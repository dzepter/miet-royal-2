import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ROBOTS_DISALLOW_PATHS,
  absoluteMediaUrl,
  buildSiteMetadata,
  canonicalUrl,
  configuratorIndexable,
  normalizeSeoPath,
  robotsRules,
  seoContext,
  seoImageFrom,
  sitemapEntries,
  socialImage,
  validIsoDate,
  validSeoBaseUrl,
} from './site-seo.ts';
import type { PublicImage, PublicPage, PublicSitePageSummary, SitePageType } from './site-types.ts';

/**
 * Phase 17 (WEB-META, Design D1–D3, D7–D9): kanonische Basis, Indexierbarkeit fail-closed,
 * Canonicals, Social Image, Metadaten, robots.txt und Sitemap – reine Funktionen (node --test).
 */

const BASE = 'https://www.miet-royal.de';
const MEDIA = '2b7c9a7e-3a1f-4c55-9f0e-1a2b3c4d5e6f';
const variant = (width: number, kind = 'media') => ({
  width,
  url: `/api/public/cms/${kind}/${MEDIA}/${width}`,
});
const IMAGE: PublicImage = {
  mediaId: MEDIA,
  alt: 'Slushmaschine am Buffet',
  decorative: false,
  width: 2000,
  height: 1500,
  variants: [variant(480), variant(1600), variant(960)],
};
const SOCIAL = {
  url: `${BASE}/api/public/cms/media/${MEDIA}/1600`,
  width: 1600,
  height: 1200,
  alt: 'Slushmaschine am Buffet',
};

function page(overrides: Partial<PublicPage> = {}): PublicPage {
  return {
    path: '/slushmaschine-mieten/mainz',
    pageType: 'region',
    revisionId: '7f3c1b2a-0000-4000-8000-000000000001',
    publishedAt: '2026-11-01T10:00:00.000Z',
    title: 'Slushmaschine mieten in Mainz',
    metaTitle: null,
    metaDescription: 'Slush für dein Event in Mainz.',
    blocks: [{ type: 'hero', heading: 'Slush in Mainz', image: IMAGE }],
    ...overrides,
  };
}

function summary(
  path: string,
  pageType: SitePageType,
  publishedAt?: string,
): PublicSitePageSummary {
  return {
    path,
    pageType,
    title: path,
    metaDescription: null,
    ...(publishedAt === undefined ? {} : { publishedAt }),
  };
}

describe('SEO-Basis und Indexierbarkeit (Phase 17, Design D1–D3)', () => {
  it('SEO-W1. Gültige Basis: nur https (http nur localhost/127.0.0.1), ohne Zugangsdaten, Query, Fragment oder Pfad; Rückgabe ohne Schluss-Slash', () => {
    assert.equal(validSeoBaseUrl('https://www.miet-royal.de'), BASE);
    assert.equal(validSeoBaseUrl('https://www.miet-royal.de/'), BASE);
    assert.equal(validSeoBaseUrl('  HTTPS://WWW.Miet-Royal.de/  '), BASE);
    assert.equal(
      validSeoBaseUrl('https://www.miet-royal.de:8443'),
      'https://www.miet-royal.de:8443',
    );
    assert.equal(validSeoBaseUrl('http://localhost:3000'), 'http://localhost:3000');
    assert.equal(validSeoBaseUrl('http://127.0.0.1:3997/'), 'http://127.0.0.1:3997');
    for (const invalid of [
      'http://www.miet-royal.de',
      'http://staging.example.org:3000',
      'https://user:pw@www.miet-royal.de',
      'https://user@www.miet-royal.de',
      'https://www.miet-royal.de/?utm=1',
      'https://www.miet-royal.de/#top',
      'https://www.miet-royal.de/start',
      'https://www.miet-royal.de//',
      'ftp://www.miet-royal.de',
      'www.miet-royal.de',
      '//www.miet-royal.de',
      'https://',
      '',
      '   ',
      'https://www.miet-royal.de /',
      'javascript:alert(1)',
    ]) {
      assert.equal(validSeoBaseUrl(invalid), null, `ungültig: ${JSON.stringify(invalid)}`);
    }
    assert.equal(validSeoBaseUrl(null), null);
    assert.equal(validSeoBaseUrl(undefined), null);
  });

  it('SEO-W2. seoContext fail-closed: Schalter aus, Demo, Origin-Sperre oder fehlende/ungültige Basis ⇒ nicht indexierbar UND keine Basis', () => {
    const on = { indexingEnabled: true, demo: false, originMismatch: false, base: BASE };
    assert.deepEqual(seoContext(on), { indexable: true, base: BASE });
    assert.deepEqual(seoContext({ ...on, indexingEnabled: false }), {
      indexable: false,
      base: null,
    });
    assert.deepEqual(seoContext({ ...on, demo: true }), { indexable: false, base: null });
    assert.deepEqual(seoContext({ ...on, originMismatch: true }), { indexable: false, base: null });
    assert.deepEqual(seoContext({ ...on, base: null }), { indexable: false, base: null });
    assert.deepEqual(seoContext({ ...on, base: undefined }), { indexable: false, base: null });
    assert.deepEqual(seoContext({ ...on, base: 'http://www.miet-royal.de' }), {
      indexable: false,
      base: null,
    });
    // Die Basis wird auch hier normalisiert (Schluss-Slash entfällt).
    assert.deepEqual(seoContext({ ...on, base: `${BASE}/` }), { indexable: true, base: BASE });
  });

  it('SEO-W3. Canonical: absolut aus Basis + Pfad; Query/Fragment und Schluss-Slash entfernt (außer Startseite); Konfigurator ohne ?maschine', () => {
    assert.equal(canonicalUrl(BASE, '/'), `${BASE}/`);
    assert.equal(canonicalUrl(BASE, ''), `${BASE}/`);
    assert.equal(canonicalUrl(BASE, '/faq'), `${BASE}/faq`);
    assert.equal(canonicalUrl(BASE, '/faq/'), `${BASE}/faq`);
    assert.equal(canonicalUrl(BASE, '/konfigurator?maschine=slush-1x8'), `${BASE}/konfigurator`);
    assert.equal(
      canonicalUrl(BASE, '/slushmaschine-mieten/mainz#inhalt'),
      `${BASE}/slushmaschine-mieten/mainz`,
    );
    assert.equal(canonicalUrl(BASE, 'ablauf'), `${BASE}/ablauf`);
    assert.equal(normalizeSeoPath('//faq//'), '/faq');
    assert.equal(normalizeSeoPath('/?x=1'), '/');
  });

  it('SEO-W4. Konfigurator nutzbar nur mit Katalog, ≥ 1 Maschine, veröffentlichtem Datenschutz und ohne Origin-Sperre', () => {
    const ok = { catalogOk: true, machineCount: 2, privacyPublished: true, originMismatch: false };
    assert.equal(configuratorIndexable(ok), true);
    assert.equal(configuratorIndexable({ ...ok, catalogOk: false }), false);
    assert.equal(configuratorIndexable({ ...ok, machineCount: 0 }), false);
    assert.equal(configuratorIndexable({ ...ok, privacyPublished: false }), false);
    assert.equal(configuratorIndexable({ ...ok, originMismatch: true }), false);
  });
});

describe('Metadaten, Social Image, robots.txt und Sitemap (Phase 17, Design D7–D9)', () => {
  it('SEO-W5. Social Image nur aus dem Hero-Bild an erster Stelle: größte eigene veröffentlichte Variante, Höhe proportional, alt nur wenn nicht dekorativ', () => {
    assert.deepEqual(socialImage(page(), BASE), SOCIAL);
    // Dekorativ ⇒ ohne alt.
    assert.deepEqual(
      socialImage(
        page({ blocks: [{ type: 'hero', heading: 'H', image: { ...IMAGE, decorative: true } }] }),
        BASE,
      ),
      { url: SOCIAL.url, width: 1600, height: 1200 },
    );
    // Hero ohne Bild, Hero nicht an erster Stelle, kein Hero, keine Blöcke ⇒ kein Bild erfinden.
    assert.equal(socialImage(page({ blocks: [{ type: 'hero', heading: 'H' }] }), BASE), null);
    assert.equal(
      socialImage(
        page({
          blocks: [
            { type: 'text', body: 'Hallo' },
            { type: 'hero', heading: 'H', image: IMAGE },
          ],
        }),
        BASE,
      ),
      null,
    );
    assert.equal(socialImage(page({ blocks: [{ type: 'image', image: IMAGE }] }), BASE), null);
    assert.equal(socialImage(page({ blocks: [] }), BASE), null);
    // Ohne Basis ⇒ kein Bild (keine relativen oder erfundenen URLs).
    assert.equal(socialImage(page(), null), null);
    // Nur eigene VERÖFFENTLICHTE Medien-URLs – nie Vorschau-Medien oder fremde Hosts.
    assert.equal(
      absoluteMediaUrl(BASE, `/api/public/cms/media/${MEDIA}/960`),
      SOCIAL.url.replace('1600', '960'),
    );
    assert.equal(absoluteMediaUrl(BASE, `/api/public/cms/preview-media/${MEDIA}/960`), null);
    assert.equal(absoluteMediaUrl(BASE, 'https://evil.example/x.png'), null);
    assert.equal(absoluteMediaUrl(BASE, '/uploads/x.png'), null);
    assert.equal(seoImageFrom({ ...IMAGE, variants: [variant(480, 'preview-media')] }, BASE), null);
    assert.equal(seoImageFrom({ ...IMAGE, variants: [] }, BASE), null);
    assert.equal(seoImageFrom({ ...IMAGE, width: 0 }, BASE), null);
  });

  it('SEO-W6. buildSiteMetadata: Canonical/og:url/Bild nur indexierbar; OpenGraph/Twitter immer; keine Keywords; keine Markendoppelung', () => {
    const input = {
      title: 'Slushmaschine mieten in Mainz – Miet-Royal',
      description: ' Slush für dein Event. ',
      path: '/slushmaschine-mieten/mainz',
      indexable: true,
      base: BASE,
      siteName: 'Miet-Royal',
      image: SOCIAL,
    };
    const indexable = buildSiteMetadata(input);
    assert.deepEqual(indexable, {
      title: 'Slushmaschine mieten in Mainz – Miet-Royal',
      description: 'Slush für dein Event.',
      robots: { index: true, follow: true },
      alternates: { canonical: `${BASE}/slushmaschine-mieten/mainz` },
      openGraph: {
        title: 'Slushmaschine mieten in Mainz – Miet-Royal',
        description: 'Slush für dein Event.',
        type: 'website',
        locale: 'de_DE',
        siteName: 'Miet-Royal',
        url: `${BASE}/slushmaschine-mieten/mainz`,
        images: [SOCIAL],
      },
      twitter: {
        card: 'summary_large_image',
        title: 'Slushmaschine mieten in Mainz – Miet-Royal',
        description: 'Slush für dein Event.',
        images: [SOCIAL],
      },
    });
    assert.equal('keywords' in indexable, false);
    assert.doesNotMatch(indexable.title, /Miet-Royal.*Miet-Royal/);
    assert.doesNotMatch(indexable.openGraph?.title ?? '', /Miet-Royal.*Miet-Royal/);

    // Nicht indexierbar (Schalter aus, Demo, …) trotz Basis: noindex, kein Canonical, kein
    // og:url, kein Bild (keine absoluten URLs), Twitter-Karte „summary“.
    const closed = buildSiteMetadata({ ...input, indexable: false });
    assert.deepEqual(closed.robots, { index: false, follow: false });
    assert.equal('alternates' in closed, false);
    assert.equal('url' in (closed.openGraph ?? {}), false);
    assert.equal('images' in (closed.openGraph ?? {}), false);
    assert.equal(closed.twitter?.card, 'summary');
    assert.equal('images' in (closed.twitter ?? {}), false);
    assert.equal(closed.openGraph?.siteName, 'Miet-Royal');
    // „Indexierbar“ ohne Basis darf nicht vorkommen – trotzdem keine absoluten URLs.
    const noBase = buildSiteMetadata({ ...input, base: null });
    assert.equal('alternates' in noBase, false);
    assert.equal('url' in (noBase.openGraph ?? {}), false);
    // Ohne Beschreibung fehlt das Feld überall (keine erfundene Beschreibung).
    const bare = buildSiteMetadata({
      title: 'FAQ – Miet-Royal',
      description: null,
      path: '/faq',
      indexable: true,
      base: BASE,
      siteName: 'Miet-Royal',
    });
    assert.equal('description' in bare, false);
    assert.equal('description' in (bare.openGraph ?? {}), false);
    assert.deepEqual(bare.twitter, { card: 'summary', title: 'FAQ – Miet-Royal' });
    assert.deepEqual(bare.alternates, { canonical: `${BASE}/faq` });
  });

  it('SEO-W7. robots.txt: nicht indexierbar ⇒ „Disallow: /“ ohne Sitemap; indexierbar ⇒ „Allow: /“, NUR „Disallow: /api/“ und Sitemap der Basis', () => {
    const closed = { rules: [{ userAgent: '*', disallow: '/' }] };
    assert.deepEqual(robotsRules({ indexable: false, base: null }), closed);
    assert.deepEqual(robotsRules({ indexable: false, base: BASE }), closed);
    assert.deepEqual(robotsRules({ indexable: true, base: BASE }), {
      rules: [{ userAgent: '*', allow: '/', disallow: ['/api/'] }],
      sitemap: `${BASE}/sitemap.xml`,
    });
    assert.deepEqual([...ROBOTS_DISALLOW_PATHS], ['/api/']);
    // Leitungsentscheidung D7 (Google „Block Search indexing with noindex“): Portal, Vorschau und
    // Token-Pfade bleiben crawlbar, damit ihr noindex gesehen wird – nie per Disallow sperren.
    for (const path of [
      '/konto',
      '/konto/',
      '/vorschau',
      '/vorschau/',
      '/angebot/',
      '/dokument/',
      '/kontakt/',
    ]) {
      assert.equal(ROBOTS_DISALLOW_PATHS.includes(path), false, path);
    }
    // Keine Tokens oder Platzhalter in robots.txt.
    assert.equal(
      JSON.stringify(robotsRules({ indexable: true, base: BASE })).includes(':token'),
      false,
    );
  });

  it('SEO-W8. Sitemap: nur veröffentlichte Seiten des Bootstraps, Startseite zuerst, Pfade sortiert, lastModified nur aus publishedAt, Konfigurator nur wenn nutzbar', () => {
    const pages = [
      summary('/slushmaschine-mieten/mainz', 'region', '2026-11-02T10:00:00Z'),
      summary('/', 'home', '2026-11-01T10:00:00.000Z'),
      summary('/faq', 'faq'),
      summary('/datenschutz', 'legal', 'kein datum'),
      summary('/faq/', 'faq', '2026-11-03T10:00:00.000Z'),
      summary('/Ueber-Uns', 'about', '2026-11-03T10:00:00.000Z'),
    ];
    assert.deepEqual(sitemapEntries({ base: BASE, pages, configurator: true }), [
      { url: `${BASE}/`, lastModified: '2026-11-01T10:00:00.000Z' },
      { url: `${BASE}/datenschutz` },
      { url: `${BASE}/faq` },
      { url: `${BASE}/konfigurator` },
      { url: `${BASE}/slushmaschine-mieten/mainz`, lastModified: '2026-11-02T10:00:00.000Z' },
    ]);
    assert.deepEqual(
      sitemapEntries({ base: BASE, pages, configurator: false }).map((entry) => entry.url),
      [`${BASE}/`, `${BASE}/datenschutz`, `${BASE}/faq`, `${BASE}/slushmaschine-mieten/mainz`],
    );
    assert.deepEqual(sitemapEntries({ base: BASE, pages: [], configurator: false }), []);
    assert.deepEqual(sitemapEntries({ base: BASE, pages: [], configurator: true }), [
      { url: `${BASE}/konfigurator` },
    ]);
    assert.equal(validIsoDate('2026-11-01T10:00:00Z'), '2026-11-01T10:00:00.000Z');
    assert.equal(validIsoDate('gestern'), null);
    assert.equal(validIsoDate(''), null);
    assert.equal(validIsoDate(undefined), null);
  });
});
