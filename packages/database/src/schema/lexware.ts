import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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
import { accountingTransfers } from './settlement.ts';
import { staffUsers } from './staff-auth.ts';

/**
 * Phase 10 – Lexware Office Public API (docs/LEXWARE_API_NOTES.md).
 * Lexware-spezifische Metadaten liegen ausschließlich hier (Order §61/§75);
 * accounting_transfers/settlements/cancellations bleiben generisch.
 * Der API-Key steht NIE in der Datenbank.
 */

export const lexwareConnectionStatus = pgEnum('lexware_connection_status', [
  'not_configured',
  'connected',
  'error',
  'incomplete',
  /** token.revoked bzw. 401: Verbindung getrennt – keine automatischen Transfers. */
  'disconnected',
  /** Die Lexware-organizationId weicht vom gepinnten Wert ab – bewusste Neueinrichtung nötig (Order §7). */
  'organization_mismatch',
]);

export const lexwareContactSyncStatus = pgEnum('lexware_contact_sync_status', [
  'linked',
  /** Mehrere/unsichere Kandidaten – Admin wählt oder legt neu an (Order §17). */
  'review_required',
  /** Contact-Create ohne Antwort – Recovery vor erneutem Create (Order §33). */
  'create_unknown',
]);

export const lexwareWebhookEventStatus = pgEnum('lexware_webhook_event_status', [
  'queued',
  'processed',
  'ignored',
  'failed',
]);

/** Steuerliche Behandlung einer Abrechnungskategorie (Order §13) – nichts wird erfunden. */
export const accountingTaxTreatment = pgEnum('accounting_tax_treatment', ['taxable', 'vatfree']);

/**
 * Ein Datensatz je Umgebung (Spalte `environment` = APP_ENV): Verbindungs- und
 * Profilstand ohne Secrets. `organizationId` ist der gepinnte Wert; weicht ein
 * späteres Profil ab, bleibt der alte Wert stehen und `pendingOrganizationId`
 * trägt den neuen bis zur bewussten Bestätigung.
 */
export const lexwareIntegrationState = pgTable('lexware_integration_state', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  environment: text('environment').notNull().unique(),
  status: lexwareConnectionStatus('status').notNull().default('not_configured'),
  organizationId: text('organization_id'),
  pendingOrganizationId: text('pending_organization_id'),
  connectionId: text('connection_id'),
  companyName: text('company_name'),
  taxType: text('tax_type'),
  smallBusiness: boolean('small_business'),
  businessFeatures: jsonb('business_features'),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  /** Neutraler Fehlercode der letzten Prüfung (nie Rohfehler, nie Key). */
  lastErrorCode: text('last_error_code'),
  /** Webhook-Einrichtung: null | 'configured' | 'incomplete' | 'error'. */
  webhookStatus: text('webhook_status'),
  /** Eigene Subscriptions [{subscriptionId, eventType, callbackUrl}] – nie fremde. */
  subscriptions: jsonb('subscriptions'),
  webhooksCheckedAt: timestamp('webhooks_checked_at', { withTimezone: true }),
  disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
  /** Administrativ bestätigte Organisation (bei organization_mismatch). */
  organizationConfirmedBy: uuid('organization_confirmed_by').references(() => staffUsers.id),
  organizationConfirmedAt: timestamp('organization_confirmed_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Kunde ↔ Lexware-Kontakt (Order §16): ein aktives Mapping je Kunde, ein Kunde je Lexware-Kontakt. */
export const lexwareContactMappings = pgTable(
  'lexware_contact_mappings',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    customerId: uuid('customer_id')
      .notNull()
      .unique()
      .references(() => customers.id),
    organizationId: text('organization_id').notNull(),
    lexwareContactId: text('lexware_contact_id'),
    /** Letzte bekannte Lexware-`version` (Optimistic Locking bei PUT). */
    contactVersion: integer('contact_version'),
    syncStatus: lexwareContactSyncStatus('sync_status').notNull().default('linked'),
    /** Kandidaten bei review_required: [{contactId, displayName, email, reason}] – keine Rohdaten darüber hinaus. */
    candidates: jsonb('candidates'),
    /** Zur Identität eines unbeantworteten Creates (Recovery): normalisierte E-Mail/Name. */
    pendingIdentity: jsonb('pending_identity'),
    linkedAt: timestamp('linked_at', { withTimezone: true }),
    linkedBy: uuid('linked_by').references(() => staffUsers.id),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    /** Hash des zuletzt an Lexware gesendeten Kontaktstands (vermeidet unnötige PUTs). */
    lastSyncedHash: text('last_synced_hash'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('lexware_contact_mappings_contact_unique')
      .on(table.organizationId, table.lexwareContactId)
      .where(sql`"lexware_contact_id" IS NOT NULL`),
    check(
      'lexware_contact_mappings_linked_check',
      sql`("sync_status" <> 'linked') OR ("lexware_contact_id" IS NOT NULL)`,
    ),
  ],
);

/** Lexware-Rechnung je accounting_transfer (Order §61). */
export const lexwareInvoiceMappings = pgTable(
  'lexware_invoice_mappings',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountingTransferId: uuid('accounting_transfer_id')
      .notNull()
      .unique()
      .references(() => accountingTransfers.id),
    organizationId: text('organization_id').notNull(),
    /** Stabiler, kundentauglicher Wiedererkennungsmarker (Order §31) – im Beleg-Remark. */
    transferMarker: text('transfer_marker').notNull().unique(),
    lexwareContactId: text('lexware_contact_id'),
    lexwareInvoiceId: text('lexware_invoice_id').unique(),
    voucherNumber: text('voucher_number'),
    voucherStatus: text('voucher_status'),
    voucherDate: date('voucher_date'),
    dueDate: date('due_date'),
    /** Erwartete Bruttosumme laut Provider-Snapshot (Cent) – Summenvalidierung (Order §64). */
    expectedGrossCents: integer('expected_gross_cents').notNull(),
    openAmountCents: integer('open_amount_cents'),
    paymentStatus: text('payment_status'),
    paidDate: date('paid_date'),
    /** 'pending' nach Erstellung; Phase 12 setzt 'sent'. Phase 10 setzt NIE 'sent'. */
    deliveryStatus: text('delivery_status').notNull().default('pending'),
    /** Phase 12: Outbox-Zustellung der Rechnungsmail (mail_deliveries) – kein FK (Importzyklus). */
    mailDeliveryId: uuid('mail_delivery_id'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    attentionCode: text('attention_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('lexware_invoice_mappings_status_idx').on(table.paymentStatus, table.voucherStatus),
    check('lexware_invoice_mappings_delivery_check', sql`"delivery_status" IN ('pending', 'sent')`),
  ],
);

/** Eingehende Webhooks, dedupliziert über den Fingerprint (Order §47). */
export const lexwareWebhookEvents = pgTable(
  'lexware_webhook_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    fingerprint: text('fingerprint').notNull().unique(),
    organizationId: text('organization_id').notNull(),
    eventType: text('event_type').notNull(),
    resourceId: text('resource_id').notNull(),
    eventDate: timestamp('event_date', { withTimezone: true }).notNull(),
    status: lexwareWebhookEventStatus('status').notNull().default('queued'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    /** Neutraler Ergebnis-/Fehlercode der Verarbeitung. */
    resultCode: text('result_code'),
  },
  (table) => [index('lexware_webhook_events_resource_idx').on(table.resourceId, table.eventType)],
);

/**
 * Gemeinsamer Rate-Limit-Zustand für API und Worker (Order §11): genau eine
 * Zeile; `nextSlotAt` ist der früheste Zeitpunkt des nächsten Requests. Der
 * Slot wird in einer kurzen Transaktion reserviert; gewartet wird außerhalb.
 */
export const lexwareRateLimit = pgTable('lexware_rate_limit', {
  id: integer('id').primaryKey(),
  nextSlotAt: timestamp('next_slot_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Explizite Steuerkonfiguration je Abrechnungskategorie (Order §13/§62).
 * Es gibt KEINE Produktionsdefaults; `synthetic = true` kennzeichnet
 * Test-/Entwicklungswerte, die in production nie gelten.
 */
export const accountingTaxConfig = pgTable(
  'accounting_tax_config',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    category: text('category').notNull().unique(),
    treatment: accountingTaxTreatment('treatment').notNull(),
    /** Steuersatz in Basispunkten (1900 = 19,00 %); bei vatfree 0. */
    taxRateBp: integer('tax_rate_bp').notNull().default(0),
    synthetic: boolean('synthetic').notNull().default(false),
    updatedBy: uuid('updated_by').references(() => staffUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check('accounting_tax_config_rate_check', sql`"tax_rate_bp" >= 0 AND "tax_rate_bp" <= 10000`),
  ],
);

export type LexwareIntegrationStateRow = typeof lexwareIntegrationState.$inferSelect;
export type LexwareContactMappingRow = typeof lexwareContactMappings.$inferSelect;
export type LexwareInvoiceMappingRow = typeof lexwareInvoiceMappings.$inferSelect;
export type LexwareWebhookEventRow = typeof lexwareWebhookEvents.$inferSelect;
export type AccountingTaxConfigRow = typeof accountingTaxConfig.$inferSelect;
