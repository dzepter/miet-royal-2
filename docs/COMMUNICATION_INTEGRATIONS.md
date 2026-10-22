# Kommunikations-Integrationen (Phase 12)

Verifikationsdatum: 2026-10-18. Dieses Dokument sammelt je Kanal die
maßgeblichen APIs/Standards, Grenzen, Sicherheitsentscheidungen und bewusst
nicht implementierte Teile.

## Überblick und Architektur

Alle Kanäle laufen über eine zentrale Kommunikationsschicht
(`apps/api/src/communication/`). Fachmodule liefern nur Ereignis, Empfänger-
Snapshot, Kontext und Dokumentreferenzen; Rendering, Outbox, Zustellung,
Retry, Status, Idempotenz und Log-Sicherheit liegen in der Schicht. Provider
werden ausschließlich über Gateways angesprochen (`OutboundMailGateway`,
`InboundMailSource`, `WhatsAppGateway`, `PushGateway`; ICS über
`CalendarFeedService`). Je Umgebung: echter Gateway oder `disabled`
(production), Mock/Whitelist (demo), Fakes nur in Tests (in production beim
Start verboten). Alle Jobs laufen auf der bestehenden PostgreSQL-Queue
(`mail.send`, `mail.inbound_poll`, `communication.scan_due`,
`communication.cleanup_retention`, `whatsapp.send`, `whatsapp.media_fetch`,
`push.send`, `voucher.delivery`, `invoice.delivery`) – kein zweites
Scheduler-System. Externe Ausfälle brechen nie den Kernbetrieb: Übergabe/
Rückgabe/Rechnung/Gutschein bleiben gültig, nur der Versandstatus zeigt
`pending`/`retry`/`failed`.

## Ausgehende E-Mail (SMTP, Phase 12 – verifiziert 2026-10-18)

**Standards/Bibliothek:** SMTP (RFC 5321) mit TLS – implizit (Port 465,
RFC 8314) oder STARTTLS-Pflicht (Port 587, RFC 3207); Nachrichtenformat
RFC 5322/MIME über `nodemailer` (kein eigener SMTP-/MIME-Code). Zertifikate
werden immer geprüft (`rejectUnauthorized: true`, mindestens TLS 1.2, keine
Konfigurationsoption zum Abschalten). Hosts/Zugangsdaten nur per Umgebung
(`MAIL_*`), nie per Staff-UI. Außerhalb von development ist
`MAIL_PUBLIC_WEB_BASE_URL` bei `MAIL_ENABLED=true` Pflicht (Härtung RA-11).

**Outbox:** `mail_deliveries` ist dauerhaft und Taktgeber. Jede Zustellung hat
einen fachlichen Idempotenzschlüssel (UNIQUE, z. B. `order_confirmation:<id>`)
und eine stabile Message-ID `<deliveryId@Absenderdomain>`, die beim Einreihen
vergeben und bei jedem Versuch identisch gesendet wird. Status: `pending`,
`sending`, `sent`, `retry`, `failed`, `blocked`, `outcome_unknown`.
Ergebnis-Klassifikation (Härtung RA-1, verifiziert gegen Nodemailer 10.1.6
`smtp-connection`): Server hat angenommen ⇒ `sent`; 4xx ⇒ `retry` (1 min × 2ⁿ,
max. 6 h, 8 Versuche, danach `failed`); 5xx ⇒ `failed`. Fehler OHNE
Serverantwort sind nur dann `retry`, wenn sie nachweislich VOR der SMTP-Sitzung
entstanden: `timeoutType` CONNECT_TIMEOUT/GREETING_TIMEOUT/UPGRADE_TIMEOUT,
EDNS, ETLS (TLS-Aufbau/STARTTLS), EPROXY, Socket-Fehler mit Aufbau-Ursache
(`originalCode`/`syscall`: ECONNREFUSED, EHOSTUNREACH, ENETUNREACH, ENOTFOUND,
EAI_AGAIN, Zertifikatsfehler beim impliziten TLS) sowie Fehler vor MAIL FROM
(EHLO/STARTTLS/AUTH, lokale API-Fehler). Nodemailer meldet Socket-Timeout,
Socket-Fehler und Verbindungsabbruch einer bestehenden Sitzung IMMER mit
`command: 'CONN'` – auch nach vollständig übertragenem DATA (ein
`command: 'DATA'` entsteht dort nie). Daher gilt alles andere ohne Antwortcode
(SOCKET_TIMEOUT, ECONNECTION/ESOCKET nach dem Greeting, EPROTOCOL, unbekannte
Fehler) als `outcome_unknown` ohne automatischen Retry – auch ein Abbruch vor
dem Greeting, der von einem Abbruch nach DATA nicht unterscheidbar ist
(konservativ; keine Exactly-once-Behauptung). Ein manuelles „Erneut senden“
erzeugt bewusst eine NEUE Zustellung mit neuer Message-ID – je Quelle genau
einmal (Schlüssel `<alt>:resend:<quell-id>`, Quelle `FOR UPDATE`; zweiter
Aufruf ⇒ 409; Resend einer Resend-Zustellung bleibt möglich; ist für dasselbe
Fachobjekt bereits eine neuere Zustellung unterwegs/versendet/unklar ⇒ 409).

**Fachstatus bei `outcome_unknown` (Härtung RA-12):** AB, Übergabe-/
Rückgabe-Paket, Kundeninformation (Schaden), Stornobestätigung und
Rechnungsversand bleiben `queued` bzw. „Versand ausstehend“ – nie `failed`,
denn der Kunde kann die Mail erhalten haben; die normale Sendeaktion ist
damit gesperrt (keine Doppelmail). Erneut senden nur bewusst über die
Admin-Outbox („erneut senden“, Warnung bei unklarer Zustellung); deren neue
Zustellung erreicht das Fachobjekt über das Schlüsselpräfix `<art>:<id>`.
Gutschein: bleibt `pending` mit Problemcode, „Gutschein jetzt senden“ ist
gesperrt. Nach `failed`/`blocked` legt die bewusste Fach-Sendeaktion eine NEUE
Zustellung `<schlüssel>:retry:<vorherige id>` an (AB, Kundeninformation,
Stornobestätigung, Gutschein an die AKTUELLE Kundenadresse); eine
Deduplizierung meldet stets den echten Status (`existingStatus`).
**Konversation (Härtung RA-14):** jede automatische Mail eines Vorgangs
erscheint als kompaktes Systemereignis (bei `sent` sowie bei `failed`/
`blocked`; unklar ⇒ „queued“), idempotent je Zustellung.
Blockaden: `MAIL_NOT_CONFIGURED`, `DEMO_NOT_WHITELISTED`, `NO_RECIPIENT`,
`INVALID_RECIPIENT`, `SECRET_UNDECRYPTABLE`, `PUBLIC_WEB_BASE_URL_MISSING`.
Anhänge werden nur referenziert: unveränderliche Dokumente aus dem
Dokumentenspeicher bzw. die Lexware-Rechnung, die beim Versand transient über
die Lexware-API geladen und nie gespeichert wird.

**Vorlagen:** je Art (offer, order_confirmation, handover_protocol,
return_protocol, settlement_damage_missing_notice, cancellation_confirmation,
reminder_7_days, reminder_1_day, appointment_changed, voucher_delivery,
invoice_delivery, manual_customer_reply) text/plain + HTML aus derselben
Quelle, alle Werte HTML-escaped, Links nur auf `MAIL_PUBLIC_WEB_BASE_URL`,
keine Bilder, kein Tracking (keine Pixel, keine Klick-Umleitungen), Signatur
„Mit freundlichen Grüßen / Miet-Royal Mainz“. CR/LF in Betreff oder
Empfängername ⇒ Abweisung (Header-Injection).

**Grenzen/bewusst nicht implementiert:** Bounce-/DSN-Auswertung,
Öffnungs-/Klick-Tracking, Newsletter/Marketing, DKIM-Signatur durch die
Anwendung (Aufgabe des Mailservers), Live-Test gegen ein echtes Postfach im
Gate (optional `pnpm mail:smoke` mit `MAIL_SMOKE=true` + `MAIL_SMOKE_TO`).

## Verschlüsselung von Kommunikations-Geheimnissen

Angebots-, Aktions- und Dokument-Token sowie Gutscheincodes stehen nie im
Klartext in der Datenbank. In der Outbox liegen sie als AES-256-GCM-Payload
(`v2:<keyId>:<base64(iv|tag|ct)>`, zufällige 12-Byte-Nonce, Schlüssel per
HKDF-SHA256 aus `COMMUNICATION_PAYLOAD_KEY`, AAD = Umgebung | Zweck | Entität);
nach `sent` wird die Payload gelöscht. Genau ein Vorgängerschlüssel
(`COMMUNICATION_PAYLOAD_KEY_PREVIOUS`) wird nur zum Entschlüsseln akzeptiert;
`pnpm communication:rewrap-secrets` kapselt alle vorhandenen Payloads (jede
Zustellung außer `sent`, also auch `failed`/`outcome_unknown`/`blocked` –
sonst wäre „erneut senden“ nach der Rotation unmöglich, Härtung RA-4) und Gutschein-
Versandkopien (inkl. Phase-11-Format v1 aus `AUTH_SECRET_KEY`) auf den
aktuellen Schlüssel um. Nicht entschlüsselbare Gutschein-Kopien ⇒ Gutschein
und Hash bleiben unverändert, `delivery_problem_code =
DELIVERY_COPY_UNDECRYPTABLE`. Öffentliche Link-Token selbst werden nur als
SHA-256-Hash gespeichert.

## Umgebungen und Demo-Isolation

- production: echte Gateways nur bei vollständiger Konfiguration, sonst
  `disabled` (fail-closed); Fakes/Mocks beim Start verboten; WhatsApp-Host
  fest `graph.facebook.com`.
- demo: E-Mail nur an `MAIL_DEMO_WHITELIST` (Adressen oder `@domain`), jeder
  Betreff mit „[DEMO]“, auf allen Pfaden (Transaktionsmails, Reminder, Staff-
  Antwort, Resend); WhatsApp ausschließlich simuliert („DEMO / simuliert“);
  Push nur an Demo-Sessions der Demo-Datenbank; eigene Kalender-Token.
- `pnpm check:env-isolation` erkennt geteilte `COMMUNICATION_PAYLOAD_KEY`
  (auch über den Vorgängerschlüssel), WhatsApp-Token/App-Secret/Nummer,
  VAPID-Schlüsselpaar und IMAP-Postfach zusätzlich zu Datenbank, Storage,
  Auth- und Lexware-Schlüsseln.

## Retention der Kommunikation (Phase-12-Finalisierung)

Job `communication.cleanup_retention` (Code: `communication/retention/`),
Einzelheiten und Begründungen in TECH_DECISIONS.md „Phase 12 Finalisierung:
Retention“.

- **Terminal** = abgeschlossen oder storniert; Terminalzeitpunkt
  `processes.completed_at` bzw. `processes.cancelled_at` (persistierter
  fachlicher Stornozeitpunkt beider Storno-Wege).
- **Sofort beim Eintritt in terminal** (Listener am Abschluss und an beiden
  Storno-Wegen ⇒ Job je Terminalzeitpunkt; Backstop in `communication.scan_due`
  alle 2 min): Chatfotos (`message_photos`, nur Kommunikationsfotos) aus dem
  Storage löschen + `deleted_at`; Retention-Anker (`retention_anchor_at`) aller
  Nachrichten und prozessgebundenen Zustellungen ohne Anker setzen. Reopen
  setzt nichts zurück und stellt nichts wieder her.
- **Täglich** (`communication.cleanup_retention:<JJJJ-MM-TT>`): Chattext,
  Betreff, Absender-Snapshot (⇒ `{"role":"customer"}`/`{"role":"staff"}`) und
  Message-IDs/wamids 12 Berliner Kalendermonate nach dem Anker;
  prozessgebundene `mail_deliveries` ebenso (Empfänger, Betreff, Kontext,
  Anhänge, In-Reply-To, Secret-Payload ⇒ danach kein Resend, Audit-Rest bleibt);
  nicht prozessgebundene Zustellungen 90 Tage nach Endzustand (nie pending/
  retry/sending); Unzugeordnetes/Ignoriertes/Quarantäne 90 Kalendertage nach
  Eingang (Text/Betreff/Absender/Fotos/Beleg-Absender weg, raus aus der
  Unmatched-Inbox, nicht mehr zuordenbar; Mailbox/UIDVALIDITY/UID/Status/
  receivedAt/Fingerprint/`message_id_hash` bleiben ⇒ IMAP-Dedupe bleibt
  wirksam); WhatsApp-Kontakte ohne Kunde 90 Tage nach der letzten Nachricht
  gelöscht, wamids in `whatsapp_events` nach 90 Tagen nur noch als
  `sha256:<hex>`.
- Nie berührt: Übergabe-/Rückgabe-/Schadens-/Defektfotos, Signaturen,
  Dokumente (auch unterschriebene Protokolle) und alle übrigen Fachdaten.

## Bewusst nicht gebaut (Auftrag §45)

Kundenportal, öffentliche Kundenchat-App, Website/Konfigurator, Newsletter
und Marketing, SMS, automatische WhatsApp-Nachrichten/Erinnerungen,
inoffizielle WhatsApp-Bibliotheken oder Scraping, Telefonanlage und
Gesprächsaufzeichnung, KI-Antworten/-Zusammenfassungen, Mahnwesen, Touren/
GPS/ETA (nur die Grenze `tour.delay_risk` ist benannt, es gibt keinen
Tour-Push), bidirektionaler Apple-Kalender, iCloud-Zugangsdaten,
Notification-Center-Glocke, Social Media.

## Web Push (Mitarbeitende, Phase 12 – verifiziert 2026-10-18)

**Standards/Quellen:** RFC 8030 (HTTP Web Push: 201 = angenommen, nicht
zugestellt; 404 bei abgelaufener Subscription; TTL-Header Pflicht;
Subscription-URI = Capability-URL), RFC 8291 (Content-Encoding aes128gcm,
ECDH P-256, auth secret 16 Oktette), RFC 8292 (VAPID: ES256-JWT, `aud` =
Origin des Push-Dienstes, `exp ≤ 24 h`, `sub` mailto:/https:), MDN
PushSubscription/notificationclick, Bibliothek `web-push` (github
web-push-libs/web-push: `generateVAPIDKeys`, `sendNotification(sub, payload,
{TTL, vapidDetails})`, verschlüsselt aes128gcm, rejects mit `statusCode`).

**Umsetzung:** `apps/api/src/communication/push/` – Gateways (WebPush/Fake/
Disabled), Subscription-Service, Push-Outbox (`push_deliveries`) + Job
`push.send`, Regeln (`PushRuleScanner.scanDue`), Admin-Status; Routen
`routes/push.ts`; Service Worker `apps/staff/public/sw.js` (`push`,
`notificationclick`), Client `apps/staff/lib/push.ts`, UI Einstellungen →
Benachrichtigungen. Env: `PUSH_VAPID_PUBLIC_KEY`, `PUSH_VAPID_PRIVATE_KEY`,
`PUSH_VAPID_SUBJECT` (alle drei oder keiner; Erzeugung mit
`pnpm --filter @mietroyal/api push:generate-vapid-keys`, je Umgebung ein
eigenes Paar – Demo und Live teilen nie Keys).

**Regeln (Order §31):** 1 h vor Abholung/Lieferung/Rückgabe an die effektive
Zuständigkeit (inkl. Vertretung), kurzfristige Neuzuweisung am
Durchführungstag an die neue Person, Vertretungsbeginn an die Vertretung,
überfällige Rückgabe einmal je Incident, Maschinenrisiko initial plus genau
eine Erinnerung nach 6 h, neues Gerät an Admins; kein Reinigungs- und kein
Tour-Push.
Phase 12 Finalisierung 2: Der Kurzfrist-Push geht an die EFFEKTIVE
Zuständigkeit der neu zugewiesenen Person (ist sie vertreten, an die
Vertretung; die Übernahmebestätigung bleibt bei der direkt zugewiesenen
Person) und nur, solange der Termin am selben Berliner Kalendertag wie die
Neuzuweisung stattfindet; Vertretungswechsel vor dem Versand ⇒ die alte
Zustellung wird `SUPERSEDED_RECIPIENT`, die nun zuständige Person bekommt genau
einen Push (Details: TECH_DECISIONS.md, Regeln A–G).

**Grenzen/Entscheidungen:** Push erst nach bewusstem Klick; Subscription je
User × Gerätesession; 404/410 deaktivieren; Revoke/Logout/Deaktivierung ⇒
kein Push; keine Kundendaten (nur Vorgangsnummer/Terminart, technisch durch
`buildPushPayload` erzwungen); TTL 1 h; keine Zustellgarantie (Push-Dienst
nimmt nur an); kein Notification-Center, keine Touren-/Reinigungs-Pushes.
Apple verlangt ein echtes `sub` (mailto:/https:) – Platzhalter ⇒ 403
BadJwtToken. Der VAPID-Private-Key liegt nur in der Server-Umgebung
(Pino-Redaction, nie Status-API/Frontend/DB).

**Kein Opt-out in Miet-Royal (Phase 12 Finalisierung, bestätigte
Entscheidung):** Die bewusste Entscheidung ist die Browserberechtigung – nach
Klick auf „Push-Benachrichtigungen aktivieren“ fragt der Browser; wer ablehnt,
sieht „Push ist auf diesem Gerät im Browser nicht aktiviert.“ (änderbar nur in
den Seiteneinstellungen des Browsers). Ist Push aktiv, zeigt die Seite nur den
Status „Push ist auf diesem Gerät aktiv.“ und die eigenen Geräte – es gibt
keinen Button und keine Route zum Ausschalten, Abmelden oder Pausieren
(`DELETE /staff/push/subscriptions/current` entfernt). Deaktiviert wird nur
technisch: Logout/Session-Widerruf, Inaktivität (30 Tage), Mitarbeiter
gesperrt/deaktiviert, 404/410 des Push-Dienstes (auch wenn der Browser die
Subscription verloren hat – dann zeigt die Seite wieder „aktivieren“),
unzulässiger Endpoint, Übernahme des Endpoints durch einen anderen User.

**Automatisches Wiederanbinden (Phase 12 Finalisierung, Auftrag 2026-10-22):**
Nach Login bzw. beim Start der Staff-App mit gültiger Online-Session
(AuthGuard, einmal je App-Start) registriert `apps/staff/lib/push-rebind.ts`
die VORHANDENE Browser-Subscription still erneut über
`POST /staff/push/subscriptions` – nur bei `Notification.permission ===
'granted'` und nur, wenn `pushManager.getSubscription()` des registrierten
Service Workers eine Subscription liefert. Kein Prompt, kein Klick, kein
`pushManager.subscribe()`, keine Endpoints aus LocalStorage/Query/Cookie, kein
Logging; offline wird nichts versucht. Der Server bindet sie an User + aktuelle
Session und reaktiviert sie (z. B. nach `session_expired`/Logout); Allowlist und
Schlüsselprüfung gelten unverändert. `'default'` ⇒ Button „Push-
Benachrichtigungen aktivieren“, `'denied'` ⇒ nur der Hinweis – jeweils ohne
Anfrage. Eine vom Push-Dienst aufgegebene Subscription (404/410), die der
Browser noch liefert, wird dadurch reaktiviert, beim nächsten Versand aber
wieder deaktiviert. Fremder User auf demselben Browser: bestehende
Übernahmeregel (vollständige Subscription ⇒ Zeile wechselt zum neuen User).

**Endpoint-Allowlist (Härtung Review B, B10):** Der Push-Endpoint kommt frei
vom Browser; der Server baut dorthin Verbindungen auf. Deshalb gilt
(`apps/api/src/communication/push/endpoint-policy.ts`, Route UND Gateway):
überall nur `https://` ohne Zugangsdaten; in production/staging/demo nur
bekannte Push-Dienste – `fcm.googleapis.com` (Chrome/Edge),
`updates.push.services.mozilla.com` (Firefox), `web.push.apple.com` und
`*.push.apple.com` (Safari), `*.notify.windows.com` (WNS) –, Port 443, keine
IP-Literale. Die Hostliste ist NICHT amtlich verifiziert (die geprüften
Primärquellen RFC 8030/8291/8292/MDN nennen keine Hosts); meldet ein Browser
„Dieser Push-Dienst wird nicht unterstützt“ (HTTP 400
`PUSH_ENDPOINT_NOT_ALLOWED`), ist sein Host in `KNOWN_PUSH_SERVICE_HOSTS`
zu ergänzen. development: keine Host-Einschränkung (lokale Fakes, z. B. der
E2E-Push-Dienst unter `https://localhost:<port>`). Bereits gespeicherte
unzulässige Endpoints werden beim Versand nicht kontaktiert und deaktiviert.

**Bewusst nicht implementiert:** Rich-Push mit Kundendaten, Push an Kunden,
Server-seitige Zustellbestätigungen/Receipts, eigene VAPID-JWT-Implementierung
(Bibliothek), SMS-Fallback.

## Apple-Kalender (ICS-Feed, Phase 12 – verifiziert 2026-10-18)

**Standards/Quellen:** RFC 5545 (Zeilen ≤ 75 Oktette, CRLF, Faltung mit
CRLF + Whitespace nicht in UTF-8-Sequenzen; VCALENDAR mit PRODID+VERSION;
VEVENT mit UID + DTSTAMP(UTC); VTIMEZONE je verwendeter TZID Pflicht; SEQUENCE
Start 0, monoton; TEXT-Escaping \ , ; \n), RFC 7986 (NAME,
REFRESH-INTERVAL;VALUE=DURATION, URL), METHOD:PUBLISH als iTIP-Konvention
(RFC 5546). Apple: support.apple.com „Subscribed calendars can be refreshed
automatically“ (macOS: Informationen → automatische Aktualisierung; der
Client bestimmt das Intervall; Account-„Push“ gilt nicht für ICS-Abos);
CalDAV-Accounts verlangen Nutzername/Passwort ⇒ nicht gewählt. Die
Bedienschritte „iOS: Kalenderabo hinzufügen“, „macOS: Ablage → Neues
Kalenderabonnement“ konnten nicht amtlich verifiziert werden und gelten als
allgemeine Hinweise.

**Umsetzung:** `apps/api/src/communication/calendar/` (`ics.ts` reine
Formatierung, `feed-service.ts` Token/Termine), Routen `routes/calendar-feed.ts`
(`POST/GET /staff/calendar/feed` mit `calendar.view`;
`GET /public/calendar/<token>.ics` öffentlich, `publicLimit(60)`, neutral
404, Log-Maskierung, `text/calendar; charset=utf-8`, `Cache-Control:
private, no-store`), UI Einstellungen → Kalender (Link einmalig sichtbar,
Kopieren, Warnung „privat, nicht weitergeben“, Regenerate mit Bestätigung).

**Link-Form (Härtung Review B, B16):** Der ausgegebene Abo-Link zeigt auf die
Staff-App: `<Staff-App-Basis-URL>/api/public/calendar/<token>.ics` (ohne
konfigurierte Basis-URL relativ `/api/public/calendar/<token>.ics` mit Hinweis).
Die Staff-App leitet `/api/*` an die API weiter und streift `/api` ab – die API
erhält `/public/calendar/<token>.ics`. Reverse-Proxy-Logs müssen beide
Pfadformen maskieren (DEPLOYMENT_NOTES.md). Der Feed antwortet neutral 404,
sobald der Mitarbeiter deaktiviert ist oder das Recht `calendar.view` nicht
mehr effektiv besitzt (B12); bei erneuter Vergabe gilt derselbe Link wieder.

**Entscheidungen:** privater read-only Feed je Mitarbeiter (Token = einziger
Zugang, 32 Random-Bytes, nur SHA-256 gespeichert, Regenerate invalidiert
sofort); Inhalt nur effektive Pickup/Delivery/Return (inkl. Vertretung,
−30…+180 Tage); eingebettete VTIMEZONE Europe/Berlin; UID = Termin-ID,
SEQUENCE = Terminversion − 1; **keine LOCATION** (Adresse = Kundendatum),
keine VALARM, keine Namen/Telefon/Preise/Schäden/Notizen; Miet-Royal bleibt
Source of Truth (keine Rückrichtung).

**Bewusst nicht implementiert:** CalDAV/Apple-ID-Anbindung, bidirektionaler
Sync, Einladungen (iTIP REQUEST), webcal://-Sonderbehandlung (http(s)-Link
reicht; Clients akzeptieren ihn als Abo), Angebote/Rechnungen/Lager/Reinigung
im Kalender.

## Inbound E-Mail (IMAP, Phase 12 – verifiziert 2026-10-18)

**Standards/Bibliotheken:** IMAP4rev1/rev2 (RFC 3501/9051) über `imapflow`
(Verbindung TLS implizit, Port 993, oder STARTTLS-Pflicht `doSTARTTLS`; nie
Klartext; in production/staging keine localhost-Hosts), MIME-Parsing über
`mailparser` (`simpleParser`). Kein eigener MIME-/IMAP-Code.

**Abruf:** Mailbox read-only öffnen (`mailboxOpen(folder, { readOnly: true })`),
UIDVALIDITY lesen, `fetch("${lastUid+1}:*", { uid, source })` mit UID-Range –
NIE nach `\Seen`/UNSEEN, nie Flags setzen, nie löschen/verschieben. Zustand
je Mailbox in `inbound_mail_state` (UIDVALIDITY, lastUid, lastPollAt,
lastSuccessAt, lastErrorCode); UIDVALIDITY-Wechsel ⇒ ab UID 1 neu lesen.
`lastUid` wird erst nach erfolgreicher Verarbeitung JEDER Nachricht
fortgeschrieben; nach einem Absturz werden Nachrichten erneut gelesen und über
die Belege dedupliziert (`inbound_mail_receipts`: UNIQUE mailbox+UIDVALIDITY+
UID, partial UNIQUE `message_id_hash`, UNIQUE Fingerprint). Phase-12-
Finalisierung: Die Message-ID steht im Beleg NUR als `message_id_hash` =
SHA-256 (hex) über die UTF-8-Bytes der normalisierten Message-ID (ohne
spitze Klammern/Steuerzeichen, Groß-/Kleinschreibung erhalten) – der
Klartext wird nie gespeichert (Migration 0024 hat Altbestände so gehasht und
die Klartextspalte entfernt). Härtung RA-6: Mit
Message-ID entscheidet ausschließlich die Message-ID (der gespeicherte
Fingerprint ist dann ein eigener Namensraum je Message-ID); nur OHNE
Message-ID dedupliziert der Fingerprint = SHA-256 über From | Date | Subject |
GESAMTER normalisierter Text | SHA-256 aller Anhänge, fehlt Date zusätzlich
Mailbox/UIDVALIDITY/UID (⇒ praktisch nur exakte Duplikate). Härtung RA-10
(Poison Message): Steuerzeichen (C0 außer Tab/Zeilenumbruch, `\r` ⇒ `\n`;
in Betreff/Name/Adresse/Message-ID ⇒ Leerzeichen bzw. entfernt) werden vor dem
Speichern entfernt; scheitert eine Nachricht dennoch nicht wiederholbar
(SQLSTATE-Klasse 22/23 außer 23505, unlesbares MIME), entsteht ein Beleg
`rejected` mit `match_reason = quarantined:<code>` ohne Inhalt, `lastUid` läuft
weiter (Mail bleibt im Postfach), geloggt wird nur der Code; wiederholbare
Fehler (DB/Storage nicht erreichbar) brechen den Poll ab und werden beim
nächsten Lauf wiederholt. Vorab hochgeladene Fotos werden bei jedem
Fehlschlag gelöscht (H7). Poll-Job `mail.inbound_poll`
reiht sich selbst alle 2 Minuten mit Zeit-Bucket-Schlüssel neu ein (Start beim
Worker-Boot); ohne IMAP-Konfiguration passiert nichts.

**Zuordnung (feste Reihenfolge):** (1) In-Reply-To, dann References gegen
`mail_deliveries.message_id` ⇒ Vorgang der eigenen Zustellung; (2) genau EINE
Vorgangsnummer `MR-JJJJ-NNNN` in Betreff/Text UND Absenderadresse normalisiert
== E-Mail des Vorgangskunden; (3) unmatched (Konversationszeile ohne Vorgang,
Staff ordnet zu oder ignoriert). Eine E-Mail autorisiert NIE eine Fachaktion –
es entstehen ausschließlich Konversationszeilen, Belege und Fotos.

**Inhalt:** text/plain bevorzugt; HTML-only wird mit einem einfachen,
sicheren Tag-Stripper (kein Rendering, keine HTML-Bibliothek) zu Text:
Script/Style/Head samt Inhalt entfernt, alle Tags (inkl. `<img>` = externe
Bilder) entfernt, Entities dekodiert. Raw-HTML wird nie gespeichert. Limit
20 000 Zeichen (Rest abgeschnitten, Hinweis). Anhänge: nur `image/jpeg`,
`image/png`, `image/webp` mit passenden Magic Bytes (FF D8 FF / 89 50 4E 47 /
RIFF…WEBP) und ≤ 8 MB ⇒ privater Storage-Key
`communication/messages/<messageId>/<uuid>.<ext>` + `message_photos`; alles
andere (PDF/ZIP/Office/SVG/getarnt/unbekannt) wird nie gespeichert – nur
`skippedAttachments` als Zähler im Absender-Snapshot.

**Grenzen/bewusst nicht implementiert:** keine Mailbox-App (nur Absender,
Betreff, Zeit, Vorschau in der Unmatched-Inbox), keine Mail-Löschung/-Ablage,
keine Signatur-/DKIM-Auswertung (Zuordnung ist bewusst konservativ), keine
Inline-Bild-Darstellung aus HTML, kein IDLE/Push (Polling alle 2 min).

## WhatsApp (Meta WhatsApp Business Cloud API, Phase 12 – verifiziert 2026-10-18)

**Quellen:** developers.facebook.com – /docs/whatsapp/cloud-api/guides/send-messages,
/docs/whatsapp/cloud-api/webhooks/components, /docs/whatsapp/cloud-api/guides/set-up-webhooks,
/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint,
/docs/whatsapp/cloud-api/reference/media, /docs/whatsapp/cloud-api/support/error-codes,
/docs/whatsapp/messaging-limits, /docs/whatsapp/throughput, /docs/graph-api/guides/versioning,
/docs/graph-api/webhooks/getting-started. Ausschließlich die offizielle Cloud
API – keine inoffiziellen Bibliotheken, kein Scraping (Auftrag §26).

**Senden:** `POST https://graph.facebook.com/{version}/{phone-number-id}/messages`,
`Authorization: Bearer <token>`, Body `{messaging_product:'whatsapp',
recipient_type:'individual', to, type:'text', text:{preview_url:false, body},
context:{message_id}?}`; Antwort `messages[0].id` bedeutet nur „angenommen“,
nicht „zugestellt“ – der Zustellstatus kommt über `statuses[]`-Webhooks
(sent/delivered/read/failed; Rückschritte werden ignoriert). Host in
production fest `graph.facebook.com`, Version konfigurierbar (Default v26.0,
siehe „Graph-API-Version“ unten; nie „latest“ in der URL).
Fehlerklassifikation: 130429/4/80007/131056/131000/131057 und HTTP 429/5xx
transient (Queue-Retry mit Backoff); 131047 (>24 h, Template nötig) ⇒
`WINDOW_CLOSED` permanent; 131026/131051/100/190/133010/131048–131050/130403 u. a.
permanent (`failed` mit neutralem Code).

**Webhook:** `GET /webhooks/whatsapp` beantwortet den Verify-Handshake
(hub.mode=subscribe, hub.verify_token in konstanter Zeit ⇒ 200 text/plain
hub.challenge; sonst 403). `POST /webhooks/whatsapp` liest den Body als
Rohbytes (eigener Content-Type-Parser, 3 MB Limit – Metas Payload-Maximum),
prüft `X-Hub-Signature-256 = sha256=HMAC-SHA256(App Secret, Rohbytes)` mit
`timingSafeEqual`; ungültig/fehlend ⇒ 401 neutral. Dedupe über
`whatsapp_events` (UNIQUE provider_message_id + event_type); Verarbeitung
idempotent im Request, dann 200 (DB-Fehler ⇒ 500, Meta wiederholt bis 7 Tage).
Ohne Live-Konfiguration (mock/disabled) antworten beide Routen neutral 404.
Bilder (`image.id`) werden NICHT im Request geladen, sondern über den Job
`whatsapp.media_fetch` (`GET /{version}/{media-id}?phone_number_id=…` ⇒
`{url, mime_type, file_size}`, URL 5 min gültig, Download mit Bearer; nur
JPEG/PNG/WebP + Magic Bytes + ≤ 5 MB; 404 der URL ⇒ Retry mit neuer URL).
Andere Typen (document/audio/video/sticker/location/contacts/…) erzeugen nur
eine Hinweiszeile ohne Inhalt. `context.id`/`image.*` sind in der Referenz
nicht vollständig geladen (UNVERIFIED) – das Parsing ist defensiv.

**Zuordnung:** (1) `context.id` = Antwort auf eine eigene Nachricht ⇒ deren
Vorgang; (2) `wa_id` (Ziffern mit Länderkennung) gegen
`customers.phone_normalized` (Kandidaten: wa_id, normalisiert, Variante
49→0) ⇒ genau EIN Kunde UND genau EIN aktiver Vorgang (`open`/`reopened`);
sonst unmatched (eindeutiger Kunde bleibt vermerkt). `whatsapp_contacts`
hält `last_inbound_at` je Nummer = Basis des 24-h-Customer-Service-Windows.

**Staff-Antwort (Recht `whatsapp.reply`):** nur innerhalb von 24 h nach der
letzten Kundennachricht (freie Service-Nachricht); außerhalb 409 mit
„WhatsApp-Antwort derzeit nicht frei möglich. Bitte E-Mail oder Anruf nutzen.“
– keine Templates, keine automatischen WhatsApp-Nachrichten (Erinnerungen,
Angebote etc. laufen NIE über WhatsApp). Empfänger ist immer die wa_id der
letzten eingehenden Nachricht des Vorgangs (kein freies Feld); Versand über
Job `whatsapp.send` nach Commit.

**Umgebungen:** production `live` (alle WHATSAPP_* gesetzt) oder `disabled`,
nie Mock; demo IMMER `MockWhatsAppGateway` („DEMO / simuliert“, kein Request,
keine Secrets erlaubt); development Mock oder Opt-in live (Fake-Host erlaubt).
Secrets (Token, App-Secret, Verify-Token) existieren nur in der Config
(Pino-Redaction); Logs enthalten nur IDs/Typ/Ergebniscode – nie Nummern oder
Inhalte. Smoke `pnpm whatsapp:smoke` nur mit WHATSAPP_SMOKE=true +
WHATSAPP_SMOKE_TO, nie im Gate.

**Graph-API-Version (Finalisierung, verifiziert 2026-10-19):** Quellen
ausschließlich developers.facebook.com: „Graph API changelog“ („The latest
Graph API version is: v26.0“), „Graph API changelog / versions“ (Tabelle),
„Graph API versioning“ (jede Version mindestens zwei Jahre nutzbar; nicht mehr
nutzbare Versionen werden auf die nächstältere nutzbare umgeleitet), WhatsApp
Cloud API Reference „Messages“ (`POST /{Version}/{Phone-Number-ID}/messages`,
Basis `https://graph.facebook.com`) und „Media“ (`GET /<API_VERSION>/<MEDIA_ID>`,
Download der zurückgegebenen URL mit Bearer-Token, URL 5 min gültig; das
offizielle Beispiel nutzt v26.0).

| Version | veröffentlicht | verfügbar bis (laut Meta-Tabelle) |
|---|---|---|
| v26.0 | 2026-07-29 | TBD |
| v25.0 | 2026-02-18 | 2028-07-29 |
| v24.0 | 2025-10-08 | 2028-02-18 |
| v23.0 | 2025-05-29 | 2027-10-08 |
| v22.0 | 2025-01-21 | 2027-05-20 |
| v21.0 | 2024-10-02 | 2027-01-21 |
| v20.0 | 2024-05-21 | 2026-09-24 (abgelaufen) |

Default `WHATSAPP_DEFAULT_GRAPH_API_VERSION = v26.0`. `WHATSAPP_GRAPH_API_VERSION`
darf explizit überschrieben werden; Werte älter als v21.0 (am
Verifikationsdatum abgelaufen) lehnt die Konfiguration ab. Die Meta-Tabelle und
die Zwei-Jahres-Regel des Versioning-Guides weichen bei einzelnen Daten ab
(z. B. v20.0: Tabelle 2026-09-24, Regel 2026-10-02) – maßgeblich ist die
Tabelle; die Version muss bei jedem Meta-Release erneut geprüft werden
(Betriebsaufgabe, DEPLOYMENT_NOTES). Die Cloud-API-Seiten nennen keine
Mindestversion; der WhatsApp-Changelog enthält nur versionsbezogene Hinweise
(„For version 24.0 and newer requests …“).

**Media-Downloadhost (Live-Smoke-Voraussetzung):** Die offiziellen Seiten
nennen für den Medien-Download nur den Platzhalter `<MEDIA_URL>` und keinen
garantierten Host. Der Code bleibt fail-closed: Bearer-Token nur an die
Allowlist (`lookaside.fbsbx.com` + Graph-Basis-Host, keine Wildcards), keine
Redirects, unbekannter Host ⇒ `MEDIA_HOST_NOT_ALLOWED`. **Echten
WhatsApp-Bildempfang vor Go-live gegen Meta-Testaccount prüfen und
tatsächlichen Media-Downloadhost verifizieren.**

**Grenzen/UNVERIFIED/bewusst nicht implementiert:** Marketing-/Utility-
Templates und Opt-in-Regeln (nicht geladen, nicht benötigt), Messaging-
Limits außerhalb des Fensters (nicht relevant – nur Service-Nachrichten),
Lesebestätigungen an Kunden (`mark as read`), Reaktionen, Sticker, Audio/
Video/Dokumente, Flows/Interactive Messages, Payments, Kundenchat-Portal.

