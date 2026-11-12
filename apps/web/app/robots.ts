import type { MetadataRoute } from 'next';
import { getSeoEnv } from '../components/site/site-data';
import { readIndexingEnabled } from '../lib/site-meta';
import { robotsRules } from '../lib/site-seo';

/**
 * Phase 17 (WEB-META, Design D7, Auftrag §9): robots.txt zur Laufzeit aus dem Website-Kontext
 * (WEB_INDEXING_ENABLED, Demo, konfigurierte Basis aus dem Bootstrap, Origin-Vergleich – nie
 * Request-Header).
 *
 * - Nicht indexierbar (Schalter aus, Demo, keine gültige Basis, Origin-Sperre):
 *   `Allow: /`, `Disallow: /api/`, KEINE Sitemap-Zeile. Bewusst kein `Disallow: /` (Review RA-3,
 *   Google „Block Search indexing with noindex“ / „Introduction to robots.txt“): robots.txt hält
 *   keine Seite aus dem Index – eine gesperrte URL kann ohne Inhalt indexiert werden, und das
 *   noindex, das jede Antwort dieser Instanz trägt, würde nie gelesen. Crawlbar + noindex ist das
 *   dokumentierte Mittel gegen Indexierung von Staging/Demo. Ohne Schalter wird der Bootstrap
 *   gar nicht erst geladen (Review RD-3).
 * - Indexierbar: `Allow: /` und `Allow: /api/public/cms/media/` (veröffentlichte Bilder müssen
 *   crawlbar sein – og:image, Organization.logo; Review RA-1), `Disallow: /api/` und
 *   `Sitemap: <Basis>/sitemap.xml`.
 *   Portal (`/konto`), Vorschau (`/vorschau`), Angebots-/Dokument-Links und `/kontakt/<token>`
 *   werden bewusst NICHT per Disallow gesperrt (Leitungsentscheidung D7): laut Google Search
 *   Central „Block Search indexing with noindex“ ist `noindex` nur wirksam, wenn die Seite nicht
 *   per robots.txt blockiert ist – eine blockierte URL kann ohne Inhalt indexiert werden und ihr
 *   noindex wird nie gesehen; bei Token-URLs wäre genau die URL das Geheimnis. Diese Seiten
 *   bleiben ausschließlich über noindex (Meta + X-Robots-Tag, bereits vorhanden) aus dem Index
 *   und stehen nie in der Sitemap. Keine Tokens in robots.txt; robots ist keine Sicherheitsgrenze.
 */
export const dynamic = 'force-dynamic';

export default async function robots(): Promise<MetadataRoute.Robots> {
  if (!readIndexingEnabled()) return robotsRules({ indexable: false, base: null });
  return robotsRules(await getSeoEnv());
}
