/**
 * Phase-13-Pflichttests 48–58: Zuständigkeit beim Hinzufügen (zuweisen,
 * gleiche Person, fremde Person nicht still, Same-Day-Recht, Acknowledge),
 * atomare Übernahme (alle offenen wechseln, erledigte historisch, Rollback)
 * und Vertretung (effektive Zuständigkeit, Vertretungsende).
 */
import { tourLiveLocations, tours } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { substitutionServiceFor } from './scheduling-helpers.ts';
import {
  DRIVER_PERMISSIONS,
  addStop,
  adminSession,
  apiFor,
  appointmentRow,
  berlinAt,
  bookingWithAppointments,
  completeAppointment,
  createTour,
  createToursWorld,
  dateInDays,
  destroyToursWorld,
  getTour,
  resetToursWorld,
  staffWith,
  todayBerlin,
  tourWithStops,
  type ToursWorld,
} from './tours-helpers.ts';

let world: ToursWorld;

beforeAll(async () => {
  world = await createToursWorld();
});
afterAll(async () => {
  await destroyToursWorld(world);
});
beforeEach(async () => {
  await resetToursWorld(world);
});

const DAY = () => dateInDays(3);

async function setup() {
  const { admin, cookie } = await adminSession(world);
  const api = apiFor(world.app, cookie);
  const driver = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Fahrer');
  return { admin, api, driver: driver.user, driverApi: apiFor(world.app, driver.cookie) };
}

describe('48.–52. Zuständigkeit beim Hinzufügen', () => {
  it('T48. Offener (unzugewiesener) Termin wird über die bestehende Zuweisung dem Tourfahrer zugewiesen – nur mit appointment.assign', async () => {
    const { admin, api, driver } = await setup();
    const booking = await bookingWithAppointments(world, admin.id, {
      outboundStartAt: berlinAt(DAY(), 10, 0),
    });
    expect(booking.outbound.assignedUserId).toBeNull();
    const tour = await createTour(api, { tourDate: DAY(), assignedUserId: driver.id });

    const planner = await staffWith(
      world,
      admin.id,
      ['calendar.view', 'calendar.manage'],
      'Planer',
    );
    const forbidden = await addStop(
      apiFor(world.app, planner.cookie),
      tour.id,
      booking.outbound.id,
    );
    expect(forbidden.status).toBe(403);
    expect((await appointmentRow(world, booking.outbound.id))!.assignedUserId).toBeNull();
    expect((await getTour(api, tour.id)).stops).toHaveLength(0);

    const result = await addStop(api, tour.id, booking.outbound.id);
    expect(result.status).toBe(200);
    const after = (await appointmentRow(world, booking.outbound.id))!;
    expect(after.assignedUserId).toBe(driver.id);
    expect(after.version).toBe(booking.outbound.version + 1);
    expect(result.body.tour.stops[0].appointment.assignedUserId).toBe(driver.id);
  });

  it('T49. Gleiche (effektive) Zuständigkeit ⇒ Termin bleibt unverändert', async () => {
    const { admin, api, driver } = await setup();
    const booking = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.id,
      outboundStartAt: berlinAt(DAY(), 10, 0),
    });
    const tour = await createTour(api, { tourDate: DAY(), assignedUserId: driver.id });
    const result = await addStop(api, tour.id, booking.outbound.id);
    expect(result.status).toBe(200);
    const after = (await appointmentRow(world, booking.outbound.id))!;
    expect(after.assignedUserId).toBe(driver.id);
    expect(after.version).toBe(booking.outbound.version);
    expect(after.acknowledgementRequestedAt).toBeNull();
  });

  it('T50. Fremde Zuständigkeit wird nie still überschrieben: 409 mit Hinweis, nur mit reassign: true', async () => {
    const { admin, api, driver } = await setup();
    const other = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Andere');
    const booking = await bookingWithAppointments(world, admin.id, {
      assignTo: other.user.id,
      outboundStartAt: berlinAt(DAY(), 10, 0),
    });
    const tour = await createTour(api, { tourDate: DAY(), assignedUserId: driver.id });
    const silent = await addStop(api, tour.id, booking.outbound.id);
    expect(silent.status).toBe(409);
    expect(silent.body.error.code).toBe('APPOINTMENT_ASSIGNED_ELSEWHERE');
    expect(silent.body.error.details.assignedUserId).toBe(other.user.id);
    expect(silent.body.error.details.assignedName).toContain('Andere');
    const untouched = (await appointmentRow(world, booking.outbound.id))!;
    expect(untouched.assignedUserId).toBe(other.user.id);
    expect(untouched.version).toBe(booking.outbound.version);
    expect((await getTour(api, tour.id)).stops).toHaveLength(0);

    const explicit = await addStop(api, tour.id, booking.outbound.id, { reassign: true });
    expect(explicit.status).toBe(200);
    const after = (await appointmentRow(world, booking.outbound.id))!;
    expect(after.assignedUserId).toBe(driver.id);
    // Zukünftiger Tag: keine Same-Day-Übernahmebestätigung nötig.
    expect(after.acknowledgementRequestedAt).toBeNull();
  });

  it('T51./T52. Same-Day-Wechsel braucht appointment.reassign_same_day; Übernahmebestätigung (Phase 4) bleibt korrekt', async () => {
    const { admin, api, driver, driverApi } = await setup();
    const other = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Andere');
    const today = todayBerlin();
    const booking = await bookingWithAppointments(world, admin.id, {
      assignTo: other.user.id,
      outboundStartAt: berlinAt(today, 23, 0),
    });
    const tour = await createTour(api, { tourDate: today, assignedUserId: driver.id });
    const planner = await staffWith(
      world,
      admin.id,
      ['calendar.view', 'calendar.manage', 'appointment.assign'],
      'Planer',
    );
    const noSameDay = await addStop(
      apiFor(world.app, planner.cookie),
      tour.id,
      booking.outbound.id,
      {
        reassign: true,
      },
    );
    expect(noSameDay.status).toBe(403);
    expect((await appointmentRow(world, booking.outbound.id))!.assignedUserId).toBe(other.user.id);
    expect((await getTour(api, tour.id)).stops).toHaveLength(0);

    const result = await addStop(api, tour.id, booking.outbound.id, { reassign: true });
    expect(result.status).toBe(200);
    const after = (await appointmentRow(world, booking.outbound.id))!;
    expect(after.assignedUserId).toBe(driver.id);
    expect(after.acknowledgementRequestedFor).toBe(driver.id);
    expect(after.acknowledgementRequestedAt).not.toBeNull();
    expect(after.acknowledgedAt).toBeNull();

    // T52: bestehender Acknowledge-Fluss des Fahrers funktioniert unverändert.
    const entry = await driverApi('GET', `/staff/appointments/${booking.outbound.id}`);
    expect(entry.status).toBe(200);
    expect(entry.body.entry.acknowledgementPending).toBe(true);
    const ack = await driverApi('POST', `/staff/appointments/${booking.outbound.id}/acknowledge`);
    expect(ack.status).toBe(200);
    expect((await appointmentRow(world, booking.outbound.id))!.acknowledgedBy).toBe(driver.id);
    const view = await getTour(api, tour.id);
    expect(view.stops[0].appointment.assignedUserId).toBe(driver.id);
  });
});

describe('53.–56. Tour übernehmen (atomar)', () => {
  async function activeTourWithThreeStops() {
    const { admin, api, driver, driverApi } = await setup();
    const today = todayBerlin();
    const done = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.id,
      outboundStartAt: berlinAt(today, 23, 0),
      street: 'Ahornweg 1',
    });
    const open1 = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.id,
      outboundStartAt: berlinAt(today, 23, 10),
      street: 'Birkenstraße 2',
    });
    const open2 = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.id,
      outboundStartAt: berlinAt(today, 23, 20),
      street: 'Cedernweg 3',
    });
    const tour = await tourWithStops(api, {
      tourDate: today,
      assignedUserId: driver.id,
      appointmentIds: [done.outbound.id, open1.outbound.id, open2.outbound.id],
    });
    const started = await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
    expect(started.status).toBe(200);
    expect(started.body.started).toBe(true);
    await completeAppointment(world, driver.id, done.outbound.id);
    await world.ctx.db.insert(tourLiveLocations).values({
      tourId: tour.id,
      userId: driver.id,
      latitude: 49.95,
      longitude: 8.27,
      observedAt: new Date(),
    });
    return { admin, api, driver, tour, done, open1, open2 };
  }

  it('T53./T54./T55. Übernahme wechselt Tourfahrer und ALLE offenen Stopp-Termine atomar; erledigte bleiben historisch', async () => {
    const { api, driver, tour, done, open1, open2 } = await activeTourWithThreeStops();
    const taker = await staffWith(
      world,
      (await world.ctx.pool.query(`SELECT id FROM staff_users ORDER BY created_at LIMIT 1`)).rows[0]
        .id,
      ['calendar.view', 'calendar.view_all', 'appointment.assign', 'appointment.reassign_same_day'],
      'Uebernehmer',
    );
    const takerApi = apiFor(world.app, taker.cookie);
    const before = await getTour(api, tour.id);
    const result = await takerApi('POST', `/staff/tours/${tour.id}/takeover`, {
      expectedVersion: before.version,
    });
    expect(result.status).toBe(200);
    expect(result.body.tour.assignedUserId).toBe(taker.user.id);
    expect(result.body.tour.status).toBe('active');
    expect(result.body.tour.version).toBe(before.version + 1);
    for (const open of [open1, open2]) {
      const after = (await appointmentRow(world, open.outbound.id))!;
      expect(after.assignedUserId).toBe(taker.user.id);
      // Same-Day-Regeln der Phase 4: Übernahmebestätigung + Push-Vorbereitung.
      expect(after.acknowledgementRequestedFor).toBe(taker.user.id);
      expect(after.assignmentNotifiedAt).toBeNull();
    }
    const doneAfter = (await appointmentRow(world, done.outbound.id))!;
    expect(doneAfter.assignedUserId).toBe(driver.id);
    expect(doneAfter.status).toBe('completed');
    expect(doneAfter.version).toBe(done.outbound.version + 1); // nur der Abschluss
    // Live-Standort des bisherigen Fahrers ist gelöscht.
    const live = await world.ctx.db
      .select()
      .from(tourLiveLocations)
      .where(eq(tourLiveLocations.tourId, tour.id));
    expect(live).toHaveLength(0);
    // Der neue Fahrer sieht die Tour als eigene aktive Tour; nochmalige Übernahme ⇒ 409.
    const active = await takerApi('GET', '/staff/tours/active');
    expect(active.body.tour.id).toBe(tour.id);
    const again = await takerApi('POST', `/staff/tours/${tour.id}/takeover`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('TOUR_ALREADY_DRIVER');
  });

  it('T56. Ein Fehler bei EINEM Stopp rollt die gesamte Übernahme zurück (keine halbe Übernahme)', async () => {
    const { admin, api, driver } = await setup();
    const today = todayBerlin();
    // Stopp 1 ohne Zeit (kein Same-Day-Recht nötig), Stopp 2 heute (Same-Day-Recht nötig).
    const unplanned = await bookingWithAppointments(world, admin.id, { assignTo: driver.id });
    const sameDay = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.id,
      outboundStartAt: berlinAt(today, 23, 30),
      street: 'Birkenstraße 2',
    });
    const tour = await tourWithStops(api, {
      tourDate: today,
      assignedUserId: driver.id,
      appointmentIds: [unplanned.outbound.id, sameDay.outbound.id],
    });
    const started = await api('POST', `/staff/tours/${tour.id}/start`, {});
    expect(started.body.started).toBe(true);
    const taker = await staffWith(
      world,
      admin.id,
      ['calendar.view', 'calendar.view_all', 'appointment.assign'],
      'Uebernehmer',
    );
    const before = await getTour(api, tour.id);
    const result = await apiFor(world.app, taker.cookie)(
      'POST',
      `/staff/tours/${tour.id}/takeover`,
      {
        expectedVersion: before.version,
      },
    );
    expect(result.status).toBe(403);
    // Rollback: auch der erste (eigentlich erfolgreiche) Wechsel ist nicht gespeichert.
    expect((await appointmentRow(world, unplanned.outbound.id))!.assignedUserId).toBe(driver.id);
    expect((await appointmentRow(world, unplanned.outbound.id))!.version).toBe(
      unplanned.outbound.version,
    );
    expect((await appointmentRow(world, sameDay.outbound.id))!.assignedUserId).toBe(driver.id);
    const row = (await world.ctx.db.select().from(tours).where(eq(tours.id, tour.id)))[0]!;
    expect(row.assignedUserId).toBe(driver.id);
    expect(row.version).toBe(before.version);
  });
});

describe('57./58. Vertretung', () => {
  it('T57. Aktive Vertretung ist effektiver Tourfahrer: sieht die Tour, darf starten; gespeicherter Fahrer bleibt', async () => {
    const { admin, api, driver } = await setup();
    const substitute = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Vertretung');
    const subApi = apiFor(world.app, substitute.cookie);
    const substitution = await substitutionServiceFor(world.ctx).create(admin.id, {
      originalUserId: driver.id,
      substituteUserId: substitute.user.id,
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: new Date(Date.now() + 24 * 3_600_000),
    });
    const today = todayBerlin();
    const booking = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.id,
      outboundStartAt: berlinAt(today, 23, 0),
    });
    const tour = await tourWithStops(api, {
      tourDate: today,
      assignedUserId: driver.id,
      appointmentIds: [booking.outbound.id],
    });
    const view = await subApi('GET', `/staff/tours/${tour.id}`);
    expect(view.status).toBe(200);
    expect(view.body.tour.assignedUserId).toBe(driver.id);
    expect(view.body.tour.effectiveDriverId).toBe(substitute.user.id);
    expect(view.body.tour.substituted).toBe(true);
    expect(view.body.tour.canStart).toBe(true);
    const list = await subApi('GET', `/staff/tours?date=${today}`);
    expect(list.body.scope).toBe('mine');
    expect(list.body.tours.map((t: { id: string }) => t.id)).toEqual([tour.id]);

    const started = await subApi('POST', `/staff/tours/${tour.id}/start`, {});
    expect(started.status).toBe(200);
    expect(started.body.started).toBe(true);
    expect(started.body.tour.assignedUserId).toBe(driver.id);
    const active = await subApi('GET', '/staff/tours/active');
    expect(active.body.tour.id).toBe(tour.id);

    // T58: Vertretungsende ⇒ Zuständigkeit fällt zurück, Vertretung sieht die Tour nicht mehr.
    await substitutionServiceFor(world.ctx).endEarly(substitution.id);
    const gone = await subApi('GET', `/staff/tours/${tour.id}`);
    expect(gone.status).toBe(404);
    const own = await getTour(api, tour.id);
    expect(own.effectiveDriverId).toBe(driver.id);
    expect(own.substituted).toBe(false);
    const noneActive = await subApi('GET', '/staff/tours/active');
    expect(noneActive.body.tour).toBeNull();
  });

  it('T58. Nach Vertretungsende ist der gespeicherte Fahrer wieder effektiv zuständig', async () => {
    const { admin, api, driver, driverApi } = await setup();
    const substitute = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Vertretung');
    // Vertretung deckt das (zukünftige) Tourdatum ab.
    const substitution = await substitutionServiceFor(world.ctx).create(admin.id, {
      originalUserId: driver.id,
      substituteUserId: substitute.user.id,
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: new Date(Date.now() + 6 * 86_400_000),
    });
    const tour = await createTour(api, { tourDate: DAY(), assignedUserId: driver.id });
    expect((await getTour(api, tour.id)).effectiveDriverId).toBe(substitute.user.id);
    // Während der Vertretung sieht der Original-Fahrer seine Tour weiterhin (gespeicherter Fahrer).
    expect((await driverApi('GET', `/staff/tours/${tour.id}`)).status).toBe(200);
    await substitutionServiceFor(world.ctx).endEarly(substitution.id);
    const after = await getTour(api, tour.id);
    expect(after.effectiveDriverId).toBe(driver.id);
    expect(after.effectiveDriverName).toContain('Fahrer');
    expect(
      (await apiFor(world.app, substitute.cookie)('GET', `/staff/tours/${tour.id}`)).status,
    ).toBe(404);
  });
});
