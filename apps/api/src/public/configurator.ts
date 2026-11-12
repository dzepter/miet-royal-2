import type { DatabaseExecutor, Product } from '@mietroyal/database';
import {
  CANISTER_SLUG,
  CUPS_PACK_SLUG,
  LARGE_EVENT_GUEST_THRESHOLD,
  PricingError,
  STRAWS_PACK_SLUG,
  canisterLimitFor,
  freeSyrupBudgetFor,
  priceOffer,
  resolvePricingInput,
  type PricingErrorCode,
  type PricingInput,
  type PricingProduct,
  type PricingProductResolver,
  type PricingResult,
  type PricingSelectionRequest,
} from '@mietroyal/domain';
import { recommendMachineSlug } from '@mietroyal/validation/cms';
import { AuthError } from '../auth/service.ts';
import type { ProductService } from '../commerce/product-service.ts';
import { loadPublishedSiteSettings } from '../cms/published-content.ts';
import {
  isSlushMachineProduct,
  loadActiveProducts,
  loadExactAddressFragments,
  productHiddenPublicly,
  publicPriceCents,
  PUBLIC_PRICE_NOTE,
} from './catalog.ts';

/**
 * Phase 16 (PUBLIC, Design §3.2): Auswahl des öffentlichen Konfigurators auflösen und
 * über die ZENTRALE Preisengine berechnen. Der Browser rechnet nie Geld; Preis- und
 * Mengenregeln (Gratis-Sirup je Behälter, 25 Becher + 25 Strohhalme einmal je
 * Mietvorgang, Kommission, Kanisterlimit) entscheidet ausschließlich `priceOffer`
 * (über `resolvePricingInput`). Hier wird nur aufgelöst, welche öffentlich wählbaren
 * Produkte (aktiv, mit wirksamem Preis, Maschinen nur Slush-Maschinen) gemeint sind.
 *
 * Genutzt von der Vorschau (`buildConfiguratorPreview`, Verstöße als Hinweise) und von
 * der Website-Anfrage (`website-inquiry.ts`, Verstöße ⇒ 400) – in beiden Fällen über
 * EINEN Executor (Anfrage: innerhalb der Transaktion, kein zweiter Pool-Zugriff).
 */

export interface ConfiguratorSyrupEntry {
  slug: string;
  liters: number;
}

export interface ConfiguratorSelection {
  machineSlug: string | null;
  syrups: { free: readonly ConfiguratorSyrupEntry[]; extra: readonly ConfiguratorSyrupEntry[] };
  extras: { cups25: number; straws25: number };
  canisters: number;
  fulfillment: 'pickup' | 'delivery';
}

/** Hinweis zur Auswahl; `path` = Feldpfad im Request-Body (ohne Werte). */
export interface ConfiguratorIssue {
  code: string;
  message: string;
  path: string;
}

export interface ResolvedConfiguratorSelection {
  /** Gewählte, öffentlich wählbare Slush-Maschine (oder null). */
  machine: Product | null;
  /** Aufgelöste Produkte der gültigen Auswahl je Slug (wirksamer Preis zum Zeitpunkt `now`). */
  pricingProducts: ReadonlyMap<string, PricingProduct>;
  /** Fachliche Auswahl mit Slug-Referenzen – nur gültige Positionen, zusammengefasst je Sorte. */
  request: PricingSelectionRequest<string>;
  resolver: PricingProductResolver<string>;
  /** Summe der angefragten Gratis-Liter (gültige Sorten). */
  requestedFreeLiters: number;
  issues: ConfiguratorIssue[];
}

export const RECOMMENDATION_FALLBACK_MESSAGE =
  'Wir prüfen persönlich, welche Maschine am besten zu deinem Event passt.';
export const DELIVERY_PREVIEW_TEXT = 'Lieferung wird individuell geprüft und angeboten.';
export const UNASSIGNED_SYRUP_LABEL = 'Sorte später abstimmen';

const MESSAGES = {
  MACHINE_UNAVAILABLE: 'Diese Maschine ist gerade nicht wählbar. Bitte wähle eine andere.',
  SYRUP_UNAVAILABLE: 'Diese Sirupsorte ist gerade nicht wählbar.',
  ACCESSORY_UNAVAILABLE: 'Dieser Artikel ist gerade nicht wählbar.',
  PRICING_INVALID: 'Die Auswahl kann so nicht berechnet werden.',
} as const;

/** Mengen je Slug zusammenfassen (Reihenfolge des ersten Auftretens), 0 entfällt. */
function mergeEntries(
  entries: readonly ConfiguratorSyrupEntry[],
): Array<{ slug: string; liters: number; index: number }> {
  const merged = new Map<string, { slug: string; liters: number; index: number }>();
  entries.forEach((entry, index) => {
    if (entry.liters <= 0) return;
    const existing = merged.get(entry.slug);
    if (existing === undefined) merged.set(entry.slug, { ...entry, index });
    else existing.liters += entry.liters;
  });
  return [...merged.values()];
}

/**
 * Öffentlich wählbare (aktive) Produkte je Slug – ohne Produkte, deren Name oder
 * Verkaufseinheit (Review RC-1) die exakte Abholadresse (Review pricing-3) oder einen
 * Preis-Freitext (Phase 17, Design D13) enthält: sie existieren öffentlich nicht – wie im Katalog.
 */
async function publicActiveProducts(
  executor: DatabaseExecutor,
  fragments: readonly string[],
): Promise<Product[]> {
  return (await loadActiveProducts(executor)).filter(
    (product) => !productHiddenPublicly(product, fragments),
  );
}

/**
 * Löst die Auswahl auf: nur AKTIVE Produkte mit wirksamem Preis zum Zeitpunkt `now`;
 * Maschinen nur über `isSlushMachineProduct`. Nicht wählbare Positionen werden nicht
 * berechnet, sondern als Hinweis (mit Feldpfad) gemeldet. `options.fragments` = bereits
 * geladene Prüffragmente der exakten Abholadresse (sonst hier einmal geladen).
 */
export async function resolveConfiguratorSelection(
  executor: DatabaseExecutor,
  productService: ProductService,
  selection: ConfiguratorSelection,
  now: Date,
  options: { fragments?: readonly string[] } = {},
): Promise<ResolvedConfiguratorSelection> {
  const fragments = options.fragments ?? (await loadExactAddressFragments(executor));
  const activeBySlug = new Map(
    (await publicActiveProducts(executor, fragments)).map((p) => [p.slug, p]),
  );
  const pricingProducts = new Map<string, PricingProduct>();
  const issues: ConfiguratorIssue[] = [];

  const available = async (
    slug: string,
    accepts: (product: Product) => boolean,
  ): Promise<PricingProduct | null> => {
    // Review pricing-4: Kategorie IMMER vor dem Cache prüfen – sonst gälte z. B. die bereits
    // aufgelöste Maschine auch als Sirup (falscher Feldpfad, leere Übersicht).
    const product = activeBySlug.get(slug);
    if (product === undefined || !accepts(product)) return null;
    const cached = pricingProducts.get(slug);
    if (cached !== undefined) return cached;
    let pricing: PricingProduct;
    try {
      pricing = await productService.pricingProductBySlug(slug, now, executor);
    } catch (error) {
      // Ohne wirksamen Preis nie wählbar (kein erfundener Preis) – wie im Katalog.
      if (error instanceof AuthError) return null;
      throw error;
    }
    pricingProducts.set(slug, pricing);
    return pricing;
  };

  let machine: Product | null = null;
  if (selection.machineSlug !== null) {
    if ((await available(selection.machineSlug, isSlushMachineProduct)) === null) {
      issues.push({
        code: 'MACHINE_UNAVAILABLE',
        message: MESSAGES.MACHINE_UNAVAILABLE,
        path: 'machineSlug',
      });
    } else {
      machine = activeBySlug.get(selection.machineSlug) ?? null;
    }
  }

  const selections: Array<{ ref: string; role: 'free' | 'extra'; quantity: number }> = [];
  let requestedFreeLiters = 0;
  for (const role of ['free', 'extra'] as const) {
    for (const entry of mergeEntries(selection.syrups[role])) {
      if ((await available(entry.slug, (product) => product.category === 'syrup')) === null) {
        issues.push({
          code: 'SYRUP_UNAVAILABLE',
          message: MESSAGES.SYRUP_UNAVAILABLE,
          path: `syrups.${role}.${entry.index}.slug`,
        });
        continue;
      }
      if (role === 'free') requestedFreeLiters += entry.liters;
      selections.push({ ref: entry.slug, role, quantity: entry.liters });
    }
  }
  const extras: Array<{ slug: string; quantity: number; path: string }> = [
    { slug: CUPS_PACK_SLUG, quantity: selection.extras.cups25, path: 'extras.cups25' },
    { slug: STRAWS_PACK_SLUG, quantity: selection.extras.straws25, path: 'extras.straws25' },
    { slug: CANISTER_SLUG, quantity: selection.canisters, path: 'canisters' },
  ];
  for (const extra of extras) {
    if (extra.quantity <= 0) continue;
    if ((await available(extra.slug, (product) => product.category !== 'machine')) === null) {
      issues.push({
        code: 'ACCESSORY_UNAVAILABLE',
        message: MESSAGES.ACCESSORY_UNAVAILABLE,
        path: extra.path,
      });
      continue;
    }
    selections.push({ ref: extra.slug, role: 'extra', quantity: extra.quantity });
  }

  const request: PricingSelectionRequest<string> = {
    machine: machine === null ? null : { ref: machine.slug, quantity: 1 },
    selections,
    fulfillment: selection.fulfillment,
  };
  const resolver: PricingProductResolver<string> = {
    product: async (slug) => {
      const product = pricingProducts.get(slug);
      if (product === undefined) throw new Error('Produkt der Auswahl nicht aufgelöst.');
      return product;
    },
    // Wie im Angebot: Inklusiv-Packs unabhängig von der Auswahl, fehlend ⇒ null; ein Pack,
    // dessen Name oder Verkaufseinheit die exakte Abholadresse oder einen Preis-Freitext
    // enthält, gilt öffentlich als fehlend (Review pricing-3, Phase 17 D13, Review RC-1).
    includedPack: async (slug) => {
      const pack =
        pricingProducts.get(slug) ??
        (await productService.pricingProductBySlug(slug, now, executor).catch(() => null));
      return pack !== null && productHiddenPublicly(pack, fragments) ? null : pack;
    },
  };
  return { machine, pricingProducts, request, resolver, requestedFreeLiters, issues };
}

/** Feldpfad eines Preisregel-Verstoßes (für 400-Antworten der Anfrage). */
export function pricingErrorPath(code: PricingErrorCode): string {
  if (code === 'FREE_SYRUP_BUDGET_EXCEEDED') return 'syrups.free';
  if (code === 'CANISTER_LIMIT_EXCEEDED') return 'canisters';
  return 'machineSlug';
}

/**
 * Vorschau-Berechnung: Verstöße gegen Kontingent/Kanisterlimit werden als Hinweis
 * gemeldet und die betroffene Position für die Übersicht weggelassen; die Regeln selbst
 * prüft ausschließlich `priceOffer`.
 */
function priceLeniently(input: PricingInput): {
  result: PricingResult | null;
  issues: ConfiguratorIssue[];
} {
  const issues: ConfiguratorIssue[] = [];
  let current = input;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return { result: priceOffer(current), issues };
    } catch (error) {
      if (!(error instanceof PricingError)) throw error;
      issues.push({ code: error.code, message: error.message, path: pricingErrorPath(error.code) });
      if (error.code === 'FREE_SYRUP_BUDGET_EXCEEDED') {
        current = { ...current, selections: current.selections.filter((s) => s.role !== 'free') };
      } else if (error.code === 'CANISTER_LIMIT_EXCEEDED') {
        current = {
          ...current,
          selections: current.selections.filter((s) => s.product.slug !== CANISTER_SLUG),
        };
      } else {
        return { result: null, issues };
      }
    }
  }
  return { result: null, issues };
}

export interface PublicConfiguratorPreview {
  recommendation: { machineSlug: string | null; message: string };
  largeEvent: boolean;
  quota: {
    freeSyrupLiters: number;
    assignedFreeLiters: number;
    unassignedFreeLiters: number;
    canisterMax: number;
  };
  fixed: Array<{ label: string; quantity: number; unitPriceCents: number; totalCents: number }>;
  fixedTotalCents: number;
  included: Array<{ label: string; quantity: number; unit: string }>;
  commission: Array<{ label: string; quantity: number; unitPriceCents: number; unit: string }>;
  delivery: { requested: boolean; text: string };
  issues: Array<{ code: string; message: string }>;
  priceNote: string;
}

export interface ConfiguratorPreviewInput {
  guests?: number | undefined;
  selection: ConfiguratorSelection;
}

/**
 * Empfehlung nur aus VERÖFFENTLICHTEN Regeln und nur für öffentlich wählbare Slush-Maschinen
 * mit Preis (Name mit exakter Abholadresse oder Preis-Freitext ⇒ nie empfohlen,
 * Review pricing-3 / Phase 17 D13 – ein solcher Name erscheint auch nicht im Empfehlungstext).
 */
async function recommendationFor(
  executor: DatabaseExecutor,
  guests: number | undefined,
  now: Date,
  fragments: readonly string[],
): Promise<PublicConfiguratorPreview['recommendation']> {
  const fallback = { machineSlug: null, message: RECOMMENDATION_FALLBACK_MESSAGE };
  if (guests === undefined) return fallback;
  const published = await loadPublishedSiteSettings(executor);
  const rules = published?.settings.recommendationRules ?? [];
  if (rules.length === 0) return fallback;
  const machines = (await publicActiveProducts(executor, fragments)).filter(isSlushMachineProduct);
  const selectable = new Map<string, Product>();
  for (const machine of machines) {
    if ((await publicPriceCents(executor, machine.id, now)) !== null) {
      selectable.set(machine.slug, machine);
    }
  }
  const slug = recommendMachineSlug(rules, guests, new Set(selectable.keys()));
  const machine = slug === null ? undefined : selectable.get(slug);
  if (slug === null || machine === undefined) return fallback;
  return {
    machineSlug: slug,
    message: `Unsere Empfehlung für deine Gästezahl: ${machine.name}. Du kannst jederzeit eine andere Maschine wählen.`,
  };
}

/** `POST /public/configurator/preview`: sichere, kundensichtbare Zusammenfassung. */
export async function buildConfiguratorPreview(
  executor: DatabaseExecutor,
  productService: ProductService,
  input: ConfiguratorPreviewInput,
  now: Date,
): Promise<PublicConfiguratorPreview> {
  const fragments = await loadExactAddressFragments(executor);
  const resolved = await resolveConfiguratorSelection(
    executor,
    productService,
    input.selection,
    now,
    { fragments },
  );
  const pricingInput = await resolvePricingInput(resolved.request, resolved.resolver);
  const priced = priceLeniently(pricingInput);
  const result = priced.result;

  const containers = resolved.machine?.containerCount ?? 0;
  const freeSyrupLiters = result?.freeSyrupBudgetLiters ?? freeSyrupBudgetFor(containers);
  const unassignedFreeLiters = Math.max(0, freeSyrupLiters - resolved.requestedFreeLiters);

  const lineItems = result?.lineItems ?? [];
  const fixed = lineItems
    .filter((item) => item.billingMode === 'fixed' && item.kind !== 'delivery')
    .map((item) => ({
      label: item.description,
      quantity: item.quantity,
      unitPriceCents: item.agreedUnitPriceCents,
      totalCents: item.totalCents,
    }));
  const included: PublicConfiguratorPreview['included'] = [];
  for (const item of lineItems) {
    if (item.billingMode === 'included' && item.kind === 'syrup') {
      included.push({ label: item.description, quantity: item.quantity, unit: 'L' });
    }
  }
  if (resolved.machine !== null && result !== null && unassignedFreeLiters > 0) {
    included.push({ label: UNASSIGNED_SYRUP_LABEL, quantity: unassignedFreeLiters, unit: 'L' });
  }
  for (const item of lineItems) {
    if (item.billingMode === 'included' && item.kind !== 'syrup') {
      included.push({ label: item.description, quantity: item.quantity, unit: item.unit });
    }
  }
  const commission = lineItems
    .filter((item) => item.billingMode === 'commission')
    .map((item) => ({
      label: item.description,
      quantity: item.quantity,
      unitPriceCents: item.agreedUnitPriceCents,
      unit: item.unit,
    }));

  const issues = [...resolved.issues, ...priced.issues].map(({ code, message }) => ({
    code,
    message: code === 'PRICING_INVALID' ? MESSAGES.PRICING_INVALID : message,
  }));

  return {
    recommendation: await recommendationFor(executor, input.guests, now, fragments),
    largeEvent: input.guests !== undefined && input.guests >= LARGE_EVENT_GUEST_THRESHOLD,
    quota: {
      freeSyrupLiters,
      assignedFreeLiters: resolved.requestedFreeLiters,
      unassignedFreeLiters,
      canisterMax: canisterLimitFor(containers),
    },
    fixed,
    fixedTotalCents: result?.fixedTotalCents ?? 0,
    included,
    commission,
    delivery: {
      requested: input.selection.fulfillment === 'delivery',
      text: DELIVERY_PREVIEW_TEXT,
    },
    issues,
    priceNote: PUBLIC_PRICE_NOTE,
  };
}
