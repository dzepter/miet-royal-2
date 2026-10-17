import type { JobRunnerLogger } from '@mietroyal/integrations';
import type { ReturnFinalizedListener } from '../returns/return-service.ts';
import type { SettlementService } from './settlement-service.ts';

/**
 * Phase 9 (§§4/23/48): Nach einer erfolgreich committeten Rückgabe-
 * Finalisierung entsteht genau EIN Settlement – idempotent und außerhalb
 * der Finalisierungs-Transaktion. Fehler werden nur protokolliert (IDs,
 * Fehlercode); die Finalisierung bleibt gültig und `pnpm settlement:ensure`
 * bzw. POST …/settlement/ensure holen die Abrechnung nach.
 */
export function createSettlementEnsureListener(
  service: SettlementService,
  logger: JobRunnerLogger,
): ReturnFinalizedListener {
  return {
    async returnFinalized(event) {
      try {
        await service.ensureSettlementForReturn(event.returnId, event.finalizedAt);
      } catch (error) {
        logger.error(
          {
            returnId: event.returnId,
            processId: event.processId,
            error: error instanceof Error ? error.name : 'unknown',
          },
          'Abrechnung konnte nach der Rückgabe-Finalisierung nicht angelegt werden',
        );
      }
    },
  };
}
