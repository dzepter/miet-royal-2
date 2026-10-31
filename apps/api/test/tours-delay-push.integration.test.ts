/**
 * Phase 13 Final §2 (P1–P7): Delay-Push als ATOMARE Outbox. Incident-Zustand,
 * Empfänger und Push-Delivery-Zeilen entstehen in EINER kurzen Transaktion
 * (Tour FOR SHARE, Incident FOR UPDATE, `createDelivery(…, tx)`,
 * `notification_enqueued_at`); der Job `push.send` wird erst NACH dem Commit
 * eingereiht. Fehlt er (Absturz/Queue-Fehler), holt ihn der bestehende
 * Push-Outbox-Backstop nach. Fahrer + Planung; eine Person in beiden Rollen ⇒
 * genau eine Zustellung; Retry ⇒ keine zweite Zeile; Pool max=1; parallele
 * Bewertungen ⇒ ein Incident, ein Push je Empfänger.
 */
import { integrationJobs } from '@mietroyal/database';
import { like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PushService, pushSendJobKey } from '../src/communication/push/push-service.ts';
import { getDepotAddress, resolveOperativeAddress } from '../src/routing/address-resolver.ts';
import { createTourLiveModule } from '../src/tours/live/module.ts';
import { TourService } from '../src/tours/tour-service.ts';
import { drainJobs } from './communication-helpers.ts';
import {
  DRIVER_PERMISSIONS,
  DRIVER_POINT,
  completeAppointment,
  configureFixedMatrix,
  createToursWorld,
  delayDeliveries,
  delayIncidents,
  destroyToursWorld,
  inMinutes,
  pushEndpointFor,
  resetToursWorld,
  sendLocation,
  sleep,
  staffWith,
  startActiveTour,
  subscribePush,
  type ToursWorld,
} from './tours-helpers.ts';

let world: ToursWorld;

beforeAll(async () => {
  world = await createToursWorld({ locationMinIntervalMs: 0 });
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

/** IDs der Zustellungen, für die ein `push.send`-Job (stabiler Schlüssel) existiert. */
async function deliveriesWithJob(w: ToursWorld, deliveryIds: readonly string[]) {
  const rows = await w.ctx.db
    .select({ key: integrationJobs.idempotencyKey })
    .from(integrationJobs)
    .where(like(integrationJobs.idempotencyKey, 'push.send:%'));
  const keys = new Set(rows.map((row) => row.key));
  return deliveryIds.filter((id) => keys.has(pushSendJobKey(id)));
}

function sentDelayPushes(w: ToursWorld) {
  return w.ctx.push.sent.filter((record) => record.payload.kind === 'tour_delay_risk');
}

/** Risk auslösen und die Outbox prüfen – für die normale und die Pool-max=1-Welt. */
async function riskWithOutbox(w: ToursWorld) {
  const fixture = await startActiveTour(w, TIGHT_STOP());
  configureFixedMatrix(w, [7200]);
  const result = await w.live.delay.evaluate(fixture.tour.id, 'manual');
  expect(result.status).toBe('risk');
  const incidents = await delayIncidents(w, fixture.tour.id);
  expect(incidents).toHaveLength(1);
  expect(incidents[0]!.resolvedAt).toBeNull();
  expect(incidents[0]!.notificationEnqueuedAt).not.toBeNull();
  const deliveries = await delayDeliveries(w);
  return { ...fixture, incident: incidents[0]!, deliveries };
}

describe('P1–P5. Atomare Outbox', () => {
  it('P1. Risk öffnet Incident + Push-Outbox atomar: Delivery-Zeilen je Empfänger, notification_enqueued_at gesetzt, Job je Zustellung erst nach dem Commit', async () => {
    const { admin, driver, incident, deliveries, tour } = await riskWithOutbox(world);
    // Fahrer (calendar.view) + Admin (employee.manage) ⇒ genau zwei Zustellungen.
    expect(deliveries.map((row) => row.userId).sort()).toEqual([admin.id, driver.id].sort());
    for (const row of deliveries) {
      expect(row.kind).toBe('tour_delay_risk');
      expect(row.status).toBe('pending');
      expect(row.idempotencyKey).toBe(`push:tour_delay_risk:${incident.id}:${row.userId}`);
    }
    const driverPush = deliveries.find((row) => row.userId === driver.id)!;
    expect((driverPush.payload as { url: string }).url).toBe(`/touren/aktiv?id=${tour.id}`);
    const adminPush = deliveries.find((row) => row.userId === admin.id)!;
    expect((adminPush.payload as { url: string }).url).toBe(`/touren/${tour.id}`);
    // Jobs existieren für JEDE Zustellung (eingereiht nach dem Commit).
    expect(
      await deliveriesWithJob(
        world,
        deliveries.map((row) => row.id),
      ),
    ).toHaveLength(2);
  });

  it('P2. Fahrer + Planung/Admin erhalten je genau einen Push (Fahrer-Variante vs. Planungs-Variante); Unbeteiligte nie; Versand bis zum Gateway', async () => {
    const fixture = await startActiveTour(world, TIGHT_STOP(), { driverLabel: 'Anton' });
    const planner = await staffWith(
      world,
      fixture.admin.id,
      ['calendar.view', 'calendar.view_all'],
      'Plan',
    );
    const bystander = await staffWith(world, fixture.admin.id, DRIVER_PERMISSIONS, 'Dritte');
    expect(await subscribePush(world, fixture.driverCookie, 'anton')).toBe(200);
    expect(await subscribePush(world, fixture.adminCookie, 'admin')).toBe(200);
    expect(await subscribePush(world, planner.cookie, 'plan')).toBe(200);
    expect(await subscribePush(world, bystander.cookie, 'dritte')).toBe(200);
    configureFixedMatrix(world, [7200]);
    expect((await world.live.delay.evaluate(fixture.tour.id, 'manual')).status).toBe('risk');
    const [incident] = await delayIncidents(world, fixture.tour.id);
    const rows = await delayDeliveries(world);
    const byUser = new Map(rows.map((row) => [row.userId, row]));
    expect(rows).toHaveLength(3);
    expect((byUser.get(fixture.driver.id)!.payload as { url: string }).url).toBe(
      `/touren/aktiv?id=${fixture.tour.id}`,
    );
    for (const userId of [fixture.admin.id, planner.user.id]) {
      const push = byUser.get(userId)!;
      expect(push.idempotencyKey).toBe(`push:tour_delay_risk:${incident!.id}:${userId}`);
      expect((push.payload as { url: string }).url).toBe(`/touren/${fixture.tour.id}`);
    }
    expect(byUser.has(bystander.user.id)).toBe(false);
    expect(
      await deliveriesWithJob(
        world,
        rows.map((row) => row.id),
      ),
    ).toHaveLength(3);
    await drainJobs(world.ctx);
    const sent = sentDelayPushes(world);
    expect(sent.map((record) => record.endpoint).sort()).toEqual(
      ['admin', 'anton', 'plan'].map(pushEndpointFor).sort(),
    );
  });

  it('P3. Fahrer ist zugleich Planer/Admin ⇒ exakt EINE Zustellung an diese Person (Fahrer-Variante), kein Duplikat', async () => {
    const fixture = await startActiveTour(world, TIGHT_STOP(), {
      driverLabel: 'Planfahrer',
      driverPermissions: ['calendar.view', 'calendar.view_all', 'employee.manage'],
    });
    expect(await subscribePush(world, fixture.driverCookie, 'planfahrer')).toBe(200);
    expect(await subscribePush(world, fixture.adminCookie, 'admin')).toBe(200);
    configureFixedMatrix(world, [7200]);
    expect((await world.live.delay.evaluate(fixture.tour.id, 'manual')).status).toBe('risk');
    const rows = await delayDeliveries(world);
    expect(rows.map((row) => row.userId).sort()).toEqual(
      [fixture.admin.id, fixture.driver.id].sort(),
    );
    const own = rows.filter((row) => row.userId === fixture.driver.id);
    expect(own).toHaveLength(1);
    expect((own[0]!.payload as { url: string }).url).toBe(`/touren/aktiv?id=${fixture.tour.id}`);
    await drainJobs(world.ctx);
    const sent = sentDelayPushes(world);
    expect(sent).toHaveLength(2);
    expect(sent.filter((record) => record.endpoint === pushEndpointFor('planfahrer'))).toHaveLength(
      1,
    );
  });

  it('P4. Crash/Queue-Fehler NACH dem Commit, VOR dem Job: Zustellung ohne Job wird nur geloggt – der Push-Outbox-Backstop (scan_due) reiht nach, genau ein Versand je Empfänger', async () => {
    class FailingJobPushService extends PushService {
      fail = false;
      override async enqueueSendJob(deliveryId: string): Promise<boolean> {
        if (this.fail) throw new Error('queue down');
        return super.enqueueSendJob(deliveryId);
      }
    }
    const warned: unknown[][] = [];
    const push = new FailingJobPushService(world.ctx.db, world.ctx.queue);
    const live = createTourLiveModule({
      db: world.ctx.db,
      tours: new TourService(world.ctx.db),
      routing: world.routing,
      geocoding: world.geocoding,
      addresses: { resolveOperativeAddress, getDepotAddress },
      push,
      auth: world.ctx.auth,
      state: world.delayState,
      logger: {
        info: () => undefined,
        warn: (...args: unknown[]) => {
          warned.push(args);
        },
        error: () => undefined,
      },
    });
    const fixture = await startActiveTour(world, TIGHT_STOP());
    expect(await subscribePush(world, fixture.driverCookie, 'fahrer')).toBe(200);
    expect(await subscribePush(world, fixture.adminCookie, 'admin')).toBe(200);
    configureFixedMatrix(world, [7200]);
    push.fail = true;
    // Bewertung scheitert NICHT: Incident + Outbox sind committed, nur der Job fehlt.
    expect((await live.delay.evaluate(fixture.tour.id, 'manual')).status).toBe('risk');
    const [incident] = await delayIncidents(world, fixture.tour.id);
    expect(incident!.notificationEnqueuedAt).not.toBeNull();
    const rows = await delayDeliveries(world);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'pending')).toBe(true);
    expect(
      await deliveriesWithJob(
        world,
        rows.map((row) => row.id),
      ),
    ).toHaveLength(0);
    // Fehler nur geloggt (IDs/Fehlercode, keine Koordinaten).
    expect(warned).toHaveLength(2);
    for (const [fields, message] of warned) {
      expect(fields).toMatchObject({ tourId: fixture.tour.id, errorCode: 'Error' });
      expect(String(message)).toMatch(/Backstop/);
      expect(JSON.stringify(fields)).not.toMatch(/latitude|longitude|49\.99|8\.24/);
    }
    // Eine erneute Bewertung legt nichts Neues an (Marke gesetzt) – und reiht auch keinen Job ein.
    push.fail = false;
    expect((await live.delay.evaluate(fixture.tour.id, 'manual')).status).toBe('risk');
    expect(await delayDeliveries(world)).toHaveLength(2);
    expect(
      await deliveriesWithJob(
        world,
        rows.map((row) => row.id),
      ),
    ).toHaveLength(0);
    // Backstop: der zentrale scan_due (Push-Regeln ⇒ scheduleOutboxBackstop) holt die Jobs nach.
    // `now` eine Stunde voraus: der Scanner `tour_delay` des Test-Runners (Mock-Routing)
    // sieht dann keinen frischen Standort und bewertet nichts – nur der Backstop wirkt.
    const later = new Date(Date.now() + 3_600_000);
    await world.ctx.scan.runOnce(later);
    expect(
      (
        await deliveriesWithJob(
          world,
          rows.map((row) => row.id),
        )
      ).sort(),
    ).toEqual(rows.map((row) => row.id).sort());
    await drainJobs(world.ctx);
    const sent = sentDelayPushes(world);
    expect(sent.map((record) => record.endpoint).sort()).toEqual(
      ['admin', 'fahrer'].map(pushEndpointFor).sort(),
    );
    // Zweiter Backstop-Lauf: nichts mehr nachzuholen, kein zweiter Versand.
    await world.ctx.scan.runOnce(later);
    await drainJobs(world.ctx);
    expect(sentDelayPushes(world)).toHaveLength(2);
  });

  it('P5. Retry ⇒ keine Doppelzustellung: erneute Bewertung, zweites notifyPending und verlorene Marke erzeugen nie eine zweite Delivery-Zeile oder einen zweiten Job', async () => {
    const { driverCookie, adminCookie, incident, deliveries, tour, driver } =
      await riskWithOutbox(world);
    expect(await subscribePush(world, driverCookie, 'fahrer')).toBe(200);
    expect(await subscribePush(world, adminCookie, 'admin')).toBe(200);
    expect(deliveries).toHaveLength(2);
    // (a) Normale Wiederholungen (manuell, Standort-Trigger nach Bewegung, Scanner).
    await sleep(20);
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('risk');
    expect(
      (
        await sendLocation(apiForDriver(driverCookie), tour.id, {
          latitude: DRIVER_POINT.latitude + 0.02,
          longitude: DRIVER_POINT.longitude,
          accuracyMeters: 20,
        })
      ).status,
    ).toBe(204);
    await world.delayState.settle();
    const scan = (await world.live.scanner.scanDue(new Date(Date.now() + 4 * 60_000))) as {
      evaluated: number;
    };
    expect(scan.evaluated).toBe(1);
    expect(await delayDeliveries(world)).toHaveLength(2);
    // (b) Härtester Retry: die Freigabe-Marke geht verloren (z. B. Rollback nach
    //     teilweisem Schreiben) – der Idempotenzschlüssel verhindert jede zweite Zeile.
    await world.ctx.pool.query(
      'UPDATE tour_delay_incidents SET notification_enqueued_at = NULL WHERE id = $1',
      [incident.id],
    );
    expect((await world.live.delay.evaluate(tour.id, 'manual')).status).toBe('risk');
    const again = await delayDeliveries(world);
    expect(again.map((row) => row.id).sort()).toEqual(deliveries.map((row) => row.id).sort());
    const [after] = await delayIncidents(world, tour.id);
    expect(after!.id).toBe(incident.id);
    expect(after!.notificationEnqueuedAt).not.toBeNull();
    expect(
      await deliveriesWithJob(
        world,
        again.map((row) => row.id),
      ),
    ).toHaveLength(2);
    expect(
      (
        await world.ctx.db
          .select({ key: integrationJobs.idempotencyKey })
          .from(integrationJobs)
          .where(like(integrationJobs.idempotencyKey, 'push.send:%'))
      ).length,
    ).toBe(2);
    await drainJobs(world.ctx);
    expect(sentDelayPushes(world)).toHaveLength(2);
    expect(
      sentDelayPushes(world).filter((r) => r.endpoint === pushEndpointFor('fahrer')),
    ).toHaveLength(1);
    void driver;
  });
});

describe('RF2. Stoppzustand frisch in der Schreibtransaktion', () => {
  it('RF2. Stopp wird WÄHREND des Provider-Aufrufs erledigt (Übergabe; Tourversion unverändert) ⇒ kein Incident, keine Delivery, kein Job; Bewertung nicht „risk“', async () => {
    const fixture = await startActiveTour(world, TIGHT_STOP());
    expect(await subscribePush(world, fixture.driverCookie, 'fahrer')).toBe(200);
    expect(await subscribePush(world, fixture.adminCookie, 'admin')).toBe(200);
    configureFixedMatrix(world, [7200]);
    let completed = false;
    world.routing.configure({
      beforeRespond: async (call) => {
        if (call.method !== 'matrix' || completed) return;
        completed = true;
        // Fachlicher Abschluss (completeWithin) erhöht die Tourversion NICHT.
        await completeAppointment(world, fixture.admin.id, fixture.bookings[0]!.outbound.id);
      },
    });
    const result = await world.live.delay.evaluate(fixture.tour.id, 'manual');
    expect(completed).toBe(true);
    expect(result.status).toBe('ok');
    if (result.status === 'skipped') throw new Error('unerwartet übersprungen');
    expect(result.stops.map((s) => s.late)).toEqual([false]);
    expect(await delayIncidents(world, fixture.tour.id)).toHaveLength(0);
    expect(await delayDeliveries(world)).toHaveLength(0);
    expect(
      await world.ctx.db
        .select({ key: integrationJobs.idempotencyKey })
        .from(integrationJobs)
        .where(like(integrationJobs.idempotencyKey, 'push.send:%')),
    ).toHaveLength(0);
    const view = await fixture.driverApi('GET', `/staff/tours/${fixture.tour.id}`);
    expect(view.body.tour.stops[0].state).toBe('done');
    expect(view.body.tour.stops[0].delay.status).toBe('none');
    expect(view.body.tour.warnings.map((w: { code: string }) => w.code)).not.toContain(
      'DELAY_RISK',
    );
    const delay = await fixture.driverApi('GET', `/staff/tours/${fixture.tour.id}/delay`);
    expect(delay.body.status).not.toBe('risk');
    await drainJobs(world.ctx);
    expect(sentDelayPushes(world)).toHaveLength(0);
  });
});

function apiForDriver(cookie: string) {
  return async (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
    url: string,
    payload?: unknown,
  ) => {
    const response = await world.app.inject({
      method,
      url,
      headers: { cookie },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return { status: response.statusCode, body: response.body === '' ? null : response.json() };
  };
}

describe('P6–P7. Pool max=1 und parallele Bewertungen', () => {
  it('P6. PostgreSQL-Pool max=1: Risk-Bewertung, Push-Outbox, Standort-Route, Konflikt-Route und parallele Bewertungen laufen ohne Timeout/Deadlock (kein zweiter Pool-Acquire in gehaltener Transaktion)', async () => {
    const pooled = await createToursWorld({ poolMax: 1, locationMinIntervalMs: 0 });
    try {
      const guard = <T>(promise: Promise<T>, label: string) =>
        Promise.race([
          promise,
          new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`Pool max=1: ${label} hängt`)), 20_000),
          ),
        ]);
      const { admin, driver, driverApi, incident, deliveries, tour } = await guard(
        riskWithOutbox(pooled),
        'Risk-Bewertung',
      );
      expect(deliveries.map((row) => row.userId).sort()).toEqual([admin.id, driver.id].sort());
      expect(
        await deliveriesWithJob(
          pooled,
          deliveries.map((row) => row.id),
        ),
      ).toHaveLength(2);
      expect(incident.notificationEnqueuedAt).not.toBeNull();
      // Parallele Bewertungen unter Pool max=1.
      const results = await guard(
        Promise.all([
          pooled.live.delay.evaluate(tour.id, 'manual'),
          pooled.live.delay.evaluate(tour.id, 'manual'),
          pooled.live.delay.evaluate(tour.id, 'manual'),
        ]),
        'parallele Bewertungen',
      );
      expect(results.map((r) => r.status)).toEqual(['risk', 'risk', 'risk']);
      expect(await delayIncidents(pooled, tour.id)).toHaveLength(1);
      expect(await delayDeliveries(pooled)).toHaveLength(2);
      // Routen der App (dieselbe Pool-Grenze): Standort ⇒ asynchrone Bewertung, Konflikt-Route, Prognose.
      expect(
        (
          await guard(
            sendLocation(driverApi, tour.id, { ...DRIVER_POINT, accuracyMeters: 20 }),
            'Standort-Route',
          )
        ).status,
      ).toBe(204);
      await guard(pooled.delayState.settle(), 'asynchrone Bewertung');
      const active = await guard(driverApi('GET', '/staff/tours/active'), 'active-Route');
      expect(active.status).toBe(200);
      expect(active.body.tour.id).toBe(tour.id);
      expect(active.body.conflict).toBeNull();
      const delay = await guard(driverApi('GET', `/staff/tours/${tour.id}/delay`), 'delay-Route');
      expect(delay.body.status).toBe('risk');
      await guard(drainJobs(pooled.ctx), 'Job-Verarbeitung');
    } finally {
      await pooled.delayState.settle();
      await destroyToursWorld(pooled);
    }
  }, 90_000);

  it('P7. Parallele Risk-Bewertungen ⇒ genau ein Incident und genau eine Zustellung je Empfänger (Incident FOR UPDATE, UNIQUE-Schlüssel)', async () => {
    const fixture = await startActiveTour(world, TIGHT_STOP());
    expect(await subscribePush(world, fixture.driverCookie, 'fahrer')).toBe(200);
    expect(await subscribePush(world, fixture.adminCookie, 'admin')).toBe(200);
    configureFixedMatrix(world, [7200]);
    const results = await Promise.all([
      world.live.delay.evaluate(fixture.tour.id, 'manual'),
      world.live.delay.evaluate(fixture.tour.id, 'manual'),
      world.live.delay.evaluate(fixture.tour.id, 'plan_changed'),
      world.live.delay.evaluate(fixture.tour.id, 'stop_changed'),
    ]);
    expect(results.every((r) => r.status === 'risk')).toBe(true);
    const incidents = await delayIncidents(world, fixture.tour.id);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.notificationEnqueuedAt).not.toBeNull();
    const rows = await delayDeliveries(world);
    expect(rows.map((row) => row.userId).sort()).toEqual(
      [fixture.admin.id, fixture.driver.id].sort(),
    );
    expect(
      await deliveriesWithJob(
        world,
        rows.map((row) => row.id),
      ),
    ).toHaveLength(2);
    await drainJobs(world.ctx);
    expect(
      sentDelayPushes(world)
        .map((r) => r.endpoint)
        .sort(),
    ).toEqual(['admin', 'fahrer'].map(pushEndpointFor).sort());
  });
});
