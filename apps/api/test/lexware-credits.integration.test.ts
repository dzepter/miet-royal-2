/**
 * Phase-10-Pflichttests Anzahlung/Kaution 99–105 (Order §§25–28, §84;
 * Vertrag §4/§6): Credits werden NIE als negative Positionen oder Rabatt
 * abgebildet – Transfer blockiert fail-closed (ADVANCE_PAYMENT_UNSUPPORTED /
 * DEPOSIT_UNSUPPORTED), kein Lexware-Aufruf, kein Betragsverlust; gehaltene
 * Kaution ohne Anwendung blockiert nicht.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  fakeInvoices,
  fakeRequests,
  readyLexware,
  resetLexwareWorld,
  transferRowForSettlement,
} from './lexware-test-helpers.ts';
import {
  adminSession,
  lineOf,
  post,
  settledReturn,
  settlementViewFor,
} from './settlement-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ lexware: true });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetLexwareWorld(ctx);
});

describe('Anzahlung/Kaution fail-closed (Tests 99–105)', () => {
  it('99./100./101. Aktive Anzahlung ⇒ Blocker ADVANCE_PAYMENT_UNSUPPORTED in View und Transfer; kein Create, keine negative Position, Betrag bleibt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { world, view } = await settledReturn(ctx, admin.id, cookie);
    const recorded = await post(
      ctx.app,
      cookie,
      `/staff/bookings/${world.bookingId}/advance-payments`,
      { amountCents: 2000, receivedAt: '2026-10-01', externalReference: 'Überweisung 4711' },
    );
    expect(recorded.status).toBe(200);
    let current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(lineOf(current, 'advance_payment_credit')).toHaveLength(1);
    expect(current.settlement.amountDueCents).toBe(view.settlement.amountDueCents - 2000);
    expect(current.settlement.accounting.blockers.map((b) => b.code)).toEqual([
      'ADVANCE_PAYMENT_UNSUPPORTED',
    ]);
    expect(current.settlement.accounting.blockers[0]?.label).toBe(
      'Lexware-Abbildung für Anzahlung muss vor Übertragung geklärt werden.',
    );
    expect(await ctx.jobs.runOnce()).toBe('processed');
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('transfer_failed');
    expect(current.settlement.lastTransferErrorCode).toBe('ADVANCE_PAYMENT_UNSUPPORTED');
    expect(fakeInvoices(ctx)).toHaveLength(0);
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(0);
    const row = (await transferRowForSettlement(ctx, view.settlement.id))!;
    expect(row.status).toBe('failed');
    expect(row.providerSnapshot).toBeNull();
    // Kein Betragsverlust: der eingefrorene Payload trägt den Credit weiterhin.
    const payload = row.snapshot as { totals: { creditsCents: number; amountDueCents: number } };
    expect(payload.totals.creditsCents).toBe(2000);
    // Manueller Retry bleibt blockiert (kein Create).
    const retry = await post(ctx.app, cookie, `/staff/settlements/${view.settlement.id}/transfer`, {
      version: current.settlement.version,
    });
    expect(retry.status).toBe(200);
    expect(retry.body.outcome).toBe('failed');
    expect(retry.body.errorCode).toBe('ADVANCE_PAYMENT_UNSUPPORTED');
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(0);
  });

  it('102./103. Angewendete Kaution ⇒ DEPOSIT_UNSUPPORTED (kein Create); gehaltene Kaution ohne Anwendung blockiert nicht', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { world, view } = await settledReturn(ctx, admin.id, cookie);
    const recorded = await post(
      ctx.app,
      cookie,
      `/staff/bookings/${world.bookingId}/security-deposits`,
      { amountCents: 5000, receivedAt: '2026-10-01', externalReference: 'Bar erhalten' },
    );
    expect(recorded.status).toBe(200);
    let current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.accounting.blockers).toEqual([]);
    const depositId = current.securityDeposits[0]!.id;
    const applied = await post(ctx.app, cookie, `/staff/security-deposits/${depositId}/apply`, {
      amountCents: 2000,
      version: 1,
    });
    expect(applied.status).toBe(200);
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(lineOf(current, 'deposit_applied_credit')).toHaveLength(1);
    expect(current.settlement.accounting.blockers.map((b) => b.code)).toEqual([
      'DEPOSIT_UNSUPPORTED',
    ]);
    expect(current.settlement.accounting.blockers[0]?.label).toBe(
      'Lexware-Abbildung für angewendete Kaution muss vor Übertragung geklärt werden.',
    );
    expect(await ctx.jobs.runOnce()).toBe('processed');
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.lastTransferErrorCode).toBe('DEPOSIT_UNSUPPORTED');
    expect(fakeInvoices(ctx)).toHaveLength(0);
    expect((await transferRowForSettlement(ctx, view.settlement.id))!.status).toBe('failed');
  });

  it('104./105. Kaution nur gehalten/freigegeben ⇒ Rechnung wird normal erstellt; Kautionsbetrag erscheint nirgends auf der Rechnung', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { world, view } = await settledReturn(ctx, admin.id, cookie);
    const recorded = await post(
      ctx.app,
      cookie,
      `/staff/bookings/${world.bookingId}/security-deposits`,
      { amountCents: 5000, receivedAt: '2026-10-01' },
    );
    expect(recorded.status).toBe(200);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('transferred');
    const invoice = fakeInvoices(ctx)[0]!;
    expect(invoice.lineItems).toHaveLength(view.lines.length);
    expect(Math.round(invoice.totalPrice.totalNetAmount * 100)).toBe(
      view.settlement.amountDueCents,
    );
    expect(JSON.stringify(invoice.lineItems)).not.toContain('50.00');
    expect(JSON.stringify(invoice.lineItems)).not.toContain('-');
  });
});
