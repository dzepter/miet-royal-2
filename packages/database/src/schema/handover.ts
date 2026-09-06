import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { staffUsers } from './staff-auth.ts';
import { processes } from './crm.ts';
import { bookings, documents, products } from './commerce.ts';
import { appointments } from './scheduling.ts';
import { inventoryItems, machines } from './warehouse.ts';

/**
 * Phase 6: Vorbereitung, konkrete Maschinenzuweisung, Ausgabe, Lieferschein
 * und Übergabeprotokoll (MASTER_SPEC Nr. 11/12, DATA_MODEL
 * "MachineAssignment"/"Handover"/"Document", Phase-6-Order §§3–5, 8–9, 14,
 * 18–20, 27–29, 33–39, 46, 59).
 *
 * Bewusst NICHT hier (Phase 7+): Rückgabe, Rückgabeprotokoll, Schäden,
 * Fehlteile, Reinigung, Kommissionsrückgabe, Abrechnung (Order §51/§70).
 */

// ── Maschinenzuweisung (Order §§3–5) ──────────────────────────────────────

/**
 * Slot-Status: open = noch keine konkrete Maschine (auch nach dem Lösen),
 * assigned = Maschine zugeordnet, prepared = physisch vorbereitet
 * (Maschine 🟠 Reserviert), issued = ausgegeben (Maschine 🔵 Vermietet),
 * returned = später durch Phase 7.
 */
export const machineAssignmentStatus = pgEnum('machine_assignment_status', [
  'open',
  'assigned',
  'prepared',
  'issued',
  'returned',
]);

/**
 * Pro tatsächlich benötigter physischer Maschine GENAU eine Zeile
 * (Order §4): Buchung × Laufnummer des Slots ist der stabile fachliche
 * Schlüssel, der Doppelklick/Retry/parallele Requests idempotent macht
 * (Order §5). Die konkrete Maschine bleibt NULL, bis ein Mitarbeiter sie
 * bewusst zuweist (Order §6 – nie automatisch).
 */
export const machineAssignments = pgTable(
  'machine_assignments',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    processId: uuid('process_id')
      .notNull()
      .references(() => processes.id),
    /** Gebuchter Maschinentyp (Produkt) – NICHT die konkrete Maschine. */
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    /** Laufnummer des Slots innerhalb der Buchung (1..Menge). */
    slotNo: integer('slot_no').notNull(),
    machineId: uuid('machine_id').references(() => machines.id),
    status: machineAssignmentStatus('status').notNull().default('open'),
    /**
     * Fachlicher Mietzeitraum (Order §3) aus den Phase-4-Terminen
     * (Abhol-/Lieferbeginn bis Rückgabe-Ende); NULL = noch nicht geplant.
     * Wird bei Zuweisung/Vorbereitung aktualisiert.
     */
    rentalFrom: timestamp('rental_from', { withTimezone: true }),
    rentalTo: timestamp('rental_to', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => staffUsers.id),
    assignedBy: uuid('assigned_by').references(() => staffUsers.id),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    preparedBy: uuid('prepared_by').references(() => staffUsers.id),
    preparedAt: timestamp('prepared_at', { withTimezone: true }),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedBy: uuid('released_by').references(() => staffUsers.id),
    /** Später (Phase 7). */
    returnedAt: timestamp('returned_at', { withTimezone: true }),
    /** Optionaler Override, mit dem die aktuelle Maschine zugewiesen wurde. */
    overrideId: uuid('override_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('machine_assignments_booking_slot_unique').on(table.bookingId, table.slotNo),
    /**
     * Physik (Order §7): eine Maschine kann nur EINMAL gleichzeitig
     * ausgegeben sein – harter DB-Backstop gegen Doppel-Ausgabe.
     */
    uniqueIndex('machine_assignments_issued_machine_unique')
      .on(table.machineId)
      .where(sql`"status" = 'issued'`),
    index('machine_assignments_machine_idx').on(table.machineId),
    index('machine_assignments_process_idx').on(table.processId),
    check('machine_assignments_slot_check', sql`"slot_no" >= 1`),
    check(
      'machine_assignments_machine_status_check',
      sql`("status" = 'open' AND "machine_id" IS NULL) OR ("status" <> 'open' AND "machine_id" IS NOT NULL)`,
    ),
  ],
);

/**
 * Bewusster Override (Order §§7/8): Recht + Warnung + Pflichtgrund +
 * Bestätigung + Mitarbeiter + Zeitpunkt + betroffene Buchung. Der
 * Situations-Fingerprint hält fest, WELCHE konkrete Problemlage bestätigt
 * wurde – ändert sie sich wesentlich, ist eine neue Bestätigung nötig
 * (Order §49, kein TOCTOU).
 */
export const machineAssignmentOverrides = pgTable(
  'machine_assignment_overrides',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => machineAssignments.id),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    processId: uuid('process_id')
      .notNull()
      .references(() => processes.id),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id),
    /** Problemcodes (z. B. status_repair, blocked, collision) als Liste. */
    problemCodes: jsonb('problem_codes').notNull(),
    /** Menschenlesbare Problembeschreibung zum Bestätigungszeitpunkt. */
    problemSummary: text('problem_summary').notNull(),
    situationFingerprint: text('situation_fingerprint').notNull(),
    reason: text('reason').notNull(),
    confirmedBy: uuid('confirmed_by')
      .notNull()
      .references(() => staffUsers.id),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull().defaultNow(),
    /** Order §9: nach abgeschlossener Rückgabe automatisch archivierbar (Phase 7). */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    index('machine_assignment_overrides_assignment_idx').on(table.assignmentId),
    check('machine_assignment_overrides_reason_check', sql`length(trim("reason")) > 0`),
  ],
);

// ── Zukünftige Risiko-Incidents (Order §§45–48) ───────────────────────────

export const machineRiskIncidentReason = pgEnum('machine_risk_incident_reason', [
  'status',
  'block',
]);

/**
 * Deduplizierter operativer Risikohinweis: eine bereits zugewiesene
 * Maschine ist für eine ZUKÜNFTIGE/laufende Buchung problematisch
 * geworden. Genau ein OFFENER Incident je Fingerprint (Maschine ×
 * Zuordnung × konkrete Ursache); Push/Follow-up-Felder sind die
 * Datengrundlage für Phase 12 (kein Versand in Phase 6).
 */
export const machineRiskIncidents = pgTable(
  'machine_risk_incidents',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => machineAssignments.id),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    processId: uuid('process_id')
      .notNull()
      .references(() => processes.id),
    reasonKind: machineRiskIncidentReason('reason_kind').notNull(),
    reasonText: text('reason_text').notNull(),
    fingerprint: text('fingerprint').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Admin-Push fällig ab Entstehung (Order §46). */
    adminNotificationDueAt: timestamp('admin_notification_due_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    adminNotifiedAt: timestamp('admin_notified_at', { withTimezone: true }),
    /** Genau EIN Follow-up 6 h nach der ersten Benachrichtigung (Order §48). */
    followUpDueAt: timestamp('follow_up_due_at', { withTimezone: true }),
    followUpSentAt: timestamp('follow_up_sent_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => staffUsers.id),
    /** auto = Problem behoben/Zuordnung geändert; acknowledged = Admin „Geprüft“. */
    resolution: text('resolution'),
  },
  (table) => [
    uniqueIndex('machine_risk_incidents_open_unique')
      .on(table.fingerprint)
      .where(sql`"resolved_at" IS NULL`),
    index('machine_risk_incidents_machine_idx').on(table.machineId),
  ],
);

// ── Zusatzpositionen nach Buchung (Order §20) ─────────────────────────────

/**
 * Nachträglich vereinbarte Verbrauchs-/Kaufartikel mit eingefrorenem
 * Preis – SEPARAT vom unveränderbaren Buchungs-Snapshot (MASTER_SPEC §10:
 * spätere Zusatzkosten als separate Positionen).
 */
export const bookingAdditions = pgTable(
  'booking_additions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    processId: uuid('process_id')
      .notNull()
      .references(() => processes.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull(),
    unit: text('unit').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    billingMode: text('billing_mode').notNull(), // 'fixed' | 'commission'
    createdBy: uuid('created_by')
      .notNull()
      .references(() => staffUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('booking_additions_booking_idx').on(table.bookingId),
    check('booking_additions_quantity_check', sql`"quantity" >= 1`),
    check('booking_additions_price_check', sql`"unit_price_cents" >= 0`),
  ],
);

// ── Lieferschein (Order §§18/19/38) ───────────────────────────────────────

export const deliveryNoteStatus = pgEnum('delivery_note_status', ['draft', 'final']);

export const deliveryNoteItemKind = pgEnum('delivery_note_item_kind', [
  'included',
  'commission',
  'purchase',
]);

export const deliveryNotes = pgTable(
  'delivery_notes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    bookingId: uuid('booking_id')
      .notNull()
      .unique()
      .references(() => bookings.id),
    processId: uuid('process_id')
      .notNull()
      .references(() => processes.id),
    status: deliveryNoteStatus('status').notNull().default('draft'),
    /** Finales, immutables PDF (Phase-3-Dokumententität). */
    documentId: uuid('document_id').references(() => documents.id),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('delivery_notes_process_idx').on(table.processId)],
);

/**
 * Tatsächlich geplante/ausgegebene Verbrauchs-, Kommissions- und
 * Kaufartikel (Order §14): Soll aus Buchung/Zusatzposition, Ist editierbar
 * bis zur Finalisierung. Konkrete Maschinen kommen aus den Assignments.
 */
export const deliveryNoteItems = pgTable(
  'delivery_note_items',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    deliveryNoteId: uuid('delivery_note_id')
      .notNull()
      .references(() => deliveryNotes.id),
    position: integer('position').notNull(),
    kind: deliveryNoteItemKind('kind').notNull(),
    productId: uuid('product_id').references(() => products.id),
    inventoryItemId: uuid('inventory_item_id').references(() => inventoryItems.id),
    bookingAdditionId: uuid('booking_addition_id').references(() => bookingAdditions.id),
    description: text('description').notNull(),
    unit: text('unit').notNull(),
    plannedQuantity: integer('planned_quantity').notNull(),
    actualQuantity: integer('actual_quantity').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    billingMode: text('billing_mode').notNull(), // 'included' | 'commission' | 'fixed'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('delivery_note_items_note_idx').on(table.deliveryNoteId),
    check('delivery_note_items_planned_check', sql`"planned_quantity" >= 0`),
    check('delivery_note_items_actual_check', sql`"actual_quantity" >= 0`),
  ],
);

// ── Abholperson / Vertreter (Order §§29–31) ───────────────────────────────

/**
 * Genau EINE aktuelle alternative Abholperson je Buchung (Ersetzen
 * überschreibt). Telefon ist ephemer (MASTER_SPEC §12: nach Abschluss
 * löschen, Name bleibt). Kein Ausweis, keine Ausweisnummer, kein Foto.
 */
export const bookingPickupRepresentatives = pgTable('booking_pickup_representatives', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  bookingId: uuid('booking_id')
    .notNull()
    .unique()
    .references(() => bookings.id),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  phone: text('phone'),
  phoneDeletedAt: timestamp('phone_deleted_at', { withTimezone: true }),
  updatedBy: uuid('updated_by').references(() => staffUsers.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Übergabe (Order §§24–44) ──────────────────────────────────────────────

export const handoverStatus = pgEnum('handover_status', ['draft', 'finalized']);

export const handoverRecipientKind = pgEnum('handover_recipient_kind', [
  'customer',
  'representative',
  'other',
]);

export const handovers = pgTable(
  'handovers',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    bookingId: uuid('booking_id')
      .notNull()
      .unique()
      .references(() => bookings.id),
    processId: uuid('process_id')
      .notNull()
      .references(() => processes.id),
    status: handoverStatus('status').notNull().default('draft'),
    /** Tatsächliche Abhol-/Empfangsperson (Order §31/§32). */
    recipientKind: handoverRecipientKind('recipient_kind'),
    recipientName: text('recipient_name'),
    /** Ephemer – bei Finalisierung gelöscht (ARCHITECTURE „Datenschutz“). */
    recipientPhone: text('recipient_phone'),
    /** Zu erledigender Ausgabe-/Liefertermin (pickup/delivery). */
    appointmentId: uuid('appointment_id').references(() => appointments.id),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    finalizedBy: uuid('finalized_by').references(() => staffUsers.id),
    /**
     * Abweichende tatsächliche Ausgabezeit (Order §43): NUR gesetzt, wenn
     * sie vom Finalisierungs-/Planzeitpunkt abweicht bzw. korrigiert wurde.
     */
    actualIssueAt: timestamp('actual_issue_at', { withTimezone: true }),
    actualIssueCorrectedBy: uuid('actual_issue_corrected_by').references(() => staffUsers.id),
    actualIssueCorrectedAt: timestamp('actual_issue_corrected_at', { withTimezone: true }),
    protocolDocumentId: uuid('protocol_document_id').references(() => documents.id),
    createdBy: uuid('created_by').references(() => staffUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('handovers_process_idx').on(table.processId)],
);

/** Aktive Übergabeprüfung je physischer Maschine (Order §25). */
export const handoverMachineChecks = pgTable(
  'handover_machine_checks',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    handoverId: uuid('handover_id')
      .notNull()
      .references(() => handovers.id),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => machineAssignments.id),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id),
    checkedBy: uuid('checked_by')
      .notNull()
      .references(() => staffUsers.id),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('handover_machine_checks_assignment_unique').on(table.assignmentId)],
);

/**
 * Pflicht-Gesamtfoto je Maschine (Order §27): privater Storage, SHA-256,
 * Zeitpunkt, Mitarbeiterbezug. Interne Beweissicherung – nicht im
 * Kunden-PDF.
 */
export const handoverPhotos = pgTable(
  'handover_photos',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    handoverId: uuid('handover_id')
      .notNull()
      .references(() => handovers.id),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => machineAssignments.id),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id),
    storageKey: text('storage_key').notNull().unique(),
    mimeType: text('mime_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    takenBy: uuid('taken_by')
      .notNull()
      .references(() => staffUsers.id),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('handover_photos_handover_idx').on(table.handoverId)],
);

export const handoverSignatureRole = pgEnum('handover_signature_role', ['customer', 'staff']);

/**
 * Gezeichnete Unterschriften (Order §§33–35): privat gespeichert; der
 * Mitarbeiter-Unterzeichner kommt aus der authentifizierten Session.
 */
export const handoverSignatures = pgTable(
  'handover_signatures',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    handoverId: uuid('handover_id')
      .notNull()
      .references(() => handovers.id),
    role: handoverSignatureRole('role').notNull(),
    signerName: text('signer_name').notNull(),
    signerUserId: uuid('signer_user_id').references(() => staffUsers.id),
    storageKey: text('storage_key').notNull().unique(),
    mimeType: text('mime_type').notNull().default('image/png'),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('handover_signatures_role_unique').on(table.handoverId, table.role)],
);

// ── Dokumentpaket / Outbox-Grundlage (Order §39) ──────────────────────────

export const deliveryPacketStatus = pgEnum('delivery_packet_status', ['ready', 'sent']);

/**
 * Fachliches Versandpaket: nach der Ausgabe EINE E-Mail mit Lieferschein +
 * Übergabeprotokoll. Phase 6 markiert nur „versandbereit“; „sent“ setzt erst
 * ein echter Mailadapter (Phase 12) – nie eine vorgetäuschte Zustellung.
 */
export const deliveryPackets = pgTable(
  'delivery_packets',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    kind: text('kind').notNull(), // 'handover_completed'
    processId: uuid('process_id')
      .notNull()
      .references(() => processes.id),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    handoverId: uuid('handover_id').references(() => handovers.id),
    recipient: text('recipient').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    /** Geordnete Dokument-IDs (genau die finalen Anhänge). */
    documentIds: jsonb('document_ids').notNull(),
    status: deliveryPacketStatus('status').notNull().default('ready'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** Genau EIN Paket je Übergabe (idempotente Finalisierung). */
    uniqueIndex('delivery_packets_handover_kind_unique').on(table.handoverId, table.kind),
    index('delivery_packets_process_idx').on(table.processId),
  ],
);

export type MachineAssignment = typeof machineAssignments.$inferSelect;
export type MachineAssignmentOverride = typeof machineAssignmentOverrides.$inferSelect;
export type MachineRiskIncident = typeof machineRiskIncidents.$inferSelect;
export type BookingAddition = typeof bookingAdditions.$inferSelect;
export type DeliveryNote = typeof deliveryNotes.$inferSelect;
export type DeliveryNoteItem = typeof deliveryNoteItems.$inferSelect;
export type BookingPickupRepresentative = typeof bookingPickupRepresentatives.$inferSelect;
export type Handover = typeof handovers.$inferSelect;
export type HandoverMachineCheck = typeof handoverMachineChecks.$inferSelect;
export type HandoverPhoto = typeof handoverPhotos.$inferSelect;
export type HandoverSignature = typeof handoverSignatures.$inferSelect;
export type DeliveryPacket = typeof deliveryPackets.$inferSelect;
