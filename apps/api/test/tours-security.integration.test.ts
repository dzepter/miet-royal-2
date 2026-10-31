/**
 * Phase-13-Pflichttests 110–114: fremde Tour-ID neutral 404, fremder Stopp
 * neutral, calendar.view nur eigene/effektive Touren, calendar.view_all alle,
 * calendar.manage bearbeitet. (104–109, 115–116: Agent ACTIVE/UI.)
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { substitutionServiceFor } from './scheduling-helpers.ts';
import {
  DRIVER_PERMISSIONS,
  addStop,
  adminSession,
  apiFor,
  berlinAt,
  bookingWithAppointments,
  createToursWorld,
  dateInDays,
  destroyToursWorld,
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

async function setup() {
  const { admin, cookie } = await adminSession(world);
  const api = apiFor(world.app, cookie);
  const driverA = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Anton');
  const driverB = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Berta');
  const day = dateInDays(2);
  const bookingA = await bookingWithAppointments(world, admin.id, {
    assignTo: driverA.user.id,
    outboundStartAt: berlinAt(day, 10, 0),
  });
  const bookingB = await bookingWithAppointments(world, admin.id, {
    assignTo: driverB.user.id,
    outboundStartAt: berlinAt(day, 11, 0),
    street: 'Birkenstraße 2',
  });
  const tourA = await tourWithStops(api, {
    tourDate: day,
    assignedUserId: driverA.user.id,
    appointmentIds: [bookingA.outbound.id],
  });
  const tourB = await tourWithStops(api, {
    tourDate: day,
    assignedUserId: driverB.user.id,
    appointmentIds: [bookingB.outbound.id],
  });
  return {
    admin,
    api,
    day,
    driverA: driverA.user,
    driverB: driverB.user,
    apiA: apiFor(world.app, driverA.cookie),
    apiB: apiFor(world.app, driverB.cookie),
    tourA,
    tourB,
    bookingA,
    bookingB,
  };
}

describe('110./111. IDOR', () => {
  it('T110. Fremde Tour-ID ⇒ neutral 404 für Lesen und alle Fahreraktionen; unbekannte ID identisch', async () => {
    const { apiB, tourA } = await setup();
    const attempts = [
      apiB('GET', `/staff/tours/${tourA.id}`),
      apiB('POST', `/staff/tours/${tourA.id}/start`, {}),
      apiB('POST', `/staff/tours/${tourA.id}/end`, {}),
      apiB('POST', `/staff/tours/${tourA.id}/plan/recalculate`, {}),
      apiB('POST', `/staff/tours/${tourA.id}/stops/${tourA.stops[0].id}/arrived`),
      apiB('GET', `/staff/tours/${randomUUID()}`),
      apiB('POST', `/staff/tours/${randomUUID()}/start`, {}),
    ];
    for (const attempt of await Promise.all(attempts)) {
      expect(attempt.status).toBe(404);
      expect(attempt.body.error.code).toBe('NOT_FOUND');
      expect(JSON.stringify(attempt.body)).not.toMatch(/Anton|Lieferweg|MR-/);
    }
    // Liste: nur eigene Touren.
    const list = await apiB('GET', `/staff/tours?date=${tourA.tourDate}`);
    expect(list.status).toBe(200);
    expect(list.body.scope).toBe('mine');
    expect(list.body.tours.map((t: { id: string }) => t.id)).not.toContain(tourA.id);
  });

  it('T111. Fremder Stopp ⇒ neutral 404 (auch für Planer über eine andere Tour)', async () => {
    const { api, apiB, tourA, tourB } = await setup();
    const foreignStop = await apiB(
      'POST',
      `/staff/tours/${tourB.id}/stops/${tourA.stops[0].id}/arrived`,
    );
    expect(foreignStop.status).toBe(404);
    // Planer: Stopp-ID gehört nicht zur angegebenen Tour ⇒ 404 ohne Änderung.
    const crossed = await api('PATCH', `/staff/tours/${tourB.id}/stops/${tourA.stops[0].id}`, {
      isPinned: true,
    });
    expect(crossed.status).toBe(404);
    const removed = await api('DELETE', `/staff/tours/${tourB.id}/stops/${tourA.stops[0].id}`, {});
    expect(removed.status).toBe(404);
    const viewA = await api('GET', `/staff/tours/${tourA.id}`);
    expect(viewA.body.tour.stops[0].isPinned).toBe(false);
    expect(viewA.body.tour.stops).toHaveLength(1);
  });
});

describe('112.–114. Rechte', () => {
  it('T112. calendar.view sieht nur eigene bzw. effektiv vertretene Touren', async () => {
    const { admin, apiA, apiB, day, driverA, tourA, tourB } = await setup();
    const own = await apiA('GET', `/staff/tours/${tourA.id}`);
    expect(own.status).toBe(200);
    expect(own.body.tour.canEdit).toBe(false);
    expect(own.body.tour.stops[0].appointment.customerName).not.toBeNull();
    expect((await apiA('GET', `/staff/tours/${tourB.id}`)).status).toBe(404);
    let list = await apiA('GET', `/staff/tours?date=${day}`);
    expect(list.body.tours.map((t: { id: string }) => t.id)).toEqual([tourA.id]);
    // Vertretung: B vertritt A ⇒ B sieht Tour A zusätzlich.
    await substitutionServiceFor(world.ctx).create(admin.id, {
      originalUserId: driverA.id,
      substituteUserId: (
        await world.ctx.pool.query(`SELECT id FROM staff_users WHERE first_name = 'Berta'`)
      ).rows[0].id,
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: new Date(Date.now() + 5 * 86_400_000),
    });
    list = await apiB('GET', `/staff/tours?date=${day}`);
    expect(list.body.tours.map((t: { id: string }) => t.id).sort()).toEqual(
      [tourA.id, tourB.id].sort(),
    );
    const substituted = await apiB('GET', `/staff/tours/${tourA.id}`);
    expect(substituted.status).toBe(200);
    expect(substituted.body.tour.substituted).toBe(true);
  });

  it('T113. calendar.view_all sieht alle Touren, darf aber nicht planen', async () => {
    const { admin, day, tourA, tourB, driverA } = await setup();
    const viewer = await staffWith(
      world,
      admin.id,
      ['calendar.view', 'calendar.view_all'],
      'Sicht',
    );
    const viewerApi = apiFor(world.app, viewer.cookie);
    const list = await viewerApi('GET', `/staff/tours?date=${day}`);
    expect(list.body.scope).toBe('all');
    expect(list.body.tours.map((t: { id: string }) => t.id).sort()).toEqual(
      [tourA.id, tourB.id].sort(),
    );
    expect((await viewerApi('GET', `/staff/tours/${tourA.id}`)).status).toBe(200);
    expect(
      (await viewerApi('POST', '/staff/tours', { tourDate: day, assignedUserId: driverA.id }))
        .status,
    ).toBe(403);
    expect(
      (
        await viewerApi('POST', `/staff/tours/${tourA.id}/stops/order`, {
          order: [tourA.stops[0].id],
        })
      ).status,
    ).toBe(403);
    expect((await viewerApi('POST', `/staff/tours/${tourA.id}/plan/propose`, {})).status).toBe(403);
    // Nicht Fahrer: Start/Ende der fremden Tour verboten (403, Tour ist sichtbar).
    expect((await viewerApi('POST', `/staff/tours/${tourA.id}/start`, {})).status).toBe(403);
  });

  it('T114. calendar.manage plant/bearbeitet alle Touren; Fahrer ohne manage nicht', async () => {
    const { admin, apiA, day, driverA, tourA, bookingA } = await setup();
    const planner = await staffWith(
      world,
      admin.id,
      ['calendar.view', 'calendar.manage', 'appointment.assign'],
      'Planer',
    );
    const plannerApi = apiFor(world.app, planner.cookie);
    const created = await plannerApi('POST', '/staff/tours', {
      tourDate: day,
      assignedUserId: driverA.id,
    });
    expect(created.status).toBe(200);
    expect(created.body.tour.canEdit).toBe(true);
    const foreignView = await plannerApi('GET', `/staff/tours/${tourA.id}`);
    expect(foreignView.status).toBe(200);
    const patched = await plannerApi(
      'PATCH',
      `/staff/tours/${tourA.id}/stops/${tourA.stops[0].id}`,
      {
        bufferMinutes: 20,
      },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.tour.stops[0].bufferMinutes).toBe(20);
    expect((await plannerApi('POST', `/staff/tours/${tourA.id}/ready`, {})).status).toBe(200);

    // Fahrer (nur calendar.view) darf nichts verändern – auch nicht an der eigenen Tour.
    expect(
      (await apiA('POST', '/staff/tours', { tourDate: day, assignedUserId: driverA.id })).status,
    ).toBe(403);
    expect((await addStop(apiA, tourA.id, bookingA.inbound.id)).status).toBe(403);
    expect(
      (
        await apiA('PATCH', `/staff/tours/${tourA.id}/stops/${tourA.stops[0].id}`, {
          isPinned: true,
        })
      ).status,
    ).toBe(403);
    expect((await apiA('POST', `/staff/tours/${tourA.id}/cancel`, {})).status).toBe(403);
    expect(
      (await apiA('POST', `/staff/tours/${tourA.id}/plan/apply`, { expectedVersion: 1, order: [] }))
        .status,
    ).toBe(403);
    // Ohne calendar.view gar kein Zugriff.
    const nobody = await staffWith(world, admin.id, ['customer.view'], 'Niemand');
    expect(
      (await apiFor(world.app, nobody.cookie)('GET', `/staff/tours?date=${todayBerlin()}`)).status,
    ).toBe(403);
  });
});

// ── Phase 13 (tours-live): 104–109 Navigation, 115–116 Offline, Zusatz GPS/Key ─────────────

import { tourLiveLocations } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { sendLocation, sleep } from './tours-helpers.ts';

const DEVICE = '0f6a9d2e-1b3c-4d5e-8f70-1234567890ab';
const KEY_PATTERN = /key=|apiKey|GRAPHHOPPER|graphhopper\.com/i;

/** Aktive Tour heute (Fahrer A) – für Offline-Snapshot und GPS-Zusatztests. */
async function activeToday() {
  const { admin, cookie } = await adminSession(world);
  const api = apiFor(world.app, cookie);
  // Offline-Lease: seit Phase 13 Final (§4) berechtigt auch calendar.view allein zum
  // (read-only) Offlinebetrieb; handover.view bleibt hier für den vollen Phase-8-Pfad
  // (Handover-Paket/Mutationen) gesetzt.
  const driverA = await staffWith(
    world,
    admin.id,
    [...DRIVER_PERMISSIONS, 'handover.view'],
    'Anton',
  );
  const driverB = await staffWith(
    world,
    admin.id,
    [...DRIVER_PERMISSIONS, 'handover.view'],
    'Berta',
  );
  const today = todayBerlin();
  const booking = await bookingWithAppointments(world, admin.id, {
    assignTo: driverA.user.id,
    outboundStartAt: berlinAt(today, 23, 30),
  });
  const other = await bookingWithAppointments(world, admin.id, {
    assignTo: driverA.user.id,
    outboundStartAt: berlinAt(today, 23, 45),
    street: 'Birkenstraße 2',
  });
  const tour = await tourWithStops(api, {
    tourDate: today,
    assignedUserId: driverA.user.id,
    appointmentIds: [booking.outbound.id, other.outbound.id],
  });
  const apiA = apiFor(world.app, driverA.cookie);
  const started = await apiA('POST', `/staff/tours/${tour.id}/start`, {});
  expect(started.status).toBe(200);
  return {
    admin,
    api,
    apiA,
    apiB: apiFor(world.app, driverB.cookie),
    cookieA: driverA.cookie,
    cookieB: driverB.cookie,
    driverA: driverA.user,
    driverB: driverB.user,
    tour: started.body.tour,
    booking,
  };
}

async function offlinePackage(cookie: string) {
  const lease = await world.app.inject({
    method: 'POST',
    url: '/staff/offline/lease',
    headers: { cookie },
    payload: { deviceId: DEVICE, environment: 'development' },
  });
  expect(lease.statusCode).toBe(200);
  const response = await world.app.inject({
    method: 'POST',
    url: '/staff/offline/package',
    headers: { cookie },
    payload: { deviceId: DEVICE, environment: 'development', includeDocuments: false },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    activeTour: {
      tourId: string;
      tourDate: string;
      status: string;
      version: number;
      stops: Record<string, unknown>[];
    } | null;
    bookings: unknown[];
  };
}

describe('104.–109. Navigation', () => {
  it('T104./T106. Navigations-Links enthalten nur das Ziel (Adresse bzw. Koordinate) – keinen Kundennamen, keine Vorgangsnummer', async () => {
    const { api, apiA, tourA } = await setup();
    let view = (await apiA('GET', `/staff/tours/${tourA.id}`)).body.tour;
    const stop = view.stops[0];
    expect(stop.appointment.customerName).toBe('Klara Kommerz');
    expect(stop.navigation).not.toBeNull();
    // Vor der Geokodierung: Adress-Variante (nur Straße/PLZ/Ort, URL-kodiert).
    const encoded = encodeURIComponent('Lieferweg 12, 55129 Mainz');
    expect(stop.navigation.apple).toBe(`https://maps.apple.com/?daddr=${encoded}`);
    expect(stop.navigation.android).toBe(`geo:0,0?q=${encoded}`);
    for (const link of Object.values(stop.navigation as Record<string, string>)) {
      expect(link).not.toMatch(/Klara|Kommerz|MR-|0171/);
      expect(link).not.toMatch(KEY_PATTERN);
    }
    // Nach der Routenberechnung: Koordinaten-Variante – wieder nur das Ziel.
    expect((await api('POST', `/staff/tours/${tourA.id}/plan/propose`, {})).status).toBe(200);
    view = (await apiA('GET', `/staff/tours/${tourA.id}`)).body.tour;
    const geocoded = view.stops[0];
    expect(geocoded.address.point).toEqual({ latitude: 49.9742, longitude: 8.2566 });
    expect(geocoded.navigation.apple).toBe('https://maps.apple.com/?daddr=49.9742,8.2566');
    for (const link of Object.values(geocoded.navigation as Record<string, string>)) {
      expect(link).not.toMatch(/Klara|Kommerz|MR-|0171|Lieferweg/);
      expect(link).not.toMatch(KEY_PATTERN);
      expect(link).not.toContain(tourA.id);
    }
  });

  it('T105. Kein API-Key in Antworten: Tour-View, Prognose, Navigation', async () => {
    const { apiA, tourA } = await setup();
    const view = await apiA('GET', `/staff/tours/${tourA.id}`);
    expect(JSON.stringify(view.body)).not.toMatch(KEY_PATTERN);
    const delay = await apiA('GET', `/staff/tours/${tourA.id}/delay`);
    expect(delay.status).toBe(200);
    expect(JSON.stringify(delay.body)).not.toMatch(KEY_PATTERN);
    const active = await apiA('GET', '/staff/tours/active');
    expect(JSON.stringify(active.body)).not.toMatch(KEY_PATTERN);
    // Konfiguration ist in keiner View enthalten (nur providerName/routeProvider).
    expect(JSON.stringify(view.body)).not.toMatch(/routing":\{|baseUrl|requestTimeout/);
  });

  it('T107./T108./T109. Apple-, Android- und Desktop-Link je Stopp (Adresse und Koordinate)', async () => {
    const { api, apiA, tourA } = await setup();
    const address = (await apiA('GET', `/staff/tours/${tourA.id}`)).body.tour.stops[0].navigation;
    const encoded = encodeURIComponent('Lieferweg 12, 55129 Mainz');
    expect(address).toEqual({
      apple: `https://maps.apple.com/?daddr=${encoded}`,
      android: `geo:0,0?q=${encoded}`,
      web: `https://www.google.com/maps/dir/?api=1&destination=${encoded}`,
    });
    await api('POST', `/staff/tours/${tourA.id}/plan/propose`, {});
    const point = (await apiA('GET', `/staff/tours/${tourA.id}`)).body.tour.stops[0].navigation;
    expect(point).toEqual({
      apple: 'https://maps.apple.com/?daddr=49.9742,8.2566',
      android: 'geo:49.9742,8.2566?q=49.9742,8.2566',
      web: 'https://www.google.com/maps/dir/?api=1&destination=49.9742%2C8.2566',
    });
    // Jede Variante funktioniert ohne Routing-Provider (keine Provider-Domain, kein Key).
    for (const link of [...Object.values(address), ...Object.values(point)] as string[]) {
      expect(link).toMatch(
        /^(https:\/\/maps\.apple\.com\/|geo:|https:\/\/www\.google\.com\/maps\/)/,
      );
      expect(link).not.toMatch(KEY_PATTERN);
    }
  });
});

describe('115.–116. Offline', () => {
  it('T115. Offline-Paket enthält die EIGENE aktive Tour lesbar (Reihenfolge, Zeiten, Adressen, Navigation, Zustand) – ohne GPS, ohne Kundendaten; fremde nie', async () => {
    const { cookieA, cookieB, apiA, driverA, tour, booking } = await activeToday();
    expect(
      (await sendLocation(apiA, tour.id, { latitude: 49.912345, longitude: 8.261234 })).status,
    ).toBe(204);
    const pkg = await offlinePackage(cookieA);
    expect(pkg.activeTour).not.toBeNull();
    const snapshot = pkg.activeTour!;
    expect(snapshot.tourId).toBe(tour.id);
    expect(snapshot.status).toBe('active');
    expect(snapshot.stops).toHaveLength(2);
    const [first, second] = snapshot.stops as {
      stopId: string;
      sequence: number;
      kind: string;
      processNumber: string;
      processId: string;
      startAt: string | null;
      addressLines: string[];
      navigation: { apple: string; android: string; web: string } | null;
      state: string;
    }[];
    expect(first!.stopId).toBe(tour.stops[0].id);
    expect([first!.sequence, second!.sequence]).toEqual([1, 2]);
    expect(first!.kind).toBe('delivery');
    expect(first!.processNumber).toMatch(/^MR-\d{4}-\d{4,}$/);
    expect(first!.processId).toBe(booking.processId);
    expect(first!.startAt).toBe(booking.outbound.startAt!.toISOString());
    expect(first!.addressLines).toEqual(['Lieferweg 12', '55129 Mainz']);
    expect(first!.navigation!.apple).toMatch(/^https:\/\/maps\.apple\.com\/\?daddr=/);
    expect(first!.navigation!.android).toMatch(/^geo:/);
    expect(first!.navigation!.web).toMatch(/^https:\/\/www\.google\.com\/maps\//);
    expect(first!.state).toBe('open');
    const text = JSON.stringify(snapshot);
    expect(text).not.toMatch(/latitude|longitude|liveLocation|49\.912345|8\.261234/);
    expect(text).not.toMatch(/Klara|Kommerz|0171|customer/);
    expect(text).not.toMatch(KEY_PATTERN);
    // Zustand folgt dem Termin: „Angekommen“ ⇒ arrived.
    expect(
      (await apiA('POST', `/staff/tours/${tour.id}/stops/${tour.stops[0].id}/arrived`)).status,
    ).toBe(200);
    const again = await offlinePackage(cookieA);
    expect(again.activeTour!.stops[0]!.state).toBe('arrived');
    expect(again.activeTour!.version).toBeGreaterThan(snapshot.version);
    // Fremder Fahrer: keine fremde Tour im Paket.
    const foreign = await offlinePackage(cookieB);
    expect(foreign.activeTour).toBeNull();
    void driverA;
  });

  it('T116. Offline-Mutationen der Tour sind serverseitig unmöglich: Sync kennt keine Tour-/GPS-Mutation; GPS nie nachsynchronisiert', async () => {
    const { cookieA, apiA, tour } = await activeToday();
    for (const type of ['tour.location', 'tour.start', 'tour.end', 'tour.takeover', 'tour.order']) {
      const response = await world.app.inject({
        method: 'POST',
        url: '/staff/offline/sync',
        headers: { cookie: cookieA },
        payload: {
          deviceId: DEVICE,
          environment: 'development',
          clientTime: new Date().toISOString(),
          mutation: {
            clientMutationId: randomUUID(),
            type,
            contextKind: 'booking',
            contextId: tour.id,
            createdAt: new Date().toISOString(),
            baseVersion: null,
            payload: { latitude: 49.9, longitude: 8.2, observedAt: new Date().toISOString() },
            media: [],
          },
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    }
    const live = await world.ctx.db
      .select()
      .from(tourLiveLocations)
      .where(eq(tourLiveLocations.tourId, tour.id));
    expect(live).toHaveLength(0);
    const view = await apiA('GET', `/staff/tours/${tour.id}`);
    expect(view.body.tour.version).toBe(tour.version);
    expect(view.body.tour.status).toBe('active');
    // Offline gesammelte Standorte (älter als 10 min) werden auch online nie übernommen.
    const replay = await sendLocation(apiA, tour.id, {
      latitude: 49.9,
      longitude: 8.2,
      observedAt: new Date(Date.now() - 15 * 60_000),
    });
    expect(replay.status).toBe(400);
  });
});

describe('Zusatz (§45/§64): GPS-Härtung', () => {
  it('Standort-Body > 512 Byte ⇒ abgelehnt; unbekannte Felder ⇒ 400; Rate-Limit greift nur für den Fahrer', async () => {
    const { apiA, apiB, cookieA, tour } = await activeToday();
    const big = await world.app.inject({
      method: 'POST',
      url: `/staff/tours/${tour.id}/location`,
      headers: { cookie: cookieA },
      payload: {
        latitude: 49.9,
        longitude: 8.2,
        observedAt: new Date().toISOString(),
        padding: 'x'.repeat(600),
      },
    });
    expect(big.statusCode).toBe(413);
    const extra = await apiA('POST', `/staff/tours/${tour.id}/location`, {
      latitude: 49.9,
      longitude: 8.2,
      observedAt: new Date().toISOString(),
      note: 'Kunde wartet',
    });
    expect(extra.status).toBe(400);
    expect(extra.body.error.code).toBe('VALIDATION_ERROR');
    // Fremder Fahrer: immer neutral 404, nie 429 (kein Oracle über die Tour).
    for (let i = 0; i < 3; i += 1) {
      expect((await sendLocation(apiB, tour.id, { latitude: 49.9, longitude: 8.2 })).status).toBe(
        404,
      );
    }
    expect((await sendLocation(apiA, tour.id, { latitude: 49.9, longitude: 8.2 })).status).toBe(
      204,
    );
    const limited = await sendLocation(apiA, tour.id, { latitude: 49.91, longitude: 8.21 });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('LOCATION_RATE_LIMITED');
    expect(JSON.stringify(limited.body)).not.toMatch(/49\.9|8\.2[01]/);
    await sleep(10);
  });
});
