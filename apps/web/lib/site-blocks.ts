/**
 * Phase 16 (WEB, Design §5 „Renderer“): reine Logik des Block-Renderers.
 *
 * Der Renderer (`components/site/block-renderer.tsx`) behandelt JEDEN Blocktyp aus
 * `SITE_BLOCK_TYPES` (Spiegel von `CMS_BLOCK_TYPES`); hier steht, welche Blöcke überhaupt
 * dargestellt werden (unbekannte Typen einer neueren API werden ignoriert, Bewertungen nur mit
 * aktivem Provider, sekundäre Angebote nur mit veröffentlichter Seite …) und wie die H1 einer
 * Seite bestimmt wird. Reine Funktionen (node --test).
 */
import { reviewsSectionVisible } from './reviews.ts';
import { phoneHref } from './site-format.ts';
import {
  CONFIGURATOR_PATH,
  SECONDARY_CTA_LABEL,
  pagesOfType,
  safeInstagramUrl,
} from './site-nav.ts';
import {
  SITE_BLOCK_TYPES,
  type PublicBlock,
  type PublicSitePageSummary,
  type PublicSiteSettings,
  type ReviewMode,
  type SiteBlockType,
  type SitePageType,
} from './site-types.ts';

/** Anzeigename je Blocktyp (data-Attribute/Test-IDs; jeder Typ MUSS hier stehen). */
export const SITE_BLOCK_LABELS: Readonly<Record<SiteBlockType, string>> = {
  hero: 'Einstieg',
  text: 'Text',
  features: 'Vorteile',
  steps: 'Ablauf',
  product_grid: 'Produkte',
  included_items: 'Inklusive',
  image: 'Bild',
  gallery: 'Galerie',
  faq: 'Häufige Fragen',
  reviews: 'Bewertungen',
  service_areas: 'Einsatzgebiet',
  secondary_offers: 'Weitere Angebote',
  contact_details: 'Kontakt',
  cta: 'Aufruf',
};

export function isSiteBlockType(value: unknown): value is SiteBlockType {
  return typeof value === 'string' && (SITE_BLOCK_TYPES as readonly string[]).includes(value);
}

export interface BlockVisibilityContext {
  reviewsMode: ReviewMode | string;
  pages: readonly PublicSitePageSummary[];
  settings: PublicSiteSettings | null;
}

/** Hat der Kontaktblock etwas anzuzeigen? (Werte nur aus veröffentlichten Einstellungen.) */
export function hasContactDetails(settings: PublicSiteSettings | null): boolean {
  return (
    settings !== null &&
    ((settings.phone ?? '').trim() !== '' ||
      (settings.email ?? '').trim() !== '' ||
      (settings.instagramUrl ?? '').trim() !== '')
  );
}

export const CONTACT_DETAILS_TEXT = {
  /** Ohne gepflegte Kontaktdaten auf Slush-Seiten: Anfrage über den Konfigurator. */
  NO_DETAILS_INQUIRY:
    'Am schnellsten erreichst du uns mit einer unverbindlichen Anfrage über den Konfigurator.',
  /** Ohne gepflegte Kontaktdaten auf Popcorn-/Waffel-Seiten (kein Konfigurator-Verweis). */
  NO_DETAILS_DIRECT: 'Unsere Kontaktdaten ergänzen wir hier in Kürze.',
} as const;

/** Was der Kontaktblock zeigt – vollständig aus Seitentyp, Einstellungen und Abholregion. */
export interface ContactDetailsPlan {
  phone: { text: string; href: string } | null;
  email: { text: string; href: string } | null;
  instagram: string | null;
  /** Zeile „Abholung: …“ (nur Slush-Kontext). */
  pickupArea: string | null;
  /** Knopf „Unverbindlich anfragen“ → Konfigurator (nur Slush-Kontext). */
  inquiryCta: { href: string; label: string } | null;
  /** Hinweis statt der Liste, wenn kein Kontaktweg gepflegt ist; sonst null. */
  emptyText: string | null;
}

/**
 * Kontaktblock je Seitentyp (Review content_ux-2, Order §3/§10/§11): Der Konfigurator kann nur
 * Slush, und der Abholort Mainz-Hechtsheim ist nur für Slush belegt (Popcorn-/Waffel-Transport
 * offen). Auf `secondary_offer`-Seiten daher KEINE Abholzeile und KEIN „Unverbindlich
 * anfragen“ → /konfigurator – nur Telefon/E-Mail aus den Einstellungen. Alle anderen
 * Seitentypen unverändert: Kontaktwege + Abholung + Anfrage-Knopf.
 */
export function contactDetailsPlan(input: {
  pageType: SitePageType | string | null | undefined;
  settings: PublicSiteSettings | null;
  pickupArea: string;
}): ContactDetailsPlan {
  const { settings } = input;
  const phoneText = settings?.phone?.trim() ?? '';
  const tel = phoneText === '' ? null : phoneHref(phoneText);
  const phone = tel === null ? null : { text: phoneText, href: tel };
  const emailText = settings?.email?.trim() ?? '';
  const email = emailText === '' ? null : { text: emailText, href: `mailto:${emailText}` };
  if (input.pageType === 'secondary_offer') {
    return {
      phone,
      email,
      instagram: null,
      pickupArea: null,
      inquiryCta: null,
      emptyText: phone === null && email === null ? CONTACT_DETAILS_TEXT.NO_DETAILS_DIRECT : null,
    };
  }
  return {
    phone,
    email,
    instagram: safeInstagramUrl(settings?.instagramUrl),
    pickupArea: input.pickupArea,
    inquiryCta: { href: CONFIGURATOR_PATH, label: SECONDARY_CTA_LABEL },
    emptyText: hasContactDetails(settings) ? null : CONTACT_DETAILS_TEXT.NO_DETAILS_INQUIRY,
  };
}

/** Wird dieser Block dargestellt? */
export function isBlockVisible(block: PublicBlock, ctx: BlockVisibilityContext): boolean {
  if (!isSiteBlockType(block.type)) return false;
  switch (block.type) {
    case 'reviews':
      return reviewsSectionVisible(ctx.reviewsMode);
    case 'secondary_offers':
      return pagesOfType(ctx.pages, 'secondary_offer').length > 0;
    case 'product_grid':
      return Array.isArray(block.products) && block.products.length > 0;
    case 'gallery':
      return Array.isArray(block.images) && block.images.length > 0;
    case 'faq':
      return Array.isArray(block.items) && block.items.length > 0;
    case 'features':
    case 'steps':
      return Array.isArray(block.items) && block.items.length > 0;
    case 'service_areas':
      return Array.isArray(block.areas) && block.areas.length > 0;
    default:
      return true;
  }
}

/** Darstellbare Blöcke in Originalreihenfolge. */
export function visibleBlocks(
  blocks: readonly PublicBlock[],
  ctx: BlockVisibilityContext,
): PublicBlock[] {
  return blocks.filter((block) => isBlockVisible(block, ctx));
}

/**
 * Die H1 einer Seite: Überschrift des Hero-Blocks, wenn er der erste Block ist (CMS-Regel),
 * sonst der Seitentitel.
 */
export function pageUsesHeroHeading(blocks: readonly PublicBlock[]): boolean {
  return blocks[0]?.type === 'hero';
}

/** `srcSet` aus den Varianten (aufsteigend): „/api/…/480 480w, /api/…/960 960w“. */
export function imageSrcSet(variants: ReadonlyArray<{ width: number; url: string }>): string {
  return [...variants]
    .filter((variant) => Number.isInteger(variant.width) && variant.width > 0)
    .sort((a, b) => a.width - b.width)
    .map((variant) => `${variant.url} ${variant.width}w`)
    .join(', ');
}

/** Standard-`src`: mittlere Variante (≈ 960 px) bzw. die größte vorhandene darunter. */
export function imageDefaultSrc(
  variants: ReadonlyArray<{ width: number; url: string }>,
): string | null {
  const sorted = [...variants].sort((a, b) => a.width - b.width);
  if (sorted.length === 0) return null;
  const candidate = sorted.filter((variant) => variant.width <= 960).pop() ?? sorted[0]!;
  return candidate.url;
}

/** Bild-URLs nur aus der eigenen API (opake Medienroute) – nie fremde Hosts. */
export function isOwnMediaUrl(url: string): boolean {
  return /^\/api\/public\/cms\/(media|preview-media)\/[0-9a-f-]{36}\/[0-9]{1,5}$/i.test(url);
}
