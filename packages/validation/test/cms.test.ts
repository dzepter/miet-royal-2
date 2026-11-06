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
  hasForbiddenTextCharacters,
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

  it('erkennt übliche deutsche Preisschreibweisen (Review pricing-1/cms-2/content_ux-1)', () => {
    for (const text of [
      '60,- €',
      '60,– €',
      '60.- €',
      'ab 60,-€',
      '60,–€',
      '60,-- EUR',
      '60.- EUR',
      'EUR60',
      'Euro60',
      '60 Euros',
      '60,-',
      'ab 60,-',
      'Preis: 60.-',
      '€ 60',
      '60€',
      'Unsere 1×8 L gibt es ab 60,- € pro Wochenende',
      // unsichtbare/Formatzeichen und Kompatibilitätszeichen (NFKC)
      '60\u200B€',
      '60\u00AD€',
      '60\u2060 €',
      '60\u00A0€',
      '\uFF16\uFF10 €',
    ]) {
      expect(containsPriceText(text), JSON.stringify(text)).toBe(true);
    }
    for (const text of [
      'Europa-Tour',
      'Euroland ohne Zahl',
      '2×10 L',
      '2 Europaletten',
      '10-12 Uhr',
      'Sa., 12.-14. Juni',
      'Sa., 12. - 14. Juni',
      '1.–3. Mai',
      'Fr 18:00 – So 11:00',
      'Tel. 0160-123',
      '1 L Sirup je Behälter',
      '25 Becher und 25 Strohhalme',
      '0,2 L',
      'Ab 250 Gästen',
    ]) {
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
    expect(normalizeForAddressComparison('Haupt-Str. 5')).toBe('haupt str 5');
    expect(normalizeForAddressComparison('Hauptstraße 5')).toBe('hauptstr 5');
    expect(normalizeForAddressComparison('Linden\u00ADhain\u200Bweg%2090')).toBe(
      'lindenhainweg 90',
    );
  });

  it('Fragmente: Straße + Hausnummer auch ohne Komma; Teile ohne Ziffer und „PLZ Ort“ nie (Review cms-1/pricing-2)', () => {
    const cases: Array<[string, string[]]> = [
      ['Lindenhainweg 90, 55130 Mainz', ['lindenhainweg 90 55130 mainz', 'lindenhainweg 90']],
      ['Lindenhainweg 90 55130 Mainz', ['lindenhainweg 90 55130 mainz', 'lindenhainweg 90']],
      ['55130 Mainz, Lindenhainweg 90', ['55130 mainz lindenhainweg 90', 'lindenhainweg 90']],
      [
        'Mainz-Hechtsheim, Lindenhainweg 99',
        ['mainz hechtsheim lindenhainweg 99', 'lindenhainweg 99'],
      ],
      [
        'Miet-Royal, Lindenhainweg 90, 55130 Mainz',
        ['miet royal lindenhainweg 90 55130 mainz', 'lindenhainweg 90'],
      ],
      ['Lindenhainweg 90\n55130 Mainz', ['lindenhainweg 90 55130 mainz', 'lindenhainweg 90']],
      [
        'Lindenhainweg 128, 55130 Mainz (Links neben der Tankstelle)',
        ['lindenhainweg 128 55130 mainz links neben der tankstelle', 'lindenhainweg 128'],
      ],
    ];
    for (const [address, expected] of cases) {
      expect(exactAddressFragments(address), address).toEqual(expected);
    }
    // PLZ vorn ohne Komma: auch die kürzeren Endstücke (Straße + Hausnummer).
    expect(exactAddressFragments('55130 Mainz Lindenhainweg 90')).toContain('lindenhainweg 90');
    // Öffentliche Region, Firmenname und „PLZ Ort“ werden nie zum Sperrfragment.
    for (const address of [
      'Mainz-Hechtsheim, Lindenhainweg 99',
      'Miet-Royal, Lindenhainweg 90, 55130 Mainz',
      '55130 Mainz, Lindenhainweg 90',
    ]) {
      const fragments = exactAddressFragments(address);
      for (const publicText of [
        'Abholung in Mainz-Hechtsheim',
        'Slushmaschine mieten | Miet-Royal',
        'Miet-Royal',
        '55130 Mainz',
      ]) {
        expect(containsExactAddress(publicText, fragments), `${address} / ${publicText}`).toBe(
          false,
        );
      }
    }
  });

  it('erkennt Schreibvarianten der Adresse (Nr., ohne Leerzeichen, Bindestrich, Formatzeichen, URL-Kodierung)', () => {
    for (const address of [
      'Lindenhainweg 90, 55130 Mainz',
      'Lindenhainweg 90 55130 Mainz',
      '55130 Mainz, Lindenhainweg 90',
      'Mainz-Hechtsheim, Lindenhainweg 90',
      'Miet-Royal, Lindenhainweg 90, 55130 Mainz',
      '55130 Mainz Lindenhainweg 90',
    ]) {
      const fragments = exactAddressFragments(address);
      for (const text of [
        'Abholung am Lindenhainweg 90 in Mainz-Hechtsheim',
        'Abholung am Lindenhainweg Nr. 90',
        'Lindenhainweg Hausnummer 90',
        'Lindenhainweg90',
        'Lindenhain-Weg 90',
        'LINDENHAINWEG 90',
        'Linden\u00ADhainweg 90',
        'Lindenhain\u200Bweg 90',
        'https://maps.google.com/?q=Lindenhainweg%2090',
        'https://maps.google.com/?q=Lindenhainweg+90',
        'https://maps.example/?q=Lindenhainweg%252090',
      ]) {
        expect(containsExactAddress(text, fragments), `${address} / ${text}`).toBe(true);
      }
      expect(containsExactAddress('Lindenhainweg 12', fragments), address).toBe(false);
    }
    const legacy = exactAddressFragments(
      'Lindenhainweg 128, 55130 Mainz (Links neben der Tankstelle)',
    );
    expect(containsExactAddress('Lindenhainweg Nr. 128', legacy)).toBe(true);
    expect(containsExactAddress('Lindenhainweg128', legacy)).toBe(true);
    expect(containsExactAddress('Lindenhainweg 12', legacy)).toBe(false);
    expect(containsExactAddress('Abholung in Mainz-Hechtsheim', legacy)).toBe(false);
    const muster = exactAddressFragments('Musterstraße 5, 55129 Mainz');
    for (const text of [
      'Musterstr 5',
      'Muster-Straße 5',
      'Musterstr.5',
      'Muster Straße 5',
      'MUSTERSTRASSE 5',
    ]) {
      expect(containsExactAddress(text, muster), text).toBe(true);
    }
    expect(containsExactAddress('Musterstraße 50', muster)).toBe(true); // fail-closed
    expect(containsExactAddress('Strohhalme und Strand', muster)).toBe(false);
  });

  it('Zusatz ohne Komma vor der Straße, Hausnummer mit Buchstabe, weitere unsichtbare Zeichen (Prüfung FIX-A P1–P3)', () => {
    // P1: Zusatz (Region, Firma, Gewerbegebiet) ohne Komma vor Straße + Hausnummer.
    for (const address of [
      'Mainz-Hechtsheim Lindenhainweg 128',
      'Miet-Royal Lindenhainweg 128 55130 Mainz',
      'Gewerbegebiet Hechtsheim Lindenhainweg 128',
    ]) {
      const fragments = exactAddressFragments(address);
      expect(fragments, address).toContain('lindenhainweg 128');
      for (const text of [
        'Abholung am Lindenhainweg 128',
        'Lindenhain-Weg 128',
        'Lindenhainweg Nr. 128',
        'https://maps.google.com/?q=Lindenhainweg%20128',
      ]) {
        expect(containsExactAddress(text, fragments), `${address} / ${text}`).toBe(true);
      }
      for (const publicText of [
        'Abholung in Mainz-Hechtsheim',
        'Miet-Royal',
        'Gewerbegebiet Hechtsheim',
        'Lindenhainweg 12',
      ]) {
        expect(containsExactAddress(publicText, fragments), `${address} / ${publicText}`).toBe(
          false,
        );
      }
    }
    // Endstücke nur aus Straßenart/Füllwörtern sind nie Fragmente („wiese 3“, „der wiese 3“).
    const wiese = exactAddressFragments('In der Dalheimer Wiese 3, 55128 Mainz');
    expect(wiese).toContain('dalheimer wiese 3');
    expect(wiese).not.toContain('wiese 3');
    expect(wiese).not.toContain('der wiese 3');
    expect(containsExactAddress('Picknick auf der Wiese 3 Stunden lang', wiese)).toBe(false);
    expect(containsExactAddress('Abholung: Dalheimer Wiese 3', wiese)).toBe(true);
    // P2: Hausnummer mit Buchstabe ⇒ auch die reine Zahl ist gesperrt.
    const withLetter = exactAddressFragments('Lindenhainweg 128a, 55130 Mainz');
    expect(withLetter).toContain('lindenhainweg 128a');
    expect(withLetter).toContain('lindenhainweg 128');
    expect(containsExactAddress('Abholung am Lindenhainweg 128', withLetter)).toBe(true);
    expect(containsExactAddress('Lindenhainweg 12', withLetter)).toBe(false);
    // P3: weitere unsichtbare Zeichen (Default Ignorable, Braille-Leerzeichen) umgehen nichts.
    const fragments = exactAddressFragments('Lindenhainweg 128, 55130 Mainz');
    for (const text of [
      'Linden\u3164hainweg 128',
      'Linden\u034Fhainweg 128',
      'Lindenhainweg\uFE0F 128',
    ]) {
      expect(containsExactAddress(text, fragments), JSON.stringify(text)).toBe(true);
    }
    for (const text of ['60\u034F €', '60\uFE0F€', '60\u3164€', '60\u2800€', '€\u2800 60']) {
      expect(containsPriceText(text), JSON.stringify(text)).toBe(true);
    }
  });
});

describe('Steuer- und Formatzeichen (Review cms-3)', () => {
  const invisible = [
    '\u0085',
    '\u009B',
    '\u00AD',
    '\u200B',
    '\u200E',
    '\u202E',
    '\u2060',
    '\u2066',
    '\uFEFF',
    '\u2028',
    '\u2029',
    '\u0007',
    '\r',
  ];

  it('hasForbiddenTextCharacters: Cc/Cf/U+2028/U+2029 verboten, \\n nur mit allowNewline', () => {
    for (const char of invisible) {
      expect(hasForbiddenTextCharacters(`A${char}B`), JSON.stringify(char)).toBe(true);
      expect(
        hasForbiddenTextCharacters(`A${char}B`, { allowNewline: true }),
        JSON.stringify(char),
      ).toBe(true);
    }
    expect(hasForbiddenTextCharacters('Zeile 1\nZeile 2')).toBe(true);
    expect(hasForbiddenTextCharacters('Zeile 1\nZeile 2', { allowNewline: true })).toBe(false);
    expect(hasForbiddenTextCharacters('Grüße – „Slush“ ✓ 🍹', { allowNewline: true })).toBe(false);
  });

  it('Seiteninhalt, Blocktexte, Meta-Felder und Alt-Texte lehnen sie ab; Absätze bleiben erlaubt', () => {
    for (const char of invisible) {
      const label = JSON.stringify(char);
      expect(
        cmsPageContentSchema.safeParse({ title: `A${char}B`, blocks: [] }).success,
        label,
      ).toBe(false);
      expect(cmsBlockSchema.safeParse({ type: 'text', body: `A${char}B` }).success, label).toBe(
        false,
      );
      expect(cmsMetaTitleSchema.safeParse(`Meta${char}Titel`).success, label).toBe(false);
      expect(cmsMetaDescriptionSchema.safeParse(`Meta${char}Text`).success, label).toBe(false);
      expect(
        cmsImageRefSchema.safeParse({
          mediaId: MEDIA_ID,
          alt: `Bild${char}text`,
          decorative: false,
        }).success,
        label,
      ).toBe(false);
    }
    expect(cmsBlockSchema.safeParse({ type: 'text', body: 'Absatz.\n\nAbsatz.' }).success).toBe(
      true,
    );
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
