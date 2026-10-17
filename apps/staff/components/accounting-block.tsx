'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  ACCOUNTING_ATTENTION_TEXT,
  accountingProviderLabel,
  attentionLabel,
  blockerLabel,
  blockerNextAction,
  deliveryStatusLabel,
  PAYMENT_STATUS_LABELS_LEXWARE,
  TRANSFER_CHECK_TEXT,
  type AccountingBlock,
} from '../lib/lexware';

/**
 * Phase 10 (Order §§69–70, Vertrag §§6–7): Block „Buchhaltung“ für Abrechnung
 * und Storno. Zeigt ausschließlich Serverzustände: Provider, Rechnung
 * erstellt, Zahlung, Versand (nie „gesendet“), Rechnungsnummer/Deeplink nur
 * wenn geliefert (Recht), verständliche Blocker mit nächster Aktion und den
 * Attention-Hinweis. Keine Rohfehler, keine Fachlogik.
 */

export interface AccountingBlockTestIds {
  block: string;
  provider: string;
  invoiceStatus: string;
  paymentStatus: string;
  deliveryStatus: string;
  reference: string;
  openInvoice: string;
  blockers: string;
  blockerPrefix: string;
  attention: string;
  transferStatus: string;
}

export const SETTLEMENT_ACCOUNTING_IDS: AccountingBlockTestIds = {
  block: 'accounting-block',
  provider: 'accounting-provider',
  invoiceStatus: 'accounting-invoice-status',
  paymentStatus: 'payment-status',
  deliveryStatus: 'invoice-delivery-status',
  reference: 'accounting-reference',
  openInvoice: 'lexware-open-invoice',
  blockers: 'accounting-blockers',
  blockerPrefix: 'accounting-blocker-',
  attention: 'accounting-attention',
  transferStatus: 'accounting-transfer-status',
};

export const CANCELLATION_ACCOUNTING_IDS: AccountingBlockTestIds = {
  block: 'cancellation-accounting-block',
  provider: 'cancellation-accounting-provider',
  invoiceStatus: 'cancellation-invoice-status',
  paymentStatus: 'cancellation-payment-status',
  deliveryStatus: 'cancellation-delivery-status',
  reference: 'cancellation-reference',
  openInvoice: 'cancellation-open-invoice',
  blockers: 'cancellation-blockers',
  blockerPrefix: 'cancellation-accounting-blocker-',
  attention: 'cancellation-accounting-attention',
  transferStatus: 'cancellation-transfer-status',
};

/**
 * Normalisierte Sicht: der Vertragsblock `accounting`, ersatzweise aus den
 * Phase-9-Feldern zusammengesetzt (bis die API den Block liefert).
 */
export interface AccountingBlockData {
  provider: string | null;
  invoiceCreated: boolean;
  voucherNumber: string | null;
  deeplink: string | null;
  paymentStatus: string | null;
  paymentStatusLabel: string | null;
  deliveryStatus: string | null;
  attention: string | null;
  blockers: { code: string; label: string; action: string | null }[];
  canRetry: boolean;
  retryLabel: string | null;
  transferFailed: boolean;
}

export function accountingBlockData(input: {
  accounting: AccountingBlock | null | undefined;
  fallback: {
    provider: string | null;
    isMock: boolean;
    transferredAt: string | null;
    reference: string | null;
    referenceVisible: boolean;
    paymentStatus: string | null;
    paymentStatusLabel: string | null;
    deliveryStatus: string | null | undefined;
    transferFailed: boolean;
  };
}): AccountingBlockData {
  const { accounting, fallback } = input;
  const provider = accounting?.provider ?? fallback.provider ?? (fallback.isMock ? 'mock' : null);
  const invoice = accounting?.invoice ?? null;
  const blockers = (accounting?.blockers ?? []).map((blocker) => ({
    code: blocker.code,
    label: blockerLabel(blocker),
    action: blocker.action ?? null,
  }));
  return {
    provider,
    invoiceCreated: invoice !== null ? invoice.created : fallback.transferredAt !== null,
    voucherNumber:
      invoice?.voucherNumber ?? (fallback.referenceVisible ? fallback.reference : null) ?? null,
    deeplink: invoice?.deeplink ?? null,
    paymentStatus: invoice?.paymentStatus ?? fallback.paymentStatus,
    paymentStatusLabel: invoice?.paymentStatusLabel ?? fallback.paymentStatusLabel,
    deliveryStatus: invoice?.deliveryStatus ?? fallback.deliveryStatus ?? null,
    attention: attentionLabel(invoice),
    blockers,
    canRetry: accounting?.canRetry === true,
    retryLabel: accounting?.retryLabel ?? null,
    transferFailed: fallback.transferFailed,
  };
}

export function AccountingBlockCard({
  ids,
  data,
  customerId,
  title = 'Buchhaltung',
  children,
}: {
  ids: AccountingBlockTestIds;
  data: AccountingBlockData;
  customerId: string | null;
  title?: string;
  children?: ReactNode;
}) {
  const isLexware = data.provider === 'lexware';
  const paymentLabel =
    data.paymentStatus !== null
      ? (data.paymentStatusLabel ??
        PAYMENT_STATUS_LABELS_LEXWARE[data.paymentStatus] ??
        data.paymentStatus)
      : null;
  const showProblem = data.transferFailed || data.blockers.length > 0;

  return (
    <div className="card" data-testid={ids.block} aria-label={title}>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      <p>
        Buchhaltung:{' '}
        <span
          className={`badge ${isLexware ? 'ok' : ''}`}
          data-testid={ids.provider}
          aria-label="Buchhaltungssystem"
        >
          {accountingProviderLabel(data.provider)}
        </span>
        {data.invoiceCreated && (
          <>
            {' '}
            <span className="badge ok" data-testid={ids.invoiceStatus}>
              Rechnung: erstellt
            </span>
          </>
        )}
        {data.invoiceCreated && paymentLabel !== null && (
          <>
            {' '}
            <span className="badge" data-testid={ids.paymentStatus}>
              {paymentLabel}
            </span>
          </>
        )}
        {data.invoiceCreated && (
          <>
            {' '}
            <span className="badge" data-testid={ids.deliveryStatus}>
              Versand: {deliveryStatusLabel({ created: true, deliveryStatus: data.deliveryStatus })}
            </span>
          </>
        )}
      </p>
      {data.invoiceCreated && data.voucherNumber !== null && (
        <p className="muted">
          Rechnungsnummer: <span data-testid={ids.reference}>{data.voucherNumber}</span>
          {data.provider === 'mock' ? ' (Mock)' : ''}
          {data.deeplink !== null && data.deeplink !== '' && (
            <>
              {' '}
              ·{' '}
              <a
                href={data.deeplink}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={ids.openInvoice}
              >
                In Lexware öffnen
              </a>
            </>
          )}
        </p>
      )}
      {data.invoiceCreated && isLexware && (
        <p className="muted">
          Rechnungen werden nicht automatisch versendet – der Versand bleibt ausstehend, bis er
          ausdrücklich erfolgt.
        </p>
      )}
      {data.attention !== null && (
        <p className="warning-red" role="status" data-testid={ids.attention}>
          {ACCOUNTING_ATTENTION_TEXT}
          {data.attention !== ACCOUNTING_ATTENTION_TEXT ? ` – ${data.attention}` : ''}
          {data.deeplink !== null && data.deeplink !== '' && (
            <>
              {' '}
              <a href={data.deeplink} target="_blank" rel="noopener noreferrer">
                In Lexware prüfen
              </a>
            </>
          )}
        </p>
      )}
      {showProblem && isLexware && data.attention === null && (
        <p className="error" role="status" data-testid={ids.transferStatus}>
          {TRANSFER_CHECK_TEXT}
          {data.blockers.length === 0 ? ' – bitte erneut versuchen oder Einstellungen prüfen.' : ''}
        </p>
      )}
      {data.blockers.length > 0 && (
        <ul data-testid={ids.blockers} style={{ paddingLeft: '1.2rem', margin: '0 0 0.75rem' }}>
          {data.blockers.map((blocker) => {
            const next = blockerNextAction(blocker.code, { customerId });
            return (
              <li key={blocker.code} data-testid={`${ids.blockerPrefix}${blocker.code}`}>
                {blocker.label}
                {blocker.action !== null && blocker.action !== '' ? (
                  <span className="muted"> – {blocker.action}</span>
                ) : null}
                {next !== null && (
                  <>
                    {' '}
                    <Link href={next.href}>{next.label}</Link>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {children}
    </div>
  );
}
