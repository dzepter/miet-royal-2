import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.ts';

/**
 * Phase 15 (Kundenportal, Design §4.2): feste Einstiegswerte des Portals –
 * `PORTAL_NEW_INQUIRY_URL` („Neue Anfrage starten“, Order §36) und
 * `COMPANY_PHONE_NUMBER` (Anruf-Button, Order §37). Beide optional (Go-live-
 * Punkte in OPEN_ITEMS/PRE_START_CHECKLIST), nie Secrets, nie erfunden:
 * fehlt ein Wert, liefert `config.portal` null. Namen laufen als „E-C<n>“.
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
  throw new Error('loadConfig hätte scheitern müssen');
}

describe('Portal-Konfiguration (Phase 15, PLATFORM)', () => {
  it('E-C1. Default: ohne PORTAL_NEW_INQUIRY_URL und COMPANY_PHONE_NUMBER ist config.portal in jeder Umgebung { newInquiryUrl: null, phoneNumber: null }', () => {
    expect(loadConfig({ APP_ENV: 'development' }).portal).toEqual({
      newInquiryUrl: null,
      phoneNumber: null,
    });
    expect(loadConfig(productionEnv).portal).toEqual({ newInquiryUrl: null, phoneNumber: null });
    expect(loadConfig(demoEnv).portal).toEqual({ newInquiryUrl: null, phoneNumber: null });
    // Wie bei MAIL_PUBLIC_WEB_BASE_URL/LEXWARE_BASE_URL: ein LEERER Wert ist kein „nicht
    // gesetzt“, sondern ein Konfigurationsfehler – die Variable wird dann weggelassen.
    expect(problemsOf({ APP_ENV: 'development', PORTAL_NEW_INQUIRY_URL: '' })).toContain(
      'PORTAL_NEW_INQUIRY_URL',
    );
    expect(problemsOf({ APP_ENV: 'development', COMPANY_PHONE_NUMBER: '' })).toContain(
      'COMPANY_PHONE_NUMBER',
    );
  });

  it('E-C2. gültige Werte werden unverändert übernommen (URL auch mit Pfad/Query; Telefonnummer mit +, Leerzeichen, -, /, Klammern)', () => {
    const config = loadConfig({
      ...productionEnv,
      PORTAL_NEW_INQUIRY_URL: 'https://www.example.de/anfrage?quelle=portal',
      COMPANY_PHONE_NUMBER: '+49 6131 123456-0',
    });
    expect(config.portal).toEqual({
      newInquiryUrl: 'https://www.example.de/anfrage?quelle=portal',
      phoneNumber: '+49 6131 123456-0',
    });
    for (const phone of ['06131 123456', '+49 (0) 6131 / 12 34 56', '0049613112345']) {
      expect(
        loadConfig({ APP_ENV: 'development', COMPANY_PHONE_NUMBER: phone }).portal.phoneNumber,
      ).toBe(phone);
    }
  });

  it('E-C3. ungültige PORTAL_NEW_INQUIRY_URL (relativ, ohne Schema, mit Leerzeichen, javascript:) ⇒ ConfigError, der nur den Variablennamen nennt', () => {
    for (const url of [
      '/anfrage',
      'www.example.de/anfrage',
      'https://www.example.de/an frage',
      'javascript:alert(1)',
      'mailto:info@example.de',
    ]) {
      const problems = problemsOf({ APP_ENV: 'development', PORTAL_NEW_INQUIRY_URL: url });
      expect(problems, url).toContain('PORTAL_NEW_INQUIRY_URL');
    }
  });

  it('E-C4. http-URL ist in production ein Konfigurationsfehler (nur https); development/demo erlauben http', () => {
    const problems = problemsOf({
      ...productionEnv,
      PORTAL_NEW_INQUIRY_URL: 'http://www.example.de/anfrage',
    });
    expect(problems).toContain('PORTAL_NEW_INQUIRY_URL');
    expect(problems).toContain('https');
    expect(
      loadConfig({
        APP_ENV: 'development',
        PORTAL_NEW_INQUIRY_URL: 'http://localhost:3100/anfrage',
      }).portal.newInquiryUrl,
    ).toBe('http://localhost:3100/anfrage');
    expect(
      loadConfig({ ...demoEnv, PORTAL_NEW_INQUIRY_URL: 'http://demo.internal/anfrage' }).portal
        .newInquiryUrl,
    ).toBe('http://demo.internal/anfrage');
    expect(
      loadConfig({ ...productionEnv, PORTAL_NEW_INQUIRY_URL: 'https://www.example.de/anfrage' })
        .portal.newInquiryUrl,
    ).toBe('https://www.example.de/anfrage');
  });

  it('E-C5. ungültige COMPANY_PHONE_NUMBER (Buchstaben, zu kurz, zu lang, Sonderzeichen, tel:-Präfix) ⇒ ConfigError ohne den Wert zu nennen', () => {
    for (const phone of [
      'abc',
      '0613',
      '+49 6131 1234567890 1234567890 1234567890',
      'tel:+496131123456',
      '+49;6131',
      '+49 6131 <script>',
    ]) {
      const problems = problemsOf({ APP_ENV: 'development', COMPANY_PHONE_NUMBER: phone });
      expect(problems, phone).toContain('COMPANY_PHONE_NUMBER');
    }
    const problems = problemsOf({ APP_ENV: 'development', COMPANY_PHONE_NUMBER: 'GEHEIM-12' });
    expect(problems).not.toContain('GEHEIM-12');
  });
});
