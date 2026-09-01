/**
 * Phase-3-Pflichttests der zentralen Preisengine (Nr. 7–19, 27-relevante
 * Sortiergrundlage, Gültigkeit Nr. 33–35, Rabattschwellen Nr. 20–24-Basis,
 * Float-Freiheit Nr. 17). Reine Unit-Tests ohne Datenbank.
 */
import { describe, expect, it } from 'vitest';
import {
  daysUntilEventBerlin,
  discountNeedsApproval,
  discountNeedsReason,
  offerValidityDays,
  priceOffer,
  PricingError,
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
const syrupMelone: PricingProduct = {
  ...syrupKirsche,
  id: 's-melone',
  slug: 'sirup-wassermelone',
  name: 'Sirup Wassermelone',
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
  name: 'Strohhalme (25 Stück)',
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

function base(machine = machine1x8) {
  return {
    machine: { product: machine, quantity: 1 },
    cupsProduct: cups,
    strawsProduct: straws,
    selections: [],
    fulfillment: 'pickup' as const,
  };
}

describe('Preisengine – Inklusivregeln (Pflichttests 7/8/9/11/12)', () => {
  it('7. 1 Behälter → 1 L Gratis-Sirup-Kontingent', () => {
    const result = priceOffer({
      ...base(machine1x8),
      selections: [{ product: syrupKirsche, role: 'free', quantity: 1 }],
    });
    expect(result.freeSyrupBudgetLiters).toBe(1);
    const freeLine = result.lineItems.find((line) => line.lineKey === `free:${syrupKirsche.id}`);
    expect(freeLine?.billingMode).toBe('included');
    expect(freeLine?.totalCents).toBe(0);
  });

  it('7b. Überschreitung des Gratis-Kontingents wird zentral abgelehnt', () => {
    expect(() =>
      priceOffer({
        ...base(machine1x8),
        selections: [{ product: syrupKirsche, role: 'free', quantity: 2 }],
      }),
    ).toThrow(PricingError);
  });

  it('8. 2 Behälter → 2 L Gratis-Sirup', () => {
    const result = priceOffer({
      ...base(machine2x10),
      selections: [{ product: syrupKirsche, role: 'free', quantity: 2 }],
    });
    expect(result.freeSyrupBudgetLiters).toBe(2);
    expect(result.fixedTotalCents).toBe(12000);
  });

  it('9. Gratisliter sind frei auf Sorten verteilbar', () => {
    const result = priceOffer({
      ...base(machine2x10),
      selections: [
        { product: syrupKirsche, role: 'free', quantity: 1 },
        { product: syrupMelone, role: 'free', quantity: 1 },
      ],
    });
    expect(result.lineItems.filter((line) => line.priceSource === 'included').length).toBe(4); // 2 Sirup + Becher + Strohhalme
  });

  it('11/12. Genau EIN Gratis-25er-Pack Becher und Strohhalme pro Mietvorgang (auch bei 2 Maschinen)', () => {
    const result = priceOffer({
      ...base(machine2x10),
      machine: { product: machine2x10, quantity: 2 },
    });
    const cupsLines = result.lineItems.filter((line) => line.lineKey === 'included:cups');
    const strawLines = result.lineItems.filter((line) => line.lineKey === 'included:straws');
    expect(cupsLines).toHaveLength(1);
    expect(strawLines).toHaveLength(1);
    expect(cupsLines[0]?.quantity).toBe(1);
    expect(strawLines[0]?.quantity).toBe(1);
  });
});

describe('Preisengine – Zusatzartikel (Pflichttests 10/13/14/15/16)', () => {
  it('10. Zusätzlicher Sirup: 12 EUR/L als Kommission', () => {
    const result = priceOffer({
      ...base(),
      selections: [{ product: syrupKirsche, role: 'extra', quantity: 3 }],
    });
    const line = result.lineItems.find((item) => item.lineKey === `extra:${syrupKirsche.id}`);
    expect(line?.billingMode).toBe('commission');
    expect(line?.agreedUnitPriceCents).toBe(1200);
    expect(line?.totalCents).toBe(3600);
    expect(result.commissionMaxCents).toBe(3600);
    // Kommission zählt NICHT in den festen Angebotswert:
    expect(result.fixedTotalCents).toBe(6000);
  });

  it('13/14. Zusätzliche Becher 2,50 EUR und Strohhalme 2,00 EUR je 25er-Pack (Kommission)', () => {
    const result = priceOffer({
      ...base(),
      selections: [
        { product: cups, role: 'extra', quantity: 2 },
        { product: straws, role: 'extra', quantity: 1 },
      ],
    });
    expect(result.commissionMaxCents).toBe(2 * 250 + 200);
    expect(result.fixedTotalCents).toBe(6000);
  });

  it('15. Kanister 5 EUR als fester Kaufartikel', () => {
    const result = priceOffer({
      ...base(),
      selections: [{ product: canister, role: 'extra', quantity: 2 }],
    });
    const line = result.lineItems.find((item) => item.lineKey === `extra:${canister.id}`);
    expect(line?.billingMode).toBe('fixed');
    expect(result.fixedTotalCents).toBe(6000 + 1000);
    expect(result.commissionMaxCents).toBe(0);
  });

  it('16. Kanisterlimit: max. 2 je gebuchtem Behälter, zentral erzwungen', () => {
    expect(() =>
      priceOffer({
        ...base(machine1x8),
        selections: [{ product: canister, role: 'extra', quantity: 3 }],
      }),
    ).toThrow(/Maximal 2 Mischkanister/);
    // 2 Behälter → 4 erlaubt, 5 nicht.
    expect(() =>
      priceOffer({
        ...base(machine2x10),
        selections: [{ product: canister, role: 'extra', quantity: 4 }],
      }),
    ).not.toThrow();
    expect(() =>
      priceOffer({
        ...base(machine2x10),
        selections: [{ product: canister, role: 'extra', quantity: 5 }],
      }),
    ).toThrow(PricingError);
  });
});

describe('Preisengine – Rabatte (Pflichttests 18/19/27-Basis) und Float-Freiheit (17)', () => {
  it('18. Prozent-Rabatt korrekt auf den Maschinen-Subtotal', () => {
    const result = priceOffer({
      ...base(machine2x10),
      discount: { type: 'percent', value: 1000 }, // 10 %
    });
    expect(result.discountCents).toBe(1200);
    expect(result.fixedTotalCents).toBe(10800);
    expect(result.discountEffectiveBp).toBe(1000);
  });

  it('19. EUR-Rabatt korrekt inkl. effektivem Prozentsatz gegen den Maschinen-Subtotal', () => {
    const result = priceOffer({
      ...base(machine2x10),
      discount: { type: 'fixed', value: 3000 }, // 30 EUR von 120 EUR = 25 %
    });
    expect(result.discountCents).toBe(3000);
    expect(result.discountEffectiveBp).toBe(2500);
    expect(discountNeedsApproval(result.discountEffectiveBp)).toBe(true);
  });

  it('27. Rabatt kann die Summe nicht unter 0 drücken', () => {
    expect(() =>
      priceOffer({ ...base(machine1x8), discount: { type: 'fixed', value: 6001 } }),
    ).toThrow(/nicht übersteigen/);
    const exact = priceOffer({ ...base(machine1x8), discount: { type: 'fixed', value: 6000 } });
    expect(exact.fixedTotalCents).toBe(0);
  });

  it('17. Kein Floating-Point-Preisfehler: 10 % von 0,03 € etc. bleiben exakte Cent', () => {
    // Klassischer Float-Fall: 0.1 + 0.2. Hier: alles Integer-Cent.
    const odd: PricingProduct = { ...machine1x8, listPriceCents: 3333 };
    const result = priceOffer({
      machine: { product: odd, quantity: 3 },
      cupsProduct: cups,
      strawsProduct: straws,
      selections: [],
      fulfillment: 'pickup',
      discount: { type: 'percent', value: 3333 }, // 33,33 %
    });
    expect(Number.isInteger(result.discountCents)).toBe(true);
    expect(result.machineSubtotalCents).toBe(9999);
    expect(result.discountCents).toBe(3333); // round(9999*3333/10000) = round(3332.9667) = 3333
    expect(result.fixedTotalCents).toBe(6666);
  });

  it('Schwellenregeln: bis 10 % ohne Grund, über 10 % Grund, über 20 % Freigabe', () => {
    expect(discountNeedsReason(1000)).toBe(false);
    expect(discountNeedsReason(1001)).toBe(true);
    expect(discountNeedsApproval(2000)).toBe(false);
    expect(discountNeedsApproval(2001)).toBe(true);
  });

  it('Sonderpreis: agreed ersetzt Standard, Standard bleibt erhalten', () => {
    const result = priceOffer({
      ...base(machine2x10),
      specialPrices: [
        {
          lineKey: 'machine',
          unitPriceCents: 9000,
          previousStandardCents: 12000,
          byUserId: 'user-1',
          at: '2026-09-01T10:00:00.000Z',
        },
      ],
    });
    const line = result.lineItems.find((item) => item.lineKey === 'machine');
    expect(line?.standardUnitPriceCents).toBe(12000);
    expect(line?.agreedUnitPriceCents).toBe(9000);
    expect(line?.priceSource).toBe('special');
    expect(result.fixedTotalCents).toBe(9000);
  });

  it('Lieferpreis nur manuell, als feste Position gekennzeichnet', () => {
    const result = priceOffer({
      ...base(),
      fulfillment: 'delivery',
      deliveryPriceCents: 4900,
    });
    const line = result.lineItems.find((item) => item.lineKey === 'delivery');
    expect(line?.priceSource).toBe('manual');
    expect(line?.description).toContain('individuell geprüft');
    expect(result.fixedTotalCents).toBe(6000 + 4900);
  });
});

describe('Angebotsgültigkeit (Pflichttests 33/34/35, Europe/Berlin)', () => {
  // Versand am 01.09.2026 12:00 Berlin (10:00 UTC).
  const sentAt = new Date('2026-09-01T10:00:00Z');

  it('33. Event ≤ 14 Tage entfernt → 3 Tage gültig', () => {
    expect(offerValidityDays('2026-09-10', sentAt)).toBe(3);
  });

  it('34. Event > 14 Tage entfernt → 7 Tage gültig', () => {
    expect(offerValidityDays('2026-10-01', sentAt)).toBe(7);
  });

  it('35. Grenzwert exakt: 14 Tage → 3 Tage, 15 Tage → 7 Tage', () => {
    expect(daysUntilEventBerlin('2026-09-15', sentAt)).toBe(14);
    expect(offerValidityDays('2026-09-15', sentAt)).toBe(3);
    expect(daysUntilEventBerlin('2026-09-16', sentAt)).toBe(15);
    expect(offerValidityDays('2026-09-16', sentAt)).toBe(7);
  });

  it('Berlin-Tagesgrenze: Versand 23:30 UTC zählt als Folgetag in Berlin', () => {
    // 31.08. 23:30 UTC = 01.09. 01:30 Berlin (Sommerzeit).
    const lateSent = new Date('2026-08-31T23:30:00Z');
    expect(daysUntilEventBerlin('2026-09-15', lateSent)).toBe(14);
  });
});
