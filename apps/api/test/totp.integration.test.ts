/**
 * Phase-1-Pflichttests 20–22: TOTP korrekt/falsch, 2FA-Reset – plus
 * erzwungene Einrichtung, Recovery-Codes und Log-Hygiene.
 */
import * as OTPAuth from 'otpauth';
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

function codeFor(secretBase32: string, offsetMs = 0): string {
  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.generate({ timestamp: Date.now() + offsetMs });
}

const EMPLOYEE_EMAIL = 'totp@test.example';
const EMPLOYEE_PASSWORD = 'totp-user-passwort-12';

/** Richtet für den Mitarbeiter 2FA über den erzwungenen Login-Flow ein. */
async function enrollTotp(): Promise<{ secret: string; recoveryCodes: string[]; userId: string }> {
  const admin = await bootstrapAdmin(ctx);
  const employee = await createEmployeeWithPassword(ctx, admin.id, {
    firstName: 'Tina',
    lastName: 'Totp',
    email: EMPLOYEE_EMAIL,
    password: EMPLOYEE_PASSWORD,
  });
  await ctx.admin.setTotpRequirement(admin.id, employee.id, true);

  const loginResult = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD);
  expect(loginResult.statusCode).toBe(200);
  expect(loginResult.body.next).toBe('totp_setup_required');
  expect(loginResult.cookie).toBe(''); // noch KEINE Session
  const challengeToken = loginResult.body.challengeToken as string;

  const begin = await ctx.app.inject({
    method: 'POST',
    url: '/auth/totp/setup/begin',
    payload: { challengeToken },
  });
  expect(begin.statusCode).toBe(200);
  const { secret, qrDataUrl } = begin.json();
  expect(qrDataUrl).toMatch(/^data:image\/png/);

  const confirm = await ctx.app.inject({
    method: 'POST',
    url: '/auth/totp/setup/confirm',
    payload: { challengeToken, code: codeFor(secret) },
  });
  expect(confirm.statusCode).toBe(200);
  const recoveryCodes = confirm.json().recoveryCodes as string[];
  expect(recoveryCodes).toHaveLength(10);
  return { secret, recoveryCodes, userId: employee.id };
}

describe('20./21. TOTP-Login', () => {
  it('korrekter Code meldet an, falscher Code nicht', async () => {
    const { secret } = await enrollTotp();

    // Neuer Login verlangt jetzt den zweiten Faktor.
    const step1 = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD);
    expect(step1.body.next).toBe('totp_required');
    expect(step1.cookie).toBe('');
    const challengeToken = step1.body.challengeToken as string;

    // 21. Falscher Code → keine Session.
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login/totp',
      payload: { challengeToken, code: '000000' },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.cookies.find((c) => c.name === 'mr_staff_session')).toBeUndefined();

    // 20. Korrekter Code → Session. (+30 s: nächster Zeitschritt, noch im
    // Fenster – der Setup-Schritt ist durch den Replay-Schutz verbraucht.)
    const right = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login/totp',
      payload: { challengeToken, code: codeFor(secret, 30_000) },
    });
    expect(right.statusCode).toBe(200);
    const cookie = right.cookies.find((c) => c.name === 'mr_staff_session');
    expect(cookie).toBeDefined();

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `mr_staff_session=${cookie!.value}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.totpEnabled).toBe(true);
  });

  it('TOTP-Secret liegt nie im Klartext in der Datenbank', async () => {
    const { secret, userId } = await enrollTotp();
    const row = await ctx.pool.query(
      'SELECT totp_secret_enc, totp_pending_secret_enc FROM staff_users WHERE id = $1',
      [userId],
    );
    expect(row.rows[0].totp_pending_secret_enc).toBeNull();
    expect(row.rows[0].totp_secret_enc).not.toBeNull();
    expect(row.rows[0].totp_secret_enc).not.toContain(secret);
  });

  it('Recovery-Code meldet an und ist danach verbraucht', async () => {
    const { recoveryCodes } = await enrollTotp();
    const usedCode = recoveryCodes[0]!;

    const step1 = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD);
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login/recovery',
      payload: { challengeToken: step1.body.challengeToken, recoveryCode: usedCode },
    });
    expect(first.statusCode).toBe(200);

    const step2 = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD);
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login/recovery',
      payload: { challengeToken: step2.body.challengeToken, recoveryCode: usedCode },
    });
    expect(second.statusCode).toBe(400);
  });
});

describe('22. 2FA-Reset durch den Admin', () => {
  it('löscht Secret + Recovery-Codes; bei bestehender Pflicht folgt neue Einrichtung', async () => {
    const { userId } = await enrollTotp();
    const admin = await ctx.auth.findUserByEmail(ADMIN_EMAIL);

    await ctx.admin.resetTotp(admin!.id, userId);

    const user = await ctx.auth.findUserById(userId);
    expect(user?.totpEnabled).toBe(false);
    expect(user?.totpSecretEnc).toBeNull();
    const codes = await ctx.pool.query(
      'SELECT count(*)::int AS n FROM staff_recovery_codes WHERE user_id = $1',
      [userId],
    );
    expect(codes.rows[0].n).toBe(0);

    // totp_required ist weiterhin true → nächster Login erzwingt neue Einrichtung.
    const next = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD);
    expect(next.body.next).toBe('totp_setup_required');

    // Ohne Pflicht: nach Aufheben ist normaler Login ohne 2FA möglich.
    await ctx.admin.setTotpRequirement(admin!.id, userId, false);
    const plain = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD);
    expect(plain.body.next).toBe('authenticated');
  });
});

describe('Audit (Vorgabe Nr. 14)', () => {
  it('zeichnet die sicherheitsrelevanten Ereignisse auf – ohne Secrets', async () => {
    await enrollTotp();
    const admin = await ctx.auth.findUserByEmail(ADMIN_EMAIL);
    const events = await ctx.admin.listSecurityEvents();
    const types = events.map((e) => e.type);
    expect(types).toContain('employee.created');
    expect(types).toContain('twofa.requirement_changed');
    expect(types).toContain('twofa.enabled');
    expect(types).toContain('session.created');
    expect(types).toContain('session.new_device_login');
    expect(types).toContain('password.reset_completed');
    expect(admin).toBeDefined();

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(ADMIN_PASSWORD);
    expect(serialized).not.toContain(EMPLOYEE_PASSWORD);
    expect(serialized).not.toMatch(/[A-Z2-7]{32}/); // kein Base32-TOTP-Secret
  });
});

describe('TOTP-Replay-Schutz (Review-Fix)', () => {
  it('derselbe Code wird innerhalb des Zeitfensters nicht zweimal akzeptiert', async () => {
    const { secret } = await enrollTotp();

    const step1 = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD);
    const code = codeFor(secret, 30_000); // nächster Zeitschritt (im ±1-Fenster gültig)
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login/totp',
      payload: { challengeToken: step1.body.challengeToken, code },
    });
    expect(first.statusCode).toBe(200);

    // Replay mit exakt demselben Code auf einer frischen Challenge.
    const step2 = await login(ctx.app, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD);
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login/totp',
      payload: { challengeToken: step2.body.challengeToken, code },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.cookies.find((c) => c.name === 'mr_staff_session')).toBeUndefined();
  });
});
