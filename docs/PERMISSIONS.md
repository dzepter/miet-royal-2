# PERMISSIONS — Granulares Rechtesystem

## Prinzip
Keine festen A/B/C-Rollen als einzige Wahrheit.
Admin vergibt granulare Rechte; Rollen nur Vorlagen.
Änderungen sofort wirksam und serverseitig geprüft.

## Beispielrechte
### Vorgänge
`process.view_all`, `process.create`, `process.reassign`, `process.reopen_completed`

### Kunden
`customer.view`, `customer.create`, `customer.edit`

### Angebot
`offer.create`, `offer.edit_draft`, `offer.send`,
`offer.create_new_version`, `offer.change_price`,
`offer.apply_discount`, `offer.apply_special_price`

### Rabatte
`discount.up_to_10`, `discount.over_10_with_reason`,
`discount.over_20_request`, `discount.over_20_approve`

Wiedermieter-Gutschein (Phase 11): KEINE neuen Rechte. Anwenden/Entfernen im
Entwurf (`POST`/`DELETE /staff/offer-versions/:id/voucher`) = `offer.edit_draft`;
kein `discount.*` (der 20-%-Gutschein ist kein manueller Rabatt, keine
>10-%-Begründung, keine >20-%-Freigabe). Kundenprofil-Karte = `customer.view`,
Vorgangszeile = `process.view_all`. Automatische Erzeugung ohne Recht (Job).
Kein `voucher.*`, keine Erstellungs-/Verlängerungs-/Übertragungs-/Löschrechte.

### Buchung/Kalender
`booking.confirm`, `booking.cancel`,
`calendar.view_all`, `calendar.drag_drop`,
`appointment.assign`, `appointment.reassign_same_day`

Kontrollierte Phase-4-Ergänzungen (keine zweite Rechtearchitektur):
`calendar.view` (Basiszugang: „Heute“, eigene Termine, Übernahme
bestätigen, Konflikt als gelöst markieren),
`calendar.manage` (Termine intern abschließen),
`substitution.manage` (Vertretungen anlegen/beenden)

### Maschinen
`machine.view`, `machine.assign`, `machine.change_status`,
`machine.block`, `machine.override_block`, `machine.replace_reference_photo`

Kontrollierte Phase-5-Ergänzungen (keine zweite Rechtearchitektur):
`machine.manage` (Stammdaten pflegen, neue Maschine anlegen),
`machine.change_location` (aktuellen Standort ändern),
`machine.qr` (QR-Code anzeigen/drucken)

Kontrollierte Phase-7-Ergänzung:
`machine.clean_complete` (Reinigung abschließen: „Gereinigt & einsatzbereit“,
🟡 Reinigung → 🟢 Einsatzbereit mit internem Reinigungs-Metadatensatz)

### Lager
`inventory.view`, `inventory.add_stock`, `inventory.issue`,
`inventory.return`, `inventory.count`, `inventory.approve_adjustment`,
`inventory.view_movement_history`

Kontrollierte Phase-5-Ergänzung:
`inventory.manage_min_stock` (Mindestbestände festlegen)

### Ausgabe/Rückgabe
`handover.perform`, `handover.correct_actual_time`,
`return.perform`, `return.correct_actual_time`, `return.mark_cleanup_issue`

Kontrollierte Phase-6-Ergänzungen (keine zweite Rechtearchitektur):
`handover.view` (Ausgabe-Bereich, Übergabe-/Lieferschein-Dokumente ansehen),
`handover.prepare` (Ausgabe vorbereiten: Vorbereitung, Abholperson),
`delivery_note.edit` (Ausgabemengen und Zusatzpositionen vor Finalisierung).
Wiederverwendet: `machine.assign` (konkrete Maschine zuordnen/lösen),
`machine.override_block` (Problemmaschinen-Override, Override-Liste),
`handover.perform` (Übergabe durchführen und final abschließen – schließt
die Lagerausgabe des Übergabeprozesses ein), `machine.block`
(Risiko-Incident „Geprüft“).

Kontrollierte Phase-7-Ergänzungen (keine zweite Rechtearchitektur):
`return.view` (Rückgabe-Bereich, Rückgabe-Detail und Rückgabeprotokoll
ansehen), `return.complete` (Rückgabe final abschließen – schließt die
Lagerrücknahme des Rückgabeprozesses ein; `inventory.return` bleibt für
die manuelle Rücknahme außerhalb einer Rückgabe reserviert).
Wiederverwendet: `return.perform` (Rückgabe starten und bearbeiten:
Rückgabeperson, Maschinen bestätigen, Zubehör- und Sauberkeitskontrolle,
Kommissionsrückgabe, Beweisfoto, Unterschriften), `return.mark_cleanup_issue`
(Maschine als nicht ordnungsgemäß vorbereitet markieren → Reinigungsgebühr-
Fakt), `return.correct_actual_time` (tatsächliche Rückgabezeit vor und nach
der Finalisierung korrigieren), `machine.change_status` (technischen Defekt
nach Rückgabe erfassen, Hinweis „ggf. in Reparatur setzen“).

### Schäden/Fehlteile
`damage.document`, `damage.set_cost`, `damage.edit_cost_before_lexware`,
`missing_item.create`, `missing_item.set_cost`, `missing_item.resolve`

Kontrollierte Phase-7-Ergänzung (keine zweite Rechtearchitektur):
`damage.resolve_current` (aktuellen Maschinenschaden als „nicht mehr
aktuell“ markieren – historische Daten und Protokolle bleiben unverändert).
Wiederverwendet: `damage.document` (Schaden bei Rückgabe und nachträgliche
Feststellung inkl. Fotos/Markierungen), `missing_item.create` (Fehlteil
anlegen), `missing_item.resolve` („Fehlteil erledigt“).

### Abrechnung
`settlement.view`, `settlement.add_manual_charge`, `settlement.release`,
`settlement.end_pre_notice_wait`, `lexware.manual_transfer`

Kontrollierte Phase-9-Ergänzung (keine zweite Rechtearchitektur):
`accounting.view_reference` (externe Buchhaltungsreferenz/Belegnummer einer
Übertragung einsehen – ohne dieses Recht sieht die Oberfläche nur den
Übertragungsstatus). Wiederverwendet in Phase 9: `settlement.view`
(ABRECHNUNG-Bereich, Klärungen, Zahlungsstatus), `settlement.add_manual_charge`
(manuelle Nachbelastung/Verspätungsgebühr, Position ändern/entfernen),
`settlement.release` (Kundeninformation freigeben, „wie berechnet freigeben“,
manuelle Übertragung auslösen), `settlement.end_pre_notice_wait` („Jetzt
freigeben“ vor Ablauf der 24-h-Frist), `damage.set_cost`/`missing_item.set_cost`
(Kostenklärung), `damage.edit_cost_before_lexware` (Kosten vor Übertragung
ändern), `deposit.record_advance`/`deposit.record_security` (Anzahlung/Kaution
erfassen), `deposit.retain_security` (Kaution verrechnen),
`deposit.refund_security` (Kaution freigeben), `lexware.manual_transfer`
(manuelle Übertragung nach Fehlschlag/Frühfreigabe), `booking.cancel` und
`process.cancel` (Storno; Vorschau benötigt `settlement.view` oder
`booking.cancel`), `process.reopen_completed` (Admin-Wiedereröffnung;
Abrechnung bleibt gesperrt), `system.settings` (Mock-Buchhaltungssteuerung –
nur außerhalb von production).

Phase 10 (echte Lexware-Integration) führt **keine neuen Rechte** ein.
Wiederverwendet: `system.settings` (Einstellungen → Lexware: Status,
Verbindungsprüfung, Webhook-Einrichtung, Abgleich, Organisation bestätigen;
Steuerkonfiguration je Kategorie; Lexware-Kontakt verknüpfen/anlegen;
„fällige Jobs ausführen“ außerhalb von production), `settlement.view`
(Buchhaltungsblock inkl. Blocker/Prüfhinweise, Lexware-Kontaktstatus eines
Kunden lesen), `accounting.view_reference` (Lexware-Rechnungsnummer,
Deeplink und Rechnungs-PDF-Durchleitung – ohne dieses Recht nur der
Status), `lexware.manual_transfer` (erneute Übertragung nach Timeout/
Fehlschlag). Der Webhook-Endpunkt `POST /webhooks/lexware` ist
unauthentifiziert und ausschließlich durch die RSA-SHA512-Signaturprüfung
(offizieller Lexware-Public-Key) plus Organisationsabgleich geschützt.

### Kaution/Anzahlung
`deposit.record_advance`, `deposit.record_security`,
`deposit.retain_security`, `deposit.refund_security`

### Kommunikation
`message.reply_customer`, `email.approve_prepared`, `whatsapp.reply`

### CMS/System
`product.manage`, `price.manage`, `cms.edit`, `cms.publish`,
`employee.manage`, `permission.manage`, `device.revoke`,
`system.settings`, `demo.manage`, `training.manage`

## Temporäre Rechte
Direktrechte optional mit `valid_from`/`valid_until`.

## Vertretung
Vertretung übernimmt Zuständigkeit, nicht automatisch fehlende Rechte.

## UI
Fachliche gesperrte Funktion darf sichtbar + Lock + kurze Erklärung sein.
Erklärung pro Funktion adminpflegbar.
Reine Admin-Infrastruktur für normale Mitarbeiter ausblenden.

## Mitarbeiter sperren
Admin:
- sofort sperren
- alle Sessions widerrufen
- neutraler Login-Hinweis
- später reaktivieren
- optionale anpassbare Reaktivierungs-Mail
Keine Pflichtbegründung.

## Training Gate
Admin kann definieren, dass bestimmte Live-Funktionen zusätzlich
eine bestandene Demo-Übung erfordern.
Admin kann Gate manuell übersteuern.

## Offline (Phase 8)

- Keine neuen Permission-Keys. Offline-Mutationen bilden 1:1 auf die
  bestehenden Keys ab (`MUTATION_PERMISSIONS` in
  `packages/offline/src/mutations.ts`, z. B. `handover.finalize` →
  `handover.view` + `process.view_all` + `handover.perform`); der Server prüft
  jede Mutation beim Sync erneut gegen die AKTUELLEN Rechte – ein widerrufenes
  Recht führt zur Ablehnung (`PERMISSION_REVOKED`), nie zur Anwendung.
- Ein Offline-Lease (72 h) erhalten nur Konten mit operativen Rechten
  (`handover.view`, `return.view` oder `machine.view`). Der lokale
  Rechte-Snapshot enthält ausschließlich operative Keys
  (`OFFLINE_RELEVANT_PERMISSIONS`); Admin-, Finanz- und Systemrechte werden
  nie übertragen und steuern lokal nur die Darstellung.
- Das Lease ist serversigniert (Ed25519-Claim mit userId, deviceId,
  Umgebung, issuedAt, expiresAt, Nonce; Schlüssel nur serverseitig aus
  `AUTH_SECRET_KEY` abgeleitet). Laufzeit und Identität bestimmt allein der
  Server; der Client kann ein Lease weder verlängern noch neu erzeugen, und
  ein Claim einer anderen Umgebung verifiziert nicht. Voraussetzung in
  staging/production: der öffentliche Verifikationsschlüssel ist beim
  Staff-Server hinterlegt (`STAFF_OFFLINE_LEASE_VERIFICATION_KEY`,
  fail-closed – siehe ENVIRONMENTS.md). Der Claim trägt keine
  Rechte – die gelten weiterhin nur serverseitig je Mutation.
- QR-Tokens reisen nur im Request-Body (`POST /staff/machines/qr/resolve`
  mit `machine.view`; `POST /staff/returns/resolve-qr` mit `return.view` +
  `process.view_all` + Vorgangssichtbarkeit) – nie im URL-Pfad. Ein Scan
  erweitert keine Rechte; unbekannte/fremde Tokens werden neutral abgelehnt.
- Der Lager-/Tabletmodus ist eine Darstellungsvariante pro Gerät und erweitert
  keine Rechte; es gibt keine zusätzliche Lager-PIN.

## Web Push & Kalender-Feed (Phase 12)

- **Kein neues Recht für Push-Geräte.** Jede gültige Session darf das EIGENE
  Gerät registrieren (`POST /staff/push/subscriptions`), abmelden
  (`DELETE /staff/push/subscriptions/current`) und die eigenen Geräte sehen
  (`GET /staff/push/subscriptions`, nur Label/Zeiten – nie Endpoint/Keys).
  Push ist ein Werkzeug, keine Datenfreigabe: Nachrichten enthalten nur
  Vorgangsnummer/Terminart und öffnen die Staff-App, deren Rechteprüfung
  unverändert greift.
- **Empfänger operativer Pushes:** 1h-Termin/Vertretungsbeginn ⇒ die
  effektiv zuständige Person; überfällige Rückgabe und Maschinenrisiko
  (initial + 6 h) ⇒ alle aktiven Nutzer mit `calendar.view_all` oder
  `employee.manage` (Planung/Admin, frisch berechnet, Systemadmins immer);
  neues Gerät (`session.new_device_login`) ⇒ nur `employee.manage`.
- **Kalender-Feed:** `calendar.view` (eigene Termine) für Erzeugen/
  Regenerieren/Status (`POST`/`GET /staff/calendar/feed`); der Feed zeigt
  ausschließlich die eigenen effektiven Termine – auch mit
  `calendar.view_all` nie fremde (Feed = Person, nicht Rolle). Der
  öffentliche Abruf `GET /public/calendar/<token>.ics` ist read-only,
  rate-limitiert und antwortet neutral 404; der Token ist der einzige
  Zugang (nur Hash gespeichert). Deaktivierte Nutzer ⇒ 404.
- **Admin-Status** (`system.settings`, Einstellungen → Kommunikation):
  `pushStatusSummary` liefert nur enabled/öffentlichen VAPID-Key/aktive
  Geräte – nie den privaten Schlüssel.

## Kommunikation: Konversation, Unmatched-Inbox, WhatsApp (Phase 12)

- **Konversation je Vorgang** (`GET /staff/processes/:id/conversation`,
  `GET /staff/messages/:id/photos/:photoId`): Sichtbarkeit = Vorgangs-
  sichtbarkeit (`process.view_all` + zentrale Regel für Abgeschlossene;
  unsichtbar = neutrales 404). Fotos sind nur über ihre eigene Nachricht
  erreichbar; Fotos unzugeordneter Nachrichten nur mit
  `message.reply_customer` (wie die Inbox).
- **Antwort per E-Mail** (`POST /staff/processes/:id/conversation/reply`,
  `channel: 'email'`): `message.reply_customer` + Vorgangssichtbarkeit.
  Empfänger ist NIE frei wählbar – immer die E-Mail des Vorgangskunden.
- **Antwort per WhatsApp** (`channel: 'whatsapp'`): `whatsapp.reply` +
  Vorgangssichtbarkeit (`message.reply_customer` genügt NICHT); nur
  innerhalb des 24-h-Fensters, Empfänger = Nummer der letzten
  Kundennachricht des Vorgangs.
- **Unmatched-Inbox** (`GET /staff/communication/unmatched`,
  `POST …/:id/assign`, `POST …/:id/ignore`): `message.reply_customer`.
  Begründung: Es ist das administrative Kommunikationsrecht „Kunden
  antworten“ – wer Kundennachrichten beantworten darf, darf sie auch
  sichten und einem Vorgang zuordnen. `system.settings` ist reine Admin-
  Infrastruktur, `email.approve_prepared` betrifft nur ausgehende Freigaben;
  ein neues Recht wäre ohne fachlichen Mehrwert (Order §36: minimal neue).
  Zuordnen setzt nur `process_id`/`customer_id`/`assigned_by` der
  Konversationszeile – nie eine Fachmutation am Vorgang.
- **Webhook** `GET/POST /webhooks/whatsapp`: öffentlich, ohne Staff-Login;
  Schutz ausschließlich über Verify-Token bzw. HMAC-Signatur, Rate-Limit,
  neutrale 401/403/404.

## Erinnerungen, Terminänderung, Kunden-Aktionslinks (Phase 12)

- **Keine neue Permission.** `POST /staff/appointments/:id/inform-customer`
  (bewusste Mail „Kunden über Terminänderung informieren“) verlangt
  `email.approve_prepared` – dieselbe Freigabe einer vorbereiteten Kundenmail
  wie die Stornobestätigung – UND die Terminsichtbarkeit der Terminplanung
  (`calendar.view_all` oder eigener/effektiver Termin, sonst neutral 404).
- **Kundenkontakte im Vorgang:** `GET /staff/processes/:id/customer-contacts`
  (Abholperson/Kontakt vor Ort aus dem Aktionslink) folgt der Vorgangs-
  sichtbarkeit (`process.view_all` + zentrale Sichtbarkeitsregel, neutral 404).
  Antworten enthalten nie Token oder Hashes.
- **Öffentlich ohne Login:** `GET/POST /public/actions/:token` – Zugang nur
  über den Token (nur Hash gespeichert, exakt bis 1 h vor Termin, je
  Termin/Zweck ein aktiver Link), IP-Rate-Limit, immer dasselbe neutrale 404
  bei jedem Fehlerfall, Pfad im Log maskiert. Erinnerungsmails (7 Tage/1 Tag)
  werden automatisch vom Scheduler versendet – keine Staff-Aktion, keine
  Permission.


## Transaktionsmails (Phase 12, transactional)
- Keine neuen Permissions. Angebotsversand bleibt `offer.send`, AB-Freigabe/
  -Versand `booking.confirm`, Kundeninformation (Schaden/Fehlteil)
  `settlement.release`, Stornobestätigung `email.approve_prepared` – jeweils
  als bewusste Staff-Aktion; die Mail selbst versendet der Job `mail.send`.
- **„Gutschein jetzt senden“** `POST /staff/customers/:id/send-voucher` (Body `{ voucherId }`, Gutschein muss zum Kunden gehören):
  `customer.view` + `email.approve_prepared` (wie die Stornobestätigung);
  409, wenn der Mailversand nicht konfiguriert ist, keine E-Mail-Adresse oder
  keine Versandkopie vorliegt. Antwort nur `{ queued, voucherId }` – Staff
  sieht nie Code, Hash oder Kopie.
- Übergabe-/Rückgabeprotokoll, Gutschein- und Rechnungsmail laufen
  automatisch (keine Staff-Aktion, keine Permission); erneut senden nur über
  die Outbox (`system.settings`).
- **Öffentlich ohne Login:** `GET /public/documents/:token` – genau ein
  Dokument je Token (nur Hash gespeichert, 90 Tage), IP-Rate-Limit 30/min,
  immer dasselbe neutrale 404, Pfad im Log maskiert.
