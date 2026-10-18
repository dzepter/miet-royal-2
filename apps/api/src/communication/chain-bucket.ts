/**
 * Phase 12 Härtung (Review B, B6): Folge-Bucket selbst-re-enqueuender
 * Kettenjobs (`communication.scan_due`, `mail.inbound_poll`).
 *
 * Der Claim eines Jobs folgt der DB-Uhr (`run_at <= now()`), der Handler
 * liest aber die Worker-Uhr. Geht die Worker-Uhr nur wenige Millisekunden
 * nach, läge „nächster Bucket nach now“ noch auf dem EIGENEN Bucket – der
 * Folgejob würde über den (für immer UNIQUE) Idempotenzschlüssel
 * dedupliziert und die Kette risse ab. Deshalb: Folge-Bucket =
 * max(Payload-Bucket + Intervall, nächster Bucket nach now). Ohne gültigen
 * Payload-Bucket (Altjobs/Tests) gilt der Bucket nach now.
 */

/** Bucket-Beginn aus dem Job-Payload (`{ bucket: ISO }`) oder null. */
export function payloadBucket(payload: unknown): Date | null {
  if (payload === null || typeof payload !== 'object') return null;
  const raw = (payload as { bucket?: unknown }).bucket;
  if (typeof raw !== 'string') return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Beginn des 2-min-(Intervall-)Buckets, in dem `now` liegt. */
export function bucketStartOf(now: Date, intervalMs: number): Date {
  return new Date(Math.floor(now.getTime() / intervalMs) * intervalMs);
}

/** Folge-Bucket: nie der eigene oder ein früherer Bucket (robust gegen Uhrversatz). */
export function followUpBucket(current: Date | null, now: Date, intervalMs: number): Date {
  const afterNow = bucketStartOf(now, intervalMs).getTime() + intervalMs;
  const afterCurrent =
    current === null ? afterNow : bucketStartOf(current, intervalMs).getTime() + intervalMs;
  return new Date(Math.max(afterNow, afterCurrent));
}

/** Takt des Ketten-Watchdogs im Worker (B6). */
export const CHAIN_WATCHDOG_INTERVAL_MS = 60_000;

export interface ChainWatchdogLogger {
  error(object: Record<string, unknown>, message: string): void;
}

/**
 * Ketten-Watchdog (B6): ruft periodisch die Boot-Enqueues (`enqueueScanDue`,
 * `enqueueInboundPoll`) für den AKTUELLEN Bucket auf. Läuft die Kette, ist
 * das ein deduplizierter No-op (ein INSERT … ON CONFLICT DO NOTHING); ist
 * sie abgerissen, startet sie spätestens nach einem Intervall neu. Da jeder
 * Bucket genau einen Schlüssel hat und jeder Lauf den Folge-Bucket nach now
 * einreiht, laufen parallele Ketten spätestens im nächsten Bucket zusammen.
 */
export function startChainWatchdog(
  tasks: readonly (() => Promise<unknown>)[],
  options: { intervalMs?: number; logger?: ChainWatchdogLogger } = {},
): { stop(): void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      for (const task of tasks) {
        try {
          await task();
        } catch (error) {
          options.logger?.error(
            { errorCode: error instanceof Error ? error.name || 'Error' : 'Error' },
            'Ketten-Watchdog: Einreihen fehlgeschlagen',
          );
        }
      }
    })().finally(() => {
      running = false;
    });
  }, options.intervalMs ?? CHAIN_WATCHDOG_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
