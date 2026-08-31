/**
 * Abstraktion für Hintergrundjobs (CLAUDE.md "Integrationen / Jobs":
 * robust, idempotent, retry-fähig). Phase 0 liefert nur die Infrastruktur;
 * fachliche Jobtypen (MAIL_SEND, LEXWARE_TRANSFER, …) folgen in den
 * jeweiligen Phasen.
 */

export interface EnqueueOptions {
  /**
   * Pflicht: fachlich eindeutiger Schlüssel. Wird derselbe Schlüssel erneut
   * enqueued, entsteht KEIN zweiter Job (Schutz vor Doppelaktionen).
   */
  idempotencyKey: string;
  /** Frühester Ausführungszeitpunkt; Default: sofort. */
  runAt?: Date;
  /** Maximale Versuche, danach Status "dead". Default: 5. */
  maxAttempts?: number;
}

export interface EnqueueResult {
  jobId: string;
  /** true, wenn der Job wegen des Idempotency-Keys bereits existierte. */
  deduplicated: boolean;
}

export interface ClaimedJob {
  id: string;
  type: string;
  payload: unknown;
  idempotencyKey: string;
  /** Laufender Versuch (1-basiert, inklusive des aktuellen). */
  attempts: number;
  maxAttempts: number;
}

export interface JobQueue {
  enqueue(type: string, payload: unknown, options: EnqueueOptions): Promise<EnqueueResult>;
  /**
   * Beansprucht den nächsten fälligen Job exklusiv (FOR UPDATE SKIP LOCKED).
   * Gibt null zurück, wenn kein Job fällig ist.
   */
  claimNext(workerId: string): Promise<ClaimedJob | null>;
  markSucceeded(job: ClaimedJob): Promise<void>;
  /**
   * Versuch fehlgeschlagen: plant Retry mit Backoff oder setzt den Job auf
   * "dead", wenn die maximalen Versuche erreicht sind.
   */
  markFailed(job: ClaimedJob, errorMessage: string): Promise<void>;
}
