import { cache } from 'react';
import {
  checkApiOriginMismatch,
  loadCatalog,
  loadSiteBootstrap,
  loadSitePage,
} from '../../lib/site-api';

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
