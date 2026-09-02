/**
 * Phase-5-Pflichttests 1–22 (Order §51): initialer Maschinenbestand,
 * ID-Schema/-Vergabe, Stammdaten ohne erfundene Werte, Statusregeln,
 * Standort, Rechte, Referenzfoto und QR-Identifier.
 */
import { machines } from '@mietroyal/database';
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
import {
  allMachines,
  machineByCode,
  machineServiceFor,
  productBySlug,
  resetWarehouse,
  SEED_MACHINE_CODES,
} from './warehouse-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
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

describe('1.–3. Initialer Bestand', () => {
  it('1./2./3. Es existieren exakt 11 Maschinen mit Verteilung 2/1/6/2 und korrekten IDs', async () => {
    const rows = await allMachines(ctx.db);
    expect(rows).toHaveLength(11);
    expect(rows.map((row) => row.machineCode)).toEqual([...SEED_MACHINE_CODES]);
    const byPrefix = (prefix: string) =>
      rows.filter((row) => row.machineCode.startsWith(prefix)).length;
    expect(byPrefix('MR-08-01')).toBe(2);
    expect(byPrefix('MR-08-02')).toBe(1);
    expect(byPrefix('MR-10-01')).toBe(6);
    expect(byPrefix('MR-10-02')).toBe(2);
  });
});

describe('4.–8. Maschinen-ID', () => {
  it('4. Die Maschinen-ID ist datenbankseitig eindeutig', async () => {
    const seed = await machineByCode(ctx.db, 'MR-08-01-01');
    await expect(
      ctx.db.insert(machines).values({
        machineCode: 'MR-08-01-01',
        productId: seed.productId,
        qrToken: 'f'.repeat(48),
      }),
    ).rejects.toThrow();
  });

  it('5. Die Maschinen-ID ist nach Vergabe nicht änderbar (kein editierbares Feld)', async () => {
    const { cookie } = await adminSession();
    const seed = await machineByCode(ctx.db, 'MR-08-01-01');
    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/machines/${seed.id}`,
      headers: { cookie },
      payload: { machineCode: 'MR-99-99-99' },
    });
    expect(response.statusCode).toBe(400);
    const after = await machineByCode(ctx.db, 'MR-08-01-01');
    expect(after.machineCode).toBe('MR-08-01-01');
  });

  it('6./8. Eine neue Maschine desselben Typs erhält die nächste Laufnummer im Typ-Schema', async () => {
    const service = machineServiceFor(ctx);
    const product = await productBySlug(ctx.db, 'slush-2x8');
    const created = await service.createMachine({ productId: product.id });
    expect(created.machineCode).toBe('MR-08-02-02');
    const bigger = await productBySlug(ctx.db, 'slush-1x10');
    const created2 = await service.createMachine({ productId: bigger.id });
    expect(created2.machineCode).toBe('MR-10-01-07');
  });

  it('7. Paralleles Anlegen erzeugt keine doppelte ID', async () => {
    const service = machineServiceFor(ctx);
    const product = await productBySlug(ctx.db, 'slush-1x8');
    const [a, b, c] = await Promise.all([
      service.createMachine({ productId: product.id }),
      service.createMachine({ productId: product.id }),
      service.createMachine({ productId: product.id }),
    ]);
    const codes = [a.machineCode, b.machineCode, c.machineCode].sort();
    expect(new Set(codes).size).toBe(3);
    expect(codes).toEqual(['MR-08-01-03', 'MR-08-01-04', 'MR-08-01-05']);
  });
});

describe('9.–11. Stammdaten ohne erfundene Werte', () => {
  it('9./10. Unbekanntes Kaufdatum und Gewicht bleiben NULL', async () => {
    const rows = await allMachines(ctx.db);
    for (const row of rows) {
      expect(row.purchaseDate).toBeNull();
      expect(row.weightGrams).toBeNull();
    }
  });

  it('11. Tragepersonen kommen aus der Produkttyp-Logik (1×→1, 2×→2)', async () => {
    const { cookie } = await adminSession();
    const single = await machineByCode(ctx.db, 'MR-10-01-01');
    const twin = await machineByCode(ctx.db, 'MR-10-02-01');
    for (const [machine, expected] of [
      [single, 1],
      [twin, 2],
    ] as const) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/staff/machines/${machine.id}`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { machine: { carryPersons: number } }).machine.carryPersons).toBe(
        expected,
      );
    }
  });
});

describe('12.–16. Status & Standort', () => {
  it('12./13./14. Einsatzbereit/Reparatur/Außer Betrieb sind manuell setzbar; Reserviert nicht', async () => {
    const { cookie } = await adminSession();
    const machine = await machineByCode(ctx.db, 'MR-10-01-02');
    for (const status of ['repair', 'out_of_service', 'ready'] as const) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/staff/machines/${machine.id}/status`,
        headers: { cookie },
        payload: { status },
      });
      expect(response.statusCode, status).toBe(200);
      const row = await machineByCode(ctx.db, 'MR-10-01-02');
      expect(row.status).toBe(status);
    }
    // Reserviert/Vermietet sind KEIN manueller Alltagsstatus (Order §6).
    const reserved = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/status`,
      headers: { cookie },
      payload: { status: 'reserved' },
    });
    expect(reserved.statusCode).toBe(400);
  });

  it('15. Standortänderung mit zentraler Standortlogik', async () => {
    const { cookie } = await adminSession();
    const machine = await machineByCode(ctx.db, 'MR-08-02-01');
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/location`,
      headers: { cookie },
      payload: { locationKind: 'customer', locationNote: 'Testkunde Musterstadt' },
    });
    expect(response.statusCode).toBe(200);
    const row = await machineByCode(ctx.db, 'MR-08-02-01');
    expect(row.locationKind).toBe('customer');
    expect(row.locationNote).toBe('Testkunde Musterstadt');
  });

  it('16. Ohne Recht sind Status-/Standortänderung blockiert (serverseitig)', async () => {
    const { admin } = await adminSession();
    const viewer = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Vera',
      lastName: 'Viewer',
      email: 'vera.viewer@test.example',
      password: 'vera-passwort-1234',
      permissionKeys: ['machine.view'],
    });
    const machine = await machineByCode(ctx.db, 'MR-10-01-03');
    const status = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/status`,
      headers: { cookie: viewer.cookie },
      payload: { status: 'repair' },
    });
    expect(status.statusCode).toBe(403);
    const location = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/location`,
      headers: { cookie: viewer.cookie },
      payload: { locationKind: 'repair' },
    });
    expect(location.statusCode).toBe(403);
    expect((await machineByCode(ctx.db, 'MR-10-01-03')).status).toBe('ready');
  });
});

describe('17.–18. Referenzfoto', () => {
  const PNG = Buffer.from(
    '89504e470d0a1a0a0000000d494844520000000100000001080600000\
01f15c4890000000d4944415478da63fcffff3f0300050001b7f7dcf90000000049454e44ae426082'.replace(
      /\s/g,
      '',
    ),
    'hex',
  );

  it('17. Referenzfoto ist privat: Zugriff nur mit Staff-Login + Recht', async () => {
    const { admin, cookie } = await adminSession();
    const machine = await machineByCode(ctx.db, 'MR-10-02-01');
    const upload = await ctx.app.inject({
      method: 'PUT',
      url: `/staff/machines/${machine.id}/reference-photo`,
      headers: { cookie },
      payload: { mimeType: 'image/png', dataBase64: PNG.toString('base64') },
    });
    expect(upload.statusCode).toBe(200);

    // Ohne Login: 401 – kein öffentlicher Bucket-Zugriff.
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/staff/machines/${machine.id}/reference-photo`,
    });
    expect(anonymous.statusCode).toBe(401);

    // Ohne machine.view: 403.
    const outsider = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Otto',
      lastName: 'Ohne',
      email: 'otto.ohne@test.example',
      password: 'otto-passwort-1234',
      permissionKeys: ['customer.view'],
    });
    const forbidden = await ctx.app.inject({
      method: 'GET',
      url: `/staff/machines/${machine.id}/reference-photo`,
      headers: { cookie: outsider.cookie },
    });
    expect(forbidden.statusCode).toBe(403);

    // Mit Recht: Bytes kommen zurück.
    const allowed = await ctx.app.inject({
      method: 'GET',
      url: `/staff/machines/${machine.id}/reference-photo`,
      headers: { cookie },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['content-type']).toBe('image/png');
  });

  it('18. Ersetzen entfernt das alte Foto sauber – keine Foto-Historie', async () => {
    const { cookie } = await adminSession();
    const machine = await machineByCode(ctx.db, 'MR-10-02-02');
    const upload = async () =>
      ctx.app.inject({
        method: 'PUT',
        url: `/staff/machines/${machine.id}/reference-photo`,
        headers: { cookie },
        payload: { mimeType: 'image/png', dataBase64: PNG.toString('base64') },
      });
    expect((await upload()).statusCode).toBe(200);
    const firstKey = (await machineByCode(ctx.db, 'MR-10-02-02')).referencePhotoKey!;
    expect(await ctx.storage.exists(firstKey)).toBe(true);
    expect((await upload()).statusCode).toBe(200);
    const secondKey = (await machineByCode(ctx.db, 'MR-10-02-02')).referencePhotoKey!;
    expect(secondKey).not.toBe(firstKey);
    expect(await ctx.storage.exists(firstKey)).toBe(false);
    expect(await ctx.storage.exists(secondKey)).toBe(true);
  });
});

describe('19.–22. QR-Identifier', () => {
  it('19./20. QR-Identifier sind eindeutig, lang und nicht fortlaufend/erratbar', async () => {
    const rows = await allMachines(ctx.db);
    const tokens = rows.map((row) => row.qrToken);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const token of tokens) {
      expect(token).toMatch(/^[0-9a-f]{48,128}$/);
      // Kein Klartext: weder Maschinen-ID noch fortlaufende Muster.
      expect(token).not.toContain('mr-');
    }
    // Nicht fortlaufend: benachbarte Maschinen unterscheiden sich massiv.
    const [a, b] = tokens;
    let differing = 0;
    for (let index = 0; index < Math.min(a!.length, b!.length); index += 1) {
      if (a![index] !== b![index]) differing += 1;
    }
    expect(differing).toBeGreaterThan(16);
  });

  it('21. QR-Resolver verlangt Staff-Authentifizierung und machine.view', async () => {
    const { admin } = await adminSession();
    const machine = await machineByCode(ctx.db, 'MR-10-01-04');
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/staff/machines/qr/${machine.qrToken}`,
    });
    expect(anonymous.statusCode).toBe(401);
    const outsider = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Nils',
      lastName: 'Nichts',
      email: 'nils.nichts@test.example',
      password: 'nils-passwort-1234',
      permissionKeys: ['customer.view'],
    });
    const forbidden = await ctx.app.inject({
      method: 'GET',
      url: `/staff/machines/qr/${machine.qrToken}`,
      headers: { cookie: outsider.cookie },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.body).not.toContain(machine.id);
    expect(forbidden.body).not.toContain('MR-10-01-04');
  });

  it('22. Ungültige QR-Identifier werden neutral abgelehnt', async () => {
    const { cookie } = await adminSession();
    for (const token of ['0'.repeat(48), 'nicht-hex-token-123', 'a'.repeat(9)]) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/staff/machines/qr/${token}`,
        headers: { cookie },
      });
      expect(response.statusCode, token).toBe(404);
      expect(response.body).toContain('nicht gültig');
    }
  });
});

describe('R9–R10. Review-Fixes: Heute-Warnungen & ID-Schema-Grenzen', () => {
  it('R9. „Heute“-Warnungen zählen nur JETZT wirksame Sperren, keine rein zukünftigen', async () => {
    const { admin, cookie } = await adminSession();
    const service = machineServiceFor(ctx);
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    // Rein zukünftige Sperre (ab morgen): heute keine Warnung.
    await service.createBlock(machine.id, admin.id, {
      startsAt: new Date(Date.now() + 24 * 3_600_000),
      endsAt: new Date(Date.now() + 48 * 3_600_000),
      reason: 'Wartung morgen',
    });
    let response = await ctx.app.inject({
      method: 'GET',
      url: '/staff/warehouse/warnings',
      headers: { cookie },
    });
    let warnings = (response.json() as { machineWarnings: { machineCode: string }[] })
      .machineWarnings;
    expect(warnings.some((entry) => entry.machineCode === 'MR-10-01-01')).toBe(false);
    // Aktive Sperre (läuft bereits): Warnung erscheint.
    await service.createBlock(machine.id, admin.id, {
      startsAt: new Date(Date.now() - 1 * 3_600_000),
      endsAt: new Date(Date.now() + 6 * 3_600_000),
      reason: 'Läuft gerade',
    });
    response = await ctx.app.inject({
      method: 'GET',
      url: '/staff/warehouse/warnings',
      headers: { cookie },
    });
    warnings = (response.json() as { machineWarnings: { machineCode: string }[] }).machineWarnings;
    expect(warnings.some((entry) => entry.machineCode === 'MR-10-01-01')).toBe(true);
  });

  it('R10. Maschinentypen außerhalb des zweistelligen ID-Schemas werden verständlich abgelehnt', async () => {
    const { cookie } = await adminSession();
    // Produkt mit 100 L pro Behälter: MR-100-… würde das ID-Schema brechen.
    const inserted = await ctx.pool.query(
      `INSERT INTO products (slug, name, category, sale_unit,
        container_volume_liters, container_count, carry_persons, active, sort_order)
       VALUES ('slush-riese', 'Slush XXL', 'machine', 'Stück', 100, 1, 2, true, 99)
       RETURNING id`,
    );
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/staff/machines',
      headers: { cookie },
      payload: { productId: inserted.rows[0].id as string },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('1 bis 99');
  });
});
