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


## Staff-Geräteidentität `mr_staff_device` (Phase 12 Finalisierung)

- Neues HttpOnly-Cookie `mr_staff_device` (32 Zufallsbytes base64url,
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

## Migrationen der Phase-12-Finalisierung (0023–0025)

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
- Nach dem Deploy erhalten Vorgänge, die bereits abgeschlossen/storniert sind,
  ihren Retention-Anker beim ersten 2-min-Backstop (Anker = vorhandener
  Abschluss-/Stornozeitpunkt); ältere Daten können dadurch beim ersten
  Tageslauf sofort fällig sein.
