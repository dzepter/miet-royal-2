/**
 * Phase-13-Pflichttests 59–72 (Order §§31–45, §69): bewusster Start,
 * Doppelklick, keine zweite aktive Tour derselben effektiven Person, GPS nur
 * in aktiver Tour, Tour läuft ohne Standort, gültiges Update, Überschreiben,
 * keine Historie, fremder Nutzer blockiert, Tourende blockiert/löscht,
 * keine nachträglichen Offline-Spuren, stale-Markierung, keine Background-
 * Garantie. Zusätzlich (§69): Rate-Limit, Log-/Status-Leaks.
 */
import { tourLiveLocations, tours } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getCustomerTravelStatus } from '../src/tours/travel-status.ts';
import { substitutionServiceFor } from './scheduling-helpers.ts';
import {
  DRIVER_PERMISSIONS,
  PLANNER_PERMISSIONS,
  adminSession,
  apiFor,
  berlinAt,
  bookingWithAppointments,
  createToursWorld,
  destroyToursWorld,
  resetToursWorld,
  sendLocation,
  setLiveLocation,
  sleep,
  staffWith,
  todayBerlin,
  tourWithStops,
  type ToursWorld,
} from './tours-helpers.ts';

let world: ToursWorld;
const RATE_LIMIT_MS = 300;
/** Markante Koordinaten – dürfen nie im Log oder in Antworten erscheinen. */
const POINT = { latitude: 49.912345, longitude: 8.261234 };

beforeAll(async () => {
  world = await createToursWorld({ captureLog: true, locationMinIntervalMs: RATE_LIMIT_MS });
});
afterAll(async () => {
  await destroyToursWorld(world);
});
beforeEach(async () => {
  await resetToursWorld(world);
});

async function liveRows(tourId: string) {
  return world.ctx.db.select().from(tourLiveLocations).where(eq(tourLiveLocations.tourId, tourId));
}

/** Entwurf mit zwei Stopps für heute (Fahrer: nur calendar.view). */
async function draftTour(label = 'Fahrer') {
  const { admin, cookie } = await adminSession(world);
  const api = apiFor(world.app, cookie);
  const driver = await staffWith(world, admin.id, DRIVER_PERMISSIONS, label);
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
  return {
    admin,
    adminCookie: cookie,
    api,
    driver: driver.user,
    driverApi,
    today,
    tour,
    first,
    second,
  };
}

async function activeTour(label = 'Fahrer') {
  const setup = await draftTour(label);
  const started = await setup.driverApi('POST', `/staff/tours/${setup.tour.id}/start`, {});
  expect(started.status).toBe(200);
  expect(started.body.started).toBe(true);
  return setup;
}

describe('59.–61. Start', () => {
  it('T59. Start nur bewusst: Anlegen/Stopps starten nichts; erst POST …/start setzt active/started_at/started_by', async () => {
    const { driverApi, driver, tour } = await draftTour();
    expect(tour.status).toBe('draft');
    expect(tour.startedAt).toBeNull();
    expect((await driverApi('GET', '/staff/tours/active')).body.tour).toBeNull();
    const view = await driverApi('GET', `/staff/tours/${tour.id}`);
    expect(view.body.tour.canStart).toBe(true);
    const started = await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
    expect(started.status).toBe(200);
    expect(started.body.started).toBe(true);
    expect(started.body.tour.status).toBe('active');
    expect(started.body.tour.startedAt).not.toBeNull();
    const row = (await world.ctx.db.select().from(tours).where(eq(tours.id, tour.id)))[0]!;
    expect(row.startedBy).toBe(driver.id);
    expect((await driverApi('GET', '/staff/tours/active')).body.tour.id).toBe(tour.id);
  });

  it('T60. Doppelklick: zwei parallele Starts ⇒ genau ein Start, ein started_at', async () => {
    const { driverApi, tour } = await draftTour();
    const [a, b] = await Promise.all([
      driverApi('POST', `/staff/tours/${tour.id}/start`, {}),
      driverApi('POST', `/staff/tours/${tour.id}/start`, {}),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect([a.body.started, b.body.started].filter(Boolean)).toHaveLength(1);
    expect(a.body.tour.startedAt).toBe(b.body.tour.startedAt);
    const third = await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
    expect(third.body.started).toBe(false);
    expect(third.body.tour.startedAt).toBe(a.body.tour.startedAt);
  });

  it('T61. Keine zweite aktive Tour derselben effektiven Person (gespeichert oder per Vertretung)', async () => {
    const { admin, api, driver, today } = await activeTour('Anton');
    // Zweite Tour desselben Fahrers.
    const other = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.id,
      outboundStartAt: berlinAt(today, 23, 40),
      street: 'Cederweg 3',
    });
    const second = await tourWithStops(api, {
      tourDate: today,
      assignedUserId: driver.id,
      appointmentIds: [other.outbound.id],
    });
    const blocked = await api('POST', `/staff/tours/${second.id}/start`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('TOUR_DRIVER_ALREADY_ACTIVE');
    // Tour eines anderen Fahrers, den Anton vertritt ⇒ effektiv dieselbe Person ⇒ 409.
    const carl = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Carl');
    await substitutionServiceFor(world.ctx).create(admin.id, {
      originalUserId: carl.user.id,
      substituteUserId: driver.id,
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: new Date(Date.now() + 2 * 86_400_000),
    });
    const carlBooking = await bookingWithAppointments(world, admin.id, {
      assignTo: carl.user.id,
      outboundStartAt: berlinAt(today, 23, 50),
      street: 'Dornweg 4',
    });
    const carlTour = await tourWithStops(api, {
      tourDate: today,
      assignedUserId: carl.user.id,
      appointmentIds: [carlBooking.outbound.id],
    });
    const substituted = await api('POST', `/staff/tours/${carlTour.id}/start`, {});
    expect(substituted.status).toBe(409);
    expect(substituted.body.error.code).toBe('TOUR_DRIVER_ALREADY_ACTIVE');
    const active = await world.ctx.db.select().from(tours).where(eq(tours.status, 'active'));
    expect(active).toHaveLength(1);
  });
});

describe('62.–66. GPS-Updates', () => {
  it('T62. GPS erst in aktiver Tour: Entwurf ⇒ neutral 404 ohne Zeile; nach Start ⇒ 204', async () => {
    const { driverApi, tour } = await draftTour();
    const early = await sendLocation(driverApi, tour.id, POINT);
    expect(early.status).toBe(404);
    expect(early.body.error.code).toBe('NOT_FOUND');
    expect(await liveRows(tour.id)).toHaveLength(0);
    await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
    const ok = await sendLocation(driverApi, tour.id, POINT);
    expect(ok.status).toBe(204);
    expect(await liveRows(tour.id)).toHaveLength(1);
  });

  it('T63. Standort verweigert: Tour läuft ohne GPS – View, „Angekommen“, Prognose „nicht verfügbar“', async () => {
    const { driverApi, tour } = await activeTour();
    const view = await driverApi('GET', `/staff/tours/${tour.id}`);
    expect(view.status).toBe(200);
    expect(view.body.tour.status).toBe('active');
    expect(view.body.tour.liveLocation).toBeNull();
    expect(view.body.tour.nextStop.id).toBe(tour.stops[0].id);
    for (const stop of view.body.tour.stops) expect(stop.delay).toEqual({ status: 'unknown' });
    expect(view.body.tour.warnings.map((w: { code: string }) => w.code)).toContain(
      'DELAY_FORECAST_UNAVAILABLE',
    );
    const delay = await driverApi('GET', `/staff/tours/${tour.id}/delay`);
    expect(delay.status).toBe(200);
    expect(delay.body.status).toBe('unavailable');
    expect(delay.body.reason).toBe('NO_LIVE_LOCATION');
    const arrived = await driverApi(
      'POST',
      `/staff/tours/${tour.id}/stops/${tour.stops[0].id}/arrived`,
    );
    expect(arrived.status).toBe(200);
    expect(arrived.body.tour.stops[0].state).toBe('arrived');
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('unavailable');
    expect(world.routing.calls.filter((c) => c.method === 'matrix')).toHaveLength(0);
  });

  it('T64. Gültiges Update ⇒ 204, eine Zeile mit Werten; View ohne Koordinaten; nie im Log/Kundenstatus', async () => {
    const { driverApi, driver, tour, first } = await activeTour();
    const observedAt = new Date(Date.now() - 5_000);
    const response = await sendLocation(driverApi, tour.id, {
      ...POINT,
      accuracyMeters: 12.5,
      observedAt,
    });
    expect(response.status).toBe(204);
    const rows = await liveRows(tour.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(driver.id);
    expect(rows[0]!.latitude).toBe(POINT.latitude);
    expect(rows[0]!.longitude).toBe(POINT.longitude);
    expect(rows[0]!.accuracyMeters).toBe(12.5);
    expect(rows[0]!.observedAt.toISOString()).toBe(observedAt.toISOString());
    expect(rows[0]!.receivedAt.getTime()).toBeGreaterThanOrEqual(observedAt.getTime());
    const view = await driverApi('GET', `/staff/tours/${tour.id}`);
    expect(view.body.tour.liveLocation).toEqual({
      observedAt: observedAt.toISOString(),
      receivedAt: rows[0]!.receivedAt.toISOString(),
      stale: false,
    });
    // Die View trägt nur Stopp-Koordinaten (Zieladressen) – nie die Fahrerposition.
    const text = JSON.stringify(view.body);
    expect(text).not.toContain('49.912345');
    expect(text).not.toContain('8.261234');
    expect(text).not.toMatch(/accuracy/);
    expect(Object.keys(view.body.tour.liveLocation)).not.toContain('latitude');
    // §69: nie im Log (Request-Log, Fehler, Bewertung) – weder Werte noch Feldnamen.
    await sleep(100);
    const log = world.logText();
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain('49.912345');
    expect(log).not.toContain('8.261234');
    expect(log).not.toMatch(/latitude|longitude|accuracyMeters/);
    // §69: nie im Kundenstatus „Unterwegs“.
    const status = await getCustomerTravelStatus(world.ctx.db, first.bookingId);
    expect(JSON.stringify(status)).not.toMatch(/49\.91|8\.26|latitude|eta/i);
  });

  it('T65. Jedes Update überschreibt die alte Position (eine Zeile, neue Werte)', async () => {
    const { driverApi, tour } = await activeTour();
    expect((await sendLocation(driverApi, tour.id, POINT)).status).toBe(204);
    await sleep(RATE_LIMIT_MS + 50);
    const next = { latitude: 49.95, longitude: 8.27 };
    expect((await sendLocation(driverApi, tour.id, next)).status).toBe(204);
    const rows = await liveRows(tour.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.latitude).toBe(next.latitude);
    expect(rows[0]!.longitude).toBe(next.longitude);
    expect(rows[0]!.accuracyMeters).toBeNull();
  });

  it('T66. Keine Historie: drei Updates ⇒ eine Zeile; keine Track-Tabelle im Schema', async () => {
    const { driverApi, tour } = await activeTour();
    for (let i = 0; i < 3; i += 1) {
      if (i > 0) await sleep(RATE_LIMIT_MS + 50);
      expect(
        (await sendLocation(driverApi, tour.id, { latitude: 49.9 + i / 100, longitude: 8.2 }))
          .status,
      ).toBe(204);
    }
    expect(await liveRows(tour.id)).toHaveLength(1);
    const tables = await world.ctx.pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND (table_name ILIKE '%track%' OR table_name ILIKE '%location%' OR table_name ILIKE '%gps%')`,
    );
    expect(tables.rows.map((r: { table_name: string }) => r.table_name)).toEqual([
      'tour_live_locations',
    ]);
  });

  it('Zusatz (§44). Rate-Limit je Tour: zweites Update innerhalb des Intervalls ⇒ 429 mit Retry-After, Zeile unverändert', async () => {
    const { driverApi, tour } = await activeTour();
    expect((await sendLocation(driverApi, tour.id, POINT)).status).toBe(204);
    const limited = await sendLocation(driverApi, tour.id, { latitude: 1, longitude: 1 });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('LOCATION_RATE_LIMITED');
    const rows = await liveRows(tour.id);
    expect(rows[0]!.latitude).toBe(POINT.latitude);
    await sleep(RATE_LIMIT_MS + 50);
    expect((await sendLocation(driverApi, tour.id, { latitude: 1, longitude: 1 })).status).toBe(
      204,
    );
  });
});

describe('67.–69. Autorisierung, Tourende', () => {
  it('T67. Fremder Nutzer blockiert (neutral 404): anderer Fahrer, Planung, view_all; Vertretung darf', async () => {
    const { admin, adminCookie, tour, driver } = await activeTour('Anton');
    const other = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Berta');
    const planner = await staffWith(world, admin.id, PLANNER_PERMISSIONS, 'Planer');
    const viewer = await staffWith(
      world,
      admin.id,
      ['calendar.view', 'calendar.view_all'],
      'Sicht',
    );
    const adminApi = apiFor(world.app, adminCookie);
    for (const api of [
      apiFor(world.app, other.cookie),
      apiFor(world.app, planner.cookie),
      apiFor(world.app, viewer.cookie),
      adminApi,
    ]) {
      const response = await sendLocation(api, tour.id, POINT);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toMatch(/Anton|Lieferweg|MR-/);
    }
    expect(await liveRows(tour.id)).toHaveLength(0);
    // Vertretung (effektiver Fahrer) darf melden – der gespeicherte Fahrer weiterhin auch.
    await substitutionServiceFor(world.ctx).create(admin.id, {
      originalUserId: driver.id,
      substituteUserId: other.user.id,
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: new Date(Date.now() + 86_400_000),
    });
    const substitute = await sendLocation(apiFor(world.app, other.cookie), tour.id, POINT);
    expect(substitute.status).toBe(204);
    expect((await liveRows(tour.id))[0]!.userId).toBe(other.user.id);
  });

  it('T68./T69. Tourende blockiert GPS und löscht die Position; Übernahme: alter Fahrer blockiert, neuer darf', async () => {
    const { admin, driverApi, tour } = await activeTour('Anton');
    expect((await sendLocation(driverApi, tour.id, POINT)).status).toBe(204);
    // Übernahme durch die Planung (appointment.assign + Same-Day).
    const planner = await staffWith(world, admin.id, PLANNER_PERMISSIONS, 'Planer');
    const plannerApi = apiFor(world.app, planner.cookie);
    const taken = await plannerApi('POST', `/staff/tours/${tour.id}/takeover`, {});
    expect(taken.status).toBe(200);
    expect(taken.body.tour.assignedUserId).toBe(planner.user.id);
    expect(await liveRows(tour.id)).toHaveLength(0);
    await sleep(RATE_LIMIT_MS + 50);
    expect((await sendLocation(driverApi, tour.id, POINT)).status).toBe(404);
    expect((await sendLocation(plannerApi, tour.id, POINT)).status).toBe(204);
    expect((await liveRows(tour.id))[0]!.userId).toBe(planner.user.id);
    // Ende (Planung, mit offenen Stopps + Grund) ⇒ Zeile weg, Updates abgelehnt.
    const ended = await plannerApi('POST', `/staff/tours/${tour.id}/end`, {
      force: true,
      reason: 'Fahrzeugdefekt – Rest morgen',
    });
    expect(ended.status).toBe(200);
    expect(ended.body.tour.status).toBe('completed');
    expect(ended.body.tour.liveLocation).toBeNull();
    expect(await liveRows(tour.id)).toHaveLength(0);
    await sleep(RATE_LIMIT_MS + 50);
    const after = await sendLocation(plannerApi, tour.id, POINT);
    expect(after.status).toBe(404);
    expect(await liveRows(tour.id)).toHaveLength(0);
  });
});

describe('70.–72. Offline-Spuren, stale, keine Background-Garantie', () => {
  it('T70. Nachträglich gesendete (offline gesammelte) Standorte werden abgelehnt – kein Track aus der Vergangenheit, keine Zukunft', async () => {
    const { driverApi, tour } = await activeTour();
    const old = await sendLocation(driverApi, tour.id, {
      ...POINT,
      observedAt: new Date(Date.now() - 11 * 60_000),
    });
    expect(old.status).toBe(400);
    expect(old.body.error.code).toBe('VALIDATION');
    const future = await sendLocation(driverApi, tour.id, {
      ...POINT,
      observedAt: new Date(Date.now() + 3 * 60_000),
    });
    expect(future.status).toBe(400);
    // „Nachsynchronisation“ eines Offline-Tracks: alle Punkte zu alt ⇒ alle abgelehnt.
    for (let minutes = 60; minutes >= 15; minutes -= 15) {
      await sleep(RATE_LIMIT_MS + 50);
      const replay = await sendLocation(driverApi, tour.id, {
        latitude: 49.9 + minutes / 1000,
        longitude: 8.2,
        observedAt: new Date(Date.now() - minutes * 60_000),
      });
      expect(replay.status).toBe(400);
    }
    expect(await liveRows(tour.id)).toHaveLength(0);
    // Innerhalb der Toleranz (9 min) wird der aktuelle Stand übernommen.
    const recent = await sendLocation(driverApi, tour.id, {
      ...POINT,
      observedAt: new Date(Date.now() - 9 * 60_000),
    });
    expect(recent.status).toBe(204);
  });

  it('T71. Standort älter als 10 Minuten ⇒ „nicht aktuell“ (stale) und keine Live-Prognose', async () => {
    const { driverApi, driver, tour } = await activeTour();
    await setLiveLocation(world, tour.id, driver.id, POINT, new Date(Date.now() - 11 * 60_000));
    const view = await driverApi('GET', `/staff/tours/${tour.id}`);
    expect(view.body.tour.liveLocation.stale).toBe(true);
    expect(view.body.tour.stops[0].delay.status).toBe('unknown');
    const evaluation = await world.live.delay.evaluate(tour.id, 'manual');
    expect(evaluation.status).toBe('unavailable');
    expect(world.routing.calls.filter((c) => c.method === 'matrix')).toHaveLength(0);
    const delay = await driverApi('GET', `/staff/tours/${tour.id}/delay`);
    expect(delay.body.status).toBe('unavailable');
    expect(delay.body.reason).toBe('NO_LIVE_LOCATION');
  });

  it('T72. Keine Background-Garantie: die API behauptet kein Hintergrund-Tracking – nur observedAt/receivedAt/stale', async () => {
    const { driverApi, tour } = await activeTour();
    expect((await sendLocation(driverApi, tour.id, POINT)).status).toBe(204);
    const view = await driverApi('GET', `/staff/tours/${tour.id}`);
    expect(Object.keys(view.body.tour.liveLocation).sort()).toEqual([
      'observedAt',
      'receivedAt',
      'stale',
    ]);
    expect(JSON.stringify(view.body)).not.toMatch(/background|hintergrund|tracking|track/i);
    const active = await driverApi('GET', '/staff/tours/active');
    expect(JSON.stringify(active.body)).not.toMatch(/background|hintergrund|tracking/i);
  });
});

describe('Review-13-Fix N1: Standort nur vom effektiven Fahrer', () => {
  it('N1. Aktive Vertretung ⇒ nur der Vertreter meldet Standort (gespeicherter Fahrer neutral 404); Start/„Angekommen“ bleiben beiden erlaubt', async () => {
    const { admin, driverApi, driver, tour } = await activeTour('Anton');
    const substitute = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Berta');
    const substituteApi = apiFor(world.app, substitute.cookie);
    await substitutionServiceFor(world.ctx).create(admin.id, {
      originalUserId: driver.id,
      substituteUserId: substitute.user.id,
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: new Date(Date.now() + 86_400_000),
    });
    const stored = await sendLocation(driverApi, tour.id, POINT);
    expect(stored.status).toBe(404);
    expect(stored.body.error.code).toBe('NOT_FOUND');
    expect(await liveRows(tour.id)).toHaveLength(0);
    const effective = await sendLocation(substituteApi, tour.id, POINT);
    expect(effective.status).toBe(204);
    expect((await liveRows(tour.id))[0]!.userId).toBe(substitute.user.id);
    // Operative Aktionen (Sichtbarkeit „eigene Tour“) bleiben für beide erlaubt.
    const stopId = tour.stops[0].id as string;
    const arrivedStored = await driverApi(
      'POST',
      `/staff/tours/${tour.id}/stops/${stopId}/arrived`,
    );
    expect(arrivedStored.status).toBe(200);
    const startStored = await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
    expect(startStored.status).toBe(200);
    expect(startStored.body.started).toBe(false);
    const secondStop = tour.stops[1].id as string;
    const arrivedEffective = await substituteApi(
      'POST',
      `/staff/tours/${tour.id}/stops/${secondStop}/arrived`,
    );
    expect(arrivedEffective.status).toBe(200);
    expect((await driverApi('GET', `/staff/tours/${tour.id}`)).status).toBe(200);
    await world.delayState.settle();
  });
});
