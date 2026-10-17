/**
 * Phase 9: Abrechnungs- und Storno-Regeln (eine autoritative Implementierung
 * je Fachregel – CLAUDE.md). Reine Funktionen ohne Datenbank-/Framework-
 * Abhängigkeit; Geld ausschließlich als Integer-Cent, Prozentsätze als
 * ganze Prozentwerte (0/50/100). Keine Floating-Point-Geldrechnung.
 *
 * Fachregeln (Phase-9-Vorgabe §2–§20, §49–§52):
 * - Feste Basis (Maschinenmiete, Lieferung, Rabatt) aus dem eingefrorenen
 *   Buchungs-Snapshot; Early Return verändert die Miete nicht.
 * - Credits (Anzahlung, angewendete Kaution) dürfen den Betrag nie negativ
 *   machen: amount_due ≥ 0, Überzahlung separat.
 * - Storno: Kalendertage bis zum Eventdatum in Europe/Berlin; ≥15 Tage 0 %,
 *   7–14 Tage 50 %, 0–6 Tage 100 % (ein bereits vergangenes Eventdatum
 *   zählt wie 0 Tage). Basis = Summe der eingefrorenen REGULÄREN
 *   Maschinen-Listenpreise (standardUnitPriceCents × Menge der
 *   Maschinenpositionen). Rundung bei 50 %: kaufmännisch (half up) auf Cent.
 */
import { daysUntilEventBerlin } from './pricing.ts';

export type SettlementLineType =
  | 'machine_rental'
  | 'delivery'
  | 'purchase'
  | 'commission_consumption'
  | 'discount'
  | 'cleanup_fee'
  | 'damage_charge'
  | 'missing_item_charge'
  | 'late_fee'
  | 'manual_charge'
  | 'advance_payment_credit'
  | 'deposit_applied_credit';

/** Feste Buchungsbasis (aus dem akzeptierten Snapshot). */
export const SETTLEMENT_FIXED_LINE_TYPES: readonly SettlementLineType[] = [
  'machine_rental',
  'delivery',
];
/** Variable Positionen aus Ausgabe-/Rückgabefakten (Phase 6/7). */
export const SETTLEMENT_VARIABLE_LINE_TYPES: readonly SettlementLineType[] = [
  'purchase',
  'commission_consumption',
  'cleanup_fee',
];
/** Nachbelastungen (menschliche Entscheidung, Phase 9). */
export const SETTLEMENT_CHARGE_LINE_TYPES: readonly SettlementLineType[] = [
  'damage_charge',
  'missing_item_charge',
  'late_fee',
  'manual_charge',
];
/** Credits – die einzigen erlaubten „negativen“ Mechanismen. */
export const SETTLEMENT_CREDIT_LINE_TYPES: readonly SettlementLineType[] = [
  'advance_payment_credit',
  'deposit_applied_credit',
];

export interface SettlementTotalsInput {
  type: SettlementLineType;
  /** Immer ≥ 0 – das Vorzeichen ergibt sich ausschließlich aus dem Typ. */
  amountCents: number;
}

export interface SettlementTotals {
  /** Miete + Lieferung − Rabatt (nie < 0). */
  fixedTotalCents: number;
  /** Kaufartikel + Kommissionsverbrauch + Reinigungsgebühren. */
  variableTotalCents: number;
  /** Schaden/Fehlteil/Verspätung/manuelle Nachbelastung. */
  chargesTotalCents: number;
  /** Rabatt (Information; bereits in fixedTotalCents verrechnet). */
  discountCents: number;
  /** Anzahlungen + angewendete Kaution. */
  creditsTotalCents: number;
  /** Belastung vor Credits. */
  grossTotalCents: number;
  /** Final übertragbarer Betrag (≥ 0). */
  amountDueCents: number;
  /** Credits über der Belastung – separat, keine negative Rechnung. */
  overpaymentCents: number;
}

export class SettlementRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementRuleError';
  }
}

function assertCents(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new SettlementRuleError(
      `${label}: Betrag muss ein nicht-negativer Integer-Cent-Wert sein.`,
    );
  }
}

/** Summen über typisierte Positionen – exakte Integer-Arithmetik. */
export function computeSettlementTotals(lines: readonly SettlementTotalsInput[]): SettlementTotals {
  let fixed = 0;
  let discount = 0;
  let variable = 0;
  let charges = 0;
  let credits = 0;
  for (const line of lines) {
    assertCents(line.amountCents, line.type);
    if (line.type === 'discount') discount += line.amountCents;
    else if (SETTLEMENT_FIXED_LINE_TYPES.includes(line.type)) fixed += line.amountCents;
    else if (SETTLEMENT_VARIABLE_LINE_TYPES.includes(line.type)) variable += line.amountCents;
    else if (SETTLEMENT_CHARGE_LINE_TYPES.includes(line.type)) charges += line.amountCents;
    else if (SETTLEMENT_CREDIT_LINE_TYPES.includes(line.type)) credits += line.amountCents;
    else throw new SettlementRuleError(`Unbekannter Positionstyp: ${String(line.type)}`);
  }
  const fixedTotalCents = Math.max(0, fixed - discount);
  const grossTotalCents = fixedTotalCents + variable + charges;
  const amountDueCents = Math.max(0, grossTotalCents - credits);
  const overpaymentCents = Math.max(0, credits - grossTotalCents);
  return {
    fixedTotalCents,
    variableTotalCents: variable,
    chargesTotalCents: charges,
    discountCents: discount,
    creditsTotalCents: credits,
    grossTotalCents,
    amountDueCents,
    overpaymentCents,
  };
}

/** Kommissionsregel (§8): chargeable = issued − returned unopened (nie < 0, nie > issued). */
export function commissionChargeableQuantity(issued: number, returnedUnopened: number): number {
  if (
    !Number.isInteger(issued) ||
    !Number.isInteger(returnedUnopened) ||
    issued < 0 ||
    returnedUnopened < 0
  ) {
    throw new SettlementRuleError('Kommissionsmengen müssen nicht-negative Ganzzahlen sein.');
  }
  return Math.max(0, issued - Math.min(issued, returnedUnopened));
}

/** 24-Stunden-Wartefenster nach Versand der Kundeninformation (§33). */
export const CUSTOMER_NOTICE_WAIT_HOURS = 24;

export function customerNoticeWaitUntil(sentAt: Date): Date {
  return new Date(sentAt.getTime() + CUSTOMER_NOTICE_WAIT_HOURS * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Storno (§49–§52)
// ---------------------------------------------------------------------------

export type CancellationFeePercent = 0 | 50 | 100;

export const CANCELLATION_FREE_MIN_DAYS = 15;
export const CANCELLATION_HALF_MIN_DAYS = 7;

/** Verbleibende Kalendertage (Europe/Berlin) vom Stornotag bis zum Eventdatum. */
export function cancellationRemainingDays(eventDateIso: string, cancelledAt: Date): number {
  return daysUntilEventBerlin(eventDateIso, cancelledAt);
}

/** ≥15 Tage 0 %; 7–14 Tage 50 %; 0–6 Tage (und vergangen) 100 %. */
export function cancellationFeePercent(remainingDays: number): CancellationFeePercent {
  if (!Number.isInteger(remainingDays)) {
    throw new SettlementRuleError('Verbleibende Tage müssen ganzzahlig sein.');
  }
  if (remainingDays >= CANCELLATION_FREE_MIN_DAYS) return 0;
  if (remainingDays >= CANCELLATION_HALF_MIN_DAYS) return 50;
  return 100;
}

export interface CancellationBaseItem {
  kind: string;
  quantity: number;
  standardUnitPriceCents: number;
}

/**
 * Stornobasis (§51): ausschließlich die eingefrorenen REGULÄREN Listenpreise
 * der Maschinenpositionen. Rabatt, Sonderpreis (agreedUnitPriceCents),
 * Lieferung, Kaufartikel, Kommission, Extras bleiben außen vor.
 */
export function cancellationBaseCents(items: readonly CancellationBaseItem[]): number {
  let base = 0;
  for (const item of items) {
    if (item.kind !== 'machine') continue;
    if (!Number.isInteger(item.quantity) || item.quantity < 0) {
      throw new SettlementRuleError('Maschinenmenge muss eine nicht-negative Ganzzahl sein.');
    }
    assertCents(item.standardUnitPriceCents, 'Regulärer Maschinenpreis');
    base += item.standardUnitPriceCents * item.quantity;
  }
  return base;
}

export const CANCELLATION_ROUNDING_METHOD = 'half_up' as const;

/**
 * Gebühr = Basis × Satz / 100, kaufmännisch auf ganze Cent gerundet
 * (half up: 0,5 Cent → aufrunden). Reine Integer-Arithmetik.
 */
export function cancellationFeeCents(baseCents: number, percent: CancellationFeePercent): number {
  assertCents(baseCents, 'Stornobasis');
  return Math.floor((baseCents * percent + 50) / 100);
}

export interface CancellationCalculation {
  eventDate: string;
  remainingDays: number;
  feePercent: CancellationFeePercent;
  baseCents: number;
  feeCents: number;
  roundingMethod: typeof CANCELLATION_ROUNDING_METHOD;
}

export function calculateCancellation(input: {
  eventDate: string;
  cancelledAt: Date;
  items: readonly CancellationBaseItem[];
}): CancellationCalculation {
  const remainingDays = cancellationRemainingDays(input.eventDate, input.cancelledAt);
  const feePercent = cancellationFeePercent(remainingDays);
  const baseCents = cancellationBaseCents(input.items);
  return {
    eventDate: input.eventDate,
    remainingDays,
    feePercent,
    baseCents,
    feeCents: cancellationFeeCents(baseCents, feePercent),
    roundingMethod: CANCELLATION_ROUNDING_METHOD,
  };
}

/** Kundenzeile der Storno-Buchhaltungsübertragung (§58). */
export function cancellationChargeDescription(processNumber: string): string {
  return `Stornokosten gemäß Mietbedingungen – Vorgang ${processNumber}`;
}
