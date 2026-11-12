import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HOME_LABEL,
  SITE_NAV_ITEMS,
  breadcrumbItems,
  footerLegalLinks,
  isCurrentNavItem,
  isPrivacyPublished,
  isValidRegionSlug,
  pagesOfType,
  publishedPathSet,
  regionHrefForArea,
  resolveSiteHref,
  safeInstagramUrl,
  slugifyArea,
  visibleNavItems,
} from './site-nav.ts';
import type { PublicSitePageSummary } from './site-types.ts';

/**
 * Phase 16 (WEB, Design §5 „Navigation“, §11.3 „WEB“): Navigations- und Seitenlogik –
 * Links auf nicht veröffentlichte Seiten werden ausgeblendet; App-Seiten bleiben erreichbar.
 */

function page(
  path: string,
  pageType: PublicSitePageSummary['pageType'],
  title = path,
): PublicSitePageSummary {
  return { path, pageType, title, metaDescription: null };
}

const PAGES: PublicSitePageSummary[] = [
  page('/', 'home'),
  page('/slushmaschine-mieten', 'slush'),
  page('/faq', 'faq'),
  page('/datenschutz', 'legal'),
  page('/slushmaschine-mieten/mainz', 'region', 'Slushmaschine mieten in Mainz'),
  page('/slushmaschine-mieten/bad-kreuznach', 'region'),
  page('/popcornmaschine-mieten', 'secondary_offer'),
];

describe('Navigation und Seitenlogik (Phase 16)', () => {
  it('W-N1. Hauptnavigation: Reihenfolge laut Auftrag; CMS-Seiten nur, wenn veröffentlicht', () => {
    assert.deepEqual(
      SITE_NAV_ITEMS.map((item) => item.label),
      ['Start', 'Slush', 'Ablauf', 'FAQ', 'Über uns', 'Kontakt', 'Kundenbereich'],
    );
    const published = publishedPathSet(PAGES);
    assert.deepEqual(
      visibleNavItems(published).map((item) => item.href),
      ['/', '/slushmaschine-mieten', '/faq', '/konto'],
    );
    // Frische Umgebung ohne Inhalte: Start und Kundenbereich bleiben.
    assert.deepEqual(
      visibleNavItems(publishedPathSet([])).map((item) => item.label),
      ['Start', 'Kundenbereich'],
    );
    assert.deepEqual(publishedPathSet(null), new Set());
  });

  it('W-N2. aria-current: Start nur exakt, sonst auch Unterseiten', () => {
    assert.equal(isCurrentNavItem('/', '/'), true);
    assert.equal(isCurrentNavItem('/faq', '/'), false);
    assert.equal(isCurrentNavItem('/slushmaschine-mieten/mainz', '/slushmaschine-mieten'), true);
    assert.equal(isCurrentNavItem('/slushmaschine-mieten-xyz', '/slushmaschine-mieten'), false);
  });

  it('W-N3. CMS-Links: unveröffentlicht ⇒ ausgeblendet; App-Seiten immer; nur https/mailto/tel extern', () => {
    const published = publishedPathSet(PAGES);
    assert.deepEqual(resolveSiteHref('/faq', published), { kind: 'internal', href: '/faq' });
    assert.deepEqual(resolveSiteHref('/faq#preise', published), {
      kind: 'internal',
      href: '/faq#preise',
    });
    assert.equal(resolveSiteHref('/ablauf', published), null);
    assert.equal(resolveSiteHref('/ueber-uns/', published), null);
    assert.deepEqual(resolveSiteHref('/konfigurator', published), {
      kind: 'internal',
      href: '/konfigurator',
    });
    assert.deepEqual(resolveSiteHref('/konto/anmelden', published), {
      kind: 'internal',
      href: '/konto/anmelden',
    });
    assert.deepEqual(resolveSiteHref('/', publishedPathSet([])), { kind: 'internal', href: '/' });
    assert.deepEqual(resolveSiteHref('https://www.instagram.com/x', published), {
      kind: 'external',
      href: 'https://www.instagram.com/x',
    });
    assert.deepEqual(resolveSiteHref('mailto:info@example.org', published), {
      kind: 'contact',
      href: 'mailto:info@example.org',
    });
    assert.deepEqual(resolveSiteHref('tel:+4961310000', published), {
      kind: 'contact',
      href: 'tel:+4961310000',
    });
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'http://example.org',
      '//evil.example',
      'https://user:pw@example.org',
      'ftp://example.org',
    ]) {
      assert.equal(resolveSiteHref(bad, published), null, bad);
    }
  });

  it('W-N4. Footer: Impressum/Datenschutz nur, wenn veröffentlicht; Datenschutz steuert das Absenden', () => {
    assert.deepEqual(
      footerLegalLinks(publishedPathSet(PAGES)).map((item) => item.href),
      ['/datenschutz'],
    );
    assert.deepEqual(footerLegalLinks(publishedPathSet([])), []);
    assert.equal(isPrivacyPublished(PAGES), true);
    assert.equal(isPrivacyPublished(PAGES.filter((p) => p.path !== '/datenschutz')), false);
    assert.equal(isPrivacyPublished([page('/datenschutz', 'faq')]), false);
    assert.equal(isPrivacyPublished(null), false);
  });

  it('W-N5. Regionen/Einsatzgebiete: Link nur auf veröffentlichte Regionsseite mit passendem Slug', () => {
    assert.equal(slugifyArea('Bad Kreuznach'), 'bad-kreuznach');
    assert.equal(slugifyArea('Mainz-Hechtsheim'), 'mainz-hechtsheim');
    assert.equal(slugifyArea('Rüsselsheim am Main'), 'ruesselsheim-am-main');
    assert.equal(slugifyArea('  Groß-Gerau '), 'gross-gerau');
    assert.equal(regionHrefForArea('Mainz', PAGES), '/slushmaschine-mieten/mainz');
    assert.equal(regionHrefForArea('Bad Kreuznach', PAGES), '/slushmaschine-mieten/bad-kreuznach');
    assert.equal(regionHrefForArea('Wiesbaden', PAGES), null);
    assert.equal(regionHrefForArea('', PAGES), null);
    assert.deepEqual(
      pagesOfType(PAGES, 'secondary_offer').map((p) => p.path),
      ['/popcornmaschine-mieten'],
    );
    assert.equal(isValidRegionSlug('bad-kreuznach'), true);
    assert.equal(isValidRegionSlug('Mainz'), false);
    assert.equal(isValidRegionSlug('a'), false);
    assert.equal(isValidRegionSlug('mainz--x'), false);
    assert.equal(isValidRegionSlug('x'.repeat(61)), false);
  });

  it('W-N6. Instagram nur als https-Link auf instagram.com', () => {
    assert.equal(
      safeInstagramUrl('https://www.instagram.com/miet.royal/'),
      'https://www.instagram.com/miet.royal/',
    );
    assert.equal(safeInstagramUrl('https://instagram.com/x'), 'https://instagram.com/x');
    assert.equal(safeInstagramUrl('http://www.instagram.com/x'), null);
    assert.equal(safeInstagramUrl('https://instagram.com.evil.example/x'), null);
    assert.equal(safeInstagramUrl('javascript:alert(1)'), null);
    assert.equal(safeInstagramUrl(null), null);
  });

  it('SEO-W15. Brotkrume (Phase 17, D11): Region = Start › Slush-Seite (nur veröffentlicht, mit ihrem Titel) › Seitentitel; Secondary Offer = Start › Seitentitel; sonst keine', () => {
    const region = {
      pageType: 'region',
      title: 'Slushmaschine mieten in Mainz',
      path: '/slushmaschine-mieten/mainz',
    } as const;
    const withSlush = [
      page('/', 'home'),
      page('/slushmaschine-mieten', 'slush', 'Slushmaschine mieten'),
      page('/slushmaschine-mieten/mainz', 'region', region.title),
    ];
    const withoutSlush = [page('/', 'home'), page('/faq', 'faq')];
    assert.equal(HOME_LABEL, 'Start');
    assert.deepEqual(breadcrumbItems(region, withSlush), [
      { name: 'Start', href: '/' },
      { name: 'Slushmaschine mieten', href: '/slushmaschine-mieten' },
      { name: 'Slushmaschine mieten in Mainz', href: '/slushmaschine-mieten/mainz' },
    ]);
    // Slush-Seite nicht veröffentlicht ⇒ Elternteil entfällt (kein Link auf eine 404-Seite).
    assert.deepEqual(breadcrumbItems(region, withoutSlush), [
      { name: 'Start', href: '/' },
      { name: 'Slushmaschine mieten in Mainz', href: '/slushmaschine-mieten/mainz' },
    ]);
    assert.equal(breadcrumbItems(region, null).length, 2);
    // Der Pfad /slushmaschine-mieten zählt nur mit Seitentyp slush (sonst liefert die Route 404).
    assert.equal(breadcrumbItems(region, [page('/slushmaschine-mieten', 'faq', 'X')]).length, 2);
    assert.deepEqual(
      breadcrumbItems(
        {
          pageType: 'secondary_offer',
          title: 'Popcornmaschine mieten',
          path: '/popcornmaschine-mieten',
        },
        withSlush,
      ),
      [
        { name: 'Start', href: '/' },
        { name: 'Popcornmaschine mieten', href: '/popcornmaschine-mieten' },
      ],
    );
    for (const pageType of ['home', 'slush', 'process', 'faq', 'about', 'contact', 'legal']) {
      assert.deepEqual(breadcrumbItems({ pageType, title: 'X', path: '/x' }, withSlush), []);
    }
  });
});
