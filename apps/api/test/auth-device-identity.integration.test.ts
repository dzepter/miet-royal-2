/**
 * Phase-12-Finalisierung, Punkt 1 – stabile Geräteidentität (Pflichttests
 * D1–D13): „neues Gerät“ entscheidet ausschließlich das serverseitig
 * erzeugte HttpOnly-Cookie `mr_staff_device` (DB: nur SHA-256 in
 * `staff_known_devices` / `staff_login_challenges.device_token_hash`), nie der
 * User-Agent. Alle Loginpfade (Passwort, TOTP, Recovery, Ersteinrichtung)
 * tragen die Identität aus dem ersten Schritt über die Challenge bis zur
 * Session; genau ein `session.new_device_login` und genau ein Admin-Push je
 * (Mitarbeiter, Gerät) – auch bei parallelen Erst-Logins.
 */
import { Writable } from 'node:stream';
import { loadConfig, type AppConfig } from '@mietroyal/config';
import {
  pushDeliveries,
  staffKnownDevices,
  staffLoginChallenges,
  staffSecurityEvents,
  staffSessions,
} from '@mietroyal/database';
import fastifyCookie from '@fastify/cookie';
import { and, asc, eq } from 'drizzle-orm';
import Fastify from 'fastify';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import * as OTPAuth from 'otpauth';
import webpush from 'web-push';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { sha256Hex } from '../src/auth/crypto.ts';
import {
  DEVICE_COOKIE_MAX_AGE_SECONDS,
  DEVICE_COOKIE_NAME_DEVELOPMENT,
  DEVICE_COOKIE_NAME_HOST_PREFIXED,
  deviceCookieName,
  resolveDeviceToken,
} from '../src/auth/device.ts';
import { setDeviceCookie } from '../src/auth/http.ts';
import { PushService } from '../src/communication/push/push-service.ts';
import { PushRuleScanner, pushKeys } from '../src/communication/push/rules.ts';
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
const logText = () => logChunks.join('');

beforeAll(async () => {
  ctx = await createTestContext({ logDestination, logLevel: 'trace' });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await ctx.pool.query('TRUNCATE push_deliveries, push_subscriptions, integration_jobs CASCADE');
  await truncateAuthTables(ctx.pool);
  ctx.push.reset();
  logChunks.length = 0;
});

const UA_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1';
const LABEL_WINDOWS = 'Windows · Chrome';
const LABEL_IPHONE = 'iPhone · Safari';
const EMPLOYEE_EMAIL = 'max@test.example';
const EMPLOYEE_PASSWORD = 'max-mitarbeiter-passwort-1';
const PUSH_KEYS = { p256dh: 'BPk'.padEnd(87, 'A'), auth: 'auth-secret-16by' };
/**
 * Phase 12 (finale Geräteidentität): die D-Tests laufen gegen die
 * development-App des Testkontexts ⇒ Name über die zentrale Funktion.
 */
const DEVICE_COOKIE_NAME = deviceCookieName('development');

// ── Hilfen ──────────────────────────────────────────────────────────────────

async function employee(adminId: string, email = EMPLOYEE_EMAIL) {
  return createEmployeeWithPassword(ctx, adminId, {
    firstName: 'Max',
    lastName: 'Muster',
    email,
    password: EMPLOYEE_PASSWORD,
  });
}

/** Klartext aus `mr_staff_device=<wert>`. */
function tokenOf(deviceCookie: string): string {
  expect(deviceCookie.startsWith(`${DEVICE_COOKIE_NAME}=`)).toBe(true);
  return deviceCookie.slice(DEVICE_COOKIE_NAME.length + 1);
}

function deviceSetCookie(response: LightMyRequestResponse, name = DEVICE_COOKIE_NAME) {
  return response.cookies.find((cookie) => cookie.name === name);
}

async function knownDevices(userId: string) {
  return ctx.db
    .select()
    .from(staffKnownDevices)
    .where(eq(staffKnownDevices.userId, userId))
    .orderBy(asc(staffKnownDevices.firstSeenAt));
}

async function securityEvents(userId: string, type: string) {
  return ctx.db
    .select()
    .from(staffSecurityEvents)
    .where(and(eq(staffSecurityEvents.targetUserId, userId), eq(staffSecurityEvents.type, type)))
    .orderBy(asc(staffSecurityEvents.createdAt));
}

const newDeviceEvents = (userId: string) => securityEvents(userId, 'session.new_device_login');
const newDeviceFlag = (event: { details: unknown }) =>
  (event.details as { newDevice?: boolean }).newDevice === true;

function codeFor(secretBase32: string): string {
  return new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  }).generate();
}

/**
 * Gültiger TOTP-Code für einen weiteren Login innerhalb desselben 30-s-Fensters:
 * der Replay-Schutz (ein Zeitschritt nur einmal) wird NUR im Test
 * zurückgesetzt – er ist hier nicht Prüfgegenstand.
 */
async function freshTotpCode(userId: string, secret: string): Promise<string> {
  await ctx.pool.query('UPDATE staff_users SET totp_last_used_step = NULL WHERE id = $1', [userId]);
  return codeFor(secret);
}

/** 2FA direkt über den Service aktivieren (ohne Login ⇒ ohne Geräteeintrag). */
async function enableTotp(userId: string) {
  const user = await ctx.auth.findUserById(userId);
  const { secret } = await ctx.auth.beginTotpSetupForUser(user!);
  const { recoveryCodes } = await ctx.auth.confirmTotpSetupForUser(userId, codeFor(secret));
  return { secret, recoveryCodes };
}

async function postJson(url: string, payload: Record<string, unknown>, cookie?: string) {
  return ctx.app.inject({
    method: 'POST',
    url,
    payload,
    headers: { 'user-agent': UA_WINDOWS, ...(cookie === undefined ? {} : { cookie }) },
  });
}

async function challengeRow(challengeToken: string) {
  const rows = await ctx.db
    .select()
    .from(staffLoginChallenges)
    .where(eq(staffLoginChallenges.tokenHash, sha256Hex(challengeToken)));
  return rows[0]!;
}

function endpointFor(label: string): string {
  return `https://push.example.test/send/${label}-${'e'.repeat(40)}`;
}

async function subscribeAdminPush(cookie: string) {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/staff/push/subscriptions',
    headers: { cookie },
    payload: { endpoint: endpointFor('admin-security'), keys: PUSH_KEYS, userAgentLabel: 'Admin' },
  });
  expect(response.statusCode).toBe(200);
}

async function drainAll(): Promise<void> {
  while ((await ctx.jobs.runOnce()) !== 'idle') {
    // weiter
  }
}

function backstopScanner(): PushRuleScanner {
  return new PushRuleScanner({
    db: ctx.db,
    push: new PushService(ctx.db, ctx.queue),
    auth: ctx.auth,
  });
}

async function newDeviceDeliveries() {
  const rows = await ctx.db.select().from(pushDeliveries);
  return rows.filter((row) => row.kind === 'session_new_device_login');
}

// ── D1–D5: Passwort-Login ──────────────────────────────────────────────────

describe('D1. Erstes Gerät', () => {
  it('D1. Login ohne Geräte-Cookie ⇒ Server setzt mr_staff_device (32 Byte base64url, HttpOnly, SameSite=Strict, Path=/, 400 Tage), speichert nur den SHA-256 und schreibt genau ein session.new_device_login (ohne Hash/Cookie)', async () => {
    const admin = await bootstrapAdmin(ctx);
    const max = await employee(admin.id);

    // Fehlgeschlagener Login: kein Geräte-Cookie, nichts gespeichert.
    const failed = await postJson('/auth/login', { email: EMPLOYEE_EMAIL, password: 'falsch-123' });
    expect(failed.statusCode).toBe(401);
    expect(deviceSetCookie(failed)).toBeUndefined();
    expect(await knownDevices(max.id)).toHaveLength(0);

    const response = await postJson('/auth/login', {
      email: EMPLOYEE_EMAIL,
      password: EMPLOYEE_PASSWORD,
    });
    expect(response.statusCode).toBe(200);
    const cookie = deviceSetCookie(response);
    expect(cookie).toBeDefined();
    expect(cookie!.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(cookie!.value, 'base64url')).toHaveLength(32);
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite).toBe('Strict');
    expect(cookie!.path).toBe('/');
    expect(cookie!.maxAge).toBe(400 * 24 * 60 * 60);
    expect(DEVICE_COOKIE_MAX_AGE_SECONDS).toBeGreaterThan(30 * 24 * 60 * 60); // > Session
    expect(cookie!.secure).toBeFalsy(); // lokale development-Umgebung
    expect(cookie!.value).not.toBe(
      response.cookies.find((c) => c.name === 'mr_staff_session')!.value,
    );

    const devices = await knownDevices(max.id);
    expect(devices).toHaveLength(1);
    expect(devices[0]!.deviceTokenHash).toBe(sha256Hex(cookie!.value));
    expect(devices[0]!.displayLabel).toBe(LABEL_WINDOWS);

    const events = await newDeviceEvents(max.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.details).toEqual({ deviceLabel: LABEL_WINDOWS });
    const created = await securityEvents(max.id, 'session.created');
    expect(created.map((event) => event.details)).toEqual([
      { deviceLabel: LABEL_WINDOWS, newDevice: true },
    ]);
    expect(events[0]!.sessionId).toBe(created[0]!.sessionId);
    // staff_sessions.device_label bleibt die (reine) Anzeige aus dem User-Agent.
    const sessions = await ctx.db
      .select()
      .from(staffSessions)
      .where(eq(staffSessions.userId, max.id));
    expect(sessions.map((session) => session.deviceLabel)).toEqual([LABEL_WINDOWS]);
  });

  it('D1. Secure-Regel exakt wie beim Session-Cookie: Secure in production/staging/demo, nicht in development; production-Login setzt beide Cookies Secure', async () => {
    const issue = async (appEnv: AppConfig['appEnv']) => {
      const app = Fastify();
      await app.register(fastifyCookie);
      app.get('/probe', async (_request, reply) => {
        setDeviceCookie(reply, { appEnv } as AppConfig, resolveDeviceToken(undefined).token);
        return { ok: true };
      });
      const response = await app.inject({ method: 'GET', url: '/probe' });
      await app.close();
      // Phase 12: Name je Umgebung (`__Host-` außerhalb development).
      return deviceSetCookie(response, deviceCookieName(appEnv))!;
    };
    expect((await issue('development')).secure).toBeFalsy();
    for (const appEnv of ['production', 'staging', 'demo'] as const) {
      expect((await issue(appEnv)).secure, appEnv).toBe(true);
    }

    await bootstrapAdmin(ctx);
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
    const app = buildApp({
      config: { ...productionConfig, auth: ctx.config.auth },
      pool: ctx.pool,
      mailAdapter: ctx.mail,
      rateLimitEnabled: false,
      storage: ctx.storage,
      jobQueue: ctx.queue,
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
        headers: { 'user-agent': UA_WINDOWS },
      });
      expect(response.statusCode).toBe(200);
      const device = deviceSetCookie(response, deviceCookieName('production'))!;
      const session = response.cookies.find((c) => c.name === 'mr_staff_session')!;
      expect(device.secure).toBe(true);
      expect(session.secure).toBe(true);
      expect(device.httpOnly).toBe(true);
      expect(device.sameSite).toBe(session.sameSite);
      expect(device.path).toBe(session.path);
    } finally {
      await app.close();
    }
  });
});

describe('D2. Zweiter Login vom selben Gerät', () => {
  it('D2. gleiches Geräte-Cookie ⇒ kein weiteres Ereignis, nur last_seen_at; Cookie-Laufzeit wird mit demselben Wert erneuert', async () => {
    const admin = await bootstrapAdmin(ctx);
    const max = await employee(admin.id);
    const first = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS);
    const [before] = await knownDevices(max.id);
    await ctx.pool.query(
      `UPDATE staff_known_devices SET first_seen_at = now() - interval '2 days',
         last_seen_at = now() - interval '1 day' WHERE user_id = $1`,
      [max.id],
    );

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMPLOYEE_EMAIL, password: EMPLOYEE_PASSWORD },
      headers: { 'user-agent': UA_WINDOWS, cookie: first.deviceCookie },
    });
    expect(second.statusCode).toBe(200);
    expect(deviceSetCookie(second)!.value).toBe(tokenOf(first.deviceCookie));
    expect(deviceSetCookie(second)!.maxAge).toBe(DEVICE_COOKIE_MAX_AGE_SECONDS);

    const devices = await knownDevices(max.id);
    expect(devices).toHaveLength(1);
    expect(devices[0]!.id).toBe(before!.id);
    expect(Date.now() - devices[0]!.lastSeenAt.getTime()).toBeLessThan(60_000);
    expect(Date.now() - devices[0]!.firstSeenAt.getTime()).toBeGreaterThan(24 * 60 * 60_000);
    expect(await newDeviceEvents(max.id)).toHaveLength(1);
    const created = await securityEvents(max.id, 'session.created');
    expect(created.map((event) => newDeviceFlag(event))).toEqual([true, false]);
  });
});

describe('D3. Zwei Geräte-IDs mit gleichem User-Agent', () => {
  it('D3. zwei Browser ohne Cookie mit identischem User-Agent ⇒ zwei Geräte, zwei Ereignisse; danach beide bekannt', async () => {
    const admin = await bootstrapAdmin(ctx);
    const max = await employee(admin.id);
    const a = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS);
    const b = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS);
    expect(a.deviceCookie).not.toBe(b.deviceCookie);

    const devices = await knownDevices(max.id);
    expect(devices).toHaveLength(2);
    expect(devices.map((device) => device.deviceTokenHash).sort()).toEqual(
      [sha256Hex(tokenOf(a.deviceCookie)), sha256Hex(tokenOf(b.deviceCookie))].sort(),
    );
    expect(devices.map((device) => device.displayLabel)).toEqual([LABEL_WINDOWS, LABEL_WINDOWS]);
    expect(await newDeviceEvents(max.id)).toHaveLength(2);

    await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS, {
      deviceCookie: a.deviceCookie,
    });
    await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS, {
      deviceCookie: b.deviceCookie,
    });
    expect(await knownDevices(max.id)).toHaveLength(2);
    expect(await newDeviceEvents(max.id)).toHaveLength(2);
  });

  it('D3. Geräte sind je Mitarbeiter: dasselbe Cookie ist für eine andere Person ein neues Gerät', async () => {
    const admin = await bootstrapAdmin(ctx);
    const max = await employee(admin.id);
    const adminLogin = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD, UA_WINDOWS);
    await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS, {
      deviceCookie: adminLogin.deviceCookie,
    });
    expect(await newDeviceEvents(admin.id)).toHaveLength(1);
    expect(await newDeviceEvents(max.id)).toHaveLength(1);
    expect((await knownDevices(max.id))[0]!.deviceTokenHash).toBe(
      sha256Hex(tokenOf(adminLogin.deviceCookie)),
    );
  });
});

describe('D4. Gleiche Geräte-ID, anderer User-Agent', () => {
  it('D4. gleiches Cookie mit anderem User-Agent ⇒ bekannt (kein Ereignis); Anzeigename/Session-Label folgen dem User-Agent', async () => {
    const admin = await bootstrapAdmin(ctx);
    const max = await employee(admin.id);
    const first = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS);
    const second = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_IPHONE, {
      deviceCookie: first.deviceCookie,
    });
    expect(second.statusCode).toBe(200);
    expect(second.deviceCookie).toBe(first.deviceCookie);

    expect(await newDeviceEvents(max.id)).toHaveLength(1);
    const devices = await knownDevices(max.id);
    expect(devices).toHaveLength(1);
    expect(devices[0]!.displayLabel).toBe(LABEL_IPHONE);
    const sessions = await ctx.db
      .select()
      .from(staffSessions)
      .where(eq(staffSessions.userId, max.id))
      .orderBy(asc(staffSessions.createdAt));
    expect(sessions.map((session) => session.deviceLabel)).toEqual([LABEL_WINDOWS, LABEL_IPHONE]);
  });
});

describe('D5. Cookie gelöscht / ungültig; Logout und Widerruf', () => {
  it('D5. gelöschtes Cookie ⇒ neuer Wert, neues Gerät; ungültiges Cookie ⇒ verworfen (nie gespeichert), neuer Wert; Geräte-ID im Body wird ignoriert', async () => {
    const admin = await bootstrapAdmin(ctx);
    const max = await employee(admin.id);
    const first = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS);
    const firstToken = tokenOf(first.deviceCookie);

    // Cookie gelöscht (Browserdaten entfernt) ⇒ neues Gerät.
    const cleared = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS);
    expect(tokenOf(cleared.deviceCookie)).not.toBe(firstToken);
    expect(await newDeviceEvents(max.id)).toHaveLength(2);

    // Syntaktisch ungültige Werte ⇒ wie „kein Cookie“.
    for (const invalid of ['kaputt', `${firstToken}x`, `${firstToken.slice(0, 42)}+`, '']) {
      const response = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS, {
        deviceCookie: `${DEVICE_COOKIE_NAME}=${invalid}`,
      });
      expect(response.statusCode).toBe(200);
      const issued = tokenOf(response.deviceCookie);
      expect(issued).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(issued).not.toBe(invalid);
      const stored = await ctx.pool.query(
        'SELECT 1 FROM staff_known_devices WHERE device_token_hash = $1',
        [sha256Hex(invalid)],
      );
      expect(stored.rowCount).toBe(0);
    }
    expect(await newDeviceEvents(max.id)).toHaveLength(6);

    // Frei gewählte Geräte-ID im Body ⇒ ignoriert (nur das Cookie zählt).
    const viaBody = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: EMPLOYEE_EMAIL,
        password: EMPLOYEE_PASSWORD,
        deviceId: firstToken,
        deviceToken: firstToken,
        deviceTokenHash: sha256Hex(firstToken),
      },
      headers: { 'user-agent': UA_WINDOWS },
    });
    expect(viaBody.statusCode).toBe(200);
    expect(deviceSetCookie(viaBody)!.value).not.toBe(firstToken);
    expect(await newDeviceEvents(max.id)).toHaveLength(7);
    expect(await knownDevices(max.id)).toHaveLength(7);
  });

  it('D5. Logout löscht das Geräte-Cookie NICHT; nach Logout und nach Session-Widerruf bleibt das Gerät bekannt', async () => {
    const admin = await bootstrapAdmin(ctx);
    const max = await employee(admin.id);
    const first = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS);

    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: `${first.cookie}; ${first.deviceCookie}` },
      payload: {},
    });
    expect(logout.statusCode).toBe(200);
    expect(deviceSetCookie(logout)).toBeUndefined();

    const afterLogout = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS, {
      deviceCookie: first.deviceCookie,
    });
    expect(afterLogout.statusCode).toBe(200);
    expect(await newDeviceEvents(max.id)).toHaveLength(1);

    // Widerruf (einzeln und „alle Geräte“) lässt das Gerät bekannt.
    const sessions = await ctx.admin.listUserSessions(max.id);
    await ctx.auth.revokeSessionById(sessions[0]!.id, 'test', admin.id);
    await ctx.auth.revokeAllSessions(max.id, 'test', admin.id);
    const afterRevoke = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS, {
      deviceCookie: first.deviceCookie,
    });
    expect(afterRevoke.statusCode).toBe(200);
    expect(await newDeviceEvents(max.id)).toHaveLength(1);
    expect(await knownDevices(max.id)).toHaveLength(1);

    // Das Geräte-Cookie ist kein Auth-Token: allein öffnet es nichts.
    const meWithDeviceOnly = await ctx.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: first.deviceCookie },
    });
    expect(meWithDeviceOnly.statusCode).toBe(401);
  });
});

// ── D6–D8: zweistufige Loginpfade ──────────────────────────────────────────

describe('D6. TOTP-Login', () => {
  it('D6. Geräte-Hash aus Schritt 1 reist über die Challenge zur Session – ein abweichendes/fehlendes Cookie in Schritt 2 ändert die Identität nicht', async () => {
    const admin = await bootstrapAdmin(ctx);
    const max = await employee(admin.id);
    const { secret } = await enableTotp(max.id);
    const other = resolveDeviceToken(undefined).token; // gültiges, aber fremdes Cookie

    const step1 = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS);
    expect(step1.body.next).toBe('totp_required');
    expect(step1.cookie).toBe(''); // noch keine Session
    const token = tokenOf(step1.deviceCookie); // Cookie schon nach bestandener Passwortprüfung
    const challengeToken = step1.body.challengeToken as string;
    expect((await challengeRow(challengeToken)).deviceTokenHash).toBe(sha256Hex(token));
    // Gerät wird erst mit der Session registriert.
    expect(await knownDevices(max.id)).toHaveLength(0);
    expect(await newDeviceEvents(max.id)).toHaveLength(0);

    const step2 = await postJson(
      '/auth/login/totp',
      { challengeToken, code: await freshTotpCode(max.id, secret) },
      `${DEVICE_COOKIE_NAME}=${other}`,
    );
    expect(step2.statusCode).toBe(200);
    expect(deviceSetCookie(step2)).toBeUndefined();
    const devices = await knownDevices(max.id);
    expect(devices.map((device) => device.deviceTokenHash)).toEqual([sha256Hex(token)]);
    expect(await newDeviceEvents(max.id)).toHaveLength(1);

    // Gleiches Gerät erneut (Schritt 2 ganz ohne Cookie) ⇒ bekannt.
    const again1 = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_IPHONE, {
      deviceCookie: step1.deviceCookie,
    });
    const again2 = await postJson('/auth/login/totp', {
      challengeToken: again1.body.challengeToken as string,
      code: await freshTotpCode(max.id, secret),
    });
    expect(again2.statusCode).toBe(200);
    expect(await newDeviceEvents(max.id)).toHaveLength(1);
    expect(await knownDevices(max.id)).toHaveLength(1);

    // Das fremde Cookie aus Schritt 2 wurde nie registriert ⇒ in Schritt 1 neu.
    const foreign1 = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS, {
      deviceCookie: `${DEVICE_COOKIE_NAME}=${other}`,
    });
    await postJson('/auth/login/totp', {
      challengeToken: foreign1.body.challengeToken as string,
      code: await freshTotpCode(max.id, secret),
    });
    expect(await newDeviceEvents(max.id)).toHaveLength(2);
  });

  it('D6. Challenge ohne Geräteidentität (Altbestand vor dem Rollout) ⇒ neutral ungültig, keine Session', async () => {
    const admin = await bootstrapAdmin(ctx);
    const max = await employee(admin.id);
    const { secret } = await enableTotp(max.id);
    const step1 = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD);
    const challengeToken = step1.body.challengeToken as string;
    await ctx.pool.query(
      'UPDATE staff_login_challenges SET device_token_hash = NULL WHERE token_hash = $1',
      [sha256Hex(challengeToken)],
    );
    const step2 = await postJson('/auth/login/totp', {
      challengeToken,
      code: await freshTotpCode(max.id, secret),
    });
    expect(step2.statusCode).toBe(401);
    expect(step2.cookies.find((c) => c.name === 'mr_staff_session')).toBeUndefined();
    expect(await knownDevices(max.id)).toHaveLength(0);
  });
});

describe('D7. Recovery-Code-Login', () => {
  it('D7. Recovery-Login registriert genau das Gerät aus Schritt 1; bekanntes Gerät ⇒ kein Ereignis, neues ⇒ eines', async () => {
    const admin = await bootstrapAdmin(ctx);
    const max = await employee(admin.id);
    const { recoveryCodes } = await enableTotp(max.id);

    const step1 = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS);
    const token = tokenOf(step1.deviceCookie);
    const recovered = await postJson(
      '/auth/login/recovery',
      { challengeToken: step1.body.challengeToken as string, recoveryCode: recoveryCodes[0]! },
      `${DEVICE_COOKIE_NAME}=${resolveDeviceToken(undefined).token}`,
    );
    expect(recovered.statusCode).toBe(200);
    expect(deviceSetCookie(recovered)).toBeUndefined();
    expect((await knownDevices(max.id)).map((device) => device.deviceTokenHash)).toEqual([
      sha256Hex(token),
    ]);
    expect(await newDeviceEvents(max.id)).toHaveLength(1);
    expect(await securityEvents(max.id, 'twofa.recovery_code_used')).toHaveLength(1);

    const known1 = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS, {
      deviceCookie: step1.deviceCookie,
    });
    const known2 = await postJson('/auth/login/recovery', {
      challengeToken: known1.body.challengeToken as string,
      recoveryCode: recoveryCodes[1]!,
    });
    expect(known2.statusCode).toBe(200);
    expect(await newDeviceEvents(max.id)).toHaveLength(1);

    const fresh1 = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS);
    const fresh2 = await postJson('/auth/login/recovery', {
      challengeToken: fresh1.body.challengeToken as string,
      recoveryCode: recoveryCodes[2]!,
    });
    expect(fresh2.statusCode).toBe(200);
    expect(await newDeviceEvents(max.id)).toHaveLength(2);
    expect(await knownDevices(max.id)).toHaveLength(2);
  });
});

describe('D8. Erzwungene TOTP-Ersteinrichtung', () => {
  it('D8. Setup-Challenge trägt den Geräte-Hash; Abschluss der Einrichtung registriert genau dieses Gerät; der nächste (TOTP-)Login von dort ist bekannt', async () => {
    const admin = await bootstrapAdmin(ctx);
    const max = await employee(admin.id);
    await ctx.admin.setTotpRequirement(admin.id, max.id, true);

    const step1 = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS);
    expect(step1.body.next).toBe('totp_setup_required');
    expect(step1.cookie).toBe('');
    const token = tokenOf(step1.deviceCookie);
    const challengeToken = step1.body.challengeToken as string;
    expect((await challengeRow(challengeToken)).deviceTokenHash).toBe(sha256Hex(token));

    const begin = await postJson('/auth/totp/setup/begin', { challengeToken });
    expect(begin.statusCode).toBe(200);
    expect(deviceSetCookie(begin)).toBeUndefined();
    const { secret } = begin.json() as { secret: string };
    const confirm = await postJson('/auth/totp/setup/confirm', {
      challengeToken,
      code: codeFor(secret),
    });
    expect(confirm.statusCode).toBe(200);
    expect(deviceSetCookie(confirm)).toBeUndefined();
    expect((await knownDevices(max.id)).map((device) => device.deviceTokenHash)).toEqual([
      sha256Hex(token),
    ]);
    expect(await newDeviceEvents(max.id)).toHaveLength(1);

    const next1 = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS, {
      deviceCookie: step1.deviceCookie,
    });
    expect(next1.body.next).toBe('totp_required');
    const next2 = await postJson('/auth/login/totp', {
      challengeToken: next1.body.challengeToken as string,
      code: await freshTotpCode(max.id, secret),
    });
    expect(next2.statusCode).toBe(200);
    expect(await newDeviceEvents(max.id)).toHaveLength(1);
    expect(await knownDevices(max.id)).toHaveLength(1);
  });
});

// ── D9: Parallelität ────────────────────────────────────────────────────────

describe('D9. Paralleler Erst-Login', () => {
  it('D9. acht gleichzeitige Erst-Logins desselben Geräts ⇒ genau ein Geräteeintrag und genau ein session.new_device_login (acht Sessions)', async () => {
    const admin = await bootstrapAdmin(ctx);
    const max = await employee(admin.id);
    const deviceCookie = `${DEVICE_COOKIE_NAME}=${resolveDeviceToken(undefined).token}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        login(
          ctx.app,
          EMPLOYEE_EMAIL,
          EMPLOYEE_PASSWORD,
          index % 2 === 0 ? UA_WINDOWS : UA_IPHONE,
          {
            deviceCookie,
          },
        ),
      ),
    );
    expect(results.map((result) => result.statusCode)).toEqual(Array(8).fill(200));
    expect(await knownDevices(max.id)).toHaveLength(1);
    expect(await newDeviceEvents(max.id)).toHaveLength(1);
    const created = await securityEvents(max.id, 'session.created');
    expect(created).toHaveLength(8);
    expect(created.filter((event) => newDeviceFlag(event))).toHaveLength(1);
    const sessions = await ctx.db
      .select()
      .from(staffSessions)
      .where(eq(staffSessions.userId, max.id));
    expect(sessions).toHaveLength(8);
  });

  it('D9. parallele Recovery-Abschlüsse dreier Challenges desselben Geräts ⇒ genau ein Ereignis', async () => {
    const admin = await bootstrapAdmin(ctx);
    const max = await employee(admin.id);
    const { recoveryCodes } = await enableTotp(max.id);
    const deviceCookie = `${DEVICE_COOKIE_NAME}=${resolveDeviceToken(undefined).token}`;
    const steps = await Promise.all(
      [0, 1, 2].map(() =>
        login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS, { deviceCookie }),
      ),
    );
    const completions = await Promise.all(
      steps.map((step, index) =>
        postJson('/auth/login/recovery', {
          challengeToken: step.body.challengeToken as string,
          recoveryCode: recoveryCodes[index]!,
        }),
      ),
    );
    expect(completions.map((response) => response.statusCode)).toEqual([200, 200, 200]);
    expect(await knownDevices(max.id)).toHaveLength(1);
    expect(await newDeviceEvents(max.id)).toHaveLength(1);
  });
});

// ── D10–D12: Datenhaltung, Logs, API ───────────────────────────────────────

interface Scenario {
  /** Alle Geräte-Cookie-Klartexte, die im Szenario vorkamen (gesetzt oder gesendet). */
  tokens: string[];
  responses: { label: string; response: LightMyRequestResponse }[];
}

/**
 * Alle Auth-Pfade einmal durchlaufen (Passwort, TOTP, Recovery,
 * Ersteinrichtung, freiwillige Einrichtung, me, Sessions, Admin-Ansichten,
 * Widerruf, Logout, Fehlversuch) – mit Admin-Push-Gerät, damit auch
 * Push-Zustellungen/Jobs entstehen.
 */
async function runFullScenario(): Promise<Scenario> {
  const responses: Scenario['responses'] = [];
  const tokens: string[] = [];
  const record = (label: string, response: LightMyRequestResponse) => {
    responses.push({ label, response });
    const device = deviceSetCookie(response);
    if (device !== undefined) tokens.push(device.value);
    return response;
  };
  const call = async (
    label: string,
    method: 'GET' | 'POST',
    url: string,
    cookie?: string,
    payload?: Record<string, unknown>,
  ) =>
    record(
      label,
      await ctx.app.inject({
        method,
        url,
        headers: { 'user-agent': UA_WINDOWS, ...(cookie === undefined ? {} : { cookie }) },
        ...(payload === undefined ? {} : { payload }),
      }),
    );
  const sessionOf = (response: LightMyRequestResponse) =>
    `mr_staff_session=${response.cookies.find((c) => c.name === 'mr_staff_session')!.value}`;

  const admin = await bootstrapAdmin(ctx);
  const adminLogin = await call('admin login', 'POST', '/auth/login', undefined, {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  const adminCookie = sessionOf(adminLogin);
  await subscribeAdminPush(adminCookie);
  const max = await employee(admin.id);
  const tina = await employee(admin.id, 'tina@test.example');
  const { secret: maxSecret, recoveryCodes } = await enableTotp(max.id);
  await ctx.admin.setTotpRequirement(admin.id, tina.id, true);

  // Fehlversuch mit vorhandenem Geräte-Cookie.
  await call('login failed', 'POST', '/auth/login', `${DEVICE_COOKIE_NAME}=${tokens[0]!}`, {
    email: EMPLOYEE_EMAIL,
    password: 'falsch-falsch-1',
  });
  // TOTP-Login.
  const totp1 = await call('login totp step1', 'POST', '/auth/login', undefined, {
    email: EMPLOYEE_EMAIL,
    password: EMPLOYEE_PASSWORD,
  });
  const maxDevice = `${DEVICE_COOKIE_NAME}=${deviceSetCookie(totp1)!.value}`;
  const totp2 = await call('login totp step2', 'POST', '/auth/login/totp', maxDevice, {
    challengeToken: totp1.json().challengeToken,
    code: await freshTotpCode(max.id, maxSecret),
  });
  const maxCookie = sessionOf(totp2);
  // Recovery-Login vom selben Gerät.
  const rec1 = await call('login recovery step1', 'POST', '/auth/login', maxDevice, {
    email: EMPLOYEE_EMAIL,
    password: EMPLOYEE_PASSWORD,
  });
  await call('login recovery step2', 'POST', '/auth/login/recovery', maxDevice, {
    challengeToken: rec1.json().challengeToken,
    recoveryCode: recoveryCodes[0],
  });
  // Erzwungene Ersteinrichtung (Tina) mit ungültigem Cookie ⇒ neuer Wert.
  const setup1 = await call('login setup step1', 'POST', '/auth/login', 'mr_staff_device=kaputt', {
    email: 'tina@test.example',
    password: EMPLOYEE_PASSWORD,
  });
  const setupBegin = await call('totp setup begin', 'POST', '/auth/totp/setup/begin', undefined, {
    challengeToken: setup1.json().challengeToken,
  });
  const tinaSecret = (setupBegin.json() as { secret: string }).secret;
  const setupConfirm = await call(
    'totp setup confirm',
    'POST',
    '/auth/totp/setup/confirm',
    undefined,
    { challengeToken: setup1.json().challengeToken, code: codeFor(tinaSecret) },
  );
  const tinaCookie = sessionOf(setupConfirm);
  // Passwort-only-Login des Admins mit anderem Gerät, freiwillige 2FA-Einrichtung.
  const adminPhone = await call('admin login 2', 'POST', '/auth/login', undefined, {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  const adminPhoneCookie = sessionOf(adminPhone);
  const selfBegin = await call(
    'totp self begin',
    'POST',
    '/auth/totp/self/begin',
    adminPhoneCookie,
  );
  await call('totp self confirm', 'POST', '/auth/totp/self/confirm', adminPhoneCookie, {
    code: codeFor((selfBegin.json() as { secret: string }).secret),
  });
  // Lesende Auth-/Admin-Antworten.
  await call('me', 'GET', '/auth/me', `${maxCookie}; ${maxDevice}`);
  await call('me tina', 'GET', '/auth/me', tinaCookie);
  const ownSessions = await call('sessions', 'GET', '/auth/sessions', `${maxCookie}; ${maxDevice}`);
  await call('admin user sessions', 'GET', `/staff/users/${max.id}/sessions`, adminCookie);
  await call('admin user detail', 'GET', `/staff/users/${max.id}`, adminCookie);
  await call('admin security events', 'GET', '/staff/security-events', adminCookie);
  await call('admin users', 'GET', '/staff/users', adminCookie);
  // Widerruf + Logout.
  const sessionList = (ownSessions.json() as { sessions: { id: string }[] }).sessions;
  const otherSession = sessionList.find(
    (session) =>
      session.id !== (ownSessions.json() as { currentSessionId: string }).currentSessionId,
  )!;
  await call(
    'self revoke',
    'POST',
    `/auth/sessions/${otherSession.id}/revoke`,
    `${maxCookie}; ${maxDevice}`,
    {},
  );
  await call('logout', 'POST', '/auth/logout', `${maxCookie}; ${maxDevice}`, {});
  // Admin-Push „neues Gerät“ tatsächlich zustellen (Jobs/Zustellungen in der DB).
  await backstopScanner().scanNewDeviceLogins(new Date());
  await drainAll();
  expect(ctx.push.sent.length).toBeGreaterThan(0);
  return { tokens: [...new Set(tokens), 'kaputt'], responses };
}

describe('D10. Kein Klartext in der Datenbank', () => {
  it('D10. nach allen Loginpfaden enthält KEINE Text-/JSON-Spalte der Datenbank einen Geräte-Cookie-Klartext; gespeichert ist nur der SHA-256', async () => {
    const { tokens } = await runFullScenario();
    const realTokens = tokens.filter((token) => token !== 'kaputt');
    expect(realTokens.length).toBeGreaterThanOrEqual(4);

    const columns = await ctx.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('text', 'character varying', 'character', 'jsonb', 'json', 'ARRAY')`,
    );
    const tableNames = new Set(columns.rows.map((column) => column.table_name));
    for (const table of [
      'staff_known_devices',
      'staff_login_challenges',
      'staff_sessions',
      'staff_security_events',
      'push_deliveries',
      'push_subscriptions',
      'integration_jobs',
    ]) {
      expect(tableNames.has(table), table).toBe(true);
    }
    const hits: string[] = [];
    for (const column of columns.rows) {
      const result = await ctx.pool.query(
        `SELECT 1 FROM "${column.table_name}" AS t
          WHERE EXISTS (SELECT 1 FROM unnest($1::text[]) AS needle
                         WHERE strpos(t."${column.column_name}"::text, needle) > 0)
          LIMIT 1`,
        [realTokens],
      );
      if ((result.rowCount ?? 0) > 0) hits.push(`${column.table_name}.${column.column_name}`);
    }
    expect(hits).toEqual([]);

    // Positivkontrolle: die Hashes liegen genau dort, wo sie hingehören.
    const stored = await ctx.pool.query<{ device_token_hash: string }>(
      'SELECT device_token_hash FROM staff_known_devices',
    );
    expect(stored.rows.length).toBeGreaterThanOrEqual(4);
    for (const row of stored.rows) {
      expect(row.device_token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(realTokens.map((token) => sha256Hex(token))).toContain(row.device_token_hash);
    }
    const challenges = await ctx.pool.query<{ device_token_hash: string | null }>(
      'SELECT device_token_hash FROM staff_login_challenges',
    );
    for (const row of challenges.rows) expect(row.device_token_hash).toMatch(/^[0-9a-f]{64}$/);
    // Phase 12 Finalisierung (B1): jede Session aller Loginpfade trägt den Hash ihres Geräts.
    const sessions = await ctx.pool.query<{ device_token_hash: string | null }>(
      'SELECT device_token_hash FROM staff_sessions',
    );
    expect(sessions.rows.length).toBeGreaterThanOrEqual(5);
    for (const row of sessions.rows) {
      expect(row.device_token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.rows.map((device) => device.device_token_hash)).toContain(
        row.device_token_hash,
      );
    }
    // Der ungültige Wert wurde nie (auch nicht gehasht) gespeichert.
    const invalidHash = sha256Hex('kaputt');
    const invalidStored = await ctx.pool.query(
      'SELECT 1 FROM staff_known_devices WHERE device_token_hash = $1 UNION ALL SELECT 1 FROM staff_login_challenges WHERE device_token_hash = $1 UNION ALL SELECT 1 FROM staff_sessions WHERE device_token_hash = $1',
      [invalidHash],
    );
    expect(invalidStored.rowCount).toBe(0);
    // Security-Events enthalten weder Hash noch Klartext.
    const events = JSON.stringify(await ctx.db.select().from(staffSecurityEvents));
    for (const row of stored.rows) expect(events).not.toContain(row.device_token_hash);
  });
});

describe('D11. Nie im Log', () => {
  it('D11. Serverlog (Level trace) aller Loginpfade enthält weder Geräte-Cookie-Klartext noch dessen Hash noch den Cookie-Header', async () => {
    const { tokens } = await runFullScenario();
    const log = logText();
    expect(log).toContain('/auth/login'); // Positivkontrolle: Log war aktiv
    expect(log).not.toContain(DEVICE_COOKIE_NAME);
    for (const token of tokens.filter((value) => value !== 'kaputt')) {
      expect(log).not.toContain(token);
      expect(log).not.toContain(sha256Hex(token));
    }
    expect(log).not.toContain('mr_staff_session=');
  });
});

describe('D12. Nie in einer API-Antwort', () => {
  it('D12. weder Klartext noch Hash erscheinen in Body oder Headern von login/me/sessions/TOTP-/Recovery-/Setup-/Admin-/Logout-Antworten – nur im Set-Cookie mr_staff_device', async () => {
    const { tokens, responses } = await runFullScenario();
    const needles = tokens
      .filter((token) => token !== 'kaputt')
      .flatMap((token) => [token, sha256Hex(token)]);
    const labels = responses.map((entry) => entry.label);
    for (const required of [
      'admin login',
      'login totp step1',
      'login totp step2',
      'login recovery step2',
      'totp setup begin',
      'totp setup confirm',
      'totp self begin',
      'totp self confirm',
      'me',
      'sessions',
      'admin user sessions',
      'admin security events',
      'logout',
    ]) {
      expect(labels).toContain(required);
    }
    for (const { label, response } of responses) {
      for (const needle of needles) {
        expect(response.body, label).not.toContain(needle);
      }
      expect(response.body, label).not.toMatch(/deviceToken|device_token|mr_staff_device/i);
      for (const [header, value] of Object.entries(response.headers)) {
        if (header === 'set-cookie') continue;
        for (const needle of needles)
          expect(String(value), `${label} ${header}`).not.toContain(needle);
      }
      // Set-Cookie: der Klartext steckt ausschließlich im Geräte-Cookie.
      for (const cookie of response.cookies) {
        if (cookie.name === DEVICE_COOKIE_NAME) continue;
        for (const needle of needles)
          expect(cookie.value, `${label} ${cookie.name}`).not.toContain(needle);
      }
    }
    // Die Login-Antwort hat keine Gerätefelder.
    const adminLogin = responses.find((entry) => entry.label === 'admin login')!.response;
    expect(Object.keys(adminLogin.json()).sort()).toEqual(['next', 'user']);
    const totpStep1 = responses.find((entry) => entry.label === 'login totp step1')!.response;
    expect(Object.keys(totpStep1.json()).sort()).toEqual(['challengeToken', 'next']);
  });
});

// ── D13: Admin-Push ─────────────────────────────────────────────────────────

describe('D13. Admin-Push exakt einmal', () => {
  it('D13. je neuem Gerät genau ein Admin-Security-Push (Sofort-Hook + Scan-Backstop dedupliziert) – bekannte Geräte, anderer User-Agent, Logout/Widerruf, parallele Erst-Logins und TOTP erzeugen keinen zweiten', async () => {
    const admin = await bootstrapAdmin(ctx);
    const adminLogin = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD, UA_WINDOWS);
    await subscribeAdminPush(adminLogin.cookie);
    const max = await employee(admin.id);

    // Gerät A: Erst-Login ⇒ ein Push (Sofort-Hook).
    const a = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS);
    expect(await newDeviceDeliveries()).toHaveLength(1);
    // Gerät A erneut, anderer User-Agent, nach Logout und Widerruf ⇒ kein weiterer.
    await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_IPHONE, {
      deviceCookie: a.deviceCookie,
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: a.cookie },
      payload: {},
    });
    await ctx.auth.revokeAllSessions(max.id, 'test', admin.id);
    await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS, {
      deviceCookie: a.deviceCookie,
    });
    expect(await newDeviceDeliveries()).toHaveLength(1);

    // Gerät B: fünf parallele Erst-Logins ⇒ genau ein weiterer Push.
    const deviceB = `${DEVICE_COOKIE_NAME}=${resolveDeviceToken(undefined).token}`;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS, { deviceCookie: deviceB }),
      ),
    );
    expect(await newDeviceDeliveries()).toHaveLength(2);

    // Gerät C über TOTP ⇒ genau ein weiterer Push (erst mit der Session).
    const { secret } = await enableTotp(max.id);
    const c1 = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS);
    expect(await newDeviceDeliveries()).toHaveLength(2);
    await postJson('/auth/login/totp', {
      challengeToken: c1.body.challengeToken as string,
      code: await freshTotpCode(max.id, secret),
    });
    expect(await newDeviceDeliveries()).toHaveLength(3);

    // Backstop-Scan (zweimal): holt nur das Admin-Login VOR der Push-
    // Registrierung nach; die Mitarbeiter-Geräte werden nie doppelt gemeldet.
    expect(await backstopScanner().scanNewDeviceLogins(new Date())).toBe(1);
    expect(await backstopScanner().scanNewDeviceLogins(new Date())).toBe(0);
    await drainAll();

    const maxEvents = await newDeviceEvents(max.id);
    expect(maxEvents).toHaveLength(3);
    const all = await newDeviceDeliveries();
    expect(all).toHaveLength(4);
    for (const event of maxEvents) {
      const key = pushKeys.newDevice(event.sessionId!, admin.id);
      expect(all.filter((row) => row.idempotencyKey === key)).toHaveLength(1);
    }
    expect(all.every((row) => row.userId === admin.id)).toBe(true);
    const sent = ctx.push.sent.filter(
      (record) => record.payload.kind === 'session_new_device_login',
    );
    expect(sent).toHaveLength(4);
    expect(new Set(sent.map((record) => record.endpoint))).toEqual(
      new Set([endpointFor('admin-security')]),
    );
    // Nutzlast ohne Gerätedaten/Identität.
    for (const record of sent) {
      const serialized = JSON.stringify(record.payload);
      expect(serialized).not.toContain(tokenOf(a.deviceCookie));
      expect(serialized).not.toContain('Windows');
      expect(serialized).not.toContain('Max');
    }
  });
});

// ── H1–H8: Host-präfixiertes Geräte-Cookie (Phase 12, finale Geräteidentität) ─

const HOST_ENVS = ['production', 'staging', 'demo'] as const;
type HostEnv = (typeof HOST_ENVS)[number];

/** Production-Pattern wie in D1: echte loadConfig je Umgebung + buildApp. */
async function withEnvApp<T>(appEnv: HostEnv, run: (app: FastifyInstance) => Promise<T>) {
  const keys = webpush.generateVAPIDKeys();
  const envConfig = loadConfig({
    APP_ENV: appEnv,
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
  expect(envConfig.appEnv).toBe(appEnv);
  const app = buildApp({
    config: { ...envConfig, auth: ctx.config.auth },
    pool: ctx.pool,
    mailAdapter: ctx.mail,
    rateLimitEnabled: false,
    storage: ctx.storage,
    jobQueue: ctx.queue,
  });
  await app.ready();
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

async function loginOn(
  app: FastifyInstance,
  cookie: string | undefined,
  email = EMPLOYEE_EMAIL,
  password = EMPLOYEE_PASSWORD,
) {
  return app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
    headers: { 'user-agent': UA_WINDOWS, ...(cookie === undefined ? {} : { cookie }) },
  });
}

/** Rohe Set-Cookie-Header (ohne Interpretation durch light-my-request). */
function rawSetCookies(response: LightMyRequestResponse): string[] {
  const header = response.headers['set-cookie'];
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [String(header)];
}

/** Genau ein Set-Cookie-Header für `name`; Attribute klein geschrieben, getrimmt. */
function rawDeviceHeader(response: LightMyRequestResponse, name: string) {
  const headers = rawSetCookies(response).filter((header) => header.startsWith(`${name}=`));
  expect(headers, name).toHaveLength(1);
  const [pair, ...attributes] = headers[0]!.split(';');
  return {
    value: pair!.slice(name.length + 1),
    attributes: attributes.map((attribute) => attribute.trim().toLowerCase()),
  };
}

const setCookieNames = (response: LightMyRequestResponse) =>
  response.cookies.map((cookie) => cookie.name);

/** Vollständiger Bestand bekannter Geräte (alle Mitarbeiter) für Vorher/Nachher. */
async function knownDeviceSnapshot() {
  const rows = await ctx.db.select().from(staffKnownDevices).orderBy(asc(staffKnownDevices.id));
  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    deviceTokenHash: row.deviceTokenHash,
    firstSeenAt: row.firstSeenAt.toISOString(),
  }));
}

describe('H1. __Host--Name außerhalb development', () => {
  it('H1. production, staging und demo setzen beim Login ausschließlich `__Host-mr_staff_device` (zentrale Funktion deviceCookieName); der Folgelogin mit diesem Cookie ist dasselbe Gerät', async () => {
    for (const appEnv of HOST_ENVS) {
      expect(deviceCookieName(appEnv), appEnv).toBe('__Host-mr_staff_device');
    }
    expect(DEVICE_COOKIE_NAME_HOST_PREFIXED).toBe('__Host-mr_staff_device');

    const admin = await bootstrapAdmin(ctx);
    const max = await employee(admin.id);
    for (const appEnv of HOST_ENVS) {
      await withEnvApp(appEnv, async (app) => {
        const first = await loginOn(app, undefined);
        expect(first.statusCode, appEnv).toBe(200);
        expect(setCookieNames(first), appEnv).toContain(DEVICE_COOKIE_NAME_HOST_PREFIXED);
        expect(setCookieNames(first), appEnv).not.toContain(DEVICE_COOKIE_NAME_DEVELOPMENT);
        const value = rawDeviceHeader(first, DEVICE_COOKIE_NAME_HOST_PREFIXED).value;
        expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);

        const eventsBefore = (await newDeviceEvents(max.id)).length;
        const again = await loginOn(app, `${DEVICE_COOKIE_NAME_HOST_PREFIXED}=${value}`);
        expect(again.statusCode, appEnv).toBe(200);
        expect(rawDeviceHeader(again, DEVICE_COOKIE_NAME_HOST_PREFIXED).value).toBe(value);
        expect(await newDeviceEvents(max.id), appEnv).toHaveLength(eventsBefore);
      });
    }
    // Je Umgebung genau ein neues Gerät (drei Browser), keins doppelt.
    expect(await knownDevices(max.id)).toHaveLength(3);
    expect(await newDeviceEvents(max.id)).toHaveLength(3);
  });
});

describe('H2. development behält den bisherigen Namen', () => {
  it('H2. development setzt und liest `mr_staff_device` (ohne Präfix, lokales http) – kein `__Host-`-Cookie', async () => {
    expect(deviceCookieName('development')).toBe('mr_staff_device');
    expect(DEVICE_COOKIE_NAME_DEVELOPMENT).toBe('mr_staff_device');
    expect(ctx.config.appEnv).toBe('development');

    const admin = await bootstrapAdmin(ctx);
    const max = await employee(admin.id);
    const first = await loginOn(ctx.app, undefined);
    expect(first.statusCode).toBe(200);
    expect(setCookieNames(first)).toContain(DEVICE_COOKIE_NAME_DEVELOPMENT);
    expect(setCookieNames(first)).not.toContain(DEVICE_COOKIE_NAME_HOST_PREFIXED);
    const value = rawDeviceHeader(first, DEVICE_COOKIE_NAME_DEVELOPMENT).value;

    const again = await loginOn(ctx.app, `${DEVICE_COOKIE_NAME_DEVELOPMENT}=${value}`);
    expect(rawDeviceHeader(again, DEVICE_COOKIE_NAME_DEVELOPMENT).value).toBe(value);
    expect(await newDeviceEvents(max.id)).toHaveLength(1);
    expect(await knownDevices(max.id)).toHaveLength(1);
  });
});

describe('H3. __Host--Regeln im Set-Cookie-Header', () => {
  it('H3. außerhalb development: Secure, Path=/ und KEIN Domain-Attribut (roher Header, Login und setDeviceCookie); development ohne Secure', async () => {
    const admin = await bootstrapAdmin(ctx);
    await employee(admin.id);
    for (const appEnv of HOST_ENVS) {
      await withEnvApp(appEnv, async (app) => {
        const response = await loginOn(app, undefined);
        expect(response.statusCode, appEnv).toBe(200);
        const { attributes } = rawDeviceHeader(response, DEVICE_COOKIE_NAME_HOST_PREFIXED);
        expect(attributes, appEnv).toContain('secure');
        expect(
          attributes.filter((a) => a.startsWith('path=')),
          appEnv,
        ).toEqual(['path=/']);
        expect(
          attributes.some((a) => a.startsWith('domain')),
          appEnv,
        ).toBe(false);
      });
    }

    // Direkt über setDeviceCookie (nur appEnv bestimmt Name und Secure).
    const issue = async (appEnv: AppConfig['appEnv']) => {
      const app = Fastify();
      await app.register(fastifyCookie);
      app.get('/probe', async (_request, reply) => {
        setDeviceCookie(reply, { appEnv } as AppConfig, resolveDeviceToken(undefined).token);
        return { ok: true };
      });
      const response = await app.inject({ method: 'GET', url: '/probe' });
      await app.close();
      return response;
    };
    for (const appEnv of HOST_ENVS) {
      const response = await issue(appEnv);
      expect(rawSetCookies(response), appEnv).toHaveLength(1);
      const { attributes } = rawDeviceHeader(response, DEVICE_COOKIE_NAME_HOST_PREFIXED);
      expect(attributes, appEnv).toContain('secure');
      expect(attributes, appEnv).toContain('path=/');
      expect(
        attributes.some((a) => a.startsWith('domain')),
        appEnv,
      ).toBe(false);
    }
    const development = rawDeviceHeader(await issue('development'), DEVICE_COOKIE_NAME_DEVELOPMENT);
    expect(development.attributes).not.toContain('secure');
    expect(development.attributes).toContain('path=/');
    expect(development.attributes.some((a) => a.startsWith('domain'))).toBe(false);
  });
});

describe('H4. HttpOnly, SameSite=Strict, 400 Tage', () => {
  it('H4. in allen Umgebungen weiterhin HttpOnly, SameSite=Strict und Max-Age 400 Tage', async () => {
    const admin = await bootstrapAdmin(ctx);
    await employee(admin.id);
    const expectAttributes = (attributes: string[], label: string) => {
      expect(attributes, label).toContain('httponly');
      expect(attributes, label).toContain('samesite=strict');
      expect(attributes, label).toContain(`max-age=${400 * 24 * 60 * 60}`);
    };
    for (const appEnv of HOST_ENVS) {
      await withEnvApp(appEnv, async (app) => {
        const response = await loginOn(app, undefined);
        expectAttributes(
          rawDeviceHeader(response, DEVICE_COOKIE_NAME_HOST_PREFIXED).attributes,
          appEnv,
        );
        const parsed = response.cookies.find((c) => c.name === DEVICE_COOKIE_NAME_HOST_PREFIXED)!;
        expect(parsed.httpOnly).toBe(true);
        expect(parsed.sameSite).toBe('Strict');
        expect(parsed.maxAge).toBe(DEVICE_COOKIE_MAX_AGE_SECONDS);
      });
    }
    const development = await loginOn(ctx.app, undefined);
    expectAttributes(
      rawDeviceHeader(development, DEVICE_COOKIE_NAME_DEVELOPMENT).attributes,
      'development',
    );
  });
});

describe('H5. Alter Name außerhalb development wird nicht übernommen', () => {
  it('H5. production ignoriert ein gültiges `mr_staff_device` (neuer __Host-Wert, neues Gerät, Ereignis); bei beiden Namen gilt ausschließlich der __Host-Wert; development liest nur den alten Namen', async () => {
    const admin = await bootstrapAdmin(ctx);
    const max = await employee(admin.id);

    // Vor dem Deploy: Gerät mit altem Cookie-Namen bekannt (development-Pfad).
    const old = resolveDeviceToken(undefined).token;
    const oldCookie = `${DEVICE_COOKIE_NAME_DEVELOPMENT}=${old}`;
    expect((await loginOn(ctx.app, oldCookie)).statusCode).toBe(200);
    expect((await knownDevices(max.id)).map((d) => d.deviceTokenHash)).toEqual([sha256Hex(old)]);
    expect(await newDeviceEvents(max.id)).toHaveLength(1);

    await withEnvApp('production', async (app) => {
      // Nur alter Name ⇒ verworfen: neuer Wert im __Host-Cookie, neues Gerät.
      const migrated = await loginOn(app, oldCookie);
      expect(migrated.statusCode).toBe(200);
      expect(setCookieNames(migrated)).not.toContain(DEVICE_COOKIE_NAME_DEVELOPMENT);
      const hostValue = rawDeviceHeader(migrated, DEVICE_COOKIE_NAME_HOST_PREFIXED).value;
      expect(hostValue).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(hostValue).not.toBe(old);
      expect((await knownDevices(max.id)).map((d) => d.deviceTokenHash)).toEqual([
        sha256Hex(old),
        sha256Hex(hostValue),
      ]);
      expect(await newDeviceEvents(max.id)).toHaveLength(2);

      // Beide Namen (beide Reihenfolgen), __Host-Wert bekannt ⇒ nur er zählt.
      for (const cookie of [
        `${oldCookie}; ${DEVICE_COOKIE_NAME_HOST_PREFIXED}=${hostValue}`,
        `${DEVICE_COOKIE_NAME_HOST_PREFIXED}=${hostValue}; ${oldCookie}`,
      ]) {
        const both = await loginOn(app, cookie);
        expect(both.statusCode).toBe(200);
        expect(rawDeviceHeader(both, DEVICE_COOKIE_NAME_HOST_PREFIXED).value).toBe(hostValue);
        expect(setCookieNames(both)).not.toContain(DEVICE_COOKIE_NAME_DEVELOPMENT);
      }
      expect(await newDeviceEvents(max.id)).toHaveLength(2);

      // Beide Namen, alter Wert bekannt, __Host-Wert neu ⇒ neues Gerät (der
      // bekannte alte Wert rettet nichts).
      const fresh = resolveDeviceToken(undefined).token;
      const mixed = await loginOn(
        app,
        `${oldCookie}; ${DEVICE_COOKIE_NAME_HOST_PREFIXED}=${fresh}`,
      );
      expect(rawDeviceHeader(mixed, DEVICE_COOKIE_NAME_HOST_PREFIXED).value).toBe(fresh);
      expect(await newDeviceEvents(max.id)).toHaveLength(3);
      expect(await knownDevices(max.id)).toHaveLength(3);
    });

    // development: genau ein Name – ein mitgeschicktes __Host-Cookie zählt nicht.
    const hostOnly = resolveDeviceToken(undefined).token;
    const devBoth = await loginOn(
      ctx.app,
      `${DEVICE_COOKIE_NAME_HOST_PREFIXED}=${hostOnly}; ${oldCookie}`,
    );
    expect(rawDeviceHeader(devBoth, DEVICE_COOKIE_NAME_DEVELOPMENT).value).toBe(old);
    expect(setCookieNames(devBoth)).not.toContain(DEVICE_COOKIE_NAME_HOST_PREFIXED);
    expect(await newDeviceEvents(max.id)).toHaveLength(3);
    expect((await knownDevices(max.id)).map((d) => d.deviceTokenHash)).not.toContain(
      sha256Hex(hostOnly),
    );
  });
});

describe('H6. Passwort-Reset löscht bekannte Geräte nicht', () => {
  it('H6. Self-Service-Reset (Mail-Link), Admin-Reset-Link und Passwortänderung lassen staff_known_devices unverändert; derselbe Browser ist danach bekannt (kein neues Ereignis)', async () => {
    const admin = await bootstrapAdmin(ctx);
    const max = await employee(admin.id);
    const adminSession = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD, UA_WINDOWS);
    expect(adminSession.statusCode).toBe(200);
    const device = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS);
    expect(device.statusCode).toBe(200);
    const before = await knownDeviceSnapshot();
    expect(before).toHaveLength(2); // Admin + Max
    expect(await newDeviceEvents(max.id)).toHaveLength(1);

    const expectStillKnown = async (password: string, label: string) => {
      expect(await knownDeviceSnapshot(), label).toEqual(before);
      const again = await login(ctx.app, EMPLOYEE_EMAIL, password, UA_WINDOWS, {
        deviceCookie: device.deviceCookie,
      });
      expect(again.statusCode, label).toBe(200);
      expect(again.deviceCookie, label).toBe(device.deviceCookie);
      expect(await newDeviceEvents(max.id), label).toHaveLength(1);
      expect(await knownDeviceSnapshot(), label).toEqual(before);
      return again;
    };

    // Weg 1: Self-Service „Passwort vergessen“ ⇒ Mail-Link ⇒ Reset.
    const forgot = await postJson('/auth/password/forgot', { email: EMPLOYEE_EMAIL });
    expect(forgot.statusCode).toBe(200);
    const mailToken = ctx.mail.sent.at(-1)?.resetToken;
    expect(mailToken).toBeDefined();
    const selfReset = await postJson('/auth/password/reset', {
      token: mailToken!,
      newPassword: 'self-reset-passwort-1',
    });
    expect(selfReset.statusCode).toBe(200);
    await expectStillKnown('self-reset-passwort-1', 'self-service');

    // Weg 2: Admin-Reset-Link (employee.manage) ⇒ Reset.
    const link = await ctx.app.inject({
      method: 'POST',
      url: `/staff/users/${max.id}/reset-link`,
      headers: { cookie: adminSession.cookie },
      payload: {},
    });
    expect(link.statusCode).toBe(200);
    const adminReset = await postJson('/auth/password/reset', {
      token: (link.json() as { resetToken: string }).resetToken,
      newPassword: 'admin-reset-passwort-2',
    });
    expect(adminReset.statusCode).toBe(200);
    const afterAdmin = await expectStillKnown('admin-reset-passwort-2', 'admin-link');

    // Weg 3: Passwortänderung im eingeloggten Zustand.
    const change = await ctx.app.inject({
      method: 'POST',
      url: '/auth/password/change',
      headers: { cookie: afterAdmin.cookie },
      payload: { currentPassword: 'admin-reset-passwort-2', newPassword: 'geaendert-passwort-3' },
    });
    expect(change.statusCode).toBe(200);
    await expectStillKnown('geaendert-passwort-3', 'password-change');
  });
});

describe('H7. 2FA-Reset und Recovery löschen bekannte Geräte nicht', () => {
  it('H7. Admin-2FA-Reset, Recovery-Code-Login und erneute 2FA-Einrichtung (neue Recovery-Codes) lassen staff_known_devices unverändert; danach kein neues Ereignis', async () => {
    const admin = await bootstrapAdmin(ctx);
    const max = await employee(admin.id);
    const adminSession = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD, UA_WINDOWS);
    const { secret, recoveryCodes } = await enableTotp(max.id);

    // Gerät über TOTP-Login bekannt machen.
    const step1 = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS);
    const step2 = await postJson(
      '/auth/login/totp',
      {
        challengeToken: step1.body.challengeToken as string,
        code: await freshTotpCode(max.id, secret),
      },
      step1.deviceCookie,
    );
    expect(step2.statusCode).toBe(200);
    const before = await knownDeviceSnapshot();
    expect(before).toHaveLength(2);
    expect(await newDeviceEvents(max.id)).toHaveLength(1);

    // Recovery-Login vom bekannten Gerät.
    const rec1 = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS, {
      deviceCookie: step1.deviceCookie,
    });
    const rec2 = await postJson(
      '/auth/login/recovery',
      { challengeToken: rec1.body.challengeToken as string, recoveryCode: recoveryCodes[0]! },
      step1.deviceCookie,
    );
    expect(rec2.statusCode).toBe(200);
    expect(await knownDeviceSnapshot()).toEqual(before);
    expect(await newDeviceEvents(max.id)).toHaveLength(1);

    // Admin setzt 2FA zurück.
    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/staff/users/${max.id}/totp-reset`,
      headers: { cookie: adminSession.cookie },
      payload: {},
    });
    expect(reset.statusCode).toBe(200);
    expect(await securityEvents(max.id, 'twofa.reset')).toHaveLength(1);
    expect(await knownDeviceSnapshot()).toEqual(before);
    const afterReset = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS, {
      deviceCookie: step1.deviceCookie,
    });
    expect(afterReset.body.next).toBe('authenticated');
    expect(await newDeviceEvents(max.id)).toHaveLength(1);
    expect(await knownDeviceSnapshot()).toEqual(before);

    // Erneute Einrichtung (alte Recovery-Codes ersetzt) + Recovery-Login.
    const renewed = await enableTotp(max.id);
    expect(await knownDeviceSnapshot()).toEqual(before);
    const again1 = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, UA_WINDOWS, {
      deviceCookie: step1.deviceCookie,
    });
    const again2 = await postJson(
      '/auth/login/recovery',
      {
        challengeToken: again1.body.challengeToken as string,
        recoveryCode: renewed.recoveryCodes[0]!,
      },
      step1.deviceCookie,
    );
    expect(again2.statusCode).toBe(200);
    expect(await newDeviceEvents(max.id)).toHaveLength(1);
    expect(await knownDeviceSnapshot()).toEqual(before);
  });
});

describe('H8. D-Regression unter __Host-', () => {
  it('H8. TOTP- und Recovery-Login in production tragen die Identität aus dem __Host-Cookie über die Challenge (D6/D7-Pfad); bekanntes Gerät ⇒ kein zweites Ereignis (D1–D13 laufen unverändert über deviceCookieName)', async () => {
    expect(DEVICE_COOKIE_NAME).toBe(deviceCookieName(ctx.config.appEnv));
    const admin = await bootstrapAdmin(ctx);
    const max = await employee(admin.id);
    const { secret, recoveryCodes } = await enableTotp(max.id);

    await withEnvApp('production', async (app) => {
      const post = (url: string, payload: Record<string, unknown>, cookie?: string) =>
        app.inject({
          method: 'POST',
          url,
          payload,
          headers: { 'user-agent': UA_WINDOWS, ...(cookie === undefined ? {} : { cookie }) },
        });
      const step1 = await loginOn(app, undefined);
      expect(step1.json().next).toBe('totp_required');
      const hostValue = rawDeviceHeader(step1, DEVICE_COOKIE_NAME_HOST_PREFIXED).value;
      const hostCookie = `${DEVICE_COOKIE_NAME_HOST_PREFIXED}=${hostValue}`;
      expect((await challengeRow(step1.json().challengeToken)).deviceTokenHash).toBe(
        sha256Hex(hostValue),
      );
      const step2 = await post('/auth/login/totp', {
        challengeToken: step1.json().challengeToken,
        code: await freshTotpCode(max.id, secret),
      });
      expect(step2.statusCode).toBe(200);
      expect(await newDeviceEvents(max.id)).toHaveLength(1);

      const rec1 = await loginOn(app, hostCookie);
      const rec2 = await post(
        '/auth/login/recovery',
        { challengeToken: rec1.json().challengeToken, recoveryCode: recoveryCodes[0] },
        hostCookie,
      );
      expect(rec2.statusCode).toBe(200);
      expect(await newDeviceEvents(max.id)).toHaveLength(1);
      expect((await knownDevices(max.id)).map((d) => d.deviceTokenHash)).toEqual([
        sha256Hex(hostValue),
      ]);
    });
  });
});
