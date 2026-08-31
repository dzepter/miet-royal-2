import { hostname } from 'node:os';
import { loadConfig } from '@mietroyal/config';
import { createPool } from '@mietroyal/database';
import {
  JobRunner,
  PostgresJobQueue,
  SYSTEM_HEARTBEAT_JOB_TYPE,
  systemHeartbeatHandler,
} from '@mietroyal/integrations';
import { pino } from 'pino';

const config = loadConfig();
const logger = pino({ level: config.logLevel });
const pool = createPool(config.databaseUrl);
const queue = new PostgresJobQueue(pool);
const workerId = `${hostname()}:${process.pid}`;

const runner = new JobRunner(queue, workerId, logger);
runner.register(SYSTEM_HEARTBEAT_JOB_TYPE, systemHeartbeatHandler);

// Harmloser System-Job beim Start: beweist enqueue → process in jeder
// Umgebung. Der Idempotency-Key dedupliziert pro Stunde, Neustarts erzeugen
// also keine Jobflut.
const hourBucket = new Date().toISOString().slice(0, 13);
await queue.enqueue(
  SYSTEM_HEARTBEAT_JOB_TYPE,
  { source: 'worker-boot' },
  { idempotencyKey: `${SYSTEM_HEARTBEAT_JOB_TYPE}:${hourBucket}` },
);

runner.start(config.worker.pollIntervalMs);
logger.info(
  { workerId, appEnv: config.appEnv, pollIntervalMs: config.worker.pollIntervalMs },
  'Worker gestartet',
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Fahre Worker herunter');
  await runner.stop();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
