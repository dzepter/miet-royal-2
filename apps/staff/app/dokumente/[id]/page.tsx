'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { AuthGuard } from '../../../components/auth-guard';
import { APP_LOCKED_EVENT } from '../../../lib/api';
import { useOffline } from '../../../lib/offline/provider';

/**
 * Geschützter Offline-Dokument-Viewer (Phase-8-Finalisierung §5): zeigt ein
 * PDF aus dem lokalen, verschlüsselten Store INNERHALB der App-Sperre. Die
 * entschlüsselten Bytes leben nur als Blob-URL im Speicher dieses Tabs –
 * keine Kopie in Cache/IndexedDB/localStorage, kein Download-Trigger. Beim
 * Verlassen der Seite, bei App-Sperre (Event oder Laufzeit gesperrt) wird die
 * Blob-URL sofort widerrufen und der Frame entfernt. Der AuthGuard rendert
 * im gesperrten Zustand ausschließlich den Sperrbildschirm – diese Seite wird
 * dadurch unmountet, das Effekt-Cleanup widerruft die URL.
 */
function DocumentViewer() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const offline = useOffline();
  const documentId = typeof params.id === 'string' ? params.id : '';
  const bookingId = search.get('booking');
  const runtime = offline?.runtime ?? null;
  const unlocked = offline?.state.unlocked ?? false;
  const initialized = offline?.state.initialized ?? false;
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processId, setProcessId] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  // Rücksprung zum Vorgang (Prozess-ID aus dem lokalen Snapshot, nur Navigation).
  useEffect(() => {
    if (runtime === null || !unlocked || bookingId === null) {
      setProcessId(null);
      return;
    }
    let cancelled = false;
    void runtime
      .findBooking(bookingId)
      .then((snapshot) => {
        if (!cancelled) setProcessId(snapshot?.processId ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bookingId, runtime, unlocked]);

  useEffect(() => {
    const revoke = () => {
      const current = urlRef.current;
      urlRef.current = null;
      if (current !== null) URL.revokeObjectURL(current);
      setUrl(null);
    };
    if (runtime === null || !initialized) return;
    if (!unlocked) {
      revoke();
      setError('Der Offline-Arbeitsbereich ist gesperrt – bitte zuerst entsperren.');
      return;
    }
    let cancelled = false;
    setError(null);
    void runtime
      .getDocumentBytes(documentId)
      .then((bytes) => {
        if (cancelled) return;
        if (bytes === null) {
          setError('Dieses Dokument ist auf diesem Gerät nicht offline verfügbar.');
          return;
        }
        const next = URL.createObjectURL(
          new Blob([bytes as BlobPart], { type: 'application/pdf' }),
        );
        urlRef.current = next;
        setUrl(next);
      })
      .catch(() => {
        if (!cancelled) setError('Das Dokument konnte nicht geöffnet werden.');
      });
    // Sperre während der Anzeige: sofort widerrufen (zusätzlich zum Unmount durch den AuthGuard).
    window.addEventListener(APP_LOCKED_EVENT, revoke);
    return () => {
      cancelled = true;
      window.removeEventListener(APP_LOCKED_EVENT, revoke);
      revoke();
    };
  }, [documentId, initialized, runtime, unlocked]);

  const back = processId !== null ? `/vorgaenge/${processId}` : null;

  return (
    <main className="page" data-testid="document-viewer">
      <h1>Dokument</h1>
      <p className="muted">
        Offline-Ansicht aus dem verschlüsselten Arbeitsbereich dieses Geräts – wird beim Verlassen
        oder Sperren sofort verworfen.
        {back !== null && (
          <>
            {' '}
            <Link href={back}>Zum Vorgang</Link>
          </>
        )}
      </p>
      {offline === null || !initialized ? (
        <p className="error" data-testid="document-viewer-error">
          Der Offline-Arbeitsbereich ist auf diesem Gerät nicht aktiv.
        </p>
      ) : error !== null ? (
        <p className="error" data-testid="document-viewer-error">
          {error}
        </p>
      ) : url === null ? (
        <p className="muted">Dokument wird entschlüsselt …</p>
      ) : (
        <iframe
          data-testid="document-frame"
          src={url}
          title="Dokument (Offline-Ansicht)"
          style={{ width: '100%', minHeight: '75vh', border: '1px solid #ddd', borderRadius: 8 }}
        />
      )}
    </main>
  );
}

export default function DocumentPage() {
  return (
    <AuthGuard>
      <Suspense fallback={<p className="muted">Wird geladen …</p>}>
        <DocumentViewer />
      </Suspense>
    </AuthGuard>
  );
}
