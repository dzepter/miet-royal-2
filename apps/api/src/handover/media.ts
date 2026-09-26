import { inflateSync } from 'node:zlib';

/**
 * Gemeinsame Bild-/Signaturprüfungen für Übergabe (Phase 6) und Rückgabe
 * (Phase 7): Magic-Bytes gegen den deklarierten Typ, vollständige
 * PNG-Validierung für Unterschriften.
 */

export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

export type ImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

/**
 * Unterschrift-PNG prüfen (Magic, IHDR mit plausiblen Maßen, IDAT/IEND,
 * Bilddaten synchron dekomprimierbar): pdfkit dekomprimiert PNGs mit
 * Alphakanal ASYNCHRON – ein nicht dekodierbares Bild würde dort nicht als
 * Fehler zurückkommen, sondern den Prozess abbrechen. Deshalb wird jede
 * Unterschrift VOR dem Speichern vollständig geprüft; ein nicht
 * darstellbares Bild wäre ohnehin keine Unterschrift (Order §§33/37).
 */
export function signaturePngLooksValid(bytes: Uint8Array): boolean {
  return pngLooksValid(bytes, 2 * 1024 * 1024);
}

/**
 * Vollständige PNG-Prüfung für Bilder, die in ein PDF eingebettet werden
 * (Unterschriften, Rückgabe-/Schadensfotos): siehe signaturePngLooksValid.
 */
export function pngLooksValid(bytes: Uint8Array, maxBytes: number): boolean {
  if (bytes.length < 64 || bytes.length > maxBytes) return false;
  const buf = Buffer.from(bytes);
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return false;
  if (buf.readUInt32BE(8) !== 13 || buf.subarray(12, 16).toString('latin1') !== 'IHDR') {
    return false;
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0 || width > 10_000 || height > 10_000) return false;
  const bitDepth = buf[24] ?? 0;
  const colorType = buf[25] ?? -1;
  if (![1, 2, 4, 8, 16].includes(bitDepth) || ![0, 2, 3, 4, 6].includes(colorType)) return false;
  // Chunks durchlaufen, IDAT-Daten sammeln, IEND verlangen.
  const idat: Buffer[] = [];
  let offset = 8;
  let sawEnd = false;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('latin1');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) return false;
    if (type === 'IDAT') idat.push(buf.subarray(dataStart, dataEnd));
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
    offset = dataEnd + 4;
  }
  if (!sawEnd || idat.length === 0) return false;
  try {
    const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: 64 * 1024 * 1024 });
    // Mindestens eine Filterbyte-Zeile je Bildzeile.
    return raw.length >= height;
  } catch {
    return false;
  }
}

/** Deklarierter MIME-Typ muss zu den tatsächlichen Bytes passen (kein Fremdinhalt im Storage). */
export function imageMagicMatches(bytes: Uint8Array, mimeType: string): boolean {
  const head = Buffer.from(bytes.subarray(0, 12));
  if (mimeType === 'image/png') return head.subarray(0, 8).equals(PNG_MAGIC);
  if (mimeType === 'image/jpeg') return head.subarray(0, 3).equals(JPEG_MAGIC);
  if (mimeType === 'image/webp') {
    return (
      head.subarray(0, 4).toString('latin1') === 'RIFF' &&
      head.subarray(8, 12).toString('latin1') === 'WEBP'
    );
  }
  return false;
}

/**
 * JPEG-Struktur prüfen (SOI, Frame-Header SOF0–SOF2/SOF9–SOF11 mit
 * plausiblen Maßen): pdfkit liest JPEG-Header synchron und wirft bei
 * defekten Dateien – die Prüfung vor dem Speichern verhindert, dass ein
 * nicht darstellbares Foto erst bei der Finalisierung auffällt.
 */
export function jpegLooksValid(bytes: Uint8Array, maxBytes: number): boolean {
  if (bytes.length < 4 || bytes.length > maxBytes) return false;
  const buf = Buffer.from(bytes);
  if (!buf.subarray(0, 3).equals(JPEG_MAGIC)) return false;
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) return false;
    const marker = buf[offset + 1] ?? 0;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return false;
    const isSof = (marker >= 0xc0 && marker <= 0xc2) || (marker >= 0xc9 && marker <= 0xcb);
    if (isSof) {
      if (offset + 9 > buf.length) return false;
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return width > 0 && height > 0 && width <= 20_000 && height <= 20_000;
    }
    if (marker === 0xda || marker === 0xd9) return false; // Scan/EOI vor dem Frame-Header
    offset += 2 + length;
  }
  return false;
}

/** Foto, das in ein PDF eingebettet wird: JPEG oder PNG, strukturell prüfbar. */
export function embeddablePhotoLooksValid(
  bytes: Uint8Array,
  mimeType: string,
  maxBytes: number,
): boolean {
  if (mimeType === 'image/png') return pngLooksValid(bytes, maxBytes);
  if (mimeType === 'image/jpeg') return jpegLooksValid(bytes, maxBytes);
  return false;
}

export function imageExtension(mimeType: ImageMimeType): string {
  return mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
}
