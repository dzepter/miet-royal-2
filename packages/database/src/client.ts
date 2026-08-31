import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.ts';

export type Database = NodePgDatabase<typeof schema>;

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export function createDb(pool: pg.Pool): Database {
  return drizzle(pool, { schema });
}

/** Leichtgewichtiger Verbindungscheck für /ready und Smoke-Tests. */
export async function pingDatabase(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1');
}
