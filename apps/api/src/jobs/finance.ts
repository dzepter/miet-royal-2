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
import { createSettlementAccountingTransferHandler } from '../settlement/jobs.ts';

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
  logger?: JobRunnerLogger;
}

export {
  SETTLEMENT_ACCOUNTING_TRANSFER_JOB_TYPE,
  CANCELLATION_ACCOUNTING_TRANSFER_JOB_TYPE,
  createAccountingGateway,
};
export type { AccountingGateway };

export function registerFinanceJobHandlers(runner: JobRunner, deps: FinanceJobDeps): void {
  const transfers = new AccountingTransferService(deps.db, deps.accountingGateway, deps.queue);
  runner.register(
    SETTLEMENT_ACCOUNTING_TRANSFER_JOB_TYPE,
    createSettlementAccountingTransferHandler({ ...deps, transfers }),
  );
  runner.register(
    CANCELLATION_ACCOUNTING_TRANSFER_JOB_TYPE,
    createCancellationAccountingTransferHandler({ ...deps, transfers }),
  );
}

export type FinanceHandlerDeps = FinanceJobDeps & { transfers: AccountingTransferService };
