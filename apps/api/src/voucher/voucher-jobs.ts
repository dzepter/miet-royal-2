import {
  rentalReturns,
  returnMachines,
  settlements,
  vouchers,
  type DatabaseExecutor,
} from '@mietroyal/database';
import type { JobHandler, JobQueue } from '@mietroyal/integrations';
import { and, eq, isNull } from 'drizzle-orm';
import type { VoucherService, VoucherLogger } from './voucher-service.ts';

/**
 * Trigger-Verdrahtung des Wiedermieter-Gutscheins (Order §7) auf der
 * PostgreSQL-Queue: Job `voucher.eligibility_check` mit Payload
 * `{ settlementId, trigger }`. Idempotenzschlüssel je Settlement/Trigger –
 * mehrfache Ereignisse (zwei paid-Webhooks, Reconcile + Webhook, Reinigung
 * mehrerer Maschinen) reihen höchstens je einen Job ein; der Service selbst
 * ist zusätzlich idempotent (genau ein Gutschein).
 *
 * Trigger A: Zahlungsstatus → paid (AccountingTransferService nach Commit).
 * Trigger B: Reinigungs-/Nachtragsphase der letzten Maschine beendet
 * (MachineService nach Reinigungsabschluss/Statuswechsel/Neuausgabe).
 */
export const VOUCHER_ELIGIBILITY_JOB_TYPE = 'voucher.eligibility_check';

export type VoucherTrigger = 'paid' | 'cleaning' | 'backfill' | 'manual';

export interface VoucherEligibilityJobPayload {
  settlementId: string;
  trigger: VoucherTrigger;
}

export function voucherEligibilityIdempotencyKey(
  settlementId: string,
  trigger: VoucherTrigger,
  suffix: string,
): string {
  return `voucher-eligibility:${settlementId}:${trigger}:${suffix}`;
}

export async function enqueueVoucherEligibility(
  queue: JobQueue,
  input: { settlementId: string; trigger: VoucherTrigger; key: string; runAt?: Date },
): Promise<void> {
  const payload: VoucherEligibilityJobPayload = {
    settlementId: input.settlementId,
    trigger: input.trigger,
  };
  await queue.enqueue(VOUCHER_ELIGIBILITY_JOB_TYPE, payload, {
    idempotencyKey: input.key,
    ...(input.runAt === undefined ? {} : { runAt: input.runAt }),
  });
}

/** Job-Handler: Fehler werfen ⇒ Queue-Retry mit Backoff; Log nur IDs/Outcome. */
export function createVoucherEligibilityHandler(
  service: VoucherService,
  logger?: VoucherLogger,
): JobHandler {
  return async (job) => {
    const payload = job.payload as Partial<VoucherEligibilityJobPayload> | null;
    const settlementId = payload?.settlementId;
    if (typeof settlementId !== 'string' || settlementId === '') {
      throw new Error('voucher.eligibility_check: Payload ohne settlementId');
    }
    const result = await service.ensureVoucherForSettlement(settlementId, new Date());
    logger?.info(
      {
        jobId: job.id,
        settlementId,
        trigger: payload?.trigger ?? null,
        outcome: result.outcome,
        attempt: job.attempts,
      },
      'voucher.eligibility_check verarbeitet',
    );
  };
}

// ── Listener (werden in app.ts / worker injiziert; keine zyklischen Imports) ──

export interface PaymentStatusChangedEvent {
  transferId: string;
  settlementId: string | null;
  cancellationId: string | null;
  status: 'open' | 'paid' | 'overdue';
  /** Zeitpunkt des Statuswechsels – Teil des Job-Schlüssels, damit paid → overdue → paid erneut prüft. */
  changedAt: Date;
}

/** Schnittstelle, die `AccountingTransferService` NACH Commit bedient. */
export interface PaymentStatusListener {
  paymentStatusChanged(event: PaymentStatusChangedEvent): Promise<void>;
}

export interface CleaningEndedEvent {
  machineId: string;
  endedAt: Date;
  reason: 'cleaned' | 'status' | 'rented';
  /** Laufende Transaktion des Auslösers (nur für Lesezugriffe). */
  executor?: DatabaseExecutor;
}

/** Schnittstelle, die `MachineService` nach dem Ende einer Reinigungsphase bedient. */
export interface CleaningEndedListener {
  cleaningEnded(event: CleaningEndedEvent): Promise<void>;
}

/** Trigger A: paid für ein Settlement ⇒ Job (Stornorechnungen tragen kein Settlement ⇒ nie). */
export function createVoucherPaymentListener(
  queue: JobQueue,
  logger?: VoucherLogger,
): PaymentStatusListener {
  return {
    async paymentStatusChanged(event) {
      if (event.status !== 'paid' || event.settlementId === null) return;
      try {
        await enqueueVoucherEligibility(queue, {
          settlementId: event.settlementId,
          trigger: 'paid',
          key: voucherEligibilityIdempotencyKey(
            event.settlementId,
            'paid',
            `${event.transferId}:${event.changedAt.toISOString()}`,
          ),
        });
      } catch (error) {
        logger?.error(
          {
            settlementId: event.settlementId,
            transferId: event.transferId,
            error: error instanceof Error ? error.name : 'unknown',
          },
          'Gutschein-Prüfjob konnte nach Zahlungseingang nicht eingereiht werden',
        );
      }
    },
  };
}

/**
 * Trigger B: alle bezahlten, übertragenen Settlements ohne Gutschein, deren
 * Return diese Maschine enthält ⇒ Job. Bei Neuausgabe (innerhalb fremder
 * Transaktion) mit 60 s Verzögerung, damit der Job nach dem Commit läuft.
 */
export function createVoucherCleaningListener(
  db: DatabaseExecutor,
  queue: JobQueue,
  logger?: VoucherLogger,
): CleaningEndedListener {
  return {
    async cleaningEnded(event) {
      try {
        const executor = event.executor ?? db;
        const rows = await executor
          .select({ settlementId: settlements.id })
          .from(returnMachines)
          .innerJoin(rentalReturns, eq(rentalReturns.id, returnMachines.returnId))
          .innerJoin(settlements, eq(settlements.returnId, rentalReturns.id))
          .leftJoin(vouchers, eq(vouchers.originSettlementId, settlements.id))
          .where(
            and(
              eq(returnMachines.machineId, event.machineId),
              eq(settlements.status, 'transferred'),
              eq(settlements.paymentStatus, 'paid'),
              isNull(vouchers.id),
            ),
          );
        const runAt =
          event.reason === 'rented' ? new Date(event.endedAt.getTime() + 60_000) : undefined;
        for (const row of rows) {
          await enqueueVoucherEligibility(queue, {
            settlementId: row.settlementId,
            trigger: 'cleaning',
            key: voucherEligibilityIdempotencyKey(
              row.settlementId,
              'cleaning',
              `${event.machineId}:${event.endedAt.toISOString()}`,
            ),
            ...(runAt === undefined ? {} : { runAt }),
          });
        }
      } catch (error) {
        logger?.error(
          { machineId: event.machineId, error: error instanceof Error ? error.name : 'unknown' },
          'Gutschein-Prüfjob konnte nach Reinigungsende nicht eingereiht werden',
        );
      }
    },
  };
}
