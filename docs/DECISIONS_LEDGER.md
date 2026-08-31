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
