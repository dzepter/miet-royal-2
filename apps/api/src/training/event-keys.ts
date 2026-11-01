/**
 * Phase 14 (Training, Order §41, Design §4.2): geschlossene Liste der
 * fachlichen Ereignisse, die der TrainingEventRecorder entgegennimmt. Jedes
 * Ereignis wird ausschließlich NACH einem erfolgreichen Fachcommit durch die
 * jeweilige Route bzw. den Job gemeldet (§42); der Recorder kennt keine
 * anderen Schlüssel. Die Liste ist Code – kein Admin-Scripting (§34).
 */
export const TRAINING_EVENT_KEYS = [
  'offer.draft_created',
  'offer.draft_updated',
  'offer.sent',
  'handover.finalized',
  'return.finalized',
  'tour.planned',
  'tour.ready',
  'tour.started',
  'tour.completed',
  'communication.reply_sent',
  'settlement.reviewed',
  'machine.cleaning_completed',
  'inventory.stocktake_created',
  'inventory.stocktake_approved',
] as const;

export type TrainingEventKey = (typeof TRAINING_EVENT_KEYS)[number];

const KEY_SET: ReadonlySet<string> = new Set(TRAINING_EVENT_KEYS);

export function isTrainingEventKey(value: string): value is TrainingEventKey {
  return KEY_SET.has(value);
}
