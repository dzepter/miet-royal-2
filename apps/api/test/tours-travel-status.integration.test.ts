/**
 * Phase-13-Pflichttests 95–103: interner Status „Unterwegs“ je Buchung
 * (getCustomerTravelStatus) – erster Kundenstopp en_route, zweiter nicht,
 * nach Abschluss der nächste, storniert nicht, beendete Tour keiner,
 * Depot-/Selbstabholungsstopp nie, kein GPS/ETA/Fahrername.
 */
import { tourLiveLocations } from '@mietroyal/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getCustomerTravelStatus } from '../src/tours/travel-status.ts';
import { cancelBooking } from './cancellation-helpers.ts';
import {
  DRIVER_PERMISSIONS,
  adminSession,
  apiFor,
  berlinAt,
  bookingWithAppointments,
  completeAppointment,
  createToursWorld,
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
  const driver = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Fahrer');
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
  return {
    admin,
    api,
    driver: driver.user,
    driverApi: apiFor(world.app, driver.cookie),
    today,
    first,
    second,
  };
}

const status = (bookingId: string) => getCustomerTravelStatus(world.ctx.db, bookingId);

describe('95.–100. Unterwegs-Status', () => {
  it('T95./T96. Nur der NÄCHSTE offene Kundenstopp der aktiven Tour ist unterwegs – und erst nach dem Start', async () => {
    const { api, driverApi, driver, today, first, second } = await setup();
    const tour = await tourWithStops(api, {
      tourDate: today,
      assignedUserId: driver.id,
      appointmentIds: [first.outbound.id, second.outbound.id],
    });
    expect(await status(first.bookingId)).toEqual({ status: 'none' });
    const started = await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
    expect(started.body.started).toBe(true);
    expect(await status(first.bookingId)).toEqual({ status: 'en_route' });
    expect(await status(second.bookingId)).toEqual({ status: 'none' });
    // „Angekommen“ ändert nichts am Status (Stopp bleibt der nächste offene).
    const arrived = await driverApi(
      'POST',
      `/staff/tours/${tour.id}/stops/${tour.stops[0].id}/arrived`,
    );
    expect(arrived.status).toBe(200);
    expect(arrived.body.tour.stops[0].state).toBe('arrived');
    expect(await status(first.bookingId)).toEqual({ status: 'en_route' });
  });

  it('T97. Nach Abschluss des ersten Stopps ist der zweite unterwegs', async () => {
    const { api, driverApi, driver, today, first, second } = await setup();
    const tour = await tourWithStops(api, {
      tourDate: today,
      assignedUserId: driver.id,
      appointmentIds: [first.outbound.id, second.outbound.id],
    });
    await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
    await completeAppointment(world, driver.id, first.outbound.id);
    expect(await status(first.bookingId)).toEqual({ status: 'none' });
    expect(await status(second.bookingId)).toEqual({ status: 'en_route' });
  });

  it('T98. Stornierte Buchung ist nie unterwegs; der nächste offene Stopp rückt nach', async () => {
    const { admin, api, driverApi, driver, today, first, second } = await setup();
    const tour = await tourWithStops(api, {
      tourDate: today,
      assignedUserId: driver.id,
      appointmentIds: [first.outbound.id, second.outbound.id],
    });
    await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
    await cancelBooking(world.ctx, admin.id, first.processId);
    expect(await status(first.bookingId)).toEqual({ status: 'none' });
    expect(await status(second.bookingId)).toEqual({ status: 'en_route' });
  });

  it('T99. Beendete Tour ⇒ keine Buchung unterwegs', async () => {
    const { api, driverApi, driver, today, first, second } = await setup();
    const tour = await tourWithStops(api, {
      tourDate: today,
      assignedUserId: driver.id,
      appointmentIds: [first.outbound.id, second.outbound.id],
    });
    await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
    await completeAppointment(world, driver.id, first.outbound.id);
    expect(await status(second.bookingId)).toEqual({ status: 'en_route' });
    const ended = await api('POST', `/staff/tours/${tour.id}/end`, {
      force: true,
      reason: 'Fahrzeugpanne',
    });
    expect(ended.status).toBe(200);
    expect(await status(first.bookingId)).toEqual({ status: 'none' });
    expect(await status(second.bookingId)).toEqual({ status: 'none' });
  });

  it('T100. Depot-/Selbstabholungsstopp ohne Kundenfahrt ist nie unterwegs (Locationsemantik, nicht Name)', async () => {
    const { admin, api, driverApi, driver, today, second } = await setup();
    const pickup = await bookingWithAppointments(world, admin.id, {
      fulfillment: 'pickup',
      assignTo: driver.id,
      outboundStartAt: berlinAt(today, 22, 50),
    });
    expect(pickup.outbound.locationKind).toBe('base');
    const tour = await tourWithStops(api, {
      tourDate: today,
      assignedUserId: driver.id,
      appointmentIds: [pickup.outbound.id, second.outbound.id],
    });
    await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
    expect(await status(pickup.bookingId)).toEqual({ status: 'none' });
    // Der Kundenstopp dahinter ist (noch) nicht der nächste Stopp.
    expect(await status(second.bookingId)).toEqual({ status: 'none' });
    await completeAppointment(world, driver.id, pickup.outbound.id);
    expect(await status(second.bookingId)).toEqual({ status: 'en_route' });
  });
});

describe('101.–103. Datenminimierung', () => {
  it('T101./T102./T103. Ergebnis enthält nur den Status – kein GPS, keine ETA, kein Fahrername', async () => {
    const { api, driverApi, driver, today, first, second } = await setup();
    const tour = await tourWithStops(api, {
      tourDate: today,
      assignedUserId: driver.id,
      appointmentIds: [first.outbound.id, second.outbound.id],
    });
    await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
    await world.ctx.db.insert(tourLiveLocations).values({
      tourId: tour.id,
      userId: driver.id,
      latitude: 49.95,
      longitude: 8.27,
      observedAt: new Date(),
    });
    const result = await status(first.bookingId);
    expect(result).toEqual({ status: 'en_route' });
    expect(Object.keys(result)).toEqual(['status']);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/lat|lon|eta|arrival|driver|Fahrer|49\.95|8\.27/i);
  });
});
