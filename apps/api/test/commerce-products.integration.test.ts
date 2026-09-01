/**
 * Phase-3-Pflichttests 1–6: Produkte & Preise (Seed-Preise, zukünftige
 * Preise mit Stichtag, Preis-Snapshot versendeter Angebote, deaktivierte
 * Produkte, historische Positionen). Läuft gegen echtes PostgreSQL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createTestContext,
  destroyTestContext,
  login,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { truncateCrmTables } from './crm-helpers.ts';
import {
  commerceServices,
  createCommerceWorld,
  ensureTestTerms,
  inquiryServiceFor,
  productServiceFor,
  truncateCommerceTables,
} from './commerce-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  // Zuletzt: Commerce-Reset inkl. Wiederherstellung der Seed-Preise.
  await truncateCommerceTables(ctx.pool);
});

async function adminSession() {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  return { admin, cookie: session.cookie };
}

describe('1.–3. Preise & zukünftige Preise', () => {
  it('1. Die vier aktuellen Slushpreise sind korrekt (60/100/75/120 EUR)', async () => {
    const products = productServiceFor(ctx);
    const expected: [string, number][] = [
      ['slush-1x8', 6000],
      ['slush-2x8', 10000],
      ['slush-1x10', 7500],
      ['slush-2x10', 12000],
    ];
    for (const [slug, cents] of expected) {
      const product = await products.getProductBySlug(slug);
      expect(await products.effectivePriceCents(product.id), slug).toBe(cents);
    }
  });

  it('2./3. Zukünftiger Preis: vor dem Stichtag inaktiv, ab dem Stichtag aktiv', async () => {
    const { admin } = await adminSession();
    const products = productServiceFor(ctx);
    const product = await products.getProductBySlug('slush-1x10');
    const effectiveFrom = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    await products.planFuturePrice(admin.id, product.id, 8000, effectiveFrom);

    // Vor dem Stichtag: alter Preis.
    expect(await products.effectivePriceCents(product.id, new Date())).toBe(7500);
    const justBefore = new Date(effectiveFrom.getTime() - 1000);
    expect(await products.effectivePriceCents(product.id, justBefore)).toBe(7500);
    // Ab dem Stichtag: neuer Preis – ohne Background-Job, rein per Datum.
    expect(await products.effectivePriceCents(product.id, effectiveFrom)).toBe(8000);
    const after = new Date(effectiveFrom.getTime() + 60_000);
    expect(await products.effectivePriceCents(product.id, after)).toBe(8000);
  });

  it('3b. Geplante Preise sind bis zur Wirksamkeit änder- und löschbar, wirksame nicht', async () => {
    const { admin, cookie } = await adminSession();
    const products = productServiceFor(ctx);
    const product = await products.getProductBySlug('slush-1x10');
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    await products.planFuturePrice(admin.id, product.id, 8000, future);
    const listed = await ctx.app.inject({
      method: 'GET',
      url: '/staff/products',
      headers: { cookie },
    });
    const body = listed.json() as {
      products: { slug: string; futurePrices: { id: string }[] }[];
    };
    const priceId = body.products.find((p) => p.slug === 'slush-1x10')?.futurePrices[0]?.id;
    expect(priceId).toBeDefined();

    await products.updateFuturePrice(priceId!, { priceCents: 8500 });
    await products.deleteFuturePrice(priceId!);
    // Der bereits wirksame Seed-Preis ist unantastbar:
    const seedPrice = await ctx.pool.query(
      `SELECT pp.id FROM product_prices pp JOIN products p ON p.id = pp.product_id WHERE p.slug = 'slush-1x10'`,
    );
    await expect(products.deleteFuturePrice(seedPrice.rows[0].id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('4.–6. Preis-Snapshot & Deaktivierung', () => {
  it('4. Altes Angebot behält den alten Preis; neues Angebot erhält den neuen (75 → 80 EUR)', async () => {
    const { admin } = await adminSession();
    const products = productServiceFor(ctx);
    const services = commerceServices(ctx);
    const machine = await products.getProductBySlug('slush-1x10');
    const world = await createCommerceWorld(ctx, admin.id);
    await inquiryServiceFor(ctx).upsertForProcess(admin.id, world.processId, {
      eventDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
      machineProductId: machine.id,
      fulfillment: 'pickup',
      selections: [],
    });
    const { versionId } = await services.offers.createOffer(admin.id, world.processId);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    await services.offers.send(admin.id, versionId, effective);

    // Preisänderung NACH Versand:
    await products.setCurrentPrice(admin.id, machine.id, 8000);

    const oldVersion = await services.offers.getVersion(versionId);
    expect(oldVersion.fixedTotalCents).toBe(7500);

    // Neues Angebot (neuer Vorgang) nutzt den neuen Preis.
    const world2 = await createCommerceWorld(ctx, admin.id);
    await inquiryServiceFor(ctx).upsertForProcess(admin.id, world2.processId, {
      eventDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
      machineProductId: machine.id,
      fulfillment: 'pickup',
      selections: [],
    });
    const next = await services.offers.createOffer(admin.id, world2.processId);
    const nextVersion = await services.offers.getVersion(next.versionId);
    expect(nextVersion.fixedTotalCents).toBe(8000);
  });

  it('5. Deaktivierte Produkte sind für neue Anfragen/Entwürfe nicht wählbar', async () => {
    const { admin } = await adminSession();
    const products = productServiceFor(ctx);
    const world = await createCommerceWorld(ctx, admin.id);
    await products.setActive(world.machineId, false);

    await expect(
      inquiryServiceFor(ctx).upsertForProcess(admin.id, world.processId, {
        eventDate: '2027-01-01',
        machineProductId: world.machineId,
        fulfillment: 'pickup',
        selections: [],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await products.setActive(world.syrupId, false);
    await expect(
      inquiryServiceFor(ctx).upsertForProcess(admin.id, world.processId, {
        eventDate: '2027-01-01',
        fulfillment: 'pickup',
        selections: [{ productId: world.syrupId, role: 'extra', quantity: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('6. Historische Positionen bleiben nach Deaktivierung und Preisänderung erhalten', async () => {
    const { admin } = await adminSession();
    const services = commerceServices(ctx);
    const products = productServiceFor(ctx);
    const world = await createCommerceWorld(ctx, admin.id);
    await ensureTestTerms(ctx.db);
    const { versionId } = await services.offers.createOffer(admin.id, world.processId);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    await services.offers.send(admin.id, versionId, effective);

    await products.setActive(world.machineId, false);
    await products.setCurrentPrice(admin.id, world.machineId, 99900);

    const items = await ctx.pool.query(
      `SELECT description, standard_unit_price_cents, agreed_unit_price_cents
       FROM offer_line_items oli WHERE oli.offer_version_id = $1 AND oli.kind = 'machine'`,
      [versionId],
    );
    expect(items.rows).toHaveLength(1);
    expect(items.rows[0].standard_unit_price_cents).toBe(12000);
    expect(items.rows[0].agreed_unit_price_cents).toBe(12000);
  });
});
