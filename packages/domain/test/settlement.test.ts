/**
 * Phase-9-Pflichttests der Abrechnungs-/Storno-Regeln (Nr. 14 Cent-
 * Arithmetik, 41/42 Überzahlung, 86–98 Storno-Grenzen/Basis/Rundung).
 * Reine Unit-Tests ohne Datenbank.
 */
import { describe, expect, it } from 'vitest';
import {
  calculateCancellation,
  cancellationBaseCents,
  cancellationChargeDescription,
  cancellationFeeCents,
  cancellationFeePercent,
  cancellationRemainingDays,
  commissionChargeableQuantity,
  computeSettlementTotals,
  customerNoticeWaitUntil,
  SettlementRuleError,
} from '../src/index.ts';

describe('computeSettlementTotals', () => {
  it('summiert feste Basis, variable Positionen, Nachbelastungen und Credits exakt (Nr. 14)', () => {
    const totals = computeSettlementTotals([
      { type: 'machine_rental', amountCents: 12_000 },
      { type: 'delivery', amountCents: 4_950 },
      { type: 'discount', amountCents: 1_200 },
      { type: 'purchase', amountCents: 1_999 },
      { type: 'commission_consumption', amountCents: 333 },
      { type: 'cleanup_fee', amountCents: 7_500 },
      { type: 'damage_charge', amountCents: 10_001 },
      { type: 'late_fee', amountCents: 1 },
      { type: 'advance_payment_credit', amountCents: 5_000 },
    ]);
    expect(totals.fixedTotalCents).toBe(15_750);
    expect(totals.discountCents).toBe(1_200);
    expect(totals.variableTotalCents).toBe(9_832);
    expect(totals.chargesTotalCents).toBe(10_002);
    expect(totals.grossTotalCents).toBe(35_584);
    expect(totals.creditsTotalCents).toBe(5_000);
    expect(totals.amountDueCents).toBe(30_584);
    expect(totals.overpaymentCents).toBe(0);
  });

  it('Credits über der Belastung ⇒ amount_due 0 und Überzahlung separat (Nr. 41/42)', () => {
    const totals = computeSettlementTotals([
      { type: 'machine_rental', amountCents: 6_000 },
      { type: 'advance_payment_credit', amountCents: 5_000 },
      { type: 'deposit_applied_credit', amountCents: 2_500 },
    ]);
    expect(totals.amountDueCents).toBe(0);
    expect(totals.overpaymentCents).toBe(1_500);
  });

  it('Rabatt drückt die feste Basis nie unter 0', () => {
    const totals = computeSettlementTotals([
      { type: 'machine_rental', amountCents: 1_000 },
      { type: 'discount', amountCents: 5_000 },
      { type: 'cleanup_fee', amountCents: 7_500 },
    ]);
    expect(totals.fixedTotalCents).toBe(0);
    expect(totals.amountDueCents).toBe(7_500);
  });

  it('lehnt Float-/negative Beträge ab (keine versteckten negativen Positionen)', () => {
    expect(() => computeSettlementTotals([{ type: 'manual_charge', amountCents: 10.5 }])).toThrow(
      SettlementRuleError,
    );
    expect(() => computeSettlementTotals([{ type: 'manual_charge', amountCents: -1 }])).toThrow(
      SettlementRuleError,
    );
  });

  it('bleibt bei vielen Cent-Positionen exakt (kein 0,1+0,2-Fehler)', () => {
    const lines = Array.from({ length: 1_000 }, () => ({
      type: 'commission_consumption' as const,
      amountCents: 1,
    }));
    expect(computeSettlementTotals(lines).amountDueCents).toBe(1_000);
  });
});

describe('commissionChargeableQuantity', () => {
  it('chargeable = issued − returned unopened, nie negativ (Nr. 9)', () => {
    expect(commissionChargeableQuantity(5, 2)).toBe(3);
    expect(commissionChargeableQuantity(5, 5)).toBe(0);
    expect(commissionChargeableQuantity(5, 9)).toBe(0);
    expect(() => commissionChargeableQuantity(1.5, 0)).toThrow(SettlementRuleError);
  });
});

describe('customerNoticeWaitUntil', () => {
  it('beträgt exakt 24 Stunden nach dem Versand', () => {
    const sent = new Date('2026-05-01T10:15:00.000Z');
    expect(customerNoticeWaitUntil(sent).toISOString()).toBe('2026-05-02T10:15:00.000Z');
  });
});

describe('Storno – Satz nach Berlin-Kalendertagen (Nr. 86–91)', () => {
  it('15 Tage ⇒ 0 %, 14 ⇒ 50 %, 7 ⇒ 50 %, 6 ⇒ 100 %, 0 ⇒ 100 % – Grenzen exakt', () => {
    expect(cancellationFeePercent(15)).toBe(0);
    expect(cancellationFeePercent(40)).toBe(0);
    expect(cancellationFeePercent(14)).toBe(50);
    expect(cancellationFeePercent(7)).toBe(50);
    expect(cancellationFeePercent(6)).toBe(100);
    expect(cancellationFeePercent(0)).toBe(100);
    expect(cancellationFeePercent(-3)).toBe(100);
  });

  it('zählt Kalendertage in Europe/Berlin, nicht 24-h-Blöcke (Nr. 91)', () => {
    // 23:30 UTC am 1.5. ist in Berlin bereits der 2.5. (MESZ) ⇒ bis 16.5. nur 14 Tage.
    expect(cancellationRemainingDays('2026-05-16', new Date('2026-05-01T23:30:00.000Z'))).toBe(14);
    // 21:30 UTC am 1.5. ist in Berlin noch der 1.5. ⇒ 15 Tage ⇒ kostenlos.
    expect(cancellationRemainingDays('2026-05-16', new Date('2026-05-01T21:30:00.000Z'))).toBe(15);
    // Storno kurz vor Mitternacht am Vortag zählt als 1 Tag, nicht als 100 % wegen Stunden.
    expect(cancellationRemainingDays('2026-05-16', new Date('2026-05-15T21:59:00.000Z'))).toBe(1);
  });
});

describe('Storno – Basis und Gebühr (Nr. 92–98)', () => {
  const items = [
    { kind: 'machine', quantity: 2, standardUnitPriceCents: 6_000, agreedUnitPriceCents: 4_500 },
    { kind: 'machine', quantity: 1, standardUnitPriceCents: 9_999, agreedUnitPriceCents: 9_999 },
    { kind: 'delivery', quantity: 1, standardUnitPriceCents: 4_900 },
    { kind: 'purchase', quantity: 2, standardUnitPriceCents: 1_500 },
    { kind: 'syrup', quantity: 3, standardUnitPriceCents: 800 },
    { kind: 'consumable', quantity: 1, standardUnitPriceCents: 300 },
  ];

  it('Basis = nur reguläre Maschinen-Listenpreise; Sonderpreis/Rabatt/Lieferung/Kauf/Kommission egal', () => {
    expect(cancellationBaseCents(items)).toBe(2 * 6_000 + 9_999);
  });

  it('50 %-Rundung ist deterministisch half-up auf ganze Cent', () => {
    expect(cancellationFeeCents(9_999, 50)).toBe(5_000); // 4999,5 ⇒ 5000
    expect(cancellationFeeCents(9_998, 50)).toBe(4_999);
    expect(cancellationFeeCents(1, 50)).toBe(1); // 0,5 ⇒ 1
    expect(cancellationFeeCents(0, 50)).toBe(0);
    expect(cancellationFeeCents(21_999, 100)).toBe(21_999);
    expect(cancellationFeeCents(21_999, 0)).toBe(0);
  });

  it('calculateCancellation liefert Vorschau-Werte vollständig (Nr. 99)', () => {
    const result = calculateCancellation({
      eventDate: '2026-06-20',
      cancelledAt: new Date('2026-06-10T08:00:00.000Z'), // 10 Tage ⇒ 50 %
      items,
    });
    expect(result).toEqual({
      eventDate: '2026-06-20',
      remainingDays: 10,
      feePercent: 50,
      baseCents: 21_999,
      feeCents: 11_000, // 10999,5 ⇒ half up
      roundingMethod: 'half_up',
    });
  });

  it('Kundenzeile enthält die Vorgangsnummer (Nr. 109)', () => {
    expect(cancellationChargeDescription('MR-2026-0042')).toBe(
      'Stornokosten gemäß Mietbedingungen – Vorgang MR-2026-0042',
    );
  });
});
