/**
 * Phase-11-Pflichttests Abrechnung 69/70 (Order §38): Gutscheinrabatt EXAKT
 * EINMAL als Rabattposition (Typ discount, Quelle booking_voucher) auf die
 * Maschinenmiete; Lexware-Snapshot wie ein Maschinenrabatt (negative
 * Position, Steuersatz der Maschinenmiete), Summe cent-genau.
 */
import { VOUCHER_LABEL } from '@mietroyal/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountingPayload } from '../src/accounting/gateway.ts';
import type { ProviderSnapshotV2 } from '../src/lexware/invoice-builder.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  fakeInvoices,
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
import { containsCode, issueVoucherForCustomer } from './voucher-offer-helpers.ts';

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

interface LexwareLine {
  type: string;
  name: string;
  quantity: number;
  unitName: string;
  unitPrice: { currency: string; netAmount: number; taxRatePercentage: number };
}

function cents(amount: number): number {
  return Math.round(amount * 100);
}

function voucherHook(adminId: string) {
  const state = { voucherId: '', code: '', compact: '' };
  const hook = async (customerId: string) => {
    const issued = await issueVoucherForCustomer(ctx, adminId, customerId);
    Object.assign(state, issued);
    return issued.code;
  };
  return { state, hook };
}

describe('Abrechnung mit Gutschein (69/70)', () => {
  it('69. Gutscheinrabatt erscheint exakt EINMAL (discount/booking_voucher/voucher), Beschreibung „20-%-Wiedermieter-Gutschein“, Summen korrekt, kein Code', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { state, hook } = voucherHook(admin.id);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, {
      fulfillment: 'delivery',
      deliveryPriceCents: 1999,
      selections: [{ slug: 'mischkanister-6l', role: 'extra', quantity: 1 }],
      machineCodes: ['MR-10-01-01'],
      voucherCodeFor: hook,
    });
    const discounts = lineOf(view, 'discount');
    expect(discounts).toHaveLength(1);
    const voucherLine = discounts[0]!;
    expect(voucherLine.sourceType).toBe('booking_voucher');
    expect(voucherLine.sourceId).toBe(state.voucherId);
    expect(voucherLine.description).toBe(VOUCHER_LABEL);
    expect(voucherLine.amountCents).toBe(1500); // 20 % von 75,00 EUR (slush-1x10)
    expect(voucherLine.direction).toBe('credit');
    expect(voucherLine.editable).toBe(false);
    expect(voucherLine.removable).toBe(false);
    expect(view.settlement.discountCents).toBe(1500);
    // Fester Teil: Miete 7500 + Lieferung 1999 − Gutschein 1500 = 7999; Kanister ist variabel.
    expect(view.settlement.fixedTotalCents).toBe(7999);
    expect(lineOf(view, 'machine_rental')[0]!.amountCents).toBe(7500);
    expect(lineOf(view, 'delivery')[0]!.amountCents).toBe(1999);
    expect(containsCode(view, state.code, state.compact)).toBe(false);

    // Neuaufbau (manuelle Position hinzufügen ⇒ rebuild) ⇒ weiterhin genau eine Gutscheinzeile.
    const added = await post(ctx.app, cookie, `/staff/settlements/${view.settlement.id}/lines`, {
      type: 'manual_charge',
      description: 'Zusatz',
      amountCents: 100,
      version: view.settlement.version,
    });
    expect(added.status).toBe(200);
    const rebuilt = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(lineOf(rebuilt, 'discount')).toHaveLength(1);
    expect(lineOf(rebuilt, 'discount')[0]!.amountCents).toBe(1500);
  });

  it('70. Lexware-Snapshot: Gutschein wie Maschinenrabatt (negative Position, Steuersatz der Miete), Summe cent-genau, Beschreibung übernommen', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { state, hook } = voucherHook(admin.id);
    const { view } = await settledReturn(ctx, admin.id, cookie, {
      machineCodes: ['MR-10-01-02'],
      voucherCodeFor: hook,
    });
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const invoices = fakeInvoices(ctx);
    expect(invoices).toHaveLength(1);
    const invoice = invoices[0]!;
    const row = (await transferRowForSettlement(ctx, view.settlement.id))!;
    expect(row.status).toBe('succeeded');
    const payload = row.snapshot as AccountingPayload;
    const snapshot = row.providerSnapshot as ProviderSnapshotV2;
    const payloadDiscounts = payload.lines.filter((line) => line.type === 'discount');
    expect(payloadDiscounts).toHaveLength(1);
    expect(payloadDiscounts[0]!.description).toBe(VOUCHER_LABEL);
    expect(payloadDiscounts[0]!.amountCents).toBe(1500);
    const mapped = snapshot.lines.find((line) => line.sourceType === 'discount')!;
    expect(mapped.category).toBe('machine_rental');
    expect(mapped.amountCents).toBe(-1500);
    expect(mapped.taxRateBp).toBe(
      snapshot.lines.find((line) => line.sourceType === 'machine_rental')!.taxRateBp,
    );
    const negative = (invoice.lineItems as unknown as LexwareLine[]).filter(
      (item) => item.unitPrice.netAmount < 0,
    );
    expect(negative).toHaveLength(1);
    expect(negative[0]!.name).toBe(VOUCHER_LABEL);
    expect(cents(negative[0]!.unitPrice.netAmount)).toBe(-1500);
    expect(negative[0]!.quantity).toBe(1);
    expect(negative[0]!.unitPrice.taxRatePercentage).toBe(19);
    expect(cents(invoice.totalPrice.totalNetAmount)).toBe(view.settlement.amountDueCents);
    expect(view.settlement.amountDueCents).toBe(6000);
    expect(cents(invoice.totalPrice.totalGrossAmount)).toBe(snapshot.expectedGrossCents);
    expect(containsCode(payload, state.code, state.compact)).toBe(false);
    expect(containsCode(snapshot, state.code, state.compact)).toBe(false);
    expect(JSON.stringify(invoice)).not.toContain(state.compact);
  });
});
