/**
 * Phase 16 (WEB, Design §5 „Navigation“): Navigations- und Verlinkungslogik der Website.
 *
 * Grundsatz: Links auf CMS-Seiten erscheinen nur, wenn die Seite veröffentlicht ist
 * (Liste `pages` aus `GET /public/site/settings`). App-Seiten (Start, Konfigurator,
 * Kundenbereich) sind immer erreichbar. Reine Funktionen (node --test).
 */
import type { PublicSitePageSummary, SitePageType } from './site-types.ts';

export const HOME_PATH = '/';
export const CONFIGURATOR_PATH = '/konfigurator';
export const PORTAL_PATH = '/konto';
export const PRIVACY_PATH = '/datenschutz';
export const IMPRINT_PATH = '/impressum';
export const SLUSH_PATH = '/slushmaschine-mieten';
export const REGION_PATH_PREFIX = '/slushmaschine-mieten/';

/** Primärer CTA (Order §3) – nie „Jetzt verbindlich buchen“. */
export const PRIMARY_CTA_LABEL = 'Slush konfigurieren';
/** Sekundärer CTA (Order §3). */
export const SECONDARY_CTA_LABEL = 'Unverbindlich anfragen';

/** Seiten der App, die unabhängig vom CMS existieren. */
const APP_PATHS: readonly string[] = [HOME_PATH, CONFIGURATOR_PATH, PORTAL_PATH];

export interface SiteNavItem {
  label: string;
  href: string;
  /** true ⇒ CMS-Seite: nur sichtbar, wenn veröffentlicht. */
  cms: boolean;
}

/** Beschriftung der Startseite in Navigation und Brotkrume. */
export const HOME_LABEL = 'Start';

/** Hauptnavigation (Order §3): Start, Slush, Ablauf, FAQ, Über uns, Kontakt, Kundenbereich. */
export const SITE_NAV_ITEMS: readonly SiteNavItem[] = [
  { label: HOME_LABEL, href: HOME_PATH, cms: false },
  { label: 'Slush', href: SLUSH_PATH, cms: true },
  { label: 'Ablauf', href: '/ablauf', cms: true },
  { label: 'FAQ', href: '/faq', cms: true },
  { label: 'Über uns', href: '/ueber-uns', cms: true },
  { label: 'Kontakt', href: '/kontakt', cms: true },
  { label: 'Kundenbereich', href: PORTAL_PATH, cms: false },
];

export function publishedPathSet(
  pages: readonly PublicSitePageSummary[] | null | undefined,
): Set<string> {
  return new Set((pages ?? []).map((page) => page.path));
}

export function visibleNavItems(published: ReadonlySet<string>): SiteNavItem[] {
  return SITE_NAV_ITEMS.filter((item) => !item.cms || published.has(item.href));
}

/** `aria-current="page"` für den aktuellen Pfad (Start nur exakt, sonst auch Unterseiten). */
export function isCurrentNavItem(currentPath: string, href: string): boolean {
  if (href === HOME_PATH) return currentPath === HOME_PATH;
  return currentPath === href || currentPath.startsWith(`${href}/`);
}

export type ResolvedHref =
  | { kind: 'internal'; href: string }
  | { kind: 'external'; href: string }
  | { kind: 'contact'; href: string };

const INTERNAL_PATH = /^\/(?!\/)[a-z0-9\-/]*(#[a-z0-9-]+)?$/;

/**
 * CMS-Link ⇒ darstellbares Ziel oder `null` (ausblenden):
 * - interner Pfad: nur App-Seiten oder VERÖFFENTLICHTE CMS-Seiten (sonst 404-Link);
 * - `https:` ⇒ extern (rel="noopener noreferrer");
 * - `mailto:`/`tel:` ⇒ Kontaktlink; alles andere (javascript:, data:, http:) ⇒ null.
 */
export function resolveSiteHref(href: string, published: ReadonlySet<string>): ResolvedHref | null {
  const value = href.trim();
  if (INTERNAL_PATH.test(value)) {
    const path = value.split('#')[0] ?? value;
    const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
    if (APP_PATHS.includes(normalized) || normalized.startsWith(`${PORTAL_PATH}/`)) {
      return { kind: 'internal', href: value };
    }
    return published.has(normalized) ? { kind: 'internal', href: value } : null;
  }
  if (/^mailto:[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/.test(value)) {
    return { kind: 'contact', href: value };
  }
  if (/^tel:\+?[0-9]{6,20}$/.test(value)) return { kind: 'contact', href: value };
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.username === '' && url.password === '') {
      return { kind: 'external', href: url.toString() };
    }
  } catch {
    return null;
  }
  return null;
}

export function pagesOfType(
  pages: readonly PublicSitePageSummary[] | null | undefined,
  pageType: SitePageType,
): PublicSitePageSummary[] {
  return (pages ?? []).filter((page) => page.pageType === pageType);
}

/** Rechtliche Links im Footer – nur veröffentlichte Rechtstexte (Order §5/§17). */
export function footerLegalLinks(published: ReadonlySet<string>): SiteNavItem[] {
  const links: SiteNavItem[] = [
    { label: 'Impressum', href: IMPRINT_PATH, cms: true },
    { label: 'Datenschutz', href: PRIVACY_PATH, cms: true },
  ];
  return links.filter((link) => published.has(link.href));
}

/**
 * Ortsname ⇒ Pfad-Slug wie im CMS (`bad-kreuznach`): Umlaute ausgeschrieben,
 * alles außer a–z/0–9 als Bindestrich.
 */
export function slugifyArea(area: string): string {
  return area
    .toLocaleLowerCase('de-DE')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Einsatzgebiet ⇒ Link auf eine VERÖFFENTLICHTE Regionsseite mit passendem Slug, sonst null
 * (keine automatisch erzeugten Ortsseiten, Order §20).
 */
export function regionHrefForArea(
  area: string,
  pages: readonly PublicSitePageSummary[] | null | undefined,
): string | null {
  const slug = slugifyArea(area);
  if (slug === '') return null;
  const path = `${REGION_PATH_PREFIX}${slug}`;
  return pagesOfType(pages, 'region').some((page) => page.path === path) ? path : null;
}

/** Datenschutzhinweise veröffentlicht ⇒ Website-Anfrage möglich (Order §17, fail-closed). */
export function isPrivacyPublished(
  pages: readonly PublicSitePageSummary[] | null | undefined,
): boolean {
  return (pages ?? []).some((page) => page.path === PRIVACY_PATH && page.pageType === 'legal');
}

/** Gültiger Regions-Slug (wie `CMS_REGION_SLUG_PATTERN`, 2–60 Zeichen). */
export function isValidRegionSlug(slug: string): boolean {
  return slug.length >= 2 && slug.length <= 60 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
}

/** Instagram nur als normaler https-Link auf instagram.com (Order §19). */
export function safeInstagramUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
    if (url.hostname !== 'instagram.com' && url.hostname !== 'www.instagram.com') return null;
    return url.toString();
  } catch {
    return null;
  }
}

// ── Brotkrumen (Phase 17, Design D11) ────────────────────────────────────────

export interface BreadcrumbItem {
  name: string;
  href: string;
}

/**
 * Sichtbare Brotkrume (und Grundlage der `BreadcrumbList`) – nur wo sie die Orientierung
 * verbessert: Regionsseiten `Start › Slushmaschine mieten › <Seitentitel>` (die Slush-Seite
 * nur, wenn sie veröffentlicht ist; Beschriftung = ihr veröffentlichter Titel) und
 * Secondary-Offer-Seiten `Start › <Seitentitel>`. Alle anderen Seitentypen: keine Brotkrume.
 */
export function breadcrumbItems(
  page: { pageType: SitePageType | string; title: string; path: string },
  pages: readonly PublicSitePageSummary[] | null | undefined,
): BreadcrumbItem[] {
  const current: BreadcrumbItem = { name: page.title, href: page.path };
  if (page.pageType === 'region') {
    const slush = (pages ?? []).find(
      (candidate) => candidate.path === SLUSH_PATH && candidate.pageType === 'slush',
    );
    return [
      { name: HOME_LABEL, href: HOME_PATH },
      ...(slush === undefined ? [] : [{ name: slush.title, href: SLUSH_PATH }]),
      current,
    ];
  }
  if (page.pageType === 'secondary_offer') return [{ name: HOME_LABEL, href: HOME_PATH }, current];
  return [];
}
