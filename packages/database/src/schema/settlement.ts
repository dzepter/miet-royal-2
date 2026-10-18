import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bookings } from './commerce.ts';
import { processes } from './crm.ts';
import { rentalReturns, type machineDamages, type missingAccessoryCases } from './returns.ts';
import { staffUsers } from './staff-auth.ts';

/**
 * Phase 9 – Abrechnung (Settlement), Anzahlung/Kaution, Buchhaltungstransfer
 * (Mock-Gateway, Phase 10: Lexware), Storno und Folgevorgang.
 *
 * Grundprinzip (Order §2): Die Abrechnung entsteht ausschließlich aus
 * eingefrorenen historischen Fakten (Booking-Snapshot, finaler Lieferschein,
 * Phase-7-Rückgabefakten, Schaden-/Fehlteilentscheidungen, autorisierte
 * manuelle Positionen, erfasste Zahlungen). Alle Beträge sind Integer-Cent.
 * Keine MwSt-Logik (Order §3) – das Accounting-Payload ist so geschnitten,
 * dass Phase 10 Steuerinformationen ergänzen kann.
 */

// ── Enums ─────────────────────────────────────────────────────────────────

export const settlementStatus = pgEnum('settlement_status', [
  'preparing',
  'clarification_required',
  'customer_notice_required',
  'customer_waiting',
  'ready_for_accounting',
  'transferring',
  'transferred',
  'transfer_failed',
]);

export const settlementLineType = pgEnum('settlement_line_type', [
  'machine_rental',
  'delivery',
  'purchase',
  'commission_consumption',
  'discount',
  'cleanup_fee',
  'damage_charge',
  'missing_item_charge',
  'late_fee',
  'manual_charge',
  'advance_payment_credit',
  'deposit_applied_credit',
]);

/** Herkunft einer Position – zusammen mit `source_key` eindeutig je Settlement (Order §5). */
export const settlementLineSourceType = pgEnum('settlement_line_source_type', [
  'booking_item',
  'booking_delivery',
  'booking_discount',
  /** Wiedermieter-Gutschein aus dem Buchungs-Snapshot (Phase 11, §38) – Typ discount. */
  'booking_voucher',
  'delivery_note_item',
  'return_inventory_item',
  'return_machine',
  'machine_damage',
  'missing_accessory_case',
  'manual',
  'advance_payment',
  'security_deposit',
]);

export const settlementClarificationType = pgEnum('settlement_clarification_type', [
  'damage_cost',
  'missing_item_cost',
  'customer_notice',
  'customer_response',
]);

export const settlementClarificationStatus = pgEnum('settlement_clarification_status', [
  'open',
  'resolved',
]);

export const customerNoticeStatus = pgEnum('settlement_customer_notice_status', [
  'prepared',
  'approved',
  'sent',
  'blocked',
]);

export const accountingTransferKind = pgEnum('accounting_transfer_kind', [
  'settlement',
  'cancellation',
]);

export const accountingTransferStatus = pgEnum('accounting_transfer_status', [
  'pending',
  'succeeded',
  'failed',
  /** Phase 10: Transfer beansprucht, externer Aufruf läuft (Sperre NICHT gehalten). */
  'in_progress',
  /** Phase 10: externer Aufruf ohne Antwort – Recovery vor jedem erneuten CREATE. */
  'outcome_unknown',
  /** Phase 10: manuelle Buchhaltungsprüfung erforderlich (Summen-/Kontakt-/Extern-Abweichung). */
  'attention',
]);

export const accountingProvider = pgEnum('accounting_provider', ['mock', 'disabled', 'lexware']);

/** Externer Zahlungsstatus (Order §42) – Miet-Royal ist dafür nicht Source of Truth. */
export const accountingPaymentStatus = pgEnum('accounting_payment_status', [
  'open',
  'paid',
  'overdue',
]);

export const advancePaymentStatus = pgEnum('advance_payment_status', ['active', 'cancelled']);

export const securityDepositStatus = pgEnum('security_deposit_status', [
  'held',
  'released',
  'applied',
]);

export const cancelerType = pgEnum('cancellation_canceler_type', ['employee', 'admin', 'customer']);

export const cancellationFinanceStatus = pgEnum('cancellation_finance_status', [
  'no_invoice',
  'accounting_pending',
  'invoice_open',
  'paid',
]);

export const processRelationKind = pgEnum('process_relation_kind', ['cancellation_follow_up']);

// ── Settlement ────────────────────────────────────────────────────────────

/**
 * Genau EIN Settlement je regulär zurückgegebener Buchung (Order §4). Der
 * Finanzstatus ist bewusst vom Vorgangs-Hauptstatus getrennt.
 */
export const settlements = pgTable(
  'settlements',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    processId: uuid('process_id')
      .notNull()
      .unique()
      .references(() => processes.id),
    bookingId: uuid('booking_id')
      .notNull()
      .unique()
      .references(() => bookings.id),
    returnId: uuid('return_id')
      .notNull()
      .unique()
      .references(() => rentalReturns.id),
    status: settlementStatus('status').notNull().default('preparing'),
    /** Feste Buchungsbasis (Miete + Lieferung − Rabatt, nie < 0), Cent – @mietroyal/domain computeSettlementTotals. */
    fixedTotalCents: integer('fixed_total_cents').notNull().default(0),
    /** Variable Positionen aus Ausgabe-/Rückgabefakten (Kaufartikel, Kommission, Reinigung), Cent. */
    variableTotalCents: integer('variable_total_cents').notNull().default(0),
    /** Nachbelastungen (Schaden, Fehlteil, Verspätung, manuell), Cent. Brutto = fix + variabel + Nachbelastungen. */
    chargesTotalCents: integer('charges_total_cents').notNull().default(0),
    /** Summe der Credits (Anzahlungen aktiv + angewendete Kaution), Cent. */
    creditsTotalCents: integer('credits_total_cents').notNull().default(0),
    /** Final übertragbarer Betrag = max(0, charges − credits). */
    amountDueCents: integer('amount_due_cents').notNull().default(0),
    /** Überzahlung = max(0, credits − charges) – nur Hinweis, nie negative Rechnung (Order §20). */
    overpaymentCents: integer('overpayment_cents').notNull().default(0),
    /** Positive Schaden-/Fehlteilbelastung ⇒ Kundeninformation vor Transfer (Order §24). */
    noticeRequired: boolean('notice_required').notNull().default(false),
    noticeSentAt: timestamp('notice_sent_at', { withTimezone: true }),
    /** = notice_sent_at + 24 h; beginnt nur einmal je Abrechnung (Order §28). */
    waitUntil: timestamp('wait_until', { withTimezone: true }),
    customerResponseReceivedAt: timestamp('customer_response_received_at', { withTimezone: true }),
    /** Schaden-/Fehlteilbetrag nach Versand der Kundeninformation geändert (Order §29/§32). */
    amountsChangedAfterNoticeAt: timestamp('amounts_changed_after_notice_at', {
      withTimezone: true,
    }),
    /** Nach Kundenrückmeldung/Änderung/vorzeitiger Freigabe: nur noch manuelle Übertragung (Order §§31, 32, 35). */
    manualTransferRequired: boolean('manual_transfer_required').notNull().default(false),
    /** Bewusste Freigabe „wie berechnet“ bzw. „Jetzt freigeben“ (Order §§31, 35). */
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedBy: uuid('released_by').references(() => staffUsers.id),
    earlyReleasedAt: timestamp('early_released_at', { withTimezone: true }),
    /** Erfolgreicher Transfer ⇒ gesperrt (Order §41); keine Änderung mehr möglich. */
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    transferredAt: timestamp('transferred_at', { withTimezone: true }),
    accountingTransferId: uuid('accounting_transfer_id'),
    accountingProvider: accountingProvider('accounting_provider'),
    /** Externe Buchhaltungsreferenz (Mock: klar als MOCK gekennzeichnet) – nur mit accounting.view_reference sichtbar. */
    accountingReference: text('accounting_reference'),
    paymentStatus: accountingPaymentStatus('payment_status'),
    /** Letzter Transferfehler (nur neutraler Code, kein Stacktrace). */
    lastTransferErrorCode: text('last_transfer_error_code'),
    /** Phase 10: Rechnungsversand (Lexware mailt nicht per API) – 'pending' bis Phase 12 versendet; nie automatisch 'sent'. */
    invoiceDeliveryStatus: text('invoice_delivery_status'),
    /** Optimistische Sperre gegen Lost Updates (Order §82). */
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('settlements_status_idx').on(table.status, table.waitUntil),
    check('settlements_amount_due_check', sql`"amount_due_cents" >= 0`),
    check('settlements_overpayment_check', sql`"overpayment_cents" >= 0`),
  ],
);

/**
 * Typisierte Abrechnungspositionen (Order §5). `amount_cents` ist stets ≥ 0;
 * ob die Position belastet oder gutschreibt, bestimmt der Typ
 * (advance_payment_credit, deposit_applied_credit und discount = Gutschrift).
 */
export const settlementLines = pgTable(
  'settlement_lines',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    settlementId: uuid('settlement_id')
      .notNull()
      .references(() => settlements.id, { onDelete: 'cascade' }),
    type: settlementLineType('type').notNull(),
    /** Kundenbeschreibung (erscheint im Accounting-Payload). */
    description: text('description').notNull(),
    quantity: integer('quantity').notNull().default(1),
    unit: text('unit').notNull().default('Stück'),
    unitPriceCents: integer('unit_price_cents').notNull(),
    amountCents: integer('amount_cents').notNull(),
    sourceType: settlementLineSourceType('source_type').notNull(),
    /** Stabile Quellreferenz (UUID oder Positionsschlüssel) – eindeutig je Settlement. */
    sourceKey: text('source_key').notNull(),
    sourceId: uuid('source_id'),
    /** Eingefrorene relevante Quelldaten (immutable). */
    sourceSnapshot: jsonb('source_snapshot'),
    internalNote: text('internal_note'),
    createdBy: uuid('created_by').references(() => staffUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').references(() => staffUsers.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('settlement_lines_source_unique').on(
      table.settlementId,
      table.sourceType,
      table.sourceKey,
    ),
    index('settlement_lines_settlement_idx').on(table.settlementId),
    check('settlement_lines_amount_check', sql`"amount_cents" >= 0`),
    check('settlement_lines_quantity_check', sql`"quantity" >= 0`),
  ],
);

/** Offene/erledigte finanzielle Klärungspunkte (Order §§10, 13, 22, 27, 30). */
export const settlementClarifications = pgTable(
  'settlement_clarifications',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    settlementId: uuid('settlement_id')
      .notNull()
      .references(() => settlements.id, { onDelete: 'cascade' }),
    type: settlementClarificationType('type').notNull(),
    /** Bezug: Schaden-ID, Fehlteil-ID oder Settlement-ID (für notice/response). */
    sourceId: uuid('source_id').notNull(),
    status: settlementClarificationStatus('status').notNull().default('open'),
    /** charged | not_charged | sent | released_as_charged | amount_changed | position_removed | already_resolved */
    resolution: text('resolution'),
    resolvedBy: uuid('resolved_by').references(() => staffUsers.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('settlement_clarifications_unique').on(
      table.settlementId,
      table.type,
      table.sourceId,
    ),
  ],
);

/**
 * Genau EINE kombinierte Schaden-/Fehlteil-Kundeninformation je Settlement
 * (Order §§25–28). Dev/Test/Demo: Outbox (nichts verlässt das System);
 * Production ohne Kommunikationsadapter: blocked, nie „gesendet“.
 */
export const settlementCustomerNotices = pgTable('settlement_customer_notices', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  settlementId: uuid('settlement_id')
    .notNull()
    .unique()
    .references(() => settlements.id, { onDelete: 'cascade' }),
  status: customerNoticeStatus('status').notNull().default('prepared'),
  recipientEmail: text('recipient_email'),
  subject: text('subject').notNull(),
  bodyText: text('body_text').notNull(),
  /** Positionen zum Versandzeitpunkt: [{ lineId, type, description, amountCents }] + Gesamtsumme. */
  positionsSnapshot: jsonb('positions_snapshot').notNull(),
  totalCents: integer('total_cents').notNull(),
  approvedBy: uuid('approved_by').references(() => staffUsers.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  gateway: text('gateway'),
  gatewayReference: text('gateway_reference'),
  blockedReason: text('blocked_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Buchhaltungstransfer ──────────────────────────────────────────────────

/**
 * Ein Transfer je Settlement bzw. Storno, idempotent über
 * `idempotency_key` (Order §39). Der `snapshot` wird VOR dem erfolgreichen
 * Transfer festgeschrieben und danach nie aus aktuellen Tabellen
 * rekonstruiert (Order §81).
 */
export const accountingTransfers = pgTable(
  'accounting_transfers',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    kind: accountingTransferKind('kind').notNull(),
    settlementId: uuid('settlement_id').references(() => settlements.id),
    cancellationId: uuid('cancellation_id'),
    processId: uuid('process_id')
      .notNull()
      .references(() => processes.id),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    status: accountingTransferStatus('status').notNull().default('pending'),
    provider: accountingProvider('provider').notNull(),
    /** Stabiler Accounting-Snapshot (Lines, Totals, Customer-/Rechnungsadress-Snapshot, Event, Hash). */
    snapshot: jsonb('snapshot').notNull(),
    snapshotHash: text('snapshot_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastErrorCode: text('last_error_code'),
    externalReference: text('external_reference'),
    paymentStatus: accountingPaymentStatus('payment_status'),
    transferredAt: timestamp('transferred_at', { withTimezone: true }),
    // ── Phase 10: zweiphasiger externer Transfer (Order §§32/60) ──
    /** Beanspruchung (claim) ohne gehaltene DB-Sperre während des HTTP-Aufrufs. */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimedBy: text('claimed_by'),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    /** Versionierter Provider-Snapshot (schemaVersion 2: Steuer, Adresse, Line-Mapping) – Phase-9-Snapshot bleibt unverändert. */
    providerSnapshot: jsonb('provider_snapshot'),
    providerSnapshotHash: text('provider_snapshot_hash'),
    /** Neutraler Code, warum eine manuelle Prüfung nötig ist (z. B. TOTAL_MISMATCH, RECOVERY_AMBIGUOUS). */
    attentionCode: text('attention_code'),
    attentionAt: timestamp('attention_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('accounting_transfers_settlement_unique')
      .on(table.settlementId)
      .where(sql`"settlement_id" IS NOT NULL`),
    uniqueIndex('accounting_transfers_cancellation_unique')
      .on(table.cancellationId)
      .where(sql`"cancellation_id" IS NOT NULL`),
    check(
      'accounting_transfers_target_check',
      sql`("kind" = 'settlement' AND "settlement_id" IS NOT NULL AND "cancellation_id" IS NULL) OR ("kind" = 'cancellation' AND "cancellation_id" IS NOT NULL AND "settlement_id" IS NULL)`,
    ),
  ],
);

// ── Anzahlung / Kaution ───────────────────────────────────────────────────

/** Manuell erfasste Anzahlung (Order §17) – kein Zahlungsanbieter, keine Banktransaktion. */
export const bookingAdvancePayments = pgTable(
  'booking_advance_payments',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    processId: uuid('process_id')
      .notNull()
      .references(() => processes.id),
    amountCents: integer('amount_cents').notNull(),
    receivedAt: date('received_at').notNull(),
    externalReference: text('external_reference'),
    status: advancePaymentStatus('status').notNull().default('active'),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => staffUsers.id),
    cancelledBy: uuid('cancelled_by').references(() => staffUsers.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('booking_advance_payments_booking_idx').on(table.bookingId),
    check('booking_advance_payments_amount_check', sql`"amount_cents" > 0`),
  ],
);

/**
 * Manuell erfasste Kaution (Order §§18–19): kein Umsatz, reduziert die
 * Rechnung NIE automatisch. `applied_cents` = bereits bewusst auf die
 * Abrechnung angewendeter Teil; Rest bleibt `held`, bis freigegeben.
 */
export const bookingSecurityDeposits = pgTable(
  'booking_security_deposits',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    processId: uuid('process_id')
      .notNull()
      .references(() => processes.id),
    amountCents: integer('amount_cents').notNull(),
    appliedCents: integer('applied_cents').notNull().default(0),
    receivedAt: date('received_at').notNull(),
    externalReference: text('external_reference'),
    status: securityDepositStatus('status').notNull().default('held'),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => staffUsers.id),
    releasedBy: uuid('released_by').references(() => staffUsers.id),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('booking_security_deposits_booking_idx').on(table.bookingId),
    check('booking_security_deposits_amount_check', sql`"amount_cents" > 0`),
    check(
      'booking_security_deposits_applied_check',
      sql`"applied_cents" >= 0 AND "applied_cents" <= "amount_cents"`,
    ),
  ],
);

// ── Storno ────────────────────────────────────────────────────────────────

/**
 * Storno einer bestätigten, noch nicht ausgegebenen Buchung (Order §§49–63).
 * Alle Berechnungsgrundlagen sind eingefroren: Eventdatum, verbleibende
 * Berliner Kalendertage, Stornosatz, Basis (Summe der regulären
 * Maschinen-Listenpreise aus dem Booking-Snapshot) und Gebühr.
 */
export const cancellations = pgTable(
  'cancellations',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    processId: uuid('process_id')
      .notNull()
      .unique()
      .references(() => processes.id),
    bookingId: uuid('booking_id')
      .notNull()
      .unique()
      .references(() => bookings.id),
    cancelerType: cancelerType('canceler_type').notNull(),
    cancelerStaffId: uuid('canceler_staff_id').references(() => staffUsers.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }).notNull(),
    /** Ursprüngliches Eventdatum (Berliner Kalendertag) laut Booking-Snapshot. */
    eventDate: date('event_date').notNull(),
    remainingDays: integer('remaining_days').notNull(),
    /** 0 | 50 | 100 */
    feePercent: integer('fee_percent').notNull(),
    /** Summe der eingefrorenen regulären Maschinen-Listenpreise (Cent). */
    baseCents: integer('base_cents').notNull(),
    feeCents: integer('fee_cents').notNull(),
    /** Rundungsmethode der Gebühr (dokumentiert): half_up auf volle Cent. */
    roundingMethod: text('rounding_method').notNull().default('half_up'),
    financeStatus: cancellationFinanceStatus('finance_status').notNull().default('no_invoice'),
    accountingTransferId: uuid('accounting_transfer_id'),
    accountingProvider: accountingProvider('accounting_provider'),
    accountingReference: text('accounting_reference'),
    paymentStatus: accountingPaymentStatus('payment_status'),
    transferredAt: timestamp('transferred_at', { withTimezone: true }),
    lastTransferErrorCode: text('last_transfer_error_code'),
    /** Phase 10: Rechnungsversand der Stornokostenrechnung ('pending'; nie automatisch 'sent'). */
    invoiceDeliveryStatus: text('invoice_delivery_status'),
    /** Freigegebene Ressourcen (Zähler) – nur Nachvollziehbarkeit. */
    releasedResources: jsonb('released_resources'),
    /** Kundenbestätigung: prepared | sent | blocked (Order §61). */
    confirmationStatus: text('confirmation_status').notNull().default('prepared'),
    confirmationSentAt: timestamp('confirmation_sent_at', { withTimezone: true }),
    confirmationGatewayReference: text('confirmation_gateway_reference'),
    /** Hinweis bei bestehendem externem Geldfluss (Anzahlung/Kaution): „Externe Rückzahlung/Verrechnung prüfen“. */
    externalRefundReviewRequired: boolean('external_refund_review_required')
      .notNull()
      .default(false),
    reopenedAt: timestamp('reopened_at', { withTimezone: true }),
    reopenedBy: uuid('reopened_by').references(() => staffUsers.id),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check('cancellations_fee_percent_check', sql`"fee_percent" IN (0, 50, 100)`),
    check('cancellations_fee_check', sql`"fee_cents" >= 0 AND "base_cents" >= 0`),
  ],
);

/** Bidirektionale Verknüpfung Storno → Folgevorgang (Order §64), normalisiert als eine Zeile. */
export const processRelations = pgTable(
  'process_relations',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    previousProcessId: uuid('previous_process_id')
      .notNull()
      .references(() => processes.id),
    followUpProcessId: uuid('follow_up_process_id')
      .notNull()
      .unique()
      .references(() => processes.id),
    kind: processRelationKind('kind').notNull(),
    createdBy: uuid('created_by').references(() => staffUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('process_relations_previous_idx').on(table.previousProcessId),
    check('process_relations_distinct_check', sql`"previous_process_id" <> "follow_up_process_id"`),
  ],
);

// Typ-Referenzen, damit Fremdtabellen im Modul „benutzt“ sind (Drizzle-Relationen folgen über Services).
export type SettlementDamageRef = typeof machineDamages.$inferSelect;
export type SettlementMissingCaseRef = typeof missingAccessoryCases.$inferSelect;
