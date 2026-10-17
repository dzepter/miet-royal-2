import { describe, expect, it } from 'vitest';
import {
  assertConfigsIsolated,
  ConfigError,
  EnvironmentIsolationError,
  loadConfig,
} from '../src/index.ts';

describe('loadConfig', () => {
  it('lädt development mit sicheren lokalen Defaults ohne .env', () => {
    const config = loadConfig({ APP_ENV: 'development' });
    expect(config.appEnv).toBe('development');
    expect(config.databaseUrl).toContain('mietroyal_dev');
    expect(config.storage).toEqual({ driver: 'fs', fsRoot: '.storage' });
    expect(config.api.port).toBe(3001);
  });

  it('lehnt unbekanntes APP_ENV ab', () => {
    expect(() => loadConfig({ APP_ENV: 'produktion' })).toThrow(ConfigError);
  });

  it('verlangt DATABASE_URL und Storage in production (keine stillen Defaults)', () => {
    try {
      loadConfig({ APP_ENV: 'production' });
      expect.unreachable('production ohne DATABASE_URL darf nicht starten');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const problems = (error as ConfigError).problems.join('\n');
      expect(problems).toContain('DATABASE_URL');
      expect(problems).toContain('STORAGE_DRIVER');
    }
  });

  it('meldet fehlende Variablennamen, aber niemals Werte', () => {
    try {
      loadConfig({
        APP_ENV: 'production',
        DATABASE_URL: 'postgresql://user:geheimes-passwort@db.example/mietroyal',
        STORAGE_DRIVER: 's3',
      });
      expect.unreachable('unvollständige S3-Konfiguration darf nicht starten');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('STORAGE_S3_BUCKET');
      expect((error as ConfigError).message).not.toContain('geheimes-passwort');
    }
  });

  it('akzeptiert vollständige production-Konfiguration', () => {
    const config = loadConfig({
      APP_ENV: 'production',
      DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_prod',
      STORAGE_DRIVER: 's3',
      STORAGE_S3_ENDPOINT: 'https://s3.example.com',
      STORAGE_S3_REGION: 'eu-central-1',
      STORAGE_S3_BUCKET: 'mietroyal-prod',
      STORAGE_S3_ACCESS_KEY_ID: 'prod-key',
      STORAGE_S3_SECRET_ACCESS_KEY: 'prod-secret',
      AUTH_SECRET_KEY: 'prod-auth-secret-key-0123456789abcdef',
      LOG_LEVEL: 'info',
      API_PORT: '8080',
    });
    expect(config.api.port).toBe(8080);
    expect(config.storage.driver).toBe('s3');
  });

  it('lehnt eine Nicht-Postgres-DATABASE_URL ab', () => {
    expect(() =>
      loadConfig({ APP_ENV: 'development', DATABASE_URL: 'mysql://root@localhost/db' }),
    ).toThrow(ConfigError);
  });

  it('lehnt einen zu kurzen AUTH_SECRET_KEY ab', () => {
    expect(() => loadConfig({ APP_ENV: 'development', AUTH_SECRET_KEY: 'zu-kurz' })).toThrow(
      ConfigError,
    );
  });
});

// Phase-1-Pflichttest 23: Die Demo-/Production-Isolation bleibt grün –
// inklusive des neuen AUTH_SECRET_KEY (2FA-Verschlüsselung je Umgebung).
describe('assertConfigsIsolated (Demo/Live-Trennung – Pflichttest 23)', () => {
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
  };
  const demoAuthKey = { AUTH_SECRET_KEY: 'demo-auth-secret-key-0123456789abcdef' };

  it('akzeptiert vollständig getrennte production/demo-Konfigurationen', () => {
    const prod = loadConfig(productionEnv);
    const demo = loadConfig({
      ...productionEnv,
      ...demoAuthKey,
      APP_ENV: 'demo',
      DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_demo',
      STORAGE_S3_BUCKET: 'mietroyal-demo',
      STORAGE_S3_ACCESS_KEY_ID: 'demo-key',
      STORAGE_S3_SECRET_ACCESS_KEY: 'demo-secret',
    });
    expect(() => assertConfigsIsolated(prod, demo)).not.toThrow();
  });

  it('erkennt dieselbe Datenbank trotz unterschiedlicher URL-Schreibweise', () => {
    const prod = loadConfig(productionEnv);
    const demo = loadConfig({
      ...productionEnv,
      ...demoAuthKey,
      APP_ENV: 'demo',
      // postgres:// statt postgresql://, Default-Port weggelassen – gleiche DB!
      DATABASE_URL: 'postgres://andererUser:anderesPw@db.internal/mietroyal_prod',
      STORAGE_S3_BUCKET: 'mietroyal-demo',
      STORAGE_S3_ACCESS_KEY_ID: 'demo-key',
      STORAGE_S3_SECRET_ACCESS_KEY: 'demo-secret',
    });
    expect(() => assertConfigsIsolated(prod, demo)).toThrow(EnvironmentIsolationError);
  });

  it('erkennt gemeinsamen S3-Bucket', () => {
    const prod = loadConfig(productionEnv);
    const demo = loadConfig({
      ...productionEnv,
      ...demoAuthKey,
      APP_ENV: 'demo',
      DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_demo',
      STORAGE_S3_ACCESS_KEY_ID: 'demo-key',
      STORAGE_S3_SECRET_ACCESS_KEY: 'demo-secret',
    });
    try {
      assertConfigsIsolated(prod, demo);
      expect.unreachable('gemeinsamer Bucket muss erkannt werden');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentIsolationError);
      expect((error as EnvironmentIsolationError).collisions.join('\n')).toContain(
        'STORAGE_S3_ENDPOINT/STORAGE_S3_BUCKET',
      );
    }
  });

  it('erkennt gemeinsame S3-Zugangsdaten', () => {
    const prod = loadConfig(productionEnv);
    const demo = loadConfig({
      ...productionEnv,
      ...demoAuthKey,
      APP_ENV: 'demo',
      DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_demo',
      STORAGE_S3_BUCKET: 'mietroyal-demo',
    });
    expect(() => assertConfigsIsolated(prod, demo)).toThrow(EnvironmentIsolationError);
  });

  it('erkennt gemeinsamen AUTH_SECRET_KEY', () => {
    const prod = loadConfig(productionEnv);
    const demo = loadConfig({
      ...productionEnv,
      APP_ENV: 'demo',
      DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_demo',
      STORAGE_S3_BUCKET: 'mietroyal-demo',
      STORAGE_S3_ACCESS_KEY_ID: 'demo-key',
      STORAGE_S3_SECRET_ACCESS_KEY: 'demo-secret',
      // AUTH_SECRET_KEY absichtlich identisch zu production
    });
    try {
      assertConfigsIsolated(prod, demo);
      expect.unreachable('gemeinsamer Auth-Schlüssel muss erkannt werden');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentIsolationError);
      expect((error as EnvironmentIsolationError).collisions.join()).toContain('AUTH_SECRET_KEY');
    }
  });

  it('erkennt gemeinsames Filesystem-Storage-Verzeichnis', () => {
    const base = {
      APP_ENV: 'staging',
      DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_staging',
      STORAGE_DRIVER: 'fs',
      STORAGE_FS_ROOT: '/var/lib/mietroyal/storage',
      AUTH_SECRET_KEY: 'staging-auth-secret-key-0123456789abc',
    };
    const staging = loadConfig(base);
    const demo = loadConfig({
      ...base,
      ...demoAuthKey,
      APP_ENV: 'demo',
      DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_demo',
    });
    expect(() => assertConfigsIsolated(staging, demo)).toThrow(EnvironmentIsolationError);
  });
});

describe('Lexware-Konfiguration (Phase 10)', () => {
  const production = {
    APP_ENV: 'production',
    DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_prod',
    STORAGE_DRIVER: 'fs',
    STORAGE_FS_ROOT: '/var/lib/mietroyal/prod',
    AUTH_SECRET_KEY: 'prod-auth-secret-key-0123456789abcdef',
  };

  it('1. production ohne LEXWARE_API_KEY ⇒ nicht aktiv (fail closed), Host fest api.lexware.io', () => {
    const config = loadConfig(production);
    expect(config.lexware.enabled).toBe(false);
    expect(config.lexware.apiKey).toBeNull();
    expect(config.lexware.baseUrl).toBe('https://api.lexware.io');
  });

  it('2. production mit Key ⇒ aktiv; 13./164. fremder Host in production abgelehnt', () => {
    const config = loadConfig({ ...production, LEXWARE_API_KEY: 'prod-key-SYNTH' });
    expect(config.lexware.enabled).toBe(true);
    expect(config.lexware.baseUrl).toBe('https://api.lexware.io');
    expect(() =>
      loadConfig({
        ...production,
        LEXWARE_API_KEY: 'prod-key-SYNTH',
        LEXWARE_BASE_URL: 'https://api.lexoffice.io',
      }),
    ).toThrow(/LEXWARE_BASE_URL/);
    expect(() =>
      loadConfig({
        ...production,
        LEXWARE_API_KEY: 'prod-key-SYNTH',
        LEXWARE_WEBHOOK_CALLBACK_URL: 'http://localhost:3001/webhooks/lexware',
      }),
    ).toThrow(/LEXWARE_WEBHOOK_CALLBACK_URL/);
    // 160. Kein Ersatz-Public-Key in production (Signatur nur mit dem offiziellen Lexware-Schlüssel).
    expect(() =>
      loadConfig({ ...production, LEXWARE_WEBHOOK_PUBLIC_KEY_PEM: '-----BEGIN PUBLIC KEY-----x' }),
    ).toThrow(/LEXWARE_WEBHOOK_PUBLIC_KEY_PEM/);
  });

  it('3./165. demo ist niemals aktiv – ein Key ist dort ein Konfigurationsfehler', () => {
    const demo = {
      ...production,
      APP_ENV: 'demo',
      DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_demo',
      STORAGE_FS_ROOT: '/var/lib/mietroyal/demo',
    };
    expect(loadConfig(demo).lexware.enabled).toBe(false);
    expect(() => loadConfig({ ...demo, LEXWARE_API_KEY: 'x' })).toThrow(/LEXWARE_API_KEY/);
  });

  it('4./166. development/staging nur per explizitem Opt-in; Fake-Host erlaubt', () => {
    const dev = loadConfig({ APP_ENV: 'development', LEXWARE_API_KEY: 'dev-key' });
    expect(dev.lexware.enabled).toBe(false);
    expect(dev.lexware.apiKey).toBeNull();
    const optIn = loadConfig({
      APP_ENV: 'development',
      LEXWARE_API_KEY: 'dev-key',
      LEXWARE_ENABLED: 'true',
      LEXWARE_BASE_URL: 'http://127.0.0.1:4555/',
    });
    expect(optIn.lexware.enabled).toBe(true);
    expect(optIn.lexware.baseUrl).toBe('http://127.0.0.1:4555');
    expect(() => loadConfig({ APP_ENV: 'development', LEXWARE_ENABLED: 'true' })).toThrow(
      /LEXWARE_API_KEY/,
    );
  });

  it('Env-Isolation: derselbe Lexware-Key in zwei Umgebungen kollidiert', () => {
    const a = loadConfig({ ...production, LEXWARE_API_KEY: 'same-key' });
    const b = loadConfig({
      APP_ENV: 'staging',
      DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_staging',
      STORAGE_DRIVER: 'fs',
      STORAGE_FS_ROOT: '/var/lib/mietroyal/staging',
      AUTH_SECRET_KEY: 'staging-auth-secret-key-0123456789abcdef',
      LEXWARE_API_KEY: 'same-key',
      LEXWARE_ENABLED: 'true',
    });
    expect(() => assertConfigsIsolated(a, b)).toThrow(/LEXWARE_API_KEY/);
  });
});
