import { describe, expect, it } from 'vitest';
import {
  CMS_BLOCK_TYPES,
  CMS_PAGE_TYPES,
  CMS_PRIVACY_PATH,
  cmsBlockSchema,
  cmsHrefSchema,
  cmsImageRefSchema,
  cmsMetaDescriptionSchema,
  cmsMetaTitleSchema,
  cmsPageContentSchema,
  cmsPageTypeIssues,
  cmsSiteSettingsSchema,
  collectCmsMediaIds,
  collectCmsStrings,
  containsExactAddress,
  containsPriceText,
  exactAddressFragments,
  isValidCmsPathForPageType,
  normalizeForAddressComparison,
  overlappingRecommendationRules,
  recommendMachineSlug,
  type CmsPageContent,
} from '../src/cms.ts';

/**
 * Phase 16 (CMS, Design §11.3): Inhaltsschema des Website-CMS – strukturierte Blöcke,
 * kein HTML/Script, keine Preisfelder, Bild-Alt-Regeln, Pfad-/Seitentyp-Regeln,
 * Preis-/Adress-Schutz und Empfehlungsregeln.
 */

const MEDIA_ID = '6f1c1d2e-8a4b-4c3d-9e5f-0a1b2c3d4e5f';
const settingsBase = {
  businessName: 'Miet-Royal',
  contact: {},
  recommendationRules: [],
};

describe('Blöcke und Seiteninhalt', () => {
  it('kennt genau die vereinbarten Blocktypen', () => {
    expect([...CMS_BLOCK_TYPES].sort()).toEqual(
      [
        'contact_details',
        'cta',
        'faq',
        'features',
        'gallery',
        'hero',
        'image',
        'included_items',
        'product_grid',
        'reviews',
        'secondary_offers',
        'service_areas',
        'steps',
        'text',
      ].sort(),
    );
    expect(CMS_PAGE_TYPES).toContain('secondary_offer');
  });

  it('akzeptiert eine gültige Seite und trimmt Texte', () => {
    const parsed = cmsPageContentSchema.parse({
      title: '  Slush mieten  ',
      blocks: [
        {
          type: 'hero',
          heading: 'Slush für dein Event',
          primaryCta: { label: 'Los', href: '/konfigurator' },
        },
        { type: 'text', body: 'Absatz eins.\n\nAbsatz zwei.' },
        { type: 'product_grid', heading: 'Maschinen' },
        { type: 'included_items' },
        { type: 'faq', items: [{ question: 'Wie?', answer: 'So.' }] },
      ],
    });
    expect(parsed.title).toBe('Slush mieten');
    expect(parsed.blocks).toHaveLength(5);
  });

  it('verbietet Preisfelder und andere Zusatzfelder (strictObject)', () => {
    expect(cmsBlockSchema.safeParse({ type: 'product_grid', priceCents: 6000 }).success).toBe(
      false,
    );
    expect(cmsBlockSchema.safeParse({ type: 'included_items', price: '60 €' }).success).toBe(false);
    expect(cmsBlockSchema.safeParse({ type: 'text', body: 'x', html: '<b>x</b>' }).success).toBe(
      false,
    );
    expect(cmsBlockSchema.safeParse({ type: 'script', body: 'x' }).success).toBe(false);
  });

  it('verbietet HTML-artige Tags und Steuerzeichen in Texten', () => {
    expect(
      cmsBlockSchema.safeParse({ type: 'text', body: '<script>alert(1)</script>' }).success,
    ).toBe(false);
    expect(cmsBlockSchema.safeParse({ type: 'text', body: 'Hallo <img src=x>' }).success).toBe(
      false,
    );
    expect(cmsBlockSchema.safeParse({ type: 'text', body: 'Null\u0000Byte' }).success).toBe(false);
    expect(cmsBlockSchema.safeParse({ type: 'text', body: '3 < 5 und 5 > 3' }).success).toBe(true);
  });

  it('erlaubt einen Hero nur als ersten Block', () => {
    const result = cmsPageContentSchema.safeParse({
      title: 'Seite',
      blocks: [
        { type: 'text', body: 'Text' },
        { type: 'hero', heading: 'Zu spät' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('begrenzt Blockanzahl und Listenlängen', () => {
    const blocks = Array.from({ length: 41 }, () => ({ type: 'text', body: 'x' }));
    expect(cmsPageContentSchema.safeParse({ title: 'Seite', blocks }).success).toBe(false);
    expect(
      cmsBlockSchema.safeParse({
        type: 'product_grid',
        productSlugs: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      }).success,
    ).toBe(false);
  });
});

describe('Links und Bilder', () => {
  it('erlaubt interne Pfade, https, mailto und tel – nie javascript:/data:/http', () => {
    for (const href of [
      '/konfigurator',
      '/faq#preise',
      'https://www.instagram.com/x',
      'mailto:info@example.com',
      'tel:+4961311234567',
    ]) {
      expect(cmsHrefSchema.safeParse(href).success, href).toBe(true);
    }
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,x',
      'http://example.com',
      '//evil.example',
      'https://user:pw@example.com',
    ]) {
      expect(cmsHrefSchema.safeParse(href).success, href).toBe(false);
    }
  });

  it('verlangt Alt-Text oder ausdrücklich dekorativ (dann leer)', () => {
    expect(
      cmsImageRefSchema.safeParse({ mediaId: MEDIA_ID, alt: 'Slushmaschine', decorative: false })
        .success,
    ).toBe(true);
    expect(
      cmsImageRefSchema.safeParse({ mediaId: MEDIA_ID, alt: '', decorative: true }).success,
    ).toBe(true);
    expect(
      cmsImageRefSchema.safeParse({ mediaId: MEDIA_ID, alt: '', decorative: false }).success,
    ).toBe(false);
    expect(
      cmsImageRefSchema.safeParse({ mediaId: MEDIA_ID, alt: 'Text', decorative: true }).success,
    ).toBe(false);
    expect(
      cmsImageRefSchema.safeParse({
        mediaId: 'cms-media/x/480.webp',
        alt: 'Bild',
        decorative: false,
      }).success,
    ).toBe(false);
  });
});

describe('Pfade und Seitentyp-Regeln', () => {
  it('bindet feste Pfade an ihren Seitentyp', () => {
    expect(isValidCmsPathForPageType('home', '/')).toBe(true);
    expect(isValidCmsPathForPageType('slush', '/slushmaschine-mieten')).toBe(true);
    expect(isValidCmsPathForPageType('faq', '/ablauf')).toBe(false);
    expect(isValidCmsPathForPageType('legal', CMS_PRIVACY_PATH)).toBe(true);
    expect(isValidCmsPathForPageType('legal', '/agb')).toBe(false);
    expect(isValidCmsPathForPageType('secondary_offer', '/popcornmaschine-mieten')).toBe(true);
  });

  it('Regionsseiten nur unter /slushmaschine-mieten/<slug>', () => {
    expect(isValidCmsPathForPageType('region', '/slushmaschine-mieten/mainz')).toBe(true);
    expect(isValidCmsPathForPageType('region', '/slushmaschine-mieten/bad-kreuznach')).toBe(true);
    expect(isValidCmsPathForPageType('region', '/slushmaschine-mieten/Mainz')).toBe(false);
    expect(isValidCmsPathForPageType('region', '/slushmaschine-mieten/a')).toBe(false);
    expect(isValidCmsPathForPageType('region', '/mainz')).toBe(false);
  });

  it('Rechtstexte: nur Textblöcke, mindestens einer (fail-closed)', () => {
    const empty: CmsPageContent = { title: 'Datenschutz', blocks: [] };
    expect(cmsPageTypeIssues('legal', empty)).toHaveLength(1);
    const withCta = cmsPageContentSchema.parse({
      title: 'Impressum',
      blocks: [
        { type: 'text', body: 'Text' },
        { type: 'cta', heading: 'Jetzt', primary: { label: 'Los', href: '/' } },
      ],
    });
    expect(cmsPageTypeIssues('legal', withCta)).toHaveLength(1);
    expect(cmsPageTypeIssues('faq', withCta)).toEqual([]);
  });

  it('Meta-Titel 1–70, Meta-Beschreibung 1–170 Zeichen', () => {
    expect(cmsMetaTitleSchema.safeParse('Slushmaschine mieten').success).toBe(true);
    expect(cmsMetaTitleSchema.safeParse('x'.repeat(71)).success).toBe(false);
    expect(cmsMetaDescriptionSchema.safeParse('x'.repeat(170)).success).toBe(true);
    expect(cmsMetaDescriptionSchema.safeParse('x'.repeat(171)).success).toBe(false);
  });
});

describe('Preis- und Adress-Schutz', () => {
  it('erkennt Preisangaben als Freitext', () => {
    for (const text of ['Nur 60 €', '60,00 EUR', '€ 60', '12 Euro pro Liter', 'ab 5€']) {
      expect(containsPriceText(text), text).toBe(true);
    }
    for (const text of ['25 Becher inklusive', 'Europa-Tour', '2×10 L', 'Euroland ohne Zahl']) {
      expect(containsPriceText(text), text).toBe(false);
    }
  });

  it('erkennt die exakte Abholadresse und ihren Straßenteil (normalisiert)', () => {
    const fragments = exactAddressFragments('Teststraße 1, 55129 Mainz-Hechtsheim (SYNTHETISCH)');
    expect(fragments.length).toBe(2);
    expect(containsExactAddress('Abholung in der Teststrasse 1 möglich', fragments)).toBe(true);
    expect(containsExactAddress('TESTSTR. 1', fragments)).toBe(true);
    expect(containsExactAddress('Abholung in Mainz-Hechtsheim', fragments)).toBe(false);
    expect(exactAddressFragments(null)).toEqual([]);
    expect(containsExactAddress('beliebig', [])).toBe(false);
    expect(normalizeForAddressComparison('Haupt-Str. 5')).toBe('haupt straße 5');
  });
});

describe('Website-Einstellungen und Empfehlungsregeln', () => {
  it('akzeptiert leere Regeln (keine erfundenen Bereiche) und Instagram nur als https-Link', () => {
    expect(cmsSiteSettingsSchema.safeParse(settingsBase).success).toBe(true);
    expect(
      cmsSiteSettingsSchema.safeParse({
        ...settingsBase,
        instagramUrl: 'https://www.instagram.com/mietroyal',
      }).success,
    ).toBe(true);
    expect(
      cmsSiteSettingsSchema.safeParse({ ...settingsBase, instagramUrl: 'https://evil.example/x' })
        .success,
    ).toBe(false);
    expect(cmsSiteSettingsSchema.safeParse({ ...settingsBase, embedFeed: true }).success).toBe(
      false,
    );
  });

  it('lehnt überlappende Regeln ab, Lücken sind erlaubt', () => {
    const rules = [
      { guestMin: 1, guestMax: 50, machineProductSlug: 'slush-1x8' },
      { guestMin: 80, guestMax: 150, machineProductSlug: 'slush-2x10' },
    ];
    expect(overlappingRecommendationRules(rules)).toEqual([]);
    expect(
      cmsSiteSettingsSchema.safeParse({ ...settingsBase, recommendationRules: rules }).success,
    ).toBe(true);
    const overlapping = [...rules, { guestMin: 140, machineProductSlug: 'slush-2x8' }];
    expect(overlappingRecommendationRules(overlapping)).toEqual([[1, 2]]);
    expect(
      cmsSiteSettingsSchema.safeParse({ ...settingsBase, recommendationRules: overlapping })
        .success,
    ).toBe(false);
  });

  it('empfiehlt nur aus Regeln und nur aktive Maschinen – sonst null (keine Ablehnung)', () => {
    const rules = [
      { guestMin: 1, guestMax: 50, machineProductSlug: 'slush-1x8' },
      { guestMin: 51, machineProductSlug: 'slush-2x10' },
    ];
    const active = new Set(['slush-1x8', 'slush-2x10']);
    expect(recommendMachineSlug(rules, 20, active)).toBe('slush-1x8');
    expect(recommendMachineSlug(rules, 400, active)).toBe('slush-2x10');
    expect(recommendMachineSlug(rules, 20, new Set(['slush-2x10']))).toBeNull();
    expect(recommendMachineSlug([], 20, active)).toBeNull();
  });
});

describe('Hilfsfunktionen', () => {
  it('sammelt Medien-IDs und Texte rekursiv', () => {
    const content = {
      title: 'Galerie',
      blocks: [
        { type: 'hero', heading: 'H', image: { mediaId: MEDIA_ID, alt: 'A', decorative: false } },
        { type: 'gallery', images: [{ mediaId: MEDIA_ID, alt: '', decorative: true }] },
      ],
    };
    expect(collectCmsMediaIds(content)).toEqual([MEDIA_ID]);
    expect(collectCmsStrings(content)).toContain('Galerie');
    expect(collectCmsStrings(content)).toContain('H');
  });
});
