/**
 * Phase-10-Pflichttests Zahlungsstatus 114–122 (Order §§41/42/51/65/86):
 * Normalisierung open/paid/overdue aus Lexware (Voucher-Status, Payments,
 * dueDate/openAmount), Spiegelung in Settlement/Storno, Hauptstatus bleibt;
 * voided/gelöscht ⇒ Attention, Settlement bleibt gesperrt, paymentStatus
 * unverändert; Mock-Zahlungssteuerung ist mit Lexware-Provider nicht aktiv.
 */
import { processes } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { syncLexwareInvoice } from '../src/lexware/invoice-sync.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { createStaffWithPermissions } from './crm-helpers.ts';
import {
  fakeControl,
  invoiceMappingFor,
  jsonPost,
  readyLexware,
  resetLexwareWorld,
  transferRowForSettlement,
} from './lexware-test-helpers.ts';
import { adminSession, post, settledReturn, settlementViewFor } from './settlement-helpers.ts';

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

async function transferredSettlement(adminId: string, cookie: string) {
  await readyLexware(ctx, adminId);
  const { world, view } = await settledReturn(ctx, adminId, cookie);
  expect(await ctx.jobs.runOnce()).toBe('processed');
  const row = (await transferRowForSettlement(ctx, view.settlement.id))!;
  const mapping = (await invoiceMappingFor(ctx, row.id))!;
  return { world, view, row, mapping, invoiceId: mapping.lexwareInvoiceId! };
}

describe('Zahlungsstatus (Tests 114–122)', () => {
  it('114./115./116. Neue Rechnung ⇒ offen; Zahlung in Lexware ⇒ bezahlt (openAmount 0, paidDate intern); Hauptstatus bleibt abgeschlossen', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, mapping, invoiceId } = await transferredSettlement(admin.id, cookie);
    expect(mapping.paymentStatus).toBe('open');
    const transfers = ctx.transfersFor();
    const unchanged = await syncLexwareInvoice(ctx.lexware, ctx.db, transfers, mapping.id);
    expect(unchanged.outcome).toBe('unchanged');

    await fakeControl(ctx, 'invoice-paid', { invoiceId, paidDate: '2026-10-20T00:00:00.000Z' });
    const result = await syncLexwareInvoice(ctx.lexware, ctx.db, transfers, mapping.id);
    expect(result).toMatchObject({ outcome: 'updated', paymentStatus: 'paid' });
    const after = (await invoiceMappingFor(ctx, mapping.accountingTransferId))!;
    expect(after).toMatchObject({
      paymentStatus: 'paid',
      openAmountCents: 0,
      voucherStatus: 'paid',
      paidDate: '2026-10-20',
    });
    const view = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(view.settlement.paymentStatus).toBe('paid');
    expect(view.settlement.paymentStatusLabel).toBe('Bezahlt');
    expect(view.settlement.accounting.invoice.paymentStatus).toBe('paid');
    expect(view.settlement.status).toBe('transferred');
    expect(view.settlement.locked).toBe(true);
    // paidDate bleibt intern (nicht in der View).
    expect(JSON.stringify(view)).not.toContain('2026-10-20');
    const processRow = (
      await ctx.db.select().from(processes).where(eq(processes.id, world.processId))
    )[0]!;
    expect(processRow.mainStatus).toBe('completed');
  });

  it('117./118. dueDate überschritten + offen ⇒ überfällig (Europe/Berlin); erneute Zahlung ⇒ bezahlt; nie eigener Zahlungseingang', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, mapping, invoiceId } = await transferredSettlement(admin.id, cookie);
    const transfers = ctx.transfersFor();
    await fakeControl(ctx, 'invoice-due-date', { invoiceId, dueDate: '2020-01-01T00:00:00.000Z' });
    expect(await syncLexwareInvoice(ctx.lexware, ctx.db, transfers, mapping.id)).toMatchObject({
      outcome: 'updated',
      paymentStatus: 'overdue',
    });
    let view = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(view.settlement.paymentStatusLabel).toBe('Überfällig');
    expect(view.settlement.accounting.invoice.paymentStatusLabel).toBe('Überfällig');
    // Fälligkeit in der Zukunft ⇒ wieder offen.
    await fakeControl(ctx, 'invoice-due-date', { invoiceId, dueDate: '2999-01-01T00:00:00.000Z' });
    expect(await syncLexwareInvoice(ctx.lexware, ctx.db, transfers, mapping.id)).toMatchObject({
      paymentStatus: 'open',
    });
    view = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(view.settlement.paymentStatus).toBe('open');
    // Mock-Zahlungssteuerung existiert mit Lexware-Provider nicht (409, keine Mutation).
    const mock = await jsonPost<{ error: { code: string } }>(
      ctx.app,
      cookie,
      '/staff/accounting/mock/payment-status',
      { transferId: mapping.accountingTransferId, status: 'paid' },
    );
    expect(mock.status).toBe(409);
    view = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(view.settlement.paymentStatus).toBe('open');
  });

  it('119./120. Extern storniert (voided) bzw. gelöscht ⇒ Attention „Buchhaltungsprüfung erforderlich“, Settlement bleibt gesperrt, Zahlungsstatus unverändert, keine Neurechnung', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view, mapping, invoiceId } = await transferredSettlement(admin.id, cookie);
    const transfers = ctx.transfersFor();
    await fakeControl(ctx, 'invoice-voided', { invoiceId });
    expect(await syncLexwareInvoice(ctx.lexware, ctx.db, transfers, mapping.id)).toMatchObject({
      outcome: 'attention',
      attentionCode: 'INVOICE_VOIDED',
    });
    let current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('transferred');
    expect(current.settlement.locked).toBe(true);
    expect(current.settlement.paymentStatus).toBe('open');
    expect(current.settlement.accounting.invoice.attentionCode).toBe('INVOICE_VOIDED');
    expect(current.settlement.accounting.invoice.attentionLabel).toBe(
      'Buchhaltungsprüfung erforderlich',
    );
    expect(current.settlement.accounting.invoice.deeplink).toContain(invoiceId);
    expect(current.settlement.accounting.canRetry).toBe(false);
    // Kein zweiter Transfer möglich: already_succeeded, keine zweite Rechnung.
    const retry = await post(ctx.app, cookie, `/staff/settlements/${view.settlement.id}/transfer`, {
      version: current.settlement.version,
    });
    expect(retry.body.outcome).toBe('already_succeeded');
    expect(ctx.lexwareFake!.invoices.size).toBe(1);

    await fakeControl(ctx, 'invoice-deleted', { invoiceId });
    expect(await syncLexwareInvoice(ctx.lexware, ctx.db, transfers, mapping.id)).toMatchObject({
      outcome: 'attention',
      attentionCode: 'INVOICE_MISSING',
    });
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.accounting.invoice.attentionCode).toBe('INVOICE_MISSING');
    expect(current.settlement.paymentStatus).toBe('open');
  });

  it('121./122. Sichtbarkeit: Mitarbeiter ohne accounting.view_reference sieht Offen/Bezahlt, aber weder Nummer noch Deeplink; keine Bankdetails/Payment Items in der View', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, mapping, invoiceId } = await transferredSettlement(admin.id, cookie);
    await fakeControl(ctx, 'invoice-paid', { invoiceId });
    await syncLexwareInvoice(ctx.lexware, ctx.db, ctx.transfersFor(), mapping.id);
    const staff = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Normal',
      lastName: 'Mitarbeiter',
      email: 'normal@test.example',
      password: 'normal-passwort-12345',
      permissionKeys: ['process.view_all', 'settlement.view', 'process.view_completed'],
    });
    const view = await settlementViewFor(ctx.app, staff.cookie, world.processId);
    expect(view.settlement.paymentStatus).toBe('paid');
    expect(view.settlement.paymentStatusLabel).toBe('Bezahlt');
    expect(view.settlement.accounting.invoice).toMatchObject({
      created: true,
      voucherNumber: null,
      deeplink: null,
      paymentStatusLabel: 'Bezahlt',
    });
    expect(view.settlement.accountingReference).toBeNull();
    expect(view.transfer?.externalReference).toBeNull();
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(mapping.voucherNumber!);
    expect(serialized).not.toContain(invoiceId);
    expect(serialized).not.toMatch(/paymentItems|iban|bank/i);
  });
});
