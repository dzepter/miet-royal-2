import { sql } from 'drizzle-orm';
import {
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

/**
 * Infrastruktur-Tabelle für die PostgreSQL-Jobqueue (ARCHITECTURE.md,
 * DATA_MODEL.md "IntegrationJob"). Fachliche Jobtypen (MAIL_SEND,
 * LEXWARE_TRANSFER, …) kommen in späteren Phasen; Phase 0 liefert nur den
 * Mechanismus mit Retry und Idempotenz.
 *
 * Statusmodell:
 *  - pending:    wartet auf Ausführung (run_at erreicht oder in Zukunft)
 *  - processing: von einem Worker beansprucht, Lease läuft (lease_expires_at)
 *  - succeeded:  erfolgreich abgeschlossen
 *  - dead:       maximale Versuche erschöpft, manuelle Klärung nötig
 * Ein fehlgeschlagener Versuch geht mit Backoff zurück auf pending.
 * Stirbt ein Worker während der Verarbeitung, läuft die Lease ab und der
 * Reclaim-Mechanismus (PostgresJobQueue.reclaimExpired) gibt den Job wieder
 * frei bzw. setzt ihn auf dead, wenn die Versuche erschöpft sind.
 */
export const integrationJobStatus = pgEnum('integration_job_status', [
  'pending',
  'processing',
  'succeeded',
  'dead',
]);

export const integrationJobs = pgTable(
  'integration_jobs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    type: text('type').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    idempotencyKey: text('idempotency_key').notNull(),
    status: integrationJobStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('integration_jobs_idempotency_key_unique').on(table.idempotencyKey),
    index('integration_jobs_claim_idx').on(table.status, table.runAt),
  ],
);

export type IntegrationJob = typeof integrationJobs.$inferSelect;
export type NewIntegrationJob = typeof integrationJobs.$inferInsert;
