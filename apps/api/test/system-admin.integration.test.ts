/**
 * Phase-2-Finalisierung: stabile Systemadmin-Semantik (Pflichttests 1–9).
 * Ein Systemadmin (Mitglied einer Rolle mit is_system_admin) besitzt
 * dynamisch ALLE Katalogrechte – auch zukünftig neu eingeführte. Läuft
 * gegen echtes PostgreSQL.
 */
import { PERMISSION_DEFINITIONS, fullPermissionSet } from '@mietroyal/permissions';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bootstrapAdmin,
  createEmployeeWithPassword,
  createTestContext,
  destroyTestContext,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateAuthTables(ctx.pool);
});

async function systemRoleId(): Promise<string> {
  const roles = await ctx.admin.listRoles();
  const role = roles.find((r) => r.isSystemAdmin);
  expect(role).toBeDefined();
  return role!.id;
}

describe('Systemadmin-Semantik (Phase-2-Finalisierung)', () => {
  it('1. Bestehender Bootstrap-Admin ist Systemadmin (stabile Eigenschaft, nicht der Name)', async () => {
    const admin = await bootstrapAdmin(ctx);
    expect(await ctx.auth.isSystemAdmin(admin.id)).toBe(true);
    // Die Eigenschaft hängt an is_system_admin, nicht am Anzeigenamen:
    const roles = await ctx.admin.listRoles();
    expect(roles.find((r) => r.isSystemAdmin)).toBeDefined();
  });

  it('2. Systemadmin besitzt alle aktuellen Permission Keys des Katalogs', async () => {
    const admin = await bootstrapAdmin(ctx);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    expect(effective.size).toBe(PERMISSION_DEFINITIONS.length);
    for (const definition of PERMISSION_DEFINITIONS) {
      expect(effective.has(definition.key), definition.key).toBe(true);
    }
  });

  it('3. Neu zum Katalog hinzugefügtes Recht gilt automatisch (dieselbe Ableitungsfunktion)', async () => {
    const admin = await bootstrapAdmin(ctx);
    // Die effektiven Rechte eines Systemadmins sind exakt fullPermissionSet():
    const effective = await ctx.auth.effectivePermissions(admin.id);
    expect([...effective].sort()).toEqual([...fullPermissionSet()].sort());
    // Zukunftssicherheit: dieselbe Funktion mit synthetisch erweitertem
    // Katalog enthält den neuen Key ohne jede Rollenzuweisung.
    const extended = fullPermissionSet([...PERMISSION_DEFINITIONS, { key: 'zukunft.testrecht' }]);
    expect(extended.has('zukunft.testrecht' as never)).toBe(true);
    expect(extended.size).toBe(PERMISSION_DEFINITIONS.length + 1);
  });

  it('4. Individueller Deny entfernt Systemadmin-Rechte NICHT', async () => {
    const admin = await bootstrapAdmin(ctx);
    await ctx.admin.addOverride(admin.id, admin.id, {
      permissionKey: 'employee.manage',
      effect: 'deny',
    });
    const effective = await ctx.auth.effectivePermissions(admin.id);
    expect(effective.has('employee.manage')).toBe(true);
    expect(effective.size).toBe(PERMISSION_DEFINITIONS.length);
  });

  it('5. Normale Rolle erhält neue Katalogrechte NICHT automatisch', async () => {
    const admin = await bootstrapAdmin(ctx);
    const employee = await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Nora',
      lastName: 'Normal',
      email: 'normal@test.example',
      password: 'normal-passwort-123',
    });
    const roleId = await ctx.admin.createRole(admin.id, {
      name: 'Kundendienst',
      permissionKeys: ['customer.view', 'process.view_all'],
    });
    await ctx.admin.setUserRoles(admin.id, employee.id, [roleId]);
    const effective = await ctx.auth.effectivePermissions(employee.id);
    expect([...effective].sort()).toEqual(['customer.view', 'process.view_all']);
    expect(await ctx.auth.isSystemAdmin(employee.id)).toBe(false);
  });

  it('6. Letzter Systemadmin kann nicht entfernt, deaktiviert oder gesperrt werden', async () => {
    const admin = await bootstrapAdmin(ctx);
    await expect(ctx.admin.setUserStatus(admin.id, admin.id, 'disabled')).rejects.toMatchObject({
      code: 'LAST_ADMIN',
    });
    await expect(ctx.admin.setUserStatus(admin.id, admin.id, 'locked')).rejects.toMatchObject({
      code: 'LAST_ADMIN',
    });
    await expect(ctx.admin.setUserRoles(admin.id, admin.id, [])).rejects.toMatchObject({
      code: 'LAST_ADMIN',
    });
    expect(await ctx.auth.isSystemAdmin(admin.id)).toBe(true);
  });

  it('7. Bei zwei Systemadmins kann einer entfernt werden', async () => {
    const admin = await bootstrapAdmin(ctx);
    const second = await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Berta',
      lastName: 'Backup',
      email: 'backup@test.example',
      password: 'backup-passwort-1234',
    });
    const roleId = await systemRoleId();
    await ctx.admin.setUserRoles(admin.id, second.id, [roleId]);
    expect(await ctx.auth.isSystemAdmin(second.id)).toBe(true);

    // Einer von zwei darf die Eigenschaft verlieren …
    await ctx.admin.setUserRoles(admin.id, second.id, []);
    expect(await ctx.auth.isSystemAdmin(second.id)).toBe(false);
    // … der letzte danach wieder nicht.
    await expect(ctx.admin.setUserRoles(admin.id, admin.id, [])).rejects.toMatchObject({
      code: 'LAST_ADMIN',
    });
  });

  it('8. Nicht-Systemadmin darf niemanden zum Systemadmin machen (auch mit permission.manage)', async () => {
    const admin = await bootstrapAdmin(ctx);
    const manager = await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Paula',
      lastName: 'Personal',
      email: 'personal@test.example',
      password: 'personal-passwort-123',
    });
    const managerRole = await ctx.admin.createRole(admin.id, {
      name: 'Personalverwaltung',
      permissionKeys: ['employee.manage', 'permission.manage'],
    });
    await ctx.admin.setUserRoles(admin.id, manager.id, [managerRole]);

    const victim = await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Otto',
      lastName: 'Opfer',
      email: 'opfer@test.example',
      password: 'opfer-passwort-1234',
    });
    const roleId = await systemRoleId();
    // Ernennung durch Nicht-Systemadmin → 403, keine Eigenschaft vergeben.
    await expect(ctx.admin.setUserRoles(manager.id, victim.id, [roleId])).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await ctx.auth.isSystemAdmin(victim.id)).toBe(false);
    // Auch Selbst-Ernennung scheitert:
    await expect(
      ctx.admin.setUserRoles(manager.id, manager.id, [managerRole, roleId]),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Und der ENTZUG durch einen Nicht-Systemadmin ebenfalls:
    await expect(ctx.admin.setUserRoles(manager.id, admin.id, [])).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('9. Systemadmin darf weiteren Systemadmin ernennen (mit Audit-Ereignis)', async () => {
    const admin = await bootstrapAdmin(ctx);
    const second = await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Berta',
      lastName: 'Backup',
      email: 'backup@test.example',
      password: 'backup-passwort-1234',
    });
    const roleId = await systemRoleId();
    await ctx.admin.setUserRoles(admin.id, second.id, [roleId]);
    expect(await ctx.auth.isSystemAdmin(second.id)).toBe(true);
    const effective = await ctx.auth.effectivePermissions(second.id);
    expect(effective.size).toBe(PERMISSION_DEFINITIONS.length);

    // Sicherheitskritische Änderung ist auditiert:
    const events = await ctx.admin.listSecurityEvents(second.id);
    expect(events.some((e) => e.type === 'permission.system_admin_granted')).toBe(true);

    // Entzug durch Systemadmin ist auditiert:
    await ctx.admin.setUserRoles(admin.id, second.id, []);
    const eventsAfter = await ctx.admin.listSecurityEvents(second.id);
    expect(eventsAfter.some((e) => e.type === 'permission.system_admin_revoked')).toBe(true);
  });
});
