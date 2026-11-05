/**
 * Phase 15 (AUTH) – Pflichttests Auth (Order §56, Design §1.6, Präfix „A“).
 * Kein echter Provider: FakeMailGateway; Magic-Link-Tokens werden nur in-process
 * aus dem verschlüsselten Outbox-Secret gelesen (portal-auth-helpers.ts).
 */
import { PassThrough } from 'node:stream';
import {
  customerPortalMagicLinks,
  customerPortalSessions,
  mailDeliveries,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/auth/crypto.ts';
import { PORTAL_MAGIC_LINK_TTL_MS, PORTAL_SESSION_TTL_MS } from '../src/portal/auth/constants.ts';
import {
  PORTAL_MAGIC_LINK_RETENTION_MS,
  PORTAL_SESSION_RETENTION_MS,
  runPortalAuthCleanup,
} from '../src/portal/auth/cleanup-scanner.ts';
import { PortalMagicLinkService } from '../src/portal/auth/magic-link-service.ts';
import { PortalSessionService, portalUserAgentLabel } from '../src/portal/auth/session-service.ts';
import {
  PORTAL_SESSION_COOKIE_DEVELOPMENT,
  PORTAL_SESSION_COOKIE_HOST_PREFIXED,
} from '../src/portal/guard.ts';
import { PORTAL_MESSAGES } from '../src/portal/types.ts';
import { IpWindowLimiter } from '../src/routes/portal-auth.ts';
import { bootstrapAdmin, login, truncateAuthTables, type TestContext } from './auth-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { drainJobs, truncateCommunicationTables } from './communication-helpers.ts';
import { createTestCustomer, customerServiceFor, truncateCrmTables } from './crm-helpers.ts';
import {
  createPortalTestContext,
  destroyPortalTestContext,
  loginPortalCustomerSession,
  loginViaMagicLink,
  portalCookieName,
  requestMagicLink,
  requestMagicLinkToken,
  truncatePortalTables,
  type PortalTestContext,
} from './portal-auth-helpers.ts';
import { truncateSchedulingTables } from './scheduling-helpers.ts';

const WEB_BASE_URL = 'https://web.test.example';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

let ctx: PortalTestContext;
let logBuffer = '';

async function resetAll(context: TestContext): Promise<void> {
  await truncatePortalTables(context.pool);
  await truncateSchedulingTables(context.pool);
  await truncateCommunicationTables(context.pool);
  await truncateCrmTables(context.pool);
  await truncateAuthTables(context.pool);
  await truncateCommerceTables(context.pool); // nach dem Auth-Reset: stellt Seed-Preise wieder her
  context.mailGateway.reset();
}

beforeAll(async () => {
  const sink = new PassThrough();
  sink.on('data', (chunk: Buffer) => {
    logBuffer += chunk.toString('utf8');
  });
  ctx = await createPortalTestContext({
    logDestination: sink,
    logLevel: 'trace',
    env: { MAIL_PUBLIC_WEB_BASE_URL: WEB_BASE_URL },
  });
});
afterAll(async () => {
  await destroyPortalTestContext(ctx);
});
beforeEach(async () => {
  await resetAll(ctx);
  logBuffer = '';
});

async function adminAndCustomer(email = 'kunde@example.com') {
  const admin = await bootstrapAdmin(ctx);
  const customer = await createTestCustomer(ctx, admin.id, {
    email,
    firstName: 'Mia',
    lastName: 'Muster',
  });
  return { admin, customer };
}

async function sessionRow(sessionId: string) {
  const rows = await ctx.db
    .select()
    .from(customerPortalSessions)
    .where(eq(customerPortalSessions.id, sessionId));
  return rows[0]!;
}

async function me(cookie: string) {
  return ctx.app.inject({ method: 'GET', url: '/portal/me', headers: { cookie } });
}

async function consume(token: string, headers: Record<string, string> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/portal/auth/consume',
    payload: { token },
    headers,
  });
}

describe('Magic Link anfordern (Order §4/§6)', () => {
  it('A1. unbekannte Adresse ⇒ neutrale 202 ohne Link', async () => {
    await bootstrapAdmin(ctx);
    const result = await requestMagicLink(ctx, 'niemand@example.com');
    expect(result.statusCode).toBe(202);
    expect(result.body).toEqual({ message: PORTAL_MESSAGES.MAGIC_LINK_REQUESTED });
    expect(result.token).toBeNull();
    const links = await ctx.db.select().from(customerPortalMagicLinks);
    expect(links).toHaveLength(0);
  });

  it('A2. eindeutige Adresse ⇒ identische neutrale 202 UND Link (auch bei Groß-/Leerzeichen)', async () => {
    const { customer } = await adminAndCustomer();
    const result = await requestMagicLink(ctx, '  Kunde@Example.com ');
    expect(result.statusCode).toBe(202);
    expect(result.body).toEqual({ message: PORTAL_MESSAGES.MAGIC_LINK_REQUESTED });
    expect(result.token).toMatch(TOKEN_PATTERN);
    expect(result.recipientEmail).toBe('kunde@example.com');
    const links = await ctx.db.select().from(customerPortalMagicLinks);
    expect(links).toHaveLength(1);
    expect(links[0]!.customerId).toBe(customer.id);
    expect(links[0]!.purpose).toBe('login');
    expect(links[0]!.sessionId).toBeNull();
  });

  it('A3. doppelte Adresse (zwei aktive Kunden) ⇒ neutrale 202, KEIN Link, kein stilles Auswählen', async () => {
    const { admin } = await adminAndCustomer('doppelt@example.com');
    await createTestCustomer(ctx, admin.id, { email: 'doppelt@example.com', firstName: 'Zwei' });
    const result = await requestMagicLink(ctx, 'doppelt@example.com');
    expect(result.statusCode).toBe(202);
    expect(result.body).toEqual({ message: PORTAL_MESSAGES.MAGIC_LINK_REQUESTED });
    expect(result.token).toBeNull();
    expect(await ctx.db.select().from(customerPortalMagicLinks)).toHaveLength(0);
    expect(await ctx.db.select().from(mailDeliveries)).toHaveLength(0);
  });

  it('A4. gelöschter Kunde (Papierkorb) ⇒ neutrale 202 ohne Link', async () => {
    const { admin, customer } = await adminAndCustomer('weg@example.com');
    await customerServiceFor(ctx).moveToTrash(admin.id, customer.id);
    const result = await requestMagicLink(ctx, 'weg@example.com');
    expect(result.statusCode).toBe(202);
    expect(result.body).toEqual({ message: PORTAL_MESSAGES.MAGIC_LINK_REQUESTED });
    expect(result.token).toBeNull();
    expect(await ctx.db.select().from(customerPortalMagicLinks)).toHaveLength(0);
  });

  it('A5. Token ≥ 32 Zufallsbytes (43 Zeichen base64url), jede Anforderung ein neuer Token', async () => {
    await adminAndCustomer();
    const first = await requestMagicLinkToken(ctx, 'kunde@example.com');
    const second = await requestMagicLinkToken(ctx, 'kunde@example.com');
    expect(first).toMatch(TOKEN_PATTERN);
    expect(second).toMatch(TOKEN_PATTERN);
    expect(Buffer.from(first, 'base64url')).toHaveLength(32);
    expect(first).not.toBe(second);
  });

  it('A6. DB speichert nur den SHA-256-Hash – Klartext kommt in keiner Portal-Spalte vor; neue Anforderung widerruft den alten Login-Link', async () => {
    await adminAndCustomer();
    const first = await requestMagicLinkToken(ctx, 'kunde@example.com');
    const second = await requestMagicLinkToken(ctx, 'kunde@example.com');
    const links = await ctx.db.select().from(customerPortalMagicLinks);
    expect(links).toHaveLength(2);
    const hashes = links.map((l) => l.tokenHash).sort();
    expect(hashes).toEqual([sha256Hex(first), sha256Hex(second)].sort());
    expect(JSON.stringify(links)).not.toContain(first);
    expect(JSON.stringify(links)).not.toContain(second);
    const older = links.find((l) => l.tokenHash === sha256Hex(first))!;
    expect(older.revokedAt).not.toBeNull();
    const firstConsume = await consume(first);
    expect(firstConsume.statusCode).toBe(401);
    expect(firstConsume.json().error.code).toBe('PORTAL_TOKEN_INVALID');
    expect((await consume(second)).statusCode).toBe(200);
  });
});

describe('Magic Link einlösen (Order §6/§7)', () => {
  it('A7. nach 15 Minuten ungültig (Ablauf exakt an expires_at)', async () => {
    await adminAndCustomer();
    const token = await requestMagicLinkToken(ctx, 'kunde@example.com');
    const [link] = await ctx.db.select().from(customerPortalMagicLinks);
    expect(link!.expiresAt.getTime() - link!.createdAt.getTime()).toBe(PORTAL_MAGIC_LINK_TTL_MS);
    await ctx.db
      .update(customerPortalMagicLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(customerPortalMagicLinks.id, link!.id));
    const response = await consume(token);
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toMatchObject({
      code: 'PORTAL_TOKEN_INVALID',
      message: PORTAL_MESSAGES.TOKEN_INVALID,
    });
    expect(response.cookies.find((c) => c.name === portalCookieName(ctx))).toBeUndefined();
    expect(await ctx.db.select().from(customerPortalSessions)).toHaveLength(0);
  });

  it('A8. one-time: zweiter Consume desselben Tokens ⇒ 401, keine zweite Session; consumed_at gesetzt', async () => {
    await adminAndCustomer();
    const token = await requestMagicLinkToken(ctx, 'kunde@example.com');
    const first = await consume(token);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ authenticated: true });
    expect(typeof first.json().expiresAt).toBe('string');
    const second = await consume(token);
    expect(second.statusCode).toBe(401);
    expect(second.json().error.code).toBe('PORTAL_TOKEN_INVALID');
    const [link] = await ctx.db.select().from(customerPortalMagicLinks);
    expect(link!.consumedAt).not.toBeNull();
    expect(await ctx.db.select().from(customerPortalSessions)).toHaveLength(1);
  });

  it('A9. fünf parallele Consumes ⇒ genau EINE Session, genau ein 200', async () => {
    await adminAndCustomer();
    const token = await requestMagicLinkToken(ctx, 'kunde@example.com');
    const responses = await Promise.all([1, 2, 3, 4, 5].map(() => consume(token)));
    const statuses = responses.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([200, 401, 401, 401, 401]);
    expect(await ctx.db.select().from(customerPortalSessions)).toHaveLength(1);
  });

  it('A10. Klartext-Token erscheint weder im Mail-Kontext noch im Serverlog (Request + Consume + Versand)', async () => {
    await adminAndCustomer();
    const result = await requestMagicLink(ctx, 'kunde@example.com');
    const token = result.token!;
    await consume(token);
    await drainJobs(ctx);
    const [delivery] = await ctx.db.select().from(mailDeliveries);
    expect(JSON.stringify(delivery!.context)).not.toContain(token);
    expect(delivery!.context).toEqual({ salutation: 'Hallo Mia Muster,', validMinutes: 15 });
    expect(logBuffer).not.toContain(token);
    expect(logBuffer).not.toContain('kunde@example.com');
    // Session-Token steht nur im Set-Cookie – nie im Log.
    const [session] = await ctx.db.select().from(customerPortalSessions);
    expect(logBuffer).not.toContain(session!.tokenHash);
    expect(ctx.mailGateway.sent).toHaveLength(1);
  });

  it('A11. Token nur im verschlüsselten Secret-Payload (Ciphertext enthält ihn nicht; Entschlüsselung liefert ihn)', async () => {
    await adminAndCustomer();
    const result = await requestMagicLink(ctx, 'kunde@example.com');
    const [delivery] = await ctx.db.select().from(mailDeliveries);
    expect(delivery!.secretPayloadCiphertext).not.toBeNull();
    expect(delivery!.secretPayloadCiphertext).not.toContain(result.token!);
    expect(delivery!.secretPayloadCiphertext!.startsWith('v2:')).toBe(true);
    const plain = JSON.parse(
      ctx.communication.crypto.decrypt(
        delivery!.secretPayloadCiphertext!,
        'mail-secret-payload',
        delivery!.id,
      ),
    );
    expect(plain).toEqual({ portalToken: result.token });
    expect(delivery!.idempotencyKey).toBe(
      `customer_portal_magic_link:${(await ctx.db.select().from(customerPortalMagicLinks))[0]!.id}`,
    );
  });

  it('A12. Link trägt den Token NUR im Fragment (#token=) – kein Query-Parameter, kein GET-Consume', async () => {
    await adminAndCustomer();
    const token = await requestMagicLinkToken(ctx, 'kunde@example.com');
    await drainJobs(ctx);
    const mail = ctx.mailGateway.sent[0]!;
    expect(mail.text).toContain(`${WEB_BASE_URL}/konto/anmelden#token=${token}`);
    expect(mail.text).not.toContain('?token=');
    expect(mail.html).toContain('/konto/anmelden#token=');
    const get = await ctx.app.inject({ method: 'GET', url: `/portal/auth/consume?token=${token}` });
    expect(get.statusCode).toBe(404);
    expect(await ctx.db.select().from(customerPortalSessions)).toHaveLength(0);
  });

  it('A12b. Consume-Body strikt: unbekannte Felder 400, fehlerhaftes Tokenformat 401 ohne DB-Zugriff', async () => {
    await adminAndCustomer();
    const strict = await ctx.app.inject({
      method: 'POST',
      url: '/portal/auth/consume',
      payload: { token: 'x'.repeat(43), customerId: 'egal' },
    });
    expect(strict.statusCode).toBe(400);
    const malformed = await consume('kurz');
    expect(malformed.statusCode).toBe(401);
    expect(malformed.json().error.code).toBe('PORTAL_TOKEN_INVALID');
    const requestStrict = await ctx.app.inject({
      method: 'POST',
      url: '/portal/auth/request',
      payload: { email: 'kunde@example.com', customerId: 'egal' },
    });
    expect(requestStrict.statusCode).toBe(400);
  });
});

describe('Session-Cookie (Order §9)', () => {
  it('A14. development: Cookie mr_customer_session, HttpOnly, Path=/, SameSite=Strict, kein Domain, Max-Age = Rest bis Ablauf', async () => {
    await adminAndCustomer();
    const token = await requestMagicLinkToken(ctx, 'kunde@example.com');
    const response = await consume(token);
    const cookie = response.cookies.find((c) => c.name === PORTAL_SESSION_COOKIE_DEVELOPMENT)!;
    expect(cookie).toBeDefined();
    expect(cookie.value).toMatch(TOKEN_PATTERN);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.path).toBe('/');
    expect(cookie.sameSite?.toLowerCase()).toBe('strict');
    expect(cookie.domain).toBeUndefined();
    expect(cookie.maxAge).toBeGreaterThan(PORTAL_SESSION_TTL_MS / 1000 - 60);
    expect(cookie.maxAge).toBeLessThanOrEqual(PORTAL_SESSION_TTL_MS / 1000);
    expect(
      response.cookies.find((c) => c.name === PORTAL_SESSION_COOKIE_HOST_PREFIXED),
    ).toBeUndefined();
    // DB kennt nur den Hash des Session-Tokens.
    const [session] = await ctx.db.select().from(customerPortalSessions);
    expect(session!.tokenHash).toBe(sha256Hex(cookie.value));
  });

  it('A13. demo (wie staging/production): __Host-mr_customer_session mit Secure, Path=/, ohne Domain', async () => {
    const demo = await createPortalTestContext({
      appEnv: 'demo',
      env: { MAIL_DEMO_WHITELIST: '@example.com', MAIL_PUBLIC_WEB_BASE_URL: WEB_BASE_URL },
    });
    try {
      await resetAll(demo);
      const admin = await bootstrapAdmin(demo);
      await createTestCustomer(demo, admin.id, { email: 'demo-kunde@example.com' });
      const token = await requestMagicLinkToken(demo, 'demo-kunde@example.com');
      const response = await demo.app.inject({
        method: 'POST',
        url: '/portal/auth/consume',
        payload: { token },
      });
      expect(response.statusCode).toBe(200);
      const cookie = response.cookies.find((c) => c.name === PORTAL_SESSION_COOKIE_HOST_PREFIXED)!;
      expect(cookie).toBeDefined();
      expect(cookie.secure).toBe(true);
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.path).toBe('/');
      expect(cookie.domain).toBeUndefined();
      expect(cookie.sameSite?.toLowerCase()).toBe('strict');
      expect(
        response.cookies.find((c) => c.name === PORTAL_SESSION_COOKIE_DEVELOPMENT),
      ).toBeUndefined();
      const meResponse = await demo.app.inject({
        method: 'GET',
        url: '/portal/me',
        headers: { cookie: `${cookie.name}=${cookie.value}` },
      });
      expect(meResponse.statusCode).toBe(200);
      expect(meResponse.json().environment).toBe('demo');
      // Nicht gelistete Adresse: Outbox blockiert (DEMO_NOT_WHITELISTED), Antwort bleibt neutral 202.
      await createTestCustomer(demo, admin.id, { email: 'fremd@example.invalid' });
      const blocked = await requestMagicLink(demo, 'fremd@example.invalid');
      expect(blocked.statusCode).toBe(202);
      expect(blocked.body).toEqual({ message: PORTAL_MESSAGES.MAGIC_LINK_REQUESTED });
      const [delivery] = await demo.db
        .select()
        .from(mailDeliveries)
        .where(eq(mailDeliveries.id, blocked.deliveryId!));
      expect(delivery!.status).toBe('blocked');
      expect(delivery!.blockedReason).toBe('DEMO_NOT_WHITELISTED');
    } finally {
      await resetAll(demo);
      await destroyPortalTestContext(demo);
    }
  });
});

describe('Session-Lebensdauer (Order §8)', () => {
  it('A15. absolut 30 Tage: 29 Tage alte Session mit frischem last_seen ist gültig, nach 30 Tagen ungültig', async () => {
    const { customer } = await adminAndCustomer();
    const sessions = new PortalSessionService(ctx.db);
    const createdAt = new Date(Date.now() - 29 * DAY);
    const { token, session } = await sessions.create(customer.id, createdAt, 'Test');
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(PORTAL_SESSION_TTL_MS);
    const cookie = `${portalCookieName(ctx)}=${token}`;
    expect((await me(cookie)).statusCode).toBe(200); // touch ⇒ last_seen = jetzt
    const touched = await sessionRow(session.id);
    expect(touched.lastSeenAt).not.toBeNull();
    expect(touched.expiresAt.getTime()).toBe(session.expiresAt.getTime());
    // Einen Tag später (Service-Zeit): trotz frischem last_seen ungültig.
    const inOneDay = new Date(Date.now() + DAY + MINUTE);
    expect(await sessions.authenticate(token, { now: inOneDay })).toBeNull();
    expect(await sessions.authenticate(token, { now: new Date() })).not.toBeNull();
  });

  it('A16. kein Sliding: /portal/me (touch) ändert last_seen_at, nie expires_at; last_seen gedrosselt', async () => {
    const { customer } = await adminAndCustomer();
    const loginResult = await loginPortalCustomerSession(ctx, customer.id);
    const before = await sessionRow(loginResult.sessionId);
    expect(before.lastSeenAt).toBeNull();
    const first = await me(loginResult.cookie);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      customer: { displayName: 'Mia Muster', type: 'private', email: 'kunde@example.com' },
      session: { expiresAt: before.expiresAt.toISOString(), reauthFresh: true },
      links: { newInquiryUrl: null, phoneNumber: null },
      environment: 'development',
    });
    const afterFirst = await sessionRow(loginResult.sessionId);
    expect(afterFirst.lastSeenAt).not.toBeNull();
    expect(afterFirst.expiresAt.getTime()).toBe(before.expiresAt.getTime());
    await me(loginResult.cookie);
    const afterSecond = await sessionRow(loginResult.sessionId);
    expect(afterSecond.lastSeenAt!.getTime()).toBe(afterFirst.lastSeenAt!.getTime()); // < 60 s ⇒ kein Schreiben
    expect(afterSecond.expiresAt.getTime()).toBe(before.expiresAt.getTime());
  });

  it('A17. Logout widerruft die Session und löscht das Cookie; ohne gültige Session ebenfalls 204', async () => {
    const { customer } = await adminAndCustomer();
    const { cookie, sessionId } = await loginPortalCustomerSession(ctx, customer.id);
    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/portal/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(204);
    const cleared = logout.cookies.find((c) => c.name === portalCookieName(ctx))!;
    expect(cleared.value).toBe('');
    expect((await sessionRow(sessionId)).revokedAt).not.toBeNull();
    expect((await me(cookie)).statusCode).toBe(401);
    const anonymous = await ctx.app.inject({ method: 'POST', url: '/portal/auth/logout' });
    expect(anonymous.statusCode).toBe(204);
    const bogus = await ctx.app.inject({
      method: 'POST',
      url: '/portal/auth/logout',
      headers: { cookie: `${portalCookieName(ctx)}=${'a'.repeat(43)}` },
    });
    expect(bogus.statusCode).toBe(204);
  });

  it('A18. abgelaufene Session ⇒ 401 PORTAL_UNAUTHENTICATED und Cookie wird gelöscht; gelöschter Kunde ⇒ 401', async () => {
    const { admin, customer } = await adminAndCustomer();
    // Vor 30 Tagen + 1 Minute angelegt ⇒ expires_at liegt in der Vergangenheit (Constraint expires_at > created_at bleibt erfüllt).
    const { cookie, sessionId } = await loginPortalCustomerSession(ctx, customer.id, {
      now: new Date(Date.now() - PORTAL_SESSION_TTL_MS - MINUTE),
    });
    expect((await sessionRow(sessionId)).expiresAt.getTime()).toBeLessThan(Date.now());
    const expired = await me(cookie);
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error).toMatchObject({
      code: 'PORTAL_UNAUTHENTICATED',
      message: PORTAL_MESSAGES.UNAUTHENTICATED,
    });
    expect(expired.cookies.find((c) => c.name === portalCookieName(ctx))!.value).toBe('');

    const other = await createTestCustomer(ctx, admin.id, { email: 'anderer@example.com' });
    const otherLogin = await loginPortalCustomerSession(ctx, other.id);
    expect((await me(otherLogin.cookie)).statusCode).toBe(200);
    await customerServiceFor(ctx).moveToTrash(admin.id, other.id);
    expect((await me(otherLogin.cookie)).statusCode).toBe(401);
  });

  it('A18b. Staff-Session-Cookie und Angebots-Token sind keine Portal-Session (401); unbekannte Portal-Route 404', async () => {
    const { customer } = await adminAndCustomer();
    const staff = await login(ctx.app, 'admin@test.example', 'test-admin-passwort-123');
    expect(staff.statusCode).toBe(200);
    const asStaff = await me(staff.cookie);
    expect(asStaff.statusCode).toBe(401);
    // Staff-Token im Portal-Cookie-Namen: Hash existiert nicht in customer_portal_sessions.
    const staffToken = staff.cookie.split('=')[1]!;
    const forged = await me(`${portalCookieName(ctx)}=${staffToken}`);
    expect(forged.statusCode).toBe(401);
    // Angebots-/Dokumenten-Token-Form (43 Zeichen) ohne Session-Zeile ⇒ 401.
    const offerLike = await me(`${portalCookieName(ctx)}=${'b'.repeat(43)}`);
    expect(offerLike.statusCode).toBe(401);
    expect((await me(`${portalCookieName(ctx)}=`)).statusCode).toBe(401);
    expect(
      (
        await me(
          `${portalCookieName(ctx)}=${(await loginPortalCustomerSession(ctx, customer.id)).token}`,
        )
      ).statusCode,
    ).toBe(200);
  });
});

describe('Umgebungs-Isolation / Host-Header (Order §48/§49)', () => {
  const secondDb = process.env.TEST_DATABASE_URL_SECOND;

  it.skipIf(secondDb === undefined)(
    'A19. Cross-Environment: Session-Cookie und Magic-Link-Token der Demo-DB sind im development-Kontext ungültig (und umgekehrt)',
    async () => {
      const demo = await createPortalTestContext({
        appEnv: 'demo',
        databaseUrl: secondDb!,
        env: { MAIL_DEMO_WHITELIST: '@example.com', MAIL_PUBLIC_WEB_BASE_URL: WEB_BASE_URL },
      });
      try {
        await resetAll(demo);
        const demoAdmin = await bootstrapAdmin(demo);
        const demoCustomer = await createTestCustomer(demo, demoAdmin.id, {
          email: 'iso@example.com',
        });
        const demoLogin = await loginPortalCustomerSession(demo, demoCustomer.id);
        const demoToken = await requestMagicLinkToken(demo, 'iso@example.com');
        // development-Kontext (eigene DB): weder Session noch Magic Link bekannt.
        const { customer } = await adminAndCustomer('iso@example.com');
        expect((await me(`${portalCookieName(ctx)}=${demoLogin.token}`)).statusCode).toBe(401);
        expect((await consume(demoToken)).statusCode).toBe(401);
        // Umgekehrt: development-Session/-Token sind in der Demo-App unbekannt.
        const devLogin = await loginPortalCustomerSession(ctx, customer.id);
        const devToken = await requestMagicLinkToken(ctx, 'iso@example.com');
        const demoMe = await demo.app.inject({
          method: 'GET',
          url: '/portal/me',
          headers: { cookie: `${portalCookieName(demo)}=${devLogin.token}` },
        });
        expect(demoMe.statusCode).toBe(401);
        const demoConsume = await demo.app.inject({
          method: 'POST',
          url: '/portal/auth/consume',
          payload: { token: devToken },
        });
        expect(demoConsume.statusCode).toBe(401);
        expect(await demo.db.select().from(customerPortalSessions)).toHaveLength(1);
      } finally {
        await resetAll(demo);
        await destroyPortalTestContext(demo);
      }
    },
  );

  it('A19b. Cookie-Namen sind je Umgebung verschieden: ein development-Cookie wird außerhalb development nie gelesen', async () => {
    const { customer } = await adminAndCustomer();
    const devLogin = await loginPortalCustomerSession(ctx, customer.id);
    // Demo-Umgebungen lesen ausschließlich `__Host-mr_customer_session`.
    expect(portalCookieName(ctx)).toBe(PORTAL_SESSION_COOKIE_DEVELOPMENT);
    const wrongName = await me(`${PORTAL_SESSION_COOKIE_HOST_PREFIXED}=${devLogin.token}`);
    expect(wrongName.statusCode).toBe(401);
  });

  it('A20. Host-/X-Forwarded-Host-Header beeinflussen den Link nicht – nur MAIL_PUBLIC_WEB_BASE_URL', async () => {
    await adminAndCustomer();
    const result = await requestMagicLink(ctx, 'kunde@example.com', {
      headers: {
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'http',
        origin: 'https://evil.example',
      },
    });
    // Origin-Header fremder Herkunft ⇒ CSRF-Schutz lehnt die Mutation ab (403) – ohne Link.
    expect(result.statusCode).toBe(403);
    expect(result.token).toBeNull();
    const withoutOrigin = await requestMagicLink(ctx, 'kunde@example.com', {
      headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' },
    });
    expect(withoutOrigin.statusCode).toBe(202);
    expect(withoutOrigin.token).not.toBeNull();
    await drainJobs(ctx);
    const mail = ctx.mailGateway.sent[0]!;
    expect(mail.text).toContain(`${WEB_BASE_URL}/konto/anmelden#token=`);
    expect(mail.text).not.toContain('evil.example');
    expect(mail.html).not.toContain('evil.example');
  });
});

describe('Login-Pfad komplett und Diagnostik', () => {
  it('A21. Request → Outbox-Secret → Consume → /portal/me liefert PortalMeView; Audit ohne Adresse/Token; UA-Label grob', async () => {
    const { customer } = await adminAndCustomer();
    const { cookie } = await loginViaMagicLink(ctx, 'kunde@example.com');
    const response = await me(cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json().customer.email).toBe('kunde@example.com');
    const events = await ctx.pool.query(
      `select type, details from staff_security_events where type like 'portal.%' order by created_at`,
    );
    expect(events.rows.map((r) => r.type)).toEqual(['portal.login']);
    expect(events.rows[0].details.customerId).toBe(customer.id);
    expect(JSON.stringify(events.rows)).not.toContain('kunde@example.com');
    expect(JSON.stringify(events.rows)).not.toContain(cookie.split('=')[1]!);
    expect(
      portalUserAgentLabel(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Version/17.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari auf iPhone');
    expect(
      portalUserAgentLabel('Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile Safari/537.36'),
    ).toBe('Chrome auf Android');
    expect(portalUserAgentLabel(undefined)).toBeNull();
    const [session] = await ctx.db.select().from(customerPortalSessions);
    expect(session!.userAgentLabel).toBe('Browser');
    expect(session!.authenticatedAt.getTime()).toBe(session!.reauthenticatedAt.getTime());
    expect(session!.createdAt.getTime()).toBe(session!.authenticatedAt.getTime());
  });

  it('A22. Mailpfad-Fehler ⇒ Link-Zeile entsteht, kein Fehler nach außen (Route antwortet weiter neutral 202)', async () => {
    const { customer } = await adminAndCustomer();
    const failingOutbox = {
      enqueueAndSchedule: async () => {
        throw new Error('simulierter Outbox-Fehler');
      },
    };
    const service = new PortalMagicLinkService(
      ctx.db,
      failingOutbox,
      ctx.config,
      new PortalSessionService(ctx.db),
    );
    await expect(service.requestLogin('kunde@example.com')).resolves.toBeUndefined();
    const links = await ctx.db.select().from(customerPortalMagicLinks);
    expect(links).toHaveLength(1);
    expect(links[0]!.customerId).toBe(customer.id);
    // Ohne Outbox (Mail nicht konfiguriert): ebenfalls kein Fehler, Zeile entsteht.
    const noOutbox = new PortalMagicLinkService(
      ctx.db,
      null,
      ctx.config,
      new PortalSessionService(ctx.db),
    );
    await expect(noOutbox.requestLogin('kunde@example.com')).resolves.toBeUndefined();
    expect(await ctx.db.select().from(customerPortalMagicLinks)).toHaveLength(2);
    // Über die Route bleibt die Antwort in jedem Fall neutral.
    const result = await requestMagicLink(ctx, 'kunde@example.com');
    expect(result.statusCode).toBe(202);
    expect(result.body).toEqual({ message: PORTAL_MESSAGES.MAGIC_LINK_REQUESTED });
  });

  it('A23. IP-Fensterlimit (30/min) zählt je IP und räumt sich nach dem Fenster selbst', () => {
    const limiter = new IpWindowLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect(limiter.hit('1.1.1.1', t0)).toBe(true);
    expect(limiter.hit('1.1.1.1', t0 + 1)).toBe(true);
    expect(limiter.hit('1.1.1.1', t0 + 2)).toBe(true);
    expect(limiter.hit('1.1.1.1', t0 + 3)).toBe(false);
    expect(limiter.hit('2.2.2.2', t0 + 3)).toBe(true);
    expect(limiter.hit('1.1.1.1', t0 + 60_000)).toBe(true);
  });
});

describe('Rate-Limits der Auth-Grenze (Order §11)', () => {
  it('A26. mit aktivem Rate-Limit: 10 Login-Anforderungen je IP+Adresse pro Minute, danach 429 – Antwort bleibt ohne Adresse', async () => {
    const limited = await createPortalTestContext({ rateLimitEnabled: true });
    try {
      await resetAll(limited);
      const admin = await bootstrapAdmin(limited);
      await createTestCustomer(limited, admin.id, { email: 'limit@example.com' });
      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        const response = await limited.app.inject({
          method: 'POST',
          url: '/portal/auth/request',
          payload: { email: 'limit@example.com' },
        });
        statuses.push(response.statusCode);
        if (response.statusCode === 429) expect(response.body).not.toContain('limit@example.com');
      }
      expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
      expect(statuses[10]).toBe(429);
      // Andere Adresse von derselben IP ist (bis zum IP-Fenster von 30/min) weiter möglich.
      const other = await limited.app.inject({
        method: 'POST',
        url: '/portal/auth/request',
        payload: { email: 'andere@example.com' },
      });
      expect(other.statusCode).toBe(202);
      // Consume: 10/min je IP.
      const consumes: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        const response = await limited.app.inject({
          method: 'POST',
          url: '/portal/auth/consume',
          payload: { token: 'c'.repeat(43) },
        });
        consumes.push(response.statusCode);
      }
      expect(consumes.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(consumes[10]).toBe(429);
    } finally {
      await resetAll(limited);
      await destroyPortalTestContext(limited);
    }
  });
});

describe('Cleanup-Scanner portal_auth_cleanup (Order §52)', () => {
  it('A24. löscht alte verbrauchte/abgelaufene/widerrufene Links und alte Sessions ohne Links; frische Zeilen bleiben; idempotent', async () => {
    const { customer } = await adminAndCustomer();
    const now = new Date();
    const sessions = new PortalSessionService(ctx.db);
    const fresh = await sessions.create(customer.id, now, 'Test');
    const oldExpired = await sessions.create(
      customer.id,
      new Date(now.getTime() - PORTAL_SESSION_TTL_MS - PORTAL_SESSION_RETENTION_MS - DAY),
      'Test',
    );
    const oldRevoked = await sessions.create(customer.id, new Date(now.getTime() - DAY), 'Test');
    await ctx.db
      .update(customerPortalSessions)
      .set({ revokedAt: new Date(now.getTime() - PORTAL_SESSION_RETENTION_MS - DAY) })
      .where(eq(customerPortalSessions.id, oldRevoked.session.id));
    // Alte Session, auf die noch ein (frischer) Reauth-Link zeigt ⇒ bleibt.
    const oldWithLink = await sessions.create(
      customer.id,
      new Date(now.getTime() - PORTAL_SESSION_TTL_MS - PORTAL_SESSION_RETENTION_MS - DAY),
      'Test',
    );
    await ctx.db.insert(customerPortalMagicLinks).values([
      {
        customerId: customer.id,
        purpose: 'login',
        tokenHash: sha256Hex('alt-abgelaufen'),
        createdAt: new Date(now.getTime() - 3 * DAY),
        expiresAt: new Date(now.getTime() - PORTAL_MAGIC_LINK_RETENTION_MS - MINUTE),
      },
      {
        customerId: customer.id,
        purpose: 'login',
        tokenHash: sha256Hex('alt-verbraucht'),
        createdAt: new Date(now.getTime() - 3 * DAY),
        expiresAt: new Date(now.getTime() - 3 * DAY + PORTAL_MAGIC_LINK_TTL_MS),
        consumedAt: new Date(now.getTime() - 2 * DAY),
      },
      {
        customerId: customer.id,
        purpose: 'login',
        tokenHash: sha256Hex('frisch'),
        createdAt: now,
        expiresAt: new Date(now.getTime() + PORTAL_MAGIC_LINK_TTL_MS),
      },
      {
        customerId: customer.id,
        purpose: 'reauth',
        sessionId: oldWithLink.session.id,
        tokenHash: sha256Hex('reauth-frisch'),
        createdAt: now,
        expiresAt: new Date(now.getTime() + PORTAL_MAGIC_LINK_TTL_MS),
      },
    ]);
    const summary = await runPortalAuthCleanup(ctx.db, now);
    expect(summary).toEqual({ magicLinksDeleted: 2, sessionsDeleted: 2 });
    const remainingLinks = (await ctx.db.select().from(customerPortalMagicLinks))
      .map((l) => l.tokenHash)
      .sort();
    expect(remainingLinks).toEqual([sha256Hex('frisch'), sha256Hex('reauth-frisch')].sort());
    const remainingSessions = (await ctx.db.select().from(customerPortalSessions))
      .map((s) => s.id)
      .sort();
    expect(remainingSessions).toEqual([fresh.session.id, oldWithLink.session.id].sort());
    expect(oldExpired.session.id).not.toBe(fresh.session.id);
    expect(await runPortalAuthCleanup(ctx.db, now)).toEqual({
      magicLinksDeleted: 0,
      sessionsDeleted: 0,
    });
    // Über den Scan-Lauf des Testkontexts erreichbar (Scanner registriert).
    await ctx.scan.runOnce(now);
    expect(await ctx.db.select().from(customerPortalSessions)).toHaveLength(2);
  });
});

describe('Keine Businessdaten im Auth-Log', () => {
  it('A25. Request/Consume/Logout loggen weder E-Mail noch Token noch Snapshot-Inhalte', async () => {
    await adminAndCustomer('log-test@example.com');
    const { cookie, token } = await loginViaMagicLink(ctx, 'log-test@example.com');
    await ctx.app.inject({ method: 'POST', url: '/portal/auth/logout', headers: { cookie } });
    expect(logBuffer).not.toContain('log-test@example.com');
    expect(logBuffer).not.toContain(token);
    expect(logBuffer).not.toContain(cookie.split('=')[1]!);
    expect(logBuffer).not.toContain('Mia');
  });
});
