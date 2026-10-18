/**
 * Phase-11-Pflichttests Preis 57–63 (Order §§22, 24, 25): 20 % der SUMME
 * aller Maschinenmietpositionen, half-up auf ganze Cent, nur Maschinenmiete
 * (nicht Lieferung/Kanister/Kommission), Inklusiv-Artikel irrelevant,
 * Nicht-Kombinierbarkeit strukturell in der Preisengine. Reine Unit-Tests.
 *
 * Phase 11 Final (F1–F12): Nur ein MASCHINEN-Sonderpreis (auch 0 EUR) schließt
 * den Gutschein aus; Sonderpreise auf Kaufartikeln/Kommissionsartikeln und der
 * individuelle Lieferpreis bleiben erlaubt und ändern den Gutscheinbetrag nicht.
 */
import { describe, expect, it } from 'vitest';
import {
  hasMachineSpecialPrice,
  priceOffer,
  PricingError,
  VOUCHER_DISCOUNT_PERCENT,
  VOUCHER_NOT_COMBINABLE_MESSAGE,
  voucherDiscountCents,
  type PricingProduct,
} from '../src/index.ts';

const machine1x8: PricingProduct = {
  id: 'm-1x8',
  slug: 'slush-1x8',
  name: '1×8 L',
  category: 'machine',
  saleUnit: 'Stück',
  defaultBillingMode: 'fixed',
  listPriceCents: 6000,
  containerCount: 1,
  containerVolumeLiters: 8,
  carryPersons: 1,
};
const machine2x10: PricingProduct = {
  ...machine1x8,
  id: 'm-2x10',
  slug: 'slush-2x10',
  name: '2×10 L',
  listPriceCents: 12000,
  containerCount: 2,
  containerVolumeLiters: 10,
  carryPersons: 2,
};
const syrupKirsche: PricingProduct = {
  id: 's-kirsche',
  slug: 'sirup-kirsche',
  name: 'Sirup Kirsche',
  category: 'syrup',
  saleUnit: '1-L-Flasche',
  defaultBillingMode: 'commission',
  listPriceCents: 1200,
};
const cups: PricingProduct = {
  id: 'c-becher',
  slug: 'becher-25',
  name: 'Becher (25 Stück)',
  category: 'consumable',
  saleUnit: '25er-Pack',
  defaultBillingMode: 'commission',
  listPriceCents: 250,
};
const straws: PricingProduct = {
  ...cups,
  id: 'c-halme',
  slug: 'strohhalme-25',
  listPriceCents: 200,
};
const canister: PricingProduct = {
  id: 'p-kanister',
  slug: 'mischkanister-6l',
  name: '6-L-Mischkanister',
  category: 'purchase',
  saleUnit: 'Stück',
  defaultBillingMode: 'fixed',
  listPriceCents: 500,
};

const voucher = { discountPercent: VOUCHER_DISCOUNT_PERCENT } as const;

function base(machine = machine1x8, quantity = 1) {
  return {
    machine: { product: machine, quantity },
    cupsProduct: cups,
    strawsProduct: straws,
    selections: [],
    fulfillment: 'pickup' as const,
  };
}

function special(lineKey: string, unitPriceCents: number) {
  return {
    lineKey,
    unitPriceCents,
    previousStandardCents: 6000,
    byUserId: 'u',
    at: '2026-01-01T00:00:00.000Z',
  };
}

describe('Gutschein-Preisregel (57–63)', () => {
  it('57. Eine Maschine: 20 % der Maschinenmiete, Gesamtwert entsprechend reduziert', () => {
    const result = priceOffer({ ...base(machine1x8), voucher });
    expect(result.machineSubtotalCents).toBe(6000);
    expect(result.voucherDiscountCents).toBe(1200);
    expect(result.machineSubtotalAfterVoucherCents).toBe(4800);
    expect(result.fixedTotalCents).toBe(4800);
    expect(result.discountCents).toBe(0);
    // Positionen selbst bleiben unverändert (Stornobasis = regulärer Listenpreis).
    const machineLine = result.lineItems.find((line) => line.lineKey === 'machine')!;
    expect(machineLine.standardUnitPriceCents).toBe(6000);
    expect(machineLine.agreedUnitPriceCents).toBe(6000);
    expect(machineLine.totalCents).toBe(6000);
  });

  it('58. Mehrere Maschinen: 20 % der SUMME aller Maschinenmietpositionen', () => {
    const result = priceOffer({ ...base(machine2x10, 3), voucher });
    expect(result.machineSubtotalCents).toBe(36000);
    expect(result.voucherDiscountCents).toBe(7200);
    expect(result.machineSubtotalAfterVoucherCents).toBe(28800);
    expect(result.fixedTotalCents).toBe(28800);
  });

  it('59. Rundung half-up auf ganze Cent, reine Integer-Arithmetik', () => {
    // 20 % von 12,34 EUR = 2,468 EUR ⇒ 2,47 EUR (aufrunden ab 0,5 Cent).
    expect(voucherDiscountCents(1234)).toBe(247);
    // 20 % von 0,07 EUR = 1,4 Cent ⇒ 1 Cent; 20 % von 0,08 EUR = 1,6 ⇒ 2 Cent.
    expect(voucherDiscountCents(7)).toBe(1);
    expect(voucherDiscountCents(8)).toBe(2);
    // Exakt halbe Cent: 20 % von 0,05 EUR = 1,0 Cent; 20 % von 0,025 EUR gibt es nicht –
    // 20 % von 1,2345 EUR entfällt (Integer-Cent); 20 % von 2,5 Cent ⇒ 0,5 ⇒ 1 (half-up).
    expect(voucherDiscountCents(3)).toBe(1); // 0,6 ⇒ 1
    expect(voucherDiscountCents(2)).toBe(0); // 0,4 ⇒ 0
    expect(voucherDiscountCents(0)).toBe(0);
    expect(() => voucherDiscountCents(12.5)).toThrow(RangeError);
    expect(() => voucherDiscountCents(-1)).toThrow(RangeError);
    const result = priceOffer({
      ...base({ ...machine1x8, listPriceCents: 1234 }),
      voucher,
    });
    expect(result.voucherDiscountCents).toBe(247);
    expect(Number.isInteger(result.fixedTotalCents)).toBe(true);
    expect(result.fixedTotalCents).toBe(987);
  });

  it('60. Lieferpreis wird nicht rabattiert', () => {
    const result = priceOffer({
      ...base(machine1x8),
      fulfillment: 'delivery',
      deliveryPriceCents: 4900,
      voucher,
    });
    expect(result.voucherDiscountCents).toBe(1200);
    expect(result.fixedSubtotalCents).toBe(10900);
    expect(result.fixedTotalCents).toBe(9700); // 6000 − 1200 + 4900
  });

  it('61. Kaufartikel (Kanister) werden nicht rabattiert', () => {
    const result = priceOffer({
      ...base(machine1x8),
      selections: [{ product: canister, role: 'extra', quantity: 2 }],
      voucher,
    });
    expect(result.voucherDiscountCents).toBe(1200);
    expect(result.fixedTotalCents).toBe(5800); // 6000 − 1200 + 2 × 500
  });

  it('62. Kommissionsartikel bleiben unberührt (Höchstwert unverändert)', () => {
    const result = priceOffer({
      ...base(machine1x8),
      selections: [{ product: syrupKirsche, role: 'extra', quantity: 3 }],
      voucher,
    });
    expect(result.voucherDiscountCents).toBe(1200);
    expect(result.commissionMaxCents).toBe(3600);
    expect(result.fixedTotalCents).toBe(4800);
  });

  it('63. Inklusiv-Artikel (Gratis-Sirup, Becher/Strohhalme) haben keinen Einfluss', () => {
    const withIncluded = priceOffer({
      ...base(machine1x8),
      selections: [{ product: syrupKirsche, role: 'free', quantity: 1 }],
      voucher,
    });
    const withoutIncluded = priceOffer({ ...base(machine1x8), voucher });
    expect(withIncluded.voucherDiscountCents).toBe(withoutIncluded.voucherDiscountCents);
    expect(withIncluded.fixedTotalCents).toBe(withoutIncluded.fixedTotalCents);
  });

  it('Ohne Gutschein: voucherDiscountCents 0, Maschinenmiete nach Gutschein = regulär', () => {
    const result = priceOffer(base(machine1x8));
    expect(result.voucherDiscountCents).toBe(0);
    expect(result.machineSubtotalAfterVoucherCents).toBe(6000);
  });

  it('Gutschein ohne Maschinenmiete und unbekannte Gutscheinart werden abgelehnt', () => {
    expect(() => priceOffer({ ...base(machine1x8), machine: null, voucher })).toThrow(PricingError);
    expect(() =>
      priceOffer({ ...base(machine1x8), voucher: { discountPercent: 30 as unknown as 20 } }),
    ).toThrow(PricingError);
  });

  it('71./72. (strukturell) Gutschein + manueller %-/EUR-Rabatt ⇒ VOUCHER_NOT_COMBINABLE_MESSAGE', () => {
    expect(() =>
      priceOffer({ ...base(machine1x8), discount: { type: 'percent', value: 500 }, voucher }),
    ).toThrow(VOUCHER_NOT_COMBINABLE_MESSAGE);
    expect(() =>
      priceOffer({ ...base(machine1x8), discount: { type: 'fixed', value: 100 }, voucher }),
    ).toThrow(VOUCHER_NOT_COMBINABLE_MESSAGE);
  });

  it('F1./F2. (strukturell, vormals 73/74/77) Gutschein + MASCHINEN-Sonderpreis (auch 0 EUR) ⇒ VOUCHER_NOT_COMBINABLE_MESSAGE', () => {
    expect(() =>
      priceOffer({ ...base(machine1x8), specialPrices: [special('machine', 5000)], voucher }),
    ).toThrow(VOUCHER_NOT_COMBINABLE_MESSAGE);
    expect(() =>
      priceOffer({ ...base(machine1x8), specialPrices: [special('machine', 0)], voucher }),
    ).toThrow(VOUCHER_NOT_COMBINABLE_MESSAGE);
    // Ohne Gutschein ist der Maschinen-Sonderpreis regulär möglich.
    const plain = priceOffer({ ...base(machine1x8), specialPrices: [special('machine', 5000)] });
    expect(plain.machineSubtotalCents).toBe(5000);
    expect(hasMachineSpecialPrice(plain.lineItems)).toBe(true);
  });

  it('F5. (strukturell) Gutschein + individueller Lieferpreis erlaubt', () => {
    const result = priceOffer({
      ...base(machine1x8),
      fulfillment: 'delivery',
      deliveryPriceCents: 4900,
      voucher,
    });
    expect(result.voucherDiscountCents).toBe(1200);
    expect(result.lineItems.find((line) => line.kind === 'delivery')?.priceSource).toBe('manual');
    expect(hasMachineSpecialPrice(result.lineItems)).toBe(false);
  });

  it('F6. (strukturell) Gutschein + Kaufartikel-Sonderpreis (Mischkanister, auch 0 EUR) erlaubt', () => {
    const result = priceOffer({
      ...base(machine1x8),
      selections: [{ product: canister, role: 'extra', quantity: 2 }],
      specialPrices: [special(`extra:${canister.id}`, 400)],
      voucher,
    });
    expect(result.voucherDiscountCents).toBe(1200);
    expect(result.machineSubtotalAfterVoucherCents).toBe(4800);
    const line = result.lineItems.find((item) => item.lineKey === `extra:${canister.id}`)!;
    expect(line.kind).toBe('purchase');
    expect(line.priceSource).toBe('special');
    expect(line.totalCents).toBe(800);
    expect(result.fixedTotalCents).toBe(5600); // 6000 − 1200 + 2 × 400
    const zero = priceOffer({
      ...base(machine1x8),
      selections: [{ product: canister, role: 'extra', quantity: 1 }],
      specialPrices: [special(`extra:${canister.id}`, 0)],
      voucher,
    });
    expect(zero.voucherDiscountCents).toBe(1200);
    expect(zero.fixedTotalCents).toBe(4800);
  });

  it('F7. (strukturell) Gutschein + Sonderpreis auf Kommissionsartikel (Sirup/Becher) erlaubt', () => {
    const result = priceOffer({
      ...base(machine1x8),
      selections: [
        { product: syrupKirsche, role: 'extra', quantity: 3 },
        { product: cups, role: 'extra', quantity: 2 },
      ],
      specialPrices: [special(`extra:${syrupKirsche.id}`, 1000), special(`extra:${cups.id}`, 200)],
      voucher,
    });
    expect(result.voucherDiscountCents).toBe(1200);
    expect(result.commissionMaxCents).toBe(3400); // 3 × 1000 + 2 × 200
    expect(result.fixedTotalCents).toBe(4800);
    expect(
      result.lineItems
        .filter((item) => item.priceSource === 'special')
        .map((item) => item.kind)
        .sort(),
    ).toEqual(['consumable', 'syrup']);
  });

  it('F10. (strukturell) Gemischt (Maschine + Nicht-Maschine) ⇒ blockiert; Inklusiv-Positionen nie Sonderpreis', () => {
    expect(() =>
      priceOffer({
        ...base(machine1x8),
        selections: [{ product: canister, role: 'extra', quantity: 1 }],
        specialPrices: [special('machine', 5000), special(`extra:${canister.id}`, 400)],
        voucher,
      }),
    ).toThrow(VOUCHER_NOT_COMBINABLE_MESSAGE);
    // Ein verwaister Eintrag auf eine nicht vorhandene Position ist kein Maschinen-Sonderpreis.
    const orphan = priceOffer({
      ...base(machine1x8),
      specialPrices: [special('extra:unbekannt', 1)],
      voucher,
    });
    expect(orphan.voucherDiscountCents).toBe(1200);
    // Ein "included:*"-Schlüssel kann nie eine Maschinen-Position treffen.
    const included = priceOffer({
      ...base(machine1x8),
      specialPrices: [special('included:cups', 1)],
      voucher,
    });
    expect(included.lineItems.find((item) => item.lineKey === 'included:cups')?.priceSource).toBe(
      'included',
    );
    expect(included.voucherDiscountCents).toBe(1200);
  });

  it('F11./F12. Gutschein = exakt 20 % der Maschinenmietsumme; Nicht-Maschinen-Sonderpreis ändert den Betrag nicht', () => {
    const without = priceOffer({
      ...base(machine2x10, 3),
      selections: [{ product: canister, role: 'extra', quantity: 2 }],
      voucher,
    });
    const withSpecial = priceOffer({
      ...base(machine2x10, 3),
      selections: [{ product: canister, role: 'extra', quantity: 2 }],
      specialPrices: [special(`extra:${canister.id}`, 100)],
      voucher,
    });
    expect(without.machineSubtotalCents).toBe(36000);
    expect(without.voucherDiscountCents).toBe(voucherDiscountCents(36000));
    expect(without.voucherDiscountCents).toBe(7200);
    expect(withSpecial.machineSubtotalCents).toBe(36000);
    expect(withSpecial.voucherDiscountCents).toBe(7200);
    expect(withSpecial.machineSubtotalAfterVoucherCents).toBe(28800);
    // Nur der Kaufartikel-Anteil ändert sich (2 × (500 − 100) = 800).
    expect(without.fixedTotalCents - withSpecial.fixedTotalCents).toBe(800);
  });

  it('hasMachineSpecialPrice entscheidet anhand Kind + Quelle, nicht anhand des lineKeys', () => {
    expect(hasMachineSpecialPrice([])).toBe(false);
    const result = priceOffer({
      ...base(machine1x8),
      selections: [{ product: canister, role: 'extra', quantity: 1 }],
      specialPrices: [special(`extra:${canister.id}`, 400)],
    });
    expect(hasMachineSpecialPrice(result.lineItems)).toBe(false);
    const machineLine = result.lineItems.find((item) => item.kind === 'machine')!;
    expect(hasMachineSpecialPrice([{ ...machineLine, priceSource: 'special' }])).toBe(true);
    expect(
      hasMachineSpecialPrice([{ ...machineLine, lineKey: 'extra:x', priceSource: 'special' }]),
    ).toBe(true);
    expect(
      hasMachineSpecialPrice([{ ...machineLine, kind: 'purchase', priceSource: 'special' }]),
    ).toBe(false);
  });
});
