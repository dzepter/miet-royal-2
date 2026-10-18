import type { AppConfig } from '@mietroyal/config';
import { customers, mailDeliveries, vouchers, type Database } from '@mietroyal/database';
import { isVoucherExpired } from '@mietroyal/domain';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { PayloadCrypto } from '../communication/payload-crypto.ts';

/** Härtung H6: abgelaufene Gutscheine werden nie (mehr) versendet. */
export const VOUCHER_PROBLEM_EXPIRED = 'VOUCHER_EXPIRED';

/** Warum „Gutschein jetzt senden“ gerade nicht möglich ist (Härtung RA-9/H6). */
export type VoucherSendNowBlock =
  | 'ALREADY_SENT'
  | 'NO_DELIVERY_COPY'
  | 'VOUCHER_EXPIRED'
  | 'NO_EMAIL'
  | 'DELIVERY_IN_PROGRESS'
  | 'DELIVERY_OUTCOME_UNKNOWN';

export interface VoucherSendNowState {
  canSendNow: boolean;
  block: VoucherSendNowBlock | null;
  /** Gescheiterte/blockierte Vorzustellung ⇒ die neue Zustellung erhält `…:retry:<id>`. */
  retryOfDeliveryId: string | null;
}

/**
 * Zentrale Regel für die Staff-Aktion „Gutschein jetzt senden“ (Profil-
 * Anzeige `canSendNow`, Route und Job nutzen dieselbe Prüfung): Gutschein
 * `pending` mit Versandkopie, nicht abgelaufen, Kunde hat E-Mail. Existiert
 * bereits eine Zustellung, ist eine NEUE nur nach `failed`/`blocked` erlaubt
 * (an die AKTUELLE Kundenadresse); läuft sie noch oder ist sie unklar
 * (outcome_unknown – der Kunde kann den Code erhalten haben), nicht.
 */
export async function voucherSendNowState(
  db: Database,
  voucher: {
    deliveryStatus: string;
    deliveryCodeCiphertext: string | null;
    expiresAt: Date;
    customerId: string;
    mailDeliveryId: string | null;
  },
  now: Date = new Date(),
): Promise<VoucherSendNowState> {
  const blocked = (block: VoucherSendNowBlock): VoucherSendNowState => ({
    canSendNow: false,
    block,
    retryOfDeliveryId: null,
  });
  if (voucher.deliveryStatus === 'sent') return blocked('ALREADY_SENT');
  if (voucher.deliveryStatus !== 'pending' || voucher.deliveryCodeCiphertext === null) {
    return blocked('NO_DELIVERY_COPY');
  }
  if (isVoucherExpired(voucher.expiresAt, now)) return blocked('VOUCHER_EXPIRED');
  const customerRows = await db
    .select({ email: customers.email })
    .from(customers)
    .where(eq(customers.id, voucher.customerId));
  if ((customerRows[0]?.email ?? '').trim() === '') return blocked('NO_EMAIL');
  if (voucher.mailDeliveryId === null) {
    return { canSendNow: true, block: null, retryOfDeliveryId: null };
  }
  const deliveryRows = await db
    .select({ status: mailDeliveries.status })
    .from(mailDeliveries)
    .where(eq(mailDeliveries.id, voucher.mailDeliveryId));
  const status = deliveryRows[0]?.status ?? 'failed';
  if (status === 'failed' || status === 'blocked') {
    return { canSendNow: true, block: null, retryOfDeliveryId: voucher.mailDeliveryId };
  }
  if (status === 'outcome_unknown') return blocked('DELIVERY_OUTCOME_UNKNOWN');
  if (status === 'sent') return blocked('ALREADY_SENT');
  return blocked('DELIVERY_IN_PROGRESS');
}

/**
 * Phase-12-Schnittstelle (Order §§13/15/50): Versand vorbereiten, NICHT
 * versenden. Phase 11 setzt `delivery_status = pending` und hält nur die
 * verschlüsselte Kopie; Phase 12 findet offene Zustellungen, entschlüsselt
 * ausschließlich serverseitig, versendet und löscht die Kopie – der
 * Code-Hash bleibt (Einlösbarkeit unverändert). Es gibt KEINE Route dafür.
 */
export interface PendingVoucherDelivery {
  voucherId: string;
  customerId: string;
  originProcessId: string;
  deliveryProblemCode: string | null;
  createdAt: Date;
}

export class VoucherDeliveryService {
  private readonly crypto: PayloadCrypto;

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {
    this.crypto = new PayloadCrypto(config);
  }

  /** Offene Zustellungen (pending mit vorhandener Versandkopie), älteste zuerst. */
  async listPendingDeliveries(limit = 100): Promise<PendingVoucherDelivery[]> {
    const rows = await this.db
      .select({
        voucherId: vouchers.id,
        customerId: vouchers.customerId,
        originProcessId: vouchers.originProcessId,
        deliveryProblemCode: vouchers.deliveryProblemCode,
        createdAt: vouchers.createdAt,
      })
      .from(vouchers)
      .where(
        and(eq(vouchers.deliveryStatus, 'pending'), isNotNull(vouchers.deliveryCodeCiphertext)),
      )
      .orderBy(asc(vouchers.createdAt))
      .limit(limit);
    return rows;
  }

  /**
   * Klartext NUR serverseitig für den Versand (Phase 12). Liest v2
   * (COMMUNICATION_PAYLOAD_KEY, aktuell oder Vorgänger) UND Legacy v1
   * (Phase 11, AUTH_SECRET_KEY); nach erfolgreichem Lesen einer nicht
   * aktuellen Kopie wird sie sofort v2 neu gekapselt (Order §8). Wirft, wenn
   * keine Kopie mehr vorhanden ist oder kein Schlüssel passt – der Hash
   * bleibt davon unberührt.
   */
  async revealCodeForDelivery(voucherId: string): Promise<string> {
    const rows = await this.db
      .select({ ciphertext: vouchers.deliveryCodeCiphertext })
      .from(vouchers)
      .where(eq(vouchers.id, voucherId));
    const ciphertext = rows[0]?.ciphertext ?? null;
    if (ciphertext === null) throw new Error('Keine Versandkopie für diesen Gutschein vorhanden.');
    const code = this.crypto.decrypt(ciphertext, 'voucher-delivery', voucherId);
    if (!this.crypto.inspect(ciphertext).current) {
      await this.db
        .update(vouchers)
        .set({
          deliveryCodeCiphertext: this.crypto.encrypt(code, 'voucher-delivery', voucherId),
          updatedAt: new Date(),
        })
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.deliveryCodeCiphertext, ciphertext)));
    }
    return code;
  }

  /** Phase 12: Versandproblem (NO_EMAIL, MAIL_FAILED, …) sichtbar machen – Gutschein bleibt gültig. */
  async markDeliveryProblem(voucherId: string, code: string, now = new Date()): Promise<void> {
    await this.db
      .update(vouchers)
      .set({ deliveryProblemCode: code, updatedAt: now })
      .where(and(eq(vouchers.id, voucherId), eq(vouchers.deliveryStatus, 'pending')));
  }

  /** Nach bestätigtem Versand: sent, delivered_at, Kopie entfernt; Hash bleibt. */
  async markDelivered(voucherId: string, deliveredAt = new Date()): Promise<void> {
    await this.db
      .update(vouchers)
      .set({
        deliveryStatus: 'sent',
        deliveredAt,
        deliveryProblemCode: null,
        deliveryCodeCiphertext: null,
        updatedAt: deliveredAt,
      })
      .where(eq(vouchers.id, voucherId));
  }
}
