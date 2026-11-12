import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { CmsPageView } from '../components/site/cms-route';
import { JsonLd } from '../components/site/json-ld';
import { getSeoEnv, getSiteBootstrap, getSitePage } from '../components/site/site-data';
import { SiteFrame } from '../components/site/site-frame';
import { FallbackHome, SiteUnavailable } from '../components/site/site-status';
import { organizationJsonLd, websiteJsonLd } from '../lib/site-jsonld';
import { homeMetadata } from '../lib/site-meta';

/**
 * Phase 16 (WEB, Order §3, Design §5): Startseite – ersetzt die technische Phase-0-Seite.
 * Veröffentlichte Startseite aus dem CMS; ohne veröffentlichten Inhalt (frische Umgebung,
 * Demo nach Reset) ein schlichter Fallback (Marke, „Unsere neue Website wird gerade
 * vorbereitet.“, CTA „Slush konfigurieren“) – nie ein Fehler. API nicht erreichbar ⇒
 * freundliche Meldung (noindex).
 * Phase 17 (WEB-META, D9/D10): Metadaten mit Canonical/OpenGraph/Twitter nur für die
 * veröffentlichte Startseite im indexierbaren Kontext; JSON-LD `WebSite` + `Organization`
 * (nur veröffentlichte Einstellungen) ausschließlich dann.
 */
const PATH = '/';

/** Fallback-Startseite und „nicht erreichbar“ sind immer noindex (Review web_security-2). */
export async function generateMetadata(): Promise<Metadata> {
  const [page, seo] = await Promise.all([getSitePage(PATH), getSeoEnv()]);
  return homeMetadata(page, seo);
}

export default async function HomePage() {
  const [bootstrap, page, seo] = await Promise.all([
    getSiteBootstrap(),
    getSitePage(PATH),
    getSeoEnv(),
  ]);
  const boot = bootstrap.ok ? bootstrap.data : null;
  const settings = boot?.settings ?? null;
  const businessName = settings?.businessName ?? 'Miet-Royal';
  const jsonLdBase = seo.indexable ? seo.base : null;
  let content: ReactNode;
  if (page.ok && page.data.pageType === 'home') {
    content = (
      <>
        {jsonLdBase !== null && settings !== null ? (
          <>
            <JsonLd data={websiteJsonLd({ base: jsonLdBase, name: settings.businessName })} />
            <JsonLd data={organizationJsonLd({ base: jsonLdBase, settings })} />
          </>
        ) : null}
        <CmsPageView page={page.data} bootstrap={boot} />
      </>
    );
  } else if (!page.ok && page.reason === 'unavailable') {
    content = <SiteUnavailable />;
  } else {
    content = <FallbackHome businessName={businessName} />;
  }
  return (
    <SiteFrame bootstrap={boot} currentPath={PATH}>
      {content}
    </SiteFrame>
  );
}
