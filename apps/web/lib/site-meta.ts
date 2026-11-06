/**
 * Phase 16 (WEB, Design §1.7/§11.2.9): Indexierungs-Entscheidung und Metadaten der Website.
 *
 * Bis zur SEO-Finalisierung (Phase 17) bleibt die Website `noindex`: nur
 * `WEB_INDEXING_ENABLED=true` (exakt) öffnet die Indexierung – und auch dann nur für
 * veröffentlichte öffentliche Seiten. Token-Seiten, `/konto` und `/vorschau` setzen in
 * ihren Layouts immer `noindex` (Segment-Metadata ersetzt `robots` vollständig).
 * Reine Funktionen (node --test).
 */
import type { SiteFetchResult } from './site-api.ts';
import { sitePageTitle } from './site-format.ts';
import type { PublicCatalog, PublicPage, SitePageType } from './site-types.ts';

export interface SiteRobots {
  index: boolean;
  follow: boolean;
  nocache?: boolean;
}

/** Nie indexieren (Token-/Vorschau-/Fehler-/Nicht-gefunden-Darstellungen). */
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
 * Robots der Root-Metadata: Default noindex/nofollow, mit Freigabe index/follow – die
 * Demo-Instanz ist IMMER noindex, auch mit gesetztem Flag (Review demo_reviews-5: kopierte
 * Live-Env darf die Demo-Kopie nicht indexierbar machen).
 */
export function siteRobots(input: IndexingDecisionInput): SiteRobots {
  return input.indexingEnabled && !input.demo
    ? { index: true, follow: true }
    : { ...NOINDEX_ROBOTS };
}

export interface CmsMetadataInput {
  title: string;
  metaTitle: string | null;
  metaDescription: string | null;
}

export interface SiteMetadata {
  title: string;
  description?: string;
  robots?: SiteRobots;
}

/** Metadaten einer CMS-Seite (Meta-Titel/-Beschreibung aus dem CMS, Fallback Seitentitel). */
export function cmsPageMetadata(page: CmsMetadataInput): SiteMetadata {
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

/**
 * Metadaten der Startseite (Review web_security-2, Design §1.7 „nur veröffentlichte öffentliche
 * Seiten indexierbar“): nur eine veröffentlichte Startseite (pageType `home`) erbt die
 * Indexierungsfreigabe des Root-Layouts. Fallback-Startseite (nichts veröffentlicht, falscher
 * Typ, 401) und „nicht erreichbar“ sind IMMER noindex.
 */
export function homeMetadata(result: SiteFetchResult<PublicPage>): SiteMetadata {
  if (result.ok && result.data.pageType === 'home') return cmsPageMetadata(result.data);
  if (!result.ok && result.reason === 'unavailable') return noindexMetadata(UNAVAILABLE_TITLE);
  return noindexMetadata(FALLBACK_HOME_TITLE);
}

/**
 * Metadaten einer CMS-Route: `null` ⇒ 404 (nicht veröffentlicht / falscher Seitentyp),
 * „nicht erreichbar“ ⇒ IMMER noindex, sonst Meta-Titel/-Beschreibung aus dem CMS.
 */
export function cmsRouteMetadataFor(
  result: SiteFetchResult<PublicPage>,
  expectedTypes?: readonly SitePageType[],
): SiteMetadata | null {
  if (result.ok) {
    if (expectedTypes !== undefined && !expectedTypes.includes(result.data.pageType)) return null;
    return cmsPageMetadata(result.data);
  }
  if (result.reason === 'not_found') return null;
  return noindexMetadata(UNAVAILABLE_TITLE);
}

export const CONFIGURATOR_TITLE = 'Slush konfigurieren';
export const CONFIGURATOR_DESCRIPTION =
  'Stell dir in wenigen Schritten deine Slushmaschine mit Sirup und Zubehör zusammen und fordere ein unverbindliches Angebot an.';

/**
 * Metadaten des Konfigurators: Katalog nicht erreichbar oder keine wählbare Maschine (nur ein
 * Hinweis auf der Seite) ⇒ noindex; sonst Titel + Beschreibung (Root-Robots gelten).
 */
export function configuratorMetadata(result: SiteFetchResult<PublicCatalog>): SiteMetadata {
  if (!result.ok || result.data.machines.length === 0) return noindexMetadata(CONFIGURATOR_TITLE);
  return {
    title: sitePageTitle(null, CONFIGURATOR_TITLE),
    description: CONFIGURATOR_DESCRIPTION,
  };
}
