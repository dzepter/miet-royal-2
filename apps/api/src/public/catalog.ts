import {
  inquiryOccasion,
  products,
  type DatabaseExecutor,
  type Product,
} from '@mietroyal/database';
import {
  CANISTER_SLUG,
  CANISTERS_PER_CONTAINER_LIMIT,
  CUPS_PACK_SLUG,
  FREE_CUPS_PER_RENTAL,
  FREE_STRAWS_PER_RENTAL,
  FREE_SYRUP_LITERS_PER_CONTAINER,
  LARGE_EVENT_GUEST_THRESHOLD,
  STRAWS_PACK_SLUG,
} from '@mietroyal/domain';
import {
  containsExactAddress,
  containsPriceText,
  exactAddressFragments,
} from '@mietroyal/validation/cms';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  PICKUP_EXACT_ADDRESS_KEY,
  PICKUP_PUBLIC_AREA_DEFAULT,
  PICKUP_PUBLIC_AREA_KEY,
  getStringSetting,
} from '../crm/settings-service.ts';
import { AuthError } from '../auth/service.ts';
import { effectivePriceCentsAt } from '../commerce/product-service.ts';

/**
 * Phase 16 (Fundament, Design §3.1; Eigentümer PUBLIC): EINZIGE öffentliche Projektion
 * von Produkten und Preisen. Genutzt von `GET /public/configurator/catalog` (PUBLIC),
 * `GET /staff/cms/catalog` und der Auflösung von `product_grid`-Blöcken (CMS).
 *
 * - nur AKTIVE Produkte; Preis = wirksamer Preis zum Zeitpunkt `now` (dieselbe Preisregel
 *   wie `ProductService.effectivePriceCents` ⇒ geplante Preise wirken ab `effective_from`);
 *   Produkte ohne wirksamen Preis werden weggelassen (nie 0 € erfinden);
 * - keine IDs, kein Bestand, keine Historie, keine internen Felder;
 * - Abholung nur als öffentliche Region – nie die exakte Adresse; Produktname mit der exakten
 *   Adresse ⇒ Produkt entfällt, Beschreibung mit ihr ⇒ `description: null` (Review pricing-3,
 *   Log nur mit Slug).
 * - Phase 17 (SEO, Order §23, Design D13): Preis-Freitext („60 €“, „EUR 60“, „60,-“) in der
 *   Beschreibung ⇒ `description: null`, im Namen ⇒ Produkt entfällt öffentlich (Katalog,
 *   product_grid, Konfigurator, Empfehlung) – Preis bleibt ausschließlich `priceCents` aus
 *   product_prices; Log `public.catalog.price_text_suppressed` nur mit Slug. Interne
 *   Produktdaten (Staff-Routen) bleiben unverändert.
 *
 * Konstanten (Gratis-Sirup je Behälter, 25 Becher/Strohhalme, Pack-Slugs, Kanisterlimit,
 * 250 Gäste) kommen ausschließlich aus packages/domain – keine zweite Wahrheit.
 * Phase 16 (PUBLIC): Preiszugriff über den Executor (Datenbank ODER Transaktion) ohne Cast.
 */

/** Phase 16 (PUBLIC): Alias der Domain-Konstante `CUPS_PACK_SLUG` (Export bleibt stabil). */
export const PUBLIC_CUPS_SLUG = CUPS_PACK_SLUG;
/** Phase 16 (PUBLIC): Alias der Domain-Konstante `STRAWS_PACK_SLUG` (Export bleibt stabil). */
export const PUBLIC_STRAWS_SLUG = STRAWS_PACK_SLUG;

export type PublicBillingMode = 'fixed' | 'commission';

export interface PublicProduct {
  slug: string;
  name: string;
  category: Product['category'];
  description: string | null;
  priceCents: number;
  billingMode: PublicBillingMode;
  unitLabel: string;
}

export interface PublicMachine extends PublicProduct {
  containerCount: number;
  containerVolumeLiters: number;
}

/** Phase 16 (PUBLIC): Anlass einer Anfrage (DB-Enum `inquiry_occasion`). */
export type InquiryOccasion = (typeof inquiryOccasion.enumValues)[number];

/**
 * Phase 16 (PUBLIC): deutsche Anlass-Bezeichnungen – 1:1 aus der Staff-App
 * (`apps/staff/lib/commerce.ts` OCCASION_LABELS, identisch in `apps/web/lib/portal.ts`).
 */
export const PUBLIC_OCCASION_LABELS: Readonly<Record<InquiryOccasion, string>> = {
  birthday: 'Geburtstag',
  wedding: 'Hochzeit',
  company_event: 'Firmenfeier',
  club: 'Verein',
  party: 'Party',
  school_kindergarten: 'Schule / Kindergarten',
  festival: 'Festival',
  other: 'Sonstiges',
};

export interface PublicOccasion {
  value: InquiryOccasion;
  label: string;
}

/** Phase 16 (PUBLIC): alle Anlässe in Enum-Reihenfolge mit deutscher Bezeichnung. */
export function publicOccasions(): PublicOccasion[] {
  return inquiryOccasion.enumValues.map((value) => ({
    value,
    label: PUBLIC_OCCASION_LABELS[value],
  }));
}

export interface PublicCatalog {
  asOf: string;
  machines: PublicMachine[];
  syrups: PublicProduct[];
  accessories: PublicProduct[];
  canister: (PublicProduct & { maxPerContainer: number }) | null;
  included: { freeSyrupLitersPerContainer: 1; cupsPerProcess: 25; strawsPerProcess: 25 };
  pickupArea: string;
  largeEventGuestThreshold: number;
  /** Phase 16 (PUBLIC): Anlässe für Schritt 1 des Konfigurators. */
  occasions: PublicOccasion[];
  priceNote: string;
}

export const PUBLIC_PRICE_NOTE =
  'Die Übersicht basiert auf den aktuell hinterlegten Preisen. Verbindlich wird der Preis erst mit deinem schriftlichen Angebot.';

/** Slush-Maschine = Kategorie machine mit gepflegten Behälterangaben (Order §4). */
export function isSlushMachineProduct(product: Product): boolean {
  return (
    product.category === 'machine' &&
    product.containerCount !== null &&
    product.containerCount > 0 &&
    product.containerVolumeLiters !== null &&
    Number(product.containerVolumeLiters) > 0
  );
}

function billingModeOf(product: Product): PublicBillingMode | null {
  // `included` ist keine öffentliche Abrechnungsart eines Katalogartikels.
  if (product.defaultBillingMode === 'fixed' || product.defaultBillingMode === 'commission') {
    return product.defaultBillingMode;
  }
  return null;
}

/**
 * Phase 16 (PUBLIC): wirksamer Preis eines Produkts zum Zeitpunkt `at` oder `null`
 * (kein Preis hinterlegt) – über den Executor, dieselbe Preisregel wie ProductService.
 */
export async function publicPriceCents(
  executor: DatabaseExecutor,
  productId: string,
  at: Date,
): Promise<number | null> {
  try {
    return await effectivePriceCentsAt(executor, productId, at);
  } catch (error) {
    // Ohne wirksamen Preis nie öffentlich (kein erfundener Preis); DB-Fehler laufen weiter.
    if (error instanceof AuthError) return null;
    throw error;
  }
}

/** Phase 16 (Review pricing-3): Logger für unterdrückte Produkttexte (nur Slug, nie Text). */
export interface PublicCatalogLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

/** Optionen der öffentlichen Produktprojektion. */
export interface PublicProjectionOptions {
  logger?: PublicCatalogLogger | undefined;
  /** Bereits geladene Prüffragmente der exakten Abholadresse (sonst einmal je Aufruf geladen). */
  fragments?: readonly string[] | undefined;
}

/** Prüffragmente der exakten Abholadresse (`pickup_exact_address`) – einmal je Request laden. */
export async function loadExactAddressFragments(executor: DatabaseExecutor): Promise<string[]> {
  return exactAddressFragments(await getStringSetting(executor, PICKUP_EXACT_ADDRESS_KEY));
}

/**
 * Phase 16 (Review pricing-3): Produktname mit der exakten Abholadresse ⇒ das Produkt ist
 * öffentlich nicht vorhanden (Katalog, product_grid, Konfigurator, Empfehlung).
 */
export function productNameRevealsExactAddress(
  product: Pick<Product, 'name'>,
  fragments: readonly string[],
): boolean {
  return containsExactAddress(product.name, fragments);
}

/**
 * Phase 17 (SEO, Design D13): Produktname mit Preis-Freitext ⇒ das Produkt ist öffentlich
 * nicht vorhanden (der Name würde eine zweite, stale Preisquelle neben `priceCents` werden).
 */
export function productNameContainsPrice(product: Pick<Product, 'name'>): boolean {
  return containsPriceText(product.name);
}

/**
 * Phase 17 (SEO): öffentlich ausgeblendetes Produkt – Name mit exakter Abholadresse ODER mit
 * Preis-Freitext (gemeinsame Regel für Katalog, Konfigurator-Auswahl und Empfehlung).
 */
export function productHiddenPublicly(
  product: Pick<Product, 'name'>,
  fragments: readonly string[],
): boolean {
  return productNameRevealsExactAddress(product, fragments) || productNameContainsPrice(product);
}

interface ProjectionGuard {
  fragments: readonly string[];
  logger: PublicCatalogLogger | undefined;
}

async function projectProduct(
  product: Product,
  now: Date,
  executor: DatabaseExecutor,
  guard: ProjectionGuard,
): Promise<PublicProduct | null> {
  const billingMode = billingModeOf(product);
  if (billingMode === null) return null;
  const priceCents = await publicPriceCents(executor, product.id, now);
  if (priceCents === null) return null;
  // Exakte Abholadresse nie öffentlich (Order §5): Name ⇒ Produkt entfällt, Beschreibung ⇒ null.
  if (productNameRevealsExactAddress(product, guard.fragments)) {
    guard.logger?.warn({ productSlug: product.slug }, 'public.catalog.exact_address_suppressed');
    return null;
  }
  // Phase 17 (SEO, D13): Preis-Freitext nie als zweite Preisquelle – Name ⇒ Produkt entfällt.
  if (productNameContainsPrice(product)) {
    guard.logger?.warn({ productSlug: product.slug }, 'public.catalog.price_text_suppressed');
    return null;
  }
  let description = product.description;
  if (description !== null && containsExactAddress(description, guard.fragments)) {
    guard.logger?.warn({ productSlug: product.slug }, 'public.catalog.exact_address_suppressed');
    description = null;
  }
  // Phase 17 (SEO, D13): Beschreibung mit Preisangabe ⇒ fail-closed ausblenden (Log nur Slug).
  if (description !== null && containsPriceText(description)) {
    guard.logger?.warn({ productSlug: product.slug }, 'public.catalog.price_text_suppressed');
    description = null;
  }
  return {
    slug: product.slug,
    name: product.name,
    category: product.category,
    description,
    priceCents,
    billingMode,
    unitLabel: product.saleUnit,
  };
}

async function projectionGuard(
  executor: DatabaseExecutor,
  options: PublicProjectionOptions,
): Promise<ProjectionGuard> {
  return {
    fragments: options.fragments ?? (await loadExactAddressFragments(executor)),
    logger: options.logger,
  };
}

/** Phase 16 (PUBLIC): alle AKTIVEN Produkte in Katalogreihenfolge (Grundlage für Katalog und Vorschau). */
export async function loadActiveProducts(executor: DatabaseExecutor): Promise<Product[]> {
  return executor
    .select()
    .from(products)
    .where(eq(products.active, true))
    .orderBy(asc(products.sortOrder), asc(products.name));
}

/**
 * Öffentliche Abholregion – fail-closed: enthält der gepflegte Wert die exakte Adresse
 * (oder ihren Straßenteil), wird der Default „Mainz-Hechtsheim“ ausgegeben.
 */
export async function publicPickupArea(
  executor: DatabaseExecutor,
  fragments?: readonly string[],
): Promise<string> {
  const area =
    (await getStringSetting(executor, PICKUP_PUBLIC_AREA_KEY)) ?? PICKUP_PUBLIC_AREA_DEFAULT;
  const checked = fragments ?? (await loadExactAddressFragments(executor));
  return containsExactAddress(area, checked) ? PICKUP_PUBLIC_AREA_DEFAULT : area;
}

export async function buildPublicCatalog(
  executor: DatabaseExecutor,
  now: Date,
  options: PublicProjectionOptions = {},
): Promise<PublicCatalog> {
  const guard = await projectionGuard(executor, options);
  const rows = await loadActiveProducts(executor);
  const machines: PublicMachine[] = [];
  const syrups: PublicProduct[] = [];
  const accessories: PublicProduct[] = [];
  let canister: PublicCatalog['canister'] = null;
  for (const product of rows) {
    const projected = await projectProduct(product, now, executor, guard);
    if (projected === null) continue;
    if (isSlushMachineProduct(product)) {
      machines.push({
        ...projected,
        containerCount: product.containerCount!,
        containerVolumeLiters: Number(product.containerVolumeLiters),
      });
    } else if (product.category === 'syrup') {
      syrups.push(projected);
    } else if (product.slug === CUPS_PACK_SLUG || product.slug === STRAWS_PACK_SLUG) {
      accessories.push(projected);
    } else if (product.slug === CANISTER_SLUG) {
      canister = { ...projected, maxPerContainer: CANISTERS_PER_CONTAINER_LIMIT };
    }
  }
  return {
    asOf: now.toISOString(),
    machines,
    syrups,
    accessories,
    canister,
    included: {
      freeSyrupLitersPerContainer: FREE_SYRUP_LITERS_PER_CONTAINER,
      cupsPerProcess: FREE_CUPS_PER_RENTAL,
      strawsPerProcess: FREE_STRAWS_PER_RENTAL,
    },
    pickupArea: await publicPickupArea(executor, guard.fragments),
    largeEventGuestThreshold: LARGE_EVENT_GUEST_THRESHOLD,
    occasions: publicOccasions(),
    priceNote: PUBLIC_PRICE_NOTE,
  };
}

/** Öffentliche Projektion ausgewählter Produkte (z. B. `product_grid.productSlugs`) – nur aktive, mit Preis. */
export async function buildPublicProducts(
  executor: DatabaseExecutor,
  slugs: readonly string[],
  now: Date,
  options: PublicProjectionOptions = {},
): Promise<PublicProduct[]> {
  if (slugs.length === 0) return [];
  const guard = await projectionGuard(executor, options);
  const rows = await executor
    .select()
    .from(products)
    .where(and(eq(products.active, true), inArray(products.slug, [...slugs])));
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  const out: PublicProduct[] = [];
  for (const slug of slugs) {
    const product = bySlug.get(slug);
    if (product === undefined) continue;
    const projected = await projectProduct(product, now, executor, guard);
    if (projected !== null) out.push(projected);
  }
  return out;
}
