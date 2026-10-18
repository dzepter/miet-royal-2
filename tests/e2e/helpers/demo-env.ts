import { resolve } from 'node:path';

/**
 * Phase 12 (E2E, Szenario T – Demo-Isolation): Konstanten der zusätzlichen
 * Demo-API (Projekt `demo-communication` in playwright.config.ts) – reine
 * Werte ohne Test-Importe, damit Config und Spec sie teilen.
 *
 * Die Demo-API läuft mit APP_ENV=demo gegen eine EIGENE Datenbank
 * (`mietroyal_test_demo`, frisch je Lauf: apps/api/scripts/e2e-demo-setup.ts),
 * eigenem Storage und eigenen Schlüsseln (AUTH_SECRET_KEY,
 * COMMUNICATION_PAYLOAD_KEY ≠ Haupt-API), Mail nur an die Whitelist
 * `@demo.test` (Senke wie die Haupt-API), KEIN WHATSAPP_* (Demo ⇒ Mock) und
 * ohne Web Push. Alle Werte sind synthetisches TEST-Material.
 */

export const DEMO_API_PORT = 3106;
export const DEMO_API_ORIGIN = `http://127.0.0.1:${DEMO_API_PORT}`;

const BASE_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://mietroyal:mietroyal_local_dev@localhost:55432/mietroyal_test';

/** Gleicher Server/gleiche Rolle wie die Testdatenbank, aber eigene Datenbank. */
export const DEMO_DATABASE_URL = (() => {
  const url = new URL(BASE_DATABASE_URL);
  url.pathname = '/mietroyal_test_demo';
  return url.toString();
})();

/** Eigenes Storage-Verzeichnis (tests/e2e/.storage ist per .gitignore ausgeschlossen). */
export const DEMO_STORAGE_ROOT = resolve(import.meta.dirname, '../.storage/demo-communication');

/** Eigene Schlüssel der Demo-API (≥ 32 Zeichen; nie in der Haupt-API verwendet). */
export const DEMO_AUTH_SECRET_KEY = 'e2e-demo-only-auth-secret-key-0000000000000001';
export const DEMO_COMMUNICATION_PAYLOAD_KEY = 'e2e-demo-only-communication-payload-key-00000000001';

/** Mail-Whitelist der Demo (ganze Domain). */
export const DEMO_MAIL_WHITELIST = '@demo.test';

/** Synthetischer Demo-Admin (Bootstrap im Startkommando der Demo-API). */
export const DEMO_ADMIN_EMAIL = 'dana.demo@demo.test';
export const DEMO_ADMIN_PASSWORD = 'e2e-demo-admin-passwort-1';
