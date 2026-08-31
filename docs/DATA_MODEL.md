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
