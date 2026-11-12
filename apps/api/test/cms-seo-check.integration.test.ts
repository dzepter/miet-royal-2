import { products } from '@mietroyal/database';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CMS_BOOTSTRAP_ENTRIES } from '../src/cms/bootstrap-content.ts';
import { runCmsBootstrap } from '../src/cms/bootstrap.ts';
import type { StaffCmsEntryDetail } from '../src/cms/cms-service.ts';
import type { SeoWarning } from '../src/cms/seo-check.ts';
import { PICKUP_EXACT_ADDRESS_KEY, setStringSetting } from '../src/crm/settings-service.ts';
import { destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  call,
  CMS_TEST_EXACT_ADDRESS,
  createCmsTestContext,
  resetCmsWorld,
  seedPage,
  seedSiteSettings,
  SETTINGS_CONTENT,
  type CmsWorld,
} from './cms-world.ts';

/**
 * Phase 17 (SEO, Order §11/§23/§24, Design D12): `GET /staff/cms/seo-check` – Rechte wie das
 * Lesen der Einträge (cms.edit ODER cms.publish), `no-store`, nicht blockierende deutsche
 * Hinweise ohne Codes: doppelte Meta-Titel veröffentlichter Seiten, Entwurf ohne Meta-Titel,
 * kaputter interner Link, Regions-Kopie, Produkt mit Preis-Freitext (Name, Beschreibung,
 * Verkaufseinheit – Review RC-1), nachträglich gepflegte Abholadresse in einem Seitentitel
 * (Review RC-4a); Standardinhalte nach `cms:bootstrap --publish-demo`. Namen laufen als
 * „SEO-API<n>“.
 */

let ctx: TestContext;
let world: CmsWorld;

beforeAll(async () => {
  ctx = await createCmsTestContext();
});

afterAll(async () => {
  await destroyTestContext(ctx);
});

beforeEach(async () => {
  world = await resetCmsWorld(ctx);
});

const DESCRIPTION_FAQ =
  'Antworten rund um deine Slush-Miete: Inklusivleistungen, Sirupsorten, Abholung in Mainz-Hechtsheim und Rückgabe.';
const DESCRIPTION_ABOUT =
  'Miet-Royal ist ein kleiner Familienbetrieb aus Mainz. Wir vermieten Slushmaschinen – fair, transparent und persönlich.';
const DESCRIPTION_HOME =
  'Slushmaschine mieten in Mainz, Wiesbaden und Umgebung: Abholung in Mainz-Hechtsheim oder Lieferung auf Anfrage.';

const TEXT_BLOCK = {
  type: 'text',
  heading: 'Slush für dein Event',
  body: 'Eigener redaktioneller Text mit genug Inhalt für eine echte Seite.',
};

async function seoCheck(cookie?: string) {
  return call(ctx, 'GET', '/staff/cms/seo-check', cookie === undefined ? {} : { cookie });
}

async function warningsOf(code?: SeoWarning['code']): Promise<SeoWarning[]> {
  const response = await seoCheck(world.editor.cookie);
  expect(response.statusCode).toBe(200);
  const warnings = response.json().warnings as SeoWarning[];
  return code === undefined ? warnings : warnings.filter((warning) => warning.code === code);
}

async function publishPage(
  pageType: Parameters<typeof seedPage>[1]['pageType'],
  path: string,
  content: unknown,
  meta: { metaTitle: string; metaDescription?: string },
): Promise<StaffCmsEntryDetail> {
  const detail = await seedPage(
    world,
    { pageType, path },
    { content, metaTitle: meta.metaTitle, metaDescription: meta.metaDescription ?? null },
  );
  return world.cms.publish(world.publisher.id, detail.id, { revisionId: detail.draft.revisionId });
}

describe('Phase 17 – SEO-Check (GET /staff/cms/seo-check)', () => {
  it('SEO-API1. Rechte: 401 ohne Anmeldung, 403 ohne CMS-Recht, 200 mit nur cms.edit bzw. nur cms.publish; no-store; leere Welt ⇒ keine Hinweise', async () => {
    expect((await seoCheck()).statusCode).toBe(401);
    expect((await seoCheck(world.viewer.cookie)).statusCode).toBe(403);
    for (const cookie of [world.editor.cookie, world.publisher.cookie]) {
      const response = await seoCheck(cookie);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.json();
      expect(typeof body.checkedAt).toBe('string');
      expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false);
      expect(body.warnings).toEqual([]);
    }
  });

  it('SEO-API2. Zwei veröffentlichte Seiten mit exakt gleichem Meta-Titel ⇒ je ein Hinweis (veröffentlicht) mit beiden Pfaden; neuer Entwurfstitel erzeugt keinen Entwurfs-Hinweis', async () => {
    const faq = await publishPage(
      'faq',
      '/faq',
      { title: 'Häufige Fragen', blocks: [TEXT_BLOCK] },
      { metaTitle: 'Slushmaschine mieten | Miet-Royal', metaDescription: DESCRIPTION_FAQ },
    );
    const about = await publishPage(
      'about',
      '/ueber-uns',
      { title: 'Über uns', blocks: [TEXT_BLOCK] },
      { metaTitle: ' slushmaschine MIETEN | Miet-Royal', metaDescription: DESCRIPTION_ABOUT },
    );
    const all = await warningsOf();
    expect(all).toEqual([
      {
        code: 'META_TITLE_DUPLICATE',
        scope: 'published',
        entryId: faq.id,
        path: '/faq',
        field: 'metaTitle',
        message:
          'Dieser Meta-Titel ist auf mehreren veröffentlichten Seiten identisch: /faq, /ueber-uns. Jede Seite braucht einen eigenen Meta-Titel.',
      },
      {
        code: 'META_TITLE_DUPLICATE',
        scope: 'published',
        entryId: about.id,
        path: '/ueber-uns',
        field: 'metaTitle',
        message:
          'Dieser Meta-Titel ist auf mehreren veröffentlichten Seiten identisch: /faq, /ueber-uns. Jede Seite braucht einen eigenen Meta-Titel.',
      },
    ]);
    // Redakteurin gibt der Über-uns-Seite einen eigenen Titel (nur Entwurf): veröffentlichte
    // Hinweise bleiben, kein Entwurfs-Hinweis.
    await world.cms.saveDraft(world.editor.id, about.id, {
      baseRevisionId: about.draft.revisionId,
      content: { title: 'Über uns', blocks: [TEXT_BLOCK] },
      metaTitle: 'Über uns – Familienbetrieb aus Mainz | Miet-Royal',
      metaDescription: DESCRIPTION_ABOUT,
    });
    const afterDraft = await warningsOf();
    expect(afterDraft.map((warning) => [warning.scope, warning.code])).toEqual([
      ['published', 'META_TITLE_DUPLICATE'],
      ['published', 'META_TITLE_DUPLICATE'],
    ]);
  });

  it('SEO-API3. Entwurf ohne Meta-Titel/-Beschreibung ⇒ Entwurfs-Hinweise mit Eintrags-ID; nach Pflege verschwinden sie', async () => {
    const region = await world.cms.createRegionPage(world.editor.id, {
      regionSlug: 'ingelheim',
      title: 'Slush in Ingelheim',
    });
    const before = await warningsOf();
    expect(before).toEqual([
      {
        code: 'META_DESCRIPTION_MISSING',
        scope: 'draft',
        entryId: region.id,
        path: '/slushmaschine-mieten/ingelheim',
        field: 'metaDescription',
        message:
          'Der Entwurf hat keine Meta-Beschreibung. Suchmaschinen zeigen dann einen beliebigen Textausschnitt der Seite.',
      },
      {
        code: 'META_TITLE_MISSING',
        scope: 'draft',
        entryId: region.id,
        path: '/slushmaschine-mieten/ingelheim',
        field: 'metaTitle',
        message:
          'Der Entwurf hat keinen Meta-Titel. Ohne Meta-Titel kann die Seite nicht veröffentlicht werden.',
      },
      {
        code: 'PAGE_EMPTY',
        scope: 'draft',
        entryId: region.id,
        path: '/slushmaschine-mieten/ingelheim',
        field: 'content',
        message: 'Der Entwurf hat außer dem Titel keinen Inhalt.',
      },
    ]);
    await world.cms.saveDraft(world.editor.id, region.id, {
      baseRevisionId: region.draft.revisionId,
      content: { title: 'Slush in Ingelheim', blocks: [TEXT_BLOCK] },
      metaTitle: 'Slushmaschine mieten in Ingelheim | Miet-Royal',
      metaDescription:
        'Slushmaschine für deine Feier in Ingelheim: abholen in Mainz-Hechtsheim oder Lieferung anfragen. Sirup inklusive.',
    });
    expect(await warningsOf()).toEqual([]);
  });

  it('SEO-API4. Interner Link auf eine nicht veröffentlichte Seite ⇒ Hinweis an der veröffentlichten Startseite; nach Veröffentlichung der Zielseite verschwindet er', async () => {
    const home = await publishPage(
      'home',
      '/',
      {
        title: 'Startseite',
        blocks: [
          {
            type: 'hero',
            heading: 'Slushmaschine mieten',
            primaryCta: { label: 'Slush konfigurieren', href: '/konfigurator' },
            secondaryCta: { label: 'Ingelheim', href: '/slushmaschine-mieten/ingelheim#start' },
          },
          {
            type: 'cta',
            heading: 'Weiter',
            primary: { label: 'Konto', href: '/konto/anmelden' },
            secondary: { label: 'FAQ', href: '/faq/' },
          },
        ],
      },
      {
        metaTitle: 'Slushmaschine mieten in Mainz | Miet-Royal',
        metaDescription: DESCRIPTION_HOME,
      },
    );
    // FAQ veröffentlicht, Regionsseite nur Entwurf
    await publishPage(
      'faq',
      '/faq',
      { title: 'Häufige Fragen', blocks: [TEXT_BLOCK] },
      {
        metaTitle: 'Häufige Fragen zur Slush-Miete | Miet-Royal',
        metaDescription: DESCRIPTION_FAQ,
      },
    );
    const region = await seedPage(
      world,
      { pageType: 'region', path: '/slushmaschine-mieten/ingelheim' },
      {
        content: { title: 'Slush in Ingelheim', blocks: [TEXT_BLOCK] },
        metaTitle: 'Slushmaschine mieten in Ingelheim | Miet-Royal',
        metaDescription:
          'Slushmaschine für deine Feier in Ingelheim: abholen in Mainz-Hechtsheim oder Lieferung anfragen. Sirup inklusive.',
      },
    );
    const broken = await warningsOf('BROKEN_INTERNAL_LINK');
    expect(broken).toEqual([
      {
        code: 'BROKEN_INTERNAL_LINK',
        scope: 'published',
        entryId: home.id,
        path: '/',
        field: 'links',
        message:
          'Der Link „/slushmaschine-mieten/ingelheim“ führt auf eine Seite, die derzeit nicht veröffentlicht ist. Die Website blendet diesen Link aus, bis die Seite veröffentlicht ist.',
      },
    ]);
    await world.cms.publish(world.publisher.id, region.id, {
      revisionId: region.draft.revisionId,
    });
    expect(await warningsOf('BROKEN_INTERNAL_LINK')).toEqual([]);
    // Zurückgezogen ⇒ der Hinweis kommt zurück.
    await world.cms.unpublish(world.publisher.id, region.id);
    expect(await warningsOf('BROKEN_INTERNAL_LINK')).toHaveLength(1);
  });

  it('SEO-API5. Produkt mit Preisangabe in Beschreibung, Name bzw. Verkaufseinheit ⇒ Katalog-Hinweise ohne Preis im Text mit Verweis auf die Produktverwaltung; inaktive Produkte bleiben außen vor', async () => {
    const touched = ['sirup-kirsche', 'slush-2x8', 'sirup-waldmeister', 'becher-25'];
    const originals = await ctx.db
      .select({
        slug: products.slug,
        name: products.name,
        description: products.description,
        saleUnit: products.saleUnit,
      })
      .from(products)
      .where(inArray(products.slug, touched));
    try {
      await ctx.db
        .update(products)
        .set({ description: 'Zuckerfrei. Flasche ab 12 €.' })
        .where(eq(products.slug, 'sirup-kirsche'));
      await ctx.db
        .update(products)
        .set({ name: '2×8 L – Tagesmiete 100,-' })
        .where(eq(products.slug, 'slush-2x8'));
      await ctx.db
        .update(products)
        .set({ description: 'EUR 12 je Flasche', active: false })
        .where(eq(products.slug, 'sirup-waldmeister'));
      // Review RC-1: Verkaufseinheit mit Preisangabe
      await ctx.db
        .update(products)
        .set({ saleUnit: '25er-Pack (ab 2,50 €)' })
        .where(eq(products.slug, 'becher-25'));
      const response = await seoCheck(world.publisher.cookie);
      expect(response.statusCode).toBe(200);
      expect(response.json().warnings).toEqual([
        {
          code: 'PRODUCT_DESCRIPTION_PRICE_HIDDEN',
          scope: 'catalog',
          entryId: null,
          path: null,
          field: 'description',
          message:
            'Die Beschreibung des Produkts „Sirup Kirsche“ enthält eine Preisangabe. Auf der Website wird die Beschreibung deshalb nicht angezeigt – Preise kommen ausschließlich aus der Produktverwaltung („Produkte & Preise“).',
        },
        {
          code: 'PRODUCT_NAME_PRICE_HIDDEN',
          scope: 'catalog',
          entryId: null,
          path: null,
          field: 'name',
          message:
            'Der Name des Produkts mit dem Kürzel „slush-2x8“ enthält eine Preisangabe. Das Produkt wird auf der Website deshalb nicht angezeigt – bitte den Namen in der Produktverwaltung („Produkte & Preise“) anpassen.',
        },
        {
          code: 'PRODUCT_UNIT_PRICE_HIDDEN',
          scope: 'catalog',
          entryId: null,
          path: null,
          field: 'saleUnit',
          message:
            'Die Verkaufseinheit des Produkts „Becher (25 Stück)“ enthält eine Preisangabe. Das Produkt wird auf der Website deshalb nicht angezeigt – bitte die Verkaufseinheit in der Produktverwaltung („Produkte & Preise“) anpassen.',
        },
      ]);
      for (const forbidden of ['12 €', '100,-', 'EUR 12', 'Tagesmiete', 'waldmeister', '2,50']) {
        expect(response.body, forbidden).not.toContain(forbidden);
      }
      // Dieselbe Projektion: der Becher-Pack fehlt in der Staff-Lesesicht „Produkte & Preise“.
      const staffCatalog = await call(ctx, 'GET', '/staff/cms/catalog', {
        cookie: world.viewer.cookie,
      });
      expect(staffCatalog.statusCode).toBe(200);
      expect(staffCatalog.json().accessories.map((item: { slug: string }) => item.slug)).toEqual([
        'strohhalme-25',
      ]);
      expect(staffCatalog.body).not.toContain('2,50');
    } finally {
      for (const original of originals) {
        await ctx.db
          .update(products)
          .set({
            name: original.name,
            description: original.description,
            saleUnit: original.saleUnit,
            active: true,
          })
          .where(eq(products.slug, original.slug));
      }
    }
  });

  it('SEO-API6. Standardinhalte nach cms:bootstrap --publish-demo ⇒ keine Hinweise; Ortsnamen-Kopie als Regions-Entwurf ⇒ Hinweis nur am Entwurf', async () => {
    const result = await runCmsBootstrap(ctx.db, {
      entries: CMS_BOOTSTRAP_ENTRIES,
      appEnv: 'development',
      publishDemo: true,
    });
    expect(result.invalid).toEqual([]);
    expect(result.publishFailed).toEqual([]);
    expect(result.published).toHaveLength(CMS_BOOTSTRAP_ENTRIES.length);
    // Phase 17: Standardinhalte starten ohne redaktionelle Hinweise (Slush-Titel 53 Zeichen).
    expect(await warningsOf()).toEqual([]);
    // Regionsseite als bloße Ortsnamen-Kopie von Mainz (Entwurf): Hinweis NUR am Entwurf,
    // die veröffentlichte Mainz-Seite bleibt ohne Hinweis.
    const mainz = CMS_BOOTSTRAP_ENTRIES.find(
      (entry) => entry.kind === 'page' && entry.path === '/slushmaschine-mieten/mainz',
    );
    if (mainz?.kind !== 'page') throw new Error('Bootstrap-Inhalt Mainz fehlt');
    const copy = await world.cms.createRegionPage(world.editor.id, {
      regionSlug: 'ingelheim',
      title: 'Slushmaschine mieten in Ingelheim',
    });
    const swapped = JSON.parse(
      JSON.stringify(mainz.content).replace(/Mainz(?!-Hechtsheim)/g, 'Ingelheim'),
    ) as unknown;
    await world.cms.saveDraft(world.editor.id, copy.id, {
      baseRevisionId: copy.draft.revisionId,
      content: swapped,
      metaTitle: 'Slushmaschine mieten in Ingelheim | Miet-Royal',
      metaDescription:
        'Slushmaschine mieten in Ingelheim: Abholung in Mainz-Hechtsheim, Lieferung auf Anfrage. Sirup, Becher und Strohhalme inklusive.',
    });
    const near = await warningsOf('REGION_NEAR_DUPLICATE');
    expect(near).toHaveLength(1);
    expect(near[0]).toMatchObject({
      scope: 'draft',
      entryId: copy.id,
      path: '/slushmaschine-mieten/ingelheim',
      field: 'content',
    });
    expect(near[0]!.message).toMatch(
      /^Der Text ähnelt stark der Regionsseite \/slushmaschine-mieten\/mainz \(Ähnlichkeit \d{2,3} %\)\. Regionsseiten brauchen eigenständige Inhalte – kein bloßer Ortsnamen-Tausch\.$/,
    );
    // Veröffentlicht ⇒ beide Seiten erhalten den Hinweis (scope published).
    const draft = await world.cms.getEntry(copy.id);
    await world.cms.publish(world.publisher.id, copy.id, { revisionId: draft.draft.revisionId });
    const published = await warningsOf('REGION_NEAR_DUPLICATE');
    expect(published.map((warning) => [warning.scope, warning.path])).toEqual([
      ['published', '/slushmaschine-mieten/ingelheim'],
      ['published', '/slushmaschine-mieten/mainz'],
    ]);
  });

  it('SEO-API7. Antwort enthält keine Redaktionsnotizen, Staff-IDs oder Texte – nur Pfade, Eintrags-IDs und Hinweise', async () => {
    const settings = await seedSiteSettings(world, SETTINGS_CONTENT);
    await world.cms.publish(world.publisher.id, settings.id, {
      revisionId: settings.draft.revisionId,
    });
    const faq = await seedPage(
      world,
      { pageType: 'faq', path: '/faq' },
      { content: { title: 'Häufige Fragen', blocks: [TEXT_BLOCK] }, metaTitle: 'Kurz' },
    );
    await world.cms.saveDraft(world.editor.id, faq.id, {
      baseRevisionId: faq.draft.revisionId,
      content: { title: 'Häufige Fragen', blocks: [TEXT_BLOCK] },
      metaTitle: 'Kurz',
      editorNote: 'INTERNE-NOTIZ-NICHT-IM-SEO-CHECK',
    });
    const response = await seoCheck(world.editor.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json().warnings.map((warning: SeoWarning) => warning.code)).toEqual([
      'META_DESCRIPTION_MISSING',
      'META_TITLE_SHORT',
    ]);
    for (const forbidden of [
      'INTERNE-NOTIZ',
      'editorNote',
      'Eigener redaktioneller Text',
      world.editor.id,
      world.publisher.id,
      world.adminId,
    ]) {
      expect(response.body, forbidden).not.toContain(forbidden);
    }
  });

  it('SEO-API9. Exakte Abholadresse nachträglich gepflegt: veröffentlichte Seite mit der Adresse im Titel liefert die Website nicht aus ⇒ Hinweis (ohne Adresse) und kaputter Link von der Startseite – dieselbe Entscheidung wie Bootstrap und Seitenabruf; nach Korrektur verschwinden beide (Review RC-4a)', async () => {
    const home = await publishPage(
      'home',
      '/',
      {
        title: 'Startseite',
        blocks: [
          {
            type: 'cta',
            heading: 'Weiter',
            primary: { label: 'Häufige Fragen', href: '/faq' },
            secondary: { label: 'Konfigurator', href: '/konfigurator' },
          },
        ],
      },
      {
        metaTitle: 'Slushmaschine mieten in Mainz | Miet-Royal',
        metaDescription: DESCRIPTION_HOME,
      },
    );
    // Zum Zeitpunkt der Veröffentlichung ist keine Abholadresse gepflegt ⇒ Titel zulässig.
    const faq = await publishPage(
      'faq',
      '/faq',
      { title: 'Häufige Fragen – Abholung Teststraße 1', blocks: [TEXT_BLOCK] },
      {
        metaTitle: 'Häufige Fragen zur Slush-Miete | Miet-Royal',
        metaDescription: DESCRIPTION_FAQ,
      },
    );
    expect(await warningsOf()).toEqual([]);
    expect(
      (await call(ctx, 'GET', '/public/site/settings'))
        .json()
        .pages.map((item: { path: string }) => item.path),
    ).toEqual(['/', '/faq']);
    // Adresse wird erst jetzt gepflegt ⇒ die Website liefert /faq fail-closed nicht mehr aus.
    await setStringSetting(ctx.db, world.adminId, PICKUP_EXACT_ADDRESS_KEY, CMS_TEST_EXACT_ADDRESS);
    const response = await seoCheck(world.editor.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json().warnings).toEqual([
      {
        code: 'BROKEN_INTERNAL_LINK',
        scope: 'published',
        entryId: home.id,
        path: '/',
        field: 'links',
        message:
          'Der Link „/faq“ führt auf eine Seite, die derzeit nicht veröffentlicht ist. Die Website blendet diesen Link aus, bis die Seite veröffentlicht ist.',
      },
      {
        code: 'PAGE_SUPPRESSED',
        scope: 'published',
        entryId: faq.id,
        path: '/faq',
        field: 'content',
        message:
          'Die veröffentlichte Seite wird auf der Website nicht ausgeliefert, weil Titel oder Meta-Titel die exakte Abholadresse enthalten.',
      },
    ]);
    expect(response.body.toLowerCase()).not.toContain('teststr');
    expect(response.body).not.toContain('55129');
    // Konsistenz mit der öffentlichen Projektion: Bootstrap ohne /faq, Seitenabruf 404.
    const site = await call(ctx, 'GET', '/public/site/settings');
    expect(site.json().pages.map((item: { path: string }) => item.path)).toEqual(['/']);
    expect((await call(ctx, 'GET', '/public/site/page?path=/faq')).statusCode).toBe(404);
    // Titel ohne Adresse veröffentlicht ⇒ Seite wieder erreichbar, beide Hinweise verschwinden.
    const current = await world.cms.getEntry(faq.id);
    await world.cms.saveDraft(world.editor.id, faq.id, {
      baseRevisionId: current.draft.revisionId,
      content: { title: 'Häufige Fragen', blocks: [TEXT_BLOCK] },
      metaTitle: 'Häufige Fragen zur Slush-Miete | Miet-Royal',
      metaDescription: DESCRIPTION_FAQ,
    });
    const corrected = await world.cms.getEntry(faq.id);
    await world.cms.publish(world.publisher.id, faq.id, {
      revisionId: corrected.draft.revisionId,
    });
    expect(await warningsOf()).toEqual([]);
    expect((await call(ctx, 'GET', '/public/site/page?path=/faq')).statusCode).toBe(200);
  });
});
