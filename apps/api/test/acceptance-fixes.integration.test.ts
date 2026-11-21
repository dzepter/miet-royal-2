/**
 * Phase 18 – Regressionstests zu den Befunden der Gesamt-Abnahme (Order „Echte
 * Produktfehler: reproduzieren → roter Test → Fix → grün“):
 *
 * - F1 CRM-Concurrency (OPEN_ITEMS Phase-18-Prüfpunkt): ein Staff-Formular, das vor
 *   einer fremden Änderung (zweite Mitarbeiterin ODER verifizierter Portal-E-Mail-
 *   Wechsel) geladen wurde, darf diese Änderung nicht still zurückdrehen – optionale
 *   optimistische Sperre über `expectedUpdatedAt` ⇒ 409, Daten bleiben.
 * - F2 Schaden online: Doppel-Submit (Doppelklick/Request-Wiederholung) mit demselben
 *   `clientMutationId` erzeugt genau EINE Dokumentationszeile (Entwurfsschaden und
 *   nachträgliche Feststellung) – derselbe Replay-Pfad wie offline.
 * - F3 Log-Policy: Terminerzeugungsfehler nach der öffentlichen Annahme werden ohne
 *   SQL/Parameter geloggt (Datenbankfehler tragen Kundendaten in `message`).
 */
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { customers, damagePhotos, machineDamages } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import {
  commerceServices,
  createCommerceWorld,
  truncateCommerceTables,
} from './commerce-helpers.ts';
import {
  createStaffWithPermissions,
  createTestCustomer,
  truncateCrmTables,
} from './crm-helpers.ts';
import { truncateHandoverTables } from './handover-helpers.ts';
import {
  latestPortalMailToken,
  loginViaMagicLink,
  truncatePortalTables,
} from './portal-auth-helpers.ts';
import { POINT_MARKER, jpegBytes, readyReturn, startedReturn } from './return-helpers.ts';
import { truncateSchedulingTables } from './scheduling-helpers.ts';
import { machineByCode, resetWarehouse } from './warehouse-helpers.ts';
import { SchedulingService } from '../src/scheduling/scheduling-service.ts';

const logLines: string[] = [];
const logDestination = new Writable({
  write(chunk, _encoding, callback) {
    logLines.push(chunk.toString());
    callback();
  },
});

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ logDestination, logLevel: 'warn' });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateHandoverTables(ctx.pool);
  await resetWarehouse(ctx.pool);
  await truncateSchedulingTables(ctx.pool);
  await truncatePortalTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  // Zuletzt: stellt die Seed-Preise wieder her (TRUNCATE staff_users CASCADE leert product_prices).
  await truncateCommerceTables(ctx.pool);
  logLines.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function adminSession() {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  return { admin, cookie: session.cookie };
}

interface CustomerDto {
  customer: { id: string; email: string | null; firstName: string | null; updatedAt: string };
}

async function loadCustomer(cookie: string, id: string): Promise<CustomerDto['customer']> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/staff/customers/${id}`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as CustomerDto).customer;
}

async function dbEmail(id: string): Promise<string | null> {
  const rows = await ctx.db
    .select({ email: customers.email })
    .from(customers)
    .where(eq(customers.id, id));
  return rows[0]?.email ?? null;
}

const STALE_FORM = {
  type: 'private' as const,
  firstName: 'Paula',
  lastName: 'Portal',
  email: 'paula.alt@portal.test',
  phone: '0170 1234567',
};

describe('P18-F1 CRM: veraltetes Staff-Formular überschreibt fremde Änderungen nicht still', () => {
  it('P18-F1a. PATCH mit veraltetem expectedUpdatedAt nach Änderung einer zweiten Mitarbeiterin ⇒ 409, Datensatz bleibt', async () => {
    const { admin, cookie } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id, STALE_FORM);
    const loaded = await loadCustomer(cookie, customer.id);
    expect(typeof loaded.updatedAt).toBe('string');

    const second = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Zweite',
      lastName: 'Bearbeiterin',
      email: 'zweite@test.example',
      password: 'zweite-passwort-123',
      permissionKeys: ['customer.view', 'customer.edit'],
    });
    const concurrent = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/customers/${customer.id}`,
      headers: { cookie: second.cookie },
      payload: { ...STALE_FORM, email: 'paula.neu@portal.test' },
    });
    expect(concurrent.statusCode).toBe(200);
    expect(await dbEmail(customer.id)).toBe('paula.neu@portal.test');

    // Das zuvor geladene Formular wird gespeichert – mit dem damaligen Zeitstempel.
    const stale = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/customers/${customer.id}`,
      headers: { cookie },
      payload: { ...STALE_FORM, expectedUpdatedAt: loaded.updatedAt },
    });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { code: string; message: string } }).error.message).toMatch(
      /zwischenzeitlich geändert/,
    );
    expect(await dbEmail(customer.id)).toBe('paula.neu@portal.test');
  });

  it('P18-F1b. verifizierter Portal-E-Mail-Wechsel wird von einem veralteten Staff-Formular nicht zurückgedreht', async () => {
    const { admin, cookie } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id, STALE_FORM);
    const loaded = await loadCustomer(cookie, customer.id);

    // Echter Portalweg: Login per Magic Link, Wechsel anfordern, Link aus der Outbox bestätigen.
    const portal = await loginViaMagicLink(ctx, STALE_FORM.email);
    const requested = await ctx.app.inject({
      method: 'POST',
      url: '/portal/auth/email-change/request',
      headers: { cookie: portal.cookie },
      payload: { email: 'paula.verifiziert@portal.test' },
    });
    expect(requested.statusCode).toBe(202);
    const link = await latestPortalMailToken(ctx, 'customer_portal_email_change');
    expect(link).not.toBeNull();
    const consumed = await ctx.app.inject({
      method: 'POST',
      url: '/portal/auth/email-change/consume',
      payload: { token: link!.token },
    });
    expect(consumed.statusCode).toBe(200);
    expect(await dbEmail(customer.id)).toBe('paula.verifiziert@portal.test');

    const stale = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/customers/${customer.id}`,
      headers: { cookie },
      payload: { ...STALE_FORM, expectedUpdatedAt: loaded.updatedAt },
    });
    expect(stale.statusCode).toBe(409);
    expect(await dbEmail(customer.id)).toBe('paula.verifiziert@portal.test');
  });

  it('P18-F1c. aktueller Zeitstempel ⇒ 200 mit neuem updatedAt; ohne expectedUpdatedAt weiterhin 200 (bestehende Clients)', async () => {
    const { admin, cookie } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id, STALE_FORM);
    const loaded = await loadCustomer(cookie, customer.id);

    const fresh = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/customers/${customer.id}`,
      headers: { cookie },
      payload: { ...STALE_FORM, phone: '0170 7654321', expectedUpdatedAt: loaded.updatedAt },
    });
    expect(fresh.statusCode).toBe(200);
    const after = (fresh.json() as CustomerDto).customer;
    expect(after.updatedAt).not.toBe(loaded.updatedAt);

    const legacy = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/customers/${customer.id}`,
      headers: { cookie },
      payload: { ...STALE_FORM, phone: '0170 1111111' },
    });
    expect(legacy.statusCode).toBe(200);

    // Ungültiger Zeitstempel ⇒ 400 (Validierung), keine Änderung.
    const invalid = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/customers/${customer.id}`,
      headers: { cookie },
      payload: { ...STALE_FORM, phone: '0170 2222222', expectedUpdatedAt: 'gestern' },
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe('P18-F2 Schaden online: Idempotenzschlüssel gegen Doppel-Submit', () => {
  const DAMAGE = {
    severity: 'medium' as const,
    description: 'Delle links am Gehäuse',
    markers: [POINT_MARKER],
  };

  async function damageRows() {
    return ctx.db.select({ id: machineDamages.id }).from(machineDamages);
  }

  it('P18-F2a. Entwurfsschaden mit demselben clientMutationId zweimal und parallel ⇒ genau eine Zeile je Schlüssel', async () => {
    const { admin, cookie } = await adminSession();
    const { world, detail } = await startedReturn(ctx, admin.id);
    const url = `/staff/returns/${world.bookingId}/machines/${detail.machines[0]!.id}/damages`;
    const first = randomUUID();
    const once = await ctx.app.inject({
      method: 'POST',
      url,
      headers: { cookie },
      payload: { ...DAMAGE, clientMutationId: first },
    });
    expect(once.statusCode).toBe(200);
    const twice = await ctx.app.inject({
      method: 'POST',
      url,
      headers: { cookie },
      payload: { ...DAMAGE, clientMutationId: first },
    });
    expect(twice.statusCode).toBe(200);
    expect((twice.json() as { damageId: string }).damageId).toBe(
      (once.json() as { damageId: string }).damageId,
    );
    expect(await damageRows()).toHaveLength(1);

    const second = randomUUID();
    const parallel = await Promise.all([
      ctx.app.inject({
        method: 'POST',
        url,
        headers: { cookie },
        payload: { ...DAMAGE, clientMutationId: second },
      }),
      ctx.app.inject({
        method: 'POST',
        url,
        headers: { cookie },
        payload: { ...DAMAGE, clientMutationId: second },
      }),
    ]);
    expect(parallel.map((r) => r.statusCode)).toEqual([200, 200]);
    const ids = new Set(parallel.map((r) => (r.json() as { damageId: string }).damageId));
    expect(ids.size).toBe(1);
    expect(await damageRows()).toHaveLength(2);

    // Ein fremder Schlüssel oder gar keiner legt wie bisher eine neue Zeile an.
    const plain = await ctx.app.inject({
      method: 'POST',
      url,
      headers: { cookie },
      payload: DAMAGE,
    });
    expect(plain.statusCode).toBe(200);
    expect(await damageRows()).toHaveLength(3);
    const malformed = await ctx.app.inject({
      method: 'POST',
      url,
      headers: { cookie },
      payload: { ...DAMAGE, clientMutationId: 'keine-uuid' },
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('P18-F2b. Nachträgliche Feststellung mit demselben clientMutationId zweimal ⇒ genau eine Zeile und ein Foto', async () => {
    const { admin, cookie } = await adminSession();
    const { world, services } = await startedReturn(ctx, admin.id);
    await readyReturn(ctx, admin.id, services, world.bookingId);
    await services.returns.finalize(admin.id, world.bookingId);
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    const key = randomUUID();
    const payload = {
      ...DAMAGE,
      description: 'Nachträglich entdeckter Kratzer',
      photo: { mimeType: 'image/jpeg', dataBase64: Buffer.from(jpegBytes()).toString('base64') },
      clientMutationId: key,
    };
    const responses = [
      await ctx.app.inject({
        method: 'POST',
        url: `/staff/machines/${machine.id}/damages`,
        headers: { cookie },
        payload,
      }),
      await ctx.app.inject({
        method: 'POST',
        url: `/staff/machines/${machine.id}/damages`,
        headers: { cookie },
        payload,
      }),
    ];
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    const ids = responses.map((r) => (r.json() as { damageId: string }).damageId);
    expect(ids[0]).toBe(ids[1]);
    const findings = await ctx.db
      .select({ id: machineDamages.id })
      .from(machineDamages)
      .where(eq(machineDamages.origin, 'post_return_finding'));
    expect(findings).toHaveLength(1);
    const photos = await ctx.db
      .select({ id: damagePhotos.id })
      .from(damagePhotos)
      .where(eq(damagePhotos.damageId, ids[0]!));
    expect(photos).toHaveLength(1);
  });
});

describe('P18-F3 Log-Policy der öffentlichen Angebotsannahme', () => {
  it('P18-F3. Fehler der Terminerzeugung wird ohne SQL-Text/Parameter geloggt, die Annahme bleibt gültig', async () => {
    const { admin } = await adminSession();
    const world = await createCommerceWorld(ctx, admin.id);
    const services = commerceServices(ctx);
    const { versionId } = await services.offers.createOffer(admin.id, world.processId);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    const { token } = await services.offers.send(admin.id, versionId, effective);

    const MARKER = 'GEHEIMER-PARAMETERWERT-4711';
    const dbLikeError = Object.assign(
      new Error(`Failed query: insert into "appointments" … params: ${MARKER}`),
      { query: 'insert into "appointments" …', params: [MARKER] },
    );
    vi.spyOn(SchedulingService.prototype, 'ensureAppointmentsForBooking').mockRejectedValueOnce(
      dbLikeError,
    );
    logLines.length = 0;

    const accepted = await ctx.app.inject({
      method: 'POST',
      url: `/public/offers/${token}/accept`,
    });
    expect(accepted.statusCode).toBe(200);
    expect((accepted.json() as { accepted: boolean }).accepted).toBe(true);

    const log = logLines.join('');
    expect(log).toContain('Terminerzeugung nach Annahme fehlgeschlagen');
    expect(log).not.toContain(MARKER);
    expect(log).not.toContain('Failed query');
  });
});
