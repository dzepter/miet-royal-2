/**
 * Phase-9-Pflichttests 86–101, 107–110 (Order §94): Stornoregel über die
 * EINE Domänenimplementierung (Berliner Kalendertage, 0/50/100 %, Basis nur
 * reguläre Maschinen-Listenpreise, deterministische Cent-Rundung), Vorschau,
 * kein Pflichtgrund, Stornierendentyp, Payload der Stornorechnung.
 */
import { accountingTransfers, cancellations, integrationJobs } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountingPayload } from '../src/accounting/gateway.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  adminSession,
  adminViewer,
  bookedProcess,
  cancellationServicesFor,
  eventDateInDays,
  resetForCancellationTests,
  staffWith,
} from './cancellation-helpers.ts';
import { productServiceFor } from './commerce-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetForCancellationTests(ctx);
});

async function preview(processId: string, now = new Date()) {
  return cancellationServicesFor(ctx).service.preview(processId, now);
}

describe('86.–91. Stornosatz nach Berliner Kalendertagen', () => {
  it.each([
    [15, 0, 0],
    [14, 50, 3750],
    [7, 50, 3750],
    [6, 100, 7500],
    [0, 100, 7500],
  ])(
    '86.–90. %i Tage vor dem Event ⇒ %i %% (Gebühr %i Cent bei 75,00 EUR Listenpreis)',
    async (days, percent, fee) => {
      const { admin, effective } = await adminSession(ctx);
      const now = new Date();
      const world = await bookedProcess(ctx, admin.id, { eventDate: eventDateInDays(days, now) });
      const view = await preview(world.processId, now);
      expect(view.blockers).toEqual([]);
      expect(view).toMatchObject({
        remainingDays: days,
        feePercent: percent,
        baseCents: 7500,
        feeCents: fee,
        roundingMethod: 'half_up',
      });
      const { service } = cancellationServicesFor(ctx);
      const cancelled = await service.cancel(
        world.processId,
        { id: admin.id, type: 'admin' },
        adminViewer(effective),
        now,
      );
      expect(cancelled).toMatchObject({ remainingDays: days, feePercent: percent, feeCents: fee });
      expect(cancelled.financeStatus).toBe(fee === 0 ? 'no_invoice' : 'accounting_pending');
    },
  );

  it('91. Kalendertage in Europe/Berlin – nicht in UTC und nicht in 24-h-Blöcken', async () => {
    const { admin } = await adminSession(ctx);
    // 22:30 UTC am 17.10.2026 = 00:30 Berlin am 18.10.2026 (MESZ). Bis zum
    // 01.11.2026 sind es in Berlin 14 Kalendertage (50 %), in UTC wären es 15 (0 %).
    const now = new Date('2026-10-17T22:30:00.000Z');
    const world = await bookedProcess(ctx, admin.id, { eventDate: '2026-11-01' });
    const view = await preview(world.processId, now);
    expect(view.remainingDays).toBe(14);
    expect(view.feePercent).toBe(50);
    // Dieselbe Uhrzeit nur 31 Minuten früher ist in Berlin noch der 17.10. ⇒ 15 Tage ⇒ 0 %.
    const earlier = await preview(world.processId, new Date('2026-10-17T21:59:00.000Z'));
    expect(earlier.remainingDays).toBe(15);
    expect(earlier.feePercent).toBe(0);
    // Ein bereits vergangenes Eventdatum zählt wie 0 Tage (100 %).
    const past = await preview(world.processId, new Date('2026-11-05T12:00:00.000Z'));
    expect(past.remainingDays).toBeLessThan(0);
    expect(past.feePercent).toBe(100);
  });
});

describe('92.–98. Basis: ausschließlich eingefrorene reguläre Maschinen-Listenpreise', () => {
  it('92./93. Rabatt verändert die Basis nicht (Listenpreis × Menge)', async () => {
    const { admin } = await adminSession(ctx);
    const now = new Date();
    const world = await bookedProcess(ctx, admin.id, {
      eventDate: eventDateInDays(10, now),
      machineSlug: 'slush-2x10',
      machineQuantity: 2,
      discount: { type: 'percent', value: 1000 },
    });
    const view = await preview(world.processId, now);
    expect(view.machines).toEqual([
      { description: expect.stringContaining('2×10'), quantity: 2, standardUnitPriceCents: 12000 },
    ]);
    expect(view.baseCents).toBe(24000);
    expect(view.feePercent).toBe(50);
    expect(view.feeCents).toBe(12000);
  });

  it('94. Sonderpreis der Maschine ist nicht die Basis', async () => {
    const { admin } = await adminSession(ctx);
    const now = new Date();
    const world = await bookedProcess(ctx, admin.id, {
      eventDate: eventDateInDays(3, now),
      specialMachinePriceCents: 1000,
    });
    const view = await preview(world.processId, now);
    expect(view.baseCents).toBe(7500);
    expect(view.feeCents).toBe(7500);
  });

  it('95. Lieferpreis ist ausgeschlossen', async () => {
    const { admin } = await adminSession(ctx);
    const now = new Date();
    const world = await bookedProcess(ctx, admin.id, {
      eventDate: eventDateInDays(3, now),
      fulfillment: 'delivery',
      deliveryPriceCents: 4900,
    });
    const view = await preview(world.processId, now);
    expect(view.baseCents).toBe(7500);
    expect(view.feeCents).toBe(7500);
  });

  it('96./97. Kaufartikel (Kanister) und Kommissionsartikel (Sirup, Becher) sind ausgeschlossen', async () => {
    const { admin } = await adminSession(ctx);
    const now = new Date();
    const world = await bookedProcess(ctx, admin.id, {
      eventDate: eventDateInDays(3, now),
      selections: [
        { slug: 'sirup-kirsche', role: 'extra', quantity: 3 },
        { slug: 'becher-25', role: 'extra', quantity: 4 },
        { slug: 'mischkanister-6l', role: 'extra', quantity: 2 },
      ],
    });
    const view = await preview(world.processId, now);
    expect(view.baseCents).toBe(7500);
    expect(view.feeCents).toBe(7500);
    expect(view.machines).toHaveLength(1);
  });

  it('98. 50 %-Rundung ist deterministisch kaufmännisch (half up) auf volle Cent; heutiger Preis ist egal', async () => {
    const { admin } = await adminSession(ctx);
    const now = new Date();
    const products = productServiceFor(ctx);
    const machine = await products.getProductBySlug('slush-1x10');
    await products.setCurrentPrice(admin.id, machine.id, 7501);
    const world = await bookedProcess(ctx, admin.id, { eventDate: eventDateInDays(10, now) });
    // Spätere Preisänderung darf das eingefrorene Ergebnis nicht verändern (§51).
    await products.setCurrentPrice(admin.id, machine.id, 99900);
    const view = await preview(world.processId, now);
    expect(view.baseCents).toBe(7501);
    expect(view.feeCents).toBe(3751); // 3750,5 ⇒ 3751
    expect(view.roundingMethod).toBe('half_up');
    const again = await preview(world.processId, now);
    expect(again.feeCents).toBe(3751);
  });
});

describe('99.–101. Vorschau, Bestätigung ohne Pflichtgrund, Stornierendentyp', () => {
  it('99. Vorschau liefert Eventdatum, Resttage, Basis, Satz, Gebühr und Freigabeumfang', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const eventDate = eventDateInDays(10);
    const world = await bookedProcess(ctx, admin.id, { eventDate });
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${world.processId}/cancellation/preview`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      eventDate,
      remainingDays: 10,
      feePercent: 50,
      baseCents: 7500,
      feeCents: 3750,
      roundingMethod: 'half_up',
      willRelease: { appointments: 2, assignments: 0, reservedMachines: 0 },
      blockers: [],
      externalRefundReviewRequired: false,
      accountingConfigured: true,
    });
  });

  it('100./101. Storno mit bloßer Bestätigung (kein Grund); Admin wird als admin gespeichert', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 20 });
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/cancellation`,
      headers: { cookie },
      payload: { confirm: true },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      processId: world.processId,
      processNumber: world.processNumber,
      cancelerType: 'admin',
      cancelerStaffId: admin.id,
      feePercent: 0,
      feeCents: 0,
      financeStatus: 'no_invoice',
      financeStatusLabel: 'Storniert – ohne Rechnung',
      confirmationStatus: 'prepared',
    });
    const stored = (await ctx.db.select().from(cancellations))[0]!;
    expect(stored.cancelerType).toBe('admin');
    expect(stored.cancelerStaffId).toBe(admin.id);
    expect(stored.cancelledAt).not.toBeNull();
  });

  it('101. Mitarbeiter mit booking.cancel wird als employee gespeichert; Zeitstempel/Stornierer nur für Admin bzw. reopen-Recht sichtbar', async () => {
    const { admin } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 20 });
    const employee = await staffWith(ctx, admin.id, ['process.view_all', 'booking.cancel'], 'Emil');
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/cancellation`,
      headers: { cookie: employee.cookie },
      payload: { confirm: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ cancelerType: 'employee', cancelerStaffId: null });
    const stored = (await ctx.db.select().from(cancellations))[0]!;
    expect(stored.cancelerType).toBe('employee');
    expect(stored.cancelerStaffId).toBe(employee.user.id);
  });
});

describe('107.–110. Stornorechnung nur bei Gebühr – genau eine Position mit Vorgangsnummer und Eventdatum', () => {
  it('107. 0 % ⇒ keine Transferzeile, kein Job, Status „ohne Rechnung“', async () => {
    const { admin, effective } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 15 });
    const { service } = cancellationServicesFor(ctx);
    const view = await service.cancel(
      world.processId,
      { id: admin.id, type: 'admin' },
      adminViewer(effective),
    );
    expect(view.financeStatus).toBe('no_invoice');
    expect(view.transfer).toBeNull();
    expect(view.accountingBlocker).toBeNull();
    expect(await ctx.db.select().from(accountingTransfers)).toHaveLength(0);
    expect(await ctx.db.select().from(integrationJobs)).toHaveLength(0);
    expect(ctx.accounting.calls).toHaveLength(0);
  });

  it('108.–110. Gebühr ⇒ genau eine Transferzeile mit einer Kundenzeile, Vorgangsnummer, Eventdatum und Stornoangaben', async () => {
    const { admin, effective } = await adminSession(ctx);
    const eventDate = eventDateInDays(10);
    const world = await bookedProcess(ctx, admin.id, {
      eventDate,
      fulfillment: 'delivery',
      deliveryPriceCents: 3000,
      discount: { type: 'fixed', value: 500 },
      selections: [{ slug: 'mischkanister-6l', role: 'extra', quantity: 2 }],
    });
    const { service } = cancellationServicesFor(ctx);
    const view = await service.cancel(
      world.processId,
      { id: admin.id, type: 'admin' },
      adminViewer(effective),
    );
    expect(view.financeStatus).toBe('accounting_pending');
    expect(view.transfer).toMatchObject({ status: 'pending', provider: 'mock', mock: true });
    const transfers = await ctx.db.select().from(accountingTransfers);
    expect(transfers).toHaveLength(1);
    const transfer = transfers[0]!;
    expect(transfer.kind).toBe('cancellation');
    expect(transfer.cancellationId).toBe(view.id);
    expect(transfer.idempotencyKey).toBe(`cancellation-transfer:${view.id}`);
    const payload = transfer.snapshot as AccountingPayload;
    expect(payload.kind).toBe('cancellation');
    expect(payload.processNumber).toBe(world.processNumber);
    expect(payload.lines).toHaveLength(1);
    expect(payload.lines[0]).toMatchObject({
      description: `Stornokosten gemäß Mietbedingungen – Vorgang ${world.processNumber}`,
      quantity: 1,
      amountCents: 3750,
      direction: 'charge',
    });
    expect(payload.eventDate).toBe(eventDate);
    expect(payload.cancellation).toEqual({
      originalEventDate: eventDate,
      regularMachinePriceCents: 7500,
      feePercent: 50,
      feeCents: 3750,
      remainingDays: 10,
    });
    expect(payload.totals).toEqual({
      chargesCents: 3750,
      creditsCents: 0,
      amountDueCents: 3750,
      overpaymentCents: 0,
    });
    expect(payload.customer.email).toBe('klara.kommerz@test.example');
    expect(payload.tax).toBeNull();
    // Automatischer Job eingestellt (ein Job je Storno).
    const jobs = await ctx.db
      .select()
      .from(integrationJobs)
      .where(eq(integrationJobs.type, 'cancellation.accounting_transfer'));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ cancellationId: view.id, reason: 'auto' });
  });
});
