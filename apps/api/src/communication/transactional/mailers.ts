/**
 * Fachliche Auslöser auf die zentrale Mail-Outbox (Phase 12, Order §§11–14).
 * Jeder Mailer reiht GENAU EINE Outbox-Zeile in der fachlichen Transaktion
 * des Aufrufers ein (Executor = tx) und plant den Versandjob NACH dem Commit
 * (`afterCommit`). Gateways werden hier nie aufgerufen – das tut nur der
 * Job `mail.send`. Einreihen wirft nur bei Programmierfehlern (ungültiger
 * Vorlagenkontext); Blockaden (kein Empfänger, Mail nicht konfiguriert, Demo-
 * Whitelist) sind Ergebnisse, keine Fehler.
 */
import {
  cancellations,
  deliveryPackets,
  settlementCustomerNotices,
  type DatabaseExecutor,
} from '@mietroyal/database';
import { and, eq } from 'drizzle-orm';
import type { CustomerDocumentLinkService } from '../document-links.ts';
import type { MailOutboxService } from '../mail/outbox.ts';
import type {
  CancellationConfirmationMailContext,
  HandoverProtocolMailContext,
  ReturnProtocolMailContext,
  SettlementNoticeMailContext,
} from '../mail/templates/contexts.ts';
import type { MailDeliveryStatus, MailEnqueueResult, OutboundMailGateway } from '../types.ts';
import {
  isoDateOrNull,
  mailSalutation,
  safeAttachmentName,
  transactionalKey,
  transactionalRetryKey,
} from './keys.ts';

export interface TransactionalMailDeps {
  outbox: MailOutboxService;
  /** Gateway-Art der Umgebung: `disabled` ⇒ „kein Versandweg konfiguriert“. */
  mailGatewayKind: OutboundMailGateway['kind'];
}

export interface EnqueuedMail {
  deliveryId: string;
  status: MailEnqueueResult['status'];
  messageId: string;
  deduplicated: boolean;
  /** Härtung RA-15: tatsächlicher Status einer vorhandenen Zeile (nur bei `deduplicated`). */
  existingStatus?: MailDeliveryStatus | null;
}

/**
 * Härtung RA-12/RA-15: wahrheitsgemäßer Fachstatus eines Einreih-Ergebnisses.
 * Neue Zeile ⇒ queued/blocked; vorhandene Zeile ⇒ ihr echter Zustand. Eine
 * unklare Zustellung (outcome_unknown) bleibt fachlich `queued` – nie
 * „fehlgeschlagen“, damit keine normale Sendeaktion eine Doppelmail erzeugt.
 */
export function transactionalStatusOf(
  enqueued: Pick<EnqueuedMail, 'status' | 'existingStatus'>,
): 'queued' | 'blocked' | 'sent' | 'failed' {
  const existing = enqueued.existingStatus ?? null;
  if (existing === null) return enqueued.status === 'pending' ? 'queued' : 'blocked';
  switch (existing) {
    case 'sent':
      return 'sent';
    case 'failed':
      return 'failed';
    case 'blocked':
      return 'blocked';
    default:
      // pending/sending/retry/outcome_unknown
      return 'queued';
  }
}

/** Nur eine neue bzw. noch offene Zeile braucht einen Versandjob. */
function needsSendJob(enqueued: EnqueuedMail): boolean {
  if (enqueued.status !== 'pending') return false;
  const existing = enqueued.existingStatus ?? null;
  return existing === null || existing === 'pending' || existing === 'retry';
}

/** Nach Commit: Versandjob planen (blocked ⇒ kein Job). Nie werfen (Fachaktion ist abgeschlossen). */
export async function scheduleAfterCommit(
  deps: Pick<TransactionalMailDeps, 'outbox'>,
  enqueued: EnqueuedMail | null | undefined,
  onError?: (error: unknown) => void,
): Promise<void> {
  if (enqueued === null || enqueued === undefined || !needsSendJob(enqueued)) return;
  try {
    await deps.outbox.scheduleSend(enqueued.deliveryId);
  } catch (error) {
    // Backstop: communication.scan_due plant pending-Zeilen ohne Job nach.
    onError?.(error);
  }
}

// ── Übergabe-/Rückgabeprotokoll (Order §11) ─────────────────────────────

export interface DeliveryPacketMailInput {
  kind: 'handover_completed' | 'return_completed';
  /** Übergabe- bzw. Rückgabe-ID (Idempotenz: eine Mail je Finalisierung). */
  entityId: string;
  processId: string;
  bookingId: string;
  customerId: string;
  processNumber: string;
  recipient: { email: string; name: string | null };
  finalizedAt: Date;
  documents: readonly { documentId: string; filename: string }[];
}

/**
 * Hängt die Outbox-Zustellung an das Paket `delivery_packets` (queued +
 * mail_delivery_id); ohne Empfänger (NO_RECIPIENT) oder ohne Mailweg wird
 * das Paket `failed` – die Finalisierung selbst bleibt davon unberührt.
 */
export class DeliveryPacketMailer {
  constructor(private readonly deps: TransactionalMailDeps) {}

  async enqueueWithin(tx: DatabaseExecutor, input: DeliveryPacketMailInput): Promise<EnqueuedMail> {
    const context: HandoverProtocolMailContext | ReturnProtocolMailContext =
      input.kind === 'handover_completed'
        ? {
            salutation: mailSalutation(input.recipient.name),
            processNumber: input.processNumber,
            handoverAt: input.finalizedAt.toISOString(),
          }
        : {
            salutation: mailSalutation(input.recipient.name),
            processNumber: input.processNumber,
            returnAt: input.finalizedAt.toISOString(),
          };
    const mailKind = input.kind === 'handover_completed' ? 'handover_protocol' : 'return_protocol';
    const result = await this.deps.outbox.enqueue(
      {
        kind: mailKind,
        processId: input.processId,
        customerId: input.customerId,
        bookingId: input.bookingId,
        recipient: input.recipient,
        context,
        attachments: input.documents.map((doc) => ({
          kind: 'document' as const,
          documentId: doc.documentId,
          filename: safeAttachmentName(doc.filename),
        })),
        idempotencyKey: transactionalKey(mailKind, input.entityId),
      },
      tx,
    );
    const column =
      input.kind === 'handover_completed' ? deliveryPackets.handoverId : deliveryPackets.returnId;
    // Blockiert (kein Empfänger/Mailweg) ⇒ `failed`; vorhandene Zeile ⇒ ihr echter Zustand.
    const packetStatus = transactionalStatusOf(result);
    await tx
      .update(deliveryPackets)
      .set({
        status: packetStatus === 'blocked' ? 'failed' : packetStatus,
        mailDeliveryId: result.deliveryId,
      })
      .where(and(eq(column, input.entityId), eq(deliveryPackets.kind, input.kind)));
    return result;
  }

  afterCommit(enqueued: EnqueuedMail | null | undefined, onError?: (e: unknown) => void) {
    return scheduleAfterCommit(this.deps, enqueued, onError);
  }
}

// ── Schaden-/Fehlteil-Vorinformation (Order §§12/13) ─────────────────────

export interface SettlementNoticeMailInput {
  noticeId: string;
  settlementId: string;
  processId: string;
  processNumber: string;
  customerId: string;
  bookingId: string;
  /** Rückgabeprotokoll – der Link in der Mail zeigt GENAU dieses Dokument. */
  returnProtocolDocumentId: string;
  recipient: { email: string; name: string | null };
  positions: readonly { label: string; amountCents: number }[];
  totalCents: number;
  /** Vorherige (gescheiterte) Zustellung ⇒ deterministischer Retry-Schlüssel. */
  previousDeliveryId: string | null;
  now: Date;
}

export class SettlementNoticeMailer {
  constructor(
    private readonly deps: TransactionalMailDeps,
    private readonly documentLinks: CustomerDocumentLinkService,
  ) {}

  /** „Kein Versandadapter“ – in jeder Umgebung fachlich `blocked` (nie vorgetäuscht). */
  isConfigured(): boolean {
    return this.deps.mailGatewayKind !== 'disabled';
  }

  /**
   * Dokument-Token ausstellen + Outbox-Zeile einreihen (beides in der
   * Settlement-Transaktion). Setzt an der Notice nur queued/blocked und die
   * Delivery-Referenz – die 24-h-Frist beginnt erst im Sent-Listener.
   */
  async enqueueWithin(
    tx: DatabaseExecutor,
    input: SettlementNoticeMailInput,
  ): Promise<EnqueuedMail> {
    const link = await this.documentLinks.issue(
      {
        documentId: input.returnProtocolDocumentId,
        processId: input.processId,
        customerId: input.customerId,
        bookingId: input.bookingId,
      },
      tx,
      input.now,
    );
    const context: SettlementNoticeMailContext = {
      salutation: mailSalutation(input.recipient.name),
      processNumber: input.processNumber,
      positions: input.positions.map((p) => ({ label: p.label, amountCents: p.amountCents })),
      totalCents: input.totalCents,
    };
    const result = await this.deps.outbox.enqueue(
      {
        kind: 'settlement_damage_missing_notice',
        processId: input.processId,
        customerId: input.customerId,
        bookingId: input.bookingId,
        recipient: input.recipient,
        context,
        secrets: { documentToken: link.token },
        idempotencyKey:
          input.previousDeliveryId === null
            ? transactionalKey('settlement_notice', input.noticeId)
            : transactionalRetryKey('settlement_notice', input.noticeId, input.previousDeliveryId),
      },
      tx,
    );
    const noticeStatus = transactionalStatusOf(result);
    await tx
      .update(settlementCustomerNotices)
      .set({
        status: noticeStatus,
        mailDeliveryId: result.deliveryId,
        gateway: 'mail',
        gatewayReference: result.messageId,
        blockedReason: noticeStatus === 'blocked' ? 'Versand blockiert (siehe Outbox)' : null,
        updatedAt: input.now,
      })
      .where(eq(settlementCustomerNotices.id, input.noticeId));
    return result;
  }

  afterCommit(enqueued: EnqueuedMail | null | undefined, onError?: (e: unknown) => void) {
    return scheduleAfterCommit(this.deps, enqueued, onError);
  }
}

// ── Stornobestätigung (Order §14) ────────────────────────────────────────

export interface CancellationConfirmationMailInput {
  cancellationId: string;
  processId: string;
  processNumber: string;
  customerId: string;
  bookingId: string;
  recipient: { email: string | null; name: string | null };
  eventDate: unknown;
  /** Stornokosten (0 ⇒ ohne Rechnung; > 0 ⇒ Rechnung folgt getrennt per invoice.delivery). */
  chargeCents: number;
  now: Date;
}

export class CancellationConfirmationMailer {
  constructor(private readonly deps: TransactionalMailDeps) {}

  isConfigured(): boolean {
    return this.deps.mailGatewayKind !== 'disabled';
  }

  async enqueueWithin(
    tx: DatabaseExecutor,
    input: CancellationConfirmationMailInput,
  ): Promise<EnqueuedMail> {
    const context: CancellationConfirmationMailContext = {
      salutation: mailSalutation(input.recipient.name),
      processNumber: input.processNumber,
      eventDate: isoDateOrNull(input.eventDate),
      chargeCents: Math.max(0, input.chargeCents),
    };
    // Härtung RA-15: bewusste erneute Sendeaktion nach failed/blocked ⇒ NEUE Zustellung
    // `cancellation_confirmation:<id>:retry:<vorherige>` (wie AB/Kundeninformation); eine
    // laufende/unklare/versendete Zustellung bleibt maßgeblich (kein Doppelversand).
    const result = await this.deps.outbox.enqueueRetryingFailed(
      {
        kind: 'cancellation_confirmation',
        processId: input.processId,
        customerId: input.customerId,
        bookingId: input.bookingId,
        recipient: { email: input.recipient.email ?? '', name: input.recipient.name },
        context,
        idempotencyKey: transactionalKey('cancellation_confirmation', input.cancellationId),
      },
      tx,
    );
    await tx
      .update(cancellations)
      .set({
        confirmationStatus: transactionalStatusOf(result),
        confirmationMailDeliveryId: result.deliveryId,
        confirmationGatewayReference: result.messageId,
        updatedAt: input.now,
      })
      .where(eq(cancellations.id, input.cancellationId));
    return result;
  }

  afterCommit(enqueued: EnqueuedMail | null | undefined, onError?: (e: unknown) => void) {
    return scheduleAfterCommit(this.deps, enqueued, onError);
  }
}
