import { hostname } from 'node:os';
import {
  createAccountingGatewayFor,
  createLexwareContext,
  registerFinanceJobHandlers,
} from '@mietroyal/api/jobs';
import { loadConfig } from '@mietroyal/config';
import { createDb, createPool } from '@mietroyal/database';
import {
  createStorageProvider,
  JobRunner,
  PostgresJobQueue,
  SYSTEM_HEARTBEAT_JOB_TYPE,
  systemHeartbeatHandler,
} from '@mietroyal/integrations';
import { pino } from 'pino';

const config = loadConfig();
// Phase 10: dieselbe Redaction wie die API – der Lexware-Key landet unter keinem Pfad im Log.
const logger = pino({
  level: config.logLevel,
  redact: {
    paths: ['apiKey', '*.apiKey', '*.*.apiKey', 'config.lexware.apiKey', '*.config.lexware.apiKey'],
    censor: '[REDACTED]',
  },
});
const pool = createPool(config.databaseUrl);
const queue = new PostgresJobQueue(pool);
const workerId = `${hostname()}:${process.pid}`;

const runner = new JobRunner(queue, workerId, logger);
runner.register(SYSTEM_HEARTBEAT_JOB_TYPE, systemHeartbeatHandler);
// Phase 9: Buchhaltungs-Transferjobs (Abrechnung/Storno) – dieselben Handler
// wie die Mock-Steuerung der API; in production bleibt das Gateway „disabled“
// und jeder Transfer wird sauber als nicht konfiguriert abgewiesen.
const db = createDb(pool);
const lexware = createLexwareContext(config, db, logger);
registerFinanceJobHandlers(runner, {
  db,
  config,
  queue,
  storage: createStorageProvider(config.storage),
  accountingGateway: createAccountingGatewayFor(config, lexware),
  lexware,
  logger,
});

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
