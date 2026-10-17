import type { JobHandler } from '@mietroyal/integrations';
import { z } from '@mietroyal/validation';
import type { FinanceHandlerDeps } from '../jobs/finance.ts';
import { createCancellationService } from './cancellation-service.ts';

const payloadSchema = z.object({
  cancellationId: z.string().uuid(),
  reason: z.enum(['auto', 'manual', 'retry']).optional(),
});

/**
 * Job `cancellation.accounting_transfer` (Payload { cancellationId, reason }):
 * Der Handler überträgt über CancellationService.executeTransfer – die
 * Rechecks (fee > 0, financeStatus accounting_pending, Vorgang weiterhin
 * cancelled, nicht bereits übertragen) laufen innerhalb der Transfersperre
 * (AccountingTransferService.execute). Erfolg ⇒ invoice_open + Referenz +
 * Zahlungsstatus offen; Fehlschlag ⇒ Fehlercode an der Stornierung und
 * Weiterwerfen für den Queue-Backoff. Ohne konfigurierte Buchhaltung
 * (production) wird der Job als No-op beendet – kein Endlos-Retry.
 */
export function createCancellationAccountingTransferHandler(deps: FinanceHandlerDeps): JobHandler {
  const service = createCancellationService({
    db: deps.db,
    config: deps.config,
    storage: deps.storage,
    transfers: deps.transfers,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
  return async (job) => {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      throw new Error('cancellation.accounting_transfer: ungültiges Job-Payload');
    }
    if (!deps.transfers.isConfigured()) {
      deps.logger?.warn(
        { jobId: job.id, cancellationId: parsed.data.cancellationId },
        'cancellation.accounting_transfer übersprungen: Buchhaltungsintegration nicht konfiguriert',
      );
      return;
    }
    const result = await service.executeTransfer(parsed.data.cancellationId);
    if (result.outcome === 'failed') {
      throw new Error(
        `cancellation.accounting_transfer fehlgeschlagen: ${result.errorCode ?? 'UNKNOWN'}`,
      );
    }
  };
}
