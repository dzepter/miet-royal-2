/**
 * Phase 16 (WEB, Design §1.7/§11.2.9): Indexierungs-Entscheidung und Metadaten der Website.
 *
 * Bis zur SEO-Finalisierung (Phase 17) bleibt die Website `noindex`: nur
 * `WEB_INDEXING_ENABLED=true` (exakt) öffnet die Indexierung – und auch dann nur für
 * veröffentlichte öffentliche Seiten. Token-Seiten, `/konto` und `/vorschau` setzen in
 * ihren Layouts immer `noindex` (Segment-Metadata ersetzt `robots` vollständig).
 * Reine Funktionen (node --test).
 */
import { sitePageTitle } from './site-format.ts';

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

/** Robots der Root-Metadata: Default noindex/nofollow, mit Freigabe index/follow. */
export function siteRobots(indexingEnabled: boolean): SiteRobots {
  return indexingEnabled ? { index: true, follow: true } : { ...NOINDEX_ROBOTS };
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
