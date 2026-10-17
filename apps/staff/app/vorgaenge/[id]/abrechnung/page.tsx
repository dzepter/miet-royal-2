'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  AccountingBlockCard,
  accountingBlockData,
  SETTLEMENT_ACCOUNTING_IDS,
} from '../../../../components/accounting-block';
import { AuthGuard } from '../../../../components/auth-guard';
import { ConfirmDialog } from '../../../../components/confirm-dialog';
import type { ApiResult } from '../../../../lib/api';
import { formatBerlin } from '../../../../lib/handover';
import { RETRY_TRANSFER_LABEL_LEXWARE, TRANSFER_CHECK_TEXT } from '../../../../lib/lexware';
import {
  ACCOUNTING_NOT_CONFIGURED_HINT,
  addLine,
  approveAndSendNotice,
  centsToInput,
  CLARIFICATION_TYPE_LABELS,
  customerResponse,
  endWaitNow,
  ensureSettlement,
  fetchNotice,
  fetchSettlement,
  formatCents,
  LINE_GROUPS,
  LINE_TYPE_LABELS,
  lockedHint,
  mockExpireWait,
  mockFailNext,
  mockPaymentStatus,
  mockRunDueJobs,
  parseEuroInput,
  releaseAsCalculated,
  removeLine,
  resolveClarification,
  settlementStatusLabel,
  TRANSFER_FAILED_TEXT,
  transferNow,
  transferOutcomeMessage,
  updateLine,
  VERSION_CONFLICT_HINT,
  type ClarificationView,
  type NoticeView,
  type SettlementLineView,
  type SettlementView,
} from '../../../../lib/settlement';

/**
 * Abrechnung eines Vorgangs (Phase 9, Order §§69–72): Positionsliste,
 * Summen, offene Klärungen, EINE dominante nächste Aktion. Alle Beträge,
 * Status und Rechte kommen aus der Server-Sicht – die UI rechnet nichts und
 * ist kein Berechtigungsschutz. Mutationen senden `version`; bei 409
 * VERSION_CONFLICT wird neu geladen.
 */

const SEVERITY_TEXT: Record<string, string> = {
  light: 'leicht',
  medium: 'mittel',
  severe: 'schwer',
};
const ACCESSORY_TEXT: Record<string, string> = { lid: 'Deckel', drip_tray: 'Tropfschale' };

interface LineDraft {
  lineId: string;
  amount: string;
  description: string;
}

function SettlementPage() {
  const params = useParams<{ id: string }>();
  const processId = params.id;
  const [view, setView] = useState<SettlementView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [noticePreview, setNoticePreview] = useState<NoticeView | null>(null);
  const [confirm, setConfirm] = useState<'end-wait' | 'transfer' | null>(null);
  const [clarificationAmounts, setClarificationAmounts] = useState<Record<string, string>>({});
  const [lineDraft, setLineDraft] = useState<LineDraft | null>(null);
  const [chargeType, setChargeType] = useState<'manual_charge' | 'late_fee'>('manual_charge');
  const [chargeDescription, setChargeDescription] = useState('');
  const [chargeAmount, setChargeAmount] = useState('');
  const [chargeNote, setChargeNote] = useState('');

  const load = useCallback(async () => {
    const result = await fetchSettlement(processId);
    if (result.data !== null) {
      setView(result.data);
      setNotFound(false);
    } else if (result.status === 404) {
      setView(null);
      setNotFound(true);
    } else {
      setError(result.errorMessage ?? 'Abrechnung konnte nicht geladen werden.');
    }
    setLoaded(true);
  }, [processId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Führt eine Mutation aus und übernimmt die zurückgelieferte Sicht; bei
   * Versionskonflikt wird die aktuelle Sicht geladen und der Hinweis gezeigt.
   */
  async function mutate<T>(
    run: () => Promise<ApiResult<T>>,
    options: { okNotice?: string; pick?: (data: T) => SettlementView | null } = {},
  ): Promise<T | null> {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await run();
    setBusy(false);
    if (!result.ok) {
      if (result.status === 409 && result.errorCode === 'VERSION_CONFLICT') {
        setNotice(VERSION_CONFLICT_HINT);
      } else {
        setError(result.errorMessage ?? 'Aktion fehlgeschlagen.');
      }
      await load();
      return null;
    }
    if (options.okNotice !== undefined) setNotice(options.okNotice);
    const next =
      options.pick !== undefined && result.data !== null ? options.pick(result.data) : null;
    if (next !== null) setView(next);
    else await load();
    return result.data;
  }

  const asView = (data: SettlementView): SettlementView => data;

  async function openNoticePreview(settlementId: string): Promise<void> {
    setError(null);
    const result = await fetchNotice(settlementId);
    if (result.data === null) {
      setError(result.errorMessage ?? 'Kundeninformation konnte nicht geladen werden.');
      return;
    }
    setNoticePreview(result.data);
  }

  if (!loaded) {
    return (
      <main className="page">
        <p className="muted">Lade …</p>
      </main>
    );
  }

  if (view === null) {
    return (
      <main className="page" data-testid="settlement-page">
        <p>
          <Link href={`/vorgaenge/${processId}`}>← Zum Vorgang</Link>
        </p>
        <div className="card">
          <h1 style={{ marginTop: 0 }}>Abrechnung</h1>
          {error !== null && <p className="error">{error}</p>}
          {notFound && (
            <>
              <p className="muted">
                Für diesen Vorgang liegt noch keine Abrechnung vor. Sie entsteht nach Abschluss der
                Rückgabe.
              </p>
              <p>
                <button
                  type="button"
                  className="primary"
                  data-testid="settlement-ensure"
                  disabled={busy}
                  onClick={() =>
                    void mutate(() => ensureSettlement(processId), {
                      pick: asView,
                      okNotice: 'Abrechnung erzeugt.',
                    })
                  }
                >
                  Abrechnung erzeugen
                </button>
              </p>
              {notice !== null && <p className="success">{notice}</p>}
            </>
          )}
        </div>
      </main>
    );
  }

  const s = view.settlement;
  const perms = view.permissions;
  const dominant = view.dominantAction;
  const locked = s.locked;
  const openClarifications = view.clarifications.filter((c) => c.status !== 'resolved');
  const lockText = lockedHint(s);

  const showNoticeReview =
    !locked &&
    perms.canRelease &&
    s.status === 'customer_notice_required' &&
    s.noticeSentAt === null;
  const showCustomerResponse =
    !locked &&
    perms.canRelease &&
    s.status === 'customer_waiting' &&
    s.customerResponseReceivedAt === null;
  const showRelease =
    !locked && perms.canRelease && s.customerResponseReceivedAt !== null && s.releasedAt === null;
  const showEndWait = !locked && perms.canEndWait && s.status === 'customer_waiting';
  const showTransferNow =
    !locked &&
    perms.canManualTransfer &&
    s.accountingBlocker === null &&
    (dominant.key === 'transfer_now' ||
      (s.status === 'ready_for_accounting' && s.manualTransferRequired));
  // Phase 10: Buchhaltungsblock (Vertrag §6) – ersatzweise aus den Phase-9-Feldern.
  const accounting = accountingBlockData({
    accounting: s.accounting,
    fallback: {
      provider: s.accountingProvider,
      isMock: view.mock.isMock,
      transferredAt: s.transferredAt,
      reference: s.accountingReference,
      referenceVisible: s.accountingReferenceVisible,
      paymentStatus: s.paymentStatus,
      paymentStatusLabel: s.paymentStatusLabel,
      deliveryStatus: s.invoiceDeliveryStatus,
      transferFailed: s.status === 'transfer_failed',
    },
  });
  const isLexware = accounting.provider === 'lexware';
  const showRetry =
    perms.canManualTransfer && (s.status === 'transfer_failed' || accounting.canRetry);
  const retryLabel =
    accounting.retryLabel ??
    (isLexware ? RETRY_TRANSFER_LABEL_LEXWARE : 'Übertragung erneut versuchen');

  const linesByType = (types: string[]): SettlementLineView[] =>
    view.lines.filter((line) => types.includes(line.type));
  const knownTypes = LINE_GROUPS.flatMap((group) => group.types as string[]);
  const otherLines = view.lines.filter((line) => !knownTypes.includes(line.type));

  function startEdit(line: SettlementLineView): void {
    setLineDraft({
      lineId: line.id,
      amount: centsToInput(line.amountCents),
      description: line.description,
    });
  }

  async function saveLine(line: SettlementLineView): Promise<void> {
    if (lineDraft === null) return;
    const amountCents = parseEuroInput(lineDraft.amount);
    if (amountCents === null || amountCents <= 0) {
      setError('Bitte einen Betrag größer 0 eingeben (z. B. 25,00).');
      return;
    }
    const body: { amountCents: number; description?: string; version: number } = {
      amountCents,
      version: s.version,
    };
    const description = lineDraft.description.trim();
    if (description !== '' && description !== line.description) body.description = description;
    const saved = await mutate(() => updateLine(s.id, line.id, body), {
      pick: asView,
      okNotice: 'Position gespeichert.',
    });
    if (saved !== null) setLineDraft(null);
  }

  async function submitCharge(): Promise<void> {
    const amountCents = parseEuroInput(chargeAmount);
    if (chargeDescription.trim() === '') {
      setError('Bitte eine Beschreibung angeben.');
      return;
    }
    if (amountCents === null || amountCents <= 0) {
      setError('Bitte einen Betrag größer 0 eingeben (z. B. 25,00).');
      return;
    }
    const body: {
      type: 'manual_charge' | 'late_fee';
      description: string;
      amountCents: number;
      internalNote?: string;
      version: number;
    } = {
      type: chargeType,
      description: chargeDescription.trim(),
      amountCents,
      version: s.version,
    };
    if (chargeNote.trim() !== '') body.internalNote = chargeNote.trim();
    const saved = await mutate(() => addLine(s.id, body), {
      pick: asView,
      okNotice: 'Nachbelastung hinzugefügt.',
    });
    if (saved !== null) {
      setChargeDescription('');
      setChargeAmount('');
      setChargeNote('');
    }
  }

  async function decideClarification(
    clarification: ClarificationView,
    decision: 'charge' | 'no_charge',
  ): Promise<void> {
    const body: {
      decision: 'charge' | 'no_charge';
      amountCents?: number;
      version: number;
    } = { decision, version: s.version };
    if (decision === 'charge') {
      const amountCents = parseEuroInput(clarificationAmounts[clarification.id] ?? '');
      if (amountCents === null || amountCents <= 0) {
        setError('Bitte einen Betrag größer 0 eingeben (z. B. 120,00).');
        return;
      }
      body.amountCents = amountCents;
    }
    await mutate(() => resolveClarification(s.id, clarification.id, body), {
      pick: asView,
      okNotice:
        decision === 'charge' ? 'Betrag festgelegt.' : 'Nicht berechnet – Klärung erledigt.',
    });
  }

  async function runTransfer(): Promise<void> {
    setConfirm(null);
    // 200 mit `outcome` – das Ergebnis wird ausgewertet, die Sicht in jedem Fall neu geladen.
    const data = await mutate(() => transferNow(s.id, s.version), {
      pick: (data) => data.settlement,
    });
    if (data === null) return;
    const result = transferOutcomeMessage(data.outcome, data.errorCode);
    if (result.ok) setNotice(result.text);
    else setError(result.text);
    await load();
  }

  function canDecide(clarification: ClarificationView): boolean {
    if (clarification.type === 'damage_cost') return perms.canSetDamageCost;
    if (clarification.type === 'missing_item_cost') return perms.canSetMissingCost;
    return false;
  }

  function renderLine(line: SettlementLineView) {
    const editing = lineDraft?.lineId === line.id;
    const isManual = line.type === 'manual_charge' || line.type === 'late_fee';
    return (
      <div className="list-row" key={line.id} data-testid={`settlement-line-${line.type}`}>
        <div style={{ flex: '1 1 14rem' }}>
          <div>
            <strong>{line.description}</strong>
          </div>
          <div className="muted">
            {LINE_TYPE_LABELS[line.type as keyof typeof LINE_TYPE_LABELS] ?? line.typeLabel}
            {line.quantity !== null && line.unitPriceCents !== null
              ? ` · ${line.quantity} ${line.unit ?? ''} × ${formatCents(line.unitPriceCents)}`
              : ''}
            {line.internalNote !== null && line.internalNote !== ''
              ? ` · Intern: ${line.internalNote}`
              : ''}
          </div>
          {editing && lineDraft !== null && (
            <div style={{ marginTop: '0.5rem' }}>
              {isManual && (
                <>
                  <label htmlFor={`line-desc-${line.id}`}>Beschreibung</label>
                  <input
                    id={`line-desc-${line.id}`}
                    value={lineDraft.description}
                    onChange={(e) => setLineDraft({ ...lineDraft, description: e.target.value })}
                  />
                </>
              )}
              <label htmlFor={`line-amount-${line.id}`}>Betrag in €</label>
              <input
                id={`line-amount-${line.id}`}
                data-testid="line-amount-input"
                inputMode="decimal"
                value={lineDraft.amount}
                onChange={(e) => setLineDraft({ ...lineDraft, amount: e.target.value })}
              />
              <p>
                <button
                  type="button"
                  className="primary"
                  data-testid="line-save"
                  disabled={busy}
                  onClick={() => void saveLine(line)}
                >
                  Speichern
                </button>{' '}
                <button type="button" disabled={busy} onClick={() => setLineDraft(null)}>
                  Abbrechen
                </button>
              </p>
            </div>
          )}
        </div>
        <div style={{ textAlign: 'right' }}>
          <strong>
            {line.direction === 'credit' ? '− ' : ''}
            {formatCents(line.amountCents)}
          </strong>
          {!locked && !editing && (line.editable || line.removable) && (
            <div style={{ marginTop: '0.25rem' }}>
              {line.editable && (
                <button
                  type="button"
                  className="link-like"
                  data-testid="line-edit"
                  disabled={busy}
                  onClick={() => startEdit(line)}
                >
                  Bearbeiten
                </button>
              )}
              {line.removable && (
                <button
                  type="button"
                  className="link-like"
                  data-testid="line-remove"
                  disabled={busy}
                  onClick={() =>
                    void mutate(() => removeLine(s.id, line.id, s.version), {
                      pick: asView,
                      okNotice: 'Position entfernt.',
                    })
                  }
                >
                  Entfernen
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderDominantAction() {
    const label = dominant.label;
    switch (dominant.key) {
      case 'resolve_clarifications':
        return (
          <a
            href="#clarifications"
            className="button-like primary"
            data-testid="settlement-dominant-action"
          >
            {label}
          </a>
        );
      case 'review_notice':
        return (
          <span data-testid="settlement-dominant-action" style={{ display: 'inline-block' }}>
            <button
              type="button"
              className="primary"
              data-testid="notice-review"
              disabled={busy || !perms.canRelease}
              onClick={() => void openNoticePreview(s.id)}
            >
              {label}
            </button>
          </span>
        );
      case 'release_as_calculated':
        return (
          <span data-testid="settlement-dominant-action" style={{ display: 'inline-block' }}>
            <button
              type="button"
              className="primary"
              data-testid="release-as-calculated"
              disabled={busy || !perms.canRelease}
              onClick={() =>
                void mutate(() => releaseAsCalculated(s.id, s.version), {
                  pick: asView,
                  okNotice: 'Wie berechnet freigegeben.',
                })
              }
            >
              {label}
            </button>
          </span>
        );
      case 'transfer_now':
        return (
          <span data-testid="settlement-dominant-action" style={{ display: 'inline-block' }}>
            <button
              type="button"
              className="primary"
              data-testid="transfer-now"
              disabled={busy || !perms.canManualTransfer}
              onClick={() => setConfirm('transfer')}
            >
              {label}
            </button>
          </span>
        );
      case 'retry_transfer':
        return (
          <span data-testid="settlement-dominant-action" style={{ display: 'inline-block' }}>
            <button
              type="button"
              className="primary"
              data-testid="retry-transfer"
              disabled={busy || !perms.canManualTransfer}
              onClick={() => setConfirm('transfer')}
            >
              {isLexware ? retryLabel : label}
            </button>
          </span>
        );
      default:
        return (
          <p data-testid="settlement-dominant-action" style={{ margin: 0 }}>
            <strong>{label}</strong>
            {dominant.hint !== null && dominant.hint !== '' ? (
              <span className="muted"> – {dominant.hint}</span>
            ) : null}
          </p>
        );
    }
  }

  return (
    <main className="page" data-testid="settlement-page">
      <p>
        <Link href={`/vorgaenge/${processId}`}>← Zum Vorgang {s.processNumber}</Link>
      </p>

      <div className="card">
        <h1 style={{ marginTop: 0 }}>Abrechnung {s.processNumber}</h1>
        <p>
          Status:{' '}
          <span
            className={`badge ${s.status === 'transferred' ? 'ok' : s.status === 'transfer_failed' ? 'locked' : ''}`}
            data-testid="settlement-status"
          >
            {settlementStatusLabel(s)}
          </span>{' '}
          {view.mock.isMock && (
            <span className="badge" data-testid="mock-badge">
              MOCK
            </span>
          )}
        </p>
        {lockText !== null && (
          <p className="muted" data-testid="settlement-locked-hint">
            {lockText}
            {s.transferredAt !== null ? ` Übertragen am ${formatBerlin(s.transferredAt)}.` : ''}
          </p>
        )}
        {s.status === 'transfer_failed' && (
          <p className="error" role="status">
            {isLexware ? TRANSFER_CHECK_TEXT : TRANSFER_FAILED_TEXT}
          </p>
        )}
        {s.accountingBlocker === 'not_configured' && (
          <p className="muted">{ACCOUNTING_NOT_CONFIGURED_HINT}</p>
        )}
      </div>

      <AccountingBlockCard
        ids={SETTLEMENT_ACCOUNTING_IDS}
        data={accounting}
        customerId={s.customerId ?? null}
      />

      <div className="card" aria-label="Nächste Aktion">
        <h2 style={{ marginTop: 0 }}>Nächste Aktion</h2>
        {error !== null && <p className="error">{error}</p>}
        {notice !== null && <p className="success">{notice}</p>}
        <div>{renderDominantAction()}</div>
        {dominant.key !== 'wait' &&
          dominant.hint !== null &&
          dominant.hint !== '' &&
          !['auto_planned', 'not_configured', 'locked'].includes(dominant.key) && (
            <p className="muted">{dominant.hint}</p>
          )}
        {s.status === 'customer_waiting' && (
          <p data-testid="settlement-wait-hint">
            <strong>Kundenrückmeldung abwarten.</strong>{' '}
            {s.manualTransferRequired
              ? 'Keine automatische Freigabe – die Übertragung erfolgt manuell.'
              : s.waitUntil !== null
                ? `Automatische Freigabe frühestens ab ${formatBerlin(s.waitUntil)}.`
                : ''}
          </p>
        )}
        {dominant.key === 'auto_planned' && s.autoTransferPlannedAt !== null && (
          <p className="muted">
            Automatische Übertragung geplant ab {formatBerlin(s.autoTransferPlannedAt)}.
          </p>
        )}
        {s.amountsChangedAfterNoticeAt !== null && !locked && (
          <p className="muted">
            Beträge wurden nach Versand der Kundeninformation geändert – keine zweite
            Kundeninformation, Übertragung nur manuell.
          </p>
        )}
        <p>
          {showNoticeReview && dominant.key !== 'review_notice' && (
            <>
              <button
                type="button"
                data-testid="notice-review"
                disabled={busy}
                onClick={() => void openNoticePreview(s.id)}
              >
                Kundeninformation prüfen
              </button>{' '}
            </>
          )}
          {showCustomerResponse && (
            <>
              <button
                type="button"
                data-testid="customer-response"
                disabled={busy}
                onClick={() =>
                  void mutate(() => customerResponse(s.id, s.version), {
                    pick: asView,
                    okNotice: 'Kundenrückmeldung vermerkt – Übertragung erfolgt manuell.',
                  })
                }
              >
                Kundenrückmeldung eingegangen
              </button>{' '}
            </>
          )}
          {showRelease && dominant.key !== 'release_as_calculated' && (
            <>
              <button
                type="button"
                data-testid="release-as-calculated"
                disabled={busy}
                onClick={() =>
                  void mutate(() => releaseAsCalculated(s.id, s.version), {
                    pick: asView,
                    okNotice: 'Wie berechnet freigegeben.',
                  })
                }
              >
                Wie berechnet freigeben
              </button>{' '}
            </>
          )}
          {showEndWait && (
            <>
              <button
                type="button"
                data-testid="end-wait-now"
                disabled={busy}
                onClick={() => setConfirm('end-wait')}
              >
                Jetzt freigeben
              </button>{' '}
            </>
          )}
          {showTransferNow && dominant.key !== 'transfer_now' && (
            <>
              <button
                type="button"
                data-testid="transfer-now"
                disabled={busy}
                onClick={() => setConfirm('transfer')}
              >
                Jetzt an Buchhaltung übertragen
              </button>{' '}
            </>
          )}
          {showRetry && dominant.key !== 'retry_transfer' && (
            <button
              type="button"
              data-testid="retry-transfer"
              disabled={busy}
              onClick={() => setConfirm('transfer')}
            >
              {retryLabel}
            </button>
          )}
        </p>
      </div>

      {noticePreview !== null && (
        <div className="card" data-testid="notice-preview">
          <h2 style={{ marginTop: 0 }}>Kundeninformation prüfen</h2>
          <p className="muted">
            An: {noticePreview.recipientEmail ?? '– (keine E-Mail hinterlegt)'} · Betreff:{' '}
            {noticePreview.subject}
          </p>
          <pre
            data-testid="notice-body"
            style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: '0 0 0.75rem' }}
          >
            {noticePreview.bodyText}
          </pre>
          <p>
            Summe der zusätzlichen Belastungen:{' '}
            <strong data-testid="notice-total">{formatCents(noticePreview.totalCents)}</strong>
          </p>
          {noticePreview.status === 'blocked' && (
            <p className="error">
              Versand nicht möglich: {noticePreview.blockedReason ?? 'kein Kommunikationsadapter'}.
            </p>
          )}
          {noticePreview.status === 'sent' ? (
            <p className="muted">Bereits gesendet am {formatBerlin(noticePreview.sentAt)}.</p>
          ) : (
            <p className="muted">
              Nach „Freigeben und senden“ beginnt das Wartefenster von 24 Stunden – nur einmal je
              Abrechnung.
            </p>
          )}
          <p>
            {noticePreview.status !== 'sent' && perms.canRelease && (
              <>
                <button
                  type="button"
                  className="primary"
                  data-testid="notice-send"
                  disabled={busy}
                  onClick={() =>
                    void mutate(() => approveAndSendNotice(s.id, s.version), {
                      pick: asView,
                      okNotice: 'Kundeninformation gesendet – Kundenrückmeldung abwarten.',
                    }).then((data) => {
                      if (data !== null) setNoticePreview(null);
                    })
                  }
                >
                  Freigeben und senden
                </button>{' '}
              </>
            )}
            <button type="button" disabled={busy} onClick={() => setNoticePreview(null)}>
              Schließen
            </button>
          </p>
        </div>
      )}

      {openClarifications.length > 0 && (
        <div className="card" id="clarifications" data-testid="clarifications">
          <h2 style={{ marginTop: 0 }}>Offene Klärungen</h2>
          {openClarifications.map((clarification) => (
            <div className="conflict-box" key={clarification.id} data-testid="clarification-item">
              <p style={{ margin: '0 0 0.25rem' }}>
                <strong>
                  {CLARIFICATION_TYPE_LABELS[
                    clarification.type as keyof typeof CLARIFICATION_TYPE_LABELS
                  ] ?? clarification.typeLabel}
                </strong>
                {clarification.title !== '' ? ` – ${clarification.title}` : ''}
              </p>
              {clarification.detail !== null && clarification.detail !== '' && (
                <p style={{ margin: '0 0 0.25rem' }}>{clarification.detail}</p>
              )}
              <p className="muted" style={{ margin: '0 0 0.5rem' }}>
                {clarification.context.machineCode !== undefined
                  ? `Maschine ${clarification.context.machineCode}`
                  : ''}
                {clarification.context.severity !== undefined
                  ? ` · Schwere: ${SEVERITY_TEXT[clarification.context.severity] ?? clarification.context.severity}`
                  : ''}
                {clarification.context.accessoryType !== undefined
                  ? ` · ${ACCESSORY_TEXT[clarification.context.accessoryType] ?? clarification.context.accessoryType}`
                  : ''}
                {clarification.context.missingQuantity !== undefined
                  ? ` · fehlt: ${clarification.context.missingQuantity}`
                  : ''}
                {clarification.context.description !== undefined &&
                clarification.context.description !== ''
                  ? ` · ${clarification.context.description}`
                  : ''}
                {clarification.context.photoCount !== undefined
                  ? ` · ${clarification.context.photoCount} Foto${clarification.context.photoCount === 1 ? '' : 's'}`
                  : ''}
                {' · '}
                <Link href={`/vorgaenge/${processId}/rueckgabe`}>Rückgabedokumentation öffnen</Link>
              </p>
              {clarification.type === 'customer_response' ? (
                <p className="muted" style={{ margin: 0 }}>
                  Entscheiden: unverändert abrechnen („Wie berechnet freigeben“), Betrag ändern oder
                  Position entfernen.
                </p>
              ) : canDecide(clarification) && !locked ? (
                <div>
                  <label htmlFor={`clar-amount-${clarification.id}`}>Betrag in €</label>
                  <input
                    id={`clar-amount-${clarification.id}`}
                    data-testid="clarification-charge-amount"
                    inputMode="decimal"
                    placeholder="z. B. 120,00"
                    value={clarificationAmounts[clarification.id] ?? ''}
                    onChange={(e) =>
                      setClarificationAmounts((current) => ({
                        ...current,
                        [clarification.id]: e.target.value,
                      }))
                    }
                  />
                  <p style={{ margin: '0.5rem 0 0' }}>
                    <button
                      type="button"
                      className="primary"
                      data-testid="clarification-charge"
                      disabled={busy}
                      onClick={() => void decideClarification(clarification, 'charge')}
                    >
                      Betrag festlegen
                    </button>{' '}
                    <button
                      type="button"
                      data-testid="clarification-no-charge"
                      disabled={busy}
                      onClick={() => void decideClarification(clarification, 'no_charge')}
                    >
                      Nicht berechnen
                    </button>
                  </p>
                </div>
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  {locked
                    ? 'Abrechnung gesperrt.'
                    : 'Dir fehlt das Recht, diesen Betrag festzulegen.'}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Positionen</h2>
        {LINE_GROUPS.map((group) => {
          const lines = linesByType(group.types);
          if (lines.length === 0) return null;
          return (
            <div key={group.key} style={{ marginBottom: '0.75rem' }}>
              <h3 className="muted" style={{ margin: '0.5rem 0 0.25rem', fontSize: '0.875rem' }}>
                {group.title}
              </h3>
              {lines.map(renderLine)}
            </div>
          );
        })}
        {otherLines.length > 0 && (
          <div style={{ marginBottom: '0.75rem' }}>
            <h3 className="muted" style={{ margin: '0.5rem 0 0.25rem', fontSize: '0.875rem' }}>
              Weitere Positionen
            </h3>
            {otherLines.map(renderLine)}
          </div>
        )}
        {view.lines.length === 0 && <p className="muted">Noch keine Positionen.</p>}

        <div className="list-row">
          <span>Gesamtbetrag</span>
          <strong data-testid="settlement-gross">{formatCents(s.grossTotalCents)}</strong>
        </div>
        <div className="list-row">
          <span>Bereits berücksichtigt (Anzahlung, angewendete Kaution)</span>
          <strong data-testid="settlement-credits">− {formatCents(s.creditsTotalCents)}</strong>
        </div>
        <div className="list-row">
          <span>
            <strong>Noch offen</strong>
          </span>
          <strong data-testid="settlement-amount-due">{formatCents(s.amountDueCents)}</strong>
        </div>
        {s.overpaymentCents > 0 && (
          <p className="warning-red" data-testid="settlement-overpayment-hint">
            Überzahlung {formatCents(s.overpaymentCents)} –{' '}
            {s.overpaymentHint ?? 'Externe Rückzahlung/Verrechnung prüfen'}
          </p>
        )}
      </div>

      {perms.canAddCharge && !locked && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Nachbelastung hinzufügen</h2>
          <p className="muted">
            Nur bewusst und manuell – Verspätungsgebühren entstehen nie automatisch.
          </p>
          <form
            data-testid="manual-charge-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submitCharge();
            }}
          >
            <label htmlFor="charge-type">Art</label>
            <select
              id="charge-type"
              data-testid="manual-charge-type"
              value={chargeType}
              onChange={(e) => setChargeType(e.target.value as 'manual_charge' | 'late_fee')}
            >
              <option value="manual_charge">Nachbelastung</option>
              <option value="late_fee">Verspätungsgebühr</option>
            </select>
            <label htmlFor="charge-description">Beschreibung</label>
            <input
              id="charge-description"
              data-testid="manual-charge-description"
              value={chargeDescription}
              onChange={(e) => setChargeDescription(e.target.value)}
            />
            <label htmlFor="charge-amount">Betrag in €</label>
            <input
              id="charge-amount"
              data-testid="manual-charge-amount"
              inputMode="decimal"
              placeholder="z. B. 25,00"
              value={chargeAmount}
              onChange={(e) => setChargeAmount(e.target.value)}
            />
            <label htmlFor="charge-note">Interne Notiz (optional)</label>
            <input
              id="charge-note"
              data-testid="manual-charge-note"
              value={chargeNote}
              onChange={(e) => setChargeNote(e.target.value)}
            />
            <p>
              <button
                type="submit"
                className="primary"
                data-testid="manual-charge-submit"
                disabled={busy}
              >
                Nachbelastung hinzufügen
              </button>
            </p>
          </form>
        </div>
      )}

      {view.mock.controlsAvailable && (
        <div className="card" data-testid="mock-controls">
          <h2 style={{ marginTop: 0 }}>
            {view.mock.isMock ? 'Mock-Steuerung' : 'Teststeuerung'}{' '}
            <span className="badge">{view.mock.isMock ? 'MOCK' : 'TEST'}</span>
          </h2>
          <p className="muted">
            {view.mock.isMock
              ? 'Nur Test/Demo – keine echte Buchhaltung, kein Versand.'
              : 'Nur Test/Entwicklung – führt fällige Hintergrundjobs sofort aus.'}
          </p>
          <p>
            <button
              type="button"
              data-testid="mock-expire-wait"
              disabled={busy || s.waitUntil === null}
              onClick={() =>
                void mutate(() => mockExpireWait(s.id), {
                  okNotice: 'Wartefenster als abgelaufen markiert.',
                })
              }
            >
              Wartefenster ablaufen lassen
            </button>{' '}
            <button
              type="button"
              data-testid="mock-run-jobs"
              disabled={busy}
              onClick={() =>
                void mutate(() => mockRunDueJobs()).then((data) => {
                  if (data !== null)
                    setNotice(
                      `Fällige Jobs ausgeführt: ${data.processed} verarbeitet, ${data.failed} fehlgeschlagen.`,
                    );
                })
              }
            >
              Fällige Jobs ausführen
            </button>{' '}
            {view.mock.isMock && (
              <>
                <button
                  type="button"
                  data-testid="mock-set-paid"
                  disabled={busy || view.transfer === null}
                  onClick={() => {
                    if (view.transfer === null) return;
                    const transferId = view.transfer.id;
                    void mutate(() => mockPaymentStatus(transferId, 'paid'), {
                      okNotice: 'Zahlungsstatus auf „Bezahlt“ gesetzt (Mock).',
                    });
                  }}
                >
                  Als bezahlt markieren
                </button>{' '}
                <button
                  type="button"
                  data-testid="mock-fail-next"
                  disabled={busy}
                  onClick={() =>
                    void mutate(() => mockFailNext(1), {
                      okNotice: 'Nächster Transfer schlägt fehl (Mock).',
                    })
                  }
                >
                  Nächsten Transfer fehlschlagen lassen
                </button>
              </>
            )}
          </p>
        </div>
      )}

      {confirm === 'end-wait' && (
        <ConfirmDialog
          testId="end-wait-dialog"
          title="Warten jetzt beenden?"
          confirmLabel="Jetzt freigeben"
          confirmTestId="end-wait-confirm"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void mutate(() => endWaitNow(s.id, s.version), {
              pick: asView,
              okNotice: 'Warten beendet – Übertragung erfolgt manuell.',
            });
          }}
        >
          <p>
            Das Wartefenster für die Kundenrückmeldung wird vorzeitig beendet. Danach gibt es keine
            automatische Übertragung – die Abrechnung wird manuell an die Buchhaltung übertragen.
          </p>
        </ConfirmDialog>
      )}

      {confirm === 'transfer' && (
        <ConfirmDialog
          testId="transfer-dialog"
          title="Jetzt an Buchhaltung übertragen?"
          confirmLabel="Jetzt übertragen"
          confirmTestId="transfer-confirm"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void runTransfer()}
        >
          <p>
            Noch offen: <strong>{formatCents(s.amountDueCents)}</strong>. Nach der Übertragung sind
            Positionen und Beträge gesperrt.
            {view.mock.isMock ? ' Übertragung an die Mock-Buchhaltung (kein echter Transfer).' : ''}
            {isLexware
              ? ' In Lexware wird genau eine finale Rechnung erstellt; ein Versand erfolgt nicht automatisch.'
              : ''}
          </p>
        </ConfirmDialog>
      )}
    </main>
  );
}

export default function SettlementRoutePage() {
  return (
    <AuthGuard>
      <SettlementPage />
    </AuthGuard>
  );
}
