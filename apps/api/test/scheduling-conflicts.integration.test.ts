/**
 * Phase-4-Pflichttests 30–40: Konfliktengine (Doppelbelegung, Reihenfolge),
 * Warnung statt Blockade, „Konflikt gelöst“ mit Fingerprint-Suppression
 * (ohne Grund, ohne Audit, nicht adminexklusiv) und Provider-Erweiterbarkeit.
 */
import { appointments } from '@mietroyal/database';
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
import { createStaffWithPermissions, truncateCrmTables } from './crm-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import {
  createAcceptedBooking,
  schedulingServiceFor,
  truncateSchedulingTables,
} from './scheduling-helpers.ts';
import { ConflictDetectionService } from '../src/scheduling/conflicts.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateSchedulingTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
});

async function adminSession() {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  return { admin, cookie: session.cookie };
}

const IN_DAYS = (days: number, hours = 0) =>
  new Date(Date.now() + days * 86_400_000 + hours * 3_600_000);

/** Zwei geplante Termine desselben Mitarbeiters (überlappend steuerbar). */
async function twoAppointments(
  adminId: string,
  userId: string,
  aStart: Date,
  bStart: Date,
  aEnd: Date | null = null,
  bEnd: Date | null = null,
) {
  const scheduling = schedulingServiceFor(ctx);
  const ids: string[] = [];
  for (const [start, end] of [
    [aStart, aEnd],
    [bStart, bEnd],
  ] as const) {
    const world = await createAcceptedBooking(ctx, adminId, {
      fulfillment: 'pickup',
      assignProcessTo: userId,
    });
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    const rows = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.bookingId, world.bookingId));
    const pickup = rows.find((row) => row.kind === 'pickup')!;
    await scheduling.reschedule(adminId, pickup.id, {
      startAt: start,
      endAt: end,
      expectedVersion: pickup.version,
    });
    ids.push(pickup.id);
  }
  return { scheduling, ids };
}

async function visibleConflictsFor(ids: string[]) {
  const scheduling = schedulingServiceFor(ctx);
  const enriched = await scheduling.listForConflictCheck(ids);
  return scheduling.conflicts.detectVisible({ appointments: enriched });
}

describe('30.–33. Erkennung: Warnung, keine Blockade', () => {
  it('30./32./33. Überlappung desselben effektiven Mitarbeiters → Konflikt mit Grund; Termin bleibt gespeichert', async () => {
    const { admin } = await adminSession();
    const start = IN_DAYS(7, 2);
    // 32: Das Verschieben in die Überlappung wird NICHT blockiert.
    const { ids } = await twoAppointments(
      admin.id,
      admin.id,
      start,
      new Date(start.getTime() + 30 * 60_000),
      new Date(start.getTime() + 2 * 3_600_000),
      null,
    );
    const conflicts = await visibleConflictsFor(ids);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.type).toBe('staff_double_booking');
    expect(conflicts[0]?.severity).toBe('strong');
    // 33: Der Grund ist verständlich verfügbar.
    expect(conflicts[0]?.reason).toContain('Doppelbelegung');
    expect([...conflicts[0]!.appointmentIds].sort()).toEqual([...ids].sort());
    // Kalender liefert den Konflikt DIREKT am Termin (Order §19).
    const scheduling = schedulingServiceFor(ctx);
    const entry = await scheduling.entryById(ids[0]!);
    expect(entry.conflicts.some((c) => c.type === 'staff_double_booking')).toBe(true);
  });

  it('31. Keine Überlappung → kein Konflikt (auch angrenzende Fenster nicht)', async () => {
    const { admin } = await adminSession();
    const start = IN_DAYS(7, 2);
    const end = new Date(start.getTime() + 3_600_000);
    const { ids } = await twoAppointments(
      admin.id,
      admin.id,
      start,
      end, // beginnt exakt am Ende des ersten Fensters
      end,
      new Date(end.getTime() + 3_600_000),
    );
    expect(await visibleConflictsFor(ids)).toHaveLength(0);
  });

  it('Unlogische Reihenfolge desselben Vorgangs: Rückgabe vor Ausgabe → Warnung', async () => {
    const { admin } = await adminSession();
    const world = await createAcceptedBooking(ctx, admin.id, { fulfillment: 'pickup' });
    const scheduling = schedulingServiceFor(ctx);
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    const rows = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.bookingId, world.bookingId));
    const pickup = rows.find((row) => row.kind === 'pickup')!;
    const back = rows.find((row) => row.kind === 'return')!;
    await scheduling.reschedule(admin.id, pickup.id, {
      startAt: IN_DAYS(8),
      endAt: null,
      expectedVersion: pickup.version,
    });
    await scheduling.reschedule(admin.id, back.id, {
      startAt: IN_DAYS(7),
      endAt: null,
      expectedVersion: back.version,
    });
    const conflicts = await visibleConflictsFor([pickup.id, back.id]);
    expect(conflicts.some((c) => c.type === 'process_sequence')).toBe(true);
    expect(conflicts.find((c) => c.type === 'process_sequence')?.severity).toBe('warning');
  });
});

describe('34.–39. „Konflikt gelöst“ (Suppression)', () => {
  it('34./35./36. Normale Mitarbeiter mit Sichtrecht lösen ohne Pflichtgrund; Konflikt verschwindet', async () => {
    const { admin } = await adminSession();
    const staffMember = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Karl',
      lastName: 'Kalender',
      email: 'karl.kalender@test.example',
      password: 'karl-passwort-1234',
      permissionKeys: ['calendar.view'],
    });
    const start = IN_DAYS(7, 2);
    const { ids } = await twoAppointments(admin.id, staffMember.user.id, start, start);
    expect(await visibleConflictsFor(ids)).toHaveLength(1);

    // 36: KEIN Adminrecht nötig – der betroffene Mitarbeiter (Sichtrecht auf
    // die eigenen Termine) löst über die normale Route; 35: ohne Grundfeld.
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/staff/conflicts/resolve',
      headers: { cookie: staffMember.cookie },
      payload: { type: 'staff_double_booking', appointmentIds: ids },
    });
    expect(response.statusCode).toBe(200);
    // 34: danach normal nicht mehr sichtbar.
    expect(await visibleConflictsFor(ids)).toHaveLength(0);
  });

  it('37./38. Relevante Terminänderung → neuer Fingerprint; alter Resolve unterdrückt nichts', async () => {
    const { admin } = await adminSession();
    const start = IN_DAYS(7, 2);
    const { scheduling, ids } = await twoAppointments(admin.id, admin.id, start, start);
    const enriched = await scheduling.listForConflictCheck(ids);
    await scheduling.conflicts.resolve(
      { appointments: enriched },
      'staff_double_booking',
      [...ids].sort(),
    );
    expect(await visibleConflictsFor(ids)).toHaveLength(0);

    // Zeit relevant ändern – WEITER überlappend (der zweite Termin ist ein
    // exakter Punkt bei `start`, der neue Zeitraum umschließt ihn), aber mit
    // NEUEM Fingerprint → der Konflikt darf wieder erscheinen.
    const entry = await scheduling.entryById(ids[0]!);
    await scheduling.reschedule(admin.id, ids[0]!, {
      startAt: new Date(start.getTime() - 30 * 60_000),
      endAt: new Date(start.getTime() + 30 * 60_000),
      expectedVersion: entry.version,
    });
    const again = await visibleConflictsFor(ids);
    expect(again).toHaveLength(1);
  });

  it('39. Lösen erzeugt KEIN Audit-Event', async () => {
    const { admin } = await adminSession();
    const start = IN_DAYS(7, 2);
    const { scheduling, ids } = await twoAppointments(admin.id, admin.id, start, start);
    const before = await ctx.pool.query('SELECT count(*)::int AS n FROM staff_security_events');
    const enriched = await scheduling.listForConflictCheck(ids);
    await scheduling.conflicts.resolve(
      { appointments: enriched },
      'staff_double_booking',
      [...ids].sort(),
    );
    const after = await ctx.pool.query('SELECT count(*)::int AS n FROM staff_security_events');
    expect(after.rows[0].n).toBe(before.rows[0].n);
    // Und die Suppression speichert nur den Fingerprint (kein Kommentar etc.).
    const suppression = await ctx.pool.query('SELECT * FROM appointment_conflict_suppressions');
    expect(suppression.rows).toHaveLength(1);
    expect(Object.keys(suppression.rows[0]).sort()).toEqual(['created_at', 'fingerprint', 'id']);
  });

  it('Nicht existierende Konflikte lassen sich nicht „lösen“ (kein Verstecken auf Vorrat)', async () => {
    const { admin, cookie } = await adminSession();
    const start = IN_DAYS(7, 2);
    // KEINE Überlappung.
    const { ids } = await twoAppointments(
      admin.id,
      admin.id,
      start,
      new Date(start.getTime() + 4 * 3_600_000),
    );
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/staff/conflicts/resolve',
      headers: { cookie },
      payload: { type: 'staff_double_booking', appointmentIds: ids },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('40. Erweiterbarkeit (Phase-5-Vorbereitung)', () => {
  it('Zusätzlicher ConflictProvider ist registrierbar; doppelte Keys abgelehnt', async () => {
    const service = new ConflictDetectionService(ctx.db);
    service.registerProvider({
      key: 'machine_capacity_dummy',
      detect: (context) =>
        context.appointments.length > 0
          ? [
              {
                type: 'machine_capacity_dummy',
                severity: 'warning',
                appointmentIds: [context.appointments[0]!.id],
                reason: 'Dummy-Maschinenkonflikt (Testprovider).',
                fingerprint: 'dummy-fingerprint',
              },
            ]
          : [],
    });
    const { admin } = await adminSession();
    const world = await createAcceptedBooking(ctx, admin.id, { fulfillment: 'pickup' });
    const scheduling = schedulingServiceFor(ctx);
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    const rows = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.bookingId, world.bookingId));
    const detected = service.detectAll({
      appointments: rows.map((row) => ({ ...row, effectiveAssigneeId: null })),
    });
    expect(detected.some((c) => c.type === 'machine_capacity_dummy')).toBe(true);
    expect(() =>
      service.registerProvider({ key: 'machine_capacity_dummy', detect: () => [] }),
    ).toThrow();
  });
});
