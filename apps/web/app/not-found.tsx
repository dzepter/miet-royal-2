import type { Metadata } from 'next';
import { getSiteBootstrap } from '../components/site/site-data';
import { SiteFrame } from '../components/site/site-frame';
import { SiteNotFound } from '../components/site/site-status';
import { notFoundMetadata } from '../lib/site-meta';

/**
 * Phase 16 (WEB, Design §5): 404 der Website (unbekannte Adressen und nicht veröffentlichte
 * CMS-Seiten). Ohne erreichbare API bleibt der Rahmen mit Start, Konfigurator und Kundenbereich
 * bedienbar. Phase 17 (Auftrag §17): eigener Titel „Seite nicht gefunden – Miet-Royal“ und
 * ausdrücklich noindex/nofollow (zusätzlich zu Nexts eigenem noindex für 404), kein Canonical.
 */
export const metadata: Metadata = notFoundMetadata();

export default async function NotFound() {
  const bootstrap = await getSiteBootstrap();
  return (
    <SiteFrame bootstrap={bootstrap.ok ? bootstrap.data : null} currentPath="">
      <SiteNotFound />
    </SiteFrame>
  );
}
