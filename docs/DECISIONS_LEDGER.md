# DECISIONS_LEDGER — Konsolidierte Widersprüche

## Schaden
Schadensmodul dokumentiert; Geldforderung wird separat im Settlement geführt.
So ist „nur Dokumentation“ im Rückgabeprozess mit späterer Kostenabrechnung vereinbar.

## Storno-Mail
Kunden-Selbststorno: automatische Bestätigung.
Mitarbeiter-Storno: Mail optional beim Vorgang.

## Abgeschlossene Vorgänge
Operativ archiviert. Mitarbeiterzugriff/Lesedauer admin-konfigurierbar.
Admin behält notwendigen Zugriff. Historische PDFs/Lexware-Rechnung bleiben trotzdem immutable.

## Löschen
Kein direkter irreversibler Business-Delete.
Papierkorb nur für wirklich löschbare Daten; Aufbewahrungspflicht hat Vorrang.

## Admin „alles“
Admin kann alles betrieblich Notwendige, aber nicht historische Wahrheit manipulieren:
keine signierten PDFs umschreiben, keine bereits übertragene Rechnung in Miet-Royal ändern.

## Demo „wie Original“
Fachfunktionen und UX identisch.
Training ist Metaebene um denselben Ablauf.
Keine Lexware-Simulation, kein echtes WhatsApp.

## Überfällige Rückgabe
Späterer Stand gilt: immer oben + rot + einmaliger Admin-Push.

## Rechte
Granular, Rollen nur Vorlagen, sofort wirksam.
Fachlich gesperrte Funktionen ggf. sichtbar; reine Admin-Infrastruktur verborgen.

## Kundenprofil
Verifizierte Profiländerungen gelten für Zukunft.
Aktive bestätigte Buchung behält Snapshot.

## Kaution
Normalerweise keine Kaution, aber Sonderfall-Modul vorhanden.
Anzahlung separat und rechnungswirksam.

## Rechnungsversand
Lexware verschickt Rechnung.
Miet-Royal verfolgt nur Rechnungs-/Zahlungsstatus, nicht Mailzustellung.

## Externe APIs
Lexware, Apple Kalender, WhatsApp und Routing technisch erst mit aktueller
offizieller Doku validieren; keine Schnittstelle erfinden.

## Touren und Routing (Phase 13)
GraphHopper Directions API ist der Produktionsprovider hinter
`RoutingGateway`; Provider schlägt vor, Mitarbeiter entscheidet.
Keine Lieferpreisformel; keine automatische Kundennachricht bei Verspätung;
keine Kunden-ETA; GPS nur während aktiver Tour ohne Historie.
Feste Stopppositionen rechnet Miet-Royal selbst (Matrix + eigener Planer),
weil der Provider sie nicht dokumentiert.

## Gesamt-Abnahme (Phase 18)
Veraltete Kundenformulare überschreiben zwischenzeitliche Änderungen nicht
still (Hinweis + Neuladen statt „letzter gewinnt“); Mitarbeitende dürfen
Kundendaten weiterhin bewusst ändern.
Schadensformulare sind idempotent (ein Schaden je Formular, online wie offline).
Backup/Restore: Datenbank, Storage und Umgebungs-Schlüssel gehören zusammen in
eine Sicherung; Restore immer in eine leere Datenbank mit Verifikation.
Kein generisches Fach-Audit-Log – Historie = Zeilenfelder, Jobs, Mails,
unveränderliche Dokumente, Security-Events.

## Pilot-Readiness (Phase 19)
Ein Live-Provider wird nie allein durch vorhandene Zugangsdaten aktiv – auch in
production braucht Lexware das ausdrückliche Opt-in (`LEXWARE_ENABLED=true`),
`false` ist der Kill-Switch.
Endgültig fehlgeschlagene Hintergrundjobs müssen für Operatoren ohne
Datenbankzugriff sichtbar sein (Einstellungen → System); niemand setzt Jobs
„auf erfolgreich“, die Wiederholung bleibt fachlich.
Web- und Staff-Server lauschen nur auf Loopback; der Reverse-Proxy ist der
einzige Zugang.
Zwei Umgebungen teilen nie dieselbe öffentliche Web-Basis.
Die Verwaltung gibt genau den Text frei, den der Kunde erhält: Vorschau und
Versand der Kundeninformation kommen aus derselben Mailvorlage; Kundentext wird
nie gekürzt (Vertragsgrenzen folgen den zulässigen Eingaben).
Kundenmails sprechen in natürlicher Reihenfolge an („Hallo Vorname Nachname,“
bzw. Organisationsname), nie im Listenformat der Staff-App.
Ein Operator erkennt ohne Datenbankzugriff, ob der Worker verarbeitet
(fällige Jobs warten nie länger als die Lease von 5 Minuten).
Jeder Proxy-Puffer vor einer API-Route ist mindestens so groß wie deren
Body-Limit plus Reserve (Web und Staff 13 MiB).
Go-live-Werkzeuge (`*:smoke`) laufen gegen dieselben Schutzmechanismen wie der
Betrieb (globale Drossel) und werden als Kindprozess getestet.
Ein echter Pilot mit realen Kunden beginnt erst nach Hosting-, Rechtstext-,
Buchhaltungs- und Pilotgruppen-Freigabe durch den Inhaber – Phase 19 weist die
technische Pilotfähigkeit nach, startet aber keinen Echtbetrieb.
