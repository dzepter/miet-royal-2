import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SCHEMA_CONTEXT,
  breadcrumbJsonLd,
  breadcrumbListJsonLd,
  organizationEmail,
  organizationJsonLd,
  organizationTelephone,
  serializeJsonLd,
  websiteJsonLd,
} from './site-jsonld.ts';
import type { PublicImage, PublicSiteSettings } from './site-types.ts';

/**
 * Phase 17 (WEB-META, Design D10, Auftrag §13/§29): strukturierte Daten nur aus veröffentlichten
 * Daten – kein exakter Abholort, keine Öffnungszeiten, keine Preise, keine Bewertungen; sichere
 * Serialisierung. Reine Funktionen (node --test).
 */

const BASE = 'https://www.miet-royal.de';
const MEDIA = '2b7c9a7e-3a1f-4c55-9f0e-1a2b3c4d5e6f';
const LOGO: PublicImage = {
  mediaId: MEDIA,
  alt: 'Miet-Royal',
  decorative: false,
  width: 960,
  height: 320,
  variants: [
    { width: 480, url: `/api/public/cms/media/${MEDIA}/480` },
    { width: 960, url: `/api/public/cms/media/${MEDIA}/960` },
  ],
};
const SETTINGS: PublicSiteSettings = {
  businessName: 'Miet-Royal',
  tagline: 'Slushmaschinen für dein Event',
  phone: '+49 (0) 160 96663665',
  email: 'info@miet-royal.de',
  instagramUrl: 'https://www.instagram.com/miet.royal/',
  logo: LOGO,
  footerNote: null,
};

describe('Strukturierte Daten (Phase 17, Design D10)', () => {
  it('SEO-W9. WebSite: Name, URL der Basis mit Schluss-Slash, Sprache de – ohne SearchAction', () => {
    assert.deepEqual(websiteJsonLd({ base: BASE, name: 'Miet-Royal' }), {
      '@context': SCHEMA_CONTEXT,
      '@type': 'WebSite',
      name: 'Miet-Royal',
      url: `${BASE}/`,
      inLanguage: 'de',
    });
  });

  it('SEO-W10. Organization nur mit veröffentlichten Daten (Logo eigene Medien-URL, Telefon E.164, E-Mail, Instagram) – keine Adresse, Öffnungszeiten, Preise, Bewertungen', () => {
    const full = organizationJsonLd({ base: BASE, settings: SETTINGS });
    assert.deepEqual(full, {
      '@context': SCHEMA_CONTEXT,
      '@type': 'Organization',
      name: 'Miet-Royal',
      url: `${BASE}/`,
      logo: `${BASE}/api/public/cms/media/${MEDIA}/960`,
      telephone: '+4916096663665',
      email: 'info@miet-royal.de',
      sameAs: ['https://www.instagram.com/miet.royal/'],
    });
    for (const forbidden of [
      'address',
      'location',
      'geo',
      'openingHours',
      'openingHoursSpecification',
      'priceRange',
      'aggregateRating',
      'review',
      'makesOffer',
    ]) {
      assert.equal(forbidden in full, false, forbidden);
    }
    // Nichts gepflegt ⇒ nur Name und URL.
    assert.deepEqual(
      organizationJsonLd({
        base: BASE,
        settings: {
          ...SETTINGS,
          logo: null,
          phone: null,
          email: '   ',
          instagramUrl: 'http://www.instagram.com/x',
        },
      }),
      { '@context': SCHEMA_CONTEXT, '@type': 'Organization', name: 'Miet-Royal', url: `${BASE}/` },
    );
    // Logo nur mit eigener VERÖFFENTLICHTER Medien-URL (keine Vorschau-Medien).
    const previewLogo = organizationJsonLd({
      base: BASE,
      settings: {
        ...SETTINGS,
        logo: {
          ...LOGO,
          variants: [{ width: 480, url: `/api/public/cms/preview-media/${MEDIA}/480` }],
        },
      },
    });
    assert.equal('logo' in previewLogo, false);
    // Telefon: Wählform ohne tel:, nur international; 00 ⇒ +; national ohne Vorwahl entfällt.
    assert.equal(organizationTelephone('+49 (0) 160 96663665'), '+4916096663665');
    assert.equal(organizationTelephone('0049 (0)6131 123456'), '+496131123456');
    assert.equal(organizationTelephone('06131 123456'), null);
    assert.equal(organizationTelephone('abc'), null);
    assert.equal(organizationTelephone(''), null);
    assert.equal(organizationTelephone(null), null);
    assert.equal(organizationEmail(' info@miet-royal.de '), 'info@miet-royal.de');
    assert.equal(organizationEmail('kein-mail'), null);
    assert.equal(organizationEmail(null), null);
  });

  it('SEO-W11. BreadcrumbList: Positionen ab 1, letztes Element ohne item, URLs = Canonicals der sichtbaren Brotkrume', () => {
    assert.deepEqual(
      breadcrumbJsonLd([
        { name: 'Start', url: `${BASE}/` },
        { name: 'Slushmaschine mieten', url: `${BASE}/slushmaschine-mieten` },
        { name: 'Slushmaschine mieten in Mainz', url: `${BASE}/slushmaschine-mieten/mainz` },
      ]),
      {
        '@context': SCHEMA_CONTEXT,
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Start', item: `${BASE}/` },
          {
            '@type': 'ListItem',
            position: 2,
            name: 'Slushmaschine mieten',
            item: `${BASE}/slushmaschine-mieten`,
          },
          { '@type': 'ListItem', position: 3, name: 'Slushmaschine mieten in Mainz' },
        ],
      },
    );
    assert.deepEqual(
      breadcrumbListJsonLd(
        [
          { name: 'Start', href: '/' },
          { name: 'Popcornmaschine mieten', href: '/popcornmaschine-mieten/' },
        ],
        BASE,
      ).itemListElement,
      [
        { '@type': 'ListItem', position: 1, name: 'Start', item: `${BASE}/` },
        { '@type': 'ListItem', position: 2, name: 'Popcornmaschine mieten' },
      ],
    );
  });

  it('SEO-W12. Serialisierung escaped <, > und & – „</script>“ kann das Script-Element nicht beenden; Ergebnis bleibt gültiges JSON', () => {
    const name = 'Miet-Royal </script><img src=x onerror=alert(1)> & Co';
    const json = serializeJsonLd({ '@context': SCHEMA_CONTEXT, '@type': 'WebSite', name });
    assert.equal(json.includes('</script>'), false);
    assert.equal(json.includes('<'), false);
    assert.equal(json.includes('>'), false);
    assert.equal(json.includes('&'), false);
    assert.deepEqual(JSON.parse(json), { '@context': SCHEMA_CONTEXT, '@type': 'WebSite', name });
  });
});
