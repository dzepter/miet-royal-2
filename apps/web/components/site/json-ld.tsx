import { serializeJsonLd, type JsonLdObject } from '../../lib/site-jsonld';

/**
 * Phase 17 (WEB-META, Design D10): `<script type="application/ld+json">` mit strukturierten
 * Daten. EINZIGE erlaubte Stelle für `dangerouslySetInnerHTML` in apps/web: der Inhalt ist
 * ausschließlich `JSON.stringify`-Ausgabe aus eigenen Buildern (lib/site-jsonld.ts), in der
 * `<`, `>` und `&` als Unicode-Escapes kodiert sind – kein CMS-Text kann das Script-Element
 * beenden oder HTML einschleusen. Nur auf indexierbaren Seiten rendern (die Aufrufer prüfen).
 * Test-ID `jsonld-<typ>` (z. B. jsonld-website, jsonld-organization, jsonld-breadcrumblist).
 */
export function JsonLd({ data }: { data: JsonLdObject }) {
  return (
    <script
      type="application/ld+json"
      data-testid={`jsonld-${data['@type'].toLowerCase()}`}
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
