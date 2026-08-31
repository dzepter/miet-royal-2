import type pg from 'pg';
import { computeBackoffMs, DEFAULT_BASE_BACKOFF_MS, DEFAULT_MAX_BACKOFF_MS } from './backoff.ts';
import type {
  ClaimedJob,
  EnqueueOptions,
  EnqueueResult,
  JobQueue,
  ReclaimResult,
} from './queue.ts';

interface JobRow {
  id: string;
  type: string;
  payload: unknown;
  idempotency_key: string;
  attempts: number;
  max_attempts: number;
}

/** Lease-Dauer: solange darf ein Versuch laufen, bevor er als verwaist gilt. */
export const DEFAULT_LEASE_MS = 300_000; // 5 Minuten

export interface PostgresJobQueueOptions {
  /** Basis für exponentiellen Retry-Backoff; nur für Tests verkleinern. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /**
   * Lease-/Visibility-Timeout in Millisekunden. Muss deutlich über der
   * längsten erwarteten Job-Laufzeit liegen: läuft die Lease ab, während der
   * Worker noch arbeitet, wird der Job neu vergeben (at-least-once).
   */
  leaseMs?: number;
}

/**
 * PostgreSQL-basierte Jobqueue auf der Tabelle integration_jobs.
 *
 * - Exklusive Job-Vergabe über FOR UPDATE SKIP LOCKED: derselbe Job kann
 *   nie gleichzeitig an zwei Worker gehen.
 * - Idempotenz über UNIQUE(idempotency_key).
 * - Retry mit exponentiellem Backoff bis max_attempts, danach "dead".
 * - Crash-Recovery über Leases: jeder Claim setzt lease_expires_at.
 *   reclaimExpired() gibt Jobs mit abgelaufener Lease kontrolliert wieder
 *   frei (oder setzt sie auf dead, wenn die Versuche erschöpft sind); der
 *   JobRunner ruft das zu Beginn jedes Poll-Ticks auf. markSucceeded und
 *   markFailed prüfen zusätzlich locked_by, damit ein Zombie-Worker nach
 *   Lease-Ablauf einen bereits neu vergebenen Job nicht mehr verändert.
 */
export class PostgresJobQueue implements JobQueue {
  private readonly pool: pg.Pool;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly leaseMs: number;

  constructor(pool: pg.Pool, options: PostgresJobQueueOptions = {}) {
    this.pool = pool;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    if (this.leaseMs < 1) throw new RangeError('leaseMs muss positiv sein');
  }

  async enqueue(type: string, payload: unknown, options: EnqueueOptions): Promise<EnqueueResult> {
    if (type.trim() === '') throw new Error('Jobtyp darf nicht leer sein');
    if (options.idempotencyKey.trim() === '') {
      throw new Error('idempotencyKey darf nicht leer sein');
    }

    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO integration_jobs (type, payload, idempotency_key, run_at, max_attempts)
       VALUES ($1, $2::jsonb, $3, COALESCE($4, now()), $5)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        type,
        JSON.stringify(payload ?? {}),
        options.idempotencyKey,
        options.runAt ?? null,
        options.maxAttempts ?? 5,
      ],
    );

    const insertedRow = inserted.rows[0];
    if (insertedRow !== undefined) {
      return { jobId: insertedRow.id, deduplicated: false };
    }

    const existing = await this.pool.query<{ id: string }>(
      'SELECT id FROM integration_jobs WHERE idempotency_key = $1',
      [options.idempotencyKey],
    );
    const existingRow = existing.rows[0];
    if (existingRow === undefined) {
      // Zwischen INSERT-Konflikt und SELECT gelöscht – im Betrieb werden Jobs
      // nicht gelöscht, daher nur als defensiver Fehler.
      throw new Error('Job mit diesem idempotencyKey konnte nicht ermittelt werden');
    }
    return { jobId: existingRow.id, deduplicated: true };
  }

  async claimNext(workerId: string): Promise<ClaimedJob | null> {
    const result = await this.pool.query<JobRow>(
      `UPDATE integration_jobs
       SET status = 'processing',
           attempts = integration_jobs.attempts + 1,
           locked_at = now(),
           locked_by = $1,
           lease_expires_at = now() + ($2::int * interval '1 millisecond'),
           updated_at = now()
       WHERE integration_jobs.id = (
         SELECT id FROM integration_jobs
         WHERE status = 'pending' AND run_at <= now()
         ORDER BY run_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, type, payload, idempotency_key, attempts, max_attempts`,
      [workerId, this.leaseMs],
    );

    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      type: row.type,
      payload: row.payload,
      idempotencyKey: row.idempotency_key,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      claimedBy: workerId,
    };
  }

  async markSucceeded(job: ClaimedJob): Promise<void> {
    // locked_by-Guard: wurde die Lease inzwischen reclaimt und der Job neu
    // vergeben, ist dieser Aufruf ein No-op (der neue Claim entscheidet).
    await this.pool.query(
      `UPDATE integration_jobs
       SET status = 'succeeded', locked_at = NULL, locked_by = NULL,
           lease_expires_at = NULL, last_error = NULL, updated_at = now()
       WHERE id = $1 AND status = 'processing' AND locked_by = $2`,
      [job.id, job.claimedBy],
    );
  }

  async markFailed(job: ClaimedJob, errorMessage: string): Promise<void> {
    const exhausted = job.attempts >= job.maxAttempts;
    if (exhausted) {
      await this.pool.query(
        `UPDATE integration_jobs
         SET status = 'dead', locked_at = NULL, locked_by = NULL,
             lease_expires_at = NULL, last_error = $2, updated_at = now()
         WHERE id = $1 AND status = 'processing' AND locked_by = $3`,
        [job.id, errorMessage, job.claimedBy],
      );
      return;
    }

    const backoffMs = computeBackoffMs(job.attempts, this.baseBackoffMs, this.maxBackoffMs);
    await this.pool.query(
      `UPDATE integration_jobs
       SET status = 'pending', locked_at = NULL, locked_by = NULL,
           lease_expires_at = NULL, last_error = $2,
           run_at = now() + ($3::int * interval '1 millisecond'),
           updated_at = now()
       WHERE id = $1 AND status = 'processing' AND locked_by = $4`,
      [job.id, errorMessage, backoffMs, job.claimedBy],
    );
  }

  async reclaimExpired(): Promise<ReclaimResult> {
    // Atomar und mehrworker-sicher: konkurrierende Aufrufe serialisiert
    // PostgreSQL über Zeilensperren; wer zu spät kommt, findet die Zeile
    // nicht mehr im Status processing und ändert nichts. Ein noch gültig
    // gelockter Job (lease_expires_at > now()) wird nie angefasst.
    // COALESCE-Fallback auf locked_at + Lease: fängt Alt-Zeilen ohne
    // lease_expires_at ab (geclaimt vor Migration 0001).
    const result = await this.pool.query<{ status: string }>(
      `UPDATE integration_jobs
       SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END::integration_job_status,
           run_at = now(),
           locked_at = NULL,
           locked_by = NULL,
           lease_expires_at = NULL,
           last_error = 'Lease abgelaufen – Worker vermutlich abgestürzt (Versuch ' || attempts || '/' || max_attempts || ')',
           updated_at = now()
       WHERE status = 'processing'
         AND COALESCE(lease_expires_at, locked_at + ($1::int * interval '1 millisecond')) <= now()
       RETURNING status`,
      [this.leaseMs],
    );

    let reclaimed = 0;
    let died = 0;
    for (const row of result.rows) {
      if (row.status === 'dead') died += 1;
      else reclaimed += 1;
    }
    return { reclaimed, died };
  }
}
