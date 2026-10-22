/**
 * Phase 12 Finalisierung – Punkt 4 (Auftrag P1–P10, hier „PB1–PB10“ zur
 * Unterscheidung von den bestehenden P1–P17 in
 * communication-push-final.integration.test.ts): Push nach Session-Ablauf
 * automatisch wieder anbinden.
 *
 * Der Client (apps/staff/lib/push-rebind.ts) registriert nach Login/App-Start
 * die vorhandene Browser-Subscription über den BESTEHENDEN Registrierpfad
 * POST /staff/push/subscriptions. Diese Tests treiben das echte Client-Modul
 * gegen die echte Route (Fake-Browser: granted + getSubscription()) und
 * belegen, dass der Server KEIN neues Sicherheitsmodell braucht:
 * angemeldeter User + aktuelle Session, Endpoint-Allowlist (B10),
 * Schlüssel-Validierung, Reaktivierung nur über den Registrierpfad,
 * Fremdübernahme nur nach der bestehenden Regel (vollständige Subscription).
 * Client-Unit-Tests (PB2–PB6 ohne Server): staff-push-rebind.test.ts.
 */
import { createECDH, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { loadConfig } from '@mietroyal/config';
import { pushDeliveries, pushSubscriptions, staffSessions } from '@mietroyal/database';
import { asc, eq } from 'drizzle-orm';
import webpush from 'web-push';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rebindExistingPushSubscription, type PushRebindEnv } from '../../staff/lib/push-rebind.ts';
import { buildApp } from '../src/app.ts';
import { isSessionExpiredByInactivity } from '../src/auth/service.ts';
import { WebPushGateway } from '../src/communication/push/gateways.ts';
import { buildPushPayload } from '../src/communication/push/payload.ts';
import { PushService } from '../src/communication/push/push-service.ts';
import { createPushSendHandler } from '../src/communication/push/send-job.ts';
import { PushSubscriptionService } from '../src/communication/push/subscription-service.ts';
import { PUSH_SEND_JOB_TYPE } from '../src/communication/types.ts';
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

let ctx: TestContext;
const logChunks: string[] = [];
const logDestination = new Writable({
  write(chunk, _encoding, callback) {
    logChunks.push(String(chunk));
    callback();
  },
});

beforeAll(async () => {
  ctx = await createTestContext({ logDestination, logLevel: 'info' });
});
afterAll(async () => {
  await ctx.pool.query('TRUNCATE push_deliveries, push_subscriptions, integration_jobs CASCADE');
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await ctx.pool.query('TRUNCATE push_deliveries, push_subscriptions, integration_jobs CASCADE');
  await truncateAuthTables(ctx.pool);
  ctx.push.reset();
  logChunks.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

const DAYS = 24 * 60 * 60 * 1000;

/** Echte Schlüsselform eines Browsers (P-256-Public-Key + 16-Byte-Auth, base64url). */
function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
}

/** Endpoint eines bekannten Push-Dienstes (Allowlist B10, in jeder Umgebung zulässig). */
function endpointFor(label: string): string {
  return `https://fcm.googleapis.com/fcm/send/rebind-${label}-${'e'.repeat(40)}`;
}

type BrowserSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

/**
 * Fake-Browser für das ECHTE Client-Modul: Berechtigung erteilt, Service
 * Worker registriert, getSubscription() liefert die vorhandene Subscription;
 * `register` geht über die echte Route (bestehender Registrierpfad).
 */
function browserEnv(
  cookie: string,
  subscription: BrowserSubscription,
  app = ctx.app,
): { env: PushRebindEnv; statusCodes: number[] } {
  const statusCodes: number[] = [];
  const env: PushRebindEnv = {
    supported: true,
    online: true,
    notification: { permission: 'granted' },
    serviceWorker: {
      getRegistration: async () => ({
        pushManager: {
          getSubscription: async () => ({
            endpoint: subscription.endpoint,
            toJSON: () => ({ endpoint: subscription.endpoint, keys: { ...subscription.keys } }),
          }),
        },
      }),
    },
    register: async (body) => {
      const response = await app.inject({
        method: 'POST',
        url: '/staff/push/subscriptions',
        headers: cookie === '' ? {} : { cookie },
        payload: body,
      });
      statusCodes.push(response.statusCode);
      return { ok: response.statusCode >= 200 && response.statusCode < 300 };
    },
    userAgentLabel: () => 'Android-Handy · Chrome',
  };
  return { env, statusCodes };
}

/** Erstregistrierung wie nach dem Klick „Push-Benachrichtigungen aktivieren“. */
async function subscribeByClick(cookie: string, subscription: BrowserSubscription) {
  return ctx.app.inject({
    method: 'POST',
    url: '/staff/push/subscriptions',
    headers: { cookie },
    payload: { ...subscription, userAgentLabel: 'Android-Handy · Chrome' },
  });
}

async function employee(adminId: string, name: string) {
  const password = `${name.toLowerCase()}-passwort-1234`;
  const user = await createEmployeeWithPassword(ctx, adminId, {
    firstName: name,
    lastName: 'Rebind',
    email: `${name.toLowerCase()}@rebind.example`,
    password,
  });
  const session = await login(ctx.app, user.email, password);
  return { user, cookie: session.cookie, password, deviceCookie: session.deviceCookie };
}

async function sessionsOf(userId: string) {
  return ctx.db
    .select()
    .from(staffSessions)
    .where(eq(staffSessions.userId, userId))
    .orderBy(asc(staffSessions.createdAt));
}

async function subscriptionByEndpoint(endpoint: string) {
  const rows = await ctx.db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint));
  return rows[0];
}

async function pushStatus(cookie: string, endpoint: string): Promise<boolean> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/staff/push/subscriptions/status',
    headers: { cookie },
    payload: { endpoint },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { active: boolean }).active;
}

async function enqueueTestPush(userId: string, key: string) {
  return new PushService(ctx.db, ctx.queue).enqueue({
    kind: 'substitution_started',
    userId,
    idempotencyKey: key,
    payload: buildPushPayload({ kind: 'substitution_started' }),
  });
}

async function drainAll(): Promise<void> {
  while ((await ctx.jobs.runOnce()) !== 'idle') {
    // weiter
  }
}

async function deliveryByKey(key: string) {
  const rows = await ctx.db
    .select()
    .from(pushDeliveries)
    .where(eq(pushDeliveries.idempotencyKey, key));
  return rows[0];
}

function sentTo(endpoint: string) {
  return ctx.push
    .forEndpoint(endpoint)
    .filter((record) => record.payload.kind === 'substitution_started');
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

/**
 * Bernd hat Push per Klick aktiviert (S1). Danach läuft S1 per Inaktivität ab
 * (31 Tage nie vorgezeigt) – Ausgangslage des automatischen Wiederanbindens.
 */
async function expiredWorld(label: string) {
  const admin = await bootstrapAdmin(ctx);
  const bernd = await employee(admin.id, 'Bernd');
  const subscription = { endpoint: endpointFor(label), keys: browserKeys() };
  expect((await subscribeByClick(bernd.cookie, subscription)).statusCode).toBe(200);
  const [s1] = await sessionsOf(bernd.user.id);
  const created = await subscriptionByEndpoint(subscription.endpoint);
  expect(created).toMatchObject({ userId: bernd.user.id, sessionId: s1!.id, disabledAt: null });
  const staleAt = new Date(Date.now() - 31 * DAYS);
  expect(isSessionExpiredByInactivity(staleAt, new Date())).toBe(true);
  await ctx.db
    .update(staffSessions)
    .set({ lastActivityAt: staleAt })
    .where(eq(staffSessions.id, s1!.id));
  return { admin, bernd, subscription, s1Id: s1!.id, subscriptionId: created!.id };
}

/** Session-Ablauf ⇒ technisch deaktiviert; danach erneuter Login (S2) + automatisches Rebind. */
async function reboundWorld(label: string) {
  const w = await expiredWorld(label);
  await enqueueTestPush(w.bernd.user.id, `rebind:${label}:expired`);
  await drainAll();
  expect((await subscriptionByEndpoint(w.subscription.endpoint))!.disabledReason).toBe(
    'session_expired',
  );
  const second = await login(ctx.app, w.bernd.user.email, w.bernd.password, undefined, {
    deviceCookie: w.bernd.deviceCookie,
  });
  expect(second.statusCode).toBe(200);
  const s2 = (await sessionsOf(w.bernd.user.id)).find((session) => session.id !== w.s1Id)!;
  const browser = browserEnv(second.cookie, w.subscription);
  const result = await rebindExistingPushSubscription(browser.env);
  return { ...w, second, s2Id: s2.id, result, statusCodes: browser.statusCodes };
}

// ═══════════════════════════════════════════════════════════════════════════
// PB1–PB3: Ablauf ⇒ deaktiviert; Re-Login + Rebind ⇒ reaktiviert, Push kommt an
// ═══════════════════════════════════════════════════════════════════════════

describe('PB1–PB3: Session-Ablauf und automatisches Wiederanbinden', () => {
  it('PB1. Session läuft per Inaktivität ab ⇒ Server-Subscription technisch deaktiviert (session_expired), kein Push; die abgelaufene Session kann nichts (wieder) registrieren', async () => {
    const w = await expiredWorld('pb1');
    await enqueueTestPush(w.bernd.user.id, 'rebind:pb1');
    await drainAll();
    expect(sentTo(w.subscription.endpoint)).toHaveLength(0);
    expect(await subscriptionByEndpoint(w.subscription.endpoint)).toMatchObject({
      disabledReason: 'session_expired',
      sessionId: w.s1Id,
    });
    expect((await deliveryByKey('rebind:pb1'))!.lastErrorCode).toBe('NO_SUBSCRIPTIONS');

    // Das automatische Rebind mit dem abgelaufenen Cookie scheitert still (401), nichts ändert sich.
    const stale = browserEnv(w.bernd.cookie, w.subscription);
    expect(await rebindExistingPushSubscription(stale.env)).toBe('failed');
    expect(stale.statusCodes).toEqual([401]);
    // Ohne Session-Cookie ebenso.
    const anonymous = browserEnv('', w.subscription);
    expect(await rebindExistingPushSubscription(anonymous.env)).toBe('failed');
    expect(anonymous.statusCodes).toEqual([401]);
    expect(await subscriptionByEndpoint(w.subscription.endpoint)).toMatchObject({
      disabledReason: 'session_expired',
      sessionId: w.s1Id,
    });
  });

  it('PB2. Erneuter Login (S2) allein reaktiviert nicht; das automatische Re-Register derselben echten Subscription (granted + getSubscription) ⇒ reaktiviert, dieselbe Zeile, an S2 gebunden, Status aktiv', async () => {
    const w = await expiredWorld('pb2');
    await enqueueTestPush(w.bernd.user.id, 'rebind:pb2:expired');
    await drainAll();
    const second = await login(ctx.app, w.bernd.user.email, w.bernd.password, undefined, {
      deviceCookie: w.bernd.deviceCookie,
    });
    expect(second.statusCode).toBe(200);
    const s2 = (await sessionsOf(w.bernd.user.id)).find((session) => session.id !== w.s1Id)!;
    // Login allein: deaktivierte Abos bleiben deaktiviert (P13), Status zeigt „aktivieren“.
    expect((await subscriptionByEndpoint(w.subscription.endpoint))!.disabledReason).toBe(
      'session_expired',
    );
    expect(await pushStatus(second.cookie, w.subscription.endpoint)).toBe(false);

    const browser = browserEnv(second.cookie, w.subscription);
    expect(await rebindExistingPushSubscription(browser.env)).toBe('rebound');
    expect(browser.statusCodes).toEqual([200]);
    const row = await subscriptionByEndpoint(w.subscription.endpoint);
    expect(row).toMatchObject({
      id: w.subscriptionId,
      userId: w.bernd.user.id,
      sessionId: s2.id,
      p256dh: w.subscription.keys.p256dh,
      auth: w.subscription.keys.auth,
      disabledAt: null,
      disabledReason: null,
    });
    expect(await pushStatus(second.cookie, w.subscription.endpoint)).toBe(true);
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/staff/push/subscriptions',
      headers: { cookie: second.cookie },
    });
    expect(list.json().devices).toEqual([
      expect.objectContaining({ id: w.subscriptionId, currentSession: true }),
    ]);
    // Endpoint/Schlüssel weder in Antworten noch im Log.
    expect(list.body).not.toContain(w.subscription.endpoint);
    const logs = logChunks.join('');
    expect(logs).not.toContain(w.subscription.endpoint);
    expect(logs).not.toContain(w.subscription.keys.p256dh);
    expect(logs).not.toContain(w.subscription.keys.auth);
  });

  it('PB3. Danach ist Push ohne weiteren Schritt wieder aktiv: der Fake-Push-Dienst erhält den nächsten Push; ein Logout von S2 deaktiviert das Abo (Bindung an die aktuelle Session)', async () => {
    const w = await reboundWorld('pb3');
    expect(w.result).toBe('rebound');
    await enqueueTestPush(w.bernd.user.id, 'rebind:pb3');
    await drainAll();
    expect(sentTo(w.subscription.endpoint)).toHaveLength(1);
    expect((await deliveryByKey('rebind:pb3'))!.status).toBe('sent');
    // Die alte Session S1 spielt keine Rolle mehr: Bindung hängt an S2.
    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: w.second.cookie },
    });
    expect(logout.statusCode).toBe(200);
    expect(await subscriptionByEndpoint(w.subscription.endpoint)).toMatchObject({
      sessionId: w.s2Id,
      disabledReason: 'session_revoked',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PB7: fremder User – Allowlist, Schlüssel, bestehende Übernahmeregel
// ═══════════════════════════════════════════════════════════════════════════

describe('PB7: fremder User / gefälschte Subscription', () => {
  it('PB7. production: gefälschter Endpoint (nicht auf der Allowlist) ⇒ 400 PUSH_ENDPOINT_NOT_ALLOWED; unvollständige/ungültige Schlüssel ⇒ 400; Statusroute übernimmt nie; nur eine vollständige gültige Subscription ⇒ bestehende Übernahmeregel (Zeile wechselt zu Anna, an Annas Session gebunden, Historie zurückgesetzt)', async () => {
    const w = await reboundWorld('pb7');
    expect(w.result).toBe('rebound');
    await ctx.db
      .update(pushSubscriptions)
      .set({ lastSuccessAt: new Date() })
      .where(eq(pushSubscriptions.id, w.subscriptionId));
    const before = (await subscriptionByEndpoint(w.subscription.endpoint))!;
    const anna = await employee(w.admin.id, 'Anna');
    const app = productionApp();
    await app.ready();
    try {
      const post = (payload: unknown) =>
        app.inject({
          method: 'POST',
          url: '/staff/push/subscriptions',
          headers: { cookie: anna.cookie },
          payload: payload as Record<string, unknown>,
        });
      // (a) gefälschter Endpoint (fremder Host) – auch über das Client-Modul.
      for (const endpoint of [
        'https://push.example.test/send/forged-endpoint-0123456789',
        'https://169.254.169.254/latest/meta-data/x',
        'https://fcm.googleapis.com.evil.example/fcm/send/x',
      ]) {
        const forged = browserEnv(anna.cookie, { endpoint, keys: browserKeys() }, app);
        expect(await rebindExistingPushSubscription(forged.env), endpoint).toBe('failed');
        expect(forged.statusCodes, endpoint).toEqual([400]);
        const rejected = await post({ endpoint, keys: browserKeys() });
        expect(rejected.json().error.code).toBe('PUSH_ENDPOINT_NOT_ALLOWED');
        expect(rejected.body).not.toContain(endpoint);
      }
      // (b) Bernds echter Endpoint, aber unvollständige/ungültige Schlüssel ⇒ 400.
      const valid = browserKeys();
      for (const keys of [
        undefined,
        {},
        { p256dh: valid.p256dh },
        { auth: valid.auth },
        { p256dh: 'zu-kurz', auth: valid.auth },
        { p256dh: valid.p256dh, auth: 'kurz' },
        { p256dh: `${valid.p256dh}+/=`, auth: valid.auth },
        { p256dh: valid.p256dh, auth: '' },
      ]) {
        const response = await post({ endpoint: w.subscription.endpoint, keys });
        expect(response.statusCode, JSON.stringify(keys)).toBe(400);
      }
      // (c) Statusroute mit fremdem Endpoint: false, nichts geändert (B1).
      const status = await app.inject({
        method: 'POST',
        url: '/staff/push/subscriptions/status',
        headers: { cookie: anna.cookie },
        payload: { endpoint: w.subscription.endpoint },
      });
      expect(status.json()).toEqual({ active: false });
      expect(await subscriptionByEndpoint(w.subscription.endpoint)).toEqual(before);

      // (d) Bestehende Regel: vollständige, gültige Subscription mit Bernds Endpoint
      // (gleicher Browser, Anna meldet sich dort an) ⇒ Zeile wechselt zu Anna.
      const annaKeys = browserKeys();
      const takeover = browserEnv(
        anna.cookie,
        { endpoint: w.subscription.endpoint, keys: annaKeys },
        app,
      );
      expect(await rebindExistingPushSubscription(takeover.env)).toBe('rebound');
      const [annaSession] = await sessionsOf(anna.user.id);
      const after = (await subscriptionByEndpoint(w.subscription.endpoint))!;
      expect(after).toMatchObject({
        id: before.id,
        userId: anna.user.id,
        sessionId: annaSession!.id,
        p256dh: annaKeys.p256dh,
        auth: annaKeys.auth,
        disabledAt: null,
        lastSuccessAt: null,
      });
      expect(after.createdAt.getTime()).toBeGreaterThanOrEqual(before.createdAt.getTime());
    } finally {
      await app.close();
    }
    // Bernd erreicht das Gerät nicht mehr und sieht es nicht mehr; Anna schon.
    const berndList = await ctx.app.inject({
      method: 'GET',
      url: '/staff/push/subscriptions',
      headers: { cookie: w.second.cookie },
    });
    expect(berndList.json().devices).toEqual([]);
    expect(await pushStatus(w.second.cookie, w.subscription.endpoint)).toBe(false);
    await enqueueTestPush(w.bernd.user.id, 'rebind:pb7:bernd');
    await enqueueTestPush(anna.user.id, 'rebind:pb7:anna');
    await drainAll();
    expect((await deliveryByKey('rebind:pb7:bernd'))!.lastErrorCode).toBe('NO_SUBSCRIPTIONS');
    expect((await deliveryByKey('rebind:pb7:anna'))!.status).toBe('sent');
    expect(sentTo(w.subscription.endpoint)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PB8–PB10: technische Deaktivierung bleibt, kein Opt-out
// ═══════════════════════════════════════════════════════════════════════════

describe('PB8–PB10: Deaktivierung bleibt, kein Opt-out', () => {
  it('PB8. Logout deaktiviert weiterhin (session_revoked, kein Push); erst der nächste Login + automatisches Rebind bindet an die neue Session', async () => {
    const w = await reboundWorld('pb8');
    expect(w.result).toBe('rebound');
    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: w.second.cookie },
    });
    expect(logout.statusCode).toBe(200);
    expect((await subscriptionByEndpoint(w.subscription.endpoint))!.disabledReason).toBe(
      'session_revoked',
    );
    await enqueueTestPush(w.bernd.user.id, 'rebind:pb8:logout');
    await drainAll();
    expect(sentTo(w.subscription.endpoint)).toHaveLength(0);
    expect((await deliveryByKey('rebind:pb8:logout'))!.lastErrorCode).toBe('NO_SUBSCRIPTIONS');
    // Rebind mit dem abgemeldeten Cookie scheitert (401), bleibt deaktiviert.
    const stale = browserEnv(w.second.cookie, w.subscription);
    expect(await rebindExistingPushSubscription(stale.env)).toBe('failed');
    expect(stale.statusCodes).toEqual([401]);
    expect((await subscriptionByEndpoint(w.subscription.endpoint))!.disabledReason).toBe(
      'session_revoked',
    );

    const third = await login(ctx.app, w.bernd.user.email, w.bernd.password);
    const s3 = (await sessionsOf(w.bernd.user.id)).at(-1)!;
    const browser = browserEnv(third.cookie, w.subscription);
    expect(await rebindExistingPushSubscription(browser.env)).toBe('rebound');
    expect(await subscriptionByEndpoint(w.subscription.endpoint)).toMatchObject({
      sessionId: s3.id,
      disabledAt: null,
    });
    await enqueueTestPush(w.bernd.user.id, 'rebind:pb8:again');
    await drainAll();
    expect(sentTo(w.subscription.endpoint)).toHaveLength(1);
  });

  for (const statusCode of [404, 410] as const) {
    it(`PB9. Push-Dienst antwortet ${statusCode} (echtes WebPushGateway, Versand gemockt) ⇒ weiterhin technisch deaktiviert (gone); ein Rebind der vom Dienst aufgegebenen Subscription reaktiviert sie zwar, der nächste Versand deaktiviert sie wieder (kein Retry-Sturm)`, async () => {
      const w = await reboundWorld(`pb9-${statusCode}`);
      expect(w.result).toBe('rebound');
      const vapid = webpush.generateVAPIDKeys();
      const handler = createPushSendHandler({
        db: ctx.db,
        subscriptions: new PushSubscriptionService(ctx.db),
        gateway: new WebPushGateway(
          { subject: 'mailto:it@miet-royal.example', ...vapid },
          { appEnv: 'production' },
        ),
      });
      const send = vi
        .spyOn(webpush, 'sendNotification')
        .mockRejectedValue(
          Object.assign(new Error('Received unexpected response code'), { statusCode }),
        );
      const run = async (key: string) => {
        const { deliveryId } = await new PushService(ctx.db, ctx.queue).createDelivery({
          kind: 'substitution_started',
          userId: w.bernd.user.id,
          idempotencyKey: key,
          payload: buildPushPayload({ kind: 'substitution_started' }),
        });
        await handler({
          id: key,
          type: PUSH_SEND_JOB_TYPE,
          payload: { deliveryId },
          idempotencyKey: key,
          attempts: 1,
          maxAttempts: 5,
          claimedBy: 'rebind',
        });
        return deliveryId;
      };
      await run(`rebind:pb9:${statusCode}:first`);
      expect(send).toHaveBeenCalledTimes(1);
      expect((await subscriptionByEndpoint(w.subscription.endpoint))!.disabledReason).toBe('gone');
      expect(await deliveryByKey(`rebind:pb9:${statusCode}:first`)).toMatchObject({
        status: 'failed',
        lastErrorCode: 'GONE',
      });
      await run(`rebind:pb9:${statusCode}:second`);
      expect(send).toHaveBeenCalledTimes(1);

      // Grenze (dokumentiert): liefert der Browser die aufgegebene Subscription noch,
      // reaktiviert das Rebind sie – der nächste Versand deaktiviert sie erneut (genau
      // ein Gateway-Aufruf, kein Retry).
      const browser = browserEnv(w.second.cookie, w.subscription);
      expect(await rebindExistingPushSubscription(browser.env)).toBe('rebound');
      expect((await subscriptionByEndpoint(w.subscription.endpoint))!.disabledAt).toBeNull();
      await run(`rebind:pb9:${statusCode}:third`);
      expect(send).toHaveBeenCalledTimes(2);
      expect((await subscriptionByEndpoint(w.subscription.endpoint))!.disabledReason).toBe('gone');
    });
  }

  it('PB10. Kein Opt-out: keine DELETE/PUT/PATCH-Route unter /staff/push (Routentabelle), keine Abmelde-Pfade; Push-Routen nur Aktivieren, Status, eigene Geräte, VAPID-Key', async () => {
    for (const method of ['DELETE', 'PUT', 'PATCH'] as const) {
      expect(ctx.app.printRoutes({ method, commonPrefix: false }), method).not.toMatch(/push/i);
    }
    expect(ctx.app.printRoutes({ commonPrefix: false })).not.toMatch(
      /unsubscribe|opt-?out|abmelden|rebind/i,
    );
    for (const suffix of [
      'current',
      'unsubscribe',
      'disable',
      'pause',
      'mute',
      'opt-out',
      'rebind',
    ]) {
      for (const method of ['POST', 'DELETE', 'PUT', 'PATCH'] as const) {
        expect(
          ctx.app.hasRoute({ method, url: `/staff/push/subscriptions/${suffix}` }),
          `${method} ${suffix}`,
        ).toBe(false);
      }
    }
    expect(ctx.app.hasRoute({ method: 'POST', url: '/staff/push/subscriptions' })).toBe(true);
    expect(ctx.app.hasRoute({ method: 'GET', url: '/staff/push/subscriptions' })).toBe(true);
    expect(ctx.app.hasRoute({ method: 'POST', url: '/staff/push/subscriptions/status' })).toBe(
      true,
    );
    expect(ctx.app.hasRoute({ method: 'GET', url: '/staff/push/vapid-public-key' })).toBe(true);
    // Eine Session kann ein aktives Abo nicht über eine Route abmelden.
    const admin = await bootstrapAdmin(ctx);
    const { cookie } = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const subscription = { endpoint: endpointFor('pb10'), keys: browserKeys() };
    expect((await subscribeByClick(cookie, subscription)).statusCode).toBe(200);
    for (const method of ['DELETE', 'PUT', 'PATCH'] as const) {
      for (const url of ['/staff/push/subscriptions', '/staff/push/subscriptions/current']) {
        const response = await ctx.app.inject({
          method,
          url,
          headers: { cookie },
          payload: { endpoint: subscription.endpoint },
        });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
    }
    expect(await subscriptionByEndpoint(subscription.endpoint)).toMatchObject({
      userId: admin.id,
      disabledAt: null,
    });
  });
});
