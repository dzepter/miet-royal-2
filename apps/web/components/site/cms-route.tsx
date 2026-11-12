import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { effectiveReviewsMode } from '../../lib/reviews';
import { breadcrumbListJsonLd } from '../../lib/site-jsonld';
import { cmsRouteMetadataFor } from '../../lib/site-meta';
import { breadcrumbItems, publishedPathSet } from '../../lib/site-nav';
import type {
  PublicPage,
  PublicSiteBootstrap,
  PublicSiteSettings,
  SitePageType,
} from '../../lib/site-types';
import { CmsBlocks } from './block-renderer';
import { Breadcrumbs } from './breadcrumbs';
import { JsonLd } from './json-ld';
import { getApiOriginMismatch, getSeoEnv, getSiteBootstrap, getSitePage } from './site-data';
import { SiteFrame } from './site-frame';
import { SiteUnavailable } from './site-status';

/**
 * Phase 16 (WEB, Design §5 „Seiten“): gemeinsamer Ablauf aller CMS-Seiten.
 * SSR über `lib/site-api.ts` (WEB_API_ORIGIN, no-store, Timeout, Promise.all):
 * nicht veröffentlicht ⇒ 404 (`notFound()`), API nicht erreichbar ⇒ freundliche Meldung
 * (noindex), sonst Inhalt im gemeinsamen Renderer. Metadaten aus Meta-Titel/-Beschreibung.
 * Phase 17 (WEB-META, D2/D9–D11): robots/Canonical/OpenGraph/Twitter aus Seite + Website-Kontext
 * (`getSeoEnv`, je Request dedupliziert – keine zusätzlichen API-Aufrufe); Brotkrume auf
 * Regions-/Secondary-Offer-Seiten; `BreadcrumbList` (JSON-LD) nur auf indexierbaren Seiten.
 */

/**
 * Seiteninhalt im Renderer (öffentlich und Vorschau). Der Seitentyp steuert kontextabhängige
 * Blöcke (Kontaktblock auf `secondary_offer` ohne Abholzeile/Konfigurator, Review content_ux-2).
 * Bewertungen fail-closed: weichen Build- und Laufzeit-Origin ab, bleibt die Sektion aus
 * (Review demo_reviews-2 / web_security-1). Die Brotkrume (D11) gehört zum Renderer und ist
 * damit auch in der Vorschau sichtbar; JSON-LD nur mit `jsonLdBase` (indexierbare öffentliche
 * Seite) – die Vorschau lässt es weg.
 */
export function CmsPageView({
  page,
  bootstrap,
  settings,
  jsonLdBase,
}: {
  page: PublicPage;
  bootstrap: PublicSiteBootstrap | null;
  /** Vorschau der Einstellungen: Entwurf statt veröffentlichter Einstellungen. */
  settings?: PublicSiteSettings | null | undefined;
  /** Phase 17 (D10): gültige Basis NUR für indexierbare öffentliche Seiten, sonst weglassen. */
  jsonLdBase?: string | null | undefined;
}) {
  const pages = bootstrap?.pages ?? [];
  const crumbs = breadcrumbItems(page, pages);
  return (
    <>
      {crumbs.length > 0 ? <Breadcrumbs items={crumbs} /> : null}
      {crumbs.length > 0 && typeof jsonLdBase === 'string' ? (
        <JsonLd data={breadcrumbListJsonLd(crumbs, jsonLdBase)} />
      ) : null}
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
    </>
  );
}

/**
 * `generateMetadata` einer CMS-Seite: Seite + Website-Kontext („nicht erreichbar“ immer
 * noindex, s. `cmsRouteMetadataFor`); nicht veröffentlicht/falscher Typ ⇒ 404 (`notFound()`,
 * Metadaten dann aus `app/not-found.tsx`: „Seite nicht gefunden“, noindex).
 */
export async function cmsRouteMetadata(
  path: string,
  expectedTypes?: readonly SitePageType[],
): Promise<Metadata> {
  const [page, seo] = await Promise.all([getSitePage(path), getSeoEnv()]);
  const metadata = cmsRouteMetadataFor(page, expectedTypes, seo);
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
  const [bootstrap, page, seo] = await Promise.all([
    getSiteBootstrap(),
    getSitePage(path),
    getSeoEnv(),
  ]);
  if (!page.ok && page.reason === 'not_found') notFound();
  if (page.ok && expectedTypes !== undefined && !expectedTypes.includes(page.data.pageType)) {
    notFound();
  }
  const boot = bootstrap.ok ? bootstrap.data : null;
  return (
    <SiteFrame bootstrap={boot} currentPath={path}>
      {page.ok ? (
        <CmsPageView
          page={page.data}
          bootstrap={boot}
          jsonLdBase={seo.indexable ? seo.base : null}
        />
      ) : (
        <SiteUnavailable />
      )}
    </SiteFrame>
  );
}
