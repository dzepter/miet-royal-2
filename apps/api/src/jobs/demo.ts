import type { Database } from '@mietroyal/database';
import {
  assertValidStorageKey,
  StorageObjectNotFoundError,
  SYSTEM_HEARTBEAT_JOB_TYPE,
  type ClaimedJob,
  type JobBeforeRunHook,
  type JobHandler,
  type JobQueue,
  type JobRunnerLogger,
  type StorageProvider,
} from '@mietroyal/integrations';
import { z } from '@mietroyal/validation';
import { DemoDatasetService } from '../demo/dataset.ts';
import {
  DEMO_DATASET_CHANGED_REASON,
  DEMO_STORAGE_CLEANUP_JOB_TYPE,
  isDemoDatasetBoundJob,
} from '../demo/job-types.ts';
import {
  createDemoResetGate,
  DEMO_RESET_GATE_CACHE_TTL_MS,
  type DemoResetGate,
  type DemoResetGateLogger,
} from '../demo/reset-gate.ts';

/**
 * Phase 14 (Design §7, Worker): Reset-Guard für den Job-Runner – derselbe
 * Zustand wie das 503-Gate der API (`demo_dataset_state.reset_in_progress`,
 * In-Process-Cache 1 s). Läuft ein Demo-Reset, wird jeder Business-Job um
 * 15 s zurückgelegt, ohne einen Versuch zu verbrauchen. Ausgenommen ist nur
 * `system.heartbeat` (Infrastruktur ohne Fachdaten); der Scanner
 * `communication.scan_due` wartet bewusst ebenfalls.
 *
 * Phase 14 (reset, Order §21): zusätzlich werden datensatzgebundene Jobs
 * (`isDemoDatasetBoundJob`), die VOR dem Beginn des letzten Resets eingereiht
 * wurden (`created_at < last_reset_started_at`, beide DB-Uhr), ohne Ausführung
 * als `dead` mit `last_error = DEMO_DATASET_CHANGED` beendet – ein Job des
 * alten Datensatzes (z. B. ein beim Reset laufender `processing`-Job, der die
 * Löschung überlebt hat) wirkt nie auf den neuen Seed. Eine UUID-Kollision
 * ist dabei keine Sicherheitsannahme: der Zeitstempel entscheidet.
 */

export const DEMO_JOB_DEFER_MS = 15_000;
export const DEMO_RESET_EXEMPT_JOB_TYPES: ReadonlySet<string> = new Set([
  SYSTEM_HEARTBEAT_JOB_TYPE,
]);

export { createDemoResetGate, DemoDatasetService, DEMO_STORAGE_CLEANUP_JOB_TYPE };
export type { DemoResetGate };

/** Quelle des Reset-Beginns (Worker: Cache mit derselben TTL wie das Gate). */
export interface DemoDatasetChangeSource {
  lastResetStartedAt(): Promise<Date | null>;
}

export function createDemoJobGuard(
  gate: Pick<DemoResetGate, 'isResetInProgress'>,
  options: {
    deferMs?: number;
    exemptJobTypes?: ReadonlySet<string>;
    /** Phase 14 (reset): ohne Quelle entfällt nur der Zeitstempel-Skip (Verhalten wie bisher). */
    datasetChange?: DemoDatasetChangeSource;
  } = {},
): JobBeforeRunHook {
  const deferMs = options.deferMs ?? DEMO_JOB_DEFER_MS;
  const exempt = options.exemptJobTypes ?? DEMO_RESET_EXEMPT_JOB_TYPES;
  const datasetChange = options.datasetChange;
  return async (job) => {
    if (exempt.has(job.type)) return 'run';
    if (datasetChange !== undefined && isStaleCandidate(job)) {
      const lastResetStartedAt = await datasetChange.lastResetStartedAt();
      if (
        lastResetStartedAt !== null &&
        job.createdAt !== undefined &&
        job.createdAt.getTime() < lastResetStartedAt.getTime()
      ) {
        return { skip: { reason: DEMO_DATASET_CHANGED_REASON } };
      }
    }
    if (!(await gate.isResetInProgress())) return 'run';
    return { defer: { delayMs: deferMs, reason: 'DEMO_RESET' } };
  };
}

/** Nur datensatzgebundene Jobs mit bekanntem Einreihungszeitpunkt kommen für den Skip in Frage. */
function isStaleCandidate(job: ClaimedJob): boolean {
  return job.createdAt !== undefined && isDemoDatasetBoundJob(job.type, job.payload);
}

/** Beginn des letzten Resets mit kurzem In-Process-Cache (TTL wie das Gate). */
export function createDemoDatasetChangeSource(
  dataset: Pick<DemoDatasetService, 'lastResetStartedAt'>,
  options: { cacheTtlMs?: number; now?: () => number } = {},
): DemoDatasetChangeSource {
  const ttl = options.cacheTtlMs ?? DEMO_RESET_GATE_CACHE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  let cached: { value: Date | null; at: number } | null = null;
  return {
    async lastResetStartedAt() {
      if (cached !== null && now() - cached.at < ttl) return cached.value;
      const value = await dataset.lastResetStartedAt();
      cached = { value, at: now() };
      return value;
    },
  };
}

/** Komfort für `apps/worker`: Guard auf einem eigenen Gate über die Worker-DB. */
export function createDemoWorkerGuard(deps: {
  db: Database;
  logger?: DemoResetGateLogger;
}): JobBeforeRunHook {
  const dataset = new DemoDatasetService(deps.db);
  const gate = createDemoResetGate({
    dataset,
    cacheTtlMs: DEMO_RESET_GATE_CACHE_TTL_MS,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
  return createDemoJobGuard(gate, { datasetChange: createDemoDatasetChangeSource(dataset) });
}

// ── Phase 14 (reset, Order §22): Nachbereinigung des Demo-Storage ────────────

/** Schlüssel je Job (größere Mengen werden auf mehrere Jobs verteilt). */
export const DEMO_STORAGE_CLEANUP_BATCH_SIZE = 100;

export interface DemoStorageCleanupPayload {
  resetRunId: string;
  keys: string[];
}

const payloadSchema = z.strictObject({
  resetRunId: z.string().min(1).max(64),
  keys: z.array(z.string().min(1).max(512)).max(DEMO_STORAGE_CLEANUP_BATCH_SIZE),
});

export function demoStorageCleanupJobKey(resetRunId: string, batchIndex: number): string {
  return `demo-storage-cleanup:${resetRunId}:${batchIndex}`;
}

/**
 * Fehlgeschlagene Storage-Löschungen eines Resets als Jobs einreihen (ein Job
 * je Batch, Idempotency-Key `demo-storage-cleanup:<resetRunId>:<n>`). Der
 * neue Datensatz ist zu diesem Zeitpunkt bereits konsistent (keine Zeile
 * referenziert die Schlüssel mehr); der Job holt nur das Löschen nach.
 */
export async function enqueueDemoStorageCleanup(
  queue: Pick<JobQueue, 'enqueue'>,
  input: { resetRunId: string; keys: readonly string[] },
): Promise<string[]> {
  const jobIds: string[] = [];
  for (let batch = 0; batch * DEMO_STORAGE_CLEANUP_BATCH_SIZE < input.keys.length; batch += 1) {
    const offset = batch * DEMO_STORAGE_CLEANUP_BATCH_SIZE;
    const payload: DemoStorageCleanupPayload = {
      resetRunId: input.resetRunId,
      keys: input.keys.slice(offset, offset + DEMO_STORAGE_CLEANUP_BATCH_SIZE),
    };
    const result = await queue.enqueue(DEMO_STORAGE_CLEANUP_JOB_TYPE, payload, {
      idempotencyKey: demoStorageCleanupJobKey(input.resetRunId, batch),
    });
    jobIds.push(result.jobId);
  }
  return jobIds;
}

/**
 * Handler `demo.storage_cleanup`: löscht die Schlüssel erneut – ausschließlich
 * im eigenen (Demo-)Storage, denn der Prozess trägt nur die Demo-Konfiguration
 * (Order §22: nie ein Production-Key, kein Bucket-weites Löschen). Ein bereits
 * fehlendes Objekt gilt als erledigt (idempotent, AT-LEAST-ONCE); bleibt ein
 * Schlüssel unlöschbar, scheitert der Job (Retry, zuletzt `dead` – sichtbar im
 * Status-Endpunkt und in Einstellungen → Demo). Logs nur Zähler/Fehlerklasse.
 */
export function createDemoStorageCleanupHandler(
  storage: Pick<StorageProvider, 'delete'>,
  options: { logger?: JobRunnerLogger | undefined } = {},
): JobHandler {
  return async (job) => {
    const payload = payloadSchema.parse(job.payload);
    let removed = 0;
    let missing = 0;
    let failed = 0;
    let lastErrorName = 'Error';
    for (const key of payload.keys) {
      assertValidStorageKey(key);
      try {
        await storage.delete(key);
        removed += 1;
      } catch (error) {
        if (error instanceof StorageObjectNotFoundError) {
          missing += 1;
          continue;
        }
        failed += 1;
        lastErrorName = error instanceof Error ? error.name : 'Error';
      }
    }
    options.logger?.info(
      { resetRunId: payload.resetRunId, removed, missing, failed },
      'Demo-Storage-Nachbereinigung ausgeführt',
    );
    if (failed > 0) {
      const error = new Error(
        `Demo-Storage-Nachbereinigung: ${failed} Objekt(e) nicht löschbar (${lastErrorName})`,
      );
      error.name = 'DemoStorageCleanupError';
      throw error;
    }
  };
}
