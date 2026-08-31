# MASTER_SPEC — Miet-Royal 2.0

## 1. Gesamtprodukt
Ein zusammenhängendes System:
- neue öffentliche Website
- Slush-Konfigurator
- Anfrage/Angebot
- optionaler Kundenbereich
- Mitarbeiter-PWA
- Lager-Tablet
- Maschinen-/Lagerverwaltung
- Kalender/Touren
- Ausgabe/Rückgabe/Schäden
- Endabrechnung
- Lexware
- E-Mail/WhatsApp/Push/Kalender
- Demo/Training
- Offline
- CMS/SEO

## 2. Kernprinzipien
- so einfach und übersichtlich wie möglich
- nur Funktionen mit betrieblichem Nutzen
- Automatik im Hintergrund
- Mensch entscheidet bei betrieblichen Ausnahmen
- Admin kann Rechte und sinnvolle Parameter flexibel pflegen
- historische Daten bleiben unverändert
- modular updatefähig

## 3. Vorgang
Jede Anfrage erzeugt genau einen zentralen Vorgang.
Nummer: `MR-YYYY-NNNN`, Sequenz läuft über Jahresgrenzen weiter.

Ablauf:
Anfrage → Prüfung → Angebot → Annahme → AB-Freigabe →
bestätigte Buchung → Vorbereitung → Ausgabe/Lieferung → Rückgabe →
Reinigung → Abrechnung → Lexware → abgeschlossen.

## 4. Slush-Produkte
Mietpreise:
- 1×8 L = 60 €
- 2×8 L = 100 €
- 1×10 L = 75 €
- 2×10 L = 120 €

Initialer interner Bestand:
- 1×8 L: 2
- 2×8 L: 1
- 1×10 L: 6
- 2×10 L: 2

Physische Bestände niemals öffentlich anzeigen.

## 5. Sirup / Zubehör
Gratis-Sirup: 1 L je gebuchtem Maschinenbehälter.
Sorten: Wassermelone, Kirsche, Waldmeister, Blaue Himbeere.
Zuckerfrei, aus Deutschland. 1 L Sirup ≈ 6 L Slush.

Pro Mietvorgang gratis:
- 25 Becher
- 25 Strohhalme

Zusätzlich auf Kommission:
- Sirup 1 L = 12 €
- Becher 25 = 2,50 €
- Strohhalme 25 = 2,00 €
Geöffnet = voll berechnet, nur ungeöffnet rückgabefähig.

6-L-Mischkanister:
- 5 €
- Verkauf
- max. 2 je Maschinenbehälter
- aktiv empfehlen

## 6. Konfigurator
Geführter mobiler Ablauf:
1. Event: Datum, Start, Ende, Gästezahl, Anlass
2. Maschinenempfehlung + freie Wahl
3. Sirup/Zubehör
4. Selbstabholung oder Lieferanfrage
5. Kontaktdaten
6. Zusammenfassung → unverbindliches Angebot anfordern

Standardportion als Orientierung: 0,2 L.
Keine starre „Portionen pro Tag“-Kapazität behaupten.
Ab 250 Gästen: Großevent-Hinweis, normaler Prozess darf weitergehen.

## 7. Verfügbarkeit
Keine automatische harte Kundenablehnung.
Interne Konflikte erkennen und Alternativen vorschlagen; Mitarbeiter entscheidet.
Beispiele: Upgrade, zwei Einzelgeräte statt Doppelgerät, Zeitverschiebung.

## 8. Abholung / Lieferung
Selbstabholung öffentlich nur „Mainz-Hechtsheim“.
Exakte Adresse erst nach bestätigter Buchung.
Wochenenddefault: Freitag 18:00 / Sonntag 11:00, änderbar.

Lieferung = individuelle Angebotsprüfung.
Kunde gibt Adresse und Zeitfenster.
System ermittelt intern Route/Distanz/Fahrzeit/Preisvorschlag, Mitarbeiter entscheidet Endpreis.

## 9. Angebot
Status:
Entwurf, Versendet, Angenommen, Abgelehnt, Abgelaufen, Erneute Prüfung angefragt.

Gültigkeit:
- Event <=14 Tage: 3 Tage
- Event >14 Tage: 7 Tage

Versendete Versionen immutable; Änderung erzeugt neue Version.
Kunde erhält Online-Link + PDF.
Annahme per Button „Angebot verbindlich annehmen“, ohne Unterschrift.

## 10. AB / Preisfreeze
Nach Annahme AB automatisch vorbereiten, Mitarbeiter freigibt Versand.
Bestätigte Kundendaten und Preise als Snapshot einfrieren.
Spätere Zusatzkosten als separate Positionen, nicht alte Positionen überschreiben.

## 11. Maschinen
IDs: `MR-[Liter]-[Behälter]-[Laufnummer]`.
Status:
Einsatzbereit, Vermietet, Reserviert, Reinigung, Reparatur, Außer Betrieb.

Konkrete Maschine erst Vorbereitung/Ausgabe zuordnen.
Bei identischen geeigneten Maschinen älteste nach Kaufdatum als bevorzugt markieren.
Manuelle Sperren haben Zeitraum + Pflichtgrund.
Override einer Sperre nur mit Recht + Grund + Bestätigung; namentlich protokollieren.

## 12. Ausgabe
Workflow:
Vorgang → QR/Maschine → Zustand → Pflicht-Gesamtfoto →
bestehende Schäden → tatsächliche Abholperson → Kundenunterschrift →
Mitarbeiterunterschrift → Abschluss.

Ohne erforderliche Signaturen kein Abschluss.
Bei mehreren Maschinen: ein kombiniertes Protokoll, je Maschine eigener Abschnitt.

Alternative Abholperson bis 1h vor Abholung:
Vorname, Nachname, Telefon. Telefon nach Abschluss löschen, Name bleibt.

## 13. Rückgabe
Workflow:
Vorgang/Maschine → Rückgabeperson → Vorbereitung → Zubehör →
Kommission → Schäden/Fehlteile → Zusammenfassung → Signaturen → Abschluss.

Tatsächliche Rückgabezeit bei Abschluss automatisch speichern; berechtigt korrigierbar.
Rückgabe nur mit anwesender Rückgabeperson.

Prüfung je Maschine:
- entleert
- zweimal gespült
- nichts demontiert

Bei klar mangelhaft: 75 € je betroffener Maschine + mindestens 1 Foto.
Kleine unvermeidbare Reste = keine Gebühr.

Nach Rückgabe immer `Reinigung`.
Nach „gereinigt & einsatzbereit“ → Einsatzbereit.
Nach 24h Reinigung: deutliche interne Warnung, kein Push.

## 14. Zubehör / Fehlteile
Rückgabecheck:
- 1 Behälter: 1 Deckel + 1 Tropfschale
- 2 Behälter: 2 + 2

Nur bei Rückgabe Pflichtcheck.
Fehlteil wird bewusst durch Mitarbeiter angelegt, kein Pflichtfoto.
Physische Rückgabe darf abgeschlossen werden; offenes Fehlteil kann separat nachverfolgt werden.
Fehlteil-Wiedervorlage ohne festes Fälligkeitsdatum.

## 15. Schäden
Car-Rental-artige Dokumentation:
- Maschinen-Skizze
- eine oder mehrere Markierungen
- leicht/mittel/schwer
- Pflichttext
- mind. 1 Foto

Dokumentation und Geldforderung getrennt.
Aktuelle Schäden erscheinen bei nächster Ausgabe als bestehend.
Historische signierte PDFs bleiben unverändert.

## 16. Abrechnung
Finale Abrechnung aus:
Mietpreis + verbrauchte Kommission + Kaufartikel + Lieferung +
Rabatte + Reinigung + freigegebene Schaden-/Fehlteilkosten +
Verspätungsgebühr + manuelle Nachbelastung − Anzahlungen.

Bei offenen Kosten: „Abrechnung wartet auf Klärung“.

### Schaden-/Fehlteil-Vorabmail
Bei monetären Schaden-/Fehlteilpositionen:
- eine gemeinsame Mail vorbereiten
- Versand erst nach Mitarbeiterfreigabe
- Einzelpositionen + Gesamtsumme
- Link zum Rückgabeprotokoll
- keine separaten Schadensfoto-Anhänge
- interne 24h-Frist, ohne Countdown/Fristerklärung an Kunde

Keine Kundenantwort: nach Ablauf automatisch weiter, wenn sonst frei.
Kundenantwort: Auto-Transfer blockieren, Mitarbeiter entscheidet:
- wie berechnet freigeben → automatisch Lexware
- Betrag ändern → danach manueller Lexware-Klick
- Position entfernen → bei keinen Blockern automatisch weiter

## 17. Lexware
Miet-Royal operativ; Lexware Rechnung/Buchhaltung/Mahnwesen.
Ohne offene Punkte nach Rückgabe automatisch übertragen.
Lexware erstellt und versendet Rechnung.

Zurück mindestens:
- Offen
- Bezahlt
- Überfällig

Rechnungsnummer nur Admin.
Rechnungs-PDF bleibt Lexware.
Nach Transfer ist Abrechnung in Miet-Royal gesperrt.

Bei Ausfall:
- „Lexware-Übertragung ausstehend“
- automatischer Retry
- bei wiederholtem Transferfehler Admin informieren
- keine zusätzliche Zustellverfolgung der Lexware-Rechnungsmail in Miet-Royal

## 18. Gutschein
Nach schadenfreier Rückgabe UND Lexware=Bezahlt:
automatisch 20%-Gutschein.
- nur Maschinenmiete
- einmalig
- 12 Monate
- personenbezogen
- nicht übertragbar
- nicht kombinierbar
- nicht auf Lieferung/Consumables

## 19. Rabatte
Berechtigte Mitarbeitende: % oder €.
>10 %: interner Grund.
>20 %: Adminfreigabe.
Sonderpreis als eigenes Recht.
Nach Angebotsannahme Preisfreeze.

## 20. Storno
Kundenbereich erlaubt Storno.
Gebühr:
- >=15 Tage: 0 %
- 7–14 Tage: 50 %
- 0–6 Tage: 100 %

Basis: regulärer Listenpreis Maschinenmiete vor Rabatt/Gutschein.
Nicht Basis: Lieferung, Kanister, Kommission.

Kundenstorno zeigt Betrag vor Bestätigung.
Kostenpflichtig → Stornorechnung Lexware.
Kostenfrei → keine Rechnung.
Storno gibt Kalender/Belegung sofort frei.

Kunden-Selbststorno: automatische Bestätigungsmail.
Mitarbeiter-Storno: Kundenmail optional beim Vorgang.
Wer stornieren darf: granulare Berechtigung.

## 21. Verlängerung / frühe Rückgabe
Frühe Rückgabe reduziert Mietpreis nicht automatisch.
Verlängerung bei betrieblicher Möglichkeit durch berechtigte Person direkt möglich, mit Konfliktprüfung/Mehrpreis.

## 22. Anzahlung / Kaution
Anzahlung: Betrag auf spätere Rechnung anrechnen.
Kaution: separate Sicherheit, normal nicht routinemäßig; Betrag, erhalten,
zurückgezahlt, teilweise/voll einbehalten, Einbehaltbetrag + Grund.

## 23. Kalender / Heute
Tag/Woche/Monat.
Überfällige Rückgaben immer ganz oben, deutlich rot.
Einmaliger Admin-Push bei Überfälligkeit.
Zugewiesene operative Termine: 1h vorher Push an zuständige Person.
Bei wenig Tagesinhalt wenige nächste Termine der Folgetage anzeigen.

## 24. Vertretung
Admin trägt Vertreter + Zeitraum ein.
Währenddessen neue relevante Aufgaben/Pushs an Vertretung.
Nach Ende offene Zuständigkeiten zurück zum Ursprung.
Vorzeitig beendbar.

## 25. Touren
Route kann Lieferung, Abholung, Rückgabe kombinieren.
Zeitfenster, 15min Standardpuffer, fixe Stopps.
Tour manuell starten/beenden.
GPS nur während aktiver Tour.
Warnung bei drohendem Verpassen, keine automatische Kundennachricht.
Kunde sieht „Unterwegs“, kein Live-GPS/ETA.

## 26. Kundenbereich
Optionales Konto.
Ohne aktive Buchung: „Neue Anfrage starten“.
Aktiv: Maschine, Extras, Event, Zeiten, Abholung/Lieferung, Preis,
Dokumente, Nachricht, Rechnungsstatus, Storno, Call-Button.

Exakte Abholadresse nach Bestätigung + Navigation.
Kein WhatsApp-Button im Portal.
Keine alte Buchungshistorie.

Magic Link 15min, Gerätesession 30 Tage.
Profiländerungen verifizieren; laufende Buchung behält Snapshot.

## 27. Kommunikation
Kundenchat nach Annahme: Text + Fotos, keine beliebigen Dateien.
Neue Kundenmessage → Admin + zuständig.
Mitarbeiterantwort → Kunde bekommt E-Mail-Hinweis.
E-Mail-Antwort möglichst dem Vorgang zuordnen.

Chattext 12 Monate nach Abschluss, Chatfotos bei Abschluss löschen.
Signatur ausgehender Mails:
„Mit freundlichen Grüßen
Miet-Royal Mainz“

## 28. Lager
Sirup je Sorte, Becher, Strohhalme, Kanister, zukünftige Artikel.
Mindestbestand pro Artikel.
Warnung bis Bestand wieder darüber.
Wareneingang = hinzugekommene Menge.
Inventur komplett oder Einzelartikel; Differenz braucht Adminfreigabe.
Preise und geplante künftige Preise adminänderbar.
Artikel deaktivieren statt löschen.

## 29. Demo / Training
Eigene Datenbank/Umgebung, niemals mit Live mischen.
Gleiche Fachfunktionen/UX wie Live.
Testkunden/-maschinen/-lager/-vorgänge.
Admin Reset.
Mail nur Whitelist + `[DEMO]`.
WhatsApp simuliert.
Keine Lexware-Simulation/echte Übertragung.
Trainings-Metaebene: Pflichtübungen, Trainingspfade, Fortschritt/Fehler für Admin,
optionale Trainingssperren, Admin-Override.
Nach Updates bestehende Trainingsstände nicht automatisch zurücksetzen.

## 30. Website / SEO
Website komplett neu, Slush primär, Popcorn/Waffel sekundär.
Deutsch, „du“, hochwertig und individuell, kein generischer SaaS/AI-Look.
CMS: Texte, Preise, Bilder, FAQ, Produkte, SEO, regionale Seiten, Vorschau→Publish.
Echte Google-Bewertungen, Instagram-Link ohne eingebetteten Feed.

SEO-Fokus:
Mainz, Wiesbaden, Bad Kreuznach + sinnvolles Umland
(Ingelheim, Bingen, Rüsselsheim, Alzey, Nieder-Olm, Oppenheim, Wörrstadt,
Hochheim, Taunusstein, Rheinhessen, Rhein-Main).
Keine dünnen Duplikat-Ortsseiten.

## 31. PWA / Offline
Staff auf Handy, Tablet, Desktop.
Warehouse-Login nur Ausgabe/Rückgabe/QR/Reinigung.
Offline-Horizont 3 Tage:
QR, Ausgabe, Rückgabe, Schäden, Fotos, Signaturen, Kommission, wichtige Dokumente.
Lokale Daten verschlüsselt, nach Sync löschen.
Konflikte nie blind überschreiben.

## 32. Updates
Staging, versionierte Migrationen, Backups, Rollback.
Bestehende Daten/Einstellungen erhalten.
Neue Regeln wirken nicht rückwirkend auf historische Snapshots.
