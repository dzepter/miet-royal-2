import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { CmsPageView } from '../components/site/cms-route';
import { getSiteBootstrap, getSitePage } from '../components/site/site-data';
import { SiteFrame } from '../components/site/site-frame';
import { FallbackHome, SiteUnavailable } from '../components/site/site-status';
import { homeMetadata } from '../lib/site-meta';

/**
 * Phase 16 (WEB, Order §3, Design §5): Startseite – ersetzt die technische Phase-0-Seite.
 * Veröffentlichte Startseite aus dem CMS; ohne veröffentlichten Inhalt (frische Umgebung,
 * Demo nach Reset) ein schlichter Fallback (Marke, „Unsere neue Website wird gerade
 * vorbereitet.“, CTA „Slush konfigurieren“) – nie ein Fehler. API nicht erreichbar ⇒
 * freundliche Meldung (noindex).
 */
const PATH = '/';

/** Fallback-Startseite und „nicht erreichbar“ sind immer noindex (Review web_security-2). */
export async function generateMetadata(): Promise<Metadata> {
  return homeMetadata(await getSitePage(PATH));
}

export default async function HomePage() {
  const [bootstrap, page] = await Promise.all([getSiteBootstrap(), getSitePage(PATH)]);
  const boot = bootstrap.ok ? bootstrap.data : null;
  const businessName = boot?.settings?.businessName ?? 'Miet-Royal';
  let content: ReactNode;
  if (page.ok && page.data.pageType === 'home') {
    content = <CmsPageView page={page.data} bootstrap={boot} />;
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
