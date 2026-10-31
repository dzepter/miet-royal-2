import { describe, expect, it } from 'vitest';
import {
  assertConfigsIsolated,
  ConfigError,
  EnvironmentIsolationError,
  loadConfig,
} from '../src/index.ts';

/**
 * Phase 14 (demo, Design §4): feste Deployment-URLs des Live↔Demo-Wechsels
 * (STAFF_DEMO_URL / STAFF_LIVE_URL) – Validierung, Umgebungsregeln und
 * Isolationsprüfung. Pflichttest-Nummern des Auftrags liegen noch nicht vor
 * (Auftragstext endet bei §20); Namen laufen als „D-C<n>“.
 */

const productionEnv = {
  APP_ENV: 'production',
  DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_prod',
  STORAGE_DRIVER: 's3',
  STORAGE_S3_ENDPOINT: 'https://s3.example.com',
  STORAGE_S3_REGION: 'eu-central-1',
  STORAGE_S3_BUCKET: 'mietroyal-prod',
  STORAGE_S3_ACCESS_KEY_ID: 'prod-key',
  STORAGE_S3_SECRET_ACCESS_KEY: 'prod-secret',
  AUTH_SECRET_KEY: 'prod-auth-secret-key-0123456789abcdef',
  COMMUNICATION_PAYLOAD_KEY: 'prod-communication-payload-key-0123456789',
};

const demoEnv = {
  ...productionEnv,
  APP_ENV: 'demo',
  DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_demo',
  STORAGE_S3_BUCKET: 'mietroyal-demo',
  STORAGE_S3_ACCESS_KEY_ID: 'demo-key',
  STORAGE_S3_SECRET_ACCESS_KEY: 'demo-secret',
  AUTH_SECRET_KEY: 'demo-auth-secret-key-0123456789abcdef',
  COMMUNICATION_PAYLOAD_KEY: 'demo-communication-payload-key-0123456789',
};

function problemsOf(env: Record<string, string>): string {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems.join('\n');
  }
  return expect.unreachable('Konfiguration hätte abgelehnt werden müssen');
}

describe('Phase 14 – Live↔Demo-Wechsel: STAFF_DEMO_URL / STAFF_LIVE_URL', () => {
  it('D-C1. ohne Variablen gibt es keine Gegen-URL (counterpart null) – in jeder Umgebung', () => {
    expect(loadConfig({ APP_ENV: 'development' }).environmentLinks.counterpart).toBeNull();
    expect(loadConfig(productionEnv).environmentLinks.counterpart).toBeNull();
    expect(loadConfig(demoEnv).environmentLinks.counterpart).toBeNull();
    // Leere Werte (wie in .env.example) gelten als nicht gesetzt.
    expect(
      loadConfig({ ...productionEnv, STAFF_DEMO_URL: '   ' }).environmentLinks.counterpart,
    ).toBeNull();
  });

  it('D-C2. production mit STAFF_DEMO_URL ⇒ counterpart demo, auf den Origin normalisiert', () => {
    const config = loadConfig({
      ...productionEnv,
      STAFF_DEMO_URL: 'https://Demo.Miet-Royal.Example:443/',
    });
    expect(config.environmentLinks.counterpart).toEqual({
      kind: 'demo',
      url: 'https://demo.miet-royal.example',
    });
    // staging darf ebenfalls auf die Demo verweisen.
    const staging = loadConfig({
      ...productionEnv,
      APP_ENV: 'staging',
      STAFF_DEMO_URL: 'https://demo.miet-royal.example',
    });
    expect(staging.environmentLinks.counterpart?.kind).toBe('demo');
  });

  it('D-C3. demo mit STAFF_LIVE_URL ⇒ counterpart live (nur Origin)', () => {
    const config = loadConfig({ ...demoEnv, STAFF_LIVE_URL: 'https://app.miet-royal.example' });
    expect(config.environmentLinks.counterpart).toEqual({
      kind: 'live',
      url: 'https://app.miet-royal.example',
    });
  });

  it('D-C4. demo lehnt STAFF_DEMO_URL ab (die Demo verlinkt nur nach Live)', () => {
    const problems = problemsOf({ ...demoEnv, STAFF_DEMO_URL: 'https://demo.miet-royal.example' });
    expect(problems).toContain('STAFF_DEMO_URL: in demo nicht zulässig');
  });

  it('D-C5. production lehnt STAFF_LIVE_URL ab (Live verlinkt nur zur Demo)', () => {
    const problems = problemsOf({
      ...productionEnv,
      STAFF_LIVE_URL: 'https://app.miet-royal.example',
    });
    expect(problems).toContain('STAFF_LIVE_URL: in production nicht zulässig');
  });

  it('D-C6. beide Variablen gleichzeitig sind nie zulässig (genau eine Gegen-Umgebung)', () => {
    const problems = problemsOf({
      APP_ENV: 'development',
      STAFF_DEMO_URL: 'http://localhost:3012',
      STAFF_LIVE_URL: 'http://localhost:3002',
    });
    expect(problems).toContain('STAFF_DEMO_URL/STAFF_LIVE_URL: nur eine Gegen-URL je Umgebung');
  });

  it('D-C7. https ist Pflicht – http nur in development', () => {
    for (const env of [productionEnv, { ...productionEnv, APP_ENV: 'staging' }]) {
      const problems = problemsOf({ ...env, STAFF_DEMO_URL: 'http://demo.miet-royal.example' });
      expect(problems).toContain('STAFF_DEMO_URL: nur der Origin ist zulässig – nur https://');
    }
    expect(problemsOf({ ...demoEnv, STAFF_LIVE_URL: 'http://app.miet-royal.example' })).toContain(
      'STAFF_LIVE_URL: nur der Origin ist zulässig – nur https://',
    );
    const dev = loadConfig({ APP_ENV: 'development', STAFF_DEMO_URL: 'http://localhost:3012' });
    expect(dev.environmentLinks.counterpart).toEqual({
      kind: 'demo',
      url: 'http://localhost:3012',
    });
  });

  it('D-C8. Pfad, Query, Fragment, Zugangsdaten und relative Angaben werden abgelehnt', () => {
    const cases: Array<[string, string]> = [
      ['https://demo.miet-royal.example/login', 'kein Pfad'],
      ['https://demo.miet-royal.example/?next=1', 'keine Query'],
      ['https://demo.miet-royal.example/#top', 'kein Fragment'],
      ['https://user:pw@demo.miet-royal.example', 'keine Zugangsdaten'],
      ['ftp://demo.miet-royal.example', 'nur https://'],
    ];
    for (const [value, expected] of cases) {
      const problems = problemsOf({ ...productionEnv, STAFF_DEMO_URL: value });
      expect(problems, value).toContain('STAFF_DEMO_URL: nur der Origin ist zulässig');
      expect(problems, value).toContain(expected);
    }
    expect(problemsOf({ ...productionEnv, STAFF_DEMO_URL: 'demo.miet-royal.example' })).toContain(
      'STAFF_DEMO_URL: muss eine absolute URL sein',
    );
  });

  it('D-C9. Isolation: dieselbe Ziel-URL in beiden Richtungen ist eine Kollision', () => {
    const prod = loadConfig({
      ...productionEnv,
      STAFF_DEMO_URL: 'https://staff.miet-royal.example',
    });
    const demo = loadConfig({ ...demoEnv, STAFF_LIVE_URL: 'https://staff.miet-royal.example' });
    try {
      assertConfigsIsolated(prod, demo);
      expect.unreachable('gleiche Ziel-URL muss erkannt werden');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentIsolationError);
      const collisions = (error as EnvironmentIsolationError).collisions.join('\n');
      expect(collisions).toContain('STAFF_DEMO_URL/STAFF_LIVE_URL');
      expect(collisions).toContain('dieselbe Ziel-URL');
    }
  });

  it('D-C10. Isolation: die eigene MAIL_PUBLIC_WEB_BASE_URL als Gegen-URL ist eine Kollision', () => {
    const prod = loadConfig({
      ...productionEnv,
      MAIL_PUBLIC_WEB_BASE_URL: 'https://www.miet-royal.example/',
      STAFF_DEMO_URL: 'https://www.miet-royal.example',
    });
    const demo = loadConfig({ ...demoEnv, STAFF_LIVE_URL: 'https://app.miet-royal.example' });
    try {
      assertConfigsIsolated(prod, demo);
      expect.unreachable('eigene Web-URL als Gegen-URL muss erkannt werden');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentIsolationError);
      const collisions = (error as EnvironmentIsolationError).collisions.join('\n');
      expect(collisions).toContain(
        'STAFF_DEMO_URL: production nennt die eigene MAIL_PUBLIC_WEB_BASE_URL',
      );
    }
  });

  it('D-C11. Isolation: korrekt verlinkte production/demo-Konfigurationen bleiben isoliert; Meldungen nennen keine Secrets', () => {
    const prod = loadConfig({
      ...productionEnv,
      MAIL_PUBLIC_WEB_BASE_URL: 'https://www.miet-royal.example',
      STAFF_DEMO_URL: 'https://demo.miet-royal.example',
    });
    const demo = loadConfig({
      ...demoEnv,
      MAIL_PUBLIC_WEB_BASE_URL: 'https://demo-web.miet-royal.example',
      STAFF_LIVE_URL: 'https://app.miet-royal.example',
    });
    expect(() => assertConfigsIsolated(prod, demo)).not.toThrow();

    // Kollisionsmeldung nennt die (nicht geheime) URL, aber nie Schlüssel/Passwörter.
    const demoSame = loadConfig({ ...demoEnv, STAFF_LIVE_URL: 'https://demo.miet-royal.example' });
    try {
      assertConfigsIsolated(prod, demoSame);
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('https://demo.miet-royal.example');
      expect(message).not.toContain('prod-secret');
      expect(message).not.toContain('prod-auth-secret-key');
      expect(message).not.toContain('communication-payload-key');
    }
  });
});
