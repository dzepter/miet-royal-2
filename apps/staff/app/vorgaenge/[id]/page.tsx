'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  AccountingBlockCard,
  accountingBlockData,
  CANCELLATION_ACCOUNTING_IDS,
} from '../../../components/accounting-block';
import { AuthGuard, useMe } from '../../../components/auth-guard';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import {
  ProcessCommunicationCard,
  VoucherDeliveryActions,
} from '../../../components/communication';
import { apiFetch, hasPermission, type ApiResult } from '../../../lib/api';
import { RETRY_TRANSFER_LABEL_LEXWARE, TRANSFER_CHECK_TEXT } from '../../../lib/lexware';
import {
  formatEventDate,
  STATUS_BADGE_CLASS,
  STATUS_LABELS,
  type MainStatus,
  type VoucherSummary,
} from '../../../lib/crm';
import {
  ACCOUNTING_NOT_CONFIGURED_HINT,
  ADVANCE_STATUS_LABELS,
  applyDeposit,
  cancelAdvance,
  cancelBooking,
  cancellationPreview,
  cancellationTransfer,
  CANCELLATION_FINANCE_LABELS,
  createFollowUp,
  DEPOSIT_STATUS_LABELS,
  ensureSettlement,
  EXTERNAL_REFUND_HINT,
  fetchCancellation,
  fetchPayments,
  fetchSettlement,
  formatCents,
  parseEuroInput,
  recordAdvance,
  recordDeposit,
  releaseDeposit,
  sendCancellationConfirmation,
  settlementStatusLabel,
  TRANSFER_FAILED_TEXT,
  transferOutcomeMessage,
  VERSION_CONFLICT_HINT,
  fetchAccountingStatus,
  mockPaymentStatus,
  mockRunDueJobs,
  type AccountingStatus,
  type CancellationPreview,
  type CancellationView,
  type PaymentsView,
  type ProcessCancellationSummary,
  type ProcessRelations,
  type SettlementView,
} from '../../../lib/settlement';
import {
  ASSIGNMENT_STATUS_LABELS,
  DOCUMENT_TYPE_LABELS,
  formatBerlin,
  NEXT_ACTION_LABELS,
  PACKET_STATUS_LABELS,
  type DeliveryPacketView,
  type HandoverDetail,
  type HandoverDocument,
} from '../../../lib/handover';
import {
  RETURN_NEXT_ACTION_LABELS,
  type ReturnDetail,
  type ReturnDocument,
} from '../../../lib/returns';

const SOURCE_LABELS: Record<string, string> = {
  website: 'Website',
  whatsapp: 'WhatsApp',
  staff_manual: 'Manuell angelegt',
  other: 'Sonstige',
};

interface ProcessDetail {
  process: {
    id: string;
    processNumber: string;
    customerId: string;
    mainStatus: MainStatus;
    source: string;
    eventDate: string | null;
    assignedUserId: string | null;
    createdAt: string;
    completedAt: string | null;
    cancelledAt: string | null;
    reopenedAt: string | null;
  };
  customer: {
    id: string;
    type: 'private' | 'organization';
    firstName: string | null;
    lastName: string | null;
    organizationName: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  notes: {
    id: string;
    text: string;
    createdAt: string;
    authorFirstName: string;
    authorLastName: string;
  }[];
  assignee: { id: string; firstName: string; lastName: string } | null;
  /** Phase 9 (Agent C): Storno-Kurzinfo und Verknüpfungen – optional, bis die API sie liefert. */
  cancellation?: ProcessCancellationSummary | null;
  relations?: ProcessRelations | null;
  /** Phase 11 (§53): aus diesem Vorgang entstandener Wiedermieter-Gutschein (nie der Code). */
  voucher?: VoucherSummary | null;
}

interface StaffOption {
  id: string;
  firstName: string;
  lastName: string;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return date.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function today(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parts;
}

function ProcessView() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const me = useMe();
  const [detail, setDetail] = useState<ProcessDetail | null>(null);
  const [staffOptions, setStaffOptions] = useState<StaffOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingDate, setEditingDate] = useState(false);
  const [dateValue, setDateValue] = useState('');
  const [noteText, setNoteText] = useState('');
  const [commerce, setCommerce] = useState<{
    hasInquiry: boolean;
    offerStatus: string | null;
    confirmationStatus: string | null;
    bookingId: string | null;
  }>({ hasInquiry: false, offerStatus: null, confirmationStatus: null, bookingId: null });
  // Phase 9: Abrechnung, Zahlungen/Kaution, Storno.
  const [settlement, setSettlement] = useState<SettlementView | null>(null);
  const [settlementMissing, setSettlementMissing] = useState(false);
  const [payments, setPayments] = useState<PaymentsView | null>(null);
  const [paymentsError, setPaymentsError] = useState<string | null>(null);
  const [paymentsNotice, setPaymentsNotice] = useState<string | null>(null);
  const [advanceAmount, setAdvanceAmount] = useState('');
  const [advanceReceivedAt, setAdvanceReceivedAt] = useState(today);
  const [advanceReference, setAdvanceReference] = useState('');
  const [depositAmount, setDepositAmount] = useState('');
  const [depositReceivedAt, setDepositReceivedAt] = useState(today);
  const [depositReference, setDepositReference] = useState('');
  const [depositApplyAmounts, setDepositApplyAmounts] = useState<Record<string, string>>({});
  const [moreOpen, setMoreOpen] = useState(false);
  const [preview, setPreview] = useState<CancellationPreview | null>(null);
  const [cancellation, setCancellation] = useState<CancellationView | null>(null);
  const [cancellationError, setCancellationError] = useState<string | null>(null);
  const [cancellationNotice, setCancellationNotice] = useState<string | null>(null);
  const [confirmCancellationTransfer, setConfirmCancellationTransfer] = useState(false);
  const [accountingStatus, setAccountingStatus] = useState<AccountingStatus | null>(null);
  const [handover, setHandover] = useState<HandoverDetail | null>(null);
  const [handoverDocs, setHandoverDocs] = useState<HandoverDocument[]>([]);
  const [packets, setPackets] = useState<DeliveryPacketView[]>([]);
  const [returnInfo, setReturnInfo] = useState<{
    detail: ReturnDetail | null;
    canStart: boolean;
    documents: ReturnDocument[];
  } | null>(null);

  const load = useCallback(async () => {
    const result = await apiFetch<ProcessDetail>(`/staff/processes/${params.id}`);
    if (result.data !== null) {
      setDetail(result.data);
      setDateValue(result.data.process.eventDate ?? '');
    } else {
      setLoadError(result.errorMessage ?? 'Vorgang nicht gefunden.');
    }
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void apiFetch<{ staff: StaffOption[] }>('/staff/staff-options').then((result) => {
      if (result.data !== null) setStaffOptions(result.data.staff);
    });
  }, []);

  const loadCommerce = useCallback(async () => {
    const [inquiryResult, offerResult] = await Promise.all([
      apiFetch<{ inquiry: unknown }>(`/staff/processes/${params.id}/inquiry`),
      apiFetch<{
        offer: {
          offer: { currentVersionId: string | null };
          versions: { id: string; effectiveStatus: string }[];
        } | null;
        booking: { id: string } | null;
        confirmation: { status: string } | null;
      }>(`/staff/processes/${params.id}/offer`),
    ]);
    const hasInquiry =
      inquiryResult.data?.inquiry !== null && inquiryResult.data?.inquiry !== undefined;
    let offerStatus: string | null = null;
    if (offerResult.data?.offer !== null && offerResult.data?.offer !== undefined) {
      const currentId = offerResult.data.offer.offer.currentVersionId;
      offerStatus =
        offerResult.data.offer.versions.find((version) => version.id === currentId)
          ?.effectiveStatus ?? null;
    }
    setCommerce({
      hasInquiry,
      offerStatus,
      confirmationStatus: offerResult.data?.confirmation?.status ?? null,
      bookingId: offerResult.data?.booking?.id ?? null,
    });
  }, [params.id]);
  useEffect(() => {
    void loadCommerce();
  }, [loadCommerce]);

  const canHandover = hasPermission(me, 'handover.view');
  useEffect(() => {
    if (!canHandover) return;
    void apiFetch<{ detail: HandoverDetail | null }>(`/staff/processes/${params.id}/handover`).then(
      async (result) => {
        if (result.data === null) return;
        setHandover(result.data.detail);
        if (result.data.detail !== null) {
          const docs = await apiFetch<{ documents: HandoverDocument[] }>(
            `/staff/handover/${result.data.detail.booking.id}`,
          );
          if (docs.data !== null) setHandoverDocs(docs.data.documents);
          if (result.data.detail.handover.status === 'finalized') {
            const packetResult = await apiFetch<{ packets: DeliveryPacketView[] }>(
              `/staff/processes/${params.id}/delivery-packets`,
            );
            if (packetResult.data !== null) setPackets(packetResult.data.packets);
          }
        }
      },
    );
  }, [canHandover, params.id, commerce.confirmationStatus]);

  const canReturn = hasPermission(me, 'return.view');
  useEffect(() => {
    if (!canReturn) return;
    // Phase 7: Rückgabe-Stand des Vorgangs (nur nach Ausgabe fachlich relevant).
    void apiFetch<{ detail: ReturnDetail | null; canStart: boolean; documents: ReturnDocument[] }>(
      `/staff/processes/${params.id}/return`,
    ).then((result) => {
      if (result.data !== null) setReturnInfo(result.data);
    });
  }, [canReturn, params.id, handover?.handover.status]);

  // Phase 9: Abrechnung entsteht erst nach finalisierter Rückgabe (§§4/48).
  const canSettlement = hasPermission(me, 'settlement.view');
  const returnFinalized = returnInfo?.detail?.return.status === 'finalized';
  const loadSettlement = useCallback(async () => {
    const result = await fetchSettlement(params.id);
    if (result.data !== null) {
      setSettlement(result.data);
      setSettlementMissing(false);
    } else if (result.status === 404) {
      setSettlement(null);
      setSettlementMissing(true);
    }
  }, [params.id]);
  useEffect(() => {
    if (!canSettlement || !returnFinalized) return;
    void loadSettlement();
  }, [canSettlement, returnFinalized, loadSettlement]);

  // Phase 9: Anzahlung/Kaution je akzeptierter Buchung (§§17–19, §74) – auch vor Rückgabe.
  const loadPayments = useCallback(async () => {
    if (commerce.bookingId === null) return;
    const result = await fetchPayments(commerce.bookingId);
    if (result.data !== null) {
      setPayments(result.data);
      setPaymentsError(null);
    } else if (result.status !== 404) {
      setPaymentsError(result.errorMessage ?? 'Zahlungen konnten nicht geladen werden.');
    }
  }, [commerce.bookingId]);
  useEffect(() => {
    if (!canSettlement) return;
    void loadPayments();
  }, [canSettlement, loadPayments]);

  // Phase 9: Storno-Sicht nach erfolgtem Storno (§§57–64).
  const isCancelled = detail?.process.mainStatus === 'cancelled';
  const loadCancellation = useCallback(async () => {
    const result = await fetchCancellation(params.id);
    if (result.data !== null) setCancellation(result.data);
  }, [params.id]);
  useEffect(() => {
    if (!isCancelled) return;
    void loadCancellation();
  }, [isCancelled, loadCancellation]);
  // Mock-Steuerung für den Storno-Transfer (nur Nicht-Production, §77) – Sichtbarkeit laut Server.
  useEffect(() => {
    if (!isCancelled || !canSettlement) return;
    void fetchAccountingStatus().then((result) => {
      if (result.data !== null) setAccountingStatus(result.data);
    });
  }, [isCancelled, canSettlement]);

  /** Mutation im Zahlungsbereich: Serverfehler als Hinweis, Versionskonflikt ⇒ neu laden. */
  async function runPayment<T>(
    run: () => Promise<ApiResult<T>>,
    okNotice: string,
  ): Promise<boolean> {
    setBusy(true);
    setPaymentsError(null);
    setPaymentsNotice(null);
    const result = await run();
    setBusy(false);
    if (!result.ok) {
      if (result.status === 409 && result.errorCode === 'VERSION_CONFLICT') {
        setPaymentsNotice(VERSION_CONFLICT_HINT);
      } else {
        setPaymentsError(result.errorMessage ?? 'Aktion fehlgeschlagen.');
      }
      await loadPayments();
      if (returnFinalized) await loadSettlement();
      return false;
    }
    setPaymentsNotice(okNotice);
    await loadPayments();
    if (returnFinalized) await loadSettlement();
    return true;
  }

  async function submitAdvance(): Promise<void> {
    if (commerce.bookingId === null) return;
    const amountCents = parseEuroInput(advanceAmount);
    if (amountCents === null || amountCents <= 0) {
      setPaymentsError('Bitte einen Betrag größer 0 eingeben (z. B. 100,00).');
      return;
    }
    const bookingId = commerce.bookingId;
    const body: { amountCents: number; receivedAt: string; externalReference?: string } = {
      amountCents,
      receivedAt: advanceReceivedAt,
    };
    if (advanceReference.trim() !== '') body.externalReference = advanceReference.trim();
    const ok = await runPayment(() => recordAdvance(bookingId, body), 'Anzahlung erfasst.');
    if (ok) {
      setAdvanceAmount('');
      setAdvanceReference('');
    }
  }

  async function submitDeposit(): Promise<void> {
    if (commerce.bookingId === null) return;
    const amountCents = parseEuroInput(depositAmount);
    if (amountCents === null || amountCents <= 0) {
      setPaymentsError('Bitte einen Betrag größer 0 eingeben (z. B. 200,00).');
      return;
    }
    const bookingId = commerce.bookingId;
    const body: { amountCents: number; receivedAt: string; externalReference?: string } = {
      amountCents,
      receivedAt: depositReceivedAt,
    };
    if (depositReference.trim() !== '') body.externalReference = depositReference.trim();
    const ok = await runPayment(() => recordDeposit(bookingId, body), 'Kaution erfasst.');
    if (ok) {
      setDepositAmount('');
      setDepositReference('');
    }
  }

  async function openCancellationPreview(): Promise<void> {
    setMoreOpen(false);
    setBusy(true);
    setActionError(null);
    const result = await cancellationPreview(params.id);
    setBusy(false);
    if (result.data === null) {
      setActionError(result.errorMessage ?? 'Storno-Vorschau konnte nicht geladen werden.');
      return;
    }
    setPreview(result.data);
  }

  async function confirmCancellation(): Promise<void> {
    setBusy(true);
    setActionError(null);
    const result = await cancelBooking(params.id);
    setBusy(false);
    if (result.data === null) {
      setActionError(result.errorMessage ?? 'Storno fehlgeschlagen.');
      // Vorschau schließen – der aktuelle Stand wird neu geladen.
      setPreview(null);
      await load();
      return;
    }
    setPreview(null);
    setCancellation(result.data);
    await Promise.all([load(), loadCommerce(), loadPayments()]);
    // Ausgabe-/Rückgabestand neu lesen (Assignments sind gelöst).
    if (canHandover) {
      const handoverResult = await apiFetch<{ detail: HandoverDetail | null }>(
        `/staff/processes/${params.id}/handover`,
      );
      if (handoverResult.data !== null) setHandover(handoverResult.data.detail);
    }
  }

  async function runCancellationAction<T>(
    run: () => Promise<ApiResult<T>>,
    okNotice: string,
  ): Promise<T | null> {
    setBusy(true);
    setCancellationError(null);
    setCancellationNotice(null);
    const result = await run();
    setBusy(false);
    if (!result.ok) {
      setCancellationError(result.errorMessage ?? 'Aktion fehlgeschlagen.');
      await loadCancellation();
      return null;
    }
    setCancellationNotice(okNotice);
    await Promise.all([loadCancellation(), load()]);
    return result.data;
  }

  async function runAction(path: string, body: unknown): Promise<void> {
    setBusy(true);
    setActionError(null);
    const result = await apiFetch(path, { method: 'POST', body });
    setBusy(false);
    if (!result.ok) {
      setActionError(result.errorMessage ?? 'Aktion fehlgeschlagen.');
      return;
    }
    await load();
  }

  async function saveEventDate(): Promise<void> {
    setBusy(true);
    setActionError(null);
    const result = await apiFetch(`/staff/processes/${params.id}`, {
      method: 'PATCH',
      body: { eventDate: dateValue === '' ? null : dateValue },
    });
    setBusy(false);
    if (!result.ok) {
      setActionError(result.errorMessage ?? 'Speichern fehlgeschlagen.');
      return;
    }
    setEditingDate(false);
    await load();
  }

  async function addNote(): Promise<void> {
    setBusy(true);
    setActionError(null);
    const result = await apiFetch(`/staff/processes/${params.id}/notes`, {
      method: 'POST',
      body: { text: noteText },
    });
    setBusy(false);
    if (!result.ok) {
      setActionError(result.errorMessage ?? 'Notiz konnte nicht gespeichert werden.');
      return;
    }
    setNoteText('');
    await load();
  }

  if (detail === null) {
    return (
      <main className="page">
        {loadError !== null ? (
          <p className="error">{loadError}</p>
        ) : (
          <p className="muted">Wird geladen …</p>
        )}
      </main>
    );
  }

  const { process, customer, notes, assignee } = detail;
  // Phase 10: Buchhaltungsblock der Storno-Karte (Vertrag §6) – ersatzweise aus Phase-9-Feldern.
  const cancellationAccounting = accountingBlockData({
    accounting: cancellation?.accounting,
    fallback: {
      provider: cancellation?.accountingProvider ?? null,
      isMock: cancellation?.accountingProvider === 'mock',
      transferredAt: cancellation?.transferredAt ?? null,
      reference: cancellation?.accountingReference ?? null,
      referenceVisible: cancellation?.accountingReferenceVisible === true,
      paymentStatus: cancellation?.paymentStatus ?? null,
      paymentStatusLabel: cancellation?.paymentStatusLabel ?? null,
      deliveryStatus: cancellation?.invoiceDeliveryStatus,
      transferFailed:
        cancellation?.financeStatus === 'accounting_pending' &&
        cancellation.lastTransferErrorCode !== null,
    },
  });
  const customerLabel =
    customer === null
      ? 'Kunde nicht verfügbar'
      : customer.type === 'organization'
        ? (customer.organizationName ?? 'Organisation')
        : `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim();
  const isEditable = process.mainStatus === 'open' || process.mainStatus === 'reopened';
  const canEdit = hasPermission(me, 'process.edit');
  const canAssign = hasPermission(me, 'process.reassign');
  // Phase 9: Storno nur vor Ausgabe (§50) – die UI zeigt den Weg, der Server entscheidet.
  const hasBooking = commerce.bookingId !== null;
  const issued =
    handover !== null &&
    (handover.handover.status === 'finalized' ||
      handover.slots.some((slot) => slot.status === 'issued' || slot.status === 'returned'));
  const beforeIssue = !issued && (returnInfo?.detail ?? null) === null;
  const canCancelBooking =
    hasBooking && isEditable && beforeIssue && hasPermission(me, 'booking.cancel');
  const followUpProcess =
    detail.relations?.followUpProcess ?? cancellation?.followUpProcess ?? null;
  const previousProcess = detail.relations?.previousProcess ?? null;
  const paymentPerms = {
    recordAdvance:
      payments?.permissions?.canRecordAdvance ?? hasPermission(me, 'deposit.record_advance'),
    recordDeposit:
      payments?.permissions?.canRecordDeposit ?? hasPermission(me, 'deposit.record_security'),
    applyDeposit:
      payments?.permissions?.canApplyDeposit ?? hasPermission(me, 'deposit.retain_security'),
    releaseDeposit:
      payments?.permissions?.canReleaseDeposit ?? hasPermission(me, 'deposit.refund_security'),
  };
  const settlementLocked = settlement?.settlement.locked ?? false;

  return (
    <main className="page">
      <p>
        <Link href="/vorgaenge">← Vorgänge</Link>
      </p>

      <div className="card">
        <h1 style={{ marginTop: 0 }}>{process.processNumber}</h1>
        <p>
          Kunde:{' '}
          {customer !== null ? (
            <Link href={`/kunden/${customer.id}`}>
              <strong>{customerLabel}</strong>
            </Link>
          ) : (
            <strong>{customerLabel}</strong>
          )}
          {' · '}Event: <strong>{formatEventDate(process.eventDate)}</strong>
          {' · '}
          <span className={`badge ${STATUS_BADGE_CLASS[process.mainStatus]}`}>
            {STATUS_LABELS[process.mainStatus]}
          </span>
        </p>
        <p className="muted">
          Zuständig:{' '}
          {assignee !== null ? `${assignee.firstName} ${assignee.lastName}` : 'Nicht zugewiesen'}
        </p>
        {detail.voucher ? (
          <p className="muted" data-testid="process-voucher">
            20-%-Wiedermieter-Gutschein erstellt – {detail.voucher.deliveryLabel}
            {' · '}
            {detail.voucher.statusLabel}
            {' · '}
            <code>{detail.voucher.maskedReference}</code>
          </p>
        ) : null}
        {/* Phase 12 (UI): Versandproblem + „Gutschein jetzt senden“ (Order §15). */}
        {detail.voucher ? (
          <VoucherDeliveryActions
            customerId={process.customerId}
            voucher={detail.voucher}
            me={me}
            testIdPrefix="process-voucher"
            onChanged={load}
          />
        ) : null}
        {(previousProcess !== null || followUpProcess !== null) && (
          <p className="muted">
            {previousProcess !== null && (
              <>
                Vorheriger Vorgang (storniert):{' '}
                <Link
                  href={`/vorgaenge/${previousProcess.id}`}
                  data-testid="process-relation-previous"
                >
                  {previousProcess.processNumber}
                </Link>
              </>
            )}
            {previousProcess !== null && followUpProcess !== null ? ' · ' : ''}
            {followUpProcess !== null && (
              <>
                Folgevorgang:{' '}
                <Link
                  href={`/vorgaenge/${followUpProcess.id}`}
                  data-testid="process-relation-follow-up"
                >
                  {followUpProcess.processNumber}
                </Link>
              </>
            )}
          </p>
        )}
      </div>

      <div className="card" aria-label="Nächste Aktion">
        <h2 style={{ marginTop: 0 }}>Nächste Aktion</h2>
        {process.mainStatus === 'cancelled' ? (
          <p>
            <span className="badge locked">Storniert</span> – keine Ausgabe oder Rückgabe mehr
            möglich.
            {followUpProcess === null && cancellation?.permissions.canCreateFollowUp === true
              ? ' Für eine neue Buchung einen neuen Vorgang aus dem Storno erstellen (siehe Storno).'
              : ''}
          </p>
        ) : commerce.confirmationStatus === 'failed' ? (
          // Phase 12 (UI): AB-Mail endgültig gescheitert – bewusst erneut versenden.
          <p>
            <Link href={`/vorgaenge/${params.id}/angebot`} data-testid="next-action-ab-resend">
              <strong>Auftragsbestätigung erneut versenden</strong>
            </Link>{' '}
            <span className="badge locked">Versand fehlgeschlagen</span>
          </p>
        ) : commerce.confirmationStatus === 'sent' || commerce.confirmationStatus === 'queued' ? (
          <>
            {commerce.confirmationStatus === 'queued' && (
              <p className="muted" data-testid="next-action-ab-queued">
                Auftragsbestätigung: Versand eingeplant.
              </p>
            )}
            {/* Terminplanung bleibt an fester Stelle (kein Umbau beim Nachladen der Ausgabe). */}
            <p>
              <Link href={`/vorgaenge/${params.id}/termine`}>
                <strong>Terminplanung öffnen</strong>
              </Link>
            </p>
            {handover !== null && handover.nextAction === 'done' && (
              <p>
                <span className="badge ok">Übergabe abgeschlossen</span>{' '}
                <Link href={`/vorgaenge/${params.id}/uebergabe`}>Protokoll ansehen</Link>
              </p>
            )}
            {returnInfo?.detail?.return.status === 'finalized' && (
              <p>
                <span className="badge ok">Rückgabe abgeschlossen</span>{' '}
                <Link href={`/vorgaenge/${params.id}/rueckgabe`}>Rückgabeprotokoll ansehen</Link>
              </p>
            )}
            {returnFinalized && settlement !== null && (
              <p>
                <Link href={`/vorgaenge/${params.id}/abrechnung`}>
                  <strong>
                    {settlement.settlement.status === 'transferred'
                      ? 'Abrechnung ansehen'
                      : `Abrechnung: ${settlement.dominantAction.label}`}
                  </strong>
                </Link>
              </p>
            )}
            {returnInfo !== null &&
              returnInfo.detail?.return.status !== 'finalized' &&
              (returnInfo.detail !== null || returnInfo.canStart) && (
                <p>
                  <Link href={`/vorgaenge/${params.id}/rueckgabe`} data-testid="return-action">
                    <strong>
                      {returnInfo.detail === null ? 'Rückgabe starten' : 'Rückgabe fortsetzen'}
                    </strong>
                  </Link>
                </p>
              )}
            {handover !== null && handover.nextAction === 'handover' && (
              <p>
                <Link href={`/vorgaenge/${params.id}/uebergabe`}>
                  <strong>Übergabe starten</strong>
                </Link>
              </p>
            )}
            {handover !== null &&
              (handover.nextAction === 'assign' || handover.nextAction === 'prepare') && (
                <p>
                  <Link href={`/vorgaenge/${params.id}/ausgabe`}>
                    <strong>{NEXT_ACTION_LABELS[handover.nextAction]}</strong>
                  </Link>
                </p>
              )}
          </>
        ) : commerce.confirmationStatus === 'prepared' ? (
          <p>
            <Link href={`/vorgaenge/${params.id}/angebot`}>
              <strong>Auftragsbestätigung prüfen</strong>
            </Link>
          </p>
        ) : commerce.confirmationStatus === 'approved' ? (
          <p>
            <Link href={`/vorgaenge/${params.id}/angebot`}>
              <strong>Auftragsbestätigung versenden</strong>
            </Link>
          </p>
        ) : commerce.offerStatus === 'draft' ? (
          <p>
            <Link href={`/vorgaenge/${params.id}/angebot`}>
              <strong>Angebot fertigstellen und versenden</strong>
            </Link>
          </p>
        ) : commerce.offerStatus === 'recheck_requested' ? (
          <p>
            <Link href={`/vorgaenge/${params.id}/angebot`}>
              <strong>Erneute Prüfung bearbeiten</strong>
            </Link>
          </p>
        ) : !commerce.hasInquiry && isEditable ? (
          <p>
            <Link href={`/vorgaenge/${params.id}/anfrage`}>
              <strong>Anfrage erfassen</strong>
            </Link>
          </p>
        ) : commerce.hasInquiry && commerce.offerStatus === null && isEditable ? (
          <p>
            <Link href={`/vorgaenge/${params.id}/angebot`}>
              <strong>Angebot erstellen</strong>
            </Link>
          </p>
        ) : (
          <p>Vorgang bearbeiten</p>
        )}
      </div>

      {actionError !== null && <p className="error">{actionError}</p>}
      {!isEditable && (
        <p className="muted">
          Der Vorgang ist {STATUS_LABELS[process.mainStatus].toLowerCase()} und für die normale
          Bearbeitung gesperrt.
          {hasPermission(me, 'process.reopen_completed')
            ? ' Zum Bearbeiten bitte wieder öffnen.'
            : ''}
        </p>
      )}

      <div className="card">
        <h2>Grunddaten</h2>
        <p>
          Quelle: {SOURCE_LABELS[process.source] ?? process.source} · Angelegt:{' '}
          {formatDateTime(process.createdAt)}
        </p>
        {editingDate ? (
          <p>
            <label htmlFor="p-event">Eventdatum</label>
            <input
              id="p-event"
              type="date"
              value={dateValue}
              onChange={(e) => setDateValue(e.target.value)}
            />
            <button className="primary" disabled={busy} onClick={() => void saveEventDate()}>
              Speichern
            </button>{' '}
            <button onClick={() => setEditingDate(false)}>Abbrechen</button>
          </p>
        ) : (
          <p>
            Eventdatum: {formatEventDate(process.eventDate)}{' '}
            {canEdit && isEditable && (
              <button onClick={() => setEditingDate(true)}>Datum ändern</button>
            )}
          </p>
        )}
        {customer !== null && (
          <p className="muted">
            Kontakt: {customer.email ?? '–'} · {customer.phone ?? '–'}
          </p>
        )}
      </div>

      <div className="card">
        <h2>Zuständigkeit</h2>
        {canAssign && isEditable ? (
          <p>
            <label htmlFor="p-assign">Zuständiger Mitarbeiter</label>
            <select
              id="p-assign"
              value={process.assignedUserId ?? ''}
              disabled={busy}
              onChange={(e) =>
                void runAction(`/staff/processes/${params.id}/assign`, {
                  userId: e.target.value === '' ? null : e.target.value,
                })
              }
            >
              <option value="">Nicht zugewiesen</option>
              {staffOptions.map((option) => (
                <option value={option.id} key={option.id}>
                  {option.lastName}, {option.firstName}
                </option>
              ))}
            </select>
          </p>
        ) : (
          <p>
            {assignee !== null ? `${assignee.firstName} ${assignee.lastName}` : 'Nicht zugewiesen'}
          </p>
        )}
      </div>

      <div className="card">
        <h2>Interne Notizen</h2>
        <p className="muted">Nur für Mitarbeitende sichtbar – nie für Kunden.</p>
        {canEdit && isEditable && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void addNote();
            }}
          >
            <label htmlFor="p-note">Neue Notiz</label>
            <textarea
              id="p-note"
              rows={3}
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
            />
            <button className="primary" type="submit" disabled={busy || noteText.trim() === ''}>
              Notiz speichern
            </button>
          </form>
        )}
        {notes.length === 0 && <p className="muted">Noch keine Notizen.</p>}
        {notes.map((note) => (
          <div className="list-row" key={note.id}>
            <div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{note.text}</div>
              <div className="muted">
                {note.authorFirstName} {note.authorLastName} · {formatDateTime(note.createdAt)}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Phase 12 (UI): kompakter Kommunikationsstatus, Kundenkontakte, Einstieg Nachrichten. */}
      <ProcessCommunicationCard processId={params.id} />

      <div className="card">
        <h2>Aktionen</h2>
        <p>
          {hasPermission(me, 'process.complete') && isEditable && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => void runAction(`/staff/processes/${params.id}/complete`, {})}
            >
              Vorgang abschließen
            </button>
          )}{' '}
          {hasPermission(me, 'process.reopen_completed') && !isEditable && (
            <button
              disabled={busy}
              onClick={() => void runAction(`/staff/processes/${params.id}/reopen`, {})}
            >
              Wieder öffnen
            </button>
          )}{' '}
          {hasPermission(me, 'process.cancel') && isEditable && !hasBooking && (
            <button
              className="danger"
              disabled={busy}
              onClick={() => void runAction(`/staff/processes/${params.id}/cancel`, {})}
            >
              Stornieren
            </button>
          )}{' '}
          {canCancelBooking && (
            <span style={{ position: 'relative', display: 'inline-block' }}>
              <button
                type="button"
                data-testid="process-more"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                disabled={busy}
                onClick={() => setMoreOpen((open) => !open)}
              >
                Mehr …
              </button>
              {moreOpen && (
                <span
                  role="menu"
                  className="card"
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: '100%',
                    zIndex: 10,
                    minWidth: '14rem',
                    padding: '0.5rem',
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="danger"
                    data-testid="cancel-booking"
                    disabled={busy}
                    style={{ width: '100%' }}
                    onClick={() => void openCancellationPreview()}
                  >
                    Buchung stornieren
                  </button>
                </span>
              )}
            </span>
          )}
        </p>
      </div>

      <div className="card">
        <h2>Anfrage &amp; Angebot</h2>
        <p>
          <Link href={`/vorgaenge/${params.id}/anfrage`}>
            Anfrage {commerce.hasInquiry ? 'ansehen/bearbeiten' : 'erfassen'}
          </Link>
        </p>
        <p>
          <Link href={`/vorgaenge/${params.id}/angebot`}>Angebot &amp; Auftragsbestätigung</Link>
        </p>
        <p>
          <Link href={`/vorgaenge/${params.id}/termine`}>Terminplanung</Link>
        </p>
        <p>
          <Link
            href={`/vorgaenge/${params.id}/kommunikation`}
            data-testid="process-link-communication"
          >
            Kommunikation
          </Link>
        </p>
      </div>

      {handover !== null && (
        <div className="card" data-testid="process-handover">
          <h2>Ausgabe</h2>
          <p>
            Gebucht:{' '}
            {handover.booking.machineQuantity > 1 ? `${handover.booking.machineQuantity} × ` : ''}
            {handover.booking.machineTypeName ?? 'Maschine'} ·{' '}
            {handover.booking.fulfillment === 'pickup' ? 'Selbstabholung' : 'Lieferung'}
          </p>
          <ul>
            {handover.slots.map((slot) => (
              <li key={slot.id}>
                Maschine {slot.slotNo}:{' '}
                {slot.machine === null ? (
                  <span className="badge locked">noch nicht zugewiesen</span>
                ) : (
                  <>
                    <strong>{slot.machine.machineCode}</strong>{' '}
                    <span
                      className={`badge ${slot.status === 'prepared' || slot.status === 'issued' ? 'ok' : ''}`}
                    >
                      {ASSIGNMENT_STATUS_LABELS[slot.status]}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
          <p>
            Ausgabestatus:{' '}
            {handover.handover.status === 'finalized' ? (
              <span className="badge ok">
                abgeschlossen am {formatBerlin(handover.handover.finalizedAt)}
              </span>
            ) : (
              <span className="badge">{NEXT_ACTION_LABELS[handover.nextAction]}</span>
            )}
          </p>
          <p>
            {process.mainStatus === 'cancelled' ? (
              <span className="muted">Storniert – keine Ausgabe mehr möglich.</span>
            ) : (
              <>
                <Link href={`/vorgaenge/${params.id}/ausgabe`}>Ausgabe vorbereiten</Link>
                {' · '}
                <Link href={`/vorgaenge/${params.id}/uebergabe`}>Übergabe</Link>
              </>
            )}
            {handoverDocs.map((doc) => (
              <span key={doc.id}>
                {' · '}
                <a href={`/api/staff/documents/${doc.id}`} target="_blank" rel="noreferrer">
                  {DOCUMENT_TYPE_LABELS[doc.type] ?? doc.type}
                </a>
              </span>
            ))}
          </p>
          {packets.map((packet) => (
            <p className="muted" key={packet.id} data-testid="delivery-packet">
              Dokumentpaket:{' '}
              <span
                className={`badge ${packet.status === 'sent' ? 'ok' : packet.status === 'failed' ? 'locked' : ''}`}
              >
                {PACKET_STATUS_LABELS[packet.status] ?? 'Unbekannt'}
              </span>{' '}
              an {packet.recipient !== '' ? packet.recipient : '– (keine E-Mail hinterlegt)'} ·{' '}
              {packet.subject} · {packet.documentIds.length}{' '}
              {packet.documentIds.length === 1 ? 'Dokument' : 'Dokumente'}
              {packet.status === 'sent' && packet.sentAt !== null
                ? ` · gesendet am ${formatBerlin(packet.sentAt)}`
                : ''}
            </p>
          ))}
        </div>
      )}

      {returnInfo !== null && (returnInfo.detail !== null || returnInfo.canStart) && (
        <div className="card" data-testid="process-return">
          <h2>Rückgabe</h2>
          {returnInfo.detail === null ? (
            <p>
              Maschinen ausgegeben –{' '}
              <Link href={`/vorgaenge/${params.id}/rueckgabe`}>Rückgabe starten</Link>
            </p>
          ) : (
            <>
              <ul>
                {returnInfo.detail.machines.map((machine) => (
                  <li key={machine.id}>
                    <strong>{machine.machineCode}</strong>{' '}
                    {machine.returnedAt !== null ? (
                      <span className="badge ok">
                        zurückgegeben am {formatBerlin(machine.returnedAt)}
                      </span>
                    ) : (
                      <span className="badge">Rückgabe offen</span>
                    )}
                    {machine.damages.length > 0 && (
                      <>
                        {' '}
                        <span className="badge locked">
                          {machine.damages.length} Schaden
                          {machine.damages.length === 1 ? '' : 'sfälle'}
                        </span>
                      </>
                    )}
                    {machine.missingCases.length > 0 && (
                      <>
                        {' '}
                        <span className="badge locked">Fehlteil</span>
                      </>
                    )}
                    {machine.cleanupRequired && (
                      <>
                        {' '}
                        <span className="badge locked">Reinigungsgebühr-Fakt</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              <p>
                Rückgabestatus:{' '}
                {returnInfo.detail.return.status === 'finalized' ? (
                  <span className="badge ok">
                    abgeschlossen am {formatBerlin(returnInfo.detail.return.finalizedAt)}
                  </span>
                ) : (
                  <span className="badge">
                    {RETURN_NEXT_ACTION_LABELS[returnInfo.detail.nextAction]}
                  </span>
                )}
              </p>
              <p>
                <Link href={`/vorgaenge/${params.id}/rueckgabe`}>Rückgabe öffnen</Link>
                {returnInfo.documents.map((doc) => (
                  <span key={doc.id}>
                    {' · '}
                    <a href={`/api/staff/documents/${doc.id}`} target="_blank" rel="noreferrer">
                      {DOCUMENT_TYPE_LABELS[doc.type] ?? doc.type}
                    </a>
                  </span>
                ))}
              </p>
            </>
          )}
        </div>
      )}

      {/* Phase 9: Abrechnung – entsteht nach finalisierter Rückgabe (§69). */}
      {canSettlement && hasBooking && process.mainStatus !== 'cancelled' && (
        <>
          {returnFinalized && settlement !== null ? (
            <div className="card" data-testid="process-settlement">
              <h2>Abrechnung</h2>
              <p>
                Status:{' '}
                <span
                  className={`badge ${settlement.settlement.status === 'transferred' ? 'ok' : ''}`}
                  data-testid="settlement-status"
                >
                  {settlementStatusLabel(settlement.settlement)}
                </span>{' '}
                {settlement.mock.isMock && <span className="badge">MOCK</span>}
              </p>
              <p>
                Noch offen:{' '}
                <strong data-testid="settlement-amount-due">
                  {formatCents(settlement.settlement.amountDueCents)}
                </strong>
                <span className="muted">
                  {' '}
                  (Gesamt {formatCents(settlement.settlement.grossTotalCents)}, bereits
                  berücksichtigt {formatCents(settlement.settlement.creditsTotalCents)})
                </span>
              </p>
              {settlement.settlement.overpaymentCents > 0 && (
                <p className="warning-red" data-testid="settlement-overpayment">
                  Überzahlung {formatCents(settlement.settlement.overpaymentCents)} –{' '}
                  {settlement.settlement.overpaymentHint ?? EXTERNAL_REFUND_HINT}
                </p>
              )}
              {settlement.settlement.status === 'transfer_failed' && (
                <p className="error">
                  {(settlement.settlement.accounting?.provider ??
                    settlement.settlement.accountingProvider) === 'lexware'
                    ? TRANSFER_CHECK_TEXT
                    : TRANSFER_FAILED_TEXT}
                </p>
              )}
              {settlement.settlement.accountingBlocker === 'not_configured' && (
                <p className="muted">{ACCOUNTING_NOT_CONFIGURED_HINT}</p>
              )}
              <p>
                <Link href={`/vorgaenge/${params.id}/abrechnung`} data-testid="settlement-open">
                  <strong>Abrechnung öffnen</strong>
                </Link>
                {settlement.settlement.status !== 'transferred' && (
                  <span className="muted"> – {settlement.dominantAction.label}</span>
                )}
              </p>
            </div>
          ) : returnFinalized && settlementMissing ? (
            <div className="card">
              <h2>Abrechnung</h2>
              <p className="muted">Für diese Rückgabe liegt noch keine Abrechnung vor.</p>
              {actionError !== null && <p className="error">{actionError}</p>}
              <p>
                <button
                  type="button"
                  className="primary"
                  data-testid="settlement-ensure"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setActionError(null);
                    void ensureSettlement(params.id).then(async (result) => {
                      setBusy(false);
                      if (result.data === null) {
                        setActionError(
                          result.errorMessage ?? 'Abrechnung konnte nicht erzeugt werden.',
                        );
                        return;
                      }
                      await loadSettlement();
                    });
                  }}
                >
                  Abrechnung erzeugen
                </button>
              </p>
            </div>
          ) : !returnFinalized ? (
            <div className="card">
              <h2>Abrechnung</h2>
              <p className="muted">Abrechnung entsteht nach Abschluss der Rückgabe.</p>
            </div>
          ) : null}
        </>
      )}

      {/* Phase 9: Anzahlung/Kaution – manuell erfasst, keine Zahlungsanbieter-UI (§74). */}
      {canSettlement && hasBooking && payments !== null && (
        <div className="card" data-testid="payments-section">
          <h2>Zahlungen / Kaution</h2>
          <p className="muted">
            Manuell erfasst, keine Banktransaktion. Eine aktive Anzahlung reduziert den offenen
            Betrag; eine gehaltene Kaution erst, wenn sie bewusst angewendet wird.
          </p>
          {paymentsError !== null && <p className="error">{paymentsError}</p>}
          {paymentsNotice !== null && <p className="success">{paymentsNotice}</p>}

          <h3 style={{ fontSize: '0.95rem', margin: '0.5rem 0 0.25rem' }}>Anzahlungen</h3>
          {payments.advancePayments.length === 0 && (
            <p className="muted">Keine Anzahlung erfasst.</p>
          )}
          {payments.advancePayments.map((advance) => (
            <div className="list-row" key={advance.id} data-testid="advance-item">
              <div>
                <strong>{formatCents(advance.amountCents)}</strong>{' '}
                <span className={`badge ${advance.status === 'active' ? 'ok' : 'locked'}`}>
                  {ADVANCE_STATUS_LABELS[advance.status] ?? advance.status}
                </span>
                <div className="muted">
                  erhalten am {formatEventDate(advance.receivedAt)}
                  {advance.externalReference !== null && advance.externalReference !== ''
                    ? ` · Referenz: ${advance.externalReference}`
                    : ''}
                </div>
              </div>
              {advance.status === 'active' && paymentPerms.recordAdvance && !settlementLocked && (
                <button
                  type="button"
                  data-testid="advance-cancel"
                  disabled={busy}
                  onClick={() =>
                    void runPayment(() => cancelAdvance(advance.id), 'Anzahlung storniert.')
                  }
                >
                  Anzahlung stornieren
                </button>
              )}
            </div>
          ))}
          {paymentPerms.recordAdvance && isEditable && !settlementLocked && (
            <form
              data-testid="advance-form"
              onSubmit={(e) => {
                e.preventDefault();
                void submitAdvance();
              }}
            >
              <label htmlFor="advance-amount">Anzahlung in €</label>
              <input
                id="advance-amount"
                data-testid="advance-amount"
                inputMode="decimal"
                placeholder="z. B. 100,00"
                value={advanceAmount}
                onChange={(e) => setAdvanceAmount(e.target.value)}
              />
              <label htmlFor="advance-received-at">Erhalten am</label>
              <input
                id="advance-received-at"
                data-testid="advance-received-at"
                type="date"
                value={advanceReceivedAt}
                onChange={(e) => setAdvanceReceivedAt(e.target.value)}
              />
              <label htmlFor="advance-reference">Externe Referenz (optional)</label>
              <input
                id="advance-reference"
                data-testid="advance-reference"
                value={advanceReference}
                onChange={(e) => setAdvanceReference(e.target.value)}
              />
              <p>
                <button
                  type="submit"
                  className="primary"
                  data-testid="advance-submit"
                  disabled={busy}
                >
                  Anzahlung erfassen
                </button>
              </p>
            </form>
          )}

          <h3 style={{ fontSize: '0.95rem', margin: '0.75rem 0 0.25rem' }}>Kaution</h3>
          {payments.securityDeposits.length === 0 && (
            <p className="muted">Keine Kaution erfasst.</p>
          )}
          {payments.securityDeposits.map((deposit) => (
            <div className="list-row" key={deposit.id} data-testid="deposit-item">
              <div style={{ flex: '1 1 12rem' }}>
                <strong>{formatCents(deposit.amountCents)}</strong>{' '}
                <span className={`badge ${deposit.status === 'held' ? 'ok' : ''}`}>
                  {DEPOSIT_STATUS_LABELS[deposit.status] ?? deposit.status}
                </span>
                <div className="muted">
                  erhalten am {formatEventDate(deposit.receivedAt)} · angewendet{' '}
                  {formatCents(deposit.appliedCents)} · noch gehalten{' '}
                  <span data-testid="deposit-held-remaining">
                    {formatCents(deposit.remainingHeldCents)}
                  </span>
                  {deposit.externalReference !== null && deposit.externalReference !== ''
                    ? ` · Referenz: ${deposit.externalReference}`
                    : ''}
                  {deposit.releasedAt !== null
                    ? ` · freigegeben am ${formatBerlin(deposit.releasedAt)} (keine Rücküberweisung durch das System)`
                    : ''}
                </div>
              </div>
              {deposit.status === 'held' && deposit.remainingHeldCents > 0 && (
                <div style={{ flex: '1 1 12rem' }}>
                  {paymentPerms.applyDeposit && (
                    <>
                      {returnFinalized && settlement !== null && !settlementLocked ? (
                        <>
                          <label htmlFor={`deposit-apply-${deposit.id}`}>
                            Auf Abrechnung anwenden (€)
                          </label>
                          <input
                            id={`deposit-apply-${deposit.id}`}
                            data-testid="deposit-apply-amount"
                            inputMode="decimal"
                            placeholder="z. B. 50,00"
                            value={depositApplyAmounts[deposit.id] ?? ''}
                            onChange={(e) =>
                              setDepositApplyAmounts((current) => ({
                                ...current,
                                [deposit.id]: e.target.value,
                              }))
                            }
                          />
                          <button
                            type="button"
                            className="primary"
                            data-testid="deposit-apply"
                            disabled={busy}
                            onClick={() => {
                              const amountCents = parseEuroInput(
                                depositApplyAmounts[deposit.id] ?? '',
                              );
                              if (amountCents === null || amountCents <= 0) {
                                setPaymentsError(
                                  'Bitte einen Betrag größer 0 eingeben (z. B. 50,00).',
                                );
                                return;
                              }
                              void runPayment(
                                () =>
                                  applyDeposit(deposit.id, {
                                    amountCents,
                                    version: deposit.version ?? 1,
                                  }),
                                'Kaution angewendet.',
                              ).then((ok) => {
                                if (ok)
                                  setDepositApplyAmounts((current) => ({
                                    ...current,
                                    [deposit.id]: '',
                                  }));
                              });
                            }}
                          >
                            Anwenden
                          </button>{' '}
                        </>
                      ) : (
                        <span className="muted">
                          {settlementLocked
                            ? 'Abrechnung gesperrt – Anwenden nicht mehr möglich. '
                            : 'Anwenden erst nach Abschluss der Rückgabe möglich. '}
                        </span>
                      )}
                    </>
                  )}
                  {paymentPerms.releaseDeposit && (
                    <button
                      type="button"
                      data-testid="deposit-release"
                      disabled={busy}
                      onClick={() =>
                        void runPayment(
                          () => releaseDeposit(deposit.id, deposit.version ?? 1),
                          'Kaution freigegeben (nur Zustand – keine Rücküberweisung).',
                        )
                      }
                    >
                      Freigeben
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          {paymentPerms.recordDeposit && isEditable && !settlementLocked && (
            <form
              data-testid="deposit-form"
              onSubmit={(e) => {
                e.preventDefault();
                void submitDeposit();
              }}
            >
              <label htmlFor="deposit-amount">Kaution in €</label>
              <input
                id="deposit-amount"
                data-testid="deposit-amount"
                inputMode="decimal"
                placeholder="z. B. 200,00"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
              />
              <label htmlFor="deposit-received-at">Erhalten am</label>
              <input
                id="deposit-received-at"
                data-testid="deposit-received-at"
                type="date"
                value={depositReceivedAt}
                onChange={(e) => setDepositReceivedAt(e.target.value)}
              />
              <label htmlFor="deposit-reference">Externe Referenz (optional)</label>
              <input
                id="deposit-reference"
                data-testid="deposit-reference"
                value={depositReference}
                onChange={(e) => setDepositReference(e.target.value)}
              />
              <p>
                <button
                  type="submit"
                  className="primary"
                  data-testid="deposit-submit"
                  disabled={busy}
                >
                  Kaution erfassen
                </button>
              </p>
            </form>
          )}
        </div>
      )}

      {/* Phase 9: Storno-Karte (§§57–64). */}
      {process.mainStatus === 'cancelled' && cancellation !== null && (
        <div className="card" data-testid="process-cancellation">
          <h2>Storno</h2>
          <p>
            <span
              className={`badge ${cancellation.financeStatus === 'paid' ? 'ok' : ''}`}
              data-testid="cancellation-finance-status"
            >
              {cancellation.financeStatusLabel !== ''
                ? cancellation.financeStatusLabel
                : CANCELLATION_FINANCE_LABELS[cancellation.financeStatus]}
            </span>{' '}
            {cancellation.accountingProvider === 'mock' && <span className="badge">MOCK</span>}
          </p>
          <p>
            Stornobetrag: <strong>{formatCents(cancellation.feeCents)}</strong> ·{' '}
            {cancellation.feePercent} % von {formatCents(cancellation.baseCents)} (regulärer
            Maschinenmietpreis) · {cancellation.remainingDays} Kalendertage bis zum Event (
            {formatEventDate(cancellation.eventDate)})
          </p>
          {cancellation.externalRefundReviewRequired && (
            <p className="warning-red">{EXTERNAL_REFUND_HINT}</p>
          )}
          {cancellation.financeStatus === 'accounting_pending' &&
            cancellation.lastTransferErrorCode !== null && (
              <p className="error">
                {cancellationAccounting.provider === 'lexware'
                  ? TRANSFER_CHECK_TEXT
                  : TRANSFER_FAILED_TEXT}
              </p>
            )}
          {cancellation.accountingBlocker === 'not_configured' && (
            <p className="muted">{ACCOUNTING_NOT_CONFIGURED_HINT}</p>
          )}
          {cancellation.financeStatus !== 'no_invoice' && (
            <AccountingBlockCard
              ids={CANCELLATION_ACCOUNTING_IDS}
              data={cancellationAccounting}
              customerId={process.customerId}
              title="Buchhaltung (Stornorechnung)"
            />
          )}
          {cancellation.releasedResources !== null && (
            <p className="muted">
              Freigegeben: {cancellation.releasedResources.appointments} Termine,{' '}
              {cancellation.releasedResources.assignments} Zuweisungen,{' '}
              {cancellation.releasedResources.machines} Maschinen.
            </p>
          )}
          <p className="muted">
            Kundenbestätigung:{' '}
            <span data-testid="cancellation-confirmation-status">
              {cancellation.confirmationStatus === 'sent'
                ? `gesendet am ${formatBerlin(cancellation.confirmationSentAt)}`
                : cancellation.confirmationStatus === 'queued'
                  ? 'Versand eingeplant'
                  : cancellation.confirmationStatus === 'failed'
                    ? 'Versand fehlgeschlagen'
                    : cancellation.confirmationStatus === 'blocked'
                      ? 'Versand nicht möglich (E-Mail-Versand blockiert)'
                      : 'vorbereitet, noch nicht gesendet'}
            </span>
          </p>
          {cancellationError !== null && <p className="error">{cancellationError}</p>}
          {cancellationNotice !== null && <p className="success">{cancellationNotice}</p>}
          {accountingStatus?.mockControlsAvailable === true && (
            <p data-testid="cancellation-mock-controls">
              <span className="badge">
                {(accountingStatus.mockPaymentControlsAvailable ?? accountingStatus.mock)
                  ? 'MOCK'
                  : 'TEST'}
              </span>{' '}
              <button
                type="button"
                data-testid="mock-run-jobs"
                disabled={busy}
                onClick={() =>
                  void runCancellationAction(() => mockRunDueJobs(), 'Fällige Jobs ausgeführt.')
                }
              >
                Fällige Jobs ausführen
              </button>{' '}
              {(accountingStatus.mockPaymentControlsAvailable ?? accountingStatus.mock) && (
                <button
                  type="button"
                  data-testid="mock-set-paid"
                  disabled={busy || cancellation.transfer === null}
                  onClick={() => {
                    if (cancellation.transfer === null) return;
                    const transferId = cancellation.transfer.id;
                    void runCancellationAction(
                      () => mockPaymentStatus(transferId, 'paid'),
                      'Zahlungsstatus auf „Bezahlt“ gesetzt (Mock).',
                    );
                  }}
                >
                  Als bezahlt markieren
                </button>
              )}
            </p>
          )}
          <p>
            {cancellation.permissions.canManualTransfer &&
              ((cancellation.financeStatus === 'accounting_pending' &&
                cancellation.accountingBlocker === null) ||
                cancellationAccounting.canRetry) && (
                <>
                  <button
                    type="button"
                    className="primary"
                    data-testid="cancellation-transfer"
                    disabled={busy}
                    onClick={() => setConfirmCancellationTransfer(true)}
                  >
                    {cancellation.lastTransferErrorCode !== null || cancellationAccounting.canRetry
                      ? (cancellationAccounting.retryLabel ??
                        (cancellationAccounting.provider === 'lexware'
                          ? RETRY_TRANSFER_LABEL_LEXWARE
                          : 'Übertragung erneut versuchen'))
                      : 'Jetzt an Buchhaltung übertragen'}
                  </button>{' '}
                </>
              )}
            {/* Phase 12 (UI): erneutes Senden nach failed/blocked – der Server entscheidet. */}
            {cancellation.permissions.canSendConfirmation &&
              cancellation.confirmationStatus !== 'sent' &&
              cancellation.confirmationStatus !== 'queued' && (
                <>
                  <button
                    type="button"
                    data-testid="cancellation-confirmation-send"
                    disabled={busy}
                    onClick={() =>
                      void runCancellationAction(
                        () => sendCancellationConfirmation(cancellation.id),
                        'Bestätigung zum Versand eingeplant.',
                      ).then((data) => {
                        if (data?.confirmationStatus === 'blocked') {
                          setCancellationNotice(null);
                          setCancellationError('Versand nicht möglich (E-Mail-Versand blockiert).');
                        }
                      })
                    }
                  >
                    {cancellation.confirmationStatus === 'prepared'
                      ? 'Bestätigung senden'
                      : 'Bestätigung erneut senden'}
                  </button>{' '}
                </>
              )}
            {cancellation.permissions.canCreateFollowUp && followUpProcess === null && (
              <button
                type="button"
                data-testid="follow-up-create"
                disabled={busy}
                onClick={() =>
                  void runCancellationAction(
                    () => createFollowUp(params.id),
                    'Neuer Vorgang erstellt.',
                  ).then((created) => {
                    if (created !== null) router.push(`/vorgaenge/${created.processId}`);
                  })
                }
              >
                Neuen Vorgang aus Storno erstellen
              </button>
            )}
          </p>
        </div>
      )}

      {/* Phase 9: Storno-Vorschau → ausdrückliche Bestätigung (§53, §73). */}
      {preview !== null && (
        <ConfirmDialog
          testId="cancellation-preview"
          title="Buchung stornieren?"
          confirmLabel="Buchung stornieren"
          confirmTestId="cancellation-confirm"
          busy={busy}
          danger
          disabled={preview.blockers.length > 0}
          maxWidth="32rem"
          onCancel={() => setPreview(null)}
          onConfirm={() => void confirmCancellation()}
        >
          <p>
            Event am <strong>{formatEventDate(preview.eventDate)}</strong> ·{' '}
            <span data-testid="cancellation-days">{preview.remainingDays}</span> Kalendertage
            verbleibend.
          </p>
          <p>
            Stornoregel: <strong data-testid="cancellation-percent">{preview.feePercent} %</strong>{' '}
            vom regulären Maschinenmietpreis{' '}
            <strong data-testid="cancellation-base">{formatCents(preview.baseCents)}</strong>
          </p>
          <p>
            Stornokosten:{' '}
            <strong data-testid="cancellation-fee" style={{ fontSize: '1.1rem' }}>
              {formatCents(preview.feeCents)}
            </strong>
          </p>
          {preview.machines.length > 0 && (
            <ul className="muted">
              {preview.machines.map((machine, index) => (
                <li key={index}>
                  {machine.quantity} × {machine.description} ·{' '}
                  {formatCents(machine.standardUnitPriceCents)} (Listenpreis)
                </li>
              ))}
            </ul>
          )}
          <p className="muted">
            Wird freigegeben: {preview.willRelease.appointments} Termine,{' '}
            {preview.willRelease.assignments} Maschinenzuweisungen,{' '}
            {preview.willRelease.reservedMachines} reservierte Maschinen. Keine Lagerbewegung, keine
            Ersatzbuchung.
          </p>
          {preview.externalRefundReviewRequired && (
            <p className="warning-red">{EXTERNAL_REFUND_HINT}</p>
          )}
          {preview.feeCents > 0 && !preview.accountingConfigured && (
            <p className="muted">{ACCOUNTING_NOT_CONFIGURED_HINT}</p>
          )}
          {preview.blockers.length > 0 && (
            <div className="conflict-box">
              <strong>Storno nicht möglich:</strong>
              <ul style={{ margin: '0.25rem 0 0' }}>
                {preview.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          )}
          {actionError !== null && <p className="error">{actionError}</p>}
        </ConfirmDialog>
      )}

      {confirmCancellationTransfer && cancellation !== null && (
        <ConfirmDialog
          testId="cancellation-transfer-dialog"
          title="Stornokosten an Buchhaltung übertragen?"
          confirmLabel="Jetzt übertragen"
          confirmTestId="cancellation-transfer-confirm"
          busy={busy}
          onCancel={() => setConfirmCancellationTransfer(false)}
          onConfirm={() => {
            setConfirmCancellationTransfer(false);
            // 200 mit `outcome` – Ergebnis auswerten; die Sicht lädt runCancellationAction neu.
            void runCancellationAction(
              () => cancellationTransfer(cancellation.id),
              'Übertragung ausgeführt.',
            ).then((data) => {
              if (data === null) return;
              const result = transferOutcomeMessage(data.outcome, data.errorCode);
              if (result.ok) {
                setCancellationNotice(result.text);
              } else {
                setCancellationNotice(null);
                setCancellationError(result.text);
              }
            });
          }}
        >
          <p>
            Stornokosten <strong>{formatCents(cancellation.feeCents)}</strong> werden an die
            Buchhaltung übertragen.
            {cancellation.accountingProvider === 'mock'
              ? ' Mock-Buchhaltung – kein echter Transfer.'
              : ''}
            {cancellationAccounting.provider === 'lexware'
              ? ' In Lexware wird genau eine finale Stornokosten-Rechnung erstellt; ein Versand erfolgt nicht automatisch.'
              : ''}
          </p>
        </ConfirmDialog>
      )}
    </main>
  );
}

export default function ProcessDetailPage() {
  return (
    <AuthGuard>
      <ProcessView />
    </AuthGuard>
  );
}
