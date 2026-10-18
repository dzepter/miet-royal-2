/**
 * Phase-11-Regressionstests zum adversarialen Review (R1–R5): Trigger-Verlust
 * bei Zahlungsstatus-Wechseln, Ablehnung einer ersetzten Version, Versionierung
 * aus einem toten Angebot, Ablaufrand bei der Annahme und Anzeige-Status einer
 * verwaisten Reservierung – über die ECHTEN Routen/Services gegen PostgreSQL.
 */
import { bookings } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthError } from '../src/auth/service.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { commerceServices } from './commerce-helpers.ts';
import { adminSession } from './settlement-helpers.ts';
import {
  allVouchers,
  completeCleaningViaRoute,
  drainJobs,
  paidSettledWorld,
  resetVoucherWorld,
  setPaymentViaRoute,
  vouchersForSettlement,
} from './voucher-helpers.ts';
import {
  draftForCustomer,
  patchVoucher,
  redemptionsFor,
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
  await resetVoucherWorld(ctx);
});

const DAY_MS = 86_400_000;

async function jobRows() {
  const rows = await ctx.pool.query<{ status: string; idempotency_key: string }>(
    `SELECT status, idempotency_key FROM integration_jobs WHERE type = 'voucher.eligibility_check' ORDER BY created_at`,
  );
  return rows.rows;
}

async function applyViaRoute(cookie: string, versionId: string, code: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/staff/offer-versions/${versionId}/voucher`,
    headers: { cookie },
    payload: { code },
  });
}

async function sendViaRoute(cookie: string, versionId: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/staff/offer-versions/${versionId}/send`,
    headers: { cookie },
  });
}

async function declineViaRoute(cookie: string, versionId: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/staff/offer-versions/${versionId}/decline`,
    headers: { cookie },
  });
}

async function customerViaRoute(cookie: string, customerId: string) {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/staff/customers/${customerId}`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    voucher: { id: string; status: string; reservedOfferId: string | null } | null;
  };
}

function tokenOf(sent: { json(): unknown }): string {
  return ((sent.json() as { publicPath: string }).publicPath ?? '').replace('/angebot/', '');
}

/** Angebot A (mit Gutschein) versenden – optional mit abweichendem Versandzeitpunkt. */
async function sendViaService(adminId: string, versionId: string, now?: Date) {
  const services = commerceServices(ctx);
  const effective = await ctx.auth.effectivePermissions(adminId);
  return services.offers.send(adminId, versionId, effective, now);
}

describe('R1. Trigger-Verlust bei Zahlungsstatus-Wechseln', () => {
  it('R1. paid (Fenster offen) → overdue → Reinigung fertig → erneut paid ⇒ neuer Job ⇒ genau EIN Gutschein; paid → paid erzeugt keinen Job', async () => {
    const { admin, cookie } = await adminSession(ctx);
    // Bezahlt, während die Maschine noch in der Reinigung ist ⇒ Job läuft ineligible.
    const paid = await paidSettledWorld(ctx, admin.id, cookie);
    expect(await drainJobs(ctx)).toBeGreaterThan(0);
    expect(await allVouchers(ctx)).toEqual([]);
    const firstPaidJobs = (await jobRows()).filter((job) => job.idempotency_key.includes(':paid:'));
    expect(firstPaidJobs).toHaveLength(1);

    // Zahlungsstatus kippt auf überfällig.
    await setPaymentViaRoute(ctx, cookie, paid.transferId, 'overdue');
    // Reinigung endet – Trigger B reiht bei „überfällig“ nichts ein.
    await completeCleaningViaRoute(ctx, cookie, paid.world.machineCodes[0]!);
    expect((await jobRows()).some((job) => job.idempotency_key.includes(':cleaning:'))).toBe(false);
    await drainJobs(ctx);
    expect(await allVouchers(ctx)).toEqual([]);

    // Erneut bezahlt ⇒ echter Statuswechsel ⇒ neuer Job (Schlüssel enthält Zeitstempel).
    await setPaymentViaRoute(ctx, cookie, paid.transferId, 'paid');
    const paidJobs = (await jobRows()).filter((job) => job.idempotency_key.includes(':paid:'));
    expect(paidJobs).toHaveLength(2);
    expect(new Set(paidJobs.map((job) => job.idempotency_key)).size).toBe(2);
    expect(await drainJobs(ctx)).toBeGreaterThan(0);
    expect(await vouchersForSettlement(ctx, paid.settlementId)).toHaveLength(1);
    expect(await allVouchers(ctx)).toHaveLength(1);

    // paid → paid erneut: kein Statuswechsel ⇒ kein weiterer Job, weiterhin ein Gutschein.
    await setPaymentViaRoute(ctx, cookie, paid.transferId, 'paid');
    await setPaymentViaRoute(ctx, cookie, paid.transferId, 'paid');
    expect((await jobRows()).filter((job) => job.idempotency_key.includes(':paid:'))).toHaveLength(
      2,
    );
    await drainJobs(ctx);
    expect(await allVouchers(ctx)).toHaveLength(1);
  });
});

describe('R2. Ablehnung einer ersetzten (superseded) Version', () => {
  it('R2. Decline auf v1 nach Versand von v2 ⇒ 409, Reservierung bleibt bei A, B blockiert, Annahme von v2 löst ein', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    const second = await draftForCustomer(ctx, admin.id, world.customerId);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    expect((await applyViaRoute(cookie, second.versionId, world.code)).statusCode).toBe(200);
    expect((await sendViaRoute(cookie, world.versionId)).statusCode).toBe(200);

    const v2 = await commerceServices(ctx).offers.createNewVersion(admin.id, world.offerId, 'v2');
    const sentV2 = await sendViaRoute(cookie, v2.versionId);
    expect(sentV2.statusCode).toBe(200);
    const tokenV2 = tokenOf(sentV2);
    expect(tokenV2).not.toBe('');

    // Ablehnung der ersetzten v1 ⇒ 409, nichts verändert.
    const decline = await declineViaRoute(cookie, world.versionId);
    expect(decline.statusCode).toBe(409);
    expect(decline.json().error.code).toBe('CONFLICT');
    const v1 = await versionRow(ctx, world.versionId);
    expect(v1.status).toBe('sent');
    expect(v1.declinedAt).toBeNull();
    expect(v1.supersededAt).not.toBeNull();
    expect((await versionRow(ctx, v2.versionId)).status).toBe('sent');
    let voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('reserved');
    expect(voucher.reservedOfferId).toBe(world.offerId);

    // Zweites Angebot desselben Kunden kann nicht senden.
    const blocked = await sendViaRoute(cookie, second.versionId);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('VOUCHER_UNAVAILABLE');
    expect((await versionRow(ctx, second.versionId)).status).toBe('draft');
    voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('reserved');
    expect(voucher.reservedOfferId).toBe(world.offerId);

    // Annahme von A v2 über den öffentlichen Token gelingt ⇒ eingelöst.
    const accept = await ctx.app.inject({
      method: 'POST',
      url: `/public/offers/${tokenV2}/accept`,
    });
    expect(accept.statusCode).toBe(200);
    voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('redeemed');
    expect(voucher.reservedOfferId).toBeNull();
    expect(await redemptionsFor(ctx, world.voucherId)).toHaveLength(1);
    expect((await versionRow(ctx, v2.versionId)).status).toBe('accepted');
  });

  it('R2. Decline auf die aktuelle v2 ⇒ 200 und Reservierung freigegeben', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    expect((await sendViaRoute(cookie, world.versionId)).statusCode).toBe(200);
    const v2 = await commerceServices(ctx).offers.createNewVersion(admin.id, world.offerId, 'v2');
    expect((await sendViaRoute(cookie, v2.versionId)).statusCode).toBe(200);
    expect((await voucherRow(ctx, world.voucherId)).status).toBe('reserved');

    const decline = await declineViaRoute(cookie, v2.versionId);
    expect(decline.statusCode).toBe(200);
    expect((await versionRow(ctx, v2.versionId)).status).toBe('declined');
    const voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('active');
    expect(voucher.reservedOfferId).toBeNull();
    expect(voucher.reservedAt).toBeNull();
  });
});

describe('R3. Versionierung aus einem toten Angebot', () => {
  it('R3. Neue Version aus abgelaufenem Angebot: Entwurf trägt Gutschein, Reservierung frei; B reserviert; Versand von A v2 ⇒ 409', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id, { draft: { eventInDays: 40 } });
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    // Versand liegt 10 Tage zurück (Angebot max. 7 Tage gültig) ⇒ Angebot tot.
    await sendViaService(admin.id, world.versionId, new Date(Date.now() - 10 * DAY_MS));
    const v1 = await versionRow(ctx, world.versionId);
    expect(v1.status).toBe('sent');
    expect(v1.expiresAt!.getTime()).toBeLessThan(Date.now());
    let voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('reserved');
    expect(voucher.reservedOfferId).toBe(world.offerId);

    const v2 = await commerceServices(ctx).offers.createNewVersion(admin.id, world.offerId, 'neu');
    const draft = await versionRow(ctx, v2.versionId);
    expect(draft.status).toBe('draft');
    expect(draft.voucherId).toBe(world.voucherId);
    expect(draft.voucherDiscountCents).toBe(2400);
    voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('active');
    expect(voucher.reservedOfferId).toBeNull();
    expect(voucher.reservedAt).toBeNull();

    // Angebot B kann den Code anwenden und senden ⇒ reserviert für B.
    const second = await draftForCustomer(ctx, admin.id, world.customerId);
    expect((await applyViaRoute(cookie, second.versionId, world.code)).statusCode).toBe(200);
    expect((await sendViaRoute(cookie, second.versionId)).statusCode).toBe(200);
    voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('reserved');
    expect(voucher.reservedOfferId).toBe(second.offerId);

    // Versand von A v2 scheitert jetzt.
    const blocked = await sendViaRoute(cookie, v2.versionId);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('VOUCHER_UNAVAILABLE');
    expect((await versionRow(ctx, v2.versionId)).status).toBe('draft');
    voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('reserved');
    expect(voucher.reservedOfferId).toBe(second.offerId);
  });

  it('R3. Gegenprobe: Versionierung aus einem lebenden gesendeten Angebot behält die Reservierung', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    expect((await sendViaRoute(cookie, world.versionId)).statusCode).toBe(200);
    const v2 = await commerceServices(ctx).offers.createNewVersion(admin.id, world.offerId, null);
    expect((await versionRow(ctx, v2.versionId)).voucherId).toBe(world.voucherId);
    const voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('reserved');
    expect(voucher.reservedOfferId).toBe(world.offerId);
  });
});

describe('R4. Ablaufrand bei der Annahme', () => {
  it('R4. Annahme 500 ms vor Ablauf ⇒ VOUCHER_UNAVAILABLE (kein RangeError), nichts gebucht; 2 s davor gelingt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const expiresAt = new Date(Date.now() + DAY_MS);
    await patchVoucher(ctx, world.voucherId, { expiresAt });
    const sent = await sendViaRoute(cookie, world.versionId);
    expect(sent.statusCode).toBe(200);
    const token = tokenOf(sent);
    // Angebotsgültigkeit ist auf das Gutschein-Ablaufdatum gekappt.
    expect((await versionRow(ctx, world.versionId)).expiresAt?.getTime()).toBe(expiresAt.getTime());

    const services = commerceServices(ctx);
    const edge = new Date(expiresAt.getTime() - 500);
    let caught: unknown = null;
    try {
      await services.offers.accept(token, edge);
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    expect(caught).not.toBeInstanceOf(RangeError);
    expect(caught).toBeInstanceOf(AuthError);
    expect((caught as AuthError).code).toBe('VOUCHER_UNAVAILABLE');
    let voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('reserved');
    expect(voucher.reservedOfferId).toBe(world.offerId);
    expect(await redemptionsFor(ctx, world.voucherId)).toHaveLength(0);
    expect(
      await ctx.db.select().from(bookings).where(eq(bookings.offerId, world.offerId)),
    ).toHaveLength(0);
    expect((await versionRow(ctx, world.versionId)).status).toBe('sent');

    // 2 s vor Ablauf: Annahme gelingt, Restgültigkeit 2 s.
    const { bookingId } = await services.offers.accept(token, new Date(expiresAt.getTime() - 2000));
    expect(bookingId).toBeTruthy();
    voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('redeemed');
    const redemptions = await redemptionsFor(ctx, world.voucherId);
    expect(redemptions).toHaveLength(1);
    expect(redemptions[0]!.bookingId).toBe(bookingId);
    expect(redemptions[0]!.remainingValiditySeconds).toBe(2);
  });
});

describe('R5. Anzeige einer verwaisten Reservierung', () => {
  it('R5. Reservierung eines abgelaufenen Angebots wird als „active“ angezeigt (DB bleibt reserved); nach Apply in B freigegeben/neu reserviert', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id, { draft: { eventInDays: 40 } });
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    await sendViaService(admin.id, world.versionId, new Date(Date.now() - 10 * DAY_MS));
    let row = await voucherRow(ctx, world.voucherId);
    expect(row.status).toBe('reserved');
    expect(row.reservedOfferId).toBe(world.offerId);

    // Anzeige: lazy „Aktiv“, ohne Schreibzugriff.
    let view = await customerViaRoute(cookie, world.customerId);
    expect(view.voucher).toMatchObject({
      id: world.voucherId,
      status: 'active',
      reservedOfferId: null,
    });
    row = await voucherRow(ctx, world.voucherId);
    expect(row.status).toBe('reserved');
    expect(row.reservedOfferId).toBe(world.offerId);

    // Apply in Angebot B gibt die DB-Zeile frei (Entwurf reserviert nicht).
    const second = await draftForCustomer(ctx, admin.id, world.customerId);
    expect((await applyViaRoute(cookie, second.versionId, world.code)).statusCode).toBe(200);
    row = await voucherRow(ctx, world.voucherId);
    expect(row.status).toBe('active');
    expect(row.reservedOfferId).toBeNull();
    view = await customerViaRoute(cookie, world.customerId);
    expect(view.voucher).toMatchObject({ status: 'active', reservedOfferId: null });

    // Versand von B reserviert neu – Anzeige und DB stimmen überein.
    expect((await sendViaRoute(cookie, second.versionId)).statusCode).toBe(200);
    row = await voucherRow(ctx, world.voucherId);
    expect(row.status).toBe('reserved');
    expect(row.reservedOfferId).toBe(second.offerId);
    view = await customerViaRoute(cookie, world.customerId);
    expect(view.voucher).toMatchObject({ status: 'reserved', reservedOfferId: second.offerId });
  });
});
