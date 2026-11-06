import { cmsEntries, cmsRevisions, products, productPrices } from '@mietroyal/database';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStringSetting, PICKUP_PUBLIC_AREA_KEY } from '../src/crm/settings-service.ts';
import { PUBLIC_PRICE_NOTE } from '../src/public/catalog.ts';
import {
  DELIVERY_PREVIEW_TEXT,
  RECOMMENDATION_FALLBACK_MESSAGE,
  UNASSIGNED_SYRUP_LABEL,
} from '../src/public/configurator.ts';
import {
  bootstrapAdmin,
  createTestContext,
  destroyTestContext,
  type TestContext,
} from './auth-helpers.ts';
import { publishCmsForTests } from './cms-helpers.ts';
import { productServiceFor, setPickupExactAddress } from './commerce-helpers.ts';
import {
  forbiddenPublicFields,
  postPreview,
  PUBLIC_FORBIDDEN_KEYS,
  resetPublicWorld,
} from './public-helpers.ts';

/**
 * Phase 16 (PUBLIC, Design §3.1/§3.2/§11.3): öffentlicher Katalog und laufende
 * Preisübersicht des Slush-Konfigurators. Preise ausschließlich aus ProductService/
 * product_prices und der zentralen Preisengine; keine IDs/Bestände/Historie; Abholung
 * ohne exakte Adresse; Lieferung ohne Preis; ≥ 250 Gäste nur Hinweis; Empfehlung nur aus
 * veröffentlichten Regeln und überschreibbar. Namen laufen als „PC<n>“.
 */

let ctx: TestContext;
let adminId: string;

const SEED_PRICES: Record<string, number> = {
  'slush-1x8': 6000,
  'slush-2x8': 10000,
  'slush-1x10': 7500,
  'slush-2x10': 12000,
  'sirup-wassermelone': 1200,
  'sirup-kirsche': 1200,
  'sirup-waldmeister': 1200,
  'sirup-blaue-himbeere': 1200,
  'becher-25': 250,
  'strohhalme-25': 200,
  'mischkanister-6l': 500,
};
const CONTAINERS: Record<string, number> = {
  'slush-1x8': 1,
  'slush-2x8': 2,
  'slush-1x10': 1,
  'slush-2x10': 2,
};

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await destroyTestContext(ctx);
});

beforeEach(async () => {
  await resetPublicWorld(ctx.pool);
  adminId = (await bootstrapAdmin(ctx)).id;
});

afterEach(() => {
  vi.useRealTimers();
});

async function catalog() {
  const response = await ctx.app.inject({ method: 'GET', url: '/public/configurator/catalog' });
  expect(response.statusCode).toBe(200);
  return { response, body: response.json() };
}

async function preview(body: Record<string, unknown>) {
  const response = await postPreview(ctx, body);
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

describe('Phase 16 – öffentlicher Katalog (GET /public/configurator/catalog)', () => {
  it('PC1. Katalog = aktueller ProductService-Preis: vier Maschinentypen mit Behältern, vier Sirupe, Becher/Strohhalme, Kanister, Inklusivregeln, Anlässe, Hinweistext, no-store', async () => {
    const { response, body } = await catalog();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    const service = productServiceFor(ctx);
    const now = new Date();
    for (const group of [body.machines, body.syrups, body.accessories, [body.canister]]) {
      for (const entry of group as Array<{ slug: string; priceCents: number }>) {
        const product = await service.getProductBySlug(entry.slug);
        expect(entry.priceCents, entry.slug).toBe(
          await service.effectivePriceCents(product.id, now),
        );
        expect(entry.priceCents, entry.slug).toBe(SEED_PRICES[entry.slug]);
      }
    }
    expect(body.machines.map((m: { slug: string }) => m.slug)).toEqual([
      'slush-1x8',
      'slush-2x8',
      'slush-1x10',
      'slush-2x10',
    ]);
    for (const machine of body.machines as Array<Record<string, unknown>>) {
      expect(machine.containerCount).toBe(CONTAINERS[machine.slug as string]);
      expect([8, 10]).toContain(machine.containerVolumeLiters);
      expect(machine.billingMode).toBe('fixed');
    }
    expect(body.syrups).toHaveLength(4);
    expect(body.syrups.every((s: { billingMode: string }) => s.billingMode === 'commission')).toBe(
      true,
    );
    expect(body.accessories.map((a: { slug: string }) => a.slug)).toEqual([
      'becher-25',
      'strohhalme-25',
    ]);
    expect(body.accessories[0].unitLabel).toBe('25er-Pack');
    expect(body.canister).toMatchObject({
      slug: 'mischkanister-6l',
      priceCents: 500,
      billingMode: 'fixed',
      maxPerContainer: 2,
    });
    expect(body.included).toEqual({
      freeSyrupLitersPerContainer: 1,
      cupsPerProcess: 25,
      strawsPerProcess: 25,
    });
    expect(body.largeEventGuestThreshold).toBe(250);
    expect(body.priceNote).toBe(PUBLIC_PRICE_NOTE);
    expect(body.pickupArea).toBe('Mainz-Hechtsheim');
    expect(body.occasions).toEqual([
      { value: 'birthday', label: 'Geburtstag' },
      { value: 'wedding', label: 'Hochzeit' },
      { value: 'company_event', label: 'Firmenfeier' },
      { value: 'club', label: 'Verein' },
      { value: 'party', label: 'Party' },
      { value: 'school_kindergarten', label: 'Schule / Kindergarten' },
      { value: 'festival', label: 'Festival' },
      { value: 'other', label: 'Sonstiges' },
    ]);
  });

  it('PC2. Deep-Scan: keine IDs, keine Bestände/Status, keine Historie, keine internen Felder (auch nicht in der Vorschau)', async () => {
    const { body } = await catalog();
    expect(forbiddenPublicFields(body, PUBLIC_FORBIDDEN_KEYS)).toEqual([]);
    const previewBody = await preview({
      guests: 40,
      machineSlug: 'slush-2x10',
      syrups: { free: [{ slug: 'sirup-kirsche', liters: 2 }], extra: [] },
      extras: { cups25: 1, straws25: 1 },
      canisters: 1,
    });
    expect(forbiddenPublicFields(previewBody, PUBLIC_FORBIDDEN_KEYS)).toEqual([]);
  });

  it('PC3. Geplanter Preis wirkt öffentlich ab effective_from (Fake-Zeit): vorher alter, danach neuer Preis – Katalog UND Vorschau', async () => {
    const service = productServiceFor(ctx);
    const machine = await service.getProductBySlug('slush-1x8');
    const realNow = new Date();
    const effectiveFrom = new Date(realNow.getTime() + 2 * 60 * 60 * 1000);
    await service.planFuturePrice(adminId, machine.id, 6900, effectiveFrom, realNow);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(effectiveFrom.getTime() - 60_000));
    const before = (await catalog()).body;
    expect(before.machines.find((m: { slug: string }) => m.slug === 'slush-1x8').priceCents).toBe(
      6000,
    );
    expect((await preview({ machineSlug: 'slush-1x8' })).fixedTotalCents).toBe(6000);

    vi.setSystemTime(new Date(effectiveFrom.getTime() + 60_000));
    const after = (await catalog()).body;
    expect(after.machines.find((m: { slug: string }) => m.slug === 'slush-1x8').priceCents).toBe(
      6900,
    );
    const pricedAfter = await preview({ machineSlug: 'slush-1x8' });
    expect(pricedAfter.fixed[0]).toMatchObject({ unitPriceCents: 6900, totalCents: 6900 });
    expect(pricedAfter.fixedTotalCents).toBe(6900);
  });

  it('PC4. Inaktive Produkte und Produkte ohne wirksamen Preis erscheinen nicht (nie 0 € erfinden)', async () => {
    const service = productServiceFor(ctx);
    await service.setActive((await service.getProductBySlug('sirup-waldmeister')).id, false);
    const fresh = await service.createProduct(
      adminId,
      {
        slug: 'sirup-test-zukunft',
        name: 'Sirup Test',
        category: 'syrup',
        saleUnit: '1-L-Flasche',
        defaultBillingMode: 'commission',
      },
      1300,
    );
    // Nur ein zukünftiger Preis: Startpreis entfernen, Zukunftspreis planen.
    await ctx.db.delete(productPrices).where(eq(productPrices.productId, fresh.id));
    await service.planFuturePrice(adminId, fresh.id, 1300, new Date(Date.now() + 86_400_000));
    const { body } = await catalog();
    const slugs = (body.syrups as Array<{ slug: string }>).map((s) => s.slug);
    expect(slugs).not.toContain('sirup-waldmeister');
    expect(slugs).not.toContain('sirup-test-zukunft');
    // Auch nicht wählbar in der Vorschau (Hinweis statt Berechnung).
    const result = await preview({
      machineSlug: 'slush-1x8',
      syrups: { free: [], extra: [{ slug: 'sirup-waldmeister', liters: 1 }] },
    });
    expect(result.commission).toEqual([]);
    expect(result.issues).toEqual([
      { code: 'SYRUP_UNAVAILABLE', message: 'Diese Sirupsorte ist gerade nicht wählbar.' },
    ]);
  });

  it('PC5. Abholung nur als öffentliche Region – nie die exakte Adresse, auch wenn sie gepflegt ist oder im Regionstext steht', async () => {
    await setPickupExactAddress(ctx, adminId);
    const plain = await catalog();
    expect(plain.body.pickupArea).toBe('Mainz-Hechtsheim');
    expect(plain.response.body).not.toContain('Teststraße');
    await setStringSetting(
      ctx.db,
      adminId,
      PICKUP_PUBLIC_AREA_KEY,
      'Teststraße 1, 55129 Mainz-Hechtsheim (SYNTHETISCH)',
    );
    const leaked = await catalog();
    expect(leaked.body.pickupArea).toBe('Mainz-Hechtsheim');
    expect(leaked.response.body).not.toContain('Teststraße');
    const previewResponse = await postPreview(ctx, { machineSlug: 'slush-1x8' });
    expect(previewResponse.body).not.toContain('Teststraße');
  });
});

describe('Phase 16 – laufende Preisübersicht (POST /public/configurator/preview)', () => {
  it('PC6. Alle vier Maschinentypen: Miete aus der Preisengine, Gratis-Sirup = Behälterzahl, Kanisterlimit 2 je Behälter, 25 Becher + 25 Strohhalme einmal inklusive', async () => {
    for (const [slug, containers] of Object.entries(CONTAINERS)) {
      const result = await preview({ machineSlug: slug });
      expect(result.fixed, slug).toHaveLength(1);
      expect(result.fixed[0]).toMatchObject({
        quantity: 1,
        unitPriceCents: SEED_PRICES[slug],
        totalCents: SEED_PRICES[slug],
      });
      expect(result.fixed[0].label).toContain('Slushmaschine');
      expect(result.fixedTotalCents).toBe(SEED_PRICES[slug]);
      expect(result.quota).toEqual({
        freeSyrupLiters: containers,
        assignedFreeLiters: 0,
        unassignedFreeLiters: containers,
        canisterMax: 2 * containers,
      });
      expect(result.included).toEqual([
        { label: UNASSIGNED_SYRUP_LABEL, quantity: containers, unit: 'L' },
        { label: '25 Becher (inklusive, einmal pro Mietvorgang)', quantity: 1, unit: '25er-Pack' },
        {
          label: '25 Strohhalme (inklusive, einmal pro Mietvorgang)',
          quantity: 1,
          unit: '25er-Pack',
        },
      ]);
      expect(result.commission).toEqual([]);
      expect(result.issues).toEqual([]);
      expect(result.priceNote).toBe(PUBLIC_PRICE_NOTE);
    }
  });

  it('PC7. Gratis-Sirup frei verteilbar; weniger als Kontingent ⇒ „Sorte später abstimmen“; mehr ⇒ Hinweis statt Fehler (Übersicht bleibt)', async () => {
    const partial = await preview({
      machineSlug: 'slush-2x10',
      syrups: { free: [{ slug: 'sirup-kirsche', liters: 1 }], extra: [] },
    });
    expect(partial.quota).toMatchObject({ assignedFreeLiters: 1, unassignedFreeLiters: 1 });
    expect(partial.included.slice(0, 2)).toEqual([
      { label: 'Sirup Kirsche (inklusive)', quantity: 1, unit: 'L' },
      { label: UNASSIGNED_SYRUP_LABEL, quantity: 1, unit: 'L' },
    ]);
    const split = await preview({
      machineSlug: 'slush-2x10',
      syrups: {
        free: [
          { slug: 'sirup-kirsche', liters: 1 },
          { slug: 'sirup-blaue-himbeere', liters: 1 },
        ],
        extra: [],
      },
    });
    expect(split.quota.unassignedFreeLiters).toBe(0);
    expect(split.included.map((i: { label: string }) => i.label)).not.toContain(
      UNASSIGNED_SYRUP_LABEL,
    );
    const tooMuch = await preview({
      machineSlug: 'slush-1x8',
      syrups: { free: [{ slug: 'sirup-kirsche', liters: 2 }], extra: [] },
    });
    expect(tooMuch.issues).toEqual([
      {
        code: 'FREE_SYRUP_BUDGET_EXCEEDED',
        message: 'Das Gratis-Sirup-Kontingent beträgt 1 L (1 L je gebuchtem Behälter).',
      },
    ]);
    expect(tooMuch.fixedTotalCents).toBe(6000); // Maschine bleibt berechnet
  });

  it('PC8. Kommission: Extra-Sirup, Becher, Strohhalme nur mit Einheitspreis, nicht im festen Betrag; Kanister ist Kauf (fest)', async () => {
    const result = await preview({
      machineSlug: 'slush-1x10',
      syrups: { free: [], extra: [{ slug: 'sirup-wassermelone', liters: 3 }] },
      extras: { cups25: 2, straws25: 1 },
      canisters: 2,
    });
    expect(result.commission).toEqual([
      {
        label: 'Sirup Wassermelone (Kommission – Abrechnung nach tatsächlichem Verbrauch)',
        quantity: 3,
        unitPriceCents: 1200,
        unit: '1-L-Flasche',
      },
      {
        label: 'Becher (25 Stück) (Kommission – Abrechnung nach tatsächlichem Verbrauch)',
        quantity: 2,
        unitPriceCents: 250,
        unit: '25er-Pack',
      },
      {
        label: 'Strohhalme (25 Stück) (Kommission – Abrechnung nach tatsächlichem Verbrauch)',
        quantity: 1,
        unitPriceCents: 200,
        unit: '25er-Pack',
      },
    ]);
    expect(result.fixed).toEqual([
      expect.objectContaining({ unitPriceCents: 7500, totalCents: 7500 }),
      { label: '6-L-Mischkanister', quantity: 2, unitPriceCents: 500, totalCents: 1000 },
    ]);
    expect(result.fixedTotalCents).toBe(8500);
    // Inklusiv-Becher/-Strohhalme bleiben genau EINMAL (nicht je Maschine/Behälter).
    const includedCups = result.included.filter((i: { label: string }) =>
      i.label.startsWith('25 Becher'),
    );
    expect(includedCups).toEqual([
      { label: '25 Becher (inklusive, einmal pro Mietvorgang)', quantity: 1, unit: '25er-Pack' },
    ]);
  });

  it('PC9. Kanisterlimit (2 je Behälter) ausschließlich über die Preisengine: Überschreitung ⇒ Hinweis, Kanister nicht berechnet', async () => {
    const over = await preview({ machineSlug: 'slush-1x8', canisters: 3 });
    expect(over.issues).toEqual([
      {
        code: 'CANISTER_LIMIT_EXCEEDED',
        message: 'Maximal 2 Mischkanister möglich (2 je gebuchtem Behälter).',
      },
    ]);
    expect(over.fixedTotalCents).toBe(6000);
    const within = await preview({ machineSlug: 'slush-2x8', canisters: 4 });
    expect(within.issues).toEqual([]);
    expect(within.quota.canisterMax).toBe(4);
    expect(within.fixedTotalCents).toBe(10000 + 4 * 500);
  });

  it('PC10. Lieferung: angefragt + Text „individuell geprüft“, KEIN Lieferpreis und keine Lieferposition', async () => {
    const result = await preview({ machineSlug: 'slush-2x10', fulfillment: 'delivery' });
    expect(result.delivery).toEqual({ requested: true, text: DELIVERY_PREVIEW_TEXT });
    expect(result.fixed).toHaveLength(1);
    expect(result.fixedTotalCents).toBe(12000);
    expect(JSON.stringify(result)).not.toMatch(/Lieferung und Abholung/);
    const pickup = await preview({ machineSlug: 'slush-2x10' });
    expect(pickup.delivery.requested).toBe(false);
  });

  it('PC11. ≥ 250 Gäste ⇒ nur Hinweis (largeEvent), nie Fehler; 249 ⇒ kein Hinweis', async () => {
    const large = await preview({ guests: 250, machineSlug: 'slush-2x10' });
    expect(large.largeEvent).toBe(true);
    expect(large.issues).toEqual([]);
    expect(large.fixedTotalCents).toBe(12000);
    expect((await preview({ guests: 249 })).largeEvent).toBe(false);
    expect((await preview({ guests: 5000 })).largeEvent).toBe(true);
  });

  it('PC12. Ohne veröffentlichte Empfehlungsregel ⇒ „Wir prüfen persönlich …“ (blockiert nie); Entwurfsregeln wirken nicht', async () => {
    const none = await preview({ guests: 80 });
    expect(none.recommendation).toEqual({
      machineSlug: null,
      message: RECOMMENDATION_FALLBACK_MESSAGE,
    });
    await publishCmsForTests(
      ctx.db,
      { kind: 'site_settings' },
      {
        content: {
          businessName: 'Miet-Royal',
          contact: {},
          recommendationRules: [{ guestMin: 1, guestMax: 100, machineProductSlug: 'slush-1x10' }],
        },
        publish: false,
      },
    );
    expect((await preview({ guests: 80 })).recommendation.machineSlug).toBeNull();
  });

  it('PC13. Veröffentlichte Regeln: Empfehlung nach Gästezahl, Lücken erlaubt, nur aktive Maschinen; Kunde kann jede andere Maschine wählen', async () => {
    await publishCmsForTests(
      ctx.db,
      { kind: 'site_settings' },
      {
        content: {
          businessName: 'Miet-Royal',
          contact: {},
          recommendationRules: [
            { guestMin: 1, guestMax: 60, machineProductSlug: 'slush-1x8' },
            { guestMin: 100, machineProductSlug: 'slush-2x10' },
          ],
        },
      },
    );
    const small = await preview({ guests: 40 });
    expect(small.recommendation.machineSlug).toBe('slush-1x8');
    expect(small.recommendation.message).toContain('1×8 L');
    // Lücke 61–99 ⇒ persönliche Prüfung, kein Fehler.
    expect((await preview({ guests: 80 })).recommendation).toEqual({
      machineSlug: null,
      message: RECOMMENDATION_FALLBACK_MESSAGE,
    });
    // Empfehlung überschreibbar: andere Maschine wird normal berechnet.
    const overridden = await preview({ guests: 300, machineSlug: 'slush-1x8' });
    expect(overridden.recommendation.machineSlug).toBe('slush-2x10');
    expect(overridden.fixedTotalCents).toBe(6000);
    expect(overridden.issues).toEqual([]);
    // Empfohlene Maschine deaktiviert ⇒ keine Empfehlung (nur aktive Maschinen).
    const service = productServiceFor(ctx);
    await service.setActive((await service.getProductBySlug('slush-2x10')).id, false);
    expect((await preview({ guests: 300 })).recommendation.machineSlug).toBeNull();
  });

  it('PC14. Überlappende Empfehlungsregeln: Schema lehnt ab; direkt gespeicherte überlappende Regeln gelten als nicht veröffentlicht (fail-closed)', async () => {
    await expect(
      publishCmsForTests(
        ctx.db,
        { kind: 'site_settings' },
        {
          content: {
            businessName: 'Miet-Royal',
            contact: {},
            recommendationRules: [
              { guestMin: 1, guestMax: 100, machineProductSlug: 'slush-1x8' },
              { guestMin: 50, guestMax: 150, machineProductSlug: 'slush-2x10' },
            ],
          },
        },
      ),
    ).rejects.toThrow();
    const [entry] = await ctx.db
      .insert(cmsEntries)
      .values({ kind: 'site_settings' })
      .returning({ id: cmsEntries.id });
    const [revision] = await ctx.db
      .insert(cmsRevisions)
      .values({
        entryId: entry!.id,
        revisionNumber: 1,
        content: {
          businessName: 'Miet-Royal',
          contact: {},
          recommendationRules: [
            { guestMin: 1, guestMax: 100, machineProductSlug: 'slush-1x8' },
            { guestMin: 50, guestMax: 150, machineProductSlug: 'slush-2x10' },
          ],
        },
      })
      .returning({ id: cmsRevisions.id });
    await ctx.db
      .update(cmsEntries)
      .set({
        draftRevisionId: revision!.id,
        publishedRevisionId: revision!.id,
        publishedAt: new Date(),
      })
      .where(eq(cmsEntries.id, entry!.id));
    expect((await preview({ guests: 75 })).recommendation.machineSlug).toBeNull();
  });

  it('PC15. Nur Slush-Maschinen: unbekannte, deaktivierte oder Maschinen ohne Behälterangabe sind nicht wählbar (Hinweis, kein Fehler)', async () => {
    const service = productServiceFor(ctx);
    await service.createProduct(
      adminId,
      {
        slug: 'maschine-ohne-behaelter',
        name: 'Testgerät',
        category: 'machine',
        saleUnit: 'Stück',
      },
      9900,
    );
    await service.setActive((await service.getProductBySlug('slush-2x8')).id, false);
    for (const slug of ['gibt-es-nicht', 'maschine-ohne-behaelter', 'slush-2x8']) {
      const result = await preview({ machineSlug: slug });
      expect(result.issues, slug).toEqual([
        {
          code: 'MACHINE_UNAVAILABLE',
          message: 'Diese Maschine ist gerade nicht wählbar. Bitte wähle eine andere.',
        },
      ]);
      expect(result.fixed).toEqual([]);
      expect(result.fixedTotalCents).toBe(0);
    }
    const { body } = await catalog();
    expect(body.machines.map((m: { slug: string }) => m.slug)).not.toContain(
      'maschine-ohne-behaelter',
    );
    const [check] = await ctx.db
      .select({ active: products.active })
      .from(products)
      .where(eq(products.slug, 'maschine-ohne-behaelter'));
    expect(check?.active).toBe(true);
  });

  it('PC16. Strikter Body (unbekanntes Feld ⇒ 400 mit Feldpfad, ohne Werte); Cross-Site-POST ⇒ 403; keine CORS-Header; leere Vorschau ist gültig', async () => {
    const unknown = await postPreview(ctx, { machineSlug: 'slush-1x8', priceCents: 1 });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(unknown.json())).not.toContain('"priceCents":1');
    const crossSite = await postPreview(
      ctx,
      {},
      { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
    );
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json().error.code).toBe('CSRF_REJECTED');
    const empty = await postPreview(ctx, {});
    expect(empty.statusCode).toBe(200);
    expect(empty.headers['access-control-allow-origin']).toBeUndefined();
    expect(empty.headers['cache-control']).toBe('no-store');
    expect(empty.json()).toMatchObject({
      fixed: [],
      fixedTotalCents: 0,
      included: [],
      commission: [],
      issues: [],
      largeEvent: false,
      quota: { freeSyrupLiters: 0, canisterMax: 0 },
    });
  });
  it('PC17. Maschinen-Slug als Sirup (gratis oder extra) ⇒ SYRUP_UNAVAILABLE am Sirup, Maschine normal berechnet (Review pricing-4)', async () => {
    for (const role of ['free', 'extra'] as const) {
      const syrups = { free: [], extra: [], [role]: [{ slug: 'slush-2x8', liters: 1 }] };
      const result = await preview({ machineSlug: 'slush-2x8', syrups });
      expect(result.issues, role).toEqual([
        { code: 'SYRUP_UNAVAILABLE', message: 'Diese Sirupsorte ist gerade nicht wählbar.' },
      ]);
      expect(result.fixed, role).toHaveLength(1);
      expect(result.fixed[0]).toMatchObject({ quantity: 1, totalCents: 10000 });
      expect(result.fixedTotalCents).toBe(10000);
      expect(result.quota).toMatchObject({ freeSyrupLiters: 2, assignedFreeLiters: 0 });
      expect(result.included).toHaveLength(3);
    }
  });

  it('PC18. Exakte Abholadresse in Produktname/-beschreibung: Beschreibung ⇒ null, Produkt mit Adress-Namen nicht öffentlich, nicht wählbar und nie empfohlen (Review pricing-3)', async () => {
    const touched = ['mischkanister-6l', 'slush-2x10'];
    const originals = await ctx.db
      .select({ slug: products.slug, name: products.name, description: products.description })
      .from(products)
      .where(inArray(products.slug, touched));
    try {
      await setPickupExactAddress(ctx, adminId);
      await ctx.db
        .update(products)
        .set({ description: 'Kauf direkt in der Teststraße 1.' })
        .where(eq(products.slug, 'mischkanister-6l'));
      await ctx.db
        .update(products)
        .set({ name: 'Slushmaschine 2×10 L (Teststr. 1)' })
        .where(eq(products.slug, 'slush-2x10'));
      await publishCmsForTests(
        ctx.db,
        { kind: 'site_settings' },
        {
          content: {
            businessName: 'Miet-Royal',
            contact: {},
            recommendationRules: [{ guestMin: 100, machineProductSlug: 'slush-2x10' }],
          },
        },
      );
      const { response, body } = await catalog();
      expect(body.canister).toMatchObject({ slug: 'mischkanister-6l', description: null });
      expect(body.machines.map((m: { slug: string }) => m.slug)).toEqual([
        'slush-1x8',
        'slush-2x8',
        'slush-1x10',
      ]);
      expect(response.body.toLowerCase()).not.toContain('teststr');
      const result = await preview({ guests: 300, machineSlug: 'slush-2x10' });
      expect(result.recommendation).toEqual({
        machineSlug: null,
        message: RECOMMENDATION_FALLBACK_MESSAGE,
      });
      expect(result.issues.map((issue: { code: string }) => issue.code)).toEqual([
        'MACHINE_UNAVAILABLE',
      ]);
      expect(JSON.stringify(result).toLowerCase()).not.toContain('teststr');
      // Beschreibung ohne Adresse bleibt sichtbar.
      await ctx.db
        .update(products)
        .set({ description: 'Zum Nachmischen.' })
        .where(eq(products.slug, 'mischkanister-6l'));
      expect((await catalog()).body.canister.description).toBe('Zum Nachmischen.');
    } finally {
      for (const original of originals) {
        await ctx.db
          .update(products)
          .set({ name: original.name, description: original.description })
          .where(eq(products.slug, original.slug));
      }
    }
  });
});
