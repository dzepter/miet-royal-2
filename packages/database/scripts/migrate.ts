/**
 * Wendet alle offenen Migrationen auf die konfigurierte Datenbank an.
 * Aufruf: pnpm db:migrate  (DATABASE_URL/APP_ENV aus der Umgebung)
 */
import { loadConfig } from '@mietroyal/config';
import { createDb, createPool } from '../src/client.ts';
import { runMigrations } from '../src/migrate.ts';

const config = loadConfig();
const pool = createPool(config.databaseUrl);

try {
  await runMigrations(createDb(pool));
  console.log(`Migrationen angewendet (APP_ENV=${config.appEnv}).`);
} finally {
  await pool.end();
}
