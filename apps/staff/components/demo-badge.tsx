'use client';

import { useState } from 'react';
import {
  counterpartLabel,
  counterpartLoginUrl,
  DEMO_BADGE_SHORT,
  DEMO_BADGE_TEXT,
  useDemoDocumentTitle,
  useEnvironment,
  type EnvironmentCounterpart,
} from '../lib/demo';
import { ConfirmDialog } from './confirm-dialog';

/**
 * Phase 14 (Design §3): dauerhafte Demo-Kennzeichnung – Text + Rahmen, nie
 * nur Farbe. Kompakt (Tablet/Mobil) bleibt „DEMO“ sichtbar; der volle Text
 * steht immer im Markup und im aria-label.
 */
export function DemoBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={`demo-badge${compact ? ' demo-badge-compact' : ''}`}
      data-testid="demo-badge"
      role="status"
      aria-label={DEMO_BADGE_TEXT}
      title={DEMO_BADGE_TEXT}
    >
      {DEMO_BADGE_SHORT}
      <span className="demo-badge-long">{DEMO_BADGE_TEXT.slice(DEMO_BADGE_SHORT.length)}</span>
    </span>
  );
}

/**
 * Badge für Seiten ohne AuthGuard (Login, Passwort vergessen/zurücksetzen):
 * Umgebung über `GET /api/health`; Fehler ⇒ kein Badge.
 */
export function PublicDemoBadge() {
  const environment = useEnvironment();
  const isDemo = environment === 'demo';
  useDemoDocumentTitle(isDemo);
  if (!isDemo) return null;
  return (
    <p className="demo-badge-row">
      <DemoBadge />
    </p>
  );
}

/**
 * Live↔Demo-Wechsel (Design §4, Order §6): fester Origin + /login in einem
 * neuen Tab – ohne Session, ohne IDs, ohne aktuelle URL; vorher bewusste
 * Bestätigung (UX_RULES „Dialoge“), nie eine automatische Weiterleitung.
 */
export function SwitchEnvironmentButton({ counterpart }: { counterpart: EnvironmentCounterpart }) {
  const [open, setOpen] = useState(false);
  const label = counterpartLabel(counterpart);
  const target = counterpart.kind === 'demo' ? 'Demo' : 'Live';
  return (
    <>
      <button type="button" data-testid="switch-environment" onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && (
        <ConfirmDialog
          testId="switch-environment-dialog"
          title={`Zur ${target}-Umgebung wechseln?`}
          confirmLabel={label}
          confirmTestId="switch-environment-confirm"
          busy={false}
          maxWidth="26rem"
          onCancel={() => setOpen(false)}
          onConfirm={() => {
            window.open(counterpartLoginUrl(counterpart), '_blank', 'noopener,noreferrer');
            setOpen(false);
          }}
        >
          <p>
            Du wechselst zur {target}-Umgebung. Es wird nichts übertragen – keine Anmeldung, kein
            Vorgang, keine Daten. Du musst dich dort separat anmelden.
          </p>
          <p className="muted">Die {target}-Umgebung öffnet sich in einem neuen Tab.</p>
        </ConfirmDialog>
      )}
    </>
  );
}
