# PRE_START_CHECKLIST — Noch nicht alles sofort nötig

## Für Phase 0
Benötigt:
- Rechner für lokale Entwicklung
- Git
- aktuelle Node.js-LTS-Version
- pnpm oder durch Phase-0-Setup definierter Package Manager
- Docker Desktop / Docker Engine, falls Phase 0 dies verwendet
- Claude Code
- leeres Projektverzeichnis
- dieses Spezifikationspaket

Nicht benötigt:
- Lexware API
- WhatsApp Zugang
- finale Bilder
- neue Website-Domain
- echte Kundendaten

## Für spätere Phasen
Die jeweils benötigten Zugangsdaten/Stammdaten stehen in `OPEN_ITEMS.md`.

## Staging/Production (ab Phase 8)
- `STAFF_OFFLINE_LEASE_VERIFICATION_KEY` beim Staff-Server gesetzt (Pflicht,
  fail-closed; Wert aus `pnpm offline:lease-key` der API-Umgebung; kein
  Secret, aber nie ins Repository committen).

## Production mit Buchhaltung (ab Phase 10)
- Lexware-Office-Account mit Public-API-Zugang; API-Key mit den in
  `docs/LEXWARE_API_NOTES.md` genannten Berechtigungen (nur serverseitig auf
  API und Worker: `LEXWARE_API_KEY`, `LEXWARE_ORGANIZATION_ID`,
  `LEXWARE_WEBHOOK_CALLBACK_URL`).
- Öffentliche HTTPS-Adresse der API für Webhooks (`/webhooks/lexware`) mit
  gültigem Zertifikat.
- Steuerkonfiguration (Steuerart und Satz je Abrechnungskategorie) mit
  Buchhaltung/Steuerberatung abgestimmt – ohne sie blockiert production jede
  Rechnung (bewusst, nichts wird erfunden).
- Entscheidung zur Lexware-Abbildung von Anzahlungen/Kautionen (Public API
  bietet keine Abschlagsrechnungen) – bis dahin werden solche Abrechnungen
  blockiert.
- Für demo: KEIN Lexware-Key (Demo bucht nie in Lexware).
- Verbindliche Go-Live-Blocker Buchhaltung (Preisbasis brutto/netto,
  Steuerbehandlung je Kategorie, Anzahlung, angewendete Kaution, manueller
  Testaccount-Smoke): siehe `docs/OPEN_ITEMS.md` → „GO-LIVE-BLOCKER
  Buchhaltung“.

## Production mit Routing/GraphHopper (ab Phase 13)
- **GO-LIVE-BLOCKER Routing (vertraglich, Phase 13 Final §5):** Vor dem
  Setzen eines `GRAPHHOPPER_API_KEY` in production mit GraphHopper (Vertrag/
  Paket, ggf. Custom-Vertrag) klären, ob die implementierte serverseitige
  Zwischenspeicherung erlaubt ist: `geocoding_cache` mit Kandidaten,
  Koordinaten und OSM-Referenzen (TTL 90 Tage resolved / 30 Tage review bzw.
  kein Treffer) sowie die persistierten minimalen Distanz-/Fahrzeitwerte je
  Tour/Stopp. Die ToS regeln ausdrücklich nur temporäres clientseitiges
  Caching; eine dauerhafte serverseitige Speicherung ist nicht ausdrücklich
  geregelt (`docs/ROUTING_API_NOTES.md`). Ergebnis negativ ⇒ Caching/
  Persistenz vor dem Go-live reduzieren/umbauen, nicht den Schalter setzen.
- Erst nach positiver Prüfung `ROUTING_PROVIDER_TERMS_CONFIRMED=true` bei API
  und Worker setzen (kein Secret, kein Default) – ohne diesen Wert startet
  production mit gesetztem Key nicht (fail-closed, Konfigurationsfehler).
  Alternative bis zur Klärung: `ROUTING_PROVIDER=disabled` (Touren
  organisatorisch nutzbar, keine Routen/Prognosen).
- Bezahlter GraphHopper-Plan (Basic oder höher) und Kontoinhaber; Key nur als
  Secret der Produktionsumgebung (`GRAPHHOPPER_API_KEY`), nie im Repo; ein
  Key gilt nur in einer Umgebung (Isolationsprüfung).
- Verzeichnis der Verarbeitungstätigkeiten um GraphHopper (Request-Retention
  bis 5 Wochen, Subprozessoren Geocoding) ergänzen; Depotadresse
  (`pickup_exact_address`) vollständig hinterlegen.

## Production mit Kundenportal (ab Phase 15)
- `MAIL_ENABLED=true` mit SMTP und `MAIL_PUBLIC_WEB_BASE_URL` (https, Web-App
  derselben Umgebung): Sie ist zugleich die Portal-Basis aller Anmelde-/
  Bestätigungslinks (`/konto/...`) – ohne Mailversand kann sich kein Kunde
  anmelden (Magic Link ausschließlich per E-Mail).
- Telefonnummer von Miet-Royal für den Anruf-Button festlegen
  (`COMPANY_PHONE_NUMBER`, kein Secret, nur Ziffern, optional führendes `+`,
  Leerzeichen, `-`, `/`, Klammern); ohne Wert zeigt das Portal keinen Anruf-
  Button. Nichts erfinden.
- Ziel-URL für „Neue Anfrage starten“ festlegen (`PORTAL_NEW_INQUIRY_URL`,
  absolute URL, in production nur https) – Stand Phase 15 gab es keine
  öffentliche Anfrage-Route (seit Phase 16: Konfigurator `/konfigurator` der
  neuen Website, siehe unten); ohne Wert fehlt Kunden ohne aktuelle Buchung die
  Hauptaktion (neutraler Hinweis statt Link).
- Beide Variablen nur mit Wert setzen oder ganz weglassen: ein leerer oder
  ungültiger Wert bricht den Start ab (Konfigurationsfehler). Produktivwerte:
  docs/OPEN_ITEMS.md „Phase 15“.
- Kanonische Abholadresse `pickup_exact_address` (Einstellungen) vollständig
  gepflegt: Das Portal zeigt bei bestätigter Selbstabholung ausschließlich diese
  Adresse und den Navigationslink; ungepflegt ⇒ keine Adresse, kein Link.
- Web und API unter demselben Origin (Web-Rewrite `/api/*`, `WEB_API_ORIGIN`),
  TLS vor den Prozessen terminiert; Reverse-Proxy reicht
  `__Host-mr_customer_session` unverändert durch und loggt `/konto/*` sowie
  `/api/portal/*` ohne Body/Cookies (docs/DEPLOYMENT_NOTES.md „Kundenportal“).
- Client-IP hinter Proxy (Phase 15, Review R4): `API_TRUST_PROXY_HOPS=1` bei der
  API; der vorgeschaltete Proxy (z. B. nginx) hängt die echte Client-IP an
  `X-Forwarded-For` an (`proxy_set_header X-Forwarded-For
  $proxy_add_x_forwarded_for;`); Web-Next, Staff-Next und API sind NIE direkt
  aus dem Internet erreichbar (Ports nur auf localhost/internem Netz). Der
  Next-Rewrite hängt selbst nichts an und zählt nicht als Hop; nur ein weiterer
  Proxy, der selbst einen Eintrag anhängt (z. B. Load-Balancer vor nginx),
  erhöht den Wert (docs/DEPLOYMENT_NOTES.md „Öffentliche Token-Links hinter
  Proxy“).
- Body-Limit des vorgeschalteten Proxys für `/api/portal/` mindestens 13 MiB
  (nginx `client_max_body_size 13m;`, Default 1 MiB) – passend zum Rewrite-
  Puffer der Web-App (13 MiB) und zum API-Limit der Portal-Nachrichten (12 MiB);
  sonst scheitern Foto-Nachrichten (Review R3).
- Demo-Deployment: `MAIL_DEMO_WHITELIST` mit Sink-Domain und Mail-Senke – sonst
  ist in der Demo keine Portal-Anmeldung möglich (Mails bleiben `blocked`).
- Kein neues Secret, keine neue Instanz; Migration 0032 angewendet
  (`pnpm db:migrate`); `pnpm check:env-isolation` vor dem Release wie bisher.

## Production mit neuer Website (ab Phase 16)
Die neue Website ist bis zum Website-Go-live (DNS-/Domain-Umschaltung, nicht
Teil von Phase 16) nicht öffentlich live; die bisherige Website bleibt online.
Vor einer Live-Veröffentlichung der neuen Website:

- **Migration und Bootstrap:** Migration 0033 angewendet (`pnpm db:migrate`);
  danach BEWUSST einmal `pnpm cms:bootstrap` mit der Konfiguration der
  Zielumgebung ausführen (legt nur fehlende Entwürfe an, überschreibt nichts,
  veröffentlicht nichts). Nie automatisch; `--publish-demo` nie in
  production/staging (bricht dort ab).
- **Kontaktwerte bestätigen:** Telefon und E-Mail in Website → Website-
  Einstellungen sind Entwürfe aus der bisherigen Website – bestätigen bzw.
  korrigieren; Instagram-Link nur mit bestätigter URL; Logo nur mit geklärten
  Rechten. Über-uns-Fakten und Einsatzgebiete vom Inhaber bestätigen lassen.
- **Impressum:** Platzhalter „Anschrift: [vor Veröffentlichung eintragen]“
  durch die ladungsfähige Anschrift ersetzen, Inhaberbezeichnung/Rechtsform und
  ggf. USt-IdNr./Steuernummer klären, Text juristisch prüfen lassen – erst dann
  veröffentlichen. Die exakte Abholadresse darf in keinem CMS-Text stehen (das
  CMS lehnt sie ab, sobald `pickup_exact_address` gepflegt ist).
- **Datenschutzhinweise:** juristisch an die neue Website anpassen
  (Konfigurator/Website-Anfrage, Kundenbereich, technisch nötige Cookies,
  Google-Bewertungen per Klick, Instagram-Link, Mailversand, Hoster/Logs,
  Aufsichtsbehörde, Stand) und erst DANACH veröffentlichen. Die Veröffentlichung
  von `/datenschutz` schaltet die Website-Anfragen frei (vorher fail-closed:
  Absenden gesperrt, API 409 `PRIVACY_NOT_PUBLISHED`); Rechtstexte lassen sich
  nicht zurückziehen, nur durch neue Revisionen ersetzen.
- **Website-Inhalte im Staff veröffentlichen:** Website-Einstellungen,
  Startseite, Slush, Ablauf, FAQ, Über uns, Kontakt, Impressum, Datenschutz
  jeweils prüfen (Vorschau) und bewusst mit `cms.publish` veröffentlichen;
  Regionsseiten erst nach lokaler Prüfung; Popcorn/Waffel erst mit echten
  Geschäftsdaten. Rollen: `cms.edit` für Redaktion, `cms.publish` für die
  Freigabe.
- **Google-Bewertungen:** alle Punkte aus docs/GOOGLE_REVIEWS_API_NOTES.md
  „Go-live“ (u. a. EWR-Nutzungszweck klären, Key je Umgebung mit API- und
  IP-Restriction, Place ID, Tages-Quota + Budget-Alerts, Datenschutzerklärung,
  Attribution-Abnahme, Staging-Smoke mit echtem Key). Bis dahin
  `REVIEWS_PROVIDER=disabled` (Default; die Website blendet die Sektion aus).
  Erst danach `GOOGLE_REVIEWS_TERMS_CONFIRMED=true` + `REVIEWS_PROVIDER=google`
  (Key nur beim API-Prozess). Demo: nie Google, höchstens `fake`.
- **Indexierung:** `WEB_INDEXING_ENABLED` erst mit Phase 17 bzw. zum Go-live
  setzen (vorher überall `noindex`); Redirects, Sitemap, Robots, Canonicals und
  strukturierte Daten sind Phase 17.
- **CMS-Vorschau:** `MAIL_PUBLIC_WEB_BASE_URL` je Umgebung auf die Web-App
  DERSELBEN Umgebung (sonst „Vorschau öffnen“ 409).
- **Web je Umgebung bauen:** jede Web-Instanz mit ihrem eigenen
  `WEB_API_ORIGIN` bauen und mit demselben Wert starten (sonst sind
  Konfigurator-Absenden und Vorschau gesperrt und die Bewertungs-Sektion fehlt;
  Serverlog prüfen).
- **Proxy:** Body-Limit vor der Staff-App für `/api/staff/cms/media`
  mindestens 9 MiB (Medien-Upload); kein Proxy-/CDN-Cache auf
  `/api/public/reviews`, `/api/public/cms/preview*` und `/vorschau*`;
  `API_TRUST_PROXY_HOPS` korrekt (IP-Limits der Website-Anfrage) –
  docs/DEPLOYMENT_NOTES.md „Website, CMS, Konfigurator, Bewertungen (Phase 16)“.
- **Kanonische Abholadresse** `pickup_exact_address` gepflegt (aktiviert den
  Adressschutz im CMS); öffentlich erscheint nur `pickup_public_area`
  („Mainz-Hechtsheim“).
- `pnpm check:env-isolation` vor dem Release wie bisher (prüft zusätzlich den
  Places-API-Key).

## Sicherheitsregel
Echte Zugangsdaten nie in Chat-Prompts oder Git-Dateien kopieren, wenn sie als
Secrets/Environment-Variablen auf dem Zielsystem gesetzt werden können.
