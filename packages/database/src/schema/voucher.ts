/**
 * Wiedermieter-Gutschein (Phase 11, Order §§9–10, 12–13, 17, 35).
 *
 * Genau eine fachliche Gutscheinart (20 %, Maschinenmiete, einmalig,
 * kundengebunden, 12 Kalendermonate). Kein generisches Coupon-System.
 *
 * - `vouchers`: ein Gutschein je berechtigtem Ursprungs-Settlement
 *   (UNIQUE origin_settlement_id als DB-Backstop gegen Doppelausstellung).
 *   Der Code existiert in der Datenbank NUR als SHA-256-Hash der kompakten
 *   Form plus eine verschlüsselte, temporäre Versandkopie (AES-256-GCM,
 *   Schlüssel per HKDF aus AUTH_SECRET_KEY, Zweck `voucher-delivery-v1`), die
 *   Phase 12 nach bestätigtem Versand entfernt. Kein Klartext.
 * - `voucher_redemptions`: Historie je Einlösung (Reaktivierung nach
 *   kostenlosem Storno stellt die gespeicherte Restgültigkeit wieder her).
 *
 * Die Spalten `offer_versions.voucher_id` / `bookings.voucher_id` (commerce.ts)
 * verweisen ohne FK hierher, um einen Importzyklus zu vermeiden.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  index,
} from 'drizzle-orm/pg-core';
import { bookings, offers } from './commerce.ts';
import { customers, processes } from './crm.ts';
import { rentalReturns } from './returns.ts';
import { cancellations, settlements } from './settlement.ts';

export const voucherType = pgEnum('voucher_type', ['returning_customer_20']);

/** Gespeicherter Status; „abgelaufen“ wird lazy aus expires_at abgeleitet (§17). */
export const voucherStatus = pgEnum('voucher_status', ['active', 'reserved', 'redeemed']);

/** Phase 11 setzt nur `pending`; `sent` erst durch den echten Versand (Phase 12). */
export const voucherDeliveryStatus = pgEnum('voucher_delivery_status', ['pending', 'sent']);

export const vouchers = pgTable(
  'vouchers',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    voucherType: voucherType('voucher_type').notNull().default('returning_customer_20'),
    /** Besitzer: exakt der Kunde des Ursprungsvorgangs (§18). */
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    originProcessId: uuid('origin_process_id')
      .notNull()
      .references(() => processes.id),
    originBookingId: uuid('origin_booking_id')
      .notNull()
      .references(() => bookings.id),
    originReturnId: uuid('origin_return_id')
      .notNull()
      .references(() => rentalReturns.id),
    /** Genau EIN Gutschein je Ursprungs-Settlement (§10). */
    originSettlementId: uuid('origin_settlement_id')
      .notNull()
      .unique()
      .references(() => settlements.id),
    /** Serverseitig konstant 20 – nie editierbar (§9). */
    discountPercent: integer('discount_percent').notNull().default(20),
    /** SHA-256 (hex) der kompakten Code-Form `MR20XXXXXXXXXXXX` (§12). */
    codeHash: text('code_hash').notNull().unique(),
    /** Letzte 4 Zeichen für die maskierte Darstellung MR20-••••-••••-XXXX (§14). */
    codeSuffix: text('code_suffix').notNull(),
    status: voucherStatus('status').notNull().default('active'),
    activatedAt: timestamp('activated_at', { withTimezone: true }).notNull(),
    /** activated_at + 12 Kalendermonate (Berlin), nach Reaktivierung Stornozeit + Restdauer (§16/§40). */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Reservierung auf Offer-Ebene (nicht Version), gesetzt beim Versand (§28). */
    reservedOfferId: uuid('reserved_offer_id').references(() => offers.id),
    reservedAt: timestamp('reserved_at', { withTimezone: true }),
    deliveryStatus: voucherDeliveryStatus('delivery_status').notNull().default('pending'),
    /** Hinweis für Phase 12 (z. B. NO_EMAIL) – der Gutschein bleibt bestehen (§51). */
    deliveryProblemCode: text('delivery_problem_code'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    /**
     * Verschlüsselte temporäre Versandkopie (base64: iv|tag|ciphertext,
     * AES-256-GCM, AAD = Gutschein-ID). Wird von Phase 12 nach Versand
     * gelöscht (§13). NIE an Clients ausliefern.
     */
    deliveryCodeCiphertext: text('delivery_code_ciphertext'),
    /** Optimistic Locking für Reservierung/Einlösung/Reaktivierung (§45). */
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('vouchers_customer_idx').on(table.customerId),
    /** Ein Angebot kann höchstens EINEN Gutschein reserviert halten (§21/§29). */
    uniqueIndex('vouchers_reserved_offer_idx')
      .on(table.reservedOfferId)
      .where(sql`${table.reservedOfferId} IS NOT NULL`),
    check('vouchers_discount_percent_check', sql`${table.discountPercent} = 20`),
    check(
      'vouchers_expires_after_activation_check',
      sql`${table.expiresAt} > ${table.activatedAt}`,
    ),
    check(
      'vouchers_reservation_consistency_check',
      sql`(${table.status} = 'reserved') = (${table.reservedOfferId} IS NOT NULL)`,
    ),
  ],
);

export const voucherRedemptions = pgTable(
  'voucher_redemptions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    voucherId: uuid('voucher_id')
      .notNull()
      .references(() => vouchers.id),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id),
    /** Eine Buchung löst höchstens einmal ein (§34/§52). */
    bookingId: uuid('booking_id')
      .notNull()
      .unique()
      .references(() => bookings.id),
    processId: uuid('process_id')
      .notNull()
      .references(() => processes.id),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).notNull(),
    expiresAtBeforeRedemption: timestamp('expires_at_before_redemption', {
      withTimezone: true,
    }).notNull(),
    /** expires_at − redeemed_at als exakte positive Dauer in Sekunden (§36). */
    remainingValiditySeconds: integer('remaining_validity_seconds').notNull(),
    /** Kostenloses Storno, das diese Einlösung aufgehoben hat (§40). */
    cancellationId: uuid('cancellation_id').references(() => cancellations.id),
    reactivatedAt: timestamp('reactivated_at', { withTimezone: true }),
    /** Endgültiger Verbrauch, z. B. `paid_cancellation` (§41). */
    finalConsumptionReason: text('final_consumption_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('voucher_redemptions_voucher_idx').on(table.voucherId),
    check(
      'voucher_redemptions_remaining_positive_check',
      sql`${table.remainingValiditySeconds} > 0`,
    ),
  ],
);

export type VoucherRow = typeof vouchers.$inferSelect;
export type VoucherRedemptionRow = typeof voucherRedemptions.$inferSelect;
