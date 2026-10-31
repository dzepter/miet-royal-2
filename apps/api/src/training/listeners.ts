import type { MailSentListener } from '../communication/mail/send-job.ts';
import type { TrainingEventRecorder } from './recorder.ts';

/**
 * Phase 14 (Training, Order §42/§78, Design §4.3): Mail-Antworten zählen erst
 * mit bestätigtem Versand („queued ist nicht sent“). Der Listener läuft NACH
 * dem Commit der Outbox-Zeile `sent` (Job `mail.send`) und meldet nur die
 * Staff-Antwort `manual_customer_reply` mit ihrem Akteur (`created_by`) und
 * der Konversationszeile als Fachobjekt – nie Inhalte. Idempotenz liefert der
 * Recorder (doppeltes Ereignis ⇒ `duplicate`).
 */
export function createTrainingMailSentListener(recorder: TrainingEventRecorder): MailSentListener {
  return {
    mailSent: async (delivery) => {
      if (delivery.kind !== 'manual_customer_reply' || delivery.createdBy === null) return;
      await recorder.record({
        actorUserId: delivery.createdBy,
        eventKey: 'communication.reply_sent',
        subjectRef: delivery.conversationMessageId,
      });
    },
  };
}
