import { createHash } from 'node:crypto';
import {
  accountingTransfers,
  cancellations,
  lexwareInvoiceMappings,
  settlements,
  type Database,
  type DatabaseTransaction,
  type LexwareInvoiceMappingRow,
} from '@mietroyal/database';
import type { JobQueue } from '@mietroyal/integrations';
import { eq } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import type { LexwareClient, LexwareInvoice, LexwarePayment } from '../lexware/client.ts';
import type { LexwareConnectionService } from '../lexware/connection-service.ts';
import type { ContactSyncService } from '../lexware/contact-sync-service.ts';
import {
  berlinTodayIso,
  lexwareInvoiceDeeplink,
  normalizeLexwarePaymentStatus,
  type LexwareContext,
} from '../lexware/context.ts';
import { LexwareApiError } from '../lexware/errors.ts';
import {
  buildInvoiceBody,
  buildProviderSnapshot,
  hashProviderSnapshot,
  InvoiceBuildError,
  isProviderSnapshotV2,
  remarkContainsMarker,
  transferMarkerFor,
  type ProviderSnapshotV2,
} from '../lexware/invoice-builder.ts';
import { decimalToCents, MoneyConversionError } from '../lexware/money.ts';
import type { PaymentStatusListener } from '../voucher/voucher-jobs.ts';
import type { TaxConfigService } from '../lexware/tax-config-service.ts';
import { assessTransferReadiness, type ReadinessBlocker } from '../lexware/transfer-readiness.ts';
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

/** Abhängigkeiten des zweiphasigen Lexware-Pfads (Vertrag §6). */
export interface LexwareTransferDeps {
  context: LexwareContext;
  connection: LexwareConnectionService;
  taxConfig: TaxConfigService;
  contacts: ContactSyncService;
  /** Kennung des beanspruchenden Prozesses (claimedBy). */
  workerId: string;
}

/** Beanspruchung einer Transferzeile (Phase 1) – nach Ablauf darf ein anderer Worker übernehmen (mit Recovery). */
export const TRANSFER_CLAIM_MS = 10 * 60 * 1000;
/** Obergrenze geprüfter Recovery-Kandidaten (Belegliste ist bereits nach Kontakt/Datum gefiltert). */
export const RECOVERY_CANDIDATE_LIMIT = 50;

export interface ExecuteTransferResult {
  outcome: 'succeeded' | 'already_succeeded' | 'skipped' | 'failed';
  row: AccountingTransferRow;
  errorCode?: string;
  /**
   * Nur bei `failed`: true ⇒ Queue-Retry sinnvoll (transient); false ⇒
   * permanenter Blocker (Konfiguration/Daten/Prüfung) – kein Auto-Retry.
   * Mock-/Disabled-Pfad: immer true (Phase-9-Verhalten unverändert).
   */
  transient?: boolean;
  /** Nur bei `skipped` wegen aktivem Claim eines anderen Workers: Zeitpunkt für einen erneuten Job. */
  retryAt?: Date;
}

export interface TransferHooks {
  recheck: (tx: DatabaseTransaction, row: AccountingTransferRow) => Promise<boolean>;
  onSuccess: (
    tx: DatabaseTransaction,
    row: AccountingTransferRow,
    result: AccountingTransferResult,
  ) => Promise<void>;
  onFailure?: (tx: DatabaseTransaction, row: AccountingTransferRow, code: string) => Promise<void>;
}

type Phase1 =
  | { kind: 'done'; result: ExecuteTransferResult }
  | {
      kind: 'proceed';
      row: AccountingTransferRow;
      payload: AccountingPayload;
      snapshot: ProviderSnapshotV2;
      mapping: LexwareInvoiceMappingRow;
      organizationId: string;
      needsRecovery: boolean;
    };

type Phase2 =
  | {
      kind: 'success';
      invoice: LexwareInvoice;
      payment: LexwarePayment | null;
      contactId: string;
    }
  | {
      kind: 'failed';
      code: string;
      transient: boolean;
      contactId: string | null;
      /** true ⇒ eine Recovery hat „kein Treffer“ ergeben (outcome_unknown darf verlassen werden). */
      recoveryResolved: boolean;
    }
  | { kind: 'unknown'; code: string; invoiceId: string | null; contactId: string | null }
  | {
      kind: 'attention';
      code: string;
      invoice: LexwareInvoice | null;
      payment: LexwarePayment | null;
      contactId: string | null;
    };

function shiftIsoDate(isoDate: string, days: number): string {
  const base = new Date(`${isoDate}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function invoiceGrossCents(invoice: LexwareInvoice): number | null {
  const gross = invoice.totalPrice?.totalGrossAmount;
  if (gross === undefined) return null;
  try {
    return decimalToCents(gross);
  } catch (error) {
    if (error instanceof MoneyConversionError) return null;
    throw error;
  }
}

function invoiceNetCents(invoice: LexwareInvoice): number | null {
  const net = invoice.totalPrice?.totalNetAmount;
  if (net === undefined) return null;
  try {
    return decimalToCents(net);
  } catch (error) {
    if (error instanceof MoneyConversionError) return null;
    throw error;
  }
}

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
    /** Phase 10: nur beim Provider „lexware“ nötig (zweiphasiger Pfad). */
    private readonly lexware?: LexwareTransferDeps,
    /**
     * Phase 11 (Order §7): Zahlungsstatus-Listener (Gutschein-Trigger A),
     * aufgerufen NACH dem Commit – nie innerhalb der Transaktion. Keine
     * Gutscheinlogik hier; die Listener reihen nur Jobs ein.
     */
    private readonly paymentStatusListeners: readonly PaymentStatusListener[] = [],
  ) {}

  /** Listener nach Commit benachrichtigen; Fehler dürfen den Aufrufer nicht stören. */
  private async notifyPaymentStatus(
    row: AccountingTransferRow,
    status: 'open' | 'paid' | 'overdue',
  ): Promise<void> {
    for (const listener of this.paymentStatusListeners) {
      try {
        await listener.paymentStatusChanged({
          transferId: row.id,
          settlementId: row.settlementId,
          cancellationId: row.cancellationId,
          status,
        });
      } catch {
        // Listener protokollieren selbst; der Zahlungsstatus ist bereits festgeschrieben.
      }
    }
  }

  get provider(): AccountingGateway['provider'] {
    return this.gateway.provider;
  }

  /** Lexware-Abhängigkeiten (z. B. für Rechnungsdatei-Streaming) – null ohne Lexware-Provider. */
  get lexwareDeps(): LexwareTransferDeps | null {
    return this.gateway.provider === 'lexware' && this.lexware !== undefined ? this.lexware : null;
  }

  /**
   * Transfer-Blocker für die Views (Vertrag §6) – identisch mit Phase 1 des
   * Zweiphasenpfads, ohne externen Aufruf. Ohne Lexware-Provider: keine.
   */
  async readiness(payload: AccountingPayload, customerId: string): Promise<ReadinessBlocker[]> {
    const deps = this.lexwareDeps;
    if (deps === null) return [];
    const readiness = await assessTransferReadiness({
      config: deps.context.config,
      lexware: deps.context,
      connection: deps.connection,
      taxConfig: deps.taxConfig,
      payload,
      customerId,
    });
    return readiness.blockers;
  }

  async invoiceMapping(transferId: string): Promise<LexwareInvoiceMappingRow | null> {
    const rows = await this.db
      .select()
      .from(lexwareInvoiceMappings)
      .where(eq(lexwareInvoiceMappings.accountingTransferId, transferId));
    return rows[0] ?? null;
  }

  invoiceDeeplink(lexwareInvoiceId: string): string | null {
    const deps = this.lexwareDeps;
    return deps === null ? null : lexwareInvoiceDeeplink(deps.context.appBaseUrl, lexwareInvoiceId);
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
    hooks: TransferHooks,
    now = new Date(),
  ): Promise<ExecuteTransferResult> {
    if (this.gateway.provider === 'lexware') {
      return this.executeTwoPhase(transferId, hooks, now);
    }
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
        return { outcome: 'failed', row: failedRow, errorCode: code, transient: true };
      }
    });
  }

  // ── Phase 10: zweiphasiger Lexware-Transfer (Vertrag §6, Order §§32/34/35/59/60/64) ──

  /**
   * Phase 1 (kurze Tx, FOR UPDATE): Zustand prüfen, Recheck, Readiness-
   * Blocker ohne externen Aufruf, Provider-Snapshot v2 einfrieren, Mapping
   * anlegen, Zeile beanspruchen. Phase 2 (OHNE DB-Sperre): Kontakt-Sync,
   * Recovery bei unbekanntem Ergebnis, POST invoice?finalize=true, GET
   * invoice, GET payment. Phase 3 (kurze Tx, FOR UPDATE): Ergebnis
   * festschreiben (Erfolg, Fehler, outcome_unknown, attention) + Hooks.
   */
  async executeTwoPhase(
    transferId: string,
    hooks: TransferHooks,
    now = new Date(),
  ): Promise<ExecuteTransferResult> {
    const deps = this.lexware;
    if (deps === undefined) {
      return this.failWithoutExternalCall(transferId, hooks, 'LEXWARE_NOT_CONFIGURED', now);
    }
    const phase1 = await this.claimAndFreeze(deps, transferId, hooks, now);
    if (phase1.kind === 'done') return phase1.result;

    const client = deps.context.client;
    if (client === null) {
      return this.commitResult(
        deps,
        phase1,
        {
          kind: 'failed',
          code: 'LEXWARE_NOT_CONFIGURED',
          transient: false,
          contactId: null,
          recoveryResolved: false,
        },
        hooks,
        now,
      );
    }
    const phase2 = await this.callLexware(deps, client, phase1, now);
    if (phase2.kind === 'failed' && phase2.code === 'LEXWARE_UNAUTHORIZED') {
      await deps.connection.markDisconnected('LEXWARE_UNAUTHORIZED');
    }
    return this.commitResult(deps, phase1, phase2, hooks, now);
  }

  /** Fehlschlag ohne jeden externen Aufruf (z. B. Blocker) – Status failed, Hook, kein Retry-Zwang. */
  private async failWithoutExternalCall(
    transferId: string,
    hooks: TransferHooks,
    code: string,
    now: Date,
  ): Promise<ExecuteTransferResult> {
    return this.db.transaction(async (tx) => {
      const row = await this.lockRow(tx, transferId);
      if (row.status === 'succeeded') return { outcome: 'already_succeeded', row };
      const updated = await tx
        .update(accountingTransfers)
        .set({
          status: row.status === 'outcome_unknown' ? 'outcome_unknown' : 'failed',
          attempts: row.attempts + 1,
          lastErrorCode: code,
          updatedAt: now,
        })
        .where(eq(accountingTransfers.id, row.id))
        .returning();
      const failedRow = updated[0] ?? row;
      if (hooks.onFailure !== undefined) await hooks.onFailure(tx, failedRow, code);
      return { outcome: 'failed', row: failedRow, errorCode: code, transient: false };
    });
  }

  private async lockRow(
    tx: DatabaseTransaction,
    transferId: string,
  ): Promise<AccountingTransferRow> {
    const locked = await tx
      .select()
      .from(accountingTransfers)
      .where(eq(accountingTransfers.id, transferId))
      .for('update');
    const row = locked[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Übertragung nicht gefunden.');
    return row;
  }

  private async claimAndFreeze(
    deps: LexwareTransferDeps,
    transferId: string,
    hooks: TransferHooks,
    now: Date,
  ): Promise<Phase1> {
    return this.db.transaction(async (tx): Promise<Phase1> => {
      const row = await this.lockRow(tx, transferId);
      if (row.status === 'succeeded') {
        return { kind: 'done', result: { outcome: 'already_succeeded', row } };
      }
      if (row.status === 'attention') {
        // Manuelle Buchhaltungsprüfung – kein automatischer zweiter Versuch, kein zweiter Create.
        return {
          kind: 'done',
          result: {
            outcome: 'failed',
            row,
            errorCode: row.attentionCode ?? 'ATTENTION',
            transient: false,
          },
        };
      }
      const claimActive =
        row.status === 'in_progress' &&
        row.claimExpiresAt !== null &&
        row.claimExpiresAt.getTime() > now.getTime();
      if (claimActive && row.claimExpiresAt !== null) {
        // Ein anderer Aufrufer (Doppelklick/Worker) ist gerade dabei – nichts doppelt anstoßen.
        return { kind: 'done', result: { outcome: 'skipped', row, retryAt: row.claimExpiresAt } };
      }
      if (!(await hooks.recheck(tx, row))) {
        return { kind: 'done', result: { outcome: 'skipped', row } };
      }
      const payload = row.snapshot as AccountingPayload;
      const needsRecovery = row.status === 'outcome_unknown' || row.status === 'in_progress';
      const attempts = row.attempts + 1;

      const fail = async (code: string, status: 'failed' | 'attention' = 'failed') => {
        // Recovery-Pflicht geht nie verloren: outcome_unknown und abgelaufene
        // in_progress-Claims bleiben „unbekannt“, bis eine Recovery abgeschlossen ist.
        const keepUnknown = needsRecovery && status === 'failed';
        const updated = await tx
          .update(accountingTransfers)
          .set({
            status: keepUnknown ? 'outcome_unknown' : status,
            attempts,
            lastErrorCode: code,
            ...(status === 'attention' ? { attentionCode: code, attentionAt: now } : {}),
            updatedAt: now,
          })
          .where(eq(accountingTransfers.id, row.id))
          .returning();
        const failedRow = updated[0] ?? row;
        if (hooks.onFailure !== undefined) await hooks.onFailure(tx, failedRow, code);
        return {
          kind: 'done' as const,
          result: {
            outcome: 'failed' as const,
            row: failedRow,
            errorCode: code,
            transient: false,
          },
        };
      };

      // Disabled-/Mock-Übernahme (Order §35): nur ohne externe Referenz und mit
      // widerspruchsfreiem Snapshot (Idempotenzschlüssel/Ziel unverändert; der
      // Phase-9-Hash ist über jsonb nicht reproduzierbar, da jsonb Schlüssel umsortiert).
      if (row.provider !== 'lexware') {
        const target = row.kind === 'settlement' ? row.settlementId : row.cancellationId;
        if (
          row.externalReference !== null ||
          payload.idempotencyKey !== row.idempotencyKey ||
          payload.sourceId !== target
        ) {
          return fail('SNAPSHOT_MISMATCH', 'attention');
        }
      }

      const readiness = await assessTransferReadiness({
        config: deps.context.config,
        lexware: deps.context,
        connection: deps.connection,
        taxConfig: deps.taxConfig,
        payload,
        customerId: payload.customer.customerId,
        executor: tx,
      });
      const blocker = readiness.blockers[0];
      if (blocker !== undefined || readiness.organizationId === null) {
        return fail(blocker?.code ?? 'LEXWARE_NOT_CONNECTED');
      }
      const organizationId = readiness.organizationId;

      // Provider-Snapshot v2: erstmalig einfrieren, bei Retry unverändert wiederverwenden.
      let snapshot: ProviderSnapshotV2;
      if (isProviderSnapshotV2(row.providerSnapshot)) {
        snapshot = row.providerSnapshot;
      } else {
        try {
          snapshot = buildProviderSnapshot({
            payload,
            taxConfig: readiness.taxConfig,
            transferMarker: transferMarkerFor(row.idempotencyKey),
            now,
          });
        } catch (error) {
          if (error instanceof InvoiceBuildError) return fail(error.code);
          throw error;
        }
      }
      const snapshotHash = hashProviderSnapshot(snapshot);
      if (row.providerSnapshotHash !== null && row.providerSnapshotHash !== snapshotHash) {
        return fail('SNAPSHOT_MISMATCH', 'attention');
      }

      const mappingRows = await tx
        .insert(lexwareInvoiceMappings)
        .values({
          accountingTransferId: row.id,
          organizationId,
          transferMarker: snapshot.transferMarker,
          expectedGrossCents: snapshot.expectedGrossCents,
          voucherDate: snapshot.voucherDate.slice(0, 10),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: lexwareInvoiceMappings.accountingTransferId,
          set: { updatedAt: now },
        })
        .returning();
      const mapping = mappingRows[0];
      if (mapping === undefined) throw new AuthError('CONFLICT', 'Rechnungs-Mapping fehlt.');

      const updated = await tx
        .update(accountingTransfers)
        .set({
          status: 'in_progress',
          provider: 'lexware',
          attempts,
          providerSnapshot: snapshot,
          providerSnapshotHash: snapshotHash,
          claimedAt: now,
          claimedBy: deps.workerId,
          claimExpiresAt: new Date(now.getTime() + TRANSFER_CLAIM_MS),
          updatedAt: now,
        })
        .where(eq(accountingTransfers.id, row.id))
        .returning();
      const claimed = updated[0] ?? row;
      deps.context.logger.info(
        {
          lexware: {
            action: 'transfer_claim',
            transferId: row.id,
            previousStatus: row.status,
            recovery: needsRecovery,
          },
        },
        'Lexware-Transfer beansprucht',
      );
      return {
        kind: 'proceed',
        row: claimed,
        payload,
        snapshot,
        mapping,
        organizationId,
        needsRecovery,
      };
    });
  }

  /** Phase 2 – ausschließlich HTTP, keine DB-Sperre. Alle Fehler werden klassifiziert, nie geworfen. */
  private async callLexware(
    deps: LexwareTransferDeps,
    client: LexwareClient,
    phase1: Extract<Phase1, { kind: 'proceed' }>,
    now: Date,
  ): Promise<Phase2> {
    const { payload, snapshot, mapping } = phase1;
    let contactId: string | null = null;
    let createdInvoiceId: string | null = null;
    let recoveryResolved = false;
    try {
      const contact = await deps.contacts.resolveForTransfer(
        payload.customer.customerId,
        phase1.organizationId,
        now,
      );
      switch (contact.status) {
        case 'linked':
        case 'created':
          contactId = contact.lexwareContactId;
          break;
        case 'review_required':
          return {
            kind: 'failed',
            code: 'CONTACT_REVIEW_REQUIRED',
            transient: false,
            contactId: null,
            recoveryResolved: false,
          };
        case 'in_progress':
          return {
            kind: 'failed',
            code: 'CONTACT_SYNC_IN_PROGRESS',
            transient: true,
            contactId: null,
            recoveryResolved: false,
          };
        case 'create_unknown':
          return {
            kind: 'failed',
            code: 'LEXWARE_TIMEOUT',
            transient: true,
            contactId: null,
            recoveryResolved: false,
          };
        default:
          return {
            kind: 'failed',
            code: 'CONTACT_REVIEW_REQUIRED',
            transient: false,
            contactId: null,
            recoveryResolved: false,
          };
      }

      let invoiceId: string | null = null;
      if (phase1.needsRecovery || mapping.lexwareInvoiceId !== null) {
        const recovered = await this.recoverInvoice(client, snapshot, mapping, contactId);
        if (recovered.kind === 'ambiguous') {
          return {
            kind: 'attention',
            code: 'RECOVERY_AMBIGUOUS',
            invoice: null,
            payment: null,
            contactId,
          };
        }
        if (recovered.kind === 'found') invoiceId = recovered.invoiceId;
        recoveryResolved = true;
      }

      if (invoiceId === null) {
        const body = buildInvoiceBody(snapshot, payload, contactId);
        try {
          invoiceId = (await client.createInvoice(body, true)).data.id;
        } catch (error) {
          if (
            error instanceof LexwareApiError &&
            (error.kind === 'timeout' || error.kind === 'network')
          ) {
            // Request gesendet, keine Antwort: NIE erneut POSTen (Order §32).
            return { kind: 'unknown', code: error.code, invoiceId: null, contactId };
          }
          throw error;
        }
      }
      // Ab hier existiert die Rechnung: JEDER Fehler ⇒ outcome_unknown mit bekannter ID.
      createdInvoiceId = invoiceId;

      const invoice: LexwareInvoice = (await client.getInvoice(invoiceId)).data;
      if (
        (invoice.voucherStatus !== 'open' && invoice.voucherStatus !== 'paid') ||
        invoice.voucherNumber === undefined ||
        invoice.voucherNumber === ''
      ) {
        // Draft trotz finalize / unerwarteter Status ⇒ manuelle Prüfung, nie „succeeded“.
        return {
          kind: 'attention',
          code: 'INVOICE_UNEXPECTED_STATUS',
          invoice,
          payment: null,
          contactId,
        };
      }
      const gross = invoiceGrossCents(invoice);
      const net = invoiceNetCents(invoice);
      const netMismatch =
        snapshot.taxType !== 'gross' && net !== null && net !== snapshot.expectedNetCents;
      if (gross === null || gross !== snapshot.expectedGrossCents || netMismatch) {
        deps.context.logger.warn(
          {
            lexware: {
              action: 'total_mismatch',
              transferId: phase1.row.id,
              expectedGrossCents: snapshot.expectedGrossCents,
              actualGrossCents: gross,
            },
          },
          'Lexware-Summe weicht von der erwarteten Summe ab',
        );
        return { kind: 'attention', code: 'TOTAL_MISMATCH', invoice, payment: null, contactId };
      }

      let payment: LexwarePayment | null = null;
      try {
        payment = (await client.getPayment(invoiceId)).data;
      } catch (error) {
        // Zahlungsinformation ist nachholbar (Webhook/Reconcile) – kein Grund für einen zweiten Create.
        if (!(error instanceof LexwareApiError)) throw error;
        payment = null;
      }
      return { kind: 'success', invoice, payment, contactId };
    } catch (error) {
      const code =
        error instanceof LexwareApiError
          ? error.code
          : error instanceof AuthError
            ? error.code
            : 'UNKNOWN';
      if (createdInvoiceId !== null) {
        // Rechnung wurde angelegt – Nachlesen scheiterte (auch 401/403/404): nie neu anlegen.
        return { kind: 'unknown', code, invoiceId: createdInvoiceId, contactId };
      }
      if (error instanceof LexwareApiError) {
        return {
          kind: 'failed',
          code,
          transient: error.transient,
          contactId,
          recoveryResolved,
        };
      }
      if (error instanceof AuthError) {
        return { kind: 'failed', code, transient: false, contactId, recoveryResolved };
      }
      deps.context.logger.error(
        {
          lexware: { action: 'transfer', transferId: phase1.row.id },
          error: error instanceof Error ? error.name : 'unknown',
        },
        'Unerwarteter Fehler im Lexware-Transfer',
      );
      return { kind: 'failed', code: 'UNKNOWN', transient: true, contactId, recoveryResolved };
    }
  }

  /**
   * Unknown-Outcome-Recovery (Order §32): bekannte Rechnungs-ID direkt
   * lesen, sonst Belegliste im engen Fenster (Kontakt, voucherDate ±1 Tag)
   * und Kandidaten über Marker + Summe prüfen. Genau einer ⇒ verbinden,
   * keiner ⇒ Create erlaubt, mehrere/unklar ⇒ attention.
   */
  private async recoverInvoice(
    client: LexwareClient,
    snapshot: ProviderSnapshotV2,
    mapping: LexwareInvoiceMappingRow,
    contactId: string,
  ): Promise<{ kind: 'found'; invoiceId: string } | { kind: 'none' } | { kind: 'ambiguous' }> {
    const matches = (invoice: LexwareInvoice): boolean =>
      remarkContainsMarker(invoice.remark, snapshot.transferMarker) &&
      invoiceGrossCents(invoice) === snapshot.expectedGrossCents;

    if (mapping.lexwareInvoiceId !== null) {
      try {
        const invoice = (await client.getInvoice(mapping.lexwareInvoiceId)).data;
        return matches(invoice) ? { kind: 'found', invoiceId: invoice.id } : { kind: 'ambiguous' };
      } catch (error) {
        if (error instanceof LexwareApiError && error.kind === 'not_found')
          return { kind: 'ambiguous' };
        throw error;
      }
    }
    const voucherDay = snapshot.voucherDate.slice(0, 10);
    const page = (
      await client.voucherlist({
        voucherType: 'invoice',
        voucherStatus: 'any',
        contactId,
        voucherDateFrom: shiftIsoDate(voucherDay, -1),
        voucherDateTo: shiftIsoDate(voucherDay, 1),
        size: 250,
      })
    ).data;
    const found: string[] = [];
    if (page.content.length > RECOVERY_CANDIDATE_LIMIT) return { kind: 'ambiguous' };
    for (const entry of page.content) {
      if (entry.voucherType !== 'invoice') continue;
      const invoice = (await client.getInvoice(entry.id)).data;
      if (matches(invoice)) found.push(invoice.id);
    }
    const first = found[0];
    if (found.length === 1 && first !== undefined) return { kind: 'found', invoiceId: first };
    return found.length === 0 ? { kind: 'none' } : { kind: 'ambiguous' };
  }

  /** Phase 3 – Ergebnis festschreiben (kurze Tx, FOR UPDATE). */
  private async commitResult(
    deps: LexwareTransferDeps,
    phase1: Extract<Phase1, { kind: 'proceed' }>,
    phase2Input: Phase2,
    hooks: TransferHooks,
    now: Date,
  ): Promise<ExecuteTransferResult> {
    // Phase 11: bereits bezahlte Rechnung beim Anlegen ⇒ Listener NACH dem Commit.
    const afterCommit: { paid: AccountingTransferRow | null } = { paid: null };
    const result = await this.db.transaction(async (tx): Promise<ExecuteTransferResult> => {
      let phase2 = phase2Input;
      const row = await this.lockRow(tx, phase1.row.id);
      if (row.status === 'succeeded') return { outcome: 'already_succeeded', row };
      const clearClaim = { claimedAt: null, claimedBy: null, claimExpiresAt: null };
      const contactPatch = phase2.contactId === null ? {} : { lexwareContactId: phase2.contactId };
      const mappingRows = await tx
        .select()
        .from(lexwareInvoiceMappings)
        .where(eq(lexwareInvoiceMappings.id, phase1.mapping.id));
      const currentMapping = mappingRows[0] ?? phase1.mapping;
      // Claim-Fencing: hat ein anderer Worker die Zeile inzwischen beansprucht
      // (abgelaufener Claim), darf ein eigener Erfolg nicht still verworfen werden.
      const claimLost =
        row.claimedBy !== phase1.row.claimedBy ||
        (row.claimedAt?.getTime() ?? null) !== (phase1.row.claimedAt?.getTime() ?? null);
      if (phase2.kind === 'success') {
        const knownInvoiceId = currentMapping.lexwareInvoiceId;
        const conflicting = knownInvoiceId !== null && knownInvoiceId !== phase2.invoice.id;
        if (claimLost || conflicting) {
          deps.context.logger.warn(
            {
              lexware: {
                action: 'transfer_claim_conflict',
                transferId: row.id,
                invoiceId: phase2.invoice.id,
                knownInvoiceId,
                claimedBy: row.claimedBy,
                workerId: deps.workerId,
              },
            },
            'Lexware-Transfer: Claim-Konflikt – manueller Abgleich erforderlich',
          );
          phase2 = {
            kind: 'attention',
            code: 'RECOVERY_AMBIGUOUS',
            invoice: conflicting ? null : phase2.invoice,
            payment: null,
            contactId: phase2.contactId,
          };
        }
      }

      if (phase2.kind === 'success') {
        const { invoice, payment } = phase2;
        const normalized = this.normalizedStatus(invoice, payment, now);
        const paymentStatus = normalized === 'attention' ? 'open' : normalized;
        const voucherNumber = invoice.voucherNumber ?? invoice.id;
        await tx
          .update(lexwareInvoiceMappings)
          .set({
            ...contactPatch,
            lexwareInvoiceId: invoice.id,
            voucherNumber,
            voucherStatus: invoice.voucherStatus,
            dueDate: invoice.dueDate?.slice(0, 10) ?? null,
            openAmountCents: payment === null ? null : decimalToCents(payment.openAmount),
            paymentStatus,
            paidDate: payment?.paidDate?.slice(0, 10) ?? null,
            deliveryStatus: 'pending',
            lastSyncedAt: now,
            attentionCode: null,
            updatedAt: now,
          })
          .where(eq(lexwareInvoiceMappings.id, phase1.mapping.id));
        const updated = await tx
          .update(accountingTransfers)
          .set({
            status: 'succeeded',
            provider: 'lexware',
            lastErrorCode: null,
            externalReference: voucherNumber,
            paymentStatus,
            transferredAt: now,
            attentionCode: null,
            attentionAt: null,
            ...clearClaim,
            updatedAt: now,
          })
          .where(eq(accountingTransfers.id, row.id))
          .returning();
        const successRow = updated[0] ?? row;
        await hooks.onSuccess(tx, successRow, {
          provider: 'lexware',
          externalReference: voucherNumber,
          paymentStatus: 'open',
        });
        await this.mirrorDelivery(tx, successRow, now, paymentStatus);
        if (paymentStatus === 'paid') afterCommit.paid = successRow;
        deps.context.logger.info(
          { lexware: { action: 'transfer_success', transferId: row.id, invoiceId: invoice.id } },
          'Lexware-Rechnung erstellt',
        );
        return { outcome: 'succeeded', row: successRow };
      }

      if (phase2.kind === 'unknown') {
        await tx
          .update(lexwareInvoiceMappings)
          .set({
            ...contactPatch,
            ...(phase2.invoiceId === null ? {} : { lexwareInvoiceId: phase2.invoiceId }),
            updatedAt: now,
          })
          .where(eq(lexwareInvoiceMappings.id, phase1.mapping.id));
        const updated = await tx
          .update(accountingTransfers)
          .set({
            status: 'outcome_unknown',
            lastErrorCode: phase2.code,
            ...clearClaim,
            updatedAt: now,
          })
          .where(eq(accountingTransfers.id, row.id))
          .returning();
        const unknownRow = updated[0] ?? row;
        if (hooks.onFailure !== undefined) await hooks.onFailure(tx, unknownRow, phase2.code);
        deps.context.logger.warn(
          { lexware: { action: 'transfer_unknown', transferId: row.id, code: phase2.code } },
          'Lexware-Transfer ohne Antwort – Recovery vor dem nächsten Versuch',
        );
        return { outcome: 'failed', row: unknownRow, errorCode: phase2.code, transient: true };
      }

      if (phase2.kind === 'attention') {
        const invoice = phase2.invoice;
        await tx
          .update(lexwareInvoiceMappings)
          .set({
            ...contactPatch,
            ...(invoice === null
              ? {}
              : {
                  lexwareInvoiceId: invoice.id,
                  voucherNumber: invoice.voucherNumber ?? invoice.id,
                  voucherStatus: invoice.voucherStatus,
                  dueDate: invoice.dueDate?.slice(0, 10) ?? null,
                }),
            attentionCode: phase2.code,
            lastSyncedAt: now,
            updatedAt: now,
          })
          .where(eq(lexwareInvoiceMappings.id, phase1.mapping.id));
        const updated = await tx
          .update(accountingTransfers)
          .set({
            status: 'attention',
            lastErrorCode: phase2.code,
            attentionCode: phase2.code,
            attentionAt: now,
            ...clearClaim,
            updatedAt: now,
          })
          .where(eq(accountingTransfers.id, row.id))
          .returning();
        const attentionRow = updated[0] ?? row;
        if (hooks.onFailure !== undefined) await hooks.onFailure(tx, attentionRow, phase2.code);
        return { outcome: 'failed', row: attentionRow, errorCode: phase2.code, transient: false };
      }

      // failed (transient oder permanent) – vor jedem Create, daher kein Unknown-Zustand.
      if (phase2.contactId !== null) {
        await tx
          .update(lexwareInvoiceMappings)
          .set({ ...contactPatch, updatedAt: now })
          .where(eq(lexwareInvoiceMappings.id, phase1.mapping.id));
      }
      // Recovery-Pflicht bleibt bestehen, bis eine Recovery „kein Treffer“/„verbunden“ ergab.
      const keepUnknown = phase1.needsRecovery && !phase2.recoveryResolved;
      const updated = await tx
        .update(accountingTransfers)
        .set({
          status: keepUnknown ? 'outcome_unknown' : 'failed',
          lastErrorCode: phase2.code,
          ...clearClaim,
          updatedAt: now,
        })
        .where(eq(accountingTransfers.id, row.id))
        .returning();
      const failedRow = updated[0] ?? row;
      if (hooks.onFailure !== undefined) await hooks.onFailure(tx, failedRow, phase2.code);
      deps.context.logger.warn(
        {
          lexware: {
            action: 'transfer_failed',
            transferId: row.id,
            code: phase2.code,
            transient: phase2.transient,
          },
        },
        'Lexware-Transfer fehlgeschlagen',
      );
      return {
        outcome: 'failed',
        row: failedRow,
        errorCode: phase2.code,
        transient: phase2.transient,
      };
    });
    if (afterCommit.paid !== null) await this.notifyPaymentStatus(afterCommit.paid, 'paid');
    return result;
  }

  private normalizedStatus(
    invoice: LexwareInvoice,
    payment: LexwarePayment | null,
    now: Date,
  ): 'open' | 'paid' | 'overdue' | 'attention' {
    let openAmountCents: number | undefined;
    if (payment !== null) {
      try {
        openAmountCents = decimalToCents(payment.openAmount);
      } catch {
        openAmountCents = undefined;
      }
    }
    return normalizeLexwarePaymentStatus({
      voucherStatus: invoice.voucherStatus,
      paymentStatus: payment?.paymentStatus,
      openAmountCents,
      dueDate: invoice.dueDate ?? null,
      todayBerlinIso: berlinTodayIso(now),
    });
  }

  /** Versandstatus 'pending' (nie 'sent', Order §40) und ggf. abweichenden Zahlungsstatus spiegeln. */
  private async mirrorDelivery(
    tx: DatabaseTransaction,
    row: AccountingTransferRow,
    now: Date,
    paymentStatus: 'open' | 'paid' | 'overdue',
  ): Promise<void> {
    if (row.settlementId !== null) {
      await tx
        .update(settlements)
        .set({ invoiceDeliveryStatus: 'pending', paymentStatus, updatedAt: now })
        .where(eq(settlements.id, row.settlementId));
    }
    if (row.cancellationId !== null) {
      await tx
        .update(cancellations)
        .set({
          invoiceDeliveryStatus: 'pending',
          paymentStatus,
          financeStatus: paymentStatus === 'paid' ? 'paid' : 'invoice_open',
          updatedAt: now,
        })
        .where(eq(cancellations.id, row.cancellationId));
    }
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
    const updatedRow = await this.db.transaction(async (tx) => {
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
    // Phase 11: Trigger A nach dem Commit (Gutschein-Prüfjob bei „bezahlt“).
    await this.notifyPaymentStatus(updatedRow, status);
    return updatedRow;
  }
}
