/**
 * Phase-9-Pflichttests §87 (1–14) und 26: Settlement-Basis aus eingefrorenen
 * Fakten – genau ein Settlement je finalisierter Rückgabe, Miete/Lieferung/
 * Rabatt aus dem Buchungs-Snapshot, Kaufartikel aus der tatsächlichen
 * Ausgabe, Kommission/Reinigung aus den Phase-7-Fakten, keine Preislogik
 * mit aktuellen Produktpreisen, Cent-Arithmetik, keine doppelten Positionen.
 */
import { randomUUID } from 'node:crypto';
import { products, rentalReturns, settlementLines, settlements } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { productServiceFor } from './commerce-helpers.ts';
import { DAYS, pngBytes } from './handover-helpers.ts';
import { offlineHelpers, type MutationInput } from './offline-helpers.ts';
import { issuedBooking, readyReturn } from './return-helpers.ts';
import {
  adminSession,
  finalizedReturn,
  issuedBookingWithOptions,
  lineOf,
  resetSettlementWorld,
  settledReturn,
  settlementServiceFor,
  settlementViewFor,
} from './settlement-helpers.ts';

let ctx: TestContext;
const h = offlineHelpers(() => ctx);

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetSettlementWorld(ctx);
});

describe('Settlement-Basis (§87)', () => {
  it('1. Finalisierter Return ⇒ genau ein Settlement (über den Finalisierungs-Hook)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await finalizedReturn(ctx, admin.id, cookie);
    const rows = await ctx.db
      .select()
      .from(settlements)
      .where(eq(settlements.returnId, world.returnId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.processId).toBe(world.processId);
    expect(rows[0]!.bookingId).toBe(world.bookingId);
    const view = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(view.settlement.status).toBe('ready_for_accounting');
    expect(view.settlement.noticeRequired).toBe(false);
  });

  it('1b. Offline-sync-finalisierte Rückgabe ⇒ genau ein Settlement (Listener auch im Offline-Pfad)', async () => {
    const { admin } = await adminSession(ctx);
    const world = await issuedBooking(ctx, admin.id, {
      machineCodes: ['MR-10-01-01'],
      to: new Date(Date.now() + 1 * DAYS),
    });
    const staff = await h.staffWith(admin.id, h.OPERATIVE, 'Settle');
    const before = await h.packageFor(staff.cookie);
    const snapshot = before.bookings.find((b) => b.bookingId === world.bookingId)!;
    const machine = snapshot.returnSeed!.machines[0]!;
    const returnAppointment = snapshot.appointments.find((a) => a.kind === 'return')!;
    const base = {
      processStatus: 'open',
      appointmentId: returnAppointment.id,
      appointmentVersion: returnAppointment.version,
    };
    const common = { assignmentId: machine.assignmentId, machineId: machine.machineId };
    const steps: MutationInput[] = [
      { type: 'return.start', contextId: world.bookingId, base, payload: {} },
      {
        type: 'return.returner',
        contextId: world.bookingId,
        base,
        payload: { kind: 'customer', firstName: null, lastName: null, phone: null },
      },
      { type: 'return.accessory', contextId: world.bookingId, base, payload: common },
      {
        type: 'return.cleanliness',
        contextId: world.bookingId,
        base,
        payload: { ...common, emptied: true, rinsedTwice: true, nothingDismantled: true },
      },
    ];
    for (const role of ['customer', 'staff'] as const) {
      const mediaId = randomUUID();
      steps.push({
        type: 'return.signature',
        contextId: world.bookingId,
        base,
        payload: { role, mediaId },
        media: [{ mediaId, purpose: 'return_signature', mimeType: 'image/png', bytes: pngBytes() }],
      });
    }
    steps.push({
      type: 'return.finalize',
      contextId: world.bookingId,
      base,
      payload: {
        capturedAt: new Date(Date.now() - 60_000).toISOString(),
        expectedMachines: [common],
      },
    });
    for (const step of steps) {
      const result = await h.sync(staff.cookie, step);
      expect(result.json.status, step.type).toBe('applied');
    }
    const ret = (
      await ctx.db.select().from(rentalReturns).where(eq(rentalReturns.bookingId, world.bookingId))
    )[0]!;
    expect(ret.status).toBe('finalized');
    const rows = await ctx.db.select().from(settlements).where(eq(settlements.returnId, ret.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('ready_for_accounting');
    expect(rows[0]!.amountDueCents).toBe(7500);
  });

  it('2. Nicht finalisierter Return ⇒ kein Settlement; GET ⇒ 404, ensure ⇒ 409', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await issuedBookingWithOptions(ctx, admin.id);
    await world.services.returns.start(admin.id, world.bookingId);
    await readyReturn(ctx, admin.id, world.services, world.bookingId);
    expect(await ctx.db.select().from(settlements)).toHaveLength(0);
    const get = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${world.processId}/settlement`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(404);
    expect(get.json().error.code).toBe('SETTLEMENT_NOT_FOUND');
    const ensure = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/settlement/ensure`,
      headers: { cookie },
    });
    expect(ensure.statusCode).toBe(409);
    expect(ensure.json().error.code).toBe('RETURN_NOT_FINALIZED');
    expect(await ctx.db.select().from(settlements)).toHaveLength(0);
  });

  it('3. ensure mehrfach (Route, Service, parallel, CLI-Logik) ⇒ keine Duplikate (Settlement, Lines, Jobs)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await finalizedReturn(ctx, admin.id, cookie, {
      selections: [{ slug: 'mischkanister-6l', role: 'extra', quantity: 2 }],
    });
    const service = settlementServiceFor(ctx);
    await Promise.all([
      service.ensureSettlementForReturn(world.returnId),
      service.ensureSettlementForReturn(world.returnId),
      ctx.app.inject({
        method: 'POST',
        url: `/staff/processes/${world.processId}/settlement/ensure`,
        headers: { cookie },
      }),
    ]);
    const all = await service.ensureAll();
    expect(all.created).toEqual([]);
    const rows = await ctx.db.select().from(settlements);
    expect(rows).toHaveLength(1);
    const lines = await ctx.db.select().from(settlementLines);
    const keys = lines.map((line) => `${line.sourceType}|${line.sourceKey}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(lines.filter((line) => line.type === 'machine_rental')).toHaveLength(1);
    expect(lines.filter((line) => line.type === 'purchase')).toHaveLength(1);
    const jobs = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM integration_jobs WHERE type = 'settlement.accounting_transfer'`,
    );
    expect(jobs.rows[0].n).toBe(1);
  });

  it('4./13./14. Miete aus dem Snapshot (1×10 = 7500 Cent) – unverändert bei früher Rückgabe, exakte Cent-Arithmetik', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { view } = await settledReturn(ctx, admin.id, cookie, { machineSlug: 'slush-1x10' });
    const rental = lineOf(view, 'machine_rental');
    expect(rental).toHaveLength(1);
    expect(rental[0]).toMatchObject({ quantity: 1, unitPriceCents: 7500, amountCents: 7500 });
    expect(view.settlement.fixedTotalCents).toBe(7500);
    expect(view.settlement.amountDueCents).toBe(7500);
    expect(Number.isInteger(view.settlement.amountDueCents)).toBe(true);
    // Rückgabe lief deutlich vor dem geplanten Rückgabetermin (+3 Tage) – keine Minderung.
    expect(view.settlement.grossTotalCents).toBe(7500);
  });

  it('5. Lieferpreis aus dem Snapshot', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { view } = await settledReturn(ctx, admin.id, cookie, {
      fulfillment: 'delivery',
      deliveryPriceCents: 4990,
    });
    const delivery = lineOf(view, 'delivery');
    expect(delivery).toHaveLength(1);
    expect(delivery[0]!.amountCents).toBe(4990);
    expect(view.settlement.fixedTotalCents).toBe(7500 + 4990);
  });

  it('6. Rabatt aus dem Snapshot (fix 1000 Cent) reduziert die feste Basis', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { view } = await settledReturn(ctx, admin.id, cookie, {
      discount: { type: 'fixed', value: 1000 },
    });
    const discount = lineOf(view, 'discount');
    expect(discount).toHaveLength(1);
    expect(discount[0]).toMatchObject({ amountCents: 1000, direction: 'credit' });
    expect(view.settlement.discountCents).toBe(1000);
    expect(view.settlement.fixedTotalCents).toBe(6500);
    expect(view.settlement.amountDueCents).toBe(6500);
  });

  it('7./8. Kaufartikel nach tatsächlicher Ausgabe mit eingefrorenem Preis – aktueller Produktpreis ändert nichts', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await issuedBookingWithOptions(ctx, admin.id, {
      selections: [{ slug: 'mischkanister-6l', role: 'extra', quantity: 2 }],
    });
    // Nach der Ausgabe wird der Kanister teurer – historische Abrechnung bleibt bei 500 Cent.
    const canister = await productServiceFor(ctx).getProductBySlug('mischkanister-6l');
    await productServiceFor(ctx).setCurrentPrice(admin.id, canister.id, 999);
    await world.services.returns.start(admin.id, world.bookingId);
    await readyReturn(ctx, admin.id, world.services, world.bookingId);
    const finalize = await ctx.app.inject({
      method: 'POST',
      url: `/staff/returns/${world.bookingId}/finalize`,
      headers: { cookie },
    });
    expect(finalize.statusCode).toBe(200);
    const view = await settlementViewFor(ctx.app, cookie, world.processId);
    const purchase = lineOf(view, 'purchase');
    expect(purchase).toHaveLength(1);
    expect(purchase[0]).toMatchObject({ quantity: 2, unitPriceCents: 500, amountCents: 1000 });
    expect(view.settlement.variableTotalCents).toBe(1000);
    const stored = await ctx.db.select().from(products).where(eq(products.id, canister.id));
    expect(stored).toHaveLength(1);
  });

  it('9./10. Kommission exakt aus Phase-7-Fakten (issued − unopened), inklusive Ware 0 EUR ohne Position', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { view } = await settledReturn(ctx, admin.id, cookie, {
      machineSlug: 'slush-2x10',
      machineCodes: ['MR-10-02-01'],
      selections: [
        { slug: 'sirup-kirsche', role: 'free', quantity: 2 },
        { slug: 'sirup-kirsche', role: 'extra', quantity: 3 },
      ],
      returnedUnopened: [{ match: 'Kirsche', quantity: 1 }],
    });
    const commission = lineOf(view, 'commission_consumption');
    expect(commission).toHaveLength(1);
    // 3 extra ausgegeben, 1 ungeöffnet zurück ⇒ 2 × 1200 (eingefrorener Preis) = 2400.
    expect(commission[0]).toMatchObject({ quantity: 2, unitPriceCents: 1200, amountCents: 2400 });
    expect(view.lines.some((line) => line.description.includes('inklusive'))).toBe(false);
    expect(view.settlement.variableTotalCents).toBe(2400);
    expect(view.settlement.amountDueCents).toBe(12000 + 2400);
  });

  it('11./12. Reinigungsgebühr 75 EUR je betroffener Maschine – zwei Maschinen ⇒ 150 EUR, keine Kundeninformation nötig', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const one = await settledReturn(ctx, admin.id, cookie, { cleanupMachines: [0] });
    expect(lineOf(one.view, 'cleanup_fee')).toHaveLength(1);
    expect(lineOf(one.view, 'cleanup_fee')[0]!.amountCents).toBe(7500);
    expect(lineOf(one.view, 'cleanup_fee')[0]!.description).toContain(
      'Reinigungsgebühr Maschine MR-10-01-01',
    );
    expect(one.view.settlement.noticeRequired).toBe(false);
    await resetSettlementWorld(ctx);
    const admin2 = await adminSession(ctx);
    const two = await settledReturn(ctx, admin2.admin.id, admin2.cookie, {
      machineCodes: ['MR-10-01-01', 'MR-10-01-02'],
      cleanupMachines: [0, 1],
    });
    expect(lineOf(two.view, 'cleanup_fee')).toHaveLength(2);
    expect(two.view.settlement.variableTotalCents).toBe(15000);
    expect(two.view.settlement.amountDueCents).toBe(2 * 7500 + 15000);
    expect(two.view.settlement.status).toBe('ready_for_accounting');
  });

  it('26. Keine Position doppelt aus derselben Source – Unique-Index + idempotenter Rebuild', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { view } = await settledReturn(ctx, admin.id, cookie, { cleanupMachines: [0] });
    const service = settlementServiceFor(ctx);
    for (let i = 0; i < 3; i += 1)
      await service.ensureSettlementForReturn(view.settlement.returnId);
    const lines = await ctx.db
      .select()
      .from(settlementLines)
      .where(eq(settlementLines.settlementId, view.settlement.id));
    expect(lines.filter((line) => line.type === 'cleanup_fee')).toHaveLength(1);
    expect(lines.filter((line) => line.type === 'machine_rental')).toHaveLength(1);
    await expect(
      ctx.db.insert(settlementLines).values({
        settlementId: view.settlement.id,
        type: 'cleanup_fee',
        description: 'Duplikat',
        unitPriceCents: 7500,
        amountCents: 7500,
        sourceType: 'return_machine',
        sourceKey: lines.find((line) => line.type === 'cleanup_fee')!.sourceKey,
      }),
    ).rejects.toThrow();
  });
});
