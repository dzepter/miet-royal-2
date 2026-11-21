# Phase 18 – Gesamt-Abnahmetest / systemweite Endabnahme (Abnahmebericht)

Stand: 2026-11-21. Basis-Commit main `68137587540cc515b20920f09df81bcec37d2cc6` (Phase 17 FINAL).
Umfang: nur Phase 18 (keine Pilot-/Go-live-Schritte, kein DNS, keine Live-Website, keine echten
Provider, keine Produktivdaten). Entscheidungen: docs/TECH_DECISIONS.md „Phase 18“;
Testübersicht: docs/TEST_PLAN.md „Gesamt-Abnahme (Phase 18)“; offene Punkte: docs/OPEN_ITEMS.md
„Phase 18“.

Arbeitsweise: Zuerst wurde das gesamte Repository (Spezifikation, Fachregeln, Rechte, Datenmodell,
Tests, Umgebungs- und Deployment-Dokumente) gelesen und eine interne Abnahmematrix
(Anforderung → Implementierung → bestehender Test → fehlender Test → Ebene → erwartetes Ergebnis →
Berechtigung → Umgebung → Persistenz/Audit) erstellt; erst danach wurden Tests ergänzt. Jeder
Produktbefund wurde reproduziert (roter Test), minimal behoben und mit Regressionstest belegt.

## 1. Abnahmeszenarien

Alle Szenarien laufen als API-Integrationssuiten gegen frische PostgreSQL-Datenbanken mit echten
Services und ausschließlich Fakes/Mocks; jede Suite endet mit dem gemeinsamen Integritätscheck
(`apps/api/test/acceptance-integrity.ts`, 92 SQL-Invarianten + Dokument↔Storage-Abgleich).
Die Oberflächen werden durch die vollständige Chromium-E2E-Suite abgedeckt (siehe Abschnitt 6),
ergänzt um Datenbank-Zustandsprüfungen in `crm-flow` und `return-flow`.

| Szenario | Suite | getesteter Ablauf | Ergebnis |
| --- | --- | --- | --- |
| A Standardvermietung | `acceptance-standard` P18-A1–A17 | Website-Anfrage (201, Replay 200, anderer Inhalt 409) → Angebot senden (1 PDF, 1 Mail, Doppel-Send 409) → Annahme 2× parallel + 1× danach (1 Buchung, 2 Termine) → AB approve/send (Doppel 409, 1 Dokument, 1 Mail) → Preisfreeze (Kunden-/Preisänderung lässt alle Snapshots byteidentisch) → Termin-CAS, Zuweisung/Vorbereitung (reserved) → Übergabe-Finalize 2× (1 Lieferschein + 1 Protokoll, issued/rented, genau eine Lagerausgabe je Artikel, Abholtermin erledigt, 1 Protokollmail) → Rückgabe-Finalize 2× (returned/cleaning, 1 Protokoll, Settlement `ready_for_accounting` mit Snapshot-Preis 12 000 trotz Listenpreis 55 500) → Job-Drain 2× (genau 1 Transfer `succeeded`, 1 Gateway-Aufruf, Vorgang `completed`; manueller Transfer danach `already_succeeded`) → Portal vor Zahlung (Buchung sichtbar, genau die 5 finalen Dokumente, PDF-Bytes identisch) → Zahlung `paid` + Reinigungsende ⇒ genau 1 Gutschein (20 %) + 1 Mail, erneutes `paid` ohne Wirkung → Portal nach Zahlung unsichtbar (Regel B) → Historienfelder gesetzt, Mails je Art genau 1, Jobs ohne `dead`/Doppel → Integrität. Lexware-Variante (A15–A17): Transfer über Contract-Fake (1 Rechnung, 1 Kontakt), Rechnungsmail genau 1, signierter Webhook 3× ⇒ 1 Event/1 Job, `paid`. | 17/17 grün (zwei Läufe auf derselben DB); kein Produktdefekt; dokumentierter Vertrag: manueller Transfer nach Erfolg ⇒ 200 `already_succeeded` |
| B Schaden | `acceptance-damage-objection` P18-B1–B6 | Rückgabe-Entwurf: Schaden nur mit Schweregrad/Text/≥1 Marker (Kosten-/Fremdfelder ⇒ 400), Finalisierung ohne Foto blockiert (409), mit Foto Finalize 2× parallel ⇒ genau eine Finalisierung, `activated_at = finalized_at`, Maschine `cleaning`, genau 1 Settlement `clarification_required` + 1 Klärung; Kostenentscheid ohne `damage.set_cost` 403 (nichts geändert), zwei Mitarbeitende parallel ⇒ 200 + 409 `VERSION_CONFLICT`, genau 1 Position 4 500; Schaden A≠B: Maschine per Override an Buchung B ausgegeben ⇒ Nachtrag 409 ohne Zeile, Entwurfsschaden über fremden Rückgabeabschnitt 404/409, Klärung nur am eigenen Settlement; 403 ohne `damage.document` ohne Nebeneffekt; Portal während Klärung nur „Rechnung wird vorbereitet“, keine Beträge/Klärungsschlüssel im DTO; Doppel-Submit ohne Schlüssel (API-Client) dokumentiert 2 Zeilen, mit Schlüssel 1 (P18-F2a). | 12/12 grün (vier Läufe); Befund F2 (Idempotenzschlüssel) behoben |
| C Kundeneinspruch/Widerspruch | `acceptance-damage-objection` P18-C1–C6 | Vorabmail: Notice ohne Fristtext, approve-and-send ⇒ Mail genau 1, `wait_until` = Versand + 24 h exakt, genau 1 Auto-Job mit `run_at = wait_until`, zweites Senden 409; Portalnachricht ändert die Abrechnung nicht (Zeile identisch); zwei Mitarbeitende erfassen die Rückmeldung parallel ⇒ 200 + 409, genau 1 offene Klärung, Auto-Job nach Rückdatierung `skipped` (0 Transfers, 0 Gateway-Aufrufe), Reload ändert nichts; „wie berechnet freigeben“ ⇒ nur manueller Transfer (Auto-Drain 0 Transfers), `end-wait` 409 `NOT_WAITING`, manueller Transfer ⇒ genau 1 Transfer, `locked_at`, Vorgang `completed`, danach Rückmeldung/Frist/Position 409 `SETTLEMENT_LOCKED`; Rechte: `settlement.release`, `settlement.end_pre_notice_wait`, `lexware.manual_transfer` ⇒ 403 ohne jede Nebenwirkung (Zeile, Mails, Jobs, Transfers, Klärungen unverändert). | 12/12 grün (Teil derselben Datei); kein Produktdefekt |
| D Storno | `acceptance-cancellation` P18-D1–D7 | Buchung mit Event in 10 Tagen und vorbereiteter Maschine: Vorschau 50 %, Basis = Σ regulärer Maschinenpreis × Menge aus dem Snapshot, half-up; Storno ⇒ genau 1 Zeile, Vorgang `cancelled`, Termine `cancelled`, Zuordnung `open` ohne Maschine, Maschine `ready`, keine Lagerbewegung, Dokumente/Buchung byteidentisch; Doppel- und Parallelstorno ⇒ dieselbe Zeile, genau 1 Transfer nach Job-Drain, manuell danach `already_succeeded`; Portal-Storno nur zur gezeigten Gebühr (`expectedFeeCents` + 1 ⇒ 409, keine Zeile), korrekt ⇒ `customer`, Bestätigungsmail genau 1, zweiter POST idempotent; Blocker 409 ohne Zeile: abgeschlossener Vorgang („zuerst wieder öffnen“), bestehende Rückgabe, ausgegebene Maschine; 403 ohne `booking.cancel`, Bestätigung ohne `email.approve_prepared`, Transfer ohne `lexware.manual_transfer` jeweils ohne Nebeneffekt; 0 % (≥ 15 Tage) ⇒ `no_invoice`, kein Finanzjob (nur Retention-Job); Reopen nach Storno lässt die Buchung gesperrt (Zuweisung/Vorbereitung/Rückgabe/erneutes Storno 409). | 9/9 grün (vier Läufe); kein Produktdefekt |
| E Offline-Betrieb | `acceptance-offline` P18-E1–E7 | Lease 72 h, Paket minimal (Kontakt nur Name/Telefon/Lieferadresse, kein E-Mail-/Finanz-/Abrechnungsschlüssel, Rechte-Snapshot nur operativ); Offline-Übergabekette synchronisiert, Replay jeder Mutation `deduplicated: true` ohne zweite Wirkung; derselbe `clientMutationId` gleichzeitig ⇒ genau eine Fachwirkung (1 Finalisierung, 2 Dokumente, Lagerausgabe 1×, 0 `processing`); zwei Geräte ⇒ 1× `applied`, Verlierer `ALREADY_FINALIZED`; abgebrochener Lauf (`processing` älter als 2 min) ⇒ Recovery `deduplicated`, frische `processing`-Quittung ⇒ 503 `SYNC_IN_PROGRESS` + `Retry-After`; Serveränderungen ⇒ `MACHINE_REASSIGNED`, `MACHINE_UNAVAILABLE`, `APPOINTMENT_CHANGED`, `SERVER_STATE_CHANGED` – Server unverändert, Quittungen ohne Kundendaten; Rechte-Entzug ⇒ `PERMISSION_REVOKED`, fremde Umgebung ⇒ 409 + Security-Event; genau eine `issued`-Zuordnung je Maschine. | 7/7 grün (fünf Läufe, auch mit erzwungenem Abend-Pin); kein Produktdefekt |
| F Konflikt/Override | `acceptance-conflict` P18-F1–F7 | Override online: Kollision ohne Override 409, ohne `machine.override_block` 403, leerer Grund 400, mit Recht + Grund genau eine aktive Override-Zeile (Fingerprint, Grund, Bestätiger), geänderte Lage ⇒ alte Zeile archiviert; harter Blocker (ausgegebene Maschine) auch mit Admin-Override 409; veralteter Override blockiert die Finalisierung (409), neue Bestätigung ⇒ Finalize 200, zweites Finalize `finalized: false`; offline: `MACHINE_UNAVAILABLE`, `VALIDATION`, `FORBIDDEN`, `applied`; Tour-Doppelstart parallel ⇒ genau ein Start, zweite aktive Tour derselben Person 409; zwei Übernahmen mit aktueller `expectedVersion` parallel ⇒ 200 + 409 `TOUR_VERSION_CONFLICT`, Stopp-Termine beim Gewinner, Live-Standort gelöscht; Termin-CAS parallel ⇒ 200 + 409. | 7/7 grün; kein Produktdefekt; Beobachtung H2 (Übernahme ohne Version per API gewinnt) dokumentiert |
| G Fehlende Berechtigungen | `acceptance-permissions` P18-G1–G24 | Negativmatrix „403 ohne Nebeneffekt“ (Zähler Jobs/Mails/Dokumente/Security-Events/Trainingsereignisse/Fachtabellen, Fake-Gateways, Zeilenstatus) für: Angebot senden, AB approve/send, Anzahlung/Kaution, Storno, Stornobestätigung/-Transfer, Übergabe-Finalize, Schaden, Rückgabe-Finalize, Abrechnung (Position, Vorabmail, Rückmeldung, Freigabe, Frist, Transfer), Reinigung, 8 Produkt-/Preisrouten, Maschine/Sperre, Gutschein senden, 6 Admin-Rechterouten (inkl. Selbst-Eskalation), Tour-Übernahme; Systemadmin ohne Rollenrecht passiert Fachrouten, Deny inert; Training-Gate in production blockt auch Systemadmins; CSRF cross-site/same-site/Origin ohne Sec-Fetch-Site/`Origin: null` ⇒ 403 ohne Mutation; 401 ohne/mit ungültigem Cookie; Positivkontrolle mit Recht. | 24/24 grün (drei Läufe); kein Bypass, keine Nebenwirkung bei 403 |
| H Demo/Training | `acceptance-demo` P18-H1–H8 | Demo-App auf eigener DB (`TEST_DATABASE_URL_SECOND`), Live-App development daneben: Seed vorhanden; Angebotsmail an Nicht-Whitelist ⇒ `blocked DEMO_NOT_WHITELISTED` (kein Job), an Whitelist ⇒ `[DEMO]`-Betreff; Lexware disabled (Transfer 409 `ACCOUNTING_NOT_CONFIGURED`, Mock-Routen 409, Webhook 404); WhatsApp/Routing Mock, Webhook 404, echte Keys in demo ⇒ `ConfigError` ohne Werte in der Meldung; Reset ⇒ neue Epoch, kanonische Zähler, Staff-Konten bleiben, Audit `demo.reset_completed`, Live-DB (13 Tabellen), Live-Fakes und Live-Audit unverändert, `/staff/demo/reset` in Live 404; production lehnt Fake-Mail/-Push/-WhatsApp/-Routing/-IMAP/-Reviews und Mock-Accounting beim Start ab, Training-Gate nur production; `check:env-isolation` Exit 0/1 ohne Werte in der Ausgabe; globaler Egress-Spion (`fetch`, `http`/`https.request`) über den gesamten Lauf: kein Host außer Loopback, alle Provider-Zähler 0. | 8/8 grün (drei Läufe); kein Produktdefekt; eine begründete Integritätsausnahme (Seed-Fixture-Gutschein `voucher.situation`, Demo bucht nie in Lexware) |

## 2. Systemweite Prüfungen

- **Datenintegrität (C):** 92 SQL-Invarianten (Statuskombinationen, Doppelobjekte, weiche Referenzen
  ohne FK, Dokumente/Protokolle, Lager-Saldo, Abrechnung/Transfer, Storno, Lexware, Gutschein,
  Mails, Jobs, Offline-Quittungen, Portal, CMS) + Dokument↔Storage-SHA-256 nach jedem Szenario
  (A–H) sowie als Zwischenprüfung nach Schaden und Storno – überall 0 Verletzungen (eine begründete
  Ausnahme in H, siehe Tabelle). Selbsttest `acceptance-integrity` P18-C0 (alle Abfragen
  ausführbar/eindeutig).
- **Idempotenz (A):** Website-Anfrage Replay, Angebots-Doppelsend, paralleler Accept, AB-Doppel,
  Übergabe-/Rückgabe-Doppelfinalize, Transfer-Drain 2× + manuell, Zahlung 2×, Gutschein-Trigger 2×,
  Webhook 3×, Storno 2×/parallel, Portal-Storno 2×, Offline-Replay/derselbe Schlüssel parallel,
  Kostenentscheid/Rückmeldung parallel, Online-Schaden mit Schlüssel 2×/parallel – jeweils genau
  eine Fachwirkung.
- **Concurrency (B):** parallele Annahme, parallele Finalisierung (ein Gerät/zwei Geräte), parallele
  Kostenentscheide und Rückmeldungen (`VERSION_CONFLICT`), parallele Tour-Starts/-Übernahmen (CAS),
  parallele Reschedules, CRM-Stale-PATCH (neu 409) – deterministisch oder definierter Konflikt, nie
  stilles Überschreiben.
- **Audit/Historie:** kein generisches Fach-Audit-Log (Design): geprüft wurden die Historienfelder
  (`sent_by/at`, `accepted_at`, `approved_by/at`, `finalized_by/at`, `cleaned_by/at`, `locked_at`,
  `transferred_at`, `completed_at`, `released_by/at`, `resolved_by`, Override-Protokoll mit Grund),
  `integration_jobs`, `mail_deliveries`, immutable `documents` sowie `staff_security_events`
  (`offline.environment_mismatch`, `demo.reset_*`, Portal-Login/-E-Mail-Wechsel); 403 erzeugt nie
  ein Event (kein Ablehnungs-Audit, bewusst).
- **PII/Logging (D):** Smoke mit `LOG_LEVEL=info` (API + Worker, 20 Routen inkl. Portal-Login,
  Anfrage mit Kontaktdaten, Login-Fehlversuch): 0 Treffer für E-Mail, Telefon, Namen, Passwort;
  PII-Grep über Smoke-, Backup-Smoke- und Worker-Logs (E-Mail-/Telefon-/Namens-/Token-/Cookie-/
  Base64-Muster): 0 Treffer; Suiten prüfen Quittungen, Fehlerbodies und Config-Fehlermeldungen auf
  Kundendaten/Secrets; Befund F3 (SQL im Log) behoben.
- **Environment-Isolation:** `pnpm check:env-isolation` mit 15 synthetischen Fixtures (13 Paare:
  4 isoliert ⇒ Exit 0, 9 kollidierend ⇒ Exit 1, Ausgabe ohne Werte) + Szenario H (Zweit-DB
  unverändert, production lehnt Fakes ab, Egress-Spion).
- **Provider:** ausschließlich Fakes/Mocks/Senken (MockAccountingGateway, FakeLexwareServer
  in-process, FakeMailGateway/SMTP-Senke, Fake-Push, Fake-/Mock-WhatsApp, Mock-Routing,
  Fake-Reviews); production-gates-Projekt mit `.invalid`-Zielen; kein echter Aufruf (Zähler und
  Egress-Spion).

## 3. Backup / Restore (Wegwerf-Testdatenbank)

Methode (jetzt dokumentiert in docs/DEPLOYMENT_NOTES.md „Backup & Restore (Phase 18)“): Dump mit
`pg_dump -Fc --no-owner --no-privileges` (PostgreSQL 18.7 im Container – das Host-`pg_dump` 16 ist
gegen den 18er-Server nicht verwendbar), Storage als Tar, Restore mit `pg_restore --exit-on-error`
in eine leere Datenbank, Storage entpackt, identische Schlüssel.

Umgebung: lokale Docker-Instanz `mietroyal-postgres`, Datenbank `mietroyal_test_bak18`
(Sicherheitsstopps der Seeds greifen nur bei `mietroyal_test`-Namen), fs-Storage im Scratchpad.
Testdaten: Migrationen + E2E-Basis-Seed + Website-Seed (CMS veröffentlicht) + Portal-Seed (3 Kunden,
2 bestätigte Buchungen mit AB/Terminen, eine finalisierte Übergabe mit Lieferschein/Protokoll,
1 versendetes Angebot; 7 Dokumente im Storage).

Ablauf und Ergebnis (Skript-Protokoll im Scratchpad `g18/bak18/`):

| Schritt | Ergebnis |
| --- | --- |
| 1 Testdaten | staff_users 2, customers 3, processes 3, offers 3, bookings 2, documents 7, machines 11, appointments 4, cms_entries 14, Migrationen 34 |
| 2 Backup | Dump 486 976 Byte (974 TOC-Einträge, 120 Tabellen mit Daten), Storage-Tar 7 Dateien, SHA-256 beider Sicherungen protokolliert |
| 3 Verlust | `DROP DATABASE … WITH (FORCE)`, leere Datenbank neu, Storage geleert (0 Tabellen, 0 Dateien) |
| 4 Restore | `pg_restore` Exit 0 ohne Meldungen; Tar entpackt |
| 5 Vergleich | 120 Tabellen: Zeilenzahl und ordnungsunabhängige MD5-Prüfsumme je Tabelle identisch (43 nicht leere), 2 Sequenzen identisch, Storage 7 Dateien SHA-256 identisch, zentrale Zähler identisch |
| 6 Migrationen | zweiter `pnpm db:migrate` gegen den Restore: No-op (34/34 Einträge) |
| 7 Anwendung | API gegen Restore: `/health` 200, `/ready` 200, Staff-Login 200 (`authenticated`), `/auth/me` 96 Rechte, `/staff/processes` 3 = DB 3, `/staff/customers` 2 aktive = DB 2, `/staff/machines` 11 = DB 11, Dokument-Download `application/pdf` 5 191 Byte = Storage-Bytes (`%PDF`), `/public/site/settings` 200, Startseite 200, Katalog 200, Cross-Site-Login 403, Logout 200 → `/auth/me` 401; 0 Fehlerzeilen, 0 PII-Treffer im API-Log |

Befund: Das Repository dokumentierte vorher nur Zielwerte (ARCHITECTURE „Backups“) und verwies auf
einen nicht beschriebenen „Backup-Restore-Pfad“ (DEPLOYMENT_NOTES Schritt 8) – als Phase-18-Befund
minimal korrigiert (Verfahren + Verifikation dokumentiert, Schlüssel als Teil der Sicherung
benannt). Kein neues Backup-Tooling; Automatisierung/Off-site bleibt Hosting-/Go-live-Thema.

## 4. Adversarial-Befunde

| # | Befund | Schweregrad | Ursache | Reproduktion | Fix | Regressionstest |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | Staff-PATCH mit veraltetem Kundenformular dreht fremde Änderungen (zweite Mitarbeiterin, verifizierter Portal-E-Mail-Wechsel) still zurück | mittel (stilles Überschreiben, Order B) | `updateCustomer` als Full-Replace ohne Vorbedingung | `acceptance-fixes` P18-F1a/F1b vor dem Fix: 200 und E-Mail zurückgedreht | optionales `expectedUpdatedAt` + CAS im UPDATE (ms-Vergleich) ⇒ 409 `CONFLICT`; Staff-App sendet den Wert, zeigt Hinweis, lädt neu; keine Migration | P18-F1a–c; E2E `crm-flow` „Veraltetes Kundenformular …“ |
| F2 | Doppel-Submit eines Online-Schadens (Entwurf, Nachtrag) erzeugt zwei Dokumentationszeilen (+ zwei Klärungen) | niedrig–mittel (Order A Idempotenz) | kein Idempotenzschlüssel online (nur offline) | P18-F2a vor dem Fix: 400 für den Schlüssel bzw. zwei Zeilen ohne Schlüssel | optionales `clientMutationId` auf beiden Routen → bestehender Replay-Pfad (Unique `machine_damages.client_mutation_id`, Zeilensperre); UI erzeugt UUID je Formular | P18-F2a/F2b; E2E `return-flow` F (Request trägt UUID) |
| F3 | `routes/commerce.ts` loggte den Fehler der Terminerzeugung nach der Annahme mit `err` (DB-Fehler ⇒ SQL + Parameter im Log) | niedrig (Log-Policy) | Abweichung vom globalen Fehlerhandler | P18-F3 vor dem Fix: Marker aus `message` im Log | nur `bookingId` + `errorName` | P18-F3 |
| F4 | Zweite Testdatenbank (`mietroyal_test7`) von keiner Infra angelegt; 4 Suiten scheitern auf frischer Infra, 2 Tests skippen still | Test-Infrastruktur | Init-SQL unvollständig, `it.skipIf` | frische Infra ohne `TEST_DATABASE_URL_SECOND` | Init-SQL + Doku; A19/G6 ohne stillen Skip | Gate: Integration mit beiden DBs, 0 übersprungen |
| F5 | Backup/Restore nur Zielwerte, kein Verfahren, Schlüssel nicht erwähnt | Doku/Prozess | – | – | DEPLOYMENT_NOTES „Backup & Restore (Phase 18)“ | Nachweislauf (Abschnitt 3) |
| F6 | PERMISSIONS.md nennt Security-Event `demo.reset_requested`, das nicht existiert | Doku | – | D-P4 (bestehend) | Doku angeglichen | – |

Weitere Beobachtungen (keine Produktänderung, dokumentiert in docs/OPEN_ITEMS.md „Phase 18“):
- Nachtrag (`post_return_finding`) nach bereits gesperrtem Settlement erzeugt keine Klärung mehr
  (fachlich offen).
- Tour-Übernahme ohne `expectedVersion` per API gewinnt still; die Staff-App sendet immer die
  Version (CAS belegt).
- `GET /staff/settlements/:id` schreibt beim Rebuild `updated_at` neu, obwohl fachlich nichts
  geändert wird (Fachfelder, Version, Klärungen identisch) – technischer Zeitstempel.
- Cross-Return-Schaden auf eine finalisierte Rückgabe antwortet 409 (Entwurfssperre) statt 404 –
  beides abgewiesen, keine Zeile.
- Ein 0-%-Storno reiht einen Retention-Job ein (Phase 12, erwartet), keinen Finanzjob.
- E2E auf frischem Container: die Haupt-API loggt vor dem ersten Seed einen Datenbankfehler
  (Tabellen fehlen, Web-Build fragt `/public/site/*`) – Startreihenfolge der Testinfrastruktur,
  kein Produktdefekt (Produktion migriert vor dem Start).
- Demo-Konfiguration: eine Angebotsmail wird ohne `MAIL_PUBLIC_WEB_BASE_URL` fail-closed
  `blocked` (`PUBLIC_WEB_BASE_URL_MISSING`) – Pflichtvariable bei `MAIL_ENABLED=true`.

## 5. Geänderte Dateien, Migrationen

Produktcode (minimal, keine Migration): `apps/api/src/routes/crm.ts` (Update-Schema mit
`expectedUpdatedAt`), `apps/api/src/crm/customer-service.ts` (CAS im UPDATE), `apps/api/src/routes/returns.ts`
(optionales `clientMutationId` auf beiden Schadensrouten), `apps/api/src/returns/damage-service.ts`
(Replay-Pfad Nachtrag), `apps/api/src/routes/commerce.ts` (Log ohne `err`); Staff-App:
`apps/staff/app/kunden/[id]/page.tsx` (Vorbedingung + 409-Hinweis), `apps/staff/app/vorgaenge/[id]/rueckgabe/page.tsx`
und `apps/staff/app/maschinen/[id]/page.tsx` (UUID je Schadensformular).
Testinfrastruktur: `infra/postgres-init/01-create-databases.sql` (vierte Datenbank), `apps/api/test/portal-auth.integration.test.ts`
(A19 ohne stillen Skip), `apps/api/test/routing-global-rate-limit.integration.test.ts` (G6 ohne stillen Skip).
Neue Tests: `apps/api/test/acceptance-integrity.ts` (+ Selbsttest), `acceptance-standard`,
`acceptance-damage-objection`, `acceptance-cancellation`, `acceptance-offline`, `acceptance-conflict`,
`acceptance-permissions`, `acceptance-demo`, `acceptance-fixes` (93 Tests, 8 103 Zeilen);
E2E `tests/e2e/specs/crm-flow.spec.ts` (+1 Test), `tests/e2e/specs/return-flow.spec.ts` (F erweitert).
Dokumentation: DEPLOYMENT_NOTES (Backup & Restore), TEST_PLAN (Gesamt-Abnahme), TECH_DECISIONS
(Phase 18), OPEN_ITEMS (Phase 18, CRM-Punkt erledigt), DOMAIN_RULES (Schaden-Idempotenz, CRM-Regel),
DECISIONS_LEDGER, PERMISSIONS (Reset-Events), ENVIRONMENTS (vierte DB), dieser Bericht.

Migrationen: keine neue Migration (alle Fixes nutzen vorhandene Spalten); Drift-Prüfung
`drizzle-kit generate` auf leerer Datenbank: „No schema changes, nothing to migrate“ (34 SQL-Dateien
vor/nach, Journal 34, 119 Tabellen; zweiter `db:migrate`-Lauf auf derselben leeren DB ohne Änderung).

## 6. Tatsächlich ausgeführte Tests und Ergebnisse

Finales Gate auf dem endgültigen Arbeitsbaum (Basis `6813758` + alle Phase-18-Änderungen,
2026-11-21, 11:18–14:17 Uhr), Schritte in dieser Reihenfolge, jeder Schritt mit Exit-Code 0;
Kommandos siehe docs/TEST_PLAN.md „Gesamt-Abnahme (Phase 18)“. Kein Test wurde wiederholt, kein
Lauf war flaky (Playwright `retries: 0`); übersprungen wurden ausschließlich die planmäßig
projektgebundenen Specs (siehe E2E-Zeilen), jede davon lief im zuständigen Projekt genau einmal.

| Schritt | Kommando / Gruppe | Ergebnis |
| --- | --- | --- |
| Format, Lint, Typecheck | `pnpm format:check`, `pnpm lint`, `pnpm typecheck` | je Exit 0 |
| Unit-Tests | `pnpm test` (alle Pakete, `apps/web` mit `node --test`) | 656 bestanden, 0 fehlgeschlagen (permissions 13, config 70, web 136, domain 115, validation 27, offline 54, integrations 24, api 217) |
| Migrationen | `db:migrate` auf leerer DB, zweiter Lauf, `drizzle-kit generate` | Lauf 1 und 2: 34/34 angewendet (Journal 34, SQL-Dateien 34, 119 Tabellen), zweiter Lauf ohne Änderung; Drift: „No schema changes, nothing to migrate“ |
| API-Integration (gesamt) | `vitest run -c vitest.integration.config.ts` gegen frisch angelegte `mietroyal_test2` und `TEST_DATABASE_URL_SECOND=…/mietroyal_test_e2e2` | 174 Dateien, 1 946 Tests bestanden, 0 übersprungen, 0 fehlgeschlagen (54 min); darin die Phase-18-Suiten A–H, Fixes und Integritäts-Selbsttest (93 Tests) |
| Environment-Isolation | `pnpm check:env-isolation` gegen 13 Fixture-Paare | 13/13 erwartetes Ergebnis (4× isoliert ⇒ Exit 0, 9× Kollision ⇒ Exit 1, Ausgabe ohne Werte) |
| API-/Worker-Smoke | gebaute API + Worker (`development`, `LOG_LEVEL=info`, Mock-Routing, Fakes): 20 Routen, 3 Job-Läufe | alle Statuscodes wie erwartet (200/202/400/401/403/404/409), Jobs `ok:true`, 0 Fehler, 0 PII im Log |
| Backup/Restore | `pg_dump -Fc` im Container → `DROP`/`CREATE` → `pg_restore --exit-on-error` → Vergleich → App-Smoke (Abschnitt 3) | 122 Prüfsummen-/Sequenzzeilen identisch, Zähler identisch, 7 Storage-Dateien SHA-256 identisch, Migrationen 34/34, Health/Ready 200, Login 200, Angebots-PDF 5 191 Bytes byteidentisch, Cross-Site-Login 403 |
| PII-Log-Prüfung | 7 Grep-Muster über Smoke-, Worker- und Backup-Smoke-Logs (3 Dateien) | 0 Treffer |
| Builds | `pnpm build` (Pakete, API, Worker, Web, Staff) | Exit 0 |
| E2E Chromium (ein Lauf) | `playwright test --project=chromium` (Production-Builds Staff/Web, frische Test-DB) | 180 bestanden, 0 fehlgeschlagen, 7 planmäßig übersprungen (Demo-Specs aus `demo-environment.spec.ts`, laufen nur im Projekt `demo-communication` – dort bestanden), 18,7 min |
| E2E isolierte Läufe | `--project=seo`; `chromium`: website-flow/-cms/-seo-disabled, portal-flow, tours-flow/-offline-conflict, communication-flow/-ops, offline-flow/-hardening, voucher-flow, demo-environment; `demo-communication`: website-demo, danach gesamt; `lexware`; `production-gates` | seo 50; Website 17; Portal 15; Touren 19; Kommunikation 20; Offline 21; Gutschein 11; demo-environment Live-Gegentest 1 (7 Demo-Specs planmäßig übersprungen); Website-Demo 4; Demo gesamt 28 (1 planmäßig übersprungen: Live-Gegentest, läuft nur in `chromium`); Lexware 16; Production-Gates 3 – alle bestanden, 0 fehlgeschlagen, 0 flaky |
| Phase-17-Regression (SEO/A11y/Responsive/Performance) | Projekt `seo` (50 Tests inkl. axe, Zoom 200 %, Responsive, Redirects, Sitemap) + Lighthouse 12.8.2 gegen Production-Build (Indexierung AN, frische DB, ohne echte Medien) | seo 50/50; Lighthouse Mobile `/` 98/100/100/100 (LCP 2,05 s, TBT 0,12 s, CLS 0,000), `/slushmaschine-mieten` 98/100/100/100 (LCP 2,06 s), `/konfigurator` 98/100/100/100 (LCP 2,18 s); Desktop `/` 100/100/100/100 (LCP 0,52 s). Verbleibende Hinweise identisch zu Phase 17 (render-blocking CSS, unused/legacy JS, bf-cache). Wiederholung auf der leeren Maschine (frische DB, neuer Production-Build): `/` 97 und 98, `/slushmaschine-mieten` 99, `/konfigurator` 95 (LCP 2,23 s, TBT 0,22 s), A11y/BP/SEO je 100. Performance 95–99 gegenüber 99–100 in Phase 17 bei unverändertem `apps/web` (kein Quelltext-Diff), gleichen Audits (zusätzlich nur Lighthouse-Insights ohne Score-Gewicht) und ausschließlich CPU-abhängigen Metriken (TBT 0,07–0,22 s, LCP 1,89–2,23 s): Laborvarianz der Testmaschine, keine Regression; Zielwerte (Perf ≥ 90, A11y/BP/SEO ≥ 95) überall erfüllt. |

Vor dem Gate (Entwicklung): Phase-18-Suiten einzeln mehrfach grün (Läufe je Suite in Abschnitt 1),
Nachbar-Suiten der Fixes (9 Dateien, 151 Tests), E2E `crm-flow` + `return-flow` isoliert (21 Tests),
Migrationen/Drift, Smoke, PII, Backup/Restore (Abschnitt 3) – jeweils grün. Fehlgeschlagene Läufe
während der Entwicklung betrafen ausschließlich Erwartungen neuer Phase-18-Tests (Enum-Vergleiche,
Anzeigename, Quittungsanzahl, Retention-Job nach 0-%-Storno, Demo-Mail ohne
`MAIL_PUBLIC_WEB_BASE_URL`) sowie die vier reproduzierten Produktbefunde F1–F4 (rote Regression vor
dem Fix); kein Test wurde abgeschwächt, kein Timeout erhöht (Ausnahme: begründete 120-s-Timeouts für
Demo-Seed/-Reset/CLI in `acceptance-demo`).

## 7. Nicht getestet, offene Punkte, Risiken

Nicht getestet (begründet):
- S3/MinIO-Storage-Integrationstest (`packages/integrations/test/s3-storage.integration.test.ts`):
  MinIO-Image in der Phase-18-Umgebung nicht ladbar – auf Staging/CI nachholen.
- Worker-Prozessstart in `production` gegen injizierte Fakes (der Worker baut Gateways nur über die
  fail-closed-Fabriken; geprüft wurden API-`buildApp` und Kommunikationskontext).
- Echte Provider (Lexware, SMTP/IMAP, WhatsApp, Push, GraphHopper, Google Places) – per Auftrag
  ausgeschlossen; Nachweis nur über Fakes, Zähler und Egress-Spion.
- Reverse-Proxy-/nginx-Logs, DNS/HTTPS, Search Console, Live-Website, Pilotbetrieb (Phase 19/20).
- Lighthouse mit echten Medien (Seed ohne Bilder) – Staging-Nachmessung (Phase 17 bekannt).

Offene Punkte: docs/OPEN_ITEMS.md „Phase 18“ (Nachtrag nach gesperrtem Settlement, Takeover ohne
Version per API, `dead`-Jobs ohne Operator-Sicht, Push at-least-once, `handovers`-CHECK nur im Code,
Backup-Automatisierung, DATA_MODEL-Lücke Offline-/Override-Tabellen, S3-Test).

Restrisiken: Rate-Limits sind prozesslokal (dokumentiert, `API_TRUST_PROXY_HOPS`); Online-Schäden
von API-Clients ohne `clientMutationId` bleiben nicht idempotent (Kompatibilität); `mr_staff_session`
ohne `__Host-`-Präfix (dokumentierte Phase-1-Entscheidung); kein Egress-Block im Code (Hosting-Firewall);
Lighthouse-Performance im Labor schwankt mit der Testmaschine (Mobile 95–99 bei unveränderter Website),
Feldwerte (Core Web Vitals) erst nach dem Go-live.
