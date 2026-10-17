import {
  bookingAdvancePayments,
  bookingSecurityDeposits,
  bookings,
  deliveryNoteItems,
  deliveryNotes,
  integrationJobs,
  machineDamages,
  machines,
  missingAccessoryCases,
  processes,
  rentalReturns,
  returnInventoryItems,
  returnMachines,
  damagePhotos,
  settlementClarifications,
  settlementCustomerNotices,
  settlementLines,
  settlements,
  type Booking,
  type Database,
  type DatabaseExecutor,
  type DatabaseTransaction,
  type Process,
} from '@mietroyal/database';
import {
  computeSettlementTotals,
  customerNoticeWaitUntil,
  SETTLEMENT_CREDIT_LINE_TYPES,
  type SettlementLineType,
} from '@mietroyal/domain';
import type { JobQueue, JobRunnerLogger } from '@mietroyal/integrations';
import type { PermissionKey } from '@mietroyal/permissions';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  SETTLEMENT_ACCOUNTING_TRANSFER_JOB_TYPE,
  settlementTransferIdempotencyKey,
  type AccountingPayload,
  type AccountingPayloadLine,
  type AccountingTransferResult,
} from '../accounting/gateway.ts';
import type {
  AccountingTransferRow,
  AccountingTransferService,
} from '../accounting/transfer-service.ts';
import { AuthError } from '../auth/service.ts';
import { buildAccountingBlock, type AccountingBlockView } from '../lexware/transfer-readiness.ts';
import type { ProcessService } from '../crm/process-service.ts';
import { ACCESSORY_LABELS } from '../returns/return-service.ts';
import { SEVERITY_LABELS } from '../returns/damage-service.ts';
import type { SettlementNoticeGateway } from './notice-gateway.ts';
import { buildCustomerNoticeText, type NoticePosition } from './notice-text.ts';

/**
 * Zentrale Abrechnungsgrenze (Phase-9-Vorgabe §§2–48). Die Abrechnung
 * entsteht ausschließlich aus eingefrorenen Fakten (Booking-Snapshot,
 * finaler Lieferschein, Phase-7-Rückgabefakten, Schaden-/Fehlteil-
 * entscheidungen, manuelle Positionen, erfasste Zahlungen); alle Beträge
 * sind Integer-Cent, die Summen kommen aus @mietroyal/domain.
 *
 * Nebenläufigkeit (§82): Jede Mutation sperrt die Settlement-Zeile
 * (SELECT … FOR UPDATE), prüft die optimistische Version und leitet danach
 * Positionen, Klärungen, Summen und Status in derselben Transaktion neu ab
 * (`rebuildWithin`). Ab der Vorbereitung des Buchhaltungstransfers
 * (accounting_transfer_id gesetzt) und erst recht nach erfolgreichem
 * Transfer (locked_at) ist die Abrechnung unveränderlich (§41).
 */

export type SettlementRow = typeof settlements.$inferSelect;
export type SettlementLineRow = typeof settlementLines.$inferSelect;
export type SettlementClarificationRow = typeof settlementClarifications.$inferSelect;
export type CustomerNoticeRow = typeof settlementCustomerNotices.$inferSelect;
export type AdvancePaymentRow = typeof bookingAdvancePayments.$inferSelect;
export type SecurityDepositRow = typeof bookingSecurityDeposits.$inferSelect;
export type SettlementStatus = SettlementRow['status'];

export type SettlementErrorReason =
  | 'SETTLEMENT_NOT_FOUND'
  | 'RETURN_NOT_FINALIZED'
  | 'SETTLEMENT_LOCKED'
  | 'TRANSFER_PREPARED'
  | 'VERSION_CONFLICT'
  | 'LINE_NOT_EDITABLE'
  | 'CLARIFICATION_RESOLVED'
  | 'CLARIFICATION_OPEN'
  | 'NOTICE_NOT_REQUIRED'
  | 'NOTICE_NOT_FOUND'
  | 'NOTICE_ALREADY_SENT'
  | 'NOTICE_RECIPIENT_MISSING'
  | 'NOTICE_NOT_CONFIGURED'
  | 'NOTICE_NOT_SENT'
  | 'CUSTOMER_RESPONSE_ALREADY_RECORDED'
  | 'NO_CUSTOMER_RESPONSE'
  | 'NOT_WAITING'
  | 'TRANSFER_NOT_READY'
  | 'ACCOUNTING_NOT_CONFIGURED'
  | 'ADVANCE_NOT_ACTIVE'
  | 'DEPOSIT_NOT_HELD'
  | 'DEPOSIT_EXCEEDS_HELD'
  | 'DEPOSIT_EXCEEDS_DUE';

/** Fachlicher Konflikt der Abrechnung – `reason` wird als Fehlercode nach außen gegeben. */
export class SettlementError extends AuthError {
  readonly reason: SettlementErrorReason;

  constructor(
    reason: SettlementErrorReason,
    message: string,
    code: 'CONFLICT' | 'NOT_FOUND' | 'VALIDATION' = 'CONFLICT',
  ) {
    super(code, message);
    this.name = 'SettlementError';
    this.reason = reason;
  }
}

export const SETTLEMENT_STATUS_LABELS: Record<SettlementStatus, string> = {
  preparing: 'In Vorbereitung',
  clarification_required: 'Klärung erforderlich',
  customer_notice_required: 'Kundeninformation erforderlich',
  customer_waiting: 'Kundenrückmeldung abwarten',
  ready_for_accounting: 'Bereit zur Buchhaltung',
  transferring: 'Übertragung geplant',
  transferred: 'An Buchhaltung übertragen',
  transfer_failed: 'Übertragung an Buchhaltung fehlgeschlagen – wird erneut versucht',
};

/** Fehlgeschlagener Transfer OHNE anstehenden Queue-Retry (z. B. manuell vorbereitet). */
export const TRANSFER_FAILED_MANUAL_LABEL =
  'Übertragung an Buchhaltung fehlgeschlagen – bitte manuell erneut übertragen.';

export const PAYMENT_STATUS_LABELS = {
  open: 'Offen',
  paid: 'Bezahlt',
  overdue: 'Überfällig',
} as const;

export const LINE_TYPE_LABELS: Record<SettlementLineType, string> = {
  machine_rental: 'Maschinenmiete',
  delivery: 'Lieferung',
  purchase: 'Kaufartikel',
  commission_consumption: 'Kommissionsartikel (Verbrauch)',
  discount: 'Rabatt',
  cleanup_fee: 'Reinigungsgebühr',
  damage_charge: 'Schadenkosten',
  missing_item_charge: 'Ersatzkosten Fehlteil',
  late_fee: 'Verspätungsgebühr',
  manual_charge: 'Nachbelastung',
  advance_payment_credit: 'Anzahlung',
  deposit_applied_credit: 'Angewendete Kaution',
};

export const CLARIFICATION_TYPE_LABELS: Record<SettlementClarificationRow['type'], string> = {
  damage_cost: 'Schadenkosten klären',
  missing_item_cost: 'Ersatzkosten Fehlteil klären',
  customer_notice: 'Kundeninformation prüfen',
  customer_response: 'Kundenrückmeldung prüfen',
};

export const OVERPAYMENT_HINT = 'Externe Rückzahlung/Verrechnung prüfen';
export const TRANSFER_LOCK_MESSAGE =
  'Die Abrechnung wurde an die Buchhaltung übertragen und ist unveränderlich.';
export const TRANSFER_PREPARED_MESSAGE = 'Übertragung vorbereitet – Beträge gesperrt.';

/** Positionstypen, die ausschließlich aus Fakten abgeleitet werden (nie manuell editierbar). */
const FACT_SOURCE_TYPES: readonly SettlementLineRow['sourceType'][] = [
  'booking_item',
  'booking_delivery',
  'booking_discount',
  'delivery_note_item',
  'return_inventory_item',
  'return_machine',
  'advance_payment',
  'security_deposit',
];
const EDITABLE_LINE_TYPES: readonly SettlementLineType[] = [
  'damage_charge',
  'missing_item_charge',
  'late_fee',
  'manual_charge',
];
const NOTICE_LINE_TYPES: readonly SettlementLineType[] = ['damage_charge', 'missing_item_charge'];
/** Klärungen, die jede Übertragung blockieren (§22). */
const BLOCKING_CLARIFICATION_TYPES: readonly SettlementClarificationRow['type'][] = [
  'damage_cost',
  'missing_item_cost',
  'customer_response',
];

export interface SettlementStatusInput {
  lockedAt: Date | null;
  accountingTransferId: string | null;
  lastTransferErrorCode: string | null;
  openBlockingClarifications: number;
  noticeRequired: boolean;
  noticeSentAt: Date | null;
  waitUntil: Date | null;
  releasedAt: Date | null;
  earlyReleasedAt: Date | null;
  now: Date;
}

/** Statusableitung (Vertrag §2) – rein, bei jeder Mutation neu berechnet, nie vom Client gesetzt. */
export function deriveSettlementStatus(input: SettlementStatusInput): SettlementStatus {
  if (input.lockedAt !== null) return 'transferred';
  if (input.accountingTransferId !== null) {
    return input.lastTransferErrorCode !== null ? 'transfer_failed' : 'transferring';
  }
  if (input.openBlockingClarifications > 0) return 'clarification_required';
  if (input.noticeRequired && input.noticeSentAt === null) return 'customer_notice_required';
  if (
    input.noticeRequired &&
    input.noticeSentAt !== null &&
    input.waitUntil !== null &&
    input.now.getTime() < input.waitUntil.getTime() &&
    input.earlyReleasedAt === null &&
    input.releasedAt === null
  ) {
    return 'customer_waiting';
  }
  return 'ready_for_accounting';
}

export interface SettlementLineView {
  id: string;
  type: SettlementLineType;
  typeLabel: string;
  description: string;
  quantity: number;
  unit: string;
  unitPriceCents: number;
  amountCents: number;
  direction: 'charge' | 'credit';
  sourceType: SettlementLineRow['sourceType'];
  sourceId: string | null;
  internalNote: string | null;
  editable: boolean;
  removable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SettlementClarificationView {
  id: string;
  type: SettlementClarificationRow['type'];
  typeLabel: string;
  sourceId: string;
  status: SettlementClarificationRow['status'];
  title: string;
  detail: string;
  resolution: string | null;
  resolvedAt: string | null;
  context: {
    machineCode?: string;
    severity?: string;
    severityLabel?: string;
    description?: string | null;
    photoCount?: number;
    accessoryType?: string;
    accessoryLabel?: string;
    missingQuantity?: number;
    caseStatus?: string;
  };
}

export interface NoticeView {
  id: string;
  status: CustomerNoticeRow['status'];
  recipientEmail: string | null;
  subject: string;
  bodyText: string;
  totalCents: number;
  positions: NoticePosition[];
  approvedAt: string | null;
  sentAt: string | null;
  gateway: string | null;
  gatewayReference: string | null;
  blockedReason: string | null;
}

export interface AdvancePaymentView {
  id: string;
  bookingId: string;
  amountCents: number;
  receivedAt: string;
  externalReference: string | null;
  status: AdvancePaymentRow['status'];
  createdAt: string;
  cancelledAt: string | null;
}

export interface SecurityDepositView {
  id: string;
  bookingId: string;
  amountCents: number;
  appliedCents: number;
  remainingHeldCents: number;
  receivedAt: string;
  externalReference: string | null;
  status: SecurityDepositRow['status'];
  releasedAt: string | null;
  version: number;
}

export interface TransferView {
  id: string;
  status: AccountingTransferRow['status'];
  attempts: number;
  lastErrorCode: string | null;
  externalReference: string | null;
  paymentStatus: AccountingTransferRow['paymentStatus'];
  transferredAt: string | null;
  provider: AccountingTransferRow['provider'];
  mock: boolean;
}

export type DominantActionKey =
  | 'resolve_clarifications'
  | 'review_notice'
  | 'wait'
  | 'release_as_calculated'
  | 'transfer_now'
  | 'retry_transfer'
  | 'auto_planned'
  | 'not_configured'
  | 'locked';

export interface SettlementPermissions {
  canAddCharge: boolean;
  canRelease: boolean;
  canEndWait: boolean;
  canSetDamageCost: boolean;
  canSetMissingCost: boolean;
  canEditCost: boolean;
  canRecordAdvance: boolean;
  canRecordDeposit: boolean;
  canApplyDeposit: boolean;
  canReleaseDeposit: boolean;
  canManualTransfer: boolean;
  canViewReference: boolean;
}

export interface SettlementView {
  settlement: {
    id: string;
    processId: string;
    processNumber: string;
    /** Kunde des Vorgangs (Kontakt-Klärung bei CONTACT_REVIEW_REQUIRED). */
    customerId: string;
    bookingId: string;
    returnId: string;
    status: SettlementStatus;
    statusLabel: string;
    fixedTotalCents: number;
    variableTotalCents: number;
    chargesTotalCents: number;
    discountCents: number;
    creditsTotalCents: number;
    grossTotalCents: number;
    amountDueCents: number;
    overpaymentCents: number;
    overpaymentHint: string | null;
    noticeRequired: boolean;
    noticeSentAt: string | null;
    waitUntil: string | null;
    customerResponseReceivedAt: string | null;
    amountsChangedAfterNoticeAt: string | null;
    manualTransferRequired: boolean;
    releasedAt: string | null;
    earlyReleasedAt: string | null;
    lockedAt: string | null;
    transferredAt: string | null;
    locked: boolean;
    accountingProvider: AccountingTransferRow['provider'] | null;
    accountingReference: string | null;
    accountingReferenceVisible: boolean;
    paymentStatus: SettlementRow['paymentStatus'];
    paymentStatusLabel: string | null;
    lastTransferErrorCode: string | null;
    accountingBlocker: 'not_configured' | null;
    /** Phase 10 (Vertrag §6): Provider, Blocker, Rechnungsdaten, Retry-Freigabe. */
    accounting: AccountingBlockView;
    /** Phase 10: Rechnungsversand – 'pending' bis Phase 12 versendet; nie automatisch 'sent'. */
    invoiceDeliveryStatus: string | null;
    autoTransferPlannedAt: string | null;
    version: number;
    createdAt: string;
    updatedAt: string;
  };
  lines: SettlementLineView[];
  clarifications: SettlementClarificationView[];
  notice: Omit<NoticeView, 'positions'> | null;
  advancePayments: AdvancePaymentView[];
  securityDeposits: SecurityDepositView[];
  transfer: TransferView | null;
  dominantAction: { key: DominantActionKey; label: string; hint: string };
  permissions: SettlementPermissions;
  mock: { isMock: boolean; controlsAvailable: boolean };
}

export interface PaymentsView {
  bookingId: string;
  processId: string;
  settlement: { id: string; version: number; locked: boolean; amountDueCents: number } | null;
  advancePayments: AdvancePaymentView[];
  securityDeposits: SecurityDepositView[];
  totals: { activeAdvanceCents: number; heldDepositCents: number; appliedDepositCents: number };
  permissions: {
    canRecordAdvance: boolean;
    canRecordDeposit: boolean;
    canApplyDeposit: boolean;
    canReleaseDeposit: boolean;
  };
}

export interface SettlementServiceDeps {
  db: Database;
  transfers: AccountingTransferService;
  noticeGateway: SettlementNoticeGateway;
  queue: JobQueue;
  processes: ProcessService;
  appEnv: string;
  logger?: JobRunnerLogger;
}

interface FactLine {
  type: SettlementLineType;
  sourceType: SettlementLineRow['sourceType'];
  sourceKey: string;
  sourceId: string | null;
  description: string;
  quantity: number;
  unit: string;
  unitPriceCents: number;
  amountCents: number;
  snapshot: unknown;
}

interface SnapshotItem {
  position?: unknown;
  kind?: unknown;
  description?: unknown;
  quantity?: unknown;
  unit?: unknown;
  agreedUnitPriceCents?: unknown;
  totalCents?: unknown;
}

const noopLogger: JobRunnerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function asInt(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function iso(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

function lineDirection(type: SettlementLineType): 'charge' | 'credit' {
  return type === 'discount' || SETTLEMENT_CREDIT_LINE_TYPES.includes(type) ? 'credit' : 'charge';
}

export class SettlementService {
  private readonly db: Database;
  private readonly transfers: AccountingTransferService;
  private readonly noticeGateway: SettlementNoticeGateway;
  private readonly queue: JobQueue;
  private readonly processes: ProcessService;
  private readonly appEnv: string;
  private readonly logger: JobRunnerLogger;

  constructor(deps: SettlementServiceDeps) {
    this.db = deps.db;
    this.transfers = deps.transfers;
    this.noticeGateway = deps.noticeGateway;
    this.queue = deps.queue;
    this.processes = deps.processes;
    this.appEnv = deps.appEnv;
    this.logger = deps.logger ?? noopLogger;
  }

  // ── Laden ────────────────────────────────────────────────────────────────

  async byId(settlementId: string, executor: DatabaseExecutor = this.db): Promise<SettlementRow> {
    const rows = await executor.select().from(settlements).where(eq(settlements.id, settlementId));
    const row = rows[0];
    if (row === undefined) {
      throw new SettlementError('SETTLEMENT_NOT_FOUND', 'Abrechnung nicht gefunden.', 'NOT_FOUND');
    }
    return row;
  }

  async byProcessId(processId: string): Promise<SettlementRow | null> {
    const rows = await this.db
      .select()
      .from(settlements)
      .where(eq(settlements.processId, processId));
    return rows[0] ?? null;
  }

  async byBookingId(
    bookingId: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<SettlementRow | null> {
    const rows = await executor
      .select()
      .from(settlements)
      .where(eq(settlements.bookingId, bookingId));
    return rows[0] ?? null;
  }

  async lineById(settlementId: string, lineId: string): Promise<SettlementLineRow> {
    const rows = await this.db
      .select()
      .from(settlementLines)
      .where(and(eq(settlementLines.id, lineId), eq(settlementLines.settlementId, settlementId)));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Position nicht gefunden.');
    return row;
  }

  async clarificationById(
    settlementId: string,
    clarificationId: string,
  ): Promise<SettlementClarificationRow> {
    const rows = await this.db
      .select()
      .from(settlementClarifications)
      .where(
        and(
          eq(settlementClarifications.id, clarificationId),
          eq(settlementClarifications.settlementId, settlementId),
        ),
      );
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Klärung nicht gefunden.');
    return row;
  }

  async advanceById(advanceId: string): Promise<AdvancePaymentRow> {
    const rows = await this.db
      .select()
      .from(bookingAdvancePayments)
      .where(eq(bookingAdvancePayments.id, advanceId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Anzahlung nicht gefunden.');
    return row;
  }

  async depositById(depositId: string): Promise<SecurityDepositRow> {
    const rows = await this.db
      .select()
      .from(bookingSecurityDeposits)
      .where(eq(bookingSecurityDeposits.id, depositId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Kaution nicht gefunden.');
    return row;
  }

  private async bookingById(bookingId: string, executor: DatabaseExecutor): Promise<Booking> {
    const rows = await executor.select().from(bookings).where(eq(bookings.id, bookingId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Buchung nicht gefunden.');
    return row;
  }

  private async processById(processId: string, executor: DatabaseExecutor): Promise<Process> {
    const rows = await executor.select().from(processes).where(eq(processes.id, processId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
    return row;
  }

  // ── Ensure / Backfill (§48) ──────────────────────────────────────────────

  /**
   * Genau EIN Settlement je finalisierter Rückgabe – idempotent und
   * nebenläufigkeitssicher (Advisory-Lock je Rückgabe + Unique-Index).
   * Mehrfachaufruf erzeugt weder doppelte Settlements noch doppelte
   * Positionen; vorhandene Entscheidungen bleiben bestehen.
   */
  async ensureSettlementForReturn(returnId: string, now = new Date()): Promise<SettlementRow> {
    const settlement = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${'settlement-ensure:' + returnId}))`,
      );
      const returnRows = await tx
        .select()
        .from(rentalReturns)
        .where(eq(rentalReturns.id, returnId));
      const ret = returnRows[0];
      if (ret === undefined) throw new AuthError('NOT_FOUND', 'Rückgabe nicht gefunden.');
      if (ret.status !== 'finalized') {
        throw new SettlementError(
          'RETURN_NOT_FINALIZED',
          'Die Abrechnung entsteht erst nach Abschluss der Rückgabe.',
        );
      }
      const existing = await tx
        .select()
        .from(settlements)
        .where(eq(settlements.returnId, returnId))
        .for('update');
      let row = existing[0];
      if (row === undefined) {
        await tx
          .insert(settlements)
          .values({
            processId: ret.processId,
            bookingId: ret.bookingId,
            returnId: ret.id,
            status: 'preparing',
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: settlements.returnId });
        const again = await tx
          .select()
          .from(settlements)
          .where(eq(settlements.returnId, returnId))
          .for('update');
        row = again[0];
        if (row === undefined)
          throw new AuthError('CONFLICT', 'Abrechnung konnte nicht angelegt werden.');
        this.logger.info(
          { settlementId: row.id, processId: row.processId, returnId },
          'Abrechnung angelegt',
        );
      }
      if (!this.isMutable(row)) return row;
      return this.rebuildWithin(tx, row, now, { bumpVersion: false });
    });
    await this.afterCommit(settlement, now);
    return settlement;
  }

  /** Ensure über den Vorgang (Route) – 404/409 wenn keine finalisierte Rückgabe existiert. */
  async ensureForProcess(processId: string, now = new Date()): Promise<SettlementRow> {
    const existing = await this.byProcessId(processId);
    if (existing !== null) return this.ensureSettlementForReturn(existing.returnId, now);
    const bookingRows = await this.db
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.processId, processId));
    const booking = bookingRows[0];
    if (booking === undefined) {
      throw new SettlementError(
        'RETURN_NOT_FINALIZED',
        'Für diesen Vorgang gibt es keine abgeschlossene Rückgabe.',
      );
    }
    const returnRows = await this.db
      .select({ id: rentalReturns.id, status: rentalReturns.status })
      .from(rentalReturns)
      .where(eq(rentalReturns.bookingId, booking.id));
    const ret = returnRows[0];
    if (ret === undefined || ret.status !== 'finalized') {
      throw new SettlementError(
        'RETURN_NOT_FINALIZED',
        'Die Abrechnung entsteht erst nach Abschluss der Rückgabe.',
      );
    }
    return this.ensureSettlementForReturn(ret.id, now);
  }

  /** Backfill (CLI): alle finalisierten Rückgaben ohne Settlement nachziehen. */
  async ensureAll(now = new Date()): Promise<{ checked: number; created: string[] }> {
    const rows = await this.db
      .select({ returnId: rentalReturns.id, settlementId: settlements.id })
      .from(rentalReturns)
      .leftJoin(settlements, eq(settlements.returnId, rentalReturns.id))
      .where(eq(rentalReturns.status, 'finalized'))
      .orderBy(asc(rentalReturns.finalizedAt));
    const created: string[] = [];
    for (const row of rows) {
      if (row.settlementId !== null) continue;
      const settlement = await this.ensureSettlementForReturn(row.returnId, now);
      created.push(settlement.id);
    }
    return { checked: rows.length, created };
  }

  // ── Sperren / Mutationsrahmen ────────────────────────────────────────────

  private isMutable(settlement: SettlementRow): boolean {
    return settlement.lockedAt === null && settlement.accountingTransferId === null;
  }

  private assertMutable(settlement: SettlementRow): void {
    if (settlement.lockedAt !== null) {
      throw new SettlementError('SETTLEMENT_LOCKED', TRANSFER_LOCK_MESSAGE);
    }
    if (settlement.accountingTransferId !== null) {
      throw new SettlementError('TRANSFER_PREPARED', TRANSFER_PREPARED_MESSAGE);
    }
  }

  private async lockSettlement(
    tx: DatabaseTransaction,
    settlementId: string,
  ): Promise<SettlementRow> {
    const rows = await tx
      .select()
      .from(settlements)
      .where(eq(settlements.id, settlementId))
      .for('update');
    const row = rows[0];
    if (row === undefined) {
      throw new SettlementError('SETTLEMENT_NOT_FOUND', 'Abrechnung nicht gefunden.', 'NOT_FOUND');
    }
    return row;
  }

  /**
   * Rahmen jeder fachlichen Mutation: Zeilensperre, Lock-Prüfung,
   * optimistische Version, Fachschritt, Neuaufbau (Fakten, Summen, Status),
   * Versionssprung – alles in EINER Transaktion; danach ggf. Auto-Job.
   */
  private async mutate<T>(
    settlementId: string,
    expectedVersion: number | null,
    now: Date,
    fn: (tx: DatabaseTransaction, settlement: SettlementRow) => Promise<T>,
  ): Promise<{ settlement: SettlementRow; result: T }> {
    const out = await this.db.transaction(async (tx) => {
      const settlement = await this.lockSettlement(tx, settlementId);
      this.assertMutable(settlement);
      if (expectedVersion !== null && settlement.version !== expectedVersion) {
        throw new SettlementError(
          'VERSION_CONFLICT',
          'Die Abrechnung wurde zwischenzeitlich geändert – bitte neu laden.',
        );
      }
      const result = await fn(tx, settlement);
      const fresh = await this.lockSettlement(tx, settlementId);
      const rebuilt = await this.rebuildWithin(tx, fresh, now, { bumpVersion: true });
      return { settlement: rebuilt, result };
    });
    await this.afterCommit(out.settlement, now);
    return out;
  }

  // ── Neuaufbau (Vertrag §3) ───────────────────────────────────────────────

  private async factLines(
    tx: DatabaseExecutor,
    settlement: SettlementRow,
    booking: Booking,
  ): Promise<FactLine[]> {
    const facts: FactLine[] = [];
    const items = Array.isArray(booking.itemsSnapshot)
      ? (booking.itemsSnapshot as SnapshotItem[])
      : [];
    for (const item of items) {
      if (item.kind !== 'machine') continue;
      const position = asInt(item.position, facts.length + 1);
      const quantity = asInt(item.quantity, 1);
      const unitPriceCents = asInt(item.agreedUnitPriceCents);
      facts.push({
        type: 'machine_rental',
        sourceType: 'booking_item',
        sourceKey: `item:${position}`,
        sourceId: null,
        description: asString(item.description, 'Maschinenmiete'),
        quantity,
        unit: asString(item.unit, 'Stück'),
        unitPriceCents,
        amountCents: asInt(item.totalCents, quantity * unitPriceCents),
        snapshot: item,
      });
    }
    const delivery = (booking.deliverySnapshot ?? null) as { deliveryPriceCents?: unknown } | null;
    const deliveryCents = delivery === null ? 0 : asInt(delivery.deliveryPriceCents);
    if (deliveryCents > 0) {
      facts.push({
        type: 'delivery',
        sourceType: 'booking_delivery',
        sourceKey: 'delivery',
        sourceId: null,
        description: 'Lieferung und Abholung',
        quantity: 1,
        unit: 'pauschal',
        unitPriceCents: deliveryCents,
        amountCents: deliveryCents,
        snapshot: delivery,
      });
    }
    const totals = (booking.totalsSnapshot ?? {}) as { discountCents?: unknown };
    const discountCents = asInt(totals.discountCents);
    if (discountCents > 0) {
      facts.push({
        type: 'discount',
        sourceType: 'booking_discount',
        sourceKey: 'discount',
        sourceId: null,
        description: 'Rabatt',
        quantity: 1,
        unit: 'pauschal',
        unitPriceCents: discountCents,
        amountCents: discountCents,
        snapshot: totals,
      });
    }
    // Kaufartikel: tatsächlich ausgegebene finale Lieferscheinmenge, eingefrorener Preis (§7).
    const purchaseRows = await tx
      .select({ item: deliveryNoteItems })
      .from(deliveryNoteItems)
      .innerJoin(deliveryNotes, eq(deliveryNotes.id, deliveryNoteItems.deliveryNoteId))
      .where(
        and(
          eq(deliveryNotes.bookingId, booking.id),
          eq(deliveryNotes.status, 'final'),
          eq(deliveryNoteItems.kind, 'purchase'),
        ),
      )
      .orderBy(asc(deliveryNoteItems.position));
    for (const { item } of purchaseRows) {
      if (item.actualQuantity <= 0) continue;
      facts.push({
        type: 'purchase',
        sourceType: 'delivery_note_item',
        sourceKey: `dni:${item.id}`,
        sourceId: item.id,
        description: item.description,
        quantity: item.actualQuantity,
        unit: item.unit,
        unitPriceCents: item.unitPriceCents,
        amountCents: item.actualQuantity * item.unitPriceCents,
        snapshot: {
          deliveryNoteItemId: item.id,
          actualQuantity: item.actualQuantity,
          unitPriceCents: item.unitPriceCents,
        },
      });
    }
    // Kommission: exakt die Phase-7-Fakten (§8) – included bleibt 0 und erzeugt keine Position.
    const commissionRows = await tx
      .select()
      .from(returnInventoryItems)
      .where(eq(returnInventoryItems.returnId, settlement.returnId))
      .orderBy(asc(returnInventoryItems.createdAt));
    for (const row of commissionRows) {
      if (row.kind !== 'commission') continue;
      const chargeableQuantity = row.chargeableQuantity ?? 0;
      if (chargeableQuantity <= 0) continue;
      facts.push({
        type: 'commission_consumption',
        sourceType: 'return_inventory_item',
        sourceKey: `rii:${row.id}`,
        sourceId: row.id,
        description: row.description,
        quantity: chargeableQuantity,
        unit: row.unit,
        unitPriceCents: row.unitPriceSnapshotCents,
        amountCents: row.chargeableAmountCents ?? chargeableQuantity * row.unitPriceSnapshotCents,
        snapshot: {
          returnInventoryItemId: row.id,
          issuedQuantity: row.issuedQuantity,
          returnedUnopenedQuantity: row.returnedUnopenedQuantity,
          chargeableQuantity,
          unitPriceSnapshotCents: row.unitPriceSnapshotCents,
        },
      });
    }
    // Reinigungsgebühr: historischer Return-Fakt je Maschine (§9).
    const cleanupRows = await tx
      .select({ rm: returnMachines, machineCode: machines.machineCode })
      .from(returnMachines)
      .innerJoin(machines, eq(machines.id, returnMachines.machineId))
      .where(eq(returnMachines.returnId, settlement.returnId))
      .orderBy(asc(returnMachines.createdAt));
    for (const { rm, machineCode } of cleanupRows) {
      if (!rm.cleanupRequired || rm.cleanupFeeSnapshotCents === null) continue;
      facts.push({
        type: 'cleanup_fee',
        sourceType: 'return_machine',
        sourceKey: `rm:${rm.id}`,
        sourceId: rm.id,
        description: `Reinigungsgebühr Maschine ${machineCode}`,
        quantity: 1,
        unit: 'pauschal',
        unitPriceCents: rm.cleanupFeeSnapshotCents,
        amountCents: rm.cleanupFeeSnapshotCents,
        snapshot: {
          returnMachineId: rm.id,
          machineCode,
          cleanupFeeSnapshotCents: rm.cleanupFeeSnapshotCents,
          cleanupReason: rm.cleanupReason,
        },
      });
    }
    // Credits (§17/§19): aktive Anzahlungen, bewusst angewendete Kaution.
    const advances = await tx
      .select()
      .from(bookingAdvancePayments)
      .where(eq(bookingAdvancePayments.bookingId, booking.id))
      .orderBy(asc(bookingAdvancePayments.createdAt));
    for (const advance of advances) {
      if (advance.status !== 'active') continue;
      facts.push({
        type: 'advance_payment_credit',
        sourceType: 'advance_payment',
        sourceKey: `advance:${advance.id}`,
        sourceId: advance.id,
        description: `Anzahlung vom ${advance.receivedAt}`,
        quantity: 1,
        unit: 'pauschal',
        unitPriceCents: advance.amountCents,
        amountCents: advance.amountCents,
        snapshot: { advancePaymentId: advance.id, receivedAt: advance.receivedAt },
      });
    }
    const deposits = await tx
      .select()
      .from(bookingSecurityDeposits)
      .where(eq(bookingSecurityDeposits.bookingId, booking.id))
      .orderBy(asc(bookingSecurityDeposits.createdAt));
    for (const deposit of deposits) {
      if (deposit.appliedCents <= 0) continue;
      facts.push({
        type: 'deposit_applied_credit',
        sourceType: 'security_deposit',
        sourceKey: `deposit:${deposit.id}`,
        sourceId: deposit.id,
        description: `Angewendete Kaution vom ${deposit.receivedAt}`,
        quantity: 1,
        unit: 'pauschal',
        unitPriceCents: deposit.appliedCents,
        amountCents: deposit.appliedCents,
        snapshot: { securityDepositId: deposit.id, appliedCents: deposit.appliedCents },
      });
    }
    return facts;
  }

  /**
   * Fakten erneut lesen (idempotent über (sourceType, sourceKey)), manuelle
   * Positionen und Entscheidungen unverändert lassen, Klärungen abgleichen,
   * Kundeninformation vorbereiten, Summen (@mietroyal/domain) und Status
   * ableiten. Läuft ausschließlich unter der Settlement-Zeilensperre.
   */
  private async rebuildWithin(
    tx: DatabaseTransaction,
    settlement: SettlementRow,
    now: Date,
    options: { bumpVersion: boolean },
  ): Promise<SettlementRow> {
    const booking = await this.bookingById(settlement.bookingId, tx);
    const process = await this.processById(settlement.processId, tx);
    const facts = await this.factLines(tx, settlement, booking);
    const keep = new Set(facts.map((fact) => `${fact.sourceType}|${fact.sourceKey}`));
    for (const fact of facts) {
      await tx
        .insert(settlementLines)
        .values({
          settlementId: settlement.id,
          type: fact.type,
          description: fact.description,
          quantity: fact.quantity,
          unit: fact.unit,
          unitPriceCents: fact.unitPriceCents,
          amountCents: fact.amountCents,
          sourceType: fact.sourceType,
          sourceKey: fact.sourceKey,
          sourceId: fact.sourceId,
          sourceSnapshot: fact.snapshot,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            settlementLines.settlementId,
            settlementLines.sourceType,
            settlementLines.sourceKey,
          ],
          set: {
            description: fact.description,
            quantity: fact.quantity,
            unit: fact.unit,
            unitPriceCents: fact.unitPriceCents,
            amountCents: fact.amountCents,
            sourceSnapshot: fact.snapshot,
            updatedAt: now,
          },
        });
    }
    const existingFactLines = await tx
      .select({
        id: settlementLines.id,
        sourceType: settlementLines.sourceType,
        sourceKey: settlementLines.sourceKey,
      })
      .from(settlementLines)
      .where(
        and(
          eq(settlementLines.settlementId, settlement.id),
          inArray(settlementLines.sourceType, [...FACT_SOURCE_TYPES]),
        ),
      );
    const stale = existingFactLines
      .filter((line) => !keep.has(`${line.sourceType}|${line.sourceKey}`))
      .map((line) => line.id);
    if (stale.length > 0) {
      await tx.delete(settlementLines).where(inArray(settlementLines.id, stale));
    }

    // Klärungen (§10/§13): offene finanzielle Schäden und Fehlteile der Rückgabe.
    const damageRows = await tx
      .select({ id: machineDamages.id })
      .from(machineDamages)
      .where(
        and(
          eq(machineDamages.returnId, settlement.returnId),
          // AUSSCHLIESSLICH requires_financial_review: `resolved_at` bedeutet in
          // Phase 7 „nicht mehr aktuell/repariert“, keine finanzielle Erledigung –
          // die lebt nur in settlement_clarifications.
          eq(machineDamages.requiresFinancialReview, true),
        ),
      );
    for (const damage of damageRows) {
      await tx
        .insert(settlementClarifications)
        .values({
          settlementId: settlement.id,
          type: 'damage_cost',
          sourceId: damage.id,
          status: 'open',
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }
    const missingRows = await tx
      .select({ id: missingAccessoryCases.id, status: missingAccessoryCases.status })
      .from(missingAccessoryCases)
      .where(eq(missingAccessoryCases.returnId, settlement.returnId));
    for (const missing of missingRows) {
      if (missing.status === 'open') {
        await tx
          .insert(settlementClarifications)
          .values({
            settlementId: settlement.id,
            type: 'missing_item_cost',
            sourceId: missing.id,
            status: 'open',
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing();
      } else {
        // Teil inzwischen zurück / Fall erledigt (Phase 7) ⇒ keine Kostenposition erforderlich (§13).
        await tx
          .update(settlementClarifications)
          .set({
            status: 'resolved',
            resolution: 'already_resolved',
            resolvedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(settlementClarifications.settlementId, settlement.id),
              eq(settlementClarifications.type, 'missing_item_cost'),
              eq(settlementClarifications.sourceId, missing.id),
              eq(settlementClarifications.status, 'open'),
            ),
          );
      }
    }

    // Summen (eine autoritative Implementierung: @mietroyal/domain).
    const lines = await tx
      .select()
      .from(settlementLines)
      .where(eq(settlementLines.settlementId, settlement.id))
      .orderBy(asc(settlementLines.createdAt));
    const totals = computeSettlementTotals(
      lines.map((line) => ({ type: line.type, amountCents: line.amountCents })),
    );
    const noticePositions: NoticePosition[] = lines
      .filter((line) => NOTICE_LINE_TYPES.includes(line.type) && line.amountCents > 0)
      .map((line) => ({
        lineId: line.id,
        type: line.type as NoticePosition['type'],
        description: line.description,
        amountCents: line.amountCents,
      }));
    const noticeRequired = noticePositions.length > 0;

    // Kundeninformation (§§24–27): eine kombinierte, vorbereitet; vor dem Versand stets aktuell.
    if (settlement.noticeSentAt === null) {
      if (noticeRequired) {
        await tx
          .insert(settlementClarifications)
          .values({
            settlementId: settlement.id,
            type: 'customer_notice',
            sourceId: settlement.id,
            status: 'open',
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing();
        const customer = booking.customerSnapshot as Record<string, unknown>;
        const totalCents = noticePositions.reduce((sum, position) => sum + position.amountCents, 0);
        const text = buildCustomerNoticeText({
          processNumber: process.processNumber,
          customerName: asString(customer.displayName),
          positions: noticePositions,
          totalCents,
        });
        const recipient = asString(customer.email).trim();
        const existingNotice = await tx
          .select()
          .from(settlementCustomerNotices)
          .where(eq(settlementCustomerNotices.settlementId, settlement.id));
        if (existingNotice[0] === undefined) {
          await tx.insert(settlementCustomerNotices).values({
            settlementId: settlement.id,
            status: 'prepared',
            recipientEmail: recipient === '' ? null : recipient,
            subject: text.subject,
            bodyText: text.bodyText,
            positionsSnapshot: noticePositions,
            totalCents,
            createdAt: now,
            updatedAt: now,
          });
        } else if (existingNotice[0].status !== 'sent') {
          await tx
            .update(settlementCustomerNotices)
            .set({
              recipientEmail: recipient === '' ? null : recipient,
              subject: text.subject,
              bodyText: text.bodyText,
              positionsSnapshot: noticePositions,
              totalCents,
              updatedAt: now,
            })
            .where(eq(settlementCustomerNotices.id, existingNotice[0].id));
        }
      } else {
        // Keine Schaden-/Fehlteilbelastung mehr vor dem Versand: vorbereitete Information entfällt.
        await tx
          .delete(settlementClarifications)
          .where(
            and(
              eq(settlementClarifications.settlementId, settlement.id),
              eq(settlementClarifications.type, 'customer_notice'),
              eq(settlementClarifications.status, 'open'),
            ),
          );
        await tx
          .delete(settlementCustomerNotices)
          .where(
            and(
              eq(settlementCustomerNotices.settlementId, settlement.id),
              inArray(settlementCustomerNotices.status, ['prepared', 'approved', 'blocked']),
            ),
          );
      }
    }

    const openRows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(settlementClarifications)
      .where(
        and(
          eq(settlementClarifications.settlementId, settlement.id),
          eq(settlementClarifications.status, 'open'),
          inArray(settlementClarifications.type, [...BLOCKING_CLARIFICATION_TYPES]),
        ),
      );
    const status = deriveSettlementStatus({
      lockedAt: settlement.lockedAt,
      accountingTransferId: settlement.accountingTransferId,
      lastTransferErrorCode: settlement.lastTransferErrorCode,
      openBlockingClarifications: Number(openRows[0]?.n ?? 0),
      noticeRequired,
      noticeSentAt: settlement.noticeSentAt,
      waitUntil: settlement.waitUntil,
      releasedAt: settlement.releasedAt,
      earlyReleasedAt: settlement.earlyReleasedAt,
      now,
    });
    const updated = await tx
      .update(settlements)
      .set({
        status,
        fixedTotalCents: totals.fixedTotalCents,
        variableTotalCents: totals.variableTotalCents,
        chargesTotalCents: totals.chargesTotalCents,
        creditsTotalCents: totals.creditsTotalCents,
        amountDueCents: totals.amountDueCents,
        overpaymentCents: totals.overpaymentCents,
        noticeRequired,
        ...(options.bumpVersion ? { version: settlement.version + 1 } : {}),
        updatedAt: now,
      })
      .where(eq(settlements.id, settlement.id))
      .returning();
    return updated[0] ?? settlement;
  }

  // ── Nach dem Commit: Auto-Transfer-Job, Prozessabschluss ─────────────────

  /**
   * Auto-Transfer (§23/§34/§79): bei `ready_for_accounting` ohne manuelle
   * Übertragung sofort, während `customer_waiting` zum Fristende
   * (runAt = waitUntil, einmal beim Versand – kein Scanner). Production ohne
   * Gateway: kein Job, kein Endlos-Retry (Blocker `not_configured`).
   */
  private async afterCommit(settlement: SettlementRow, now: Date): Promise<void> {
    try {
      if (settlement.status === 'transferred') {
        await this.completeProcessAfterTransfer(settlement, now);
        return;
      }
      if (!this.transfers.isConfigured()) return;
      if (settlement.manualTransferRequired || settlement.accountingTransferId !== null) return;
      if (settlement.status === 'ready_for_accounting') {
        await this.ensureAutoJob(settlement.id, now);
      } else if (settlement.status === 'customer_waiting' && settlement.waitUntil !== null) {
        await this.ensureAutoJob(settlement.id, settlement.waitUntil);
      }
    } catch (error) {
      this.logger.error(
        {
          settlementId: settlement.id,
          error: error instanceof Error ? error.name : 'unknown',
        },
        'Nachlauf der Abrechnung (Auto-Job/Prozessabschluss) fehlgeschlagen',
      );
    }
  }

  private async pendingAutoJob(settlementId: string) {
    const rows = await this.db
      .select({
        id: integrationJobs.id,
        runAt: integrationJobs.runAt,
        status: integrationJobs.status,
      })
      .from(integrationJobs)
      .where(
        and(
          eq(integrationJobs.type, SETTLEMENT_ACCOUNTING_TRANSFER_JOB_TYPE),
          sql`${integrationJobs.payload}->>'settlementId' = ${settlementId}`,
          inArray(integrationJobs.status, ['pending', 'processing']),
        ),
      )
      .orderBy(desc(integrationJobs.runAt));
    return rows[0] ?? null;
  }

  private async ensureAutoJob(settlementId: string, runAt: Date): Promise<void> {
    const pending = await this.pendingAutoJob(settlementId);
    if (pending !== null) {
      // Die Fälligkeit des Jobs folgt der Frist der Abrechnung (z. B. Mock-
      // Steuerung „Frist ablaufen lassen“): nur vorziehen, nie verschieben.
      if (pending.status === 'pending' && pending.runAt.getTime() > runAt.getTime()) {
        await this.db
          .update(integrationJobs)
          .set({ runAt, updatedAt: new Date() })
          .where(and(eq(integrationJobs.id, pending.id), eq(integrationJobs.status, 'pending')));
      }
      return;
    }
    const countRows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(integrationJobs)
      .where(
        and(
          eq(integrationJobs.type, SETTLEMENT_ACCOUNTING_TRANSFER_JOB_TYPE),
          sql`${integrationJobs.payload}->>'settlementId' = ${settlementId}`,
        ),
      );
    const generation = Number(countRows[0]?.n ?? 0);
    const base = settlementTransferIdempotencyKey(settlementId);
    const result = await this.queue.enqueue(
      SETTLEMENT_ACCOUNTING_TRANSFER_JOB_TYPE,
      { settlementId, reason: 'auto' },
      { idempotencyKey: generation === 0 ? base : `${base}:auto:${generation}`, runAt },
    );
    if (!result.deduplicated) {
      this.logger.info(
        { settlementId, jobId: result.jobId, runAt: runAt.toISOString() },
        'Automatische Buchhaltungsübertragung eingestellt',
      );
    }
  }

  /**
   * Nach erfolgreichem Transfer: Vorgang operativ abschließen (§45) über
   * die bestehende Prozesslogik. Ein Konflikt (z. B. bereits abgeschlossen)
   * wird nur protokolliert – der Transfer bleibt erfolgreich.
   */
  private async completeProcessAfterTransfer(
    settlement: SettlementRow,
    now: Date,
    options: { justTransferred: boolean } = { justTransferred: false },
  ): Promise<void> {
    const process = await this.processById(settlement.processId, this.db);
    // Ein vom Admin wieder geöffneter Vorgang wird nur durch den Transfer
    // selbst abgeschlossen – nie nachträglich durch Lese-/Nachläufe (§47).
    const eligible =
      process.mainStatus === 'open' ||
      (options.justTransferred && process.mainStatus === 'reopened');
    if (!eligible) return;
    try {
      await this.processes.complete(settlement.processId, {
        canViewCompleted: true,
        visibilityDays: 0,
        now,
      });
      this.logger.info(
        { settlementId: settlement.id, processId: settlement.processId },
        'Vorgang nach Buchhaltungstransfer abgeschlossen',
      );
    } catch (error) {
      this.logger.warn(
        {
          settlementId: settlement.id,
          processId: settlement.processId,
          code: error instanceof AuthError ? error.code : 'UNKNOWN',
        },
        'Vorgang konnte nach dem Transfer nicht automatisch abgeschlossen werden',
      );
    }
  }

  // ── Manuelle Positionen (§§15/16) ────────────────────────────────────────

  async addManualLine(
    actorId: string,
    settlementId: string,
    input: {
      type: 'manual_charge' | 'late_fee';
      description: string;
      amountCents: number;
      internalNote?: string | null | undefined;
      version: number;
    },
    now = new Date(),
  ): Promise<SettlementRow> {
    const description = input.description.trim();
    if (description === '') {
      throw new AuthError('VALIDATION', 'Eine Kundenbeschreibung ist Pflicht.');
    }
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new AuthError('VALIDATION', 'Der Betrag muss ein positiver Cent-Betrag sein.');
    }
    const { settlement } = await this.mutate(settlementId, input.version, now, async (tx, s) => {
      await tx.insert(settlementLines).values({
        settlementId: s.id,
        type: input.type,
        description,
        quantity: 1,
        unit: 'pauschal',
        unitPriceCents: input.amountCents,
        amountCents: input.amountCents,
        sourceType: 'manual',
        sourceKey: `manual:${crypto.randomUUID()}`,
        sourceId: null,
        sourceSnapshot: { enteredBy: actorId, enteredAt: now.toISOString() },
        internalNote: (input.internalNote ?? '').trim() === '' ? null : input.internalNote!.trim(),
        createdBy: actorId,
        createdAt: now,
        updatedBy: actorId,
        updatedAt: now,
      });
    });
    return settlement;
  }

  async updateLine(
    actorId: string,
    settlementId: string,
    lineId: string,
    input: {
      amountCents?: number | undefined;
      description?: string | undefined;
      internalNote?: string | null | undefined;
      version: number;
    },
    now = new Date(),
  ): Promise<SettlementRow> {
    if (
      input.amountCents !== undefined &&
      (!Number.isInteger(input.amountCents) || input.amountCents <= 0)
    ) {
      throw new AuthError('VALIDATION', 'Der Betrag muss ein positiver Cent-Betrag sein.');
    }
    if (input.description !== undefined && input.description.trim() === '') {
      throw new AuthError('VALIDATION', 'Die Kundenbeschreibung darf nicht leer sein.');
    }
    const { settlement } = await this.mutate(settlementId, input.version, now, async (tx, s) => {
      const line = await this.lockLine(tx, s.id, lineId);
      if (!EDITABLE_LINE_TYPES.includes(line.type)) {
        throw new SettlementError(
          'LINE_NOT_EDITABLE',
          'Diese Position stammt aus eingefrorenen Fakten und kann nicht geändert werden.',
        );
      }
      const amountChanged =
        input.amountCents !== undefined && input.amountCents !== line.amountCents;
      await tx
        .update(settlementLines)
        .set({
          ...(input.amountCents === undefined
            ? {}
            : { amountCents: input.amountCents, unitPriceCents: input.amountCents, quantity: 1 }),
          ...(input.description === undefined ? {} : { description: input.description.trim() }),
          ...(input.internalNote === undefined
            ? {}
            : {
                internalNote:
                  (input.internalNote ?? '').trim() === '' ? null : input.internalNote!.trim(),
              }),
          updatedBy: actorId,
          updatedAt: now,
        })
        .where(eq(settlementLines.id, line.id));
      if (amountChanged && NOTICE_LINE_TYPES.includes(line.type)) {
        await this.markAmountsChangedAfterNotice(tx, s, actorId, 'amount_changed', now);
      }
    });
    return settlement;
  }

  async removeLine(
    actorId: string,
    settlementId: string,
    lineId: string,
    version: number,
    now = new Date(),
  ): Promise<SettlementRow> {
    const { settlement } = await this.mutate(settlementId, version, now, async (tx, s) => {
      const line = await this.lockLine(tx, s.id, lineId);
      if (!EDITABLE_LINE_TYPES.includes(line.type)) {
        throw new SettlementError(
          'LINE_NOT_EDITABLE',
          'Diese Position stammt aus eingefrorenen Fakten und kann nicht entfernt werden.',
        );
      }
      await tx.delete(settlementLines).where(eq(settlementLines.id, line.id));
      if (NOTICE_LINE_TYPES.includes(line.type) && line.sourceId !== null) {
        // Entscheid „nicht berechnen“ – der historische Fakt (Schaden/Fehlteil) bleibt (§33).
        await tx
          .update(settlementClarifications)
          .set({
            status: 'resolved',
            resolution: 'not_charged',
            resolvedBy: actorId,
            resolvedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(settlementClarifications.settlementId, s.id),
              eq(settlementClarifications.sourceId, line.sourceId),
              inArray(settlementClarifications.type, ['damage_cost', 'missing_item_cost']),
            ),
          );
        // Entfernen nach Versand/Kundenrückmeldung (DOMAIN_RULES „Kundenantwort …
        // Position entfernen → wenn sonst frei automatisch weiter“, Order §33):
        // KEIN amountsChangedAfterNoticeAt, Rückmeldung gilt als bearbeitet und
        // der Auto-Transfer ist wieder zulässig (manualTransferRequired = false).
        await this.resolveCustomerResponse(tx, s.id, actorId, 'position_removed', now);
        if (s.manualTransferRequired && s.releasedAt === null && s.earlyReleasedAt === null) {
          await tx
            .update(settlements)
            .set({ manualTransferRequired: false, updatedAt: now })
            .where(eq(settlements.id, s.id));
        }
      }
    });
    return settlement;
  }

  private async lockLine(
    tx: DatabaseTransaction,
    settlementId: string,
    lineId: string,
  ): Promise<SettlementLineRow> {
    const rows = await tx
      .select()
      .from(settlementLines)
      .where(and(eq(settlementLines.id, lineId), eq(settlementLines.settlementId, settlementId)))
      .for('update');
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Position nicht gefunden.');
    return row;
  }

  /**
   * Betragsänderung/Entfernung NACH Versand der Kundeninformation (§29/§32):
   * keine zweite Information, Fenster startet nicht neu, Auto-Transfer aus –
   * nur noch manuelle Übertragung; eine offene Kundenrückmeldung gilt damit
   * als bearbeitet.
   */
  private async markAmountsChangedAfterNotice(
    tx: DatabaseTransaction,
    settlement: SettlementRow,
    actorId: string,
    resolution: 'amount_changed',
    now: Date,
  ): Promise<void> {
    if (settlement.noticeSentAt === null) return;
    await tx
      .update(settlements)
      .set({
        amountsChangedAfterNoticeAt: settlement.amountsChangedAfterNoticeAt ?? now,
        manualTransferRequired: true,
        updatedAt: now,
      })
      .where(eq(settlements.id, settlement.id));
    await this.resolveCustomerResponse(tx, settlement.id, actorId, resolution, now);
  }

  private async resolveCustomerResponse(
    tx: DatabaseTransaction,
    settlementId: string,
    actorId: string,
    resolution: string,
    now: Date,
  ): Promise<number> {
    const rows = await tx
      .update(settlementClarifications)
      .set({ status: 'resolved', resolution, resolvedBy: actorId, resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(settlementClarifications.settlementId, settlementId),
          eq(settlementClarifications.type, 'customer_response'),
          eq(settlementClarifications.status, 'open'),
        ),
      )
      .returning({ id: settlementClarifications.id });
    return rows.length;
  }

  // ── Schaden-/Fehlteil-Kostenentscheid (§§11/14) ──────────────────────────

  async resolveClarification(
    actorId: string,
    settlementId: string,
    clarificationId: string,
    input: {
      decision: 'charge' | 'no_charge';
      amountCents?: number | undefined;
      description?: string | undefined;
      version: number;
    },
    now = new Date(),
  ): Promise<SettlementRow> {
    if (input.decision === 'charge') {
      if (!Number.isInteger(input.amountCents) || (input.amountCents ?? 0) <= 0) {
        throw new AuthError('VALIDATION', 'Zum Berechnen ist ein Betrag > 0 erforderlich.');
      }
    }
    const { settlement } = await this.mutate(settlementId, input.version, now, async (tx, s) => {
      const rows = await tx
        .select()
        .from(settlementClarifications)
        .where(
          and(
            eq(settlementClarifications.id, clarificationId),
            eq(settlementClarifications.settlementId, s.id),
          ),
        )
        .for('update');
      const clarification = rows[0];
      if (clarification === undefined) throw new AuthError('NOT_FOUND', 'Klärung nicht gefunden.');
      if (clarification.type !== 'damage_cost' && clarification.type !== 'missing_item_cost') {
        throw new SettlementError(
          'LINE_NOT_EDITABLE',
          'Diese Klärung wird über die zugehörige Aktion erledigt, nicht über einen Kostenentscheid.',
        );
      }
      // Revidierbar vor Transfer (Order §11/§14): „nicht berechnen“ darf unter der
      // Settlement-Sperre in „berechnen“ geändert werden; alles andere ist entschieden.
      const revisable =
        clarification.status === 'resolved' &&
        input.decision === 'charge' &&
        clarification.resolution !== 'charged';
      if (clarification.status !== 'open' && !revisable) {
        throw new SettlementError(
          'CLARIFICATION_RESOLVED',
          'Diese Klärung wurde bereits entschieden.',
        );
      }
      if (input.decision === 'charge') {
        const context = await this.clarificationContext(tx, clarification);
        const description =
          input.description !== undefined && input.description.trim() !== ''
            ? input.description.trim()
            : context.defaultDescription;
        const amount = input.amountCents!;
        await tx
          .insert(settlementLines)
          .values({
            settlementId: s.id,
            type: clarification.type === 'damage_cost' ? 'damage_charge' : 'missing_item_charge',
            description,
            quantity: 1,
            unit: 'pauschal',
            unitPriceCents: amount,
            amountCents: amount,
            sourceType:
              clarification.type === 'damage_cost' ? 'machine_damage' : 'missing_accessory_case',
            sourceKey:
              clarification.type === 'damage_cost'
                ? `damage:${clarification.sourceId}`
                : `missing:${clarification.sourceId}`,
            sourceId: clarification.sourceId,
            sourceSnapshot: context.snapshot,
            createdBy: actorId,
            createdAt: now,
            updatedBy: actorId,
            updatedAt: now,
          })
          .onConflictDoNothing();
        // Später hinzugefügte Belastung nach Versand: Fenster startet nicht neu, kein Auto-Transfer (§29).
        await this.markAmountsChangedAfterNotice(tx, s, actorId, 'amount_changed', now);
      }
      await tx
        .update(settlementClarifications)
        .set({
          status: 'resolved',
          resolution: input.decision === 'charge' ? 'charged' : 'not_charged',
          resolvedBy: actorId,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(eq(settlementClarifications.id, clarification.id));
    });
    return settlement;
  }

  private async clarificationContext(
    executor: DatabaseExecutor,
    clarification: SettlementClarificationRow,
  ): Promise<{
    defaultDescription: string;
    snapshot: unknown;
    context: SettlementClarificationView['context'];
    detail: string;
  }> {
    if (clarification.type === 'damage_cost') {
      const rows = await executor
        .select({ damage: machineDamages, machineCode: machines.machineCode })
        .from(machineDamages)
        .innerJoin(machines, eq(machines.id, machineDamages.machineId))
        .where(eq(machineDamages.id, clarification.sourceId));
      const row = rows[0];
      if (row === undefined) {
        return { defaultDescription: 'Schadenkosten', snapshot: null, context: {}, detail: '' };
      }
      const photoRows = await executor
        .select({ n: sql<number>`count(*)::int` })
        .from(damagePhotos)
        .where(eq(damagePhotos.damageId, row.damage.id));
      const severityLabel = SEVERITY_LABELS[row.damage.severity];
      return {
        defaultDescription: `Schadenkosten Maschine ${row.machineCode} (${severityLabel}): ${row.damage.description}`,
        snapshot: {
          damageId: row.damage.id,
          machineCode: row.machineCode,
          severity: row.damage.severity,
          description: row.damage.description,
        },
        context: {
          machineCode: row.machineCode,
          severity: row.damage.severity,
          severityLabel,
          description: row.damage.description,
          photoCount: Number(photoRows[0]?.n ?? 0),
        },
        detail: `Maschine ${row.machineCode} – ${severityLabel}: ${row.damage.description}`,
      };
    }
    if (clarification.type === 'missing_item_cost') {
      const rows = await executor
        .select({ missing: missingAccessoryCases, machineCode: machines.machineCode })
        .from(missingAccessoryCases)
        .innerJoin(machines, eq(machines.id, missingAccessoryCases.machineId))
        .where(eq(missingAccessoryCases.id, clarification.sourceId));
      const row = rows[0];
      if (row === undefined) {
        return {
          defaultDescription: 'Ersatzkosten Fehlteil',
          snapshot: null,
          context: {},
          detail: '',
        };
      }
      const accessoryLabel = ACCESSORY_LABELS[row.missing.accessoryType];
      return {
        defaultDescription: `Ersatzkosten Fehlteil Maschine ${row.machineCode}: ${row.missing.missingQuantity} × ${accessoryLabel}`,
        snapshot: {
          missingCaseId: row.missing.id,
          machineCode: row.machineCode,
          accessoryType: row.missing.accessoryType,
          missingQuantity: row.missing.missingQuantity,
        },
        context: {
          machineCode: row.machineCode,
          accessoryType: row.missing.accessoryType,
          accessoryLabel,
          missingQuantity: row.missing.missingQuantity,
          description: row.missing.description,
          caseStatus: row.missing.status,
        },
        detail: `Maschine ${row.machineCode} – ${row.missing.missingQuantity} × ${accessoryLabel}`,
      };
    }
    if (clarification.type === 'customer_notice') {
      return {
        defaultDescription: '',
        snapshot: null,
        context: {},
        detail: 'Kundeninformation prüfen, freigeben und senden – erst danach beginnt die Frist.',
      };
    }
    return {
      defaultDescription: '',
      snapshot: null,
      context: {},
      detail:
        'Kunde hat sich gemeldet – wie berechnet freigeben, Betrag ändern oder Position entfernen.',
    };
  }

  // ── Kundeninformation (§§24–28) ──────────────────────────────────────────

  private async noticeRow(
    settlementId: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<CustomerNoticeRow | null> {
    const rows = await executor
      .select()
      .from(settlementCustomerNotices)
      .where(eq(settlementCustomerNotices.settlementId, settlementId));
    return rows[0] ?? null;
  }

  private noticeView(row: CustomerNoticeRow): NoticeView {
    return {
      id: row.id,
      status: row.status,
      recipientEmail: row.recipientEmail,
      subject: row.subject,
      bodyText: row.bodyText,
      totalCents: row.totalCents,
      positions: Array.isArray(row.positionsSnapshot)
        ? (row.positionsSnapshot as NoticePosition[])
        : [],
      approvedAt: iso(row.approvedAt),
      sentAt: iso(row.sentAt),
      gateway: row.gateway,
      gatewayReference: row.gatewayReference,
      blockedReason: row.blockedReason,
    };
  }

  async notice(settlementId: string, now = new Date()): Promise<NoticeView> {
    await this.refresh(settlementId, now);
    const row = await this.noticeRow(settlementId);
    if (row === null) {
      throw new SettlementError(
        'NOTICE_NOT_FOUND',
        'Für diese Abrechnung ist keine Kundeninformation erforderlich.',
        'NOT_FOUND',
      );
    }
    return this.noticeView(row);
  }

  /**
   * Freigabe + Versand in einem Schritt (§27): nur einmal je Abrechnung,
   * nur ohne offene Kostenklärungen; der erfolgreiche Gateway-Aufruf gilt
   * als Versand – erst dann notice_sent_at und wait_until (= +24 h, §28).
   * Production ohne Adapter: blocked, nie „gesendet“, keine Frist.
   */
  async approveAndSendNotice(
    actorId: string,
    settlementId: string,
    version: number,
    now = new Date(),
  ): Promise<SettlementRow> {
    try {
      return await this.approveAndSendNoticeExclusive(actorId, settlementId, version, now);
    } catch (error) {
      if (error instanceof SettlementError && error.reason === 'NOTICE_NOT_CONFIGURED') {
        await this.db
          .update(settlementCustomerNotices)
          .set({
            status: 'blocked',
            blockedReason: 'Kein Versandadapter konfiguriert',
            updatedAt: now,
          })
          .where(
            and(
              eq(settlementCustomerNotices.settlementId, settlementId),
              inArray(settlementCustomerNotices.status, ['prepared', 'approved', 'blocked']),
            ),
          );
      }
      throw error;
    }
  }

  private async approveAndSendNoticeExclusive(
    actorId: string,
    settlementId: string,
    version: number,
    now: Date,
  ): Promise<SettlementRow> {
    const { settlement } = await this.mutate(settlementId, version, now, async (tx, s) => {
      if (s.noticeSentAt !== null) {
        throw new SettlementError(
          'NOTICE_ALREADY_SENT',
          'Die Kundeninformation wurde bereits gesendet – nur einmal je Abrechnung.',
        );
      }
      if (!s.noticeRequired) {
        throw new SettlementError(
          'NOTICE_NOT_REQUIRED',
          'Für diese Abrechnung ist keine Kundeninformation erforderlich.',
        );
      }
      if (s.status === 'clarification_required') {
        throw new SettlementError(
          'CLARIFICATION_OPEN',
          'Bitte zuerst alle offenen Kostenklärungen erledigen – die Information wird einmal kombiniert gesendet.',
        );
      }
      const noticeRows = await tx
        .select()
        .from(settlementCustomerNotices)
        .where(eq(settlementCustomerNotices.settlementId, s.id))
        .for('update');
      const notice = noticeRows[0];
      if (notice === undefined) {
        throw new SettlementError('NOTICE_NOT_FOUND', 'Kundeninformation nicht vorbereitet.');
      }
      const recipient = (notice.recipientEmail ?? '').trim();
      if (recipient === '') {
        throw new SettlementError(
          'NOTICE_RECIPIENT_MISSING',
          'Im Buchungs-Snapshot fehlt eine E-Mail-Adresse des Kunden.',
        );
      }
      if (!this.noticeGateway.isConfigured()) {
        // Der Status „blocked“ wird außerhalb dieser (zurückgerollten) Transaktion festgehalten.
        throw new SettlementError(
          'NOTICE_NOT_CONFIGURED',
          'Kundeninformation nicht versendbar: Es ist kein Versandadapter konfiguriert.',
        );
      }
      const result = await this.noticeGateway.send({
        noticeId: notice.id,
        settlementId: s.id,
        recipientEmail: recipient,
        subject: notice.subject,
        bodyText: notice.bodyText,
      });
      await tx
        .update(settlementCustomerNotices)
        .set({
          status: 'sent',
          approvedBy: actorId,
          approvedAt: now,
          sentAt: now,
          gateway: result.gateway,
          gatewayReference: result.gatewayReference,
          blockedReason: null,
          updatedAt: now,
        })
        .where(eq(settlementCustomerNotices.id, notice.id));
      await tx
        .update(settlements)
        .set({ noticeSentAt: now, waitUntil: customerNoticeWaitUntil(now), updatedAt: now })
        .where(eq(settlements.id, s.id));
      await tx
        .update(settlementClarifications)
        .set({
          status: 'resolved',
          resolution: 'sent',
          resolvedBy: actorId,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(settlementClarifications.settlementId, s.id),
            eq(settlementClarifications.type, 'customer_notice'),
            eq(settlementClarifications.status, 'open'),
          ),
        );
      this.logger.info({ settlementId: s.id, noticeId: notice.id }, 'Kundeninformation gesendet');
    });
    return settlement;
  }

  /** Interne Aktion „Kundenrückmeldung eingegangen“ (§30): blockiert den Auto-Transfer. */
  async recordCustomerResponse(
    actorId: string,
    settlementId: string,
    version: number,
    now = new Date(),
  ): Promise<SettlementRow> {
    const { settlement } = await this.mutate(settlementId, version, now, async (tx, s) => {
      if (s.noticeSentAt === null) {
        throw new SettlementError(
          'NOTICE_NOT_SENT',
          'Eine Kundenrückmeldung setzt eine gesendete Kundeninformation voraus.',
        );
      }
      if (s.customerResponseReceivedAt !== null) {
        throw new SettlementError(
          'CUSTOMER_RESPONSE_ALREADY_RECORDED',
          'Die Kundenrückmeldung ist bereits erfasst.',
        );
      }
      await tx
        .update(settlements)
        .set({ customerResponseReceivedAt: now, manualTransferRequired: true, updatedAt: now })
        .where(eq(settlements.id, s.id));
      await tx
        .insert(settlementClarifications)
        .values({
          settlementId: s.id,
          type: 'customer_response',
          sourceId: s.id,
          status: 'open',
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            settlementClarifications.settlementId,
            settlementClarifications.type,
            settlementClarifications.sourceId,
          ],
          set: {
            status: 'open',
            resolution: null,
            resolvedBy: null,
            resolvedAt: null,
            updatedAt: now,
          },
        });
      void actorId;
    });
    return settlement;
  }

  /** „Wie berechnet freigeben“ (§31): Rückmeldung erledigt, bewusst manueller Transfer. */
  async releaseAsCalculated(
    actorId: string,
    settlementId: string,
    version: number,
    now = new Date(),
  ): Promise<SettlementRow> {
    const { settlement } = await this.mutate(settlementId, version, now, async (tx, s) => {
      const resolved = await this.resolveCustomerResponse(
        tx,
        s.id,
        actorId,
        'released_as_charged',
        now,
      );
      if (resolved === 0) {
        throw new SettlementError(
          'NO_CUSTOMER_RESPONSE',
          'Es liegt keine offene Kundenrückmeldung vor, die freigegeben werden könnte.',
        );
      }
      await tx
        .update(settlements)
        .set({ releasedAt: now, releasedBy: actorId, manualTransferRequired: true, updatedAt: now })
        .where(eq(settlements.id, s.id));
    });
    return settlement;
  }

  /** „Jetzt freigeben“ (§35): beendet das Wartefenster; danach KEIN automatischer Transfer. */
  async endWait(
    actorId: string,
    settlementId: string,
    version: number,
    now = new Date(),
  ): Promise<SettlementRow> {
    const { settlement } = await this.mutate(settlementId, version, now, async (tx, s) => {
      if (s.status !== 'customer_waiting') {
        throw new SettlementError(
          'NOT_WAITING',
          'Die Abrechnung befindet sich nicht im Wartefenster nach der Kundeninformation.',
        );
      }
      await tx
        .update(settlements)
        .set({ earlyReleasedAt: now, manualTransferRequired: true, updatedAt: now })
        .where(eq(settlements.id, s.id));
      void actorId;
    });
    return settlement;
  }

  // ── Buchhaltungstransfer (§§36–41, §§78–81) ──────────────────────────────

  private async buildPayload(
    tx: DatabaseExecutor,
    settlement: SettlementRow,
    now: Date,
  ): Promise<AccountingPayload> {
    const booking = await this.bookingById(settlement.bookingId, tx);
    const process = await this.processById(settlement.processId, tx);
    const lines = await tx
      .select()
      .from(settlementLines)
      .where(eq(settlementLines.settlementId, settlement.id))
      .orderBy(asc(settlementLines.createdAt));
    const customer = booking.customerSnapshot as Record<string, unknown>;
    const event = (booking.eventSnapshot ?? {}) as Record<string, unknown>;
    const payloadLines: AccountingPayloadLine[] = lines.map((line) => ({
      id: line.id,
      type: line.type,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      unitPriceCents: line.unitPriceCents,
      amountCents: line.amountCents,
      direction: lineDirection(line.type),
    }));
    const totals = computeSettlementTotals(
      lines.map((line) => ({ type: line.type, amountCents: line.amountCents })),
    );
    return {
      schemaVersion: 1,
      kind: 'settlement',
      sourceId: settlement.id,
      processId: settlement.processId,
      processNumber: process.processNumber,
      bookingId: settlement.bookingId,
      eventDate: asString(event.eventDate, process.eventDate ?? ''),
      customer: {
        customerId: asString(customer.id, booking.customerId),
        displayName: asString(customer.displayName),
        companyName:
          typeof customer.organizationName === 'string' ? customer.organizationName : null,
        email: typeof customer.email === 'string' ? customer.email : null,
        billingAddress: {
          street: typeof customer.billingStreet === 'string' ? customer.billingStreet : null,
          postalCode:
            typeof customer.billingPostalCode === 'string' ? customer.billingPostalCode : null,
          city: typeof customer.billingCity === 'string' ? customer.billingCity : null,
        },
      },
      lines: payloadLines,
      totals: {
        chargesCents: totals.grossTotalCents,
        creditsCents: totals.creditsTotalCents,
        amountDueCents: totals.amountDueCents,
        overpaymentCents: totals.overpaymentCents,
      },
      tax: null,
      idempotencyKey: settlementTransferIdempotencyKey(settlement.id),
      createdAt: now.toISOString(),
    };
  }

  /** Zeit der Datenbank (Transaktionszeit) – maßgeblich für Fristvergleiche der Queue. */
  private async dbNow(tx: DatabaseExecutor): Promise<Date> {
    const result = await tx.execute(sql`SELECT now() AS now`);
    const value = result.rows[0]?.now;
    return value instanceof Date ? value : new Date(String(value));
  }

  private async openBlockingClarifications(
    tx: DatabaseExecutor,
    settlementId: string,
  ): Promise<number> {
    const rows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(settlementClarifications)
      .where(
        and(
          eq(settlementClarifications.settlementId, settlementId),
          eq(settlementClarifications.status, 'open'),
          inArray(settlementClarifications.type, [...BLOCKING_CLARIFICATION_TYPES]),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Vorbedingungen der Übertragung – geprüft unter der Settlement-Sperre
   * (Vorbereitung) UND erneut in der Transfersperre (`recheck`, TOCTOU §80).
   */
  private async transferBlockers(
    tx: DatabaseExecutor,
    settlement: SettlementRow,
    mode: 'auto' | 'manual',
    now: Date,
  ): Promise<string[]> {
    const blockers: string[] = [];
    const process = await this.processById(settlement.processId, tx);
    if (process.mainStatus === 'cancelled') blockers.push('Der Vorgang ist storniert.');
    if (settlement.lockedAt !== null) blockers.push('Die Abrechnung ist bereits übertragen.');
    if ((await this.openBlockingClarifications(tx, settlement.id)) > 0) {
      blockers.push('Es gibt offene Klärungen.');
    }
    const status = deriveSettlementStatus({
      lockedAt: settlement.lockedAt,
      accountingTransferId: null,
      lastTransferErrorCode: null,
      openBlockingClarifications: 0,
      noticeRequired: settlement.noticeRequired,
      noticeSentAt: settlement.noticeSentAt,
      waitUntil: settlement.waitUntil,
      releasedAt: settlement.releasedAt,
      earlyReleasedAt: settlement.earlyReleasedAt,
      now,
    });
    if (status === 'customer_notice_required') {
      blockers.push('Die Kundeninformation wurde noch nicht gesendet.');
    }
    if (status === 'customer_waiting') {
      blockers.push('Das Wartefenster nach der Kundeninformation läuft noch.');
    }
    if (mode === 'auto') {
      if (settlement.manualTransferRequired) blockers.push('Nur manuelle Übertragung zulässig.');
      // Entfällt die Notice-Pflicht nach Versand (alle Schaden-/Fehlteilpositionen
      // entfernt), läuft die Abrechnung sofort automatisch weiter (Order §33).
      if (settlement.noticeRequired) {
        if (settlement.noticeSentAt === null) blockers.push('Kundeninformation nicht gesendet.');
        if (settlement.waitUntil === null || now.getTime() < settlement.waitUntil.getTime()) {
          blockers.push('Wartefenster nicht abgelaufen.');
        }
        // Eine Kundenrückmeldung blockiert nur, solange ihre Klärung OFFEN ist
        // (oben als offene Klärung erfasst); der Zeitstempel bleibt Historie.
        if (settlement.amountsChangedAfterNoticeAt !== null) {
          blockers.push('Beträge nach der Kundeninformation geändert.');
        }
      }
    }
    return blockers;
  }

  /** Transferzeile mit eingefrorenem Payload anlegen (idempotent); ab hier sind Beträge gesperrt. */
  private async prepareTransferWithin(
    tx: DatabaseTransaction,
    settlement: SettlementRow,
    now: Date,
  ): Promise<string> {
    if (settlement.accountingTransferId !== null) return settlement.accountingTransferId;
    const payload = await this.buildPayload(tx, settlement, now);
    const row = await this.transfers.prepare(
      tx,
      { kind: 'settlement', settlementId: settlement.id, processId: settlement.processId },
      payload,
    );
    await tx
      .update(settlements)
      .set({
        accountingTransferId: row.id,
        accountingProvider: row.provider,
        status: 'transferring',
        version: settlement.version + 1,
        updatedAt: now,
      })
      .where(eq(settlements.id, settlement.id));
    this.logger.info(
      { settlementId: settlement.id, transferId: row.id },
      'Buchhaltungsübertragung vorbereitet – Beträge gesperrt',
    );
    return row.id;
  }

  private executeHooks(mode: 'auto' | 'manual', now: Date) {
    return {
      recheck: async (tx: DatabaseTransaction, row: AccountingTransferRow): Promise<boolean> => {
        if (row.settlementId === null) return false;
        const settlement = await this.lockSettlement(tx, row.settlementId);
        const blockers = await this.transferBlockers(
          tx,
          settlement,
          mode,
          mode === 'auto' ? await this.dbNow(tx) : now,
        );
        if (blockers.length > 0) {
          this.logger.info(
            { settlementId: settlement.id, transferId: row.id, mode, blockers: blockers.length },
            'Buchhaltungsübertragung übersprungen (Vorbedingungen nicht mehr erfüllt)',
          );
          return false;
        }
        return true;
      },
      onSuccess: async (
        tx: DatabaseTransaction,
        row: AccountingTransferRow,
        result: AccountingTransferResult,
      ): Promise<void> => {
        if (row.settlementId === null) return;
        const settlement = await this.lockSettlement(tx, row.settlementId);
        await tx
          .update(settlements)
          .set({
            status: 'transferred',
            lockedAt: now,
            transferredAt: now,
            accountingTransferId: row.id,
            accountingProvider: result.provider,
            accountingReference: result.externalReference,
            paymentStatus: 'open',
            lastTransferErrorCode: null,
            version: settlement.version + 1,
            updatedAt: now,
          })
          .where(eq(settlements.id, settlement.id));
        this.logger.info(
          { settlementId: settlement.id, transferId: row.id, provider: result.provider },
          'Abrechnung an Buchhaltung übertragen – gesperrt',
        );
      },
      onFailure: async (
        tx: DatabaseTransaction,
        row: AccountingTransferRow,
        code: string,
      ): Promise<void> => {
        if (row.settlementId === null) return;
        const settlement = await this.lockSettlement(tx, row.settlementId);
        await tx
          .update(settlements)
          .set({
            status: 'transfer_failed',
            lastTransferErrorCode: code,
            version: settlement.version + 1,
            updatedAt: now,
          })
          .where(eq(settlements.id, settlement.id));
        this.logger.warn(
          { settlementId: settlement.id, transferId: row.id, code },
          'Buchhaltungsübertragung fehlgeschlagen',
        );
      },
    };
  }

  /**
   * Manuelle Übertragung (synchron, §§32/35/40/76): bereitet den Transfer
   * vor (Payload einfrieren, Beträge sperren) und führt ihn exklusiv aus.
   * Doppelklick: der zweite Aufruf wartet auf die Sperre und sieht
   * `already_succeeded` – nie eine zweite externe Übertragung.
   */
  async transferNow(
    actorId: string,
    settlementId: string,
    version: number,
    now = new Date(),
  ): Promise<{
    outcome: 'succeeded' | 'already_succeeded' | 'skipped' | 'failed';
    errorCode?: string;
    /** Phase 10: false ⇒ permanenter Blocker (kein Auto-Retry). */
    transient?: boolean;
    settlement: SettlementRow;
  }> {
    if (!this.transfers.isConfigured()) {
      throw new SettlementError(
        'ACCOUNTING_NOT_CONFIGURED',
        'Buchhaltungsintegration nicht konfiguriert',
      );
    }
    const transferId = await this.db.transaction(async (tx) => {
      const settlement = await this.lockSettlement(tx, settlementId);
      if (settlement.accountingTransferId !== null) return settlement.accountingTransferId;
      if (settlement.version !== version) {
        throw new SettlementError(
          'VERSION_CONFLICT',
          'Die Abrechnung wurde zwischenzeitlich geändert – bitte neu laden.',
        );
      }
      const blockers = await this.transferBlockers(tx, settlement, 'manual', now);
      if (blockers.length > 0) {
        throw new SettlementError(
          'TRANSFER_NOT_READY',
          `Die Abrechnung kann noch nicht übertragen werden: ${blockers.join(' ')}`,
        );
      }
      return this.prepareTransferWithin(tx, settlement, now);
    });
    const result = await this.transfers.execute(transferId, this.executeHooks('manual', now), now);
    this.logger.info(
      { settlementId, transferId, outcome: result.outcome, actorId },
      'Manuelle Buchhaltungsübertragung',
    );
    const settlement = await this.byId(settlementId);
    if (result.outcome === 'succeeded') {
      await this.completeProcessAfterTransfer(settlement, now, { justTransferred: true });
    }
    await this.afterCommit(settlement, now);
    return {
      outcome: result.outcome,
      ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      ...(result.transient === undefined ? {} : { transient: result.transient }),
      settlement,
    };
  }

  /**
   * Automatische Übertragung (Job-Handler, §§34/79/80): dieselbe Boundary wie
   * manuell; alle Vorbedingungen werden unter der Settlement-Sperre und
   * erneut in der Transfersperre geprüft. `skipped` ist kein Fehler.
   */
  async runAutoTransfer(
    settlementId: string,
    now = new Date(),
  ): Promise<{
    outcome: 'succeeded' | 'already_succeeded' | 'skipped' | 'failed';
    errorCode?: string;
    transient?: boolean;
    /** Phase 10: übersprungen wegen aktivem Claim eines anderen Workers – Job zu diesem Zeitpunkt erneut einreihen. */
    retryAt?: Date;
  }> {
    if (!this.transfers.isConfigured()) return { outcome: 'skipped' };
    const transferId = await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(settlements)
        .where(eq(settlements.id, settlementId))
        .for('update');
      const settlement = rows[0];
      if (settlement === undefined) return null;
      // Fristvergleich gegen die DB-Zeit: ein exakt zu wait_until beanspruchter Job
      // darf nicht an einer abweichenden JS-Uhr scheitern.
      const dbNow = await this.dbNow(tx);
      if (settlement.accountingTransferId !== null) {
        // Bereits vorbereitet/übertragen/fehlgeschlagen: Retry bzw. already_succeeded über die Boundary.
        if (settlement.lockedAt !== null) return settlement.accountingTransferId;
        const blockers = await this.transferBlockers(tx, settlement, 'auto', dbNow);
        return blockers.length > 0 ? null : settlement.accountingTransferId;
      }
      const blockers = await this.transferBlockers(tx, settlement, 'auto', dbNow);
      if (blockers.length > 0) return null;
      return this.prepareTransferWithin(tx, settlement, now);
    });
    if (transferId === null) {
      // Übersprungen: ggf. neue Job-Generation, falls die Übertragung inzwischen zulässig ist.
      // Eine nicht (mehr) existierende Abrechnung ist kein Fehler – der Job endet still
      // (kein Dauer-Retry bis „dead“).
      const current = await this.db
        .select()
        .from(settlements)
        .where(eq(settlements.id, settlementId));
      if (current[0] !== undefined) await this.afterCommit(current[0], now);
      return { outcome: 'skipped' };
    }
    const result = await this.transfers.execute(transferId, this.executeHooks('auto', now), now);
    const settlement = await this.byId(settlementId);
    if (result.outcome === 'succeeded') {
      await this.completeProcessAfterTransfer(settlement, now, { justTransferred: true });
    }
    await this.afterCommit(settlement, now);
    return {
      outcome: result.outcome,
      ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      ...(result.transient === undefined ? {} : { transient: result.transient }),
      ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }),
    };
  }

  // ── Anzahlungen / Kautionen (§§17–20) ───────────────────────────────────

  private async settlementForBookingLocked(
    tx: DatabaseTransaction,
    bookingId: string,
  ): Promise<SettlementRow | null> {
    const rows = await tx
      .select()
      .from(settlements)
      .where(eq(settlements.bookingId, bookingId))
      .for('update');
    return rows[0] ?? null;
  }

  /** Mutation an Zahlungen: existiert eine Abrechnung, wird sie gesperrt geprüft und neu aufgebaut. */
  private async paymentMutation(
    bookingId: string,
    now: Date,
    fn: (tx: DatabaseTransaction, settlement: SettlementRow | null) => Promise<void>,
    options: { requireMutableSettlement: boolean } = { requireMutableSettlement: true },
  ): Promise<void> {
    const settlement = await this.db.transaction(async (tx) => {
      const locked = await this.settlementForBookingLocked(tx, bookingId);
      if (locked !== null && options.requireMutableSettlement) this.assertMutable(locked);
      await fn(tx, locked);
      if (locked === null || !this.isMutable(locked)) return null;
      const fresh = await this.lockSettlement(tx, locked.id);
      return this.rebuildWithin(tx, fresh, now, { bumpVersion: true });
    });
    if (settlement !== null) await this.afterCommit(settlement, now);
  }

  async recordAdvance(
    actorId: string,
    bookingId: string,
    input: {
      amountCents: number;
      receivedAt: string;
      externalReference?: string | null | undefined;
    },
    now = new Date(),
  ): Promise<AdvancePaymentRow> {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new AuthError('VALIDATION', 'Der Betrag muss ein positiver Cent-Betrag sein.');
    }
    const booking = await this.bookingById(bookingId, this.db);
    let created: AdvancePaymentRow | undefined;
    await this.paymentMutation(booking.id, now, async (tx) => {
      const inserted = await tx
        .insert(bookingAdvancePayments)
        .values({
          bookingId: booking.id,
          processId: booking.processId,
          amountCents: input.amountCents,
          receivedAt: input.receivedAt,
          externalReference:
            (input.externalReference ?? '').trim() === '' ? null : input.externalReference!.trim(),
          status: 'active',
          recordedBy: actorId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      created = inserted[0];
    });
    if (created === undefined)
      throw new AuthError('CONFLICT', 'Anzahlung konnte nicht erfasst werden.');
    return created;
  }

  async cancelAdvance(
    actorId: string,
    advanceId: string,
    now = new Date(),
  ): Promise<AdvancePaymentRow> {
    const advance = await this.advanceById(advanceId);
    let updated: AdvancePaymentRow | undefined;
    await this.paymentMutation(advance.bookingId, now, async (tx) => {
      const rows = await tx
        .select()
        .from(bookingAdvancePayments)
        .where(eq(bookingAdvancePayments.id, advanceId))
        .for('update');
      const locked = rows[0];
      if (locked === undefined) throw new AuthError('NOT_FOUND', 'Anzahlung nicht gefunden.');
      if (locked.status !== 'active') {
        throw new SettlementError('ADVANCE_NOT_ACTIVE', 'Die Anzahlung ist bereits storniert.');
      }
      const result = await tx
        .update(bookingAdvancePayments)
        .set({ status: 'cancelled', cancelledBy: actorId, cancelledAt: now, updatedAt: now })
        .where(eq(bookingAdvancePayments.id, advanceId))
        .returning();
      updated = result[0];
    });
    if (updated === undefined)
      throw new AuthError('CONFLICT', 'Anzahlung konnte nicht storniert werden.');
    return updated;
  }

  async recordDeposit(
    actorId: string,
    bookingId: string,
    input: {
      amountCents: number;
      receivedAt: string;
      externalReference?: string | null | undefined;
    },
    now = new Date(),
  ): Promise<SecurityDepositRow> {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new AuthError('VALIDATION', 'Der Betrag muss ein positiver Cent-Betrag sein.');
    }
    const booking = await this.bookingById(bookingId, this.db);
    // Eine gehaltene Kaution ist kein Umsatz und ändert die Abrechnung nicht (§18) –
    // sie darf auch nach dem Transfer dokumentiert werden.
    const inserted = await this.db
      .insert(bookingSecurityDeposits)
      .values({
        bookingId: booking.id,
        processId: booking.processId,
        amountCents: input.amountCents,
        appliedCents: 0,
        receivedAt: input.receivedAt,
        externalReference:
          (input.externalReference ?? '').trim() === '' ? null : input.externalReference!.trim(),
        status: 'held',
        recordedBy: actorId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) throw new AuthError('CONFLICT', 'Kaution konnte nicht erfasst werden.');
    return row;
  }

  private async lockDeposit(
    tx: DatabaseTransaction,
    depositId: string,
  ): Promise<SecurityDepositRow> {
    const rows = await tx
      .select()
      .from(bookingSecurityDeposits)
      .where(eq(bookingSecurityDeposits.id, depositId))
      .for('update');
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Kaution nicht gefunden.');
    return row;
  }

  /**
   * Kaution bewusst ganz/teilweise anwenden (§19): ≤ noch gehalten, ≤ offener
   * Betrag; Rest bleibt held. Zeilensperre auf der Kaution (Reihenfolge:
   * Kaution → Settlement) verhindert Überanwendung bei parallelen Aufrufen.
   */
  async applyDeposit(
    actorId: string,
    depositId: string,
    input: { amountCents: number; version: number },
    now = new Date(),
  ): Promise<SecurityDepositRow> {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new AuthError('VALIDATION', 'Der Betrag muss ein positiver Cent-Betrag sein.');
    }
    const deposit = await this.depositById(depositId);
    let updated: SecurityDepositRow | undefined;
    const settlement = await this.db.transaction(async (tx) => {
      const locked = await this.lockDeposit(tx, depositId);
      if (locked.version !== input.version) {
        throw new SettlementError(
          'VERSION_CONFLICT',
          'Die Kaution wurde zwischenzeitlich geändert – bitte neu laden.',
        );
      }
      if (locked.status !== 'held') {
        throw new SettlementError('DEPOSIT_NOT_HELD', 'Die Kaution wird nicht mehr gehalten.');
      }
      const settlementRow = await this.settlementForBookingLocked(tx, deposit.bookingId);
      if (settlementRow === null) {
        throw new SettlementError(
          'SETTLEMENT_NOT_FOUND',
          'Die Kaution kann erst auf eine vorhandene Abrechnung angewendet werden.',
        );
      }
      this.assertMutable(settlementRow);
      const remaining = locked.amountCents - locked.appliedCents;
      if (input.amountCents > remaining) {
        throw new SettlementError(
          'DEPOSIT_EXCEEDS_HELD',
          'Es kann höchstens der noch gehaltene Kautionsbetrag angewendet werden.',
        );
      }
      if (input.amountCents > settlementRow.amountDueCents) {
        throw new SettlementError(
          'DEPOSIT_EXCEEDS_DUE',
          'Es kann höchstens der noch offene Abrechnungsbetrag angewendet werden.',
        );
      }
      const applied = locked.appliedCents + input.amountCents;
      const rows = await tx
        .update(bookingSecurityDeposits)
        .set({
          appliedCents: applied,
          status: applied >= locked.amountCents ? 'applied' : 'held',
          version: locked.version + 1,
          updatedAt: now,
        })
        .where(eq(bookingSecurityDeposits.id, depositId))
        .returning();
      updated = rows[0];
      void actorId;
      const fresh = await this.lockSettlement(tx, settlementRow.id);
      return this.rebuildWithin(tx, fresh, now, { bumpVersion: true });
    });
    await this.afterCommit(settlement, now);
    if (updated === undefined)
      throw new AuthError('CONFLICT', 'Kaution konnte nicht angewendet werden.');
    return updated;
  }

  /** „Kaution freigegeben“ dokumentiert nur den Zustand (§19) – keine Rücküberweisung. */
  async releaseDeposit(
    actorId: string,
    depositId: string,
    version: number,
    now = new Date(),
  ): Promise<SecurityDepositRow> {
    const rows = await this.db.transaction(async (tx) => {
      const locked = await this.lockDeposit(tx, depositId);
      if (locked.version !== version) {
        throw new SettlementError(
          'VERSION_CONFLICT',
          'Die Kaution wurde zwischenzeitlich geändert – bitte neu laden.',
        );
      }
      if (locked.status !== 'held') {
        throw new SettlementError('DEPOSIT_NOT_HELD', 'Die Kaution wird nicht mehr gehalten.');
      }
      return tx
        .update(bookingSecurityDeposits)
        .set({
          status: 'released',
          releasedBy: actorId,
          releasedAt: now,
          version: locked.version + 1,
          updatedAt: now,
        })
        .where(eq(bookingSecurityDeposits.id, depositId))
        .returning();
    });
    const row = rows[0];
    if (row === undefined)
      throw new AuthError('CONFLICT', 'Kaution konnte nicht freigegeben werden.');
    return row;
  }

  private advanceView(row: AdvancePaymentRow): AdvancePaymentView {
    return {
      id: row.id,
      bookingId: row.bookingId,
      amountCents: row.amountCents,
      receivedAt: row.receivedAt,
      externalReference: row.externalReference,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      cancelledAt: iso(row.cancelledAt),
    };
  }

  private depositView(row: SecurityDepositRow): SecurityDepositView {
    return {
      id: row.id,
      bookingId: row.bookingId,
      amountCents: row.amountCents,
      appliedCents: row.appliedCents,
      remainingHeldCents: row.status === 'held' ? row.amountCents - row.appliedCents : 0,
      receivedAt: row.receivedAt,
      externalReference: row.externalReference,
      status: row.status,
      releasedAt: iso(row.releasedAt),
      version: row.version,
    };
  }

  private async paymentRows(bookingId: string) {
    const advances = await this.db
      .select()
      .from(bookingAdvancePayments)
      .where(eq(bookingAdvancePayments.bookingId, bookingId))
      .orderBy(asc(bookingAdvancePayments.createdAt));
    const deposits = await this.db
      .select()
      .from(bookingSecurityDeposits)
      .where(eq(bookingSecurityDeposits.bookingId, bookingId))
      .orderBy(asc(bookingSecurityDeposits.createdAt));
    return { advances, deposits };
  }

  async payments(bookingId: string, effective: ReadonlySet<PermissionKey>): Promise<PaymentsView> {
    const booking = await this.bookingById(bookingId, this.db);
    const settlement = await this.byBookingId(booking.id);
    const { advances, deposits } = await this.paymentRows(booking.id);
    return {
      bookingId: booking.id,
      processId: booking.processId,
      settlement:
        settlement === null
          ? null
          : {
              id: settlement.id,
              version: settlement.version,
              locked: !this.isMutable(settlement),
              amountDueCents: settlement.amountDueCents,
            },
      advancePayments: advances.map((row) => this.advanceView(row)),
      securityDeposits: deposits.map((row) => this.depositView(row)),
      totals: {
        activeAdvanceCents: advances
          .filter((row) => row.status === 'active')
          .reduce((sum, row) => sum + row.amountCents, 0),
        heldDepositCents: deposits
          .filter((row) => row.status === 'held')
          .reduce((sum, row) => sum + (row.amountCents - row.appliedCents), 0),
        appliedDepositCents: deposits.reduce((sum, row) => sum + row.appliedCents, 0),
      },
      permissions: {
        canRecordAdvance: effective.has('deposit.record_advance'),
        canRecordDeposit: effective.has('deposit.record_security'),
        canApplyDeposit: effective.has('deposit.retain_security'),
        canReleaseDeposit: effective.has('deposit.refund_security'),
      },
    };
  }

  // ── Ansichten ────────────────────────────────────────────────────────────

  /** Fakten/Status mit der Zeit abgleichen (z. B. Fristende, Phase-7-Erledigung) – nur solange veränderbar. */
  private async refresh(settlementId: string, now: Date): Promise<SettlementRow> {
    const settlement = await this.db.transaction(async (tx) => {
      const locked = await this.lockSettlement(tx, settlementId);
      if (!this.isMutable(locked)) return locked;
      return this.rebuildWithin(tx, locked, now, { bumpVersion: false });
    });
    await this.afterCommit(settlement, now);
    return settlement;
  }

  async view(
    settlementId: string,
    effective: ReadonlySet<PermissionKey>,
    now = new Date(),
  ): Promise<SettlementView> {
    const settlement = await this.refresh(settlementId, now);
    const process = await this.processById(settlement.processId, this.db);
    const lines = await this.db
      .select()
      .from(settlementLines)
      .where(eq(settlementLines.settlementId, settlement.id))
      .orderBy(asc(settlementLines.createdAt));
    const clarificationRows = await this.db
      .select()
      .from(settlementClarifications)
      .where(eq(settlementClarifications.settlementId, settlement.id))
      .orderBy(asc(settlementClarifications.createdAt));
    const clarifications: SettlementClarificationView[] = [];
    for (const row of clarificationRows) {
      const context = await this.clarificationContext(this.db, row);
      clarifications.push({
        id: row.id,
        type: row.type,
        typeLabel: CLARIFICATION_TYPE_LABELS[row.type],
        sourceId: row.sourceId,
        status: row.status,
        title: CLARIFICATION_TYPE_LABELS[row.type],
        detail: context.detail,
        resolution: row.resolution,
        resolvedAt: iso(row.resolvedAt),
        context: context.context,
      });
    }
    const noticeRow = await this.noticeRow(settlement.id);
    const { advances, deposits } = await this.paymentRows(settlement.bookingId);
    const transferRow =
      settlement.accountingTransferId === null
        ? undefined
        : await this.transfers.byId(settlement.accountingTransferId);
    const canViewReference = effective.has('accounting.view_reference');
    const mutable = this.isMutable(settlement);
    const configured = this.transfers.isConfigured();
    const pendingJob =
      settlement.lockedAt === null ? await this.pendingAutoJob(settlement.id) : null;
    const autoPlanned =
      pendingJob !== null &&
      settlement.accountingTransferId === null &&
      !settlement.manualTransferRequired;
    const openResponse = clarificationRows.some(
      (row) => row.type === 'customer_response' && row.status === 'open',
    );
    const permissions: SettlementPermissions = {
      canAddCharge: effective.has('settlement.add_manual_charge'),
      canRelease: effective.has('settlement.release'),
      canEndWait: effective.has('settlement.end_pre_notice_wait'),
      canSetDamageCost: effective.has('damage.set_cost'),
      canSetMissingCost: effective.has('missing_item.set_cost'),
      canEditCost: effective.has('damage.edit_cost_before_lexware'),
      canRecordAdvance: effective.has('deposit.record_advance'),
      canRecordDeposit: effective.has('deposit.record_security'),
      canApplyDeposit: effective.has('deposit.retain_security'),
      canReleaseDeposit: effective.has('deposit.refund_security'),
      canManualTransfer: effective.has('lexware.manual_transfer'),
      canViewReference,
    };
    const dominantAction = this.dominantAction(settlement, openResponse, configured, autoPlanned);
    if (settlement.status === 'transfer_failed' && pendingJob === null) {
      dominantAction.hint =
        'Die letzte Übertragung ist fehlgeschlagen – bitte manuell erneut übertragen.';
    }
    const accounting = await this.accountingBlock(
      settlement,
      process,
      transferRow ?? null,
      canViewReference,
      now,
    );
    if (
      accounting.provider === 'lexware' &&
      accounting.blockers.length > 0 &&
      settlement.lockedAt === null &&
      (settlement.status === 'transfer_failed' || settlement.status === 'transferring')
    ) {
      dominantAction.label = 'Lexware-Übertragung prüfen';
      dominantAction.hint = accounting.blockers.map((blocker) => blocker.label).join(' ');
    }
    // Phase 10: Transferzeile in outcome_unknown / in_progress (Claim abgelaufen) /
    // attention / failed ⇒ für die Anzeige immer „Übertragung prüfen“ (nie „Bereit“).
    const lexwareProblem =
      accounting.provider === 'lexware' &&
      settlement.lockedAt === null &&
      transferRow !== undefined &&
      (transferRow.status === 'outcome_unknown' ||
        transferRow.status === 'attention' ||
        transferRow.status === 'failed' ||
        (transferRow.status === 'in_progress' &&
          (transferRow.claimExpiresAt === null ||
            transferRow.claimExpiresAt.getTime() <= now.getTime())));
    const effectiveStatus: SettlementStatus = lexwareProblem
      ? 'transfer_failed'
      : settlement.status;
    const effectiveErrorCode =
      settlement.lastTransferErrorCode ??
      (lexwareProblem
        ? (transferRow.attentionCode ??
          transferRow.lastErrorCode ??
          (transferRow.status === 'attention' ? 'ATTENTION' : 'LEXWARE_OUTCOME_UNKNOWN'))
        : null);
    const effectiveStatusLabel =
      lexwareProblem && transferRow.status === 'attention'
        ? 'Buchhaltungsprüfung erforderlich'
        : lexwareProblem
          ? 'Lexware-Übertragung prüfen'
          : settlement.status === 'transfer_failed' && pendingJob === null
            ? TRANSFER_FAILED_MANUAL_LABEL
            : SETTLEMENT_STATUS_LABELS[settlement.status];
    if (lexwareProblem) {
      if (transferRow.status === 'attention') {
        dominantAction.key = 'locked';
        dominantAction.label = 'Buchhaltungsprüfung erforderlich';
        dominantAction.hint =
          accounting.invoice.attentionLabel ??
          'Die Übertragung erfordert eine manuelle Prüfung durch die Buchhaltung.';
      } else {
        dominantAction.key = 'retry_transfer';
        if (accounting.blockers.length === 0) {
          dominantAction.label = accounting.retryLabel;
          dominantAction.hint =
            transferRow.status === 'outcome_unknown' || transferRow.status === 'in_progress'
              ? 'Lexware hat nicht geantwortet – vor einem erneuten Versuch wird automatisch geprüft, ob die Rechnung bereits entstanden ist.'
              : 'Die letzte Übertragung ist fehlgeschlagen – bitte erneut versuchen.';
        }
      }
    }
    const notice = noticeRow === null ? null : this.noticeView(noticeRow);
    return {
      settlement: {
        id: settlement.id,
        processId: settlement.processId,
        processNumber: process.processNumber,
        customerId: process.customerId,
        bookingId: settlement.bookingId,
        returnId: settlement.returnId,
        status: effectiveStatus,
        statusLabel: effectiveStatusLabel,
        fixedTotalCents: settlement.fixedTotalCents,
        variableTotalCents: settlement.variableTotalCents,
        chargesTotalCents: settlement.chargesTotalCents,
        discountCents: lines
          .filter((line) => line.type === 'discount')
          .reduce((sum, line) => sum + line.amountCents, 0),
        creditsTotalCents: settlement.creditsTotalCents,
        grossTotalCents:
          settlement.fixedTotalCents + settlement.variableTotalCents + settlement.chargesTotalCents,
        amountDueCents: settlement.amountDueCents,
        overpaymentCents: settlement.overpaymentCents,
        overpaymentHint: settlement.overpaymentCents > 0 ? OVERPAYMENT_HINT : null,
        noticeRequired: settlement.noticeRequired,
        noticeSentAt: iso(settlement.noticeSentAt),
        waitUntil: iso(settlement.waitUntil),
        customerResponseReceivedAt: iso(settlement.customerResponseReceivedAt),
        amountsChangedAfterNoticeAt: iso(settlement.amountsChangedAfterNoticeAt),
        manualTransferRequired: settlement.manualTransferRequired,
        releasedAt: iso(settlement.releasedAt),
        earlyReleasedAt: iso(settlement.earlyReleasedAt),
        lockedAt: iso(settlement.lockedAt),
        transferredAt: iso(settlement.transferredAt),
        locked: !mutable,
        accountingProvider: settlement.accountingProvider,
        accountingReference: canViewReference ? settlement.accountingReference : null,
        accountingReferenceVisible: canViewReference,
        paymentStatus: settlement.paymentStatus,
        paymentStatusLabel:
          settlement.paymentStatus === null
            ? null
            : PAYMENT_STATUS_LABELS[settlement.paymentStatus],
        lastTransferErrorCode: effectiveErrorCode,
        accountingBlocker: !configured && settlement.lockedAt === null ? 'not_configured' : null,
        accounting,
        invoiceDeliveryStatus: settlement.invoiceDeliveryStatus,
        autoTransferPlannedAt: autoPlanned ? pendingJob.runAt.toISOString() : null,
        version: settlement.version,
        createdAt: settlement.createdAt.toISOString(),
        updatedAt: settlement.updatedAt.toISOString(),
      },
      lines: lines.map((line) => ({
        id: line.id,
        type: line.type,
        typeLabel: LINE_TYPE_LABELS[line.type],
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPriceCents: line.unitPriceCents,
        amountCents: line.amountCents,
        direction: lineDirection(line.type),
        sourceType: line.sourceType,
        sourceId: line.sourceId,
        internalNote: line.internalNote,
        editable: mutable && EDITABLE_LINE_TYPES.includes(line.type),
        removable: mutable && EDITABLE_LINE_TYPES.includes(line.type),
        createdAt: line.createdAt.toISOString(),
        updatedAt: line.updatedAt.toISOString(),
      })),
      clarifications,
      notice:
        notice === null
          ? null
          : {
              id: notice.id,
              status: notice.status,
              recipientEmail: notice.recipientEmail,
              subject: notice.subject,
              bodyText: notice.bodyText,
              totalCents: notice.totalCents,
              approvedAt: notice.approvedAt,
              sentAt: notice.sentAt,
              gateway: notice.gateway,
              gatewayReference: notice.gatewayReference,
              blockedReason: notice.blockedReason,
            },
      advancePayments: advances.map((row) => this.advanceView(row)),
      securityDeposits: deposits.map((row) => this.depositView(row)),
      transfer:
        transferRow === undefined
          ? null
          : {
              id: transferRow.id,
              status: transferRow.status,
              attempts: transferRow.attempts,
              lastErrorCode: transferRow.lastErrorCode,
              externalReference: canViewReference ? transferRow.externalReference : null,
              paymentStatus: transferRow.paymentStatus,
              transferredAt: iso(transferRow.transferredAt),
              provider: transferRow.provider,
              mock: transferRow.provider === 'mock',
            },
      dominantAction,
      permissions,
      mock: {
        isMock: this.transfers.provider === 'mock',
        // Phase 10: „fällige Jobs ausführen“ wird auch mit Lexware-Fake außerhalb von
        // production gebraucht (E2E ohne Worker); Zahlungs-/Fehlersimulation nur bei isMock.
        controlsAvailable: this.appEnv !== 'production' && configured,
      },
    };
  }

  /**
   * Buchhaltungsblock (Phase 10, Vertrag §6): Blocker über dieselbe
   * Readiness-Prüfung wie der Transferpfad (ohne externen Aufruf), Rechnungs-
   * daten aus lexware_invoice_mappings, Referenz/Deeplink nur mit Recht.
   */
  private async accountingBlock(
    settlement: SettlementRow,
    process: Process,
    transferRow: AccountingTransferRow | null,
    canViewReference: boolean,
    now: Date,
  ): Promise<AccountingBlockView> {
    const provider = this.transfers.provider;
    let blockers: AccountingBlockView['blockers'] = [];
    if (
      provider === 'lexware' &&
      settlement.lockedAt === null &&
      transferRow?.status !== 'succeeded'
    ) {
      try {
        const payload =
          transferRow === null
            ? await this.buildPayload(this.db, settlement, now)
            : (transferRow.snapshot as AccountingPayload);
        blockers = await this.transfers.readiness(payload, process.customerId);
      } catch (error) {
        this.logger.warn(
          { settlementId: settlement.id, error: error instanceof Error ? error.name : 'unknown' },
          'Buchhaltungs-Blocker konnten nicht ermittelt werden',
        );
      }
    }
    const mapping =
      transferRow === null ? null : await this.transfers.invoiceMapping(transferRow.id);
    return buildAccountingBlock({
      provider,
      blockers,
      transfer: transferRow,
      mapping,
      localPaymentStatus: settlement.paymentStatus,
      localDeliveryStatus: settlement.invoiceDeliveryStatus,
      canViewReference,
      deeplink:
        mapping?.lexwareInvoiceId === undefined || mapping?.lexwareInvoiceId === null
          ? null
          : this.transfers.invoiceDeeplink(mapping.lexwareInvoiceId),
      now,
    });
  }

  private dominantAction(
    settlement: SettlementRow,
    openCustomerResponse: boolean,
    configured: boolean,
    jobPending: boolean,
  ): SettlementView['dominantAction'] {
    switch (settlement.status) {
      case 'transferred':
        return {
          key: 'locked',
          label: 'An Buchhaltung übertragen',
          hint: 'Die Abrechnung ist gesperrt und kann nicht mehr geändert werden.',
        };
      case 'transfer_failed':
        return {
          key: 'retry_transfer',
          label: 'Übertragung erneut versuchen',
          hint: 'Die letzte Übertragung ist fehlgeschlagen – sie wird automatisch erneut versucht oder kann jetzt manuell angestoßen werden.',
        };
      case 'transferring':
        return {
          key: 'auto_planned',
          label: 'Übertragung geplant',
          hint: 'Die Übertragung an die Buchhaltung ist vorbereitet; Beträge sind gesperrt.',
        };
      case 'clarification_required':
        return openCustomerResponse
          ? {
              key: 'release_as_calculated',
              label: 'Wie berechnet freigeben',
              hint: 'Der Kunde hat sich gemeldet: wie berechnet freigeben, Betrag ändern oder Position entfernen.',
            }
          : {
              key: 'resolve_clarifications',
              label: 'Offene Klärungen bearbeiten',
              hint: 'Offene Schaden-/Fehlteilkosten entscheiden (berechnen oder nicht berechnen).',
            };
      case 'customer_notice_required':
        return {
          key: 'review_notice',
          label: 'Kundeninformation prüfen',
          hint: 'Vor der Belastung wird der Kunde einmal informiert – bitte prüfen, freigeben und senden.',
        };
      case 'customer_waiting':
        return {
          key: 'wait',
          label: 'Kundenrückmeldung abwarten',
          hint: 'Nach Ablauf der Frist läuft die Abrechnung automatisch weiter, sofern keine Rückmeldung eingeht.',
        };
      case 'ready_for_accounting':
      case 'preparing':
      default:
        if (!configured) {
          return {
            key: 'not_configured',
            label: 'Buchhaltungsintegration noch nicht eingerichtet',
            hint: 'Die Abrechnung ist bereit; eine Übertragung ist in dieser Umgebung nicht konfiguriert.',
          };
        }
        if (settlement.manualTransferRequired || !jobPending) {
          return {
            key: 'transfer_now',
            label: 'Jetzt an Buchhaltung übertragen',
            hint: 'Die Übertragung erfolgt bewusst manuell.',
          };
        }
        return {
          key: 'auto_planned',
          label: 'Übertragung geplant',
          hint: 'Die Abrechnung wird automatisch an die Buchhaltung übertragen.',
        };
    }
  }
}
