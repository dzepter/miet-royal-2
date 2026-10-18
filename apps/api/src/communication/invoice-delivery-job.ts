/**
 * Job `invoice.delivery` (Phase 12, Order §§16/37): Rechnungsmail nach
 * erfolgreicher Lexware-Rechnungserstellung (Abrechnung UND Storno). Der
 * Transfer-Service reiht den Job nach dem Commit ein (Key je Rechnungs-
 * Mapping); der Job legt GENAU EINE Outbox-Zustellung `invoice_delivery` an
 * (Empfänger = eingefrorene Buchungs-E-Mail, Anhang = Lexware-Rechnung
 * transient über den Lexware-Client – nie documents/Storage/Dateisystem).
 * Automatisch nie doppelt (mail_delivery_id am Mapping); manueller Resend
 * läuft über die Outbox (neue Zustellung, neue Message-ID). Der Sent-
 * Listener setzt `invoice_delivery_status = sent` an Abrechnung/Storno und
 * `delivery_status = sent` am Mapping.
 */
import {
  accountingTransfers,
  bookings,
  cancellations,
  lexwareInvoiceMappings,
  processes,
  settlements,
  type Database,
} from '@mietroyal/database';
import type { AppConfig } from '@mietroyal/config';
import type { JobHandler, JobQueue, JobRunnerLogger } from '@mietroyal/integrations';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { LexwareContext } from '../lexware/context.ts';
import type { MailOutboxService } from './mail/outbox.ts';
import type { InvoiceFileFetcher } from './mail/send-job.ts';
import type { InvoiceDeliveryMailContext } from './mail/templates/contexts.ts';
import { mailSalutation, safeAttachmentName, transactionalKey } from './transactional/keys.ts';
import { INVOICE_DELIVERY_JOB_TYPE } from './types.ts';

export function invoiceDeliveryJobKey(mappingId: string): string {
  return `${INVOICE_DELIVERY_JOB_TYPE}:${mappingId}`;
}

/** Nach dem Commit des Transfers aufrufen (Wiederholung mit demselben Schlüssel ist ein No-op). */
export async function enqueueInvoiceDelivery(queue: JobQueue, mappingId: string): Promise<void> {
  await queue.enqueue(
    INVOICE_DELIVERY_JOB_TYPE,
    { mappingId },
    { idempotencyKey: invoiceDeliveryJobKey(mappingId) },
  );
}

/** Transienter Rechnungsabruf für den Anhang – Bytes werden nach dem Versand verworfen. */
export function createLexwareInvoiceFileFetcher(
  lexware: Pick<LexwareContext, 'client'>,
): InvoiceFileFetcher {
  return {
    async fetch(lexwareInvoiceId: string): Promise<Uint8Array> {
      if (lexware.client === null) throw new Error('Lexware ist nicht konfiguriert.');
      const file = await lexware.client.getInvoiceFile(lexwareInvoiceId);
      return file.data;
    },
  };
}

export interface InvoiceDeliveryJobDeps {
  db: Database;
  /** Automatischer Versand nur bei explizit konfiguriertem Mailversand (MAIL_ENABLED). */
  config: Pick<AppConfig, 'mail'>;
  outbox: MailOutboxService;
  logger?: JobRunnerLogger | undefined;
}

/**
 * Sweep (für `communication.scan_due`): Rechnungen mit Versand „ausstehend“
 * ohne Zustellung erneut einreihen – z. B. wenn der Mailversand erst nach der
 * Rechnungserstellung konfiguriert wurde. Zeit-Bucket im Jobschlüssel (Keys
 * sind für immer UNIQUE); der Job selbst ist idempotent (mail_delivery_id).
 */
export async function enqueuePendingInvoiceDeliveries(deps: {
  db: Database;
  queue: JobQueue;
  config: Pick<AppConfig, 'mail'>;
  now?: Date;
  limit?: number;
}): Promise<number> {
  if (!deps.config.mail.enabled) return 0;
  const bucket = (deps.now ?? new Date()).toISOString().slice(0, 13);
  const rows = await deps.db
    .select({ id: lexwareInvoiceMappings.id })
    .from(lexwareInvoiceMappings)
    .where(
      and(
        eq(lexwareInvoiceMappings.deliveryStatus, 'pending'),
        isNotNull(lexwareInvoiceMappings.lexwareInvoiceId),
        isNull(lexwareInvoiceMappings.mailDeliveryId),
      ),
    )
    .orderBy(asc(lexwareInvoiceMappings.createdAt))
    .limit(deps.limit ?? 100);
  for (const row of rows) {
    await deps.queue.enqueue(
      INVOICE_DELIVERY_JOB_TYPE,
      { mappingId: row.id },
      { idempotencyKey: `${invoiceDeliveryJobKey(row.id)}:sweep:${bucket}` },
    );
  }
  return rows.length;
}

export type InvoiceDeliveryOutcome =
  'mail_not_configured' | 'queued' | 'blocked' | 'already_queued' | 'not_ready' | 'not_found';

export class InvoiceDeliveryJob {
  constructor(private readonly deps: InvoiceDeliveryJobDeps) {}

  async process(mappingId: string, now = new Date()): Promise<InvoiceDeliveryOutcome> {
    const rows = await this.deps.db
      .select({ mapping: lexwareInvoiceMappings, transfer: accountingTransfers })
      .from(lexwareInvoiceMappings)
      .innerJoin(
        accountingTransfers,
        eq(accountingTransfers.id, lexwareInvoiceMappings.accountingTransferId),
      )
      .where(eq(lexwareInvoiceMappings.id, mappingId));
    const hit = rows[0];
    if (hit === undefined) return 'not_found';
    const { mapping, transfer } = hit;
    if (mapping.mailDeliveryId !== null) return 'already_queued';
    if (!this.deps.config.mail.enabled) return 'mail_not_configured';
    if (mapping.deliveryStatus !== 'pending' || mapping.lexwareInvoiceId === null)
      return 'not_ready';
    const invoiceNumber = mapping.voucherNumber ?? mapping.lexwareInvoiceId;

    // Bezug: Abrechnung oder Storno ⇒ Buchung (eingefrorene E-Mail) + Vorgang.
    let bookingId: string | null = null;
    let processId: string | null = null;
    if (transfer.settlementId !== null) {
      const s = await this.deps.db
        .select({ bookingId: settlements.bookingId, processId: settlements.processId })
        .from(settlements)
        .where(eq(settlements.id, transfer.settlementId));
      bookingId = s[0]?.bookingId ?? null;
      processId = s[0]?.processId ?? null;
    } else if (transfer.cancellationId !== null) {
      const c = await this.deps.db
        .select({ bookingId: cancellations.bookingId, processId: cancellations.processId })
        .from(cancellations)
        .where(eq(cancellations.id, transfer.cancellationId));
      bookingId = c[0]?.bookingId ?? null;
      processId = c[0]?.processId ?? null;
    }
    if (bookingId === null || processId === null) return 'not_ready';
    const bookingRows = await this.deps.db
      .select({
        customerId: bookings.customerId,
        customerSnapshot: bookings.customerSnapshot,
        processNumber: processes.processNumber,
      })
      .from(bookings)
      .innerJoin(processes, eq(processes.id, bookings.processId))
      .where(eq(bookings.id, bookingId));
    const booking = bookingRows[0];
    if (booking === undefined) return 'not_ready';
    const customer = (booking.customerSnapshot ?? {}) as Record<string, unknown>;
    const email = typeof customer.email === 'string' ? customer.email.trim() : '';
    const name = typeof customer.displayName === 'string' ? customer.displayName : null;
    const context: InvoiceDeliveryMailContext = {
      salutation: mailSalutation(name),
      processNumber: booking.processNumber,
      invoiceNumber,
    };
    const result = await this.deps.outbox.enqueueAndSchedule({
      kind: 'invoice_delivery',
      processId,
      customerId: booking.customerId,
      bookingId,
      recipient: { email, name },
      context,
      attachments: [
        {
          kind: 'lexware_invoice',
          lexwareInvoiceId: mapping.lexwareInvoiceId,
          filename: safeAttachmentName(`Rechnung-${invoiceNumber}.pdf`),
        },
      ],
      idempotencyKey: transactionalKey('invoice_delivery', mappingId),
    });
    await this.deps.db
      .update(lexwareInvoiceMappings)
      .set({ mailDeliveryId: result.deliveryId, updatedAt: now })
      .where(eq(lexwareInvoiceMappings.id, mappingId));
    // Abrechnung/Storno: `pending` bleibt bis zum bestätigten Versand (Sent-Listener ⇒ sent);
    // eine Einreih-Blockade (z. B. keine Buchungs-E-Mail) wird sichtbar `blocked`.
    await mirrorInvoiceDeliveryStatus(
      this.deps.db,
      transfer,
      result.status === 'blocked' ? 'blocked' : 'pending',
      result.deliveryId,
      now,
    );
    this.deps.logger?.info(
      {
        mail: { mappingId, mailDeliveryId: result.deliveryId, status: result.status },
      },
      'invoice.delivery: Rechnungsmail eingereiht',
    );
    return result.status === 'pending' ? 'queued' : 'blocked';
  }
}

/** Versandstatus an Abrechnung/Storno spiegeln (Textspalten ohne CHECK). */
export async function mirrorInvoiceDeliveryStatus(
  db: Database,
  transfer: { settlementId: string | null; cancellationId: string | null },
  status: 'pending' | 'sent' | 'failed' | 'blocked',
  deliveryId: string,
  now: Date,
): Promise<void> {
  if (transfer.settlementId !== null) {
    await db
      .update(settlements)
      .set({ invoiceDeliveryStatus: status, invoiceMailDeliveryId: deliveryId, updatedAt: now })
      .where(eq(settlements.id, transfer.settlementId));
  }
  if (transfer.cancellationId !== null) {
    await db
      .update(cancellations)
      .set({ invoiceDeliveryStatus: status, invoiceMailDeliveryId: deliveryId, updatedAt: now })
      .where(eq(cancellations.id, transfer.cancellationId));
  }
}

export function createInvoiceDeliveryHandler(deps: InvoiceDeliveryJobDeps): JobHandler {
  const job = new InvoiceDeliveryJob(deps);
  return async (queued) => {
    const payload = queued.payload as { mappingId?: unknown } | null;
    const mappingId = payload?.mappingId;
    if (typeof mappingId !== 'string' || mappingId === '') {
      throw new Error('invoice.delivery: Payload ohne mappingId');
    }
    const outcome = await job.process(mappingId);
    deps.logger?.info(
      { jobId: queued.id, mail: { mappingId, outcome }, attempt: queued.attempts },
      'invoice.delivery verarbeitet',
    );
  };
}
