/**
 * Phase 13 Final §7 (V1–V7): Vertretung + zwei aktive Touren derselben
 * effektiven Person. Kein Architekturumbau, aber nichts wird still verborgen:
 * `GET /staff/tours/active` liefert deterministisch die zuerst gestartete Tour
 * plus `conflict` mit allen betroffenen; jede betroffene Tour trägt die
 * View-Warnung MULTIPLE_ACTIVE_TOURS („Mehrere aktive Touren gleichzeitig –
 * Planung prüfen.“); beide bleiben einzeln erreichbar; GPS bleibt an die
 * konkrete tourId gebunden; der Tourstart verhindert weiterhin Doppelstarts;
 * keine Tour wird automatisch beendet oder übertragen; nach Vertretungsende
 * verschwindet der Konflikt. Phase 13 Corr (§2/§3): die zentrale Auflösung
 * `TourService.resolveActiveToursFor` kennt none | single | conflict; der
 * Offline-Snapshot enthält im Konfliktfall ALLE Touren (nie still die erste).
 */
import { tours } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDepotAddress, resolveOperativeAddress } from '../src/routing/address-resolver.ts';
import { createOfflineTourSnapshotSource } from '../src/tours/live/offline-snapshot.ts';
import { TourService } from '../src/tours/tour-service.ts';
import { substitutionServiceFor } from './scheduling-helpers.ts';
import {
  DRIVER_PERMISSIONS,
  NEAR_POINT,
  PLANNER_PERMISSIONS,
  adminSession,
  apiFor,
  bookingWithAppointments,
  configureFixedMatrix,
  createToursWorld,
  delayDeliveries,
  delayIncidents,
  destroyToursWorld,
  inMinutes,
  pinMorningClockIfEvening,
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
/** Phase 17 (§27 B): abends Testuhr auf 09:00 Berlin zurück – `inMinutes(+N)` bleibt am Tourtag. */
let restoreClock: () => void = () => {};
const CONFLICT_MESSAGE = 'Mehrere aktive Touren gleichzeitig – Planung prüfen.';

beforeAll(async () => {
  restoreClock = pinMorningClockIfEvening();
  world = await createToursWorld({ locationMinIntervalMs: 0 });
});
afterAll(async () => {
  await destroyToursWorld(world);
  restoreClock();
});
beforeEach(async () => {
  await resetToursWorld(world);
});

const codesOf = (tour: { warnings: { code: string }[] }) => tour.warnings.map((w) => w.code);

/**
 * Anton und Carl starten je ihre eigene Tour (Anton zuerst). Danach wird
 * NACHTRÄGLICH eine Vertretung Carl → Anton angelegt: Anton ist effektiv für
 * beide aktiven Touren zuständig.
 */
async function twoActiveTours(options: { substitute?: boolean } = {}) {
  const { admin, cookie } = await adminSession(world);
  const api = apiFor(world.app, cookie);
  const anton = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Anton');
  const carl = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Carl');
  const planner = await staffWith(world, admin.id, PLANNER_PERMISSIONS, 'Plan');
  const today = todayBerlin();
  const bookingA = await bookingWithAppointments(world, admin.id, {
    assignTo: anton.user.id,
    outboundStartAt: inMinutes(60),
    outboundEndAt: inMinutes(180),
    street: 'Ahornweg 1',
  });
  const bookingC = await bookingWithAppointments(world, admin.id, {
    assignTo: carl.user.id,
    outboundStartAt: inMinutes(90),
    outboundEndAt: inMinutes(200),
    street: 'Birkenstraße 2',
  });
  const tourA = await tourWithStops(api, {
    tourDate: today,
    assignedUserId: anton.user.id,
    appointmentIds: [bookingA.outbound.id],
  });
  const tourC = await tourWithStops(api, {
    tourDate: today,
    assignedUserId: carl.user.id,
    appointmentIds: [bookingC.outbound.id],
  });
  const antonApi = apiFor(world.app, anton.cookie);
  const carlApi = apiFor(world.app, carl.cookie);
  expect((await antonApi('POST', `/staff/tours/${tourA.id}/start`, {})).status).toBe(200);
  await sleep(20);
  expect((await carlApi('POST', `/staff/tours/${tourC.id}/start`, {})).status).toBe(200);
  await world.delayState.settle();
  let substitution = null;
  if (options.substitute !== false) {
    substitution = await substitutionServiceFor(world.ctx).create(admin.id, {
      originalUserId: carl.user.id,
      substituteUserId: anton.user.id,
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: new Date(Date.now() + 86_400_000),
    });
  }
  return {
    admin,
    api,
    today,
    anton: anton.user,
    carl: carl.user,
    antonApi,
    carlApi,
    plannerApi: apiFor(world.app, planner.cookie),
    tourA,
    tourC,
    substitution,
  };
}

function snapshotSource() {
  return createOfflineTourSnapshotSource({
    db: world.ctx.db,
    tours: new TourService(world.ctx.db),
    addresses: { resolveOperativeAddress, getDepotAddress },
    geocoding: world.geocoding,
  });
}

describe('V1–V3. Erkennung', () => {
  it('V1. Eine aktive effektive Tour ⇒ normal: tour gesetzt, conflict null, keine Warnung', async () => {
    const { antonApi, carlApi, tourA, tourC } = await twoActiveTours({ substitute: false });
    const active = await antonApi('GET', '/staff/tours/active');
    expect(active.status).toBe(200);
    expect(active.body.tour.id).toBe(tourA.id);
    expect(active.body.conflict).toBeNull();
    expect(codesOf(active.body.tour)).not.toContain('MULTIPLE_ACTIVE_TOURS');
    const carlActive = await carlApi('GET', '/staff/tours/active');
    expect(carlActive.body.tour.id).toBe(tourC.id);
    expect(carlActive.body.conflict).toBeNull();
    const resolved = await new TourService(world.ctx.db).resolveActiveToursFor(
      active.body.tour.assignedUserId,
    );
    expect(resolved.kind).toBe('single');
    expect(
      (
        await snapshotSource().activeTourSnapshotsFor(
          active.body.tour.assignedUserId,
          new Set(['calendar.view']),
          new Date(),
        )
      ).map((snapshot) => snapshot.tourId),
    ).toEqual([tourA.id]);
  });

  it('V2. Zwei aktive Touren durch NACHTRÄGLICHE Vertretung ⇒ Konflikt erkannt: tour = zuerst gestartete, conflict nennt beide; nichts beendet/übertragen', async () => {
    const { anton, antonApi, carl, carlApi, tourA, tourC } = await twoActiveTours();
    const active = await antonApi('GET', '/staff/tours/active');
    expect(active.status).toBe(200);
    expect(active.body.tour.id).toBe(tourA.id);
    expect(active.body.conflict).not.toBeNull();
    expect(active.body.conflict.tours.map((t: { id: string }) => t.id)).toEqual([
      tourA.id,
      tourC.id,
    ]);
    expect(active.body.conflict.tours[1]).toMatchObject({
      id: tourC.id,
      assignedUserId: carl.id,
      effectiveDriverId: anton.id,
      substituted: true,
    });
    expect(typeof active.body.conflict.tours[0].startedAt).toBe('string');
    expect(new Date(active.body.conflict.tours[0].startedAt).getTime()).toBeLessThanOrEqual(
      new Date(active.body.conflict.tours[1].startedAt).getTime(),
    );
    // Deterministisch: wiederholte Abfrage liefert dieselbe Reihenfolge; die zentrale
    // Auflösung meldet den Konflikt explizit; der Offline-Snapshot enthält BEIDE Touren
    // in derselben Reihenfolge (Phase 13 Corr §3 – keine still gewählte „erste“ Tour).
    expect((await antonApi('GET', '/staff/tours/active')).body.tour.id).toBe(tourA.id);
    const resolved = await new TourService(world.ctx.db).resolveActiveToursFor(anton.id);
    expect(resolved.kind).toBe('conflict');
    expect(resolved.kind === 'conflict' ? resolved.tours.map((t) => t.tour.id) : []).toEqual([
      tourA.id,
      tourC.id,
    ]);
    expect(
      (
        await snapshotSource().activeTourSnapshotsFor(
          anton.id,
          new Set(['calendar.view']),
          new Date(),
        )
      ).map((snapshot) => snapshot.tourId),
    ).toEqual([tourA.id, tourC.id]);
    // Keine automatische Beendigung/Übertragung.
    const rows = await world.ctx.db.select().from(tours).where(eq(tours.status, 'active'));
    expect(rows.map((row) => row.id).sort()).toEqual([tourA.id, tourC.id].sort());
    expect(rows.find((row) => row.id === tourC.id)!.assignedUserId).toBe(carl.id);
    // Carl (gespeicherter Fahrer, vertreten) sieht weiterhin seine Tour – ohne Konflikt.
    const carlActive = await carlApi('GET', '/staff/tours/active');
    expect(carlActive.body.tour.id).toBe(tourC.id);
    expect(carlActive.body.conflict).toBeNull();
  });

  it('V3. Keine Tour still versteckt: Warnung MULTIPLE_ACTIVE_TOURS in JEDER betroffenen Tour (Fahrer-, Einzel- und Planer-Sicht /touren)', async () => {
    const { antonApi, plannerApi, tourA, tourC, today } = await twoActiveTours();
    const active = await antonApi('GET', '/staff/tours/active');
    expect(active.body.tour.warnings).toContainEqual({
      code: 'MULTIPLE_ACTIVE_TOURS',
      message: CONFLICT_MESSAGE,
    });
    for (const id of [tourA.id, tourC.id]) {
      const single = await antonApi('GET', `/staff/tours/${id}`);
      expect(single.status).toBe(200);
      expect(codesOf(single.body.tour)).toContain('MULTIPLE_ACTIVE_TOURS');
    }
    const list = await plannerApi('GET', `/staff/tours?date=${today}`);
    expect(list.status).toBe(200);
    const byId = new Map(
      (list.body.tours as { id: string; warnings: { code: string }[] }[]).map((t) => [t.id, t]),
    );
    expect(codesOf(byId.get(tourA.id)!)).toContain('MULTIPLE_ACTIVE_TOURS');
    expect(codesOf(byId.get(tourC.id)!)).toContain('MULTIPLE_ACTIVE_TOURS');
    // Die Planer-Liste des Tages enthält genau die beiden betroffenen Touren.
    expect([...byId.keys()].sort()).toEqual([tourA.id, tourC.id].sort());
  });
});

describe('V4–V7. Erreichbarkeit, GPS-Bindung, Doppelstart, Vertretungsende', () => {
  it('V4. Beide Touren sind für die effektive Person einzeln erreichbar (View, Prognose, Angekommen-Rechte)', async () => {
    const { antonApi, tourA, tourC } = await twoActiveTours();
    for (const id of [tourA.id, tourC.id]) {
      const view = await antonApi('GET', `/staff/tours/${id}`);
      expect(view.status).toBe(200);
      expect(view.body.tour.status).toBe('active');
      expect(view.body.tour.canEnd).toBe(true);
      expect((await antonApi('GET', `/staff/tours/${id}/delay`)).status).toBe(200);
    }
    expect(
      (await antonApi('GET', `/staff/tours/${tourC.id}`)).body.tour.effectiveDriverId,
    ).not.toBeNull();
  });

  it('V5. GPS-Update betrifft immer die konkrete tourId: eigene Zeile je Tour, nie Übertrag; vertretener Fahrer neutral 404', async () => {
    const { antonApi, carlApi, tourA, tourC } = await twoActiveTours();
    expect(
      (
        await sendLocation(antonApi, tourC.id, {
          latitude: 49.95,
          longitude: 8.27,
          accuracyMeters: 20,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await sendLocation(antonApi, tourA.id, {
          latitude: 49.96,
          longitude: 8.28,
          accuracyMeters: 20,
        })
      ).status,
    ).toBe(204);
    await world.delayState.settle();
    const rows = (
      await world.ctx.pool.query(
        'SELECT tour_id, latitude FROM tour_live_locations ORDER BY tour_id',
      )
    ).rows as { tour_id: string; latitude: number }[];
    expect(rows).toHaveLength(2);
    expect(Number(rows.find((row) => row.tour_id === tourC.id)!.latitude)).toBe(49.95);
    expect(Number(rows.find((row) => row.tour_id === tourA.id)!.latitude)).toBe(49.96);
    // Carl ist vertreten ⇒ nicht mehr effektiver Fahrer seiner Tour (Fix N1).
    expect(
      (
        await sendLocation(carlApi, tourC.id, {
          latitude: 49.9,
          longitude: 8.2,
          accuracyMeters: 20,
        })
      ).status,
    ).toBe(404);
  });

  it('V6. Tourstart verhindert weiterhin den Doppelstart derselben effektiven Person (eigene und vertretene Tour)', async () => {
    const { admin, api, anton, carl, antonApi, today } = await twoActiveTours();
    const third = await bookingWithAppointments(world, admin.id, {
      assignTo: anton.id,
      outboundStartAt: inMinutes(120),
      street: 'Cedernweg 3',
    });
    const tourThird = await tourWithStops(api, {
      tourDate: today,
      assignedUserId: anton.id,
      appointmentIds: [third.outbound.id],
    });
    const blocked = await antonApi('POST', `/staff/tours/${tourThird.id}/start`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('TOUR_DRIVER_ALREADY_ACTIVE');
    const fourth = await bookingWithAppointments(world, admin.id, {
      assignTo: carl.id,
      outboundStartAt: inMinutes(150),
      street: 'Dornweg 4',
    });
    const tourFourth = await tourWithStops(api, {
      tourDate: today,
      assignedUserId: carl.id,
      appointmentIds: [fourth.outbound.id],
    });
    const blockedToo = await api('POST', `/staff/tours/${tourFourth.id}/start`, {});
    expect(blockedToo.status).toBe(409);
    expect(blockedToo.body.error.code).toBe('TOUR_DRIVER_ALREADY_ACTIVE');
    const active = await world.ctx.db.select().from(tours).where(eq(tours.status, 'active'));
    expect(active).toHaveLength(2);
  });

  it('V7. Konflikt verschwindet nach Vertretungsende: conflict null, keine Warnung mehr, jeder sieht wieder seine Tour', async () => {
    const { antonApi, carlApi, tourA, tourC, substitution } = await twoActiveTours();
    expect((await antonApi('GET', '/staff/tours/active')).body.conflict).not.toBeNull();
    await substitutionServiceFor(world.ctx).endEarly(substitution!.id);
    const active = await antonApi('GET', '/staff/tours/active');
    expect(active.body.tour.id).toBe(tourA.id);
    expect(active.body.conflict).toBeNull();
    expect(codesOf(active.body.tour)).not.toContain('MULTIPLE_ACTIVE_TOURS');
    const carlActive = await carlApi('GET', '/staff/tours/active');
    expect(carlActive.body.tour.id).toBe(tourC.id);
    expect(carlActive.body.conflict).toBeNull();
    expect(codesOf(carlActive.body.tour)).not.toContain('MULTIPLE_ACTIVE_TOURS');
    // Anton sieht Carls Tour nicht mehr (nur calendar.view).
    expect((await antonApi('GET', `/staff/tours/${tourC.id}`)).status).toBe(404);
  });
});

describe('RF3. Verspätungs-Push bei mehreren aktiven Touren', () => {
  it('RF3. Incident in der ZWEITEN aktiven Tour der effektiven Person ⇒ Fahrer-Push verlinkt auf genau diese Tour (/touren/aktiv?id=…), Planung auf /touren/<id>', async () => {
    const { admin, anton, antonApi, tourA, tourC } = await twoActiveTours();
    // Anton ist effektiv (Vertretung) für Carls Tour C unterwegs – Standort an Tour C.
    await setLiveLocation(world, tourC.id, anton.id, NEAR_POINT);
    // Fahrzeit 240 min > Fensterende (+200 min) ⇒ Risk in Tour C.
    configureFixedMatrix(world, [14_400]);
    expect((await world.live.delay.evaluate(tourC.id, 'manual')).status).toBe('risk');
    const [incident] = await delayIncidents(world, tourC.id);
    expect(incident).toBeDefined();
    const deliveries = await delayDeliveries(world);
    const antonPush = deliveries.find((row) => row.userId === anton.id);
    expect(antonPush).toBeDefined();
    expect((antonPush!.payload as { url: string }).url).toBe(`/touren/aktiv?id=${tourC.id}`);
    expect((antonPush!.payload as { tag: string }).tag).toBe(`tour-delay:${incident!.id}`);
    const adminPush = deliveries.find((row) => row.userId === admin.id);
    expect(adminPush).toBeDefined();
    expect((adminPush!.payload as { url: string }).url).toBe(`/touren/${tourC.id}`);
    // Ohne Tour-ID zeigt /active die erste Tour in deterministischer Reihenfolge (A) PLUS
    // den Konflikt – deshalb verlinkt der Push die konkrete Tour C.
    const active = await antonApi('GET', '/staff/tours/active');
    expect(active.body.tour.id).toBe(tourA.id);
    expect(active.body.conflict).not.toBeNull();
    expect(await delayIncidents(world, tourA.id)).toHaveLength(0);
  });
});
