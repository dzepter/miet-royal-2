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

## Geschäftsdaten (vor Live)
exakte Abholadresse, feste Telefonnummer, E-Mail, Impressumsdaten,
Mietbedingungen/Datenschutz juristisch final prüfen.

## Maschinenstamm (vor Phase 5/Live)
MR-IDs, Kaufdaten, Gewichte, Standorte, Referenzfotos, bestehende Schäden.

## Lagerstart (vor Phase 5/Live)
Bestände und Mindestmengen.

## Popcorn/Waffel (vor Website)
Preise, Inklusivleistungen, Bilder, Anfragefelder, Transportinfos.

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

## Alte Website (vor Phase 17)
URL-Liste, wichtige Rankings, Redirect-Mapping, zu übernehmender Content.

## Noch als Admin-/Stammdaten definieren
- genaue Gästezahl→Maschinenempfehlungslogik
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

## Phase 15 – Stand nach Phase 15 (2026-11-05)

Kundenportal (`/konto`, API `/portal/*`, docs/CUSTOMER_PORTAL.md): Magic-Link-
Anmeldung, aktuelle Buchung(en), Dokumente, Portalnachrichten, Rechnungsstatus,
Kundenstorno, Profil mit Reauth, Demo-Integration. Go-live-Punkte
(Konfiguration/Geschäftsdaten, kein Code – nichts davon wird erfunden):

- **Telefonnummer für den Anruf-Button (`COMPANY_PHONE_NUMBER`):** Produktivwert
  der Miet-Royal-Rufnummer festlegen (kein Secret; Ziffern, optional `+`,
  Leerzeichen, `-`, `/`, Klammern). Ohne Wert zeigt das Portal keinen Anruf-
  Button; die Config bleibt optional (Order §37).
- **Ziel-URL „Neue Anfrage starten“ (`PORTAL_NEW_INQUIRY_URL`):** Es gibt keine
  öffentliche Anfrage-Route (Website/Konfigurator sind nicht Teil von Phase 15);
  feste https-URL der bestehenden Anfrage-/Kontaktseite setzen. Ohne Wert zeigt
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

Offene Fachpunkte (konservativ umgesetzt, Entscheidung des Auftraggebers
ausstehend – Design Phase 15 §7):

- Eine Portalnachricht zählt NICHT automatisch als „Kundenantwort“ einer
  Abrechnungsklärung – die Mitarbeitenden entscheiden weiterhin manuell.
- Eine begonnene, nicht finalisierte Übergabe ist nach der Phase-9-Regel kein
  Storno-Blocker; das Portal folgt Phase 9 unverändert (keine neue Regel).
- Ein abgeschlossener Vorgang ohne Abrechnung bleibt im Portal sichtbar
  (Order §14 „kein finaler Zahlungsstatus“), bis ein finaler Zahlungsstatus
  vorliegt.
- Die Rechnungsnummer wird im Portal nicht gezeigt (nur Status Offen / Bezahlt /
  Überfällig; finaler Betrag erst bei finaler Rechnung).
- Die Bestätigung eines E-Mail-Wechsels verlangt kein Cookie der anfordernden
  Session (Gerätewechsel: die neue Adresse darf auf einem anderen Gerät geöffnet
  werden); Bindung an Kunde + anfordernde Session (muss noch gültig sein) +
  one-time Token; danach werden alle Sessions widerrufen.
- Kein WhatsApp-Button, keine Buchungshistorie, kein Passwort-/Social-Login
  (Order §2) – keine offenen Punkte, bewusst nicht gebaut.
