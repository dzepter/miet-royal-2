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
Phase-15-Stand (Kundenportal `/konto`, docs/CUSTOMER_PORTAL.md): beide Regeln sind
Pflichttests (A7 in `portal-auth`, B3/P11 in `portal-booking`/`portal-profile`).
Dazu u. a.: keine Enumeration (auch nicht beim E-Mail-Wechsel), Session absolut 30
Tage, Reauth ≤ 15 min, Sichtbarkeit nur „aktueller“ Buchungen (Stornozeile schlägt
Vorgangsstatus), Storno an die gezeigte Gebühr gebunden, IDOR ⇒ neutrales 404.
Zuordnung aller Pflicht-, E2E- und Review-Tests: Abschnitt „Kundenportal (Phase 15)“.

## Website
- freie Maschinenwahl trotz Empfehlung
- 250+ Hinweis
- Gratis-Sirup je Behälter
- Kanisterlimit
- laufende Preissumme
- Lieferung ohne festen Auto-Endpreis
- keine Lagerzahl öffentlich
Phase-16-Stand: alle Punkte sind Pflichttests (`public-configurator` PC*,
`public-inquiry` PI*, Web `configurator.test.ts`); Zuordnung im Abschnitt
„Website, CMS, Konfigurator, Bewertungen (Phase 16)“.

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
- Sperrfenster Integration (Berlin, festgestellt im Phase-15-Gate): Einige Touren-
  Integrationstests legen Termine bei „jetzt + N Minuten“ an und verlangen das heutige
  Berliner Tourdatum (`inMinutes` in `apps/api/test/tours-helpers.ts` klemmt nur negative
  Versätze auf den Tagesbeginn). Größter Versatz: `tours-delay-risk` +240 min,
  `tours-multi-active` und `offline-tour-lease` +200 min. Laufen diese Dateien ab etwa
  20:00 Uhr, rutschen Termine auf den nächsten Tag (`APPOINTMENT_NOT_ON_TOUR_DATE`). Die
  komplette Integrationssuite (Dauer etwa 45–60 min) deshalb nicht zwischen 19:00 und 00:00
  Uhr starten, die genannten Dateien einzeln nicht zwischen 20:00 und 00:00 Uhr.
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
- Demo-Testadressen des Seeds (Order §9/§25, Review-Fix F8):
  `demo-seed.integration.test.ts` D-S4 (Demo-Testkontext ohne
  `MAIL_DEMO_WHITELIST` ⇒ alle Adressen example.com/example.invalid, auch die
  fünf Mail-Übungskunden), D-S4b (zweiter Demo-Kontext mit
  `MAIL_DEMO_WHITELIST=senke@demo.test,@demo.test,@zweite.test` und
  `MAIL_PUBLIC_WEB_BASE_URL` ⇒ nur die Mail-Übungskunden tragen
  `<lokalteil>@demo.test`, Vollmatch-Adresse nie vergeben, keine Adresse
  doppelt, `process.offer.sent` bleibt blockiert, Outbox pending/blocked
  passend, Test-Runner stellt alle eingereihten Mails mit „[DEMO]“ an die
  Whitelist-Domain zu, Seed-Antwort `queued` ⇒ `sent`), D-S14 (Abrechnung
  `process.settlement.review` mit Belastung: Kostenentscheide ⇒ Klärung
  `customer_notice` ⇒ approve-and-send ⇒ `mail.send` über den Test-Runner ⇒
  `customer_waiting` ohne Auto-Transfer ⇒ end-wait ⇒ `ready_for_accounting`,
  Blocker `demo_unavailable`, keine Transfers/-Jobs, Vorgang offen, Übung
  `settlement_review` bestanden mit Ereignis `settlement.reviewed`).
- E2E: `tests/e2e/specs/demo-environment.spec.ts` (Order §109 A Demo Banner,
  C Demo Reset, Q Live↔Demo-Wechsel – Teilszenarien D1–D7 – im Projekt
  `demo-communication` mit eigener Demo-Staff- (Produktions-Build) und
  Demo-Web-Instanz, Live-Gegentest im Projekt chromium; Audit `demo.reset_started`/
  `demo.reset_completed` nur mit resetRunId/datasetVersion/status, Status-Feld
  `storageCleanup`, Registry inkl. `voucher.situation`). Übersicht aller
  E2E-Buchstaben A–Q: Abschnitt „E2E Phase 14 (Order §109)“.
- Reset-Sicherheit wird reproduziert: paralleler Reset ⇒ 409, Percent-codierte
  Pfade ⇒ 503 während des Resets, Prozessabbruch ⇒ `resetStale` nach 10 min.
- Reset-Barrier (Phase 14 Final, Auftrag §6, Agent BARRIER):
  `apps/api/test/demo-reset-barrier.integration.test.ts` (DB mietroyal_test5) RB1
  Businessrequest blockiert > 1,2 s ⇒ Phase B erst nach Request-Ende (Mutation
  anschließend gelöscht), RB2 Jobhandler blockiert > 1,2 s ⇒ kein Wipe vor
  Handlerende, RB3 echter geclaimter `mail.send` (Fake-Gateway hängt) ⇒ Reset
  wartet, Zustellung endet vor Phase B, danach kein Gateway-Aufruf für die alte
  Zustellung, RB4 Flag gesetzt ⇒ 503, RB5 Gate-Cache false + ungecachte
  Zweitprüfung true ⇒ 503 ohne Mutation, RB6 Job sieht Reset erst nach dem
  Lock ⇒ defer ohne Attempt-Verbrauch, RB7 zwei Apps (A-Request blockiert
  B-Reset-Route), RB8 App + Worker-Runner mit eigener Barrier, RB9 Exclusive
  wartet auf den letzten Shared-Inhaber (zwei Barrier-Instanzen; neue Mutation
  währenddessen 503), RB10–RB13 Freigabe bei 200/4xx/500/Jobfehler, RB14 keine
  Lock-/Pool-Leaks (pg_locks + Pool-Zähler) nach parallelen Mutationen, RB15
  Fach-Pool max = 1 ohne Deadlock inkl. komplettem Reset, RB16 Reset-Route hält
  keinen Shared-Lock, RB17 neuer Datensatz nach Reset (Epoch, 200), RB18 alter
  processing-Job ⇒ dead/DEMO_DATASET_CHANGED, RB-A1 (Review 14f F1: echter
  TCP-Client-Abbruch während des Handlers ⇒ Shared-Lock bleibt, Reset wartet,
  Mutation nach Handlerende nicht im neuen Datensatz, kein Leak), RF3-1 (Review
  14f F3: Lock-Pool erschöpft ⇒ `DEMO_RESET_BARRIER_UNAVAILABLE` vor/nach Phase
  A, Audit-errorClass, API weiter 503 DATABASE_UNAVAILABLE). RF3-3
  (`demo-reset.integration.test.ts`): fremde Tabellensperre in Phase B ⇒
  SQLSTATE 55P03 nach `wipeLockTimeoutMs` statt Hänger, Audit `SQLSTATE_55P03`,
  erneuter Reset ok. FC2 (`training-gates.integration.test.ts`): Offline-Sync
  bei Katalogausfall ⇒ 503 TRAINING_CATALOG_UNAVAILABLE, kein Receipt, danach
  reguläre Gate-Auswertung. Unit:
  `apps/api/test/demo-reset-barrier.test.ts` RB-H1…H7 (Hook-Reihenfolge Gate →
  Lock → Zweitprüfung, alle Release-Pfade; RB-H7/RB-A2: Client-Abbruch/Timeout
  geben nicht frei, Freigabe in `onSend`, fail-closed) und RB-J1…J3
  (Execution-Guard), `packages/integrations/test/runner-defer.test.ts` RB-U1…U5
  (Runner-Guard: release nach Erfolg/Fehler, defer/skip, Guard-Fehler ⇒ defer).
  RF4 (`demo-reset.integration.test.ts`) prüft, dass Phase B ohne Zeitfenster auf
  das Ende eines Shared-Inhabers wartet; `settleDelayMs` existiert nicht mehr.
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
    Ereignistabelle sind reine Metadaten, Versuchsansicht ohne Fachobjekt-ID; Phase 14
    Final SR1 (subjectRef in keiner API-Antwort/keinem Audit, statische Prüfung).
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
- E2E (Projekt `demo-communication`, `tests/e2e/specs/training-demo.spec.ts`): B und
  D–K, O, P über die Demo-Staff-UI mit eigenen Trainees je Übung – Details im Abschnitt
  „E2E Phase 14 (Order §109)“.

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
- Phase 14 Final (Agent RULES, Order §7/§9/§13) in denselben Dateien:
  - `training-admin-live`: VD1 verified_demo ohne validUntil (201, null, Sperre
    offen), VD2 verified_demo mit validUntil (Zukunft/Vergangenheit) ⇒ 400
    VALIDATION mit festem Text, `null` erlaubt, VD3 direkter INSERT/UPDATE ⇒
    CHECK `staff_training_clearances_verified_demo_permanent_check` (23514),
    VD4 Override unbefristet, VD5 Override mit Zukunftsdatum (Vergangenheit
    400); IU2 verified_demo an deaktivierten Mitarbeiter ⇒ 409
    `TRAINING_USER_INACTIVE` (locked erlaubt, `user.status` in der Antwort),
    IU3 Override ⇒ 409, IU4 Freigaben eines deaktivierten Mitarbeiters bleiben
    lesbar/widerrufbar, IU5 Reaktivierung ⇒ nicht widerrufene verified_demo
    gilt wieder im production-Gate, Widerruf sperrt.
  - `training-gates`: VD6 abgelaufener Override blockiert, daneben bestehende
    Demo-Bestätigung bleibt (Anzeige bevorzugt sie), VD7 verified_demo gilt
    nach Jahren bis zum Widerruf, FC1 Katalog-Sync scheitert ⇒ production-Gate
    503 `TRAINING_CATALOG_UNAVAILABLE` ohne Interna, keine Fachwirkung, nach
    gelungenem Sync erlaubt (fail-closed, nie fail-open).
  - `training-admin-demo`: IU1 Zuweisung an deaktivierten Mitarbeiter ⇒ 409
    (locked erlaubt), IU4 Historie (Zuweisung, Versuche, Ereignisse) nach
    Deaktivierung über Admin-Routen lesbar, IU6 Übersicht führt deaktivierte
    mit Historie (status disabled), nicht ohne Historie.
  - `training-meta`: SR1 `subjectRef` erscheint in keiner Trainings-API-Antwort
    (me, definitions, attempt, check, overview, user-detail, paths) und keinem
    Audit-Detail; statisch: Routen/Gate-Services/Audit kennen das Feld nicht.
- Bestandstests der gegateten Module bleiben grün (development erzwingt
  nicht): commerce-offer, handover-finalization, return-finalization,
  return-cleaning, settlement-notice-wait/-security, tours-end/-security,
  warehouse-stocktake/-machines, offline-core.
- E2E (Projekt `production-gates`, `tests/e2e/specs/training-gates.spec.ts`): L Production
  Gate blockiert, M Verified Demo erlaubt, N Override/Widerruf – Details im Abschnitt
  „E2E Phase 14 (Order §109)“.

## E2E Phase 14 (Order §109, Szenarien A–Q)
Alle Läufe über `pnpm test:e2e` (`tests/e2e/playwright.config.ts`); jedes Projekt startet
sämtliche Server frisch (`reuseExistingServer: false`). Drei Staff-Instanzen werden als
Produktions-Build gebaut (`.next` Haupt, `.next/demo` Demo, `.next/prod` Production – je
≈ 3 min), weil `STAFF_API_ORIGIN` zur Build-Zeit eingebacken wird und Offline-Szenarien
die App-Shell mit Service Worker brauchen.

| Buchstabe | Spec (Projekt) | Inhalt |
| --- | --- | --- |
| A Demo Banner | `demo-environment.spec.ts` (demo-communication, „A/D1“) | Badge/Titel/Web-Banner |
| B Demo Seed | `training-demo.spec.ts` (demo-communication) | Reset per API, Registry inkl. `voucher.situation` (ein aktiver Fixture-Gutschein ohne Transfer), Audit nur Meta, `storageCleanup` 0/0 |
| C Demo Reset | `demo-environment.spec.ts` („C/D3–C/D7“) | Rechte, Dialog, 503-Gate, Datensatz, Staff-Daten bleiben |
| D Reset + Offline Epoch | `training-demo.spec.ts` | Arbeitspaket mit Epoch, offline erfasste Übergabe-Prüfung, Admin-Reset per API, online ⇒ `dataset-changed-banner`/`-dialog`, „Später“ (keine Sync), Bestätigen ⇒ Pending 0, neue Epoch, neuer Seed ohne Prüfung/Fotos/Unterschriften |
| E Offer Training | `training-demo.spec.ts` | Rabatt auf den Seed-Entwurf + Versand ⇒ bestanden; Prüfung vorher ⇒ offener Schritt; Angebotsmail an die Demo-Testadresse `verein@demo.test` pending ⇒ `run-due-jobs` ⇒ Senke „[DEMO] Dein Angebot …“ ⇒ sent |
| F Handover Training | `training-demo.spec.ts` | Übergabe-Wizard vollständig ⇒ bestanden |
| G Return Training | `training-demo.spec.ts` | Rückgabe-Wizard ohne Beanstandung ⇒ bestanden, Pfad abgeschlossen |
| H Tour Training | `training-demo.spec.ts` | eigene Tour (Stopp heute via `e2e-tours-seed`) ⇒ bereit/starten/beenden ⇒ bestanden, Routing Mock ohne Provider-Request |
| I Communication Training | `training-demo.spec.ts` | E-Mail-Antwort an `@demo.test` ⇒ queued zählt nicht ⇒ `run-due-jobs` ⇒ sent ⇒ bestanden |
| F7 Freie Übung (Review-Fix F7) | `training-demo.spec.ts` | Mitarbeiterin ohne Zuweisung besteht `communication_reply` unter „Weitere Übungen“ (Antwort an `lena.beispiel@demo.test`, Seed `conversation.email.unanswered`) ⇒ nach Reload `data-state=passed` mit „Bestanden am“, ohne „Übung starten“, genau ein Versuch, `/me.definitions[].attempt` |
| J Settlement Training | `training-demo.spec.ts` | Klärungen „Nicht berechnen“ ⇒ „Bereit zur Buchhaltung“, Demo-Hinweis, kein Transfer (auch nach Jobs) |
| J2 Settlement mit Belastung (Review-Fix F8/F4) | `training-demo.spec.ts` | Reset per API, Trainee mit `settlement.release` + `settlement.end_pre_notice_wait`: 50,00 € + 15,00 € ⇒ „Kundeninformation prüfen“ ⇒ „Freigeben und senden“ (pending, „Übung prüfen“ offen, kein `settlement.reviewed`) ⇒ `run-due-jobs` ⇒ Senke „[DEMO] …“ an `einkauf@demo.test` ⇒ `customer_waiting` ⇒ „Jetzt freigeben“ ⇒ „Bereit zur Buchhaltung“ ⇒ bestanden (genau ein akzeptiertes Ereignis), kein Transfer |
| K Admin Progress | `training-demo.spec.ts` | Zuweisung, Fortschritt 3/3, Fehlprüfung + Ereignis ohne Businessdaten, Training-Reset, Trainee startet neu |
| L Production Gate blockiert | `training-gates.spec.ts` (production-gates) | Sperre `offer.send` ⇒ UI-Hinweis, Entwurf bleibt, API 403, `/training` „offen“ |
| M Verified Demo erlaubt | `training-gates.spec.ts` | Freigabe `verified_demo` ⇒ Senden klappt, Zeile ohne Demo-Daten |
| N Override / Revoke | `training-gates.spec.ts` | Widerruf sofort wirksam, Override ohne Grund = Formularfehler, mit Grund erlaubt, Widerruf, Audit ohne Begründung |
| O Definition Update Stability | `training-demo.spec.ts` | `scripts/e2e-training-catalog-bump.ts` (Version +1, Titel) ⇒ bestanden bleibt, Katalog zeigt Version 2, danach `restore` |
| P Demo Provider Isolation | `training-demo.spec.ts` | Accounting disabled/Webhook 404/Mock 409, WhatsApp `mock-…` ohne Graph-Request, Routing Mock ohne Fake-Request, Nicht-Whitelist-Mail (`process.offer.sent`, example.com) blocked mit „[DEMO]“, keine Secrets |
| Q Live↔Demo Wechsel | `demo-environment.spec.ts` („Q/D2“) | neues Fenster ohne Session/IDs/Token |

- Projekt `production-gates`: API 3110 mit `APP_ENV=production`, Datenbank
  `mietroyal_test_prod` (frisch je Lauf über `apps/api/scripts/e2e-prod-setup.ts`:
  Live-Admin `admin.live@live.test`, Mitarbeiterin `mia.live@live.test` mit Rolle
  „E2E-Live“, synthetische Nicht-Test-Mietbedingungen für den Angebotsversand), fs-Storage im
  Temp-Verzeichnis, je Lauf zufällige 64-Hex-Schlüssel, kein Lexware/WhatsApp/Routing; Mail nur
  als nie angesprochener SMTP-Platzhalter (`smtp.e2e.invalid`, HTTPS-Basis-URL), weil production
  den Angebotsversand ohne SMTP-Weg hart blockiert – der Job `mail.send` läuft im Projekt nie,
  Angebotsmails bleiben `pending`; Staff 3111 als Produktions-Build. Login im Browser
  (Secure-/`__Host-`-Cookies auf http://127.0.0.1), genau zwei Logins je Lauf (Rate-Limits).
- Sperrfenster (Berlin): `training-demo.spec.ts` (H) und `tours-demo.spec.ts` nicht zwischen
  23:38 und 00:02 starten, `tours-flow.spec.ts` nicht zwischen 22:43 und 00:02 (Resttag zu
  kurz, siehe Kopfkommentare).
- Demo-Testadressen (Review-Fix F8): Die Demo-API des Projekts läuft mit
  `MAIL_DEMO_WHITELIST=@demo.test`; fünf Seed-Kunden der Mail-Übungen tragen deshalb
  `<lokalteil>@demo.test` (`lena.beispiel`, `verein`, `miriam.demoperson`, `jana.beispielhaft`,
  `einkauf`), alle anderen example.*. Ein Seed/Reset erzeugt dadurch eingereihte (`pending`)
  Mails an diese Adressen (plus `mail.send`-Jobs); ohne Worker verlässt nichts die Umgebung –
  erst `run-due-jobs` stellt sie an die Senke zu. Senken-Prüfungen filtern daher immer nach
  Empfänger + Betreff (`demo-environment.spec.ts` C/D4/C/D6, `training-demo.spec.ts` E/F7/J2/P).

## Kundenportal (Phase 15)
Fachdoku: docs/CUSTOMER_PORTAL.md. Testnamen tragen die Nummer bzw. den Fund am Anfang
(„A7. …“, „R12. …“). Integration: `cd apps/api && TEST_DATABASE_URL=… pnpm vitest run --config
vitest.integration.config.ts <Datei>`; A19 (`portal-auth`) läuft nur mit
`TEST_DATABASE_URL_SECOND` (sonst übersprungen), E4 (`portal-demo`) nutzt die zweite Datenbank
(Default `mietroyal_test7`). Web: `pnpm --filter @mietroyal/web test` (`node --test`), Config:
`cd packages/config && pnpm vitest run`. Keine echten Provider (Fake-Mail-Gateway, SMTP-Senke).

**Magic-Link-Testtokens nur in-process:** Integrationstests lesen den Token ausschließlich im
Testprozess aus dem verschlüsselten Outbox-Secret (`decryptPortalMailToken` in
`apps/api/test/portal-auth-helpers.ts`, PayloadCrypto); E2E nimmt ihn nur aus dem Link der
echten Mail in der SMTP-Senke (`tests/e2e/helpers/portal.ts`) und vergleicht Tokens nur
boolesch. Es gibt KEINE Reveal-Route, keine Ausgabe auf stdout, keine Klartextdatei, keine
Debug-API; das Seed-Skript `apps/api/scripts/e2e-portal-seed.ts` gibt nur IDs/Nummern aus und
legt keine Sessions oder Links an. Die DB-Drossel (5 Login-Links je 15 min je Kunde) umgehen
die Helfer `requestMagicLinkToken`/`loginViaMagicLink` nur, wenn sie sonst greifen würde,
indem sie `created_at` älterer Login-Links desselben Kunden aus dem Fenster verschieben
(`releasePortalLoginThrottle`, `expires_at` bleibt); die R4-Tests nutzen diese Helfer nicht.

Pflichttests (Order §56–§65):

| Order | Thema | Datei (alle unter `apps/api/test/`, sofern nicht anders genannt) | Testnamen |
| --- | --- | --- | --- |
| §56 | Auth | `portal-auth.integration.test.ts` | A1–A26 (u. a. A1–A4 neutral/kein Link, A5/A6 Token und Hash, A7 15 min, A8 one-time, A9 paralleler Consume, A10/A25 kein Token im Log, A11 Secret-Payload, A12 Fragment, A12b strikter Consume-Body, A13/A14 Cookie, A15/A16 30 Tage ohne Sliding, A17 Logout, A18 Ablauf, A19/A19b Cross-Environment, A20 Host-Header, A23/A26 Rate-Limits, A24 Cleanup); Cross-Environment zusätzlich `portal-demo` E4 |
| §57 | Visibility | `portal-visibility.integration.test.ts` | V1–V13 (V7: 0-€-Storno als Kundenstorno) |
| §58 | Booking | `portal-booking.integration.test.ts` | B1–B8, B9.–B12. („Unterwegs“ ohne GPS/ETA/Fahrer) |
| §59 | Dokumente | `portal-documents.integration.test.ts` | D1–D11 |
| §60 | Chat | `portal-chat.integration.test.ts`, `portal-chat-staff.integration.test.ts` | M1–M16, M16b (Kunde, Fotos, Push, Retention, Rate-Limit), „Polyglot-CSP.“; M17–M24 (Staff-Antwort Kanal Portal, Recht, Hinweis-Mail, Terminal, `canReplyPortal`) |
| §61 | Profil | `portal-profile.integration.test.ts` | P1–P19, P15b, P16b (P15: belegte Adresse ⇒ neutrale 202 ohne nutzbaren Link) |
| §62 | Rechnung | `portal-invoice.integration.test.ts` | I1–I9 |
| §63 | Storno | `portal-cancellation.integration.test.ts` | C1–C19, C14b (Backstop-Scanner); gültige Storno-POSTs senden `expectedFeeCents` (Helfer `cancelVia`) |
| §64 | Security | `portal-security-dto.integration.test.ts`; ergänzend `portal-auth`, `portal-chat`, `apps/web/lib/portal.test.ts` | S1 Deep-Scan, S2 401, S3 Staff-Session, S4 IDOR, S5 Client-IDs; A10/A25 (Token nicht im Log), A12 (kein Token in der Query), A18b (Staff-Session/Angebots-Token), A20 (fremde Origin 403, Host-Header), M8 (Client-Felder 400); W6 (`same-origin` + `no-store`). Wildcard-CORS (es gibt kein CORS-Plugin), Open Redirect und Next-Cache: Code-Prüfung im Review §67, Header von `/konto` im E2E C |
| §65 | Demo | `portal-demo.integration.test.ts` | E1–E12 (E5./E6./E7. Reset löscht Sessions/Links/offenen E-Mail-Wechsel, E8 503 während Reset, E9 Barrier, E10 alter Consume, E11 Production unverändert), R10 |
| Config | Portal-Variablen | `packages/config/test/portal-config.test.ts` | E-C1–E-C5 |
| Web | Formatierer, Fehler-Mapping, Client | `apps/web/lib/portal.test.ts` | W1–W9 |

E2E (Order §66; `pnpm test:e2e`, `tests/e2e/playwright.config.ts`). `portal-flow.spec.ts` läuft im
Projekt `chromium` (seriell; Web 3100 → Same-Origin-Proxy → API 3101, development, Cookie
`mr_customer_session`), `portal-demo.spec.ts` nur im Projekt `demo-communication` (Demo-Web
3108 → Demo-API 3106, Cookie `__Host-mr_customer_session`, Whitelist `@demo.test`). Daten:
Basis-Seed + `apps/api/scripts/e2e-portal-seed.ts` (echte Fachservices).

| Buchstabe | Spec (Projekt) | Inhalt |
| --- | --- | --- |
| A Magic Login | `portal-flow.spec.ts` (chromium) | Link nur aus der Mail, Fragment, Token weder in URL noch Storage, HttpOnly-Session, Einmal-Link |
| B No Enumeration | `portal-flow.spec.ts` (chromium) | unbekannt/doppelt/gelöscht ⇒ identische neutrale Antwort ohne Link |
| C Active Booking | `portal-flow.spec.ts` (chromium) | Snapshot-Ansicht, exakt vs. Fenster, Abholadresse + Navigation, Anrufen, keine Interna, Header |
| D Multiple Current Bookings | `portal-flow.spec.ts` (chromium) | Liste nach Eventdatum, dann Vorgangsnummer |
| E Documents | `portal-flow.spec.ts` (chromium) | Angebot, AB, Lieferschein, Übergabeprotokoll; private PDFs |
| F Chat + Photo + Staff Reply | `portal-flow.spec.ts` (chromium) | Text + Foto, Push ohne Text, Antwort Kanal Portal, Mail-Hinweis ohne Chattext |
| G „Unterwegs“ | `portal-flow.spec.ts` (chromium) | aktive Tour, kein GPS/ETA/Fahrer |
| H Profile Reauth | `portal-flow.spec.ts` (chromium) | blockiert ⇒ Bestätigungslink ⇒ speichern; Ablauf und Snapshot unverändert |
| I Email Change + Session Revoke | `portal-flow.spec.ts` (chromium) | Link an neue Adresse, alle Sessions widerrufen, Login nur neu |
| J Free Cancellation | `portal-flow.spec.ts` (chromium) | 0 €, Bestätigung ohne Dokument- und Nachrichtenbereich, Wiederholungs-POST mit `expectedFeeCents: 0` idempotent, genau eine Mail, danach nicht im Dashboard |
| K Paid Cancellation Fee | `portal-flow.spec.ts` (chromium) | 50 % der regulären Maschinenmiete, „Rechnung folgt“, Nachrichten lesbar ohne Formular |
| L Cancellation Blocked | `portal-flow.spec.ts` (chromium) | Kundentext + Anrufen, POST (mit Prüfwert) 409 `PORTAL_CANCELLATION_BLOCKED` |
| M No Active Booking | `portal-flow.spec.ts` (chromium) | „Neue Anfrage starten“ mit konfigurierter URL |
| N Demo Portal + Reset | `portal-demo.spec.ts` (demo-communication) | Banner, Whitelist + „[DEMO]“, Login über Demo-Web; nach Reset Session ungültig, alter Link wirkungslos |
| O 30-Day Session / no sliding | `portal-flow.spec.ts` (chromium) | Ablauf exakt 30 Tage, Aktivität verschiebt nichts |
| P IDOR mit zwei Customers | `portal-flow.spec.ts` (chromium) | fremde Buchung/Dokument/Nachricht/Foto/Storno ⇒ 404, Client-IDs abgelehnt, Logout |

- Sperrfenster (Berlin): `portal-flow.spec.ts` nicht zwischen 23:38 und 00:02 Uhr starten –
  Szenario G legt eine Lieferung HEUTE an (`todayWindow(30, 90)`), sonst bricht `beforeAll`
  mit „Resttag zu kurz“ ab (Kopfkommentar der Spec).
- Einzige DB-Schreibhilfe im E2E ist die reine Zeitverschiebung von Session-Zeilen (H, O);
  weitere Seed-Abkürzungen (Live-Standort für G per SQL, Kopie der Dokument-Bytes ins
  Storage der E2E-API) stehen in OPEN_ITEMS „Phase 15“.
- Staff-Logins im Browser, die als Vorbedingung einloggen (`login` in `helpers/settlement.ts`,
  `loginStaff` in `helpers/tours.ts`, Inline-Logins der Fachspecs), senden über
  `submitStaffLogin` (`tests/e2e/helpers/staff-login.ts`) ab. Nur wenn `POST /auth/login` mit 429
  antwortet UND die Seite „Rate limit exceeded, retry in N …“ zeigt, wartet der Helfer N + 1 s
  (je Versuch max. 65 s, max. 6 Versuche, Wartezeit wird dem Test-Timeout gutgeschrieben) und
  sendet erneut; jede andere Antwort prüft der Aufrufer unverändert. Grund: Login-Limit
  10/min je IP + E-Mail – im Komplettlauf meldet `communication-ops.spec.ts` den Admin kurz
  hintereinander mehrfach an, die Folgespecs sofort wieder. Muster wie Phase 14 `demoApiLogin`;
  `staff-auth.spec.ts` (Login-Verhalten inkl. Fehlversuche) nutzt den Helfer bewusst nicht.

Review-Regressionstests (adversarialer Review Order §67, Funde R1–R13; jeder vor dem Fix rot):

| Fund | Inhalt | Datei | Tests |
| --- | --- | --- | --- |
| R1 | Stornozeile schlägt Vorgangsstatus (Reopen nie `active`); keine Staff-Portalantwort bei Stornozeile (409, `canReplyPortal` false, keine Hinweis-Mail), Gegenprobe ohne Storno | `portal-review-booking.integration.test.ts` | 6 × „R1. …“ |
| R2 | Gebühr an die Vorschau gebunden (Mitternacht ⇒ 409 `PORTAL_CANCELLATION_FEE_CHANGED`, Pflichtfeld, Prüfung unter der Sperre) | `portal-review-booking.integration.test.ts`; Web `apps/web/lib/portal-review.test.ts` | 3 × „R2. …“; Web 3 (Texte, Body, Neuladen der Vorschau) |
| R3 | Body-Limit-Kette Client-Vorprüfung 8 MiB Rohbytes < API 12 MiB ≤ Next-Rewrite-Puffer 13 MiB (der Testname gibt die Reihenfolge verkürzt als „Browser ≤ Next-Rewrite ≤ API“ wieder; geprüft wird Next ≥ API) | `apps/web/lib/portal-review.test.ts` | „R3. …“ |
| R4 | DB-Versanddrossel (Login/E-Mail-Wechsel je Kunde, Reauth je Session, rotierendes `X-Forwarded-For`); Hop-Semantik und Doku | `portal-review-auth.integration.test.ts`; `portal-review-web.integration.test.ts` | 4 × „R4. …“; 2 × „R4. …“ |
| R5 | keine weitere Bestätigungsmail nach `failed`; Rate-Limit 10/min je Session | `portal-review-booking.integration.test.ts` | 2 × „R5. …“ |
| R6 | parallele E-Mail-Wechsel/Consumes ohne 500, Login-Rennen | `portal-review-auth.integration.test.ts` | 5 × „R6. …“ |
| R7 | Profil-PATCH schreibt `email`/`type` nie | `portal-review-auth.integration.test.ts` | 2 × „R7. …“ |
| R8 | E-Mail-Wechsel neutral 202, belegte Adresse verbraucht das Kontingent (Platzhalterzeile) | `portal-review-auth.integration.test.ts`; Web `apps/web/lib/portal-review.test.ts`; `portal-profile` P15 | 3 × „R8. …“; Web „R8. …“ und „R2./R8. …“ |
| R9 | Papierkorb widerruft Sessions/Links, auch im Rennen | `portal-review-auth.integration.test.ts` | 3 × „R9. …“ |
| R10 | Demo-Reset löscht `portal.*`-Security-Events | `portal-demo.integration.test.ts` | „R10. …“ |
| R11 | Bestätigung des Kundenstornos an die aktuelle Adresse; Staff-Storno Snapshot | `portal-review-booking.integration.test.ts` | 2 × „R11. …“ |
| R12 | 24-h-Fenster nur Kundenstorno, nur Detail/Storno-POST; Staff-0-€-Storno sofort unsichtbar | `portal-review-booking.integration.test.ts` | 2 × „R12. …“ |
| R13 | abgeschlossen ohne (übertragene) Abrechnung ⇒ „Rechnung wird vorbereitet“ | `portal-review-booking.integration.test.ts` | 2 × „R13. …“ |
| Polyglot-CSP | Foto-Route mit `default-src 'none'; sandbox` | `portal-chat.integration.test.ts` | „Polyglot-CSP. …“ |

Wegen geänderter Verträge bewusst angepasste Bestandstests: `portal-cancellation` (Body mit
`expectedFeeCents`, C15/C16 laden die Vorschau vorher, C19 strenge Payloads),
`portal-security-dto` S1/S5, `portal-visibility` V7 (Kundenstorno statt Staff-Storno),
`portal-profile` P12./P13./P15 (neutraler Text, kein nutzbarer Link), E2E J/L (Prüfwert im
Storno-Body, Bestätigungsansicht ohne Dokumente/Nachrichten).

Phase 15 Final-Korrektur (2026-11-06; bezahlte Buchung nach Reopen, Entscheidungen Storno +
Reopen und Portalnachricht – docs/CUSTOMER_PORTAL.md §4/§7, TECH_DECISIONS „Phase 15
Final-Korrektur: bezahlte Buchung nach Reopen (2026-11-06)“). Datei
`apps/api/test/portal-review-reopen.integration.test.ts`, Testnamen „R15-1. …“ bis „R15-10. …“
sowie „R15-2b. …“ und „R15-4b. …“ (nicht zu verwechseln mit „R15. …“ in
`handover-finalization` und `communication-retention-final`, andere Phasen):

| Test | Inhalt |
| --- | --- |
| R15-1 | `completed` + Abrechnung final (`locked_at` gesetzt) + `payment_status = 'paid'` ⇒ unsichtbar |
| R15-2 | derselbe Vorgang danach `reopened` ⇒ weiterhin unsichtbar |
| R15-2b | Staff-Portalantwort bei bezahltem, wiedereröffnetem Vorgang gesperrt (409, `canReplyPortal` false, keine Hinweis-Mail) |
| R15-3 | derselbe Vorgang danach wieder `open` (technisch simuliert) ⇒ weiterhin unsichtbar, solange die Abrechnung final und bezahlt ist |
| R15-4 | `reopened` + übertragene Abrechnung mit Zahlungsstatus `open` bzw. NULL ⇒ weiterhin sichtbar (`active`), Staff-Portalantwort möglich |
| R15-4b | `reopened` + Abrechnung nicht übertragen (`locked_at` NULL) ⇒ sichtbar |
| R15-5 | `reopened` + Zahlungsstatus `overdue` ⇒ sichtbar |
| R15-6 | Storno + Reopen ⇒ bestehende Storno-Regeln unverändert |
| R15-7 | Storno + Reopen ⇒ Staff-Portalantwort weiterhin gesperrt |
| R15-8 | Portalnachricht nach versandter Vorinformation: kein `customer_response_received_at`, keine Klärung `customer_response`, Abrechnung unverändert |
| R15-9 | alte bezahlte, wiedereröffnete Buchung: `GET /portal/bookings` leer; Detailroute, Dokumente, Nachrichten, Travel-Status, Storno-Vorschau, Nachricht senden und Storno-POST ⇒ 404 |
| R15-10 | mehrere Buchungen: alte bezahlte + wiedereröffnete unsichtbar, aktuelle offene sichtbar |

## Website, CMS, Konfigurator, Bewertungen (Phase 16)
Fachdoku: docs/WEBSITE_CMS.md, docs/WEBSITE_CONFIGURATOR.md,
docs/GOOGLE_REVIEWS_API_NOTES.md. Testnamen tragen das Kürzel am Anfang („C5. …“, „PI6. …“,
„W-C3 …“). Integration: `cd apps/api && TEST_DATABASE_URL=… TEST_DATABASE_URL_SECOND=… pnpm
vitest run --config vitest.integration.config.ts <Datei>`; `cms-preview` (P10) und `public-demo`
nutzen die zweite Datenbank (Default `mietroyal_test7`). Unit API: `cd apps/api && pnpm vitest
run`; Domain/Config/Validation: `pnpm vitest run` im Paket; Web: `pnpm --filter @mietroyal/web
test` (`node --test`). Kein echter Google-/SMTP-/Provider-Aufruf: Google nur gegen den lokalen
Contract-Fake `apps/api/src/reviews/testing/fake-places-server.ts` bzw. injizierte Gateways.
Test-Helfer: `apps/api/test/cms-helpers.ts` (`publishCmsForTests`, `publishPrivacyForTests`,
`truncateCmsTables`), `apps/api/test/cms-world.ts`, `apps/api/test/public-helpers.ts`
(`inquiryBody`, `resetPublicWorld`). Eine Website-Anfrage braucht eine veröffentlichte
Datenschutz-Revision (`publishPrivacyForTests`); `TRUNCATE staff_users CASCADE` leert auch alle
CMS-Tabellen.

Pflichttests (Order §25):

| Bereich | Thema | Datei (unter `apps/api/test/`, sofern nicht anders genannt) | Testnamen |
| --- | --- | --- | --- |
| CMS | Rechte `cms.edit` vs. `cms.publish`, immutable Revisionen, Konflikt, Entwurf nie öffentlich, atomares Publish (stale, parallel), Pflichtangaben, Restore, Zurückziehen, Regionsanlage, Preistext, exakte Adresse, Audit ohne Texte, Empfehlungsregeln, strikte Bodies | `cms-editorial.integration.test.ts` | C1–C14 |
| CMS | Medien: Upload-Recht, SVG/HTML/GIF/getarnt/defekt/zu groß, EXIF entfernt, Varianten, Entwurfsmedium 404 ⇒ nach Publish 200 + `immutable`, `cms_revision_media`, kein Storage-Key in DTO/Log | `cms-media.integration.test.ts` | M1–M6 |
| CMS | Vorschau: Hash-only/30 min/no-store/Audit, einmalig, Cookie-Attribute, gebundene Revision, fremde Revision 404, Ablauf + Cleanup, Vorschau-Medien, Einstellungs-Vorschau, Token/Cookie nicht im Log, Cross-/Same-Site 403, Demo/Live (zwei DBs), 409 ohne Basis-URL + Rate-Limit, Nur-Publisher | `cms-preview.integration.test.ts` | P1–P12 |
| CMS | Öffentliche Projektion: Settings-DTO ohne Regeln/Notizen, Katalogpreise/Inklusivleistungen, Preis ab `effective_from`, Adress-Fail-closed im Lesepfad, Reviews-Block nur mit Provider, strikte Pfade, kein CORS | `cms-public-site.integration.test.ts` | S1–S6 |
| CMS | Bootstrap: Entwürfe, idempotent, überschreibt nie, ungültige Einträge, `--publish-demo` in production/staging verweigert, echte Standardliste, Skript-Exit-Codes | `cms-bootstrap.integration.test.ts` | B1–B8 |
| CMS | CMS überlebt den Demo-Business-Reset (Zählungen vor/nach), Vorschau-Cookie in demo `__Host-` | `cms-demo-reset.integration.test.ts` | R1 |
| CMS | Inhaltsschema (Blocktypen, strict, kein HTML, Preistext, Adressfragmente, Empfehlungsregeln, Pfade) | `packages/validation/test/cms.test.ts` | beschreibende Testnamen (ohne Kürzel) |
| Inhalte | Bootstrap-Inhalte: Pflicht-Einträge, Schema, Pfade, Sperrliste, Altlasten, keine Medien/Instagram/Regeln, du-Ansprache, Links, Regions-Schablonen-Prüfung, Rechtstexte nur Text | `cms-bootstrap-content.test.ts` (Unit) | beschreibende Testnamen (ohne Kürzel) |
| Produkte/Preise | Katalog = ProductService-Preis, Deep-Scan ohne IDs/Bestände/Historie, geplanter Preis ab Wirksamkeit (Fake-Zeit), inaktive/preislose Produkte fehlen, Abholung nur Region | `public-configurator.integration.test.ts` | PC1–PC5 |
| Konfigurator | vier Maschinentypen, Gratis-Sirup je Behälter, „Sorte später abstimmen“, Kommission, Kanisterlimit, Lieferung ohne Preis, ≥ 250 nur Hinweis, fehlende Regel blockiert nie, Regeln nicht überlappend, nur Slush-Maschinen, strikter Body/Cross-Site | `public-configurator.integration.test.ts` | PC6–PC16 |
| Konfigurator | Pricing-Helfer „Auswahl ⇒ PricingInput“, Domain-Konstanten, `PricingError.code` | `packages/domain/test/pricing-input.test.ts` | beschreibende Testnamen (ohne Kürzel) |
| Website-Anfrage | genau ein Vorgang, `source = website`, `created_by` NULL, Organisation, Zeiten Berlin/Folgetag, Lieferung ohne Preis, Retry/Doppelklick idempotent, 409 mit Vorgangsnummer, Datenschutz fail-closed, E-Mail-Treffer ohne CRM-Overwrite, Dublette, Portal-Session, ≥ 250, kein Verfügbarkeits-Reject, atomar, Server prüft erneut, keine PII im Log, Cross-Site, Staff-Hinweis, Submission unveränderlich, Rate-Limit | `public-inquiry.integration.test.ts` | PI1–PI20 |
| Website-Anfrage | Pool max = 1 (neuer Kunde, E-Mail-Treffer, Portal, Retry, parallel, Vorschau mit Empfehlung) | `public-inquiry-pool.integration.test.ts` | PP1–PP3 |
| Demo | Demo-Anfrage in der Demo-DB, 503 während Reset, Löschliste | `public-demo.integration.test.ts`; `demo-reset.integration.test.ts` | PD1–PD3; D-R2b (Submissions gelöscht, CMS-Zählungen unverändert) |
| Bewertungen | Config-Regeln je Umgebung (Default disabled, fake in production/staging, google in demo, Pflichtwerte, Key nur im Objekt, Isolation, `.env.example`) | `packages/config/test/reviews-config.test.ts` | RC1–RC9 |
| Bewertungen | Google-Gateway gegen lokalen Fake-HTTP-Server (Feldmaske/Header/Sprache, Pflicht-Attribution, Host-Allowlist, Fehlerbilder, Timeout ohne Wiederholung, 429-Pause, kein Cache, Tagesgrenze) | `reviews-gateway.test.ts` (Unit) | RG1–RG13 |
| Bewertungen | Fabrik/Laufzeitsperren, Fake eindeutig DEMO, DTO, Log-Redaktion | `reviews-factory.test.ts` (Unit) | RF1–RF8 |
| Bewertungen | Route: disabled 404, Demo-Fake, Startabbruch production/staging-Fake bzw. demo-Google, Google-DTO, nichts in der DB, Ausfall ⇒ 503 bei erreichbarer Website, globale Grenze, Key nie im Log, Cross-/Same-Site 403, 10/min | `reviews-public.integration.test.ts` | RV1–RV10 |
| Web | Header-Matrix `next.config.ts` (`/vorschau*`, `/angebot/:token` neu; Token-Seiten/`/konto` unverändert; `/kontakt` ohne Token-Header) | `apps/web/lib/next-config.test.ts` | W-H1–W-H5 |
| Web | Formatierung Cent ⇒ EUR, Preiszeilen, Absätze, Seitentitel, Telefonlink; Indexierungs-Entscheidung und CMS-Metadaten | `apps/web/lib/site-format.test.ts`; `apps/web/lib/site-meta.test.ts` | W-F1–W-F7, W-I1–W-I2; W-I3–W-I6 |
| Web | Navigation (Reihenfolge, nur veröffentlichte CMS-Ziele, Footer, Regionen, Instagram) | `apps/web/lib/site-nav.test.ts` | W-N1–W-N6 |
| Web | SSR-Fetch, Formprüfung, Origin-Vergleich Build/Laufzeit | `apps/web/lib/site-api.test.ts` | W-A1–W-A5, W-O1–W-O2 |
| Web | Vorschau: Fragment-Parser, Cookie-Header, Consume (same-origin, no-referrer), neutrale Fehlertexte, Banner | `apps/web/lib/site-preview.test.ts` | W-P1–W-P5 |
| Web | Konfigurator: `clientMutationId`-Speicher (nur ID), Payload, Übersicht ohne Preise im Request, Antwort-/Fehlermatrix, Texte, sechs Schritte, Schrittprüfungen, Lieferfenster-Reihenfolge, Feldzuordnung der 400-Pfade | `apps/web/lib/configurator.test.ts` | W-C1–W-C18 |
| Web | Block-Typen-Abdeckung des Renderers (gespiegelt aus `CMS_BLOCK_TYPES`), H1-Regel, Bilder, Kontaktblock (auch `secondary_offer`); Bewertungen (nur mit Provider, Pflicht-Attribution, Demo ohne „Google“, Richtlinienhinweis, Übersetzung, Modus-/Origin-Abweichung); Fokuskontrast CTA-Band | `apps/web/lib/site-blocks.test.ts`; `apps/web/lib/reviews.test.ts` | W-B1–W-B7, W-R1–W-R5; W-R6–W-R12, W-A11Y1 |
| Regression | Startseite (Fallback ODER veröffentlichter Inhalt, eine H1, CTA, Kundenbereich, kein „verbindlich buchen“) | `tests/e2e/specs/smoke.spec.ts` | angepasster Startseiten-Test |

Review-Regressionstests (Review vom 2026-11-06; die Kürzel setzen die Reihen oben fort):

| Fund | Thema | Datei | Testnamen |
| --- | --- | --- | --- |
| pricing-1, cms-2, content_ux-1 | Preis-Freitext in Strich-/Währungsvarianten („60,- €“, „60,– €“, „60.- EUR“, „EUR60“, „60,-“) und mit unsichtbaren Zeichen ⇒ 400 beim Speichern UND Veröffentlichen; Zeit-/Mengenangaben bleiben erlaubt | `packages/validation/test/cms.test.ts`; `cms-editorial.integration.test.ts` | „erkennt übliche deutsche Preisschreibweisen …“; C15 |
| cms-1, pricing-2 | Abholadresse ohne Komma, mit PLZ vorn, in Schreibvarianten (Nr., ohne Leerzeichen, Bindestrich, Formatzeichen, URL-Kodierung) ⇒ 400; Firmenname/Region bleiben erlaubt; Lesepfad fail-closed | `packages/validation/test/cms.test.ts`; `cms-editorial.integration.test.ts`; `cms-public-site.integration.test.ts` | „Fragmente: Straße + Hausnummer auch ohne Komma …“, „erkennt Schreibvarianten der Adresse …“, „erkennt die exakte Abholadresse und ihren Straßenteil (normalisiert)“; C16; S7 |
| pricing-3 | Produktbeschreibung mit Adresse ⇒ `null`, Produktname mit Adresse ⇒ Produkt öffentlich weg (Katalog, `product_grid`, `included_items`, Staff-Lesesicht, Vorschau, Empfehlung); Log nur Slug | `cms-public-site.integration.test.ts`; `public-configurator.integration.test.ts` | S8; PC18 |
| cms-3 | C1-, Bidi-, Zero-Width-, Format- und U+2028/U+2029-Zeichen in Titel, Text, Meta, Alt-Text, Redaktionsnotiz, Medien-Bezeichnung/-Standard-Alt-Text ⇒ 400 `VALIDATION_ERROR` | `packages/validation/test/cms.test.ts`; `cms-editorial.integration.test.ts`; `cms-media.integration.test.ts` | Block „Steuer- und Formatzeichen (Review cms-3)“; C17; M7 |
| pricing-4 | Maschinen-Slug als Sirup ⇒ `SYRUP_UNAVAILABLE` am Sirup (Vorschau) bzw. 400 am Sirupfeld (Anfrage), Maschine normal berechnet | `public-configurator.integration.test.ts`; `public-inquiry.integration.test.ts` | PC17; PI24 |
| inquiry-1 | Wiederholung nach Mitternacht (Eventdatum vergangen): gleiche ID + Inhalt ⇒ 200, anderer Inhalt ⇒ 409, neue ID ⇒ 400 | `public-inquiry.integration.test.ts` | PI21 |
| inquiry-2 | Uhrzeit in der Sommerzeit-Lücke ⇒ 400 am jeweiligen Feld; gespeichertes Ende liegt immer nach dem Beginn | `packages/domain/test/scheduling.test.ts`; `public-inquiry.integration.test.ts` | „Phase 16: berlinLocalTimeExists – …“; PI22 |
| inquiry-3 | Wunsch-Lieferzeitfenster am Veranstaltungstag: Ende ≤ Beginn ⇒ 400 an `body.fulfillment.windowTo` (keine Folgetag-Regel); Eventzeiten behalten die Folgetag-Regel | `public-inquiry.integration.test.ts` | PI23 |
| demo_reviews-3 | `HEAD /public/reviews` ⇒ 404 ohne Gateway-Aufruf; GET-Limit bleibt 10/min | `reviews-public.integration.test.ts` | RV11 |
| demo_reviews-1 | Web, Google-Modus: Richtlinienhinweis + https-Link (lokaler Fallback bei fehlenden/ungültigen Feldern), „Von Google übersetzt“, Originaltext nur bei übersetzten Bewertungen; Demo ohne alles davon | `apps/web/lib/reviews.test.ts` | W-R6–W-R8 |
| demo_reviews-4 | Attribution „Google Maps“ mit `translate="no"` und nowrap; Demo nie „Google“ | `apps/web/lib/reviews.test.ts` | W-R9 |
| demo_reviews-2, web_security-1 | Antwort mit anderem Modus als der SSR-Modus ⇒ verworfen („nicht verfügbar“); Build-/Laufzeit-Origin-Abweichung ⇒ Sektion wie `disabled` | `apps/web/lib/reviews.test.ts` | W-R10–W-R12 |
| demo_reviews-5 | Demo-Instanz immer noindex, auch mit `WEB_INDEXING_ENABLED=true` | `apps/web/lib/site-meta.test.ts` | W-I3 |
| web_security-2 | Fallback-Startseite und „nicht erreichbar“ immer noindex; CMS-Routen (404/noindex); `/konfigurator` ohne Katalog/Maschine noindex | `apps/web/lib/site-meta.test.ts` | W-I4–W-I6 |
| content_ux-2 | Kontaktblock auf `secondary_offer`: nur Telefon/E-Mail, keine Abholzeile, kein Konfigurator-Knopf; andere Seitentypen unverändert | `apps/web/lib/site-blocks.test.ts` | W-B7 |
| content_ux-3 | Fokusrahmen im CTA-Band in Gold, Kontrast ≥ 3:1 (nachgerechnet aus den CSS-Tokens) | `apps/web/lib/reviews.test.ts` | W-A11Y1 |
| web_security-3 | `tel:`-Link ohne geklammerte „(0)“ nach der Ländervorwahl, andere Schreibweisen unverändert | `apps/web/lib/site-format.test.ts` | W-F7 |
| inquiry-2/-3 (Web) | Lieferfenster Ende ≤ Beginn blockiert den Schritt mit der API-Meldung am Feld `windowTo`; 400-Pfade (Zeitumstellung/Lieferfenster) ⇒ richtiger Schritt und richtiges Feld, Meldung genau einmal | `apps/web/lib/configurator.test.ts` | W-C17, W-C18 |

Die Sperre der Konfigurator-Steuerelemente bis zur Hydration (E2E-Beobachtung) hat keinen eigenen
Unit-Test; sie ist im SSR-HTML sichtbar (`fieldset disabled`, `data-hydrated="false"`,
`cfg-hydrating`) und wird durch die E2E-Specs C–G mit abgedeckt (`openConfigurator` wartet auf
die erste Vorschau-Antwort, Playwright wartet auf aktivierte Felder).

Security-Pflichtpunkte (§25) sind in den Dateien oben verteilt: Cross-Site-Mutation (C14/P9/PC16/
PI17/RV9), keine CORS-Wildcard bzw. keine CORS-Header (S1/P9/PI17), Vorschau
noindex/no-store/no-referrer (P1/P2, W-H*), `/konto` weiterhin privat/noindex und Token-Seiten
unverändert (W-H*, `apps/web/lib/portal.test.ts`), keine PII/Tokens/Keys im Log (P8/PI16/RV8/M6).

Phase-16-E2E (Order §26, Szenarien A–M; `pnpm test:e2e`, `tests/e2e/playwright.config.ts`):

| Spec | Projekt | Tests |
| --- | --- | --- |
| `tests/e2e/specs/website-flow.spec.ts` (serial) | `chromium` | A1, A2, B, C, D, E, F, G1, G2, M, L |
| `tests/e2e/specs/website-cms.spec.ts` (serial) | `chromium` | H, I, J |
| `tests/e2e/specs/website-demo.spec.ts` (serial) | nur `demo-communication` (in `chromium` per `testIgnore` ausgeschlossen) | K1, K2, K3 |

Daten und Helfer: Seed `apps/api/scripts/e2e-website-seed.ts` (Kindprozess; echter
CMS-Bootstrap mit `CMS_BOOTSTRAP_ENTRIES` und `publishDemo` – derselbe Weg wie
`pnpm cms:bootstrap --publish-demo`, damit auch `/datenschutz` veröffentlicht; Ziel `main`
legt zusätzlich je einen Mitarbeiter „nur `cms.edit`“ und „nur `cms.publish`“ an, Ziel `demo`
nur Inhalte in `mietroyal_test_demo`; Sicherheitsstopp ohne `mietroyal_test` im DB-Namen;
idempotent), Helfer `tests/e2e/helpers/website.ts` (`seedWebsite('main'|'demo')`,
Mitarbeiter-Konstanten, DB-Lesehelfer, Katalog direkt an der API, `euro`/`priceText` als
Spiegel der Web-Formatierung, Konfigurator-Schritte über `data-testid`, `openConfigurator`
wartet auf die erste Vorschau-Antwort (erst nach der Hydration), `RateWindow`, im Test
erzeugtes PNG – keine Fremd-/Stockbilder). `website-flow` und `website-cms` setzen im
`beforeAll` die DB zurück und seeden das CMS neu (der Basis-Seed leert `staff_users CASCADE`
und damit das CMS); `website-demo` seedet die Demo-DB idempotent (CMS überlebt Demo-Resets).
M hängt innerhalb von `website-flow` an C. Demo-API der E2E-Suite mit `REVIEWS_PROVIDER=fake`,
Haupt-API mit Default `disabled` (nie Google, kein Key).

| Test | Inhalt |
| --- | --- |
| A1 | Startseite Desktop: Navigation (7 Punkte, Labels, `aria-current`), kein Menü-Knopf, CTA Kopf + Hero → `/konfigurator`, genau eine H1, alle veröffentlichten Seiten durchgeklickt, kein Fake-Content (Zähler, Sterne, „verbindlich buchen“, WhatsApp, Google), keine Reviews-Sektion ohne Provider, keine exakte Abholadresse, keine Requests an fremde Hosts, Kundenbereich ohne Website-Rahmen |
| A2 | Startseite mobil (390×844): Menü-Knopf mit `aria-expanded`, Escape schließt (Fokus zurück), Navigation per Menü, CTA ≥ 44 px als volle Zeile, kein horizontales Scrollen (Start + Konfigurator) |
| B | Slush-Seite: Preise = Katalog = Staff-`/staff/products`; Preisänderung per `POST /api/staff/products/:id/price` (`price.manage`) erscheint auf Slush- und Startseite, CMS-Einträge/-Revisionen unverändert |
| C | Konfigurator Abholung (6 Schritte, Fallback-Empfehlung, Katalogpreise, keine Bestandsworte, Gratis-Sirup + „Sorte später abstimmen“, „Mainz-Hechtsheim“ ohne exakte Adresse, Datenschutz-Checkbox) ⇒ Vorgangsnummer; DB genau +1 Vorgang/Anfrage/Kunde/Submission, `source = website`, `created_by` NULL, `customer_match = new_customer`, Datenschutz-Revision; Staff-Kasten „Website-Anfrage“ |
| D | Konfigurator Lieferung: Adresse + Zeitfenster 14–16 Uhr, „individuell geprüft“, nirgends ein Lieferpreis; DB-Fenster am Eventtag (Europe/Berlin), Staff-Hinweis |
| E | Großevent: 249 ohne, 300 mit Hinweis (Schritt 1 + Zusammenfassung), Absenden möglich |
| F | Sirup & Zubehör: Gratis-Kontingent je Behälter, 25 + 25 inklusive, Kommission mit Einheitspreis, Kanister 0 vorausgewählt und max. 2 je Behälter; Server-Vorschau meldet `CANISTER_LIMIT_EXCEEDED` + `FREE_SYRUP_BUDGET_EXCEEDED`; Selections exakt |
| G1 | Doppelklick ⇒ dieselbe `clientMutationId`, genau +1 Vorgang, ID danach aus `sessionStorage` gelöscht; identischer Payload erneut ⇒ 200, gleiche Nummer |
| G2 | Netzabbruch NACH der Serververarbeitung (`page.route` + `route.fetch()` + `route.abort('connectionreset')`) ⇒ „unklar“ + „Erneut senden“, Formular gesperrt, Web Storage nur UUID; Retry ⇒ 200, dieselbe Nummer, weiterhin genau +1 |
| M | Regression Angebotslink: Angebot aus der Website-Anfrage von C ⇒ `/angebot/<token>` (noindex, no-referrer, no-store/no-cache, ohne Website-Rahmen) inkl. Annahme; `/kontakt/<token>` noindex; `/kontakt` (CMS) mit Rahmen, ohne X-Robots-Tag |
| L | Regression Kundenportal: Magic-Link-Login (`/konto`, SMTP-Senke), aktive Buchung, ohne Website-Rahmen |
| H | CMS: Entwurf `/ueber-uns` speichern ⇒ öffentlich unverändert ⇒ „Vorschau öffnen“ (Popup, Fragment-Token, Consume, Cookie `mr_cms_preview` HttpOnly/Strict) zeigt Entwurf mit Banner, noindex/no-store/no-referrer ⇒ Veröffentlichen ⇒ öffentlich Revision 2, Audit `cms.published` |
| I | Rechte: nur `cms.edit` speichert, kein Veröffentlichen-Knopf, `POST …/publish` 403; nur `cms.publish` im Lesemodus, `PUT …/draft` und Medien-Upload 403, Vorschau + Veröffentlichen möglich (`published_by`) |
| J | Medien: PNG hochladen (Standard-Alt-Text), in `/faq` einsetzen ⇒ öffentlich weder Bild noch Medien-URL (404) ⇒ nach Veröffentlichen `<img alt>`, Varianten 200 `image/webp`, `immutable`, `nosniff`; kein Storage-Key in DOM/Antworten |
| K1 | DEMO-Banner auf allen veröffentlichten Seiten, `/konfigurator` und 404 der Demo-Web-Instanz; Live-Web ohne Banner; keine Fremd-Requests |
| K2 | Demo-Bewertungen nur als DEMO (Fake-Provider, Klick-zum-Laden, nie „Google“, keine Bilder/Links); Live `disabled` ⇒ 404 `REVIEWS_DISABLED`, keine Sektion; kein Google-Request, kein Places-Key |
| K3 | Anfrage über die Demo-Web-Instanz ⇒ +1 nur in der Demo-DB, Live-DB unverändert |

Rate-Limits sind in allen E2E-APIs aktiv (alle Requests von 127.0.0.1): `POST /public/inquiries`
5/min + 20/h je API-Prozess, Konfigurator-Vorschau 60/min. `RateWindow` zählt die eigenen
Requests je Route über alle Browserkontexte und wartet nur bei Bedarf (Budget ≤ 4 Anfragen/min,
≤ 45 Vorschauen/min; die Wartezeit wird dem Testtimeout gutgeschrieben, Log-Zeile
`[rate-window] …`). `website-flow` wartet dafür typischerweise einmal ~55 s vor G1. Weil
`website-flow` je Lauf bis zu 9 Anfragen sendet (C, D, E, F je 1; G1 bis zu 3; G2 2), darf die
Spec höchstens 2× je Playwright-Aufruf (gegen denselben API-Prozess) laufen – nie
`--repeat-each=3` o. ä. Keine andere Spec nutzt diese Routen; K läuft gegen die Demo-API
(eigener Prozess, eigenes Limit).

Hinweise: `next dev` ersetzt `Cache-Control` (no-cache) – Header-Assertions auf Web-Seiten
tolerant halten (API-Header exakt); „Vorschau öffnen“ öffnet ein Popup (erst `about:blank`,
dann die Vorschau-URL). Quality-Gate-Ergebnisse (Order §27) stehen im Phase-16-Abschlussbericht,
nicht in diesem Dokument.

## Definition of Done
Fachregel korrekt, Rechte serverseitig, Validierung, Fehlerfall,
responsive, Tests ausgeführt, Doku aktualisiert, Staging geprüft.
