'use client';

import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/**
 * Sicherer Dokumentlink (Phase 12, Order §13): genau EIN unveränderliches
 * Dokument (z. B. Rückgabeprotokoll aus der Schaden-/Fehlteil-Information).
 * Kein Konto, kein Portal; Autorität ist ausschließlich das Token. Das PDF
 * kommt über die API (`GET /public/documents/:token`, no-store) und wird nur
 * als Blob-URL im Speicher dieses Tabs eingebettet. Jeder Fehlerfall ⇒
 * dieselbe neutrale Meldung. Kein Tracking, keine externen Ressourcen.
 */

const NOT_AVAILABLE = 'Dieser Link ist nicht verfügbar.';

const card: React.CSSProperties = {
  background: '#ffffff',
  border: '1px solid #e2e2e2',
  borderRadius: 8,
  padding: '1.25rem',
  marginBottom: '1rem',
};

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; url: string }
  | { kind: 'not_available' }
  | { kind: 'failed'; message: string };

export default function PublicDocumentPage() {
  const params = useParams<{ token: string }>();
  const token = typeof params.token === 'string' ? params.token : '';
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void (async () => {
      let response: Response;
      try {
        response = await fetch(`/api/public/documents/${encodeURIComponent(token)}`, {
          cache: 'no-store',
        });
      } catch {
        if (!cancelled) {
          setState({
            kind: 'failed',
            message: 'Keine Verbindung. Bitte später erneut versuchen.',
          });
        }
        return;
      }
      if (response.status === 429) {
        if (!cancelled) {
          setState({
            kind: 'failed',
            message: 'Zu viele Aufrufe. Bitte in einigen Minuten erneut versuchen.',
          });
        }
        return;
      }
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok || !type.startsWith('application/pdf')) {
        if (!cancelled) setState({ kind: 'not_available' });
        return;
      }
      const blob = await response.blob();
      if (cancelled) return;
      const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
      urlRef.current = url;
      setState({ kind: 'ready', url });
    })();
    return () => {
      cancelled = true;
      const current = urlRef.current;
      urlRef.current = null;
      if (current !== null) URL.revokeObjectURL(current);
    };
  }, [token, attempt]);

  if (state.kind === 'not_available') {
    return (
      <main style={{ maxWidth: '36rem', margin: '10vh auto', padding: '1rem' }}>
        <div style={card} data-testid="document-not-available">
          <h1 style={{ fontSize: '1.25rem', marginTop: 0 }}>{NOT_AVAILABLE}</h1>
          <p style={{ marginBottom: 0, color: '#555' }}>
            Bei Fragen melde dich bitte direkt bei Miet-Royal.
          </p>
        </div>
      </main>
    );
  }

  if (state.kind === 'loading' || state.kind === 'failed') {
    return (
      <main style={{ maxWidth: '36rem', margin: '10vh auto', padding: '1rem' }}>
        {state.kind === 'failed' ? (
          <div style={card} role="alert">
            <p style={{ marginTop: 0 }}>{state.message}</p>
            <button
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
              style={{ padding: '0.6rem 1rem', fontSize: '1rem', cursor: 'pointer' }}
            >
              Erneut versuchen
            </button>
          </div>
        ) : (
          <p style={{ color: '#666' }}>Dokument wird geladen …</p>
        )}
      </main>
    );
  }

  return (
    <main
      style={{ maxWidth: '56rem', margin: '2rem auto', padding: '0 1rem 3rem' }}
      data-testid="document-page"
    >
      <h1 style={{ fontSize: '1.4rem' }}>Dein Dokument von Miet-Royal</h1>
      <div style={card}>
        <p style={{ marginTop: 0 }}>
          Dieses Dokument ist nur über deinen persönlichen Link abrufbar. Bitte gib den Link nicht
          weiter.
        </p>
        <p style={{ marginBottom: 0 }}>
          <a
            href={state.url}
            target="_blank"
            rel="noreferrer"
            data-testid="document-open"
            style={{ fontWeight: 600 }}
          >
            Dokument als PDF öffnen
          </a>
          {' · '}
          <a href={state.url} download="Miet-Royal-Dokument.pdf" data-testid="document-download">
            Herunterladen
          </a>
        </p>
      </div>
      <iframe
        src={state.url}
        title="Dokument (PDF)"
        data-testid="document-embed"
        style={{
          width: '100%',
          height: '75vh',
          border: '1px solid #e2e2e2',
          borderRadius: 8,
          background: '#ffffff',
        }}
      />
    </main>
  );
}
