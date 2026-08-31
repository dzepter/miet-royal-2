import { describe, expect, it } from 'vitest';
import { computeBackoffMs } from '../src/jobs/backoff.ts';

describe('computeBackoffMs', () => {
  it('verdoppelt den Backoff pro Versuch', () => {
    expect(computeBackoffMs(1, 1000)).toBe(1000);
    expect(computeBackoffMs(2, 1000)).toBe(2000);
    expect(computeBackoffMs(3, 1000)).toBe(4000);
    expect(computeBackoffMs(4, 1000)).toBe(8000);
  });

  it('deckelt am Maximum', () => {
    expect(computeBackoffMs(10, 30_000, 3_600_000)).toBe(3_600_000);
    expect(computeBackoffMs(30, 30_000, 3_600_000)).toBe(3_600_000);
  });

  it('lehnt ungültige Versuche ab', () => {
    expect(() => computeBackoffMs(0)).toThrow(RangeError);
    expect(() => computeBackoffMs(-1)).toThrow(RangeError);
    expect(() => computeBackoffMs(1.5)).toThrow(RangeError);
  });
});
