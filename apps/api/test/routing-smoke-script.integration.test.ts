/**
 * Phase 19 (P19-F11): Das Go-live-Werkzeug `pnpm routing:smoke` muss das GraphHopper-Gateway
 * mit der globalen Drossel (Datenbank) aufbauen können. Vorher brach das Skript vor dem ersten
 * Request mit „GraphHopper braucht die globale Drossel“ ab – der dokumentierte Provider-Smoke
 * war nicht ausführbar. Hier läuft das Skript als Kindprozess gegen einen geschlossenen Port:
 * der Aufbau gelingt (Startzeile), der Request scheitert kontrolliert (Exit 1, Fehlermeldung),
 * nie wegen fehlender Drossel. Kein Aufruf echter Provider.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from './auth-helpers.ts';

const API_DIR = join(import.meta.dirname, '..');

describe('Phase 19 – routing:smoke (P19-F11)', () => {
  it('baut das GraphHopper-Gateway mit globaler Drossel auf und scheitert nur am (geschlossenen) Endpunkt', () => {
    const result = spawnSync('pnpm', ['exec', 'tsx', 'scripts/routing-smoke.ts'], {
      cwd: API_DIR,
      env: {
        ...process.env,
        ROUTING_SMOKE: '1',
        APP_ENV: 'development',
        DATABASE_URL: TEST_DATABASE_URL,
        ROUTING_ENABLED: 'true',
        ROUTING_PROVIDER: 'graphhopper',
        GRAPHHOPPER_API_KEY: 'smoke-test-key-not-real',
        GRAPHHOPPER_BASE_URL: 'http://127.0.0.1:9',
        HTTPS_PROXY: '',
        https_proxy: '',
        HTTP_PROXY: '',
        http_proxy: '',
      },
      encoding: 'utf8',
      timeout: 120_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toContain('globale Drossel');
    expect(result.stdout).toContain('Routing-Smoke (APP_ENV=development, provider=graphhopper');
    expect(result.stderr).toContain('Smoke-Test fehlgeschlagen');
    expect(result.status).toBe(1);
    expect(output).not.toContain('smoke-test-key-not-real');
  });
});
