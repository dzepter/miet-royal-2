import { sql } from 'drizzle-orm';
import {
  date,
  index,
  jsonb,
  pgEnum,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { staffUsers } from './staff-auth.ts';

/**
 * Phase 2: Kundenstammdaten, zentrale Vorgänge, Notizen, Systemeinstellungen
 * (MASTER_SPEC Nr. 3, DATA_MODEL.md: Customer, Process, InternalNote,
 * SystemSetting). Anfragen/Angebote/Buchungen/Maschinen folgen in ihren
 * eigenen Phasen.
 */

export const customerType = pgEnum('customer_type', ['private', 'organization']);

/**
 * Kleiner, erweiterbarer Hauptstatus (Phase-2-Vorgabe Nr. 6). Die
 * fachlichen Detailstatus (Angebot, Buchung, Rückgabe, Abrechnung) kommen
 * später in ihren Modulen und ersetzen diesen Überbau nicht.
 */
export const processStatus = pgEnum('process_status', [
  'open',
  'completed',
  'reopened',
  'cancelled',
]);

/** Interne Herkunft des Vorgangs – keine Integration in Phase 2. */
export const processSource = pgEnum('process_source', [
  'website',
  'whatsapp',
  'staff_manual',
  'other',
]);

/**
 * Kundenstamm. Rechnungsadresse eingebettet (genau eine je Kunde);
 * Event-/Lieferadressen gehören später zum konkreten Vorgang, NICHT hierher.
 * `email` wird normalisiert (trim+lowercase) gespeichert; `phone` bleibt in
 * der vom Nutzer eingegebenen Darstellung, `phoneNormalized` (nur Ziffern,
 * deutsche Default-Vorwahl) dient ausschließlich Suche/Dublettenprüfung.
 * `deletedAt` = Papierkorb (nur Admin, 30 Tage Wiederherstellung; nur für
 * Kunden ohne Vorgänge – Geschäftsdaten werden nie hart gelöscht).
 */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    type: customerType('type').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    organizationName: text('organization_name'),
    /** Ansprechpartner bei Organisationen (Freitext, bewusst einfach). */
    contactPerson: text('contact_person'),
    email: text('email'),
    phone: text('phone'),
    phoneNormalized: text('phone_normalized'),
    billingStreet: text('billing_street'),
    billingPostalCode: text('billing_postal_code'),
    billingCity: text('billing_city'),
    billingCountry: text('billing_country'),
    vatId: text('vat_id'),
    department: text('department'),
    costCenter: text('cost_center'),
    orderReference: text('order_reference'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => staffUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('customers_email_idx').on(table.email),
    index('customers_phone_normalized_idx').on(table.phoneNormalized),
    index('customers_deleted_idx').on(table.deletedAt),
  ],
);

/**
 * Fortlaufende Sequenz für die öffentliche Vorgangsnummer MR-YYYY-NNNN.
 * PostgreSQL-Sequenzen sind race-sicher, vergeben nie doppelt und werden
 * über Jahresgrenzen NICHT zurückgesetzt (MASTER_SPEC Nr. 3).
 */
export const processNumberSeq = pgSequence('process_number_seq', {
  startWith: 1,
  increment: 1,
});

export const processes = pgTable(
  'processes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Öffentlich, unveränderbar (DB-Trigger verhindert jede Änderung). */
    processNumber: text('process_number').notNull().unique(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    mainStatus: processStatus('main_status').notNull().default('open'),
    /**
     * Optionale Zuständigkeit. Historische Referenz bleibt bestehen, auch
     * wenn der Mitarbeiter später deaktiviert wird; nur NEUE Zuweisungen
     * auf inaktive Mitarbeiter sind verboten (Service-Prüfung).
     */
    assignedUserId: uuid('assigned_user_id').references(() => staffUsers.id),
    source: processSource('source').notNull().default('staff_manual'),
    eventDate: date('event_date'),
    createdBy: uuid('created_by').references(() => staffUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    reopenedAt: timestamp('reopened_at', { withTimezone: true }),
  },
  (table) => [
    index('processes_customer_idx').on(table.customerId),
    index('processes_status_idx').on(table.mainStatus, table.completedAt),
    index('processes_assigned_idx').on(table.assignedUserId),
    index('processes_event_date_idx').on(table.eventDate),
  ],
);

/**
 * Interne Notizen: immer genau ein Vorgang, niemals kundensichtbar
 * (DATA_MODEL.md "InternalNote"). Keine Status, kein Rich-Text.
 */
export const processNotes = pgTable(
  'process_notes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    processId: uuid('process_id')
      .notNull()
      .references(() => processes.id),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => staffUsers.id),
    text: text('text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('process_notes_process_idx').on(table.processId, table.createdAt)],
);

/**
 * Sinnvolle veränderbare Betriebsparameter (DATA_MODEL.md "SystemSetting") –
 * keine Fachlogik als freie JSON-Regel. Phase 2 nutzt:
 * completed_process_staff_visibility_days (Default 7, im Code).
 */
export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by').references(() => staffUsers.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
export type Process = typeof processes.$inferSelect;
export type ProcessNote = typeof processNotes.$inferSelect;
