/**
 * Phase 13 Final §3 (A1–A10): GPS-Genauigkeit der Verspätungsprognose.
 * Bewertet wird NUR bei accuracyMeters !== null und ≤ DELAY_LOCATION_MAX_ACCURACY_METERS
 * (250 m, zentral in packages/domain); sonst `unavailable` mit Grund
 * LOCATION_INACCURATE – kein Incident, keine Entwarnung, kein Push. Der
 * Standort selbst wird weiterhin (ohne Historie) gespeichert; ein späterer
 * genauer Standort wird normal bewertet. Keine Koordinaten/Genauigkeit in Logs.
 */
import { DELAY_LOCATION_MAX_ACCURACY_METERS } from '@mietroyal/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DELAY_LOCATION_MAX_ACCURACY_METERS as SERVICE_LIMIT } from '../src/tours/live/delay-risk-service.ts';
import { drainJobs } from './communication-helpers.ts';
import {
  DRIVER_POINT,
  NEAR_POINT,
  configureFixedMatrix,
  createToursWorld,
  delayDeliveries,
  delayIncidents,
  destroyToursWorld,
  inMinutes,
  resetToursWorld,
  sendLocation,
  setLiveLocation,
  sleep,
  startActiveTour,
  subscribePush,
  type ToursWorld,
} from './tours-helpers.ts';

let world: ToursWorld;

beforeAll(async () => {
  world = await createToursWorld({ locationMinIntervalMs: 0, captureLog: true });
});
afterAll(async () => {
  await destroyToursWorld(world);
});
beforeEach(async () => {
  await resetToursWorld(world);
});

const TIGHT_STOP = () => [
  { startAt: inMinutes(-10), endAt: inMinutes(20), street: 'Lieferweg 12' },
];
const matrixCalls = () => world.routing.calls.filter((c) => c.method === 'matrix').length;

/** Tour mit Live-Standort gegebener Genauigkeit, weit weg, knappe Deadline, Fahrzeit 2 h. */
async function tourWithAccuracy(accuracyMeters: number | null) {
  const fixture = await startActiveTour(world, TIGHT_STOP(), { accuracyMeters });
  configureFixedMatrix(world, [7200]);
  return fixture;
}

async function expectInaccurate(
  tourId: string,
  driverApi: Awaited<ReturnType<typeof startActiveTour>>['driverApi'],
) {
  const calls = matrixCalls();
  const result = await world.live.delay.evaluate(tourId, 'manual');
  expect(result).toMatchObject({ status: 'unavailable', reason: 'LOCATION_INACCURATE', stops: [] });
  // Kein Provider-Aufruf, kein Incident, keine Zustellung.
  expect(matrixCalls()).toBe(calls);
  expect(await delayIncidents(world, tourId)).toHaveLength(0);
  expect(await delayDeliveries(world)).toHaveLength(0);
  // Prognose-Endpunkt und View: „unknown“ + kleiner Hinweis, kein rotes Risiko, kein Meterwert.
  const delay = await driverApi('GET', `/staff/tours/${tourId}/delay`);
  expect(delay.status).toBe(200);
  expect(delay.body).toMatchObject({
    status: 'unavailable',
    reason: 'LOCATION_INACCURATE',
    stops: [],
  });
  const view = await driverApi('GET', `/staff/tours/${tourId}`);
  expect(view.body.tour.stops[0].delay).toEqual({ status: 'unknown' });
  expect(view.body.tour.openIncidents).toEqual([]);
  const codes = view.body.tour.warnings.map((w: { code: string }) => w.code);
  expect(codes).toContain('DELAY_LOCATION_INACCURATE');
  expect(codes).toContain('DELAY_FORECAST_UNAVAILABLE');
  expect(codes).not.toContain('DELAY_RISK');
  const hint = view.body.tour.warnings.find(
    (w: { code: string }) => w.code === 'DELAY_LOCATION_INACCURATE',
  );
  expect(hint).toEqual({
    code: 'DELAY_LOCATION_INACCURATE',
    message: 'Standort derzeit zu ungenau.',
    reason: 'LOCATION_INACCURATE',
  });
  const unavailable = view.body.tour.warnings.find(
    (w: { code: string }) => w.code === 'DELAY_FORECAST_UNAVAILABLE',
  );
  expect(unavailable).toEqual({
    code: 'DELAY_FORECAST_UNAVAILABLE',
    message: 'Verspätungsprognose derzeit nicht verfügbar.',
    reason: 'LOCATION_INACCURATE',
  });
  expect(JSON.stringify(view.body)).not.toMatch(/accuracy/i);
  return result;
}

describe('A1–A5. Genauigkeitsgrenze 250 m', () => {
  it('Grenze ist zentral (domain) und vom Service weitergereicht', () => {
    expect(DELAY_LOCATION_MAX_ACCURACY_METERS).toBe(250);
    expect(SERVICE_LIMIT).toBe(DELAY_LOCATION_MAX_ACCURACY_METERS);
  });

  it('A1. 20 m ⇒ Bewertung möglich: Risk mit Incident, View „risk“', async () => {
    const { tour, driverApi } = await tourWithAccuracy(20);
    const result = await world.live.delay.evaluate(tour.id, 'manual');
    expect(result.status).toBe('risk');
    expect(await delayIncidents(world, tour.id)).toHaveLength(1);
    const view = await driverApi('GET', `/staff/tours/${tour.id}`);
    expect(view.body.tour.stops[0].delay.status).toBe('risk');
    expect(view.body.tour.warnings.map((w: { code: string }) => w.code)).not.toContain(
      'DELAY_LOCATION_INACCURATE',
    );
  });

  it('A2. Genau 250 m ⇒ Bewertung möglich (Grenze inklusiv)', async () => {
    const { tour } = await tourWithAccuracy(250);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('risk');
    expect(await delayIncidents(world, tour.id)).toHaveLength(1);
  });

  it('A3. 251 m ⇒ unavailable/LOCATION_INACCURATE: kein Provider-Aufruf, kein Incident, View unknown + Hinweis', async () => {
    const { tour, driverApi } = await tourWithAccuracy(251);
    await expectInaccurate(tour.id, driverApi);
  });

  it('A4. Genauigkeit unbekannt (null) ⇒ unavailable/LOCATION_INACCURATE', async () => {
    const { tour, driverApi } = await tourWithAccuracy(null);
    await expectInaccurate(tour.id, driverApi);
  });

  it('A5. 50 km Genauigkeit ⇒ kein Risk trotz weiter Entfernung und knapper Deadline', async () => {
    const { tour, driverApi } = await tourWithAccuracy(50_000);
    await expectInaccurate(tour.id, driverApi);
    // Auch Standort-/Scanner-Trigger bewerten nichts.
    expect((await world.live.delay.evaluate(tour.id, 'location')).status).toBe('unavailable');
    expect((await world.live.delay.evaluate(tour.id, 'scanner')).status).toBe('unavailable');
    expect(await delayIncidents(world, tour.id)).toHaveLength(0);
  });
});

describe('A6–A8. Keine Entwarnung, erneute Bewertung, kein Push', () => {
  it('A6. Ungenauer Standort löst einen bestehenden Risk NICHT auf: Incident bleibt offen, View/Prognose weiterhin risk, zusätzlich Hinweis „zu ungenau“', async () => {
    const { tour, driver, driverApi } = await tourWithAccuracy(20);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('risk');
    const [incident] = await delayIncidents(world, tour.id);
    const pushes = (await delayDeliveries(world)).length;
    expect(pushes).toBeGreaterThan(0);
    // Jetzt „nahe“ gemeldet, aber ungenau (1 km) – wäre bei genauer Messung pünktlich.
    await setLiveLocation(world, tour.id, driver.id, NEAR_POINT, new Date(), 1_000);
    configureFixedMatrix(world, [120]);
    const calls = matrixCalls();
    const result = await world.live.delay.evaluate(tour.id, 'manual');
    expect(result).toMatchObject({ status: 'unavailable', reason: 'LOCATION_INACCURATE' });
    expect(matrixCalls()).toBe(calls);
    const rows = await delayIncidents(world, tour.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(incident!.id);
    expect(rows[0]!.resolvedAt).toBeNull();
    expect(await delayDeliveries(world)).toHaveLength(pushes);
    // Fachliche Wahrheit (offener Incident) bleibt sichtbar – nie eine stille Entwarnung.
    const delay = await driverApi('GET', `/staff/tours/${tour.id}/delay`);
    expect(delay.body.status).toBe('risk');
    const view = await driverApi('GET', `/staff/tours/${tour.id}`);
    expect(view.body.tour.stops[0].delay.status).toBe('risk');
    const codes = view.body.tour.warnings.map((w: { code: string }) => w.code);
    expect(codes).toContain('DELAY_RISK');
    expect(codes).toContain('DELAY_LOCATION_INACCURATE');
  });

  it('A7. Später genauer Standort ⇒ wieder normal bewertet: pünktlich ⇒ Incident gelöst; danach ungenau ⇒ nichts; danach genau+spät ⇒ neuer Incident', async () => {
    const { tour, driver } = await tourWithAccuracy(20);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('risk');
    const [first] = await delayIncidents(world, tour.id);
    // ungenau ⇒ nichts
    await setLiveLocation(world, tour.id, driver.id, NEAR_POINT, new Date(), 900);
    expect((await world.live.delay.evaluate(tour.id, 'location')).status).toBe('unavailable');
    // genau, nahe ⇒ ok ⇒ gelöst (auch als Standort-Trigger: kein Drossel-Rest aus der ungenauen Bewertung)
    await setLiveLocation(world, tour.id, driver.id, NEAR_POINT, new Date(), 15);
    configureFixedMatrix(world, [120]);
    expect((await world.live.delay.evaluate(tour.id, 'location')).status).toBe('ok');
    let rows = await delayIncidents(world, tour.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolvedAt).not.toBeNull();
    const pushes = (await delayDeliveries(world)).length;
    // ungenau + weit weg ⇒ nichts (kein neuer Incident)
    await setLiveLocation(world, tour.id, driver.id, DRIVER_POINT, new Date(), 5_000);
    configureFixedMatrix(world, [7200]);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('unavailable');
    expect(await delayIncidents(world, tour.id)).toHaveLength(1);
    expect(await delayDeliveries(world)).toHaveLength(pushes);
    // genau + weit weg ⇒ neuer Incident, neuer Push
    await setLiveLocation(world, tour.id, driver.id, DRIVER_POINT, new Date(), 30);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('risk');
    rows = await delayIncidents(world, tour.id);
    expect(rows).toHaveLength(2);
    const second = rows.find((row) => row.resolvedAt === null)!;
    expect(second.id).not.toBe(first!.id);
    expect(second.notificationEnqueuedAt).not.toBeNull();
    expect((await delayDeliveries(world)).length).toBe(pushes * 2);
  });

  it('A8. Kein Push bei LOCATION_INACCURATE – auch nach Scanner-Lauf und Job-Verarbeitung nichts versendet', async () => {
    const { tour, driverCookie, adminCookie } = await tourWithAccuracy(400);
    expect(await subscribePush(world, driverCookie, 'fahrer')).toBe(200);
    expect(await subscribePush(world, adminCookie, 'admin')).toBe(200);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('unavailable');
    const scan = (await world.live.scanner.scanDue(new Date())) as { evaluated: number };
    expect(scan.evaluated).toBe(1);
    expect(await delayIncidents(world, tour.id)).toHaveLength(0);
    expect(await delayDeliveries(world)).toHaveLength(0);
    await drainJobs(world.ctx);
    expect(world.ctx.push.sent.filter((r) => r.payload.kind === 'tour_delay_risk')).toHaveLength(0);
  });
});

describe('A9–A10. Speicherung und Logs', () => {
  it('A9. Ungenauer Standort wird weiterhin gespeichert (eine Zeile, Genauigkeit erhalten, keine Historie); genaueres Update überschreibt und wird bewertet', async () => {
    const { tour, driverApi, driver } = await startActiveTour(world, TIGHT_STOP(), {
      liveLocation: false,
    });
    configureFixedMatrix(world, [7200]);
    world.delayState.reset();
    const rowsOf = async () =>
      (
        await world.ctx.pool.query(
          'SELECT tour_id, user_id, accuracy_meters FROM tour_live_locations WHERE tour_id = $1',
          [tour.id],
        )
      ).rows as { tour_id: string; user_id: string; accuracy_meters: number | null }[];
    expect(
      (await sendLocation(driverApi, tour.id, { ...DRIVER_POINT, accuracyMeters: 5_000 })).status,
    ).toBe(204);
    let rows = await rowsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tour_id).toBe(tour.id);
    expect(rows[0]!.user_id).toBe(driver.id);
    expect(Number(rows[0]!.accuracy_meters)).toBe(5_000);
    await world.delayState.settle();
    expect(world.delayState.get(tour.id)).toMatchObject({
      status: 'unavailable',
      reason: 'LOCATION_INACCURATE',
      position: null,
    });
    expect(await delayIncidents(world, tour.id)).toHaveLength(0);
    // Ohne Genauigkeit (null) ⇒ gespeichert, aber keine Prognose.
    expect(
      (await sendLocation(driverApi, tour.id, { ...DRIVER_POINT, accuracyMeters: null })).status,
    ).toBe(204);
    rows = await rowsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accuracy_meters).toBeNull();
    await world.delayState.settle();
    expect(world.delayState.get(tour.id)?.reason).toBe('LOCATION_INACCURATE');
    // Genaueres Update: eine Zeile, Wert überschrieben, Bewertung läuft (asynchron nach 204).
    expect(
      (await sendLocation(driverApi, tour.id, { ...DRIVER_POINT, accuracyMeters: 12 })).status,
    ).toBe(204);
    rows = await rowsOf();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.accuracy_meters)).toBe(12);
    await world.delayState.settle();
    expect(world.delayState.get(tour.id)?.status).toBe('risk');
    expect(await delayIncidents(world, tour.id)).toHaveLength(1);
    expect((await driverApi('GET', `/staff/tours/${tour.id}/delay`)).body.status).toBe('risk');
  });

  it('A10. Keine Koordinaten und keine Genauigkeitswerte in Logs (Request-Log, Bewertung, Hinweise) – nur neutrale Gründe', async () => {
    const { tour, driverApi } = await startActiveTour(world, TIGHT_STOP(), {
      liveLocation: false,
    });
    configureFixedMatrix(world, [7200]);
    const point = { latitude: 49.912345, longitude: 8.261234 };
    expect(
      (await sendLocation(driverApi, tour.id, { ...point, accuracyMeters: 987.5 })).status,
    ).toBe(204);
    await world.delayState.settle();
    expect(world.delayState.get(tour.id)?.reason).toBe('LOCATION_INACCURATE');
    expect((await driverApi('GET', `/staff/tours/${tour.id}`)).status).toBe(200);
    expect((await driverApi('GET', `/staff/tours/${tour.id}/delay`)).body.reason).toBe(
      'LOCATION_INACCURATE',
    );
    await sleep(100);
    const log = world.logText();
    expect(log.length).toBeGreaterThan(0);
    expect(log).toContain('LOCATION_INACCURATE');
    expect(log).not.toContain('987.5');
    expect(log).not.toContain('49.912345');
    expect(log).not.toContain('8.261234');
    expect(log).not.toMatch(/latitude|longitude|accuracy/i);
  });
});
