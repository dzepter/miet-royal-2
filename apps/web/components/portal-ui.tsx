'use client';

import type { CSSProperties, ReactNode } from 'react';
import { telHref, type PortalBookingState } from '../lib/portal';

/**
 * Phase 15 (Kundenportal): gemeinsame Bausteine der /konto-Seiten im Stil der
 * bestehenden öffentlichen Seiten (Inline-Styles, kein CSS-Framework), mobile-
 * first. Status wird nie nur über Farbe vermittelt (Symbol + Text).
 */

export const card: CSSProperties = {
  background: '#ffffff',
  border: '1px solid #e2e2e2',
  borderRadius: 8,
  padding: '1.25rem',
  marginBottom: '1rem',
};

export const inputStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.7rem 0.75rem',
  fontSize: '1rem',
  border: '1px solid #c8c8c8',
  borderRadius: 6,
  margin: '0.25rem 0 0.9rem',
  background: '#ffffff',
  color: '#1a1a1a',
};

export const labelStyle: CSSProperties = { display: 'block', fontWeight: 600 };

export const mutedStyle: CSSProperties = { color: '#555' };

export function primaryButton(busy = false): CSSProperties {
  return {
    background: '#1b5e20',
    color: '#ffffff',
    border: 'none',
    borderRadius: 6,
    padding: '0.85rem 1.4rem',
    fontSize: '1.05rem',
    cursor: busy ? 'wait' : 'pointer',
    width: '100%',
    opacity: busy ? 0.8 : 1,
  };
}

export function dangerButton(busy = false): CSSProperties {
  return { ...primaryButton(busy), background: '#b3261e' };
}

export const secondaryButton: CSSProperties = {
  background: '#ffffff',
  color: '#1a1a1a',
  border: '1px solid #8a8a8a',
  borderRadius: 6,
  padding: '0.75rem 1.2rem',
  fontSize: '1rem',
  cursor: 'pointer',
  width: '100%',
};

export const linkButton: CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#0b57d0',
  cursor: 'pointer',
  padding: 0,
  fontSize: '1rem',
  textDecoration: 'underline',
};

export function PortalMain({
  children,
  wide = false,
  testId,
}: {
  children: ReactNode;
  wide?: boolean;
  testId?: string;
}) {
  return (
    <main
      style={{ maxWidth: wide ? '44rem' : '36rem', margin: '1.5rem auto', padding: '0 1rem 3rem' }}
      data-testid={testId}
    >
      {children}
    </main>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>{children}</h2>;
}

export function Loading({ text = 'Wird geladen …' }: { text?: string }) {
  return (
    <p style={{ color: '#666' }} role="status" data-testid="portal-loading">
      {text}
    </p>
  );
}

export function ErrorBox({
  message,
  testId = 'portal-error',
  children,
}: {
  message: string;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <div
      style={{ ...card, borderColor: '#b3261e', background: '#fdecea' }}
      role="alert"
      data-testid={testId}
    >
      <p style={{ margin: 0 }}>
        <span aria-hidden="true">⚠ </span>
        {message}
      </p>
      {children}
    </div>
  );
}

type Tone = 'success' | 'info' | 'warning';

const TONES: Record<Tone, { border: string; background: string; symbol: string }> = {
  success: { border: '#2e7d32', background: '#f1f8e9', symbol: '✓' },
  info: { border: '#4a76b8', background: '#eef3fb', symbol: 'ℹ' },
  warning: { border: '#e65100', background: '#fff3e0', symbol: '!' },
};

export function InfoBox({
  tone = 'info',
  testId,
  children,
}: {
  tone?: Tone;
  testId?: string;
  children: ReactNode;
}) {
  const t = TONES[tone];
  return (
    <div
      style={{ ...card, borderColor: t.border, background: t.background }}
      role="status"
      data-testid={testId}
    >
      <span aria-hidden="true" style={{ fontWeight: 700, marginRight: '0.4rem' }}>
        {t.symbol}
      </span>
      {children}
    </div>
  );
}

/** „Anrufen“ (Order §37): nur mit konfigurierter Nummer, sonst nichts. Kein WhatsApp. */
export function CallButton({
  phoneNumber,
  label = 'Anrufen',
  testId = 'portal-call',
}: {
  phoneNumber: string | null;
  label?: string;
  testId?: string;
}) {
  const href = telHref(phoneNumber);
  if (href === null) return null;
  return (
    <a
      href={href}
      data-testid={testId}
      style={{
        ...secondaryButton,
        display: 'block',
        textAlign: 'center',
        textDecoration: 'none',
        boxSizing: 'border-box',
      }}
    >
      <span aria-hidden="true">☎ </span>
      {label}
      {phoneNumber !== null ? ` (${phoneNumber})` : ''}
    </a>
  );
}

const STATE_STYLES: Record<
  PortalBookingState,
  { border: string; background: string; symbol: string }
> = {
  active: { border: '#2e7d32', background: '#f1f8e9', symbol: '✓' },
  completed_open: { border: '#4a76b8', background: '#eef3fb', symbol: '€' },
  cancelled_free: { border: '#8a8a8a', background: '#f3f3f3', symbol: '✕' },
  cancelled_fee: { border: '#e65100', background: '#fff3e0', symbol: '✕' },
};

/** Status-Badge: Symbol + Text (nie nur Farbe). */
export function StateBadge({ state, label }: { state: PortalBookingState; label: string }) {
  const s = STATE_STYLES[state];
  return (
    <span
      data-testid="portal-state-label"
      data-state={state}
      style={{
        display: 'inline-block',
        padding: '0.2rem 0.6rem',
        borderRadius: 999,
        border: `1px solid ${s.border}`,
        background: s.background,
        fontSize: '0.9rem',
        fontWeight: 600,
      }}
    >
      <span aria-hidden="true">{s.symbol} </span>
      {label}
    </span>
  );
}

export function DefinitionList({ rows }: { rows: { term: string; value: ReactNode }[] }) {
  return (
    <dl style={{ margin: 0 }}>
      {rows.map((row) => (
        <div
          key={row.term}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.25rem 1rem',
            padding: '0.35rem 0',
            borderBottom: '1px solid #f0f0f0',
          }}
        >
          <dt style={{ color: '#555', minWidth: '9rem' }}>{row.term}</dt>
          <dd style={{ margin: 0, flex: 1 }}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
