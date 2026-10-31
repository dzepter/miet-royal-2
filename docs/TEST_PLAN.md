# TEST_PLAN — Pflichtabnahme

## Testebenen
- Unit: Geschäftslogik
- Integration: API + DB + Rechte
- E2E: kritische Prozesse

## Grenztests Storno
- 20 Tage → 0 %
- 15 → 0 %
- 14 → 50 %
- 7 → 50 %
- 6 → 100 %
- Eventtag → 100 %
Basis darf Rabatt/Gutschein nicht übernehmen; Lieferung/Kanister/Kommission ausgeschlossen.

## Angebotsgültigkeit
- Event 15 Tage entfernt → 7 Tage
- Event 14 Tage entfernt → 3 Tage

## Preissnapshot
75 € Angebot versenden → Standardpreis 80 € → altes Angebot 75 €, neues 80 €.

## Angebotsversion
V1 versenden → V2 → V1 nicht annehmbar, historisch vorhanden.

## Maschinen
- älteste geeignete als bevorzugt
- andere wählbar
- Sperr-Override ohne Recht blockiert
- mit Recht Grund + Bestätigung + Nutzer
- Folgebuchung erzeugt Admin-Push + einmalige 6h-Erinnerung

## Ausgabe
Ohne Kunden- und Mitarbeiterunterschrift kein Abschluss.
Mehrere Maschinen → ein PDF mit Einzelabschnitten.

## Rückgabe
- ordentliche Rückgabe → Cleaning
- Fehlteil → physische Rückgabe möglich, finanzielle Klärung offen
- Schaden → Marker + Severity + Text + Foto Pflicht
- mangelhafte Vorbereitung → 75 € + Foto

## Kommission
Ausgegeben 4, ungeöffnet zurück 2 → berechenbar 2.

## Vorinformationsfrist
- mehrere Positionen → eine Mail
- eine 24h-Frist
- spätere Position startet nicht neu
- Kundenantwort blockiert Auto-Lexware
- keine Antwort lässt weiterlaufen

## Lexware
Mock-Connector: derselbe Job mehrfach retryen → extern nur eine Rechnung.
Nach erfolgreichem Transfer Settlement nicht mehr editierbar.

Umsetzung Phase 9: `apps/api/test/accounting-transfer.integration.test.ts`
(Transfer-Boundary: paralleles prepare/execute, Snapshot-Unveränderlichkeit,
transienter Fehler + Retry, Disabled-Gateway, Mock-Steuerung nur mit
system.settings und nicht in production), `settlement-*.integration.test.ts`
(Pflichttests 1–60, 130–135, 138–142, 146–149), `cancellation-*.integration.test.ts`
(86–115, 136/137, 143/144, Storno-vs.-Ausgabe-Race), `packages/domain/test/
settlement.test.ts` (Summen, Kommissionsregel, Storno-Grenzen 15/14/7/6/0,
Berlin-Kalendertage, half-up-Rundung), E2E `tests/e2e/specs/settlement-flow.spec.ts`
(A–M).

Umsetzung Phase 10 (Lexware Office, nur gegen den lokalen Contract-Fake
`apps/api/src/lexware/testing/fake-server.ts`, nie gegen einen echten
Account): `apps/api/test/lexware-client.test.ts` (Client, Fehlerklassen,
Geldumrechnung, Webhook-Signatur), `lexware-connection/-rate-limit/-webhooks/
-reconcile` (Verbindung, 2 Req/s über zwei Prozesse, signierte Webhooks,
Dedup, Reconcile/Setup idempotent), `lexware-tax/-contacts/-invoice/
-cancellation/-transfer/-credits/-delivery/-payment/-security`
(Steuerkonfiguration fail-closed, Kontakt-Mapping ohne Auto-Merge, finale
Rechnung aus dem Snapshot, Stornokostenrechnung, Doppelklick/Worker/Timeout-
Recovery ⇒ genau eine Rechnung, Anzahlung/Kaution blockiert, kein PDF,
Versand „ausstehend“, Zahlungsstatus, IDOR/Key-Leaks), E2E
`tests/e2e/specs/lexware-flow.spec.ts` (A–N) im eigenen Playwright-Projekt.

## Gutschein
- nur nach paid + schadenfrei
- nur einmal
- 12 Monate
- nur Maschinenmiete
- nicht kombinierbar

Phase-11-Tests (Angebot/Storno/Abrechnung/Security, Agent O):
- `packages/domain/test/voucher-pricing.test.ts`: 57–63 (eine/mehrere Maschinen,
  half-up, Lieferung/Kanister/Kommission/Inklusiv unberührt, Nicht-Kombinierbarkeit
  strukturell).
- `apps/api/test/voucher-offer.integration.test.ts`: 42–56 (Entwurf/Reservierung/
  Versionierung/Freigabe/Cap/Annahme/Races/Booking-Snapshot), 64–68 (Staff, öffentlich,
  PDF + AB, Snapshot friert ein), 71–80 (nicht kombinierbar, keine Rabattrechte,
  Lieferpreis unabhängig).
- `apps/api/test/voucher-cancellation.integration.test.ts`: 81–96 (0 % reaktiviert
  denselben Gutschein, Restgültigkeit, Retry/Replay, 50/100 % verbraucht, Stornobasis
  100 EUR + Gutschein + 50 % ⇒ 50 EUR, Folgevorgang).
- `apps/api/test/voucher-settlement.integration.test.ts` (Lexware-Fake): 69/70
  (Rabattzeile exakt einmal, Lexware negative Position mit Mietsteuersatz).
- `apps/api/test/voucher-offer-security.integration.test.ts`: 114–123 (IDOR,
  identische neutrale Antworten, keine Client-Steuerung von %/Betrag/Besitzer/
  Status/Reservierung, keine Reaktivierungsroute).

Phase 11 Final, Punkt 2 (kein Klartextcode über stdout/CI-Logs; Pflichttests
F15–F21):
- F15 `tests/e2e/specs/voucher-flow.spec.ts` (A–J, L) und
  `voucher-lexware.spec.ts` (K) laufen ohne Reveal-Script: der Klartext entsteht
  in-process (`helpers/voucher.ts` `revealVoucherCode`, Entschlüsselung der
  Versandkopie mit der Serverfunktion `decryptDeliveryCode`); Szenario A prüft
  weiterhin die echte automatische Erzeugung und `sha256(code) == code_hash`.
- F16/F17 `apps/api/test/voucher-security.integration.test.ts`: API-Log (In-
  Prozess-Jobrunner der API über `run-due-jobs`, trace) und Worker-Log (eigener
  `JobRunner` mit Logger wie `apps/worker`) enthalten nach
  `voucher.eligibility_check` nur IDs/Outcome – nie Code, Hash, Versandkopie.
- F18 E2E-Prozesslogs: der Helfer startet keinen Kindprozess für den Code,
  gibt nichts aus und schreibt nichts; API-/Worker-stdout (Playwright-WebServer)
  sind durch F16/F17 abgedeckt; `expectNoPlaintextCode` prüft UI/API-Texte.
- F19 `voucher-security.integration.test.ts`: Routentabelle (`printRoutes`)
  ohne reveal/code/vouchers-/test-Pfad, einziger Gutschein-Pfad ist
  Apply/Remove am Entwurf; Kunden-/Vorgangs-/Angebots-/öffentliche Antworten
  ohne Code/Hash/Kopie; denkbare Test-/Reveal-Endpunkte ⇒ 404.
- F20 `voucher-security.integration.test.ts`: Script existiert nicht mehr,
  `voucher-delivery.ts` ohne fs/console/stdout, `revealCodeForDelivery` ohne
  stdout/stderr/Log; eine Klartextdatei entsteht nirgends (Helfer schreibt
  keine Datei – statisch nachvollziehbar, kein eigener Laufzeittest sinnvoll).
- F21 `apps/api/test/voucher-delivery.integration.test.ts` 97–105 unverändert
  grün (`VoucherDeliveryService` bleibt serverinterne Boundary).

## Anzahlung/Kaution
Anzahlung korrekt abziehen.
Kaution separat, Teil-Einbehalt mit Grund.

## Rechte
Negative API-Tests für Preis, Storno, Settlement, Damage Cost, Override, CMS.
Ohne Recht serverseitig 403/äquivalent.

## Session
Sperren → alle Sessions ungültig.
Passwortänderung → andere Sessions raus.
Neues Gerät → Admin-Push-Job.

## Vertretung
Während Zeitraum neue Aufgabe an Vertretung; danach offen zurück.

## Offline
Offline-Rückgabe + parallele Onlineänderung → Konflikt, kein stilles Überschreiben.

## Demo-Isolation
- Demo kann keine Live-ID lesen
- Demo-Storage keine Live-Datei
- Lexware hard-disabled
- Mail außerhalb Whitelist blockiert
- `[DEMO]` im Betreff
- Phase 14 (Auftrag Teil 2, §101 Nr. 1–17): `apps/api/test/demo-isolation.integration.test.ts`
  mit ZWEI Apps auf ZWEI Datenbanken (`createTestContext({ appEnv: 'demo' })` und
  `createTestContext({ databaseUrl: TEST_DATABASE_URL_SECOND })`, Default
  `mietroyal_test7`; production-Konfiguration auf der zweiten DB über
  `env-app-helpers.ts`): T1 eigene DB (+ Isolation-Check erkennt geteilte DB/Storage),
  T2 eigener Storage (Datei der einen Umgebung fehlt in der anderen), T3/T4 Kunde und
  Vorgang der anderen DB ⇒ 404 (und fremdes Session-Cookie ⇒ 401), T5/T6/T7 Angebots-
  und Dokument-Token über die Umgebungsgrenze ⇒ 404 (development UND production),
  T8/T9 Demo-Mail nur Whitelist + `[DEMO]` (Ergänzung zu communication-mail 14./15.),
  T10/T11 WhatsApp-Mock ohne Meta-Aufruf, echte Zugangsdaten = ConfigError, Webhook 404
  (Ergänzung zu communication-whatsapp 98./116.), T12/T13 Routing-Mock ohne
  GraphHopper-Aufruf, Key = ConfigError (Ergänzung zu routing-config T3/T4/C4 und
  routing-graphhopper „Fabrik“), T16 Push nur an Subscriptions der Demo-DB (Live-Fake
  nie aufgerufen), T17 `assertConfigsIsolated` + CLI `pnpm check:env-isolation`
  mit synthetischen Fixtures grün bzw. Kollision ohne Werte. T14/T15 liegen in
  `demo-accounting.integration.test.ts`.

## Customer
Magic Link nach 15min ungültig.
Profiländerung verändert laufenden Booking-Snapshot nicht.

## Website
- freie Maschinenwahl trotz Empfehlung
- 250+ Hinweis
- Gratis-Sirup je Behälter
- Kanisterlimit
- laufende Preissumme
- Lieferung ohne festen Auto-Endpreis
- keine Lagerzahl öffentlich

## Kommunikation (Phase 12)
- Pflichttests 1–205 als Integrations-/Unit-Tests `apps/api/test/communication-*.test.ts`
  (Nummer im Testnamen), Härtung nach adversarialem Review in
  `communication-hardening-*` (Fund-IDs RA-…/B…).
- Keine echten Provider im Gate: Fakes (`FakeMailGateway`, `FakeInboundMailSource`,
  `FakeWhatsAppGateway`, `FakePushGateway`) in Integrationstests; in E2E echte
  Gateways gegen lokale Fakes (TLS-SMTP-Senke, IMAP, Graph-API, Push-Dienst,
  `tests/e2e/fakes/`, Test-CA nur über `NODE_EXTRA_CA_CERTS`).
- E2E-Szenarien A–T: `communication-flow.spec.ts`, `communication-lexware.spec.ts`,
  `communication-ops.spec.ts` (Demo-Isolation im eigenen Projekt).
- Optionale Live-Smokes `pnpm mail:smoke`, `pnpm whatsapp:smoke` nur mit expliziten Flags.

## Touren, Routing, aktive Fahrt, GPS (Phase 13)
- Pflichttests T1–T124 (Nummer im Testnamen „T<n>. …“): Config
  `packages/config/test/routing-config.test.ts`, Provider-Client gegen den
  Contract-Fake `apps/api/test/routing-graphhopper.test.ts`
  (`apps/api/src/routing/testing/fake-server.ts`), Integrationstests
  `apps/api/test/tours-*.integration.test.ts` (geocoding, planning,
  assignment, route-changes, travel-status, security, end, active-gps,
  delay-risk), Domänentests `packages/domain/test/tours.test.ts`.
  Traceability: `docs/PHASE13_TEST_TRACEABILITY.md`.
- Keine echten Provider im Gate: `FakeRoutingGateway` in Integrationstests;
  in E2E der echte GraphHopper-Client gegen den lokalen Contract-Fake auf dem
  HTTPS-Dispatcher (4567, Präfix `/api/1`, Test-CA nur über
  `NODE_EXTRA_CA_CERTS`); Demo-Projekt ohne Key (Mock, kein Provider-Aufruf).
- E2E-Szenarien A–O: `tests/e2e/specs/tours-flow.spec.ts`.
- Optionaler Live-Smoke `pnpm routing:smoke` nur mit `ROUTING_SMOKE=1` und
  echtem Key, nie in production, nie im Gate.

## Demo-Umgebung, Seed, Reset (Phase 14)
- Pflichttest-Nummern fehlen im Auftrag (endet bei §20); Testnamen tragen
  provisorische Kennungen: Config `D-C1…` (`packages/config/test/demo-links.test.ts`),
  Runner `D-R1…` (`packages/integrations/test/runner-defer.test.ts`), Gate
  `D-G1…`/`RF1` (`apps/api/test/demo-reset-gate.test.ts`), Plattform `D-P1…`
  (`apps/api/test/demo-platform.integration.test.ts`), Seed `D-S1…`
  (`demo-seed.integration.test.ts`), Reset `D-R1…`/`RF3…RF8`
  (`demo-reset.integration.test.ts`), Web-Banner `RF6…` (`apps/web/lib/environment.test.ts`).
- Demo-Testkontext: `createTestContext({ appEnv: 'demo' })` (vollständige
  Demo-Konfiguration mit Test-Schlüsseln); Demo-Routen existieren außerhalb
  demo nicht (404-Tests).
- E2E: `tests/e2e/specs/demo-environment.spec.ts` (provisorisch D1–D7 im
  Projekt `demo-communication` mit eigener Demo-Staff- und Demo-Web-Instanz,
  Live-Gegentest im Projekt chromium).
- Reset-Sicherheit wird reproduziert: paralleler Reset ⇒ 409, Percent-codierte
  Pfade ⇒ 503 während des Resets, Prozessabbruch ⇒ `resetStale` nach 10 min.
- Kein automatischer Seed in Tests oder beim Start; `pnpm demo:seed` /
  `pnpm demo:reset` nur gegen Demo-Datenbanken (Env-Guard-Tests).
- Demo-Accounting (Auftrag Teil 2, §101 Nr. 14/15, W1/W1.1):
  `apps/api/test/demo-accounting.integration.test.ts` – T14 Demo Lexware immer
  disabled (Fabrik/Status `disabled`, kein Lexware-Client, Webhook 404,
  Lexware-Key in demo ist Konfigurationsfehler), T14b Start-Guard (`buildApp`
  mit Mock-Gateway wirft in demo/production, development erlaubt;
  `assertAccountingGatewayAllowed` für Worker/Seed), W1.1 Seed-Fixture
  `voucher.situation` (ein aktiver Gutschein des Wiedermieters ohne
  Transferreferenz, Registry nur mit ID, `voucher.delivery`-Job, anwendbar
  über `POST /staff/offer-versions/:id/voucher`, idempotent, nur demo), T15
  keine simulierte erfolgreiche Übertragung (Settlement bleibt
  `ready_for_accounting`, kein Transferjob, `transferNow` 409, Mock-Steuerung
  409, `run-due-jobs` überträgt nichts, Vorgang bleibt offen, Blocker
  `demo_unavailable` mit Text), T15b Storno in der Demo (Vorschau/Sicht
  `demo_unavailable`, kein Job, kein Erfolg). Angepasst: Seed D-S1/D-S10,
  Reset D-R1/D-R7 (keine Transferjobs mehr in der Demo; Fixture-Gutschein).
  T96 (Settlement-Training ohne Lexware-Erfolg) liegt im Trainingsmodul.
- Demo-Reset – Jobs, Outbox, Storage, Audit, Tokens (Auftrag Teil 2, §103 Nr.
  35–59, Agent RESET): `apps/api/test/demo-reset-jobs.integration.test.ts`. Eigene
  Assertions: T53 laufender Business-Job des alten Datensatzes ⇒ nach dem Reset vom
  Worker-Guard `dead`/DEMO_DATASET_CHANGED (Handler nie aufgerufen), pending gelöscht,
  neue Jobs laufen; T53b nur neue Business-Jobs (created_at ≥ last_reset_started_at);
  T54 Outbox-Tabellen leer, überlebender `mail.send`-Job ohne Gateway-Aufruf; T55
  Angebots-, Dokument-, Aktionstoken und Gutschein tot (404/≥400), Kalender-Feed-Token
  bleibt und liefert nur neue Termine; T56 Storage-Delete-Fehler ⇒ genau ein Job
  `demo.storage_cleanup` mit exakt den fehlgeschlagenen Schlüsseln, Handler löscht beim
  nächsten Lauf, Status `storageCleanup` pending/dead; T58 Audit started/completed
  (gleiche resetRunId, Session, Details nur resetRunId/datasetVersion/status) + Hook
  genau einmal; T59 Hook-Fehler ⇒ reset_failed mit errorClass (Name/SQLSTATE), nie die
  Meldung. Dünne Mapping-Tests mit je einer eigenen Prüfung: T35 (⇒ D-P3), T36 (⇒ D-R8),
  T37 production-App 404 (⇒ D-P2), T38/T39 Advisory-Lock (⇒ D-R4), T40 Flag ⇒ 503
  (⇒ D-P5/RF1), T41/T42 (⇒ D-R1), T43–T47 Löschliste ohne staff_*/Geräte/Audit (⇒ D-R2),
  T48–T52 Löschliste ohne training_*/demo_* + Hook-Punkt (Fachassertion Tests 85/86 bei
  TRAINING-CORE), T57 mehrfach sicher (⇒ D-R1/D-R7/RF3). Runner-Skip:
  `packages/integrations/test/runner-defer.test.ts` D-R5/D-R6.
- Demo-Offline-Epoch (Auftrag Teil 2, §104 Nr. 60–68): Integration
  `apps/api/test/demo-offline-epoch.integration.test.ts` (T60 Lease, T61 Paket + Status,
  T62 Reset ändert Epoch, T63 alte/fehlende/fremde Epoch ⇒ 409 DEMO_DATASET_CHANGED ohne
  Quittung, T64 alte Mutation ohne Wirkung auf den neuen Seed, T67 neues Paket ladbar,
  T68 development: Epoch null, Sync ohne/mit Feld unverändert); Unit
  `packages/offline/test/dataset-epoch.test.ts` (T65 Erkennung nur bei zwei bekannten,
  abweichenden Epochen; T65b Envelope-Epoch Mutation/Meta; T65c Queue bricht bei
  DatasetChangedError ab, alles bleibt pending; T66 `discardDataset` leert alle
  Fachstores und Epoch-Metadaten, Workspace/Uhr bleiben). Client-Dialog/Banner: E2E D.
- Demo-PDF-Kennzeichnung (Auftrag Teil 2, §89): `apps/api/test/demo-documents.integration.test.ts`
  – in demo tragen Angebot (final + Vorschau), AB, Lieferschein (Entwurf + final),
  Übergabe- und Rückgabeprotokoll „DEMO – keine echten Kundendaten“ (jede Seite) und den
  Titelpräfix „DEMO · “; in development nicht.

## Training in der Demo – Metaebene, Übungen, Verwaltung (Phase 14, W2, Agent TRAINING-CORE)
- Unit `apps/api/test/training-evaluators.test.ts`: Katalogkonsistenz (8 Übungen, 5 Pfade,
  Validierung), Evaluatoren (`matchEvent`/`isComplete`/`openStep`/`stepsView`): Reihenfolge,
  PREREQUISITE_MISSING, `sameSubject` (Angebot/Tour/Inventur), Duplikate, fremde Ereignisse.
- Integration (Demo-Kontext `createTrainingDemoContext()` = `createTestContext({ appEnv: 'demo',
  env: { MAIL_DEMO_WHITELIST: '@example.com' } })`, DB `TEST_DATABASE_URL`; Katalog wird beim
  `app.ready()` synchronisiert, Fortschritt je Test geleert):
  - `training-meta.integration.test.ts` (§105 Nr. 69–89): T69 stabile Keys/IDs bei zweifachem
    Sync, T70 Version-Update (Versuch behält `definition_version`), T71 Pfad-Reihenfolge und
    Resequenzierung ohne Unique-Verletzung (Item-Zeilen bleiben), T72 Zuweisung ⇒ `/me`,
    T73 fremde Versuchs-ID 404 (lesen/prüfen), Admin-Routen 403, T74 Übersicht zeigt alle
    aktiven Mitarbeiter, T75 Start (201, Schritte, offener Schritt), T76 zwei parallele POSTs
    ⇒ eine ID / genau ein `in_progress` (Partial-Unique-Backstop), T77 zweiter Mitarbeiter
    eigener Versuch, T78 Ereignis mit fremdem Akteur zählt nicht, T79 development: Recorder
    Noop, keine Zeilen, Attempt-/Admin-Routen 404, `/me`+Katalog verfügbar, T80 409 der
    Finalisierung ⇒ kein Ereignis/kein Fehlversuch, T81 „Übung prüfen“ ⇒ failed_check_count,
    Ereignis `check_failed`/STEP_NOT_COMPLETED, T82 letztes Pflicht-Ereignis ⇒ automatisch
    `passed`, T83 Duplikat ⇒ kein Doppelabschluss (`duplicate`), T84 passed bleibt nach
    Katalog-Update, T85/T86 echter Demo-Reset über `POST /staff/demo/reset` (passed bleibt,
    in_progress ⇒ interrupted/DEMO_DATA_RESET, Zuweisung bleibt, Seed-Entity danach
    auflösbar), T87 Training-Reset erhält Historie (superseded, Runde +1, neuer Versuch),
    T88 inaktive Übung ⇒ 409 TRAINING_DEFINITION_INACTIVE, T89 Spalten/Inhalte der
    Ereignistabelle sind reine Metadaten, Versuchsansicht ohne Fachobjekt-ID.
  - `training-exercises.integration.test.ts` (§106 Nr. 90–98, echte Fachpfade über Routen,
    Trainee mit exakt den nötigen Rechten): T90 offer_send (bearbeiten + senden ⇒ passed; nur
    senden ⇒ `send` abgelehnt, offener Schritt `edit`), T91 handover_complete (idempotente
    Wiederholung ohne zweites Ereignis), T92 return_complete, T93 tour_complete (anlegen,
    bereit, starten, Stopp erledigen, beenden ⇒ passed; nur starten ⇒ offen), T94
    communication_reply (WhatsApp-Fake über `whatsapp.send` ⇒ sent ⇒ passed; Mail an
    Whitelist-Adresse über `mail.send` ⇒ sent, [DEMO]-Betreff ⇒ passed; blockierte Mail ⇒
    nicht passed), T95 settlement_review (Klärung lösen bis `ready_for_accounting`), T96 kein
    Lexware-Erfolg nötig (kein Transfer, kein Client), T97 Fachrechte gelten (403
    TRAINING_PERMISSION_MISSING / Fachroute 403 FORBIDDEN), T98 Pflichtschritte nicht
    umgehbar (409 ohne Ereignis, erst der vollständige Weg besteht).
  - `training-admin-demo.integration.test.ts` (§108 Nr. 119–123): T119 Pfad zuweisen (201,
    409 Duplikat, 404, 403, strict schema, Audit nur IDs/Keys), T120 Reset (superseded/
    interrupted TRAINING_RESET, Runde +1, Historie, Audit, Teil-Reset einer Übung), T121
    Fortschritt (Übersicht/Detail, Fehlversuche, unterbrochene Versuche), T122 Fehlercodes
    (STEP_NOT_COMPLETED, PREREQUISITE_MISSING, nur Meta-Schlüssel), T123 keine
    Businessinhalte (Kunden-/Vorgangs-/Kontaktdaten und Fachobjekt-IDs fehlen; Schlüssel-
    Whitelist der Antworten).
- E2E (Agent E2E, Projekt `demo-communication`): E–K und O laufen gegen diese Routen –
  Ablauf je Übung siehe Abschlussbericht TRAINING-CORE.

## Live-Trainingssperren und Live-Verwaltung (Phase 14, W2)
- `apps/api/test/training-gates.integration.test.ts` (T99–T118; Testkontext
  development plus production-/staging-/demo-App auf demselben Pool über
  `apps/api/test/env-app-helpers.ts`): T99 Gate standardmäßig aus, T100/T101
  Permission allein reicht nicht ⇒ 403 `TRAINING_REQUIRED` mit
  featureKey/requiredTrainingKey/title, T102 verified_demo erlaubt, T103
  Override erlaubt, T104 Override ohne Grund 400 (API + DB-Constraint), T105
  abgelaufen blockiert, T106 Widerruf wirkt sofort, T107 demo erzwingt nicht
  (Admin-Gate-Routen 404), T108 development, T109 staging (`enforced: false`),
  T110 production erzwingt, T111 Systemadmin kein Bypass, T112 bewusster
  Systemadmin-Override mit Audit, T113 Verwaltungs-/Lese-Routen ungegated
  (dynamisch + statisch: genau acht `requireTrainingGate`-Aufrufe, ein
  Sync-Aufruf), T114 demo.manage ungegated, T115 inaktive/unbekannte Übung kein
  Gate-Ziel (409/404, Deaktivieren erlaubt), T116 inkonsistente Sperre
  fail-closed `TRAINING_CONFIGURATION_INVALID` auch mit Freigabe, T117 alle
  acht Routen + Offline-Sync (handover/return finalize, clean_complete) ⇒
  TRAINING_REQUIRED, T118 verständlicher Text ohne Technikcodes.
- `apps/api/test/training-admin-live.integration.test.ts` (T124–T130,
  production-App): T124 Demo-Abschluss bestätigen (Liste, Audit, 404 bei
  unbekannter Übung/Mitarbeiter), T125 keine Demo-Businessdaten (Zeile nur
  Meta-Spalten, strict schema lehnt Zusatzfelder ab), T126 Sperre aktivieren
  (Audit nur bei Zustandswechsel, Übungswechsel auditiert), T127 deaktivieren
  (idempotent; ohne `training.manage` 403), T128 Override (Doppelklick
  dupliziert nicht), T129 Widerruf (idempotent, sofort wirksam, eigener Typ
  für Demo-Bestätigung), T130 Audit aller sechs Typen ohne Begründungstext.
- Bestandstests der gegateten Module bleiben grün (development erzwingt
  nicht): commerce-offer, handover-finalization, return-finalization,
  return-cleaning, settlement-notice-wait/-security, tours-end/-security,
  warehouse-stocktake/-machines, offline-core.
- E2E (Agent E2E, Projekt `production-gates`): L Production Gate blockiert,
  M Verified Demo erlaubt, N Override/Widerruf.

## Definition of Done
Fachregel korrekt, Rechte serverseitig, Validierung, Fehlerfall,
responsive, Tests ausgeführt, Doku aktualisiert, Staging geprüft.
