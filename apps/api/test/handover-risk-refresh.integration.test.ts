/**
 * Phase-6-Finalisierung A2 (Order-Tests 7–11, Pflichttest 120): Zeit-
 * änderungen an Abhol-/Liefer-/Rückgabeterminen bewerten die Risikohinweise
 * SOFORT neu – über die Listener-Schnittstelle der Terminplanung (keine
 * zyklische Abhängigkeit Scheduling ↔ Handover). Veraltete Incidents werden
 * gelöst, neue (Sperre/Status/Kollision) angelegt, Duplikate verhindert.
 * Die Prüfungen lesen die Incident-Tabelle DIREKT (kein Lazy-Refresh).
 */
import { appointments, machineRiskIncidents } from '@mietroyal/database';
import { eq, isNull } from 'drizzle-orm';
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
  type HandoverServices,
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

async function openIncidents() {
  return ctx.db.select().from(machineRiskIncidents).where(isNull(machineRiskIncidents.resolvedAt));
}

async function allIncidents() {
  return ctx.db.select().from(machineRiskIncidents);
}

async function appointmentRow(id: string) {
  return (await ctx.db.select().from(appointments).where(eq(appointments.id, id)))[0]!;
}

async function rescheduleTo(
  services: HandoverServices,
  actorId: string,
  id: string,
  startAt: Date,
) {
  const row = await appointmentRow(id);
  await services.scheduling.reschedule(actorId, id, {
    startAt,
    endAt: null,
    expectedVersion: row.version,
  });
}

/** Buchung +1d..+3d mit zugewiesener Maschine MR-10-01-01. */
async function assignedBooking(
  services: HandoverServices,
  adminId: string,
  effective: ReadonlySet<string>,
) {
  const machine = await machineByCode(ctx.db, 'MR-10-01-01');
  const world = await scheduledBooking(ctx, adminId, {
    from: new Date(Date.now() + 1 * DAYS),
    to: new Date(Date.now() + 3 * DAYS),
  });
  await services.handover.ensureForBooking(world.bookingId, adminId);
  const slot = (await services.assignments.slotsForBooking(world.bookingId))[0]!;
  await services.assignments.assign(adminId, effective, slot.id, machine.id, null);
  return { machine, world, slot };
}

describe('A2 – Terminänderung refresht Risikohinweise sofort (Tests 7–11, Pflichttest 120)', () => {
  it('7. Verschiebung in eine Sperre erzeugt sofort einen Incident – über die HTTP-Route, ohne manuellen Refresh', async () => {
    const { admin, effective, cookie } = await adminSession();
    const services = handoverServicesFor(ctx);
    const { machine, world, slot } = await assignedBooking(services, admin.id, effective);
    // Sperre +5d..+6d liegt AUSSERHALB des Mietzeitraums: kein Incident.
    await services.machineService.createBlock(machine.id, admin.id, {
      startsAt: new Date(Date.now() + 5 * DAYS),
      endsAt: new Date(Date.now() + 6 * DAYS),
      reason: 'Wartung',
    });
    await services.assignments.refreshRiskIncidents();
    expect(await openIncidents()).toEqual([]);

    // Rückgabe auf +7d: Mietzeitraum überlappt nun die Sperre.
    const returnRow = await appointmentRow(world.returnAppointmentId);
    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/appointments/${world.returnAppointmentId}/schedule`,
      headers: { cookie },
      payload: {
        startAt: new Date(Date.now() + 7 * DAYS).toISOString(),
        endAt: null,
        expectedVersion: returnRow.version,
      },
    });
    expect(response.statusCode).toBe(200);
    const open = await openIncidents();
    expect(open).toHaveLength(1);
    expect(open[0]!.reasonKind).toBe('block');
    expect(open[0]!.assignmentId).toBe(slot.id);
    expect(open[0]!.machineId).toBe(machine.id);
    expect(open[0]!.reasonText).toContain('Wartung');
  });

  it('8. Verschiebung aus der Sperre heraus löst den Incident automatisch', async () => {
    const { admin, effective } = await adminSession();
    const services = handoverServicesFor(ctx);
    const { machine, world } = await assignedBooking(services, admin.id, effective);
    await services.machineService.createBlock(machine.id, admin.id, {
      startsAt: new Date(Date.now() + 5 * DAYS),
      endsAt: new Date(Date.now() + 6 * DAYS),
      reason: 'Wartung',
    });
    await rescheduleTo(
      services,
      admin.id,
      world.returnAppointmentId,
      new Date(Date.now() + 7 * DAYS),
    );
    expect(await openIncidents()).toHaveLength(1);

    await rescheduleTo(
      services,
      admin.id,
      world.returnAppointmentId,
      new Date(Date.now() + 3 * DAYS),
    );
    expect(await openIncidents()).toEqual([]);
    const all = await allIncidents();
    expect(all).toHaveLength(1);
    expect(all[0]!.resolution).toBe('auto');
    expect(all[0]!.resolvedAt).not.toBeNull();
  });

  it('9. Neue zeitliche Kollision durch Verschiebung wird erkannt – genau ein Kollisions-Incident je Paar', async () => {
    const { admin, effective } = await adminSession();
    const services = handoverServicesFor(ctx);
    const { machine, world: x } = await assignedBooking(services, admin.id, effective);
    // Buchung Y +5d..+6d auf derselben Maschine: (noch) keine Kollision.
    const y = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 5 * DAYS),
      to: new Date(Date.now() + 6 * DAYS),
    });
    await services.handover.ensureForBooking(y.bookingId, admin.id);
    const slotY = (await services.assignments.slotsForBooking(y.bookingId))[0]!;
    await services.assignments.assign(admin.id, effective, slotY.id, machine.id, null);
    await services.assignments.refreshRiskIncidents();
    expect(await openIncidents()).toEqual([]);

    // Rückgabe von X auf +10d: X (+1d..+10d) kollidiert jetzt mit Y (+5d..+6d).
    await rescheduleTo(services, admin.id, x.returnAppointmentId, new Date(Date.now() + 10 * DAYS));
    const open = await openIncidents();
    expect(open).toHaveLength(1);
    expect(open[0]!.reasonKind).toBe('collision');
    // Die Seite mit dem späteren Mietbeginn (Y) trägt den Incident.
    expect(open[0]!.assignmentId).toBe(slotY.id);
    expect(open[0]!.bookingId).toBe(y.bookingId);
    expect(open[0]!.reasonText).toContain('Zeitliche Kollision');
    // Die Risikoliste (mit Lazy-Refresh) liefert denselben einen Incident.
    const listed = await services.assignments.listOpenIncidents();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.reasonKind).toBe('collision');
  });

  it('10. Aufgelöste Kollision: Rückverschiebung löst den Kollisions-Incident automatisch', async () => {
    const { admin, effective } = await adminSession();
    const services = handoverServicesFor(ctx);
    const { machine, world: x } = await assignedBooking(services, admin.id, effective);
    const y = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 5 * DAYS),
      to: new Date(Date.now() + 6 * DAYS),
    });
    await services.handover.ensureForBooking(y.bookingId, admin.id);
    const slotY = (await services.assignments.slotsForBooking(y.bookingId))[0]!;
    await services.assignments.assign(admin.id, effective, slotY.id, machine.id, null);
    await rescheduleTo(services, admin.id, x.returnAppointmentId, new Date(Date.now() + 10 * DAYS));
    expect(await openIncidents()).toHaveLength(1);

    await rescheduleTo(services, admin.id, x.returnAppointmentId, new Date(Date.now() + 3 * DAYS));
    expect(await openIncidents()).toEqual([]);
    const all = await allIncidents();
    expect(all).toHaveLength(1);
    expect(all[0]!.resolution).toBe('auto');
  });

  it('11. Wiederholte Verschiebungen erzeugen keine doppelten Incidents (Sperre und Kollision)', async () => {
    const { admin, effective } = await adminSession();
    const services = handoverServicesFor(ctx);
    const { machine, world: x } = await assignedBooking(services, admin.id, effective);
    await services.machineService.createBlock(machine.id, admin.id, {
      startsAt: new Date(Date.now() + 5 * DAYS),
      endsAt: new Date(Date.now() + 6 * DAYS),
      reason: 'Wartung',
    });
    const y = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 8 * DAYS),
      to: new Date(Date.now() + 9 * DAYS),
    });
    await services.handover.ensureForBooking(y.bookingId, admin.id);
    const slotY = (await services.assignments.slotsForBooking(y.bookingId))[0]!;
    await services.assignments.assign(admin.id, effective, slotY.id, machine.id, null);

    // Drei Verschiebungen, die Sperre UND Kollision jeweils bestehen lassen.
    for (const hours of [0, 1, 2]) {
      await rescheduleTo(
        services,
        admin.id,
        x.returnAppointmentId,
        new Date(Date.now() + 10 * DAYS + hours * HOURS),
      );
    }
    const open = await openIncidents();
    expect(open.map((row) => row.reasonKind).sort()).toEqual(['block', 'collision']);
    expect(await allIncidents()).toHaveLength(2);
    expect(new Set(open.map((row) => row.fingerprint)).size).toBe(2);
  });

  it('Kollision, die EINE Seite per Override bewusst akzeptiert hat, erzeugt keinen Kollisions-Incident', async () => {
    const { admin, effective } = await adminSession();
    const services = handoverServicesFor(ctx);
    const { machine, world: x } = await assignedBooking(services, admin.id, effective);
    // Y +2d..+4d überlappt X (+1d..+3d): nur per Override zuweisbar.
    const y = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 2 * DAYS),
      to: new Date(Date.now() + 4 * DAYS),
    });
    await services.handover.ensureForBooking(y.bookingId, admin.id);
    const slotY = (await services.assignments.slotsForBooking(y.bookingId))[0]!;
    await services.assignments.assign(admin.id, effective, slotY.id, machine.id, {
      reason: 'Kunde X holt nachweislich vor Y ab',
    });
    await services.assignments.refreshRiskIncidents();
    expect(await openIncidents()).toEqual([]);
    // Terminänderung auf X (weiter überlappend): Override deckt das Paar
    // von beiden Seiten – weiterhin kein Kollisions-Incident.
    await rescheduleTo(
      services,
      admin.id,
      x.returnAppointmentId,
      new Date(Date.now() + 3.5 * DAYS),
    );
    expect(await openIncidents()).toEqual([]);
  });
});
