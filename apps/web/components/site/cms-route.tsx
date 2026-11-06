import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { effectiveReviewsMode } from '../../lib/reviews';
import { cmsRouteMetadataFor } from '../../lib/site-meta';
import { publishedPathSet } from '../../lib/site-nav';
import type {
  PublicPage,
  PublicSiteBootstrap,
  PublicSiteSettings,
  SitePageType,
} from '../../lib/site-types';
import { CmsBlocks } from './block-renderer';
import { getApiOriginMismatch, getSiteBootstrap, getSitePage } from './site-data';
import { SiteFrame } from './site-frame';
import { SiteUnavailable } from './site-status';

/**
 * Phase 16 (WEB, Design §5 „Seiten“): gemeinsamer Ablauf aller CMS-Seiten.
 * SSR über `lib/site-api.ts` (WEB_API_ORIGIN, no-store, Timeout, Promise.all):
 * nicht veröffentlicht ⇒ 404 (`notFound()`), API nicht erreichbar ⇒ freundliche Meldung
 * (noindex), sonst Inhalt im gemeinsamen Renderer. Metadaten aus Meta-Titel/-Beschreibung.
 */

/**
 * Seiteninhalt im Renderer (öffentlich und Vorschau). Der Seitentyp steuert kontextabhängige
 * Blöcke (Kontaktblock auf `secondary_offer` ohne Abholzeile/Konfigurator, Review content_ux-2).
 * Bewertungen fail-closed: weichen Build- und Laufzeit-Origin ab, bleibt die Sektion aus
 * (Review demo_reviews-2 / web_security-1).
 */
export function CmsPageView({
  page,
  bootstrap,
  settings,
}: {
  page: PublicPage;
  bootstrap: PublicSiteBootstrap | null;
  /** Vorschau der Einstellungen: Entwurf statt veröffentlichter Einstellungen. */
  settings?: PublicSiteSettings | null | undefined;
}) {
  const pages = bootstrap?.pages ?? [];
  return (
    <CmsBlocks
      blocks={page.blocks}
      ctx={{
        pages,
        published: publishedPathSet(pages),
        settings: settings !== undefined ? settings : (bootstrap?.settings ?? null),
        reviewsMode: effectiveReviewsMode(bootstrap?.reviews.mode, getApiOriginMismatch()),
        pickupArea: bootstrap?.pickupArea ?? 'Mainz-Hechtsheim',
        title: page.title,
        pageType: page.pageType,
      }}
    />
  );
}

/** `generateMetadata` einer CMS-Seite („nicht erreichbar“ immer noindex, s. `cmsRouteMetadataFor`). */
export async function cmsRouteMetadata(
  path: string,
  expectedTypes?: readonly SitePageType[],
): Promise<Metadata> {
  const metadata = cmsRouteMetadataFor(await getSitePage(path), expectedTypes);
  if (metadata === null) notFound();
  return metadata;
}

/** Seite einer CMS-Route (Server-Komponente). */
export async function CmsRoute({
  path,
  expectedTypes,
}: {
  path: string;
  expectedTypes?: readonly SitePageType[] | undefined;
}) {
  const [bootstrap, page] = await Promise.all([getSiteBootstrap(), getSitePage(path)]);
  if (!page.ok && page.reason === 'not_found') notFound();
  if (page.ok && expectedTypes !== undefined && !expectedTypes.includes(page.data.pageType)) {
    notFound();
  }
  const boot = bootstrap.ok ? bootstrap.data : null;
  return (
    <SiteFrame bootstrap={boot} currentPath={path}>
      {page.ok ? <CmsPageView page={page.data} bootstrap={boot} /> : <SiteUnavailable />}
    </SiteFrame>
  );
}
