import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import {
  FAKES_CONTROL_PORT,
  IMAP_FAKE_PASSWORD,
  IMAP_FAKE_PORT,
  IMAP_FAKE_USER,
  MAIL_FROM_ADDRESS,
  MAIL_REPLY_ADDRESS,
  PUSH_VAPID_PRIVATE_KEY,
  PUSH_VAPID_PUBLIC_KEY,
  PUSH_VAPID_SUBJECT,
  SMTP_SINK_HOST,
  SMTP_SINK_PASSWORD,
  SMTP_SINK_PORT,
  SMTP_SINK_USER,
  TEST_CA_FILE,
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_APP_SECRET,
  WHATSAPP_BUSINESS_ACCOUNT_ID,
  WHATSAPP_GRAPH_API_VERSION,
  WHATSAPP_GRAPH_FAKE_ORIGIN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
} from './fakes/constants.ts';
// Phase 12 (E2E-Agent 2): Demo-API für Szenario T (Projekt `demo-communication`).
import {
  DEMO_ADMIN_EMAIL,
  DEMO_ADMIN_PASSWORD,
  DEMO_API_PORT,
  DEMO_AUTH_SECRET_KEY,
  DEMO_COMMUNICATION_PAYLOAD_KEY,
  DEMO_DATABASE_URL,
  DEMO_MAIL_WHITELIST,
  DEMO_STORAGE_ROOT,
} from './helpers/demo-env.ts';

/**
 * E2E-Smokes und Fachszenarien: Web-Shell, API und Staff-App (Login →
 * Mitarbeiterverwaltung → Rechte → Sperren → Fachprozesse → Offline/PWA).
 * Die API läuft gegen die TESTdatenbank; global-setup.ts legt einen
 * synthetischen Bootstrap-Admin an.
 *
 * Phase 8 (Offline/PWA):
 * - Die Staff-App läuft als PRODUKTIONS-Build (`next build && next start`),
 *   weil der Turbopack-Dev-Server ohne HMR-Verbindung offline nicht
 *   hydratisiert – ein Dev-Server kann die Offline-App-Shell nicht abbilden.
 * - Chromium bleibt Pflicht (alle Specs); der WebKit-Smoke (`pwa-smoke.spec.ts`,
 *   Order §94) läuft als eigenes Projekt und lässt sich mit `E2E_WEBKIT=0`
 *   abschalten, wenn WebKit in der Umgebung nicht installierbar ist.
 * - Alle Server werden IMMER frisch gestartet (`reuseExistingServer:
 *   false`): ein liegengebliebener Server würde sonst unbemerkt alten Code
 *   testen. Die API-Ausgabe wird ins Testprotokoll geleitet (Diagnose von
 *   Sync-Fehlern).
 *
 * Phase 10 (Lexware Office, nur gegen den lokalen Contract-Fake):
 * - Das Standardprojekt `chromium` bleibt unverändert auf dem MOCK-Provider
 *   (Phase-1–9-Specs erwarten `mock-badge`/„MOCK-RE-…“).
 * - Die Lexware-Spec (`lexware-flow.spec.ts`, Szenarien A–N) läuft als eigenes
 *   Projekt `lexware` gegen eine ZWEITE API-Instanz (Port 3104, Lexware-Env,
 *   gleiche Testdatenbank) und eine zweite Staff-Instanz (Port 3105). Die
 *   Staff-App bäckt `STAFF_API_ORIGIN` zur Build-Zeit in die Rewrites ein
 *   (routes-manifest), ein zweiter `next start` desselben Builds könnte also
 *   nicht auf die Lexware-API zeigen. Daher läuft die zweite Staff-Instanz als
 *   `next dev` (Next 16 schreibt Dev-Ausgaben isoliert nach `.next/dev` – der
 *   Produktionsbuild bleibt unberührt); Offline/PWA ist für die Lexware-Spec
 *   irrelevant. Die Web-Shell (3100 → API 3101) wird mitgenutzt: Angebots-
 *   Annahmen schreiben nur in die gemeinsame Datenbank.
 * - Der Lexware-Fake (Port 4555) startet VOR beiden APIs mit festem
 *   Schlüsselpaar aus `fixtures/` (reines Fake-Material, kein Secret) und
 *   ohne Rate-Limit-Simulation; der Public Key wird der Lexware-API als
 *   `LEXWARE_WEBHOOK_PUBLIC_KEY_PEM` übergeben (Webhook-Signaturprüfung).
 *
 * Phase 12 (Kommunikation, nur gegen lokale Fakes – nie echte Provider):
 * - `fakes/communication-fakes.ts` startet VOR den APIs: SMTP-Senke mit
 *   implizitem TLS (Port 4565, Test-Zertifikat aus `fixtures/tls`), HTTP-
 *   Steuerung (4566), HTTPS-Web-Push-Dienst + WhatsApp-Mediendownload (4567),
 *   WhatsApp-Graph-API-Fake (4568) und IMAP-Mailbox mit implizitem TLS (4569).
 * - BEIDE APIs versenden Mails über den ECHTEN SmtpMailGateway (Nodemailer,
 *   `rejectUnauthorized: true`) an die Senke; die Test-CA kommt ausschließlich
 *   über `NODE_EXTRA_CA_CERTS` in den API-Prozess (kein Abschalten der
 *   Zertifikatsprüfung). Damit gilt in allen Projekten das Phase-12-Soll:
 *   AB/Schaden-Vorinfo/Gutschein/Rechnung werden nach dem Job `mail.send`
 *   (runDueJobs) tatsächlich zugestellt.
 * - Nur die Haupt-API (Projekt `chromium`) bekommt zusätzlich IMAP-Eingang
 *   (gegen den IMAP-Fake), WhatsApp (Cloud-API-Gateway gegen den Graph-Fake,
 *   http in development erlaubt) und Web Push (feste VAPID-TESTschlüssel aus
 *   `fakes/constants.ts`); die Lexware-API bleibt dort beim Default (kein
 *   IMAP, WhatsApp `mock`, Push aus).
 * - Szenarien G–S (communication-ops.spec.ts) laufen im Projekt `chromium`;
 *   Szenario T (communication-demo.spec.ts) im Projekt `demo-communication`
 *   gegen eine DRITTE API-Instanz mit APP_ENV=demo (Port 3106, eigene
 *   Datenbank `mietroyal_test_demo`, eigenes Storage, eigene Schlüssel, Mail
 *   nur an `@demo.test`, kein WhatsApp-Live-Zugang, kein Push) – reine
 *   API-Tests ohne eigene Staff-Instanz (helpers/demo-env.ts).
 *
 * In Umgebungen mit vorinstalliertem Chromium kann CHROMIUM_PATH auf die
 * Browser-Binärdatei zeigen; sonst nutzt Playwright seine eigene Installation
 * (npx playwright install chromium).
 */
const WEB_PORT = 3100;
const API_PORT = 3101;
const STAFF_PORT = 3102;
/** Phase 10: zweite API-/Staff-Instanz mit Lexware-Provider (Fake) – nur Projekt `lexware`. */
const LEXWARE_API_PORT = 3104;
const LEXWARE_STAFF_PORT = 3105;
const LEXWARE_FAKE_PORT = 4555;
/** Feste Fake-Organisation (identisch für Fake und API – organizationId-Pinning). */
const LEXWARE_ORGANIZATION_ID = 'e2e-org-00000000-0000-4000-8000-000000000001';
const LEXWARE_FAKE_API_KEY = 'e2e-fake-lexware-key';
const LEXWARE_FAKE_PRIVATE_KEY_FILE = resolve(
  import.meta.dirname,
  'fixtures/lexware-fake-private-key.pem',
);
const LEXWARE_FAKE_PUBLIC_KEY_PEM = readFileSync(
  resolve(import.meta.dirname, 'fixtures/lexware-fake-public-key.pem'),
  'utf8',
);

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://mietroyal:mietroyal_local_dev@localhost:55432/mietroyal_test';

/** WebKit-Smoke (Order §94) – nur abschaltbar, wenn WebKit technisch nicht verfügbar ist. */
const WEBKIT_ENABLED = process.env.E2E_WEBKIT !== '0';

/**
 * Phase 12: Mailversand beider E2E-APIs an die lokale SMTP-Senke (echter
 * SmtpMailGateway). Synthetische Zugangsdaten; Links in Mails zeigen auf die
 * Web-Shell (gleiche Origin wie helpers/seed.ts WEB_ORIGIN).
 */
const MAIL_E2E_ENV = {
  MAIL_ENABLED: 'true',
  MAIL_SMTP_HOST: SMTP_SINK_HOST,
  MAIL_SMTP_PORT: String(SMTP_SINK_PORT),
  MAIL_SMTP_SECURE: 'true',
  MAIL_SMTP_USER: SMTP_SINK_USER,
  MAIL_SMTP_PASSWORD: SMTP_SINK_PASSWORD,
  MAIL_FROM_ADDRESS,
  MAIL_REPLY_ADDRESS,
  MAIL_PUBLIC_WEB_BASE_URL: `http://127.0.0.1:${WEB_PORT}`,
  // Nur die Test-CA der Fakes – ersetzt (nur im API-Prozess) eine geerbte Proxy-CA.
  NODE_EXTRA_CA_CERTS: TEST_CA_FILE,
};

/**
 * Phase 12: nur Haupt-API – IMAP-Eingang gegen den IMAP-Fake (implizites TLS, Test-CA),
 * WhatsApp Cloud API gegen den Graph-Fake, Web Push mit VAPID-Testschlüsseln.
 * Der IMAP-Poll läuft nur, wenn eine Spec einen Job `mail.inbound_poll` einreiht
 * (helpers/jobs.ts) – ohne Worker pollt die E2E-API nie von selbst.
 */
const WHATSAPP_PUSH_E2E_ENV = {
  MAIL_IMAP_ENABLED: 'true',
  MAIL_IMAP_HOST: SMTP_SINK_HOST,
  MAIL_IMAP_PORT: String(IMAP_FAKE_PORT),
  MAIL_IMAP_SECURE: 'true',
  MAIL_IMAP_USER: IMAP_FAKE_USER,
  MAIL_IMAP_PASSWORD: IMAP_FAKE_PASSWORD,
  MAIL_IMAP_FOLDER: 'INBOX',
  WHATSAPP_ENABLED: 'true',
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_BUSINESS_ACCOUNT_ID,
  WHATSAPP_APP_SECRET,
  WHATSAPP_VERIFY_TOKEN,
  WHATSAPP_GRAPH_API_VERSION,
  WHATSAPP_BASE_URL: WHATSAPP_GRAPH_FAKE_ORIGIN,
  PUSH_VAPID_PUBLIC_KEY,
  PUSH_VAPID_PRIVATE_KEY,
  PUSH_VAPID_SUBJECT,
};

const chromiumLaunch = process.env.CHROMIUM_PATH
  ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
  : {};

export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.ts',
  timeout: 90_000,
  fullyParallel: false,
  // Alle Specs teilen sich EINE Testdatenbank und laufen strikt nacheinander;
  // jede Spec setzt die Datenbank zu Beginn auf den Basis-Seed zurück
  // (helpers/seed.ts) und ist damit unabhängig von der Dateireihenfolge.
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${STAFF_PORT}`,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...chromiumLaunch,
      },
      // Der WebKit-Smoke ist iPhone/iPad-spezifisch; Chromium deckt ihn über offline-flow ab.
      // Die Lexware-Specs laufen nur im Projekt `lexware` (zweite API-/Staff-Instanz);
      // Phase 11: voucher-lexware.spec.ts (Szenario K – Zahlungs-Webhook ⇒ Gutschein).
      // Phase 12: communication-lexware.spec.ts (Szenario F – Rechnungsmail aus Lexware).
      testIgnore: [
        /pwa-smoke\.spec\.ts$/,
        /lexware-flow\.spec\.ts$/,
        /voucher-lexware\.spec\.ts$/,
        /communication-lexware\.spec\.ts$/,
        // Phase 12 (E2E-Agent 2): Szenario T läuft nur gegen die Demo-API.
        /communication-demo\.spec\.ts$/,
      ],
    },
    ...(WEBKIT_ENABLED
      ? [
          {
            name: 'webkit',
            use: { ...devices['Desktop Safari'] },
            testMatch: /pwa-smoke\.spec\.ts$/,
          },
        ]
      : []),
    {
      name: 'lexware',
      use: {
        ...devices['Desktop Chrome'],
        ...chromiumLaunch,
        baseURL: `http://127.0.0.1:${LEXWARE_STAFF_PORT}`,
      },
      testMatch: /(lexware-flow|voucher-lexware|communication-lexware)\.spec\.ts$/,
    },
    {
      // Phase 12 (E2E-Agent 2): Szenario T – reine API-Tests gegen die Demo-API (APP_ENV=demo).
      name: 'demo-communication',
      use: { ...devices['Desktop Chrome'], ...chromiumLaunch },
      testMatch: /communication-demo\.spec\.ts$/,
    },
  ],
  webServer: [
    {
      command: `pnpm --filter @mietroyal/web exec next dev --port ${WEB_PORT}`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      // Immer frische Server: ein liegengebliebener Server würde sonst alten Code testen.
      reuseExistingServer: false,
      timeout: 120_000,
      cwd: '../..',
    },
    {
      // Phase 12: Kommunikations-Fakes (SMTP-Senke, Push, WhatsApp-Graph) – VOR den APIs.
      command: 'pnpm --filter @mietroyal/api exec tsx ../../tests/e2e/fakes/communication-fakes.ts',
      url: `http://127.0.0.1:${FAKES_CONTROL_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      cwd: '../..',
    },
    {
      // Phase 10: Lexware-Contract-Fake – VOR den APIs (festes Fake-Schlüsselpaar, kein Rate-Limit).
      command: 'pnpm --filter @mietroyal/api exec tsx scripts/lexware-fake-server.ts',
      url: `http://127.0.0.1:${LEXWARE_FAKE_PORT}/__control/public-key`,
      reuseExistingServer: false,
      timeout: 60_000,
      cwd: '../..',
      env: {
        LEXWARE_FAKE_PORT: String(LEXWARE_FAKE_PORT),
        LEXWARE_FAKE_ORGANIZATION_ID: LEXWARE_ORGANIZATION_ID,
        LEXWARE_FAKE_API_KEY,
        LEXWARE_FAKE_RATE_LIMIT: '0',
        LEXWARE_FAKE_PRIVATE_KEY_FILE,
      },
    },
    {
      command: 'pnpm --filter @mietroyal/api start',
      url: `http://127.0.0.1:${API_PORT}/health`,
      // Immer frische Server: ein liegengebliebener Server würde sonst alten Code testen.
      reuseExistingServer: false,
      timeout: 60_000,
      cwd: '../..',
      // Warn-/Fehlerzeilen der API im Testprotokoll (Diagnose von Sync-Fehlern).
      stdout: 'pipe',
      env: {
        APP_ENV: 'development',
        DATABASE_URL: TEST_DATABASE_URL,
        API_PORT: String(API_PORT),
        LOG_LEVEL: 'warn',
        // Phase 12: Mail (SMTP-Senke + IMAP-Fake), WhatsApp (Graph-Fake), Web Push (VAPID-Test).
        ...MAIL_E2E_ENV,
        ...WHATSAPP_PUSH_E2E_ENV,
      },
    },
    {
      // Produktions-Build: nur so ist die App-Shell offline (ohne HMR) lauffähig.
      // Keep-Alive länger als die Pausen zwischen Testschritten: sonst schließt der
      // Node-Server (Default 5 s) einen Leerlauf-Socket genau dann, wenn der
      // Request-Client ihn wiederverwendet ⇒ sporadisches ECONNRESET.
      command: `pnpm --filter @mietroyal/staff exec sh -c "next build && next start --port ${STAFF_PORT} --keepAliveTimeout 70000"`,
      url: `http://127.0.0.1:${STAFF_PORT}/login`,
      // Immer frische Server: ein liegengebliebener Server würde sonst alten Code testen.
      reuseExistingServer: false,
      timeout: 360_000,
      cwd: '../..',
      env: {
        STAFF_API_ORIGIN: `http://127.0.0.1:${API_PORT}`,
      },
    },
    {
      // Phase 10: zweite API-Instanz mit Lexware-Provider gegen den Fake (gleiche Testdatenbank).
      command: 'pnpm --filter @mietroyal/api start',
      url: `http://127.0.0.1:${LEXWARE_API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      cwd: '../..',
      stdout: 'pipe',
      env: {
        APP_ENV: 'development',
        DATABASE_URL: TEST_DATABASE_URL,
        API_PORT: String(LEXWARE_API_PORT),
        LOG_LEVEL: 'warn',
        LEXWARE_ENABLED: 'true',
        LEXWARE_API_KEY: LEXWARE_FAKE_API_KEY,
        LEXWARE_BASE_URL: `http://127.0.0.1:${LEXWARE_FAKE_PORT}`,
        LEXWARE_ORGANIZATION_ID,
        LEXWARE_WEBHOOK_CALLBACK_URL: 'https://e2e.example/webhooks/lexware',
        LEXWARE_WEBHOOK_PUBLIC_KEY_PEM: LEXWARE_FAKE_PUBLIC_KEY_PEM,
        // Kurzer Timeout: Szenario H (Timeout NACH dem Create) wartet nicht 15 s.
        LEXWARE_REQUEST_TIMEOUT_MS: '5000',
        // Phase 12: Rechnungs-/Gutscheinmails an die SMTP-Senke (wie die Haupt-API).
        ...MAIL_E2E_ENV,
      },
    },
    {
      // Phase 10: zweite Staff-Instanz (Dev-Server, siehe Kopfkommentar) gegen die Lexware-API.
      command: `pnpm --filter @mietroyal/staff exec next dev --port ${LEXWARE_STAFF_PORT}`,
      url: `http://127.0.0.1:${LEXWARE_STAFF_PORT}/login`,
      reuseExistingServer: false,
      timeout: 180_000,
      cwd: '../..',
      env: {
        STAFF_API_ORIGIN: `http://127.0.0.1:${LEXWARE_API_PORT}`,
      },
    },
    {
      // Phase 12 (E2E-Agent 2): Demo-API (Szenario T, Order §39) – APP_ENV=demo, EIGENE
      // Datenbank (frisch je Lauf: scripts/e2e-demo-setup.ts, inkl. Demo-Admin), eigenes
      // Storage, eigene Schlüssel; Mail an die Senke NUR für die Whitelist (+ „[DEMO]“),
      // KEIN WHATSAPP_* (Demo ⇒ Mock), kein Web Push. Kein Staff-Build (nur API-Tests).
      command:
        'pnpm --filter @mietroyal/api exec sh -c "tsx scripts/e2e-demo-setup.ts && tsx src/server.ts"',
      url: `http://127.0.0.1:${DEMO_API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      cwd: '../..',
      stdout: 'pipe',
      env: {
        ...MAIL_E2E_ENV,
        APP_ENV: 'demo',
        DATABASE_URL: DEMO_DATABASE_URL,
        API_PORT: String(DEMO_API_PORT),
        LOG_LEVEL: 'warn',
        STORAGE_DRIVER: 'fs',
        STORAGE_FS_ROOT: DEMO_STORAGE_ROOT,
        AUTH_SECRET_KEY: DEMO_AUTH_SECRET_KEY,
        COMMUNICATION_PAYLOAD_KEY: DEMO_COMMUNICATION_PAYLOAD_KEY,
        MAIL_DEMO_WHITELIST: DEMO_MAIL_WHITELIST,
        E2E_DEMO_ADMIN_EMAIL: DEMO_ADMIN_EMAIL,
        E2E_DEMO_ADMIN_PASSWORD: DEMO_ADMIN_PASSWORD,
      },
    },
  ],
});
