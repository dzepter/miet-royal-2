/**
 * Phase-11-Pflichttests Storno 81–96 (Order §§40–46): kostenloses Storno
 * reaktiviert DENSELBEN Gutschein mit gespeicherter Restgültigkeit (idempotent,
 * replay-sicher), kostenpflichtiges Storno lässt ihn verbraucht; Stornobasis
 * = regulärer Listenpreis VOR Gutschein; Folgevorgang setzt nichts ein.
 */
import { vouchers } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { VoucherService } from '../src/voucher/voucher-service.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  adminSession,
  bookedProcess,
  cancellationServicesFor,
  cancelBooking,
  eventDateInDays,
  resetForCancellationTests,
} from './cancellation-helpers.ts';
import { commerceServices, inquiryServiceFor, productServiceFor } from './commerce-helpers.ts';
import {
  draftForCustomer,
  issueVoucherForCustomer,
  redemptionsFor,
  versionRow,
  voucherRow,
} from './voucher-offer-helpers.ts';

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

const DAY_MS = 86_400_000;

/** Gutschein-Fixture als Hook für `bookedProcess` (Kunde entsteht dort). */
function voucherHook(adminId: string, remainingDays?: number) {
  const state: { voucherId: string; code: string; compact: string } = {
    voucherId: '',
    code: '',
    compact: '',
  };
  const hook = async (customerId: string) => {
    const issued = await issueVoucherForCustomer(ctx, adminId, customerId);
    Object.assign(state, issued);
    if (remainingDays !== undefined) {
      await ctx.db
        .update(vouchers)
        .set({ expiresAt: new Date(Date.now() + remainingDays * DAY_MS) })
        .where(eq(vouchers.id, issued.voucherId));
    }
    return issued.code;
  };
  return { state, hook };
}

describe('Kostenloses Storno (81–90)', () => {
  it('81.–86./89. 15+ Tage ⇒ 0 %: derselbe Gutschein (ID/Hash) wird reaktiviert, kein neuer, Restgültigkeit gespeichert und wiederhergestellt', async () => {
    const { admin } = await adminSession(ctx);
    const { state, hook } = voucherHook(admin.id, 93);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30, voucherCodeFor: hook });
    const redeemed = await voucherRow(ctx, state.voucherId);
    expect(redeemed.status).toBe('redeemed');
    const [redemptionBefore] = await redemptionsFor(ctx, state.voucherId);
    expect(redemptionBefore).toBeDefined();
    // 85: Restgültigkeit = expires_at − redeemed_at (exakt, Sekunden).
    expect(redemptionBefore!.remainingValiditySeconds).toBe(
      Math.floor(
        (redemptionBefore!.expiresAtBeforeRedemption.getTime() -
          redemptionBefore!.redeemedAt.getTime()) /
          1000,
      ),
    );
    expect(redemptionBefore!.remainingValiditySeconds).toBeGreaterThan(92 * 86_400);
    expect(redemptionBefore!.remainingValiditySeconds).toBeLessThanOrEqual(93 * 86_400);

    const cancelledAt = new Date(Date.now() + 2 * DAY_MS);
    const view = await cancelBooking(ctx, admin.id, booked.processId, cancelledAt);
    expect(view.feePercent).toBe(0); // 81

    const reactivated = await voucherRow(ctx, state.voucherId);
    expect(reactivated.id).toBe(redeemed.id); // 82
    expect(reactivated.codeHash).toBe(redeemed.codeHash); // 84
    expect(reactivated.status).toBe('active');
    expect(reactivated.reservedOfferId).toBeNull();
    expect(reactivated.version).toBeGreaterThan(redeemed.version);
    // 86: neues expires_at = Stornozeitpunkt + gespeicherte Restdauer.
    expect(reactivated.expiresAt.getTime()).toBe(
      cancelledAt.getTime() + redemptionBefore!.remainingValiditySeconds * 1000,
    );
    // 83: kein neuer Gutschein.
    expect(await ctx.db.select().from(vouchers)).toHaveLength(1);
    // 89: Redemption-Eintrag mit Storno-Verweis und Reaktivierungszeit.
    const [redemptionAfter] = await redemptionsFor(ctx, state.voucherId);
    expect(redemptionAfter!.id).toBe(redemptionBefore!.id);
    expect(redemptionAfter!.cancellationId).toBe(view.id);
    expect(redemptionAfter!.reactivatedAt).not.toBeNull();
    expect(redemptionAfter!.finalConsumptionReason).toBeNull();
  });

  it('87. Doppelstorno/Retry reaktiviert nur einmal – Restgültigkeit wird nicht erneut addiert', async () => {
    const { admin } = await adminSession(ctx);
    const { state, hook } = voucherHook(admin.id, 93);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30, voucherCodeFor: hook });
    const first = await cancelBooking(ctx, admin.id, booked.processId, new Date());
    const afterFirst = await voucherRow(ctx, state.voucherId);
    const second = await cancelBooking(
      ctx,
      admin.id,
      booked.processId,
      new Date(Date.now() + 5 * DAY_MS),
    );
    expect(second.id).toBe(first.id);
    const afterSecond = await voucherRow(ctx, state.voucherId);
    expect(afterSecond.expiresAt.getTime()).toBe(afterFirst.expiresAt.getTime());
    expect(afterSecond.version).toBe(afterFirst.version);
    expect(afterSecond.status).toBe('active');
    const redemptions = await redemptionsFor(ctx, state.voucherId);
    expect(redemptions).toHaveLength(1);

    // Direkter Retry der Reaktivierung (Nachbearbeitung) ist ebenfalls idempotent.
    const service = new VoucherService(ctx.db, ctx.config);
    const outcome = await ctx.db.transaction((tx) =>
      service.reactivateForFreeCancellation(tx, {
        bookingId: booked.bookingId,
        cancellationId: first.id,
        cancelledAt: new Date(Date.now() + 10 * DAY_MS),
      }),
    );
    expect(outcome.outcome).toBe('already_processed');
    expect((await voucherRow(ctx, state.voucherId)).expiresAt.getTime()).toBe(
      afterFirst.expiresAt.getTime(),
    );
  });

  it('88. Reaktivierter Gutschein ist für denselben Kunden wieder verwendbar (neuer Entwurf, Versand, Annahme)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { state, hook } = voucherHook(admin.id);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30, voucherCodeFor: hook });
    await cancelBooking(ctx, admin.id, booked.processId, new Date());
    const draft = await draftForCustomer(ctx, admin.id, booked.customerId);
    const applied = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${draft.versionId}/voucher`,
      headers: { cookie },
      payload: { code: state.code },
    });
    expect(applied.statusCode).toBe(200);
    expect((await versionRow(ctx, draft.versionId)).voucherDiscountCents).toBe(2400);
    const services = commerceServices(ctx);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    const { token } = await services.offers.send(admin.id, draft.versionId, effective);
    await services.offers.accept(token);
    expect((await voucherRow(ctx, state.voucherId)).status).toBe('redeemed');
    expect(await redemptionsFor(ctx, state.voucherId)).toHaveLength(2);
  });

  it('90. Alter Storno-Replay zerstört eine NEUE Redemption nicht (Voucher bleibt eingelöst)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { state, hook } = voucherHook(admin.id);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30, voucherCodeFor: hook });
    const oldCancellation = await cancelBooking(ctx, admin.id, booked.processId, new Date());
    // Erneute Nutzung ⇒ zweite Redemption.
    const draft = await draftForCustomer(ctx, admin.id, booked.customerId);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/staff/offer-versions/${draft.versionId}/voucher`,
          headers: { cookie },
          payload: { code: state.code },
        })
      ).statusCode,
    ).toBe(200);
    const services = commerceServices(ctx);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    const { token } = await services.offers.send(admin.id, draft.versionId, effective);
    await services.offers.accept(token);
    const before = await voucherRow(ctx, state.voucherId);
    expect(before.status).toBe('redeemed');

    // Replay des ALTEN Stornos (bereits verarbeitet) ⇒ no-op.
    const service = new VoucherService(ctx.db, ctx.config);
    const replay = await ctx.db.transaction((tx) =>
      service.reactivateForFreeCancellation(tx, {
        bookingId: booked.bookingId,
        cancellationId: oldCancellation.id,
        cancelledAt: new Date(),
      }),
    );
    expect(replay.outcome).toBe('already_processed');
    // Selbst wenn die alte Redemption fälschlich als unverarbeitet gälte:
    // eine NEUERE Redemption existiert ⇒ Voucher wird NICHT reaktiviert.
    const [oldRedemption] = (await redemptionsFor(ctx, state.voucherId)).filter(
      (r) => r.bookingId === booked.bookingId,
    );
    await ctx.pool.query(
      'UPDATE voucher_redemptions SET reactivated_at = NULL, cancellation_id = NULL WHERE id = $1',
      [oldRedemption!.id],
    );
    const forced = await ctx.db.transaction((tx) =>
      service.reactivateForFreeCancellation(tx, {
        bookingId: booked.bookingId,
        cancellationId: oldCancellation.id,
        cancelledAt: new Date(),
      }),
    );
    expect(forced.outcome).toBe('superseded');
    const after = await voucherRow(ctx, state.voucherId);
    expect(after.status).toBe('redeemed');
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
    expect(after.version).toBe(before.version);
  });
});

describe('Kostenpflichtiges Storno & Stornobasis (91–96)', () => {
  it('91. 50 % ⇒ Gutschein bleibt verbraucht (paid_cancellation), keine Reaktivierung', async () => {
    const { admin } = await adminSession(ctx);
    const { state, hook } = voucherHook(admin.id);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 10, voucherCodeFor: hook });
    const view = await cancelBooking(ctx, admin.id, booked.processId, new Date());
    expect(view.feePercent).toBe(50);
    const voucher = await voucherRow(ctx, state.voucherId);
    expect(voucher.status).toBe('redeemed');
    const [redemption] = await redemptionsFor(ctx, state.voucherId);
    expect(redemption!.finalConsumptionReason).toBe('paid_cancellation');
    expect(redemption!.cancellationId).toBe(view.id);
    expect(redemption!.reactivatedAt).toBeNull();
    expect(await ctx.db.select().from(vouchers)).toHaveLength(1);
  });

  it('92. 100 % ⇒ Gutschein bleibt verbraucht', async () => {
    const { admin } = await adminSession(ctx);
    const { state, hook } = voucherHook(admin.id);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 3, voucherCodeFor: hook });
    const view = await cancelBooking(ctx, admin.id, booked.processId, new Date());
    expect(view.feePercent).toBe(100);
    expect((await voucherRow(ctx, state.voucherId)).status).toBe('redeemed');
    const [redemption] = await redemptionsFor(ctx, state.voucherId);
    expect(redemption!.finalConsumptionReason).toBe('paid_cancellation');
  });

  it('93./94. Stornobasis = regulärer Maschinen-Listenpreis VOR Gutschein: 100 EUR + Gutschein (80) + 50 % ⇒ 50 EUR, nicht 40', async () => {
    const { admin } = await adminSession(ctx);
    const { state, hook } = voucherHook(admin.id);
    const booked = await bookedProcess(ctx, admin.id, {
      eventInDays: 10,
      machineSlug: 'slush-2x8', // 100,00 EUR Listenpreis
      voucherCodeFor: hook,
    });
    const view = await cancelBooking(ctx, admin.id, booked.processId, new Date());
    expect(view.feePercent).toBe(50);
    expect(view.baseCents).toBe(10000);
    expect(view.feeCents).toBe(5000);
    expect((await voucherRow(ctx, state.voucherId)).status).toBe('redeemed');
  });

  it('95. Ohne Gutschein: Stornoberechnung unverändert (100 EUR, 50 % ⇒ 50 EUR), keine Gutscheinwirkung', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, {
      eventInDays: 10,
      machineSlug: 'slush-2x8',
    });
    const view = await cancelBooking(ctx, admin.id, booked.processId, new Date());
    expect(view.feePercent).toBe(50);
    expect(view.baseCents).toBe(10000);
    expect(view.feeCents).toBe(5000);
    expect(await ctx.db.select().from(vouchers)).toHaveLength(0);
  });

  it('96. „Neuen Vorgang aus Storno erstellen“ setzt den reaktivierten Gutschein NICHT automatisch ein', async () => {
    const { admin } = await adminSession(ctx);
    const { state, hook } = voucherHook(admin.id);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30, voucherCodeFor: hook });
    await cancelBooking(ctx, admin.id, booked.processId, new Date());
    const { service } = cancellationServicesFor(ctx);
    const followUp = await service.createFollowUp(booked.processId, admin.id);
    const offer = await commerceServices(ctx).offers.getOfferForProcess(followUp.processId);
    expect(offer).toBeNull();
    const voucher = await voucherRow(ctx, state.voucherId);
    expect(voucher.status).toBe('active');
    expect(voucher.reservedOfferId).toBeNull();
    // Später bewusst nutzbar: Anfrage (Maschine) + Entwurf im Folgevorgang, Code anwenden.
    const machine = await productServiceFor(ctx).getProductBySlug('slush-2x10');
    await inquiryServiceFor(ctx).upsertForProcess(admin.id, followUp.processId, {
      eventDate: eventDateInDays(30),
      machineProductId: machine.id,
      fulfillment: 'pickup',
      selections: [],
    });
    const { versionId } = await commerceServices(ctx).offers.createOffer(
      admin.id,
      followUp.processId,
    );

    await commerceServices(ctx).offers.applyVoucher(admin.id, versionId, state.code);
    expect((await versionRow(ctx, versionId)).voucherId).toBe(state.voucherId);
  });
});
