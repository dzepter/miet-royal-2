import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SiteFetchResult } from './site-api.ts';
import {
  FALLBACK_HOME_TITLE,
  NOINDEX_ROBOTS,
  UNAVAILABLE_TITLE,
  cmsRouteMetadataFor,
  configuratorMetadata,
  homeMetadata,
  siteRobots,
} from './site-meta.ts';
import type { PublicCatalog, PublicPage, SitePageType } from './site-types.ts';

/**
 * Phase 16 Review-Fixes (WEB, Design §1.7): Indexierungs-Entscheidung fail-closed –
 * Demo-Instanz immer noindex (demo_reviews-5), Fallback-Startseite / „nicht erreichbar“ /
 * Konfigurator ohne Maschinen immer noindex (web_security-2). Läuft mit `node --test`.
 */

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

describe('Indexierung fail-closed (Phase 16, Review-Fixes)', () => {
  it('W-I3. demo_reviews-5: Demo-Instanz ist IMMER noindex – auch mit WEB_INDEXING_ENABLED=true', () => {
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

  it('W-I4. web_security-2: Fallback-Startseite und „nicht erreichbar“ immer noindex; nur eine veröffentlichte Startseite erbt die Root-Freigabe', () => {
    const published = homeMetadata(ok(page('home')));
    assert.deepEqual(published, {
      title: 'Slushmaschine mieten in Mainz – Miet-Royal',
      description: 'Slushmaschinen für dein Event.',
    });
    assert.equal('robots' in published, false, 'veröffentlichte Startseite: Root-Robots gelten');

    // Nichts veröffentlicht ⇒ „Unsere neue Website wird gerade vorbereitet.“ ⇒ noindex.
    assert.deepEqual(homeMetadata(NOT_FOUND), {
      title: FALLBACK_HOME_TITLE,
      robots: { index: false, follow: false },
    });
    // Seite unter „/“ hat einen anderen Typ ⇒ die Seite zeigt den Fallback ⇒ noindex.
    assert.equal(homeMetadata(ok(page('faq'))).robots?.index, false);
    assert.equal(homeMetadata(UNAUTHORIZED).robots?.index, false);
    // API nicht erreichbar ⇒ „Gleich wieder da“ ⇒ noindex.
    assert.deepEqual(homeMetadata(UNAVAILABLE), {
      title: `${UNAVAILABLE_TITLE} – Miet-Royal`,
      robots: { index: false, follow: false },
    });
  });

  it('W-I5. CMS-Routen: nicht veröffentlicht/falscher Typ ⇒ 404 (null), „nicht erreichbar“ ⇒ noindex, Inhalt ⇒ CMS-Metadaten', () => {
    assert.equal(cmsRouteMetadataFor(NOT_FOUND, ['faq']), null);
    assert.equal(cmsRouteMetadataFor(ok(page('slush')), ['faq']), null);
    assert.deepEqual(cmsRouteMetadataFor(ok(page('faq', { metaTitle: null })), ['faq']), {
      title: 'Slushmaschine mieten – Miet-Royal',
      description: 'Slushmaschinen für dein Event.',
    });
    assert.deepEqual(cmsRouteMetadataFor(ok(page('region'))), {
      title: 'Slushmaschine mieten in Mainz – Miet-Royal',
      description: 'Slushmaschinen für dein Event.',
    });
    for (const failure of [UNAVAILABLE, UNAUTHORIZED]) {
      assert.deepEqual(cmsRouteMetadataFor(failure, ['faq']), {
        title: 'Gleich wieder da – Miet-Royal',
        robots: { index: false, follow: false },
      });
    }
  });

  it('W-I6. Konfigurator: Katalog weg oder keine wählbare Maschine ⇒ noindex; sonst Titel + Beschreibung', () => {
    const catalog = { machines: [{ slug: 'slush-1x8' }] } as unknown as PublicCatalog;
    const empty = { machines: [] } as unknown as PublicCatalog;
    assert.deepEqual(configuratorMetadata({ ok: true, data: catalog }), {
      title: 'Slush konfigurieren – Miet-Royal',
      description:
        'Stell dir in wenigen Schritten deine Slushmaschine mit Sirup und Zubehör zusammen und fordere ein unverbindliches Angebot an.',
    });
    assert.equal(configuratorMetadata({ ok: true, data: empty }).robots?.index, false);
    assert.equal(configuratorMetadata(UNAVAILABLE).robots?.index, false);
  });
});
