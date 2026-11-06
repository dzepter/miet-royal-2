/**
 * Phase 16 (Website-CMS, Order §6/§8/§12/§23): verbindliches Inhaltsschema des
 * internen CMS. Gemeinsamer Vertrag für API (Validierung beim Speichern und
 * Veröffentlichen), Bootstrap-Inhalte und Staff-Editor.
 *
 * Grundsätze:
 * - Strukturierte Blöcke, jeweils `strictObject` – kein HTML, kein Script, kein
 *   WYSIWYG-Blob. Texte sind reiner Text (Absätze durch Leerzeilen).
 * - KEINE Preise im CMS: Blöcke wie `product_grid`/`included_items` tragen nur
 *   Überschrift/Einleitung; Produkte und Preise kommen beim Rendern ausschließlich
 *   aus products/product_prices (ProductService).
 * - Bilder nur über `mediaId` (opake ID), mit Alt-Text oder ausdrücklich dekorativ.
 * - Maschinenempfehlung: nur gepflegte, nicht überlappende Regeln; keine Formel.
 */
import { z } from 'zod';

// ── Seitentypen und Pfade ────────────────────────────────────────────────────

export const CMS_PAGE_TYPES = [
  'home',
  'slush',
  'process',
  'faq',
  'about',
  'contact',
  'legal',
  'region',
  'secondary_offer',
] as const;
export type CmsPageTypeName = (typeof CMS_PAGE_TYPES)[number];

/** Seitentypen mit genau einem festen Pfad (Singleton-Seiten). */
export const CMS_FIXED_PAGE_PATHS = {
  home: '/',
  slush: '/slushmaschine-mieten',
  process: '/ablauf',
  faq: '/faq',
  about: '/ueber-uns',
  contact: '/kontakt',
} as const satisfies Partial<Record<CmsPageTypeName, string>>;

export const CMS_IMPRINT_PATH = '/impressum';
/** Pfad der Datenschutzhinweise – deren veröffentlichte Revision ist Pflicht für Website-Anfragen (Order §17). */
export const CMS_PRIVACY_PATH = '/datenschutz';
export const CMS_LEGAL_PATHS = [CMS_IMPRINT_PATH, CMS_PRIVACY_PATH] as const;
export const CMS_SECONDARY_OFFER_PATHS = [
  '/popcornmaschine-mieten',
  '/waffeleisen-mieten',
] as const;
export const CMS_REGION_PATH_PREFIX = '/slushmaschine-mieten/';
export const CMS_REGION_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const CMS_REGION_SLUG_MAX = 60;

/** Prüft, ob ein öffentlicher Pfad zu einem Seitentyp passt (Service-Regel beim Anlegen). */
export function isValidCmsPathForPageType(pageType: CmsPageTypeName, path: string): boolean {
  switch (pageType) {
    case 'home':
    case 'slush':
    case 'process':
    case 'faq':
    case 'about':
    case 'contact':
      return CMS_FIXED_PAGE_PATHS[pageType] === path;
    case 'legal':
      return (CMS_LEGAL_PATHS as readonly string[]).includes(path);
    case 'secondary_offer':
      return (CMS_SECONDARY_OFFER_PATHS as readonly string[]).includes(path);
    case 'region': {
      if (!path.startsWith(CMS_REGION_PATH_PREFIX)) return false;
      const slug = path.slice(CMS_REGION_PATH_PREFIX.length);
      return (
        slug.length >= 2 && slug.length <= CMS_REGION_SLUG_MAX && CMS_REGION_SLUG_PATTERN.test(slug)
      );
    }
  }
}

// ── Bausteine ────────────────────────────────────────────────────────────────

/**
 * Phase 16 (Review cms-3): verbotene Zeichen in redaktionellen Texten – Unicode-Steuerzeichen
 * (`\p{Cc}`: C0, DEL, C1 U+0080–U+009F), Formatzeichen (`\p{Cf}`: weiches Trennzeichen U+00AD,
 * Zero-Width U+200B–U+200F, Bidi U+202A–U+202E/U+2066–U+2069, U+2060–U+2064, BOM U+FEFF …)
 * sowie Zeilen-/Absatztrenner U+2028/U+2029. Erlaubt ist höchstens der Zeilenumbruch `\n`.
 * Gemeinsame Prüfung für CMS-Texte, Meta-Felder, Alt-Texte, Medien-Bezeichnungen und die
 * Redaktionsnotiz (unsichtbare Zeichen dürfen die Preis-/Adress-Sperre nicht umgehen).
 */
const FORBIDDEN_TEXT_CHARACTERS = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const FORBIDDEN_TEXT_CHARACTERS_EXCEPT_NEWLINE = /[^\P{Cc}\n]|[\p{Cf}\u2028\u2029]/u;

export function hasForbiddenTextCharacters(
  value: string,
  options: { allowNewline: boolean } = { allowNewline: false },
): boolean {
  return (
    options.allowNewline ? FORBIDDEN_TEXT_CHARACTERS_EXCEPT_NEWLINE : FORBIDDEN_TEXT_CHARACTERS
  ).test(value);
}

/** Steuer-/Formatzeichen außer Zeilenumbruch und HTML-artige Tags sind in CMS-Texten verboten. */
function hasForbiddenControl(value: string): boolean {
  return hasForbiddenTextCharacters(value, { allowNewline: true });
}
const TAG_LIKE = /<\s*[a-zA-Z/!?]/;

/** HTML-artiger Tag (`<b`, `</`, `<!`, `<?`) – in reinen Texten verboten. */
export function hasTagLikeText(value: string): boolean {
  return TAG_LIKE.test(value);
}

function cmsText(min: number, max: number) {
  return z
    .string()
    .trim()
    .min(min, min === 1 ? 'Bitte ausfüllen.' : `Mindestens ${min} Zeichen.`)
    .max(max, `Höchstens ${max} Zeichen.`)
    .refine((value) => !hasForbiddenControl(value), 'Unzulässige Steuerzeichen.')
    .refine(
      (value) => !TAG_LIKE.test(value),
      'HTML ist nicht erlaubt – bitte reinen Text verwenden.',
    );
}

const INTERNAL_PATH = /^\/(?!\/)[a-z0-9\-/]*(#[a-z0-9-]+)?$/;
const TEL = /^tel:\+?[0-9]{6,20}$/;
const MAILTO = /^mailto:[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

/** Link-Ziel: interner Pfad, https-URL, mailto: oder tel: – nie javascript:/data:. */
export const cmsHrefSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((href) => {
    if (INTERNAL_PATH.test(href)) return true;
    if (TEL.test(href) || MAILTO.test(href)) return true;
    try {
      const url = new URL(href);
      return url.protocol === 'https:' && url.username === '' && url.password === '';
    } catch {
      return false;
    }
  }, 'Link muss ein interner Pfad, eine https-Adresse, mailto: oder tel: sein.');

export const cmsCtaSchema = z.strictObject({
  label: cmsText(1, 60),
  href: cmsHrefSchema,
});

/** Bildreferenz: opake Medien-ID; Alt-Text Pflicht, außer ausdrücklich dekorativ (dann leer). */
export const cmsImageRefSchema = z
  .strictObject({
    mediaId: z.uuid(),
    alt: z.string().trim().max(200),
    decorative: z.boolean(),
  })
  .superRefine((image, ctx) => {
    if (image.decorative && image.alt !== '') {
      ctx.addIssue({
        code: 'custom',
        path: ['alt'],
        message: 'Dekorative Bilder haben keinen Alt-Text.',
      });
    }
    if (!image.decorative && image.alt.length < 3) {
      ctx.addIssue({
        code: 'custom',
        path: ['alt'],
        message: 'Bitte einen Alt-Text angeben oder das Bild als dekorativ markieren.',
      });
    }
    if (hasForbiddenControl(image.alt) || TAG_LIKE.test(image.alt)) {
      ctx.addIssue({ code: 'custom', path: ['alt'], message: 'Unzulässiger Alt-Text.' });
    }
  });

const heading = cmsText(1, 120);
const intro = cmsText(1, 800);
const titledItem = z.strictObject({ title: cmsText(1, 80), text: cmsText(1, 600) });

// ── Blöcke ───────────────────────────────────────────────────────────────────

export const cmsHeroBlockSchema = z.strictObject({
  type: z.literal('hero'),
  heading,
  lead: cmsText(1, 400).optional(),
  image: cmsImageRefSchema.optional(),
  primaryCta: cmsCtaSchema.optional(),
  secondaryCta: cmsCtaSchema.optional(),
});
export const cmsTextBlockSchema = z.strictObject({
  type: z.literal('text'),
  heading: heading.optional(),
  body: cmsText(1, 8000),
});
export const cmsFeaturesBlockSchema = z.strictObject({
  type: z.literal('features'),
  heading: heading.optional(),
  intro: intro.optional(),
  items: z.array(titledItem).min(1).max(6),
});
export const cmsStepsBlockSchema = z.strictObject({
  type: z.literal('steps'),
  heading: heading.optional(),
  intro: intro.optional(),
  items: z.array(titledItem).min(1).max(8),
});
const productSlug = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Ungültiger Produkt-Slug.');

/**
 * Produktübersicht – Produkte und Preise kommen beim Rendern aus dem Katalog, nie aus dem
 * CMS. Ohne `productSlugs` zeigt der Block die Slush-Maschinen; mit `productSlugs` genau diese
 * (aktiven) Produkte mit aktuellem Preis – z. B. später Popcorn/Waffel (Order §30), ohne
 * Neuprogrammierung.
 */
export const cmsProductGridBlockSchema = z.strictObject({
  type: z.literal('product_grid'),
  heading: heading.optional(),
  intro: intro.optional(),
  productSlugs: z.array(productSlug).min(1).max(6).optional(),
});
/** Inklusivleistungen + Zubehör – Mengen/Preise aus Domain-Regeln und Katalog, nie aus dem CMS. */
export const cmsIncludedItemsBlockSchema = z.strictObject({
  type: z.literal('included_items'),
  heading: heading.optional(),
  intro: intro.optional(),
});
export const cmsImageBlockSchema = z.strictObject({
  type: z.literal('image'),
  image: cmsImageRefSchema,
  caption: cmsText(1, 200).optional(),
});
export const cmsGalleryBlockSchema = z.strictObject({
  type: z.literal('gallery'),
  heading: heading.optional(),
  images: z.array(cmsImageRefSchema).min(1).max(12),
});
export const cmsFaqBlockSchema = z.strictObject({
  type: z.literal('faq'),
  heading: heading.optional(),
  items: z
    .array(z.strictObject({ question: cmsText(1, 200), answer: cmsText(1, 3000) }))
    .min(1)
    .max(40),
});
/** Bewertungen – erscheinen nur, wenn ein Bewertungs-Provider aktiv ist (Order §18). */
export const cmsReviewsBlockSchema = z.strictObject({
  type: z.literal('reviews'),
  heading: heading.optional(),
  intro: intro.optional(),
});
export const cmsServiceAreasBlockSchema = z.strictObject({
  type: z.literal('service_areas'),
  heading: heading.optional(),
  intro: intro.optional(),
  areas: z.array(cmsText(1, 60)).min(1).max(20),
});
/** Sekundäre Angebote – zeigt nur bewusst veröffentlichte secondary_offer-Seiten. */
export const cmsSecondaryOffersBlockSchema = z.strictObject({
  type: z.literal('secondary_offers'),
  heading: heading.optional(),
  intro: intro.optional(),
});
/** Kontaktangaben – Werte kommen aus den veröffentlichten Website-Einstellungen. */
export const cmsContactDetailsBlockSchema = z.strictObject({
  type: z.literal('contact_details'),
  heading: heading.optional(),
  intro: intro.optional(),
});
export const cmsCtaBlockSchema = z.strictObject({
  type: z.literal('cta'),
  heading,
  text: cmsText(1, 500).optional(),
  primary: cmsCtaSchema,
  secondary: cmsCtaSchema.optional(),
});

export const cmsBlockSchema = z.discriminatedUnion('type', [
  cmsHeroBlockSchema,
  cmsTextBlockSchema,
  cmsFeaturesBlockSchema,
  cmsStepsBlockSchema,
  cmsProductGridBlockSchema,
  cmsIncludedItemsBlockSchema,
  cmsImageBlockSchema,
  cmsGalleryBlockSchema,
  cmsFaqBlockSchema,
  cmsReviewsBlockSchema,
  cmsServiceAreasBlockSchema,
  cmsSecondaryOffersBlockSchema,
  cmsContactDetailsBlockSchema,
  cmsCtaBlockSchema,
]);
export type CmsBlock = z.infer<typeof cmsBlockSchema>;
export type CmsBlockType = CmsBlock['type'];
export const CMS_BLOCK_TYPES = cmsBlockSchema.options.map(
  (option) => option.shape.type.value,
) as readonly CmsBlockType[];

/** Rechtstexte bestehen nur aus Textblöcken (keine CTAs, keine Bilder). */
const LEGAL_BLOCK_TYPES: readonly CmsBlockType[] = ['text'];

/**
 * Seiteninhalt: `title` ist die H1, außer der erste Block ist ein `hero` (dann ist
 * dessen Überschrift die H1). `hero` ist nur als erster Block erlaubt.
 */
export const cmsPageContentSchema = z
  .strictObject({
    title: cmsText(1, 120),
    blocks: z.array(cmsBlockSchema).max(40),
  })
  .superRefine((content, ctx) => {
    content.blocks.forEach((block, index) => {
      if (block.type === 'hero' && index !== 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['blocks', index, 'type'],
          message: 'Ein Hero-Block ist nur als erster Block erlaubt.',
        });
      }
    });
  });
export type CmsPageContent = z.infer<typeof cmsPageContentSchema>;

/** Seitentyp-spezifische Regeln; liefert Meldungen (leer = gültig). */
export function cmsPageTypeIssues(pageType: CmsPageTypeName, content: CmsPageContent): string[] {
  const issues: string[] = [];
  if (pageType === 'legal') {
    content.blocks.forEach((block, index) => {
      if (!LEGAL_BLOCK_TYPES.includes(block.type)) {
        issues.push(`Block ${index + 1}: Rechtstexte bestehen nur aus Textblöcken.`);
      }
    });
    // Ein leerer Rechtstext gilt nie als veröffentlichte Datenschutzhinweise (Order §17, fail-closed).
    if (!content.blocks.some((block) => block.type === 'text')) {
      issues.push('Rechtstexte brauchen mindestens einen Textblock.');
    }
  }
  return issues;
}

// ── Schutzregeln für Texte (Order §5/§7) ────────────────────────────────────

/**
 * Vergleichsform für die Schutzregeln: Unicode-NFKC (Vollbreiten-Ziffern, NBSP …) und ohne
 * Formatzeichen (`\p{Cf}`: weiches Trennzeichen, Zero-Width, Bidi, BOM) – unsichtbare Zeichen
 * dürfen weder Preis- noch Adress-Sperre umgehen.
 */
function guardComparable(text: string): string {
  // Phase 16 (Prüfung FIX-A, P3): auch übrige „Default Ignorable“-Zeichen (CGJ U+034F,
  // Variantenwähler U+FE00–U+FE0F, Hangul-Füller U+3164 …) entfernen und das
  // Braille-Leerzeichen U+2800 wie ein Leerzeichen behandeln.
  return text
    .normalize('NFKC')
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
    .replace(/\u2800/g, ' ');
}

/** Bindestriche/Gedankenstriche (inkl. U+2010–U+2015, U+2212) für die Strich-Schreibweise. */
const DASH = '[-\\u2010-\\u2015\\u2212]';

/**
 * Preise als Freitext sind im CMS verboten (außer in Rechtstexten): Preise kommen nur aus
 * products/product_prices (Design §11.2.1, Review pricing-1/cms-2/content_ux-1). Erkennt
 * „60 €“, „60€“, „60,00 EUR“, „€ 60“, „EUR60“, „12 Euro“, „60 Euros“, die Strich-Schreibweise
 * „60,- €“, „60,– €“, „ab 60,-€“, „60.- EUR“ und die Kurzform ohne Währung „60,-“/„60.-“.
 * Nicht: „Europa-Tour“, „2 Europaletten“, „10-12 Uhr“, „Sa., 12.-14. Juni“, „Tel. 0160-123“.
 */
const PRICE_TEXT_PATTERNS = [
  // Betrag vor der Währung, optional mit Strich-Endung („60,- €“, „60.–EUR“).
  new RegExp(`\\d[\\d.,]*\\s*(?:[.,]?\\s*${DASH}{1,2}\\s*)?(?:€|eur(?:os?)?\\b)`, 'iu'),
  // Währung vor dem Betrag, auch ohne Leerzeichen („€ 60“, „EUR60“, „Euro 12“).
  /(?:€|\beur(?:os?)?)\s*\d/iu,
  // Strich-Kurzform ohne Währung („60,-“, „60,–“, „60.-“) – nicht vor einer Zahl („12.-14.“).
  new RegExp(`\\d[.,]${DASH}{1,2}(?!\\s*\\d)`, 'u'),
];

export function containsPriceText(text: string): boolean {
  const comparable = guardComparable(text);
  return PRICE_TEXT_PATTERNS.some((pattern) => pattern.test(comparable));
}

/** Prozent-Kodierung (z. B. in https-Links „…?q=Heiligkreuzweg%2090“) dekodieren – nie werfen. */
function decodePercentEncoding(text: string): string {
  let current = text;
  // Mehrfach kodierte Werte („%2520“) bis zu dreimal auflösen.
  for (let round = 0; round < 3; round += 1) {
    const next = current.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        // Ungültige UTF-8-Folge: wenigstens die ASCII-Sequenzen (%20, %2C …) auflösen.
        return run.replace(/%([0-7][0-9a-f])/gi, (_, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        );
      }
    });
    if (next === current) break;
    current = next;
  }
  return current;
}

/**
 * Normalisierung für den Adressabgleich (Review cms-1/pricing-2): NFKC, Formatzeichen ENTFERNT,
 * Prozent-Kodierung dekodiert, klein, ß ⇒ ss, „Straße“/„Strasse“/„Str.“/„Str“ ⇒ „str“, alle
 * übrigen Zeichen außer Buchstaben/Ziffern ⇒ ein Leerzeichen.
 */
export function normalizeForAddressComparison(text: string): string {
  const decoded = guardComparable(decodePercentEncoding(guardComparable(text)));
  return decoded
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/(?:strasse|str)\.?(?!\p{L})/gu, 'str ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Wörter, die beim kompakten Vergleich wegfallen („Heiligkreuzweg Nr. 90“ = „Heiligkreuzweg 90“). */
const HOUSE_NUMBER_WORDS: ReadonlySet<string> = new Set([
  'nr',
  'no',
  'nummer',
  'hausnr',
  'hausnummer',
]);
/** Straßenart allein ist nie ein Fragment („Weg 5“, „Platz 5“, „Wiese 3“). */
const STREET_TYPE_WORDS: ReadonlySet<string> = new Set([
  'str',
  'weg',
  'gasse',
  'allee',
  'platz',
  'ring',
  'ufer',
  'damm',
  'pfad',
  'steig',
  'stieg',
  'markt',
  'chaussee',
  'wiese',
  'berg',
  'feld',
  'hof',
  'graben',
  'garten',
  'park',
  'anger',
  'winkel',
  'zeile',
  'kamp',
  'grund',
  'hoehe',
  'höhe',
  'aue',
  'leite',
  'wall',
  'bogen',
  'kai',
  'tor',
  'brücke',
  'bruecke',
]);
/** Artikel/Präpositionen in Straßennamen („In der Dalheimer Wiese“) – allein nie ein Fragment. */
const STREET_FILLER_WORDS: ReadonlySet<string> = new Set([
  'am',
  'an',
  'auf',
  'im',
  'in',
  'der',
  'die',
  'das',
  'dem',
  'den',
  'zum',
  'zur',
  'beim',
  'bei',
  'vor',
  'hinter',
  'unter',
  'ober',
]);
const MIN_FRAGMENT_LENGTH = 6;

/** Kompakte Form: ohne Leerzeichen (also auch ohne Bindestriche/Punkte) und ohne „Nr.“-Wörter. */
function compactAddress(normalized: string): string {
  return normalized
    .split(' ')
    .filter((token) => !HOUSE_NUMBER_WORDS.has(token))
    .join('');
}

const hasDigit = (token: string): boolean => /\p{N}/u.test(token);
const isPostalCode = (token: string): boolean => /^\d{5}$/.test(token);
const isHouseNumber = (token: string): boolean => /^\d{1,4}[a-z]?$/.test(token);

/** „PLZ Ort“-Teil (einzige Ziffernangabe ist eine fünfstellige PLZ) – nie ein Fragment. */
function isPostalCityPart(tokens: readonly string[]): boolean {
  const numeric = tokens.filter(hasDigit);
  return numeric.length === 1 && isPostalCode(numeric[0]!);
}

/**
 * Straße + Hausnummer aus einem normalisierten Adressteil – auch ohne Komma
 * („heiligkreuzweg 90 55130 mainz“ ⇒ „heiligkreuzweg 90“). Es zählen IMMER auch die kürzeren
 * Endstücke vor der Hausnummer (Prüfung FIX-A, P1: Zusatz ohne Komma davor, z. B.
 * „Mainz-Hechtsheim Heiligkreuzweg 128“ oder „55130 Mainz Heiligkreuzweg 90“ ⇒ auch
 * „heiligkreuzweg 128“) – außer Endstücke nur aus Straßenart/Füllwörtern („wiese 3“, „der weg 5“).
 * Hausnummer mit Buchstabe („128a“) ergibt zusätzlich das Fragment mit der reinen Zahl (P2).
 */
function streetNumberFragments(tokens: readonly string[]): string[] {
  const out: string[] = [];
  let run: string[] = [];
  tokens.forEach((token) => {
    if (isHouseNumber(token) && run.length > 0) {
      const numbers = [token];
      const digitsOnly = /^(\d+)[a-z]$/.exec(token)?.[1];
      if (digitsOnly !== undefined) numbers.push(digitsOnly);
      for (let start = 0; start < run.length; start += 1) {
        const words = run.slice(start).filter((word) => !HOUSE_NUMBER_WORDS.has(word));
        if (words.length === 0) continue;
        const onlyGeneric = words.every(
          (word) => STREET_TYPE_WORDS.has(word) || STREET_FILLER_WORDS.has(word),
        );
        if (start > 0 && onlyGeneric) continue;
        for (const number of numbers) out.push([...run.slice(start), number].join(' '));
      }
      run = [];
    } else if (hasDigit(token)) {
      run = [];
    } else {
      run.push(token);
    }
  });
  return out;
}

/**
 * Prüffragmente der exakten Abholadresse (Review cms-1/pricing-2): die ganze Adresse, jeder
 * Teil (getrennt durch Komma, Semikolon oder Zeilenumbruch) MIT Ziffer und Straße +
 * Hausnummer – auch ohne Komma oder mit PLZ vorn. Teile ohne Ziffer (Firmen-/Personennamen,
 * „Mainz-Hechtsheim“) und reine „PLZ Ort“-Teile sind NIE Fragmente (sonst würden öffentliche
 * Region bzw. Impressum überblockiert). Leere/fehlende Adresse ⇒ keine Fragmente.
 */
export function exactAddressFragments(exactAddress: string | null | undefined): string[] {
  if (exactAddress === null || exactAddress === undefined) return [];
  const full = normalizeForAddressComparison(exactAddress);
  if (full === '') return [];
  const fragments = new Set<string>([full]);
  const candidates: string[] = [];
  for (const rawPart of guardComparable(exactAddress).split(/[,;\n\r]/)) {
    const part = normalizeForAddressComparison(rawPart);
    const tokens = part.split(' ').filter((token) => token !== '');
    if (!tokens.some(hasDigit) || isPostalCityPart(tokens)) continue;
    candidates.push(part, ...streetNumberFragments(tokens));
  }
  for (const candidate of candidates) {
    if (candidate.length >= MIN_FRAGMENT_LENGTH && /\p{L}/u.test(candidate)) {
      fragments.add(candidate);
    }
  }
  return [...fragments];
}

/**
 * Enthält ein Text die exakte Abholadresse (Order §5: niemals öffentlich)? Vergleich auf der
 * normalisierten UND der kompakten Form (ohne Leerzeichen/Bindestriche/Punkte, ohne „Nr.“) –
 * erkennt „Heiligkreuzweg Nr. 90“, „Heiligkreuzweg90“, „Heiligkreuz-Weg 90“, „Musterstr.5“.
 */
export function containsExactAddress(text: string, fragments: readonly string[]): boolean {
  if (fragments.length === 0) return false;
  const normalized = normalizeForAddressComparison(text);
  if (fragments.some((fragment) => normalized.includes(fragment))) return true;
  const compact = compactAddress(normalized);
  return fragments.some((fragment) => {
    const compactFragment = compactAddress(fragment);
    return compactFragment.length >= MIN_FRAGMENT_LENGTH && compact.includes(compactFragment);
  });
}

// ── SEO-Metadaten (Order §23) ────────────────────────────────────────────────

export const cmsMetaTitleSchema = cmsText(1, 70);
export const cmsMetaDescriptionSchema = cmsText(1, 170);

// ── Maschinenempfehlung (Order §12) ──────────────────────────────────────────

export const cmsRecommendationRuleSchema = z
  .strictObject({
    guestMin: z.number().int().min(1).max(100_000),
    guestMax: z.number().int().min(1).max(100_000).optional(),
    machineProductSlug: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Ungültiger Produkt-Slug.'),
  })
  .superRefine((rule, ctx) => {
    if (rule.guestMax !== undefined && rule.guestMax < rule.guestMin) {
      ctx.addIssue({
        code: 'custom',
        path: ['guestMax'],
        message: 'Die Obergrenze muss mindestens der Untergrenze entsprechen.',
      });
    }
  });
export type CmsRecommendationRule = z.infer<typeof cmsRecommendationRuleSchema>;

/** Paare überlappender Regeln (Indizes); Lücken sind erlaubt, Überlappungen nicht. */
export function overlappingRecommendationRules(
  rules: readonly CmsRecommendationRule[],
): Array<[number, number]> {
  const overlaps: Array<[number, number]> = [];
  for (let i = 0; i < rules.length; i += 1) {
    for (let j = i + 1; j < rules.length; j += 1) {
      const a = rules[i]!;
      const b = rules[j]!;
      const aMax = a.guestMax ?? Number.POSITIVE_INFINITY;
      const bMax = b.guestMax ?? Number.POSITIVE_INFINITY;
      if (a.guestMin <= bMax && b.guestMin <= aMax) overlaps.push([i, j]);
    }
  }
  return overlaps;
}

/**
 * Empfohlener Maschinen-Slug für eine Gästezahl – nur aus gepflegten Regeln, nie
 * aus einer Formel. `null` ⇒ „Wir prüfen persönlich …“ (keine Ablehnung).
 * `activeMachineSlugs` filtert Regeln auf (noch) aktive Maschinenprodukte.
 */
export function recommendMachineSlug(
  rules: readonly CmsRecommendationRule[],
  guests: number,
  activeMachineSlugs: ReadonlySet<string>,
): string | null {
  for (const rule of rules) {
    const max = rule.guestMax ?? Number.POSITIVE_INFINITY;
    if (
      guests >= rule.guestMin &&
      guests <= max &&
      activeMachineSlugs.has(rule.machineProductSlug)
    ) {
      return rule.machineProductSlug;
    }
  }
  return null;
}

// ── Website-Einstellungen (site_settings) ────────────────────────────────────

const PHONE = /^\+?[0-9][0-9 ()/-]{5,29}$/;

export const cmsSiteSettingsSchema = z
  .strictObject({
    businessName: cmsText(1, 80),
    tagline: cmsText(1, 160).optional(),
    contact: z.strictObject({
      phone: z.string().trim().regex(PHONE, 'Ungültige Telefonnummer.').optional(),
      email: z.email('Ungültige E-Mail-Adresse.').max(200).optional(),
    }),
    /** Nur ein normaler externer Link (Order §19) – kein Feed, kein iframe. */
    instagramUrl: z
      .url()
      .max(300)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === 'https:' &&
            (url.hostname === 'instagram.com' || url.hostname === 'www.instagram.com')
          );
        } catch {
          return false;
        }
      }, 'Nur https://www.instagram.com/… ist erlaubt.')
      .optional(),
    logo: cmsImageRefSchema.optional(),
    footerNote: cmsText(1, 300).optional(),
    recommendationRules: z.array(cmsRecommendationRuleSchema).max(20),
  })
  .superRefine((settings, ctx) => {
    for (const [i, j] of overlappingRecommendationRules(settings.recommendationRules)) {
      ctx.addIssue({
        code: 'custom',
        path: ['recommendationRules', j],
        message: `Die Regel überschneidet sich mit Regel ${i + 1}.`,
      });
    }
  });
export type CmsSiteSettings = z.infer<typeof cmsSiteSettingsSchema>;
export type CmsImageRef = z.infer<typeof cmsImageRefSchema>;
export type CmsCta = z.infer<typeof cmsCtaSchema>;

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

/** Alle Medien-IDs eines Inhalts (Seite oder Einstellungen) – für Medienbindung/Prüfung. */
export function collectCmsMediaIds(value: unknown): string[] {
  const ids = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node !== null && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      if (typeof record.mediaId === 'string') ids.add(record.mediaId);
      Object.values(record).forEach(visit);
    }
  };
  visit(value);
  return [...ids];
}

/** Alle Textwerte eines Inhalts (z. B. für die Prüfung „exakte Abholadresse nie öffentlich“). */
export function collectCmsStrings(value: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node !== null && typeof node === 'object') Object.values(node).forEach(visit);
  };
  visit(value);
  return out;
}
