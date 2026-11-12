# SEO_TECHNICAL — Technische SEO der Website (Phase 17)

Stand: 2026-11-12 (Phase 17). Maßgeblich ist der Code; dieses Dokument beschreibt ihn.
Verwandte Dokumente: [REDIRECT_MATRIX.md](REDIRECT_MATRIX.md) (verbindliche Alt-URL-Tabelle),
[SEO_STRUCTURED_DATA_NOTES.md](SEO_STRUCTURED_DATA_NOTES.md) (strukturierte Daten mit
Google-Quellen), [WEBSITE_QA_REPORT.md](WEBSITE_QA_REPORT.md) (Lighthouse, Accessibility,
Responsive, Compliance), [WEBSITE_CMS.md](WEBSITE_CMS.md) (Meta-Felder, SEO-Hinweise im
Staff), [WEBSITE_MIGRATION_NOTES.md](WEBSITE_MIGRATION_NOTES.md) (Inventur der bisherigen
Website), [DEPLOYMENT_NOTES.md](DEPLOYMENT_NOTES.md) „Website SEO, Redirects, kanonischer Host
(Phase 17)“, [ENVIRONMENTS.md](ENVIRONMENTS.md) „Website-SEO (Phase 17)“,
[PRE_START_CHECKLIST.md](PRE_START_CHECKLIST.md) „Website-Go-live SEO“.

## Grundsätze

- **Indexierung fail-closed.** `WEB_INDEXING_ENABLED` ist per Default aus; ohne den exakten
  Wert `true` ist jede Antwort der Website `noindex, nofollow`. Auch mit Schalter wird eine
  Seite nur indexierbar, wenn alle weiteren Bedingungen erfüllt sind (Abschnitt
  „Indexierbarkeit“). Nichts wird in Phase 17 automatisch eingeschaltet.
- **Keine Host-Ableitung.** Absolute URLs (Canonical, `og:url`, Sitemap, Sitemap-Zeile in
  `robots.txt`, JSON-LD) entstehen ausschließlich aus der konfigurierten öffentlichen Basis
  (`MAIL_PUBLIC_WEB_BASE_URL`, geliefert über den Bootstrap der API). Host-Header,
  `X-Forwarded-Host` oder `request.url` sind nie eine Quelle. Der kanonische Host
  `www.miet-royal.de` wird im Reverse-Proxy erzwungen, nicht im Anwendungscode.
- **CMS bleibt Source of Truth.** Titel und Beschreibung kommen aus den Meta-Feldern des CMS,
  Fallback ist der Seitentitel. Keine Keyword-Logik, keine Meta-Keywords, keine automatische
  Umschreibung. Der SEO-Check im Staff warnt nur – er blockiert nie.
- **Private Bereiche bleiben privat.** Portal (`/konto*`), Vorschau (`/vorschau*`),
  Token-Seiten (`/kontakt/<token>`, `/angebot/<token>`, `/dokument/<token>`), 404, 410,
  Fallback-/Fehlerseiten und die Demo-Instanz sind IMMER `noindex` und stehen nie in der
  Sitemap. Keine Phase-17-Regel macht eine private oder tokenisierte Seite öffentlich.
- **Ein Verfahren für Alt-URLs.** Permanente Redirects sind projektweit `308` in genau einem
  Hop; endgültig entfernte WordPress-Reste liefern echten HTTP `410`.

Code (Web, `apps/web`): `lib/site-seo.ts` (Basis-Prüfung, Indexierbarkeit, Canonical,
Metadaten, robots, Sitemap), `lib/site-meta.ts` (Metadaten je Seitentyp), `lib/site-jsonld.ts`
(JSON-LD-Builder), `lib/legacy-routes.ts` + `proxy.ts` (Alt-URLs), `app/robots.ts`,
`app/sitemap.ts`, `app/layout.tsx`, `app/not-found.tsx`, `components/site/breadcrumbs.tsx`,
`components/site/json-ld.tsx`, `components/site/cms-route.tsx`, `components/site/site-data.ts`.
API: `apps/api/src/cms/public-site.ts` (Bootstrap mit `publicBaseUrl` und `publishedAt`),
`apps/api/src/cms/seo-check.ts` + Route in `apps/api/src/routes/website-cms.ts`,
`apps/api/src/public/catalog.ts` (Preis-Guard). Staff: `apps/staff/components/website.tsx`
(`SeoWarningsBox`).

## Kanonische Basis

Die API liefert im Bootstrap `GET /public/site/settings` das Feld
`publicBaseUrl: string | null` = `MAIL_PUBLIC_WEB_BASE_URL` ohne Schluss-Slash (fehlt die
Variable ⇒ `null`). Das Web prüft den Wert zusätzlich (`validSeoBaseUrl`, `lib/site-seo.ts`):

| Bedingung | Beispiel gültig | Beispiel ungültig ⇒ `null` |
| --- | --- | --- |
| absolute URL | `https://www.miet-royal.de` | `www.miet-royal.de`, leer |
| Protokoll `https:`; `http:` nur außerhalb von production und nur für Hostname `localhost` oder `127.0.0.1` (Entwicklung, E2E, Lighthouse) – in production (`WEB_APP_ENV=production` oder Bootstrap `environment: 'production'`) ist jede `http:`-Basis ungültig (Review RA-2) | `http://127.0.0.1:3100` (nicht production) | `http://staging.example.org`; `http://localhost:3000` in production |
| keine Zugangsdaten | – | `https://user:pw@www.miet-royal.de` |
| kein Query, kein Fragment, kein Leerraum | – | `https://www.miet-royal.de/?x=1`, `…/#top` |
| Pfad genau `/` | `https://www.miet-royal.de/` | `https://www.miet-royal.de/website` |

Rückgabe ist der Origin (klein geschrieben, ohne Schluss-Slash, Port bleibt). Ohne gültige
Basis gibt es keine absoluten URLs – auch wenn `WEB_INDEXING_ENABLED=true` gesetzt ist
(Auftrag §4: fail-closed, keine erfundene Domain). Production: `MAIL_PUBLIC_WEB_BASE_URL`
muss `https://www.miet-royal.de` sein (ohne Pfad); das Web lehnt in production jede http-Basis
ab (auch `localhost`), die API verlangt in production ohnehin HTTPS für diese Variable, sobald
der Mailversand aktiv ist.

## Indexierbarkeit

`seoContext` (`lib/site-seo.ts`) entscheidet je Request einmal (dedupliziert über
`getSeoEnv` in `components/site/site-data.ts`, keine zusätzlichen API-Aufrufe):

```
indexable = WEB_INDEXING_ENABLED === 'true'
         && !demo
         && !originMismatch
         && validSeoBaseUrl(bootstrap.publicBaseUrl, { allowLocalHttp: !production }) !== null
```

- `production` = `WEB_APP_ENV=production` ODER der Bootstrap meldet `environment: 'production'`
  ⇒ nur eine https-Basis gilt (auch `http://localhost` ist dann ungültig).

- `demo` = `WEB_APP_ENV=demo` ODER `GET <WEB_API_ORIGIN>/health` meldet `environment: 'demo'`
  ODER der Bootstrap meldet `environment: 'demo'`.
- `originMismatch` = Build- und Laufzeit-Origin der API weichen ab (dieselbe Sperre wie für
  Konfigurator-Absenden und Vorschau, Phase 16).
- Bootstrap nicht erreichbar ⇒ keine Basis ⇒ nicht indexierbar.

Ist der Kontext nicht indexierbar, gilt `base = null`: kein Canonical, kein `og:url`, kein
Social Image, leere Sitemap, `robots.txt` sperrt alles, kein JSON-LD. Zusätzlich entscheidet
jede Seite über ihre eigene Bedingung:

| Seite | indexierbar, wenn Kontext indexierbar UND … | sonst |
| --- | --- | --- |
| Startseite `/` | eine veröffentlichte Seite vom Typ `home` vorliegt | Fallback-Startseite („Unsere neue Website wird gerade vorbereitet.“) und „Gleich wieder da“ (API nicht erreichbar): `noindex`, kein Canonical |
| CMS-Seiten (`slush`, `process`, `faq`, `about`, `contact`, `legal`, `region`, `secondary_offer`) | die Seite veröffentlicht ist und der Seitentyp zur Route passt | nicht veröffentlicht/falscher Typ ⇒ echter 404; API nicht erreichbar ⇒ „Gleich wieder da“ `noindex` |
| `/konfigurator` | der Konfigurator technisch nutzbar ist (`configuratorIndexable`): Katalog erreichbar, ≥ 1 Maschine, `/datenschutz` veröffentlicht, keine Origin-Sperre | `noindex` ohne Canonical (Titel/Beschreibung bleiben) |

**Immer `noindex` (unabhängig vom Schalter):** Demo-Instanz; Vorschau `/vorschau*` (Meta +
`X-Robots-Tag: noindex, nofollow, noarchive`); Portal `/konto*` (Meta + `X-Robots-Tag:
noindex, nofollow, nocache`); Token-Seiten `/kontakt/<token>`, `/angebot/<token>`,
`/dokument/<token>` (Meta + `X-Robots-Tag: noindex, nofollow, noarchive`); 404-Seite; 410-Seite
(Meta + `X-Robots-Tag: noindex, nofollow`); Fallback-Startseite; „Gleich wieder da“. Das
Root-Layout (`app/layout.tsx`) setzt `robots` IMMER auf `noindex, nofollow` – jede
Website-Seite muss sich ausdrücklich freigeben.

## Canonicals

- Nur indexierbare Seiten erhalten genau einen absoluten Canonical
  (`<link rel="canonical">` im `<head>`, kein zusätzlicher HTTP-Header):
  `${base}${pfad}`; Startseite `${base}/`.
- Pfadnormalisierung (`normalizeSeoPath`): Query und Fragment entfernt, Mehrfach-Slashes
  zusammengefasst, Schluss-Slash entfernt (außer `/`). Beispiele: `/slushmaschine-mieten` ⇒
  selbst; `/slushmaschine-mieten/mainz` ⇒ Self-Canonical der Regionsseite (nie auf die Slush-
  oder Mainz-Seite einer anderen Region); `/konfigurator?maschine=slush-1x8` ⇒
  `${base}/konfigurator`.
- Nicht indexierbare Seiten (Portal, Token, Vorschau, 404, 410, Fallback, „nicht erreichbar“,
  Demo) haben KEINEN Canonical; es gibt keine Canonicals auf unveröffentlichte Seiten.
- Sitemap-URLs sind exakt die Canonical-URLs (eine Normalisierungsfunktion für beides).

## robots.txt (`app/robots.ts`, dynamisch je Request)

| Zustand | Ausgabe |
| --- | --- |
| nicht indexierbar (Schalter aus, Demo, keine/ungültige Basis, Origin-Sperre, Bootstrap nicht erreichbar) | `User-Agent: *` / `Allow: /` / `Disallow: /api/` – KEINE Sitemap-Zeile |
| indexierbar | `User-Agent: *` / `Allow: /` / `Allow: /api/public/cms/media/` / `Disallow: /api/` / `Sitemap: <Basis>/sitemap.xml` |

- **Kein `Disallow: /` für nicht indexierbare Instanzen** (Entscheidung D7 final, adversarialer
  Review RA-3): `robots.txt` hält keine URL aus dem Index. Laut Google Search Central („Block
  Search indexing with noindex“, „Introduction to robots.txt“, Stand 2025-12-10 – Quellen in
  [SEO_STRUCTURED_DATA_NOTES.md](SEO_STRUCTURED_DATA_NOTES.md)) kann eine per robots.txt
  gesperrte URL ohne Inhalt indexiert werden, und das `noindex`, das JEDE Antwort einer nicht
  indexierbaren Instanz trägt, würde nie gelesen. Staging und Demo bleiben deshalb crawlbar und
  werden durch `noindex` (Meta + `X-Robots-Tag`) aus dem Index gehalten; eine Sitemap-Zeile gibt
  es dort nicht.
- **Nur `/api/` ist gesperrt** (liefert kein indexierbares HTML). Im indexierbaren Zustand gilt
  zusätzlich `Allow: /api/public/cms/media/` (die längere Allow-Regel gewinnt gegen
  `Disallow: /api/`): veröffentlichte CMS-Bilder (`og:image`, `Organization.logo`,
  Seitenbilder) müssen crawlbar sein – Google verlangt crawlbare Bild-URLs in strukturierten
  Daten (Review RA-1).
- **Portal, Vorschau und Token-Seiten werden bewusst NICHT per `Disallow` aufgeführt** (gleicher
  Grund; bei Token-URLs wäre genau die URL das Geheimnis). `robots.txt` ist keine
  Sicherheitsgrenze und listet nie Tokens. Diese Bereiche bleiben ausschließlich über `noindex`
  (Meta + `X-Robots-Tag`) aus dem Index und stehen nie in der Sitemap.
- Ohne `WEB_INDEXING_ENABLED=true` laden `robots.txt` und `sitemap.xml` keinen Bootstrap und
  keinen `/health`-Status (Frühausstieg, Review RD-3). Antwort `text/plain`,
  `Cache-Control: public, max-age=0, must-revalidate`.

## Sitemap (`app/sitemap.ts`, dynamisch je Request)

- Nicht indexierbar ⇒ leere `urlset` (die `robots.txt` nennt die Sitemap dann nicht); ohne
  `WEB_INDEXING_ENABLED=true` ohne jeden Bootstrap-/Health-Aufruf.
- Indexierbar ⇒ alle veröffentlichten Seiten aus `bootstrap.pages` (Startseite, feste Seiten,
  Rechtstexte, Regionsseiten, sekundäre Angebote) mit `url = Canonical` und
  `lastModified = publishedAt` (ISO-Zeitpunkt der letzten Veröffentlichung aus
  `cms_entries.published_at`; ungültig/fehlend ⇒ kein `lastmod`, nie ein erfundenes Datum).
  Pfade müssen dem CMS-Pfadmuster entsprechen; Dubletten entfallen.
- `/konfigurator` zusätzlich ohne `lastmod`, nur wenn technisch nutzbar
  (`configuratorIndexable`, siehe oben).
- Reihenfolge: `/` zuerst, dann Pfade aufsteigend. Keine `priority`/`changefreq`.
- Nie enthalten: Entwürfe, zurückgezogene Seiten, Fallback-Seite, Vorschau, Portal,
  Token-Seiten, 404/410, API, Demo. Eine zurückgezogene Regionsseite verschwindet mit dem
  nächsten Abruf; eine neue Regionsseite erscheint erst nach Veröffentlichung.

## Metadaten, OpenGraph, Twitter Card (`buildSiteMetadata`)

| Feld | Quelle / Regel |
| --- | --- |
| `<title>` | `sitePageTitle(metaTitle, title)`: Meta-Titel aus dem CMS, sonst Seitentitel; „ – Miet-Royal“ nur angehängt, wenn der Markenname nicht enthalten ist (keine Doppelung). Feste Titel: Konfigurator „Slush konfigurieren – Miet-Royal“, 404 „Seite nicht gefunden – Miet-Royal“, „Gleich wieder da – Miet-Royal“, 410 „Diese Seite gibt es nicht mehr – Miet-Royal“ |
| `description` | Meta-Beschreibung aus dem CMS; fehlt sie, gibt es keine Description (nichts erfunden). Konfigurator: fester Text |
| `robots` | `index, follow` nur wenn indexierbar, sonst `noindex, nofollow` |
| `alternates.canonical` | nur indexierbar (siehe „Canonicals“) |
| `openGraph` | `title` (= Dokumenttitel), `description` (nur wenn vorhanden), `type: website`, `locale: de_DE`, `siteName` = veröffentlichter Firmenname (`businessName`), `url` nur indexierbar, `images` nur indexierbar und nur mit Social Image |
| `twitter` | `card: summary_large_image` mit Bild, sonst `summary`; `title`, `description` (nur wenn vorhanden), `images` wie OpenGraph |
| Meta-Keywords | nie |

**Social Image (Auftrag §12):** ausschließlich das Bild eines `hero`-Blocks an erster
Stelle der Seite – also eine veröffentlichte, über das CMS gepflegte eigene Bildreferenz.
Verwendet wird die größte veröffentlichte Variante als absolute Medien-URL
`${base}/api/public/cms/media/<id>/<breite>` (`width` = Variantenbreite, `height` proportional
zum Original, `alt` nur wenn nicht dekorativ). Vorschau-Medien, fremde Hosts oder Bilder der
bisherigen Website werden nie verwendet; ohne Hero-Bild sind OpenGraph/Twitter ohne Bild
(zulässig laut Auftrag; ogp.me zählt `og:image` zwar zu den Pflichtfeldern, ein erfundenes
Bild ist aber ausgeschlossen). Das Logo aus den Website-Einstellungen erscheint nur im
JSON-LD (`Organization.logo`), nicht als `og:image`.

Hinweis zur Prüfung: Next liefert die Metadaten im Server-HTML; Canonical und `robots` lagen
im Rauchtest für Googlebot-, Chrome- und Social-Crawler-User-Agents jeweils im `<head>`.

**Favicon:** `apps/web/app/icon.svg` und `apps/web/app/favicon.ico` sind neutrale Platzhalter
(Phase 17, Lighthouse-QA: `GET /favicon.ico` lieferte vorher 404 ⇒ Konsolenfehler ⇒ Best
Practices 96). Next liefert sie als Metadata-Routen `/icon.svg` und `/favicon.ico` aus und
setzt `<link rel="icon">`; der Alt-URL-Proxy fasst beide nicht an. Das finale Favicon/Logo
ersetzt die Dateien 1:1 ([OPEN_ITEMS.md](OPEN_ITEMS.md) „Phase 17“).

## Strukturierte Daten (Kurzfassung)

Nur auf indexierbaren Seiten mit Basis: `WebSite` + `Organization` auf der Startseite (nur
veröffentlichte Daten, keine Adresse), `BreadcrumbList` auf Regions- und Secondary-Offer-Seiten
(identisch zur sichtbaren Brotkrume). Kein `LocalBusiness`, kein `Review`/`AggregateRating`,
keine `FAQPage`, kein `Product`/`Offer`. Nichts auf Vorschau, Portal, Token-Seiten, 404, 410,
Fallback oder „nicht erreichbar“. Serialisierung mit Unicode-Escapes für `<`, `>` und `&`.
Vollständige Begründung mit Quellen: [SEO_STRUCTURED_DATA_NOTES.md](SEO_STRUCTURED_DATA_NOTES.md).

## Breadcrumbs (`components/site/breadcrumbs.tsx`, Helfer `breadcrumbItems` in `lib/site-nav.ts`)

- Sichtbar nur dort, wo sie die Orientierung verbessern: Regionsseiten
  (`Start › <Titel der veröffentlichten Slush-Seite> › <Seitentitel>`; das Slush-Glied
  entfällt, wenn `/slushmaschine-mieten` nicht veröffentlicht ist) und sekundäre Angebote
  (`Start › <Seitentitel>`). Alle anderen Seitentypen haben keine Brotkrume.
- Markup: `<nav aria-label="Brotkrumen" data-testid="site-breadcrumbs">` mit `<ol>`; die
  aktuelle Seite als `<span aria-current="page">` ohne Link; Trennzeichen rein per CSS (kein
  Text im DOM); Einträge mindestens 44 px hoch, mobil umbrechend.
- `BreadcrumbList` (JSON-LD) nur auf indexierbaren öffentlichen Seiten und exakt in der
  sichtbaren Reihenfolge (keine versteckten SEO-Breadcrumbs). In der CMS-Vorschau ist die
  Brotkrume sichtbar (gleicher Renderer), aber ohne JSON-LD.

## 404 und 410

**404** (`app/not-found.tsx`): echter Status 404 für unbekannte Adressen UND für nicht
veröffentlichte oder zurückgezogene CMS-Seiten (nie 200 mit „nicht gefunden“). Titel „Seite
nicht gefunden – Miet-Royal“, `noindex, nofollow` (zusätzlich zu Nexts eigenem
`<meta name="robots" content="noindex">` – zwei Tags, beide `noindex`), kein Canonical, kein
JSON-LD. Die Seite zeigt im Website-Rahmen „Diese Seite gibt es nicht (mehr).“ mit Links
„Zur Startseite“ und „Slush konfigurieren“; Kontakt und Slush sind über die Navigation
erreichbar. Kein technischer Fehlercode im UI. Die Token-Semantik der Phase 12/15/16 bleibt
unverändert (fremde Token ⇒ neutrale Antworten wie bisher).

Bekannte Grenze (seit Phase 16, in Phase 17 analysiert): Für CMS-Routen, die `notFound()`
werfen, liefert Next den Status 404, Titel und `noindex` korrekt im HTML, die 404-Oberfläche
(Überschrift, Links) steht aber im Flight-Payload und wird erst clientseitig gerendert.
Direkte unbekannte URLs (`/gibt-es-nicht`) rendern die 404-Seite vollständig serverseitig.
Für Suchmaschinen ist der Status maßgeblich; eine serverseitig vollständige 404 für CMS-Pfade
bräuchte eine Strukturänderung (eigene Route-Group) – offen in
[OPEN_ITEMS.md](OPEN_ITEMS.md) „Phase 17“.

**API nicht erreichbar:** CMS-Seiten antworten mit 200 und der Zustandsseite „Gleich wieder
da“ – immer `noindex`, ohne Canonical, ohne JSON-LD (kein 503). Ein API-Ausfall erzeugt damit
keine indexierbare Fehlerseite; dass der Status 200 statt 503 ist, steht als Hinweis in
[OPEN_ITEMS.md](OPEN_ITEMS.md) „Phase 17“.

**410** (`lib/legacy-routes.ts`, direkte Antwort des Proxys): echter Status 410 für die in
[REDIRECT_MATRIX.md](REDIRECT_MATRIX.md) gelisteten Alt-Pfade (mit und ohne Schluss-Slash,
jede Schreibweise, nur exakte Pfade – Unterpfade wie `/shop/irgendwas` enden als 404).
Eigenständiges kleines HTML-Dokument im Website-Look (Creme/Bronze-Tokens, Serifen-
Überschrift, `lang="de"`): Überschrift „Diese Seite gibt es nicht mehr.“, Erklärung,
CTA „Slush konfigurieren“ (`/konfigurator`), Navigation „Zur Startseite“ (`/`),
„Slushmaschine mieten“ (`/slushmaschine-mieten`), „Kontakt“ (`/kontakt`);
`<meta name="robots" content="noindex, nofollow">`; Header `Content-Type: text/html;
charset=utf-8`, `Cache-Control: public, max-age=3600`, `X-Robots-Tag: noindex, nofollow`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. Kein Script, keine externen
Ressourcen, keine Adresse, keine Codes, kein „buchen“. Der gemeinsame Seitenrahmen steht in
einer Proxy-Antwort nicht zur Verfügung (CSS Modules/React); ein Rewrite auf eine Seite könnte
den Status 410 nicht setzen – deshalb das eigenständige Dokument (keine Soft-404).

## Legacy-Redirects (Verfahren)

Verbindliche Tabelle je Altpfad (Altpfad, Ergebnis, Ziel, Begründung, Testname):
[REDIRECT_MATRIX.md](REDIRECT_MATRIX.md). Verfahren:

- **Next-Proxy** `apps/web/proxy.ts` (Node-Runtime) mit `skipTrailingSlashRedirect: true` in
  `apps/web/next.config.ts`. Nexts eigener Trailing-Slash-Redirect liefe VOR dem Proxy und
  würde `/uber-uns/` → `/uber-uns` → `/ueber-uns` zur Kette machen. Der Proxy entscheidet
  Legacy-Ziel, 410 und Schluss-Slash in EINEM Hop (`decideLegacyRoute` in
  `lib/legacy-routes.ts`). Keine `redirects()` in `next.config.ts`, kein 301/302-Mix.
- **Status 308** (permanent, Methode bleibt erhalten; für Google gleichwertig zu 301). Matching:
  Pfad klein geschrieben, Schluss-Slashes entfernt ⇒ `/buchung`, `/buchung/`, `/Buchung/`
  treffen dieselbe Regel.
- **Query:** Legacy-Redirects verwerfen die Query vollständig (`/buchung/?next=https://…` ⇒
  `Location: /konfigurator`). Die reine Slash-Normalisierung (`/ablauf/?x=1` ⇒ `/ablauf?x=1`)
  behält die Query, aber nur aus sichtbarem ASCII (Zeilenumbrüche, Leer-, Steuer- und
  unkodierte Nicht-ASCII-Zeichen ⇒ Query entfällt). WordPress-Shortlinks `/?p=<id>` und
  Suchen `/?s=…` werden nicht gemappt (Startseite 200, Canonical `/` ohne Query).
- **Open-Redirect-Schutz:** Nur „sichere“ Pfade werden behandelt (`SAFE_PATH`: Segmente aus
  unreservierten Zeichen, höchstens ein Schluss-Slash; `//`, `\`, `%`, `:`, `?`, `#`
  ⇒ keine Entscheidung). Jede Location beginnt mit genau einem `/` und stammt ausschließlich
  aus der Entscheidungstabelle; der Proxy löst sie gegen die EIGENE Server-URL
  (`request.nextUrl`, nicht Host-/Forwarded-Header) auf, prüft, dass der Origin unverändert
  ist, und Next relativiert sie wieder – der Client erhält `Location: /ziel`. Nexts eigene
  Normalisierung von Mehrfach-Slashes/Backslashes läuft vor dem Proxy (308 auf den
  bereinigten Pfad, relativ); `//evil.com/` wird so zu `/evil.com/` (kein Host-Wechsel).
  Akzeptierte Ausnahme (Review RB-3): Pfade mit Mehrfach-Slash (`//uber-uns/`, `/buchung//`)
  durchlaufen dadurch zwei Hops (Next-Normalisierung, dann Proxy) – keine echte Alt-URL ist
  betroffen. Prozentkodierte Pfade (`/%73lushmaschine-mieten/`) erhalten keinen
  Proxy-Redirect; Next bedient sie dekodiert als die jeweilige Seite mit korrektem Canonical
  (Review RB-4).
- **Absolute-form Request-Targets** (`GET http://evil.example/buchung/ HTTP/1.1`, Review RB-5,
  Next-Core): Next beantwortet sie selbst mit 308 auf die fremde absolute URL. Browser senden
  nie absolute-form; der Reverse-Proxy (nginx) steht vor Next und normalisiert auf origin-form
  – Go-live-Smoke mit `curl --request-target` in
  [PRE_START_CHECKLIST.md](PRE_START_CHECKLIST.md).
- **Cache-Control:** Legacy-Tabellen-Redirects `public, max-age=3600` (öffentliche, rein
  URL-abhängige Alt-URLs); Slash-Normalisierungen `private, no-store` – sie treffen auch
  Token-/Portal-/Vorschau-Pfade (`/angebot/<token>/`, `/konto/…/`), deren Location sonst eine
  Stunde in geteilten Caches läge (Review RD-2/RB-2; Unit SEO-R-U14, E2E SEO-R1/R3). Der
  Portal-`X-Robots-Tag` bleibt auf `/konto/…`-Antworten erhalten.
- **Matcher:** alles außer `/api/…` (Rewrite zur API), `/_next/…`, exakt `favicon.ico`,
  `robots.txt`, `sitemap.xml`. Die Alt-Sitemaps (`/sitemap_index.xml` ⇒ 308 `/sitemap.xml`,
  Rank-Math-Unter-Sitemaps ⇒ 410) bleiben absichtlich im Matcher. Dateien aus
  `apps/web/public/` (z. B. das Google-Maps-Logo) werden unverändert durchgereicht.
- **Kein Logging im Proxy** (Pfade können Token enthalten).
- **Rollback:** Die Listen `LEGACY_REDIRECTS`/`LEGACY_GONE` in `lib/legacy-routes.ts` sind die
  einzige Quelle; ein Eintrag lässt sich entfernen oder umhängen, danach die Tabelle in
  [REDIRECT_MATRIX.md](REDIRECT_MATRIX.md) anpassen (Konsistenztest `redirect-matrix.test.ts`
  schlägt sonst an) und das Web neu bauen. Bis zur DNS-Umschaltung bleibt die bisherige Website
  unverändert online; die Redirects wirken nur auf der neuen Instanz.

## Kanonischer Host (www)

Kanonischer Host der neuen Website ist `www.miet-royal.de` (Auftrag §8,
[ARCHITECTURE.md](ARCHITECTURE.md) „Domains“); die bisherige Website leitete umgekehrt `www.`
→ Apex. Der Host-Redirect Apex `miet-royal.de` → `https://www.miet-royal.de$request_uri`
(308) und HTTP → HTTPS liegen ausschließlich in der Reverse-Proxy-Konfiguration
([DEPLOYMENT_NOTES.md](DEPLOYMENT_NOTES.md) „Website SEO, Redirects, kanonischer Host
(Phase 17)“, nginx-Beispiel). Der Anwendungscode enthält keinen Hostnamen und kein
Host-Header-Verhalten: Das Web bedient jede eingehende Anfrage gleich und bildet absolute URLs
nur aus `MAIL_PUBLIC_WEB_BASE_URL` (`https://www.miet-royal.de`). Die Entscheidung ist per
Konfiguration umkehrbar. Da DNS/Proxy erst beim Go-live umgeschaltet werden, ist der
Host-Redirect ein Go-live-Smoke ([PRE_START_CHECKLIST.md](PRE_START_CHECKLIST.md),
Testname SEO-R9), kein Phase-17-Test gegen die Live-Domain.

## SEO-Check im Staff (nur Hinweise, nie blockierend)

`GET /staff/cms/seo-check` (Recht `cms.edit` ODER `cms.publish`, `Cache-Control: no-store`,
kein Audit) liefert `{ checkedAt, warnings: SeoWarning[] }` mit
`SeoWarning { code, scope: 'published' | 'draft' | 'catalog', entryId, path, field, message }`.
Kernfunktion `computeSeoWarnings` (`apps/api/src/cms/seo-check.ts`, reine Funktion ohne
Datenbank). Geltungsbereiche: `published` = veröffentlichte Revision; `draft` = aktueller
Entwurf nur, wenn er vom veröffentlichten Stand abweicht oder nie veröffentlicht wurde (keine
doppelten Hinweise); `catalog` = Produktdaten der öffentlichen Projektion. Reihenfolge
deterministisch: veröffentlicht, Entwurf, Katalog; darin Pfad, Code, Meldung. Die Meldungen
sind deutsch, nennen nie einen Code und nie einen Preis.

| Code | Bedeutung (Schwellen) |
| --- | --- |
| `META_TITLE_MISSING` | Meta-Titel fehlt (Entwurf: ohne Meta-Titel ist kein Veröffentlichen möglich; veröffentlicht nur bei direkt gespeicherten Daten) |
| `META_TITLE_SHORT` | Meta-Titel sehr kurz (< 20 Zeichen) |
| `META_TITLE_LONG` | Meta-Titel sehr lang (> 60 Zeichen; Suchmaschinen kürzen) |
| `META_DESCRIPTION_MISSING` | Meta-Beschreibung fehlt |
| `META_DESCRIPTION_SHORT` | Meta-Beschreibung sehr kurz (< 50 Zeichen) |
| `META_DESCRIPTION_LONG` | Meta-Beschreibung sehr lang (> 160 Zeichen) |
| `META_TITLE_DUPLICATE` | exakt gleicher Meta-Titel auf mehreren Seiten (Vergleich NFKC, getrimmt, klein, Leerraum zusammengefasst; veröffentlichte Seiten und Entwürfe getrennt; Meldung nennt alle Pfade) |
| `META_DESCRIPTION_DUPLICATE` | exakt gleiche Meta-Beschreibung auf mehreren Seiten (wie oben) |
| `PAGE_EMPTY` | Seite ohne Blöcke bzw. ohne eigenen Text (nur Bilder/automatisch befüllte Bausteine) |
| `BROKEN_INTERNAL_LINK` | interner Link auf eine CMS-Seite, die die Website nicht ausliefert – nicht veröffentlicht, ungültiger gespeicherter Inhalt oder fail-closed wegen der exakten Abholadresse (App-Pfade `/`, `/konfigurator`, `/konto/…` gelten als vorhanden); die Website blendet solche Links aus, bis die Zielseite ausgeliefert wird |
| `REGION_NEAR_DUPLICATE` | zwei Regionsseiten mit nahezu identischem Text: Jaccard-Ähnlichkeit der Wort-3-Gramme über Titel + redaktionelle Blocktexte ≥ 0,6; ab 30 Trigrammen der kleineren Seite zusätzlich Containment (Anteil der kleineren Menge in der größeren) ≥ 0,6, damit auch Teilkopien („Ortsnamen-Tausch + ein Block entfernt“) erkannt werden |
| `PAGE_SUPPRESSED` | veröffentlichte Seite, die die Website fail-closed nicht ausliefert, weil Titel oder Meta-Titel die exakte Abholadresse enthalten |
| `PRODUCT_DESCRIPTION_PRICE_HIDDEN` | Produktbeschreibung enthält eine Preisangabe – die Website blendet die Beschreibung aus (Preis-Guard) |
| `PRODUCT_NAME_PRICE_HIDDEN` | Produktname enthält eine Preisangabe – das Produkt erscheint nicht auf der Website (Preis-Guard) |
| `PRODUCT_UNIT_PRICE_HIDDEN` | Verkaufseinheit (`saleUnit`, öffentlich `unitLabel`) enthält eine Preisangabe – das Produkt erscheint nicht auf der Website (Preis-Guard) |

Staff-Darstellung (`SeoWarningsBox`): Übersicht `/website` zeigt den Kasten „Hinweise zur
Suchmaschinen-Darstellung“ (`data-testid="cms-seo-warnings"`, je Zeile `cms-seo-warning` mit
`data-code`/`data-scope`/`data-entry-id`) mit dem Satz „Das sind Hinweise für die Redaktion –
nichts wird blockiert.“, dazu je Eintrag die Zählzeile `cms-entry-seo-count`; Katalog-Hinweise verlinken „Produkte &
Preise öffnen“ auf die Produktverwaltung `/produkte` (nur mit `product.view`); der Editor zeigt
unter den Meta-Feldern „Hinweise zu Titel, Beschreibung und Inhalt“ (`cms-seo-entry-warnings`)
und lädt sie nach Speichern, Veröffentlichen, Zurückziehen und „Als neuen Entwurf übernehmen“
neu. Geltungsbereich als Text („Veröffentlicht“, „Entwurf“, „Produkte & Preise“). Schlägt der
Abruf fehl (Recht, offline, Fehler), fehlt der Kasten still. Kein Score, keine Sperre, keine
automatische Umschreibung – die Redaktion entscheidet.

## Preis-Guard der öffentlichen Produktprojektion (Auftrag §23)

`projectProduct` in `apps/api/src/public/catalog.ts` ist die einzige öffentliche
Produkt-/Preisprojektion (Katalog `/public/configurator/catalog`, Blöcke `product_grid` und
`included_items`, Konfigurator, Empfehlung, Staff-Lesesicht `/staff/cms/catalog`). Nach dem
bestehenden Adress-Guard gilt fail-closed:

- Enthält die Produkt**beschreibung** einen Preis-Freitext (`containsPriceText`, z. B. „60 €“,
  „EUR 60“, „60,-“), wird sie öffentlich `null`; `priceCents` bleibt der wirksame Preis aus
  `product_prices`.
- Enthält der Produkt**name** oder die **Verkaufseinheit** (`saleUnit`, öffentlich `unitLabel`)
  einen Preis-Freitext, entfällt das Produkt öffentlich ganz (im Konfigurator nicht wählbar ⇒
  `MACHINE_UNAVAILABLE`, nicht im Inklusiv-Pack, nie empfohlen, nicht in der Website-Anfrage) –
  dieselbe Regel wie beim Adress-Guard, der seit dem Review ebenfalls die Verkaufseinheit prüft.
- Als Preisangabe gelten auch Cent-Beträge („50 Cent“, „0,50 Cent je Becher“, „50 ct“); nicht
  „5 Prozent“, „40 cm“, „12,5 kg“ (`containsPriceText`, `packages/validation/src/cms.ts`).
- Log `public.catalog.price_text_suppressed` nur mit `productSlug` und `field` (`name`,
  `description`, `saleUnit`), nie dem Text. Interne
  Produktdaten (`GET /staff/products`, `ProductService`) bleiben unverändert; der SEO-Check
  meldet den Fall der Redaktion (`PRODUCT_*_PRICE_HIDDEN`).

Damit bleibt die Phase-16-Regel „eine Preisquelle“ auch gegenüber stale Freitexten belastbar:
Preise auf der Website kommen ausschließlich aus `products`/`product_prices`.

## Konfigurator (Auftrag §22)

- `/konfigurator?maschine=<slug>` wählt die Maschine vor, wenn der Slug im Katalog existiert;
  unbekannte Slugs werden ignoriert (kein Fehler, kein eigener URL-Zustand).
- Canonical immer `${base}/konfigurator` (Query entfällt); indexierbar nur im indexierbaren
  Kontext UND wenn technisch nutzbar (Katalog erreichbar, ≥ 1 Maschine, `/datenschutz`
  veröffentlicht, keine Origin-Sperre) – dieselben Kriterien wie für die Sitemap. Ohne
  veröffentlichte Datenschutzhinweise ist Absenden gesperrt und die Seite `noindex`.
- Fester Titel „Slush konfigurieren – Miet-Royal“ und feste Beschreibung; keine
  Preisberechnung im Browser (Server-Vorschau, Phase 16). Der bestehende ehrliche Hinweis ohne
  JavaScript bleibt.

## Interne Links

Der Web-Renderer blendet interne Links auf nicht veröffentlichte CMS-Seiten aus
(`resolveSiteHref`, `lib/site-nav.ts`); Navigation, Fußzeile, `service_areas` und
`secondary_offers` verlinken nur veröffentlichte Seiten. Der SEO-Check meldet solche Links
der Redaktion (`BROKEN_INTERNAL_LINK`). Die E2E-Linkprüfung (Spec `seo-links`) folgt allen
internen Links der veröffentlichten Testseiten und der Sitemap: Status 200, kein 404/410,
kein Entwurf, keine Token-Platzhalter, keine exakte Abholadresse, keine `http://`-Links,
keine leeren `tel:`-/Instagram-Links, CTA-Texte „Slush konfigurieren“/„Unverbindlich anfragen“
statt „buchen“.

## Testabdeckung

Testnamen tragen das Präfix `SEO-` (Kollisionsfrei zu den Phase-15/16-Kürzeln). Zuordnung
und Lauf-Kommandos: [TEST_PLAN.md](TEST_PLAN.md) „SEO, Redirects, technische QA (Phase 17)“.

| Ebene | Datei | Tests |
| --- | --- | --- |
| Web-Unit (`pnpm --filter @mietroyal/web test`) | `apps/web/lib/site-seo.test.ts`, `site-jsonld.test.ts`, `site-meta.test.ts`, `site-nav.test.ts`, `site-api.test.ts` | SEO-W1–W18 (Basis-Prüfung inkl. production-Regel für http-Basen, Indexierbarkeits-Matrix, Canonical, Konfigurator-Kriterien, Social Image, Metadaten, robots beider Zustände, Sitemap, JSON-LD, Serialisierung, 404-Metadaten, `seoEnvFrom`, Brotkrume, Bootstrap-Form) |
| Web-Unit | `apps/web/lib/legacy-routes.test.ts`, `redirect-matrix.test.ts`, `next-config.test.ts` | SEO-R-U1–U14 (Entscheidungstabelle, Query, Open Redirect, 410-HTML/-Header, Proxy-Quelltext, Cache-Header je Entscheidung), SEO-R-D1–D5 (Doku ↔ Code), SEO-W-H6 (`skipTrailingSlashRedirect`) |
| Web-Unit | `apps/web/lib/site-css.test.ts` | SEO-W-CSS1–CSS3 (`.listValue` ohne `white-space: nowrap`; Brotkrumen-Einträge ≥ 44 px und umbrechend; Konfigurator-Raster `minmax(0, 1fr)`) |
| Web-Unit | `apps/web/lib/reviews.test.ts` | SEO-W-REV1–REV3 (Google-Maps-Logo-Attribution, Asset unverändert, Proxy lässt den Logo-Pfad in Ruhe) |
| API-Unit (`cd apps/api && pnpm vitest run test/seo-check.test.ts`) | `apps/api/test/seo-check.test.ts` | SEO-U1–U14 (inkl. Verkaufseinheit, ungültiger Inhalt ⇒ kaputte Links, `PAGE_SUPPRESSED`) |
| API-Integration | `apps/api/test/cms-seo-check.integration.test.ts`, `cms-public-site.integration.test.ts`, `public-configurator.integration.test.ts`, `public-inquiry.integration.test.ts` | SEO-API1–API9 (Rechte, Duplikate, Entwurf, Links, Produkte, Standardinhalte, keine Interna, Bootstrap-Felder, nachträglich gepflegte Adresse), SEO-P1–P8 (Preis-Guard inkl. Verkaufseinheit und Website-Anfrage) |
| E2E gegen den Production-Build (Projekt `seo`, `tests/e2e/playwright.config.ts`) | `tests/e2e/specs/seo-redirects.spec.ts`, `seo-metadata.spec.ts`, `seo-links.spec.ts`, `seo-a11y.spec.ts` | SEO-R1–R9 plus Durchreichung (Redirects/410/404; API-Rewrite, Assets, Favicon unberührt), SEO-C1–C4 und C7 (Canonicals; C5 Demo in `website-demo.spec.ts`, C6 Indexierung aus siehe unten), SEO-M1–M6 plus Favicon (Metadaten), SEO-S1–S7 (Sitemap), SEO-SD1–SD8 (strukturierte Daten), SEO-L1–L8 (interne Links, Brotkrume, CTA-Texte), SEO-A1–A12 (Viewports, Tastatur-Navigation und -Konfigurator, Fehlerzuordnung, Skip-Link, reduced-motion, Zoom 200 %, axe-Scan SEO-A8, Alt-Texte, Landmarken, `lang`) |
| E2E dev-Web (Projekt `chromium`) | `tests/e2e/specs/website-seo-disabled.spec.ts` | SEO-C6 (Indexierung aus: robots crawlbar ohne Sitemap-Zeile, kein Canonical, `noindex`, leere Sitemap; Redirects/410 unabhängig vom Schalter) |
| E2E Demo-Web (Projekt `demo-communication`) | `tests/e2e/specs/website-demo.spec.ts` | SEO-C5 (Demo nie indexierbar trotz gültiger Basis) |
| E2E Staff (Projekt `chromium`) | `tests/e2e/specs/website-cms.spec.ts` | SEO-ST1 (SEO-Hinweise in Editor und Übersicht erscheinen und verschwinden mit dem Meta-Titel) |

Das Projekt `seo` baut das Web als Production-Build mit `WEB_INDEXING_ENABLED=true` gegen die
Haupt-API der E2E-Suite; die API ist mit `MAIL_PUBLIC_WEB_BASE_URL=http://127.0.0.1:3100`
konfiguriert, der Production-Build läuft auf einem anderen Port. Canonicals zeigen deshalb auf
die konfigurierte Basis (Port 3100), nicht auf den Request-Host – genau das belegt „keine
Host-Ableitung“ (SEO-C1/C7).

## Betrieb und Go-live

- **Jetzt (Phase 17):** `WEB_INDEXING_ENABLED` bleibt überall ungesetzt bzw. nicht `true`;
  Staging und Demo bleiben crawlbar (`Allow: /`, keine Sitemap-Zeile), jede Antwort trägt
  `noindex`; die Demo-Instanz ist unabhängig vom Schalter `noindex`. Die bisherige Website bleibt unverändert
  online; keine DNS-Umschaltung.
- **Go-live der Website:** Reverse-Proxy mit Host-Redirect Apex → `www` (308) und HTTP →
  HTTPS; Web-Server mit `MAIL_PUBLIC_WEB_BASE_URL=https://www.miet-royal.de` (API-Prozess) und
  erst dann `WEB_INDEXING_ENABLED=true` (Web-Prozess); Smokes aus
  [PRE_START_CHECKLIST.md](PRE_START_CHECKLIST.md) „Website-Go-live SEO“ und
  [DEPLOYMENT_NOTES.md](DEPLOYMENT_NOTES.md) „6d SEO-Smoke“ (robots.txt, sitemap.xml,
  Alt-URL-Stichprobe, Host-Redirect, Rich-Results-Test).
- **Nicht Teil von Phase 17 (Auftrag §35):** DNS-Umschaltung, WordPress-Abschaltung,
  Search-Console-Verifikation und -Einreichung der Sitemap, Rich-Results-Test gegen die
  Live-Domain, Ranking-Monitoring, Google Analytics/Tracking/Consent-Manager, Google Ads,
  Content-Kampagnen, automatisches Veröffentlichen von Regionsseiten, juristische Freigabe der
  Rechtstexte. Offene Punkte: [OPEN_ITEMS.md](OPEN_ITEMS.md) „Phase 17“.
