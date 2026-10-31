import type { AppConfig } from '@mietroyal/config';
import {
  customers,
  integrationJobs,
  processes,
  staffUsers,
  tours,
  type Database,
} from '@mietroyal/database';
import { parseOrThrow, z } from '@mietroyal/validation';
import { and, count, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  authErrorStatus,
  requireAuth,
  requirePermission,
  sendAuthError,
  sendError,
} from '../auth/http.ts';
import type { AuthenticatedContext, StaffAuthService } from '../auth/service.ts';
import { DEMO_STORAGE_CLEANUP_JOB_TYPE } from '../demo/job-types.ts';
import type { DemoModule } from '../demo/module.ts';
import { DEMO_MESSAGES, DemoError } from '../demo/types.ts';

/**
 * Phase 14 (Design §2, Order §§14–16, §20): Demo-Verwaltung – Status des
 * kanonischen Datensatzes, Seed-Registry und der destruktive Reset. Die Routen
 * werden in `buildApp` AUSSCHLIESSLICH für `APP_ENV=demo` registriert; in
 * allen anderen Umgebungen existieren sie nicht (404). Recht: `demo.manage`
 * (Systemadmins automatisch). Antworten enthalten nur Zähler, Zeitstempel,
 * Versionen und Anzeigenamen – nie Secrets oder Kundendaten.
 */

const resetBodySchema = z.strictObject({ confirmation: z.string().min(1).max(100) });

export interface DemoRouteDeps {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  demo: DemoModule;
}

export interface DemoStaffRef {
  id: string;
  name: string;
}

export interface DemoStatusResponse {
  environment: 'demo';
  datasetVersion: number | null;
  expectedDatasetVersion: number;
  outdated: boolean;
  /** Admin-Hinweis (Order §8), nur wenn `outdated`. */
  outdatedHint: string | null;
  seededAt: Date | null;
  seededBy: DemoStaffRef | null;
  lastResetAt: Date | null;
  lastResetBy: DemoStaffRef | null;
  resetInProgress: boolean;
  resetStartedAt: Date | null;
  /** Reset begonnen, aber länger als DEMO_RESET_STALE_MS (10 min) nicht abgeschlossen – erneut zurücksetzen. */
  resetStale: boolean;
  counts: { customers: number; processes: number; tours: number };
  seedEntities: number;
  /**
   * Phase 14 (reset, Order §22): Nachbereinigung alter Demo-Dateien – Jobs
   * `demo.storage_cleanup`, die noch ausstehen (pending/processing) bzw.
   * dauerhaft gescheitert sind (dead; technischer Fehler, Logs prüfen).
   */
  storageCleanup: { pendingJobs: number; deadJobs: number };
}

async function storageCleanupCounts(db: Database): Promise<DemoStatusResponse['storageCleanup']> {
  const [pending] = await db
    .select({ value: count() })
    .from(integrationJobs)
    .where(
      and(
        eq(integrationJobs.type, DEMO_STORAGE_CLEANUP_JOB_TYPE),
        inArray(integrationJobs.status, ['pending', 'processing']),
      ),
    );
  const [dead] = await db
    .select({ value: count() })
    .from(integrationJobs)
    .where(
      and(
        eq(integrationJobs.type, DEMO_STORAGE_CLEANUP_JOB_TYPE),
        eq(integrationJobs.status, 'dead'),
      ),
    );
  return { pendingJobs: pending?.value ?? 0, deadJobs: dead?.value ?? 0 };
}

async function businessCounts(db: Database): Promise<DemoStatusResponse['counts']> {
  const [c] = await db.select({ value: count() }).from(customers);
  const [p] = await db.select({ value: count() }).from(processes);
  const [t] = await db.select({ value: count() }).from(tours);
  return { customers: c?.value ?? 0, processes: p?.value ?? 0, tours: t?.value ?? 0 };
}

async function staffRefs(db: Database, ids: readonly (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  const byId = new Map<string, DemoStaffRef>();
  if (wanted.length === 0) return byId;
  const rows = await db
    .select({ id: staffUsers.id, firstName: staffUsers.firstName, lastName: staffUsers.lastName })
    .from(staffUsers)
    .where(inArray(staffUsers.id, wanted));
  for (const row of rows) {
    byId.set(row.id, { id: row.id, name: `${row.firstName} ${row.lastName}`.trim() });
  }
  return byId;
}

export function registerDemoRoutes(app: FastifyInstance, deps: DemoRouteDeps): void {
  const { db, auth, config, demo } = deps;

  const requireDemoManager = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthenticatedContext | null> => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return null;
    if (!(await requirePermission(request, reply, auth, context, 'demo.manage'))) return null;
    return context;
  };

  app.get('/staff/demo/status', async (request, reply) => {
    const context = await requireDemoManager(request, reply);
    if (context === null) return;
    const now = new Date();
    const state = await demo.dataset.state(now);
    const counts = await businessCounts(db);
    const seedEntities = (await demo.registry.list()).length;
    const refs = await staffRefs(db, [state.seededBy, state.lastResetBy]);
    // Design §5: veraltet, wenn die Version hinter dem Code liegt ODER Business-
    // Daten ohne registrierten Seed-Stand vorhanden sind (unbekannte Herkunft).
    const hasBusinessData = counts.customers + counts.processes + counts.tours > 0;
    const outdated = state.outdated || (state.seededAt === null && hasBusinessData);
    const response: DemoStatusResponse = {
      environment: 'demo',
      datasetVersion: state.datasetVersion,
      expectedDatasetVersion: state.expectedDatasetVersion,
      outdated,
      outdatedHint: outdated ? DEMO_MESSAGES.DEMO_OUTDATED : null,
      seededAt: state.seededAt,
      seededBy: state.seededBy === null ? null : (refs.get(state.seededBy) ?? null),
      lastResetAt: state.lastResetAt,
      lastResetBy: state.lastResetBy === null ? null : (refs.get(state.lastResetBy) ?? null),
      resetInProgress: state.resetInProgress,
      resetStartedAt: state.resetStartedAt,
      resetStale: state.resetStale,
      counts,
      seedEntities,
      storageCleanup: await storageCleanupCounts(db), // Phase 14 (reset)
    };
    return response;
  });

  app.get('/staff/demo/seed-entities', async (request, reply) => {
    const context = await requireDemoManager(request, reply);
    if (context === null) return;
    const entities = await demo.registry.list();
    return {
      expectedDatasetVersion: (await demo.dataset.state()).expectedDatasetVersion,
      entities,
    };
  });

  /**
   * Destruktiver Reset (Order §16/§20): exakter Bestätigungstext Pflicht,
   * sonst 400 VALIDATION. Läuft synchron bis zum Ende; währenddessen greift
   * das 503-Gate für alle anderen Business-Mutationen. Fehler des Reset-
   * Services (`DemoError`) werden mit dem Status des AuthError-Codes und
   * `details.demoCode` beantwortet (z. B. 409 / DEMO_RESET_RUNNING).
   */
  app.post('/staff/demo/reset', async (request, reply) => {
    const context = await requireDemoManager(request, reply);
    if (context === null) return;
    const body = parseOrThrow(resetBodySchema, request.body);
    if (body.confirmation !== DEMO_MESSAGES.RESET_CONFIRMATION) {
      sendError(
        request,
        reply,
        400,
        'VALIDATION',
        `Bestätigung fehlt – bitte genau „${DEMO_MESSAGES.RESET_CONFIRMATION}“ eingeben.`,
      );
      return;
    }
    const now = new Date();
    // Phase 14 (reset, Order §31): das Security-Audit (demo.reset_started/
    // _completed/_failed) schreibt ausschließlich der Reset-Service; die Route
    // reicht nur Actor und Session durch.
    request.log.info({ actorId: context.user.id }, 'Demo-Reset angefordert');
    try {
      const result = await demo.reset.reset({
        actorId: context.user.id,
        sessionId: context.session.id,
        now,
      });
      demo.gate.invalidate();
      return result;
    } catch (error) {
      demo.gate.invalidate();
      if (error instanceof DemoError) {
        void reply.status(authErrorStatus(error.code)).send({
          error: {
            code: error.code,
            message: error.message,
            correlationId: request.id,
            details: { ...error.details, demoCode: error.demoCode },
          },
        });
        return;
      }
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });
}
