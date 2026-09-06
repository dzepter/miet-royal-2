/**
 * Phase-6-Pflichttests 1–19 (Order §60): Assignment-Slots, bewusste
 * Zuweisung, Typprüfung, Kollisionen, Override (Recht + Grund), harter
 * Block für ausgegebene Maschinen, Präferenz/Fallback, Wechsel, Races.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createTestContext,
  destroyTestContext,
  login,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import {
  adminVisibilityCtx,
  createStaffWithPermissions,
  processServiceFor,
  truncateCrmTables,
} from './crm-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { schedulingServiceFor, truncateSchedulingTables } from './scheduling-helpers.ts';
import { appointments } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { machineByCode, resetWarehouse } from './warehouse-helpers.ts';
import {
  DAYS,
  handoverServicesFor,
  initializeAllInventory,
  readyHandover,
  scheduledBooking,
  truncateHandoverTables,
} from './handover-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateHandoverTables(ctx.pool);
  await resetWarehouse(ctx.pool);
  await truncateSchedulingTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
});

async function adminSession() {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  const effective = await ctx.auth.effectivePermissions(admin.id);
  return { admin, cookie: session.cookie, effective };
}

describe('1.–5. Slots und Zuweisung', () => {
  it('1./2. Bestätigte Buchung erzeugt exakt so viele Slots wie Maschinen – ohne automatische Maschine', async () => {
    const { admin } = await adminSession();
    const { assignments, handover } = handoverServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id, { machineQuantity: 2 });
    await handover.ensureForBooking(world.bookingId, admin.id);
    await handover.ensureForBooking(world.bookingId, admin.id); // idempotent
    const slots = await assignments.slotsForBooking(world.bookingId);
    expect(slots).toHaveLength(2);
    expect(slots.map((slot) => slot.slotNo)).toEqual([1, 2]);
    expect(slots.every((slot) => slot.status === 'open' && slot.machine === null)).toBe(true);
    // Vorschlag existiert, weist aber NICHT zu.
    const suggestion = await assignments.suggestionForSlot(slots[0]!.id);
    expect(suggestion.entries.some((entry) => entry.preferred)).toBe(true);
    expect((await assignments.slotsForBooking(world.bookingId))[0]!.machine).toBeNull();
  });

  it('3./4. Geeignete Maschinen werden je Slot einzeln zugewiesen', async () => {
    const { admin, effective } = await adminSession();
    const { assignments, handover } = handoverServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id, { machineQuantity: 2 });
    await handover.ensureForBooking(world.bookingId, admin.id);
    const slots = await assignments.slotsForBooking(world.bookingId);
    const first = await machineByCode(ctx.db, 'MR-10-01-01');
    const second = await machineByCode(ctx.db, 'MR-10-01-02');
    const a = await assignments.assign(admin.id, effective, slots[0]!.id, first.id, null);
    const b = await assignments.assign(admin.id, effective, slots[1]!.id, second.id, null);
    expect(a.status).toBe('assigned');
    expect(a.machine?.machineCode).toBe('MR-10-01-01');
    expect(b.machine?.machineCode).toBe('MR-10-01-02');
    const rows = await ctx.pool.query(
      `SELECT machine_id FROM machine_assignments WHERE booking_id = $1 ORDER BY slot_no`,
      [world.bookingId],
    );
    expect(rows.rows.map((row) => row.machine_id)).toEqual([first.id, second.id]);
  });

  it('5. Eine Maschine des falschen Typs wird abgelehnt', async () => {
    const { admin, effective } = await adminSession();
    const { assignments, handover } = handoverServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id, { machineSlug: 'slush-1x10' });
    await handover.ensureForBooking(world.bookingId, admin.id);
    const slot = (await assignments.slotsForBooking(world.bookingId))[0]!;
    const wrong = await machineByCode(ctx.db, 'MR-08-02-01');
    await expect(
      assignments.assign(admin.id, effective, slot.id, wrong.id, null),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });
});

describe('6.–10. Kollision & Override', () => {
  it('6./7. Überlappende Zuweisung derselben Maschine erzeugt eine starke Warnung und ist ohne Override nicht möglich', async () => {
    const { admin, effective } = await adminSession();
    const { assignments, handover } = handoverServicesFor(ctx);
    const from = new Date(Date.now() + 2 * DAYS);
    const to = new Date(Date.now() + 4 * DAYS);
    const a = await scheduledBooking(ctx, admin.id, { from, to });
    const b = await scheduledBooking(ctx, admin.id, {
      from: new Date(from.getTime() + 6 * 3_600_000),
      to: new Date(to.getTime() + 6 * 3_600_000),
    });
    await handover.ensureForBooking(a.bookingId, admin.id);
    await handover.ensureForBooking(b.bookingId, admin.id);
    const machine = await machineByCode(ctx.db, 'MR-10-01-03');
    const slotA = (await assignments.slotsForBooking(a.bookingId))[0]!;
    const slotB = (await assignments.slotsForBooking(b.bookingId))[0]!;
    await assignments.assign(admin.id, effective, slotA.id, machine.id, null);
    const evaluation = await assignments.evaluateMachine(machine.id, {
      ...(await assignments.assignmentById(slotB.id)),
    });
    expect(evaluation.overrideRequired).toBe(true);
    expect(evaluation.hardBlocked).toBe(false);
    const collision = evaluation.problems.find((p) => p.code === 'collision');
    expect(collision?.otherBookingId).toBe(a.bookingId);
    expect(collision?.otherProcessNumber).toMatch(/^MR-\d{4}-\d{4}$/);
    await expect(
      assignments.assign(admin.id, effective, slotB.id, machine.id, null),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await assignments.slotsForBooking(b.bookingId))[0]!.machine).toBeNull();
  });

  it('8./9. Kollision ist mit bewusstem Override + Grund möglich; ohne Grund abgelehnt', async () => {
    const { admin, effective } = await adminSession();
    const { assignments, handover } = handoverServicesFor(ctx);
    const a = await scheduledBooking(ctx, admin.id);
    const b = await scheduledBooking(ctx, admin.id);
    await handover.ensureForBooking(a.bookingId, admin.id);
    await handover.ensureForBooking(b.bookingId, admin.id);
    const machine = await machineByCode(ctx.db, 'MR-10-01-03');
    const slotA = (await assignments.slotsForBooking(a.bookingId))[0]!;
    const slotB = (await assignments.slotsForBooking(b.bookingId))[0]!;
    await assignments.assign(admin.id, effective, slotA.id, machine.id, null);
    await expect(
      assignments.assign(admin.id, effective, slotB.id, machine.id, { reason: '   ' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const view = await assignments.assign(admin.id, effective, slotB.id, machine.id, {
      reason: 'Kunde A holt früher ab, abgesprochen.',
    });
    expect(view.status).toBe('assigned');
    expect(view.override?.reason).toContain('früher');
    expect(view.override?.confirmedByName).toBeTruthy();
    const overrides = await assignments.listOverrides();
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.machineCode).toBe('MR-10-01-03');
  });

  it('10. Override ohne Recht wird abgelehnt (403), Zuweisung ohne Problem bleibt möglich', async () => {
    const { admin } = await adminSession();
    const { assignments, handover, machineService } = handoverServicesFor(ctx);
    const staff = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Anton',
      lastName: 'Assign',
      email: 'anton.assign@test.example',
      password: 'anton-passwort-1234',
      permissionKeys: ['process.view_all', 'machine.assign', 'handover.view'],
    });
    const world = await scheduledBooking(ctx, admin.id);
    await handover.ensureForBooking(world.bookingId, admin.id);
    const slot = (await assignments.slotsForBooking(world.bookingId))[0]!;
    const repair = await machineByCode(ctx.db, 'MR-10-01-04');
    await machineService.setStatus(repair.id, 'repair');
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/staff/handover/${world.bookingId}/slots/${slot.id}/assign`,
      headers: { cookie: staff.cookie },
      payload: { machineId: repair.id, override: { confirmed: true, reason: 'Trotzdem' } },
    });
    expect(denied.statusCode).toBe(403);
    const fine = await machineByCode(ctx.db, 'MR-10-01-05');
    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/staff/handover/${world.bookingId}/slots/${slot.id}/assign`,
      headers: { cookie: staff.cookie },
      payload: { machineId: fine.id },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().slot.machine.machineCode).toBe('MR-10-01-05');
  });
});

describe('11.–15. Problemmaschinen', () => {
  for (const status of ['repair', 'out_of_service', 'cleaning'] as const) {
    it(`11./12./14. Maschine im Status ${status} verlangt einen Override`, async () => {
      const { admin, effective } = await adminSession();
      const { assignments, handover, machineService } = handoverServicesFor(ctx);
      const world = await scheduledBooking(ctx, admin.id);
      await handover.ensureForBooking(world.bookingId, admin.id);
      const slot = (await assignments.slotsForBooking(world.bookingId))[0]!;
      const machine = await machineByCode(ctx.db, 'MR-10-01-06');
      await machineService.setStatus(machine.id, status);
      const evaluation = await assignments.evaluateMachine(
        machine.id,
        await assignments.assignmentById(slot.id),
      );
      expect(evaluation.overrideRequired).toBe(true);
      expect(evaluation.problems.map((p) => p.code)).toContain(`status_${status}`);
      await expect(
        assignments.assign(admin.id, effective, slot.id, machine.id, null),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      const view = await assignments.assign(admin.id, effective, slot.id, machine.id, {
        reason: 'Bewusst gewählt.',
      });
      expect(view.override).not.toBeNull();
    });
  }

  it('13. Eine aktive Sperre im Mietzeitraum verlangt einen Override; außerhalb nicht', async () => {
    const { admin, effective } = await adminSession();
    const { assignments, handover, machineService } = handoverServicesFor(ctx);
    const from = new Date(Date.now() + 5 * DAYS);
    const to = new Date(Date.now() + 7 * DAYS);
    const world = await scheduledBooking(ctx, admin.id, { from, to });
    await handover.ensureForBooking(world.bookingId, admin.id);
    const slot = (await assignments.slotsForBooking(world.bookingId))[0]!;
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    // Sperre außerhalb des Mietzeitraums: kein Override nötig.
    await machineService.createBlock(machine.id, admin.id, {
      startsAt: new Date(Date.now() + 20 * DAYS),
      endsAt: new Date(Date.now() + 21 * DAYS),
      reason: 'Späte Wartung',
    });
    let evaluation = await assignments.evaluateMachine(
      machine.id,
      await assignments.assignmentById(slot.id),
    );
    expect(evaluation.overrideRequired).toBe(false);
    // Sperre im Mietzeitraum: Override.
    await machineService.createBlock(machine.id, admin.id, {
      startsAt: new Date(from.getTime() + 3_600_000),
      endsAt: new Date(from.getTime() + 5 * 3_600_000),
      reason: 'Interne Nutzung',
    });
    evaluation = await assignments.evaluateMachine(
      machine.id,
      await assignments.assignmentById(slot.id),
    );
    expect(evaluation.overrideRequired).toBe(true);
    expect(evaluation.problems.find((p) => p.code === 'blocked')?.detail).toContain(
      'Interne Nutzung',
    );
    await expect(
      assignments.assign(admin.id, effective, slot.id, machine.id, null),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('15. Eine aktuell an einen anderen Vorgang ausgegebene Maschine kann NICHT erneut zugeordnet werden – auch nicht mit Override', async () => {
    const { admin, effective } = await adminSession();
    const { assignments, handover } = handoverServicesFor(ctx);
    await initializeAllInventory(ctx, admin.id);
    const first = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 1 * DAYS),
      to: new Date(Date.now() + 2 * DAYS),
    });
    await readyHandover(ctx, admin.id, first.bookingId, ['MR-10-01-01']);
    await handover.finalize(admin.id, first.bookingId);
    const second = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 10 * DAYS),
      to: new Date(Date.now() + 11 * DAYS),
    });
    await handover.ensureForBooking(second.bookingId, admin.id);
    const slot = (await assignments.slotsForBooking(second.bookingId))[0]!;
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    const evaluation = await assignments.evaluateMachine(
      machine.id,
      await assignments.assignmentById(slot.id),
    );
    expect(evaluation.hardBlocked).toBe(true);
    expect(evaluation.overrideRequired).toBe(false);
    await expect(
      assignments.assign(admin.id, effective, slot.id, machine.id, { reason: 'Versuch' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await assignments.slotsForBooking(second.bookingId))[0]!.machine).toBeNull();
  });
});

describe('16.–19. Präferenz, Wechsel, Races', () => {
  it('16./17. Ältestes bekanntes Kaufdatum bevorzugt; ohne Daten deterministischer Fallback', async () => {
    const { admin } = await adminSession();
    const { assignments, handover, machineService } = handoverServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id);
    await handover.ensureForBooking(world.bookingId, admin.id);
    const slot = (await assignments.slotsForBooking(world.bookingId))[0]!;
    let suggestion = await assignments.suggestionForSlot(slot.id);
    expect(suggestion.entries.find((entry) => entry.preferred)?.machineCode).toBe('MR-10-01-01');
    expect(suggestion.preferredBasis).toContain('Kaufdatum unbekannt');
    const oldest = await machineByCode(ctx.db, 'MR-10-01-05');
    await machineService.updateMasterData(oldest.id, { purchaseDate: '2019-03-01' });
    const newer = await machineByCode(ctx.db, 'MR-10-01-01');
    await machineService.updateMasterData(newer.id, { purchaseDate: '2024-01-01' });
    suggestion = await assignments.suggestionForSlot(slot.id);
    expect(suggestion.entries.find((entry) => entry.preferred)?.machineCode).toBe('MR-10-01-05');
    expect(suggestion.preferredBasis).toBe('Ältestes bekanntes Kaufdatum');
    // Alle geeigneten bleiben wählbar (keine automatische Zuweisung).
    expect(
      suggestion.entries.filter((entry) => entry.eligibility === 'eligible').length,
    ).toBeGreaterThan(1);
  });

  it('18. Zuordnung kann vor der Ausgabe gewechselt und gelöst werden', async () => {
    const { admin, effective } = await adminSession();
    const { assignments, handover } = handoverServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id);
    await handover.ensureForBooking(world.bookingId, admin.id);
    const slot = (await assignments.slotsForBooking(world.bookingId))[0]!;
    const m1 = await machineByCode(ctx.db, 'MR-10-01-01');
    const m2 = await machineByCode(ctx.db, 'MR-10-01-02');
    await assignments.assign(admin.id, effective, slot.id, m1.id, null);
    const switched = await assignments.assign(admin.id, effective, slot.id, m2.id, null);
    expect(switched.machine?.machineCode).toBe('MR-10-01-02');
    const released = await assignments.release(admin.id, slot.id);
    expect(released.status).toBe('open');
    expect(released.machine).toBeNull();
  });

  it('19. Parallele Zuweisungen derselben Maschine erzeugen keine stille Doppelbelegung', async () => {
    const { admin, effective } = await adminSession();
    const { assignments, handover } = handoverServicesFor(ctx);
    const a = await scheduledBooking(ctx, admin.id);
    const b = await scheduledBooking(ctx, admin.id);
    await handover.ensureForBooking(a.bookingId, admin.id);
    await handover.ensureForBooking(b.bookingId, admin.id);
    const machine = await machineByCode(ctx.db, 'MR-10-01-02');
    const slotA = (await assignments.slotsForBooking(a.bookingId))[0]!;
    const slotB = (await assignments.slotsForBooking(b.bookingId))[0]!;
    const results = await Promise.allSettled([
      assignments.assign(admin.id, effective, slotA.id, machine.id, null),
      assignments.assign(admin.id, effective, slotB.id, machine.id, null),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'CONFLICT' });
    const rows = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM machine_assignments WHERE machine_id = $1 AND status <> 'open'`,
      [machine.id],
    );
    expect(rows.rows[0].n).toBe(1);
  });
});

describe('R. Review-Regressionen (Zuweisung)', () => {
  it('R3. Terminverschiebung wirkt sofort auf die Kollisionsprüfung (kein eingefrorener Mietzeitraum)', async () => {
    const { admin, effective } = await adminSession();
    const { assignments, handover } = handoverServicesFor(ctx);
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    // Buchung X: +1d..+3d, Maschine zugewiesen (Intervall gespiegelt).
    const x = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 1 * DAYS),
      to: new Date(Date.now() + 3 * DAYS),
    });
    await handover.ensureForBooking(x.bookingId, admin.id);
    const slotX = (await assignments.slotsForBooking(x.bookingId))[0]!;
    await assignments.assign(admin.id, effective, slotX.id, machine.id, null);
    // Rückgabe von X wird auf +10d verschoben (Phase-4-Reschedule).
    const scheduling = schedulingServiceFor(ctx);
    const returnRow = (
      await ctx.db.select().from(appointments).where(eq(appointments.id, x.returnAppointmentId))
    )[0]!;
    await scheduling.reschedule(admin.id, x.returnAppointmentId, {
      startAt: new Date(Date.now() + 10 * DAYS),
      endAt: null,
      expectedVersion: returnRow.version,
    });
    // Buchung Y: +5d..+6d – kollidiert NUR mit dem verschobenen Zeitraum.
    const y = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 5 * DAYS),
      to: new Date(Date.now() + 6 * DAYS),
    });
    await handover.ensureForBooking(y.bookingId, admin.id);
    const slotY = (await assignments.slotsForBooking(y.bookingId))[0]!;
    const evaluation = await assignments.evaluateMachine(
      machine.id,
      await assignments.assignmentById(slotY.id),
    );
    expect(evaluation.problems.some((p) => p.code === 'collision')).toBe(true);
    expect(evaluation.overrideRequired).toBe(true);
    await expect(
      assignments.assign(admin.id, effective, slotY.id, machine.id, null),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('R4. Dieselbe Maschine kann nicht zwei Slots derselben Buchung besetzen – auch nicht per Override', async () => {
    const { admin, effective } = await adminSession();
    const { assignments, handover } = handoverServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id, { machineQuantity: 2 });
    await handover.ensureForBooking(world.bookingId, admin.id);
    const slots = await assignments.slotsForBooking(world.bookingId);
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    await assignments.assign(admin.id, effective, slots[0]!.id, machine.id, null);
    await expect(
      assignments.assign(admin.id, effective, slots[1]!.id, machine.id, {
        reason: 'Versuch der Doppelbelegung',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const after = await assignments.slotsForBooking(world.bookingId);
    expect(after[1]!.machine).toBeNull();
  });

  it('R5. Storno des Vorgangs löst Zuordnungen systemseitig: Reserviert zurück, keine Phantom-Kollision', async () => {
    const { admin, effective } = await adminSession();
    const { assignments, handover } = handoverServicesFor(ctx);
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    const x = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 1 * DAYS),
      to: new Date(Date.now() + 3 * DAYS),
    });
    await handover.ensureForBooking(x.bookingId, admin.id);
    const slotX = (await assignments.slotsForBooking(x.bookingId))[0]!;
    await assignments.assign(admin.id, effective, slotX.id, machine.id, null);
    await assignments.prepare(admin.id, slotX.id);
    expect((await machineByCode(ctx.db, 'MR-10-01-01')).status).toBe('reserved');
    await processServiceFor(ctx).cancel(x.processId, adminVisibilityCtx());
    // Buchung Y im selben Zeitraum: keine Kollision mit dem stornierten Vorgang.
    const y = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 1 * DAYS),
      to: new Date(Date.now() + 3 * DAYS),
    });
    await handover.ensureForBooking(y.bookingId, admin.id);
    const slotY = (await assignments.slotsForBooking(y.bookingId))[0]!;
    const evaluation = await assignments.evaluateMachine(
      machine.id,
      await assignments.assignmentById(slotY.id),
    );
    expect(evaluation.problems.some((p) => p.code === 'collision')).toBe(false);
    await assignments.refreshRiskIncidents();
    const released = (await assignments.slotsForBooking(x.bookingId))[0]!;
    expect(released.status).toBe('open');
    expect(released.machine).toBeNull();
    expect((await machineByCode(ctx.db, 'MR-10-01-01')).status).toBe('ready');
    expect(await assignments.listOpenIncidents()).toEqual([]);
  });

  it('R7. Ersetzte oder gelöste Overrides verschwinden aus der aktiven Admin-Liste', async () => {
    const { admin, effective } = await adminSession();
    const { assignments, handover, machineService } = handoverServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id);
    await handover.ensureForBooking(world.bookingId, admin.id);
    const slot = (await assignments.slotsForBooking(world.bookingId))[0]!;
    const cleaning = await machineByCode(ctx.db, 'MR-10-01-02');
    await machineService.setStatus(cleaning.id, 'cleaning');
    await assignments.assign(admin.id, effective, slot.id, cleaning.id, {
      reason: 'Reinigung ist bis zur Abholung erledigt',
    });
    expect(await assignments.listOverrides()).toHaveLength(1);
    const other = await machineByCode(ctx.db, 'MR-10-01-03');
    await assignments.assign(admin.id, effective, slot.id, other.id, null);
    expect(await assignments.listOverrides()).toHaveLength(0);
    await assignments.assign(admin.id, effective, slot.id, cleaning.id, {
      reason: 'Doch die gereinigte Maschine',
    });
    expect(await assignments.listOverrides()).toHaveLength(1);
    await assignments.release(admin.id, slot.id);
    expect(await assignments.listOverrides()).toHaveLength(0);
  });

  it('R8. Sperre vor einem bekannten Beginn ohne Rückgabe-Ende verlangt keinen Override; ohne Beginn nur Warnung', async () => {
    const { admin } = await adminSession();
    const { assignments, handover, machineService } = handoverServicesFor(ctx);
    const scheduling = schedulingServiceFor(ctx);
    const from = new Date(Date.now() + 10 * DAYS);
    const world = await scheduledBooking(ctx, admin.id, {
      from,
      to: new Date(Date.now() + 12 * DAYS),
    });
    await handover.ensureForBooking(world.bookingId, admin.id);
    const slot = (await assignments.slotsForBooking(world.bookingId))[0]!;
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    await machineService.createBlock(machine.id, admin.id, {
      startsAt: new Date(Date.now() + 2 * DAYS),
      endsAt: new Date(Date.now() + 3 * DAYS),
      reason: 'Frühe Wartung',
    });
    // Rückgabe-Ende unbekannt → Sperre endet vor dem Beginn → irrelevant.
    const returnRow = (
      await ctx.db.select().from(appointments).where(eq(appointments.id, world.returnAppointmentId))
    )[0]!;
    await scheduling.reschedule(admin.id, world.returnAppointmentId, {
      startAt: null,
      endAt: null,
      expectedVersion: returnRow.version,
    });
    let evaluation = await assignments.evaluateMachine(
      machine.id,
      await assignments.assignmentById(slot.id),
    );
    expect(evaluation.problems.some((p) => p.code === 'blocked')).toBe(false);
    expect(evaluation.overrideRequired).toBe(false);
    // Auch der Beginn unbekannt → Überlappung nicht bestimmbar → nur Warnung.
    const outboundRow = (
      await ctx.db
        .select()
        .from(appointments)
        .where(eq(appointments.id, world.outboundAppointmentId))
    )[0]!;
    await scheduling.reschedule(admin.id, world.outboundAppointmentId, {
      startAt: null,
      endAt: null,
      expectedVersion: outboundRow.version,
    });
    evaluation = await assignments.evaluateMachine(
      machine.id,
      await assignments.assignmentById(slot.id),
    );
    const blocked = evaluation.problems.find((p) => p.code === 'blocked');
    expect(blocked?.warningOnly).toBe(true);
    expect(evaluation.overrideRequired).toBe(false);
  });

  it('R9. „Bevorzugt“ ist nie eine Maschine mit Override-Pflicht; Reihenfolge bleibt deterministisch', async () => {
    const { admin, effective } = await adminSession();
    const { assignments, handover } = handoverServicesFor(ctx);
    const from = new Date(Date.now() + 1 * DAYS);
    const to = new Date(Date.now() + 3 * DAYS);
    const first = await scheduledBooking(ctx, admin.id, { from, to });
    await handover.ensureForBooking(first.bookingId, admin.id);
    const slotFirst = (await assignments.slotsForBooking(first.bookingId))[0]!;
    const oldest = await machineByCode(ctx.db, 'MR-10-01-01');
    await assignments.assign(admin.id, effective, slotFirst.id, oldest.id, null);
    const second = await scheduledBooking(ctx, admin.id, { from, to });
    await handover.ensureForBooking(second.bookingId, admin.id);
    const slotSecond = (await assignments.slotsForBooking(second.bookingId))[0]!;
    const suggestion = await assignments.suggestionForSlot(slotSecond.id);
    const preferred = suggestion.entries.find((entry) => entry.preferred);
    expect(preferred?.machineCode).toBe('MR-10-01-02');
    expect(preferred?.overrideRequired).toBe(false);
    expect(suggestion.preferredBasis).toContain('nächste Maschine ohne Konflikt');
    const collided = suggestion.entries.find((entry) => entry.machineCode === 'MR-10-01-01');
    expect(collided?.overrideRequired).toBe(true);
    expect(collided?.preferred).toBe(false);
    // Override-pflichtige Einträge stehen hinter den wählbaren.
    const codes = suggestion.entries.map((entry) => entry.machineCode);
    expect(codes.indexOf('MR-10-01-01')).toBeGreaterThan(codes.indexOf('MR-10-01-06'));
  });
});

describe('R12. Vorgangsstatus und ephemere Daten', () => {
  it('R12. Abgeschlossene Vorgänge sind gesperrt; Abschluss mit aktiven Zuordnungen wird verweigert; Storno löscht Telefonnummern', async () => {
    const { admin, effective } = await adminSession();
    const { assignments, handover } = handoverServicesFor(ctx);
    const processService = processServiceFor(ctx);
    const world = await scheduledBooking(ctx, admin.id);
    await handover.ensureForBooking(world.bookingId, admin.id);
    const slot = (await assignments.slotsForBooking(world.bookingId))[0]!;
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    await assignments.assign(admin.id, effective, slot.id, machine.id, null);
    await expect(
      processService.complete(world.processId, adminVisibilityCtx()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await assignments.release(admin.id, slot.id);
    await processService.complete(world.processId, adminVisibilityCtx());
    await expect(
      assignments.assign(admin.id, effective, slot.id, machine.id, null),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await handover.detail(world.bookingId)).blockers).toContain(
      'Der Vorgang ist bereits abgeschlossen – bitte zuerst wieder öffnen.',
    );
    // Storno eines anderen Vorgangs löscht die ephemeren Telefonnummern.
    const other = await scheduledBooking(ctx, admin.id);
    await handover.setRepresentative(admin.id, other.bookingId, {
      firstName: 'Anna',
      lastName: 'Abholung',
      phone: '+49 6131 12345',
    });
    await handover.setRecipient(other.bookingId, {
      kind: 'other',
      name: 'Vertreter V',
      phone: '+49 6131 99999',
    });
    await processService.cancel(other.processId, adminVisibilityCtx());
    const detail = await handover.detail(other.bookingId);
    expect(detail.representative?.phone).toBeNull();
    expect(detail.representative?.firstName).toBe('Anna');
    expect(detail.handover.recipientPhone).toBeNull();
    expect(detail.handover.recipientName).toBe('Vertreter V');
  });
});
