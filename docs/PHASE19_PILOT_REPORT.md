# Phase 19 – Pilotbericht: Pilot-Readiness / produktionsnahe Validierung

Stand: 2026-11-21 · Basis: `main` f947fb5 (Phase 18 FINAL GRÜN) · Ergebnis dieser Phase als
ein Squash-Commit auf `main` (SHA: `git log -1 -- docs/PHASE19_PILOT_REPORT.md`; im Abschlussbericht genannt).

| Bewertung | Ergebnis |
| --- | --- |
| **TECHNICAL PILOT READINESS** | **JA** – auf einem lokalen, produktionsnahen Stand-in (`APP_ENV=staging`, nginx/TLS, S3-Storage, echter SMTP-Adapter gegen TLS-Senke, Worker, Contract-Fakes) vollständig nachgewiesen; alle gefundenen Defekte behoben und mit roten Regressionstests belegt |
| **REAL PILOT EXECUTED** | **NEIN** – es existiert kein Zielsystem (Hosting, Hostnamen, TLS, Postfach), keine Pilotgruppe und keine Freigabe; Phase 19 hat keinen echten Kunden kontaktiert, keinen echten Provider aufgerufen und keine Produktionsdaten angefasst |
| **PHASE 19 FINAL** | **NEIN** – FINAL setzt einen durchgeführten echten Pilot voraus; dafür sind die unten gelisteten Entscheidungen/Freigaben des Inhabers nötig (Blocker, nicht autonom lösbar) |

Phase 20 wurde nicht begonnen. Keine DNS-Änderung, keine Änderung der öffentlichen Website,
WordPress unangetastet, `WEB_INDEXING_ENABLED` in production nicht gesetzt (Default false),
keine Search Console, keine Rechtstexte veröffentlicht, keine Entscheidung zu Google
Reviews/EWR, keine Migration realer Vorgänge.

## 1. Zusammenfassung

- **Pilotumgebung:** Eine echte Staging-/Pilotumgebung gibt es nicht (OPEN_ITEMS „Hosting“: kein
  Server, keine Hostnamen, kein TLS, kein Prozessmanager, keine CI). Das ist ein **Blocker für den
  echten Pilot**; statt so zu tun, wurde ein lokaler Stand-in mit Produktionstopologie gebaut
  (Abschnitt 2) und darauf alles nachgewiesen, was ohne Zielsystem nachweisbar ist.
- **Nachweise:** Fail-closed-Startmatrix 38/38 (API + Worker), nginx-Topologie mit TLS/Cookies/
  X-Forwarded-For/Log-Maskierung, Worker-Betriebsnachweis A–F (Zustellung, Retry/Backoff,
  SIGTERM, SIGKILL + Lease-Recovery, Neustart, Heartbeat, PII 0), S3-Storage 4/4 (zwei Läufe) und
  kompletter Pilot-Stack auf S3 (45 Dokumente byte-identisch), Standard-Pilotvorgang 20/20,
  Edge-Pilotvorgang 26/26, Offline-Pilotvorgang 17/17, 92 Integritätsprüfungen 0
  Verletzungen gegen die Pilot-Datenbank, Backup/Restore mit S3-Variante (Dump + 264 Objekte,
  Restore in neue DB/Bucket, Prüfsummen identisch, API gegen den Restore).
- **Produktbefunde (alle behoben, rot→grün):** Lexware in production aktivierte sich allein durch
  den Schlüssel (P19-F4); Kundeninformation: freigegebene Vorschau ≠ gesendete Mail (P19-F8);
  lange Schadenbeschreibung ⇒ Freigabe 500 (P19-F9); `pnpm routing:smoke` nicht ausführbar
  (P19-F11); Kundenmails sprachen im Listenformat „Hallo Nachname, Vorname,“ an (P19-F12);
  Staff-Proxy schnitt Offline-Sync-Bodies über 10 MiB still ab (P19-F13, Phase-18-Restpunkt);
  Next-Server banden an 0.0.0.0 (P19-F2); Isolations-Check ignorierte die öffentliche Web-Basis
  (P19-F5); `requires_financial_review` unsichtbar (P19-F7); irreführender Passwort-vergessen-Text
  (P19-F6). Neu für den Betrieb: Operator-Sicht auf dead/retrying-Jobs
  mit Worker-Lebenszeichen (P19-F3/F10). Testinfrastruktur: MinIO-Image nicht mehr abrufbar ⇒
  RustFS (P19-F1).
- **Nicht autonom entscheidbar (Freigabepunkte, Abschnitt 17):** Zielsystem/Hosting, Umgebung
  des Piloten (production), Provider-Stufen (Mail-Postfach, Lexware-Steuerkonfiguration),
  Rechtstexte, Pilotgruppe/Umfang/Abbruchkriterien, Backup-Automatisierung, Verantwortliche(r)
  für Go/No-Go (Dennis).

## 2. Pilotumgebung (lokaler Stand-in, produktionsnahe Konfiguration)

| Komponente | Pilot-Stack | Hinweis |
| --- | --- | --- |
| APP_ENV | `staging` (Vorabnahme: keine Defaults, TLS-Pflicht, Opt-in-Fakes erlaubt) | ein echter Pilot mit Kunden läuft in `production` (Training-Gate, Fake-Verbot, Provider-Schalter) |
| Reverse-Proxy | nginx 1.24, TLS mit eigener Test-CA; Hosts `www.pilot.test` (Web + Portal), `app.pilot.test` (Staff), `api.pilot.test` (nur `/webhooks`, `/public/calendar`, `/health`, `/ready`), Apex → www 308, http → https 308, unbekannter Host 444 | Vorlage jetzt in DEPLOYMENT_NOTES „Reverse-Proxy für Staff, Website und API-Direktrouten“ |
| API | Fastify per `tsx`, `API_HOST=127.0.0.1:3401`, `API_TRUST_PROXY_HOPS=1` | wie dokumentiert (tsx-Betrieb ist eine TECH_DECISION) |
| Worker | `tsx`, Poll 1 s, Lease 5 min | eigener Prozess, SIGTERM/SIGKILL-Nachweis Abschnitt 5 |
| Web / Staff | Next-Production-Builds mit eingebackenen Origins (`WEB_API_ORIGIN`/`STAFF_API_ORIGIN` = API), `next start --hostname 127.0.0.1`, Build-Verzeichnisse je Stand (`.next/pilot` … `.next/pilot4`) | P19-F2; Rollback durch Verzeichniswechsel |
| Datenbank | PostgreSQL 18.7 (Docker `mietroyal-postgres`), eigene DB `mietroyal_pilot`, 34 Migrationen frisch angewendet | isoliert von Test-/Demo-Datenbanken |
| Dateispeicher | S3-kompatibel (RustFS 1.0.6, Bucket `mietroyal-pilot`, path-style) | gesamter Stack auf S3, keine fs-Ablage |
| Mail | echter SMTP-Adapter → TLS-Senke `smtp.pilot.test:4565` (E2E-Fake mit Pilot-Zertifikat), IMAP-Poll gegen `imap.pilot.test:4569`, `MAIL_PUBLIC_WEB_BASE_URL=https://www.pilot.test` | keine echte Mail hat den Rechner verlassen |
| Buchhaltung | Lexware-Contract-Fake (signierte Webhooks, Callback über nginx), `LEXWARE_ENABLED=true` (staging-Opt-in) | kein echter Lexware-Aufruf |
| Routing | GraphHopper-Contract-Fake über TLS | kein echter GraphHopper-Aufruf |
| Push | VAPID-Testpaar, Push-Fake | – |
| WhatsApp, Reviews | `disabled` | realistische Pilotstufe |
| Konten/Daten | synthetischer Admin `pilot.admin@pilot.test`, Testkunden `*@*.pilot.test` | keine realen Personen |

Betriebsbedingungen der Sandbox: Docker-Daemon musste nach einem Neustart der Umgebung manuell
gestartet werden; ausgehende Verbindungen laufen über einen HTTPS-Proxy, der für die lokalen
Pilot-Hosts umgangen werden musste (`--noproxy`, Proxy-Variablen für node/Playwright entfernt).

## 3. Deployment-Nachweis (produktionsnah)

- **Fail-closed-Startmatrix (38/38):** 19 Fehlkonfigurationen (production/staging/demo: fehlende
  Secrets, Fakes in production, Schlüssel in demo, http-Basis, ungültige `APP_ENV`, …) × 2
  Prozesse (API, Worker) ⇒ jeweils Exit 1, Fehlermeldung nennt nur den Variablennamen, kein
  Secret im Log.
- **Topologie über TLS:** http→https 308 mit festem Ziel je Host, Apex→www 308, `default_server`
  444, API nur über Direktrouten (alles andere 404), robots ohne Sitemap, `noindex`-Meta ohne
  Canonical (staging), Legacy-Redirect 308 in einem Hop, 410 für entfernte Seiten.
- **Cookies/CSRF/Drosseln:** `__Host-mr_staff_device` (Secure, HttpOnly, SameSite=Strict, 400 d)
  und `mr_staff_session` (30 d) unverändert durch den Proxy; Cross-Site-POST 403; Login-Drossel
  429 nach zehn Fehlversuchen trotz wechselndem `X-Forwarded-For` (Spoofing wirkungslos bei
  `API_TRUST_PROXY_HOPS=1`); Access-Log maskiert Token-Pfade.
- **Lexware-Setup über den Proxy:** `lexware:setup` legte 4 Event-Subscriptions mit Callback
  `https://api.pilot.test/webhooks/lexware` beim Contract-Fake an; signierte Webhooks (3× ⇒
  queued/duplicate/duplicate) kamen im Standardablauf über nginx an.
- **UI-Smoke über TLS (Playwright, Chromium):** Website (200, noindex, kein Canonical, kein
  Demo-Banner), Portal-Anmeldeseite, Staff-Login mit Cookie-Attributen, Kernseiten (Heute,
  Vorgänge, Kalender, Maschinen, Touren, Einstellungen, Kunden), Einstellungen → System,
  mobiler Viewport ohne horizontalen Overflow: 31/32 Prüfungen grün auf dem finalen Baum (Staff-Build
  mit Operator-Sicht und Worker-Lebenszeichen). Einziger roter Punkt:
  Konsolenfehler durch das selbstsignierte Zertifikat (Service-Worker-/Skript-Abruf) –
  Artefakt der Testumgebung, auf einem Zielsystem mit gültigem Zertifikat nicht vorhanden.

## 4. Storage-Nachweis

- Der Phase-18-Restpunkt „S3-Test nicht ausführbar“ hatte eine externe Ursache: `minio/minio:latest`
  ist weder auf Docker Hub noch quay.io anonym abrufbar; der direkte Download der MinIO-Binary
  wurde von der Umgebungsrichtlinie der Sandbox abgelehnt und nicht umgangen. Entscheidung P19-F1:
  Dienst `s3` mit `rustfs/rustfs:1.0.6` (Apache-2.0, S3-API), gleicher Port/Zugangsdaten,
  Healthcheck.
- `packages/integrations/test/s3-storage.integration.test.ts`: 4/4 grün (drei Läufe, zuletzt im
  Gate) gegen `pnpm infra:up`.
- Pilot-Stack vollständig auf S3: zum Zeitpunkt der Integritätsprüfung 45 Dokumente (Angebote,
  Protokolle, Lieferscheine, Rechnungen) im Bucket, am Ende 123; Download über API und
  Kundenportal byte-identisch; Integritätsprüfung `documents ↔ Storage` (SHA-256, Bytes) 0
  Abweichungen, Backup/Restore 123/123.

## 5. Worker / Jobs

Nachweis mit dem laufenden Pilot-Worker über Portal-Anmeldelinks an dedizierte Testkunden und
empfängerbezogene SMTP-Störungen der Senke (Zeiten UTC, Protokoll im Arbeitsverzeichnis):

| Schritt | Ergebnis |
| --- | --- |
| A Baseline | `mail.send` ⇒ Zustellung in der Senke +1 |
| B 2× SMTP 450 (RCPT) | Wiederholung auf Zustellungsebene (je Versuch ein eigener `mail.send`-Job, Backoff 1 min, 2 min), Erfolg beim 3. Versuch, genau eine Zustellung |
| C 6× SMTP 450 | Zustellung `retry`, 5 Versuche in 900 s beobachtet (Backoff 1·2ⁿ min), nächster Versuch nach 16 min; kein PII im Fehlertext; keine Zustellung. Endzustand `failed` (8 Versuche ≈ 127 min) im Zeitfenster nicht beobachtet – durch Phase-12-Tests abgedeckt |
| D SIGTERM während Job | Verbindungsabbruch nach DATA ⇒ Zustellung `outcome_unknown` (RA-2: nie automatischer Doppelversand); Worker beendete in 1 s, 0 Jobs in `processing` |
| E SIGKILL während Job | Job blieb `processing` (Lease 5 min); Neustart mit gültiger Lease ⇒ keine Doppelverarbeitung; nach Lease-Ablauf „Verwaiste Jobs freigegeben (reclaimed=1)“, Job erfolgreich beim 2. Versuch; Zustellung `outcome_unknown` ohne Doppelversand (Ausgang des abgebrochenen SMTP-Dialogs unbekannt) |
| F Neustart mit 2 wartenden Jobs | beide verarbeitet (+2); Heartbeat-Job der Stunde genau einmal trotz mehrerer Neustarts |
| PII | 0 Kundenadressen, 0 Token-Fragmente im Worker-Log |

Erkenntnis für das Runbook: Mail-Wiederholungen leben in der Outbox (`mail_deliveries`), nicht in
Job-Versuchen; `mail.send`-Jobs enden `succeeded`. Ein dauerhaft gestörter Versand ist unter
Einstellungen → Kommunikation (`retry`/`failed`/`outcome_unknown`) sichtbar, nicht als dead-Job.

**Operator-Sicht (neu, P19-F3/F10):** `GET /staff/system/jobs` (Recht `system.settings`) und
Einstellungen → System: Zählstände, dead-/retrying-Jobs mit Typ, Versuchen, Fehlerzusammenfassung,
nur UUID-Referenzen (nie Adressen/Inhalte), Betriebsanweisung je Jobfamilie, Worker-Lebenszeichen
(letzter Erfolg, ältester fälliger Job; „Worker verarbeitet nicht“ ab 5 min Rückstand); zusätzlich
Log-Zeile `Job endgültig fehlgeschlagen (dead)` (Fehlerlevel, alarmierbar). Tests P19-J1–J4, Runner-
Test. Jobstatus wurden nie per SQL verändert.

## 6. Monitoring / Observability

Vorhanden und im Pilot nutzbar (DEPLOYMENT_NOTES „Betrieb im Pilot“): `/health` (mit Umgebung),
`/ready` (Datenbank), Einstellungen → System (Jobs, Worker-Lebenszeichen), Einstellungen →
Kommunikation (Outbox, Erneut senden), Einstellungen → Lexware (Verbindung/Webhooks),
`staff_security_events`, pino-JSON-Logs mit Redaction (API/Worker), nginx-Access-Log mit
Token-Maskierung; tägliche Routine beschrieben. Nicht vorhanden (Zielsystem): Uptime-Check,
Alarmkanal, Log-Aggregation/-Retention – als Freigabe-/Einrichtungspunkt gelistet. `/ready` prüft
bewusst nur die Datenbank (Storage/SMTP-Ausfälle erscheinen fachlich mit 5xx/Outbox-Status).

## 7. Backup- / Restore-Readiness

Nachgewiesen am Pilot-Stack (S3-Variante, Worker für den Sicherungszeitraum gestoppt, API lief
weiter): `pg_dump -Fc` der Pilot-Datenbank im Container (733 KB; 54 Kunden, 51 Vorgänge, 51
Buchungen, 123 Dokumente, 22 Abrechnungen, 448 Jobs, 193 Mailzustellungen, 34 Migrationen) und
Export aller 264 Bucket-Objekte (840 KB) mit Manifest (Schlüssel, Bytes, SHA-256); Sicherung mit
265 Prüfsummen. Restore in eine NEUE Datenbank und einen NEUEN Bucket: `pg_restore` ohne Meldung,
264 Objekte importiert; Vergleich: Tabellen-Prüfsummen identisch (121 Zeilen), Zählstände identisch,
Storage-Manifest identisch (264/264, 0 abweichend, 0 zusätzlich), 123/123 `documents` mit
identischem SHA-256/Bytes im Restore-Bucket; `db:migrate` gegen den Restore = No-op (34);
API gegen den Restore auf eigenem Port mit gleichen Schlüsseln: `/health` 200, `/ready` 200,
Admin-Login 200, 51 Vorgänge über die API = Datenbank, Angebots-PDF byte-identisch (SHA-256,
`%PDF`), Cross-Site-Login 403, keine Fehlerzeilen im API-Log; Worker danach wieder gestartet (die
Restore-API lief nach dem Skriptende noch weiter – das Skript hatte nur den Wrapper-Prozess beendet –
und wurde anschließend als Prozessgruppe manuell gestoppt; Skript entsprechend zu korrigieren).
Schlüssel (`AUTH_SECRET_KEY`, `COMMUNICATION_PAYLOAD_KEY`) sind Teil der Sicherung (ohne sie sind
TOTP-Secrets, Offline-Leases und verschlüsselte Mail-Payloads unbrauchbar). Automatisierung,
Zeitplan und Off-site-Kopie gehören zum Zielsystem (offen).

## 8. Rollback-Plan

DEPLOYMENT_NOTES „Rollback im Pilot (Phase 19)“: Git-Tag je Pilot-Stand und `tsx`-Neustart für
API/Worker; Web/Staff über behaltene Build-Verzeichnisse (Sekunden); Datenbank additiv/idempotent,
Rücknahme einer Migration nur über Restore des Vor-Release-Backups (Datenverlust seit Backup,
Migration 0024 nicht umkehrbar); Provider-Kill-Switches (`MAIL_ENABLED`, `LEXWARE_ENABLED`,
`ROUTING_PROVIDER`, `WHATSAPP_ENABLED`, `REVIEWS_PROVIDER`); Pilot-Abbruch ohne Datenlöschung.
Nicht rückrollbar: Außenwirkungen (Mails, Rechnungen) – deshalb Provider bis zur Freigabe aus.

## 9. Pilotgruppe

Keine Kunden oder Mitarbeitende ausgewählt oder angeschrieben (nicht autonom). Vorbereitet:
Rollen/Rechte für eine Pilotgruppe (Nursicht, Kollege mit `damage.set_cost`/`settlement.release`,
Admin) wurden im Edge-Ablauf über die Staff-Admin-API geprüft; Offline-Lease/Geräte-Bindung im
Offline-Ablauf. Entscheidung Umfang/Dauer/Abbruchkriterien: Inhaber (PRE_START_CHECKLIST).

## 10. Echter Pilot durchgeführt

**NEIN.** Gründe: kein Zielsystem (Hosting, Hostnamen, TLS, Firewall), kein Mail-Postfach (ohne
SMTP kein Portal-Login, keine Angebote/AB), Lexware-Steuerkonfiguration offen (production ist
fail-closed), Rechtstexte nicht freigegeben, keine Pilotgruppe, keine Freigabe durch Dennis.

## 11. Standard-Pilotvorgang (20/20 Schritte, HTTPS/nginx, Worker, Fakes, lesende DB-Prüfung)

Anfrage (Website-Pfad fail-closed wegen `PRIVACY_NOT_PUBLISHED` ⇒ Staff-Anfrage), Angebot
erstellen + senden (Doppelversand 409), Angebotsmail in der Senke, Online-Annahme über den
öffentlichen Link (2× parallel + 1× danach: genau eine Annahme), Auftragsbestätigung (Doppelklick
409), Preisfreeze (Kundenänderung ⇒ Snapshots byte-identisch), Termine (Versionskonflikt 409),
Maschinenzuweisung/Vorbereitung, Übergabe (Finalize 2×, Lieferschein + Protokoll + Mail), Rückgabe
(Finalize 2×, Protokoll + Mail), Abrechnung (genau ein Transferjob), Lexware-Transfer über den
Worker (genau EINE Rechnung im Fake), Rechnungsmail genau einmal mit PDF, Kundenportal vor Zahlung
(Magic Link aus der Senke, PDF byte-identisch), Zahlung über signierten Webhook (3× ⇒ queued/
duplicate/duplicate, paid), Reinigungsabschluss ⇒ Gutschein + Gutscheinmail (Wiederholungen ohne
Wirkung), Portal nach Zahlung (Regel B), Abschlussprüfung (Historie, Mails je Art genau einmal,
Jobs, Dokumente byte-identisch). Endzustand: Vorgang `completed`, Abrechnung `transferred/locked/
paid`, Rechnung RE20260006.

## 12. Edge-Pilotvorgang (26/26 Schritte)

Staff-Storno 10 Tage vor dem Event (50 % half-up, eine Transaktion: Termine storniert, Zuordnung
gelöst, Maschine frei; zweiter und zwei parallele POSTs idempotent; genau ein Transferjob), Rechte
ohne Nebenwirkung (Nursicht 403 ohne Zeile), Kundenstorno über das Portal (Magic Link aus der
Senke; Gebühr an den angezeigten Wert gebunden: falscher Prüfwert 409 ohne Zeile), Blocker
„Maschine ausgegeben“, „Rückgabe existiert“, „abgeschlossener Vorgang“ (409 ohne Zeile), Rückgabe
mit Schaden (Pflichtfoto blockiert Finalisierung; parallele Doppel-Finalisierung ⇒ genau ein
Finalize), Kostenentscheid (Admin + Kollege gleichzeitig ⇒ ein 200, ein 409 VERSION_CONFLICT),
Kundeninformation (vorbereitet ohne Fristtext; Freigabe reiht ein; erst der bestätigte Versand
startet die 24-h-Frist und plant den Auto-Job; zweite Freigabe 409; genau eine Mail), Portal der
Kundin während offener Klärung ohne Beträge/Schäden, Rechte-Negativmatrix im Wartefenster,
Kundenrückmeldung (gleichzeitig ⇒ ein 200, ein 409), „wie berechnet freigeben“ ⇒ kein
Auto-Transfer, Reinigung, Invarianten des Laufs. Beobachtungen: Vorschau ≠ Mail (⇒ P19-F8
behoben); Staff-Storno sendet die Stornokostenrechnung automatisch, die Stornobestätigung ist
manuell (Design, Runbook-Hinweis). Nicht beobachtet: „fälliger Auto-Job überspringt“ (24-h-Frist
läuft real weiter; kein SQL-Backdating erlaubt). Ein erster Lauf hatte zwei rote Teilprüfungen in
C1: der Testablauf las den Zwischenzustand `queued` erst, nachdem der Worker (Poll 1 s) bereits
zugestellt hatte – Race des Prüfskripts, kein Produktfehler; der Ablauf wurde korrigiert und
komplett wiederholt (26/26).

## 13. Offline-Pilotvorgang (17/17 Schritte, Phase-18-Zyklus E1–E7 über den Pilot-Stack)

Offline-Lease (72 h, Ed25519-Claim verifiziert, Rechte-Snapshot nur operativ), Arbeitspaket mit
Datenminimierung (Tiefenscan der Feldliste: Kontakt nur Name/Telefon/Lieferadresse),
Offline-Übergabe mit 8 Mutationen (applied ⇒ finalisiert, Dokumente, Lager, Mail), Replay aller 8
Mutationen (deduplicated, identische resultRef, keine zweite Wirkung), dieselbe `clientMutationId`
zweimal parallel ⇒ genau eine Anwendung, zwei Geräte mit zwei Leases konkurrieren ⇒ Verlierer
`ALREADY_FINALIZED`, serverseitige Umzuweisung ⇒ `MACHINE_REASSIGNED`, vermietete Maschine ⇒
`MACHINE_UNAVAILABLE`, verschobener Termin ⇒ `APPOINTMENT_CHANGED`/`SERVER_STATE_CHANGED`, Rechte
entzogen ⇒ `PERMISSION_REVOKED`, fremde Umgebung „demo“ ⇒ 409 `ENVIRONMENT_MISMATCH` + Security-
Event ohne Quittung, Invarianten (Quittungen konsistent und ohne Kundendaten, Zuordnungen/
Maschinen, Integritäts-SQL), Aufräumen ausschließlich über Fach-APIs (Rückgabe + Reinigung, Leases
widerrufen, Konto deaktiviert). 18 Offline-Mutationen mit Quittung; Buchungen MR-2026-0024 bis
MR-2026-0028. Keine Beobachtungen. Auf dem finalen Baum wiederholt (17/17); ein Zwischenlauf
scheiterte an einem erschöpften Maschinenpool („kein Maschinentyp mit ≥ 2 freien Maschinen“ –
Maschinen aus früheren Testläufen in Reinigung bzw. durch unfertige Testbuchungen reserviert); die
Freigabe erfolgte ausschließlich über die Fach-API (Reinigungsabschluss, Staff-Storno), nie per SQL.

## 14. Provider-Matrix (Pilot-Stack / Pilot-Empfehlung)

| Provider | Pilot-Stack | Echter Pilot (Empfehlung, Entscheidung Inhaber) | Rollback |
| --- | --- | --- | --- |
| Mail SMTP/IMAP | echter Adapter → TLS-Senke/IMAP-Fake | live (Postfach, SPF/DKIM/DMARC, `pnpm mail:smoke` an eigene Adresse) – ohne Mail kein Portal/Angebot | `MAIL_ENABLED=false` |
| Lexware | Contract-Fake, Opt-in | `LEXWARE_ENABLED=true` erst nach Steuerkonfiguration + Testaccount-Smoke; sonst `false` (Transfers warten) | `LEXWARE_ENABLED=false` |
| Routing GraphHopper | Contract-Fake | `disabled` bis Vertragsprüfung/Plan; `routing:smoke` jetzt lauffähig (P19-F11) | `ROUTING_PROVIDER=disabled` |
| Web-Push | VAPID-Testpaar, Fake | aktiv mit VAPID je Umgebung (informativ, at-least-once) | Schlüssel entfernen |
| WhatsApp | disabled | disabled (kein WABA) | – |
| Google Reviews | disabled | disabled (EWR offen) | – |
| Zahlung | nur Lexware-Zahlungsstatus (Webhook) | wie Lexware | – |

Kein echter Provider wurde in Phase 19 aufgerufen; Live-Provider wurden nie allein wegen
vorhandener Credentials genutzt (es lagen keine vor).

## 15. Phase-18-Restpunkte – Neubewertung

| Punkt | Bewertung | Status |
| --- | --- | --- |
| `post_return_finding` nach gesperrter Abrechnung | Flag jetzt in der Maschinenansicht sichtbar (P19-F7), Kontroll-SQL; Nachberechnung bleibt Fachentscheidung | **deferred** (fachlich), beobachtbar |
| Tour-Übernahme `expectedVersion` optional | Staff-App sendet immer die Version; keine anderen Clients | **accepted** |
| dead-Jobs unsichtbar | Operator-Sicht + Log-Signal + Worker-Lebenszeichen (P19-F3/F10) | **resolved** |
| Push at-least-once | rein informativ, kein Fachzustand | **accepted** |
| S3-Test nicht ausführbar | RustFS, 4/4, Pilot-Stack auf S3 | **resolved** |
| Online-Schäden `clientMutationId` optional | Staff-App sendet immer; keine anderen Clients | **accepted** |
| Rate-Limits prozesslokal | genau eine API-Instanz hinter Proxy (Topologie); vor Skalierung Store nötig | **accepted** (Pilot) |
| Staff-Session-Cookie ohne `__Host-` | Schwester-Subdomains unter Kontrolle des Inhabers; dokumentiert | **accepted** |
| Staff-Proxy-Body-Limit 10 MiB < Offline-Sync 12 MiB | Puffer 13 MiB wie Web (P19-F13), Test | **resolved** |
| Egress nur per Firewall | Allowlist-Vorgabe in PRE_START_CHECKLIST; kein Code-Block | **blocker** (Zielsystem) |
| WebKit/PWA-Smoke | WebKit (2336) installiert; `pwa-smoke` im Phase-19-Gate ausgeführt: 1/1 (PWA-Grundstart, IndexedDB, Offline-App-Shell, Sync-Status) | **resolved** (Nachweis im Gate; iOS-Gerätetest bleibt Pilotaufgabe) |
| Backup-Automatisierung | Verfahren inkl. S3-Variante nachgewiesen; Automatisierung/Off-site = Zielsystem | **blocker** (Zielsystem) |
| Lexware-Aktivierung allein per Key | Opt-in + Pflichtfelder (P19-F4) | **resolved** |
| Isolations-Check ohne Web-Basis | Regel ergänzt (P19-F5) | **resolved** |

## 16. Incidents und Befunde (mit Schwere)

| ID | Schwere | Befund | Ergebnis |
| --- | --- | --- | --- |
| P19-F1 | medium (Testinfra) | MinIO-Image nicht abrufbar, Binary-Download von der Sandbox-Richtlinie abgelehnt | RustFS im Compose, S3-Test 4/4 |
| P19-F2 | medium | `next start` ohne `--hostname` bindet an 0.0.0.0 | Start-Skripte auf Loopback |
| P19-F3 | – (Betrieb) | dead-Jobs für Operatoren unsichtbar | Operator-Sicht, Log-Signal, Tests |
| P19-F4 | high | Lexware in production allein durch Schlüssel aktiv, `LEXWARE_ENABLED=false` kein Kill-Switch | Opt-in + Pflicht Organisation/Callback; Tests P19-L1–L3 |
| P19-F5 | medium | Isolations-Check verglich `MAIL_PUBLIC_WEB_BASE_URL` nicht | Regel + Test P19-I1 |
| P19-F6 | low | Passwort-vergessen versprach eine E-Mail, die außerhalb development nie kommt | ehrlicher Text + Hinweis auf Admin-Reset-Link |
| P19-F7 | medium | `requires_financial_review` nirgends sichtbar | Badge in der Maschinenansicht |
| P19-F8 | low (Produkt) | freigegebene Kundeninformation ≠ gesendete Mail (Betreff, Form) | eine Quelle (Mailvorlage) für Vorschau und Versand; Tests |
| P19-F9 | medium (Produkt) | Schadenbeschreibung > ~250 Zeichen ⇒ Freigabe 500 | Kontextvertrag 2600; Test (2000 Zeichen) |
| P19-F10 | – (Betrieb) | kein Worker-Lebenszeichen | Signal aus der Queue; Test P19-J4 |
| P19-F11 | medium (Werkzeug) | `pnpm routing:smoke` brach ohne globale Drossel ab | DB-Verbindung im Skript; Kindprozess-Test rot→grün |
| P19-F12 | low (Produkt, kundensichtbar) | Kundenmails sprachen mit dem Listen-Anzeigenamen an („Hallo Kommerz, Klara,“) | `mailRecipientName` an allen Mail-Stellen; Unit- + Integrationstest rot→grün |
| P19-F13 | medium (Phase-18-Restpunkt) | Staff-Proxy puffert 10 MiB, Offline-Sync erlaubt 12 MiB ⇒ stilles Abschneiden | `proxyClientMaxBodySize` 13 MiB wie Web; Konfigurationstest rot→grün |
| Beobachtung | info | Edge-Lauf 3 auf dem finalen Baum: Übergabe-Finalisierung 409 „Lagerbestand prüfen“ (Verbrauchsmaterial nach vielen Läufen aufgebraucht) | korrektes Fail-closed; Bestand per Staff-API-Inventur aufgefüllt, Wiederholung 26/26 |
| Beobachtung | info | Offline-Wiederholung: Maschinenpool durch frühere Testläufe erschöpft (3 in Reinigung, 3 durch unfertige Testbuchungen reserviert) | Fach-API (Reinigungsabschluss, Staff-Storno), Wiederholung 17/17 |
| Beobachtung | info | Staff-Storno: Rechnung automatisch, Bestätigung manuell | Runbook-Hinweis |
| Beobachtung | info | Edge C1 erster Lauf: Race des Prüfskripts mit dem Live-Worker | Ablauf korrigiert, 26/26 |
| Beobachtung | info | Worker-Nachweis C/E: Skript-Erwartungen (Job `dead`, +1 nach SIGKILL) passten nicht zur Outbox-Semantik (Zustellungs-Retry, `outcome_unknown` ohne Doppelversand) | Systemverhalten korrekt, Erwartung dokumentiert |
| Sandbox | info | Docker-Daemon nach Umgebungsneustart gestoppt; HTTPS-Proxy für lokale Hosts | manuell behoben, keine Codeänderung |

## 17. Freigabepunkte für den Inhaber (Dennis) – nicht autonom

1. Zielsystem/Hosting mit Hostnamen, TLS, Firewall/Egress-Allowlist, Prozessmanager, Secret-Ablage.
2. Umgebung des Piloten (`production`) und `pnpm check:env-isolation` für alle Paare.
3. Provider-Stufen: Mail-Postfach (SPF/DKIM/DMARC, `mail:smoke`), Lexware (`LEXWARE_ENABLED` erst
   nach Steuerkonfiguration + Testaccount-Smoke), Routing/WhatsApp/Reviews `disabled`.
4. Rechtstexte juristisch freigegeben und veröffentlicht (Website-Anfrage/Portal fail-closed).
5. Pilotgruppe, Umfang, Dauer, Abbruchkriterien, Rollback-Entscheidung schriftlich.
6. Backup auf dem Zielsystem durchspielen, Zeitplan + Off-site; Restore-Test wiederholen.
7. Beobachtung: Uptime-Check, Alarm auf dead-Zeile, tägliche Routine, Verantwortliche(r).

## 18. Produktfixes, Dateien, Migrationen

Produktfixes: P19-F2, F4, F5, F6, F7, F8, F9, F11, F12, F13; Betriebsfunktionen: P19-F3, F10;
Testinfrastruktur: P19-F1. Migrationen: **keine** (kein Schemawechsel). Geänderte/neue Dateien:


Geändert:

  - `README.md`
  - `apps/api/scripts/routing-smoke.ts`
  - `apps/api/src/app.ts`
  - `apps/api/src/cancellation/cancellation-service.ts`
  - `apps/api/src/commerce/confirmation-service.ts`
  - `apps/api/src/commerce/offer-service.ts`
  - `apps/api/src/communication/invoice-delivery-job.ts`
  - `apps/api/src/communication/mail/templates/contexts.ts`
  - `apps/api/src/communication/mail/templates/index.ts`
  - `apps/api/src/communication/reminders/service.ts`
  - `apps/api/src/communication/transactional/keys.ts`
  - `apps/api/src/communication/transactional/mailers.ts`
  - `apps/api/src/communication/voucher-delivery-job.ts`
  - `apps/api/src/handover/handover-service.ts`
  - `apps/api/src/returns/return-service.ts`
  - `apps/api/src/routes/offline.ts`
  - `apps/api/src/settlement/notice-text.ts`
  - `apps/api/src/settlement/settlement-service.ts`
  - `apps/api/test/communication-templates.test.ts`
  - `apps/api/test/settlement-notice-wait.integration.test.ts`
  - `apps/staff/app/einstellungen/page.tsx`
  - `apps/staff/app/maschinen/[id]/page.tsx`
  - `apps/staff/app/passwort-vergessen/page.tsx`
  - `apps/staff/next.config.ts`
  - `apps/staff/package.json`
  - `apps/web/package.json`
  - `docs/DECISIONS_LEDGER.md`
  - `docs/DEPLOYMENT_NOTES.md`
  - `docs/ENVIRONMENTS.md`
  - `docs/OPEN_ITEMS.md`
  - `docs/PERMISSIONS.md`
  - `docs/PRE_START_CHECKLIST.md`
  - `docs/TECH_DECISIONS.md`
  - `docs/TEST_PLAN.md`
  - `infra/docker-compose.yml`
  - `packages/config/src/isolation.ts`
  - `packages/config/src/load-config.ts`
  - `packages/config/test/demo-links.test.ts`
  - `packages/config/test/load-config.test.ts`
  - `packages/integrations/src/jobs/runner.ts`
  - `packages/integrations/test/runner.test.ts`
  - `packages/integrations/test/s3-storage.integration.test.ts`

Neu:

  - `apps/api/src/routes/system-jobs.ts`
  - `apps/api/src/system/…`
  - `apps/api/test/mail-recipient-name.test.ts`
  - `apps/api/test/routing-smoke-script.integration.test.ts`
  - `apps/api/test/staff-proxy-body-limit.test.ts`
  - `apps/api/test/system-jobs.integration.test.ts`
  - `apps/staff/app/einstellungen/system/…`
  - `apps/staff/lib/system-jobs.ts`
  - `docs/PHASE19_PILOT_REPORT.md`


## 19. Tests – tatsächlich ausgeführt

| Lauf | Ergebnis |
| --- | --- |
| Fail-closed-Startmatrix API/Worker (Pilot-Stack) | 38/38 |
| `s3-storage.integration.test.ts` gegen RustFS | 4/4 (drei Läufe; der erste Gate-Aufruf fand wegen falscher Vitest-Konfiguration keine Testdatei und wurde mit der Integrationskonfiguration wiederholt) |
| Queue-Integrationstest (`postgres-queue`) | 11/11 |
| Config-Tests (`load-config`, `demo-links`) | 74/74 |
| `runner.test.ts` (dead-Signal) | 26/26 (Paket integrations) |
| `system-jobs.integration.test.ts` P19-J1–J4 | 4/4 |
| `communication-templates.test.ts` (inkl. Vorschau = Versand) | 30/30 |
| `settlement-notice-wait.integration.test.ts` (inkl. P19-F8/F9) | 17/17 |
| `routing-smoke-script.integration.test.ts` | rot (Original) → grün (Fix) |
| `mail-recipient-name.test.ts` (P19-F12) + Anrede-Assertions in `settlement-notice-wait` | rot → grün |
| `staff-proxy-body-limit.test.ts` (P19-F13) | rot → grün |
| API-Unit-Suite (`apps/api`, 22 Dateien) | 221/221 |
| Nachbarschaft: settlement-*, communication-*, demo-seed, lexware-transfer, system-jobs | 449/450 (der eine Fehlschlag war der noch unfertige J4-Test, danach 4/4) |
| Nachbarschaft nach P19-F12 (breite Teilmenge, Hintergrund) | abgebrochen zugunsten des vollständigen Integrationslaufs im Gate (zwei Cross-Environment-Tests meldeten dort Fehler, weil der Teillauf ohne zweite Testdatenbank gestartet war – im Gate mit beiden Datenbanken) |
| Worker-Nachweis A–F + PII | wie Abschnitt 5 |
| Standard-Pilotvorgang / Edge-Pilotvorgang / Offline-Pilotvorgang | 20/20 · 26/26 · 17/17 – alle drei auf dem finalen Baum nach Neustart von API/Worker/Staff wiederholt: 20/20, 26/26, 17/17 |
| 92 Integritätsprüfungen + Dokumente↔S3 gegen `mietroyal_pilot` | 0 Verletzungen, 0 Abweichungen |
| UI-Smoke über TLS (finaler Baum, 32 Prüfungen) | 31/32 (rot nur Konsolenfehler der Test-CA) |
| Backup/Restore (S3-Variante) | OK (Prüfsummen/Zählstände/Objekte identisch, 123/123 Dokumente, API gegen Restore) |
| Gate – Integrationslauf 1 (176 Dateien) | 1948/1953: 5 Fehlschläge in EINER Datei (`acceptance-damage-objection`, Phase-18-Szenario C) – veraltete Erwartung „45,00 EUR“ an die Vorschau, die seit P19-F8 das Mailformat „45,00 €“ trägt; Folgefehler C2–C6 durch den abgebrochenen Ablauf. Erwartung an das Mailformat angepasst (Betrag weiterhin geprüft), Datei 12/12; vollständige Wiederholung des Integrationslaufs auf dem finalen Baum (Lauf 2, 18:37–19:3x Uhr): 176/176 Dateien, 1953/1953 Tests grün, EXIT 0 |
| Gate – PII-Scan der Smoke-/Backup-/E2E-API-Logs | erster Durchlauf meldete 1 „Telefonnummer“: Fehlalarm der Heuristik (Antwortzeit `…0145050000001` im Log passte auf das Muster `01…`); Muster um eine Ziffern-/Punkt-Grenze geschärft, danach 0 Treffer in allen Kategorien (E-Mail, Telefon, Seed-Namen, Passwörter, Token-Pfade, Cookie-/Authorization-Header, Base64-Bilder) |
| Gate – static (Format, Lint, Typecheck, Unit alle Pakete) | alle EXIT 0; Unit 667 Tests (permissions 13, config 74, web 136, domain 115, validation 27, offline 54, integrations 26, api 222) |
| Gate – Migrationen (leere DB, zweiter Lauf idempotent, Journal = SQL-Dateien) | 34/34, zweiter Lauf „nothing to migrate“ |
| Gate – envcheck (Isolations-Fixturepaare) | 13/13 |
| Gate – Smoke (API + Worker development, fs-Storage) | api-errors 0, worker-errors 0, Anfrage ohne Rechtstexte 409 PRIVACY_NOT_PUBLISHED |
| Gate – Backup/Restore fs-Variante (Phase-18-Verfahren) | OK |
| Gate – Builds (`pnpm build`, Web + Staff) | EXIT 0 |
| Gate – E2E-Kette (13 Playwright-Projekte, Chromium) | alle EXIT 0: chromium_full 180 (7 skipped), seo 50, iso_website 17, iso_website_demo 4, iso_portal 15, iso_tours 19, iso_comm 20, iso_offline 21, iso_voucher 11, iso_p14live 1 (7 skipped), demo 28 (1 skipped), lexware 16, production-gates 3 ⇒ 385 passed, 15 skipped (Skips wie in Phase 18: umgebungsabhängige Live-Pfade) |
| Gate – WebKit `pwa-smoke` (Desktop Safari, WebKit 2336) | 1/1: PWA-Grundstart, IndexedDB, Offline-App-Shell, Sync-Status (1,7 min) |
| Gate – Lighthouse (Production-Build, mobil `/`, `/slushmaschine-mieten`, `/konfigurator`; Desktop `/`) | Performance 96 / 98 / 99 (Desktop 100), Accessibility 100, Best Practices 100, SEO 100; CLS 0,000; mobile LCP 2,07 s / 2,05 s / 1,56 s (Phase 18: 98/98/98 – Schwankung unter paralleler Last) |
| Gesamt-Gate auf dem finalen Baum (16:37–18:36 Uhr) | alle Schritte grün bis auf Integrationslauf 1 (eine veraltete Erwartung, s. o.); Integrationslauf 2 nach der Korrektur 1953/1953 grün ⇒ **Gate grün** |

Fehlgeschlagene/wiederholte Läufe: Edge C1 (Race des Prüfskripts, korrigiert, kompletter
Wiederholungslauf 26/26); Edge auf dem finalen Baum zweimal rot durch Testdaten (Betragsformat
„45,00 €“ nach P19-F8 im Prüfskript nachgezogen; Lagerbestand aufgebraucht ⇒ Inventur per
Staff-API), danach 26/26; Offline-Wiederholung mit erschöpftem Maschinenpool (Fach-API), danach
17/17; P19-J4 (401 durch falsche Cookie-Nutzung im Test, korrigiert); P19-F8/F9/F11/F12/F13
bewusst rot vor dem Fix; breite Integrations-Teilmenge im Hintergrund abgebrochen (ohne zweite
Testdatenbank gestartet) und durch den vollständigen Integrationslauf im Gate ersetzt; S3-Gate-
Schritt mit falscher Konfiguration wiederholt; Gate-Integrationslauf 1 mit 5 Fehlschlägen in einem
Phase-18-Szenariotest (veraltete Erwartung an das Vorschau-Betragsformat nach P19-F8; Erwartung
nachgezogen, vollständiger Lauf wiederholt); UI-Smoke Konsolenfehler durch Test-CA. Keine
Assertion wurde abgeschwächt, kein Test entfernt, keine Sleeps/Retry-bis-grün.

## 20. Nicht getestet / Restrisiken / Go-live-Blocker

**Nicht getestet:** echte Provider (SMTP/IMAP-Postfach, Lexware-Account, GraphHopper, WhatsApp,
Push-Dienste), Website-Anfrage über den öffentlichen Pfad (Rechtstexte), Auto-Transfer nach Ablauf
der 24-h-Frist in Echtzeit, Mail-Endzustand `failed` nach 8 Versuchen live, horizontale
Skalierung, Verhalten eines echten Hosters/Proxys/CDN, Zertifikatsautomatik, Backup-Zeitplan.

**Restrisiken (Pilot):** kein Egress-Block im Code (nur Firewall); Rate-Limits prozesslokal;
`WEB_APP_ENV` fehlt ⇒ stilles development (Checkliste); Operator-Skripte mit impliziten
Migrationen/Jobwirkung (Checkliste); staging ohne Mail-Whitelist (Pilot in production);
`outcome_unknown`-Zustellungen brauchen manuelle Entscheidung; Pilotvorgänge in production nicht
markierbar; Rechtstexte/Logo/Kontaktdaten unbestätigt.

**Go-live-Blocker Phase 20 (unverändert, aus Phase 18 + 19):** Hosting/DNS/TLS/Firewall,
Mail-Betrieb, Buchhaltungs-Steuerkonfiguration und Lexware-Smoke, Rechtstexte, Backup-
Automatisierung, Monitoring/Alarm, Google Reviews/EWR, Routing-Vertrag, benannte Freigabe.
