import { describe, expect, it } from 'vitest';
import {
  TRAINING_CATALOG,
  TRAINING_DEFINITIONS,
  TRAINING_PATHS,
  hasRequiredPermissions,
} from '../src/training/catalog.ts';
import { validateTrainingCatalog } from '../src/training/catalog-sync.ts';
import {
  EVALUATOR_ERROR_CODES,
  EVALUATOR_KEYS,
  TRAINING_EVALUATORS,
  evaluatorAcceptsEvent,
  isComplete,
  matchEvent,
  openStep,
  stepsView,
  type AcceptedEvent,
} from '../src/training/evaluators.ts';
import { TRAINING_EVENT_KEYS, isTrainingEventKey } from '../src/training/event-keys.ts';

/**
 * Phase 14 (Training, Design §4.7 Unit): reine Evaluator-Funktionen –
 * Reihenfolge, Vorbedingungen, Duplikate, `sameSubject`, offener Schritt –
 * sowie die statische Konsistenz des Code-Katalogs.
 */

const TOUR_A = '11111111-1111-4111-8111-111111111111';
const TOUR_B = '22222222-2222-4222-8222-222222222222';

describe('Trainingskatalog (Code, Order §50/§51)', () => {
  it('enthält die 8 Übungen und 5 Pfade mit stabilen Keys und ist valide', () => {
    expect(TRAINING_DEFINITIONS.map((d) => d.key)).toEqual([
      'offer_send',
      'handover_complete',
      'return_complete',
      'tour_complete',
      'communication_reply',
      'settlement_review',
      'machine_clean_complete',
      'inventory_stocktake_approve',
    ]);
    expect(TRAINING_PATHS.map((p) => p.key)).toEqual([
      'rental_basics',
      'delivery_tour',
      'communication',
      'settlement',
      'machines_warehouse',
    ]);
    expect(() => validateTrainingCatalog(TRAINING_CATALOG)).not.toThrow();
    for (const definition of TRAINING_DEFINITIONS) {
      expect(EVALUATOR_KEYS).toContain(definition.evaluatorKey);
      expect(definition.demoPath.startsWith('/')).toBe(true);
      expect(definition.seedKey).toMatch(/^[a-z0-9]+(\.[a-z0-9_-]+)+$/);
    }
    const settlement = TRAINING_DEFINITIONS.find((d) => d.key === 'settlement_review')!;
    expect(settlement.instructions).toContain('in der Demo gibt es keine Buchhaltungsübertragung');
  });

  it('lehnt doppelte Keys, unbekannte Übungen in Pfaden und doppelte Sequenzen ab', () => {
    const clone = () => JSON.parse(JSON.stringify(TRAINING_CATALOG)) as typeof TRAINING_CATALOG;
    const duplicate = clone();
    (duplicate.definitions as unknown[]).push({ ...duplicate.definitions[0] });
    expect(() => validateTrainingCatalog(duplicate)).toThrow(/doppelter Definition-Key/);
    const unknown = clone();
    (unknown.paths[0]!.items as unknown as { definitionKey: string }[])[0]!.definitionKey =
      'missing_v9';
    expect(() => validateTrainingCatalog(unknown)).toThrow(/unbekannte Übung/);
    const sequence = clone();
    (sequence.paths[0]!.items as unknown as { sequence: number }[])[1]!.sequence = 1;
    expect(() => validateTrainingCatalog(sequence)).toThrow(/eindeutige Reihenfolge/);
  });

  it('jeder Evaluator verwendet nur bekannte Event-Keys; jeder Event-Key gehört zu einem Evaluator', () => {
    const used = new Set<string>();
    for (const spec of Object.values(TRAINING_EVALUATORS)) {
      for (const step of spec.steps) {
        for (const key of step.eventKeys) {
          expect(isTrainingEventKey(key)).toBe(true);
          used.add(key);
        }
      }
    }
    for (const key of TRAINING_EVENT_KEYS) expect(used.has(key)).toBe(true);
    expect(evaluatorAcceptsEvent(TRAINING_EVALUATORS.offer_send, 'offer.sent')).toBe(true);
    expect(evaluatorAcceptsEvent(TRAINING_EVALUATORS.offer_send, 'tour.started')).toBe(false);
  });

  it('Rechtevorbedingung: anyOf/allOf (§55 – keine neuen Rechte)', () => {
    const set = new Set(['offer.edit_draft'] as const);
    expect(hasRequiredPermissions({ allOf: ['offer.edit_draft', 'offer.send'] }, set)).toBe(false);
    expect(hasRequiredPermissions({ anyOf: ['offer.edit_draft', 'offer.send'] }, set)).toBe(true);
    expect(hasRequiredPermissions({ anyOf: [] }, set)).toBe(true);
    expect(hasRequiredPermissions({ allOf: [] }, set)).toBe(true);
  });
});

describe('matchEvent / isComplete / openStep (Order §45, §74, §77)', () => {
  const offer = TRAINING_EVALUATORS.offer_send;
  const tour = TRAINING_EVALUATORS.tour_complete;
  const handover = TRAINING_EVALUATORS.handover_complete;

  it('offer_send: Versand ohne Bearbeitung wird abgelehnt (PREREQUISITE_MISSING); Bearbeitung + Versand desselben Angebots ⇒ vollständig', () => {
    const none: AcceptedEvent[] = [];
    expect(matchEvent(offer, none, { eventKey: 'offer.sent', subjectRef: TOUR_A })).toEqual({
      stepKey: 'send',
      result: 'rejected',
      errorCode: EVALUATOR_ERROR_CODES.PREREQUISITE_MISSING,
    });
    const edit = matchEvent(offer, none, { eventKey: 'offer.draft_updated', subjectRef: TOUR_A });
    expect(edit).toEqual({ stepKey: 'edit', result: 'accepted', errorCode: null });
    const accepted: AcceptedEvent[] = [{ stepKey: 'edit', subjectRef: TOUR_A }];
    expect(isComplete(offer, accepted)).toBe(false);
    expect(openStep(offer, accepted)?.key).toBe('send');
    // anderes Angebot versendet ⇒ zählt nicht für dasselbe Fachobjekt
    expect(matchEvent(offer, accepted, { eventKey: 'offer.sent', subjectRef: TOUR_B }).result).toBe(
      'rejected',
    );
    expect(matchEvent(offer, accepted, { eventKey: 'offer.sent', subjectRef: TOUR_A }).result).toBe(
      'accepted',
    );
    const complete = [...accepted, { stepKey: 'send', subjectRef: TOUR_A }];
    expect(isComplete(offer, complete)).toBe(true);
    expect(openStep(offer, complete)).toBeNull();
    expect(stepsView(offer, complete)).toEqual([
      { key: 'edit', title: 'Angebotsentwurf anlegen oder bearbeiten', done: true },
      { key: 'send', title: 'Angebot versenden', done: true },
    ]);
  });

  it('sameSubject verlangt ein Fachobjekt; fremde Ereignisse sind nicht anwendbar; erfüllte Schritte ⇒ duplicate', () => {
    expect(matchEvent(offer, [], { eventKey: 'offer.draft_created', subjectRef: null })).toEqual({
      stepKey: 'edit',
      result: 'rejected',
      errorCode: EVALUATOR_ERROR_CODES.SUBJECT_MISSING,
    });
    expect(matchEvent(offer, [], { eventKey: 'tour.started', subjectRef: TOUR_A })).toEqual({
      stepKey: null,
      result: 'rejected',
      errorCode: EVALUATOR_ERROR_CODES.EVENT_NOT_APPLICABLE,
    });
    const accepted: AcceptedEvent[] = [{ stepKey: 'edit', subjectRef: TOUR_A }];
    expect(
      matchEvent(offer, accepted, { eventKey: 'offer.draft_created', subjectRef: TOUR_A }),
    ).toEqual({ stepKey: 'edit', result: 'duplicate', errorCode: null });
  });

  it('tour_complete: plan → start → end in Reihenfolge, Start ohne Planung abgelehnt, Mischung zweier Touren unvollständig', () => {
    expect(matchEvent(tour, [], { eventKey: 'tour.started', subjectRef: TOUR_A }).errorCode).toBe(
      EVALUATOR_ERROR_CODES.PREREQUISITE_MISSING,
    );
    const planned: AcceptedEvent[] = [{ stepKey: 'plan', subjectRef: TOUR_A }];
    expect(
      matchEvent(tour, planned, { eventKey: 'tour.completed', subjectRef: TOUR_A }).result,
    ).toBe('rejected');
    expect(matchEvent(tour, planned, { eventKey: 'tour.started', subjectRef: TOUR_A }).result).toBe(
      'accepted',
    );
    const mixed: AcceptedEvent[] = [
      { stepKey: 'plan', subjectRef: TOUR_A },
      { stepKey: 'start', subjectRef: TOUR_B },
    ];
    expect(isComplete(tour, mixed)).toBe(false);
    // Offener Schritt folgt dem Fachobjekt mit dem größten Fortschritt (Tour A: plan erfüllt ⇒ start).
    expect(openStep(tour, mixed)?.key).toBe('start');
    const done: AcceptedEvent[] = [
      { stepKey: 'plan', subjectRef: TOUR_A },
      { stepKey: 'start', subjectRef: TOUR_A },
      { stepKey: 'end', subjectRef: TOUR_A },
    ];
    expect(isComplete(tour, done)).toBe(true);
    expect(stepsView(tour, done).every((step) => step.done)).toBe(true);
    // `tour.ready` erfüllt den Planungsschritt ebenso wie `tour.planned`.
    expect(matchEvent(tour, [], { eventKey: 'tour.ready', subjectRef: TOUR_B })).toEqual({
      stepKey: 'plan',
      result: 'accepted',
      errorCode: null,
    });
  });

  it('Einschritt-Evaluator (handover_complete): Ereignis ⇒ vollständig; Wiederholung ⇒ duplicate, kein zweiter Abschluss', () => {
    const first = matchEvent(handover, [], { eventKey: 'handover.finalized', subjectRef: null });
    expect(first).toEqual({ stepKey: 'finalize', result: 'accepted', errorCode: null });
    const accepted: AcceptedEvent[] = [{ stepKey: 'finalize', subjectRef: null }];
    expect(isComplete(handover, accepted)).toBe(true);
    expect(
      matchEvent(handover, accepted, { eventKey: 'handover.finalized', subjectRef: null }),
    ).toEqual({
      stepKey: 'finalize',
      result: 'duplicate',
      errorCode: null,
    });
    expect(openStep(handover, [])).toEqual(handover.steps[0]);
    expect(stepsView(handover, [])).toEqual([
      { key: 'finalize', title: 'Übergabe abschließen', done: false },
    ]);
  });

  it('inventory_stocktake_approve: Freigabe ohne vorherige Zählung desselben Inventurlaufs wird abgelehnt', () => {
    const spec = TRAINING_EVALUATORS.inventory_stocktake_approve;
    const counted: AcceptedEvent[] = [{ stepKey: 'count', subjectRef: TOUR_A }];
    expect(
      matchEvent(spec, counted, { eventKey: 'inventory.stocktake_approved', subjectRef: TOUR_B })
        .errorCode,
    ).toBe(EVALUATOR_ERROR_CODES.PREREQUISITE_MISSING);
    expect(
      matchEvent(spec, counted, { eventKey: 'inventory.stocktake_approved', subjectRef: TOUR_A })
        .result,
    ).toBe('accepted');
  });
});
