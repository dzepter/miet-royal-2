/**
 * Phase-10-Pflichttests Normale Rechnung 52–75 (Order §§21–25, §31, §36,
 * §37, §64, §81; Vertrag §6): finalize=true, genau eine Rechnung, Positionen
 * ausschließlich aus dem Snapshot, alle Positionstypen, Rabatt exakt, Summe
 * cent-genau, Vorgangsnummer/Marker, Metadaten gespeichert, Provider lexware,
 * Settlement gesperrt, Vorgang abgeschlossen, Zahlung offen.
 */
import { processes } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountingPayload } from '../src/accounting/gateway.ts';
import { transferMarkerFor, type ProviderSnapshotV2 } from '../src/lexware/invoice-builder.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  fakeInvoices,
  fakeRequests,
  invoiceMappingFor,
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

describe('Normale Rechnung (Tests 52–75)', () => {
  it('52./53./68.–75. Finale Rechnung (finalize=true), genau eine, Metadaten im Mapping, Provider lexware, Settlement gesperrt, Vorgang abgeschlossen, Zahlung offen', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { world, view } = await settledReturn(ctx, admin.id, cookie);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    expect(await ctx.jobs.runOnce()).toBe('idle');

    const invoices = fakeInvoices(ctx);
    expect(invoices).toHaveLength(1);
    const invoice = invoices[0]!;
    expect(invoice.voucherStatus).toBe('open');
    expect(invoice.voucherNumber).toMatch(/^RE\d+/);
    expect(invoice.dueDate).not.toBeNull();
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(1);
    expect(fakeRequests(ctx, 'GET', '/v1/payments')).toHaveLength(1);

    const row = await transferRowById(view.settlement.id);
    expect(row).toMatchObject({
      status: 'succeeded',
      provider: 'lexware',
      externalReference: invoice.voucherNumber,
      paymentStatus: 'open',
      lastErrorCode: null,
      claimedBy: null,
      attentionCode: null,
    });
    expect(row.transferredAt).not.toBeNull();
    const mapping = await invoiceMappingFor(ctx, row.id);
    expect(mapping).toMatchObject({
      lexwareInvoiceId: invoice.id,
      voucherNumber: invoice.voucherNumber,
      voucherStatus: 'open',
      dueDate: invoice.dueDate!.slice(0, 10),
      organizationId: ctx.lexwareFake!.organizationId,
      paymentStatus: 'open',
      openAmountCents: cents(invoice.totalPrice.totalGrossAmount),
      deliveryStatus: 'pending',
      expectedGrossCents: cents(invoice.totalPrice.totalGrossAmount),
      attentionCode: null,
    });
    expect(mapping!.lastSyncedAt).not.toBeNull();

    const current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement).toMatchObject({
      status: 'transferred',
      locked: true,
      accountingProvider: 'lexware',
      accountingReference: invoice.voucherNumber,
      paymentStatus: 'open',
      paymentStatusLabel: 'Offen',
      invoiceDeliveryStatus: 'pending',
      lastTransferErrorCode: null,
    });
    expect(current.settlement.accounting).toMatchObject({
      provider: 'lexware',
      blockers: [],
      canRetry: false,
      invoice: {
        created: true,
        voucherNumber: invoice.voucherNumber,
        deeplink: `https://app.lexware.de/permalink/invoices/view/${invoice.id}`,
        voucherStatus: 'open',
        paymentStatus: 'open',
        paymentStatusLabel: 'Offen',
        deliveryStatus: 'pending',
        deliveryLabel: 'Versand ausstehend',
        attentionCode: null,
      },
    });
    expect(current.transfer).toMatchObject({
      provider: 'lexware',
      mock: false,
      status: 'succeeded',
    });
    expect(current.mock.isMock).toBe(false);
    const processRow = (
      await ctx.db.select().from(processes).where(eq(processes.id, world.processId))
    )[0]!;
    expect(processRow.mainStatus).toBe('completed');
    // Settlement bleibt gesperrt: keine Positionen mehr änderbar.
    const edit = await post(ctx.app, cookie, `/staff/settlements/${view.settlement.id}/lines`, {
      type: 'manual_charge',
      description: 'Nachträglich',
      amountCents: 100,
      version: current.settlement.version,
    });
    expect(edit.status).toBe(409);
  });

  it('54.–63. Alle Positionstypen aus dem Snapshot (Miete, Lieferung, Kaufartikel, Kommission, Reinigung, Verspätung, Nachbelastung) als custom-Positionen mit Menge/Einzelpreis', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, {
      machineSlug: 'slush-2x10',
      machineCodes: ['MR-10-02-01'],
      fulfillment: 'delivery',
      deliveryPriceCents: 2500,
      selections: [
        { slug: 'sirup-kirsche', role: 'free', quantity: 2 },
        { slug: 'sirup-kirsche', role: 'extra', quantity: 3 },
        { slug: 'mischkanister-6l', role: 'extra', quantity: 2 },
      ],
      returnedUnopened: [{ match: 'Kirsche', quantity: 1 }],
      cleanupMachines: [0],
    });
    const late = await post(ctx.app, cookie, `/staff/settlements/${view.settlement.id}/lines`, {
      type: 'late_fee',
      description: 'Verspätete Rückgabe (2 Tage)',
      amountCents: 3000,
      version: view.settlement.version,
    });
    expect(late.status).toBe(200);
    const manual = await post(ctx.app, cookie, `/staff/settlements/${view.settlement.id}/lines`, {
      type: 'manual_charge',
      description: 'Zusätzliche Sirupflasche',
      amountCents: 1250,
      version: late.body.settlement!.version,
    });
    expect(manual.status).toBe(200);
    const before = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(before.settlement.status).toBe('ready_for_accounting');
    for (const type of [
      'machine_rental',
      'delivery',
      'purchase',
      'commission_consumption',
      'cleanup_fee',
      'late_fee',
      'manual_charge',
    ]) {
      expect(lineOf(before, type).length).toBeGreaterThan(0);
    }
    // Manuelle Positionen ⇒ bewusster manueller Transfer.
    const transfer = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/transfer`,
      { version: before.settlement.version },
    );
    expect(transfer.status).toBe(200);
    expect(transfer.body.outcome).toBe('succeeded');

    const row = await transferRowById(view.settlement.id);
    const payload = row.snapshot as AccountingPayload;
    const snapshot = row.providerSnapshot as ProviderSnapshotV2;
    const body = ctx.lexwareFake!.lastInvoiceBody as {
      lineItems: LexwareLine[];
      totalPrice: Record<string, unknown>;
      taxConditions: { taxType: string };
      shippingConditions: { shippingType: string; shippingDate: string };
      title: string;
      voucherDate: string;
    };
    expect(body.lineItems).toHaveLength(payload.lines.length);
    expect(snapshot.lines).toHaveLength(payload.lines.length);
    for (const [index, line] of payload.lines.entries()) {
      const item = body.lineItems[index]!;
      const mapped = snapshot.lines[index]!;
      expect(item.type).toBe('custom');
      expect(item.name).toBe(line.description);
      expect(item.unitName).toBe(line.unit);
      expect(item.unitPrice.currency).toBe('EUR');
      expect(item.unitPrice.taxRatePercentage).toBe(19);
      expect(cents(item.unitPrice.netAmount) * item.quantity).toBe(line.amountCents);
      expect(mapped.sourceLineId).toBe(line.id);
      expect(mapped.netCents).toBe(line.amountCents);
      expect(mapped.lexwareIndex).toBe(index);
      // Rückführbar: keine internen IDs im Text.
      expect(item.name).not.toContain(line.id);
    }
    const commission = payload.lines.find((line) => line.type === 'commission_consumption')!;
    const commissionItem = body.lineItems[payload.lines.indexOf(commission)]!;
    expect(commissionItem.quantity).toBe(2);
    expect(cents(commissionItem.unitPrice.netAmount)).toBe(1200);
    expect(body.totalPrice).toEqual({ currency: 'EUR' });
    expect(body.taxConditions.taxType).toBe('net');
    expect(body.shippingConditions.shippingType).toBe('service');
    expect(body.shippingConditions.shippingDate.startsWith(payload.eventDate)).toBe(true);
    expect(body.title).toBe('Rechnung');
    expect(body.voucherDate).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000[+-]\d{2}:\d{2}$/);
    const invoice = fakeInvoices(ctx)[0]!;
    expect(cents(invoice.totalPrice.totalNetAmount)).toBe(before.settlement.amountDueCents);
    expect(cents(invoice.totalPrice.totalGrossAmount)).toBe(snapshot.expectedGrossCents);
  });

  it('64./65. Rabatt (Prozent und EUR) als eigene negative Position mit Steuersatz der Miete; Summe cent-genau gegen die Lexware-Rechnung', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const percent = await settledReturn(ctx, admin.id, cookie, {
      fulfillment: 'delivery',
      deliveryPriceCents: 1999,
      discount: { type: 'percent', value: 15 },
      machineCodes: ['MR-10-01-01'],
    });
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const first = fakeInvoices(ctx)[0]!;
    const firstRow = await transferRowById(percent.view.settlement.id);
    const firstSnapshot = firstRow.providerSnapshot as ProviderSnapshotV2;
    const discountLine = lineOf(percent.view, 'discount')[0]!;
    expect(discountLine.amountCents).toBeGreaterThan(0);
    const lexwareDiscount = (first.lineItems as unknown as LexwareLine[]).find(
      (item) => item.unitPrice.netAmount < 0,
    )!;
    expect(cents(lexwareDiscount.unitPrice.netAmount)).toBe(-discountLine.amountCents);
    expect(lexwareDiscount.quantity).toBe(1);
    expect(lexwareDiscount.unitPrice.taxRatePercentage).toBe(19);
    expect(cents(first.totalPrice.totalNetAmount)).toBe(percent.view.settlement.amountDueCents);
    expect(cents(first.totalPrice.totalGrossAmount)).toBe(firstSnapshot.expectedGrossCents);
    expect(cents(first.totalPrice.totalGrossAmount)).toBe(
      (await invoiceMappingFor(ctx, firstRow.id))!.expectedGrossCents,
    );
  });

  it('64./65. EUR-Rabatt exakt als negative Position; Summe cent-genau', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const fixed = await settledReturn(ctx, admin.id, cookie, {
      discount: { type: 'fixed', value: 1234 },
      machineCodes: ['MR-10-01-02'],
    });
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const second = fakeInvoices(ctx)[0]!;
    const secondRow = await transferRowById(fixed.view.settlement.id);
    expect(secondRow.status).toBe('succeeded');
    const secondDiscount = (second.lineItems as unknown as LexwareLine[]).find(
      (item) => item.unitPrice.netAmount < 0,
    )!;
    expect(cents(secondDiscount.unitPrice.netAmount)).toBe(-1234);
    expect(cents(second.totalPrice.totalNetAmount)).toBe(fixed.view.settlement.amountDueCents);
    expect(cents(second.totalPrice.totalGrossAmount)).toBe(
      (secondRow.providerSnapshot as ProviderSnapshotV2).expectedGrossCents,
    );
    expect(fakeInvoices(ctx)).toHaveLength(1);
  });

  it('66./67. Vorgangsnummer im Belegkopf/Remark, stabiler Marker (MRT-…) im Remark und im Mapping – keine UUID, kein JSON', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { view } = await settledReturn(ctx, admin.id, cookie);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const invoice = fakeInvoices(ctx)[0]!;
    const row = await transferRowById(view.settlement.id);
    const marker = transferMarkerFor(row.idempotencyKey);
    expect(marker).toMatch(/^MRT-[0-9A-F]{10}$/);
    expect(invoice.introduction).toContain(view.settlement.processNumber);
    expect(invoice.remark).toBe(
      `Miet-Royal Vorgang ${view.settlement.processNumber} · MR-Transfer: ${marker}`,
    );
    expect(invoice.remark).not.toContain(view.settlement.id);
    expect(invoice.remark).not.toContain('{');
    expect((await invoiceMappingFor(ctx, row.id))!.transferMarker).toBe(marker);
    expect((row.providerSnapshot as ProviderSnapshotV2).transferMarker).toBe(marker);
  });
});

async function transferRowById(settlementId: string) {
  const row = await transferRowForSettlement(ctx, settlementId);
  if (row === null) throw new Error('Transferzeile fehlt');
  return row;
}
