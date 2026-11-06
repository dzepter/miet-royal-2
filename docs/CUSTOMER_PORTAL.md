# Kundenportal (Phase 15)

Stand: Phase 15 Final (2026-11-06) – Review-Fixes R1–R13 (2026-11-05) und Final-Korrektur
„bezahlte Buchung nach Reopen“ (Tests R15, 2026-11-06). Das Kundenportal ist der optionale
Kundenbereich unter `/konto` in der öffentlichen Web-App (`apps/web`). Es ist KEIN eigenes
Frontend-Projekt und KEIN eigenes Fachobjekt: Der `customers`-Datensatz bleibt die Identität,
das Portal ergänzt nur Authentifizierung (Magic Links, Sessions) und eine kundensichere Sicht auf
bestehende Fachdaten. Fachlogik (Preise, Storno, Konversation, Dokumente, Abrechnung) wird
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
  - **Body-Limit (Review R3):** Der Rewrite puffert Request-Bodies bis 13 MiB
    (`experimental.proxyClientMaxBodySize: 13 * 1024 * 1024` in `apps/web/next.config.ts`);
    der Next-Default von 10 MiB schnitt Foto-Nachrichten ohne Fehler ab. Kette: Client-
    Vorprüfung 8 MiB Rohbytes < API-Limit Portal-Chat 12 MiB ≤ Rewrite-Puffer 13 MiB; der
    vorgeschaltete Proxy muss für `/api/portal/` mindestens 13 MiB zulassen (nginx
    `client_max_body_size 13m;`, DEPLOYMENT_NOTES „Kundenportal“).
  - **Client-IP (Review R4):** Der Rewrite reicht ein vom Client gesendetes
    `X-Forwarded-For` unverändert weiter und hängt selbst nichts an. Web-Next und API sind
    deshalb NIE direkt erreichbar, der vorgeschaltete Proxy hängt die echte Client-IP an
    (`$proxy_add_x_forwarded_for`), `API_TRUST_PROXY_HOPS=1` (DEPLOYMENT_NOTES „Öffentliche
    Token-Links hinter Proxy“).
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
  (nie still einen Kunden wählen). Die Antwort ist IMMER identisch (`202`, Mindestdauer
  150 ms): „Wenn die E-Mail-Adresse bei uns hinterlegt ist, erhältst du gleich einen
  Anmeldelink.“ – keine Enumeration über Status, Body oder (praktisch) Zeit.
- Unter dem Kunden-Lock (siehe „Sperrreihenfolge“) liest `requestLogin` den Kunden frisch: Er
  muss noch aktiv sein UND noch genau die angefragte Adresse tragen, sonst entsteht kein Link
  (Rennen mit Papierkorb bzw. E-Mail-Wechsel; Review R6/R9). Ein Link an eine gerade
  abgelöste Adresse ist damit ausgeschlossen.
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
  Kunden. Der Login-Consume (Verbrauch, Session-Anlage, Audit) läuft in EINER Transaktion
  unter dem Kunden-Lock (Review R6).
- Link-Format: `MAIL_PUBLIC_WEB_BASE_URL + /konto/anmelden#token=<TOKEN>`. Der Token steht
  NUR im URL-Fragment: Browser senden Fragmente nie an den Server, Mail-Scanner und Proxys
  können den Link nicht per GET verbrauchen. Die Seite liest das Fragment, entfernt es sofort
  per `history.replaceState`, hält den Token nur im Speicher und sendet ihn erst beim Klick auf
  „Kundenbereich öffnen“ per `POST /portal/auth/consume`. Es gibt kein GET-Consume.
- Die Basis-URL kommt ausschließlich aus `MAIL_PUBLIC_WEB_BASE_URL`; Host-Header,
  `X-Forwarded-Host`, Query oder Body haben keinen Einfluss (kein Host-Header-Poisoning).
- **HTTP-Rate-Limits** (`@fastify/rate-limit` bzw. In-Memory-Fenster, je API-Prozess):
  - `POST /portal/auth/request`: 10/min je IP + nicht rückrechenbarem Hash der normalisierten
    Adresse, zusätzlich 30/min je IP.
  - `POST /portal/auth/consume`, `/portal/auth/reauth/consume`,
    `/portal/auth/email-change/consume`: 10/min je IP.
  - `POST /portal/auth/reauth/request`, `/portal/auth/email-change/request`: 5 je 15 min je
    IP + Hash des Sessiontokens.
- **DB-Versanddrossel (Review R4):** unabhängig von IP und `X-Forwarded-For` höchstens 5
  erzeugte Links je 15 min (`PORTAL_LINK_THROTTLE_MAX`, `PORTAL_LINK_THROTTLE_WINDOW_MS` in
  `apps/api/src/portal/auth/constants.ts`) – Login und E-Mail-Wechsel je Kunde, Reauth je
  Session. Gezählt werden alle im Fenster erzeugten Zeilen des Zwecks (auch verbrauchte und
  widerrufene); Zählung und Anlage laufen unter dem Kunden-Lock und sind damit exakt. Darüber
  passiert still nichts: kein Link, kein Widerruf älterer Links, keine Mail; die Antwort bleibt
  unverändert neutral, das Log nennt nur `portal.magic_link.skipped` mit `reason: 'throttled'`
  (ohne Adresse). Die Drossel ist die zweite Verteidigungslinie gegen Mailbombing, falls die
  IP-Limits hinter einem falsch konfigurierten Proxy nicht greifen. Bekannte Nebenwirkung: Wer
  eine Adresse kennt, kann das Login-Kontingent dieses Kunden verbrauchen; der jüngste bereits
  versandte Link des Kunden bleibt gültig (OPEN_ITEMS „Phase 15“).
- **Sperrreihenfolge (Review R6):** Die Link-Anforderungen (Login, Reauth, E-Mail-Wechsel),
  Login- und E-Mail-Wechsel-Consume sowie die Papierkorb-Löschung nehmen ZUERST den
  Transaktions-Lock je Kunde (`lockPortalCustomerAuth` in `apps/api/src/portal/auth/locks.ts`,
  `pg_advisory_xact_lock` auf `portal-customer-auth:<customerId>`). Den Adress-Lock des
  E-Mail-Wechsels (`portal-email-change:<adresse>`) nimmt danach nur der E-Mail-Wechsel-Consume;
  erst dann folgen Link-/Session-Zeilen und die `customers`-Zeile. Logout und Reauth-Consume
  laufen ohne diese Locks (Einzelstatements ohne Transaktion, kein Deadlock möglich). Folge:
  nie zwei offene E-Mail-Wechsel-Links, parallele Consumes desselben Kunden warten aufeinander
  statt sich zu verklemmen (vorher Deadlock 40P01 ⇒ 500).

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
- **Papierkorb (Review R9):** `CustomerService.moveToTrash` widerruft in derselben Transaktion
  (zuerst der Kunden-Lock) alle Portal-Sessions und offenen Magic Links des Kunden. Eine
  Wiederherstellung belebt sie nicht – der Kunde meldet sich neu an. Für diesen Widerruf wird
  kein Security-Event geschrieben (OPEN_ITEMS „Phase 15“).
- Cleanup: abgelaufene/widerrufene Sessions und verbrauchte/abgelaufene Links werden vom
  bestehenden `communication.scan_due`-Lauf gelöscht (Scanner `portal_auth_cleanup`), keine
  neue Scheduler-Infrastruktur.

## 4 Sichtbarkeitsregel (CustomerPortalVisibilityPolicy)

Einzige Stelle: `apps/api/src/portal/visibility.ts`. Eine Buchung erscheint nur mit echter
`bookings`-Zeile des Kunden (Anfrage, Angebotsentwurf oder nur versendetes Angebot sind
keine Portalbuchung); Buchung UND Vorgang müssen dem Kunden gehören. Danach gilt eine feste
Reihenfolge A → B → C (Review R1; Phase 15 Final-Korrektur, 2026-11-06):

- **A – Stornozeile** (`cancellations` der Buchung) vorhanden ⇒ ausschließlich die
  Storno-Regeln, unabhängig vom Vorgangsstatus (auch nach Reopen).
- **B – reguläre Abrechnung final bezahlt** (keine Stornozeile, `settlements.locked_at` gesetzt
  UND `settlements.payment_status = 'paid'`) ⇒ IMMER unsichtbar, unabhängig vom Vorgangsstatus:
  `completed`, `reopened` und auch ein wieder auf `open` gesetzter Vorgang.
- **C – erst danach der Vorgangsstatus**: `open`/`reopened` ⇒ `active`, `completed` ⇒
  `completed_open` (final bezahlt ist bereits durch B unsichtbar), `cancelled` ⇒ unsichtbar.

| Regel | Lage | Bedingung | Portalzustand |
| --- | --- | --- | --- |
| A | Stornozeile vorhanden (jeder Vorgangsstatus, auch nach Reopen) | Gebühr 0 €, Kundenstorno, höchstens 24 h alt | nur Bestätigungsansicht `cancelled_free` („Storniert“) über die Detailroute und die Antwort des Storno-POST; nie in der Liste |
| A | Stornozeile vorhanden | Gebühr 0 €, Staff-Storno oder älter als 24 h | unsichtbar |
| A | Stornozeile vorhanden | Gebühr > 0 € und Finanzstatus ≠ `paid` | `cancelled_fee` („Storniert – Stornogebühr“) |
| A | Stornozeile vorhanden | Gebühr > 0 € und Finanzstatus `paid` | unsichtbar |
| B | ohne Stornozeile, jeder Vorgangsstatus (`completed`, `reopened`, `open`) | Abrechnung übertragen (`locked_at` gesetzt) UND Zahlungsstatus `paid` | unsichtbar |
| C | `open` / `reopened` | Abrechnung fehlt, nicht übertragen (`locked_at` NULL), oder Zahlungsstatus `open`/`overdue`/unbekannt | `active` („Bestätigte Buchung“) |
| C | `completed` | Abrechnung fehlt, nicht übertragen (`locked_at` NULL), oder Zahlungsstatus `open`/`overdue`/unbekannt | `completed_open` („Abgeschlossen – Rechnung offen“) |
| C | `cancelled` ohne Stornozeile | immer | unsichtbar |

- **Reopen ist ein interner Arbeitsstatus (Phase 15 Final-Korrektur, 2026-11-06):** Ein Reopen
  ist keine Reaktivierung einer finanziell abgeschlossenen Kundenbuchung. Er macht keine alte
  bezahlte Vermietung wieder aktiv, bucht keine alte Maschine wieder, macht den alten Snapshot
  nicht wieder kundenaktuell, den alten Chat nicht wieder beschreibbar (§7) und keine alte Tour
  wieder aktiv. Ein neuer Mietvorgang ist eine neue Buchung bzw. ein neuer Vorgang. Es gibt
  keine Portal-Historie über Reopen (MASTER_SPEC §26 „Keine alte Buchungshistorie“). Vorher
  erschien ein abgeschlossener, final bezahlter Vorgang nach einem Reopen wieder als
  „Bestätigte Buchung“, weil `reopened` ⇒ `active` vor der Zahlungsprüfung entschieden wurde.
  Weil jede Portalroute über die Policy auflöst, gilt Regel B für Liste, Detailroute und alle
  Unterrouten (neutrales 404). Nicht final bezahlte Lagen bleiben nach einem Reopen sichtbar
  (`active`): Zahlungsstatus `open`, `overdue` oder unbekannt, Abrechnung nicht übertragen. Tests:
  `apps/api/test/portal-review-reopen.integration.test.ts`, R15-1 … R15-10, R15-2b, R15-4b
  (TEST_PLAN „Kundenportal (Phase 15)“).
- **Reopen nach Storno (Review R1):** Ein wiedereröffneter Vorgang macht die stornierte
  Buchung nie wieder `active` (Phase 9: die alte Buchung wird nicht reaktiviert). Der Reopen
  löscht die Stornozeile nicht (er setzt nur `reopened_at`); Zustand, Storno-Block, Gebühr und
  Rechnungsstatus kommen weiter aus ihr (Tabelle oben). Ein 0-€-Staff-Storno bleibt nach dem
  Reopen unsichtbar. Ein 0-€-Kundenstorno zeigt auch nach einem Reopen innerhalb von 24 h nur
  die Bestätigungsansicht (Detailroute bzw. Storno-POST) und ist danach unsichtbar. Regel A hat
  Vorrang vor Regel B: Für eine stornierte Buchung zählt nur die Stornozeile, nie eine Abrechnung.
  Tests: R1 „Zustandsfunktion“ (alle Vorgangsstatus, auch Kundenstorno 0 €), R1 „Reopen nach
  0-€-Storno“ (Staff-Storno), R15-6 (Storno + Reopen, Storno-Regeln unverändert).
- **24-h-Bestätigungsfenster (Review R12):** gilt NUR für einen kostenfreien KUNDENstorno und
  NUR für `GET /portal/bookings/:id` und `POST /portal/bookings/:id/cancellation` (wiederholter
  Klick ⇒ idempotente Bestätigungsansicht). Dokumente, Dokument-Download, Storno-Vorschau,
  Travel-Status, Nachrichten und Fotos antworten in dieser Lage 404. Ein kostenfreier
  Staff-Storno ist sofort unsichtbar (auch Detailroute und Storno-POST 404). Die Web-
  Detailseite (`apps/web/app/konto/buchung/[id]/page.tsx`) zeigt bei `cancelled_free` weiter
  die Buchungsansicht aus dem Snapshot (Event, Maschinen & Extras, Termine, Abholung bzw.
  Lieferung, Preis) mit dem Storno-Block, aber ohne Dokument-, Nachrichten- und Storno-Bereich;
  der Rechnungsbereich entfällt, weil der Status bei 0 € „keine Rechnung“ ist. Für jede
  stornierte Buchung gilt: Termine erscheinen als „entfällt“; gibt es keine, entfällt der
  Termine-Bereich (kein „Die Termine stimmen wir noch mit dir ab.“).

0 Buchungen ⇒ „Neue Anfrage starten“; 1 ⇒ direkt die Übersicht; mehrere ⇒ Liste „Aktuelle
Buchungen“, sortiert nach nächstem Eventdatum, dann Vorgangsnummer. Es gibt KEINE Historien-
oder Archivroute („No-history“-Entscheidung, MASTER_SPEC §26). Ein manuell abgeschlossener
Vorgang ohne Abrechnung bleibt dauerhaft `completed_open`, denn Regel B greift erst mit einer
übertragenen UND bezahlten Abrechnung (offener Fachpunkt, OPEN_ITEMS „Phase 15“).

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
  Nur Lieferungen einer `active` Buchung können „unterwegs“ sein.
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
Storage-Keys oder öffentlichen URLs im DTO. Liste und Download lösen ohne
Bestätigungsfenster auf: Nach einem kostenfreien Kundenstorno antworten beide 404 (Review R12).

## 7 Portalnachrichten (Chat)

- Neue Nachrichten nur zu einer bestätigten Buchung im Zustand `active`. Bei `completed_open`
  und `cancelled_fee` bleiben bestehende Nachrichten lesbar (gemäß Retention, `canSend:
  false`), eine neue Nachricht ⇒ `409 PORTAL_BOOKING_CLOSED`. Nach einem kostenfreien Storno
  (`cancelled_free`) antworten Nachrichten und Fotos 404 – für den Chat gibt es kein
  Bestätigungsfenster. Die Web-Detailseite lädt den Nachrichtenbereich nach einem Storno neu
  (dann Hinweis statt Formular) bzw. blendet ihn bei `cancelled_free` ganz aus. Eine nach §4
  unsichtbare Buchung (z. B. final bezahlt, auch nach einem Reopen) hat im Portal keinen Chat:
  Nachrichten und Fotos antworten 404.
- Kanal `conversation_channel = portal` der Phase-12-Konversation (gleiche Tabelle, gleiche
  Retention: Fotos beim Eintritt in abgeschlossen/storniert gelöscht, Text nach 12 Berliner
  Kalendermonaten). E-Mail- und WhatsApp-Historie erscheint nicht im Portal.
- Kunde: Text (max. 5000 Zeichen) + Bilder (JPEG/PNG/WebP, Magic-Byte-Prüfung, ≤ 8 MB, max.
  5 je Nachricht); PDF/SVG/sonstige Dateien werden abgelehnt. Absender immer aus der Session.
  Body-Limit der Route 12 MiB, Rate-Limit 20 Nachrichten/min je IP + Hash des Sessiontokens.
- Foto-Auslieferung `GET /portal/bookings/:id/messages/:messageId/photos/:photoId`: privat,
  `Cache-Control: private, no-store`, `nosniff`, `inline` und zusätzlich
  `Content-Security-Policy: default-src 'none'; sandbox` (Defense in Depth gegen Polyglot-
  Dateien mit gültigen Bild-Magic-Bytes). Dokument-PDFs bekommen diese Policy bewusst nicht.
- Interne Benachrichtigung: Push `portal_message` an aktive Systemadmins und die effektiv
  zuständige Person des Vorgangs (Zuweisung + Vertretung) – Titel „Neue Kundennachricht –
  MR-…“, fester Body ohne Nachrichtentext, keine Fotovorschau.
- Staff-Antwort: bestehende Vorgangskommunikation, Kanal „Portal“, Recht
  `message.reply_customer`. Die Antwort wird als outbound-Portalnachricht gespeichert (sofort
  im Portal sichtbar) und löst eine separate E-Mail `customer_portal_reply_notice` („Du hast
  eine neue Nachricht von Miet-Royal.“ + fester Portal-Link) aus; scheitert die Mail, bleibt
  die Portalnachricht. Hinweis „Kundenportal aktiv“ zeigt, ob der Kunde eine gültige Session hat.
- **Staff-Portalantwort gesperrt bei Stornozeile oder final bezahlter Abrechnung (Review R1;
  Phase 15 Final-Korrektur, 2026-11-06):** Möglich nur bei Vorgang `open`/`reopened` mit
  Buchung, OHNE Stornozeile der Buchung UND ohne final bezahlte Abrechnung (`locked_at`
  gesetzt und `payment_status = 'paid'`). `ConversationService.replyByPortal` prüft das unter
  der Vorgangssperre und antwortet sonst `409` („Zu diesem Vorgang ist keine Portalnachricht
  möglich.“) – ohne Nachricht und ohne Hinweis-Mail; die Staff-Ansicht liefert
  `canReplyPortal = false` (`portal/chat/staff-hints.ts`), das Radio „Portal“ erscheint dann
  nicht. Beide nutzen dasselbe Prädikat wie die Policy (`isSettlementFinallyPaid`). Die
  E-Mail-Antwort bleibt möglich.
  - **Stornozeile:** gesperrt auch nach einem Reopen und in beiden Fällen: 0 € (der Kunde sieht
    die Buchung nicht) und kostenpflichtig (der Kunde kann nur lesen). **Fachentscheidung
    bestätigt (2026-11-06):** Ein Reopen reaktiviert den Portal-Chat einer stornierten Buchung
    nie – auch nicht bei kostenpflichtigem Storno. Tests R1, R15-7.
  - **Final bezahlte Abrechnung:** gesperrt wie bei einer Stornozeile, auch nach einem Reopen.
    Die Buchung ist nach §4 Regel B unsichtbar; Portalnachricht und Hinweis-Mail würden auf
    eine Buchung verweisen, die der Kunde nicht öffnen kann. Test R15-2b.
- **Portalnachricht und Abrechnungsklärung (Entscheidung 2026-11-06):** Eine Portalnachricht
  zählt NIE automatisch als „Kundenantwort“ einer Abrechnungsklärung (Schaden-/Fehlteil-
  Vorinformation, DOMAIN_RULES). Die Mitarbeitenden sehen sie in der Vorgangskommunikation und
  entscheiden manuell, ob sie die Kundenantwort erfassen; der Portalchat ändert die Abrechnung
  nie automatisch. Test R15-8.

## 8 Rechnungsstatus

Quelle `apps/api/src/portal/invoice-status.ts`; Labels „Offen“, „Bezahlt“, „Überfällig“,
„Rechnung wird vorbereitet“, „Keine Rechnung vorhanden“ (das Web blendet den Rechnungsbereich
bei „keine Rechnung“ aus).

- **Stornozeile vorhanden** (unabhängig vom Vorgangsstatus, auch nach Reopen – Review R1):
  Status ausschließlich aus der Stornozeile, nie aus einer Abrechnung der stornierten Buchung.
  0 € ⇒ keine Rechnung; kostenpflichtig: `no_invoice` ⇒ keine Rechnung, `accounting_pending`
  ⇒ „Rechnung wird vorbereitet“ ohne Betrag, `invoice_open` ⇒ „Offen“ bzw. „Überfällig“
  (Zahlungsstatus des Stornos), `paid` ⇒ „Bezahlt“ (die Buchung ist dann nach §4 allerdings
  unsichtbar). Finaler Betrag (= Stornogebühr) nur bei `invoice_open` und `paid`.
- **Ohne Abrechnung**: aktive Buchung ⇒ keine Rechnung; abgeschlossener Vorgang
  (`completed_open`) ⇒ „Rechnung wird vorbereitet“ (Review R13 – nie „Keine Rechnung
  vorhanden“ neben „Abgeschlossen – Rechnung offen“).
- **Abrechnung vorhanden, nicht übertragen** (`locked_at` NULL) ⇒ „Rechnung wird
  vorbereitet“, ohne Betrag.
- **Übertragen** (`locked_at` gesetzt) ⇒ Status aus `payment_status` (NULL ⇒ „Offen“), finaler
  Betrag `amount_due_cents`. Bei `paid` ist die Buchung nach §4 Regel B allerdings unsichtbar –
  unabhängig vom Vorgangsstatus, auch nach einem Reopen.
- Der Portalchat ändert weder Abrechnung noch Rechnungsstatus; eine Portalnachricht ist nie
  automatisch die Kundenantwort einer Abrechnungsklärung (§7, Entscheidung 2026-11-06).

Nie: Buchhaltungsreferenz, Lexware-ID, Providerstatus, Übertragungsfehler,
Steuerkonfiguration, ungeprüfte Schadens-/Fehlteilpositionen. Es gibt kein eigenes
Rechnungs-PDF (Rechnung bleibt Lexware/`invoice_delivery`).

## 9 Kundenstorno

- Ausschließlich über den bestehenden `CancellationService` (Phase 9): `canceler_type =
  customer`, `canceler_staff_id = NULL`. Keine zweite Formel.
- Vorschau (`GET /portal/bookings/:id/cancellation/preview`): Eventdatum, verbleibende Tage,
  Prozentsatz (≥ 15 Tage 0 %, 7–14 Tage 50 %, 0–6 Tage 100 %), reguläre Maschinenmiet-Basis
  (Listenpreis vor Rabatt/Gutschein; ohne Lieferung, Kanister, Kommission), exakte Gebühr
  (Cent). Keine internen Freigaben, Zuordnungen oder Buchhaltungsdetails.
- Bestätigung bewusst: Dialog mit „Stornogebühr: X,XX €“ und Button „Buchung verbindlich
  stornieren“ (kein `confirm()`). Blocker (z. B. Übergabe abgeschlossen) ⇒ „Diese Buchung kann
  nicht mehr online storniert werden. Bitte kontaktiere uns.“ + Anruf-Button.
- **Body und Gebührenbindung (Review R2):** `POST /portal/bookings/:id/cancellation` verlangt
  `{ "confirm": true, "expectedFeeCents": <Cent> }` (`strictObject`; `expectedFeeCents`
  ganzzahlig 0 … 100 000 000, Pflicht – sonst 400 ohne Wirkung). Der Wert ist nur Prüfwert,
  nie Autorität: Der Service berechnet die Gebühr unter der Prozesssperre neu und vergleicht
  sie VOR jeder Schreiboperation; bei Abweichung (z. B. Vorschau vor, Bestätigung nach der
  Berliner Mitternacht) ⇒ `409 PORTAL_CANCELLATION_FEE_CHANGED` „Die Stornogebühr hat sich
  inzwischen geändert. Bitte prüfe den neuen Betrag und bestätige erneut.“, nichts storniert.
  Prüfreihenfolge: fremde/unsichtbare Buchung 404 → Body 400 → bereits storniert ⇒
  idempotente Bestätigungsansicht (Prüfwert ignoriert) → nicht `active` bzw. Blocker ⇒ 409
  `PORTAL_CANCELLATION_BLOCKED` → Gebühr geändert ⇒ 409 `PORTAL_CANCELLATION_FEE_CHANGED`.
- **Web:** Der Dialog sendet als `expectedFeeCents` genau den angezeigten Betrag
  (`preview.feeCents ?? 0`). Bei `409 PORTAL_CANCELLATION_FEE_CHANGED` lädt die Seite die
  Vorschau neu, zeigt im offenen Dialog den neuen Betrag mit dem Hinweis und aktiviert den
  Button wieder; jede andere 409 schließt den Dialog und zeigt Blocker-Text + Anrufen.
- **Rate-Limit (Review R5):** 10 Storno-POSTs je Minute und Session (Schlüssel = Hash des
  Sessiontokens, ohne Cookie die IP; unabhängig von `X-Forwarded-For`), danach 429.
- Race Kunde/Mitarbeiter und Doppelklick ⇒ genau eine Stornierung (Sperren/Idempotenz des
  Services). Ressourcenfreigabe, Gutschein-Reaktivierung/-Verbrauch und der Buchhaltungspfad
  der Phase 9 bleiben unverändert.
- **Bestätigungsmail** (`cancellation_confirmation`): wird nach dem Kundenstorno automatisch
  über die Outbox eingereiht (idempotenter Schlüssel `cancellation_confirmation:<id>`) und
  durch den Backstop-Scanner `portal_cancellation_mail_backstop` nachgeholt (Status `prepared`
  älter als 2 min, höchstens 50 je Lauf, wiedereröffnete Vorgänge ausgenommen); das Storno
  gilt auch, wenn die Mail scheitert.
  - Empfänger (Review R11): bei Kundenstorno die AKTUELLE `customers.email` des aktiven
    Kunden (z. B. nach einem verifizierten E-Mail-Wechsel), ohne aktuelle Adresse Rückfall auf
    den Snapshot; die Anrede kommt weiter aus dem Snapshot. Staff-Stornos und der Snapshot
    selbst bleiben unverändert.
  - Nachreihen (Review R5): Ein wiederholter Klick oder ein paralleler Aufruf reiht nur nach,
    solange die Bestätigung des Kundenstornos noch `prepared` ist (nie eingereiht). Nach
    `failed`/`blocked` erzeugt ein weiterer Klick keine neue Zustellung – ein erneuter Versand
    bleibt eine bewusste Staff-Aktion.
- Nach dem Storno zeigt die Seite die Bestätigungsansicht (Storno-Block mit Gebühr, bei
  Gebühr > 0 € „Rechnung folgt“). Kostenfrei ⇒ Buchungsansicht mit Storno-Block, aber ohne
  Dokument-, Nachrichten- und Storno-Bereich, höchstens 24 h über die Detailroute erreichbar
  und nie im Dashboard (§4).

## 10 Profil und Verifikation

- `/konto/profil`: privat – Vorname, Nachname, E-Mail, Telefon, Rechnungsadresse;
  Organisation – Organisationsname, Ansprechpartner, E-Mail, Telefon, Rechnungsadresse,
  USt-ID, Abteilung, Kostenstelle, Bestellreferenz. Nur bestehende CRM-Felder und -Validatoren;
  `type` nicht änderbar; E-Mail nicht löschbar und nicht über das Profil änderbar. Der
  Profil-PATCH (`CustomerService.updateCustomerFromPortal`) schreibt `email` und `type` nie
  mit – ein parallel bestätigter E-Mail-Wechsel kann nicht überschrieben werden (kein Lost
  Update, Review R7).
- Jede Profilmutation verlangt eine Reauth, die höchstens 15 Minuten alt ist
  (`reauthenticated_at`; Login setzt sie). Sonst `403 PORTAL_REAUTH_REQUIRED` und die UI bietet
  „Änderung bestätigen“: Reauth-Magic-Link an die aktuelle Adresse, 15 min, one-time, an Kunde
  UND aktuelle Session gebunden; Consume nur mit derselben aktiven Session; verlängert die
  Session nicht.
- **E-Mail-Wechsel-Anforderung** (`POST /portal/auth/email-change/request`): frische Reauth
  (sonst 403 `PORTAL_REAUTH_REQUIRED`) → neue Adresse (normalisiert; ungültiges Format ⇒ 400,
  die eigene aktuelle Adresse ⇒ 400 `PORTAL_EMAIL_UNAVAILABLE`) → unter dem Kunden-Lock zuerst
  die Drossel (5 je 15 min je Kunde; darüber still nichts), dann werden ältere offene
  Wechsel-Links widerrufen – bei freier wie bei belegter Adresse.
  - Antwort IMMER neutral (Review R8): `202` „Wenn die Adresse verwendet werden kann, erhältst
    du dort gleich einen Bestätigungslink.“, mit derselben Mindestdauer von 150 ms wie die
    Login-Anforderung – auch wenn die Adresse einem ANDEREN aktiven Kunden gehört (kein
    Existenz-Orakel). Die Web-Profilseite zeigt nach 2xx immer genau diesen Text.
  - Freie Adresse ⇒ Magic Link an die NEUE Adresse (15 min, one-time).
  - Belegte Adresse ⇒ kein Link, keine Mail. Stattdessen entsteht eine nie versandte, sofort
    widerrufene Platzhalterzeile `email_change` (zufälliger Token-Hash, Token verlässt den
    Server nie, nicht konsumierbar). Sie verbraucht das Drosselkontingent genau wie eine freie
    Anforderung, damit die Drossel nicht verrät, ob die Adresse vergeben ist. Wegen des
    CHECK-Constraints trägt sie die angefragte Adresse in `proposed_email`, bis der Cleanup sie
    löscht (1 Tag nach Widerruf; Demo-Reset sofort) – OPEN_ITEMS „Phase 15“.
- **E-Mail-Wechsel-Consume**: Kunden-Lock → Adress-Lock → atomarer Verbrauch des Links →
  anfordernde Session muss noch gültig sein → Eindeutigkeit ERNEUT geprüft (belegt ⇒ fail-closed
  `409 PORTAL_EMAIL_UNAVAILABLE`, Adresse unverändert) → erst jetzt wird `customers.email`
  geändert. Kein Cookie nötig (Bestätigung auf einem anderen Gerät möglich). Danach: alle
  Portal-Sessions und offenen Links des Kunden widerrufen, Cookie gelöscht, UI „E-Mail-Adresse
  geändert. Bitte melde dich mit deiner neuen Adresse erneut an.“ Snapshots bleiben
  unverändert. Ein Login-Link an die alte Adresse entsteht danach nicht mehr (§2).

## 11 Demo

Das Portal funktioniert in `APP_ENV=demo` mit Demo-Banner, eigener Datenbank und eigenem
Storage; Mails nur an die Whitelist (`MAIL_DEMO_WHITELIST`) mit `[DEMO]`-Betreff. Die
Portal-Tabellen gehören zur Reset-Löschliste (Sessions, Magic Links inkl. offener
E-Mail-Wechsel); zusätzlich löscht der Reset in derselben Transaktion die Portal-Auth-
Ereignisse `staff_security_events` mit `type LIKE 'portal.%'` (Zähler
`staff_security_events:portal` im Reset-Ergebnis; Review R10). Staff-Auth, übrige Staff-
Ereignisse und Training bleiben. Alle `/portal`-Mutationen (inkl. Login-Consume) stehen unter
Reset-Gate und Reset-Barrier (503 `DEMO_RESET` während eines Resets; laufende Portal-Mutationen
blockieren den Reset). Sessions und Magic Links sind pro Umgebung isoliert (eigene DB,
`__Host-`-Cookie je Host); der Link-Host kommt nur aus der festen Konfiguration.

Hinweis Schulung: Die DB-Drossel (§2) gilt auch in der Demo. Teilen sich mehrere Teilnehmende
denselben Übungskunden, erzeugen höchstens 5 Login-Anforderungen je 15 min eine Mail; weitere
bleiben still ohne Link (Antwort trotzdem neutral). Für parallele Portal-Übungen verschiedene
Übungskunden verwenden (ENVIRONMENTS „Demo-Mail“).

## 12 Sicherheitsgrenzen (Kurzliste)

Keine Enumeration (auch nicht beim E-Mail-Wechsel) · Token nur als Hash · Fragment statt Query
· kein GET-Consume · `__Host-`-Cookie · absolute Session · Reauth für Mutationen ·
Session-Autorität statt Client-IDs · neutrale 404 · kundensichere DTOs (verbotene Felder per
Test geprüft) · no-store/noindex · Same-Origin-Proxy statt CORS · Rate-Limits plus DB-
Versanddrossel unabhängig von `X-Forwarded-For` · feste Sperrreihenfolge Kunde → Adresse ·
Papierkorb widerruft Sessions und Links · Proxy-Body-Limit 13 MiB · Foto-CSP
`default-src 'none'; sandbox` · keine Tokens/E-Mails in Logs · Demo-Gate/-Barrier.
Offene Go-live-Punkte: siehe OPEN_ITEMS („Phase 15“) und PRE_START_CHECKLIST („Production
mit Kundenportal“).
