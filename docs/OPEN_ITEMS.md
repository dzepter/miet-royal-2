# OPEN_ITEMS — Erst vor jeweiliger Phase erforderlich

Diese Punkte blockieren Phase 0–2 nicht.

## Lexware (vor Phase 10)
- exakt genutzte Edition
- aktuelle offizielle API
- Auth
- Rechnungserstellung
- automatischer Mailversand
- Zahlungsstatus
- Rechnungsnummer
- Stornorechnung
- Kostenstelle/Bestellreferenz
- Anzahlung/Kaution
Keine Funktion annehmen, bevor aktuelle Doku geprüft wurde.

## E-Mail (Phase 12 – technisch umgesetzt, Betrieb offen)
Umgesetzt: provider-neutral SMTP (Versand) + IMAP (Eingang), Outbox, Vorlagen,
Antwort-Zuordnung (docs/COMMUNICATION_INTEGRATIONS.md). Vor Live noch offen:
- konkretes Postfach/Provider und Absenderadresse (`MAIL_FROM_ADDRESS`, `MAIL_REPLY_ADDRESS`)
- SPF/DKIM/DMARC der Absenderdomain (Aufgabe des Mailservers, nicht der Anwendung)
- `MAIL_PUBLIC_WEB_BASE_URL` der öffentlichen Web-App
- ein Live-Test mit echtem Konto (`pnpm mail:smoke`) – im Gate bewusst nicht ausgeführt

## WhatsApp (Phase 12 – technisch umgesetzt, Betrieb offen)
Umgesetzt: ausschließlich offizielle Meta Cloud API, Webhook mit Signaturprüfung,
Text + Bilder eingehend, freie Staff-Antwort nur im 24-h-Fenster, keine Templates.
Vor Live noch offen:
- Meta Business / WABA, Telefonnummer, System-User-Token, App-Secret, Webhook-Registrierung
- Live-Test mit Testnummer (`pnpm whatsapp:smoke`)

## Apple Kalender (Phase 12 – entschieden: privater ICS-Feed)
Umgesetzt: read-only ICS-Abo je Mitarbeiter (kein CalDAV, keine Apple-ID).
Vor Live noch offen: manueller Abo-Test auf iPhone/Mac mit echter HTTPS-Domain
(Staff-Basis-URL in den Einstellungen).

## Go-live-Smokes Kommunikation/Buchhaltung (vor Produktivbetrieb, KEIN Phase-13-Blocker)
Bestätigt 2026-10-22: technisch abgeschlossen; vor dem echten Produktivbetrieb
mit echten Konten durchzuführen (im Quality Gate bewusst nicht ausgeführt):
- echter SMTP-/IMAP-Smoke (`pnpm mail:smoke`)
- echter WhatsApp-Testaccount inklusive Bildempfang und Verifikation des
  tatsächlichen Media-Downloadhosts (`pnpm whatsapp:smoke`)
- manuelles Apple-Kalender-Abo auf iPhone/Mac mit echter HTTPS-Domain
- Lexware-Smoke gegen einen Testaccount (`LEXWARE_SMOKE=1 pnpm lexware:smoke`)
- Steuer-/Buchhaltungsentscheidungen (siehe „GO-LIVE-BLOCKER Buchhaltung“)

## Kommunikation – offene Fachfragen (Phase 12)
- Abholadresse in Erinnerungen nur, wenn `pickup_exact_address` gesetzt ist –
  bleibt Geschäftsdaten-/Go-live-Punkt (exakte Abholadresse, siehe
  „Geschäftsdaten“); keine Adresse erfinden, die bestehende Logik (Adresse nur,
  wenn bestätigt gesetzt) bleibt unverändert.

Mit der Phase-12-Finalisierung entschieden (nicht mehr offen, siehe
TECH_DECISIONS.md „Phase 12 Finalisierung: Retention“):
- Storno-Retention: terminal = abgeschlossen ODER storniert; Chatfotos sofort,
  Chattext 12 Berliner Kalendermonate nach dem Stornozeitpunkt
  (`processes.cancelled_at`).
- Nicht zugeordnete/ignorierte Nachrichten, Quarantäne-Belege und ihre Fotos:
  90 Kalendertage nach Eingang bereinigen (technische Minimaldaten bleiben).
- `mail_deliveries` (Empfänger, Betreff, Kontext, Anhänge, In-Reply-To,
  Secret-Payload): prozessgebunden 12 Berliner Kalendermonate nach
  Abschluss/Storno, sonst 90 Tage nach Endzustand; danach kein Resend.
- Dokument-Link zum Rückgabeprotokoll: 90 Tage gültig (bestätigt).
- WhatsApp nach 90 Tagen (bestätigt 2026-10-22): nicht zugeordnete WhatsApp-PII
  minimieren, Kontakte ohne Kundenbindung löschen, wamid und Job-Schlüssel nur
  noch gehasht, soweit für den technischen Dedupe-Nachweis nötig.

Bestätigte Produktentscheidungen (nicht mehr offen, siehe TECH_DECISIONS.md
„Phase 12 Finalisierung: Bestätigte Produktentscheidungen“):
- Reminder-Toleranz 6 h; keine verspätete 7-Tage-Mail, wenn die Buchung erst
  nach dem 7-Tage-Zeitpunkt entsteht.
- WhatsApp-Auto-Zuordnung nur zu offenen/wieder geöffneten Vorgängen, außer bei
  eindeutigem Antwortkontext.
- Push: bewusste Browserberechtigung, danach kein internes Opt-out.
- Vertretungsende darf eine neue Erinnerung an die ursprüngliche Person auslösen.

## Routing (vor Phase 13)
Provider, Kosten, Limits, Datenschutz, DE-Geocoding.

## Hosting (vor Produktivsetup)
Exakter STRATO VPS oder Alternative, CPU/RAM/Storage, Backup,
Object Storage, DNS, Monitoring, SSH/Deployment.

## Marke / Assets (vor visueller Finalisierung)
Logo, echte Maschinenbilder, Eventbilder, ggf. Teamfotos, Icons/Favicon.
Phase 16: weiterhin offen – die neue Website nutzt bis dahin die Wortmarke
„Miet-Royal“ und Sektionen ohne Bild (siehe „Phase 16“).

## Geschäftsdaten (vor Live)
exakte Abholadresse, feste Telefonnummer, E-Mail, Impressumsdaten,
Mietbedingungen/Datenschutz juristisch final prüfen.

## Maschinenstamm (vor Phase 5/Live)
MR-IDs, Kaufdaten, Gewichte, Standorte, Referenzfotos, bestehende Schäden.

## Lagerstart (vor Phase 5/Live)
Bestände und Mindestmengen.

## Popcorn/Waffel (vor Website)
Preise, Inklusivleistungen, Bilder, Anfragefelder, Transportinfos.
Phase 16: Seiten `/popcornmaschine-mieten` und `/waffeleisen-mieten` existieren
nur als CMS-Entwürfe ohne Preise/Inklusivleistungen/Transportangaben; die
Geschäftsdaten bleiben offen (siehe „Phase 16“). Kein Blocker für den
Slush-Relaunch.

## Steuer/Rechnung (vor Phase 9/10)
MwSt.-Behandlung, brutto/netto, Rundungsregeln, Lexware-Verantwortung.

## GO-LIVE-BLOCKER Buchhaltung (nach Phase 10 verbindlich offen)
Diese Fragen beantwortet das System bewusst NICHT selbst (kein technischer
Default). Die Production-Fail-Closed-Logik aus Phase 10 bleibt bestehen: ohne
vollständige, nicht-synthetische Steuerkonfiguration und bei Anzahlung/
angewendeter Kaution wird keine Rechnung erzeugt. Sie blockieren Phase 11
nicht, aber den Produktivbetrieb der Buchhaltung.

1. **Preisbasis der Endkundenpreise:** Sind die in Miet-Royal gepflegten
   Endkundenpreise brutto, netto oder umsatzsteuerfrei? (Phase 10 übergibt
   die Beträge als Netto an Lexware, die Steuerart ist konfigurierbar – die
   fachliche Entscheidung fehlt.)
2. **Reale Steuerbehandlung je Phase-10-Kategorie:** Steuerart und Satz für
   machine_rental, delivery, purchase, commission_consumption, cleanup_fee,
   damage_charge, missing_item_charge, late_fee, manual_charge,
   cancellation_charge (Rabatt folgt der Maschinenmiete) – mit Buchhaltung/
   Steuerberatung festlegen und in Einstellungen → Steuern eintragen
   (synthetische Werte gelten in production nicht).
3. **Echte Anzahlungen in Lexware:** Wie sollen Anzahlungen buchhalterisch
   abgebildet werden, solange Down-Payment-Invoices per Public API nur
   read-only sind? (Bis zur Entscheidung Blocker `ADVANCE_PAYMENT_UNSUPPORTED`.)
4. **Tatsächlich angewendete Kaution:** Wie wird eine auf die Abrechnung
   angewendete Kaution buchhalterisch korrekt abgebildet? (Bis zur
   Entscheidung Blocker `DEPOSIT_UNSUPPORTED`; nur gehaltene/freigegebene
   Kautionen blockieren nicht.)
5. **Manueller Smoke gegen einen Lexware-Testaccount vor Produktivbetrieb:**
   `LEXWARE_SMOKE=1 pnpm lexware:smoke` mit explizitem Test-Env (nie
   production, nie im Quality Gate) – Profil, Subscriptions, Steuerplausibilität
   und eine Testrechnung im Testaccount gegen die Erwartungen prüfen.

## GO-LIVE-BLOCKER Routing (nach Phase 13 Final verbindlich offen)
Das System trifft hier bewusst KEINE juristische Entscheidung (kein
technischer Default). Production ist fail-closed: mit gesetztem
`GRAPHHOPPER_API_KEY` (effektiver Provider `graphhopper`) startet die
Konfiguration nur mit `ROUTING_PROVIDER_TERMS_CONFIRMED=true`
(`packages/config`, Phase 13 Final §5). Der Schalter ist kein Secret und
bedeutet ausschließlich „Vertrag gegen die implementierte Nutzung geprüft“.

1. **Vertrag/Paket muss die implementierte serverseitige Zwischenspeicherung
   erlauben:** `geocoding_cache` speichert Geocoding-Kandidaten (≤ 5, mit
   OSM-Referenz), Koordinaten und bestätigte OSM-Referenzen mit TTL 90 Tage
   (resolved) bzw. 30 Tage (review_required/no_result); außerdem werden
   minimale skalare Distanz-/Fahrzeitwerte (Meter/Sekunden, geplante Zeiten)
   je Tour/Stopp persistiert. Die GraphHopper-ToS regeln ausdrücklich nur
   temporäres clientseitiges Caching; eine dauerhafte serverseitige Speicherung
   ist nicht ausdrücklich geregelt (`docs/ROUTING_API_NOTES.md`, Abschnitt
   „Persistenz- und Caching-Grenzen“). Vor dem Go-live mit dem gewählten Paket
   bzw. per Custom-Vertrag klären – ohne Behauptung „laut ToS erlaubt“.
2. **Ergebnis negativ ⇒ vor dem Go-live reduzieren/umbauen:** TTLs verkürzen
   oder Geocoding-Cache/Kandidatenlisten/Koordinaten nicht persistieren,
   Distanz-/Fahrzeitwerte nur transient halten – NICHT den Schalter setzen.
   Bis zur Klärung bleibt production mit `ROUTING_PROVIDER=disabled`
   startbar (Touren organisatorisch nutzbar, keine Routen/Prognosen).
3. **Ergebnis positiv ⇒** `ROUTING_PROVIDER_TERMS_CONFIRMED=true` bei API und
   Worker setzen (dokumentierte Entscheidung, `docs/PRE_START_CHECKLIST.md`),
   zusätzlich bezahlter Plan (Basic oder höher) und Kontoinhaber.
4. **`push_deliveries`-Retention (Retention-/Go-live-Punkt, bewusst nicht in
   Phase 13 Final gebaut, §9):** Push-Zustellungen (`push_deliveries`, inkl.
   `tour_delay_risk`) haben noch keine eigene Aufbewahrungs-/Bereinigungsregel;
   vor dem Go-live Frist festlegen (Vorschlag analog `mail_deliveries`:
   prozessgebunden 12 Berliner Kalendermonate, sonst 90 Tage nach Endzustand)
   und als Retention-Job nachziehen. Keine Fachregel erfinden.

## Alte Website (Phase 17 umgesetzt, Rankings offen)
URL-Liste, wichtige Rankings, Redirect-Mapping, zu übernehmender Content.
Phase 16: Inventur (URLs, Inhalte, Bilder/Logo, Impressum/Datenschutz,
Widersprüche) liegt in docs/WEBSITE_MIGRATION_NOTES.md; übernommene Texte nur als
redaktionelle CMS-Entwürfe. Phase 17 (12.11.2026): Alt-URLs erneut lesend
verifiziert, Redirect-/410-Matrix umgesetzt (docs/REDIRECT_MATRIX.md,
docs/WEBSITE_MIGRATION_NOTES.md §10). Weiter offen: Ranking-/Backlink-Prüfung
und Search Console (kein Zugang; Go-live, siehe „Phase 17“).

## Noch als Admin-/Stammdaten definieren
- genaue Gästezahl→Maschinenempfehlungslogik (Phase 16: technisch als pflegbare,
  nicht überlappende Empfehlungsregeln in den Website-Einstellungen umgesetzt;
  die Bereiche selbst sind weiterhin offen und initial leer)
- Lieferpreis-Vorschlagslogik
- Maschinengewichte/Transporttexte

## Touren/Routing (nach Phase 13 offen)
Mit Phase 13 Final ENTSCHIEDEN (nicht mehr offen, siehe TECH_DECISIONS.md
„Phase 13 Final: bestätigte Produktentscheidungen“ und DOMAIN_RULES.md
„Touren“): Verspätungsschwelle (prognostizierte Ankunft nach der Frist, kein
Vorwarn-Puffer), mehrere Risiken (Incident je Stopp, ein Push je Empfänger),
GPS-Mindestqualität (≤ 250 m), „Angekommen“ ohne GPS-Näheprüfung, Entfernen
eines Stopps aus einer aktiven Tour; außerdem Offline-Lease für reine
Tourfahrer (`calendar.view`) und der GraphHopper-Go-live-Schalter (siehe
„GO-LIVE-BLOCKER Routing“).
- Mehrfach-Touren-Konflikt (mehrere aktive Touren derselben effektiven Person,
  z. B. nachträgliche Vertretung) wird nur angezeigt, nicht automatisch
  gelöst: online `GET /staff/tours/active` (`conflict`) und Warnung
  `MULTIPLE_ACTIVE_TOURS`; offline sind seit Phase 13 Corr ALLE betroffenen
  Touren read-only lesbar (`activeTours`, keine Silent-first-Reduktion).
  Keine automatische Beendigung/Übertragung, kein Planungs-Incident – die
  Planung löst den Konflikt online (bewusst, kein offener Fachpunkt).
- Lieferpreis-Vorschlagslogik bleibt undefiniert: Phase 13 zeigt nur Distanz
  und Fahrzeit; `DeliveryPriceSuggestion` liefert bewusst `null` (keine
  €/km-, Mindest- oder Zeitpreisregel erfunden).
- GraphHopper-Plan für den Produktivbetrieb (Basic oder höher; Free ist laut
  Pricing nicht für kommerziellen Produktivbetrieb) und Kontoinhaber.
- `push_deliveries`-Retention: siehe „GO-LIVE-BLOCKER Routing“ Punkt 4
  (späterer Retention-/Go-live-Punkt, nicht in Phase 13 Final gebaut).
- Kundenstatus „Unterwegs“ ist nur als Grenze vorbereitet
  (`getCustomerTravelStatus`), ohne Endpunkt (Kundenportal spätere Phase).

## Phase 14 – Stand nach Phase 14 Final (2026-11-01)

Demo-Umgebung, kanonischer Seed, Reset (inkl. verteilter Reset-Barrier), Trainings-
Metaebene, Live-Sperren und Freigaben sind umgesetzt. Die folgenden Punkte sind
mit Phase 14 Final **entschieden** und nicht mehr offen (Details in
TECH_DECISIONS.md „Phase 14 Final: Trainingsregeln“, „Phase 14: Training Gates &
Freigaben (W2)“, „Phase 14: W1 Lexware/Accounting in der Demo“ sowie
PERMISSIONS.md „Training Gate“):

- **W1 Lexware-Mock in der Demo – entschieden (Phase 14 Final):** Mock in demo
  abgeschaltet, Gateway immer `disabled`, Abrechnung endet bei „Bereit zur
  Buchhaltung“; `voucher.situation` als Seed-Fixture.
- **W2 Weg eines bestandenen Demo-Trainings nach Live – entschieden (Phase 14
  Final):** keine ID-Kopplung, keine Synchronisierung; Live kennt nur Katalog-
  Keys, Sperren, manuell bestätigte Freigaben (`verified_demo`), Overrides und
  das Audit.
- **verified_demo-Befristung – entschieden (Phase 14 Final §7):** eine bestätigte
  Demo-Übung ist unbefristet (`valid_until` muss NULL sein; API 400 „Eine
  bestätigte Demo-Übung läuft nicht ab – kein Ablaufdatum möglich.“, CHECK
  `staff_training_clearances_verified_demo_permanent_check`, Migration 0031; UI
  ohne Datum). Nur ein Override darf befristet sein; sie gilt bis zum bewussten
  Widerruf.
- **`subject_ref` – entschieden (Phase 14 Final §8):** bleibt als internes
  Evaluator-Metadatum (ausschließlich serverseitig ermittelte UUID, nie Namen/
  Nummern/Kontakte/Texte/Preise/GPS); erscheint in keiner API-Antwort, keinem
  Audit und keiner UI. Kein Schema-Umbau.
- **Gate-Wechsel-Audit – entschieden (Phase 14 Final §10):**
  `training.gate_enabled` mit `previousDefinitionKey` genügt; kein eigener Typ.
- **Tour-Training-Rechte – entschieden (Phase 14 Final §11):** keine
  Sonderrechte, keine Rechteerhöhung; der bestehende Hinweis auf fehlende
  Berechtigung bleibt.
- **Reichweite `training.manage` gegenüber `demo.manage` – entschieden (L11):**
  `training.manage` = Trainingsverwaltung (Demo: Zuweisungen, Fortschritt,
  Training-Reset; Live: Sperren, Freigaben, Overrides); `demo.manage` = Status,
  Seed-Registry, Reset in der Demo.
- **DEMO-Vermerk auf PDFs/Dokumenten – entschieden/umgesetzt (L9, §89):** in
  `APP_ENV=demo` Zeile „DEMO – keine echten Kundendaten“ und Titelpräfix
  „DEMO · “.
- **Deaktivierte Mitarbeiter – entschieden (Phase 14 Final §9):** neue
  Zuweisungen, Freigaben und Overrides an deaktivierte (`disabled`) Konten ⇒
  409 `TRAINING_USER_INACTIVE` „Der Mitarbeiter ist deaktiviert.“; Historie
  bleibt vollständig lesbar, nichts wird gelöscht; nach Reaktivierung gelten
  nicht widerrufene Freigaben wieder. Gesperrte Konten (`locked`) bleiben
  zulässig (Sperre ist vorübergehend).
- **Settlement-Training / Demo-Mail – akzeptiert (Phase 14 Final §12):**
  bestehende Umsetzung (Whitelist-Testdomain/Senke als Deployment-Voraussetzung,
  Variante „Nicht berechnen“), kein weiterer Sonderweg.
- **Katalog fail-soft, Gate nie fail-open – entschieden (Phase 14 Final §13):**
  Trainingsrouten antworten ohne Katalog 503; eine aktive production-Sperre
  blockiert bei fehlgeschlagenem Katalog-Sync die Fachaktion (503
  `TRAINING_CATALOG_UNAVAILABLE`).
- Freigaben für eine inaktive Übung bleiben wie bisher erlaubt (unkritisch:
  inaktive Übungen sind kein Sperrziel) – keine Änderung in Phase 14 Final.

Weiterhin offen (keine Blocker für Phase 15):

- **Simulation eingehender WhatsApp-Nachrichten** in der Demo (Webhook ist in
  demo 404; nur der Service-Einstieg existiert).
- **Demo-Mail-Whitelist als Deployment-Konfiguration:** `MAIL_DEMO_WHITELIST`
  mit Sink-Domain und Mail-Senke (z. B. `@demo.test`) beim Demo-Deployment
  setzen (DEPLOYMENT_NOTES/ENVIRONMENTS „Demo-Mail“) – Voraussetzung für die
  Mail-Übungen, keine Codeänderung.
- **Markenbilder** (Logo, Maschinen-/Eventbilder) – siehe „Marke / Assets“.
- **Demo-Nummernkreis:** bewusst nicht nötig (Demo-Vorgänge tragen den
  normalen Nummernkreis der getrennten Demo-Datenbank; Dokumente sind per
  DEMO-Vermerk gekennzeichnet) – kein offener Punkt.
- **Mietbedingungen in der Demo:** Versand von Angeboten braucht eine aktive
  Version; der Seed legt nur dann einen klar markierten Platzhalter an, wenn
  keine existiert (Geschäftsdaten, siehe oben).
- Go-live-Punkte früherer Phasen (Lexware, E-Mail/WhatsApp-Smokes, Routing-
  Terms, Hosting, Geschäftsdaten) bleiben wie in den Abschnitten oben.

## Phase 15 – Stand nach Phase 15 Final (2026-11-06)

Kundenportal (`/konto`, API `/portal/*`, docs/CUSTOMER_PORTAL.md): Magic-Link-
Anmeldung, aktuelle Buchung(en), Dokumente, Portalnachrichten, Rechnungsstatus,
Kundenstorno, Profil mit Reauth, Demo-Integration. Go-live-Punkte
(Konfiguration/Geschäftsdaten, kein Code – nichts davon wird erfunden):

- **Telefonnummer für den Anruf-Button (`COMPANY_PHONE_NUMBER`):** Produktivwert
  der Miet-Royal-Rufnummer festlegen (kein Secret; Ziffern, optional `+`,
  Leerzeichen, `-`, `/`, Klammern). Ohne Wert zeigt das Portal keinen Anruf-
  Button; die Config bleibt optional (Order §37).
- **Ziel-URL „Neue Anfrage starten“ (`PORTAL_NEW_INQUIRY_URL`):** Stand Phase 15
  gab es keine öffentliche Anfrage-Route. KORREKTUR Phase 16: Die neue Website
  hat jetzt eine öffentliche Website-Anfrage (`/konfigurator` ⇒
  `POST /public/inquiries`, docs/WEBSITE_CONFIGURATOR.md); nach dem Website-
  Go-live kann die Variable auf die https-URL des Konfigurators der Live-Website
  zeigen (Konfigurationsentscheidung, keine Codeänderung). Ohne Wert zeigt
  das Portal Kunden ohne aktuelle Buchung nur den Hinweis „Für eine neue Anfrage
  melde dich gern bei uns.“ (Order §36).
- **Kanonische Abholadresse `pickup_exact_address`:** vollständig pflegen
  (Einstellungen) – das Portal zeigt bei bestätigter Selbstabholung
  ausschließlich diese Adresse und den Navigationslink; ungepflegt ⇒ keine
  Adresse, kein Link (Order §19; bereits Routing-Go-live-Punkt).
- **Demo-Whitelist-Deployment:** `MAIL_DEMO_WHITELIST` mit Sink-Domain und
  Mail-Senke (z. B. `@demo.test`) ist jetzt Voraussetzung dafür, dass die
  Portal-Anmeldung in der Demo überhaupt möglich ist (Magic Link nur per Mail);
  Übungskunden mit Whitelist-Adresse und bestätigter Buchung:
  `process.return.damage`, `process.return.missing_part`,
  `process.settlement.review` (ENVIRONMENTS „Demo-Mail“). Kein Seed-Umbau nötig.
- **`MAIL_ENABLED` in production:** ohne SMTP kein Portal-Login (bestehender
  E-Mail-Betriebspunkt oben).
- **Leere Portal-Variablen:** `PORTAL_NEW_INQUIRY_URL=`/`COMPANY_PHONE_NUMBER=`
  (leer) sind wie bei `MAIL_PUBLIC_WEB_BASE_URL` ein Konfigurationsfehler –
  Variable weglassen. Bewusst keine Sonderbehandlung (Konsistenz mit den
  übrigen validierten URL-Variablen); bei Bedarf zentral ändern.

Am 2026-11-06 vom Auftraggeber entschieden und damit KEINE offenen Punkte mehr
(Regeln: docs/CUSTOMER_PORTAL.md §4/§7, TECH_DECISIONS „Phase 15
Final-Korrektur: bezahlte Buchung nach Reopen (2026-11-06)“): bezahlter Vorgang
nach Reopen (bleibt im Portal unsichtbar), Staff-Portalantwort nach Storno +
Reopen (bleibt gesperrt, auch beim kostenpflichtigen Storno), Portalnachricht
als Kundenantwort einer Abrechnungsklärung (nie automatisch).

Offene Fachpunkte (konservativ umgesetzt, Entscheidung des Auftraggebers
ausstehend – Design Phase 15 §7):

- Eine begonnene, nicht finalisierte Übergabe ist nach der Phase-9-Regel kein
  Storno-Blocker; das Portal folgt Phase 9 unverändert (keine neue Regel).
- Ein abgeschlossener Vorgang ohne Abrechnung bleibt im Portal sichtbar
  (Order §14 „kein finaler Zahlungsstatus“), bis ein finaler Zahlungsstatus
  vorliegt – ohne Abrechnung also dauerhaft („Abgeschlossen – Rechnung offen“
  mit „Rechnung wird vorbereitet“, Review R13). Eine Fachregel für das Ende
  dieser Sichtbarkeit fehlt; vor dem Go-live klären.
- Mehrdeutige Adressen (mehrere aktive Kunden mit derselben E-Mail-Adresse)
  erhalten keinen Anmeldelink; ein Hinweis an die Mitarbeitenden ist dafür nicht
  definiert (der Kunde sieht nur die neutrale Antwort).
- Die Rechnungsnummer wird im Portal nicht gezeigt (nur Status Offen / Bezahlt /
  Überfällig; finaler Betrag erst bei finaler Rechnung).
- Die Bestätigung eines E-Mail-Wechsels verlangt kein Cookie der anfordernden
  Session (Gerätewechsel: die neue Adresse darf auf einem anderen Gerät geöffnet
  werden); Bindung an Kunde + anfordernde Session (muss noch gültig sein) +
  one-time Token; danach werden alle Sessions widerrufen.
- Kein WhatsApp-Button, keine Buchungshistorie, kein Passwort-/Social-Login
  (Order §2) – keine offenen Punkte, bewusst nicht gebaut.

Offen nach den Review-Fixes R1–R13 (Phase 15, 2026-11-05; Details
docs/CUSTOMER_PORTAL.md, TECH_DECISIONS „Phase 15: Kundenportal“). Alle
folgenden Härtungen und Restrisiken sind KEINE Phase-15-Blocker (Phase 15 Final,
2026-11-06): Sie bleiben dokumentiert, in Phase 15 wird nichts davon umgebaut.

- **E-Mail-Wechsel an eine belegte Adresse (R8):** Die nie versandte, sofort
  widerrufene Platzhalterzeile trägt wegen des CHECK-Constraints die angefragte,
  einem ANDEREN Kunden gehörende Adresse in `proposed_email` – bis der Cleanup
  sie löscht (1 Tag nach Widerruf, Demo-Reset sofort). Eine Alternative
  (Platzhalter ohne Adresse) gibt es nur per Schemaänderung; Entscheidung der
  Leitung.
- **DB-Versanddrossel (R4):** Wer eine Kundenadresse kennt, kann deren
  Login-Kontingent (5 Links je 15 min) verbrauchen; der Kunde behält seinen
  jüngsten bereits versandten Link (keine Widerrufe oberhalb der Grenze), weitere
  Anforderungen bleiben in diesem Fenster still. In der Demo teilen sich
  Schulungsteilnehmende womöglich einen Übungskunden und treffen die Drossel
  gemeinsam – in der Schulungsdoku berücksichtigen (je Teilnehmer ein eigener
  Übungskunde).
- **Papierkorb (R9):** Das Verschieben in den Papierkorb widerruft Portal-
  Sessions und offene Links, schreibt dafür aber kein Security-Event (möglich
  wäre `portal.sessions_revoked` mit `reason: 'customer_trashed'`); fachlich
  entscheiden.
- **Bestätigung eines Kundenstornos an die aktuelle Adresse (R11):** Als
  „aktuell“ gilt `customers.email` – auch eine von Mitarbeitenden im CRM
  geänderte, vom Kunden nicht verifizierte Adresse. Die Anrede kommt weiter aus
  dem Buchungs-Snapshot. Bewusst so umgesetzt; bei Bedarf fachlich nachschärfen.
- **Allgemeines CRM-Concurrency-Hardening – Staff-PATCH mit veraltetem Formular
  (vorbestehend, Nachbar von R7; kein Phase-15-Blocker):** Mitarbeitende dürfen
  die Kunden-E-Mail im CRM bewusst ändern (bleibt so). Speichert eine
  Mitarbeiterin aber ein vor dem verifizierten Portal-Wechsel geladenes
  Kundenformular, kann sie die Adresse unbemerkt zurückdrehen. Spätestens in
  Phase 18 / Acceptance prüfen (möglicher Weg: optimistische Sperre); jetzt keine
  CRM-Versionierungsarchitektur.
- **Optionale Härtungen (theoretisch, nicht reproduziert):**
  - R5 (TOCTOU): Die Bedingung „Bestätigung nur bei `prepared` nachreihen“ wird
    vor dem Service-Aufruf geprüft; zusätzlich unter `FOR UPDATE` in
    `sendConfirmation` prüfen.
  - R1 (Storno + Reopen im Wettlauf mit einer Staff-Portalantwort): in
    `replyByPortal` die Stornozeile nach der Vorgangssperre in einer zweiten
    Abfrage lesen.
- **Staff-Fotoroute ohne CSP (außerhalb Phase 15):**
  `/staff/messages/:id/photos/:photoId` liefert Kundenbilder ohne
  `Content-Security-Policy: default-src 'none'; sandbox` (die Portal-Fotoroute hat
  sie seit dem Review). Defense in Depth, kein bekannter Angriff.
- **Body-Limit der Staff-App (vorbestehend seit Phase 8):**
  `apps/staff/next.config.ts` behält den Next-Default von 10 MiB für den
  Rewrite, `POST /staff/offline/sync` erlaubt 12 MiB – ein Sync-Body zwischen 10
  und 12 MiB würde ohne Fehler abgeschnitten. Empfehlung:
  `experimental.proxyClientMaxBodySize` ≥ 13 MiB wie in `apps/web`.
- **Consume-Limit 10/min je IP:** `POST /portal/auth/consume` (und die übrigen
  Consumes) greifen hinter einer gemeinsamen IP (Firmen-/Carrier-NAT) schon bei
  etwa 10 Anmeldungen pro Minute; der Kunde sieht „Zu viele Versuche …“ und muss
  den (weiter gültigen) Link erneut öffnen. Für den Go-live bewerten.
- **Restrisiken aus dem Review (Hinweise ohne Fund, bewusst nicht geändert):**
  - Login-CSRF über einen fremden Magic Link: Wer einem Kunden
    `/konto/anmelden#token=<eigener Token>` schickt, meldet ihn nach dem Klick auf
    „Kundenbereich öffnen“ im Konto des Absenders an; die Zielidentität wird vor dem
    Consume nicht angezeigt. Bei Magic Links inhärent, verlangt einen bewussten
    Klick. Ebenso inhärent: Ein E-Mail-Wechsel auf eine fremde, keinem aktiven
    Kunden gehörende Adresse wird wirksam, sobald deren Inhaber den Link bestätigt.
  - Keine Rate-Limits für den Profil-PATCH (verlangt aber eine höchstens 15 min
    alte Reauth) sowie Dokumentliste und Dokument-Download; begrenzt sind nur die
    Link-Anforderungen und Consumes, das Chat-Senden und der Storno-POST.
  - Speichervolumen der Chat-Fotos: höchstens 5 Fotos je Nachricht zu je ≤ 8 MiB,
    durch das Body-Limit von 12 MiB (Base64-JSON) rund 9 MiB Rohbytes je
    Nachricht, bei 20 Nachrichten/min je Session; ein Speicherkontingent je Kunde
    gibt es nicht.
  - Mailzustellungen der Magic Links (ohne `process_id`): Der Secret-Payload wird
    nach dem Versand geleert, Empfänger und Kontext entfernt erst der Scrub 90
    Berliner Kalendertage nach dem Endzustand; die Zeilen selbst bleiben. Die Menge
    begrenzen nur die IP-Limits und die DB-Versanddrossel (5 Links je 15 min je
    Kunde bzw. bei Reauth je Session).
- **Uhrzeitabhängige Touren-Integrationstests – ERLEDIGT (Phase 17, Auftrag §27 B):**
  `tours-delay-risk`, `tours-multi-active`, `offline-tour-lease`, `tours-delay-accuracy` und
  `tours-delay-push` drehen ab 19:00 Uhr Berlin die Testuhr auf 09:00 desselben Tages zurück
  (`pinMorningClockIfEvening`, nur `Date`, nie vorwärts; keine Produktlogik geändert) – die
  Integrationssuite hat kein Startzeitfenster mehr (TEST_PLAN „Touren … Phase 13“). Die
  verbleibenden E2E-Fenster und die Option einer injizierbaren API-Testuhr stehen unter „Phase 17“.
- **E2E-Seed-Abkürzungen** (`apps/api/scripts/e2e-portal-seed.ts`,
  `tests/e2e/helpers/portal.ts`): Live-Standort der aktiven Tour (Szenario G) per
  SQL wie der Integrationstest-Helfer; vom Seed erzeugte Dokument-Bytes werden mit
  identischem Storage-Key ins Storage der E2E-API (`apps/api/.storage`) kopiert;
  Session-Zeilen werden für H (Reauth-Frische) und O (30-Tage-Grenze) nur in der
  Zeit verschoben. Bei einer Änderung des Storage-Layouts der E2E-API muss
  `seedPortal` mitgezogen werden.

## Phase 16 – Stand nach Phase 16 (2026-11-06)

Neue Website, internes CMS, Slush-Konfigurator mit Website-Anfrage und
Google-Bewertungs-Grenze sind technisch umgesetzt (docs/WEBSITE_CMS.md,
docs/WEBSITE_CONFIGURATOR.md, docs/GOOGLE_REVIEWS_API_NOTES.md). Die bestehende
Live-Website bleibt unverändert online; keine DNS-/Domain-Umschaltung.

**Offene Business-Inhalte (Order §30 – NICHT erfunden; alles später über
CMS/Konfiguration ergänzbar, ohne die Website neu zu programmieren):**

- **Gästezahl→Maschinen-Empfehlungsbereiche:** Regeln (`guestMin`, `guestMax`
  optional, aktive Slush-Maschine) sind im Staff unter Website → Website-
  Einstellungen pflegbar; initial leer. Bis dahin zeigt der Konfigurator „Wir
  prüfen persönlich, welche Maschine am besten zu deinem Event passt.“
- **Popcorn:** Preis, Inklusivleistungen, Transportdetails (und Bilder,
  Anfrageweg) – Seite bleibt Entwurf; später als Produkt mit Preis pflegen und
  per `product_grid` mit `productSlugs` zeigen.
- **Waffel:** Preis, Inklusivleistungen, Transportdetails (und Bilder,
  Anfrageweg) – wie Popcorn.
- **Eigene Bilder/Logo:** finale eigene Bilder (Maschinen, Events, ggf. Team) und
  Logo mit geklärter Herkunft/Rechten bzw. Einwilligungen (insb. Fotos mit
  Kindern); bis dahin Wortmarke und Sektionen ohne Bild. Upload über
  Website → Medien (Alt-Text oder „dekorativ“).
- **Öffentliche Kontaktwerte bestätigen:** Telefonnummer und E-Mail in den
  Website-Einstellungen stammen als Entwurf von der bisherigen Website
  („vor Veröffentlichung bestätigen“).
- **Instagram-URL:** auf der bisherigen Website nicht belegt – erst nach
  Bestätigung in den Website-Einstellungen eintragen (nur Link, kein Feed).
- **Google Place ID und API-Zugang inkl. EWR-Nutzungszweck:** Google-Cloud-
  Projekt, Key je Umgebung, Place ID, Klärung des EWR-Nutzungszwecks (Places API
  EEA Permitted Uses) und alle Punkte aus docs/GOOGLE_REVIEWS_API_NOTES.md
  „Go-live“. Bis dahin `REVIEWS_PROVIDER=disabled` (fail-closed, Sektion
  ausgeblendet).
- **Juristisch geprüfte Impressums-/Datenschutztexte:** Die Bootstrap-Entwürfe
  sind redaktionelle Übernahmen der bisherigen Website und NICHT juristisch
  geprüft (veraltete Abschnitte bleiben als Prüfpunkte in der Redaktionsnotiz).
  Das Impressum enthält den Platzhalter „Anschrift: [vor Veröffentlichung
  eintragen]“ (Anschrift, ggf. USt-IdNr./Steuernummer, Inhaberbezeichnung/
  Rechtsform klären). Die Datenschutzhinweise müssen an die neue Website
  angepasst werden (Konfigurator/Website-Anfrage, Kundenbereich, technisch
  nötige Cookies inkl. Vorschau-Cookie, Google-Bewertungen per Klick, Instagram-
  Link, Mailversand, Hoster/Logs, Aufsichtsbehörde, Stand). Erst die
  Veröffentlichung von `/datenschutz` schaltet Website-Anfragen frei; Rechtstexte
  lassen sich danach nicht zurückziehen, nur durch neue Revisionen ersetzen.
- **Spätere Regionsseiten:** Mainz, Wiesbaden, Bad Kreuznach liegen als eigene
  Entwürfe vor („vor Veröffentlichung lokal prüfen“); weitere Orte aus
  MASTER_SPEC §30 nur einzeln und mit eigenem Inhalt (Website → „Regionale
  Seite anlegen“), keine Massenerzeugung.
- **Lieferpreis-Vorschlagslogik:** weiterhin undefiniert; Website und
  Konfigurator nennen keinen Lieferpreis („Lieferung wird individuell geprüft“).
- **Über-uns-Fakten bestätigen:** Geschichte, „Familienbetrieb aus Mainz seit
  2023“, Namen und die kurze Einweisung bei der Übergabe stammen nur von der
  bisherigen Website ⇒ Bestätigung durch den Inhaber; ebenso die Liste der
  Einsatzgebiete und Mengen-/Zeitangaben im Text (bei Regeländerung manuell
  nachziehen). Öffnungszeiten sind nicht belegt und werden nicht erfunden.

**Phase 17 (umgesetzt 2026-11-12, Abschnitt „Phase 17“):** Redirect-/410-Matrix,
Sitemap, robots.txt, Canonicals, strukturierte Daten, Lighthouse-/Accessibility-/
Responsive-QA, SEO-Hinweise im Staff, lesende Prüfung alter URLs. Weiter offen:
Ranking-/Search-Console-Prüfung. Die Indexierung bleibt bis zum Website-Go-live
aus (`WEB_INDEXING_ENABLED` nicht gesetzt ⇒ überall `noindex`).

**Technische Restpunkte und Betriebshinweise (keine Phase-16-Blocker):**

- **Rate-Limits prozesslokal:** Die IP-Limits der Website (Anfrage 5/min +
  20/h, Konfigurator-Vorschau 60/min, Vorschau-Einlösen 20/min, Bewertungen
  10/min) liegen wie alle bestehenden IP-Limits im Speicher JE API-PROZESS –
  mehrere Replikate vervielfachen das effektive Limit. Wirksam je Client nur mit
  korrektem `API_TRUST_PROXY_HOPS` (docs/DEPLOYMENT_NOTES.md „Öffentliche
  Token-Links hinter Proxy“); hinter einer gemeinsamen IP (Firmen-/Carrier-NAT)
  greifen sie entsprechend früher. Global (DB) ist nur die Tagesgrenze der
  Google-Abrufe. Kein CAPTCHA in Phase 16.
- **429-Fehlercode:** Die Minutenlimits über `@fastify/rate-limit` liefern wie
  alle bestehenden Routen Status 429 mit dem generischen Code der
  Fehlerbehandlung (`BAD_REQUEST`, englische Plugin-Meldung); nur das
  Stundenfenster der Website-Anfrage liefert `RATE_LIMITED`. Web und Staff
  werten den Status aus – bei Bedarf zentral vereinheitlichen (in Phase 16
  bewusst nicht, betrifft alle bestehenden Routen; docs/TECH_DECISIONS.md
  „Phase 16“).
- **Status „Nicht veröffentlicht“:** Die API meldet für zurückgezogene Seiten
  ebenfalls `never_published`; ein eigenes Feld (z. B. „war veröffentlicht“)
  würde den Status präziser machen.
- **Veröffentlichte Bilder im Browser-Cache:** öffentliche Medien tragen
  `immutable` mit bis zu einem Jahr Gültigkeit – ein einmal veröffentlichtes Bild
  kann nach dem Zurückziehen in Browser-Caches bleiben (docs/WEBSITE_CMS.md
  „Medien“). Kein Löschen von Medien in Phase 16.
- **Kontaktblock auf Popcorn-/Waffel-Seiten:** ERLEDIGT (Review-Fix
  2026-11-06): `contact_details` zeigt auf `secondary_offer`-Seiten nur Telefon
  und E-Mail – weder die Zeile „Abholung: …“ noch Instagram noch den Knopf
  „Unverbindlich anfragen“ → `/konfigurator`.
  Offen bleibt nur der Business-Inhalt (Anfrageweg, Transport) – siehe oben.
- **Wiederholung nach Datumswechsel:** ERLEDIGT (Review-Fix 2026-11-06): Die
  Website-Anfrage prüft „Datum nicht in der Vergangenheit“ und die Zeitregeln
  erst NACH der Wiederholungserkennung; dieselbe `clientMutationId` liefert auch
  nach Ablauf des Eventdatums 200 (gleicher Inhalt) bzw. 409 mit Vorgangsnummer
  (Test PI21).
- **Adress-Guard bewusst fail-closed:** Teilstring-Treffer (z. B. dieselbe Straße
  mit einer Hausnummer, die mit der Abhol-Hausnummer beginnt) werden ebenfalls
  abgelehnt; die Redaktion muss dann umformulieren.
- **Produktdaten ohne Speicher-Guard:** Name/Beschreibung eines Produkts werden
  beim Speichern unter `/produkte` nicht auf die exakte Abholadresse geprüft;
  geschützt ist der öffentliche Lesepfad (Beschreibung ⇒ null, Name ⇒ Produkt
  entfällt öffentlich). Ein Hinweis im Staff-Produktformular fehlt.
- **Zusammengesetzte Emojis im CMS:** Das Verbot aller Unicode-Formatzeichen
  schließt den Zero-Width-Joiner ein ⇒ zusammengesetzte Emojis sind in
  CMS-Texten nicht erlaubt (einfache schon). Bei Bedarf später ZWJ nur zwischen
  Emoji-Zeichen zulassen.
- **Keine Bestätigungsmail an Kunden:** bewusst (Design Phase 16); der Kunde
  sieht die Vorgangsnummer auf dem Bildschirm. Eine Mail-Bestätigung wäre eine
  neue Mail-Art und eine eigene Entscheidung.
- **Echte Google-Antwort ungetestet:** Host-Allowlist und Feldverfügbarkeit
  (`photoUri`, `text`) sind aus der Doku abgeleitet ⇒ einmaliger Staging-Smoke
  mit echtem Key vor Go-live (docs/GOOGLE_REVIEWS_API_NOTES.md „Go-live“).

## Phase 17 – Stand nach Phase 17 (2026-11-12)

SEO-Fundament, Redirect-/410-Matrix, technische QA und Testflake-Härtung sind umgesetzt
(docs/SEO_TECHNICAL.md, docs/REDIRECT_MATRIX.md, docs/SEO_STRUCTURED_DATA_NOTES.md,
docs/WEBSITE_QA_REPORT.md). Die bisherige Live-Website bleibt unverändert online; die
Indexierung der neuen Website bleibt aus (`WEB_INDEXING_ENABLED` ungesetzt).

**Erledigt (Phase 17):** fail-closed Indexierbarkeit mit konfigurierter Basis (keine
Host-Ableitung; in production nur https); Canonicals; robots.txt (crawlbar, nur `/api/`
gesperrt, veröffentlichte Bilder erlaubt, Sitemap-Zeile nur indexierbar); dynamische Sitemap
aus veröffentlichten Seiten; OpenGraph/Twitter mit Social Image nur aus veröffentlichtem
Hero-Bild; JSON-LD WebSite/Organization/BreadcrumbList; sichtbare Brotkrumen; 404-Metadaten;
410-Seite; Legacy-Redirects 308 in einem Hop im Next-Proxy; SEO-Hinweise im Staff (nie
blockierend); Preis-Guard der öffentlichen Produktprojektion (Name, Beschreibung,
Verkaufseinheit, Cent-Beträge); Google-Maps-Logo-Attribution; Lighthouse-/Accessibility-/
Responsive-QA mit Fixes (Favicon-Platzhalter, Marken-Link-Name, umbrechende Preiszeilen);
Testuhr-Pin der Touren-Integrationstests; Lexware-Wartebedingung.

**Offen / deferred (Go-live, Auftrag §35 – nichts davon in Phase 17):**

- **Search Console:** Property für `https://www.miet-royal.de/` verifizieren, Sitemap
  einreichen, Indexabdeckung und die 410-/Redirect-Pfade der bisherigen Website beobachten.
- **DNS-Umschaltung und WordPress-Abschaltung** (Phase 20); bis dahin kein Live-Test des
  www-Redirects (Go-live-Smoke SEO-R9, docs/PRE_START_CHECKLIST.md „Website-Go-live SEO“).
- **Ranking-/Backlink-Prüfung und Ranking-Monitoring:** in Phase 17 nicht möglich (kein Zugang
  zu Search-Console-/Backlink-Daten). Entscheidung `/shop/` 410 (umgesetzt) vs. 301 auf
  `/slushmaschine-mieten` nur bei nachgewiesenem Wert.
- **Rich-Results-Test / Schema Markup Validator** erst gegen die Live-Domain
  (docs/SEO_STRUCTURED_DATA_NOTES.md „Prüfmethode“); Logo-Mindestgröße 112×112 px mit dem
  finalen Logo prüfen.
- **Juristische Freigabe der Rechtstexte bleibt Blocker** (Impressum-Platzhalter, Datenschutz
  inkl. Cookies `__Host-mr_customer_session`/`__Host-mr_cms_preview`, Google-Bewertungen per
  Klick) – siehe „Phase 16“; vor der Veröffentlichung keine Indexierung einschalten.
- **Google-Bewertungen:** EWR-Permitted-Use nur über Rechtsberatung oder Google Sales klärbar
  (der technische Support gibt laut Policy vom 2026-11-09 keine Rechtsauskunft) –
  `REVIEWS_PROVIDER=disabled` bleibt. Logo-Attribution umgesetzt; Sichtabnahme mit echten Daten
  auf Staging offen (docs/GOOGLE_REVIEWS_API_NOTES.md Go-live 9). Entscheidung der Leitung:
  Logo oben neben der Gesamtbewertung (umgesetzt) oder unterhalb der Liste; zweiter Textlink
  „Alle Bewertungen auf Google Maps“ behalten (umgesetzt) oder streichen. Host-Liste für
  Avatare/Links (spätere CSP `img-src`) nur per Staging-Smoke ermittelbar.
- **Finales Favicon/Logo der Firma einsetzen:** `apps/web/app/icon.svg` und
  `apps/web/app/favicon.ico` sind neutrale Platzhalter („MR“ auf Bronze, wie die Staff-PWA-Icons
  in `apps/staff/public/icons/`) – Dateien 1:1 durch die finalen Grafiken ersetzen (gleiche
  Dateinamen); Logo in den Website-Einstellungen nur mit geklärten Rechten („Marke / Assets“).
- **Dynamische 404-Oberfläche clientseitig gerendert (seit Phase 16, in Phase 17 analysiert):**
  Für CMS-Routen, die `notFound()` werfen, liefert Next Status 404, Titel und `noindex` im HTML,
  die 404-Oberfläche (H1, Links) aber erst nach Hydration; direkte unbekannte URLs rendern
  vollständig serverseitig. Für Suchmaschinen ist der Status maßgeblich; eine serverseitig
  vollständige 404 für CMS-Pfade bräuchte eine Route-Group mit eigenem Layout/not-found – offen,
  keine Fachwirkung.
- **API-Ausfall ⇒ 200 + `noindex` statt 503:** CMS-Seiten antworten ohne erreichbare API mit der
  Zustandsseite „Gleich wieder da“ (Status 200, immer `noindex`, kein Canonical, kein JSON-LD).
  Keine indexierbare Fehlerseite; ein 503 mit `Retry-After` wäre für Crawler präziser – bewusst
  nicht in Phase 17 geändert (Phase-16-Verhalten, nur Hinweis).
- **`Organization.telephone` nur international:** eine national gepflegte Telefonnummer
  (ohne Ländervorwahl) erscheint auf der Seite, aber nicht im JSON-LD (Google empfiehlt Landes-
  und Ortsvorwahl). Kontaktwerte vor dem Go-live ohnehin bestätigen („Phase 16“).
- **Verbleibende E2E-Zeitfenster (Berlin):** `tours-flow.spec.ts` 22:43–00:02;
  `portal-flow.spec.ts` (G), `training-demo.spec.ts` (H), `tours-offline-conflict.spec.ts`
  23:38–00:02 – Produktregel `TOUR_NOT_TODAY` plus Termine „heute relativ zu jetzt“; die API
  hat keine injizierbare Uhr. Option für später: injizierbare Testuhr der API (nur Test-Env,
  wäre eine Produktänderung – bewusst nicht in Phase 17). Integrationssuite und `tours-demo`
  sind ohne Zeitfenster (docs/TEST_PLAN.md).
- **Lighthouse-Hinweise ohne Score-Wirkung:** bf-cache (`no-store` bei dynamischem SSR),
  render-blocking CSS 5,8 KB, unused/legacy JS der Next-Runtime – keine Maßnahme in Phase 17;
  LCP mit echtem Hero-Bild nicht gemessen (Seed ohne Bilder) ⇒ Staging-Nachmessung nach dem
  Medien-Upload (docs/WEBSITE_QA_REPORT.md „Nicht geprüft“).
- **Akzeptierte Redirect-Ausnahme:** Pfade mit Mehrfach-Slash (`//uber-uns/`, `/buchung//`)
  normalisiert Next vor dem Proxy ⇒ zwei Hops; keine echte Alt-URL betroffen
  (docs/REDIRECT_MATRIX.md „Verfahren“).
- **SEO-Check, bewusst ohne eigenen Hinweis:** ein veröffentlichter Eintrag mit ungültigem
  gespeichertem Inhalt (nur per Direkt-INSERT möglich, Revisionen sind unveränderlich) erzeugt
  keinen eigenen Hinweis – nur Links darauf gelten als kaputt; die exakte Abholadresse in der
  Verkaufseinheit eines Produkts wird (wie bei Name/Beschreibung) nur geloggt, das Produkt
  entfällt öffentlich. Die Meldung `BROKEN_INTERNAL_LINK` sagt „nicht veröffentlicht“, auch wenn
  das Ziel veröffentlicht, aber wegen der Adresse ausgeblendet ist – `PAGE_SUPPRESSED` erklärt
  diesen Fall. Optional später: eigene Meldungen.
- **E2E-Laufzeit:** der Production-Build der Website (Projekt `seo`) startet bei jedem
  Playwright-Lauf mit (≈ 15–60 s mit Turbopack-Cache, ohne Cache bis ~2 min) – Playwright startet
  alle `webServer`-Einträge unabhängig vom gewählten Projekt.
- **X/Twitter-Cards:** offizielle Dokumentation nicht abrufbar; Umsetzung nach bekanntem Schema,
  nicht gegen eine Primärquelle verifiziert (kein Blocker).
- **Staging darf nie indexiert werden:** `WEB_INDEXING_ENABLED` dort nicht setzen; Staging bleibt
  crawlbar, jede Antwort `noindex`, keine Sitemap-Zeile (docs/ENVIRONMENTS.md „Website-SEO“).
