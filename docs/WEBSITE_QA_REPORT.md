# WEBSITE_QA_REPORT — Technische QA der Website (Phase 17)

Stand: 2026-11-12 (Phase 17, Auftrag §18–§21, §25, §26, §30). Dieser Bericht fasst die
technische Qualitätssicherung der neuen Website vor dem Go-live zusammen: Lighthouse,
Accessibility, Responsive, interne Links, Regionsseiten, Google-Reviews-Compliance,
Legal-/Privacy-QA (nur technisch) und Performance-Maßnahmen. Grundlagen:
[SEO_TECHNICAL.md](SEO_TECHNICAL.md), [REDIRECT_MATRIX.md](REDIRECT_MATRIX.md),
[SEO_STRUCTURED_DATA_NOTES.md](SEO_STRUCTURED_DATA_NOTES.md),
[GOOGLE_REVIEWS_API_NOTES.md](GOOGLE_REVIEWS_API_NOTES.md), [TEST_PLAN.md](TEST_PLAN.md)
„SEO, Redirects, technische QA (Phase 17)“.

E2E-Ergebnisse stammen aus den dokumentierten Läufen des Playwright-Projekts `seo` vom
12.11.2026 (Lauf 2: 50 Tests in vier Dateien bestanden; Zusatzlauf 5 der A11y-Spec mit
Messwert-Ausgaben: 11/11; Lauf 1 scheiterte an zwei Testfehlern der Spec selbst – `CSS.escape`
in Node, unverankerter `testMatch` –, nicht am Produkt). Der Gate-Lauf (Auftrag §33) wiederholt
die Prüfung; abweichende Ergebnisse sind hier nachzutragen.
Keine Messung lief gegen die bisherige Live-Website; kein echter Google-Aufruf.

## 1 Lighthouse

**Methode:** Lighthouse 12.8.2 (`npx lighthouse`, kein Repo-Dependency) gegen den
Production-Build der Website (`next build && next start`) mit Indexierung AN
(`WEB_INDEXING_ENABLED=true`, Basis-URL = eigener Origin des Teststacks), frische
Test-Datenbank mit Website-Seed `main` (alle 14 Standardseiten veröffentlicht, Datenschutz
veröffentlicht, Katalog mit Maschinen), Chromium 141 headless, 4 vCPU. Mobile =
Lighthouse-Standard (Moto-G-Power-Emulation, Slow-4G-Simulation), Desktop = `--preset=desktop`.
Die Indexing-Testkonfiguration ist nötig, weil `noindex` den Audit `is-crawlable` und damit die
SEO-Kategorie fast vollständig entwertet (Auftrag §19). Kein Pixeltest, keine Live-Domain.
Protokolle und JSON-Reports liegen beim Phase-17-Gate (Scratch `p17/lh/out*`), nicht im Repo.

Zielwerte (QA-Leitlinie, Auftrag §19): Performance ≥ 90, Accessibility ≥ 95, Best Practices
≥ 95, SEO ≥ 95 – ohne Tests durch Verstecken zu bestehen.

### Messung 1 (vor den Fixes)

| Seite | Formfaktor | Perf | A11y | BP | SEO | LCP | CLS | TBT | TTFB | Hinweise |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/` | Mobile | 99 | 100 | 96 | 100 | 2,08 s | 0,000 | 0,06 s | 0,16 s | `errors-in-console` (Favicon 404), `label-content-name-mismatch` (Marken-Link), bf-cache, render-blocking CSS, unused/legacy JS |
| `/konfigurator` | Mobile | 100 | 100 | 96 | 100 | 1,59 s | 0,000 | 0,06 s | 0,05 s | wie oben |
| `/kontakt` | Mobile | 100 | 100 | 96 | 100 | 1,51 s | 0,000 | 0,05 s | 0,04 s | wie oben |
| `/konto/anmelden` | Mobile | 100 | 100 | 96 | 54 | 1,51 s | 0,000 | 0,06 s | 0,01 s | SEO 54 GEWOLLT: `is-crawlable` (Portal immer `noindex`), `meta-description` (Portal ohne Description, ohne Belang bei noindex); Favicon 404 |
| `/slushmaschine-mieten` | Mobile | 100 | 100 | 96 | 100 | 1,51 s | 0,000 | 0,05 s | 0,03 s | wie `/` |
| `/slushmaschine-mieten/mainz` | Mobile | 100 | 100 | 96 | 100 | 1,68 s | 0,000 | 0,05 s | 0,09 s | wie `/` |
| `/` | Desktop | 100 | 100 | 96 | 100 | 0,49 s | 0,000 | 0,00 s | 0,05 s | Favicon 404, Marken-Link |
| `/konfigurator` | Desktop | 100 | 100 | 96 | 100 | 0,47 s | 0,000 | 0,00 s | 0,03 s | wie oben |
| `/slushmaschine-mieten` | Desktop | 100 | 100 | 96 | 100 | 0,48 s | 0,000 | 0,00 s | 0,03 s | wie oben |

Weitere Werte der Messung 1 (Mobile): FCP 0,66–0,78 s, Speed Index 0,66–0,78 s; Desktop FCP
0,21–0,22 s. LCP-Element der Startseite (Mobile) ist der Hero-Lead-Absatz (Text), 2,08 s
simuliert bei einer Grenze von 2,5 s; der Seed enthält kein Hero-Bild (siehe „Nicht geprüft“).
CLS auf allen Seiten 0,000; TTFB 0,01–0,16 s.

Befunde der Messung 1 und Einordnung:

- `errors-in-console` (Best Practices 96 auf allen Seiten): einzige Ursache war
  `GET /favicon.ico` ⇒ 404 (kein Favicon im Web-Projekt). **Behoben** – siehe Abschnitt 8.
- `label-content-name-mismatch` (Accessibility-Audit ohne Score-Wirkung, WCAG 2.5.3 „Label in
  Name“): Der Marken-Link im Kopf trug ein `aria-label` „Miet-Royal – Startseite“, das den
  sichtbaren Slogan nicht enthielt. **Behoben** – siehe Abschnitt 8.
- `bf-cache` („Not actionable“): Next liefert dynamische Seiten mit `cache-control: no-store`
  (Standard für dynamisches SSR). Bewusst keine Cache-Änderung in Phase 17 (Auftrag §18: keine
  pauschale neue Cache-Architektur).
- `render-blocking-resources` (eine CSS-Datei, 5,8 KB, geschätzt 30–70 ms),
  `unused-javascript` (Next-Runtime-Chunks, ≈ 50 KiB), `legacy-javascript` (Next-Polyfills,
  ≈ 13 KiB): Hinweise ohne Score-Wirkung (Performance 99–100) – keine Maßnahme.
- `/konto/anmelden` SEO 54 ist gewollt: Das Portal ist nie indexierbar; der Lighthouse-SEO-Score
  ist für Portal-, Token-, 404- und 410-Seiten kein Ziel.

### Nachmessungen (gleicher Stack, Web neu gebaut)

Messung 2 (nach dem Favicon-Fix `app/icon.svg` + `app/favicon.ico`): `/` Mobile 99 / 100 /
**100** / 100 (LCP 2,07 s, CLS 0,000); `/konfigurator` Mobile 99 / 100 / 100 / 100 (LCP 1,60 s).
`errors-in-console` behoben; `label-content-name-mismatch` noch offen (ein erster Versuch mit
zusammengesetztem `aria-label` reichte axe nicht).

Messung 3 (nach dem Marken-Link-Fix: kein `aria-label`, sobald der Link sichtbaren Text oder
ein Logo mit Alt-Text hat):

| Seite | Formfaktor | Perf | A11y | BP | SEO | LCP | CLS | TBT | FCP | Verbleibende Hinweise |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/` | Mobile | 100 | 100 | 100 | 100 | 1,52 s | 0,000 | 0,05 s | 0,77 s | render-blocking CSS (5,8 KB), unused/legacy JS (Next-Runtime/Polyfills), bf-cache |
| `/slushmaschine-mieten/mainz` | Mobile | 99 | 100 | 100 | 100 | 2,07 s | 0,000 | 0,05 s | 0,76 s | dito |

**Ergebnis:** Alle Accessibility-Audits bestanden. Die Zielwerte §19 sind auf allen gemessenen
öffentlichen Seiten erfüllt (Perf 99–100, A11y 100, BP 100, SEO 100); `/konto/anmelden` SEO 54
ist gewollt (`noindex`). Labor-Messungen sind keine Felddaten (Core Web Vitals im Feld erst
nach dem Go-live, [SEO_STRUCTURED_DATA_NOTES.md](SEO_STRUCTURED_DATA_NOTES.md) „CWV“).

## 2 Accessibility (Auftrag §20, adversarial)

Manuelle Kernprüfungen und Playwright-Prüfungen gegen den Production-Build (E2E-Spec
`tests/e2e/specs/seo-a11y.spec.ts`, Projekt `seo`, Testnamen SEO-A1–A12); der automatisierte
Scan (`@axe-core/playwright` 4.14.0, Impact `serious`/`critical` = 0) ergänzt sie, ersetzt sie
aber nicht. Lighthouse (Abschnitt 1): alle Accessibility-Audits bestanden (Score 100 auf allen
gemessenen Seiten, nach dem Marken-Link-Fix auch ohne den score-neutralen Hinweis
`label-content-name-mismatch`).

| Prüfpunkt | Ort / Umsetzung | Ergebnis |
| --- | --- | --- |
| Tastatur komplett (Navigation, CTA, Formulare, Links) | Website-Seiten, Konfigurator | siehe E2E seo-a11y (SEO-A*) |
| Skip-Link „Zum Inhalt springen“ → `main#inhalt` | `components/site/site-frame.tsx` | siehe E2E seo-a11y |
| Mobile-Menü per Tastatur (`aria-expanded`, Escape schließt, Fokus zurück) | `site-frame.tsx` (Phase 16) | siehe E2E seo-a11y; Phase-16-E2E A2 |
| Fokus sichtbar (3 px; Gold auf dunklen Flächen) | `site.module.css` | Phase-16-Test W-A11Y1; siehe E2E seo-a11y |
| Dialog: Fokusfalle/Schließen | Website ohne modale Dialoge; Mobile-Menü als einziges Overlay; Portal-Storno-Dialog (Phase 15) | E2E SEO-A9 (Menü schließt per Escape, Fokus zurück); Portal-Dialog durch Phase-15-E2E J/K abgedeckt |
| Konfigurator nur mit Tastatur (Schritt 1–6) | `components/configurator/` | siehe E2E seo-a11y |
| Formularlabels, Fehlermeldungen am Feld zugeordnet | Konfigurator, Portal-Login | siehe E2E seo-a11y |
| Storno-/Portal-Regression | `/konto/anmelden`, Portal-Seiten | siehe E2E seo-a11y; Phase-15/16-E2E unverändert |
| Kontrast (WCAG AA) | Tokens `.site` (UX_RULES „Website“) | Lighthouse `color-contrast` bestanden (100) |
| `prefers-reduced-motion` | `site.module.css` (Übergänge aus) | siehe E2E seo-a11y (emulateMedia) |
| Zoom 200 % ohne Verlust (Kernseiten) | Layout mit `clamp`/`rem`, `overflow-wrap`/`hyphens` | E2E SEO-A7 (Viewport 640×400 bei deviceScaleFactor 2 ≙ 1280-px-Fenster bei 200 %, dazu 320×568; kein Überlauf, Grundschrift ≥ 16 px) |
| Keine horizontale Scrollbar bei 320/360 px | alle Seiten | siehe Abschnitt 3 |
| Touchziele ≥ 44 px | CTA, Navigation, Brotkrume, Logo-Link | CSS-Regeln (`min-height: 44px`), Unit SEO-W-REV1 (Logo-Touchfläche) |
| Landmarken (`header`, `nav aria-label`, `main`, `footer`, Brotkrume `nav aria-label="Brotkrumen"`), `html[lang="de"]` | `site-frame.tsx`, `breadcrumbs.tsx`, `app/layout.tsx` | Lighthouse `landmark-*` bestanden; E2E SEO-A11/A12 |
| Genau ein inhaltlicher H1 je Seite | Hero-Überschrift bzw. Seitentitel; 404/410 eigener H1 | Rauchtest WEB-META (ein H1 je Seite), E2E SEO-M6 |
| Marken-Link: zugänglicher Name = sichtbarer Text (WCAG 2.5.3) | `site-frame.tsx` (Phase 17) | Lighthouse Messung 3 ohne Hinweis |
| Alt-Texte aller Bilder (leer nur dekorativ mit `aria-hidden`) | Block-Renderer (Phase 16) | E2E SEO-A10 |
| Automatisierter axe-Scan (WCAG 2.0/2.1 A/AA + Best Practices; `/`, Slush, Konfigurator, Region, Kontakt, `/konto/anmelden`, 404, 410) | E2E SEO-A8 (`@axe-core/playwright` 4.14.0, Tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `best-practice`) | 0 Verstöße – auch keine minor/moderate – auf allen acht Seiten (Läufe 2 und 5, 12.11.2026, Desktop Chrome 1280×720, Production-Build); Tabelle unten. WCAG-2.2-Regeln (z. B. `target-size`) sind nicht im Tag-Satz – Touchziele ≥ 44 px werden in SEO-A2 direkt gemessen |

Axe-Ergebnisse je Seite (Lauf 5; „bestanden“ = Anzahl bestandener Regeln, `incomplete` = Regeln
ohne automatische Entscheidung):

| Seite | Verstöße (alle Schweregrade) | bestandene Regeln | incomplete | inapplicable |
| --- | --- | --- | --- | --- |
| `/` | 0 | 37 | 0 | 53 |
| `/slushmaschine-mieten` | 0 | 39 | 0 | 51 |
| `/konfigurator` | 0 | 44 | 0 | 46 |
| `/slushmaschine-mieten/mainz` | 0 | 39 | 0 | 51 |
| `/kontakt` | 0 | 39 | 0 | 51 |
| `/konto/anmelden` (Portal-Login) | 0 | 34 | 0 | 56 |
| `/gibt-es-nicht` (404) | 0 | 37 | 0 | 53 |
| `/shop` (410, Proxy-HTML) | 0 | 26 | 0 | 64 |

Weitere Messwerte (Lauf 5): SEO-A7 Zoom 200 % (640×400 und 320×568 bei deviceScaleFactor 2) auf
Start, Slush, Konfigurator, Kontakt ⇒ `scrollWidth = innerWidth`, Grundschrift 17 px
(`1.0625rem`), H1 sichtbar, Kopf-CTA im Viewport; SEO-A2 Menü-Knopf und Kopf-CTA ≥ 44 px,
Tab-Reihenfolge im geöffneten Menü = 8 Links (7 Navigationspunkte + CTA); SEO-A6 unter
`prefers-reduced-motion: reduce` `transition-duration: 0s` / `animation-name: none` für Knöpfe,
Links und Menü.

## 3 Responsive-Matrix (Auftrag §21)

Viewports (CSS-Pixel): 320×568, 360×800, 390×844, 768×1024, 1024×768, 1440×900. Prüfung je
Seite: kein horizontaler Overflow (`document.documentElement.scrollWidth <= innerWidth`),
Header/Navigation, Hero, Produktkarten, Preise, FAQ, Konfigurator (alle sechs Schritte),
Formulare, CMS-Bilder, Fußzeile, Regionsseite, Portal-Regressionsseite. Automatisiert in
`tests/e2e/specs/seo-a11y.spec.ts` (SEO-A1: `documentElement`/`body.scrollWidth ≤ innerWidth`
in allen sechs Viewports auf Start, Slush, Konfigurator, Region, Kontakt, Portal-Login, 404,
410); ergänzend `overflow-wrap: anywhere` und `hyphens: auto` für Überschriften (Abschnitt 8).

**Fund RD-1 (adversarialer Review, behoben):** `.listValue` (Preiszeilen der Inklusiv-Listen,
z. B. „12,00 € je 1-L-Flasche · auf Kommission“) trug `white-space: nowrap` ⇒ horizontaler
Seiten-Overflow bei 320 und 360 px auf `/` und `/slushmaschine-mieten`. Fix in
`apps/web/components/site/site.module.css`: Zeile darf umbrechen (`text-align: right`, der
Betrag bleibt durch das geschützte Leerzeichen der Währungsformatierung zusammen);
abgesichert durch Unit SEO-W-CSS1 (kein `nowrap` auf `.listValue`) und E2E SEO-A1. Nach dem Fix
kein Overflow mehr auf diesen Seiten.

| Seite | 320×568 | 360×800 | 390×844 | 768×1024 | 1024×768 | 1440×900 |
| --- | --- | --- | --- | --- | --- | --- |
| `/` (Header/Nav, Hero, Produktkarten, Preise, Footer) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) |
| `/slushmaschine-mieten` (Produktkarten, Preise, Inklusive) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) |
| `/slushmaschine-mieten/mainz` (Brotkrume, Regionsinhalt) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) |
| `/konfigurator` (Schritte 1–6, Formulare, Preisübersicht; ≤ 390 px zusätzlich hydratisiert) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) |
| `/kontakt` (Kontaktblock, Formular-CTA) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) |
| `/konto/anmelden` (Portal-Regression) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) |
| 404 / 410 | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) | ok (SEO-A1) |
| `/faq` (FAQ-Block) | nicht Teil des automatisierten Satzes (SEO-A1 prüft die acht Kernseiten); FAQ-Block nutzt dieselben Container/Umbruchregeln – Sichtprüfung bei der Staging-Abnahme | – | – | – | – | – |

Eintrag „ok (SEO-A1)“: kein horizontaler Overflow (`documentElement`/`body.scrollWidth ≤
innerWidth`, gemessen nach `networkidle`), `main` im Viewport – Läufe 2 und 5 des Projekts `seo`
vom 12.11.2026 (6 Viewports × 8 Seiten). Messwerte (Lauf 5): maximale `scrollWidth` (html/body)
= `innerWidth` in jedem Viewport – 320/320, 360/360, 390/390, 768/768, 1024/1024, 1440/1440; die
vor dem Fix RD-1 erwartete Überlaufstelle bei 320/360 px (Inklusiv-Block) trat nicht mehr auf. Bewusst scrollbare Komponenten (die Schrittleiste des Konfigurators scrollt intern)
zählen nicht als Overflow der Seite. Bedienbarkeit der Elemente: Mobile-Navigation (SEO-A2,
360×800), Konfigurator (SEO-A3), Skip-Link (SEO-A5), Zoom (SEO-A7). Phase-16-E2E A2 (390×844: Menü, CTA als volle Zeile, kein horizontales Scrollen auf
Start + Konfigurator) bleibt zusätzlich bestehen. CMS-Bilder: Der Website-Seed enthält keine
Bilder (siehe „Nicht geprüft“); das Bild-Markup (`width`/`height`, `srcSet` aus den
WebP-Varianten, Alt-Text oder dekorativ) ist durch die Phase-16-Tests abgedeckt.

## 4 Internal-Link-QA (Auftrag §15)

Methode (`tests/e2e/specs/seo-links.spec.ts`, Projekt `seo`, Production-Build, SEO-L1–L8):
Alle veröffentlichten Testseiten (Seed `main`) und alle Sitemap-URLs werden geladen; jeder
interne Link (`a[href^="/"]`) wird aufgelöst und muss mit 200 antworten – kein 404, kein 410,
kein Redirect auf eine fehlende Seite; kein Link auf eine unveröffentlichte Seite (der Renderer
blendet solche Links aus, [SEO_TECHNICAL.md](SEO_TECHNICAL.md) „Interne Links“); keine
Token-Platzhalter (`<token>`, `:token`); keine exakte Abholadresse im Text; keine
`http://`-Produktionslinks; keine leeren `tel:`-/`mailto:`-/Instagram-Links; die CTAs lauten
„Slush konfigurieren“ und „Unverbindlich anfragen“ – nie „buchen“. Ergänzend warnt der
SEO-Check im Staff (`BROKEN_INTERNAL_LINK`) die Redaktion vor Links auf unveröffentlichte Seiten.
Ergebnis: Gate-Lauf des Projekts `seo` (Abschlussbericht Phase 17 „Internal-link QA“).

## 5 Regionsseiten-QA (Auftrag §16)

Keine automatisch erzeugten Ortsseiten; nur tatsächlich veröffentlichte CMS-Regionen sind
indexierbar und sitemapfähig (Standard-Entwürfe Mainz, Wiesbaden, Bad Kreuznach mit je eigenem
Text; weitere nur einzeln über „Regionale Seite anlegen“).

| Prüfpunkt | Umsetzung / Nachweis |
| --- | --- |
| eigener H1 | Seitentitel bzw. Hero-Überschrift der Regionsseite (ein H1 je Seite, E2E SEO-M6) |
| eigener Titel, eigene Description | Meta-Felder je Regionsseite; Duplikate meldet der SEO-Check (`META_TITLE_DUPLICATE`, `META_DESCRIPTION_DUPLICATE`), E2E SEO-M1/M2 |
| eigener Inhalt, kein Ortsnamen-Tausch | SEO-Check `REGION_NEAR_DUPLICATE` (Jaccard der Wort-3-Gramme ≥ 0,6, ab 30 Trigrammen zusätzlich Containment ≥ 0,6 für Teilkopien; Ortsnamen-Kopie der Mainz-Seite wird erkannt, die drei Standard-Entwürfe nicht – Unit SEO-U8, Integration SEO-API6) |
| Self-Canonical, kein Duplicate-Canonical auf Mainz | `canonicalUrl(base, page.path)` je Seite (Unit SEO-W3), E2E SEO-C3 |
| nur veröffentlicht in Sitemap/Index | Sitemap aus `bootstrap.pages` (nur veröffentlicht); zurückgezogen ⇒ verschwindet (E2E SEO-S4), neu angelegt ⇒ erst nach Publish (SEO-S5) |
| interne Verlinkung nur wenn veröffentlicht | `service_areas` verlinkt nur veröffentlichte Regionsseiten; Fußzeile ebenso (Phase 16, W-N*) |
| Brotkrume + `BreadcrumbList` | `Start › Slushmaschine mieten › <Region>`, JSON-LD identisch (SEO-W11/W15, SEO-SD*) |
| keine Doorway-Page-Automatik | kein Code erzeugt Seiten; Massenerzeugung nicht möglich (ein `POST /staff/cms/entries` je Seite) |

## 6 Google-Reviews-Compliance (Auftrag §25, Design D19)

Verifikation gegen die am 12.11.2026 abgerufenen Google-Maps-Platform-Policies (Stand
2026-11-09); bestehende Implementierung nicht umgebaut, nur die Attribution auf das offizielle
Logo umgestellt ([GOOGLE_REVIEWS_API_NOTES.md](GOOGLE_REVIEWS_API_NOTES.md) „Logo-Attribution“).
Kein echter Google-Aufruf, kein Key.

| Punkt | Beleg | Ergebnis |
| --- | --- | --- |
| maximal 5 Bewertungen | `apps/api/src/reviews/google.ts` (`GOOGLE_REVIEWS_MAX_REVIEWS = 5`, `slice(0, 5)`), Test RG5 | erfüllt |
| Autorenname (Pflicht) | Schema + Verwerfen ohne Name (`google.ts`), zweite Sperre `reviews/public.ts`, dritte Sperre Web `lib/reviews.ts` (`displayableReviews`) | erfüllt (drei Ebenen) |
| Autorenlink | nur https + Host-Allowlist, sonst verworfen; Web `rel="noopener noreferrer"` | erfüllt |
| Autorenfoto | Pflichtfeld, `referrerPolicy="no-referrer"`, `loading="lazy"`, erst nach Klick | erfüllt |
| direkter Review-Link (`googleMapsUri`) | Pflicht im Gateway; Web „Auf Google Maps ansehen“ | erfüllt |
| Google-Maps-Attribution | **Logo** (offizielles Asset `apps/web/public/google-maps-logo-gray.svg`, byteidentisch, SHA-256 `99a08b57…4016b5`, 18 px Höhe, Verhältnis 98:18, Freiraum ≥ 10 px, `alt="Google Maps"`, `translate="no"`, eigenständig oben in der Sektion, Link auf den Ort nur bei https-`placeUri`); Unit SEO-W-REV1/REV2 | umgestellt (Phase 17); Sichtabnahme mit echten Daten bleibt Go-live-Punkt 9 |
| Sortierhinweis (Pflicht) | `sortNote` („sortiert nach Relevanz durch Google … wir filtern nicht nach Sternen …“) | erfüllt |
| Übersetzungshinweis | `translated`/`translationNote`, Web „Von Google übersetzt“ + Originaltext aufklappbar | erfüllt |
| Reporting-Link | `flagUri` Pflicht (unzulässiger Link ⇒ Bewertung verworfen); Web „Bewertung melden“ | erfüllt (fail-safe) |
| `no-store` | Route `GET /public/reviews` (jede Antwort), Browser-Fetch `cache: 'no-store'`, Gateway ohne Cache; RV1 | erfüllt |
| keine DB-Speicherung | Volltextscan aller Tabellen im Test RV5 (Marker, Autor, Key, Avatar-URL ⇒ 0 Treffer); Budget-Tabelle nur Zeitspalten; Policy-Abschnitt „Data storage, caching, and scraping“ wörtlich gedeckt | erfüllt |
| kein automatischer Abruf (Klick-zum-Laden) | `reviews-section.tsx` `'use client'`, Fetch nur im Button-Handler; kein Server-/Prefetch-Aufruf (grep); E2E K2 (vor Klick keine Liste, keine Fremd-Requests) | erfüllt; von der Policy jetzt ausdrücklich empfohlen (*„fetch fresh details when a user interacts“*) |
| EWR-Gate fail-closed | `GOOGLE_REVIEWS_TERMS_CONFIRMED=true` Pflicht für `google`; demo nie Google/Key; Fabrik + Laufzeitsperre; RC4, RF3/RF4, RV3 | erfüllt; Permitted-Use-Klärung nur über Rechtsberatung/Google Sales (Support gibt keine Rechtsauskunft) |
| kein Google-JS/Widget, keine Karte | grep `apps/web` ohne googleapis/maps/gstatic/gtm; Logo lokal | erfüllt |
| Demo nie „Google“ | Text „Quelle: DEMO – synthetische Beispielbewertungen“, kein `<img>`; E2E K2 | erfüllt |
| kein echter Key im Test | nur Contract-Fake / injizierte Gateways | erfüllt |

Offen (keine Phase-17-Blocker, [OPEN_ITEMS.md](OPEN_ITEMS.md) „Phase 17“): Sichtabnahme des
Logos auf Staging mit echten Daten (Go-live 9); EWR-Permitted-Use (Go-live 2, nur
Rechtsberatung/Sales); Host-Liste für Avatare/Links (spätere CSP `img-src`, Staging-Smoke);
Position oben statt unterhalb der Liste und zweiter Textlink „Alle Bewertungen auf Google Maps“
(beides regelkonform, Entscheidung der Leitung). Ein E2E-Test im Google-Modus ist ohne
Env-Injektion der Fake-Places-URL nicht möglich (Quelltext-Unit-Tests + Staging-Abnahme).

## 7 Legal / Privacy – technische QA (Auftrag §26, Design D18)

Keine juristische Bewertung; nur technische Prüfung. **Die juristische Prüfung der Rechtstexte
bleibt vor dem Go-live ausdrücklich Blocker.**

| Prüfpunkt | Ergebnis |
| --- | --- |
| Impressum/Datenschutz bleiben Entwurf | Bootstrap legt nur Entwürfe an; nichts wird automatisch veröffentlicht (API-Start, Migration, Deployment); `--publish-demo` bricht in production/staging ab (B5) |
| Platzhalter nicht live-fähig | Impressum-Entwurf enthält „Anschrift: [vor Veröffentlichung eintragen]“ – Veröffentlichung ist eine bewusste Staff-Aktion mit `cms.publish`; in production veröffentlicht der Bootstrap nie |
| Datenschutz-Gate für Public Inquiry | ohne veröffentlichte `/datenschutz`-Revision: Konfigurator-Absenden gesperrt, API 409 `PRIVACY_NOT_PUBLISHED`; Konfigurator dann `noindex` und nicht in der Sitemap (Phase 17) |
| Cookies der Website-Origin (technisch notwendig) | Portal-Session `__Host-mr_customer_session` (development `mr_customer_session`; HttpOnly, Secure, SameSite=Strict, Path=/, absolut 30 Tage) – nur nach Magic-Link-Anmeldung; CMS-Vorschau `__Host-mr_cms_preview` (development `mr_cms_preview`; HttpOnly, Secure, SameSite=Strict, ≤ 30 min) – nur für Redaktion nach Einlösen eines Vorschau-Zugangs. Beide werden ohne Nutzeraktion nicht gesetzt. Staff-Cookies (`mr_staff_session`, `__Host-mr_staff_device`) gehören zur Staff-App, nicht zur Website |
| Web Storage | nur die `clientMutationId` (UUID) des Konfigurators in `sessionStorage` bis zum erfolgreichen Absenden – keine Kontaktdaten (Phase-16-Tests W-C1, E2E G1/G2) |
| keine Tracker, keine Analytics, kein Consent-Manager, kein Cookie-Banner | nichts hinzugefügt; E2E A1/K1 (keine Requests an fremde Hosts) |
| keine Newsletter-Cookies, kein Newsletter | nicht übernommen (WEBSITE_MIGRATION_NOTES W17) |
| Portal-/Vorschau-Cookies korrekt klassifiziert | technisch notwendig für Anmeldung bzw. Vorschau-Sitzung; `noindex`/`no-store` auf den zugehörigen Seiten |
| Google-Bewertungen im Datenschutz | Abruf erst nach Klick, Avatare/Links von Google – im Datenschutz-Open-Item gelistet ([OPEN_ITEMS.md](OPEN_ITEMS.md) „Phase 16“ Rechtstexte, [GOOGLE_REVIEWS_API_NOTES.md](GOOGLE_REVIEWS_API_NOTES.md) Abschnitt 7) |
| externe Ressourcen | keine Google Fonts, kein Maps-iframe, kein WhatsApp-Widget; Google-Maps-Logo lokal aus `apps/web/public/` |
| Phase-17-Daten | SEO-Check und Sitemap verarbeiten nur CMS-Inhalte/Produkt-Slugs, keine Personendaten; der Proxy loggt nichts |

## 8 Performance- und QA-Maßnahmen (tatsächlich umgesetzt)

Messen, dann gezielt verbessern (Auftrag §18) – keine pauschale Cache-Architektur, keine
Tracker, Reviews bleiben Klick-zum-Laden.

| Maßnahme | Datei | Anlass / Wirkung |
| --- | --- | --- |
| `overflow-wrap: anywhere` und `hyphens: auto` für `h1`–`h3`, Brotkrume mit `overflow-wrap` und `flex-wrap` | `apps/web/components/site/site.module.css` | lange Überschriften/Ortsnamen brechen bei 320 px ohne horizontalen Overflow |
| `.listValue` ohne `white-space: nowrap` (Review RD-1) | `apps/web/components/site/site.module.css` | Preiszeilen der Inklusiv-Listen brechen bei 320/360 px um – kein Seiten-Overflow auf `/` und `/slushmaschine-mieten`; Unit SEO-W-CSS1 |
| Konfigurator-Raster `grid-template-columns: minmax(0, 1fr)`, Fortschrittsbalken mit `gap: 0.25rem` | `apps/web/components/site/site.module.css` | das Raster schrumpft bei 320 px unter die Min-Content-Breite; die Schrittleiste scrollt intern statt das Raster zu dehnen; Unit SEO-W-CSS3, E2E SEO-A1 |
| Favicon-Platzhalter `apps/web/app/icon.svg` + `apps/web/app/favicon.ico` (neutral, bewusst kein Branding, 1:1 ersetzbar – wie die Staff-PWA-Icons in `apps/staff/public/icons/README.md`) | `apps/web/app/` | `GET /favicon.ico` 404 ⇒ Konsolenfehler ⇒ Best Practices 96; nach dem Fix 100. Finales Favicon/Logo: [OPEN_ITEMS.md](OPEN_ITEMS.md) „Phase 17“ |
| Marken-Link: `aria-label` nur, wenn der Link keinen sichtbaren Text hat (dekoratives Logo ohne Slogan ⇒ „<Firma> – Startseite“); sonst ist der sichtbare Text (Wortmarke/Logo-Alt + Slogan) der zugängliche Name | `apps/web/components/site/site-frame.tsx` | WCAG 2.5.3 „Label in Name“, Lighthouse `label-content-name-mismatch` behoben |
| Google-Maps-Logo mit `width`/`height` im nativen Verhältnis, `decoding="async"` | `reviews-section.tsx` | kein Layout-Shift beim Laden der Bewertungen |

Nicht umgesetzt (bewusst): Cache-Änderungen (bf-cache), Entfernen der Next-Polyfills/
Runtime-Chunks, Preload/Preconnect (Systemschriften, same-origin), Konfigurator-Bundle-
Aufteilung (Lighthouse zeigte kein Problem: TBT ≤ 0,06 s).

## 9 Nicht geprüft / Grenzen

- **LCP mit Hero-Bild:** Der Website-Seed enthält keine Bilder; LCP-Element war der
  Hero-Text. Bild-Markup (`width`/`height`, `srcSet`/`sizes`, WebP-Varianten, Lazy-Loading
  außer Hero) ist durch die Phase-16-Tests abgedeckt; eine Messung mit echtem Hero-Bild gehört
  zur Staging-Abnahme nach dem Medien-Upload.
- **Live-Domain:** kein Test gegen `www.miet-royal.de`/`miet-royal.de` (keine
  DNS-Umschaltung); Host-Redirect, Rich-Results-Test und Search Console sind Go-live-Smokes.
- **Echte Google-Antwort:** nur Contract-Fake; Staging-Smoke mit echtem Key bleibt Go-live 12.
- **X/Twitter-Cards:** offizielle Dokumentation nicht abrufbar (keine Primärquelle).
- **Felddaten (Core Web Vitals, INP):** nur Labor-Werte; INP-nahe Interaktionen über TBT
  (≤ 0,06 s) und die Playwright-Interaktionen abgeschätzt.
- **Pixel-/Screenshot-Tests:** bewusst nicht als alleinige Qualitätssicherung (Auftrag §30).
