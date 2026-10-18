import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@mietroyal/config';
import {
  accountingTransfers,
  bookings,
  cancellations,
  customers,
  machineAssignments,
  machineDamages,
  machines,
  offerVersions,
  offers,
  processes,
  rentalReturns,
  returnMachines,
  settlements,
  voucherRedemptions,
  vouchers,
  type Database,
  type DatabaseExecutor,
  type DatabaseTransaction,
  type VoucherRow,
} from '@mietroyal/database';
import {
  isVoucherExpired,
  maskVoucherCode,
  normalizeVoucherCode,
  reactivatedExpiresAt,
  remainingValiditySeconds,
  VOUCHER_DELIVERY_LABELS,
  VOUCHER_INVALID_MESSAGE,
  VOUCHER_STATUS_LABELS,
  VOUCHER_TYPE_RETURNING_CUSTOMER,
  voucherDiscountCents,
  voucherEffectiveStatus,
  voucherExpiresAt,
  type VoucherDeliveryStatus,
  type VoucherEffectiveStatus,
} from '@mietroyal/domain';
import { and, asc, desc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { codeSuffix, generateVoucherCode, hashVoucherCode } from './voucher-codes.ts';
import { encryptDeliveryCode } from './voucher-crypto.ts';

/**
 * Zentraler Gutschein-Service (Phase 11, Order §§3–7, 10, 16–19, 28–45).
 *
 * - Entstehung: `ensureVoucherForSettlement` ist idempotent (Advisory-Lock je
 *   Settlement + UNIQUE origin_settlement_id); Eligibility wird unter der
 *   Sperre geprüft. Trigger (Zahlung → paid, Reinigungsende) laufen über
 *   Jobs (`voucher-jobs.ts`); mehrfaches Feuern erzeugt genau einen Gutschein.
 * - Der Klartextcode existiert nur im Moment der Erzeugung; persistiert
 *   werden SHA-256-Hash, Suffix und eine verschlüsselte Versandkopie
 *   (`voucher-crypto.ts`). Keine Methode dieser Klasse gibt den Klartext
 *   zurück oder loggt ihn.
 * - Validierung nach außen immer neutral (`VOUCHER_INVALID_MESSAGE`); Gründe
 *   bleiben intern.
 * - Reservierung (Senden), Einlösung (Annahme) und Reaktivierung (0-%-Storno)
 *   laufen in der Transaktion des Aufrufers mit `FOR UPDATE` auf der
 *   Gutscheinzeile; `version` zählt jede Statusänderung.
 *
 * Importregel: dieses Modul importiert nichts aus lexware/, handover/ oder
 * commerce/ – die Trigger werden in app.ts/worker injiziert.
 */

export type VoucherIneligibilityReason =
  | 'NO_BOOKING'
  | 'PROCESS_CANCELLED'
  | 'RETURN_NOT_FINALIZED'
  | 'SETTLEMENT_NOT_TRANSFERRED'
  | 'TRANSFER_NOT_SUCCEEDED'
  | 'PAYMENT_NOT_PAID'
  | 'CANCELLATION_EXISTS'
  | 'DAMAGE_DOCUMENTED'
  | 'POST_RETURN_WINDOW_OPEN'
  | 'ALREADY_ISSUED';

export type VoucherErrorCode = 'VOUCHER_UNAVAILABLE';

export class VoucherError extends Error {
  constructor(
    readonly code: VoucherErrorCode,
    message: string = VOUCHER_INVALID_MESSAGE,
  ) {
    super(message);
    this.name = 'VoucherError';
  }
}

export interface VoucherEligibilityContext {
  settlementId: string;
  processId: string;
  bookingId: string;
  returnId: string;
  customerId: string;
}

export interface VoucherEligibilityResult {
  eligible: boolean;
  reasons: VoucherIneligibilityReason[];
  context?: VoucherEligibilityContext;
}

export interface EnsureVoucherResult {
  outcome: 'created' | 'exists' | 'ineligible';
  voucherId?: string | undefined;
  reasons?: VoucherIneligibilityReason[] | undefined;
}

export interface EnsureAllResult {
  scanned: number;
  created: number;
  exists: number;
  ineligible: number;
}

export type ValidateForOfferResult = { ok: true; voucher: VoucherRow } | { ok: false };

/** Für Kundenprofil/Vorgang: nie codeHash/ciphertext/Klartext (Vertrag §6). */
export interface VoucherSummary {
  id: string;
  status: VoucherEffectiveStatus;
  statusLabel: string;
  expiresAt: string;
  maskedReference: string;
  deliveryStatus: VoucherDeliveryStatus;
  deliveryLabel: string;
  reservedOfferId: string | null;
  originProcessId: string;
  originProcessNumber: string | null;
}

export interface VoucherLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export type ReactivationOutcome =
  'reactivated' | 'already_processed' | 'superseded' | 'no_redemption';

type SettlementRow = typeof settlements.$inferSelect;

export class VoucherService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly logger?: VoucherLogger,
  ) {}

  // ── Eligibility (Order §§3–5, 47) ──────────────────────────────────────

  async assessEligibility(
    settlementId: string,
    now: Date = new Date(),
    executor: DatabaseExecutor = this.db,
  ): Promise<VoucherEligibilityResult> {
    const settlementRows = await executor
      .select()
      .from(settlements)
      .where(eq(settlements.id, settlementId));
    const settlement = settlementRows[0];
    if (settlement === undefined) return { eligible: false, reasons: ['NO_BOOKING'] };
    return this.assessSettlement(executor, settlement, now);
  }

  private async assessSettlement(
    executor: DatabaseExecutor,
    settlement: SettlementRow,
    _now: Date,
  ): Promise<VoucherEligibilityResult> {
    const reasons: VoucherIneligibilityReason[] = [];

    const bookingRows = await executor
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.id, settlement.bookingId));
    if (bookingRows.length === 0) reasons.push('NO_BOOKING');

    const processRows = await executor
      .select({ mainStatus: processes.mainStatus, customerId: processes.customerId })
      .from(processes)
      .where(eq(processes.id, settlement.processId));
    const process = processRows[0];
    if (process === undefined || process.mainStatus === 'cancelled') {
      reasons.push('PROCESS_CANCELLED');
    }

    // Stornovorgang (Order §§3/5): Stornorechnungen haben kein Settlement –
    // ein Storno zu dieser Buchung schließt den Gutschein trotzdem aus.
    const cancellationRows = await executor
      .select({ id: cancellations.id })
      .from(cancellations)
      .where(
        or(
          eq(cancellations.processId, settlement.processId),
          eq(cancellations.bookingId, settlement.bookingId),
        ),
      )
      .limit(1);
    if (cancellationRows.length > 0) reasons.push('CANCELLATION_EXISTS');

    const returnRows = await executor
      .select({ status: rentalReturns.status })
      .from(rentalReturns)
      .where(eq(rentalReturns.id, settlement.returnId));
    if (returnRows[0]?.status !== 'finalized') reasons.push('RETURN_NOT_FINALIZED');

    if (settlement.status !== 'transferred') reasons.push('SETTLEMENT_NOT_TRANSFERRED');

    const transferRows = await executor
      .select({ status: accountingTransfers.status })
      .from(accountingTransfers)
      .where(eq(accountingTransfers.settlementId, settlement.id));
    if (transferRows[0]?.status !== 'succeeded') reasons.push('TRANSFER_NOT_SUCCEEDED');

    // open/overdue/null ⇒ kein Gutschein (Order §47); „abgeschlossen“ allein reicht nicht.
    if (settlement.paymentStatus !== 'paid') reasons.push('PAYMENT_NOT_PAID');

    // Schadenfrei (Order §4): irgendein kundenbezogener Schaden zu diesem Return –
    // Rückgabe ODER Nachtrag, unabhängig von Berechnung/Auflösung/„nicht mehr aktuell“.
    // Technische Defekte, Reinigungsgebühr, Fehlteile, Verspätung, manuelle
    // Nachbelastungen sind KEIN Ausschlussgrund.
    const damageRows = await executor
      .select({ id: machineDamages.id })
      .from(machineDamages)
      .where(eq(machineDamages.returnId, settlement.returnId))
      .limit(1);
    if (damageRows.length > 0) reasons.push('DAMAGE_DOCUMENTED');

    if (await this.postReturnWindowOpenForReturn(executor, settlement.returnId)) {
      reasons.push('POST_RETURN_WINDOW_OPEN');
    }

    const existing = await executor
      .select({ id: vouchers.id })
      .from(vouchers)
      .where(eq(vouchers.originSettlementId, settlement.id));
    if (existing.length > 0) reasons.push('ALREADY_ISSUED');

    const context: VoucherEligibilityContext | undefined =
      process === undefined
        ? undefined
        : {
            settlementId: settlement.id,
            processId: settlement.processId,
            bookingId: settlement.bookingId,
            returnId: settlement.returnId,
            customerId: process.customerId,
          };
    return {
      eligible: reasons.length === 0,
      reasons,
      ...(context === undefined ? {} : { context }),
    };
  }

  /**
   * Phase-7-Nachtragsfenster (Order §3): eine Maschine des Returns ist noch
   * in der Reinigungsphase NACH DIESER Rückgabe – Logik wie
   * `damage-service.ts` (`postReturnWindowOpen` + letzter finalisierter
   * Return der Maschine + `notReissuedSince`).
   */
  private async postReturnWindowOpenForReturn(
    executor: DatabaseExecutor,
    returnId: string,
  ): Promise<boolean> {
    const machineRows = await executor
      .select({
        machineId: returnMachines.machineId,
        status: machines.status,
        cleaningSince: machines.cleaningSince,
      })
      .from(returnMachines)
      .innerJoin(machines, eq(machines.id, returnMachines.machineId))
      .where(eq(returnMachines.returnId, returnId));
    for (const row of machineRows) {
      if (!(row.status === 'cleaning' && row.cleaningSince !== null)) continue;
      const lastRows = await executor
        .select({ returnId: returnMachines.returnId, finalizedAt: rentalReturns.finalizedAt })
        .from(returnMachines)
        .innerJoin(rentalReturns, eq(rentalReturns.id, returnMachines.returnId))
        .where(
          and(eq(returnMachines.machineId, row.machineId), eq(rentalReturns.status, 'finalized')),
        )
        .orderBy(desc(rentalReturns.finalizedAt))
        .limit(1);
      const last = lastRows[0];
      if (last === undefined || last.finalizedAt === null || last.returnId !== returnId) continue;
      const reissued = await executor
        .select({ id: machineAssignments.id })
        .from(machineAssignments)
        .where(
          and(
            eq(machineAssignments.machineId, row.machineId),
            or(
              eq(machineAssignments.status, 'issued'),
              and(
                isNotNull(machineAssignments.issuedAt),
                gt(machineAssignments.issuedAt, last.finalizedAt),
              ),
            ),
          ),
        )
        .limit(1);
      if (reissued.length === 0) return true;
    }
    return false;
  }

  // ── Entstehung (Order §§6–10, 48, 51) ──────────────────────────────────

  /**
   * Genau ein Gutschein je berechtigtem Settlement. Advisory-Lock serialisiert
   * parallele Trigger (Webhook, Reconcile, Reinigungsende, Backfill); der
   * UNIQUE-Index ist der DB-Backstop. Ergebnis und Logs enthalten nur IDs.
   */
  async ensureVoucherForSettlement(
    settlementId: string,
    now: Date = new Date(),
  ): Promise<EnsureVoucherResult> {
    const result = await this.db.transaction(async (tx): Promise<EnsureVoucherResult> => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${'voucher-ensure:' + settlementId}))`,
      );
      const settlementRows = await tx
        .select()
        .from(settlements)
        .where(eq(settlements.id, settlementId))
        .for('share');
      const settlement = settlementRows[0];
      if (settlement === undefined) return { outcome: 'ineligible', reasons: ['NO_BOOKING'] };
      // Maschinen des Returns FOR SHARE sperren: serialisiert gegen Nachtrags-
      // Schaden und Reinigungsabschluss (beide sperren die Maschine exklusiv),
      // damit „Schaden vor Reinigungsende“ nie zwischen den Prüfungen landet.
      if (settlement.returnId !== null) {
        await tx.execute(sql`
          SELECT m.id FROM machines m
          INNER JOIN return_machines rm ON rm.machine_id = m.id
          WHERE rm.return_id = ${settlement.returnId}
          ORDER BY m.id
          FOR SHARE OF m
        `);
      }
      const eligibility = await this.assessSettlement(tx, settlement, now);
      if (!eligibility.eligible || eligibility.context === undefined) {
        if (eligibility.reasons.includes('ALREADY_ISSUED')) {
          return { outcome: 'exists', voucherId: await this.existingId(tx, settlementId) };
        }
        return { outcome: 'ineligible', reasons: eligibility.reasons };
      }
      const context = eligibility.context;
      const customerRows = await tx
        .select({ email: customers.email })
        .from(customers)
        .where(eq(customers.id, context.customerId));
      const email = customerRows[0]?.email ?? null;
      const voucherId = randomUUID();
      // Klartext nur hier – weder zurückgegeben noch geloggt.
      const code = generateVoucherCode();
      const inserted = await tx
        .insert(vouchers)
        .values({
          id: voucherId,
          voucherType: VOUCHER_TYPE_RETURNING_CUSTOMER,
          customerId: context.customerId,
          originProcessId: context.processId,
          originBookingId: context.bookingId,
          originReturnId: context.returnId,
          originSettlementId: context.settlementId,
          discountPercent: 20,
          codeHash: hashVoucherCode(code),
          codeSuffix: codeSuffix(code),
          status: 'active',
          activatedAt: now,
          expiresAt: voucherExpiresAt(now),
          deliveryStatus: 'pending',
          // Kunde ohne E-Mail (Order §51): Gutschein entsteht trotzdem, Phase 12 sieht das Problem.
          deliveryProblemCode: email === null || email.trim() === '' ? 'NO_EMAIL' : null,
          deliveryCodeCiphertext: encryptDeliveryCode(code, voucherId, this.config.auth.secretKey),
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: vouchers.originSettlementId })
        .returning({ id: vouchers.id });
      if (inserted.length === 0) {
        return { outcome: 'exists', voucherId: await this.existingId(tx, settlementId) };
      }
      return { outcome: 'created', voucherId };
    });
    this.logger?.info(
      {
        voucher: {
          action: 'ensure',
          settlementId,
          outcome: result.outcome,
          voucherId: result.voucherId ?? null,
          reasons: result.reasons ?? null,
        },
      },
      'Wiedermieter-Gutschein geprüft',
    );
    return result;
  }

  private async existingId(
    executor: DatabaseExecutor,
    settlementId: string,
  ): Promise<string | undefined> {
    const rows = await executor
      .select({ id: vouchers.id })
      .from(vouchers)
      .where(eq(vouchers.originSettlementId, settlementId));
    return rows[0]?.id;
  }

  /** Backfill (CLI `pnpm voucher:ensure`): bezahlte, übertragene Settlements ohne Gutschein. */
  async ensureForAllEligible(limit?: number, now: Date = new Date()): Promise<EnsureAllResult> {
    const query = this.db
      .select({ id: settlements.id })
      .from(settlements)
      .leftJoin(vouchers, eq(vouchers.originSettlementId, settlements.id))
      .where(
        and(
          eq(settlements.status, 'transferred'),
          eq(settlements.paymentStatus, 'paid'),
          isNull(vouchers.id),
        ),
      )
      .orderBy(asc(settlements.transferredAt));
    const rows = limit === undefined ? await query : await query.limit(limit);
    const counters: EnsureAllResult = {
      scanned: rows.length,
      created: 0,
      exists: 0,
      ineligible: 0,
    };
    for (const row of rows) {
      const result = await this.ensureVoucherForSettlement(row.id, now);
      counters[result.outcome] += 1;
    }
    return counters;
  }

  // ── Validierung für Angebote (Order §§18–19, 55) ───────────────────────

  /**
   * Neutral nach außen: jeder Fehlgrund (unbekannt, fremder Kunde, abgelaufen,
   * eingelöst, für anderes Angebot reserviert, ungültige Form) ergibt
   * `{ ok: false }`. Eine Reservierung durch ein nicht mehr aktuelles Angebot
   * wird lazy freigegeben (§32).
   */
  async validateForOffer(input: {
    code: string;
    customerId: string;
    offerId: string;
    now?: Date;
  }): Promise<ValidateForOfferResult> {
    const now = input.now ?? new Date();
    const compact = normalizeVoucherCode(input.code);
    if (compact === null) return { ok: false };
    const codeHash = hashVoucherCode(compact);
    return this.db.transaction(async (tx): Promise<ValidateForOfferResult> => {
      const rows = await tx.select().from(vouchers).where(eq(vouchers.codeHash, codeHash));
      let voucher = rows[0];
      if (voucher === undefined) return { ok: false };
      if (voucher.customerId !== input.customerId) return { ok: false };
      if (voucher.status === 'redeemed') return { ok: false };
      if (isVoucherExpired(voucher.expiresAt, now)) return { ok: false };
      if (voucher.status === 'reserved' && voucher.reservedOfferId !== input.offerId) {
        const locked = await tx
          .select()
          .from(vouchers)
          .where(eq(vouchers.id, voucher.id))
          .for('update');
        voucher = await this.releaseStaleReservation(tx, locked[0] ?? voucher, now);
        if (voucher.status !== 'active') return { ok: false };
      }
      return { ok: true, voucher };
    });
  }

  /**
   * Reservierung lazy freigeben (Order §§30–32): bleibt bestehen, solange das
   * reservierende Angebot eine aktuelle gesendete, nicht abgelaufene Version
   * mit diesem Gutschein hat – oder ein Entwurf derselben Angebotsreihe den
   * Gutschein trägt (Versionierung). Accepted ⇒ nie freigeben.
   */
  async releaseStaleReservation(
    tx: DatabaseTransaction,
    voucher: VoucherRow,
    now: Date,
  ): Promise<VoucherRow> {
    if (voucher.status !== 'reserved' || voucher.reservedOfferId === null) return voucher;
    if (await this.reservationStillHeld(tx, voucher, now)) return voucher;
    const updated = await tx
      .update(vouchers)
      .set({
        status: 'active',
        reservedOfferId: null,
        reservedAt: null,
        version: voucher.version + 1,
        updatedAt: now,
      })
      .where(and(eq(vouchers.id, voucher.id), eq(vouchers.version, voucher.version)))
      .returning();
    return updated[0] ?? voucher;
  }

  /**
   * Hält das reservierende Angebot die Reservierung noch? Ja, wenn seine
   * aktuelle Version den Gutschein trägt und entweder ein Entwurf ist
   * (Versionierung, §30) oder versendet, nicht superseded und nicht abgelaufen
   * (§32). Eine angenommene Version hält immer (dann ist der Gutschein eingelöst).
   * Reine Leseprüfung – wird von der Freigabe und von den Statusansichten genutzt.
   */
  private async reservationStillHeld(
    executor: DatabaseExecutor,
    voucher: VoucherRow,
    now: Date,
  ): Promise<boolean> {
    if (voucher.reservedOfferId === null) return false;
    const offerRows = await executor
      .select({ currentVersionId: offers.currentVersionId })
      .from(offers)
      .where(eq(offers.id, voucher.reservedOfferId));
    const currentVersionId = offerRows[0]?.currentVersionId ?? null;
    if (currentVersionId === null) return false;
    const versionRows = await executor
      .select({
        status: offerVersions.status,
        supersededAt: offerVersions.supersededAt,
        expiresAt: offerVersions.expiresAt,
        voucherId: offerVersions.voucherId,
      })
      .from(offerVersions)
      .where(eq(offerVersions.id, currentVersionId));
    const version = versionRows[0];
    if (version === undefined) return false;
    if (version.status === 'accepted') return true;
    const carries = version.voucherId === voucher.id;
    const sentAndValid =
      version.status === 'sent' &&
      version.supersededAt === null &&
      version.expiresAt !== null &&
      version.expiresAt.getTime() > now.getTime();
    return carries && (sentAndValid || version.status === 'draft');
  }

  // ── Reservierung / Freigabe (Order §§28–33) ────────────────────────────

  private async lockVoucher(tx: DatabaseTransaction, voucherId: string): Promise<VoucherRow> {
    const rows = await tx.select().from(vouchers).where(eq(vouchers.id, voucherId)).for('update');
    const row = rows[0];
    if (row === undefined) throw new VoucherError('VOUCHER_UNAVAILABLE');
    return row;
  }

  /** Beim SENDEN (atomar in der Angebots-Transaktion): erster Send gewinnt. */
  async reserveForOffer(
    tx: DatabaseTransaction,
    input: { voucherId: string; offerId: string; customerId: string; now: Date },
  ): Promise<VoucherRow> {
    const locked = await this.lockVoucher(tx, input.voucherId);
    const voucher = await this.releaseStaleReservation(tx, locked, input.now);
    if (voucher.customerId !== input.customerId) throw new VoucherError('VOUCHER_UNAVAILABLE');
    if (isVoucherExpired(voucher.expiresAt, input.now)) {
      throw new VoucherError('VOUCHER_UNAVAILABLE');
    }
    const allowed =
      voucher.status === 'active' ||
      (voucher.status === 'reserved' && voucher.reservedOfferId === input.offerId);
    if (!allowed) throw new VoucherError('VOUCHER_UNAVAILABLE');
    const updated = await tx
      .update(vouchers)
      .set({
        status: 'reserved',
        reservedOfferId: input.offerId,
        reservedAt: voucher.reservedOfferId === input.offerId ? voucher.reservedAt : input.now,
        version: voucher.version + 1,
        updatedAt: input.now,
      })
      .where(and(eq(vouchers.id, voucher.id), eq(vouchers.version, voucher.version)))
      .returning();
    const row = updated[0];
    if (row === undefined) throw new VoucherError('VOUCHER_UNAVAILABLE');
    return row;
  }

  /** Nur die eigene Reservierung freigeben (Entfernen im Entwurf, Ablehnung). */
  async releaseReservation(
    tx: DatabaseTransaction,
    input: { voucherId: string; offerId: string; now?: Date },
  ): Promise<void> {
    const now = input.now ?? new Date();
    await tx
      .update(vouchers)
      .set({
        status: 'active',
        reservedOfferId: null,
        reservedAt: null,
        version: sql`${vouchers.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(vouchers.id, input.voucherId),
          eq(vouchers.status, 'reserved'),
          eq(vouchers.reservedOfferId, input.offerId),
        ),
      );
  }

  // ── Einlösung (Order §§34–37) ──────────────────────────────────────────

  /**
   * In der Annahme-Transaktion: Gutschein gesperrt, Kunde/Ablauf/Betrag
   * geprüft, Redemption angelegt, Status redeemed. Jeder Fehler wirft
   * `VoucherError` – der Aufrufer rollt zurück, der Gutschein bleibt
   * reserviert/aktiv.
   */
  async redeem(
    tx: DatabaseTransaction,
    input: {
      voucherId: string;
      offerId: string;
      bookingId: string;
      processId: string;
      customerId: string;
      expectedDiscountCents: number;
      machineSubtotalCents: number;
      now: Date;
    },
  ): Promise<{ redemptionId: string; voucher: VoucherRow }> {
    const voucher = await this.lockVoucher(tx, input.voucherId);
    if (voucher.customerId !== input.customerId) throw new VoucherError('VOUCHER_UNAVAILABLE');
    if (voucher.status === 'redeemed') throw new VoucherError('VOUCHER_UNAVAILABLE');
    if (voucher.status === 'reserved' && voucher.reservedOfferId !== input.offerId) {
      throw new VoucherError('VOUCHER_UNAVAILABLE');
    }
    if (isVoucherExpired(voucher.expiresAt, input.now)) {
      throw new VoucherError('VOUCHER_UNAVAILABLE');
    }
    if (
      !Number.isInteger(input.machineSubtotalCents) ||
      input.machineSubtotalCents <= 0 ||
      voucherDiscountCents(input.machineSubtotalCents) !== input.expectedDiscountCents
    ) {
      throw new VoucherError('VOUCHER_UNAVAILABLE');
    }
    if (Math.floor((voucher.expiresAt.getTime() - input.now.getTime()) / 1000) <= 0) {
      // Letzte Sekunde vor Ablauf: keine positive Restgültigkeit mehr ⇒ nicht einlösbar (409, kein 500).
      throw new VoucherError('VOUCHER_UNAVAILABLE');
    }
    const remaining = remainingValiditySeconds(voucher.expiresAt, input.now);
    const redemption = await tx
      .insert(voucherRedemptions)
      .values({
        voucherId: voucher.id,
        offerId: input.offerId,
        bookingId: input.bookingId,
        processId: input.processId,
        redeemedAt: input.now,
        expiresAtBeforeRedemption: voucher.expiresAt,
        remainingValiditySeconds: remaining,
        createdAt: input.now,
      })
      .returning({ id: voucherRedemptions.id });
    const updated = await tx
      .update(vouchers)
      .set({
        status: 'redeemed',
        reservedOfferId: null,
        reservedAt: null,
        version: voucher.version + 1,
        updatedAt: input.now,
      })
      .where(and(eq(vouchers.id, voucher.id), eq(vouchers.version, voucher.version)))
      .returning();
    const row = updated[0];
    const redemptionId = redemption[0]?.id;
    if (row === undefined || redemptionId === undefined) {
      throw new VoucherError('VOUCHER_UNAVAILABLE');
    }
    return { redemptionId, voucher: row };
  }

  // ── Storno (Order §§40–46) ─────────────────────────────────────────────

  /**
   * 0-%-Storno: DENSELBEN Gutschein reaktivieren, Restgültigkeit ab
   * Stornozeitpunkt wiederherstellen. Idempotent (Retry/Doppelstorno) und
   * replay-sicher (§45): eine neuere Einlösung wird nie überschrieben.
   */
  async reactivateForFreeCancellation(
    tx: DatabaseTransaction,
    input: { bookingId: string; cancellationId: string; cancelledAt: Date },
  ): Promise<{ outcome: ReactivationOutcome }> {
    const redemptionRows = await tx
      .select()
      .from(voucherRedemptions)
      .where(eq(voucherRedemptions.bookingId, input.bookingId))
      .for('update');
    const redemption = redemptionRows[0];
    if (redemption === undefined) return { outcome: 'no_redemption' };
    if (redemption.reactivatedAt !== null || redemption.finalConsumptionReason !== null) {
      return { outcome: 'already_processed' };
    }
    const voucher = await this.lockVoucher(tx, redemption.voucherId);
    const newerRows = await tx
      .select({ id: voucherRedemptions.id })
      .from(voucherRedemptions)
      .where(
        and(
          eq(voucherRedemptions.voucherId, voucher.id),
          gt(voucherRedemptions.redeemedAt, redemption.redeemedAt),
        ),
      )
      .limit(1);
    const superseded = voucher.status !== 'redeemed' || newerRows.length > 0;
    await tx
      .update(voucherRedemptions)
      .set({ reactivatedAt: input.cancelledAt, cancellationId: input.cancellationId })
      .where(eq(voucherRedemptions.id, redemption.id));
    if (superseded) return { outcome: 'superseded' };
    await tx
      .update(vouchers)
      .set({
        status: 'active',
        reservedOfferId: null,
        reservedAt: null,
        expiresAt: reactivatedExpiresAt(input.cancelledAt, redemption.remainingValiditySeconds),
        version: voucher.version + 1,
        updatedAt: input.cancelledAt,
      })
      .where(and(eq(vouchers.id, voucher.id), eq(vouchers.version, voucher.version)));
    return { outcome: 'reactivated' };
  }

  /** 50-/100-%-Storno: Gutschein bleibt verbraucht (§41). */
  async markConsumedByPaidCancellation(
    tx: DatabaseTransaction,
    input: { bookingId: string; cancellationId: string },
  ): Promise<void> {
    await tx
      .update(voucherRedemptions)
      .set({ finalConsumptionReason: 'paid_cancellation', cancellationId: input.cancellationId })
      .where(
        and(
          eq(voucherRedemptions.bookingId, input.bookingId),
          isNull(voucherRedemptions.reactivatedAt),
          isNull(voucherRedemptions.finalConsumptionReason),
        ),
      );
  }

  // ── Views (Order §§52–53) ──────────────────────────────────────────────

  /**
   * Anzeige-Status: eine Reservierung, deren Angebot nicht mehr annehmbar ist
   * (abgelaufen/abgelehnt ohne Nachfolgeversion), gilt als „Aktiv“ (§32 lazy);
   * geschrieben wird hier nichts – die Freigabe erfolgt beim nächsten Zugriff.
   */
  private async toSummary(
    row: VoucherRow,
    processNumber: string | null,
    now: Date,
  ): Promise<VoucherSummary> {
    let status = voucherEffectiveStatus(row.status, row.expiresAt, now);
    let reservedOfferId = row.reservedOfferId;
    if (status === 'reserved' && !(await this.reservationStillHeld(this.db, row, now))) {
      status = 'active';
      reservedOfferId = null;
    }
    return {
      id: row.id,
      status,
      statusLabel: VOUCHER_STATUS_LABELS[status],
      expiresAt: row.expiresAt.toISOString(),
      maskedReference: maskVoucherCode(row.codeSuffix),
      deliveryStatus: row.deliveryStatus,
      deliveryLabel: VOUCHER_DELIVERY_LABELS[row.deliveryStatus],
      reservedOfferId,
      originProcessId: row.originProcessId,
      originProcessNumber: processNumber,
    };
  }

  /** Relevantester Gutschein des Kunden: aktiv/reserviert zuerst, sonst der neueste. */
  async customerVoucherSummary(
    customerId: string,
    now: Date = new Date(),
  ): Promise<VoucherSummary | null> {
    const rows = await this.db
      .select({ voucher: vouchers, processNumber: processes.processNumber })
      .from(vouchers)
      .leftJoin(processes, eq(processes.id, vouchers.originProcessId))
      .where(eq(vouchers.customerId, customerId))
      .orderBy(desc(vouchers.createdAt));
    const first = rows[0];
    if (first === undefined) return null;
    const usable = rows.find((row) => {
      const status = voucherEffectiveStatus(row.voucher.status, row.voucher.expiresAt, now);
      return status === 'active' || status === 'reserved';
    });
    const chosen = usable ?? first;
    return this.toSummary(chosen.voucher, chosen.processNumber ?? null, now);
  }

  /** Gutschein, der aus diesem Ursprungsvorgang entstanden ist. */
  async processVoucherSummary(
    processId: string,
    now: Date = new Date(),
  ): Promise<VoucherSummary | null> {
    const rows = await this.db
      .select({ voucher: vouchers, processNumber: processes.processNumber })
      .from(vouchers)
      .leftJoin(processes, eq(processes.id, vouchers.originProcessId))
      .where(eq(vouchers.originProcessId, processId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return this.toSummary(row.voucher, row.processNumber ?? null, now);
  }
}
