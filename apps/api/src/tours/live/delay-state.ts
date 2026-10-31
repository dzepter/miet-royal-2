import type { GeoPoint } from '../../routing/types.ts';

/**
 * Phase 13 (Design §9): In-Process-Gedächtnis der Verspätungsbewertung –
 * bewusst OHNE Schema (keine Historie, keine Positionsspur). Je Tour wird
 * nur die letzte Bewertung gehalten: Zeitpunkt, Ergebnis, Bewertungsposition
 * (für die Drossel „≥ 3 min ODER ≥ 500 m“) und die Prognose je Stopp.
 *
 * API und Worker halten je ein eigenes Gedächtnis; die fachliche Wahrheit
 * (offene Incidents) steht in `tour_delay_incidents`. Die Position wird nie
 * geloggt und nie ausgespielt.
 */

export type DelayEvaluationStatus = 'ok' | 'risk' | 'unavailable';

const DELAY_STATE_PRUNE_THRESHOLD = 500;
const DELAY_STATE_MAX_AGE_MS = 24 * 3_600_000;

export interface DelayStopResult {
  stopId: string;
  predictedArrivalAt: Date | null;
  deadlineAt: Date | null;
  late: boolean;
}

export interface DelayEvaluationRecord {
  evaluatedAt: Date;
  status: DelayEvaluationStatus;
  /** Neutraler Grund bei `unavailable` (z. B. NO_LIVE_LOCATION, ROUTING_UNAVAILABLE). */
  reason: string | null;
  /** Live-Standort, auf dem die Bewertung beruhte (Drossel) – nie nach außen. */
  position: GeoPoint | null;
  stops: DelayStopResult[];
}

/** Nur-Lese-Sicht für die Tour-View (Design §8: `delay.status = 'unknown'` ohne Live-Prognose). */
export interface TourDelaySource {
  get(tourId: string): DelayEvaluationRecord | undefined;
}

export class DelayEvaluationState implements TourDelaySource {
  private readonly records = new Map<string, DelayEvaluationRecord>();
  private readonly pending = new Set<Promise<unknown>>();

  /** Asynchrone Bewertung (nach einer HTTP-Antwort) registrieren – `settle()` wartet darauf (Tests, Shutdown). */
  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    const release = () => {
      this.pending.delete(promise);
    };
    promise.then(release, release);
    return promise;
  }

  /** Auf alle laufenden asynchronen Bewertungen warten. */
  async settle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  get(tourId: string): DelayEvaluationRecord | undefined {
    return this.records.get(tourId);
  }

  set(tourId: string, record: DelayEvaluationRecord): void {
    this.records.set(tourId, record);
    // Beendete Touren haben keinen Haken ins Gedächtnis: alte Einträge gelegentlich verwerfen.
    if (this.records.size > DELAY_STATE_PRUNE_THRESHOLD) {
      const cutoff = record.evaluatedAt.getTime() - DELAY_STATE_MAX_AGE_MS;
      for (const [id, entry] of this.records) {
        if (entry.evaluatedAt.getTime() < cutoff) this.records.delete(id);
      }
    }
  }

  clear(tourId: string): void {
    this.records.delete(tourId);
  }

  /** Tests/Neustart-Simulation. */
  reset(): void {
    this.records.clear();
  }
}
