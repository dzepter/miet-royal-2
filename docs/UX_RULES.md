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

