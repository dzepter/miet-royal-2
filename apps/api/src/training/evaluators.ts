import type { TrainingEventKey } from './event-keys.ts';

/**
 * Phase 14 (Training, Order §34, §§45/74–79, Design §4.2): fester
 * serverseitiger Evaluator-Katalog. Ein Evaluator ist eine geordnete Liste
 * von Pflichtschritten; jeder Schritt wird durch eines seiner fachlichen
 * Ereignisse erfüllt. `sameSubject` verlangt, dass alle Schritte dasselbe
 * Fachobjekt betreffen (z. B. dieselbe Tour, dasselbe Angebot) – der
 * `subjectRef` wird serverseitig ermittelt, nie vom Client geliefert (§72).
 *
 * Alle Funktionen sind rein (keine DB, kein Scripting): die Regeln leben im
 * Code, die Datenbank hält nur Ereignisse und Ergebnisse (§38).
 */

export const EVALUATOR_KEYS = [
  'offer_send',
  'handover_complete',
  'return_complete',
  'tour_complete',
  'communication_reply',
  'settlement_review',
  'machine_clean_complete',
  'inventory_stocktake_approve',
] as const;

export type EvaluatorKey = (typeof EVALUATOR_KEYS)[number];

export interface EvaluatorStep {
  key: string;
  title: string;
  eventKeys: readonly TrainingEventKey[];
  required: true;
}

export interface EvaluatorSpec {
  key: EvaluatorKey;
  steps: readonly EvaluatorStep[];
  /** Alle Schritte müssen dasselbe Fachobjekt (subjectRef) betreffen. */
  sameSubject: boolean;
}

/** Bereits akzeptiertes Ereignis eines Versuchs (nur Metadaten). */
export interface AcceptedEvent {
  stepKey: string;
  subjectRef: string | null;
}

export interface IncomingEvent {
  eventKey: TrainingEventKey;
  subjectRef: string | null;
}

export type MatchResultKind = 'accepted' | 'duplicate' | 'rejected';

export interface MatchResult {
  /** Schritt, dem das Ereignis zugeordnet wurde (null: Evaluator kennt das Ereignis nicht). */
  stepKey: string | null;
  result: MatchResultKind;
  /** Neutraler Code bei `rejected` (nie Businessdaten). */
  errorCode: string | null;
}

export const EVALUATOR_ERROR_CODES = {
  /** Vorhergehender Pflichtschritt (für dasselbe Fachobjekt) noch nicht erfüllt. */
  PREREQUISITE_MISSING: 'PREREQUISITE_MISSING',
  /** Evaluator verlangt ein Fachobjekt, das Ereignis trägt keines. */
  SUBJECT_MISSING: 'SUBJECT_MISSING',
  /** Ereignis gehört zu keinem Schritt dieses Evaluators. */
  EVENT_NOT_APPLICABLE: 'EVENT_NOT_APPLICABLE',
} as const;

function step(key: string, title: string, eventKeys: readonly TrainingEventKey[]): EvaluatorStep {
  return { key, title, eventKeys, required: true };
}

export const TRAINING_EVALUATORS: Record<EvaluatorKey, EvaluatorSpec> = {
  offer_send: {
    key: 'offer_send',
    sameSubject: true,
    steps: [
      step('edit', 'Angebotsentwurf anlegen oder bearbeiten', [
        'offer.draft_created',
        'offer.draft_updated',
      ]),
      step('send', 'Angebot versenden', ['offer.sent']),
    ],
  },
  handover_complete: {
    key: 'handover_complete',
    sameSubject: false,
    steps: [step('finalize', 'Übergabe abschließen', ['handover.finalized'])],
  },
  return_complete: {
    key: 'return_complete',
    sameSubject: false,
    steps: [step('finalize', 'Rückgabe abschließen', ['return.finalized'])],
  },
  tour_complete: {
    key: 'tour_complete',
    sameSubject: true,
    steps: [
      step('plan', 'Tour planen oder als bereit markieren', ['tour.planned', 'tour.ready']),
      step('start', 'Tour starten', ['tour.started']),
      step('end', 'Tour beenden', ['tour.completed']),
    ],
  },
  communication_reply: {
    key: 'communication_reply',
    sameSubject: false,
    steps: [
      step('reply', 'Kundennachricht beantworten (Versand bestätigt)', [
        'communication.reply_sent',
      ]),
    ],
  },
  settlement_review: {
    key: 'settlement_review',
    sameSubject: false,
    steps: [
      step('review', 'Abrechnung prüfen bis „Bereit zur Buchhaltung“', ['settlement.reviewed']),
    ],
  },
  machine_clean_complete: {
    key: 'machine_clean_complete',
    sameSubject: false,
    steps: [step('clean', 'Reinigung abschließen', ['machine.cleaning_completed'])],
  },
  inventory_stocktake_approve: {
    key: 'inventory_stocktake_approve',
    sameSubject: true,
    steps: [
      step('count', 'Lagerzählung mit Differenz erfassen', ['inventory.stocktake_created']),
      step('approve', 'Lagerzählung freigeben', ['inventory.stocktake_approved']),
    ],
  },
};

const EVALUATOR_KEY_SET: ReadonlySet<string> = new Set(EVALUATOR_KEYS);

export function isEvaluatorKey(value: string): value is EvaluatorKey {
  return EVALUATOR_KEY_SET.has(value);
}

export function evaluatorFor(evaluatorKey: string): EvaluatorSpec | null {
  return isEvaluatorKey(evaluatorKey) ? TRAINING_EVALUATORS[evaluatorKey] : null;
}

/** Kennt der Evaluator dieses Ereignis (irgendein Schritt)? */
export function evaluatorAcceptsEvent(spec: EvaluatorSpec, eventKey: TrainingEventKey): boolean {
  return spec.steps.some((candidate) => candidate.eventKeys.includes(eventKey));
}

function stepIndexFor(spec: EvaluatorSpec, eventKey: TrainingEventKey): number {
  return spec.steps.findIndex((candidate) => candidate.eventKeys.includes(eventKey));
}

/** Akzeptierte Schritte je Fachobjekt (bei `sameSubject`) bzw. insgesamt. */
function doneStepsFor(
  spec: EvaluatorSpec,
  accepted: readonly AcceptedEvent[],
  subjectRef: string | null,
): ReadonlySet<string> {
  const done = new Set<string>();
  for (const event of accepted) {
    if (spec.sameSubject && event.subjectRef !== subjectRef) continue;
    done.add(event.stepKey);
  }
  return done;
}

/** Fachobjekte, zu denen Ereignisse akzeptiert wurden (null = ohne Objekt). */
function subjectsOf(accepted: readonly AcceptedEvent[]): (string | null)[] {
  const seen = new Set<string | null>();
  const result: (string | null)[] = [];
  for (const event of accepted) {
    if (seen.has(event.subjectRef)) continue;
    seen.add(event.subjectRef);
    result.push(event.subjectRef);
  }
  return result;
}

/** Anzahl der von vorne durchgehend erfüllten Pflichtschritte. */
function progressLength(spec: EvaluatorSpec, done: ReadonlySet<string>): number {
  let length = 0;
  for (const candidate of spec.steps) {
    if (!done.has(candidate.key)) break;
    length += 1;
  }
  return length;
}

/**
 * Fachobjekt mit dem größten Fortschritt (für Anzeige/offenen Schritt). Ohne
 * `sameSubject` gibt es nur „ein“ Subjekt (alle Ereignisse zählen gemeinsam).
 */
function bestSubject(spec: EvaluatorSpec, accepted: readonly AcceptedEvent[]): string | null {
  if (!spec.sameSubject) return null;
  let best: string | null = null;
  let bestLength = -1;
  for (const subject of subjectsOf(accepted)) {
    const length = progressLength(spec, doneStepsFor(spec, accepted, subject));
    if (length > bestLength) {
      best = subject;
      bestLength = length;
    }
  }
  return best;
}

/**
 * Ordnet ein fachliches Ereignis dem Versuch zu. Schritt k wird akzeptiert,
 * wenn alle vorherigen Pflichtschritte (bei `sameSubject` für dasselbe
 * Fachobjekt) bereits akzeptiert sind; bereits erfüllter Schritt ⇒
 * `duplicate` (kein Doppelabschluss, §45); fehlende Vorbedingung ⇒
 * `rejected`/PREREQUISITE_MISSING.
 */
export function matchEvent(
  spec: EvaluatorSpec,
  accepted: readonly AcceptedEvent[],
  event: IncomingEvent,
): MatchResult {
  const index = stepIndexFor(spec, event.eventKey);
  if (index < 0) {
    return {
      stepKey: null,
      result: 'rejected',
      errorCode: EVALUATOR_ERROR_CODES.EVENT_NOT_APPLICABLE,
    };
  }
  const current = spec.steps[index]!;
  if (spec.sameSubject && event.subjectRef === null) {
    return {
      stepKey: current.key,
      result: 'rejected',
      errorCode: EVALUATOR_ERROR_CODES.SUBJECT_MISSING,
    };
  }
  const subject = spec.sameSubject ? event.subjectRef : null;
  const done = doneStepsFor(spec, accepted, subject);
  for (const previous of spec.steps.slice(0, index)) {
    if (previous.required && !done.has(previous.key)) {
      return {
        stepKey: current.key,
        result: 'rejected',
        errorCode: EVALUATOR_ERROR_CODES.PREREQUISITE_MISSING,
      };
    }
  }
  if (done.has(current.key)) {
    return { stepKey: current.key, result: 'duplicate', errorCode: null };
  }
  return { stepKey: current.key, result: 'accepted', errorCode: null };
}

/** Alle Pflichtschritte erfüllt (bei `sameSubject` für ein und dasselbe Fachobjekt)? */
export function isComplete(spec: EvaluatorSpec, accepted: readonly AcceptedEvent[]): boolean {
  const subjects = spec.sameSubject ? subjectsOf(accepted) : [null];
  return subjects.some((subject) => {
    const done = doneStepsFor(spec, accepted, subject);
    return spec.steps.every((candidate) => !candidate.required || done.has(candidate.key));
  });
}

/** Erster offener Pflichtschritt (für das Fachobjekt mit dem größten Fortschritt); null = vollständig. */
export function openStep(
  spec: EvaluatorSpec,
  accepted: readonly AcceptedEvent[],
): EvaluatorStep | null {
  if (isComplete(spec, accepted)) return null;
  const done = doneStepsFor(spec, accepted, bestSubject(spec, accepted));
  return spec.steps.find((candidate) => candidate.required && !done.has(candidate.key)) ?? null;
}

/** Schrittliste mit Erledigt-Kennzeichen (für Versuchs-Ansichten). */
export function stepsView(
  spec: EvaluatorSpec,
  accepted: readonly AcceptedEvent[],
): { key: string; title: string; done: boolean }[] {
  const done = doneStepsFor(spec, accepted, bestSubject(spec, accepted));
  return spec.steps.map((candidate) => ({
    key: candidate.key,
    title: candidate.title,
    done: done.has(candidate.key),
  }));
}
