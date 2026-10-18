/**
 * Phase-11-Pflichttest 5 (Order §§7/10/48/61, Lexware-Provider): Zahlung
 * „bezahlt“ gleichzeitig per Webhook UND Reconcile gemeldet ⇒ Jobs auf der
 * PostgreSQL-Queue ⇒ exakt EIN Gutschein; Mock-Zahlungssteuerung ist mit
 * Lexware nicht aktiv (der Pfad läuft über die echte Rückmeldung).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { syncLexwareInvoice } from '../src/lexware/invoice-sync.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { postWebhook } from './lexware-connection-helpers.ts';
import {
  fakeControl,
  invoiceMappingFor,
  readyLexware,
  resetLexwareWorld,
  transferRowForSettlement,
} from './lexware-test-helpers.ts';
import { adminSession, settledReturn } from './settlement-helpers.ts';
import {
  allVouchers,
  completeCleaningViaRoute,
  drainJobs,
  truncateVoucherTables,
  vouchersForSettlement,
} from './voucher-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ lexware: true });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateVoucherTables(ctx.pool);
  await resetLexwareWorld(ctx);
});

describe('Lexware-Zahlungsrückmeldung (Test 5 / K)', () => {
  it('5. reconcile + webhook gleichzeitig „bezahlt“ ⇒ genau ein Gutschein; erneuter Webhook ⇒ kein zweiter', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { world, view } = await settledReturn(ctx, admin.id, cookie);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const row = (await transferRowForSettlement(ctx, view.settlement.id))!;
    expect(row.status).toBe('succeeded');
    const mapping = (await invoiceMappingFor(ctx, row.id))!;
    const invoiceId = mapping.lexwareInvoiceId!;
    await completeCleaningViaRoute(ctx, cookie, world.machineCodes[0]!);
    await drainJobs(ctx);
    expect(await allVouchers(ctx)).toEqual([]);

    await fakeControl(ctx, 'invoice-paid', { invoiceId, paidDate: '2026-10-20T00:00:00.000Z' });
    const signed = ctx.lexwareFake!.signWebhook({
      eventType: 'payment.changed',
      resourceId: invoiceId,
    });
    const [webhook, sync] = await Promise.all([
      postWebhook(ctx, signed.body, signed.signature),
      syncLexwareInvoice(ctx.lexware, ctx.db, ctx.transfersFor('reconcile'), mapping.id),
    ]);
    expect(webhook.statusCode).toBeLessThan(300);
    expect(['updated', 'unchanged']).toContain(sync.outcome);
    // Webhook-Job (lexware.event.process) + Gutschein-Jobs verarbeiten.
    await drainJobs(ctx);
    const vouchersAfter = await vouchersForSettlement(ctx, view.settlement.id);
    expect(vouchersAfter).toHaveLength(1);
    expect(vouchersAfter[0]).toMatchObject({ status: 'active', deliveryStatus: 'pending' });
    expect(await allVouchers(ctx)).toHaveLength(1);

    // Zweiter Webhook + zweiter Reconcile ⇒ weiterhin genau einer.
    const again = ctx.lexwareFake!.signWebhook({
      eventType: 'payment.changed',
      resourceId: invoiceId,
    });
    await postWebhook(ctx, again.body, again.signature);
    await syncLexwareInvoice(ctx.lexware, ctx.db, ctx.transfersFor('reconcile-2'), mapping.id);
    await drainJobs(ctx);
    expect(await allVouchers(ctx)).toHaveLength(1);
    const jobs = await ctx.pool.query<{ idempotency_key: string; status: string }>(
      `SELECT idempotency_key, status FROM integration_jobs WHERE type = 'voucher.eligibility_check'`,
    );
    expect(jobs.rows.every((job) => job.status === 'succeeded')).toBe(true);
    expect(jobs.rows.filter((job) => job.idempotency_key.includes(':paid:'))).toHaveLength(1);
  });
});
