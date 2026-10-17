import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

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
      // Die Lexware-Spec läuft nur im Projekt `lexware` (zweite API-/Staff-Instanz).
      testIgnore: [/pwa-smoke\.spec\.ts$/, /lexware-flow\.spec\.ts$/],
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
      testMatch: /lexware-flow\.spec\.ts$/,
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
      },
    },
    {
      // Produktions-Build: nur so ist die App-Shell offline (ohne HMR) lauffähig.
      command: `pnpm --filter @mietroyal/staff exec sh -c "next build && next start --port ${STAFF_PORT}"`,
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
  ],
});
