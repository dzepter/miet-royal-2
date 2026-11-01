import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  createDemoResetGate,
  DEMO_RESET_RETRY_AFTER_SECONDS,
  isDemoGatedRequest,
} from '../src/demo/reset-gate.ts';
import { DEMO_MESSAGES } from '../src/demo/types.ts';

/**
 * Phase 14 (Design §7): Reset-Gate ohne Datenbank – Pfad-/Methodenregel,
 * In-Process-Cache und die 503-Antwort des Hooks.
 */

describe('Demo-Reset-Gate (Phase 14, Unit)', () => {
  it('D-G1. sperrt Business-Mutationen unter /staff, /public und /webhooks (Query wird ignoriert)', () => {
    for (const [method, url] of [
      ['POST', '/staff/customers'],
      ['PUT', '/staff/processes/abc'],
      ['PATCH', '/staff/machines/abc'],
      ['DELETE', '/staff/customers/abc'],
      ['POST', '/staff/offline/sync'],
      ['POST', '/staff/offline/package'],
      ['POST', '/public/offers/token/accept?x=1'],
      ['POST', '/webhooks/whatsapp'],
      ['post', '/staff/settings/completed-visibility'],
    ] as const) {
      expect(isDemoGatedRequest(method, url), `${method} ${url}`).toBe(true);
    }
  });

  it('D-G2. lässt Lesezugriffe, Auth, Demo-Verwaltung, Push-Geräte und die Offline-Lease passieren', () => {
    for (const [method, url] of [
      ['GET', '/staff/customers'],
      ['HEAD', '/staff/customers'],
      ['OPTIONS', '/staff/customers'],
      ['GET', '/public/offers/token'],
      ['POST', '/auth/login'],
      ['POST', '/auth/logout'],
      ['POST', '/auth/sessions/abc/revoke'],
      ['POST', '/staff/demo/reset'],
      ['GET', '/staff/demo/status'],
      ['POST', '/staff/push/subscriptions'],
      ['POST', '/staff/push/subscriptions/status'],
      ['POST', '/staff/offline/lease'],
      ['POST', '/staff/offline/lease/revoke'],
      ['POST', '/health'],
    ] as const) {
      expect(isDemoGatedRequest(method, url), `${method} ${url}`).toBe(false);
    }
  });

  it('D-G3. liest den Zustand mit Cache (TTL), invalidate() verwirft ihn, DB-Fehler ⇒ fail-open mit Warnung ohne Fehlertext', async () => {
    let value = false;
    let reads = 0;
    let fail = false;
    let clock = 1_000;
    const warnings: Record<string, unknown>[] = [];
    const gate = createDemoResetGate({
      dataset: {
        resetInProgress: async () => {
          reads += 1;
          if (fail) {
            const error = new Error('SQL: SELECT … WHERE kunde = "geheim"');
            (error as { code?: string }).code = '57P01';
            throw error;
          }
          return value;
        },
      },
      cacheTtlMs: 1000,
      logger: { warn: (context) => warnings.push(context) },
      now: () => clock,
    });
    expect(await gate.isResetInProgress()).toBe(false);
    value = true;
    expect(await gate.isResetInProgress()).toBe(false); // Cache gilt (TTL 1 s)
    expect(reads).toBe(1);
    clock += 1000;
    expect(await gate.isResetInProgress()).toBe(true);
    expect(reads).toBe(2);
    gate.invalidate();
    value = false;
    expect(await gate.isResetInProgress()).toBe(false);
    expect(reads).toBe(3);
    // Parallele Aufrufe teilen sich einen Lesevorgang.
    gate.invalidate();
    await Promise.all([gate.isResetInProgress(), gate.isResetInProgress()]);
    expect(reads).toBe(4);
    // DB-Fehler: Anfrage läuft normal weiter; Log nennt nur Klasse/Code.
    gate.invalidate();
    fail = true;
    expect(await gate.isResetInProgress()).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).not.toContain('geheim');
    expect(warnings[0]).toMatchObject({ errorName: 'Error', errorCode: '57P01' });
  });

  it('D-G4. Hook antwortet 503 DEMO_RESET mit retry-after 15 nur für gesperrte Anfragen', async () => {
    let inProgress = true;
    const gate = createDemoResetGate({
      dataset: { resetInProgress: async () => inProgress },
      cacheTtlMs: 0,
    });
    const app = Fastify();
    app.addHook('onRequest', gate.onRequest);
    app.post('/staff/customers', async () => ({ created: true }));
    app.get('/staff/customers', async () => ({ list: true }));
    app.post('/auth/login', async () => ({ login: true }));
    await app.ready();

    const blocked = await app.inject({ method: 'POST', url: '/staff/customers', payload: {} });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.headers['retry-after']).toBe(String(DEMO_RESET_RETRY_AFTER_SECONDS));
    expect(blocked.json()).toMatchObject({
      error: { code: 'DEMO_RESET', message: DEMO_MESSAGES.DEMO_RESET },
    });
    expect(blocked.json().error.correlationId).toEqual(expect.any(String));

    expect((await app.inject({ method: 'GET', url: '/staff/customers' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: {} })).statusCode).toBe(
      200,
    );

    inProgress = false;
    expect(
      (await app.inject({ method: 'POST', url: '/staff/customers', payload: {} })).statusCode,
    ).toBe(200);
    await app.close();
  });

  it('RF1. Hook prüft die geroutete (dekodierte) URL: Percent-codierte Pfade wie /%73taff/customers werden während eines Resets ebenfalls mit 503 abgewiesen; Ausnahmen bleiben auch codiert frei (Review F1)', async () => {
    const gate = createDemoResetGate({
      dataset: { resetInProgress: async () => true },
      cacheTtlMs: 0,
    });
    const app = Fastify();
    app.addHook('onRequest', gate.onRequest);
    app.post('/staff/customers', async () => ({ created: true }));
    app.delete('/staff/customers/:id', async () => ({ deleted: true }));
    app.post('/public/offers/:token/accept', async () => ({ accepted: true }));
    app.post('/webhooks/whatsapp', async () => ({ webhook: true }));
    app.post('/staff/push/subscriptions', async () => ({ push: true }));
    app.get('/staff/customers', async () => ({ list: true }));
    await app.ready();

    for (const [method, url] of [
      ['POST', '/%73taff/customers'],
      ['POST', '/staff/%63ustomers'],
      ['DELETE', '/staff/customers/%61bc'],
      ['POST', '/%70ublic/offers/t%6Fken/accept'],
      ['POST', '/%77ebhooks/whatsapp'],
      ['POST', '/staff/customers?next=%2Fstaff%2Fpush'],
      ['POST', '/staff/customers'],
    ] as const) {
      const response = await app.inject({ method, url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'DEMO_RESET' } });
      expect(response.headers['retry-after']).toBe(String(DEMO_RESET_RETRY_AFTER_SECONDS));
    }
    // Ausnahme (Push-Geräte) und Lesezugriffe bleiben frei – auch Percent-codiert.
    expect(
      (await app.inject({ method: 'POST', url: '/%73taff/push/subscriptions', payload: {} }))
        .statusCode,
    ).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/%73taff/customers' })).statusCode).toBe(200);
    // Ohne passende Route gibt es nichts zu mutieren: 404 des Routers, kein 503.
    expect(
      (await app.inject({ method: 'POST', url: '/%73taff/unbekannt', payload: {} })).statusCode,
    ).toBe(404);
    await app.close();
  });
});
