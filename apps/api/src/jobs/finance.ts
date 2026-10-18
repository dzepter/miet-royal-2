import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type {
  JobQueue,
  JobRunner,
  JobRunnerLogger,
  StorageProvider,
} from '@mietroyal/integrations';
import {
  CANCELLATION_ACCOUNTING_TRANSFER_JOB_TYPE,
  SETTLEMENT_ACCOUNTING_TRANSFER_JOB_TYPE,
  createAccountingGateway,
  type AccountingGateway,
} from '../accounting/gateway.ts';
import { AccountingTransferService } from '../accounting/transfer-service.ts';
import { createCancellationAccountingTransferHandler } from '../cancellation/jobs.ts';
import type { LexwareConnectionService } from '../lexware/connection-service.ts';
import { createLexwareContext, type LexwareContext } from '../lexware/context.ts';
import { createLexwareEventHandler } from '../lexware/event-job.ts';
import { LEXWARE_EVENT_PROCESS_JOB_TYPE } from '../lexware/webhook-service.ts';
import { createLexwareTransferDeps, LexwareAccountingGateway } from '../lexware/lexware-gateway.ts';
import { createSettlementAccountingTransferHandler } from '../settlement/jobs.ts';
import {
  createVoucherCleaningListener,
  createVoucherEligibilityHandler,
  createVoucherPaymentListener,
  VOUCHER_ELIGIBILITY_JOB_TYPE,
  type CleaningEndedListener,
  type PaymentStatusListener,
} from '../voucher/voucher-jobs.ts';
import { VoucherService } from '../voucher/voucher-service.ts';

/**
 * Finanz-Jobs (Phase 9 §44) auf der bestehenden PostgreSQL-Queue. Der Worker
 * (apps/worker) registriert sie über `@mietroyal/api/jobs`; die API hält
 * dieselben Handler in einem NICHT gestarteten Runner für die Mock-Steuerung
 * „fällige Jobs jetzt ausführen“ (nur außerhalb von production).
 */
export interface FinanceJobDeps {
  db: Database;
  config: AppConfig;
  queue: JobQueue;
  storage: StorageProvider;
  accountingGateway: AccountingGateway;
  /** Phase 10: Lexware-Kontext (client null ⇒ nicht aktiv). */
  lexware: LexwareContext;
  /** Phase 10: geteilte Verbindungsprüfung (optional; sonst eigene Instanz). */
  lexwareConnection?: LexwareConnectionService;
  /** Phase 10: Kennung des Prozesses für Transfer-Claims (Default api:<pid>). */
  workerId?: string;
  logger?: JobRunnerLogger;
  /** Phase 11: Zahlungsstatus-Listener (Default: Gutschein-Trigger A auf derselben Queue). */
  paymentStatusListeners?: readonly PaymentStatusListener[];
}

export {
  SETTLEMENT_ACCOUNTING_TRANSFER_JOB_TYPE,
  CANCELLATION_ACCOUNTING_TRANSFER_JOB_TYPE,
  LEXWARE_EVENT_PROCESS_JOB_TYPE,
  VOUCHER_ELIGIBILITY_JOB_TYPE,
};
export type { CleaningEndedListener, PaymentStatusListener };

/**
 * Phase 11 (Order §7): Gutschein-Trigger für API und Worker – Listener reihen
 * nur Jobs ein (Idempotenzschlüssel je Settlement/Trigger); die Entscheidung
 * trifft der `VoucherService` im Job. Eine Stelle für beide Prozesse.
 */
export function createVoucherTriggers(deps: {
  db: Database;
  queue: JobQueue;
  logger?: JobRunnerLogger;
}): { paymentStatusListener: PaymentStatusListener; cleaningEndedListener: CleaningEndedListener } {
  return {
    paymentStatusListener: createVoucherPaymentListener(deps.queue, deps.logger),
    cleaningEndedListener: createVoucherCleaningListener(deps.db, deps.queue, deps.logger),
  };
}
export type { AccountingGateway, LexwareContext };
export { createLexwareContext };

/** Gateway-Wahl inkl. Lexware (Order §4) – eine Stelle für API und Worker. */
export function createAccountingGatewayFor(
  config: AppConfig,
  lexware: LexwareContext,
): AccountingGateway {
  return createAccountingGateway(config, {
    client: lexware.client,
    gateway: () => new LexwareAccountingGateway(lexware),
  });
}

/** Transfer-Boundary inkl. Lexware-Zweiphasenpfad – eine Komposition für API, Worker und Tests. */
export function createAccountingTransferService(deps: {
  db: Database;
  queue: JobQueue;
  accountingGateway: AccountingGateway;
  lexware: LexwareContext;
  lexwareConnection?: LexwareConnectionService;
  workerId?: string;
  logger?: JobRunnerLogger;
  /** Phase 11: Default = Gutschein-Trigger A (`createVoucherTriggers`). */
  paymentStatusListeners?: readonly PaymentStatusListener[];
}): AccountingTransferService {
  return new AccountingTransferService(
    deps.db,
    deps.accountingGateway,
    deps.queue,
    deps.accountingGateway.provider === 'lexware'
      ? createLexwareTransferDeps(deps.lexware, {
          ...(deps.lexwareConnection === undefined ? {} : { connection: deps.lexwareConnection }),
          ...(deps.workerId === undefined ? {} : { workerId: deps.workerId }),
        })
      : undefined,
    deps.paymentStatusListeners ?? [createVoucherTriggers(deps).paymentStatusListener],
  );
}

export function registerFinanceJobHandlers(runner: JobRunner, deps: FinanceJobDeps): void {
  const transfers = createAccountingTransferService(deps);
  runner.register(
    SETTLEMENT_ACCOUNTING_TRANSFER_JOB_TYPE,
    createSettlementAccountingTransferHandler({ ...deps, transfers }),
  );
  runner.register(
    CANCELLATION_ACCOUNTING_TRANSFER_JOB_TYPE,
    createCancellationAccountingTransferHandler({ ...deps, transfers }),
  );
  // Phase 10: Webhook-Ereignisse (Order §48) – Payload ist nur Trigger; der
  // Worker liest den Stand bei Lexware. Kein Polling-/Cron-Job (Order §53).
  runner.register(
    LEXWARE_EVENT_PROCESS_JOB_TYPE,
    createLexwareEventHandler({ ...deps, transfers }),
  );
  // Phase 11: Gutschein-Prüfung (Order §7) – idempotent je Settlement.
  runner.register(
    VOUCHER_ELIGIBILITY_JOB_TYPE,
    createVoucherEligibilityHandler(
      new VoucherService(deps.db, deps.config, deps.logger),
      deps.logger,
      // Phase 12 (transactional): neuer Gutschein ⇒ Versandjob voucher.delivery.
      deps.queue,
    ),
  );
}

export type FinanceHandlerDeps = FinanceJobDeps & { transfers: AccountingTransferService };
