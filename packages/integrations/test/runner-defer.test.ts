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

  async markFailed(job: ClaimedJob): Promise<void> {
    this.failed.push(job.id);
  }

  async defer(job: ClaimedJob, runAt: Date): Promise<void> {
    this.deferred.push({ job, runAt });
  }

  async reclaimExpired(): Promise<ReclaimResult> {
    return { reclaimed: 0, died: 0 };
  }
}

/** Queue ohne defer – wie die bisherigen Fakes. */
class LegacyQueue extends RecordingQueue {
  override defer = undefined as unknown as RecordingQueue['defer'];
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
});
