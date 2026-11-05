import { setTimeout as sleep } from 'node:timers/promises';
import { customers, demoDatasetState, mailDeliveries } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEMO_SUBJECT_PREFIX,
  MAIL_BLOCKED_DEMO_NOT_WHITELISTED,
} from '../src/communication/types.ts';
import { DemoDatasetService } from '../src/demo/dataset.ts';
import { DEMO_RESET_BARRIER_LOCK_KEY, type DemoResetBarrier } from '../src/demo/reset-barrier.ts';
import { DEMO_RESET_RETRY_AFTER_SECONDS } from '../src/demo/reset-gate.ts';
import { DEMO_MESSAGES } from '../src/demo/types.ts';
import { PortalSessionService } from '../src/portal/auth/session-service.ts';
import {
  PORTAL_SESSION_COOKIE_DEVELOPMENT,
  PORTAL_SESSION_COOKIE_HOST_PREFIXED,
} from '../src/portal/guard.ts';
import { PORTAL_MESSAGES } from '../src/portal/types.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { drainJobs } from './communication-helpers.ts';
import { createTestCustomer } from './crm-helpers.ts';
import { demoServicesFor, demoTestNow, freshDemoDatabase } from './demo-helpers.ts';
import { createEnvApp } from './env-app-helpers.ts';
import {
  latestPortalMailToken,
  loginPortalCustomerSession,
  loginViaMagicLink,
  portalCookieName,
  requestMagicLink,
  requestMagicLinkToken,
} from './portal-auth-helpers.ts';

/**
 * Phase 15 (PLATFORM, Order §45–§49, §65; Design §4.3): Kundenportal in der
 * Demo-Umgebung – Whitelist/[DEMO] für Magic-Link-Mails, Isolation der Sessions
 * und Tokens zwischen Umgebungen (zweite Datenbank), Reset-Löschgrenze
 * (Sessions, Magic Links, offener E-Mail-Wechsel), Reset-Gate und Reset-Barrier
 * für Portal-Mutationen, altes Magic-Consume gegen den neuen Seed, Production
 * ohne Gate. Namen laufen als „E<n>.“ (E1 Banner liegt in der Web-App/E2E – hier
 * nur die API-Quelle des Banners). Läuft gegen mietroyal_test6, zweite DB
 * mietroyal_test7 (TEST_DATABASE_URL_SECOND).
 */

const RESET_TIMEOUT_MS = 180_000;
/** Weit über dem früheren Schutzfenster (Phase 14 Final RB1) und über dem Gate-Cache (1 s). */
const BLOCK_MS = 1500;
const SLOW_ROUTE = '/portal/barrier-test/slow';
const WHITELIST_DOMAIN = 'demo.test';
const SECOND_DATABASE_URL =
  process.env.TEST_DATABASE_URL_SECOND ??
  'postgresql://mietroyal:mietroyal_local_dev@localhost:55432/mietroyal_test7';
/** Übungskunde mit Whitelist-Adresse UND bestätigter Buchung (process.settlement.review). */
const SEED_PORTAL_EMAIL = `einkauf@${WHITELIST_DOMAIN}`;

interface Gate {
  entered: Promise<void>;
  markEntered: () => void;
  released: Promise<void>;
  release: () => void;
}

function gate(): Gate {
  let markEntered: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, markEntered, released, release };
}

let ctx: TestContext;
let adminId: string;
const now = demoTestNow();
/** Testroute unter /portal: wartet an einem Gate und legt DANACH eine Portal-Session an (Business-Mutation). */
let slowGate: Gate | null = null;
let slowRequestEndedAt = 0;

beforeAll(async () => {
  ctx = await createTestContext({
    appEnv: 'demo',
    env: {
      MAIL_DEMO_WHITELIST: `@${WHITELIST_DOMAIN}`,
      MAIL_PUBLIC_WEB_BASE_URL: 'https://web.demo.test',
    },
    beforeReady: (app) => {
      app.post(SLOW_ROUTE, async (request) => {
        const body = request.body as { customerId: string };
        slowGate?.markEntered();
        await slowGate?.released;
        const { session } = await new PortalSessionService(ctx.db).create(
          body.customerId,
          new Date(),
          'Barrier-Test',
        );
        slowRequestEndedAt = Date.now();
        return { sessionId: session.id };
      });
    },
  });
  ({ adminId } = await freshDemoDatabase(ctx));
  await demoServicesFor(ctx).seed.seed({ actorId: adminId, now });
}, RESET_TIMEOUT_MS);

afterAll(async () => {
  await destroyTestContext(ctx);
});

// ── Hilfen ─────────────────────────────────────────────────────────────────────

async function count(table: string, pool = ctx.pool): Promise<number> {
  const result = await pool.query(`SELECT count(*)::int AS n FROM "${table}"`);
  return result.rows[0].n as number;
}

async function customerIdByEmail(email: string): Promise<string> {
  const rows = await ctx.db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.email, email));
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`Kunde ${email} fehlt`);
  return id;
}

function tokenOfCookieHeader(cookie: string): string {
  return cookie.slice(cookie.indexOf('=') + 1);
}

async function barrierLocks(): Promise<Array<{ mode: string; granted: boolean }>> {
  const result = await ctx.pool.query<{ mode: string; granted: boolean }>(
    `SELECT mode, granted FROM pg_locks
     WHERE locktype = 'advisory' AND objsubid = 1
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND classid::bigint = ((hashtext($1)::bigint >> 32) & 4294967295)
       AND objid::bigint = (hashtext($1)::bigint & 4294967295)
     ORDER BY mode, granted`,
    [DEMO_RESET_BARRIER_LOCK_KEY],
  );
  return result.rows;
}

async function sharedHeld(): Promise<number> {
  return (await barrierLocks()).filter((l) => l.mode === 'ShareLock' && l.granted).length;
}

async function exclusiveWaiting(): Promise<number> {
  return (await barrierLocks()).filter((l) => l.mode === 'ExclusiveLock' && !l.granted).length;
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error('waitFor: Bedingung nicht erfüllt');
}

async function expectNoLeak(barrier: DemoResetBarrier = ctx.demoBarrier!) {
  await waitFor(async () => (await barrierLocks()).length === 0);
  await waitFor(() => {
    const stats = barrier.stats();
    return stats.totalCount === stats.idleCount && stats.waitingCount === 0;
  });
  expect(await barrierLocks()).toEqual([]);
}

async function resetInProgress(): Promise<boolean> {
  return new DemoDatasetService(ctx.db).resetInProgress();
}

/** Reset-Flag direkt setzen/löschen (wie Phase A/D, ohne Exclusive-Lock) – nur Tests. */
async function setFlag(value: boolean): Promise<void> {
  const dataset = new DemoDatasetService(ctx.db);
  if (value) {
    await ctx.db.transaction(async (tx) => {
      await dataset.lockRow(tx);
      await dataset.beginReset(tx, { actorId: adminId, now: new Date() });
    });
    return;
  }
  await ctx.db
    .update(demoDatasetState)
    .set({ resetInProgress: false, resetStartedAt: null })
    .where(eq(demoDatasetState.id, 1));
  // Gate-Cache (TTL 1 s) sicher verfallen lassen, damit Folgetests nicht 503 sehen.
  await sleep(1100);
}

/** Reset-Service mit beobachtbarem Beginn von Phase B. */
function observingReset() {
  const observed = { wipeAt: 0 };
  const demo = demoServicesFor(ctx, {
    hooks: {
      beforeBusinessWipe: async () => {
        observed.wipeAt = Date.now();
      },
    },
  });
  return { reset: demo.reset, observed };
}

function startSlowRequest(app: FastifyInstance, customerId: string) {
  slowGate = gate();
  slowRequestEndedAt = 0;
  const response = app.inject({ method: 'POST', url: SLOW_ROUTE, payload: { customerId } });
  return { gate: slowGate, response };
}

async function deliveryById(id: string) {
  return (await ctx.db.select().from(mailDeliveries).where(eq(mailDeliveries.id, id)))[0] ?? null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Phase 15 – Kundenportal in der Demo (E1–E11)', () => {
  it('E1. Quelle des Demo-Banners: GET /health meldet environment demo (die Web-App zeigt daraus den Banner auch unter /konto); Portal-Routen existieren in der Demo-App', async () => {
    const health = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ environment: 'demo' });
    const me = await ctx.app.inject({ method: 'GET', url: '/portal/me' });
    expect(me.statusCode).toBe(401);
    expect(me.json()).toMatchObject({ error: { code: 'PORTAL_UNAUTHENTICATED' } });
    expect(portalCookieName(ctx)).toBe(PORTAL_SESSION_COOKIE_HOST_PREFIXED);
  });

  it('E12. Seed: Übungskunden mit Whitelist-Adresse haben eine bestätigte Buchung in einem offenen Vorgang (Portal-Übung mit Mail möglich, Design §4.3) – ohne Seed-Änderung', async () => {
    const result = await ctx.pool.query<{ email: string }>(
      `SELECT DISTINCT c.email FROM customers c
         JOIN processes p ON p.customer_id = c.id
         JOIN bookings b ON b.process_id = p.id
        WHERE c.deleted_at IS NULL AND c.email LIKE $1
          AND p.main_status IN ('open', 'reopened')
        ORDER BY c.email`,
      [`%@${WHITELIST_DOMAIN}`],
    );
    const emails = result.rows.map((row) => row.email);
    expect(emails).toEqual(
      expect.arrayContaining([
        `einkauf@${WHITELIST_DOMAIN}`, // process.settlement.review
        `jana.beispielhaft@${WHITELIST_DOMAIN}`, // process.return.missing_part
        `miriam.demoperson@${WHITELIST_DOMAIN}`, // process.return.damage
      ]),
    );
    // Jede Adresse ist eindeutig (sonst gäbe es keinen Link, Order §4).
    for (const email of emails) {
      const rows = await ctx.db
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.email, email));
      expect(rows, email).toHaveLength(1);
    }
    // Die Übung funktioniert: der Magic Link für den Seed-Kunden entsteht (pending, nicht blocked).
    const request = await requestMagicLink(ctx, SEED_PORTAL_EMAIL);
    expect(request.statusCode).toBe(202);
    expect(request.token).not.toBeNull();
    expect((await deliveryById(request.deliveryId!))?.status).toBe('pending');
  });

  it('E2./E3. Magic-Mail nur an die Whitelist: nicht gelistete Adresse ⇒ Zustellung blocked/DEMO_NOT_WHITELISTED, nie am Gateway; Antwort IMMER identisch 202; beide Betreffs tragen „[DEMO] “; Whitelist-Mail wird versendet', async () => {
    const allowed = await createTestCustomer(ctx, adminId, {
      firstName: 'Portal',
      lastName: 'Erlaubt',
      email: `portal.erlaubt@${WHITELIST_DOMAIN}`,
    });
    const blockedCustomer = await createTestCustomer(ctx, adminId, {
      firstName: 'Portal',
      lastName: 'Gesperrt',
      email: 'portal.gesperrt@example.com',
    });
    ctx.mailGateway.reset();

    const blocked = await requestMagicLink(ctx, blockedCustomer.email!);
    const okay = await requestMagicLink(ctx, allowed.email!);
    expect(blocked.statusCode).toBe(202);
    expect(okay.statusCode).toBe(202);
    expect(blocked.body).toEqual({ message: PORTAL_MESSAGES.MAGIC_LINK_REQUESTED });
    expect(okay.body).toEqual(blocked.body);

    expect(blocked.deliveryId).not.toBeNull();
    const blockedRow = (await deliveryById(blocked.deliveryId!))!;
    expect(blockedRow.status).toBe('blocked');
    expect(blockedRow.blockedReason).toBe(MAIL_BLOCKED_DEMO_NOT_WHITELISTED);
    expect(blockedRow.subject?.startsWith(DEMO_SUBJECT_PREFIX)).toBe(true);

    expect(okay.token).not.toBeNull();
    const okayRow = (await deliveryById(okay.deliveryId!))!;
    expect(okayRow.status).toBe('pending');
    expect(okayRow.subject?.startsWith(DEMO_SUBJECT_PREFIX)).toBe(true);

    await drainJobs(ctx);
    expect((await deliveryById(okay.deliveryId!))?.status).toBe('sent');
    expect((await deliveryById(blocked.deliveryId!))?.status).toBe('blocked');
    const attempts = ctx.mailGateway.attempts.map((message) => JSON.stringify(message));
    expect(attempts.some((text) => text.includes(blockedCustomer.email!))).toBe(false);
    const sentToAllowed = ctx.mailGateway.sent.filter((message) =>
      JSON.stringify(message).includes(allowed.email!),
    );
    expect(sentToAllowed).toHaveLength(1);
    expect(sentToAllowed[0]!.subject.startsWith(DEMO_SUBJECT_PREFIX)).toBe(true);
    // Link zeigt auf die konfigurierte Demo-Web-Basis (nie Host-Header) und trägt das Token nur im Fragment.
    const rendered = JSON.stringify(sentToAllowed[0]);
    expect(rendered).toContain('https://web.demo.test/konto/anmelden#token=');
  });

  it(
    'E4. Demo-Session nur in der Demo-DB (Order §48): Session-Cookie und Magic Link aus der Demo sind in einer development-App auf einer ZWEITEN Datenbank ungültig (401, keine Session-Zeile) – und umgekehrt',
    async () => {
      const second = await createTestContext({ databaseUrl: SECOND_DATABASE_URL });
      try {
        const { adminId: secondAdminId } = await freshDemoDatabase(second);
        expect(portalCookieName(second)).toBe(PORTAL_SESSION_COOKIE_DEVELOPMENT);

        // Demo-Login über den echten Magic-Link-Pfad.
        const demoLogin = await loginViaMagicLink(ctx, SEED_PORTAL_EMAIL);
        const demoToken = tokenOfCookieHeader(demoLogin.cookie);
        expect(
          (
            await ctx.app.inject({
              method: 'GET',
              url: '/portal/me',
              headers: { cookie: demoLogin.cookie },
            })
          ).statusCode,
        ).toBe(200);

        // Demo-Sessiontoken in der development-App (zweite DB) ⇒ 401, nichts geschrieben.
        const crossSession = await second.app.inject({
          method: 'GET',
          url: '/portal/me',
          headers: { cookie: `${PORTAL_SESSION_COOKIE_DEVELOPMENT}=${demoToken}` },
        });
        expect(crossSession.statusCode).toBe(401);
        expect(crossSession.json()).toMatchObject({ error: { code: 'PORTAL_UNAUTHENTICATED' } });
        expect(await count('customer_portal_sessions', second.pool)).toBe(0);

        // Demo-Magic-Link in der development-App ⇒ 401, keine Session; der Demo-Link bleibt unverbraucht.
        const demoMagicToken = await requestMagicLinkToken(ctx, SEED_PORTAL_EMAIL);
        const crossConsume = await second.app.inject({
          method: 'POST',
          url: '/portal/auth/consume',
          payload: { token: demoMagicToken },
        });
        expect(crossConsume.statusCode).toBe(401);
        expect(crossConsume.json()).toMatchObject({ error: { code: 'PORTAL_TOKEN_INVALID' } });
        expect(
          crossConsume.cookies.find((c) => c.name.includes('mr_customer_session')),
        ).toBeUndefined();
        expect(await count('customer_portal_sessions', second.pool)).toBe(0);
        expect(await count('customer_portal_magic_links', second.pool)).toBe(0);
        const openDemoLinks = await ctx.pool.query(
          `SELECT count(*)::int AS n FROM customer_portal_magic_links WHERE consumed_at IS NULL AND revoked_at IS NULL AND purpose = 'login'`,
        );
        expect(openDemoLinks.rows[0].n).toBeGreaterThanOrEqual(1);
        // Derselbe Link funktioniert in der Demo-App weiterhin genau einmal.
        const demoConsume = await ctx.app.inject({
          method: 'POST',
          url: '/portal/auth/consume',
          payload: { token: demoMagicToken },
        });
        expect(demoConsume.statusCode).toBe(200);

        // Umgekehrt: development-Session (zweite DB) öffnet in der Demo-App nichts.
        const devCustomer = await createTestCustomer(second, secondAdminId, {
          firstName: 'Dev',
          lastName: 'Kunde',
          email: 'dev.kunde@example.com',
        });
        const devLogin = await loginPortalCustomerSession(second, devCustomer.id);
        const demoSessionsBefore = await count('customer_portal_sessions');
        const reverse = await ctx.app.inject({
          method: 'GET',
          url: '/portal/me',
          headers: { cookie: `${PORTAL_SESSION_COOKIE_HOST_PREFIXED}=${devLogin.token}` },
        });
        expect(reverse.statusCode).toBe(401);
        expect(await count('customer_portal_sessions')).toBe(demoSessionsBefore);
        expect(
          (
            await second.app.inject({
              method: 'GET',
              url: '/portal/me',
              headers: { cookie: devLogin.cookie },
            })
          ).statusCode,
        ).toBe(200);
      } finally {
        await destroyTestContext(second);
      }
    },
    RESET_TIMEOUT_MS,
  );

  it('E8. Portal-Mutationen während eines Resets ⇒ 503 DEMO_RESET mit retry-after 15 (Login-Request, Consume, Logout, Profil, E-Mail-Wechsel); Lesezugriffe und /auth bleiben frei', async () => {
    const login = await loginViaMagicLink(ctx, SEED_PORTAL_EMAIL);
    await setFlag(true);
    try {
      for (const [method, url, payload] of [
        ['POST', '/portal/auth/request', { email: SEED_PORTAL_EMAIL }],
        ['POST', '/portal/auth/consume', { token: 'x'.repeat(43) }],
        ['POST', '/portal/auth/logout', undefined],
        ['POST', '/portal/auth/reauth/request', {}],
        ['POST', '/portal/auth/email-change/request', { email: `neu@${WHITELIST_DOMAIN}` }],
        ['PATCH', '/portal/profile', { phone: '+49 6131 000000' }],
      ] as const) {
        const response = await ctx.app.inject({
          method,
          url,
          headers: { cookie: login.cookie },
          ...(payload === undefined ? {} : { payload }),
        });
        expect(response.statusCode, `${method} ${url}`).toBe(503);
        expect(response.headers['retry-after']).toBe(String(DEMO_RESET_RETRY_AFTER_SECONDS));
        expect(response.json()).toMatchObject({
          error: { code: 'DEMO_RESET', message: DEMO_MESSAGES.DEMO_RESET },
        });
      }
      // Nichts wurde geschrieben: keine neue Session, kein neuer Magic Link.
      const me = await ctx.app.inject({
        method: 'GET',
        url: '/portal/me',
        headers: { cookie: login.cookie },
      });
      expect(me.statusCode).toBe(200); // Lesen bleibt möglich, Session unverändert gültig
      expect((await ctx.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    } finally {
      await setFlag(false);
    }
    // Nach dem Ende: Logout funktioniert wieder.
    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/portal/auth/logout',
      headers: { cookie: login.cookie },
    });
    expect(logout.statusCode).toBe(204);
  });

  it(
    'E11. Production unverändert: dieselben Portal-Routen ohne Gate – POST /portal/auth/request 202 neutral auch bei gesetztem Reset-Flag, kein Demo-Endpunkt (404), __Host-Cookie-Name',
    async () => {
      const production = await createEnvApp(ctx, 'production');
      try {
        expect(
          (await production.inject({ method: 'GET', url: '/staff/demo/status' })).statusCode,
        ).toBe(404);
        const health = await production.inject({ method: 'GET', url: '/health' });
        expect(health.json()).toMatchObject({ environment: 'production' });

        const request = await production.inject({
          method: 'POST',
          url: '/portal/auth/request',
          payload: { email: SEED_PORTAL_EMAIL },
        });
        expect(request.statusCode).toBe(202);
        expect(request.json()).toEqual({ message: PORTAL_MESSAGES.MAGIC_LINK_REQUESTED });

        await setFlag(true);
        try {
          const duringFlag = await production.inject({
            method: 'POST',
            url: '/portal/auth/request',
            payload: { email: 'niemand@example.com' },
          });
          expect(duringFlag.statusCode).toBe(202); // kein Reset-Gate außerhalb demo
          const demoDuringFlag = await ctx.app.inject({
            method: 'POST',
            url: '/portal/auth/request',
            payload: { email: 'niemand@example.com' },
          });
          expect(demoDuringFlag.statusCode).toBe(503);
        } finally {
          await setFlag(false);
        }
        const consume = await production.inject({
          method: 'POST',
          url: '/portal/auth/consume',
          payload: { token: 'A'.repeat(43) },
        });
        expect(consume.statusCode).toBe(401);
        expect(consume.json()).toMatchObject({ error: { code: 'PORTAL_TOKEN_INVALID' } });
        const me = await production.inject({ method: 'GET', url: '/portal/me' });
        expect(me.statusCode).toBe(401);
        // Gelöschtes Cookie trägt den __Host-Namen (production ist nie development).
        expect(
          me.cookies.some((c) => c.name === PORTAL_SESSION_COOKIE_HOST_PREFIXED) ||
            me.headers['set-cookie'] === undefined,
        ).toBe(true);
      } finally {
        await production.close();
      }
    },
    RESET_TIMEOUT_MS,
  );

  // Zustand für E10 (Tokens aus der Zeit VOR dem Reset).
  let staleLoginToken = '';
  let staleEmailChangeToken = '';
  let staleCookie = '';

  it(
    'E5./E6./E7. Reset löscht Portal-Sessions, Magic Links und den offenen E-Mail-Wechsel (Zähler vor/nach, deleted-Zähler des Resets); Staff-Sessions bleiben; alte Session danach 401',
    async () => {
      const login = await loginViaMagicLink(ctx, SEED_PORTAL_EMAIL);
      staleCookie = login.cookie;
      staleLoginToken = await requestMagicLinkToken(ctx, SEED_PORTAL_EMAIL);
      const emailChange = await ctx.app.inject({
        method: 'POST',
        url: '/portal/auth/email-change/request',
        headers: { cookie: login.cookie },
        payload: { email: `neue.adresse@${WHITELIST_DOMAIN}` },
      });
      expect(emailChange.statusCode).toBe(202);
      const pending = await latestPortalMailToken(ctx, 'customer_portal_email_change');
      expect(pending).not.toBeNull();
      staleEmailChangeToken = pending!.token;

      const sessionsBefore = await count('customer_portal_sessions');
      const linksBefore = await count('customer_portal_magic_links');
      const pendingEmailChanges = await ctx.pool.query(
        `SELECT count(*)::int AS n FROM customer_portal_magic_links WHERE purpose = 'email_change' AND consumed_at IS NULL AND revoked_at IS NULL`,
      );
      expect(sessionsBefore).toBeGreaterThan(0);
      expect(linksBefore).toBeGreaterThan(1);
      expect(pendingEmailChanges.rows[0].n).toBe(1);
      const staffSessionsBefore = await count('staff_sessions');

      const result = await demoServicesFor(ctx).reset.reset({ actorId: adminId, now: new Date() });
      expect(result.ok).toBe(true);
      expect(result.deleted.customer_portal_sessions).toBe(sessionsBefore);
      expect(result.deleted.customer_portal_magic_links).toBe(linksBefore);

      expect(await count('customer_portal_sessions')).toBe(0);
      expect(await count('customer_portal_magic_links')).toBe(0);
      expect(await count('staff_sessions')).toBe(staffSessionsBefore);
      const me = await ctx.app.inject({
        method: 'GET',
        url: '/portal/me',
        headers: { cookie: login.cookie },
      });
      expect(me.statusCode).toBe(401);
      // Der neue Seed trägt die alte Adresse wieder (neue ID), nie die vorgeschlagene neue.
      expect(
        await ctx.db
          .select({ id: customers.id })
          .from(customers)
          .where(eq(customers.email, `neue.adresse@${WHITELIST_DOMAIN}`)),
      ).toHaveLength(0);
      await expectNoLeak();
    },
    RESET_TIMEOUT_MS,
  );

  it('E10. Altes Magic-Consume nach dem Reset ⇒ 401 PORTAL_TOKEN_INVALID, kein Cookie, keine Session-Zeile im neuen Seed; alter E-Mail-Wechsel-Link ebenso wirkungslos', async () => {
    expect(staleLoginToken).not.toBe('');
    const consume = await ctx.app.inject({
      method: 'POST',
      url: '/portal/auth/consume',
      payload: { token: staleLoginToken },
    });
    expect(consume.statusCode).toBe(401);
    expect(consume.json()).toMatchObject({
      error: { code: 'PORTAL_TOKEN_INVALID', message: PORTAL_MESSAGES.TOKEN_INVALID },
    });
    const sessionCookie = consume.cookies.find(
      (c) => c.name === PORTAL_SESSION_COOKIE_HOST_PREFIXED,
    );
    expect(sessionCookie === undefined || sessionCookie.value === '').toBe(true);
    expect(await count('customer_portal_sessions')).toBe(0);
    expect(await count('customer_portal_magic_links')).toBe(0);

    const emailChange = await ctx.app.inject({
      method: 'POST',
      url: '/portal/auth/email-change/consume',
      payload: { token: staleEmailChangeToken },
    });
    expect(emailChange.statusCode).toBe(401);
    expect(
      await ctx.db
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.email, `neue.adresse@${WHITELIST_DOMAIN}`)),
    ).toHaveLength(0);
    // Der Seed-Kunde existiert neu (andere ID) mit unveränderter Adresse; das alte Cookie bleibt ungültig.
    await customerIdByEmail(SEED_PORTAL_EMAIL);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/portal/me', headers: { cookie: staleCookie } }))
        .statusCode,
    ).toBe(401);
    expect(await count('customer_portal_sessions')).toBe(0);
  });

  it(
    'E9. Laufende Portal-Mutation blockiert den Reset (Shared-Barrier): Phase B beginnt erst nach dem Ende des /portal-Requests, neue Portal-Mutationen erhalten währenddessen 503, die im Request angelegte Session wird mit gelöscht; keine Lock-Leaks',
    async () => {
      const customerId = await customerIdByEmail(SEED_PORTAL_EMAIL);
      const { gate: slow, response } = startSlowRequest(ctx.app, customerId);
      await slow.entered;
      expect(await sharedHeld()).toBe(1);

      const { reset, observed } = observingReset();
      const run = reset.reset({ actorId: adminId, now: new Date() });
      await sleep(BLOCK_MS);
      expect(await resetInProgress()).toBe(true); // Phase A committet
      expect(await exclusiveWaiting()).toBe(1); // Reset wartet an der Barrier
      expect(observed.wipeAt).toBe(0); // Phase B nicht begonnen
      const blocked = await ctx.app.inject({
        method: 'POST',
        url: '/portal/auth/request',
        payload: { email: SEED_PORTAL_EMAIL },
      });
      expect(blocked.statusCode).toBe(503);
      expect(blocked.json()).toMatchObject({ error: { code: 'DEMO_RESET' } });

      slow.release();
      const reply = await response;
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toMatchObject({ sessionId: expect.any(String) });
      const result = await run;
      expect(result.ok).toBe(true);
      expect(observed.wipeAt).toBeGreaterThanOrEqual(slowRequestEndedAt);
      expect(result.barrierWaitMs).toBeGreaterThanOrEqual(BLOCK_MS - 50);
      expect(result.deleted.customer_portal_sessions).toBeGreaterThanOrEqual(1);
      expect(await count('customer_portal_sessions')).toBe(0); // vor Phase B geschrieben ⇒ gelöscht
      expect(await resetInProgress()).toBe(false);
      await expectNoLeak();

      // Normalbetrieb auf dem neuen Datensatz: Anmeldung funktioniert wieder.
      const login = await loginViaMagicLink(ctx, SEED_PORTAL_EMAIL);
      expect(
        (
          await ctx.app.inject({
            method: 'GET',
            url: '/portal/me',
            headers: { cookie: login.cookie },
          })
        ).statusCode,
      ).toBe(200);
    },
    RESET_TIMEOUT_MS,
  );
});
