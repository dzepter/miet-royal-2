import { defineConfig, devices } from '@playwright/test';

/**
 * E2E-Grundlage (PHASE_00_FOUNDATION.md, Nr. 10): startet Web-Shell und API
 * lokal und prüft die kritischen Smoke-Pfade. Fachliche E2E-Prozesse
 * (Angebot, Ausgabe, Rückgabe, …) kommen mit den jeweiligen Phasen.
 *
 * In Umgebungen mit vorinstalliertem Chromium kann CHROMIUM_PATH auf die
 * Browser-Binärdatei zeigen; sonst nutzt Playwright seine eigene Installation
 * (npx playwright install chromium).
 */
const WEB_PORT = 3100;
const API_PORT = 3101;

export default defineConfig({
  testDir: './specs',
  timeout: 60_000,
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
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
        API_PORT: String(API_PORT),
        LOG_LEVEL: 'warn',
      },
    },
  ],
});
