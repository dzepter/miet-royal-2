import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { staffUsers } from './staff-auth.ts';

/**
 * Phase 14 (Order §8): Zustand des kanonischen Demo-Datensatzes – genau eine
 * Zeile (id = 1). Die erwartete Dataset-Version liegt im Code
 * (`DEMO_DATASET_VERSION`); ein älterer Stand wird NIE automatisch
 * zurückgesetzt, sondern dem Admin als „veraltet“ angezeigt. `resetInProgress`
 * sperrt während eines Resets alle Demo-Business-Mutationen (503 DEMO_RESET).
 * Staff-Konten bleiben vom Reset unberührt, daher dürfen die Referenzen auf
 * Mitarbeiter bestehen (ON DELETE SET NULL nur für den Fall einer späteren
 * Kontolöschung).
 */
export const demoDatasetState = pgTable(
  'demo_dataset_state',
  {
    id: integer('id').primaryKey(),
    datasetVersion: integer('dataset_version').notNull(),
    seededAt: timestamp('seeded_at', { withTimezone: true }),
    seededBy: uuid('seeded_by').references(() => staffUsers.id, { onDelete: 'set null' }),
    lastResetAt: timestamp('last_reset_at', { withTimezone: true }),
    lastResetBy: uuid('last_reset_by').references(() => staffUsers.id, { onDelete: 'set null' }),
    resetInProgress: boolean('reset_in_progress').notNull().default(false),
    resetStartedAt: timestamp('reset_started_at', { withTimezone: true }),
    /**
     * Phase 14 (Order §91/§92): Generation des Demo-Datensatzes. Jeder Reset
     * erzeugt eine neue zufällige Epoch; Offline-Leases, -Pakete und
     * -Mutationen der Demo sind an die Epoch gebunden und werden nach einem
     * Reset mit DEMO_DATASET_CHANGED abgewiesen (nie auf den neuen Seed angewendet).
     */
    datasetEpoch: uuid('dataset_epoch')
      .notNull()
      .default(sql`gen_random_uuid()`),
    /**
     * Startzeitpunkt des letzten Resets (bleibt nach Abschluss stehen, anders
     * als `reset_started_at`): Demo-Jobs, die vor diesem Zeitpunkt eingereiht
     * wurden, gehören zum alten Datensatz und werden vom Worker nicht mehr
     * ausgeführt (Order §21 – UUID-Kollision ist keine Sicherheitsannahme).
     */
    lastResetStartedAt: timestamp('last_reset_started_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check('demo_dataset_state_singleton', sql`"id" = 1`),
    check('demo_dataset_state_version_check', sql`"dataset_version" >= 0`),
  ],
);

/**
 * Phase 14 (Order §13): stabile Seed-Schlüssel des kanonischen Demo-Datensatzes.
 * Training und Admin-UI finden Demo-Szenarien über `seedKey`
 * (z. B. `process.offer.draft`), nie über Business-UUIDs. Bewusst OHNE
 * Fremdschlüssel auf Business-Tabellen: der Reset löscht Business-Daten und
 * die Registry gemeinsam; Business-Tabellen bleiben frei von Demo-Sonderfeldern.
 */
export const demoSeedEntities = pgTable(
  'demo_seed_entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seedKey: text('seed_key').notNull().unique(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    datasetVersion: integer('dataset_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('demo_seed_entities_entity_idx').on(table.entityType, table.entityId),
    check('demo_seed_entities_key_check', sql`"seed_key" ~ '^[a-z0-9]+(\\.[a-z0-9_-]+)+$'`),
  ],
);

export type DemoDatasetState = typeof demoDatasetState.$inferSelect;
export type DemoSeedEntity = typeof demoSeedEntities.$inferSelect;
