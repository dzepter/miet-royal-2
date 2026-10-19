/**
 * Phase 12 (Inbound, Order §23): sichere Inhaltsaufbereitung eingehender
 * Nachrichten – reine Funktionen ohne I/O.
 *
 * - HTML wird NIE gerendert oder gespeichert: ein einfacher Tag-Stripper
 *   (keine Rendering-Bibliothek) wandelt HTML-only-Mails in Text um; Skripte,
 *   Styles und alle Tags (inkl. externer Bilder) verschwinden vollständig.
 * - Bildanhänge werden nur als JPEG/PNG/WebP akzeptiert – MIME-Typ UND
 *   Magic-Bytes müssen passen; alles andere (PDF/ZIP/Office/SVG/…) wird
 *   nie gespeichert.
 */
import { createHash } from 'node:crypto';

/** Maximale Textlänge einer Konversationszeile (Rest wird abgeschnitten). */
export const INBOUND_BODY_MAX_CHARS = 20_000;
export const INBOUND_BODY_TRUNCATED_NOTICE = '\n\n[… Nachricht gekürzt – Original war länger.]';
/** Größenlimit je Bildanhang (E-Mail). */
export const INBOUND_MAIL_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
/** Größenlimit je WhatsApp-Bild (Meta-Limit für Bilder: 5 MB). */
export const WHATSAPP_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

export type AllowedImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

const IMAGE_EXTENSION: Record<AllowedImageMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function imageExtensionFor(mime: AllowedImageMime): string {
  return IMAGE_EXTENSION[mime];
}

/** Erkennt den Bildtyp ausschließlich über Magic Bytes (nie über Dateiname/Header). */
export function detectImageMime(bytes: Uint8Array): AllowedImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return 'image/webp';
  }
  return null;
}

/** MIME-Angabe normalisieren (`image/jpg` ⇒ `image/jpeg`, Parameter entfernen). */
export function normalizeDeclaredMime(contentType: string | null | undefined): string {
  const base = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return base === 'image/jpg' ? 'image/jpeg' : base;
}

/**
 * Anhang-Prüfung (Order §23): deklarierter Typ UND Magic Bytes müssen
 * dasselbe erlaubte Bildformat ergeben; Größenlimit. Alles andere ⇒ null.
 */
export function acceptImageAttachment(
  declaredContentType: string | null | undefined,
  bytes: Uint8Array,
  maxBytes: number,
): AllowedImageMime | null {
  if (bytes.length === 0 || bytes.length > maxBytes) return null;
  const declared = normalizeDeclaredMime(declaredContentType);
  const detected = detectImageMime(bytes);
  if (detected === null) return null;
  if (declared !== detected) return null;
  return detected;
}

// ── HTML → Text ───────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  euro: '€',
  szlig: 'ß',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  laquo: '«',
  raquo: '»',
  copy: '©',
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code) : '';
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code) : '';
    }
    const named = NAMED_ENTITIES[entity];
    return named === undefined ? match : named;
  });
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Einfacher, sicherer Tag-Stripper: Script/Style/Head/Template samt Inhalt
 * entfernen, Blockelemente zu Zeilenumbrüchen, alle übrigen Tags löschen,
 * Entities dekodieren, Whitespace glätten. Das Ergebnis ist reiner Text –
 * es wird nie wieder als HTML interpretiert.
 */
export function htmlToSafeText(html: string): string {
  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(
    /<(script|style|head|template|noscript|iframe|object|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    '',
  );
  // Blockgrenzen ⇒ Zeilenumbruch (vor dem Entfernen der Tags).
  text = text.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  text = text.replace(
    /<\/\s*(p|div|li|tr|h[1-6]|blockquote|pre|table|section|article)\s*>/gi,
    '\n',
  );
  text = text.replace(/<\s*(li)\b[^>]*>/gi, '• ');
  text = text.replace(/<[^>]*>/g, '');
  text = decodeHtmlEntities(text);
  // Nach dem Dekodieren könnten erneut Tag-ähnliche Zeichen entstehen – die
  // sind jetzt reiner Text; wir entfernen nur Steuerzeichen.
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/[ \t\u00a0]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

// ── Steuerzeichen (Härtung RA-10) ─────────────────────────────────────────

/* eslint-disable no-control-regex */
const MULTILINE_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const SINGLE_LINE_CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;
/* eslint-enable no-control-regex */

/**
 * C0-Steuerzeichen entfernen (Härtung RA-10, Poison Message): PostgreSQL
 * lehnt NUL (0x00) in text/jsonb ab – eine einzige Mail mit `=00` würde sonst
 * den IMAP-Eingang blockieren. Mehrzeilig (Body): `\t` und `\n` bleiben,
 * `\r\n`/`\r` ⇒ `\n`, alle übrigen C0-Zeichen und DEL entfallen.
 * Einzeilig (Betreff, Absendername, Adressen, Message-IDs, Dateinamen): jede
 * Folge von Steuerzeichen inkl. Tab/Zeilenumbruch ⇒ ein Leerzeichen.
 */
export function stripControlChars(value: string, mode: 'multiline' | 'single_line'): string {
  if (mode === 'single_line') return value.replace(SINGLE_LINE_CONTROL_CHARS, ' ');
  return value.replace(/\r\n?/g, '\n').replace(MULTILINE_CONTROL_CHARS, '');
}

/** Textbody aus Klartext (bevorzugt) oder HTML (sicher konvertiert) – ohne Steuerzeichen. */
export function chooseInboundBody(input: { text?: string | null; html?: string | null }): string {
  const plain = stripControlChars(input.text ?? '', 'multiline').trim();
  if (plain !== '') return plain;
  const html = input.html ?? '';
  if (html.trim() === '') return '';
  return htmlToSafeText(html);
}

/** Textlimit mit Hinweis (Order §23). */
export function truncateBody(body: string, maxChars = INBOUND_BODY_MAX_CHARS): string {
  if (body.length <= maxChars) return body;
  return body.slice(0, maxChars) + INBOUND_BODY_TRUNCATED_NOTICE;
}

// ── Dedupe / Zuordnung ───────────────────────────────────────────────────

/** RFC-5322-Message-ID normalisieren: Steuerzeichen (RA-10), Whitespace und spitze Klammern entfernen. */
export function normalizeMessageId(value: string | null | undefined): string | null {
  const trimmed = (value ?? '')
    .replace(SINGLE_LINE_CONTROL_CHARS, '')
    .trim()
    .replace(/^<+/, '')
    .replace(/>+$/, '')
    .trim();
  return trimmed === '' ? null : trimmed.slice(0, 998);
}

/** Alle Message-IDs aus einem References-/In-Reply-To-Header (Reihenfolge erhalten). */
export function parseMessageIdList(value: string | readonly string[] | null | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(' ') : ((value as string | null | undefined) ?? '');
  const ids: string[] = [];
  for (const token of raw.split(/\s+/)) {
    const id = normalizeMessageId(token);
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Fallback-Dedupe NUR für Mails OHNE Message-ID (Härtung RA-6): SHA-256 über
 * From | Date | Subject | GESAMTER normalisierter Text (Whitespace geglättet)
 * | SHA-256 aller Anhänge (Reihenfolge erhalten). Fehlt der Date-Header,
 * gehen Mailbox/UIDVALIDITY/UID mit ein – der Fingerprint erkennt dann nur
 * noch exakte Wiederholungen derselben Nachricht (gleiche Antwort „Ja, passt.“
 * an zwei Tagen bleibt zwei Nachrichten).
 */
export function inboundMailFingerprint(input: {
  from: string | null;
  date: Date | null;
  subject: string | null;
  body: string;
  attachmentSha256?: readonly string[];
  /** Pflicht-Ersatz für ein fehlendes Date (Mailbox/UIDVALIDITY/UID). */
  uidFallback?: { mailbox: string; uidValidity: string; uid: number } | null;
}): string {
  const body = input.body.replace(/\s+/g, ' ').trim();
  const fallback = input.uidFallback ?? null;
  const material = [
    'v2',
    (input.from ?? '').trim().toLowerCase(),
    input.date === null ? '' : input.date.toISOString(),
    input.date === null && fallback !== null
      ? `${fallback.mailbox}/${fallback.uidValidity}/${fallback.uid}`
      : '',
    (input.subject ?? '').trim(),
    body,
    (input.attachmentSha256 ?? []).join(','),
  ].join('|');
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/**
 * Phase-12-Finalisierung (Retention §4.3): Dedupe-Schlüssel `message_id_hash`
 * = SHA-256 (hex) über die UTF-8-Bytes der NORMALISIERTEN Message-ID
 * (`normalizeMessageId`) – identisch mit dem Backfill der Migration 0024
 * (`encode(sha256(convert_to(message_id, 'UTF8')), 'hex')`). Der Klartext
 * wird in `inbound_mail_receipts` nie gespeichert.
 */
export function inboundMessageIdHash(normalizedMessageId: string): string {
  return createHash('sha256').update(normalizedMessageId, 'utf8').digest('hex');
}

/**
 * Pflichtwert der Spalte `fingerprint` (UNIQUE) für Mails MIT Message-ID:
 * eigener Namensraum je Message-ID – inhaltsgleiche, aber verschiedene Mails
 * kollidieren dadurch nie (Härtung RA-6).
 */
export function inboundMessageIdFingerprint(messageId: string): string {
  return createHash('sha256').update(`message-id|${messageId}`, 'utf8').digest('hex');
}

/** Vorgangsnummern-Format aus crm/process-service.ts (MR-YYYY-NNNN, Sequenz unbegrenzt). */
const PROCESS_NUMBER_PATTERN = /\bMR-\d{4}-\d{4,}\b/g;

/** Alle unterschiedlichen Vorgangsnummern in Betreff/Text (Order §21: nur bei genau einer zuordnen). */
export function extractProcessNumbers(...parts: readonly (string | null | undefined)[]): string[] {
  const found = new Set<string>();
  for (const part of parts) {
    if (part === null || part === undefined) continue;
    for (const match of part.matchAll(PROCESS_NUMBER_PATTERN)) found.add(match[0]);
  }
  return [...found];
}

/** Textvorschau für Listen (Unmatched-Inbox): einzeilig, max. n Zeichen. */
export function previewOf(body: string, maxChars = 200): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`;
}
