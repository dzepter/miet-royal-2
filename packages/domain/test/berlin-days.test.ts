/**
 * Phase 12 (reminders): `addBerlinCalendarDays` – Kalendertage in
 * Europe/Berlin bei gleicher Wanduhrzeit, auch über die Zeitumstellungen
 * (März/Oktober) hinweg. Kein 7 × 24 h-Fehler (Order §17).
 */
import { describe, expect, it } from 'vitest';
import { addBerlinCalendarDays } from '../src/voucher.ts';

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

describe('addBerlinCalendarDays (Phase 12, Order §17)', () => {
  it('7 Kalendertage vor einem Termin am Tag nach der März-Umstellung: gleiche Wanduhrzeit, 167 h', () => {
    // Umstellung 29.03.2026 02:00 → 03:00 (MEZ → MESZ). Termin Montag 30.03.2026 10:00 MESZ.
    const appointment = new Date('2026-03-30T08:00:00.000Z');
    expect(berlin(appointment)).toBe('2026-03-30, 10:00');
    const due = addBerlinCalendarDays(appointment, -7);
    expect(berlin(due)).toBe('2026-03-23, 10:00');
    // 23.03. 10:00 MEZ = 09:00Z – 7 Kalendertage sind hier 167 Stunden, nicht 168.
    expect(due.toISOString()).toBe('2026-03-23T09:00:00.000Z');
    expect((appointment.getTime() - due.getTime()) / 3_600_000).toBe(167);
  });

  it('7 Kalendertage vor einem Termin am Tag nach der Oktober-Umstellung: gleiche Wanduhrzeit, 169 h', () => {
    // Umstellung 25.10.2026 03:00 → 02:00 (MESZ → MEZ). Termin 26.10.2026 09:30 MEZ.
    const appointment = new Date('2026-10-26T08:30:00.000Z');
    expect(berlin(appointment)).toBe('2026-10-26, 09:30');
    const due = addBerlinCalendarDays(appointment, -7);
    expect(berlin(due)).toBe('2026-10-19, 09:30');
    expect(due.toISOString()).toBe('2026-10-19T07:30:00.000Z');
    expect((appointment.getTime() - due.getTime()) / 3_600_000).toBe(169);
  });

  it('1 Kalendertag vorher über die Umstellung: gleiche Wanduhrzeit', () => {
    const appointment = new Date('2026-03-29T12:00:00.000Z'); // 29.03. 14:00 MESZ
    const due = addBerlinCalendarDays(appointment, -1);
    expect(berlin(due)).toBe('2026-03-28, 14:00');
    expect(due.toISOString()).toBe('2026-03-28T13:00:00.000Z');
  });

  it('positive Tage, Monats- und Jahreswechsel', () => {
    expect(berlin(addBerlinCalendarDays(new Date('2026-12-30T11:00:00.000Z'), 3))).toBe(
      '2027-01-02, 12:00',
    );
    expect(berlin(addBerlinCalendarDays(new Date('2026-02-26T11:00:00.000Z'), 3))).toBe(
      '2026-03-01, 12:00',
    );
    expect(addBerlinCalendarDays(new Date('2026-05-05T10:00:00.000Z'), 0).toISOString()).toBe(
      '2026-05-05T10:00:00.000Z',
    );
  });

  it('nicht existierende Wanduhrzeit (Lücke 02:30 am 29.03.) wird deterministisch verschoben', () => {
    const base = new Date('2026-03-22T01:30:00.000Z'); // 22.03. 02:30 MEZ
    const shifted = addBerlinCalendarDays(base, 7); // 29.03. 02:30 existiert nicht
    expect(berlin(shifted)).toBe('2026-03-29, 03:30');
  });

  it('lehnt nicht-ganzzahlige Tage ab', () => {
    expect(() => addBerlinCalendarDays(new Date(), 1.5)).toThrow(RangeError);
  });
});
