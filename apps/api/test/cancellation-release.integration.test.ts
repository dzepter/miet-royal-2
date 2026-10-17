/**
 * Phase-9-Pflichttests 102–106, 113–115 (Order §94) und Legacy-Route:
 * Storno nur vor der Ausgabe, sofortige Ressourcenfreigabe (Termine,
 * Zuordnungen, Reserviert, Risikohinweise, ephemere Telefonnummern), keine
 * Lagerbewegung, Vorgang bleibt storniert und suchbar, keine Rückerstattung
 * (nur Hinweis), Legacy-Storno delegiert bei bestätigter Buchung.
 */
import {
  bookingAdvancePayments,
  bookingPickupRepresentatives,
  cancellations,
  inventoryMovements,
  machineRiskIncidents,
  processes,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  adminSession,
  adminViewer,
  appointmentsOf,
  assignmentsOf,
  bookedProcess,
  cancellationServicesFor,
  resetForCancellationTests,
  staffWith,
} from './cancellation-helpers.ts';
import { createTestCustomer, processServiceFor } from './crm-helpers.ts';
import {
  DAYS,
  handoverServicesFor,
  initializeAllInventory,
  readyHandover,
  scheduledBooking,
} from './handover-helpers.ts';
import { machineByCode } from './warehouse-helpers.ts';

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

async function cancelViaRoute(cookie: string, processId: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/staff/processes/${processId}/cancellation`,
    headers: { cookie },
    payload: { confirm: true },
  });
}

describe('102. Storno nur vor der Ausgabe', () => {
  it('102. Nach finalisierter Übergabe (issued) ist das Storno blockiert – 409 CANCELLATION_BLOCKED', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { handover } = handoverServicesFor(ctx);
    await initializeAllInventory(ctx, admin.id);
    const world = await scheduledBooking(ctx, admin.id);
    await readyHandover(ctx, admin.id, world.bookingId, ['MR-10-01-01']);
    await handover.finalize(admin.id, world.bookingId);
    const preview = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${world.processId}/cancellation/preview`,
      headers: { cookie },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().blockers.length).toBeGreaterThan(0);
    const response = await cancelViaRoute(cookie, world.processId);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CANCELLATION_BLOCKED');
    expect(response.json().error.message).toContain('ausgegeben');
    const process = (
      await ctx.db.select().from(processes).where(eq(processes.id, world.processId))
    )[0]!;
    expect(process.mainStatus).toBe('open');
    expect(await ctx.db.select().from(cancellations)).toHaveLength(0);
    expect((await assignmentsOf(ctx, world.bookingId)).map((a) => a.status)).toEqual(['issued']);
  });

  it('Vorgang ohne bestätigte Buchung oder bereits storniert ⇒ 409 CANCELLATION_BLOCKED', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const customer = await createTestCustomer(ctx, admin.id);
    const bare = await processServiceFor(ctx).createProcess(admin.id, { customerId: customer.id });
    const noBooking = await cancelViaRoute(cookie, bare.id);
    expect(noBooking.statusCode).toBe(409);
    expect(noBooking.json().error.code).toBe('CANCELLATION_BLOCKED');
    expect(noBooking.json().error.message).toContain('keine bestätigte Buchung');
    // Legacy-Status ohne Phase-9-Storno (kein cancellations-Datensatz) ⇒ blockiert.
    const legacy = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${bare.id}/cancel`,
      headers: { cookie },
    });
    expect(legacy.statusCode).toBe(200);
    const again = await cancelViaRoute(cookie, bare.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toContain('bereits storniert');
  });
});

describe('103.–106. Sofortige Ressourcenfreigabe ohne Lagerbewegung', () => {
  it('103.–106. Termine storniert, Zuordnung gelöst, Reserviert ⇒ Einsatzbereit, Risikohinweis gelöst, keine inventory_movements, Telefonnummern gelöscht', async () => {
    const { admin, effective } = await adminSession(ctx);
    const { assignments, handover, machineService } = handoverServicesFor(ctx);
    await initializeAllInventory(ctx, admin.id);
    const world = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 1 * DAYS),
      to: new Date(Date.now() + 3 * DAYS),
    });
    await readyHandover(ctx, admin.id, world.bookingId, ['MR-10-01-01']);
    await handover.setRepresentative(admin.id, world.bookingId, {
      firstName: 'Anna',
      lastName: 'Abholung',
      phone: '+49 6131 12345',
    });
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    expect(machine.status).toBe('reserved');
    // Risikohinweis provozieren: Maschine nachträglich für den Mietzeitraum sperren.
    await machineService.createBlock(machine.id, admin.id, {
      startsAt: new Date(Date.now() + 1 * DAYS),
      endsAt: new Date(Date.now() + 2 * DAYS),
      reason: 'Wartung',
    });
    await assignments.refreshRiskIncidents();
    const openBefore = await ctx.db
      .select()
      .from(machineRiskIncidents)
      .where(eq(machineRiskIncidents.processId, world.processId));
    expect(openBefore.filter((i) => i.resolvedAt === null).length).toBeGreaterThan(0);
    const movementsBefore = (await ctx.db.select().from(inventoryMovements)).length;

    const { service } = cancellationServicesFor(ctx);
    const view = await service.cancel(
      world.processId,
      { id: admin.id, type: 'admin' },
      adminViewer(effective),
    );
    expect(view.releasedResources).toEqual({
      appointments: 2,
      assignments: 1,
      machines: 1,
      riskIncidents: openBefore.filter((i) => i.resolvedAt === null).length,
    });
    // 103. Termine storniert (bestehender Statuswert), Version erhöht.
    const appointments = await appointmentsOf(ctx, world.bookingId);
    expect(appointments.map((a) => a.status)).toEqual(['cancelled', 'cancelled']);
    expect(appointments.every((a) => a.cancelledAt !== null && a.version >= 2)).toBe(true);
    // 104. Zuordnung gelöst (kein Fachzustand, Slot offen).
    const slots = await assignmentsOf(ctx, world.bookingId);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ status: 'open', machineId: null, releasedBy: null });
    expect(slots[0]!.releasedAt).not.toBeNull();
    // 105. Reserviert sauber zurück auf Einsatzbereit.
    expect((await machineByCode(ctx.db, 'MR-10-01-01')).status).toBe('ready');
    // 106. Keine Lagerbewegung.
    expect((await ctx.db.select().from(inventoryMovements)).length).toBe(movementsBefore);
    // Risikohinweise gelöst (nach Commit neu bewertet).
    const openAfter = await ctx.db
      .select()
      .from(machineRiskIncidents)
      .where(eq(machineRiskIncidents.processId, world.processId));
    expect(openAfter.every((i) => i.resolvedAt !== null)).toBe(true);
    expect(await assignments.listOpenIncidents()).toEqual([]);
    // Ephemere Telefonnummern gelöscht, Namen bleiben.
    const representative = (
      await ctx.db
        .select()
        .from(bookingPickupRepresentatives)
        .where(eq(bookingPickupRepresentatives.bookingId, world.bookingId))
    )[0]!;
    expect(representative.phone).toBeNull();
    expect(representative.firstName).toBe('Anna');
    // Übergabe bleibt Entwurf, Vorgang storniert.
    expect((await handover.detail(world.bookingId)).handover.status).toBe('draft');
    const process = (
      await ctx.db.select().from(processes).where(eq(processes.id, world.processId))
    )[0]!;
    expect(process.mainStatus).toBe('cancelled');
    expect(process.cancelledAt).not.toBeNull();
    // Freigegebene Maschine ist für eine andere Buchung ohne Kollision nutzbar.
    const other = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 1 * DAYS),
      to: new Date(Date.now() + 3 * DAYS),
    });
    await handover.ensureForBooking(other.bookingId, admin.id);
    const otherSlot = (await assignments.slotsForBooking(other.bookingId))[0]!;
    const evaluation = await assignments.evaluateMachine(
      machine.id,
      await assignments.assignmentById(otherSlot.id),
    );
    expect(evaluation.problems.some((p) => p.code === 'collision')).toBe(false);
  });
});

describe('113.–115. Status, Suche, keine Rückerstattung', () => {
  it('113./114. Vorgang bleibt storniert (nie completed) und ist über die Suche auffindbar; Detail zeigt Storno-Kurzinfo', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 3 });
    expect((await cancelViaRoute(cookie, world.processId)).statusCode).toBe(200);
    const search = await ctx.app.inject({
      method: 'GET',
      url: `/staff/search?q=${encodeURIComponent(world.processNumber)}&includeCompleted=true`,
      headers: { cookie },
    });
    expect(search.statusCode).toBe(200);
    const hits = search.json().processes as { id: string; mainStatus: string }[];
    expect(hits.some((p) => p.id === world.processId && p.mainStatus === 'cancelled')).toBe(true);
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${world.processId}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      process: { mainStatus: 'cancelled' },
      cancellation: {
        financeStatus: 'accounting_pending',
        financeStatusLabel: 'Stornorechnung – Buchhaltung ausstehend',
        feeCents: 7500,
      },
      relations: { previousProcess: null, followUpProcess: null },
    });
    // Abschluss eines stornierten Vorgangs ist nicht möglich (bleibt cancelled).
    const complete = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/complete`,
      headers: { cookie },
    });
    expect(complete.statusCode).toBe(409);
  });

  it('115. Anzahlung vorhanden ⇒ nur Hinweis „Externe Rückzahlung/Verrechnung prüfen“, keine Rückerstattung, Anzahlung unverändert', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 20 });
    await ctx.db.insert(bookingAdvancePayments).values({
      bookingId: world.bookingId,
      processId: world.processId,
      amountCents: 2500,
      receivedAt: '2026-10-01',
      recordedBy: admin.id,
    });
    const preview = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${world.processId}/cancellation/preview`,
      headers: { cookie },
    });
    expect(preview.json().externalRefundReviewRequired).toBe(true);
    const response = await cancelViaRoute(cookie, world.processId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      externalRefundReviewRequired: true,
      externalRefundReviewHint: 'Externe Rückzahlung/Verrechnung prüfen',
      financeStatus: 'no_invoice',
    });
    const advances = await ctx.db.select().from(bookingAdvancePayments);
    expect(advances).toHaveLength(1);
    expect(advances[0]).toMatchObject({ status: 'active', amountCents: 2500 });
    expect(ctx.accounting.calls).toHaveLength(0);
  });
});

describe('Legacy-Route POST /staff/processes/:id/cancel', () => {
  it('delegiert bei bestätigter Buchung an den Storno-Pfad (zusätzlich booking.cancel) und bleibt für Vorgänge ohne Buchung wie bisher', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 3 });
    const onlyProcessCancel = await staffWith(
      ctx,
      admin.id,
      ['process.view_all', 'process.cancel'],
      'Paula',
    );
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/cancel`,
      headers: { cookie: onlyProcessCancel.cookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(await ctx.db.select().from(cancellations)).toHaveLength(0);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/cancel`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      cancelled: true,
      cancellation: { processId: world.processId, feePercent: 100, feeCents: 7500 },
    });
    expect(await ctx.db.select().from(cancellations)).toHaveLength(1);
    expect((await appointmentsOf(ctx, world.bookingId)).map((a) => a.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);

    // Direkter Service-Aufruf auf einen Vorgang MIT Buchung ⇒ Verweis auf den Storno-Pfad.
    const other = await bookedProcess(ctx, admin.id, { eventInDays: 3 });
    await expect(
      processServiceFor(ctx).cancel(other.processId, {
        canViewCompleted: true,
        visibilityDays: 7,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
