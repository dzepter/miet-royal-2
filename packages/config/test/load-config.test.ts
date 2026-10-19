import { describe, expect, it } from 'vitest';
import {
  assertConfigsIsolated,
  ConfigError,
  EnvironmentIsolationError,
  loadConfig,
  WHATSAPP_DEFAULT_GRAPH_API_VERSION,
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
      COMMUNICATION_PAYLOAD_KEY: 'prod-communication-payload-key-0123456789',
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
    COMMUNICATION_PAYLOAD_KEY: 'prod-communication-payload-key-0123456789',
  };
  const demoAuthKey = {
    AUTH_SECRET_KEY: 'demo-auth-secret-key-0123456789abcdef',
    COMMUNICATION_PAYLOAD_KEY: 'demo-communication-payload-key-0123456789',
  };

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
      COMMUNICATION_PAYLOAD_KEY: 'staging-communication-payload-key-0123456789',
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
    COMMUNICATION_PAYLOAD_KEY: 'prod-communication-payload-key-0123456789',
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
      COMMUNICATION_PAYLOAD_KEY: 'staging-communication-payload-key-0123456789',
      LEXWARE_API_KEY: 'same-key',
      LEXWARE_ENABLED: 'true',
    });
    expect(() => assertConfigsIsolated(a, b)).toThrow(/LEXWARE_API_KEY/);
  });
});

describe('Kommunikations-Konfiguration (Phase 12)', () => {
  const production = {
    APP_ENV: 'production',
    DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_prod',
    STORAGE_DRIVER: 'fs',
    STORAGE_FS_ROOT: '/var/lib/mietroyal/prod',
    AUTH_SECRET_KEY: 'prod-auth-secret-key-0123456789abcdef',
    COMMUNICATION_PAYLOAD_KEY: 'prod-communication-payload-key-0123456789',
  };
  const smtp = {
    MAIL_ENABLED: 'true',
    MAIL_SMTP_HOST: 'smtp.example.net',
    MAIL_SMTP_USER: 'mailer',
    MAIL_SMTP_PASSWORD: 'SYNTH-smtp-passwort',
    MAIL_FROM_ADDRESS: 'service@example.net',
    // Härtung RA-11: außerhalb von development Pflicht bei MAIL_ENABLED=true.
    MAIL_PUBLIC_WEB_BASE_URL: 'https://www.example.net',
  };

  it('COMMUNICATION_PAYLOAD_KEY ist außerhalb von development Pflicht; development hat einen lokalen Default', () => {
    const { COMMUNICATION_PAYLOAD_KEY: _omit, ...withoutKey } = production;
    expect(() => loadConfig(withoutKey)).toThrow(/COMMUNICATION_PAYLOAD_KEY/);
    expect(() => loadConfig({ ...withoutKey, APP_ENV: 'staging' })).toThrow(
      /COMMUNICATION_PAYLOAD_KEY/,
    );
    expect(() => loadConfig({ ...withoutKey, APP_ENV: 'demo' })).toThrow(
      /COMMUNICATION_PAYLOAD_KEY/,
    );
    expect(loadConfig({ APP_ENV: 'development' }).communication.payloadKey.length).toBeGreaterThan(
      31,
    );
    expect(() =>
      loadConfig({ ...production, COMMUNICATION_PAYLOAD_KEY_PREVIOUS: 'zu-kurz' }),
    ).toThrow(/COMMUNICATION_PAYLOAD_KEY_PREVIOUS/);
    expect(() =>
      loadConfig({
        ...production,
        COMMUNICATION_PAYLOAD_KEY_PREVIOUS: production.COMMUNICATION_PAYLOAD_KEY,
      }),
    ).toThrow(/COMMUNICATION_PAYLOAD_KEY_PREVIOUS/);
    const rotated = loadConfig({
      ...production,
      COMMUNICATION_PAYLOAD_KEY_PREVIOUS: 'prod-communication-payload-key-previous-1',
    });
    expect(rotated.communication.payloadKeyPrevious).toBe(
      'prod-communication-payload-key-previous-1',
    );
  });

  it('Mail ist fail-closed: ohne MAIL_ENABLED=true kein Versand, mit Flag sind SMTP-Daten Pflicht', () => {
    const off = loadConfig(production);
    expect(off.mail.enabled).toBe(false);
    expect(off.mail.smtp).toBeNull();
    expect(off.mail.imap).toBeNull();
    expect(off.mail.fromName).toBe('Miet-Royal Mainz');
    try {
      loadConfig({ ...production, MAIL_ENABLED: 'true' });
      expect.unreachable('MAIL_ENABLED ohne SMTP-Daten darf nicht starten');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const text = (error as ConfigError).message;
      expect(text).toContain('MAIL_SMTP_HOST');
      expect(text).toContain('MAIL_SMTP_PASSWORD');
      expect(text).toContain('MAIL_FROM_ADDRESS');
    }
    const on = loadConfig({ ...production, ...smtp });
    expect(on.mail.enabled).toBe(true);
    expect(on.mail.smtp).toEqual({
      host: 'smtp.example.net',
      port: 465,
      tls: 'implicit',
      user: 'mailer',
      password: 'SYNTH-smtp-passwort',
    });
    expect(on.mail.replyAddress).toBe('service@example.net');
    const starttls = loadConfig({ ...production, ...smtp, MAIL_SMTP_SECURE: 'false' });
    expect(starttls.mail.smtp?.tls).toBe('starttls');
    expect(starttls.mail.smtp?.port).toBe(587);
    expect(() => loadConfig({ ...production, ...smtp, MAIL_SMTP_HOST: 'localhost' })).toThrow(
      /MAIL_SMTP_HOST/,
    );
    expect(() => loadConfig({ ...production, MAIL_FROM_ADDRESS: 'keine-adresse' })).toThrow(
      /MAIL_FROM_ADDRESS/,
    );
  });

  it('Fehlermeldungen nennen nur Variablennamen, nie SMTP-Passwörter', () => {
    try {
      loadConfig({ ...production, ...smtp, MAIL_SMTP_PORT: '99999' });
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigError).message).toContain('MAIL_SMTP_PORT');
      expect((error as ConfigError).message).not.toContain('SYNTH-smtp-passwort');
    }
  });

  it('IMAP nur mit MAIL_IMAP_ENABLED=true + Host + Zugangsdaten (fail-closed); Defaults 993/INBOX', () => {
    // Ohne Opt-in bleibt IMAP aus, auch wenn Zugangsdaten gesetzt sind.
    const off = loadConfig({
      ...production,
      MAIL_IMAP_HOST: 'imap.example.net',
      MAIL_IMAP_USER: 'mailer',
      MAIL_IMAP_PASSWORD: 'SYNTH-imap',
    });
    expect(off.mail.imap).toBeNull();
    expect(() => loadConfig({ ...production, MAIL_IMAP_ENABLED: 'true' })).toThrow(
      /MAIL_IMAP_HOST/,
    );
    expect(() =>
      loadConfig({ ...production, MAIL_IMAP_ENABLED: 'true', MAIL_IMAP_HOST: 'imap.example.net' }),
    ).toThrow(/MAIL_IMAP_USER/);
    const config = loadConfig({
      ...production,
      MAIL_IMAP_ENABLED: 'true',
      MAIL_IMAP_HOST: 'imap.example.net',
      MAIL_IMAP_USER: 'mailer',
      MAIL_IMAP_PASSWORD: 'SYNTH-imap',
    });
    expect(config.mail.imap).toEqual({
      host: 'imap.example.net',
      port: 993,
      tls: 'implicit',
      user: 'mailer',
      password: 'SYNTH-imap',
      folder: 'INBOX',
    });
    expect(() =>
      loadConfig({
        ...production,
        MAIL_IMAP_ENABLED: 'true',
        MAIL_IMAP_HOST: 'localhost',
        MAIL_IMAP_USER: 'mailer',
        MAIL_IMAP_PASSWORD: 'SYNTH-imap',
      }),
    ).toThrow(/MAIL_IMAP_HOST/);
  });

  it('demo sendet nur mit Whitelist; production lehnt eine Whitelist ab', () => {
    const demo = {
      ...production,
      APP_ENV: 'demo',
      DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_demo',
      STORAGE_FS_ROOT: '/var/lib/mietroyal/demo',
      ...smtp,
    };
    expect(() => loadConfig(demo)).toThrow(/MAIL_DEMO_WHITELIST/);
    const ok = loadConfig({
      ...demo,
      MAIL_DEMO_WHITELIST: ' Tester@Example.net, @demo.example.org ',
    });
    expect(ok.mail.demoWhitelist).toEqual(['tester@example.net', '@demo.example.org']);
    expect(() => loadConfig({ ...demo, MAIL_DEMO_WHITELIST: 'kein-eintrag' })).toThrow(
      /MAIL_DEMO_WHITELIST/,
    );
    expect(() =>
      loadConfig({ ...production, ...smtp, MAIL_DEMO_WHITELIST: 'x@example.net' }),
    ).toThrow(/MAIL_DEMO_WHITELIST/);
    // Außerhalb von demo wird eine (z. B. in staging) gesetzte Whitelist nicht wirksam.
    const staging = loadConfig({
      ...demo,
      APP_ENV: 'staging',
      MAIL_DEMO_WHITELIST: 'x@example.net',
    });
    expect(staging.mail.demoWhitelist).toEqual([]);
  });

  it('RA-11 MAIL_PUBLIC_WEB_BASE_URL ist in production/staging/demo bei MAIL_ENABLED=true Pflicht (development: lokaler Default)', () => {
    const { MAIL_PUBLIC_WEB_BASE_URL: _omit, ...smtpWithoutBase } = smtp;
    const demoBase = {
      ...production,
      APP_ENV: 'demo',
      DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_demo',
      STORAGE_FS_ROOT: '/var/lib/mietroyal/demo',
      MAIL_DEMO_WHITELIST: 'tester@example.net',
    };
    for (const env of [
      { ...production, ...smtpWithoutBase },
      { ...production, ...smtpWithoutBase, APP_ENV: 'staging' },
      { ...demoBase, ...smtpWithoutBase },
    ]) {
      try {
        loadConfig(env);
        expect.unreachable(
          `${env.APP_ENV}: MAIL_ENABLED ohne MAIL_PUBLIC_WEB_BASE_URL darf nicht starten`,
        );
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).message).toContain('MAIL_PUBLIC_WEB_BASE_URL');
        expect((error as ConfigError).message).not.toContain('SYNTH-smtp-passwort');
      }
    }
    // Ohne MAIL_ENABLED bleibt die Basis-URL optional (Mail ist ohnehin aus).
    expect(loadConfig(production).mail.publicWebBaseUrl).toBeNull();
    // development: lokaler Default in publicWebBaseUrlFor – keine Pflicht.
    expect(
      loadConfig({ APP_ENV: 'development', ...smtpWithoutBase }).mail.publicWebBaseUrl,
    ).toBeNull();
    expect(loadConfig({ ...demoBase, ...smtp }).mail.publicWebBaseUrl).toBe(
      'https://www.example.net',
    );
  });

  it('MAIL_PUBLIC_WEB_BASE_URL: absolut, in production HTTPS, ohne Slash am Ende', () => {
    expect(
      loadConfig({ ...production, ...smtp, MAIL_PUBLIC_WEB_BASE_URL: 'https://www.example.de/' })
        .mail.publicWebBaseUrl,
    ).toBe('https://www.example.de');
    expect(() =>
      loadConfig({ ...production, ...smtp, MAIL_PUBLIC_WEB_BASE_URL: 'http://www.example.de' }),
    ).toThrow(/MAIL_PUBLIC_WEB_BASE_URL/);
    expect(() =>
      loadConfig({ APP_ENV: 'development', MAIL_PUBLIC_WEB_BASE_URL: 'www.example.de' }),
    ).toThrow(/MAIL_PUBLIC_WEB_BASE_URL/);
  });

  const whatsappLive = {
    WHATSAPP_ENABLED: 'true',
    WHATSAPP_ACCESS_TOKEN: 'SYNTH-token',
    WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
    WHATSAPP_BUSINESS_ACCOUNT_ID: '987654321098765',
    WHATSAPP_APP_SECRET: 'SYNTH-app-secret-0123456789',
    WHATSAPP_VERIFY_TOKEN: 'SYNTH-verify-token-0123456789',
  };

  it('WhatsApp: production live nur komplett per Opt-in, Host fest graph.facebook.com', () => {
    const off = loadConfig(production);
    expect(off.whatsapp.mode).toBe('disabled');
    expect(off.whatsapp.accessToken).toBeNull();
    const live = loadConfig({ ...production, ...whatsappLive });
    expect(live.whatsapp.mode).toBe('live');
    expect(live.whatsapp.baseUrl).toBe('https://graph.facebook.com');
    // W1: Default = aktuelle offiziell veröffentlichte Graph-Version (verifiziert 2026-10-19).
    expect(live.whatsapp.graphApiVersion).toBe('v26.0');
    expect(WHATSAPP_DEFAULT_GRAPH_API_VERSION).toBe('v26.0');
    // Explizite, noch unterstützte Version bleibt möglich; abgelaufene werden abgelehnt.
    expect(
      loadConfig({ ...production, ...whatsappLive, WHATSAPP_GRAPH_API_VERSION: 'v25.0' }).whatsapp
        .graphApiVersion,
    ).toBe('v25.0');
    expect(() =>
      loadConfig({ ...production, ...whatsappLive, WHATSAPP_GRAPH_API_VERSION: 'v20.0' }),
    ).toThrow(/WHATSAPP_GRAPH_API_VERSION/);
    expect(() =>
      loadConfig({ ...production, ...whatsappLive, WHATSAPP_GRAPH_API_VERSION: 'latest' }),
    ).toThrow(/WHATSAPP_GRAPH_API_VERSION/);
    expect(live.whatsapp.appSecret).toBe('SYNTH-app-secret-0123456789');
    const { WHATSAPP_APP_SECRET: _omit, ...incomplete } = whatsappLive;
    expect(() => loadConfig({ ...production, ...incomplete })).toThrow(/WHATSAPP_APP_SECRET/);
    expect(() =>
      loadConfig({
        ...production,
        ...whatsappLive,
        WHATSAPP_BASE_URL: 'https://graph.evil.example',
      }),
    ).toThrow(/WHATSAPP_BASE_URL/);
    expect(() =>
      loadConfig({ ...production, ...whatsappLive, WHATSAPP_GRAPH_API_VERSION: '25' }),
    ).toThrow(/WHATSAPP_GRAPH_API_VERSION/);
    // Ohne Opt-in bleiben gesetzte Zugangsdaten unbenutzt (disabled, keine Secrets im Objekt).
    const noOptIn = loadConfig({ ...production, ...whatsappLive, WHATSAPP_ENABLED: 'false' });
    expect(noOptIn.whatsapp.mode).toBe('disabled');
    expect(noOptIn.whatsapp.accessToken).toBeNull();
  });

  it('WhatsApp: demo immer simuliert (Zugangsdaten dort ein Fehler); development mock, staging disabled, Opt-in live mit Fake-Host', () => {
    const demo = {
      ...production,
      APP_ENV: 'demo',
      DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_demo',
      STORAGE_FS_ROOT: '/var/lib/mietroyal/demo',
    };
    expect(loadConfig(demo).whatsapp.mode).toBe('mock');
    expect(() => loadConfig({ ...demo, WHATSAPP_ACCESS_TOKEN: 'x' })).toThrow(/WHATSAPP_/);
    expect(() => loadConfig({ ...demo, WHATSAPP_ENABLED: 'true' })).toThrow(/WHATSAPP_/);
    expect(loadConfig({ APP_ENV: 'development' }).whatsapp.mode).toBe('mock');
    expect(
      loadConfig({
        ...production,
        APP_ENV: 'staging',
        DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_staging',
      }).whatsapp.mode,
    ).toBe('disabled');
    const optIn = loadConfig({
      APP_ENV: 'development',
      ...whatsappLive,
      WHATSAPP_BASE_URL: 'http://127.0.0.1:4560/',
    });
    expect(optIn.whatsapp.mode).toBe('live');
    expect(optIn.whatsapp.baseUrl).toBe('http://127.0.0.1:4560');
  });

  it('Push: aktiv nur mit vollständigem VAPID-Tripel; Subject mailto: oder https://', () => {
    expect(loadConfig(production).push.enabled).toBe(false);
    expect(() => loadConfig({ ...production, PUSH_VAPID_PUBLIC_KEY: 'pub' })).toThrow(
      /PUSH_VAPID_PRIVATE_KEY/,
    );
    expect(() =>
      loadConfig({
        ...production,
        PUSH_VAPID_PUBLIC_KEY: 'pub',
        PUSH_VAPID_PRIVATE_KEY: 'priv',
        PUSH_VAPID_SUBJECT: 'service@example.net',
      }),
    ).toThrow(/PUSH_VAPID_SUBJECT/);
    const on = loadConfig({
      ...production,
      PUSH_VAPID_PUBLIC_KEY: 'pub',
      PUSH_VAPID_PRIVATE_KEY: 'priv',
      PUSH_VAPID_SUBJECT: 'mailto:service@example.net',
    });
    expect(on.push).toEqual({
      enabled: true,
      vapidPublicKey: 'pub',
      vapidPrivateKey: 'priv',
      vapidSubject: 'mailto:service@example.net',
    });
  });

  it('Env-Isolation: Kommunikationsschlüssel, WhatsApp-Zugang, VAPID-Paar und IMAP-Postfach dürfen nicht geteilt werden', () => {
    const base = {
      ...production,
      ...whatsappLive,
      PUSH_VAPID_PUBLIC_KEY: 'pub',
      PUSH_VAPID_PRIVATE_KEY: 'priv',
      PUSH_VAPID_SUBJECT: 'mailto:service@example.net',
      MAIL_IMAP_ENABLED: 'true',
      MAIL_IMAP_HOST: 'imap.example.net',
      MAIL_IMAP_USER: 'Mailer',
      MAIL_IMAP_PASSWORD: 'SYNTH-imap',
    };
    const prod = loadConfig(base);
    const staging = loadConfig({
      ...base,
      APP_ENV: 'staging',
      DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_staging',
      STORAGE_FS_ROOT: '/var/lib/mietroyal/staging',
      AUTH_SECRET_KEY: 'staging-auth-secret-key-0123456789abcdef',
      MAIL_IMAP_USER: 'mailer',
    });
    try {
      assertConfigsIsolated(prod, staging);
      expect.unreachable('geteilte Kommunikationsgeheimnisse müssen erkannt werden');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentIsolationError);
      const text = (error as EnvironmentIsolationError).collisions.join('\n');
      expect(text).toContain('COMMUNICATION_PAYLOAD_KEY');
      expect(text).toContain('WHATSAPP_ACCESS_TOKEN');
      expect(text).toContain('WHATSAPP_APP_SECRET');
      expect(text).toContain('WHATSAPP_PHONE_NUMBER_ID');
      expect(text).toContain('PUSH_VAPID_PRIVATE_KEY');
      expect(text).toContain('MAIL_IMAP_*');
      expect(text).not.toContain('SYNTH');
    }
    // Vorgängerschlüssel der einen Umgebung = aktueller Schlüssel der anderen ⇒ Kollision.
    const rotatedDemo = loadConfig({
      ...production,
      APP_ENV: 'demo',
      DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_demo',
      STORAGE_FS_ROOT: '/var/lib/mietroyal/demo',
      AUTH_SECRET_KEY: 'demo-auth-secret-key-0123456789abcdef',
      COMMUNICATION_PAYLOAD_KEY: 'demo-communication-payload-key-0123456789',
      COMMUNICATION_PAYLOAD_KEY_PREVIOUS: production.COMMUNICATION_PAYLOAD_KEY,
    });
    expect(() => assertConfigsIsolated(loadConfig(production), rotatedDemo)).toThrow(
      /COMMUNICATION_PAYLOAD_KEY/,
    );
    const separated = loadConfig({
      ...base,
      APP_ENV: 'staging',
      DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_staging',
      STORAGE_FS_ROOT: '/var/lib/mietroyal/staging',
      AUTH_SECRET_KEY: 'staging-auth-secret-key-0123456789abcdef',
      COMMUNICATION_PAYLOAD_KEY: 'staging-communication-payload-key-0123456789',
      WHATSAPP_ACCESS_TOKEN: 'SYNTH-token-staging',
      WHATSAPP_PHONE_NUMBER_ID: '111111111111111',
      WHATSAPP_APP_SECRET: 'SYNTH-app-secret-staging-0123',
      PUSH_VAPID_PUBLIC_KEY: 'pub-staging',
      PUSH_VAPID_PRIVATE_KEY: 'priv-staging',
      MAIL_IMAP_FOLDER: 'Staging',
    });
    expect(() => assertConfigsIsolated(prod, separated)).not.toThrow();
  });
});
