# Redirect-/410-Matrix der Website-Migration (Phase 17)

Stand: 2026-11-12 (Phase 17, Agent WEB-ROUTES – Tabelle; Prosa/Querverweise ergänzt der
DOCS-Agent). Quellen: docs/WEBSITE_MIGRATION_NOTES.md §2a/§2b und die ausschließlich lesende
Verifikation der Alt-Seite `https://miet-royal.de/` vom 12.11.2026 (alle 24 Seiten-URLs der
Alt-Sitemaps sind abgedeckt; die fünf vorher „nicht einzeln geprüften“ BookingPress-Seiten sind
verifiziert: `index, follow`, kein Inhalt ⇒ 410 bestätigt).

## Zweck

Jede bekannte Adresse der bisherigen WordPress-Website erhält auf der neuen Website genau EINE
technische Antwort: permanenter Redirect (`308`) in einem Hop, `410` (Gone) oder bewusst `404`.
Diese Tabelle ist die verbindliche Liste. Der Konsistenztest `apps/web/lib/redirect-matrix.test.ts`
(SEO-R-D1–D5) prüft, dass Tabelle und Code (`apps/web/lib/legacy-routes.ts`: `LEGACY_REDIRECTS`,
`LEGACY_GONE`) deckungsgleich sind und jedes Ziel als Route unter `apps/web/app` existiert.

## Verfahren (projektweit 308 im Proxy)

- Umsetzung: `apps/web/proxy.ts` (Next-16-Proxy, Node-Runtime, Matcher schließt nur `/api/…`,
  `/_next/…`, `favicon.ico`, `robots.txt` und `sitemap.xml` aus) zusammen mit
  `skipTrailingSlashRedirect: true` in `apps/web/next.config.ts`. Nexts eigener
  Trailing-Slash-Redirect liefe VOR dem Proxy und würde `/uber-uns/` → `/uber-uns` → `/ueber-uns`
  zur Redirect-Kette machen; der Proxy entscheidet Legacy-Ziel und Schluss-Slash in EINEM Hop.
- Status projektweit `308` (permanent, HTTP-Methode bleibt erhalten) – auch für den Host-Redirect
  im Reverse-Proxy. Kein 301/302-Mix, keine `redirects()` in `next.config.ts`.
- Matching: Pfad kleingeschrieben, Schluss-Slash entfernt ⇒ `/buchung`, `/buchung/` und
  `/Buchung/` treffen dieselbe Regel. Die Alt-Seite leitete Pfade ohne Slash per 301 auf die
  Slash-Variante; Links existieren daher in beiden Schreibweisen – beide werden geprüft
  (SEO-R-U1/U2, E2E SEO-R1).
- Antwort `308`: Der Client erhält `Location: /ziel` (relativ). Das Ziel stammt ausschließlich aus
  der Entscheidungstabelle (`decideLegacyRoute`, relativer Pfad); Nexts Node-Adapter verlangt intern
  eine absolute URL (relativ ⇒ 500) – der Proxy löst den Pfad deshalb gegen die EIGENE Server-URL
  (`request.nextUrl`: hostname/port des Servers, nicht der Host-/Forwarded-Header) auf, prüft, dass
  der Origin unverändert ist, und Next relativiert die Location wieder. `Cache-Control: public,
  max-age=3600`.
- Antwort `410`: eigenständige kleine HTML-Seite im Website-Look mit der Überschrift
  „Diese Seite gibt es nicht mehr.“, Links „Zur Startseite“ (`/`), „Slushmaschine mieten“
  (`/slushmaschine-mieten`), „Kontakt“ (`/kontakt`) und CTA „Slush konfigurieren“ (`/konfigurator`);
  `<meta name="robots" content="noindex, nofollow">`; Header `X-Robots-Tag: noindex, nofollow`,
  `Cache-Control: public, max-age=3600`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`. Echter Status 410, keine Soft-404, kein Script.
- `410` gilt nur für exakte Pfade. Unterpfade (`/shop/irgendwas`) sind keine bekannten Alt-URLs
  und laufen in die 404-Seite der Website (noindex).
- Nicht vom Proxy behandelt: `/` selbst, `/api/*` (Rewrite zur API), `/_next/*`, `favicon.ico`,
  `robots.txt`, `sitemap.xml` sowie Pfade mit `//`, `\`, `%`, `:`, `?`, `#` im Pfadteil – Next
  normalisiert Mehrfach-Slashes/Backslashes selbst (308 auf den bereinigten Pfad), alles andere
  endet als 404.

## Trailing-Slash-Regel

Kanonisch ist die Form OHNE Schluss-Slash. Jeder sonstige „sichere“ Pfad mit Schluss-Slash
(`/ablauf/`, `/impressum/`, `/datenschutz/`, `/konto/`, `/slushmaschine-mieten/mainz/`) wird mit
einem `308` auf die Form ohne Slash geleitet; die Query bleibt erhalten, die Groß-/Kleinschreibung
bleibt unverändert (Next-Routen sind case-sensitive, `/Ablauf` endet als 404). Damit entsteht für
die gleichen Pfade der Alt-Seite genau ein Redirect und keine Doppelweiterleitung (Auftrag §6).

## Query-Regel

- Legacy-Redirects verwerfen die Query vollständig: `/buchung/?next=https://evil.example/` ⇒
  `Location: /konfigurator` (SEO-R-U7, E2E SEO-R4).
- Die Slash-Normalisierung behält die Query (`/ablauf/?x=1` ⇒ `/ablauf?x=1`), aber nur, wenn sie
  ausschließlich sichtbare ASCII-Zeichen enthält (kein Zeilenumbruch, kein Leerzeichen, kein
  unkodiertes Nicht-ASCII) – sonst entfällt sie (SEO-R-U8). Next serialisiert die Query der
  Location neu und kodiert dabei Sonderzeichen (`/ablauf/?x=//evil` ⇒ `Location: /ablauf?x=%2F%2Fevil`,
  Pfad bleibt `/ablauf`).
- WordPress-Shortlinks `/?p=<id>` und Suchen `/?s=<suche>` werden nicht gemappt: Die Startseite
  antwortet mit 200 und Canonical `/` ohne Query.
- Ein Open Redirect ist ausgeschlossen: Die `Location` beginnt immer mit genau einem `/`;
  `//host/`, `/\host/`, `/%2F%2Fhost/` und `/buchung//` lösen keinen Proxy-Redirect aus.

## Kanonischer Host (www)

Kanonischer Host der neuen Website ist `www.miet-royal.de` (Auftrag §8, docs/ARCHITECTURE.md
„Domains“); die Alt-Seite leitete umgekehrt `www.` → Apex. Der Host-Redirect Apex →
`https://www.miet-royal.de$request_uri` (308) sowie HTTP → HTTPS liegen ausschließlich in der
dokumentierten Reverse-Proxy-Konfiguration (docs/DEPLOYMENT_NOTES.md) – kein Host-Header-Verhalten
im Anwendungscode, keine Hostnamen im Code; `MAIL_PUBLIC_WEB_BASE_URL=https://www.miet-royal.de`.
Go-live-Smoke: docs/PRE_START_CHECKLIST.md (E2E/Smoke SEO-R9). Bis zur DNS-Umschaltung bleibt die
Alt-Seite unverändert online.

## Testnamen

- Unit (`apps/web/lib/legacy-routes.test.ts`, `node --test`): SEO-R-U1 Legacy-Redirects
  (mit/ohne Slash, Schreibweise, Query weg) · SEO-R-U2 410-Pfade · SEO-R-U3 keine Präfixregeln ·
  SEO-R-U4 Slash-Normalisierung · SEO-R-U5 keine Entscheidung (`/`, kanonische Pfade,
  404-belassene Pfade) · SEO-R-U6 Open-Redirect-Pfade · SEO-R-U7 Query erzeugt kein externes
  Ziel · SEO-R-U8 Zeilenumbruch in der Query · SEO-R-U9 Listen konsistent, kein Loop/keine
  Kette · SEO-R-U10 Alt-Sitemaps · SEO-R-U11 410-HTML · SEO-R-U12 410-Header ·
  SEO-R-U13 Proxy-Matcher/-Quelltext. Doku-Konsistenz: `apps/web/lib/redirect-matrix.test.ts`
  (SEO-R-D1–D5). Konfiguration: `apps/web/lib/next-config.test.ts` SEO-W-H6.
- E2E gegen den Production-Build (`tests/e2e/specs/seo-redirects.spec.ts`, Projekt `seo`):
  SEO-R1 Alt-URLs genau EIN permanenter Redirect (308, relative Location, mit und ohne Slash) ·
  SEO-R2 kein Redirect-Loop · SEO-R3 keine Redirect-Kette (Ziel antwortet ohne weiteren 3xx) ·
  SEO-R4 Query kann kein externes Ziel erzeugen · SEO-R5 410-Pfade liefern echten HTTP 410 ·
  SEO-R6 410-Seite noindex (Meta + `X-Robots-Tag`) · SEO-R7 unveröffentlichte CMS-Seite ⇒ 404 ·
  SEO-R8 404-Seite noindex · SEO-R9 www-/kanonische-Host-Regel dokumentiert und per Smoke
  geprüft.

## Matrix der Alt-URLs

Ergebnis: `308` = Legacy-Redirect (Query verworfen), `308 (Slash)` = gleicher Pfad, nur
Slash-Normalisierung (Query bleibt), `410` = Gone, `200` = unverändert erreichbar.

| Altpfad | Ergebnis | Ziel | Begründung | Testname |
| --- | --- | --- | --- | --- |
| `/` | 200 | `/` | Startseite bleibt; Host-/Protokoll-Redirects im Reverse-Proxy. | SEO-R-U5, SEO-R4 |
| `/?p=<id>` | 200 | `/` | WordPress-Shortlinks werden nicht gemappt (Startseite, Canonical `/` ohne Query). | SEO-R-U5, SEO-R4 |
| `/?s=<suche>` | 200 | `/` | WordPress-Suche wird nicht gemappt (Startseite, Canonical `/` ohne Query). | SEO-R-U5, SEO-R4 |
| `/maschinen-zubehoer/` | 308 | `/slushmaschine-mieten` | Alte Produktübersicht „Maschinen & Zubehör“ (indexiert, Produkt-Intention) ⇒ neue Slush-Seite. | SEO-R-U1, SEO-R1, SEO-R2, SEO-R3 |
| `/ablauf/` | 308 (Slash) | `/ablauf` | Gleiche Seite; nur Normalisierung auf die Form ohne Schluss-Slash, Query bleibt. | SEO-R-U4, SEO-R1, SEO-R3, SEO-R4 |
| `/buchung/` | 308 | `/konfigurator` | Alte Anfrage-/Buchungsseite (Ziel des Header-Buttons der Alt-Seite) ⇒ Konfigurator mit unverbindlicher Anfrage; Query (`?next=…`) wird verworfen. | SEO-R-U1, SEO-R1, SEO-R2, SEO-R3, SEO-R4 |
| `/uber-uns/` | 308 | `/ueber-uns` | Gleiche Seite, neue Schreibweise mit „ue“ – in einem Hop (kein Zwischenschritt `/uber-uns`). | SEO-R-U1, SEO-R1, SEO-R2, SEO-R3 |
| `/kontaktformular/` | 308 | `/kontakt` | Alte Kontaktseite mit Formular ⇒ neue Kontaktseite (ohne exakte Abholadresse). | SEO-R-U1, SEO-R1, SEO-R2, SEO-R3 |
| `/metform-form/contact-form/` | 308 | `/kontakt` | Technische Formularvorlage des MetForm-Plugins (kein eigener Inhalt, aber indexiert und in der Alt-Sitemap); gleiche Intention wie Kontakt – 410 wäre gleichwertig, Redirect laut Auftrag §6. | SEO-R-U1, SEO-R1, SEO-R2, SEO-R3 |
| `/book-appointment/` | 308 | `/konfigurator` | BookingPress-Terminseite (nur roher Shortcode); Intention „Termin anfragen“ ⇒ Konfigurator (Auftrag §6). | SEO-R-U1, SEO-R1, SEO-R2, SEO-R3 |
| `/mein-konto/` | 308 | `/konto` | WooCommerce-Login (ungenutzt, noindex); Intention „Konto“ ⇒ Kundenbereich (Auftrag §6). | SEO-R-U1, SEO-R1, SEO-R2, SEO-R3 |
| `/my-bookings/` | 308 | `/konto` | BookingPress „Meine Buchungen“ (roher Shortcode); Auftrag §7 nimmt den Pfad bewusst aus 410 heraus ⇒ Kundenbereich. | SEO-R-U1, SEO-R1, SEO-R2, SEO-R3 |
| `/impressum/` | 308 (Slash) | `/impressum` | Gleiche Seite; nur Slash-Normalisierung. | SEO-R-U4, SEO-R1, SEO-R3 |
| `/datenschutz/` | 308 (Slash) | `/datenschutz` | Gleiche Seite; nur Slash-Normalisierung. | SEO-R-U4, SEO-R1, SEO-R3 |
| `/sitemap_index.xml` | 308 | `/sitemap.xml` | Rank-Math-Sitemap-Index der Alt-Seite (in deren robots.txt referenziert) ⇒ neue Sitemap (Metadata-Route `apps/web/app/sitemap.ts`), damit Suchmaschinen sie finden. | SEO-R-U10, SEO-R1, SEO-R3 |
| `/shop/` | 410 | – | WooCommerce-Shoparchiv ohne Produkte („Es wurden keine Produkte gefunden“); kein Ranking-/Backlink-Nachweis für einen Redirect. | SEO-R-U2, SEO-R5, SEO-R6 |
| `/warenkorb/` | 410 | – | Leerer WooCommerce-Warenkorb (noindex). | SEO-R-U2, SEO-R5, SEO-R6 |
| `/kasse/` | 410 | – | WooCommerce-Kasse (leitete per 302 auf den leeren Warenkorb). | SEO-R-U2, SEO-R5, SEO-R6 |
| `/hello-world/` | 410 | – | WordPress-Standardbeitrag inkl. Standardkommentar. | SEO-R-U2, SEO-R5, SEO-R6 |
| `/category/uncategorized/` | 410 | – | Kategorie-Archiv des WordPress-Standardbeitrags. | SEO-R-U2, SEO-R5, SEO-R6 |
| `/sample-page/` | 410 | – | WordPress-Beispielseite (englischer Platzhaltertext). | SEO-R-U2, SEO-R5, SEO-R6 |
| `/thank-you/` | 410 | – | BookingPress-Dankeseite mit rohen Shortcodes. | SEO-R-U2, SEO-R5, SEO-R6 |
| `/cancel-appointment/` | 410 | – | BookingPress-Stornoseite (englischer Plugin-Standardtext); verifiziert 12.11.2026: index/follow, kein Inhalt. | SEO-R-U2, SEO-R5, SEO-R6 |
| `/cancel-payment/` | 410 | – | BookingPress „Zahlung fehlgeschlagen“ (englischer Plugin-Standardtext); verifiziert 12.11.2026. | SEO-R-U2, SEO-R5, SEO-R6 |
| `/appointment-cancellation-confirmation/` | 410 | – | BookingPress-Stornobestätigung (nur roher Shortcode); verifiziert 12.11.2026. | SEO-R-U2, SEO-R5, SEO-R6 |
| `/appointment-reschedule/` | 410 | – | BookingPress-Terminverschiebung (nur roher Shortcode); verifiziert 12.11.2026. | SEO-R-U2, SEO-R5, SEO-R6 |
| `/bookingpress-complete-payment/` | 410 | – | BookingPress-Zahlungsabschluss (nur roher Shortcode); verifiziert 12.11.2026. | SEO-R-U2, SEO-R5, SEO-R6 |
| `/feed/` | 410 | – | RSS-Feed der Alt-Seite (es gab keinen Blog). | SEO-R-U10, SEO-R5, SEO-R6 |
| `/comments/feed/` | 410 | – | Kommentar-Feed der Alt-Seite. | SEO-R-U10, SEO-R5, SEO-R6 |
| `/author/techremedys/` | 410 | – | Autorenarchiv der Agentur-/Autorenkennung (nicht in der Alt-Sitemap). | SEO-R-U10, SEO-R5, SEO-R6 |
| `/page/2/` | 410 | – | Paginierungsrest der statischen Startseite der Alt-Seite. | SEO-R-U10, SEO-R5, SEO-R6 |
| `/post-sitemap.xml` | 410 | – | Rank-Math-Unter-Sitemap der Alt-Seite; nicht umleiten – die neue Sitemap gibt es nur unter `/sitemap.xml`. | SEO-R-U10, SEO-R5, SEO-R6 |
| `/page-sitemap.xml` | 410 | – | Rank-Math-Unter-Sitemap der Alt-Seite; nicht umleiten. | SEO-R-U10, SEO-R5, SEO-R6 |
| `/metform-form-sitemap.xml` | 410 | – | Rank-Math-Unter-Sitemap der Alt-Seite; nicht umleiten. | SEO-R-U10, SEO-R5, SEO-R6 |
| `/category-sitemap.xml` | 410 | – | Rank-Math-Unter-Sitemap der Alt-Seite; nicht umleiten. | SEO-R-U10, SEO-R5, SEO-R6 |

## Weitere Regeln (keine Inhalts-URLs der Alt-Seite)

`404` = bewusst nicht behandelt; die 404-Seite der Website antwortet mit echtem Status 404 und
noindex. Ein Schluss-Slash wird auch hier zuerst normalisiert (`/wp-json/` ⇒ 308 `/wp-json` ⇒ 404).

| Altpfad | Ergebnis | Ziel | Begründung | Testname |
| --- | --- | --- | --- | --- |
| `/konto/` | 308 (Slash) | `/konto` | App-Pfad des Kundenbereichs; Slash-Normalisierung wie bei allen Pfaden (Portal-Header bleiben auf dem Ziel). | SEO-R-U4, SEO-R1 |
| `/wp-login.php` | 404 | – | WordPress-Login; typisches Bot-Ziel, kein Redirect. | SEO-R-U5, SEO-R8 |
| `/xmlrpc.php` | 404 | – | WordPress-XML-RPC (nur POST); kein Redirect. | SEO-R-U5, SEO-R8 |
| `/wp-json/` | 404 | – | WordPress-REST-Wurzel (war bereits `X-Robots-Tag: noindex`); kein Redirect. | SEO-R-U5, SEO-R8 |
| `/tag/` | 404 | – | Schlagwort-Archiv (auf der Alt-Seite schon 404). | SEO-R-U5, SEO-R8 |
| `/wp-content/uploads/*` | 404 | – | Bilder/Uploads der Alt-Seite (Logo, Fotos, Stock-/KI-Bilder); nichts wird übernommen, kein Redirect. | SEO-R-U5, SEO-R8 |
