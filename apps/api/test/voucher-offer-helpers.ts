import {
  bookings,
  offers,
  offerVersions,
  rentalReturns,
  settlements,
  voucherRedemptions,
  vouchers,
  type VoucherRow,
} from '@mietroyal/database';
import { formatVoucherCode } from '@mietroyal/domain';
import { eq } from 'drizzle-orm';
import type { TestContext } from './auth-helpers.ts';
import {
  commerceServices,
  ensureTestTerms,
  inquiryServiceFor,
  productServiceFor,
} from './commerce-helpers.ts';
import { createTestCustomer, processServiceFor } from './crm-helpers.ts';
import { eventDateInDays } from './cancellation-helpers.ts';
import { issueTestVoucher } from './voucher-helpers.ts';

/**
 * Phase-11-Testbausteine (Agent O): Gutschein-Fixture mit vollständiger
 * Ursprungskette (eigener Vorgang → Buchung → Rückgabe → Abrechnung als
 * FK-Träger) und Angebotsentwürfe für DENSELBEN Kunden. Der Code wird – wie
 * im Service – nur als SHA-256-Hash + Suffix gespeichert; der Klartext
 * existiert ausschließlich im Test.
 *
 * Der eigentliche Gutschein-Insert läuft über `issueTestVoucher` aus
 * `voucher-helpers.ts` (Agent D) – eine Fixture für beide Testgruppen.
 */

export interface VoucherOrigin {
  processId: string;
  bookingId: string;
  returnId: string;
  settlementId: string;
}

/** Ursprungskette eines Gutscheins (FK-Träger; Berechtigungsprüfung ist Agent D's Teil). */
export async function originChainFor(
  ctx: TestContext,
  adminId: string,
  customerId: string,
): Promise<VoucherOrigin> {
  const draft = await draftForCustomer(ctx, adminId, customerId, { eventInDays: 40 });
  const services = commerceServices(ctx);
  const effective = await ctx.auth.effectivePermissions(adminId);
  const { token } = await services.offers.send(adminId, draft.versionId, effective);
  const { bookingId } = await services.offers.accept(token);
  const returnRows = await ctx.db
    .insert(rentalReturns)
    .values({ bookingId, processId: draft.processId, status: 'draft' })
    .returning({ id: rentalReturns.id });
  const returnId = returnRows[0]!.id;
  const settlementRows = await ctx.db
    .insert(settlements)
    .values({ processId: draft.processId, bookingId, returnId })
    .returning({ id: settlements.id });
  return { processId: draft.processId, bookingId, returnId, settlementId: settlementRows[0]!.id };
}

/**
 * Gutschein direkt einfügen – delegiert an Agent D's `issueTestVoucher`
 * (Hash + Suffix + verschlüsselte Versandkopie, kein Klartext in der DB) und
 * liefert zusätzlich die Anzeigeform mit Bindestrichen.
 */
export async function insertTestVoucher(
  ctx: TestContext,
  input: {
    customerId: string;
    originProcessId: string;
    originBookingId: string;
    originReturnId: string;
    originSettlementId: string;
    activatedAt?: Date;
    status?: 'active' | 'reserved' | 'redeemed';
  },
): Promise<{ voucherId: string; code: string; compact: string }> {
  const { status, ...rest } = input;
  const issued = await issueTestVoucher(ctx, rest);
  if (status !== undefined && status !== 'active') {
    await ctx.db.update(vouchers).set({ status }).where(eq(vouchers.id, issued.voucherId));
  }
  return {
    voucherId: issued.voucherId,
    code: formatVoucherCode(issued.code),
    compact: issued.code,
  };
}

/** Gutschein für einen Kunden inkl. Ursprungskette. */
export async function issueVoucherForCustomer(
  ctx: TestContext,
  adminId: string,
  customerId: string,
  options: { activatedAt?: Date } = {},
): Promise<{ voucherId: string; code: string; compact: string; origin: VoucherOrigin }> {
  const origin = await originChainFor(ctx, adminId, customerId);
  const voucher = await insertTestVoucher(ctx, {
    customerId,
    originProcessId: origin.processId,
    originBookingId: origin.bookingId,
    originReturnId: origin.returnId,
    originSettlementId: origin.settlementId,
    ...(options.activatedAt === undefined ? {} : { activatedAt: options.activatedAt }),
  });
  return { ...voucher, origin };
}

export interface CustomerDraft {
  processId: string;
  offerId: string;
  versionId: string;
}

/** Neuer Vorgang + Anfrage + Angebotsentwurf für einen bestehenden Kunden. */
export async function draftForCustomer(
  ctx: TestContext,
  adminId: string,
  customerId: string,
  options: {
    eventInDays?: number;
    machineSlug?: string;
    machineQuantity?: number;
    fulfillment?: 'pickup' | 'delivery';
    deliveryPriceCents?: number;
    selections?: { slug: string; role: 'free' | 'extra'; quantity: number }[];
  } = {},
): Promise<CustomerDraft> {
  await ensureTestTerms(ctx.db);
  const products = productServiceFor(ctx);
  const machine = await products.getProductBySlug(options.machineSlug ?? 'slush-2x10');
  const fulfillment = options.fulfillment ?? 'pickup';
  const process = await processServiceFor(ctx).createProcess(adminId, { customerId });
  const selections = [];
  for (const selection of options.selections ?? []) {
    const product = await products.getProductBySlug(selection.slug);
    selections.push({ productId: product.id, role: selection.role, quantity: selection.quantity });
  }
  await inquiryServiceFor(ctx).upsertForProcess(adminId, process.id, {
    eventDate: eventDateInDays(options.eventInDays ?? 30),
    guestCount: 40,
    occasion: 'birthday',
    machineProductId: machine.id,
    fulfillment,
    deliveryStreet: fulfillment === 'delivery' ? 'Lieferweg 12' : null,
    deliveryPostalCode: fulfillment === 'delivery' ? '55129' : null,
    deliveryCity: fulfillment === 'delivery' ? 'Mainz' : null,
    selections,
  });
  const services = commerceServices(ctx);
  const { offerId, versionId } = await services.offers.createOffer(adminId, process.id);
  const draft: Record<string, unknown> = {};
  if (options.machineQuantity !== undefined) draft.machineQuantity = options.machineQuantity;
  if (options.deliveryPriceCents !== undefined)
    draft.deliveryPriceCents = options.deliveryPriceCents;
  if (Object.keys(draft).length > 0) await services.offers.updateDraft(adminId, versionId, draft);
  return { processId: process.id, offerId, versionId };
}

/** Kunde + Gutschein + Entwurf (Standard: Maschine 2×10 = 120 EUR, Gutschein 24 EUR). */
export async function voucherWorld(
  ctx: TestContext,
  adminId: string,
  options: { email?: string; draft?: Parameters<typeof draftForCustomer>[3] } = {},
) {
  const customer = await createTestCustomer(ctx, adminId, {
    firstName: 'Wanda',
    lastName: 'Wiedermieter',
    email: options.email ?? 'wanda.wiedermieter@test.example',
    phone: '0170 1112233',
  });
  const voucher = await issueVoucherForCustomer(ctx, adminId, customer.id);
  const draft = await draftForCustomer(ctx, adminId, customer.id, options.draft ?? {});
  return { customerId: customer.id, ...voucher, ...draft };
}

export async function voucherRow(ctx: TestContext, voucherId: string): Promise<VoucherRow> {
  return (await ctx.db.select().from(vouchers).where(eq(vouchers.id, voucherId)))[0]!;
}

export async function redemptionsFor(ctx: TestContext, voucherId: string) {
  return ctx.db
    .select()
    .from(voucherRedemptions)
    .where(eq(voucherRedemptions.voucherId, voucherId));
}

export async function versionRow(ctx: TestContext, versionId: string) {
  return (await ctx.db.select().from(offerVersions).where(eq(offerVersions.id, versionId)))[0]!;
}

export async function offerRow(ctx: TestContext, offerId: string) {
  return (await ctx.db.select().from(offers).where(eq(offers.id, offerId)))[0]!;
}

export async function bookingRowById(ctx: TestContext, bookingId: string) {
  return (await ctx.db.select().from(bookings).where(eq(bookings.id, bookingId)))[0]!;
}

/** Gutschein-Zustand direkt setzen (Ablauf-/Besitzer-/Status-Szenarien). */
export async function patchVoucher(
  ctx: TestContext,
  voucherId: string,
  patch: Partial<Pick<VoucherRow, 'expiresAt' | 'customerId' | 'status' | 'reservedOfferId'>>,
): Promise<void> {
  // CHECK expires_at > activated_at: für „bereits abgelaufen“-Szenarien die
  // Aktivierung passend vorverlegen (nur Testfixture).
  const activated =
    patch.expiresAt === undefined
      ? {}
      : {
          activatedAt: new Date(
            Math.min(
              (await voucherRow(ctx, voucherId)).activatedAt.getTime(),
              patch.expiresAt.getTime() - 3_600_000,
            ),
          ),
        };
  await ctx.db
    .update(vouchers)
    .set({ ...patch, ...activated })
    .where(eq(vouchers.id, voucherId));
}

/** Prüft, dass ein beliebiges Objekt den Klartextcode in keiner Form enthält. */
export function containsCode(value: unknown, code: string, compact: string): boolean {
  const text = JSON.stringify(value) ?? '';
  return text.includes(code) || text.includes(compact) || text.includes(compact.slice(4));
}
