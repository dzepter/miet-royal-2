/**
 * Phase-9-Pflichttests 122–129 (Order §96) und §63 (Admin-Reopen):
 * Folgevorgang aus Storno (neue Nummer, nur Kunde, bidirektionale
 * Relation, alte Buchung unverändert, genau ein Folgevorgang), Reopen
 * markiert die Stornierung, sperrt nichts auf und reaktiviert nichts.
 */
import {
  bookings,
  cancellations,
  machineAssignments,
  processRelations,
  processes,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  adminSession,
  appointmentsOf,
  bookedProcess,
  bookingRow,
  cancelBooking,
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

async function followUp(cookie: string, processId: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/staff/processes/${processId}/follow-up`,
    headers: { cookie },
    payload: {},
  });
}

async function assignmentsOfBooking(bookingId: string) {
  return ctx.db
    .select()
    .from(machineAssignments)
    .where(eq(machineAssignments.bookingId, bookingId));
}

async function detail(cookie: string, processId: string) {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/staff/processes/${processId}`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, unknown>;
}

describe('122.–129. Folgevorgang aus Storno', () => {
  it('122.–128. Neuer Vorgang mit neuer Nummer, nur Kundenreferenz, kein Eventdatum/Maschine/Preis, bidirektionale Relation', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, {
      eventInDays: 10,
      discount: { type: 'percent', value: 1000 },
    });
    const cancellation = await cancelBooking(ctx, admin.id, world.processId);
    expect(cancellation.permissions.canCreateFollowUp).toBe(true);
    expect(cancellation.followUpProcess).toBeNull();

    const response = await followUp(cookie, world.processId);
    expect(response.statusCode).toBe(200);
    const created = response.json() as { processId: string; processNumber: string };
    expect(created.processId).not.toBe(world.processId);
    expect(created.processNumber).not.toBe(world.processNumber);
    expect(created.processNumber).toMatch(/^MR-\d{4}-\d{4}$/);
    const newProcess = (
      await ctx.db.select().from(processes).where(eq(processes.id, created.processId))
    )[0]!;
    expect(newProcess).toMatchObject({
      customerId: world.customerId,
      mainStatus: 'open',
      eventDate: null,
      source: 'staff_manual',
      createdBy: admin.id,
    });
    // Keine Buchung, kein Angebot, keine Termine am neuen Vorgang.
    expect(
      await ctx.db.select().from(bookings).where(eq(bookings.processId, created.processId)),
    ).toHaveLength(0);
    const offers = await ctx.pool.query('SELECT 1 FROM offers WHERE process_id = $1', [
      created.processId,
    ]);
    expect(offers.rowCount).toBe(0);
    const appointments = await ctx.pool.query('SELECT 1 FROM appointments WHERE process_id = $1', [
      created.processId,
    ]);
    expect(appointments.rowCount).toBe(0);
    // Relation normalisiert als EINE Zeile, in beiden Vorgangs-Details sichtbar.
    const relations = await ctx.db.select().from(processRelations);
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      previousProcessId: world.processId,
      followUpProcessId: created.processId,
      kind: 'cancellation_follow_up',
      createdBy: admin.id,
    });
    const previousDetail = await detail(cookie, world.processId);
    expect(previousDetail.relations).toEqual({
      previousProcess: null,
      followUpProcess: { id: created.processId, processNumber: created.processNumber },
    });
    const followUpDetail = await detail(cookie, created.processId);
    expect(followUpDetail.relations).toEqual({
      previousProcess: { id: world.processId, processNumber: world.processNumber },
      followUpProcess: null,
    });
    expect(followUpDetail.cancellation).toBeNull();
    const cancellationView = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${world.processId}/cancellation`,
      headers: { cookie },
    });
    expect(cancellationView.json()).toMatchObject({
      followUpProcess: { id: created.processId },
      permissions: { canCreateFollowUp: false },
    });
  });

  it('129. Alte Buchung bleibt unverändert; ein zweiter Folgevorgang ⇒ 409 FOLLOW_UP_EXISTS (auch parallel)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    const before = await bookingRow(ctx, world.bookingId);
    await cancelBooking(ctx, admin.id, world.processId);
    const [a, b] = await Promise.all([
      followUp(cookie, world.processId),
      followUp(cookie, world.processId),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const conflict = a.statusCode === 409 ? a : b;
    expect(conflict.json().error.code).toBe('FOLLOW_UP_EXISTS');
    expect(await ctx.db.select().from(processRelations)).toHaveLength(1);
    const third = await followUp(cookie, world.processId);
    expect(third.statusCode).toBe(409);
    expect(third.json().error.message).toMatch(/MR-\d{4}-\d{4}/);
    const after = await bookingRow(ctx, world.bookingId);
    expect(after).toEqual(before);
  });

  it('Folgevorgang nur aus stornierten Vorgängen; Recht process.create erforderlich', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    const open = await followUp(cookie, world.processId);
    expect(open.statusCode).toBe(409);
    await cancelBooking(ctx, admin.id, world.processId);
    const limited = await staffWith(ctx, admin.id, ['process.view_all'], 'Finn');
    const denied = await followUp(limited.cookie, world.processId);
    expect(denied.statusCode).toBe(403);
    expect(await ctx.db.select().from(processRelations)).toHaveLength(0);
    const creator = await staffWith(ctx, admin.id, ['process.view_all', 'process.create'], 'Carla');
    const ok = await followUp(creator.cookie, world.processId);
    expect(ok.statusCode).toBe(200);
    // Auch ein per Legacy-Route stornierter Vorgang ohne Buchung erlaubt einen Folgevorgang.
    const customer = await createTestCustomer(ctx, admin.id);
    const bare = await processServiceFor(ctx).createProcess(admin.id, { customerId: customer.id });
    const legacy = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${bare.id}/cancel`,
      headers: { cookie },
    });
    expect(legacy.statusCode).toBe(200);
    expect((await followUp(cookie, bare.id)).statusCode).toBe(200);
  });
});

describe('§63 Admin-Reopen eines Stornos', () => {
  it('Reopen markiert die Stornierung (reopenedAt/By), lässt Accountingdaten unverändert, reaktiviert Buchung/Termine nicht', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    const view = await cancelBooking(ctx, admin.id, world.processId);
    await ctx.jobs.drain();
    const before = (
      await ctx.db.select().from(cancellations).where(eq(cancellations.id, view.id))
    )[0]!;
    expect(before.financeStatus).toBe('invoice_open');
    const bookingBefore = await bookingRow(ctx, world.bookingId);

    const reopen = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/reopen`,
      headers: { cookie },
    });
    expect(reopen.statusCode).toBe(200);
    const process = (
      await ctx.db.select().from(processes).where(eq(processes.id, world.processId))
    )[0]!;
    expect(process.mainStatus).toBe('reopened');
    const after = (
      await ctx.db.select().from(cancellations).where(eq(cancellations.id, view.id))
    )[0]!;
    expect(after.reopenedAt).not.toBeNull();
    expect(after.reopenedBy).toBe(admin.id);
    expect({ ...after, reopenedAt: null, reopenedBy: null, updatedAt: before.updatedAt }).toEqual(
      before,
    );
    expect(await bookingRow(ctx, world.bookingId)).toEqual(bookingBefore);
    expect((await appointmentsOf(ctx, world.bookingId)).map((a) => a.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
    expect(ctx.accounting.calls).toHaveLength(1);
    // Storno-Ansicht zeigt reopenedAt; erneutes Storno ist nicht vorgesehen (409); Folgevorgang nur aus cancelled.
    const shown = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${world.processId}/cancellation`,
      headers: { cookie },
    });
    expect(shown.json().reopenedAt).not.toBeNull();
    expect(shown.json().permissions.canCreateFollowUp).toBe(true);
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/cancellation`,
      headers: { cookie },
      payload: { confirm: true },
    });
    expect(again.statusCode).toBe(409);
    expect(await ctx.db.select().from(cancellations)).toHaveLength(1);
  });
  it('§63 Nach Reopen bleibt die alte Buchung gesperrt: Zuweisung, Vorbereitung, Übergabe (Mutation/Finalisierung) und Rückgabe ⇒ 409; Folgevorgang weiterhin möglich', async () => {
    const { admin, cookie, effective } = await adminSession(ctx);
    const { assignments, handover, returns } = handoverServicesFor(ctx);
    await initializeAllInventory(ctx, admin.id);
    const world = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 1 * DAYS),
      to: new Date(Date.now() + 3 * DAYS),
    });
    await readyHandover(ctx, admin.id, world.bookingId, ['MR-10-01-01']);
    await cancelBooking(ctx, admin.id, world.processId);
    const reopen = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/reopen`,
      headers: { cookie },
    });
    expect(reopen.statusCode).toBe(200);
    const expected = { code: 'CONFLICT', message: expect.stringContaining('storniert') };
    const slot = (await assignments.slotsForBooking(world.bookingId))[0]!;
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    await expect(
      assignments.assign(admin.id, effective, slot.id, machine.id, null),
    ).rejects.toMatchObject(expected);
    await expect(assignments.prepare(admin.id, slot.id)).rejects.toMatchObject(expected);
    await expect(
      handover.setRecipient(world.bookingId, { kind: 'customer' }),
    ).rejects.toMatchObject(expected);
    await expect(handover.finalize(admin.id, world.bookingId)).rejects.toMatchObject(expected);
    await expect(returns.start(admin.id, world.bookingId)).rejects.toMatchObject(expected);
    const handoverDetail = await handover.detail(world.bookingId);
    expect(handoverDetail.blockers.some((b) => b.includes('Folgevorgang'))).toBe(true);
    expect(handoverDetail.handover.status).toBe('draft');
    expect((await assignmentsOfBooking(world.bookingId)).map((a) => a.status)).toEqual(['open']);
    expect((await machineByCode(ctx.db, 'MR-10-01-01')).status).toBe('ready');
    // Über die HTTP-Routen ebenso 409.
    const assignRoute = await ctx.app.inject({
      method: 'POST',
      url: `/staff/handover/${world.bookingId}/slots/${slot.id}/assign`,
      headers: { cookie },
      payload: { machineId: machine.id },
    });
    expect(assignRoute.statusCode).toBe(409);
    // Folgevorgang auch aus dem wieder geöffneten Vorgang MIT Stornozeile – genau einer.
    const created = await followUp(cookie, world.processId);
    expect(created.statusCode).toBe(200);
    expect(created.json().processId).not.toBe(world.processId);
    const second = await followUp(cookie, world.processId);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('FOLLOW_UP_EXISTS');
    const relationsAfter = await detail(cookie, world.processId);
    expect(relationsAfter.relations).toMatchObject({
      followUpProcess: { id: created.json().processId },
    });
    const shownAfter = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${world.processId}/cancellation`,
      headers: { cookie },
    });
    expect(shownAfter.json().permissions.canCreateFollowUp).toBe(false);
    // Ein wieder geöffneter Vorgang OHNE Stornozeile (Legacy-Storno ohne Buchung) bleibt ausgeschlossen.
    const customer = await createTestCustomer(ctx, admin.id);
    const bare = await processServiceFor(ctx).createProcess(admin.id, { customerId: customer.id });
    await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${bare.id}/cancel`,
      headers: { cookie },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${bare.id}/reopen`,
      headers: { cookie },
    });
    expect((await followUp(cookie, bare.id)).statusCode).toBe(409);
  });

  it('§63 Reopen bei ausstehender Stornogebühr: Gebühr bleibt geschuldet – Worker/manuell übertragen trotzdem genau einmal', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    const view = await cancelBooking(ctx, admin.id, world.processId);
    expect(view.financeStatus).toBe('accounting_pending');
    const reopen = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/reopen`,
      headers: { cookie },
    });
    expect(reopen.statusCode).toBe(200);
    const before = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${world.processId}/cancellation`,
      headers: { cookie },
    });
    expect(before.json().permissions.canManualTransfer).toBe(true);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    expect(ctx.accounting.calls).toHaveLength(1);
    const stored = (
      await ctx.db.select().from(cancellations).where(eq(cancellations.id, view.id))
    )[0]!;
    expect(stored.financeStatus).toBe('invoice_open');
    expect(stored.accountingReference).toMatch(/^MOCK-STORNO-/);
    const manual = await ctx.app.inject({
      method: 'POST',
      url: `/staff/cancellations/${view.id}/transfer`,
      headers: { cookie },
      payload: {},
    });
    expect(manual.statusCode).toBe(200);
    expect(manual.json().outcome).toBe('already_succeeded');
    expect(ctx.accounting.calls).toHaveLength(1);
    // Nach Reopen: Stornobestätigung wird nicht mehr versendet.
    const confirmation = await ctx.app.inject({
      method: 'POST',
      url: `/staff/cancellations/${view.id}/confirmation/send`,
      headers: { cookie },
      payload: {},
    });
    expect(confirmation.statusCode).toBe(409);
    expect((await ctx.db.select().from(cancellations))[0]!.confirmationStatus).toBe('prepared');
    const after = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${world.processId}/cancellation`,
      headers: { cookie },
    });
    expect(after.json().permissions.canSendConfirmation).toBe(false);
  });
});
