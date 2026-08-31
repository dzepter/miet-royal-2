import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.ts';

export type Database = NodePgDatabase<typeof schema>;

export function createPool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // pg emittiert 'error' auf dem Pool, wenn eine IDLE-Verbindung stirbt
  // (DB-Neustart, Failover, Netzwerkabriss). Ohne Listener stürzt der
  // gesamte Prozess ab; mit Listener verwirft der Pool den Client einfach
  // und die nächste Query verbindet neu (/ready meldet solange 503).
  pool.on('error', (error) => {
    console.error(
      `[database] Verbindungsfehler einer Idle-Verbindung: ${error.message} – Pool verwirft den Client und verbindet bei Bedarf neu`,
    );
  });
  return pool;
}

export function createDb(pool: pg.Pool): Database {
  return drizzle(pool, { schema });
}

/** Leichtgewichtiger Verbindungscheck für /ready und Smoke-Tests. */
export async function pingDatabase(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1');
}
