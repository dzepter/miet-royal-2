import {
  accountingTransfers,
  lexwareInvoiceMappings,
  type Database,
  type LexwareInvoiceMappingRow,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import type { AccountingTransferService } from '../accounting/transfer-service.ts';
import { AuthError } from '../auth/service.ts';
import { LexwareBlockedError } from './connection-service.ts';
import { berlinTodayIso, normalizeLexwarePaymentStatus, type LexwareContext } from './context.ts';
import { LexwareApiError } from './errors.ts';
import { decimalToCents } from './money.ts';

/**
 * Statusabgleich einer gemappten Lexware-Rechnung (Order §§41/48/50/51) –
 * EINE Implementierung für Webhook-Job und Reconciliation. Liest GET invoice
 * + GET payment (über den Client, also über die zentrale Drosselung) und
 * aktualisiert `lexware_invoice_mappings`; open/paid/overdue werden über
 * `AccountingTransferService.setPaymentStatus` in Settlement/Storno
 * gespiegelt. Externe Abweichungen (gelöscht/404, storniert/voided,
 * unerwarteter Status) setzen NUR einen Attention-Code (Mapping +
 * accounting_transfers.attentionCode/attentionAt): Settlement bleibt
 * gesperrt, paymentStatus bleibt unverändert, keine lokale Finanzmutation.
 */
export type LexwareInvoiceAttentionCode =
  'INVOICE_MISSING' | 'INVOICE_VOIDED' | 'INVOICE_UNEXPECTED_STATUS';

/** Attention-Codes, die dieser Abgleich selbst setzt und daher auch wieder aufheben darf. */
const SYNC_ATTENTION_CODES: readonly string[] = [
  'INVOICE_MISSING',
  'INVOICE_VOIDED',
  'INVOICE_UNEXPECTED_STATUS',
];

export interface LexwareInvoiceSyncResult {
  outcome: 'updated' | 'attention' | 'unchanged' | 'missing';
  paymentStatus?: string;
  attentionCode?: string;
}

export async function syncLexwareInvoice(
  lexware: LexwareContext,
  db: Database,
  transfers: AccountingTransferService,
  mappingId: string,
  now: Date = new Date(),
): Promise<LexwareInvoiceSyncResult> {
  const client = lexware.client;
  if (client === null) {
    throw new LexwareBlockedError(
      'LEXWARE_NOT_CONFIGURED',
      'Buchhaltungsintegration nicht konfiguriert',
    );
  }
  const rows = await db
    .select()
    .from(lexwareInvoiceMappings)
    .where(eq(lexwareInvoiceMappings.id, mappingId));
  const mapping = rows[0];
  if (mapping === undefined || mapping.lexwareInvoiceId === null) return { outcome: 'missing' };
  const invoiceId = mapping.lexwareInvoiceId;

  let invoice;
  try {
    invoice = (await client.getInvoice(invoiceId)).data;
  } catch (error) {
    if (error instanceof LexwareApiError && error.kind === 'not_found') {
      return setAttention(db, mapping, 'INVOICE_MISSING', now);
    }
    throw error;
  }
  if (invoice.voucherStatus === 'voided') {
    return setAttention(db, mapping, 'INVOICE_VOIDED', now, { voucherStatus: 'voided' });
  }

  let payment;
  try {
    payment = (await client.getPayment(invoiceId)).data;
  } catch (error) {
    if (error instanceof LexwareApiError && error.kind === 'not_found') {
      return setAttention(db, mapping, 'INVOICE_MISSING', now);
    }
    throw error;
  }

  const openAmountCents = decimalToCents(payment.openAmount);
  const dueDate = invoice.dueDate?.slice(0, 10) ?? null;
  const paidDate = payment.paidDate?.slice(0, 10) ?? null;
  const normalized = normalizeLexwarePaymentStatus({
    voucherStatus: invoice.voucherStatus,
    paymentStatus: payment.paymentStatus,
    openAmountCents,
    dueDate,
    todayBerlinIso: berlinTodayIso(now),
  });
  if (normalized === 'attention') {
    return setAttention(db, mapping, 'INVOICE_UNEXPECTED_STATUS', now, {
      voucherStatus: invoice.voucherStatus,
    });
  }

  // Nur die von diesem Abgleich gesetzten Attention-Codes wieder aufheben –
  // TOTAL_MISMATCH/RECOVERY_AMBIGUOUS bleiben Sache der Buchhaltungsprüfung.
  const clearsOwnAttention =
    mapping.attentionCode !== null && SYNC_ATTENTION_CODES.includes(mapping.attentionCode);
  const unchanged =
    !clearsOwnAttention &&
    mapping.voucherStatus === invoice.voucherStatus &&
    mapping.dueDate === dueDate &&
    mapping.openAmountCents === openAmountCents &&
    mapping.paidDate === paidDate &&
    mapping.paymentStatus === normalized &&
    (mapping.voucherNumber ?? null) === (invoice.voucherNumber ?? null);

  await db.transaction(async (tx) => {
    await tx
      .update(lexwareInvoiceMappings)
      .set({
        voucherStatus: invoice.voucherStatus,
        ...(invoice.voucherNumber === undefined ? {} : { voucherNumber: invoice.voucherNumber }),
        dueDate,
        openAmountCents,
        paidDate,
        paymentStatus: normalized,
        lastSyncedAt: now,
        ...(clearsOwnAttention ? { attentionCode: null } : {}),
        updatedAt: now,
      })
      .where(eq(lexwareInvoiceMappings.id, mapping.id));
    if (clearsOwnAttention) {
      const transferRows = await tx
        .select({ attentionCode: accountingTransfers.attentionCode })
        .from(accountingTransfers)
        .where(eq(accountingTransfers.id, mapping.accountingTransferId));
      if (transferRows[0]?.attentionCode === mapping.attentionCode) {
        await tx
          .update(accountingTransfers)
          .set({ attentionCode: null, attentionAt: null, updatedAt: now })
          .where(eq(accountingTransfers.id, mapping.accountingTransferId));
      }
    }
  });

  if (unchanged) return { outcome: 'unchanged', paymentStatus: normalized };

  // Spiegelung in Settlement/Storno (nur open/paid/overdue) über die
  // bestehende Phase-9-Boundary. Ist die Transferzeile nicht `succeeded`
  // (z. B. attention wegen TOTAL_MISMATCH), bleibt der lokale Zahlungsstatus
  // unverändert – das Mapping trägt den Lexware-Stand trotzdem.
  try {
    await transfers.setPaymentStatus(mapping.accountingTransferId, normalized, now);
  } catch (error) {
    if (!(error instanceof AuthError && error.code === 'CONFLICT')) throw error;
    lexware.logger.warn(
      {
        lexware: {
          action: 'invoice_sync',
          mappingId: mapping.id,
          transferId: mapping.accountingTransferId,
          paymentStatus: normalized,
          code: 'TRANSFER_NOT_SUCCEEDED',
        },
      },
      'Lexware-Zahlungsstatus nicht gespiegelt: Transfer nicht erfolgreich abgeschlossen',
    );
  }
  lexware.logger.info(
    {
      lexware: {
        action: 'invoice_sync',
        mappingId: mapping.id,
        transferId: mapping.accountingTransferId,
        paymentStatus: normalized,
        voucherStatus: invoice.voucherStatus,
      },
    },
    'Lexware-Rechnungsstatus aktualisiert',
  );
  return { outcome: 'updated', paymentStatus: normalized };
}

async function setAttention(
  db: Database,
  mapping: LexwareInvoiceMappingRow,
  code: LexwareInvoiceAttentionCode,
  now: Date,
  extra: { voucherStatus?: string } = {},
): Promise<LexwareInvoiceSyncResult> {
  await db.transaction(async (tx) => {
    await tx
      .update(lexwareInvoiceMappings)
      .set({
        attentionCode: code,
        ...(extra.voucherStatus === undefined ? {} : { voucherStatus: extra.voucherStatus }),
        lastSyncedAt: now,
        updatedAt: now,
      })
      .where(eq(lexwareInvoiceMappings.id, mapping.id));
    const transferRows = await tx
      .select({ attentionCode: accountingTransfers.attentionCode })
      .from(accountingTransfers)
      .where(eq(accountingTransfers.id, mapping.accountingTransferId));
    const current = transferRows[0]?.attentionCode ?? null;
    // Einen bestehenden fremden Attention-Code (z. B. TOTAL_MISMATCH) nicht überschreiben.
    if (current === null || SYNC_ATTENTION_CODES.includes(current)) {
      await tx
        .update(accountingTransfers)
        .set({ attentionCode: code, attentionAt: now, updatedAt: now })
        .where(eq(accountingTransfers.id, mapping.accountingTransferId));
    }
  });
  return {
    outcome: 'attention',
    attentionCode: code,
    ...(mapping.paymentStatus === null ? {} : { paymentStatus: mapping.paymentStatus }),
  };
}
