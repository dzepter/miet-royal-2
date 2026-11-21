/**
 * Phase 18 – Szenario H „Demo-/Trainingsumgebung“ (Order Szenario 8; Karte D §3/§6).
 *
 * Gegentests „Demo erzeugt keine Live-Aktion“ und „Production verwendet keine Demo-Fakes“
 * mit ZWEI Apps auf ZWEI Datenbanken: Demo-App (APP_ENV=demo, zweite Datenbank
 * TEST_DATABASE_URL_SECOND, Mail-Whitelist `@example.com`) und Live-App (development,
 * TEST_DATABASE_URL). Über den gesamten Lauf liegt ein globaler Egress-Spion auf `fetch`
 * sowie `http.request`/`https.request`: kein Aufruf darf einen Host außerhalb des Loopbacks
 * erreichen – der systemweite Nachweis, dass Seed, Angebotsversand, Abrechnung, Reset und
 * Konfigurationsprüfungen keinen echten Provider (SMTP, Lexware, Meta, GraphHopper, Google)
 * kontaktieren. Die Fakes/Mocks zeichnen jeden Aufruf auf (Mail nur Whitelist + „[DEMO]“,
 * WhatsApp/Push/Routing/Buchhaltung ohne Provider-Aufruf).
 *
 * Reihenfolge: H2 Seed + Angebotsmail (blocked / whitelisted) → H3 Buchhaltung disabled →
 * H4 WhatsApp/Routing Mock + Konfigurationsfehler bei echten Schlüsseln → H5 Reset
 * (neue Epoch, Datensatz neu, Staff bleibt, Live-DB unverändert) → H6 production lehnt
 * Fakes ab / Training-Gate nur production → H7 Isolations-CLI → H1 Egress-Beleg (bewusst
 * zuletzt, nach allen Aktionen) → H8 Integritätscheck auf der Demo-Datenbank.
 *
 * Die zweite Datenbank ist Pflicht: fehlt `TEST_DATABASE_URL_SECOND`, schlägt die Suite mit
 * klarer Meldung fehl (kein Skip – Order „keine Skips für Grün“).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from '@mietroyal/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockAccountingGateway } from '../src/accounting/gateway.ts';
import { buildApp } from '../src/app.ts';
import { createCommunicationContext } from '../src/communication/context.ts';
import { FakeInboundMailSource } from '../src/communication/inbound/sources.ts';
import { FakeMailGateway } from '../src/communication/mail/gateways.ts';
import { isDemoWhitelisted } from '../src/communication/mail/whitelist.ts';
import { FakePushGateway } from '../src/communication/push/gateways.ts';
import {
  DEMO_SUBJECT_PREFIX,
  MAIL_BLOCKED_DEMO_NOT_WHITELISTED,
} from '../src/communication/types.ts';
import {
  createWhatsAppGateway,
  FakeWhatsAppGateway,
  MockWhatsAppGateway,
} from '../src/communication/whatsapp/gateways.ts';
import { DEMO_DATASET_VERSION } from '../src/demo/dataset.ts';
import { DEMO_SEED_KEYS } from '../src/demo/seed/data.ts';
import { FakeReviewGateway } from '../src/reviews/fake.ts';
import { createRoutingGateway } from '../src/routing/factory.ts';
import { FakeRoutingGateway, MockRoutingGateway } from '../src/routing/fake.ts';
import { integrityViolations, tableCounts } from './acceptance-integrity.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createTestContext,
  DEMO_TEST_AUTH_SECRET_KEY,
  DEMO_TEST_COMMUNICATION_PAYLOAD_KEY,
  destroyTestContext,
  login,
  TEST_DATABASE_URL,
  type TestContext,
} from './auth-helpers.ts';
import {
  commerceServices,
  createCommerceWorld,
  inquiryServiceFor,
  productServiceFor,
} from './commerce-helpers.ts';
import {
  createStaffWithPermissions,
  createTestCustomer,
  processServiceFor,
} from './crm-helpers.ts';
import {
  demoServicesFor,
  demoTestNow,
  freshDemoDatabase,
  wipeDemoTestDatabase,
  type DemoTestServices,
} from './demo-helpers.ts';
import { buildEnvApp, envAppConfig, withEnvApp } from './env-app-helpers.ts';
import {
  apiOn,
  definitionTitle,
  ensureTrainingDefinitions,
  expectTrainingRequired,
  FEATURE_DEFINITIONS,
  setRequirement,
} from './training-gate-helpers.ts';
import { inventoryServiceFor } from './warehouse-helpers.ts';

// ── Egress-Spion (gesamte Datei) ─────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const recordedFetchUrls: string[] = [];
const recordedRequestHosts: string[] = [];

type FetchFn = typeof globalThis.fetch;
const originalFetch: FetchFn = globalThis.fetch;
const originalHttpRequest = http.request;
const originalHttpsRequest = https.request;

function fetchUrlOf(input: Parameters<FetchFn>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestHostOf(args: unknown[]): string {
  const [first, second] = args;
  if (typeof first === 'string') return new URL(first).hostname;
  if (first instanceof URL) return first.hostname;
  const options = (typeof first === 'object' && first !== null ? first : second) as
    { hostname?: string; host?: string } | undefined;
  return options?.hostname ?? options?.host ?? '<unbekannt>';
}

function installEgressSpies(): void {
  globalThis.fetch = (async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    recordedFetchUrls.push(fetchUrlOf(input));
    return originalFetch(input, init);
  }) as FetchFn;
  http.request = ((...args: unknown[]) => {
    recordedRequestHosts.push(`http:${requestHostOf(args)}`);
    return (originalHttpRequest as (...inner: unknown[]) => http.ClientRequest)(...args);
  }) as typeof http.request;
  https.request = ((...args: unknown[]) => {
    recordedRequestHosts.push(`https:${requestHostOf(args)}`);
    return (originalHttpsRequest as (...inner: unknown[]) => http.ClientRequest)(...args);
  }) as typeof https.request;
}

function restoreEgressSpies(): void {
  globalThis.fetch = originalFetch;
  http.request = originalHttpRequest;
  https.request = originalHttpsRequest;
}

// ── Kontexte ────────────────────────────────────────────────────────────────

const SECOND_DATABASE_URL = process.env.TEST_DATABASE_URL_SECOND;
const DEMO_WHITELIST = '@example.com';
const DEMO_PUBLIC_WEB_BASE_URL = 'https://demo.miet-royal.test';
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
/** Demo-Seed/-Reset legen den vollständigen kanonischen Datensatz (inkl. PDFs) an – deutlich über dem 30-s-Default, gemessen < 60 s. */
const DEMO_DATASET_TIMEOUT_MS = 120_000;
/** Zwei Kindprozesse (pnpm --filter + tsx) für die Isolations-CLI. */
const CLI_TIMEOUT_MS = 120_000;

const LIVE_TABLES = [
  'customers',
  'processes',
  'bookings',
  'appointments',
  'machines',
  'products',
  'product_prices',
  'staff_users',
  'staff_sessions',
  'mail_deliveries',
  'documents',
  'integration_jobs',
  'demo_dataset_state',
] as const;

let demo: TestContext;
let live: TestContext;
let services: DemoTestServices;
let demoAdminId: string;
let liveAdminId: string;
let demoCookie: string;
let liveCookie: string;
/** Zähler des kanonischen Datensatzes direkt nach dem Seed (Vergleich nach dem Reset). */
let canonicalCounts: Record<string, number>;
const now = demoTestNow();

beforeAll(async () => {
  installEgressSpies();
  if (SECOND_DATABASE_URL === undefined || SECOND_DATABASE_URL === '') {
    throw new Error(
      'TEST_DATABASE_URL_SECOND fehlt: Szenario H braucht eine zweite Datenbank für die Demo-App (Demo- und Live-Datenbank müssen getrennt sein). Kein Skip – Variable setzen.',
    );
  }
  if (SECOND_DATABASE_URL === TEST_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL_SECOND muss von TEST_DATABASE_URL abweichen.');
  }
  demo = await createTestContext({
    appEnv: 'demo',
    databaseUrl: SECOND_DATABASE_URL,
    // Whitelist wie die Trainings-Suiten; Basis-URL der Kundenlinks (sonst blockiert die
    // Outbox Angebotsmails fail-closed mit PUBLIC_WEB_BASE_URL_MISSING – communication-mail 573).
    env: {
      MAIL_DEMO_WHITELIST: DEMO_WHITELIST,
      MAIL_PUBLIC_WEB_BASE_URL: DEMO_PUBLIC_WEB_BASE_URL,
    },
  });
  live = await createTestContext();
  expect(demo.config.appEnv).toBe('demo');
  expect(live.config.appEnv).toBe('development');
  expect(demo.config.databaseUrl).not.toBe(live.config.databaseUrl);
  services = demoServicesFor(demo);
  ({ adminId: demoAdminId } = await freshDemoDatabase(demo));
  await services.seed.seed({ actorId: demoAdminId, now });
  canonicalCounts = await services.seed.counts();
  demoCookie = (await login(demo.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie;
  expect(demoCookie).not.toBe('');
  // Live-Datenbank: frisch, Bootstrap-Admin und ein Vorgang ⇒ nicht-triviale Zählstände.
  await wipeDemoTestDatabase(live.pool);
  liveAdminId = (await bootstrapAdmin(live)).id;
  await createCommerceWorld(live, liveAdminId);
  liveCookie = (await login(live.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie;
  expect(liveCookie).not.toBe('');
}, DEMO_DATASET_TIMEOUT_MS);

afterAll(async () => {
  restoreEgressSpies();
  if (demo !== undefined) await destroyTestContext(demo);
  if (live !== undefined) await destroyTestContext(live);
});

async function drain(ctx: TestContext): Promise<number> {
  let processed = 0;
  for (let i = 0; i < 200; i += 1) {
    if ((await ctx.jobs.runOnce()) === 'idle') break;
    processed += 1;
  }
  return processed;
}

async function resolveSeedId(seedKey: string): Promise<string> {
  const ref = await services.registry.resolve(seedKey);
  if (ref === null) throw new Error(`Seed-Schlüssel ${seedKey} fehlt`);
  return ref.entityId;
}

async function one<T extends Record<string, unknown>>(
  ctx: TestContext,
  sql: string,
  params: unknown[],
): Promise<T> {
  const result = await ctx.pool.query<T>(sql, params);
  const first = result.rows[0];
  if (first === undefined) throw new Error(`Zeile fehlt: ${sql}`);
  return first;
}

async function count(ctx: TestContext, sql: string, params: unknown[] = []): Promise<number> {
  const result = await ctx.pool.query<{ n: string }>(sql, params);
  return Number(result.rows[0]?.n ?? 0);
}

/** Demo-Konfiguration wie der Kontext (nur Variablen; `loadConfig` verbindet nichts). */
function demoEnvLike(): Record<string, string> {
  return {
    APP_ENV: 'demo',
    DATABASE_URL: demo.config.databaseUrl,
    STORAGE_DRIVER: 'fs',
    STORAGE_FS_ROOT: demo.config.storage.driver === 'fs' ? demo.config.storage.fsRoot : '/tmp/x',
    AUTH_SECRET_KEY: DEMO_TEST_AUTH_SECRET_KEY,
    COMMUNICATION_PAYLOAD_KEY: DEMO_TEST_COMMUNICATION_PAYLOAD_KEY,
    LOG_LEVEL: 'error',
  };
}

/** Angebot im Demo-Kontext für einen Kunden mit dieser E-Mail über die ECHTE Route versenden. */
async function sendDemoOffer(email: string, label: string): Promise<{ processId: string }> {
  const products = productServiceFor(demo);
  const machine = await products.getProductBySlug('slush-2x10');
  const syrup = await products.getProductBySlug('sirup-kirsche');
  const customer = await createTestCustomer(demo, demoAdminId, {
    firstName: label,
    lastName: 'Demokundin',
    email,
    phone: '0170 0000000',
  });
  const process = await processServiceFor(demo).createProcess(demoAdminId, {
    customerId: customer.id,
  });
  await inquiryServiceFor(demo).upsertForProcess(demoAdminId, process.id, {
    eventDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
    guestCount: 40,
    occasion: 'birthday',
    machineProductId: machine.id,
    fulfillment: 'pickup',
    selections: [{ productId: syrup.id, role: 'free', quantity: 2 }],
  });
  const { versionId } = await commerceServices(demo).offers.createOffer(demoAdminId, process.id);
  const sent = await demo.app.inject({
    method: 'POST',
    url: `/staff/offer-versions/${versionId}/send`,
    headers: { cookie: demoCookie },
  });
  expect(sent.statusCode, sent.body).toBe(200);
  return { processId: process.id };
}

// ── Synthetische Isolations-Fixtures (keine echten Werte; Muster T17) ────────

const PROD_ENV = `APP_ENV=production
DATABASE_URL=postgresql://app:pw@db.internal:5432/mietroyal_prod
STORAGE_DRIVER=fs
STORAGE_FS_ROOT=/var/lib/mietroyal/prod
AUTH_SECRET_KEY=p18-prod-auth-secret-key-0123456789abcdef
COMMUNICATION_PAYLOAD_KEY=p18-prod-communication-payload-key-0123456789
MAIL_ENABLED=true
MAIL_SMTP_HOST=smtp.example.net
MAIL_SMTP_USER=mailer
MAIL_SMTP_PASSWORD=SYNTH-smtp-p18
MAIL_FROM_ADDRESS=service@example.net
MAIL_PUBLIC_WEB_BASE_URL=https://www.example.net
PUSH_VAPID_PUBLIC_KEY=p18-pub-prod
PUSH_VAPID_PRIVATE_KEY=p18-priv-prod
PUSH_VAPID_SUBJECT=mailto:service@example.net
`;
const DEMO_ENV = `APP_ENV=demo
DATABASE_URL=postgresql://app:pw@db.internal:5432/mietroyal_demo
STORAGE_DRIVER=fs
STORAGE_FS_ROOT=/var/lib/mietroyal/demo
AUTH_SECRET_KEY=p18-demo-auth-secret-key-0123456789abcdef
COMMUNICATION_PAYLOAD_KEY=p18-demo-communication-payload-key-0123456789
MAIL_ENABLED=true
MAIL_SMTP_HOST=smtp.example.net
MAIL_SMTP_USER=demo-mailer
MAIL_SMTP_PASSWORD=SYNTH-smtp-demo-p18
MAIL_FROM_ADDRESS=demo@example.net
MAIL_PUBLIC_WEB_BASE_URL=https://demo.example.net
MAIL_DEMO_WHITELIST=@demo.example.net
PUSH_VAPID_PUBLIC_KEY=p18-pub-demo
PUSH_VAPID_PRIVATE_KEY=p18-priv-demo
PUSH_VAPID_SUBJECT=mailto:demo@example.net
`;
/** Demo mit Production-Datenbank, -Storage, -Auth-Schlüssel und -VAPID-Private-Key (Environment-Leak). */
const DEMO_COLLIDING_ENV = DEMO_ENV.replace('mietroyal_demo', 'mietroyal_prod')
  .replace('STORAGE_FS_ROOT=/var/lib/mietroyal/demo', 'STORAGE_FS_ROOT=/var/lib/mietroyal/prod')
  .replace(
    'AUTH_SECRET_KEY=p18-demo-auth-secret-key-0123456789abcdef',
    'AUTH_SECRET_KEY=p18-prod-auth-secret-key-0123456789abcdef',
  )
  .replace('PUSH_VAPID_PRIVATE_KEY=p18-priv-demo', 'PUSH_VAPID_PRIVATE_KEY=p18-priv-prod');

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Phase 18 – Szenario H: Demo-/Trainingsumgebung', () => {
  it('P18-H2. Demo-Seed über den Service vorhanden; Angebotsversand aus einem Demo-Vorgang: nicht freigegebener Empfänger ⇒ Outbox „blocked“ (DEMO_NOT_WHITELISTED, kein Job, kein Versand), freigegebener Empfänger ⇒ Versand über den Fake mit Betreff „[DEMO] …“', async () => {
    // Datensatz vorhanden (Service-Seed, kanonische Zähler, Registry, Zustand).
    expect(canonicalCounts.customers).toBeGreaterThan(0);
    expect(canonicalCounts.processes).toBeGreaterThan(0);
    expect(canonicalCounts.bookings).toBeGreaterThan(0);
    const state = await services.dataset.state(now);
    expect(state.datasetVersion).toBe(DEMO_DATASET_VERSION);
    expect(state.seededAt?.toISOString()).toBe(now.toISOString());
    expect(state.resetInProgress).toBe(false);
    expect(await services.dataset.datasetEpoch()).toEqual(expect.any(String));
    expect(await services.registry.resolve(DEMO_SEED_KEYS.processCleaningPending)).not.toBeNull();
    expect(demo.config.mail.demoWhitelist).toEqual([DEMO_WHITELIST]);

    // Nicht freigegebener Empfänger: Einreihen blockiert – kein Job, kein Gateway-Versuch.
    const attemptsBefore = demo.mailGateway.attempts.length;
    const blocked = await sendDemoOffer('echte.kundin@kunde-domain.de', 'Bianca');
    const blockedRow = await one<{
      id: string;
      status: string;
      blocked_reason: string | null;
      subject: string;
      recipient_email: string;
    }>(
      demo,
      `SELECT id, status, blocked_reason, subject, recipient_email FROM mail_deliveries WHERE process_id = $1 AND kind = 'offer'`,
      [blocked.processId],
    );
    expect(blockedRow).toMatchObject({
      status: 'blocked',
      blocked_reason: MAIL_BLOCKED_DEMO_NOT_WHITELISTED,
      recipient_email: 'echte.kundin@kunde-domain.de',
    });
    expect(blockedRow.subject.startsWith(DEMO_SUBJECT_PREFIX)).toBe(true);
    expect(
      await count(
        demo,
        `SELECT count(*)::text AS n FROM integration_jobs WHERE type = 'mail.send' AND payload->>'deliveryId' = $1`,
        [blockedRow.id],
      ),
    ).toBe(0);
    // Der Angebotsversand selbst ist fachlich vollzogen (Version versendet, PDF erzeugt) – nur die Mail bleibt im Haus.
    expect(
      await count(
        demo,
        `SELECT count(*)::text AS n FROM documents WHERE process_id = $1 AND type = 'offer'`,
        [blocked.processId],
      ),
    ).toBe(1);

    // Freigegebener Empfänger: Zustellung über den Fake, Betreff mit Präfix.
    const allowed = await sendDemoOffer('dana.demo@example.com', 'Dana');
    const pendingRow = await one<{ status: string; subject: string }>(
      demo,
      `SELECT status, subject FROM mail_deliveries WHERE process_id = $1 AND kind = 'offer'`,
      [allowed.processId],
    );
    expect(pendingRow.status).toBe('pending');
    await drain(demo);
    expect(demo.mailGateway.attempts.length).toBeGreaterThan(attemptsBefore);
    const delivered = demo.mailGateway.sent.filter((m) => m.to.email === 'dana.demo@example.com');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.subject.startsWith(DEMO_SUBJECT_PREFIX)).toBe(true);
    expect(DEMO_SUBJECT_PREFIX).toBe('[DEMO] ');
    expect(
      (
        await one<{ status: string }>(
          demo,
          `SELECT status FROM mail_deliveries WHERE process_id = $1 AND kind = 'offer'`,
          [allowed.processId],
        )
      ).status,
    ).toBe('sent');
    expect(
      (
        await one<{ status: string }>(demo, `SELECT status FROM mail_deliveries WHERE id = $1`, [
          blockedRow.id,
        ])
      ).status,
    ).toBe('blocked');
    // Systemweit: JEDER Versuch des Demo-Fakes galt einem freigegebenen Empfänger mit [DEMO]-Betreff.
    for (const message of demo.mailGateway.attempts) {
      expect(
        isDemoWhitelisted(message.to.email, demo.config.mail.demoWhitelist),
        message.to.email,
      ).toBe(true);
      expect(message.subject.startsWith(DEMO_SUBJECT_PREFIX), message.subject).toBe(true);
    }
    expect(demo.mailGateway.attempts.some((m) => m.to.email.endsWith('@kunde-domain.de'))).toBe(
      false,
    );
  });

  it('P18-H3. Buchhaltung in der Demo immer disabled: Transfer ⇒ 409 ACCOUNTING_NOT_CONFIGURED (Blocker demo_unavailable, keine accounting_transfers-Zeile), Mock-Steuerung ⇒ 409, Lexware-Webhook ⇒ 404', async () => {
    expect(demo.config.lexware.enabled).toBe(false);
    expect(demo.lexware.client).toBeNull();
    expect(demo.gateway.provider).toBe('disabled');
    expect(demo.gateway.isConfigured()).toBe(false);
    const processId = await resolveSeedId(DEMO_SEED_KEYS.processCleaningPending);
    const view = await demo.app.inject({
      method: 'GET',
      url: `/staff/processes/${processId}/settlement`,
      headers: { cookie: demoCookie },
    });
    expect(view.statusCode).toBe(200);
    const settlement = view.json().settlement as {
      id: string;
      version: number;
      status: string;
      accountingBlocker: string | null;
      accountingReference: string | null;
    };
    expect(settlement.status).toBe('ready_for_accounting');
    expect(settlement.accountingBlocker).toBe('demo_unavailable');
    expect(settlement.accountingReference).toBeNull();

    const transfersBefore = await count(
      demo,
      `SELECT count(*)::text AS n FROM accounting_transfers`,
    );
    const transfer = await demo.app.inject({
      method: 'POST',
      url: `/staff/settlements/${settlement.id}/transfer`,
      headers: { cookie: demoCookie },
      payload: { version: settlement.version },
    });
    expect(transfer.statusCode).toBe(409);
    expect(transfer.json().error.code).toBe('ACCOUNTING_NOT_CONFIGURED');
    expect(await count(demo, `SELECT count(*)::text AS n FROM accounting_transfers`)).toBe(
      transfersBefore,
    );
    expect(
      await one(
        demo,
        `SELECT status, locked_at, accounting_transfer_id FROM settlements WHERE id = $1`,
        [settlement.id],
      ),
    ).toMatchObject({
      status: 'ready_for_accounting',
      locked_at: null,
      accounting_transfer_id: null,
    });
    expect(
      await count(
        demo,
        `SELECT count(*)::text AS n FROM integration_jobs WHERE type IN ('settlement.accounting_transfer','cancellation.accounting_transfer','lexware.event.process')`,
      ),
    ).toBe(0);

    const mockPayloads: Record<string, Record<string, unknown>> = {
      '/staff/accounting/mock/payment-status': {
        transferId: '00000000-0000-4000-8000-000000000001',
        status: 'paid',
      },
      '/staff/accounting/mock/fail-next': { count: 1 },
      '/staff/accounting/mock/expire-wait': { settlementId: settlement.id },
    };
    for (const [url, payload] of Object.entries(mockPayloads)) {
      const response = await demo.app.inject({
        method: 'POST',
        url,
        headers: { cookie: demoCookie },
        payload,
      });
      expect(response.statusCode, url).toBe(409);
      expect(response.json().error.code).toBe('CONFLICT');
    }
    const webhook = await demo.app.inject({
      method: 'POST',
      url: '/webhooks/lexware',
      headers: { 'content-type': 'application/json' },
      payload: { eventType: 'invoice.status.changed', resourceId: 'x' },
    });
    expect(webhook.statusCode).toBe(404);
    expect(await count(demo, `SELECT count(*)::text AS n FROM lexware_webhook_events`)).toBe(0);
    // Der (nicht injizierte) Mock des Kontexts wurde nie aufgerufen.
    expect(demo.accounting.calls).toHaveLength(0);
  });

  it('P18-H4. WhatsApp und Routing sind in der Demo Mocks (kein Provider-Aufruf), WhatsApp-Webhook ⇒ 404; echte Schlüssel (WhatsApp, GraphHopper, Lexware, Google Places) sind in demo ein Konfigurationsfehler ohne Wertnennung', async () => {
    expect(demo.config.whatsapp.mode).toBe('mock');
    expect(demo.config.routing.provider).toBe('mock');
    const whatsapp = createWhatsAppGateway(demo.config);
    expect(whatsapp).toBeInstanceOf(MockWhatsAppGateway);
    const outcome = await whatsapp.sendText({ to: '4917000000000', text: 'Demo-Nachricht' });
    expect(outcome.outcome).toBe('accepted');
    const routing = createRoutingGateway(demo.config, undefined, { db: demo.db });
    expect(routing.kind).toBe('mock');
    const geocoded = await routing.geocode({
      query: 'Lieferweg 12, 55129 Mainz',
      limit: 3,
      locale: 'de',
    });
    expect(geocoded.candidates.length).toBeGreaterThan(0);
    const webhook = await demo.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      payload: { object: 'whatsapp_business_account', entry: [] },
    });
    expect(webhook.statusCode).toBe(404);
    expect(await count(demo, `SELECT count(*)::text AS n FROM whatsapp_events`)).toBe(0);

    const base = demoEnvLike();
    // Meldung je Variante: WhatsApp fasst alle WHATSAPP_*-Variablen zusammen (load-config.ts 1029).
    const mentions: Record<string, RegExp> = {
      WHATSAPP_ACCESS_TOKEN: /WHATSAPP_\*: in demo nicht zulässig/,
      GRAPHHOPPER_API_KEY: /GRAPHHOPPER_API_KEY: in demo nicht zulässig/,
      LEXWARE_API_KEY: /LEXWARE_API_KEY: in demo nicht zulässig/,
      GOOGLE_PLACES_API_KEY: /GOOGLE_PLACES_API_KEY: in demo nicht zulässig/,
    };
    const variants: Record<string, Record<string, string>> = {
      WHATSAPP_ACCESS_TOKEN: {
        WHATSAPP_ENABLED: 'true',
        WHATSAPP_ACCESS_TOKEN: 'SYNTH-wa-token-p18-never-real',
        WHATSAPP_PHONE_NUMBER_ID: '100000000000001',
        WHATSAPP_BUSINESS_ACCOUNT_ID: '200000000000001',
        WHATSAPP_APP_SECRET: 'SYNTH-wa-app-secret-p18-0123456789',
        WHATSAPP_VERIFY_TOKEN: 'SYNTH-wa-verify-token-p18-0123456789',
      },
      GRAPHHOPPER_API_KEY: { GRAPHHOPPER_API_KEY: 'SYNTH-gh-key-p18-0123456789abcdef' },
      LEXWARE_API_KEY: {
        LEXWARE_ENABLED: 'true',
        LEXWARE_API_KEY: 'SYNTH-lexware-key-p18-0000000000000000',
      },
      GOOGLE_PLACES_API_KEY: {
        REVIEWS_PROVIDER: 'google',
        GOOGLE_PLACES_API_KEY: 'SYNTH-places-key-p18-0123456789',
        GOOGLE_PLACE_ID: 'ChIJ-synthetic-p18',
        GOOGLE_REVIEWS_TERMS_CONFIRMED: 'true',
      },
    };
    for (const [variable, extra] of Object.entries(variants)) {
      let error: unknown = null;
      try {
        loadConfig({ ...base, ...extra });
      } catch (caught) {
        error = caught;
      }
      expect(error, variable).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      expect(message, variable).toMatch(mentions[variable]!);
      for (const value of Object.values(extra)) {
        if (value.startsWith('SYNTH-')) expect(message).not.toContain(value);
      }
    }
    // Der Demo-Kontext selbst lädt (wie die App) fehlerfrei.
    expect(loadConfig(base).appEnv).toBe('demo');
  });

  it(
    'P18-H5. Demo-Reset: neue Datensatz-Epoch, Geschäftsdaten kanonisch neu angelegt (Demo-Vorgänge von H2 weg), Staff-Konten/Sessions bleiben – und die Live-Datenbank/-App bleibt vollständig unverändert („keine Live-Aktion“)',
    async () => {
      const epochBefore = await services.dataset.datasetEpoch();
      expect(epochBefore).toEqual(expect.any(String));
      const demoStaffBefore = await tableCounts(demo.pool, [
        'staff_users',
        'staff_roles',
        'staff_user_roles',
        'staff_sessions',
      ]);
      const extraProcesses = await count(
        demo,
        `SELECT count(*)::text AS n FROM customers WHERE last_name = 'Demokundin'`,
      );
      expect(extraProcesses).toBe(2);
      const countsBeforeReset = await services.seed.counts();
      expect(countsBeforeReset.customers).toBe(canonicalCounts.customers! + 2);
      const liveBefore = {
        counts: await tableCounts(live.pool, LIVE_TABLES),
        mailSent: live.mailGateway.sent.length,
        mailAttempts: live.mailGateway.attempts.length,
        pushSent: live.push.sent.length,
        whatsapp: live.whatsapp.sendCalls.length,
        accounting: live.accounting.calls.length,
      };
      expect(liveBefore.counts.customers).toBeGreaterThan(0);

      const result = await services.reset.reset({ actorId: demoAdminId, now });
      expect(result.ok).toBe(true);
      expect(result.datasetVersion).toBe(DEMO_DATASET_VERSION);
      expect(result.seeded.customers).toBe(canonicalCounts.customers);

      const epochAfter = await services.dataset.datasetEpoch();
      expect(epochAfter).toEqual(expect.any(String));
      expect(epochAfter).not.toBe(epochBefore);
      expect(await services.seed.counts()).toEqual(canonicalCounts);
      expect(
        await count(
          demo,
          `SELECT count(*)::text AS n FROM customers WHERE last_name = 'Demokundin'`,
        ),
      ).toBe(0);
      expect(
        await tableCounts(demo.pool, [
          'staff_users',
          'staff_roles',
          'staff_user_roles',
          'staff_sessions',
        ]),
      ).toEqual(demoStaffBefore);
      const state = await services.dataset.state(now);
      expect(state.resetInProgress).toBe(false);
      expect(state.lastResetBy).toBe(demoAdminId);
      // Demo-Session gilt weiter; Reset-Audit nur in der Demo-DB.
      const me = await demo.app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { cookie: demoCookie },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().environment).toBe('demo');
      expect(
        await count(
          demo,
          `SELECT count(*)::text AS n FROM staff_security_events WHERE type = 'demo.reset_completed'`,
        ),
      ).toBe(1);
      // Storage-Nachbereinigung des Resets im Test-Runner ausführen (wie der Worker) – nur Demo-Storage.
      await drain(demo);

      // Live: nichts hat sich bewegt – Zählstände, Fakes, App, Audit.
      expect(await tableCounts(live.pool, LIVE_TABLES)).toEqual(liveBefore.counts);
      expect(live.mailGateway.sent.length).toBe(liveBefore.mailSent);
      expect(live.mailGateway.attempts.length).toBe(liveBefore.mailAttempts);
      expect(live.push.sent.length).toBe(liveBefore.pushSent);
      expect(live.whatsapp.sendCalls.length).toBe(liveBefore.whatsapp);
      expect(live.accounting.calls.length).toBe(liveBefore.accounting);
      expect(
        await count(
          live,
          `SELECT count(*)::text AS n FROM staff_security_events WHERE type LIKE 'demo.%'`,
        ),
      ).toBe(0);
      const liveMe = await live.app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { cookie: liveCookie },
      });
      expect(liveMe.statusCode).toBe(200);
      expect(liveMe.json().environment).toBe('development');
      // Demo-Routen existieren in der Live-App nicht.
      const liveReset = await live.app.inject({
        method: 'POST',
        url: '/staff/demo/reset',
        headers: { cookie: liveCookie },
        payload: { confirmation: 'DEMO ZURÜCKSETZEN' },
      });
      expect(liveReset.statusCode).toBe(404);
    },
    DEMO_DATASET_TIMEOUT_MS,
  );

  it('P18-H6. Production lehnt Fakes beim Start ab (Mail, Push, WhatsApp, Routing, IMAP, Mock-Buchhaltung, Bewertungen; auch der Kommunikationskontext); demo lehnt die Mock-Buchhaltung ab; Training-Gate wird NUR in production erzwungen', async () => {
    const prodConfig = envAppConfig(live, 'production');
    const base = {
      config: prodConfig,
      pool: live.pool,
      mailAdapter: live.mail,
      storage: live.storage,
      jobQueue: live.queue,
      rateLimitEnabled: false,
    };
    expect(() => buildApp({ ...base, mailGateway: new FakeMailGateway() })).toThrow(/production/);
    expect(() => buildApp({ ...base, pushGateway: new FakePushGateway() })).toThrow(/production/);
    expect(() => buildApp({ ...base, whatsappGateway: new FakeWhatsAppGateway() })).toThrow(
      /production/,
    );
    expect(() => buildApp({ ...base, whatsappGateway: new MockWhatsAppGateway() })).toThrow(
      /production/,
    );
    expect(() => buildApp({ ...base, routingGateway: new MockRoutingGateway() })).toThrow(
      /production/,
    );
    expect(() => buildApp({ ...base, routingGateway: new FakeRoutingGateway() })).toThrow(
      /production/,
    );
    expect(() =>
      buildApp({ ...base, inboundMailSource: new FakeInboundMailSource('INBOX') }),
    ).toThrow(/production/);
    expect(() => buildApp({ ...base, accountingGateway: new MockAccountingGateway() })).toThrow(
      /Mock-Buchhaltungs-Gateway/,
    );
    expect(() =>
      createCommunicationContext(prodConfig, live.db, live.queue, {
        gateway: new FakeMailGateway(),
        storage: live.storage,
      }),
    ).toThrow(/production/);
    // Bewertungs-Fake: Laufzeitsperre beim Start (Plugin-Registrierung ⇒ ready() wirft).
    const reviewsApp = buildEnvApp(live, 'production', {
      app: { reviewGateway: new FakeReviewGateway() },
    });
    try {
      await expect(reviewsApp.ready()).rejects.toThrow(/Fake-Bewertungs-Gateway .* nicht zulässig/);
    } finally {
      await reviewsApp.close().catch(() => undefined);
    }
    // Demo: Mock-Buchhaltung ebenfalls verboten (nur Disabled).
    expect(() =>
      buildApp({ config: demo.config, accountingGateway: new MockAccountingGateway() }),
    ).toThrow(/Mock-Buchhaltungs-Gateway/);

    // Training-Gate: production erzwingt, development nicht, demo kennt keine Gate-Routen (T107/T108/T110).
    await ensureTrainingDefinitions(live.db);
    const feature = 'inventory.stocktake_approve';
    const definition = FEATURE_DEFINITIONS[feature]!;
    await setRequirement(live.db, feature, definition, true, liveAdminId);
    const approver = await createStaffWithPermissions(live, liveAdminId, {
      firstName: 'Lara',
      lastName: 'Lager',
      email: 'lara.lager@test.example',
      password: 'lara-lager-passwort-12345',
      permissionKeys: ['inventory.approve_adjustment'],
    });
    const inventory = inventoryServiceFor(live);
    const item = (await inventory.listItems())[0]!;
    const stocktake = await inventory.createStocktake(liveAdminId, [
      { itemId: item.itemId, countedStock: 7 },
    ]);
    expect(stocktake.status).toBe('pending_approval');
    const approveUrl = `/staff/inventory/stocktakes/${stocktake.id}/approve`;
    await withEnvApp(live, 'production', async (prod) => {
      const gates = await apiOn(prod, liveCookie)('GET', '/staff/training/admin/gates');
      expect(gates.status).toBe(200);
      expect(gates.body.enforced).toBe(true);
      expectTrainingRequired(
        await apiOn(prod, approver.cookie)('POST', approveUrl),
        feature,
        await definitionTitle(live.db, definition),
      );
    });
    expect(
      (
        await one<{ status: string }>(
          live,
          `SELECT status FROM inventory_stocktakes WHERE id = $1`,
          [stocktake.id],
        )
      ).status,
    ).toBe('pending_approval');
    const demoGates = await demo.app.inject({
      method: 'GET',
      url: '/staff/training/admin/gates',
      headers: { cookie: demoCookie },
    });
    expect(demoGates.statusCode).toBe(404);
    const dev = await apiOn(live.app, approver.cookie)('POST', approveUrl);
    expect(dev.status, JSON.stringify(dev.body)).toBe(200);
    expect(dev.body.stocktake.status).toBe('approved');
  });

  it(
    'P18-H7. Environment-Isolation-CLI: isolierte production/demo-Fixtures ⇒ Exit 0; kollidierende Fixtures (gleiche DB, Storage, Auth-Schlüssel, VAPID-Private-Key) ⇒ Exit 1 – Ausgabe nennt nur Variablennamen, keine Werte',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'mietroyal-p18-envcheck-'));
      const prodFile = join(dir, 'prod.env');
      const demoFile = join(dir, 'demo.env');
      const collidingFile = join(dir, 'demo-colliding.env');
      writeFileSync(prodFile, PROD_ENV);
      writeFileSync(demoFile, DEMO_ENV);
      writeFileSync(collidingFile, DEMO_COLLIDING_ENV);
      const run = (a: string, b: string) =>
        // pnpm reicht Argumente ohne `--` an das Skript durch (Muster T17).
        spawnSync('pnpm', ['--filter', '@mietroyal/config', 'check:env-isolation', a, b], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          timeout: CLI_TIMEOUT_MS,
        });
      const ok = run(prodFile, demoFile);
      expect(ok.status, ok.stdout + ok.stderr).toBe(0);
      expect(ok.stdout).toMatch(/OK: "production" .* und "demo" .* sind isoliert/);

      const failed = run(prodFile, collidingFile);
      expect(failed.status, failed.stdout + failed.stderr).toBe(1);
      expect(failed.stderr).toMatch(/nicht isoliert/);
      for (const variable of ['DATABASE_URL', 'STORAGE_FS_ROOT', 'AUTH_SECRET_KEY', 'PUSH_VAPID']) {
        expect(failed.stderr, variable).toContain(variable);
      }
      const output = ok.stdout + ok.stderr + failed.stdout + failed.stderr;
      for (const secret of [
        'p18-prod-auth-secret-key-0123456789abcdef',
        'p18-prod-communication-payload-key-0123456789',
        'p18-priv-prod',
        'SYNTH-smtp-p18',
        'mietroyal_prod',
        'db.internal',
      ]) {
        expect(output, secret).not.toContain(secret);
      }
    },
    CLI_TIMEOUT_MS,
  );

  it('P18-H1. Systemweiter Egress-Beleg (nach allen Aktionen): kein fetch-/http-/https-Aufruf an einen Host außerhalb des Loopbacks; Fakes ohne Provider-Aufruf (WhatsApp/Push/Routing/Buchhaltung), jede Demo-Mail nur an die Whitelist', async () => {
    // Der Spion ist seit Beginn der Datei aktiv (Seed, Angebote, Jobs, Reset, Konfigurationen, Startversuche).
    const foreignFetches = recordedFetchUrls.filter(
      (url) => !LOOPBACK_HOSTS.has(new URL(url).hostname),
    );
    expect(foreignFetches, 'fetch an fremde Hosts').toEqual([]);
    const foreignRequests = recordedRequestHosts.filter(
      (entry) => !LOOPBACK_HOSTS.has(entry.slice(entry.indexOf(':') + 1)),
    );
    expect(foreignRequests, 'http(s).request an fremde Hosts').toEqual([]);
    // Fakes/Mocks beider Kontexte: kein Provider-Aufruf.
    for (const ctx of [demo, live]) {
      expect(ctx.whatsapp.sendCalls, `${ctx.config.appEnv}: WhatsApp`).toHaveLength(0);
      expect(ctx.whatsapp.mediaCalls, `${ctx.config.appEnv}: WhatsApp-Medien`).toHaveLength(0);
      expect(ctx.push.sent, `${ctx.config.appEnv}: Push`).toHaveLength(0);
      expect(ctx.accounting.calls, `${ctx.config.appEnv}: Mock-Buchhaltung`).toHaveLength(0);
      expect(ctx.lexwareFake, `${ctx.config.appEnv}: Lexware-Fake`).toBeNull();
    }
    expect(live.mailGateway.attempts, 'Live-Mail').toHaveLength(0);
    expect(createRoutingGateway(demo.config, undefined, { db: demo.db }).kind).toBe('mock');
    expect(createWhatsAppGateway(demo.config).kind).toBe('mock');
    for (const message of demo.mailGateway.attempts) {
      expect(
        isDemoWhitelisted(message.to.email, demo.config.mail.demoWhitelist),
        message.to.email,
      ).toBe(true);
    }
    expect(demo.mailGateway.sent.length).toBeGreaterThan(0);
  });

  it('P18-H8. Demo-Datenbank ist nach Seed, Fachaktionen und Reset konsistent (Integritätscheck 0 Verletzungen; einzige begründete Ausnahme: der Seed-Fixture-Gutschein W1.1 ohne Buchhaltungsübertragung)', async () => {
    // Order W1/W1.1 (demo-accounting W1.1, voucher-fixture.ts): Die Demo bucht nie in Lexware;
    // die Gutschein-Situation des Wiedermieters entsteht deshalb als Seed-Fixture mit einem
    // Ursprungs-Settlement „ready_for_accounting“ (nie bezahlt/übertragen). Genau dieser eine
    // Gutschein darf die Prüfung „Gutschein nur zu bezahlter, übertragener Abrechnung“ verletzen.
    const fixtureVoucherId = await resolveSeedId(DEMO_SEED_KEYS.voucherSituation);
    const unpaid = await demo.pool.query<{ id: string }>(
      `SELECT v.id FROM vouchers v JOIN settlements s ON s.id = v.origin_settlement_id
        WHERE v.voucher_type IS NOT NULL AND (s.payment_status IS DISTINCT FROM 'paid' OR s.status <> 'transferred')`,
    );
    expect(unpaid.rows.map((row) => row.id)).toEqual([fixtureVoucherId]);
    expect(
      await integrityViolations(demo.pool, { skip: ['voucher_for_unpaid_settlement'] }),
    ).toEqual([]);
  });
});
