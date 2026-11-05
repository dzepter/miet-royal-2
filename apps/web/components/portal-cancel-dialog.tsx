'use client';

import { useEffect, useRef } from 'react';
import { euro, formatDate, remainingDaysText, type PortalCancellationPreview } from '../lib/portal';
import { CallButton, ErrorBox, card, dangerButton, mutedStyle, secondaryButton } from './portal-ui';

/**
 * Storno-Dialog (Order §39–§41; Design §5): eigene Komponente statt
 * `confirm()`. Zeigt die serverseitige Vorschau (Eventdatum, verbleibende
 * Tage, Prozentsatz, reguläre Maschinenmiet-Basis, exakte Gebühr) und die
 * bewusste Bestätigung „Buchung verbindlich stornieren“. Während der Anfrage
 * ist der Button gesperrt (Doppelklick-Schutz; die API ist zusätzlich
 * idempotent). Blocker ⇒ Kundentext + Anrufen, nie interne Gründe.
 */
export function PortalCancelDialog({
  preview,
  busy,
  error,
  phoneNumber,
  onConfirm,
  onClose,
}: {
  preview: PortalCancellationPreview;
  busy: boolean;
  error: string | null;
  phoneNumber: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const feeCents = preview.feeCents ?? 0;
  const days = remainingDaysText(preview.remainingDays);

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        padding: '1rem',
        zIndex: 100,
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="portal-cancel-title"
        data-testid="portal-cancel-dialog"
        style={{ ...card, width: '100%', maxWidth: '32rem', marginBottom: 0 }}
      >
        <h2 id="portal-cancel-title" style={{ marginTop: 0, fontSize: '1.2rem' }}>
          Buchung stornieren
        </h2>

        {preview.allowed ? (
          <>
            <p style={{ margin: '0 0 0.5rem' }}>
              Eventdatum: <strong>{formatDate(preview.eventDate)}</strong>
            </p>
            {days !== null && <p style={{ margin: '0 0 0.5rem', ...mutedStyle }}>{days}</p>}
            {preview.baseCents !== null && (
              <p style={{ margin: '0 0 0.5rem' }}>
                Reguläre Maschinenmiete: <strong>{euro(preview.baseCents)}</strong>
                {preview.feePercent !== null ? ` · Stornosatz ${preview.feePercent} %` : ''}
              </p>
            )}
            <p style={{ fontSize: '1.15rem', margin: '0.75rem 0' }}>
              <strong data-testid="portal-cancellation-fee">Stornogebühr: {euro(feeCents)}</strong>
            </p>
            <p style={{ ...mutedStyle, fontSize: '0.9rem' }}>
              {feeCents === 0
                ? 'Die Stornierung ist für dich kostenfrei.'
                : 'Die Stornogebühr stellen wir dir in Rechnung. Die Rechnung folgt.'}{' '}
              Die Stornierung kann nicht rückgängig gemacht werden.
            </p>
            {error !== null && <ErrorBox message={error} testId="portal-cancel-error" />}
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              style={dangerButton(busy)}
              data-testid="portal-cancel-confirm"
            >
              {busy ? 'Wird storniert …' : 'Buchung verbindlich stornieren'}
            </button>
          </>
        ) : (
          <>
            <p data-testid="portal-cancel-blocked">
              {preview.blockedMessage ??
                'Diese Buchung kann nicht mehr online storniert werden. Bitte kontaktiere uns.'}
            </p>
            <CallButton phoneNumber={phoneNumber} />
          </>
        )}

        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          disabled={busy}
          style={{ ...secondaryButton, marginTop: '0.75rem' }}
          data-testid="portal-cancel-close"
        >
          {preview.allowed ? 'Abbrechen – Buchung behalten' : 'Schließen'}
        </button>
      </div>
    </div>
  );
}
