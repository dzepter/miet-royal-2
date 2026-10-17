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
- `MockAccountingGateway` in development/staging/demo: deterministische
  Referenz `MOCK-RE-<Vorgangsnummer>-<lfd>` bzw. `MOCK-STORNO-…`, in der
  Oberfläche immer als „MOCK“ gekennzeichnet; keine Rechnung, kein PDF, kein
  Versand. Fehler nur über explizite Simulation (`fail-next`), nie zufällig.
- `DisabledAccountingGateway` in production bis Phase 10: jede Übertragung
  wird mit „Buchhaltungsintegration nicht konfiguriert“ abgewiesen; nichts
  wird als übertragen markiert, keine Endlos-Retries (kein Job eingestellt).
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
Apple-Technik vor Phase 12 konkret validieren.

## Routing
Provider liefert Distanz/Fahrzeit/Route.
Miet-Royal schlägt vor, Mitarbeiter entscheidet.
Keine eigene Turn-by-Turn-Navigation.
„Navigation starten“ öffnet bevorzugte Karten-App.

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
