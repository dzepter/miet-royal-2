import { productPrices, products, type Database, type Product } from '@mietroyal/database';
import type { PricingProduct } from '@mietroyal/domain';
import { and, asc, desc, eq, gt, lte } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';

/**
 * Produktkatalog + zeitgesteuerte Preise (Phase-3-Vorgaben Nr. 1/2/7/8).
 * Produkte werden NIE physisch gelöscht (nur deaktiviert); der wirksame
 * Preis zum Zeitpunkt t ist die product_prices-Zeile mit dem größten
 * effective_from <= t – geplante zukünftige Preise brauchen daher keinen
 * Background-Job und bleiben bis zur Wirksamkeit änder-/löschbar.
 */

export interface ProductInput {
  slug: string;
  name: string;
  category: 'machine' | 'syrup' | 'consumable' | 'purchase';
  description?: string | undefined;
  saleUnit: string;
  defaultBillingMode?: 'fixed' | 'commission' | 'included' | undefined;
  sortOrder?: number | undefined;
  containerCount?: number | undefined;
  containerVolumeLiters?: number | undefined;
  weightGrams?: number | undefined;
  carryPersons?: number | undefined;
}

export class ProductService {
  constructor(private readonly db: Database) {}

  async listProducts(includeInactive: boolean) {
    const rows = await this.db
      .select()
      .from(products)
      .where(includeInactive ? undefined : eq(products.active, true))
      .orderBy(asc(products.sortOrder), asc(products.name));
    const now = new Date();
    const result = [];
    for (const product of rows) {
      const currentPrice = await this.effectivePriceCents(product.id, now);
      const futurePrices = await this.db
        .select()
        .from(productPrices)
        .where(and(eq(productPrices.productId, product.id), gt(productPrices.effectiveFrom, now)))
        .orderBy(asc(productPrices.effectiveFrom));
      result.push({ ...product, currentPriceCents: currentPrice, futurePrices });
    }
    return result;
  }

  async getProduct(productId: string): Promise<Product> {
    const rows = await this.db.select().from(products).where(eq(products.id, productId));
    const product = rows[0];
    if (product === undefined) throw new AuthError('NOT_FOUND', 'Produkt nicht gefunden.');
    return product;
  }

  async getProductBySlug(slug: string): Promise<Product> {
    const rows = await this.db.select().from(products).where(eq(products.slug, slug));
    const product = rows[0];
    if (product === undefined) throw new AuthError('NOT_FOUND', `Produkt fehlt: ${slug}`);
    return product;
  }

  async createProduct(actorId: string, input: ProductInput, initialPriceCents: number) {
    if (input.slug.trim() === '' || input.name.trim() === '' || input.saleUnit.trim() === '') {
      throw new AuthError('VALIDATION', 'Key, Name und Verkaufseinheit sind erforderlich.');
    }
    if (!Number.isInteger(initialPriceCents) || initialPriceCents < 0) {
      throw new AuthError('VALIDATION', 'Der Preis muss ein nicht-negativer Cent-Betrag sein.');
    }
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(products)
        .values({
          slug: input.slug.trim(),
          name: input.name.trim(),
          category: input.category,
          description: input.description ?? null,
          saleUnit: input.saleUnit.trim(),
          defaultBillingMode: input.defaultBillingMode ?? 'fixed',
          sortOrder: input.sortOrder ?? 0,
          containerCount: input.containerCount ?? null,
          containerVolumeLiters: input.containerVolumeLiters ?? null,
          weightGrams: input.weightGrams ?? null,
          carryPersons: input.carryPersons ?? null,
        })
        .returning();
      const product = inserted[0];
      if (product === undefined) throw new AuthError('CONFLICT', 'Anlegen fehlgeschlagen.');
      await tx.insert(productPrices).values({
        productId: product.id,
        priceCents: initialPriceCents,
        effectiveFrom: new Date(),
        createdBy: actorId,
      });
      return product;
    });
  }

  async updateProduct(
    productId: string,
    input: { [K in keyof Partial<ProductInput>]: ProductInput[K] | undefined },
  ): Promise<Product> {
    await this.getProduct(productId);
    const updated = await this.db
      .update(products)
      .set({
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.saleUnit === undefined ? {} : { saleUnit: input.saleUnit.trim() }),
        ...(input.defaultBillingMode === undefined
          ? {}
          : { defaultBillingMode: input.defaultBillingMode }),
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
        ...(input.containerCount === undefined ? {} : { containerCount: input.containerCount }),
        ...(input.containerVolumeLiters === undefined
          ? {}
          : { containerVolumeLiters: input.containerVolumeLiters }),
        ...(input.weightGrams === undefined ? {} : { weightGrams: input.weightGrams }),
        ...(input.carryPersons === undefined ? {} : { carryPersons: input.carryPersons }),
        updatedAt: new Date(),
      })
      .where(eq(products.id, productId))
      .returning();
    const product = updated[0];
    if (product === undefined) throw new AuthError('NOT_FOUND', 'Produkt nicht gefunden.');
    return product;
  }

  /** Deaktivieren statt löschen – historische Positionen bleiben gültig. */
  async setActive(productId: string, active: boolean): Promise<void> {
    await this.getProduct(productId);
    await this.db
      .update(products)
      .set({ active, updatedAt: new Date() })
      .where(eq(products.id, productId));
  }

  // ── Preise ───────────────────────────────────────────────────────────────

  async effectivePriceCents(productId: string, at = new Date()): Promise<number> {
    const rows = await this.db
      .select()
      .from(productPrices)
      .where(and(eq(productPrices.productId, productId), lte(productPrices.effectiveFrom, at)))
      .orderBy(desc(productPrices.effectiveFrom))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new AuthError('CONFLICT', 'Für dieses Produkt ist kein Preis hinterlegt.');
    }
    return row.priceCents;
  }

  /** Sofortige Preisänderung: gilt nur für NEUE Preisermittlungen (Nr. 7). */
  async setCurrentPrice(actorId: string, productId: string, priceCents: number): Promise<void> {
    await this.getProduct(productId);
    if (!Number.isInteger(priceCents) || priceCents < 0) {
      throw new AuthError('VALIDATION', 'Der Preis muss ein nicht-negativer Cent-Betrag sein.');
    }
    await this.db.insert(productPrices).values({
      productId,
      priceCents,
      effectiveFrom: new Date(),
      createdBy: actorId,
    });
  }

  /** Zukünftigen Preis mit Wirksamkeitsdatum planen (Nr. 8). */
  async planFuturePrice(
    actorId: string,
    productId: string,
    priceCents: number,
    effectiveFrom: Date,
    now = new Date(),
  ): Promise<void> {
    await this.getProduct(productId);
    if (!Number.isInteger(priceCents) || priceCents < 0) {
      throw new AuthError('VALIDATION', 'Der Preis muss ein nicht-negativer Cent-Betrag sein.');
    }
    if (effectiveFrom.getTime() <= now.getTime()) {
      throw new AuthError('VALIDATION', 'Das Wirksamkeitsdatum muss in der Zukunft liegen.');
    }
    await this.db.insert(productPrices).values({
      productId,
      priceCents,
      effectiveFrom,
      createdBy: actorId,
    });
  }

  /** Geplante (noch nicht wirksame) Preise sind änder- und löschbar. */
  async updateFuturePrice(
    priceId: string,
    input: { priceCents?: number | undefined; effectiveFrom?: Date | undefined },
    now = new Date(),
  ): Promise<void> {
    const row = await this.futurePriceRow(priceId, now);
    if (input.priceCents !== undefined) {
      if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
        throw new AuthError('VALIDATION', 'Der Preis muss ein nicht-negativer Cent-Betrag sein.');
      }
    }
    if (input.effectiveFrom !== undefined && input.effectiveFrom.getTime() <= now.getTime()) {
      throw new AuthError('VALIDATION', 'Das Wirksamkeitsdatum muss in der Zukunft liegen.');
    }
    await this.db
      .update(productPrices)
      .set({
        ...(input.priceCents === undefined ? {} : { priceCents: input.priceCents }),
        ...(input.effectiveFrom === undefined ? {} : { effectiveFrom: input.effectiveFrom }),
      })
      .where(eq(productPrices.id, row.id));
  }

  async deleteFuturePrice(priceId: string, now = new Date()): Promise<void> {
    const row = await this.futurePriceRow(priceId, now);
    await this.db.delete(productPrices).where(eq(productPrices.id, row.id));
  }

  private async futurePriceRow(priceId: string, now: Date) {
    const rows = await this.db.select().from(productPrices).where(eq(productPrices.id, priceId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Preiseintrag nicht gefunden.');
    if (row.effectiveFrom.getTime() <= now.getTime()) {
      throw new AuthError(
        'CONFLICT',
        'Bereits wirksame Preise sind unveränderlich – bitte eine neue Preisänderung anlegen.',
      );
    }
    return row;
  }

  // ── Preisengine-Anbindung ────────────────────────────────────────────────

  /** Produkt inkl. wirksamem Listenpreis für die zentrale Preisengine. */
  async pricingProduct(productId: string, at = new Date()): Promise<PricingProduct> {
    const product = await this.getProduct(productId);
    return this.toPricingProduct(product, at);
  }

  async pricingProductBySlug(slug: string, at = new Date()): Promise<PricingProduct> {
    const product = await this.getProductBySlug(slug);
    return this.toPricingProduct(product, at);
  }

  private async toPricingProduct(product: Product, at: Date): Promise<PricingProduct> {
    return {
      id: product.id,
      slug: product.slug,
      name: product.name,
      category: product.category,
      saleUnit: product.saleUnit,
      defaultBillingMode: product.defaultBillingMode,
      listPriceCents: await this.effectivePriceCents(product.id, at),
      containerCount: product.containerCount,
      containerVolumeLiters: product.containerVolumeLiters,
      carryPersons: product.carryPersons,
      weightGrams: product.weightGrams,
    };
  }
}
