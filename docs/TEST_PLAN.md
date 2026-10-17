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

## Definition of Done
Fachregel korrekt, Rechte serverseitig, Validierung, Fehlerfall,
responsive, Tests ausgeführt, Doku aktualisiert, Staging geprüft.
