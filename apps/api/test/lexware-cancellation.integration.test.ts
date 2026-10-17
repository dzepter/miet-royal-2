/**
 * Phase-10-Pflichttests Storno 76–87 (Order §§29/30/65/82; Vertrag §6):
 * kostenpflichtiges Storno ⇒ genau EINE finale Stornokosten-Rechnung mit
 * einer Position, klassifiziert als cancellation_charge; 0 % ⇒ keine
 * Rechnung; Zahlungsstatus bleibt am Storno (cancelled bleibt); Reopen
 * erzeugt keine zweite Rechnung; Retry idempotent.
 */
import { processes } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { syncLexwareInvoice } from '../src/lexware/invoice-sync.ts';
import type { ProviderSnapshotV2 } from '../src/lexware/invoice-builder.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  adminSession,
  bookedProcess,
  cancelBooking,
  cancellationServicesFor,
} from './cancellation-helpers.ts';
import {
  fakeControl,
  fakeInvoices,
  fakeRequests,
  invoiceMappingFor,
  jsonGet,
  jsonPost,
  readyLexware,
  resetLexwareWorld,
  transferRowForCancellation,
} from './lexware-test-helpers.ts';

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

interface CancellationBody {
  id: string;
  financeStatus: string;
  financeStatusLabel: string;
  paymentStatus: string | null;
  paymentStatusLabel: string | null;
  accountingProvider: string | null;
  accountingReference: string | null;
  lastTransferErrorCode: string | null;
  invoiceDeliveryStatus: string | null;
  customerId: string;
  accounting: {
    provider: string;
    blockers: { code: string; label: string }[];
    invoice: {
      created: boolean;
      voucherNumber: string | null;
      deeplink: string | null;
      paymentStatus: string | null;
      deliveryStatus: string | null;
      attentionCode: string | null;
    };
    canRetry: boolean;
    retryLabel: string;
  };
  transfer: { status: string; provider: string } | null;
}

async function cancellationView(cookie: string, processId: string) {
  const result = await jsonGet<CancellationBody>(
    ctx.app,
    cookie,
    `/staff/processes/${processId}/cancellation`,
  );
  expect(result.status).toBe(200);
  return result.body;
}

describe('Stornokosten-Rechnung (Tests 76–87)', () => {
  it('76.–81. 50 %-Storno ⇒ genau eine finale Stornokosten-Rechnung mit einer Position (cancellation_charge), Vorgangsnummer, Storno bleibt cancelled', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    const view = await cancelBooking(ctx, admin.id, world.processId);
    expect(view.financeStatus).toBe('accounting_pending');
    expect(view.feeCents).toBe(3750);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    expect(await ctx.jobs.runOnce()).toBe('idle');

    const invoices = fakeInvoices(ctx);
    expect(invoices).toHaveLength(1);
    const invoice = invoices[0]!;
    expect(invoice.voucherStatus).toBe('open');
    expect(invoice.lineItems).toHaveLength(1);
    const item = invoice.lineItems[0] as {
      name: string;
      quantity: number;
      unitPrice: { netAmount: number; taxRatePercentage: number };
    };
    expect(item.name).toContain('Stornokosten');
    expect(item.name).toContain(world.processNumber);
    expect(item.quantity).toBe(1);
    expect(Math.round(item.unitPrice.netAmount * 100)).toBe(3750);
    expect(item.unitPrice.taxRatePercentage).toBe(19);
    expect(invoice.title).toBe('Stornokosten');
    expect(invoice.introduction).toContain(world.processNumber);
    expect(invoice.introduction).toContain('50 %');
    expect(invoice.remark).toContain(`Miet-Royal Vorgang ${world.processNumber}`);
    expect(invoice.remark).toMatch(/MR-Transfer: MRT-[0-9A-F]{10}/);
    expect(Math.round(invoice.totalPrice.totalNetAmount * 100)).toBe(3750);

    const row = (await transferRowForCancellation(ctx, view.id))!;
    expect(row).toMatchObject({ status: 'succeeded', provider: 'lexware', paymentStatus: 'open' });
    const snapshot = row.providerSnapshot as ProviderSnapshotV2;
    expect(snapshot.lines).toHaveLength(1);
    expect(snapshot.lines[0]).toMatchObject({ category: 'cancellation_charge', taxRateBp: 1900 });
    expect(snapshot.lines[0]!.grossCents).toBe(
      Math.round(invoice.totalPrice.totalGrossAmount * 100),
    );
    // Leistungsdatum = Stornodatum (Berliner Kalendertag), nicht das Eventdatum.
    expect(snapshot.shippingDate).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000[+-]\d{2}:\d{2}$/);
    expect(snapshot.shippingDate.slice(0, 10)).not.toBe(view.eventDate);
    const mapping = (await invoiceMappingFor(ctx, row.id))!;
    expect(mapping).toMatchObject({
      lexwareInvoiceId: invoice.id,
      voucherNumber: invoice.voucherNumber,
      paymentStatus: 'open',
      deliveryStatus: 'pending',
    });

    const body = await cancellationView(cookie, world.processId);
    expect(body).toMatchObject({
      financeStatus: 'invoice_open',
      paymentStatus: 'open',
      paymentStatusLabel: 'Offen',
      accountingProvider: 'lexware',
      accountingReference: invoice.voucherNumber,
      invoiceDeliveryStatus: 'pending',
      customerId: world.customerId,
      accounting: {
        provider: 'lexware',
        blockers: [],
        canRetry: false,
        invoice: {
          created: true,
          voucherNumber: invoice.voucherNumber,
          deeplink: `https://app.lexware.de/permalink/invoices/view/${invoice.id}`,
          paymentStatus: 'open',
          deliveryStatus: 'pending',
          attentionCode: null,
        },
      },
      transfer: { status: 'succeeded', provider: 'lexware' },
    });
    const processRow = (
      await ctx.db.select().from(processes).where(eq(processes.id, world.processId))
    )[0]!;
    expect(processRow.mainStatus).toBe('cancelled');
  });

  it('82. 0 %-Storno ⇒ keine Rechnung, kein 0-EUR-Beleg, kein Lexware-Aufruf', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 20 });
    const view = await cancelBooking(ctx, admin.id, world.processId);
    expect(view.financeStatus).toBe('no_invoice');
    expect(view.feeCents).toBe(0);
    expect(await ctx.jobs.runOnce()).toBe('idle');
    expect(fakeInvoices(ctx)).toHaveLength(0);
    expect(fakeRequests(ctx, 'POST', '/v1/')).toHaveLength(0);
    const body = await cancellationView(cookie, world.processId);
    expect(body.financeStatusLabel).toBe('Storniert – ohne Rechnung');
    expect(body.accounting.invoice.created).toBe(false);
    expect(body.accounting.canRetry).toBe(false);
    expect(await transferRowForCancellation(ctx, view.id)).toBeNull();
  });

  it('83./84./85. Zahlungsstatus am Storno: bezahlt ⇒ „bezahlt“, Hauptstatus bleibt cancelled; überfällig ohne Verlust von cancelled', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 3 });
    const view = await cancelBooking(ctx, admin.id, world.processId);
    expect(view.feeCents).toBe(7500);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const row = (await transferRowForCancellation(ctx, view.id))!;
    const mapping = (await invoiceMappingFor(ctx, row.id))!;
    const transfers = ctx.transfersFor();

    await fakeControl(ctx, 'invoice-due-date', {
      invoiceId: mapping.lexwareInvoiceId,
      dueDate: '2020-01-01T00:00:00.000Z',
    });
    let sync = await syncLexwareInvoice(ctx.lexware, ctx.db, transfers, mapping.id);
    expect(sync.outcome).toBe('updated');
    let body = await cancellationView(cookie, world.processId);
    expect(body.paymentStatus).toBe('overdue');
    expect(body.paymentStatusLabel).toBe('Überfällig');
    expect(body.financeStatus).toBe('invoice_open');

    await fakeControl(ctx, 'invoice-paid', { invoiceId: mapping.lexwareInvoiceId });
    sync = await syncLexwareInvoice(ctx.lexware, ctx.db, transfers, mapping.id);
    expect(sync.outcome).toBe('updated');
    body = await cancellationView(cookie, world.processId);
    expect(body.financeStatus).toBe('paid');
    expect(body.financeStatusLabel).toBe('Stornorechnung bezahlt');
    expect(body.paymentStatus).toBe('paid');
    expect(body.accounting.invoice.paymentStatus).toBe('paid');
    const processRow = (
      await ctx.db.select().from(processes).where(eq(processes.id, world.processId))
    )[0]!;
    expect(processRow.mainStatus).toBe('cancelled');
  });

  it('86./87. Retry/Doppelstorno/Reopen: nie eine zweite Stornorechnung; manuelle Übertragung nach Erfolg ⇒ already_succeeded', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    const view = await cancelBooking(ctx, admin.id, world.processId);
    const submit = () =>
      jsonPost<{ outcome: string }>(ctx.app, cookie, `/staff/cancellations/${view.id}/transfer`);
    const [a, b] = await Promise.all([submit(), submit()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const outcomes = [a.body.outcome, b.body.outcome].sort();
    expect(outcomes[1]).toBe('succeeded');
    expect(['already_succeeded', 'skipped']).toContain(outcomes[0]);
    expect(fakeInvoices(ctx)).toHaveLength(1);
    const again = await submit();
    expect(again.body.outcome).toBe('already_succeeded');
    // Worker-Job danach und Service-Doppelaufruf: nichts Neues.
    await ctx.jobs.drain();
    const { service } = cancellationServicesFor(ctx);
    const results = await Promise.all([
      service.executeTransfer(view.id),
      service.executeTransfer(view.id),
    ]);
    expect(results.every((r) => r.outcome === 'already_succeeded')).toBe(true);
    expect(fakeInvoices(ctx)).toHaveLength(1);
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(1);
    const body = await cancellationView(cookie, world.processId);
    expect(body.accounting.canRetry).toBe(false);
  });
});
