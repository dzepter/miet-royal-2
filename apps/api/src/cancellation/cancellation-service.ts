import type { AppConfig } from '@mietroyal/config';
import {
  appointments,
  bookingAdvancePayments,
  bookingSecurityDeposits,
  bookings,
  cancellations,
  handovers,
  machineAssignments,
  machineRiskIncidents,
  machines,
  processRelations,
  processes,
  rentalReturns,
  type Booking,
  type Database,
  type DatabaseExecutor,
  type MachineAssignment,
  type Process,
} from '@mietroyal/database';
import {
  calculateCancellation,
  cancellationChargeDescription,
  type CancellationBaseItem,
  type CancellationCalculation,
} from '@mietroyal/domain';
import type { StorageProvider } from '@mietroyal/integrations';
import { alias } from 'drizzle-orm/pg-core';
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  cancellationTransferIdempotencyKey,
  type AccountingPayload,
  type AccountingTransferResult,
} from '../accounting/gateway.ts';
import type {
  AccountingTransferRow,
  AccountingTransferService,
} from '../accounting/transfer-service.ts';
import { AuthError } from '../auth/service.ts';
import { buildAccountingBlock, type AccountingBlockView } from '../lexware/transfer-readiness.ts';
import { ProcessService, type ProcessCompletionListener } from '../crm/process-service.ts';
import { AssignmentService } from '../handover/assignment-service.ts';
import { SchedulingService } from '../scheduling/scheduling-service.ts';
import { MachineService } from '../warehouse/machine-service.ts';
import { VoucherService } from '../voucher/voucher-service.ts';
import {
  transactionalStatusOf,
  type CancellationConfirmationMailer,
} from '../communication/transactional/mailers.ts';

/**
 * Storno einer bestätigten, noch nicht ausgegebenen Buchung (Phase-9-
 * Vorgabe §§49–§64, §83). Grundsätze:
 *
 * - Die Berechnung (Kalendertage Europe/Berlin, Satz, Basis aus den
 *   eingefrorenen regulären Maschinen-Listenpreisen, Rundung) lebt
 *   ausschließlich in @mietroyal/domain `calculateCancellation`; der Client
 *   sendet nie Prozentsatz oder Basis.
 * - EINE Transaktion: Vorgang und Buchung werden zuerst gesperrt, danach
 *   genau in der Sperrreihenfolge der Übergabe-Finalisierung (Advisory-Lock
 *   der Übergabe, handovers-Zeile, Slot-Zeilen nach slotNo, Advisory-Locks
 *   der Maschinen sortiert, Termine). Storno und Finalisierung sehen sich
 *   deshalb gegenseitig: genau einer gewinnt, nie „issued UND cancelled“.
 *   Die Vorgangs-/Buchungszeilen werden FOR NO KEY UPDATE gesperrt – das
 *   serialisiert mit allen Statusmutationen des Vorgangs, kollidiert aber
 *   nicht mit den FK-KEY-SHARE-Sperren, die die Finalisierung beim Anlegen
 *   von Dokumenten/Versandpaketen auf dieselben Zeilen nimmt (sonst
 *   Deadlock statt sauberem 409).
 * - Ressourcen werden sofort freigegeben (Termine storniert, nicht
 *   ausgegebene Zuordnungen gelöst, Reserviert sauber zurück, Risiko-
 *   Incidents nach dem Commit neu bewertet, ephemere Telefonnummern
 *   gelöscht). KEINE Lagerbewegungen, keine Übergabe/Rückgabe.
 * - Gebühr > 0 ⇒ Transferzeile mit eingefrorenem Payload (eine Kundenzeile
 *   „Stornokosten gemäß Mietbedingungen – Vorgang MR-…“) und Job auf der
 *   bestehenden Queue; in production ohne Buchhaltungsanbindung kein Job,
 *   dafür der konfigurative Blocker „nicht konfiguriert“.
 */

export type CancellationRow = typeof cancellations.$inferSelect;
export type CancelerType = CancellationRow['cancelerType'];
export type CancellationFinanceStatus = CancellationRow['financeStatus'];

export const CANCELLATION_FINANCE_STATUS_LABELS: Record<CancellationFinanceStatus, string> = {
  no_invoice: 'Storniert – ohne Rechnung',
  accounting_pending: 'Stornorechnung – Buchhaltung ausstehend',
  invoice_open: 'Stornorechnung offen',
  paid: 'Stornorechnung bezahlt',
};

const PAYMENT_STATUS_LABELS: Record<'open' | 'paid' | 'overdue', string> = {
  open: 'Offen',
  paid: 'Bezahlt',
  overdue: 'Überfällig',
};

export const EXTERNAL_REFUND_REVIEW_HINT = 'Externe Rückzahlung/Verrechnung prüfen';

/** 409 mit Grund (Route: Code CANCELLATION_BLOCKED). */
export class CancellationBlockedError extends AuthError {
  constructor(readonly blockers: readonly string[]) {
    super('CONFLICT', `Storno nicht möglich: ${blockers.join(' ')}`);
    this.name = 'CancellationBlockedError';
  }
}

/** 409 mit vorhandener Folgevorgangsnummer (Route: Code FOLLOW_UP_EXISTS). */
export class FollowUpExistsError extends AuthError {
  constructor(readonly followUp: { id: string; processNumber: string }) {
    super(
      'CONFLICT',
      `Zu diesem Storno existiert bereits der Folgevorgang ${followUp.processNumber}.`,
    );
    this.name = 'FollowUpExistsError';
  }
}

export interface CancellationViewer {
  permissions: ReadonlySet<string>;
  isAdmin: boolean;
}

export interface ReleasedResources {
  appointments: number;
  assignments: number;
  machines: number;
  riskIncidents: number;
}

export interface CancellationPreview {
  eventDate: string | null;
  remainingDays: number | null;
  feePercent: number | null;
  baseCents: number | null;
  feeCents: number | null;
  roundingMethod: string | null;
  machines: { description: string; quantity: number; standardUnitPriceCents: number }[];
  willRelease: { appointments: number; assignments: number; reservedMachines: number };
  blockers: string[];
  externalRefundReviewRequired: boolean;
  accountingConfigured: boolean;
}

export interface CancellationTransferView {
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

export interface CancellationView {
  id: string;
  processId: string;
  processNumber: string;
  cancelerType: CancelerType;
  cancelerStaffId: string | null;
  cancelledAt: string;
  eventDate: string;
  remainingDays: number;
  feePercent: number;
  baseCents: number;
  feeCents: number;
  roundingMethod: string;
  financeStatus: CancellationFinanceStatus;
  financeStatusLabel: string;
  accountingProvider: CancellationRow['accountingProvider'];
  accountingReference: string | null;
  accountingReferenceVisible: boolean;
  paymentStatus: CancellationRow['paymentStatus'];
  paymentStatusLabel: string | null;
  transferredAt: string | null;
  lastTransferErrorCode: string | null;
  accountingBlocker: 'not_configured' | null;
  /** Phase 10 (Vertrag §6): Provider, Blocker, Rechnungsdaten, Retry-Freigabe. */
  accounting: AccountingBlockView;
  /** Phase 10: Rechnungsversand – 'pending' bis Phase 12 versendet; nie automatisch 'sent'. */
  invoiceDeliveryStatus: string | null;
  /** Kunde des Vorgangs (Kontakt-Klärung bei CONTACT_REVIEW_REQUIRED). */
  customerId: string;
  releasedResources: ReleasedResources;
  confirmationStatus: string;
  confirmationSentAt: string | null;
  externalRefundReviewRequired: boolean;
  externalRefundReviewHint: string | null;
  reopenedAt: string | null;
  followUpProcess: { id: string; processNumber: string } | null;
  transfer: CancellationTransferView | null;
  permissions: {
    canManualTransfer: boolean;
    canSendConfirmation: boolean;
    canCreateFollowUp: boolean;
    canViewReference: boolean;
  };
}

export interface ProcessRelationsView {
  previousProcess: { id: string; processNumber: string } | null;
  followUpProcess: { id: string; processNumber: string } | null;
}

export interface CancellationLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

const noopLogger: CancellationLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface CancellationServiceDeps {
  db: Database;
  config: AppConfig;
  transfers: AccountingTransferService;
  assignments: AssignmentService;
  scheduling: SchedulingService;
  processes: ProcessService;
  /** Phase 12 (Order §14): Stornobestätigung über die Mail-Outbox; null = kein Versandweg (blocked). */
  confirmations: CancellationConfirmationMailer | null;
  logger?: CancellationLogger;
  /** Phase 11: Gutschein-Reaktivierung/-Verbrauch beim Storno (Default: eigene Instanz). */
  vouchers?: VoucherService;
}

/** Komposition wie in den Routen (ein Aufbau für Routen, Jobs und Tests). */
export function createCancellationService(input: {
  db: Database;
  config: AppConfig;
  storage: StorageProvider;
  transfers: AccountingTransferService;
  confirmations?: CancellationConfirmationMailer | null;
  logger?: CancellationLogger;
  /** Phase-12-Finalisierung (Retention): Nach-Commit-Listener des Statusübergangs „storniert“. */
  processListeners?: readonly ProcessCompletionListener[];
}): CancellationService {
  const machineService = new MachineService(input.db, input.storage);
  return new CancellationService({
    db: input.db,
    config: input.config,
    transfers: input.transfers,
    assignments: new AssignmentService(input.db, machineService, input.storage),
    scheduling: new SchedulingService(input.db),
    processes: new ProcessService(input.db, input.processListeners ?? []),
    confirmations: input.confirmations ?? null,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });
}

// ── Snapshot-Hilfen ───────────────────────────────────────────────────────

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

interface SnapshotMachineItem extends CancellationBaseItem {
  description: string;
}

/** Maschinenpositionen des eingefrorenen Buchungs-Snapshots (Order §51). */
export function snapshotItems(booking: Pick<Booking, 'itemsSnapshot'>): SnapshotMachineItem[] {
  const raw = Array.isArray(booking.itemsSnapshot) ? booking.itemsSnapshot : [];
  const items: SnapshotMachineItem[] = [];
  for (const entry of raw) {
    const item = record(entry);
    const kind = str(item.kind) ?? '';
    const quantity = typeof item.quantity === 'number' ? item.quantity : 0;
    const standardUnitPriceCents =
      typeof item.standardUnitPriceCents === 'number' ? item.standardUnitPriceCents : 0;
    items.push({
      kind,
      quantity,
      standardUnitPriceCents,
      description: str(item.description) ?? '',
    });
  }
  return items;
}

/** Eventdatum: eingefrorener Buchungs-Snapshot, sonst Vorgang. */
function eventDateOf(booking: Pick<Booking, 'eventSnapshot'>, process: Process): string | null {
  const snapshot = record(booking.eventSnapshot);
  return str(snapshot.eventDate) ?? process.eventDate ?? null;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export class CancellationService {
  private readonly db: Database;
  private readonly transfers: AccountingTransferService;
  private readonly assignments: AssignmentService;
  private readonly scheduling: SchedulingService;
  private readonly processes: ProcessService;
  private readonly confirmations: CancellationConfirmationMailer | null;
  private readonly logger: CancellationLogger;
  private readonly vouchers: VoucherService;

  constructor(deps: CancellationServiceDeps) {
    this.db = deps.db;
    this.transfers = deps.transfers;
    this.assignments = deps.assignments;
    this.scheduling = deps.scheduling;
    this.processes = deps.processes;
    this.confirmations = deps.confirmations;
    this.logger = deps.logger ?? noopLogger;
    this.vouchers = deps.vouchers ?? new VoucherService(deps.db, deps.config);
  }

  // ── Laden ───────────────────────────────────────────────────────────────

  async byId(cancellationId: string, executor: DatabaseExecutor = this.db) {
    const rows = await executor
      .select()
      .from(cancellations)
      .where(eq(cancellations.id, cancellationId));
    return rows[0] ?? null;
  }

  async byProcessId(processId: string, executor: DatabaseExecutor = this.db) {
    const rows = await executor
      .select()
      .from(cancellations)
      .where(eq(cancellations.processId, processId));
    return rows[0] ?? null;
  }

  private async processById(processId: string, executor: DatabaseExecutor = this.db) {
    const rows = await executor.select().from(processes).where(eq(processes.id, processId));
    const process = rows[0];
    if (process === undefined) throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
    return process;
  }

  private async bookingForProcess(processId: string, executor: DatabaseExecutor = this.db) {
    const rows = await executor.select().from(bookings).where(eq(bookings.processId, processId));
    return rows[0] ?? null;
  }

  // ── Blocker (Order §50) ─────────────────────────────────────────────────

  private computeBlockers(input: {
    process: Process;
    booking: Booking | null;
    handoverStatus: string | null;
    assignments: readonly MachineAssignment[];
    returnExists: boolean;
    alreadyCancelled: boolean;
  }): string[] {
    const blockers: string[] = [];
    if (input.alreadyCancelled || input.process.mainStatus === 'cancelled') {
      blockers.push('Der Vorgang ist bereits storniert.');
    } else if (input.process.mainStatus === 'completed') {
      blockers.push('Der Vorgang ist abgeschlossen – bitte zuerst wieder öffnen.');
    }
    if (input.booking === null) {
      blockers.push('Der Vorgang hat keine bestätigte Buchung.');
    }
    if (input.handoverStatus === 'finalized') {
      blockers.push(
        'Die Übergabe ist bereits abgeschlossen – nach der Ausgabe ist kein Storno mehr möglich (Rückgabe und Abrechnung).',
      );
    }
    if (input.assignments.some((a) => a.status === 'issued' || a.status === 'returned')) {
      blockers.push('Mindestens eine Maschine wurde bereits ausgegeben.');
    }
    if (input.returnExists) {
      blockers.push('Für die Buchung existiert bereits eine Rückgabe.');
    }
    return blockers;
  }

  private async externalRefundReviewRequired(
    executor: DatabaseExecutor,
    bookingId: string,
  ): Promise<boolean> {
    const advances = await executor
      .select({ id: bookingAdvancePayments.id })
      .from(bookingAdvancePayments)
      .where(
        and(
          eq(bookingAdvancePayments.bookingId, bookingId),
          eq(bookingAdvancePayments.status, 'active'),
        ),
      )
      .limit(1);
    if (advances.length > 0) return true;
    const deposits = await executor
      .select({ id: bookingSecurityDeposits.id })
      .from(bookingSecurityDeposits)
      .where(
        and(
          eq(bookingSecurityDeposits.bookingId, bookingId),
          or(
            inArray(bookingSecurityDeposits.status, ['held', 'applied']),
            gt(bookingSecurityDeposits.appliedCents, 0),
          ),
        ),
      )
      .limit(1);
    return deposits.length > 0;
  }

  private calculate(process: Process, booking: Booking, now: Date): CancellationCalculation {
    const eventDate = eventDateOf(booking, process);
    if (eventDate === null) {
      throw new AuthError(
        'CONFLICT',
        'Für die Buchung ist kein Eventdatum hinterlegt – die Stornoregel kann nicht angewendet werden.',
      );
    }
    return calculateCancellation({
      eventDate,
      cancelledAt: now,
      items: snapshotItems(booking),
    });
  }

  // ── Vorschau (Order §53) ────────────────────────────────────────────────

  async preview(processId: string, now = new Date()): Promise<CancellationPreview> {
    const process = await this.processById(processId);
    const booking = await this.bookingForProcess(processId);
    const existing = await this.byProcessId(processId);
    const handoverRows =
      booking === null
        ? []
        : await this.db
            .select({ status: handovers.status })
            .from(handovers)
            .where(eq(handovers.bookingId, booking.id));
    const assignmentRows = await this.db
      .select()
      .from(machineAssignments)
      .where(eq(machineAssignments.processId, processId))
      .orderBy(asc(machineAssignments.slotNo));
    const returnRows =
      booking === null
        ? []
        : await this.db
            .select({ id: rentalReturns.id })
            .from(rentalReturns)
            .where(eq(rentalReturns.bookingId, booking.id));
    const blockers = this.computeBlockers({
      process,
      booking,
      handoverStatus: handoverRows[0]?.status ?? null,
      assignments: assignmentRows,
      returnExists: returnRows.length > 0,
      alreadyCancelled: existing !== null,
    });
    const scheduled = await this.db
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(eq(appointments.processId, processId), eq(appointments.status, 'scheduled')));
    const unissued = assignmentRows.filter(
      (a) => a.status === 'assigned' || a.status === 'prepared',
    );
    const preparedMachineIds = [
      ...new Set(
        unissued
          .filter((a) => a.status === 'prepared')
          .map((a) => a.machineId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const reservedRows =
      preparedMachineIds.length === 0
        ? []
        : await this.db
            .select({ id: machines.id })
            .from(machines)
            .where(and(inArray(machines.id, preparedMachineIds), eq(machines.status, 'reserved')));

    let calculation: CancellationCalculation | null = null;
    if (booking !== null && eventDateOf(booking, process) !== null) {
      calculation = this.calculate(process, booking, now);
    } else if (booking !== null) {
      blockers.push('Für die Buchung ist kein Eventdatum hinterlegt.');
    }
    const machineItems =
      booking === null ? [] : snapshotItems(booking).filter((item) => item.kind === 'machine');
    return {
      eventDate: calculation?.eventDate ?? null,
      remainingDays: calculation?.remainingDays ?? null,
      feePercent: calculation?.feePercent ?? null,
      baseCents: calculation?.baseCents ?? null,
      feeCents: calculation?.feeCents ?? null,
      roundingMethod: calculation?.roundingMethod ?? null,
      machines: machineItems.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        standardUnitPriceCents: item.standardUnitPriceCents,
      })),
      willRelease: {
        appointments: scheduled.length,
        assignments: unissued.length,
        reservedMachines: reservedRows.length,
      },
      blockers,
      externalRefundReviewRequired:
        booking === null ? false : await this.externalRefundReviewRequired(this.db, booking.id),
      accountingConfigured: this.transfers.isConfigured(),
    };
  }

  // ── Storno (Order §§54–§58, §83) ────────────────────────────────────────

  async cancel(
    processId: string,
    actor: { id: string; type: 'employee' | 'admin' },
    viewer: CancellationViewer,
    now = new Date(),
  ): Promise<CancellationView> {
    const evidenceKeys: string[] = [];
    const outcome = await this.db.transaction(async (tx) => {
      // 1. Vorgang, dann Buchung sperren (FOR NO KEY UPDATE – siehe Kopf).
      const processRows = await tx
        .select()
        .from(processes)
        .where(eq(processes.id, processId))
        .for('no key update');
      const process = processRows[0];
      if (process === undefined) throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
      const existing = await this.byProcessId(processId, tx);
      if (existing !== null) {
        // Doppelstorno (Test 119/121): idempotent, nie eine zweite Belastung.
        if (process.mainStatus === 'cancelled') return { kind: 'existing' as const, row: existing };
        throw new AuthError(
          'CONFLICT',
          'Der Vorgang wurde nach einem Storno wieder geöffnet – ein erneutes Storno ist nicht vorgesehen.',
        );
      }
      const bookingRows = await tx
        .select()
        .from(bookings)
        .where(eq(bookings.processId, processId))
        .for('no key update');
      const booking = bookingRows[0] ?? null;

      // 2. Sperrreihenfolge der Übergabe-Finalisierung nachziehen.
      let handoverStatus: string | null = null;
      if (booking !== null) {
        const handoverIds = await tx
          .select({ id: handovers.id })
          .from(handovers)
          .where(eq(handovers.bookingId, booking.id));
        const handoverId = handoverIds[0]?.id;
        if (handoverId !== undefined) {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${'handover-finalize:' + handoverId}))`,
          );
          const lockedHandover = await tx
            .select({ status: handovers.status })
            .from(handovers)
            .where(eq(handovers.id, handoverId))
            .for('no key update');
          handoverStatus = lockedHandover[0]?.status ?? null;
        }
      }
      const assignmentRows = await this.assignments.lockAssignmentsForProcess(tx, processId);
      const returnRows =
        booking === null
          ? []
          : await tx
              .select({ id: rentalReturns.id })
              .from(rentalReturns)
              .where(eq(rentalReturns.bookingId, booking.id));

      // 3. Blocker unter Sperre prüfen (kein TOCTOU).
      const blockers = this.computeBlockers({
        process,
        booking,
        handoverStatus,
        assignments: assignmentRows,
        returnExists: returnRows.length > 0,
        alreadyCancelled: false,
      });
      if (blockers.length > 0 || booking === null) {
        throw new CancellationBlockedError(
          blockers.length > 0 ? blockers : ['Der Vorgang hat keine bestätigte Buchung.'],
        );
      }

      // 4. Berechnung – ausschließlich Domänenregel.
      const calculation = this.calculate(process, booking, now);

      // 5. Ressourcen freigeben (Order §56) – keine Lagerbewegungen. Offene
      //    Risikohinweise des Vorgangs werden sofort geschlossen (wie die
      //    Neubewertung es täte); der Refresh nach dem Commit bestätigt das.
      const closedIncidents = await tx
        .update(machineRiskIncidents)
        .set({ resolvedAt: now, resolution: 'auto' })
        .where(
          and(
            eq(machineRiskIncidents.processId, processId),
            isNull(machineRiskIncidents.resolvedAt),
          ),
        )
        .returning({ id: machineRiskIncidents.id });
      const cancelledAppointments = await this.scheduling.cancelForProcessWithin(
        tx,
        processId,
        now,
      );
      const released = await this.assignments.releaseAssignmentsWithin(
        tx,
        assignmentRows,
        now,
        evidenceKeys,
      );
      const releasedResources: ReleasedResources = {
        appointments: cancelledAppointments.appointments,
        assignments: released.assignments,
        machines: released.machines,
        riskIncidents: closedIncidents.length,
      };

      // 6. Stornierung festschreiben.
      const externalRefundReviewRequired = await this.externalRefundReviewRequired(tx, booking.id);
      const inserted = await tx
        .insert(cancellations)
        .values({
          processId,
          bookingId: booking.id,
          cancelerType: actor.type,
          cancelerStaffId: actor.id,
          cancelledAt: now,
          eventDate: calculation.eventDate,
          remainingDays: calculation.remainingDays,
          feePercent: calculation.feePercent,
          baseCents: calculation.baseCents,
          feeCents: calculation.feeCents,
          roundingMethod: calculation.roundingMethod,
          financeStatus: calculation.feeCents > 0 ? 'accounting_pending' : 'no_invoice',
          releasedResources,
          confirmationStatus: 'prepared',
          externalRefundReviewRequired,
        })
        .returning();
      let row = inserted[0];
      if (row === undefined)
        throw new AuthError('CONFLICT', 'Storno konnte nicht gespeichert werden.');

      // 7. Vorgang storniert (eine Stelle für den Statusübergang); bookings
      //    hat keine Statusspalte – die Buchung bleibt als Snapshot bestehen.
      await this.processes.markCancelledWithin(tx, processId, now);

      // 7a. Phase 11 (§§40–45): Wiedermieter-Gutschein der Buchung. 0 % ⇒
      //     derselbe Gutschein wird mit gespeicherter Restgültigkeit
      //     reaktiviert; 50/100 % ⇒ bleibt verbraucht. Beides in DIESER
      //     Transaktion (atomar); Doppelstorno kehrt oben als `existing`
      //     zurück und reaktiviert nie ein zweites Mal. Die Stornobasis
      //     (reguläre Listenpreise) ist vom Gutschein unberührt (§42).
      if (booking.voucherId !== null) {
        if (calculation.feePercent === 0) {
          await this.vouchers.reactivateForFreeCancellation(tx, {
            bookingId: booking.id,
            cancellationId: row.id,
            cancelledAt: now,
          });
        } else {
          await this.vouchers.markConsumedByPaidCancellation(tx, {
            bookingId: booking.id,
            cancellationId: row.id,
          });
        }
      }

      // 8. Gebühr > 0: Transferzeile mit eingefrorenem Payload (Order §58/§81).
      let transfer: AccountingTransferRow | null = null;
      if (calculation.feeCents > 0) {
        const payload = this.buildPayload(row, process, booking, calculation, now);
        transfer = await this.transfers.prepare(
          tx,
          { kind: 'cancellation', cancellationId: row.id, processId },
          payload,
        );
        const updated = await tx
          .update(cancellations)
          .set({
            accountingTransferId: transfer.id,
            accountingProvider: transfer.provider,
            updatedAt: now,
          })
          .where(eq(cancellations.id, row.id))
          .returning();
        row = updated[0] ?? row;
      }
      return { kind: 'created' as const, row, transfer };
    });

    if (outcome.kind === 'created') {
      this.logger.info(
        {
          cancellationId: outcome.row.id,
          processId,
          financeStatus: outcome.row.financeStatus,
          feePercent: outcome.row.feePercent,
        },
        'Buchung storniert',
      );
      await this.assignments.discardEvidence(evidenceKeys);
      // Phase-12-Finalisierung (Retention §4.1): Storno ⇒ Chatfotos sofort löschen,
      // Retention-Anker setzen (Listener reiht den Job ein; Backstop in scan_due).
      await this.processes.notifyCancelled({ processId, cancelledAt: now });
      // Risiko-Incidents nach dem Commit neu bewerten (Order §56) – nie unter Sperren.
      try {
        await this.assignments.refreshRiskIncidents(now);
      } catch (error) {
        this.logger.error(
          { processId, error: error instanceof Error ? error.name : 'unknown' },
          'Risikohinweise nach Storno konnten nicht neu bewertet werden',
        );
      }
      if (outcome.transfer !== null) await this.enqueueAuto(outcome.transfer, outcome.row.id);
    }
    return this.viewFor(outcome.row, viewer);
  }

  /**
   * Automatischer Transferjob (Order §59/§79): nur mit konfigurierter
   * Buchhaltung; production ohne Anbindung bekommt keinen Job (kein
   * Endlos-Retry), die Oberfläche zeigt den konfigurativen Blocker.
   */
  private async enqueueAuto(
    transfer: AccountingTransferRow,
    cancellationId: string,
  ): Promise<void> {
    if (!this.transfers.isConfigured()) {
      this.logger.warn(
        { cancellationId, provider: this.transfers.provider },
        'Storno-Transfer nicht eingestellt: Buchhaltungsintegration nicht konfiguriert',
      );
      return;
    }
    try {
      await this.transfers.enqueue(transfer, { reason: 'auto' });
    } catch (error) {
      // Der manuelle Transfer bleibt möglich; nichts ist verloren.
      this.logger.error(
        { cancellationId, error: error instanceof Error ? error.name : 'unknown' },
        'Storno-Transferjob konnte nicht eingestellt werden',
      );
    }
  }

  private buildPayload(
    row: CancellationRow,
    process: Process,
    booking: Booking,
    calculation: CancellationCalculation,
    now: Date,
  ): AccountingPayload {
    const customer = record(booking.customerSnapshot);
    return {
      schemaVersion: 1,
      kind: 'cancellation',
      sourceId: row.id,
      processId: process.id,
      processNumber: process.processNumber,
      bookingId: booking.id,
      eventDate: calculation.eventDate,
      customer: {
        customerId: str(customer.id) ?? booking.customerId,
        displayName: str(customer.displayName) ?? '',
        companyName: str(customer.organizationName),
        email: str(customer.email),
        billingAddress: {
          street: str(customer.billingStreet),
          postalCode: str(customer.billingPostalCode),
          city: str(customer.billingCity),
        },
      },
      // Genau EINE Position (Order §58) – keine anderen Positionen.
      lines: [
        {
          id: `cancellation-${row.id}`,
          type: 'cancellation_fee',
          description: cancellationChargeDescription(process.processNumber),
          quantity: 1,
          unit: 'Pauschale',
          unitPriceCents: calculation.feeCents,
          amountCents: calculation.feeCents,
          direction: 'charge',
        },
      ],
      totals: {
        chargesCents: calculation.feeCents,
        creditsCents: 0,
        amountDueCents: calculation.feeCents,
        overpaymentCents: 0,
      },
      cancellation: {
        originalEventDate: calculation.eventDate,
        regularMachinePriceCents: calculation.baseCents,
        feePercent: calculation.feePercent,
        feeCents: calculation.feeCents,
        remainingDays: calculation.remainingDays,
      },
      tax: null,
      idempotencyKey: cancellationTransferIdempotencyKey(row.id),
      createdAt: now.toISOString(),
    };
  }

  // ── Buchhaltungstransfer (Order §§59/60, Tests 120/121) ─────────────────

  /**
   * Gemeinsamer Pfad für Job und manuelle Übertragung: Rechecks laufen
   * INNERHALB der Transfersperre (fee > 0, Finanzstatus noch ausstehend,
   * Vorgang weiterhin storniert, nicht bereits übertragen).
   */
  async executeTransfer(
    cancellationId: string,
    now = new Date(),
  ): Promise<{
    outcome: 'succeeded' | 'already_succeeded' | 'skipped' | 'failed';
    errorCode?: string;
    /** Phase 10: false ⇒ permanenter Blocker (kein Auto-Retry). */
    transient?: boolean;
    /** Phase 10: übersprungen wegen aktivem Claim eines anderen Workers. */
    retryAt?: Date;
  }> {
    const current = await this.byId(cancellationId);
    if (current === null) throw new AuthError('NOT_FOUND', 'Stornierung nicht gefunden.');
    if (current.feeCents <= 0) {
      throw new AuthError(
        'CONFLICT',
        'Dieses Storno ist ohne Rechnung – es gibt nichts zu übertragen.',
      );
    }
    if (current.financeStatus !== 'accounting_pending') return { outcome: 'already_succeeded' };
    const transferId = current.accountingTransferId;
    if (transferId === null) {
      // Bei Gebühr > 0 entsteht die Transferzeile immer in der Storno-Transaktion.
      throw new AuthError('CONFLICT', 'Für diese Stornierung existiert keine Transferzeile.');
    }
    const result = await this.transfers.execute(
      transferId,
      {
        recheck: async (tx) => {
          const locked = await tx
            .select()
            .from(cancellations)
            .where(eq(cancellations.id, cancellationId))
            .for('update');
          const row = locked[0];
          // Die Stornogebühr bleibt auch nach einem Admin-Reopen geschuldet
          // (Storno ist historisch gültig, §63) – maßgeblich ist allein die
          // Stornozeile: vorhanden, Gebühr > 0, noch nicht übertragen.
          if (row === undefined) return false;
          return row.feeCents > 0 && row.financeStatus === 'accounting_pending';
        },
        onSuccess: async (tx, transferRow, result: AccountingTransferResult) => {
          await tx
            .update(cancellations)
            .set({
              financeStatus: 'invoice_open',
              accountingTransferId: transferRow.id,
              accountingProvider: result.provider,
              accountingReference: result.externalReference,
              paymentStatus: result.paymentStatus,
              transferredAt: now,
              lastTransferErrorCode: null,
              updatedAt: now,
            })
            .where(eq(cancellations.id, cancellationId));
        },
        onFailure: async (tx, _transferRow, code) => {
          await tx
            .update(cancellations)
            .set({ lastTransferErrorCode: code, updatedAt: now })
            .where(eq(cancellations.id, cancellationId));
        },
      },
      now,
    );
    this.logger.info(
      {
        cancellationId,
        transferId,
        outcome: result.outcome,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      },
      'Storno-Buchhaltungstransfer',
    );
    return {
      outcome: result.outcome,
      ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      ...(result.transient === undefined ? {} : { transient: result.transient }),
      ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }),
    };
  }

  /** Manuelle, synchrone Übertragung (Retry nach Fehlschlag / vorzeitig). */
  async transfer(
    cancellationId: string,
    viewer: CancellationViewer,
    now = new Date(),
  ): Promise<{ outcome: string; cancellation: CancellationView }> {
    this.transfers.assertConfigured();
    const result = await this.executeTransfer(cancellationId, now);
    const row = await this.byId(cancellationId);
    if (row === null) throw new AuthError('NOT_FOUND', 'Stornierung nicht gefunden.');
    return { outcome: result.outcome, cancellation: await this.viewFor(row, viewer) };
  }

  // ── Bestätigung (Order §61, Phase 12 Order §14) ────────────────────────

  /**
   * Bewusste Staff-Aktion: Stornobestätigung in die Mail-Outbox einreihen
   * (in dieser Transaktion, Status `queued`); versendet wird nach dem Commit
   * durch `mail.send`, `sent`/`sentAt` setzt der Sent-Listener. 0 EUR ⇒ keine
   * Rechnung; kostenpflichtig ⇒ die Stornorechnung geht getrennt über
   * `invoice.delivery`. Ohne Versandweg: `blocked` – nie vorgetäuscht.
   * Härtung RA-15: nach `failed`/`blocked` legt die erneute Aktion eine NEUE
   * Zustellung an (Retry-Schlüssel); die Antwort meldet den echten Status.
   */
  async sendConfirmation(
    cancellationId: string,
    now = new Date(),
  ): Promise<{ confirmationStatus: string; confirmationSentAt: string | null }> {
    const outcome = await this.db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(cancellations)
        .where(eq(cancellations.id, cancellationId))
        .for('update');
      const row = locked[0];
      if (row === undefined) throw new AuthError('NOT_FOUND', 'Stornierung nicht gefunden.');
      // Genau ein Versand je Storno – Doppelklick ist ein No-op.
      if (row.confirmationStatus === 'sent' || row.confirmationStatus === 'queued') {
        return {
          enqueued: null,
          response: {
            confirmationStatus: row.confirmationStatus,
            confirmationSentAt: iso(row.confirmationSentAt),
          },
        };
      }
      const process = await this.processById(row.processId, tx);
      if (row.reopenedAt !== null || process.mainStatus !== 'cancelled') {
        throw new AuthError(
          'CONFLICT',
          'Der Vorgang wurde nach dem Storno wieder geöffnet – die Stornobestätigung wird nicht versendet.',
        );
      }
      if (this.confirmations === null || !this.confirmations.isConfigured()) {
        await tx
          .update(cancellations)
          .set({ confirmationStatus: 'blocked', updatedAt: now })
          .where(eq(cancellations.id, row.id));
        return {
          enqueued: null,
          response: { confirmationStatus: 'blocked', confirmationSentAt: null },
        };
      }
      const bookingRows = await tx
        .select({
          customerId: bookings.customerId,
          customerSnapshot: bookings.customerSnapshot,
          eventSnapshot: bookings.eventSnapshot,
        })
        .from(bookings)
        .where(eq(bookings.id, row.bookingId));
      const booking = bookingRows[0];
      const customer = record(booking?.customerSnapshot);
      const event = record(booking?.eventSnapshot);
      const enqueued = await this.confirmations.enqueueWithin(tx, {
        cancellationId: row.id,
        processId: row.processId,
        processNumber: process.processNumber,
        customerId: booking?.customerId ?? process.customerId,
        bookingId: row.bookingId,
        recipient: { email: str(customer.email), name: str(customer.displayName) },
        eventDate: event.eventDate ?? process.eventDate,
        chargeCents: row.feeCents,
        now,
      });
      return {
        enqueued,
        response: {
          confirmationStatus: transactionalStatusOf(enqueued),
          confirmationSentAt: null,
        },
      };
    });
    await this.confirmations?.afterCommit(outcome.enqueued, (error) =>
      this.logger.error(
        { cancellationId, error: error instanceof Error ? error.name : 'unknown' },
        'Versandjob der Stornobestätigung konnte nicht geplant werden',
      ),
    );
    return outcome.response;
  }

  // ── Folgevorgang (Order §64) ────────────────────────────────────────────

  async createFollowUp(
    processId: string,
    actorId: string,
    now = new Date(),
  ): Promise<{ processId: string; processNumber: string }> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(processes)
        .where(eq(processes.id, processId))
        .for('no key update');
      const previous = rows[0];
      if (previous === undefined) throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
      // Erlaubt aus dem stornierten Vorgang – und aus einem wieder geöffneten
      // Vorgang MIT Stornozeile (die alte Buchung bleibt gesperrt, §63).
      const cancellation = await this.byProcessId(processId, tx);
      const allowed =
        previous.mainStatus === 'cancelled' ||
        (previous.mainStatus === 'reopened' && cancellation !== null);
      if (!allowed) {
        throw new AuthError(
          'CONFLICT',
          'Ein Folgevorgang kann nur aus einem stornierten Vorgang erstellt werden.',
        );
      }
      const existing = await loadProcessRelations(tx, processId);
      if (existing.followUpProcess !== null)
        throw new FollowUpExistsError(existing.followUpProcess);
      // Nur die Kundenreferenz wird übernommen – keine Maschine, kein
      // Eventdatum, keine Lieferdaten, keine Preise/Rabatte, keine Buchung.
      const created = await this.processes.createProcessWithin(
        tx,
        actorId,
        { customerId: previous.customerId, source: 'staff_manual' },
        now,
      );
      await tx.insert(processRelations).values({
        previousProcessId: processId,
        followUpProcessId: created.id,
        kind: 'cancellation_follow_up',
        createdBy: actorId,
      });
      this.logger.info(
        { previousProcessId: processId, followUpProcessId: created.id },
        'Folgevorgang aus Storno erstellt',
      );
      return { processId: created.id, processNumber: created.processNumber };
    });
  }

  // ── Views ───────────────────────────────────────────────────────────────

  async viewForProcess(processId: string, viewer: CancellationViewer): Promise<CancellationView> {
    const row = await this.byProcessId(processId);
    if (row === null) throw new AuthError('NOT_FOUND', 'Keine Stornierung vorhanden.');
    return this.viewFor(row, viewer);
  }

  async viewFor(row: CancellationRow, viewer: CancellationViewer): Promise<CancellationView> {
    const process = await this.processById(row.processId);
    const transfer =
      row.accountingTransferId === null
        ? null
        : ((await this.transfers.byId(row.accountingTransferId)) ?? null);
    const relations = await loadProcessRelations(this.db, row.processId);
    const canViewReference = viewer.permissions.has('accounting.view_reference');
    const configured = this.transfers.isConfigured();
    const pending = row.feeCents > 0 && row.financeStatus === 'accounting_pending';
    const resources = record(row.releasedResources);
    const count = (key: string) =>
      typeof resources[key] === 'number' ? (resources[key] as number) : 0;
    const now = new Date();
    let blockers: AccountingBlockView['blockers'] = [];
    if (transfer !== null && pending && this.transfers.provider === 'lexware') {
      blockers = await this.transfers.readiness(
        transfer.snapshot as AccountingPayload,
        process.customerId,
      );
    }
    const mapping = transfer === null ? null : await this.transfers.invoiceMapping(transfer.id);
    const accounting = buildAccountingBlock({
      provider: this.transfers.provider,
      blockers,
      transfer,
      mapping,
      localPaymentStatus: row.paymentStatus,
      localDeliveryStatus: row.invoiceDeliveryStatus,
      canViewReference,
      deeplink:
        mapping?.lexwareInvoiceId === undefined || mapping?.lexwareInvoiceId === null
          ? null
          : this.transfers.invoiceDeeplink(mapping.lexwareInvoiceId),
      now,
    });
    return {
      id: row.id,
      processId: row.processId,
      processNumber: process.processNumber,
      cancelerType: row.cancelerType,
      cancelerStaffId:
        viewer.isAdmin || viewer.permissions.has('process.reopen_completed')
          ? row.cancelerStaffId
          : null,
      cancelledAt: row.cancelledAt.toISOString(),
      eventDate: row.eventDate,
      remainingDays: row.remainingDays,
      feePercent: row.feePercent,
      baseCents: row.baseCents,
      feeCents: row.feeCents,
      roundingMethod: row.roundingMethod,
      financeStatus: row.financeStatus,
      financeStatusLabel: CANCELLATION_FINANCE_STATUS_LABELS[row.financeStatus],
      accountingProvider: row.accountingProvider,
      accountingReference: canViewReference ? row.accountingReference : null,
      accountingReferenceVisible: canViewReference,
      paymentStatus: row.paymentStatus,
      paymentStatusLabel:
        row.paymentStatus === null ? null : PAYMENT_STATUS_LABELS[row.paymentStatus],
      transferredAt: iso(row.transferredAt),
      lastTransferErrorCode:
        row.lastTransferErrorCode ??
        (pending && transfer !== null && transfer.status !== 'pending'
          ? (transfer.attentionCode ?? transfer.lastErrorCode ?? 'LEXWARE_OUTCOME_UNKNOWN')
          : null),
      accountingBlocker: pending && !configured ? 'not_configured' : null,
      accounting,
      invoiceDeliveryStatus: row.invoiceDeliveryStatus,
      customerId: process.customerId,
      releasedResources: {
        appointments: count('appointments'),
        assignments: count('assignments'),
        machines: count('machines'),
        riskIncidents: count('riskIncidents'),
      },
      confirmationStatus: row.confirmationStatus,
      confirmationSentAt: iso(row.confirmationSentAt),
      externalRefundReviewRequired: row.externalRefundReviewRequired,
      externalRefundReviewHint: row.externalRefundReviewRequired
        ? EXTERNAL_REFUND_REVIEW_HINT
        : null,
      reopenedAt: iso(row.reopenedAt),
      followUpProcess: relations.followUpProcess,
      transfer:
        transfer === null
          ? null
          : {
              id: transfer.id,
              status: transfer.status,
              attempts: transfer.attempts,
              lastErrorCode: transfer.lastErrorCode,
              externalReference: canViewReference ? transfer.externalReference : null,
              paymentStatus: transfer.paymentStatus,
              transferredAt: iso(transfer.transferredAt),
              provider: transfer.provider,
              mock: transfer.provider === 'mock',
            },
      permissions: {
        canManualTransfer:
          viewer.permissions.has('lexware.manual_transfer') && pending && configured,
        canSendConfirmation:
          viewer.permissions.has('email.approve_prepared') &&
          row.confirmationStatus !== 'sent' &&
          row.confirmationStatus !== 'queued' &&
          row.reopenedAt === null &&
          process.mainStatus === 'cancelled',
        canCreateFollowUp:
          viewer.permissions.has('process.create') &&
          (process.mainStatus === 'cancelled' || process.mainStatus === 'reopened') &&
          relations.followUpProcess === null,
        canViewReference,
      },
    };
  }
}

// ── Leichte Abfragen für das Vorgangs-Detail (routes/crm.ts) ──────────────

/** Kurzinfo zur Stornierung eines Vorgangs (null = nicht storniert über Phase 9). */
export async function loadCancellationSummary(
  executor: DatabaseExecutor,
  processId: string,
): Promise<{
  financeStatus: CancellationFinanceStatus;
  financeStatusLabel: string;
  feeCents: number;
} | null> {
  const rows = await executor
    .select({ financeStatus: cancellations.financeStatus, feeCents: cancellations.feeCents })
    .from(cancellations)
    .where(eq(cancellations.processId, processId));
  const row = rows[0];
  if (row === undefined) return null;
  return {
    financeStatus: row.financeStatus,
    financeStatusLabel: CANCELLATION_FINANCE_STATUS_LABELS[row.financeStatus],
    feeCents: row.feeCents,
  };
}

/** Bidirektionale Verknüpfung Storno ↔ Folgevorgang (Order §64). */
export async function loadProcessRelations(
  executor: DatabaseExecutor,
  processId: string,
): Promise<ProcessRelationsView> {
  const related = alias(processes, 'related');
  const previousRows = await executor
    .select({ id: related.id, processNumber: related.processNumber })
    .from(processRelations)
    .innerJoin(related, eq(related.id, processRelations.previousProcessId))
    .where(
      and(
        eq(processRelations.followUpProcessId, processId),
        eq(processRelations.kind, 'cancellation_follow_up'),
      ),
    );
  const followUpRows = await executor
    .select({ id: related.id, processNumber: related.processNumber })
    .from(processRelations)
    .innerJoin(related, eq(related.id, processRelations.followUpProcessId))
    .where(
      and(
        eq(processRelations.previousProcessId, processId),
        eq(processRelations.kind, 'cancellation_follow_up'),
      ),
    )
    .orderBy(asc(processRelations.createdAt));
  return {
    previousProcess: previousRows[0] ?? null,
    followUpProcess: followUpRows[0] ?? null,
  };
}
