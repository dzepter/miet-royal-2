/**
 * Phase-10-Pflichttests Idempotenz/Unknown-Outcome 88–98 (Order §§32/34/35/
 * 59/60/83; Vertrag §6): Doppelklick, zwei unabhängige Serviceinstanzen,
 * Worker-Retry ⇒ je genau eine Rechnung; Timeout VOR dem Create ⇒ Retry;
 * Timeout NACH dem Create ⇒ outcome_unknown ⇒ Recovery verbindet dieselbe
 * Rechnung; kein Treffer ⇒ Create erlaubt; mehrere ⇒ attention; Schlüssel/
 * Marker stabil; disabled-Zeile übernommen; erfolgreicher Mock nicht neu.
 */
import { accountingTransfers } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProcessService } from '../src/crm/process-service.ts';
import { transferMarkerFor } from '../src/lexware/invoice-builder.ts';
import { SettlementService } from '../src/settlement/settlement-service.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  failNext,
  fakeInvoices,
  fakeRequests,
  invoiceMappingFor,
  makeJobsDue,
  readyLexware,
  resetLexwareWorld,
  syntheticTax,
  transferRowForSettlement,
  transferSettlement,
} from './lexware-test-helpers.ts';
import {
  adminSession,
  settledReturn,
  settlementServiceFor,
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

/** Unabhängige Serviceinstanz (eigene Transfer-Boundary, eigener Worker-Name) auf demselben Pool/Fake. */
function independentService(workerId: string): SettlementService {
  return new SettlementService({
    db: ctx.db,
    transfers: ctx.transfersFor(workerId),
    notices: ctx.transactional.noticeMailer,
    queue: ctx.queue,
    processes: new ProcessService(ctx.db),
    appEnv: ctx.config.appEnv,
  });
}

async function jobStatus() {
  const rows = await ctx.pool.query<{ status: string; attempts: number }>(
    `SELECT status, attempts FROM integration_jobs WHERE type = 'settlement.accounting_transfer' ORDER BY created_at`,
  );
  return rows.rows;
}

describe('Idempotenz und Unknown-Outcome (Tests 88–98)', () => {
  it('88. Doppelklick auf „Jetzt übertragen“ ⇒ genau eine Lexware-Rechnung; zweiter Aufruf succeeded/skipped/already_succeeded', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { view } = await settledReturn(ctx, admin.id, cookie);
    const results = await Promise.all([
      transferSettlement(ctx.app, cookie, view.settlement.id, view.settlement.version),
      transferSettlement(ctx.app, cookie, view.settlement.id, view.settlement.version),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const outcomes = results.map((r) => r.body.outcome).sort();
    expect(outcomes).toContain('succeeded');
    expect(fakeInvoices(ctx)).toHaveLength(1);
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(1);
    const row = (await transferRowForSettlement(ctx, view.settlement.id))!;
    expect(row.status).toBe('succeeded');
    expect(row.claimedBy).toBeNull();
  });

  it('89. Zwei unabhängige Serviceinstanzen (eigene Worker) übertragen gleichzeitig ⇒ eine Rechnung; Worker-Wiederholung ⇒ nichts Neues', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { view, world } = await settledReturn(ctx, admin.id, cookie);
    const a = independentService('worker-a');
    const b = independentService('worker-b');
    const [ra, rb, job] = await Promise.all([
      a.runAutoTransfer(view.settlement.id),
      b.runAutoTransfer(view.settlement.id),
      ctx.jobs.runOnce(),
    ]);
    expect(['processed', 'idle']).toContain(job);
    const outcomes = [ra.outcome, rb.outcome];
    expect(outcomes.filter((o) => o === 'succeeded').length).toBeLessThanOrEqual(1);
    expect(fakeInvoices(ctx)).toHaveLength(1);
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(1);
    // Erneuter Worker-Lauf (at-least-once): kein zweiter Create.
    await ctx.pool.query(
      `UPDATE integration_jobs SET status = 'pending', run_at = now() - interval '1 minute', locked_at = NULL, locked_by = NULL, lease_expires_at = NULL`,
    );
    expect(await ctx.jobs.runOnce()).toBe('processed');
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(1);
    const after = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(after.settlement.status).toBe('transferred');
    expect(after.settlement.accountingReference).toBe(fakeInvoices(ctx)[0]!.voucherNumber);
  });

  it('90./91. Transienter Fehler (500) und Timeout VOR dem Create ⇒ failed/transient, Queue-Retry ⇒ danach genau eine Rechnung', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { view, world } = await settledReturn(ctx, admin.id, cookie);
    await failNext(ctx, { match: '^POST /v1/invoices$', status: 500 });
    expect(await ctx.jobs.runOnce()).toBe('failed');
    let row = (await transferRowForSettlement(ctx, view.settlement.id))!;
    expect(row).toMatchObject({ status: 'failed', lastErrorCode: 'LEXWARE_SERVER', attempts: 1 });
    let current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('transfer_failed');
    expect(current.settlement.lastTransferErrorCode).toBe('LEXWARE_SERVER');
    expect(current.settlement.accounting.canRetry).toBe(true);
    expect((await jobStatus())[0]).toMatchObject({ status: 'pending', attempts: 1 });

    // Timeout vor dem Create (Kontaktabgleich hängt) ⇒ transient, KEIN outcome_unknown.
    await ctx.pool.query(`UPDATE lexware_contact_mappings SET last_synced_hash = NULL`);
    await failNext(ctx, { match: '^GET /v1/contacts/', mode: 'hang' });
    await makeJobsDue(ctx);
    expect(await ctx.jobs.runOnce()).toBe('failed');
    row = (await transferRowForSettlement(ctx, view.settlement.id))!;
    expect(row.status).toBe('failed');
    expect(row.lastErrorCode).toBe('LEXWARE_TIMEOUT');
    expect(fakeInvoices(ctx)).toHaveLength(0);

    await makeJobsDue(ctx);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    row = (await transferRowForSettlement(ctx, view.settlement.id))!;
    expect(row.status).toBe('succeeded');
    expect(row.attempts).toBe(3);
    expect(fakeInvoices(ctx)).toHaveLength(1);
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('transferred');
  });

  it('92./94./95. Timeout NACH dem Create ⇒ outcome_unknown (kein blinder zweiter Create); Recovery verbindet dieselbe Rechnung; Schlüssel/Marker stabil', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { view, world } = await settledReturn(ctx, admin.id, cookie);
    await failNext(ctx, { match: '^POST /v1/invoices$', mode: 'after_create' });
    expect(await ctx.jobs.runOnce()).toBe('failed');
    let row = (await transferRowForSettlement(ctx, view.settlement.id))!;
    expect(row.status).toBe('outcome_unknown');
    expect(row.lastErrorCode).toBe('LEXWARE_TIMEOUT');
    expect(row.externalReference).toBeNull();
    expect(row.claimedBy).toBeNull();
    expect(fakeInvoices(ctx)).toHaveLength(1);
    let current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('transfer_failed');
    expect(current.settlement.accounting.invoice.created).toBe(false);
    expect(current.settlement.accounting.canRetry).toBe(true);
    const marker = transferMarkerFor(row.idempotencyKey);
    const mappingBefore = (await invoiceMappingFor(ctx, row.id))!;
    expect(mappingBefore.transferMarker).toBe(marker);
    expect(mappingBefore.lexwareInvoiceId).toBeNull();

    // Manueller Retry ⇒ ZUERST Recovery über die Belegliste ⇒ dieselbe Rechnung, kein zweiter POST.
    const retry = await transferSettlement(
      ctx.app,
      cookie,
      view.settlement.id,
      current.settlement.version,
    );
    expect(retry.status).toBe(200);
    expect(retry.body.outcome).toBe('succeeded');
    expect(fakeInvoices(ctx)).toHaveLength(1);
    expect(fakeRequests(ctx, 'GET', '/v1/voucherlist')).toHaveLength(1);
    const invoice = fakeInvoices(ctx)[0]!;
    row = (await transferRowForSettlement(ctx, view.settlement.id))!;
    expect(row).toMatchObject({
      status: 'succeeded',
      externalReference: invoice.voucherNumber,
      idempotencyKey: `settlement-transfer:${view.settlement.id}`,
    });
    const mapping = (await invoiceMappingFor(ctx, row.id))!;
    expect(mapping.lexwareInvoiceId).toBe(invoice.id);
    expect(mapping.transferMarker).toBe(marker);
    expect(invoice.remark).toContain(marker);
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('transferred');
    // Anstehender Queue-Retry: already_succeeded, kein weiterer Create.
    await makeJobsDue(ctx);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(0);
    expect(fakeInvoices(ctx)).toHaveLength(1);
  });

  it('93. outcome_unknown ohne Treffer in Lexware ⇒ Recovery findet nichts ⇒ Create wird erneut zugelassen (genau eine Rechnung)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { view } = await settledReturn(ctx, admin.id, cookie);
    await failNext(ctx, { match: '^POST /v1/invoices$', mode: 'after_create' });
    expect(await ctx.jobs.runOnce()).toBe('failed');
    // Die verschluckte Rechnung ist bei Lexware tatsächlich nicht entstanden.
    ctx.lexwareFake!.invoices.clear();
    await makeJobsDue(ctx);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const row = (await transferRowForSettlement(ctx, view.settlement.id))!;
    expect(row.status).toBe('succeeded');
    expect(fakeRequests(ctx, 'GET', '/v1/voucherlist')).toHaveLength(1);
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(1);
    expect(fakeInvoices(ctx)).toHaveLength(1);
  });

  it('96. Mehrere Kandidaten mit Marker und Summe ⇒ attention RECOVERY_AMBIGUOUS, kein Create, manueller Abgleich', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { view, world } = await settledReturn(ctx, admin.id, cookie);
    await failNext(ctx, { match: '^POST /v1/invoices$', mode: 'after_create' });
    expect(await ctx.jobs.runOnce()).toBe('failed');
    const original = fakeInvoices(ctx)[0]!;
    ctx.lexwareFake!.invoices.set(`${original.id.slice(0, -4)}dead`, {
      ...original,
      id: `${original.id.slice(0, -4)}dead`,
      voucherNumber: 'RE-DOPPELT',
    });
    await makeJobsDue(ctx);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const row = (await transferRowForSettlement(ctx, view.settlement.id))!;
    expect(row.status).toBe('attention');
    expect(row.attentionCode).toBe('RECOVERY_AMBIGUOUS');
    expect(row.lastErrorCode).toBe('RECOVERY_AMBIGUOUS');
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(0);
    const current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('transfer_failed');
    expect(current.settlement.lastTransferErrorCode).toBe('RECOVERY_AMBIGUOUS');
    expect(current.settlement.accounting.invoice.attentionCode).toBe('RECOVERY_AMBIGUOUS');
    expect(current.settlement.accounting.invoice.attentionLabel).toBe(
      'Lexware-Abgleich erforderlich',
    );
    expect(current.settlement.accounting.canRetry).toBe(false);
    // Kein automatischer zweiter Versuch, kein Create.
    const retry = await transferSettlement(
      ctx.app,
      cookie,
      view.settlement.id,
      current.settlement.version,
    );
    expect(retry.body.outcome).toBe('failed');
    expect(retry.body.errorCode).toBe('RECOVERY_AMBIGUOUS');
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(0);
    expect((await jobStatus()).every((job) => job.status === 'succeeded')).toBe(true);
  });

  it('Summenabweichung nach dem Create ⇒ attention TOTAL_MISMATCH, Rechnung verbunden, kein zweiter Create', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { view, world } = await settledReturn(ctx, admin.id, cookie);
    const service = independentService('mismatch');
    // Fake liefert eine abweichende Summe: Beleg nach dem Create serverseitig um 1 Cent verändern.
    const fake = ctx.lexwareFake!;
    const originalSet = fake.invoices.set.bind(fake.invoices);
    fake.invoices.set = (id, invoice) => {
      invoice.totalPrice = {
        ...invoice.totalPrice,
        totalGrossAmount: invoice.totalPrice.totalGrossAmount + 0.01,
      };
      return originalSet(id, invoice);
    };
    try {
      const result = await service.runAutoTransfer(view.settlement.id);
      expect(result.outcome).toBe('failed');
      expect(result.errorCode).toBe('TOTAL_MISMATCH');
      expect(result.transient).toBe(false);
    } finally {
      fake.invoices.set = originalSet;
    }
    const row = (await transferRowForSettlement(ctx, view.settlement.id))!;
    expect(row.status).toBe('attention');
    expect(row.attentionCode).toBe('TOTAL_MISMATCH');
    const mapping = (await invoiceMappingFor(ctx, row.id))!;
    expect(mapping.lexwareInvoiceId).toBe(fakeInvoices(ctx)[0]!.id);
    expect(mapping.attentionCode).toBe('TOTAL_MISMATCH');
    const current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.locked).toBe(true);
    expect(current.settlement.accounting.invoice.attentionLabel).toBe(
      'Summenabweichung – Buchhaltungsprüfung erforderlich',
    );
    expect(current.settlement.accounting.invoice.deeplink).toContain(mapping.lexwareInvoiceId);
    await ctx.jobs.drain();
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(1);
  });

  it('97. Bestehende disabled-Transferzeile (nie extern gebucht) wird vom Lexware-Provider übernommen – keine zweite Zeile', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { view, world } = await settledReturn(ctx, admin.id, cookie);
    // Zeile wie in production mit Disabled-Provider vorbereitet (pending, ohne externe Referenz).
    const mockService = settlementServiceFor(ctx);
    ctx.accounting.failNext(1);
    await mockService.runAutoTransfer(view.settlement.id);
    await ctx.db
      .update(accountingTransfers)
      .set({ provider: 'disabled', status: 'pending', lastErrorCode: null })
      .where(eq(accountingTransfers.settlementId, view.settlement.id));
    await ctx.pool.query(
      `UPDATE settlements SET accounting_provider = 'disabled', last_transfer_error_code = NULL WHERE id = $1`,
      [view.settlement.id],
    );
    let current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.accountingProvider).toBe('disabled');
    expect(current.transfer?.provider).toBe('disabled');
    const before = (await transferRowForSettlement(ctx, view.settlement.id))!;
    await makeJobsDue(ctx);
    await ctx.jobs.drain();
    const rows = await ctx.db
      .select()
      .from(accountingTransfers)
      .where(eq(accountingTransfers.settlementId, view.settlement.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: before.id,
      provider: 'lexware',
      status: 'succeeded',
      idempotencyKey: before.idempotencyKey,
      snapshotHash: before.snapshotHash,
    });
    expect(fakeInvoices(ctx)).toHaveLength(1);
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.accountingProvider).toBe('lexware');
    expect(current.settlement.status).toBe('transferred');
  });

  it('B1. Recovery-Lauf scheitert transient ⇒ Status bleibt outcome_unknown; nächster Lauf: kein zweiter POST; View zeigt „Lexware-Übertragung prüfen“ + Retry', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { view, world } = await settledReturn(ctx, admin.id, cookie);
    await failNext(ctx, { match: '^POST /v1/invoices$', mode: 'after_create' });
    expect(await ctx.jobs.runOnce()).toBe('failed');
    let current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('transfer_failed');
    expect(current.settlement.statusLabel).toBe('Lexware-Übertragung prüfen');
    expect(current.dominantAction).toMatchObject({
      key: 'retry_transfer',
      label: 'Lexware-Übertragung erneut versuchen',
    });
    expect(current.settlement.lastTransferErrorCode).toBe('LEXWARE_TIMEOUT');
    // Recovery (Belegliste) scheitert transient ⇒ bleibt outcome_unknown.
    await failNext(ctx, { match: '^GET /v1/voucherlist$', status: 500 });
    await makeJobsDue(ctx);
    expect(await ctx.jobs.runOnce()).toBe('failed');
    let row = (await transferRowForSettlement(ctx, view.settlement.id))!;
    expect(row.status).toBe('outcome_unknown');
    expect(row.lastErrorCode).toBe('LEXWARE_SERVER');
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(0);
    // Abgelaufener in_progress-Claim ⇒ ebenfalls Recovery-Pflicht, auch bei Blockern.
    await ctx.pool.query(
      `UPDATE accounting_transfers SET status = 'in_progress', claimed_by = 'tot', claimed_at = now() - interval '1 hour', claim_expires_at = now() - interval '30 minutes'`,
    );
    await ctx.pool.query(`DELETE FROM accounting_tax_config WHERE category = 'delivery'`);
    await makeJobsDue(ctx);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    row = (await transferRowForSettlement(ctx, view.settlement.id))!;
    expect(row.status).toBe('outcome_unknown');
    expect(row.lastErrorCode).toBe('TAX_CONFIG_INCOMPLETE');
    await syntheticTax(ctx, admin.id);
    // Nächster Lauf: Recovery findet die Rechnung ⇒ verbunden, kein POST.
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    const retry = await transferSettlement(
      ctx.app,
      cookie,
      view.settlement.id,
      current.settlement.version,
    );
    expect(retry.body.outcome).toBe('succeeded');
    expect(fakeInvoices(ctx)).toHaveLength(1);
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(0);
  });

  it('B2. Fehler NACH dem Create (403 auf GET invoice) ⇒ outcome_unknown mit bekannter Invoice-ID; Retry verbindet dieselbe Rechnung per GET', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { view, world } = await settledReturn(ctx, admin.id, cookie);
    await failNext(ctx, { match: '^GET /v1/invoices/', status: 403 });
    expect(await ctx.jobs.runOnce()).toBe('failed');
    const row = (await transferRowForSettlement(ctx, view.settlement.id))!;
    expect(row.status).toBe('outcome_unknown');
    expect(row.lastErrorCode).toBe('LEXWARE_FORBIDDEN');
    const invoice = fakeInvoices(ctx)[0]!;
    expect((await invoiceMappingFor(ctx, row.id))!.lexwareInvoiceId).toBe(invoice.id);
    const current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('transfer_failed');
    const retry = await transferSettlement(
      ctx.app,
      cookie,
      view.settlement.id,
      current.settlement.version,
    );
    expect(retry.body.outcome).toBe('succeeded');
    expect(fakeRequests(ctx, 'GET', '/v1/voucherlist')).toHaveLength(0);
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(1);
    expect(fakeInvoices(ctx)).toHaveLength(1);
    expect((await transferRowForSettlement(ctx, view.settlement.id))!.externalReference).toBe(
      invoice.voucherNumber,
    );
  });

  it('B9. Aktiver Claim eines anderen Workers ⇒ Job übersprungen und zum Claim-Ablauf neu eingereiht (kein Fehler, kein Create); View „Übertragung geplant“', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { view, world } = await settledReturn(ctx, admin.id, cookie);
    // Zeile vorbereiten (Blocker ⇒ failed), dann fremden aktiven Claim simulieren.
    await ctx.pool.query(`DELETE FROM accounting_tax_config WHERE category = 'delivery'`);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    await syntheticTax(ctx, admin.id);
    const expires = new Date(Date.now() + 5 * 60 * 1000);
    await ctx.pool.query(
      `UPDATE accounting_transfers SET status = 'in_progress', claimed_by = 'anderer-worker', claimed_at = now(), claim_expires_at = $1`,
      [expires],
    );
    const current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.accounting.canRetry).toBe(false);
    const manual = await transferSettlement(
      ctx.app,
      cookie,
      view.settlement.id,
      current.settlement.version,
    );
    expect(manual.body.outcome).toBe('skipped');
    await ctx.pool.query(`UPDATE integration_jobs SET status = 'succeeded'`);
    await ctx.queue.enqueue(
      'settlement.accounting_transfer',
      { settlementId: view.settlement.id, reason: 'retry' },
      { idempotencyKey: `b9:${view.settlement.id}` },
    );
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const jobs = await ctx.pool.query<{ status: string; run_at: Date }>(
      `SELECT status, run_at FROM integration_jobs WHERE status = 'pending' AND type = 'settlement.accounting_transfer'`,
    );
    expect(jobs.rows).toHaveLength(1);
    expect(Math.abs(jobs.rows[0]!.run_at.getTime() - expires.getTime())).toBeLessThan(1000);
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(0);
  });

  it('98. Erfolgreich per Mock übertragene Zeile wird nicht erneut an Lexware übertragen (already_succeeded)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { view } = await settledReturn(ctx, admin.id, cookie);
    const mockService = settlementServiceFor(ctx);
    const mockResult = await mockService.runAutoTransfer(view.settlement.id);
    expect(mockResult.outcome).toBe('succeeded');
    const before = (await transferRowForSettlement(ctx, view.settlement.id))!;
    expect(before.provider).toBe('mock');
    const retry = await transferSettlement(ctx.app, cookie, view.settlement.id, 1);
    expect(retry.status).toBe(200);
    expect(retry.body.outcome).toBe('already_succeeded');
    await makeJobsDue(ctx);
    await ctx.jobs.drain();
    const after = (await transferRowForSettlement(ctx, view.settlement.id))!;
    expect(after).toMatchObject({
      provider: 'mock',
      status: 'succeeded',
      externalReference: before.externalReference,
    });
    expect(fakeInvoices(ctx)).toHaveLength(0);
    expect(fakeRequests(ctx, 'POST', '/v1/')).toHaveLength(0);
  });
});
