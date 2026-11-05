import type { VisibleBooking } from './visibility.ts';
import { PORTAL_INVOICE_LABELS, type PortalInvoiceStatus } from './views.ts';

/**
 * Phase 15 (Order §22, Design §2.2): Rechnungsstatus für den Kunden – NUR die
 * fachlich finalen Zustände aus `settlements` bzw. `cancellations`:
 *
 * - keine Abrechnung ⇒ `none`;
 * - Abrechnung vorhanden, aber noch nicht gesperrt (`locked_at` NULL) ⇒
 *   `preparing` („Rechnung wird vorbereitet“) – ohne Betrag, denn vorläufige
 *   Positionen (Schäden, Fehlteile, Klärungen) erreichen den Kunden hier nie;
 * - gesperrt (erfolgreich übertragen) ⇒ Status aus `payment_status`
 *   (NULL ⇒ open), finaler Betrag `amount_due_cents`;
 * - kostenpflichtiges Storno ⇒ `accounting_pending` preparing, `invoice_open`
 *   open/overdue, `paid` paid; finaler Betrag = Stornogebühr.
 *
 * NIE: accountingReference, Provider-IDs, Transferfehler, Rechnungsnummer,
 * Klärungen oder Positionen (Order §22/§51).
 */
export function portalInvoiceStatus(visible: VisibleBooking): PortalInvoiceStatus {
  return withLabel(statusOf(visible));
}

function withLabel(input: Omit<PortalInvoiceStatus, 'label'>): PortalInvoiceStatus {
  return {
    status: input.status,
    label: PORTAL_INVOICE_LABELS[input.status],
    finalAmountCents: input.finalAmountCents,
  };
}

function statusOf(visible: VisibleBooking): Omit<PortalInvoiceStatus, 'label'> {
  if (visible.portalState === 'cancelled_free' || visible.portalState === 'cancelled_fee') {
    const row = visible.cancellation;
    if (row === null || row.feeCents <= 0) return { status: 'none', finalAmountCents: null };
    switch (row.financeStatus) {
      case 'no_invoice':
        return { status: 'none', finalAmountCents: null };
      case 'accounting_pending':
        return { status: 'preparing', finalAmountCents: null };
      case 'invoice_open':
        return {
          status: row.paymentStatus === 'overdue' ? 'overdue' : 'open',
          finalAmountCents: row.feeCents,
        };
      case 'paid':
        return { status: 'paid', finalAmountCents: row.feeCents };
    }
  }
  const settlement = visible.settlement;
  if (settlement === null) return { status: 'none', finalAmountCents: null };
  if (settlement.lockedAt === null) return { status: 'preparing', finalAmountCents: null };
  const payment = settlement.paymentStatus ?? 'open';
  return { status: payment, finalAmountCents: settlement.amountDueCents };
}
