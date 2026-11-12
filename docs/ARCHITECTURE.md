# ARCHITECTURE — Technische Zielarchitektur

## Baseline
Bei Projektstart aktuelle stabile Produktionsversionen auswählen und pinnen.

Empfohlen:
- pnpm Workspace / Monorepo
- Next.js + React + TypeScript für Web
- Next.js/React PWA für Staff
- TypeScript API-Service
- PostgreSQL
- etabliertes TS-ORM, in Phase 0 auswählen und danach nicht spontan wechseln
- Zod oder gleichwertig
- Vitest + Playwright oder gleichwertig
- privater S3-kompatibler Object Storage
- PostgreSQL-basierte Jobqueue als schlanker Start
- Docker/Compose, wenn Deploymentziel passt

## Struktur
```text
miet-royal/
├── apps/
│   ├── web/
│   ├── staff/
│   ├── api/
│   └── worker/
├── packages/
│   ├── database/
│   ├── domain/
│   ├── permissions/
│   ├── documents/
│   ├── integrations/
│   ├── ui/
│   ├── validation/
│   └── config/
├── docs/
├── migrations/
├── tests/
└── CLAUDE.md
```

## Fachmodule
customers, processes, inquiries, offers, bookings, scheduling, machines,
inventory, handover, returns, damages, settlements, cancellations, vouchers,
communications, documents, employees, permissions, training, cms, integrations.

## Umgebungen
Production, Demo, Staging jeweils technisch getrennt.
Demo nicht nur `is_demo=true`, sondern eigene DB/Secrets/Storage-Konfiguration.

## Hosting
Provider-neutral bauen.
Geplante Option: professioneller Linux VPS/Cloud-Server.
STRATO ist möglich, wenn passender VPS/Server die Anforderungen erfüllt.
Bestehendes simples Webhosting nicht als App-Backend voraussetzen.

## Domains
Vorschlag:
- www.miet-royal.de → Website (Phase 17: kanonischer Host; Apex `miet-royal.de`
  ⇒ 308 auf `https://www.miet-royal.de$request_uri` und HTTP ⇒ HTTPS ausschließlich
  im Reverse-Proxy – kein Host-Header-Verhalten im Anwendungscode; absolute
  SEO-URLs nur aus `MAIL_PUBLIC_WEB_BASE_URL`, docs/SEO_TECHNICAL.md)
- app.miet-royal.de → Staff
- demo.miet-royal.de → Demo
- kunden.miet-royal.de oder /konto → Kundenbereich
  (Phase 15 entschieden: `/konto` in der öffentlichen Web-App `apps/web`, kein
  eigenes Frontend-Projekt; Details docs/CUSTOMER_PORTAL.md)

## Auth
Staff: E-Mail+Passwort, optional 2FA, Geräte/Sessions, 15min App-Lock,
Session-Ablauf nach 30 Tagen Inaktivität (keine zusätzliche absolute
Maximaldauer für regelmäßig aktive Sessions), Biometrie als Gerätekomfort.
Customer: Magic Link 15min, 30 Tage Gerätesession.
Phase 15: Kunden-Auth ist vollständig von der Staff-Auth getrennt – eigene
Tabellen (`customer_portal_sessions`, `customer_portal_magic_links`), eigenes
Cookie `__Host-mr_customer_session` (außerhalb development), Präfix `/portal`.
Die Gerätesession läuft ABSOLUT 30 Tage ab Anmeldung (kein Sliding);
Profiländerungen verlangen eine Reauth ≤ 15 min. Web → API ausschließlich über
den Same-Origin-Rewrite `/api/*` der Web-App (kein CORS).

## Storage
Private Object Storage für Fotos/PDFs.
DB speichert Metadaten/Keys.
Autorisierte oder kurzlebig signierte Zugriffe.

## Offline
PWA Service Worker + verschlüsselter lokaler Speicher,
nur definierter 3-Tage-Horizont.
Sync mit Operation-ID, Server-Version und Konflikterkennung.

## Backups
Startwert:
- täglich DB
- Dateien/Storage
- 7 tägliche
- 4 wöchentliche
- mehrere monatliche
- mindestens eine Kopie außerhalb Produktivserver
- Restore-Test

## Deployment
Git-basiert, Migrationen, Staging, Healthchecks, Smoke Tests,
Backup vor kritischem Release, rollbackfähig.

## Security
HTTPS, Firewall, Rate Limits, sichere Sessions, CSRF/XSS/Injection-Schutz,
Object-Level Authorization, sichere Uploads, keine Secrets im Frontend,
Security Headers.

## Datenschutz
Keine GPS-Historie.
Ephemere Vertreter-/Rückgabe-/Liefertelefonnummern nach Abschluss löschen.
Chatfotos bei Abschluss, Chattext nach 12 Monaten.
Rechtliche Dokumente separat nach definierter Aufbewahrung.

## Feature Flags
Einfache interne Flags für neue Module, z. B.
whatsapp_enabled, customer_portal_enabled, offline_returns_enabled.
(Phase 15: das Kundenportal hat kein Feature-Flag – es ist für Kunden optional,
weil der Zugang nur über einen angeforderten Magic Link entsteht.)

## Website, CMS, Konfigurator (Phase 16)
Neue öffentliche Website in `apps/web` mit schlankem internem CMS in API und
Staff-App – kein externes CMS, keine neue Instanz, kein neues Secret (Details:
docs/WEBSITE_CMS.md, docs/WEBSITE_CONFIGURATOR.md, docs/GOOGLE_REVIEWS_API_NOTES.md).

- **API – ein Einhängepunkt:** `apps/api/src/website/module.ts`
  (`registerWebsiteModule`, in `app.ts` registriert) bindet alle neuen Routen:
  - CMS: `apps/api/src/routes/website-cms.ts` (`/staff/cms/*`, `/public/site/*`,
    `/public/cms/*`), Logik `apps/api/src/cms/` (`cms-service.ts`,
    `content-rules.ts` als EINE Stelle aller Prüfregeln, `media-service.ts`,
    `preview-service.ts`, `public-site.ts`, `published-content.ts`,
    `bootstrap.ts` + `bootstrap-content.ts`).
  - Konfigurator/Website-Anfrage: `apps/api/src/routes/public-configurator.ts`
    (`/public/configurator/*`, `/public/inquiries`,
    `/staff/processes/:id/website-submission`), Logik `apps/api/src/public/`
    (`catalog.ts` = einzige öffentliche Produkt-/Preisprojektion,
    `configurator.ts`, `schemas.ts`, `website-inquiry.ts`).
  - Bewertungen: `apps/api/src/routes/public-reviews.ts` (`GET /public/reviews`)
    hinter der Provider-Grenze `ReviewGateway` (`apps/api/src/reviews/`:
    `types.ts`, `factory.ts`, `budget.ts`, `google.ts`, `fake.ts`, `public.ts`,
    `testing/fake-places-server.ts`), Gateway je API-Prozess aus der
    Konfiguration (`createReviewGateway`) mit Laufzeitsperre
    `assertReviewGatewayAllowed` (production/staging nie Fake, demo nie Google).
- **Eine Preisquelle:** Website, Konfigurator, Vorschau und Anfrage nutzen
  ausschließlich `products`/`product_prices` (`effectivePriceCentsAt`, dieselbe
  Regel wie `ProductService.effectivePriceCents`) und die zentrale Preisengine
  `priceOffer` mit dem gemeinsamen Helfer `resolvePricingInput`
  (`packages/domain/src/pricing-input.ts`, auch vom `OfferService` genutzt).
  Inklusiv-/Kontingentkonstanten liegen in `packages/domain/src/pricing.ts`.
  Der Browser rechnet nie Geld.
- **Website-Anfrage in EINER Transaktion:** `WebsiteInquiryService.submit`
  arbeitet nur über den Transaktions-Executor (Pool max = 1 fest):
  Advisory-Lock je `clientMutationId` ⇒ Wiederholungserkennung ⇒ erst dann
  Datums-/Zeitprüfungen (Vergangenheit, Zeitumstellung, Lieferfenster) ⇒
  Datenschutz-Revision ⇒ erneute Auswahlprüfung ⇒ Advisory-Lock je
  normalisierter E-Mail ⇒
  `CustomerService.createCustomerWithin` ⇒ `ProcessService.createProcessWithin(tx,
  null, …)` ⇒ `InquiryService.upsertWithin(tx, null, …)` ⇒ unveränderliche
  `public_inquiry_submissions`-Zeile. Die optionale Portal-Session wird VOR der
  Transaktion ohne Touch gelesen. Die Staff-Pfade delegieren an dieselben
  `…Within`-Methoden (keine duplizierte Fachlogik).
- **Web (`apps/web`):** Server-Komponenten lesen `/public/site/*` und den Katalog
  direkt an `WEB_API_ORIGIN` (`apps/web/lib/site-api.ts`, `cache: 'no-store'`,
  Timeout 2,5 s, je Request per React `cache` dedupliziert) – diese GET-Routen
  haben deshalb kein IP-Limit. Browser-Aufrufe (Vorschau-Übersicht, Anfrage,
  Vorschau-Einlösen, Bewertungen) laufen über den Same-Origin-Rewrite `/api/*`
  mit IP-Limits. Seitenrahmen `components/site/site-frame.tsx` nur auf
  Website-Seiten (nicht auf `/konto`, Token-Seiten, `/vorschau`-Einlösung); EIN
  Block-Renderer (`components/site/block-renderer.tsx`) für öffentliche Seiten
  und CMS-Vorschau; Konfigurator `components/configurator/`. CSS Modules mit
  Tokens unter `.site` – keine globalen Element-Selektoren, Portal und
  Token-Seiten bleiben unberührt. Indexierung bis Phase 17 aus
  (`WEB_INDEXING_ENABLED`). Der beim Build verwendete API-Origin wird als
  `MR_BUILD_API_ORIGIN` eingebacken; weicht `WEB_API_ORIGIN` zur Laufzeit ab,
  bleiben Konfigurator-Absenden und Vorschau gesperrt und die Bewertungs-Sektion
  ausgeblendet („Web je Umgebung bauen“, docs/DEPLOYMENT_NOTES.md).
- **Staff (`apps/staff`):** Bereich `/website` (Übersicht, Editor, Medien,
  „Produkte & Preise“ als Lesesicht) und Kasten „Website-Anfrage“ in der
  Inquiry-Ansicht; Inhaltsschema als Workspace-Paket `@mietroyal/validation/cms`
  (Staff `transpilePackages`). Online-only.
- **Vorschau ohne Session-Transfer:** Staff erzeugt einen kurzlebigen,
  revisionsgebundenen Zugang; das Web löst ihn per POST ein und setzt ein eigenes
  HttpOnly-Cookie (`__Host-mr_cms_preview`) – keine Staff-Session wandert in die
  Web-Origin; jede Umgebung prüft gegen ihre eigene Datenbank.
- **Medien:** über den bestehenden `StorageProvider`, ausschließlich neu
  kodierte WebP-Varianten (`cms-media/<id>/<breite>.webp`), öffentlich nur über
  die opake Medien-ID und nur für veröffentlichte Revisionen.
- **Demo:** CMS-Tabellen überleben den Business-Reset; Website-Anfragen
  (`public_inquiry_submissions`) werden gelöscht. Bewertungen in der Demo nur
  synthetisch (`fake`), nie Google.

## SEO-Schicht und Alt-URLs (Phase 17)
Technische SEO und Website-Migration laufen in den vorhandenen Prozessen (Details:
docs/SEO_TECHNICAL.md, docs/REDIRECT_MATRIX.md, docs/SEO_STRUCTURED_DATA_NOTES.md):

- **Web-Proxy (`apps/web/proxy.ts`):** einziger Ort für Alt-URLs der bisherigen
  WordPress-Website – permanenter Redirect 308 in einem Hop, 410 als eigenständiges
  HTML, Schluss-Slash-Normalisierung; reine Entscheidungsfunktion
  `apps/web/lib/legacy-routes.ts` (Listen `LEGACY_REDIRECTS`, `LEGACY_GONE`),
  `skipTrailingSlashRedirect` in `next.config.ts`. Ziel-URLs stammen nie aus
  Host-/Forwarded-Headern; kein Logging (Token in Pfaden).
- **SEO-Kontext (`apps/web/lib/site-seo.ts`, `site-meta.ts`,
  `components/site/site-data.ts`):** je Request eine fail-closed Entscheidung aus
  `WEB_INDEXING_ENABLED`, Demo-Kennzeichnung, Origin-Vergleich und der von der API
  gelieferten Basis `publicBaseUrl` (= `MAIL_PUBLIC_WEB_BASE_URL`; in production nur
  https). Daraus Metadaten (Canonical, OpenGraph, Twitter, robots), `app/robots.ts`,
  `app/sitemap.ts` und JSON-LD (`lib/site-jsonld.ts`, `components/site/json-ld.tsx`).
  Root-Layout immer noindex; Portal, Vorschau, Token-Seiten, 404/410 und Demo bleiben
  noindex.
- **API:** Bootstrap `GET /public/site/settings` liefert `publicBaseUrl` und je Seite
  `publishedAt`; `GET /staff/cms/seo-check` (`apps/api/src/cms/seo-check.ts`) liefert
  Redaktionshinweise (nie blockierend); die öffentliche Produktprojektion
  (`apps/api/src/public/catalog.ts`) blendet Preis-Freitext in Name, Beschreibung und
  Verkaufseinheit fail-closed aus (eine Preisquelle).
- **Staff:** `SeoWarningsBox` (`apps/staff/components/website.tsx`) in Übersicht und
  Editor des Bereichs „Website“.
- **Reverse-Proxy:** kanonischer Host `www`, Apex-Redirect, HTTP ⇒ HTTPS,
  Normalisierung absolute-form Request-Targets (kein App-Code).
