# DEPLOYMENT_NOTES — Grundlage (Phase 0)

Provider-neutral (ARCHITECTURE.md „Hosting“); Ziel ist ein Linux-VPS oder
vergleichbarer Cloud-Server. Dieses Dokument wächst mit den Phasen; hier steht
nur, was die Foundation bereits festlegt.

## Prozesse

| Prozess | Start                                   | Zweck                                   |
| ------- | --------------------------------------- | ---------------------------------------- |
| API     | `pnpm api` (`apps/api`, tsx)            | HTTP-API inkl. `/health` und `/ready`.   |
| Worker  | `pnpm worker` (`apps/worker`, tsx)      | Verarbeitet die PostgreSQL-Jobqueue.     |
| Web     | `pnpm --filter @mietroyal/web build && … start`   | Öffentliche Website (Next.js).  |
| Staff   | `pnpm --filter @mietroyal/staff build && … start` | Mitarbeiter-App (Next.js).      |

Alle Prozesse werden über einen Prozessmanager (z. B. systemd) mit den
Umgebungsvariablen der jeweiligen Umgebung betrieben (kein `.env`-Autoloading,
siehe TECH_DECISIONS.md).

**Pflichtwert für den Staff-Server in staging/production:**
`STAFF_OFFLINE_LEASE_VERIFICATION_KEY` (öffentlicher Ed25519-Verifikations-
schlüssel der Offline-Lease, kein Secret; Wert per `pnpm offline:lease-key`
in der API-Umgebung ausgeben). Ohne diesen Wert ist der Offlinebetrieb der
Staff-App dort bewusst gesperrt (fail-closed), der Online-Betrieb läuft
normal. Nach jeder Rotation von `AUTH_SECRET_KEY` neu ausgeben und setzen.
Details: ENVIRONMENTS.md „Offline-Lease-Verifikationsschlüssel“.

Worker-Hinweis: Die Jobqueue arbeitet **at-least-once** mit Lease-basierter
Crash-Recovery (Default 5 min, `PostgresJobQueueOptions.leaseMs`). Mehrere
Worker-Instanzen sind sicher (SKIP LOCKED); Job-Handler müssen idempotent
sein, und die Lease muss deutlich über der längsten Job-Laufzeit liegen. API und Worker laufen in
Phase 0 über tsx direkt aus TypeScript; falls später ein kompilierter Build
gewünscht ist, wird das als eigene Entscheidung in TECH_DECISIONS.md ergänzt.

## Release-Ablauf (CLAUDE.md „Deployment“)

1. Implementieren + lokale Tests (`pnpm lint && pnpm typecheck && pnpm test`).
2. Integration/E2E gegen lokale Infrastruktur (`pnpm infra:up`,
   `pnpm test:integration`, `pnpm test:e2e`).
3. Staging deployen, dort abnehmen.
4. **Backup vor kritischem Release** (Datenbank + Storage, siehe
   ARCHITECTURE.md „Backups“).
5. `pnpm check:env-isolation <prod.env> <demo.env>` — Release abbrechen, wenn
   Umgebungen kollidieren.
6. Migrationen anwenden: `pnpm db:migrate` (läuft vor dem App-Start; nur
   versionierte Migrationen, keine manuellen Schemaänderungen).
6a. Staging/Production-Checkliste Offline: `STAFF_OFFLINE_LEASE_VERIFICATION_KEY`
   beim Staff-Server gesetzt und identisch mit `pnpm offline:lease-key` der
   zugehörigen API-Umgebung (Production ≠ Demo); sonst keine Offline-Lease.
6b. Checkliste Web-Instanzen (Phase 14, Review F6): `WEB_APP_ENV` ist bei
   jedem Web-Server außerhalb development **Pflicht** – `demo` für die
   Demo-Web-Instanz, `production`/`staging` sonst – und `WEB_API_ORIGIN` zeigt
   auf die API derselben Umgebung. Fehlt `WEB_APP_ENV`, startet der Server
   trotzdem (kein Ausfall), loggt einmal `WEB_APP_ENV fehlt – …` und zeigt den
   Demo-Banner nur, wenn die konfigurierte API über `GET /health`
   `environment: 'demo'` meldet (docs/ENVIRONMENTS.md). Das Serverlog nach dem
   Start auf diese Meldung prüfen.
7. Prozesse neu starten, dann Smoke Test: `/health` muss 200 liefern,
   `/ready` muss 200 liefern (prüft die Datenbankverbindung).
8. Bei Fehlern: Rollback auf vorherigen Stand + Backup-Restore-Pfad.

Claude Code deployt niemals eigenmächtig auf Produktion.

## Lexware Office (Phase 10)

- Variablen: `LEXWARE_API_KEY` (Pflicht für aktive Anbindung in production,
  sonst bleibt die Buchhaltung „nicht konfiguriert“), `LEXWARE_ORGANIZATION_ID`
  (gepinnt), `LEXWARE_WEBHOOK_CALLBACK_URL` (öffentliche HTTPS-URL der API,
  Pfad `/webhooks/lexware`, Zertifikat „Grade A“), optional
  `LEXWARE_API_KEY_REMINDER_DATE`. In demo darf KEIN Key gesetzt sein; in
  development/staging nur mit `LEXWARE_ENABLED=true`. `LEXWARE_BASE_URL` ist
  in production verboten (fester Host `https://api.lexware.io`).
- Berechtigungen des Keys (Least Privilege, siehe docs/LEXWARE_API_NOTES.md):
  Profil lesen; Kontakte lesen/schreiben; Rechnungen lesen/schreiben;
  Zahlungen lesen; Belegliste lesen; Rechnungsdatei lesen;
  Event-Subscriptions lesen/anlegen/löschen.
- Key-Rotation (spätestens alle 24 Monate, Lexware-Ablauf): neuen Key in der
  Lexware-Key-Verwaltung erzeugen → `LEXWARE_API_KEY` auf API und Worker
  setzen → Prozesse neu starten → `pnpm lexware:setup` ausführen (Lexware
  löscht beim Invalidieren des alten Keys dessen Subscriptions; der Befehl
  legt fehlende Subscriptions idempotent neu an) → in Einstellungen → Lexware
  „Verbindung prüfen“. Keine automatische Rotation; das Ablaufdatum liefert
  Lexware nicht per API – ggf. `LEXWARE_API_KEY_REMINDER_DATE` pflegen.
- Erstinbetriebnahme: Steuerkonfiguration (Einstellungen → Steuern) mit
  Buchhaltung/Steuerberatung festlegen – ohne vollständige Konfiguration
  blockiert production jede Rechnung; `pnpm lexware:setup`; Testlauf mit
  `LEXWARE_SMOKE=1 pnpm lexware:smoke` (liest nur Profil und Subscriptions).
- Betrieb: Webhooks sind der primäre Rückkanal; `pnpm lexware:reconcile`
  bzw. „Zahlungsstatus abgleichen“ nur für Ausnahmefälle (kein Polling).
  Bei 401 (Key ungültig/widerrufen – erkannt über Profilprüfung oder einen
  fehlgeschlagenen Aufruf) zeigt die Adminansicht „Verbindung getrennt“ –
  Key erneuern, Setup wiederholen. `token.revoked` wird nicht abonniert: es
  beschreibt laut Doku einen widerrufenen OAuth-Refresh-Token, Miet-Royal
  nutzt einen API-Key; eine früher selbst angelegte Subscription dieses Typs
  entfernt `pnpm lexware:setup` (nur die eigene, nie fremde).
- Der Rechnungsversand per E-Mail ist NICHT Teil der Public API: Rechnungen
  stehen in Lexware (Deeplink) und tragen in Miet-Royal „Versand ausstehend“
  bis Phase 12 den zentralen Mailadapter liefert.

## Wiedermieter-Gutschein (Phase 11)

- Entstehung läuft automatisch über Jobs auf der PostgreSQL-Queue (Worker
  muss laufen): Zahlungsstatus „bezahlt“ (Webhook/Reconcile/Mock) und
  Reinigungsabschluss der letzten Maschine reihen `voucher.eligibility_check`
  ein. Kein Cron.
- `pnpm voucher:ensure`: idempotenter Backfill für alle übertragenen, als
  bezahlt gemeldeten regulären Abrechnungen ohne Gutschein (z. B. nach
  Worker-Ausfall oder nach dem Rollout). Mehrfaches Ausführen erzeugt keine
  Duplikate; Ausgabe nur Zähler.
- Die verschlüsselte Versandkopie hängt an `AUTH_SECRET_KEY` (HKDF, eigener
  Zweck). Nach einer Rotation sind noch nicht versendete Kopien
  unentschlüsselbar – Phase 12 meldet das als Versandproblem; die
  Einlösbarkeit (Hash) bleibt. Rotation daher möglichst ohne offene
  Zustellungen (`delivery_status = pending`) durchführen.
- Phase 11 versendet nichts; `delivery_status` bleibt `pending`, bis Phase 12
  den Versand übernimmt.

## Healthchecks

- `/health`: Prozess lebt (ohne Abhängigkeiten) – für Prozessmanager/Uptime.
- `/ready`: Datenbank erreichbar – für Load-Balancer/Deploy-Gates.

## Offene Punkte für spätere Phasen

- Konkreter Hoster/VPS (OPEN_ITEMS.md „Hosting“), TLS/Reverse Proxy,
  Firewall, Rate Limits.
- S3-kompatibler Object Storage je Umgebung.
- Rechnungsversand per Miet-Royal-Mailadapter (Phase 12) – bis dahin
  `invoice_delivery_status = pending`.
- Backup-Automatisierung + Restore-Test (ARCHITECTURE.md).
- CI-Pipeline (Lint/Typecheck/Tests auf jedem Push).

## E-Mail-Versand und Kommunikations-Schlüssel (Phase 12, mail)

- Variablen (nur API/Worker, nie Staff/Web): `MAIL_ENABLED` (`true` ⇒ SMTP
  Pflicht: `MAIL_SMTP_HOST`, `MAIL_SMTP_USER`, `MAIL_SMTP_PASSWORD`,
  `MAIL_FROM_ADDRESS`; optional `MAIL_SMTP_PORT` (Default 465 implizit /
  587 STARTTLS), `MAIL_SMTP_SECURE` (`true` = implizites TLS, `false` =
  STARTTLS-Pflicht; Klartext gibt es nicht), `MAIL_FROM_NAME`,
  `MAIL_REPLY_ADDRESS`), `MAIL_IMAP_ENABLED` (`true` ⇒ Eingang aktiv; dann Pflicht `MAIL_IMAP_HOST`, `MAIL_IMAP_USER`, `MAIL_IMAP_PASSWORD`; optional `MAIL_IMAP_PORT` (Default 993/143), `MAIL_IMAP_SECURE`, `MAIL_IMAP_FOLDER` (Default INBOX)), `MAIL_DEMO_WHITELIST`
  (nur demo, Pflicht bei `MAIL_ENABLED=true`; in production abgelehnt),
  `MAIL_PUBLIC_WEB_BASE_URL` (absolute Basis der öffentlichen Web-App für
  Angebots-/Dokument-/Kontaktlinks; production nur HTTPS; in staging/demo/
  production Pflicht bei `MAIL_ENABLED=true` – sonst startet API/Worker nicht
  (Härtung RA-11); nur in development gilt der lokale Default), `COMMUNICATION_PAYLOAD_KEY`
  (≥ 32 Zeichen, Pflicht außerhalb development, je Umgebung EIGEN),
  `COMMUNICATION_PAYLOAD_KEY_PREVIOUS` (nur während einer Rotation).
- production/staging: `MAIL_SMTP_HOST`/`MAIL_IMAP_HOST` dürfen nicht
  localhost sein; Zertifikate werden immer geprüft (keine Option zum
  Abschalten). Ohne `MAIL_ENABLED=true` + vollständige SMTP-Daten bleibt der
  Versand fail-closed deaktiviert: Zustellungen entstehen als `blocked
  MAIL_NOT_CONFIGURED` und lassen sich nach Konfiguration über
  Einstellungen → Kommunikation „erneut senden“.
- Betrieb: Der Worker muss laufen (Job `mail.send`). Status/SMTP-Check/
  Outbox/Resend unter Einstellungen → Kommunikation (`system.settings`).
  `outcome_unknown` (Zustellung unklar: Timeout/Abbruch einer bestehenden
  SMTP-Sitzung ohne Serverantwort, z. B. nach DATA) wird nie automatisch
  wiederholt – Postfach/Provider prüfen und bewusst erneut senden (je
  Zustellung genau ein Resend; der Fachstatus bleibt bis dahin „im Versand“).
- Rotation von `COMMUNICATION_PAYLOAD_KEY`: (1) neuen Wert als
  `COMMUNICATION_PAYLOAD_KEY`, bisherigen als
  `COMMUNICATION_PAYLOAD_KEY_PREVIOUS` setzen, API+Worker neu starten;
  (2) `pnpm communication:rewrap-secrets` ausführen (idempotent, Ausgabe nur
  Zähler); (3) `COMMUNICATION_PAYLOAD_KEY_PREVIOUS` entfernen, neu starten.
  Legacy-Gutscheinkopien aus Phase 11 (AUTH_SECRET_KEY) werden beim Rewrap
  ebenfalls auf v2 gehoben – das Script daher einmal nach dem Phase-12-Rollout
  ausführen, solange `AUTH_SECRET_KEY` unverändert ist. Nicht entschlüsselbare
  Kopien werden nur markiert (`delivery_problem_code =
  DELIVERY_COPY_UNDECRYPTABLE`, Mail: `blocked SECRET_UNDECRYPTABLE`); Codes
  und Hashes ändern sich nie.
- `pnpm mail:smoke`: manueller Live-Smoke (eine Testmail über das konfigurierte
  Gateway) nur mit `MAIL_SMOKE=true MAIL_SMOKE_TO=<Adresse>`, nie in
  production, nie im Quality Gate.

<!-- Phase 12 (Härtung Review A, H8) -->
## Öffentliche Token-Links hinter Proxy (Phase 12, Härtung H8)

- `API_TRUST_PROXY_HOPS` MUSS hinter Web-/Staff-Proxy gesetzt sein: Die
  öffentlichen Rate-Limits (Kontakt-/Aktionslinks, Dokumentlinks,
  Kalender-Feed, Angebotslinks; `publicLimit` je Client-IP) und das
  Login-Limit greifen sonst auf die IP des Proxys – alle Kunden teilen sich
  ein Limit (Sperre für alle) bzw. ein Angreifer wird nicht getrennt
  begrenzt. Wert = Anzahl der vertrauenswürdigen Proxies zwischen Client und
  API, z. B. nginx → Next-Server (`apps/web`/`apps/staff`, Rewrite `/api/*`)
  → API = `2`; nur Next-Server → API = `1`. Alle Wege zur API (Web, Staff,
  ggf. direkt freigegebener Kalender-Feed) müssen dieselbe Hop-Zahl haben;
  nie pauschal vertrauen (X-Forwarded-For wäre fälschbar).
- Reverse-Proxy-Access-Logs (nginx o. Ä. vor Web/Staff/API) müssen die
  Token-Pfade maskieren, denn das Token steht im Pfad: `/kontakt/<token>`,
  `/dokument/<token>`, `/angebot/<token>` und `/api/public/**`
  (z. B. `/api/public/offers/<token>/pdf`, `/api/public/actions/<token>`,
  `/api/public/documents/<token>`, `/api/public/calendar/<token>.ics`). Die
  API selbst maskiert ihre Request-Logs (`maskLoggedPath`); Proxy-Logs
  liegen außerhalb und brauchen eine eigene Regel (z. B. nginx `map` auf
  `$request_uri` ⇒ `…/***`) oder Access-Log für diese Pfade abschalten.

## WhatsApp Graph-API-Version (Phase 12 Finalisierung)

- Default `v26.0` (verifiziert 2026-10-19 auf developers.facebook.com). Bei
  jedem neuen Meta-Release Versionstabelle prüfen und ggf.
  `WHATSAPP_GRAPH_API_VERSION` setzen bzw. den Default anheben; Werte älter als
  v21.0 werden beim Start abgelehnt.
- Vor Go-live: echten WhatsApp-Bildempfang gegen einen Meta-Testaccount prüfen
  und den tatsächlichen Media-Downloadhost verifizieren (Allowlist
  `WHATSAPP_MEDIA_DOWNLOAD_HOSTS` in `apps/api/src/communication/whatsapp/gateways.ts`).


## Staff-Geräteidentität (Phase 12 Finalisierung)

- **Cookie-Name je Umgebung:** `APP_ENV=production`, `staging` und `demo` ⇒
  `__Host-mr_staff_device`; nur `APP_ENV=development` (lokales http) ⇒
  `mr_staff_device`. Der Server liest und setzt je Umgebung ausschließlich
  diesen einen Namen (`deviceCookieName` in `apps/api/src/auth/device.ts`).
- **HTTPS zwingend** außerhalb development: ein `__Host-`-Cookie wird vom
  Browser nur mit `Secure` angenommen – über http (oder hinter einem Proxy,
  der dem Browser http ausliefert) entsteht kein Geräte-Cookie und jeder Login
  wäre „neues Gerät“.
- **Reverse Proxy/CDN dürfen `__Host-`-Cookies nicht umschreiben:** kein
  `Domain`-Attribut ergänzen (z. B. kein `proxy_cookie_domain`/Cookie-Rewrite
  auf die Hauptdomain), `Path=/` und `Secure` nicht entfernen, Namen nicht
  ändern – sonst verwirft der Browser das Cookie.
- **Einmalig „neues Gerät“ nach diesem Deploy:** ein vorhandenes
  `mr_staff_device` aus früheren Test-/Staging-Ständen wird außerhalb
  development NICHT übernommen (keine Migration des Werts) ⇒ jeder Browser
  erhält beim ersten Login einen neuen `__Host-`-Wert und meldet sich einmal
  als neues Gerät (vor dem Produktivstart akzeptiert). Das alte Cookie bleibt
  wirkungslos im Browser liegen, bis es abläuft.
- **Passwort-/2FA-Reset und Recovery löschen bekannte Geräte nicht**
  (Fachentscheidung, TECH_DECISIONS.md); eine Funktion „Geräte vergessen“
  gibt es nicht.
- HttpOnly-Geräte-Cookie (32 Zufallsbytes base64url,
  SameSite=Strict, Path=/, Max-Age 400 Tage, Secure außer
  `APP_ENV=development` – gleiche Regel wie `mr_staff_session`). Es wird vom
  API-Server beim Login nach bestandener Passwortprüfung gesetzt und erkennt
  „neues Gerät“ (Admin-Security-Push); in der DB liegt nur der SHA-256
  (`staff_known_devices`, Migration 0023). Kein Auth-Token, keine neue
  Konfiguration/kein Secret nötig.
- Reverse Proxy/Staff-Proxy müssen – wie für `mr_staff_session` – mehrere
  `Set-Cookie`-Header unverändert durchreichen (Next-Rewrite `/api/*` tut das).
  Cookie-Header nie im Access-Log protokollieren (gilt bereits für die Session).
- **Rollout-Effekt (bewusst, konservativ):** Kein Browser besitzt das Cookie vor
  dem Rollout. Daher gilt nach dem Deploy JEDES Gerät jedes Mitarbeiters beim
  ersten Login einmal als „neu“ ⇒ je (Mitarbeiter, Gerät) einmalig ein
  `session.new_device_login` und ein Admin-Push „Neue Anmeldung von einem
  neuen Gerät“. Admins vorab informieren; danach nur noch echte neue Geräte
  bzw. Browser mit gelöschten Website-Daten. Bestehende Sessions bleiben
  gültig (kein erzwungener Re-Login).
- Login-Challenges (TOTP/Ersteinrichtung), die in den ≤ 5 Minuten vor dem
  Deploy begonnen wurden, haben keinen Geräte-Hash und werden neutral
  abgelehnt – die Person meldet sich einfach erneut an.
- Löscht ein Browser seine Website-Daten (oder Privat-Modus), ist das Gerät
  beim nächsten Login wieder „neu“ (erwartetes Verhalten).

## Migrationen der Phase-12-Finalisierung (0023–0026)

- **0023** `staff_known_devices`, Geräte-Hash an der Login-Challenge,
  Retention-Anker/PII-Scrub-Spalten, `mail_deliveries.recipient_email`/
  `subject` nullable, `inbound_mail_receipts.message_id_hash`.
- **0024** füllt `message_id_hash` aus der bisherigen Klartext-Message-ID
  (SHA-256, UTF-8) und entfernt die Klartextspalte – nicht umkehrbar
  (Backup vor dem Deploy wie üblich).
- **0025** `staff_sessions.device_token_hash` (nur Hash; Push-Abos desselben
  Mitarbeiters auf demselben Gerät folgen beim erneuten Login der neuen
  Session), `push_deliveries.appointment_id` (Versandzeit-Prüfung
  terminbezogener Pushes) und Teilindizes für den Retention-Backstop.
  Sessions vor dem Deploy haben keinen Hash ⇒ kein Umbinden, bis die Person
  sich einmal neu anmeldet.
- **0026** Index `push_deliveries(appointment_id)` (Zustellungen einer
  Kurzfrist-Neuzuweisung je Termin); rein additiv.
- Nach dem Deploy erhalten Vorgänge, die bereits abgeschlossen/storniert sind,
  ihren Retention-Anker beim ersten 2-min-Backstop (Anker = vorhandener
  Abschluss-/Stornozeitpunkt); ältere Daten können dadurch beim ersten
  Tageslauf sofort fällig sein.

## Routing/Touren (Phase 13)

- **Migration 0027** (`tours`, `tour_stops`, `tour_live_locations`,
  `tour_delay_incidents`, `geocoding_cache`, Enums `tour_status`,
  `tour_planning_status`, `geocoding_status`) ist rein additiv.
- **GraphHopper-Konto:** Produktivbetrieb braucht einen bezahlten Plan (Basic
  oder höher, `docs/ROUTING_API_NOTES.md`); Key nur als Secret der
  Produktionsumgebung (`GRAPHHOPPER_API_KEY`), nie in `.env`-Dateien im Repo.
  Ohne Key läuft die API mit `ROUTING_PROVIDER=disabled`: Touren sind
  organisatorisch nutzbar, Routen/Prognosen melden „Routing ist nicht
  konfiguriert.“
- **Smoke vor Freischaltung:** `ROUTING_SMOKE=1 GRAPHHOPPER_API_KEY=… pnpm
  routing:smoke` (ein Geocode, eine Route; gibt Status und Credits aus, nie
  den Key). Nicht in production ausführen.
- **Go-live-Schalter `ROUTING_PROVIDER_TERMS_CONFIRMED` (Phase 13 Final):**
  production mit gesetztem `GRAPHHOPPER_API_KEY` (effektiver Provider
  `graphhopper`) startet NUR mit `ROUTING_PROVIDER_TERMS_CONFIRMED=true`
  (API und Worker). Der Wert ist kein Secret, sondern die dokumentierte
  Bestätigung, dass Vertrag/Paket die implementierte serverseitige
  Zwischenspeicherung (`geocoding_cache` mit Kandidaten/Koordinaten/
  OSM-Referenzen, TTL 90/30 Tage; persistierte minimale Distanz-/
  Fahrzeitwerte) erlaubt – siehe `docs/OPEN_ITEMS.md` „GO-LIVE-BLOCKER
  Routing“. Ohne Bestätigung: `ROUTING_PROVIDER=disabled` lassen (Touren
  bleiben organisatorisch nutzbar) oder Caching/Persistenz vor dem Go-live
  reduzieren. Kein automatischer Default; demo/development/staging
  ignorieren den Schalter.
- **Depotadresse:** Einstellung `pickup_exact_address` muss vollständig sein,
  sonst sind Gesamtrouten blockiert („Depotadresse ist noch nicht vollständig
  hinterlegt.“).
- **Worker:** registriert den Scanner `tour_delay` im `communication.scan_due`
  und braucht dieselben Routing-Variablen wie die API (eigene
  Gateway-Instanz, eigene Drossel).
- **Datenschutz:** Standort nur während aktiver Tour in einer Zeile je Tour,
  gelöscht bei Tourende; Provider speichert Requests bis zu 5 Wochen
  (Privacy-Policy) – Verzeichnis der Verarbeitungstätigkeiten ergänzen
  (GraphHopper GmbH, Hetzner DE; Geocoding-Subprozessoren laut Notiz).
- **Attribution:** Die Staff-UI zeigt bei Routenwerten den
  OpenStreetMap-Hinweis (ODbL).

## Demo-Instanzen (Phase 14)

Die Demo-Umgebung besteht aus eigenen Prozessen mit **eigener** Datenbank,
eigenem Storage und eigenen Secrets (nie mit production geteilt; vor jedem
Release `pnpm check:env-isolation <prod.env> <demo.env>`):

| Prozess | Pflichtwerte zusätzlich zu den üblichen Variablen |
| --- | --- |
| API (demo) | `APP_ENV=demo`, optional `STAFF_LIVE_URL=https://app.<domain>` (Button „Live öffnen“); **kein** `STAFF_DEMO_URL`, kein Lexware-/WhatsApp-/GraphHopper-Key (Konfigurationsfehler); `MAIL_DEMO_WHITELIST` bei `MAIL_ENABLED=true` – für Mail-Übungen (Kundeninformation, Kommunikationsantwort) eine Sink-Domain mit Mail-Senke whitelisten, z. B. `MAIL_DEMO_WHITELIST=@demo.test`, plus `MAIL_PUBLIC_WEB_BASE_URL` (docs/ENVIRONMENTS.md „Demo-Mail“) |
| Worker (demo) | dieselben Variablen wie die Demo-API (`APP_ENV=demo`); legt Business-Jobs während eines Demo-Resets automatisch um 15 s zurück und hält je laufendem Handler einen Shared-Barrier-Lock (Phase 14 Final, siehe „Reset-Barrier“ unten) |
| Staff (demo) | wie bisher (`STAFF_API_ORIGIN` auf die Demo-API, `STAFF_OFFLINE_LEASE_VERIFICATION_KEY` der Demo-API); Badge/Titel „DEMO“ kommen aus der API, keine eigene Variable |
| Web (demo) | `WEB_API_ORIGIN` auf die Demo-API **und `WEB_APP_ENV=demo`** (fester Banner „DEMO – keine echten Kundendaten“ auf allen öffentlichen Seiten). Zusätzlich (Review F6) erscheint der Banner, wenn die konfigurierte API über `GET /health` `environment: 'demo'` meldet; `WEB_APP_ENV` bleibt Pflicht (Release-Ablauf 6b) |
| API (production) | optional `STAFF_DEMO_URL=https://demo.<domain>` (Button „Demo öffnen“); **kein** `STAFF_LIVE_URL` |

- **Seed/Reset laufen nur explizit** – nie beim Start, Deployment, bei
  Migration oder Update (Order §7). Den kanonischen Demo-Datensatz legt
  `pnpm demo:seed` an, den Reset lösen `pnpm demo:reset` oder Einstellungen →
  Demo („Demo-Geschäftsdaten zurücksetzen“, Bestätigungstext „DEMO
  ZURÜCKSETZEN“, Recht `demo.manage`) aus; Details zu Ablauf, Umfang und
  Kommandos: docs/TECH_DECISIONS.md (Phase 14, Seed/Reset).
- Ein älterer Datenstand (`dataset_version` kleiner als im Code) wird nach
  einem Update **nicht** automatisch zurückgesetzt, sondern Admins als
  „Demo-Datenstand ist veraltet – Zurücksetzen empfohlen.“ angezeigt
  (Einstellungen → Demo und dezent auf „Heute“).
- Während eines Resets antwortet die Demo-API auf Business-Mutationen mit
  `503 DEMO_RESET` (`retry-after: 15`); Offline-Sync behandelt das als
  vorübergehend (späterer Retry), die Staff-App zeigt einen lesbaren Hinweis
  statt einer Abmeldung. Bleibt ein Reset hängen (Flag älter als 10 min,
  `DEMO_RESET_STALE_MS`; Review F8), zeigt Einstellungen → Demo „Letzter Reset
  unterbrochen – erneut zurücksetzen“; der Reset-Endpunkt ist vom Gate
  ausgenommen. Nach einem harten Prozessabbruch (Deploy/OOM während der
  ≈ 10 s eines Resets) kann ein Systemadmin die Wartezeit mit `pnpm demo:reset
  --force` überspringen (nur CLI, siehe Seed-/Reset-Kommandos).
- Die Demo-Routen `/staff/demo/*` existieren ausschließlich in `APP_ENV=demo`
  (sonst 404) – es gibt keinen Reset-Endpunkt in production/staging/development.
- **Reset-Barrier (Phase 14 Final):** Der Reset wartet ehrlich, bis ALLE
  laufenden Business-Mutationen (API-Requests, Jobhandler – in jedem Demo-API-
  und Demo-Worker-Prozess) beendet sind: jede Mutation hält einen Shared-
  Advisory-Lock, der Reset den Exclusive (PostgreSQL, DB-weit). Die Reset-
  Dauer verlängert sich damit um die längste laufende Mutation (meist
  Sekunden). Neue Mutationen erhalten währenddessen sofort `503 DEMO_RESET`,
  neue Jobs werden zurückgelegt. Enden laufende Vorgänge nicht binnen
  **120 s** (`DEMO_RESET_BARRIER_TIMEOUT_MS`, Code-Default, keine
  Umgebungsvariable), bricht der Reset fail-closed ab: Antwort 409
  `DEMO_RESET_BARRIER_TIMEOUT`, Audit `demo.reset_failed`, Einstellungen → Demo
  zeigt „Letzter Reset unterbrochen – erneut zurücksetzen“ – einfach erneut
  auslösen. Jeder Demo-API-/Worker-Prozess hält dafür einen kleinen
  **zusätzlichen Verbindungs-Pool nur für Locks** (Default 20 Verbindungen,
  getrennt vom Fach-Pool mit 10) – bei `max_connections` der Demo-Datenbank
  einplanen: je Prozess bis zu 10 + 20 Verbindungen. Bleibt ein Lock nach einem
  harten Prozessabbruch stehen, gibt PostgreSQL ihn mit der Verbindung frei;
  ein manueller Eingriff ist nicht nötig. Ein festes Schutz-Zeitfenster gibt es
  nicht mehr.
- **Nach dem Reset (Phase 14 RESET):** Der Demo-Worker beendet Business-Jobs, die
  vor dem Reset-Beginn eingereiht wurden, als `dead`/`DEMO_DATASET_CHANGED`
  (erwartet, kein Fehler). Storage-Objekte, die beim Reset nicht gelöscht werden
  konnten, räumt der Job `demo.storage_cleanup` nach – er läuft nur im Demo-Worker
  (demo-Konfiguration, eigener Storage); „Bereinigung alter Demo-Dateien
  fehlgeschlagen“ in Einstellungen → Demo bedeutet einen dauerhaft `dead`
  gegangenen Cleanup-Job (Storage-Zugang/Logs prüfen; der Datensatz selbst ist
  konsistent). Offline-Geräte, die vor dem Reset ein Arbeitspaket hatten, erhalten
  beim nächsten Onlinekontakt den Hinweis „Demo-Daten zurückgesetzt“ und laden
  nach Bestätigung ein neues Paket (Dataset-Epoch); alte Offline-Erfassungen
  werden mit `409 DEMO_DATASET_CHANGED` abgewiesen und nie auf den neuen Seed
  angewendet. Production/Staging kennen keine Epoch – kein Unterschied dort.


### Seed-/Reset-Kommandos (Phase 14, SEED)

| Kommando | Wirkung |
| --- | --- |
| `pnpm demo:seed` | legt den kanonischen Demo-Datensatz auf LEEREM Demo-Geschäftsbestand an; bei vorhandenen Daten Abbruch „Demo-Daten existieren bereits – demo:reset verwenden.“ (Exit 1) |
| `pnpm demo:reset` | löscht ALLE Demo-Geschäftsdaten und seedet neu; verlangt interaktiv genau `DEMO ZURÜCKSETZEN` oder `--yes` (nur Automatisierung; ohne Terminal und ohne `--yes` Abbruch, Exit 2) |
| `pnpm demo:reset --force` | wie `demo:reset` (Bestätigung bleibt Pflicht), setzt aber vorher einen **hängenden** Reset zurück (Flag `reset_in_progress` gesetzt, aber kein Prozess hält mehr den Advisory-Lock – z. B. nach Deploy/OOM während eines Resets) und startet sofort neu, statt die Stale-Spanne von 10 min abzuwarten. Läuft tatsächlich ein Reset (Lauf-Lock belegt – gilt für die gesamte Laufzeit von Phase A bis D, Review-Fix F1), bricht das Kommando mit `DEMO_RESET_RUNNING` ab. Nur benutzen, wenn sicher kein Reset-Prozess mehr läuft; nur CLI, nur `APP_ENV=demo` |

Beide Kommandos laufen mit den Umgebungsvariablen der Demo-API (`APP_ENV=demo`,
`DATABASE_URL`, `STORAGE_*`, `AUTH_SECRET_KEY`, `COMMUNICATION_PAYLOAD_KEY`,
optional `MAIL_*`), brechen in jeder anderen Umgebung mit „Nur in APP_ENV=demo
erlaubt.“ (Exit 2) ab und brauchen einen bestehenden aktiven Systemadmin
(sonst Hinweis auf `pnpm staff:bootstrap-admin`, Exit 2). Migrationen werden
nicht angewendet (`pnpm db:migrate` bleibt ein eigener Schritt). Protokolliert
werden nur Datenbankname und Zähler. Nach einem Reset beginnen die
Vorgangsnummern wieder bei `MR-<Jahr>-0001`; Staff-Konten, Rollen, Rechte,
Geräte, Audit, Einstellungen und Stammdaten bleiben erhalten. Ohne
`MAIL_ENABLED`/Whitelist landen alle Kundenmails des Seeds als `blocked` in der
Outbox – gewollt, nichts verlässt die Demo. Mit einem `@domain`-Eintrag in
`MAIL_DEMO_WHITELIST` (empfohlen: Sink-Domain `@demo.test` mit Mail-Senke)
erhalten die Kunden der Mail-Übungsszenarien (`process.settlement.review`,
`process.return.damage`/`.missing_part`, `conversation.email.*`) Adressen unter
dieser Domain (z. B. `einkauf@demo.test`), damit Kundeninformationen und
Kommunikationsantworten in der Demo tatsächlich zugestellt werden (Order §9);
die Adressen gelten ab dem nächsten Seed/Reset, alle anderen Seed-Kunden
bleiben unter example.com / example.invalid.
