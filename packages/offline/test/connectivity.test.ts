/**
 * Konnektivitäts-Epoche (Phase-8-Order §78, Phase-11-Finalisierung §3): Eine
 * Health-Check-Antwort, die erst nach einem Offline-Übergang eintrifft, ist
 * veraltet und darf den Offline-Zustand nicht mit „online“ überschreiben.
 */
import { describe, expect, it } from 'vitest';
import { ConnectivityEpoch } from '../src/connectivity.ts';

describe('ConnectivityEpoch', () => {
  it('Prüfung derselben Epoche bei onLine=true ist gültig', () => {
    const epoch = new ConnectivityEpoch();
    const started = epoch.value;
    expect(epoch.isStale(started, true)).toBe(false);
    expect(epoch.isStale(started, undefined)).toBe(false);
  });

  it('Offline-Übergang nach Prüfungsstart macht die Antwort veraltet', () => {
    const epoch = new ConnectivityEpoch();
    const started = epoch.value;
    epoch.bump();
    expect(epoch.isStale(started, true)).toBe(true);
  });

  it('navigator.onLine === false macht die Antwort auch ohne Event veraltet', () => {
    const epoch = new ConnectivityEpoch();
    expect(epoch.isStale(epoch.value, false)).toBe(true);
  });

  it('eine nach dem Offline-Übergang gestartete Prüfung ist wieder gültig', () => {
    const epoch = new ConnectivityEpoch();
    epoch.bump();
    const started = epoch.value;
    expect(epoch.isStale(started, true)).toBe(false);
    epoch.bump();
    expect(epoch.isStale(started, true)).toBe(true);
  });
});
