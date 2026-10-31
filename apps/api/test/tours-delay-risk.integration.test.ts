/**
 * Phase-13-Pflichttests 80–94 (Order §§49–55): ETA im Fenster kein Risk,
 * ETA nach Deadline Risk, exakter Termin, Fensterende, 15-min-Puffer der
 * vorherigen Stopps, Provider nicht verfügbar ⇒ kein falscher Risk, stale
 * GPS ⇒ keine Live-Prognose, genau ein Push an Fahrer bzw. Planung/Admin,
 * kein Spam je Incident, Auflösung bei Pünktlichkeit, keine Kundenmail/
 * -WhatsApp/-Portalnachricht, Push ohne PII. Zusätzlich: Drossel, Trigger
 * über das Standort-Update, Scanner `tour_delay`.
 */
import {
  appointments,
  pushDeliveries,
  tourDelayIncidents,
  type TourDelayIncident,
} from '@mietroyal/database';
import { berlinStartOfDay } from '@mietroyal/domain';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TourService } from '../src/tours/tour-service.ts';
import { drainJobs } from './communication-helpers.ts';
import { substitutionServiceFor } from './scheduling-helpers.ts';
import {
  DRIVER_PERMISSIONS,
  adminSession,
  apiFor,
  bookingWithAppointments,
  completeAppointment,
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
const MINUTES = 60_000;
/** Fahrer-Position (Koordinate wird nur an das Fake-Gateway gegeben). */
const DRIVER_POINT = { latitude: 49.99, longitude: 8.24 };
const NEAR_POINT = { latitude: 49.9742, longitude: 8.2566 };

beforeAll(async () => {
  world = await createToursWorld({ locationMinIntervalMs: 0 });
});
afterAll(async () => {
  await destroyToursWorld(world);
});
beforeEach(async () => {
  await resetToursWorld(world);
});

/**
 * Feste Fahrzeiten: Zeile 0 = Live-Standort, danach die Stopps in
 * Tour-Reihenfolge. `fromOrigin[i]` = Sekunden Standort → Stopp i+1,
 * `between` = Sekunden zwischen beliebigen Stopps.
 */
function fixedMatrix(fromOrigin: number[], between = 600) {
  world.routing.configure({
    matrix: (request) => {
      const n = request.points.length;
      const durationsSeconds: (number | null)[][] = [];
      const distancesMeters: (number | null)[][] = [];
      for (let i = 0; i < n; i += 1) {
        const row: (number | null)[] = [];
        for (let j = 0; j < n; j += 1) {
          if (i === j) row.push(0);
          else if (i === 0) row.push(fromOrigin[j - 1] ?? between);
          else if (j === 0) row.push(fromOrigin[i - 1] ?? between);
          else row.push(between);
        }
        durationsSeconds.push(row);
        distancesMeters.push(row.map((value) => (value === null ? null : value * 11)));
      }
      return { durationsSeconds, distancesMeters };
    },
  });
}

interface StopSpec {
  startAt: Date;
  endAt?: Date | null;
  street: string;
  bufferMinutes?: number;
}

/** Aktive Tour des Fahrers mit Stopps (Zeiten relativ zu jetzt) und frischem Live-Standort. */
async function activeTour(stops: StopSpec[], options: { driverLabel?: string } = {}) {
  const { admin, cookie } = await adminSession(world);
  const api = apiFor(world.app, cookie);
  const driver = await staffWith(
    world,
    admin.id,
    DRIVER_PERMISSIONS,
    options.driverLabel ?? 'Fahrer',
  );
  const driverApi = apiFor(world.app, driver.cookie);
  const today = todayBerlin();
  const bookings = [];
  for (const spec of stops) {
    bookings.push(
      await bookingWithAppointments(world, admin.id, {
        assignTo: driver.user.id,
        outboundStartAt: spec.startAt,
        outboundEndAt: spec.endAt ?? null,
        street: spec.street,
      }),
    );
  }
  let tour = await tourWithStops(api, {
    tourDate: today,
    assignedUserId: driver.user.id,
    appointmentIds: bookings.map((b) => b.outbound.id),
  });
  for (let i = 0; i < stops.length; i += 1) {
    const buffer = stops[i]!.bufferMinutes;
    if (buffer === undefined) continue;
    const patched = await api('PATCH', `/staff/tours/${tour.id}/stops/${tour.stops[i].id}`, {
      bufferMinutes: buffer,
    });
    expect(patched.status).toBe(200);
    tour = patched.body.tour;
  }
  const started = await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
  expect(started.status).toBe(200);
  tour = started.body.tour;
  await setLiveLocation(world, tour.id, driver.user.id, DRIVER_POINT);
  // Asynchrone Bewertungen aus der Planungsphase (Stopp hinzufügen/Start) abwarten.
  await world.delayState.settle();
  return { admin, adminCookie: cookie, api, driver: driver.user, driverApi, today, tour, bookings };
}

/**
 * Zeitpunkt relativ zu jetzt; Vergangenheitswerte bleiben am heutigen Berliner Tag
 * (Tourdatum), damit Läufe kurz nach Mitternacht nicht an „Termin nicht am Tourdatum“ scheitern.
 */
const inMinutes = (minutes: number) => {
  const at = Date.now() + minutes * MINUTES;
  const dayStart = berlinStartOfDay(todayBerlin()).getTime() + MINUTES;
  return new Date(minutes < 0 ? Math.max(at, dayStart) : at);
};

async function incidents(tourId: string): Promise<TourDelayIncident[]> {
  return world.ctx.db
    .select()
    .from(tourDelayIncidents)
    .where(eq(tourDelayIncidents.tourId, tourId))
    .orderBy(asc(tourDelayIncidents.detectedAt));
}

async function deliveries(kind = 'tour_delay_risk') {
  return world.ctx.db
    .select()
    .from(pushDeliveries)
    .where(eq(pushDeliveries.kind, kind))
    .orderBy(asc(pushDeliveries.createdAt));
}

async function countRows(table: string): Promise<number> {
  const result = await world.ctx.pool.query(`SELECT count(*)::int AS n FROM ${table}`);
  return result.rows[0].n as number;
}

describe('80.–86. Bewertung', () => {
  it('T80. ETA im Fenster ⇒ kein Risk, kein Incident, kein Push; Prognose ok', async () => {
    const { tour, driverApi } = await activeTour([
      { startAt: inMinutes(30), endAt: inMinutes(120), street: 'Lieferweg 12' },
    ]);
    fixedMatrix([600]);
    const result = await world.live.delay.evaluate(tour.id, 'manual');
    expect(result.status).toBe('ok');
    if (result.status === 'skipped') throw new Error('unexpected');
    expect(result.stops).toHaveLength(1);
    expect(result.stops[0]!.late).toBe(false);
    // Ankunft wartet bis zum Frühestbeginn (Fensterbeginn), nie davor.
    expect(result.stops[0]!.predictedArrivalAt!.getTime()).toBeGreaterThanOrEqual(
      Date.now() + 29 * MINUTES,
    );
    expect(await incidents(tour.id)).toHaveLength(0);
    expect(await deliveries()).toHaveLength(0);
    const delay = await driverApi('GET', `/staff/tours/${tour.id}/delay`);
    expect(delay.body.status).toBe('ok');
    expect(delay.body.stops[0].late).toBe(false);
    const view = await driverApi('GET', `/staff/tours/${tour.id}`);
    expect(view.body.tour.stops[0].delay).toEqual({ status: 'none' });
    expect(view.body.tour.openIncidents).toEqual([]);
    expect(view.body.tour.warnings.map((w: { code: string }) => w.code)).not.toContain(
      'DELAY_FORECAST_UNAVAILABLE',
    );
    // An den Provider gingen nur Koordinaten.
    const matrixCalls = world.routing.calls.filter((c) => c.method === 'matrix');
    expect(matrixCalls).toHaveLength(1);
    // (Die Adresse selbst geht an den Provider – Name, Vorgangsnummer, Telefon nie.)
    expect(world.routing.serializedCalls()).not.toMatch(/Klara|Kommerz|MR-|0171/);
  });

  it('T81. ETA nach der Deadline ⇒ Risk: Incident mit Prognose/Deadline, View risk + Warnung, Prognose-Endpunkt', async () => {
    const { tour, driverApi, bookings } = await activeTour([
      { startAt: inMinutes(-10), endAt: inMinutes(20), street: 'Lieferweg 12' },
    ]);
    fixedMatrix([7200]);
    const before = Date.now();
    const result = await world.live.delay.evaluate(tour.id, 'manual');
    expect(result.status).toBe('risk');
    const rows = await incidents(tour.id);
    expect(rows).toHaveLength(1);
    const incident = rows[0]!;
    expect(incident.stopId).toBe(tour.stops[0].id);
    expect(incident.resolvedAt).toBeNull();
    expect(incident.deadlineAt.toISOString()).toBe(bookings[0]!.outbound.endAt!.toISOString());
    expect(incident.predictedArrivalAt.getTime()).toBeGreaterThanOrEqual(before + 7200_000 - 1000);
    expect(incident.predictedArrivalAt.getTime()).toBeGreaterThan(incident.deadlineAt.getTime());
    expect(incident.notificationEnqueuedAt).not.toBeNull();
    const view = await driverApi('GET', `/staff/tours/${tour.id}`);
    expect(view.body.tour.stops[0].delay).toEqual({
      status: 'risk',
      predictedArrivalAt: incident.predictedArrivalAt.toISOString(),
      incidentId: incident.id,
    });
    expect(view.body.tour.openIncidents).toEqual([
      {
        id: incident.id,
        stopId: tour.stops[0].id,
        predictedArrivalAt: incident.predictedArrivalAt.toISOString(),
        deadlineAt: incident.deadlineAt.toISOString(),
      },
    ]);
    const warning = view.body.tour.warnings.find((w: { code: string }) => w.code === 'DELAY_RISK');
    expect(warning.stopId).toBe(tour.stops[0].id);
    expect(warning.message).toMatch(
      /^Liefertermin MR-\d{4}-\d{4,} droht den Termin zu verpassen\.$/,
    );
    const delay = await driverApi('GET', `/staff/tours/${tour.id}/delay`);
    expect(delay.body.status).toBe('risk');
    expect(delay.body.stops).toEqual([
      {
        stopId: tour.stops[0].id,
        predictedArrivalAt: incident.predictedArrivalAt.toISOString(),
        deadlineAt: incident.deadlineAt.toISOString(),
        late: true,
      },
    ]);
  });

  it('T82. Exakter Termin: Deadline = Termin selbst; Ankunft danach ⇒ Risk', async () => {
    const { tour, bookings } = await activeTour([
      { startAt: inMinutes(20), endAt: null, street: 'Lieferweg 12' },
    ]);
    fixedMatrix([3600]);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('risk');
    const [incident] = await incidents(tour.id);
    expect(incident!.deadlineAt.toISOString()).toBe(bookings[0]!.outbound.startAt!.toISOString());
    expect(bookings[0]!.outbound.endAt).toBeNull();
  });

  it('T83. Zeitfenster: Deadline = Fensterende – Ankunft nach Fensterbeginn, aber vor Ende ⇒ kein Risk; nach Ende ⇒ Risk', async () => {
    const early = await activeTour([
      { startAt: inMinutes(-10), endAt: inMinutes(180), street: 'Lieferweg 12' },
    ]);
    fixedMatrix([3000]);
    const ok = await world.live.delay.evaluate(early.tour.id, 'manual');
    expect(ok.status).toBe('ok');
    expect(await incidents(early.tour.id)).toHaveLength(0);
    // Tour beenden, damit derselbe Fahrer eine zweite Tour starten kann.
    const ended = await early.api('POST', `/staff/tours/${early.tour.id}/end`, {
      force: true,
      reason: 'Testende',
    });
    expect(ended.status).toBe(200);
    await resetToursWorld(world);
    const late = await activeTour([
      { startAt: inMinutes(10), endAt: inMinutes(40), street: 'Lieferweg 12' },
    ]);
    fixedMatrix([3000]);
    const risk = await world.live.delay.evaluate(late.tour.id, 'manual');
    expect(risk.status).toBe('risk');
    const [incident] = await incidents(late.tour.id);
    expect(incident!.deadlineAt.toISOString()).toBe(
      late.bookings[0]!.outbound.endAt!.toISOString(),
    );
  });

  it('T84. 15-min-Puffer der vorherigen Stopps zählt: mit Standardpuffer Risk, ohne Puffer pünktlich', async () => {
    // Standort = Stopp 1 (0 s), Stopp 1 → Stopp 2 = 10 min; Stopp 2 exakt in 20 min.
    // Standardpuffer 15 min am Stopp 1 ⇒ Ankunft Stopp 2 in 25 min ⇒ Risk.
    const withBuffer = await activeTour([
      { startAt: inMinutes(-5), endAt: inMinutes(55), street: 'Lieferweg 12' },
      { startAt: inMinutes(20), endAt: null, street: 'Birkenstraße 2' },
    ]);
    fixedMatrix([0, 600], 600);
    const risk = await world.live.delay.evaluate(withBuffer.tour.id, 'manual');
    expect(risk.status).toBe('risk');
    if (risk.status === 'skipped') throw new Error('unexpected');
    expect(risk.stops[0]!.late).toBe(false);
    expect(risk.stops[1]!.late).toBe(true);
    expect(risk.stops[1]!.predictedArrivalAt!.getTime()).toBeGreaterThanOrEqual(
      Date.now() + 24 * MINUTES,
    );
    expect((await incidents(withBuffer.tour.id)).map((i) => i.stopId)).toEqual([
      withBuffer.tour.stops[1].id,
    ]);
    await resetToursWorld(world);
    // Gleiche Lage, Puffer am Stopp 1 = 0 ⇒ Ankunft Stopp 2 in 10 min ⇒ pünktlich.
    const noBuffer = await activeTour([
      { startAt: inMinutes(-5), endAt: inMinutes(55), street: 'Lieferweg 12', bufferMinutes: 0 },
      { startAt: inMinutes(20), endAt: null, street: 'Birkenstraße 2' },
    ]);
    fixedMatrix([0, 600], 600);
    const ok = await world.live.delay.evaluate(noBuffer.tour.id, 'manual');
    expect(ok.status).toBe('ok');
    expect(await incidents(noBuffer.tour.id)).toHaveLength(0);
  });

  it('T85. Provider nicht verfügbar/deaktiviert ⇒ „unavailable“: kein falscher Risk, keine falsche Entwarnung, kein zweiter Push', async () => {
    const { tour, driverApi } = await activeTour([
      { startAt: inMinutes(-10), endAt: inMinutes(20), street: 'Lieferweg 12' },
    ]);
    world.routing.configure({
      failNext: { matrix: { kind: 'server_error', times: 1, status: 502 } },
    });
    const failed = await world.live.delay.evaluate(tour.id, 'manual');
    expect(failed.status).toBe('unavailable');
    if (failed.status === 'skipped') throw new Error('unexpected');
    expect(failed.reason).toBe('ROUTING_SERVER_ERROR');
    expect(await incidents(tour.id)).toHaveLength(0);
    expect(await deliveries()).toHaveLength(0);
    let delay = await driverApi('GET', `/staff/tours/${tour.id}/delay`);
    expect(delay.body.status).toBe('unavailable');
    let view = await driverApi('GET', `/staff/tours/${tour.id}`);
    expect(view.body.tour.stops[0].delay).toEqual({ status: 'unknown' });
    expect(view.body.tour.warnings.map((w: { code: string }) => w.code)).toContain(
      'DELAY_FORECAST_UNAVAILABLE',
    );
    // Echter Risk …
    fixedMatrix([7200]);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('risk');
    const [incident] = await incidents(tour.id);
    const pushCount = (await deliveries()).length;
    expect(pushCount).toBeGreaterThan(0);
    // … dann Provider aus (disabled) ⇒ Incident bleibt offen, kein zusätzlicher Push, Prognose aus DB.
    world.routing.configure({ failNext: { matrix: { kind: 'disabled', times: null } } });
    const down = await world.live.delay.evaluate(tour.id, 'manual');
    expect(down.status).toBe('unavailable');
    const after = await incidents(tour.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(incident!.id);
    expect(after[0]!.resolvedAt).toBeNull();
    expect(after[0]!.lastEvaluatedAt.toISOString()).toBe(incident!.lastEvaluatedAt.toISOString());
    expect(await deliveries()).toHaveLength(pushCount);
    delay = await driverApi('GET', `/staff/tours/${tour.id}/delay`);
    expect(delay.body.status).toBe('risk');
    expect(delay.body.stops[0].stopId).toBe(tour.stops[0].id);
    view = await driverApi('GET', `/staff/tours/${tour.id}`);
    expect(view.body.tour.stops[0].delay.status).toBe('risk');
  });

  it('T86. Stale GPS (> 10 min) ⇒ keine Live-Prognose, kein Provider-Aufruf, kein Incident', async () => {
    const { tour, driver } = await activeTour([
      { startAt: inMinutes(-10), endAt: inMinutes(20), street: 'Lieferweg 12' },
    ]);
    await setLiveLocation(
      world,
      tour.id,
      driver.id,
      DRIVER_POINT,
      new Date(Date.now() - 11 * MINUTES),
    );
    fixedMatrix([7200]);
    world.routing.calls.length = 0;
    const result = await world.live.delay.evaluate(tour.id, 'scanner');
    expect(result.status).toBe('unavailable');
    if (result.status === 'skipped') throw new Error('unexpected');
    expect(result.reason).toBe('NO_LIVE_LOCATION');
    expect(world.routing.calls.filter((c) => c.method === 'matrix')).toHaveLength(0);
    expect(await incidents(tour.id)).toHaveLength(0);
    // Der Scanner wählt stale Standorte gar nicht erst aus.
    expect(await world.live.scanner.scanDue(new Date())).toEqual({
      evaluated: 0,
      skipped: 0,
      failed: 0,
    });
  });
});

describe('87.–94. Push, Spam, Auflösung, keine Kundenkommunikation, PII', () => {
  it('T87./T88. Erstes echtes Risk ⇒ genau ein Push an den effektiven Fahrer (Vertretung) und an Planung/Admin, nicht an sonstige', async () => {
    const { admin, adminCookie, driver, tour, bookings } = await activeTour(
      [{ startAt: inMinutes(-10), endAt: inMinutes(20), street: 'Lieferweg 12' }],
      { driverLabel: 'Anton' },
    );
    const substitute = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Berta');
    await substitutionServiceFor(world.ctx).create(admin.id, {
      originalUserId: driver.id,
      substituteUserId: substitute.user.id,
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: new Date(Date.now() + 86_400_000),
    });
    const planner = await staffWith(
      world,
      admin.id,
      ['calendar.view', 'calendar.view_all'],
      'Plan',
    );
    const bystander = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Dritte');
    // Subscriptions, damit der Versand bis zum Fake-Gateway läuft.
    const KEYS = { p256dh: 'BPk'.padEnd(87, 'A'), auth: 'auth-secret-16by' };
    const subscribe = (cookie: string, label: string) =>
      world.app.inject({
        method: 'POST',
        url: '/staff/push/subscriptions',
        headers: { cookie },
        payload: {
          endpoint: `https://push.example.test/send/${label}-${'e'.repeat(40)}`,
          keys: KEYS,
        },
      });
    expect((await subscribe(substitute.cookie, 'berta')).statusCode).toBe(200);
    expect((await subscribe(adminCookie, 'admin')).statusCode).toBe(200);
    expect((await subscribe(planner.cookie, 'plan')).statusCode).toBe(200);
    expect((await subscribe(bystander.cookie, 'dritte')).statusCode).toBe(200);

    fixedMatrix([7200]);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('risk');
    const [incident] = await incidents(tour.id);
    const rows = await deliveries();
    const byUser = new Map(rows.map((row) => [row.userId, row]));
    // T87: effektiver Fahrer (Vertretung) genau einmal, Ziel „Aktive Tour“.
    const driverPush = byUser.get(substitute.user.id)!;
    expect(driverPush).toBeDefined();
    expect(driverPush.idempotencyKey).toBe(
      `push:tour_delay_risk:${incident!.id}:${substitute.user.id}`,
    );
    expect((driverPush.payload as { url: string }).url).toBe(`/touren/aktiv?id=${tour.id}`);
    expect(byUser.has(driver.id)).toBe(false); // vertretener Fahrer ist nicht zuständig
    // T88: Planung/Admin genau einmal, Ziel Tourseite; Unbeteiligte nie.
    for (const userId of [admin.id, planner.user.id]) {
      const push = byUser.get(userId)!;
      expect(push).toBeDefined();
      expect(push.idempotencyKey).toBe(`push:tour_delay_risk:${incident!.id}:${userId}`);
      expect((push.payload as { url: string }).url).toBe(`/touren/${tour.id}`);
    }
    expect(byUser.has(bystander.user.id)).toBe(false);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.kind === 'tour_delay_risk')).toBe(true);
    // Versand über die Phase-12-Outbox bis zum Fake-Gateway.
    await drainJobs(world.ctx);
    const sent = world.ctx.push.sent.filter((record) => record.payload.kind === 'tour_delay_risk');
    expect(sent).toHaveLength(3);
    expect(sent.map((record) => record.endpoint).sort()).toEqual(
      ['admin', 'berta', 'plan'].map(
        (l) => `https://push.example.test/send/${l}-${'e'.repeat(40)}`,
      ),
    );
    const processNumber = (
      await world.ctx.pool.query('SELECT process_number FROM processes WHERE id = $1', [
        bookings[0]!.processId,
      ])
    ).rows[0].process_number as string;
    expect(sent[0]!.payload.title).toBe('Tour droht Termin zu verpassen');
    expect(sent[0]!.payload.body).toBe(`Lieferung ${processNumber}`);
    expect(sent[0]!.payload.tag).toBe(`tour-delay:${incident!.id}`);
  });

  it('T89. Gleicher Incident ⇒ kein Spam: erneute Bewertung (manuell, Standort, Scanner) erzeugt keinen zweiten Push', async () => {
    const { tour, driver } = await activeTour([
      { startAt: inMinutes(-10), endAt: inMinutes(20), street: 'Lieferweg 12' },
    ]);
    fixedMatrix([7200]);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('risk');
    const [first] = await incidents(tour.id);
    const count = (await deliveries()).length;
    expect(count).toBeGreaterThan(0);
    await sleep(20);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('risk');
    // Standort-Trigger nach > 500 m Bewegung ⇒ bewertet, aber kein neuer Push.
    await setLiveLocation(world, tour.id, driver.id, {
      latitude: DRIVER_POINT.latitude + 0.02,
      longitude: DRIVER_POINT.longitude,
    });
    expect((await world.live.delay.evaluate(tour.id, 'location')).status).toBe('risk');
    // Scanner-Lauf (≥ 3 min später simuliert).
    const scan = (await world.live.scanner.scanDue(new Date(Date.now() + 4 * MINUTES))) as {
      evaluated: number;
    };
    expect(scan.evaluated).toBe(1);
    const rows = await incidents(tour.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first!.id);
    expect(rows[0]!.lastEvaluatedAt.getTime()).toBeGreaterThan(first!.lastEvaluatedAt.getTime());
    expect(rows[0]!.notificationEnqueuedAt!.toISOString()).toBe(
      first!.notificationEnqueuedAt!.toISOString(),
    );
    expect(await deliveries()).toHaveLength(count);
    // Der zentrale scan_due kennt den Scanner `tour_delay`.
    const run = await world.ctx.scan.runOnce(new Date(Date.now() - 20 * MINUTES));
    expect(run.scanners.find((s) => s.name === 'tour_delay')).toEqual({
      name: 'tour_delay',
      ok: true,
      errorCode: null,
    });
    expect(await deliveries()).toHaveLength(count);
  });

  it('T90. Wieder pünktlich ⇒ resolved (kein Push); neues echtes Risk nach Auflösung ⇒ neuer Incident, neuer Push', async () => {
    const { tour, driver, driverApi } = await activeTour([
      { startAt: inMinutes(-10), endAt: inMinutes(60), street: 'Lieferweg 12' },
    ]);
    fixedMatrix([7200]);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('risk');
    const [first] = await incidents(tour.id);
    const pushes = (await deliveries()).length;
    // Nahe am Ziel ⇒ pünktlich ⇒ gelöst.
    await setLiveLocation(world, tour.id, driver.id, NEAR_POINT);
    fixedMatrix([120]);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('ok');
    let rows = await incidents(tour.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolvedAt).not.toBeNull();
    expect(await deliveries()).toHaveLength(pushes);
    const view = await driverApi('GET', `/staff/tours/${tour.id}`);
    expect(view.body.tour.stops[0].delay).toEqual({ status: 'none' });
    expect(view.body.tour.openIncidents).toEqual([]);
    // Erneut weit weg ⇒ neuer Incident (nicht derselbe), neuer Push.
    await setLiveLocation(world, tour.id, driver.id, DRIVER_POINT);
    fixedMatrix([7200]);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('risk');
    rows = await incidents(tour.id);
    expect(rows).toHaveLength(2);
    const second = rows.find((row) => row.resolvedAt === null)!;
    expect(second.id).not.toBe(first!.id);
    expect(second.notificationEnqueuedAt).not.toBeNull();
    expect((await deliveries()).length).toBe(pushes * 2);
    expect(
      (await deliveries()).filter((row) => row.idempotencyKey.includes(second.id)),
    ).toHaveLength(pushes);
  });

  it('T91./T92./T93. Risk und Auflösung lösen NIE Kundenkommunikation aus (Mail, WhatsApp, Aktions-/Portal-Links)', async () => {
    const { tour, driver, bookings } = await activeTour([
      { startAt: inMinutes(-10), endAt: inMinutes(60), street: 'Lieferweg 12' },
    ]);
    const before = {
      mail: await countRows('mail_deliveries'),
      conversation: await countRows('conversation_messages'),
      whatsapp: await countRows('whatsapp_events'),
      actions: await countRows('customer_action_tokens'),
    };
    fixedMatrix([7200]);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('risk');
    await setLiveLocation(world, tour.id, driver.id, NEAR_POINT);
    fixedMatrix([120]);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('ok');
    await world.live.scanner.scanDue(new Date(Date.now() + 4 * MINUTES));
    await drainJobs(world.ctx);
    expect(await countRows('mail_deliveries')).toBe(before.mail);
    expect(await countRows('conversation_messages')).toBe(before.conversation);
    expect(await countRows('whatsapp_events')).toBe(before.whatsapp);
    expect(await countRows('customer_action_tokens')).toBe(before.actions);
    expect(world.ctx.mailGateway.sent).toHaveLength(0);
    expect(world.ctx.whatsapp.sendCalls).toHaveLength(0);
    const appointment = (
      await world.ctx.db
        .select()
        .from(appointments)
        .where(eq(appointments.id, bookings[0]!.outbound.id))
    )[0]!;
    expect(appointment.customerInformedAt).toBeNull();
    expect(appointment.status).toBe('scheduled');
    expect(appointment.startAt!.toISOString()).toBe(bookings[0]!.outbound.startAt!.toISOString());
  });

  it('T94. Push ohne PII: nur Terminart + Vorgangsnummer – kein Name, keine Adresse, kein Telefon, keine Koordinate, kein Preis', async () => {
    const { tour, bookings } = await activeTour([
      { startAt: inMinutes(-10), endAt: inMinutes(20), street: 'Lieferweg 12' },
    ]);
    fixedMatrix([7200]);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('risk');
    const rows = await deliveries();
    expect(rows.length).toBeGreaterThan(0);
    const processNumber = (
      await world.ctx.pool.query('SELECT process_number FROM processes WHERE id = $1', [
        bookings[0]!.processId,
      ])
    ).rows[0].process_number as string;
    for (const row of rows) {
      const payload = row.payload as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(['body', 'kind', 'tag', 'title', 'url']);
      expect(payload.title).toBe('Tour droht Termin zu verpassen');
      expect(payload.body).toBe(`Lieferung ${processNumber}`);
      const text = JSON.stringify(payload);
      expect(text).not.toMatch(/Klara|Kommerz|Lieferweg|55129|Mainz|0171|49\.9|8\.2|€|EUR/);
      expect(text).not.toMatch(/latitude|longitude|key=/i);
    }
  });
});

describe('Review-13-Fixes: Race Tourende/Version, stale Warnung, Stopp entfernen', () => {
  const openIncidents = async (tourId: string) =>
    (await incidents(tourId)).filter((row) => row.resolvedAt === null);

  it('F2. Tour wird WÄHREND des Provider-Aufrufs beendet ⇒ Bewertung verworfen: kein Incident, kein Push, Prognose nie „risk“ für eine beendete Tour', async () => {
    const { api, driverApi, tour } = await activeTour([
      { startAt: inMinutes(10), street: 'Ahornweg 1' },
    ]);
    fixedMatrix([3600]);
    let ended = false;
    world.routing.configure({
      beforeRespond: async (call) => {
        if (call.method !== 'matrix' || ended) return;
        ended = true;
        const result = await api('POST', `/staff/tours/${tour.id}/end`, {
          force: true,
          reason: 'Fahrzeugpanne – Tour abgebrochen',
        });
        expect(result.status).toBe(200);
        expect(result.body.tour.status).toBe('completed');
      },
    });
    const evaluation = await world.live.delay.evaluate(tour.id, 'manual');
    expect(ended).toBe(true);
    expect(evaluation.status).toBe('unavailable');
    expect(evaluation.reason).toBe('TOUR_CHANGED');
    expect(await openIncidents(tour.id)).toHaveLength(0);
    expect(await deliveries()).toHaveLength(0);
    // Kein Gedächtnis-Eintrag für die verworfene Bewertung.
    expect(world.delayState.get(tour.id)).toBeUndefined();
    const delay = await driverApi('GET', `/staff/tours/${tour.id}/delay`);
    expect(delay.body.status).toBe('unavailable');
    expect(delay.body.reason).toBe('TOUR_NOT_ACTIVE');
    const view = await driverApi('GET', `/staff/tours/${tour.id}`);
    expect(view.body.tour.warnings.map((w: { code: string }) => w.code)).not.toContain(
      'DELAY_RISK',
    );
    expect(view.body.tour.openIncidents).toEqual([]);
  });

  it('F2. Tourversion ändert sich WÄHREND des Provider-Aufrufs (Umsortierung) ⇒ Ergebnis verworfen, nichts geschrieben; nächste Bewertung schreibt', async () => {
    const { admin, tour } = await activeTour([
      { startAt: inMinutes(10), street: 'Ahornweg 1' },
      { startAt: inMinutes(90), street: 'Birkenstraße 2' },
    ]);
    fixedMatrix([3600, 600]);
    const [a, b] = tour.stops as { id: string }[];
    let reordered = false;
    world.routing.configure({
      beforeRespond: async (call) => {
        if (call.method !== 'matrix' || reordered) return;
        reordered = true;
        // Direkt über den Service (ohne Route-Haken, der sonst eine neue Bewertung anstößt).
        await new TourService(world.ctx.db).reorder(admin.id, tour.id, { order: [b!.id, a!.id] });
      },
    });
    const evaluation = await world.live.delay.evaluate(tour.id, 'manual');
    await world.delayState.settle();
    expect(reordered).toBe(true);
    expect(evaluation.status).toBe('unavailable');
    expect(evaluation.reason).toBe('TOUR_CHANGED');
    expect(await incidents(tour.id)).toHaveLength(0);
    expect(await deliveries()).toHaveLength(0);
    // Eine Bewertung der geänderten Tour (neue Version) schreibt regulär.
    world.routing.configure({ beforeRespond: async () => undefined });
    const fresh = await world.live.delay.evaluate(tour.id, 'manual');
    expect(fresh.status).toBe('risk');
    expect(await openIncidents(tour.id)).toHaveLength(1);
  });

  it('F3. Stopp erledigt (Übergabe) ⇒ keine stehengebliebene Warnung: View „none“, kein DELAY_RISK, Prognose nicht „risk“; Incident lazy gelöst – ohne Provider-Aufruf', async () => {
    const { admin, driverApi, tour, bookings } = await activeTour([
      { startAt: inMinutes(10), street: 'Ahornweg 1' },
      { startAt: inMinutes(90), street: 'Birkenstraße 2' },
    ]);
    fixedMatrix([3600, 600]);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('risk');
    expect(await openIncidents(tour.id)).toHaveLength(1);
    const matrixCalls = world.routing.calls.filter((c) => c.method === 'matrix').length;
    // GPS bleibt aus (keine neue Bewertung) – der Stopp wird fachlich abgeschlossen.
    world.delayState.reset();
    await completeAppointment(world, admin.id, bookings[0]!.outbound.id);
    const view = await driverApi('GET', `/staff/tours/${tour.id}`);
    expect(view.body.tour.stops[0].state).toBe('done');
    expect(view.body.tour.stops[0].delay.status).toBe('none');
    expect(view.body.tour.warnings.map((w: { code: string }) => w.code)).not.toContain(
      'DELAY_RISK',
    );
    expect(view.body.tour.openIncidents).toEqual([]);
    const delay = await driverApi('GET', `/staff/tours/${tour.id}/delay`);
    expect(delay.body.status).not.toBe('risk');
    // Lazy-Heilung hat den Incident gelöst – kein Provider-Aufruf dafür.
    const rows = await incidents(tour.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolvedAt).not.toBeNull();
    expect(world.routing.calls.filter((c) => c.method === 'matrix')).toHaveLength(matrixCalls);
  });

  it('F5. Stopp entfernen trotz Incident-Historie (gelöst oder offen) ⇒ 200, Incidents des Stopps gelöscht', async () => {
    const { api, tour } = await activeTour([
      { startAt: inMinutes(10), street: 'Ahornweg 1' },
      { startAt: inMinutes(90), street: 'Birkenstraße 2' },
    ]);
    fixedMatrix([3600, 600]);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('risk');
    fixedMatrix([60, 600]);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('ok');
    expect(await openIncidents(tour.id)).toHaveLength(0);
    expect(await incidents(tour.id)).toHaveLength(1);
    const stopId = tour.stops[0].id as string;
    const removed = await api('DELETE', `/staff/tours/${tour.id}/stops/${stopId}`, {});
    expect(removed.status).toBe(200);
    expect(removed.body.tour.stops).toHaveLength(1);
    expect(await incidents(tour.id)).toHaveLength(0);
    await world.delayState.settle();
    // Offener Incident: der verbleibende Stopp (Termin in 90 min) wird late und entfernt.
    fixedMatrix([7200]);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('risk');
    expect(await openIncidents(tour.id)).toHaveLength(1);
    const lastStop = removed.body.tour.stops[0].id as string;
    const removedOpen = await api('DELETE', `/staff/tours/${tour.id}/stops/${lastStop}`, {});
    expect(removedOpen.status).toBe(200);
    expect(await incidents(tour.id)).toHaveLength(0);
    await world.delayState.settle();
  });
});

describe('Review 13 Final: Verspätung nur für offene Stopps', () => {
  const codes = (view: { body: { tour: { warnings: { code: string }[] } } }) =>
    view.body.tour.warnings.map((w) => w.code);

  it('RF1. „Angekommen“ NACH der Deadline ⇒ kein Incident, kein Push, keine DELAY_RISK-Warnung; der erreichte Stopp bleibt Zwischenpunkt der Restroute (late=false)', async () => {
    const { driverApi, tour } = await activeTour([
      { startAt: inMinutes(-30), endAt: inMinutes(-2), street: 'Lieferweg 12' },
      { startAt: inMinutes(180), endAt: inMinutes(240), street: 'Ahornweg 1' },
    ]);
    const [first, second] = tour.stops as { id: string }[];
    // Fahrer steht am Ziel (30 s), zweiter Stopp bequem erreichbar.
    fixedMatrix([30, 600]);
    expect(await incidents(tour.id)).toHaveLength(0);
    const arrived = await driverApi(
      'POST',
      `/staff/tours/${tour.id}/stops/${first!.id}/arrived`,
      {},
    );
    expect(arrived.status).toBe(200);
    expect(arrived.body.tour.stops[0].state).toBe('arrived');
    // Trigger stop_changed bewertet asynchron – abwarten.
    await world.delayState.settle();
    expect(await incidents(tour.id)).toHaveLength(0);
    expect(await deliveries()).toHaveLength(0);
    const view = await driverApi('GET', `/staff/tours/${tour.id}`);
    expect(view.body.tour.stops[0].state).toBe('arrived');
    expect(codes(view)).not.toContain('DELAY_RISK');
    expect(view.body.tour.openIncidents).toEqual([]);
    // Erneute Bewertung: der erreichte Stopp bleibt Zwischenpunkt (Matrix mit 3 Punkten),
    // ist aber nie „late“; der offene zweite Stopp ist pünktlich.
    const before = world.routing.calls.filter((c) => c.method === 'matrix').length;
    const evaluation = await world.live.delay.evaluate(tour.id, 'manual');
    expect(evaluation.status).toBe('ok');
    if (evaluation.status === 'skipped') throw new Error('unerwartet übersprungen');
    expect(evaluation.stops.map((s) => [s.stopId, s.late])).toEqual([
      [first!.id, false],
      [second!.id, false],
    ]);
    const calls = world.routing.calls.filter((c) => c.method === 'matrix');
    expect(calls).toHaveLength(before + 1);
    expect((calls.at(-1)!.request as { points: unknown[] }).points).toHaveLength(3);
    expect(await incidents(tour.id)).toHaveLength(0);
    expect(await deliveries()).toHaveLength(0);
    const delay = await driverApi('GET', `/staff/tours/${tour.id}/delay`);
    expect(delay.body.status).toBe('ok');
  });

  it('RF1b. Offener Incident, dann „Angekommen“ (nach der Deadline) ⇒ Incident gelöst, kein zweiter Push, keine DELAY_RISK-Warnung; einziger Stopp erreicht ⇒ kein Provider-Aufruf', async () => {
    const { driverApi, tour } = await activeTour([
      { startAt: inMinutes(-10), endAt: inMinutes(20), street: 'Lieferweg 12' },
    ]);
    fixedMatrix([7200]);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('risk');
    const open = (await incidents(tour.id)).filter((row) => row.resolvedAt === null);
    expect(open).toHaveLength(1);
    const sentBefore = await deliveries();
    expect(sentBefore).toHaveLength(2);
    const matrixCalls = world.routing.calls.filter((c) => c.method === 'matrix').length;
    const arrived = await driverApi(
      'POST',
      `/staff/tours/${tour.id}/stops/${tour.stops[0].id}/arrived`,
      {},
    );
    expect(arrived.status).toBe(200);
    await world.delayState.settle();
    const rows = await incidents(tour.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolvedAt).not.toBeNull();
    expect((await deliveries()).map((row) => row.id).sort()).toEqual(
      sentBefore.map((row) => row.id).sort(),
    );
    // Kein offener Stopp mehr ⇒ keine Prognose nötig, kein Provider-Aufruf.
    expect(world.routing.calls.filter((c) => c.method === 'matrix')).toHaveLength(matrixCalls);
    const view = await driverApi('GET', `/staff/tours/${tour.id}`);
    expect(view.body.tour.stops[0].state).toBe('arrived');
    expect(view.body.tour.stops[0].delay.status).toBe('none');
    expect(codes(view)).not.toContain('DELAY_RISK');
    expect(view.body.tour.openIncidents).toEqual([]);
    expect((await driverApi('GET', `/staff/tours/${tour.id}/delay`)).body.status).toBe('ok');
  });
});

describe('Zusatz: Drossel, Standort-Trigger', () => {
  it('Location-Trigger: < 3 min und < 500 m seit der letzten Bewertung ⇒ übersprungen; ≥ 500 m ⇒ bewertet', async () => {
    const { tour, driver } = await activeTour([
      { startAt: inMinutes(30), endAt: inMinutes(120), street: 'Lieferweg 12' },
    ]);
    fixedMatrix([600]);
    expect((await world.live.delay.evaluate(tour.id, 'location')).status).toBe('ok');
    const calls = world.routing.calls.filter((c) => c.method === 'matrix').length;
    await setLiveLocation(world, tour.id, driver.id, {
      latitude: DRIVER_POINT.latitude + 0.001, // ≈ 110 m
      longitude: DRIVER_POINT.longitude,
    });
    expect((await world.live.delay.evaluate(tour.id, 'location')).status).toBe('skipped');
    expect((await world.live.delay.evaluate(tour.id, 'scanner')).status).toBe('skipped');
    expect(world.routing.calls.filter((c) => c.method === 'matrix')).toHaveLength(calls);
    await setLiveLocation(world, tour.id, driver.id, {
      latitude: DRIVER_POINT.latitude + 0.01, // ≈ 1,1 km
      longitude: DRIVER_POINT.longitude,
    });
    expect((await world.live.delay.evaluate(tour.id, 'location')).status).toBe('ok');
    expect(world.routing.calls.filter((c) => c.method === 'matrix')).toHaveLength(calls + 1);
    // Plan-/Stopp-Trigger bewerten immer.
    expect((await world.live.delay.evaluate(tour.id, 'plan_changed')).status).toBe('ok');
    expect(world.routing.calls.filter((c) => c.method === 'matrix')).toHaveLength(calls + 2);
  });

  it('Standort-Update über die API stößt die Bewertung nach der 204-Antwort an (asynchron)', async () => {
    const { tour, driverApi } = await activeTour([
      { startAt: inMinutes(-10), endAt: inMinutes(20), street: 'Lieferweg 12' },
    ]);
    world.delayState.reset();
    fixedMatrix([7200]);
    // Phase 13 Final (§3): nur ein genauer Standort (≤ 250 m) trägt eine Prognose.
    expect(
      (await sendLocation(driverApi, tour.id, { ...DRIVER_POINT, accuracyMeters: 20 })).status,
    ).toBe(204);
    let record = world.delayState.get(tour.id);
    for (let i = 0; i < 100 && record === undefined; i += 1) {
      await sleep(30);
      record = world.delayState.get(tour.id);
    }
    expect(record?.status).toBe('risk');
    expect(await incidents(tour.id)).toHaveLength(1);
    const delay = await driverApi('GET', `/staff/tours/${tour.id}/delay`);
    expect(delay.body.status).toBe('risk');
  });
});
