/**
 * Phase-6-Pflichttests 20–30 (Order §61): Vorbereitung/Reserviert und
 * deduplizierte Risiko-Incidents inkl. 6-Stunden-Follow-up-Grundlage.
 */
import { machineRiskIncidents } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
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
import { truncateCrmTables } from './crm-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { truncateSchedulingTables } from './scheduling-helpers.ts';
import { machineByCode, resetWarehouse } from './warehouse-helpers.ts';
import {
  DAYS,
  HOURS,
  handoverServicesFor,
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

async function assignedSlot(adminId: string, effective: ReadonlySet<string>, code = 'MR-10-01-01') {
  const services = handoverServicesFor(ctx);
  const world = await scheduledBooking(ctx, adminId, {
    from: new Date(Date.now() + 5 * DAYS),
    to: new Date(Date.now() + 7 * DAYS),
  });
  await services.handover.ensureForBooking(world.bookingId, adminId);
  const slot = (await services.assignments.slotsForBooking(world.bookingId))[0]!;
  const machine = await machineByCode(ctx.db, code);
  await services.assignments.assign(adminId, effective, slot.id, machine.id, null);
  return { services, world, slot, machine };
}

describe('20.–22. Vorbereitung und Reserviert', () => {
  it('20. Eine Zuweisung allein setzt die Maschine NICHT auf Reserviert', async () => {
    const { admin, effective } = await adminSession();
    const { machine } = await assignedSlot(admin.id, effective);
    expect((await machineByCode(ctx.db, machine.machineCode)).status).toBe('ready');
  });

  it('21. „Vorbereitet“ setzt die Maschine auf Reserviert – nur über den Fachprozess', async () => {
    const { admin, effective, cookie } = await adminSession();
    const { services, world, slot, machine } = await assignedSlot(admin.id, effective);
    const view = await services.assignments.prepare(admin.id, slot.id);
    expect(view.status).toBe('prepared');
    expect((await machineByCode(ctx.db, machine.machineCode)).status).toBe('reserved');
    // Manuell bleibt Reserviert weiterhin verboten (Phase-5-Regel).
    const manual = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/status`,
      headers: { cookie },
      payload: { status: 'reserved' },
    });
    expect(manual.statusCode).toBe(400);
    void world;
  });

  it('22. Vorbereitung lösen setzt den Status sauber zurück', async () => {
    const { admin, effective } = await adminSession();
    const { services, slot, machine } = await assignedSlot(admin.id, effective);
    await services.assignments.prepare(admin.id, slot.id);
    await services.assignments.unprepare(admin.id, slot.id);
    expect((await machineByCode(ctx.db, machine.machineCode)).status).toBe('ready');
    await services.assignments.prepare(admin.id, slot.id);
    const released = await services.assignments.release(admin.id, slot.id);
    expect(released.status).toBe('open');
    expect((await machineByCode(ctx.db, machine.machineCode)).status).toBe('ready');
  });
});

describe('23.–28. Risiko-Incidents', () => {
  it('23./26./27. Späterer Problemstatus erzeugt genau EINEN Incident; behoben → automatisch gelöst', async () => {
    const { admin, effective } = await adminSession();
    const { services, machine, slot } = await assignedSlot(admin.id, effective);
    expect(await services.assignments.listOpenIncidents()).toHaveLength(0);
    await services.machineService.setStatus(machine.id, 'repair');
    let open = await services.assignments.listOpenIncidents();
    expect(open).toHaveLength(1);
    expect(open[0]!.reasonKind).toBe('status');
    expect(open[0]!.assignmentId).toBe(slot.id);
    // Dedupliziert: wiederholte Bewertung erzeugt keinen zweiten Incident.
    await services.assignments.refreshRiskIncidents();
    await services.assignments.refreshRiskIncidents();
    open = await services.assignments.listOpenIncidents();
    expect(open).toHaveLength(1);
    // Behoben → resolved (auto).
    await services.machineService.setStatus(machine.id, 'ready');
    expect(await services.assignments.listOpenIncidents()).toHaveLength(0);
    const rows = await ctx.db
      .select()
      .from(machineRiskIncidents)
      .where(eq(machineRiskIncidents.machineId, machine.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolvedAt).not.toBeNull();
    expect(rows[0]!.resolution).toBe('auto');
  });

  it('24./25. Relevante Sperre erzeugt einen Incident, irrelevante außerhalb des Mietzeitraums nicht', async () => {
    const { admin, effective } = await adminSession();
    const { services, machine } = await assignedSlot(admin.id, effective);
    await services.machineService.createBlock(machine.id, admin.id, {
      startsAt: new Date(Date.now() + 30 * DAYS),
      endsAt: new Date(Date.now() + 31 * DAYS),
      reason: 'Weit entfernt',
    });
    expect(await services.assignments.listOpenIncidents()).toHaveLength(0);
    await services.machineService.createBlock(machine.id, admin.id, {
      startsAt: new Date(Date.now() + 5 * DAYS + 2 * HOURS),
      endsAt: new Date(Date.now() + 5 * DAYS + 6 * HOURS),
      reason: 'Im Mietzeitraum',
    });
    const open = await services.assignments.listOpenIncidents();
    expect(open).toHaveLength(1);
    expect(open[0]!.reasonKind).toBe('block');
    expect(open[0]!.reasonText).toContain('Im Mietzeitraum');
  });

  it('28. Admin „Geprüft“ löst den Incident ohne Pflichtgrund', async () => {
    const { admin, effective, cookie } = await adminSession();
    const { services, machine } = await assignedSlot(admin.id, effective);
    await services.machineService.setStatus(machine.id, 'out_of_service');
    const open = await services.assignments.listOpenIncidents();
    expect(open).toHaveLength(1);
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machine-risk-incidents/${open[0]!.id}/acknowledge`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(await services.assignments.listOpenIncidents()).toHaveLength(0);
    const rows = await ctx.db
      .select()
      .from(machineRiskIncidents)
      .where(eq(machineRiskIncidents.id, open[0]!.id));
    expect(rows[0]!.resolution).toBe('acknowledged');
    expect(rows[0]!.resolvedBy).toBe(admin.id);
  });
});

describe('29.–30. Follow-up nach 6 Stunden', () => {
  it('29./30. Vor 6 h kein Follow-up, danach genau EINES – nie ein zweites', async () => {
    const { admin, effective } = await adminSession();
    const { services, machine } = await assignedSlot(admin.id, effective);
    await services.machineService.setStatus(machine.id, 'repair');
    const open = await services.assignments.listOpenIncidents();
    const incident = open[0]!;
    const notifiedAt = new Date();
    expect(
      (await services.assignments.listDueAdminNotifications(notifiedAt)).map((r) => r.id),
    ).toContain(incident.id);
    await services.assignments.markAdminNotified(incident.id, notifiedAt);
    expect(
      await services.assignments.listDueFollowUps(new Date(notifiedAt.getTime() + 5 * HOURS)),
    ).toHaveLength(0);
    const due = await services.assignments.listDueFollowUps(
      new Date(notifiedAt.getTime() + 6 * HOURS),
    );
    expect(due.map((r) => r.id)).toEqual([incident.id]);
    await services.assignments.markFollowUpSent(
      incident.id,
      new Date(notifiedAt.getTime() + 6 * HOURS),
    );
    expect(
      await services.assignments.listDueFollowUps(new Date(notifiedAt.getTime() + 7 * HOURS)),
    ).toHaveLength(0);
    expect(
      await services.assignments.listDueFollowUps(new Date(notifiedAt.getTime() + 30 * HOURS)),
    ).toHaveLength(0);
    // Ein gelöster Incident ist nie mehr fällig.
    await services.machineService.setStatus(machine.id, 'ready');
    await services.assignments.refreshRiskIncidents();
    expect(
      await services.assignments.listDueAdminNotifications(
        new Date(notifiedAt.getTime() + 40 * HOURS),
      ),
    ).toHaveLength(0);
  });
});
