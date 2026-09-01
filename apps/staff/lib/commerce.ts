'use client';

/** Gemeinsame Typen/Helfer der Produkt-/Angebotsbereiche (nur Darstellung). */

export function euro(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100).toLocaleString('de-DE')},${String(abs % 100).padStart(2, '0')} €`;
}

/**
 * Mitternacht des Kalendertags in Europe/Berlin als ISO-Zeitpunkt – DST-fest
 * (kein fester +01:00-Offset; im Sommer gilt +02:00). Probiert beide
 * möglichen Offsets und prüft per Intl, welcher auf 00:00 Berlin fällt.
 */
export function berlinMidnightIso(dateStr: string): string {
  for (const offset of ['+01:00', '+02:00']) {
    const candidate = new Date(`${dateStr}T00:00:00${offset}`);
    const hour = new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(candidate);
    if (hour === '00') return candidate.toISOString();
  }
  return new Date(`${dateStr}T00:00:00+01:00`).toISOString();
}

export function parseEuroToCents(value: string): number | null {
  const trimmed = value.trim().replace(/€/g, '').replace(/\s/g, '');
  if (trimmed === '') return null;
  const match = /^(\d{1,7})(?:[,.](\d{1,2}))?$/.exec(trimmed.replace(/\.(?=\d{3}(?:\D|$))/g, ''));
  if (match === null) return null;
  const eurosPart = Number(match[1]);
  const centsPart = Number((match[2] ?? '0').padEnd(2, '0'));
  return eurosPart * 100 + centsPart;
}

export const OFFER_STATUS_LABELS: Record<string, string> = {
  draft: 'Entwurf',
  sent: 'Versendet',
  accepted: 'Angenommen',
  declined: 'Abgelehnt',
  expired: 'Abgelaufen',
  recheck_requested: 'Erneute Prüfung angefragt',
  superseded: 'Ersetzt (historisch)',
};

export const OCCASION_LABELS: Record<string, string> = {
  birthday: 'Geburtstag',
  wedding: 'Hochzeit',
  company_event: 'Firmenfeier',
  club: 'Verein',
  party: 'Party',
  school_kindergarten: 'Schule / Kindergarten',
  festival: 'Festival',
  other: 'Sonstiges',
};

export const CATEGORY_LABELS: Record<string, string> = {
  machine: 'Maschinentyp',
  syrup: 'Sirup',
  consumable: 'Verbrauchsartikel',
  purchase: 'Kaufartikel',
};

export const BILLING_LABELS: Record<string, string> = {
  fixed: 'fest berechnet',
  commission: 'Kommission',
  included: 'inklusive',
};

export interface ProductRow {
  id: string;
  slug: string;
  name: string;
  category: 'machine' | 'syrup' | 'consumable' | 'purchase';
  description: string | null;
  saleUnit: string;
  defaultBillingMode: 'fixed' | 'commission' | 'included';
  active: boolean;
  sortOrder: number;
  containerCount: number | null;
  containerVolumeLiters: number | null;
  weightGrams: number | null;
  carryPersons: number | null;
  currentPriceCents: number;
  futurePrices: { id: string; priceCents: number; effectiveFrom: string }[];
}

export interface OfferLineItemRow {
  id: string;
  position: number;
  kind: string;
  billingMode: 'fixed' | 'commission' | 'included';
  description: string;
  quantity: number;
  unit: string;
  standardUnitPriceCents: number;
  agreedUnitPriceCents: number;
  totalCents: number;
  priceSource: string;
  productId: string | null;
}

export interface OfferVersionRow {
  id: string;
  versionNumber: number;
  status: string;
  effectiveStatus: string;
  machineProductId: string | null;
  machineQuantity: number;
  fulfillment: 'pickup' | 'delivery';
  deliveryStreet: string | null;
  deliveryPostalCode: string | null;
  deliveryCity: string | null;
  deliveryPriceCents: number | null;
  discountType: 'percent' | 'fixed' | null;
  discountValue: number | null;
  discountReason: string | null;
  discountApprovedBy: string | null;
  machineSubtotalCents: number | null;
  discountCents: number | null;
  fixedTotalCents: number | null;
  sentAt: string | null;
  expiresAt: string | null;
  acceptedAt: string | null;
  changeNote: string | null;
  lineItems: OfferLineItemRow[];
  selections: { id: string; productId: string; role: 'free' | 'extra'; quantity: number }[];
}

export function lineKeyFor(item: OfferLineItemRow, productId?: string | null): string {
  if (item.kind === 'machine') return 'machine';
  if (item.kind === 'delivery') return 'delivery';
  return `extra:${productId ?? ''}`;
}

export function formatBerlin(value: string | null): string {
  if (value === null) return '–';
  return new Date(value).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
}
