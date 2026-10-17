/**
 * Phase 10 – Verbindungs-/Profilprüfung gegen den Contract-Fake (Order §7/§8,
 * Vertrag §3; Pflichttests 1–4 (serverseitig), 5, 6, 7–12).
 */
import { Writable } from 'node:stream';
import { lexwareIntegrationState } from '@mietroyal/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  LexwareBlockedError,
  LexwareConnectionService,
} from '../src/lexware/connection-service.ts';
import { createLexwareContext, type LexwareContext } from '../src/lexware/context.ts';
import { NoopLexwareThrottle } from '../src/lexware/rate-limiter.ts';
import { FakeLexwareServer } from '../src/lexware/testing/fake-server.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { createStaffWithPermissions } from './crm-helpers.ts';
import { adminSession, truncateLexwareWorld } from './lexware-connection-helpers.ts';

let ctx: TestContext;
let fake: FakeLexwareServer;
const logLines: string[] = [];
const logDestination = new Writable({
  write(chunk: Buffer | string, _encoding, callback) {
    logLines.push(chunk.toString());
    callback();
  },
});
const logText = () => logLines.join('');

beforeAll(async () => {
  ctx = await createTestContext({ lexware: true, logDestination, logLevel: 'trace' });
  fake = ctx.lexwareFake as FakeLexwareServer;
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateLexwareWorld(ctx.pool);
  fake.failures.length = 0;
  fake.revoked = false;
  fake.deniedScopes.clear();
  fake.taxType = 'net';
  fake.smallBusiness = false;
  logLines.length = 0;
});

const service = () => new LexwareConnectionService(ctx.lexware);

/** Kontext gegen einen ZWEITEN Fake (andere organizationId), optional ohne Config-Pinning. */
async function contextFor(
  other: FakeLexwareServer,
  options: { pinned?: string | null } = {},
): Promise<{ lexware: LexwareContext; stop: () => Promise<void> }> {
  const url = await other.start();
  const config = {
    ...ctx.config,
    lexware: {
      ...ctx.config.lexware,
      baseUrl: url,
      apiKey: other.apiKey,
      organizationId:
        options.pinned === undefined ? ctx.config.lexware.organizationId : options.pinned,
    },
  };
  const lexware = createLexwareContext(config, ctx.db, ctx.lexware.logger, {
    throttle: new NoopLexwareThrottle(),
  });
  return { lexware, stop: () => other.stop() };
}

describe('LexwareConnectionService (§7, Tests 1–4, 7–12)', () => {
  it('1./2. Konfiguration: Fake-Kontext ist aktiv, Gateway lexware, Host nicht api.lexware.io – Key nirgends im Zustand', async () => {
    expect(ctx.config.lexware.enabled).toBe(true);
    expect(ctx.lexware.client).not.toBeNull();
    expect(ctx.config.lexware.baseUrl).not.toContain('lexware.io');
    expect(ctx.config.lexware.baseUrl).not.toContain('lexoffice');
    const state = await service().check();
    expect(JSON.stringify(state)).not.toContain(fake.apiKey);
  });

  it('7. Profile ok ⇒ status connected, Firmenname, connectionId, lastSuccessAt; keine Personendaten gespeichert', async () => {
    const result = await service().check();
    expect(result.ok).toBe(true);
    expect(result.code).toBeNull();
    expect(result.state.status).toBe('connected');
    expect(result.state.companyName).toBe(fake.companyName);
    expect(result.state.connectionId).toBe(fake.connectionId);
    expect(result.state.lastSuccessAt).not.toBeNull();
    expect(result.state.lastErrorCode).toBeNull();
    expect(result.state.environment).toBe('development');
    const serialized = JSON.stringify(result.state);
    expect(serialized).not.toContain('fake@example.invalid');
    expect(serialized).not.toContain('Fake Nutzer');
    expect(serialized).not.toContain(fake.apiKey);
    // Genau eine Zeile je Umgebung – zweite Prüfung legt keine zweite an.
    await service().check();
    const rows = await ctx.db.select().from(lexwareIntegrationState);
    expect(rows).toHaveLength(1);
  });

  it('8. organizationId wird gespeichert und bei jeder Prüfung gegen den gepinnten Wert geprüft', async () => {
    const result = await service().check();
    expect(result.state.organizationId).toBe(fake.organizationId);
    expect(result.state.pendingOrganizationId).toBeNull();
    const ready = await service().assertReady();
    expect(ready.organizationId).toBe(fake.organizationId);
    expect(await service().isTransferReady()).toBe(true);
  });

  it('9. Falsche organizationId (Config-Pinning) ⇒ organization_mismatch, Transfers blockiert', async () => {
    const other = new FakeLexwareServer({ rateLimit: false });
    const { lexware, stop } = await contextFor(other);
    try {
      const conn = new LexwareConnectionService(lexware);
      const result = await conn.check();
      expect(result.ok).toBe(false);
      expect(result.code).toBe('LEXWARE_ORGANIZATION_MISMATCH');
      expect(result.state.status).toBe('organization_mismatch');
      expect(result.state.organizationId).toBe(fake.organizationId);
      expect(result.state.pendingOrganizationId).toBe(other.organizationId);
      await expect(conn.assertReady()).rejects.toMatchObject({
        code: 'LEXWARE_ORGANIZATION_MISMATCH',
      });
      // Config-Pinning kann per UI nicht übersteuert werden.
      await expect(
        conn.confirmOrganization('00000000-0000-4000-8000-000000000001', other.organizationId),
      ).rejects.toThrow(/LEXWARE_ORGANIZATION_ID/);
    } finally {
      await stop();
    }
  });

  it('9b. Ohne Config-Pinning: erste Prüfung pinnt; spätere Änderung ⇒ mismatch bis zur Admin-Bestätigung', async () => {
    const { admin } = await adminSession(ctx);
    const first = new FakeLexwareServer({ rateLimit: false });
    const firstCtx = await contextFor(first, { pinned: null });
    const second = new FakeLexwareServer({ rateLimit: false });
    const secondCtx = await contextFor(second, { pinned: null });
    try {
      const a = await new LexwareConnectionService(firstCtx.lexware).check();
      expect(a.state.status).toBe('connected');
      expect(a.state.organizationId).toBe(first.organizationId);
      const conn = new LexwareConnectionService(secondCtx.lexware);
      const b = await conn.check();
      expect(b.state.status).toBe('organization_mismatch');
      expect(b.state.organizationId).toBe(first.organizationId);
      expect(b.state.pendingOrganizationId).toBe(second.organizationId);
      await expect(conn.assertReady()).rejects.toBeInstanceOf(LexwareBlockedError);
      await expect(conn.confirmOrganization(admin.id, 'falsch')).rejects.toThrow(
        /entspricht nicht/,
      );
      await conn.confirmOrganization(admin.id, second.organizationId);
      const after = await conn.getState();
      expect(after?.status).toBe('connected');
      expect(after?.organizationId).toBe(second.organizationId);
      expect(after?.pendingOrganizationId).toBeNull();
      expect(after?.organizationConfirmedBy).toBe(admin.id);
    } finally {
      await firstCtx.stop();
      await secondCtx.stop();
    }
  });

  it('10. taxType/smallBusiness werden aus dem Profil gelesen (kein eigener Default)', async () => {
    fake.taxType = 'vatfree';
    fake.smallBusiness = true;
    const result = await service().check();
    expect(result.state.taxType).toBe('vatfree');
    expect(result.state.smallBusiness).toBe(true);
    expect(result.state.businessFeatures).toEqual(['INVOICING', 'INVOICING_PRO', 'BOOKKEEPING']);
  });

  it('11. Fehlende Berechtigung (403) ⇒ status error mit verständlichem Code LEXWARE_FORBIDDEN', async () => {
    await service().check();
    fake.deniedScopes.add('/v1/profile');
    const result = await service().check();
    expect(result.ok).toBe(false);
    expect(result.code).toBe('LEXWARE_FORBIDDEN');
    expect(result.state.status).toBe('error');
    expect(result.state.lastErrorCode).toBe('LEXWARE_FORBIDDEN');
    await expect(service().assertReady()).rejects.toMatchObject({ code: 'LEXWARE_FORBIDDEN' });
  });

  it('12. 401 ⇒ disconnected (LEXWARE_UNAUTHORIZED), kein Transfer; markDisconnected analog', async () => {
    await service().check();
    fake.revoked = true;
    const result = await service().check();
    expect(result.code).toBe('LEXWARE_UNAUTHORIZED');
    expect(result.state.status).toBe('disconnected');
    expect(result.state.disconnectedAt).not.toBeNull();
    await expect(service().assertReady()).rejects.toMatchObject({ code: 'LEXWARE_UNAUTHORIZED' });
    fake.revoked = false;
    await service().check();
    await service().markDisconnected('TOKEN_REVOKED');
    const state = await service().getState();
    expect(state?.status).toBe('disconnected');
    expect(state?.lastErrorCode).toBe('TOKEN_REVOKED');
    await expect(service().assertReady()).rejects.toMatchObject({ code: 'LEXWARE_NOT_CONNECTED' });
  });

  it('12b. Fehlendes Business-Feature INVOICING ⇒ incomplete; Timeout/5xx ⇒ error mit transientem Code', async () => {
    const other = new FakeLexwareServer({ rateLimit: false });
    const { lexware, stop } = await contextFor(other, { pinned: null });
    try {
      other.failures.push({
        match: 'GET /v1/profile',
        status: 200,
        times: 1,
        body: { organizationId: other.organizationId, companyName: 'X', businessFeatures: [] },
      });
      const conn = new LexwareConnectionService(lexware);
      const incomplete = await conn.check();
      expect(incomplete.state.status).toBe('incomplete');
      expect(incomplete.code).toBe('LEXWARE_FEATURE_MISSING');
      await expect(conn.assertReady()).rejects.toMatchObject({ code: 'LEXWARE_NOT_CONNECTED' });
      other.failures.push({ match: 'GET /v1/profile', status: 503, times: 1 });
      const err = await conn.check();
      expect(err.state.status).toBe('error');
      expect(err.code).toBe('LEXWARE_SERVER');
    } finally {
      await stop();
    }
  });

  it('Nicht konfiguriert (client null) ⇒ LEXWARE_NOT_CONFIGURED', async () => {
    const lexware = createLexwareContext(
      { ...ctx.config, lexware: { ...ctx.config.lexware, enabled: false, apiKey: null } },
      ctx.db,
      ctx.lexware.logger,
      { throttle: new NoopLexwareThrottle() },
    );
    const conn = new LexwareConnectionService(lexware);
    expect(lexware.client).toBeNull();
    const result = await conn.check();
    expect(result.state.status).toBe('not_configured');
    await expect(conn.assertReady()).rejects.toMatchObject({ code: 'LEXWARE_NOT_CONFIGURED' });
  });
});

describe('Admin-Routen /staff/lexware/* (§8, Tests 3–6)', () => {
  it('3./4. Status-Route nur mit system.settings; Firmenname/Org-ID gekürzt; nie der Key (5)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const checked = await ctx.app.inject({
      method: 'POST',
      url: '/staff/lexware/check-connection',
      headers: { cookie },
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toMatchObject({
      ok: true,
      status: 'connected',
      statusLabel: 'Verbunden',
    });
    const status = await ctx.app.inject({
      method: 'GET',
      url: '/staff/lexware/status',
      headers: { cookie },
    });
    expect(status.statusCode).toBe(200);
    const body = status.json();
    expect(body).toMatchObject({
      configured: true,
      enabled: true,
      environment: 'development',
      status: 'connected',
      connectionOk: true,
      companyName: fake.companyName,
      taxConfigComplete: false,
      webhooks: {
        status: null,
        subscriptions: [],
        callbackUrl: 'https://test.example/webhooks/lexware',
      },
      pendingOrganizationId: null,
      deeplinkBase: 'https://app.lexware.de',
    });
    expect(body.organizationIdShort).toBe(`${fake.organizationId.slice(0, 8)}…`);
    expect(body.organizationIdShort).not.toBe(fake.organizationId);
    expect(status.body).not.toContain(fake.apiKey);
    expect(checked.body).not.toContain(fake.apiKey);
    expect(status.body).not.toContain('fake@example.invalid');

    const staff = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Sina',
      lastName: 'Sachbearbeitung',
      email: 'sina@test.example',
      password: 'sina-passwort-123456',
      permissionKeys: ['settlement.view', 'lexware.manual_transfer'],
    });
    for (const [method, url] of [
      ['GET', '/staff/lexware/status'],
      ['POST', '/staff/lexware/check-connection'],
      ['POST', '/staff/lexware/setup-webhooks'],
      ['POST', '/staff/lexware/reconcile'],
      ['POST', '/staff/lexware/confirm-organization'],
    ] as const) {
      const denied = await ctx.app.inject({
        method,
        url,
        headers: { cookie: staff.cookie },
        ...(method === 'POST' ? { payload: { organizationId: 'x' } } : {}),
      });
      expect(denied.statusCode, `${method} ${url}`).toBe(403);
      expect(denied.body).not.toContain(fake.apiKey);
    }
    const anonymous = await ctx.app.inject({ method: 'GET', url: '/staff/lexware/status' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('6. Serverlog enthält bei Prüfung/Status/Fehlern nie den API-Key', async () => {
    const { cookie } = await adminSession(ctx);
    await ctx.app.inject({
      method: 'POST',
      url: '/staff/lexware/check-connection',
      headers: { cookie },
    });
    fake.revoked = true;
    await ctx.app.inject({
      method: 'POST',
      url: '/staff/lexware/check-connection',
      headers: { cookie },
    });
    fake.revoked = false;
    fake.deniedScopes.add('/v1/profile');
    await ctx.app.inject({
      method: 'POST',
      url: '/staff/lexware/check-connection',
      headers: { cookie },
    });
    await ctx.app.inject({ method: 'GET', url: '/staff/lexware/status', headers: { cookie } });
    expect(logLines.length).toBeGreaterThan(0);
    expect(logText()).not.toContain(fake.apiKey);
    expect(logText()).not.toContain('fake@example.invalid');
  });

  it('confirm-organization: validiert Body, 409 ohne ausstehende Änderung', async () => {
    const { cookie } = await adminSession(ctx);
    const invalid = await ctx.app.inject({
      method: 'POST',
      url: '/staff/lexware/confirm-organization',
      headers: { cookie },
      payload: { organizationId: '', extra: 1 },
    });
    expect(invalid.statusCode).toBe(400);
    const nothing = await ctx.app.inject({
      method: 'POST',
      url: '/staff/lexware/confirm-organization',
      headers: { cookie },
      payload: { organizationId: fake.organizationId },
    });
    expect(nothing.statusCode).toBe(409);
    expect(nothing.json().error.code).toBe('CONFLICT');
  });
});
