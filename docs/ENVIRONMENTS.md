# ENVIRONMENTS — Umgebungen und Konfiguration

## Die vier Umgebungen

| APP_ENV       | Zweck                                  | Konfigquelle                                    |
| ------------- | -------------------------------------- | ------------------------------------------------ |
| `development` | Lokale Entwicklung                     | Sichere Defaults im Code (passend zu `infra/docker-compose.yml`); alles per Env-Variable überschreibbar. |
| `staging`     | Vorabnahme vor Produktion              | Alle Variablen explizit als Secrets/Env gesetzt. |
| `demo`        | Demo/Training (MASTER_SPEC Nr. 29)     | Alle Variablen explizit; **eigene** DB, Storage, Secrets. |
| `production`  | Live-Betrieb                           | Alle Variablen explizit; niemals mit demo geteilt. |

`APP_ENV` ist von `NODE_ENV` getrennt: `NODE_ENV` steuert nur
Framework-Optimierungen, `APP_ENV` die fachliche Umgebung.

## Regeln (verbindlich, CLAUDE.md „Live / Demo / Staging“)

- Getrennte Datenbanken, getrennte Secrets, getrennte Storage-Konfiguration.
- Für `staging`/`demo`/`production` gibt es **keine Defaults**: fehlt eine
  Pflichtvariable, bricht der Start sofort mit einer Fehlermeldung ab, die nur
  Variablennamen nennt (nie Werte).
- Echte Secrets niemals ins Repository oder in Chat-Prompts – nur als
  Umgebungsvariablen/Secrets auf dem Zielsystem.
- Backend-Prozesse (API, Worker, Migrationen) lesen ausschließlich echte
  Prozess-Umgebungsvariablen; eine `.env`-Datei wird **nicht** automatisch
  geladen (bewusste Entscheidung, siehe TECH_DECISIONS.md). `.env.example`
  ist eine Referenzliste der Variablennamen; `.env`-Dateien sind gitignored
  und werden nur vom Isolations-Check explizit als Dateien eingelesen.

## Variablen

Siehe `.env.example` für die vollständige Liste. Pflicht außerhalb von
development: `APP_ENV`, `DATABASE_URL`, `AUTH_SECRET_KEY` (≥ 32 Zeichen,
verschlüsselt u. a. TOTP-Secrets im Ruhezustand; je Umgebung ein eigener
Zufallswert – der Isolations-Check erzwingt das), `STORAGE_DRIVER` (+ die zum
Treiber gehörenden `STORAGE_*`-Variablen). Optional: `AUTH_ALLOWED_ORIGINS`
(CSRF-Legacy-Fallback für Clients ohne `Sec-Fetch-Site`-Header, meist leer;
seit Phase 15 in `.env.example` dokumentiert). Optional mit Defaults: `API_HOST` (127.0.0.1),
`API_PORT` (3001), `LOG_LEVEL` (debug in development, sonst info),
`WORKER_POLL_INTERVAL_MS` (2000). Optional ohne Default (Phase 15, Kundenportal):
`PORTAL_NEW_INQUIRY_URL`, `COMPANY_PHONE_NUMBER` – Abschnitt „Kundenportal“.

## Lokale Entwicklung

`pnpm infra:up` startet PostgreSQL 18 mit drei getrennten Datenbanken:

| Datenbank        | Zweck                          |
| ---------------- | ------------------------------ |
| `mietroyal_dev`  | Entwicklung (`APP_ENV=development`-Default) |
| `mietroyal_test` | Integrationstests (`TEST_DATABASE_URL`)     |
| `mietroyal_demo` | Lokale Demo-Experimente        |

Lokale Verbindungsdaten (kein Geheimnis, nur Docker-lokal; der Port ist
ausschließlich an 127.0.0.1 gebunden):
`postgresql://mietroyal:mietroyal_local_dev@localhost:55432/<datenbank>`

Die Dev-Kommandos (`pnpm dev`, `pnpm db:migrate:dev`) setzen
`APP_ENV=development` selbst; nur in dieser Umgebung greifen die obigen
Defaults automatisch. Wer API/Worker einzeln mit `pnpm api`/`pnpm worker`
startet, setzt `APP_ENV=development` (bzw. die vollständige Serverkonfiguration)
explizit in der Shell.

## Isolation prüfen (produktionsnaher Check)

`assertConfigsIsolated` (`@mietroyal/config`) erkennt Kollisionen zweier
Umgebungen: gleiche Datenbank (auch bei kosmetisch unterschiedlicher URL),
gleicher S3-Bucket/Endpoint, gleiche S3-Zugangsdaten, gleiches
Storage-Verzeichnis. Vor jedem Deployment mit realen Serverkonfigurationen
ausführen:

```bash
pnpm check:env-isolation /pfad/zu/prod.env /pfad/zu/demo.env
```

Exit-Code 0 = isoliert; 1 = Kollision (der Report nennt die betroffenen
Variablen, nie deren Werte). Die gleichen Prüfungen laufen als Unit-Tests in
`packages/config/test/load-config.test.ts`.

## Offline-Namespaces (Phase 8)

Jedes Arbeitspaket und jede Offline-Mutation trägt die Umgebungs-ID
(`environment`), die der Server beim Ausstellen des Offline-Leases setzt und
bei jedem Sync hart gegen `APP_ENV` prüft (Mismatch ⇒ 409 `ENVIRONMENT_MISMATCH`
+ Security-Event). Lokal liegt jede Umgebung in einer eigenen IndexedDB
`mietroyal-offline-<env>-<userId>` mit eigenem Datenschlüssel – Demo-Daten
können weder in Production-Stores gelangen noch dorthin synchronisiert werden.

### Offline-Lease-Verifikationsschlüssel (Staff-Server)

Die Offline-Lease ist vom API-Server Ed25519-signiert; der private Schlüssel
wird je Umgebung aus `AUTH_SECRET_KEY` abgeleitet und verlässt die API nie.
Damit der Client Leases nur gegen genau diesen Schlüssel akzeptiert, wird der
**öffentliche** Schlüssel beim Staff-Server hinterlegt:

```bash
# in der API-Umgebung (gleiche Variablen wie der API-Prozess):
pnpm offline:lease-key          # gibt den Base64url-Schlüssel aus (kein Secret)
# beim Staff-Server (next start):
STAFF_OFFLINE_LEASE_VERIFICATION_KEY=<ausgegebener Wert>
```

In `staging` und `production` ist das Pflicht (fail-closed: ohne Schlüssel
akzeptiert die Staff-App keine Offline-Lease; Online-Betrieb läuft normal).
Nach einer Rotation von `AUTH_SECRET_KEY` muss der Wert neu ausgegeben und
gesetzt werden; bestehende Leases werden ungültig und beim nächsten
Onlinekontakt neu ausgestellt. Production und Demo haben zwingend
verschiedene Schlüssel (sie teilen kein `AUTH_SECRET_KEY`).

## Routing-Provider (Phase 13)

| Variable | Bedeutung |
| --- | --- |
| `ROUTING_ENABLED` | `true`/`false` – explizites Ein-/Ausschalten |
| `ROUTING_PROVIDER` | `graphhopper` \| `mock` \| `disabled` |
| `GRAPHHOPPER_API_KEY` | nur Server, nie Browser/DB/Logs/Git |
| `GRAPHHOPPER_BASE_URL` | nur development/staging überschreibbar (Fake-Server) |
| `ROUTING_REQUEST_TIMEOUT_MS` | Timeout je Provider-Aufruf (Default 15000) |
| `ROUTING_PROVIDER_TERMS_CONFIRMED` | `true`/`false` (Default false, kein Secret) – Go-live-Schalter: Vertrag/Paket gegen die implementierte serverseitige Zwischenspeicherung geprüft; production mit effektivem `graphhopper` startet ohne `true` nicht |

Regeln: **production** erlaubt nur `graphhopper` oder `disabled`, der Host ist
fest `https://graphhopper.com/api/1` (abweichende URL ⇒ Konfigurationsfehler),
ohne Key startet die API mit `disabled` (Hinweis im Log, kein Fake).
**demo** nutzt immer den Mock; ein gesetzter Key oder `graphhopper` ist ein
Konfigurationsfehler (Demo ruft nie einen echten Provider). **development**
Standard `mock`, **staging** Standard `disabled`; der echte Provider nur mit
`ROUTING_ENABLED=true`, `ROUTING_PROVIDER=graphhopper` und Key. Die
Isolationsprüfung meldet denselben `GRAPHHOPPER_API_KEY` in zwei Umgebungen
als Kollision.

**Go-live-Schalter (Phase 13 Final, §5):** `APP_ENV=production` mit effektivem
Provider `graphhopper` (Key gesetzt, nicht deaktiviert) verlangt zusätzlich
`ROUTING_PROVIDER_TERMS_CONFIRMED=true`; andernfalls bricht der Start mit einem
Konfigurationsfehler ab („GraphHopper in production erfordert
ROUTING_PROVIDER_TERMS_CONFIRMED=true nach vertraglicher Prüfung der
serverseitigen Zwischenspeicherung“). production mit `disabled` braucht keine
Bestätigung; demo/development/staging ignorieren den Schalter (staging wird
bewusst nicht erzwungen). Das Flag ist kein Geheimnis (keine Redaction, keine
Isolationsprüfung) und hat in production keinen automatischen Default – es
dokumentiert die bewusste Entscheidung nach Vertragsprüfung
(`docs/OPEN_ITEMS.md` → „GO-LIVE-BLOCKER Routing“).

## Demo-Umgebung (Phase 14)

### Live↔Demo-Wechsel: `STAFF_DEMO_URL` / `STAFF_LIVE_URL`

| Variable | Wo | Bedeutung |
| --- | --- | --- |
| `STAFF_DEMO_URL` | API in production/staging/development | fester Origin der **Demo**-Staff-App, z. B. `https://demo.<domain>`; in `demo` ein Konfigurationsfehler |
| `STAFF_LIVE_URL` | API in demo | fester Origin der **Live**-Staff-App, z. B. `https://app.<domain>`; in `production` ein Konfigurationsfehler |

Regeln (`packages/config`, `config.environmentLinks.counterpart`): nur eine
absolute URL mit Schema `https` (`http` nur in development), ausschließlich der
Origin – kein Pfad, keine Query, kein Fragment, keine Zugangsdaten (alles
andere ⇒ `ConfigError`); nie beide Variablen gleichzeitig. Die Werte sind
keine Secrets. `GET /auth/me` liefert `counterpart: { kind: 'demo' | 'live',
url } | null`; die Staff-App zeigt nur dann „Demo öffnen“ / „Live öffnen“,
öffnet nach bewusster Bestätigung `<Origin>/login` in einem neuen Tab und
überträgt dabei nichts (keine Session, keine IDs, keine aktuelle URL). Ohne
Variable gibt es keinen Button.

**Isolations-Check (erweitert):** Kollision, wenn beide Umgebungen auf dieselbe
Ziel-URL verlinken (`STAFF_DEMO_URL` der Live-Konfiguration ==
`STAFF_LIVE_URL` der Demo-Konfiguration) oder eine Umgebung ihre eigene
`MAIL_PUBLIC_WEB_BASE_URL` als Gegen-URL nennt. Diese Meldungen dürfen die
URLs nennen (keine Secrets).

### Web-Instanz: `WEB_APP_ENV`

`WEB_APP_ENV` gilt **nur für den Web-Server** (`apps/web`, `next start`), nicht
für API/Worker und nicht in `packages/config`. Werte wie `APP_ENV`, Default
`development`. Die Web-Instanz der Demo-Umgebung **MUSS** `WEB_APP_ENV=demo`
setzen: dann zeigt sie auf allen Seiten (Angebots-, Kontakt- und
Dokumentlinks) den festen Banner „DEMO – keine echten Kundendaten“ – dieser
Banner lässt sich durch nichts ausblenden. Der Wert wird zur Laufzeit des
Servers gelesen (nicht beim Build); ein unbekannter Wert wird einmal im
Serverlog gemeldet und wie `development` behandelt.

**Zweite Quelle (Review F6, Härtung):** zusätzlich fragt das Root-Layout je
Seitenaufruf serverseitig `GET <WEB_API_ORIGIN>/health` ab (Timeout 1 s,
`cache: 'no-store'`). Meldet die konfigurierte API `environment: 'demo'`,
erscheint der Banner ebenfalls (ODER-Logik, `apps/web/lib/environment.ts`,
`resolveDemoBanner`). Fehler oder Timeout der Abfrage ⇒ nur `WEB_APP_ENV`
zählt. Eine Demo-Web-Instanz mit vergessener Variable, aber korrektem
`WEB_API_ORIGIN` auf die Demo-API, bleibt dadurch gekennzeichnet.

**Pflicht außerhalb development:** fehlt `WEB_APP_ENV` bei `NODE_ENV`
≠ `development` (`next start`), loggt der Web-Server einmal einen Fehler
(`WEB_APP_ENV fehlt – …`) und läuft weiter – bewusst **kein Startabbruch**,
damit die Web-App nicht ausfällt; die Demo-Kennzeichnung hängt dann allein an
`/health`. Die Deploy-Checkliste (docs/DEPLOYMENT_NOTES.md, Release-Ablauf
6b) verlangt den Wert für jede Web-Instanz (`demo` bzw. `production`/
`staging`); der Isolation-Check kann ihn nicht prüfen.

### Demo-Mail: Senke, Whitelist und Demo-Testadressen des Seeds

Die Demo versendet E-Mails ausschließlich an `MAIL_DEMO_WHITELIST` (Phase 12:
vollständige Adressen oder `@domain`-Einträge; Betreff immer „[DEMO] …“;
Prüfung beim Einreihen und vor dem Versand). Damit Mail-Übungen in der Demo
tatsächlich zustellbar sind (Kundeninformation der Abrechnung bei berechneter
Belastung, Kommunikationsantworten – beide gelten erst mit bestätigtem Versand
als erledigt), sollte das Demo-Deployment eine **Sink-Domain** whitelisten,
z. B. `MAIL_DEMO_WHITELIST=@demo.test` (reservierte TLD, nie real), und den
SMTP-Weg (`MAIL_ENABLED=true`, `MAIL_SMTP_*`) auf eine Mail-Senke
(Catch-all-Postfach/Test-SMTP) zeigen lassen; Mails mit Links (Angebote,
Aktionen) brauchen außerdem `MAIL_PUBLIC_WEB_BASE_URL` (Config-Pflicht bei
`MAIL_ENABLED=true`, sonst bleiben sie `blocked`/`PUBLIC_WEB_BASE_URL_MISSING`).

Der Demo-Seed (Phase 14, Order §9 „konfigurierte Demo-Testadresse“) vergibt an
die Kunden der Mail-Übungsszenarien (`process.settlement.review`,
`process.return.damage`, `process.return.missing_part`, `conversation.email.*`)
Adressen `<lokalteil>@<erste Whitelist-Domain>` (z. B. `einkauf@demo.test`,
`lena.beispiel@demo.test`); ohne `@domain`-Eintrag bleiben alle Seed-Adressen
unter example.com / example.invalid und jede Kundenmail `blocked`
(DEMO_NOT_WHITELISTED). Vollständige Adressen der Whitelist (`tester@…`) werden
nie an Seed-Kunden vergeben; alle übrigen Seed-Kunden behalten die
Beispieldomain. Die Whitelist-Domain wirkt erst mit dem nächsten
`pnpm demo:seed`/`demo:reset`; bestehende Kunden behalten ihre Adresse. Details:
docs/TECH_DECISIONS.md („Demo-Testadressen im Seed“).

Phase 15 (Kundenportal): Auch die Portal-Mails (`customer_portal_magic_link`,
`customer_portal_reauth`, `customer_portal_email_change`,
`customer_portal_reply_notice`) unterliegen Whitelist und „[DEMO]“-Betreff –
ohne Sink-Domain kann sich in der Demo KEIN Kunde anmelden (die Anforderung
antwortet neutral 202, die Zustellung bleibt `blocked`/`DEMO_NOT_WHITELISTED`).
Für die Portal-Übung eignen sich die Übungskunden mit Whitelist-Adresse UND
bestätigter Buchung: `process.return.damage` (`miriam.demoperson@…`),
`process.return.missing_part` (`jana.beispielhaft@…`) und
`process.settlement.review` (`einkauf@…`); `customer.private.basic` hat nur eine
Anfrage und `customer.org.basic` nur einen Angebotsentwurf (im Portal „keine
aktuelle Buchung“ – ebenfalls ein Übungsfall).

### Demo-Kennzeichnung der Staff-App

Die Staff-App kennt ihre Umgebung über `GET /auth/me` (`environment`, auch im
gesperrten Zustand), offline über die gespeicherte Identität und auf Seiten
ohne Anmeldung (Login, Passwort vergessen/zurücksetzen) über `GET /api/health`.
Bei `demo` zeigt sie dauerhaft das Badge „DEMO – keine echten Kundendaten“ im
Header und Sperrbildschirm sowie den Titel-Präfix „DEMO · “. Dafür ist keine
zusätzliche Staff-Variable nötig.

### Demo-Reset-Gate

In `APP_ENV=demo` weist die API während eines laufenden Demo-Resets
(`demo_dataset_state.reset_in_progress`) alle Business-Mutationen
(`POST/PUT/PATCH/DELETE` unter `/staff/*`, `/public/*`, `/webhooks/*` und – seit
Phase 15 – `/portal/*`) mit `503 DEMO_RESET` und `retry-after: 15` ab;
ausgenommen sind `/auth/*`, `/staff/demo/*`, `/staff/push/*` und
`/staff/offline/lease*`. Für das Kundenportal gibt es bewusst KEINE Ausnahme:
Auch Magic-Link-Anforderung, -Einlösung und Logout warten (ein Consume würde
sonst eine Session in den gerade gelöschten Datensatz schreiben; Order §47). Der Worker legt
Business-Jobs (alle außer `system.heartbeat`) in dieser Zeit um 15 s zurück,
ohne einen Versuch zu verbrauchen. In allen anderen Umgebungen existieren
weder Gate noch Demo-Routen (`/staff/demo/*` ⇒ 404).

### Reset-Folgen für Jobs, Storage und Offline (Phase 14, RESET)

- **Jobs:** Business-Jobs, die vor dem Beginn des letzten Resets eingereiht
  wurden (`demo_dataset_state.last_reset_started_at`, DB-Uhr), führt der
  Demo-Worker nie aus – er beendet sie als `dead` mit `last_error =
  DEMO_DATASET_CHANGED`. Infrastruktur-Jobs (Heartbeat, Scanner, IMAP-Poll,
  Retention-Backstop, `demo.storage_cleanup`) sind davon ausgenommen.
- **Storage:** Objekte des alten Datensatzes, die beim Reset nicht gelöscht
  werden konnten, räumt der Job `demo.storage_cleanup` nach (nur im Demo-
  Storage – der Demo-Worker kennt keine andere Konfiguration). Offene oder
  dauerhaft gescheiterte Nachbereinigungen zeigt `GET /staff/demo/status`
  (`storageCleanup`) bzw. Einstellungen → Demo.
- **Offline-Epoch:** Nur in `APP_ENV=demo` liefern Lease (`POST
  /staff/offline/lease`), Arbeitspaket (`POST /staff/offline/package`) und
  Status (`GET /staff/offline/status`) ein Feld `datasetEpoch` (UUID der
  Datensatz-Generation); jeder Reset erzeugt eine neue. Der Sync (`POST
  /staff/offline/sync`) verlangt in demo die aktuelle Epoch (`datasetEpoch`) und
  antwortet sonst `409 DEMO_DATASET_CHANGED`, ohne etwas zu schreiben. In
  development/staging/production ist `datasetEpoch` immer `null`, und das Feld
  der Sync-Anfrage wird ignoriert – kein Verhaltensunterschied.
- **PDFs:** In demo tragen Angebot, Auftragsbestätigung, Lieferschein und die
  Protokolle die Zeile „DEMO – keine echten Kundendaten“ (jede Seite) und den
  Titelpräfix „DEMO · “; keine Staff-/Web-Variable nötig (Quelle `APP_ENV`).
- **Kundenportal (Phase 15):** Der Reset löscht `customer_portal_magic_links` und
  `customer_portal_sessions` (Order §46; damit auch offene E-Mail-Wechsel-Links)
  – Demo-Kunden müssen sich danach neu anmelden; ein vor dem Reset erzeugter
  Magic Link ist danach ungültig (401) und legt keine Session im neuen Seed an.
  Staff-Sessions, Geräte und Training bleiben unberührt.

## Kundenportal (Phase 15)

Das Kundenportal (`/konto/*` in apps/web, API-Routen `/portal/*`) läuft in jeder
Umgebung in den vorhandenen Web-/API-/Worker-Prozessen – keine eigene Instanz,
keine eigene Datenbank, kein eigenes Secret, keine Pflichtvariable. Details zur
Fachlogik: docs/CUSTOMER_PORTAL.md.

- **Variablen (optional, keine Secrets):** `PORTAL_NEW_INQUIRY_URL` (Ziel von
  „Neue Anfrage starten“; absolute http(s)-URL, in production nur https) und
  `COMPANY_PHONE_NUMBER` (Anruf-Button; Ziffern mit optional führendem `+`,
  Leerzeichen, `-`, `/`, Klammern). Beide ohne Default: `config.portal =
  { newInquiryUrl: null, phoneNumber: null }`, `GET /portal/me` liefert sie als
  `links`. Ungültige Werte brechen den Start ab (Konfigurationsfehler nennt nur
  den Variablennamen); ein LEERER Wert ist ebenfalls ein Fehler (wie bei
  `MAIL_PUBLIC_WEB_BASE_URL`) – die Variable dann weglassen. Produktivwerte
  fehlen noch (docs/OPEN_ITEMS.md „Phase 15“).
- **Portal-Basis = `MAIL_PUBLIC_WEB_BASE_URL`:** Anmelde-, Reauth- und E-Mail-
  Wechsel-Links werden ausschließlich aus dieser Variable und festen Pfaden
  gebildet (`/konto/anmelden`, `/konto/profil/bestaetigen`,
  `/konto/profil/e-mail-bestaetigen`, Hinweis-Mail `/konto`), Token im URL-
  Fragment (`#token=…`, erreicht den Server nie). Host-Header,
  `X-Forwarded-Host`, Query oder Body haben keinen Einfluss. Sie muss auf die
  Web-App DERSELBEN Umgebung zeigen (Demo-Links auf die Demo-Web-Instanz; der
  Isolations-Check vergleicht sie). Ohne `MAIL_ENABLED=true` gibt es keinen
  Portal-Login.
- **Web → API:** Same-Origin-Rewrite `/api/:path*` → `WEB_API_ORIGIN` (wie die
  Staff-App); das Portal ruft `/api/portal/...` mit `credentials: 'same-origin'`.
  Kein CORS, kein neues Proxy-Ziel; der globale CSRF-Hook (`Sec-Fetch-Site`,
  Fallback `AUTH_ALLOWED_ORIGINS`) gilt für alle Portal-Mutationen.
- **Portal-Cookie:** außerhalb development `__Host-mr_customer_session`
  (HttpOnly, Secure, Path=/, kein Domain, SameSite=Strict, Max-Age bis zum
  ABSOLUTEN Ablauf 30 Tage nach Anmeldung – kein Sliding), in development
  `mr_customer_session` (kein Secure, weil `__Host-` HTTPS verlangt). Token nie
  im Client-Storage. Staff-Cookie `mr_staff_session` und Portal-Cookie sind
  getrennte Sessions: Staff-Sessions öffnen keine Portal-Route (401) und
  umgekehrt.
- **Isolation (Order §48):** Sessions und Magic Links liegen in
  `customer_portal_sessions`/`customer_portal_magic_links` der jeweiligen
  Datenbank – ein Demo-Cookie oder -Token ist in production/development
  unbekannt (401) und umgekehrt; es gibt keine Cross-Environment-URL.
- **Demo:** Banner über das Root-Layout der Web-App (`WEB_APP_ENV=demo`, gilt für
  `/konto/*`); Portal-Mails nur an die Whitelist, Betreff „[DEMO]“ (Abschnitt
  „Demo-Mail“); Gate-/Barrier-Präfix `/portal` (Abschnitt „Demo-Reset-Gate“);
  Reset löscht Portal-Sessions und Magic Links (Abschnitt „Reset-Folgen“).
- **Cleanup:** Abgelaufene/widerrufene Sessions und verbrauchte/abgelaufene Magic
  Links räumt der bestehende Scan-Lauf `communication.scan_due` (alle 2 min,
  Worker; API-Testrunner identisch) über Portal-Scanner auf – keine neue
  Scheduler-Konfiguration (Order §52).

