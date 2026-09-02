import {
  appointmentOverdueIncidents,
  appointments,
  bookings,
  customers,
  processes,
  staffUsers,
  type Appointment,
  type AppointmentOverdueIncident,
  type Database,
  type DatabaseTransaction,
} from '@mietroyal/database';
import {
  assertValidTimePosition,
  berlinDateOf,
  berlinStartOfDay,
  isReminderDue,
  isReturnOverdue,
  isSameBerlinDay,
  SchedulingRuleError,
  weekendStandardSuggestion,
  type SubstitutionLike,
} from '@mietroyal/domain';
import type { PermissionKey } from '@mietroyal/permissions';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import {
  getAppointmentReminderMinutes,
  getPickupExactAddress,
  getPickupPublicArea,
} from '../crm/settings-service.ts';
import { createMachineCapacityProvider } from '../warehouse/capacity-conflict.ts';
import { effectiveAssigneeForAppointment, loadSubstitutions } from './assignee.ts';
import {
  ConflictDetectionService,
  type ConflictAppointment,
  type DetectedConflict,
} from './conflicts.ts';

/**
 * Klar abgegrenzte Scheduling-Boundary (Order §4): SÄMTLICHE Termin-
 * Fachlogik lebt hier – nichts davon im OfferService. Termine entstehen
 * idempotent aus bestätigten Buchungen (Unique je Buchung+Terminart),
 * Buchungs-Snapshots werden dabei NIE verändert.
 */

function parseSnapshotDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface CalendarConflictInfo {
  type: string;
  severity: 'warning' | 'strong';
  reason: string;
  appointmentIds: string[];
}

/** Datenminimierte Kalenderdarstellung (Order §15, Pflichttest 57). */
export interface CalendarEntry {
  id: string;
  processId: string;
  processNumber: string;
  bookingId: string;
  kind: Appointment['kind'];
  status: Appointment['status'];
  startAt: string | null;
  endAt: string | null;
  timezone: string;
  locationKind: Appointment['locationKind'];
  locationLabel: string;
  customerName: string;
  customerPhone: string | null;
  machineName: string | null;
  assignedUserId: string | null;
  assignedName: string | null;
  effectiveAssigneeId: string | null;
  effectiveAssigneeName: string | null;
  substituted: boolean;
  overdue: boolean;
  overdueIncident: {
    id: string;
    missedAt: string;
    customerContactedAt: string | null;
  } | null;
  customerInfoRequiredAt: string | null;
  acknowledgementPending: boolean;
  acknowledgementRequestedFor: string | null;
  completedAt: string | null;
  version: number;
  conflicts: CalendarConflictInfo[];
}

interface EnrichmentContext {
  processNumbers: Map<string, string>;
  customerByProcess: Map<string, { name: string; phone: string | null }>;
  machineByBooking: Map<string, string | null>;
  userNames: Map<string, string>;
  openIncidents: Map<string, AppointmentOverdueIncident>;
  baseLocationLabel: string;
  substitutions: SubstitutionLike[];
  now: Date;
}

export class SchedulingService {
  readonly conflicts: ConflictDetectionService;

  constructor(private readonly db: Database) {
    this.conflicts = new ConflictDetectionService(db);
    // Phase 5 (Order §18/§47): Kapazitätswarnungen laufen über die
    // BESTEHENDE Konfliktarchitektur – keine zweite Engine.
    this.conflicts.registerProvider(createMachineCapacityProvider(this.db));
  }

  // ── Termin-Erzeugung aus bestätigter Buchung (Order §§4–7, §40) ─────────

  /**
   * Idempotent: legt fehlende Termine einer Buchung an (Unique je
   * Buchung+Art verhindert Doppeltermine auch bei Races). Vorhandene
   * Termine – auch manuell geänderte – werden NIE überschrieben.
   */
  async ensureAppointmentsForBooking(bookingId: string): Promise<{ created: number }> {
    const bookingRows = await this.db.select().from(bookings).where(eq(bookings.id, bookingId));
    const booking = bookingRows[0];
    if (booking === undefined) throw new AuthError('NOT_FOUND', 'Buchung nicht gefunden.');
    const processRows = await this.db
      .select()
      .from(processes)
      .where(eq(processes.id, booking.processId));
    const process = processRows[0];
    if (process === undefined) throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
    if (process.mainStatus === 'cancelled') return { created: 0 };

    // Initiale Zuweisung: aktiver Vorgangs-Zuständiger, sonst offen
    // (Order §9 – niemals irgendeinen Mitarbeiter erfinden).
    let assignedUserId: string | null = null;
    if (process.assignedUserId !== null) {
      const userRows = await this.db
        .select({ status: staffUsers.status })
        .from(staffUsers)
        .where(eq(staffUsers.id, process.assignedUserId));
      if (userRows[0]?.status === 'active') assignedUserId = process.assignedUserId;
    }

    const event = (booking.eventSnapshot ?? {}) as Record<string, unknown>;
    const delivery = (booking.deliverySnapshot ?? {}) as Record<string, unknown>;
    const customerLocation =
      booking.fulfillment === 'delivery'
        ? {
            street: typeof delivery.street === 'string' ? delivery.street : null,
            postalCode: typeof delivery.postalCode === 'string' ? delivery.postalCode : null,
            city: typeof delivery.city === 'string' ? delivery.city : null,
          }
        : null;

    /**
     * Snapshot-Zeiten nur übernehmen, wenn sie fachlich gültig sind. Ein
     * unmögliches Fenster (Ende <= Beginn) wird NICHT zu einer erfundenen
     * exakten Zeit umgedeutet – der Termin bleibt „Zeit festlegen“ (§3/§5).
     */
    const timesFrom = (fromValue: unknown, toValue: unknown) => {
      const startAt = parseSnapshotDate(fromValue);
      const endAt = parseSnapshotDate(toValue);
      if (startAt === null) return { startAt: null, endAt: null };
      if (endAt !== null && endAt.getTime() <= startAt.getTime()) {
        return { startAt: null, endAt: null };
      }
      return { startAt, endAt };
    };

    const desired: {
      kind: Appointment['kind'];
      locationKind: Appointment['locationKind'];
      locationSnapshot: Record<string, unknown> | null;
      startAt: Date | null;
      endAt: Date | null;
    }[] = [];

    if (booking.fulfillment === 'pickup') {
      // Selbstabholung (§5): Abhol- + Rückgabetermin am Betriebsstandort.
      // Abholzeitfenster aus dem Snapshot, sofern vorhanden; sonst ungeplant.
      desired.push({
        kind: 'pickup',
        locationKind: 'base',
        locationSnapshot: null,
        ...timesFrom(event.collectionWindowFrom, event.collectionWindowTo),
      });
      desired.push({
        kind: 'return',
        locationKind: 'base',
        locationSnapshot: null,
        startAt: null,
        endAt: null,
      });
    } else {
      // Lieferung (§7): Lieferfenster + spätere Rückholung als Rückgabe.
      desired.push({
        kind: 'delivery',
        locationKind: 'customer',
        locationSnapshot: customerLocation,
        ...timesFrom(event.deliveryWindowFrom, event.deliveryWindowTo),
      });
      desired.push({
        kind: 'return',
        locationKind: 'customer',
        locationSnapshot: customerLocation,
        ...timesFrom(event.collectionWindowFrom, event.collectionWindowTo),
      });
    }

    let created = 0;
    for (const row of desired) {
      const inserted = await this.db
        .insert(appointments)
        .values({
          processId: booking.processId,
          bookingId: booking.id,
          kind: row.kind,
          locationKind: row.locationKind,
          locationSnapshot: row.locationSnapshot,
          startAt: row.startAt,
          endAt: row.endAt,
          assignedUserId,
          source: 'booking',
        })
        .onConflictDoNothing({ target: [appointments.bookingId, appointments.kind] })
        .returning({ id: appointments.id });
      created += inserted.length;
    }
    return { created };
  }

  async ensureAppointmentsForProcess(processId: string): Promise<{ created: number }> {
    const bookingRows = await this.db
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.processId, processId));
    const booking = bookingRows[0];
    if (booking === undefined) return { created: 0 };
    return this.ensureAppointmentsForBooking(booking.id);
  }

  /** Backfill für Bestandsbuchungen (Order §4) – idempotent. */
  async ensureAllBookingAppointments(): Promise<{ bookings: number; created: number }> {
    const rows = await this.db.select({ id: bookings.id }).from(bookings);
    let created = 0;
    for (const row of rows) {
      created += (await this.ensureAppointmentsForBooking(row.id)).created;
    }
    return { bookings: rows.length, created };
  }

  /**
   * Selbstheilungs-Pass für die Sichtbarkeitsgarantie (Order §8): Buchungen
   * ohne vollständige Termine werden bei jedem Heute-/Offen-Aufruf
   * nachgezogen – so geht KEINE bestätigte Buchung verloren, selbst wenn
   * der Ensure-Aufruf direkt nach der Annahme fehlschlug. Der Filter
   * greift nur auf Buchungen ohne beide Termine zu (schnell im Normalfall).
   */
  async ensureMissingBookingAppointments(): Promise<void> {
    const rows = await this.db
      .select({ id: bookings.id })
      .from(bookings)
      .innerJoin(processes, eq(processes.id, bookings.processId))
      .leftJoin(appointments, eq(appointments.bookingId, bookings.id))
      .where(sql`${processes.mainStatus} <> 'cancelled'`)
      .groupBy(bookings.id)
      .having(sql`count(${appointments.id}) < 2`);
    for (const row of rows) {
      await this.ensureAppointmentsForBooking(row.id);
    }
  }

  // ── Wochenend-Standard (Order §6) ───────────────────────────────────────

  /**
   * "Wochenend-Standard übernehmen": setzt Abhol- und Rückgabezeit auf
   * Freitag 18:00 / Sonntag 11:00, NUR wenn der Vorschlag zum
   * Eventzeitraum passt – sonst verständliche Ablehnung ohne Speichern.
   */
  async applyWeekendStandard(
    actorId: string,
    processId: string,
    now = new Date(),
  ): Promise<{ pickupAt: string; returnAt: string }> {
    const bookingRows = await this.db
      .select()
      .from(bookings)
      .where(eq(bookings.processId, processId));
    const booking = bookingRows[0];
    if (booking === undefined) {
      throw new AuthError('NOT_FOUND', 'Für diesen Vorgang existiert keine bestätigte Buchung.');
    }
    // Der Wochenend-Standard ist eine SELBSTABHOLUNGS-Regel (MASTER_SPEC §8);
    // bei Lieferungen bleibt das mit dem Kunden vereinbarte Zeitfenster
    // führend – niemals durch eine erfundene exakte Zeit ersetzen (§3/§7).
    if (booking.fulfillment !== 'pickup') {
      throw new AuthError(
        'VALIDATION',
        'Der Wochenend-Standard gilt nur für Selbstabholung. Bei Lieferungen bleibt das vereinbarte Liefer-/Rückholfenster maßgeblich.',
      );
    }
    const event = (booking.eventSnapshot ?? {}) as Record<string, unknown>;
    const eventDate = typeof event.eventDate === 'string' ? event.eventDate : '';
    const suggestion = weekendStandardSuggestion({
      eventDate,
      eventStart: typeof event.eventStart === 'string' ? event.eventStart : null,
      eventEnd: typeof event.eventEnd === 'string' ? event.eventEnd : null,
    });
    if (!suggestion.ok) {
      throw new AuthError('VALIDATION', suggestion.reason);
    }
    await this.ensureAppointmentsForBooking(booking.id);
    const rows = await this.db
      .select()
      .from(appointments)
      .where(eq(appointments.bookingId, booking.id));
    const outbound = rows.find((row) => row.kind === 'pickup');
    const inbound = rows.find((row) => row.kind === 'return');
    if (outbound === undefined || inbound === undefined) {
      throw new AuthError('CONFLICT', 'Die Termine dieser Buchung fehlen.');
    }
    // ATOMAR (Order §41): beide Zeiten in EINER Transaktion, Locks in
    // deterministischer Reihenfolge – nie ein halb angewendeter Standard.
    await this.db.transaction(async (tx) => {
      const [firstId, secondId] =
        outbound.id < inbound.id ? [outbound.id, inbound.id] : [inbound.id, outbound.id];
      const lockedFirst = await this.lockAppointment(tx, firstId);
      const lockedSecond = await this.lockAppointment(tx, secondId);
      const lockedOutbound = lockedFirst.id === outbound.id ? lockedFirst : lockedSecond;
      const lockedInbound = lockedFirst.id === inbound.id ? lockedFirst : lockedSecond;
      await this.rescheduleWithLock(tx, actorId, lockedOutbound, suggestion.pickupAt, null, now);
      await this.rescheduleWithLock(tx, actorId, lockedInbound, suggestion.returnAt, null, now);
    });
    return {
      pickupAt: suggestion.pickupAt.toISOString(),
      returnAt: suggestion.returnAt.toISOString(),
    };
  }

  // ── Verschieben / Zeit festlegen (Order §§3/16/17/27, §41) ──────────────

  /**
   * Zeit setzen/verschieben mit Optimistic Concurrency: `expectedVersion`
   * muss dem aktuellen Stand entsprechen, sonst 409 – parallele Updates
   * überschreiben sich nie still. Änderung einer BEREITS vereinbarten Zeit
   * markiert "Kundeninformation erforderlich"; eine Rückgabe-Verschiebung
   * beendet offene Überfälligkeits-Incidents (Neubewertung erfolgt lazy).
   */
  async reschedule(
    actorId: string,
    appointmentId: string,
    input: { startAt: Date | null; endAt: Date | null; expectedVersion: number },
    now = new Date(),
  ): Promise<Appointment> {
    return this.db.transaction(async (tx) => {
      const locked = await this.lockAppointment(tx, appointmentId);
      if (locked.version !== input.expectedVersion) {
        throw new AuthError(
          'CONFLICT',
          'Der Termin wurde zwischenzeitlich geändert. Bitte neu laden und erneut prüfen.',
        );
      }
      return this.rescheduleWithLock(tx, actorId, locked, input.startAt, input.endAt, now);
    });
  }

  private async rescheduleWithLock(
    tx: DatabaseTransaction,
    _actorId: string,
    locked: Appointment,
    startAt: Date | null,
    endAt: Date | null,
    now: Date,
  ): Promise<Appointment> {
    if (locked.status !== 'scheduled') {
      throw new AuthError('CONFLICT', 'Nur offene Termine können verschoben werden.');
    }
    try {
      assertValidTimePosition(startAt, endAt);
    } catch (error) {
      if (error instanceof SchedulingRuleError) throw new AuthError('VALIDATION', error.message);
      throw error;
    }
    const sameTimes =
      (locked.startAt?.getTime() ?? null) === (startAt?.getTime() ?? null) &&
      (locked.endAt?.getTime() ?? null) === (endAt?.getTime() ?? null);
    if (sameTimes) return locked;

    // Kundeninformation nur bei Änderung einer BEREITS vereinbarten Zeit
    // (Order §17); interne Neuzuweisungen erzeugen sie nie.
    const customerInfoRequiredAt =
      locked.startAt !== null ? now : (locked.customerInfoRequiredAt ?? null);

    if (locked.kind === 'return') {
      // Neubewertung der Überfälligkeit (Order §27): alte Incidents enden;
      // ist auch die neue Zeit überschritten, entsteht lazy ein NEUER
      // Incident (eigener Admin-Push-Anspruch).
      await tx
        .update(appointmentOverdueIncidents)
        .set({ resolvedAt: now })
        .where(
          and(
            eq(appointmentOverdueIncidents.appointmentId, locked.id),
            isNull(appointmentOverdueIncidents.resolvedAt),
          ),
        );
    }

    const updated = await tx
      .update(appointments)
      .set({
        startAt,
        endAt,
        customerInfoRequiredAt,
        version: locked.version + 1,
        updatedAt: now,
      })
      .where(eq(appointments.id, locked.id))
      .returning();
    const row = updated[0];
    if (row === undefined) throw new AuthError('CONFLICT', 'Termin konnte nicht geändert werden.');
    return row;
  }

  // ── Zuweisung / gleiche-Tages-Übernahme (Order §§9–11) ──────────────────

  async assign(
    actorId: string,
    appointmentId: string,
    input: { userId: string; expectedVersion: number },
    effective: ReadonlySet<PermissionKey>,
    now = new Date(),
  ): Promise<Appointment> {
    const targetRows = await this.db
      .select({ id: staffUsers.id, status: staffUsers.status })
      .from(staffUsers)
      .where(eq(staffUsers.id, input.userId));
    const target = targetRows[0];
    if (target === undefined) throw new AuthError('NOT_FOUND', 'Mitarbeiter nicht gefunden.');
    if (target.status !== 'active') {
      throw new AuthError(
        'VALIDATION',
        'Deaktivierte oder gesperrte Mitarbeiter können nicht neu zugewiesen werden.',
      );
    }

    return this.db.transaction(async (tx) => {
      const locked = await this.lockAppointment(tx, appointmentId);
      if (locked.version !== input.expectedVersion) {
        throw new AuthError(
          'CONFLICT',
          'Der Termin wurde zwischenzeitlich geändert. Bitte neu laden und erneut prüfen.',
        );
      }
      if (locked.status !== 'scheduled') {
        throw new AuthError('CONFLICT', 'Nur offene Termine können zugewiesen werden.');
      }
      if (locked.assignedUserId === input.userId) return locked;

      // Gleiche-Tages-REASSIGNMENT (Order §11): Wechsel von einem auf einen
      // anderen Mitarbeiter am lokalen Kalendertag der Durchführung.
      const sameDayReassignment =
        locked.assignedUserId !== null &&
        locked.startAt !== null &&
        isSameBerlinDay(locked.startAt, now);
      if (sameDayReassignment && !effective.has('appointment.reassign_same_day')) {
        throw new AuthError(
          'FORBIDDEN',
          'Dir fehlt das Recht, Termine am selben Tag neu zuzuweisen.',
        );
      }

      const updated = await tx
        .update(appointments)
        .set({
          assignedUserId: input.userId,
          // Erneute Zuweisung macht eine alte Bestätigung IMMER ungültig.
          acknowledgementRequestedAt: sameDayReassignment ? now : null,
          acknowledgementRequestedFor: sameDayReassignment ? input.userId : null,
          acknowledgedAt: null,
          acknowledgedBy: null,
          // Push-Vorbereitung (§11): notwendig = requestedAt gesetzt und
          // notifiedAt NULL; Phase 12 setzt den Versandzeitpunkt.
          assignmentNotifiedAt: null,
          version: locked.version + 1,
          updatedAt: now,
        })
        .where(eq(appointments.id, locked.id))
        .returning();
      const row = updated[0];
      if (row === undefined) {
        throw new AuthError('CONFLICT', 'Zuweisung konnte nicht gespeichert werden.');
      }
      return row;
    });
  }

  /** "Termin übernommen" – nur durch den neu zugewiesenen Mitarbeiter. */
  async acknowledge(actorId: string, appointmentId: string, now = new Date()): Promise<void> {
    const updated = await this.db
      .update(appointments)
      .set({ acknowledgedAt: now, acknowledgedBy: actorId, updatedAt: now })
      .where(
        and(
          eq(appointments.id, appointmentId),
          eq(appointments.acknowledgementRequestedFor, actorId),
          sql`${appointments.acknowledgementRequestedAt} IS NOT NULL`,
          isNull(appointments.acknowledgedAt),
        ),
      )
      .returning({ id: appointments.id });
    if (updated.length === 0) {
      const rows = await this.db
        .select()
        .from(appointments)
        .where(eq(appointments.id, appointmentId));
      const appointment = rows[0];
      if (appointment === undefined) throw new AuthError('NOT_FOUND', 'Termin nicht gefunden.');
      if (appointment.acknowledgementRequestedFor !== actorId) {
        throw new AuthError(
          'FORBIDDEN',
          'Nur der neu zugewiesene Mitarbeiter kann die Übernahme bestätigen.',
        );
      }
      throw new AuthError('CONFLICT', 'Für diesen Termin steht keine Übernahmebestätigung aus.');
    }
  }

  // ── Interner Planungsabschluss (Order §§9/23/30) ────────────────────────

  /**
   * Neutraler interner Abschluss – KEIN fachlicher Übergabe-/Rückgabe-
   * Abschluss (der kommt mit den Workflows späterer Phasen). Ohne
   * zugewiesenen Mitarbeiter nicht möglich (Order §9).
   */
  async complete(
    actorId: string,
    appointmentId: string,
    expectedVersion: number,
    now = new Date(),
  ): Promise<Appointment> {
    return this.db.transaction(async (tx) => {
      const locked = await this.lockAppointment(tx, appointmentId);
      if (locked.version !== expectedVersion) {
        throw new AuthError(
          'CONFLICT',
          'Der Termin wurde zwischenzeitlich geändert. Bitte neu laden und erneut prüfen.',
        );
      }
      if (locked.status !== 'scheduled') {
        throw new AuthError('CONFLICT', 'Dieser Termin ist bereits abgeschlossen.');
      }
      if (locked.assignedUserId === null) {
        throw new AuthError(
          'VALIDATION',
          'Ohne zugewiesenen Mitarbeiter kann ein Termin nicht abgeschlossen werden.',
        );
      }
      const updated = await tx
        .update(appointments)
        .set({
          status: 'completed',
          completedAt: now,
          completedBy: actorId,
          version: locked.version + 1,
          updatedAt: now,
        })
        .where(eq(appointments.id, locked.id))
        .returning();
      const row = updated[0];
      if (row === undefined) throw new AuthError('CONFLICT', 'Abschluss fehlgeschlagen.');
      // Ein intern erledigter Termin ist kein offener Überfälligkeitsfall
      // mehr – sonst bliebe der Admin-Push dauerhaft „fällig“ (Order §24).
      await tx
        .update(appointmentOverdueIncidents)
        .set({ resolvedAt: now })
        .where(
          and(
            eq(appointmentOverdueIncidents.appointmentId, locked.id),
            isNull(appointmentOverdueIncidents.resolvedAt),
          ),
        );
      return row;
    });
  }

  // ── Überfälligkeit & Incidents (Order §§23/24/26/27) ────────────────────

  /**
   * Lazy Incident-Pflege (kein Hintergrundjob): erst SELBSTHEILUNG – offene
   * Incidents, die zum aktuellen Terminstand nicht mehr passen (Termin
   * erledigt/storniert, Vorgang storniert, geplante Zeit inzwischen anders),
   * werden gelöst; das räumt auch Race-Phantome ab (paralleles Ensure gegen
   * eine gleichzeitige Verschiebung, Order §41). Danach entsteht je aktuell
   * überfälliger Rückgabe genau EIN OFFENER Incident pro verpasster Zeit –
   * ein erneut gerissenes (auch identisches) Datum ergibt einen NEUEN
   * Incident, weil die Eindeutigkeit nur offene Incidents umfasst (§24).
   */
  async ensureOverdueIncidents(now = new Date()): Promise<void> {
    await this.db.execute(sql`
      UPDATE appointment_overdue_incidents i
      SET resolved_at = ${now}
      FROM appointments a
      JOIN processes p ON p.id = a.process_id
      WHERE i.appointment_id = a.id
        AND i.resolved_at IS NULL
        AND (
          a.status <> 'scheduled'
          OR p.main_status = 'cancelled'
          OR COALESCE(a.end_at, a.start_at) IS NULL
          OR COALESCE(a.end_at, a.start_at) <> i.missed_at
        )
    `);
    await this.db.execute(sql`
      INSERT INTO appointment_overdue_incidents (appointment_id, missed_at, opened_at)
      SELECT a.id, COALESCE(a.end_at, a.start_at), ${now}
      FROM appointments a
      JOIN processes p ON p.id = a.process_id
      WHERE a.kind = 'return'
        AND a.status = 'scheduled'
        AND p.main_status <> 'cancelled'
        AND COALESCE(a.end_at, a.start_at) < ${now}
        AND NOT EXISTS (
          SELECT 1 FROM appointment_overdue_incidents i
          WHERE i.appointment_id = a.id
            AND i.missed_at = COALESCE(a.end_at, a.start_at)
            AND i.resolved_at IS NULL
        )
      ON CONFLICT (appointment_id, missed_at) WHERE resolved_at IS NULL DO NOTHING
    `);
  }

  /** "Kunde kontaktiert" (Order §26): minimales Kennzeichen am Incident. */
  async markCustomerContacted(
    actorId: string,
    appointmentId: string,
    now = new Date(),
  ): Promise<void> {
    await this.ensureOverdueIncidents(now);
    const updated = await this.db
      .update(appointmentOverdueIncidents)
      .set({ customerContactedAt: now, customerContactedBy: actorId })
      .where(
        and(
          eq(appointmentOverdueIncidents.appointmentId, appointmentId),
          isNull(appointmentOverdueIncidents.resolvedAt),
        ),
      )
      .returning({ id: appointmentOverdueIncidents.id });
    if (updated.length === 0) {
      throw new AuthError('CONFLICT', 'Dieser Termin ist aktuell nicht überfällig.');
    }
  }

  /** Push-Vorbereitung (Order §24): genau EIN Admin-Push je Incident fällig. */
  async listDueOverdueAdminNotifications(
    now = new Date(),
  ): Promise<{ incidentId: string; appointmentId: string; missedAt: Date }[]> {
    await this.ensureOverdueIncidents(now);
    const rows = await this.db
      .select()
      .from(appointmentOverdueIncidents)
      .where(
        and(
          isNull(appointmentOverdueIncidents.resolvedAt),
          isNull(appointmentOverdueIncidents.adminNotifiedAt),
        ),
      );
    return rows.map((row) => ({
      incidentId: row.id,
      appointmentId: row.appointmentId,
      missedAt: row.missedAt,
    }));
  }

  // ── Reminder-Vorbereitung (Order §25) ───────────────────────────────────

  /**
   * Fällige 1h-Erinnerungen: korrekter EFFEKTIVER Mitarbeiter inkl. aktiver
   * Vertretung, noch nicht gesendet. Phase 12 versendet und setzt
   * reminderSentAt.
   */
  async listDueReminders(
    now = new Date(),
  ): Promise<{ appointmentId: string; startAt: Date; effectiveUserId: string }[]> {
    const minutes = await getAppointmentReminderMinutes(this.db);
    const substitutions = await loadSubstitutions(this.db);
    const rows = await this.db
      .select()
      .from(appointments)
      .where(and(eq(appointments.status, 'scheduled'), isNull(appointments.reminderSentAt)));
    const due: { appointmentId: string; startAt: Date; effectiveUserId: string }[] = [];
    for (const appointment of rows) {
      if (!isReminderDue(appointment, minutes, now)) continue;
      const effectiveUserId = effectiveAssigneeForAppointment(appointment, substitutions, now);
      if (effectiveUserId === null) continue;
      due.push({ appointmentId: appointment.id, startAt: appointment.startAt!, effectiveUserId });
    }
    return due;
  }

  // ── Laden / Anreichern (Kalender, Heute, Vorschau) ──────────────────────

  private async lockAppointment(
    tx: DatabaseTransaction,
    appointmentId: string,
  ): Promise<Appointment> {
    // FOR NO KEY UPDATE: serialisiert Terminmutationen, kollidiert aber
    // nicht mit FK-KEY-SHARE-Locks (Incident-Inserts anderer Verbindungen).
    const rows = await tx
      .select()
      .from(appointments)
      .where(eq(appointments.id, appointmentId))
      .for('no key update');
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Termin nicht gefunden.');
    return row;
  }

  async byId(appointmentId: string): Promise<Appointment> {
    const rows = await this.db
      .select()
      .from(appointments)
      .where(eq(appointments.id, appointmentId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Termin nicht gefunden.');
    return row;
  }

  private async buildEnrichment(rows: Appointment[], now: Date): Promise<EnrichmentContext> {
    const processIds = [...new Set(rows.map((row) => row.processId))];
    const bookingIds = [...new Set(rows.map((row) => row.bookingId))];
    const processRows =
      processIds.length === 0
        ? []
        : await this.db
            .select({
              id: processes.id,
              processNumber: processes.processNumber,
              customerId: processes.customerId,
            })
            .from(processes)
            .where(inArray(processes.id, processIds));
    const customerIds = [...new Set(processRows.map((row) => row.customerId))];
    const customerRows =
      customerIds.length === 0
        ? []
        : await this.db
            .select({
              id: customers.id,
              firstName: customers.firstName,
              lastName: customers.lastName,
              organizationName: customers.organizationName,
              phone: customers.phone,
            })
            .from(customers)
            .where(inArray(customers.id, customerIds));
    const bookingRows =
      bookingIds.length === 0
        ? []
        : await this.db
            .select({ id: bookings.id, itemsSnapshot: bookings.itemsSnapshot })
            .from(bookings)
            .where(inArray(bookings.id, bookingIds));
    const userRows = await this.db
      .select({
        id: staffUsers.id,
        firstName: staffUsers.firstName,
        lastName: staffUsers.lastName,
      })
      .from(staffUsers);

    const customerByProcess = new Map<string, { name: string; phone: string | null }>();
    for (const process of processRows) {
      const customer = customerRows.find((row) => row.id === process.customerId);
      const name =
        customer === undefined
          ? 'Unbekannt'
          : (customer.organizationName ??
            `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim());
      customerByProcess.set(process.id, {
        name: name === '' ? 'Unbekannt' : name,
        phone: customer?.phone ?? null,
      });
    }
    const machineByBooking = new Map<string, string | null>();
    for (const booking of bookingRows) {
      const items = (booking.itemsSnapshot ?? []) as {
        kind?: string;
        productSnapshot?: { name?: unknown } | null;
        description?: string;
      }[];
      const machine = items.find((item) => item.kind === 'machine');
      const name = machine?.productSnapshot?.name;
      machineByBooking.set(
        booking.id,
        typeof name === 'string' ? name : (machine?.description ?? null),
      );
    }

    await this.ensureOverdueIncidents(now);
    const appointmentIds = rows.map((row) => row.id);
    const incidentRows =
      appointmentIds.length === 0
        ? []
        : await this.db
            .select()
            .from(appointmentOverdueIncidents)
            .where(
              and(
                inArray(appointmentOverdueIncidents.appointmentId, appointmentIds),
                isNull(appointmentOverdueIncidents.resolvedAt),
              ),
            );
    const openIncidents = new Map<string, AppointmentOverdueIncident>();
    for (const incident of incidentRows) openIncidents.set(incident.appointmentId, incident);

    const exactAddress = await getPickupExactAddress(this.db);
    const publicArea = await getPickupPublicArea(this.db);

    return {
      processNumbers: new Map(processRows.map((row) => [row.id, row.processNumber])),
      customerByProcess,
      machineByBooking,
      userNames: new Map(
        userRows.map((row) => [row.id, `${row.firstName} ${row.lastName}`.trim()]),
      ),
      openIncidents,
      // Interne Anzeige: exakte Abholadresse; nie öffentlich (Order §5).
      baseLocationLabel: exactAddress ?? `${publicArea} (exakte Adresse nicht konfiguriert)`,
      substitutions: await loadSubstitutions(this.db),
      now,
    };
  }

  private toEntry(
    appointment: Appointment,
    context: EnrichmentContext,
    conflicts: DetectedConflict[],
  ): CalendarEntry {
    const effectiveAssigneeId = effectiveAssigneeForAppointment(
      appointment,
      context.substitutions,
      context.now,
    );
    const customer = context.customerByProcess.get(appointment.processId);
    const location = (appointment.locationSnapshot ?? {}) as Record<string, unknown>;
    const locationLabel =
      appointment.locationKind === 'base'
        ? context.baseLocationLabel
        : [location.street, [location.postalCode, location.city].filter(Boolean).join(' ')]
            .filter((part) => typeof part === 'string' && part !== '')
            .join(', ') || 'Adresse fehlt';
    const overdueIncident = context.openIncidents.get(appointment.id) ?? null;
    const own = conflicts.filter((conflict) => conflict.appointmentIds.includes(appointment.id));
    return {
      id: appointment.id,
      processId: appointment.processId,
      processNumber: context.processNumbers.get(appointment.processId) ?? '',
      bookingId: appointment.bookingId,
      kind: appointment.kind,
      status: appointment.status,
      startAt: appointment.startAt?.toISOString() ?? null,
      endAt: appointment.endAt?.toISOString() ?? null,
      timezone: appointment.timezone,
      locationKind: appointment.locationKind,
      locationLabel,
      customerName: customer?.name ?? 'Unbekannt',
      customerPhone: customer?.phone ?? null,
      machineName: context.machineByBooking.get(appointment.bookingId) ?? null,
      assignedUserId: appointment.assignedUserId,
      assignedName:
        appointment.assignedUserId === null
          ? null
          : (context.userNames.get(appointment.assignedUserId) ?? null),
      effectiveAssigneeId,
      effectiveAssigneeName:
        effectiveAssigneeId === null ? null : (context.userNames.get(effectiveAssigneeId) ?? null),
      substituted: effectiveAssigneeId !== appointment.assignedUserId,
      overdue: isReturnOverdue(appointment, context.now),
      overdueIncident:
        overdueIncident === null
          ? null
          : {
              id: overdueIncident.id,
              missedAt: overdueIncident.missedAt.toISOString(),
              customerContactedAt: overdueIncident.customerContactedAt?.toISOString() ?? null,
            },
      customerInfoRequiredAt: appointment.customerInfoRequiredAt?.toISOString() ?? null,
      acknowledgementPending:
        appointment.acknowledgementRequestedAt !== null && appointment.acknowledgedAt === null,
      acknowledgementRequestedFor: appointment.acknowledgementRequestedFor,
      completedAt: appointment.completedAt?.toISOString() ?? null,
      version: appointment.version,
      conflicts: own.map((conflict) => ({
        type: conflict.type,
        severity: conflict.severity,
        reason: conflict.reason,
        appointmentIds: conflict.appointmentIds,
      })),
    };
  }

  private async enrichAll(rows: Appointment[], now: Date): Promise<CalendarEntry[]> {
    const context = await this.buildEnrichment(rows, now);
    const conflictInput: ConflictAppointment[] = rows.map((row) => ({
      ...row,
      effectiveAssigneeId: effectiveAssigneeForAppointment(row, context.substitutions, now),
    }));
    const conflicts = await this.conflicts.detectVisible({ appointments: conflictInput });
    return rows.map((row) => this.toEntry(row, context, conflicts));
  }

  /**
   * Kalenderdaten für einen Zeitraum (Order §§13/14/19). scope='mine'
   * nutzt die EFFEKTIVE Zuständigkeit inkl. Vertretung; 'all' und der
   * Mitarbeiterfilter erfordern calendar.view_all (Routen-Ebene).
   */
  async listCalendar(
    viewerId: string,
    input: {
      from: Date;
      to: Date;
      scope: 'mine' | 'all';
      kinds?: readonly Appointment['kind'][] | undefined;
      userId?: string | undefined;
    },
    now = new Date(),
  ): Promise<CalendarEntry[]> {
    const rows = (
      await this.db
        .select({ appointment: appointments })
        .from(appointments)
        .innerJoin(processes, eq(processes.id, appointments.processId))
        .where(
          and(
            sql`${appointments.startAt} IS NOT NULL`,
            sql`${appointments.startAt} < ${input.to}`,
            sql`COALESCE(${appointments.endAt}, ${appointments.startAt}) >= ${input.from}`,
            sql`${appointments.status} <> 'cancelled'`,
            // Stornierte Vorgänge sind kein Geschäft mehr – ihre Termine
            // gehören nicht in den operativen Kalender (Order §1).
            sql`${processes.mainStatus} <> 'cancelled'`,
          ),
        )
        .orderBy(asc(appointments.startAt))
    ).map((row) => row.appointment);
    let entries = await this.enrichAll(rows, now);
    if (input.scope === 'mine') {
      entries = entries.filter((entry) => entry.effectiveAssigneeId === viewerId);
    }
    if (input.userId !== undefined) {
      entries = entries.filter((entry) => entry.effectiveAssigneeId === input.userId);
    }
    // kinds === [] bedeutet „keine Terminart ausgewählt“ → leeres Ergebnis
    // (Order §13: der Filter zeigt genau die gewählten Arten).
    if (input.kinds !== undefined) {
      entries = entries.filter((entry) => input.kinds!.includes(entry.kind));
    }
    return entries;
  }

  /** Ungeplante/unzugewiesene Termine (Order §8/§9) – nichts geht verloren. */
  async listOrganizationalOpen(
    viewerId: string,
    scope: 'mine' | 'all',
    now = new Date(),
  ): Promise<CalendarEntry[]> {
    await this.ensureMissingBookingAppointments();
    const rows = (
      await this.db
        .select({ appointment: appointments })
        .from(appointments)
        .innerJoin(processes, eq(processes.id, appointments.processId))
        .where(
          and(
            eq(appointments.status, 'scheduled'),
            sql`(${appointments.startAt} IS NULL OR ${appointments.assignedUserId} IS NULL)`,
            sql`${processes.mainStatus} <> 'cancelled'`,
          ),
        )
    ).map((row) => row.appointment);
    let entries = await this.enrichAll(rows, now);
    if (scope === 'mine') {
      entries = entries.filter((entry) => entry.effectiveAssigneeId === viewerId);
    }
    return entries;
  }

  /** Termine eines Vorgangs (Terminplanung), inkl. Lazy-Ensure. */
  async listForProcess(processId: string, now = new Date()): Promise<CalendarEntry[]> {
    await this.ensureAppointmentsForProcess(processId);
    const rows = await this.db
      .select()
      .from(appointments)
      .where(eq(appointments.processId, processId))
      .orderBy(asc(appointments.createdAt));
    return this.enrichAll(rows, now);
  }

  /** Termine für die serverseitige Konfliktprüfung (Suppression, §20). */
  async listForConflictCheck(
    appointmentIds: readonly string[],
    now = new Date(),
  ): Promise<ConflictAppointment[]> {
    const rows =
      appointmentIds.length === 0
        ? []
        : await this.db
            .select()
            .from(appointments)
            .where(inArray(appointments.id, [...appointmentIds]));
    const substitutions = await loadSubstitutions(this.db);
    return rows.map((row) => ({
      ...row,
      effectiveAssigneeId: effectiveAssigneeForAppointment(row, substitutions, now),
    }));
  }

  async entryById(appointmentId: string, now = new Date()): Promise<CalendarEntry> {
    const appointment = await this.byId(appointmentId);
    // Konflikte im Umfeld des Termins mitberechnen (gleicher Zeitraum).
    const rows = await this.db
      .select()
      .from(appointments)
      .where(
        appointment.startAt === null
          ? eq(appointments.id, appointment.id)
          : and(
              sql`${appointments.startAt} IS NOT NULL`,
              sql`${appointments.startAt} < ${new Date(
                (appointment.endAt ?? appointment.startAt).getTime() + 24 * 3600_000,
              )}`,
              sql`COALESCE(${appointments.endAt}, ${appointments.startAt}) >= ${new Date(
                appointment.startAt.getTime() - 24 * 3600_000,
              )}`,
              sql`${appointments.status} <> 'cancelled'`,
            ),
      );
    const all = rows.some((row) => row.id === appointment.id) ? rows : [...rows, appointment];
    const entries = await this.enrichAll(all, now);
    const entry = entries.find((item) => item.id === appointmentId);
    if (entry === undefined) throw new AuthError('NOT_FOUND', 'Termin nicht gefunden.');
    return entry;
  }

  /**
   * „Heute“ (Order §22): 1. überfällige Rückgaben, 2. heutige Termine,
   * 3. organisatorisch Offenes, 4. bei wenig Inhalt bis zu 2 kommende.
   */
  async todayView(
    viewerId: string,
    scope: 'mine' | 'all',
    now = new Date(),
  ): Promise<{
    overdue: CalendarEntry[];
    today: CalendarEntry[];
    organizational: CalendarEntry[];
    upcoming: CalendarEntry[];
  }> {
    await this.ensureMissingBookingAppointments();
    await this.ensureOverdueIncidents(now);
    const todayIso = berlinDateOf(now);
    const dayStart = berlinStartOfDay(todayIso);
    const nextDayStart = new Date(dayStart.getTime() + 36 * 3600_000);
    const realNextDayStart = berlinStartOfDay(berlinDateOf(nextDayStart));

    const rows = (
      await this.db
        .select({ appointment: appointments })
        .from(appointments)
        .innerJoin(processes, eq(processes.id, appointments.processId))
        .where(
          and(
            sql`${appointments.status} <> 'cancelled'`,
            sql`${processes.mainStatus} <> 'cancelled'`,
          ),
        )
        .orderBy(asc(appointments.startAt))
    ).map((row) => row.appointment);
    let entries = await this.enrichAll(rows, now);
    if (scope === 'mine') {
      entries = entries.filter((entry) => entry.effectiveAssigneeId === viewerId);
    }

    const overdue = entries
      .filter((entry) => entry.overdue)
      .sort((a, b) => (a.startAt ?? '').localeCompare(b.startAt ?? ''));
    const overdueIds = new Set(overdue.map((entry) => entry.id));
    const today = entries.filter(
      (entry) =>
        entry.startAt !== null &&
        !overdueIds.has(entry.id) &&
        new Date(entry.startAt).getTime() >= dayStart.getTime() &&
        new Date(entry.startAt).getTime() < realNextDayStart.getTime(),
    );
    const organizational = entries.filter(
      (entry) =>
        entry.status === 'scheduled' &&
        (entry.startAt === null || entry.assignedUserId === null) &&
        !overdueIds.has(entry.id),
    );
    // UX-Regel (Order §22/§38): bei wenigen heutigen Terminen bis zu 2
    // kommende Termine zeigen.
    const upcoming =
      today.filter((entry) => entry.status === 'scheduled').length < 3
        ? entries
            .filter(
              (entry) =>
                entry.status === 'scheduled' &&
                entry.startAt !== null &&
                new Date(entry.startAt).getTime() >= realNextDayStart.getTime(),
            )
            .slice(0, 2)
        : [];
    return { overdue, today, organizational, upcoming };
  }
}
