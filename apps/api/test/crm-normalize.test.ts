import { describe, expect, it } from 'vitest';
import {
  berlinYear,
  dateSearchTerm,
  normalizeEmailAddress,
  normalizePhoneNumber,
  phoneSearchTerm,
} from '../src/crm/normalize.ts';

/** Phase-2-Pflichttests Nr. 3 (E-Mail) und Nr. 4 (Telefon-Suchnormalisierung). */

describe('E-Mail-Normalisierung (Pflichttest 3)', () => {
  it('trimmt und schreibt klein', () => {
    expect(normalizeEmailAddress('  Max.Meier@Example.COM ')).toBe('max.meier@example.com');
  });

  it('leere Eingaben werden zu null', () => {
    expect(normalizeEmailAddress('')).toBeNull();
    expect(normalizeEmailAddress('   ')).toBeNull();
    expect(normalizeEmailAddress(undefined)).toBeNull();
    expect(normalizeEmailAddress(null)).toBeNull();
  });
});

describe('Telefonnummer-Suchnormalisierung (Pflichttest 4)', () => {
  it('entfernt Trennzeichen und vereinheitlicht die Ländervorwahl', () => {
    expect(normalizePhoneNumber('0171 234 56 78')).toBe('491712345678');
    expect(normalizePhoneNumber('+49 171 2345678')).toBe('491712345678');
    expect(normalizePhoneNumber('0049 (171) 234-5678')).toBe('491712345678');
    expect(normalizePhoneNumber('491712345678')).toBe('491712345678');
  });

  it('leere Eingaben werden zu null', () => {
    expect(normalizePhoneNumber('')).toBeNull();
    expect(normalizePhoneNumber('abc')).toBeNull();
    expect(normalizePhoneNumber(undefined)).toBeNull();
  });

  it('Sucheingaben: alle Schreibweisen derselben Nummer treffen dieselbe Ziffernform', () => {
    expect(phoneSearchTerm('+49 171 2345678')).toBe('491712345678');
    expect(phoneSearchTerm('0171/2345678')).toBe('491712345678');
    expect(phoneSearchTerm('0171 234')).toBe('49171234');
  });

  it('Sucheingaben ohne Telefonnummer-Form liefern null', () => {
    expect(phoneSearchTerm('Meier')).toBeNull();
    expect(phoneSearchTerm('12')).toBeNull();
    expect(phoneSearchTerm('MR-2026-0001')).toBeNull();
  });
});

describe('Eventdatum-Sucheingabe', () => {
  it('versteht deutsche und ISO-Schreibweisen', () => {
    expect(dateSearchTerm('31.12.2026')).toBe('2026-12-31');
    expect(dateSearchTerm('1.2.26')).toBe('2026-02-01');
    expect(dateSearchTerm('2026-12-31')).toBe('2026-12-31');
  });

  it('lehnt Nicht-Daten ab', () => {
    expect(dateSearchTerm('Meier')).toBeNull();
    expect(dateSearchTerm('32.13.2026')).toBeNull();
  });

  it('lehnt unmögliche Kalenderdaten ab (kein PostgreSQL-Datumsfehler)', () => {
    expect(dateSearchTerm('31.02.2026')).toBeNull();
    expect(dateSearchTerm('30.02.26')).toBeNull();
    expect(dateSearchTerm('2026-99-99')).toBeNull();
    expect(dateSearchTerm('2026-02-31')).toBeNull();
    expect(dateSearchTerm('29.02.2028')).toBe('2028-02-29'); // Schaltjahr existiert
  });
});

describe('Jahr der Vorgangsnummer (Europe/Berlin)', () => {
  it('nutzt das Berliner Jahr, nicht UTC', () => {
    // 31.12. 23:30 UTC ist in Berlin bereits der 1.1. des Folgejahres.
    expect(berlinYear(new Date('2026-12-31T23:30:00Z'))).toBe(2027);
    expect(berlinYear(new Date('2026-06-15T12:00:00Z'))).toBe(2026);
  });
});
