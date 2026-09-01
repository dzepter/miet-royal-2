/**
 * Phase-2-Pflichttests 1–2 und 5–20 sowie 32: Kunden, Dubletten, Vorgänge,
 * Nummernvergabe, Zuständigkeit, Abschluss/Wiederöffnen, Notizen, Papierkorb
 * und manipulierte Anfragen ohne Recht. Läuft gegen echtes PostgreSQL.
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
  customerServiceFor,
  processServiceFor,
  truncateCrmTables,
} from './crm-helpers.ts';
import type { PermissionKey } from '@mietroyal/permissions';
import { setCompletedVisibilityDays } from '../src/crm/settings-service.ts';
import { buildVisibilityContext } from '../src/crm/visibility.ts';

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

async function adminSession() {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  return { admin, cookie: session.cookie };
}

describe('1.–2. Kunden anlegen', () => {
  it('1. Privatkunde: Vor-/Nachname reichen, keine unnötigen Pflichtfelder', async () => {
    const { cookie } = await adminSession();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/staff/customers',
      headers: { cookie },
      payload: { type: 'private', firstName: 'Max', lastName: 'Mustermann' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { customer: { id: string; type: string; email: null } };
    expect(body.customer.type).toBe('private');
    expect(body.customer.email).toBeNull();
  });

  it('1b. Privatkunde ohne Nachnamen wird abgelehnt (fachliches Minimum)', async () => {
    const { cookie } = await adminSession();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/staff/customers',
      headers: { cookie },
      payload: { type: 'private', firstName: 'Max' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('2. Organisationskunde mit Ansprechpartner und optionalen Feldern', async () => {
    const { cookie } = await adminSession();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/staff/customers',
      headers: { cookie },
      payload: {
        type: 'organization',
        organizationName: 'Eventservice Kranz GmbH',
        contactPerson: 'Karla Kranz',
        email: 'Info@Kranz-Events.example',
        vatId: 'DE123456789',
        costCenter: 'K-100',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      customer: { organizationName: string; email: string; vatId: string };
    };
    expect(body.customer.organizationName).toBe('Eventservice Kranz GmbH');
    // Normalisierung greift beim Speichern:
    expect(body.customer.email).toBe('info@kranz-events.example');
    expect(body.customer.vatId).toBe('DE123456789');
  });
});

describe('5.–6. Dubletten: warnen, nie blockieren', () => {
  it('5. Dublettenwarnung bei gleicher E-Mail (auch anders geschrieben)', async () => {
    const { admin, cookie } = await adminSession();
    await createTestCustomer(ctx, admin.id, { email: 'doppelt@test.example' });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/staff/customers/duplicate-check',
      headers: { cookie },
      payload: {
        type: 'private',
        firstName: 'Moritz',
        lastName: 'Anders',
        email: ' DOPPELT@test.example ',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { duplicates: { reason: string }[] };
    expect(body.duplicates.length).toBeGreaterThan(0);
    expect(body.duplicates[0]?.reason).toBe('email');
  });

  it('6. Dublette blockiert das Anlegen NICHT – zweiter Kunde entsteht trotzdem', async () => {
    const { admin, cookie } = await adminSession();
    await createTestCustomer(ctx, admin.id, { email: 'doppelt@test.example' });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/staff/customers',
      headers: { cookie },
      payload: {
        type: 'private',
        firstName: 'Moritz',
        lastName: 'Anders',
        email: 'doppelt@test.example',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { customer: { id: string }; duplicates: unknown[] };
    expect(body.customer.id).toBeTruthy();
    // Die Warnung wird mitgeliefert, entschieden wird bewusst vom Menschen.
    expect(body.duplicates.length).toBeGreaterThan(0);
    const count = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM customers WHERE email = 'doppelt@test.example'`,
    );
    expect(count.rows[0].n).toBe(2);
  });
});

describe('7.–12. Vorgang + Nummernvergabe', () => {
  it('7. Vorgang anlegen (Quelle, Status offen, Kunde verknüpft)', async () => {
    const { admin, cookie } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/staff/processes',
      headers: { cookie },
      payload: { customerId: customer.id, source: 'whatsapp', eventDate: '2026-10-03' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      process: { mainStatus: string; source: string; customerId: string; eventDate: string };
    };
    expect(body.process.mainStatus).toBe('open');
    expect(body.process.source).toBe('whatsapp');
    expect(body.process.customerId).toBe(customer.id);
    expect(body.process.eventDate).toBe('2026-10-03');
  });

  it('8. korrekte MR-Nummer: Format MR-YYYY-NNNN mit Berliner Jahr', async () => {
    const { admin } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id);
    const now = new Date('2026-06-15T12:00:00Z');
    const process = await processServiceFor(ctx).createProcess(
      admin.id,
      { customerId: customer.id },
      now,
    );
    expect(process.processNumber).toMatch(/^MR-2026-\d{4,}$/);
  });

  it('9. laufende Nummer setzt sich über den Jahreswechsel fort (kein Reset)', async () => {
    const { admin } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id);
    const service = processServiceFor(ctx);
    const inOldYear = await service.createProcess(
      admin.id,
      { customerId: customer.id },
      new Date('2026-06-15T12:00:00Z'),
    );
    const inNewYear = await service.createProcess(
      admin.id,
      { customerId: customer.id },
      new Date('2027-01-05T12:00:00Z'),
    );
    const oldSeq = Number(inOldYear.processNumber.split('-')[2]);
    const newSeq = Number(inNewYear.processNumber.split('-')[2]);
    expect(inOldYear.processNumber.startsWith('MR-2026-')).toBe(true);
    expect(inNewYear.processNumber.startsWith('MR-2027-')).toBe(true);
    expect(newSeq).toBe(oldSeq + 1);
  });

  it('10. parallele Erstellung vieler Vorgänge erzeugt keine Doppelnummer', async () => {
    const { admin } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id);
    const service = processServiceFor(ctx);
    const created = await Promise.all(
      Array.from({ length: 12 }, () =>
        service.createProcess(admin.id, { customerId: customer.id }),
      ),
    );
    const numbers = created.map((p) => p.processNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
    const stored = await ctx.pool.query(
      'SELECT count(DISTINCT process_number)::int AS n FROM processes',
    );
    expect(stored.rows[0].n).toBe(12);
  });

  it('11. Vorgangsnummer ist nach Erstellung unveränderbar (DB-Trigger)', async () => {
    const { admin } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id);
    const process = await processServiceFor(ctx).createProcess(admin.id, {
      customerId: customer.id,
    });
    await expect(
      ctx.pool.query(`UPDATE processes SET process_number = 'MR-9999-0001' WHERE id = $1`, [
        process.id,
      ]),
    ).rejects.toThrow(/unveraenderbar/);
  });

  it('12. ein Kunde kann mehrere Vorgänge haben', async () => {
    const { admin } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id);
    const service = processServiceFor(ctx);
    await service.createProcess(admin.id, { customerId: customer.id });
    await service.createProcess(admin.id, { customerId: customer.id });
    const days = 7;
    const ctxAdmin = buildVisibilityContext(
      new Set<PermissionKey>(['process.view_completed']),
      days,
    );
    const list = await service.listForCustomer(customer.id, ctxAdmin);
    expect(list.length).toBe(2);
  });
});

describe('13.–14. Zuständigkeit', () => {
  it('13. Mitarbeiter zuweisen (serverseitig berechtigungsgeprüft)', async () => {
    const { admin, cookie } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id);
    const process = await processServiceFor(ctx).createProcess(admin.id, {
      customerId: customer.id,
    });
    const worker = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Willi',
      lastName: 'Worker',
      email: 'worker@test.example',
      password: 'worker-passwort-123',
      permissionKeys: [],
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${process.id}/assign`,
      headers: { cookie },
      payload: { userId: worker.user.id },
    });
    expect(response.statusCode).toBe(200);
    const stored = await ctx.pool.query('SELECT assigned_user_id FROM processes WHERE id = $1', [
      process.id,
    ]);
    expect(stored.rows[0].assigned_user_id).toBe(worker.user.id);
  });

  it('14. deaktivierter Mitarbeiter kann nicht neu zugewiesen werden – Historie bleibt', async () => {
    const { admin, cookie } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id);
    const service = processServiceFor(ctx);
    const worker = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Willi',
      lastName: 'Worker',
      email: 'worker@test.example',
      password: 'worker-passwort-123',
      permissionKeys: [],
    });
    const assigned = await service.createProcess(admin.id, {
      customerId: customer.id,
      assignedUserId: worker.user.id,
    });
    await ctx.admin.setUserStatus(admin.id, worker.user.id, 'disabled');

    // Neue Zuweisung wird abgelehnt …
    const fresh = await service.createProcess(admin.id, { customerId: customer.id });
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${fresh.id}/assign`,
      headers: { cookie },
      payload: { userId: worker.user.id },
    });
    expect(response.statusCode).toBe(400);

    // … die bestehende historische Referenz bleibt unangetastet.
    const stored = await ctx.pool.query('SELECT assigned_user_id FROM processes WHERE id = $1', [
      assigned.id,
    ]);
    expect(stored.rows[0].assigned_user_id).toBe(worker.user.id);
  });
});

describe('15.–18. Abschließen, Sperre, Wiederöffnen', () => {
  it('15. Vorgang abschließen setzt Status und Abschlusszeitpunkt', async () => {
    const { admin, cookie } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id);
    const process = await processServiceFor(ctx).createProcess(admin.id, {
      customerId: customer.id,
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${process.id}/complete`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const stored = await ctx.pool.query(
      'SELECT main_status, completed_at FROM processes WHERE id = $1',
      [process.id],
    );
    expect(stored.rows[0].main_status).toBe('completed');
    expect(stored.rows[0].completed_at).not.toBeNull();
  });

  it('16. abgeschlossener Vorgang ist für normale Bearbeitung gesperrt', async () => {
    const { admin, cookie } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id);
    const service = processServiceFor(ctx);
    const process = await service.createProcess(admin.id, { customerId: customer.id });
    await service.complete(process.id, adminVisibilityCtx());

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/processes/${process.id}`,
      headers: { cookie },
      payload: { eventDate: '2027-01-01' },
    });
    expect(patch.statusCode).toBe(409);

    const note = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${process.id}/notes`,
      headers: { cookie },
      payload: { text: 'Nachtrag' },
    });
    expect(note.statusCode).toBe(409);

    const assign = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${process.id}/assign`,
      headers: { cookie },
      payload: { userId: null },
    });
    expect(assign.statusCode).toBe(409);
  });

  it('17. Wiederöffnen mit Recht: Status „Wieder geöffnet“, erneut abschließbar', async () => {
    const { admin, cookie } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id);
    const service = processServiceFor(ctx);
    const process = await service.createProcess(admin.id, { customerId: customer.id });
    await service.complete(process.id, adminVisibilityCtx());

    const reopen = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${process.id}/reopen`,
      headers: { cookie },
    });
    expect(reopen.statusCode).toBe(200);
    const stored = await ctx.pool.query(
      'SELECT main_status, reopened_at FROM processes WHERE id = $1',
      [process.id],
    );
    expect(stored.rows[0].main_status).toBe('reopened');
    expect(stored.rows[0].reopened_at).not.toBeNull();

    // Späteres erneutes Abschließen ist möglich (Phase-2-Vorgabe Nr. 10).
    const completeAgain = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${process.id}/complete`,
      headers: { cookie },
    });
    expect(completeAgain.statusCode).toBe(200);
  });

  it('18. Wiederöffnen ohne Recht wird verweigert (403), Status unverändert', async () => {
    const { admin } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id);
    const service = processServiceFor(ctx);
    const process = await service.createProcess(admin.id, { customerId: customer.id });
    await service.complete(process.id, adminVisibilityCtx());

    const staff = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Nora',
      lastName: 'Normal',
      email: 'normal@test.example',
      password: 'normal-passwort-123',
      permissionKeys: ['process.view_all', 'process.edit', 'process.complete'],
    });
    const reopen = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${process.id}/reopen`,
      headers: { cookie: staff.cookie },
    });
    expect(reopen.statusCode).toBe(403);
    const stored = await ctx.pool.query('SELECT main_status FROM processes WHERE id = $1', [
      process.id,
    ]);
    expect(stored.rows[0].main_status).toBe('completed');
  });
});

describe('19.–20. Interne Notizen', () => {
  it('19. Notiz erstellen: gehört zum Vorgang, Autor wird angezeigt', async () => {
    const { admin, cookie } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id);
    const process = await processServiceFor(ctx).createProcess(admin.id, {
      customerId: customer.id,
    });
    const create = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${process.id}/notes`,
      headers: { cookie },
      payload: { text: 'Kunde ruft Montag zurück.' },
    });
    expect(create.statusCode).toBe(200);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${process.id}`,
      headers: { cookie },
    });
    const body = detail.json() as {
      notes: { text: string; authorFirstName: string; authorLastName: string }[];
    };
    expect(body.notes.length).toBe(1);
    expect(body.notes[0]?.text).toBe('Kunde ruft Montag zurück.');
    expect(body.notes[0]?.authorFirstName).toBe('Anna');
    expect(body.notes[0]?.authorLastName).toBe('Admin');
  });

  it('20. Kein IDOR: Notizen unsichtbarer/unberechtigter Vorgänge sind nicht abrufbar', async () => {
    const { admin } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id);
    const service = processServiceFor(ctx);
    const process = await service.createProcess(admin.id, { customerId: customer.id });
    await service.addNote(process.id, admin.id, 'Vertrauliche interne Notiz', adminVisibilityCtx());
    await service.complete(process.id, adminVisibilityCtx());
    await setCompletedVisibilityDays(ctx.db, admin.id, 0);

    // Ohne process.view_all: 403 – kein Zugriff auf fremde Vorgänge/Notizen.
    const noRight = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Karl',
      lastName: 'Kundenpfleger',
      email: 'kunden@test.example',
      password: 'kunden-passwort-123',
      permissionKeys: ['customer.view'],
    });
    const forbidden = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${process.id}`,
      headers: { cookie: noRight.cookie },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.body).not.toContain('Vertrauliche interne Notiz');

    // Mit view_all, aber ohne view_completed und abgelaufener Frist: 404.
    const normal = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Nora',
      lastName: 'Normal',
      email: 'normal@test.example',
      password: 'normal-passwort-123',
      permissionKeys: ['process.view_all'],
    });
    const invisible = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${process.id}`,
      headers: { cookie: normal.cookie },
    });
    expect(invisible.statusCode).toBe(404);
    expect(invisible.body).not.toContain('Vertrauliche interne Notiz');
  });
});

describe('32. Manipulierte API-Aufrufe ohne Recht + Papierkorbregeln', () => {
  it('32. Kunden-/Vorgangs-Endpunkte verweigern ohne Recht mit 403', async () => {
    const { admin } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id);
    const process = await processServiceFor(ctx).createProcess(admin.id, {
      customerId: customer.id,
    });
    const staff = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Otto',
      lastName: 'OhneRechte',
      email: 'ohne@test.example',
      password: 'ohne-passwort-123',
      permissionKeys: [],
    });
    const cases: {
      method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
      url: string;
      payload?: object;
    }[] = [
      { method: 'GET', url: '/staff/customers' },
      {
        method: 'POST',
        url: '/staff/customers',
        payload: { type: 'private', firstName: 'A', lastName: 'B' },
      },
      { method: 'PATCH', url: `/staff/customers/${customer.id}`, payload: { type: 'private' } },
      { method: 'DELETE', url: `/staff/customers/${customer.id}` },
      { method: 'GET', url: '/staff/trash/customers' },
      { method: 'POST', url: '/staff/processes', payload: { customerId: customer.id } },
      { method: 'GET', url: '/staff/processes' },
      { method: 'GET', url: `/staff/processes/${process.id}` },
      { method: 'PATCH', url: `/staff/processes/${process.id}`, payload: { eventDate: null } },
      {
        method: 'POST',
        url: `/staff/processes/${process.id}/assign`,
        payload: { userId: null },
      },
      { method: 'POST', url: `/staff/processes/${process.id}/complete` },
      { method: 'POST', url: `/staff/processes/${process.id}/notes`, payload: { text: 'x' } },
      { method: 'GET', url: '/staff/settings/completed-visibility' },
      { method: 'GET', url: `/staff/customers/${customer.id}` },
      {
        method: 'POST',
        url: '/staff/customers/duplicate-check',
        payload: { type: 'private', firstName: 'A', lastName: 'B' },
      },
      { method: 'POST', url: `/staff/trash/customers/${customer.id}/restore` },
      { method: 'POST', url: `/staff/processes/${process.id}/reopen` },
      { method: 'POST', url: `/staff/processes/${process.id}/cancel` },
      { method: 'PUT', url: '/staff/settings/completed-visibility', payload: { days: 1 } },
      { method: 'GET', url: '/staff/staff-options' },
    ];
    for (const testCase of cases) {
      const response = await ctx.app.inject({
        method: testCase.method,
        url: testCase.url,
        headers: { cookie: staff.cookie },
        ...(testCase.payload === undefined ? {} : { payload: testCase.payload }),
      });
      expect(response.statusCode, `${testCase.method} ${testCase.url}`).toBe(403);
    }
  });

  it('Papierkorb: Kunde mit Vorgängen ist nicht löschbar, ohne Vorgänge schon (mit Wiederherstellung)', async () => {
    const { admin, cookie } = await adminSession();
    const withProcess = await createTestCustomer(ctx, admin.id, { lastName: 'MitVorgang' });
    await processServiceFor(ctx).createProcess(admin.id, { customerId: withProcess.id });
    const blocked = await ctx.app.inject({
      method: 'DELETE',
      url: `/staff/customers/${withProcess.id}`,
      headers: { cookie },
    });
    expect(blocked.statusCode).toBe(409);

    const deletable = await createTestCustomer(ctx, admin.id, { lastName: 'OhneVorgang' });
    const trashed = await ctx.app.inject({
      method: 'DELETE',
      url: `/staff/customers/${deletable.id}`,
      headers: { cookie },
    });
    expect(trashed.statusCode).toBe(200);

    // Im Papierkorb, nicht hart gelöscht:
    const trashList = await ctx.app.inject({
      method: 'GET',
      url: '/staff/trash/customers',
      headers: { cookie },
    });
    const trashBody = trashList.json() as { customers: { id: string }[] };
    expect(trashBody.customers.some((c) => c.id === deletable.id)).toBe(true);

    const restore = await ctx.app.inject({
      method: 'POST',
      url: `/staff/trash/customers/${deletable.id}/restore`,
      headers: { cookie },
    });
    expect(restore.statusCode).toBe(200);
    const detail = await customerServiceFor(ctx).getActiveCustomer(deletable.id);
    expect(detail.deletedAt).toBeNull();
  });

  it('Es existiert kein Hard-Delete-Endpunkt für Vorgänge', async () => {
    const { admin, cookie } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id);
    const process = await processServiceFor(ctx).createProcess(admin.id, {
      customerId: customer.id,
    });
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/staff/processes/${process.id}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    const stored = await ctx.pool.query('SELECT count(*)::int AS n FROM processes');
    expect(stored.rows[0].n).toBe(1);
  });
});

describe('Härtungen aus dem adversarialen Phase-2-Review', () => {
  it('Erstzuweisung beim Anlegen verlangt process.reassign (kein Bypass über create)', async () => {
    const { admin } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id);
    const creator = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Carla',
      lastName: 'Creator',
      email: 'creator@test.example',
      password: 'creator-passwort-123',
      permissionKeys: ['process.create', 'process.view_all'],
    });

    const withAssignee = await ctx.app.inject({
      method: 'POST',
      url: '/staff/processes',
      headers: { cookie: creator.cookie },
      payload: { customerId: customer.id, assignedUserId: admin.id },
    });
    expect(withAssignee.statusCode).toBe(403);
    const count = await ctx.pool.query('SELECT count(*)::int AS n FROM processes');
    expect(count.rows[0].n).toBe(0);

    // Ohne Zuweisung bleibt das Anlegen mit process.create möglich.
    const plain = await ctx.app.inject({
      method: 'POST',
      url: '/staff/processes',
      headers: { cookie: creator.cookie },
      payload: { customerId: customer.id },
    });
    expect(plain.statusCode).toBe(200);
  });

  it('Schreibzugriffe auf unsichtbare Vorgänge liefern 404 (kein Status-Orakel, kein Bearbeiten)', async () => {
    const { admin, cookie } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id);
    const service = processServiceFor(ctx);
    const staff = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Nora',
      lastName: 'Normal',
      email: 'normal@test.example',
      password: 'normal-passwort-123',
      permissionKeys: ['process.view_all', 'process.edit', 'process.complete'],
    });

    // Fall a: wieder geöffneter Vorgang (ohne view_completed unsichtbar).
    const reopened = await service.createProcess(admin.id, { customerId: customer.id });
    await service.complete(reopened.id, adminVisibilityCtx());
    await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${reopened.id}/reopen`,
      headers: { cookie },
    });
    for (const attempt of [
      {
        method: 'PATCH' as const,
        url: `/staff/processes/${reopened.id}`,
        payload: { eventDate: null },
      },
      {
        method: 'POST' as const,
        url: `/staff/processes/${reopened.id}/notes`,
        payload: { text: 'x' },
      },
      {
        method: 'POST' as const,
        url: `/staff/processes/${reopened.id}/complete`,
        payload: undefined,
      },
    ]) {
      const response = await ctx.app.inject({
        method: attempt.method,
        url: attempt.url,
        headers: { cookie: staff.cookie },
        ...(attempt.payload === undefined ? {} : { payload: attempt.payload }),
      });
      expect(response.statusCode, `${attempt.method} ${attempt.url}`).toBe(404);
    }
    const unchanged = await ctx.pool.query('SELECT main_status FROM processes WHERE id = $1', [
      reopened.id,
    ]);
    expect(unchanged.rows[0].main_status).toBe('reopened');

    // Fall b: abgeschlossener Vorgang außerhalb der Frist → 404 statt 409.
    const done = await service.createProcess(admin.id, { customerId: customer.id });
    await service.complete(done.id, adminVisibilityCtx());
    await setCompletedVisibilityDays(ctx.db, admin.id, 0);
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/processes/${done.id}`,
      headers: { cookie: staff.cookie },
      payload: { eventDate: null },
    });
    expect(patch.statusCode).toBe(404);
  });

  it('Unmögliche Kalenderdaten: 400 statt Datenbankfehler; Suche bleibt stabil', async () => {
    const { admin, cookie } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id);
    const process = await processServiceFor(ctx).createProcess(admin.id, {
      customerId: customer.id,
    });

    const badDate = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/processes/${process.id}`,
      headers: { cookie },
      payload: { eventDate: '2026-02-31' },
    });
    expect(badDate.statusCode).toBe(400);

    for (const q of ['31.02.2026', '2026-99-99']) {
      const search = await ctx.app.inject({
        method: 'GET',
        url: `/staff/search?q=${encodeURIComponent(q)}`,
        headers: { cookie },
      });
      expect(search.statusCode, q).toBe(200);
    }
  });

  it('Vorgangsdetail liefert nur Anzeige-/Kontaktdaten des Kunden (Datenminimierung)', async () => {
    const { admin, cookie } = await adminSession();
    const service = customerServiceFor(ctx);
    const { customer } = await service.createCustomer(admin.id, {
      type: 'organization',
      organizationName: 'Datenminimal GmbH',
      email: 'dm@test.example',
      billingStreet: 'Geheimweg 1',
      vatId: 'DE999999999',
      costCenter: 'K-42',
    });
    const process = await processServiceFor(ctx).createProcess(admin.id, {
      customerId: customer.id,
    });
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${process.id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { customer: Record<string, unknown> };
    expect(body.customer.organizationName).toBe('Datenminimal GmbH');
    expect(body.customer).not.toHaveProperty('billingStreet');
    expect(body.customer).not.toHaveProperty('vatId');
    expect(body.customer).not.toHaveProperty('costCenter');
    expect(detail.body).not.toContain('Geheimweg');
  });

  it('Stornieren verlangt das eigene Recht process.cancel (nicht booking.cancel)', async () => {
    const { admin } = await adminSession();
    const customer = await createTestCustomer(ctx, admin.id);
    const process = await processServiceFor(ctx).createProcess(admin.id, {
      customerId: customer.id,
    });
    const bookingOnly = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Bodo',
      lastName: 'Buchung',
      email: 'buchung@test.example',
      password: 'buchung-passwort-123',
      permissionKeys: ['process.view_all', 'booking.cancel'],
    });
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${process.id}/cancel`,
      headers: { cookie: bookingOnly.cookie },
    });
    expect(denied.statusCode).toBe(403);

    const canceller = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Stella',
      lastName: 'Storno',
      email: 'storno@test.example',
      password: 'storno-passwort-123',
      permissionKeys: ['process.view_all', 'process.cancel'],
    });
    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${process.id}/cancel`,
      headers: { cookie: canceller.cookie },
    });
    expect(ok.statusCode).toBe(200);
    const stored = await ctx.pool.query(
      'SELECT main_status, cancelled_at FROM processes WHERE id = $1',
      [process.id],
    );
    expect(stored.rows[0].main_status).toBe('cancelled');
    expect(stored.rows[0].cancelled_at).not.toBeNull();
  });
});
