import { describe, expect, it } from 'vitest';
import { CMS_BOOTSTRAP_ENTRIES } from '../src/cms/bootstrap-content.ts';
import {
  collectCmsHrefs,
  computeSeoWarnings,
  editorialStrings,
  internalPathExists,
  jaccardSimilarity,
  META_DESCRIPTION_MAX_RECOMMENDED,
  META_DESCRIPTION_MIN,
  META_TITLE_MAX_RECOMMENDED,
  META_TITLE_MIN,
  normalizeInternalPath,
  REGION_SIMILARITY_THRESHOLD,
  wordTrigrams,
  type SeoCheckEntry,
  type SeoCheckInput,
  type SeoCheckRevision,
  type SeoWarning,
} from '../src/cms/seo-check.ts';

/**
 * Phase 17 (SEO, Order §11/§24, Design D12): reine Prüffunktion `computeSeoWarnings` – jede
 * Regel positiv und negativ, Geltungsbereiche (veröffentlicht/Entwurf/Katalog), deterministische
 * Reihenfolge, deutsche Meldungen ohne Codes und ohne Preise. Namen laufen als „SEO-U<n>“.
 */

const GOOD_TITLE = 'Slushmaschine mieten in Mainz | Miet-Royal';
const GOOD_DESCRIPTION =
  'Slushmaschine mieten in Mainz: Abholung in Mainz-Hechtsheim oder Lieferung auf Anfrage. Sirup, Becher und Strohhalme inklusive.';
const GOOD_CONTENT = {
  title: 'Slushmaschine mieten',
  blocks: [
    {
      type: 'text',
      heading: 'Slush für dein Event',
      body: 'Eigener redaktioneller Text mit genug Inhalt für eine echte Seite.',
    },
  ],
};

function revision(input: Partial<SeoCheckRevision> = {}): SeoCheckRevision {
  return {
    metaTitle: input.metaTitle === undefined ? GOOD_TITLE : input.metaTitle,
    metaDescription: input.metaDescription === undefined ? GOOD_DESCRIPTION : input.metaDescription,
    content: input.content === undefined ? GOOD_CONTENT : input.content,
  };
}

/** Seite; `published: 'same'` ⇒ veröffentlicht ohne Entwurfsänderungen. */
function page(
  path: string,
  draft: SeoCheckRevision,
  published: 'same' | SeoCheckRevision | null = 'same',
  pageType: SeoCheckEntry['pageType'] = path.startsWith('/slushmaschine-mieten/')
    ? 'region'
    : 'faq',
): SeoCheckEntry {
  return {
    entryId: `entry-${path}`,
    kind: 'page',
    pageType,
    path,
    draft,
    published:
      published === 'same' ? { ...draft, content: structuredClone(draft.content) } : published,
  };
}

function check(
  entries: SeoCheckEntry[],
  extra: Partial<Omit<SeoCheckInput, 'entries'>> = {},
): SeoWarning[] {
  return computeSeoWarnings({
    entries,
    products: extra.products ?? [],
    publishedPaths:
      extra.publishedPaths ??
      entries
        .filter((entry) => entry.kind === 'page' && entry.published !== null)
        .map((entry) => entry.path!),
  });
}

const codes = (warnings: SeoWarning[]) => warnings.map((warning) => warning.code);

describe('Phase 17 – SEO-Check (reine Funktion)', () => {
  it('SEO-U1. Saubere veröffentlichte Seite ohne Entwurfsänderungen ⇒ keine Hinweise; site_settings werden ignoriert', () => {
    const settings: SeoCheckEntry = {
      entryId: 'settings',
      kind: 'site_settings',
      pageType: null,
      path: null,
      draft: { metaTitle: null, metaDescription: null, content: { businessName: 'X' } },
      published: null,
    };
    expect(check([settings, page('/faq', revision())])).toEqual([]);
  });

  it('SEO-U2. Fehlender Meta-Titel: Entwurf (nie veröffentlicht) und veröffentlichte Revision – je eigene Meldung ohne Code', () => {
    const draftOnly = check([page('/faq', revision({ metaTitle: null }), null)]);
    expect(draftOnly).toEqual([
      {
        code: 'META_TITLE_MISSING',
        scope: 'draft',
        entryId: 'entry-/faq',
        path: '/faq',
        field: 'metaTitle',
        message:
          'Der Entwurf hat keinen Meta-Titel. Ohne Meta-Titel kann die Seite nicht veröffentlicht werden.',
      },
    ]);
    const published = check([page('/faq', revision({ metaTitle: '   ' }))]);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ code: 'META_TITLE_MISSING', scope: 'published' });
    expect(published[0]!.message).toContain('veröffentlichte Seite');
    for (const warning of [...draftOnly, ...published]) {
      expect(warning.message).not.toMatch(/[A-Z]{3,}_[A-Z]/);
    }
  });

  it('SEO-U3. Meta-Titel sehr kurz (< 20) bzw. sehr lang (> 60) mit Zeichenzahl; Grenzwerte ohne Hinweis', () => {
    const titleOf = (length: number) => 'T'.repeat(length);
    expect(
      codes(check([page('/faq', revision({ metaTitle: titleOf(META_TITLE_MIN - 1) }))])),
    ).toEqual(['META_TITLE_SHORT']);
    expect(check([page('/faq', revision({ metaTitle: titleOf(META_TITLE_MIN) }))])).toEqual([]);
    expect(
      check([page('/faq', revision({ metaTitle: titleOf(META_TITLE_MAX_RECOMMENDED) }))]),
    ).toEqual([]);
    const long = check([
      page('/faq', revision({ metaTitle: titleOf(META_TITLE_MAX_RECOMMENDED + 1) })),
    ]);
    expect(long).toHaveLength(1);
    expect(long[0]).toMatchObject({ code: 'META_TITLE_LONG', field: 'metaTitle' });
    expect(long[0]!.message).toBe(
      'Der Meta-Titel ist sehr lang (61 Zeichen). Empfohlen sind 20–60 Zeichen – längere Titel werden in Suchergebnissen abgeschnitten.',
    );
    const short = check([page('/faq', revision({ metaTitle: 'Kontakt | Miet' }))]);
    expect(short[0]!.message).toBe(
      'Der Meta-Titel ist sehr kurz (14 Zeichen). Empfohlen sind 20–60 Zeichen.',
    );
  });

  it('SEO-U4. Meta-Beschreibung fehlend, sehr kurz (< 50), sehr lang (> 160); Grenzwerte ohne Hinweis', () => {
    const text = (length: number) => 'B'.repeat(length);
    const missing = check([page('/faq', revision({ metaDescription: null }))]);
    expect(missing).toEqual([
      {
        code: 'META_DESCRIPTION_MISSING',
        scope: 'published',
        entryId: 'entry-/faq',
        path: '/faq',
        field: 'metaDescription',
        message:
          'Die veröffentlichte Seite hat keine Meta-Beschreibung. Suchmaschinen zeigen dann einen beliebigen Textausschnitt der Seite.',
      },
    ]);
    const short = check([
      page('/faq', revision({ metaDescription: text(META_DESCRIPTION_MIN - 1) })),
    ]);
    expect(short[0]).toMatchObject({ code: 'META_DESCRIPTION_SHORT' });
    expect(short[0]!.message).toContain('(49 Zeichen)');
    expect(
      check([page('/faq', revision({ metaDescription: text(META_DESCRIPTION_MIN) }))]),
    ).toEqual([]);
    expect(
      check([page('/faq', revision({ metaDescription: text(META_DESCRIPTION_MAX_RECOMMENDED) }))]),
    ).toEqual([]);
    const long = check([
      page('/faq', revision({ metaDescription: text(META_DESCRIPTION_MAX_RECOMMENDED + 1) })),
    ]);
    expect(long[0]).toMatchObject({ code: 'META_DESCRIPTION_LONG' });
    expect(long[0]!.message).toContain('(161 Zeichen)');
    expect(long[0]!.message).toContain('50–160 Zeichen');
  });

  it('SEO-U5. Duplikate: exakt gleich nach NFKC/trim/lowercase, getrennt veröffentlicht vs. Entwurf; alle Pfade in der Meldung', () => {
    const a = page('/faq', revision({ metaTitle: 'Kontakt | Miet-Royal Mainz' }), 'same', 'faq');
    const b = page(
      '/ablauf',
      revision({ metaTitle: '  KONTAKT | miet-royal  Mainz ' }),
      'same',
      'process',
    );
    // Vollbreite Zeichen ⇒ NFKC gleich
    const c = page(
      '/kontakt',
      revision({ metaTitle: 'Ｋontakt | Miet-Royal Mainz' }),
      'same',
      'contact',
    );
    const other = page(
      '/ueber-uns',
      revision({ metaTitle: 'Über uns – Miet-Royal Mainz' }),
      'same',
      'about',
    );
    const warnings = check([a, b, c, other]).filter(
      (warning) => warning.code === 'META_TITLE_DUPLICATE',
    );
    expect(warnings).toHaveLength(3);
    expect(warnings.map((warning) => warning.path)).toEqual(['/ablauf', '/faq', '/kontakt']);
    for (const warning of warnings) {
      expect(warning.scope).toBe('published');
      expect(warning.field).toBe('metaTitle');
      expect(warning.message).toBe(
        'Dieser Meta-Titel ist auf mehreren veröffentlichten Seiten identisch: /ablauf, /faq, /kontakt. Jede Seite braucht einen eigenen Meta-Titel.',
      );
    }
    // Entwurf übernimmt den Titel einer veröffentlichten Seite ⇒ Hinweis nur am Entwurf (scope draft),
    // nicht an der unveränderten veröffentlichten Seite.
    const published = page('/faq', revision({ metaTitle: 'Häufige Fragen | Miet-Royal' }));
    const pending = page(
      '/ablauf',
      revision({ metaTitle: 'Häufige Fragen | Miet-Royal' }),
      revision({ metaTitle: 'Ablauf der Slush-Miete | Miet-Royal' }),
      'process',
    );
    const draftWarnings = check([published, pending]).filter(
      (warning) => warning.code === 'META_TITLE_DUPLICATE',
    );
    expect(draftWarnings).toEqual([
      {
        code: 'META_TITLE_DUPLICATE',
        scope: 'draft',
        entryId: 'entry-/ablauf',
        path: '/ablauf',
        field: 'metaTitle',
        message:
          'Dieser Meta-Titel ist in mehreren Entwürfen identisch: /ablauf, /faq. Jede Seite braucht einen eigenen Meta-Titel.',
      },
    ]);
    // Beschreibungen: gleiche Regel, eigenes Feld
    const d1 = page('/faq', revision({ metaDescription: GOOD_DESCRIPTION }));
    const d2 = page(
      '/ablauf',
      revision({ metaDescription: GOOD_DESCRIPTION.toUpperCase() }),
      'same',
      'process',
    );
    const descriptionWarnings = check([d1, d2]).filter(
      (warning) => warning.code === 'META_DESCRIPTION_DUPLICATE',
    );
    expect(descriptionWarnings).toHaveLength(2);
    // Gleiche Titel beider Seiten ⇒ zusätzlich Titel-Duplikate (getrenntes Feld), sonst nichts.
    expect(codes(check([d1, d2]))).toEqual([
      'META_DESCRIPTION_DUPLICATE',
      'META_TITLE_DUPLICATE',
      'META_DESCRIPTION_DUPLICATE',
      'META_TITLE_DUPLICATE',
    ]);
    expect(descriptionWarnings[0]!.field).toBe('metaDescription');
    expect(descriptionWarnings[0]!.message).toContain(
      'Diese Meta-Beschreibung ist auf mehreren veröffentlichten Seiten identisch: /ablauf, /faq.',
    );
  });

  it('SEO-U6. Leere Seite: keine Blöcke bzw. kein eigener Text (Titel zählt nicht); Block mit Überschrift gilt als Inhalt', () => {
    const noBlocks = check([
      page('/faq', revision({ content: { title: 'Häufige Fragen', blocks: [] } })),
    ]);
    expect(noBlocks).toEqual([
      {
        code: 'PAGE_EMPTY',
        scope: 'published',
        entryId: 'entry-/faq',
        path: '/faq',
        field: 'content',
        message: 'Die veröffentlichte Seite hat außer dem Titel keinen Inhalt.',
      },
    ]);
    const noText = check([
      page(
        '/faq',
        revision({
          content: {
            title: 'Häufige Fragen',
            blocks: [
              { type: 'product_grid' },
              {
                type: 'image',
                image: {
                  mediaId: '0e4cbb21-3a16-4d4a-9e3e-0f0c7c6d7f11',
                  alt: 'Maschine',
                  decorative: false,
                },
              },
            ],
          },
        }),
      ),
    ]);
    expect(noText).toHaveLength(1);
    expect(noText[0]!.message).toBe(
      'Die veröffentlichte Seite enthält keinen eigenen Text – nur Bilder oder automatisch befüllte Bausteine.',
    );
    const withHeading = check([
      page(
        '/faq',
        revision({
          content: {
            title: 'Häufige Fragen',
            blocks: [{ type: 'product_grid', heading: 'Maschinen' }],
          },
        }),
      ),
    ]);
    expect(withHeading).toEqual([]);
    expect(
      editorialStrings([
        { type: 'cta', href: '/x', mediaId: 'm', alt: 'a', productSlugs: ['s'], heading: 'H' },
      ]),
    ).toEqual(['H']);
  });

  it('SEO-U7. Kaputter interner Link: nur nicht veröffentlichte CMS-Pfade; App-Pfade, Fragmente, Schluss-Slash, externe/mailto/tel-Links nie', () => {
    const content = {
      title: 'Start',
      blocks: [
        {
          type: 'hero',
          heading: 'Slush',
          primaryCta: { label: 'Region', href: '/slushmaschine-mieten/ingelheim' },
          secondaryCta: { label: 'FAQ', href: '/faq/#oben' },
        },
        {
          type: 'cta',
          heading: 'Weiter',
          primary: { label: 'Konto', href: '/konto/anmelden' },
          secondary: { label: 'Vorschau', href: '/vorschau' },
        },
        {
          type: 'cta',
          heading: 'Noch einmal',
          primary: { label: 'Region', href: '/slushmaschine-mieten/ingelheim/' },
          secondary: { label: 'Extern', href: 'https://www.instagram.com/mietroyal' },
        },
        {
          type: 'cta',
          heading: 'Kontakt',
          primary: { label: 'Mail', href: 'mailto:info@example.test' },
          secondary: { label: 'Tel', href: 'tel:+4961310000' },
        },
        {
          type: 'cta',
          heading: 'App',
          primary: { label: 'Start', href: '/' },
          secondary: { label: 'Konfigurator', href: '/konfigurator' },
        },
      ],
    };
    const home = page('/', revision({ content }), 'same', 'home');
    const faq = page('/faq', revision());
    const warnings = check([home, faq]).filter(
      (warning) => warning.path === '/' && warning.code === 'BROKEN_INTERNAL_LINK',
    );
    expect(warnings).toEqual([
      {
        code: 'BROKEN_INTERNAL_LINK',
        scope: 'published',
        entryId: 'entry-/',
        path: '/',
        field: 'links',
        message:
          'Der Link „/slushmaschine-mieten/ingelheim“ führt auf eine Seite, die derzeit nicht veröffentlicht ist. Die Website blendet diesen Link aus, bis die Seite veröffentlicht ist.',
      },
      {
        code: 'BROKEN_INTERNAL_LINK',
        scope: 'published',
        entryId: 'entry-/',
        path: '/',
        field: 'links',
        message:
          'Der Link „/vorschau“ führt auf eine Seite, die derzeit nicht veröffentlicht ist. Die Website blendet diesen Link aus, bis die Seite veröffentlicht ist.',
      },
    ]);
    // Sobald die Regionsseite veröffentlicht ist, verschwindet der Hinweis.
    const region = page('/slushmaschine-mieten/ingelheim', revision());
    expect(
      check([home, faq, region]).filter((warning) => warning.code === 'BROKEN_INTERNAL_LINK'),
    ).toHaveLength(1);
    expect(collectCmsHrefs(content.blocks)).toHaveLength(10);
    expect(normalizeInternalPath('/faq/#oben')).toBe('/faq');
    expect(normalizeInternalPath('/#top')).toBe('/');
    expect(normalizeInternalPath('/slushmaschine-mieten/mainz//')).toBe(
      '/slushmaschine-mieten/mainz',
    );
    const published = new Set(['/faq']);
    expect(internalPathExists('/', published)).toBe(true);
    expect(internalPathExists('/konto/anmelden', published)).toBe(true);
    expect(internalPathExists('/kontakt', published)).toBe(false);
    expect(internalPathExists('/kontakt/abc123token', published)).toBe(false);
  });

  it('SEO-U8. Regionsseiten: Ortsnamen-Tausch wird erkannt (beide Seiten), eigenständige Texte nicht; Entwurfskopie nur am Entwurf', () => {
    const mainzEntry = CMS_BOOTSTRAP_ENTRIES.find(
      (entry) => entry.kind === 'page' && entry.path === '/slushmaschine-mieten/mainz',
    );
    const wiesbadenEntry = CMS_BOOTSTRAP_ENTRIES.find(
      (entry) => entry.kind === 'page' && entry.path === '/slushmaschine-mieten/wiesbaden',
    );
    if (mainzEntry?.kind !== 'page' || wiesbadenEntry?.kind !== 'page')
      throw new Error('Bootstrap');
    const swapped = JSON.parse(
      JSON.stringify(mainzEntry.content).replace(/Mainz(?!-Hechtsheim)/g, 'Ingelheim'),
    ) as unknown;
    const mainz = page(
      '/slushmaschine-mieten/mainz',
      revision({
        metaTitle: mainzEntry.metaTitle ?? null,
        metaDescription: mainzEntry.metaDescription ?? null,
        content: mainzEntry.content,
      }),
    );
    const ingelheim = page(
      '/slushmaschine-mieten/ingelheim',
      revision({
        metaTitle: 'Slushmaschine mieten in Ingelheim | Miet-Royal',
        metaDescription:
          'Slushmaschine für Ingelheim: abholen in Mainz-Hechtsheim oder Lieferung anfragen. Sirup, Becher und Strohhalme inklusive.',
        content: swapped,
      }),
    );
    const wiesbaden = page(
      '/slushmaschine-mieten/wiesbaden',
      revision({
        metaTitle: wiesbadenEntry.metaTitle ?? null,
        metaDescription: wiesbadenEntry.metaDescription ?? null,
        content: wiesbadenEntry.content,
      }),
    );
    const near = check([mainz, ingelheim, wiesbaden]).filter(
      (warning) => warning.code === 'REGION_NEAR_DUPLICATE',
    );
    expect(near.map((warning) => [warning.scope, warning.path])).toEqual([
      ['published', '/slushmaschine-mieten/ingelheim'],
      ['published', '/slushmaschine-mieten/mainz'],
    ]);
    expect(near[0]!.message).toMatch(
      /^Der Text ähnelt stark der Regionsseite \/slushmaschine-mieten\/mainz \(Ähnlichkeit (6\d|7\d|8\d|9\d|100) %\)\. Regionsseiten brauchen eigenständige Inhalte – kein bloßer Ortsnamen-Tausch\.$/,
    );
    expect(near[1]!.message).toContain('/slushmaschine-mieten/ingelheim');
    // Mainz vs. Wiesbaden (eigenständige Texte): kein Hinweis
    expect(
      check([mainz, wiesbaden]).filter((warning) => warning.code === 'REGION_NEAR_DUPLICATE'),
    ).toEqual([]);
    // Entwurfskopie einer veröffentlichten Seite: Hinweis nur am Entwurf (scope draft)
    const draftCopy = page('/slushmaschine-mieten/ingelheim', ingelheim.draft, null);
    const draftWarnings = check([mainz, draftCopy]).filter(
      (warning) => warning.code === 'REGION_NEAR_DUPLICATE',
    );
    expect(draftWarnings).toHaveLength(1);
    expect(draftWarnings[0]).toMatchObject({
      scope: 'draft',
      path: '/slushmaschine-mieten/ingelheim',
      field: 'content',
    });
    // Nicht-Regionsseiten werden nie verglichen.
    const slushCopy = page('/slushmaschine-mieten', mainz.draft, 'same', 'slush');
    expect(
      check([mainz, slushCopy]).filter((warning) => warning.code === 'REGION_NEAR_DUPLICATE'),
    ).toEqual([]);
    // Ähnlichkeitsmaß
    const a = wordTrigrams('Slush für deine Feier in Mainz – eiskalt und bunt');
    const b = wordTrigrams('Slush für deine Feier in Ingelheim – eiskalt und bunt');
    expect(jaccardSimilarity(a, a)).toBe(1);
    expect(jaccardSimilarity(a, new Set())).toBe(0);
    expect(jaccardSimilarity(a, b)).toBeGreaterThan(0);
    expect(jaccardSimilarity(a, b)).toBeLessThan(REGION_SIMILARITY_THRESHOLD);
  });

  it('SEO-U9. Produkte: Preisangabe in Beschreibung bzw. Name ⇒ Katalog-Hinweis mit Name bzw. Slug – nie der Preis', () => {
    const warnings = check([], {
      products: [
        { slug: 'slush-1x8', name: '1×8 L', description: 'Slushmaschine, Tagesmiete 60 €.' },
        {
          slug: 'slush-2x8',
          name: '2×8 L ab 100,-',
          description: 'Slushmaschine mit 2 Behältern.',
        },
        { slug: 'slush-1x10', name: 'Slush 75 Euro', description: 'EUR 75 pro Tag' },
        { slug: 'sirup-kirsche', name: 'Sirup Kirsche', description: '1 L ergibt ca. 6 L Slush.' },
        { slug: 'becher-25', name: 'Becher (25 Stück)', description: null },
      ],
    });
    expect(warnings).toEqual([
      {
        code: 'PRODUCT_DESCRIPTION_PRICE_HIDDEN',
        scope: 'catalog',
        entryId: null,
        path: null,
        field: 'description',
        message:
          'Die Beschreibung des Produkts mit dem Kürzel „slush-1x10“ enthält eine Preisangabe. Auf der Website wird die Beschreibung deshalb nicht angezeigt – Preise kommen ausschließlich aus „Produkte & Preise“.',
      },
      {
        code: 'PRODUCT_DESCRIPTION_PRICE_HIDDEN',
        scope: 'catalog',
        entryId: null,
        path: null,
        field: 'description',
        message:
          'Die Beschreibung des Produkts „1×8 L“ enthält eine Preisangabe. Auf der Website wird die Beschreibung deshalb nicht angezeigt – Preise kommen ausschließlich aus „Produkte & Preise“.',
      },
      {
        code: 'PRODUCT_NAME_PRICE_HIDDEN',
        scope: 'catalog',
        entryId: null,
        path: null,
        field: 'name',
        message:
          'Der Name des Produkts mit dem Kürzel „slush-1x10“ enthält eine Preisangabe. Das Produkt wird auf der Website deshalb nicht angezeigt – bitte den Namen in „Produkte & Preise“ anpassen.',
      },
      {
        code: 'PRODUCT_NAME_PRICE_HIDDEN',
        scope: 'catalog',
        entryId: null,
        path: null,
        field: 'name',
        message:
          'Der Name des Produkts mit dem Kürzel „slush-2x8“ enthält eine Preisangabe. Das Produkt wird auf der Website deshalb nicht angezeigt – bitte den Namen in „Produkte & Preise“ anpassen.',
      },
    ]);
    for (const warning of warnings) {
      expect(warning.message).not.toMatch(/60|100|75|€|EUR|Euro/);
    }
  });

  it('SEO-U10. Standardinhalte (CMS_BOOTSTRAP_ENTRIES) als veröffentlicht ⇒ keine Hinweise (Meta-Titel/-Beschreibungen in den empfohlenen Längen, keine Duplikate, keine kaputten Links)', () => {
    const entries: SeoCheckEntry[] = CMS_BOOTSTRAP_ENTRIES.map((entry, index) => {
      const draft: SeoCheckRevision =
        entry.kind === 'page'
          ? {
              metaTitle: entry.metaTitle ?? null,
              metaDescription: entry.metaDescription ?? null,
              content: entry.content,
            }
          : { metaTitle: null, metaDescription: null, content: entry.content };
      return {
        entryId: `bootstrap-${index}`,
        kind: entry.kind,
        pageType: entry.kind === 'page' ? entry.pageType : null,
        path: entry.kind === 'page' ? entry.path : null,
        draft,
        published: { ...draft },
      };
    });
    // Phase 17: Der Meta-Titel der Slush-Seite wurde von 62 auf 53 Zeichen gekürzt – die
    // Standardinhalte sollen ohne redaktionelle Hinweise starten (Regeln nicht aufgeweicht).
    expect(
      check(entries, {
        products: [
          {
            slug: 'slush-1x8',
            name: '1×8 L',
            description: 'Slushmaschine mit 1 Behälter à 8 Liter.',
          },
        ],
      }),
    ).toEqual([]);
  });

  it('SEO-U11. Reihenfolge deterministisch: veröffentlicht, Entwurf, Katalog – innerhalb nach Pfad und Code; Entwurf = veröffentlicht erzeugt keine doppelten Hinweise', () => {
    const faq = page('/faq', revision({ metaTitle: 'Kurz', metaDescription: null }));
    const draftOnly = page('/ablauf', revision({ metaTitle: null }), null, 'process');
    const warnings = check([draftOnly, faq], {
      products: [{ slug: 'x', name: 'Ding 5 €', description: null }],
    });
    expect(warnings.map((warning) => [warning.scope, warning.path, warning.code])).toEqual([
      ['published', '/faq', 'META_DESCRIPTION_MISSING'],
      ['published', '/faq', 'META_TITLE_SHORT'],
      ['draft', '/ablauf', 'META_TITLE_MISSING'],
      ['catalog', null, 'PRODUCT_NAME_PRICE_HIDDEN'],
    ]);
    // Entwurf mit Änderung UND veröffentlichter Stand mit demselben Problem ⇒ je ein Hinweis pro Scope
    const both = page(
      '/faq',
      revision({ metaTitle: 'Kurz', content: { title: 'Neu', blocks: GOOD_CONTENT.blocks } }),
      revision({ metaTitle: 'Kurz' }),
    );
    expect(check([both]).map((warning) => [warning.scope, warning.code])).toEqual([
      ['published', 'META_TITLE_SHORT'],
      ['draft', 'META_TITLE_SHORT'],
    ]);
  });
});
