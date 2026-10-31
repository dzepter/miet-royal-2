/**
 * Phase-13-Pflichttests 25–47: Tour anlegen, Datum (Berlin), Fahrer aktiv,
 * Stopps, Reihenfolge/Version/Races, Pin, Puffer, Vorschlag/Übernahme/
 * Verwerfen, Metriken, infeasible, keine Terminmutation, kein Lieferpreis,
 * Providerfehler ⇒ Tour manuell weiter.
 */
import { bookings, tourStops, tours } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { suggestDeliveryPrice } from '../src/tours/delivery-price-suggestion.ts';
import {
  DRIVER_PERMISSIONS,
  addStop,
  adminSession,
  apiFor,
  appointmentRow,
  berlinAt,
  bookingWithAppointments,
  createTour,
  createToursWorld,
  dateInDays,
  destroyToursWorld,
  getTour,
  resetToursWorld,
  staffWith,
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
  return { admin, api, driver: driver.user, driverCookie: driver.cookie };
}

describe('25.–29. Tour anlegen und Stopps', () => {
  it('T25. Tour anlegen ⇒ Entwurf mit Version 1, Fahrer und leerer Stoppliste', async () => {
    const { api, driver } = await setup();
    const tour = await createTour(api, { tourDate: DAY(), assignedUserId: driver.id });
    expect(tour.status).toBe('draft');
    expect(tour.version).toBe(1);
    expect(tour.tourDate).toBe(DAY());
    expect(tour.assignedUserId).toBe(driver.id);
    expect(tour.planningStatus).toBe('unplanned');
    expect(tour.stops).toEqual([]);
    expect(tour.canEdit).toBe(true);
    expect(tour.depot.status).toBe('ok');
  });

  it('T26. Tourdatum ist der Berliner Kalendertag des Termins (00:30 Berlin zählt zum Tourtag)', async () => {
    const { admin, api, driver } = await setup();
    const day = DAY();
    const booking = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.id,
      outboundStartAt: berlinAt(day, 0, 30),
    });
    // UTC-Datum des Termins ist der Vortag – die Tour des Vortags darf ihn NICHT aufnehmen.
    expect(booking.outbound.startAt!.toISOString().slice(0, 10)).toBe(dateInDays(2));
    const wrong = await createTour(api, { tourDate: dateInDays(2), assignedUserId: driver.id });
    const rejected = await addStop(api, wrong.id, booking.outbound.id);
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('APPOINTMENT_NOT_ON_TOUR_DATE');

    const right = await createTour(api, { tourDate: day, assignedUserId: driver.id });
    const accepted = await addStop(api, right.id, booking.outbound.id);
    expect(accepted.status).toBe(200);
    expect(accepted.body.tour.stops).toHaveLength(1);
  });

  it('T27. Fahrer muss aktiv sein', async () => {
    const { admin, api, driver } = await setup();
    await world.ctx.admin.setUserStatus(admin.id, driver.id, 'disabled');
    const result = await api('POST', '/staff/tours', {
      tourDate: DAY(),
      assignedUserId: driver.id,
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('TOUR_DRIVER_INACTIVE');
  });

  it('T28. Termin hinzufügen ⇒ Stopp mit abgeleitetem Zustand, Adresse und Navigation', async () => {
    const { admin, api, driver } = await setup();
    const booking = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.id,
      outboundStartAt: berlinAt(DAY(), 10, 0),
      outboundEndAt: berlinAt(DAY(), 12, 0),
    });
    const tour = await createTour(api, { tourDate: DAY(), assignedUserId: driver.id });
    const result = await addStop(api, tour.id, booking.outbound.id, { expectedVersion: 1 });
    expect(result.status).toBe(200);
    const view = result.body.tour;
    expect(view.version).toBe(2);
    const stop = view.stops[0];
    expect(stop.appointmentId).toBe(booking.outbound.id);
    expect(stop.sequence).toBe(1);
    expect(stop.state).toBe('open');
    expect(stop.isPinned).toBe(false);
    expect(stop.appointment.kind).toBe('delivery');
    expect(stop.appointment.processNumber).toMatch(/^MR-/);
    expect(stop.address.lines).toEqual(['Lieferweg 12', '55129 Mainz']);
    expect(stop.address.status).toBe('ok');
    expect(stop.travel).toBe('customer');
    expect(stop.deadlineAt).toBe(berlinAt(DAY(), 12, 0).toISOString());
    expect(stop.navigation.web).toContain('Lieferweg');
    expect(view.nextStop.id).toBe(stop.id);
  });

  it('T29. Derselbe Termin steckt nie in zwei offenen Touren (409 + DB-Backstop); nach Abbruch wieder frei', async () => {
    const { admin, api, driver } = await setup();
    const booking = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.id,
      outboundStartAt: berlinAt(DAY(), 10, 0),
    });
    const first = await tourWithStops(api, {
      tourDate: DAY(),
      assignedUserId: driver.id,
      appointmentIds: [booking.outbound.id],
    });
    const second = await createTour(api, { tourDate: DAY(), assignedUserId: driver.id });
    const rejected = await addStop(api, second.id, booking.outbound.id);
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('TOUR_STOP_ALREADY_PLANNED');
    expect(rejected.body.error.details.tourId).toBe(first.id);

    // DB-Backstop: direkter Insert scheitert am partiellen Unique-Index.
    await expect(
      world.ctx.db
        .insert(tourStops)
        .values({ tourId: second.id, appointmentId: booking.outbound.id, sequence: 1 }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });

    const cancelled = await api('POST', `/staff/tours/${first.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.tour.status).toBe('cancelled');
    const accepted = await addStop(api, second.id, booking.outbound.id);
    expect(accepted.status).toBe(200);
  });
});

describe('Kandidaten (verfügbare Stopps des Tourtags)', () => {
  it('liefert offene Termine des Tages mit Zuständigkeitshinweis, ohne bereits geplante und ohne Telefonnummer', async () => {
    const { admin, api, driver } = await setup();
    const other = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Andere');
    const own = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.id,
      outboundStartAt: berlinAt(DAY(), 9, 0),
    });
    const foreign = await bookingWithAppointments(world, admin.id, {
      assignTo: other.user.id,
      outboundStartAt: berlinAt(DAY(), 10, 0),
    });
    const unassigned = await bookingWithAppointments(world, admin.id, {
      outboundStartAt: berlinAt(DAY(), 11, 0),
    });
    const otherDay = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.id,
      outboundStartAt: berlinAt(dateInDays(4), 9, 0),
    });
    const tour = await tourWithStops(api, {
      tourDate: DAY(),
      assignedUserId: driver.id,
      appointmentIds: [own.outbound.id],
    });
    const result = await api('GET', `/staff/tours/${tour.id}/candidates`);
    expect(result.status).toBe(200);
    const byId = new Map(
      result.body.appointments.map((entry: { id: string }) => [entry.id, entry]),
    );
    expect(byId.has(own.outbound.id)).toBe(false); // bereits eingeplant
    expect(byId.has(otherDay.outbound.id)).toBe(false); // anderer Tag
    expect((byId.get(foreign.outbound.id) as { assignment: string }).assignment).toBe('other');
    expect((byId.get(unassigned.outbound.id) as { assignment: string }).assignment).toBe(
      'unassigned',
    );
    // Ungeplante Rückgabetermine (ohne Zeit) erscheinen ebenfalls – mit Hinweis.
    expect((byId.get(own.inbound.id) as { assignment: string }).assignment).toBe('tour_driver');
    for (const entry of result.body.appointments as Record<string, unknown>[]) {
      expect(entry).not.toHaveProperty('customerPhone');
      expect(entry.processNumber).toMatch(/^MR-/);
    }
    // Nur Planer dürfen die Kandidatenliste sehen.
    const driverView = await apiFor(
      world.app,
      (await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Nurfahrer')).cookie,
    )('GET', `/staff/tours/${tour.id}/candidates`);
    expect(driverView.status).toBe(403);
  });
});

describe('30.–34. Reihenfolge, Version, Pin, Puffer', () => {
  async function threeStops() {
    const { admin, api, driver } = await setup();
    const a = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.id,
      outboundStartAt: berlinAt(DAY(), 9, 0),
      outboundEndAt: berlinAt(DAY(), 11, 0),
      street: 'Ahornweg 1',
    });
    const b = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.id,
      outboundStartAt: berlinAt(DAY(), 10, 0),
      outboundEndAt: berlinAt(DAY(), 13, 0),
      street: 'Birkenstraße 2',
    });
    const c = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.id,
      outboundStartAt: berlinAt(DAY(), 12, 0),
      outboundEndAt: berlinAt(DAY(), 15, 0),
    });
    const tour = await tourWithStops(api, {
      tourDate: DAY(),
      assignedUserId: driver.id,
      appointmentIds: [a.outbound.id, b.outbound.id, c.outbound.id],
    });
    return { admin, api, driver, tour, a, b, c };
  }

  it('T30. Vollständige Reihenfolge setzen; unvollständige wird abgelehnt', async () => {
    const { api, tour } = await threeStops();
    const [s1, s2, s3] = tour.stops.map((stop: { id: string }) => stop.id);
    const incomplete = await api('POST', `/staff/tours/${tour.id}/stops/order`, {
      order: [s3, s1],
    });
    expect(incomplete.status).toBe(400);
    const result = await api('POST', `/staff/tours/${tour.id}/stops/order`, {
      expectedVersion: tour.version,
      order: [s3, s1, s2],
    });
    expect(result.status).toBe(200);
    expect(result.body.tour.stops.map((stop: { id: string }) => stop.id)).toEqual([s3, s1, s2]);
    expect(result.body.tour.stops.map((stop: { sequence: number }) => stop.sequence)).toEqual([
      1, 2, 3,
    ]);
  });

  it('T31. Drag&Drop mit expectedVersion: veraltete Version ⇒ 409 TOUR_VERSION_CONFLICT', async () => {
    const { api, tour } = await threeStops();
    const order = [...tour.stops.map((stop: { id: string }) => stop.id)].reverse();
    const stale = await api('POST', `/staff/tours/${tour.id}/stops/order`, {
      expectedVersion: tour.version - 1,
      order,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('TOUR_VERSION_CONFLICT');
    const fresh = await api('POST', `/staff/tours/${tour.id}/stops/order`, {
      expectedVersion: tour.version,
      order,
    });
    expect(fresh.status).toBe(200);
    expect(fresh.body.tour.version).toBe(tour.version + 1);
  });

  it('T32. Parallele Änderungen mit derselben Version: genau eine gewinnt, die andere 409', async () => {
    const { api, tour } = await threeStops();
    const ids = tour.stops.map((stop: { id: string }) => stop.id);
    const [first, second] = await Promise.all([
      api('POST', `/staff/tours/${tour.id}/stops/order`, {
        expectedVersion: tour.version,
        order: [ids[2], ids[1], ids[0]],
      }),
      api('POST', `/staff/tours/${tour.id}/stops/order`, {
        expectedVersion: tour.version,
        order: [ids[1], ids[0], ids[2]],
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const view = await getTour(api, tour.id);
    expect(view.version).toBe(tour.version + 1);
  });

  it('T33. Gepinnter Stopp behält seine Position – Vorschlag über Matrix + lokalen Planer', async () => {
    const { api, tour } = await threeStops();
    // Der FERNSTE Stopp (Lieferweg ist dem Depot am nächsten) wird an Position 1 gepinnt.
    const pinned = tour.stops[0]!;
    const patched = await api('PATCH', `/staff/tours/${tour.id}/stops/${pinned.id}`, {
      expectedVersion: tour.version,
      isPinned: true,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.tour.stops[0].isPinned).toBe(true);
    const proposal = await api('POST', `/staff/tours/${tour.id}/plan/propose`, {
      departureAt: berlinAt(DAY(), 8, 0).toISOString(),
    });
    expect(proposal.status).toBe(200);
    expect(proposal.body.status).toBe('ok');
    expect(proposal.body.plan.order[0]).toBe(pinned.id);
    expect(world.routing.calls.map((call) => call.method)).toContain('matrix');
    expect(world.routing.calls.map((call) => call.method)).not.toContain('optimizeTour');
    // Ohne Pin nutzt der Vorschlag die Provider-Optimierung.
    await api('PATCH', `/staff/tours/${tour.id}/stops/${pinned.id}`, { isPinned: false });
    world.routing.reset();
    const free = await api('POST', `/staff/tours/${tour.id}/plan/propose`, {
      departureAt: berlinAt(DAY(), 8, 0).toISOString(),
    });
    expect(free.status).toBe(200);
    expect(world.routing.calls.map((call) => call.method)).toContain('optimizeTour');
  });

  it('T34. Standardpuffer 15 Minuten; Planer darf 0–240 setzen, außerhalb ⇒ 400', async () => {
    const { api, tour } = await threeStops();
    const stop = tour.stops[0]!;
    expect((stop as { bufferMinutes?: number }).bufferMinutes).toBe(15);
    const ok = await api('PATCH', `/staff/tours/${tour.id}/stops/${stop.id}`, {
      bufferMinutes: 30,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.tour.stops[0].bufferMinutes).toBe(30);
    const tooHigh = await api('PATCH', `/staff/tours/${tour.id}/stops/${stop.id}`, {
      bufferMinutes: 300,
    });
    expect(tooHigh.status).toBe(400);
    const negative = await api('PATCH', `/staff/tours/${tour.id}/stops/${stop.id}`, {
      bufferMinutes: -1,
    });
    expect(negative.status).toBe(400);
    const rows = await world.ctx.db.select().from(tourStops).where(eq(tourStops.id, stop.id));
    expect(rows[0]?.bufferMinutes).toBe(30);
  });
});

describe('35.–47. Vorschlag, Übernahme, Metriken, infeasible, Providerfehler', () => {
  async function plannableTour() {
    const { admin, api, driver } = await setup();
    const exact = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.id,
      outboundStartAt: berlinAt(DAY(), 11, 0),
      street: 'Ahornweg 1',
    });
    // Hinweis: „Lieferweg 12, 55129 Mainz“ trifft im Mock die Depot-Regel (55129 Mainz) –
    // für Distanz-Aussagen daher eine eigene Straße mit anderer PLZ.
    const window = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.id,
      outboundStartAt: berlinAt(DAY(), 9, 0),
      outboundEndAt: berlinAt(DAY(), 15, 0),
      street: 'Birkenstraße 2',
    });
    const tour = await tourWithStops(api, {
      tourDate: DAY(),
      assignedUserId: driver.id,
      appointmentIds: [exact.outbound.id, window.outbound.id],
    });
    return { admin, api, driver, tour, exact, window };
  }

  const departure = () => berlinAt(DAY(), 8, 0).toISOString();

  it('T37./T39. Vorschlag berechnen überschreibt nichts – Verwerfen ist ein reiner Client-Schritt', async () => {
    const { api, tour } = await plannableTour();
    const proposal = await api('POST', `/staff/tours/${tour.id}/plan/propose`, {
      departureAt: departure(),
    });
    expect(proposal.status).toBe(200);
    expect(proposal.body.status).toBe('ok');
    expect(proposal.body.plan.order).toHaveLength(2);
    expect(proposal.body.plan.provider).toBe('fake');
    const after = await getTour(api, tour.id);
    expect(after.version).toBe(tour.version);
    expect(after.planningStatus).toBe('unplanned');
    expect(after.routeCalculatedAt).toBeNull();
    expect(after.stops.map((s: { id: string }) => s.id)).toEqual(
      tour.stops.map((s: { id: string }) => s.id),
    );
    for (const stop of after.stops) {
      expect(stop.plannedArrivalAt).toBeNull();
      expect(stop.legDistanceMeters).toBeNull();
    }
  });

  it('T38./T40.–T43. Übernehmen bewertet die Reihenfolge serverseitig neu und speichert Distanz, Fahrzeit, Abschnitte und interne Ankunftszeiten', async () => {
    const { api, tour } = await plannableTour();
    const proposal = await api('POST', `/staff/tours/${tour.id}/plan/propose`, {
      departureAt: departure(),
    });
    const order: string[] = proposal.body.plan.order;
    const applied = await api('POST', `/staff/tours/${tour.id}/plan/apply`, {
      expectedVersion: tour.version,
      order,
      departureAt: departure(),
    });
    expect(applied.status).toBe(200);
    const view = applied.body.tour;
    expect(view.planningStatus).toBe('planned');
    expect(view.version).toBe(tour.version + 1);
    expect(view.routeProvider).toBe('fake');
    expect(view.routeCalculatedAt).not.toBeNull();
    expect(view.stops.map((s: { id: string }) => s.id)).toEqual(order);
    // T40/T41: Gesamtdistanz und Fahrzeit (Hin- und Rückfahrt), T42: Abschnittswerte je Stopp.
    expect(view.plannedDistanceMeters).toBeGreaterThan(0);
    expect(view.plannedDurationSeconds).toBeGreaterThan(0);
    const legSum = view.stops.reduce(
      (sum: number, s: { legDistanceMeters: number }) => sum + s.legDistanceMeters,
      0,
    );
    expect(view.plannedDistanceMeters).toBe(legSum + applied.body.plan.returnLeg.distanceMeters);
    expect(view.plannedStartAt).toBe(departure());
    expect(view.plannedEndAt).toBe(applied.body.plan.plannedEndAt);
    for (const stop of view.stops) {
      expect(stop.legDistanceMeters).toBeGreaterThan(0);
      expect(stop.legDurationSeconds).toBeGreaterThan(0);
      // T43: ETA nur intern (Planungswert), keine Kundenangabe.
      expect(stop.plannedArrivalAt).not.toBeNull();
      expect(stop.plannedDepartureAt).not.toBeNull();
    }
    // Der Server hat die Zeiten für genau diese Reihenfolge erneut berechnet (Matrix-Call).
    expect(world.routing.calls.map((call) => call.method)).toContain('matrix');
    const row = (await world.ctx.db.select().from(tours).where(eq(tours.id, tour.id)))[0]!;
    expect(row.plannedDistanceMeters).toBe(view.plannedDistanceMeters);
    expect(row.planningStatus).toBe('planned');
  });

  it('T35./T36./T45. Exakter Termin und Zeitfenster bleiben unverändert – kein Auto-Reschedule', async () => {
    const { api, tour, exact, window } = await plannableTour();
    const proposal = await api('POST', `/staff/tours/${tour.id}/plan/propose`, {
      departureAt: departure(),
    });
    await api('POST', `/staff/tours/${tour.id}/plan/apply`, {
      expectedVersion: tour.version,
      order: proposal.body.plan.order,
      departureAt: departure(),
    });
    const exactAfter = (await appointmentRow(world, exact.outbound.id))!;
    expect(exactAfter.startAt?.toISOString()).toBe(exact.outbound.startAt?.toISOString());
    expect(exactAfter.endAt).toBeNull();
    expect(exactAfter.version).toBe(exact.outbound.version);
    const windowAfter = (await appointmentRow(world, window.outbound.id))!;
    expect(windowAfter.startAt?.toISOString()).toBe(window.outbound.startAt?.toISOString());
    expect(windowAfter.endAt?.toISOString()).toBe(window.outbound.endAt?.toISOString());
    expect(windowAfter.version).toBe(window.outbound.version);
  });

  it('T44./T45. Unmögliche Zeitvorgaben ⇒ infeasible mit verständlichem Konflikt, Termine unverändert', async () => {
    const { admin, api, driver } = await setup();
    // Beide exakt 10:00 an verschiedenen Adressen – der zweite ist nie rechtzeitig erreichbar.
    const first = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.id,
      outboundStartAt: berlinAt(DAY(), 10, 0),
      street: 'Ahornweg 1',
    });
    const second = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.id,
      outboundStartAt: berlinAt(DAY(), 10, 0),
    });
    const tour = await tourWithStops(api, {
      tourDate: DAY(),
      assignedUserId: driver.id,
      appointmentIds: [first.outbound.id, second.outbound.id],
    });
    const proposal = await api('POST', `/staff/tours/${tour.id}/plan/propose`, {
      departureAt: departure(),
    });
    expect(proposal.status).toBe(200);
    expect(proposal.body.plan.feasible).toBe(false);
    expect(proposal.body.plan.conflicts).toHaveLength(1);
    expect(proposal.body.plan.conflicts[0].code).toBe('TIME_WINDOW_MISSED');
    expect(proposal.body.plan.conflicts[0].message).toMatch(
      /^(Liefertermin|Abholtermin|Rückgabetermin) MR-\d{4}-\d+ ist nach dem vorherigen Stopp voraussichtlich nicht rechtzeitig erreichbar\.$/,
    );
    const applied = await api('POST', `/staff/tours/${tour.id}/plan/apply`, {
      expectedVersion: tour.version,
      order: proposal.body.plan.order,
      departureAt: departure(),
    });
    expect(applied.status).toBe(200);
    expect(applied.body.tour.planningStatus).toBe('infeasible');
    expect(applied.body.tour.warnings.map((w: { code: string }) => w.code)).toContain(
      'PLAN_INFEASIBLE',
    );
    for (const original of [first.outbound, second.outbound]) {
      const after = (await appointmentRow(world, original.id))!;
      expect(after.startAt?.toISOString()).toBe(original.startAt?.toISOString());
      expect(after.version).toBe(original.version);
      expect(after.status).toBe('scheduled');
    }
  });

  it('T46. Kein automatischer Lieferpreis: Buchungs-Snapshot unverändert, Grenze liefert null', async () => {
    const { api, tour, exact } = await plannableTour();
    const before = (
      await world.ctx.db.select().from(bookings).where(eq(bookings.id, exact.bookingId))
    )[0]!;
    const proposal = await api('POST', `/staff/tours/${tour.id}/plan/propose`, {
      departureAt: departure(),
    });
    await api('POST', `/staff/tours/${tour.id}/plan/apply`, {
      expectedVersion: tour.version,
      order: proposal.body.plan.order,
      departureAt: departure(),
    });
    const after = (
      await world.ctx.db.select().from(bookings).where(eq(bookings.id, exact.bookingId))
    )[0]!;
    expect(after.deliverySnapshot).toEqual(before.deliverySnapshot);
    expect(suggestDeliveryPrice({ distanceMeters: 12_000, durationSeconds: 900 })).toBeNull();
  });

  it('T47. Providerfehler ⇒ 503 „Route konnte gerade nicht berechnet werden.“, Tour manuell weiter nutzbar', async () => {
    const { api, tour } = await plannableTour();
    world.routing.configure({
      failNext: { all: { kind: 'server_error', times: null, status: 500 } },
    });
    const proposal = await api('POST', `/staff/tours/${tour.id}/plan/propose`, {
      departureAt: departure(),
    });
    expect(proposal.status).toBe(503);
    expect(proposal.body.error.code).toBe('ROUTING_UNAVAILABLE');
    expect(proposal.body.error.message).toBe('Route konnte gerade nicht berechnet werden.');
    const applied = await api('POST', `/staff/tours/${tour.id}/plan/apply`, {
      expectedVersion: tour.version,
      order: tour.stops.map((s: { id: string }) => s.id),
    });
    expect(applied.status).toBe(503);
    // Tourdaten unverändert; manuelle Reihenfolge und Navigation funktionieren ohne Provider.
    const view = await getTour(api, tour.id);
    expect(view.version).toBe(tour.version);
    expect(view.planningStatus).toBe('unplanned');
    const reordered = await api('POST', `/staff/tours/${tour.id}/stops/order`, {
      expectedVersion: tour.version,
      order: [...tour.stops.map((s: { id: string }) => s.id)].reverse(),
    });
    expect(reordered.status).toBe(200);
    for (const stop of reordered.body.tour.stops) {
      expect(stop.navigation).not.toBeNull();
      expect(stop.navigation.apple).toContain('maps.apple.com');
    }
    // Routing nicht konfiguriert (Gateway meldet disabled) ⇒ 409 ROUTING_DISABLED.
    world.routing.reset();
    world.routing.configure({
      failNext: { optimizeTour: { kind: 'disabled', times: null } },
    });
    const disabled = await api('POST', `/staff/tours/${tour.id}/plan/propose`, {});
    expect(disabled.status).toBe(409);
    expect(disabled.body.error.code).toBe('ROUTING_DISABLED');
    expect(disabled.body.error.message).toBe('Routing ist nicht konfiguriert.');
  });

  it('Blocker: fehlende Depotadresse, mehrdeutige Adresse (Review + Bestätigung), kein Treffer – keine Routing-Calls', async () => {
    const { api, tour, window } = await plannableTour();
    await world.ctx.pool.query(`DELETE FROM system_settings WHERE key = 'pickup_exact_address'`);
    const noDepot = await api('POST', `/staff/tours/${tour.id}/plan/propose`, {});
    expect(noDepot.status).toBe(200);
    expect(noDepot.body.status).toBe('blocked');
    expect(noDepot.body.reasons.map((r: { code: string }) => r.code)).toContain(
      'DEPOT_ADDRESS_MISSING',
    );
    expect(noDepot.body.reasons[0].message).toBe(
      'Depotadresse ist noch nicht vollständig hinterlegt.',
    );
    expect(world.routing.calls.filter((c) => c.method !== 'geocode')).toHaveLength(0);
    const view = await getTour(api, tour.id);
    expect(view.depot.status).toBe('missing');
    expect(view.warnings.map((w: { code: string }) => w.code)).toContain('DEPOT_ADDRESS_MISSING');

    const { admin } = await (async () => {
      const rows = await world.ctx.pool.query(
        `SELECT id FROM staff_users ORDER BY created_at LIMIT 1`,
      );
      return { admin: { id: rows.rows[0].id as string } };
    })();
    const { setPickupExactAddress } = await import('./commerce-helpers.ts');
    await setPickupExactAddress(world.ctx, admin.id);

    world.geocoding.override(/Birkenstraße/i, {
      status: 'review_required',
      point: null,
      label: null,
      candidates: [
        {
          ref: 'osm:1',
          label: 'Lieferweg 12, 55129 Mainz',
          point: { latitude: 49.97, longitude: 8.25 },
        },
        {
          ref: 'osm:2',
          label: 'Lieferweg 12, 55120 Mainz',
          point: { latitude: 49.99, longitude: 8.2 },
        },
      ],
    });
    const review = await api('POST', `/staff/tours/${tour.id}/plan/propose`, {});
    expect(review.body.status).toBe('blocked');
    const reason = review.body.reasons.find(
      (r: { code: string }) => r.code === 'GEOCODING_REVIEW_REQUIRED',
    );
    expect(reason.candidates).toHaveLength(2);
    expect(reason.cacheId).toMatch(/^[0-9a-f-]{36}$/);
    const stopId = tour.stops.find(
      (s: { appointmentId: string }) => s.appointmentId === window.outbound.id,
    )!.id;
    expect(reason.stopId).toBe(stopId);
    const reviewed = await getTour(api, tour.id);
    const reviewedStop = reviewed.stops.find((s: { id: string }) => s.id === stopId);
    expect(reviewedStop.address.status).toBe('review_required');
    expect(reviewedStop.address.candidates).toHaveLength(2);

    // Bestätigung nur für Adressen dieser Tour; fremde cacheId ⇒ neutral 404.
    const foreign = await api('POST', `/staff/tours/${tour.id}/geocoding/confirm`, {
      cacheId: '00000000-0000-4000-8000-000000000000',
      candidateRef: 'osm:1',
    });
    expect(foreign.status).toBe(404);
    const confirmed = await api('POST', `/staff/tours/${tour.id}/geocoding/confirm`, {
      cacheId: reason.cacheId,
      candidateRef: 'osm:1',
    });
    expect(confirmed.status).toBe(200);
    const ok = await api('POST', `/staff/tours/${tour.id}/plan/propose`, {});
    expect(ok.body.status).toBe('ok');

    world.geocoding.override(/Ahornweg/i, {
      status: 'no_result',
      point: null,
      label: null,
      candidates: [],
    });
    const none = await api('POST', `/staff/tours/${tour.id}/plan/propose`, {});
    expect(none.body.status).toBe('blocked');
    expect(none.body.reasons[0].code).toBe('GEOCODING_NO_RESULT');
  });

  it('N5. Adressbestätigung prüft die cacheId nur gegen den Cache-Stand (peekCached) – keine Provider-/resolve-Aufrufe für die übrigen Adressen', async () => {
    const { api, tour } = await plannableTour();
    world.geocoding.override(/Birkenstraße/i, {
      status: 'review_required',
      point: null,
      label: null,
      candidates: [
        {
          ref: 'osm:1',
          label: 'Birkenstraße 2, 55128 Mainz',
          point: { latitude: 49.97, longitude: 8.25 },
        },
        {
          ref: 'osm:2',
          label: 'Birkenstraße 2, 55120 Mainz',
          point: { latitude: 49.99, longitude: 8.2 },
        },
      ],
    });
    const review = await api('POST', `/staff/tours/${tour.id}/plan/propose`, {});
    expect(review.body.status).toBe('blocked');
    const reason = review.body.reasons.find(
      (r: { code: string }) => r.code === 'GEOCODING_REVIEW_REQUIRED',
    );
    const resolveCalls = world.geocoding.calls.length;
    const routingCalls = world.routing.calls.length;
    const confirmed = await api('POST', `/staff/tours/${tour.id}/geocoding/confirm`, {
      cacheId: reason.cacheId,
      candidateRef: 'osm:1',
    });
    expect(confirmed.status).toBe(200);
    expect(world.geocoding.calls).toHaveLength(resolveCalls);
    expect(world.routing.calls).toHaveLength(routingCalls);
    // Unbekannte cacheId weiterhin neutral 404 – ebenfalls ohne resolve.
    const foreign = await api('POST', `/staff/tours/${tour.id}/geocoding/confirm`, {
      cacheId: '00000000-0000-4000-8000-000000000000',
      candidateRef: 'osm:1',
    });
    expect(foreign.status).toBe(404);
    expect(world.geocoding.calls).toHaveLength(resolveCalls);
  });
});

describe('Review-13-Fix N4: Lesen ohne Schreibsperre', () => {
  it('N4. GET der Tour öffnet keine Schreibtransaktion, wenn nichts zu heilen ist: liest trotz fremder Zeilensperre sofort; fremder Nutzer ⇒ 404 ohne Warten; Version unverändert', async () => {
    const { admin, api, driver } = await setup();
    const booking = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.id,
      outboundStartAt: berlinAt(DAY(), 9, 0),
      street: 'Ahornweg 1',
    });
    const tour = await tourWithStops(api, {
      tourDate: DAY(),
      assignedUserId: driver.id,
      appointmentIds: [booking.outbound.id],
    });
    const other = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Fremd');
    const otherApi = apiFor(world.app, other.cookie);
    const client = await world.ctx.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM tours WHERE id = $1 FOR NO KEY UPDATE', [tour.id]);
      const startedAt = Date.now();
      const view = await api('GET', `/staff/tours/${tour.id}`);
      expect(view.status).toBe(200);
      expect(view.body.tour.version).toBe(tour.version);
      const foreign = await otherApi('GET', `/staff/tours/${tour.id}`);
      expect(foreign.status).toBe(404);
      const list = await api('GET', `/staff/tours?date=${DAY()}`);
      expect(list.status).toBe(200);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    const after = await getTour(api, tour.id);
    expect(after.version).toBe(tour.version);
  });
});
