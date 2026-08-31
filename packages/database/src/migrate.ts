import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client.ts';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Wendet alle noch fehlenden versionierten Migrationen aus
 * packages/database/migrations an (CLAUDE.md: "jede Schemaänderung als
 * versionierte Migration"). Idempotent – bereits angewendete Migrationen
 * werden übersprungen.
 */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
