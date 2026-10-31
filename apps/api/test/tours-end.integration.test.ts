/**
 * Phase-13-Pflichttests 117–124: Tour beenden – alle erledigt ⇒ normal,
 * offene ⇒ 409, Planer-Abschluss mit Grund, Termine bleiben scheduled,
 * Stopps werden frei, kein Hard Delete, GPS gelöscht, idempotent.
 * Zusätzlich (ohne Pflichtnummer): bewusster Start, Doppelstart, keine
 * zweite aktive Tour derselben effektiven Person, nur am Tourdatum.
 */
import { tourLiveLocations, tourStops, tours } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

async function activeTour() {
  const { admin, cookie } = await adminSession(world);
  const api = apiFor(world.app, cookie);
  const driver = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Fahrer');
  const driverApi = apiFor(world.app, driver.cookie);
  const today = todayBerlin();
  const first = await bookingWithAppointments(world, admin.id, {
    assignTo: driver.user.id,
    outboundStartAt: berlinAt(today, 23, 0),
    street: 'Ahornweg 1',
  });
  const second = await bookingWithAppointments(world, admin.id, {
    assignTo: driver.user.id,
    outboundStartAt: berlinAt(today, 23, 20),
    street: 'Birkenstraße 2',
  });
  const tour = await tourWithStops(api, {
    tourDate: today,
    assignedUserId: driver.user.id,
    appointmentIds: [first.outbound.id, second.outbound.id],
  });
  const started = await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
  expect(started.status).toBe(200);
  expect(started.body.started).toBe(true);
  await world.ctx.db.insert(tourLiveLocations).values({
    tourId: tour.id,
    userId: driver.user.id,
    latitude: 49.95,
    longitude: 8.27,
    observedAt: new Date(),
  });
  return { admin, api, driver: driver.user, driverApi, today, tour, first, second };
}

describe('117.–124. Tour beenden', () => {
  it('T117./T123./T124. Alle Stopps erledigt ⇒ normales Ende; Live-Standort gelöscht; erneutes Ende idempotent', async () => {
    const { driverApi, driver, tour, first, second } = await activeTour();
    await completeAppointment(world, driver.id, first.outbound.id);
    await completeAppointment(world, driver.id, second.outbound.id);
    const ended = await driverApi('POST', `/staff/tours/${tour.id}/end`, {});
    expect(ended.status).toBe(200);
    expect(ended.body.ended).toBe(true);
    expect(ended.body.tour.status).toBe('completed');
    expect(ended.body.tour.endedAt).not.toBeNull();
    expect(ended.body.tour.endReason).toBeNull();
    expect(ended.body.tour.stops.every((s: { state: string }) => s.state === 'done')).toBe(true);
    const row = (await world.ctx.db.select().from(tours).where(eq(tours.id, tour.id)))[0]!;
    expect(row.endedBy).toBe(driver.id);
    // T123: GPS weg.
    const live = await world.ctx.db
      .select()
      .from(tourLiveLocations)
      .where(eq(tourLiveLocations.tourId, tour.id));
    expect(live).toHaveLength(0);
    expect(ended.body.tour.liveLocation).toBeNull();
    // T124: idempotent.
    const again = await driverApi('POST', `/staff/tours/${tour.id}/end`, {});
    expect(again.status).toBe(200);
    expect(again.body.ended).toBe(false);
    expect(again.body.tour.status).toBe('completed');
    expect(again.body.tour.endedAt).toBe(ended.body.tour.endedAt);
    // Aktive Tour des Fahrers gibt es nicht mehr.
    expect((await driverApi('GET', '/staff/tours/active')).body.tour).toBeNull();
  });

  it('T118. Offene Stopps ⇒ 409 „Die Tour enthält noch offene Stopps.“ – Tour bleibt aktiv', async () => {
    const { driverApi, driver, tour, first } = await activeTour();
    await completeAppointment(world, driver.id, first.outbound.id);
    const ended = await driverApi('POST', `/staff/tours/${tour.id}/end`, {});
    expect(ended.status).toBe(409);
    expect(ended.body.error.code).toBe('TOUR_HAS_OPEN_STOPS');
    expect(ended.body.error.message).toBe('Die Tour enthält noch offene Stopps.');
    expect(ended.body.error.details.openStopIds).toEqual([tour.stops[1].id]);
    const view = await driverApi('GET', `/staff/tours/${tour.id}`);
    expect(view.body.tour.status).toBe('active');
  });

  it('T119./T120. Planer beendet trotzdem – nur calendar.manage, nur mit Grund; offene Termine bleiben scheduled', async () => {
    const { api, driverApi, tour, first, second } = await activeTour();
    const driverForce = await driverApi('POST', `/staff/tours/${tour.id}/end`, {
      force: true,
      reason: 'Fahrzeug defekt',
    });
    expect(driverForce.status).toBe(403);
    const noReason = await api('POST', `/staff/tours/${tour.id}/end`, { force: true });
    expect(noReason.status).toBe(400);
    const shortReason = await api('POST', `/staff/tours/${tour.id}/end`, {
      force: true,
      reason: 'ab',
    });
    expect(shortReason.status).toBe(400);
    expect((await getTour(api, tour.id)).status).toBe('active');

    const forced = await api('POST', `/staff/tours/${tour.id}/end`, {
      force: true,
      reason: 'Fahrzeug defekt – Rest morgen',
    });
    expect(forced.status).toBe(200);
    expect(forced.body.ended).toBe(true);
    expect(forced.body.tour.status).toBe('completed');
    expect(forced.body.tour.endReason).toBe('Fahrzeug defekt – Rest morgen');
    // T120: Termine nicht abgeschlossen, Version unverändert.
    for (const booking of [first, second]) {
      const after = (await appointmentRow(world, booking.outbound.id))!;
      expect(after.status).toBe('scheduled');
      expect(after.completedAt).toBeNull();
      expect(after.version).toBe(booking.outbound.version);
    }
    expect(forced.body.tour.stops.every((s: { state: string }) => s.state === 'open')).toBe(true);
  });

  it('T121./T122. Beendete Tour gibt Stopps frei (neu aufnehmbar) und bleibt als Historie erhalten', async () => {
    const { api, driver, today, tour, first } = await activeTour();
    const forced = await api('POST', `/staff/tours/${tour.id}/end`, {
      force: true,
      reason: 'Abbruch wegen Unwetter',
    });
    expect(forced.status).toBe(200);
    const stopRows = await world.ctx.db
      .select()
      .from(tourStops)
      .where(eq(tourStops.tourId, tour.id));
    expect(stopRows).toHaveLength(2);
    expect(stopRows.every((row) => row.releasedAt !== null)).toBe(true);
    // Termin in neuer Tour desselben Tags wieder aufnehmbar.
    const next = await createTour(api, { tourDate: today, assignedUserId: driver.id });
    const added = await addStop(api, next.id, first.outbound.id);
    expect(added.status).toBe(200);
    // T122: kein Hard Delete – alte Tour samt Stopps lesbar, keine Löschroute.
    const old = await getTour(api, tour.id);
    expect(old.status).toBe('completed');
    expect(old.stops).toHaveLength(2);
    expect(old.canEdit).toBe(false);
    expect((await api('DELETE', `/staff/tours/${tour.id}`)).status).toBe(404);
    // Beendete Touren sind nicht mehr bearbeitbar; Abbruch nur im Entwurf.
    expect((await api('POST', `/staff/tours/${tour.id}/cancel`, {})).status).toBe(409);
    expect((await addStop(api, tour.id, first.inbound.id)).status).toBe(409);
    const cancelledDraft = await api('POST', `/staff/tours/${next.id}/cancel`, {});
    expect(cancelledDraft.body.tour.status).toBe('cancelled');
    expect((await world.ctx.db.select().from(tours).where(eq(tours.id, next.id)))[0]).toBeDefined();
  });

  it('Aktive Tour kann nicht abgebrochen werden (nur beenden); Entwurf nicht beendet werden', async () => {
    const { api, driver, tour } = await activeTour();
    const cancel = await api('POST', `/staff/tours/${tour.id}/cancel`, {});
    expect(cancel.status).toBe(409);
    expect(cancel.body.error.code).toBe('TOUR_ACTIVE');
    const draft = await createTour(api, { tourDate: dateInDays(1), assignedUserId: driver.id });
    const end = await api('POST', `/staff/tours/${draft.id}/end`, {});
    expect(end.status).toBe(409);
    expect(end.body.error.code).toBe('TOUR_NOT_ACTIVE');
  });
});

describe('Start (Grundlage für 59–61)', () => {
  it('Start nur bewusst und nur am Tourdatum; Doppelklick ⇒ genau ein Start; keine zweite aktive Tour derselben Person', async () => {
    const { admin, cookie } = await adminSession(world);
    const api = apiFor(world.app, cookie);
    const driver = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Fahrer');
    const driverApi = apiFor(world.app, driver.cookie);
    const today = todayBerlin();
    const tomorrow = dateInDays(1);
    const todayBooking = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.user.id,
      outboundStartAt: berlinAt(today, 23, 0),
    });
    const laterBooking = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.user.id,
      outboundStartAt: berlinAt(tomorrow, 10, 0),
      street: 'Birkenstraße 2',
    });
    const empty = await createTour(api, { tourDate: today, assignedUserId: driver.user.id });
    const emptyStart = await driverApi('POST', `/staff/tours/${empty.id}/start`, {});
    expect(emptyStart.status).toBe(409);
    expect(emptyStart.body.error.code).toBe('TOUR_EMPTY');

    const future = await tourWithStops(api, {
      tourDate: tomorrow,
      assignedUserId: driver.user.id,
      appointmentIds: [laterBooking.outbound.id],
    });
    const notToday = await driverApi('POST', `/staff/tours/${future.id}/start`, {});
    expect(notToday.status).toBe(409);
    expect(notToday.body.error.code).toBe('TOUR_NOT_TODAY');

    const tour = await tourWithStops(api, {
      tourDate: today,
      assignedUserId: driver.user.id,
      appointmentIds: [todayBooking.outbound.id],
    });
    expect((await getTour(api, tour.id)).startedAt).toBeNull();
    const [a, b] = await Promise.all([
      driverApi('POST', `/staff/tours/${tour.id}/start`, {}),
      driverApi('POST', `/staff/tours/${tour.id}/start`, {}),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.started, b.body.started].sort()).toEqual([false, true]);
    const row = (await world.ctx.db.select().from(tours).where(eq(tours.id, tour.id)))[0]!;
    expect(row.status).toBe('active');
    expect(row.startedBy).toBe(driver.user.id);
    const again = await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
    expect(again.body.started).toBe(false);
    expect(again.body.tour.startedAt).toBe(a.body.tour.startedAt);

    // Zweite Tour desselben Fahrers heute ⇒ 409.
    const second = await tourWithStops(api, {
      tourDate: today,
      assignedUserId: driver.user.id,
      appointmentIds: [todayBooking.inbound.id],
    });
    // Rückgabetermin ohne Zeit ist erlaubt (ungeplant) – Start scheitert an der aktiven Tour.
    const conflict = await driverApi('POST', `/staff/tours/${second.id}/start`, {});
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('TOUR_DRIVER_ALREADY_ACTIVE');
  });
});
