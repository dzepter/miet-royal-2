# UX_RULES — Bedienlogik

## Leitbild
Intern leistungsfähig, sichtbar einfach.

## Staff-Hauptnavigation
1. Heute
2. Vorgänge
3. Kalender
4. Maschinen & Lager
5. Mehr

Suche über Icon.
Mobile: Bottom Navigation.
Tablet/Desktop: Sidebar.

## Heute
Reihenfolge:
1. überfällige Rückgaben immer oben
2. heutige Termine
3. dringende Vorgänge/Wiedervorlagen
4. Maschinen-/Lagerwarnungen
5. bei wenig Inhalt wenige nächste Termine

Keine Umsatz-/BI-Spielereien.

## Vorgangsdetail
Oben: Kunde, Event, Maschine, Zeit, Status.
Prominent: **Nächste Aktion**.
Sektionen einklappbar; Seltenes unter „Mehr“.

## Technische Zustände
Nie rohe Enums/Fehlercodes anzeigen.
Verständliche deutsche Zustände.

## Geführte Workflows
Ausgabe/Rückgabe als Schritte mit nur relevanten Feldern.
Eine dominante Hauptaktion.
Zurück ohne Datenverlust.

## Schnellpfad
Bei sauberer Rückgabe keine 20 „Nein“-Fragen.
„Rückgabe ohne Beanstandung“ + nur bei Auffälligkeit Zusatzfelder.

## Warnungen
Nur bei echtem Handlungsbedarf.
Farbe immer mit Icon/Text kombinieren.

## Dialoge
Nur bei kritischen Aktionen:
Storno, Löschen, Live↔Demo, Sperr-Override, weitreichende Rechte,
manuelle Lexware-Übertragung.

## Hilfen
Kurzer Feldhinweis oder Hilfe-Icon bei Bedarf, keine langen Anleitungen.

## Sprache
Deutsch, Kundenansprache „du“.
Begriffe überall gleich.

## Warehouse
Nur vier große Bereiche:
Ausgabe, Rückgabe, QR scannen, Reinigung.

## Offline
Klarer Banner:
„Offline – X Änderungen warten auf Synchronisierung“.
Konflikt: Werte gegenüberstellen („Offline erfasst / Serverstand /
Was jetzt zu tun ist“), Nutzer entscheidet.
Offline-Suche nur im geladenen Arbeitspaket, mit sichtbarem Hinweis.
Abmelden mit nicht synchronisierten Erfassungen: zweistufige Rückfrage,
„Zuerst synchronisieren (empfohlen)“ als Hauptaktion – nie stiller Verlust.
Online-Aktionen (z. B. Kundennachricht senden, Mail erneut senden – Phase 12)
sind offline deaktiviert und zeigen „Diese Aktion ist offline nicht verfügbar –
bitte mit Verbindung erneut versuchen.“

## Suche
Teiltreffer/Tippfehler, Suche nach MR-Nummer, Kunde, Telefon,
E-Mail, Maschine, Eventdatum.
Beste Treffer zuerst, nach Typ gruppiert.
Keine Suchhistorie.

## Kundenbereich
Minimal: aktuelle Buchung, Termine, Preis, Docs, Nachricht, Rechnung,
Storno, Anruf.
Keine komplette Historie.

## Website
Emotionaler als Staff, aber gleiche Marke.
Primärer CTA: Angebot anfordern / Slush konfigurieren.
Konfigurator mobile-first, kurze Schritte, laufende Preisübersicht.

## Responsive / Accessibility
- Smartphone, Tablet, Desktop direkt
- große Touchflächen
- Labels
- sichtbarer Fokus
- ausreichender Kontrast
- Systemschriftgröße respektieren
- Fehlermeldung erklärt nächsten Schritt

## Performance
Keine unnötigen Animationen, Social Feeds oder riesigen Dependencies.

## Demo-Umgebung (Phase 14)
Kennzeichnung: In der Demo zeigt die Staff-App dauerhaft das Badge
„DEMO – keine echten Kundendaten“ (kompakt „DEMO“, Text + Rahmen, nie nur
Farbe) im Header, im Sperrbildschirm und auf den Seiten ohne Anmeldung;
Dokumenttitel mit Präfix „DEMO · “. Öffentliche Demo-Seiten (Web) tragen den
festen Banner „DEMO – keine echten Kundendaten“ auf allen Seiten.
Wechsel Live↔Demo: nur mit konfigurierter fester URL („Demo öffnen“ /
„Live öffnen“), Dialog vor dem Wechsel: „Du wechselst zur {Demo|Live}-Umgebung.
Es wird nichts übertragen – keine Anmeldung, kein Vorgang, keine Daten. Du
musst dich dort separat anmelden.“ Öffnet die Anmeldeseite der Gegen-Umgebung
in einem neuen Tab; keine automatische Weiterleitung, keine editierbare URL.
Reset: „Demo-Geschäftsdaten zurücksetzen“ (Einstellungen → Demo) ist eine
destruktive Aktion mit Dialog nach bestehendem Muster: Pflicht-Texteingabe
„DEMO ZURÜCKSETZEN“, Bestätigen erst bei exaktem Text aktiv, während des Laufs
gesperrt, kein Browser-confirm(). Während eines Resets zeigen blockierte
Aktionen „Die Demo-Umgebung wird gerade zurückgesetzt. Bitte in einer Minute
erneut versuchen.“ (keine Abmeldung). Veralteter Datenstand: dezenter Hinweis
„Demo-Datenstand ist veraltet – Zurücksetzen empfohlen.“ nur für Admins mit
`demo.manage`; nie ein automatischer Reset.
Abrechnung in der Demo (W1, MASTER_SPEC §29): Die Abrechnung ist bis zum
Status „Bereit zur Buchhaltung“ vollständig bedienbar; danach zeigt die
Abrechnungsseite, die Vorgangsseite und die Storno-Karte den neutralen
Hinweis „Buchhaltungsübertragung ist in der Demo nicht verfügbar.“ (gedämpft,
`data-testid="settlement-demo-unavailable"` bzw.
`cancellation-demo-unavailable`) – KEIN Fehler-Styling, keine Warnung, kein
Handlungsbedarf. Es gibt keinen Button „Jetzt an Buchhaltung übertragen“,
keine Mock-/Teststeuerungskarte und kein MOCK-Badge; das Buchhaltungs-Badge
lautet „Nicht verfügbar (Demo)“. Nie ein simulierter Erfolg („übertragen“,
Rechnungsnummer, bezahlt).
Reset und Offline (Phase 14 RESET, Order §92): Wurde die Demo zurückgesetzt,
während ein Gerät offline erfasst hat, zeigen alle Offline-Bereiche den Banner
(`data-testid="dataset-changed-banner"`, Button „Prüfen“ ⇒ /sync) und die
Sync-Seite den Dialog nach bestehendem Muster (`dataset-changed-dialog`):
„Die Demo-Daten wurden zurückgesetzt. {n} nicht synchronisierte Erfassungen
gehören zum alten Datenstand und können nicht mehr übernommen werden.“
Hauptaktion „Alten Stand verwerfen und neues Arbeitspaket laden“
(`dataset-changed-confirm`, nur online), Nebenaktion „Später“
(`dataset-changed-later`) lässt alles stehen – bis zur Bestätigung wird nicht
synchronisiert, nichts wird automatisch verworfen. Ohne offene Erfassungen
übernimmt die App ein neues Paket still (alter Stand wird ersetzt). In
Production/Development gibt es keine Epoch und damit weder Banner noch Dialog.
Alte Dateien nach dem Reset: Einstellungen → Demo zeigt neutral „Bereinigung
alter Demo-Dateien ausstehend (n)“ bzw. als Fehler „Bereinigung alter
Demo-Dateien fehlgeschlagen – technischer Fehler, Logs prüfen“
(`data-testid="demo-storage-cleanup"`); der Datensatz selbst ist konsistent.
Dokumente (Order §89): In der Demo tragen Angebot, Auftragsbestätigung,
Lieferschein, Übergabe- und Rückgabeprotokoll unter dem Kopf die fette,
umrahmte Zeile „DEMO – keine echten Kundendaten“ (auf jeder Seite) und den
Titelpräfix „DEMO · “ (PDF-Metadaten/Browser-Tab); in allen anderen
Umgebungen sind die Dokumente unverändert.

## Training (Phase 14)
Navigation: Eintrag „Training“ (`/training`) für alle angemeldeten
Mitarbeitenden, online und offline; offline zeigt die Seite nur „Training ist
offline nicht verfügbar.“ Die Verwaltung liegt getrennt unter Einstellungen →
„Training“ (nur `training.manage`; Admin-Infrastruktur, für normale
Mitarbeitende unsichtbar).
Demo (`/training`): zugewiesene Pfade mit Pflichtübungen, Zustand als Text
„erledigt / offen / läuft“ (Badge nie nur Farbe), laufender Versuch mit
Schrittliste und offenem Schritt, genau eine Hauptaktion je Übung („Übung
starten“ bzw. „Übung prüfen“), daneben der Link „Zum Demo-Bereich“ (sicherer
Katalogpfad oder aufgelöstes Seed-Szenario). Ergebnis-Hinweise: „Übung
bestanden.“ / „Noch nicht vollständig – offener Schritt: ‚…‘.“ Fehlendes
Fachrecht: „Für diese Übung fehlt dir aktuell die erforderliche Berechtigung.“
Unterbrochener Versuch: „Dein Versuch wurde durch das Zurücksetzen der
Demo-Daten unterbrochen – du kannst neu starten.“ bzw. „… durch einen
Training-Reset …“. Nicht zugewiesene Katalogübungen stehen unter „Weitere
Übungen“ frei zur Verfügung. Keine Noten, keine Rangliste, keine rohen Codes.
Live/Staging/Development (`/training`): nur der Hinweis „Übungen werden in der
Demo-Umgebung absolviert.“ und die Tabelle der eigenen Live-Sperren (Funktion /
erforderliches Training / Status „freigegeben (Demo bestätigt)“, „freigegeben
(Override bis …)“, „offen“).
Gesperrte Live-Funktion: Die Aktion bleibt sichtbar; beim Ausführen erscheint
im bestehenden Fehlerbereich der Servertext „Für diese Funktion ist zuerst das
Training ‚…‘ erforderlich.“ (nie eine rohe 403-Meldung). Offline erfasste
Aktionen zeigen denselben Text in „Synchronisierung prüfen“ unter Serverstand;
ohne Servertext „Für diese Funktion ist zuerst ein Training erforderlich.“
Admin-Dialoge: „Training zurücksetzen“ (Demo) und „Freigabe widerrufen“ (Live)
laufen über den bestehenden Bestätigungsdialog („Abbrechen“ ändert nichts);
der Reset-Dialog nennt Umfang (gesamter Mitarbeiter / Pfad / einzelne Übung)
und den Hinweis „Historische Versuche bleiben erhalten; eine neue Runde
beginnt.“ Ein Override verlangt eine Begründung im Formular („Für einen
Override ist eine Begründung erforderlich.“), optional „Gültig bis“. „Demo-
Training bestätigen“ hat kein Datum (Phase 14 Final §7: „Eine bestätigte
Demo-Übung ist unbefristet – sie gilt bis zu einem bewussten Widerruf.“).
Deaktivierte Mitarbeitende stehen in den Auswahllisten (Zuweisung, Reset,
Freigabe, Override) nicht zur Wahl; in Übersicht und Freigabeliste erscheint
ihre Historie mit dem Badge „deaktiviert“; der Servertext „Der Mitarbeiter ist
deaktiviert.“ erscheint im jeweiligen Formular-Fehlerbereich (Phase 14 Final §9).
Admin-Detailansichten zeigen zu Versuchen nur Zeitpunkt, Übung, Schritt und
den Hinweis „Schritt nicht abgeschlossen“ – nie Geschäftsdaten.

