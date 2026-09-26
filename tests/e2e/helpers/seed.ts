import { execSync } from 'node:child_process';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://mietroyal:mietroyal_local_dev@localhost:55432/mietroyal_test';

export const ADMIN_EMAIL = 'admin@e2e.example';
export const ADMIN_PASSWORD = 'e2e-admin-passwort-1';
export const SELLER_EMAIL = 'verkauf@e2e.example';
export const SELLER_PASSWORD = 'e2e-verkauf-passwort-1';
export const WEB_ORIGIN = 'http://127.0.0.1:3100';

/**
 * Testdatenbank auf den unveränderlichen Basis-Seed zurücksetzen
 * (Phase-6-Finalisierung A3): Migrationen, leere Fach-/Auth-Tabellen,
 * Seed-Produkte/-Preise/-Maschinen, Admin + Verkauf. Jede Spec ruft dies
 * zu Beginn ihres `beforeAll` auf und ist damit unabhängig von der
 * Dateireihenfolge und von Mutationen anderer Specs – der Seed ist
 * synchron, damit keine Spec auf halb zurückgesetzten Daten startet.
 */
export function resetE2eDatabase(): void {
  execSync('pnpm --filter @mietroyal/api exec tsx scripts/e2e-seed.ts', {
    cwd: `${import.meta.dirname}/../../..`,
    stdio: 'pipe',
    env: {
      ...process.env,
      APP_ENV: 'development',
      DATABASE_URL: TEST_DATABASE_URL,
      LOG_LEVEL: 'warn',
    },
  });
}

/**
 * Reinigungsbeginn einer Maschine (nach Rückgabe) um `hours` Stunden
 * zurücksetzen – macht die rein zeitabhängige 24-h-Warnung (Order §53)
 * im E2E deterministisch prüfbar.
 */
export function backdateCleaning(machineCode: string, hours: number): void {
  execSync('pnpm --filter @mietroyal/api exec tsx scripts/e2e-backdate-cleaning.ts', {
    cwd: `${import.meta.dirname}/../../..`,
    stdio: 'pipe',
    env: {
      ...process.env,
      APP_ENV: 'development',
      DATABASE_URL: TEST_DATABASE_URL,
      LOG_LEVEL: 'warn',
      MACHINE_CODE: machineCode,
      HOURS: String(hours),
    },
  });
}
