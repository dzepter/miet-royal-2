/**
 * Phase 16 (PUBLIC): „Auswahl ⇒ PricingInput“ (resolvePricingInput) und die dafür
 * gehobenen Domain-Konstanten. Reine Unit-Tests ohne Datenbank – die Produktauflösung
 * kommt aus einem In-Memory-Resolver.
 */
import { describe, expect, it } from 'vitest';
import {
  CANISTER_SLUG,
  CANISTERS_PER_CONTAINER_LIMIT,
  CUPS_PACK_SLUG,
  FREE_CUPS_PER_RENTAL,
  FREE_STRAWS_PER_RENTAL,
  FREE_SYRUP_LITERS_PER_CONTAINER,
  PricingError,
  STRAWS_PACK_SLUG,
  canisterLimitFor,
  freeSyrupBudgetFor,
  priceOffer,
  resolvePricingInput,
  type PricingProduct,
  type PricingProductResolver,
} from '../src/index.ts';

const machine2x8: PricingProduct = {
  id: 'm-2x8',
  slug: 'slush-2x8',
  name: '2×8 L',
  category: 'machine',
  saleUnit: 'Stück',
  defaultBillingMode: 'fixed',
  listPriceCents: 10000,
  containerCount: 2,
  containerVolumeLiters: 8,
};
const syrup: PricingProduct = {
  id: 's-kirsche',
  slug: 'sirup-kirsche',
  name: 'Sirup Kirsche',
  category: 'syrup',
  saleUnit: '1-L-Flasche',
  defaultBillingMode: 'commission',
  listPriceCents: 1200,
};
const cups: PricingProduct = {
  id: 'c-becher',
  slug: CUPS_PACK_SLUG,
  name: 'Becher (25 Stück)',
  category: 'consumable',
  saleUnit: '25er-Pack',
  defaultBillingMode: 'commission',
  listPriceCents: 250,
};
const straws: PricingProduct = {
  ...cups,
  id: 'c-halme',
  slug: STRAWS_PACK_SLUG,
  name: 'Strohhalme (25 Stück)',
  listPriceCents: 200,
};
const canister: PricingProduct = {
  id: 'p-kanister',
  slug: CANISTER_SLUG,
  name: '6-L-Mischkanister',
  category: 'purchase',
  saleUnit: 'Stück',
  defaultBillingMode: 'fixed',
  listPriceCents: 500,
};

/** In-Memory-Resolver per Slug; protokolliert die Reihenfolge der Auflösung. */
function slugResolver(
  products: readonly PricingProduct[],
  options: { withPacks?: boolean } = {},
): PricingProductResolver<string> & { calls: string[] } {
  const bySlug = new Map(products.map((product) => [product.slug, product]));
  const calls: string[] = [];
  return {
    calls,
    product: async (slug) => {
      calls.push(`product:${slug}`);
      const product = bySlug.get(slug);
      if (product === undefined) throw new Error(`unbekannt: ${slug}`);
      return product;
    },
    includedPack: async (slug) => {
      calls.push(`pack:${slug}`);
      if (options.withPacks === false) return null;
      return bySlug.get(slug) ?? null;
    },
  };
}

describe('Phase 16 – Domain-Konstanten (eine Wahrheit für Angebot und Website)', () => {
  it('Pack-Slugs, Inklusivmengen und Kontingentregeln haben die fachlichen Werte', () => {
    expect(CUPS_PACK_SLUG).toBe('becher-25');
    expect(STRAWS_PACK_SLUG).toBe('strohhalme-25');
    expect(FREE_CUPS_PER_RENTAL).toBe(25);
    expect(FREE_STRAWS_PER_RENTAL).toBe(25);
    expect(FREE_SYRUP_LITERS_PER_CONTAINER).toBe(1);
    expect(freeSyrupBudgetFor(2)).toBe(2);
    expect(canisterLimitFor(2)).toBe(2 * CANISTERS_PER_CONTAINER_LIMIT);
    expect(canisterLimitFor(0)).toBe(0);
  });

  it('PricingError trägt einen maschinenlesbaren Code (Meldungstext unverändert)', () => {
    const base = {
      machine: { product: machine2x8, quantity: 1 },
      cupsProduct: cups,
      strawsProduct: straws,
      fulfillment: 'pickup' as const,
    };
    const tooMuchSyrup = () =>
      priceOffer({ ...base, selections: [{ product: syrup, role: 'free', quantity: 3 }] });
    expect(tooMuchSyrup).toThrow(PricingError);
    expect(tooMuchSyrup).toThrow(
      'Das Gratis-Sirup-Kontingent beträgt 2 L (1 L je gebuchtem Behälter).',
    );
    try {
      tooMuchSyrup();
    } catch (error) {
      expect((error as PricingError).code).toBe('FREE_SYRUP_BUDGET_EXCEEDED');
    }
    try {
      priceOffer({ ...base, selections: [{ product: canister, role: 'extra', quantity: 5 }] });
      expect.unreachable();
    } catch (error) {
      expect((error as PricingError).code).toBe('CANISTER_LIMIT_EXCEEDED');
      expect((error as PricingError).message).toBe(
        'Maximal 4 Mischkanister möglich (2 je gebuchtem Behälter).',
      );
    }
    try {
      priceOffer({ ...base, machine: { product: syrup, quantity: 1 }, selections: [] });
      expect.unreachable();
    } catch (error) {
      expect((error as PricingError).code).toBe('PRICING_INVALID');
    }
  });
});

describe('Phase 16 – resolvePricingInput (Auswahl ⇒ PricingInput)', () => {
  it('löst Maschine, Auswahl (in Eingabereihenfolge) und danach die Inklusiv-Packs per Domain-Slug auf', async () => {
    const resolver = slugResolver([machine2x8, syrup, cups, straws, canister]);
    const input = await resolvePricingInput(
      {
        machine: { ref: 'slush-2x8', quantity: 1 },
        selections: [
          { ref: 'sirup-kirsche', role: 'free', quantity: 2 },
          { ref: CANISTER_SLUG, role: 'extra', quantity: 1 },
        ],
        fulfillment: 'delivery',
      },
      resolver,
    );
    expect(resolver.calls).toEqual([
      'product:slush-2x8',
      'product:sirup-kirsche',
      `product:${CANISTER_SLUG}`,
      `pack:${CUPS_PACK_SLUG}`,
      `pack:${STRAWS_PACK_SLUG}`,
    ]);
    expect(input.machine).toEqual({ product: machine2x8, quantity: 1 });
    expect(input.selections).toEqual([
      { product: syrup, role: 'free', quantity: 2 },
      { product: canister, role: 'extra', quantity: 1 },
    ]);
    expect(input.cupsProduct).toBe(cups);
    expect(input.strawsProduct).toBe(straws);
    expect(input.fulfillment).toBe('delivery');
    // Keine erfundenen Felder: ohne Angabe kein Lieferpreis, kein Rabatt, kein Gutschein.
    expect('deliveryPriceCents' in input).toBe(false);
    expect('discount' in input).toBe(false);
    expect('voucher' in input).toBe(false);
  });

  it('Ergebnis über priceOffer: 25 Becher + 25 Strohhalme einmal inklusive, Kommission und Kauf getrennt, kein Lieferpreis', async () => {
    const input = await resolvePricingInput(
      {
        machine: { ref: 'slush-2x8', quantity: 1 },
        selections: [
          { ref: 'sirup-kirsche', role: 'free', quantity: 1 },
          { ref: 'sirup-kirsche', role: 'extra', quantity: 3 },
          { ref: CUPS_PACK_SLUG, role: 'extra', quantity: 2 },
          { ref: CANISTER_SLUG, role: 'extra', quantity: 2 },
        ],
        fulfillment: 'delivery',
      },
      slugResolver([machine2x8, syrup, cups, straws, canister]),
    );
    const result = priceOffer(input);
    const included = result.lineItems.filter((item) => item.billingMode === 'included');
    expect(included.map((item) => item.description)).toEqual([
      'Sirup Kirsche (inklusive)',
      '25 Becher (inklusive, einmal pro Mietvorgang)',
      '25 Strohhalme (inklusive, einmal pro Mietvorgang)',
    ]);
    expect(result.freeSyrupBudgetLiters).toBe(2);
    expect(result.commissionMaxCents).toBe(3 * 1200 + 2 * 250);
    expect(result.fixedTotalCents).toBe(10000 + 2 * 500);
    expect(result.lineItems.some((item) => item.kind === 'delivery')).toBe(false);
  });

  it('fehlende Inklusiv-Packs ⇒ null (priceOffer nutzt die Fallback-Einheit, Preis 0)', async () => {
    const input = await resolvePricingInput(
      { machine: { ref: 'slush-2x8', quantity: 1 }, selections: [], fulfillment: 'pickup' },
      slugResolver([machine2x8], { withPacks: false }),
    );
    expect(input.cupsProduct).toBeNull();
    expect(input.strawsProduct).toBeNull();
    const cupsLine = priceOffer(input).lineItems.find((item) => item.lineKey === 'included:cups');
    expect(cupsLine).toMatchObject({ unit: '25er-Pack', totalCents: 0, productId: null });
  });

  it('reicht Lieferpreis, Rabatt, Sonderpreise und Gutschein unverändert durch (Angebotspfad)', async () => {
    const specialPrices = [
      {
        lineKey: 'machine',
        unitPriceCents: 9000,
        previousStandardCents: 10000,
        byUserId: 'u-1',
        at: '2026-11-06T10:00:00.000Z',
      },
    ];
    const input = await resolvePricingInput(
      {
        machine: { ref: 'slush-2x8', quantity: 2 },
        selections: [],
        fulfillment: 'delivery',
        deliveryPriceCents: 4500,
        discount: { type: 'percent', value: 500 },
        specialPrices,
        voucher: null,
      },
      slugResolver([machine2x8, cups, straws]),
    );
    expect(input.deliveryPriceCents).toBe(4500);
    expect(input.discount).toEqual({ type: 'percent', value: 500 });
    expect(input.specialPrices).toBe(specialPrices);
    expect(input.voucher).toBeNull();
    expect(input.machine?.quantity).toBe(2);
  });

  it('ohne Maschine: keine Maschinenauflösung, Packs werden trotzdem aufgelöst (priceOffer entscheidet)', async () => {
    const resolver = slugResolver([syrup, cups, straws]);
    const input = await resolvePricingInput(
      {
        machine: null,
        selections: [{ ref: 'sirup-kirsche', role: 'extra', quantity: 1 }],
        fulfillment: 'pickup',
      },
      resolver,
    );
    expect(input.machine).toBeNull();
    expect(resolver.calls[0]).toBe('product:sirup-kirsche');
    const result = priceOffer(input);
    // Inklusiv-Becher/-Strohhalme nur mit Maschine (Mietvorgang).
    expect(result.lineItems.some((item) => item.lineKey === 'included:cups')).toBe(false);
  });

  it('unbekanntes Produkt ⇒ Fehler des Resolvers wird durchgereicht (keine stille Auslassung)', async () => {
    await expect(
      resolvePricingInput(
        { machine: { ref: 'gibt-es-nicht', quantity: 1 }, selections: [], fulfillment: 'pickup' },
        slugResolver([]),
      ),
    ).rejects.toThrow('unbekannt: gibt-es-nicht');
  });
});
