import type { MetadataRoute } from 'next';
import { getSeoEnv } from '../components/site/site-data';
import { robotsRules } from '../lib/site-seo';

/**
 * Phase 17 (WEB-META, Design D7, Auftrag §9): robots.txt zur Laufzeit aus dem Website-Kontext
 * (WEB_INDEXING_ENABLED, Demo, konfigurierte Basis aus dem Bootstrap, Origin-Vergleich – nie
 * Request-Header).
 *
 * - Nicht indexierbar (Schalter aus, Demo, keine gültige Basis, Origin-Sperre):
 *   `User-agent: *` / `Disallow: /`, keine Sitemap-Zeile – Deployment-/Staging-Instanzen sollen
 *   nicht gecrawlt werden; alle Seiten sind zusätzlich noindex.
 * - Indexierbar: `Allow: /`, `Disallow: /api/` (NUR `/api/`) und `Sitemap: <Basis>/sitemap.xml`.
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
  return robotsRules(await getSeoEnv());
}
