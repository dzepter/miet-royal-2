import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
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
import { customers } from './crm.ts';
import { processes } from './crm.ts';
import { staffUsers } from './staff-auth.ts';

/**
 * Phase 3: Produkte, Preise, Anfragen, Angebote & Auftragsbestätigung
 * (MASTER_SPEC §4/§5/§9/§10, DOMAIN_RULES Preise/Inklusiv/Rabatt/Angebot,
 * DATA_MODEL Product/ProductPrice/Inquiry/Offer/OfferVersion/Booking/
 * Document).
 *
 * Geldwerte IMMER als Integer-Cent (CLAUDE.md „Geld“ – niemals Float).
 * Prozentwerte als Basispunkte (10 % = 1000), exakt und float-frei.
 * Versendete Angebotsversionen, Buchungs-Snapshots und finale Dokumente
 * sind historisch unveränderbar.
 */

export const productCategory = pgEnum('product_category', [
  'machine',
  'syrup',
  'consumable',
  'purchase',
]);

export const billingMode = pgEnum('billing_mode', ['fixed', 'commission', 'included']);

export const offerStatus = pgEnum('offer_status', [
  'draft',
  'sent',
  'accepted',
  'declined',
  'expired',
  'recheck_requested',
]);

export const fulfillmentType = pgEnum('fulfillment_type', ['pickup', 'delivery']);

export const inquiryOccasion = pgEnum('inquiry_occasion', [
  'birthday',
  'wedding',
  'company_event',
  'club',
  'party',
  'school_kindergarten',
  'festival',
  'other',
]);

export const selectionRole = pgEnum('selection_role', ['free', 'extra']);

export const lineItemKind = pgEnum('line_item_kind', [
  'machine',
  'syrup',
  'consumable',
  'purchase',
  'delivery',
]);

export const priceSource = pgEnum('price_source', ['list', 'special', 'manual', 'included']);

export const discountType = pgEnum('discount_type', ['percent', 'fixed']);

export const orderConfirmationStatus = pgEnum('order_confirmation_status', [
  'prepared',
  'approved',
  'sent',
]);

export const documentType = pgEnum('document_type', [
  'offer',
  'order_confirmation',
  'delivery_note',
  'handover_protocol',
  'return_protocol',
]);

// ── Produktkatalog ─────────────────────────────────────────────────────────

export const products = pgTable('products', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  /** Stabiler technischer Key (Seed/Referenzen), nie umbenennen. */
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  category: productCategory('category').notNull(),
  description: text('description'),
  /** Verkaufseinheit, z. B. „Stück“, „1-L-Flasche“, „25er-Pack“. */
  saleUnit: text('sale_unit').notNull(),
  /** Standard-Abrechnungsart einer ZUSATZ-Position dieses Produkts. */
  defaultBillingMode: billingMode('default_billing_mode').notNull().default('fixed'),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  // Maschinentyp-Fachdaten (nur category='machine'):
  containerCount: integer('container_count'),
  containerVolumeLiters: integer('container_volume_liters'),
  /** Gewicht in Gramm – bewusst NULL, bis der Betreiber echte Werte liefert. */
  weightGrams: integer('weight_grams'),
  /** Personen zum Tragen (Transporthinweis AB): 1×… = 1, 2×… = 2. */
  carryPersons: integer('carry_persons'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Zeitgesteuerte Preise (DATA_MODEL „ProductPrice“): Der wirksame Preis zum
 * Zeitpunkt t ist die Zeile mit dem größten effective_from <= t. Geplante
 * zukünftige Preise (effective_from > jetzt) sind änder-/löschbar; es ist
 * KEIN Background-Job nötig.
 */
export const productPrices = pgTable(
  'product_prices',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    priceCents: integer('price_cents').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    createdBy: uuid('created_by').references(() => staffUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('product_prices_product_effective_idx').on(table.productId, table.effectiveFrom),
  ],
);

// ── Anfrage ────────────────────────────────────────────────────────────────

export const inquiries = pgTable('inquiries', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  /** Genau EIN Vorgang pro Anfrage (MASTER_SPEC §3). */
  processId: uuid('process_id')
    .notNull()
    .unique()
    .references(() => processes.id),
  eventDate: date('event_date'),
  eventStart: timestamp('event_start', { withTimezone: true }),
  eventEnd: timestamp('event_end', { withTimezone: true }),
  /** Exakter positiver Integer; ab 250: interner Großveranstaltungs-Hinweis. */
  guestCount: integer('guest_count'),
  occasion: inquiryOccasion('occasion'),
  machineProductId: uuid('machine_product_id').references(() => products.id),
  fulfillment: fulfillmentType('fulfillment').notNull().default('pickup'),
  deliveryStreet: text('delivery_street'),
  deliveryPostalCode: text('delivery_postal_code'),
  deliveryCity: text('delivery_city'),
  deliveryWindowFrom: timestamp('delivery_window_from', { withTimezone: true }),
  deliveryWindowTo: timestamp('delivery_window_to', { withTimezone: true }),
  collectionWindowFrom: timestamp('collection_window_from', { withTimezone: true }),
  collectionWindowTo: timestamp('collection_window_to', { withTimezone: true }),
  onsiteContactName: text('onsite_contact_name'),
  onsiteContactPhone: text('onsite_contact_phone'),
  createdBy: uuid('created_by').references(() => staffUsers.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Sirup-/Zubehörauswahl der Anfrage (free = Gratiskontingent, extra = Zusatz). */
export const inquirySelections = pgTable(
  'inquiry_selections',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    inquiryId: uuid('inquiry_id')
      .notNull()
      .references(() => inquiries.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    role: selectionRole('role').notNull(),
    quantity: integer('quantity').notNull(),
  },
  (table) => [index('inquiry_selections_inquiry_idx').on(table.inquiryId)],
);

// ── Angebot & Versionen ────────────────────────────────────────────────────

export const offers = pgTable('offers', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  processId: uuid('process_id')
    .notNull()
    .unique()
    .references(() => processes.id),
  currentVersionId: uuid('current_version_id'),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => staffUsers.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const offerVersions = pgTable(
  'offer_versions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id),
    versionNumber: integer('version_number').notNull(),
    status: offerStatus('status').notNull().default('draft'),
    // Entwurfs-Eingaben (nach Versand eingefroren):
    machineProductId: uuid('machine_product_id').references(() => products.id),
    machineQuantity: integer('machine_quantity').notNull().default(1),
    fulfillment: fulfillmentType('fulfillment').notNull().default('pickup'),
    deliveryStreet: text('delivery_street'),
    deliveryPostalCode: text('delivery_postal_code'),
    deliveryCity: text('delivery_city'),
    /** Manuell vereinbarter Lieferpreis („individuell geprüft“, §15). */
    deliveryPriceCents: integer('delivery_price_cents'),
    // Manueller Rabatt auf den Maschinenmieten-Subtotal (§18):
    discountType: discountType('discount_type'),
    /** percent: Basispunkte (10 % = 1000); fixed: Cent. */
    discountValue: integer('discount_value'),
    discountReason: text('discount_reason'),
    discountApprovedBy: uuid('discount_approved_by').references(() => staffUsers.id),
    discountApprovedAt: timestamp('discount_approved_at', { withTimezone: true }),
    // Eingefrorene Summen (beim Versand):
    machineSubtotalCents: integer('machine_subtotal_cents'),
    discountCents: integer('discount_cents'),
    fixedTotalCents: integer('fixed_total_cents'),
    // Versand-/Lebenszyklus:
    sentAt: timestamp('sent_at', { withTimezone: true }),
    sentBy: uuid('sent_by').references(() => staffUsers.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    recheckRequestedAt: timestamp('recheck_requested_at', { withTimezone: true }),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    /**
     * Sonderpreise je Positionsschlüssel (§19) – Teil der Entwurfs-Eingabe,
     * damit sie Neuberechnungen überleben:
     * [{ lineKey, unitPriceCents, previousStandardCents, byUserId, at }]
     */
    specialPrices: jsonb('special_prices'),
    /** Kunden-/Event-Snapshot, eingefroren beim Versand. */
    customerSnapshot: jsonb('customer_snapshot'),
    eventSnapshot: jsonb('event_snapshot'),
    termsVersionId: uuid('terms_version_id'),
    changeNote: text('change_note'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => staffUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('offer_versions_offer_version_idx').on(table.offerId, table.versionNumber),
  ],
);

/** Sirup-/Zubehörauswahl einer Angebotsversion (Entwurfs-Eingabe). */
export const offerVersionSelections = pgTable(
  'offer_version_selections',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    offerVersionId: uuid('offer_version_id')
      .notNull()
      .references(() => offerVersions.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    role: selectionRole('role').notNull(),
    quantity: integer('quantity').notNull(),
  },
  (table) => [index('offer_version_selections_version_idx').on(table.offerVersionId)],
);

/**
 * Angebotspositionen (Line Items, §17) – von der zentralen Preisengine
 * erzeugt; nach Versand eingefroren. Standard- UND vereinbarter Preis
 * bleiben getrennt erhalten (Basis späterer Storno-Berechnung).
 */
export const offerLineItems = pgTable(
  'offer_line_items',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    offerVersionId: uuid('offer_version_id')
      .notNull()
      .references(() => offerVersions.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    kind: lineItemKind('kind').notNull(),
    billingMode: billingMode('billing_mode').notNull(),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull(),
    unit: text('unit').notNull(),
    /** Standard-Listenpreis je Einheit (Cent). */
    standardUnitPriceCents: integer('standard_unit_price_cents').notNull(),
    /** Tatsächlich vereinbarter Einzelpreis (Cent; = Standard oder Sonderpreis). */
    agreedUnitPriceCents: integer('agreed_unit_price_cents').notNull(),
    totalCents: integer('total_cents').notNull(),
    priceSource: priceSource('price_source').notNull(),
    productId: uuid('product_id').references(() => products.id),
    /** Snapshot relevanter Produktdaten (Name, Einheit, Fachdaten). */
    productSnapshot: jsonb('product_snapshot'),
    // Sonderpreis-Nachvollziehbarkeit (§19):
    specialPriceBy: uuid('special_price_by').references(() => staffUsers.id),
    specialPriceAt: timestamp('special_price_at', { withTimezone: true }),
  },
  (table) => [index('offer_line_items_version_idx').on(table.offerVersionId)],
);

/** Sicherer öffentlicher Angebotszugang: Token NUR als SHA-256-Hash. */
export const offerAccessTokens = pgTable(
  'offer_access_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [index('offer_access_tokens_offer_idx').on(table.offerId)],
);

// ── Mietbedingungen (versioniert, §27) ─────────────────────────────────────

export const termsVersions = pgTable('terms_versions', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  label: text('label').notNull().unique(),
  content: text('content').notNull(),
  /** TEST-Platzhalter dürfen in Production niemals versendet werden. */
  isTest: boolean('is_test').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Buchung (Snapshot nach verbindlicher Annahme, §30) ─────────────────────

export const bookings = pgTable('bookings', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  processId: uuid('process_id')
    .notNull()
    .unique()
    .references(() => processes.id),
  offerId: uuid('offer_id')
    .notNull()
    .unique()
    .references(() => offers.id),
  offerVersionId: uuid('offer_version_id')
    .notNull()
    .unique()
    .references(() => offerVersions.id),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => customers.id),
  /** Eingefrorene Snapshots – spätere Profil-/Preisänderungen wirken NIE. */
  customerSnapshot: jsonb('customer_snapshot').notNull(),
  eventSnapshot: jsonb('event_snapshot').notNull(),
  itemsSnapshot: jsonb('items_snapshot').notNull(),
  totalsSnapshot: jsonb('totals_snapshot').notNull(),
  fulfillment: fulfillmentType('fulfillment').notNull(),
  deliverySnapshot: jsonb('delivery_snapshot'),
  termsVersionId: uuid('terms_version_id').references(() => termsVersions.id),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Auftragsbestätigung (§31) ──────────────────────────────────────────────

export const orderConfirmations = pgTable('order_confirmations', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  bookingId: uuid('booking_id')
    .notNull()
    .unique()
    .references(() => bookings.id),
  status: orderConfirmationStatus('status').notNull().default('prepared'),
  approvedBy: uuid('approved_by').references(() => staffUsers.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  documentId: uuid('document_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Dokumente (§34/§35/§37) ────────────────────────────────────────────────

export const documents = pgTable(
  'documents',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    type: documentType('type').notNull(),
    processId: uuid('process_id')
      .notNull()
      .references(() => processes.id),
    offerVersionId: uuid('offer_version_id').references(() => offerVersions.id),
    bookingId: uuid('booking_id').references(() => bookings.id),
    docVersion: integer('doc_version').notNull().default(1),
    storageKey: text('storage_key').notNull().unique(),
    sha256: text('sha256').notNull(),
    byteSize: integer('byte_size').notNull(),
    mimeType: text('mime_type').notNull().default('application/pdf'),
    /** Finale Dokumente sind immutable – niemals überschreiben. */
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('documents_process_idx').on(table.processId)],
);

// ── Versand-Outbox (Phase-3-Adapter, §24) ──────────────────────────────────

export const offerDeliveries = pgTable('offer_deliveries', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  kind: text('kind').notNull(), // 'offer' | 'order_confirmation'
  offerVersionId: uuid('offer_version_id').references(() => offerVersions.id),
  orderConfirmationId: uuid('order_confirmation_id').references(() => orderConfirmations.id),
  recipient: text('recipient').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Product = typeof products.$inferSelect;
export type ProductPrice = typeof productPrices.$inferSelect;
export type Inquiry = typeof inquiries.$inferSelect;
export type InquirySelection = typeof inquirySelections.$inferSelect;
export type Offer = typeof offers.$inferSelect;
export type OfferVersion = typeof offerVersions.$inferSelect;
export type OfferVersionSelection = typeof offerVersionSelections.$inferSelect;
export type OfferLineItem = typeof offerLineItems.$inferSelect;
export type TermsVersion = typeof termsVersions.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type OrderConfirmation = typeof orderConfirmations.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type OfferDelivery = typeof offerDeliveries.$inferSelect;
