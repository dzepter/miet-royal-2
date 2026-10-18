/**
 * Phase 11 Final – Pflichttests F1–F14 (Auftrag §1): Gutschein und Sonderpreis.
 * NUR ein Sonderpreis auf einer MASCHINEN-Position (auch 0 EUR) ist mit dem
 * Gutschein nicht kombinierbar – in beide Richtungen, inkl. Send-Revalidation
 * und Versionierung. Sonderpreise auf Kaufartikeln (Mischkanister) und
 * Kommissionsartikeln (Sirup/Becher) sowie der individuelle Lieferpreis sind
 * erlaubt; der Gutschein bleibt exakt 20 % der Maschinenmiet-Zwischensumme.
 * Entscheidung serverseitig anhand der berechneten Positionen (Kind
 * `machine`), nie anhand des Client-lineKeys. Läuft gegen echtes PostgreSQL
 * über die ECHTEN Service-/Routenpfade (Lexware-Fake für F14).
 */
import { offerLineItems, offerVersions } from '@mietroyal/database';
import {
  VOUCHER_LABEL,
  VOUCHER_NOT_COMBINABLE_MESSAGE,
  voucherDiscountCents,
} from '@mietroyal/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountingPayload } from '../src/accounting/gateway.ts';
import type { ProviderSnapshotV2 } from '../src/lexware/invoice-builder.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { adminSession } from './cancellation-helpers.ts';
import { commerceServices, productServiceFor } from './commerce-helpers.ts';
import {
  fakeInvoices,
  readyLexware,
  resetLexwareWorld,
  transferRowForSettlement,
} from './lexware-test-helpers.ts';
import { lineOf, post, settledReturn, settlementViewFor } from './settlement-helpers.ts';
import {
  bookingRowById,
  containsCode,
  issueVoucherForCustomer,
  versionRow,
  voucherWorld,
} from './voucher-offer-helpers.ts';

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

const MACHINE_2X10 = 12000;
const VOUCHER_2X10 = 2400;
const CANISTER = 500;
const SYRUP = 1200;

async function applyViaRoute(cookie: string, versionId: string, code: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/staff/offer-versions/${versionId}/voucher`,
    headers: { cookie },
    payload: { code },
  });
}

async function specialViaRoute(
  cookie: string,
  versionId: string,
  lineKey: string,
  unitPriceCents: number | null,
) {
  return ctx.app.inject({
    method: 'POST',
    url: `/staff/offer-versions/${versionId}/special-price`,
    headers: { cookie },
    payload: { lineKey, unitPriceCents },
  });
}

async function sendViaRoute(cookie: string, versionId: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/staff/offer-versions/${versionId}/send`,
    headers: { cookie },
  });
}

async function productId(slug: string): Promise<string> {
  return (await productServiceFor(ctx).getProductBySlug(slug)).id;
}

/** Welt: Maschine 2×10 (120 EUR) + 1 Mischkanister (Kauf) + 2 L Sirup Kirsche (Kommission). */
async function mixedWorld(adminId: string, extra: { delivery?: boolean } = {}) {
  const world = await voucherWorld(ctx, adminId, {
    draft: {
      selections: [
        { slug: 'mischkanister-6l', role: 'extra', quantity: 1 },
        { slug: 'sirup-kirsche', role: 'extra', quantity: 2 },
      ],
      ...(extra.delivery ? { fulfillment: 'delivery' as const, deliveryPriceCents: 4900 } : {}),
    },
  });
  return {
    ...world,
    canisterKey: `extra:${await productId('mischkanister-6l')}`,
    syrupKey: `extra:${await productId('sirup-kirsche')}`,
  };
}

function specialKeys(version: { specialPrices: unknown }): string[] {
  return ((version.specialPrices ?? []) as { lineKey: string }[]).map((e) => e.lineKey).sort();
}

describe('Gutschein + Sonderpreis: nur Maschinen-Sonderpreis blockiert (F1–F12)', () => {
  it('F1. Gutschein + Maschinen-Sonderpreis blockiert – auch bei Send-Revalidation/Recompute (inkonsistenter DB-Stand)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await mixedWorld(admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    // Maschinen-Sonderpreis am Service vorbei in die DB geschrieben: Der
    // Versand rechnet neu und MUSS strukturell (Preisengine) ablehnen.
    await ctx.db
      .update(offerVersions)
      .set({
        specialPrices: [
          {
            lineKey: 'machine',
            unitPriceCents: 11000,
            previousStandardCents: MACHINE_2X10,
            byUserId: admin.id,
            at: new Date().toISOString(),
          },
        ],
      })
      .where(eq(offerVersions.id, world.versionId));
    const sent = await sendViaRoute(cookie, world.versionId);
    expect(sent.statusCode).toBe(400);
    expect(sent.json().error.message).toBe(VOUCHER_NOT_COMBINABLE_MESSAGE);
    const version = await versionRow(ctx, world.versionId);
    expect(version.status).toBe('draft');
    expect(version.sentAt).toBeNull();
  });

  it('F2. Gutschein + 0-EUR-Maschinen-Sonderpreis blockiert (Route, 400, Entwurf unverändert)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await mixedWorld(admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const zero = await specialViaRoute(cookie, world.versionId, 'machine', 0);
    expect(zero.statusCode).toBe(400);
    expect(zero.json().error.message).toBe(VOUCHER_NOT_COMBINABLE_MESSAGE);
    const version = await versionRow(ctx, world.versionId);
    expect(version.voucherId).toBe(world.voucherId);
    expect(version.specialPrices ?? []).toEqual([]);
    expect(version.voucherDiscountCents).toBe(VOUCHER_2X10);
  });

  it('F3. Maschinen-Sonderpreis (auch 0 EUR) vorhanden ⇒ Gutschein anwenden blockiert', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await mixedWorld(admin.id);
    for (const cents of [11000, 0]) {
      expect((await specialViaRoute(cookie, world.versionId, 'machine', cents)).statusCode).toBe(
        200,
      );
      const response = await applyViaRoute(cookie, world.versionId, world.code);
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({
        code: 'VALIDATION',
        message: VOUCHER_NOT_COMBINABLE_MESSAGE,
      });
      expect((await versionRow(ctx, world.versionId)).voucherId).toBeNull();
    }
  });

  it('F4. Gutschein vorhanden ⇒ Maschinen-Sonderpreis setzen blockiert (400), Gutschein bleibt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await mixedWorld(admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const blocked = await specialViaRoute(cookie, world.versionId, 'machine', 11000);
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.message).toBe(VOUCHER_NOT_COMBINABLE_MESSAGE);
    const version = await versionRow(ctx, world.versionId);
    expect(version.voucherId).toBe(world.voucherId);
    expect(version.specialPrices ?? []).toEqual([]);
    expect(version.fixedTotalCents).toBe(MACHINE_2X10 - VOUCHER_2X10 + CANISTER);
  });

  it('F5. Gutschein + individueller Lieferpreis erlaubt (vorher und nachträglich)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await mixedWorld(admin.id, { delivery: true });
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const version = await versionRow(ctx, world.versionId);
    expect(version.voucherDiscountCents).toBe(VOUCHER_2X10);
    expect(version.fixedTotalCents).toBe(MACHINE_2X10 - VOUCHER_2X10 + CANISTER + 4900);
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/offer-versions/${world.versionId}`,
      headers: { cookie },
      payload: { deliveryPriceCents: 5900 },
    });
    expect(patched.statusCode).toBe(200);
    const updated = await versionRow(ctx, world.versionId);
    expect(updated.voucherId).toBe(world.voucherId);
    expect(updated.voucherDiscountCents).toBe(VOUCHER_2X10);
    expect(updated.fixedTotalCents).toBe(MACHINE_2X10 - VOUCHER_2X10 + CANISTER + 5900);
    // Ein "Sonderpreis" auf die Lieferposition gibt es nicht (Lieferpreis = manuell).
    expect((await specialViaRoute(cookie, world.versionId, 'delivery', 100)).statusCode).toBe(400);
  });

  it('F6. Kaufartikel-Sonderpreis (Mischkanister, auch 0 EUR) vorhanden ⇒ Gutschein erlaubt; Versand + neue Version übernehmen beides', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await mixedWorld(admin.id);
    expect(
      (await specialViaRoute(cookie, world.versionId, world.canisterKey, 400)).statusCode,
    ).toBe(200);
    const applied = await applyViaRoute(cookie, world.versionId, world.code);
    expect(applied.statusCode).toBe(200);
    let version = await versionRow(ctx, world.versionId);
    expect(version.voucherId).toBe(world.voucherId);
    expect(version.voucherDiscountCents).toBe(VOUCHER_2X10);
    expect(version.fixedTotalCents).toBe(MACHINE_2X10 - VOUCHER_2X10 + 400);
    expect(specialKeys(version)).toEqual([world.canisterKey]);
    // 0 EUR auf dem Kaufartikel bleibt ebenfalls erlaubt.
    expect((await specialViaRoute(cookie, world.versionId, world.canisterKey, 0)).statusCode).toBe(
      200,
    );
    version = await versionRow(ctx, world.versionId);
    expect(version.voucherDiscountCents).toBe(VOUCHER_2X10);
    expect(version.fixedTotalCents).toBe(MACHINE_2X10 - VOUCHER_2X10);
    // Versand (Recompute + Reservierung) und Versionierung wenden dieselbe Regel an.
    const sent = await sendViaRoute(cookie, world.versionId);
    expect(sent.statusCode).toBe(200);
    const frozen = await versionRow(ctx, world.versionId);
    expect(frozen.status).toBe('sent');
    expect(frozen.voucherDiscountCents).toBe(VOUCHER_2X10);
    const services = commerceServices(ctx);
    const next = await services.offers.createNewVersion(admin.id, world.offerId, 'Nachtrag');
    const draft = await versionRow(ctx, next.versionId);
    expect(draft.status).toBe('draft');
    expect(draft.voucherId).toBe(world.voucherId);
    expect(specialKeys(draft)).toEqual([world.canisterKey]);
    expect(draft.voucherDiscountCents).toBe(VOUCHER_2X10);
    expect(draft.fixedTotalCents).toBe(MACHINE_2X10 - VOUCHER_2X10);
  });

  it('F7. Sonderpreis auf Kommissionsartikel (Sirup, Becher) vorhanden ⇒ Gutschein erlaubt; Inklusiv-Positionen haben keinen Sonderpreis', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id, {
      draft: {
        selections: [
          { slug: 'sirup-kirsche', role: 'extra', quantity: 2 },
          { slug: 'becher-25', role: 'extra', quantity: 3 },
          { slug: 'sirup-waldmeister', role: 'free', quantity: 1 },
        ],
      },
    });
    const syrupKey = `extra:${await productId('sirup-kirsche')}`;
    const cupsKey = `extra:${await productId('becher-25')}`;
    expect((await specialViaRoute(cookie, world.versionId, syrupKey, 1000)).statusCode).toBe(200);
    expect((await specialViaRoute(cookie, world.versionId, cupsKey, 200)).statusCode).toBe(200);
    // Inklusiv-Positionen (Gratis-Sirup, Becher/Strohhalme inklusive) sind kein Sonderpreis-Ziel.
    const included = await specialViaRoute(cookie, world.versionId, 'included:cups', 1);
    expect(included.statusCode).toBe(400);
    expect(included.json().error.message).toContain('Inklusiv-Positionen');
    const applied = await applyViaRoute(cookie, world.versionId, world.code);
    expect(applied.statusCode).toBe(200);
    const version = await versionRow(ctx, world.versionId);
    expect(version.voucherId).toBe(world.voucherId);
    expect(version.voucherDiscountCents).toBe(VOUCHER_2X10);
    expect(version.fixedTotalCents).toBe(MACHINE_2X10 - VOUCHER_2X10);
    expect(specialKeys(version)).toEqual([syrupKey, cupsKey].sort());
    const offer = await commerceServices(ctx).offers.getOfferForProcess(world.processId);
    const current = offer!.versions.find((v) => v.id === world.versionId)!;
    const commission = current.lineItems.filter((item) => item.billingMode === 'commission');
    expect(commission.map((item) => item.totalCents).sort((a, b) => a - b)).toEqual([600, 2000]);
    expect(commission.every((item) => item.priceSource === 'special')).toBe(true);
  });

  it('F8. Nur Nicht-Maschinen-Sonderpreise (Kauf + Kommission) vorhanden ⇒ Gutschein anwenden erlaubt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await mixedWorld(admin.id);
    expect(
      (await specialViaRoute(cookie, world.versionId, world.canisterKey, 450)).statusCode,
    ).toBe(200);
    expect((await specialViaRoute(cookie, world.versionId, world.syrupKey, 1100)).statusCode).toBe(
      200,
    );
    const applied = await applyViaRoute(cookie, world.versionId, world.code);
    expect(applied.statusCode).toBe(200);
    const version = await versionRow(ctx, world.versionId);
    expect(version.voucherId).toBe(world.voucherId);
    expect(version.machineSubtotalCents).toBe(MACHINE_2X10);
    expect(version.voucherDiscountCents).toBe(VOUCHER_2X10);
    expect(version.fixedTotalCents).toBe(MACHINE_2X10 - VOUCHER_2X10 + 450);
    expect(specialKeys(version)).toEqual([world.canisterKey, world.syrupKey].sort());
  });

  it('F9. Gutschein aktiv ⇒ nachträglicher Nicht-Maschinen-Sonderpreis erlaubt (und wieder entfernbar), Maschine weiterhin blockiert', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await mixedWorld(admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    expect(
      (await specialViaRoute(cookie, world.versionId, world.canisterKey, 300)).statusCode,
    ).toBe(200);
    expect((await specialViaRoute(cookie, world.versionId, world.syrupKey, 900)).statusCode).toBe(
      200,
    );
    let version = await versionRow(ctx, world.versionId);
    expect(version.voucherId).toBe(world.voucherId);
    expect(version.voucherDiscountCents).toBe(VOUCHER_2X10);
    expect(version.fixedTotalCents).toBe(MACHINE_2X10 - VOUCHER_2X10 + 300);
    expect(specialKeys(version)).toEqual([world.canisterKey, world.syrupKey].sort());
    // Maschine bleibt gesperrt – auch wenn andere Sonderpreise bereits existieren.
    const machine = await specialViaRoute(cookie, world.versionId, 'machine', 11000);
    expect(machine.statusCode).toBe(400);
    expect(machine.json().error.message).toBe(VOUCHER_NOT_COMBINABLE_MESSAGE);
    // Zurücksetzen eines Nicht-Maschinen-Sonderpreises bleibt möglich.
    expect(
      (await specialViaRoute(cookie, world.versionId, world.canisterKey, null)).statusCode,
    ).toBe(200);
    version = await versionRow(ctx, world.versionId);
    expect(specialKeys(version)).toEqual([world.syrupKey]);
    expect(version.voucherDiscountCents).toBe(VOUCHER_2X10);
    expect(version.fixedTotalCents).toBe(MACHINE_2X10 - VOUCHER_2X10 + CANISTER);
  });

  it('F10. Gemischt (Maschine + Nicht-Maschine) ⇒ blockiert – in beide Richtungen', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await mixedWorld(admin.id);
    expect(
      (await specialViaRoute(cookie, world.versionId, world.canisterKey, 400)).statusCode,
    ).toBe(200);
    expect((await specialViaRoute(cookie, world.versionId, 'machine', 11000)).statusCode).toBe(200);
    const blocked = await applyViaRoute(cookie, world.versionId, world.code);
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.message).toBe(VOUCHER_NOT_COMBINABLE_MESSAGE);
    expect((await versionRow(ctx, world.versionId)).voucherId).toBeNull();
    // Maschinen-Sonderpreis entfernen ⇒ nur Kaufartikel-Sonderpreis bleibt ⇒ erlaubt.
    expect((await specialViaRoute(cookie, world.versionId, 'machine', null)).statusCode).toBe(200);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    // Mit aktivem Gutschein und Kaufartikel-Sonderpreis: Maschine ⇒ blockiert (gemischt).
    const mixed = await specialViaRoute(cookie, world.versionId, 'machine', 11000);
    expect(mixed.statusCode).toBe(400);
    expect(mixed.json().error.message).toBe(VOUCHER_NOT_COMBINABLE_MESSAGE);
    const version = await versionRow(ctx, world.versionId);
    expect(version.voucherId).toBe(world.voucherId);
    expect(specialKeys(version)).toEqual([world.canisterKey]);
  });

  it('F11. Gutscheinbetrag ist immer exakt 20 % der Maschinenmietsumme (mehrere Maschinen, Sonderpreise auf Zusatzartikeln)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id, {
      draft: {
        machineQuantity: 3,
        fulfillment: 'delivery',
        deliveryPriceCents: 1999,
        selections: [
          { slug: 'mischkanister-6l', role: 'extra', quantity: 2 },
          { slug: 'sirup-kirsche', role: 'extra', quantity: 1 },
        ],
      },
    });
    const canisterKey = `extra:${await productId('mischkanister-6l')}`;
    expect((await specialViaRoute(cookie, world.versionId, canisterKey, 123)).statusCode).toBe(200);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const version = await versionRow(ctx, world.versionId);
    expect(version.machineSubtotalCents).toBe(3 * MACHINE_2X10);
    expect(version.voucherDiscountCents).toBe(voucherDiscountCents(3 * MACHINE_2X10));
    expect(version.voucherDiscountCents).toBe(7200);
    expect(version.fixedTotalCents).toBe(3 * MACHINE_2X10 - 7200 + 2 * 123 + 1999);
    const offer = await commerceServices(ctx).offers.getOfferForProcess(world.processId);
    const current = offer!.versions.find((v) => v.id === world.versionId)!;
    expect(current.voucher).toMatchObject({
      machineSubtotalBeforeVoucherCents: 36000,
      voucherDiscountCents: 7200,
      machineSubtotalAfterVoucherCents: 28800,
    });
  });

  it('F12. Nicht-Maschinen-Sonderpreis beeinflusst den Gutscheinbetrag nicht (vor/nach identisch)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await mixedWorld(admin.id);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    const before = await versionRow(ctx, world.versionId);
    expect((await specialViaRoute(cookie, world.versionId, world.canisterKey, 50)).statusCode).toBe(
      200,
    );
    expect((await specialViaRoute(cookie, world.versionId, world.syrupKey, 10)).statusCode).toBe(
      200,
    );
    const after = await versionRow(ctx, world.versionId);
    expect(after.machineSubtotalCents).toBe(before.machineSubtotalCents);
    expect(after.voucherDiscountCents).toBe(before.voucherDiscountCents);
    expect(after.voucherDiscountCents).toBe(VOUCHER_2X10);
    // Nur der Kaufartikel-Anteil ändert sich (Kommission ist nicht Teil des festen Werts).
    expect(before.fixedTotalCents! - after.fixedTotalCents!).toBe(CANISTER - 50);
    const offer = await commerceServices(ctx).offers.getOfferForProcess(world.processId);
    const current = offer!.versions.find((v) => v.id === world.versionId)!;
    const syrup = current.lineItems.find(
      (item) => item.kind === 'syrup' && item.billingMode === 'commission',
    )!;
    expect(syrup.totalCents).toBe(2 * 10);
    expect(syrup.standardUnitPriceCents).toBe(SYRUP);
  });
});

interface LexwareLine {
  type: string;
  name: string;
  quantity: number;
  unitPrice: { currency: string; netAmount: number; taxRatePercentage: number };
}

function cents(amount: number): number {
  return Math.round(amount * 100);
}

describe('Abrechnung & Lexware mit Gutschein und Nicht-Maschinen-Sonderpreis (F13/F14)', () => {
  function voucherHook(adminId: string) {
    const state = { voucherId: '', code: '', compact: '' };
    const hook = async (customerId: string) => {
      const issued = await issueVoucherForCustomer(ctx, adminId, customerId);
      Object.assign(state, issued);
      return issued.code;
    };
    return { state, hook };
  }

  it('F13. Settlement enthält den Gutscheinrabatt exakt einmal; Kaufartikel mit Sonderpreis separat', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { state, hook } = voucherHook(admin.id);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, {
      selections: [{ slug: 'mischkanister-6l', role: 'extra', quantity: 1 }],
      specialPrices: [{ slug: 'mischkanister-6l', unitPriceCents: 400 }],
      machineCodes: ['MR-10-01-01'],
      voucherCodeFor: hook,
    });
    const discounts = lineOf(view, 'discount');
    expect(discounts).toHaveLength(1);
    expect(discounts[0]).toMatchObject({
      sourceType: 'booking_voucher',
      sourceId: state.voucherId,
      description: VOUCHER_LABEL,
      amountCents: 1500, // 20 % von 75,00 EUR (slush-1x10) – unabhängig vom Kanister-Sonderpreis
      direction: 'credit',
    });
    expect(lineOf(view, 'machine_rental')[0]!.amountCents).toBe(7500);
    const purchase = lineOf(view, 'purchase');
    expect(purchase).toHaveLength(1);
    expect(purchase[0]).toMatchObject({ quantity: 1, unitPriceCents: 400, amountCents: 400 });
    expect(view.settlement.discountCents).toBe(1500);
    expect(view.settlement.fixedTotalCents).toBe(6000); // 7500 − 1500; Kanister ist variabel
    expect(view.settlement.variableTotalCents).toBe(400);
    expect(view.settlement.amountDueCents).toBe(6400);
    expect(containsCode(view, state.code, state.compact)).toBe(false);
    // Neuaufbau ⇒ weiterhin genau eine Gutscheinzeile, Kaufartikel unverändert.
    const added = await post(ctx.app, cookie, `/staff/settlements/${view.settlement.id}/lines`, {
      type: 'manual_charge',
      description: 'Zusatz',
      amountCents: 100,
      version: view.settlement.version,
    });
    expect(added.status).toBe(200);
    const rebuilt = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(lineOf(rebuilt, 'discount')).toHaveLength(1);
    expect(lineOf(rebuilt, 'discount')[0]!.amountCents).toBe(1500);
    expect(lineOf(rebuilt, 'purchase')[0]!.amountCents).toBe(400);
  });

  it('F14. Lexware-Snapshot übernimmt Kaufartikel-Sonderpreis UND Gutscheinrabatt korrekt (Summe cent-genau, kein Code)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { state, hook } = voucherHook(admin.id);
    const { view } = await settledReturn(ctx, admin.id, cookie, {
      selections: [{ slug: 'mischkanister-6l', role: 'extra', quantity: 1 }],
      specialPrices: [{ slug: 'mischkanister-6l', unitPriceCents: 400 }],
      machineCodes: ['MR-10-01-02'],
      voucherCodeFor: hook,
    });
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const invoices = fakeInvoices(ctx);
    expect(invoices).toHaveLength(1);
    const invoice = invoices[0]!;
    const row = (await transferRowForSettlement(ctx, view.settlement.id))!;
    expect(row.status).toBe('succeeded');
    const payload = row.snapshot as AccountingPayload;
    const snapshot = row.providerSnapshot as ProviderSnapshotV2;
    expect(payload.lines.filter((line) => line.type === 'discount')).toHaveLength(1);
    expect(payload.lines.find((line) => line.type === 'discount')!.amountCents).toBe(1500);
    expect(payload.lines.filter((line) => line.type === 'purchase')).toHaveLength(1);
    expect(payload.lines.find((line) => line.type === 'purchase')!.amountCents).toBe(400);
    const mappedDiscount = snapshot.lines.find((line) => line.sourceType === 'discount')!;
    expect(mappedDiscount.amountCents).toBe(-1500);
    expect(mappedDiscount.category).toBe('machine_rental');
    const mappedPurchase = snapshot.lines.find((line) => line.sourceType === 'purchase')!;
    expect(mappedPurchase.amountCents).toBe(400);
    const items = invoice.lineItems as unknown as LexwareLine[];
    const negative = items.filter((item) => item.unitPrice.netAmount < 0);
    expect(negative).toHaveLength(1);
    expect(negative[0]!.name).toBe(VOUCHER_LABEL);
    expect(cents(negative[0]!.unitPrice.netAmount)).toBe(-1500);
    const canister = items.find((item) => item.name.includes('Mischkanister'))!;
    expect(canister.quantity).toBe(1);
    expect(cents(canister.unitPrice.netAmount)).toBe(400);
    expect(view.settlement.amountDueCents).toBe(6400); // 7500 + 400 − 1500
    expect(cents(invoice.totalPrice.totalNetAmount)).toBe(6400);
    expect(cents(invoice.totalPrice.totalGrossAmount)).toBe(snapshot.expectedGrossCents);
    expect(containsCode(payload, state.code, state.compact)).toBe(false);
    expect(containsCode(snapshot, state.code, state.compact)).toBe(false);
    expect(JSON.stringify(invoice)).not.toContain(state.compact);
  });
});

describe('Phase-12-Vorarbeit A: Maschinen-Sonderpreis verfällt beim Wechsel des Maschinentyps (A1–A4)', () => {
  it('A1./A2./A3. Maschine A + Sonderpreis → Wechsel auf Maschine B ⇒ Maschinen-Sonderpreis weg, Kaufartikel-Sonderpreis bleibt, Gutschein anwendbar', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await mixedWorld(admin.id);
    expect((await specialViaRoute(cookie, world.versionId, 'machine', 10000)).statusCode).toBe(200);
    expect(
      (await specialViaRoute(cookie, world.versionId, world.canisterKey, 400)).statusCode,
    ).toBe(200);
    let version = await versionRow(ctx, world.versionId);
    expect(specialKeys(version)).toEqual([world.canisterKey, 'machine']);
    expect(version.machineSubtotalCents).toBe(10000);
    // Wechsel des Maschinen-Produkttyps (manuell)
    const services = commerceServices(ctx);
    const other = await productId('slush-1x8');
    await services.offers.updateDraft(admin.id, world.versionId, { machineProductId: other });
    version = await versionRow(ctx, world.versionId);
    expect(specialKeys(version)).toEqual([world.canisterKey]);
    const standard = (await productServiceFor(ctx).pricingProductBySlug('slush-1x8', new Date()))
      .listPriceCents;
    expect(version.machineSubtotalCents).toBe(standard);
    // Gleiche Maschine erneut setzen ⇒ kein Verlust (kein Typwechsel): Sonderpreis neu setzen und prüfen
    expect((await specialViaRoute(cookie, world.versionId, 'machine', 9000)).statusCode).toBe(200);
    await services.offers.updateDraft(admin.id, world.versionId, { machineProductId: other });
    expect(specialKeys(await versionRow(ctx, world.versionId))).toEqual([
      world.canisterKey,
      'machine',
    ]);
    // Zurück auf 2×10 ⇒ wieder weg; Gutschein danach anwendbar (A3).
    const original = await productId('slush-2x10');
    await services.offers.updateDraft(admin.id, world.versionId, { machineProductId: original });
    expect(specialKeys(await versionRow(ctx, world.versionId))).toEqual([world.canisterKey]);
    expect((await applyViaRoute(cookie, world.versionId, world.code)).statusCode).toBe(200);
    version = await versionRow(ctx, world.versionId);
    expect(version.voucherDiscountCents).toBe(VOUCHER_2X10);
  });

  it('A1b. „Neu aus Anfrage übernehmen“ mit anderem Maschinentyp entfernt den Maschinen-Sonderpreis ebenfalls', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await mixedWorld(admin.id);
    expect((await specialViaRoute(cookie, world.versionId, 'machine', 10000)).statusCode).toBe(200);
    const services = commerceServices(ctx);
    const other = await productId('slush-1x8');
    // Entwurf auf B wechseln (Sonderpreis verfällt), neuen Sonderpreis für B setzen,
    // dann aus der Anfrage (Maschine A) übernehmen ⇒ Typwechsel ⇒ verfällt erneut.
    await services.offers.updateDraft(admin.id, world.versionId, { machineProductId: other });
    expect((await specialViaRoute(cookie, world.versionId, 'machine', 7000)).statusCode).toBe(200);
    await services.offers.syncDraftFromInquiry(admin.id, world.versionId);
    const version = await versionRow(ctx, world.versionId);
    expect(specialKeys(version)).toEqual([]);
    expect(version.machineSubtotalCents).toBe(MACHINE_2X10);
    // Sync ohne Typwechsel behält einen Maschinen-Sonderpreis.
    expect((await specialViaRoute(cookie, world.versionId, 'machine', 11000)).statusCode).toBe(200);
    await services.offers.syncDraftFromInquiry(admin.id, world.versionId);
    expect(specialKeys(await versionRow(ctx, world.versionId))).toEqual(['machine']);
  });

  it('A4. Alter Maschinen-Sonderpreis landet nicht im Offer-/Booking-Snapshot', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await mixedWorld(admin.id);
    expect((await specialViaRoute(cookie, world.versionId, 'machine', 10000)).statusCode).toBe(200);
    const services = commerceServices(ctx);
    const other = await productId('slush-1x8');
    await services.offers.updateDraft(admin.id, world.versionId, { machineProductId: other });
    const effective = await ctx.auth.effectivePermissions(admin.id);
    const { token } = await services.offers.send(admin.id, world.versionId, effective);
    const sent = await versionRow(ctx, world.versionId);
    const standard = (await productServiceFor(ctx).pricingProductBySlug('slush-1x8', new Date()))
      .listPriceCents;
    expect(sent.machineSubtotalCents).toBe(standard);
    expect(specialKeys(sent)).toEqual([]);
    const items = await ctx.db
      .select()
      .from(offerLineItems)
      .where(eq(offerLineItems.offerVersionId, world.versionId));
    const machineLine = items.find((item) => item.kind === 'machine')!;
    expect(machineLine.priceSource).toBe('list');
    expect(machineLine.agreedUnitPriceCents).toBe(standard);
    // Annahme ⇒ Booking-Snapshot mit Listenpreis, ohne Sonderpreis-Spuren.
    const { bookingId } = await services.offers.accept(token);
    const booking = await bookingRowById(ctx, bookingId);
    const snapshotItems = booking.itemsSnapshot as {
      kind: string;
      priceSource: string;
      agreedUnitPriceCents: number;
      standardUnitPriceCents: number;
    }[];
    const snapshotMachine = snapshotItems.find((item) => item.kind === 'machine')!;
    expect(snapshotMachine.priceSource).toBe('list');
    expect(snapshotMachine.agreedUnitPriceCents).toBe(standard);
    expect(JSON.stringify(booking.itemsSnapshot)).not.toContain('10000');
    expect((booking.totalsSnapshot as { machineSubtotalCents: number }).machineSubtotalCents).toBe(
      standard,
    );
  });
});
