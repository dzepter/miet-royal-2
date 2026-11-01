import { setTimeout as sleep } from 'node:timers/promises';
import {
  appointments,
  customers,
  demoDatasetState,
  documents,
  machines,
  processes,
  products,
  staffSecurityEvents,
  systemSettings,
  tours,
  type DatabaseExecutor,
} from '@mietroyal/database';
import { berlinDateOf } from '@mietroyal/domain';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEMO_DATASET_VERSION,
  DEMO_RESET_STALE_MS,
  DemoDatasetService,
} from '../src/demo/dataset.ts';
import { DEMO_RESET_GATE_CACHE_TTL_MS } from '../src/demo/reset-gate.ts';
import {
  DemoResetService,
  DEMO_BUSINESS_TABLES_DELETE_ORDER,
  DEMO_RESET_SETTLE_DELAY_MS,
  DEMO_RESET_STORAGE_DELETE_CONCURRENCY,
  deleteStorageObjectsInBatches,
  isForeignKeyViolation,
  retryOnceOnForeignKeyViolation,
} from '../src/demo/reset-service.ts';
import { DEMO_SEED_KEYS } from '../src/demo/seed/data.ts';
import { berlinDayShift } from '../src/demo/seed/time.ts';
import { DemoError, DEMO_MESSAGES } from '../src/demo/types.ts';
import { setStringSetting } from '../src/crm/settings-service.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  destroyTestContext,
  login,
  type TestContext,
} from './auth-helpers.ts';
import {
  createDemoTestContext,
  demoServicesFor,
  demoTestNow,
  freshDemoDatabase,
  type DemoTestServices,
} from './demo-helpers.ts';

/**
 * Phase 14 (SEED, Order §§15–20, Design §6): Demo-Reset – vollständige
 * Löschung der Geschäftsdaten in expliziter Reihenfolge, Erhalt von Staff/
 * Rollen/Rechten/Sessions/Geräten/Audit/Push-Geräten/Einstellungen/
 * Stammdaten, Sequenz-Neustart, Serialisierung (409 bei laufendem Reset),
 * Flag während des Laufs, Audit-Eintrag, Jobs, Storage, Env-Guard.
 * Namen laufen als „D-R<n>“. Läuft gegen eine eigene Test-DB.
 */

const RESET_TIMEOUT_MS = 180_000;
const DAY_MS = 86_400_000;

let ctx: TestContext;
let demo: DemoTestServices;
let adminId: string;
const now = demoTestNow();

beforeAll(async () => {
  ctx = await createDemoTestContext();
  demo = demoServicesFor(ctx);
  ({ adminId } = await freshDemoDatabase(ctx));
  await demo.seed.seed({ actorId: adminId, now });
}, 180_000);

afterAll(async () => {
  await destroyTestContext(ctx);
});

async function count(table: string): Promise<number> {
  const result = await ctx.pool.query(`SELECT count(*)::int AS n FROM "${table}"`);
  return result.rows[0].n as number;
}

async function resolveId(seedKey: string): Promise<string> {
  const ref = await demo.registry.resolve(seedKey);
  if (ref === null) throw new Error(`Seed-Schlüssel ${seedKey} fehlt`);
  return ref.entityId;
}

async function stateRow() {
  return (await ctx.db.select().from(demoDatasetState).where(eq(demoDatasetState.id, 1)))[0]!;
}

describe('Phase 14 – Demo-Reset', () => {
  it(
    'D-R1. Reset löscht alle Business-Tabellen und die Registry und legt den kanonischen Datensatz neu an (Zähler, alte IDs weg)',
    async () => {
      const before = await demo.seed.counts();
      const oldCustomerId = await resolveId(DEMO_SEED_KEYS.customerPrivateBasic);
      const oldProcessId = await resolveId(DEMO_SEED_KEYS.processRentalActive);
      const oldTourId = await resolveId(DEMO_SEED_KEYS.tourTodayMultiStop);
      const oldEntities = await demo.registry.list();

      const result = await demo.reset.reset({ actorId: adminId, now });

      expect(result.ok).toBe(true);
      expect(result.datasetVersion).toBe(DEMO_DATASET_VERSION);
      expect(result.seededAt.toISOString()).toBe(now.toISOString());
      expect(result.durationMs).toBeGreaterThan(0);
      for (const table of DEMO_BUSINESS_TABLES_DELETE_ORDER) {
        expect(result.deleted[table]).toEqual(expect.any(Number));
      }
      expect(result.deleted.customers).toBe(before.customers);
      expect(result.deleted.processes).toBe(before.processes);
      expect(result.deleted.bookings).toBe(before.bookings);
      expect(result.deleted.tours).toBe(before.tours);
      expect(result.deleted.demo_seed_entities).toBe(oldEntities.length);
      expect(result.deleted.machines_reset).toBe(11);
      expect(result.deleted.inventory_items_reset).toBeGreaterThanOrEqual(7);
      expect(result.seeded.customers).toBe(before.customers);
      expect(result.seeded.processes).toBe(before.processes);
      expect(result.seeded.seedEntities).toBe(oldEntities.length);

      expect(
        await ctx.db.select().from(customers).where(eq(customers.id, oldCustomerId)),
      ).toHaveLength(0);
      expect(
        await ctx.db.select().from(processes).where(eq(processes.id, oldProcessId)),
      ).toHaveLength(0);
      expect(await ctx.db.select().from(tours).where(eq(tours.id, oldTourId))).toHaveLength(0);
      const fresh = await demo.registry.list();
      expect(fresh.map((entry) => entry.seedKey).sort()).toEqual(
        oldEntities.map((entry) => entry.seedKey).sort(),
      );
      const oldIds = new Set(oldEntities.map((entry) => entry.entityId));
      const reused = fresh.filter(
        (entry) =>
          entry.entityType !== 'machine' &&
          entry.entityType !== 'inventory_item' &&
          oldIds.has(entry.entityId),
      );
      expect(reused).toHaveLength(0);
      // Tabellen, die der Seed nicht befüllt, sind nach dem Reset leer.
      for (const table of ['tour_live_locations', 'cancellations', 'accounting_transfers']) {
        expect(await count(table)).toBe(0);
      }
      // Phase 14 (accounting), W1.1: `vouchers` trägt nach dem Reset genau den neuen
      // Fixture-Gutschein (voucher.situation) – der alte ist weg.
      expect(await count('vouchers')).toBe(1);
      const newVoucherId = await resolveId(DEMO_SEED_KEYS.voucherSituation);
      expect(oldIds.has(newVoucherId)).toBe(false);
      const state = await demo.dataset.state(now);
      expect(state.resetInProgress).toBe(false);
      expect(state.lastResetAt?.toISOString()).toBe(now.toISOString());
      expect(state.lastResetBy).toBe(adminId);
      expect(state.seededAt?.toISOString()).toBe(now.toISOString());
      expect(state.datasetVersion).toBe(DEMO_DATASET_VERSION);
    },
    RESET_TIMEOUT_MS,
  );

  it(
    'D-R2. Reset behält Staff-Konten, Rollen, Rechte, Sessions, bekannte Geräte, Security-Events, Push-Geräte, Einstellungen, Produkte/Preise, Maschinen-Zeilen und Mietbedingungen',
    async () => {
      const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
      expect(session.statusCode).toBe(200);
      const pushResponse = await ctx.app.inject({
        method: 'POST',
        url: '/staff/push/subscriptions',
        headers: { cookie: session.cookie },
        payload: {
          // Außerhalb von development nur bekannte Push-Dienste (Endpoint-Policy).
          endpoint: `https://fcm.googleapis.com/fcm/send/demo-reset-${'e'.repeat(40)}`,
          keys: { p256dh: 'BPk'.padEnd(87, 'A'), auth: 'auth-secret-16by' },
        },
      });
      expect([200, 201]).toContain(pushResponse.statusCode);
      await setStringSetting(ctx.db, adminId, 'demo_test_custom_setting', 'bleibt');
      const machineIdsBefore = (await ctx.db.select({ id: machines.id }).from(machines))
        .map((row) => row.id)
        .sort();
      const preserved = [
        'staff_users',
        'staff_roles',
        'staff_role_permissions',
        'staff_user_roles',
        'staff_sessions',
        'staff_known_devices',
        'push_subscriptions',
        'system_settings',
        'products',
        'product_prices',
        'terms_versions',
        'machines',
        'inventory_items',
        'integration_rate_limits',
      ];
      const before = new Map<string, number>();
      for (const table of preserved) before.set(table, await count(table));
      expect(before.get('staff_sessions')).toBeGreaterThan(0);
      expect(before.get('push_subscriptions')).toBe(1);
      expect(before.get('machines')).toBe(11);
      const eventsBefore = await count('staff_security_events');

      await demo.reset.reset({ actorId: adminId, now });

      for (const table of preserved) expect(await count(table)).toBe(before.get(table));
      // Genau zwei Audit-Einträge mehr (demo.reset_started + demo.reset_completed, Phase 14 reset); nichts gelöscht.
      expect(await count('staff_security_events')).toBe(eventsBefore + 2);
      const machineIdsAfter = (await ctx.db.select({ id: machines.id }).from(machines))
        .map((row) => row.id)
        .sort();
      expect(machineIdsAfter).toEqual(machineIdsBefore);
      const setting = await ctx.db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, 'demo_test_custom_setting'));
      expect(setting[0]?.value).toBe('bleibt');
      const productRows = await ctx.db.select({ slug: products.slug }).from(products);
      expect(productRows).toHaveLength(11);
      // Session weiterhin gültig – kein Mitarbeiter wird ausgesperrt.
      const me = await ctx.app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { cookie: session.cookie },
      });
      expect(me.statusCode).toBe(200);
    },
    RESET_TIMEOUT_MS,
  );

  it('D-R3. Sequenz neu gestartet: erster Vorgang nach dem Reset trägt MR-<Jahr>-0001, Nummern fortlaufend', async () => {
    const rows = await ctx.db
      .select({ number: processes.processNumber })
      .from(processes)
      .orderBy(asc(processes.createdAt));
    const year = berlinDateOf(now).slice(0, 4);
    expect(rows[0]!.number).toBe(`MR-${year}-0001`);
    rows.forEach((row, index) => {
      expect(row.number).toBe(`MR-${year}-${String(index + 1).padStart(4, '0')}`);
    });
  });

  it(
    'D-R4. Zwei parallele Resets: genau einer läuft, der andere scheitert mit 409 DEMO_RESET_RUNNING',
    async () => {
      const first = demo.reset.reset({ actorId: adminId, now });
      await sleep(150);
      const second = demo.reset.reset({ actorId: adminId, now });
      const outcomes = await Promise.allSettled([first, second]);
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const error = (rejected[0] as PromiseRejectedResult).reason as DemoError;
      expect(error).toBeInstanceOf(DemoError);
      expect(error.code).toBe('CONFLICT');
      expect(error.demoCode).toBe('DEMO_RESET_RUNNING');
      expect(error.message).toBe(DEMO_MESSAGES.DEMO_RESET_RUNNING);
      expect(await demo.dataset.resetInProgress()).toBe(false);
    },
    RESET_TIMEOUT_MS,
  );

  it(
    'D-R5. Flag reset_in_progress ist während des Laufs true (Gate greift) und danach false',
    async () => {
      expect(await demo.dataset.resetInProgress()).toBe(false);
      const running = demo.reset.reset({ actorId: adminId, now });
      let seenInProgress = false;
      for (let i = 0; i < 100 && !seenInProgress; i += 1) {
        await sleep(20);
        seenInProgress = await demo.dataset.resetInProgress();
      }
      expect(seenInProgress).toBe(true);
      const row = await stateRow();
      expect(row.resetInProgress).toBe(true);
      expect(row.resetStartedAt?.toISOString()).toBe(now.toISOString());
      expect(row.lastResetBy).toBe(adminId);
      await running;
      expect(await demo.dataset.resetInProgress()).toBe(false);
      expect((await stateRow()).resetStartedAt).toBeNull();
    },
    RESET_TIMEOUT_MS,
  );

  it('D-R6. Audit-Event demo.reset_completed mit Actor, resetRunId, Version und Status (Phase 14 reset: keine Zähler, keine Inhalte)', async () => {
    const events = await ctx.db
      .select()
      .from(staffSecurityEvents)
      .where(eq(staffSecurityEvents.type, 'demo.reset_completed'));
    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1]!;
    expect(last.actorUserId).toBe(adminId);
    const details = last.details as Record<string, unknown>;
    expect(Object.keys(details).sort()).toEqual(['datasetVersion', 'resetRunId', 'status']);
    expect(details.resetRunId).toMatch(/^[0-9a-f-]{36}$/);
    expect(details.datasetVersion).toBe(DEMO_DATASET_VERSION);
    expect(details.status).toBe('completed');
    for (const value of Object.values(details)) {
      expect(['number', 'string', 'boolean']).toContain(typeof value);
    }
  });

  it(
    'D-R7. Business-Jobs des alten Datensatzes werden gelöscht, Infrastruktur-Jobs bleiben',
    async () => {
      const heartbeat = await ctx.queue.enqueue(
        'system.heartbeat',
        { source: 'demo-reset-test' },
        { idempotencyKey: `system.heartbeat:demo-reset-test:${Date.now()}` },
      );
      const scan = await ctx.queue.enqueue(
        'communication.scan_due',
        {},
        { idempotencyKey: `communication.scan_due:demo-reset-test:${Date.now()}` },
      );
      // Phase 14 (accounting), W1: der Seed stellt keine Transferjobs mehr ein (Gateway in
      // demo `disabled`); Business-Jobs des Datensatzes sind u. a. `voucher.delivery`
      // (Fixture `voucher.situation`, normaler Versandweg) und Retention-Jobs.
      const businessBefore = await ctx.pool.query(
        `SELECT id FROM integration_jobs WHERE type IN ('voucher.delivery', 'voucher.eligibility_check', 'settlement.accounting_transfer')`,
      );
      expect(businessBefore.rows.length).toBeGreaterThan(0);
      const oldBusinessIds = businessBefore.rows.map((row: { id: string }) => row.id);

      const result = await demo.reset.reset({ actorId: adminId, now });
      expect(result.deleted.integration_jobs).toBeGreaterThanOrEqual(oldBusinessIds.length);

      const remainingOld = await ctx.pool.query(
        `SELECT id FROM integration_jobs WHERE id = ANY($1)`,
        [oldBusinessIds],
      );
      expect(remainingOld.rows).toHaveLength(0);
      const infra = await ctx.pool.query(
        `SELECT id, type FROM integration_jobs WHERE id = ANY($1)`,
        [[heartbeat.jobId, scan.jobId]],
      );
      expect(infra.rows.map((row: { type: string }) => row.type).sort()).toEqual([
        'communication.scan_due',
        'system.heartbeat',
      ]);
      // Der neue Seed stellt eigene Business-Jobs ein (Gutschein-Versand der Fixture);
      // Transferjobs entstehen in der Demo nie (W1).
      const businessAfter = await ctx.pool.query(
        `SELECT count(*)::int AS n FROM integration_jobs WHERE type = 'voucher.delivery'`,
      );
      expect(businessAfter.rows[0].n).toBeGreaterThan(0);
      const transferJobs = await ctx.pool.query(
        `SELECT count(*)::int AS n FROM integration_jobs WHERE type = 'settlement.accounting_transfer'`,
      );
      expect(transferJobs.rows[0].n).toBe(0);
    },
    RESET_TIMEOUT_MS,
  );

  it('D-R8. Reset außerhalb von APP_ENV=demo ist unmöglich (DEMO_ONLY, nichts gelöscht)', async () => {
    const before = await demo.seed.counts();
    const dev = new DemoResetService({
      db: ctx.db,
      config: { ...ctx.config, appEnv: 'development' },
      storage: ctx.storage,
      queue: ctx.queue,
      seed: demo.seed,
    });
    const error = await dev.reset({ actorId: adminId, now }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DemoError);
    expect((error as DemoError).demoCode).toBe('DEMO_ONLY');
    expect((error as DemoError).code).toBe('FORBIDDEN');
    expect(await demo.seed.counts()).toEqual(before);
    expect(await demo.dataset.resetInProgress()).toBe(false);
  });

  it(
    'D-R9/D-R10. Ergebnis-Zähler plausibel; Storage-Objekte gelöschter Dokumente werden entfernt, neue existieren; Datum-Relativität nach Reset mit anderem „jetzt“ (+7 Tage)',
    async () => {
      const oldDocs = await ctx.db.select({ key: documents.storageKey }).from(documents);
      expect(oldDocs.length).toBeGreaterThan(0);
      for (const doc of oldDocs) expect(await ctx.storage.exists(doc.key)).toBe(true);
      const before = await demo.seed.counts();

      const later = new Date(now.getTime() + 7 * DAY_MS);
      const result = await demo.reset.reset({ actorId: null, now: later });

      expect(result.deleted.documents).toBe(oldDocs.length);
      expect(result.deleted.customers).toBe(before.customers);
      expect(result.seeded.customers).toBe(before.customers);
      expect(result.seeded.processes).toBe(before.processes);
      expect(result.seeded.bookings).toBe(before.bookings);
      expect(result.seeded.tours).toBe(2);
      for (const doc of oldDocs) expect(await ctx.storage.exists(doc.key)).toBe(false);
      const newDocs = await ctx.db.select({ key: documents.storageKey }).from(documents);
      expect(newDocs.length).toBe(oldDocs.length);
      for (const doc of newDocs) expect(await ctx.storage.exists(doc.key)).toBe(true);

      // actorId null ⇒ Fachaktor = erster Systemadmin; Auslöser (last_reset_by/
      // seeded_by, DemoDatasetService.endReset) bleibt leer; die Fachdaten tragen den Admin.
      const state = await demo.dataset.state(later);
      expect(state.lastResetBy).toBeNull();
      expect(state.seededBy).toBeNull();
      const firstProcess = (
        await ctx.db.select().from(processes).orderBy(asc(processes.createdAt)).limit(1)
      )[0]!;
      expect(firstProcess.createdBy).toBe(adminId);

      const laterToday = berlinDateOf(later);
      const overdue = (
        await ctx.db
          .select()
          .from(appointments)
          .where(eq(appointments.id, await resolveId(DEMO_SEED_KEYS.appointmentReturnOverdue)))
      )[0]!;
      expect(berlinDateOf(overdue.startAt!)).toBe(berlinDayShift(laterToday, -1));
      const tourRows = await ctx.db.select().from(tours).orderBy(asc(tours.tourDate));
      expect(tourRows.map((row) => row.tourDate)).toEqual([
        laterToday,
        berlinDayShift(laterToday, 1),
      ]);
      expect(tourRows[1]!.planningStatus).toBe('planned');
    },
    RESET_TIMEOUT_MS,
  );

  it(
    'D-R11. Laufender Reset (Flag jünger als DEMO_RESET_STALE_MS = 10 min) ⇒ 409; hängen gebliebener Reset (älter) darf neu gestartet werden',
    async () => {
      await ctx.db.transaction(async (tx) => {
        await demo.dataset.lockRow(tx);
        await demo.dataset.beginReset(tx, { actorId: adminId, now });
      });
      await expect(demo.reset.reset({ actorId: adminId, now })).rejects.toMatchObject({
        demoCode: 'DEMO_RESET_RUNNING',
      });
      expect(await demo.dataset.resetInProgress()).toBe(true);
      const stale = new Date(now.getTime() - DEMO_RESET_STALE_MS - 60_000);
      await ctx.db.transaction(async (tx) => {
        await demo.dataset.lockRow(tx);
        await demo.dataset.beginReset(tx, { actorId: adminId, now: stale });
      });
      expect((await demo.dataset.state()).resetStale).toBe(true);
      const result = await demo.reset.reset({ actorId: adminId, now });
      expect(result.ok).toBe(true);
      expect(await demo.dataset.resetInProgress()).toBe(false);
    },
    RESET_TIMEOUT_MS,
  );

  it(
    'D-R12. Abbruch im Seed lässt das Flag gesetzt (Gate fail-closed), markiert den Lauf als unterbrochen und erlaubt sofort einen neuen Reset',
    async () => {
      const failing = demoServicesFor(ctx, {
        scenarios: [
          {
            name: 'explodes',
            run: async () => {
              throw new Error('Demo-Seed-Testabbruch');
            },
          },
        ],
      });
      await expect(failing.reset.reset({ actorId: adminId, now })).rejects.toThrow(
        'Demo-Seed-Testabbruch',
      );
      const state = await demo.dataset.state();
      expect(state.resetInProgress).toBe(true);
      expect(state.resetStale).toBe(true);
      expect(await count('customers')).toBe(0);
      const result = await demo.reset.reset({ actorId: adminId, now });
      expect(result.ok).toBe(true);
      expect(await demo.dataset.resetInProgress()).toBe(false);
      expect(await count('customers')).toBeGreaterThan(0);
    },
    RESET_TIMEOUT_MS,
  );

  it(
    'RF3. Reset löscht vorgangsgebundene Retention-Jobs (communication.cleanup_retention, scope photos) des alten Datensatzes; der Backstop bleibt; danach verweist kein photos-Job auf eine gelöschte Vorgangs-ID',
    async () => {
      const photosBefore = await ctx.pool.query<{ id: string }>(
        `SELECT id FROM integration_jobs
          WHERE type = 'communication.cleanup_retention' AND payload->>'scope' = 'photos'`,
      );
      expect(photosBefore.rows.length).toBeGreaterThan(0);
      const oldIds = photosBefore.rows.map((row) => row.id);
      const backstop = await ctx.queue.enqueue(
        'communication.cleanup_retention',
        { scope: 'backstop', day: '2026-01-01', textRetention: false },
        { idempotencyKey: `communication.cleanup_retention:rf3-backstop:${Date.now()}` },
      );

      const result = await demo.reset.reset({ actorId: adminId, now });
      expect(result.deleted.integration_jobs).toBeGreaterThanOrEqual(oldIds.length);

      const remainingOld = await ctx.pool.query(
        `SELECT id FROM integration_jobs WHERE id = ANY($1)`,
        [oldIds],
      );
      expect(remainingOld.rows).toHaveLength(0);
      const orphaned = await ctx.pool.query(
        `SELECT j.id FROM integration_jobs j
          WHERE j.type = 'communication.cleanup_retention' AND j.payload->>'scope' = 'photos'
            AND NOT EXISTS (SELECT 1 FROM processes p WHERE p.id::text = j.payload->>'processId')`,
      );
      expect(orphaned.rows).toHaveLength(0);
      const kept = await ctx.pool.query(`SELECT id FROM integration_jobs WHERE id = $1`, [
        backstop.jobId,
      ]);
      expect(kept.rows).toHaveLength(1);
      // Der neue Seed stellt seinen eigenen Retention-Job (abgeschlossener Vorgang) ein.
      const photosAfter = await ctx.pool.query(
        `SELECT count(*)::int AS n FROM integration_jobs
          WHERE type = 'communication.cleanup_retention' AND payload->>'scope' = 'photos'`,
      );
      expect(photosAfter.rows[0].n).toBeGreaterThan(0);
    },
    RESET_TIMEOUT_MS,
  );

  it(
    'RF4. Schutzfenster: Phase B beginnt erst settleDelayMs nach dem Flag-Commit (Default Gate-Cache-TTL + 200 ms; Tests laufen mit 0 weiter grün)',
    async () => {
      expect(DEMO_RESET_SETTLE_DELAY_MS).toBe(DEMO_RESET_GATE_CACHE_TTL_MS + 200);
      let flaggedAt = 0;
      let wipeAt = 0;
      class ObservingDataset extends DemoDatasetService {
        override async beginReset(
          tx: DatabaseExecutor,
          input: { actorId: string | null; now: Date },
        ): Promise<void> {
          await super.beginReset(tx, input);
          flaggedAt = Date.now();
        }
      }
      const observing = new DemoResetService({
        db: ctx.db,
        config: ctx.config,
        storage: ctx.storage,
        queue: ctx.queue,
        mailGateway: ctx.mailGateway,
        dataset: new ObservingDataset(ctx.db),
        registry: demo.registry,
        seed: demo.seed,
        settleDelayMs: 150,
        fkRetryDelayMs: 0,
        hooks: {
          beforeBusinessWipe: async () => {
            wipeAt = Date.now();
          },
        },
      });
      const result = await observing.reset({ actorId: adminId, now });
      expect(result.ok).toBe(true);
      expect(flaggedAt).toBeGreaterThan(0);
      expect(wipeAt - flaggedAt).toBeGreaterThanOrEqual(150);
      expect(await demo.dataset.resetInProgress()).toBe(false);
    },
    RESET_TIMEOUT_MS,
  );

  it('RF4b. Phase-B-Wiederholung (Mock): genau ein zweiter Versuch nach SQLSTATE 23503 (direkt oder als cause), sonst keine Wiederholung; zweiter Fehlschlag wird weitergereicht; Log nur mit Code', async () => {
    const warnings: Record<string, unknown>[] = [];
    const logger = {
      info: () => {},
      warn: (context: Record<string, unknown>) => {
        warnings.push(context);
      },
      error: () => {},
    };
    const fkError = () =>
      Object.assign(new Error('delete on table "kunden" violates foreign key (geheim)'), {
        code: '23503',
      });
    let calls = 0;
    const result = await retryOnceOnForeignKeyViolation(
      async () => {
        calls += 1;
        if (calls === 1) throw fkError();
        return 'ok';
      },
      { delayMs: 0, logger },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
    expect(warnings).toEqual([{ errorCode: '23503' }]);
    expect(JSON.stringify(warnings)).not.toContain('geheim');

    // DrizzleQueryError-Form: SQLSTATE im `cause`.
    calls = 0;
    const wrapped = await retryOnceOnForeignKeyViolation(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('Failed query', { cause: fkError() });
        return calls;
      },
      { delayMs: 0 },
    );
    expect(wrapped).toBe(2);

    // Zweiter Fehlschlag ⇒ Fehler, genau zwei Versuche.
    calls = 0;
    await expect(
      retryOnceOnForeignKeyViolation(
        async () => {
          calls += 1;
          throw fkError();
        },
        { delayMs: 0 },
      ),
    ).rejects.toMatchObject({ code: '23503' });
    expect(calls).toBe(2);

    // Andere Fehler ⇒ keine Wiederholung.
    calls = 0;
    await expect(
      retryOnceOnForeignKeyViolation(
        async () => {
          calls += 1;
          throw Object.assign(new Error('duplicate'), { code: '23505' });
        },
        { delayMs: 0 },
      ),
    ).rejects.toMatchObject({ code: '23505' });
    expect(calls).toBe(1);
    expect(isForeignKeyViolation(null)).toBe(false);
    expect(isForeignKeyViolation(new Error('x'))).toBe(false);
  });

  it(
    'RF4c. FK-Verletzung in Phase B (im Hook simuliert, Transaktion rollt zurück) ⇒ genau eine Wiederholung, Reset gelingt',
    async () => {
      let hookCalls = 0;
      const retrying = demoServicesFor(ctx, {
        hooks: {
          beforeBusinessWipe: async () => {
            hookCalls += 1;
            if (hookCalls === 1) {
              throw Object.assign(new Error('simulierte FK-Verletzung'), { code: '23503' });
            }
          },
        },
      });
      const result = await retrying.reset.reset({ actorId: adminId, now });
      expect(result.ok).toBe(true);
      expect(hookCalls).toBe(2);
      expect(await demo.dataset.resetInProgress()).toBe(false);
      expect(await count('customers')).toBe(result.seeded.customers);
    },
    RESET_TIMEOUT_MS,
  );

  it('RF7. Storage-Löschung (Mock): parallele Batches mit höchstens 10 gleichzeitigen Löschungen, Fehler je Objekt gezählt und ohne Schlüssel geloggt, nie abgebrochen', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const deleted: string[] = [];
    const storage = {
      delete: async (key: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(5);
        inFlight -= 1;
        if (key.endsWith('-fail')) throw new Error(`geheimer Pfad ${key}`);
        deleted.push(key);
      },
    };
    const keys = Array.from({ length: 25 }, (_, index) =>
      index % 12 === 0 ? `obj-${index}-fail` : `obj-${index}`,
    );
    const warnings: Record<string, unknown>[] = [];
    const outcome = await deleteStorageObjectsInBatches(storage, keys, {
      logger: {
        info: () => {},
        warn: (context) => {
          warnings.push(context);
        },
        error: () => {},
      },
    });
    // Phase 14 (reset, Order §22): fehlgeschlagene Schlüssel werden für die Nachbereinigung geliefert.
    expect(outcome).toEqual({
      removed: 22,
      failed: 3,
      failedKeys: ['obj-0-fail', 'obj-12-fail', 'obj-24-fail'],
    });
    expect(maxInFlight).toBe(DEMO_RESET_STORAGE_DELETE_CONCURRENCY);
    expect(maxInFlight).toBeLessThanOrEqual(10);
    expect(deleted).toHaveLength(22);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toEqual({ errorName: 'Error' });
    expect(JSON.stringify(warnings)).not.toContain('obj-');
    expect(await deleteStorageObjectsInBatches(storage, [], { concurrency: 1 })).toEqual({
      removed: 0,
      failed: 0,
      failedKeys: [],
    });
  });

  it(
    'RF8. Hängender Reset: nach 10 min (DEMO_RESET_STALE_MS) abgelaufen, jünger ⇒ 409; --force (releaseStaleReset) gibt ein hängendes Flag ohne Lock-Inhaber sofort frei, meldet bei gehaltenem Lock DEMO_RESET_RUNNING und ist ohne Flag wirkungslos',
    async () => {
      expect(DEMO_RESET_STALE_MS).toBe(10 * 60 * 1000);
      const flagAt = (startedAt: Date) =>
        ctx.db.transaction(async (tx) => {
          await demo.dataset.lockRow(tx);
          await demo.dataset.beginReset(tx, { actorId: adminId, now: startedAt });
        });

      // 9 min alt ⇒ läuft noch (Status und Phase A).
      await flagAt(new Date(now.getTime() - 9 * 60_000));
      expect((await demo.dataset.state(now)).resetStale).toBe(false);
      await expect(demo.reset.reset({ actorId: adminId, now })).rejects.toMatchObject({
        demoCode: 'DEMO_RESET_RUNNING',
      });
      // 11 min bzw. 20 min alt ⇒ abgelaufen (früher erst nach 30 min).
      await flagAt(new Date(now.getTime() - 11 * 60_000));
      expect((await demo.dataset.state(now)).resetStale).toBe(true);
      await flagAt(new Date(now.getTime() - 20 * 60_000));
      expect((await demo.dataset.state(now)).resetStale).toBe(true);

      // --force: Flag 1 min alt, kein Lock-Inhaber ⇒ sofort abgelaufen, Flag bleibt (Gate geschlossen).
      await flagAt(new Date(now.getTime() - 60_000));
      expect(await demo.reset.releaseStaleReset(now)).toBe(true);
      const released = await demo.dataset.state(now);
      expect(released.resetInProgress).toBe(true);
      expect(released.resetStale).toBe(true);

      // Lock gehalten (Phase B eines anderen Prozesses) ⇒ DEMO_RESET_RUNNING, Flag unverändert.
      await flagAt(new Date(now.getTime() - 60_000));
      const holder = await ctx.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query("SELECT pg_advisory_xact_lock(hashtext('demo-reset'))");
        await expect(demo.reset.releaseStaleReset(now)).rejects.toMatchObject({
          demoCode: 'DEMO_RESET_RUNNING',
        });
        await expect(demo.reset.reset({ actorId: adminId, now })).rejects.toMatchObject({
          demoCode: 'DEMO_RESET_RUNNING',
        });
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      expect((await demo.dataset.state(now)).resetStale).toBe(false);

      // CLI-Pfad --force: freigeben und sofort neu starten.
      expect(await demo.reset.releaseStaleReset(now)).toBe(true);
      const result = await demo.reset.reset({ actorId: adminId, now });
      expect(result.ok).toBe(true);
      expect(await demo.dataset.resetInProgress()).toBe(false);
      // Ohne hängendes Flag: nichts zu tun.
      expect(await demo.reset.releaseStaleReset(now)).toBe(false);
      // Außerhalb demo unmöglich.
      const dev = new DemoResetService({
        db: ctx.db,
        config: { ...ctx.config, appEnv: 'development' },
        storage: ctx.storage,
        queue: ctx.queue,
        seed: demo.seed,
      });
      await expect(dev.releaseStaleReset(now)).rejects.toMatchObject({ demoCode: 'DEMO_ONLY' });
    },
    RESET_TIMEOUT_MS,
  );

  it(
    'RF14-1. Lauf-Lock über die gesamte Laufzeit (Review-Fix F1, Order §20): während ein Reset läuft (Schutzfenster/Seed), meldet releaseStaleReset (--force) DEMO_RESET_RUNNING und ein zweiter reset() scheitert vor Phase A (nie Phase B); nach dem Ende ist der Lock frei',
    async () => {
      const first = demoServicesFor(ctx, { settleDelayMs: 2500 });
      let secondReachedPhaseB = false;
      const second = demoServicesFor(ctx, {
        hooks: {
          beforeBusinessWipe: async () => {
            secondReachedPhaseB = true;
          },
        },
      });
      const firstRun = first.reset.reset({ actorId: adminId, now });
      await sleep(500); // Phase A des ersten Resets ist committet, das Schutzfenster läuft
      await expect(second.reset.releaseStaleReset(now)).rejects.toMatchObject({
        demoCode: 'DEMO_RESET_RUNNING',
      });
      await expect(second.reset.reset({ actorId: adminId, now })).rejects.toMatchObject({
        demoCode: 'DEMO_RESET_RUNNING',
      });
      expect(secondReachedPhaseB).toBe(false);
      // Der erste Reset läuft ungestört zu Ende (ein Lauf, Version aktuell, Flag frei).
      expect((await firstRun).ok).toBe(true);
      const state = await demo.dataset.state(now);
      expect(state.resetInProgress).toBe(false);
      expect(state.resetStale).toBe(false);
      expect(state.datasetVersion).toBe(DEMO_DATASET_VERSION);
      // Lock frei: --force ohne hängendes Flag wirkungslos, ein weiterer Reset läuft (Phase B erreicht).
      expect(await second.reset.releaseStaleReset(now)).toBe(false);
      expect((await second.reset.reset({ actorId: adminId, now })).ok).toBe(true);
      expect(secondReachedPhaseB).toBe(true);
      expect(await demo.dataset.resetInProgress()).toBe(false);
    },
    RESET_TIMEOUT_MS,
  );
});
