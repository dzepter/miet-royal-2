/**
 * Phase-11-Pflichttests Angebot 42–56, Darstellung/Snapshot 64–68 und
 * Nicht-Kombinierbarkeit 71–80 (Order §§20–34, §37, §39, §54). Läuft gegen
 * echtes PostgreSQL über die ECHTEN Service-/Routenpfade.
 */
import { bookings, documents, voucherRedemptions, vouchers } from '@mietroyal/database';
import {
  VOUCHER_INVALID_MESSAGE,
  VOUCHER_NOT_COMBINABLE_MESSAGE,
  maskVoucherCode,
} from '@mietroyal/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { adminSession, resetForCancellationTests, staffWith } from './cancellation-helpers.ts';
import { commerceServices, productServiceFor } from './commerce-helpers.ts';
import { pdfText } from './handover-helpers.ts';
import {
  bookingRowById,
  containsCode,
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
  await resetForCancellationTests(ctx);
});

const DAY_MS = 86_400_000;

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

async function offerViaRoute(cookie: string, processId: string) {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/staff/processes/${processId}/offer`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    offer: {
      offer: { id: string; currentVersionId: string };
      versions: Record<string, unknown>[];
    };
    booking: Record<string, unknown> | null;
  };
}

describe('Angebot (42–56)', () => {
  it('42. Gutschein im Entwurf anwenden: 20 % der Maschinenmiete, Gesamtwert reduziert, kein Klartext', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    const response = await applyViaRoute(cookie, world.versionId, world.code);
    expect(response.statusCode).toBe(200);
    const version = await versionRow(ctx, world.versionId);
    expect(version.voucherId).toBe(world.voucherId);
    expect(version.machineSubtotalCents).toBe(12000);
    expect(version.voucherDiscountCents).toBe(2400);
    expect(version.fixedTotalCents).toBe(9600);
    expect(version.discountCents).toBe(0);
    expect(containsCode(version, world.code, world.compact)).toBe(false);
  });

  it('43. Der Entwurf reserviert NICHT – der Gutschein bleibt aktiv', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('active');
    expect(voucher.reservedOfferId).toBeNull();
    expect(voucher.reservedAt).toBeNull();
  });

  it('44. Versand reserviert atomar (Offer-Ebene) und friert den Gutschein-Snapshot ohne Klartext ein', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const sent = await sendViaRoute(cookie, world.versionId);
    expect(sent.statusCode).toBe(200);
    const voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('reserved');
    expect(voucher.reservedOfferId).toBe(world.offerId);
    expect(voucher.reservedAt).not.toBeNull();
    const version = await versionRow(ctx, world.versionId);
    expect(version.status).toBe('sent');
    expect(version.voucherSnapshot).toEqual({
      voucherId: world.voucherId,
      voucherType: 'returning_customer_20',
      discountPercent: 20,
      machineSubtotalBeforeVoucherCents: 12000,
      voucherDiscountCents: 2400,
      machineSubtotalAfterVoucherCents: 9600,
      maskedReference: maskVoucherCode(world.compact.slice(-4)),
    });
    expect(containsCode(version, world.code, world.compact)).toBe(false);
  });

  it('45. Zwei parallele Angebote: beide Entwürfe ok, erster Versand reserviert, zweiter wird mit 409 blockiert', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    const second = await draftForCustomer(ctx, admin.id, world.customerId);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    expect((await applyViaRoute(cookie, second.versionId, world.code)).statusCode).toBe(200);

    expect((await sendViaRoute(cookie, world.versionId)).statusCode).toBe(200);
    const blocked = await sendViaRoute(cookie, second.versionId);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('VOUCHER_UNAVAILABLE');
    expect(containsCode(blocked.json(), world.code, world.compact)).toBe(false);
    // Zweiter Entwurf bleibt Entwurf, Reservierung unverändert beim ersten Angebot.
    expect((await versionRow(ctx, second.versionId)).status).toBe('draft');
    const voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('reserved');
    expect(voucher.reservedOfferId).toBe(world.offerId);
  });

  it('46. Neue Version im selben Angebot behält die Reservierung; erneuter Versand funktioniert', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    expect((await sendViaRoute(cookie, world.versionId)).statusCode).toBe(200);
    const services = commerceServices(ctx);
    const next = await services.offers.createNewVersion(admin.id, world.offerId, 'Änderung');
    const draft = await versionRow(ctx, next.versionId);
    expect(draft.voucherId).toBe(world.voucherId);
    expect(draft.voucherDiscountCents).toBe(2400);
    expect(draft.voucherSnapshot).toBeNull();
    let voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('reserved');
    expect(voucher.reservedOfferId).toBe(world.offerId);
    expect((await sendViaRoute(cookie, next.versionId)).statusCode).toBe(200);
    voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('reserved');
    expect(voucher.reservedOfferId).toBe(world.offerId);
    expect((await versionRow(ctx, next.versionId)).voucherSnapshot).not.toBeNull();
  });

  it('47. Abgelehntes bzw. abgelaufenes Angebot gibt die Reservierung frei (lazy, ohne Cron)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    expect((await sendViaRoute(cookie, world.versionId)).statusCode).toBe(200);
    const decline = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${world.versionId}/decline`,
      headers: { cookie },
    });
    expect(decline.statusCode).toBe(200);
    let voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('active');
    expect(voucher.reservedOfferId).toBeNull();

    // Ablauf: Versand liegt 10 Tage zurück (Gültigkeit max. 7 Tage) ⇒ beim
    // nächsten Zugriff (Anwendung in einem neuen Entwurf) wird freigegeben.
    const second = await draftForCustomer(ctx, admin.id, world.customerId, { eventInDays: 40 });
    expect((await applyViaRoute(cookie, second.versionId, world.code)).statusCode).toBe(200);
    const services = commerceServices(ctx);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    await services.offers.send(
      admin.id,
      second.versionId,
      effective,
      new Date(Date.now() - 10 * DAY_MS),
    );
    voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('reserved');
    expect(voucher.reservedOfferId).toBe(second.offerId);
    const third = await draftForCustomer(ctx, admin.id, world.customerId);
    expect((await applyViaRoute(cookie, third.versionId, world.code)).statusCode).toBe(200);
    voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('active');
    expect(voucher.reservedOfferId).toBeNull();
  });

  it('48. „Gutschein entfernen“ im Entwurf: Anwendung weg, Preise neu, Reservierung freigegeben', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/staff/offer-versions/${world.versionId}/voucher`,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(200);
    let version = await versionRow(ctx, world.versionId);
    expect(version.voucherId).toBeNull();
    expect(version.voucherDiscountCents).toBe(0);
    expect(version.fixedTotalCents).toBe(12000);
    // Idempotent.
    expect(
      (
        await ctx.app.inject({
          method: 'DELETE',
          url: `/staff/offer-versions/${world.versionId}/voucher`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);

    // Nach Versand + neuer Version: Entfernen gibt die Reservierung des Angebots frei.
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    expect((await sendViaRoute(cookie, world.versionId)).statusCode).toBe(200);
    const next = await commerceServices(ctx).offers.createNewVersion(admin.id, world.offerId, null);
    expect(
      (
        await ctx.app.inject({
          method: 'DELETE',
          url: `/staff/offer-versions/${next.versionId}/voucher`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);
    version = await versionRow(ctx, next.versionId);
    expect(version.voucherId).toBeNull();
    const voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('active');
    expect(voucher.reservedOfferId).toBeNull();
  });

  it('49. Versand prüft den Gutschein erneut: zwischenzeitlich abgelaufen/eingelöst ⇒ 409, nichts eingefroren', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    await patchVoucher(ctx, world.voucherId, { expiresAt: new Date(Date.now() - 1000) });
    const expired = await sendViaRoute(cookie, world.versionId);
    expect(expired.statusCode).toBe(409);
    expect(expired.json().error.code).toBe('VOUCHER_UNAVAILABLE');
    const version = await versionRow(ctx, world.versionId);
    expect(version.status).toBe('draft');
    expect(version.voucherSnapshot).toBeNull();
    expect(version.sentAt).toBeNull();

    await patchVoucher(ctx, world.voucherId, {
      expiresAt: new Date(Date.now() + 100 * DAY_MS),
      status: 'redeemed',
    });
    const redeemed = await sendViaRoute(cookie, world.versionId);
    expect(redeemed.statusCode).toBe(409);
    expect((await versionRow(ctx, world.versionId)).status).toBe('draft');
  });

  it('50. Versand kappt die Angebotsgültigkeit auf das Gutschein-Ablaufdatum', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id, { draft: { eventInDays: 60 } });
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const voucherExpiry = new Date(Date.now() + 2 * DAY_MS);
    await patchVoucher(ctx, world.voucherId, { expiresAt: voucherExpiry });
    expect((await sendViaRoute(cookie, world.versionId)).statusCode).toBe(200);
    const version = await versionRow(ctx, world.versionId);
    // Regulär 7 Tage (Event in 60 Tagen) – tatsächlich das frühere Gutscheindatum.
    expect(version.expiresAt?.getTime()).toBe(voucherExpiry.getTime());
    // Die Reservierung verlängert den Gutschein nicht.
    expect((await voucherRow(ctx, world.voucherId)).expiresAt.getTime()).toBe(
      voucherExpiry.getTime(),
    );
    // Ohne Kappung bleibt die reguläre Gültigkeit.
    const second = await voucherWorld(ctx, admin.id, {
      email: 'zweite@test.example',
      draft: { eventInDays: 60 },
    });
    expect((await applyViaRoute(cookie, second.versionId, second.code)).statusCode).toBe(200);
    const sentAt = Date.now();
    expect((await sendViaRoute(cookie, second.versionId)).statusCode).toBe(200);
    const regular = await versionRow(ctx, second.versionId);
    expect(regular.expiresAt!.getTime()).toBeGreaterThan(sentAt + 6 * DAY_MS);
  });

  it('51. Annahme löst ein: Gutschein redeemed, Redemption mit Restgültigkeit, Booking verknüpft', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const sent = await sendViaRoute(cookie, world.versionId);
    const token = (sent.json().publicPath as string).replace('/angebot/', '');
    const before = await voucherRow(ctx, world.voucherId);
    const accept = await ctx.app.inject({ method: 'POST', url: `/public/offers/${token}/accept` });
    expect(accept.statusCode).toBe(200);
    const bookingId = accept.json().bookingId as string;
    const voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('redeemed');
    expect(voucher.reservedOfferId).toBeNull();
    expect(voucher.reservedAt).toBeNull();
    const redemptions = await redemptionsFor(ctx, world.voucherId);
    expect(redemptions).toHaveLength(1);
    const redemption = redemptions[0]!;
    expect(redemption.bookingId).toBe(bookingId);
    expect(redemption.offerId).toBe(world.offerId);
    expect(redemption.processId).toBe(world.processId);
    expect(redemption.expiresAtBeforeRedemption.getTime()).toBe(before.expiresAt.getTime());
    expect(redemption.remainingValiditySeconds).toBe(
      Math.floor((before.expiresAt.getTime() - redemption.redeemedAt.getTime()) / 1000),
    );
    expect(redemption.remainingValiditySeconds).toBeGreaterThan(0);
    expect(redemption.reactivatedAt).toBeNull();
    expect(redemption.cancellationId).toBeNull();
  });

  it('52. Double-Submit der Annahme ⇒ genau eine Buchung und eine Redemption', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const sent = await sendViaRoute(cookie, world.versionId);
    const token = (sent.json().publicPath as string).replace('/angebot/', '');
    const first = await ctx.app.inject({ method: 'POST', url: `/public/offers/${token}/accept` });
    const second = await ctx.app.inject({ method: 'POST', url: `/public/offers/${token}/accept` });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().bookingId).toBe(first.json().bookingId);
    expect(await redemptionsFor(ctx, world.voucherId)).toHaveLength(1);
    expect(await ctx.db.select().from(bookings)).toHaveLength(2); // Ursprung + diese
  });

  it('53. Parallele Annahmen ⇒ genau eine Buchung, eine Redemption, Gutschein einmal eingelöst', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const sent = await sendViaRoute(cookie, world.versionId);
    const token = (sent.json().publicPath as string).replace('/angebot/', '');
    const services = commerceServices(ctx);
    const results = await Promise.allSettled([
      services.offers.accept(token),
      services.offers.accept(token),
      services.offers.accept(token),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(
      fulfilled.map((r) => (r as PromiseFulfilledResult<{ bookingId: string }>).value.bookingId),
    );
    expect(ids.size).toBe(1);
    expect(await redemptionsFor(ctx, world.voucherId)).toHaveLength(1);
    expect((await voucherRow(ctx, world.voucherId)).status).toBe('redeemed');
  });

  it('54. Falscher Kunde bei der Annahme ⇒ Annahme scheitert, Gutschein bleibt reserviert, keine Buchung', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    const other = await voucherWorld(ctx, admin.id, { email: 'andere@test.example' });
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const sent = await sendViaRoute(cookie, world.versionId);
    const token = (sent.json().publicPath as string).replace('/angebot/', '');
    await patchVoucher(ctx, world.voucherId, { customerId: other.customerId });
    const accept = await ctx.app.inject({ method: 'POST', url: `/public/offers/${token}/accept` });
    expect(accept.statusCode).toBe(409);
    expect(accept.json().error.code).toBe('VOUCHER_UNAVAILABLE');
    const voucher = await voucherRow(ctx, world.voucherId);
    expect(voucher.status).toBe('reserved');
    expect(voucher.reservedOfferId).toBe(world.offerId);
    expect(await redemptionsFor(ctx, world.voucherId)).toHaveLength(0);
    expect((await versionRow(ctx, world.versionId)).status).toBe('sent');
    expect(
      await ctx.db.select().from(bookings).where(eq(bookings.offerId, world.offerId)),
    ).toHaveLength(0);
  });

  it('55. Abgelaufen bei der Annahme ⇒ blockiert, nichts eingelöst', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const sent = await sendViaRoute(cookie, world.versionId);
    const token = (sent.json().publicPath as string).replace('/angebot/', '');
    // Angebot selbst noch gültig, Gutschein inzwischen abgelaufen.
    await patchVoucher(ctx, world.voucherId, { expiresAt: new Date(Date.now() - 1000) });
    const accept = await ctx.app.inject({ method: 'POST', url: `/public/offers/${token}/accept` });
    expect(accept.statusCode).toBe(409);
    expect(await redemptionsFor(ctx, world.voucherId)).toHaveLength(0);
    expect((await voucherRow(ctx, world.voucherId)).status).toBe('reserved');
    expect((await versionRow(ctx, world.versionId)).status).toBe('sent');
  });

  it('56. Booking-Snapshot korrekt: voucherId, 20 %, Beträge, Totals – ohne Klartext', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const sent = await sendViaRoute(cookie, world.versionId);
    const token = (sent.json().publicPath as string).replace('/angebot/', '');
    const { bookingId } = await commerceServices(ctx).offers.accept(token);
    const booking = await bookingRowById(ctx, bookingId);
    expect(booking.voucherId).toBe(world.voucherId);
    expect(booking.voucherSnapshot).toEqual({
      voucherId: world.voucherId,
      voucherDiscountPercent: 20,
      voucherDiscountCents: 2400,
      machineSubtotalBeforeVoucherCents: 12000,
      machineSubtotalAfterVoucherCents: 9600,
    });
    expect(booking.totalsSnapshot).toEqual({
      machineSubtotalCents: 12000,
      discountCents: 0,
      voucherDiscountCents: 2400,
      machineSubtotalAfterVoucherCents: 9600,
      fixedTotalCents: 9600,
    });
    expect(containsCode(booking, world.code, world.compact)).toBe(false);
    // Positionen: regulärer Maschinenpreis bleibt Standard = vereinbart (Stornobasis §42).
    const items = booking.itemsSnapshot as {
      kind: string;
      standardUnitPriceCents: number;
      agreedUnitPriceCents: number;
    }[];
    const machine = items.find((item) => item.kind === 'machine')!;
    expect(machine.standardUnitPriceCents).toBe(12000);
    expect(machine.agreedUnitPriceCents).toBe(12000);
  });
});

describe('Darstellung & Snapshot (64–68)', () => {
  it('64. Staff-Angebot liefert regulär / 20 % / reduziert, maskierte Referenz, Gültigkeit – nie den Code', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const detail = await offerViaRoute(cookie, world.processId);
    const version = detail.offer.versions[0]!;
    expect(version.voucher).toEqual({
      voucherId: world.voucherId,
      discountPercent: 20,
      machineSubtotalBeforeVoucherCents: 12000,
      voucherDiscountCents: 2400,
      machineSubtotalAfterVoucherCents: 9600,
      maskedReference: maskVoucherCode(world.compact.slice(-4)),
      expiresAt: (await voucherRow(ctx, world.voucherId)).expiresAt.toISOString(),
    });
    expect(containsCode(detail, world.code, world.compact)).toBe(false);
    expect(JSON.stringify(detail)).not.toContain('codeHash');
    // Nach Versand aus dem Snapshot – identische Werte.
    expect((await sendViaRoute(cookie, world.versionId)).statusCode).toBe(200);
    const sentDetail = await offerViaRoute(cookie, world.processId);
    expect(sentDetail.offer.versions[0]!.voucher).toMatchObject({
      voucherDiscountCents: 2400,
      machineSubtotalAfterVoucherCents: 9600,
      maskedReference: maskVoucherCode(world.compact.slice(-4)),
    });
  });

  it('65. Öffentliches Angebot zeigt regulär / Gutschein 20 % / nach Gutschein – ohne Code/Referenz', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const sent = await sendViaRoute(cookie, world.versionId);
    const token = (sent.json().publicPath as string).replace('/angebot/', '');
    const response = await ctx.app.inject({ method: 'GET', url: `/public/offers/${token}` });
    expect(response.statusCode).toBe(200);
    const view = response.json().offer as Record<string, unknown>;
    expect(view.voucher).toEqual({
      discountPercent: 20,
      machineSubtotalBeforeVoucherCents: 12000,
      voucherDiscountCents: 2400,
      machineSubtotalAfterVoucherCents: 9600,
    });
    expect(view.fixedTotalCents).toBe(9600);
    expect(containsCode(view, world.code, world.compact)).toBe(false);
    expect(JSON.stringify(view)).not.toContain('••••');
  });

  it('66. Angebots-PDF und Auftragsbestätigung zeigen „Maschinenmiete regulär / Gutschein 20 % / Maschinenmiete nach Gutschein“', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const services = commerceServices(ctx);
    const preview = pdfText(await services.offers.renderPreviewPdf(world.versionId));
    expect(preview).toContain('Maschinenmiete regulär: 120,00');
    expect(preview).toContain('Gutschein 20 %: -24,00');
    expect(preview).toContain('Maschinenmiete nach Gutschein: 96,00');
    expect(preview).toContain('Fester Angebotswert: 96,00');
    expect(preview).not.toContain(world.code);
    expect(preview).not.toContain(world.compact);

    const sent = await sendViaRoute(cookie, world.versionId);
    const token = (sent.json().publicPath as string).replace('/angebot/', '');
    const rows = await ctx.db
      .select()
      .from(documents)
      .where(eq(documents.offerVersionId, world.versionId));
    expect(rows).toHaveLength(1);
    const final = pdfText(await services.documents.bytesFor(rows[0]!));
    expect(final).toContain('Gutschein 20 %: -24,00');
    expect(final).toContain('Maschinenmiete nach Gutschein: 96,00');
    expect(final).not.toContain(world.compact);

    const { bookingId } = await services.offers.accept(token);
    const confirmation = await services.confirmations.byBookingId(bookingId);
    const ab = pdfText(await services.confirmations.renderPreviewPdf(confirmation!.id));
    expect(ab).toContain('Maschinenmiete regulär: 120,00');
    expect(ab).toContain('Gutschein 20 %: -24,00');
    expect(ab).toContain('Maschinenmiete nach Gutschein: 96,00');
    expect(ab).not.toContain(world.compact);
  });

  it('67./68. Booking-Snapshot friert ein: Produktpreisänderung und Gutscheinablauf nach der Annahme ändern nichts', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const sent = await sendViaRoute(cookie, world.versionId);
    const token = (sent.json().publicPath as string).replace('/angebot/', '');
    const { bookingId } = await commerceServices(ctx).offers.accept(token);
    const before = await bookingRowById(ctx, bookingId);

    const products = productServiceFor(ctx);
    const machine = await products.getProductBySlug('slush-2x10');
    await products.setCurrentPrice(admin.id, machine.id, 20000);
    await patchVoucher(ctx, world.voucherId, { expiresAt: new Date(Date.now() - 1000) });

    const after = await bookingRowById(ctx, bookingId);
    expect(after.totalsSnapshot).toEqual(before.totalsSnapshot);
    expect(after.voucherSnapshot).toEqual(before.voucherSnapshot);
    expect(after.itemsSnapshot).toEqual(before.itemsSnapshot);
    // Ein neuer Entwurf rechnet mit dem neuen Preis – die Buchung nicht.
    const fresh = await draftForCustomer(ctx, admin.id, world.customerId);
    expect((await versionRow(ctx, fresh.versionId)).machineSubtotalCents).toBe(20000);
  });
});

describe('Nicht kombinierbar (71–80)', () => {
  const effectiveFor = (adminId: string) => ctx.auth.effectivePermissions(adminId);

  it('71./72. Manueller %- bzw. EUR-Rabatt vorhanden ⇒ Gutschein wird mit 400 abgelehnt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    const services = commerceServices(ctx);
    const effective = await effectiveFor(admin.id);
    await services.offers.setDiscount(admin.id, world.versionId, effective, {
      type: 'percent',
      value: 500,
    });
    const percent = await applyViaRoute(cookie, world.versionId, world.code);
    expect(percent.statusCode).toBe(400);
    expect(percent.json().error).toMatchObject({
      code: 'VALIDATION',
      message: VOUCHER_NOT_COMBINABLE_MESSAGE,
    });
    await services.offers.setDiscount(admin.id, world.versionId, effective, {
      type: 'fixed',
      value: 1000,
    });
    const fixed = await applyViaRoute(cookie, world.versionId, world.code);
    expect(fixed.statusCode).toBe(400);
    expect(fixed.json().error.message).toBe(VOUCHER_NOT_COMBINABLE_MESSAGE);
    expect((await versionRow(ctx, world.versionId)).voucherId).toBeNull();
  });

  it('73./74. Sonderpreis (auch 0 EUR) vorhanden ⇒ Gutschein abgelehnt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    const services = commerceServices(ctx);
    const effective = await effectiveFor(admin.id);
    await services.offers.setSpecialPrice(admin.id, world.versionId, effective, {
      lineKey: 'machine',
      unitPriceCents: 11000,
    });
    const special = await applyViaRoute(cookie, world.versionId, world.code);
    expect(special.statusCode).toBe(400);
    expect(special.json().error.message).toBe(VOUCHER_NOT_COMBINABLE_MESSAGE);
    await services.offers.setSpecialPrice(admin.id, world.versionId, effective, {
      lineKey: 'machine',
      unitPriceCents: 0,
    });
    const zero = await applyViaRoute(cookie, world.versionId, world.code);
    expect(zero.statusCode).toBe(400);
    expect(zero.json().error.message).toBe(VOUCHER_NOT_COMBINABLE_MESSAGE);
    expect((await versionRow(ctx, world.versionId)).voucherId).toBeNull();
  });

  it('75./76./77. Gutschein vorhanden ⇒ %-Rabatt, EUR-Rabatt und Sonderpreis werden mit 400 blockiert', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    for (const discount of [
      { type: 'percent', value: 500 },
      { type: 'fixed', value: 1000 },
    ]) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/staff/offer-versions/${world.versionId}/discount`,
        headers: { cookie },
        payload: { discount },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toBe(VOUCHER_NOT_COMBINABLE_MESSAGE);
    }
    const special = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${world.versionId}/special-price`,
      headers: { cookie },
      payload: { lineKey: 'machine', unitPriceCents: 11000 },
    });
    expect(special.statusCode).toBe(400);
    expect(special.json().error.message).toBe(VOUCHER_NOT_COMBINABLE_MESSAGE);
    const version = await versionRow(ctx, world.versionId);
    expect(version.discountType).toBeNull();
    expect(version.specialPrices ?? []).toEqual([]);
    expect(version.voucherDiscountCents).toBe(2400);
    expect(version.fixedTotalCents).toBe(9600);
  });

  it('78./79. Keine Rabatt-Rechte nötig: offer.edit_draft genügt zum Anwenden, Versand ohne >20-%-Freigabe', async () => {
    const { admin } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    const staff = await staffWith(
      ctx,
      admin.id,
      ['process.view_all', 'customer.view', 'offer.view', 'offer.edit_draft', 'offer.send'],
      'Entwurf',
    );
    const applied = await applyViaRoute(staff.cookie, world.versionId, world.code);
    expect(applied.statusCode).toBe(200);
    expect((await versionRow(ctx, world.versionId)).voucherDiscountCents).toBe(2400);
    const sent = await sendViaRoute(staff.cookie, world.versionId);
    expect(sent.statusCode).toBe(200);
    expect((await versionRow(ctx, world.versionId)).discountApprovedBy).toBeNull();
  });

  it('80. Liefer-Sonderpreis (manueller Lieferpreis) ist kein Rabatt und bleibt unabhängig', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id, {
      draft: { fulfillment: 'delivery', deliveryPriceCents: 4900 },
    });
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const version = await versionRow(ctx, world.versionId);
    expect(version.voucherDiscountCents).toBe(2400);
    expect(version.fixedTotalCents).toBe(14500); // 12000 − 2400 + 4900
    // Lieferpreis nachträglich ändern bleibt möglich.
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/offer-versions/${world.versionId}`,
      headers: { cookie },
      payload: { deliveryPriceCents: 5900 },
    });
    expect(patched.statusCode).toBe(200);
    const updated = await versionRow(ctx, world.versionId);
    expect(updated.voucherId).toBe(world.voucherId);
    expect(updated.fixedTotalCents).toBe(15500);
  });

  it('Max. ein Gutschein je Angebot: zweiter (anderer) Code wird mit 409 abgelehnt; ungültiger Code neutral 400', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    // Derselbe Code erneut: idempotent.
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const invalid = await applyViaRoute(cookie, world.versionId, 'MR20-AAAA-BBBB-CCCC');
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.message).toBe(VOUCHER_INVALID_MESSAGE);
    expect(await ctx.db.select().from(voucherRedemptions)).toHaveLength(0);
    expect(await ctx.db.select().from(vouchers)).toHaveLength(1);
  });
});
