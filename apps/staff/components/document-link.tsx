'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useOffline } from '../lib/offline/provider';

/**
 * Dokument-Link (Phase-8-Order §§12, 44): Dokumente aus dem Arbeitspaket
 * (Lieferschein, Protokolle, Auftragsbestätigung) liegen verschlüsselt im
 * lokalen Store und öffnen offline aus den entschlüsselten Bytes; online
 * (oder ohne lokale Kopie) wie bisher über die API. Nie über den SW-Cache.
 */
export function DocumentLink({
  documentId,
  children,
}: {
  documentId: string;
  children: ReactNode;
}) {
  const offline = useOffline();
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
  return (
    <button
      type="button"
      className="link-like"
      data-testid={`document-offline-${documentId}`}
      onClick={() => {
        void runtime.getDocumentBytes(documentId).then((bytes) => {
          if (bytes === null) return;
          const url = URL.createObjectURL(
            new Blob([bytes as BlobPart], { type: 'application/pdf' }),
          );
          window.open(url, '_blank', 'noopener');
          window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        });
      }}
    >
      {children} <span className="badge">offline verfügbar</span>
    </button>
  );
}
