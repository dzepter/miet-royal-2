import type { ClaimedJob, JobQueue } from './queue.ts';

export type JobHandler = (job: ClaimedJob) => Promise<void>;

/**
 * Phase 14 (demo): Entscheidung VOR der Ausführung eines beanspruchten Jobs.
 * `'run'` führt den Handler aus; `{ defer: { delayMs } }` legt den Job ohne
 * Attempt-Verbrauch um `delayMs` zurück (Queue.defer), z. B. solange ein
 * Demo-Reset läuft. Wirft der Hook, läuft der Job normal (fail-open – der
 * Handler scheitert dann ggf. selbst mit Retry).
 *
 * Phase 14 (reset): `{ skip: { reason } }` beendet den Job OHNE Ausführung
 * dauerhaft als `dead` mit `last_error` = Grund (Queue.markDead; ohne diese
 * Methode Fallback auf markFailed) – für Jobs eines alten Demo-Datensatzes,
 * die nach einem Reset nie auf den neuen Seed wirken dürfen (Order §21).
 */
export type JobBeforeRunDecision =
  'run' | { defer: { delayMs: number; reason?: string } } | { skip: { reason: string } };
export type JobBeforeRunHook = (job: ClaimedJob) => Promise<JobBeforeRunDecision>;

/**
 * Phase 14 Final (Reset-Barrier): Execution-Guard UM die Ausführung eines
 * beanspruchten Jobs – nach dem `beforeRun`-Hook aufgerufen. `acquire(job)`
 * liefert `run` mit einem `release()`, das der Runner im `finally` nach
 * Handler + markSucceeded/markFailed aufruft (auch bei Handler-Exception oder
 * Fehler von markFailed), `defer` (ohne Attempt-Verbrauch, Queue.defer) oder
 * `skip` (Queue.markDead). Wirft `acquire`, wird der Job fail-closed ohne
 * Attempt-Verbrauch um `JOB_EXECUTION_GUARD_ERROR_DEFER_MS` zurückgelegt – ein
 * Handler läuft nie ohne erworbenen Guard (z. B. Shared-Barrier-Lock in der Demo).
 */
export type JobExecutionDecision =
  | { action: 'run'; release(): Promise<void> }
  | { action: 'defer'; delayMs: number; reason?: string }
  | { action: 'skip'; reason: string };
export interface JobExecutionGuard {
  acquire(job: ClaimedJob): Promise<JobExecutionDecision>;
}
/** Phase 14 Final: Vertagung, wenn der Execution-Guard selbst scheitert (Infrastruktur). */
export const JOB_EXECUTION_GUARD_ERROR_DEFER_MS = 15_000;

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

/** Maximale Länge der gespeicherten/geloggten Fehlerzusammenfassung eines Jobs. */
export const JOB_ERROR_SUMMARY_MAX_CHARS = 500;

/* eslint-disable-next-line no-control-regex */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;

function errorCodeOf(error: unknown): string | null {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const code = (candidate as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(code)) return code;
  }
  return null;
}

/**
 * Fehlerzusammenfassung für `integration_jobs.last_error` und das Log
 * (Phase 12, Härtung RA-10/H3): nur Fehlerklasse, Code und ERSTE Zeile der
 * Meldung – Drizzle hängt in Zeile 2 die SQL-Parameter an (Kundendaten,
 * Token, im Fall RA-10 ein NUL-Byte, das schon das Speichern von markFailed
 * scheitern ließ). Rohe PostgreSQL-Fehler (SQLSTATE + severity) ohne Meldung,
 * denn sie zitieren Werte („invalid input syntax …: "<wert>"“). Steuerzeichen
 * werden entfernt, Länge ≤ 500 Zeichen.
 */
export function summarizeJobError(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const code = errorCodeOf(error);
  const message = error instanceof Error ? error.message : String(error);
  const isRawPgError =
    error instanceof Error &&
    typeof (error as { severity?: unknown }).severity === 'string' &&
    code !== null &&
    /^[0-9A-Z]{5}$/.test(code);
  const firstLine = isRawPgError ? '' : (message.split(/\r?\n/)[0] ?? '');
  const summary = `${name}${code === null ? '' : ` [${code}]`}${firstLine === '' ? '' : `: ${firstLine}`}`;
  const cleaned = summary.replace(CONTROL_CHARS, ' ').trim();
  return cleaned.length <= JOB_ERROR_SUMMARY_MAX_CHARS
    ? cleaned
    : `${cleaned.slice(0, JOB_ERROR_SUMMARY_MAX_CHARS - 1)}…`;
}

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
  private beforeRun: JobBeforeRunHook | null = null;
  private executionGuard: JobExecutionGuard | null = null;
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

  /**
   * Phase 14 (demo): Hook vor jeder Jobausführung setzen (oder mit null
   * entfernen). Verlangt eine Queue mit `defer`, damit ein vertagter Job
   * keinen Versuch verbraucht – sonst Programmierfehler beim Verdrahten.
   */
  setBeforeRun(hook: JobBeforeRunHook | null): void {
    if (hook !== null && typeof this.queue.defer !== 'function') {
      throw new Error('JobRunner.setBeforeRun: die Queue unterstützt kein defer()');
    }
    this.beforeRun = hook;
  }

  /**
   * Phase 14 Final (Reset-Barrier): Execution-Guard um jede Jobausführung
   * setzen (oder mit null entfernen). Verlangt wie `setBeforeRun` eine Queue
   * mit `defer`, damit ein vertagter Job keinen Versuch verbraucht.
   */
  setExecutionGuard(guard: JobExecutionGuard | null): void {
    if (guard !== null && typeof this.queue.defer !== 'function') {
      throw new Error('JobRunner.setExecutionGuard: die Queue unterstützt kein defer()');
    }
    this.executionGuard = guard;
  }

  /** Verarbeitet höchstens einen fälligen Job. */
  async runOnce(): Promise<'processed' | 'failed' | 'idle' | 'deferred' | 'skipped'> {
    const job = await this.queue.claimNext(this.workerId);
    if (job === null) return 'idle';

    const handler = this.handlers.get(job.type);
    if (handler === undefined) {
      await this.queue.markFailed(job, `Kein Handler für Jobtyp "${job.type}" registriert`);
      this.logger.warn({ jobId: job.id, jobType: job.type }, 'Job ohne registrierten Handler');
      return 'failed';
    }

    // Phase 14 (demo): Vertagung ohne Attempt-Verbrauch (z. B. Demo-Reset läuft).
    if (this.beforeRun !== null && typeof this.queue.defer === 'function') {
      let decision: JobBeforeRunDecision = 'run';
      try {
        decision = await this.beforeRun(job);
      } catch (error) {
        this.logger.warn(
          { jobId: job.id, jobType: job.type, error: summarizeJobError(error) },
          'beforeRun-Hook fehlgeschlagen – Job läuft normal',
        );
      }
      if (decision !== 'run' && 'skip' in decision) {
        // Phase 14 (reset): ohne Ausführung endgültig beenden – nie auf den neuen Seed wirken.
        const reason = decision.skip.reason;
        if (typeof this.queue.markDead === 'function') await this.queue.markDead(job, reason);
        else await this.queue.markFailed(job, reason);
        this.logger.warn(
          { jobId: job.id, jobType: job.type, reason },
          'Job übersprungen und beendet (Datensatz gewechselt)',
        );
        return 'skipped';
      }
      if (decision !== 'run') {
        const delayMs = Math.max(0, Math.floor(decision.defer.delayMs));
        await this.queue.defer(job, new Date(Date.now() + delayMs));
        this.logger.info(
          { jobId: job.id, jobType: job.type, delayMs, reason: decision.defer.reason ?? null },
          'Job zurückgelegt (ohne Versuchsverbrauch)',
        );
        return 'deferred';
      }
    }

    // Phase 14 Final (Reset-Barrier): Guard UM die gesamte Ausführung (Lock bis ins finally).
    let release: (() => Promise<void>) | null = null;
    if (this.executionGuard !== null && typeof this.queue.defer === 'function') {
      let decision: JobExecutionDecision;
      try {
        decision = await this.executionGuard.acquire(job);
      } catch (error) {
        // Fail-closed: ohne Guard läuft kein Handler; Vertagung ohne Versuchsverbrauch.
        const message = summarizeJobError(error);
        await this.queue.defer(job, new Date(Date.now() + JOB_EXECUTION_GUARD_ERROR_DEFER_MS));
        this.logger.warn(
          {
            jobId: job.id,
            jobType: job.type,
            delayMs: JOB_EXECUTION_GUARD_ERROR_DEFER_MS,
            error: message,
          },
          'Execution-Guard fehlgeschlagen – Job zurückgelegt (ohne Versuchsverbrauch)',
        );
        return 'deferred';
      }
      if (decision.action === 'skip') {
        const reason = decision.reason;
        if (typeof this.queue.markDead === 'function') await this.queue.markDead(job, reason);
        else await this.queue.markFailed(job, reason);
        this.logger.warn(
          { jobId: job.id, jobType: job.type, reason },
          'Job übersprungen und beendet (Execution-Guard)',
        );
        return 'skipped';
      }
      if (decision.action === 'defer') {
        const delayMs = Math.max(0, Math.floor(decision.delayMs));
        await this.queue.defer(job, new Date(Date.now() + delayMs));
        this.logger.info(
          { jobId: job.id, jobType: job.type, delayMs, reason: decision.reason ?? null },
          'Job zurückgelegt (ohne Versuchsverbrauch)',
        );
        return 'deferred';
      }
      release = decision.release;
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
      // Härtung RA-10/H3: nie Rohmeldung (SQL-Parameter, NUL-Bytes) speichern/loggen.
      const message = summarizeJobError(error);
      await this.queue.markFailed(job, message);
      this.logger.error(
        { jobId: job.id, jobType: job.type, attempt: job.attempts, error: message },
        'Job fehlgeschlagen',
      );
      return 'failed';
    } finally {
      if (release !== null) {
        // Phase 14 Final: Guard IMMER freigeben – auch nach Handler-Exception oder markFailed-Fehler.
        try {
          await release();
        } catch (error) {
          this.logger.warn(
            { jobId: job.id, jobType: job.type, error: summarizeJobError(error) },
            'Execution-Guard konnte nicht freigegeben werden',
          );
        }
      }
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
            { error: summarizeJobError(error) },
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
