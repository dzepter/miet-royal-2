'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';

/**
 * QR-Scan (Phase-6-Order §13): Kamera nur während der aktiven Scan-Funktion,
 * Erkennung über die Browser-BarcodeDetector-API, wenn vorhanden. Der
 * erkannte Wert (QR-URL oder Identifier) wird AUTHENTIFIZIERT über den
 * Phase-5-Resolver aufgelöst; kein Hardwarezwang – der Identifier kann
 * immer auch manuell eingegeben werden.
 */
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}

function extractToken(raw: string): string {
  const trimmed = raw.trim();
  const match = /\/qr\/([0-9a-fA-F]{32,128})/.exec(trimmed);
  if (match?.[1] !== undefined) return match[1];
  return trimmed;
}

export function QrScanner({
  onResolved,
  onClose,
}: {
  onResolved: (machine: { machineId: string; machineCode: string }) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [manual, setManual] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function resolve(raw: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    const token = extractToken(raw);
    const result = await apiFetch<{ machineId: string; machineCode: string }>(
      `/staff/machines/qr/${encodeURIComponent(token)}`,
    );
    setBusy(false);
    if (result.data === null) {
      setError(result.errorMessage ?? 'QR-Code nicht gültig.');
      return false;
    }
    onResolved(result.data);
    return true;
  }

  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    const globalWindow = window as unknown as {
      BarcodeDetector?: new (o: { formats: string[] }) => BarcodeDetectorLike;
    };
    const canDetect =
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices?.getUserMedia !== undefined &&
      globalWindow.BarcodeDetector !== undefined;
    setSupported(canDetect);
    if (!canDetect) return;
    const detector = new globalWindow.BarcodeDetector!({ formats: ['qr_code'] });
    void navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video === null) return;
        video.srcObject = stream;
        void video.play();
        // Ein fehlgeschlagener Scan (fremder/unlesbarer Code) beendet die
        // Scan-Funktion nicht: weiter erkennen, denselben Wert kurz sperren.
        let rejectedValue: string | null = null;
        let rejectedUntil = 0;
        const tick = async () => {
          if (cancelled) return;
          try {
            const codes = await detector.detect(video);
            const first = codes[0];
            if (
              first !== undefined &&
              first.rawValue !== '' &&
              !(first.rawValue === rejectedValue && Date.now() < rejectedUntil)
            ) {
              if (await resolve(first.rawValue)) return;
              rejectedValue = first.rawValue;
              rejectedUntil = Date.now() + 3000;
            }
          } catch {
            // Frame noch nicht bereit – weiter versuchen.
          }
          if (!cancelled) frame = window.requestAnimationFrame(() => void tick());
        };
        frame = window.requestAnimationFrame(() => void tick());
      })
      .catch(() => setError('Kamera nicht verfügbar – bitte Identifier manuell eingeben.'));
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      // Kameraerlaubnis endet mit der Scan-Funktion.
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  return (
    <div className="card" data-testid="qr-scanner">
      <h3 style={{ marginTop: 0 }}>Maschine scannen</h3>
      {supported === true ? (
        <video
          ref={videoRef}
          muted
          playsInline
          style={{ width: '100%', maxWidth: 480, borderRadius: 8, background: '#000' }}
        />
      ) : (
        <p className="muted">
          Kamera-Scan wird von diesem Gerät/Browser nicht unterstützt – bitte den QR-Identifier oder
          die gescannte Adresse eingeben.
        </p>
      )}
      <p>
        <label htmlFor="qr-manual">QR-Identifier oder gescannte Adresse</label>
        <input
          id="qr-manual"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="z. B. …/qr/abcdef… oder Identifier"
        />
      </p>
      {error !== null && <p className="error">{error}</p>}
      <p>
        <button
          type="button"
          className="primary"
          disabled={busy || manual.trim() === ''}
          onClick={() => void resolve(manual)}
        >
          Auflösen
        </button>{' '}
        <button type="button" onClick={onClose}>
          Schließen
        </button>
      </p>
    </div>
  );
}
