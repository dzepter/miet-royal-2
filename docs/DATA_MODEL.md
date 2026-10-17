# DATA_MODEL — Fachliches Zielmodell

## Grundregeln
- interne UUID/ULID IDs
- öffentliche MR-Vorgangsnummer separat
- Geld exakt
- historische Snapshots
- signierte/versendete Dokumente immutable
- Live und Demo physisch getrennt

## Kernentitäten
### Customer
Privat/Firma, Name, Firma, E-Mail, Telefon, Rechnungsadresse, optionale USt-ID.

### CustomerAccount
Magic-Link-Konto, verifizierte Kontakte, Sessions, Löschstatus.

### Process
process_number, customer, source, main_status, assigned_user, event_date,
created/completed/canceled/reopened.

### Inquiry
Eventgrund, Start/Ende, Gästezahl, gewünschte Produkte, Fulfillment,
Lieferadresse/-fenster.

### Offer / OfferVersion
Status, Version, Gültigkeit, Kunden-/Event-/Pricing-Snapshot,
sent/accepted/invalidated, immutable nach Versand.

### Booking / BookingItem
Bestätigter Snapshot, Positionen mit Menge, Beschreibung, Einzelpreis,
Rabatt, Summe, Quelle.

### Product / ProductPrice
Produktstamm + zeitgesteuerte Preise.

### Appointment
PICKUP / RETURN / DELIVERY, geplant, tatsächlich, Ort, zuständig, Status.

### Machine
machine_code, type, status, location, purchase_date, weight,
required_carry_persons, reference_photo.

### MachineBlock
machine, von/bis, Grund, Ersteller.

### MachineAssignment
Process/Booking ↔ konkrete Maschine.

### MachineDamage
Maschine, Rückgabequelle, Severity, Beschreibung, aktuelle Sichtbarkeit.
DamageMarker: normierte Koordinaten.
DamagePhoto: File-Referenz.

### InventoryItem
Artikel, Einheit, aktiv, Mindestbestand, Preisregel.
### InventoryMovement
INBOUND / ISSUE / RETURN / INVENTORY_ADJUSTMENT.
### InventoryCount / Lines
Systemmenge, Istmenge, Adminfreigabe.

### Handover
Zeit, tatsächliche Abholperson, ephemeres Telefon, Gesamtfoto,
Kunden-/Mitarbeitersignatur, Abschluss.

### Return
Zeit, Rückgabeperson, ephemeres Telefon, Abschluss.
### ReturnMachineCheck
entleert, gespült, nicht demontiert, Reinigungspauschale, Beweisfoto.
### ReturnAccessoryCheck
Soll/Ist Deckel/Tropfschale.
### CommissionReturn
ausgegeben, ungeöffnet zurück, berechenbar.
### MissingItemCase
Beschreibung, Menge, OPEN/RESOLVED, optionaler Betrag, Follow-up.

### Settlement
Status, Summen, Lexware Lock, externe ID, Zahlungsstatus.
### SettlementItem
Typ, Quelle, Beschreibung, Menge, Betrag, Kunden-Vorinformation ja/nein.
### SettlementPreNotice
sent_at, wait_until, customer_replied_at, blocked.

### DepositPayment
ADVANCE_PAYMENT oder SECURITY_DEPOSIT, Betrag, Status, applied amount.
### SecurityDepositRetention
Betrag + Grund.

### Cancellation
wer, Zeitpunkt, Prozent, regulärer Preis-Snapshot, Gebühr, Rechnung nötig.

Umsetzung Phase 9 (`packages/database/src/schema/settlement.ts`, Migration
0018): `settlements` (ein Datensatz je finalisierter Rückgabe; Status,
Summen fix/variabel/Nachbelastungen/Credits, amount_due ≥ 0, overpayment
separat, Notice-/Warte-/Lock-/Transferfelder, version), `settlement_lines`
(typisiert, Betrag ≥ 0, Richtung aus dem Typ, Unique je Quelle
`(settlement_id, source_type, source_key)`, immutable `source_snapshot`),
`settlement_clarifications` (damage_cost / missing_item_cost /
customer_notice / customer_response; open/resolved), `settlement_customer_notices`
(eine je Abrechnung: prepared/approved/sent/blocked, Positions-Snapshot,
Gateway-Referenz), `accounting_transfers` (eine je Abrechnung bzw. Storno:
Idempotenzschlüssel, eingefrorener Snapshot + Hash, Versuche, Fehlercode,
externe Referenz, Zahlungsstatus), `booking_advance_payments` (active/
cancelled), `booking_security_deposits` (held/released/applied, applied_cents
≤ amount_cents), `cancellations` (canceler_type employee/admin/customer,
Kalendertage, Satz 0/50/100, Basis, Gebühr, Rundung half_up, Finanzstatus
no_invoice/accounting_pending/invoice_open/paid, freigegebene Ressourcen,
Bestätigungsstatus, reopened_at), `process_relations` (previous → follow_up,
kind cancellation_follow_up, normalisiert). SettlementItem/SettlementPreNotice/
DepositPayment/SecurityDepositRetention aus der Zielskizze sind damit durch
diese Tabellen abgedeckt; eine eigene „Kautions-Einbehalt mit Grund“-Tabelle
entsteht erst, wenn Phase 10+ sie braucht (heute: `applied_cents` + Credit-
Position). Keine Lexware-spezifischen Tabellen.

### Voucher
Kunde, Ursprungsvorgang, Code-Hash, 20 %, Gültigkeit, Benutzung.

### Document
Typ, Version, Storage-Key, Hash, created/finalized, immutable, kunden-sichtbar.

### ConversationMessage
PORTAL / EMAIL / WHATSAPP, Richtung, Sender, Text, Zeit, optional importiert.
### MessagePhoto
temporäre Datei.
### InternalNote
Vorgang, Autor, Text.

### User
Mitarbeiter, Status, Auth/2FA.
### Permission
Key, Beschreibung, Kategorie.
### RoleTemplate
Vorlage.
### UserPermission
User, Permission, allow, optional valid_from/until.
### DeviceSession
Gerät, last_seen, revoked.

### Substitution
Ursprung, Vertreter, von/bis.

### TrainingDefinition / Path / Assignment / Attempt
Demo-Trainings-Metaebene.

### SystemSetting
Nur sinnvolle veränderbare Betriebsparameter; keine komplette Fachlogik als freie JSON-Regel.

### IntegrationJob
Typ, idempotency_key, status, attempts, retry time, error.

### FileObject
Storage-Key, MIME, Size, Hash, Klassifikation, Löschzeitpunkt.

## Unveränderliche Beziehungen
- Process bleibt zentrale Klammer.
- bereits versendete OfferVersion nie überschreiben.
- Booking referenziert angenommene OfferVersion.
- SettlementItem kennt Quelle.
- finale Dokumente bleiben historisch.
