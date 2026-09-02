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
import { bookings } from './commerce.ts';

/**
 * Phase 4: Operative Termine, Vertretungen, Konflikt-Suppressions und
 * Überfälligkeits-Incidents (MASTER_SPEC Nr. 23/24, DATA_MODEL.md
 * "Appointment"/"Substitution", Phase-4-Order §§2/12/20/24).
 *
 * Bewusst NICHT hier: Maschinen, Lager, Protokolle, Routen, Push-Delivery,
 * Apple-Kalender (spätere Phasen; externe Referenzen kommen später über
 * eine eigene integration_mapping-Tabelle – Order §35/§39).
 */

export const appointmentKind = pgEnum('appointment_kind', ['pickup', 'return', 'delivery']);

/**
 * Neutraler Terminstatus (Order §30): "completed" ist ein INTERNER
 * Planungsabschluss – die fachliche Übergabe/Rückgabe kommt erst mit den
 * Ausgabe-/Rückgabe-Workflows späterer Phasen.
 */
export const appointmentStatus = pgEnum('appointment_status', [
  'scheduled',
  'completed',
  'cancelled',
]);

/** Standortart: Betriebsstandort (pickup_exact_address) oder Kundenadresse. */
export const appointmentLocationKind = pgEnum('appointment_location_kind', ['base', 'customer']);

/** Erstellungsgrund (Order §2 "Quelle"). */
export const appointmentSource = pgEnum('appointment_source', ['booking', 'manual']);

export const appointments = pgTable(
  'appointments',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    processId: uuid('process_id')
      .notNull()
      .references(() => processes.id),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    kind: appointmentKind('kind').notNull(),
    status: appointmentStatus('status').notNull().default('scheduled'),
    /**
     * Zeitmodell (Order §3):
     * - exakter Termin: startAt gesetzt, endAt NULL;
     * - Zeitfenster: startAt UND endAt gesetzt (endAt > startAt);
     * - ungeplant ("Zeit festlegen"): startAt NULL.
     * Es wird NIE eine künstliche exakte Zeit aus einem Fenster erzeugt.
     */
    startAt: timestamp('start_at', { withTimezone: true }),
    endAt: timestamp('end_at', { withTimezone: true }),
    /** Fachliche Betriebszeitzone – in Version 1 immer Europe/Berlin. */
    timezone: text('timezone').notNull().default('Europe/Berlin'),
    locationKind: appointmentLocationKind('location_kind').notNull(),
    /**
     * Nur für Kundenadressen (Liefer-/Rückholadresse aus dem eingefrorenen
     * Buchungs-Snapshot). Der Betriebsstandort wird zur Laufzeit aus
     * pickup_exact_address gelesen (Einstellung kann sich ändern) und NIE
     * öffentlich ausgespielt.
     */
    locationSnapshot: jsonb('location_snapshot'),
    /** Historische Referenz bleibt auch bei später deaktivierten Nutzern. */
    assignedUserId: uuid('assigned_user_id').references(() => staffUsers.id),
    source: appointmentSource('source').notNull().default('booking'),
    /**
     * Kundeninformation offen (Order §17/§27): gesetzt, wenn eine bereits
     * vereinbarte Zeit nachträglich geändert wurde. Der spätere
     * Mail-Freigabe-Workflow (Phase 12) räumt das Feld wieder ab.
     */
    customerInfoRequiredAt: timestamp('customer_info_required_at', { withTimezone: true }),
    /**
     * Gleiche-Tages-Reassignment (Order §11): Übernahmebestätigung.
     * requestedFor = Nutzer, der bestätigen muss; eine erneute Zuweisung
     * setzt die Felder neu bzw. macht eine alte Bestätigung ungültig.
     * assignmentNotifiedAt bleibt NULL, bis Phase 12 den Push versendet
     * ("Benachrichtigung notwendig" = requestedAt gesetzt UND notified NULL).
     */
    acknowledgementRequestedAt: timestamp('acknowledgement_requested_at', { withTimezone: true }),
    acknowledgementRequestedFor: uuid('acknowledgement_requested_for').references(
      () => staffUsers.id,
    ),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedBy: uuid('acknowledged_by').references(() => staffUsers.id),
    assignmentNotifiedAt: timestamp('assignment_notified_at', { withTimezone: true }),
    /** 1h-Reminder (Order §25): Phase 12 setzt den Versandzeitpunkt. */
    reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),
    /** Interner Planungsabschluss (Order §30) – KEIN fachlicher Rückgabeabschluss. */
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: uuid('completed_by').references(() => staffUsers.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /** Optimistic Concurrency (Order §41): jede Mutation inkrementiert. */
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** Idempotenz (Order §40): je Buchung genau EIN Termin je fachlichem Zweck. */
    uniqueIndex('appointments_booking_kind_unique').on(table.bookingId, table.kind),
    index('appointments_process_idx').on(table.processId),
    index('appointments_start_idx').on(table.startAt),
    index('appointments_assigned_idx').on(table.assignedUserId),
    index('appointments_status_idx').on(table.status),
    check('appointments_window_check', sql`"end_at" IS NULL OR "start_at" IS NOT NULL`),
    check(
      'appointments_window_order_check',
      sql`"end_at" IS NULL OR "start_at" IS NULL OR "end_at" > "start_at"`,
    ),
  ],
);

/**
 * Vertretungen (Order §12, DATA_MODEL "Substitution"): Admin trägt
 * Ursprung, Vertretung und Zeitraum ein. endedEarlyAt = vorzeitiges Ende
 * (wirksames Ende = LEAST(endsAt, endedEarlyAt)). Historische
 * Terminzuweisungen werden NICHT umgeschrieben – die effektive
 * Zuständigkeit wird zeitabhängig aufgelöst (resolveEffectiveAssignee).
 */
export const staffSubstitutions = pgTable(
  'staff_substitutions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    originalUserId: uuid('original_user_id')
      .notNull()
      .references(() => staffUsers.id),
    substituteUserId: uuid('substitute_user_id')
      .notNull()
      .references(() => staffUsers.id),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    endedEarlyAt: timestamp('ended_early_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => staffUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('staff_substitutions_original_idx').on(table.originalUserId, table.startsAt),
    check('staff_substitutions_distinct_check', sql`"original_user_id" <> "substitute_user_id"`),
    check('staff_substitutions_range_check', sql`"ends_at" > "starts_at"`),
  ],
);

/**
 * Konflikt-Suppressions (Order §20): minimale Speicherung, damit ein als
 * "gelöst" markierter Konflikt nicht sofort wieder erscheint. Der
 * Fingerprint wird ausschließlich SERVERSEITIG aus Konfliktart, betroffenen
 * Terminen, Zeiten und effektivem Mitarbeiter berechnet – Clients können
 * keinen beliebigen Fingerprint einreichen. Relevante Terminänderungen
 * erzeugen einen neuen Fingerprint, der Konflikt darf wieder erscheinen.
 * BEWUSST ohne Audit-Event und ohne sichtbare Historie.
 */
export const appointmentConflictSuppressions = pgTable(
  'appointment_conflict_suppressions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    fingerprint: text('fingerprint').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('conflict_suppressions_fingerprint_unique').on(table.fingerprint)],
);

/**
 * Überfälligkeits-Incidents (Order §24/§27): Ein Incident entsteht pro
 * verpasster Rückgabezeit (missedAt = die überschrittene geplante Zeit).
 * Eine verbindlich vereinbarte neue Zeit beendet den Incident (resolvedAt);
 * wird die vereinbarte Zeit erneut überschritten, entsteht ein NEUER
 * Incident – auch wenn dieselbe Wanduhrzeit ein zweites Mal gerissen wird
 * (deshalb ist die Eindeutigkeit PARTIELL auf offene Incidents beschränkt).
 * Der Admin-Push (Phase 12) ist genau einmal je Incident fällig:
 * adminNotifiedAt NULL = noch nicht versendet. "Kunde kontaktiert"
 * (Order §26) ist ein minimales Kennzeichen am aktuellen Incident – kein
 * Kontaktverlauf.
 */
export const appointmentOverdueIncidents = pgTable(
  'appointment_overdue_incidents',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id),
    /** Die überschrittene geplante Rückgabezeit (Fenster-Ende bzw. Zeitpunkt). */
    missedAt: timestamp('missed_at', { withTimezone: true }).notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    adminNotifiedAt: timestamp('admin_notified_at', { withTimezone: true }),
    customerContactedAt: timestamp('customer_contacted_at', { withTimezone: true }),
    customerContactedBy: uuid('customer_contacted_by').references(() => staffUsers.id),
  },
  (table) => [
    /** Genau EIN OFFENER Incident je (Termin, verpasster Zeit) – gelöste
     *  Incidents blockieren ein erneutes Reißen derselben Zeit nicht. */
    uniqueIndex('overdue_incidents_open_appointment_missed_unique')
      .on(table.appointmentId, table.missedAt)
      .where(sql`"resolved_at" IS NULL`),
    index('overdue_incidents_open_idx').on(table.resolvedAt),
  ],
);

export type Appointment = typeof appointments.$inferSelect;
export type StaffSubstitution = typeof staffSubstitutions.$inferSelect;
export type AppointmentConflictSuppression = typeof appointmentConflictSuppressions.$inferSelect;
export type AppointmentOverdueIncident = typeof appointmentOverdueIncidents.$inferSelect;
