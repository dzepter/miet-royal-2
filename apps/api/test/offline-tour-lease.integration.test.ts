/**
 * Phase 13 Final §4 (Tests O1–O10): Offline-Lease für den reinen Tourfahrer.
 * `calendar.view` ist lease-aktivierend; das Paket enthält für ein Konto nur
 * mit `calendar.view` ausschließlich den read-only Snapshot der eigenen bzw.
 * effektiven (Vertretung) aktiven Tour – keinen Maschinenstamm, keine
 * fremden Vorgänge, keine Handover-/Return-/Lager-/Admin-/Finanzdaten, kein
 * GPS. Tour-Mutationen existieren offline nicht.
 *
 * O9 (Phase-8-Lease-Tests) und O10 (Handover-/Return-Offline-Flows) sind die
 * unveränderten Bestandsdateien `offline-core`, `offline-hardening` und
 * `offline-idempotency` (*.integration.test.ts), die nach dieser Änderung
 * erneut ausgeführt werden.
 */
import { randomUUID } from 'node:crypto';
import { machines, offlineAccessLeases, tourLiveLocations } from '@mietroyal/database';
import { MUTATION_PERMISSIONS, OFFLINE_MUTATION_TYPES } from '@mietroyal/offline/shared';
import type { PermissionKey } from '@mietroyal/permissions';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OFFLINE_ENABLING_PERMISSIONS,
  OFFLINE_RELEVANT_PERMISSIONS,
} from '../src/offline/lease-service.ts';
import { substitutionServiceFor } from './scheduling-helpers.ts';
import {
  DRIVER_PERMISSIONS,
  adminSession,
  apiFor,
  berlinAt,
  bookingWithAppointments,
  createToursWorld,
  destroyToursWorld,
  resetToursWorld,
  sendLocation,
  staffWith,
  todayBerlin,
  tourWithStops,
  type BookingWithAppointments,
  type ToursWorld,
} from './tours-helpers.ts';

let world: ToursWorld;
const DEVICE = '0f6a9d2e-1b3c-4d5e-8f70-1234567890ab';
const DEVICE_B = '9f6a9d2e-1b3c-4d5e-8f70-1234567890cd';
const ENVIRONMENT = 'development';

/** Admin-/Finanz-/Systemrechte, die nie in ein Lease gehören (O6). */
const ADMIN_FINANCE_PERMISSIONS: readonly PermissionKey[] = [
  'employee.manage',
  'permission.manage',
  'system.settings',
  'settlement.view',
  'settlement.release',
  'accounting.view_reference',
];

/** Phase-8-Rechte, die ein Paket mit Vorgängen/Maschinen/Lager befüllen würden. */
const PHASE8_DATA_PERMISSIONS: readonly PermissionKey[] = [
  'process.view_all',
  'handover.view',
  'return.view',
  'machine.view',
  'inventory.view',
];

beforeAll(async () => {
  world = await createToursWorld();
});
afterAll(async () => {
  await destroyToursWorld(world);
});
beforeEach(async () => {
  await resetToursWorld(world);
  await world.ctx.pool.query('TRUNCATE offline_mutation_receipts, offline_access_leases CASCADE');
});

async function lease(cookie: string, deviceId = DEVICE) {
  return world.app.inject({
    method: 'POST',
    url: '/staff/offline/lease',
    headers: { cookie },
    payload: { deviceId, environment: ENVIRONMENT },
  });
}

interface PackageJson {
  permissions: string[];
  bookings: unknown[];
  machines: unknown[];
  inventory: unknown[] | null;
  documents: unknown[];
  activeTour: {
    tourId: string;
    tourDate: string;
    status: string;
    version: number;
    snapshotAt: string;
    stops: {
      stopId: string;
      appointmentId: string;
      sequence: number;
      kind: string;
      processNumber: string;
      processId: string;
      bookingId: string;
      startAt: string | null;
      endAt: string | null;
      addressLines: string[];
      navigation: { apple: string; android: string; web: string } | null;
      state: string;
    }[];
  } | null;
}

async function pkg(cookie: string, extra: Record<string, unknown> = {}, deviceId = DEVICE) {
  return world.app.inject({
    method: 'POST',
    url: '/staff/offline/package',
    headers: { cookie },
    payload: { deviceId, environment: ENVIRONMENT, includeDocuments: true, ...extra },
  });
}

/** Lease + Paket für ein Konto (beides muss gelingen). */
async function packageFor(cookie: string, extra: Record<string, unknown> = {}, deviceId = DEVICE) {
  expect((await lease(cookie, deviceId)).statusCode).toBe(200);
  const response = await pkg(cookie, extra, deviceId);
  expect(response.statusCode).toBe(200);
  return response.json() as PackageJson;
}

/**
 * Reiner Tourfahrer (nur calendar.view) mit eigener, von ihm gestarteter
 * aktiver Tour (zwei Lieferstopps heute, Adressen Lieferweg 12 / Birkenstraße 2)
 * plus ein fremder reiner Tourfahrer ohne Tour.
 */
async function activeTourWorld() {
  const { admin, cookie } = await adminSession(world);
  const api = apiFor(world.app, cookie);
  const driver = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Fahrer');
  const other = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Fremd');
  const today = todayBerlin();
  const booking = await bookingWithAppointments(world, admin.id, {
    assignTo: driver.user.id,
    outboundStartAt: berlinAt(today, 23, 30),
  });
  const second = await bookingWithAppointments(world, admin.id, {
    assignTo: driver.user.id,
    outboundStartAt: berlinAt(today, 23, 45),
    street: 'Birkenstraße 2',
  });
  const planned = await tourWithStops(api, {
    tourDate: today,
    assignedUserId: driver.user.id,
    appointmentIds: [booking.outbound.id, second.outbound.id],
  });
  const driverApi = apiFor(world.app, driver.cookie);
  const started = await driverApi('POST', `/staff/tours/${planned.id}/start`, {});
  expect(started.status).toBe(200);
  expect(started.body.started).toBe(true);
  return {
    admin,
    api,
    today,
    driver,
    driverApi,
    other,
    otherApi: apiFor(world.app, other.cookie),
    tour: started.body.tour as { id: string; version: number; stops: { id: string }[] },
    booking,
    second,
  };
}

function expectOnlyTourSnapshot(
  packageJson: PackageJson,
  tourId: string,
  bookings: readonly BookingWithAppointments[],
): void {
  expect(packageJson.permissions).toEqual(['calendar.view']);
  expect(packageJson.bookings).toEqual([]);
  expect(packageJson.machines).toEqual([]);
  expect(packageJson.inventory).toBeNull();
  expect(packageJson.documents).toEqual([]);
  expect(packageJson.activeTour).not.toBeNull();
  expect(packageJson.activeTour!.tourId).toBe(tourId);
  const text = JSON.stringify(packageJson);
  // Keine Phase-8-Sichten, keine Kunden-/Kontakt-/Finanzdaten, kein Maschinenstamm.
  expect(text).not.toMatch(
    /qrHash|machineCode|handover|returnSeed|returnStartable|existingDamages|candidateMachines|deliveryNote|customer|phone|email|Cents|invoice|settlement|voucher/i,
  );
  expect(text).not.toMatch(/Klara|Kommerz|0171/);
  for (const booking of bookings) {
    // Der Vorgang selbst (Kunde, Übergabe, Rückgabe) liegt nicht im Paket – nur Tour-Stopp-Referenzen.
    expect(text).not.toContain(booking.customerId);
  }
}

describe('Phase 13 Final §4: Offline-Lease für reine Tourfahrer (O1–O8)', () => {
  it('O1. Ein Konto nur mit calendar.view erhält ein Lease (Rechte-Snapshot = [calendar.view]); ohne operatives Recht weiterhin 403', async () => {
    expect(OFFLINE_ENABLING_PERMISSIONS).toContain('calendar.view');
    const { admin } = await adminSession(world);
    const driver = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Fahrer');
    const office = await staffWith(world, admin.id, ['process.view_all', 'offer.view'], 'Buero');

    const denied = await lease(office.cookie);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('FORBIDDEN');
    expect(await world.ctx.db.select().from(offlineAccessLeases)).toHaveLength(0);

    const granted = await lease(driver.cookie);
    expect(granted.statusCode).toBe(200);
    const grant = granted.json() as {
      leaseId: string;
      userId: string;
      deviceId: string;
      environment: string;
      leaseSecret: string;
      permissions: string[];
      claim: string;
      signature: string;
    };
    expect(grant.userId).toBe(driver.user.id);
    expect(grant.deviceId).toBe(DEVICE);
    expect(grant.environment).toBe(ENVIRONMENT);
    expect(grant.leaseSecret.length).toBeGreaterThan(30);
    expect(grant.claim).toBeTypeOf('string');
    expect(grant.signature).toBeTypeOf('string');
    expect(grant.permissions).toEqual(['calendar.view']);
    const rows = await world.ctx.db.select().from(offlineAccessLeases);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.staffUserId).toBe(driver.user.id);
    // Ohne aktive Tour: Paket ist leer bis auf den (leeren) Tour-Abschnitt.
    const empty = await pkg(driver.cookie);
    expect(empty.statusCode).toBe(200);
    const json = empty.json() as PackageJson;
    expect(json.activeTour).toBeNull();
    expect(json.bookings).toEqual([]);
    expect(json.machines).toEqual([]);
    expect(json.inventory).toBeNull();
    expect(json.documents).toEqual([]);
  });

  it('O2. Die eigene aktive Tour liegt als read-only Snapshot im Paket (Reihenfolge, Terminart, Vorgangsnummer, Adresse, Zeiten, Navigation, Zustand)', async () => {
    const { driver, driverApi, tour, booking, second } = await activeTourWorld();
    const packageJson = await packageFor(driver.cookie);
    expectOnlyTourSnapshot(packageJson, tour.id, [booking, second]);
    const snapshot = packageJson.activeTour!;
    expect(snapshot.status).toBe('active');
    expect(snapshot.tourDate).toBe(todayBerlin());
    expect(snapshot.version).toBe(tour.version);
    expect(snapshot.stops).toHaveLength(2);
    const [first, next] = snapshot.stops;
    expect(first!.stopId).toBe(tour.stops[0]!.id);
    expect([first!.sequence, next!.sequence]).toEqual([1, 2]);
    expect(first!.kind).toBe('delivery');
    expect(first!.processNumber).toMatch(/^MR-\d{4}-\d{4,}$/);
    expect(first!.processId).toBe(booking.processId);
    expect(first!.appointmentId).toBe(booking.outbound.id);
    expect(first!.startAt).toBe(booking.outbound.startAt!.toISOString());
    expect(first!.addressLines).toEqual(['Lieferweg 12', '55129 Mainz']);
    expect(next!.addressLines).toEqual(['Birkenstraße 2', '55128 Mainz']);
    expect(first!.navigation!.apple).toMatch(/^https:\/\/maps\.apple\.com\/\?daddr=/);
    expect(first!.navigation!.android).toMatch(/^geo:/);
    expect(first!.navigation!.web).toMatch(/^https:\/\/www\.google\.com\/maps\//);
    expect(first!.state).toBe('open');
    // Zustand folgt der Online-Aktion „Angekommen“ – nur online, danach neuer Snapshot.
    expect(
      (await driverApi('POST', `/staff/tours/${tour.id}/stops/${tour.stops[0]!.id}/arrived`))
        .status,
    ).toBe(200);
    const again = await packageFor(driver.cookie);
    expect(again.activeTour!.stops[0]!.state).toBe('arrived');
    expect(again.activeTour!.version).toBeGreaterThan(snapshot.version);
  });

  it('O3. Die effektive Vertretung (nur calendar.view) erhält Lease und Tour-Snapshot; nach Vertretungsende nicht mehr', async () => {
    const { admin, api, today } = await (async () => {
      const { admin, cookie } = await adminSession(world);
      return { admin, api: apiFor(world.app, cookie), today: todayBerlin() };
    })();
    const driver = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Fahrer');
    const substitute = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Vertretung');
    const substitution = await substitutionServiceFor(world.ctx).create(admin.id, {
      originalUserId: driver.user.id,
      substituteUserId: substitute.user.id,
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: new Date(Date.now() + 24 * 3_600_000),
    });
    const booking = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.user.id,
      outboundStartAt: berlinAt(today, 23, 30),
    });
    const planned = await tourWithStops(api, {
      tourDate: today,
      assignedUserId: driver.user.id,
      appointmentIds: [booking.outbound.id],
    });
    // Die Vertretung ist effektiver Fahrer und startet die Tour selbst (nur calendar.view).
    const subApi = apiFor(world.app, substitute.cookie);
    const started = await subApi('POST', `/staff/tours/${planned.id}/start`, {});
    expect(started.status).toBe(200);

    const subPackage = await packageFor(substitute.cookie, {}, DEVICE_B);
    expectOnlyTourSnapshot(subPackage, planned.id, [booking]);
    expect(subPackage.activeTour!.stops[0]!.processId).toBe(booking.processId);
    // Der gespeicherte Fahrer sieht seine Tour ebenfalls (Zuständigkeit bleibt bei ihm).
    const driverPackage = await packageFor(driver.cookie);
    expect(driverPackage.activeTour!.tourId).toBe(planned.id);

    await substitutionServiceFor(world.ctx).endEarly(substitution.id);
    const afterEnd = await pkg(substitute.cookie, {}, DEVICE_B);
    expect(afterEnd.statusCode).toBe(200);
    expect((afterEnd.json() as PackageJson).activeTour).toBeNull();
  });

  it('O4. Eine fremde aktive Tour fehlt im Paket – auch über extraBookingIds oder den Einzel-Snapshot (neutral 404)', async () => {
    const { other, tour, booking, second } = await activeTourWorld();
    const foreign = await packageFor(other.cookie, {
      extraBookingIds: [booking.bookingId, second.bookingId],
    });
    expect(foreign.activeTour).toBeNull();
    expect(foreign.bookings).toEqual([]);
    expect(foreign.permissions).toEqual(['calendar.view']);
    const text = JSON.stringify(foreign);
    expect(text).not.toContain(tour.id);
    expect(text).not.toContain(booking.processId);
    expect(text).not.toContain(booking.bookingId);
    const single = await world.app.inject({
      method: 'GET',
      url: `/staff/offline/bookings/${booking.bookingId}`,
      headers: { cookie: other.cookie },
    });
    expect(single.statusCode).toBe(404);
    expect(single.json().error.code).toBe('NOT_FOUND');
    // Unbekannte ID verhält sich identisch (kein Existenz-Orakel).
    const unknown = await world.app.inject({
      method: 'GET',
      url: `/staff/offline/bookings/${randomUUID()}`,
      headers: { cookie: other.cookie },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('O5. Nur calendar.view ⇒ keine Maschinen-, Handover-, Return-, Lager- oder Dokumentdaten – auch nicht für die eigenen Tour-Vorgänge', async () => {
    const { admin, driver, tour, booking, second } = await activeTourWorld();
    // Es gibt Maschinen im Bestand (Buchungen belegen welche) – sie dürfen nicht ins Paket.
    expect((await world.ctx.db.select().from(machines)).length).toBeGreaterThan(0);
    const packageJson = await packageFor(driver.cookie, {
      extraBookingIds: [booking.bookingId, second.bookingId],
      includeDocuments: true,
    });
    expectOnlyTourSnapshot(packageJson, tour.id, [booking, second]);
    // Der Einzel-Snapshot des EIGENEN Tour-Vorgangs ist ohne Vorgangssicht ebenfalls nicht abrufbar.
    const single = await world.app.inject({
      method: 'GET',
      url: `/staff/offline/bookings/${booking.bookingId}`,
      headers: { cookie: driver.cookie },
    });
    expect(single.statusCode).toBe(404);
    // Gegenprobe: mit Phase-8-Rechten füllen sich die Abschnitte wie bisher (Phase-8-Logik unverändert).
    const operative = await staffWith(
      world,
      admin.id,
      [...DRIVER_PERMISSIONS, ...PHASE8_DATA_PERMISSIONS],
      'Lager',
    );
    const full = await packageFor(
      operative.cookie,
      { extraBookingIds: [booking.bookingId] },
      DEVICE_B,
    );
    expect(full.machines.length).toBeGreaterThan(0);
    expect(full.inventory).not.toBeNull();
    expect(full.bookings.length).toBeGreaterThan(0);
    expect(full.activeTour).toBeNull();
    expect(full.permissions).toEqual(
      [...DRIVER_PERMISSIONS, ...PHASE8_DATA_PERMISSIONS].map(String).sort(),
    );
  });

  it('O6. Admin-/Finanz-/Systemrechte stehen nie im Lease oder Paket – auch wenn das Konto sie online besitzt', async () => {
    for (const key of ADMIN_FINANCE_PERMISSIONS) {
      expect(OFFLINE_RELEVANT_PERMISSIONS).not.toContain(key);
      expect(OFFLINE_ENABLING_PERMISSIONS).not.toContain(key);
    }
    const { admin } = await adminSession(world);
    const privileged = await staffWith(
      world,
      admin.id,
      [...DRIVER_PERMISSIONS, ...ADMIN_FINANCE_PERMISSIONS],
      'Leitung',
    );
    const granted = await lease(privileged.cookie);
    expect(granted.statusCode).toBe(200);
    expect((granted.json() as { permissions: string[] }).permissions).toEqual(['calendar.view']);
    const packageJson = (await pkg(privileged.cookie)).json() as PackageJson;
    expect(packageJson.permissions).toEqual(['calendar.view']);
    const text = JSON.stringify(packageJson);
    for (const key of ADMIN_FINANCE_PERMISSIONS) expect(text).not.toContain(key);
  });

  it('O7. Keine Tour-Mutation in OFFLINE_MUTATION_TYPES; jede Mutation verlangt ein Phase-8-Recht; Sync eines calendar.view-Kontos wird abgelehnt', async () => {
    for (const type of OFFLINE_MUTATION_TYPES) {
      expect(type).not.toMatch(/^tour\./);
      expect(type).not.toMatch(/location|gps|arrive|takeover/i);
      const required = MUTATION_PERMISSIONS[type];
      expect(required.length).toBeGreaterThan(0);
      expect(
        required.some(
          (key) => key === 'handover.view' || key === 'return.view' || key === 'machine.view',
        ),
        `${type} muss ein Phase-8-Recht verlangen`,
      ).toBe(true);
      expect(required).not.toEqual(['calendar.view']);
    }
    const { driver, tour, booking } = await activeTourWorld();
    expect((await lease(driver.cookie)).statusCode).toBe(200);
    const syncWith = (type: string, contextId: string, payload: unknown, base: unknown) =>
      world.app.inject({
        method: 'POST',
        url: '/staff/offline/sync',
        headers: { cookie: driver.cookie },
        payload: {
          deviceId: DEVICE,
          environment: ENVIRONMENT,
          clientTime: new Date().toISOString(),
          mutation: {
            clientMutationId: randomUUID(),
            type,
            contextKind: 'booking',
            contextId,
            createdAt: new Date().toISOString(),
            baseVersion: base === null ? null : JSON.stringify(base),
            payload,
            media: [],
          },
        },
      });
    // Unbekannte Tour-Mutationen scheitern bereits am Schema (400), nie an Fachlogik.
    for (const type of [
      'tour.create',
      'tour.stop_add',
      'tour.order',
      'tour.start',
      'tour.takeover',
      'tour.arrived',
      'tour.end',
      'tour.location',
    ]) {
      const response = await syncWith(
        type,
        tour.id,
        { latitude: 49.9, longitude: 8.2, observedAt: new Date().toISOString() },
        null,
      );
      expect(response.statusCode, type).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    }
    // Eine bestehende Phase-8-Mutation lehnt der Server für ein calendar.view-Konto fachlich ab.
    const rejected = await syncWith(
      'return.returner',
      booking.bookingId,
      { kind: 'customer', firstName: null, lastName: null, phone: null },
      { processStatus: 'open', appointmentId: null, appointmentVersion: null },
    );
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().status).toBe('rejected');
    expect(rejected.json().code).toBe('PERMISSION_REVOKED');
    // Tour unverändert, kein Standort entstanden.
    const view = await apiFor(world.app, driver.cookie)('GET', `/staff/tours/${tour.id}`);
    expect(view.status).toBe(200);
    expect(view.body.tour.version).toBe(tour.version);
    expect(
      await world.ctx.db
        .select()
        .from(tourLiveLocations)
        .where(eq(tourLiveLocations.tourId, tour.id)),
    ).toHaveLength(0);
  });

  it('O8. GPS (Live-Standort) liegt nie im Paket – weder Koordinaten noch Zeitpunkt noch Genauigkeit', async () => {
    const { driver, driverApi, tour, booking, second } = await activeTourWorld();
    const observedAt = new Date();
    expect(
      (
        await sendLocation(driverApi, tour.id, {
          latitude: 49.912345,
          longitude: 8.261234,
          accuracyMeters: 17,
          observedAt,
        })
      ).status,
    ).toBe(204);
    const live = await world.ctx.db
      .select()
      .from(tourLiveLocations)
      .where(eq(tourLiveLocations.tourId, tour.id));
    expect(live).toHaveLength(1);
    const packageJson = await packageFor(driver.cookie);
    expectOnlyTourSnapshot(packageJson, tour.id, [booking, second]);
    const text = JSON.stringify(packageJson);
    expect(text).not.toMatch(/latitude|longitude|liveLocation|accuracy|observedAt|receivedAt/i);
    expect(text).not.toContain('49.912345');
    expect(text).not.toContain('8.261234');
    expect(text).not.toContain(observedAt.toISOString());
    // Jeder Stopp kennt nur Ziel-Navigation und Adresse, nie die Fahrerposition.
    for (const stop of packageJson.activeTour!.stops) {
      expect(Object.keys(stop).sort()).toEqual(
        [
          'stopId',
          'appointmentId',
          'sequence',
          'kind',
          'processNumber',
          'processId',
          'bookingId',
          'startAt',
          'endAt',
          'addressLines',
          'navigation',
          'state',
        ].sort(),
      );
    }
    expect(Object.keys(packageJson.activeTour!).sort()).toEqual(
      ['tourId', 'tourDate', 'status', 'version', 'snapshotAt', 'stops'].sort(),
    );
  });
});
