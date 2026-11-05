/**
 * Phase 15 (Review, Gruppe B – AUTH): Regressionstests zu den Review-Funden
 * R4 (DB-basierte Versanddrossel), R6 (parallele E-Mail-Wechsel/Consumes),
 * R7 (Lost Update Profil ↔ E-Mail-Wechsel), R8 (kein Existenz-Orakel beim
 * E-Mail-Wechsel) und R9 (Papierkorb beendet Portal-Sessions endgültig).
 * Jeder Test war vor dem Fix rot (Reproduktion) – Ausnahmen stehen im Testnamen
 * bzw. im Bericht (phase15_fix_B.md). Kein echter Provider: FakeMailGateway;
 * Tokens nur in-process aus dem verschlüsselten Outbox-Secret.
 */
import { PassThrough } from 'node:stream';
import {
  customerPortalMagicLinks,
  customerPortalSessions,
  customers,
  mailDeliveries,
} from '@mietroyal/database';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateToken, sha256Hex } from '../src/auth/crypto.ts';
import { CustomerService } from '../src/crm/customer-service.ts';
import { PortalMagicLinkService } from '../src/portal/auth/magic-link-service.ts';
import { PortalSessionService } from '../src/portal/auth/session-service.ts';
import { PORTAL_MESSAGES } from '../src/portal/types.ts';
import { bootstrapAdmin, truncateAuthTables, type TestContext } from './auth-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { truncateCommunicationTables } from './communication-helpers.ts';
import { createTestCustomer, customerServiceFor, truncateCrmTables } from './crm-helpers.ts';
import {
  createPortalTestContext,
  destroyPortalTestContext,
  latestPortalMailToken,
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
/** Erwartete Drossel laut Fix-Plan R4: höchstens 5 Links je 15 Minuten (bewusst hart kodiert). */
const THROTTLE_MAX = 5;
const THROTTLE_WINDOW_MS = 15 * MINUTE;
/** Mindestdauer der neutralen Antworten (wie die Login-Anforderung). */
const MIN_DURATION_MS = 150;

let ctx: PortalTestContext;

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
  ctx = await createPortalTestContext({ env: { MAIL_PUBLIC_WEB_BASE_URL: WEB_BASE_URL } });
});
afterAll(async () => {
  await destroyPortalTestContext(ctx);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await resetAll(ctx);
});

// ── Hilfen ───────────────────────────────────────────────────────────────────

async function customerWithSession(
  context: PortalTestContext,
  adminId: string,
  email: string,
  firstName = 'Mia',
) {
  const customer = await createTestCustomer(context, adminId, {
    email,
    firstName,
    lastName: 'Muster',
  });
  const session = await loginPortalCustomerSession(context, customer.id);
  return { customer, session };
}

async function linksOf(context: PortalTestContext, customerId: string) {
  return context.db
    .select()
    .from(customerPortalMagicLinks)
    .where(eq(customerPortalMagicLinks.customerId, customerId));
}

async function openLinksOf(
  context: PortalTestContext,
  customerId: string,
  purpose: 'login' | 'reauth' | 'email_change',
) {
  return context.db
    .select()
    .from(customerPortalMagicLinks)
    .where(
      and(
        eq(customerPortalMagicLinks.customerId, customerId),
        eq(customerPortalMagicLinks.purpose, purpose),
        isNull(customerPortalMagicLinks.consumedAt),
        isNull(customerPortalMagicLinks.revokedAt),
      ),
    );
}

async function mailsOfKind(
  context: PortalTestContext,
  kind: 'customer_portal_magic_link' | 'customer_portal_reauth' | 'customer_portal_email_change',
) {
  return context.db.select().from(mailDeliveries).where(eq(mailDeliveries.kind, kind));
}

async function customerRow(context: PortalTestContext, customerId: string) {
  const rows = await context.db.select().from(customers).where(eq(customers.id, customerId));
  return rows[0]!;
}

async function activeSessionsOf(context: PortalTestContext, customerId: string) {
  return context.db
    .select()
    .from(customerPortalSessions)
    .where(
      and(
        eq(customerPortalSessions.customerId, customerId),
        isNull(customerPortalSessions.revokedAt),
      ),
    );
}

/** Alle Links des Kunden um `ms` in die Vergangenheit schieben (Zeitfenster simulieren). */
async function ageLinks(context: PortalTestContext, customerId: string, ms: number) {
  await context.pool.query(
    `update customer_portal_magic_links
        set created_at = created_at - ($2::int * interval '1 millisecond'),
            expires_at = expires_at - ($2::int * interval '1 millisecond')
      where customer_id = $1`,
    [customerId, ms],
  );
}

const me = (context: PortalTestContext, cookie: string) =>
  context.app.inject({ method: 'GET', url: '/portal/me', headers: { cookie } });
const loginConsume = (context: PortalTestContext, token: string) =>
  context.app.inject({ method: 'POST', url: '/portal/auth/consume', payload: { token } });
const emailChangeRequest = (
  context: PortalTestContext,
  cookie: string,
  email: string,
  headers: Record<string, string> = {},
  remoteAddress?: string,
) =>
  context.app.inject({
    method: 'POST',
    url: '/portal/auth/email-change/request',
    headers: { cookie, ...headers },
    payload: { email },
    ...(remoteAddress === undefined ? {} : { remoteAddress }),
  });
const emailChangeConsume = (context: PortalTestContext, token: string) =>
  context.app.inject({
    method: 'POST',
    url: '/portal/auth/email-change/consume',
    payload: { token },
  });
const patchProfile = (context: PortalTestContext, cookie: string, payload: object) =>
  context.app.inject({ method: 'PATCH', url: '/portal/profile', headers: { cookie }, payload });

// ── R4: DB-basierte Versanddrossel (unabhängig von IP/X-Forwarded-For) ─────────

describe('R4 – Versanddrossel je Kunde/Session (Code-Teil)', () => {
  /**
   * Kontext wie hinter einem Proxy: Rate-Limits AKTIV, API_TRUST_PROXY_HOPS=1,
   * die TCP-Gegenstelle ist immer der Proxy (10.0.0.2) – ein Angreifer rotiert
   * X-Forwarded-For und umgeht damit alle IP-Schlüssel der Route.
   */
  let proxied: PortalTestContext;
  let logBuffer = '';
  const PROXY_ADDRESS = '10.0.0.2';
  const spoofed = (i: number) => ({ 'x-forwarded-for': `198.51.100.${i}` });

  beforeAll(async () => {
    const sink = new PassThrough();
    sink.on('data', (chunk: Buffer) => {
      logBuffer += chunk.toString('utf8');
    });
    proxied = await createPortalTestContext({
      rateLimitEnabled: true,
      logDestination: sink,
      logLevel: 'info',
      env: { MAIL_PUBLIC_WEB_BASE_URL: WEB_BASE_URL, API_TRUST_PROXY_HOPS: '1' },
    });
  });
  afterAll(async () => {
    await resetAll(proxied);
    await destroyPortalTestContext(proxied);
  });
  beforeEach(async () => {
    await resetAll(proxied);
    logBuffer = '';
  });

  it('R4. Login: 6. Anforderung binnen 15 min mit rotierendem X-Forwarded-For ⇒ identische neutrale 202, aber keine Zeile, kein Widerruf, keine Mail; nach dem Fenster wieder möglich', async () => {
    const admin = await bootstrapAdmin(proxied);
    const customer = await createTestCustomer(proxied, admin.id, {
      email: 'opfer@example.com',
      firstName: 'Olga',
    });
    const responses: { status: number; body: string; ms: number }[] = [];
    for (let i = 1; i <= THROTTLE_MAX + 1; i += 1) {
      const started = Date.now();
      const response = await proxied.app.inject({
        method: 'POST',
        url: '/portal/auth/request',
        payload: { email: 'opfer@example.com' },
        headers: spoofed(i),
        remoteAddress: PROXY_ADDRESS,
      });
      responses.push({
        status: response.statusCode,
        body: response.body,
        ms: Date.now() - started,
      });
    }
    // Öffentlich ununterscheidbar: Status, Body und Mindestdauer identisch.
    expect(responses.map((r) => r.status)).toEqual(Array(THROTTLE_MAX + 1).fill(202));
    expect(new Set(responses.map((r) => r.body)).size).toBe(1);
    expect(JSON.parse(responses[0]!.body)).toEqual({
      message: PORTAL_MESSAGES.MAGIC_LINK_REQUESTED,
    });
    expect(responses.every((r) => r.ms >= MIN_DURATION_MS - 5)).toBe(true);

    // Genau 5 Links und 5 Mails; der 5. Link bleibt offen (6. Anforderung widerruft nichts).
    const links = await linksOf(proxied, customer.id);
    expect(links).toHaveLength(THROTTLE_MAX);
    expect(await mailsOfKind(proxied, 'customer_portal_magic_link')).toHaveLength(THROTTLE_MAX);
    const open = await openLinksOf(proxied, customer.id, 'login');
    expect(open).toHaveLength(1);
    const newest = [...links].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
    expect(open[0]!.id).toBe(newest.id);
    // Log nennt den Grund, aber nie die Adresse.
    expect(logBuffer).toContain('"reason":"throttled"');
    expect(logBuffer).not.toContain('opfer@example.com');

    // Nach dem Fenster (Links > 15 min alt) entsteht wieder ein Link.
    await ageLinks(proxied, customer.id, THROTTLE_WINDOW_MS + 1000);
    const after = await proxied.app.inject({
      method: 'POST',
      url: '/portal/auth/request',
      payload: { email: 'opfer@example.com' },
      headers: spoofed(99),
      remoteAddress: PROXY_ADDRESS,
    });
    expect(after.statusCode).toBe(202);
    expect(after.body).toBe(responses[0]!.body);
    expect(await linksOf(proxied, customer.id)).toHaveLength(THROTTLE_MAX + 1);
    expect(await mailsOfKind(proxied, 'customer_portal_magic_link')).toHaveLength(THROTTLE_MAX + 1);
  });

  it('R4. Login (Service-Zeit): Fenstergrenze 15 min – 6. Anforderung nach 14 min gedrosselt, nach 15 min + 1 s wieder erlaubt', async () => {
    const admin = await bootstrapAdmin(proxied);
    const customer = await createTestCustomer(proxied, admin.id, { email: 'zeit@example.com' });
    const service = new PortalMagicLinkService(
      proxied.db,
      null,
      proxied.config,
      new PortalSessionService(proxied.db),
    );
    const t0 = new Date();
    for (let i = 0; i < THROTTLE_MAX; i += 1) {
      await service.requestLogin('zeit@example.com', new Date(t0.getTime() + i * 1000));
    }
    expect(await linksOf(proxied, customer.id)).toHaveLength(THROTTLE_MAX);
    await service.requestLogin('zeit@example.com', new Date(t0.getTime() + 14 * MINUTE));
    expect(await linksOf(proxied, customer.id)).toHaveLength(THROTTLE_MAX);
    // Nach 15 min + 1 s liegt der erste Link außerhalb des Fensters ⇒ 4 im Fenster ⇒ erlaubt.
    await service.requestLogin(
      'zeit@example.com',
      new Date(t0.getTime() + THROTTLE_WINDOW_MS + 1000),
    );
    expect(await linksOf(proxied, customer.id)).toHaveLength(THROTTLE_MAX + 1);
  });

  it('R4. Reauth: je Session höchstens 5 Links/15 min – 6. Anforderung (rotierendes XFF) still 202 ohne Link/Mail; andere Session unberührt', async () => {
    const admin = await bootstrapAdmin(proxied);
    const { customer, session } = await customerWithSession(proxied, admin.id, 're@example.com');
    const statuses: number[] = [];
    const bodies = new Set<string>();
    for (let i = 1; i <= THROTTLE_MAX + 1; i += 1) {
      const response = await proxied.app.inject({
        method: 'POST',
        url: '/portal/auth/reauth/request',
        headers: { cookie: session.cookie, ...spoofed(i) },
        remoteAddress: PROXY_ADDRESS,
      });
      statuses.push(response.statusCode);
      bodies.add(response.body);
    }
    expect(statuses).toEqual(Array(THROTTLE_MAX + 1).fill(202));
    expect(bodies.size).toBe(1);
    const reauthLinks = (await linksOf(proxied, customer.id)).filter((l) => l.purpose === 'reauth');
    expect(reauthLinks).toHaveLength(THROTTLE_MAX);
    expect(await mailsOfKind(proxied, 'customer_portal_reauth')).toHaveLength(THROTTLE_MAX);
    expect(await openLinksOf(proxied, customer.id, 'reauth')).toHaveLength(1);
    // Zweite Session desselben Kunden hat ihr eigenes Kontingent.
    const second = await loginPortalCustomerSession(proxied, customer.id);
    const other = await proxied.app.inject({
      method: 'POST',
      url: '/portal/auth/reauth/request',
      headers: { cookie: second.cookie, ...spoofed(50) },
      remoteAddress: PROXY_ADDRESS,
    });
    expect(other.statusCode).toBe(202);
    expect(await mailsOfKind(proxied, 'customer_portal_reauth')).toHaveLength(THROTTLE_MAX + 1);
    // Nach dem Fenster wieder möglich.
    await ageLinks(proxied, customer.id, THROTTLE_WINDOW_MS + 1000);
    const later = await proxied.app.inject({
      method: 'POST',
      url: '/portal/auth/reauth/request',
      headers: { cookie: session.cookie, ...spoofed(77) },
      remoteAddress: PROXY_ADDRESS,
    });
    expect(later.statusCode).toBe(202);
    expect(await mailsOfKind(proxied, 'customer_portal_reauth')).toHaveLength(THROTTLE_MAX + 2);
  });

  it('R4. E-Mail-Wechsel: je Kunde höchstens 5 Links/15 min – 6. Anforderung (rotierendes XFF) still 202 ohne Link/Mail', async () => {
    const admin = await bootstrapAdmin(proxied);
    const { customer, session } = await customerWithSession(proxied, admin.id, 'ec@example.com');
    const statuses: number[] = [];
    const bodies = new Set<string>();
    for (let i = 1; i <= THROTTLE_MAX + 1; i += 1) {
      const response = await emailChangeRequest(
        proxied,
        session.cookie,
        `ziel${i}@example.com`,
        spoofed(i),
        PROXY_ADDRESS,
      );
      statuses.push(response.statusCode);
      bodies.add(response.body);
    }
    expect(statuses).toEqual(Array(THROTTLE_MAX + 1).fill(202));
    expect(bodies.size).toBe(1);
    const changeLinks = (await linksOf(proxied, customer.id)).filter(
      (l) => l.purpose === 'email_change',
    );
    expect(changeLinks).toHaveLength(THROTTLE_MAX);
    expect(changeLinks.map((l) => l.proposedEmail)).not.toContain(
      `ziel${THROTTLE_MAX + 1}@example.com`,
    );
    expect(await mailsOfKind(proxied, 'customer_portal_email_change')).toHaveLength(THROTTLE_MAX);
    // Gedrosselt ⇒ auch kein Widerruf: der 5. Link bleibt gültig.
    const open = await openLinksOf(proxied, customer.id, 'email_change');
    expect(open.map((l) => l.proposedEmail)).toEqual([`ziel${THROTTLE_MAX}@example.com`]);
  });

  it('R8. belegte Adresse verbraucht das Drosselkontingent wie eine freie (kein Seitenkanal über die Kontrollmail)', async () => {
    // Angriff aus der Nachprüfung (ohne XFF-Fälschung, Routenlimits aktiv): 4 Anforderungen an
    // eigene Adressen, dann die Probe-Adresse, dann aus einer ZWEITEN Session (eigener
    // Routen-Schlüssel ip|Session) eine Kontrollanforderung an das eigene Postfach. Käme die
    // Kontrollmail nur bei belegter Probe-Adresse an, verriete die Drossel ein fremdes Konto.
    const admin = await bootstrapAdmin(proxied);
    await createTestCustomer(proxied, admin.id, { email: 'belegt@example.com', firstName: 'Bela' });
    const observed: Record<string, unknown> = {};
    const probes = ['belegt@example.com', 'frei-probe@example.com'];
    for (const [index, probe] of probes.entries()) {
      const { customer, session } = await customerWithSession(
        proxied,
        admin.id,
        `angreifer${index}@example.com`,
        'Anna',
      );
      const second = await loginPortalCustomerSession(proxied, customer.id);
      const responses = [];
      for (let i = 0; i < THROTTLE_MAX - 1; i += 1) {
        responses.push(
          await emailChangeRequest(
            proxied,
            session.cookie,
            `fuell${index}-${i}@example.com`,
            {},
            PROXY_ADDRESS,
          ),
        );
      }
      responses.push(await emailChangeRequest(proxied, session.cookie, probe, {}, PROXY_ADDRESS));
      const mailbox = `postfach${index}@example.com`;
      responses.push(await emailChangeRequest(proxied, second.cookie, mailbox, {}, PROXY_ADDRESS));
      const changeLinks = (await linksOf(proxied, customer.id)).filter(
        (l) => l.purpose === 'email_change',
      );
      observed[probe] = {
        statuses: responses.map((r) => r.statusCode),
        bodies: [...new Set(responses.map((r) => r.body))],
        changeLinks: changeLinks.length,
        controlMails: (await mailsOfKind(proxied, 'customer_portal_email_change')).filter(
          (m) => m.recipientEmail === mailbox,
        ).length,
      };
    }
    // Beide Fälle sind über Antwort UND Drossel ununterscheidbar: Kontingent erschöpft ⇒ keine Kontrollmail.
    const expected = {
      statuses: Array(THROTTLE_MAX + 1).fill(202),
      bodies: [JSON.stringify({ message: PORTAL_MESSAGES.EMAIL_CHANGE_REQUESTED })],
      changeLinks: THROTTLE_MAX,
      controlMails: 0,
    };
    expect(observed).toEqual({
      'belegt@example.com': expected,
      'frei-probe@example.com': expected,
    });
    // Die belegte Adresse bekommt weiterhin weder Mail noch nutzbaren Link.
    const allMails = await proxied.db.select().from(mailDeliveries);
    expect(allMails.filter((m) => m.recipientEmail === 'belegt@example.com')).toHaveLength(0);
    const allLinks = await proxied.db.select().from(customerPortalMagicLinks);
    const takenRows = allLinks.filter((l) => l.proposedEmail === 'belegt@example.com');
    expect(takenRows).toHaveLength(1);
    expect(takenRows.every((l) => l.revokedAt !== null && l.consumedAt === null)).toBe(true);
  });
});

// ── R6: E-Mail-Wechsel je Kunde serialisiert ─────────────────────────────────

describe('R6 – parallele E-Mail-Wechsel und Consumes', () => {
  const ROUNDS = 5;

  it('R6. Zwei parallele E-Mail-Wechsel-Anforderungen derselben Session ⇒ in jeder Runde genau EIN offener Link', async () => {
    const admin = await bootstrapAdmin(ctx);
    const openCounts: number[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const { customer, session } = await customerWithSession(
        ctx,
        admin.id,
        `par${round}@example.com`,
      );
      const responses = await Promise.all([
        emailChangeRequest(ctx, session.cookie, `x${round}@example.com`),
        emailChangeRequest(ctx, session.cookie, `y${round}@example.com`),
      ]);
      expect(responses.map((r) => r.statusCode)).toEqual([202, 202]);
      openCounts.push((await openLinksOf(ctx, customer.id, 'email_change')).length);
    }
    expect(openCounts).toEqual(Array(ROUNDS).fill(1));
  });

  it('R6. Parallele Consumes zweier offener E-Mail-Wechsel-Links desselben Kunden ⇒ nie 500 (kein Deadlock), genau ein Gewinner', async () => {
    const admin = await bootstrapAdmin(ctx);
    const outcomes: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const { customer, session } = await customerWithSession(
        ctx,
        admin.id,
        `dl${round}@example.com`,
      );
      // Zustand „zwei offene Links“ (wie ihn die alte, unserialisierte Anforderung erzeugen konnte).
      const now = new Date();
      const entries = [0, 1].map((i) => ({
        token: generateToken(),
        proposedEmail: `dl${round}-ziel${i}@example.com`,
      }));
      await ctx.db.insert(customerPortalMagicLinks).values(
        entries.map((entry) => ({
          customerId: customer.id,
          purpose: 'email_change' as const,
          tokenHash: sha256Hex(entry.token),
          sessionId: session.sessionId,
          proposedEmail: entry.proposedEmail,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 15 * MINUTE),
        })),
      );
      const responses = await Promise.all(
        entries.map((entry) => emailChangeConsume(ctx, entry.token)),
      );
      const statuses = responses.map((r) => r.statusCode).sort();
      outcomes.push(statuses.join('/'));
      // Nur 200/401/409 erlaubt – ein Deadlock (40P01) zeigte sich als 500.
      expect(statuses.filter((s) => ![200, 401, 409].includes(s))).toEqual([]);
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      const email = (await customerRow(ctx, customer.id)).email;
      expect(entries.map((e) => e.proposedEmail)).toContain(email);
      expect(await activeSessionsOf(ctx, customer.id)).toHaveLength(0);
      expect(
        (await linksOf(ctx, customer.id)).filter(
          (l) => l.consumedAt === null && l.revokedAt === null,
        ),
      ).toHaveLength(0);
    }
    expect(outcomes).toEqual(Array(ROUNDS).fill('200/401'));
  });

  it('R6. Login-Consume parallel zum E-Mail-Wechsel-Consume ⇒ nie 500; nach dem Wechsel bleibt KEINE aktive Session übrig', async () => {
    const admin = await bootstrapAdmin(ctx);
    const results: string[] = [];
    for (let round = 0; round < ROUNDS * 2; round += 1) {
      const email = `lc${round}@example.com`;
      const { customer, session } = await customerWithSession(ctx, admin.id, email);
      const loginToken = await requestMagicLinkToken(ctx, email);
      const requested = await emailChangeRequest(ctx, session.cookie, `lc${round}-neu@example.com`);
      expect(requested.statusCode).toBe(202);
      const change = await latestPortalMailToken(ctx, 'customer_portal_email_change');
      const [loginResponse, changeResponse] = await Promise.all([
        loginConsume(ctx, loginToken),
        emailChangeConsume(ctx, change!.token),
      ]);
      results.push(`${loginResponse.statusCode}/${changeResponse.statusCode}`);
      expect([200, 401]).toContain(loginResponse.statusCode);
      expect(changeResponse.statusCode).toBe(200);
      expect((await customerRow(ctx, customer.id)).email).toBe(`lc${round}-neu@example.com`);
      // Order §35: nach dem Wechsel ist JEDE Session des Kunden widerrufen – auch eine parallel entstandene.
      expect(await activeSessionsOf(ctx, customer.id)).toHaveLength(0);
    }
    expect(results.every((r) => r === '200/200' || r === '401/200')).toBe(true);
  });

  it('R6. Login-Consume: E-Mail-Wechsel committet zwischen Link-Verbrauch und Session-Anlage ⇒ danach trotzdem keine aktive Session (deterministisch)', async () => {
    const admin = await bootstrapAdmin(ctx);
    const { customer, session } = await customerWithSession(ctx, admin.id, 'gap@example.com');
    const loginToken = await requestMagicLinkToken(ctx, 'gap@example.com');
    expect((await emailChangeRequest(ctx, session.cookie, 'gap-neu@example.com')).statusCode).toBe(
      202,
    );
    const change = await latestPortalMailToken(ctx, 'customer_portal_email_change');

    // Der Login-Consume „hängt“ nach dem Verbrauch des Links kurz vor der Session-Anlage;
    // genau dann läuft der E-Mail-Wechsel-Consume (Wartezeit höchstens 1,5 s – ist der
    // Wechsel per Kunden-Lock blockiert, geht der Login danach regulär weiter).
    const original = PortalSessionService.prototype.create;
    let changePromise: Promise<{ statusCode: number }> | null = null;
    vi.spyOn(PortalSessionService.prototype, 'create').mockImplementation(async function (
      this: PortalSessionService,
      ...args: Parameters<PortalSessionService['create']>
    ) {
      if (changePromise === null) {
        changePromise = emailChangeConsume(ctx, change!.token);
        await Promise.race([
          changePromise,
          new Promise<void>((resolve) => setTimeout(resolve, 1500)),
        ]);
      }
      return original.apply(this, args);
    });
    const loginResponse = await loginConsume(ctx, loginToken);
    const changeResponse = await changePromise!;
    vi.restoreAllMocks();

    expect(changeResponse.statusCode).toBe(200);
    expect([200, 401]).toContain(loginResponse.statusCode);
    expect((await customerRow(ctx, customer.id)).email).toBe('gap-neu@example.com');
    // Order §35: nach dem Wechsel ist JEDE Session des Kunden widerrufen.
    expect(await activeSessionsOf(ctx, customer.id)).toHaveLength(0);
    if (loginResponse.statusCode === 200) {
      const cookie = loginResponse.cookies.find((c) => c.name === portalCookieName(ctx))!;
      expect((await me(ctx, `${cookie.name}=${cookie.value}`)).statusCode).toBe(401);
    }
  });

  it('R6. E-Mail-Wechsel committet zwischen Kandidatensuche und Link-Transaktion der Login-Anforderung ⇒ kein offener Login-Link, keine Mail an die alte Adresse, kein Login', async () => {
    const admin = await bootstrapAdmin(ctx);
    const { customer, session } = await customerWithSession(ctx, admin.id, 'alt-race@example.com');
    expect((await emailChangeRequest(ctx, session.cookie, 'neu-race@example.com')).statusCode).toBe(
      202,
    );
    const change = await latestPortalMailToken(ctx, 'customer_portal_email_change');
    // Die Login-Anforderung findet den Kunden noch über die ALTE Adresse (außerhalb des
    // Kunden-Locks); genau danach – vor ihrer Link-Transaktion – committet der Wechsel.
    const racingDb = Object.create(ctx.db) as typeof ctx.db;
    let consumeStatus = 0;
    racingDb.transaction = (async (...args: Parameters<typeof ctx.db.transaction>) => {
      consumeStatus = (await emailChangeConsume(ctx, change!.token)).statusCode;
      return ctx.db.transaction(...args);
    }) as typeof ctx.db.transaction;
    const service = new PortalMagicLinkService(
      racingDb,
      ctx.communication.outbox,
      ctx.config,
      new PortalSessionService(ctx.db),
    );
    await service.requestLogin('alt-race@example.com');

    expect(consumeStatus).toBe(200);
    expect((await customerRow(ctx, customer.id)).email).toBe('neu-race@example.com');
    // Kein Login-Link (auch kein verbrauchter), keine Mail an die alte Adresse, keine Session.
    expect((await linksOf(ctx, customer.id)).filter((l) => l.purpose === 'login')).toHaveLength(0);
    expect(await mailsOfKind(ctx, 'customer_portal_magic_link')).toHaveLength(0);
    expect(await activeSessionsOf(ctx, customer.id)).toHaveLength(0);
    // Order §35: Login nur noch mit der neuen Adresse.
    expect((await requestMagicLink(ctx, 'alt-race@example.com')).token).toBeNull();
    const fresh = await loginViaMagicLink(ctx, 'neu-race@example.com');
    expect((await me(ctx, fresh.cookie)).statusCode).toBe(200);
    expect(
      (await mailsOfKind(ctx, 'customer_portal_magic_link')).map((m) => m.recipientEmail),
    ).toEqual(['neu-race@example.com']);
  });
});

// ── R7: Profil-PATCH schreibt email/type nie ─────────────────────────────────

describe('R7 – kein Lost Update zwischen Profil-PATCH und E-Mail-Wechsel', () => {
  it('R7. E-Mail-Wechsel committet zwischen Lesen und Schreiben des Profil-PATCH ⇒ neue Adresse bleibt erhalten, Typ unverändert', async () => {
    const admin = await bootstrapAdmin(ctx);
    const { customer, session } = await customerWithSession(ctx, admin.id, 'lost@example.com');
    const requested = await emailChangeRequest(ctx, session.cookie, 'gewonnen@example.com');
    expect(requested.statusCode).toBe(202);
    const link = await latestPortalMailToken(ctx, 'customer_portal_email_change');
    expect(link).not.toBeNull();

    // Zweiter Aufruf von getActiveCustomer = Lesen in updateCustomerFromPortal (der erste
    // liefert den Kundentyp für das Patch-Schema). Genau dazwischen committet der Consume.
    const original = CustomerService.prototype.getActiveCustomer;
    let calls = 0;
    let consumeStatus = 0;
    vi.spyOn(CustomerService.prototype, 'getActiveCustomer').mockImplementation(async function (
      this: CustomerService,
      customerId: string,
    ) {
      calls += 1;
      const result = await original.call(this, customerId);
      if (calls === 2) {
        consumeStatus = (await emailChangeConsume(ctx, link!.token)).statusCode;
      }
      return result;
    });
    const patched = await patchProfile(ctx, session.cookie, { firstName: 'Marie' });
    vi.restoreAllMocks();

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(consumeStatus).toBe(200);
    expect(patched.statusCode).toBe(200);
    const row = await customerRow(ctx, customer.id);
    expect(row.email).toBe('gewonnen@example.com');
    expect(row.firstName).toBe('Marie');
    expect(row.type).toBe('private');
    // Login nur noch mit der neuen Adresse.
    expect((await requestMagicLink(ctx, 'lost@example.com')).token).toBeNull();
    expect((await requestMagicLink(ctx, 'gewonnen@example.com')).token).not.toBeNull();
  });

  it('R7. updateCustomerFromPortal ändert email und type nie – auch nicht bei veraltetem Lesestand', async () => {
    const admin = await bootstrapAdmin(ctx);
    const customer = await createTestCustomer(ctx, admin.id, { email: 'alt@example.com' });
    const service = new CustomerService(ctx.db);
    const original = CustomerService.prototype.getActiveCustomer;
    vi.spyOn(CustomerService.prototype, 'getActiveCustomer').mockImplementation(async function (
      this: CustomerService,
      customerId: string,
    ) {
      const result = await original.call(this, customerId);
      // Staff ändert parallel die Adresse (anderer Schreibpfad) – nach dem Lesen.
      await ctx.db
        .update(customers)
        .set({ email: 'staff-neu@example.com' })
        .where(eq(customers.id, customerId));
      return result;
    });
    const updated = await service.updateCustomerFromPortal(customer.id, { phone: '0171 1' });
    vi.restoreAllMocks();
    expect(updated.email).toBe('staff-neu@example.com');
    expect(updated.phone).toBe('0171 1');
    expect((await customerRow(ctx, customer.id)).email).toBe('staff-neu@example.com');
  });
});

// ── R8: neutrale E-Mail-Wechsel-Anforderung ──────────────────────────────────

describe('R8 – E-Mail-Wechsel-Anforderung ist kein Existenz-Orakel', () => {
  it('R8. belegte Adresse ⇒ identische neutrale 202 wie freie Adresse, aber kein nutzbarer Link und keine Mail', async () => {
    const admin = await bootstrapAdmin(ctx);
    const { customer, session } = await customerWithSession(ctx, admin.id, 'ich@example.com');
    await createTestCustomer(ctx, admin.id, { email: 'belegt@example.com', firstName: 'Bela' });

    const startedTaken = Date.now();
    const taken = await emailChangeRequest(ctx, session.cookie, 'Belegt@Example.com');
    const takenMs = Date.now() - startedTaken;
    expect(taken.statusCode).toBe(202);
    expect(taken.json()).toEqual({ message: PORTAL_MESSAGES.EMAIL_CHANGE_REQUESTED });
    expect(takenMs).toBeGreaterThanOrEqual(MIN_DURATION_MS - 5);
    // Nachbesserung R8: nur eine sofort widerrufene Platzhalterzeile (zählt für die Drossel).
    const placeholder = await linksOf(ctx, customer.id);
    expect(placeholder).toHaveLength(1);
    expect(placeholder[0]!.revokedAt).not.toBeNull();
    expect(placeholder[0]!.consumedAt).toBeNull();
    expect(await openLinksOf(ctx, customer.id, 'email_change')).toHaveLength(0);
    expect(await mailsOfKind(ctx, 'customer_portal_email_change')).toHaveLength(0);

    const free = await emailChangeRequest(ctx, session.cookie, 'frei@example.com');
    expect(free.statusCode).toBe(202);
    expect(free.body).toBe(taken.body);
    const link = await latestPortalMailToken(ctx, 'customer_portal_email_change');
    expect(link!.recipientEmail).toBe('frei@example.com');
    expect(await openLinksOf(ctx, customer.id, 'email_change')).toHaveLength(1);

    // Eine neue Anforderung ersetzt die vorige – unabhängig davon, ob die Zieladresse frei ist
    // (keine Seitenkanal-Unterscheidung über die Gültigkeit des alten Links).
    const takenAgain = await emailChangeRequest(ctx, session.cookie, 'belegt@example.com');
    expect(takenAgain.body).toBe(taken.body);
    expect(await openLinksOf(ctx, customer.id, 'email_change')).toHaveLength(0);
    expect(await mailsOfKind(ctx, 'customer_portal_email_change')).toHaveLength(1);
    expect((await emailChangeConsume(ctx, link!.token)).statusCode).toBe(401);
    expect((await customerRow(ctx, customer.id)).email).toBe('ich@example.com');
  });

  it('R8. Ausnahmen bleiben: eigene Adresse 400 PORTAL_EMAIL_UNAVAILABLE, ungültiges Format 400, ohne frische Reauth 403', async () => {
    const admin = await bootstrapAdmin(ctx);
    const { session } = await customerWithSession(ctx, admin.id, 'selbst@example.com');
    const own = await emailChangeRequest(ctx, session.cookie, ' Selbst@example.com ');
    expect(own.statusCode).toBe(400);
    expect(own.json().error.code).toBe('PORTAL_EMAIL_UNAVAILABLE');
    const invalid = await emailChangeRequest(ctx, session.cookie, 'ohne-at');
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('VALIDATION');
    await ctx.db
      .update(customerPortalSessions)
      .set({ reauthenticatedAt: new Date(Date.now() - 16 * MINUTE) })
      .where(eq(customerPortalSessions.id, session.sessionId));
    const stale = await emailChangeRequest(ctx, session.cookie, 'frei@example.com');
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe('PORTAL_REAUTH_REQUIRED');
    expect(await mailsOfKind(ctx, 'customer_portal_email_change')).toHaveLength(0);
  });
});

// ── R9: Papierkorb beendet Portal-Sessions und offene Links endgültig ────────

describe('R9 – Papierkorb und Wiederherstellung', () => {
  it('R9. Papierkorb + Wiederherstellen ⇒ altes Cookie bleibt 401, alte Links bleiben ungültig; neuer Login funktioniert', async () => {
    const admin = await bootstrapAdmin(ctx);
    const customer = await createTestCustomer(ctx, admin.id, { email: 'trash@example.com' });
    const { cookie } = await loginViaMagicLink(ctx, 'trash@example.com');
    const openLogin = await requestMagicLinkToken(ctx, 'trash@example.com');
    const reauth = await ctx.app.inject({
      method: 'POST',
      url: '/portal/auth/reauth/request',
      headers: { cookie },
    });
    expect(reauth.statusCode).toBe(202);
    expect((await me(ctx, cookie)).statusCode).toBe(200);

    await customerServiceFor(ctx).moveToTrash(admin.id, customer.id);
    expect((await me(ctx, cookie)).statusCode).toBe(401);
    // In derselben Transaktion widerrufen: alle Sessions und alle offenen Links.
    expect(await activeSessionsOf(ctx, customer.id)).toHaveLength(0);
    expect(
      (await linksOf(ctx, customer.id)).filter(
        (l) => l.consumedAt === null && l.revokedAt === null,
      ),
    ).toHaveLength(0);

    await customerServiceFor(ctx).restoreFromTrash(customer.id);
    const afterRestore = await me(ctx, cookie);
    expect(afterRestore.statusCode).toBe(401);
    expect(afterRestore.json().error.code).toBe('PORTAL_UNAUTHENTICATED');
    expect((await loginConsume(ctx, openLogin)).statusCode).toBe(401);
    // Ein frischer Login nach der Wiederherstellung ist möglich.
    const fresh = await loginViaMagicLink(ctx, 'trash@example.com');
    expect((await me(ctx, fresh.cookie)).statusCode).toBe(200);
    expect(fresh.cookie).not.toBe(cookie);
    expect(fresh.cookie.startsWith(`${portalCookieName(ctx)}=`)).toBe(true);
  });

  it('R9. Papierkorb parallel zum E-Mail-Wechsel-Consume ⇒ kein Deadlock/500; danach keine aktive Session (Sperrreihenfolge Kunde → Zeilen)', async () => {
    const admin = await bootstrapAdmin(ctx);
    for (let round = 0; round < 4; round += 1) {
      const { customer, session } = await customerWithSession(
        ctx,
        admin.id,
        `tr${round}@example.com`,
      );
      expect(
        (await emailChangeRequest(ctx, session.cookie, `tr${round}-neu@example.com`)).statusCode,
      ).toBe(202);
      const change = await latestPortalMailToken(ctx, 'customer_portal_email_change');
      const [trash, consumed] = await Promise.allSettled([
        customerServiceFor(ctx).moveToTrash(admin.id, customer.id),
        emailChangeConsume(ctx, change!.token),
      ]);
      expect(trash.status).toBe('fulfilled');
      expect(consumed.status).toBe('fulfilled');
      const status = consumed.status === 'fulfilled' ? consumed.value.statusCode : 0;
      expect([200, 401]).toContain(status);
      expect(await activeSessionsOf(ctx, customer.id)).toHaveLength(0);
      expect((await customerRow(ctx, customer.id)).deletedAt).not.toBeNull();
    }
  });

  it('R9. Login-Anforderung, während der Kunde in den Papierkorb wandert ⇒ kein offener Link; nach Wiederherstellung kein Login über diesen Link', async () => {
    const admin = await bootstrapAdmin(ctx);
    const customer = await createTestCustomer(ctx, admin.id, { email: 'knapp@example.com' });
    // Der Papierkorb committet genau zwischen Kandidatensuche und Link-Transaktion.
    const racingDb = Object.create(ctx.db) as typeof ctx.db;
    racingDb.transaction = (async (...args: Parameters<typeof ctx.db.transaction>) => {
      await customerServiceFor(ctx).moveToTrash(admin.id, customer.id);
      return ctx.db.transaction(...args);
    }) as typeof ctx.db.transaction;
    const service = new PortalMagicLinkService(
      racingDb,
      ctx.communication.outbox,
      ctx.config,
      new PortalSessionService(ctx.db),
    );
    await service.requestLogin('knapp@example.com');
    expect((await customerRow(ctx, customer.id)).deletedAt).not.toBeNull();
    expect(await openLinksOf(ctx, customer.id, 'login')).toHaveLength(0);
    expect(await mailsOfKind(ctx, 'customer_portal_magic_link')).toHaveLength(0);
    await customerServiceFor(ctx).restoreFromTrash(customer.id);
    expect(await openLinksOf(ctx, customer.id, 'login')).toHaveLength(0);
  });
});
