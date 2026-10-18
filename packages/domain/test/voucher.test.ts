/**
 * Phase-11-Pflichttests Gültigkeit 33–36 (Unit; Order §§16/36/40) und
 * Rundung (§25): 12 KALENDERMONATE Europe/Berlin bei gleicher Wanduhrzeit,
 * DST-Grenzen, Monatsende, lazy Ablauf exakt zum Zeitpunkt, Restgültigkeit
 * und Reaktivierung.
 */
import { describe, expect, it } from 'vitest';
import {
  addBerlinCalendarMonths,
  isVoucherExpired,
  maskVoucherCode,
  reactivatedExpiresAt,
  remainingValiditySeconds,
  voucherDiscountCents,
  voucherEffectiveStatus,
  voucherExpiresAt,
} from '../src/voucher.ts';

const berlin = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);

describe('Gültigkeit 12 Kalendermonate (Tests 33–36)', () => {
  it('33. genau 12 Kalendermonate, nicht 365 Tage (Sommerzeit → Sommerzeit)', () => {
    const activated = new Date('2026-06-15T10:00:00+02:00');
    const expires = voucherExpiresAt(activated);
    expect(expires.toISOString()).toBe(new Date('2027-06-15T10:00:00+02:00').toISOString());
    expect((expires.getTime() - activated.getTime()) / 86_400_000).toBe(365);
    // Schaltjahr-Überspannung: 2028 ist Schaltjahr ⇒ 366 Tage, trotzdem gleiche Wanduhrzeit.
    const leap = new Date('2027-10-01T09:30:00+02:00');
    const leapExpires = voucherExpiresAt(leap);
    expect(berlin(leapExpires)).toBe('2028-10-01, 09:30');
    expect((leapExpires.getTime() - leap.getTime()) / 86_400_000).toBe(366);
  });

  it('34. DST-Grenzen: Winterzeit-Aktivierung ⇒ Winterzeit-Ablauf (Offset wechselt sauber), Monatsende gekappt', () => {
    // 28.03.2026 10:00 MEZ (Tag vor der Umstellung am 29.03.2026) →
    // 28.03.2027 10:00 MESZ (Umstellung am 28.03.2027 02:00): Offset wechselt +01 → +02.
    const activated = new Date('2026-03-28T10:00:00+01:00');
    const expires = voucherExpiresAt(activated);
    expect(berlin(expires)).toBe('2027-03-28, 10:00');
    expect(expires.toISOString()).toBe('2027-03-28T08:00:00.000Z');
    // Umgekehrt: 26.10.2026 10:00 MEZ (Umstellung war 25.10.2026) → 26.10.2027 10:00 MESZ
    // (Umstellung erst 31.10.2027): Offset wechselt +01 → +02, Wanduhrzeit bleibt.
    const autumn = voucherExpiresAt(new Date('2026-10-26T10:00:00+01:00'));
    expect(berlin(autumn)).toBe('2027-10-26, 10:00');
    expect(autumn.toISOString()).toBe('2027-10-26T08:00:00.000Z');
    // Winterzeit → Sommerzeit über die Frühjahrsumstellung hinweg.
    const winter = new Date('2026-01-20T08:15:00+01:00');
    expect(berlin(voucherExpiresAt(winter))).toBe('2027-01-20, 08:15');
    // 29.02.2028 + 12 Monate ⇒ 28.02.2029.
    expect(berlin(addBerlinCalendarMonths(new Date('2028-02-29T12:00:00+01:00'), 12))).toBe(
      '2029-02-28, 12:00',
    );
    // 31.01. + 1 Monat ⇒ 28.02. (nicht 03.03.).
    expect(berlin(addBerlinCalendarMonths(new Date('2026-01-31T12:00:00+01:00'), 1))).toBe(
      '2026-02-28, 12:00',
    );
    // Nicht existierende Wanduhrzeit (Lücke 29.03.2026 02:30) ⇒ deterministisch gültiger Zeitpunkt.
    const gap = addBerlinCalendarMonths(new Date('2025-03-29T02:30:00+01:00'), 12);
    expect(Number.isNaN(gap.getTime())).toBe(false);
  });

  it('35./36. innerhalb verwendbar, exakt zum Ablaufzeitpunkt nicht mehr (lazy, kein Cron)', () => {
    const activated = new Date('2026-03-01T12:00:00+01:00');
    const expires = voucherExpiresAt(activated);
    expect(isVoucherExpired(expires, new Date(expires.getTime() - 1))).toBe(false);
    expect(isVoucherExpired(expires, expires)).toBe(true);
    expect(isVoucherExpired(expires, new Date(expires.getTime() + 1))).toBe(true);
    expect(voucherEffectiveStatus('active', expires, new Date(expires.getTime() - 1))).toBe(
      'active',
    );
    expect(voucherEffectiveStatus('active', expires, expires)).toBe('expired');
    expect(voucherEffectiveStatus('reserved', expires, expires)).toBe('expired');
    expect(voucherEffectiveStatus('redeemed', expires, expires)).toBe('redeemed');
  });

  it('Restgültigkeit (§36) und Reaktivierung (§40): Stornozeit + exakte Restdauer, DST-neutral', () => {
    const expires = new Date('2027-03-01T12:00:00+01:00');
    const redeemed = new Date('2026-11-28T12:00:00+01:00');
    const remaining = remainingValiditySeconds(expires, redeemed);
    expect(remaining).toBe(93 * 86_400);
    const cancelled = new Date('2027-01-10T09:00:00+01:00');
    expect(reactivatedExpiresAt(cancelled, remaining).toISOString()).toBe(
      new Date(cancelled.getTime() + 93 * 86_400_000).toISOString(),
    );
    expect(() => remainingValiditySeconds(expires, expires)).toThrow();
    expect(() => reactivatedExpiresAt(cancelled, 0)).toThrow();
  });
});

describe('Rabatt und Maske', () => {
  it('59. 20 % half-up auf Integer-Cent', () => {
    expect(voucherDiscountCents(10_000)).toBe(2000);
    expect(voucherDiscountCents(1)).toBe(0);
    expect(voucherDiscountCents(3)).toBe(1);
    expect(voucherDiscountCents(12_345)).toBe(2469);
    expect(voucherDiscountCents(12_347)).toBe(2469);
    expect(voucherDiscountCents(12_348)).toBe(2470);
    expect(() => voucherDiscountCents(1.5)).toThrow();
    expect(() => voucherDiscountCents(-1)).toThrow();
  });

  it('14. Maskierte Darstellung zeigt nur das Suffix', () => {
    expect(maskVoucherCode('T2RW')).toBe('MR20-••••-••••-T2RW');
  });
});
