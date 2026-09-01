/**
 * Brute-Force-Limits (Phase-1-Vorgabe Nr. 3/20, Review-Fix):
 * Schlüssel = IP + Ziel(E-Mail/Challenge/Session), damit die Limits auch
 * hinter dem Same-Origin-Proxy pro Konto wirken und nicht die ganze Firma
 * in einen gemeinsamen Topf fallen.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrapAdmin,
  createTestContext,
  destroyTestContext,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ rateLimitEnabled: true });
  await truncateAuthTables(ctx.pool);
  await bootstrapAdmin(ctx);
});
afterAll(async () => {
  await destroyTestContext(ctx);
});

async function attemptLogin(email: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: 'absichtlich-falsch-1' },
  });
}

describe('Login-Rate-Limit', () => {
  it('drosselt nach 10 Versuchen pro Konto – andere Konten bleiben nutzbar', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await attemptLogin('opfer@test.example')).statusCode).toBe(401);
    }
    const eleventh = await attemptLogin('opfer@test.example');
    expect(eleventh.statusCode).toBe(429);

    // Anderes Konto (gleiche Quelle): eigener Topf, kein firmenweiter Ausfall.
    const other = await attemptLogin('anderes-konto@test.example');
    expect(other.statusCode).toBe(401);
  });
});
