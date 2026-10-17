'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useOffline } from '../lib/offline/provider';

/**
 * Dokument-Link (Phase-8-Order §§12, 44; Finalisierung §5): Dokumente aus dem
 * Arbeitspaket (Lieferschein, Protokolle, Auftragsbestätigung) liegen
 * verschlüsselt im lokalen Store. Offline öffnet der Link den geschützten
 * Viewer `/dokumente/<id>` INNERHALB der App-Sperre (kein fremder Tab, keine
 * Kopie außerhalb des Arbeitsbereichs); online (oder ohne lokale Kopie) wie
 * bisher über die API. Nie über den SW-Cache.
 */
export function DocumentLink({
  documentId,
  bookingId,
  children,
}: {
  documentId: string;
  /** Vorgang für den Rücksprung aus dem Viewer (optional). */
  bookingId?: string;
  children: ReactNode;
}) {
  const offline = useOffline();
  const router = useRouter();
  const [local, setLocal] = useState(false);
  const runtime = offline?.runtime ?? null;
  const unlocked = offline?.state.unlocked ?? false;

  useEffect(() => {
    if (runtime === null || !unlocked) {
      setLocal(false);
      return;
    }
    let cancelled = false;
    void runtime
      .hasDocument(documentId)
      .then((has) => {
        if (!cancelled) setLocal(has);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [documentId, runtime, unlocked]);

  const href = `/api/staff/documents/${documentId}`;
  const connectivity = offline?.state.connectivity ?? 'unknown';
  if (!local || runtime === null || connectivity === 'online') {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
        {local && <span className="badge"> offline verfügbar</span>}
      </a>
    );
  }
  const viewer = `/dokumente/${encodeURIComponent(documentId)}${
    bookingId !== undefined ? `?booking=${encodeURIComponent(bookingId)}` : ''
  }`;
  return (
    <button
      type="button"
      className="link-like"
      data-testid={`document-offline-${documentId}`}
      onClick={() => router.push(viewer)}
    >
      {children} <span className="badge">offline verfügbar</span>
    </button>
  );
}
