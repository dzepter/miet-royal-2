/**
 * Phase-4-Pflichttests 15–29: Vertretungen (Anlage, Ablehnung, effektive
 * Zuständigkeit, vorzeitiges Ende, „Meine Termine“) und gleiche-Tages-
 * Reassignment mit Übernahmebestätigung + Push-Datenlage.
 */
import { appointments } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createEmployeeWithPassword,
  createTestContext,
  destroyTestContext,
  login,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { truncateCrmTables } from './crm-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import {
  createAcceptedBooking,
  schedulingServiceFor,
  substitutionServiceFor,
  truncateSchedulingTables,
} from './scheduling-helpers.ts';

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

async function makeEmployee(adminId: string, name: string) {
  return createEmployeeWithPassword(ctx, adminId, {
    firstName: name,
    lastName: 'Test',
    email: `${name.toLowerCase()}@test.example`,
    password: `${name.toLowerCase()}-passwort-1234`,
  });
}

const IN_DAYS = (days: number, hours = 0) =>
  new Date(Date.now() + days * 86_400_000 + hours * 3_600_000);

/**
 * Zeitpunkt, der GARANTIERT am selben Berliner Kalendertag wie "jetzt"
 * liegt (kurz vor Mitternacht: 30 min zurück statt vor).
 */
function sameBerlinDayStart(): Date {
  const hour = Number(
    new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date()),
  );
  return hour < 23 ? new Date(Date.now() + 30 * 60_000) : new Date(Date.now() - 30 * 60_000);
}

describe('15.–21. Vertretungen', () => {
  it('15./19./20. Anlage mit Start/Ende; effektive Zuständigkeit im Zeitraum, danach zurück', async () => {
    const { admin } = await adminSession();
    const anna = await makeEmployee(admin.id, 'Anna');
    const bernd = await makeEmployee(admin.id, 'Bernd');
    const substitutions = substitutionServiceFor(ctx);
    await substitutions.create(admin.id, {
      originalUserId: anna.id,
      substituteUserId: bernd.id,
      startsAt: IN_DAYS(5),
      endsAt: IN_DAYS(10),
    });

    const world = await createAcceptedBooking(ctx, admin.id, {
      fulfillment: 'pickup',
      assignProcessTo: anna.id,
    });
    const scheduling = schedulingServiceFor(ctx);
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    const rows = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.bookingId, world.bookingId));
    const pickup = rows.find((row) => row.kind === 'pickup')!;

    // Termin IM Vertretungszeitraum → effektiv Bernd; danach wieder Anna.
    await scheduling.reschedule(admin.id, pickup.id, {
      startAt: IN_DAYS(7),
      endAt: null,
      expectedVersion: pickup.version,
    });
    let entry = await scheduling.entryById(pickup.id);
    expect(entry.assignedUserId).toBe(anna.id);
    expect(entry.effectiveAssigneeId).toBe(bernd.id);
    expect(entry.substituted).toBe(true);

    await scheduling.reschedule(admin.id, pickup.id, {
      startAt: IN_DAYS(12),
      endAt: null,
      expectedVersion: entry.version,
    });
    entry = await scheduling.entryById(pickup.id);
    expect(entry.effectiveAssigneeId).toBe(anna.id);
    expect(entry.substituted).toBe(false);
  });

  it('16. Ursprung = Vertretung wird abgelehnt', async () => {
    const { admin } = await adminSession();
    const anna = await makeEmployee(admin.id, 'Anna');
    await expect(
      substitutionServiceFor(ctx).create(admin.id, {
        originalUserId: anna.id,
        substituteUserId: anna.id,
        startsAt: IN_DAYS(1),
        endsAt: IN_DAYS(2),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('17. Deaktivierte Personen sind nicht auswählbar', async () => {
    const { admin } = await adminSession();
    const anna = await makeEmployee(admin.id, 'Anna');
    const dora = await makeEmployee(admin.id, 'Dora');
    await ctx.admin.setUserStatus(admin.id, dora.id, 'disabled');
    const substitutions = substitutionServiceFor(ctx);
    await expect(
      substitutions.create(admin.id, {
        originalUserId: anna.id,
        substituteUserId: dora.id,
        startsAt: IN_DAYS(1),
        endsAt: IN_DAYS(2),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      substitutions.create(admin.id, {
        originalUserId: dora.id,
        substituteUserId: anna.id,
        startsAt: IN_DAYS(1),
        endsAt: IN_DAYS(2),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('18. Widersprüchlich überlappende Vertretungen desselben Ursprungs werden abgelehnt', async () => {
    const { admin } = await adminSession();
    const anna = await makeEmployee(admin.id, 'Anna');
    const bernd = await makeEmployee(admin.id, 'Bernd');
    const carla = await makeEmployee(admin.id, 'Carla');
    const substitutions = substitutionServiceFor(ctx);
    await substitutions.create(admin.id, {
      originalUserId: anna.id,
      substituteUserId: bernd.id,
      startsAt: IN_DAYS(5),
      endsAt: IN_DAYS(10),
    });
    await expect(
      substitutions.create(admin.id, {
        originalUserId: anna.id,
        substituteUserId: carla.id,
        startsAt: IN_DAYS(8),
        endsAt: IN_DAYS(12),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // Nicht überlappend ist erlaubt (direkt anschließend).
    await substitutions.create(admin.id, {
      originalUserId: anna.id,
      substituteUserId: carla.id,
      startsAt: IN_DAYS(10),
      endsAt: IN_DAYS(12),
    });
    // Für einen ANDEREN Ursprung ist der Zeitraum frei.
    await substitutions.create(admin.id, {
      originalUserId: bernd.id,
      substituteUserId: carla.id,
      startsAt: IN_DAYS(5),
      endsAt: IN_DAYS(10),
    });
  });

  it('21. Vorzeitiges Beenden wirkt sofort', async () => {
    const { admin } = await adminSession();
    const anna = await makeEmployee(admin.id, 'Anna');
    const bernd = await makeEmployee(admin.id, 'Bernd');
    const substitutions = substitutionServiceFor(ctx);
    const created = await substitutions.create(admin.id, {
      originalUserId: anna.id,
      substituteUserId: bernd.id,
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: IN_DAYS(10),
    });

    const world = await createAcceptedBooking(ctx, admin.id, {
      fulfillment: 'pickup',
      assignProcessTo: anna.id,
    });
    const scheduling = schedulingServiceFor(ctx);
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    const rows = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.bookingId, world.bookingId));
    const pickup = rows.find((row) => row.kind === 'pickup')!;
    await scheduling.reschedule(admin.id, pickup.id, {
      startAt: new Date(Date.now() + 3_600_000),
      endAt: null,
      expectedVersion: pickup.version,
    });
    expect((await scheduling.entryById(pickup.id)).effectiveAssigneeId).toBe(bernd.id);

    await substitutions.endEarly(created.id);
    expect((await scheduling.entryById(pickup.id)).effectiveAssigneeId).toBe(anna.id);
    // Doppeltes Beenden → verständlicher Konflikt.
    await expect(substitutions.endEarly(created.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('22.–23. „Meine Termine“ mit Vertretung', () => {
  it('22./23. Vertretung sieht die Termine des Vertretenen; neue Termine im Zeitraum werden korrekt aufgelöst', async () => {
    const { admin } = await adminSession();
    const anna = await makeEmployee(admin.id, 'Anna');
    const bernd = await makeEmployee(admin.id, 'Bernd');
    await substitutionServiceFor(ctx).create(admin.id, {
      originalUserId: anna.id,
      substituteUserId: bernd.id,
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: IN_DAYS(14),
    });

    const scheduling = schedulingServiceFor(ctx);
    const world = await createAcceptedBooking(ctx, admin.id, {
      fulfillment: 'pickup',
      assignProcessTo: anna.id,
    });
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    const rows = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.bookingId, world.bookingId));
    const pickup = rows.find((row) => row.kind === 'pickup')!;
    await scheduling.reschedule(admin.id, pickup.id, {
      startAt: IN_DAYS(7),
      endAt: null,
      expectedVersion: pickup.version,
    });

    const range = {
      from: new Date(Date.now() - 86_400_000),
      to: IN_DAYS(30),
    };
    // "Meine Termine" der VERTRETUNG enthält den Termin …
    const mineBernd = await scheduling.listCalendar(bernd.id, { ...range, scope: 'mine' });
    expect(mineBernd.some((entry) => entry.id === pickup.id)).toBe(true);
    // … die des abwesenden Ursprungs für den Zeitraum nicht.
    const mineAnna = await scheduling.listCalendar(anna.id, { ...range, scope: 'mine' });
    expect(mineAnna.some((entry) => entry.id === pickup.id)).toBe(false);

    // 23: Ein NEU zugewiesener Termin im Vertretungszeitraum landet ebenfalls
    // effektiv bei der Vertretung (Zuweisung an Anna → effektiv Bernd).
    const world2 = await createAcceptedBooking(ctx, admin.id, { fulfillment: 'pickup' });
    await scheduling.ensureAppointmentsForBooking(world2.bookingId);
    const rows2 = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.bookingId, world2.bookingId));
    const pickup2 = rows2.find((row) => row.kind === 'pickup')!;
    await scheduling.reschedule(admin.id, pickup2.id, {
      startAt: IN_DAYS(8),
      endAt: null,
      expectedVersion: pickup2.version,
    });
    const effective = await ctx.auth.effectivePermissions(admin.id);
    const afterReschedule = await scheduling.entryById(pickup2.id);
    await scheduling.assign(
      admin.id,
      pickup2.id,
      { userId: anna.id, expectedVersion: afterReschedule.version },
      effective,
    );
    const entry = await scheduling.entryById(pickup2.id);
    expect(entry.assignedUserId).toBe(anna.id);
    expect(entry.effectiveAssigneeId).toBe(bernd.id);
  });
});

describe('24.–29. Gleiche-Tages-Reassignment & Übernahmebestätigung', () => {
  async function scheduledWorld(adminId: string, startAt: Date, assignTo: string) {
    const world = await createAcceptedBooking(ctx, adminId, {
      fulfillment: 'pickup',
      assignProcessTo: assignTo,
    });
    const scheduling = schedulingServiceFor(ctx);
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    const rows = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.bookingId, world.bookingId));
    const pickup = rows.find((row) => row.kind === 'pickup')!;
    await scheduling.reschedule(adminId, pickup.id, {
      startAt,
      endAt: null,
      expectedVersion: pickup.version,
    });
    return { world, appointmentId: pickup.id, scheduling };
  }

  it('24. Normale zukünftige Reassignment: keine Übernahmebestätigung nötig', async () => {
    const { admin } = await adminSession();
    const anna = await makeEmployee(admin.id, 'Anna');
    const bernd = await makeEmployee(admin.id, 'Bernd');
    const { appointmentId, scheduling } = await scheduledWorld(admin.id, IN_DAYS(7), anna.id);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    const entry = await scheduling.entryById(appointmentId);
    await scheduling.assign(
      admin.id,
      appointmentId,
      { userId: bernd.id, expectedVersion: entry.version },
      effective,
    );
    const after = await scheduling.entryById(appointmentId);
    expect(after.assignedUserId).toBe(bernd.id);
    expect(after.acknowledgementPending).toBe(false);
  });

  it('25./26./29. Gleiche-Tages-Reassignment: pending → bestätigen; Push-Datenlage eindeutig', async () => {
    const { admin } = await adminSession();
    const anna = await makeEmployee(admin.id, 'Anna');
    const bernd = await makeEmployee(admin.id, 'Bernd');
    const today = sameBerlinDayStart();
    const { appointmentId, scheduling } = await scheduledWorld(admin.id, today, anna.id);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    const entry = await scheduling.entryById(appointmentId);
    await scheduling.assign(
      admin.id,
      appointmentId,
      { userId: bernd.id, expectedVersion: entry.version },
      effective,
    );
    const pending = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.id, appointmentId));
    // 29: Datenlage für Phase 12 – Benachrichtigung notwendig, nicht versendet,
    // Übernahme noch nicht bestätigt.
    expect(pending[0]?.acknowledgementRequestedAt).not.toBeNull();
    expect(pending[0]?.acknowledgementRequestedFor).toBe(bernd.id);
    expect(pending[0]?.assignmentNotifiedAt).toBeNull();
    expect(pending[0]?.acknowledgedAt).toBeNull();
    expect((await scheduling.entryById(appointmentId)).acknowledgementPending).toBe(true);

    // 26: Der NEUE Mitarbeiter bestätigt „Termin übernommen“.
    await scheduling.acknowledge(bernd.id, appointmentId);
    const confirmed = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.id, appointmentId));
    expect(confirmed[0]?.acknowledgedAt).not.toBeNull();
    expect(confirmed[0]?.acknowledgedBy).toBe(bernd.id);
    expect((await scheduling.entryById(appointmentId)).acknowledgementPending).toBe(false);
  });

  it('27. Andere Personen können die Bestätigung nicht fälschen', async () => {
    const { admin } = await adminSession();
    const anna = await makeEmployee(admin.id, 'Anna');
    const bernd = await makeEmployee(admin.id, 'Bernd');
    const carla = await makeEmployee(admin.id, 'Carla');
    const today = sameBerlinDayStart();
    const { appointmentId, scheduling } = await scheduledWorld(admin.id, today, anna.id);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    const entry = await scheduling.entryById(appointmentId);
    await scheduling.assign(
      admin.id,
      appointmentId,
      { userId: bernd.id, expectedVersion: entry.version },
      effective,
    );
    await expect(scheduling.acknowledge(carla.id, appointmentId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(scheduling.acknowledge(admin.id, appointmentId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('28. Erneute Reassignment macht eine alte Bestätigung ungültig', async () => {
    const { admin } = await adminSession();
    const anna = await makeEmployee(admin.id, 'Anna');
    const bernd = await makeEmployee(admin.id, 'Bernd');
    const carla = await makeEmployee(admin.id, 'Carla');
    const today = sameBerlinDayStart();
    const { appointmentId, scheduling } = await scheduledWorld(admin.id, today, anna.id);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    let entry = await scheduling.entryById(appointmentId);
    await scheduling.assign(
      admin.id,
      appointmentId,
      { userId: bernd.id, expectedVersion: entry.version },
      effective,
    );
    await scheduling.acknowledge(bernd.id, appointmentId);

    entry = await scheduling.entryById(appointmentId);
    await scheduling.assign(
      admin.id,
      appointmentId,
      { userId: carla.id, expectedVersion: entry.version },
      effective,
    );
    const rows = await ctx.db.select().from(appointments).where(eq(appointments.id, appointmentId));
    expect(rows[0]?.acknowledgedAt).toBeNull();
    expect(rows[0]?.acknowledgedBy).toBeNull();
    expect(rows[0]?.acknowledgementRequestedFor).toBe(carla.id);
    expect(rows[0]?.assignmentNotifiedAt).toBeNull();
    // Bernd kann die alte Bestätigung nicht wiederverwenden.
    await expect(scheduling.acknowledge(bernd.id, appointmentId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
