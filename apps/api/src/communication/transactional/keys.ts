/**
 * Transaktionsmails (Phase 12, Order §§11–16): Idempotenzschlüssel der
 * Outbox-Zustellungen und ihre Rückabbildung auf die Fachentität.
 *
 * Konvention: `<kind>:<entityId>` für die erste Zustellung; eine bewusste
 * Wiederholung nach einem Fehlschlag (AB, Kundeninformation) hängt
 * `:retry:<vorherigeDeliveryId>` an; Agent-M-Resends hängen `:resend:<id>`
 * an. Die Listener lesen die Entität ausschließlich aus dem Präfix – so
 * erreichen auch manuelle Resends (neue Delivery, neue Message-ID) den
 * fachlichen Status, ohne dass eine Tabelle je Zustellung nachgeführt
 * werden müsste.
 */

export const TRANSACTIONAL_KEY_KINDS = [
  'offer',
  'order_confirmation',
  'handover_protocol',
  'return_protocol',
  'settlement_notice',
  'cancellation_confirmation',
  'voucher_delivery',
  'invoice_delivery',
] as const;

export type TransactionalKeyKind = (typeof TRANSACTIONAL_KEY_KINDS)[number];

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const KEY_PATTERN = new RegExp(`^(${TRANSACTIONAL_KEY_KINDS.join('|')}):(${UUID})(?::|$)`);

export function transactionalKey(kind: TransactionalKeyKind, entityId: string): string {
  return `${kind}:${entityId}`;
}

/** Bewusste Wiederholung nach Fehlschlag: deterministisch je vorheriger Zustellung. */
export function transactionalRetryKey(
  kind: TransactionalKeyKind,
  entityId: string,
  previousDeliveryId: string,
): string {
  return `${kind}:${entityId}:retry:${previousDeliveryId}`;
}

export function parseTransactionalKey(
  idempotencyKey: string,
): { kind: TransactionalKeyKind; entityId: string } | null {
  const match = KEY_PATTERN.exec(idempotencyKey);
  if (match === null) return null;
  return { kind: match[1] as TransactionalKeyKind, entityId: match[2]!.toLowerCase() };
}

/** Fertige Anrede für die Vorlagen („Hallo Max Mustermann,“; ohne Namen „Hallo,“). */
export function mailSalutation(displayName: string | null | undefined): string {
  const name = (displayName ?? '').replace(/[\r\n\0]+/g, ' ').trim();
  return name === '' ? 'Hallo,' : `Hallo ${name.slice(0, 180)},`;
}

/** Kalenderdatum `JJJJ-MM-TT` aus einem Snapshot-Wert oder null. */
export function isoDateOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/** Dateiname ohne Pfad-/Steuerzeichen (Mail-Anhang). */
export function safeAttachmentName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned === '' ? 'Dokument' : cleaned.slice(0, 80);
}
