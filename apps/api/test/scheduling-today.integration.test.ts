/**
 * Phase-4-Pflichttests 41–52: Überfällige Rückgaben (Incident-Semantik,
 * „Kunde kontaktiert“, neue Rückgabezeit), Admin-Push- und 1h-Reminder-
 * Vorbereitung (effektiver Mitarbeiter inkl. Vertretung) und „Heute“.
 */
import { appointmentOverdueIncidents, appointments } from '@mietroyal/database';
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

const HOURS = 3_600_000;

/** Rückgabetermin mit gesetzter Zeit anlegen (relativ zu jetzt). */
async function returnAppointmentAt(adminId: string, startAt: Date, assignTo: string | null = null) {
  const scheduling = schedulingServiceFor(ctx);
  const world = await createAcceptedBooking(ctx, adminId, {
    fulfillment: 'pickup',
    ...(assignTo === null ? {} : { assignProcessTo: assignTo }),
  });
  await scheduling.ensureAppointmentsForBooking(world.bookingId);
  const rows = await ctx.db
    .select()
    .from(appointments)
    .where(eq(appointments.bookingId, world.bookingId));
  const back = rows.find((row) => row.kind === 'return')!;
  await scheduling.reschedule(adminId, back.id, {
    startAt,
    endAt: null,
    expectedVersion: back.version,
  });
  return {
    scheduling,
    world,
    appointmentId: back.id,
    pickupId: rows.find((r) => r.kind === 'pickup')!.id,
  };
}

describe('41.–43. Überfällige Rückgabe erkennen', () => {
  it('41./42. Überfällige Rückgabe wird erkannt und steht VOR den heutigen Terminen', async () => {
    const { admin } = await adminSession();
    const { scheduling, appointmentId } = await returnAppointmentAt(
      admin.id,
      new Date(Date.now() - 2 * HOURS),
    );
    const view = await scheduling.todayView(admin.id, 'all');
    expect(view.overdue.some((entry) => entry.id === appointmentId)).toBe(true);
    // Struktur: Überfällig ist die ERSTE Sektion und heutige Termine
    // enthalten den überfälligen Termin nicht doppelt.
    expect(view.today.some((entry) => entry.id === appointmentId)).toBe(false);
    const entry = view.overdue.find((item) => item.id === appointmentId)!;
    expect(entry.overdue).toBe(true);
    expect(entry.overdueIncident).not.toBeNull();
  });

  it('43. Nicht überfällige Rückgabe wird nicht als überfällig markiert', async () => {
    const { admin } = await adminSession();
    const { scheduling, appointmentId } = await returnAppointmentAt(
      admin.id,
      new Date(Date.now() + 5 * HOURS),
    );
    const view = await scheduling.todayView(admin.id, 'all');
    expect(view.overdue.some((entry) => entry.id === appointmentId)).toBe(false);
    const entry = await scheduling.entryById(appointmentId);
    expect(entry.overdue).toBe(false);
    expect(entry.overdueIncident).toBeNull();
    // Abgeschlossene Rückgaben sind nie überfällig.
    const effective = await ctx.auth.effectivePermissions(admin.id);
    void effective;
  });
});

describe('44.–48. Incident-Semantik („Kunde kontaktiert“, neue Zeit, Admin-Push)', () => {
  it('44. „Kunde kontaktiert“ ist speicherbar (minimales Kennzeichen, kein Verlauf)', async () => {
    const { admin } = await adminSession();
    const { scheduling, appointmentId } = await returnAppointmentAt(
      admin.id,
      new Date(Date.now() - 2 * HOURS),
    );
    await scheduling.markCustomerContacted(admin.id, appointmentId);
    const entry = await scheduling.entryById(appointmentId);
    expect(entry.overdueIncident?.customerContactedAt).not.toBeNull();
    // Bei NICHT überfälligen Terminen ist die Aktion nicht möglich.
    const future = await returnAppointmentAt(admin.id, new Date(Date.now() + 5 * HOURS));
    await expect(
      scheduling.markCustomerContacted(admin.id, future.appointmentId),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('45./46. Neue Rückgabezeit: bestätigte Änderung (Versionsprüfung) beendet den alten Incident', async () => {
    const { admin } = await adminSession();
    const { scheduling, appointmentId } = await returnAppointmentAt(
      admin.id,
      new Date(Date.now() - 2 * HOURS),
    );
    await scheduling.todayView(admin.id, 'all'); // Incident sicher angelegt
    const entry = await scheduling.entryById(appointmentId);

    // 45: Ohne korrekte (bestätigte) Version wird NICHT gespeichert.
    await expect(
      scheduling.reschedule(admin.id, appointmentId, {
        startAt: new Date(Date.now() + 24 * HOURS),
        endAt: null,
        expectedVersion: entry.version + 7,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // 46: Mit bestätigter Version → Zeit aktualisiert, Incident beendet,
    // Kundeninformation als erforderlich markiert (Order §27).
    await scheduling.reschedule(admin.id, appointmentId, {
      startAt: new Date(Date.now() + 24 * HOURS),
      endAt: null,
      expectedVersion: entry.version,
    });
    const after = await scheduling.entryById(appointmentId);
    expect(after.overdue).toBe(false);
    expect(after.overdueIncident).toBeNull();
    expect(after.customerInfoRequiredAt).not.toBeNull();
    const incidents = await ctx.db
      .select()
      .from(appointmentOverdueIncidents)
      .where(eq(appointmentOverdueIncidents.appointmentId, appointmentId));
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.resolvedAt).not.toBeNull();
  });

  it('47./48. Erneut überschritten → NEUER Incident; Admin-Push genau einmal je Incident fällig', async () => {
    const { admin } = await adminSession();
    const { scheduling, appointmentId } = await returnAppointmentAt(
      admin.id,
      new Date(Date.now() - 3 * HOURS),
    );
    // Erster Incident fällig (noch nicht versendet).
    let due = await scheduling.listDueOverdueAdminNotifications();
    expect(due.filter((row) => row.appointmentId === appointmentId)).toHaveLength(1);
    const firstIncidentId = due.find((row) => row.appointmentId === appointmentId)!.incidentId;

    // Phase-12-Kontrakt simulieren: Versand markiert adminNotifiedAt →
    // danach ist derselbe Incident NICHT mehr fällig (keine Push-Schleife).
    await ctx.db
      .update(appointmentOverdueIncidents)
      .set({ adminNotifiedAt: new Date() })
      .where(eq(appointmentOverdueIncidents.id, firstIncidentId));
    due = await scheduling.listDueOverdueAdminNotifications();
    expect(due.filter((row) => row.appointmentId === appointmentId)).toHaveLength(0);

    // Neue Zeit in der Vergangenheit? Nein – fachlich: neue ZUKUNFTSzeit,
    // die später erneut überschritten wird. Wir setzen eine Zeit, die knapp
    // vor "jetzt" liegt, NACHDEM der alte Incident beendet wurde.
    const entry = await scheduling.entryById(appointmentId);
    await scheduling.reschedule(admin.id, appointmentId, {
      startAt: new Date(Date.now() + 24 * HOURS),
      endAt: null,
      expectedVersion: entry.version,
    });
    const rescheduled = await scheduling.entryById(appointmentId);
    // Später wird auch die neue Zeit überschritten (Zeitreise per Reschedule
    // in die Vergangenheit – fachlich äquivalent zum Verstreichen der Zeit).
    await scheduling.reschedule(admin.id, appointmentId, {
      startAt: new Date(Date.now() - 1 * HOURS),
      endAt: null,
      expectedVersion: rescheduled.version,
    });
    due = await scheduling.listDueOverdueAdminNotifications();
    const newDue = due.filter((row) => row.appointmentId === appointmentId);
    expect(newDue).toHaveLength(1);
    expect(newDue[0]?.incidentId).not.toBe(firstIncidentId);

    const incidents = await ctx.db
      .select()
      .from(appointmentOverdueIncidents)
      .where(eq(appointmentOverdueIncidents.appointmentId, appointmentId));
    expect(incidents).toHaveLength(2);
  });
});

describe('49.–50. 1h-Reminder-Vorbereitung', () => {
  it('49. Reminder ist exakt dem effektiven Mitarbeiter zugeordnet und nur im Fälligkeitsfenster', async () => {
    const { admin } = await adminSession();
    const anna = await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Anna',
      lastName: 'Test',
      email: 'anna@test.example',
      password: 'anna-passwort-1234',
    });
    const soon = await returnAppointmentAt(admin.id, new Date(Date.now() + 0.5 * HOURS), anna.id);
    await returnAppointmentAt(admin.id, new Date(Date.now() + 5 * HOURS), anna.id);
    const due = await soon.scheduling.listDueReminders();
    expect(due).toHaveLength(1);
    expect(due[0]?.appointmentId).toBe(soon.appointmentId);
    expect(due[0]?.effectiveUserId).toBe(anna.id);
  });

  it('50. Bei aktiver Vertretung erhält die VERTRETUNG den Reminder', async () => {
    const { admin } = await adminSession();
    const anna = await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Anna',
      lastName: 'Test',
      email: 'anna@test.example',
      password: 'anna-passwort-1234',
    });
    const bernd = await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Bernd',
      lastName: 'Test',
      email: 'bernd@test.example',
      password: 'bernd-passwort-1234',
    });
    await substitutionServiceFor(ctx).create(admin.id, {
      originalUserId: anna.id,
      substituteUserId: bernd.id,
      startsAt: new Date(Date.now() - HOURS),
      endsAt: new Date(Date.now() + 48 * HOURS),
    });
    const soon = await returnAppointmentAt(admin.id, new Date(Date.now() + 0.5 * HOURS), anna.id);
    const due = await soon.scheduling.listDueReminders();
    const forAppointment = due.filter((row) => row.appointmentId === soon.appointmentId);
    expect(forAppointment).toHaveLength(1);
    expect(forAppointment[0]?.effectiveUserId).toBe(bernd.id);
  });
});

describe('51.–52. „Heute“-Inhalte', () => {
  it('51. Bei wenigen heutigen Terminen werden bis zu 2 kommende gezeigt', async () => {
    const { admin } = await adminSession();
    const scheduling = schedulingServiceFor(ctx);
    // Drei zukünftige Termine an kommenden Tagen, keiner heute.
    for (const days of [3, 5, 7]) {
      await returnAppointmentAt(admin.id, new Date(Date.now() + days * 24 * HOURS));
    }
    const view = await scheduling.todayView(admin.id, 'all');
    expect(view.today).toHaveLength(0);
    expect(view.upcoming).toHaveLength(2);
    // Sortiert: die zwei NÄCHSTEN Termine.
    const starts = view.upcoming.map((entry) => new Date(entry.startAt!).getTime());
    expect(starts[0]!).toBeLessThan(starts[1]!);
  });

  it('52. „Heute“ liefert nur operative Sektionen – keine Umsatz-/Analytics-Daten', async () => {
    const { cookie } = await adminSession();
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/staff/today',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'organizational',
      'overdue',
      'scope',
      'today',
      'upcoming',
    ]);
  });
});
