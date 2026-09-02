/**
 * Phase-4-Review-Regressionen (adversarialer Review): Sichtbarkeitsgarantie
 * für bestätigte Buchungen, Wochenend-Standard nur für Selbstabholung,
 * Incident-Lebenszyklus (identische Zeit erneut gerissen, interner
 * Abschluss, Storno, Selbstheilung), Zuständigkeits-Rückfall nach
 * Vertretungsende, gesperrte Vertretungen, Vorgangs-Sichtbarkeitsregel und
 * Eingabe-Plausibilität.
 */
import { appointmentOverdueIncidents, appointments } from '@mietroyal/database';
import { and, eq, isNull } from 'drizzle-orm';
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
import {
  adminVisibilityCtx,
  createStaffWithPermissions,
  processServiceFor,
  truncateCrmTables,
} from './crm-helpers.ts';
import {
  commerceServices,
  createCommerceWorld,
  inquiryServiceFor,
  productServiceFor,
  truncateCommerceTables,
} from './commerce-helpers.ts';
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

const HOURS = 3_600_000;

async function adminSession() {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  return { admin, cookie: session.cookie };
}

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
  return { scheduling, world, appointmentId: back.id };
}

describe('Sichtbarkeitsgarantie für bestätigte Buchungen (Order §4/§8/§22)', () => {
  it('Öffentliche Annahme erzeugt die Termine sofort (Routen-Hook)', async () => {
    const { admin } = await adminSession();
    const world = await createCommerceWorld(ctx, admin.id, {
      eventInDays: 30,
      fulfillment: 'pickup',
    });
    const machine = await productServiceFor(ctx).getProductBySlug('slush-2x10');
    await inquiryServiceFor(ctx).upsertForProcess(admin.id, world.processId, {
      eventDate: new Date(Date.now() + 30 * 24 * HOURS).toISOString().slice(0, 10),
      eventStart: null,
      eventEnd: null,
      guestCount: 40,
      occasion: 'birthday',
      machineProductId: machine.id,
      fulfillment: 'pickup',
      deliveryStreet: null,
      deliveryPostalCode: null,
      deliveryCity: null,
      deliveryWindowFrom: null,
      deliveryWindowTo: null,
      collectionWindowFrom: null,
      collectionWindowTo: null,
      selections: [],
    });
    const services = commerceServices(ctx);
    const { versionId } = await services.offers.createOffer(admin.id, world.processId);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    const { token } = await services.offers.send(admin.id, versionId, effective);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/public/offers/${token}/accept`,
    });
    expect(response.statusCode).toBe(200);
    const rows = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.processId, world.processId));
    expect(rows.map((row) => row.kind).sort()).toEqual(['pickup', 'return']);
  });

  it('Selbstheilung: Buchung ohne Termine erscheint trotzdem in Heute/Offen-Liste', async () => {
    const { admin } = await adminSession();
    const scheduling = schedulingServiceFor(ctx);
    // Buchung über den Service-Pfad (ohne Routen-Hook, ohne expliziten
    // Ensure) – simuliert den Fall "Terminerzeugung direkt nach der
    // Annahme fehlgeschlagen".
    const world = await createAcceptedBooking(ctx, admin.id, { fulfillment: 'pickup' });
    const open = await scheduling.listOrganizationalOpen(admin.id, 'all');
    const forBooking = open.filter((entry) => entry.bookingId === world.bookingId);
    expect(forBooking.map((entry) => entry.kind).sort()).toEqual(['pickup', 'return']);
    const view = await scheduling.todayView(admin.id, 'all');
    expect(view.organizational.filter((entry) => entry.bookingId === world.bookingId)).toHaveLength(
      2,
    );
  });

  it('Ungültiges Snapshot-Zeitfenster wird NICHT zu einer erfundenen exakten Zeit', async () => {
    const { admin } = await adminSession();
    const scheduling = schedulingServiceFor(ctx);
    const world = await createAcceptedBooking(ctx, admin.id, {
      fulfillment: 'pickup',
      collectionWindowFrom: new Date(Date.now() + 50 * HOURS),
      collectionWindowTo: new Date(Date.now() + 48 * HOURS), // Ende vor Beginn
    });
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    const rows = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.bookingId, world.bookingId));
    const pickup = rows.find((row) => row.kind === 'pickup')!;
    expect(pickup.startAt).toBeNull();
    expect(pickup.endAt).toBeNull();
  });
});

describe('Wochenend-Standard ist eine Selbstabholungs-Regel (Order §3/§6/§7)', () => {
  it('Lieferbuchung: Standard wird abgelehnt, das vereinbarte Fenster bleibt unangetastet', async () => {
    const { admin } = await adminSession();
    const scheduling = schedulingServiceFor(ctx);
    const windowFrom = new Date(Date.now() + 29 * 24 * HOURS);
    const windowTo = new Date(windowFrom.getTime() + 2 * HOURS);
    const world = await createAcceptedBooking(ctx, admin.id, {
      fulfillment: 'delivery',
      deliveryWindowFrom: windowFrom,
      deliveryWindowTo: windowTo,
    });
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    await expect(scheduling.applyWeekendStandard(admin.id, world.processId)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    const rows = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.bookingId, world.bookingId));
    const delivery = rows.find((row) => row.kind === 'delivery')!;
    expect(delivery.startAt?.toISOString()).toBe(windowFrom.toISOString());
    expect(delivery.endAt?.toISOString()).toBe(windowTo.toISOString());
  });
});

describe('Incident-Lebenszyklus (Order §24)', () => {
  it('Identische Rückgabezeit erneut gerissen → NEUER Incident (neuer Push-Anspruch)', async () => {
    const { admin } = await adminSession();
    const missed = new Date(Date.now() - 2 * HOURS);
    const { scheduling, appointmentId } = await returnAppointmentAt(admin.id, missed);
    let due = await scheduling.listDueOverdueAdminNotifications();
    const first = due.find((row) => row.appointmentId === appointmentId)!;
    expect(first).toBeDefined();

    // Neue Zukunftszeit beendet den Incident, danach Rückkehr zur ALTEN Zeit.
    let entry = await scheduling.entryById(appointmentId);
    await scheduling.reschedule(admin.id, appointmentId, {
      startAt: new Date(Date.now() + 24 * HOURS),
      endAt: null,
      expectedVersion: entry.version,
    });
    entry = await scheduling.entryById(appointmentId);
    await scheduling.reschedule(admin.id, appointmentId, {
      startAt: missed,
      endAt: null,
      expectedVersion: entry.version,
    });

    due = await scheduling.listDueOverdueAdminNotifications();
    const second = due.find((row) => row.appointmentId === appointmentId)!;
    expect(second).toBeDefined();
    expect(second.incidentId).not.toBe(first.incidentId);
    const incidents = await ctx.db
      .select()
      .from(appointmentOverdueIncidents)
      .where(eq(appointmentOverdueIncidents.appointmentId, appointmentId));
    expect(incidents).toHaveLength(2);
  });

  it('Interner Abschluss beendet offene Incidents – kein dauerhaft fälliger Admin-Push', async () => {
    const { admin } = await adminSession();
    const { scheduling, appointmentId } = await returnAppointmentAt(
      admin.id,
      new Date(Date.now() - 2 * HOURS),
      admin.id, // Abschluss verlangt einen zugewiesenen Mitarbeiter (Order §9)
    );
    let due = await scheduling.listDueOverdueAdminNotifications();
    expect(due.some((row) => row.appointmentId === appointmentId)).toBe(true);

    const entry = await scheduling.entryById(appointmentId);
    await scheduling.complete(admin.id, appointmentId, entry.version);

    due = await scheduling.listDueOverdueAdminNotifications();
    expect(due.some((row) => row.appointmentId === appointmentId)).toBe(false);
    const open = await ctx.db
      .select()
      .from(appointmentOverdueIncidents)
      .where(
        and(
          eq(appointmentOverdueIncidents.appointmentId, appointmentId),
          isNull(appointmentOverdueIncidents.resolvedAt),
        ),
      );
    expect(open).toHaveLength(0);
  });

  it('Vorgangs-Storno entfernt Termine aus Heute/Kalender/Offen und beendet Incidents', async () => {
    const { admin } = await adminSession();
    const { scheduling, world, appointmentId } = await returnAppointmentAt(
      admin.id,
      new Date(Date.now() - 2 * HOURS),
    );
    let view = await scheduling.todayView(admin.id, 'all');
    expect(view.overdue.some((entry) => entry.id === appointmentId)).toBe(true);

    await processServiceFor(ctx).cancel(world.processId, adminVisibilityCtx());

    view = await scheduling.todayView(admin.id, 'all');
    const all = [...view.overdue, ...view.today, ...view.organizational, ...view.upcoming];
    expect(all.some((entry) => entry.id === appointmentId)).toBe(false);
    expect(await scheduling.listDueOverdueAdminNotifications()).toHaveLength(0);
    expect(await scheduling.listOrganizationalOpen(admin.id, 'all')).toHaveLength(0);
    const calendar = await scheduling.listCalendar(admin.id, {
      from: new Date(Date.now() - 240 * HOURS),
      to: new Date(Date.now() + 240 * HOURS),
      scope: 'all',
    });
    expect(calendar.some((entry) => entry.id === appointmentId)).toBe(false);
  });

  it('Selbstheilung: Incident zu einer nicht mehr aktuellen Zeit wird gelöst (Race-Phantom)', async () => {
    const { admin } = await adminSession();
    const { scheduling, appointmentId } = await returnAppointmentAt(
      admin.id,
      new Date(Date.now() + 24 * HOURS),
    );
    // Phantom simulieren: offener Incident zu einer alten, überschrittenen
    // Zeit, die am Termin gar nicht mehr steht.
    await ctx.db.insert(appointmentOverdueIncidents).values({
      appointmentId,
      missedAt: new Date(Date.now() - 1 * HOURS),
    });
    expect(await scheduling.listDueOverdueAdminNotifications()).toHaveLength(0);
    const open = await ctx.db
      .select()
      .from(appointmentOverdueIncidents)
      .where(
        and(
          eq(appointmentOverdueIncidents.appointmentId, appointmentId),
          isNull(appointmentOverdueIncidents.resolvedAt),
        ),
      );
    expect(open).toHaveLength(0);
  });
});

describe('Zuständigkeits-Rückfall & inaktive Vertretungen (Order §12/§49)', () => {
  it('Nach Vertretungsende fällt die OFFENE Zuständigkeit vergangener Termine zurück', async () => {
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
    const { scheduling, appointmentId } = await returnAppointmentAt(
      admin.id,
      new Date(Date.now() - 2 * HOURS),
      anna.id,
    );
    const substitution = await substitutionServiceFor(ctx).create(admin.id, {
      originalUserId: anna.id,
      substituteUserId: bernd.id,
      startsAt: new Date(Date.now() - 3 * HOURS),
      endsAt: new Date(Date.now() + 48 * HOURS),
    });
    // Aktive Vertretung: der überfällige Alt-Termin gehört Bernd.
    let entry = await scheduling.entryById(appointmentId);
    expect(entry.effectiveAssigneeId).toBe(bernd.id);

    await substitutionServiceFor(ctx).endEarly(substitution.id);

    // Nach dem Ende gehört der weiterhin OFFENE Termin wieder Anna –
    // sichtbar in ihren „Meine Termine“, nicht mehr bei Bernd.
    entry = await scheduling.entryById(appointmentId);
    expect(entry.effectiveAssigneeId).toBe(anna.id);
    const annaView = await scheduling.todayView(anna.id, 'mine');
    expect(annaView.overdue.some((item) => item.id === appointmentId)).toBe(true);
    const berndView = await scheduling.todayView(bernd.id, 'mine');
    expect(berndView.overdue.some((item) => item.id === appointmentId)).toBe(false);
  });

  it('Gesperrte Vertretung übernimmt keine Termine mehr (Rückfall an das Original)', async () => {
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
    const { scheduling, appointmentId } = await returnAppointmentAt(
      admin.id,
      new Date(Date.now() + 24 * HOURS),
      anna.id,
    );
    await substitutionServiceFor(ctx).create(admin.id, {
      originalUserId: anna.id,
      substituteUserId: bernd.id,
      startsAt: new Date(Date.now() - 1 * HOURS),
      endsAt: new Date(Date.now() + 48 * HOURS),
    });
    let entry = await scheduling.entryById(appointmentId);
    expect(entry.effectiveAssigneeId).toBe(bernd.id);

    await ctx.pool.query(`UPDATE staff_users SET status = 'locked' WHERE id = $1`, [bernd.id]);
    entry = await scheduling.entryById(appointmentId);
    expect(entry.effectiveAssigneeId).toBe(anna.id);
    const reminders = await scheduling.listDueReminders();
    expect(reminders.every((row) => row.effectiveUserId !== bernd.id)).toBe(true);
  });
});

describe('Vorgangs-Sichtbarkeit & Eingabe-Plausibilität (Order §33/§49)', () => {
  it('Termin-Endpunkte respektieren die zentrale Vorgangs-Sichtbarkeitsregel', async () => {
    const { admin, cookie: adminCookie } = await adminSession();
    const limited = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Lena',
      lastName: 'Limitiert',
      email: 'lena.limitiert@test.example',
      password: 'lena-passwort-1234',
      permissionKeys: ['calendar.view', 'calendar.drag_drop', 'process.view_all'],
    });
    const { world } = await returnAppointmentAt(admin.id, new Date(Date.now() + 24 * HOURS));
    await processServiceFor(ctx).complete(world.processId, adminVisibilityCtx());
    // Abschluss weit außerhalb des Sichtbarkeitsfensters „altern“ lassen.
    await ctx.pool.query(
      `UPDATE processes SET completed_at = now() - interval '400 days' WHERE id = $1`,
      [world.processId],
    );

    for (const [method, url] of [
      ['GET', `/staff/processes/${world.processId}/appointments`],
      ['POST', `/staff/processes/${world.processId}/appointments/weekend-standard`],
    ] as const) {
      const response = await ctx.app.inject({
        method,
        url,
        headers: { cookie: limited.cookie },
      });
      expect(response.statusCode, url).toBe(404);
    }
    // Mit process.view_completed (Systemadmin) bleibt der Zugriff möglich.
    const adminRead = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${world.processId}/appointments`,
      headers: { cookie: adminCookie },
    });
    expect(adminRead.statusCode).toBe(200);
  });

  it('Übernahmebestätigung: fremde Termin-IDs antworten neutral mit 404 (kein Oracle)', async () => {
    const { admin } = await adminSession();
    const outsider = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Otto',
      lastName: 'Outsider',
      email: 'otto.outsider@test.example',
      password: 'otto-passwort-1234',
      permissionKeys: ['calendar.view'],
    });
    const { appointmentId } = await returnAppointmentAt(
      admin.id,
      new Date(Date.now() + 24 * HOURS),
      admin.id,
    );
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/appointments/${appointmentId}/acknowledge`,
      headers: { cookie: outsider.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('Fachlich unmögliche Jahreszahlen werden verständlich abgelehnt', async () => {
    const { admin, cookie } = await adminSession();
    const { appointmentId, scheduling } = await returnAppointmentAt(
      admin.id,
      new Date(Date.now() + 24 * HOURS),
    );
    const entry = await scheduling.entryById(appointmentId);
    for (const startAt of ['3025-01-01T10:00:00.000Z', '1999-01-01T10:00:00.000Z']) {
      const response = await ctx.app.inject({
        method: 'PATCH',
        url: `/staff/appointments/${appointmentId}/schedule`,
        headers: { cookie },
        payload: { startAt, endAt: null, expectedVersion: entry.version },
      });
      expect(response.statusCode, startAt).toBe(400);
    }
  });
});
