# DOMAIN_RULES — Verbindliche Geschäftsregeln

## Angebot
- Event <=14 Tage entfernt → 3 Tage Angebotsgültigkeit.
- Event >14 Tage entfernt → 7 Tage.
- Versendetes Angebot niemals überschreiben; neue Version.
- Abgelaufenes Angebot nicht annehmbar; erneute Prüfung möglich.

## Preise
- 1×8 L 60 €
- 2×8 L 100 €
- 1×10 L 75 €
- 2×10 L 120 €
- Preisänderungen gelten nur für neue Preisermittlungen.
- bestätigte/versendete Positionen behalten Snapshot.

## Inklusiv / Kommission
- 1 L Gratis-Sirup pro Maschinenbehälter.
- 25 Becher + 25 Strohhalme pro Mietvorgang gratis.
- Sirup 12 €/L; Becher 2,50 €/25; Strohhalme 2 €/25.
- nur ungeöffnet zurückrechenbar.
- Kanister 6 L = 5 €, Kaufartikel, max. 2 je Behälter.

## Rabatt
- >10 % manueller Rabatt → Grund Pflicht.
- >20 % → Adminfreigabe.
- Gutschein nicht mit anderem Rabatt kombinieren.
- angenommene Preise nicht rückwirkend ändern.

## Verfügbarkeit
- automatische Prüfung darf Kundenanfrage nie hart ablehnen.
- Mitarbeiter entscheidet bei Konflikt.
- konkrete Maschine erst später zuordnen.

## Maschinen
- älteste geeignete Maschine als bevorzugt markieren.
- Sperr-Override: Recht + Warnung + Pflichtgrund + Bestätigung + Nutzer protokollieren.
- Sperre/Schaden mit Folgebuchung: Admin-Push, nach 6h einmalige Erinnerung wenn offen.

## Rückgabevorbereitung
Je Maschine:
- entleert?
- zweimal gespült?
- nichts demontiert?
Bei klar mangelhaft: 75 € + mindestens 1 Foto.
Unvermeidbarer kleiner Rest allein löst keine Gebühr aus.

## Zubehör
1 Behälter → 1 Deckel + 1 Tropfschale.
2 Behälter → 2 + 2.
Nur Rückgabecheck.
Fehlteil nicht allein durch Abweichung automatisch anlegen; Mitarbeiter bestätigt.

## Schäden
Neuer Schaden benötigt:
- mind. 1 Marker
- leicht/mittel/schwer
- Text
- mind. 1 Foto
Schaden dokumentieren und finanziell abrechnen sind getrennt.

## Physische Rückgabe vs. Abrechnung
Rückgabe darf abgeschlossen werden trotz offenem Schaden/Fehlteil.
Settlement bleibt ggf. „Klärung erforderlich“.

## Schaden-/Fehlteil-Vorinformation
Bei monetären Positionen:
1. eine gemeinsame Mail vorbereiten
2. Mitarbeiterfreigabe zum Versand
3. ab Versand eine 24h-Frist pro Vorgang
4. spätere zusätzliche Position startet Frist nicht neu
5. keine explizite Fristerklärung/Countdown

Keine Kundenantwort: danach automatisch weiter, falls keine anderen Blocker.
Kundenantwort (auch normale Rückfrage): Auto-Lexware blockiert.
Mitarbeiter:
- wie berechnet freigeben → Auto-Lexware
- Betrag ändern → danach manueller Lexware-Klick
- Position entfernen → wenn sonst frei automatisch weiter

Vorzeitiges Ende 24h:
- Abrechnungsrecht
- Sicherheitsdialog
- anschließend bewusster manueller Lexware-Klick

## Lexware
Normale abgeschlossene Rückgabe ohne offene Punkte → Auto-Transfer.
Nach erfolgreichem Transfer Settlement immutable.
Transferausfall → „Lexware-Übertragung ausstehend“ + Retry.
Wiederholter Transferfehler → Admin informieren.

## Gutschein
Nur wenn:
- Rückgabe schadenfrei
- Lexware=Bezahlt
- noch kein Gutschein für Vorgang
20 %, Maschinenmiete, 12 Monate, einmalig, personenbezogen, nicht kombinierbar.

## Storno
- >=15 Tage → 0 %
- 7–14 Tage → 50 %
- 0–6 Tage → 100 %
Basis: regulärer Listen-Maschinenpreis.
Nicht Basis: Lieferung, Kanister, Kommission.
Kostenpflichtig → Lexware-Stornorechnung.
Storno entfernt operative Termine sofort und gibt Belegung frei.

Gutschein:
- 0 % Storno → reaktivieren, Restgültigkeit bleibt
- 50/100 % → bleibt verbraucht

## Frühere Rückgabe
Keine automatische Mietpreisminderung.

## Verlängerung
Bei betrieblicher Möglichkeit + Recht direkt verlängerbar; Konflikte und Mehrpreis neu prüfen.

## Anzahlung
Auf spätere Rechnung anrechnen.

## Kaution
Separate Sicherheit, nicht Anzahlung:
Betrag, erhalten, zurückgezahlt, Teil-/Voll-Einbehalt, Einbehaltgrund.

## Überfällige Rückgabe
- immer oben auf Heute
- rot
- genau ein Admin-Push
- keine Push-Spam-Schleife
- Verspätungsgebühr niemals automatisch; berechtigte Person entscheidet

## Termine
Zugewiesener operativer Termin → 1h vorher Push an aktuelle Zuständigkeit/Vertretung.

## Vertretung
Während Zeitraum neue Aufgaben/Pushs zur Vertretung.
Nach Ende offene Aufgaben zurück an Ursprung.
Vorzeitiges Ende sofort.

## Reinigung
Nach Rückgabe immer Reinigung.
„Gereinigt & einsatzbereit“ → Einsatzbereit.
>24h Reinigung → interne rote Warnung, kein Push.

## Offline
Server ist Autorität.
Neuere konkurrierende Onlineänderung niemals still mit Offlineversion überschreiben.

## Archiv / Löschen
Geschäftsvorgänge archivieren.
Papierkorb nur für wirklich löschbare Daten, Admin-only, Standard 30 Tage.
Aufbewahrungspflicht schlägt Löschwunsch.
