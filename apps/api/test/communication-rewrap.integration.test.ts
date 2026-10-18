/**
 * Phase 12 (mail) – CRYPTO/ROTATION 179–184 (Integrationsanteil, Order §8):
 * Rewrap-Command-Logik (`rewrapCommunicationSecrets`): Legacy-v1-Gutschein-
 * kopien ⇒ v2; Vorgängerschlüssel ⇒ aktueller Schlüssel; nicht
 * entschlüsselbar ⇒ delivery_problem_code (Gutschein/Hash/Ciphertext
 * unverändert, auch reserviert/eingelöst); Mail-Secret-Payloads nur
 * pending/retry; idempotent; Gutschein-Erzeugung schreibt v2;
 * revealCodeForDelivery liest v1 UND v2 und kapselt v1 sofort neu.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@mietroyal/config';
import { mailDeliveries, vouchers } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PayloadCrypto } from '../src/communication/payload-crypto.ts';
import {
  rewrapCommunicationSecrets,
  VOUCHER_DELIVERY_COPY_UNDECRYPTABLE,
} from '../src/communication/rewrap.ts';
import { encryptDeliveryCode } from '../src/voucher/voucher-crypto.ts';
import { VoucherDeliveryService } from '../src/voucher/voucher-delivery.ts';
import { hashVoucherCode } from '../src/voucher/voucher-codes.ts';
import {
  createTestContext,
  destroyTestContext,
  TEST_DATABASE_URL,
  type TestContext,
} from './auth-helpers.ts';
import { bookingRow } from './cancellation-helpers.ts';
import { createTestCustomer } from './crm-helpers.ts';
import { adminSession } from './settlement-helpers.ts';
import {
  drainJobs,
  payAndCompleteWorld,
  resetVoucherWorld,
  voucherRow,
  vouchersForSettlement,
} from './voucher-helpers.ts';
import { issueVoucherForCustomer } from './voucher-offer-helpers.ts';

let ctx: TestContext;
const KEY_B = 'rotated-communication-payload-key-B-0123456789';

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await ctx.pool.query('TRUNCATE mail_deliveries CASCADE');
  await resetVoucherWorld(ctx);
});

function cryptoFor(key: string, previous: string | null = null): PayloadCrypto {
  return new PayloadCrypto({
    ...ctx.config,
    communication: { payloadKey: key, payloadKeyPrevious: previous },
  });
}

async function legacyVoucher() {
  const { admin } = await adminSession(ctx);
  const customer = await createTestCustomer(ctx, admin.id, { email: 'wanda@test.example' });
  // issueVoucherForCustomer schreibt die Phase-11-Kopie (v1 aus AUTH_SECRET_KEY).
  const issued = await issueVoucherForCustomer(ctx, admin.id, customer.id);
  const before = (await voucherRow(ctx, issued.voucherId))!;
  expect(before.deliveryCodeCiphertext).toMatch(/^[A-Za-z0-9+/=]+$/);
  return { ...issued, before, customer, admin };
}

describe('Rewrap (Tests 179–184)', () => {
  it('180./182. v1 ⇒ v2 mit aktuellem Schlüssel; Hash/Status unverändert; Klartext weiterhin lesbar; zweiter Lauf idempotent', async () => {
    const { voucherId, compact, before } = await legacyVoucher();
    const crypto = new PayloadCrypto(ctx.config);
    const first = await rewrapCommunicationSecrets(ctx.db, crypto);
    expect(first.vouchers).toEqual({ scanned: 1, current: 0, rewrapped: 1, undecryptable: 0 });
    const after = (await voucherRow(ctx, voucherId))!;
    expect(after.deliveryCodeCiphertext).toMatch(/^v2:[0-9a-f]{12}:/);
    expect(after.deliveryCodeCiphertext).not.toBe(before.deliveryCodeCiphertext);
    expect(after.codeHash).toBe(before.codeHash);
    expect(after.codeHash).toBe(hashVoucherCode(compact));
    expect(after.status).toBe(before.status);
    expect(after.deliveryProblemCode).toBeNull();
    expect(crypto.decrypt(after.deliveryCodeCiphertext!, 'voucher-delivery', voucherId)).toBe(
      compact,
    );
    expect(JSON.stringify(after)).not.toContain(compact.slice(4));
    const second = await rewrapCommunicationSecrets(ctx.db, crypto);
    expect(second.vouchers).toEqual({ scanned: 1, current: 1, rewrapped: 0, undecryptable: 0 });
    expect((await voucherRow(ctx, voucherId))!.deliveryCodeCiphertext).toBe(
      after.deliveryCodeCiphertext,
    );
  });

  it('181./183. Current/Previous: v2 unter dem Vorgängerschlüssel wird auf den aktuellen Schlüssel gehoben; ohne Previous ⇒ nicht entschlüsselbar', async () => {
    const { voucherId, compact } = await legacyVoucher();
    const keyA = ctx.config.communication.payloadKey;
    await rewrapCommunicationSecrets(ctx.db, cryptoFor(keyA));
    const underA = (await voucherRow(ctx, voucherId))!.deliveryCodeCiphertext!;
    // Rotation: B aktuell, A Vorgänger.
    const rotated = cryptoFor(KEY_B, keyA);
    expect(rotated.inspect(underA).current).toBe(false);
    const result = await rewrapCommunicationSecrets(ctx.db, rotated);
    expect(result.vouchers).toEqual({ scanned: 1, current: 0, rewrapped: 1, undecryptable: 0 });
    const underB = (await voucherRow(ctx, voucherId))!.deliveryCodeCiphertext!;
    expect(underB).not.toBe(underA);
    expect(rotated.inspect(underB)).toMatchObject({ version: 'v2', current: true });
    expect(cryptoFor(KEY_B).decrypt(underB, 'voucher-delivery', voucherId)).toBe(compact);
    // Previous entfernt ⇒ alter Ciphertext wäre UNKNOWN_KEY (hier bereits gehoben, daher lesbar).
    expect(() => cryptoFor(KEY_B).decrypt(underA, 'voucher-delivery', voucherId)).toThrow(
      /UNKNOWN_KEY/,
    );
  });

  it('184. Nicht entschlüsselbar ⇒ delivery_problem_code DELIVERY_COPY_UNDECRYPTABLE; Ciphertext, Hash, Status (reserviert/eingelöst) unverändert; kein Codewechsel', async () => {
    const { voucherId, before, origin } = await legacyVoucher();
    // Kopie stammt aus einer fremden Umgebung (anderer AUTH_SECRET_KEY) – Legacy nicht lesbar.
    const foreign = encryptDeliveryCode(
      'MR20ZZZZZZZZZZZZ',
      voucherId,
      'foreign-auth-secret-key-xxxxxxxxxxxxxxxxxxxx',
    );
    const offerId = (await bookingRow(ctx, origin.bookingId)).offerId;
    await ctx.db
      .update(vouchers)
      .set({
        deliveryCodeCiphertext: foreign,
        status: 'reserved',
        reservedOfferId: offerId,
        reservedAt: new Date(),
      })
      .where(eq(vouchers.id, voucherId));
    const result = await rewrapCommunicationSecrets(ctx.db, new PayloadCrypto(ctx.config));
    expect(result.vouchers).toEqual({ scanned: 1, current: 0, rewrapped: 0, undecryptable: 1 });
    const after = (await voucherRow(ctx, voucherId))!;
    expect(after).toMatchObject({
      deliveryProblemCode: VOUCHER_DELIVERY_COPY_UNDECRYPTABLE,
      deliveryCodeCiphertext: foreign,
      codeHash: before.codeHash,
      status: 'reserved',
      deliveryStatus: 'pending',
    });
    // Der Problemcode ist im Pending-Listing für Admins sichtbar; der Hash bleibt prüfbar.
    const pending = await new VoucherDeliveryService(ctx.db, ctx.config).listPendingDeliveries();
    expect(pending.map((p) => p.deliveryProblemCode)).toEqual([
      VOUCHER_DELIVERY_COPY_UNDECRYPTABLE,
    ]);
    await expect(
      new VoucherDeliveryService(ctx.db, ctx.config).revealCodeForDelivery(voucherId),
    ).rejects.toThrow();
  });

  it('Mail-Secret-Payloads: pending/retry (Härtung RA-4: alle außer sent) werden neu gekapselt, sent übersprungen, nicht lesbar ⇒ blocked SECRET_UNDECRYPTABLE', async () => {
    const keyA = ctx.config.communication.payloadKey;
    const cryptoA = cryptoFor(keyA);
    const ids = {
      pending: randomUUID(),
      retry: randomUUID(),
      sent: randomUUID(),
      broken: randomUUID(),
    };
    const base = (id: string, status: 'pending' | 'retry' | 'sent', ciphertext: string | null) => ({
      id,
      kind: 'offer' as const,
      recipientEmail: 'kunde@example.org',
      subject: 'Test',
      templateKind: 'offer',
      context: {},
      secretPayloadCiphertext: ciphertext,
      status,
      idempotencyKey: `rewrap:${id}`,
      messageId: `<${id}@miet-royal.local>`,
    });
    const foreignCrypto = cryptoFor('completely-foreign-communication-key-0123456789');
    await ctx.db
      .insert(mailDeliveries)
      .values([
        base(
          ids.pending,
          'pending',
          cryptoA.encrypt('{"offerToken":"t1"}', 'mail-secret-payload', ids.pending),
        ),
        base(
          ids.retry,
          'retry',
          cryptoA.encrypt('{"offerToken":"t2"}', 'mail-secret-payload', ids.retry),
        ),
        base(ids.sent, 'sent', null),
        base(
          ids.broken,
          'pending',
          foreignCrypto.encrypt('{"offerToken":"t3"}', 'mail-secret-payload', ids.broken),
        ),
      ]);
    const rotated = cryptoFor(KEY_B, keyA);
    const result = await rewrapCommunicationSecrets(ctx.db, rotated);
    expect(result.mailDeliveries).toEqual({
      scanned: 3,
      current: 0,
      rewrapped: 2,
      undecryptable: 1,
    });
    const rows = Object.fromEntries(
      (await ctx.db.select().from(mailDeliveries)).map((r) => [r.id, r]),
    );
    expect(rotated.inspect(rows[ids.pending]!.secretPayloadCiphertext!)).toMatchObject({
      current: true,
    });
    expect(
      cryptoFor(KEY_B).decrypt(
        rows[ids.retry]!.secretPayloadCiphertext!,
        'mail-secret-payload',
        ids.retry,
      ),
    ).toBe('{"offerToken":"t2"}');
    expect(rows[ids.sent]).toMatchObject({ status: 'sent', secretPayloadCiphertext: null });
    expect(rows[ids.broken]).toMatchObject({
      status: 'blocked',
      blockedReason: 'SECRET_UNDECRYPTABLE',
    });
    expect(await rewrapCommunicationSecrets(ctx.db, rotated)).toMatchObject({
      mailDeliveries: { scanned: 2, current: 2, rewrapped: 0, undecryptable: 0 },
    });
  });

  it('Gutschein-Erzeugung schreibt v2 (COMMUNICATION_PAYLOAD_KEY); anderer Communication-Key liest nicht; AUTH_SECRET_KEY ist irrelevant', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await payAndCompleteWorld(ctx, admin.id, cookie);
    await drainJobs(ctx);
    const voucher = (await vouchersForSettlement(ctx, paid.settlementId))[0]!;
    expect(voucher.deliveryCodeCiphertext).toMatch(/^v2:[0-9a-f]{12}:/);
    const otherAuth = loadConfig({
      APP_ENV: 'development',
      DATABASE_URL: TEST_DATABASE_URL,
      AUTH_SECRET_KEY: 'another-auth-secret-key-xxxxxxxxxxxxxxxxxxxxxxxx',
    });
    await expect(
      new VoucherDeliveryService(ctx.db, otherAuth).revealCodeForDelivery(voucher.id),
    ).resolves.toMatch(/^MR20/);
    const otherKey = loadConfig({
      APP_ENV: 'development',
      DATABASE_URL: TEST_DATABASE_URL,
      COMMUNICATION_PAYLOAD_KEY: 'another-communication-key-xxxxxxxxxxxxxxxxxxxxxx',
    });
    await expect(
      new VoucherDeliveryService(ctx.db, otherKey).revealCodeForDelivery(voucher.id),
    ).rejects.toThrow();
    expect(await rewrapCommunicationSecrets(ctx.db, new PayloadCrypto(ctx.config))).toMatchObject({
      vouchers: { scanned: 1, current: 1, rewrapped: 0 },
    });
  });

  it('revealCodeForDelivery liest Legacy v1 und kapselt die Kopie sofort als v2 neu (Hash unverändert)', async () => {
    const { voucherId, compact, before } = await legacyVoucher();
    const service = new VoucherDeliveryService(ctx.db, ctx.config);
    expect(await service.revealCodeForDelivery(voucherId)).toBe(compact);
    const after = (await voucherRow(ctx, voucherId))!;
    expect(after.deliveryCodeCiphertext).toMatch(/^v2:/);
    expect(after.codeHash).toBe(before.codeHash);
    expect(await service.revealCodeForDelivery(voucherId)).toBe(compact);
    expect((await voucherRow(ctx, voucherId))!.deliveryCodeCiphertext).toBe(
      after.deliveryCodeCiphertext,
    );
  });
});
