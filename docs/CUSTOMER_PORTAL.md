# Kundenportal (Phase 15)

Stand: Phase 15. Das Kundenportal ist der optionale Kundenbereich unter `/konto` in der
öffentlichen Web-App (`apps/web`). Es ist KEIN eigenes Frontend-Projekt und KEIN eigenes
Fachobjekt: Der `customers`-Datensatz bleibt die Identität, das Portal ergänzt nur
Authentifizierung (Magic Links, Sessions) und eine kundensichere Sicht auf bestehende
Fachdaten. Fachlogik (Preise, Storno, Konversation, Dokumente, Abrechnung) wird
ausschließlich wiederverwendet, nie dupliziert.

## 1 Architektur und Grenzen

- **Web**: `apps/web/app/konto/**` (Next.js, alle Seiten Client-Komponenten, Daten nur per
  `fetch('/api/portal/…', { credentials: 'same-origin', cache: 'no-store' })`). Keine
  Accountdaten im HTML, kein SSG/ISR, keine Tokens im Client-Storage, keine Third-Party-
  Skripte. Antwort-Header für `/konto*`: `Cache-Control: private, no-store`, `X-Robots-Tag:
  noindex`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `nosniff`.
- **Proxy**: Der bestehende Same-Origin-Rewrite `/api/:path*` → `WEB_API_ORIGIN` (fester
  Wert aus der Umgebung) trägt die Portal-Aufrufe. Dadurch funktionieren HttpOnly-Cookies
  mit `SameSite=Strict` ohne CORS; es gibt kein CORS-Plugin und keine frei konfigurierbaren
  Proxy-Ziele.
- **API**: Präfix `/portal/*` (`apps/api/src/routes/portal-*.ts`, zusammengeführt in
  `apps/api/src/portal/module.ts`). Jede Route außer der Auth-Grenze läuft durch
  `requirePortalSession` (`apps/api/src/portal/guard.ts`). Staff-Session und Angebots-Token
  sind an der Portal-Grenze wertlos.
- **Autorität**: Der Kunde wird IMMER serverseitig aus der Session bestimmt. Kein Body- oder
  Query-Feld (`customerId`, `senderCustomerId`, `ownerId`) hat Autorität; Zod-Schemas sind
  `strictObject`. Fremde oder unsichtbare Ressourcen (Buchung, Dokument, Nachricht, Foto,
  Storno) liefern immer ein neutrales `404 NOT_FOUND`.
- **CSRF**: Der globale `csrfRejects`-Hook (Sec-Fetch-Site / Origin-Allowlist) gilt auch für
  `/portal`-Mutationen; über den Same-Origin-Proxy ist `Sec-Fetch-Site: same-origin`.

## 2 Authentifizierung (Magic Link)

- Login ausschließlich per Magic Link. `POST /portal/auth/request { email }`: E-Mail wird
  mit der CRM-Normalisierung (trim + lowercase) gesucht, nur Kunden mit `deleted_at IS NULL`.
  Genau ein Treffer ⇒ Link; kein Treffer oder mehrere Kunden mit derselben Adresse ⇒ KEIN Link
  (nie still einen Kunden wählen). Die Antwort ist IMMER identisch (`202`):
  „Wenn die E-Mail-Adresse bei uns hinterlegt ist, erhältst du gleich einen Anmeldelink.“ –
  keine Enumeration über Status, Body oder (praktisch) Zeit.
- Tabelle `customer_portal_magic_links` (purpose `login | reauth | email_change`,
  `token_hash`, optional `session_id`, `proposed_email`, `expires_at`, `consumed_at`,
  `revoked_at`). Token = 32 Zufallsbytes base64url (43 Zeichen); in der Datenbank liegt NUR
  der SHA-256-Hex. Der Klartext existiert nur im verschlüsselten Secret-Payload der
  Mail-Outbox (`mail_deliveries.secret_payload_ciphertext`, Phase-12-Mechanismus) und im
  Mail-Link. Nie in Logs, Audit, Fehlerbodies, Mail-Kontext, Client-Storage, Cookies oder
  Konsole.
- Gültigkeit 15 Minuten, one-time (`consumed_at` wird atomar per
  `UPDATE … WHERE consumed_at IS NULL … RETURNING` gesetzt ⇒ bei parallelem Consume gewinnt
  genau ein Aufruf). Eine neue Login-Anforderung widerruft ältere offene Login-Links des
  Kunden.
- Link-Format: `MAIL_PUBLIC_WEB_BASE_URL + /konto/anmelden#token=<TOKEN>`. Der Token steht
  NUR im URL-Fragment: Browser senden Fragmente nie an den Server, Mail-Scanner und Proxys
  können den Link nicht per GET verbrauchen. Die Seite liest das Fragment, entfernt es sofort
  per `history.replaceState`, hält den Token nur im Speicher und sendet ihn erst beim Klick auf
  „Kundenbereich öffnen“ per `POST /portal/auth/consume`. Es gibt kein GET-Consume.
- Die Basis-URL kommt ausschließlich aus `MAIL_PUBLIC_WEB_BASE_URL`; Host-Header,
  `X-Forwarded-Host`, Query oder Body haben keinen Einfluss (kein Host-Header-Poisoning).
- Rate-Limits: Anforderung je IP + nicht rückrechenbarem Hash der normalisierten Adresse,
  Consume je IP; bestehende `@fastify/rate-limit`-Muster.

## 3 Sessions

- Tabelle `customer_portal_sessions` (`customer_id`, `token_hash`, `created_at`,
  `authenticated_at`, `reauthenticated_at`, `last_seen_at`, `expires_at`, `revoked_at`,
  `user_agent_label`). Sessiontoken 32 Bytes base64url, DB nur Hash.
- Lebensdauer ABSOLUT 30 Tage ab `created_at` – kein Sliding Window. `last_seen_at` ist
  Diagnostik (gedrosselt geschrieben) und verlängert nichts. Logout widerruft die Session.
- Cookie: außerhalb von development `__Host-mr_customer_session` (HttpOnly, Secure, Path=/,
  kein Domain, SameSite=Strict), in development `mr_customer_session`. Der Proxy darf
  `__Host-`-Cookies nicht umschreiben (siehe DEPLOYMENT_NOTES).
- Ein gelöschter Kunde (`deleted_at`) macht jede Session sofort ungültig; ein E-Mail-Wechsel
  widerruft alle Sessions und offenen Links des Kunden.
- Cleanup: abgelaufene/widerrufene Sessions und verbrauchte/abgelaufene Links werden vom
  bestehenden `communication.scan_due`-Lauf gelöscht (Scanner `portal_auth_cleanup`), keine
  neue Scheduler-Infrastruktur.

## 4 Sichtbarkeitsregel (CustomerPortalVisibilityPolicy)

Einzige Stelle: `apps/api/src/portal/visibility.ts`. Eine Buchung erscheint nur mit echter
`bookings`-Zeile des Kunden (Anfrage, Angebotsentwurf oder nur versendetes Angebot sind
keine Portalbuchung). „Aktuell“ ist:

| Vorgangsstatus | Bedingung | Portalzustand |
| --- | --- | --- |
| `open` / `reopened` | immer | `active` („Bestätigte Buchung“) |
| `completed` | Abrechnung fehlt, nicht übertragen (`locked_at` NULL), oder Zahlungsstatus `open`/`overdue`/unbekannt | `completed_open` („Abgeschlossen – Rechnung offen“) |
| `completed` | Zahlungsstatus `paid` | unsichtbar |
| `cancelled` | Stornogebühr 0 € | nur Bestätigungsansicht direkt nach der Aktion (24 h über die Detailroute), nicht im Dashboard |
| `cancelled` | Gebühr > 0 € und Finanzstatus ≠ `paid` | `cancelled_fee` („Storniert – Stornogebühr“) |
| `cancelled` | Finanzstatus `paid` | unsichtbar |

0 Buchungen ⇒ „Neue Anfrage starten“; 1 ⇒ direkt die Übersicht; mehrere ⇒ Liste „Aktuelle
Buchungen“, sortiert nach nächstem Eventdatum, dann Vorgangsnummer. Es gibt KEINE Historien-
oder Archivroute („No-history“-Entscheidung, MASTER_SPEC §26).

## 5 Buchungsansicht

Quelle ist der unveränderliche Buchungs-Snapshot (`customer_snapshot`, `event_snapshot`,
`items_snapshot`, `totals_snapshot`, `delivery_snapshot`): Maschinen, Extras, Eventdatum/-zeit,
Gästezahl, Anlass, Abholung/Lieferung, Lieferadresse, vereinbarter Preis. Nie gezeigt:
Rabattgrund, Sonderpreisgrund, Freigabe-User, Mitarbeiter, interne Notizen, Lagerbestand,
Konflikte, Risiken, Listenpreise/Preisquelle, interne Vorgangsbeziehungen. Die Vorgangsnummer
`MR-YYYY-NNNN` ist sichtbar.

- **Termine** kommen aus der bestehenden Terminquelle (Abholung, Rückgabe/Rückholung,
  Lieferung): exakte Zeit, Zeitfenster oder „Zeit wird noch festgelegt“ – aus Fenstern wird nie
  eine Uhrzeit erfunden.
- **Abholadresse** (nur Selbstabholung): kanonisches Setting `pickup_exact_address`; nicht
  gepflegt ⇒ keine Adresse (Go-live-Datenpunkt). „Navigation öffnen“ nutzt die Phase-13-
  Linklogik (`navigationLinks`) – extern geht nur die Adresse, nie Name oder Vorgangsnummer.
- **Unterwegs**: `getCustomerTravelStatus(db, bookingId, now)` liefert `none | en_route`;
  das Portal zeigt bei `en_route` nur das Wort „Unterwegs“ (Polling alle 30 s über
  `GET /portal/bookings/:id/travel-status`). Kein GPS, keine Karte, kein ETA, kein Fahrername.
- **Profil vs. Snapshot**: Das Profil zeigt die aktuellen Stammdaten, die Buchung den
  eingefrorenen Snapshot. Hinweis im Profil: „Änderungen gelten für zukünftige Anfragen. Deine
  bereits bestätigte Buchung bleibt unverändert.“

## 6 Dokumente

Nur finalisierte, kundenrelevante Dokumente der sichtbaren Buchung: angenommene
Angebotsversion (genau `booking.offer_version_id`), freigegebene Auftragsbestätigung,
Lieferschein und Übergabeprotokoll finalisierter Übergaben, Rückgabeprotokoll – keine Entwürfe,
keine supersedeten Versionen. Download `GET /portal/bookings/:id/documents/:documentId`:
Server prüft Session, Zugehörigkeit der Buchung, Portal-Relevanz der Buchung, Zugehörigkeit
und Finalität des Dokuments; sonst 404. Private Ablage, Header `Cache-Control: private,
no-store`, `X-Content-Type-Options: nosniff`, korrekter MIME, sicherer Dateiname. Keine
Storage-Keys oder öffentlichen URLs im DTO.

## 7 Portalnachrichten (Chat)

- Nur zu einer bestätigten Buchung im Zustand `active`; abgeschlossen/storniert ⇒ bestehende
  Nachrichten lesbar (gemäß Retention), neue Nachrichten `409`.
- Kanal `conversation_channel = portal` der Phase-12-Konversation (gleiche Tabelle, gleiche
  Retention: Fotos beim Eintritt in abgeschlossen/storniert gelöscht, Text nach 12 Berliner
  Kalendermonaten). E-Mail- und WhatsApp-Historie erscheint nicht im Portal.
- Kunde: Text (max. 5000 Zeichen) + Bilder (JPEG/PNG/WebP, Magic-Byte-Prüfung, ≤ 8 MB, max.
  5 je Nachricht); PDF/SVG/sonstige Dateien werden abgelehnt. Absender immer aus der Session.
- Interne Benachrichtigung: Push `portal_message` an aktive Systemadmins und die effektiv
  zuständige Person des Vorgangs (Zuweisung + Vertretung) – Titel „Neue Kundennachricht –
  MR-…“, fester Body ohne Nachrichtentext, keine Fotovorschau.
- Staff-Antwort: bestehende Vorgangskommunikation, Kanal „Portal“, Recht
  `message.reply_customer`. Die Antwort wird als outbound-Portalnachricht gespeichert (sofort
  im Portal sichtbar) und löst eine separate E-Mail `customer_portal_reply_notice` („Du hast
  eine neue Nachricht von Miet-Royal.“ + fester Portal-Link) aus; scheitert die Mail, bleibt
  die Portalnachricht. Hinweis „Kundenportal aktiv“ zeigt, ob der Kunde eine gültige Session hat.

## 8 Rechnungsstatus

Anzeige nur `Offen | Bezahlt | Überfällig` aus `payment_status` der übertragenen Abrechnung
bzw. der kostenpflichtigen Stornierung; vor der Übertragung „Rechnung wird vorbereitet“, ohne
Abrechnung kein Status. Der finale Betrag erscheint erst, wenn die Abrechnung übertragen
(`locked_at`) ist. Nie: Buchhaltungsreferenz, Lexware-ID, Providerstatus, Übertragungsfehler,
Steuerkonfiguration, ungeprüfte Schadens-/Fehlteilpositionen. Es gibt kein eigenes
Rechnungs-PDF (Rechnung bleibt Lexware/`invoice_delivery`).

## 9 Kundenstorno

- Ausschließlich über den bestehenden `CancellationService` (Phase 9): `canceler_type =
  customer`, `canceler_staff_id = NULL`. Keine zweite Formel.
- Vorschau (`GET /portal/bookings/:id/cancellation/preview`): Eventdatum, verbleibende Tage,
  Prozentsatz (≥ 15 Tage 0 %, 7–14 Tage 50 %, 0–6 Tage 100 %), reguläre Maschinenmiet-Basis
  (Listenpreis vor Rabatt/Gutschein; ohne Lieferung, Kanister, Kommission), exakte Gebühr.
  Keine internen Freigaben, Zuordnungen oder Buchhaltungsdetails.
- Bestätigung bewusst: Dialog mit „Stornogebühr: X,XX €“ und Button „Buchung verbindlich
  stornieren“ (kein `confirm()`). Blocker (z. B. Übergabe abgeschlossen) ⇒ „Diese Buchung kann
  nicht mehr online storniert werden. Bitte kontaktiere uns.“ + Anruf-Button.
- Race Kunde/Mitarbeiter und Doppelklick ⇒ genau eine Stornierung (Sperren/Idempotenz des
  Services). Ressourcenfreigabe, Gutschein-Reaktivierung/-Verbrauch und der Buchhaltungspfad
  der Phase 9 bleiben unverändert.
- Bestätigungsmail (`cancellation_confirmation`) wird nach dem Kundenstorno automatisch über die
  Outbox eingereiht (idempotenter Schlüssel) und durch einen Backstop-Scanner nachgeholt; das
  Storno gilt auch, wenn die Mail scheitert.

## 10 Profil und Verifikation

- `/konto/profil`: privat – Vorname, Nachname, E-Mail, Telefon, Rechnungsadresse;
  Organisation – Organisationsname, Ansprechpartner, E-Mail, Telefon, Rechnungsadresse,
  USt-ID, Abteilung, Kostenstelle, Bestellreferenz. Nur bestehende CRM-Felder und -Validatoren;
  `type` nicht änderbar; E-Mail nicht löschbar.
- Jede Profilmutation verlangt eine Reauth, die höchstens 15 Minuten alt ist
  (`reauthenticated_at`; Login setzt sie). Sonst `403 PORTAL_REAUTH_REQUIRED` und die UI bietet
  „Änderung bestätigen“: Reauth-Magic-Link an die aktuelle Adresse, 15 min, one-time, an Kunde
  UND aktuelle Session gebunden; Consume nur mit derselben aktiven Session; verlängert die
  Session nicht.
- E-Mail-Wechsel: frische Reauth → neue Adresse (normalisiert, Eindeutigkeit gegen andere
  aktive Kunden) → Magic Link an die NEUE Adresse (15 min, one-time) → erst beim Consume wird
  `customers.email` geändert (Eindeutigkeit erneut unter Advisory-Lock geprüft, Race fail-closed).
  Danach: alle Portal-Sessions und offenen Links des Kunden widerrufen, Cookie gelöscht, UI
  „E-Mail-Adresse geändert. Bitte melde dich mit deiner neuen Adresse erneut an.“ Snapshots
  bleiben unverändert.

## 11 Demo

Das Portal funktioniert in `APP_ENV=demo` mit Demo-Banner, eigener Datenbank und eigenem
Storage; Mails nur an die Whitelist (`MAIL_DEMO_WHITELIST`) mit `[DEMO]`-Betreff. Die
Portal-Tabellen gehören zur Reset-Löschliste (Sessions, Magic Links inkl. offener
E-Mail-Wechsel); Staff-Auth und Training bleiben. Alle `/portal`-Mutationen (inkl. Login-
Consume) stehen unter Reset-Gate und Reset-Barrier (503 `DEMO_RESET` während eines Resets;
laufende Portal-Mutationen blockieren den Reset). Sessions und Magic Links sind pro Umgebung
isoliert (eigene DB, `__Host-`-Cookie je Host); der Link-Host kommt nur aus der festen
Konfiguration.

## 12 Sicherheitsgrenzen (Kurzliste)

Keine Enumeration · Token nur als Hash · Fragment statt Query · kein GET-Consume ·
`__Host-`-Cookie · absolute Session · Reauth für Mutationen · Session-Autorität statt Client-IDs ·
neutrale 404 · kundensichere DTOs (verbotene Felder per Test geprüft) · no-store/noindex ·
Same-Origin-Proxy statt CORS · Rate-Limits · keine Tokens/E-Mails in Logs · Demo-Gate/-Barrier.
Offene Go-live-Punkte: siehe OPEN_ITEMS („Phase 15“) und PRE_START_CHECKLIST („Production
mit Kundenportal“).
