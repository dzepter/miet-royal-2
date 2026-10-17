/**
 * Phase 10 – Event-Subscription-Setup (idempotent, Order §54) und
 * Reconciliation (Order §53) gegen den Contract-Fake; Pflichttests 138–145.
 */
import { randomUUID } from 'node:crypto';
import {
  accountingTransfers,
  cancellations,
  lexwareIntegrationState,
  lexwareInvoiceMappings,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountingTransferService } from '../src/accounting/transfer-service.ts';
import { LexwareConnectionService } from '../src/lexware/connection-service.ts';
import { createLexwareContext } from '../src/lexware/context.ts';
import { NoopLexwareThrottle, PostgresLexwareThrottle } from '../src/lexware/rate-limiter.ts';
import {
  LEXWARE_RECONCILE_ADMIN_LIMIT,
  LexwareReconcileService,
} from '../src/lexware/reconcile-service.ts';
import {
  LEXWARE_REQUIRED_EVENT_TYPES,
  LexwareSubscriptionService,
} from '../src/lexware/subscription-service.ts';
import type { FakeLexwareServer } from '../src/lexware/testing/fake-server.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  adminSession,
  createFakeInvoice,
  createMappedTransfer,
  truncateLexwareWorld,
} from './lexware-connection-helpers.ts';

let ctx: TestContext;
let fake: FakeLexwareServer;
const CALLBACK = 'https://test.example/webhooks/lexware';

beforeAll(async () => {
  ctx = await createTestContext({ lexware: true });
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
  fake.invoices.clear();
  fake.subscriptions.clear();
  fake.requestLog.length = 0;
  await new LexwareConnectionService(ctx.lexware).check();
});

const connection = () => new LexwareConnectionService(ctx.lexware);
const subscriptions = () => new LexwareSubscriptionService(ctx.lexware, connection());
const transfers = () => new AccountingTransferService(ctx.db, ctx.accounting, ctx.queue);
const reconcile = () => new LexwareReconcileService(ctx.lexware, ctx.db, transfers(), connection());

function seedForeignSubscription(eventType: string, callbackUrl: string) {
  const subscriptionId = randomUUID();
  fake.subscriptions.set(subscriptionId, {
    subscriptionId,
    organizationId: fake.organizationId,
    eventType,
    callbackUrl,
    createdDate: new Date().toISOString(),
  });
  return subscriptionId;
}

describe('Event-Subscriptions – pnpm lexware:setup / Adminaktion (§54, Tests 138–141)', () => {
  it('138. Setup ist idempotent: zweiter Lauf legt nichts Neues an', async () => {
    const first = await subscriptions().setup();
    expect(first.created.sort()).toEqual([...LEXWARE_REQUIRED_EVENT_TYPES].sort());
    expect(first.existing).toEqual([]);
    expect(first.failed).toEqual([]);
    expect(first.webhookStatus).toBe('configured');
    const second = await subscriptions().setup();
    expect(second.created).toEqual([]);
    expect(second.existing.sort()).toEqual([...LEXWARE_REQUIRED_EVENT_TYPES].sort());
    expect(fake.subscriptions.size).toBe(5);
    const [state] = await ctx.db.select().from(lexwareIntegrationState);
    expect(state!.webhookStatus).toBe('configured');
    expect(state!.webhooksCheckedAt).not.toBeNull();
    expect((state!.subscriptions as unknown[]).length).toBe(5);
    expect(JSON.stringify(state!.subscriptions)).not.toContain(fake.apiKey);
  });

  it('139. Vorhandene Subscription mit gleicher Callback-URL wird wiederverwendet, nicht dupliziert', async () => {
    const existingId = seedForeignSubscription('payment.changed', CALLBACK);
    const result = await subscriptions().setup();
    expect(result.existing).toEqual(['payment.changed']);
    expect(result.created).toHaveLength(4);
    expect(fake.subscriptions.size).toBe(5);
    expect(fake.subscriptions.has(existingId)).toBe(true);
    const stored = await subscriptions().stored();
    expect(stored.find((s) => s.eventType === 'payment.changed')?.subscriptionId).toBe(existingId);
  });

  it('140. Fehlende Subscription wird beim nächsten Lauf angelegt (z. B. nach Key-Erneuerung)', async () => {
    await subscriptions().setup();
    const stored = await subscriptions().stored();
    const revoked = stored.find((s) => s.eventType === 'token.revoked')!;
    fake.subscriptions.delete(revoked.subscriptionId);
    const result = await subscriptions().setup();
    expect(result.created).toEqual(['token.revoked']);
    expect(result.existing).toHaveLength(4);
    expect(fake.subscriptions.size).toBe(5);
  });

  it('141. Fremde Subscriptions werden nie gelöscht; nur die EIGENE mit veralteter Callback-URL wird ersetzt', async () => {
    const foreignId = seedForeignSubscription('invoice.changed', 'https://andere-app.example/hook');
    const foreignSameType = seedForeignSubscription(
      'payment.changed',
      'https://altsystem.example/x',
    );
    await subscriptions().setup();
    expect(fake.subscriptions.has(foreignId)).toBe(true);
    expect(fake.subscriptions.has(foreignSameType)).toBe(true);
    expect(fake.subscriptions.size).toBe(7);

    // Eigene Subscription mit alter URL simulieren: gespeicherter Stand zeigt
    // auf eine Subscription, deren Callback nicht mehr der Konfiguration entspricht.
    const staleId = seedForeignSubscription('invoice.deleted', 'https://alt.test.example/webhooks');
    const stored = await subscriptions().stored();
    const current = stored.find((s) => s.eventType === 'invoice.deleted')!;
    fake.subscriptions.delete(current.subscriptionId);
    await ctx.db
      .update(lexwareIntegrationState)
      .set({
        subscriptions: stored.map((s) =>
          s.eventType === 'invoice.deleted'
            ? { ...s, subscriptionId: staleId, callbackUrl: 'https://alt.test.example/webhooks' }
            : s,
        ),
      })
      .where(eq(lexwareIntegrationState.environment, ctx.config.appEnv));
    const result = await subscriptions().setup();
    expect(result.created).toEqual(['invoice.deleted']);
    expect(fake.subscriptions.has(staleId)).toBe(false);
    expect(fake.subscriptions.has(foreignId)).toBe(true);
    expect(fake.subscriptions.has(foreignSameType)).toBe(true);
    expect(fake.requestLog.filter((r) => r.method === 'DELETE')).toHaveLength(1);
  });

  it('Setup-Fehler: 403 beim Anlegen ⇒ failed mit Code, Status incomplete; 401 ⇒ disconnected', async () => {
    fake.deniedScopes.add('/v1/event-subscriptions');
    fake.failures.push({
      match: 'GET /v1/event-subscriptions',
      status: 200,
      times: 1,
      body: { content: [] },
    });
    const result = await subscriptions().setup();
    expect(result.failed).toHaveLength(5);
    expect(result.failed[0]!.code).toBe('LEXWARE_FORBIDDEN');
    expect(result.webhookStatus).toBe('incomplete');
    fake.deniedScopes.clear();
    fake.revoked = true;
    await expect(subscriptions().setup()).rejects.toMatchObject({ code: 'LEXWARE_UNAUTHORIZED' });
    const state = await connection().getState();
    expect(state?.status).toBe('disconnected');
    expect(state?.webhookStatus).toBe('error');
  });

  it('Admin-Route POST /staff/lexware/setup-webhooks liefert {created, existing, failed}; Status zeigt Subscriptions', async () => {
    const { cookie } = await adminSession(ctx);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/staff/lexware/setup-webhooks',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      existing: [],
      failed: [],
      webhookStatus: 'configured',
    });
    expect(response.json().created).toHaveLength(5);
    const status = await ctx.app.inject({
      method: 'GET',
      url: '/staff/lexware/status',
      headers: { cookie },
    });
    expect(status.json().webhooks).toMatchObject({ status: 'configured', callbackUrl: CALLBACK });
    expect(status.json().webhooks.subscriptions).toHaveLength(5);
    expect(status.body).not.toContain(fake.apiKey);
  });
});

describe('Reconciliation – pnpm lexware:reconcile / Adminaktion (§53, Tests 142–145)', () => {
  it('142. Nur relevante Mappings werden abgefragt (open/overdue oder ohne Prüfcode und nicht bezahlt)', async () => {
    const { admin } = await adminSession(ctx);
    const open = await createMappedTransfer(ctx, admin.id, await createFakeInvoice(ctx));
    const paid = await createMappedTransfer(ctx, admin.id, await createFakeInvoice(ctx), {
      paymentStatus: 'paid',
      voucherStatus: 'paid',
      openAmountCents: 0,
    });
    const foreignAttention = await createMappedTransfer(
      ctx,
      admin.id,
      await createFakeInvoice(ctx),
      {
        paymentStatus: null,
        attentionCode: 'TOTAL_MISMATCH',
      },
    );
    const unknown = await createMappedTransfer(ctx, admin.id, await createFakeInvoice(ctx), {
      paymentStatus: null,
      voucherStatus: null,
      attentionCode: null,
    });
    const candidates = await reconcile().candidates();
    expect(candidates.sort()).toEqual([open.mapping.id, unknown.mapping.id].sort());
    fake.requestLog.length = 0;
    const result = await reconcile().run();
    expect(result).toMatchObject({ checked: 2, attention: 0, failed: 0 });
    const touched = fake.requestLog.map((r) => r.path);
    expect(touched).toContain(`/v1/invoices/${open.mapping.lexwareInvoiceId}`);
    expect(touched).toContain(`/v1/invoices/${unknown.mapping.lexwareInvoiceId}`);
    expect(touched).not.toContain(`/v1/invoices/${paid.mapping.lexwareInvoiceId}`);
    expect(touched).not.toContain(`/v1/invoices/${foreignAttention.mapping.lexwareInvoiceId}`);
    // Keine Historie: nur GET invoice/payment, keine voucherlist.
    expect(touched.some((p) => p.includes('voucherlist'))).toBe(false);
  });

  it('143. Reconcile nutzt die zentrale Drosselung (≥ 500 ms zwischen Requests, auch bei 100er-Batch-Grenze)', async () => {
    const { admin } = await adminSession(ctx);
    await createMappedTransfer(ctx, admin.id, await createFakeInvoice(ctx));
    await createMappedTransfer(ctx, admin.id, await createFakeInvoice(ctx));
    await ctx.pool.query('TRUNCATE lexware_rate_limit');
    const throttled = createLexwareContext(ctx.config, ctx.db, ctx.lexware.logger, {
      throttle: new PostgresLexwareThrottle(ctx.db),
    });
    const conn = new LexwareConnectionService(throttled);
    const service = new LexwareReconcileService(throttled, ctx.db, transfers(), conn);
    fake.requestLog.length = 0;
    const started = Date.now();
    const result = await service.run(new Date(), 100);
    expect(result.checked).toBe(2);
    const times = fake.requestLog.map((r) => r.at);
    expect(times).toHaveLength(4);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(450);
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
    // Batch-Grenze: candidates() liefert höchstens `limit`.
    expect((await service.candidates(1)).length).toBe(1);
  });

  it('144. Veralteter lokaler Status wird korrigiert (bezahlt/überfällig); gelöscht ⇒ Prüfbedarf, keine Finanzmutation', async () => {
    const { admin } = await adminSession(ctx);
    const paidInvoice = await createFakeInvoice(ctx);
    const paidCase = await createMappedTransfer(ctx, admin.id, paidInvoice);
    fake.setInvoicePaid(paidInvoice.id, '2026-10-21T00:00:00.000+02:00');
    const overdueInvoice = await createFakeInvoice(ctx);
    const overdueCase = await createMappedTransfer(ctx, admin.id, overdueInvoice);
    fake.setDueDate(overdueInvoice.id, '2021-05-05T00:00:00.000+02:00');
    const missingInvoice = await createFakeInvoice(ctx);
    const missingCase = await createMappedTransfer(ctx, admin.id, missingInvoice);
    fake.deleteInvoice(missingInvoice.id);

    const result = await reconcile().run();
    expect(result).toEqual({ checked: 3, updated: 2, attention: 1, failed: 0 });

    const mappingOf = async (id: string) =>
      (
        await ctx.db.select().from(lexwareInvoiceMappings).where(eq(lexwareInvoiceMappings.id, id))
      )[0]!;
    expect(await mappingOf(paidCase.mapping.id)).toMatchObject({
      paymentStatus: 'paid',
      paidDate: '2026-10-21',
      openAmountCents: 0,
    });
    expect(await mappingOf(overdueCase.mapping.id)).toMatchObject({
      paymentStatus: 'overdue',
      dueDate: '2021-05-05',
    });
    expect(await mappingOf(missingCase.mapping.id)).toMatchObject({
      attentionCode: 'INVOICE_MISSING',
      paymentStatus: 'open',
    });
    const [paidCancellation] = await ctx.db
      .select()
      .from(cancellations)
      .where(eq(cancellations.id, paidCase.cancellation.id));
    expect(paidCancellation!.paymentStatus).toBe('paid');
    const [overdueCancellation] = await ctx.db
      .select()
      .from(cancellations)
      .where(eq(cancellations.id, overdueCase.cancellation.id));
    expect(overdueCancellation!.paymentStatus).toBe('overdue');
    expect(overdueCancellation!.financeStatus).toBe('invoice_open');
    const [missingTransfer] = await ctx.db
      .select()
      .from(accountingTransfers)
      .where(eq(accountingTransfers.id, missingCase.transfer.id));
    expect(missingTransfer).toMatchObject({
      status: 'succeeded',
      paymentStatus: 'open',
      attentionCode: 'INVOICE_MISSING',
    });

    // Zweiter Lauf: bezahlt ist kein Kandidat mehr, INVOICE_MISSING ebenfalls
    // nicht (manuelle Prüfung) – nur die überfällige Rechnung wird erneut geprüft.
    const again = await reconcile().run();
    expect(again).toEqual({ checked: 1, updated: 0, attention: 0, failed: 0 });
  });

  it('144b. Adminaktion POST /staff/lexware/reconcile liefert {checked, updated, attention}; ohne Verbindung 409', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const invoice = await createFakeInvoice(ctx);
    await createMappedTransfer(ctx, admin.id, invoice);
    fake.setInvoicePaid(invoice.id);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/staff/lexware/reconcile',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ checked: 1, updated: 1, attention: 0, failed: 0 });
    // Paralleler Lauf: Advisory-Lock ⇒ 409 RECONCILE_RUNNING, danach wieder frei.
    const holder = await ctx.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('lexware-reconcile'))");
      const busy = await ctx.app.inject({
        method: 'POST',
        url: '/staff/lexware/reconcile',
        headers: { cookie },
      });
      expect(busy.statusCode).toBe(409);
      expect(busy.json().error.code).toBe('RECONCILE_RUNNING');
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
    const free = await ctx.app.inject({
      method: 'POST',
      url: '/staff/lexware/reconcile',
      headers: { cookie },
    });
    expect(free.statusCode).toBe(200);
    await connection().markDisconnected('TOKEN_REVOKED');
    const blocked = await ctx.app.inject({
      method: 'POST',
      url: '/staff/lexware/reconcile',
      headers: { cookie },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('LEXWARE_NOT_CONNECTED');
    expect(blocked.body).not.toContain(fake.apiKey);
  });

  it('142b. Mappings mit INVOICE_VOIDED/INVOICE_MISSING bleiben dauerhaft außerhalb des Batches; Adminbatch max. 25', async () => {
    const { admin } = await adminSession(ctx);
    const voided = await createMappedTransfer(ctx, admin.id, await createFakeInvoice(ctx), {
      attentionCode: 'INVOICE_VOIDED',
      voucherStatus: 'voided',
    });
    const missing = await createMappedTransfer(ctx, admin.id, await createFakeInvoice(ctx), {
      attentionCode: 'INVOICE_MISSING',
    });
    const open = await createMappedTransfer(ctx, admin.id, await createFakeInvoice(ctx));
    const candidates = await reconcile().candidates();
    expect(candidates).toEqual([open.mapping.id]);
    expect(candidates).not.toContain(voided.mapping.id);
    expect(candidates).not.toContain(missing.mapping.id);
    expect(LEXWARE_RECONCILE_ADMIN_LIMIT).toBe(25);
  });

  it('Setup ohne Callback-URL verwirft die gespeicherten eigenen Subscription-IDs nicht', async () => {
    await subscriptions().setup();
    const before = await subscriptions().stored();
    expect(before).toHaveLength(5);
    const noCallback = createLexwareContext(
      { ...ctx.config, lexware: { ...ctx.config.lexware, webhookCallbackUrl: null } },
      ctx.db,
      ctx.lexware.logger,
      { throttle: new NoopLexwareThrottle() },
    );
    const service = new LexwareSubscriptionService(
      noCallback,
      new LexwareConnectionService(noCallback),
    );
    const result = await service.setup();
    expect(result.webhookStatus).toBe('incomplete');
    expect(result.failed).toHaveLength(5);
    expect(await service.stored()).toEqual(before);
    const [state] = await ctx.db.select().from(lexwareIntegrationState);
    expect(state!.webhookStatus).toBe('incomplete');
  });

  it('145. Kein Polling-/Cron-Job: weder Handler noch Jobs für einen Lexware-Abgleich existieren', async () => {
    const { admin } = await adminSession(ctx);
    await createMappedTransfer(ctx, admin.id, await createFakeInvoice(ctx));
    await subscriptions().setup();
    await reconcile().run();
    const rows = await ctx.pool.query<{ type: string }>(
      'SELECT DISTINCT type FROM integration_jobs',
    );
    expect(rows.rows).toEqual([]);
    const handlers = (ctx.jobs as unknown as { handlers: Map<string, unknown> }).handlers;
    const types = [...handlers.keys()];
    expect(types).toContain('lexware.event.process');
    expect(types.filter((t) => /reconcile|poll|cron|sync/i.test(t))).toEqual([]);
  });
});
