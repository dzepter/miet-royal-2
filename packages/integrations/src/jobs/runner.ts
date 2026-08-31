import type { ClaimedJob, JobQueue } from './queue.ts';

export type JobHandler = (job: ClaimedJob) => Promise<void>;

/** Minimales Logger-Interface, damit dieses Paket keinen Logger erzwingt. */
export interface JobRunnerLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

const noopLogger: JobRunnerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Verarbeitet Jobs aus einer JobQueue: pro Tick werden zuerst verwaiste
 * Jobs (abgelaufene Leases nach Worker-Absturz) wieder freigegeben, danach
 * fällige Jobs nacheinander beansprucht und ausgeführt, bis die Queue leer
 * ist. Fehler eines Jobs beenden den Runner nie – sie führen zu Retry oder
 * "dead".
 *
 * Lebenszyklus: start() → stop(). Ein Runner kann nach vollständig
 * abgeschlossenem stop() erneut gestartet werden; start() während eines noch
 * laufenden Betriebs oder eines noch nicht abgeschlossenen stop() ist ein
 * Programmierfehler und wirft, damit nie zwei Poll-Schleifen parallel laufen.
 */
export class JobRunner {
  private readonly queue: JobQueue;
  private readonly workerId: string;
  private readonly logger: JobRunnerLogger;
  private readonly handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private stopInFlight: Promise<void> | undefined;
  private activeTick: Promise<void> = Promise.resolve();

  constructor(queue: JobQueue, workerId: string, logger: JobRunnerLogger = noopLogger) {
    this.queue = queue;
    this.workerId = workerId;
    this.logger = logger;
  }

  register(type: string, handler: JobHandler): void {
    if (this.handlers.has(type)) {
      throw new Error(`Für Jobtyp "${type}" ist bereits ein Handler registriert`);
    }
    this.handlers.set(type, handler);
  }

  /** Verarbeitet höchstens einen fälligen Job. */
  async runOnce(): Promise<'processed' | 'failed' | 'idle'> {
    const job = await this.queue.claimNext(this.workerId);
    if (job === null) return 'idle';

    const handler = this.handlers.get(job.type);
    if (handler === undefined) {
      await this.queue.markFailed(job, `Kein Handler für Jobtyp "${job.type}" registriert`);
      this.logger.warn({ jobId: job.id, jobType: job.type }, 'Job ohne registrierten Handler');
      return 'failed';
    }

    try {
      await handler(job);
      await this.queue.markSucceeded(job);
      this.logger.info(
        { jobId: job.id, jobType: job.type, attempt: job.attempts },
        'Job erfolgreich verarbeitet',
      );
      return 'processed';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.queue.markFailed(job, message);
      this.logger.error(
        { jobId: job.id, jobType: job.type, attempt: job.attempts, error: message },
        'Job fehlgeschlagen',
      );
      return 'failed';
    }
  }

  /** Verarbeitet fällige Jobs, bis die Queue leer ist. */
  async drain(): Promise<void> {
    while (true) {
      const outcome = await this.runOnce();
      if (outcome === 'idle' || this.stopped) return;
    }
  }

  /** Ein vollständiger Poll-Tick: Crash-Recovery, dann Verarbeitung. */
  private async runTick(): Promise<void> {
    const { reclaimed, died } = await this.queue.reclaimExpired();
    if (reclaimed > 0 || died > 0) {
      this.logger.warn(
        { reclaimed, died },
        'Verwaiste Jobs mit abgelaufener Lease freigegeben (Worker-Absturz?)',
      );
    }
    await this.drain();
  }

  start(pollIntervalMs: number): void {
    if (!this.stopped) {
      throw new Error('JobRunner läuft bereits');
    }
    if (this.stopInFlight !== undefined) {
      throw new Error('JobRunner stoppt gerade – stop() erst abwarten');
    }
    this.stopped = false;

    const tick = (): void => {
      if (this.stopped) return;
      this.activeTick = this.runTick()
        .catch((error: unknown) => {
          // Nur Infrastrukturfehler (z. B. DB weg) landen hier; Jobfehler
          // behandelt runOnce selbst. Runner läuft weiter und versucht es
          // beim nächsten Tick erneut.
          this.logger.error(
            { error: error instanceof Error ? error.message : String(error) },
            'Queue-Verarbeitung fehlgeschlagen',
          );
        })
        .finally(() => {
          if (!this.stopped) {
            this.timer = setTimeout(tick, pollIntervalMs);
          }
        });
    };
    tick();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      // Bereits gestoppt bzw. Stop eines anderen Aufrufers noch im Gange.
      await (this.stopInFlight ?? Promise.resolve());
      return;
    }
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.stopInFlight = this.activeTick.finally(() => {
      this.stopInFlight = undefined;
    });
    await this.stopInFlight;
  }
}
