/**
 * Integrationstest gegen echtes PostgreSQL (infra/docker-compose.yml).
 * Beweist die Phase-0-Anforderungen an die Jobqueue:
 * enqueue → process → retry → Idempotenz (PHASE_00_FOUNDATION.md, Nr. 7).
 *
 * Voraussetzung: `pnpm infra:up` (nutzt die Datenbank mietroyal_test).
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { createDb, createPool, runMigrations } from '@mietroyal/database';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobRunner } from '../src/jobs/runner.ts';
import { PostgresJobQueue } from '../src/jobs/postgres-queue.ts';
import { SYSTEM_HEARTBEAT_JOB_TYPE, systemHeartbeatHandler } from '../src/jobs/system-heartbeat.ts';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://mietroyal:mietroyal_local_dev@localhost:55432/mietroyal_test';

let pool: pg.Pool;

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await runMigrations(createDb(pool));
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE integration_jobs');
});

async function fetchJob(jobId: string): Promise<Record<string, unknown>> {
  const result = await pool.query('SELECT * FROM integration_jobs WHERE id = $1', [jobId]);
  const row: Record<string, unknown> | undefined = result.rows[0];
  if (row === undefined) throw new Error(`Job ${jobId} nicht gefunden`);
  return row;
}

describe('PostgresJobQueue (echte Datenbank)', () => {
  it('verarbeitet enqueue → claim → succeed', async () => {
    const queue = new PostgresJobQueue(pool);
    const { jobId, deduplicated } = await queue.enqueue(
      SYSTEM_HEARTBEAT_JOB_TYPE,
      { note: 'phase-0' },
      { idempotencyKey: 'heartbeat-1' },
    );
    expect(deduplicated).toBe(false);

    const runner = new JobRunner(queue, 'test-worker');
    runner.register(SYSTEM_HEARTBEAT_JOB_TYPE, systemHeartbeatHandler);
    expect(await runner.runOnce()).toBe('processed');
    expect(await runner.runOnce()).toBe('idle');

    const row = await fetchJob(jobId);
    expect(row.status).toBe('succeeded');
    expect(row.attempts).toBe(1);
  });

  it('dedupliziert über den Idempotency-Key (kein zweiter Job)', async () => {
    const queue = new PostgresJobQueue(pool);
    const first = await queue.enqueue(SYSTEM_HEARTBEAT_JOB_TYPE, {}, { idempotencyKey: 'once' });
    const second = await queue.enqueue(
      SYSTEM_HEARTBEAT_JOB_TYPE,
      { anders: true },
      { idempotencyKey: 'once' },
    );

    expect(second.deduplicated).toBe(true);
    expect(second.jobId).toBe(first.jobId);

    const count = await pool.query('SELECT count(*)::int AS n FROM integration_jobs');
    expect(count.rows[0]?.n).toBe(1);
  });

  it('wiederholt fehlgeschlagene Jobs mit Backoff und schafft sie im 2. Versuch', async () => {
    const queue = new PostgresJobQueue(pool, { baseBackoffMs: 10 });
    const { jobId } = await queue.enqueue('test.flaky', {}, { idempotencyKey: 'flaky-1' });

    let calls = 0;
    const runner = new JobRunner(queue, 'test-worker');
    runner.register('test.flaky', async () => {
      calls += 1;
      if (calls === 1) throw new Error('simulierter Ausfall');
    });

    expect(await runner.runOnce()).toBe('failed');
    const afterFailure = await fetchJob(jobId);
    expect(afterFailure.status).toBe('pending');
    expect(afterFailure.attempts).toBe(1);
    expect(afterFailure.last_error).toContain('simulierter Ausfall');

    // Auf den Backoff (10 ms) warten, dann muss der Job erneut fällig sein.
    await sleep(50);
    expect(await runner.runOnce()).toBe('processed');

    const afterSuccess = await fetchJob(jobId);
    expect(afterSuccess.status).toBe('succeeded');
    expect(afterSuccess.attempts).toBe(2);
    expect(afterSuccess.last_error).toBeNull();
  });

  it('setzt Jobs nach Ausschöpfen der Versuche auf "dead"', async () => {
    const queue = new PostgresJobQueue(pool, { baseBackoffMs: 1 });
    const { jobId } = await queue.enqueue(
      'test.always-broken',
      {},
      { idempotencyKey: 'broken-1', maxAttempts: 2 },
    );

    const runner = new JobRunner(queue, 'test-worker');
    runner.register('test.always-broken', async () => {
      throw new Error('geht nie');
    });

    expect(await runner.runOnce()).toBe('failed');
    await sleep(30);
    expect(await runner.runOnce()).toBe('failed');
    expect(await runner.runOnce()).toBe('idle');

    const row = await fetchJob(jobId);
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(2);
  });

  it('führt Jobs ohne registrierten Handler nicht endlos aus', async () => {
    const queue = new PostgresJobQueue(pool, { baseBackoffMs: 1 });
    const { jobId } = await queue.enqueue(
      'test.unbekannt',
      {},
      { idempotencyKey: 'unbekannt-1', maxAttempts: 1 },
    );

    const runner = new JobRunner(queue, 'test-worker');
    expect(await runner.runOnce()).toBe('failed');

    const row = await fetchJob(jobId);
    expect(row.status).toBe('dead');
    expect(row.last_error).toContain('Kein Handler');
  });

  it('respektiert runAt (Job ist erst später fällig)', async () => {
    const queue = new PostgresJobQueue(pool);
    await queue.enqueue(
      SYSTEM_HEARTBEAT_JOB_TYPE,
      {},
      { idempotencyKey: 'later-1', runAt: new Date(Date.now() + 60_000) },
    );

    const runner = new JobRunner(queue, 'test-worker');
    runner.register(SYSTEM_HEARTBEAT_JOB_TYPE, systemHeartbeatHandler);
    expect(await runner.runOnce()).toBe('idle');
  });
});
