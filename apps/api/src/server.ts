import { loadConfig } from '@mietroyal/config';
import { createPool } from '@mietroyal/database';
import { buildApp } from './app.ts';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = buildApp({ config, pool });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Fahre API herunter');
  await app.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.api.host, port: config.api.port });
} catch (error) {
  app.log.error({ err: error }, 'API-Start fehlgeschlagen');
  await pool.end();
  process.exit(1);
}
