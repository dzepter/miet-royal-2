import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { demoDatasetState, staffSecurityEvents } from '@mietroyal/database';
import { JobRunner } from '@mietroyal/integrations';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_DATASET_VERSION, DemoDatasetService } from '../src/demo/dataset.ts';
import { DemoSeedRegistry } from '../src/demo/registry.ts';
import { DemoError, DEMO_MESSAGES, type DemoResetRunner } from '../src/demo/types.ts';
import { createDemoJobGuard, createDemoResetGate } from '../src/jobs/demo.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createEmployeeWithPassword,
  createTestContext,
  DEMO_TEST_AUTH_SECRET_KEY,
  DEMO_TEST_COMMUNICATION_PAYLOAD_KEY,
  destroyTestContext,
  login,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import {
  createStaffWithPermissions,
  createTestCustomer,
  truncateCrmTables,
} from './crm-helpers.ts';

/**
 * Phase 14 (Plattform, Design §§2–7): Live↔Demo-Gegen-URL in /auth/me,
 * Demo-Routen nur in APP_ENV=demo, Recht demo.manage, Reset-Bestätigung,
 * 503-Gate während eines Resets (API) und Zurücklegen von Business-Jobs
 * (Worker-Guard), Status-Form/outdated-Berechnung, keine Secrets in Logs.
 * Pflichttest-Nummern des Auftrags fehlen noch (Text endet bei §20) – Namen
 * laufen als „D-P<n>“. Läuft gegen eine eigene Test-DB (TEST_DATABASE_URL).
 */

const LIVE_URL = 'https://app.miet-royal.example';
const DEMO_URL = 'http://localhost:3012'; // development erlaubt http

class FakeResetRunner implements DemoResetRunner {
  calls: Array<{ actorId: string | null; now?: Date }> = [];
  nextError: Error | null = null;

  async reset(input: { actorId: string | null; now?: Date }) {
    this.calls.push(input);
    if (this.nextError !== null) {
      const error = this.nextError;
      this.nextError = null;
      throw error;
    }
    return {
      ok: true as const,
      datasetVersion: DEMO_DATASET_VERSION,
      seededAt: input.now ?? new Date(),
      durationMs: 12,
      deleted: { customers: 3, processes: 5 },
      seeded: { customers: 2, processes: 4 },
    };
  }
}

const logChunks: string[] = [];
const logDestination = new Writable({
  write(chunk, _encoding, callback) {
    logChunks.push(String(chunk));
    callback();
  },
});

let dev: TestContext;
let demo: TestContext;
const resetRunner = new FakeResetRunner();

beforeAll(async () => {
  dev = await createTestContext({ env: { STAFF_DEMO_URL: DEMO_URL } });
  demo = await createTestContext({
    appEnv: 'demo',
    env: { STAFF_LIVE_URL: LIVE_URL },
    demoReset: resetRunner,
    logDestination,
    logLevel: 'trace',
  });
});
afterAll(async () => {
  await destroyTestContext(demo);
  await destroyTestContext(dev);
});
beforeEach(async () => {
  await demo.pool.query(
    'TRUNCATE demo_seed_entities, demo_dataset_state, integration_jobs CASCADE',
  );
  await truncateCrmTables(demo.pool);
  await truncateAuthTables(demo.pool);
  resetRunner.calls = [];
  resetRunner.nextError = null;
});

async function adminCookie(ctx: TestContext): Promise<{ cookie: string; adminId: string }> {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  expect(session.statusCode).toBe(200);
  return { cookie: session.cookie, adminId: admin.id };
}

/** Reset-Flag direkt setzen/löschen (wie Phase A/D des Reset-Services). */
async function setResetInProgress(ctx: TestContext, actorId: string | null, startedAt: Date) {
  const dataset = new DemoDatasetService(ctx.db);
  await ctx.db.transaction(async (tx) => {
    await dataset.lockRow(tx);
    await dataset.beginReset(tx, { actorId, now: startedAt });
  });
}

async function clearResetInProgress(ctx: TestContext) {
  await ctx.db
    .update(demoDatasetState)
    .set({ resetInProgress: false, resetStartedAt: null })
    .where(eq(demoDatasetState.id, 1));
}

describe('Phase 14 – Plattform (Demo-Umgebung)', () => {
  it('D-P1. /auth/me liefert die feste Gegen-URL (nur Origin): demo ⇒ live, development ⇒ demo, ohne Konfiguration null; nie Secrets', async () => {
    const { cookie } = await adminCookie(demo);
    const me = await demo.app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      environment: 'demo',
      counterpart: { kind: 'live', url: LIVE_URL },
    });
    const text = me.body;
    expect(text).not.toContain(DEMO_TEST_AUTH_SECRET_KEY);
    expect(text).not.toContain(DEMO_TEST_COMMUNICATION_PAYLOAD_KEY);
    expect(text).not.toContain(ADMIN_PASSWORD);

    const devSession = await login(dev.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const devMe = await dev.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: devSession.cookie },
    });
    expect(devMe.json()).toMatchObject({
      environment: 'development',
      counterpart: { kind: 'demo', url: DEMO_URL },
    });

    const plain = await createTestContext();
    try {
      const plainSession = await login(plain.app, ADMIN_EMAIL, ADMIN_PASSWORD);
      const plainMe = await plain.app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { cookie: plainSession.cookie },
      });
      expect(plainMe.json().counterpart).toBeNull();
    } finally {
      await destroyTestContext(plain);
    }
  });

  it('D-P2. Demo-Routen existieren außerhalb von demo nicht (404, auch für Systemadmins)', async () => {
    const session = await login(dev.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const headers = { cookie: session.cookie };
    for (const [method, url, payload] of [
      ['GET', '/staff/demo/status', undefined],
      ['GET', '/staff/demo/seed-entities', undefined],
      ['POST', '/staff/demo/reset', { confirmation: DEMO_MESSAGES.RESET_CONFIRMATION }],
    ] as const) {
      const response = await dev.app.inject({
        method,
        url,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    }
    expect(resetRunner.calls).toEqual([]);
  });

  it('D-P3. in demo verlangen Status/Registry/Reset das Recht demo.manage: Systemadmin ok, Rolle mit Recht ok, ohne Recht 403, ohne Anmeldung 401', async () => {
    const { cookie, adminId } = await adminCookie(demo);
    const status = await demo.app.inject({
      method: 'GET',
      url: '/staff/demo/status',
      headers: { cookie },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().environment).toBe('demo');

    const manager = await createStaffWithPermissions(demo, adminId, {
      firstName: 'Mira',
      lastName: 'Manager',
      email: 'mira.manager@example.com',
      password: 'demo-manager-passwort-1',
      permissionKeys: ['demo.manage'],
    });
    const managerStatus = await demo.app.inject({
      method: 'GET',
      url: '/staff/demo/status',
      headers: { cookie: manager.cookie },
    });
    expect(managerStatus.statusCode).toBe(200);

    const plain = await createEmployeeWithPassword(demo, adminId, {
      firstName: 'Paul',
      lastName: 'Planer',
      email: 'paul.planer@example.com',
      password: 'demo-planer-passwort-1',
    });
    expect(plain.id).toBeDefined();
    const plainSession = await login(demo.app, 'paul.planer@example.com', 'demo-planer-passwort-1');
    for (const [method, url, payload] of [
      ['GET', '/staff/demo/status', undefined],
      ['GET', '/staff/demo/seed-entities', undefined],
      ['POST', '/staff/demo/reset', { confirmation: DEMO_MESSAGES.RESET_CONFIRMATION }],
    ] as const) {
      const forbidden = await demo.app.inject({
        method,
        url,
        headers: { cookie: plainSession.cookie },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(forbidden.statusCode, `${method} ${url}`).toBe(403);
      expect(forbidden.json().error.code).toBe('FORBIDDEN');
    }
    expect(resetRunner.calls).toEqual([]);

    const anonymous = await demo.app.inject({ method: 'GET', url: '/staff/demo/status' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('D-P4. Reset: Bestätigung „DEMO ZURÜCKSETZEN“ ist Pflicht (400), Erfolg 200 mit Ergebnis + Security-Event, DemoError ⇒ Status + details.demoCode', async () => {
    const { cookie, adminId } = await adminCookie(demo);
    const wrong = await demo.app.inject({
      method: 'POST',
      url: '/staff/demo/reset',
      headers: { cookie },
      payload: { confirmation: 'demo zurücksetzen' },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('VALIDATION');
    const missing = await demo.app.inject({
      method: 'POST',
      url: '/staff/demo/reset',
      headers: { cookie },
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    expect(resetRunner.calls).toEqual([]);
    const resetEvents = () =>
      demo.db
        .select()
        .from(staffSecurityEvents)
        .where(eq(staffSecurityEvents.type, 'demo.reset_requested'));
    expect(await resetEvents()).toEqual([]);

    const ok = await demo.app.inject({
      method: 'POST',
      url: '/staff/demo/reset',
      headers: { cookie },
      payload: { confirmation: DEMO_MESSAGES.RESET_CONFIRMATION },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      ok: true,
      datasetVersion: DEMO_DATASET_VERSION,
      durationMs: 12,
      deleted: { customers: 3, processes: 5 },
      seeded: { customers: 2, processes: 4 },
    });
    expect(ok.json().seededAt).toEqual(expect.any(String));
    expect(resetRunner.calls).toHaveLength(1);
    expect(resetRunner.calls[0]!.actorId).toBe(adminId);
    expect(resetRunner.calls[0]!.now).toBeInstanceOf(Date);
    const events = await resetEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.actorUserId).toBe(adminId);
    expect(events[0]!.details).toEqual({ environment: 'demo' });

    resetRunner.nextError = new DemoError(
      'CONFLICT',
      'DEMO_RESET_RUNNING',
      DEMO_MESSAGES.DEMO_RESET_RUNNING,
    );
    const running = await demo.app.inject({
      method: 'POST',
      url: '/staff/demo/reset',
      headers: { cookie },
      payload: { confirmation: DEMO_MESSAGES.RESET_CONFIRMATION },
    });
    expect(running.statusCode).toBe(409);
    expect(running.json().error).toMatchObject({
      code: 'CONFLICT',
      message: DEMO_MESSAGES.DEMO_RESET_RUNNING,
      details: { demoCode: 'DEMO_RESET_RUNNING' },
    });
  });

  it('D-P5. 503-Gate: während reset_in_progress werden Business-Mutationen abgewiesen (retry-after 15), nicht aber /auth/*, /staff/demo/*, Push, Offline-Lease und Lesezugriffe; danach wieder frei', async () => {
    const { cookie, adminId } = await adminCookie(demo);
    const customerPayload = { type: 'private', firstName: 'Demo', lastName: 'Kundin' };
    await setResetInProgress(demo, adminId, new Date());

    const blocked = await demo.app.inject({
      method: 'POST',
      url: '/staff/customers',
      headers: { cookie },
      payload: customerPayload,
    });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.headers['retry-after']).toBe('15');
    expect(blocked.json().error).toMatchObject({
      code: 'DEMO_RESET',
      message: DEMO_MESSAGES.DEMO_RESET,
    });
    for (const [method, url] of [
      ['DELETE', '/staff/customers/00000000-0000-4000-8000-000000000001'],
      ['POST', '/staff/offline/sync'],
      ['POST', '/public/offers/irgendein-token/accept'],
      ['POST', '/webhooks/whatsapp'],
    ] as const) {
      const response = await demo.app.inject({ method, url, headers: { cookie }, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(503);
    }

    // Ausnahmen antworten fachlich (nie 503).
    const loginFailed = await demo.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: ADMIN_EMAIL, password: 'falsch' },
    });
    expect(loginFailed.statusCode).toBe(401);
    const resetValidation = await demo.app.inject({
      method: 'POST',
      url: '/staff/demo/reset',
      headers: { cookie },
      payload: { confirmation: 'nein' },
    });
    expect(resetValidation.statusCode).toBe(400);
    const pushStatus = await demo.app.inject({
      method: 'POST',
      url: '/staff/push/subscriptions/status',
      headers: { cookie },
      payload: {},
    });
    expect(pushStatus.statusCode).not.toBe(503);
    const lease = await demo.app.inject({
      method: 'POST',
      url: '/staff/offline/lease',
      headers: { cookie },
      payload: {},
    });
    expect(lease.statusCode).not.toBe(503);
    const list = await demo.app.inject({
      method: 'GET',
      url: '/staff/customers',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const status = await demo.app.inject({
      method: 'GET',
      url: '/staff/demo/status',
      headers: { cookie },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ resetInProgress: true, resetStale: false });

    await clearResetInProgress(demo);
    await sleep(1100); // In-Process-Cache (TTL 1 s) läuft ab
    const created = await demo.app.inject({
      method: 'POST',
      url: '/staff/customers',
      headers: { cookie },
      payload: customerPayload,
    });
    expect(created.statusCode).toBe(200);
  });

  it('RF1. 503-Gate prüft die geroutete URL: Percent-codierte Pfade (/%73taff/customers, /staff/%63ustomers, /%70ublic/…) werden während eines Resets abgewiesen, codierte Ausnahmen bleiben frei (Review F1)', async () => {
    const { cookie, adminId } = await adminCookie(demo);
    const customerPayload = { type: 'private', firstName: 'Demo', lastName: 'Kundin' };
    await setResetInProgress(demo, adminId, new Date());
    await sleep(1100); // In-Process-Cache (TTL 1 s) des Gates läuft sicher ab

    for (const url of [
      '/%73taff/customers',
      '/staff/%63ustomers',
      '/%70ublic/offers/irgendein-token/accept',
      '/%77ebhooks/whatsapp',
    ]) {
      const response = await demo.app.inject({
        method: 'POST',
        url,
        headers: { cookie },
        payload: customerPayload,
      });
      expect(response.statusCode, url).toBe(503);
      expect(response.json().error).toMatchObject({
        code: 'DEMO_RESET',
        message: DEMO_MESSAGES.DEMO_RESET,
      });
      expect(response.headers['retry-after']).toBe('15');
    }
    // Ausnahme (Push-Geräte) bleibt auch Percent-codiert fachlich erreichbar (nie 503).
    const push = await demo.app.inject({
      method: 'POST',
      url: '/%73taff/push/subscriptions/status',
      headers: { cookie },
      payload: {},
    });
    expect(push.statusCode).not.toBe(503);

    await clearResetInProgress(demo);
    await sleep(1100);
    const created = await demo.app.inject({
      method: 'POST',
      url: '/%73taff/customers',
      headers: { cookie },
      payload: customerPayload,
    });
    expect(created.statusCode).toBe(200);
  });

  it('D-P6. Worker-Guard: Business-Jobs werden während eines Resets um 15 s zurückgelegt (ohne Versuchsverbrauch), system.heartbeat läuft; danach normale Verarbeitung', async () => {
    const dataset = new DemoDatasetService(demo.db);
    const gate = createDemoResetGate({ dataset, cacheTtlMs: 0 });
    const runner = new JobRunner(demo.queue, 'demo-test-worker');
    const handled: string[] = [];
    runner.register('demo.test.business', async (job) => {
      handled.push(job.id);
    });
    runner.register('system.heartbeat', async (job) => {
      handled.push(job.id);
    });
    runner.setBeforeRun(createDemoJobGuard(gate));

    const business = await demo.queue.enqueue(
      'demo.test.business',
      {},
      { idempotencyKey: 'd-p6:b' },
    );
    const heartbeat = await demo.queue.enqueue(
      'system.heartbeat',
      {},
      { idempotencyKey: 'd-p6:h' },
    );
    await setResetInProgress(demo, null, new Date());
    const before = Date.now();
    const outcomes = [await runner.runOnce(), await runner.runOnce(), await runner.runOnce()];
    expect(outcomes.sort()).toEqual(['deferred', 'idle', 'processed']);
    expect(handled).toEqual([heartbeat.jobId]);
    const row = await demo.pool.query<{ status: string; attempts: number; run_at: Date }>(
      'SELECT status, attempts, run_at FROM integration_jobs WHERE id = $1',
      [business.jobId],
    );
    expect(row.rows[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(row.rows[0]!.run_at.getTime()).toBeGreaterThanOrEqual(before + 14_000);

    await clearResetInProgress(demo);
    await demo.pool.query('UPDATE integration_jobs SET run_at = now() WHERE id = $1', [
      business.jobId,
    ]);
    expect(await runner.runOnce()).toBe('processed');
    expect(handled).toEqual([heartbeat.jobId, business.jobId]);
  });

  it('D-P7. Status-Form und outdated-Berechnung: leer ⇒ nicht veraltet; Daten ohne Seed-Stand ⇒ veraltet; aktueller Seed ⇒ aktuell mit Namen; ältere Version ⇒ Hinweis; Registry/Zähler/resetStale', async () => {
    const { cookie, adminId } = await adminCookie(demo);
    const get = async () => {
      const response = await demo.app.inject({
        method: 'GET',
        url: '/staff/demo/status',
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      return response.json();
    };
    expect(await get()).toEqual({
      environment: 'demo',
      datasetVersion: null,
      expectedDatasetVersion: DEMO_DATASET_VERSION,
      outdated: false,
      outdatedHint: null,
      seededAt: null,
      seededBy: null,
      lastResetAt: null,
      lastResetBy: null,
      resetInProgress: false,
      resetStartedAt: null,
      resetStale: false,
      counts: { customers: 0, processes: 0, tours: 0 },
      seedEntities: 0,
    });

    // Business-Daten ohne registrierten Seed-Stand: Herkunft unbekannt ⇒ veraltet.
    const customer = await createTestCustomer(demo, adminId, { email: 'kundin@example.com' });
    expect(await get()).toMatchObject({
      outdated: true,
      outdatedHint: DEMO_MESSAGES.DEMO_OUTDATED,
      counts: { customers: 1, processes: 0, tours: 0 },
    });

    // Aktueller Seed-Stand durch die Admin ⇒ aktuell, mit Anzeigename.
    const dataset = new DemoDatasetService(demo.db);
    const seededAt = new Date('2026-10-30T10:00:00.000Z');
    await demo.db.transaction((tx) =>
      dataset.markSeeded(tx, {
        datasetVersion: DEMO_DATASET_VERSION,
        seededBy: adminId,
        now: seededAt,
      }),
    );
    const registry = new DemoSeedRegistry(demo.db);
    await demo.db.transaction((tx) =>
      registry.register(tx, {
        seedKey: 'customer.private.basic',
        entityType: 'customer',
        entityId: customer.id,
        datasetVersion: DEMO_DATASET_VERSION,
      }),
    );
    expect(await get()).toMatchObject({
      datasetVersion: DEMO_DATASET_VERSION,
      outdated: false,
      outdatedHint: null,
      seededAt: seededAt.toISOString(),
      seededBy: { id: adminId, name: 'Anna Admin' },
      seedEntities: 1,
    });
    const entities = await demo.app.inject({
      method: 'GET',
      url: '/staff/demo/seed-entities',
      headers: { cookie },
    });
    expect(entities.json()).toEqual({
      expectedDatasetVersion: DEMO_DATASET_VERSION,
      entities: [
        {
          seedKey: 'customer.private.basic',
          entityType: 'customer',
          entityId: customer.id,
          datasetVersion: DEMO_DATASET_VERSION,
        },
      ],
    });

    // Älterer Datenstand ⇒ Hinweis, nie automatischer Reset (Runner unberührt).
    await demo.db
      .update(demoDatasetState)
      .set({ datasetVersion: DEMO_DATASET_VERSION - 1 })
      .where(eq(demoDatasetState.id, 1));
    expect(await get()).toMatchObject({
      datasetVersion: DEMO_DATASET_VERSION - 1,
      outdated: true,
      outdatedHint: DEMO_MESSAGES.DEMO_OUTDATED,
    });
    expect(resetRunner.calls).toEqual([]);

    // Hängender Reset (älter als DEMO_RESET_STALE_MS = 10 min; hier 31 min) ⇒ resetStale, lastResetBy mit Namen.
    await setResetInProgress(demo, adminId, new Date(Date.now() - 31 * 60 * 1000));
    expect(await get()).toMatchObject({
      resetInProgress: true,
      resetStale: true,
      lastResetBy: { id: adminId, name: 'Anna Admin' },
    });
    await clearResetInProgress(demo);
  });

  it('D-P8. Serverlog und Antworten der Demo-Verwaltung enthalten keine Secrets', async () => {
    const { cookie } = await adminCookie(demo);
    const status = await demo.app.inject({
      method: 'GET',
      url: '/staff/demo/status',
      headers: { cookie },
    });
    const me = await demo.app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    await demo.app.inject({
      method: 'POST',
      url: '/staff/demo/reset',
      headers: { cookie },
      payload: { confirmation: DEMO_MESSAGES.RESET_CONFIRMATION },
    });
    const text = logChunks.join('');
    expect(text.length).toBeGreaterThan(0);
    for (const secret of [
      DEMO_TEST_AUTH_SECRET_KEY,
      DEMO_TEST_COMMUNICATION_PAYLOAD_KEY,
      ADMIN_PASSWORD,
      cookie.replace('mr_staff_session=', ''),
    ]) {
      expect(text).not.toContain(secret);
      expect(status.body).not.toContain(secret);
      expect(me.body).not.toContain(secret);
    }
  });
});
