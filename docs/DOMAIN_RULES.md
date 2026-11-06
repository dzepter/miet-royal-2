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

Präzisierung Phase 12 (transactional): „ab Versand“ = ab bestätigtem
Mailversand (SMTP angenommen). Freigabe allein startet keine Frist; ein
gescheiterter oder blockierter Versand startet sie nie.

Keine Kundenantwort: danach automatisch weiter, falls keine anderen Blocker.
Kundenantwort (auch normale Rückfrage): Auto-Lexware blockiert.
Phase 15: Eine Nachricht im Kundenportal wird NICHT automatisch als
„Kundenantwort“ der Abrechnungsklärung gewertet – Mitarbeitende sehen sie in der
Vorgangskommunikation und erfassen die Kundenantwort wie bisher selbst (offener
Fachpunkt, OPEN_ITEMS „Phase 15“).
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

Anwendung im Angebot (Phase 11):
- Eingabe nur durch Mitarbeitende im Angebots-ENTWURF (`offer.edit_draft`); kein
  öffentlicher Endpunkt, kein Portal.
- Genau EIN Gutschein je Angebot; nur der Code wird gesendet – Prozentsatz (20),
  Betrag, Besitzer, Status und Reservierung sind ausschließlich serverseitig.
- Ungültig/fremd/eingelöst/abgelaufen ⇒ immer dieselbe neutrale Antwort
  „Gutschein ist ungültig oder nicht verwendbar.“ (400).
- Nicht kombinierbar in beide Richtungen mit manuellem %-/EUR-Rabatt und einem
  Sonderpreis auf einer MASCHINEN-Position (auch 0 EUR). ERLAUBT bleiben der
  individuelle Lieferpreis sowie Sonderpreise auf Nicht-Maschinen-Positionen
  (Kaufartikel wie Mischkanister, zusätzliche Verbrauchs-/Kommissionsartikel) –
  sie ändern die Maschinenmiet-Zwischensumme nicht. Gemischt (Maschine +
  Nicht-Maschine) ⇒ blockiert; nur Nicht-Maschine ⇒ erlaubt. Ob ein Sonderpreis
  eine Maschine betrifft, entscheidet der Server anhand der berechneten Position
  (Art `machine`), nie anhand eines Client-Schlüssels. Meldung: „Gutschein kann
  nicht mit einem weiteren Rabatt oder Sonderpreis kombiniert werden.“
- 20 % der SUMME aller Maschinenmietpositionen, Integer-Cent, half-up; Lieferung,
  Kanister, Kommission, Inklusiv-Artikel, Nachbelastungen bleiben unberührt.
- Darstellung (Staff, öffentliches Angebot, PDF, AB): „Maschinenmiete regulär /
  Gutschein 20 % / Maschinenmiete nach Gutschein“, dann Gesamtsumme.
- Entwurf reserviert nicht. Versand reserviert atomar auf Angebotsebene; ein
  zweites Angebot kann mit demselben Gutschein nicht versendet werden (409).
  Angebotsgültigkeit = min(normale Gültigkeit, Gutschein-Ablauf).
- Neue Version im selben Angebot behält die Reservierung; wird der Gutschein
  unzulässig, wird er entfernt und freigegeben. Abgelehnt/abgelaufen ⇒ Reservierung
  entfällt (lazy, kein Cron). „Gutschein entfernen“ im Entwurf ohne Begründung.
- Die ANNAHME verbraucht den Gutschein (Redemption mit Restgültigkeit); der
  Buchungs-Snapshot ist unveränderlich (kein Klartextcode).
- Storno: 0 % ⇒ DERSELBE Gutschein wird reaktiviert, neues Ablaufdatum =
  Stornozeitpunkt + gespeicherte Restdauer (einmalig, replay-sicher);
  50/100 % ⇒ bleibt verbraucht. Stornobasis bleibt der reguläre Listenpreis VOR
  Gutschein (100 EUR + Gutschein + 50 % ⇒ 50 EUR). Folgevorgang setzt nichts ein.
- Abrechnung: Gutscheinrabatt exakt EINMAL als Rabattposition (Typ discount,
  Quelle booking_voucher, „20-%-Wiedermieter-Gutschein“), Lexware-Steuer wie
  Maschinenmiete.

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

Kundenstorno (Phase 15, Kundenportal): dieselbe Regel und derselbe Service
(`canceler_type = customer`, keine Staff-ID). Der Kunde sieht vorher
Eventdatum, verbleibende Tage, Prozentsatz, reguläre Maschinenmiet-Basis und
die exakte Gebühr und bestätigt bewusst („Buchung verbindlich stornieren“).
Online nur, solange der Phase-9-Service kein Blocker meldet (z. B. Übergabe
abgeschlossen) – sonst „Diese Buchung kann nicht mehr online storniert werden.
Bitte kontaktiere uns.“ Die Bestätigung ist an die gezeigte Gebühr gebunden
(Phase 15, Review R2): Der Kunde sendet die angezeigte Gebühr in Cent mit
(`expectedFeeCents`, nur Prüfwert); weicht die unter der Prozesssperre neu
berechnete Gebühr ab (z. B. über die Berliner Mitternacht), wird nichts
storniert, der Kunde sieht den neuen Betrag und bestätigt erneut. Die
Stornobestätigung geht bei Kundenstorno automatisch raus (Outbox, idempotent,
Backstop) – an die aktuelle Kundenadresse, ohne aktuelle Adresse an die
Snapshot-Adresse (Review R11); ein wiederholter Klick reiht nur nach, solange
die Bestätigung nie eingereiht wurde, nie nach `failed`/`blocked` (Review R5).
Mitarbeiter-Storno: Mail weiterhin bewusst über die Sendeaktion an die
Snapshot-Adresse.

## Kundenportal (Phase 15)
- „Aktuelle Buchung“ (einzige Regel, `CustomerPortalVisibilityPolicy`):
  - Hat die Buchung eine Stornozeile, entscheidet AUSSCHLIESSLICH sie – auch
    wenn der Vorgang danach wieder geöffnet wurde (Review R1; die stornierte
    Buchung wird nie wieder „Bestätigte Buchung“): kostenpflichtig sichtbar bis
    bezahlt; kostenfrei unsichtbar, außer der Bestätigungsansicht direkt nach
    einem KUNDENstorno (24 h, nur Detailansicht und Storno-Antwort; Review
    R12). Ein kostenfreier Mitarbeiter-Storno ist sofort unsichtbar.
  - Ohne Stornozeile: Vorgang open/reopened; oder abgeschlossen, solange
    finanziell offen (keine übertragene Abrechnung oder Zahlungsstatus
    offen/überfällig/unbekannt).
  - Bezahlte Buchungen erscheinen nie. Keine Buchungshistorie.
- Rechnungsstatus: abgeschlossen ohne (übertragene) Abrechnung ⇒ „Rechnung wird
  vorbereitet“ (Review R13); mit Stornozeile immer aus dem Storno. Wann die
  Sichtbarkeit eines abgeschlossenen Vorgangs ohne Abrechnung endet, ist
  fachlich offen (OPEN_ITEMS „Phase 15“).
- Buchungsansicht nur aus dem Snapshot; Profiländerungen gelten nur für
  zukünftige Anfragen.
- Portalnachrichten nur zu einer aktiven Buchung; nach Abschluss oder
  kostenpflichtigem Storno nur noch lesbar (Retention wie Phase 12); nach
  kostenfreiem Storno nicht mehr erreichbar.
- Mitarbeiter-Antwort im Kanal Portal nur bei offenem/wiedereröffnetem Vorgang
  mit Buchung OHNE Stornozeile, sonst abgelehnt (keine Nachricht, keine
  Hinweis-Mail; E-Mail-Antwort bleibt möglich). Ob nach kostenpflichtigem Storno
  und Reopen per Portal geantwortet werden darf, ist eine offene
  Fachentscheidung (bis dahin gesperrt).

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

## Touren (Phase 13 Final, entschieden)
Verspätungsrisiko genau dann, wenn die prognostizierte Ankunft nach der Frist liegt (exakter Termin: Terminzeit; Zeitfenster: Fensterende); kein Vorwarn-Puffer.
Je Stopp ein Incident; je neuem Incident genau ein Push je Empfänger (Dedupe), kein zweiter Push solange der Incident offen ist.
Verspätungsprognose nur mit Standortgenauigkeit ≤ 250 m (`DELAY_LOCATION_MAX_ACCURACY_METERS`); ungenauer Standort wird als letzter bekannter Standort gespeichert, erzeugt aber weder Risiko noch Entwarnung noch Push („Verspätungsprognose derzeit nicht verfügbar.“).
„Angekommen“ ist eine bewusste Mitarbeiteraktion ohne GPS-Näheprüfung.
Ein nicht erledigter Stopp darf durch `calendar.manage` bewusst aus einer aktiven Tour entfernt werden: Termin bleibt scheduled, Route wird stale; erledigte Stopps bleiben Historie und sind nicht entfernbar; keine Fachstornierung.
Offline: ein reiner Tourfahrer (`calendar.view`) erhält nur den read-only Snapshot seiner eigenen/effektiven aktiven Tour; alle Tour-Aktionen und GPS nur online.

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
