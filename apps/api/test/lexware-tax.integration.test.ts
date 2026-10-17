/**
 * Phase-10-Pflichttests Steuern 43–51 (Order §13/§14/§62/§80; Vertrag §4):
 * keine Produktionsdefaults, kein hartkodierter Satz, fehlende Behandlung
 * blockiert, synthetische Werte nur außerhalb production, jede Position
 * klassifiziert, Profil-Plausibilität, Rabatt mit Steuerquelle, Snapshot
 * unveränderlich.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TaxConfigService } from '../src/lexware/tax-config-service.ts';
import { stableStringify, type ProviderSnapshotV2 } from '../src/lexware/invoice-builder.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  connectLexware,
  fakeControl,
  fakeInvoices,
  fakeRequests,
  jsonGet,
  jsonPost,
  readyLexware,
  resetLexwareWorld,
  syntheticTax,
  taxConfigFor,
  transferRowForSettlement,
} from './lexware-test-helpers.ts';
import { adminSession, settledReturn, settlementViewFor } from './settlement-helpers.ts';

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

interface TaxConfigBody {
  taxType: string | null;
  categories: {
    category: string;
    label: string;
    treatment: string;
    taxRateBp: number;
    synthetic: boolean;
  }[];
  complete: boolean;
  missing: string[];
  synthetic: boolean;
  syntheticAllowed: boolean;
  hint: string;
}

describe('Steuerkonfiguration (Tests 43–51)', () => {
  it('43. Keine Produktionsdefaults: leere Konfiguration ist unvollständig; synthetische Zeilen zählen in production nicht', async () => {
    const { admin } = await adminSession(ctx);
    const service = taxConfigFor(ctx);
    expect(await service.isComplete()).toMatchObject({ complete: false, synthetic: false });
    expect((await service.isComplete()).missing).toContain('taxType');
    await syntheticTax(ctx, admin.id);
    expect(await service.isComplete()).toMatchObject({ complete: true, synthetic: true });
    // Dieselbe Datenbank aus Sicht einer production-Instanz: synthetisch ⇒ unvollständig.
    const production = new TaxConfigService(ctx.db, 'production');
    const result = await production.isComplete();
    expect(result.complete).toBe(false);
    expect(result.missing).toContain('machine_rental');
    await expect(production.applySyntheticDefaults(admin.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('46. Synthetische Werte über die Route (system.settings) ⇒ vollständig, klar als SYNTHETISCH markiert, Hinweistext', async () => {
    const { cookie } = await adminSession(ctx);
    const before = await jsonGet<TaxConfigBody>(ctx.app, cookie, '/staff/accounting/tax-config');
    expect(before.status).toBe(200);
    expect(before.body.complete).toBe(false);
    expect(before.body.categories).toEqual([]);
    expect(before.body.hint).toBe(
      'Steuerkonfiguration vor Produktivbetrieb mit Buchhaltung/Steuerberatung prüfen.',
    );
    const applied = await jsonPost<TaxConfigBody>(
      ctx.app,
      cookie,
      '/staff/accounting/tax-config/synthetic',
    );
    expect(applied.status).toBe(200);
    expect(applied.body.complete).toBe(true);
    expect(applied.body.synthetic).toBe(true);
    expect(applied.body.taxType).toBe('net');
    expect(applied.body.categories).toHaveLength(10);
    expect(applied.body.categories.every((row) => row.synthetic)).toBe(true);
    expect(applied.body.categories.find((row) => row.category === 'machine_rental')?.label).toBe(
      'Maschinenmiete',
    );
  });

  it('PUT validiert strikt: vatfree ⇒ 0 %, unbekannte Kategorie 400, gespeicherte Zeilen sind nicht synthetisch', async () => {
    const { cookie } = await adminSession(ctx);
    const bad = await jsonPost<{ error: { code: string } }>(
      ctx.app,
      cookie,
      '/staff/accounting/tax-config',
      {
        taxType: 'net',
        categories: [{ category: 'fantasie', treatment: 'taxable', taxRateBp: 1900 }],
      },
      'PUT',
    );
    expect(bad.status).toBe(400);
    const extra = await jsonPost<{ error: { code: string } }>(
      ctx.app,
      cookie,
      '/staff/accounting/tax-config',
      { taxType: 'net', categories: [], rate: 19 },
      'PUT',
    );
    expect(extra.status).toBe(400);
    const vatfreeWithRate = await jsonPost<{ error: { code: string } }>(
      ctx.app,
      cookie,
      '/staff/accounting/tax-config',
      {
        taxType: 'net',
        categories: [{ category: 'delivery', treatment: 'vatfree', taxRateBp: 700 }],
      },
      'PUT',
    );
    expect(vatfreeWithRate.status).toBe(400);
    const ok = await jsonPost<TaxConfigBody>(
      ctx.app,
      cookie,
      '/staff/accounting/tax-config',
      {
        taxType: 'net',
        categories: [
          { category: 'machine_rental', treatment: 'taxable', taxRateBp: 700 },
          { category: 'delivery', treatment: 'vatfree', taxRateBp: 0 },
        ],
      },
      'PUT',
    );
    expect(ok.status).toBe(200);
    expect(ok.body.complete).toBe(false);
    expect(ok.body.synthetic).toBe(false);
    expect(ok.body.categories).toHaveLength(2);
    expect(ok.body.categories.every((row) => !row.synthetic)).toBe(true);
    expect(ok.body.missing).toContain('purchase');
    expect(ok.body.missing).not.toContain('taxType');
  });

  it('45. Fehlende Behandlung für EINE Position ⇒ Transfer blockiert (TAX_CONFIG_INCOMPLETE), kein Lexware-Aufruf, Blocker in der View', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    await taxConfigFor(ctx).removeCategory('machine_rental');
    const { world } = await settledReturn(ctx, admin.id, cookie);
    const before = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(before.settlement.accounting.provider).toBe('lexware');
    expect(before.settlement.accounting.blockers.map((b) => b.code)).toContain(
      'TAX_CONFIG_INCOMPLETE',
    );
    expect(before.settlement.accounting.blockers[0]?.label).toBe(
      'Steuerkonfiguration für Buchhaltung unvollständig',
    );
    expect(before.settlement.accounting.blockers[0]?.action).toBeTruthy();
    // Permanenter Blocker: Job wird ohne Endlos-Retry beendet.
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const view = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(view.settlement.status).toBe('transfer_failed');
    expect(view.settlement.lastTransferErrorCode).toBe('TAX_CONFIG_INCOMPLETE');
    expect(view.settlement.accounting.canRetry).toBe(true);
    expect(view.settlement.accounting.retryLabel).toBe('Lexware-Übertragung erneut versuchen');
    expect(view.dominantAction.label).toBe('Lexware-Übertragung prüfen');
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(0);
    expect(fakeRequests(ctx, 'POST', '/v1/contacts')).toHaveLength(0);
    const jobs = await ctx.pool.query<{ status: string }>(
      `SELECT status FROM integration_jobs WHERE type = 'settlement.accounting_transfer'`,
    );
    expect(jobs.rows.every((row) => row.status === 'succeeded')).toBe(true);
  });

  it('44./47./49. Satz kommt ausschließlich aus der Konfiguration (7 %), jede Position klassifiziert, Rabatt trägt den Satz der Maschinenmiete', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await connectLexware(ctx);
    await taxConfigFor(ctx).update(admin.id, {
      taxType: 'net',
      categories: [
        { category: 'machine_rental', treatment: 'taxable', taxRateBp: 700 },
        { category: 'delivery', treatment: 'taxable', taxRateBp: 1900 },
        { category: 'purchase', treatment: 'taxable', taxRateBp: 1900 },
        { category: 'commission_consumption', treatment: 'taxable', taxRateBp: 1900 },
        { category: 'cleanup_fee', treatment: 'taxable', taxRateBp: 1900 },
        { category: 'damage_charge', treatment: 'taxable', taxRateBp: 1900 },
        { category: 'missing_item_charge', treatment: 'taxable', taxRateBp: 1900 },
        { category: 'late_fee', treatment: 'taxable', taxRateBp: 1900 },
        { category: 'manual_charge', treatment: 'taxable', taxRateBp: 1900 },
        { category: 'cancellation_charge', treatment: 'taxable', taxRateBp: 1900 },
      ],
    });
    const { world, view } = await settledReturn(ctx, admin.id, cookie, {
      fulfillment: 'delivery',
      deliveryPriceCents: 2000,
      discount: { type: 'percent', value: 10 },
    });
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const after = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(after.settlement.status).toBe('transferred');
    const row = await transferRowForSettlement(ctx, view.settlement.id);
    const snapshot = row!.providerSnapshot as ProviderSnapshotV2;
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.taxType).toBe('net');
    for (const line of snapshot.lines) expect(line.category).toBeTruthy();
    const rental = snapshot.lines.find((line) => line.sourceType === 'machine_rental')!;
    const delivery = snapshot.lines.find((line) => line.sourceType === 'delivery')!;
    const discount = snapshot.lines.find((line) => line.sourceType === 'discount')!;
    expect(rental.taxRateBp).toBe(700);
    expect(delivery.taxRateBp).toBe(1900);
    expect(discount.taxRateBp).toBe(700);
    expect(discount.category).toBe('machine_rental');
    expect(discount.amountCents).toBeLessThan(0);
    const body = ctx.lexwareFake!.lastInvoiceBody as {
      lineItems: { unitPrice: { taxRatePercentage: number; netAmount: number } }[];
    };
    const rates = body.lineItems.map((item) => item.unitPrice.taxRatePercentage);
    expect(rates).toContain(7);
    expect(rates).toContain(19);
    expect(body.lineItems.some((item) => item.unitPrice.netAmount < 0)).toBe(true);
    // Summe cent-genau gegen die Fake-Rechnung (7 % auf Miete/Rabatt, 19 % auf Lieferung).
    const invoice = fakeInvoices(ctx)[0]!;
    expect(Math.round(invoice.totalPrice.totalGrossAmount * 100)).toBe(snapshot.expectedGrossCents);
    expect(Math.round(invoice.totalPrice.totalNetAmount * 100)).toBe(snapshot.expectedNetCents);
    expect(snapshot.expectedNetCents).toBe(view.settlement.amountDueCents);
  });

  it('48. Profil-Plausibilität: Lexware taxType gross vs. Config net ⇒ TAX_TYPE_MISMATCH; Kleinunternehmer ohne vatfree ⇒ blockiert', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await fakeControl(ctx, 'profile', { taxType: 'gross' });
    await readyLexware(ctx, admin.id);
    const { world } = await settledReturn(ctx, admin.id, cookie);
    let view = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(view.settlement.accounting.blockers.map((b) => b.code)).toEqual(['TAX_TYPE_MISMATCH']);
    expect(view.settlement.accounting.blockers[0]?.label).toBe(
      'Steuerkonfiguration passt nicht zum Lexware-Profil',
    );
    expect(await ctx.jobs.runOnce()).toBe('processed');
    view = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(view.settlement.lastTransferErrorCode).toBe('TAX_TYPE_MISMATCH');
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(0);

    await fakeControl(ctx, 'profile', { taxType: 'net', smallBusiness: true });
    await connectLexware(ctx);
    view = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(view.settlement.accounting.blockers.map((b) => b.code)).toEqual(['TAX_TYPE_MISMATCH']);

    // Übereinstimmung ⇒ Blocker weg, Retry gelingt.
    await fakeControl(ctx, 'profile', { taxType: 'net', smallBusiness: false });
    await connectLexware(ctx);
    view = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(view.settlement.accounting.blockers).toEqual([]);
  });

  it('51. Tax-Snapshot ist nach dem Transfer unveränderlich; Phase-9-Snapshot (v1) bleibt unberührt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { world, view } = await settledReturn(ctx, admin.id, cookie);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const after = await transferRowForSettlement(ctx, view.settlement.id);
    expect(after!.status).toBe('succeeded');
    const v1 = after!.snapshot as { schemaVersion: number; tax: unknown };
    expect(v1.schemaVersion).toBe(1);
    expect(v1.tax).toBeNull();
    expect(v1).toMatchObject({
      idempotencyKey: after!.idempotencyKey,
      sourceId: view.settlement.id,
    });
    const frozen = after!.providerSnapshot as ProviderSnapshotV2;
    expect(frozen.taxConfigSnapshot.machine_rental).toMatchObject({
      taxRateBp: 1900,
      synthetic: true,
    });
    await taxConfigFor(ctx).update(admin.id, {
      taxType: 'net',
      categories: [{ category: 'machine_rental', treatment: 'taxable', taxRateBp: 700 }],
    });
    const later = await transferRowForSettlement(ctx, view.settlement.id);
    expect(later!.providerSnapshot).toEqual(frozen);
    expect(stableStringify(later!.snapshot)).toBe(stableStringify(after!.snapshot));
    expect(later!.providerSnapshotHash).toBe(after!.providerSnapshotHash);
    const settlementView = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(settlementView.settlement.status).toBe('transferred');
  });
});
