/**
 * ZENTRALE, autoritative Angebots-Preisberechnung (Phase-3-Vorgabe Nr. 16;
 * CLAUDE.md „Eine autoritative Implementierung je Regel“).
 *
 * Pure Funktion ohne Datenbank-/Framework-Abhängigkeit: API, PDF und
 * Frontends zeigen ausschließlich das Ergebnis dieser Berechnung an.
 * Geld ausschließlich als Integer-Cent, Prozentwerte als Basispunkte
 * (10 % = 1000) – niemals Floating-Point-Geldrechnung.
 *
 * Fachregeln (MASTER_SPEC §4/§5, DOMAIN_RULES „Preise“/„Inklusiv“/„Rabatt“):
 * - 1 L Gratis-Sirup je gebuchtem Maschinenbehälter, frei auf Sorten verteilbar.
 * - 25 Becher + 25 Strohhalme einmal GRATIS pro Mietvorgang (nicht je Maschine).
 * - Zusätzlicher Sirup/Becher/Strohhalme: Kommission (Abrechnung nach
 *   tatsächlichem Verbrauch – Rückgabephase, hier nur Kennzeichnung).
 * - 6-L-Mischkanister: Kaufartikel, fest berechnet, max. 2 je Behälter.
 * - Lieferpreis: nur manuell vereinbart („individuell geprüft“).
 * - Manueller Rabatt (Prozent/EUR) auf den MASCHINENMIETEN-Subtotal;
 *   Gesamtbetrag nie unter 0.
 */

export type BillingMode = 'fixed' | 'commission' | 'included';
export type LineItemKind = 'machine' | 'syrup' | 'consumable' | 'purchase' | 'delivery';
export type PriceSource = 'list' | 'special' | 'manual' | 'included';

export interface PricingProduct {
  id: string;
  slug: string;
  name: string;
  category: 'machine' | 'syrup' | 'consumable' | 'purchase';
  saleUnit: string;
  defaultBillingMode: BillingMode;
  /** Wirksamer Listenpreis in Cent zum Berechnungszeitpunkt. */
  listPriceCents: number;
  containerCount?: number | null;
  containerVolumeLiters?: number | null;
  carryPersons?: number | null;
  weightGrams?: number | null;
}

export interface PricingSelection {
  product: PricingProduct;
  role: 'free' | 'extra';
  quantity: number;
}

export interface SpecialPriceEntry {
  /** Positionsschlüssel: "machine" oder "extra:<productId>" (kein "delivery" – der Lieferpreis ist manuell). */
  lineKey: string;
  unitPriceCents: number;
  previousStandardCents: number;
  byUserId: string;
  at: string;
}

export interface PricingInput {
  machine: { product: PricingProduct; quantity: number } | null;
  /** Becher-/Strohhalm-Produkte für die Inklusiv-Positionen (25+25 gratis). */
  cupsProduct?: PricingProduct | null;
  strawsProduct?: PricingProduct | null;
  selections: readonly PricingSelection[];
  fulfillment: 'pickup' | 'delivery';
  /** Manuell vereinbarter Lieferpreis (nur bei Lieferung, optional). */
  deliveryPriceCents?: number | null;
  discount?: { type: 'percent' | 'fixed'; value: number; reason?: string | null } | null;
  specialPrices?: readonly SpecialPriceEntry[];
}

export interface PricedLineItem {
  lineKey: string;
  kind: LineItemKind;
  billingMode: BillingMode;
  description: string;
  quantity: number;
  unit: string;
  standardUnitPriceCents: number;
  agreedUnitPriceCents: number;
  totalCents: number;
  priceSource: PriceSource;
  productId: string | null;
  productSnapshot: Record<string, unknown> | null;
  specialPriceBy: string | null;
  specialPriceAt: string | null;
}

export interface PricingResult {
  lineItems: PricedLineItem[];
  /** Maschinenmieten-Subtotal (Rabattbasis, §18). */
  machineSubtotalCents: number;
  /** Alle fest berechneten Positionen VOR Rabatt. */
  fixedSubtotalCents: number;
  discountCents: number;
  /** Effektiver Rabatt in Basispunkten gegen den Maschinen-Subtotal. */
  discountEffectiveBp: number;
  /** FESTER ANGEBOTSWERT (nach Rabatt, nie < 0 – erzwungen). */
  fixedTotalCents: number;
  /** Kommissionsartikel: möglicher Höchstwert bei vollem Verbrauch. */
  commissionMaxCents: number;
  /** Gratis-Sirup-Kontingent in Litern (Behälter × Maschinenanzahl). */
  freeSyrupBudgetLiters: number;
  notes: string[];
}

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingError';
  }
}

/** Max. 2 Kanister je gebuchtem Maschinenbehälter (Phase-3-Vorgabe Nr. 5). */
export const CANISTERS_PER_CONTAINER_LIMIT = 2;
/**
 * Die Max-2-je-Behälter-Regel (§5) gilt für den 6-L-Mischkanister – nicht
 * für beliebige künftige Kaufartikel (§6: keine Fachregeln verallgemeinern).
 */
export const CANISTER_SLUG = 'mischkanister-6l';
export const FREE_CUPS_PACKS_PER_RENTAL = 1;
export const FREE_STRAWS_PACKS_PER_RENTAL = 1;
export const LARGE_EVENT_GUEST_THRESHOLD = 250;
export const LARGE_EVENT_NOTE = 'Großveranstaltung – individuelles Angebot / persönliche Prüfung';

function snapshotOf(product: PricingProduct): Record<string, unknown> {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    category: product.category,
    saleUnit: product.saleUnit,
    listPriceCents: product.listPriceCents,
    containerCount: product.containerCount ?? null,
    containerVolumeLiters: product.containerVolumeLiters ?? null,
    carryPersons: product.carryPersons ?? null,
    weightGrams: product.weightGrams ?? null,
  };
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new PricingError(`${label} muss eine positive ganze Zahl sein.`);
  }
}

function assertNonNegativeCents(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new PricingError(`${label} muss ein nicht-negativer Cent-Betrag sein.`);
  }
}

/**
 * Rundung halbe-Cent-aufwärts, rein ganzzahlig (kein Float):
 * round(numerator / denominator).
 */
function divRound(numerator: number, denominator: number): number {
  return Math.floor((numerator + denominator / 2) / denominator);
}

export function priceOffer(input: PricingInput): PricingResult {
  const lineItems: PricedLineItem[] = [];
  const notes: string[] = [];
  const specials = new Map<string, SpecialPriceEntry>();
  for (const entry of input.specialPrices ?? []) {
    assertNonNegativeCents(entry.unitPriceCents, 'Sonderpreis');
    specials.set(entry.lineKey, entry);
  }

  const applySpecial = (
    lineKey: string,
    standardCents: number,
  ): { agreed: number; source: PriceSource; by: string | null; at: string | null } => {
    const special = specials.get(lineKey);
    if (special === undefined) {
      return { agreed: standardCents, source: 'list', by: null, at: null };
    }
    return {
      agreed: special.unitPriceCents,
      source: 'special',
      by: special.byUserId,
      at: special.at,
    };
  };

  // ── Maschine ─────────────────────────────────────────────────────────────
  let machineSubtotalCents = 0;
  let containersTotal = 0;
  if (input.machine !== null) {
    const { product, quantity } = input.machine;
    if (product.category !== 'machine') {
      throw new PricingError('Das gewählte Produkt ist kein Maschinentyp.');
    }
    assertPositiveInt(quantity, 'Maschinenanzahl');
    const containers = product.containerCount ?? 0;
    if (containers <= 0) {
      throw new PricingError('Der Maschinentyp hat keine Behälterangabe.');
    }
    containersTotal = containers * quantity;
    const { agreed, source, by, at } = applySpecial('machine', product.listPriceCents);
    machineSubtotalCents = agreed * quantity;
    lineItems.push({
      lineKey: 'machine',
      kind: 'machine',
      billingMode: 'fixed',
      description: `Slushmaschine ${product.name}`,
      quantity,
      unit: product.saleUnit,
      standardUnitPriceCents: product.listPriceCents,
      agreedUnitPriceCents: agreed,
      totalCents: machineSubtotalCents,
      priceSource: source,
      productId: product.id,
      productSnapshot: snapshotOf(product),
      specialPriceBy: by,
      specialPriceAt: at,
    });
  }

  // ── Gratis-Sirup (1 L je Behälter, frei auf Sorten verteilbar) ──────────
  const freeSyrupBudgetLiters = containersTotal;
  const freeSelections = input.selections.filter((s) => s.role === 'free');
  let freeLitersUsed = 0;
  for (const selection of freeSelections) {
    if (selection.product.category !== 'syrup') {
      throw new PricingError('Nur Sirup kann Teil des Gratis-Kontingents sein.');
    }
    assertPositiveInt(selection.quantity, 'Gratis-Sirup-Menge');
    freeLitersUsed += selection.quantity;
  }
  if (freeLitersUsed > freeSyrupBudgetLiters) {
    throw new PricingError(
      `Das Gratis-Sirup-Kontingent beträgt ${freeSyrupBudgetLiters} L (1 L je gebuchtem Behälter).`,
    );
  }
  for (const selection of freeSelections) {
    lineItems.push({
      lineKey: `free:${selection.product.id}`,
      kind: 'syrup',
      billingMode: 'included',
      description: `${selection.product.name} (inklusive)`,
      quantity: selection.quantity,
      unit: selection.product.saleUnit,
      standardUnitPriceCents: selection.product.listPriceCents,
      agreedUnitPriceCents: 0,
      totalCents: 0,
      priceSource: 'included',
      productId: selection.product.id,
      productSnapshot: snapshotOf(selection.product),
      specialPriceBy: null,
      specialPriceAt: null,
    });
  }

  // ── Inklusive Becher/Strohhalme (einmal PRO MIETVORGANG, nicht je
  // Maschine/Behälter) ─────────────────────────────────────────────────────
  if (input.machine !== null) {
    const included: {
      key: string;
      product: PricingProduct | null | undefined;
      packs: number;
      label: string;
    }[] = [
      {
        key: 'included:cups',
        product: input.cupsProduct,
        packs: FREE_CUPS_PACKS_PER_RENTAL,
        label: '25 Becher',
      },
      {
        key: 'included:straws',
        product: input.strawsProduct,
        packs: FREE_STRAWS_PACKS_PER_RENTAL,
        label: '25 Strohhalme',
      },
    ];
    for (const entry of included) {
      const product = entry.product ?? null;
      lineItems.push({
        lineKey: entry.key,
        kind: 'consumable',
        billingMode: 'included',
        description: `${entry.label} (inklusive, einmal pro Mietvorgang)`,
        quantity: entry.packs,
        unit: product?.saleUnit ?? '25er-Pack',
        standardUnitPriceCents: product?.listPriceCents ?? 0,
        agreedUnitPriceCents: 0,
        totalCents: 0,
        priceSource: 'included',
        productId: product?.id ?? null,
        productSnapshot: product === null ? null : snapshotOf(product),
        specialPriceBy: null,
        specialPriceAt: null,
      });
    }
  }

  // ── Zusatzartikel (Sirup/Becher/Strohhalme = Kommission, Kanister = Kauf) ─
  let fixedExtrasCents = 0;
  let commissionMaxCents = 0;
  let canisterCount = 0;
  for (const selection of input.selections) {
    if (selection.role !== 'extra') continue;
    const { product, quantity } = selection;
    assertPositiveInt(quantity, `Menge für ${product.name}`);
    if (product.category === 'machine') {
      throw new PricingError('Maschinen sind keine Zusatzartikel.');
    }
    if (product.slug === CANISTER_SLUG) {
      canisterCount += quantity;
    }
    const lineKey = `extra:${product.id}`;
    const { agreed, source, by, at } = applySpecial(lineKey, product.listPriceCents);
    const billing: BillingMode = product.defaultBillingMode;
    const totalCents = agreed * quantity;
    if (billing === 'commission') {
      commissionMaxCents += totalCents;
    } else {
      fixedExtrasCents += totalCents;
    }
    lineItems.push({
      lineKey,
      kind: product.category === 'purchase' ? 'purchase' : product.category,
      billingMode: billing,
      description:
        billing === 'commission'
          ? `${product.name} (Kommission – Abrechnung nach tatsächlichem Verbrauch)`
          : product.name,
      quantity,
      unit: product.saleUnit,
      standardUnitPriceCents: product.listPriceCents,
      agreedUnitPriceCents: agreed,
      totalCents,
      priceSource: source,
      productId: product.id,
      productSnapshot: snapshotOf(product),
      specialPriceBy: by,
      specialPriceAt: at,
    });
  }

  // Kanisterlimit ZENTRAL in der Domainlogik (nicht nur UI):
  const canisterLimit = containersTotal * CANISTERS_PER_CONTAINER_LIMIT;
  if (canisterCount > canisterLimit) {
    throw new PricingError(
      `Maximal ${canisterLimit} Mischkanister möglich (${CANISTERS_PER_CONTAINER_LIMIT} je gebuchtem Behälter).`,
    );
  }

  // ── Lieferung (nur manuell vereinbart, §15) ──────────────────────────────
  let deliveryCents = 0;
  if (
    input.fulfillment === 'delivery' &&
    input.deliveryPriceCents !== null &&
    input.deliveryPriceCents !== undefined
  ) {
    assertNonNegativeCents(input.deliveryPriceCents, 'Lieferpreis');
    deliveryCents = input.deliveryPriceCents;
    lineItems.push({
      lineKey: 'delivery',
      kind: 'delivery',
      billingMode: 'fixed',
      description: 'Lieferung und Abholung (Lieferpreis individuell geprüft)',
      quantity: 1,
      unit: 'pauschal',
      standardUnitPriceCents: deliveryCents,
      agreedUnitPriceCents: deliveryCents,
      totalCents: deliveryCents,
      priceSource: 'manual',
      productId: null,
      productSnapshot: null,
      specialPriceBy: null,
      specialPriceAt: null,
    });
  }

  // ── Rabatt auf den Maschinenmieten-Subtotal (§18) ────────────────────────
  const fixedSubtotalCents = machineSubtotalCents + fixedExtrasCents + deliveryCents;
  let discountCents = 0;
  let discountEffectiveBp = 0;
  if (input.discount !== null && input.discount !== undefined) {
    const { type, value } = input.discount;
    if (machineSubtotalCents <= 0) {
      throw new PricingError('Ein Rabatt benötigt eine Maschinenmiete als Basis.');
    }
    if (type === 'percent') {
      if (!Number.isInteger(value) || value <= 0 || value > 10000) {
        throw new PricingError('Der Prozent-Rabatt muss zwischen 0,01 % und 100 % liegen.');
      }
      discountEffectiveBp = value;
      discountCents = divRound(machineSubtotalCents * value, 10000);
    } else {
      assertNonNegativeCents(value, 'Rabattbetrag');
      if (value <= 0) throw new PricingError('Der Rabattbetrag muss größer als 0 sein.');
      discountCents = value;
      // Effektiver Prozentsatz GEGEN den Maschinen-Subtotal (aufgerundet,
      // damit Schwellen nie durch Abrunden unterlaufen werden):
      discountEffectiveBp = Math.ceil((value * 10000) / machineSubtotalCents);
    }
    if (discountCents > machineSubtotalCents) {
      throw new PricingError('Der Rabatt darf den Maschinenmieten-Subtotal nicht übersteigen.');
    }
  }

  const fixedTotalCents = fixedSubtotalCents - discountCents;
  if (fixedTotalCents < 0) {
    // Strukturell unmöglich (Rabatt ≤ Maschinen-Subtotal ≤ fixedSubtotal),
    // aber als harte Invariante abgesichert: Gesamtbetrag nie unter 0.
    throw new PricingError('Der Gesamtbetrag darf nicht unter 0 liegen.');
  }

  return {
    lineItems,
    machineSubtotalCents,
    fixedSubtotalCents,
    discountCents,
    discountEffectiveBp,
    fixedTotalCents,
    commissionMaxCents,
    freeSyrupBudgetLiters,
    notes,
  };
}

/**
 * Angebotsgültigkeit (Phase-3-Vorgabe Nr. 22, MASTER_SPEC §9):
 * Liegt das Event zum Versandzeitpunkt 14 Tage oder weniger entfernt →
 * 3 Tage gültig, sonst 7 Tage. Tagesdifferenz in Europe/Berlin.
 */
export const OFFER_VALIDITY_NEAR_DAYS = 3;
export const OFFER_VALIDITY_FAR_DAYS = 7;
export const OFFER_VALIDITY_THRESHOLD_DAYS = 14;

function berlinDateParts(date: Date): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [year, month, day] = formatter.format(date).split('-').map(Number);
  return { year: year ?? 0, month: month ?? 0, day: day ?? 0 };
}

/** Kalendertag-Differenz (eventDate ISO yyyy-mm-dd) minus Berlin-Tag von sentAt. */
export function daysUntilEventBerlin(eventDateIso: string, sentAt: Date): number {
  const [ey, em, ed] = eventDateIso.split('-').map(Number);
  const sent = berlinDateParts(sentAt);
  const eventUtc = Date.UTC(ey ?? 0, (em ?? 1) - 1, ed ?? 1);
  const sentUtc = Date.UTC(sent.year, sent.month - 1, sent.day);
  return Math.round((eventUtc - sentUtc) / 86_400_000);
}

export function offerValidityDays(eventDateIso: string, sentAt: Date): number {
  const days = daysUntilEventBerlin(eventDateIso, sentAt);
  return days <= OFFER_VALIDITY_THRESHOLD_DAYS ? OFFER_VALIDITY_NEAR_DAYS : OFFER_VALIDITY_FAR_DAYS;
}

export function offerExpiresAt(eventDateIso: string, sentAt: Date): Date {
  const days = offerValidityDays(eventDateIso, sentAt);
  return new Date(sentAt.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Rabatt-Schwellenregeln (§18/§19) – exakt, ohne Float:
 * bis einschließlich 10 %: kein Pflichtgrund; über 10 %: Grund Pflicht;
 * über 20 %: Freigabeberechtigung erforderlich.
 */
export const DISCOUNT_REASON_THRESHOLD_BP = 1000;
export const DISCOUNT_APPROVAL_THRESHOLD_BP = 2000;

export function discountNeedsReason(effectiveBp: number): boolean {
  return effectiveBp > DISCOUNT_REASON_THRESHOLD_BP;
}

export function discountNeedsApproval(effectiveBp: number): boolean {
  return effectiveBp > DISCOUNT_APPROVAL_THRESHOLD_BP;
}
