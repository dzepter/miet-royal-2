import { randomUUID } from 'node:crypto';
import { machines, vouchers } from '@mietroyal/database';
import { voucherExpiresAt } from '@mietroyal/domain';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { codeSuffix, generateVoucherCode, hashVoucherCode } from '../src/voucher/voucher-codes.ts';
import { encryptDeliveryCode } from '../src/voucher/voucher-crypto.ts';
import { VoucherDeliveryService } from '../src/voucher/voucher-delivery.ts';
import { VoucherService } from '../src/voucher/voucher-service.ts';
import type { TestContext } from './auth-helpers.ts';
import { settleMailJobs } from './mail-job-helpers.ts';
import {
  openClarifications,
  post,
  resetSettlementWorld,
  settledReturn,
  settlementViewFor,
  type FinalizedReturn,
  type FinalizedReturnOptions,
} from './settlement-helpers.ts';
import type { SettlementView } from '../src/settlement/settlement-service.ts';

/**
 * Phase-11-Testbausteine (Agent D): Gutschein-Welten über die ECHTEN Wege
 * (Rückgabe-Finalisierung, Abrechnung, Transfer mit Mock-Gateway, Mock-
 * Zahlungsstatus, Reinigungsabschluss über die Route) – plus ein direkter
 * Test-Gutschein (`issueTestVoucher`) für Angebots-/Storno-Tests.
 */

export async function truncateVoucherTables(pool: pg.Pool): Promise<void> {
  await pool.query('TRUNCATE voucher_redemptions, vouchers CASCADE');
}

export async function resetVoucherWorld(ctx: TestContext): Promise<void> {
  await truncateVoucherTables(ctx.pool);
  await resetSettlementWorld(ctx);
}

export function voucherServiceFor(ctx: TestContext): VoucherService {
  return new VoucherService(ctx.db, ctx.config);
}

export function voucherDeliveryFor(ctx: TestContext): VoucherDeliveryService {
  return new VoucherDeliveryService(ctx.db, ctx.config);
}

/**
 * Test-Gutschein direkt in `vouchers` (Hash + Suffix + verschlüsselte Kopie,
 * kein Klartext in der DB). Liefert den Klartextcode NUR an den Test.
 */
export async function issueTestVoucher(
  ctx: TestContext,
  input: {
    customerId: string;
    originProcessId: string;
    originBookingId: string;
    originReturnId: string;
    originSettlementId: string;
    activatedAt?: Date;
    now?: Date;
  },
): Promise<{ voucherId: string; code: string }> {
  const now = input.now ?? new Date();
  const activatedAt = input.activatedAt ?? now;
  const voucherId = randomUUID();
  const code = generateVoucherCode();
  await ctx.db.insert(vouchers).values({
    id: voucherId,
    customerId: input.customerId,
    originProcessId: input.originProcessId,
    originBookingId: input.originBookingId,
    originReturnId: input.originReturnId,
    originSettlementId: input.originSettlementId,
    codeHash: hashVoucherCode(code),
    codeSuffix: codeSuffix(code),
    status: 'active',
    activatedAt,
    expiresAt: voucherExpiresAt(activatedAt),
    deliveryStatus: 'pending',
    deliveryCodeCiphertext: encryptDeliveryCode(code, voucherId, ctx.config.auth.secretKey),
    createdAt: now,
    updatedAt: now,
  });
  return { voucherId, code };
}

export async function voucherRow(ctx: TestContext, voucherId: string) {
  return (await ctx.db.select().from(vouchers).where(eq(vouchers.id, voucherId)))[0] ?? null;
}

export async function vouchersForSettlement(ctx: TestContext, settlementId: string) {
  return ctx.db.select().from(vouchers).where(eq(vouchers.originSettlementId, settlementId));
}

export async function allVouchers(ctx: TestContext) {
  return ctx.db.select().from(vouchers);
}

export interface PaidWorld {
  world: FinalizedReturn;
  view: SettlementView;
  settlementId: string;
  transferId: string;
}

/** Transfer über die echte Route (Mock-Gateway) – Settlement muss bereit sein. */
export async function transferViaRoute(ctx: TestContext, cookie: string, processId: string) {
  const view = await settlementViewFor(ctx.app, cookie, processId);
  const transfer = await post(
    ctx.app,
    cookie,
    `/staff/settlements/${view.settlement.id}/transfer`,
    {
      version: view.settlement.version,
    },
  );
  if (transfer.status !== 200 || transfer.body.outcome !== 'succeeded') {
    throw new Error(`Transfer fehlgeschlagen: ${transfer.status} ${JSON.stringify(transfer.body)}`);
  }
  const after = await settlementViewFor(ctx.app, cookie, processId);
  return { view: after, transferId: after.transfer!.id };
}

/** Zahlungsstatus über die Mock-Steuerung (löst den Listener/Job aus). */
export async function setPaymentViaRoute(
  ctx: TestContext,
  cookie: string,
  transferId: string,
  status: 'open' | 'paid' | 'overdue',
): Promise<void> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/staff/accounting/mock/payment-status',
    headers: { cookie },
    payload: { transferId, status },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Zahlungsstatus nicht setzbar: ${response.statusCode} ${response.body}`);
  }
}

/** Alle fälligen Jobs des Test-Runners verarbeiten (wie der Worker). */
export async function drainJobs(ctx: TestContext): Promise<number> {
  let processed = 0;
  for (let i = 0; i < 50; i += 1) {
    const outcome = await ctx.jobs.runOnce();
    if (outcome === 'idle') break;
    processed += 1;
  }
  return processed;
}

/**
 * Finalisierte Rückgabe ⇒ Abrechnung ⇒ Transfer ⇒ „bezahlt“. Bei berechneten
 * Schäden wird die Klärung aufgelöst, die Kundeninformation gesendet und das
 * Warten beendet; bei `noCharge` ohne Betrag. Reinigung bleibt offen, bis
 * `completeCleaningViaRoute` aufgerufen wird.
 */
export async function paidSettledWorld(
  ctx: TestContext,
  adminId: string,
  cookie: string,
  options: FinalizedReturnOptions & {
    damageDecision?: 'charge' | 'no_charge';
    damageAmountCents?: number;
    paymentStatus?: 'open' | 'paid' | 'overdue';
  } = {},
): Promise<PaidWorld> {
  const { world, view } = await settledReturn(ctx, adminId, cookie, options);
  let current = view;
  const open = [
    ...openClarifications(current, 'damage_cost'),
    ...openClarifications(current, 'missing_item_cost'),
  ];
  for (const clarification of open) {
    const decision = options.damageDecision ?? 'no_charge';
    const resolved = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/clarifications/${clarification.id}/resolve`,
      {
        decision,
        ...(decision === 'charge' ? { amountCents: options.damageAmountCents ?? 5000 } : {}),
        version: current.settlement.version,
      },
    );
    if (resolved.status !== 200) {
      throw new Error(
        `Klärung nicht auflösbar: ${resolved.status} ${JSON.stringify(resolved.body)}`,
      );
    }
    current = await settlementViewFor(ctx.app, cookie, world.processId);
  }
  if (current.settlement.noticeRequired) {
    const sent = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/notice/approve-and-send`,
      { version: current.settlement.version },
    );
    if (sent.status !== 200) throw new Error(`Kundeninformation nicht sendbar: ${sent.status}`);
    // Phase 12: Freigabe reiht nur ein – erst der bestätigte Mailversand startet die Frist.
    await settleMailJobs(ctx);
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    const ended = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/end-wait`,
      {
        version: current.settlement.version,
      },
    );
    if (ended.status !== 200) throw new Error(`Warten nicht beendbar: ${ended.status}`);
  }
  const { view: transferred, transferId } = await transferViaRoute(ctx, cookie, world.processId);
  const paymentStatus = options.paymentStatus ?? 'paid';
  if (paymentStatus !== 'open') await setPaymentViaRoute(ctx, cookie, transferId, paymentStatus);
  return { world, view: transferred, settlementId: transferred.settlement.id, transferId };
}

export async function machineByCode(ctx: TestContext, code: string) {
  const rows = await ctx.db.select().from(machines).where(eq(machines.machineCode, code));
  const row = rows[0];
  if (row === undefined) throw new Error(`Maschine ${code} fehlt`);
  return row;
}

/** „Gereinigt & einsatzbereit“ über die echte Route (löst Trigger B aus). */
export async function completeCleaningViaRoute(
  ctx: TestContext,
  cookie: string,
  machineCode: string,
): Promise<void> {
  const machine = await machineByCode(ctx, machineCode);
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/staff/machines/${machine.id}/clean-complete`,
    headers: { cookie },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Reinigungsabschluss fehlgeschlagen: ${response.statusCode} ${response.body}`);
  }
}

/** Komplett berechtigte Welt: bezahlt UND Reinigung aller Maschinen abgeschlossen. */
export async function payAndCompleteWorld(
  ctx: TestContext,
  adminId: string,
  cookie: string,
  options: Parameters<typeof paidSettledWorld>[3] = {},
): Promise<PaidWorld> {
  const paid = await paidSettledWorld(ctx, adminId, cookie, options);
  for (const code of paid.world.machineCodes) await completeCleaningViaRoute(ctx, cookie, code);
  return paid;
}
