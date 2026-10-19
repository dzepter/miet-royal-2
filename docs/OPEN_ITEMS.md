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

## Kommunikation – offene Fachfragen (Phase 12)
- Abholadresse in Erinnerungen nur, wenn `pickup_exact_address` gesetzt ist.

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

## Alte Website (vor Phase 17)
URL-Liste, wichtige Rankings, Redirect-Mapping, zu übernehmender Content.

## Noch als Admin-/Stammdaten definieren
- genaue Gästezahl→Maschinenempfehlungslogik
- Lieferpreis-Vorschlagslogik
- Maschinengewichte/Transporttexte
