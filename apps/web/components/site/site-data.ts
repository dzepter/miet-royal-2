import { cache } from 'react';
import { resolveDemoBanner } from '../../lib/environment';
import {
  checkApiOriginMismatch,
  loadCatalog,
  loadSiteBootstrap,
  loadSitePage,
} from '../../lib/site-api';
import { seoEnvFrom } from '../../lib/site-meta';
import type { SeoEnv } from '../../lib/site-seo';

/**
 * Phase 16 (WEB, Design §5): serverseitige Datenquellen der Website, je Request dedupliziert
 * (React `cache`) – `generateMetadata` und die Seite teilen sich denselben API-Aufruf.
 * Nur in Server-Komponenten verwenden (liest WEB_API_ORIGIN, nie im Browser-Bundle).
 */

export const getSiteBootstrap = cache(() => loadSiteBootstrap());

export const getSitePage = cache((path: string) => loadSitePage(path));

export const getCatalog = cache(() => loadCatalog());

/** true ⇒ Build- und Laufzeit-Origin weichen ab ⇒ Absenden/Vorschau fail-closed. */
export const getApiOriginMismatch = cache(() => checkApiOriginMismatch());

/**
 * Phase 14/17: Demo-Entscheidung je Request EINMAL (`WEB_APP_ENV=demo` ⇒ ohne API-Abfrage,
 * sonst zählt zusätzlich `environment: 'demo'` aus GET <WEB_API_ORIGIN>/health, Timeout 1 s,
 * no-store). Root-Layout (Banner), Seiten-Metadaten (Demo ⇒ immer noindex), robots.txt und
 * Sitemap teilen sich dieselbe Abfrage.
 */
export const getDemoMode = cache(() => resolveDemoBanner());

/**
 * Phase 17 (Design D1/D2): SEO-Kontext je Request aus Bootstrap (konfigurierte Basis
 * `publicBaseUrl`, `environment`, Markenname), Demo-Entscheidung und Origin-Vergleich – keine
 * zusätzlichen API-Aufrufe, nie Request-Header.
 */
export const getSeoEnv = cache(async (): Promise<SeoEnv> => {
  const [bootstrap, demo] = await Promise.all([getSiteBootstrap(), getDemoMode()]);
  return seoEnvFrom(bootstrap, demo, getApiOriginMismatch());
});
