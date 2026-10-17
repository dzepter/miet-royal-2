import type { JobHandler } from '@mietroyal/integrations';
import type { FinanceHandlerDeps } from '../jobs/finance.ts';

/**
 * Job `settlement.accounting_transfer` (Payload { settlementId, reason }):
 * Der Handler lädt das Settlement, prüft INNERHALB der Transfersperre erneut
 * alle Bedingungen (Status ready_for_accounting/transfer_failed, Frist
 * abgelaufen, keine Kundenrückmeldung, keine offenen Klärungen, kein
 * manualTransferRequired bei automatischem Anlass) und überträgt dann über
 * AccountingTransferService.execute. — Implementierung: SettlementService
 * (Phase 9, Agent Abrechnung).
 */
export function createSettlementAccountingTransferHandler(_deps: FinanceHandlerDeps): JobHandler {
  return async () => {
    throw new Error('settlement.accounting_transfer: Handler noch nicht implementiert');
  };
}
