import type { VisibleBooking } from './visibility.ts';
import { PORTAL_INVOICE_LABELS, type PortalInvoiceStatus } from './views.ts';

/**
 * Phase 15 (Order §22, Design §2.2): Rechnungsstatus für den Kunden – NUR die
 * fachlich finalen Zustände aus `settlements` bzw. `cancellations`:
 *
 * - keine Abrechnung ⇒ `none` (aktive Buchung) bzw. `preparing`, wenn der
 *   Vorgang bereits abgeschlossen ist (Phase 15, Review R13);
 * - Abrechnung vorhanden, aber noch nicht gesperrt (`locked_at` NULL) ⇒
 *   `preparing` („Rechnung wird vorbereitet“) – ohne Betrag, denn vorläufige
 *   Positionen (Schäden, Fehlteile, Klärungen) erreichen den Kunden hier nie;
 * - gesperrt (erfolgreich übertragen) ⇒ Status aus `payment_status`
 *   (NULL ⇒ open), finaler Betrag `amount_due_cents`;
 * - Stornozeile vorhanden (unabhängig vom Vorgangsstatus, Review R1):
 *   0 € ⇒ `none`; kostenpflichtig `accounting_pending` preparing, `invoice_open`
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
  // Phase 15 (Review R1): Stornozeile vorhanden ⇒ Status IMMER aus der Stornozeile (auch nach
  // einem Reopen des Vorgangs) – nie aus einer Abrechnung der stornierten Buchung.
  const row = visible.cancellation;
  if (row !== null) {
    if (row.feeCents <= 0) return { status: 'none', finalAmountCents: null };
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
  if (settlement === null) {
    // Phase 15 (Review R13): abgeschlossen ohne Abrechnung ⇒ „Rechnung wird vorbereitet“ –
    // nie „Keine Rechnung vorhanden“ neben „Abgeschlossen – Rechnung offen“.
    if (visible.portalState === 'completed_open') {
      return { status: 'preparing', finalAmountCents: null };
    }
    return { status: 'none', finalAmountCents: null };
  }
  if (settlement.lockedAt === null) return { status: 'preparing', finalAmountCents: null };
  const payment = settlement.paymentStatus ?? 'open';
  return { status: payment, finalAmountCents: settlement.amountDueCents };
}
