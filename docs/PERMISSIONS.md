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
