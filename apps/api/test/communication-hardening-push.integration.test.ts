/**
 * Phase 12 Härtung (Review B) – Web Push: Regressionstests zu den Funden
 *  B10 SSRF über frei wählbaren Endpoint: außerhalb von development nur
 *      bekannte Push-Dienste; das WebPushGateway prüft vor jedem Versand
 *      erneut (Defense in depth) und baut zu internen Zielen keine Verbindung auf,
 *  B11 Sessions, die nach der Inaktivitätsregel der Auth abgelaufen sind,
 *      erhalten keine Pushes mehr,
 *  B14 1h-Push geht nach einem Absturz zwischen Reminder-Marke und Einreihen
 *      nicht verloren (erst Zustellung, dann Marke; Altbestand wird ergänzt).
 */
import { createECDH, randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { loadConfig } from '@mietroyal/config';
import {
  appointmentReminders,
  appointments,
  pushDeliveries,
  pushSubscriptions,
  staffSessions,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import webpush from 'web-push';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import {
  checkPushEndpoint,
  KNOWN_PUSH_SERVICE_HOSTS,
  PUSH_ENDPOINT_NOT_ALLOWED,
} from '../src/communication/push/endpoint-policy.ts';
import { WebPushGateway } from '../src/communication/push/gateways.ts';
import { buildPushPayload } from '../src/communication/push/payload.ts';
import { PushService } from '../src/communication/push/push-service.ts';
import {
  appointmentPushFingerprint,
  pushKeys,
  PushRuleScanner,
} from '../src/communication/push/rules.ts';
import { createPushSendHandler } from '../src/communication/push/send-job.ts';
import { PushSubscriptionService } from '../src/communication/push/subscription-service.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createTestContext,
  destroyTestContext,
  login,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { truncateCrmTables } from './crm-helpers.ts';
import {
  createAcceptedBooking,
  schedulingServiceFor,
  truncateSchedulingTables,
} from './scheduling-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.pool.query('TRUNCATE push_deliveries, push_subscriptions, integration_jobs CASCADE');
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await ctx.pool.query(
    'TRUNCATE push_deliveries, push_subscriptions, appointment_reminders, integration_jobs CASCADE',
  );
  await truncateSchedulingTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
  ctx.push.reset();
});

function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
}

async function adminWithCookie() {
  const admin = await bootstrapAdmin(ctx);
  const { cookie } = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  return { admin, cookie };
}

function productionApp() {
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
  return buildApp({
    config: { ...productionConfig, auth: ctx.config.auth },
    pool: ctx.pool,
    mailAdapter: ctx.mail,
    rateLimitEnabled: false,
    storage: ctx.storage,
    jobQueue: ctx.queue,
  });
}

const TOKEN = `send-${'t'.repeat(40)}`;

describe('Härtung Review B – Push-Endpoint (B10)', () => {
  it('B10. production: Endpoints interner Ziele (Link-Local/Loopback/privat/IP-Literal), fremde Hosts, Nicht-Standardports ⇒ 400, nichts gespeichert; bekannte Push-Dienste ⇒ registriert', async () => {
    const { cookie } = await adminWithCookie();
    const app = productionApp();
    await app.ready();
    try {
      const subscribe = (endpoint: string) =>
        app.inject({
          method: 'POST',
          url: '/staff/push/subscriptions',
          headers: { cookie },
          payload: { endpoint, keys: browserKeys() },
        });
      for (const endpoint of [
        'https://169.254.169.254/latest/meta-data/iam/x',
        'https://localhost:5432/',
        'https://10.0.0.5:8443/admin',
        'https://127.0.0.1/intern',
        'https://[::1]/intern',
        'https://[fe80::1]/intern',
        'https://192.168.1.10/push',
        'https://push.example.test/send/x',
        'https://fcm.googleapis.com.evil.example/fcm/send/x',
        'https://fcm.googleapis.com:8443/fcm/send/x',
        'https://notify.windows.com/w/?token=x',
      ]) {
        const rejected = await subscribe(endpoint);
        expect(rejected.statusCode, endpoint).toBe(400);
        expect(rejected.json().error.code).toBe('PUSH_ENDPOINT_NOT_ALLOWED');
        expect(rejected.body).not.toContain(endpoint);
      }
      expect(await ctx.db.select().from(pushSubscriptions)).toHaveLength(0);
      for (const endpoint of [
        `https://fcm.googleapis.com/fcm/send/${TOKEN}`,
        `https://updates.push.services.mozilla.com/wpush/v2/${TOKEN}`,
        `https://web.push.apple.com/${TOKEN}`,
        `https://wns2-db5p.notify.windows.com/w/?token=${TOKEN}`,
      ]) {
        expect((await subscribe(endpoint)).statusCode, endpoint).toBe(200);
      }
      expect(await ctx.db.select().from(pushSubscriptions)).toHaveLength(4);
    } finally {
      await app.close();
    }
  });

  it('B10b. Regel je Umgebung: staging/demo wie production; development erlaubt lokale Fakes (E2E-Push-Dienst https://localhost:<port>); überall nur https ohne Zugangsdaten', async () => {
    for (const host of KNOWN_PUSH_SERVICE_HOSTS) {
      expect(checkPushEndpoint(`https://${host}/x`, 'production')).toBeNull();
    }
    for (const env of ['production', 'staging', 'demo'] as const) {
      expect(checkPushEndpoint('https://localhost:4567/push/e2e', env)).toBe(
        PUSH_ENDPOINT_NOT_ALLOWED,
      );
      expect(checkPushEndpoint('https://100.64.0.1/x', env)).toBe(PUSH_ENDPOINT_NOT_ALLOWED);
      expect(checkPushEndpoint(`https://web.push.apple.com/${TOKEN}`, env)).toBeNull();
    }
    expect(checkPushEndpoint('https://localhost:4567/push/e2e', 'development')).toBeNull();
    expect(checkPushEndpoint('https://127.0.0.1:4567/push/e2e', 'development')).toBeNull();
    expect(checkPushEndpoint('http://localhost:4567/push/e2e', 'development')).toBe(
      PUSH_ENDPOINT_NOT_ALLOWED,
    );
    expect(checkPushEndpoint('https://user:pw@fcm.googleapis.com/x', 'production')).toBe(
      PUSH_ENDPOINT_NOT_ALLOWED,
    );

    // Route in development (Testkontext): lokaler Fake-Endpoint wird weiter akzeptiert.
    const { cookie } = await adminWithCookie();
    const local = await ctx.app.inject({
      method: 'POST',
      url: '/staff/push/subscriptions',
      headers: { cookie },
      payload: { endpoint: 'https://localhost:4567/push/e2e-device', keys: browserKeys() },
    });
    expect(local.statusCode).toBe(200);
  });

  it('B10c. Defense in depth: ein (Altbestand-)Endpoint auf 127.0.0.1 wird vom WebPushGateway (production) NICHT kontaktiert – kein Verbindungsaufbau, Subscription deaktiviert', async () => {
    const { admin, cookie } = await adminWithCookie();
    const sockets: Socket[] = [];
    let connections = 0;
    const server: Server = createServer((socket) => {
      connections += 1;
      sockets.push(socket);
      socket.on('data', () => socket.destroy());
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      // Registrierung im development-Testkontext (vor der Härtung so auch in production möglich).
      const target = await ctx.app.inject({
        method: 'POST',
        url: '/staff/push/subscriptions',
        headers: { cookie },
        payload: { endpoint: `https://127.0.0.1:${port}/intern`, keys: browserKeys() },
      });
      expect(target.statusCode).toBe(200);
      const service = new PushService(ctx.db, ctx.queue);
      const { deliveryId } = await service.enqueue({
        kind: 'substitution_started',
        userId: admin.id,
        idempotencyKey: 'hardening-b:ssrf',
        payload: buildPushPayload({ kind: 'substitution_started' }),
      });
      const vapid = webpush.generateVAPIDKeys();
      const handler = createPushSendHandler({
        db: ctx.db,
        subscriptions: new PushSubscriptionService(ctx.db),
        gateway: new WebPushGateway(
          {
            subject: 'mailto:review@test.example',
            publicKey: vapid.publicKey,
            privateKey: vapid.privateKey,
          },
          { appEnv: 'production' },
        ),
      });
      await handler({
        id: 'x',
        type: 'push.send',
        payload: { deliveryId },
        idempotencyKey: 'x',
        attempts: 1,
        maxAttempts: 5,
        claimedBy: 'hardening-b',
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(connections).toBe(0);
      const [row] = await ctx.db
        .select()
        .from(pushDeliveries)
        .where(eq(pushDeliveries.id, deliveryId));
      expect(row).toMatchObject({ status: 'failed', lastErrorCode: PUSH_ENDPOINT_NOT_ALLOWED });
      const [subscription] = await ctx.db.select().from(pushSubscriptions);
      expect(subscription!.disabledReason).toBe('endpoint_not_allowed');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('Härtung Review B – Sessions nach Inaktivität (B11)', () => {
  it('B11. Session seit > 30 Tagen inaktiv (nie wieder vorgezeigt, daher nicht widerrufen) bekommt KEINEN Push; Subscription deaktiviert (session_expired); aktive Session weiterhin', async () => {
    const { admin, cookie } = await adminWithCookie();
    const endpoint = `https://push.example.test/send/hardening-b-${'e'.repeat(40)}`;
    const subscribed = await ctx.app.inject({
      method: 'POST',
      url: '/staff/push/subscriptions',
      headers: { cookie },
      payload: { endpoint, keys: browserKeys() },
    });
    expect(subscribed.statusCode).toBe(200);
    const subscriptions = new PushSubscriptionService(ctx.db);
    expect(await subscriptions.hasActiveSubscription(admin.id)).toBe(true);
    await ctx.db
      .update(staffSessions)
      .set({ lastActivityAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(staffSessions.userId, admin.id));
    expect(await subscriptions.hasActiveSubscription(admin.id)).toBe(false);
    expect(await subscriptions.countActive()).toBe(0);
    await new PushService(ctx.db, ctx.queue).enqueue({
      kind: 'return_overdue',
      userId: admin.id,
      idempotencyKey: 'hardening-b:stale-session',
      payload: buildPushPayload({
        kind: 'return_overdue',
        processId: '00000000-0000-4000-8000-000000000001',
        processNumber: 'MR-2026-0001',
      }),
    });
    while ((await ctx.jobs.runOnce()) !== 'idle') {
      // weiter
    }
    expect(ctx.push.forEndpoint(endpoint)).toHaveLength(0);
    const [row] = await ctx.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint));
    expect(row!.disabledReason).toBe('session_expired');
    // Dieselbe Regel wie die Auth: die Session wird beim nächsten Request abgelehnt.
    const me = await ctx.app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);

    // Gegenprobe: frische Anmeldung (neue Session) ⇒ Push kommt an.
    const fresh = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const freshEndpoint = `https://push.example.test/send/hardening-b-fresh-${'f'.repeat(32)}`;
    await ctx.app.inject({
      method: 'POST',
      url: '/staff/push/subscriptions',
      headers: { cookie: fresh.cookie },
      payload: { endpoint: freshEndpoint, keys: browserKeys() },
    });
    await new PushService(ctx.db, ctx.queue).enqueue({
      kind: 'substitution_started',
      userId: admin.id,
      idempotencyKey: 'hardening-b:fresh-session',
      payload: buildPushPayload({ kind: 'substitution_started' }),
    });
    while ((await ctx.jobs.runOnce()) !== 'idle') {
      // weiter
    }
    expect(ctx.push.forEndpoint(freshEndpoint)).toHaveLength(1);
  });
});

describe('Härtung Review B – 1h-Push nach Absturz (B14)', () => {
  async function pickupInThirtyMinutes(adminId: string) {
    const world = await createAcceptedBooking(ctx, adminId, { assignProcessTo: adminId });
    const scheduling = schedulingServiceFor(ctx);
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    const rows = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.bookingId, world.bookingId));
    const pickup = rows.find((row) => row.kind === 'pickup')!;
    const startAt = new Date(Date.now() + 30 * 60_000);
    startAt.setUTCMilliseconds(0);
    await scheduling.reschedule(adminId, pickup.id, {
      startAt,
      endAt: null,
      expectedVersion: pickup.version,
    });
    return { pickupId: pickup.id, startAt };
  }

  const scanner = () =>
    new PushRuleScanner({ db: ctx.db, push: new PushService(ctx.db, ctx.queue), auth: ctx.auth });
  const oneHourPushes = async () =>
    (await ctx.db.select().from(pushDeliveries)).filter((row) => row.kind === 'appointment_1h');

  it('B14. Altbestand: Reminder-Marke ohne Push-Zustellung (Absturz vor der Härtung) ⇒ der nächste Scan reiht den 1h-Push genau einmal nach', async () => {
    const { admin } = await adminWithCookie();
    const { pickupId, startAt } = await pickupInThirtyMinutes(admin.id);
    const fingerprint = appointmentPushFingerprint(pickupId, startAt, admin.id);
    await ctx.db.insert(appointmentReminders).values({
      appointmentId: pickupId,
      kind: 'push_1_hour',
      fingerprint,
      dueAt: new Date(startAt.getTime() - 60 * 60_000),
    });
    expect(await scanner().scanAppointmentReminders(new Date())).toBe(1);
    expect(await scanner().scanAppointmentReminders(new Date())).toBe(0);
    const pushes = await oneHourPushes();
    expect(pushes).toHaveLength(1);
    const [marker] = await ctx.db.select().from(appointmentReminders);
    expect(marker!.pushDeliveryId).toBe(pushes[0]!.id);
    expect(marker!.sentAt).not.toBeNull();
  });

  it('B14b. Absturz nach dem Einreihen, vor der Marke ⇒ der nächste Scan dedupliziert über den Schlüssel (kein zweiter Push) und setzt die Marke; parallele Scans ⇒ genau ein Push', async () => {
    const { admin } = await adminWithCookie();
    const { pickupId, startAt } = await pickupInThirtyMinutes(admin.id);
    const fingerprint = appointmentPushFingerprint(pickupId, startAt, admin.id);
    // Zustand nach Absturz: Zustellung + Job existieren, Marke fehlt.
    const first = await new PushService(ctx.db, ctx.queue).enqueue({
      kind: 'appointment_1h',
      userId: admin.id,
      idempotencyKey: pushKeys.appointment1h(pickupId, fingerprint),
      payload: buildPushPayload({ kind: 'substitution_started' }),
    });
    expect(await ctx.db.select().from(appointmentReminders)).toHaveLength(0);
    const counts = await Promise.all([
      scanner().scanAppointmentReminders(new Date()),
      scanner().scanAppointmentReminders(new Date()),
      scanner().scanAppointmentReminders(new Date()),
    ]);
    expect(counts.reduce((sum, value) => sum + value, 0)).toBe(1);
    const pushes = await oneHourPushes();
    expect(pushes.map((row) => row.id)).toEqual([first.deliveryId]);
    const markers = await ctx.db.select().from(appointmentReminders);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.pushDeliveryId).toBe(first.deliveryId);
    const [appointment] = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.id, pickupId));
    expect(appointment!.reminderSentAt).not.toBeNull();
  });
});
