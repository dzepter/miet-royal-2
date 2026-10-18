import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type {
  JobQueue,
  JobRunner,
  JobRunnerLogger,
  StorageProvider,
} from '@mietroyal/integrations';
import { CustomerActionLinkService } from '../communication/action-links/service.ts';
import type { CommunicationContext } from '../communication/context.ts';
import {
  AppointmentCustomerInfoService,
  ReminderService,
} from '../communication/reminders/service.ts';
import {
  createCleanupRetentionHandler,
  createRetentionCompletionListener,
  RetentionCleanupService,
} from '../communication/retention/cleanup.ts';
import {
  createScanDueHandler,
  enqueueScanDue,
  runScanDue,
  type DueScanner,
} from '../communication/scan-due.ts';
import {
  COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE,
  COMMUNICATION_SCAN_DUE_JOB_TYPE,
} from '../communication/types.ts';

/**
 * Phase 12 (reminders): zentraler Scan-Job `communication.scan_due`,
 * Retention-Job `communication.cleanup_retention`, Kunden-Erinnerungen,
 * Aktionslinks und Terminänderungs-Mail – EINE Komposition für API
 * (app.ts), Worker (apps/worker) und Tests (auth-helpers).
 *
 * `scanners`: weitere DueScanner (Push-Regeln von Agent P, Gutschein-Sweep
 * von Agent T) werden hier eingehängt; der Reminder-Scanner ist immer dabei.
 */
export interface ScanModuleDeps {
  db: Database;
  config: AppConfig;
  queue: JobQueue;
  storage: StorageProvider;
  communication: CommunicationContext;
  /** Zusätzliche Scanner (Push-Regeln, Gutschein-Sweep …) – laufen nach den Erinnerungen. */
  scanners?: readonly DueScanner[];
  logger?: JobRunnerLogger | undefined;
  now?: () => Date;
}

export interface ScanModule {
  reminders: ReminderService;
  actionLinks: CustomerActionLinkService;
  appointmentInfo: AppointmentCustomerInfoService;
  retention: RetentionCleanupService;
  scanners: readonly DueScanner[];
  /** Listener für ProcessService (Vorgangsabschluss ⇒ Foto-Retention-Job). */
  processCompletionListener: ReturnType<typeof createRetentionCompletionListener>;
  /** Ein Scan-Lauf ohne Self-Re-Enqueue (Tests/Mock-Steuerung). */
  runOnce(now?: Date): ReturnType<typeof runScanDue>;
}

export function createScanModule(deps: ScanModuleDeps): ScanModule {
  const now = deps.now ?? (() => new Date());
  const actionLinks = new CustomerActionLinkService(deps.db, now);
  const reminders = new ReminderService({
    db: deps.db,
    outbox: deps.communication.outbox,
    actionLinks,
    logger: deps.logger,
  });
  const appointmentInfo = new AppointmentCustomerInfoService(deps.db, deps.communication.outbox);
  const retention = new RetentionCleanupService({
    db: deps.db,
    storage: deps.storage,
    logger: deps.logger,
  });
  // Sent-Listener: Reminder-Zeile `sentAt`, Terminänderung ⇒ Kunde informiert.
  deps.communication.addMailSentListener(reminders.sentListener());
  deps.communication.addMailSentListener(appointmentInfo.sentListener());
  // Phase 12 Härtung (B7/RA-5): veraltete Erinnerung/Terminänderung nie versenden.
  deps.communication.addMailPreSendGuard(reminders.preSendGuard());
  deps.communication.addMailPreSendGuard(appointmentInfo.preSendGuard());
  const scanners: DueScanner[] = [
    { name: 'reminders', scanDue: (at) => reminders.scanDue(at) },
    ...(deps.scanners ?? []),
  ];
  return {
    reminders,
    actionLinks,
    appointmentInfo,
    retention,
    scanners,
    processCompletionListener: createRetentionCompletionListener(deps.queue, deps.logger),
    runOnce: (at = now()) =>
      runScanDue(
        {
          db: deps.db,
          queue: deps.queue,
          scanners,
          retention,
          logger: deps.logger,
          reenqueue: false,
        },
        at,
      ),
  };
}

export function registerScanDueJobHandlers(
  runner: JobRunner,
  deps: ScanModuleDeps & { module?: ScanModule },
): ScanModule {
  const module = deps.module ?? createScanModule(deps);
  runner.register(
    COMMUNICATION_SCAN_DUE_JOB_TYPE,
    createScanDueHandler({
      db: deps.db,
      queue: deps.queue,
      scanners: module.scanners,
      retention: module.retention,
      logger: deps.logger,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  );
  runner.register(
    COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE,
    createCleanupRetentionHandler({
      retention: module.retention,
      logger: deps.logger,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  );
  return module;
}

export { createRetentionCompletionListener, enqueueScanDue, type DueScanner };
// Phase 12 Härtung (B6): Ketten-Watchdog für den Worker.
export { CHAIN_WATCHDOG_INTERVAL_MS, startChainWatchdog } from '../communication/chain-bucket.ts';
export { COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE, COMMUNICATION_SCAN_DUE_JOB_TYPE };
