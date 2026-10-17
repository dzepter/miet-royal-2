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
 * - Alle drei Server werden IMMER frisch gestartet (`reuseExistingServer:
 *   false`): ein liegengebliebener Server würde sonst unbemerkt alten Code
 *   testen. Die API-Ausgabe wird ins Testprotokoll geleitet (Diagnose von
 *   Sync-Fehlern).
 *
 * In Umgebungen mit vorinstalliertem Chromium kann CHROMIUM_PATH auf die
 * Browser-Binärdatei zeigen; sonst nutzt Playwright seine eigene Installation
 * (npx playwright install chromium).
 */
const WEB_PORT = 3100;
const API_PORT = 3101;
const STAFF_PORT = 3102;

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://mietroyal:mietroyal_local_dev@localhost:55432/mietroyal_test';

/** WebKit-Smoke (Order §94) – nur abschaltbar, wenn WebKit technisch nicht verfügbar ist. */
const WEBKIT_ENABLED = process.env.E2E_WEBKIT !== '0';

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
        ...(process.env.CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
          : {}),
      },
      // Der WebKit-Smoke ist iPhone/iPad-spezifisch; Chromium deckt ihn über offline-flow ab.
      testIgnore: /pwa-smoke\.spec\.ts$/,
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
  ],
});
