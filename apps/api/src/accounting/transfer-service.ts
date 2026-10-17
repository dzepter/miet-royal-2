import { createHash } from 'node:crypto';
import {
  accountingTransfers,
  cancellations,
  settlements,
  type Database,
  type DatabaseTransaction,
} from '@mietroyal/database';
import type { JobQueue } from '@mietroyal/integrations';
import { eq } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import {
  AccountingGatewayError,
  CANCELLATION_ACCOUNTING_TRANSFER_JOB_TYPE,
  SETTLEMENT_ACCOUNTING_TRANSFER_JOB_TYPE,
  cancellationTransferIdempotencyKey,
  settlementTransferIdempotencyKey,
  type AccountingGateway,
  type AccountingPayload,
  type AccountingTransferResult,
} from './gateway.ts';

export type AccountingTransferRow = typeof accountingTransfers.$inferSelect;

/**
 * Gemeinsame Transfer-Boundary für Abrechnung UND Storno (Phase-9-Vorgabe
 * §37–§40, §44–§46). Garantien:
 *
 * - Genau EIN accounting_transfers-Datensatz je Settlement/Cancellation
 *   (partielle Unique-Indizes + stabiler Idempotenzschlüssel). `prepare()`
 *   ist idempotent und friert den Payload-Snapshot VOR der Übertragung ein;
 *   der Snapshot wird danach nie mehr verändert (Hash dokumentiert das).
 * - `execute()` sperrt die Transferzeile (SELECT … FOR UPDATE) für die
 *   gesamte Dauer des Gateway-Aufrufs: Doppelklick, paralleler Worker und
 *   Retry warten auf die Sperre und sehen anschließend `succeeded` – es
 *   entsteht nie eine zweite externe Übertragung. Ein Absturz während des
 *   Aufrufs rollt die Zeile auf `pending` zurück; der Wiederholungsversuch
 *   nutzt denselben Idempotenzschlüssel (Gateway-seitig idempotent).
 * - Fehlschläge erhöhen `attempts`, speichern nur einen neutralen Fehlercode
 *   (keine Stacktraces/Kundendaten) und werfen weiter, damit die Queue mit
 *   Backoff erneut versucht.
 */
export class AccountingTransferService {
  constructor(
    private readonly db: Database,
    private readonly gateway: AccountingGateway,
    private readonly queue: JobQueue,
  ) {}

  get provider(): AccountingGateway['provider'] {
    return this.gateway.provider;
  }

  isConfigured(): boolean {
    return this.gateway.isConfigured();
  }

  /** Wirft AuthError CONFLICT „Buchhaltungsintegration nicht konfiguriert“ (production). */
  assertConfigured(): void {
    this.gateway.assertConfigured();
  }

  static hashSnapshot(payload: AccountingPayload): string {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  /**
   * Legt die Transferzeile mit eingefrorenem Snapshot an (idempotent: eine
   * bereits vorhandene Zeile wird unverändert zurückgegeben – auch wenn sich
   * der übergebene Payload inzwischen unterscheiden würde).
   */
  async prepare(
    tx: DatabaseTransaction,
    target:
      | { kind: 'settlement'; settlementId: string; processId: string }
      | { kind: 'cancellation'; cancellationId: string; processId: string },
    payload: AccountingPayload,
  ): Promise<AccountingTransferRow> {
    const idempotencyKey =
      target.kind === 'settlement'
        ? settlementTransferIdempotencyKey(target.settlementId)
        : cancellationTransferIdempotencyKey(target.cancellationId);
    if (payload.idempotencyKey !== idempotencyKey) {
      throw new AuthError('CONFLICT', 'Idempotenzschlüssel des Payloads passt nicht zum Ziel.');
    }
    const existing = await tx
      .select()
      .from(accountingTransfers)
      .where(eq(accountingTransfers.idempotencyKey, idempotencyKey))
      .for('update');
    if (existing[0] !== undefined) return existing[0];
    const inserted = await tx
      .insert(accountingTransfers)
      .values({
        kind: target.kind,
        settlementId: target.kind === 'settlement' ? target.settlementId : null,
        cancellationId: target.kind === 'cancellation' ? target.cancellationId : null,
        processId: target.processId,
        idempotencyKey,
        provider: this.gateway.provider,
        snapshot: payload,
        snapshotHash: AccountingTransferService.hashSnapshot(payload),
      })
      .onConflictDoNothing({ target: accountingTransfers.idempotencyKey })
      .returning();
    if (inserted[0] !== undefined) return inserted[0];
    const again = await tx
      .select()
      .from(accountingTransfers)
      .where(eq(accountingTransfers.idempotencyKey, idempotencyKey))
      .for('update');
    const row = again[0];
    if (row === undefined)
      throw new AuthError('CONFLICT', 'Transferzeile konnte nicht angelegt werden.');
    return row;
  }

  /** Stellt den Transferjob ein (dedupliziert über die Queue-Idempotenz). */
  async enqueue(
    row: Pick<AccountingTransferRow, 'kind' | 'settlementId' | 'cancellationId' | 'idempotencyKey'>,
    options: { runAt?: Date; reason: 'auto' | 'manual' | 'retry' } = { reason: 'auto' },
  ): Promise<{ jobId: string; deduplicated: boolean }> {
    const type =
      row.kind === 'settlement'
        ? SETTLEMENT_ACCOUNTING_TRANSFER_JOB_TYPE
        : CANCELLATION_ACCOUNTING_TRANSFER_JOB_TYPE;
    const payload =
      row.kind === 'settlement'
        ? { settlementId: row.settlementId, reason: options.reason }
        : { cancellationId: row.cancellationId, reason: options.reason };
    // Ein Job je Transfer und Anlass-Generation: Retries nach Fehlschlag
    // bekommen durch den Queue-Backoff ohnehin denselben Job; manuelle
    // Wiederholungen nach „dead“ brauchen einen frischen Schlüssel.
    const suffix = options.reason === 'auto' ? '' : `:${options.reason}:${Date.now()}`;
    return this.queue.enqueue(type, payload, {
      idempotencyKey: `${row.idempotencyKey}${suffix}`,
      ...(options.runAt === undefined ? {} : { runAt: options.runAt }),
    });
  }

  async byId(transferId: string): Promise<AccountingTransferRow | undefined> {
    const rows = await this.db
      .select()
      .from(accountingTransfers)
      .where(eq(accountingTransfers.id, transferId));
    return rows[0];
  }

  /**
   * Führt die Übertragung exklusiv aus. `recheck` läuft INNERHALB der
   * Sperre (TOCTOU-Schutz, §46): liefert es false, wird nichts übertragen
   * (Ergebnis 'skipped'). `onSuccess` läuft in derselben Transaktion nach
   * dem Gateway-Erfolg (Settlement/Storno sperren, Vorgang abschließen …).
   */
  async execute(
    transferId: string,
    hooks: {
      recheck: (tx: DatabaseTransaction, row: AccountingTransferRow) => Promise<boolean>;
      onSuccess: (
        tx: DatabaseTransaction,
        row: AccountingTransferRow,
        result: AccountingTransferResult,
      ) => Promise<void>;
      onFailure?: (
        tx: DatabaseTransaction,
        row: AccountingTransferRow,
        code: string,
      ) => Promise<void>;
    },
    now = new Date(),
  ): Promise<{
    outcome: 'succeeded' | 'already_succeeded' | 'skipped' | 'failed';
    row: AccountingTransferRow;
    errorCode?: string;
  }> {
    return this.db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(accountingTransfers)
        .where(eq(accountingTransfers.id, transferId))
        .for('update');
      const row = locked[0];
      if (row === undefined) throw new AuthError('NOT_FOUND', 'Übertragung nicht gefunden.');
      if (row.status === 'succeeded') return { outcome: 'already_succeeded', row };
      if (!(await hooks.recheck(tx, row))) return { outcome: 'skipped', row };

      const attempt = row.attempts + 1;
      const payload = row.snapshot as AccountingPayload;
      try {
        const result = await this.gateway.transfer({
          idempotencyKey: row.idempotencyKey,
          payload,
          attempt,
        });
        const updated = await tx
          .update(accountingTransfers)
          .set({
            status: 'succeeded',
            // Provider des tatsächlich erfolgreichen Gateways (eine in production
            // mit „disabled“ vorbereitete Zeile wird bei späterer Anbindung korrekt).
            provider: result.provider,
            attempts: attempt,
            lastErrorCode: null,
            externalReference: result.externalReference,
            paymentStatus: result.paymentStatus,
            transferredAt: now,
            updatedAt: now,
          })
          .where(eq(accountingTransfers.id, row.id))
          .returning();
        const successRow = updated[0] ?? row;
        await hooks.onSuccess(tx, successRow, result);
        return { outcome: 'succeeded', row: successRow };
      } catch (error) {
        const code =
          error instanceof AccountingGatewayError
            ? error.code
            : error instanceof AuthError
              ? error.code
              : 'UNKNOWN';
        const updated = await tx
          .update(accountingTransfers)
          .set({ status: 'failed', attempts: attempt, lastErrorCode: code, updatedAt: now })
          .where(eq(accountingTransfers.id, row.id))
          .returning();
        const failedRow = updated[0] ?? row;
        if (hooks.onFailure !== undefined) await hooks.onFailure(tx, failedRow, code);
        return { outcome: 'failed', row: failedRow, errorCode: code };
      }
    });
  }

  /**
   * Zahlungsstatus setzen (§42/§43). Phase 9: ausschließlich über die
   * Mock-Steuerung (nicht in production) oder spätere echte Rückmeldung.
   * Spiegelt den Status in settlements bzw. cancellations.
   */
  async setPaymentStatus(
    transferId: string,
    status: 'open' | 'paid' | 'overdue',
    now = new Date(),
  ): Promise<AccountingTransferRow> {
    return this.db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(accountingTransfers)
        .where(eq(accountingTransfers.id, transferId))
        .for('update');
      const row = locked[0];
      if (row === undefined) throw new AuthError('NOT_FOUND', 'Übertragung nicht gefunden.');
      if (row.status !== 'succeeded') {
        throw new AuthError('CONFLICT', 'Zahlungsstatus nur für erfolgreich übertragene Belege.');
      }
      const updated = await tx
        .update(accountingTransfers)
        .set({ paymentStatus: status, updatedAt: now })
        .where(eq(accountingTransfers.id, row.id))
        .returning();
      if (row.settlementId !== null) {
        await tx
          .update(settlements)
          .set({ paymentStatus: status, updatedAt: now })
          .where(eq(settlements.id, row.settlementId));
      }
      if (row.cancellationId !== null) {
        await tx
          .update(cancellations)
          .set({
            paymentStatus: status,
            financeStatus: status === 'paid' ? 'paid' : 'invoice_open',
            updatedAt: now,
          })
          .where(eq(cancellations.id, row.cancellationId));
      }
      return updated[0] ?? row;
    });
  }
}
