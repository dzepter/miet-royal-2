import {
  appointments,
  bookings,
  conversationMessages,
  customers,
  mailDeliveries,
  processes,
  settlements,
  staffRoles,
  staffUserRoles,
  staffUsers,
  tours,
  type Database,
} from '@mietroyal/database';
import type { JobRunnerLogger } from '@mietroyal/integrations';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { StaffAuthService } from '../../auth/service.ts';
import { getCompletedVisibilityDays } from '../../crm/settings-service.ts';
import { buildVisibilityContext } from '../../crm/visibility.ts';
import { DEMO_DATASET_VERSION, DemoDatasetService } from '../dataset.ts';
import { DemoSeedRegistry } from '../registry.ts';
import { DEMO_MESSAGES, DemoError } from '../types.ts';
import { CANONICAL_DEMO_SCENARIOS } from './canonical-dataset.ts';
import type { DemoScenario, DemoSeedContext } from './context.ts';
import {
  createDemoSeedServices,
  type DemoSeedServiceDeps as DemoSeedServicesDeps,
  type DemoSeedServices,
} from './services.ts';
import { createDemoClock } from './time.ts';

/**
 * Phase 14 (Order §14, Design §2): Demo-Seed – erzeugt den kanonischen
 * Datensatz AUSSCHLIESSLICH über die Fachservices, ausschließlich in
 * APP_ENV=demo, nur auf leerem Demo-Geschäftsbestand (sonst
 * DEMO_DATA_EXISTS – kein stilles Überschreiben, kein versteckter Reset).
 * Der Seed ist bewusst kein Migrations-Seed (Order §7): er läuft nur auf
 * expliziten Befehl (`pnpm demo:seed`, Reset-Phase C).
 */
export interface DemoSeedResult {
  datasetVersion: number;
  seededAt: Date;
  /** Fachaktor der Fachpfade (aktiver Systemadmin). */
  actorId: string;
  /** Auslöser (Route/CLI), falls übergeben – in `demo_dataset_state.seeded_by`. */
  requestedBy: string | null;
  /** Zähler je Entität (nie Inhalte). */
  seeded: Record<string, number>;
}

export interface DemoSeedServiceDeps extends DemoSeedServicesDeps {
  dataset?: DemoDatasetService | undefined;
  registry?: DemoSeedRegistry | undefined;
  /** Vorgefertigte Fachservices (Tests); Default: `createDemoSeedServices(deps)`. */
  services?: DemoSeedServices | undefined;
  /** Szenarioliste (Tests); Default: kanonischer Datensatz. */
  scenarios?: readonly DemoScenario[] | undefined;
}

export const DEMO_SEED_ADMIN_MISSING_MESSAGE =
  'Kein aktiver Systemadmin vorhanden – zuerst „pnpm staff:bootstrap-admin“ ausführen.';

/** Ältester aktiver Systemadmin (stabile `is_system_admin`-Eigenschaft, nie der Rollenname). */
export async function findFirstActiveSystemAdmin(db: Database): Promise<string | null> {
  const rows = await db
    .select({ id: staffUsers.id })
    .from(staffUsers)
    .innerJoin(staffUserRoles, eq(staffUserRoles.userId, staffUsers.id))
    .innerJoin(staffRoles, eq(staffRoles.id, staffUserRoles.roleId))
    .where(and(eq(staffUsers.status, 'active'), eq(staffRoles.isSystemAdmin, true)))
    .orderBy(asc(staffUsers.createdAt), asc(staffUsers.id))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Fachaktor des Seeds: ein BESTEHENDER aktiver Systemadmin der Demo-DB – nie
 * angelegt. Ein übergebener Akteur (Route: Nutzer mit demo.manage; CLI: erster
 * Systemadmin) muss existieren und aktiv sein; ist er kein Systemadmin, läuft
 * der Seed fachlich unter dem ältesten aktiven Systemadmin (die Fachpfade
 * brauchen Vollrechte, z. B. appointment.assign, return.mark_cleanup_issue),
 * der Auslöser bleibt als `requestedBy`/`seeded_by` erhalten.
 */
export async function resolveDemoSeedActor(
  db: Database,
  auth: Pick<StaffAuthService, 'isSystemAdmin'>,
  actorId: string | null,
): Promise<{ seedActorId: string; requestedBy: string | null }> {
  if (actorId !== null) {
    const rows = await db
      .select({ status: staffUsers.status })
      .from(staffUsers)
      .where(eq(staffUsers.id, actorId));
    const user = rows[0];
    if (user === undefined || user.status !== 'active') {
      throw new DemoError(
        'VALIDATION',
        'DEMO_ACTOR_INVALID',
        'Der angegebene Akteur ist kein aktives Mitarbeiterkonto.',
      );
    }
    if (await auth.isSystemAdmin(actorId)) return { seedActorId: actorId, requestedBy: actorId };
  }
  const admin = await findFirstActiveSystemAdmin(db);
  if (admin === null) {
    throw new DemoError('CONFLICT', 'DEMO_ADMIN_MISSING', DEMO_SEED_ADMIN_MISSING_MESSAGE);
  }
  return { seedActorId: admin, requestedBy: actorId };
}

export class DemoSeedService {
  private readonly dataset: DemoDatasetService;
  private readonly registry: DemoSeedRegistry;
  private readonly services: DemoSeedServices;
  private readonly scenarios: readonly DemoScenario[];
  private readonly logger: JobRunnerLogger | undefined;

  constructor(private readonly deps: DemoSeedServiceDeps) {
    this.dataset = deps.dataset ?? new DemoDatasetService(deps.db);
    this.registry = deps.registry ?? new DemoSeedRegistry(deps.db);
    this.services = deps.services ?? createDemoSeedServices(deps);
    this.scenarios = deps.scenarios ?? CANONICAL_DEMO_SCENARIOS;
    this.logger = deps.logger;
  }

  /** Fachaktor auflösen (siehe `resolveDemoSeedActor`) – auch für den Reset VOR dem Löschen. */
  resolveActor(
    actorId: string | null,
  ): Promise<{ seedActorId: string; requestedBy: string | null }> {
    return resolveDemoSeedActor(this.deps.db, this.services.auth, actorId);
  }

  /** Env-Guard (Order §14/§15): Seed und Reset existieren nur in APP_ENV=demo. */
  assertDemoEnvironment(): void {
    if (this.deps.config.appEnv !== 'demo') {
      throw new DemoError('FORBIDDEN', 'DEMO_ONLY', DEMO_MESSAGES.DEMO_ONLY);
    }
  }

  /** „Relevante Demo-Geschäftsdaten vorhanden?“ (Kunden, Vorgänge, Buchungen, Touren oder seeded_at). */
  async hasBusinessData(): Promise<boolean> {
    const state = await this.dataset.state();
    if (state.seededAt !== null) return true;
    const counts = await this.counts();
    return (
      (counts.customers ?? 0) > 0 ||
      (counts.processes ?? 0) > 0 ||
      (counts.bookings ?? 0) > 0 ||
      (counts.tours ?? 0) > 0
    );
  }

  /** Expliziter Seed (CLI/Route): nur demo, nur auf leerem Geschäftsbestand. */
  async seed(input: { actorId: string | null; now?: Date }): Promise<DemoSeedResult> {
    this.assertDemoEnvironment();
    const actor = await resolveDemoSeedActor(this.deps.db, this.services.auth, input.actorId);
    if (await this.hasBusinessData()) {
      throw new DemoError('CONFLICT', 'DEMO_DATA_EXISTS', DEMO_MESSAGES.DEMO_DATA_EXISTS);
    }
    return this.seedCanonical({
      actorId: actor.seedActorId,
      requestedBy: actor.requestedBy,
      now: input.now,
    });
  }

  /**
   * Kanonischen Datensatz erzeugen (ohne Bestandsprüfung – Reset-Phase C nach
   * dem Löschen). Nicht transaktional: die Fachservices committen je Schritt;
   * bricht ein Szenario ab, bleiben Teildaten zurück und der nächste
   * `seed()` meldet DEMO_DATA_EXISTS – dann `demo:reset` verwenden.
   */
  async seedCanonical(input: {
    actorId: string;
    requestedBy?: string | null | undefined;
    now?: Date | undefined;
  }): Promise<DemoSeedResult> {
    this.assertDemoEnvironment();
    const now = input.now ?? new Date();
    const actor = await resolveDemoSeedActor(this.deps.db, this.services.auth, input.actorId);
    const requestedBy = input.requestedBy === undefined ? actor.requestedBy : input.requestedBy;
    const effective = await this.services.auth.effectivePermissions(actor.seedActorId, now);
    const visibility = buildVisibilityContext(
      effective,
      await getCompletedVisibilityDays(this.deps.db),
      now,
    );
    const registry = this.registry;
    const ctx: DemoSeedContext = {
      db: this.deps.db,
      config: this.deps.config,
      services: this.services,
      now,
      clock: createDemoClock(now),
      actorId: actor.seedActorId,
      effective,
      visibility,
      registry,
      datasetVersion: DEMO_DATASET_VERSION,
      register: (seedKey, entityType, entityId) =>
        registry.register(this.deps.db, {
          seedKey,
          entityType,
          entityId,
          datasetVersion: DEMO_DATASET_VERSION,
        }),
      resolve: async (seedKey) => {
        const ref = await registry.resolve(seedKey);
        if (ref === null)
          throw new Error(`Demo-Seed: Seed-Schlüssel „${seedKey}“ nicht registriert`);
        return ref.entityId;
      },
    };
    const startedAt = Date.now();
    for (const scenario of this.scenarios) {
      const scenarioStart = Date.now();
      try {
        await scenario.run(ctx);
      } catch (error) {
        this.logger?.error(
          { scenario: scenario.name, errorName: error instanceof Error ? error.name : 'Error' },
          'Demo-Seed: Szenario fehlgeschlagen',
        );
        throw error;
      }
      this.logger?.info(
        { scenario: scenario.name, durationMs: Date.now() - scenarioStart },
        'Demo-Seed: Szenario angelegt',
      );
    }
    await this.deps.db.transaction((tx) =>
      this.dataset.markSeeded(tx, {
        datasetVersion: DEMO_DATASET_VERSION,
        seededBy: requestedBy ?? actor.seedActorId,
        now,
      }),
    );
    const seeded = await this.counts();
    this.logger?.info({ durationMs: Date.now() - startedAt, ...seeded }, 'Demo-Seed abgeschlossen');
    return {
      datasetVersion: DEMO_DATASET_VERSION,
      seededAt: now,
      actorId: actor.seedActorId,
      requestedBy,
      seeded,
    };
  }

  /** Zähler relevanter Entitäten (nur Zahlen – für Logs, Berichte und den Reset). */
  async counts(): Promise<Record<string, number>> {
    const db = this.deps.db;
    const one = async (query: Promise<{ n: number }[]>): Promise<number> =>
      Number((await query)[0]?.n ?? 0);
    const n = sql<number>`count(*)::int`;
    const [
      customerCount,
      processCount,
      bookingCount,
      appointmentCount,
      tourCount,
      messageCount,
      settlementCount,
      mailCount,
    ] = await Promise.all([
      one(db.select({ n }).from(customers)),
      one(db.select({ n }).from(processes)),
      one(db.select({ n }).from(bookings)),
      one(db.select({ n }).from(appointments)),
      one(db.select({ n }).from(tours)),
      one(db.select({ n }).from(conversationMessages)),
      one(db.select({ n }).from(settlements)),
      one(db.select({ n }).from(mailDeliveries)),
    ]);
    const seedEntities = (await this.registry.list()).length;
    return {
      customers: customerCount,
      processes: processCount,
      bookings: bookingCount,
      appointments: appointmentCount,
      tours: tourCount,
      conversationMessages: messageCount,
      settlements: settlementCount,
      mailDeliveries: mailCount,
      seedEntities,
    };
  }
}
