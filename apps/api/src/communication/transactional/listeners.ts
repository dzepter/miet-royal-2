/**
 * Zustellstatus der Outbox in die Fachentitäten spiegeln (Phase 12, Order
 * §§11–16). Die Entität wird ausschließlich aus dem Idempotenzschlüssel der
 * Zustellung gelesen (`parseTransactionalKey`), damit auch manuelle Resends
 * (neue Delivery) den Fachstatus erreichen. Alle Listener sind idempotent –
 * der Job `mail.send` kann sie bei Wiederholung erneut aufrufen.
 */
import {
  cancellations,
  deliveryPackets,
  lexwareInvoiceMappings,
  orderConfirmations,
  accountingTransfers,
  type Database,
  type MailDeliveryRow,
} from '@mietroyal/database';
import type { JobRunnerLogger } from '@mietroyal/integrations';
import { and, eq, ne } from 'drizzle-orm';
import type { SettlementService } from '../../settlement/settlement-service.ts';
import { VoucherDeliveryService } from '../../voucher/voucher-delivery.ts';
import type { AppConfig } from '@mietroyal/config';
import { mirrorInvoiceDeliveryStatus } from '../invoice-delivery-job.ts';
import type { MailFailedListener, MailSentListener } from '../mail/send-job.ts';
import { VOUCHER_PROBLEM_MAIL_FAILED } from '../voucher-delivery-job.ts';
import { parseTransactionalKey } from './keys.ts';

export interface TransactionalListenerDeps {
  db: Database;
  config: AppConfig;
  /** Für die Kundeninformation (24-h-Frist erst nach Mailerfolg). */
  settlements: SettlementService;
  logger?: JobRunnerLogger | undefined;
}

export function createTransactionalMailListeners(deps: TransactionalListenerDeps): {
  sent: MailSentListener;
  failed: MailFailedListener;
} {
  const { db } = deps;
  const vouchers = new VoucherDeliveryService(db, deps.config);

  const sent: MailSentListener = {
    async mailSent(delivery: MailDeliveryRow): Promise<void> {
      const parsed = parseTransactionalKey(delivery.idempotencyKey);
      if (parsed === null) return;
      const sentAt = delivery.sentAt ?? new Date();
      switch (parsed.kind) {
        case 'offer':
          // Kein Fachstatus an der Angebotsversion – der Kommunikationsstatus kommt aus der Outbox.
          return;
        case 'order_confirmation':
          await db
            .update(orderConfirmations)
            .set({ status: 'sent', sentAt, mailDeliveryId: delivery.id, updatedAt: sentAt })
            .where(
              and(
                eq(orderConfirmations.id, parsed.entityId),
                ne(orderConfirmations.status, 'sent'),
              ),
            );
          return;
        case 'handover_protocol':
          await db
            .update(deliveryPackets)
            .set({ status: 'sent', sentAt, mailDeliveryId: delivery.id })
            .where(
              and(
                eq(deliveryPackets.handoverId, parsed.entityId),
                eq(deliveryPackets.kind, 'handover_completed'),
                ne(deliveryPackets.status, 'sent'),
              ),
            );
          return;
        case 'return_protocol':
          await db
            .update(deliveryPackets)
            .set({ status: 'sent', sentAt, mailDeliveryId: delivery.id })
            .where(
              and(
                eq(deliveryPackets.returnId, parsed.entityId),
                eq(deliveryPackets.kind, 'return_completed'),
                ne(deliveryPackets.status, 'sent'),
              ),
            );
          return;
        case 'settlement_notice':
          await deps.settlements.noticeMailSent(parsed.entityId, sentAt, delivery.id);
          return;
        case 'cancellation_confirmation':
          await db
            .update(cancellations)
            .set({
              confirmationStatus: 'sent',
              confirmationSentAt: sentAt,
              confirmationMailDeliveryId: delivery.id,
              updatedAt: sentAt,
            })
            .where(
              and(
                eq(cancellations.id, parsed.entityId),
                ne(cancellations.confirmationStatus, 'sent'),
              ),
            );
          return;
        case 'voucher_delivery':
          // sent, delivered_at, Versandkopie gelöscht – der Hash bleibt (Order §15).
          await vouchers.markDelivered(parsed.entityId, sentAt);
          return;
        case 'invoice_delivery': {
          const rows = await db
            .update(lexwareInvoiceMappings)
            .set({ deliveryStatus: 'sent', mailDeliveryId: delivery.id, updatedAt: sentAt })
            .where(eq(lexwareInvoiceMappings.id, parsed.entityId))
            .returning({ accountingTransferId: lexwareInvoiceMappings.accountingTransferId });
          const transferId = rows[0]?.accountingTransferId;
          if (transferId === undefined) return;
          const transfer = await db
            .select({
              settlementId: accountingTransfers.settlementId,
              cancellationId: accountingTransfers.cancellationId,
            })
            .from(accountingTransfers)
            .where(eq(accountingTransfers.id, transferId));
          if (transfer[0] !== undefined) {
            await mirrorInvoiceDeliveryStatus(db, transfer[0], 'sent', delivery.id, sentAt);
          }
          return;
        }
      }
    },
  };

  const failed: MailFailedListener = {
    async mailFailed(delivery, result): Promise<void> {
      const parsed = parseTransactionalKey(delivery.idempotencyKey);
      if (parsed === null) return;
      const now = new Date();
      // Härtung RA-12: unklare Zustellung (outcome_unknown) wird NIE als „fehlgeschlagen“
      // gespiegelt – der Fachstatus bleibt `queued` (der Kunde kann die Mail erhalten haben),
      // damit keine normale Sendeaktion eine Doppelmail erzeugt. Erneut senden nur bewusst
      // über die Admin-Outbox („erneut senden“, Warnhinweis bei unklarer Zustellung); deren
      // neue Zustellung erreicht das Fachobjekt über das Schlüsselpräfix. Der Gutschein
      // bekommt nur einen sichtbaren Problemcode (Status bleibt pending, kein Senden-Knopf).
      if (result.status === 'outcome_unknown' && parsed.kind !== 'voucher_delivery') return;
      const status = result.status === 'blocked' ? 'blocked' : 'failed';
      switch (parsed.kind) {
        case 'offer':
          return;
        case 'order_confirmation':
          await db
            .update(orderConfirmations)
            .set({ status: 'failed', updatedAt: now })
            .where(
              and(
                eq(orderConfirmations.id, parsed.entityId),
                eq(orderConfirmations.status, 'queued'),
              ),
            );
          return;
        case 'handover_protocol':
          await db
            .update(deliveryPackets)
            .set({ status: 'failed' })
            .where(
              and(
                eq(deliveryPackets.handoverId, parsed.entityId),
                eq(deliveryPackets.kind, 'handover_completed'),
                eq(deliveryPackets.status, 'queued'),
              ),
            );
          return;
        case 'return_protocol':
          await db
            .update(deliveryPackets)
            .set({ status: 'failed' })
            .where(
              and(
                eq(deliveryPackets.returnId, parsed.entityId),
                eq(deliveryPackets.kind, 'return_completed'),
                eq(deliveryPackets.status, 'queued'),
              ),
            );
          return;
        case 'settlement_notice':
          await deps.settlements.noticeMailFailed(parsed.entityId, result, now);
          return;
        case 'cancellation_confirmation':
          await db
            .update(cancellations)
            .set({ confirmationStatus: status, updatedAt: now })
            .where(
              and(
                eq(cancellations.id, parsed.entityId),
                eq(cancellations.confirmationStatus, 'queued'),
              ),
            );
          return;
        case 'voucher_delivery':
          // Gutschein bleibt gültig und pending; Problemcode für Staff/Admin sichtbar.
          await vouchers.markDeliveryProblem(
            parsed.entityId,
            result.errorCode === null ? VOUCHER_PROBLEM_MAIL_FAILED : result.errorCode,
            now,
          );
          return;
        case 'invoice_delivery': {
          const mapping = await db
            .select({ accountingTransferId: lexwareInvoiceMappings.accountingTransferId })
            .from(lexwareInvoiceMappings)
            .where(eq(lexwareInvoiceMappings.id, parsed.entityId));
          const transferId = mapping[0]?.accountingTransferId;
          if (transferId === undefined) return;
          const transfer = await db
            .select({
              settlementId: accountingTransfers.settlementId,
              cancellationId: accountingTransfers.cancellationId,
            })
            .from(accountingTransfers)
            .where(eq(accountingTransfers.id, transferId));
          if (transfer[0] !== undefined) {
            // Rechnung bleibt gültig (Order §3); nur der Versandstatus zeigt den Fehler.
            await mirrorInvoiceDeliveryStatus(db, transfer[0], status, delivery.id, now);
          }
          return;
        }
      }
    },
  };

  return { sent, failed };
}
