/**
 * Phase-4-Pflichttests 1–14: Termin-Erzeugung aus bestätigten Buchungen
 * (idempotent), Zeitmodell (exakt/Fenster/ungeplant, Europe/Berlin),
 * Wochenend-Vorschlag und initiale Mitarbeiterzuweisung. Läuft gegen
 * echtes PostgreSQL – Buchungen entstehen über den echten Annahmepfad.
 */
import { appointments, processes } from '@mietroyal/database';
import { berlinDateTimeToUtc } from '@mietroyal/domain';
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

async function appointmentsOf(bookingId: string) {
  return ctx.db.select().from(appointments).where(eq(appointments.bookingId, bookingId));
}

describe('1.–4. Termin-Erzeugung (idempotent, nichts geht verloren)', () => {
  it('1. Selbstabholbuchung erzeugt Abhol- UND Rückgabebedarf am Betriebsstandort', async () => {
    const { admin } = await adminSession();
    const world = await createAcceptedBooking(ctx, admin.id, { fulfillment: 'pickup' });
    const scheduling = schedulingServiceFor(ctx);
    const result = await scheduling.ensureAppointmentsForBooking(world.bookingId);
    expect(result.created).toBe(2);
    const rows = await appointmentsOf(world.bookingId);
    expect(rows.map((row) => row.kind).sort()).toEqual(['pickup', 'return']);
    expect(rows.every((row) => row.locationKind === 'base')).toBe(true);
    expect(rows.every((row) => row.timezone === 'Europe/Berlin')).toBe(true);
    expect(rows.every((row) => row.source === 'booking')).toBe(true);
  });

  it('2. Lieferbuchung erzeugt Lieferung + Rückgabebedarf an der Kundenadresse', async () => {
    const { admin } = await adminSession();
    const world = await createAcceptedBooking(ctx, admin.id, { fulfillment: 'delivery' });
    const scheduling = schedulingServiceFor(ctx);
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    const rows = await appointmentsOf(world.bookingId);
    expect(rows.map((row) => row.kind).sort()).toEqual(['delivery', 'return']);
    expect(rows.every((row) => row.locationKind === 'customer')).toBe(true);
    const snapshot = rows[0]?.locationSnapshot as Record<string, unknown>;
    expect(snapshot.street).toBe('Lieferweg 12');
    expect(snapshot.city).toBe('Mainz');
  });

  it('3. ensure zweimal (auch parallel) erzeugt keine Doppeltermine', async () => {
    const { admin } = await adminSession();
    const world = await createAcceptedBooking(ctx, admin.id, { fulfillment: 'pickup' });
    const scheduling = schedulingServiceFor(ctx);
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    const second = await scheduling.ensureAppointmentsForBooking(world.bookingId);
    expect(second.created).toBe(0);
    await Promise.allSettled([
      scheduling.ensureAppointmentsForBooking(world.bookingId),
      scheduling.ensureAppointmentsForBooking(world.bookingId),
    ]);
    expect((await appointmentsOf(world.bookingId)).length).toBe(2);
    // Auch der Backfill über ALLE Buchungen bleibt idempotent.
    const backfill = await scheduling.ensureAllBookingAppointments();
    expect(backfill.created).toBe(0);
  });

  it('4. Fehlende Zeit → ungeplant („Zeit festlegen“), aber niemals verloren', async () => {
    const { admin } = await adminSession();
    const world = await createAcceptedBooking(ctx, admin.id, { fulfillment: 'pickup' });
    const scheduling = schedulingServiceFor(ctx);
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    const rows = await appointmentsOf(world.bookingId);
    expect(rows.every((row) => row.startAt === null)).toBe(true);
    // Sichtbar in der Offen-Liste …
    const open = await scheduling.listOrganizationalOpen(admin.id, 'all');
    expect(open.filter((entry) => entry.bookingId === world.bookingId)).toHaveLength(2);
    // … aber nicht im Kalenderraster (dort erst mit Zeitposition).
    const calendar = await scheduling.listCalendar(admin.id, {
      from: new Date(Date.now() - 365 * 86_400_000),
      to: new Date(Date.now() + 365 * 86_400_000),
      scope: 'all',
    });
    expect(calendar.filter((entry) => entry.bookingId === world.bookingId)).toHaveLength(0);
  });
});

describe('5.–8. Zeitmodell (exakt, Fenster, Europe/Berlin, Validierung)', () => {
  it('5./6. Exakte Zeit und Lieferzeitfenster kommen korrekt aus dem Buchungs-Snapshot', async () => {
    const { admin } = await adminSession();
    const from = new Date('2026-10-09T12:00:00.000Z'); // 14:00 Berlin (MESZ)
    const to = new Date('2026-10-09T13:00:00.000Z'); // 15:00 Berlin
    const world = await createAcceptedBooking(ctx, admin.id, {
      fulfillment: 'delivery',
      eventDate: '2026-10-10',
      deliveryWindowFrom: from,
      deliveryWindowTo: to,
      collectionWindowFrom: new Date('2026-10-11T09:00:00.000Z'),
    });
    const scheduling = schedulingServiceFor(ctx);
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    const rows = await appointmentsOf(world.bookingId);
    const delivery = rows.find((row) => row.kind === 'delivery');
    const back = rows.find((row) => row.kind === 'return');
    // Zeitfenster: Beginn UND Ende gespeichert – keine künstliche exakte Zeit.
    expect(delivery?.startAt?.toISOString()).toBe(from.toISOString());
    expect(delivery?.endAt?.toISOString()).toBe(to.toISOString());
    // Exakte Zeit (nur „von“): Ende bleibt NULL.
    expect(back?.startAt?.toISOString()).toBe('2026-10-11T09:00:00.000Z');
    expect(back?.endAt).toBeNull();
  });

  it('8. Ungültige Zeitfenster werden verständlich abgelehnt', async () => {
    const { admin } = await adminSession();
    const world = await createAcceptedBooking(ctx, admin.id, { fulfillment: 'pickup' });
    const scheduling = schedulingServiceFor(ctx);
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    const rows = await appointmentsOf(world.bookingId);
    const pickup = rows.find((row) => row.kind === 'pickup')!;
    const start = new Date('2026-10-09T12:00:00.000Z');
    await expect(
      scheduling.reschedule(admin.id, pickup.id, {
        startAt: start,
        endAt: new Date('2026-10-09T11:00:00.000Z'),
        expectedVersion: pickup.version,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      scheduling.reschedule(admin.id, pickup.id, {
        startAt: null,
        endAt: start,
        expectedVersion: pickup.version,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('7./9. Wochenend-Standard: Freitag 18:00 / Sonntag 11:00 Europe/Berlin (gültiger Fall)', async () => {
    const { admin } = await adminSession();
    // Samstags-Event.
    const world = await createAcceptedBooking(ctx, admin.id, {
      fulfillment: 'pickup',
      eventDate: '2026-09-05',
    });
    const scheduling = schedulingServiceFor(ctx);
    const applied = await scheduling.applyWeekendStandard(admin.id, world.processId);
    expect(applied.pickupAt).toBe(berlinDateTimeToUtc('2026-09-04', 18).toISOString());
    expect(applied.returnAt).toBe(berlinDateTimeToUtc('2026-09-06', 11).toISOString());
    const rows = await appointmentsOf(world.bookingId);
    const pickup = rows.find((row) => row.kind === 'pickup');
    const back = rows.find((row) => row.kind === 'return');
    // 18:00 Berlin am 04.09. = 16:00 UTC (MESZ) – exakt, keine DST-Drift.
    expect(pickup?.startAt?.toISOString()).toBe('2026-09-04T16:00:00.000Z');
    expect(back?.startAt?.toISOString()).toBe('2026-09-06T09:00:00.000Z');
  });

  it('10. Unpassender Wochenend-Standard wird NICHT automatisch übernommen', async () => {
    const { admin } = await adminSession();
    // Freitags-Event ohne Zeiten: Freitag 18:00 läge nicht vor dem Event.
    const world = await createAcceptedBooking(ctx, admin.id, {
      fulfillment: 'pickup',
      eventDate: '2026-09-04',
    });
    const scheduling = schedulingServiceFor(ctx);
    await expect(scheduling.applyWeekendStandard(admin.id, world.processId)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    const rows = await appointmentsOf(world.bookingId);
    expect(rows.every((row) => row.startAt === null)).toBe(true);
  });
});

describe('11.–14. Initiale Zuweisung & Trennung von Prozesszuständigkeit', () => {
  it('11. Aktive Vorgangszuständigkeit wird initial als Terminmitarbeiter übernommen', async () => {
    const { admin } = await adminSession();
    const employee = await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Olaf',
      lastName: 'Operativ',
      email: 'olaf.operativ@test.example',
      password: 'olaf-passwort-1234',
    });
    const world = await createAcceptedBooking(ctx, admin.id, {
      fulfillment: 'pickup',
      assignProcessTo: employee.id,
    });
    await schedulingServiceFor(ctx).ensureAppointmentsForBooking(world.bookingId);
    const rows = await appointmentsOf(world.bookingId);
    expect(rows.every((row) => row.assignedUserId === employee.id)).toBe(true);
  });

  it('12. Ohne geeigneten Mitarbeiter bleibt die Zuweisung offen („Mitarbeiter zuweisen“)', async () => {
    const { admin } = await adminSession();
    const world = await createAcceptedBooking(ctx, admin.id, { fulfillment: 'pickup' });
    const scheduling = schedulingServiceFor(ctx);
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    const rows = await appointmentsOf(world.bookingId);
    expect(rows.every((row) => row.assignedUserId === null)).toBe(true);
    const open = await scheduling.listOrganizationalOpen(admin.id, 'all');
    expect(open.some((entry) => entry.bookingId === world.bookingId)).toBe(true);
  });

  it('13. Deaktivierte Mitarbeiter sind nicht neu zuweisbar (historisch bleiben sie referenziert)', async () => {
    const { admin } = await adminSession();
    const employee = await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Dora',
      lastName: 'Deaktiv',
      email: 'dora.deaktiv@test.example',
      password: 'dora-passwort-1234',
    });
    const world = await createAcceptedBooking(ctx, admin.id, {
      fulfillment: 'pickup',
      assignProcessTo: employee.id,
    });
    const scheduling = schedulingServiceFor(ctx);
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    await ctx.admin.setUserStatus(admin.id, employee.id, 'disabled');

    const rows = await appointmentsOf(world.bookingId);
    const pickup = rows.find((row) => row.kind === 'pickup')!;
    const effective = await ctx.auth.effectivePermissions(admin.id);
    await expect(
      scheduling.assign(
        admin.id,
        pickup.id,
        { userId: employee.id, expectedVersion: pickup.version },
        effective,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    // Historische Referenz bleibt bestehen.
    const after = await appointmentsOf(world.bookingId);
    expect(after.find((row) => row.kind === 'pickup')?.assignedUserId).toBe(employee.id);
  });

  it('14. Terminzuweisung ändert die Prozesszuständigkeit NICHT', async () => {
    const { admin } = await adminSession();
    const employee = await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Timo',
      lastName: 'Termin',
      email: 'timo.termin@test.example',
      password: 'timo-passwort-1234',
    });
    const world = await createAcceptedBooking(ctx, admin.id, {
      fulfillment: 'pickup',
      assignProcessTo: admin.id,
    });
    const scheduling = schedulingServiceFor(ctx);
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    const rows = await appointmentsOf(world.bookingId);
    const pickup = rows.find((row) => row.kind === 'pickup')!;
    const effective = await ctx.auth.effectivePermissions(admin.id);
    await scheduling.assign(
      admin.id,
      pickup.id,
      { userId: employee.id, expectedVersion: pickup.version },
      effective,
    );
    const processRow = await ctx.db
      .select({ assignedUserId: processes.assignedUserId })
      .from(processes)
      .where(eq(processes.id, world.processId));
    expect(processRow[0]?.assignedUserId).toBe(admin.id);
    const after = await appointmentsOf(world.bookingId);
    expect(after.find((row) => row.kind === 'pickup')?.assignedUserId).toBe(employee.id);
  });
});
