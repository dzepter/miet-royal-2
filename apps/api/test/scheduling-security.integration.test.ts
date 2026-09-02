/**
 * Phase-4-Pflichttests 53–60: serverseitige Rechte (Kalender, Reschedule,
 * Reassignment, Mitarbeiterfilter), Appointment-IDOR, Datenminimierung,
 * Demo/Production-Isolation und parallele Terminupdates (Races).
 */
import { loadConfig, assertConfigsIsolated } from '@mietroyal/config';
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

async function scheduledAppointment(adminId: string, assignTo: string | null = null) {
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
  const pickup = rows.find((row) => row.kind === 'pickup')!;
  await scheduling.reschedule(adminId, pickup.id, {
    startAt: new Date(Date.now() + 72 * HOURS),
    endAt: null,
    expectedVersion: pickup.version,
  });
  return { scheduling, world, appointmentId: pickup.id };
}

describe('53.–56./58. Serverseitige Rechte', () => {
  it('53. Kalenderzugriff ohne calendar.view ist blockiert', async () => {
    const { admin } = await adminSession();
    const noCalendar = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Nora',
      lastName: 'Nichts',
      email: 'nora.nichts@test.example',
      password: 'nora-passwort-1234',
      permissionKeys: ['customer.view'],
    });
    for (const url of [
      '/staff/today',
      '/staff/calendar?from=2026-01-01&to=2026-12-31',
      '/staff/appointments/open',
    ]) {
      const response = await ctx.app.inject({
        method: 'GET',
        url,
        headers: { cookie: noCalendar.cookie },
      });
      expect(response.statusCode, url).toBe(403);
    }
  });

  it('54. Appointment-IDOR: fremde Termin-IDs sind ohne view_all weder les- noch änderbar (neutral 404)', async () => {
    const { admin } = await adminSession();
    const outsider = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Ivo',
      lastName: 'Idor',
      email: 'ivo.idor@test.example',
      password: 'ivo-passwort-1234',
      permissionKeys: ['calendar.view', 'calendar.drag_drop', 'appointment.assign'],
    });
    // Termin gehört (effektiv) dem Admin – nicht Ivo.
    const { appointmentId } = await scheduledAppointment(admin.id, admin.id);

    const read = await ctx.app.inject({
      method: 'GET',
      url: `/staff/appointments/${appointmentId}`,
      headers: { cookie: outsider.cookie },
    });
    expect(read.statusCode).toBe(404);

    const reschedule = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/appointments/${appointmentId}/schedule`,
      headers: { cookie: outsider.cookie },
      payload: { startAt: new Date(Date.now() + 96 * HOURS).toISOString(), expectedVersion: 2 },
    });
    expect(reschedule.statusCode).toBe(404);

    const assign = await ctx.app.inject({
      method: 'POST',
      url: `/staff/appointments/${appointmentId}/assign`,
      headers: { cookie: outsider.cookie },
      payload: { userId: outsider.user.id, expectedVersion: 2 },
    });
    expect(assign.statusCode).toBe(404);

    // Der eigene (effektive) Termin bleibt erreichbar.
    const own = await scheduledAppointment(admin.id, outsider.user.id);
    const ownRead = await ctx.app.inject({
      method: 'GET',
      url: `/staff/appointments/${own.appointmentId}`,
      headers: { cookie: outsider.cookie },
    });
    expect(ownRead.statusCode).toBe(200);
  });

  it('55./56. Reassignment/Reschedule ohne das jeweilige Recht → 403', async () => {
    const { admin } = await adminSession();
    const viewer = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Vera',
      lastName: 'Viewer',
      email: 'vera.viewer@test.example',
      password: 'vera-passwort-1234',
      permissionKeys: ['calendar.view'],
    });
    const { appointmentId } = await scheduledAppointment(admin.id, viewer.user.id);

    const reschedule = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/appointments/${appointmentId}/schedule`,
      headers: { cookie: viewer.cookie },
      payload: { startAt: new Date(Date.now() + 96 * HOURS).toISOString(), expectedVersion: 2 },
    });
    expect(reschedule.statusCode).toBe(403);

    const assign = await ctx.app.inject({
      method: 'POST',
      url: `/staff/appointments/${appointmentId}/assign`,
      headers: { cookie: viewer.cookie },
      payload: { userId: viewer.user.id, expectedVersion: 2 },
    });
    expect(assign.statusCode).toBe(403);

    // Gleiche-Tages-Reassignment braucht ZUSÄTZLICH das eigene Recht.
    const assigner = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Axel',
      lastName: 'Assign',
      email: 'axel.assign@test.example',
      password: 'axel-passwort-1234',
      permissionKeys: ['calendar.view', 'calendar.view_all', 'appointment.assign'],
    });
    const scheduling = schedulingServiceFor(ctx);
    const entry = await scheduling.entryById(appointmentId);
    await scheduling.reschedule(admin.id, appointmentId, {
      startAt: new Date(Date.now() + 10 * 60_000),
      endAt: null,
      expectedVersion: entry.version,
    });
    const sameDay = await ctx.app.inject({
      method: 'POST',
      url: `/staff/appointments/${appointmentId}/assign`,
      headers: { cookie: assigner.cookie },
      payload: { userId: assigner.user.id, expectedVersion: entry.version + 1 },
    });
    expect(sameDay.statusCode).toBe(403);
  });

  it('58. Mitarbeiterfilter und „Alle Termine“ sind an calendar.view_all gebunden', async () => {
    const { admin } = await adminSession();
    const viewer = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Mia',
      lastName: 'Mine',
      email: 'mia.mine@test.example',
      password: 'mia-passwort-1234',
      permissionKeys: ['calendar.view'],
    });
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 30 * 24 * HOURS).toISOString();
    const all = await ctx.app.inject({
      method: 'GET',
      url: `/staff/calendar?from=${from}&to=${to}&scope=all`,
      headers: { cookie: viewer.cookie },
    });
    expect(all.statusCode).toBe(403);
    const filtered = await ctx.app.inject({
      method: 'GET',
      url: `/staff/calendar?from=${from}&to=${to}&userId=${admin.id}`,
      headers: { cookie: viewer.cookie },
    });
    expect(filtered.statusCode).toBe(403);
    // scope=mine funktioniert und liefert nur die effektiv eigenen Termine.
    const mine = await ctx.app.inject({
      method: 'GET',
      url: `/staff/calendar?from=${from}&to=${to}`,
      headers: { cookie: viewer.cookie },
    });
    expect(mine.statusCode).toBe(200);
    expect((mine.json() as { scope: string }).scope).toBe('mine');
  });
});

describe('57. Datenminimierung', () => {
  it('Kalender-/Heute-Daten enthalten keine Rechnungsadresse', async () => {
    const { admin, cookie } = await adminSession();
    const { world, appointmentId } = await scheduledAppointment(admin.id, admin.id);
    // Kunde bekommt eine Rechnungsadresse …
    await ctx.pool.query(
      `UPDATE customers SET billing_street = 'Geheime Rechnungsstraße 9',
       billing_postal_code = '55129', billing_city = 'Mainz' WHERE id = $1`,
      [world.customerId],
    );
    // … die in Kalender/Heute/Preview NIRGENDS auftaucht.
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 30 * 24 * HOURS).toISOString();
    for (const url of [
      `/staff/calendar?from=${from}&to=${to}&scope=all`,
      '/staff/today',
      `/staff/appointments/${appointmentId}`,
    ]) {
      const response = await ctx.app.inject({ method: 'GET', url, headers: { cookie } });
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).not.toContain('Rechnungsstraße');
      expect(response.body, url).not.toContain('billingStreet');
    }
  });
});

describe('59. Demo/Production-Isolation', () => {
  it('assertConfigsIsolated erkennt Kollisionen weiterhin (DB + Storage)', () => {
    const base = {
      APP_ENV: 'production',
      DATABASE_URL: 'postgresql://prod:SYNTH@db-prod.internal:5432/mietroyal_prod',
      AUTH_SECRET_KEY: '1'.repeat(64),
      STORAGE_DRIVER: 's3',
      STORAGE_S3_ENDPOINT: 'https://s3.synthetic.example',
      STORAGE_S3_REGION: 'eu-central-1',
      STORAGE_S3_BUCKET: 'mietroyal-prod-documents',
      STORAGE_S3_ACCESS_KEY_ID: 'SYNTH-PROD',
      STORAGE_S3_SECRET_ACCESS_KEY: 'SYNTH-prod-secret',
    };
    const production = loadConfig(base);
    const demo = loadConfig({
      ...base,
      APP_ENV: 'demo',
      DATABASE_URL: 'postgresql://demo:SYNTH@db-demo.internal:5432/mietroyal_demo',
      AUTH_SECRET_KEY: '2'.repeat(64),
      STORAGE_S3_BUCKET: 'mietroyal-demo-documents',
      STORAGE_S3_ACCESS_KEY_ID: 'SYNTH-DEMO',
      STORAGE_S3_SECRET_ACCESS_KEY: 'SYNTH-demo-secret',
    });
    expect(() => assertConfigsIsolated(production, demo)).not.toThrow();
    const collidingDemo = loadConfig({
      ...base,
      APP_ENV: 'demo',
      AUTH_SECRET_KEY: '2'.repeat(64),
    });
    expect(() => assertConfigsIsolated(production, collidingDemo)).toThrow();
  });
});

describe('60. Parallele Terminupdates', () => {
  it('Zwei parallele Reschedules mit derselben Version: genau einer gewinnt, nichts wird still überschrieben', async () => {
    const { admin } = await adminSession();
    const { scheduling, appointmentId } = await scheduledAppointment(admin.id, admin.id);
    const entry = await scheduling.entryById(appointmentId);
    const targetA = new Date(Date.now() + 100 * HOURS);
    const targetB = new Date(Date.now() + 200 * HOURS);
    const [a, b] = await Promise.allSettled([
      scheduling.reschedule(admin.id, appointmentId, {
        startAt: targetA,
        endAt: null,
        expectedVersion: entry.version,
      }),
      scheduling.reschedule(admin.id, appointmentId, {
        startAt: targetB,
        endAt: null,
        expectedVersion: entry.version,
      }),
    ]);
    const outcomes = [a, b];
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const after = await scheduling.entryById(appointmentId);
    const winner = fulfilled[0]!.status === 'fulfilled' ? fulfilled[0]!.value : null;
    expect(after.startAt).toBe(winner?.startAt?.toISOString() ?? null);
    expect([targetA.toISOString(), targetB.toISOString()]).toContain(after.startAt);
    expect(after.version).toBe(entry.version + 1);
  });
});
