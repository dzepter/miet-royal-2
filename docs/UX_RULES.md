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

Umsetzung Phase 15 (`/konto`, Details docs/CUSTOMER_PORTAL.md):
- Ansprache „du“, Deutsch, mobile-first; eine Hauptaktion je Bildschirm.
- Anmeldung nur per Magic Link; Antwort auf jede Anforderung identisch:
  „Wenn die E-Mail-Adresse bei uns hinterlegt ist, erhältst du gleich einen
  Anmeldelink.“ Der Link öffnet eine Seite mit dem Button „Kundenbereich öffnen“
  (kein automatischer Login per Aufruf).
- 0 aktuelle Buchungen ⇒ Hauptaktion „Neue Anfrage starten“ (feste URL aus
  `PORTAL_NEW_INQUIRY_URL`, sonst Hinweis + Anrufen); 1 ⇒ direkt die Buchung;
  mehrere ⇒ Liste „Aktuelle Buchungen“.
- Statuslabels: „Bestätigte Buchung“, „Abgeschlossen – Rechnung offen“,
  „Storniert“, „Storniert – Stornogebühr“; Rechnung „Offen“ / „Bezahlt“ /
  „Überfällig“ / „Rechnung wird vorbereitet“. Status nie nur über Farbe.
- Termine: exakte Zeit, Zeitfenster („10:00–12:00 Uhr“) oder „Zeit wird noch
  festgelegt“. „Unterwegs“ nur als Wort – keine Karte, kein ETA, kein Fahrer.
- Storno nur über einen eigenen Dialog (kein Browser-`confirm()`) mit
  „Stornogebühr: X,XX €“ und „Buchung verbindlich stornieren“; blockiert ⇒
  „Diese Buchung kann nicht mehr online storniert werden. Bitte kontaktiere
  uns.“ + Anrufen.
- Profil: Hinweis „Änderungen gelten für zukünftige Anfragen. Deine bereits
  bestätigte Buchung bleibt unverändert.“; Änderungen verlangen eine Bestätigung
  per Link („Änderung bestätigen“). Nach E-Mail-Wechsel: „E-Mail-Adresse
  geändert. Bitte melde dich mit deiner neuen Adresse erneut an.“
- Kein WhatsApp-Button, kein Online-Payment, keine rohen Codes in Fehlermeldungen
  (429 ⇒ „Zu viele Versuche. Bitte warte einen Moment.“).

## Website
Emotionaler als Staff, aber gleiche Marke.
Primärer CTA: Angebot anfordern / Slush konfigurieren.
Konfigurator mobile-first, kurze Schritte, laufende Preisübersicht.

Umsetzung Phase 16 (`apps/web`, Details docs/WEBSITE_CMS.md und
docs/WEBSITE_CONFIGURATOR.md):
- Wirkung: individueller Event-/Vermietungsbetrieb – warm, hochwertig, direkt,
  persönlich. Deutsch, Ansprache konsequent „du“. Kein generischer SaaS-/AI-Look:
  keine Fake-Statistik-Zähler, kein Glassmorphism, keine großen Verläufe, keine
  Emoji-Wände, keine Reihen gleichartiger Karten, keine Stock-/AI-/Fremdbilder.
  Fehlt ein gesichertes eigenes Bild, bleibt die Sektion ohne Bild.
- Farben aus dem bisherigen Auftritt (Tokens unter `.site`): Creme `#FFFCF2`
  (Fläche), fast Schwarz `#1C1712` (Text), Bronze `#7B5426` (Textakzent und
  Primär-CTA mit weißer Schrift), Gold `#BF9B30` nur dekorativ, `#E2C46E` auf
  dunklem Grund. Kontraste nach WCAG AA (u. a. Text 17,3:1, Bronze auf Creme
  6,5:1, Weiß auf Bronze 6,7:1). Systemschriften, Überschriften mit
  Serifen-Stack; Wortmarke „Miet-Royal“ in Serifen-Versalien, bis im CMS ein
  Logo gepflegt ist.
- Navigation: Start, Slush, Ablauf, FAQ, Über uns, Kontakt, Kundenbereich
  (`/konto`); CMS-Ziele erscheinen nur, wenn die Seite veröffentlicht ist.
  Dominanter CTA „Slush konfigurieren“ (`/konfigurator`) immer sichtbar (schmal
  als volle Zeile), sekundär „Unverbindlich anfragen“. Nie „Jetzt verbindlich
  buchen“ – die Website erzeugt nur eine Anfrage. Kopf nicht sticky (der
  DEMO-Banner bleibt oben). Mobile-Menü barrierefrei (`aria-expanded`,
  Escape, schließt bei Navigation).
- Fußzeile: Marke, Kurzbeschreibung, Kontakt aus den Website-Einstellungen,
  Instagram nur als normaler externer Link (`rel="noopener noreferrer"`, kein
  Feed, kein iframe), veröffentlichte sekundäre Angebote/Regionsseiten,
  Impressum/Datenschutz nur, wenn veröffentlicht.
- Bewegung nur kurze Übergänge (150 ms), `prefers-reduced-motion` schaltet ab;
  sichtbarer Fokus (3 px; auf dunklen Flächen – CTA-Band, Fußzeile – in hellem
  Gold `#E2C46E`, ca. 10,5:1 statt 2,7:1 mit Bronze), Skip-Link, Touchflächen
  ≥ 44 px, genau eine H1 je Seite (Hero-Überschrift bzw. Seitentitel),
  semantische Überschriften.
- Zustände: Startseite ohne veröffentlichten Inhalt ⇒ schlichter Fallback
  („Unsere neue Website wird gerade vorbereitet.“ + CTA „Slush konfigurieren“,
  immer noindex); unveröffentlichte Seite ⇒ 404 mit Seitenrahmen; API nicht
  erreichbar ⇒ „Gleich wieder da“ ohne technische Details (immer noindex).
- Kontaktblock: Telefon als `tel:`-Link ohne „(0)“ (aus „+49 (0) …“ wird
  `tel:+49…`); auf Popcorn-/Waffel-Seiten nur Telefon und E-Mail – ohne
  Abholzeile, ohne Instagram und ohne den Knopf „Unverbindlich anfragen“ →
  Konfigurator (der Konfigurator kann nur Slush).
- Preise erscheinen nur aus dem Katalog („Mietpreis 60,00 €“ bzw.
  „12,00 € je 1-L-Flasche · auf Kommission“) – nie als CMS-Text.
- Bewertungen nur als Klick-zum-Laden („Bewertungen anzeigen“ mit Hinweis „Beim
  Laden werden Bewertungen und Profilbilder von Google abgerufen.“), nur wenn ein
  Provider aktiv ist; Demo eindeutig „DEMO – synthetische
  Beispielbewertungen“; Fehler ⇒ „Bewertungen sind gerade nicht verfügbar.“
  Google-Modus: Attribution mit dem offiziellen Google-Maps-Logo (Phase 17:
  unverändertes Asset, 18 px hoch, Freiraum, `alt` „Google Maps“, nicht
  übersetzbar, eigenständig neben der Gesamtbewertung – nie im Fließtext, nie
  in der Fußzeile; verlinkt auf den Ort), „Google Maps“ in Linktexten ohne
  Zeilenumbruch, Richtlinienhinweis von Google mit Link, „Von Google übersetzt“
  bei übersetzten Texten, Originaltext optional aufklappbar.
- Keine Live-Verfügbarkeit, keine Bestandszahlen, kein WhatsApp-Widget, kein
  Google-Maps-Embed, kein Newsletter, keine Marketing-Tracker, kein
  Cookie-Banner (nur technisch nötige Cookies).
- Konfigurator in sechs Schritten (Event, Maschine, Sirup & Zubehör, Abholung
  oder Lieferung, Kontakt, Zusammenfassung) mit Fortschrittsanzeige, laufender
  Übersicht ausschließlich aus der Server-Vorschau und dominantem Button
  „Unverbindliches Angebot anfordern“; Bestätigung mit Vorgangsnummer und dem
  klaren Hinweis „unverbindlich – noch keine Buchung“. Ab 250 Gästen nur ein
  freundlicher Hinweis. Abholung nur „Mainz-Hechtsheim“ + „Die genaue
  Abholadresse teilen wir dir rechtzeitig mit.“; Lieferung „wird individuell
  geprüft“, Wunsch-Lieferzeitfenster am Veranstaltungstag (Ende nach dem
  Beginn). Fehlertexte nennen den nächsten Schritt und stehen am Feld, nie
  Codes. Eingaben sind erst nach dem Laden der Seite (Hydration) bedienbar –
  keine still verlorenen Eingaben.

Umsetzung Phase 17 (SEO und technische QA, Details docs/SEO_TECHNICAL.md und
docs/WEBSITE_QA_REPORT.md):
- Brotkrume nur dort, wo sie Orientierung gibt: Regionsseiten („Start ›
  Slushmaschine mieten › Ort“) und sekundäre Angebote („Start › Seite“) –
  `nav aria-label="Brotkrumen"` mit `ol`, aktuelle Seite als
  `aria-current="page"` ohne Link, Trennzeichen rein per CSS, Einträge ≥ 44 px,
  umbrechend. Keine Brotkrume auf Start- und Hauptseiten; das JSON-LD entspricht
  exakt der sichtbaren Brotkrume (nie versteckte SEO-Breadcrumbs).
- 410-Seite („Diese Seite gibt es nicht mehr.“): Website-Look mit Creme/Bronze
  und Serifen-Überschrift, Erklärung in du-Ansprache, CTA „Slush konfigurieren“,
  Links „Zur Startseite“, „Slushmaschine mieten“, „Kontakt“; echter Status 410,
  noindex, kein Script, keine technischen Codes. 404-Seite: Titel „Seite nicht
  gefunden – Miet-Royal“, echter Status 404 (auch für unveröffentlichte
  CMS-Seiten).
- Umbruch statt Überlauf: Überschriften mit `overflow-wrap: anywhere` und
  `hyphens: auto`; kein `white-space: nowrap` auf variablen Textwerten (z. B.
  Preiszeilen der Inklusiv-Listen – der Betrag bleibt durch das geschützte
  Leerzeichen zusammen); Raster mit `minmax(0, 1fr)` statt `1fr`, damit sie
  unter die Min-Content-Breite schrumpfen (Konfigurator: die Schrittleiste
  scrollt intern); keine horizontale Seite bei 320–1440 px außer bewusst
  scrollbaren Komponenten. Sichtbarer Fokus (3 px, Gold auf dunklem Grund) auch
  auf der 410-Seite.
- Marken-Link im Kopf: der zugängliche Name ist der sichtbare Text (Wortmarke
  bzw. Logo-Alt-Text plus Slogan); ein `aria-label` („<Firma> – Startseite“) nur,
  wenn der Link keinen Text hat (dekoratives Logo ohne Slogan) – WCAG 2.5.3
  „Label in Name“.
- Favicon/App-Icon: neutraler Platzhalter („MR“ auf Bronze, `app/icon.svg`,
  `app/favicon.ico`) bis das finale Logo vorliegt – 1:1 ersetzen
  (docs/OPEN_ITEMS.md „Phase 17“).
- Weiterhin keine Tracker, kein Consent-Manager, keine Cookie-Banner;
  Bewertungen bleiben Klick-zum-Laden.

Staff-Bereich „Website“ (Phase 16, Navigation bei `cms.edit` oder
`cms.publish`, nach „Produkte“): Übersicht mit Gruppen (Einstellungen,
Hauptseiten, Regionale Seiten, Sekundäre Angebote, Rechtliches) und Status als
Text („Veröffentlicht“, „Entwurf mit Änderungen“, „Nicht veröffentlicht“);
Editor mit einem Formular je Blocktyp, Zeichenzählern für Meta-Titel (70) und
-Beschreibung (170), Bildwahl mit Alt-Text oder „dekorativ“, Hinweis bei
ungespeicherten Änderungen; eine Hauptaktion je Schritt („Entwurf speichern“,
„Vorschau öffnen“ im neuen Tab, „Veröffentlichen“ mit Bestätigung der
Revisionsnummer); Nur-Publisher im Lesemodus; Konflikt ⇒ „Der Entwurf wurde
inzwischen geändert – bitte neu laden.“; Prüfmeldungen am Feld mit lesbarem
Pfad („Block 3 (Vorteile) › Eintrag 1 › Titel“), nie rohe Codes. „Produkte &
Preise“ ist eine Lesesicht mit Link nach `/produkte`. Kasten „Website-Anfrage“
in der Inquiry-Ansicht des Vorgangs: kompakt, nur bei Website-Anfragen, keine
automatische Zusammenführung.
Phase 17: Kasten „Hinweise zur Suchmaschinen-Darstellung“ in der Übersicht und
„Hinweise zu Titel, Beschreibung und Inhalt“ im Editor – Geltungsbereich als
Text („Veröffentlicht“, „Entwurf“, „Produkte & Preise“), Servermeldung ohne
Codes, Satz „nichts wird blockiert“; Links „Bearbeiten“ bzw. „Produkte & Preise
öffnen“; kein Score, keine Sperre, kein Ladeindikator; bei fehlendem Recht,
offline oder Fehler fehlt der Kasten still (Warnungen nur bei echtem
Handlungsbedarf).

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

