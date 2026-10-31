# INTEGRATIONS — Externe Systeme

## Grundsatz
Externe Systeme dürfen den Kernbetrieb nicht blockieren.
Connector + robuste Hintergrundjobs + Idempotenz + Retry.

## Lexware
Miet-Royal liefert finale Rechnungsdaten.
Lexware:
- Rechnung erzeugen
- automatisch per E-Mail versenden
- Buchhaltung/Mahnwesen

Zurück mindestens:
- Offen
- Bezahlt
- Überfällig
- Rechnungsnummer, wenn API verfügbar

Exakte aktuelle API erst gegen tatsächlich genutzte Lexware-Version validieren.
Keine erfundene Schnittstelle.

Bei Transferausfall:
- Retry
- Status „Lexware-Übertragung ausstehend“
- wiederholt fehlgeschlagen → Admin informieren
- keine Doppelrechnung

Miet-Royal verfolgt nicht zusätzlich, ob Lexware-Rechnungsmail zugestellt wurde.

### Umsetzung Phase 9: AccountingGateway (Vorstufe zu Lexware)
Es gibt genau eine Grenze zwischen Abrechnung/Storno und Buchhaltung:
`AccountingGateway` (`apps/api/src/accounting/gateway.ts`).
- `MockAccountingGateway` in development/staging (seit Phase 14 NICHT mehr in
  demo): deterministische Referenz `MOCK-RE-<Vorgangsnummer>-<lfd>` bzw.
  `MOCK-STORNO-…`, in der Oberfläche immer als „MOCK“ gekennzeichnet; keine
  Rechnung, kein PDF, kein Versand. Fehler nur über explizite Simulation
  (`fail-next`), nie zufällig.
- `DisabledAccountingGateway` in production ohne Lexware-Anbindung UND in demo
  (Phase 14, W1): jede Übertragung wird mit „Buchhaltungsintegration nicht
  konfiguriert“ abgewiesen; nichts wird als übertragen markiert, keine
  Endlos-Retries (kein Job eingestellt).
- Übertragung läuft ausschließlich über `AccountingTransferService`
  (`accounting_transfers`): eingefrorener Payload-Snapshot VOR dem ersten
  Versuch (Hash dokumentiert), stabiler Idempotenzschlüssel
  (`settlement-transfer:<id>` / `cancellation-transfer:<id>`), Zeilensperre
  für die Dauer des Gateway-Aufrufs (Doppelklick, paralleler Worker, Retry ⇒
  genau eine externe Übertragung), Fehlercode ohne Stacktrace, Retry mit
  Backoff über die bestehende PostgreSQL-Queue (`settlement.accounting_transfer`,
  `cancellation.accounting_transfer`).
- Payload (`AccountingPayload`, schemaVersion 1): Vorgangsnummer, Kunden- und
  Rechnungsadress-Snapshot, Eventdatum, Positionen, Summen, Credits,
  Endbetrag, Idempotenzschlüssel, interne Settlement-/Storno-ID. Feld `tax`
  ist reserviert (immer null) – Phase 10 ergänzt Steuerinformationen ohne
  Strukturbruch. Keine implizite MwSt., keine „inkl. 19 %“-Texte.
- Zahlungsstatus open/paid/overdue kommt von außen (Phase 10: Lexware-
  Rückfluss); Phase 9 erlaubt ihn nur über die Mock-Steuerung außerhalb von
  production (system.settings). Miet-Royal ist nicht Source of Truth, kein
  Mahnwesen.

### Phase 14 (W1, MASTER_SPEC §29): Demo – Lexware und Buchhaltung immer disabled
In `APP_ENV=demo` liefert `createAccountingGateway` IMMER
`DisabledAccountingGateway`: kein `LexwareClient` (ein `LEXWARE_API_KEY` ist
dort ein Konfigurationsfehler), kein Lexware-API-Aufruf, kein Mock-Erfolg,
keine Fake-Rechnung, keine Fake-Rechnungsnummer, keine externe Referenz, kein
Webhook (`POST /webhooks/lexware` ⇒ 404), keine Zahlungsbestätigung.
`buildApp`, der Worker und der Demo-Seed prüfen zusätzlich fail-closed, dass
in demo/production nie ein Mock-Gateway aktiv ist
(`assertAccountingGatewayAllowed`). Folgen: der Settlement-Hook stellt in der
Demo keinen Auto-Transfer-Job ein, `transferNow`/Storno-Transfer antworten 409
`ACCOUNTING_NOT_CONFIGURED`, `GET /staff/accounting/status` meldet
`{ provider: 'disabled', configured: false, mock: false, mockControlsAvailable:
false, environment: 'demo' }`, die Mock-Steuerung antwortet 409 (nur
`run-due-jobs` bleibt als reiner Job-Trigger erreichbar). Die Abrechnung ist
in der Demo bis „Bereit zur Buchhaltung“ trainierbar; die Sicht trägt den
Blocker `demo_unavailable` (kein Fehlerzustand) mit dem Text
„Buchhaltungsübertragung ist in der Demo nicht verfügbar.“. Der
Wiedermieter-Gutschein der Demo entsteht als Seed-Fixture (W1.1, siehe
TECH_DECISIONS), nie über einen simulierten Transfer.

### Umsetzung Phase 10: Provider „lexware“
Siehe `docs/LEXWARE_API_NOTES.md` (verifizierte Endpunkte, Berechtigungen,
Einschränkungen). Kernpunkte: ein zentraler `LexwareClient`
(`apps/api/src/lexware/client.ts`), gemeinsamer 2-Requests/Sekunde-
Rate-Limiter über PostgreSQL für API und Worker, zweiphasiger Transfer ohne
DB-Sperre während des HTTP-Aufrufs mit Unknown-Outcome-Recovery über die
Belegliste und einen stabilen Transfermarker im Beleg-Remark, Kontakt-
Mapping (`lexware_contact_mappings`), Rechnungs-Mapping
(`lexware_invoice_mappings`), signierte Webhooks (`X-Lxo-Signature`,
RSA-SHA512) als primärer Rückkanal für Zahlungs-/Rechnungsstatus, Event-
Subscriptions per `pnpm lexware:setup`, Reconciliation per
`pnpm lexware:reconcile`. Kein Rechnungs-PDF in Miet-Royal, kein
E-Mail-Versand (Public API hat keinen), kein Mahnwesen. Production bucht nur
mit vollständiger Steuerkonfiguration und eindeutigem Kontakt; Anzahlungen/
Kautionen auf der Rechnung sind fail-closed blockiert (Down-Payment-Invoices
sind in der Public API read-only).

## E-Mail
Umsetzung Phase 9 (Vorstufe): `SettlementNoticeGateway` für die kombinierte
Kundeninformation vor Schaden-/Fehlteilbelastung und die Storno-Bestätigung –
Outbox außerhalb von production (Protokoll in `settlement_customer_notices`
bzw. `cancellations`), in production ohne echten Adapter hart blockiert
(Status `blocked`, niemals „gesendet“). Die 24-h-Frist beginnt nur nach
erfolgreichem Gateway-Aufruf.

Zentraler Mailservice.
Vorlagen u. a.:
Angebot, AB, 7-/1-Tage-Erinnerung, Ausgabe, Rückgabe,
Schaden-/Fehlteil-Vorinfo, Storno, Gutschein, Kundenchat-Hinweis.

Antworten möglichst über eindeutige Reply-Referenz dem Vorgang zuordnen.

## WhatsApp Business
Nur offizielle Business-Anbindung.
Nachrichten in den Vorgang, Antworten aus Staff.
Angebot bleibt Miet-Royal-Link.
Demo nur Simulation.

## Push
Kritisch:
- 1h vor zugewiesenem Termin
- überfällige Rückgabe einmal an Admin
- kurzfristige Neuzuweisung
- Vertretung
- drohende Tourverspätung
- neues Gerät → Admin
- Sperr-/Schadenkonflikt mit Folgebuchung → Admin
- einmal 6h später Erinnerung, wenn noch offen

Geschäftskritische Pushs nicht abschaltbar.
Kein Notification Center.

## Kalender
Miet-Royal ist Source of Truth.
Synchronisieren: Abholung, Rückgabe, Lieferung.
Keine Angebots-/Rechnungs-/Lagerereignisse.
Ausfall → Miet-Royal bleibt gültig, Sync später.
Apple-Technik: in Phase 12 als privater read-only ICS-Feed je Mitarbeiter umgesetzt
(Details, Quellen und Grenzen: docs/COMMUNICATION_INTEGRATIONS.md).

## Routing
Provider liefert Distanz/Fahrzeit/Route.
Miet-Royal schlägt vor, Mitarbeiter entscheidet.
Keine eigene Turn-by-Turn-Navigation.
„Navigation starten“ öffnet bevorzugte Karten-App.

Phase 13 (verifiziert 2026-10-30, `docs/ROUTING_API_NOTES.md`): primärer
Produktionsprovider ist die GraphHopper Directions API hinter der
provider-neutralen Grenze `RoutingGateway` (`geocode`, `route`, `matrix`,
`optimizeTour`; `apps/api/src/routing/`). Implementierungen:
`GraphHopperRoutingGateway` (einziger Provider-Client), `MockRoutingGateway`
(Demo/Entwicklung, deterministisch), `FakeRoutingGateway` (Tests),
`DisabledRoutingGateway`. Genutzte Endpunkte: `GET /geocode`
(provider=nominatim, locale de, limit 5), `POST /route`, `POST /matrix`
(fail_fast=false), `POST /vrp` (synchron, harte Zeitfenster, `in_sequence`).
An den Provider gehen ausschließlich Adresse/Koordinaten, Zeitfenster,
Servicezeiten und anonyme Stopp-IDs – nie Kundenname, Telefon, E-Mail,
Vorgangsnummer, Preise, Schäden, Notizen. API-Key nur serverseitig (Query
`key=`), in Logs redigiert; Fehler werden klassifiziert (auth_invalid,
validation, not_found, rate_limited, credit_limited, timeout, network,
server_error, invalid_response, disabled) und erreichen den Browser nur als
neutrale Meldung („Route konnte gerade nicht berechnet werden.“). Routing ist
read-only und blockiert nie Buchung, Termin, Übergabe oder Rückgabe.
Persistiert werden nur eigene Planungswerte (Reihenfolge, Zeiten, Distanz,
Fahrzeit); Geocoding-Ergebnisse liegen in einem Cache mit Ablauf.
Kartenlinks (Apple Maps, `geo:`, Google/OSM-Web) enthalten nur das Ziel.
Keine Lieferpreisformel: `DeliveryPriceSuggestion` ist eine leere Grenze.

## Dokumente
Serverseitige Templates:
Angebot, AB, Lieferschein, Übergabeprotokoll, Rückgabeprotokoll.
Finale signierte PDFs immutable + Hash.

## QR
QR enthält sichere Maschinenreferenz, keine sensiblen Daten.
Server prüft Auth/Rechte/Kontext.

## Jobtypen
MAIL_SEND, LEXWARE_TRANSFER, CALENDAR_SYNC, PUSH_SEND,
VOUCHER_CREATE_SEND, OFFER_EXPIRY, CLEANING_OVERDUE_CHECK,
MACHINE_CONFLICT_REMINDER, DATA_RETENTION_CLEANUP.
