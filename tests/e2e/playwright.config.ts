import { defineConfig, devices } from '@playwright/test';

/**
 * E2E-Smokes: Web-Shell, API und Staff-App (Login → Mitarbeiterverwaltung →
 * Rechte → Sperren). Die API läuft gegen die TESTdatenbank; global-setup.ts
 * legt einen synthetischen Bootstrap-Admin an.
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

export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.ts',
  timeout: 90_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${STAFF_PORT}`,
    ...(process.env.CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
      : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `pnpm --filter @mietroyal/web exec next dev --port ${WEB_PORT}`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      cwd: '../..',
    },
    {
      command: 'pnpm --filter @mietroyal/api start',
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      cwd: '../..',
      env: {
        APP_ENV: 'development',
        DATABASE_URL: TEST_DATABASE_URL,
        API_PORT: String(API_PORT),
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: `pnpm --filter @mietroyal/staff exec next dev --port ${STAFF_PORT}`,
      url: `http://127.0.0.1:${STAFF_PORT}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      cwd: '../..',
      env: {
        STAFF_API_ORIGIN: `http://127.0.0.1:${API_PORT}`,
      },
    },
  ],
});
