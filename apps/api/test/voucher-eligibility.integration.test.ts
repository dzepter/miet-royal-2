/**
 * Phase-11-Pflichttests Eligibility 1–17 (Order §§3–8, 47–48) und
 * Gültigkeit/Owner 37–41 (Order §§18–19): genau ein Gutschein nach
 * schadenfreier, bezahlter, regulärer Abrechnung mit beendetem Nachtrags-
 * fenster – über die ECHTEN Trigger (Zahlungsstatus, Reinigungsabschluss),
 * Jobs auf der PostgreSQL-Queue und den idempotenten Backfill.
 */
import { randomUUID } from 'node:crypto';
import { processes, vouchers } from '@mietroyal/database';
import { formatVoucherCode } from '@mietroyal/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { bookedProcess, bookingRow, cancelBooking } from './cancellation-helpers.ts';
import { jpegBytes, POINT_MARKER } from './return-helpers.ts';
import { adminSession, settledReturn } from './settlement-helpers.ts';
import {
  allVouchers,
  completeCleaningViaRoute,
  drainJobs,
  issueTestVoucher,
  machineByCode,
  paidSettledWorld,
  payAndCompleteWorld,
  resetVoucherWorld,
  setPaymentViaRoute,
  voucherRow,
  voucherServiceFor,
  vouchersForSettlement,
} from './voucher-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetVoucherWorld(ctx);
});

async function jobRows() {
  const rows = await ctx.pool.query<{ status: string; idempotency_key: string }>(
    `SELECT status, idempotency_key FROM integration_jobs WHERE type = 'voucher.eligibility_check' ORDER BY created_at`,
  );
  return rows.rows;
}

describe('Entstehung (Tests 1–6, 14–17)', () => {
  it('1. finalisiert + bezahlt + schadenfrei + Nachtragsfenster beendet ⇒ genau EIN Gutschein (über Trigger + Job)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await payAndCompleteWorld(ctx, admin.id, cookie);
    expect(await drainJobs(ctx)).toBeGreaterThan(0);
    const rows = await vouchersForSettlement(ctx, paid.settlementId);
    expect(rows).toHaveLength(1);
    const voucher = rows[0]!;
    expect(voucher).toMatchObject({
      voucherType: 'returning_customer_20',
      customerId: paid.world.customerId,
      originProcessId: paid.world.processId,
      originBookingId: paid.world.bookingId,
      originReturnId: paid.world.returnId,
      discountPercent: 20,
      status: 'active',
      deliveryStatus: 'pending',
      reservedOfferId: null,
      deliveredAt: null,
      version: 1,
    });
    expect(voucher.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(voucher.codeSuffix).toMatch(/^[A-Z2-9]{4}$/);
    expect(voucher.deliveryCodeCiphertext).not.toBeNull();
    expect(voucher.expiresAt.getTime()).toBeGreaterThan(voucher.activatedAt.getTime());
    expect(await allVouchers(ctx)).toHaveLength(1);
    const service = voucherServiceFor(ctx);
    expect(await service.ensureVoucherForSettlement(paid.settlementId)).toMatchObject({
      outcome: 'exists',
      voucherId: voucher.id,
    });
  });

  it('2. Zahlungsstatus offen ⇒ kein Gutschein („Abgeschlossen“ allein reicht nicht)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await payAndCompleteWorld(ctx, admin.id, cookie, { paymentStatus: 'open' });
    await drainJobs(ctx);
    expect(await allVouchers(ctx)).toEqual([]);
    const process = (
      await ctx.db.select().from(processes).where(eq(processes.id, paid.world.processId))
    )[0]!;
    expect(process.mainStatus).toBe('completed');
    const result = await voucherServiceFor(ctx).ensureVoucherForSettlement(paid.settlementId);
    expect(result.outcome).toBe('ineligible');
    expect(result.reasons).toEqual(['PAYMENT_NOT_PAID']);
    expect(await allVouchers(ctx)).toEqual([]);
  });

  it('3. Zahlungsstatus überfällig ⇒ kein Gutschein; späteres „bezahlt“ ⇒ Gutschein', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await payAndCompleteWorld(ctx, admin.id, cookie, { paymentStatus: 'overdue' });
    await drainJobs(ctx);
    expect(await jobRows()).toEqual([]);
    const result = await voucherServiceFor(ctx).ensureVoucherForSettlement(paid.settlementId);
    expect(result).toMatchObject({ outcome: 'ineligible', reasons: ['PAYMENT_NOT_PAID'] });
    await setPaymentViaRoute(ctx, cookie, paid.transferId, 'paid');
    await drainJobs(ctx);
    expect(await vouchersForSettlement(ctx, paid.settlementId)).toHaveLength(1);
  });

  it('4./48. „bezahlt“ mehrfach gemeldet ⇒ genau ein Gutschein (Jobs dedupliziert je Transfer, Service idempotent)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await payAndCompleteWorld(ctx, admin.id, cookie);
    for (let i = 0; i < 3; i += 1) await setPaymentViaRoute(ctx, cookie, paid.transferId, 'paid');
    await setPaymentViaRoute(ctx, cookie, paid.transferId, 'open');
    await setPaymentViaRoute(ctx, cookie, paid.transferId, 'paid');
    const jobs = await jobRows();
    expect(jobs.filter((job) => job.idempotency_key.includes(':paid:'))).toHaveLength(1);
    await drainJobs(ctx);
    expect(await vouchersForSettlement(ctx, paid.settlementId)).toHaveLength(1);
    // Parallele Service-Aufrufe (zwei Instanzen) ⇒ weiterhin genau einer.
    const results = await Promise.all([
      voucherServiceFor(ctx).ensureVoucherForSettlement(paid.settlementId),
      voucherServiceFor(ctx).ensureVoucherForSettlement(paid.settlementId),
      voucherServiceFor(ctx).ensureVoucherForSettlement(paid.settlementId),
    ]);
    expect(results.map((r) => r.outcome)).toEqual(['exists', 'exists', 'exists']);
    expect(await allVouchers(ctx)).toHaveLength(1);
  });

  it('6. voucher:ensure (Backfill) zweimal ⇒ genau ein Gutschein; nicht berechtigte bleiben ohne', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const eligible = await payAndCompleteWorld(ctx, admin.id, cookie);
    const stillCleaning = await paidSettledWorld(ctx, admin.id, cookie, {
      machineCodes: ['MR-10-01-02'],
    });
    // Jobs bewusst NICHT verarbeiten – der Backfill muss es allein schaffen.
    await ctx.pool.query(`DELETE FROM integration_jobs WHERE type = 'voucher.eligibility_check'`);
    const service = voucherServiceFor(ctx);
    const first = await service.ensureForAllEligible();
    expect(first).toEqual({ scanned: 2, created: 1, exists: 0, ineligible: 1 });
    const second = await service.ensureForAllEligible();
    expect(second).toEqual({ scanned: 1, created: 0, exists: 0, ineligible: 1 });
    expect(await vouchersForSettlement(ctx, eligible.settlementId)).toHaveLength(1);
    expect(await vouchersForSettlement(ctx, stillCleaning.settlementId)).toHaveLength(0);
    expect(await allVouchers(ctx)).toHaveLength(1);
    // Parallel: Backfill + Trigger-Job gleichzeitig ⇒ kein Duplikat.
    await completeCleaningViaRoute(ctx, cookie, 'MR-10-01-02');
    await Promise.all([service.ensureForAllEligible(), drainJobs(ctx)]);
    expect(await vouchersForSettlement(ctx, stillCleaning.settlementId)).toHaveLength(1);
    expect(await allVouchers(ctx)).toHaveLength(2);
  });

  it('14./15. „bezahlt“ während des Nachtragsfensters ⇒ noch kein Gutschein; Reinigungsabschluss der letzten Maschine ⇒ Gutschein entsteht', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidSettledWorld(ctx, admin.id, cookie, {
      machineCodes: ['MR-10-01-01', 'MR-10-01-02'],
    });
    await drainJobs(ctx);
    expect(await allVouchers(ctx)).toEqual([]);
    expect(
      await voucherServiceFor(ctx).ensureVoucherForSettlement(paid.settlementId),
    ).toMatchObject({
      outcome: 'ineligible',
      reasons: ['POST_RETURN_WINDOW_OPEN'],
    });
    // Erste Maschine gereinigt ⇒ Fenster der zweiten noch offen.
    await completeCleaningViaRoute(ctx, cookie, 'MR-10-01-01');
    await drainJobs(ctx);
    expect(await allVouchers(ctx)).toEqual([]);
    // Letzte Maschine gereinigt ⇒ Trigger B ⇒ Job ⇒ Gutschein.
    await completeCleaningViaRoute(ctx, cookie, 'MR-10-01-02');
    expect((await jobRows()).some((job) => job.idempotency_key.includes(':cleaning:'))).toBe(true);
    await drainJobs(ctx);
    expect(await vouchersForSettlement(ctx, paid.settlementId)).toHaveLength(1);
  });

  it('15b. Reinigungsphase anderweitig verlassen (Status Reparatur) beendet das Fenster ebenfalls ⇒ Gutschein', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidSettledWorld(ctx, admin.id, cookie);
    await drainJobs(ctx);
    expect(await allVouchers(ctx)).toEqual([]);
    const machine = await machineByCode(ctx, 'MR-10-01-01');
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/status`,
      headers: { cookie },
      payload: { status: 'repair' },
    });
    expect(response.statusCode).toBe(200);
    await drainJobs(ctx);
    expect(await vouchersForSettlement(ctx, paid.settlementId)).toHaveLength(1);
  });

  it('16. Bezahlte Stornorechnung erzeugt NIE einen Gutschein (kein Settlement, Storno-Transfer paid ⇒ kein Job, Backfill findet nichts)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    // Kostenpflichtiges Storno (Event in 5 Tagen ⇒ Gebühr > 0) einer bestätigten Buchung.
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 5 });
    const cancellation = await cancelBooking(ctx, admin.id, booked.processId);
    expect(cancellation.feePercent).toBeGreaterThan(0);
    await drainJobs(ctx);
    const transfer = await ctx.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM accounting_transfers WHERE cancellation_id = $1`,
      [cancellation.id],
    );
    expect(transfer.rows[0]?.status).toBe('succeeded');
    await setPaymentViaRoute(ctx, cookie, transfer.rows[0]!.id, 'paid');
    const paidRow = await ctx.pool.query<{ payment_status: string }>(
      `SELECT payment_status FROM cancellations WHERE id = $1`,
      [cancellation.id],
    );
    expect(paidRow.rows[0]?.payment_status).toBe('paid');
    // Trigger A ignoriert Storno-Transfers (kein settlementId) ⇒ kein Job, kein Gutschein.
    expect(await jobRows()).toEqual([]);
    await drainJobs(ctx);
    expect(await allVouchers(ctx)).toEqual([]);
    const backfill = await voucherServiceFor(ctx).ensureForAllEligible();
    expect(backfill).toEqual({ scanned: 0, created: 0, exists: 0, ineligible: 0 });
    expect(await allVouchers(ctx)).toEqual([]);
  });

  it('17. Kein Duplikat je origin_settlement: Direkt-Insert eines zweiten Gutscheins scheitert am UNIQUE-Index', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await payAndCompleteWorld(ctx, admin.id, cookie);
    await drainJobs(ctx);
    const existing = (await vouchersForSettlement(ctx, paid.settlementId))[0]!;
    await expect(
      issueTestVoucher(ctx, {
        customerId: existing.customerId,
        originProcessId: existing.originProcessId,
        originBookingId: existing.originBookingId,
        originReturnId: existing.originReturnId,
        originSettlementId: existing.originSettlementId,
      }),
    ).rejects.toThrow();
    expect(await allVouchers(ctx)).toHaveLength(1);
  });
});

describe('Schadenfrei (Tests 7–13)', () => {
  it('7. dokumentierter, berechneter Rückgabeschaden ⇒ kein Gutschein (auch nach Zahlung + Reinigung)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await payAndCompleteWorld(ctx, admin.id, cookie, {
      damages: [{ description: 'Riss im Deckel', severity: 'light' }],
      damageDecision: 'charge',
      damageAmountCents: 5000,
    });
    await drainJobs(ctx);
    expect(await allVouchers(ctx)).toEqual([]);
    const result = await voucherServiceFor(ctx).ensureVoucherForSettlement(paid.settlementId);
    expect(result).toMatchObject({ outcome: 'ineligible', reasons: ['DAMAGE_DOCUMENTED'] });
  });

  it('8. Schaden „nicht mehr aktuell“ (aufgelöst) ⇒ weiterhin kein Gutschein', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world } = await settledReturn(ctx, admin.id, cookie, {
      damages: [{ description: 'Kratzer am Gehäuse' }],
    });
    await world.services.damages.resolveCurrent(admin.id, world.damageIds[0]!);
    const assessment = await voucherServiceFor(ctx).assessEligibility(
      (await ctx.pool.query<{ id: string }>('SELECT id FROM settlements')).rows[0]!.id,
    );
    expect(assessment.eligible).toBe(false);
    expect(assessment.reasons).toContain('DAMAGE_DOCUMENTED');
  });

  it('9. Schaden ohne Berechnung (0 EUR / nicht berechnen) ⇒ kein Gutschein', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await payAndCompleteWorld(ctx, admin.id, cookie, {
      damages: [{ description: 'Delle hinten', severity: 'light' }],
      damageDecision: 'no_charge',
    });
    await drainJobs(ctx);
    expect(await allVouchers(ctx)).toEqual([]);
    const result = await voucherServiceFor(ctx).ensureVoucherForSettlement(paid.settlementId);
    expect(result).toMatchObject({ outcome: 'ineligible', reasons: ['DAMAGE_DOCUMENTED'] });
  });

  it('10. post_return_finding (Nachtrag während der Reinigung) ⇒ kein Gutschein', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidSettledWorld(ctx, admin.id, cookie);
    const machine = await machineByCode(ctx, 'MR-10-01-01');
    await paid.world.services.damages.createPostReturnFinding(admin.id, machine.id, {
      severity: 'severe',
      description: 'Nachträglich: Gehäuse gebrochen',
      markers: [POINT_MARKER],
      photo: { bytes: jpegBytes(), mimeType: 'image/jpeg' },
    });
    await completeCleaningViaRoute(ctx, cookie, 'MR-10-01-01');
    await drainJobs(ctx);
    expect(await allVouchers(ctx)).toEqual([]);
    const result = await voucherServiceFor(ctx).ensureVoucherForSettlement(paid.settlementId);
    expect(result).toMatchObject({ outcome: 'ineligible', reasons: ['DAMAGE_DOCUMENTED'] });
  });

  it('11. technischer Defekt allein (requires_financial_review=false) ⇒ Gutschein erlaubt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidSettledWorld(ctx, admin.id, cookie);
    const machine = await machineByCode(ctx, 'MR-10-01-01');
    await paid.world.services.damages.addTechnicalDefect(admin.id, machine.id, {
      description: 'Kompressor läuft nicht an',
    });
    await completeCleaningViaRoute(ctx, cookie, 'MR-10-01-01');
    await drainJobs(ctx);
    expect(await vouchersForSettlement(ctx, paid.settlementId)).toHaveLength(1);
  });

  it('12. Reinigungsgebühr allein ⇒ Gutschein erlaubt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await payAndCompleteWorld(ctx, admin.id, cookie, { cleanupMachines: [0] });
    expect(paid.view.lines.some((line) => line.type === 'cleanup_fee')).toBe(true);
    await drainJobs(ctx);
    expect(await vouchersForSettlement(ctx, paid.settlementId)).toHaveLength(1);
  });

  it('13. Fehlteil allein ⇒ Gutschein erlaubt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await payAndCompleteWorld(ctx, admin.id, cookie, {
      missing: [{ accessoryType: 'lid', quantity: 1 }],
    });
    expect(paid.world.missingCaseIds).toHaveLength(1);
    await drainJobs(ctx);
    expect(await vouchersForSettlement(ctx, paid.settlementId)).toHaveLength(1);
  });
});

describe('Gültigkeit und Besitzer (Tests 37–41)', () => {
  async function voucherWorld() {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await payAndCompleteWorld(ctx, admin.id, cookie);
    await drainJobs(ctx);
    const voucher = (await vouchersForSettlement(ctx, paid.settlementId))[0]!;
    // Test-Gutschein mit bekanntem Code für dieselbe Welt (eigenes Settlement nötig: UNIQUE).
    await ctx.pool.query('TRUNCATE voucher_redemptions, vouchers CASCADE');
    const issued = await issueTestVoucher(ctx, {
      customerId: voucher.customerId,
      originProcessId: voucher.originProcessId,
      originBookingId: voucher.originBookingId,
      originReturnId: voucher.originReturnId,
      originSettlementId: voucher.originSettlementId,
    });
    return { admin, cookie, paid, ...issued };
  }

  it('37./39. richtiger Kunde + aktiv ⇒ verwendbar (Code in jeder Schreibweise)', async () => {
    const { paid, code, voucherId } = await voucherWorld();
    const service = voucherServiceFor(ctx);
    for (const input of [code, formatVoucherCode(code), formatVoucherCode(code).toLowerCase()]) {
      const result = await service.validateForOffer({
        code: input,
        customerId: paid.world.customerId,
        offerId: randomUUID(),
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.voucher.id).toBe(voucherId);
    }
  });

  it('38. fremder Kunde ⇒ neutral { ok: false } – identisch zu unbekanntem Code', async () => {
    const { paid, code } = await voucherWorld();
    const service = voucherServiceFor(ctx);
    const foreign = await service.validateForOffer({
      code,
      customerId: randomUUID(),
      offerId: randomUUID(),
    });
    const unknown = await service.validateForOffer({
      code: 'MR20-AAAA-BBBB-CCCC',
      customerId: paid.world.customerId,
      offerId: randomUUID(),
    });
    expect(foreign).toEqual({ ok: false });
    expect(unknown).toEqual({ ok: false });
  });

  it('40. eingelöst ⇒ nicht verwendbar (neutral)', async () => {
    const { paid, code, voucherId } = await voucherWorld();
    const service = voucherServiceFor(ctx);
    const offerId = (await bookingRow(ctx, paid.world.bookingId)).offerId;
    await ctx.db.transaction((tx) =>
      service.redeem(tx, {
        voucherId,
        offerId,
        bookingId: paid.world.bookingId,
        processId: paid.world.processId,
        customerId: paid.world.customerId,
        expectedDiscountCents: 2000,
        machineSubtotalCents: 10_000,
        now: new Date(),
      }),
    );
    expect((await voucherRow(ctx, voucherId))!.status).toBe('redeemed');
    expect(
      await service.validateForOffer({
        code,
        customerId: paid.world.customerId,
        offerId: randomUUID(),
      }),
    ).toEqual({ ok: false });
  });

  it('41. abgelaufen ⇒ nicht verwendbar; eine Sekunde davor verwendbar', async () => {
    const { paid, code, voucherId } = await voucherWorld();
    const service = voucherServiceFor(ctx);
    const row = (await voucherRow(ctx, voucherId))!;
    const before = new Date(row.expiresAt.getTime() - 1000);
    expect(
      (
        await service.validateForOffer({
          code,
          customerId: paid.world.customerId,
          offerId: randomUUID(),
          now: before,
        })
      ).ok,
    ).toBe(true);
    expect(
      await service.validateForOffer({
        code,
        customerId: paid.world.customerId,
        offerId: randomUUID(),
        now: row.expiresAt,
      }),
    ).toEqual({ ok: false });
    // Lazy: Status in der DB bleibt active, effektiver Status „abgelaufen“.
    expect((await voucherRow(ctx, voucherId))!.status).toBe('active');
    const summary = await service.customerVoucherSummary(paid.world.customerId, row.expiresAt);
    expect(summary).toMatchObject({ status: 'expired', statusLabel: 'Abgelaufen' });
    expect(await ctx.db.select().from(vouchers)).toHaveLength(1);
  });
});
