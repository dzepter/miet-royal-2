/**
 * Phase-13-Pflichttests 73–79: Storno ⇒ Stopp operativ weg, Verschiebung ⇒
 * stale, Restroute nur für verbleibende Stopps, erledigte unverändert,
 * Adressänderung ⇒ stale, veraltete Version nach externer Berechnung ⇒
 * verworfen, kein HTTP unter DB-Sperre.
 */
import { tourStops } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TourService } from '../src/tours/tour-service.ts';
import { cancelBooking } from './cancellation-helpers.ts';
import {
  DRIVER_PERMISSIONS,
  adminSession,
  apiFor,
  berlinAt,
  bookingWithAppointments,
  completeAppointment,
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

async function setup(day: string, options: { untimed?: boolean } = {}) {
  const { admin, cookie } = await adminSession(world);
  const api = apiFor(world.app, cookie);
  const driver = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Fahrer');
  const streets = ['Ahornweg 1', 'Birkenstraße 2', 'Cedernweg 3'];
  const bookings = [];
  for (let i = 0; i < 3; i += 1) {
    bookings.push(
      await bookingWithAppointments(world, admin.id, {
        assignTo: driver.user.id,
        // Ohne Zeitvorgabe (untimed): Restroute unabhängig von der Uhrzeit des Testlaufs machbar.
        ...(options.untimed === true
          ? {}
          : { outboundStartAt: berlinAt(day, 9 + i, 0), outboundEndAt: berlinAt(day, 20, 0) }),
        street: streets[i]!,
      }),
    );
  }
  const tour = await tourWithStops(api, {
    tourDate: day,
    assignedUserId: driver.user.id,
    appointmentIds: bookings.map((b) => b.outbound.id),
  });
  return {
    admin,
    api,
    driver: driver.user,
    driverApi: apiFor(world.app, driver.cookie),
    tour,
    bookings,
  };
}

async function applyPlan(api: ReturnType<typeof apiFor>, tourId: string, day: string) {
  const current = await getTour(api, tourId);
  const departureAt = berlinAt(day, 8, 0).toISOString();
  const proposal = await api('POST', `/staff/tours/${tourId}/plan/propose`, { departureAt });
  expect(proposal.body.status).toBe('ok');
  const applied = await api('POST', `/staff/tours/${tourId}/plan/apply`, {
    expectedVersion: current.version,
    order: proposal.body.plan.order,
    departureAt,
  });
  expect(applied.status).toBe(200);
  expect(applied.body.tour.planningStatus).toBe('planned');
  return applied.body.tour;
}

describe('73.–77. Änderungen am Termin/Depot', () => {
  it('T73. Storno während der Tour ⇒ Stopp operativ übersprungen (Listener) und lazy beim Lesen', async () => {
    const today = todayBerlin();
    const { api, driverApi, tour, bookings } = await setup(today);
    const started = await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
    expect(started.body.started).toBe(true);
    // Storno über die Route (Listener nach Commit).
    const cancelled = await api('POST', `/staff/processes/${bookings[0]!.processId}/cancellation`, {
      confirm: true,
    });
    expect(cancelled.status).toBe(200);
    let view = await getTour(api, tour.id);
    const first = view.stops.find(
      (s: { appointmentId: string }) => s.appointmentId === bookings[0]!.outbound.id,
    );
    expect(first.state).toBe('skipped');
    expect(first.skippedAt).not.toBeNull();
    expect(first.appointment.status).toBe('cancelled');
    expect(view.nextStop.appointmentId).toBe(bookings[1]!.outbound.id);
    // Storno direkt über den Service (ohne App-Listener) ⇒ Lazy-Heilung beim Lesen.
    await cancelBooking(
      world.ctx,
      (await world.ctx.pool.query(`SELECT id FROM staff_users ORDER BY created_at LIMIT 1`)).rows[0]
        .id,
      bookings[1]!.processId,
    );
    view = await getTour(api, tour.id);
    const second = view.stops.find(
      (s: { appointmentId: string }) => s.appointmentId === bookings[1]!.outbound.id,
    );
    expect(second.state).toBe('skipped');
    expect(view.nextStop.appointmentId).toBe(bookings[2]!.outbound.id);
    expect(view.status).toBe('active');
  });

  it('T74. Terminverschiebung ⇒ Plan stale (Warnung), Version erhöht, Termine unangetastet', async () => {
    const day = dateInDays(3);
    const { api, tour, bookings } = await setup(day);
    const planned = await applyPlan(api, tour.id, day);
    const appointment = bookings[1]!.outbound;
    const moved = await api('PATCH', `/staff/appointments/${appointment.id}/schedule`, {
      startAt: berlinAt(day, 14, 0).toISOString(),
      endAt: berlinAt(day, 16, 0).toISOString(),
      expectedVersion: appointment.version,
    });
    expect(moved.status).toBe(200);
    const view = await getTour(api, tour.id);
    expect(view.planningStatus).toBe('stale');
    expect(view.version).toBe(planned.version + 1);
    expect(view.warnings.map((w: { code: string }) => w.code)).toContain('PLAN_STALE');
    // Alte Werte bleiben sichtbar, gelten aber als veraltet (nie still als aktuell).
    expect(view.routeCalculatedAt).toBe(planned.routeCalculatedAt);
  });

  it('T75./T76. Restroute neu berechnen: nur verbleibende Stopps, erledigte bleiben unverändert', async () => {
    const today = todayBerlin();
    const { api, driver, driverApi, tour } = await setup(today, { untimed: true });
    await applyPlan(api, tour.id, today);
    const started = await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
    expect(started.body.started).toBe(true);
    const before = await getTour(api, tour.id);
    const firstId: string = before.stops[0].id;
    await completeAppointment(world, driver.id, before.stops[0].appointmentId);
    const doneBefore = (
      await world.ctx.db.select().from(tourStops).where(eq(tourStops.id, firstId))
    )[0]!;
    world.routing.reset();
    const current = await getTour(api, tour.id);
    const result = await driverApi('POST', `/staff/tours/${tour.id}/plan/recalculate`, {
      expectedVersion: current.version,
    });
    expect(result.status).toBe(200);
    expect(result.body.plan.order).toEqual(current.stops.slice(1).map((s: { id: string }) => s.id));
    expect(result.body.plan.stopCount).toBe(2);
    // Matrix: Startpunkt (Depot/letzter erledigter Stopp) + Depot + 2 verbleibende Stopps.
    const matrixCall = world.routing.calls.find((c) => c.method === 'matrix');
    expect(matrixCall).toBeDefined();
    expect((matrixCall as { request: { points: unknown[] } }).request.points).toHaveLength(4);
    // Erledigter Stopp: Planungswerte unverändert (Historie).
    const doneAfter = (
      await world.ctx.db.select().from(tourStops).where(eq(tourStops.id, firstId))
    )[0]!;
    expect(doneAfter.plannedArrivalAt?.toISOString()).toBe(
      doneBefore.plannedArrivalAt?.toISOString(),
    );
    expect(doneAfter.legDistanceMeters).toBe(doneBefore.legDistanceMeters);
    expect(doneAfter.sequence).toBe(doneBefore.sequence);
    // Verbleibende Stopps: neue Ankunftszeiten ab jetzt.
    const view = result.body.tour;
    expect(view.stops[0].state).toBe('done');
    for (const stop of view.stops.slice(1)) {
      expect(stop.state).toBe('open');
      expect(new Date(stop.plannedArrivalAt).getTime()).toBeGreaterThanOrEqual(Date.now() - 60_000);
    }
    expect(view.planningStatus).toBe('planned');
    expect(view.routeCalculatedAt).not.toBe(before.routeCalculatedAt);
    // Nur die geplante Bewegung: an die Provider-Anfrage gehen nur Koordinaten.
    expect(world.routing.serializedCalls()).not.toMatch(/MR-\d|Kommerz|Lieferweg|@test\.example/);
  });

  it('T77. Änderung der Depotadresse ⇒ Plan stale', async () => {
    const day = dateInDays(3);
    const { api, tour } = await setup(day);
    const planned = await applyPlan(api, tour.id, day);
    // Kurze Pause, damit updated_at sicher nach route_calculated_at liegt.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updated = await api('PUT', '/staff/settings/pickup', {
      exactAddress: 'Neue Halle 7, 55129 Mainz-Hechtsheim (SYNTHETISCH)',
    });
    expect(updated.status).toBe(200);
    const view = await getTour(api, tour.id);
    expect(view.planningStatus).toBe('stale');
    expect(view.version).toBe(planned.version + 1);
    expect(view.depot.label).toContain('Neue Halle 7');
  });
});

describe('78./79. Zweiphasige Berechnung', () => {
  it('T78. Version ändert sich während der externen Berechnung ⇒ Ergebnis verworfen (409), nichts gespeichert', async () => {
    const day = dateInDays(3);
    const { admin, api, tour } = await setup(day);
    const current = await getTour(api, tour.id);
    const order: string[] = current.stops.map((s: { id: string }) => s.id);
    world.routing.configure({
      beforeRespond: async (call) => {
        if (call.method !== 'matrix') return;
        // Parallele Änderung während der Provider läuft (bewusst ohne HTTP-Sperre möglich).
        await new TourService(world.ctx.db).reorder(admin.id, tour.id, {
          order: [...order].reverse(),
        });
      },
    });
    const applied = await api('POST', `/staff/tours/${tour.id}/plan/apply`, {
      expectedVersion: current.version,
      order,
      departureAt: berlinAt(day, 8, 0).toISOString(),
    });
    expect(applied.status).toBe(409);
    expect(applied.body.error.code).toBe('TOUR_VERSION_CONFLICT');
    const view = await getTour(api, tour.id);
    expect(view.planningStatus).toBe('unplanned');
    expect(view.routeCalculatedAt).toBeNull();
    expect(view.stops.map((s: { id: string }) => s.id)).toEqual([...order].reverse());
    for (const stop of view.stops) expect(stop.plannedArrivalAt).toBeNull();
  });

  it('T79. Während des Provider-Aufrufs hält die Berechnung KEINE Zeilensperre auf der Tour', async () => {
    const day = dateInDays(3);
    const { api, tour } = await setup(day);
    const current = await getTour(api, tour.id);
    let lockable: boolean | null = null;
    world.routing.configure({
      beforeRespond: async (call) => {
        if (call.method !== 'matrix') return;
        const client = await world.ctx.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT id FROM tours WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [
            tour.id,
          ]);
          lockable = true;
        } catch {
          lockable = false;
        } finally {
          await client.query('ROLLBACK').catch(() => undefined);
          client.release();
        }
      },
    });
    const applied = await api('POST', `/staff/tours/${tour.id}/plan/apply`, {
      expectedVersion: current.version,
      order: current.stops.map((s: { id: string }) => s.id),
      departureAt: berlinAt(day, 8, 0).toISOString(),
    });
    expect(applied.status).toBe(200);
    expect(lockable).toBe(true);
  });
});

describe('Review-13-Fixes: Restroute-CAS, Termin an anderem Tag', () => {
  it('F4. Restroute: expectedVersion Pflicht (400); parallele Umsortierung während des Provider-Aufrufs ⇒ 409 TOUR_VERSION_CONFLICT, Plan bleibt stale', async () => {
    const today = todayBerlin();
    const { api, driverApi, tour } = await setup(today, { untimed: true });
    const started = await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
    expect(started.body.started).toBe(true);
    const missing = await driverApi('POST', `/staff/tours/${tour.id}/plan/recalculate`, {});
    expect(missing.status).toBe(400);
    const before = await getTour(driverApi, tour.id);
    const ids: string[] = before.stops.map((s: { id: string }) => s.id);
    let reordered = false;
    world.routing.configure({
      beforeRespond: async (call) => {
        if (call.method !== 'matrix' || reordered) return;
        reordered = true;
        const result = await api('POST', `/staff/tours/${tour.id}/stops/order`, {
          order: [...ids].reverse(),
        });
        expect(result.status).toBe(200);
      },
    });
    const recalculated = await driverApi('POST', `/staff/tours/${tour.id}/plan/recalculate`, {
      expectedVersion: before.version,
    });
    expect(reordered).toBe(true);
    expect(recalculated.status).toBe(409);
    expect(recalculated.body.error.code).toBe('TOUR_VERSION_CONFLICT');
    await world.delayState.settle();
    const after = await getTour(driverApi, tour.id);
    expect(after.planningStatus).not.toBe('planned');
    expect(after.stops.map((s: { id: string }) => s.id)).toEqual([...ids].reverse());
    for (const stop of after.stops) expect(stop.plannedArrivalAt).toBeNull();
    // Mit aktueller Version klappt die Restroute (Reihenfolge wird elementweise geprüft).
    world.routing.configure({ beforeRespond: async () => undefined });
    const ok = await driverApi('POST', `/staff/tours/${tour.id}/plan/recalculate`, {
      expectedVersion: after.version,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.plan.order).toEqual([...ids].reverse());
    await world.delayState.settle();
  });

  it('N3. Termin auf einen anderen Tag verschoben ⇒ Plan stale UND Warnung APPOINTMENT_NOT_ON_TOUR_DATE am Stopp', async () => {
    const day = dateInDays(3);
    const { api, tour, bookings } = await setup(day);
    await applyPlan(api, tour.id, day);
    const appointment = bookings[1]!.outbound;
    const nextDay = dateInDays(4);
    const moved = await api('PATCH', `/staff/appointments/${appointment.id}/schedule`, {
      startAt: berlinAt(nextDay, 10, 0).toISOString(),
      endAt: berlinAt(nextDay, 12, 0).toISOString(),
      expectedVersion: appointment.version,
    });
    expect(moved.status).toBe(200);
    const view = await getTour(api, tour.id);
    expect(view.planningStatus).toBe('stale');
    const stopId = view.stops.find(
      (s: { appointmentId: string }) => s.appointmentId === appointment.id,
    ).id;
    const warning = view.warnings.find(
      (w: { code: string }) => w.code === 'APPOINTMENT_NOT_ON_TOUR_DATE',
    );
    expect(warning).toEqual({
      code: 'APPOINTMENT_NOT_ON_TOUR_DATE',
      message: 'Termin liegt nicht mehr am Tourtag.',
      stopId,
    });
    expect(
      view.warnings.filter((w: { code: string }) => w.code === 'APPOINTMENT_NOT_ON_TOUR_DATE'),
    ).toHaveLength(1);
  });
});

describe('Phase 13 Final (§6E): Stopp aus aktiver Tour entfernen', () => {
  it('E1. Nicht erledigter Stopp: calendar.manage entfernt ihn bewusst aus der AKTIVEN Tour (Termin bleibt scheduled, Route stale, Tour aktiv); Fahrer ohne manage 403; erledigte Stopps bleiben Historie (409 TOUR_STOP_DONE)', async () => {
    const today = todayBerlin();
    const { api, driver, driverApi, tour, bookings } = await setup(today, { untimed: true });
    await applyPlan(api, tour.id, today);
    const started = await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
    expect(started.body.started).toBe(true);
    const before = await getTour(api, tour.id);
    expect(before.planningStatus).toBe('planned');
    const doneStop = before.stops[0];
    const openStop = before.stops[1];
    await completeAppointment(world, driver.id, doneStop.appointmentId);
    // Erledigter Stopp: nicht entfernbar (Historie).
    const blocked = await api('DELETE', `/staff/tours/${tour.id}/stops/${doneStop.id}`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('TOUR_STOP_DONE');
    // Fahrer ohne calendar.manage: nicht erlaubt.
    const forbidden = await driverApi('DELETE', `/staff/tours/${tour.id}/stops/${openStop.id}`, {});
    expect(forbidden.status).toBe(403);
    // Planer: bewusstes Entfernen eines nicht erledigten Stopps.
    const current = await getTour(api, tour.id);
    const removed = await api('DELETE', `/staff/tours/${tour.id}/stops/${openStop.id}`, {
      expectedVersion: current.version,
    });
    expect(removed.status).toBe(200);
    const view = removed.body.tour;
    expect(view.status).toBe('active');
    expect(view.planningStatus).toBe('stale');
    expect(view.version).toBeGreaterThan(current.version);
    expect(view.stops.map((s: { id: string }) => s.id)).toEqual(
      current.stops
        .filter((s: { id: string }) => s.id !== openStop.id)
        .map((s: { id: string }) => s.id),
    );
    expect(view.stops[0].state).toBe('done');
    // Termin bleibt fachlich unangetastet (scheduled, keine Stornierung).
    const appointment = (
      await world.ctx.pool.query('SELECT status FROM appointments WHERE id = $1', [
        openStop.appointmentId,
      ])
    ).rows[0] as { status: string };
    expect(appointment.status).toBe('scheduled');
    expect(
      (await world.ctx.db.select().from(tourStops).where(eq(tourStops.id, openStop.id))).length,
    ).toBe(0);
    void bookings;
  });
});
