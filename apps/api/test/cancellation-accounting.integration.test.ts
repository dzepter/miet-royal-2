/**
 * Phase-9-Pflichttests 111–113, 119–121 (Order §§94/95) sowie §§59–61:
 * Worker-Transfer der Stornorechnung (Mock), Zahlungsstatus über die
 * Mock-Steuerung, Fehlschlag/Retry, Doppelstorno und Double-Submit
 * idempotent, Referenz nur mit Recht, Stornobestätigung über Outbox.
 */
import {
  accountingTransfers,
  cancellations,
  integrationJobs,
  processes,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { drainAllJobs } from './settlement-helpers.ts';
import {
  adminSession,
  bookedProcess,
  cancelBooking,
  cancellationServicesFor,
  resetForCancellationTests,
  staffWith,
} from './cancellation-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetForCancellationTests(ctx);
});

async function storedCancellation(id: string) {
  return (await ctx.db.select().from(cancellations).where(eq(cancellations.id, id)))[0]!;
}

async function cancellationView(cookie: string, processId: string) {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/staff/processes/${processId}/cancellation`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, unknown>;
}

describe('111.–113. Automatischer Mock-Transfer und Zahlungsstatus', () => {
  it('111. Worker überträgt genau einmal ⇒ Stornorechnung offen, MOCK-Referenz, Zahlungsstatus offen', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    const view = await cancelBooking(ctx, admin.id, world.processId);
    expect(view.financeStatus).toBe('accounting_pending');
    expect(await ctx.jobs.runOnce()).toBe('processed');
    expect(await ctx.jobs.runOnce()).toBe('idle');
    expect(ctx.accounting.calls).toHaveLength(1);
    expect(ctx.accounting.calls[0]).toMatchObject({
      kind: 'cancellation',
      attempt: 1,
      amountDueCents: 3750,
      idempotencyKey: `cancellation-transfer:${view.id}`,
    });
    const stored = await storedCancellation(view.id);
    expect(stored.financeStatus).toBe('invoice_open');
    expect(stored.paymentStatus).toBe('open');
    expect(stored.accountingProvider).toBe('mock');
    expect(stored.accountingReference).toMatch(/^MOCK-STORNO-/);
    expect(stored.transferredAt).not.toBeNull();
    expect(stored.lastTransferErrorCode).toBeNull();
    const transfer = (await ctx.db.select().from(accountingTransfers))[0]!;
    expect(transfer.status).toBe('succeeded');
    expect(transfer.attempts).toBe(1);
    const body = await cancellationView(cookie, world.processId);
    expect(body).toMatchObject({
      financeStatus: 'invoice_open',
      financeStatusLabel: 'Stornorechnung offen',
      paymentStatus: 'open',
      paymentStatusLabel: 'Offen',
      accountingReferenceVisible: true,
      transfer: { status: 'succeeded', attempts: 1, provider: 'mock', mock: true },
      permissions: { canManualTransfer: false, canViewReference: true },
    });
    expect(body.accountingReference).toMatch(/^MOCK-STORNO-/);
  });

  it('112./113. Mock setzt „bezahlt“ ⇒ Stornorechnung bezahlt; Vorgang bleibt storniert (nie abgeschlossen)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 2 });
    const view = await cancelBooking(ctx, admin.id, world.processId);
    await drainAllJobs(ctx);
    const transfer = (await ctx.db.select().from(accountingTransfers))[0]!;
    const paid = await ctx.app.inject({
      method: 'POST',
      url: '/staff/accounting/mock/payment-status',
      headers: { cookie },
      payload: { transferId: transfer.id, status: 'paid' },
    });
    expect(paid.statusCode).toBe(200);
    const stored = await storedCancellation(view.id);
    expect(stored.financeStatus).toBe('paid');
    expect(stored.paymentStatus).toBe('paid');
    const body = await cancellationView(cookie, world.processId);
    expect(body).toMatchObject({
      financeStatusLabel: 'Stornorechnung bezahlt',
      paymentStatusLabel: 'Bezahlt',
    });
    const process = (
      await ctx.db.select().from(processes).where(eq(processes.id, world.processId))
    )[0]!;
    expect(process.mainStatus).toBe('cancelled');
    expect(process.completedAt).toBeNull();
    // Überfällig ⇒ wieder „Stornorechnung offen“ mit Zahlungsstatus überfällig.
    await ctx.app.inject({
      method: 'POST',
      url: '/staff/accounting/mock/payment-status',
      headers: { cookie },
      payload: { transferId: transfer.id, status: 'overdue' },
    });
    expect(await storedCancellation(view.id)).toMatchObject({
      financeStatus: 'invoice_open',
      paymentStatus: 'overdue',
    });
  });

  it('Transient-Fehler ⇒ bleibt ausstehend mit Fehlercode, Job geht in den Backoff; manuelle Übertragung (lexware.manual_transfer) holt nach', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    const view = await cancelBooking(ctx, admin.id, world.processId);
    ctx.accounting.failNext(1, 'TRANSIENT');
    expect(await ctx.jobs.runOnce()).toBe('failed');
    let stored = await storedCancellation(view.id);
    expect(stored.financeStatus).toBe('accounting_pending');
    expect(stored.lastTransferErrorCode).toBe('TRANSIENT');
    const job = (await ctx.db.select().from(integrationJobs))[0]!;
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(1);
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now());
    expect(ctx.accounting.calls).toHaveLength(0);
    const body = await cancellationView(cookie, world.processId);
    expect(body).toMatchObject({
      lastTransferErrorCode: 'TRANSIENT',
      transfer: { status: 'failed', attempts: 1, lastErrorCode: 'TRANSIENT' },
      permissions: { canManualTransfer: true },
    });

    const manual = await ctx.app.inject({
      method: 'POST',
      url: `/staff/cancellations/${view.id}/transfer`,
      headers: { cookie },
      payload: {},
    });
    expect(manual.statusCode).toBe(200);
    expect(manual.json()).toMatchObject({
      outcome: 'succeeded',
      cancellation: { financeStatus: 'invoice_open', lastTransferErrorCode: null },
    });
    stored = await storedCancellation(view.id);
    expect(stored.financeStatus).toBe('invoice_open');
    expect(ctx.accounting.calls).toHaveLength(1);
    // Der später fällige Queue-Job überträgt NICHT erneut (recheck in der Sperre).
    await ctx.db.update(integrationJobs).set({ runAt: new Date(Date.now() - 1000) });
    expect(await ctx.jobs.runOnce()).toBe('processed');
    expect(ctx.accounting.calls).toHaveLength(1);
    expect((await ctx.db.select().from(accountingTransfers))[0]!.attempts).toBe(2);
  });

  it('Manuelle Übertragung ohne Recht ⇒ 403; ohne Rechnung (0 %) ⇒ 409', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    const paidView = await cancelBooking(ctx, admin.id, paid.processId);
    const limited = await staffWith(ctx, admin.id, ['process.view_all'], 'Lena');
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/staff/cancellations/${paidView.id}/transfer`,
      headers: { cookie: limited.cookie },
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    const free = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const freeView = await cancelBooking(ctx, admin.id, free.processId);
    const nothing = await ctx.app.inject({
      method: 'POST',
      url: `/staff/cancellations/${freeView.id}/transfer`,
      headers: { cookie },
      payload: {},
    });
    expect(nothing.statusCode).toBe(409);
    expect(ctx.accounting.calls).toHaveLength(0);
  });
});

describe('119.–121. Idempotenz', () => {
  it('119./121. Doppelstorno ist idempotent: dieselbe Stornierung, eine Transferzeile, ein Job, keine zweite Belastung', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    const first = await cancelBooking(ctx, admin.id, world.processId);
    const second = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/cancellation`,
      headers: { cookie },
      payload: { confirm: true },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.id);
    expect(await ctx.db.select().from(cancellations)).toHaveLength(1);
    expect(await ctx.db.select().from(accountingTransfers)).toHaveLength(1);
    expect(await ctx.db.select().from(integrationJobs)).toHaveLength(1);
    await drainAllJobs(ctx);
    expect(ctx.accounting.calls).toHaveLength(1);
    // Nach Übertragung: erneutes Storno ändert nichts an der Rechnung.
    const third = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/cancellation`,
      headers: { cookie },
      payload: { confirm: true },
    });
    expect(third.statusCode).toBe(200);
    expect(third.json()).toMatchObject({ id: first.id, financeStatus: 'invoice_open' });
    expect(ctx.accounting.calls).toHaveLength(1);
  });

  it('120. Double-Submit der manuellen Übertragung ⇒ genau eine externe Übertragung (succeeded + already_succeeded)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    const view = await cancelBooking(ctx, admin.id, world.processId);
    const submit = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/staff/cancellations/${view.id}/transfer`,
        headers: { cookie },
        payload: {},
      });
    const [a, b] = await Promise.all([submit(), submit()]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const outcomes = [a.json().outcome, b.json().outcome].sort();
    expect(outcomes).toEqual(['already_succeeded', 'succeeded']);
    expect(ctx.accounting.calls).toHaveLength(1);
    // Service-Doppelaufruf parallel: ebenfalls genau ein Transfer.
    const { service } = cancellationServicesFor(ctx);
    const results = await Promise.all([
      service.executeTransfer(view.id),
      service.executeTransfer(view.id),
    ]);
    expect(results.every((r) => r.outcome === 'already_succeeded')).toBe(true);
    expect(ctx.accounting.calls).toHaveLength(1);
    expect((await ctx.db.select().from(accountingTransfers))[0]!.status).toBe('succeeded');
    // Worker-Job danach: kein zweiter Transfer.
    await drainAllJobs(ctx);
    expect(ctx.accounting.calls).toHaveLength(1);
  });
});

describe('Referenzrecht und Bestätigung (§§59/61)', () => {
  it('Buchhaltungsreferenz nur mit accounting.view_reference; sonst null bei sichtbarem Status', async () => {
    const { admin } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    await cancelBooking(ctx, admin.id, world.processId);
    await drainAllJobs(ctx);
    const viewer = await staffWith(ctx, admin.id, ['process.view_all'], 'Vera');
    const hidden = await cancellationView(viewer.cookie, world.processId);
    expect(hidden).toMatchObject({
      financeStatus: 'invoice_open',
      accountingReference: null,
      accountingReferenceVisible: false,
      cancelerStaffId: null,
    });
    expect((hidden.transfer as Record<string, unknown>).externalReference).toBeNull();
    expect(JSON.stringify(hidden)).not.toContain('MOCK-STORNO');
    const reader = await staffWith(
      ctx,
      admin.id,
      ['process.view_all', 'accounting.view_reference', 'process.reopen_completed'],
      'Rita',
    );
    const visible = await cancellationView(reader.cookie, world.processId);
    expect(visible.accountingReference).toMatch(/^MOCK-STORNO-/);
    expect(visible.cancelerStaffId).toBe(admin.id);
  });

  it('Stornobestätigung: vorbereitet ⇒ Versand über Outbox (email.approve_prepared), zweiter Versand ist ein No-op; auch bei 0 % erlaubt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const view = await cancelBooking(ctx, admin.id, world.processId);
    expect(view.confirmationStatus).toBe('prepared');
    expect(view.permissions.canSendConfirmation).toBe(true);
    const limited = await staffWith(ctx, admin.id, ['process.view_all'], 'Nora');
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/staff/cancellations/${view.id}/confirmation/send`,
      headers: { cookie: limited.cookie },
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    const sent = await ctx.app.inject({
      method: 'POST',
      url: `/staff/cancellations/${view.id}/confirmation/send`,
      headers: { cookie },
      payload: {},
    });
    expect(sent.statusCode).toBe(200);
    // Phase 12: bewusste Aktion reiht ein (queued); „sent“ erst nach bestätigtem Mailversand.
    expect(sent.json().confirmationStatus).toBe('queued');
    await drainAllJobs(ctx);
    const stored = await storedCancellation(view.id);
    expect(stored.confirmationStatus).toBe('sent');
    expect(stored.confirmationSentAt).not.toBeNull();
    expect(stored.confirmationMailDeliveryId).not.toBeNull();
    expect(stored.confirmationGatewayReference).toMatch(/^<.+@.+>$/);
    expect(ctx.mailGateway.sent.filter((m) => m.subject.includes('Storno'))).toHaveLength(1);
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/staff/cancellations/${view.id}/confirmation/send`,
      headers: { cookie },
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().confirmationSentAt).toBe(stored.confirmationSentAt!.toISOString());
    expect(ctx.mail.sent).toHaveLength(0);
    const after = await cancellationView(cookie, world.processId);
    expect(after.permissions).toMatchObject({ canSendConfirmation: false });
  });
});
