import { resolve } from 'node:path';

/**
 * Phase 12 (E2E): gemeinsame Konstanten der lokalen Kommunikations-Fakes
 * (SMTP-Senke, Web-Push-Dienst, WhatsApp-Graph-API) – genutzt von
 * playwright.config.ts (Server-Env), dem Fake-Prozess und den Spec-Helfern.
 *
 * ALLE Werte sind synthetisches TEST-Material ohne Bezug zu echten Konten:
 * Zugangsdaten der Senke, WhatsApp-Token/App-Secret/Verify-Token und das
 * VAPID-Schlüsselpaar (einmalig mit `pnpm --filter @mietroyal/api
 * push:generate-vapid-keys` erzeugt) werden nirgends sonst verwendet und
 * dürfen nie in einer echten Umgebung landen (siehe fixtures/README.md).
 */

/** SMTP mit implizitem TLS (wie Port 465) – Zertifikat aus fixtures/tls. */
export const SMTP_SINK_PORT = 4565;
/** HTTP-Steuerung aller Fakes (Nachrichten/Requests abfragen, Fehler injizieren). */
export const FAKES_CONTROL_PORT = 4566;
/** HTTPS: Web-Push-Endpunkte (`/push/<id>`) und WhatsApp-Mediendownloads (`/whatsapp-media/<id>`). */
export const FAKES_HTTPS_PORT = 4567;
/** HTTP: Fake der WhatsApp Business Cloud API (Graph), WHATSAPP_BASE_URL in development. */
export const WHATSAPP_GRAPH_FAKE_PORT = 4568;
/** IMAP mit implizitem TLS (wie Port 993) – Inbound-Mailbox der Haupt-API. */
export const IMAP_FAKE_PORT = 4569;

export const FAKES_CONTROL_ORIGIN = `http://127.0.0.1:${FAKES_CONTROL_PORT}`;
/** Host MUSS zum Test-Zertifikat passen (SAN: DNS localhost, IP 127.0.0.1). */
export const SMTP_SINK_HOST = '127.0.0.1';
export const PUSH_FAKE_ORIGIN = `https://localhost:${FAKES_HTTPS_PORT}`;
export const WHATSAPP_GRAPH_FAKE_ORIGIN = `http://127.0.0.1:${WHATSAPP_GRAPH_FAKE_PORT}`;

/** Synthetische SMTP-Zugangsdaten (die Senke prüft sie wie ein echter Server). */
export const SMTP_SINK_USER = 'e2e-smtp-user';
export const SMTP_SINK_PASSWORD = 'e2e-smtp-passwort-nur-test';
/** Synthetische IMAP-Zugangsdaten (Mailbox INBOX der Haupt-API). */
export const IMAP_FAKE_USER = 'e2e-imap-user';
export const IMAP_FAKE_PASSWORD = 'e2e-imap-passwort-nur-test';
export const MAIL_FROM_ADDRESS = 'service@miet-royal.test';
export const MAIL_REPLY_ADDRESS = 'antwort@miet-royal.test';

/** Synthetische WhatsApp-Cloud-API-Werte (Format wie bei Meta, sonst bedeutungslos). */
export const WHATSAPP_ACCESS_TOKEN = 'e2e-fake-whatsapp-access-token';
export const WHATSAPP_PHONE_NUMBER_ID = '100000000000001';
export const WHATSAPP_BUSINESS_ACCOUNT_ID = '200000000000002';
export const WHATSAPP_APP_SECRET = 'e2e-fake-whatsapp-app-secret-0001';
export const WHATSAPP_VERIFY_TOKEN = 'e2e-fake-whatsapp-verify-token-0001';
export const WHATSAPP_GRAPH_API_VERSION = 'v25.0';

/** VAPID-Testschlüssel (P-256, base64url) – nur für die lokale E2E-API. */
export const PUSH_VAPID_PUBLIC_KEY =
  'BDGBpIIByuxSWr6Mrxkn0Hr-39lXRJ7FE9ss-tMrRHJcxYd46iGQNzCPFGzLE4XmJQyJICl4wB_R38iDLOXUM9o';
export const PUSH_VAPID_PRIVATE_KEY = 'WVnsIOaSETh8X2t2T6Elm0aKh0PU1Z7d9oUgWbVz2PY';
export const PUSH_VAPID_SUBJECT = 'mailto:e2e-push@miet-royal.test';

const TLS_DIR = resolve(import.meta.dirname, '../fixtures/tls');
/** Test-CA (für NODE_EXTRA_CA_CERTS der API-Prozesse). */
export const TEST_CA_FILE = resolve(TLS_DIR, 'ca.pem');
export const TEST_SERVER_CERT_FILE = resolve(TLS_DIR, 'server.pem');
export const TEST_SERVER_KEY_FILE = resolve(TLS_DIR, 'server-key.pem');
