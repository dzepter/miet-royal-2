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

### Lager
`inventory.view`, `inventory.add_stock`, `inventory.issue`,
`inventory.return`, `inventory.count`, `inventory.approve_adjustment`,
`inventory.view_movement_history`

### Ausgabe/Rückgabe
`handover.perform`, `handover.correct_actual_time`,
`return.perform`, `return.correct_actual_time`, `return.mark_cleanup_issue`

### Schäden/Fehlteile
`damage.document`, `damage.set_cost`, `damage.edit_cost_before_lexware`,
`missing_item.create`, `missing_item.set_cost`, `missing_item.resolve`

### Abrechnung
`settlement.view`, `settlement.add_manual_charge`, `settlement.release`,
`settlement.end_pre_notice_wait`, `lexware.manual_transfer`

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
