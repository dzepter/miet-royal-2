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
});

describe('assertConfigsIsolated (Demo/Live-Trennung)', () => {
  const productionEnv = {
    APP_ENV: 'production',
    DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_prod',
    STORAGE_DRIVER: 's3',
    STORAGE_S3_ENDPOINT: 'https://s3.example.com',
    STORAGE_S3_REGION: 'eu-central-1',
    STORAGE_S3_BUCKET: 'mietroyal-prod',
    STORAGE_S3_ACCESS_KEY_ID: 'prod-key',
    STORAGE_S3_SECRET_ACCESS_KEY: 'prod-secret',
  };

  it('akzeptiert vollständig getrennte production/demo-Konfigurationen', () => {
    const prod = loadConfig(productionEnv);
    const demo = loadConfig({
      ...productionEnv,
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
      APP_ENV: 'demo',
      DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_demo',
      STORAGE_S3_BUCKET: 'mietroyal-demo',
    });
    expect(() => assertConfigsIsolated(prod, demo)).toThrow(EnvironmentIsolationError);
  });

  it('erkennt gemeinsames Filesystem-Storage-Verzeichnis', () => {
    const base = {
      APP_ENV: 'staging',
      DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_staging',
      STORAGE_DRIVER: 'fs',
      STORAGE_FS_ROOT: '/var/lib/mietroyal/storage',
    };
    const staging = loadConfig(base);
    const demo = loadConfig({
      ...base,
      APP_ENV: 'demo',
      DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_demo',
    });
    expect(() => assertConfigsIsolated(staging, demo)).toThrow(EnvironmentIsolationError);
  });
});
