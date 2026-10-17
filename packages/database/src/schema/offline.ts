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
import { staffSessions, staffUsers } from './staff-auth.ts';

/**
 * Phase 8 (Offlinebetrieb): das serverseitige Datenmodell besteht bewusst
 * NUR aus zwei Tabellen – der 72-h-Offline-Lease je Benutzer × Gerät ×
 * Umgebung (Order §8) und den Quittungen synchronisierter Mutationen
 * (Idempotenz, Order §§28/63/64). Fachdaten entstehen ausschließlich in den
 * bestehenden Tabellen der Phasen 1–7; der lokale Offline-Store ist nie eine
 * zweite Geschäftsdatenbank.
 */

/** Umgebungs-ID (APP_ENV) – Paket, Lease und Quittung tragen sie (Order §76). */
export const offlineEnvironment = pgEnum('offline_environment', [
  'development',
  'staging',
  'demo',
  'production',
]);

export const offlineAccessLeases = pgTable(
  'offline_access_leases',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    staffUserId: uuid('staff_user_id')
      .notNull()
      .references(() => staffUsers.id),
    /** Session, über die das Lease zuletzt ausgestellt/verlängert wurde (nur Nachvollziehbarkeit). */
    sessionId: uuid('session_id').references(() => staffSessions.id),
    /** Client-erzeugte Geräte-ID (UUID in localStorage) – kein Fingerprinting. */
    deviceId: uuid('device_id').notNull(),
    appEnv: offlineEnvironment('app_env').notNull(),
    /** Lease-Secret (Wrap B des lokalen DEK) – nur AES-256-GCM-verschlüsselt mit AUTH_SECRET_KEY. */
    leaseSecretEncrypted: text('lease_secret_encrypted').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    renewedAt: timestamp('renewed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    /** Letzter Paketabruf dieses Geräts (nur Betriebsinformation). */
    lastPackageAt: timestamp('last_package_at', { withTimezone: true }),
    packageSeq: integer('package_seq').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Genau EIN aktives Lease je Benutzer × Gerät × Umgebung (Order §8).
    uniqueIndex('offline_access_leases_active_unique')
      .on(table.staffUserId, table.deviceId, table.appEnv)
      .where(sql`${table.revokedAt} IS NULL`),
    index('offline_access_leases_user_idx').on(table.staffUserId, table.revokedAt),
    check('offline_access_leases_expiry_check', sql`${table.expiresAt} > ${table.issuedAt}`),
    // Maximale Laufzeit 72 h – auch bei Verlängerung (neues issued_at).
    check(
      'offline_access_leases_max_check',
      sql`${table.expiresAt} <= ${table.issuedAt} + interval '72 hours'`,
    ),
  ],
);

export const offlineReceiptStatus = pgEnum('offline_receipt_status', [
  'applied',
  'conflict',
  'rejected',
  /** Reserviert VOR der Fachmutation (zweiphasige Quittung): Ergebnis noch offen. */
  'processing',
]);

export const offlineMutationReceipts = pgTable(
  'offline_mutation_receipts',
  {
    /** Client-erzeugte Mutations-ID (UUID) – Primärschlüssel = Idempotenz. */
    clientMutationId: uuid('client_mutation_id').primaryKey(),
    staffUserId: uuid('staff_user_id')
      .notNull()
      .references(() => staffUsers.id),
    deviceId: uuid('device_id').notNull(),
    appEnv: offlineEnvironment('app_env').notNull(),
    /** Typisierter Operationstyp (z. B. `return.damage`), Order §62. */
    operationType: text('operation_type').notNull(),
    contextKind: text('context_kind').notNull(),
    contextId: uuid('context_id').notNull(),
    status: offlineReceiptStatus('status').notNull(),
    /** Nur technische Ergebnis-Referenzen (IDs, Hashes); nie Fachinhalte. */
    resultRef: jsonb('result_ref').$type<Record<string, string | number | boolean | null>>(),
    /** Neutraler Fehlercode (CONFLICT, FORBIDDEN, …) ohne Kundendaten. */
    errorCode: text('error_code'),
    /** Neutrale Meldung für die Konflikt-UI; keine personenbezogenen Daten. */
    message: text('message'),
    /** Vom Client gemeldete Erfassungszeit (UTC) zur Plausibilisierung. */
    clientCreatedAt: timestamp('client_created_at', { withTimezone: true }),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('offline_mutation_receipts_context_idx').on(table.contextKind, table.contextId),
    index('offline_mutation_receipts_user_idx').on(table.staffUserId, table.processedAt),
    check(
      'offline_mutation_receipts_error_check',
      // Textvergleich statt Enum-Literal: der Wert 'processing' kommt per ALTER TYPE ADD VALUE
      // in derselben Migration hinzu und darf dort noch nicht als Enum-Wert verwendet werden.
      sql`(${table.status}::text IN ('applied', 'processing') AND ${table.errorCode} IS NULL) OR (${table.status}::text NOT IN ('applied', 'processing') AND ${table.errorCode} IS NOT NULL)`,
    ),
  ],
);

export type OfflineAccessLease = typeof offlineAccessLeases.$inferSelect;
export type NewOfflineAccessLease = typeof offlineAccessLeases.$inferInsert;
export type OfflineMutationReceipt = typeof offlineMutationReceipts.$inferSelect;
export type NewOfflineMutationReceipt = typeof offlineMutationReceipts.$inferInsert;
