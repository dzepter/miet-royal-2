import type { Database } from '@mietroyal/database';
import {
  InMemoryIntegrationRateLimiter,
  PostgresIntegrationRateLimiter,
  type IntegrationRateLimiter,
} from '../integrations/rate-limiter.ts';

/**
 * Phase 16 (REVIEWS, Design §4/§11.2.6): GLOBALE Tagesgrenze für Places-Abrufe über den
 * bestehenden `IntegrationRateLimiter` (Zeile `google_places_reviews` in
 * `integration_rate_limits`, geteilt von allen API-Replikaten einer Umgebung; keine neue
 * Tabelle, keine Migration).
 *
 * Der Limiter kennt nur „nächster Slot“ (`next_slot_at`) und eine Pause. Darauf sitzt hier
 * ein Token-Bucket nach GCRA (`next_slot_at` = theoretische Ankunftszeit):
 * - Abstand `intervalMs = ceil(24 h / (limit + 1 − burst))`, Burst `burst = max(1, ⌊limit/4⌋)`,
 *   Toleranz `toleranceMs = (burst − 1) × intervalMs`.
 * - Ein Abruf ist erlaubt, wenn der reservierte Slot höchstens `toleranceMs` in der Zukunft
 *   liegt. Damit gilt für JEDES gleitende 24-Stunden-Fenster: höchstens `limit` Abrufe
 *   (n-ter Abruf nach dem ersten frühestens nach (n − 1) × intervalMs − toleranceMs);
 *   kurzzeitige Häufungen bis `burst` sind sofort möglich (Klick-zum-Laden-Besuche kommen
 *   gebündelt), danach füllt sich das Kontingent gleichmäßig auf.
 * - Der Limiter reserviert bei JEDEM Aufruf (auch wenn wir ablehnen) ⇒ eine Ablehnung würde
 *   den Zeiger um ein Intervall verschieben (nur strenger, nie lockerer, aber Durchsatz
 *   kostend). Deshalb setzt jeder Aufruf, nach dem das Kontingent leer ist (der letzte
 *   freigegebene ebenso wie eine Ablehnung), eine globale Pause (`credit_limited`) bis zu dem
 *   Zeitpunkt, ab dem der nächste Abruf wieder in die Toleranz fällt (+ 1 s Sicherheitsabstand
 *   gegen Uhrabweichung). Während der Pause reserviert der Limiter nichts (fail-fast) – so
 *   entstehen Ablehnungen mit Zeigerverschiebung nur bei gleichzeitigen Abrufen (begrenzt,
 *   selbstheilend).
 * - 429 von Google ⇒ globale Pause `rate_limited` (`GOOGLE_REVIEWS_RATE_LIMIT_PAUSE_MS`).
 *
 * Zeitautorität für Slots ist die Datenbank; das Pausen-Ende wird mit der Prozessuhr
 * berechnet (Abweichungen verlängern/verkürzen nur die Pause, nie die Grenze).
 * Gespeichert werden nur Provider, Umgebung und Zeitpunkte – nie Key, URL oder Inhalte.
 */

export const GOOGLE_REVIEWS_RATE_LIMIT_PROVIDER = 'google_places_reviews';
/** Pause nach einem 429 von Google (keine Wiederholung im Request-Pfad). */
export const GOOGLE_REVIEWS_RATE_LIMIT_PAUSE_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Sicherheitsabstand am Pausenende (Prozess- vs. Datenbankuhr). */
export const REVIEW_BUDGET_PAUSE_MARGIN_MS = 1000;

export interface ReviewBudgetPolicy {
  dailyRequestLimit: number;
  burst: number;
  intervalMs: number;
  toleranceMs: number;
}

export function reviewBudgetPolicy(dailyRequestLimit: number): ReviewBudgetPolicy {
  if (!Number.isInteger(dailyRequestLimit) || dailyRequestLimit < 1) {
    throw new Error('Bewertungen: dailyRequestLimit muss eine positive ganze Zahl sein');
  }
  const burst = Math.max(1, Math.floor(dailyRequestLimit / 4));
  const intervalMs = Math.ceil(DAY_MS / (dailyRequestLimit + 1 - burst));
  return { dailyRequestLimit, burst, intervalMs, toleranceMs: (burst - 1) * intervalMs };
}

export type ReviewBudgetDecision =
  { granted: true } | { granted: false; reason: 'budget_exhausted' | 'rate_limited' };

export class ReviewRequestBudget {
  readonly policy: ReviewBudgetPolicy;

  private constructor(
    private readonly limiter: IntegrationRateLimiter,
    policy: ReviewBudgetPolicy,
    private readonly now: () => number,
  ) {
    this.policy = policy;
  }

  /** Betrieb: globale Grenze in `integration_rate_limits` (alle Replikate einer Umgebung). */
  static forDatabase(
    db: Database,
    environment: string,
    dailyRequestLimit: number,
  ): ReviewRequestBudget {
    const policy = reviewBudgetPolicy(dailyRequestLimit);
    const limiter = new PostgresIntegrationRateLimiter(db, {
      provider: GOOGLE_REVIEWS_RATE_LIMIT_PROVIDER,
      environment,
      intervalMs: policy.intervalMs,
    });
    return new ReviewRequestBudget(limiter, policy, () => Date.now());
  }

  /** Nur Unit-Tests: dieselbe Logik ohne Datenbank (Uhr injizierbar). */
  static inMemory(dailyRequestLimit: number, now: () => number = () => Date.now()) {
    const policy = reviewBudgetPolicy(dailyRequestLimit);
    const limiter = new InMemoryIntegrationRateLimiter({
      provider: GOOGLE_REVIEWS_RATE_LIMIT_PROVIDER,
      intervalMs: policy.intervalMs,
      now,
    });
    return new ReviewRequestBudget(limiter, policy, now);
  }

  /** Einen Abruf freigeben oder ablehnen – wartet nie (Browser-Request-Pfad). */
  async tryConsume(): Promise<ReviewBudgetDecision> {
    const slot = await this.limiter.reserveSlot();
    if (slot.paused !== null) {
      return {
        granted: false,
        reason: slot.paused.kind === 'rate_limited' ? 'rate_limited' : 'budget_exhausted',
      };
    }
    const { intervalMs, toleranceMs } = this.policy;
    const granted = slot.waitMs <= toleranceMs;
    // Neuer Zeiger = jetzt + waitMs + intervalMs; der nächste Abruf ist frei, sobald der
    // Zeiger höchstens toleranceMs in der Zukunft liegt. Liegt dieser Zeitpunkt in der
    // Zukunft, ist das Kontingent leer ⇒ globale Pause bis dahin (verhindert weitere
    // Reservierungen und damit Zeigerverschiebungen durch Ablehnungen).
    const nextFreeInMs = slot.waitMs + intervalMs - toleranceMs;
    if (nextFreeInMs > 0) {
      await this.limiter.pause(
        new Date(this.now() + nextFreeInMs + REVIEW_BUDGET_PAUSE_MARGIN_MS),
        'credit_limited',
      );
    }
    return granted ? { granted: true } : { granted: false, reason: 'budget_exhausted' };
  }

  /** 429 von Google: globale Pause für alle Replikate (nie verkürzt). */
  async pauseAfterProviderRateLimit(
    durationMs: number = GOOGLE_REVIEWS_RATE_LIMIT_PAUSE_MS,
  ): Promise<void> {
    await this.limiter.pause(new Date(this.now() + durationMs), 'rate_limited');
  }
}
