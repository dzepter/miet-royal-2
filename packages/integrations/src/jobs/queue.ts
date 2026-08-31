/**
 * Abstraktion für Hintergrundjobs (CLAUDE.md "Integrationen / Jobs":
 * robust, idempotent, retry-fähig). Phase 0 liefert nur die Infrastruktur;
 * fachliche Jobtypen (MAIL_SEND, LEXWARE_TRANSFER, …) folgen in den
 * jeweiligen Phasen.
 *
 * Verarbeitungsgarantie: AT-LEAST-ONCE. Ein Job kann in seltenen Fällen
 * mehrfach ausgeführt werden (z. B. Worker-Absturz nach Ausführung, aber vor
 * markSucceeded, oder Lease-Ablauf bei einem nur langsamen Worker). Handler
 * müssen deshalb idempotent geschrieben werden – das ist ohnehin die
 * verbindliche Regel für alle Integrationsjobs (CLAUDE.md).
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
  /**
   * Worker-ID, die diesen Claim hält. markSucceeded/markFailed wirken nur,
   * solange der Job noch von genau dieser Worker-ID gelockt ist – ein
   * "Zombie"-Worker, dessen Lease abgelaufen und dessen Job neu vergeben
   * wurde, kann den neuen Claim nicht mehr beeinflussen.
   */
  claimedBy: string;
}

export interface ReclaimResult {
  /** Jobs, die nach Lease-Ablauf wieder auf pending gesetzt wurden. */
  reclaimed: number;
  /** Jobs, die nach Lease-Ablauf mit erschöpften Versuchen auf dead gingen. */
  died: number;
}

export interface JobQueue {
  enqueue(type: string, payload: unknown, options: EnqueueOptions): Promise<EnqueueResult>;
  /**
   * Beansprucht den nächsten fälligen Job exklusiv (FOR UPDATE SKIP LOCKED)
   * und startet dessen Lease. Gibt null zurück, wenn kein Job fällig ist.
   */
  claimNext(workerId: string): Promise<ClaimedJob | null>;
  markSucceeded(job: ClaimedJob): Promise<void>;
  /**
   * Versuch fehlgeschlagen: plant Retry mit Backoff oder setzt den Job auf
   * "dead", wenn die maximalen Versuche erreicht sind.
   */
  markFailed(job: ClaimedJob, errorMessage: string): Promise<void>;
  /**
   * Crash-Recovery: gibt Jobs frei, deren Lease abgelaufen ist (Worker
   * abgestürzt oder hängen geblieben). Jobs mit Restversuchen gehen zurück
   * auf pending und werden sofort wieder fällig; Jobs mit erschöpften
   * Versuchen gehen auf dead. Mehrfach/parallel aufrufbar.
   */
  reclaimExpired(): Promise<ReclaimResult>;
}
