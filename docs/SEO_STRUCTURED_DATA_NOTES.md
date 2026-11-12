# SEO_STRUCTURED_DATA_NOTES — Strukturierte Daten und Google-Regeln (Phase 17)

Stand: 2026-11-12 (Phase 17, Auftrag §13/§29). Alle Quellen wurden am **12.11.2026** lesend
abgerufen (Google Search Central, schema.org, Google Maps Platform, ogp.me). Zitiert wird nur
der normative Seitentext der Google-Dokumentation – die oben auf den Seiten eingeblendete,
automatisch erzeugte „Page Summary“ gilt nicht als Quelle. Umsetzung:
`apps/web/lib/site-jsonld.ts` (Builder), `apps/web/components/site/json-ld.tsx` (Ausgabe),
Aufrufer `apps/web/app/page.tsx` und `apps/web/components/site/cms-route.tsx`. Technischer
Rahmen (Indexierbarkeit, Canonicals, robots, Sitemap): [SEO_TECHNICAL.md](SEO_TECHNICAL.md).

**Vor dem Go-live diese Notizen erneut gegen die Quellen prüfen** (Google ändert Features –
in 2024 entfiel die Sitelinks-Searchbox, 2026 das FAQ-Rich-Result).

## Quellen

| Kurz | Quelle | Stand laut Seite |
| --- | --- | --- |
| SD-GEN | developers.google.com/search/docs/appearance/structured-data/sd-policies | 2026-07-10 |
| SD-INTRO | …/structured-data/intro-structured-data | 2025-12-10 |
| SD-ORG | …/structured-data/organization | 2026-09-08 |
| SD-SITENAME | developers.google.com/search/docs/appearance/site-names | 2025-12-10 |
| SD-BREAD | …/structured-data/breadcrumb | 2026-09-08 |
| SD-LOCAL | …/structured-data/local-business | 2026-09-08 |
| SD-REVIEW | …/structured-data/review-snippet | 2026-09-08 |
| SD-PRODUCT / SD-PSNIP / SD-MERCH | …/structured-data/product, …/product-snippet, …/merchant-listing | 2025-12-10 / Abruf 2026-11-12 |
| SD-GALLERY | …/structured-data/search-gallery (vollständige Feature-Liste) | 2026-10-16 |
| UPDATES | developers.google.com/search/updates (Ziel der Weiterleitungen von `…/faqpage` und `…/sitelinks-searchbox`) | 2026-11-09 |
| TAGS | …/crawling-indexing/special-tags | 2025-12-10 |
| IMG | developers.google.com/search/docs/appearance/google-images | 2026-03-02 |
| CANON | …/crawling-indexing/consolidate-duplicate-urls | 2026-07-10 |
| RMETA | …/crawling-indexing/robots-meta-tag | 2026-03-24 |
| NOINDEX | …/crawling-indexing/block-indexing | 2025-12-10 |
| RTXT-INTRO / RTXT-CREATE / RTXT-SPEC | …/crawling-indexing/robots/intro; developers.google.com/crawling/docs/robots-txt/create-robots-txt; …/robots-txt-spec | 2025-12-10 / 2025-11-21 / 2026-10-23 |
| SMAP / SMAP-OV / SMAP-PROTO | …/crawling-indexing/sitemaps/build-sitemap; …/sitemaps/overview; sitemaps.org/protocol.html | 2026-07-08 / 2025-12-10 / o. A. |
| REDIR / HTTP / MOVE | …/crawling-indexing/301-redirects; developers.google.com/crawling/docs/troubleshooting/http-status-codes; …/site-move-with-url-changes | 2026-04-14 / 2026-02-04 / Abruf 2026-11-12 |
| MOBILE | …/crawling-indexing/mobile/mobile-sites-mobile-first-indexing | 2025-12-10 |
| PX / CWV | developers.google.com/search/docs/appearance/page-experience; …/core-web-vitals | 2026-09-22 / 2025-12-10 |
| TITLE / SNIP | developers.google.com/search/docs/appearance/title-link; …/snippet | 2025-12-10 / 2026-04-20 |
| OGP | ogp.me | o. A. |
| SCHEMA-\* | schema.org/{WebSite, Organization, BreadcrumbList, LocalBusiness, Service, Product, Offer, RentAction, BusinessFunction} | o. A. |
| POL / ASSETS / GEO-BRAND | Google Maps Platform Places-Policies; Attribution-Asset-Zip; Geo-Markenrichtlinien (Details [GOOGLE_REVIEWS_API_NOTES.md](GOOGLE_REVIEWS_API_NOTES.md)) | 2026-11-09 / Zip 2025-07-08 / o. A. |

## Entscheidungen je Typ

| Typ | Entscheidung | Begründung (Quelle) |
| --- | --- | --- |
| `WebSite` | **Ja**, nur Startseite, ohne `SearchAction` | Site-Name-Signal: *„To indicate your site name preference, add WebSite structured data to your home page … WebSite structured data is most important, if you want to specify a preference.“*; *„The WebSite structured data must be on the home page of the site.“*; genau ein Block (*„avoid creating an additional WebSite structured data block on your home page“*) (SD-SITENAME). `SearchAction`/Sitelinks-Searchbox: *„The sitelinks search box feature is no longer available in Google Search results.“* (UPDATES, Nov. 2024) ⇒ kein Nutzen, es gibt auch keine Website-Suche. |
| `Organization` | **Ja**, Startseite, nur veröffentlichte Daten, **keine `address`** | *„Adding organization structured data to your home page can help Google better understand your organization's administrative details“*; *„There are no required properties“*; *„We recommend placing this information on your home page … You don't need to include it on every page of your site.“*; `telephone`: *„Be sure to include the country code and area code“*; `logo`: *„The image must be 112x112px, at minimum.“*, *„The image URL must be crawlable and indexable.“* (SD-ORG). `address` ist optional – die exakte Abholadresse bleibt geheim (MASTER_SPEC §8). |
| `BreadcrumbList` | **Ja**, nur auf Seiten mit sichtbarer Brotkrume (Regionsseiten, sekundäre Angebote) | *„define a BreadcrumbList that contains at least two ListItems“*; Pflicht je `ListItem`: `name`, `position` (ab 1), `item` – *„If the breadcrumb is the last item in the breadcrumb trail, item is not required.“* (SD-BREAD). Sichtbarkeit: *„Don't mark up content that is not visible to readers of the page.“* (SD-GEN) ⇒ JSON-LD = sichtbare Navigation (Auftrag §14). |
| `LocalBusiness` | **Nein** | Pflichtfelder `name` und **`address`** (*„The physical location of the business.“*, SD-LOCAL); schema.org: *„A particular physical business or branch of an organization.“* Die exakte Abholadresse darf nicht veröffentlicht werden; ob eine Nur-Ort-Adresse genügt, regelt die Doku nicht ⇒ konservativ nicht verwenden. `Organization` ohne Adresse genügt. |
| `Review` / `AggregateRating` | **Nein** | Selbstbewertungs-Verbot: *„If the entity that's being reviewed controls the reviews about itself, their pages that use LocalBusiness or any other type of Organization structured data are ineligible for star review feature. For example, a review about entity A is placed on the website of entity A, either directly in their structured data or through an embedded third-party widget (for example, Google Business reviews …).“*; *„Don't aggregate reviews or ratings from other websites.“* (SD-REVIEW). Zusätzlich werden Bewertungen erst nach Klick geladen (nicht Teil des serverseitigen Inhalts) und dürfen laut Maps-Policy nicht gespeichert werden (POL „Data storage, caching, and scraping“). |
| `FAQPage` | **Nein** | Feature abgeschafft: *„This feature will no longer appear in Google Search starting May 7, 2026.“* (UPDATES, Mai 2026); Doku im Juni 2026 entfernt; FAQ fehlt in SD-GALLERY. Die sichtbare FAQ-Seite bleibt normaler Inhalt. |
| `Product` / `Offer` | **Nein** | *„Product snippets: For product pages where people can't directly purchase the product.“*; Merchant Listings nur *„where a shopper can purchase a product“*; Rich Results nur für Seiten, die *„focus on a single product“* (SD-PRODUCT, SD-PSNIP, SD-MERCH). Vermietung ist in der Google-Doku nicht geregelt (schema.org `Offer.businessFunction`/`RentAction` dokumentiert Google nicht). Auftrag §13: eine unverbindliche Anfrage darf nicht als Kauf erscheinen; Preise bleiben einzige Quelle `priceCents` und stehen nie im Markup. |
| `Service`, `SearchAction`, `Article`/`WebPage` je Seite | **Nein** | kein Google-Feature (SD-GALLERY) bzw. abgeschafft; die bisherige Website lieferte `Article` für statische Seiten und `legalName` einer Agenturkennung – nichts davon wird übernommen ([WEBSITE_MIGRATION_NOTES.md](WEBSITE_MIGRATION_NOTES.md) §1). |

Allgemeine Regeln (SD-GEN), die die Umsetzung einhält: JSON-LD (*„JSON-LD (recommended)“*);
*„Your structured data must be a true representation of the page content.“*; *„Don't mark up
irrelevant or misleading content, such as fake reviews“*; *„Put the structured data on the page
that it describes“*; *„All image URLs specified in structured data must be crawlable and
indexable.“* ⇒ die `robots.txt` erlaubt im indexierbaren Zustand ausdrücklich
`/api/public/cms/media/` (veröffentlichte Bild-Varianten für `Organization.logo` und
`og:image`), obwohl `/api/` sonst gesperrt ist; *„Don't block your structured data pages to
Googlebot using robots.txt, noindex, or any other access control methods.“* ⇒ keine
strukturierten Daten auf `noindex`-Seiten (dort ohnehin ohne Wirkung). Google garantiert keine Darstellung (*„Google does not guarantee
that your structured data will show up in search results“*).

## Umsetzung

Alle Builder liefern nur Felder mit tatsächlich veröffentlichten Werten; fehlt ein Wert,
fehlt das Feld (nichts wird erfunden, keine Platzhalter).

### `WebSite` (Startseite)

```
{ "@context": "https://schema.org", "@type": "WebSite",
  "name": <businessName>, "url": "<Basis>/", "inLanguage": "de" }
```

`name` = veröffentlichter Firmenname aus den Website-Einstellungen (identisch zu `og:site_name`
und zum Titel-Suffix „Miet-Royal“ – Google: *„Use the same name … that you're using for your
site name“*); `url` = kanonische Basis mit Schluss-Slash. Kein `SearchAction`, kein
`alternateName`.

### `Organization` (Startseite)

| Feld | Herkunft | Regel |
| --- | --- | --- |
| `name` | `settings.businessName` (veröffentlicht) | Pflicht im Builder; identisch zu `WebSite.name` |
| `url` | kanonische Basis + `/` | nie aus Request-Headern |
| `logo` | `settings.logo` (veröffentlichtes CMS-Medium) | nur wenn gepflegt; größte VERÖFFENTLICHTE Variante als absolute URL `<Basis>/api/public/cms/media/<id>/<breite>` (nie Vorschau-Medien, nie fremde Hosts), per `Allow: /api/public/cms/media/` in der robots.txt crawlbar. Google verlangt mindestens 112×112 px und Formate aus BMP/GIF/JPEG/PNG/WebP/SVG/AVIF (IMG) – CMS-Varianten sind WebP, mindestens 480 px breit bzw. Originalbreite; bei sehr flachen Logos die Höhe beim Upload prüfen |
| `telephone` | `settings.phone` | nur in internationaler Schreibweise (`+49…`; `00…` wird zu `+`), abgeleitet aus dem `tel:`-Link; eine national gepflegte Nummer erscheint auf der Seite, aber nicht im JSON-LD |
| `email` | `settings.email` | nur in plausibler Form (`lokal@domain.tld`) |
| `sameAs` | `settings.instagramUrl` | nur als gültiger Instagram-Link (`https://instagram.com/…` bzw. `https://www.instagram.com/…`) |
| `address`, `geo`, `openingHours`, `openingHoursSpecification`, `priceRange`, `aggregateRating`, `review`, `hasOfferCatalog`, `makesOffer` | – | **nie** (keine exakte Abholadresse, keine Öffnungszeiten, keine Preisspannen, keine Bewertungen) |

Die Startseite trägt `WebSite` und `Organization` nur, wenn sie indexierbar ist UND eine
veröffentlichte Startseite (`home`) UND veröffentlichte Website-Einstellungen vorliegen.
`/ueber-uns` erhält kein zweites `Organization` (Google: einmal auf der Startseite genügt).

### `BreadcrumbList` (Regionsseiten, sekundäre Angebote)

```
{ "@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
  { "@type": "ListItem", "position": 1, "name": "Start", "item": "<Basis>/" },
  { "@type": "ListItem", "position": 2, "name": "<Titel der Slush-Seite>", "item": "<Basis>/slushmaschine-mieten" },
  { "@type": "ListItem", "position": 3, "name": "<Seitentitel>" } ] }
```

Positionen ab 1, `item` als Canonical-URL der sichtbaren Glieder, letztes Element (die Seite
selbst) ohne `item`; Namen = sichtbare Linktexte (`Start`, Titel der veröffentlichten
Slush-Seite, Seitentitel). Sekundäre Angebote: `Start › <Seitentitel>` (zwei Glieder, Minimum
laut SD-BREAD). Ist `/slushmaschine-mieten` nicht veröffentlicht, fehlt das mittlere Glied
sichtbar UND im JSON-LD. In der CMS-Vorschau ist die Brotkrume sichtbar, JSON-LD wird dort
nicht ausgegeben.

### Ausgabe und Escaping

`<JsonLd>` (`components/site/json-ld.tsx`) rendert `<script type="application/ld+json"
data-testid="jsonld-<typ>">` (Test-IDs `jsonld-website`, `jsonld-organization`,
`jsonld-breadcrumblist`). Es ist die einzige Stelle mit `dangerouslySetInnerHTML` in
`apps/web`; der Inhalt ist ausschließlich `JSON.stringify`-Ausgabe der eigenen Builder, in der
`<`, `>` und `&` als Unicode-Escapes (`<`, `>`, `&`) kodiert sind – kein
CMS-Text (z. B. `</script>`) kann das Script-Element beenden oder HTML einschleusen; das
Ergebnis bleibt gültiges JSON. Jeder Typ steht in einem eigenen Script-Element.

### Wo keine strukturierten Daten stehen

Vorschau (`/vorschau*`), Portal (`/konto*`), Token-Seiten, 404, 410, Fallback-Startseite,
„Gleich wieder da“, Demo-Instanz, Konfigurator (keine Produkt-/Angebotsdaten) und jede Seite
ohne indexierbaren Kontext (Schalter aus, Basis fehlt/ungültig, Origin-Sperre). Keine
Metadaten oder JSON-LD hängen von Viewport oder User-Agent ab (Mobile-first: *„Make sure that
your mobile and desktop sites have the same structured data.“*, MOBILE).

### Konservativitätsregeln

- **Keine exakte Abholadresse** – weder als `address` noch in Freitextfeldern; deshalb kein
  `LocalBusiness`. Öffentlich gilt nur die Region („Mainz-Hechtsheim“), und auch sie steht nicht
  im JSON-LD.
- Keine Öffnungszeiten (nicht belegt), keine Preisspannen, keine Bewertungssterne, keine
  Zähler, keine FAQ-Markups, keine Kauf-Semantik.
- Nur Daten, die auf der Seite sichtbar veröffentlicht sind (SD-GEN); Telefon/E-Mail/Instagram
  nur, wenn sie in den veröffentlichten Website-Einstellungen gepflegt sind (vor Go-live
  bestätigen, [OPEN_ITEMS.md](OPEN_ITEMS.md) „Geschäftsdaten“).

## Weitere Google-Regeln, die Phase-17-Entscheidungen begründen

| Thema | Zitat / Befund | Folge |
| --- | --- | --- |
| `noindex` vs. `robots.txt` | *„For the noindex rule to be effective, the page or resource must not be blocked by a robots.txt file … the crawler will never see the noindex rule, and the page can still appear in search results“* (NOINDEX); *„Google may still index URLs that are disallowed in robots.txt without their content.“* (CANON); robots.txt *„is not a mechanism for keeping a web page out of Google“* (RTXT-INTRO) | Portal, Vorschau und Token-Seiten nur per `noindex` (Meta + `X-Robots-Tag`), nicht per `Disallow`; auch nicht indexierbare Instanzen (Staging/Demo) erhalten kein `Disallow: /`, sondern bleiben crawlbar mit `noindex` auf jeder Antwort (Review RA-3); `Disallow` nur für `/api/`, mit `Allow: /api/public/cms/media/` für veröffentlichte Bilder (SD-GEN: Bild-URLs müssen crawlbar sein); keine Tokens in robots.txt |
| Canonical | *„Use absolute paths rather than relative paths“*; *„only accepted if it appears in the <head>“*; Self-Canonical empfohlen; *„Don't specify a URL fragment as canonical“*; HTTPS bevorzugt (CANON). „Canonical auf noindex-Seite“ ist nicht ausdrücklich geregelt | genau ein absoluter Canonical im `<head>` je indexierbarer Seite, Query/Fragment entfernt; keine Canonicals auf noindex-Seiten |
| Redirects | *„The 301 and 308 status codes mean that a page has permanently moved“* (REDIR); *„308 (moved permanently): Equivalent to 301.“* (HTTP); *„Avoid chaining redirects … redirecting to the final destination directly“*; *„Don't redirect many old URLs to one irrelevant single URL destination, such as the home page … might be treated as a soft 404 error.“* (MOVE) | projektweit 308 in einem Hop; thematisch wertlose Alt-URLs ⇒ 410 statt Sammel-Redirect auf `/` |
| 404/410 | *„All 4xx errors, except 429, are treated the same … the indexing pipeline removes the URL from the index“*; Soft-404 bei 2xx mit Fehlertext (HTTP) | echter Status 404 bzw. 410, nie 200 mit „nicht gefunden“; 410 für endgültig entfernte WordPress-Reste ist semantisch korrekt |
| Sitemap | *„Use fully-qualified, absolute URLs“*; *„Google ignores <priority> and <changefreq> values.“*; `lastmod` nur, wenn *„consistently and verifiably … accurate“* (SMAP); Sitemap-Direktive in robots.txt *„must be a fully-qualified URL“* (RTXT-CREATE) | Sitemap-URLs = Canonicals, `lastModified` nur aus `publishedAt`, keine `priority`/`changefreq`; Sitemap-Zeile nur mit gültiger Basis |
| Titel / Description | *„While there's no limit on how long a <title> element can be, the title link is truncated“*; *„Avoid repeated or boilerplate text“*; Site-Name einmal am Anfang oder Ende mit Trennzeichen (TITLE); *„Create unique descriptions for each page“* (SNIP); *„The meta-keyword tag is not used by Google Search“* (TAGS) | Site-Name genau einmal („ – Miet-Royal“), keine Meta-Keywords; Staff-Hinweise zu Länge und Duplikaten sind weiche Hinweise (Google kürzt gerätespezifisch), keine Sperre |
| Core Web Vitals | *„LCP … within the first 2.5 seconds“*, *„INP of less than 200 milliseconds“*, *„CLS score of less than 0.1“* (CWV); *„trying to get a perfect score just for SEO reasons may not be the best use of your time.“* (PX) | Lighthouse-Laborwerte in [WEBSITE_QA_REPORT.md](WEBSITE_QA_REPORT.md); Felddaten erst nach Go-live |
| OpenGraph | ogp.me: Pflicht `og:title`, `og:type`, `og:image`, `og:url`; *„If the page specifies an og:image it should specify og:image:alt.“* (OGP). Google nutzt `og:title` (TITLE) und `og:site_name` (SD-SITENAME) als Quellen; eine Ranking-Aussage gibt es nicht | OG immer mit Titel/Typ/Locale/Site-Name, `og:url` nur indexierbar, `og:image` nur mit veröffentlichtem Hero-Bild (bewusster Verzicht statt erfundenem Bild) |
| Google-Maps-Attribution | *„Attribution should take the form of the Google Maps logo whenever possible. In cases where space is limited, the text Google Maps is acceptable.“* (POL) | Logo-Attribution mit dem offiziellen Asset ([GOOGLE_REVIEWS_API_NOTES.md](GOOGLE_REVIEWS_API_NOTES.md) „Logo-Attribution“) |

## Prüfmethode

- **Unit** (`pnpm --filter @mietroyal/web test`): `apps/web/lib/site-jsonld.test.ts` SEO-W9
  (`WebSite` ohne SearchAction), SEO-W10 (`Organization` nur mit vorhandenen Daten, verbotene
  Felder fehlen, Vorschau-Logo entfällt, Telefon nur international), SEO-W11
  (`BreadcrumbList` Positionen, letztes Element ohne `item`, Canonical-URLs), SEO-W12
  (Escaping, gültiges JSON).
- **E2E** (Projekt `seo`, Production-Build mit Indexierung): `tests/e2e/specs/seo-metadata.spec.ts`
  SEO-SD1–SD8 – gültiges JSON-LD, `WebSite`, `Organization` nur mit vorhandenen Daten, kein
  Abholort, keine Öffnungszeiten, keine Bewertungen/AggregateRating, `BreadcrumbList` =
  sichtbare Brotkrume, nichts auf Vorschau/Portal/Token/404/410.
- **Rich-Results-Test / Schema Markup Validator:** erst nach dem Go-live gegen
  `https://www.miet-royal.de` (Go-live-Punkt, [PRE_START_CHECKLIST.md](PRE_START_CHECKLIST.md));
  Site-Names werden im Rich-Results-Test nicht unterstützt (*„Site names aren't supported in
  the Rich Results Test.“*, SD-SITENAME) ⇒ `WebSite` mit dem Schema Markup Validator prüfen.
  In Phase 17 wurde keine Live-Domain geprüft (keine DNS-Umschaltung).

## Nicht geklärt (ausdrücklich offen, nichts geraten)

- X/Twitter-Cards: Die offizielle Dokumentation war am 12.11.2026 nicht abrufbar (Umleitung/
  404). `twitter:card=summary` bzw. `summary_large_image`, `twitter:title`, `twitter:description`
  und optional `twitter:image` folgen dem allgemein bekannten Schema; Pflichtfelder sind nicht
  aus einer Primärquelle belegbar. Kein Blocker (OpenGraph deckt die Vorschau ab).
- Ranking-Wirkung von OpenGraph: keine Aussage in der Google-Dokumentation.
- `LocalBusiness` mit Nur-Ort-Adresse: nicht geregelt ⇒ nicht verwendet.
- Vermietung in `Product`/`Offer` (`businessFunction` LeaseOut): von Google nicht dokumentiert
  ⇒ nicht verwendet.
- Trennzeichen im Titel: nicht vorgeschrieben (Bindestrich, Doppelpunkt, Pipe gleichwertig
  genannt) – Miet-Royal nutzt den Gedankenstrich.
- Logo-Mindestgröße 112×112 px hängt vom hochgeladenen Logo ab (Seitenverhältnis); vor Go-live
  mit dem finalen Logo prüfen.
