/**
 * Phase-15-Pflichttests Kundenstorno (Order §63, Design §2.4): Vorschau nach
 * Phase-9-Regel (0/50/100 %, Basis nur reguläre Maschinenmiete – nicht Rabatt/
 * Gutschein/Lieferung/Kommission/Kanister, exakte Gebühr), nur eigene Buchung,
 * canceler_type customer ohne Staff-ID, Ressourcenfreigabe, 0 € ohne Rechnung,
 * kostenpflichtiger Buchhaltungspfad unverändert, automatische Bestätigungsmail
 * (+ Backstop), Doppelklick und Staff/Kunde-Race ⇒ genau ein Storno, Gutschein-
 * logik unverändert, Übergabe-Blocker verständlich, keine Interna im DTO.
 */
import {
  accountingTransfers,
  cancellations,
  integrationJobs,
  mailDeliveries,
  processes,
  vouchers,
} from '@mietroyal/database';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PORTAL_CANCELLATION_VIEWER,
  createPortalCancellationMailBackstopScanner,
} from '../src/portal/cancellation.ts';
import { PORTAL_MESSAGES } from '../src/portal/types.ts';
import type { PortalBookingView, PortalCancellationPreview } from '../src/portal/views.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  adminSession,
  appointmentsOf,
  bookedProcess,
  bookingRow,
  cancellationServicesFor,
} from './cancellation-helpers.ts';
import { settleMailJobs } from './mail-job-helpers.ts';
import {
  forbiddenKeysIn,
  portalApp,
  portalGet,
  portalPost,
  portalSessionFor,
  resetPortalWorld,
  type PortalTestApp,
} from './portal-test-helpers.ts';
import { issuedBooking } from './return-helpers.ts';
import { drainAllJobs } from './settlement-helpers.ts';
import { issueVoucherForCustomer } from './voucher-offer-helpers.ts';

let ctx: TestContext;
let portal: PortalTestApp;

beforeAll(async () => {
  ctx = await createTestContext();
  portal = await portalApp(ctx);
});
afterAll(async () => {
  await portal.close();
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetPortalWorld(ctx);
});

interface SnapshotItem {
  kind: string;
  quantity: number;
  standardUnitPriceCents: number;
  agreedUnitPriceCents: number;
}

/** Erwartete Stornobasis: Σ regulärer Maschinen-Listenpreis × Menge (Snapshot). */
async function expectedBase(bookingId: string): Promise<number> {
  const row = await bookingRow(ctx, bookingId);
  return (row.itemsSnapshot as SnapshotItem[])
    .filter((item) => item.kind === 'machine')
    .reduce((sum, item) => sum + item.standardUnitPriceCents * item.quantity, 0);
}

const feeOf = (base: number, percent: number) => Math.floor((base * percent + 50) / 100);

async function previewFor(cookie: string, bookingId: string): Promise<PortalCancellationPreview> {
  const response = await portalGet(
    portal.app,
    cookie,
    `/portal/bookings/${bookingId}/cancellation/preview`,
  );
  expect(response.status).toBe(200);
  return response.body as PortalCancellationPreview;
}

async function cancelVia(cookie: string, bookingId: string) {
  return portalPost(portal.app, cookie, `/portal/bookings/${bookingId}/cancellation`, {
    confirm: true,
  });
}

async function cancellationRow(processId: string) {
  return (
    await ctx.db.select().from(cancellations).where(eq(cancellations.processId, processId))
  )[0];
}

async function confirmationDeliveries(processId: string) {
  return ctx.db
    .select()
    .from(mailDeliveries)
    .where(
      and(
        eq(mailDeliveries.processId, processId),
        eq(mailDeliveries.kind, 'cancellation_confirmation'),
      ),
    );
}

describe('C1–C6. Vorschau nach Phase-9-Regel', () => {
  it('C1./C2. ≥15 Tage 0 %, 7–14 Tage 50 %, 0–6 Tage 100 % – Basis = reguläre Maschinenmiete', async () => {
    const { admin } = await adminSession(ctx);
    for (const [days, percent] of [
      [30, 0],
      [10, 50],
      [3, 100],
    ] as const) {
      const booked = await bookedProcess(ctx, admin.id, { eventInDays: days });
      const session = await portalSessionFor(ctx, booked.customerId);
      const preview = await previewFor(session.cookie, booked.bookingId);
      const base = await expectedBase(booked.bookingId);
      expect(base).toBeGreaterThan(0);
      expect(preview).toEqual({
        eventDate: expect.any(String),
        remainingDays: days,
        feePercent: percent,
        baseCents: base,
        feeCents: feeOf(base, percent),
        allowed: true,
        blockedMessage: null,
      });
    }
  });

  it('C3. Rabatt, Sonderpreis und Gutschein verringern die Basis nicht', async () => {
    const { admin } = await adminSession(ctx);
    const discounted = await bookedProcess(ctx, admin.id, {
      eventInDays: 10,
      discount: { type: 'percent', value: 20 },
    });
    let session = await portalSessionFor(ctx, discounted.customerId);
    let preview = await previewFor(session.cookie, discounted.bookingId);
    let base = await expectedBase(discounted.bookingId);
    const totals = (await bookingRow(ctx, discounted.bookingId)).totalsSnapshot as Record<
      string,
      number
    >;
    expect(totals.discountCents).toBeGreaterThan(0);
    expect(preview.baseCents).toBe(base);
    expect(preview.feeCents).toBe(feeOf(base, 50));

    const special = await bookedProcess(ctx, admin.id, {
      eventInDays: 10,
      specialMachinePriceCents: 1000,
    });
    session = await portalSessionFor(ctx, special.customerId);
    preview = await previewFor(session.cookie, special.bookingId);
    base = await expectedBase(special.bookingId);
    const machine = (
      (await bookingRow(ctx, special.bookingId)).itemsSnapshot as SnapshotItem[]
    ).find((i) => i.kind === 'machine')!;
    expect(machine.agreedUnitPriceCents).toBe(1000);
    expect(machine.standardUnitPriceCents).toBeGreaterThan(1000);
    expect(preview.baseCents).toBe(base);

    const withVoucher = await bookedProcess(ctx, admin.id, {
      eventInDays: 10,
      voucherCodeFor: async (customerId) =>
        (await issueVoucherForCustomer(ctx, admin.id, customerId)).code,
    });
    session = await portalSessionFor(ctx, withVoucher.customerId);
    preview = await previewFor(session.cookie, withVoucher.bookingId);
    const voucherTotals = (await bookingRow(ctx, withVoucher.bookingId)).totalsSnapshot as Record<
      string,
      number
    >;
    expect(voucherTotals.voucherDiscountCents).toBeGreaterThan(0);
    expect(preview.baseCents).toBe(await expectedBase(withVoucher.bookingId));
  });

  it('C4. Lieferung ist nicht Teil der Basis', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, {
      eventInDays: 10,
      fulfillment: 'delivery',
      deliveryPriceCents: 5000,
    });
    const session = await portalSessionFor(ctx, booked.customerId);
    const preview = await previewFor(session.cookie, booked.bookingId);
    const base = await expectedBase(booked.bookingId);
    expect(preview.baseCents).toBe(base);
    const delivery = (await bookingRow(ctx, booked.bookingId)).deliverySnapshot as Record<
      string,
      number
    >;
    expect(delivery.deliveryPriceCents).toBe(5000);
  });

  it('C5. Kommission/Kanister/Kaufartikel sind nicht Teil der Basis', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, {
      eventInDays: 10,
      selections: [
        { slug: 'becher-25', role: 'extra', quantity: 4 },
        { slug: 'mischkanister-6l', role: 'extra', quantity: 1 },
      ],
    });
    const items = (await bookingRow(ctx, booked.bookingId)).itemsSnapshot as SnapshotItem[];
    expect(items.some((i) => i.kind !== 'machine' && i.standardUnitPriceCents > 0)).toBe(true);
    const session = await portalSessionFor(ctx, booked.customerId);
    const preview = await previewFor(session.cookie, booked.bookingId);
    expect(preview.baseCents).toBe(await expectedBase(booked.bookingId));
  });

  it('C6. Exakte Gebühr (kaufmännisch gerundet) bei mehreren Maschinen', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 10, machineQuantity: 3 });
    const session = await portalSessionFor(ctx, booked.customerId);
    const preview = await previewFor(session.cookie, booked.bookingId);
    const base = await expectedBase(booked.bookingId);
    expect(preview.baseCents).toBe(base);
    expect(preview.feeCents).toBe(feeOf(base, 50));
    // Keine Interna in der Vorschau (Order §39).
    expect(Object.keys(preview).sort()).toEqual([
      'allowed',
      'baseCents',
      'blockedMessage',
      'eventDate',
      'feeCents',
      'feePercent',
      'remainingDays',
    ]);
  });
});

describe('C7–C13. Storno-Wirkung', () => {
  it('C7./C8. Nur die eigene Buchung – fremde Buchung ⇒ 404 ohne Wirkung', async () => {
    const { admin } = await adminSession(ctx);
    const own = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const other = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const session = await portalSessionFor(ctx, other.customerId);
    expect(
      (
        await portalGet(
          portal.app,
          session.cookie,
          `/portal/bookings/${own.bookingId}/cancellation/preview`,
        )
      ).status,
    ).toBe(404);
    const attempt = await cancelVia(session.cookie, own.bookingId);
    expect(attempt.status).toBe(404);
    expect(await cancellationRow(own.processId)).toBeUndefined();
    expect(
      (await ctx.db.select().from(processes).where(eq(processes.id, own.processId)))[0]!.mainStatus,
    ).toBe('open');
  });

  it('C9.–C12. Kundenstorno 0 €: canceler customer ohne Staff-ID, Ressourcen frei, keine Rechnung', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const session = await portalSessionFor(ctx, booked.customerId);
    const response = await cancelVia(session.cookie, booked.bookingId);
    expect(response.status).toBe(200);
    const view = response.body as PortalBookingView;
    expect(view).toMatchObject({
      bookingId: booked.bookingId,
      portalState: 'cancelled_free',
      stateLabel: 'Storniert',
      canCancelOnline: false,
      canMessage: false,
      cancellation: { feeCents: 0, feePercent: 0, invoiceFollows: false },
      invoice: { status: 'none', finalAmountCents: null },
    });

    const row = (await cancellationRow(booked.processId))!;
    expect(row.cancelerType).toBe('customer'); // C9
    expect(row.cancelerStaffId).toBeNull(); // C10
    expect(row.feeCents).toBe(0);
    expect(row.financeStatus).toBe('no_invoice'); // C12
    expect(row.accountingTransferId).toBeNull();
    expect(
      (await appointmentsOf(ctx, booked.bookingId)).map((a) => a.status), // C11
    ).toEqual(['cancelled', 'cancelled']);
    expect(
      (await ctx.db.select().from(processes).where(eq(processes.id, booked.processId)))[0]!
        .mainStatus,
    ).toBe('cancelled');
    expect(
      await ctx.db
        .select()
        .from(accountingTransfers)
        .where(eq(accountingTransfers.processId, booked.processId)),
    ).toEqual([]);
    expect(
      await ctx.db
        .select()
        .from(integrationJobs)
        .where(eq(integrationJobs.type, 'cancellation.accounting_transfer')),
    ).toEqual([]);
    expect(ctx.accounting.calls).toHaveLength(0);
  });

  it('C13. Kostenpflichtig: Buchhaltungspfad unverändert (Transferzeile, Job, Mock-Beleg, „Rechnung folgt“)', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    const session = await portalSessionFor(ctx, booked.customerId);
    const base = await expectedBase(booked.bookingId);
    const response = await cancelVia(session.cookie, booked.bookingId);
    expect(response.status).toBe(200);
    const view = response.body as PortalBookingView;
    expect(view.portalState).toBe('cancelled_fee');
    expect(view.cancellation).toMatchObject({
      feePercent: 50,
      feeCents: feeOf(base, 50),
      invoiceFollows: true,
    });
    expect(view.invoice).toEqual({
      status: 'preparing',
      label: 'Rechnung wird vorbereitet',
      finalAmountCents: null,
    });

    let row = (await cancellationRow(booked.processId))!;
    expect(row.cancelerType).toBe('customer');
    expect(row.financeStatus).toBe('accounting_pending');
    expect(row.accountingTransferId).not.toBeNull();
    const jobs = await ctx.db
      .select()
      .from(integrationJobs)
      .where(eq(integrationJobs.type, 'cancellation.accounting_transfer'));
    expect(jobs).toHaveLength(1);

    await drainAllJobs(ctx);
    const payloads = ctx.accounting.calls.filter((call) => call.kind === 'cancellation');
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.amountDueCents).toBe(feeOf(base, 50));
    row = (await cancellationRow(booked.processId))!;
    expect(row.financeStatus).toBe('invoice_open');

    const after = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${booked.bookingId}`,
    );
    expect((after.body as PortalBookingView).invoice).toEqual({
      status: 'open',
      label: 'Offen',
      finalAmountCents: feeOf(base, 50),
    });
    expect(forbiddenKeysIn(after.body)).toEqual([]);
  });
});

describe('C14–C16. Bestätigungsmail, Doppelklick, Race', () => {
  it('C14. Automatische Stornobestätigung über die Outbox (idempotent) – Storno gilt unabhängig vom Versand', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const session = await portalSessionFor(ctx, booked.customerId);
    expect((await cancelVia(session.cookie, booked.bookingId)).status).toBe(200);
    let row = (await cancellationRow(booked.processId))!;
    expect(row.confirmationStatus).toBe('queued');
    let deliveries = await confirmationDeliveries(booked.processId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.idempotencyKey).toBe(`cancellation_confirmation:${row.id}`);
    expect(deliveries[0]!.context).toMatchObject({
      processNumber: booked.processNumber,
      chargeCents: 0,
    });

    await settleMailJobs(ctx);
    row = (await cancellationRow(booked.processId))!;
    expect(row.confirmationStatus).toBe('sent');
    deliveries = await confirmationDeliveries(booked.processId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe('sent');
  });

  it('C14b. Backstop-Scanner reiht verlorene Bestätigungen von Kundenstornos nach – genau einmal', async () => {
    const { admin } = await adminSession(ctx);
    const { service } = cancellationServicesFor(ctx);
    const fresh = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const stale = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const staffCancelled = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const now = new Date();
    // „Crash“ zwischen Commit und Einreihen: Storno ohne sendConfirmation.
    await service.cancel(
      fresh.processId,
      { id: null, type: 'customer' },
      PORTAL_CANCELLATION_VIEWER,
      now,
    );
    await service.cancel(
      stale.processId,
      { id: null, type: 'customer' },
      PORTAL_CANCELLATION_VIEWER,
      new Date(now.getTime() - 3 * 60_000),
    );
    await service.cancel(
      staffCancelled.processId,
      { id: admin.id, type: 'admin' },
      PORTAL_CANCELLATION_VIEWER,
      new Date(now.getTime() - 3 * 60_000),
    );
    const scanner = createPortalCancellationMailBackstopScanner({
      db: ctx.db,
      confirmations: service,
    });
    expect(scanner.name).toBe('portal_cancellation_mail_backstop');
    const first = (await scanner.scanDue(now)) as { scanned: number; enqueued: number };
    expect(first).toEqual({ scanned: 1, enqueued: 1 });
    expect((await cancellationRow(stale.processId))!.confirmationStatus).toBe('queued');
    // Jüngeres Kundenstorno (Karenz) und Staff-Storno bleiben unberührt.
    expect((await cancellationRow(fresh.processId))!.confirmationStatus).toBe('prepared');
    expect((await cancellationRow(staffCancelled.processId))!.confirmationStatus).toBe('prepared');
    const second = (await scanner.scanDue(now)) as { scanned: number };
    expect(second.scanned).toBe(0);
    expect(await confirmationDeliveries(stale.processId)).toHaveLength(1);
  });

  it('C15. Doppelklick (sequenziell und parallel) ⇒ genau ein Storno, genau eine Mail', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    const session = await portalSessionFor(ctx, booked.customerId);
    const [a, b] = await Promise.all([
      cancelVia(session.cookie, booked.bookingId),
      cancelVia(session.cookie, booked.bookingId),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const third = await cancelVia(session.cookie, booked.bookingId);
    expect(third.status).toBe(200);
    expect((third.body as PortalBookingView).portalState).toBe('cancelled_fee');
    const rows = await ctx.db
      .select()
      .from(cancellations)
      .where(eq(cancellations.processId, booked.processId));
    expect(rows).toHaveLength(1);
    expect(await confirmationDeliveries(booked.processId)).toHaveLength(1);
    expect(
      await ctx.db
        .select()
        .from(accountingTransfers)
        .where(eq(accountingTransfers.processId, booked.processId)),
    ).toHaveLength(1);
  });

  it('C16. Race Staff/Kunde ⇒ genau eine Stornozeile, keine Doppelrechnung, keine Doppelmail', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const booked = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
      const session = await portalSessionFor(ctx, booked.customerId);
      const staff = () =>
        ctx.app.inject({
          method: 'POST',
          url: `/staff/processes/${booked.processId}/cancellation`,
          headers: { cookie },
          payload: { confirm: true },
        });
      const customer = () => cancelVia(session.cookie, booked.bookingId);
      const [staffResult, customerResult] =
        i % 2 === 0
          ? await Promise.all([staff(), customer()])
          : (await Promise.all([customer(), staff()])).reverse();
      expect((staffResult as { statusCode: number }).statusCode).toBe(200);
      expect((customerResult as { status: number }).status).toBe(200);
      const rows = await ctx.db
        .select()
        .from(cancellations)
        .where(eq(cancellations.processId, booked.processId));
      expect(rows).toHaveLength(1);
      outcomes.push(rows[0]!.cancelerType);
      expect(
        await ctx.db
          .select()
          .from(accountingTransfers)
          .where(eq(accountingTransfers.processId, booked.processId)),
      ).toHaveLength(1);
      const deliveries = await confirmationDeliveries(booked.processId);
      expect(deliveries.length).toBeLessThanOrEqual(1);
      // Automatische Mail nur, wenn der KUNDE das Storno ausgelöst hat.
      expect(deliveries.length).toBe(rows[0]!.cancelerType === 'customer' ? 1 : 0);
    }
    expect(outcomes.every((type) => type === 'customer' || type === 'admin')).toBe(true);
  });
});

describe('C17–C19. Gutschein, Blocker, DTO', () => {
  it('C17. Gutscheinlogik unverändert: 0 % reaktiviert denselben Gutschein, 50 % verbraucht ihn', async () => {
    const { admin } = await adminSession(ctx);
    for (const [days, expected] of [
      [30, 'active'],
      [10, 'redeemed'],
    ] as const) {
      let voucherId = '';
      const booked = await bookedProcess(ctx, admin.id, {
        eventInDays: days,
        voucherCodeFor: async (customerId) => {
          const issued = await issueVoucherForCustomer(ctx, admin.id, customerId);
          voucherId = issued.voucherId;
          return issued.code;
        },
      });
      expect(
        (await ctx.db.select().from(vouchers).where(eq(vouchers.id, voucherId)))[0]!.status,
      ).toBe('redeemed');
      const session = await portalSessionFor(ctx, booked.customerId);
      expect((await cancelVia(session.cookie, booked.bookingId)).status).toBe(200);
      const voucher = (await ctx.db.select().from(vouchers).where(eq(vouchers.id, voucherId)))[0]!;
      expect(voucher.status, `${days} Tage`).toBe(expected);
    }
  });

  it('C18. Übergabe abgeschlossen ⇒ verständlicher Kundentext, 409 PORTAL_CANCELLATION_BLOCKED, keine Interna', async () => {
    const { admin } = await adminSession(ctx);
    const issued = await issuedBooking(ctx, admin.id);
    const session = await portalSessionFor(ctx, issued.customerId);
    const preview = await previewFor(session.cookie, issued.bookingId);
    expect(preview.allowed).toBe(false);
    expect(preview.blockedMessage).toBe(PORTAL_MESSAGES.CANCELLATION_BLOCKED);
    const previewText = JSON.stringify(preview);
    expect(previewText).not.toMatch(/Übergabe|ausgegeben|Rückgabe|blocker/i);

    const detail = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${issued.bookingId}`,
    );
    expect((detail.body as PortalBookingView).canCancelOnline).toBe(false);

    const attempt = await cancelVia(session.cookie, issued.bookingId);
    expect(attempt.status).toBe(409);
    expect(attempt.body).toMatchObject({
      error: {
        code: 'PORTAL_CANCELLATION_BLOCKED',
        message: PORTAL_MESSAGES.CANCELLATION_BLOCKED,
      },
    });
    expect(JSON.stringify(attempt.body)).not.toMatch(/Übergabe|ausgegeben/i);
    expect(await cancellationRow(issued.processId)).toBeUndefined();
  });

  it('C19. Kein releasedResources/willRelease/Blocker im DTO; Body wird strikt geprüft', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const session = await portalSessionFor(ctx, booked.customerId);
    // Client darf Satz/Basis/Gebühr nie mitsenden (strictObject ⇒ 400).
    for (const payload of [
      { confirm: false },
      { confirm: true, feePercent: 0 },
      { confirm: true, customerId: booked.customerId },
      {},
    ]) {
      const rejected = await portalPost(
        portal.app,
        session.cookie,
        `/portal/bookings/${booked.bookingId}/cancellation`,
        payload,
      );
      expect(rejected.status, JSON.stringify(payload)).toBe(400);
    }
    expect(await cancellationRow(booked.processId)).toBeUndefined();

    const response = await cancelVia(session.cookie, booked.bookingId);
    expect(response.status).toBe(200);
    expect(forbiddenKeysIn(response.body)).toEqual([]);
    const text = JSON.stringify(response.body);
    expect(text).not.toMatch(/releasedResources|willRelease|blockers|accountingBlocker|machines"/);
    expect(Object.keys((response.body as PortalBookingView).cancellation!).sort()).toEqual([
      'cancelledAt',
      'feeCents',
      'feePercent',
      'invoiceFollows',
    ]);
  });
});
