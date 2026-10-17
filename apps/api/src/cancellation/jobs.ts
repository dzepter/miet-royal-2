import type { JobHandler } from '@mietroyal/integrations';
import type { FinanceHandlerDeps } from '../jobs/finance.ts';

/**
 * Job `cancellation.accounting_transfer` (Payload { cancellationId, reason }):
 * Der Handler lädt die Stornierung, prüft innerhalb der Transfersperre erneut
 * (fee > 0, financeStatus accounting_pending, Vorgang weiterhin cancelled)
 * und überträgt über AccountingTransferService.execute. — Implementierung:
 * CancellationService (Phase 9, Agent Storno).
 */
export function createCancellationAccountingTransferHandler(_deps: FinanceHandlerDeps): JobHandler {
  return async () => {
    throw new Error('cancellation.accounting_transfer: Handler noch nicht implementiert');
  };
}
