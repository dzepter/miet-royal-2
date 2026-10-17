/**
 * Phase-10-Pflichttests Security 152–172 (Agent B, Order §90/§93): IDOR auf
 * Kontakt-/Mapping-Routen, Steuerkonfiguration nur system.settings, keine
 * synthetischen Werte in production, Phase-9-Snapshot nach Transfer
 * unverändert, kein zweiter Transfer nach Erfolg, kein Key/keine
 * Kundendaten in Antworten und Logs, Mock-Steuerung nicht mit Lexware.
 */
import { Writable } from 'node:stream';
import { loadConfig } from '@mietroyal/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { stableStringify } from '../src/lexware/invoice-builder.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { createStaffWithPermissions } from './crm-helpers.ts';
import {
  fakeInvoices,
  jsonGet,
  jsonPost,
  readyLexware,
  resetLexwareWorld,
  syntheticTax,
  transferRowForSettlement,
  transferSettlement,
} from './lexware-test-helpers.ts';
import { adminSession, post, settledReturn, settlementViewFor } from './settlement-helpers.ts';

let ctx: TestContext;
const logLines: string[] = [];
const logDestination = new Writable({
  write(chunk, _encoding, callback) {
    logLines.push(chunk.toString());
    callback();
  },
});

beforeAll(async () => {
  ctx = await createTestContext({ lexware: true, logDestination, logLevel: 'trace' });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetLexwareWorld(ctx);
  logLines.length = 0;
});

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

describe('Security Phase 10 (Agent B)', () => {
  it('152./153. IDOR: unbekannter/unsichtbarer Kunde bzw. unbekannte Abrechnung ⇒ neutrales 404 auf Kontakt-/Rechnungsdatei-Routen; ohne Login 401', async () => {
    const { cookie } = await adminSession(ctx);
    for (const [method, url] of [
      ['GET', `/staff/customers/${UNKNOWN_ID}/lexware-contact`],
      ['POST', `/staff/customers/${UNKNOWN_ID}/lexware-contact/create`],
      ['GET', `/staff/settlements/${UNKNOWN_ID}/invoice-file`],
    ] as const) {
      const response = await ctx.app.inject({
        method,
        url,
        headers: { cookie },
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      expect(response.statusCode).toBe(404);
      expect(['NOT_FOUND', 'SETTLEMENT_NOT_FOUND']).toContain(response.json().error.code);
    }
    const link = await ctx.app.inject({
      method: 'POST',
      url: `/staff/customers/${UNKNOWN_ID}/lexware-contact/link`,
      headers: { cookie },
      payload: { lexwareContactId: UNKNOWN_ID },
    });
    expect(link.statusCode).toBe(404);
    const badBody = await ctx.app.inject({
      method: 'POST',
      url: `/staff/customers/${UNKNOWN_ID}/lexware-contact/link`,
      headers: { cookie },
      payload: { lexwareContactId: 'https://evil.example/x' },
    });
    expect(badBody.statusCode).toBe(400);
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/staff/customers/${UNKNOWN_ID}/lexware-contact`,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('154./155. Steuerkonfiguration nur mit system.settings (403 sonst); Mock-Zahlungssteuerung mit Lexware-Provider nicht aktiv; run-due-jobs bleibt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const staff = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Abrechnung',
      lastName: 'Ohne Admin',
      email: 'abrechnung@test.example',
      password: 'abrechnung-passwort-12345',
      permissionKeys: ['process.view_all', 'settlement.view', 'lexware.manual_transfer'],
    });
    expect((await jsonGet(ctx.app, staff.cookie, '/staff/accounting/tax-config')).status).toBe(403);
    expect(
      (
        await jsonPost(
          ctx.app,
          staff.cookie,
          '/staff/accounting/tax-config',
          { taxType: 'net', categories: [] },
          'PUT',
        )
      ).status,
    ).toBe(403);
    expect(
      (await jsonPost(ctx.app, staff.cookie, '/staff/accounting/tax-config/synthetic')).status,
    ).toBe(403);
    expect((await jsonGet(ctx.app, cookie, '/staff/accounting/tax-config')).status).toBe(200);

    const status = await jsonGet<Record<string, unknown>>(
      ctx.app,
      cookie,
      '/staff/accounting/status',
    );
    expect(status.body).toMatchObject({ provider: 'lexware', configured: true, mock: false });
    const fail = await jsonPost<{ error: { code: string } }>(
      ctx.app,
      cookie,
      '/staff/accounting/mock/fail-next',
      { count: 1 },
    );
    expect(fail.status).toBe(409);
    const runDue = await jsonPost<{ processed: number }>(
      ctx.app,
      cookie,
      '/staff/accounting/mock/run-due-jobs',
    );
    expect(runDue.status).toBe(200);
  });

  it('156. In production: keine synthetischen Steuerwerte (404), synthetische Zeilen zählen nicht, Provider disabled ohne Key', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await syntheticTax(ctx, admin.id);
    const productionConfig = loadConfig({
      APP_ENV: 'production',
      DATABASE_URL: ctx.config.databaseUrl,
      AUTH_SECRET_KEY: '1'.repeat(64),
      STORAGE_DRIVER: 'fs',
      STORAGE_FS_ROOT: ctx.config.storage.driver === 'fs' ? ctx.config.storage.fsRoot : '/tmp/x',
      LOG_LEVEL: 'error',
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
      const synthetic = await app.inject({
        method: 'POST',
        url: '/staff/accounting/tax-config/synthetic',
        headers: { cookie },
        payload: {},
      });
      expect(synthetic.statusCode).toBe(404);
      const config = await app.inject({
        method: 'GET',
        url: '/staff/accounting/tax-config',
        headers: { cookie },
      });
      expect(config.statusCode).toBe(200);
      expect(config.json()).toMatchObject({
        complete: false,
        synthetic: false,
        syntheticAllowed: false,
        categories: [],
      });
      const status = await app.inject({
        method: 'GET',
        url: '/staff/accounting/status',
        headers: { cookie },
      });
      expect(status.json()).toMatchObject({ provider: 'disabled', configured: false });
      expect(JSON.stringify(status.json())).not.toContain(ctx.lexwareFake!.apiKey);
    } finally {
      await app.close();
    }
  });

  it('164./165. Phase-9-Snapshot bleibt nach dem Lexware-Transfer unverändert; Transfer nach Erfolg ⇒ already_succeeded, keine zweite Rechnung; Client kann nichts setzen', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { view, world } = await settledReturn(ctx, admin.id, cookie);
    const first = await transferSettlement(
      ctx.app,
      cookie,
      view.settlement.id,
      view.settlement.version,
    );
    expect(first.body.outcome).toBe('succeeded');
    const row = (await transferRowForSettlement(ctx, view.settlement.id))!;
    const snapshot = stableStringify(row.snapshot);
    expect(row.snapshot).toMatchObject({ schemaVersion: 1, tax: null });
    const current = await settlementViewFor(ctx.app, cookie, world.processId);
    const again = await transferSettlement(
      ctx.app,
      cookie,
      view.settlement.id,
      current.settlement.version,
    );
    expect(again.body.outcome).toBe('already_succeeded');
    const forged = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/transfer`,
      {
        version: current.settlement.version,
        accountingReference: 'RE-FAKE',
        accounting: { invoice: { created: true } },
      },
    );
    expect(forged.status).toBe(400);
    await ctx.jobs.drain();
    const later = (await transferRowForSettlement(ctx, view.settlement.id))!;
    expect(stableStringify(later.snapshot)).toBe(snapshot);
    expect(later.snapshotHash).toBe(row.snapshotHash);
    expect(later.providerSnapshotHash).toBe(row.providerSnapshotHash);
    expect(fakeInvoices(ctx)).toHaveLength(1);
  });

  it('166.–172. Kein API-Key und keine Kundendaten in API-Antworten und Serverlog; Deeplink ohne Key', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { view, world } = await settledReturn(ctx, admin.id, cookie);
    const transfer = await transferSettlement(
      ctx.app,
      cookie,
      view.settlement.id,
      view.settlement.version,
    );
    expect(transfer.body.outcome).toBe('succeeded');
    const current = await settlementViewFor(ctx.app, cookie, world.processId);
    const contact = await jsonGet(
      ctx.app,
      cookie,
      `/staff/customers/${world.customerId}/lexware-contact`,
    );
    const tax = await jsonGet(ctx.app, cookie, '/staff/accounting/tax-config');
    const apiKey = ctx.lexwareFake!.apiKey;
    for (const body of [current, contact.body, tax.body, transfer.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(apiKey);
      expect(text).not.toContain('Bearer ');
    }
    expect(current.settlement.accounting.invoice.deeplink).not.toContain(apiKey);
    const log = logLines.join('');
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(apiKey);
    expect(log).not.toContain('klara.kommerz@test.example');
    expect(log).not.toContain('Kommerz');
    expect(log).not.toContain(current.settlement.accountingReference!);
    expect(log).not.toContain('Lieferweg');
    expect(log).toContain(view.settlement.id);
  });
});
