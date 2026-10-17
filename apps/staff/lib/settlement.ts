'use client';

/**
 * Phase 9: Typen, Labels und API-Aufrufe der Abrechnung, Anzahlung/Kaution
 * und des Stornos (Spiegel der API-Sichten laut scratchpad/phase9_contracts.md).
 * Nur Darstellung – keine Preis-, Storno- oder Statuslogik im Client.
 */

import { apiFetch, type ApiResult } from './api';
import { euro } from './commerce';
import { ACCOUNTING_BLOCKER_LABELS, type AccountingBlock } from './lexware';

// ── Beträge ──────────────────────────────────────────────────────────────

/** Gemeinsamer Betragsformatierer (de-DE, „1.234,56 €“). */
export function formatCents(cents: number): string {
  return euro(cents);
}

/**
 * Eingabe „12,50“ / „12.50“ / „1.234,56“ → 1250 Cent. Keine Fachlogik,
 * nur Umwandlung der Nutzereingabe; ungültig ⇒ null.
 */
export function parseEuroInput(raw: string): number | null {
  const trimmed = raw.trim().replace(/\s|€/g, '');
  if (trimmed === '') return null;
  let normalized = trimmed;
  if (trimmed.includes(',')) {
    normalized = trimmed.replace(/\./g, '').replace(',', '.');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [eurosPart, centsPart = ''] = normalized.split('.');
  const euros = Number.parseInt(eurosPart ?? '0', 10);
  const cents = Number.parseInt((centsPart + '00').slice(0, 2), 10);
  if (!Number.isFinite(euros) || !Number.isFinite(cents)) return null;
  return euros * 100 + cents;
}

/** Cent → Eingabewert „12,50“ (für Bearbeitungsfelder). */
export function centsToInput(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

// ── Abrechnung ───────────────────────────────────────────────────────────

export type SettlementStatus =
  | 'preparing'
  | 'clarification_required'
  | 'customer_notice_required'
  | 'customer_waiting'
  | 'ready_for_accounting'
  | 'transferring'
  | 'transferred'
  | 'transfer_failed';

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

export type PaymentStatus = 'open' | 'paid' | 'overdue';

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  open: 'Offen',
  paid: 'Bezahlt',
  overdue: 'Überfällig',
};

export type SettlementLineType =
  | 'machine_rental'
  | 'delivery'
  | 'purchase'
  | 'commission_consumption'
  | 'discount'
  | 'cleanup_fee'
  | 'damage_charge'
  | 'missing_item_charge'
  | 'late_fee'
  | 'manual_charge'
  | 'advance_payment_credit'
  | 'deposit_applied_credit';

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

/** Gruppen der Positionsliste (Order §69) – Reihenfolge der Anzeige. */
export const LINE_GROUPS: { key: string; title: string; types: SettlementLineType[] }[] = [
  {
    key: 'fixed',
    title: 'Feste Basis aus der Buchung',
    types: ['machine_rental', 'delivery', 'discount'],
  },
  {
    key: 'variable',
    title: 'Variable Positionen aus Ausgabe und Rückgabe',
    types: ['purchase', 'commission_consumption', 'cleanup_fee'],
  },
  {
    key: 'charges',
    title: 'Nachbelastungen',
    types: ['damage_charge', 'missing_item_charge', 'late_fee', 'manual_charge'],
  },
  {
    key: 'credits',
    title: 'Bereits berücksichtigt',
    types: ['advance_payment_credit', 'deposit_applied_credit'],
  },
];

export type ClarificationType = 'damage_cost' | 'missing_item_cost' | 'customer_response';

export const CLARIFICATION_TYPE_LABELS: Record<ClarificationType, string> = {
  damage_cost: 'Schadenkosten klären',
  missing_item_cost: 'Ersatzkosten Fehlteil klären',
  customer_response: 'Kundenrückmeldung bearbeiten',
};

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

export interface SettlementLineView {
  id: string;
  type: SettlementLineType | string;
  typeLabel: string;
  description: string;
  quantity: number | null;
  unit: string | null;
  unitPriceCents: number | null;
  amountCents: number;
  direction: 'charge' | 'credit';
  sourceType: string;
  sourceId: string | null;
  internalNote: string | null;
  editable: boolean;
  removable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ClarificationView {
  id: string;
  type: ClarificationType | string;
  typeLabel: string;
  sourceId: string | null;
  status: 'open' | 'resolved' | string;
  title: string;
  detail: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  context: {
    machineCode?: string;
    severity?: string;
    description?: string;
    photoCount?: number;
    accessoryType?: string;
    missingQuantity?: number;
    caseStatus?: string;
  };
}

export interface NoticeView {
  id: string;
  status: 'prepared' | 'approved' | 'sent' | 'blocked' | string;
  recipientEmail: string | null;
  subject: string;
  bodyText: string;
  totalCents: number;
  approvedAt: string | null;
  sentAt: string | null;
  gateway: string | null;
  gatewayReference: string | null;
  blockedReason: string | null;
}

export interface AdvancePaymentView {
  id: string;
  bookingId?: string;
  amountCents: number;
  receivedAt: string;
  externalReference: string | null;
  status: 'active' | 'cancelled';
  cancelledAt?: string | null;
}

export interface SecurityDepositView {
  id: string;
  bookingId?: string;
  amountCents: number;
  appliedCents: number;
  remainingHeldCents: number;
  receivedAt: string;
  externalReference: string | null;
  status: 'held' | 'released' | 'applied';
  releasedAt: string | null;
  /** Optimistische Sperre der Kautionszeile (Spiegel von booking_security_deposits.version). */
  version?: number;
}

export const ADVANCE_STATUS_LABELS: Record<AdvancePaymentView['status'], string> = {
  active: 'Aktiv',
  cancelled: 'Storniert',
};

export const DEPOSIT_STATUS_LABELS: Record<SecurityDepositView['status'], string> = {
  held: 'Gehalten',
  released: 'Freigegeben',
  applied: 'Angewendet',
};

export interface TransferView {
  id: string;
  status:
    'pending' | 'succeeded' | 'failed' | 'in_progress' | 'outcome_unknown' | 'attention' | string;
  attempts: number;
  lastErrorCode: string | null;
  externalReference: string | null;
  paymentStatus: PaymentStatus | null;
  transferredAt: string | null;
  provider: 'mock' | 'disabled' | 'lexware' | null;
  mock: boolean;
}

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
    /** Phase 10: Kunde des Vorgangs (für die Kontakt-Klärung) – optional. */
    customerId?: string | null;
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
    accountingProvider: 'mock' | 'disabled' | 'lexware' | null;
    accountingReference: string | null;
    accountingReferenceVisible: boolean;
    paymentStatus: PaymentStatus | null;
    paymentStatusLabel: string | null;
    lastTransferErrorCode: string | null;
    accountingBlocker: 'not_configured' | null;
    /** Phase 10 (Vertrag §6): Buchhaltungsblock – optional, bis die API ihn liefert. */
    accounting?: AccountingBlock | null;
    /** Phase 10: Versandstatus der Rechnung – nie „sent“ (Order §40). */
    invoiceDeliveryStatus?: 'pending' | string | null;
    autoTransferPlannedAt: string | null;
    version: number;
    createdAt: string;
    updatedAt: string;
  };
  lines: SettlementLineView[];
  clarifications: ClarificationView[];
  notice: NoticeView | null;
  advancePayments: AdvancePaymentView[];
  securityDeposits: SecurityDepositView[];
  transfer: TransferView | null;
  dominantAction: { key: DominantActionKey; label: string; hint: string | null };
  permissions: SettlementPermissions;
  mock: { isMock: boolean; controlsAvailable: boolean };
}

export interface PaymentsView {
  advancePayments: AdvancePaymentView[];
  securityDeposits: SecurityDepositView[];
  totals: { activeAdvanceCents: number; heldDepositCents: number; appliedDepositCents: number };
  /** Optional – liefert die Route keine Rechte, entscheidet die UI über /staff/me. */
  permissions?: Partial<
    Pick<
      SettlementPermissions,
      'canRecordAdvance' | 'canRecordDeposit' | 'canApplyDeposit' | 'canReleaseDeposit'
    >
  >;
}

export type TransferOutcome = 'succeeded' | 'already_succeeded' | 'skipped' | 'failed';

export interface TransferResponse {
  outcome: TransferOutcome | string;
  errorCode?: string | null;
  settlement: SettlementView;
}

export interface CancellationTransferResponse {
  outcome?: TransferOutcome | string;
  errorCode?: string | null;
  cancellation?: CancellationView;
}

/**
 * Verständlicher Text zum Ergebnis einer synchronen Übertragung (200 mit
 * `outcome`). Fehlercodes nur neutral, nie Stacktraces.
 */
export function transferOutcomeMessage(
  outcome: string | undefined,
  errorCode?: string | null,
): { ok: boolean; text: string } {
  switch (outcome) {
    case 'succeeded':
    case 'already_succeeded':
      return { ok: true, text: 'Übertragung ausgeführt.' };
    case 'skipped':
      return {
        ok: false,
        text: 'Übertragung derzeit nicht möglich – Voraussetzungen nicht erfüllt.',
      };
    case 'failed': {
      // Phase 10: bekannte Blocker verständlich benennen, sonst neutraler Hinweis ohne Rohfehler.
      const blockerText =
        errorCode !== undefined && errorCode !== null && errorCode !== ''
          ? (ACCOUNTING_BLOCKER_LABELS[errorCode as keyof typeof ACCOUNTING_BLOCKER_LABELS] ?? null)
          : null;
      return {
        ok: false,
        text:
          blockerText !== null
            ? `Übertragung nicht möglich: ${blockerText}`
            : 'Übertragung an Buchhaltung fehlgeschlagen – bitte später erneut versuchen.',
      };
    }
    default:
      return { ok: true, text: 'Übertragung ausgeführt.' };
  }
}

export interface AccountingStatus {
  provider: 'mock' | 'disabled' | 'lexware' | string;
  configured: boolean;
  mock: boolean;
  mockControlsAvailable: boolean;
  /** Phase 10: Zahlungs-/Fehlersimulation nur mit Mock-Gateway (optional geliefert). */
  mockPaymentControlsAvailable?: boolean;
  environment: string;
}

// ── Storno ───────────────────────────────────────────────────────────────

export type CancellationFinanceStatus =
  'no_invoice' | 'accounting_pending' | 'invoice_open' | 'paid';

export const CANCELLATION_FINANCE_LABELS: Record<CancellationFinanceStatus, string> = {
  no_invoice: 'Storniert – ohne Rechnung',
  accounting_pending: 'Stornorechnung – Buchhaltung ausstehend',
  invoice_open: 'Stornorechnung offen',
  paid: 'Stornorechnung bezahlt',
};

export interface CancellationPreview {
  eventDate: string | null;
  remainingDays: number;
  feePercent: number;
  baseCents: number;
  feeCents: number;
  roundingMethod: string;
  machines: { description: string; quantity: number; standardUnitPriceCents: number }[];
  willRelease: { appointments: number; assignments: number; reservedMachines: number };
  blockers: string[];
  externalRefundReviewRequired: boolean;
  accountingConfigured: boolean;
}

export interface CancellationView {
  id: string;
  processId: string;
  processNumber: string;
  cancelerType: 'employee' | 'admin' | 'customer';
  cancelerStaffId: string | null;
  cancelledAt: string;
  eventDate: string | null;
  remainingDays: number;
  feePercent: number;
  baseCents: number;
  feeCents: number;
  roundingMethod: string;
  financeStatus: CancellationFinanceStatus;
  financeStatusLabel: string;
  accountingProvider: 'mock' | 'disabled' | 'lexware' | null;
  accountingReference: string | null;
  accountingReferenceVisible: boolean;
  paymentStatus: PaymentStatus | null;
  paymentStatusLabel: string | null;
  transferredAt: string | null;
  lastTransferErrorCode: string | null;
  accountingBlocker: 'not_configured' | null;
  /** Phase 10 (Vertrag §6): Buchhaltungsblock – optional, bis die API ihn liefert. */
  accounting?: AccountingBlock | null;
  /** Phase 10: Versandstatus der Stornorechnung – nie „sent“ (Order §40). */
  invoiceDeliveryStatus?: 'pending' | string | null;
  releasedResources: {
    appointments: number;
    assignments: number;
    machines: number;
    riskIncidents: number;
  } | null;
  confirmationStatus: 'prepared' | 'sent' | 'blocked' | string;
  confirmationSentAt: string | null;
  externalRefundReviewRequired: boolean;
  reopenedAt: string | null;
  followUpProcess: { id: string; processNumber: string } | null;
  transfer: TransferView | null;
  permissions: {
    canManualTransfer: boolean;
    canSendConfirmation: boolean;
    canCreateFollowUp: boolean;
    canViewReference: boolean;
  };
}

export interface ProcessRelations {
  previousProcess: { id: string; processNumber: string } | null;
  followUpProcess: { id: string; processNumber: string } | null;
}

/** Kurzinfo im Prozess-Detail (Agent C). */
export interface ProcessCancellationSummary {
  financeStatus: CancellationFinanceStatus;
  financeStatusLabel: string;
  feeCents: number;
}

export const EXTERNAL_REFUND_HINT = 'Externe Rückzahlung/Verrechnung prüfen';
export const ACCOUNTING_NOT_CONFIGURED_HINT = 'Buchhaltungsintegration noch nicht eingerichtet';
export const VERSION_CONFLICT_HINT = 'Daten wurden zwischenzeitlich geändert – neu geladen';

// ── API: Abrechnung ──────────────────────────────────────────────────────

export function fetchSettlement(processId: string): Promise<ApiResult<SettlementView>> {
  return apiFetch<SettlementView>(`/staff/processes/${processId}/settlement`);
}

export function ensureSettlement(processId: string): Promise<ApiResult<SettlementView>> {
  return apiFetch<SettlementView>(`/staff/processes/${processId}/settlement/ensure`, {
    method: 'POST',
    body: {},
  });
}

export function fetchSettlementById(settlementId: string): Promise<ApiResult<SettlementView>> {
  return apiFetch<SettlementView>(`/staff/settlements/${settlementId}`);
}

export function addLine(
  settlementId: string,
  body: {
    type: 'manual_charge' | 'late_fee';
    description: string;
    amountCents: number;
    internalNote?: string;
    version: number;
  },
): Promise<ApiResult<SettlementView>> {
  return apiFetch<SettlementView>(`/staff/settlements/${settlementId}/lines`, {
    method: 'POST',
    body,
  });
}

export function updateLine(
  settlementId: string,
  lineId: string,
  body: { amountCents?: number; description?: string; internalNote?: string; version: number },
): Promise<ApiResult<SettlementView>> {
  return apiFetch<SettlementView>(`/staff/settlements/${settlementId}/lines/${lineId}`, {
    method: 'PATCH',
    body,
  });
}

export function removeLine(
  settlementId: string,
  lineId: string,
  version: number,
): Promise<ApiResult<SettlementView>> {
  return apiFetch<SettlementView>(`/staff/settlements/${settlementId}/lines/${lineId}`, {
    method: 'DELETE',
    body: { version },
  });
}

export function resolveClarification(
  settlementId: string,
  clarificationId: string,
  body: {
    decision: 'charge' | 'no_charge';
    amountCents?: number;
    description?: string;
    version: number;
  },
): Promise<ApiResult<SettlementView>> {
  return apiFetch<SettlementView>(
    `/staff/settlements/${settlementId}/clarifications/${clarificationId}/resolve`,
    { method: 'POST', body },
  );
}

export function fetchNotice(settlementId: string): Promise<ApiResult<NoticeView>> {
  return apiFetch<NoticeView>(`/staff/settlements/${settlementId}/notice`);
}

export function approveAndSendNotice(
  settlementId: string,
  version: number,
): Promise<ApiResult<SettlementView>> {
  return apiFetch<SettlementView>(`/staff/settlements/${settlementId}/notice/approve-and-send`, {
    method: 'POST',
    body: { version },
  });
}

export function customerResponse(
  settlementId: string,
  version: number,
  note?: string,
): Promise<ApiResult<SettlementView>> {
  const body: { version: number; note?: string } = { version };
  if (note !== undefined && note.trim() !== '') body.note = note.trim();
  return apiFetch<SettlementView>(`/staff/settlements/${settlementId}/customer-response`, {
    method: 'POST',
    body,
  });
}

export function releaseAsCalculated(
  settlementId: string,
  version: number,
): Promise<ApiResult<SettlementView>> {
  return apiFetch<SettlementView>(`/staff/settlements/${settlementId}/release`, {
    method: 'POST',
    body: { version },
  });
}

export function endWaitNow(
  settlementId: string,
  version: number,
): Promise<ApiResult<SettlementView>> {
  return apiFetch<SettlementView>(`/staff/settlements/${settlementId}/end-wait`, {
    method: 'POST',
    body: { version },
  });
}

export function transferNow(
  settlementId: string,
  version: number,
): Promise<ApiResult<TransferResponse>> {
  return apiFetch<TransferResponse>(`/staff/settlements/${settlementId}/transfer`, {
    method: 'POST',
    body: { version },
  });
}

// ── API: Anzahlung / Kaution ─────────────────────────────────────────────

export function fetchPayments(bookingId: string): Promise<ApiResult<PaymentsView>> {
  return apiFetch<PaymentsView>(`/staff/bookings/${bookingId}/payments`);
}

export function recordAdvance(
  bookingId: string,
  body: { amountCents: number; receivedAt: string; externalReference?: string },
): Promise<ApiResult<unknown>> {
  return apiFetch(`/staff/bookings/${bookingId}/advance-payments`, { method: 'POST', body });
}

export function cancelAdvance(advancePaymentId: string): Promise<ApiResult<unknown>> {
  return apiFetch(`/staff/advance-payments/${advancePaymentId}/cancel`, {
    method: 'POST',
    body: {},
  });
}

export function recordDeposit(
  bookingId: string,
  body: { amountCents: number; receivedAt: string; externalReference?: string },
): Promise<ApiResult<unknown>> {
  return apiFetch(`/staff/bookings/${bookingId}/security-deposits`, { method: 'POST', body });
}

export function applyDeposit(
  depositId: string,
  body: { amountCents: number; version: number },
): Promise<ApiResult<unknown>> {
  return apiFetch(`/staff/security-deposits/${depositId}/apply`, { method: 'POST', body });
}

export function releaseDeposit(depositId: string, version: number): Promise<ApiResult<unknown>> {
  return apiFetch(`/staff/security-deposits/${depositId}/release`, {
    method: 'POST',
    body: { version },
  });
}

// ── API: Storno / Folgevorgang ───────────────────────────────────────────

export function cancellationPreview(processId: string): Promise<ApiResult<CancellationPreview>> {
  return apiFetch<CancellationPreview>(`/staff/processes/${processId}/cancellation/preview`);
}

export function cancelBooking(processId: string): Promise<ApiResult<CancellationView>> {
  return apiFetch<CancellationView>(`/staff/processes/${processId}/cancellation`, {
    method: 'POST',
    body: { confirm: true },
  });
}

export function fetchCancellation(processId: string): Promise<ApiResult<CancellationView>> {
  return apiFetch<CancellationView>(`/staff/processes/${processId}/cancellation`);
}

export function cancellationTransfer(
  cancellationId: string,
): Promise<ApiResult<CancellationTransferResponse>> {
  return apiFetch<CancellationTransferResponse>(`/staff/cancellations/${cancellationId}/transfer`, {
    method: 'POST',
    body: {},
  });
}

export function sendCancellationConfirmation(
  cancellationId: string,
): Promise<ApiResult<{ confirmationStatus: string }>> {
  return apiFetch<{ confirmationStatus: string }>(
    `/staff/cancellations/${cancellationId}/confirmation/send`,
    { method: 'POST', body: {} },
  );
}

export function createFollowUp(
  processId: string,
): Promise<ApiResult<{ processId: string; processNumber: string }>> {
  return apiFetch<{ processId: string; processNumber: string }>(
    `/staff/processes/${processId}/follow-up`,
    { method: 'POST', body: {} },
  );
}

// ── API: Buchhaltungsstatus / Mock-Steuerung (nie in Production) ─────────

export function fetchAccountingStatus(): Promise<ApiResult<AccountingStatus>> {
  return apiFetch<AccountingStatus>('/staff/accounting/status');
}

export function mockExpireWait(settlementId: string): Promise<ApiResult<unknown>> {
  return apiFetch('/staff/accounting/mock/expire-wait', { method: 'POST', body: { settlementId } });
}

export function mockRunDueJobs(): Promise<ApiResult<{ processed: number; failed: number }>> {
  return apiFetch<{ processed: number; failed: number }>('/staff/accounting/mock/run-due-jobs', {
    method: 'POST',
    body: {},
  });
}

export function mockPaymentStatus(
  transferId: string,
  status: PaymentStatus,
): Promise<ApiResult<unknown>> {
  return apiFetch('/staff/accounting/mock/payment-status', {
    method: 'POST',
    body: { transferId, status },
  });
}

export function mockFailNext(count = 1, code?: string): Promise<ApiResult<unknown>> {
  const body: { count: number; code?: string } = { count };
  if (code !== undefined) body.code = code;
  return apiFetch('/staff/accounting/mock/fail-next', { method: 'POST', body });
}

// ── Darstellungshelfer ───────────────────────────────────────────────────

export function settlementStatusLabel(view: SettlementView['settlement']): string {
  return view.statusLabel !== '' ? view.statusLabel : SETTLEMENT_STATUS_LABELS[view.status];
}

/** Verständlicher Text für einen gescheiterten Transfer (nie Rohcode zeigen). */
export const TRANSFER_FAILED_TEXT =
  'Übertragung an Buchhaltung fehlgeschlagen – wird erneut versucht';

export function lockedHint(view: SettlementView['settlement']): string | null {
  if (!view.locked) return null;
  if (view.status === 'transferred') {
    return 'An Buchhaltung übertragen – Positionen und Beträge sind gesperrt.';
  }
  return 'Übertragung vorbereitet – Beträge gesperrt.';
}
