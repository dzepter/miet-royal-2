import type { JobHandler } from '@mietroyal/integrations';
import { ProcessService } from '../crm/process-service.ts';
import type { FinanceHandlerDeps } from '../jobs/finance.ts';
import { createSettlementNoticeGateway } from './notice-gateway.ts';
import { SettlementService } from './settlement-service.ts';

/**
 * Job `settlement.accounting_transfer` (Payload { settlementId, reason }):
 * Der Handler lädt das Settlement und überträgt über
 * `SettlementService.runAutoTransfer` – alle Bedingungen (Status, keine
 * offenen Klärungen, kein manualTransferRequired, bei Kundeninformation:
 * gesendet, Frist abgelaufen, keine Rückmeldung, keine Betragsänderung,
 * Vorgang nicht storniert) werden unter der Settlement-Sperre UND erneut in
 * der Transfersperre geprüft (TOCTOU, §80). `skipped` ist kein Fehler; ein
 * Gateway-Fehler wird weitergeworfen, damit die Queue mit Backoff erneut
 * versucht (Settlement: transfer_failed, nur neutraler Fehlercode).
 */
export function createSettlementAccountingTransferHandler(deps: FinanceHandlerDeps): JobHandler {
  const service = new SettlementService({
    db: deps.db,
    transfers: deps.transfers,
    noticeGateway: createSettlementNoticeGateway(deps.config),
    queue: deps.queue,
    processes: new ProcessService(deps.db),
    appEnv: deps.config.appEnv,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
  return async (job) => {
    const payload = job.payload as { settlementId?: unknown; reason?: unknown } | null;
    const settlementId = payload?.settlementId;
    if (typeof settlementId !== 'string' || settlementId === '') {
      throw new Error('settlement.accounting_transfer: Payload ohne settlementId');
    }
    const result = await service.runAutoTransfer(settlementId, new Date());
    deps.logger?.info(
      { jobId: job.id, settlementId, outcome: result.outcome, attempt: job.attempts },
      'settlement.accounting_transfer verarbeitet',
    );
    if (result.outcome === 'failed') {
      throw new Error(`Buchhaltungsübertragung fehlgeschlagen (${result.errorCode ?? 'UNKNOWN'})`);
    }
  };
}
