import type pg from 'pg';
import { computeBackoffMs, DEFAULT_BASE_BACKOFF_MS, DEFAULT_MAX_BACKOFF_MS } from './backoff.ts';
import type { ClaimedJob, EnqueueOptions, EnqueueResult, JobQueue } from './queue.ts';

interface JobRow {
  id: string;
  type: string;
  payload: unknown;
  idempotency_key: string;
  attempts: number;
  max_attempts: number;
}

export interface PostgresJobQueueOptions {
  /** Basis für exponentiellen Retry-Backoff; nur für Tests verkleinern. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * PostgreSQL-basierte Jobqueue auf der Tabelle integration_jobs.
 * Exklusive Job-Vergabe über FOR UPDATE SKIP LOCKED, Idempotenz über
 * UNIQUE(idempotency_key), Retry mit exponentiellem Backoff.
 */
export class PostgresJobQueue implements JobQueue {
  private readonly pool: pg.Pool;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(pool: pg.Pool, options: PostgresJobQueueOptions = {}) {
    this.pool = pool;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
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
           updated_at = now()
       WHERE integration_jobs.id = (
         SELECT id FROM integration_jobs
         WHERE status = 'pending' AND run_at <= now()
         ORDER BY run_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, type, payload, idempotency_key, attempts, max_attempts`,
      [workerId],
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
    };
  }

  async markSucceeded(job: ClaimedJob): Promise<void> {
    await this.pool.query(
      `UPDATE integration_jobs
       SET status = 'succeeded', locked_at = NULL, locked_by = NULL,
           last_error = NULL, updated_at = now()
       WHERE id = $1 AND status = 'processing'`,
      [job.id],
    );
  }

  async markFailed(job: ClaimedJob, errorMessage: string): Promise<void> {
    const exhausted = job.attempts >= job.maxAttempts;
    if (exhausted) {
      await this.pool.query(
        `UPDATE integration_jobs
         SET status = 'dead', locked_at = NULL, locked_by = NULL,
             last_error = $2, updated_at = now()
         WHERE id = $1 AND status = 'processing'`,
        [job.id, errorMessage],
      );
      return;
    }

    const backoffMs = computeBackoffMs(job.attempts, this.baseBackoffMs, this.maxBackoffMs);
    await this.pool.query(
      `UPDATE integration_jobs
       SET status = 'pending', locked_at = NULL, locked_by = NULL,
           last_error = $2, run_at = now() + ($3::int * interval '1 millisecond'),
           updated_at = now()
       WHERE id = $1 AND status = 'processing'`,
      [job.id, errorMessage, backoffMs],
    );
  }
}
