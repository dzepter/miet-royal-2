/**
 * Zentraler Scheduler-Job `communication.scan_due` (Phase 12, Order §32/§37)
 * auf der bestehenden PostgreSQL-Queue – kein zweites Scheduler-System.
 *
 * Takt: alle 2 Minuten. Der Worker reiht beim Boot den aktuellen Zeit-Bucket
 * ein (`communication.scan_due:<Bucket-Beginn ISO>`), jeder Lauf reiht ZUERST
 * den nächsten Bucket (runAt = Bucket-Beginn) ein – integration_jobs.
 * idempotency_key bleibt für immer UNIQUE, deshalb trägt jeder Lauf den
 * Schlüssel seiner Zielminute (Boot-Enqueue und Self-Re-Enqueue kollidieren
 * nie zu einem Doppellauf).
 * Härtung B6: Der Folge-Bucket ist max(Payload-Bucket + 2 min, Bucket nach
 * now) – eine nachgehende Worker-Uhr re-enqueued nie den eigenen Schlüssel.
 * Zusätzlich reiht der Worker per Watchdog (`enqueueScanDue`, jede Minute)
 * den aktuellen Bucket ein – dedupliziert, setzt eine abgerissene Kette neu
 * auf; da je Bucket genau ein Schlüssel existiert, entstehen keine Doppelketten.
 *
 * Ein Lauf ruft nacheinander, jeweils fehlertolerant (Fehler werden mit Code
 * geloggt, die weiteren Scanner laufen trotzdem):
 *  1. alle registrierten `DueScanner` (Reminder 7d/1d, Push-Regeln 1h/Overdue/
 *     Risk 6h, Gutschein-Sweep …) – jede Zustellung hat ihren eigenen
 *     Idempotenzschlüssel, der Scan selbst ist beliebig wiederholbar;
 *  2. den Outbox-Backstop: pending/retry-Zeilen mit fälligem nextAttemptAt
 *     (und veraltete `sending`-Zeilen) ohne offenen `mail.send`-Job erhalten
 *     einen Job mit Bucket-Schlüssel (`mail.send:<id>:backstop:<bucket>`);
 *     veraltete `sending`-Zeilen sendet der Job NICHT erneut, sondern schließt
 *     sie als `outcome_unknown` (SENDING_STALE) ab (Härtung RA-2);
 *  3. den Retention-Backstop: Chatfotos abgeschlossener Vorgänge bei jedem
 *     Lauf, Text-Retention täglich als eigener Job `communication.cleanup_
 *     retention:<JJJJ-MM-TT>`.
 */
import { integrationJobs, mailDeliveries, type Database } from '@mietroyal/database';
import type { JobHandler, JobQueue, JobRunnerLogger } from '@mietroyal/integrations';
import { and, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { followUpBucket, payloadBucket } from './chain-bucket.ts';
import { MAIL_SEND_JOB_MAX_ATTEMPTS } from './mail/outbox.ts';
import { MAIL_SENDING_STALE_MS } from './mail/send-job.ts';
import {
  berlinDay,
  retentionBackstopJobKey,
  type RetentionCleanupService,
  type RetentionJobPayload,
} from './retention/cleanup.ts';
import {
  COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE,
  COMMUNICATION_SCAN_DUE_JOB_TYPE,
  MAIL_SEND_JOB_TYPE,
} from './types.ts';

export const SCAN_DUE_INTERVAL_MS = 2 * 60 * 1000;
/** Outbox-Zeilen bekommen erst nach dieser Karenz einen Backstop-Job (der normale Pfad plant direkt nach Commit). */
export const OUTBOX_BACKSTOP_GRACE_MS = 5 * 60 * 1000;

export interface DueScanner {
  name: string;
  scanDue(now: Date): Promise<unknown>;
}

export function scanDueBucketStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / SCAN_DUE_INTERVAL_MS) * SCAN_DUE_INTERVAL_MS);
}

export function nextScanDueBucket(now: Date): Date {
  return new Date(scanDueBucketStart(now).getTime() + SCAN_DUE_INTERVAL_MS);
}

export function scanDueIdempotencyKey(bucketStart: Date): string {
  return `${COMMUNICATION_SCAN_DUE_JOB_TYPE}:${bucketStart.toISOString()}`;
}

export function outboxBackstopJobKey(deliveryId: string, bucketStart: Date): string {
  return `${MAIL_SEND_JOB_TYPE}:${deliveryId}:backstop:${bucketStart.toISOString()}`;
}

/** Boot-Enqueue (Worker): aktueller Bucket, sofort fällig; Neustarts erzeugen keine Jobflut. */
export async function enqueueScanDue(queue: JobQueue, now = new Date()): Promise<void> {
  const bucket = scanDueBucketStart(now);
  await queue.enqueue(
    COMMUNICATION_SCAN_DUE_JOB_TYPE,
    { bucket: bucket.toISOString() },
    { idempotencyKey: scanDueIdempotencyKey(bucket), maxAttempts: 3 },
  );
}

export interface ScanDueDeps {
  db: Database;
  queue: JobQueue;
  scanners: readonly DueScanner[];
  retention: RetentionCleanupService;
  logger?: JobRunnerLogger | undefined;
  now?: () => Date;
  /** Tests: Self-Re-Enqueue abschalten (direkter Aufruf ohne Kette). */
  reenqueue?: boolean;
}

export interface ScanDueResult {
  scanners: { name: string; ok: boolean; errorCode: string | null }[];
  outboxBackstop: number;
  retention: { photosDeleted: number; textJobEnqueued: boolean };
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.name || 'Error' : 'Error';
}

/**
 * Outbox-Backstop: fällige Zeilen ohne offenen Job. „Offen“ = ein `mail.send`-
 * Job mit dieser deliveryId in pending/processing. Der Backstop-Job trägt den
 * Bucket-Schlüssel; der Handler ist ohne Claim ein No-op (kein Doppelversand).
 */
export async function scheduleOutboxBackstop(
  db: Database,
  queue: JobQueue,
  now: Date,
): Promise<number> {
  const bucket = scanDueBucketStart(now);
  const graceBefore = new Date(now.getTime() - OUTBOX_BACKSTOP_GRACE_MS);
  const staleBefore = new Date(now.getTime() - MAIL_SENDING_STALE_MS);
  const rows = await db
    .select({ id: mailDeliveries.id, attempts: mailDeliveries.attempts })
    .from(mailDeliveries)
    .where(
      and(
        or(
          and(
            inArray(mailDeliveries.status, ['pending', 'retry']),
            or(isNull(mailDeliveries.nextAttemptAt), lte(mailDeliveries.nextAttemptAt, now)),
            lt(mailDeliveries.updatedAt, graceBefore),
          ),
          and(eq(mailDeliveries.status, 'sending'), lt(mailDeliveries.sendingSince, staleBefore)),
        ),
        sql`NOT EXISTS (
          SELECT 1 FROM ${integrationJobs} j
          WHERE j.type = ${MAIL_SEND_JOB_TYPE}
            AND j.status IN ('pending', 'processing')
            AND j.payload->>'deliveryId' = ${mailDeliveries.id}::text
        )`,
      ),
    )
    .limit(200);
  let scheduled = 0;
  for (const row of rows) {
    const result = await queue.enqueue(
      MAIL_SEND_JOB_TYPE,
      { deliveryId: row.id, attempt: row.attempts, backstop: true },
      {
        idempotencyKey: outboxBackstopJobKey(row.id, bucket),
        maxAttempts: MAIL_SEND_JOB_MAX_ATTEMPTS,
      },
    );
    if (!result.deduplicated) scheduled += 1;
  }
  return scheduled;
}

export async function enqueueDailyRetentionBackstop(queue: JobQueue, now: Date): Promise<boolean> {
  const day = berlinDay(now);
  const result = await queue.enqueue(
    COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE,
    { scope: 'backstop', day, textRetention: true } satisfies RetentionJobPayload,
    { idempotencyKey: retentionBackstopJobKey(day), maxAttempts: 3 },
  );
  return !result.deduplicated;
}

/**
 * Ein kompletter Scan-Lauf (auch direkt aus Tests aufrufbar). `bucket`: der
 * Bucket des laufenden Jobs (Payload) – der Folgejob liegt immer danach.
 */
export async function runScanDue(
  deps: ScanDueDeps,
  now: Date,
  options: { bucket?: Date | null } = {},
): Promise<ScanDueResult> {
  const { logger } = deps;
  if (deps.reenqueue !== false) {
    // Nächsten Lauf ZUERST einreihen (kein Abriss der Kette bei Fehlern unten).
    const next = followUpBucket(options.bucket ?? null, now, SCAN_DUE_INTERVAL_MS);
    await deps.queue.enqueue(
      COMMUNICATION_SCAN_DUE_JOB_TYPE,
      { bucket: next.toISOString() },
      { idempotencyKey: scanDueIdempotencyKey(next), runAt: next, maxAttempts: 3 },
    );
  }
  const result: ScanDueResult = {
    scanners: [],
    outboxBackstop: 0,
    retention: { photosDeleted: 0, textJobEnqueued: false },
  };
  for (const scanner of deps.scanners) {
    try {
      await scanner.scanDue(now);
      result.scanners.push({ name: scanner.name, ok: true, errorCode: null });
    } catch (error) {
      const code = errorCode(error);
      result.scanners.push({ name: scanner.name, ok: false, errorCode: code });
      logger?.error(
        { scanner: scanner.name, errorCode: code },
        'communication.scan_due: Scanner fehlgeschlagen',
      );
    }
  }
  try {
    result.outboxBackstop = await scheduleOutboxBackstop(deps.db, deps.queue, now);
  } catch (error) {
    logger?.error(
      { scanner: 'outbox_backstop', errorCode: errorCode(error) },
      'communication.scan_due: Outbox-Backstop fehlgeschlagen',
    );
  }
  try {
    result.retention.photosDeleted = (await deps.retention.cleanupPhotosBackstop()).deleted;
    result.retention.textJobEnqueued = await enqueueDailyRetentionBackstop(deps.queue, now);
  } catch (error) {
    logger?.error(
      { scanner: 'retention_backstop', errorCode: errorCode(error) },
      'communication.scan_due: Retention-Backstop fehlgeschlagen',
    );
  }
  logger?.info(
    {
      scanners: result.scanners,
      outboxBackstop: result.outboxBackstop,
      retention: result.retention,
    },
    'communication.scan_due ausgeführt',
  );
  return result;
}

export function createScanDueHandler(deps: ScanDueDeps): JobHandler {
  return async (job) => {
    const now = deps.now === undefined ? new Date() : deps.now();
    await runScanDue(deps, now, { bucket: payloadBucket(job.payload) });
  };
}
