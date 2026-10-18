/**
 * Phase-11-Pflichttests Security 114–123 (Order §§19, 55, 56, 59):
 * Offer-Voucher-IDOR, neutrale identische Antworten für fremde/eingelöste/
 * abgelaufene/ungültige Codes, keine Client-Steuerung von Prozentsatz,
 * Betrag, Besitzer, Status oder Reservierung, keine direkte Reaktivierung.
 */
import { vouchers } from '@mietroyal/database';
import { VOUCHER_INVALID_MESSAGE } from '@mietroyal/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setCompletedVisibilityDays } from '../src/crm/settings-service.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { adminSession, resetForCancellationTests, staffWith } from './cancellation-helpers.ts';
import { createTestCustomer } from './crm-helpers.ts';
import {
  draftForCustomer,
  issueVoucherForCustomer,
  patchVoucher,
  versionRow,
  voucherRow,
  voucherWorld,
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

const UNKNOWN = '00000000-0000-4000-8000-000000000000';

async function apply(cookie: string, versionId: string, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: `/staff/offer-versions/${versionId}/voucher`,
    headers: { cookie },
    payload,
  });
}

/** Antwort ohne die per Request variierende correlationId. */
function neutral(body: Record<string, unknown>) {
  const error = { ...(body.error as Record<string, unknown>) };
  delete error.correlationId;
  return { ...body, error };
}

describe('Security (114–123)', () => {
  it('114. Offer-Voucher-IDOR: unbekannte/unsichtbare Version ⇒ 404, ohne Recht ⇒ 403; nichts angewendet', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    const staff = await staffWith(
      ctx,
      admin.id,
      ['process.view_all', 'customer.view', 'offer.view', 'offer.edit_draft'],
      'Sicht',
    );
    const unknown = await apply(staff.cookie, UNKNOWN, { code: world.code });
    expect(unknown.statusCode).toBe(404);
    const unknownDelete = await ctx.app.inject({
      method: 'DELETE',
      url: `/staff/offer-versions/${UNKNOWN}/voucher`,
      headers: { cookie: staff.cookie },
    });
    expect(unknownDelete.statusCode).toBe(404);

    // Ohne offer.edit_draft ⇒ 403 (kein Existenz-Orakel über die Version).
    const viewer = await staffWith(ctx, admin.id, ['process.view_all', 'offer.view'], 'Leser');
    expect((await apply(viewer.cookie, world.versionId, { code: world.code })).statusCode).toBe(
      403,
    );

    // Vorgang abschließen + Sichtbarkeit 0 Tage ⇒ für den Mitarbeiter unsichtbar ⇒ 404.
    const complete = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/complete`,
      headers: { cookie },
    });
    expect(complete.statusCode).toBe(200);
    await setCompletedVisibilityDays(ctx.db, admin.id, 0);
    const hidden = await apply(staff.cookie, world.versionId, { code: world.code });
    expect(hidden.statusCode).toBe(404);
    expect((await versionRow(ctx, world.versionId)).voucherId).toBeNull();
    expect((await voucherRow(ctx, world.voucherId)).status).toBe('active');
  });

  it('115./116./117. Fremder, eingelöster, abgelaufener und formal ungültiger Code ⇒ byte-identische neutrale 400-Antwort', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    // Fremder Kunde mit eigenem Gutschein (115).
    const stranger = await createTestCustomer(ctx, admin.id, {
      firstName: 'Fremd',
      lastName: 'Kunde',
      email: 'fremd@test.example',
    });
    const foreign = await issueVoucherForCustomer(ctx, admin.id, stranger.id);
    const foreignResponse = await apply(cookie, world.versionId, { code: foreign.code });
    // Eingelöster Gutschein des eigenen Kunden (117).
    const redeemed = await issueVoucherForCustomer(ctx, admin.id, world.customerId);
    await patchVoucher(ctx, redeemed.voucherId, { status: 'redeemed' });
    const redeemedResponse = await apply(cookie, world.versionId, { code: redeemed.code });
    // Abgelaufener Gutschein des eigenen Kunden (116).
    const expired = await issueVoucherForCustomer(ctx, admin.id, world.customerId);
    await patchVoucher(ctx, expired.voucherId, { expiresAt: new Date(Date.now() - 1000) });
    const expiredResponse = await apply(cookie, world.versionId, { code: expired.code });
    // Nicht existierender und formal ungültiger Code.
    const missingResponse = await apply(cookie, world.versionId, { code: 'MR20-AAAA-BBBB-CCCC' });
    const malformedResponse = await apply(cookie, world.versionId, { code: 'HALLO-WELT' });

    const responses = [
      foreignResponse,
      redeemedResponse,
      expiredResponse,
      missingResponse,
      malformedResponse,
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION');
      expect(response.json().error.message).toBe(VOUCHER_INVALID_MESSAGE);
      const text = JSON.stringify(response.json());
      expect(text).not.toContain(stranger.id);
      expect(text).not.toContain('expire');
      expect(text).not.toContain('redeem');
    }
    const reference = JSON.stringify(neutral(responses[0]!.json()));
    for (const response of responses.slice(1)) {
      expect(JSON.stringify(neutral(response.json()))).toBe(reference);
    }
    expect((await versionRow(ctx, world.versionId)).voucherId).toBeNull();
    // Ein gültiger Code des richtigen Kunden geht weiterhin (Kontrolle).
    expect((await apply(cookie, world.versionId, { code: world.code })).statusCode).toBe(200);
  });

  it('118.–122. discount_percent / voucher_discount_cents / owner / redeemed / reservation sind nie sendbar (400, nichts angewendet)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    const other = await draftForCustomer(ctx, admin.id, world.customerId);
    const attempts: Record<string, unknown>[] = [
      { code: world.code, discount_percent: 50 },
      { code: world.code, discountPercent: 50 },
      { code: world.code, voucher_discount_cents: 11999 },
      { code: world.code, voucherDiscountCents: 11999 },
      { code: world.code, owner: UNKNOWN },
      { code: world.code, customerId: UNKNOWN },
      { code: world.code, redeemed: false },
      { code: world.code, status: 'active' },
      { code: world.code, reservation: other.offerId },
      { code: world.code, reservedOfferId: other.offerId },
      { code: world.code, voucherId: UNKNOWN },
      { code: world.code, expiresAt: '2099-01-01T00:00:00.000Z' },
    ];
    for (const payload of attempts) {
      const response = await apply(cookie, world.versionId, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      const version = await versionRow(ctx, world.versionId);
      expect(version.voucherId, JSON.stringify(payload)).toBeNull();
      expect(version.voucherDiscountCents).toBe(0);
    }
    const voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('active');
    expect(voucher.reservedOfferId).toBeNull();
    expect(voucher.discountPercent).toBe(20);
    expect(voucher.customerId).toBe(world.customerId);

    // Regulär angewendet: 20 % serverseitig, unabhängig von jeder Eingabe.
    expect((await apply(cookie, world.versionId, { code: world.code })).statusCode).toBe(200);
    const applied = await versionRow(ctx, world.versionId);
    expect(applied.voucherDiscountCents).toBe(2400);
    // Entwurfs-PATCH kann weder Gutschein-ID noch Betrag setzen.
    const fresh = await draftForCustomer(ctx, admin.id, world.customerId);
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/offer-versions/${fresh.versionId}`,
      headers: { cookie },
      payload: { voucherId: world.voucherId, voucherDiscountCents: 5000 },
    });
    expect([200, 400]).toContain(patched.statusCode);
    const freshVersion = await versionRow(ctx, fresh.versionId);
    expect(freshVersion.voucherId).toBeNull();
    expect(freshVersion.voucherDiscountCents).toBe(0);
  });

  it('123. Keine direkte Reaktivierung/Statusänderung über die API; eingelöster Gutschein bleibt eingelöst', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    await patchVoucher(ctx, world.voucherId, { status: 'redeemed' });
    for (const [method, url] of [
      ['POST', `/staff/vouchers/${world.voucherId}/reactivate`],
      ['POST', `/staff/vouchers/${world.voucherId}/activate`],
      ['PATCH', `/staff/vouchers/${world.voucherId}`],
      ['PUT', `/staff/vouchers/${world.voucherId}`],
      ['DELETE', `/staff/vouchers/${world.voucherId}`],
      ['POST', `/staff/vouchers`],
      ['GET', `/staff/vouchers/${world.voucherId}/code`],
      ['POST', `/public/vouchers/validate`],
    ] as const) {
      const response = await ctx.app.inject({
        method,
        url,
        headers: { cookie },
        payload: { status: 'active', expiresAt: '2099-01-01T00:00:00.000Z', code: world.code },
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
    const voucher = (
      await ctx.db.select().from(vouchers).where(eq(vouchers.id, world.voucherId))
    )[0]!;
    expect(voucher.status).toBe('redeemed');
    // Und der eingelöste Code ist im Entwurf nicht mehr verwendbar.
    expect((await apply(cookie, world.versionId, { code: world.code })).statusCode).toBe(400);
  });
});
