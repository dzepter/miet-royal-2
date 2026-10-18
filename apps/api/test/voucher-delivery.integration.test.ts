/**
 * Phase-11-Pflichttests Delivery 97–105 (Order §§13, 15, 50, 51): Phase 11
 * versendet NICHT – Versandstatus pending, verschlüsselte Kopie vorhanden;
 * die Phase-12-Schnittstelle findet offene Zustellungen, entschlüsselt nur
 * serverseitig, markiert gesendet und entfernt die Kopie; der Hash bleibt
 * (Einlösbarkeit unverändert). Kunde ohne E-Mail verliert den Gutschein nicht.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@mietroyal/config';
import { normalizeVoucherCode } from '@mietroyal/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { VoucherDeliveryService } from '../src/voucher/voucher-delivery.ts';
import { hashVoucherCode } from '../src/voucher/voucher-codes.ts';
import {
  createTestContext,
  destroyTestContext,
  TEST_DATABASE_URL,
  type TestContext,
} from './auth-helpers.ts';
import { adminSession } from './settlement-helpers.ts';
import {
  completeCleaningViaRoute,
  drainJobs,
  paidSettledWorld,
  payAndCompleteWorld,
  resetVoucherWorld,
  setPaymentViaRoute,
  voucherDeliveryFor,
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

async function issuedVoucher() {
  const { admin, cookie } = await adminSession(ctx);
  const paid = await payAndCompleteWorld(ctx, admin.id, cookie);
  await drainJobs(ctx);
  const voucher = (await vouchersForSettlement(ctx, paid.settlementId))[0]!;
  return { admin, cookie, paid, voucher };
}

describe('Versand vorbereitet, nicht ausgeführt (Tests 97–104)', () => {
  it('97./98./99. Neuer Gutschein: delivery_status pending, nie sent, verschlüsselte Kopie vorhanden, kein Klartext', async () => {
    const { voucher } = await issuedVoucher();
    expect(voucher.deliveryStatus).toBe('pending');
    expect(voucher.deliveredAt).toBeNull();
    expect(voucher.deliveryProblemCode).toBeNull();
    expect(voucher.deliveryCodeCiphertext).not.toBeNull();
    expect(voucher.deliveryCodeCiphertext).toMatch(/^[A-Za-z0-9+/=]+$/);
    // Die Kopie ist kein Klartextcode und enthält auch das Suffix nicht im Klartext.
    expect(normalizeVoucherCode(voucher.deliveryCodeCiphertext!)).toBeNull();
    expect(voucher.deliveryCodeCiphertext).not.toContain(`MR20`);
    // Kein Mail-Adapter wurde bemüht (Phase 11 versendet nicht).
    expect(ctx.mail.sent).toHaveLength(0);
  });

  it('100./101. listPendingDeliveries liefert offene Zustellungen (älteste zuerst) und keine gesendeten', async () => {
    const { voucher } = await issuedVoucher();
    const delivery = voucherDeliveryFor(ctx);
    const pending = await delivery.listPendingDeliveries();
    expect(pending.map((entry) => entry.voucherId)).toEqual([voucher.id]);
    expect(pending[0]).toMatchObject({
      customerId: voucher.customerId,
      originProcessId: voucher.originProcessId,
      deliveryProblemCode: null,
    });
    // Die Pending-Liste trägt weder Kopie noch Hash.
    expect(JSON.stringify(pending)).not.toContain(voucher.codeHash);
    expect(JSON.stringify(pending)).not.toContain(voucher.deliveryCodeCiphertext!);
    await delivery.markDelivered(voucher.id, new Date());
    expect(await delivery.listPendingDeliveries()).toEqual([]);
    expect(await delivery.listPendingDeliveries(10)).toEqual([]);
  });

  it('102./103./104. revealCodeForDelivery nur serverseitig; markDelivered setzt sent + delivered_at, entfernt die Kopie; Hash bleibt und Code bleibt einlösbar', async () => {
    const { voucher, paid } = await issuedVoucher();
    const delivery = voucherDeliveryFor(ctx);
    const code = await delivery.revealCodeForDelivery(voucher.id);
    expect(normalizeVoucherCode(code)).toBe(code);
    expect(hashVoucherCode(code)).toBe(voucher.codeHash);
    expect(code.endsWith(voucher.codeSuffix)).toBe(true);
    const deliveredAt = new Date('2026-10-18T12:00:00.000Z');
    await delivery.markDelivered(voucher.id, deliveredAt);
    const after = (await voucherRow(ctx, voucher.id))!;
    expect(after.deliveryStatus).toBe('sent');
    expect(after.deliveredAt?.toISOString()).toBe(deliveredAt.toISOString());
    expect(after.deliveryCodeCiphertext).toBeNull();
    expect(after.codeHash).toBe(voucher.codeHash);
    expect(after.status).toBe('active');
    await expect(delivery.revealCodeForDelivery(voucher.id)).rejects.toThrow();
    // Idempotent: erneutes markDelivered ändert nichts Wesentliches.
    await delivery.markDelivered(voucher.id, new Date());
    expect((await voucherRow(ctx, voucher.id))!.deliveryStatus).toBe('sent');
    // Einlösbarkeit über den Hash unverändert.
    const validated = await voucherServiceFor(ctx).validateForOffer({
      code,
      customerId: paid.world.customerId,
      offerId: randomUUID(),
    });
    expect(validated.ok).toBe(true);
    const summary = await voucherServiceFor(ctx).customerVoucherSummary(paid.world.customerId);
    expect(summary).toMatchObject({ deliveryStatus: 'sent', deliveryLabel: 'Versendet' });
  });

  it('126. Kopie ist an den Umgebungsschlüssel gebunden: anderer AUTH_SECRET_KEY kann nicht entschlüsseln', async () => {
    const { voucher } = await issuedVoucher();
    const otherConfig = loadConfig({
      APP_ENV: 'development',
      DATABASE_URL: TEST_DATABASE_URL,
      AUTH_SECRET_KEY: 'another-environment-secret-key-xxxxxxxxxxxxxxxx',
    });
    const foreign = new VoucherDeliveryService(ctx.db, otherConfig);
    await expect(foreign.revealCodeForDelivery(voucher.id)).rejects.toThrow();
    await expect(voucherDeliveryFor(ctx).revealCodeForDelivery(voucher.id)).resolves.toMatch(
      /^MR20/,
    );
  });
});

describe('Kunde ohne E-Mail (Test 105)', () => {
  it('105. Gutschein entsteht trotzdem: pending mit Problemcode NO_EMAIL, keine erfundene Adresse, nicht gelöscht', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidSettledWorld(ctx, admin.id, cookie, { paymentStatus: 'open' });
    await ctx.pool.query(`UPDATE customers SET email = NULL WHERE id = $1`, [
      paid.world.customerId,
    ]);
    await setPaymentViaRoute(ctx, cookie, paid.transferId, 'paid');
    await completeCleaningViaRoute(ctx, cookie, paid.world.machineCodes[0]!);
    await drainJobs(ctx);
    const rows = await vouchersForSettlement(ctx, paid.settlementId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'active',
      deliveryStatus: 'pending',
      deliveryProblemCode: 'NO_EMAIL',
      deliveredAt: null,
    });
    expect(rows[0]!.deliveryCodeCiphertext).not.toBeNull();
    const customer = await ctx.pool.query<{ email: string | null }>(
      'SELECT email FROM customers WHERE id = $1',
      [paid.world.customerId],
    );
    expect(customer.rows[0]?.email).toBeNull();
    const pending = await voucherDeliveryFor(ctx).listPendingDeliveries();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.deliveryProblemCode).toBe('NO_EMAIL');
  });
});
