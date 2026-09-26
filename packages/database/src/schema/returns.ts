import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
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
import {
  deliveryNoteItemKind,
  deliveryNoteItems,
  handoverRecipientKind,
  handoverSignatureRole,
  machineAssignments,
} from './handover.ts';

/**
 * Phase 7: Rückgabe, Zubehör-/Sauberkeitskontrolle, Reinigungsgebühr-Fakt,
 * Kommissionsrückgabe, Schäden (Schema-Markierungen, Fotos), Fehlteile,
 * technische Defekte, Rückgabeprotokoll (MASTER_SPEC §§141–181, DOMAIN_RULES
 * „Rückgabevorbereitung“/„Zubehör“/„Schäden“, DATA_MODEL Return/
 * ReturnMachineCheck/ReturnAccessoryCheck/CommissionReturn/MachineDamage/
 * DamageMarker/DamagePhoto/MissingItemCase, Phase-7-Order §§3, 10–13, 17–26,
 * 28–29, 31, 37, 39, 43, 50, 52, 67).
 *
 * Bewusst NICHT hier (Phase 9+): Settlement-/Rechnungs-/Lexware-Tabellen,
 * Schadensbeträge, Fehlteil-Ersatzkosten (Order §82).
 */

export const rentalReturnStatus = pgEnum('rental_return_status', ['draft', 'finalized']);

/**
 * Genau EINE normale Rückgabe je ausgegebener Buchung (Order §3/§7): alle
 * ausgegebenen Maschinen werden gemeinsam zurückgenommen, ein kombiniertes
 * Protokoll. Rückgabeperson wie die Abholperson der Phase 6: Name bleibt
 * historisch, Telefon ist ephemer (nach Abschluss gelöscht, Order §8).
 * Tatsächliche Rückgabezeit: vor der Finalisierung frei korrigierbar
 * (`draft_actual_return_at`), bei Finalisierung eingefroren
 * (`original_actual_return_at`); spätere Korrekturen separat (Order §50).
 */
export const rentalReturns = pgTable(
  'rental_returns',
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
    status: rentalReturnStatus('status').notNull().default('draft'),
    startedBy: uuid('started_by').references(() => staffUsers.id),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    returnerKind: handoverRecipientKind('returner_kind'),
    returnerName: text('returner_name'),
    /** Ephemer – bei Finalisierung gelöscht (ARCHITECTURE „Datenschutz“). */
    returnerPhone: text('returner_phone'),
    returnerPhoneDeletedAt: timestamp('returner_phone_deleted_at', { withTimezone: true }),
    /** Fachlich abzuschließender Rückgabetermin (Phase 4). */
    returnAppointmentId: uuid('return_appointment_id').references(() => appointments.id),
    /** Vor der Finalisierung erfasste abweichende Rückgabezeit (mit Recht). */
    draftActualReturnAt: timestamp('draft_actual_return_at', { withTimezone: true }),
    actualReturnAt: timestamp('actual_return_at', { withTimezone: true }),
    originalActualReturnAt: timestamp('original_actual_return_at', { withTimezone: true }),
    correctedActualReturnAt: timestamp('corrected_actual_return_at', { withTimezone: true }),
    correctedBy: uuid('corrected_by').references(() => staffUsers.id),
    correctedAt: timestamp('corrected_at', { withTimezone: true }),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    finalizedBy: uuid('finalized_by').references(() => staffUsers.id),
    protocolDocumentId: uuid('protocol_document_id').references(() => documents.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('rental_returns_process_idx').on(table.processId),
    // Finalisiert ⇒ Zeitstempel, Protokoll vorhanden und Telefonnummer gelöscht (Order §§8/47).
    check(
      'rental_returns_finalized_check',
      sql`"status" <> 'finalized' OR ("finalized_at" IS NOT NULL AND "actual_return_at" IS NOT NULL AND "original_actual_return_at" IS NOT NULL AND "protocol_document_id" IS NOT NULL AND "returner_phone" IS NULL)`,
    ),
  ],
);

/**
 * Je ausgegebener Maschine (machine_assignment) ein Rückgabeabschnitt:
 * Zubehör-Soll aus dem Maschinentyp (1 Behälter: 1 Deckel + 1 Tropfschale,
 * 2 Behälter: 2 + 2; Order §10), aktive Zubehör- und Sauberkeitskontrolle
 * (entleert, zweimal gespült, nichts demontiert; Order §15) und der
 * unveränderliche Reinigungsgebühr-Fakt (Order §17): `cleanup_required` +
 * `cleanup_fee_snapshot_cents` (7500) + Grund – KEINE Settlement-Position.
 */
export const returnMachines = pgTable(
  'return_machines',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    returnId: uuid('return_id')
      .notNull()
      .references(() => rentalReturns.id),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => machineAssignments.id),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    expectedLids: integer('expected_lids').notNull(),
    expectedDripTrays: integer('expected_drip_trays').notNull(),
    /** NULL = Zubehörkontrolle noch nicht bestätigt. */
    accessoryComplete: boolean('accessory_complete'),
    accessoryCheckedBy: uuid('accessory_checked_by').references(() => staffUsers.id),
    accessoryCheckedAt: timestamp('accessory_checked_at', { withTimezone: true }),
    /** NULL = Sauberkeitskontrolle noch nicht bestätigt (alle drei gemeinsam). */
    emptied: boolean('emptied'),
    rinsedTwice: boolean('rinsed_twice'),
    nothingDismantled: boolean('nothing_dismantled'),
    cleanlinessCheckedBy: uuid('cleanliness_checked_by').references(() => staffUsers.id),
    cleanlinessCheckedAt: timestamp('cleanliness_checked_at', { withTimezone: true }),
    cleanupRequired: boolean('cleanup_required').notNull().default(false),
    cleanupFeeSnapshotCents: integer('cleanup_fee_snapshot_cents'),
    cleanupReason: text('cleanup_reason'),
    /** Zeitpunkt, zu dem DIESE Maschine als zurückgegeben gilt (Order §7). */
    returnedAt: timestamp('returned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('return_machines_assignment_unique').on(table.assignmentId),
    index('return_machines_return_idx').on(table.returnId),
    index('return_machines_machine_idx').on(table.machineId),
    check(
      'return_machines_expected_check',
      sql`"expected_lids" >= 0 AND "expected_drip_trays" >= 0`,
    ),
    check(
      'return_machines_cleanup_check',
      sql`("cleanup_required" = false AND "cleanup_fee_snapshot_cents" IS NULL) OR ("cleanup_required" = true AND "cleanup_fee_snapshot_cents" > 0)`,
    ),
  ],
);

/**
 * Kommissions-/Inklusivrückgabe je tatsächlich ausgegebener Lieferschein-
 * Position (Order §§19–25): nur die UNGEÖFFNET zurückgegebene Menge wird
 * erfasst; abrechenbare Menge = ausgegeben − ungeöffnet zurück; Einzelpreis
 * ist der eingefrorene Ausgabe-Snapshot. Vorläufiger Betrag – KEINE
 * Settlement-Position (Phase 9). Kaufartikel (Kanister) haben keine Zeile.
 */
export const returnInventoryItems = pgTable(
  'return_inventory_items',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    returnId: uuid('return_id')
      .notNull()
      .references(() => rentalReturns.id),
    deliveryNoteItemId: uuid('delivery_note_item_id')
      .notNull()
      .references(() => deliveryNoteItems.id),
    /** null = Verbrauchsartikel ohne Lagerartikel: Kommissionsfakt ohne Ledger-Bewegung. */
    inventoryItemId: uuid('inventory_item_id').references(() => inventoryItems.id),
    productId: uuid('product_id').references(() => products.id),
    kind: deliveryNoteItemKind('kind').notNull(),
    description: text('description').notNull(),
    unit: text('unit').notNull(),
    issuedQuantity: integer('issued_quantity').notNull(),
    returnedUnopenedQuantity: integer('returned_unopened_quantity').notNull().default(0),
    unitPriceSnapshotCents: integer('unit_price_snapshot_cents').notNull(),
    /** Bei Finalisierung eingefroren (nur Kommission > 0). */
    chargeableQuantity: integer('chargeable_quantity'),
    chargeableAmountCents: integer('chargeable_amount_cents'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('return_inventory_items_item_unique').on(table.returnId, table.deliveryNoteItemId),
    check('return_inventory_items_issued_check', sql`"issued_quantity" >= 0`),
    check(
      'return_inventory_items_returned_check',
      sql`"returned_unopened_quantity" >= 0 AND "returned_unopened_quantity" <= "issued_quantity"`,
    ),
    check('return_inventory_items_price_check', sql`"unit_price_snapshot_cents" >= 0`),
  ],
);

/** Beweisfoto je betroffener Maschine bei Reinigungsgebühr (Order §18). */
export const returnPhotos = pgTable(
  'return_photos',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    returnId: uuid('return_id')
      .notNull()
      .references(() => rentalReturns.id),
    returnMachineId: uuid('return_machine_id')
      .notNull()
      .references(() => returnMachines.id),
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
  (table) => [index('return_photos_return_machine_idx').on(table.returnMachineId)],
);

// ── Schäden (Order §§26–38) ────────────────────────────────────────────────

export const damageSeverity = pgEnum('damage_severity', ['light', 'medium', 'severe']);
export const damageOrigin = pgEnum('damage_origin', ['return', 'post_return_finding']);
export const damageView = pgEnum('damage_view', ['front', 'back', 'left', 'right']);
export const damageMarkerType = pgEnum('damage_marker_type', ['point', 'area']);

/**
 * Dokumentierter Schaden (KEIN Geldbetrag, Order §27): mit Rückgabe
 * verknüpft, Schweregrad leicht/mittel/schwer, Pflichtbeschreibung, ≥ 1 Foto,
 * ≥ 1 Markierung. `activated_at` = ab wann er „aktueller Schaden“ der
 * Maschine ist (Rückgabeschaden: bei Finalisierung; nachträgliche
 * Feststellung: sofort); `resolved_at` = „nicht mehr aktuell“ (Order §34) –
 * nie gelöscht, alte Protokolle unverändert.
 */
export const machineDamages = pgTable(
  'machine_damages',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id),
    returnId: uuid('return_id')
      .notNull()
      .references(() => rentalReturns.id),
    returnMachineId: uuid('return_machine_id')
      .notNull()
      .references(() => returnMachines.id),
    origin: damageOrigin('origin').notNull().default('return'),
    severity: damageSeverity('severity').notNull(),
    description: text('description').notNull(),
    requiresFinancialReview: boolean('requires_financial_review').notNull().default(true),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => staffUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => staffUsers.id),
  },
  (table) => [
    index('machine_damages_machine_idx').on(table.machineId),
    index('machine_damages_return_idx').on(table.returnId),
    check('machine_damages_description_check', sql`length(trim("description")) > 0`),
    // Nachträgliche Feststellung ist sofort aktuell (Order §37).
    check(
      'machine_damages_post_return_check',
      sql`"origin" <> 'post_return_finding' OR "activated_at" IS NOT NULL`,
    ),
  ],
);

/**
 * Markierung am Maschinenschema, grafikunabhängig (Order §29): Ansicht,
 * Typ Punkt/Fläche, normalisierte Koordinaten 0..1 (Fläche zusätzlich mit
 * Breite/Höhe 0..1). Echte Grafiken können später ohne Datenmigration
 * getauscht werden.
 */
export const damageMarkers = pgTable(
  'damage_markers',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    damageId: uuid('damage_id')
      .notNull()
      .references(() => machineDamages.id),
    view: damageView('view').notNull(),
    markerType: damageMarkerType('marker_type').notNull(),
    x: doublePrecision('x').notNull(),
    y: doublePrecision('y').notNull(),
    width: doublePrecision('width'),
    height: doublePrecision('height'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('damage_markers_damage_idx').on(table.damageId),
    check('damage_markers_xy_check', sql`"x" >= 0 AND "x" <= 1 AND "y" >= 0 AND "y" <= 1`),
    check(
      'damage_markers_area_check',
      sql`("marker_type" = 'point' AND "width" IS NULL AND "height" IS NULL) OR ("marker_type" = 'area' AND "width" > 0 AND "height" > 0 AND "x" + "width" <= 1 AND "y" + "height" <= 1)`,
    ),
  ],
);

/** Schadensfoto: privat, integritätsgesichert, ohne Kundendaten im Schlüssel (Order §31). */
export const damagePhotos = pgTable(
  'damage_photos',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    damageId: uuid('damage_id')
      .notNull()
      .references(() => machineDamages.id),
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
  (table) => [index('damage_photos_damage_idx').on(table.damageId)],
);

// ── Fehlteile (Order §§12–14, 55) ──────────────────────────────────────────

export const accessoryType = pgEnum('accessory_type', ['lid', 'drip_tray']);
export const missingAccessoryStatus = pgEnum('missing_accessory_status', ['open', 'resolved']);

/**
 * Fehlteil-Fall: bewusst vom Mitarbeiter angelegt, kein Foto, kein Betrag;
 * offener Follow-up ohne Fälligkeit (ab Finalisierung aktiv); „Fehlteil
 * erledigt“ mit einem Klick; `requires_financial_review` solange offen.
 */
export const missingAccessoryCases = pgTable(
  'missing_accessory_cases',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    returnId: uuid('return_id')
      .notNull()
      .references(() => rentalReturns.id),
    returnMachineId: uuid('return_machine_id')
      .notNull()
      .references(() => returnMachines.id),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id),
    accessoryType: accessoryType('accessory_type').notNull(),
    missingQuantity: integer('missing_quantity').notNull(),
    description: text('description'),
    status: missingAccessoryStatus('status').notNull().default('open'),
    requiresFinancialReview: boolean('requires_financial_review').notNull().default(true),
    /** Gesetzt bei Finalisierung der Rückgabe (Follow-up aktiv). */
    followUpOpenedAt: timestamp('follow_up_opened_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => staffUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedBy: uuid('resolved_by').references(() => staffUsers.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    index('missing_accessory_cases_return_idx').on(table.returnId),
    index('missing_accessory_cases_machine_idx').on(table.machineId),
    check('missing_accessory_cases_quantity_check', sql`"missing_quantity" >= 1`),
    check(
      'missing_accessory_cases_resolved_check',
      sql`"status" <> 'resolved' OR ("resolved_at" IS NOT NULL AND "resolved_by" IS NOT NULL)`,
    ),
  ],
);

// ── Technische Defekte nach Rückgabe (Order §§39/40) ─────────────────────

/**
 * Interner technischer Defekt, mit der letzten Rückgabe verknüpft, solange
 * die Maschine nicht erneut ausgegeben wurde. Keine Kundenbelastung,
 * `requires_financial_review` standardmäßig false; Foto optional.
 */
export const technicalDefects = pgTable(
  'technical_defects',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id),
    returnId: uuid('return_id')
      .notNull()
      .references(() => rentalReturns.id),
    processId: uuid('process_id')
      .notNull()
      .references(() => processes.id),
    description: text('description').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    photoStorageKey: text('photo_storage_key').unique(),
    photoMimeType: text('photo_mime_type'),
    photoByteSize: integer('photo_byte_size'),
    photoSha256: text('photo_sha256'),
    requiresFinancialReview: boolean('requires_financial_review').notNull().default(false),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => staffUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('technical_defects_machine_idx').on(table.machineId),
    check('technical_defects_description_check', sql`length(trim("description")) > 0`),
  ],
);

// ── Unterschriften der Rückgabe (Order §43) ───────────────────────────────

export const returnSignatures = pgTable(
  'return_signatures',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    returnId: uuid('return_id')
      .notNull()
      .references(() => rentalReturns.id),
    role: handoverSignatureRole('role').notNull(),
    signerName: text('signer_name').notNull(),
    signerUserId: uuid('signer_user_id').references(() => staffUsers.id),
    storageKey: text('storage_key').notNull().unique(),
    mimeType: text('mime_type').notNull().default('image/png'),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('return_signatures_role_unique').on(table.returnId, table.role)],
);

export type RentalReturn = typeof rentalReturns.$inferSelect;
export type ReturnMachine = typeof returnMachines.$inferSelect;
export type ReturnInventoryItem = typeof returnInventoryItems.$inferSelect;
export type ReturnPhoto = typeof returnPhotos.$inferSelect;
export type MachineDamage = typeof machineDamages.$inferSelect;
export type DamageMarker = typeof damageMarkers.$inferSelect;
export type DamagePhoto = typeof damagePhotos.$inferSelect;
export type MissingAccessoryCase = typeof missingAccessoryCases.$inferSelect;
export type TechnicalDefect = typeof technicalDefects.$inferSelect;
export type ReturnSignature = typeof returnSignatures.$inferSelect;
