/**
 * Phase 12 (inbound/conversation): Zustellstatus der Outbox in die
 * Konversation spiegeln (Order §24 „delivery state“). Idempotent – Listener
 * dürfen bei Job-Wiederholungen mehrfach laufen.
 *
 * Härtung RA-14 (Order §24 „automatische Mails kompakt als Ereignisse“):
 * Jede automatische Mail eines Vorgangs (alle Arten außer der Staff-Antwort
 * `manual_customer_reply`, die bereits eine eigene Konversationszeile hat)
 * erscheint als Systemereignis – beim Versand (`sent`) und bei sichtbaren
 * Fehlern (`failed`/`blocked`); eine unklare Zustellung (outcome_unknown)
 * erscheint ebenfalls, bleibt aber „queued“ (kein falsches „failed“).
 * `recordOutboundSystemEvent` ist je mailDeliveryId idempotent.
 */
import type { MailDeliveryRow } from '@mietroyal/database';
import type { MailFailedListener, MailSentListener } from '../mail/send-job.ts';
import type { ConversationService } from './conversation-service.ts';

async function recordSystemEvent(
  conversations: ConversationService,
  delivery: MailDeliveryRow,
): Promise<void> {
  if (delivery.processId === null || delivery.kind === 'manual_customer_reply') return;
  await conversations.recordOutboundSystemEvent({
    processId: delivery.processId,
    customerId: delivery.customerId,
    channel: 'email',
    kind: delivery.kind,
    // Phase-12-Finalisierung: nach Retention-Scrub kein Betreff mehr (nur Art).
    subject: delivery.subject,
    mailDeliveryId: delivery.id,
  });
}

export function createConversationDeliveryListeners(conversations: ConversationService): {
  sent: MailSentListener;
  failed: MailFailedListener;
} {
  return {
    sent: {
      mailSent: async (delivery) => {
        await recordSystemEvent(conversations, delivery);
        await conversations.markDeliveryState(delivery.id, 'sent');
      },
    },
    failed: {
      mailFailed: async (delivery, result) => {
        await recordSystemEvent(conversations, delivery);
        // outcome_unknown bleibt „queued“ (kein falsches „failed“ bei unklarer Zustellung).
        if (result.status === 'outcome_unknown') return;
        await conversations.markDeliveryState(
          delivery.id,
          result.status === 'blocked' ? 'blocked' : 'failed',
        );
      },
    },
  };
}
