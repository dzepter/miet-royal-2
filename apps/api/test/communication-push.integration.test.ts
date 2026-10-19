/**
 * Phase 12 – PUSH (Pflichttests 117–149): Subscriptions je User/Session,
 * Revoke, 404/410, VAPID-Konfiguration, Datenminimierung, notificationclick-
 * URL, 1h-Regel (Pickup/Delivery/Return), Vertretung, Reschedule,
 * Reassignment, Overdue, Maschinenrisiko initial + 6h, neues Gerät, KEIN
 * Reinigungs-Push, Tour-Grenze, Hijack (fremder Endpoint/fremde Session).
 */
import { Writable } from 'node:stream';
import { loadConfig } from '@mietroyal/config';
import {
  appointmentOverdueIncidents,
  appointmentReminders,
  appointments,
  machineRiskIncidents,
  pushDeliveries,
  pushSubscriptions,
  staffSessions,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import webpush from 'web-push';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import {
  createPushGateway,
  DisabledPushGateway,
  FakePushGateway,
  outcomeFromStatusCode,
  WebPushGateway,
} from '../src/communication/push/gateways.ts';
import { buildPushPayload, PUSH_KINDS } from '../src/communication/push/payload.ts';
import { PushService } from '../src/communication/push/push-service.ts';
import { PushRuleScanner, pushKeys } from '../src/communication/push/rules.ts';
import { pushStatusSummary } from '../src/communication/push/status.ts';
import { PushSubscriptionService } from '../src/communication/push/subscription-service.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createEmployeeWithPassword,
  createTestContext,
  destroyTestContext,
  login,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { createStaffWithPermissions, truncateCrmTables } from './crm-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import {
  DAYS,
  handoverServicesFor,
  HOURS,
  scheduledBooking,
  truncateHandoverTables,
} from './handover-helpers.ts';
import {
  createAcceptedBooking,
  schedulingServiceFor,
  substitutionServiceFor,
  truncateSchedulingTables,
} from './scheduling-helpers.ts';
import { machineByCode, resetWarehouse } from './warehouse-helpers.ts';

let ctx: TestContext;
const logChunks: string[] = [];
const logDestination = new Writable({
  write(chunk, _encoding, callback) {
    logChunks.push(String(chunk));
    callback();
  },
});
const logText = () => logChunks.join('');

beforeAll(async () => {
  ctx = await createTestContext({ logDestination, logLevel: 'trace' });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await ctx.pool.query(
    'TRUNCATE push_deliveries, push_subscriptions, appointment_reminders, integration_jobs CASCADE',
  );
  await truncateHandoverTables(ctx.pool);
  await resetWarehouse(ctx.pool);
  await truncateSchedulingTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
  ctx.push.reset();
  logChunks.length = 0;
});

const MINUTES = 60_000;
const UA_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1';

function endpointFor(label: string): string {
  return `https://push.example.test/send/${label}-${'e'.repeat(40)}`;
}
const KEYS = { p256dh: 'BPk'.padEnd(87, 'A'), auth: 'auth-secret-16by' };

async function adminSession(userAgent = UA_WINDOWS) {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD, userAgent);
  return { admin, cookie: session.cookie };
}

async function makeEmployee(adminId: string, name: string, permissionKeys: string[] = []) {
  if (permissionKeys.length === 0) {
    const user = await createEmployeeWithPassword(ctx, adminId, {
      firstName: name,
      lastName: 'Test',
      email: `${name.toLowerCase()}@test.example`,
      password: `${name.toLowerCase()}-passwort-1234`,
    });
    const session = await login(ctx.app, user.email, `${name.toLowerCase()}-passwort-1234`);
    return { user, cookie: session.cookie };
  }
  return createStaffWithPermissions(ctx, adminId, {
    firstName: name,
    lastName: 'Test',
    email: `${name.toLowerCase()}@test.example`,
    password: `${name.toLowerCase()}-passwort-1234`,
    permissionKeys: permissionKeys as never,
  });
}

async function subscribe(cookie: string, endpoint: string, label = 'Testgerät') {
  return ctx.app.inject({
    method: 'POST',
    url: '/staff/push/subscriptions',
    headers: { cookie },
    payload: { endpoint, keys: KEYS, userAgentLabel: label },
  });
}

function scannerFor(): PushRuleScanner {
  return new PushRuleScanner({
    db: ctx.db,
    push: new PushService(ctx.db, ctx.queue),
    auth: ctx.auth,
  });
}

async function deliveries(kind?: string) {
  const rows = await ctx.db.select().from(pushDeliveries);
  return kind === undefined ? rows : rows.filter((row) => row.kind === kind);
}

async function deliveryByKey(key: string) {
  const rows = await ctx.db
    .select()
    .from(pushDeliveries)
    .where(eq(pushDeliveries.idempotencyKey, key));
  return rows[0]!;
}

/** Alle fälligen Jobs verarbeiten (JobRunner.drain stoppt im Testmodus nach einem Job). */
async function drainAll(): Promise<void> {
  while ((await ctx.jobs.runOnce()) !== 'idle') {
    // weiter
  }
}

/** Sendungen des Fakes einer Art (Login-Hinweise anderer Tests ausblenden). */
function sentOf(kind: string) {
  return ctx.push.sent.filter((record) => record.payload.kind === kind);
}

async function subscriptionByEndpoint(endpoint: string) {
  const rows = await ctx.db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint));
  return rows[0];
}

/** Bestätigte Buchung mit zugewiesenem Mitarbeiter; Termine auf konkrete Zeiten setzen. */
async function bookingWithTimes(
  adminId: string,
  assigneeId: string,
  times: { outbound: Date | null; inbound: Date | null },
  fulfillment: 'pickup' | 'delivery' = 'pickup',
) {
  const world = await createAcceptedBooking(ctx, adminId, {
    fulfillment,
    assignProcessTo: assigneeId,
  });
  const scheduling = schedulingServiceFor(ctx);
  await scheduling.ensureAppointmentsForBooking(world.bookingId);
  const rows = await ctx.db
    .select()
    .from(appointments)
    .where(eq(appointments.bookingId, world.bookingId));
  const outbound = rows.find((row) => row.kind === 'pickup' || row.kind === 'delivery')!;
  const inbound = rows.find((row) => row.kind === 'return')!;
  if (times.outbound !== null) {
    await scheduling.reschedule(adminId, outbound.id, {
      startAt: times.outbound,
      endAt: null,
      expectedVersion: outbound.version,
    });
  }
  if (times.inbound !== null) {
    await scheduling.reschedule(adminId, inbound.id, {
      startAt: times.inbound,
      endAt: null,
      expectedVersion: inbound.version,
    });
  }
  return { ...world, outboundId: outbound.id, inboundId: inbound.id, scheduling };
}

describe('117.–119. Subscriptions je User/Session, Revoke, 404/410', () => {
  it('117. Subscription wird an User UND aktuelle Session gebunden; Liste zeigt nie Endpoint/Keys', async () => {
    const { admin, cookie } = await adminSession();
    const endpoint = endpointFor('admin-a');
    const response = await subscribe(cookie, endpoint, 'Windows · Chrome');
    expect(response.statusCode).toBe(200);
    const row = (await subscriptionByEndpoint(endpoint))!;
    expect(row.userId).toBe(admin.id);
    const sessions = await ctx.db
      .select()
      .from(staffSessions)
      .where(eq(staffSessions.userId, admin.id));
    expect(sessions.map((s) => s.id)).toContain(row.sessionId);
    expect(row.disabledAt).toBeNull();

    // Zweite Registrierung desselben Endpoints ist ein Upsert (keine zweite Zeile).
    await subscribe(cookie, endpoint, 'Windows · Chrome');
    const all = await ctx.db.select().from(pushSubscriptions);
    expect(all).toHaveLength(1);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/staff/push/subscriptions',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const devices = list.json().devices as Record<string, unknown>[];
    expect(devices).toHaveLength(1);
    expect(devices[0]!.userAgentLabel).toBe('Windows · Chrome');
    expect(devices[0]!.currentSession).toBe(true);
    expect(list.body).not.toContain(endpoint);
    expect(list.body).not.toContain(KEYS.auth);
    expect(list.body).not.toContain(KEYS.p256dh);
    // VAPID-Status-Route: nur enabled/publicKey.
    const vapid = await ctx.app.inject({
      method: 'GET',
      url: '/staff/push/vapid-public-key',
      headers: { cookie },
    });
    // Testkontext: Fake-Gateway aktiv ⇒ enabled, aber kein echter VAPID-Key.
    expect(vapid.json()).toEqual({ enabled: true, publicKey: null });
  });

  it('117b. Endpoint muss https sein; Validierung lehnt http/zu lange Werte ab; ohne Login 401', async () => {
    const { cookie } = await adminSession();
    const bad = await subscribe(cookie, 'http://push.example.test/send/x');
    expect(bad.statusCode).toBe(400);
    const tooLong = await subscribe(cookie, `https://push.example.test/${'x'.repeat(2100)}`);
    expect(tooLong.statusCode).toBe(400);
    const anonymous = await ctx.app.inject({
      method: 'POST',
      url: '/staff/push/subscriptions',
      payload: { endpoint: endpointFor('anon'), keys: KEYS },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('118. Logout (Revoke) ⇒ Subscription deaktiviert, kein Push mehr an dieses Gerät', async () => {
    const { admin, cookie } = await adminSession();
    const endpoint = endpointFor('admin-logout');
    await subscribe(cookie, endpoint);
    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(200);
    const row = (await subscriptionByEndpoint(endpoint))!;
    expect(row.disabledAt).not.toBeNull();
    expect(row.disabledReason).toBe('session_revoked');

    const push = new PushService(ctx.db, ctx.queue);
    await push.enqueue({
      kind: 'session_new_device_login',
      userId: admin.id,
      idempotencyKey: 'test:revoked',
      payload: buildPushPayload({ kind: 'session_new_device_login' }),
    });
    await drainAll();
    expect(ctx.push.sent).toHaveLength(0);
    const delivery = await deliveryByKey('test:revoked');
    expect(delivery.status).toBe('failed');
    expect(delivery.lastErrorCode).toBe('NO_SUBSCRIPTIONS');
    expect(delivery.subscriptionsTargeted).toBe(0);
  });

  it('118b. Deaktivierung des Mitarbeiters ⇒ alle Sessions widerrufen ⇒ Subscriptions deaktiviert', async () => {
    const { admin } = await adminSession();
    const bernd = await makeEmployee(admin.id, 'Bernd');
    const endpoint = endpointFor('bernd');
    await subscribe(bernd.cookie, endpoint);
    // Status-Änderung läuft über den App-Service (Route) – hier direkt über
    // den App-internen Auth-Pfad simuliert: Admin-Route „Mitarbeiter sperren“.
    const { cookie: adminCookie } = {
      cookie: (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie,
    };
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/users/${bernd.user.id}/status`,
      headers: { cookie: adminCookie },
      payload: { status: 'disabled' },
    });
    expect([200, 204]).toContain(response.statusCode);
    const row = (await subscriptionByEndpoint(endpoint))!;
    expect(row.disabledAt).not.toBeNull();
    expect(['session_revoked', 'user_inactive']).toContain(row.disabledReason);
  });

  it('119. Push-Dienst antwortet 404/410 ⇒ Subscription deaktiviert (gone); Zustellung failed', async () => {
    const { admin, cookie } = await adminSession();
    const endpoint = endpointFor('gone');
    await subscribe(cookie, endpoint);
    await drainAll(); // Login-Hinweis des Admins zuerst zustellen (noch erfolgreich)
    ctx.push.setBehaviour(endpoint, 'gone');
    const push = new PushService(ctx.db, ctx.queue);
    await push.enqueue({
      kind: 'session_new_device_login',
      userId: admin.id,
      idempotencyKey: 'test:gone',
      payload: buildPushPayload({ kind: 'session_new_device_login' }),
    });
    await drainAll();
    const row = (await subscriptionByEndpoint(endpoint))!;
    expect(row.disabledReason).toBe('gone');
    const delivery = await deliveryByKey('test:gone');
    expect(delivery.status).toBe('failed');
    expect(delivery.subscriptionsTargeted).toBe(1);
    expect(delivery.subscriptionsSucceeded).toBe(0);
    expect(outcomeFromStatusCode(404)).toEqual({ outcome: 'gone' });
    expect(outcomeFromStatusCode(410)).toEqual({ outcome: 'gone' });
    expect(outcomeFromStatusCode(201)).toEqual({ outcome: 'sent' });
    expect(outcomeFromStatusCode(429).outcome).toBe('transient_error');
    expect(outcomeFromStatusCode(503).outcome).toBe('transient_error');
    expect(outcomeFromStatusCode(400).outcome).toBe('permanent_error');
    expect(outcomeFromStatusCode(403).outcome).toBe('permanent_error');
    expect(outcomeFromStatusCode(413).outcome).toBe('permanent_error');
  });

  it('119b. Erfolg ⇒ sent + lastSuccessAt; Dedupe über Idempotenzschlüssel; transient ⇒ Retry (pending)', async () => {
    const { admin, cookie } = await adminSession();
    const endpoint = endpointFor('ok');
    await subscribe(cookie, endpoint);
    const push = new PushService(ctx.db, ctx.queue);
    const first = await push.enqueue({
      kind: 'session_new_device_login',
      userId: admin.id,
      idempotencyKey: 'test:dedupe',
      payload: buildPushPayload({ kind: 'session_new_device_login' }),
    });
    const second = await push.enqueue({
      kind: 'session_new_device_login',
      userId: admin.id,
      idempotencyKey: 'test:dedupe',
      payload: buildPushPayload({ kind: 'session_new_device_login' }),
    });
    expect(second.deduplicated).toBe(true);
    expect(second.deliveryId).toBe(first.deliveryId);
    await drainAll();
    expect(sentOf('session_new_device_login').length).toBeGreaterThanOrEqual(1);
    const delivery = await deliveryByKey('test:dedupe');
    expect(delivery.status).toBe('sent');
    expect(delivery.subscriptionsSucceeded).toBe(1);
    expect((await subscriptionByEndpoint(endpoint))!.lastSuccessAt).not.toBeNull();

    ctx.push.setBehaviour(endpoint, 'transient');
    await push.enqueue({
      kind: 'session_new_device_login',
      userId: admin.id,
      idempotencyKey: 'test:transient',
      payload: buildPushPayload({ kind: 'session_new_device_login' }),
    });
    await drainAll();
    const pending = await deliveryByKey('test:transient');
    expect(pending.status).toBe('pending');
    expect(pending.lastErrorCode).toBe('HTTP_503');
    const jobs = await ctx.pool.query(
      "SELECT status, attempts FROM integration_jobs WHERE type = 'push.send' ORDER BY created_at",
    );
    expect(jobs.rows.at(-1)).toMatchObject({ status: 'pending', attempts: 1 });
  });
});

describe('120. VAPID-Konfiguration (production)', () => {
  it('120. production + PUSH_VAPID_* ⇒ WebPushGateway; Fake in production verboten; Private Key nie in Status/Log', async () => {
    const { admin } = await adminSession();
    const keys = webpush.generateVAPIDKeys();
    const productionConfig = loadConfig({
      APP_ENV: 'production',
      DATABASE_URL: ctx.config.databaseUrl,
      AUTH_SECRET_KEY: '1'.repeat(64),
      COMMUNICATION_PAYLOAD_KEY: 'c1'.repeat(32),
      STORAGE_DRIVER: 'fs',
      STORAGE_FS_ROOT: ctx.config.storage.driver === 'fs' ? ctx.config.storage.fsRoot : '/tmp/x',
      LOG_LEVEL: 'error',
      PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
      PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
      PUSH_VAPID_SUBJECT: 'mailto:it@miet-royal.example',
    });
    expect(productionConfig.push.enabled).toBe(true);
    const gateway = createPushGateway(productionConfig);
    expect(gateway).toBeInstanceOf(WebPushGateway);
    expect(gateway.kind).toBe('web_push');
    expect(createPushGateway(ctx.config)).toBeInstanceOf(DisabledPushGateway);

    expect(() =>
      buildApp({
        config: { ...productionConfig, auth: ctx.config.auth },
        pool: ctx.pool,
        mailAdapter: ctx.mail,
        rateLimitEnabled: false,
        storage: ctx.storage,
        pushGateway: new FakePushGateway(),
      }),
    ).toThrow(/FakePushGateway/);

    const status = await pushStatusSummary(ctx.db, productionConfig);
    expect(status).toEqual({ enabled: true, vapidPublicKey: keys.publicKey, activeDevices: 0 });
    expect(JSON.stringify(status)).not.toContain(keys.privateKey);
    expect(JSON.stringify(productionConfig.push)).toContain(keys.privateKey); // nur im Config-Objekt
    expect(logText()).not.toContain(keys.privateKey);
    void admin;
  });

  it('120b. Unvollständige PUSH_VAPID_*-Konfiguration wird abgelehnt (fail-closed)', () => {
    expect(() =>
      loadConfig({
        APP_ENV: 'development',
        DATABASE_URL: ctx.config.databaseUrl,
        LOG_LEVEL: 'error',
        PUSH_VAPID_PUBLIC_KEY: 'only-public',
      }),
    ).toThrow(/PUSH_VAPID_PRIVATE_KEY/);
  });
});

describe('121.–122. Datenminimierung & notificationclick-URL', () => {
  it('121. buildPushPayload kennt nur Vorgangsnummer/Terminart; Kundendaten der Fixture erscheinen nie', async () => {
    const { admin } = await adminSession();
    const anna = await makeEmployee(admin.id, 'Anna');
    const now = new Date();
    const world = await bookingWithTimes(admin.id, anna.user.id, {
      outbound: new Date(now.getTime() + 30 * MINUTES),
      inbound: null,
    });
    await scannerFor().scanDue(now);
    const rows = await deliveries('appointment_1h');
    expect(rows).toHaveLength(1);
    const json = JSON.stringify(rows[0]!.payload);
    for (const forbidden of ['Klara', 'Kommerz', '9998877', 'klara.kommerz', 'Lieferweg', '€']) {
      expect(json).not.toContain(forbidden);
    }
    expect(rows[0]!.payload).toMatchObject({
      kind: 'appointment_1h',
      title: 'Termin in 1 Stunde',
      url: `/vorgaenge/${world.processId}/termine`,
    });
    expect((rows[0]!.payload as { body: string }).body).toMatch(/^Abholung MR-\d{4}-\d{4}$/);
    // Keine freien Textfelder: falsche Vorgangsnummern werden abgelehnt.
    expect(() =>
      buildPushPayload({
        kind: 'return_overdue',
        processId: world.processId,
        processNumber: 'Klara Kommerz 0171',
      }),
    ).toThrow();
    // Die Nutzlast-Signatur hat keinen Parameter für Namen/Telefon/Beträge.
    const payloadKeys = Object.keys(buildPushPayload({ kind: 'session_new_device_login' })).sort();
    expect(payloadKeys).toEqual(['body', 'kind', 'tag', 'title', 'url']);
  });

  it('122. notificationclick-URL ist ein relativer Staff-Pfad (Vorgang/Termine bzw. Mitarbeiter)', () => {
    const processId = '11111111-1111-4111-8111-111111111111';
    expect(
      buildPushPayload({ kind: 'return_overdue', processId, processNumber: 'MR-2026-0001' }).url,
    ).toBe(`/vorgaenge/${processId}/termine`);
    expect(buildPushPayload({ kind: 'session_new_device_login' }).url).toBe('/mitarbeiter');
    expect(
      buildPushPayload({ kind: 'return_overdue', processId, processNumber: 'MR-2026-0001' }).body,
    ).toBe('MR-2026-0001 – in Miet-Royal prüfen');
    for (const kind of PUSH_KINDS) {
      const payload =
        kind === 'appointment_1h' || kind === 'assignment_reassigned'
          ? buildPushPayload({
              kind,
              processId,
              processNumber: 'MR-2026-0001',
              appointmentKind: 'return',
            })
          : kind === 'session_new_device_login' || kind === 'substitution_started'
            ? buildPushPayload({ kind })
            : buildPushPayload({ kind, processId, processNumber: 'MR-2026-0001' });
      expect(payload.url.startsWith('/')).toBe(true);
      expect(payload.url.startsWith('//')).toBe(false);
    }
  });
});

describe('123.–128. 1h-Regel: Pickup/Delivery/Return, Vertretung, Reschedule, Reassignment', () => {
  it('123./124./125. Genau ein Push je Termin 1 h vorher an die effektive Zuständigkeit; ungeplant nie; zweiter Scan no-op', async () => {
    const { admin } = await adminSession();
    const anna = await makeEmployee(admin.id, 'Anna');
    const now = new Date();
    const pickupWorld = await bookingWithTimes(admin.id, anna.user.id, {
      outbound: new Date(now.getTime() + 30 * MINUTES),
      inbound: new Date(now.getTime() + 55 * MINUTES),
    });
    const deliveryWorld = await bookingWithTimes(
      admin.id,
      anna.user.id,
      { outbound: new Date(now.getTime() + 40 * MINUTES), inbound: null },
      'delivery',
    );
    // Termin außerhalb des Fensters (2 h) und ungeplanter Termin (Delivery-Rückgabe).
    await bookingWithTimes(admin.id, anna.user.id, {
      outbound: new Date(now.getTime() + 2 * HOURS),
      inbound: null,
    });
    const summary = await scannerFor().scanDue(now);
    expect(summary.appointment1h).toBe(3);
    const rows = await deliveries('appointment_1h');
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.userId === anna.user.id)).toBe(true);
    const bodies = rows.map((row) => (row.payload as { body: string }).body).sort();
    expect(bodies[0]).toMatch(/^Abholung MR-/);
    expect(bodies[1]).toMatch(/^Lieferung MR-/);
    expect(bodies[2]).toMatch(/^Rückgabe MR-/);
    const reminders = await ctx.db.select().from(appointmentReminders);
    expect(reminders).toHaveLength(3);
    expect(reminders.every((r) => r.kind === 'push_1_hour' && r.pushDeliveryId !== null)).toBe(
      true,
    );
    expect(
      (
        await ctx.db.select().from(appointments).where(eq(appointments.id, pickupWorld.outboundId))
      )[0]!.reminderSentAt,
    ).not.toBeNull();
    // Versand über den Job an Annas Gerät.
    await subscribe(anna.cookie, endpointFor('anna'));
    await drainAll();
    expect(sentOf('appointment_1h')).toHaveLength(3);
    expect(sentOf('appointment_1h').every((s) => s.endpoint === endpointFor('anna'))).toBe(true);

    const again = await scannerFor().scanDue(new Date(now.getTime() + 2 * MINUTES));
    expect(again.appointment1h).toBe(0);
    expect(await deliveries('appointment_1h')).toHaveLength(3);
    void deliveryWorld;
  });

  it('126. Vertretung: Vertreter bekommt den 1h-Push und den Vertretungs-Hinweis, Original nicht', async () => {
    const { admin } = await adminSession();
    const anna = await makeEmployee(admin.id, 'Anna');
    const bernd = await makeEmployee(admin.id, 'Bernd');
    const now = new Date();
    await bookingWithTimes(admin.id, anna.user.id, {
      outbound: new Date(now.getTime() + 30 * MINUTES),
      inbound: null,
    });
    const substitution = await substitutionServiceFor(ctx).create(admin.id, {
      originalUserId: anna.user.id,
      substituteUserId: bernd.user.id,
      startsAt: new Date(now.getTime() - 10 * MINUTES),
      endsAt: new Date(now.getTime() + 3 * DAYS),
    });
    const summary = await scannerFor().scanDue(now);
    expect(summary.appointment1h).toBe(1);
    expect(summary.substitutionStarted).toBe(1);
    const reminderRows = await deliveries('appointment_1h');
    expect(reminderRows).toHaveLength(1);
    expect(reminderRows[0]!.userId).toBe(bernd.user.id);
    const substitutionRows = await deliveries('substitution_started');
    expect(substitutionRows).toHaveLength(1);
    expect(substitutionRows[0]!.userId).toBe(bernd.user.id);
    expect(substitutionRows[0]!.idempotencyKey).toBe(pushKeys.substitution(substitution.id));
    expect((await deliveries()).some((row) => row.userId === anna.user.id)).toBe(false);
    // Zweiter Scan: Vertretungs-Hinweis nicht erneut.
    const again = await scannerFor().scanDue(new Date(now.getTime() + 5 * MINUTES));
    expect(again.substitutionStarted).toBe(0);
  });

  it('127. Reschedule: alter Fingerprint bleibt no-op, neue Zeit im Fenster ⇒ neuer Push; außerhalb ⇒ keiner', async () => {
    const { admin } = await adminSession();
    const anna = await makeEmployee(admin.id, 'Anna');
    const now = new Date();
    const world = await bookingWithTimes(admin.id, anna.user.id, {
      outbound: new Date(now.getTime() + 30 * MINUTES),
      inbound: null,
    });
    await scannerFor().scanDue(now);
    expect(await deliveries('appointment_1h')).toHaveLength(1);

    const first = await world.scheduling.byId(world.outboundId);
    await world.scheduling.reschedule(admin.id, world.outboundId, {
      startAt: new Date(now.getTime() + 45 * MINUTES),
      endAt: null,
      expectedVersion: first.version,
    });
    await scannerFor().scanDue(now);
    const afterReschedule = await deliveries('appointment_1h');
    expect(afterReschedule).toHaveLength(2);
    expect(new Set(afterReschedule.map((row) => row.idempotencyKey)).size).toBe(2);
    expect(await ctx.db.select().from(appointmentReminders)).toHaveLength(2);

    const second = await world.scheduling.byId(world.outboundId);
    await world.scheduling.reschedule(admin.id, world.outboundId, {
      startAt: new Date(now.getTime() + 5 * HOURS),
      endAt: null,
      expectedVersion: second.version,
    });
    const summary = await scannerFor().scanDue(now);
    expect(summary.appointment1h).toBe(0);
    expect(await deliveries('appointment_1h')).toHaveLength(2);
  });

  it('128. Kurzfristige Neuzuweisung: neuer Mitarbeiter bekommt den Push, alter nicht erneut', async () => {
    const { admin } = await adminSession();
    const anna = await makeEmployee(admin.id, 'Anna');
    const bernd = await makeEmployee(admin.id, 'Bernd');
    const now = new Date();
    const world = await bookingWithTimes(admin.id, anna.user.id, {
      outbound: new Date(now.getTime() + 30 * MINUTES),
      inbound: null,
    });
    await scannerFor().scanDue(now);
    const current = await world.scheduling.byId(world.outboundId);
    await world.scheduling.assign(
      admin.id,
      world.outboundId,
      { userId: bernd.user.id, expectedVersion: current.version },
      await ctx.auth.effectivePermissions(admin.id),
    );
    await scannerFor().scanDue(new Date(now.getTime() + 1 * MINUTES));
    const rows = await deliveries('appointment_1h');
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.userId === anna.user.id)).toHaveLength(1);
    expect(rows.filter((row) => row.userId === bernd.user.id)).toHaveLength(1);
    await scannerFor().scanDue(new Date(now.getTime() + 2 * MINUTES));
    expect(await deliveries('appointment_1h')).toHaveLength(2);

    // Eigene Benachrichtigung „kurzfristig zugewiesen“ (Order §31, Phase-4-Feld
    // assignmentNotifiedAt): genau einmal an Bernd, nie an Anna; danach markiert.
    const reassigned = await deliveries('assignment_reassigned');
    expect(reassigned).toHaveLength(1);
    expect(reassigned[0]!.userId).toBe(bernd.user.id);
    expect(reassigned[0]!.payload).toMatchObject({
      kind: 'assignment_reassigned',
      title: 'Kurzfristig zugewiesen',
      url: `/vorgaenge/${world.processId}/termine`,
    });
    expect(JSON.stringify(reassigned[0]!.payload)).toMatch(/^.*Abholung MR-\d{4}-\d{4,}.*$/);
    const afterNotify = await world.scheduling.byId(world.outboundId);
    expect(afterNotify.assignmentNotifiedAt).not.toBeNull();

    // Erneute Neuzuweisung am selben Tag ⇒ neue Benachrichtigung an die neue Person.
    const carla = await makeEmployee(admin.id, 'Carla');
    await world.scheduling.assign(
      admin.id,
      world.outboundId,
      { userId: carla.user.id, expectedVersion: afterNotify.version },
      await ctx.auth.effectivePermissions(admin.id),
    );
    await scannerFor().scanDue(new Date(now.getTime() + 3 * MINUTES));
    await scannerFor().scanDue(new Date(now.getTime() + 4 * MINUTES));
    const all = await deliveries('assignment_reassigned');
    expect(all).toHaveLength(2);
    expect(all.filter((row) => row.userId === carla.user.id)).toHaveLength(1);
    expect(all.filter((row) => row.userId === anna.user.id)).toHaveLength(0);
  });

  it('128b. Erstzuweisung (kein Wechsel) und Neuzuweisung an einem anderen Tag lösen keine Kurzfrist-Benachrichtigung aus', async () => {
    const { admin } = await adminSession();
    const anna = await makeEmployee(admin.id, 'Anna');
    const bernd = await makeEmployee(admin.id, 'Bernd');
    const now = new Date();
    const world = await bookingWithTimes(admin.id, anna.user.id, {
      outbound: new Date(now.getTime() + 3 * DAYS),
      inbound: null,
    });
    const current = await world.scheduling.byId(world.outboundId);
    await world.scheduling.assign(
      admin.id,
      world.outboundId,
      { userId: bernd.user.id, expectedVersion: current.version },
      await ctx.auth.effectivePermissions(admin.id),
    );
    await scannerFor().scanDue(now);
    expect(await deliveries('assignment_reassigned')).toHaveLength(0);
  });
});

describe('129.–131. Overdue, Maschinenrisiko initial + 6 h, neues Gerät', () => {
  it('129. Überfällige Rückgabe: genau EIN Push je Incident an Planung/Admin (nicht an normale Mitarbeitende)', async () => {
    const { admin } = await adminSession();
    const anna = await makeEmployee(admin.id, 'Anna');
    const planner = await makeEmployee(admin.id, 'Paula', ['calendar.view', 'calendar.view_all']);
    const now = new Date();
    await bookingWithTimes(admin.id, anna.user.id, {
      outbound: new Date(now.getTime() - 2 * DAYS),
      inbound: new Date(now.getTime() - 2 * HOURS),
    });
    const summary = await scannerFor().scanDue(now);
    expect(summary.returnOverdue).toBe(1);
    const rows = await deliveries('return_overdue');
    expect(rows.map((row) => row.userId).sort()).toEqual([admin.id, planner.user.id].sort());
    expect(rows.some((row) => row.userId === anna.user.id)).toBe(false);
    expect((rows[0]!.payload as { body: string }).body).toMatch(
      /^MR-\d{4}-\d{4} – in Miet-Royal prüfen$/,
    );
    const incidents = await ctx.db.select().from(appointmentOverdueIncidents);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.adminNotifiedAt).not.toBeNull();
    const again = await scannerFor().scanDue(new Date(now.getTime() + 30 * MINUTES));
    expect(again.returnOverdue).toBe(0);
    expect(await deliveries('return_overdue')).toHaveLength(2);
  });

  it('130. Maschinenrisiko: ein Push bei Entstehung, genau EINE Erinnerung nach 6 h, danach nie mehr', async () => {
    const { admin } = await adminSession();
    const effective = await ctx.auth.effectivePermissions(admin.id);
    const services = handoverServicesFor(ctx);
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    const world = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 1 * DAYS),
      to: new Date(Date.now() + 3 * DAYS),
    });
    await services.handover.ensureForBooking(world.bookingId, admin.id);
    const slot = (await services.assignments.slotsForBooking(world.bookingId))[0]!;
    await services.assignments.assign(admin.id, effective, slot.id, machine.id, null);
    await services.machineService.createBlock(machine.id, admin.id, {
      startsAt: new Date(Date.now() + 1 * DAYS),
      endsAt: new Date(Date.now() + 2 * DAYS),
      reason: 'Wartung',
    });
    await services.assignments.refreshRiskIncidents();
    const incidents = await ctx.db.select().from(machineRiskIncidents);
    expect(incidents).toHaveLength(1);

    const now = new Date();
    const first = await scannerFor().scanDue(now);
    expect(first.machineRisk).toBe(1);
    expect(first.machineRisk6h).toBe(0);
    expect(await deliveries('machine_risk')).toHaveLength(1);
    expect((await deliveries('machine_risk'))[0]!.idempotencyKey).toBe(
      pushKeys.machineRisk(incidents[0]!.id, admin.id),
    );
    const after = (await ctx.db.select().from(machineRiskIncidents))[0]!;
    expect(after.adminNotifiedAt).not.toBeNull();
    expect(after.followUpDueAt!.getTime()).toBe(now.getTime() + 6 * HOURS);

    const tooEarly = await scannerFor().scanDue(new Date(now.getTime() + 5 * HOURS));
    expect(tooEarly.machineRisk6h).toBe(0);
    const due = await scannerFor().scanDue(new Date(now.getTime() + 6 * HOURS + 1));
    expect(due.machineRisk).toBe(0);
    expect(due.machineRisk6h).toBe(1);
    expect(await deliveries('machine_risk_6h')).toHaveLength(1);
    const later = await scannerFor().scanDue(new Date(now.getTime() + 20 * HOURS));
    expect(later.machineRisk6h).toBe(0);
    expect(await deliveries('machine_risk_6h')).toHaveLength(1);
    expect(await deliveries('machine_risk')).toHaveLength(1);
  });

  it('131. Neues Gerät ⇒ sofort ein Admin-Security-Push (employee.manage), bekanntes Gerät nicht; Scan dupliziert nicht', async () => {
    const { admin, cookie } = await adminSession(UA_WINDOWS);
    // Ohne registriertes Admin-Gerät entsteht KEINE Zustellung (Queue bleibt frei).
    expect(await deliveries('session_new_device_login')).toHaveLength(0);
    await subscribe(cookie, endpointFor('admin-security'));
    // Phase-12-Finalisierung: Geräteidentität = Geräte-Cookie (nicht der
    // User-Agent). Login von Anna ohne Cookie (neues Gerät) ⇒ Admin-Push.
    await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Anna',
      lastName: 'Test',
      email: 'anna@test.example',
      password: 'anna-passwort-1234',
    });
    const annaLaptop = await login(ctx.app, 'anna@test.example', 'anna-passwort-1234', UA_WINDOWS);
    expect(annaLaptop.deviceCookie).toMatch(/^mr_staff_device=/);
    const afterAnna = await deliveries('session_new_device_login');
    expect(afterAnna).toHaveLength(1);
    expect(afterAnna[0]!.userId).toBe(admin.id);
    const annaRow = afterAnna[0]!;
    expect((annaRow.payload as { body: string }).body).toBe(
      'Neue Anmeldung von einem neuen Gerät – in Miet-Royal prüfen',
    );
    expect(JSON.stringify(annaRow.payload)).not.toContain('Anna');

    // Gleiches Gerät (gleiches Geräte-Cookie) erneut – auch mit anderem
    // User-Agent: kein weiterer Push.
    await login(ctx.app, 'anna@test.example', 'anna-passwort-1234', UA_WINDOWS, {
      deviceCookie: annaLaptop.deviceCookie,
    });
    await login(ctx.app, 'anna@test.example', 'anna-passwort-1234', UA_IPHONE, {
      deviceCookie: annaLaptop.deviceCookie,
    });
    expect(await deliveries('session_new_device_login')).toHaveLength(1);
    // Anderes Gerät (Browser ohne Geräte-Cookie): ein weiterer Push.
    await login(ctx.app, 'anna@test.example', 'anna-passwort-1234', UA_IPHONE);
    expect(await deliveries('session_new_device_login')).toHaveLength(2);
    // Backstop-Scan: holt nur das Admin-Login VOR der Geräteregistrierung nach
    // (eigener Schlüssel je Session) und erzeugt keine Duplikate.
    const summary = await scannerFor().scanDue(new Date());
    expect(summary.newDevice).toBe(1);
    expect(await deliveries('session_new_device_login')).toHaveLength(3);
    const again = await scannerFor().scanDue(new Date());
    expect(again.newDevice).toBe(0);
    expect(await deliveries('session_new_device_login')).toHaveLength(3);
  });
});

describe('132.–133. Keine Reinigungs-Pushes, keine Touren', () => {
  it('132. Reinigung > 24 h ist KEINE Push-Art (Order §31)', () => {
    expect(PUSH_KINDS.some((kind) => /clean|reinig/i.test(kind))).toBe(false);
    const scanner = scannerFor();
    expect(Object.keys(scanner).some((key) => /clean|reinig/i.test(key))).toBe(false);
  });

  it('133. Touren existieren nicht: tour.delay_risk ist nur Grenzkonstante, kein PushKind', () => {
    expect(PUSH_KINDS).not.toContain('tour.delay_risk' as never);
    expect(PUSH_KINDS.some((kind) => /tour/i.test(kind))).toBe(false);
  });
});

describe('134.–136. Hijack: fremder Endpoint, fremde Session, Logs', () => {
  it('134. Fremder Endpoint: zweiter User übernimmt das Gerät – erster sieht/erreicht es nicht mehr', async () => {
    const { admin, cookie: adminCookie } = await adminSession();
    const anna = await makeEmployee(admin.id, 'Anna');
    const endpoint = endpointFor('shared');
    await subscribe(adminCookie, endpoint, 'Admin-Gerät');
    await subscribe(anna.cookie, endpoint, 'Annas Gerät');
    const rows = await ctx.db.select().from(pushSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(anna.user.id);
    const adminList = await ctx.app.inject({
      method: 'GET',
      url: '/staff/push/subscriptions',
      headers: { cookie: adminCookie },
    });
    expect(adminList.json().devices).toEqual([]);
    const push = new PushService(ctx.db, ctx.queue);
    await push.enqueue({
      kind: 'session_new_device_login',
      userId: admin.id,
      idempotencyKey: 'test:admin-after-reassign',
      payload: buildPushPayload({ kind: 'session_new_device_login' }),
    });
    await push.enqueue({
      kind: 'substitution_started',
      userId: anna.user.id,
      idempotencyKey: 'test:anna-after-reassign',
      payload: buildPushPayload({ kind: 'substitution_started' }),
    });
    await drainAll();
    expect(sentOf('substitution_started')).toHaveLength(1);
    expect(ctx.push.sent.every((record) => record.endpoint === endpoint)).toBe(true);
    expect(ctx.push.sent.every((record) => record.payload.kind === 'substitution_started')).toBe(
      true,
    );
  });

  it('135. Fremde Session: andere Nutzer können eine Subscription weder abschalten noch sehen', async () => {
    // Phase 12 Finalisierung: Die frühere Abmelde-Route (DELETE
    // /staff/push/subscriptions/current) existiert nicht mehr (kein Push-Opt-out,
    // Pflichttest P1) – weder für fremde noch für die eigene Subscription.
    const { admin, cookie: adminCookie } = await adminSession();
    const anna = await makeEmployee(admin.id, 'Anna');
    const endpoint = endpointFor('admin-only');
    await subscribe(adminCookie, endpoint);
    for (const cookie of [anna.cookie, adminCookie]) {
      const removed = await ctx.app.inject({
        method: 'DELETE',
        url: '/staff/push/subscriptions/current',
        headers: { cookie },
        payload: { endpoint },
      });
      expect(removed.statusCode).toBe(404);
    }
    expect((await subscriptionByEndpoint(endpoint))!.disabledAt).toBeNull();
    const foreignStatus = await ctx.app.inject({
      method: 'POST',
      url: '/staff/push/subscriptions/status',
      headers: { cookie: anna.cookie },
      payload: { endpoint },
    });
    expect(foreignStatus.json()).toEqual({ active: false });
    const ownStatus = await ctx.app.inject({
      method: 'POST',
      url: '/staff/push/subscriptions/status',
      headers: { cookie: adminCookie },
      payload: { endpoint },
    });
    expect(ownStatus.json()).toEqual({ active: true });
    // Ein neuer Sitzungs-Cookie eines anderen Users kann keine fremde Session-ID vorgeben:
    // die Bindung entsteht ausschließlich serverseitig aus der eigenen Session.
    const subs = new PushSubscriptionService(ctx.db);
    expect(await subs.listOwn(anna.user.id, 'ffffffff-ffff-4fff-8fff-ffffffffffff')).toEqual([]);
  });

  it('136. Endpoint und Schlüssel erscheinen nie im Serverlog', async () => {
    const { cookie } = await adminSession();
    const endpoint = endpointFor('logcheck');
    await subscribe(cookie, endpoint);
    ctx.push.setBehaviour(endpoint, 'transient');
    const push = new PushService(ctx.db, ctx.queue);
    const admin = (await ctx.db.select().from(pushSubscriptions))[0]!;
    await push.enqueue({
      kind: 'session_new_device_login',
      userId: admin.userId,
      idempotencyKey: 'test:log',
      payload: buildPushPayload({ kind: 'session_new_device_login' }),
    });
    await drainAll();
    const log = logText();
    expect(log).toContain('/staff/push/subscriptions');
    expect(log).not.toContain(endpoint);
    expect(log).not.toContain('push.example.test');
    expect(log).not.toContain(KEYS.auth);
    expect(log).not.toContain(KEYS.p256dh);
  });
});
