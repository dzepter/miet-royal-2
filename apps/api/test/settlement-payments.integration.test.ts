/**
 * Phase-9-Pflichttests §90 (33–43): Anzahlungen und Kautionen – manuell
 * erfasst, keine Zahlungsintegration; aktive Anzahlung reduziert den
 * offenen Betrag, gehaltene Kaution nicht; bewusstes (Teil-)Anwenden mit
 * Zeilensperre gegen Überanwendung; Überzahlung separat, nie negativ.
 */
import { bookingSecurityDeposits } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  adminSession,
  issuedBookingWithOptions,
  lineOf,
  post,
  resetSettlementWorld,
  settledReturn,
  settlementViewFor,
} from './settlement-helpers.ts';
import { readyReturn } from './return-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetSettlementWorld(ctx);
});

interface PaymentsBody {
  advancePayments: { id: string; status: string; amountCents: number }[];
  securityDeposits: {
    id: string;
    status: string;
    amountCents: number;
    appliedCents: number;
    remainingHeldCents: number;
    releasedAt: string | null;
    version: number;
  }[];
  totals: { activeAdvanceCents: number; heldDepositCents: number; appliedDepositCents: number };
  settlement: { id: string; version: number } | null;
}

async function payments(cookie: string, bookingId: string): Promise<PaymentsBody> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/staff/bookings/${bookingId}/payments`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as PaymentsBody;
}

describe('Anzahlungen (§90)', () => {
  it('33./34. Anzahlung VOR der Rückgabe erfassen; nach Finalisierung reduziert sie den offenen Betrag', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await issuedBookingWithOptions(ctx, admin.id);
    const recorded = await post(
      ctx.app,
      cookie,
      `/staff/bookings/${world.bookingId}/advance-payments`,
      {
        amountCents: 2000,
        receivedAt: '2026-10-01',
        externalReference: 'Überweisung 4711',
      },
    );
    expect(recorded.status).toBe(200);
    const before = await payments(cookie, world.bookingId);
    expect(before.settlement).toBeNull();
    expect(before.advancePayments).toHaveLength(1);
    expect(before.totals.activeAdvanceCents).toBe(2000);
    await world.services.returns.start(admin.id, world.bookingId);
    await readyReturn(ctx, admin.id, world.services, world.bookingId);
    const finalize = await ctx.app.inject({
      method: 'POST',
      url: `/staff/returns/${world.bookingId}/finalize`,
      headers: { cookie },
    });
    expect(finalize.statusCode).toBe(200);
    const view = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(lineOf(view, 'advance_payment_credit')).toHaveLength(1);
    expect(lineOf(view, 'advance_payment_credit')[0]).toMatchObject({
      amountCents: 2000,
      direction: 'credit',
    });
    expect(view.settlement.creditsTotalCents).toBe(2000);
    expect(view.settlement.grossTotalCents).toBe(7500);
    expect(view.settlement.amountDueCents).toBe(5500);
    expect(view.settlement.overpaymentCents).toBe(0);
  });

  it('33b. Ungültiges Kalenderdatum (2026-02-30) ⇒ 400, keine Erfassung', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await issuedBookingWithOptions(ctx, admin.id);
    for (const receivedAt of ['2026-02-30', '2026-13-01', '2026-04-31']) {
      const response = await post(
        ctx.app,
        cookie,
        `/staff/bookings/${world.bookingId}/advance-payments`,
        { amountCents: 1000, receivedAt },
      );
      expect(response.status, receivedAt).toBe(400);
      const deposit = await post(
        ctx.app,
        cookie,
        `/staff/bookings/${world.bookingId}/security-deposits`,
        { amountCents: 1000, receivedAt },
      );
      expect(deposit.status, receivedAt).toBe(400);
    }
    const before = await payments(cookie, world.bookingId);
    expect(before.advancePayments).toEqual([]);
    expect(before.securityDeposits).toEqual([]);
  });

  it('35. Stornierte Anzahlung wird nicht berücksichtigt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie);
    await post(ctx.app, cookie, `/staff/bookings/${world.bookingId}/advance-payments`, {
      amountCents: 1500,
      receivedAt: '2026-10-01',
    });
    let current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.amountDueCents).toBe(6000);
    expect(current.settlement.version).toBeGreaterThan(view.settlement.version);
    const advanceId = current.advancePayments[0]!.id;
    const cancelled = await post(
      ctx.app,
      cookie,
      `/staff/advance-payments/${advanceId}/cancel`,
      {},
    );
    expect(cancelled.status).toBe(200);
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(lineOf(current, 'advance_payment_credit')).toEqual([]);
    expect(current.settlement.amountDueCents).toBe(7500);
    expect(current.advancePayments[0]).toMatchObject({ status: 'cancelled' });
    const again = await post(ctx.app, cookie, `/staff/advance-payments/${advanceId}/cancel`, {});
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe('ADVANCE_NOT_ACTIVE');
  });

  it('41./42. Credits > Belastung ⇒ amount_due 0, Überzahlung separat mit Hinweis – keine negative Rechnung', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world } = await settledReturn(ctx, admin.id, cookie);
    await post(ctx.app, cookie, `/staff/bookings/${world.bookingId}/advance-payments`, {
      amountCents: 10000,
      receivedAt: '2026-10-01',
    });
    const view = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(view.settlement.amountDueCents).toBe(0);
    expect(view.settlement.overpaymentCents).toBe(2500);
    expect(view.settlement.overpaymentHint).toBe('Externe Rückzahlung/Verrechnung prüfen');
    expect(view.settlement.creditsTotalCents).toBe(10000);
    expect(view.settlement.grossTotalCents).toBe(7500);
  });
});

describe('Kautionen (§90)', () => {
  it('36./37./38./39. Gehaltene Kaution reduziert nicht; teilweises Anwenden ≤ gehalten; Rest bleibt held; Überanwendung abgelehnt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world } = await settledReturn(ctx, admin.id, cookie);
    const recorded = await post(
      ctx.app,
      cookie,
      `/staff/bookings/${world.bookingId}/security-deposits`,
      {
        amountCents: 5000,
        receivedAt: '2026-10-01',
        externalReference: 'Bar erhalten',
      },
    );
    expect(recorded.status).toBe(200);
    let view = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(view.settlement.amountDueCents).toBe(7500);
    expect(lineOf(view, 'deposit_applied_credit')).toEqual([]);
    expect(view.securityDeposits[0]).toMatchObject({
      status: 'held',
      remainingHeldCents: 5000,
      version: 1,
    });
    const depositId = view.securityDeposits[0]!.id;
    const tooMuch = await post(ctx.app, cookie, `/staff/security-deposits/${depositId}/apply`, {
      amountCents: 6000,
      version: 1,
    });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error?.code).toBe('DEPOSIT_EXCEEDS_HELD');
    const partial = await post(ctx.app, cookie, `/staff/security-deposits/${depositId}/apply`, {
      amountCents: 2000,
      version: 1,
    });
    expect(partial.status).toBe(200);
    view = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(lineOf(view, 'deposit_applied_credit')).toHaveLength(1);
    expect(lineOf(view, 'deposit_applied_credit')[0]!.amountCents).toBe(2000);
    expect(view.settlement.amountDueCents).toBe(5500);
    expect(view.securityDeposits[0]).toMatchObject({
      status: 'held',
      appliedCents: 2000,
      remainingHeldCents: 3000,
      version: 2,
    });
    // Mehr als noch gehalten (3000) ⇒ abgelehnt; Angewendetes bleibt.
    const over = await post(ctx.app, cookie, `/staff/security-deposits/${depositId}/apply`, {
      amountCents: 3001,
      version: 2,
    });
    expect(over.status).toBe(409);
    // Mehr als offen ⇒ abgelehnt (kein Überzahlungsmechanismus über Kaution).
    await post(ctx.app, cookie, `/staff/bookings/${world.bookingId}/advance-payments`, {
      amountCents: 5000,
      receivedAt: '2026-10-02',
    });
    view = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(view.settlement.amountDueCents).toBe(500);
    const overDue = await post(ctx.app, cookie, `/staff/security-deposits/${depositId}/apply`, {
      amountCents: 600,
      version: 2,
    });
    expect(overDue.status).toBe(409);
    expect(overDue.body.error?.code).toBe('DEPOSIT_EXCEEDS_DUE');
    const stored = await ctx.db
      .select()
      .from(bookingSecurityDeposits)
      .where(eq(bookingSecurityDeposits.id, depositId));
    expect(stored[0]!.appliedCents).toBe(2000);
  });

  it('40. Kaution freigeben dokumentiert nur den Zustand – keine Banktransaktion, keine Rechnungsänderung', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world } = await settledReturn(ctx, admin.id, cookie);
    await post(ctx.app, cookie, `/staff/bookings/${world.bookingId}/security-deposits`, {
      amountCents: 5000,
      receivedAt: '2026-10-01',
    });
    let view = await settlementViewFor(ctx.app, cookie, world.processId);
    const depositId = view.securityDeposits[0]!.id;
    await post(ctx.app, cookie, `/staff/security-deposits/${depositId}/apply`, {
      amountCents: 1000,
      version: 1,
    });
    const released = await post(ctx.app, cookie, `/staff/security-deposits/${depositId}/release`, {
      version: 2,
    });
    expect(released.status).toBe(200);
    const body = released.body as unknown as PaymentsBody;
    expect(body.securityDeposits[0]).toMatchObject({
      status: 'released',
      appliedCents: 1000,
      remainingHeldCents: 0,
      version: 3,
    });
    expect(body.securityDeposits[0]!.releasedAt).not.toBeNull();
    expect(body.totals).toEqual({
      activeAdvanceCents: 0,
      heldDepositCents: 0,
      appliedDepositCents: 1000,
    });
    view = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(view.settlement.amountDueCents).toBe(6500);
    const again = await post(ctx.app, cookie, `/staff/security-deposits/${depositId}/release`, {
      version: 3,
    });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe('DEPOSIT_NOT_HELD');
    const tables = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name LIKE '%bank%' OR table_name LIKE '%refund%'`,
    );
    expect(tables.rows[0].n).toBe(0);
  });

  it('43. Parallele Kautionsanwendung ⇒ keine Überanwendung (Zeilensperre + Version)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world } = await settledReturn(ctx, admin.id, cookie);
    await post(ctx.app, cookie, `/staff/bookings/${world.bookingId}/security-deposits`, {
      amountCents: 5000,
      receivedAt: '2026-10-01',
    });
    const view = await settlementViewFor(ctx.app, cookie, world.processId);
    const depositId = view.securityDeposits[0]!.id;
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        post(ctx.app, cookie, `/staff/security-deposits/${depositId}/apply`, {
          amountCents: 3000,
          version: 1,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    const stored = await ctx.db
      .select()
      .from(bookingSecurityDeposits)
      .where(eq(bookingSecurityDeposits.id, depositId));
    expect(stored[0]!.appliedCents).toBe(3000);
    expect(stored[0]!.status).toBe('held');
    const after = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(lineOf(after, 'deposit_applied_credit')).toHaveLength(1);
    expect(after.settlement.amountDueCents).toBe(4500);
  });

  it('Anzahlung/Kaution nach Transfer-Lock ⇒ 409 (Credits unveränderlich)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie);
    await post(ctx.app, cookie, `/staff/bookings/${world.bookingId}/security-deposits`, {
      amountCents: 5000,
      receivedAt: '2026-10-01',
    });
    const transfer = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/transfer`,
      {
        version: view.settlement.version,
      },
    );
    expect(transfer.status).toBe(200);
    const advance = await post(
      ctx.app,
      cookie,
      `/staff/bookings/${world.bookingId}/advance-payments`,
      {
        amountCents: 1000,
        receivedAt: '2026-10-01',
      },
    );
    expect(advance.status).toBe(409);
    expect(advance.body.error?.code).toBe('SETTLEMENT_LOCKED');
    const current = await settlementViewFor(ctx.app, cookie, world.processId);
    const apply = await post(
      ctx.app,
      cookie,
      `/staff/security-deposits/${current.securityDeposits[0]!.id}/apply`,
      {
        amountCents: 1000,
        version: 1,
      },
    );
    expect(apply.status).toBe(409);
    expect(apply.body.error?.code).toBe('SETTLEMENT_LOCKED');
  });
});
