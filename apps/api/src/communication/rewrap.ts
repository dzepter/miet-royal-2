/**
 * Schlüsselrotation der Kommunikations-Payloads (Phase 12, Order §8):
 * `pnpm communication:rewrap-secrets` kapselt vorhandene Ciphertexte mit dem
 * aktuellen COMMUNICATION_PAYLOAD_KEY neu.
 *
 * - vouchers.delivery_code_ciphertext: v1 (Phase 11, AUTH_SECRET_KEY) oder
 *   v2 mit Vorgängerschlüssel ⇒ decrypt ⇒ encrypt v2 (aktuell) ⇒ UPDATE.
 *   Nicht entschlüsselbar ⇒ delivery_problem_code
 *   DELIVERY_COPY_UNDECRYPTABLE; Gutschein, Hash und Ciphertext bleiben
 *   unangetastet (nie Codeänderung, auch nicht bei reserviert/eingelöst).
 * - mail_deliveries.secret_payload_ciphertext: ALLE Zeilen mit Payload außer
 *   `sent` (dort ist sie gelöscht) – Härtung RA-4: auch failed/outcome_unknown/
 *   blocked/sending, denn „erneut senden“ entschlüsselt die Payload der Quelle;
 *   ohne Rewrap wäre der Resend nach Entfernen des Vorgängerschlüssels
 *   dauerhaft unmöglich. Nicht entschlüsselbar ⇒ pending/retry werden
 *   blocked SECRET_UNDECRYPTABLE; bei allen anderen bleibt der Status (z. B.
 *   „Zustellung unklar“) unverändert – nur gezählt. Bereits als
 *   SECRET_UNDECRYPTABLE blockierte Zeilen werden nicht erneut betrachtet.
 *   Das reine Neuverschlüsseln ändert `updated_at` NICHT (Retention-Frist
 *   nicht prozessgebundener Zustellungen = Zeitpunkt des letzten Status-
 *   wechsels); die Blockierung ist ein Statuswechsel und setzt es.
 * Ausgabe ausschließlich Zähler – nie Klartext, nie Ciphertext.
 */
import { mailDeliveries, vouchers, type Database } from '@mietroyal/database';
import { and, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import { MAIL_BLOCKED_SECRET_UNDECRYPTABLE } from './types.ts';
import type { PayloadCrypto } from './payload-crypto.ts';

export const VOUCHER_DELIVERY_COPY_UNDECRYPTABLE = 'DELIVERY_COPY_UNDECRYPTABLE';

export interface RewrapCounters {
  scanned: number;
  current: number;
  rewrapped: number;
  undecryptable: number;
}

export interface RewrapResult {
  vouchers: RewrapCounters;
  mailDeliveries: RewrapCounters;
}

function counters(): RewrapCounters {
  return { scanned: 0, current: 0, rewrapped: 0, undecryptable: 0 };
}

export async function rewrapVoucherDeliveryCopies(
  db: Database,
  crypto: PayloadCrypto,
): Promise<RewrapCounters> {
  const result = counters();
  const rows = await db
    .select({ id: vouchers.id, ciphertext: vouchers.deliveryCodeCiphertext })
    .from(vouchers)
    .where(isNotNull(vouchers.deliveryCodeCiphertext));
  for (const row of rows) {
    if (row.ciphertext === null) continue;
    result.scanned += 1;
    if (crypto.inspect(row.ciphertext).current) {
      result.current += 1;
      continue;
    }
    let rewrapped: string;
    try {
      rewrapped = crypto.rewrap(row.ciphertext, 'voucher-delivery', row.id);
    } catch {
      result.undecryptable += 1;
      await db
        .update(vouchers)
        .set({ deliveryProblemCode: VOUCHER_DELIVERY_COPY_UNDECRYPTABLE, updatedAt: new Date() })
        .where(eq(vouchers.id, row.id));
      continue;
    }
    // Nur ersetzen, wenn die Kopie zwischenzeitlich nicht gelöscht/verändert wurde.
    await db
      .update(vouchers)
      .set({ deliveryCodeCiphertext: rewrapped, updatedAt: new Date() })
      .where(and(eq(vouchers.id, row.id), eq(vouchers.deliveryCodeCiphertext, row.ciphertext)));
    result.rewrapped += 1;
  }
  return result;
}

export async function rewrapMailSecretPayloads(
  db: Database,
  crypto: PayloadCrypto,
): Promise<RewrapCounters> {
  const result = counters();
  const rows = await db
    .select({ id: mailDeliveries.id, ciphertext: mailDeliveries.secretPayloadCiphertext })
    .from(mailDeliveries)
    .where(
      and(
        isNotNull(mailDeliveries.secretPayloadCiphertext),
        ne(mailDeliveries.status, 'sent'),
        // Bereits als nicht entschlüsselbar markierte Zeilen nicht bei jedem Lauf erneut zählen.
        or(
          ne(mailDeliveries.status, 'blocked'),
          isNull(mailDeliveries.blockedReason),
          ne(mailDeliveries.blockedReason, MAIL_BLOCKED_SECRET_UNDECRYPTABLE),
        ),
      ),
    );
  for (const row of rows) {
    if (row.ciphertext === null) continue;
    result.scanned += 1;
    if (crypto.inspect(row.ciphertext).current) {
      result.current += 1;
      continue;
    }
    let rewrapped: string;
    try {
      rewrapped = crypto.rewrap(row.ciphertext, 'mail-secret-payload', row.id);
    } catch {
      result.undecryptable += 1;
      await db
        .update(mailDeliveries)
        .set({
          status: 'blocked',
          blockedReason: MAIL_BLOCKED_SECRET_UNDECRYPTABLE,
          lastErrorCode: MAIL_BLOCKED_SECRET_UNDECRYPTABLE,
          updatedAt: new Date(),
        })
        .where(
          and(eq(mailDeliveries.id, row.id), inArray(mailDeliveries.status, ['pending', 'retry'])),
        );
      continue;
    }
    // Phase-12-Finalisierung (Review-Fund): reines Neuverschlüsseln ist KEIN Status-
    // wechsel ⇒ `updated_at` bleibt (Endzustandszeit der 90-Tage-Retention nicht
    // prozessgebundener Zustellungen, retention/cleanup.ts).
    await db
      .update(mailDeliveries)
      .set({ secretPayloadCiphertext: rewrapped })
      .where(
        and(
          eq(mailDeliveries.id, row.id),
          eq(mailDeliveries.secretPayloadCiphertext, row.ciphertext),
        ),
      );
    result.rewrapped += 1;
  }
  return result;
}

export async function rewrapCommunicationSecrets(
  db: Database,
  crypto: PayloadCrypto,
): Promise<RewrapResult> {
  return {
    vouchers: await rewrapVoucherDeliveryCopies(db, crypto),
    mailDeliveries: await rewrapMailSecretPayloads(db, crypto),
  };
}
