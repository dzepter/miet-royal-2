/**
 * Phase-9-Pflichttests §92/§93 (61, 63–85): Mock-Accounting über die
 * Abrechnung – Payload (Kundensnapshot, Eventdatum, Lines/Summen, stabiler
 * Idempotenzschlüssel), Doppelklick/Worker-Retry ⇒ genau ein Transfer,
 * transiente Fehler mit Retry, Lock nach Transfer, Zahlungsstatus,
 * Prozessabschluss, Reopen ohne Entsperrung, kein Rechnungs-PDF; Concurrency
 * §82 (Doppelklick, Worker vs. manuell).
 */
import { accountingTransfers, documents, processes } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DisabledAccountingGateway,
  settlementTransferIdempotencyKey,
  type AccountingPayload,
} from '../src/accounting/gateway.ts';
import { buildApp } from '../src/app.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { createStaffWithPermissions } from './crm-helpers.ts';
import {
  adminSession,
  post,
  resetSettlementWorld,
  settledReturn,
  settlementViewFor,
} from './settlement-helpers.ts';

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

async function transferRow(settlementId: string) {
  const rows = await ctx.db
    .select()
    .from(accountingTransfers)
    .where(eq(accountingTransfers.settlementId, settlementId));
  return rows[0];
}

describe('Mock-Accounting über die Abrechnung (§92)', () => {
  it('61./65./66./67./68. Dev/Test nutzt Mock; Payload mit Kundensnapshot, Eventdatum, Lines/Summen und stabilem Idempotenzschlüssel', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, {
      discount: { type: 'fixed', value: 500 },
      selections: [{ slug: 'mischkanister-6l', role: 'extra', quantity: 1 }],
    });
    expect(view.mock).toEqual({ isMock: true, controlsAvailable: true });
    expect(view.settlement.accountingBlocker).toBeNull();
    const transfer = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/transfer`,
      { version: view.settlement.version },
    );
    expect(transfer.status).toBe(200);
    expect(transfer.body.outcome).toBe('succeeded');
    const row = (await transferRow(view.settlement.id))!;
    expect(row.idempotencyKey).toBe(settlementTransferIdempotencyKey(view.settlement.id));
    expect(row.provider).toBe('mock');
    const payload = row.snapshot as AccountingPayload;
    expect(payload.kind).toBe('settlement');
    expect(payload.processNumber).toBe(view.settlement.processNumber);
    expect(payload.customer).toMatchObject({
      customerId: world.customerId,
      email: 'klara.kommerz@test.example',
    });
    expect(payload.customer.displayName).toContain('Kommerz');
    expect(payload.eventDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(payload.lines.map((line) => line.type).sort()).toEqual([
      'discount',
      'machine_rental',
      'purchase',
    ]);
    expect(payload.lines.find((line) => line.type === 'discount')!.direction).toBe('credit');
    expect(payload.totals).toEqual({
      chargesCents: 7500,
      creditsCents: 0,
      amountDueCents: 7500,
      overpaymentCents: 0,
    });
    expect(payload.tax).toBeNull();
    expect(payload.idempotencyKey).toBe(row.idempotencyKey);
    expect(ctx.accounting.calls[0]!.idempotencyKey).toBe(row.idempotencyKey);
    const after = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(after.settlement.accountingReference).toMatch(/^MOCK-RE-MR-/);
    expect(after.settlement.accountingProvider).toBe('mock');
    expect(after.transfer).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      mock: true,
      paymentStatus: 'open',
    });
  });

  it('63./64. Disabled-Gateway (Production): keine Übertragung, nie „übertragen“, Blocker „nicht konfiguriert“, kein Job', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie);
    // createAccountingGateway(production) liefert das Disabled-Gateway (accounting-transfer-Test);
    // hier wird dieselbe Instanz in die App injiziert – ohne Production-Secrets im Test.
    const app = buildApp({
      config: ctx.config,
      pool: ctx.pool,
      mailAdapter: ctx.mail,
      rateLimitEnabled: false,
      storage: ctx.storage,
      accountingGateway: new DisabledAccountingGateway(),
      noticeGateway: ctx.notices,
      jobQueue: ctx.queue,
    });
    await app.ready();
    try {
      const get = await app.inject({
        method: 'GET',
        url: `/staff/processes/${world.processId}/settlement`,
        headers: { cookie },
      });
      expect(get.statusCode).toBe(200);
      expect(get.json().settlement.accountingBlocker).toBe('not_configured');
      expect(get.json().settlement.status).toBe('ready_for_accounting');
      expect(get.json().dominantAction.key).toBe('not_configured');
      expect(get.json().mock).toEqual({ isMock: false, controlsAvailable: false });
      const transfer = await app.inject({
        method: 'POST',
        url: `/staff/settlements/${view.settlement.id}/transfer`,
        headers: { cookie },
        payload: { version: get.json().settlement.version },
      });
      expect(transfer.statusCode).toBe(409);
      expect(transfer.json().error.code).toBe('ACCOUNTING_NOT_CONFIGURED');
      expect(transfer.json().error.message).toContain('Buchhaltungsintegration nicht konfiguriert');
    } finally {
      await app.close();
    }
    expect(await transferRow(view.settlement.id)).toBeUndefined();
    const stored = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(stored.settlement.status).not.toBe('transferred');
    expect(stored.settlement.accountingReference).toBeNull();
    expect(ctx.accounting.calls).toHaveLength(0);
  });

  it('69. Doppelklick ⇒ genau ein externer Transfer; zweiter Aufruf sieht already_succeeded', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { view } = await settledReturn(ctx, admin.id, cookie);
    const url = `/staff/settlements/${view.settlement.id}/transfer`;
    const results = await Promise.all([
      post(ctx.app, cookie, url, { version: view.settlement.version }),
      post(ctx.app, cookie, url, { version: view.settlement.version }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.body.outcome).sort()).toEqual(['already_succeeded', 'succeeded']);
    expect(ctx.accounting.calls).toHaveLength(1);
    expect((await transferRow(view.settlement.id))!.attempts).toBe(1);
  });

  it('70./§82 Worker vs. manuell gleichzeitig ⇒ genau ein Transfer; Worker-Wiederholung ⇒ kein zweiter', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { view, world } = await settledReturn(ctx, admin.id, cookie);
    const [manual, worker] = await Promise.all([
      post(ctx.app, cookie, `/staff/settlements/${view.settlement.id}/transfer`, {
        version: view.settlement.version,
      }),
      ctx.jobs.runOnce(),
    ]);
    expect(manual.status).toBe(200);
    expect(['succeeded', 'already_succeeded']).toContain(manual.body.outcome);
    expect(worker).toBe('processed');
    expect(ctx.accounting.calls).toHaveLength(1);
    // Erneuter Worker-Lauf (at-least-once) ⇒ nichts passiert erneut.
    await ctx.pool.query(
      `UPDATE integration_jobs SET status = 'pending', run_at = now() - interval '1 minute', locked_at = NULL, locked_by = NULL, lease_expires_at = NULL`,
    );
    expect(await ctx.jobs.runOnce()).toBe('processed');
    expect(ctx.accounting.calls).toHaveLength(1);
    const after = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(after.settlement.status).toBe('transferred');
    expect((await transferRow(view.settlement.id))!.externalReference).toBe(
      ctx.accounting.calls[0]!.externalReference,
    );
  });

  it('71./72. Transienter Fehler ⇒ transfer_failed mit neutralem Code, Beträge gesperrt, Retry (Queue-Backoff/manuell) ⇒ transferred', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { view, world } = await settledReturn(ctx, admin.id, cookie);
    ctx.accounting.failNext(1);
    expect(await ctx.jobs.runOnce()).toBe('failed');
    let current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('transfer_failed');
    expect(current.settlement.statusLabel).toBe(
      'Übertragung an Buchhaltung fehlgeschlagen – wird erneut versucht',
    );
    expect(current.settlement.lastTransferErrorCode).toBe('TRANSIENT');
    expect(current.settlement.locked).toBe(true);
    expect(current.dominantAction.key).toBe('retry_transfer');
    expect(current.transfer).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastErrorCode: 'TRANSIENT',
    });
    // Beträge ab Vorbereitung gesperrt (Vertrag §2).
    const edit = await post(ctx.app, cookie, `/staff/settlements/${current.settlement.id}/lines`, {
      type: 'manual_charge',
      description: 'Nachträglich',
      amountCents: 100,
      version: current.settlement.version,
    });
    expect(edit.status).toBe(409);
    expect(edit.body.error?.code).toBe('TRANSFER_PREPARED');
    // Queue hat den Job mit Backoff neu geplant (kein Dead-Job, kein Doppel-Transfer).
    const job = await ctx.pool.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM integration_jobs WHERE type = 'settlement.accounting_transfer'`,
    );
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0]).toMatchObject({ status: 'pending', attempts: 1 });
    // Manueller Retry gelingt, derselbe Snapshot/Idempotenzschlüssel.
    const retry = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/transfer`,
      { version: current.settlement.version },
    );
    expect(retry.status).toBe(200);
    expect(retry.body.outcome).toBe('succeeded');
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('transferred');
    expect(current.settlement.lastTransferErrorCode).toBeNull();
    expect(ctx.accounting.calls).toHaveLength(1);
    expect((await transferRow(view.settlement.id))!.attempts).toBe(2);
    // Der noch anstehende Queue-Retry sieht already_succeeded.
    await ctx.pool.query(`UPDATE integration_jobs SET run_at = now() - interval '1 minute'`);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    expect(ctx.accounting.calls).toHaveLength(1);
  });

  it('73./74./75./76./77./78. Transfer sperrt und ist immutable; Zahlungsstatus open → paid/overdue via Mock; kein Rechnungs-PDF', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { view, world } = await settledReturn(ctx, admin.id, cookie, { cleanupMachines: [0] });
    const transfer = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/transfer`,
      { version: view.settlement.version },
    );
    expect(transfer.status).toBe(200);
    let current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('transferred');
    expect(current.settlement.paymentStatus).toBe('open');
    expect(current.settlement.paymentStatusLabel).toBe('Offen');
    expect(current.lines.every((line) => !line.editable && !line.removable)).toBe(true);
    expect(current.dominantAction).toMatchObject({
      key: 'locked',
      label: 'An Buchhaltung übertragen',
    });
    const cleanup = current.lines.find((line) => line.type === 'cleanup_fee')!;
    for (const attempt of [
      post(
        ctx.app,
        cookie,
        `/staff/settlements/${current.settlement.id}/lines/${cleanup.id}`,
        { amountCents: 1, version: current.settlement.version },
        'PATCH',
      ),
      post(ctx.app, cookie, `/staff/settlements/${current.settlement.id}/lines`, {
        type: 'late_fee',
        description: 'x',
        amountCents: 1,
        version: current.settlement.version,
      }),
      post(ctx.app, cookie, `/staff/settlements/${current.settlement.id}/customer-response`, {
        version: current.settlement.version,
      }),
      post(ctx.app, cookie, `/staff/settlements/${current.settlement.id}/end-wait`, {
        version: current.settlement.version,
      }),
      post(ctx.app, cookie, `/staff/bookings/${world.bookingId}/advance-payments`, {
        amountCents: 100,
        receivedAt: '2026-10-01',
      }),
    ]) {
      const result = await attempt;
      expect(result.status).toBe(409);
      expect(result.body.error?.code).toBe('SETTLEMENT_LOCKED');
    }
    const transferId = current.transfer!.id;
    for (const status of ['paid', 'overdue', 'open'] as const) {
      const set = await ctx.app.inject({
        method: 'POST',
        url: '/staff/accounting/mock/payment-status',
        headers: { cookie },
        payload: { transferId, status },
      });
      expect(set.statusCode).toBe(200);
      current = await settlementViewFor(ctx.app, cookie, world.processId);
      expect(current.settlement.paymentStatus).toBe(status);
      expect(current.settlement.paymentStatusLabel).toBe(
        { paid: 'Bezahlt', overdue: 'Überfällig', open: 'Offen' }[status],
      );
      expect(current.settlement.status).toBe('transferred');
    }
    const docs = await ctx.db
      .select()
      .from(documents)
      .where(eq(documents.processId, world.processId));
    const types: string[] = docs.map((doc) => doc.type);
    expect(types).not.toContain('invoice');
    expect(types).toEqual(expect.arrayContaining(['return_protocol']));
  });
});

describe('Prozessabschluss und Reopen (§93)', () => {
  it('79./80./81. Regulärer Transfer ⇒ Vorgang abgeschlossen (Zahlung offen hindert nicht); 7-Tage-Sichtbarkeit für Mitarbeiter', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { view, world } = await settledReturn(ctx, admin.id, cookie);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const process = (
      await ctx.db.select().from(processes).where(eq(processes.id, world.processId))
    )[0]!;
    expect(process.mainStatus).toBe('completed');
    expect(process.completedAt).not.toBeNull();
    const current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.paymentStatus).toBe('open');
    expect(current.settlement.status).toBe('transferred');
    const staff = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Normale',
      lastName: 'Mitarbeiterin',
      email: 'normal@test.example',
      password: 'normal-passwort-12345',
      permissionKeys: ['process.view_all', 'settlement.view'],
    });
    const visible = await ctx.app.inject({
      method: 'GET',
      url: `/staff/settlements/${view.settlement.id}`,
      headers: { cookie: staff.cookie },
    });
    expect(visible.statusCode).toBe(200);
    expect(visible.json().settlement.accountingReference).toBeNull();
    expect(visible.json().settlement.accountingReferenceVisible).toBe(false);
  });

  it('83./84./85. Admin-Reopen verändert Snapshot nicht, entsperrt nicht; erneutes Schließen ⇒ kein zweiter Transfer', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { view, world } = await settledReturn(ctx, admin.id, cookie);
    await post(ctx.app, cookie, `/staff/settlements/${view.settlement.id}/transfer`, {
      version: view.settlement.version,
    });
    const before = (await transferRow(view.settlement.id))!;
    const reopen = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/reopen`,
      headers: { cookie },
    });
    expect(reopen.statusCode).toBe(200);
    const process = (
      await ctx.db.select().from(processes).where(eq(processes.id, world.processId))
    )[0]!;
    expect(process.mainStatus).toBe('reopened');
    const current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('transferred');
    expect(current.settlement.locked).toBe(true);
    const edit = await post(ctx.app, cookie, `/staff/settlements/${current.settlement.id}/lines`, {
      type: 'manual_charge',
      description: 'Nach Reopen',
      amountCents: 100,
      version: current.settlement.version,
    });
    expect(edit.status).toBe(409);
    expect(edit.body.error?.code).toBe('SETTLEMENT_LOCKED');
    const again = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/transfer`,
      { version: current.settlement.version },
    );
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe('already_succeeded');
    const complete = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/complete`,
      headers: { cookie },
    });
    expect(complete.statusCode).toBe(200);
    const after = (await transferRow(view.settlement.id))!;
    expect(after.snapshotHash).toBe(before.snapshotHash);
    expect(after.snapshot).toEqual(before.snapshot);
    expect(after.attempts).toBe(before.attempts);
    expect(ctx.accounting.calls).toHaveLength(1);
    expect(ctx.notices.sent).toHaveLength(0);
  });
});
