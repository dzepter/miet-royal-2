import type { JobHandler } from '@mietroyal/integrations';
import { settlementTransferIdempotencyKey } from '../accounting/gateway.ts';
import { createRetentionCompletionListener } from '../communication/retention/cleanup.ts';
import { ProcessService } from '../crm/process-service.ts';
import type { FinanceHandlerDeps } from '../jobs/finance.ts';
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
    // Phase 12: Der Transferjob versendet nie Kundeninformationen – kein Mailer nötig.
    notices: null,
    queue: deps.queue,
    // Phase 12 (E2E-Agent 2, Retention Order §25): Abschluss über den Auto-Transfer
    // reiht wie der CRM-Abschluss sofort den Foto-Retention-Job ein (Backstop bleibt).
    processes: new ProcessService(deps.db, [
      createRetentionCompletionListener(deps.queue, deps.logger),
    ]),
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
    // Phase 10: nur transiente Fehler werfen (Queue-Backoff); permanente
    // Blocker (Steuerkonfiguration, Kontakt, Berechtigung, Prüfstatus)
    // werden nicht endlos wiederholt – sie sind in der Abrechnung sichtbar.
    if (result.outcome === 'skipped' && result.retryAt !== undefined) {
      // Ein anderer Worker hält den Claim: nach dessen Ablauf erneut prüfen (kein Fehler).
      await deps.transfers.enqueue(
        {
          kind: 'settlement',
          settlementId,
          cancellationId: null,
          idempotencyKey: settlementTransferIdempotencyKey(settlementId),
        },
        { reason: 'retry', runAt: result.retryAt },
      );
      return;
    }
    if (result.outcome === 'failed' && result.transient !== false) {
      throw new Error(`Buchhaltungsübertragung fehlgeschlagen (${result.errorCode ?? 'UNKNOWN'})`);
    }
  };
}
