/**
 * Phase-1-Pflichttests 1–11 (PHASE-1-Vorgabe Nr. 19): Bootstrap, Login,
 * Kontostatus, Sessions/Geräte, Passwortwechsel/-reset, 30-Tage-Ablauf.
 * Läuft gegen echtes PostgreSQL (mietroyal_test).
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

async function me(cookie: string) {
  return ctx.app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
}

describe('1. Admin-Bootstrap', () => {
  it('legt den ersten Admin mit allen Rechten an und ist nur einmal möglich', async () => {
    const admin = await bootstrapAdmin(ctx);
    expect(admin.email).toBe(ADMIN_EMAIL);

    const permissions = await ctx.auth.effectivePermissions(admin.id);
    expect(permissions.has('employee.manage')).toBe(true);
    expect(permissions.has('permission.manage')).toBe(true);
    expect(permissions.size).toBeGreaterThan(50);

    await expect(
      ctx.admin.bootstrapFirstAdmin({
        firstName: 'Zweiter',
        lastName: 'Versuch',
        email: 'zweiter@test.example',
        password: 'noch-ein-passwort-123',
      }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe('2./3. Login', () => {
  it('erfolgreicher Login setzt HttpOnly-Session-Cookie und /auth/me funktioniert', async () => {
    await bootstrapAdmin(ctx);
    const result = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(result.statusCode).toBe(200);
    expect(result.cookie).toContain('mr_staff_session=');

    const meResponse = await me(result.cookie);
    expect(meResponse.statusCode).toBe(200);
    const body = meResponse.json();
    expect(body.appLocked).toBe(false);
    expect(body.user.email).toBe(ADMIN_EMAIL);
    expect(body.permissions).toContain('employee.manage');
  });

  it('falsches Passwort → neutrale 401 ohne Details, kein Cookie', async () => {
    await bootstrapAdmin(ctx);
    const result = await login(ctx.app, ADMIN_EMAIL, 'voellig-falsch-123');
    expect(result.statusCode).toBe(401);
    expect(result.cookie).toBe('');
    expect(JSON.stringify(result.body)).not.toMatch(/passwort.*hash|argon|status/i);
  });
});

describe('4./5. Gesperrtes/deaktiviertes Konto', () => {
  it.each(['locked', 'disabled'] as const)(
    'Login mit Status %s → exakt dieselbe neutrale Meldung wie falsches Passwort',
    async (status) => {
      const admin = await bootstrapAdmin(ctx);
      const employee = await createEmployeeWithPassword(ctx, admin.id, {
        firstName: 'Max',
        lastName: 'Muster',
        email: 'max@test.example',
        password: 'mitarbeiter-passwort-1',
      });
      await ctx.admin.setUserStatus(admin.id, employee.id, status);

      const blocked = await login(ctx.app, 'max@test.example', 'mitarbeiter-passwort-1');
      const wrongPassword = await login(ctx.app, ADMIN_EMAIL, 'voellig-falsch-123');
      expect(blocked.statusCode).toBe(401);
      expect(blocked.cookie).toBe('');
      expect(blocked.body).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'LOGIN_FAILED',
            message: (wrongPassword.body as { error: { message: string } }).error.message,
          }),
        }),
      );
    },
  );
});

describe('6./7. Session-Widerruf', () => {
  it('widerrufene Session ist sofort ungültig', async () => {
    const admin = await bootstrapAdmin(ctx);
    const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    expect((await me(session.cookie)).statusCode).toBe(200);

    const sessions = await ctx.admin.listUserSessions(admin.id);
    await ctx.auth.revokeSessionById(sessions[0]!.id, 'test', admin.id);
    expect((await me(session.cookie)).statusCode).toBe(401);
  });

  it('ein Gerät widerrufen – das andere bleibt angemeldet', async () => {
    const admin = await bootstrapAdmin(ctx);
    const phone = await login(
      ctx.app,
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
      'Mozilla/5.0 (iPhone) Safari/605',
    );
    const desktop = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const sessions = await ctx.admin.listUserSessions(admin.id);
    const phoneSession = sessions.find((s) => s.deviceLabel.includes('iPhone'));
    expect(phoneSession).toBeDefined();

    // Admin-Endpunkt nutzen (device.revoke) – wie in der Geräteübersicht.
    const revoke = await ctx.app.inject({
      method: 'POST',
      url: `/staff/sessions/${phoneSession!.id}/revoke`,
      headers: { cookie: desktop.cookie },
      payload: {},
    });
    expect(revoke.statusCode).toBe(200);

    expect((await me(phone.cookie)).statusCode).toBe(401);
    expect((await me(desktop.cookie)).statusCode).toBe(200);
  });
});

describe('8. Benutzersperre beendet alle Sessions', () => {
  it('Sperren widerruft sofort ALLE Geräte', async () => {
    const admin = await bootstrapAdmin(ctx);
    const employee = await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Eva',
      lastName: 'Beispiel',
      email: 'eva@test.example',
      password: 'mitarbeiter-passwort-2',
    });
    const device1 = await login(ctx.app, 'eva@test.example', 'mitarbeiter-passwort-2');
    const device2 = await login(
      ctx.app,
      'eva@test.example',
      'mitarbeiter-passwort-2',
      'Mozilla/5.0 (iPad) Safari/605',
    );
    expect((await me(device1.cookie)).statusCode).toBe(200);

    await ctx.admin.setUserStatus(admin.id, employee.id, 'locked');
    expect((await me(device1.cookie)).statusCode).toBe(401);
    expect((await me(device2.cookie)).statusCode).toBe(401);
  });
});

describe('9. Passwortänderung', () => {
  it('beendet alle ANDEREN Sessions, die aktuelle bleibt', async () => {
    await bootstrapAdmin(ctx);
    const current = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const other = await login(
      ctx.app,
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
      'Mozilla/5.0 (iPhone) Safari/605',
    );

    const change = await ctx.app.inject({
      method: 'POST',
      url: '/auth/password/change',
      headers: { cookie: current.cookie },
      payload: { currentPassword: ADMIN_PASSWORD, newPassword: 'neues-admin-passwort-9' },
    });
    expect(change.statusCode).toBe(200);

    expect((await me(current.cookie)).statusCode).toBe(200); // bleibt
    expect((await me(other.cookie)).statusCode).toBe(401); // raus

    expect((await login(ctx.app, ADMIN_EMAIL, 'neues-admin-passwort-9')).statusCode).toBe(200);
    expect((await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).statusCode).toBe(401);
  });
});

describe('10. Passwort-Reset', () => {
  it('Token ist einmal verwendbar und beendet ALLE alten Sessions', async () => {
    await bootstrapAdmin(ctx);
    const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const forgot = await ctx.app.inject({
      method: 'POST',
      url: '/auth/password/forgot',
      payload: { email: ADMIN_EMAIL },
    });
    expect(forgot.statusCode).toBe(200);
    const token = ctx.mail.sent.at(-1)?.resetToken;
    expect(token).toBeDefined();

    const reset = await ctx.app.inject({
      method: 'POST',
      url: '/auth/password/reset',
      payload: { token, newPassword: 'reset-passwort-10zeichen' },
    });
    expect(reset.statusCode).toBe(200);

    // Alle alten Sessions ungültig; neues Passwort funktioniert.
    expect((await me(session.cookie)).statusCode).toBe(401);
    expect((await login(ctx.app, ADMIN_EMAIL, 'reset-passwort-10zeichen')).statusCode).toBe(200);

    // Einmal verwendbar.
    const secondUse = await ctx.app.inject({
      method: 'POST',
      url: '/auth/password/reset',
      payload: { token, newPassword: 'noch-ein-passwort-11' },
    });
    expect(secondUse.statusCode).toBe(401);
  });

  it('verrät nicht, ob eine E-Mail existiert', async () => {
    await bootstrapAdmin(ctx);
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/auth/password/forgot',
      payload: { email: 'gibtesnicht@test.example' },
    });
    const known = await ctx.app.inject({
      method: 'POST',
      url: '/auth/password/forgot',
      payload: { email: ADMIN_EMAIL },
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.body).toBe(known.body);
  });
});

describe('11. 30 Tage Inaktivität', () => {
  it('Session ist nach 30 Tagen Inaktivität endgültig ungültig', async () => {
    await bootstrapAdmin(ctx);
    const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    await ctx.pool.query(`UPDATE staff_sessions SET last_activity_at = now() - interval '31 days'`);
    expect((await me(session.cookie)).statusCode).toBe(401);

    const rows = await ctx.pool.query('SELECT revoked_at, revoked_reason FROM staff_sessions');
    expect(rows.rows[0].revoked_at).not.toBeNull();
    expect(rows.rows[0].revoked_reason).toBe('expired_inactivity');
  });

  it('29 Tage Inaktivität: Session gilt noch (aber App-Sperre aktiv)', async () => {
    await bootstrapAdmin(ctx);
    const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    await ctx.pool.query(`UPDATE staff_sessions SET last_activity_at = now() - interval '29 days'`);
    const response = await me(session.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json().appLocked).toBe(true);
  });
});

describe('15-Minuten-App-Sperre (Vorgabe Nr. 6)', () => {
  it('sperrt nach 15 Minuten Inaktivität; Entsperren nur mit Passwort', async () => {
    await bootstrapAdmin(ctx);
    const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    await ctx.pool.query(
      `UPDATE staff_sessions SET last_activity_at = now() - interval '16 minutes'`,
    );

    // Normale Endpunkte sind gesperrt …
    const blocked = await ctx.app.inject({
      method: 'GET',
      url: '/staff/users',
      headers: { cookie: session.cookie },
    });
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error.code).toBe('APP_LOCKED');

    // … /auth/me meldet den Sperrzustand ohne sensible Daten …
    const meLocked = await me(session.cookie);
    expect(meLocked.statusCode).toBe(200);
    expect(meLocked.json().appLocked).toBe(true);
    expect(meLocked.json().permissions).toBeUndefined();

    // … falsches Passwort entsperrt nicht …
    const badUnlock = await ctx.app.inject({
      method: 'POST',
      url: '/auth/unlock',
      headers: { cookie: session.cookie },
      payload: { password: 'falsches-passwort-xx' },
    });
    expect(badUnlock.statusCode).toBe(401);

    // … richtiges Passwort entsperrt, Session bleibt dieselbe.
    const unlock = await ctx.app.inject({
      method: 'POST',
      url: '/auth/unlock',
      headers: { cookie: session.cookie },
      payload: { password: ADMIN_PASSWORD },
    });
    expect(unlock.statusCode).toBe(200);
    const meAfter = await me(session.cookie);
    expect(meAfter.json().appLocked).toBe(false);
  });
});

describe('CSRF-Schutz', () => {
  it('blockiert zustandsändernde Cross-Site-Anfragen', async () => {
    await bootstrapAdmin(ctx);
    const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: session.cookie, 'sec-fetch-site': 'cross-site' },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('CSRF_REJECTED');
    // Session unangetastet:
    expect((await me(session.cookie)).statusCode).toBe(200);
  });
});
