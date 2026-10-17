import { createHash } from 'node:crypto';
import type { AccountingPayload, AccountingPayloadLine } from '../accounting/gateway.ts';
import {
  basisPointsToPercentage,
  centsToDecimalString,
  centsToLexwareAmount,
  grossFromNetCents,
} from './money.ts';
import {
  taxCategoryForLineType,
  type LexwareTaxType,
  type TaxCategory,
  type TaxCategoryConfig,
  type TaxConfigState,
} from './tax-config-service.ts';

/**
 * Reiner Aufbau der Lexware-Rechnung aus dem eingefrorenen Phase-9-Payload
 * (Vertrag §6, Order §§15/21–25/29/31/63). Keine I/O, keine Float-Rechnung:
 * Beträge bleiben Integer-Cent bis zur Serialisierung über money.ts.
 *
 * PREISBASIS (Entscheidung Vertrag §6, im Bericht als offener Punkt): Die
 * Phase-9-Beträge gelten als NETTO-Beträge der Abrechnung (Miet-Royal hat
 * bisher keine MwSt. ausgewiesen). taxType net ⇒ unitPrice.netAmount,
 * Lexware schlägt die Steuer auf; vatfree ⇒ Satz 0; gross ⇒
 * unitPrice.grossAmount (Preise gelten dann als Bruttopreise).
 *
 * Rabatt: eigene Position mit negativem Betrag und dem Steuersatz der
 * Maschinenmiete (Order §24/§25). Credits (Anzahlung/angewendete Kaution)
 * werden NICHT abgebildet ⇒ Blocker, kein Build (Order §26/§27).
 */

export const PROVIDER_SNAPSHOT_SCHEMA_VERSION = 2 as const;

export interface ProviderSnapshotLine {
  sourceLineId: string;
  sourceType: string;
  category: TaxCategory;
  description: string;
  quantity: number;
  unitName: string;
  /** Einzelpreis in Cent (netto bei net/vatfree, brutto bei gross); negativ beim Rabatt. */
  unitPriceCents: number;
  /** Positionsbetrag in Cent in der Preisbasis des taxType (negativ beim Rabatt). */
  amountCents: number;
  /** Netto-Cent der Position (bei gross aus dem Brutto abgeleitet). */
  netCents: number;
  taxRateBp: number;
  grossCents: number;
  lexwareIndex: number;
}

export interface ProviderSnapshotAddress {
  name: string;
  street: string | null;
  zip: string | null;
  city: string | null;
  countryCode: 'DE';
}

export interface ProviderSnapshotV2 {
  schemaVersion: typeof PROVIDER_SNAPSHOT_SCHEMA_VERSION;
  kind: AccountingPayload['kind'];
  processNumber: string;
  taxType: LexwareTaxType;
  taxConfigSnapshot: Partial<Record<TaxCategory, TaxCategoryConfig>>;
  address: ProviderSnapshotAddress;
  lines: ProviderSnapshotLine[];
  transferMarker: string;
  expectedGrossCents: number;
  expectedNetCents: number;
  /** Belegdatum `yyyy-MM-ddT00:00:00.000+XX:XX` (Europe/Berlin) – stabil für Retry/Recovery. */
  voucherDate: string;
  /** Leistungsdatum (Settlement: Eventdatum; Storno: Stornodatum) im selben Format. */
  shippingDate: string;
  createdAt: string;
}

export type PayloadBlockerCode =
  | 'ADVANCE_PAYMENT_UNSUPPORTED'
  | 'DEPOSIT_UNSUPPORTED'
  | 'LINE_TYPE_UNSUPPORTED'
  | 'TAX_CONFIG_INCOMPLETE'
  | 'PAYLOAD_TOTAL_MISMATCH';

export class InvoiceBuildError extends Error {
  constructor(
    readonly code: PayloadBlockerCode,
    message: string,
  ) {
    super(message);
    this.name = 'InvoiceBuildError';
  }
}

/** Stabiler, unaufdringlicher Marker (Order §31): `MRT-` + 10 Hex-Zeichen von sha256(idempotencyKey). */
export function transferMarkerFor(idempotencyKey: string): string {
  return `MRT-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 10).toUpperCase()}`;
}

/** UTC-Offset von Europe/Berlin zu einem Zeitpunkt, z. B. `+02:00`. */
export function berlinOffsetAt(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Berlin',
    timeZoneName: 'longOffset',
  }).formatToParts(at);
  const raw = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+01:00';
  const match = /GMT([+-]\d{2}:\d{2})?/.exec(raw);
  return match?.[1] ?? '+00:00';
}

/** `yyyy-MM-dd` (Berliner Kalendertag) → Lexware-Datumsformat `yyyy-MM-ddT00:00:00.000+XX:XX`. */
export function lexwareDateTimeFor(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new InvoiceBuildError('PAYLOAD_TOTAL_MISMATCH', 'Ungültiges Datum im Payload.');
  }
  const offset = berlinOffsetAt(new Date(`${isoDate}T12:00:00Z`));
  return `${isoDate}T00:00:00.000${offset}`;
}

export function berlinDateOf(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** Brutto-Cent → Netto-Cent bei Satz bp, kaufmännisch gerundet (Integer-Arithmetik). */
function netFromGrossCents(grossCents: number, taxRateBp: number): number {
  const denominator = 10_000 + taxRateBp;
  const sign = grossCents < 0 ? -1 : 1;
  const scaled = Math.abs(grossCents) * 10_000;
  return sign * Math.floor((scaled * 2 + denominator) / (denominator * 2));
}

function isCreditType(type: string): boolean {
  return type === 'advance_payment_credit' || type === 'deposit_applied_credit';
}

/**
 * Blocker eines Payloads gegen die Steuerkonfiguration – ohne externen
 * Aufruf. Reihenfolge: Credits (fail-closed) → unbekannte Typen → fehlende
 * Steuerbehandlung → Summenkonsistenz.
 */
export function payloadBlockers(
  payload: AccountingPayload,
  tax: Pick<TaxConfigState, 'taxType' | 'categories'>,
): PayloadBlockerCode[] {
  const codes = new Set<PayloadBlockerCode>();
  for (const line of payload.lines) {
    if (line.type === 'advance_payment_credit' && line.amountCents > 0) {
      codes.add('ADVANCE_PAYMENT_UNSUPPORTED');
      continue;
    }
    if (line.type === 'deposit_applied_credit' && line.amountCents > 0) {
      codes.add('DEPOSIT_UNSUPPORTED');
      continue;
    }
    if (isCreditType(line.type)) continue;
    const category = taxCategoryForLineType(line.type);
    if (category === null) {
      codes.add('LINE_TYPE_UNSUPPORTED');
      continue;
    }
    if (tax.categories[category] === undefined) codes.add('TAX_CONFIG_INCOMPLETE');
  }
  if (tax.taxType === null) codes.add('TAX_CONFIG_INCOMPLETE');
  if (payload.totals.creditsCents === 0 && !codes.has('LINE_TYPE_UNSUPPORTED')) {
    // Summe der abgebildeten Positionen muss dem eingefrorenen Endbetrag entsprechen.
    let sum = 0;
    for (const line of payload.lines) {
      if (isCreditType(line.type)) continue;
      sum += line.type === 'discount' ? -line.amountCents : line.amountCents;
    }
    if (sum !== payload.totals.amountDueCents) codes.add('PAYLOAD_TOTAL_MISMATCH');
  }
  return [...codes];
}

function lineQuantityAndUnit(line: AccountingPayloadLine): {
  quantity: number;
  unitPriceCents: number;
} {
  const quantity = Number.isInteger(line.quantity) ? line.quantity : 0;
  if (quantity > 0 && quantity * line.unitPriceCents === line.amountCents) {
    return { quantity, unitPriceCents: line.unitPriceCents };
  }
  return { quantity: 1, unitPriceCents: line.amountCents };
}

function trimText(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function euro(cents: number): string {
  return `${centsToDecimalString(cents).replace('.', ',')} €`;
}

function germanDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  return match === null ? isoDate : `${match[3]}.${match[2]}.${match[1]}`;
}

export interface BuildProviderSnapshotInput {
  payload: AccountingPayload;
  taxConfig: TaxConfigState;
  transferMarker: string;
  now: Date;
}

/** Provider-Snapshot v2 (eingefroren beim ersten Transferversuch). Wirft InvoiceBuildError bei Blockern. */
export function buildProviderSnapshot(input: BuildProviderSnapshotInput): ProviderSnapshotV2 {
  const { payload, taxConfig, transferMarker, now } = input;
  const blockers = payloadBlockers(payload, taxConfig);
  const first = blockers[0];
  if (first !== undefined) {
    throw new InvoiceBuildError(first, 'Payload kann nicht an Lexware übertragen werden.');
  }
  const taxType = taxConfig.taxType;
  if (taxType === null) throw new InvoiceBuildError('TAX_CONFIG_INCOMPLETE', 'taxType fehlt.');
  const lines: ProviderSnapshotLine[] = [];
  const usedCategories: Partial<Record<TaxCategory, TaxCategoryConfig>> = {};
  let expectedGrossCents = 0;
  let expectedNetCents = 0;
  for (const line of payload.lines) {
    if (isCreditType(line.type)) continue;
    const category = taxCategoryForLineType(line.type);
    const config = category === null ? undefined : taxConfig.categories[category];
    if (category === null || config === undefined) {
      throw new InvoiceBuildError('TAX_CONFIG_INCOMPLETE', 'Steuerbehandlung fehlt.');
    }
    usedCategories[category] = config;
    const taxRateBp =
      taxType === 'vatfree' || config.treatment === 'vatfree' ? 0 : config.taxRateBp;
    const sign = line.type === 'discount' ? -1 : 1;
    const { quantity, unitPriceCents } = lineQuantityAndUnit(line);
    const amountCents = sign * line.amountCents;
    const netCents = taxType === 'gross' ? netFromGrossCents(amountCents, taxRateBp) : amountCents;
    const grossCents =
      taxType === 'gross' ? amountCents : grossFromNetCents(amountCents, taxRateBp);
    expectedGrossCents += grossCents;
    expectedNetCents += netCents;
    lines.push({
      sourceLineId: line.id,
      sourceType: line.type,
      category,
      description: trimText(line.description, 255),
      quantity,
      unitName: trimText(line.unit === '' ? 'Stück' : line.unit, 64),
      unitPriceCents: sign * unitPriceCents,
      amountCents,
      netCents,
      taxRateBp,
      grossCents,
      lexwareIndex: lines.length,
    });
  }
  if (lines.length === 0) {
    throw new InvoiceBuildError('PAYLOAD_TOTAL_MISMATCH', 'Keine übertragbaren Positionen.');
  }
  // Steuer je Steuersatz-Gruppe auf die SUMME der Nettobeträge (übliche
  // Belegrechnung; vermeidet Rundungsdrift bei negativen Rabattpositionen).
  // Die exakte Lexware-Rundung ist nicht dokumentiert – Abweichungen führen
  // zur Summenprüfung (attention), nie zu stiller Anpassung.
  if (taxType !== 'gross') {
    const netByRate = new Map<number, number>();
    for (const line of lines) {
      netByRate.set(line.taxRateBp, (netByRate.get(line.taxRateBp) ?? 0) + line.netCents);
    }
    expectedGrossCents = 0;
    for (const [rateBp, groupNet] of netByRate) {
      expectedGrossCents += grossFromNetCents(groupNet, rateBp);
    }
  }
  const customer = payload.customer;
  const shippingIsoDate =
    payload.kind === 'cancellation' ? berlinDateOf(new Date(payload.createdAt)) : payload.eventDate;
  return {
    schemaVersion: PROVIDER_SNAPSHOT_SCHEMA_VERSION,
    kind: payload.kind,
    processNumber: payload.processNumber,
    taxType,
    taxConfigSnapshot: usedCategories,
    address: {
      name: trimText(customer.companyName ?? customer.displayName, 255),
      street: customer.billingAddress.street,
      zip: customer.billingAddress.postalCode,
      city: customer.billingAddress.city,
      countryCode: 'DE',
    },
    lines,
    transferMarker,
    expectedGrossCents,
    expectedNetCents,
    voucherDate: lexwareDateTimeFor(berlinDateOf(now)),
    shippingDate: lexwareDateTimeFor(shippingIsoDate),
    createdAt: now.toISOString(),
  };
}

/** Rechnungs-Body (Felder laut docs/LEXWARE_API_NOTES.md) aus Snapshot + Kontakt-ID. */
export function buildInvoiceBody(
  snapshot: ProviderSnapshotV2,
  payload: AccountingPayload,
  lexwareContactId: string,
): Record<string, unknown> {
  const address: Record<string, unknown> = {
    contactId: lexwareContactId,
    name: snapshot.address.name,
    countryCode: snapshot.address.countryCode,
  };
  if (snapshot.address.street !== null) address.street = snapshot.address.street;
  if (snapshot.address.zip !== null) address.zip = snapshot.address.zip;
  if (snapshot.address.city !== null) address.city = snapshot.address.city;

  const lineItems = snapshot.lines.map((line) => ({
    type: 'custom',
    name: line.description,
    quantity: line.quantity,
    unitName: line.unitName,
    unitPrice: {
      currency: 'EUR',
      ...(snapshot.taxType === 'gross'
        ? { grossAmount: centsToLexwareAmount(line.unitPriceCents) }
        : { netAmount: centsToLexwareAmount(line.unitPriceCents) }),
      taxRatePercentage: basisPointsToPercentage(line.taxRateBp),
    },
  }));

  const processNumber = snapshot.processNumber;
  const introduction =
    payload.kind === 'cancellation'
      ? `Stornokosten gemäß Mietbedingungen – Vorgang ${processNumber}` +
        (payload.cancellation === undefined
          ? ''
          : ` (Veranstaltung am ${germanDate(payload.cancellation.originalEventDate)}, ` +
            `${payload.cancellation.feePercent} % von ${euro(payload.cancellation.regularMachinePriceCents)})`)
      : `Abrechnung zum Vorgang ${processNumber}` +
        (payload.eventDate === '' ? '' : ` – Veranstaltung am ${germanDate(payload.eventDate)}`);

  return {
    voucherDate: snapshot.voucherDate,
    address,
    lineItems,
    totalPrice: { currency: 'EUR' },
    taxConditions: { taxType: snapshot.taxType },
    shippingConditions: { shippingType: 'service', shippingDate: snapshot.shippingDate },
    title: payload.kind === 'cancellation' ? 'Stornokosten' : 'Rechnung',
    introduction,
    remark: `Miet-Royal Vorgang ${processNumber} · MR-Transfer: ${snapshot.transferMarker}`,
  };
}

export interface BuildLexwareInvoiceInput {
  payload: AccountingPayload;
  taxConfig: TaxConfigState;
  lexwareContactId: string;
  transferMarker: string;
  now?: Date;
}

/** Komplettaufbau (Vertrag §6): Snapshot v2 + Body + erwartete Summen. */
export function buildLexwareInvoice(input: BuildLexwareInvoiceInput): {
  body: Record<string, unknown>;
  expectedGrossCents: number;
  expectedNetCents: number;
  providerSnapshot: ProviderSnapshotV2;
} {
  const providerSnapshot = buildProviderSnapshot({
    payload: input.payload,
    taxConfig: input.taxConfig,
    transferMarker: input.transferMarker,
    now: input.now ?? new Date(),
  });
  return {
    body: buildInvoiceBody(providerSnapshot, input.payload, input.lexwareContactId),
    expectedGrossCents: providerSnapshot.expectedGrossCents,
    expectedNetCents: providerSnapshot.expectedNetCents,
    providerSnapshot,
  };
}

export function isProviderSnapshotV2(value: unknown): value is ProviderSnapshotV2 {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { schemaVersion?: unknown }).schemaVersion === PROVIDER_SNAPSHOT_SCHEMA_VERSION &&
    Array.isArray((value as { lines?: unknown }).lines) &&
    typeof (value as { transferMarker?: unknown }).transferMarker === 'string'
  );
}

/** Kanonische Serialisierung (sortierte Schlüssel) – jsonb gibt Schlüssel in anderer Reihenfolge zurück. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Hash über die kanonische Form – stabil über das Speichern in jsonb hinweg. */
export function hashProviderSnapshot(snapshot: ProviderSnapshotV2): string {
  return createHash('sha256').update(stableStringify(snapshot)).digest('hex');
}

/** Enthält der Beleg-Remark den Marker (Recovery-Match)? */
export function remarkContainsMarker(remark: string | undefined, marker: string): boolean {
  return remark !== undefined && remark.includes(`MR-Transfer: ${marker}`);
}
