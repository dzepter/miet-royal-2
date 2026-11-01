import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Phase 14 (E2E, Szenarien L–N – training-gates.spec.ts): Konstanten der
 * zusätzlichen PRODUCTION-API des Projekts `production-gates`
 * (playwright.config.ts) – reine Werte ohne Test-Importe, damit Config, Setup-
 * Skript und Spec sie teilen.
 *
 * Die Production-API läuft mit APP_ENV=production gegen eine EIGENE Datenbank
 * (`mietroyal_test_prod`, frisch je Lauf: apps/api/scripts/e2e-prod-setup.ts),
 * fs-Storage in einem Temp-Verzeichnis, eigenen zufälligen 64-Hex-Schlüsseln
 * (je Lauf neu erzeugt – nur die Config kennt sie, die Spec braucht sie nicht),
 * OHNE Lexware/WhatsApp/Routing (Gateways `disabled`; Fake-/Mock-Gateways
 * werden in production beim Start abgelehnt). Mail: production versendet
 * Angebote nur mit konfiguriertem SMTP-Weg (OfferDeliveryGateway.assertConfigured,
 * fail-closed) – die Production-API bekommt daher ein SMTP-Ziel unter der
 * reservierten Domain `.invalid`, das NIE angesprochen wird: der Versandjob
 * `mail.send` läuft in diesem Projekt nicht (kein Worker; die Mock-Jobsteuerung
 * existiert in production nicht), Outbox-Zeilen bleiben `pending`. Nur dort
 * werden die Live-Trainingssperren erzwungen (Order §63). Alle Werte sind
 * synthetisches TEST-Material.
 */

export const PROD_API_PORT = 3110;
export const PROD_API_ORIGIN = `http://127.0.0.1:${PROD_API_PORT}`;
export const PROD_STAFF_PORT = 3111;
export const PROD_STAFF_ORIGIN = `http://127.0.0.1:${PROD_STAFF_PORT}`;
/** Eigenes Build-Verzeichnis der Production-Staff-Instanz (Muster Demo-Staff `.next/demo`). */
export const PROD_STAFF_DIST_DIR = '.next/prod';

export const PROD_DATABASE_NAME = 'mietroyal_test_prod';

const BASE_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://mietroyal:mietroyal_local_dev@localhost:55432/mietroyal_test';

/** Gleicher Server/gleiche Rolle wie die Testdatenbank, aber eigene Datenbank. */
export const PROD_DATABASE_URL = (() => {
  const url = new URL(BASE_DATABASE_URL);
  url.pathname = `/${PROD_DATABASE_NAME}`;
  return url.toString();
})();

/** fs-Storage in einem Temp-Verzeichnis (wird vom Setup-Skript je Lauf geleert). */
export const PROD_STORAGE_ROOT = join(tmpdir(), 'mietroyal-e2e-production-gates');

/**
 * SMTP-Platzhalter der Production-API (nie aufgelöst, nie verbunden – siehe
 * Kopfkommentar); production verlangt TLS, keine localhost-Adresse und eine
 * HTTPS-Basis-URL für Links in Kundenmails.
 */
export const PROD_MAIL_ENV = {
  MAIL_ENABLED: 'true',
  MAIL_SMTP_HOST: 'smtp.e2e.invalid',
  MAIL_SMTP_PORT: '465',
  MAIL_SMTP_SECURE: 'true',
  MAIL_SMTP_USER: 'e2e-prod-smtp-user',
  MAIL_SMTP_PASSWORD: 'e2e-prod-smtp-passwort-nur-test',
  MAIL_FROM_ADDRESS: 'service@live.test',
  MAIL_REPLY_ADDRESS: 'antwort@live.test',
  MAIL_PUBLIC_WEB_BASE_URL: 'https://web.live.test',
} as const;

/** Zufälliger 64-Hex-Schlüssel (32 Byte) – je Config-Ladevorgang neu, nie persistiert. */
export function randomHexKey(): string {
  return randomBytes(32).toString('hex');
}

/** Synthetischer Live-Admin (Bootstrap im Startkommando der Production-API; `training.manage` automatisch). */
export const PROD_ADMIN_EMAIL = 'admin.live@live.test';
export const PROD_ADMIN_PASSWORD = 'e2e-live-admin-passwort-1';
export const PROD_ADMIN_FIRST_NAME = 'Lars';

/** Synthetische Mitarbeiterin mit Rolle „E2E-Live“ (Angebot bearbeiten/versenden, keine Verwaltung). */
export const PROD_STAFF_EMAIL = 'mia.live@live.test';
export const PROD_STAFF_PASSWORD = 'e2e-live-mia-passwort-1';
export const PROD_STAFF_FIRST_NAME = 'Mia';
export const PROD_STAFF_ROLE_NAME = 'E2E-Live';
