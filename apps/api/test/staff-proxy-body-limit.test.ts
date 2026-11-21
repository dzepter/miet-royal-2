/**
 * Phase 19 (P19-F13): Der Same-Origin-Rewrite der Staff-App puffert Request-Bodies nur bis
 * `experimental.proxyClientMaxBodySize` (Next-Default 10 MiB) und reicht größere Bodies OHNE Fehler
 * abgeschnitten an die API weiter (siehe apps/web/next.config.ts). `POST /staff/offline/sync`
 * erlaubt 12 MiB – fotoreiche Offline-Übergaben wären im Pilot still gescheitert (Phase-18-
 * Restpunkt). Dieser Test hält die Kette fest: Staff-Puffer ≥ API-Limit des Offline-Syncs + Reserve.
 */
import { describe, expect, it } from 'vitest';
import staffConfig from '../../staff/next.config.ts';
import { SYNC_BODY_LIMIT } from '../src/routes/offline.ts';

describe('Phase 19 (P19-F13) – Staff-Proxy-Puffer vor dem Offline-Sync', () => {
  it('proxyClientMaxBodySize der Staff-App ist mindestens das API-Limit des Offline-Syncs plus Reserve', () => {
    const buffer = staffConfig.experimental?.proxyClientMaxBodySize;
    expect(typeof buffer).toBe('number');
    expect(buffer as number).toBeGreaterThanOrEqual(SYNC_BODY_LIMIT + 1024 * 1024);
    expect(SYNC_BODY_LIMIT).toBe(12 * 1024 * 1024);
  });
});
