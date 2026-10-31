/**
 * Phase 14: synthetische Bild-Platzhalter des Demo-Seeds (kleinste gültige
 * PNG-/JPEG-Dateien, 1×1 Pixel). Echte Referenz-/Schadensfotos der Marke sind
 * offen (OPEN_ITEMS „Marke / Assets“) – hier werden bewusst keine erfunden.
 */

/** Minimal gültiges PNG (1×1 Pixel) – Übergabe-/Rückgabefotos und Unterschriften. */
export const DEMO_PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Kleinstes gültiges JPEG (1×1 Pixel, SOF0) – Schadens-/Reinigungsfotos. */
export const DEMO_JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

export function demoPngBytes(): Uint8Array {
  return new Uint8Array(DEMO_PNG_1X1);
}

export function demoJpegBytes(): Uint8Array {
  return new Uint8Array(DEMO_JPEG_1X1);
}
