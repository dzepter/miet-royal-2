import { products, type DatabaseExecutor, type Product } from '@mietroyal/database';
import {
  CANISTER_SLUG,
  CANISTERS_PER_CONTAINER_LIMIT,
  LARGE_EVENT_GUEST_THRESHOLD,
} from '@mietroyal/domain';
import { containsExactAddress, exactAddressFragments } from '@mietroyal/validation/cms';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  PICKUP_EXACT_ADDRESS_KEY,
  PICKUP_PUBLIC_AREA_DEFAULT,
  PICKUP_PUBLIC_AREA_KEY,
  getStringSetting,
} from '../crm/settings-service.ts';
import { ProductService } from '../commerce/product-service.ts';

/**
 * Phase 16 (Fundament, Design §3.1): EINZIGE öffentliche Projektion von Produkten und
 * Preisen. Genutzt von `GET /public/configurator/catalog` (PUBLIC), `GET /staff/cms/catalog`
 * und der Auflösung von `product_grid`-Blöcken (CMS).
 *
 * - nur AKTIVE Produkte; Preis = wirksamer Preis zum Zeitpunkt `now`
 *   (`ProductService.effectivePriceCents` ⇒ geplante Preise wirken ab `effective_from`);
 *   Produkte ohne wirksamen Preis werden weggelassen (nie 0 € erfinden);
 * - keine IDs, kein Bestand, keine Historie, keine internen Felder;
 * - Abholung nur als öffentliche Region – nie die exakte Adresse.
 *
 * Konstanten (Gratis-Sirup je Behälter, 25 Becher/Strohhalme, Kanisterlimit, 250 Gäste)
 * kommen aus packages/domain. Die Slugs der Becher/Strohhalm-Packs hebt PUBLIC als
 * Domain-Konstanten an (heute noch in offer-service.ts hartkodiert).
 */

export const PUBLIC_CUPS_SLUG = 'becher-25';
export const PUBLIC_STRAWS_SLUG = 'strohhalme-25';

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

export interface PublicCatalog {
  asOf: string;
  machines: PublicMachine[];
  syrups: PublicProduct[];
  accessories: PublicProduct[];
  canister: (PublicProduct & { maxPerContainer: number }) | null;
  included: { freeSyrupLitersPerContainer: 1; cupsPerProcess: 25; strawsPerProcess: 25 };
  pickupArea: string;
  largeEventGuestThreshold: number;
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

async function projectProduct(
  service: ProductService,
  product: Product,
  now: Date,
  executor: DatabaseExecutor,
): Promise<PublicProduct | null> {
  const billingMode = billingModeOf(product);
  if (billingMode === null) return null;
  let priceCents: number;
  try {
    priceCents = await service.effectivePriceCents(product.id, now, executor);
  } catch {
    return null; // ohne wirksamen Preis nie öffentlich (kein erfundener Preis)
  }
  return {
    slug: product.slug,
    name: product.name,
    category: product.category,
    description: product.description,
    priceCents,
    billingMode,
    unitLabel: product.saleUnit,
  };
}

/**
 * Öffentliche Abholregion – fail-closed: enthält der gepflegte Wert die exakte Adresse
 * (oder ihren Straßenteil), wird der Default „Mainz-Hechtsheim“ ausgegeben.
 */
export async function publicPickupArea(executor: DatabaseExecutor): Promise<string> {
  const area =
    (await getStringSetting(executor, PICKUP_PUBLIC_AREA_KEY)) ?? PICKUP_PUBLIC_AREA_DEFAULT;
  const fragments = exactAddressFragments(
    await getStringSetting(executor, PICKUP_EXACT_ADDRESS_KEY),
  );
  return containsExactAddress(area, fragments) ? PICKUP_PUBLIC_AREA_DEFAULT : area;
}

export async function buildPublicCatalog(
  executor: DatabaseExecutor,
  now: Date,
): Promise<PublicCatalog> {
  const service = new ProductService(executor as never);
  const rows = await executor
    .select()
    .from(products)
    .where(eq(products.active, true))
    .orderBy(asc(products.sortOrder), asc(products.name));
  const machines: PublicMachine[] = [];
  const syrups: PublicProduct[] = [];
  const accessories: PublicProduct[] = [];
  let canister: PublicCatalog['canister'] = null;
  for (const product of rows) {
    const projected = await projectProduct(service, product, now, executor);
    if (projected === null) continue;
    if (isSlushMachineProduct(product)) {
      machines.push({
        ...projected,
        containerCount: product.containerCount!,
        containerVolumeLiters: Number(product.containerVolumeLiters),
      });
    } else if (product.category === 'syrup') {
      syrups.push(projected);
    } else if (product.slug === PUBLIC_CUPS_SLUG || product.slug === PUBLIC_STRAWS_SLUG) {
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
    included: { freeSyrupLitersPerContainer: 1, cupsPerProcess: 25, strawsPerProcess: 25 },
    pickupArea: await publicPickupArea(executor),
    largeEventGuestThreshold: LARGE_EVENT_GUEST_THRESHOLD,
    priceNote: PUBLIC_PRICE_NOTE,
  };
}

/** Öffentliche Projektion ausgewählter Produkte (z. B. `product_grid.productSlugs`) – nur aktive, mit Preis. */
export async function buildPublicProducts(
  executor: DatabaseExecutor,
  slugs: readonly string[],
  now: Date,
): Promise<PublicProduct[]> {
  if (slugs.length === 0) return [];
  const service = new ProductService(executor as never);
  const rows = await executor
    .select()
    .from(products)
    .where(and(eq(products.active, true), inArray(products.slug, [...slugs])));
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  const out: PublicProduct[] = [];
  for (const slug of slugs) {
    const product = bySlug.get(slug);
    if (product === undefined) continue;
    const projected = await projectProduct(service, product, now, executor);
    if (projected !== null) out.push(projected);
  }
  return out;
}
