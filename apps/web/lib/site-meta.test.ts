import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SiteFetchResult } from './site-api.ts';
import {
  CONFIGURATOR_DESCRIPTION,
  FALLBACK_HOME_TITLE,
  NOINDEX_ROBOTS,
  NOT_FOUND_TITLE,
  UNAVAILABLE_TITLE,
  cmsRouteMetadataFor,
  configuratorMetadata,
  homeMetadata,
  notFoundMetadata,
  seoEnvFrom,
  siteRobots,
  type SeoEnv,
  readProductionWebEnv,
} from './site-meta.ts';
import type { PublicCatalog, PublicPage, PublicSiteBootstrap, SitePageType } from './site-types.ts';

/**
 * Phase 16 Review-Fixes (WEB, Design §1.7) und Phase 17 (WEB-META, Design D2/D3/D9):
 * Indexierungs-Entscheidung fail-closed – Demo-Instanz immer noindex (demo_reviews-5),
 * Fallback-Startseite / „nicht erreichbar“ / 404 / Konfigurator ohne Maschinen immer noindex
 * (web_security-2); Canonical, og:url nur im indexierbaren Kontext. Läuft mit `node --test`.
 */

const BASE = 'https://www.miet-royal.de';
const INDEXABLE: SeoEnv = { indexable: true, base: BASE, siteName: 'Miet-Royal' };
const CLOSED: SeoEnv = { indexable: false, base: null, siteName: 'Miet-Royal' };

function page(pageType: SitePageType, overrides: Partial<PublicPage> = {}): PublicPage {
  return {
    path: '/',
    pageType,
    revisionId: '7f3c1b2a-0000-4000-8000-000000000001',
    publishedAt: '2026-11-01T10:00:00.000Z',
    title: 'Slushmaschine mieten',
    metaTitle: 'Slushmaschine mieten in Mainz',
    metaDescription: 'Slushmaschinen für dein Event.',
    blocks: [],
    ...overrides,
  };
}

const ok = (data: PublicPage): SiteFetchResult<PublicPage> => ({ ok: true, data });
const NOT_FOUND: SiteFetchResult<never> = { ok: false, reason: 'not_found' };
const UNAVAILABLE: SiteFetchResult<never> = { ok: false, reason: 'unavailable' };
const UNAUTHORIZED: SiteFetchResult<never> = { ok: false, reason: 'unauthorized' };

function bootstrap(
  overrides: Partial<PublicSiteBootstrap> = {},
): SiteFetchResult<PublicSiteBootstrap> {
  return {
    ok: true,
    data: {
      environment: 'production',
      settings: {
        businessName: 'Miet-Royal GmbH',
        tagline: null,
        phone: null,
        email: null,
        instagramUrl: null,
        logo: null,
        footerNote: null,
      },
      pages: [],
      reviews: { mode: 'disabled' },
      pickupArea: 'Mainz-Hechtsheim',
      publicBaseUrl: BASE,
      ...overrides,
    },
  };
}

describe('Indexierung fail-closed (Phase 16 Review-Fixes, Phase 17 SEO)', () => {
  it('W-I3. demo_reviews-5: Teilentscheidung Schalter/Demo – Demo-Instanz ist IMMER noindex, auch mit WEB_INDEXING_ENABLED=true', () => {
    assert.deepEqual(siteRobots({ indexingEnabled: true, demo: true }), NOINDEX_ROBOTS);
    assert.deepEqual(siteRobots({ indexingEnabled: false, demo: true }), NOINDEX_ROBOTS);
    assert.deepEqual(siteRobots({ indexingEnabled: false, demo: false }), NOINDEX_ROBOTS);
    assert.deepEqual(siteRobots({ indexingEnabled: true, demo: false }), {
      index: true,
      follow: true,
    });
    // Eigene Kopie – Aufrufer können NOINDEX_ROBOTS nicht verändern.
    assert.notEqual(siteRobots({ indexingEnabled: true, demo: true }), NOINDEX_ROBOTS);
  });

  it('W-I4. web_security-2: Fallback-Startseite und „nicht erreichbar“ immer noindex ohne Canonical; nur eine veröffentlichte Startseite ist im offenen Kontext indexierbar', () => {
    const published = homeMetadata(ok(page('home')), INDEXABLE);
    assert.equal(published.title, 'Slushmaschine mieten in Mainz – Miet-Royal');
    assert.equal(published.description, 'Slushmaschinen für dein Event.');
    assert.deepEqual(published.robots, { index: true, follow: true });
    assert.deepEqual(published.alternates, { canonical: `${BASE}/` });
    assert.equal(published.openGraph?.url, `${BASE}/`);
    assert.equal(published.openGraph?.siteName, 'Miet-Royal');
    assert.equal(published.twitter?.card, 'summary');

    // Dieselbe Seite im geschlossenen Kontext (Schalter aus, Demo, keine Basis, Origin-Sperre):
    // noindex, kein Canonical, kein og:url – Titel/Beschreibung bleiben.
    const closed = homeMetadata(ok(page('home')), CLOSED);
    assert.equal(closed.title, 'Slushmaschine mieten in Mainz – Miet-Royal');
    assert.deepEqual(closed.robots, NOINDEX_ROBOTS);
    assert.equal('alternates' in closed, false);
    assert.equal(closed.openGraph?.url, undefined);

    // Nichts veröffentlicht ⇒ „Unsere neue Website wird gerade vorbereitet.“ ⇒ noindex, auch im
    // offenen Kontext; keine Canonical-/OpenGraph-Felder.
    assert.deepEqual(homeMetadata(NOT_FOUND, INDEXABLE), {
      title: FALLBACK_HOME_TITLE,
      robots: { index: false, follow: false },
    });
    // Seite unter „/“ hat einen anderen Typ ⇒ die Seite zeigt den Fallback ⇒ noindex.
    assert.deepEqual(homeMetadata(ok(page('faq')), INDEXABLE).robots, NOINDEX_ROBOTS);
    assert.deepEqual(homeMetadata(UNAUTHORIZED, INDEXABLE).robots, NOINDEX_ROBOTS);
    // API nicht erreichbar ⇒ „Gleich wieder da“ ⇒ noindex.
    assert.deepEqual(homeMetadata(UNAVAILABLE, INDEXABLE), {
      title: `${UNAVAILABLE_TITLE} – Miet-Royal`,
      robots: { index: false, follow: false },
    });
  });

  it('W-I5. CMS-Routen: nicht veröffentlicht/falscher Typ ⇒ 404 (null), „nicht erreichbar“ ⇒ noindex, Inhalt ⇒ CMS-Metadaten mit Self-Canonical', () => {
    assert.equal(cmsRouteMetadataFor(NOT_FOUND, ['faq'], INDEXABLE), null);
    assert.equal(cmsRouteMetadataFor(ok(page('slush')), ['faq'], INDEXABLE), null);
    const faq = cmsRouteMetadataFor(
      ok(page('faq', { path: '/faq', metaTitle: null })),
      ['faq'],
      INDEXABLE,
    );
    assert.equal(faq?.title, 'Slushmaschine mieten – Miet-Royal');
    assert.equal(faq?.description, 'Slushmaschinen für dein Event.');
    assert.deepEqual(faq?.alternates, { canonical: `${BASE}/faq` });
    // Regionsseite: Self-Canonical auf den eigenen Pfad (keine Duplicate-Canonical auf Mainz).
    const region = cmsRouteMetadataFor(
      ok(page('region', { path: '/slushmaschine-mieten/bad-kreuznach' })),
      undefined,
      INDEXABLE,
    );
    assert.deepEqual(region?.alternates, {
      canonical: `${BASE}/slushmaschine-mieten/bad-kreuznach`,
    });
    assert.deepEqual(region?.openGraph, {
      title: 'Slushmaschine mieten in Mainz – Miet-Royal',
      description: 'Slushmaschinen für dein Event.',
      type: 'website',
      locale: 'de_DE',
      siteName: 'Miet-Royal',
      url: `${BASE}/slushmaschine-mieten/bad-kreuznach`,
    });
    assert.deepEqual(region?.twitter, {
      card: 'summary',
      title: 'Slushmaschine mieten in Mainz – Miet-Royal',
      description: 'Slushmaschinen für dein Event.',
    });
    // Geschlossener Kontext: Inhalt bleibt, aber noindex ohne Canonical.
    const closed = cmsRouteMetadataFor(ok(page('faq', { path: '/faq' })), ['faq'], CLOSED);
    assert.deepEqual(closed?.robots, NOINDEX_ROBOTS);
    assert.equal(closed !== null && 'alternates' in closed, false);
    for (const failure of [UNAVAILABLE, UNAUTHORIZED]) {
      assert.deepEqual(cmsRouteMetadataFor(failure, ['faq'], INDEXABLE), {
        title: 'Gleich wieder da – Miet-Royal',
        robots: { index: false, follow: false },
      });
    }
  });

  it('W-I6. Konfigurator: Katalog weg, keine Maschine, Datenschutz nicht veröffentlicht oder Origin-Sperre ⇒ noindex ohne Canonical; sonst Titel + Beschreibung + Canonical /konfigurator', () => {
    const catalog = { machines: [{ slug: 'slush-1x8' }] } as unknown as PublicCatalog;
    const empty = { machines: [] } as unknown as PublicCatalog;
    const usable = { ...INDEXABLE, privacyPublished: true, originMismatch: false };
    const meta = configuratorMetadata({ ok: true, data: catalog }, usable);
    assert.equal(meta.title, 'Slush konfigurieren – Miet-Royal');
    assert.equal(meta.description, CONFIGURATOR_DESCRIPTION);
    assert.deepEqual(meta.robots, { index: true, follow: true });
    assert.deepEqual(meta.alternates, { canonical: `${BASE}/konfigurator` });
    assert.equal(meta.openGraph?.url, `${BASE}/konfigurator`);
    assert.equal('images' in (meta.openGraph ?? {}), false);
    for (const closed of [
      configuratorMetadata({ ok: true, data: empty }, usable),
      configuratorMetadata(UNAVAILABLE, usable),
      configuratorMetadata({ ok: true, data: catalog }, { ...usable, privacyPublished: false }),
      configuratorMetadata({ ok: true, data: catalog }, { ...usable, originMismatch: true }),
      configuratorMetadata({ ok: true, data: catalog }, { ...usable, ...CLOSED }),
    ]) {
      assert.deepEqual(closed.robots, NOINDEX_ROBOTS);
      assert.equal('alternates' in closed, false);
      assert.equal(closed.openGraph?.url, undefined);
      assert.equal(closed.title, 'Slush konfigurieren – Miet-Royal');
      assert.equal(closed.description, CONFIGURATOR_DESCRIPTION);
    }
  });

  it('SEO-W13. 404: eigener Titel „Seite nicht gefunden – Miet-Royal“, immer noindex/nofollow, kein Canonical', () => {
    assert.deepEqual(notFoundMetadata(), {
      title: `${NOT_FOUND_TITLE} – Miet-Royal`,
      robots: { index: false, follow: false },
    });
    assert.equal(notFoundMetadata().title, 'Seite nicht gefunden – Miet-Royal');
  });

  it('SEO-W14. seoEnvFrom: Basis NUR aus dem Bootstrap (publicBaseUrl), Demo auch über environment, Origin-Sperre, ohne Bootstrap keine Basis; Markenname aus den Einstellungen', () => {
    assert.deepEqual(seoEnvFrom(bootstrap(), false, false, true), {
      indexable: true,
      base: BASE,
      siteName: 'Miet-Royal GmbH',
    });
    // Schalter aus ⇒ nicht indexierbar, keine Basis.
    assert.deepEqual(seoEnvFrom(bootstrap(), false, false, false), {
      indexable: false,
      base: null,
      siteName: 'Miet-Royal GmbH',
    });
    // Demo über WEB_APP_ENV bzw. /health ODER über das Bootstrap-Environment.
    assert.equal(seoEnvFrom(bootstrap(), true, false, true).indexable, false);
    assert.equal(
      seoEnvFrom(bootstrap({ environment: 'demo' }), false, false, true).indexable,
      false,
    );
    // Origin-Sperre.
    assert.equal(seoEnvFrom(bootstrap(), false, true, true).indexable, false);
    // Keine oder ungültige Basis (http-Fremdhost) ⇒ fail-closed; keine erfundene Domain.
    assert.deepEqual(seoEnvFrom(bootstrap({ publicBaseUrl: null }), false, false, true), {
      indexable: false,
      base: null,
      siteName: 'Miet-Royal GmbH',
    });
    assert.equal(
      seoEnvFrom(bootstrap({ publicBaseUrl: 'http://www.miet-royal.de' }), false, false, true)
        .indexable,
      false,
    );
    // Antwort einer älteren API ohne das Feld ⇒ ebenfalls fail-closed.
    const legacy = bootstrap();
    if (legacy.ok) delete legacy.data.publicBaseUrl;
    assert.equal(seoEnvFrom(legacy, false, false, true).indexable, false);
    // Bootstrap nicht erreichbar ⇒ keine Basis, Standard-Markenname.
    assert.deepEqual(seoEnvFrom(UNAVAILABLE, false, false, true), {
      indexable: false,
      base: null,
      siteName: 'Miet-Royal',
    });
  });
  it('SEO-W18. seoEnvFrom: production (WEB_APP_ENV oder Bootstrap-Environment) ⇒ http-Basis fail-closed, https-Basis bleibt; readProductionWebEnv nur exakt „production“', () => {
    assert.equal(readProductionWebEnv('production'), true);
    assert.equal(readProductionWebEnv(' production '), true);
    assert.equal(readProductionWebEnv('Production'), false);
    assert.equal(readProductionWebEnv('staging'), false);
    assert.equal(readProductionWebEnv(undefined), false);
    // Der Test-Bootstrap ist `environment: 'production'` – lokale Basis nur in development gültig.
    const local = bootstrap({ publicBaseUrl: 'http://localhost:3000', environment: 'development' });
    assert.equal(seoEnvFrom(local, false, false, true, false).indexable, true);
    assert.equal(seoEnvFrom(local, false, false, true, true).indexable, false);
    assert.equal(seoEnvFrom(local, false, false, true, true).base, null);
    assert.equal(
      seoEnvFrom(
        bootstrap({ publicBaseUrl: 'http://localhost:3000', environment: 'production' }),
        false,
        false,
        true,
        false,
      ).indexable,
      false,
    );
    assert.equal(seoEnvFrom(bootstrap(), false, false, true, true).base, BASE);
  });
});
