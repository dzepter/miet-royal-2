/**
 * Phase-2-Pflichttests 21–30: globale Suche (Vorgangsnummer, Namensteile,
 * Organisation, E-Mail, Telefon, Tippfehler, Sortierung, Sichtbarkeit
 * abgeschlossener Vorgänge, completed_process_staff_visibility_days).
 * Läuft gegen echtes PostgreSQL inkl. pg_trgm.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bootstrapAdmin,
  createTestContext,
  destroyTestContext,
  login,
  truncateAuthTables,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  type TestContext,
} from './auth-helpers.ts';
import {
  adminVisibilityCtx,
  createStaffWithPermissions,
  createTestCustomer,
  processServiceFor,
  truncateCrmTables,
} from './crm-helpers.ts';
import { setCompletedVisibilityDays } from '../src/crm/settings-service.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
});

interface SearchBody {
  customers: { id: string; displayName: string }[];
  processes: { id: string; processNumber: string; mainStatus: string }[];
  canViewCompleted: boolean;
}

async function search(cookie: string, q: string, includeCompleted = false): Promise<SearchBody> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/staff/search?q=${encodeURIComponent(q)}&includeCompleted=${includeCompleted ? 'true' : 'false'}`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as SearchBody;
}

/** Legt die synthetische Standard-Testwelt an. */
async function seed() {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  const anna = await createTestCustomer(ctx, admin.id, {
    firstName: 'Anna',
    lastName: 'Schmidt',
    email: 'anna.schmidt@test.example',
    phone: '0171 2345678',
  });
  const verein = await createTestCustomer(ctx, admin.id, {
    type: 'organization',
    organizationName: 'Sportverein Blau-Weiß e.V.',
    email: 'kontakt@blauweiss.example',
  });
  const service = processServiceFor(ctx);
  const openProcess = await service.createProcess(admin.id, {
    customerId: anna.id,
    eventDate: '2026-10-03',
  });
  const doneProcess = await service.createProcess(admin.id, { customerId: anna.id });
  await service.complete(doneProcess.id, adminVisibilityCtx());
  const orgProcess = await service.createProcess(admin.id, { customerId: verein.id });
  return { admin, cookie: session.cookie, anna, verein, openProcess, doneProcess, orgProcess };
}

describe('21.–26. Suchfelder und Toleranz', () => {
  it('21. Suche nach Vorgangsnummer (auch Teil der Nummer)', async () => {
    const world = await seed();
    const exact = await search(world.cookie, world.openProcess.processNumber);
    expect(exact.processes.some((p) => p.id === world.openProcess.id)).toBe(true);
    const partial = await search(world.cookie, world.openProcess.processNumber.slice(3));
    expect(partial.processes.some((p) => p.id === world.openProcess.id)).toBe(true);
  });

  it('22. Suche nach Teil des Kundennamens, case-tolerant', async () => {
    const world = await seed();
    const result = await search(world.cookie, 'schmi');
    expect(result.customers.some((c) => c.id === world.anna.id)).toBe(true);
    expect(result.processes.some((p) => p.id === world.openProcess.id)).toBe(true);
    const upper = await search(world.cookie, 'SCHMIDT');
    expect(upper.customers.some((c) => c.id === world.anna.id)).toBe(true);
  });

  it('23. Suche nach Organisation', async () => {
    const world = await seed();
    const result = await search(world.cookie, 'Blau-Weiß');
    expect(result.customers.some((c) => c.id === world.verein.id)).toBe(true);
    expect(result.processes.some((p) => p.id === world.orgProcess.id)).toBe(true);
  });

  it('24. Suche nach E-Mail', async () => {
    const world = await seed();
    const result = await search(world.cookie, 'anna.schmidt@test');
    expect(result.customers.some((c) => c.id === world.anna.id)).toBe(true);
  });

  it('25. Suche nach Telefonnummer in beliebiger Schreibweise', async () => {
    const world = await seed();
    for (const variant of ['+49 171 2345678', '01712345678', '0171/234 56 78']) {
      const result = await search(world.cookie, variant);
      expect(
        result.customers.some((c) => c.id === world.anna.id),
        variant,
      ).toBe(true);
    }
  });

  it('26. Tippfehler-Suche nach Name (pg_trgm)', async () => {
    const world = await seed();
    const result = await search(world.cookie, 'Anna Schmit');
    expect(result.customers.some((c) => c.id === world.anna.id)).toBe(true);
  });

  it('Eventdatum als Sucheingabe findet den Vorgang', async () => {
    const world = await seed();
    const result = await search(world.cookie, '03.10.2026');
    expect(result.processes.some((p) => p.id === world.openProcess.id)).toBe(true);
  });
});

describe('27.–30. Sortierung und Sichtbarkeit', () => {
  it('27. offene Vorgänge erscheinen vor abgeschlossenen', async () => {
    const world = await seed();
    const result = await search(world.cookie, 'Schmidt', true);
    const ids = result.processes.map((p) => p.id);
    expect(ids).toContain(world.openProcess.id);
    expect(ids).toContain(world.doneProcess.id);
    expect(ids.indexOf(world.openProcess.id)).toBeLessThan(ids.indexOf(world.doneProcess.id));
  });

  it('28. abgeschlossene Vorgänge sind ohne Recht nach Fristablauf nicht sichtbar', async () => {
    const world = await seed();
    await setCompletedVisibilityDays(ctx.db, world.admin.id, 0);
    const staff = await createStaffWithPermissions(ctx, world.admin.id, {
      firstName: 'Nora',
      lastName: 'Normal',
      email: 'normal@test.example',
      password: 'normal-passwort-123',
      permissionKeys: ['process.view_all', 'customer.view'],
    });
    // Standard (ohne includeCompleted): nur offene.
    const defaults = await search(staff.cookie, 'Schmidt');
    expect(defaults.processes.some((p) => p.id === world.doneProcess.id)).toBe(false);
    // Auch mit includeCompleted greift die serverseitige Sichtbarkeitsregel.
    const explicit = await search(staff.cookie, 'Schmidt', true);
    expect(explicit.processes.some((p) => p.id === world.doneProcess.id)).toBe(false);
    expect(explicit.canViewCompleted).toBe(false);
  });

  it('29. Admin-Suche findet berechtigte abgeschlossene Vorgänge', async () => {
    const world = await seed();
    await setCompletedVisibilityDays(ctx.db, world.admin.id, 0);
    const result = await search(world.cookie, 'Schmidt', true);
    expect(result.processes.some((p) => p.id === world.doneProcess.id)).toBe(true);
    expect(result.canViewCompleted).toBe(true);
  });

  it('30. completed_process_staff_visibility_days wird respektiert', async () => {
    const world = await seed();
    const staff = await createStaffWithPermissions(ctx, world.admin.id, {
      firstName: 'Nora',
      lastName: 'Normal',
      email: 'normal@test.example',
      password: 'normal-passwort-123',
      permissionKeys: ['process.view_all', 'customer.view'],
    });
    // Innerhalb der Frist (Default 7 Tage): frisch abgeschlossene sichtbar.
    const within = await search(staff.cookie, 'Schmidt', true);
    expect(within.processes.some((p) => p.id === world.doneProcess.id)).toBe(true);
    // Frist auf 0 Tage: sofort unsichtbar – ohne neue Anmeldung (Sofortwirkung).
    await setCompletedVisibilityDays(ctx.db, world.admin.id, 0);
    const expired = await search(staff.cookie, 'Schmidt', true);
    expect(expired.processes.some((p) => p.id === world.doneProcess.id)).toBe(false);

    // Die Vorgangsliste nutzt dieselbe zentrale Regel.
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/staff/processes?includeCompleted=true',
      headers: { cookie: staff.cookie },
    });
    const listBody = list.json() as { processes: { id: string }[] };
    expect(listBody.processes.some((p) => p.id === world.doneProcess.id)).toBe(false);
  });

  it('Suche ohne Kundenrecht liefert keine Kundendaten (kein Datenleck)', async () => {
    const world = await seed();
    const staff = await createStaffWithPermissions(ctx, world.admin.id, {
      firstName: 'Paul',
      lastName: 'ProzessNur',
      email: 'prozess@test.example',
      password: 'prozess-passwort-123',
      permissionKeys: ['process.view_all'],
    });
    const result = await search(staff.cookie, 'Schmidt');
    expect(result.customers.length).toBe(0);
    // Vorgänge (mit Kundenanzeige im Kontext des Vorgangs) bleiben erlaubt.
    expect(result.processes.some((p) => p.id === world.openProcess.id)).toBe(true);

    const none = await createStaffWithPermissions(ctx, world.admin.id, {
      firstName: 'Otto',
      lastName: 'OhneAlles',
      email: 'ohne@test.example',
      password: 'ohne-passwort-123',
      permissionKeys: [],
    });
    const emptyResult = await search(none.cookie, 'Schmidt');
    expect(emptyResult.customers.length).toBe(0);
    expect(emptyResult.processes.length).toBe(0);
  });

  it('SQL-Sonderzeichen in der Sucheingabe sind harmlos (parametrisiert)', async () => {
    const world = await seed();
    for (const q of ["'; DROP TABLE customers; --", '%_%', "Schmidt' OR '1'='1"]) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/staff/search?q=${encodeURIComponent(q)}`,
        headers: { cookie: world.cookie },
      });
      expect(response.statusCode).toBe(200);
    }
    const stillThere = await ctx.pool.query('SELECT count(*)::int AS n FROM customers');
    expect(stillThere.rows[0].n).toBe(2);
  });
});

describe('Ergänzungen aus dem adversarialen Phase-2-Review', () => {
  it('Suche nach zuständigem Mitarbeiter findet dessen Vorgänge', async () => {
    const world = await seed();
    await processServiceFor(ctx).assign(world.openProcess.id, world.admin.id, adminVisibilityCtx());
    const result = await search(world.cookie, 'Anna Admin');
    expect(result.processes.some((p) => p.id === world.openProcess.id)).toBe(true);
    // Der nicht zugewiesene Organisations-Vorgang wird darüber NICHT gefunden.
    expect(result.processes.some((p) => p.id === world.orgProcess.id)).toBe(false);
  });

  it('Wieder geöffnete Vorgänge: in der Standardsuche für Berechtigte, unsichtbar ohne Recht', async () => {
    const world = await seed();
    // Admin öffnet den abgeschlossenen Vorgang wieder.
    const reopen = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.doneProcess.id}/reopen`,
      headers: { cookie: world.cookie },
    });
    expect(reopen.statusCode).toBe(200);

    // Admin findet ihn in der STANDARD-Suche (operativ offen), Label-Status reopened.
    const adminDefault = await search(world.cookie, 'Schmidt');
    const hit = adminDefault.processes.find((p) => p.id === world.doneProcess.id);
    expect(hit?.mainStatus).toBe('reopened');

    // Normale Mitarbeitende ohne process.view_completed sehen ihn nirgends –
    // weder Standard noch includeCompleted, weder Suche noch Liste noch Detail.
    const staff = await createStaffWithPermissions(ctx, world.admin.id, {
      firstName: 'Nora',
      lastName: 'Normal',
      email: 'normal@test.example',
      password: 'normal-passwort-123',
      permissionKeys: ['process.view_all', 'customer.view'],
    });
    const searchDefault = await search(staff.cookie, 'Schmidt');
    expect(searchDefault.processes.some((p) => p.id === world.doneProcess.id)).toBe(false);
    const searchAll = await search(staff.cookie, 'Schmidt', true);
    expect(searchAll.processes.some((p) => p.id === world.doneProcess.id)).toBe(false);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/staff/processes?includeCompleted=true',
      headers: { cookie: staff.cookie },
    });
    const listBody = list.json() as { processes: { id: string }[] };
    expect(listBody.processes.some((p) => p.id === world.doneProcess.id)).toBe(false);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${world.doneProcess.id}`,
      headers: { cookie: staff.cookie },
    });
    expect(detail.statusCode).toBe(404);
  });
});
