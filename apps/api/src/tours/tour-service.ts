import {
  appointments,
  processes,
  staffUsers,
  systemSettings,
  tourDelayIncidents,
  tourLiveLocations,
  tourStops,
  tours,
  type Appointment,
  type Database,
  type DatabaseExecutor,
  type DatabaseTransaction,
  type Tour,
  type TourStop,
} from '@mietroyal/database';
import {
  TOUR_STOP_BUFFER_MINUTES_DEFAULT,
  TOUR_STOP_BUFFER_MINUTES_MAX,
  TOUR_STOP_BUFFER_MINUTES_MIN,
  berlinDateOf,
  berlinDateTimeToUtc,
  resolveEffectiveAssigneeId,
  tourStopState,
  type SubstitutionLike,
  type TourStopState,
} from '@mietroyal/domain';
import type { PermissionKey } from '@mietroyal/permissions';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import { PICKUP_EXACT_ADDRESS_KEY } from '../crm/settings-service.ts';
import { effectiveAssigneeForAppointment, loadSubstitutions } from '../scheduling/assignee.ts';
import { SchedulingService } from '../scheduling/scheduling-service.ts';
import { TOUR_MESSAGES, TourError } from './errors.ts';

/**
 * Phase 13 (Touren, Design §7): Tour-Lebenszyklus, Stopps, Reihenfolge,
 * Pin/Puffer, Start/Ende/Abbruch/Übernahme, Stale-/Storno-Haken.
 *
 * Grundsätze:
 * - `appointments` bleibt Source of Truth (Art, Zeit, Zuständigkeit, Abschluss,
 *   Storno). Der Stopp-Zustand wird NUR abgeleitet (`tourStopState`).
 * - Zuständigkeit NIE selbst schreiben: Zuweisungen laufen ausschließlich
 *   über `SchedulingService.assignWithin` (Same-Day-Recht, Übernahme-
 *   bestätigung, Push-Vorbereitung bleiben korrekt – Order §26/§29).
 * - Jede Mutation von Tour oder Stoppfolge: Zeilensperre FOR NO KEY UPDATE
 *   + Version +1 (CAS über `expectedVersion`, Order §62); Planungswerte
 *   werden bei Änderungen `stale`.
 * - Keine Provider-Aufrufe hier (Planung: planning-service.ts).
 */

const OPEN_TOUR_STATUSES = ['draft', 'ready', 'active'] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const END_REASON_MIN = 3;
const END_REASON_MAX = 500;

export interface LoadedStop {
  stop: TourStop;
  appointment: Appointment;
  state: TourStopState;
}

export interface LoadedTour {
  tour: Tour;
  /** In Reihenfolge (sequence). */
  stops: LoadedStop[];
}

export interface TourDriverContext {
  effectiveDriverId: string | null;
  substituted: boolean;
}

function isOpenStatus(status: Tour['status']): boolean {
  return (OPEN_TOUR_STATUSES as readonly string[]).includes(status);
}

function versionConflict(): TourError {
  return new TourError(
    'CONFLICT',
    'TOUR_VERSION_CONFLICT',
    'Die Tour wurde zwischenzeitlich geändert. Bitte neu laden und erneut prüfen.',
  );
}

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return (error as { code?: unknown }).code === '23505' || cause?.code === '23505';
}

export class TourService {
  private readonly scheduling: SchedulingService;

  constructor(
    private readonly db: Database,
    scheduling?: SchedulingService,
  ) {
    this.scheduling = scheduling ?? new SchedulingService(db);
  }

  // ── Laden ────────────────────────────────────────────────────────────────

  async byId(tourId: string, executor: DatabaseExecutor = this.db): Promise<Tour> {
    const rows = await executor.select().from(tours).where(eq(tours.id, tourId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Tour nicht gefunden.');
    return row;
  }

  async lockTour(tx: DatabaseTransaction, tourId: string): Promise<Tour> {
    const rows = await tx.select().from(tours).where(eq(tours.id, tourId)).for('no key update');
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Tour nicht gefunden.');
    return row;
  }

  async loadStops(executor: DatabaseExecutor, tourId: string): Promise<LoadedStop[]> {
    const rows = await executor
      .select({ stop: tourStops, appointment: appointments })
      .from(tourStops)
      .innerJoin(appointments, eq(appointments.id, tourStops.appointmentId))
      .where(eq(tourStops.tourId, tourId))
      .orderBy(asc(tourStops.sequence), asc(tourStops.createdAt));
    return rows.map((row) => ({
      stop: row.stop,
      appointment: row.appointment,
      state: tourStopState({
        appointmentStatus: row.appointment.status,
        skippedAt: row.stop.skippedAt,
        arrivedAt: row.stop.arrivedAt,
      }),
    }));
  }

  /**
   * Tour mit Stopps laden – mit Lazy-Heilung (Order §36): Stopps stornierter
   * Termine erhalten `skippedAt`; eine geänderte Depotadresse (Setting
   * `pickup_exact_address` nach der letzten Berechnung) macht den Plan stale.
   */
  async load(tourId: string, now = new Date()): Promise<LoadedTour> {
    const tour = await this.byId(tourId);
    // Phase 13 (Fix N4): reines Lesen öffnet KEINE Schreibtransaktion/Sperre –
    // erst eine Lesevorprüfung, die Heilung nur bei Bedarf unter Zeilensperre.
    if (await this.healingNeeded(this.db, tour)) {
      await this.db.transaction(async (tx) => {
        const locked = await this.lockTour(tx, tourId);
        await this.healWithin(tx, locked, now);
      });
      return { tour: await this.byId(tourId), stops: await this.loadStops(this.db, tourId) };
    }
    return { tour, stops: await this.loadStops(this.db, tourId) };
  }

  /** Stopps, die operativ geschlossen sind (erledigt/storniert/übersprungen) – für Incident-Heilung (Fix F3). */
  private closedStopIds(executor: DatabaseExecutor, tourId: string) {
    return executor
      .select({ id: tourStops.id })
      .from(tourStops)
      .innerJoin(appointments, eq(appointments.id, tourStops.appointmentId))
      .where(
        and(
          eq(tourStops.tourId, tourId),
          or(
            isNotNull(tourStops.skippedAt),
            inArray(appointments.status, ['completed', 'cancelled']),
          ),
        ),
      );
  }

  /**
   * Fix N4: Lesevorprüfung ohne Sperre – gibt es etwas zu heilen (Stopps
   * stornierter Termine, offene Incidents geschlossener Stopps, geänderte
   * Depotadresse seit der letzten Berechnung)?
   */
  private async healingNeeded(executor: DatabaseExecutor, tour: Tour): Promise<boolean> {
    if (!isOpenStatus(tour.status)) return false;
    const cancelled = await executor
      .select({ id: tourStops.id })
      .from(tourStops)
      .innerJoin(appointments, eq(appointments.id, tourStops.appointmentId))
      .where(
        and(
          eq(tourStops.tourId, tour.id),
          isNull(tourStops.skippedAt),
          isNull(tourStops.releasedAt),
          eq(appointments.status, 'cancelled'),
        ),
      )
      .limit(1);
    if (cancelled.length > 0) return true;
    const staleIncidents = await executor
      .select({ id: tourDelayIncidents.id })
      .from(tourDelayIncidents)
      .where(
        and(
          eq(tourDelayIncidents.tourId, tour.id),
          isNull(tourDelayIncidents.resolvedAt),
          inArray(tourDelayIncidents.stopId, this.closedStopIds(executor, tour.id)),
        ),
      )
      .limit(1);
    if (staleIncidents.length > 0) return true;
    if (
      (tour.planningStatus === 'planned' || tour.planningStatus === 'infeasible') &&
      tour.routeCalculatedAt !== null
    ) {
      const setting = await executor
        .select({ updatedAt: systemSettings.updatedAt })
        .from(systemSettings)
        .where(eq(systemSettings.key, PICKUP_EXACT_ADDRESS_KEY));
      const updatedAt = setting[0]?.updatedAt ?? null;
      if (updatedAt !== null && updatedAt.getTime() > tour.routeCalculatedAt.getTime()) return true;
    }
    return false;
  }

  async loadMany(tourIds: readonly string[], now = new Date()): Promise<LoadedTour[]> {
    const result: LoadedTour[] = [];
    for (const id of tourIds) result.push(await this.load(id, now));
    return result;
  }

  async listForDate(dateIso: string, now = new Date()): Promise<LoadedTour[]> {
    const rows = await this.db
      .select({ id: tours.id })
      .from(tours)
      .where(eq(tours.tourDate, dateIso))
      .orderBy(asc(tours.createdAt), asc(tours.id));
    return this.loadMany(
      rows.map((row) => row.id),
      now,
    );
  }

  /** Eigene aktive Tour (gespeicherter Fahrer ODER effektive Vertretung, Order §30). */
  async findActiveFor(userId: string, now = new Date()): Promise<LoadedTour | null> {
    const rows = await this.db
      .select()
      .from(tours)
      .where(eq(tours.status, 'active'))
      .orderBy(asc(tours.startedAt), asc(tours.id));
    const substitutions = await loadSubstitutions(this.db);
    const own = rows.find(
      (row) =>
        row.assignedUserId === userId || this.effectiveDriverId(row, substitutions, now) === userId,
    );
    return own === undefined ? null : this.load(own.id, now);
  }

  /**
   * Effektiver Fahrer (Vertretung) – Stichzeit: liegt das Tourdatum in der
   * Zukunft, die Tagesmitte des Tourdatums (Berlin), sonst jetzt.
   */
  effectiveDriverId(
    tour: Pick<Tour, 'assignedUserId' | 'tourDate'>,
    substitutions: readonly SubstitutionLike[],
    now: Date,
  ): string | null {
    const at = tour.tourDate > berlinDateOf(now) ? berlinDateTimeToUtc(tour.tourDate, 12, 0) : now;
    return resolveEffectiveAssigneeId(tour.assignedUserId, at, substitutions);
  }

  async driverContext(tour: Tour, now = new Date()): Promise<TourDriverContext> {
    const substitutions = await loadSubstitutions(this.db);
    const effectiveDriverId = this.effectiveDriverId(tour, substitutions, now);
    return { effectiveDriverId, substituted: effectiveDriverId !== tour.assignedUserId };
  }

  /** Sichtbarkeit (Design §7): view_all/manage alles; sonst eigene/effektive Tour. */
  async canView(
    tour: Tour,
    viewerId: string,
    effective: ReadonlySet<PermissionKey>,
    now = new Date(),
  ): Promise<boolean> {
    if (effective.has('calendar.view_all') || effective.has('calendar.manage')) return true;
    if (tour.assignedUserId === viewerId) return true;
    const context = await this.driverContext(tour, now);
    return context.effectiveDriverId === viewerId;
  }

  /** Fahrer der Tour (gespeichert oder effektiv)? Für operative Aktionen. */
  async isDriver(tour: Tour, userId: string, now = new Date()): Promise<boolean> {
    if (tour.assignedUserId === userId) return true;
    const context = await this.driverContext(tour, now);
    return context.effectiveDriverId === userId;
  }

  // ── Heilung / Stale ──────────────────────────────────────────────────────

  private async healWithin(tx: DatabaseTransaction, tour: Tour, now: Date): Promise<void> {
    if (!isOpenStatus(tour.status)) return;
    const skipped = await tx
      .update(tourStops)
      .set({ skippedAt: now, updatedAt: now })
      .where(
        and(
          eq(tourStops.tourId, tour.id),
          isNull(tourStops.skippedAt),
          isNull(tourStops.releasedAt),
          inArray(
            tourStops.appointmentId,
            tx
              .select({ id: appointments.id })
              .from(appointments)
              .where(eq(appointments.status, 'cancelled')),
          ),
        ),
      )
      .returning({ id: tourStops.id });
    // Phase 13 (Fix F3): offene Verspätungs-Incidents zu erledigten/übersprungenen
    // Stopps gelten als gelöst (ohne Provider-Aufruf) – keine stehengebliebene Warnung.
    await tx
      .update(tourDelayIncidents)
      .set({ resolvedAt: now, lastEvaluatedAt: now })
      .where(
        and(
          eq(tourDelayIncidents.tourId, tour.id),
          isNull(tourDelayIncidents.resolvedAt),
          inArray(tourDelayIncidents.stopId, this.closedStopIds(tx, tour.id)),
        ),
      );
    let invalidate = skipped.length > 0;
    if (
      !invalidate &&
      (tour.planningStatus === 'planned' || tour.planningStatus === 'infeasible') &&
      tour.routeCalculatedAt !== null
    ) {
      const setting = await tx
        .select({ updatedAt: systemSettings.updatedAt })
        .from(systemSettings)
        .where(eq(systemSettings.key, PICKUP_EXACT_ADDRESS_KEY));
      const updatedAt = setting[0]?.updatedAt ?? null;
      if (updatedAt !== null && updatedAt.getTime() > tour.routeCalculatedAt.getTime()) {
        invalidate = true;
      }
    }
    if (invalidate) await this.bumpWithin(tx, tour, now, { invalidatePlan: true });
  }

  /**
   * Storno eines Vorgangs (Order §36): Stopps stornierter Termine in offenen
   * Touren operativ schließen (`skippedAt`) – nach dem Commit des Stornos
   * (Listener) und zusätzlich lazy beim Lesen.
   */
  async markCancelledStops(processId: string, now = new Date()): Promise<{ stops: number }> {
    const rows = await this.db
      .select({ tourId: tourStops.tourId })
      .from(tourStops)
      .innerJoin(appointments, eq(appointments.id, tourStops.appointmentId))
      .where(
        and(
          eq(appointments.processId, processId),
          eq(appointments.status, 'cancelled'),
          isNull(tourStops.skippedAt),
          isNull(tourStops.releasedAt),
        ),
      );
    const tourIds = [...new Set(rows.map((row) => row.tourId))];
    let total = 0;
    for (const tourId of tourIds) {
      total += await this.db.transaction(async (tx) => {
        const tour = await this.lockTour(tx, tourId);
        const before = await tx
          .select({ id: tourStops.id })
          .from(tourStops)
          .where(and(eq(tourStops.tourId, tourId), isNull(tourStops.skippedAt)));
        await this.healWithin(tx, tour, now);
        const after = await tx
          .select({ id: tourStops.id })
          .from(tourStops)
          .where(and(eq(tourStops.tourId, tourId), isNull(tourStops.skippedAt)));
        return before.length - after.length;
      });
    }
    return { stops: total };
  }

  /**
   * Terminänderung (Order §37): jede offene Tour, die den Termin enthält,
   * erhält Version +1 (ein laufender Vorschlag wird damit verworfen) und –
   * falls berechnet – `planning_status = stale`.
   */
  async markStaleForAppointment(appointmentId: string, now = new Date()): Promise<void> {
    const rows = await this.db
      .select({ tourId: tourStops.tourId })
      .from(tourStops)
      .innerJoin(tours, eq(tours.id, tourStops.tourId))
      .where(
        and(
          eq(tourStops.appointmentId, appointmentId),
          isNull(tourStops.releasedAt),
          inArray(tours.status, [...OPEN_TOUR_STATUSES]),
        ),
      );
    for (const row of rows) {
      await this.db.transaction(async (tx) => {
        const tour = await this.lockTour(tx, row.tourId);
        if (!isOpenStatus(tour.status)) return;
        await this.bumpWithin(tx, tour, now, { invalidatePlan: true });
      });
    }
  }

  private async bumpWithin(
    tx: DatabaseTransaction,
    tour: Tour,
    now: Date,
    options: { invalidatePlan: boolean; set?: Partial<typeof tours.$inferInsert> },
  ): Promise<Tour> {
    const invalidate =
      options.invalidatePlan &&
      (tour.planningStatus === 'planned' || tour.planningStatus === 'infeasible');
    const updated = await tx
      .update(tours)
      .set({
        ...(options.set ?? {}),
        ...(invalidate ? { planningStatus: 'stale' as const } : {}),
        version: tour.version + 1,
        updatedAt: now,
      })
      .where(eq(tours.id, tour.id))
      .returning();
    const row = updated[0];
    if (row === undefined) throw new AuthError('CONFLICT', 'Tour konnte nicht gespeichert werden.');
    return row;
  }

  private assertVersion(tour: Tour, expectedVersion: number | undefined): void {
    if (expectedVersion !== undefined && tour.version !== expectedVersion) throw versionConflict();
  }

  private assertEditable(tour: Tour): void {
    if (!isOpenStatus(tour.status)) {
      throw new TourError(
        'CONFLICT',
        'TOUR_NOT_EDITABLE',
        'Abgeschlossene oder abgebrochene Touren können nicht mehr bearbeitet werden.',
      );
    }
  }

  // ── Anlegen ──────────────────────────────────────────────────────────────

  async create(
    actorId: string,
    input: { tourDate: string; assignedUserId: string },
    now = new Date(),
  ): Promise<Tour> {
    if (!ISO_DATE.test(input.tourDate) || Number.isNaN(Date.parse(`${input.tourDate}T00:00:00Z`))) {
      throw new AuthError('VALIDATION', 'Bitte ein gültiges Tourdatum (JJJJ-MM-TT) angeben.');
    }
    await this.assertActiveStaff(this.db, input.assignedUserId);
    const inserted = await this.db
      .insert(tours)
      .values({
        tourDate: input.tourDate,
        assignedUserId: input.assignedUserId,
        createdBy: actorId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) throw new AuthError('CONFLICT', 'Tour konnte nicht angelegt werden.');
    return row;
  }

  private async assertActiveStaff(executor: DatabaseExecutor, userId: string): Promise<void> {
    const rows = await executor
      .select({ status: staffUsers.status })
      .from(staffUsers)
      .where(eq(staffUsers.id, userId));
    const user = rows[0];
    if (user === undefined) throw new AuthError('NOT_FOUND', 'Mitarbeiter nicht gefunden.');
    if (user.status !== 'active') {
      throw new TourError(
        'VALIDATION',
        'TOUR_DRIVER_INACTIVE',
        'Nur aktive Mitarbeiter können als Fahrer eingetragen werden.',
      );
    }
  }

  // ── Stopps (Order §§12–13, §26) ──────────────────────────────────────────

  async addStop(
    actorId: string,
    tourId: string,
    input: {
      appointmentId: string;
      expectedVersion?: number | undefined;
      reassign?: boolean | undefined;
    },
    effective: ReadonlySet<PermissionKey>,
    now = new Date(),
  ): Promise<Tour> {
    return this.db.transaction(async (tx) => {
      const tour = await this.lockTour(tx, tourId);
      this.assertEditable(tour);
      this.assertVersion(tour, input.expectedVersion);

      const appointmentRows = await tx
        .select()
        .from(appointments)
        .where(eq(appointments.id, input.appointmentId))
        .for('no key update');
      const appointment = appointmentRows[0];
      if (appointment === undefined) throw new AuthError('NOT_FOUND', 'Termin nicht gefunden.');
      if (appointment.status !== 'scheduled') {
        throw new TourError(
          'CONFLICT',
          'APPOINTMENT_NOT_SCHEDULED',
          'Nur offene Termine können in eine Tour aufgenommen werden.',
        );
      }
      const processRows = await tx
        .select({ mainStatus: processes.mainStatus })
        .from(processes)
        .where(eq(processes.id, appointment.processId));
      if (processRows[0]?.mainStatus === 'cancelled') {
        throw new TourError(
          'CONFLICT',
          'APPOINTMENT_NOT_SCHEDULED',
          'Der Vorgang dieses Termins ist storniert.',
        );
      }
      if (appointment.startAt !== null && berlinDateOf(appointment.startAt) !== tour.tourDate) {
        throw new TourError(
          'CONFLICT',
          'APPOINTMENT_NOT_ON_TOUR_DATE',
          'Der Termin liegt nicht am Tourdatum.',
        );
      }
      const planned = await tx
        .select({ id: tourStops.id, tourId: tourStops.tourId })
        .from(tourStops)
        .where(and(eq(tourStops.appointmentId, appointment.id), isNull(tourStops.releasedAt)));
      if (planned.length > 0) {
        throw new TourError(
          'CONFLICT',
          'TOUR_STOP_ALREADY_PLANNED',
          'Der Termin ist bereits in einer offenen Tour eingeplant.',
          { tourId: planned[0]!.tourId },
        );
      }

      // Zuständigkeit (Order §26): nie still überschreiben, nie eigene Logik.
      const substitutions = await loadSubstitutions(tx);
      const effectiveAssignee = effectiveAssigneeForAppointment(appointment, substitutions, now);
      if (appointment.assignedUserId === null) {
        if (!effective.has('appointment.assign')) {
          throw new AuthError('FORBIDDEN', 'Dir fehlt das Recht, Termine zuzuweisen.');
        }
        await this.scheduling.assignWithin(
          tx,
          actorId,
          appointment.id,
          { userId: tour.assignedUserId, expectedVersion: appointment.version },
          effective,
          now,
        );
      } else if (
        appointment.assignedUserId !== tour.assignedUserId &&
        effectiveAssignee !== tour.assignedUserId
      ) {
        const nameRows = await tx
          .select({ firstName: staffUsers.firstName, lastName: staffUsers.lastName })
          .from(staffUsers)
          .where(eq(staffUsers.id, appointment.assignedUserId));
        const assignedName =
          nameRows[0] === undefined
            ? null
            : `${nameRows[0].firstName} ${nameRows[0].lastName}`.trim();
        if (input.reassign !== true) {
          throw new TourError(
            'CONFLICT',
            'APPOINTMENT_ASSIGNED_ELSEWHERE',
            `Der Termin ist ${assignedName ?? 'einer anderen Person'} zugewiesen. Die Zuständigkeit wird nur auf ausdrücklichen Wunsch geändert.`,
            { assignedUserId: appointment.assignedUserId, assignedName },
          );
        }
        if (!effective.has('appointment.assign')) {
          throw new AuthError('FORBIDDEN', 'Dir fehlt das Recht, Termine zuzuweisen.');
        }
        await this.scheduling.assignWithin(
          tx,
          actorId,
          appointment.id,
          { userId: tour.assignedUserId, expectedVersion: appointment.version },
          effective,
          now,
        );
      }

      const maxRows = await tx
        .select({ max: sql<number | null>`max(${tourStops.sequence})` })
        .from(tourStops)
        .where(eq(tourStops.tourId, tour.id));
      const sequence = Number(maxRows[0]?.max ?? 0) + 1;
      try {
        await tx.insert(tourStops).values({
          tourId: tour.id,
          appointmentId: appointment.id,
          sequence,
          bufferMinutes: TOUR_STOP_BUFFER_MINUTES_DEFAULT,
          createdAt: now,
          updatedAt: now,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new TourError(
            'CONFLICT',
            'TOUR_STOP_ALREADY_PLANNED',
            'Der Termin ist bereits in einer offenen Tour eingeplant.',
          );
        }
        throw error;
      }
      return this.bumpWithin(tx, tour, now, { invalidatePlan: true });
    });
  }

  private async stopOfTour(
    tx: DatabaseTransaction,
    tourId: string,
    stopId: string,
  ): Promise<LoadedStop> {
    const stops = await this.loadStops(tx, tourId);
    const found = stops.find((entry) => entry.stop.id === stopId);
    if (found === undefined) throw new AuthError('NOT_FOUND', 'Stopp nicht gefunden.');
    return found;
  }

  async removeStop(
    actorId: string,
    tourId: string,
    stopId: string,
    input: { expectedVersion?: number | undefined },
    now = new Date(),
  ): Promise<Tour> {
    void actorId;
    return this.db.transaction(async (tx) => {
      const tour = await this.lockTour(tx, tourId);
      this.assertEditable(tour);
      this.assertVersion(tour, input.expectedVersion);
      const entry = await this.stopOfTour(tx, tourId, stopId);
      if (entry.state === 'done') {
        throw new TourError(
          'CONFLICT',
          'TOUR_STOP_DONE',
          'Erledigte Stopps bleiben als Historie in der Tour.',
        );
      }
      // Phase 13 (Fix F5): Incident-Historie des Stopps (auch ein offener Incident) in
      // derselben Transaktion löschen – der Stopp verlässt die Tour (FK ohne Kaskade).
      await tx.delete(tourDelayIncidents).where(eq(tourDelayIncidents.stopId, stopId));
      await tx.delete(tourStops).where(eq(tourStops.id, stopId));
      const remaining = await this.loadStops(tx, tourId);
      for (let i = 0; i < remaining.length; i += 1) {
        const stop = remaining[i]!.stop;
        if (stop.sequence !== i + 1) {
          await tx
            .update(tourStops)
            .set({ sequence: i + 1, updatedAt: now })
            .where(eq(tourStops.id, stop.id));
        }
      }
      return this.bumpWithin(tx, tour, now, { invalidatePlan: true });
    });
  }

  /** Vollständige Reihenfolge (gleiche Menge) – Drag&Drop mit CAS (Order §62). */
  async reorder(
    actorId: string,
    tourId: string,
    input: { expectedVersion?: number | undefined; order: readonly string[] },
    now = new Date(),
  ): Promise<Tour> {
    void actorId;
    return this.db.transaction(async (tx) => {
      const tour = await this.lockTour(tx, tourId);
      this.assertEditable(tour);
      this.assertVersion(tour, input.expectedVersion);
      const stops = await this.loadStops(tx, tourId);
      const current = new Set(stops.map((entry) => entry.stop.id));
      const requested = new Set(input.order);
      if (
        requested.size !== input.order.length ||
        requested.size !== current.size ||
        [...requested].some((id) => !current.has(id))
      ) {
        throw new AuthError(
          'VALIDATION',
          'Die Reihenfolge muss genau alle Stopps der Tour enthalten.',
        );
      }
      for (let i = 0; i < input.order.length; i += 1) {
        await tx
          .update(tourStops)
          .set({ sequence: i + 1, updatedAt: now })
          .where(eq(tourStops.id, input.order[i]!));
      }
      return this.bumpWithin(tx, tour, now, { invalidatePlan: true });
    });
  }

  async updateStop(
    actorId: string,
    tourId: string,
    stopId: string,
    input: {
      expectedVersion?: number | undefined;
      isPinned?: boolean | undefined;
      bufferMinutes?: number | undefined;
    },
    now = new Date(),
  ): Promise<Tour> {
    void actorId;
    if (
      input.bufferMinutes !== undefined &&
      (!Number.isInteger(input.bufferMinutes) ||
        input.bufferMinutes < TOUR_STOP_BUFFER_MINUTES_MIN ||
        input.bufferMinutes > TOUR_STOP_BUFFER_MINUTES_MAX)
    ) {
      throw new AuthError(
        'VALIDATION',
        `Der Puffer muss zwischen ${TOUR_STOP_BUFFER_MINUTES_MIN} und ${TOUR_STOP_BUFFER_MINUTES_MAX} Minuten liegen.`,
      );
    }
    return this.db.transaction(async (tx) => {
      const tour = await this.lockTour(tx, tourId);
      this.assertEditable(tour);
      this.assertVersion(tour, input.expectedVersion);
      const entry = await this.stopOfTour(tx, tourId, stopId);
      const changes: Partial<typeof tourStops.$inferInsert> = {};
      if (input.isPinned !== undefined && input.isPinned !== entry.stop.isPinned) {
        changes.isPinned = input.isPinned;
      }
      if (input.bufferMinutes !== undefined && input.bufferMinutes !== entry.stop.bufferMinutes) {
        changes.bufferMinutes = input.bufferMinutes;
      }
      if (Object.keys(changes).length === 0) return tour;
      await tx
        .update(tourStops)
        .set({ ...changes, updatedAt: now })
        .where(eq(tourStops.id, stopId));
      return this.bumpWithin(tx, tour, now, { invalidatePlan: true });
    });
  }

  // ── Lebenszyklus (Order §§31–33, §§59–61) ────────────────────────────────

  async markReady(
    actorId: string,
    tourId: string,
    input: { expectedVersion?: number | undefined } = {},
    now = new Date(),
  ): Promise<Tour> {
    void actorId;
    return this.db.transaction(async (tx) => {
      const tour = await this.lockTour(tx, tourId);
      if (tour.status === 'ready') return tour;
      if (tour.status !== 'draft') {
        throw new TourError(
          'CONFLICT',
          'TOUR_NOT_DRAFT',
          'Nur Entwürfe können als bereit markiert werden.',
        );
      }
      this.assertVersion(tour, input.expectedVersion);
      await this.healWithin(tx, tour, now);
      const stops = await this.loadStops(tx, tourId);
      if (!stops.some((entry) => entry.state === 'open' || entry.state === 'arrived')) {
        throw new TourError('CONFLICT', 'TOUR_EMPTY', 'Die Tour enthält keine offenen Stopps.');
      }
      const fresh = await this.lockTour(tx, tourId);
      return this.bumpWithin(tx, fresh, now, { invalidatePlan: false, set: { status: 'ready' } });
    });
  }

  /**
   * Bewusster Start (Order §31/§32): Tourdatum = heute (Berlin), ≥ 1 offener
   * Stopp, Fahrer aktiv, keine zweite aktive Tour derselben effektiven Person
   * (Advisory-Lock je effektivem Fahrer + DB-Unique je gespeichertem Fahrer).
   * Idempotent: bereits aktiv ⇒ `started: false`.
   */
  async start(
    actorId: string,
    tourId: string,
    input: { expectedVersion?: number | undefined } = {},
    now = new Date(),
  ): Promise<{ started: boolean; tour: Tour }> {
    return this.db.transaction(async (tx) => {
      const tour = await this.lockTour(tx, tourId);
      if (tour.status === 'active') return { started: false, tour };
      if (tour.status !== 'draft' && tour.status !== 'ready') {
        throw new TourError(
          'CONFLICT',
          'TOUR_NOT_STARTABLE',
          'Nur Entwürfe oder bereite Touren können gestartet werden.',
        );
      }
      this.assertVersion(tour, input.expectedVersion);
      if (tour.tourDate !== berlinDateOf(now)) {
        throw new TourError(
          'CONFLICT',
          'TOUR_NOT_TODAY',
          'Eine Tour kann nur an ihrem Tourdatum gestartet werden.',
        );
      }
      await this.healWithin(tx, tour, now);
      const stops = await this.loadStops(tx, tourId);
      if (!stops.some((entry) => entry.state === 'open' || entry.state === 'arrived')) {
        throw new TourError('CONFLICT', 'TOUR_EMPTY', 'Die Tour enthält keine offenen Stopps.');
      }
      await this.assertActiveStaff(tx, tour.assignedUserId);
      const substitutions = await loadSubstitutions(tx);
      const effectiveDriver =
        this.effectiveDriverId(tour, substitutions, now) ?? tour.assignedUserId;
      await this.assertNoOtherActiveTour(tx, tour.id, tour.assignedUserId, effectiveDriver, now);
      const fresh = await this.lockTour(tx, tourId);
      try {
        const updated = await this.bumpWithin(tx, fresh, now, {
          invalidatePlan: false,
          set: { status: 'active', startedAt: now, startedBy: actorId },
        });
        return { started: true, tour: updated };
      } catch (error) {
        if (isUniqueViolation(error)) throw driverAlreadyActive();
        throw error;
      }
    });
  }

  private async assertNoOtherActiveTour(
    tx: DatabaseTransaction,
    tourId: string,
    storedDriverId: string,
    effectiveDriverId: string,
    now: Date,
  ): Promise<void> {
    // Serialisiert parallele Starts/Übernahmen derselben effektiven Person.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'tour-active-driver:' + effectiveDriverId}))`,
    );
    const active = await tx.select().from(tours).where(eq(tours.status, 'active'));
    const substitutions = await loadSubstitutions(tx);
    for (const other of active) {
      if (other.id === tourId) continue;
      const otherEffective = this.effectiveDriverId(other, substitutions, now);
      if (
        other.assignedUserId === storedDriverId ||
        other.assignedUserId === effectiveDriverId ||
        otherEffective === effectiveDriverId
      ) {
        throw driverAlreadyActive();
      }
    }
  }

  /**
   * Bewusstes Ende (Order §59/§60): alle Stopps erledigt/übersprungen ⇒
   * completed; offene Stopps ⇒ 409 TOUR_HAS_OPEN_STOPS; `force` nur mit
   * `canForce` (calendar.manage) und Pflichtgrund – Termine bleiben scheduled.
   * Idempotent: bereits beendet ⇒ `ended: false`.
   */
  async end(
    actorId: string,
    tourId: string,
    input: { force?: boolean | undefined; reason?: string | null; canForce: boolean },
    now = new Date(),
  ): Promise<{ ended: boolean; tour: Tour }> {
    return this.db.transaction(async (tx) => {
      const tour = await this.lockTour(tx, tourId);
      if (tour.status === 'completed') return { ended: false, tour };
      if (tour.status !== 'active') {
        throw new TourError(
          'CONFLICT',
          'TOUR_NOT_ACTIVE',
          'Nur aktive Touren können beendet werden (Entwürfe: abbrechen).',
        );
      }
      await this.healWithin(tx, tour, now);
      const stops = await this.loadStops(tx, tourId);
      const open = stops.filter((entry) => entry.state === 'open' || entry.state === 'arrived');
      let endReason: string | null = null;
      if (open.length > 0) {
        if (input.force !== true) {
          throw new TourError('CONFLICT', 'TOUR_HAS_OPEN_STOPS', TOUR_MESSAGES.OPEN_STOPS, {
            openStopIds: open.map((entry) => entry.stop.id),
          });
        }
        if (!input.canForce) {
          throw new AuthError(
            'FORBIDDEN',
            'Nur die Planung darf eine Tour mit offenen Stopps beenden.',
          );
        }
        const reason = (input.reason ?? '').trim();
        if (reason.length < END_REASON_MIN || reason.length > END_REASON_MAX) {
          throw new AuthError(
            'VALIDATION',
            `Bitte einen Grund mit ${END_REASON_MIN}–${END_REASON_MAX} Zeichen angeben.`,
          );
        }
        endReason = reason;
      }
      const fresh = await this.lockTour(tx, tourId);
      const updated = await this.bumpWithin(tx, fresh, now, {
        invalidatePlan: false,
        set: { status: 'completed', endedAt: now, endedBy: actorId, endReason },
      });
      await this.releaseWithin(tx, tourId, now);
      return { ended: true, tour: updated };
    });
  }

  /** Abbruch (Order §61): nur draft/ready; kein Hard Delete. */
  async cancel(
    actorId: string,
    tourId: string,
    now = new Date(),
  ): Promise<{ cancelled: boolean; tour: Tour }> {
    return this.db.transaction(async (tx) => {
      const tour = await this.lockTour(tx, tourId);
      if (tour.status === 'cancelled') return { cancelled: false, tour };
      if (tour.status === 'active') {
        throw new TourError(
          'CONFLICT',
          'TOUR_ACTIVE',
          'Aktive Touren werden über „Tour beenden“ abgeschlossen.',
        );
      }
      if (tour.status === 'completed') {
        throw new TourError('CONFLICT', 'TOUR_COMPLETED', 'Die Tour ist bereits beendet.');
      }
      const updated = await this.bumpWithin(tx, tour, now, {
        invalidatePlan: false,
        set: { status: 'cancelled', cancelledAt: now, cancelledBy: actorId },
      });
      await this.releaseWithin(tx, tourId, now);
      return { cancelled: true, tour: updated };
    });
  }

  /** Stopps freigeben (DB-Backstop), Live-Standort löschen, offene Incidents lösen. */
  private async releaseWithin(tx: DatabaseTransaction, tourId: string, now: Date): Promise<void> {
    await tx
      .update(tourStops)
      .set({ releasedAt: now, updatedAt: now })
      .where(and(eq(tourStops.tourId, tourId), isNull(tourStops.releasedAt)));
    await this.clearLiveLocation(tx, tourId);
    await tx
      .update(tourDelayIncidents)
      .set({ resolvedAt: now, lastEvaluatedAt: now })
      .where(and(eq(tourDelayIncidents.tourId, tourId), isNull(tourDelayIncidents.resolvedAt)));
  }

  /** Haken für Tourende/Abbruch/Übernahme (Design §9): genau eine Zeile je Tour wird gelöscht. */
  async clearLiveLocation(tx: DatabaseExecutor, tourId: string): Promise<void> {
    await tx.delete(tourLiveLocations).where(eq(tourLiveLocations.tourId, tourId));
  }

  /**
   * Übernahme (Order §29): EINE Transaktion – Tourfahrer wechseln und alle
   * offenen Stopp-Termine über die bestehende Zuweisungslogik umstellen;
   * ein Fehler rollt alles zurück. Erledigte Stopps bleiben unverändert.
   */
  async takeover(
    actorId: string,
    tourId: string,
    input: { expectedVersion?: number | undefined },
    effective: ReadonlySet<PermissionKey>,
    now = new Date(),
  ): Promise<Tour> {
    return this.db.transaction(async (tx) => {
      const tour = await this.lockTour(tx, tourId);
      if (tour.status !== 'active') {
        throw new TourError(
          'CONFLICT',
          'TOUR_NOT_ACTIVE',
          'Nur aktive Touren können übernommen werden.',
        );
      }
      this.assertVersion(tour, input.expectedVersion);
      await this.assertActiveStaff(tx, actorId);
      const substitutions = await loadSubstitutions(tx);
      const currentEffective = this.effectiveDriverId(tour, substitutions, now);
      if (tour.assignedUserId === actorId || currentEffective === actorId) {
        throw new TourError(
          'CONFLICT',
          'TOUR_ALREADY_DRIVER',
          'Du bist bereits für diese Tour zuständig.',
        );
      }
      await this.assertNoOtherActiveTour(tx, tour.id, actorId, actorId, now);
      await this.healWithin(tx, tour, now);
      const stops = await this.loadStops(tx, tourId);
      for (const entry of stops) {
        if (entry.state !== 'open' && entry.state !== 'arrived') continue;
        await this.scheduling.assignWithin(
          tx,
          actorId,
          entry.appointment.id,
          { userId: actorId, expectedVersion: entry.appointment.version },
          effective,
          now,
        );
      }
      const fresh = await this.lockTour(tx, tourId);
      try {
        const updated = await this.bumpWithin(tx, fresh, now, {
          invalidatePlan: false,
          set: { assignedUserId: actorId },
        });
        await this.clearLiveLocation(tx, tourId);
        return updated;
      } catch (error) {
        if (isUniqueViolation(error)) throw driverAlreadyActive();
        throw error;
      }
    });
  }

  /** „Angekommen“ (Order §35): setzt nur arrived_at – keine Fachmutation. */
  async markArrived(
    actorId: string,
    tourId: string,
    stopId: string,
    now = new Date(),
  ): Promise<Tour> {
    void actorId;
    return this.db.transaction(async (tx) => {
      const tour = await this.lockTour(tx, tourId);
      // Erst der Stopp (fremde Stopp-IDs ⇒ neutral 404), dann der Tourstatus.
      const entry = await this.stopOfTour(tx, tourId, stopId);
      if (tour.status !== 'active') {
        throw new TourError(
          'CONFLICT',
          'TOUR_NOT_ACTIVE',
          '„Angekommen“ ist nur in einer aktiven Tour möglich.',
        );
      }
      if (entry.state === 'arrived') return tour;
      if (entry.state !== 'open') {
        throw new TourError(
          'CONFLICT',
          'TOUR_STOP_CLOSED',
          'Dieser Stopp ist bereits erledigt oder übersprungen.',
        );
      }
      await tx
        .update(tourStops)
        .set({ arrivedAt: now, updatedAt: now })
        .where(eq(tourStops.id, stopId));
      return this.bumpWithin(tx, tour, now, { invalidatePlan: false });
    });
  }

  /** Termin-IDs, die aktuell in offenen Touren stecken (Kalender-Badge/Kandidaten). */
  async plannedAppointmentIds(): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ appointmentId: tourStops.appointmentId, tourId: tourStops.tourId })
      .from(tourStops)
      .where(isNull(tourStops.releasedAt));
    return new Map(rows.map((row) => [row.appointmentId, row.tourId]));
  }
}

function driverAlreadyActive(): TourError {
  return new TourError(
    'CONFLICT',
    'TOUR_DRIVER_ALREADY_ACTIVE',
    'Für diese Person läuft bereits eine aktive Tour.',
  );
}
