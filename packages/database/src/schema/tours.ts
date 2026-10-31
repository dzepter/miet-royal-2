import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  doublePrecision,
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
import { appointments } from './scheduling.ts';
import { staffUsers } from './staff-auth.ts';

/**
 * Phase 13: Touren, Tour-Stopps, Live-Standort, Verspätungs-Incidents und
 * Geocoding-Cache (MASTER_SPEC Nr. 25, Phase-13-Order §§10–12, 40, 52).
 *
 * Grundsätze:
 * - `appointments` bleibt Source of Truth für Terminart, Zeit/Fenster, Buchung,
 *   Vorgang, Zuständigkeit und Abschluss/Storno – ein TourStop dupliziert
 *   diese Fachdaten NICHT (nur Reihenfolge, Pin, Puffer, operative Marken und
 *   eigene Planungswerte).
 * - Provider-Rohantworten (Geometrien, Hits, Matrizen) werden NIE dauerhaft
 *   gespeichert (GraphHopper-ToS §5.2: nur temporäres Caching). Gespeichert
 *   werden eigene Geschäftsdaten und minimale skalare Planungswerte
 *   (Distanz in m, Dauer in s, geplante Zeiten) – docs/ROUTING_API_NOTES.md.
 * - GPS: KEINE Historie – genau eine Zeile je aktiver Tour, jedes Update
 *   überschreibt, Tourende löscht (ARCHITECTURE.md „Keine GPS-Historie“).
 */

export const tourStatus = pgEnum('tour_status', [
  'draft',
  'ready',
  'active',
  'completed',
  'cancelled',
]);

/**
 * Planungsstand der Route (Order §36/§37): `unplanned` = noch keine
 * Berechnung bzw. keine übernommene Reihenfolge, `planned` = Werte aktuell,
 * `stale` = Termin/Adresse/Reihenfolge seit der Berechnung geändert,
 * `infeasible` = letzte Berechnung meldete nicht einhaltbare Zeitvorgaben.
 */
export const tourPlanningStatus = pgEnum('tour_planning_status', [
  'unplanned',
  'planned',
  'stale',
  'infeasible',
]);

export const tours = pgTable(
  'tours',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Berliner Kalendertag der Durchführung (Order §10). */
    tourDate: date('tour_date').notNull(),
    status: tourStatus('status').notNull().default('draft'),
    /** Gespeicherter Tourfahrer – effektive Zuständigkeit löst Vertretung zur Laufzeit auf (Order §30). */
    assignedUserId: uuid('assigned_user_id')
      .notNull()
      .references(() => staffUsers.id),
    /** Optimistic Concurrency (Order §62): jede Mutation von Tour oder Stoppfolge inkrementiert. */
    version: integer('version').notNull().default(1),
    startedAt: timestamp('started_at', { withTimezone: true }),
    startedBy: uuid('started_by').references(() => staffUsers.id),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedBy: uuid('ended_by').references(() => staffUsers.id),
    /** Pflichtgrund bei „Tour trotzdem beenden“ mit offenen Stopps (Order §60) – intern, nie Kundendatum. */
    endReason: text('end_reason'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => staffUsers.id),
    planningStatus: tourPlanningStatus('planning_status').notNull().default('unplanned'),
    routeCalculatedAt: timestamp('route_calculated_at', { withTimezone: true }),
    /** 'graphhopper' | 'mock' – nie ein API-Key, nie eine URL. */
    routeProvider: text('route_provider'),
    /** Minimale skalare Planungswerte (Order §5/§24) – keine Geometrien. */
    plannedDistanceMeters: integer('planned_distance_meters'),
    plannedDurationSeconds: integer('planned_duration_seconds'),
    plannedStartAt: timestamp('planned_start_at', { withTimezone: true }),
    plannedEndAt: timestamp('planned_end_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => staffUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('tours_date_idx').on(table.tourDate, table.status),
    index('tours_assigned_idx').on(table.assignedUserId, table.status),
    /** DB-Backstop (Order §32/§61): höchstens EINE aktive Tour je gespeichertem Fahrer. */
    uniqueIndex('tours_one_active_per_user_idx')
      .on(table.assignedUserId)
      .where(sql`"status" = 'active'`),
    check(
      'tours_started_check',
      sql`("status" <> 'active' AND "status" <> 'completed') OR "started_at" IS NOT NULL`,
    ),
    check('tours_ended_check', sql`"status" <> 'completed' OR "ended_at" IS NOT NULL`),
    check(
      'tours_planned_values_check',
      sql`"planned_distance_meters" IS NULL OR "planned_distance_meters" >= 0`,
    ),
  ],
);

export const tourStops = pgTable(
  'tour_stops',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tourId: uuid('tour_id')
      .notNull()
      .references(() => tours.id),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id),
    /** 1-basierte Position in der Tour; der Service schreibt die Folge atomar unter Tour-Sperre neu. */
    sequence: integer('sequence').notNull(),
    /** Gepinnter/fester Stopp: behält seine Position im Routenvorschlag (Order §18–§20). */
    isPinned: boolean('is_pinned').notNull().default(false),
    /** Servicepuffer in Minuten – Standard 15 (Order §21), nur durch Planer abweichend. */
    bufferMinutes: integer('buffer_minutes').notNull().default(15),
    /** Operative Marke „Angekommen“ (Order §35) – keine Fachmutation. */
    arrivedAt: timestamp('arrived_at', { withTimezone: true }),
    /** Operativ geschlossen, weil der Termin storniert wurde (Order §36) – Termin bleibt Source of Truth. */
    skippedAt: timestamp('skipped_at', { withTimezone: true }),
    /**
     * Eigene Planungswerte aus der letzten übernommenen Berechnung (Order §24,
     * nur skalare Werte): Abschnitt VOM vorherigen Stopp (bzw. Depot) BIS hier.
     */
    plannedArrivalAt: timestamp('planned_arrival_at', { withTimezone: true }),
    plannedDepartureAt: timestamp('planned_departure_at', { withTimezone: true }),
    legDistanceMeters: integer('leg_distance_meters'),
    legDurationSeconds: integer('leg_duration_seconds'),
    /**
     * DB-Backstop (Order §12): NULL, solange die Tour draft/ready/active ist;
     * wird beim Abschluss/Abbruch der Tour in derselben Transaktion gesetzt.
     * Partieller Unique-Index ⇒ ein Termin steckt nie in zwei offenen Touren.
     */
    releasedAt: timestamp('released_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('tour_stops_tour_appointment_unique').on(table.tourId, table.appointmentId),
    uniqueIndex('tour_stops_open_appointment_unique')
      .on(table.appointmentId)
      .where(sql`"released_at" IS NULL`),
    index('tour_stops_tour_sequence_idx').on(table.tourId, table.sequence),
    check('tour_stops_sequence_check', sql`"sequence" >= 1`),
    check('tour_stops_buffer_check', sql`"buffer_minutes" >= 0 AND "buffer_minutes" <= 240`),
  ],
);

/**
 * Letzter Live-Standort der AKTIVEN Tour (Order §40–§43): genau eine Zeile je
 * Tour (PK = tour_id), jedes Update überschreibt, Tourende löscht die Zeile.
 * Keine Historie, keine Track-Tabelle. Werte werden nie geloggt und nie an
 * Kunden ausgespielt.
 */
export const tourLiveLocations = pgTable(
  'tour_live_locations',
  {
    tourId: uuid('tour_id')
      .primaryKey()
      .references(() => tours.id),
    /** Fahrer, der den Standort gemeldet hat (effektive Zuständigkeit beim Update). */
    userId: uuid('user_id')
      .notNull()
      .references(() => staffUsers.id),
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    accuracyMeters: doublePrecision('accuracy_meters'),
    /** Zeitpunkt der Messung laut Gerät (plausibilisiert) und Eingang beim Server. */
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check('tour_live_locations_lat_check', sql`"latitude" >= -90 AND "latitude" <= 90`),
    check('tour_live_locations_lon_check', sql`"longitude" >= -180 AND "longitude" <= 180`),
    check(
      'tour_live_locations_accuracy_check',
      sql`"accuracy_meters" IS NULL OR ("accuracy_meters" >= 0 AND "accuracy_meters" <= 100000)`,
    ),
  ],
);

/**
 * Verspätungsrisiko (Order §50–§55): genau EIN offener Incident je Stopp
 * (partieller Unique-Index). Entsteht, wenn die aktuell berechnete Route den
 * spätesten Zeitpunkt des Stopps (exakt: Termin; Fenster: Ende) voraussichtlich
 * verpasst; wird gelöst, sobald eine neue Berechnung wieder rechtzeitig ist.
 * Genau ein Push je Incident (notification_sent_at). Kein Kundenkontakt.
 */
export const tourDelayIncidents = pgTable(
  'tour_delay_incidents',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tourId: uuid('tour_id')
      .notNull()
      .references(() => tours.id),
    stopId: uuid('stop_id')
      .notNull()
      .references(() => tourStops.id),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    lastEvaluatedAt: timestamp('last_evaluated_at', { withTimezone: true }).notNull().defaultNow(),
    predictedArrivalAt: timestamp('predicted_arrival_at', { withTimezone: true }).notNull(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    notificationSentAt: timestamp('notification_sent_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('tour_delay_incidents_open_stop_unique')
      .on(table.stopId)
      .where(sql`"resolved_at" IS NULL`),
    index('tour_delay_incidents_tour_idx').on(table.tourId, table.resolvedAt),
  ],
);

export const geocodingStatus = pgEnum('geocoding_status', [
  'resolved',
  'review_required',
  'no_result',
]);

/**
 * Temporärer Geocoding-Cache (Order §16/§17, ToS §5.2 „temporarily cached“):
 * je normalisierter operativer Adresse (Hash) das Ergebnis des Providers –
 * eindeutig aufgelöst (Koordinate), mehrdeutig (wenige Kandidaten für das
 * Staff-Review) oder ohne Treffer. `expires_at` begrenzt die Lebensdauer; eine
 * bewusste Staff-Auswahl (`confirmed_*`) bleibt eine eigene Geschäftsentscheidung
 * und wird nach Ablauf automatisch erneut angewendet, wenn der Provider denselben
 * OSM-Treffer liefert. Enthält NIE Kundendaten außer der Adresse selbst.
 */
export const geocodingCache = pgTable(
  'geocoding_cache',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** SHA-256 der normalisierten Adresse (Kleinschreibung, Whitespace, Land). */
    addressHash: text('address_hash').notNull(),
    /** Normalisierte Adresse im Klartext (nur Adresse – keine Namen/Telefon). */
    addressText: text('address_text').notNull(),
    status: geocodingStatus('status').notNull(),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    /** Anzeige „Straße, PLZ Ort“ des aufgelösten Treffers. */
    displayLabel: text('display_label'),
    /** OSM-Referenz des aufgelösten Treffers (für Wiedererkennung nach Ablauf). */
    osmRef: text('osm_ref'),
    /** Nur bei review_required: ≤ 5 Kandidaten {label, latitude, longitude, osmRef}. */
    candidates: jsonb('candidates'),
    provider: text('provider').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    confirmedBy: uuid('confirmed_by').references(() => staffUsers.id),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /** OSM-Referenz der bewussten Staff-Auswahl (überlebt den Cache-Ablauf). */
    confirmedOsmRef: text('confirmed_osm_ref'),
  },
  (table) => [
    uniqueIndex('geocoding_cache_address_hash_unique').on(table.addressHash),
    index('geocoding_cache_expires_idx').on(table.expiresAt),
    check(
      'geocoding_cache_resolved_check',
      sql`"status" <> 'resolved' OR ("latitude" IS NOT NULL AND "longitude" IS NOT NULL)`,
    ),
  ],
);

export type Tour = typeof tours.$inferSelect;
export type TourStop = typeof tourStops.$inferSelect;
export type TourLiveLocation = typeof tourLiveLocations.$inferSelect;
export type TourDelayIncident = typeof tourDelayIncidents.$inferSelect;
export type GeocodingCacheRow = typeof geocodingCache.$inferSelect;
