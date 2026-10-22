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
Phase 11: `vouchers` (genau eine Art `returning_customer_20`; Kunde,
Ursprungsvorgang/-buchung/-rückgabe/-abrechnung mit UNIQUE
`origin_settlement_id`; `discount_percent` konstant 20 (CHECK); `code_hash`
SHA-256 UNIQUE + `code_suffix` für die Maske; Status active/reserved/redeemed
(„abgelaufen“ lazy aus `expires_at`); `activated_at`, `expires_at`
(12 Kalendermonate Berlin); `reserved_offer_id` (unique partial) +
`reserved_at` (Reservierung beim Senden, Offer-Ebene); Versand
`delivery_status` pending/sent, `delivery_problem_code` (z. B. NO_EMAIL),
`delivered_at`, `delivery_code_ciphertext` (AES-256-GCM-Kopie, Phase 12
löscht sie); `version`). `voucher_redemptions` (je Einlösung: Gutschein,
Angebot, Buchung UNIQUE, Vorgang, `redeemed_at`,
`expires_at_before_redemption`, `remaining_validity_seconds` > 0,
`cancellation_id`, `reactivated_at`, `final_consumption_reason`).
Snapshots: `offer_versions.voucher_id/voucher_discount_cents/voucher_snapshot`,
`bookings.voucher_id/voucher_snapshot` (ohne Klartext). Kein Klartextcode in
irgendeiner Spalte.

### MailDelivery (Phase 12, `mail_deliveries`)
Dauerhafte E-Mail-Outbox: `kind` (offer, order_confirmation, handover_protocol,
return_protocol, settlement_damage_missing_notice, cancellation_confirmation,
reminder_7_days, reminder_1_day, appointment_changed, voucher_delivery,
invoice_delivery, manual_customer_reply), Bezüge `process_id`/`customer_id`/
`booking_id`, eingefrorener Empfänger (`recipient_email`, `recipient_name`),
`subject`, `template_kind`/`template_version`, `context` (jsonb, NUR nicht-
geheime Render-Daten), `secret_payload_ciphertext` (AES-256-GCM v2 mit
Communication-Key; Token/Gutscheincode; nach `sent` gelöscht), `attachments`
(Referenzen: `document` → documents.id, `lexware_invoice` → Lexware-ID; nie
Bytes), `status` (pending | sending | sent | retry | failed | blocked |
outcome_unknown), `idempotency_key` (UNIQUE, fachlich), `message_id` (UNIQUE,
stabil über alle Versuche), `in_reply_to_message_id`, `attempts`,
`next_attempt_at`, `sending_since`, `sent_at`, `provider_code`,
`last_error_code`, `blocked_reason` (MAIL_NOT_CONFIGURED,
DEMO_NOT_WHITELISTED, NO_RECIPIENT, INVALID_RECIPIENT, SECRET_UNDECRYPTABLE,
PUBLIC_WEB_BASE_URL_MISSING, …), `conversation_message_id`, `created_by`.
Kein Mailbody, kein Klartext-Geheimnis in irgendeiner Spalte.
Phase-12-Finalisierung (Retention): `recipient_email` und `subject` sind
NULLable (nur nach der Bereinigung NULL); `retention_anchor_at` =
Terminalzeitpunkt des Vorgangs (completed_at bzw. cancelled_at, gesetzt beim
Eintritt in terminal, nur prozessgebundene Zeilen); `pii_scrubbed_at` =
Zeitpunkt der Bereinigung (prozessgebunden 12 Berliner Kalendermonate nach dem
Anker, sonst 90 Tage nach Endzustand sent ⇒ `sent_at`, failed/blocked/
outcome_unknown ⇒ `updated_at`; nie pending/retry/sending): `recipient_email`,
`recipient_name`, `subject`, `in_reply_to_message_id`,
`secret_payload_ciphertext` ⇒ NULL, `context` ⇒ `{}`, `attachments` ⇒ `[]`;
danach kein Resend. Audit-Rest bleibt (id, kind, Bezüge, Status,
Idempotenzschlüssel, Message-ID, Versuche, Zeiten, neutrale Codes).

### PushSubscription / PushDelivery (Phase 12, `push_subscriptions`, `push_deliveries`)
`push_subscriptions`: `user_id`, `session_id` (registrierende Gerätesession),
`endpoint` (UNIQUE, Capability-URL – nie loggen/ausgeben), `p256dh`, `auth`,
`user_agent_label`, `created_at`, `last_success_at`, `disabled_at`,
`disabled_reason` (gone | session_revoked | user_inactive | session_expired |
endpoint_not_allowed | reassigned; `user_unsubscribed` nur noch in
Bestandszeilen – Phase 12 Finalisierung: kein Push-Opt-out, wird nicht mehr
erzeugt). Versand nur an Zeilen mit `disabled_at IS NULL`, aktivem User
und nicht widerrufener Session. `push_deliveries`: `kind` (appointment_1h,
return_overdue, machine_risk, machine_risk_6h, session_new_device_login,
substitution_started), `user_id`, `idempotency_key` (UNIQUE, z. B.
`push:return_overdue:<incidentId>:<userId>`), `payload` (jsonb {kind, title,
body, url, tag} – datenminimiert), `status` (pending | sent | failed |
skipped), `subscriptions_targeted`/`_succeeded`, `last_error_code`, `sent_at`.
Phase 12 Finalisierung (Migration 0025): `appointment_id` (uuid NULL, FK
appointments) bei `appointment_1h`/`assignment_reassigned` – `push.send` prüft
vor jedem Versand, ob die Zustellung noch zum aktuellen Terminstand passt,
sonst `skipped` mit `last_error_code = 'SUPERSEDED'`; NULL = nicht
terminbezogen bzw. Altbestand (ungeprüft). `session_id` eines Abos folgt bei
erneutem Login desselben Users auf demselben Gerät bzw. über die Statusroute
der aktuellen Session.

### CalendarFeedToken (Phase 12, `calendar_feed_tokens`)
Ein Eintrag je User (`user_id` UNIQUE): `token_hash` (SHA-256 des 32-Byte-
Tokens, UNIQUE; Klartext nur in der Erzeugungsantwort), `created_at`,
`regenerated_at`, `last_access_at`. Regenerate ersetzt den Hash in place.

### AppointmentReminder (Phase 12, `appointment_reminders`)
Bindet Erinnerungen an die Terminversion: `appointment_id`, `kind`
(reminder_7_days | reminder_1_day | push_1_hour), `fingerprint` (für Push:
sha256(appointmentId|startAt|assignee); für Mail-Erinnerungen:
sha256(appointmentId|kind|startAt-ISO)), `due_at` (Mail: startAt − 7 bzw. − 1
Berliner Kalendertag(e), gleiche Wanduhrzeit), `mail_delivery_id`/
`push_delivery_id`, `sent_at` (Mail: vom Sent-Listener gesetzt);
UNIQUE (appointment, kind, fingerprint) ⇒ Reschedule/Neuzuweisung erzeugen
neue Zeilen, alte bleiben no-op. Eine Mail-Zeile mit `mail_delivery_id IS NULL`
und `sent_at IS NULL` bedeutet „bewusst nicht nachgeholt“ (Buchung nach dem
Fälligkeitszeitpunkt oder Fälligkeit > 6 h zurück) – sie hält jeden weiteren
Scan idempotent.

### CustomerActionToken (Phase 12, `customer_action_tokens`)
Single-Purpose-Kundenlinks: `purpose` (pickup_contact_update |
delivery_contact_update | document_view), `token_hash` (SHA-256 des 32-Byte-
base64url-Tokens, UNIQUE – nie der Klartext), `process_id`, `customer_id`,
`booking_id`, `appointment_id` (Kontakt-Links), `document_id` (nur
document_view; CHECK), `expires_at` (Kontakt-Links: exakt startAt − 1 h),
`revoked_at` (erneute Ausgabe je Termin/Zweck widerruft ältere Tokens),
`last_used_at`, `use_count`. Zusätzlich serverseitiger Cutoff gegen den
AKTUELLEN Terminbeginn, Termin-/Vorgangsstatus; alle Fehlerfälle neutral.

Phase 12 (transactional): purpose `document_view` (Kundeninformation →
Rückgabeprotokoll) gilt 90 Tage ab Ausstellung, wird beim Einreihen der Mail
in derselben Transaktion ausgestellt; Klartext nur in der verschlüsselten
Outbox-Payload.

### Transaktionsmail-Status (Phase 12, transactional)
Verknüpfung über `*.mail_delivery_id` (kein FK): `order_confirmations.status`
prepared | approved | queued | sent | failed; `delivery_packets.status`
ready | queued | sent | failed (`ready` nur noch ohne Mailer, z. B. Alt-
bestand); `settlement_customer_notices.status` prepared | approved | queued |
sent | blocked | failed (`gateway` = 'mail', `gateway_reference` =
Message-ID); `cancellations.confirmation_status` (Text) prepared | queued |
sent | failed | blocked, `confirmation_mail_delivery_id`,
`confirmation_gateway_reference` = Message-ID; `settlements/cancellations.
invoice_delivery_status` (Text) pending | sent | failed | blocked +
`invoice_mail_delivery_id`; `lexware_invoice_mappings.delivery_status`
pending | sent (CHECK) + `mail_delivery_id`; `vouchers.mail_delivery_id`,
`delivery_problem_code` (NO_EMAIL, DELIVERY_COPY_UNDECRYPTABLE, MAIL_FAILED,
SMTP-Code). `offer_deliveries` wird seit Phase 12 nicht mehr befüllt
(Altbestand, Token dort maskiert).

### BookingCustomerContact (Phase 12, `booking_customer_contacts`)
Vom Kunden per Aktionslink gepflegte Abholperson (`kind = pickup`) bzw.
Kontakt vor Ort (`kind = delivery`): `booking_id`, `kind`, `first_name`,
`last_name`, `phone` (Pflicht; normalisiert `+<Ziffern>`, 6–20 Ziffern),
`updated_via_token_id`, `updated_at`. UNIQUE (booking, kind): genau EIN
aktueller Stand je Buchung und Art – eine Änderung überschreibt vollständig,
es gibt keine Historie und keine Kopie der alten Telefonnummer.

### Document
Typ, Version, Storage-Key, Hash, created/finalized, immutable, kunden-sichtbar.

### ConversationMessage (Phase 12, `conversation_messages`)
Eine Zeile je Nachricht im Vorgang: `process_id` (NULL = nicht zugeordnet,
Order §22/§27), `customer_id`, `channel` (email | whatsapp | portal
[vorbereitet]), `direction` (inbound | outbound), `sender_snapshot` (jsonb
ohne Secrets: `name?`, `email?`, `phone?` = wa_id – bei ausgehenden WhatsApp-
Zeilen die Gegenstelle –, `skippedAttachments?` = Zähler nicht gespeicherter
Anhänge), `subject`, `body` (NUR Text; HTML wird sicher zu Text, nie Raw-HTML),
`provider_message_id` (RFC-5322-Message-ID ohne Klammern bzw. wamid; UNIQUE je
Kanal), `reply_to_provider_message_id` (In-Reply-To / WhatsApp-context.id),
`mail_delivery_id` (eigene Outbox-Zustellung), `is_system_event` (automatische
Mails als kompakte Ereignisse), `delivery_state` (received | queued | sent |
delivered | read | failed | blocked; wird aus Outbox-Status bzw. WhatsApp-
statuses gespiegelt), `sent_at`/`received_at`, `created_by_staff_id`,
Zuordnung durch Staff (`assigned_by_staff_id`, `assigned_at`) bzw. Ignorieren
(`ignored_at`, `ignored_by_staff_id`), Retention `body_deleted_at` (Text
geleert; Zeile bleibt als Metadatum). Phase-12-Finalisierung:
`retention_anchor_at` = Terminalzeitpunkt (Abschluss/Storno), der für DIESE
Zeile gilt – gesetzt beim ersten Terminalzustand nach ihrem Entstehen bzw.
ihrer Zuordnung, nie zurückgesetzt (Reopen); `pii_scrubbed_at` = Zeitpunkt
der PII-Minimierung: zugeordnet 12 Berliner Kalendermonate nach dem Anker
(`body` '', `subject`/`provider_message_id`/`reply_to_provider_message_id`
NULL, `sender_snapshot` ⇒ `{"role":"customer"}` bzw. `{"role":"staff"}`),
nicht zugeordnet/ignoriert 90 Kalendertage nach Eingang
(LEAST(`received_at`, `created_at`); `sender_snapshot` ⇒ `{}`; danach nicht
mehr in der Unmatched-Inbox und nicht zuordenbar).
### MessagePhoto (Phase 12, `message_photos`)
Eingehendes Bild (nur JPEG/PNG/WebP nach MIME + Magic Bytes + Größenlimit):
`message_id`, `storage_key` (privat, `communication/messages/<messageId>/<uuid>.<ext>`,
UNIQUE), `mime_type`, `byte_size`, `sha256`, `deleted_at` (beim Eintritt des
Vorgangs in terminal – Abschluss ODER Storno – bzw. 90 Tage nach Eingang
nicht zugeordneter Nachrichten gelöscht; gesetzt erst nach erfolgreichem
Storage-Löschen – nur Kommunikationsfotos, nie Übergabe-/Rückgabe-/
Schadensfotos). Auslieferung ausschließlich über
`GET /staff/messages/:id/photos/:photoId` (Vorgangssichtbarkeit).
### InboundMailReceipt / InboundMailState (Phase 12, `inbound_mail_receipts`, `inbound_mail_state`)
Beleg je verarbeiteter eingehender Mail: `mailbox`, `uid_validity`, `uid`
(UNIQUE Tripel), `message_id_hash` (SHA-256 hex der normalisierten
Message-ID, partial UNIQUE – Phase-12-Finalisierung: KEIN Klartext, die
frühere Spalte `message_id` ist entfernt), `fingerprint` (SHA-256, UNIQUE),
`from_address`, `subject`, `received_at`, `status` (matched | unmatched |
ignored | rejected), `match_reason` (in_reply_to | references |
process_number_sender | manual | `quarantined:<code>`),
`conversation_message_id`, `pii_scrubbed_at` (unmatched/ignored/rejected 90
Kalendertage nach Eingang bzw. zugeordnete Belege mit ihrer Nachricht:
`from_address`/`subject` ⇒ NULL; Tripel, Status, `received_at`, Fingerprint
und Hash bleiben für die Deduplizierung). Poller-Zustand je Mailbox: `uid_validity`,
`last_uid` (erst nach erfolgreicher Verarbeitung fortgeschrieben),
`last_poll_at`, `last_success_at`, `last_error_code` (neutral, nie Inhalte).
### WhatsAppEvent / WhatsAppContact (Phase 12, `whatsapp_events`, `whatsapp_contacts`)
`whatsapp_events`: Dedupe/Verlauf je Webhook-Ereignis – `provider_message_id`
(wamid bzw. `outbound:<messageId>` für Sendeergebnisse) + `event_type`
(`message`, `status.sent|delivered|read|failed`, `send_result`) UNIQUE,
`phone_number_id`, `status` (queued | processed | ignored | failed),
`result_code` (Zuordnungsgrund, `UNSUPPORTED_<TYP>`, Graph-Fehlercode),
`received_at`, `processed_at`, `conversation_message_id`; nie Nutzlast/Inhalt.
Phase-12-Finalisierung: Die wamid ist aus der wa_id (Telefonnummer)
abgeleitet ⇒ `provider_message_id` nach 90 Tagen nur noch `sha256:<hex>`.
`whatsapp_contacts`: `wa_id` (PK, Ziffern ohne Plus), `customer_id` (wenn
eindeutig zugeordnet), `last_inbound_at` (Basis des 24-h-Service-Fensters),
`profile_name`. Zeilen ohne `customer_id`, deren letzte Nachricht > 90 Tage
zurückliegt, werden gelöscht (keine Referenz zeigt auf die Tabelle).
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
<!-- Phase 12 Finalisierung (Geräteidentität) -->
`staff_sessions.device_label` (aus dem User-Agent) ist reine Anzeige und
entscheidet nicht über „neues Gerät“.
<!-- Phase 12 Finalisierung (Push-Session-Bindung, Migration 0025) -->
`staff_sessions.device_token_hash` (text NULL): SHA-256 des Geräte-Cookies
der Anmeldung (`__Host-mr_staff_device`, in development `mr_staff_device`;
alle Loginpfade; nie Klartext, nie API-Feld).
NULL = Session vor dem Rollout. Index (`user_id`, `device_token_hash`) WHERE
NOT NULL. Einziger Zweck: nach einem erneuten Login desselben Mitarbeiters auf
demselben Gerät dessen aktive Push-Abos an die neue Session binden (nie an eine
andere Person).

### StaffKnownDevice (Phase 12 Finalisierung)
Tabelle `staff_known_devices`: bekannte Geräte je Mitarbeiter – `id`,
`user_id`, `device_token_hash` (NUR SHA-256 des serverseitig erzeugten
HttpOnly-Cookies `__Host-mr_staff_device` bzw. in development
`mr_staff_device`, 32 Zufallsbytes base64url; nie Klartext),
`display_label` (Anzeige aus dem User-Agent, wird beim Login aktualisiert),
`first_seen_at`, `last_seen_at`. UNIQUE(`user_id`, `device_token_hash`):
„neues Gerät“ ⇔ das Paar existiert noch nicht ⇒ atomar genau ein
`session.new_device_login` (Admin-Push). Logout/Session-Widerruf lassen den
Eintrag bestehen; ebenso Passwort-/2FA-Reset und Recovery (Fachentscheidung
2026-10-22, kein Codepfad löscht Zeilen). `staff_login_challenges.device_token_hash` trägt denselben
Hash vom Passwortschritt bis zum Abschluss (TOTP/Recovery/Ersteinrichtung).

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
