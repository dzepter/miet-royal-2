import { getSiteBootstrap } from '../components/site/site-data';
import { SiteFrame } from '../components/site/site-frame';
import { SiteNotFound } from '../components/site/site-status';

/**
 * Phase 16 (WEB, Design §5): 404 der Website (unbekannte Adressen und nicht veröffentlichte
 * CMS-Seiten). Next setzt für Nicht-gefunden-Seiten selbst `noindex`. Ohne erreichbare API
 * bleibt der Rahmen mit Start, Konfigurator und Kundenbereich bedienbar.
 */
export default async function NotFound() {
  const bootstrap = await getSiteBootstrap();
  return (
    <SiteFrame bootstrap={bootstrap.ok ? bootstrap.data : null} currentPath="">
      <SiteNotFound />
    </SiteFrame>
  );
}
