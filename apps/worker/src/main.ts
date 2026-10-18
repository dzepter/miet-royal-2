import { hostname } from 'node:os';
import {
  createAccountingGatewayFor,
  createAccountingTransferService,
  createLexwareContext,
  createVoucherTriggers,
  registerFinanceJobHandlers,
} from '@mietroyal/api/jobs';
// Phase 12 (transactional)
import {
  createTransactionalMailModule,
  registerTransactionalJobHandlers,
} from '@mietroyal/api/jobs/communication-transactional';
// Phase 12 (mail)
import {
  COMMUNICATION_LOG_REDACT_PATHS,
  createCommunicationContext,
  registerCommunicationJobHandlers,
} from '@mietroyal/api/jobs/communication';
// Phase 12 (push)
import {
  createMailAdapter,
  createPushModule,
  registerPushJobHandlers,
  StaffAuthService,
} from '@mietroyal/api/jobs/communication-push';
// Phase 12 (scan)
import {
  enqueueScanDue,
  registerScanDueJobHandlers,
  startChainWatchdog,
} from '@mietroyal/api/jobs/communication-scan';
import {
  enqueuePendingInvoiceDeliveries,
  enqueuePendingVoucherDeliveries,
} from '@mietroyal/api/jobs/communication-transactional';
// Phase 12 (inbound)
import {
  createConversationDeliveryListeners,
  createInboundMailSource,
  createWhatsAppGateway,
  enqueueInboundPoll,
  registerInboundJobHandlers,
} from '@mietroyal/api/jobs/communication-inbound';
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
    paths: [
      'apiKey',
      '*.apiKey',
      '*.*.apiKey',
      'config.lexware.apiKey',
      '*.config.lexware.apiKey',
      // Phase 12 (mail): Kommunikations-Geheimnisse unter keinem Pfad im Log.
      ...COMMUNICATION_LOG_REDACT_PATHS,
    ],
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
// Phase 11: Zahlungsstatus „bezahlt“ (Webhook/Reconcile im Worker) ⇒ Gutschein-Prüfjob.
const voucherTriggers = createVoucherTriggers({ db, queue, logger });
const storage = createStorageProvider(config.storage);
registerFinanceJobHandlers(runner, {
  db,
  config,
  queue,
  storage,
  accountingGateway: createAccountingGatewayFor(config, lexware),
  lexware,
  logger,
  paymentStatusListeners: [voucherTriggers.paymentStatusListener],
});
// Phase 12 (mail): Outbox-Versand (mail.send) – Gateway je Umgebung (SMTP oder
// deaktiviert; nie Fake), Listener/Rechnungsabruf registrieren die Fachmodule.
const communication = createCommunicationContext(config, db, queue, { storage, logger });
registerCommunicationJobHandlers(runner, { communication });
// Phase 12 (transactional): Sent-/Failed-Listener der Fachmodule (AB, Pakete,
// Kundeninformation, Storno, Gutschein, Rechnung), transienter Rechnungsabruf
// sowie die Jobs voucher.delivery / invoice.delivery.
const accountingGateway = createAccountingGatewayFor(config, lexware);
createTransactionalMailModule({
  communication,
  db,
  config,
  queue,
  lexware,
  transfers: createAccountingTransferService({
    db,
    queue,
    accountingGateway,
    lexware,
    workerId,
    logger,
    paymentStatusListeners: [voucherTriggers.paymentStatusListener],
  }),
  logger,
});
registerTransactionalJobHandlers(runner, { communication, db, config, logger });
// Phase 12 (push): push.send im Worker; Rechteauflösung für Admin-Pushes über
// den Auth-Service (keine Session-Hooks im Worker). Gateway: WebPush/Disabled.
const pushModule = createPushModule(
  { db, config, queue, logger },
  new StaffAuthService(db, config, createMailAdapter(config)),
);
registerPushJobHandlers(runner, {
  db,
  subscriptions: pushModule.subscriptions,
  gateway: pushModule.gateway,
  logger,
});
// Phase 12 (inbound): IMAP-Poller (mail.inbound_poll, selbst-re-enqueue alle
// 2 min), WhatsApp-Versand/Medien; Zustellstatus in die Konversation spiegeln.
const inboundMailSource = createInboundMailSource(config);
const whatsappGateway = createWhatsAppGateway(config);
registerInboundJobHandlers(runner, {
  db,
  config,
  queue,
  storage,
  inboundMailSource,
  whatsappGateway,
  logger,
});
const conversationListeners = createConversationDeliveryListeners(db, storage);
communication.addMailSentListener(conversationListeners.sent);
communication.addMailFailedListener(conversationListeners.failed);
await enqueueInboundPoll(queue, inboundMailSource);
// Phase 12 (scan): zentraler Scan alle 2 min (Erinnerungen, Push-Regeln,
// Outbox-/Retention-Backstop) – Boot-Enqueue mit Zeit-Bucket-Schlüssel,
// danach Self-Re-Enqueue je Lauf. cleanup_retention läuft im selben Runner.
registerScanDueJobHandlers(runner, {
  db,
  config,
  queue,
  storage,
  communication,
  scanners: [
    { name: 'push_rules', scanDue: (now) => pushModule.rules.scanDue(now) },
    {
      name: 'voucher_sweep',
      scanDue: (now) => enqueuePendingVoucherDeliveries({ db, queue, now, config }),
    },
    // Rechnungs-Sweep (Phase 12 §16): vor der Mailkonfiguration entstandene Rechnungen nachreihen.
    {
      name: 'invoice_sweep',
      scanDue: (now) => enqueuePendingInvoiceDeliveries({ db, queue, now, config }),
    },
  ],
  logger,
});
await enqueueScanDue(queue);
// Phase 12 Härtung (B6): Ketten-Watchdog – reiht minütlich den AKTUELLEN Bucket
// von scan_due und inbound_poll ein (dedupliziert); eine abgerissene Kette
// setzt so spätestens nach einer Minute wieder auf.
const chainWatchdog = startChainWatchdog(
  [() => enqueueScanDue(queue), () => enqueueInboundPoll(queue, inboundMailSource)],
  { logger },
);

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
  chainWatchdog.stop(); // Phase 12 Härtung (B6)
  await runner.stop();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
