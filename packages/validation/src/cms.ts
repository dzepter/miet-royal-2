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

/** Steuerzeichen außer Zeilenumbruch und HTML-artige Tags sind in CMS-Texten verboten. */
function hasForbiddenControl(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code < 0x20 && code !== 0x0a) || code === 0x7f) return true;
  }
  return false;
}
const TAG_LIKE = /<\s*[a-zA-Z/!?]/;

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
/** Maschinenübersicht – Produkte und Preise kommen beim Rendern aus dem Katalog, nie aus dem CMS. */
export const cmsProductGridBlockSchema = z.strictObject({
  type: z.literal('product_grid'),
  heading: heading.optional(),
  intro: intro.optional(),
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
  }
  return issues;
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
