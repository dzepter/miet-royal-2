import { describe, expect, it } from 'vitest';
import type { ClaimedJob, JobQueue, ReclaimResult } from '../src/jobs/queue.ts';
import { JobRunner } from '../src/jobs/runner.ts';

/**
 * Phase 14 (demo): `beforeRun`-Hook des JobRunners – ein vertagter Job wird
 * über `queue.defer` ohne Attempt-Verbrauch zurückgelegt, der Handler läuft
 * nicht; ohne Vertagung läuft alles wie bisher.
 */

class RecordingQueue implements JobQueue {
  pending: ClaimedJob[] = [];
  deferred: Array<{ job: ClaimedJob; runAt: Date }> = [];
  succeeded: string[] = [];
  failed: string[] = [];
  /** Phase 14 (reset): ohne Ausführung beendete Jobs (Grund = last_error). */
  dead: Array<{ job: ClaimedJob; reason: string }> = [];

  constructor(jobs: ClaimedJob[]) {
    this.pending = [...jobs];
  }

  async enqueue(): Promise<{ jobId: string; deduplicated: boolean }> {
    return { jobId: 'fake', deduplicated: false };
  }

  async claimNext(): Promise<ClaimedJob | null> {
    return this.pending.shift() ?? null;
  }

  async markSucceeded(job: ClaimedJob): Promise<void> {
    this.succeeded.push(job.id);
  }

  async markFailed(job: ClaimedJob, errorMessage: string): Promise<void> {
    this.failed.push(`${job.id}:${errorMessage}`);
  }

  async defer(job: ClaimedJob, runAt: Date): Promise<void> {
    this.deferred.push({ job, runAt });
  }

  async markDead(job: ClaimedJob, reason: string): Promise<void> {
    this.dead.push({ job, reason });
  }

  async reclaimExpired(): Promise<ReclaimResult> {
    return { reclaimed: 0, died: 0 };
  }
}

/** Queue ohne defer – wie die bisherigen Fakes. */
class LegacyQueue extends RecordingQueue {
  override defer = undefined as unknown as RecordingQueue['defer'];
}

/** Queue mit defer, aber ohne markDead (Phase 14 reset: Fallback auf markFailed). */
class DeferOnlyQueue extends RecordingQueue {
  override markDead = undefined as unknown as RecordingQueue['markDead'];
}

function job(id: string, type: string): ClaimedJob {
  return { id, type, payload: {}, idempotencyKey: id, attempts: 1, maxAttempts: 5, claimedBy: 'w' };
}

describe('JobRunner beforeRun/defer (Phase 14, demo)', () => {
  it('D-R1. beforeRun ⇒ defer: Job wird um delayMs zurückgelegt, Handler läuft nicht, kein markFailed', async () => {
    const queue = new RecordingQueue([job('j1', 'mail.send')]);
    const runner = new JobRunner(queue, 'w');
    let handled = 0;
    runner.register('mail.send', async () => {
      handled += 1;
    });
    runner.setBeforeRun(async () => ({ defer: { delayMs: 15_000, reason: 'DEMO_RESET' } }));
    const before = Date.now();
    expect(await runner.runOnce()).toBe('deferred');
    expect(handled).toBe(0);
    expect(queue.failed).toEqual([]);
    expect(queue.succeeded).toEqual([]);
    expect(queue.deferred).toHaveLength(1);
    const runAt = queue.deferred[0]!.runAt.getTime();
    expect(runAt).toBeGreaterThanOrEqual(before + 15_000);
    expect(runAt).toBeLessThanOrEqual(Date.now() + 15_000);
  });

  it('D-R2. beforeRun ⇒ run: Job läuft wie bisher; Hook kann je Jobtyp entscheiden (Heartbeat ausgenommen)', async () => {
    const queue = new RecordingQueue([job('h1', 'system.heartbeat'), job('m1', 'mail.send')]);
    const runner = new JobRunner(queue, 'w');
    const handled: string[] = [];
    runner.register('system.heartbeat', async (j) => {
      handled.push(j.id);
    });
    runner.register('mail.send', async (j) => {
      handled.push(j.id);
    });
    runner.setBeforeRun(async (j) =>
      j.type === 'system.heartbeat' ? 'run' : { defer: { delayMs: 1000 } },
    );
    expect(await runner.runOnce()).toBe('processed');
    expect(await runner.runOnce()).toBe('deferred');
    expect(await runner.runOnce()).toBe('idle');
    expect(handled).toEqual(['h1']);
    expect(queue.succeeded).toEqual(['h1']);
    expect(queue.deferred.map((d) => d.job.id)).toEqual(['m1']);
  });

  it('D-R3. wirft der Hook, läuft der Job normal (fail-open); ohne Hook unverändertes Verhalten', async () => {
    const queue = new RecordingQueue([job('a', 'mail.send'), job('b', 'mail.send')]);
    const runner = new JobRunner(queue, 'w');
    let handled = 0;
    runner.register('mail.send', async () => {
      handled += 1;
    });
    runner.setBeforeRun(async () => {
      throw new Error('Zustand nicht lesbar');
    });
    expect(await runner.runOnce()).toBe('processed');
    runner.setBeforeRun(null);
    expect(await runner.runOnce()).toBe('processed');
    expect(handled).toBe(2);
    expect(queue.deferred).toEqual([]);
  });

  it('D-R4. setBeforeRun verlangt eine Queue mit defer() (Programmierfehler beim Verdrahten)', () => {
    const runner = new JobRunner(new LegacyQueue([]), 'w');
    expect(() => runner.setBeforeRun(async () => 'run')).toThrow('unterstützt kein defer');
  });

  it('D-R5. (Phase 14 reset) beforeRun ⇒ skip: Job wird ohne Ausführung als dead mit dem Grund beendet (markDead), kein Retry, Ergebnis „skipped“', async () => {
    const old = { ...job('alt', 'mail.send'), createdAt: new Date('2026-10-01T08:00:00.000Z') };
    const fresh = { ...job('neu', 'mail.send'), createdAt: new Date('2026-10-31T08:00:00.000Z') };
    const queue = new RecordingQueue([old, fresh]);
    const runner = new JobRunner(queue, 'w');
    const handled: string[] = [];
    runner.register('mail.send', async (j) => {
      handled.push(j.id);
    });
    const resetStartedAt = new Date('2026-10-15T00:00:00.000Z');
    runner.setBeforeRun(async (j) =>
      j.createdAt !== undefined && j.createdAt < resetStartedAt
        ? { skip: { reason: 'DEMO_DATASET_CHANGED' } }
        : 'run',
    );
    expect(await runner.runOnce()).toBe('skipped');
    expect(await runner.runOnce()).toBe('processed');
    expect(await runner.runOnce()).toBe('idle');
    expect(handled).toEqual(['neu']);
    expect(queue.dead).toEqual([{ job: old, reason: 'DEMO_DATASET_CHANGED' }]);
    expect(queue.failed).toEqual([]);
    expect(queue.deferred).toEqual([]);
    expect(queue.succeeded).toEqual(['neu']);
  });

  it('D-R6. (Phase 14 reset) skip ohne markDead in der Queue ⇒ Fallback markFailed mit dem Grund; Handler läuft nicht', async () => {
    const queue = new DeferOnlyQueue([job('x', 'push.send')]);
    const runner = new JobRunner(queue, 'w');
    let handled = 0;
    runner.register('push.send', async () => {
      handled += 1;
    });
    runner.setBeforeRun(async () => ({ skip: { reason: 'DEMO_DATASET_CHANGED' } }));
    expect(await runner.runOnce()).toBe('skipped');
    expect(handled).toBe(0);
    expect(queue.failed).toEqual(['x:DEMO_DATASET_CHANGED']);
    expect(queue.dead).toEqual([]);
  });
});
