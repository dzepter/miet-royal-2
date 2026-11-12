/**
 * Phase 16 (WEB, Design §1.7/§11.2.9) / Phase 17 (WEB-META, Design D2/D3/D9): Indexierungs-
 * Entscheidung und Metadaten der Website.
 *
 * Fail-closed: `WEB_INDEXING_ENABLED=true` (exakt) ist nur EINE Bedingung – indexierbar ist eine
 * Seite erst, wenn außerdem keine Demo-Instanz vorliegt, Build-/Laufzeit-Origin übereinstimmen,
 * die konfigurierte öffentliche Basis gültig ist (`seoContext`, lib/site-seo.ts) und die Seite
 * tatsächlich veröffentlicht ist. Das Root-Layout setzt `robots` seit Phase 17 IMMER noindex;
 * jede Website-Seite setzt `robots`, Canonical, OpenGraph und Twitter Card selbst. Token-Seiten,
 * `/konto` und `/vorschau` setzen in ihren Layouts immer `noindex` (Segment-Metadata ersetzt
 * `robots` vollständig). Fallback-Startseite, „nicht erreichbar“ und 404 sind immer noindex ohne
 * Canonical. Reine Funktionen (node --test).
 */
import type { SiteFetchResult } from './site-api.ts';
import { SITE_BRAND_NAME, sitePageTitle } from './site-format.ts';
import { CONFIGURATOR_PATH } from './site-nav.ts';
import {
  buildSiteMetadata,
  configuratorIndexable,
  seoContext,
  socialImage,
  type SeoEnv,
  type SiteMetadata,
  type SiteRobots,
} from './site-seo.ts';
import type { PublicCatalog, PublicPage, PublicSiteBootstrap, SitePageType } from './site-types.ts';

export type { SeoEnv, SiteMetadata, SiteRobots } from './site-seo.ts';

/** Nie indexieren (Token-/Vorschau-/Fehler-/Nicht-gefunden-Darstellungen, Root-Default). */
export const NOINDEX_ROBOTS: SiteRobots = { index: false, follow: false };

/** Default AUS: nur der Wert `true` (klein geschrieben, äußerer Leerraum egal) öffnet. */
export function readIndexingEnabled(
  value: string | undefined = process.env.WEB_INDEXING_ENABLED,
): boolean {
  return (value ?? '').trim() === 'true';
}

export interface IndexingDecisionInput {
  /** `WEB_INDEXING_ENABLED=true`. */
  indexingEnabled: boolean;
  /** Demo-Web-Instanz (`WEB_APP_ENV=demo` oder Demo-Banner aktiv / API meldet `demo`). */
  demo: boolean;
}

/**
 * Reine Robots-Entscheidung aus Schalter und Demo: Default noindex/nofollow, mit Freigabe
 * index/follow – die Demo-Instanz ist IMMER noindex, auch mit gesetztem Flag (Review
 * demo_reviews-5). Seit Phase 17 entscheiden die Seiten vollständig über `seoContext`
 * (zusätzlich Basis und Origin); diese Funktion bleibt als Teilentscheidung bestehen.
 */
export function siteRobots(input: IndexingDecisionInput): SiteRobots {
  return input.indexingEnabled && !input.demo
    ? { index: true, follow: true }
    : { ...NOINDEX_ROBOTS };
}

/**
 * Website-Kontext einer Anfrage aus den je Request deduplizierten Quellen: Bootstrap
 * (Basis `publicBaseUrl`, `environment`, Markenname), Demo-Entscheidung (WEB_APP_ENV bzw.
 * /health) und Origin-Vergleich. Ohne erreichbaren Bootstrap gibt es keine Basis ⇒ nicht
 * indexierbar (fail-closed). Nie aus Request-Headern.
 */
export function seoEnvFrom(
  bootstrap: SiteFetchResult<PublicSiteBootstrap>,
  demo: boolean,
  originMismatch: boolean,
  indexingEnabled: boolean = readIndexingEnabled(),
): SeoEnv {
  const boot = bootstrap.ok ? bootstrap.data : null;
  const context = seoContext({
    indexingEnabled,
    demo: demo || boot?.environment === 'demo',
    originMismatch,
    base: boot?.publicBaseUrl,
  });
  return { ...context, siteName: boot?.settings?.businessName ?? SITE_BRAND_NAME };
}

export interface CmsMetadataInput {
  title: string;
  metaTitle: string | null;
  metaDescription: string | null;
}

export interface CmsPageText {
  title: string;
  description?: string;
}

/** Titel/Beschreibung einer CMS-Seite (Meta-Titel/-Beschreibung aus dem CMS, Fallback Seitentitel). */
export function cmsPageMetadata(page: CmsMetadataInput): CmsPageText {
  const description = (page.metaDescription ?? '').trim();
  return {
    title: sitePageTitle(page.metaTitle, page.title),
    ...(description === '' ? {} : { description }),
  };
}

/** Metadaten einer Darstellung, die nie indexiert werden darf (z. B. API nicht erreichbar). */
export function noindexMetadata(title: string): SiteMetadata {
  return { title: sitePageTitle(null, title), robots: { ...NOINDEX_ROBOTS } };
}

/** Titel der Zustandsseite „API nicht erreichbar“. */
export const UNAVAILABLE_TITLE = 'Gleich wieder da';
/** Titel der Fallback-Startseite („Unsere neue Website wird gerade vorbereitet.“). */
export const FALLBACK_HOME_TITLE = 'Miet-Royal';
/** Titel der 404-Seite (Auftrag §17). */
export const NOT_FOUND_TITLE = 'Seite nicht gefunden';

/**
 * Vollständige Metadaten einer veröffentlichten CMS-Seite (D9): Titel/Beschreibung aus dem CMS,
 * robots/Canonical/og:url nach Website-Kontext, Social Image nur aus dem Hero-Bild der Seite.
 */
export function cmsPageSeoMetadata(page: PublicPage, env: SeoEnv): SiteMetadata {
  const text = cmsPageMetadata(page);
  return buildSiteMetadata({
    title: text.title,
    description: text.description,
    path: page.path,
    indexable: env.indexable,
    base: env.base,
    siteName: env.siteName,
    image: socialImage(page, env.base),
  });
}

/**
 * Metadaten der Startseite (Review web_security-2, Design §1.7 „nur veröffentlichte öffentliche
 * Seiten indexierbar“): nur eine veröffentlichte Startseite (pageType `home`) kann indexierbar
 * sein. Fallback-Startseite (nichts veröffentlicht, falscher Typ, 401) und „nicht erreichbar“
 * sind IMMER noindex ohne Canonical/og:url.
 */
export function homeMetadata(result: SiteFetchResult<PublicPage>, env: SeoEnv): SiteMetadata {
  if (result.ok && result.data.pageType === 'home') return cmsPageSeoMetadata(result.data, env);
  if (!result.ok && result.reason === 'unavailable') return noindexMetadata(UNAVAILABLE_TITLE);
  return noindexMetadata(FALLBACK_HOME_TITLE);
}

/**
 * Metadaten einer CMS-Route: `null` ⇒ 404 (nicht veröffentlicht / falscher Seitentyp),
 * „nicht erreichbar“ ⇒ IMMER noindex, sonst vollständige Metadaten aus dem CMS.
 */
export function cmsRouteMetadataFor(
  result: SiteFetchResult<PublicPage>,
  expectedTypes: readonly SitePageType[] | undefined,
  env: SeoEnv,
): SiteMetadata | null {
  if (result.ok) {
    if (expectedTypes !== undefined && !expectedTypes.includes(result.data.pageType)) return null;
    return cmsPageSeoMetadata(result.data, env);
  }
  if (result.reason === 'not_found') return null;
  return noindexMetadata(UNAVAILABLE_TITLE);
}

export const CONFIGURATOR_TITLE = 'Slush konfigurieren';
export const CONFIGURATOR_DESCRIPTION =
  'Stell dir in wenigen Schritten deine Slushmaschine mit Sirup und Zubehör zusammen und fordere ein unverbindliches Angebot an.';

export interface ConfiguratorMetadataInput extends SeoEnv {
  /** Datenschutzhinweise veröffentlicht (sonst kein Absenden ⇒ nicht nutzbar). */
  privacyPublished: boolean;
  /** Build-/Laufzeit-Origin weichen ab (Absenden gesperrt ⇒ nicht nutzbar). */
  originMismatch: boolean;
}

/**
 * Metadaten des Konfigurators (D8/D9, Auftrag §22): fester Titel + Beschreibung; Canonical
 * immer `/konfigurator` (nie `?maschine=…`); indexierbar nur, wenn der Website-Kontext es
 * erlaubt UND der Konfigurator nutzbar ist (Katalog erreichbar, ≥ 1 Maschine, Datenschutz
 * veröffentlicht, keine Origin-Sperre) – sonst noindex ohne Canonical.
 */
export function configuratorMetadata(
  result: SiteFetchResult<PublicCatalog>,
  input: ConfiguratorMetadataInput,
): SiteMetadata {
  const usable = configuratorIndexable({
    catalogOk: result.ok,
    machineCount: result.ok ? result.data.machines.length : 0,
    privacyPublished: input.privacyPublished,
    originMismatch: input.originMismatch,
  });
  return buildSiteMetadata({
    title: sitePageTitle(null, CONFIGURATOR_TITLE),
    description: CONFIGURATOR_DESCRIPTION,
    path: CONFIGURATOR_PATH,
    indexable: input.indexable && usable,
    base: input.base,
    siteName: input.siteName,
  });
}

/** Metadaten der 404-Seite (Auftrag §17): eigener Titel, immer noindex/nofollow, kein Canonical. */
export function notFoundMetadata(): SiteMetadata {
  return noindexMetadata(NOT_FOUND_TITLE);
}
