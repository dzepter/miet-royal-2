import type { MetadataRoute } from 'next';
import {
  getApiOriginMismatch,
  getCatalog,
  getDemoMode,
  getSiteBootstrap,
} from '../components/site/site-data';
import { seoEnvFrom } from '../lib/site-meta';
import { isPrivacyPublished } from '../lib/site-nav';
import { configuratorIndexable, sitemapEntries } from '../lib/site-seo';

/**
 * Phase 17 (WEB-META, Design D8, Auftrag §10): dynamische Sitemap ausschließlich aus tatsächlich
 * veröffentlichten Seiten des Bootstraps (`pages` – Startseite, feste Seiten, Regionen,
 * Secondary Offers) mit `lastModified` nur aus dem echten Veröffentlichungszeitpunkt
 * (`publishedAt`), plus `/konfigurator` ohne Datum, wenn er technisch nutzbar ist (Katalog
 * erreichbar, ≥ 1 Maschine, Datenschutz veröffentlicht, keine Origin-Sperre).
 * Nicht indexierbar (Schalter aus, Demo, keine gültige Basis, Origin-Sperre, Bootstrap nicht
 * erreichbar) ⇒ leere Sitemap; robots.txt nennt sie dann nicht. Nie Entwürfe, Vorschau, Portal,
 * Token-Seiten, 404/410 oder API. URLs = Canonicals (`<Basis><Pfad>`, nie Request-Header).
 */
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [bootstrap, demo] = await Promise.all([getSiteBootstrap(), getDemoMode()]);
  const originMismatch = getApiOriginMismatch();
  const seo = seoEnvFrom(bootstrap, demo, originMismatch);
  if (!seo.indexable || seo.base === null || !bootstrap.ok) return [];
  const catalog = await getCatalog();
  return sitemapEntries({
    base: seo.base,
    pages: bootstrap.data.pages,
    configurator: configuratorIndexable({
      catalogOk: catalog.ok,
      machineCount: catalog.ok ? catalog.data.machines.length : 0,
      privacyPublished: isPrivacyPublished(bootstrap.data.pages),
      originMismatch,
    }),
  });
}
