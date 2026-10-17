'use client';

import type { ReactNode } from 'react';

/**
 * Kurze Bestätigung für kritische Aktionen (UX_RULES „Dialoge“: Storno,
 * manuelle Buchhaltungsübertragung …). Gleiche Optik wie der Logout-Dialog
 * (Phase 8); „Abbrechen“ ändert nichts.
 */
export function ConfirmDialog({
  testId,
  title,
  children,
  confirmLabel,
  confirmTestId,
  busy,
  danger = false,
  disabled = false,
  maxWidth = '22rem',
  onConfirm,
  onCancel,
}: {
  testId: string;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  confirmTestId: string;
  busy: boolean;
  danger?: boolean;
  disabled?: boolean;
  maxWidth?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="lock-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testId}
    >
      <div className="card" style={{ maxWidth }}>
        <h2 style={{ marginTop: 0 }}>{title}</h2>
        {children}
        <p>
          <button
            type="button"
            className={danger ? 'danger' : 'primary'}
            data-testid={confirmTestId}
            disabled={busy || disabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>{' '}
          <button type="button" data-testid={`${testId}-cancel`} disabled={busy} onClick={onCancel}>
            Abbrechen
          </button>
        </p>
      </div>
    </div>
  );
}
