'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Gezeichnete Unterschrift (Phase-6-Order §33): Finger, Touch, Stift oder
 * Maus über Pointer-Events auf einem Canvas. Liefert PNG-Bytes als Base64;
 * kein externer Signaturanbieter, nichts wird geloggt.
 */
export function SignaturePad({
  label,
  signerName,
  disabled,
  onSubmit,
}: {
  label: string;
  signerName: string;
  disabled: boolean;
  onSubmit: (pngBase64: string) => Promise<void>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const context = canvas.getContext('2d');
    if (context === null) return;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.lineWidth = 2.5;
    context.lineCap = 'round';
    context.strokeStyle = '#111111';
  }, []);

  function position(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    drawing.current = true;
    const context = canvasRef.current?.getContext('2d');
    const { x, y } = position(event);
    context?.beginPath();
    context?.moveTo(x, y);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const context = canvasRef.current?.getContext('2d');
    const { x, y } = position(event);
    context?.lineTo(x, y);
    context?.stroke();
    setHasInk(true);
  }

  function end() {
    drawing.current = false;
  }

  function clear() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (canvas === null || context === null || context === undefined) return;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  }

  async function submit() {
    const canvas = canvasRef.current;
    if (canvas === null || !hasInk) return;
    setBusy(true);
    const dataUrl = canvas.toDataURL('image/png');
    await onSubmit(dataUrl.slice(dataUrl.indexOf(',') + 1));
    setBusy(false);
  }

  return (
    <div className="signature-pad" data-testid={`signature-${label}`}>
      <p>
        <strong>{label}</strong> · Unterzeichner: {signerName}
      </p>
      <canvas
        ref={canvasRef}
        width={600}
        height={220}
        aria-label={`Unterschrift ${label}`}
        style={{
          width: '100%',
          maxWidth: 600,
          height: 220,
          border: '2px dashed #999',
          borderRadius: 8,
          touchAction: 'none',
          background: '#fff',
        }}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        onPointerCancel={end}
      />
      <p>
        <button type="button" onClick={clear} disabled={disabled || busy}>
          Löschen
        </button>{' '}
        <button
          type="button"
          className="primary"
          disabled={disabled || busy || !hasInk}
          onClick={() => void submit()}
        >
          Unterschrift übernehmen
        </button>
      </p>
    </div>
  );
}
