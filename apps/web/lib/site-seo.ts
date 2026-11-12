/**
 * Phase 17 (WEB-META, Design D1–D3, D7–D9): reine SEO-Logik der Website.
 *
 * - Kanonische Basis (D1): ausschließlich die von der API gelieferte, konfigurierte
 *   öffentliche Web-Basis (`publicBaseUrl` = MAIL_PUBLIC_WEB_BASE_URL). NIE Host-,
 *   X-Forwarded-Host- oder Request-URL-Ableitung. Hier wird sie zusätzlich geprüft:
 *   absolute URL, `https:` (`http:` nur für localhost/127.0.0.1 in dev/E2E), keine
 *   Zugangsdaten, kein Query/Fragment, Pfad genau `/` – sonst `null` ⇒ fail-closed.
 * - Indexierbarkeit (D2): `WEB_INDEXING_ENABLED=true` UND keine Demo UND keine
 *   Origin-Sperre UND gültige Basis. Ohne Indexierbarkeit gibt es KEINE absoluten URLs
 *   (kein Canonical, kein og:url, keine Sitemap-Einträge, kein JSON-LD).
 * - Metadaten (D9): Titel/Beschreibung aus dem CMS (Source of Truth), robots, Canonical,
 *   OpenGraph, Twitter Card; Bild nur aus dem Hero-Bild der Seite (veröffentlichte,
 *   rechtegeklärte CMS-Bildreferenz), keine Meta-Keywords, kein erfundenes Bild.
 * - robots.txt (D7) und Sitemap (D8) als reine Builder.
 *
 * Reine Funktionen ohne React-/Next-Abhängigkeit (node --test).
 */
import { SITE_PATH_PATTERN } from './site-api.ts';
import { isOwnMediaUrl } from './site-blocks.ts';
import { CONFIGURATOR_PATH, HOME_PATH } from './site-nav.ts';
import type { PublicBlock, PublicImage, PublicSitePageSummary } from './site-types.ts';

// ── Kanonische Basis (D1) ────────────────────────────────────────────────────

/** `http:` ist nur für lokale Entwicklungs-/E2E-Instanzen zulässig (Production: nur HTTPS). */
export const SEO_LOCAL_HTTP_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];

/**
 * Gültige SEO-Basis oder `null`: absolute URL, `https:` (bzw. `http:` nur für
 * localhost/127.0.0.1), keine Zugangsdaten, kein Query/Fragment, Pfad genau `/`.
 * Rückgabe ohne Schluss-Slash (`https://www.example.org`, ggf. mit Port).
 */
export function validSeoBaseUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || /[?#\s]/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '' || url.hostname === '') return null;
  if (url.protocol === 'http:') {
    if (!SEO_LOCAL_HTTP_HOSTS.includes(url.hostname)) return null;
  } else if (url.protocol !== 'https:') {
    return null;
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  return url.origin;
}

// ── Indexierbarkeit (D2) ─────────────────────────────────────────────────────

export interface SeoContextInput {
  /** `WEB_INDEXING_ENABLED=true` (exakt). */
  indexingEnabled: boolean;
  /** Demo-Instanz: WEB_APP_ENV=demo, /health meldet demo oder Bootstrap `environment: 'demo'`. */
  demo: boolean;
  /** Build-/Laufzeit-Origin weichen ab (fail-closed wie Absenden/Vorschau). */
  originMismatch: boolean;
  /** Rohwert `publicBaseUrl` aus dem Bootstrap (wird hier geprüft). */
  base: string | null | undefined;
}

export interface SeoContext {
  /** Darf diese Instanz überhaupt indexiert werden? (Seitenbedingungen kommen hinzu.) */
  indexable: boolean;
  /** Gültige Basis NUR wenn indexierbar – sonst null (keine absoluten URLs). */
  base: string | null;
}

/** Website-Kontext für die Metadaten einer Seite (Kontext + Anzeigename der Marke). */
export interface SeoEnv extends SeoContext {
  siteName: string;
}

export function seoContext(input: SeoContextInput): SeoContext {
  const base = validSeoBaseUrl(input.base);
  const indexable = input.indexingEnabled && !input.demo && !input.originMismatch && base !== null;
  return { indexable, base: indexable ? base : null };
}

/**
 * Konfigurator „technisch nutzbar“ (Auftrag §10/§22, D8): Katalog erreichbar, mindestens eine
 * Maschine, Datenschutzhinweise veröffentlicht, keine Origin-Sperre.
 */
export function configuratorIndexable(input: {
  catalogOk: boolean;
  machineCount: number;
  privacyPublished: boolean;
  originMismatch: boolean;
}): boolean {
  return (
    input.catalogOk && input.machineCount > 0 && input.privacyPublished && !input.originMismatch
  );
}

// ── Canonical (D3) ───────────────────────────────────────────────────────────

/** Pfad ohne Query/Fragment, mit führendem Slash, ohne Schluss-Slash (außer `/`). */
export function normalizeSeoPath(path: string): string {
  const withoutQuery = (path.split(/[?#]/, 1)[0] ?? '').trim();
  const leading = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
  const collapsed = leading.replace(/\/{2,}/g, '/');
  const stripped = collapsed.replace(/\/+$/, '');
  return stripped === '' ? HOME_PATH : stripped;
}

/** Absoluter Canonical `${base}${pfad}`; Startseite `${base}/`. */
export function canonicalUrl(base: string, path: string): string {
  return `${base}${normalizeSeoPath(path)}`;
}

// ── Bilder (Auftrag §12) ─────────────────────────────────────────────────────

/** Nur VERÖFFENTLICHTE Medien der eigenen API (nie Vorschau-Medien, nie fremde Hosts). */
const PUBLISHED_MEDIA_PREFIX = '/api/public/cms/media/';

/** Absolute Medien-URL nur für eigene veröffentlichte Medien-Varianten, sonst null. */
export function absoluteMediaUrl(base: string, variantUrl: string): string | null {
  if (!isOwnMediaUrl(variantUrl) || !variantUrl.startsWith(PUBLISHED_MEDIA_PREFIX)) return null;
  return `${base}${variantUrl}`;
}

export interface SeoImage {
  url: string;
  width: number;
  height: number;
  alt?: string;
}

/**
 * Größte veröffentlichte Variante eines CMS-Bilds als absolutes Social Image; Höhe
 * proportional aus dem Seitenverhältnis des Originals; `alt` nur, wenn nicht dekorativ.
 * Ohne gültige Variante oder Maße ⇒ null (kein Bild erfinden).
 */
export function seoImageFrom(image: PublicImage, base: string): SeoImage | null {
  const variants = image.variants
    .filter(
      (variant) =>
        Number.isInteger(variant.width) &&
        variant.width > 0 &&
        absoluteMediaUrl(base, variant.url) !== null,
    )
    .sort((a, b) => b.width - a.width);
  const largest = variants[0];
  if (largest === undefined) return null;
  if (!(image.width > 0) || !(image.height > 0)) return null;
  const url = absoluteMediaUrl(base, largest.url);
  if (url === null) return null;
  const alt = image.decorative ? '' : image.alt.trim();
  return {
    url,
    width: largest.width,
    height: Math.max(1, Math.round((largest.width * image.height) / image.width)),
    ...(alt === '' ? {} : { alt }),
  };
}

/** Social Image einer Seite: nur das Bild eines Hero-Blocks an erster Stelle. */
export function socialImage(
  page: { blocks: readonly PublicBlock[] },
  base: string | null,
): SeoImage | null {
  if (base === null) return null;
  const first = page.blocks[0];
  if (first === undefined || first.type !== 'hero' || first.image === undefined) return null;
  return seoImageFrom(first.image, base);
}

// ── Metadaten (D9) ───────────────────────────────────────────────────────────

export interface SiteRobots {
  index: boolean;
  follow: boolean;
  nocache?: boolean;
}

export interface SiteOpenGraph {
  title: string;
  description?: string;
  type: 'website';
  locale: 'de_DE';
  siteName: string;
  url?: string;
  images?: SeoImage[];
}

export interface SiteTwitter {
  card: 'summary' | 'summary_large_image';
  title: string;
  description?: string;
  images?: SeoImage[];
}

/** Strukturelle Teilmenge von Nexts `Metadata` (ohne Next-Import – node --test). */
export interface SiteMetadata {
  title: string;
  description?: string;
  robots: SiteRobots;
  alternates?: { canonical: string };
  openGraph?: SiteOpenGraph;
  twitter?: SiteTwitter;
}

export interface BuildSiteMetadataInput {
  /** Fertiger Dokumenttitel (über `sitePageTitle`, keine Markendoppelung). */
  title: string;
  description?: string | null | undefined;
  /** Pfad der Seite (Query/Fragment werden entfernt). */
  path: string;
  /** Endgültige Entscheidung dieser Seite (Website-Kontext UND Seitenbedingung). */
  indexable: boolean;
  base: string | null;
  siteName: string;
  image?: SeoImage | null | undefined;
}

/**
 * Metadaten einer öffentlichen Seite: robots index/follow nur wenn indexierbar; Canonical,
 * og:url und Bilder (absolute URLs) NUR wenn indexierbar UND Basis vorhanden (fail-closed);
 * OpenGraph/Twitter immer (ohne Bild zulässig, Auftrag §12). Keine Meta-Keywords.
 */
export function buildSiteMetadata(input: BuildSiteMetadataInput): SiteMetadata {
  const description = (input.description ?? '').trim();
  const text = description === '' ? {} : { description };
  const absolute = input.indexable && input.base !== null;
  const url = absolute && input.base !== null ? canonicalUrl(input.base, input.path) : null;
  const image = absolute ? (input.image ?? null) : null;
  return {
    title: input.title,
    ...text,
    robots: input.indexable ? { index: true, follow: true } : { index: false, follow: false },
    ...(url === null ? {} : { alternates: { canonical: url } }),
    openGraph: {
      title: input.title,
      ...text,
      type: 'website',
      locale: 'de_DE',
      siteName: input.siteName,
      ...(url === null ? {} : { url }),
      ...(image === null ? {} : { images: [image] }),
    },
    twitter: {
      card: image === null ? 'summary' : 'summary_large_image',
      title: input.title,
      ...text,
      ...(image === null ? {} : { images: [image] }),
    },
  };
}

// ── robots.txt (D7) ──────────────────────────────────────────────────────────

/**
 * Indexierbar ⇒ gesperrt wird NUR `/api/` (liefert kein indexierbares HTML). Portal (`/konto`),
 * Vorschau (`/vorschau`), Angebots-/Dokument-/Kontakt-Token-Links werden bewusst NICHT per
 * Disallow gesperrt (Leitungsentscheidung D7 nach Google Search Central „Block Search indexing
 * with noindex“): `noindex` wirkt nur, wenn die Seite gecrawlt werden darf – eine per robots.txt
 * blockierte URL kann ohne Inhalt trotzdem indexiert werden, ihr noindex wird nie gesehen; bei
 * Token-URLs wäre genau die URL das Geheimnis. Diese Seiten bleiben ausschließlich über noindex
 * (Meta + X-Robots-Tag, Phase 12/15/16) aus dem Index und stehen nie in der Sitemap. Keine
 * Tokens in robots.txt; robots ist keine Sicherheitsgrenze.
 */
export const ROBOTS_DISALLOW_PATHS: readonly string[] = ['/api/'];

export interface RobotsRule {
  userAgent: string;
  allow?: string;
  disallow: string | string[];
}

export interface RobotsFile {
  rules: RobotsRule[];
  sitemap?: string;
}

/** Nicht indexierbar ⇒ alles gesperrt, keine Sitemap-Zeile; sonst Allow + Sperrliste + Sitemap. */
export function robotsRules(context: SeoContext): RobotsFile {
  if (!context.indexable || context.base === null) {
    return { rules: [{ userAgent: '*', disallow: '/' }] };
  }
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: [...ROBOTS_DISALLOW_PATHS] }],
    sitemap: `${context.base}/sitemap.xml`,
  };
}

// ── Sitemap (D8) ─────────────────────────────────────────────────────────────

export interface SitemapEntry {
  url: string;
  /** Nur echte Veröffentlichungszeitpunkte (ISO), nie erfunden. */
  lastModified?: string;
}

/** Gültiger ISO-Zeitpunkt ⇒ normalisierte ISO-Form, sonst null. */
export function validIsoDate(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/**
 * Sitemap-Einträge: alle veröffentlichten Seiten des Bootstraps (Pfadformat wie das CMS,
 * Dubletten entfallen) mit `lastModified` nur aus `publishedAt`, plus `/konfigurator` ohne
 * Datum, wenn nutzbar. Reihenfolge stabil: Startseite zuerst, dann Pfade sortiert.
 */
export function sitemapEntries(input: {
  base: string;
  pages: readonly PublicSitePageSummary[];
  configurator: boolean;
}): SitemapEntry[] {
  const seen = new Set<string>();
  const entries: Array<{ path: string; lastModified: string | null }> = [];
  for (const page of input.pages) {
    const path = normalizeSeoPath(page.path);
    if (path.length > 200 || !SITE_PATH_PATTERN.test(path) || seen.has(path)) continue;
    seen.add(path);
    entries.push({ path, lastModified: validIsoDate(page.publishedAt) });
  }
  if (input.configurator && !seen.has(CONFIGURATOR_PATH)) {
    entries.push({ path: CONFIGURATOR_PATH, lastModified: null });
  }
  entries.sort((a, b) => {
    if (a.path === HOME_PATH) return -1;
    if (b.path === HOME_PATH) return 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return entries.map((entry) => ({
    url: canonicalUrl(input.base, entry.path),
    ...(entry.lastModified === null ? {} : { lastModified: entry.lastModified }),
  }));
}
