/**
 * Härtung Review A (Phase 12, Order §§5/11/13/20) – Konfiguration:
 *  RA-11 production/staging/demo lehnen MAIL_ENABLED=true OHNE
 *        MAIL_PUBLIC_WEB_BASE_URL beim Start ab (vorher: Angebot „versendet“,
 *        jede Link-Mail scheiterte erst im Job mit PUBLIC_WEB_BASE_URL_MISSING).
 *  RA-CFG (kein Fund) ConfigError enthält keine Secret-Werte.
 */
import { ConfigError, loadConfig } from '@mietroyal/config';
import { describe, expect, it } from 'vitest';
import { createOfferDeliveryGateway } from '../src/commerce/delivery-gateway.ts';
import { createOutboundMailGateway } from '../src/communication/mail/gateways.ts';
import { publicWebBaseUrlFor } from '../src/communication/mail/send-job.ts';
import { renderMail } from '../src/communication/mail/templates/index.ts';

function productionEnv(extra: Record<string, string> = {}) {
  return {
    APP_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db.example.invalid:5432/prod',
    AUTH_SECRET_KEY: '1'.repeat(64),
    COMMUNICATION_PAYLOAD_KEY: 'c1'.repeat(32),
    STORAGE_DRIVER: 'fs',
    STORAGE_FS_ROOT: '/var/lib/mietroyal/storage',
    LOG_LEVEL: 'error',
    ...extra,
  };
}

const SMTP = {
  MAIL_ENABLED: 'true',
  MAIL_SMTP_HOST: 'smtp.provider.example',
  MAIL_SMTP_USER: 'mailer@miet-royal.example',
  MAIL_SMTP_PASSWORD: 'secret-smtp-password-ra11',
  MAIL_FROM_ADDRESS: 'noreply@miet-royal.example',
};

describe('Härtung Review A – Mailkonfiguration ohne öffentliche Basis-URL (RA-11)', () => {
  it('RA-11 production/staging/demo mit MAIL_ENABLED=true ohne MAIL_PUBLIC_WEB_BASE_URL starten nicht (ConfigError ohne Secret)', () => {
    for (const env of [
      productionEnv(SMTP),
      productionEnv({ ...SMTP, APP_ENV: 'staging' }),
      productionEnv({ ...SMTP, APP_ENV: 'demo', MAIL_DEMO_WHITELIST: 'tester@miet-royal.test' }),
    ]) {
      let error: unknown = null;
      try {
        loadConfig(env);
      } catch (caught) {
        error = caught;
      }
      expect(error, env.APP_ENV).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('MAIL_PUBLIC_WEB_BASE_URL');
      expect((error as ConfigError).message).not.toContain('secret-smtp-password-ra11');
    }
  });

  it('RA-11 mit Basis-URL: Gateway smtp, Angebotsversand nicht blockiert, Link-Mails renderbar', () => {
    const config = loadConfig(
      productionEnv({ ...SMTP, MAIL_PUBLIC_WEB_BASE_URL: 'https://www.miet-royal.example/' }),
    );
    expect(config.mail.enabled).toBe(true);
    expect(config.mail.publicWebBaseUrl).toBe('https://www.miet-royal.example');
    const gateway = createOutboundMailGateway(config);
    expect(gateway.kind).toBe('smtp');
    const offerGateway = createOfferDeliveryGateway(config, {
      outbox: {} as never,
      mailGateway: gateway,
    });
    expect(() => offerGateway.assertConfigured()).not.toThrow();
    const rendered = renderMail(
      'offer',
      {
        salutation: 'Hallo,',
        processNumber: 'MR-2026-0001',
        eventDate: '2026-11-20',
        validUntil: '2026-11-01T10:00:00Z',
      },
      { offerToken: 'offer-token-abcdefghijklmnop' },
      { appEnv: 'production', publicWebBaseUrl: publicWebBaseUrlFor(config) },
    );
    expect(rendered.text).toContain(
      'https://www.miet-royal.example/angebot/offer-token-abcdefghijklmnop',
    );
  });

  it('RA-11 ohne MAIL_ENABLED bleibt die Basis-URL optional; development nutzt den lokalen Default', () => {
    expect(loadConfig(productionEnv()).mail.publicWebBaseUrl).toBeNull();
    const dev = loadConfig({ APP_ENV: 'development', ...SMTP });
    expect(dev.mail.publicWebBaseUrl).toBeNull();
    expect(publicWebBaseUrlFor(dev)).toBe('http://localhost:3000');
  });
});

describe('Härtung Review A – ConfigError enthält keine Secret-Werte (kein Fund)', () => {
  it('RA-CFG zu kurzer COMMUNICATION_PAYLOAD_KEY / zu langes SMTP-Passwort ⇒ Meldung ohne Wert', () => {
    const shortKey = 'short-secret-key-value';
    const longPassword = `pw-${'x'.repeat(1100)}`;
    let message = '';
    try {
      loadConfig(
        productionEnv({
          ...SMTP,
          COMMUNICATION_PAYLOAD_KEY: shortKey,
          MAIL_SMTP_PASSWORD: longPassword,
          WHATSAPP_APP_SECRET: 'wa-app-secret-value-123',
        }),
      );
    } catch (error) {
      message = error instanceof Error ? `${error.message} ${JSON.stringify(error)}` : '';
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(shortKey);
    expect(message).not.toContain('x'.repeat(50));
    expect(message).not.toContain('wa-app-secret-value-123');
  });
});
