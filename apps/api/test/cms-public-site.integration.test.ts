import { PassThrough } from 'node:stream';
import { productPrices, products } from '@mietroyal/database';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cmsEntries } from '@mietroyal/database';
import { PICKUP_EXACT_ADDRESS_KEY, setStringSetting } from '../src/crm/settings-service.ts';
import type { PlaceReviewsResult, ReviewGateway } from '../src/reviews/types.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { publishCmsForTests } from './cms-helpers.ts';
import {
  call,
  CMS_TEST_EXACT_ADDRESS,
  CMS_TEST_WEB_BASE,
  createCmsTestContext,
  faqContent,
  resetCmsWorld,
  seedPage,
  seedSiteSettings,
  SETTINGS_CONTENT,
  type CmsWorld,
} from './cms-world.ts';

/**
 * Phase 16 (CMS, Order §7/§18/§23/§25, Design §2.5/§11.2.2b/§11.2.3/§11.3): öffentliche
 * Site-Routen – nur Veröffentlichtes, keine Redaktionsnotizen/Staff-IDs/Storage-Keys/
 * Empfehlungsregeln; Produkte und Preise ausschließlich aus dem aktuellen Katalog (auch
 * geplante Preise ab Wirksamkeit); exakte Abholadresse fail-closed im Lesepfad;
 * `reviews`-Block nur mit aktivem Provider; no-store, kein CORS, strikte Pfade.
 * Namen laufen als „S<n>.“.
 */

let ctx: TestContext;
let world: CmsWorld;
let logBuffer = '';

beforeAll(async () => {
  const sink = new PassThrough();
  sink.on('data', (chunk: Buffer) => {
    logBuffer += chunk.toString('utf8');
  });
  ctx = await createCmsTestContext({ logDestination: sink, logLevel: 'info' });
});

afterAll(async () => {
  await destroyTestContext(ctx);
});

beforeEach(async () => {
  world = await resetCmsWorld(ctx);
});

async function publishPage(
  pageType: Parameters<typeof seedPage>[1]['pageType'],
  path: string,
  content: unknown,
  meta: { metaTitle?: string; metaDescription?: string } = {},
) {
  const detail = await seedPage(
    world,
    { pageType, path },
    {
      content,
      metaTitle: meta.metaTitle ?? 'Titel',
      metaDescription: meta.metaDescription ?? null,
    },
  );
  return world.cms.publish(world.publisher.id, detail.id, { revisionId: detail.draft.revisionId });
}

const SLUSH_CONTENT = {
  title: 'Slushmaschine mieten',
  blocks: [
    { type: 'hero', heading: 'Slush für dein Event' },
    { type: 'product_grid', heading: 'Unsere Maschinen' },
    { type: 'product_grid', heading: 'Sirup', productSlugs: ['sirup-kirsche', 'gibt-es-nicht'] },
    { type: 'included_items', heading: 'Inklusive' },
    { type: 'reviews', heading: 'Bewertungen' },
  ],
};

describe('Phase 16 – öffentliche Site-Routen', () => {
  it('S1. /public/site/settings: nur Veröffentlichtes, keine Regeln/Notizen/Staff-IDs, no-store, kein CORS', async () => {
    const settings = await seedSiteSettings(world, {
      ...SETTINGS_CONTENT,
      contact: { email: 'info@cms.test', phone: '+49 6131 000000' },
      instagramUrl: 'https://www.instagram.com/mietroyal.test',
      recommendationRules: [{ guestMin: 1, guestMax: 80, machineProductSlug: 'slush-1x8' }],
    });
    await world.cms.publish(world.publisher.id, settings.id, {
      revisionId: settings.draft.revisionId,
    });
    await publishPage('faq', '/faq', faqContent(), {
      metaTitle: 'FAQ',
      metaDescription: 'Antworten rund um die Slushmaschine.',
    });
    await seedPage(
      world,
      { pageType: 'about', path: '/ueber-uns' },
      { content: { title: 'Über uns', blocks: [] } },
    );
    const response = await call(ctx, 'GET', '/public/site/settings', {
      headers: { origin: 'https://evil.example' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.json()).toEqual({
      environment: 'development',
      settings: {
        businessName: 'Miet-Royal',
        tagline: 'Slush für dein Event',
        phone: '+49 6131 000000',
        email: 'info@cms.test',
        instagramUrl: 'https://www.instagram.com/mietroyal.test',
        logo: null,
        footerNote: 'Synthetischer Testinhalt.',
      },
      pages: [
        {
          path: '/faq',
          pageType: 'faq',
          title: 'Häufige Fragen',
          metaDescription: 'Antworten rund um die Slushmaschine.',
          publishedAt: expect.any(String), // Phase 17 (SEO-API8 prüft den Wert)
        },
      ],
      reviews: { mode: 'disabled' },
      pickupArea: 'Mainz-Hechtsheim',
      publicBaseUrl: CMS_TEST_WEB_BASE, // Phase 17 (SEO, D1)
    });
    for (const forbidden of [
      'recommendationRules',
      'guestMin',
      world.publisher.id,
      world.adminId,
    ]) {
      expect(response.body).not.toContain(forbidden);
    }
  });

  it('S2. Seiten-DTO: Produkte/Preise aus dem Katalog, Inklusivleistungen, keine IDs/Bestände/Notizen', async () => {
    const detail = await seedPage(
      world,
      { pageType: 'slush', path: '/slushmaschine-mieten' },
      {
        content: SLUSH_CONTENT,
        metaTitle: 'Slushmaschine mieten',
        metaDescription: 'Slush für dein Event.',
      },
    );
    const withNote = await world.cms.saveDraft(world.editor.id, detail.id, {
      baseRevisionId: detail.draft.revisionId,
      content: SLUSH_CONTENT,
      metaTitle: 'Slushmaschine mieten',
      editorNote: 'INTERNE-NOTIZ-NICHT-ÖFFENTLICH',
    });
    await world.cms.publish(world.publisher.id, detail.id, {
      revisionId: withNote.draft.revisionId,
    });
    const response = await call(ctx, 'GET', '/public/site/page?path=/slushmaschine-mieten', {
      headers: { origin: 'https://evil.example' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    const page = response.json();
    expect(page).toMatchObject({
      path: '/slushmaschine-mieten',
      pageType: 'slush',
      revisionId: withNote.draft.revisionId,
      title: 'Slushmaschine mieten',
      metaTitle: 'Slushmaschine mieten',
      metaDescription: null,
    });
    expect(typeof page.publishedAt).toBe('string');
    expect(page.blocks.map((block: { type: string }) => block.type)).toEqual([
      'hero',
      'product_grid',
      'product_grid',
      'included_items',
    ]); // reviews entfällt ohne Provider
    const machines = page.blocks[1].products as Array<{ slug: string; priceCents: number }>;
    expect(machines.map((machine) => [machine.slug, machine.priceCents])).toEqual([
      ['slush-1x8', 6000],
      ['slush-2x8', 10000],
      ['slush-1x10', 7500],
      ['slush-2x10', 12000],
    ]);
    expect(page.blocks[2].products.map((product: { slug: string }) => product.slug)).toEqual([
      'sirup-kirsche',
    ]);
    expect(page.blocks[3]).toMatchObject({
      included: { freeSyrupLitersPerContainer: 1, cupsPerProcess: 25, strawsPerProcess: 25 },
      canister: { slug: 'mischkanister-6l', priceCents: 500, maxPerContainer: 2 },
    });
    expect(page.blocks[3].syrups).toHaveLength(4);
    expect(page.blocks[3].accessories.map((item: { slug: string }) => item.slug).sort()).toEqual([
      'becher-25',
      'strohhalme-25',
    ]);
    for (const forbidden of [
      'INTERNE-NOTIZ',
      'editorNote',
      '"id"',
      'weightGrams',
      'carryPersons',
      'futurePrices',
      'stock',
      'inventory',
      world.publisher.id,
    ]) {
      expect(response.body, forbidden).not.toContain(forbidden);
    }
  });

  it('S3. Preise wirken ab effective_from – das CMS hält keinen Preis', async () => {
    await publishPage('slush', '/slushmaschine-mieten', SLUSH_CONTENT, {
      metaTitle: 'Slushmaschine mieten',
    });
    const product = (
      await ctx.db.select().from(products).where(eq(products.slug, 'slush-1x8'))
    )[0]!;
    const future = new Date(Date.now() + 60 * 60_000);
    const inserted = await ctx.db
      .insert(productPrices)
      .values({ productId: product.id, priceCents: 6500, effectiveFrom: future })
      .returning();
    const priceOf = async () => {
      const page = (await call(ctx, 'GET', '/public/site/page?path=/slushmaschine-mieten')).json();
      return (page.blocks[1].products as Array<{ slug: string; priceCents: number }>).find(
        (item) => item.slug === 'slush-1x8',
      )!.priceCents;
    };
    expect(await priceOf()).toBe(6000);
    // Stichtag erreicht (Zeitpunkt in die Vergangenheit verschoben ⇒ jetzt wirksam)
    await ctx.db
      .update(productPrices)
      .set({ effectiveFrom: new Date(Date.now() - 1000) })
      .where(eq(productPrices.id, inserted[0]!.id));
    expect(await priceOf()).toBe(6500);
    // Inaktives Produkt verschwindet aus dem Raster (kein erfundener Preis)
    await ctx.db.update(products).set({ active: false }).where(eq(products.slug, 'slush-1x8'));
    const page = (await call(ctx, 'GET', '/public/site/page?path=/slushmaschine-mieten')).json();
    expect(page.blocks[1].products.map((item: { slug: string }) => item.slug)).not.toContain(
      'slush-1x8',
    );
  });

  it('S4. Exakte Abholadresse fail-closed im Lesepfad (Blöcke/Felder weg, Titel betroffen ⇒ 404), Log nur mit ID', async () => {
    // Direkt eingefügt (ohne Service-Prüfung) und erst DANACH Adresse gepflegt.
    const settings = await publishCmsForTests(
      ctx.db,
      { kind: 'site_settings' },
      {
        content: {
          ...SETTINGS_CONTENT,
          footerNote: 'Abholung: Teststraße 1 in Mainz',
        },
      },
    );
    const contact = await publishCmsForTests(
      ctx.db,
      { kind: 'page', pageType: 'contact', path: '/kontakt' },
      {
        content: {
          title: 'Kontakt',
          blocks: [
            { type: 'text', body: 'Schreib uns jederzeit.' },
            { type: 'text', body: 'Lager: Teststrasse 1, 55129 Mainz-Hechtsheim (synthetisch)' },
          ],
        },
        metaTitle: 'Kontakt',
        metaDescription: 'Teststraße 1 – so findest du uns',
      },
    );
    await publishCmsForTests(
      ctx.db,
      { kind: 'page', pageType: 'about', path: '/ueber-uns' },
      { content: { title: 'Über uns in der Teststraße 1', blocks: [] }, metaTitle: 'Über uns' },
    );
    // Vor der Pflege der Adresse: alles sichtbar
    expect((await call(ctx, 'GET', '/public/site/page?path=/ueber-uns')).statusCode).toBe(200);
    await setStringSetting(ctx.db, world.adminId, PICKUP_EXACT_ADDRESS_KEY, CMS_TEST_EXACT_ADDRESS);
    logBuffer = '';
    const page = await call(ctx, 'GET', '/public/site/page?path=/kontakt');
    expect(page.statusCode).toBe(200);
    expect(page.json().blocks).toEqual([{ type: 'text', body: 'Schreib uns jederzeit.' }]);
    expect(page.json().metaDescription).toBeNull();
    expect((await call(ctx, 'GET', '/public/site/page?path=/ueber-uns')).statusCode).toBe(404);
    const site = await call(ctx, 'GET', '/public/site/settings');
    expect(site.json().settings.footerNote).toBeNull();
    expect(site.json().pages.map((item: { path: string }) => item.path)).toEqual(['/kontakt']);
    for (const body of [page.body, site.body]) {
      expect(body.toLowerCase()).not.toContain('teststr');
    }
    expect(logBuffer).toContain(contact.entryId);
    expect(logBuffer).toContain(settings.entryId);
    expect(logBuffer.toLowerCase()).not.toContain('teststr');
  });

  it('S5. Bewertungs-Block nur mit aktivem Provider; reviews.mode aus der Grenze', async () => {
    const demoGateway: ReviewGateway = {
      mode: 'demo',
      fetchPlaceReviews: async (): Promise<PlaceReviewsResult> => ({
        mode: 'demo',
        rating: null,
        total: null,
        placeUri: null,
        reviews: [],
      }),
    };
    const withReviews = await createCmsTestContext({ reviewGateway: demoGateway });
    try {
      const otherWorld = await resetCmsWorld(withReviews);
      const detail = await seedPage(
        otherWorld,
        { pageType: 'home', path: '/' },
        {
          content: { title: 'Start', blocks: [{ type: 'reviews', heading: 'Das sagen Gäste' }] },
          metaTitle: 'Start',
        },
      );
      await otherWorld.cms.publish(otherWorld.publisher.id, detail.id, {
        revisionId: detail.draft.revisionId,
      });
      const site = (await call(withReviews, 'GET', '/public/site/settings')).json();
      expect(site.reviews).toEqual({ mode: 'demo' });
      const page = (await call(withReviews, 'GET', '/public/site/page?path=/')).json();
      expect(page.blocks).toEqual([{ type: 'reviews', heading: 'Das sagen Gäste' }]);
    } finally {
      await destroyTestContext(withReviews);
    }
    // Hauptkontext: disabled ⇒ Block entfällt
    world = await resetCmsWorld(ctx);
    await publishPage('home', '/', {
      title: 'Start',
      blocks: [{ type: 'reviews', heading: 'Das sagen Gäste' }],
    });
    expect((await call(ctx, 'GET', '/public/site/page?path=/')).json().blocks).toEqual([]);
  });

  it('S6. Strikte Pfade: ungültig ⇒ 400, unbekannt/Entwurf ⇒ 404', async () => {
    await seedPage(world, { pageType: 'faq', path: '/faq' }, { content: faqContent() });
    for (const path of ['faq', '/FAQ', '/faq/', '/../etc', '/faq?x=1', '//faq']) {
      const response = await call(ctx, 'GET', `/public/site/page?path=${encodeURIComponent(path)}`);
      expect(response.statusCode, path).toBe(400);
    }
    expect((await call(ctx, 'GET', '/public/site/page')).statusCode).toBe(400);
    expect((await call(ctx, 'GET', '/public/site/page?path=/faq&extra=1')).statusCode).toBe(400);
    expect((await call(ctx, 'GET', '/public/site/page?path=/faq')).statusCode).toBe(404);
    expect((await call(ctx, 'GET', '/public/site/page?path=/gibt-es-nicht')).statusCode).toBe(404);
  });

  it('S7. Lesepfad bei Adresse ohne Komma bzw. „Firma, Straße, PLZ Ort“: Block mit Straßenvariante entfällt, Seiten/Einstellungen mit „Miet-Royal“ bleiben öffentlich (Review cms-1/pricing-2)', async () => {
    // Direkt eingefügt (ohne Service-Prüfung) und erst DANACH Adresse gepflegt.
    await publishCmsForTests(ctx.db, { kind: 'site_settings' }, { content: SETTINGS_CONTENT });
    const faq = await publishCmsForTests(
      ctx.db,
      { kind: 'page', pageType: 'faq', path: '/faq' },
      {
        content: {
          title: 'Häufige Fragen',
          blocks: [
            { type: 'text', body: 'Du holst die Maschine in Mainz-Hechtsheim ab.' },
            { type: 'text', body: 'Abholung am Lindenhain-Weg 90.' },
            {
              type: 'cta',
              heading: 'Route',
              primary: { label: 'Karte', href: 'https://maps.google.com/?q=Lindenhainweg%2090' },
            },
          ],
        },
        metaTitle: 'Häufige Fragen | Miet-Royal',
      },
    );
    for (const address of [
      'Lindenhainweg 90 55130 Mainz',
      '55130 Mainz, Lindenhainweg 90',
      'Miet-Royal, Lindenhainweg 90, 55130 Mainz',
    ]) {
      await setStringSetting(ctx.db, world.adminId, PICKUP_EXACT_ADDRESS_KEY, address);
      logBuffer = '';
      const page = await call(ctx, 'GET', '/public/site/page?path=/faq');
      expect(page.statusCode, address).toBe(200);
      expect(page.json().metaTitle).toBe('Häufige Fragen | Miet-Royal');
      expect(page.json().blocks).toEqual([
        { type: 'text', body: 'Du holst die Maschine in Mainz-Hechtsheim ab.' },
      ]);
      const site = await call(ctx, 'GET', '/public/site/settings');
      expect(site.json().settings?.businessName, address).toBe('Miet-Royal');
      expect(site.json().pages.map((item: { path: string }) => item.path)).toEqual(['/faq']);
      for (const body of [page.body, site.body]) {
        expect(body.toLowerCase()).not.toContain('lindenhain');
      }
      expect(logBuffer).toContain(faq.entryId);
      expect(logBuffer.toLowerCase()).not.toContain('lindenhain');
    }
  });

  it('S8. Produkte mit exakter Adresse: Beschreibung ⇒ null, Produktname ⇒ Produkt entfällt (product_grid, included_items, Staff-Lesesicht); Log nur Slug (Review pricing-3)', async () => {
    const touched = ['mischkanister-6l', 'sirup-kirsche', 'sirup-waldmeister'];
    const originals = await ctx.db
      .select({ slug: products.slug, name: products.name, description: products.description })
      .from(products)
      .where(inArray(products.slug, touched));
    try {
      await setStringSetting(
        ctx.db,
        world.adminId,
        PICKUP_EXACT_ADDRESS_KEY,
        CMS_TEST_EXACT_ADDRESS,
      );
      await ctx.db
        .update(products)
        .set({ description: 'Kauf direkt in der Teststraße 1.' })
        .where(eq(products.slug, 'mischkanister-6l'));
      await ctx.db
        .update(products)
        .set({ description: 'Abholung: Teststr.1' })
        .where(eq(products.slug, 'sirup-kirsche'));
      await ctx.db
        .update(products)
        .set({ name: 'Waldmeister (Teststrasse 1)' })
        .where(eq(products.slug, 'sirup-waldmeister'));
      await publishPage(
        'slush',
        '/slushmaschine-mieten',
        {
          title: 'Slushmaschine mieten',
          blocks: [
            {
              type: 'product_grid',
              heading: 'Sirup',
              productSlugs: ['sirup-kirsche', 'sirup-waldmeister', 'sirup-wassermelone'],
            },
            { type: 'included_items', heading: 'Inklusive' },
          ],
        },
        { metaTitle: 'Slushmaschine mieten' },
      );
      logBuffer = '';
      const response = await call(ctx, 'GET', '/public/site/page?path=/slushmaschine-mieten');
      expect(response.statusCode).toBe(200);
      const page = response.json();
      const grid = page.blocks[0].products as Array<{ slug: string; description: string | null }>;
      expect(grid.map((product) => product.slug)).toEqual(['sirup-kirsche', 'sirup-wassermelone']);
      expect(grid[0]!.description).toBeNull();
      expect(page.blocks[1].canister).toMatchObject({
        slug: 'mischkanister-6l',
        description: null,
      });
      expect(page.blocks[1].syrups.map((item: { slug: string }) => item.slug)).not.toContain(
        'sirup-waldmeister',
      );
      expect(response.body.toLowerCase()).not.toContain('teststr');
      for (const slug of touched) expect(logBuffer, slug).toContain(slug);
      expect(logBuffer.toLowerCase()).not.toContain('teststr');
      const staff = await call(ctx, 'GET', '/staff/cms/catalog', { cookie: world.viewer.cookie });
      expect(staff.statusCode).toBe(200);
      expect(staff.json().canister.description).toBeNull();
      expect(staff.body.toLowerCase()).not.toContain('teststr');
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

describe('Phase 17 – Bootstrap-Erweiterung für SEO (Design D1/D8)', () => {
  it('SEO-API8. publicBaseUrl exakt wie konfiguriert (Schluss-Slash entfernt), null ohne Konfiguration; pages[].publishedAt = cms_entries.published_at (ISO), ändert sich beim erneuten Veröffentlichen; Entwürfe fehlen', async () => {
    const first = new Date('2026-11-12T08:00:00.000Z');
    const second = new Date('2026-11-12T09:30:00.000Z');
    const faq = await seedPage(
      world,
      { pageType: 'faq', path: '/faq' },
      { content: faqContent(), metaTitle: 'Häufige Fragen | Miet-Royal' },
    );
    await world.cms.publish(
      world.publisher.id,
      faq.id,
      { revisionId: faq.draft.revisionId },
      { now: first },
    );
    // Entwurf (nie veröffentlicht) bleibt außen vor.
    await seedPage(
      world,
      { pageType: 'about', path: '/ueber-uns' },
      { content: { title: 'Über uns', blocks: [] }, metaTitle: 'Über uns' },
    );
    const site = (await call(ctx, 'GET', '/public/site/settings')).json();
    expect(site.publicBaseUrl).toBe(CMS_TEST_WEB_BASE);
    expect(site.publicBaseUrl.endsWith('/')).toBe(false);
    expect(site.pages).toEqual([
      {
        path: '/faq',
        pageType: 'faq',
        title: 'Häufige Fragen',
        metaDescription: null,
        publishedAt: first.toISOString(),
      },
    ]);
    const row = (await ctx.db.select().from(cmsEntries).where(eq(cmsEntries.id, faq.id)))[0]!;
    expect(row.publishedAt?.toISOString()).toBe(site.pages[0].publishedAt);
    // Erneut veröffentlichen ⇒ neuer Zeitpunkt (Grundlage für lastModified der Sitemap).
    const changed = await world.cms.saveDraft(world.editor.id, faq.id, {
      baseRevisionId: faq.draft.revisionId,
      content: faqContent('Abholung in Mainz-Hechtsheim, Lieferung auf Anfrage.'),
      metaTitle: 'Häufige Fragen | Miet-Royal',
    });
    await world.cms.publish(
      world.publisher.id,
      faq.id,
      { revisionId: changed.draft.revisionId },
      { now: second },
    );
    const again = (await call(ctx, 'GET', '/public/site/settings')).json();
    expect(again.pages[0].publishedAt).toBe(second.toISOString());
    // Konfigurierte Basis mit Schluss-Slash ⇒ ohne Slash; ohne Konfiguration ⇒ null (fail-closed).
    const slashed = await createCmsTestContext({
      env: { MAIL_PUBLIC_WEB_BASE_URL: `${CMS_TEST_WEB_BASE}/` },
    });
    try {
      expect((await call(slashed, 'GET', '/public/site/settings')).json().publicBaseUrl).toBe(
        CMS_TEST_WEB_BASE,
      );
    } finally {
      await destroyTestContext(slashed);
    }
    const unconfigured = await createTestContext();
    try {
      const body = (await call(unconfigured, 'GET', '/public/site/settings')).json();
      expect(body.publicBaseUrl).toBeNull();
      expect(body.pages.map((item: { path: string }) => item.path)).toEqual(['/faq']);
    } finally {
      await destroyTestContext(unconfigured);
    }
  });
});

describe('Phase 17 – Preis-Guard der öffentlichen Produktprojektion (Order §23, Design D13)', () => {
  it('SEO-P2/P5. Preis-Freitext: Beschreibung ⇒ ohne Beschreibung im product_grid (Preis bleibt priceCents), Name ⇒ Produkt fehlt in product_grid/included_items und Staff-Lesesicht; Log nur Slug', async () => {
    const touched = ['slush-1x8', 'sirup-waldmeister', 'mischkanister-6l'];
    const originals = await ctx.db
      .select({ slug: products.slug, name: products.name, description: products.description })
      .from(products)
      .where(inArray(products.slug, touched));
    const priceTexts = ['Tagesmiete 60 €', '12,- je Liter', 'EUR 5'];
    try {
      await ctx.db
        .update(products)
        .set({ description: 'Slushmaschine, Tagesmiete 60 € inkl. Sirup.' })
        .where(eq(products.slug, 'slush-1x8'));
      await ctx.db
        .update(products)
        .set({ name: 'Waldmeister 12,- je Liter' })
        .where(eq(products.slug, 'sirup-waldmeister'));
      await ctx.db
        .update(products)
        .set({ description: 'Kauf: EUR 5 je Kanister.' })
        .where(eq(products.slug, 'mischkanister-6l'));
      await publishPage(
        'slush',
        '/slushmaschine-mieten',
        {
          title: 'Slushmaschine mieten',
          blocks: [
            { type: 'product_grid', heading: 'Unsere Maschinen' },
            {
              type: 'product_grid',
              heading: 'Sirup',
              productSlugs: ['sirup-kirsche', 'sirup-waldmeister'],
            },
            { type: 'included_items', heading: 'Inklusive' },
          ],
        },
        { metaTitle: 'Slushmaschine mieten' },
      );
      logBuffer = '';
      const response = await call(ctx, 'GET', '/public/site/page?path=/slushmaschine-mieten');
      expect(response.statusCode).toBe(200);
      const page = response.json();
      const machines = page.blocks[0].products as Array<{
        slug: string;
        description: string | null;
        priceCents: number;
      }>;
      expect(machines.find((item) => item.slug === 'slush-1x8')).toMatchObject({
        description: null,
        priceCents: 6000,
      });
      expect(machines.find((item) => item.slug === 'slush-2x8')?.description).toBe(
        'Slushmaschine mit 2 Behältern à 8 Liter.',
      );
      expect(page.blocks[1].products.map((item: { slug: string }) => item.slug)).toEqual([
        'sirup-kirsche',
      ]);
      expect(page.blocks[2].syrups.map((item: { slug: string }) => item.slug)).not.toContain(
        'sirup-waldmeister',
      );
      expect(page.blocks[2].canister).toMatchObject({
        slug: 'mischkanister-6l',
        description: null,
        priceCents: 500,
      });
      for (const forbidden of priceTexts) expect(response.body, forbidden).not.toContain(forbidden);
      // Log: Ereignis + Slug, nie der Text
      expect(logBuffer).toContain('public.catalog.price_text_suppressed');
      for (const slug of touched) expect(logBuffer, slug).toContain(slug);
      for (const forbidden of priceTexts) expect(logBuffer, forbidden).not.toContain(forbidden);
      // Staff-Lesesicht „Produkte & Preise“ ist dieselbe öffentliche Projektion
      const staff = await call(ctx, 'GET', '/staff/cms/catalog', { cookie: world.viewer.cookie });
      expect(staff.statusCode).toBe(200);
      expect(staff.json().canister).toMatchObject({ description: null, priceCents: 500 });
      expect(staff.json().syrups.map((item: { slug: string }) => item.slug)).not.toContain(
        'sirup-waldmeister',
      );
      for (const forbidden of priceTexts) expect(staff.body, forbidden).not.toContain(forbidden);
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
