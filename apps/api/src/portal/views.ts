import type { PortalBookingState, VisibleBooking } from './visibility.ts';

/**
 * Phase 15 (Design §6): kundensichere DTOs des Kundenportals (BOOKING). Die
 * Builder lesen AUSSCHLIESSLICH explizit genannte Felder aus den eingefrorenen
 * Buchungs-Snapshots – nie `...row`, nie Staff-Views. Verbotene Schlüssel
 * (Design §0, Order §51) kommen hier nicht vor; der Deep-Scan-Test prüft jede
 * Portal-Antwort rekursiv.
 */

export type { PortalBookingState } from './visibility.ts';

export interface PortalBookingSummary {
  bookingId: string;
  processNumber: string;
  portalState: PortalBookingState;
  stateLabel: string;
  eventDate: string | null;
  fulfillment: 'pickup' | 'delivery';
  /** Beschreibungen der Maschinenpositionen (kind = machine). */
  machines: string[];
  travelStatus: 'none' | 'en_route';
}

export type PortalItemKind = 'machine' | 'syrup' | 'consumable' | 'purchase' | 'delivery';
export type PortalBillingMode = 'fixed' | 'commission' | 'included';

export interface PortalBookingItem {
  kind: PortalItemKind;
  description: string;
  quantity: number;
  unit: string | null;
  agreedUnitPriceCents: number | null;
  totalCents: number | null;
  billingMode: PortalBillingMode;
}

export interface PortalAppointment {
  kind: 'pickup' | 'return' | 'delivery';
  label: string;
  timing: 'exact' | 'window' | 'unplanned';
  startAt: string | null;
  endAt: string | null;
  status: 'scheduled' | 'completed' | 'cancelled';
}

export interface PortalInvoiceStatus {
  status: 'none' | 'preparing' | 'open' | 'paid' | 'overdue';
  label: string;
  finalAmountCents: number | null;
}

export interface PortalCancellationInfo {
  cancelledAt: string;
  feeCents: number;
  feePercent: number;
  invoiceFollows: boolean;
}

export interface PortalBookingView {
  bookingId: string;
  processNumber: string;
  portalState: PortalBookingState;
  stateLabel: string;
  event: {
    eventDate: string | null;
    eventStart: string | null;
    eventEnd: string | null;
    guestCount: number | null;
    occasion: string | null;
    onsiteContactName: string | null;
  };
  fulfillment: 'pickup' | 'delivery';
  pickup: {
    address: string | null;
    navigation: { apple: string; android: string; web: string } | null;
  } | null;
  delivery: { street: string; postalCode: string; city: string } | null;
  appointments: PortalAppointment[];
  items: PortalBookingItem[];
  price: {
    agreedTotalCents: number;
    machineSubtotalCents: number;
    discountCents: number;
    voucherDiscountCents: number;
    deliveryPriceCents: number | null;
  };
  invoice: PortalInvoiceStatus;
  cancellation: PortalCancellationInfo | null;
  travelStatus: 'none' | 'en_route';
  canCancelOnline: boolean;
  canMessage: boolean;
  acceptedAt: string;
}

export type PortalDocumentType =
  'offer' | 'order_confirmation' | 'delivery_note' | 'handover_protocol' | 'return_protocol';

export interface PortalDocumentView {
  id: string;
  type: PortalDocumentType;
  label: string;
  createdAt: string;
}

export interface PortalCancellationPreview {
  eventDate: string | null;
  remainingDays: number | null;
  feePercent: number | null;
  baseCents: number | null;
  feeCents: number | null;
  allowed: boolean;
  blockedMessage: string | null;
}

// ── Labels (API liefert, Web zeigt) ─────────────────────────────────────────

export const PORTAL_STATE_LABELS: Record<PortalBookingState, string> = {
  active: 'Bestätigte Buchung',
  completed_open: 'Abgeschlossen – Rechnung offen',
  cancelled_free: 'Storniert',
  cancelled_fee: 'Storniert – Stornogebühr',
};

export const PORTAL_DOCUMENT_LABELS: Record<PortalDocumentType, string> = {
  offer: 'Angebot (angenommen)',
  order_confirmation: 'Auftragsbestätigung',
  delivery_note: 'Lieferschein',
  handover_protocol: 'Übergabeprotokoll',
  return_protocol: 'Rückgabeprotokoll',
};

/** Dateinamen des Downloads – nur `[a-z0-9-]` (Header-sicher, Order §24). */
export const PORTAL_DOCUMENT_FILENAMES: Record<PortalDocumentType, string> = {
  offer: 'angebot',
  order_confirmation: 'auftragsbestaetigung',
  delivery_note: 'lieferschein',
  handover_protocol: 'uebergabeprotokoll',
  return_protocol: 'rueckgabeprotokoll',
};

export const PORTAL_INVOICE_LABELS: Record<PortalInvoiceStatus['status'], string> = {
  none: 'Keine Rechnung vorhanden',
  preparing: 'Rechnung wird vorbereitet',
  open: 'Offen',
  paid: 'Bezahlt',
  overdue: 'Überfällig',
};

export function portalAppointmentLabel(
  kind: PortalAppointment['kind'],
  fulfillment: 'pickup' | 'delivery',
): string {
  switch (kind) {
    case 'pickup':
      return 'Abholung';
    case 'delivery':
      return 'Lieferung';
    case 'return':
      return fulfillment === 'delivery' ? 'Rückholung' : 'Rückgabe';
  }
}

// ── Snapshot-Leser (defensiv – jsonb ist untypisiert) ───────────────────────

export function snapshotRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function snapshotString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function snapshotNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const ITEM_KINDS: ReadonlySet<string> = new Set<PortalItemKind>([
  'machine',
  'syrup',
  'consumable',
  'purchase',
  'delivery',
]);
const BILLING_MODES: ReadonlySet<string> = new Set<PortalBillingMode>([
  'fixed',
  'commission',
  'included',
]);

/**
 * Positionen aus `bookings.items_snapshot` – NUR kundensichtbare Felder. Kein
 * standardUnitPriceCents, priceSource, productId, productSnapshot (Order §16/§51).
 */
export function buildPortalItems(itemsSnapshot: unknown): PortalBookingItem[] {
  const raw = Array.isArray(itemsSnapshot) ? itemsSnapshot : [];
  const items: PortalBookingItem[] = [];
  for (const entry of raw) {
    const item = snapshotRecord(entry);
    const kind = snapshotString(item.kind);
    const billingMode = snapshotString(item.billingMode);
    if (kind === null || !ITEM_KINDS.has(kind)) continue;
    if (billingMode === null || !BILLING_MODES.has(billingMode)) continue;
    items.push({
      kind: kind as PortalItemKind,
      description: snapshotString(item.description) ?? '',
      quantity: snapshotNumber(item.quantity) ?? 0,
      unit: snapshotString(item.unit),
      agreedUnitPriceCents: snapshotNumber(item.agreedUnitPriceCents),
      totalCents: snapshotNumber(item.totalCents),
      billingMode: billingMode as PortalBillingMode,
    });
  }
  return items;
}

export function machineDescriptions(itemsSnapshot: unknown): string[] {
  return buildPortalItems(itemsSnapshot)
    .filter((item) => item.kind === 'machine')
    .map((item) => item.description);
}

export function buildPortalEvent(eventSnapshot: unknown): PortalBookingView['event'] {
  const event = snapshotRecord(eventSnapshot);
  return {
    eventDate: snapshotString(event.eventDate),
    eventStart: snapshotString(event.eventStart),
    eventEnd: snapshotString(event.eventEnd),
    guestCount: snapshotNumber(event.guestCount),
    occasion: snapshotString(event.occasion),
    onsiteContactName: snapshotString(event.onsiteContactName),
    // onsiteContactPhone bewusst NICHT (Design §2.2).
  };
}

export function buildPortalPrice(
  totalsSnapshot: unknown,
  deliverySnapshot: unknown,
): PortalBookingView['price'] {
  const totals = snapshotRecord(totalsSnapshot);
  const delivery = snapshotRecord(deliverySnapshot);
  return {
    agreedTotalCents: snapshotNumber(totals.fixedTotalCents) ?? 0,
    machineSubtotalCents: snapshotNumber(totals.machineSubtotalCents) ?? 0,
    discountCents: snapshotNumber(totals.discountCents) ?? 0,
    voucherDiscountCents: snapshotNumber(totals.voucherDiscountCents) ?? 0,
    deliveryPriceCents: snapshotNumber(delivery.deliveryPriceCents),
  };
}

export function buildPortalDelivery(
  fulfillment: 'pickup' | 'delivery',
  deliverySnapshot: unknown,
): PortalBookingView['delivery'] {
  if (fulfillment !== 'delivery') return null;
  const delivery = snapshotRecord(deliverySnapshot);
  return {
    street: snapshotString(delivery.street) ?? '',
    postalCode: snapshotString(delivery.postalCode) ?? '',
    city: snapshotString(delivery.city) ?? '',
  };
}

/** Storno-Block: nur Zeitpunkt, Gebühr, Satz und ob eine Rechnung folgt (Order §44). */
export function buildPortalCancellationInfo(
  visible: VisibleBooking,
): PortalCancellationInfo | null {
  if (visible.portalState !== 'cancelled_free' && visible.portalState !== 'cancelled_fee') {
    return null;
  }
  const row = visible.cancellation;
  if (row === null) return null;
  return {
    cancelledAt: row.cancelledAt.toISOString(),
    feeCents: row.feeCents,
    feePercent: row.feePercent,
    invoiceFollows: row.feeCents > 0 && row.financeStatus !== 'paid',
  };
}

export function buildPortalBookingSummary(
  visible: VisibleBooking,
  travelStatus: 'none' | 'en_route',
): PortalBookingSummary {
  const event = snapshotRecord(visible.booking.eventSnapshot);
  return {
    bookingId: visible.booking.id,
    processNumber: visible.process.processNumber,
    portalState: visible.portalState,
    stateLabel: PORTAL_STATE_LABELS[visible.portalState],
    eventDate: snapshotString(event.eventDate) ?? visible.process.eventDate,
    fulfillment: visible.booking.fulfillment,
    machines: machineDescriptions(visible.booking.itemsSnapshot),
    travelStatus,
  };
}
