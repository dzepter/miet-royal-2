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

## E-Mail
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
