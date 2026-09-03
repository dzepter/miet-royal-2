import { sql } from 'drizzle-orm';
import {
  check,
  date,
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
import { products } from './commerce.ts';

/**
 * Phase 5: Physische Maschinen, Sperren und Lagerbestand (MASTER_SPEC
 * Nr. 11/28, DATA_MODEL "Machine"/"MachineBlock"/"InventoryItem"/
 * "InventoryMovement"/"InventoryCount", Phase-5-Order §§2–13, 25–37, 50).
 *
 * Bewusst NICHT hier (spätere Phasen): machine_assignments, Übergabe-/
 * Rückgabeprotokolle, Schäden, Reinigungshistorie, Touren, Lexware,
 * Push-Zustellung (Order §50/§60).
 */

/**
 * Maschinenstatus (Order §5). Technische Namen englisch, UI deutsch:
 * ready=Einsatzbereit, rented=Vermietet, reserved=Reserviert,
 * cleaning=Reinigung, repair=Reparatur, out_of_service=Außer Betrieb.
 * rented/reserved werden erst durch die Fachprozesse späterer Phasen
 * gesetzt (Order §6) – Phase 5 erlaubt sie nicht als manuellen Status.
 */
export const machineStatus = pgEnum('machine_status', [
  'ready',
  'rented',
  'reserved',
  'cleaning',
  'repair',
  'out_of_service',
]);

/** Standortarten (Order §8) – bewusst KEINE Fahrzeugverwaltung. */
export const machineLocationKind = pgEnum('machine_location_kind', [
  'warehouse',
  'customer',
  'staff',
  'repair',
  'other',
]);

export const machines = pgTable(
  'machines',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /**
     * Miet-Royal-Maschinen-ID (Order §3): MR-[Liter]-[Behälter]-[Laufnummer],
     * serverseitig vergeben, nach Vergabe UNVERÄNDERBAR, keine
     * Wiederverwendung. Kein frei editierbares Textfeld.
     */
    machineCode: text('machine_code').notNull(),
    /** Buchbarer Maschinentyp (Phase-3-Produkt, category='machine'). */
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    status: machineStatus('status').notNull().default('ready'),
    locationKind: machineLocationKind('location_kind').notNull().default('warehouse'),
    /** Kurze Ergänzung (z. B. Kundenname/Ort) – optional, keine Pflicht. */
    locationNote: text('location_note'),
    /** Optional – NIE erfinden (Order §4): NULL bis der Betreiber Werte liefert. */
    purchaseDate: date('purchase_date'),
    weightGrams: integer('weight_grams'),
    /**
     * Sicherer, opaker QR-Identifier (Order §10): zufällig, ohne Klartext-
     * Details; Auflösung nur nach Staff-Authentifizierung. Kein Bearer-
     * Ersatz – Rechteprüfung bleibt immer serverseitig bestehen.
     */
    qrToken: text('qr_token').notNull(),
    /** Referenzfoto im privaten Storage (Order §9); NULL = Platzhalter. */
    referencePhotoKey: text('reference_photo_key'),
    referencePhotoMime: text('reference_photo_mime'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('machines_code_unique').on(table.machineCode),
    uniqueIndex('machines_qr_token_unique').on(table.qrToken),
    index('machines_product_idx').on(table.productId),
    check('machines_code_format_check', sql`"machine_code" ~ '^MR-[0-9]{2}-[0-9]{2}-[0-9]{2,}$'`),
  ],
);

/**
 * Manuelle Maschinensperren (Order §§12/13): Zeitraum + PFLICHTGRUND.
 * Aufheben setzt liftedAt/liftedBy (keine Pflichtbegründung); historische
 * Datensätze bleiben aus Integritätsgründen bestehen.
 */
export const machineBlocks = pgTable(
  'machine_blocks',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by').references(() => staffUsers.id),
    liftedAt: timestamp('lifted_at', { withTimezone: true }),
    liftedBy: uuid('lifted_by').references(() => staffUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('machine_blocks_machine_idx').on(table.machineId, table.startsAt),
    check('machine_blocks_range_check', sql`"ends_at" > "starts_at"`),
    check('machine_blocks_reason_check', sql`length(btrim("reason")) > 0`),
  ],
);

/**
 * Lagerartikel (Order §§25–27): verweist auf das bestehende Phase-3-
 * Produkt (keine parallelen Stammdaten, Einheit = products.sale_unit).
 * current_stock NULL = "Noch nicht initial erfasst" – es wird NIE still
 * 0 als vermeintlich realer Bestand gesetzt. min_stock NULL =
 * "Mindestbestand nicht festgelegt" (keine erfundenen Grenzwerte).
 * Bestände sind GANZE Lagereinheiten (Integer, keine Float-Arithmetik).
 */
export const inventoryItems = pgTable(
  'inventory_items',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    currentStock: integer('current_stock'),
    minStock: integer('min_stock'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('inventory_items_product_unique').on(table.productId),
    check('inventory_items_min_stock_check', sql`"min_stock" IS NULL OR "min_stock" >= 0`),
  ],
);

export const inventoryStocktakeStatus = pgEnum('inventory_stocktake_status', [
  'completed',
  'pending_approval',
  'approved',
]);

/**
 * Inventuren (Order §§34–36): Speichern ändert den Bestand NICHT;
 * erst die Freigabe (approve) erzeugt je Artikel genau eine Bewegung.
 * Die erste freigegebene Erfassung initialisiert den Bestand
 * ("Anfangsbestand erfassen").
 */
export const inventoryStocktakes = pgTable('inventory_stocktakes', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  status: inventoryStocktakeStatus('status').notNull(),
  createdBy: uuid('created_by').references(() => staffUsers.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  approvedBy: uuid('approved_by').references(() => staffUsers.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
});

/**
 * Bewegungsarten (Order §32): initial (freigegebene Erstinventur),
 * incoming (Wareneingang), issue/return (erst Phase 6/7 aktiv),
 * inventory_adjustment (freigegebene Inventurkorrektur).
 */
export const inventoryMovementKind = pgEnum('inventory_movement_kind', [
  'initial',
  'incoming',
  'issue',
  'return',
  'inventory_adjustment',
]);

/**
 * Zentrales Bestandsledger (Order §32): JEDE echte Bestandsänderung
 * resultiert nachvollziehbar aus genau einer Bewegung – keine stillen
 * current_stock-Updates. resulting_stock dokumentiert den Stand NACH der
 * Bewegung (Nachvollziehbarkeit + Konsistenzprüfung).
 */
export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    itemId: uuid('item_id')
      .notNull()
      .references(() => inventoryItems.id),
    kind: inventoryMovementKind('kind').notNull(),
    /** Vorzeichenbehaftete Menge in ganzen Lagereinheiten. */
    quantityDelta: integer('quantity_delta').notNull(),
    resultingStock: integer('resulting_stock').notNull(),
    stocktakeId: uuid('stocktake_id').references(() => inventoryStocktakes.id),
    createdBy: uuid('created_by').references(() => staffUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('inventory_movements_item_idx').on(table.itemId, table.createdAt),
    // Nur die Erstinventur darf Delta 0 haben (Anfangsbestand 0 gezählt).
    check('inventory_movements_delta_check', sql`"kind" = 'initial' OR "quantity_delta" <> 0`),
    check('inventory_movements_resulting_check', sql`"resulting_stock" >= 0`),
  ],
);

export const inventoryStocktakeItems = pgTable(
  'inventory_stocktake_items',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    stocktakeId: uuid('stocktake_id')
      .notNull()
      .references(() => inventoryStocktakes.id),
    itemId: uuid('item_id')
      .notNull()
      .references(() => inventoryItems.id),
    /** Systembestand zum Zählzeitpunkt; NULL = noch nicht initial erfasst. */
    systemStock: integer('system_stock'),
    /** Gezählter Ist-Bestand; vor Freigabe durch Admin korrigierbar. */
    countedStock: integer('counted_stock').notNull(),
    /**
     * Exklusivitäts-Backstop (Phase-5-Finalisierung): solange die Inventur
     * "Freigabe erforderlich" ist, trägt die Zeile hier den Artikel – der
     * partielle Unique-Index garantiert datenbankseitig höchstens EINE
     * offene Zählung je Artikel. Freigabe setzt das Feld auf NULL.
     */
    openItemId: uuid('open_item_id').references(() => inventoryItems.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('inventory_stocktake_items_unique').on(table.stocktakeId, table.itemId),
    uniqueIndex('inventory_stocktake_items_open_item_unique')
      .on(table.openItemId)
      .where(sql`"open_item_id" IS NOT NULL`),
    check('inventory_stocktake_items_counted_check', sql`"counted_stock" >= 0`),
  ],
);

export type Machine = typeof machines.$inferSelect;
export type MachineBlock = typeof machineBlocks.$inferSelect;
export type InventoryItem = typeof inventoryItems.$inferSelect;
export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type InventoryStocktake = typeof inventoryStocktakes.$inferSelect;
export type InventoryStocktakeItem = typeof inventoryStocktakeItems.$inferSelect;
