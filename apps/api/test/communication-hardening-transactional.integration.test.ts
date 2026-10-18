/**
 * Härtung Review A (Phase 12, Order §§9/11/14/15) – Regressionstests Transaktionsmails:
 *  RA-8  Angebotsmail verspricht keinen PDF-Anhang mehr (Link + PDF-Download der Angebotsseite).
 *  RA-9  „Gutschein jetzt senden“ nach gescheiterter Zustellung ⇒ NEUE Zustellung
 *        (`voucher_delivery:<id>:retry:<vorherige>`) an die AKTUELLE Kundenadresse; laufende/
 *        unklare Zustellung ⇒ 409, canSendNow=false; alte Zustellung nicht mehr resendbar.
 *  H6    Abgelaufene Gutscheine werden nie versendet (VOUCHER_EXPIRED) – Profil, Route, Job, Sweep.
 *  RA-12 outcome_unknown bleibt fachlich `queued` (AB, Stornobestätigung) – keine Doppelmail über
 *        die normale Sendeaktion; Admin-Resend erreicht das Fachobjekt über das Schlüsselpräfix.
 *  RA-15 Stornobestätigung nach Fehlschlag: erneute Sendeaktion versendet wirklich (Retry-Schlüssel).
 */
import { cancellations, mailDeliveries, orderConfirmations, vouchers } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  enqueuePendingVoucherDeliveries,
  VoucherDeliveryJob,
} from '../src/communication/voucher-delivery-job.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { bookedProcess, cancelBooking, resetForCancellationTests } from './cancellation-helpers.ts';
import {
  commerceServices,
  createCommerceWorld,
  setPickupExactAddress,
  truncateCommerceTables,
} from './commerce-helpers.ts';
import { adminSession, drainAllJobs } from './settlement-helpers.ts';
import {
  completeCleaningViaRoute,
  paidSettledWorld,
  setPaymentViaRoute,
  truncateVoucherTables,
  vouchersForSettlement,
} from './voucher-helpers.ts';

const MAIL_ENV = {
  MAIL_ENABLED: 'true',
  MAIL_SMTP_HOST: 'smtp.test.example',
  MAIL_SMTP_USER: 'mailer@miet-royal.test',
  MAIL_SMTP_PASSWORD: 'smtp-password-review-a',
  MAIL_FROM_NAME: 'Miet-Royal Mainz',
  MAIL_FROM_ADDRESS: 'noreply@miet-royal.test',
  MAIL_PUBLIC_WEB_BASE_URL: 'https://web.test.example',
};

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ env: MAIL_ENV });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateVoucherTables(ctx.pool);
  await resetForCancellationTests(ctx);
  await truncateCommerceTables(ctx.pool);
  await ctx.pool.query(
    'TRUNCATE mail_deliveries, customer_action_tokens, conversation_messages, integration_jobs CASCADE',
  );
  ctx.mailGateway.reset();
});

async function deliveriesOfKind(kind: string) {
  return (await ctx.db.select().from(mailDeliveries)).filter((row) => row.kind === kind);
}

describe('Härtung Review A – Angebotsmail (RA-8, Order §11)', () => {
  it('RA-8 Angebotsmail ohne Anhang verspricht kein PDF „im Anhang“, verweist auf Link/PDF-Download; Vorlage v2', async () => {
    const { admin } = await adminSession(ctx);
    const world = await createCommerceWorld(ctx, admin.id);
    const services = commerceServices(ctx);
    const { versionId } = await services.offers.createOffer(admin.id, world.processId);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    await services.offers.send(admin.id, versionId, effective);
    await drainAllJobs(ctx);
    const delivery = (await deliveriesOfKind('offer'))[0]!;
    expect(delivery).toMatchObject({ status: 'sent', templateVersion: 2, attachments: [] });
    const mail = ctx.mailGateway.sent.find((m) => m.messageId === delivery.messageId)!;
    expect(mail.attachments).toHaveLength(0);
    expect(mail.text).not.toContain('im Anhang');
    expect(mail.html).not.toContain('im Anhang');
    expect(mail.text).toContain(
      'Über den Link kannst du das Angebot ansehen und als PDF herunterladen.',
    );
  });
});

describe('Härtung Review A – „Gutschein jetzt senden“ nach gescheiterter Zustellung (RA-9/H6, Order §15)', () => {
  async function voucherWithFailedDelivery() {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidSettledWorld(ctx, admin.id, cookie, { paymentStatus: 'open' });
    await ctx.pool.query(`UPDATE customers SET email = $2 WHERE id = $1`, [
      paid.world.customerId,
      'tippfehler@test.example',
    ]);
    await setPaymentViaRoute(ctx, cookie, paid.transferId, 'paid');
    await completeCleaningViaRoute(ctx, cookie, paid.world.machineCodes[0]!);
    ctx.mailGateway.nextOutcomes({ outcome: 'permanent_error', code: 'SMTP_550' });
    await drainAllJobs(ctx);
    const failed = (await deliveriesOfKind('voucher_delivery'))[0]!;
    expect(failed).toMatchObject({ status: 'failed', recipientEmail: 'tippfehler@test.example' });
    const voucher = (await vouchersForSettlement(ctx, paid.settlementId))[0]!;
    expect(voucher).toMatchObject({ deliveryStatus: 'pending', mailDeliveryId: failed.id });
    ctx.mailGateway.reset();
    return { cookie, paid, failed, voucher };
  }

  const profile = async (cookie: string, customerId: string) =>
    (
      await ctx.app.inject({
        method: 'GET',
        url: `/staff/customers/${customerId}`,
        headers: { cookie },
      })
    ).json().voucher as { canSendNow: boolean; sendNowBlock: string | null };

  const sendNow = (cookie: string, customerId: string, voucherId: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/staff/customers/${customerId}/send-voucher`,
      headers: { cookie },
      payload: { voucherId },
    });

  it('RA-9 korrigierte Adresse: „jetzt senden“ legt eine neue Zustellung an die AKTUELLE Adresse an und versendet; alte Zustellung nicht mehr resendbar', async () => {
    const { cookie, paid, failed, voucher } = await voucherWithFailedDelivery();
    await ctx.pool.query(`UPDATE customers SET email = $2 WHERE id = $1`, [
      paid.world.customerId,
      'richtig@test.example',
    ]);
    expect(await profile(cookie, paid.world.customerId)).toMatchObject({
      canSendNow: true,
      sendNowBlock: null,
    });
    // Doppelklick vor dem Job: beide angenommen, aber genau EINE neue Zustellung.
    const clicks = await Promise.all([
      sendNow(cookie, paid.world.customerId, voucher.id),
      sendNow(cookie, paid.world.customerId, voucher.id),
    ]);
    expect(clicks.map((c) => c.statusCode)).toEqual([200, 200]);
    expect(clicks[0]!.json()).toEqual({ queued: true, voucherId: voucher.id });
    await drainAllJobs(ctx);

    const deliveries = await deliveriesOfKind('voucher_delivery');
    expect(deliveries).toHaveLength(2);
    const retry = deliveries.find((d) => d.id !== failed.id)!;
    expect(retry).toMatchObject({
      status: 'sent',
      recipientEmail: 'richtig@test.example',
      idempotencyKey: `voucher_delivery:${voucher.id}:retry:${failed.id}`,
    });
    expect(ctx.mailGateway.sent).toHaveLength(1);
    expect(ctx.mailGateway.sent[0]!.to.email).toBe('richtig@test.example');
    const after = (await vouchersForSettlement(ctx, paid.settlementId))[0]!;
    expect(after).toMatchObject({
      deliveryStatus: 'sent',
      mailDeliveryId: retry.id,
      deliveryProblemCode: null,
      deliveryCodeCiphertext: null,
    });

    // Danach: kein weiterer Versand – weder über „jetzt senden“ noch über die alte Zustellung.
    const again = await sendNow(cookie, paid.world.customerId, voucher.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().message ?? JSON.stringify(again.json())).toContain('bereits versendet');
    const resendOld = await ctx.app.inject({
      method: 'POST',
      url: `/staff/communication/deliveries/${failed.id}/resend`,
      headers: { cookie },
    });
    expect(resendOld.statusCode).toBe(409);
    await drainAllJobs(ctx);
    expect(ctx.mailGateway.sent).toHaveLength(1);
  });

  it('RA-9b laufende (retry) bzw. unklare (outcome_unknown) Zustellung ⇒ canSendNow=false und 409', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidSettledWorld(ctx, admin.id, cookie, { paymentStatus: 'open' });
    await setPaymentViaRoute(ctx, cookie, paid.transferId, 'paid');
    await completeCleaningViaRoute(ctx, cookie, paid.world.machineCodes[0]!);
    ctx.mailGateway.nextOutcomes({ outcome: 'transient_error', code: 'SMTP_421' });
    await drainAllJobs(ctx);
    const first = (await deliveriesOfKind('voucher_delivery'))[0]!;
    expect(first.status).toBe('retry');
    const voucher = (await vouchersForSettlement(ctx, paid.settlementId))[0]!;
    expect(await profile(cookie, paid.world.customerId)).toMatchObject({
      canSendNow: false,
      sendNowBlock: 'DELIVERY_IN_PROGRESS',
    });
    expect((await sendNow(cookie, paid.world.customerId, voucher.id)).statusCode).toBe(409);

    // Unklare Zustellung: Kunde KANN den Code erhalten haben ⇒ kein neuer Versand per Klick.
    await ctx.db
      .update(mailDeliveries)
      .set({ status: 'outcome_unknown', nextAttemptAt: null })
      .where(eq(mailDeliveries.id, first.id));
    expect(await profile(cookie, paid.world.customerId)).toMatchObject({
      canSendNow: false,
      sendNowBlock: 'DELIVERY_OUTCOME_UNKNOWN',
    });
    const unclear = await sendNow(cookie, paid.world.customerId, voucher.id);
    expect(unclear.statusCode).toBe(409);
    expect(JSON.stringify(unclear.json())).toContain('unklar');
    // Auch ein (veralteter) Retry-Job ändert nichts: Vorzustellung ist nicht gescheitert.
    const job = new VoucherDeliveryJob({
      db: ctx.db,
      config: ctx.config,
      outbox: ctx.communication.outbox,
      mailGateway: ctx.mailGateway,
    });
    expect(await job.process(voucher.id, new Date(), { retryOfDeliveryId: first.id })).toBe(
      'already_queued',
    );
    expect(await deliveriesOfKind('voucher_delivery')).toHaveLength(1);
  });

  it('H6 abgelaufener Gutschein wird nicht versendet: Profil canSendNow=false, Route 409, Job „expired“, Sweep überspringt', async () => {
    const { cookie, paid, failed, voucher } = await voucherWithFailedDelivery();
    await ctx.pool.query(`UPDATE customers SET email = $2 WHERE id = $1`, [
      paid.world.customerId,
      'richtig@test.example',
    ]);
    // Gutschein abgelaufen (Aktivierung entsprechend früher – CHECK expires > activated).
    await ctx.pool.query(
      `UPDATE vouchers SET activated_at = now() - interval '400 days',
         expires_at = now() - interval '1 minute' WHERE id = $1`,
      [voucher.id],
    );
    expect(await profile(cookie, paid.world.customerId)).toMatchObject({
      canSendNow: false,
      sendNowBlock: 'VOUCHER_EXPIRED',
    });
    const response = await sendNow(cookie, paid.world.customerId, voucher.id);
    expect(response.statusCode).toBe(409);
    expect(JSON.stringify(response.json())).toContain('abgelaufen');
    const job = new VoucherDeliveryJob({
      db: ctx.db,
      config: ctx.config,
      outbox: ctx.communication.outbox,
      mailGateway: ctx.mailGateway,
    });
    expect(await job.process(voucher.id, new Date(), { retryOfDeliveryId: failed.id })).toBe(
      'expired',
    );
    // Sweep: auch ohne Vorzustellung kein Versand, aber sichtbarer Problemcode.
    await ctx.db
      .update(vouchers)
      .set({ mailDeliveryId: null, deliveryProblemCode: null })
      .where(eq(vouchers.id, voucher.id));
    expect(
      await enqueuePendingVoucherDeliveries({ db: ctx.db, queue: ctx.queue, config: ctx.config }),
    ).toBe(0);
    const row = (await ctx.db.select().from(vouchers).where(eq(vouchers.id, voucher.id)))[0]!;
    expect(row).toMatchObject({
      deliveryStatus: 'pending',
      deliveryProblemCode: 'VOUCHER_EXPIRED',
    });
    await drainAllJobs(ctx);
    expect(ctx.mailGateway.attempts).toHaveLength(0);
    expect(await deliveriesOfKind('voucher_delivery')).toHaveLength(1);
  });
});

describe('Härtung Review A – outcome_unknown bleibt fachlich queued (RA-12, Order §9)', () => {
  it('RA-12 AB: unklare Zustellung ⇒ Status queued, erneute Sendeaktion abgelehnt (keine Doppelmail); Admin-Resend setzt die AB auf sent', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await createCommerceWorld(ctx, admin.id);
    const services = commerceServices(ctx);
    const { versionId } = await services.offers.createOffer(admin.id, world.processId);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    const { token } = await services.offers.send(admin.id, versionId, effective);
    const { bookingId } = await services.offers.accept(token);
    const confirmation = (await services.confirmations.byBookingId(bookingId))!;
    await setPickupExactAddress(ctx, admin.id);
    await services.confirmations.approve(admin.id, confirmation.id);
    await drainAllJobs(ctx);
    ctx.mailGateway.reset();

    ctx.mailGateway.nextOutcomes({ outcome: 'unknown', code: 'SMTP_ETIMEDOUT' });
    await services.confirmations.send(confirmation.id);
    await drainAllJobs(ctx);
    const first = (await deliveriesOfKind('order_confirmation'))[0]!;
    expect(first.status).toBe('outcome_unknown');
    let row = (await ctx.db.select().from(orderConfirmations))[0]!;
    expect(row.status).toBe('queued');

    // Normale Sendeaktion: abgelehnt (bereits im Versand), keine zweite Mail.
    await expect(services.confirmations.send(confirmation.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await drainAllJobs(ctx);
    expect(await deliveriesOfKind('order_confirmation')).toHaveLength(1);
    expect(ctx.mailGateway.attempts).toHaveLength(1);

    // Bewusst über die Admin-Outbox erneut senden ⇒ AB erreicht `sent`.
    const resend = await ctx.app.inject({
      method: 'POST',
      url: `/staff/communication/deliveries/${first.id}/resend`,
      headers: { cookie },
    });
    expect(resend.statusCode).toBe(200);
    await drainAllJobs(ctx);
    row = (await ctx.db.select().from(orderConfirmations))[0]!;
    expect(row.status).toBe('sent');
    expect(row.mailDeliveryId).toBe((resend.json() as { deliveryId: string }).deliveryId);
    expect(ctx.mailGateway.sent).toHaveLength(1);
  });

  it('RA-12b Stornobestätigung: unklare Zustellung bleibt queued; erneutes Senden ist ein No-op ohne Mail', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const view = await cancelBooking(ctx, admin.id, world.processId);
    await drainAllJobs(ctx);
    ctx.mailGateway.reset();
    ctx.mailGateway.nextOutcomes({ outcome: 'unknown', code: 'SMTP_ETIMEDOUT' });
    const send = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/staff/cancellations/${view.id}/confirmation/send`,
        headers: { cookie },
        payload: {},
      });
    expect((await send()).json().confirmationStatus).toBe('queued');
    await drainAllJobs(ctx);
    const stored = (
      await ctx.db.select().from(cancellations).where(eq(cancellations.id, view.id))
    )[0]!;
    expect(stored.confirmationStatus).toBe('queued');
    expect((await deliveriesOfKind('cancellation_confirmation'))[0]!.status).toBe(
      'outcome_unknown',
    );
    expect((await send()).json().confirmationStatus).toBe('queued');
    await drainAllJobs(ctx);
    expect(ctx.mailGateway.attempts).toHaveLength(1);
    expect(await deliveriesOfKind('cancellation_confirmation')).toHaveLength(1);
  });
});

describe('Härtung Review A – Stornobestätigung nach Fehlschlag (RA-15, outbox.ts)', () => {
  it('RA-15 failed ⇒ erneut senden ⇒ neue Zustellung (Retry-Schlüssel), wirklich versendet, Status sent; danach No-op', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const view = await cancelBooking(ctx, admin.id, world.processId);
    await drainAllJobs(ctx);
    ctx.mailGateway.reset();
    ctx.mailGateway.nextOutcomes({ outcome: 'permanent_error', code: 'SMTP_550' });
    const send = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/staff/cancellations/${view.id}/confirmation/send`,
        headers: { cookie },
        payload: {},
      });
    expect((await send()).json().confirmationStatus).toBe('queued');
    await drainAllJobs(ctx);
    const stored = async () =>
      (await ctx.db.select().from(cancellations).where(eq(cancellations.id, view.id)))[0]!;
    expect((await stored()).confirmationStatus).toBe('failed');
    const failed = (await deliveriesOfKind('cancellation_confirmation'))[0]!;
    expect(failed.status).toBe('failed');

    ctx.mailGateway.reset();
    const again = await send();
    expect(again.statusCode).toBe(200);
    expect(again.json().confirmationStatus).toBe('queued');
    await drainAllJobs(ctx);
    expect(ctx.mailGateway.sent).toHaveLength(1);
    const deliveries = await deliveriesOfKind('cancellation_confirmation');
    expect(deliveries).toHaveLength(2);
    const retry = deliveries.find((d) => d.id !== failed.id)!;
    expect(retry).toMatchObject({
      status: 'sent',
      idempotencyKey: `cancellation_confirmation:${view.id}:retry:${failed.id}`,
    });
    expect(await stored()).toMatchObject({
      confirmationStatus: 'sent',
      confirmationMailDeliveryId: retry.id,
    });
    // Genau ein erfolgreicher Versand je Storno – weitere Klicks sind No-ops.
    expect((await send()).json().confirmationStatus).toBe('sent');
    await drainAllJobs(ctx);
    expect(ctx.mailGateway.attempts).toHaveLength(1);
  });
});
