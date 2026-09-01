import { execSync } from 'node:child_process';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://mietroyal:mietroyal_local_dev@localhost:55432/mietroyal_test';

export default function globalSetup(): void {
  execSync('pnpm --filter @mietroyal/api exec tsx scripts/e2e-seed.ts', {
    cwd: `${import.meta.dirname}/../..`,
    stdio: 'inherit',
    env: {
      ...process.env,
      APP_ENV: 'development',
      DATABASE_URL: TEST_DATABASE_URL,
      LOG_LEVEL: 'warn',
    },
  });
}
