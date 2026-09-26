/**
 * Phase-7-Pflichttests 111–118 (Order §77): Maschine bleibt nach Rückgabe in
 * Reinigung, „Gereinigt & einsatzbereit“, cleaned_by intern, keine
 * Reinigungshistorie in der normalen Ansicht, 24-h-Warnung (rot, zeitabhängig,
 * ohne Push), Verschwinden nach Reinigung.
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
import { createStaffWithPermissions, truncateCrmTables } from './crm-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { truncateSchedulingTables } from './scheduling-helpers.ts';
import { machineByCode, resetWarehouse } from './warehouse-helpers.ts';
import { truncateHandoverTables } from './handover-helpers.ts';
import { readyReturn, startedReturn } from './return-helpers.ts';

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
  return { admin, cookie: session.cookie };
}

async function returnedMachine(adminId: string) {
  const { world, services } = await startedReturn(ctx, adminId);
  await readyReturn(ctx, adminId, services, world.bookingId);
  await services.returns.finalize(adminId, world.bookingId);
  const machine = await machineByCode(ctx.db, 'MR-10-01-01');
  return { world, services, machine };
}

async function setCleaningSince(machineId: string, hoursAgo: number) {
  await ctx.pool.query(
    `UPDATE machines SET cleaning_since = now() - ($2 || ' hours')::interval WHERE id = $1`,
    [machineId, String(hoursAgo)],
  );
}

describe('111.–118. Reinigung nach Rückgabe', () => {
  it('111./112./113. Nach dem Return bleibt die Maschine in Reinigung; „Gereinigt & einsatzbereit“ setzt Einsatzbereit mit cleaned_by/cleaned_at', async () => {
    const { admin, cookie } = await adminSession();
    const { machine } = await returnedMachine(admin.id);
    expect(machine.status).toBe('cleaning');
    expect(machine.cleaningSince).not.toBeNull();
    expect(machine.cleanedAt).toBeNull();
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/clean-complete`,
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().machine.status).toBe('ready');
    const cleaned = await machineByCode(ctx.db, 'MR-10-01-01');
    expect(cleaned.status).toBe('ready');
    expect(cleaned.cleanedBy).toBe(admin.id);
    expect(cleaned.cleanedAt).not.toBeNull();
    expect(cleaned.cleaningSince).toBeNull();
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/clean-complete`,
      headers: { cookie },
      payload: {},
    });
    expect(again.statusCode).toBe(409);
  });

  it('114. Die normale Mitarbeiteransicht zeigt keine Reinigungshistorie – nur Admins sehen den letzten Reinigungsabschluss', async () => {
    const { admin, cookie } = await adminSession();
    const { services, machine } = await returnedMachine(admin.id);
    await services.returns.completeCleaning(admin.id, machine.id);
    const adminView = await ctx.app.inject({
      method: 'GET',
      url: `/staff/machines/${machine.id}/condition`,
      headers: { cookie },
    });
    expect(adminView.json().cleaning.cleanedBy).toBe(admin.id);
    expect(adminView.json().cleaning.cleanedAt).not.toBeNull();
    const staff = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Lena',
      lastName: 'Lager',
      email: 'lager@example.test',
      password: 'lager-passwort-123',
      permissionKeys: ['machine.view', 'return.view', 'process.view_all'],
    });
    const staffView = await ctx.app.inject({
      method: 'GET',
      url: `/staff/machines/${machine.id}/condition`,
      headers: { cookie: staff.cookie },
    });
    expect(staffView.statusCode).toBe(200);
    expect(staffView.json().cleaning.cleanedBy).toBeNull();
    expect(staffView.json().cleaning.cleanedAt).toBeNull();
    const tables = await ctx.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name ILIKE '%clean%'`,
    );
    expect(tables.rows).toEqual([]);
  });

  it('115./116./117./118. 24-h-Warnung ist zeitabhängig (rot in Maschinenansicht/Heute), vorher keine, verschwindet nach Reinigung, kein Push', async () => {
    const { admin, cookie } = await adminSession();
    const { services, machine } = await returnedMachine(admin.id);
    await setCleaningSince(machine.id, 23);
    expect(await services.returns.cleaningWarnings()).toEqual([]);
    expect((await services.returns.machineCondition(machine.id)).cleaning.overdue).toBe(false);
    await setCleaningSince(machine.id, 25);
    const warnings = await services.returns.cleaningWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ machineCode: 'MR-10-01-01', hoursInCleaning: 25 });
    expect((await services.returns.machineCondition(machine.id)).cleaning.overdue).toBe(true);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/staff/cleaning-warnings',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().warnings).toHaveLength(1);
    // Kein Push/Job: die Warnung ist rein abgeleitet – Abfragen erzeugen keinerlei
    // Datensätze (Jobs, Pakete, Incidents, Notizen) und verändern keine Maschine.
    const snapshot = async () =>
      (
        await ctx.pool.query(
          `SELECT (SELECT count(*) FROM integration_jobs) AS jobs,
                  (SELECT count(*) FROM delivery_packets) AS packets,
                  (SELECT count(*) FROM machine_risk_incidents) AS incidents,
                  (SELECT count(*) FROM process_notes) AS notes,
                  (SELECT max(updated_at) FROM machines) AS machines_updated`,
        )
      ).rows[0];
    const before = await snapshot();
    await services.returns.cleaningWarnings();
    await services.returns.machineCondition(machine.id);
    await ctx.app.inject({ method: 'GET', url: '/staff/cleaning-warnings', headers: { cookie } });
    expect(await snapshot()).toEqual(before);
    expect(Number(before.jobs)).toBe(0);
    await services.returns.completeCleaning(admin.id, machine.id);
    expect(await services.returns.cleaningWarnings()).toEqual([]);
    expect((await services.returns.machineCondition(machine.id)).cleaning.active).toBe(false);
    // Ein manuell auf Reinigung gesetzter Status ohne Rückgabe hat keinen Reinigungsbeginn → keine Warnung.
    await services.machineService.setStatus(machine.id, 'cleaning');
    expect(await services.returns.cleaningWarnings()).toEqual([]);
  });
});

describe('Review-Härtungen (Order §§37/38/52/53): manuelle Statuswechsel und Reinigungsphase', () => {
  it('R1. Reinigung → Einsatzbereit ist manuell gesperrt – nur „Gereinigt & einsatzbereit“ setzt cleaned_by/cleaned_at', async () => {
    const { admin, cookie } = await adminSession();
    const { services, machine } = await returnedMachine(admin.id);
    await expect(services.machineService.setStatus(machine.id, 'ready')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('Gereinigt & einsatzbereit'),
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/status`,
      headers: { cookie },
      payload: { status: 'ready' },
    });
    expect(response.statusCode).toBe(409);
    const unchanged = await machineByCode(ctx.db, 'MR-10-01-01');
    expect(unchanged.status).toBe('cleaning');
    expect(unchanged.cleanedAt).toBeNull();
    expect(unchanged.cleaningSince).not.toBeNull();
    const cleaned = await services.returns.completeCleaning(admin.id, machine.id);
    expect(cleaned.status).toBe('ready');
    expect(cleaned.cleanedBy).toBe(admin.id);
    expect(cleaned.cleanedAt).not.toBeNull();
    // Aus „Reparatur“ bleibt der manuelle Weg nach „Einsatzbereit“ erlaubt (Phase 5).
    await services.machineService.setStatus(machine.id, 'repair');
    expect((await services.machineService.setStatus(machine.id, 'ready')).status).toBe('ready');
  });

  it('R2. Verlässt die Maschine die Reinigung anderweitig, endet die Reinigungsphase: keine 24-h-Warnung, kein Nachtragsfenster – auch nach erneutem manuellem „Reinigung“', async () => {
    const { admin } = await adminSession();
    const { services, machine } = await returnedMachine(admin.id);
    await setCleaningSince(machine.id, 30);
    expect(await services.returns.cleaningWarnings()).toHaveLength(1);
    expect((await services.returns.machineCondition(machine.id)).postReturnFindingOpen).toBe(true);
    await services.machineService.setStatus(machine.id, 'repair');
    expect(await services.returns.cleaningWarnings()).toEqual([]);
    let condition = await services.returns.machineCondition(machine.id);
    expect(condition.cleaning).toMatchObject({ active: false, since: null, overdue: false });
    expect(condition.postReturnFindingOpen).toBe(false);
    // Manuell wieder „Reinigung“: keine Reinigungsphase nach Rückgabe, keine Warnung, kein Fenster.
    await services.machineService.setStatus(machine.id, 'cleaning');
    expect((await machineByCode(ctx.db, 'MR-10-01-01')).cleaningSince).toBeNull();
    expect(await services.returns.cleaningWarnings()).toEqual([]);
    condition = await services.returns.machineCondition(machine.id);
    expect(condition.cleaning).toMatchObject({ active: true, since: null, overdue: false });
    expect(condition.postReturnFindingOpen).toBe(false);
    // „Gereinigt & einsatzbereit“ funktioniert auch für eine manuell gesetzte Reinigung.
    expect((await services.returns.completeCleaning(admin.id, machine.id)).status).toBe('ready');
  });
});
