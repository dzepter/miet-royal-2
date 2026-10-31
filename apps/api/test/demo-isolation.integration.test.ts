import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertConfigsIsolated,
  ConfigError,
  EnvironmentIsolationError,
  loadConfig,
} from '@mietroyal/config';
import { documents, mailDeliveries, pushDeliveries } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import webpush from 'web-push';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildPushPayload } from '../src/communication/push/payload.ts';
import { PushService } from '../src/communication/push/push-service.ts';
import {
  DEMO_SUBJECT_PREFIX,
  MAIL_BLOCKED_DEMO_NOT_WHITELISTED,
} from '../src/communication/types.ts';
import {
  createWhatsAppGateway,
  MockWhatsAppGateway,
} from '../src/communication/whatsapp/gateways.ts';
import { createRoutingGateway } from '../src/routing/factory.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createTestContext,
  destroyTestContext,
  login,
  TEST_DATABASE_URL,
  type TestContext,
} from './auth-helpers.ts';
import { commerceServices, createCommerceWorld } from './commerce-helpers.ts';
import { createTestCustomer, processServiceFor } from './crm-helpers.ts';
import { wipeDemoTestDatabase } from './demo-helpers.ts';
import { withEnvApp } from './env-app-helpers.ts';

/**
 * Phase 14 (RESET, Order §101 Pflichttests 1–17, §90, §96, Design Teil 2 §2.4):
 * Demo-Isolation über ZWEI Apps auf ZWEI Datenbanken – Demo-App (APP_ENV=demo,
 * Test-DB) und Live-App (development, zweite DB `TEST_DATABASE_URL_SECOND`,
 * Default mietroyal_test7; für T5–T7 zusätzlich eine production-Konfiguration auf
 * derselben zweiten DB). Keine ID, kein Token und keine Push-Subscription
 * überschreitet die Umgebungsgrenze. Die Provider-Nummern T8–T13 ergänzen die
 * bestehenden Tests (communication-mail 14./15., communication-whatsapp 98./116.,
 * routing-config T3/T4/C4, routing-graphhopper „Fabrik“) um je eine Demo-Assertion.
 * T17 führt den Environment-Isolation-Check (Funktion + CLI) mit synthetischen
 * Fixtures aus.
 */

const SECOND_DATABASE_URL =
  process.env.TEST_DATABASE_URL_SECOND ??
  TEST_DATABASE_URL.replace(/\/[^/?]+(\?.*)?$/, '/mietroyal_test7$1');

/** Synthetische Isolation-Fixtures (keine echten Werte) – Basis isoliert, Varianten kollidierend. */
const PROD_ENV = `APP_ENV=production
DATABASE_URL=postgresql://app:pw@db.internal:5432/mietroyal_prod
STORAGE_DRIVER=fs
STORAGE_FS_ROOT=/var/lib/mietroyal/prod
AUTH_SECRET_KEY=prod-auth-secret-key-0123456789abcdef
COMMUNICATION_PAYLOAD_KEY=prod-communication-payload-key-0123456789
MAIL_ENABLED=true
MAIL_SMTP_HOST=smtp.example.net
MAIL_SMTP_USER=mailer
MAIL_SMTP_PASSWORD=SYNTH-smtp
MAIL_FROM_ADDRESS=service@example.net
MAIL_PUBLIC_WEB_BASE_URL=https://www.example.net
PUSH_VAPID_PUBLIC_KEY=pub-prod
PUSH_VAPID_PRIVATE_KEY=priv-prod
PUSH_VAPID_SUBJECT=mailto:service@example.net
`;
const DEMO_ENV = `APP_ENV=demo
DATABASE_URL=postgresql://app:pw@db.internal:5432/mietroyal_demo
STORAGE_DRIVER=fs
STORAGE_FS_ROOT=/var/lib/mietroyal/demo
AUTH_SECRET_KEY=demo-auth-secret-key-0123456789abcdef
COMMUNICATION_PAYLOAD_KEY=demo-communication-payload-key-0123456789
MAIL_ENABLED=true
MAIL_SMTP_HOST=smtp.example.net
MAIL_SMTP_USER=demo-mailer
MAIL_SMTP_PASSWORD=SYNTH-smtp-demo
MAIL_FROM_ADDRESS=demo@example.net
MAIL_PUBLIC_WEB_BASE_URL=https://demo.example.net
MAIL_DEMO_WHITELIST=@demo.example.net
PUSH_VAPID_PUBLIC_KEY=pub-demo
PUSH_VAPID_PRIVATE_KEY=priv-demo
PUSH_VAPID_SUBJECT=mailto:demo@example.net
`;
/** Demo mit Production-Kommunikationsschlüssel und Production-VAPID-Private-Key (§96). */
const DEMO_COLLIDING_ENV = DEMO_ENV.replace(
  'COMMUNICATION_PAYLOAD_KEY=demo-communication-payload-key-0123456789',
  'COMMUNICATION_PAYLOAD_KEY=prod-communication-payload-key-0123456789',
).replace('PUSH_VAPID_PRIVATE_KEY=priv-demo', 'PUSH_VAPID_PRIVATE_KEY=priv-prod');
/** Demo auf der Production-Datenbank und dem Production-Storage. */
const DEMO_SHARED_DB_ENV = DEMO_ENV.replace('mietroyal_demo', 'mietroyal_prod').replace(
  'STORAGE_FS_ROOT=/var/lib/mietroyal/demo',
  'STORAGE_FS_ROOT=/var/lib/mietroyal/prod',
);

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) out[line.slice(0, index)] = line.slice(index + 1);
  }
  return out;
}

const KEYS = { p256dh: 'BPk'.padEnd(87, 'A'), auth: 'auth-secret-16by' };
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

let demo: TestContext;
let live: TestContext;
let demoAdminId: string;
let liveAdminId: string;
let demoCookie: string;
let liveCookie: string;

beforeAll(async () => {
  demo = await createTestContext({ appEnv: 'demo' });
  live = await createTestContext({ databaseUrl: SECOND_DATABASE_URL });
  expect(live.config.databaseUrl).not.toBe(demo.config.databaseUrl);
  await wipeDemoTestDatabase(demo.pool);
  await wipeDemoTestDatabase(live.pool);
  demoAdminId = (await bootstrapAdmin(demo)).id;
  liveAdminId = (await bootstrapAdmin(live)).id;
  demoCookie = (await login(demo.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie;
  liveCookie = (await login(live.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie;
}, 180_000);

afterAll(async () => {
  await destroyTestContext(demo);
  await destroyTestContext(live);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function drain(ctx: TestContext): Promise<void> {
  while ((await ctx.jobs.runOnce()) !== 'idle') {
    // weiter
  }
}

/** Angebots-Token + Dokument-Token (finales Angebots-PDF) in einer Umgebung erzeugen. */
async function tokensIn(ctx: TestContext, adminId: string) {
  const world = await createCommerceWorld(ctx, adminId);
  const services = commerceServices(ctx);
  const { versionId } = await services.offers.createOffer(adminId, world.processId);
  const effective = await ctx.auth.effectivePermissions(adminId);
  const { token: offerToken } = await services.offers.send(adminId, versionId, effective);
  const [offerDocument] = await ctx.db
    .select()
    .from(documents)
    .where(eq(documents.offerVersionId, versionId));
  const documentLink = await ctx.transactional.documentLinks.issue({
    documentId: offerDocument!.id,
    processId: world.processId,
    customerId: world.customerId,
  });
  return { world, offerToken, documentToken: documentLink.token };
}

function productionExtraEnv(): Record<string, string> {
  const keys = webpush.generateVAPIDKeys();
  return {
    PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
    PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
    PUSH_VAPID_SUBJECT: 'mailto:it@miet-royal.example',
  };
}

describe('Phase 14 – Demo-Isolation (T1–T17)', () => {
  it('T1. Demo hat eine eigene Datenbank: Demo- und Live-App zeigen auf verschiedene DATABASE_URLs; der Isolation-Check erkennt eine geteilte Datenbank als Kollision', () => {
    expect(demo.config.appEnv).toBe('demo');
    expect(live.config.appEnv).toBe('development');
    expect(demo.config.databaseUrl).not.toBe(live.config.databaseUrl);
    expect(() => assertConfigsIsolated(demo.config, live.config)).not.toThrow();
    const prod = loadConfig(parseEnv(PROD_ENV));
    const sharedDb = loadConfig(parseEnv(DEMO_SHARED_DB_ENV));
    let error: unknown = null;
    try {
      assertConfigsIsolated(prod, sharedDb);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EnvironmentIsolationError);
    const collisions = (error as EnvironmentIsolationError).collisions;
    expect(collisions.some((c) => c.startsWith('DATABASE_URL'))).toBe(true);
    expect(collisions.some((c) => c.startsWith('STORAGE_FS_ROOT'))).toBe(true);
    // Meldungen nennen nie Werte/Secrets.
    expect(JSON.stringify(collisions)).not.toContain('mietroyal_prod');
    expect(JSON.stringify(collisions)).not.toContain('secret-key');
  });

  it('T2. Demo hat einen eigenen Storage: andere Wurzel, eine Demo-Datei ist im Live-Storage nicht vorhanden (und umgekehrt)', async () => {
    expect(demo.config.storage.driver).toBe('fs');
    expect(live.config.storage.driver).toBe('fs');
    expect(demo.config.storage.driver === 'fs' && demo.config.storage.fsRoot).not.toBe(
      live.config.storage.driver === 'fs' && live.config.storage.fsRoot,
    );
    const key = `documents/isolation/${randomUUID()}.bin`;
    await demo.storage.put(key, new Uint8Array([1, 2, 3]));
    expect(await demo.storage.exists(key)).toBe(true);
    expect(await live.storage.exists(key)).toBe(false);
    const liveKey = `documents/isolation/${randomUUID()}.bin`;
    await live.storage.put(liveKey, new Uint8Array([4]));
    expect(await demo.storage.exists(liveKey)).toBe(false);
    const prod = loadConfig(parseEnv(PROD_ENV));
    const demoCfg = loadConfig(parseEnv(DEMO_ENV));
    expect(prod.storage.driver === 'fs' && prod.storage.fsRoot).not.toBe(
      demoCfg.storage.driver === 'fs' && demoCfg.storage.fsRoot,
    );
  });

  it('T3./T4. Demo kann eine Live-ID nicht lesen und Live keine Demo-ID: Kunde und Vorgang der jeweils anderen Datenbank ⇒ neutrales 404', async () => {
    const liveCustomer = await createTestCustomer(live, liveAdminId, { email: 'live@example.com' });
    const liveProcess = await processServiceFor(live).createProcess(liveAdminId, {
      customerId: liveCustomer.id,
    });
    const demoCustomer = await createTestCustomer(demo, demoAdminId, { email: 'demo@example.com' });
    const demoProcess = await processServiceFor(demo).createProcess(demoAdminId, {
      customerId: demoCustomer.id,
    });
    const read = (ctx: TestContext, cookie: string, url: string) =>
      ctx.app.inject({ method: 'GET', url, headers: { cookie } });
    // Eigene Umgebung: lesbar.
    expect((await read(live, liveCookie, `/staff/customers/${liveCustomer.id}`)).statusCode).toBe(
      200,
    );
    expect((await read(demo, demoCookie, `/staff/customers/${demoCustomer.id}`)).statusCode).toBe(
      200,
    );
    // Fremde IDs: 404 in beide Richtungen (Kunde und Vorgang).
    expect((await read(demo, demoCookie, `/staff/customers/${liveCustomer.id}`)).statusCode).toBe(
      404,
    );
    expect((await read(demo, demoCookie, `/staff/processes/${liveProcess.id}`)).statusCode).toBe(
      404,
    );
    expect((await read(live, liveCookie, `/staff/customers/${demoCustomer.id}`)).statusCode).toBe(
      404,
    );
    expect((await read(live, liveCookie, `/staff/processes/${demoProcess.id}`)).statusCode).toBe(
      404,
    );
    // Auch das Session-Cookie der einen Umgebung gilt in der anderen nicht (eigene Datenbank, eigener Schlüssel).
    expect((await read(live, demoCookie, `/staff/customers/${liveCustomer.id}`)).statusCode).toBe(
      401,
    );
    expect((await read(demo, liveCookie, `/staff/customers/${demoCustomer.id}`)).statusCode).toBe(
      401,
    );
  });

  it('T5./T6./T7. Demo-Angebots- und Dokument-Token sind in Live (development UND production) ungültig (404), Live-Token in Demo ebenso; in der eigenen Umgebung gültig', async () => {
    const fromDemo = await tokensIn(demo, demoAdminId);
    const fromLive = await tokensIn(live, liveAdminId);
    const offer = (ctx: TestContext, token: string) =>
      ctx.app.inject({ method: 'GET', url: `/public/offers/${token}` });
    const document = (ctx: TestContext, token: string) =>
      ctx.app.inject({ method: 'GET', url: `/public/documents/${token}` });
    expect((await offer(demo, fromDemo.offerToken)).statusCode).toBe(200);
    expect((await document(demo, fromDemo.documentToken)).statusCode).toBe(200);
    expect((await offer(live, fromLive.offerToken)).statusCode).toBe(200);
    expect((await document(live, fromLive.documentToken)).statusCode).toBe(200);
    // T5/T7: Demo-Token in Live (development).
    expect((await offer(live, fromDemo.offerToken)).statusCode).toBe(404);
    expect((await document(live, fromDemo.documentToken)).statusCode).toBe(404);
    expect(
      (await live.app.inject({ method: 'GET', url: `/public/offers/${fromDemo.offerToken}/pdf` }))
        .statusCode,
    ).toBe(404);
    // T6: Live-Token in Demo.
    expect((await offer(demo, fromLive.offerToken)).statusCode).toBe(404);
    expect((await document(demo, fromLive.documentToken)).statusCode).toBe(404);
    // T5/T7 mit production-Konfiguration auf der Live-Datenbank.
    await withEnvApp(
      live,
      'production',
      async (prodApp) => {
        expect(
          (await prodApp.inject({ method: 'GET', url: `/public/offers/${fromDemo.offerToken}` }))
            .statusCode,
        ).toBe(404);
        expect(
          (
            await prodApp.inject({
              method: 'GET',
              url: `/public/documents/${fromDemo.documentToken}`,
            })
          ).statusCode,
        ).toBe(404);
        // Live-Token (gleiche DB) bleibt in production gültig – die Trennung hängt an der Datenbank, nicht am Token-Format.
        expect(
          (await prodApp.inject({ method: 'GET', url: `/public/offers/${fromLive.offerToken}` }))
            .statusCode,
        ).toBe(200);
      },
      { extraEnv: productionExtraEnv() },
    );
  }, 120_000);

  it('T8./T9. Demo-Mail nur an die Whitelist, Betreff immer [DEMO] (Ergänzung zu communication-mail 14./15.): nicht freigegebener Empfänger ⇒ blocked DEMO_NOT_WHITELISTED, kein Job, kein Gateway-Aufruf; Outbox-Betreff trägt den Präfix', async () => {
    const customer = await createTestCustomer(demo, demoAdminId, { email: 'kundin@example.com' });
    const process = await processServiceFor(demo).createProcess(demoAdminId, {
      customerId: customer.id,
    });
    const attemptsBefore = demo.mailGateway.attempts.length;
    const result = await demo.communication.outbox.enqueue({
      kind: 'offer',
      processId: process.id,
      customerId: customer.id,
      recipient: { email: 'echter.kunde@kunde-domain.de', name: 'Echter Kunde' },
      context: {
        salutation: 'Hallo,',
        processNumber: 'MR-2026-0001',
        eventDate: '2026-11-20',
        validUntil: '2026-11-01T10:00:00Z',
      },
      secrets: { offerToken: 'offer-token-SECRET-abcdefghijklmnop1234' },
      idempotencyKey: `isolation:offer:${randomUUID()}`,
    });
    expect(result.status).toBe('blocked');
    const [row] = await demo.db
      .select()
      .from(mailDeliveries)
      .where(eq(mailDeliveries.id, result.deliveryId));
    expect(row).toMatchObject({
      status: 'blocked',
      blockedReason: MAIL_BLOCKED_DEMO_NOT_WHITELISTED,
    });
    expect(row!.subject?.startsWith(DEMO_SUBJECT_PREFIX)).toBe(true);
    expect(DEMO_SUBJECT_PREFIX).toBe('[DEMO] ');
    await drain(demo);
    expect(demo.mailGateway.attempts.length).toBe(attemptsBefore);
    expect(demo.mailGateway.sent).toHaveLength(0);
    expect(demo.config.mail.demoWhitelist).toEqual([]);
    expect(live.config.mail.demoWhitelist).toEqual([]);
  });

  it('T10./T11. Demo-WhatsApp ist der Mock und ruft Meta nie auf (Ergänzung zu communication-whatsapp 98./116.): Fabrik liefert MockWhatsAppGateway, sendText ohne fetch; echte Zugangsdaten sind in demo ein Konfigurationsfehler; Webhook 404', async () => {
    expect(demo.config.whatsapp.mode).toBe('mock');
    const gateway = createWhatsAppGateway(demo.config);
    expect(gateway).toBeInstanceOf(MockWhatsAppGateway);
    expect(gateway.kind).toBe('mock');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const outcome = await gateway.sendText({ to: '4917000000000', text: 'Demo-Nachricht' });
    expect(outcome.outcome).toBe('accepted');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(() =>
      loadConfig({
        ...parseEnv(DEMO_ENV),
        WHATSAPP_ENABLED: 'true',
        WHATSAPP_ACCESS_TOKEN: 'SYNTH-token',
        WHATSAPP_PHONE_NUMBER_ID: '100000000000001',
        WHATSAPP_BUSINESS_ACCOUNT_ID: '200000000000001',
        WHATSAPP_APP_SECRET: 'SYNTH-app-secret-0123456789',
        WHATSAPP_VERIFY_TOKEN: 'SYNTH-verify-token-0123456789',
      }),
    ).toThrow(ConfigError);
    const webhook = await demo.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      payload: { object: 'whatsapp_business_account', entry: [] },
    });
    expect(webhook.statusCode).toBe(404);
  });

  it('T12./T13. Demo-Routing ist der Mock und ruft GraphHopper nie auf (Ergänzung zu routing-config T3/T4/C4 und routing-graphhopper „Fabrik“): Provider mock, Geokodierung ohne fetch; ein GraphHopper-Key ist in demo ein Konfigurationsfehler', async () => {
    expect(demo.config.routing.provider).toBe('mock');
    const gateway = createRoutingGateway(demo.config, undefined, { db: demo.db });
    expect(gateway.kind).toBe('mock');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await gateway.geocode({
      query: 'Lieferweg 12, 55129 Mainz',
      limit: 3,
      locale: 'de',
    });
    expect(result).toBeDefined();
    const route = await gateway.route({
      points: [
        { latitude: 49.9545, longitude: 8.2735 },
        { latitude: 49.9742, longitude: 8.2566 },
      ],
    });
    expect(route).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(() =>
      loadConfig({
        ...parseEnv(DEMO_ENV),
        ROUTING_PROVIDER: 'graphhopper',
        GRAPHHOPPER_API_KEY: 'gh-other-key-0123456789abcdef',
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...parseEnv(DEMO_ENV), GRAPHHOPPER_API_KEY: 'gh-key-0123456789abcdef' }),
    ).toThrow(ConfigError);
  });

  it('T16. Demo-Push erreicht nur Subscriptions der Demo-Datenbank: ein Push in demo geht an das Demo-Gerät, die Live-Subscription (andere DB) bleibt unberührt und das Live-Gateway wird nie aufgerufen', async () => {
    // Bekannter Push-Dienst (Endpoint-Policy gilt in demo wie in production).
    const demoEndpoint = `https://fcm.googleapis.com/fcm/send/demo-${'d'.repeat(40)}`;
    const liveEndpoint = `https://fcm.googleapis.com/fcm/send/live-${'l'.repeat(40)}`;
    const subscribe = (ctx: TestContext, cookie: string, endpoint: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/staff/push/subscriptions',
        headers: { cookie },
        payload: { endpoint, keys: KEYS, userAgentLabel: 'Testgerät' },
      });
    expect((await subscribe(demo, demoCookie, demoEndpoint)).statusCode).toBe(200);
    expect((await subscribe(live, liveCookie, liveEndpoint)).statusCode).toBe(200);
    demo.push.reset();
    live.push.reset();
    const push = new PushService(demo.db, demo.queue);
    await push.enqueue({
      kind: 'session_new_device_login',
      userId: demoAdminId,
      idempotencyKey: `isolation:push:${randomUUID()}`,
      payload: buildPushPayload({ kind: 'session_new_device_login' }),
    });
    await drain(demo);
    expect(demo.push.sent.map((record) => record.endpoint)).toEqual([demoEndpoint]);
    expect(live.push.sent).toHaveLength(0);
    expect(await live.db.select().from(pushDeliveries)).toHaveLength(0);
    // Dieselbe Benutzer-ID existiert in der Live-DB nicht als Demo-Konto – die Zielermittlung liest nur die eigene DB.
    expect(demoAdminId).not.toBe(liveAdminId);
    await drain(live);
    expect(live.push.sent).toHaveLength(0);
  });

  it('T17. Environment-Isolation bleibt grün: assertConfigsIsolated (production/demo) und `pnpm check:env-isolation` akzeptieren isolierte Fixtures und lehnen kollidierende Schlüssel (Kommunikationsschlüssel, VAPID) ab – ohne Werte zu nennen', () => {
    const prod = loadConfig(parseEnv(PROD_ENV));
    expect(() => assertConfigsIsolated(prod, loadConfig(parseEnv(DEMO_ENV)))).not.toThrow();
    let error: unknown = null;
    try {
      assertConfigsIsolated(prod, loadConfig(parseEnv(DEMO_COLLIDING_ENV)));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EnvironmentIsolationError);
    const message = (error as Error).message;
    expect(message).toMatch(/COMMUNICATION_PAYLOAD_KEY/);
    expect(message).toMatch(/PUSH_VAPID/);
    expect(message).not.toContain('prod-communication-payload-key');
    expect(message).not.toContain('priv-prod');

    const dir = mkdtempSync(join(tmpdir(), 'mietroyal-envcheck-'));
    const prodFile = join(dir, 'prod.env');
    const demoFile = join(dir, 'demo.env');
    const collidingFile = join(dir, 'demo-colliding.env');
    writeFileSync(prodFile, PROD_ENV);
    writeFileSync(demoFile, DEMO_ENV);
    writeFileSync(collidingFile, DEMO_COLLIDING_ENV);
    const run = (a: string, b: string) =>
      // pnpm reicht Argumente ohne `--` an das Skript durch (ein `--` käme beim Skript als Argument an).
      spawnSync('pnpm', ['--filter', '@mietroyal/config', 'check:env-isolation', a, b], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 120_000,
      });
    const ok = run(prodFile, demoFile);
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/OK: "production" .* und "demo" .* sind isoliert/);
    const failed = run(prodFile, collidingFile);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/nicht isoliert/);
    expect(failed.stderr).not.toContain('prod-communication-payload-key');
  }, 180_000);
});
