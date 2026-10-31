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

## Phase 14 – offene Entscheidungen (vor Abnahme zu klären)

Die Demo-Umgebung, der kanonische Seed und der Reset (Auftrag §0–§20) sind
umgesetzt. Folgende Punkte sind keine technischen Details, sondern
Geschäftsentscheidungen des Auftraggebers und bleiben bis zur Entscheidung
bewusst unentschieden (keine erfundene Defaultregel im Produktivcode):

- **Trainings-Metaebene (Auftrag ab §21 fehlt):** Felder und Regeln für
  Definitionen, Pfade, Zuweisungen, Versuche, Prüfkriterien, Fortschritt,
  Live-Sperren, Admin-Bestätigung und Override; Pflichttests, E2E, Gate und
  Berichtsform. Bis dahin existiert kein Trainingsschema; der Reset hält den
  Hook `beforeBusinessWipe` für „laufende Versuche ⇒ interrupted
  (DEMO_DATA_RESET)“ bereit.
- **W1 Lexware-Mock in der Demo – GESCHLOSSEN (Auftrag Teil 2, W1/§29/§30):**
  Mock in demo abgeschaltet; Gateway in demo immer `disabled`, Abrechnung
  endet bei „Bereit zur Buchhaltung“ („Buchhaltungsübertragung ist in der
  Demo nicht verfügbar.“, kein Fehlerzustand), `voucher.situation` als
  Seed-Fixture (W1.1). Details: TECH_DECISIONS „Phase 14: W1 Lexware/
  Accounting in der Demo“ und INTEGRATIONS (Lexware, Phase 14).
- **W2 Weg eines bestandenen Demo-Trainings nach Live – GESCHLOSSEN (Auftrag
  Teil 2, W2/§56–§66):** Übungen, Pfade, Zuweisungen und Versuche nur in der
  Demo-DB; Live kennt ausschließlich Katalog-Keys, Live-Sperren
  (`training_feature_requirements`), manuell bestätigte Freigaben
  (`verified_demo`), Overrides (Begründung Pflicht, optional befristet) und das
  Audit – keine ID-Kopplung, keine Synchronisierung, kein Cross-DB-Zugriff.
  Damit geschlossen: L3 (fester Feature-Katalog mit acht Live-Mutationen, kein
  Systemadmin-Bypass, Gate auch im Offline-Sync), L4 (Override: Begründung
  Pflicht, `validUntil` optional, Audit, idempotenter Widerruf), L5
  (Admin-Bestätigung `verified_demo`). Details: TECH_DECISIONS „Phase 14:
  Training Gates & Freigaben (W2)“, PERMISSIONS „Training Gate“.
- **Training Gates – verbleibende Fachfragen (keine Blocker):** (1) Darf eine
  Demo-Bestätigung (`verified_demo`) befristet sein? API und Schema erlauben
  `validUntil` für beide Quellen, die UI bietet es nur beim Override an. (2)
  Dürfen Freigaben für eine inaktive Übung erteilt werden? Heute erlaubt
  (unkritisch: inaktive Übungen können kein Sperrziel sein). (3) Soll der
  Wechsel der Übung bei aktiver Sperre ein eigener Audit-Typ sein? Heute
  `training.gate_enabled` mit `previousDefinitionKey`.
- **Reichweite von `training.manage` gegenüber `demo.manage` – GESCHLOSSEN
  (L11):** `training.manage` = Trainingsverwaltung (Demo: Zuweisungen,
  Fortschritt, Training-Reset; Live: Sperren, Freigaben, Overrides);
  `demo.manage` = Status, Seed-Registry, Reset in der Demo. Geprüft wird in der
  Umgebung, in der die Route existiert (Live-Gate-Routen nur außerhalb demo,
  Demo-Routen nur in demo).
- **DEMO-Vermerk auf PDFs/Dokumenten** der Demo (L9): geschlossen (Auftrag Teil 2
  §89, Phase 14 RESET) – in `APP_ENV=demo` tragen alle Kundendokumente die Zeile
  „DEMO – keine echten Kundendaten“ und den Titelpräfix „DEMO · “
  (`packages/documents` `PdfRenderOptions`, `apps/api/src/documents/environment-label.ts`).
- **Mietbedingungen in der Demo:** Versand von Angeboten braucht eine aktive
  Version; der Seed legt nur dann einen klar markierten Platzhalter an, wenn
  keine existiert.
- **Simulation eingehender WhatsApp-Nachrichten** in der Demo (Webhook ist in
  demo 404; nur der Service-Einstieg existiert).
