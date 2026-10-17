import { lexwareInvoiceMappings, type Database } from '@mietroyal/database';
import { and, asc, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import type { AccountingTransferService } from '../accounting/transfer-service.ts';
import type { LexwareConnectionService } from './connection-service.ts';
import type { LexwareContext } from './context.ts';
import { LexwareApiError } from './errors.ts';
import { syncLexwareInvoice } from './invoice-sync.ts';

/**
 * Reconciliation (Order §53, Vertrag §3): nur gemappte Rechnungen mit
 * Zahlungsstatus open/overdue oder ohne Attention und noch nicht bezahlt
 * (voucherStatus ≠ paid); max. 100 je Lauf, Requests laufen über den
 * zentralen Throttle des Clients. Keine Historie, KEIN permanentes Polling –
 * Aufruf nur per `pnpm lexware:reconcile` oder Adminaktion.
 */
export const LEXWARE_RECONCILE_BATCH_LIMIT = 100;
/** Adminaktion: kleiner Batch, damit die Anfrage kurz bleibt (CLI darf 100). */
export const LEXWARE_RECONCILE_ADMIN_LIMIT = 25;
/** Attention-Codes, die ein Mapping dauerhaft aus dem Abgleich nehmen (manuelle Prüfung). */
const EXCLUDED_ATTENTION_CODES = ['INVOICE_VOIDED', 'INVOICE_MISSING'];
const RECONCILE_LOCK_KEY = 'lexware-reconcile';

export class LexwareReconcileRunningError extends Error {
  readonly code = 'RECONCILE_RUNNING';
  constructor() {
    super('Ein Lexware-Abgleich läuft bereits.');
    this.name = 'LexwareReconcileRunningError';
  }
}

export interface LexwareReconcileResult {
  checked: number;
  updated: number;
  attention: number;
  /** Zusätzlich: Mappings, deren Abgleich mit einem Lexware-Fehler endete (nur Zähler). */
  failed: number;
}

export class LexwareReconcileService {
  constructor(
    private readonly lexware: LexwareContext,
    private readonly db: Database,
    private readonly transfers: AccountingTransferService,
    private readonly connection: LexwareConnectionService,
  ) {}

  /** Kandidaten-IDs in stabiler Reihenfolge (älteste Synchronisation zuerst). */
  async candidates(limit = LEXWARE_RECONCILE_BATCH_LIMIT): Promise<string[]> {
    const rows = await this.db
      .select({ id: lexwareInvoiceMappings.id })
      .from(lexwareInvoiceMappings)
      .where(
        and(
          isNotNull(lexwareInvoiceMappings.lexwareInvoiceId),
          or(
            isNull(lexwareInvoiceMappings.attentionCode),
            notInArray(lexwareInvoiceMappings.attentionCode, EXCLUDED_ATTENTION_CODES),
          ),
          or(
            inArray(lexwareInvoiceMappings.paymentStatus, ['open', 'overdue']),
            and(
              isNull(lexwareInvoiceMappings.attentionCode),
              or(
                isNull(lexwareInvoiceMappings.voucherStatus),
                ne(lexwareInvoiceMappings.voucherStatus, 'paid'),
              ),
            ),
          ),
        ),
      )
      .orderBy(
        sql`${lexwareInvoiceMappings.lastSyncedAt} ASC NULLS FIRST`,
        asc(lexwareInvoiceMappings.createdAt),
      )
      .limit(limit);
    return rows.map((r) => r.id);
  }

  /**
   * `exclusive`: parallele Läufe (z. B. Doppelklick in der Adminansicht) werden
   * über einen Advisory-Lock abgelehnt (LexwareReconcileRunningError). Der Lock
   * hält nur eine eigene Verbindung – keine Business-Zeile ist gesperrt.
   */
  async run(
    now = new Date(),
    limit = LEXWARE_RECONCILE_BATCH_LIMIT,
    options: { exclusive?: boolean } = {},
  ): Promise<LexwareReconcileResult> {
    if (options.exclusive !== true) return this.runBatch(now, limit);
    return this.db.transaction(async (tx) => {
      const locked = await tx.execute(
        sql`SELECT pg_try_advisory_xact_lock(hashtext(${RECONCILE_LOCK_KEY})) AS locked`,
      );
      const row = locked.rows[0] as { locked?: unknown } | undefined;
      if (row?.locked !== true) throw new LexwareReconcileRunningError();
      return this.runBatch(now, limit);
    });
  }

  private async runBatch(now: Date, limit: number): Promise<LexwareReconcileResult> {
    await this.connection.assertReady();
    const ids = await this.candidates(limit);
    const result: LexwareReconcileResult = { checked: 0, updated: 0, attention: 0, failed: 0 };
    for (const id of ids) {
      try {
        const outcome = await syncLexwareInvoice(this.lexware, this.db, this.transfers, id, now);
        result.checked += 1;
        if (outcome.outcome === 'updated') result.updated += 1;
        if (outcome.outcome === 'attention') result.attention += 1;
      } catch (error) {
        if (error instanceof LexwareApiError) {
          if (error.kind === 'unauthorized') {
            await this.connection.markDisconnected(error.code);
            throw error;
          }
          result.failed += 1;
          this.lexware.logger.warn(
            { lexware: { action: 'reconcile', mappingId: id, code: error.code } },
            'Lexware-Abgleich für Mapping fehlgeschlagen',
          );
          // Dauerhafte Störung (5xx/Timeout) nicht 100-mal wiederholen.
          if (error.transient && result.failed >= 3) break;
          continue;
        }
        throw error;
      }
    }
    this.lexware.logger.info(
      { lexware: { action: 'reconcile', ...result } },
      'Lexware-Statusabgleich abgeschlossen',
    );
    return result;
  }
}
