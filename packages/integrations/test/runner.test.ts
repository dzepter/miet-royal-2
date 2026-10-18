import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { ClaimedJob, JobQueue, ReclaimResult } from '../src/jobs/queue.ts';
import { JOB_ERROR_SUMMARY_MAX_CHARS, JobRunner, summarizeJobError } from '../src/jobs/runner.ts';

/** Steuerbare In-Memory-Queue für Lebenszyklus-Tests ohne Datenbank. */
class FakeQueue implements JobQueue {
  claims = 0;
  reclaims = 0;

  async enqueue(): Promise<{ jobId: string; deduplicated: boolean }> {
    return { jobId: 'fake', deduplicated: false };
  }

  async claimNext(): Promise<ClaimedJob | null> {
    this.claims += 1;
    return null; // immer leer – Tests prüfen nur den Lebenszyklus
  }

  async markSucceeded(): Promise<void> {}
  async markFailed(): Promise<void> {}

  async reclaimExpired(): Promise<ReclaimResult> {
    this.reclaims += 1;
    return { reclaimed: 0, died: 0 };
  }
}

describe('JobRunner-Lebenszyklus', () => {
  it('führt Crash-Recovery (reclaimExpired) zu Beginn jedes Ticks aus', async () => {
    const queue = new FakeQueue();
    const runner = new JobRunner(queue, 'test-worker');
    runner.start(10);
    await sleep(60);
    await runner.stop();
    expect(queue.reclaims).toBeGreaterThanOrEqual(2);
    expect(queue.claims).toBeGreaterThanOrEqual(2);
  });

  it('doppeltes start() wirft, statt zwei Poll-Schleifen zu erzeugen', async () => {
    const runner = new JobRunner(new FakeQueue(), 'test-worker');
    runner.start(1000);
    expect(() => runner.start(1000)).toThrow('läuft bereits');
    await runner.stop();
  });

  it('start() während eines noch nicht abgeschlossenen stop() wirft', async () => {
    const queue = new FakeQueue();
    // Ein Tick, der lange läuft, damit stop() warten muss.
    let release: (() => void) | undefined;
    queue.claimNext = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return null;
    };

    const runner = new JobRunner(queue, 'test-worker');
    runner.start(1000);
    await sleep(20); // Tick hängt jetzt in claimNext

    const stopPromise = runner.stop();
    expect(() => runner.start(1000)).toThrow('stoppt gerade');

    release?.();
    await stopPromise;
  });

  it('nach vollständigem stop() ist ein Neustart möglich', async () => {
    const queue = new FakeQueue();
    const runner = new JobRunner(queue, 'test-worker');
    runner.start(10);
    await runner.stop();
    const before = queue.reclaims;
    runner.start(10);
    await sleep(30);
    await runner.stop();
    expect(queue.reclaims).toBeGreaterThan(before);
  });

  it('stop() ist mehrfach aufrufbar', async () => {
    const runner = new JobRunner(new FakeQueue(), 'test-worker');
    runner.start(10);
    await Promise.all([runner.stop(), runner.stop()]);
    await runner.stop();
  });
});

describe('summarizeJobError (Phase 12, Härtung RA-10/H3)', () => {
  it('speichert nur Fehlerklasse, Code und erste Zeile – nie Drizzle-Parameter oder NUL-Bytes', () => {
    const cause = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), {
      code: '22021',
      severity: 'ERROR',
    });
    const drizzle = Object.assign(
      new Error(
        'Failed query: insert into "conversation_messages" ("body") values ($1)\nparams: Geheimer Kundentext SECRET-4711 mit NUL\u0000Byte',
      ),
      { name: 'DrizzleQueryError', cause },
    );
    const summary = summarizeJobError(drizzle);
    expect(summary).toBe(
      'DrizzleQueryError [22021]: Failed query: insert into "conversation_messages" ("body") values ($1)',
    );
    expect(summary).not.toContain('SECRET-4711');
    expect(summary).not.toContain('\u0000');
  });

  it('rohe PostgreSQL-Fehler ohne Meldung (zitiert Werte); Steuerzeichen entfernt; Länge begrenzt', () => {
    const raw = Object.assign(
      new Error('invalid input syntax for type uuid: "kunde@example.org"'),
      {
        name: 'error',
        code: '22P02',
        severity: 'ERROR',
      },
    );
    expect(summarizeJobError(raw)).toBe('error [22P02]');
    expect(summarizeJobError(new Error('a\u0000b\tc'))).toBe('Error: a b c');
    const long = summarizeJobError(new Error('x'.repeat(2000)));
    expect(long.length).toBe(JOB_ERROR_SUMMARY_MAX_CHARS);
    expect(summarizeJobError('kaputt')).toBe('string: kaputt');
  });
});
