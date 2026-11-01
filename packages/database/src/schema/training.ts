import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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

/**
 * Phase 14 (Order §32–§38, §61–§62): Trainings-Metaebene.
 *
 * Trennung nach Umgebung (Order W2, §57, §69):
 * - `training_definitions`, `training_paths`, `training_path_items` sind ein
 *   stabiler Katalog aus dem Code (idempotentes Upsert beim Start, §70) und
 *   existieren in JEDER Umgebung – referenziert wird ausschließlich über den
 *   stabilen `key`, nie über IDs einer anderen Umgebung.
 * - `training_assignments`, `training_attempts`, `training_attempt_events`
 *   werden nur in APP_ENV=demo befüllt (Übungen laufen nur dort).
 * - `training_feature_requirements` (Live-Sperren) und
 *   `staff_training_clearances` (Freigaben/Overrides) werden nur außerhalb der
 *   Demo gepflegt und ausschließlich in APP_ENV=production erzwungen (§63).
 * Es gibt keinen gemeinsamen Store und keine Synchronisierung zwischen
 * Demo und Live; der Demo-Reset lässt alle Trainingstabellen unangetastet
 * (nur laufende Versuche werden `interrupted`, §94).
 */

export const trainingAssignmentStatus = pgEnum('training_assignment_status', [
  'assigned',
  'in_progress',
  'completed',
]);

export const trainingAttemptStatus = pgEnum('training_attempt_status', [
  'in_progress',
  'passed',
  'interrupted',
]);

export const trainingEventResult = pgEnum('training_event_result', [
  /** Fachliches Event wurde einem offenen Schritt zugeordnet. */
  'accepted',
  /** Event für einen bereits erfüllten Schritt (kein Doppelabschluss, §45). */
  'duplicate',
  /** Event abgelehnt (z. B. Vorbedingung/Reihenfolge nicht erfüllt). */
  'rejected',
  /** Bewusste Prüfung „Übung prüfen“: alle Pflichtschritte erfüllt. */
  'check_passed',
  /** Bewusste Prüfung ohne erfüllte Kriterien (STEP_NOT_COMPLETED, §44). */
  'check_failed',
  /** Versuch unterbrochen (DEMO_DATA_RESET, TRAINING_RESET). */
  'interrupted',
]);

export const trainingClearanceSource = pgEnum('training_clearance_source', [
  'verified_demo',
  'override',
]);

/** Übungsdefinition (§33). `evaluatorKey` kommt aus dem festen Server-Katalog (§34). */
export const trainingDefinitions = pgTable(
  'training_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull().unique(),
    version: integer('version').notNull().default(1),
    title: text('title').notNull(),
    objective: text('objective').notNull(),
    instructions: text('instructions').notNull(),
    evaluatorKey: text('evaluator_key').notNull(),
    active: boolean('active').notNull().default(true),
    /** Sicherer bekannter Staff-Pfad zum passenden Demo-Bereich (§72), z. B. `/vorgaenge`. */
    demoPath: text('demo_path'),
    /** Stabiler Seed-Schlüssel des Demo-Szenarios (§72); in Demo zur Laufzeit über die Registry aufgelöst. */
    seedKey: text('seed_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check('training_definitions_key_check', sql`"key" ~ '^[a-z][a-z0-9_]*$'`),
    check('training_definitions_evaluator_check', sql`"evaluator_key" ~ '^[a-z][a-z0-9_]*$'`),
    check('training_definitions_version_check', sql`"version" >= 1`),
    check('training_definitions_demo_path_check', sql`"demo_path" IS NULL OR "demo_path" ~ '^/'`),
  ],
);

/** Trainingspfad (§35). */
export const trainingPaths = pgTable(
  'training_paths',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull().unique(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check('training_paths_key_check', sql`"key" ~ '^[a-z][a-z0-9_]*$'`)],
);

/** Pfad-Element (§35): eindeutige Reihenfolge je Pfad, jede Übung höchstens einmal je Pfad. */
export const trainingPathItems = pgTable(
  'training_path_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pathId: uuid('path_id')
      .notNull()
      .references(() => trainingPaths.id, { onDelete: 'cascade' }),
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => trainingDefinitions.id, { onDelete: 'restrict' }),
    sequence: integer('sequence').notNull(),
    required: boolean('required').notNull().default(true),
  },
  (table) => [
    uniqueIndex('training_path_items_sequence_uq').on(table.pathId, table.sequence),
    uniqueIndex('training_path_items_definition_uq').on(table.pathId, table.definitionId),
    check('training_path_items_sequence_check', sql`"sequence" >= 1`),
  ],
);

/**
 * Zuweisung eines Pfads an einen Mitarbeiter (§36). `round` zählt die
 * Fortschrittsrunden: ein bewusster Training-Reset (§48) erhöht die Runde,
 * bestandene Versuche früherer Runden bleiben als Historie erhalten
 * (`training_attempts.superseded_at`).
 */
export const trainingAssignments = pgTable(
  'training_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => staffUsers.id),
    pathId: uuid('path_id')
      .notNull()
      .references(() => trainingPaths.id, { onDelete: 'restrict' }),
    assignedBy: uuid('assigned_by').references(() => staffUsers.id, { onDelete: 'set null' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp('due_at', { withTimezone: true }),
    status: trainingAssignmentStatus('status').notNull().default('assigned'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    round: integer('round').notNull().default(1),
    lastResetAt: timestamp('last_reset_at', { withTimezone: true }),
    lastResetBy: uuid('last_reset_by').references(() => staffUsers.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('training_assignments_user_path_uq').on(table.userId, table.pathId),
    index('training_assignments_user_idx').on(table.userId),
    check('training_assignments_round_check', sql`"round" >= 1`),
  ],
);

/**
 * Trainingsversuch (§37). Höchstens ein laufender Versuch je Mitarbeiter und
 * Übung (partieller Unique-Index) – Doppelklick ist dadurch idempotent (§39).
 * Versuche werden nie gelöscht; ein Training-Reset setzt nur `superseded_at`.
 */
export const trainingAttempts = pgTable(
  'training_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => staffUsers.id),
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => trainingDefinitions.id, { onDelete: 'restrict' }),
    assignmentId: uuid('assignment_id').references(() => trainingAssignments.id, {
      onDelete: 'set null',
    }),
    /** Runde der Zuweisung zum Startzeitpunkt (Fortschritt zählt nur Versuche der aktuellen Runde). */
    assignmentRound: integer('assignment_round'),
    /** Version der Übungsdefinition beim Start – rein informativ, nie Grund für eine Aberkennung (§46). */
    definitionVersion: integer('definition_version').notNull(),
    status: trainingAttemptStatus('status').notNull().default('in_progress'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    interruptedAt: timestamp('interrupted_at', { withTimezone: true }),
    interruptionCode: text('interruption_code'),
    failedCheckCount: integer('failed_check_count').notNull().default(0),
    lastFailedCheckAt: timestamp('last_failed_check_at', { withTimezone: true }),
    /** Gesetzt durch einen bewussten Training-Reset (§48): zählt nicht mehr als „bestanden“, bleibt Historie. */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    supersededBy: uuid('superseded_by').references(() => staffUsers.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('training_attempts_active_uq')
      .on(table.userId, table.definitionId)
      .where(sql`"status" = 'in_progress'`),
    index('training_attempts_user_idx').on(table.userId, table.definitionId),
    index('training_attempts_assignment_idx').on(table.assignmentId),
    check('training_attempts_failed_count_check', sql`"failed_check_count" >= 0`),
    check(
      'training_attempts_interruption_check',
      sql`("status" = 'interrupted') = ("interruption_code" IS NOT NULL)`,
    ),
  ],
);

/**
 * Ereignis eines Versuchs (§38): ausschließlich Metadaten (Event-Schlüssel,
 * Schritt, Ergebnis, neutraler Fehlercode). `subjectRef` ist die serverseitig
 * ermittelte ID des Fachobjekts (z. B. Tour), damit Mehrschritt-Übungen
 * dasselbe Objekt verlangen können – keine Businessdaten, keine Kontakte,
 * keine Preise, keine Texte, keine Fotos, kein GPS.
 */
export const trainingAttemptEvents = pgTable(
  'training_attempt_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => trainingAttempts.id, { onDelete: 'cascade' }),
    eventKey: text('event_key').notNull(),
    stepKey: text('step_key'),
    result: trainingEventResult('result').notNull(),
    errorCode: text('error_code'),
    subjectRef: uuid('subject_ref'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('training_attempt_events_attempt_idx').on(table.attemptId, table.occurredAt),
    check('training_attempt_events_key_check', sql`"event_key" ~ '^[a-z][a-z0-9_.]*$'`),
    check(
      'training_attempt_events_error_check',
      sql`"error_code" IS NULL OR "error_code" ~ '^[A-Z][A-Z0-9_]*$'`,
    ),
  ],
);

/**
 * Live-Sperre je Funktion (§61): global, genau eine Zeile je Feature-Key aus
 * dem festen Katalog (§60). Referenz auf die Übung über den stabilen Key.
 */
export const trainingFeatureRequirements = pgTable(
  'training_feature_requirements',
  {
    featureKey: text('feature_key').primaryKey(),
    definitionKey: text('definition_key')
      .notNull()
      .references(() => trainingDefinitions.key, { onDelete: 'restrict' }),
    enabled: boolean('enabled').notNull().default(false),
    configuredBy: uuid('configured_by').references(() => staffUsers.id, { onDelete: 'set null' }),
    configuredAt: timestamp('configured_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check('training_feature_requirements_key_check', sql`"feature_key" ~ '^[a-z][a-z0-9_.]*$'`),
  ],
);

/**
 * Freigabe (§62): manuell bestätigtes Demo-Training (`verified_demo`) oder
 * bewusster Admin-Override (`override`, Begründung Pflicht, optional befristet).
 * Widerruf setzt `revoked_at`; Zeilen werden nie gelöscht (Audit-Historie).
 */
export const staffTrainingClearances = pgTable(
  'staff_training_clearances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => staffUsers.id),
    definitionKey: text('definition_key')
      .notNull()
      .references(() => trainingDefinitions.key, { onDelete: 'restrict' }),
    source: trainingClearanceSource('source').notNull(),
    reason: text('reason'),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    grantedBy: uuid('granted_by').references(() => staffUsers.id, { onDelete: 'set null' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => staffUsers.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('staff_training_clearances_user_idx').on(table.userId, table.definitionKey),
    check(
      'staff_training_clearances_reason_check',
      sql`"source" <> 'override' OR ("reason" IS NOT NULL AND length(btrim("reason")) > 0)`,
    ),
    check(
      'staff_training_clearances_valid_check',
      sql`"valid_until" IS NULL OR "valid_until" > "valid_from"`,
    ),
  ],
);

export type TrainingDefinition = typeof trainingDefinitions.$inferSelect;
export type TrainingPath = typeof trainingPaths.$inferSelect;
export type TrainingPathItem = typeof trainingPathItems.$inferSelect;
export type TrainingAssignment = typeof trainingAssignments.$inferSelect;
export type TrainingAttempt = typeof trainingAttempts.$inferSelect;
export type TrainingAttemptEvent = typeof trainingAttemptEvents.$inferSelect;
export type TrainingFeatureRequirement = typeof trainingFeatureRequirements.$inferSelect;
export type StaffTrainingClearance = typeof staffTrainingClearances.$inferSelect;
