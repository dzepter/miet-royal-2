import type { AppConfig } from '@mietroyal/config';
import { vouchers, type Database } from '@mietroyal/database';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { decryptDeliveryCode } from './voucher-crypto.ts';

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
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

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
   * Klartext NUR serverseitig für den Versand (Phase 12). Wirft, wenn keine
   * Kopie mehr vorhanden ist oder der Schlüssel nicht passt (z. B. nach
   * Rotation von AUTH_SECRET_KEY) – der Hash bleibt davon unberührt.
   */
  async revealCodeForDelivery(voucherId: string): Promise<string> {
    const rows = await this.db
      .select({ ciphertext: vouchers.deliveryCodeCiphertext })
      .from(vouchers)
      .where(eq(vouchers.id, voucherId));
    const ciphertext = rows[0]?.ciphertext ?? null;
    if (ciphertext === null) throw new Error('Keine Versandkopie für diesen Gutschein vorhanden.');
    return decryptDeliveryCode(ciphertext, voucherId, this.config.auth.secretKey);
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
