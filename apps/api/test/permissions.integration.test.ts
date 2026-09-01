/**
 * Phase-1-Pflichttests 12–19: Berechtigungssystem (Allow/Deny, Rollen,
 * befristete Sonderrechte, Sofortwirkung, manipulierte Anfragen,
 * Letzter-Admin-Schutz). Läuft gegen echtes PostgreSQL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthError } from '../src/auth/service.ts';
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

const EMPLOYEE_EMAIL = 'worker@test.example';
const EMPLOYEE_PASSWORD = 'worker-passwort-123';

async function setup() {
  const admin = await bootstrapAdmin(ctx);
  const employee = await createEmployeeWithPassword(ctx, admin.id, {
    firstName: 'Willi',
    lastName: 'Worker',
    email: EMPLOYEE_EMAIL,
    password: EMPLOYEE_PASSWORD,
  });
  return { admin, employee };
}

describe('12.–14. Allow / Deny / Rolle + Override', () => {
  it('12. Rollenrecht erlaubt den Zugriff (Permission-Allow)', async () => {
    const { admin, employee } = await setup();
    const roleId = await ctx.admin.createRole(admin.id, {
      name: 'Verwaltung',
      permissionKeys: ['employee.manage'],
    });
    await ctx.admin.setUserRoles(admin.id, employee.id, [roleId]);

    const session = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/staff/users',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
  });

  it('13. Deny-Override entzieht ein Rollenrecht (Permission-Deny)', async () => {
    const { admin, employee } = await setup();
    const roleId = await ctx.admin.createRole(admin.id, {
      name: 'Verwaltung',
      permissionKeys: ['employee.manage'],
    });
    await ctx.admin.setUserRoles(admin.id, employee.id, [roleId]);
    await ctx.admin.addOverride(admin.id, employee.id, {
      permissionKey: 'employee.manage',
      effect: 'deny',
    });

    const session = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/staff/users',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it('14. Rolle + individueller Allow-Override ergänzen sich', async () => {
    const { admin, employee } = await setup();
    const roleId = await ctx.admin.createRole(admin.id, {
      name: 'Basis',
      permissionKeys: ['customer.view'],
    });
    await ctx.admin.setUserRoles(admin.id, employee.id, [roleId]);
    await ctx.admin.addOverride(admin.id, employee.id, {
      permissionKey: 'offer.change_price',
      effect: 'allow',
    });

    const effective = await ctx.auth.effectivePermissions(employee.id);
    expect(effective.has('customer.view')).toBe(true); // aus Rolle
    expect(effective.has('offer.change_price')).toBe(true); // aus Override
    expect(effective.has('employee.manage')).toBe(false);
  });
});

describe('15./16. Befristete Sonderrechte', () => {
  it('15. gilt innerhalb der Laufzeit', async () => {
    const { admin, employee } = await setup();
    await ctx.admin.addOverride(admin.id, employee.id, {
      permissionKey: 'employee.manage',
      effect: 'allow',
      validFrom: new Date(Date.now() - 60_000),
      validUntil: new Date(Date.now() + 60 * 60_000),
    });

    const session = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/staff/users',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
  });

  it('16. gilt nach Ablauf nicht mehr – ohne Background-Job, rein zeitbasiert', async () => {
    const { admin, employee } = await setup();
    await ctx.admin.addOverride(admin.id, employee.id, {
      permissionKey: 'employee.manage',
      effect: 'allow',
      validFrom: new Date(Date.now() - 2 * 60 * 60_000),
      validUntil: new Date(Date.now() - 60_000), // vor einer Minute abgelaufen
    });

    const session = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/staff/users',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('17. Rechteänderung wirkt sofort', () => {
  it('gilt in der laufenden Session ohne erneuten Login – in beide Richtungen', async () => {
    const { admin, employee } = await setup();
    const session = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD);

    // Vorher: kein Recht.
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/staff/users',
          headers: { cookie: session.cookie },
        })
      ).statusCode,
    ).toBe(403);

    // Admin vergibt das Recht → dieselbe Session darf sofort.
    const overrideId = await ctx.admin.addOverride(admin.id, employee.id, {
      permissionKey: 'employee.manage',
      effect: 'allow',
    });
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/staff/users',
          headers: { cookie: session.cookie },
        })
      ).statusCode,
    ).toBe(200);

    // Admin entzieht es wieder → sofort 403, weiterhin ohne neuen Login.
    await ctx.admin.removeOverride(admin.id, overrideId);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/staff/users',
          headers: { cookie: session.cookie },
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('18. Manipulierte Anfragen ohne Recht', () => {
  it('kritische Admin-Aktionen werden serverseitig mit 403 verweigert', async () => {
    const { admin, employee } = await setup();
    const session = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD);

    const attempts = [
      {
        method: 'POST' as const,
        url: `/staff/users/${admin.id}/status`,
        payload: { status: 'locked' },
      },
      {
        method: 'POST' as const,
        url: '/staff/users',
        payload: { firstName: 'Hack', lastName: 'Er', email: 'hacker@test.example' },
      },
      {
        method: 'POST' as const,
        url: `/staff/users/${employee.id}/overrides`,
        payload: { permissionKey: 'employee.manage', effect: 'allow' },
      },
      {
        method: 'POST' as const,
        url: '/staff/roles',
        payload: { name: 'Root', permissionKeys: [] },
      },
      { method: 'POST' as const, url: `/staff/users/${admin.id}/sessions/revoke-all`, payload: {} },
    ];
    for (const attempt of attempts) {
      const response = await ctx.app.inject({
        method: attempt.method,
        url: attempt.url,
        headers: { cookie: session.cookie },
        payload: attempt.payload,
      });
      expect(response.statusCode, `${attempt.method} ${attempt.url}`).toBe(403);
    }

    // Und der Admin ist unbeeinträchtigt.
    expect((await ctx.auth.findUserById(admin.id))?.status).toBe('active');
  });

  it('IDOR: fremde Session kann nicht über den Selbstbedienungs-Endpunkt widerrufen werden', async () => {
    const { admin } = await setup();
    await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const adminSessions = await ctx.admin.listUserSessions(admin.id);
    const employeeSession = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/auth/sessions/${adminSessions[0]!.id}/revoke`,
      headers: { cookie: employeeSession.cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    const stillActive = await ctx.admin.listUserSessions(admin.id);
    expect(stillActive[0]!.revokedAt).toBeNull();
  });
});

describe('19. Letzter aktiver Admin ist geschützt', () => {
  it('kann nicht gesperrt oder deaktiviert werden', async () => {
    const { admin } = await setup();
    await expect(ctx.admin.setUserStatus(admin.id, admin.id, 'locked')).rejects.toMatchObject({
      code: 'LAST_ADMIN',
    });
    await expect(ctx.admin.setUserStatus(admin.id, admin.id, 'disabled')).rejects.toMatchObject({
      code: 'LAST_ADMIN',
    });
    expect((await ctx.auth.findUserById(admin.id))?.status).toBe('active');
  });

  it('kann seine Admin-Rechte nicht per Rollenentzug, Deny oder Rollenänderung verlieren', async () => {
    const { admin } = await setup();

    await expect(ctx.admin.setUserRoles(admin.id, admin.id, [])).rejects.toMatchObject({
      code: 'LAST_ADMIN',
    });
    await expect(
      ctx.admin.addOverride(admin.id, admin.id, {
        permissionKey: 'permission.manage',
        effect: 'deny',
      }),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN' });

    const roles = await ctx.admin.listRoles();
    const adminRole = roles.find((r) => r.name === 'Administrator');
    await expect(
      ctx.admin.updateRole(admin.id, adminRole!.id, { permissionKeys: ['customer.view'] }),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    await expect(ctx.admin.deleteRole(admin.id, adminRole!.id)).rejects.toMatchObject({
      code: 'LAST_ADMIN',
    });

    // Alles unverändert wirksam:
    const effective = await ctx.auth.effectivePermissions(admin.id);
    expect(effective.has('employee.manage')).toBe(true);
    expect(effective.has('permission.manage')).toBe(true);
  });

  it('mit einem zweiten aktiven Admin sind dieselben Aktionen erlaubt', async () => {
    const { admin } = await setup();
    const second = await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Berta',
      lastName: 'Backup',
      email: 'backup@test.example',
      password: 'backup-passwort-1234',
    });
    const roles = await ctx.admin.listRoles();
    const adminRole = roles.find((r) => r.name === 'Administrator');
    await ctx.admin.setUserRoles(admin.id, second.id, [adminRole!.id]);

    // Jetzt darf der erste Admin gesperrt werden.
    await ctx.admin.setUserStatus(second.id, admin.id, 'locked');
    expect((await ctx.auth.findUserById(admin.id))?.status).toBe('locked');

    // Aber der nun letzte Admin ist wieder geschützt.
    await expect(ctx.admin.setUserStatus(second.id, second.id, 'locked')).rejects.toMatchObject({
      code: 'LAST_ADMIN',
    });
  });

  it('Fehlerobjekt ist ein AuthError mit verständlicher Meldung', async () => {
    const { admin } = await setup();
    try {
      await ctx.admin.setUserStatus(admin.id, admin.id, 'disabled');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).message).toContain('Administrator');
    }
  });
});

describe('19b. Letzter-Admin-Schutz: zeitliche Robustheit (Review-Fix)', () => {
  it('vordatierter Deny auf den einzigen Admin wird abgelehnt', async () => {
    const { admin } = await setup();
    await expect(
      ctx.admin.addOverride(admin.id, admin.id, {
        permissionKey: 'employee.manage',
        effect: 'deny',
        validFrom: new Date(Date.now() + 60_000), // greift erst in 1 Minute
      }),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN' });
  });

  it('Deaktivieren des letzten permanenten Admins wird abgelehnt, wenn die Vertretung nur ein auslaufendes Sonderrecht hat', async () => {
    const { admin } = await setup();
    const cover = await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Vera',
      lastName: 'Vertretung',
      email: 'vertretung@test.example',
      password: 'vertretung-passwort-1',
    });
    // Befristete Admin-Fähigkeit für die Vertretung (läuft in 1 h aus).
    for (const key of ['employee.manage', 'permission.manage'] as const) {
      await ctx.admin.addOverride(admin.id, cover.id, {
        permissionKey: key,
        effect: 'allow',
        validUntil: new Date(Date.now() + 60 * 60_000),
      });
    }
    // Ohne Zeitprüfung würde das durchgehen – nach Ablauf gäbe es keinen Admin.
    await expect(ctx.admin.setUserStatus(admin.id, admin.id, 'disabled')).rejects.toMatchObject({
      code: 'LAST_ADMIN',
    });

    // Mit UNBEFRISTETER Vertretungs-Fähigkeit ist es erlaubt.
    for (const key of ['employee.manage', 'permission.manage'] as const) {
      await ctx.admin.addOverride(admin.id, cover.id, { permissionKey: key, effect: 'allow' });
    }
    await ctx.admin.setUserStatus(admin.id, admin.id, 'disabled');
    expect((await ctx.auth.findUserById(admin.id))?.status).toBe('disabled');
  });

  it('zwei gleichzeitige Sperrungen der letzten beiden Admins: genau eine gewinnt (kein Write-Skew)', async () => {
    const { admin } = await setup();
    const second = await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Zeno',
      lastName: 'Zweitadmin',
      email: 'zweitadmin@test.example',
      password: 'zweitadmin-passwort-1',
    });
    const roles = await ctx.admin.listRoles();
    const adminRole = roles.find((r) => r.name === 'Administrator');
    await ctx.admin.setUserRoles(admin.id, second.id, [adminRole!.id]);

    const results = await Promise.allSettled([
      ctx.admin.setUserStatus(admin.id, second.id, 'locked'),
      ctx.admin.setUserStatus(second.id, admin.id, 'locked'),
    ]);
    const failed = results.filter((r) => r.status === 'rejected');
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'LAST_ADMIN' });

    // Genau einer der beiden Admins ist gesperrt, einer bleibt aktiv
    // (der dritte Nutzer "Willi Worker" aus setup() zählt nicht mit).
    const users = await ctx.admin.listUsers();
    const statusById = new Map(users.map((u) => [u.id, u.status]));
    const adminStatuses = [statusById.get(admin.id), statusById.get(second.id)];
    expect(adminStatuses.filter((s) => s === 'active')).toHaveLength(1);
    expect(adminStatuses.filter((s) => s === 'locked')).toHaveLength(1);
  });
});

describe('Admin-Reset-Weg (Review-Fix)', () => {
  it('employee.manage kann einen einmaligen Reset-Link erzeugen; damit ist neues Passwort + Login möglich', async () => {
    const { admin, employee } = await setup();
    const adminSession = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/users/${employee.id}/reset-link`,
      headers: { cookie: adminSession.cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const { resetToken } = response.json();

    const reset = await ctx.app.inject({
      method: 'POST',
      url: '/auth/password/reset',
      payload: { token: resetToken, newPassword: 'neu-gesetztes-passwort-1' },
    });
    expect(reset.statusCode).toBe(200);
    expect((await login(ctx.app, EMPLOYEE_EMAIL, 'neu-gesetztes-passwort-1')).statusCode).toBe(200);

    // Ohne Recht: 403.
    const employeeSession = await login(ctx.app, EMPLOYEE_EMAIL, 'neu-gesetztes-passwort-1');
    const forbidden = await ctx.app.inject({
      method: 'POST',
      url: `/staff/users/${admin.id}/reset-link`,
      headers: { cookie: employeeSession.cookie },
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
