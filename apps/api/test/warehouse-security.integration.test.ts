/**
 * Phase-5-Pflichttests 74–84 (Order §57): IDOR (Maschinen, QR, Foto,
 * Lager, Inventur), verborgene Bewegungshistorie, keine direkte
 * Bestandsmanipulation, Datenminimierung und Umgebungs-/Storage-Isolation.
 */
import { randomUUID } from 'node:crypto';
import { assertConfigsIsolated, loadConfig } from '@mietroyal/config';
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
  inventoryServiceFor,
  machineByCode,
  productBySlug,
  resetWarehouse,
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

describe('74.–79. IDOR & verborgene Bereiche', () => {
  it('74. Machine-IDOR: ohne Recht 403, unbekannte IDs neutral 404', async () => {
    const { admin, cookie } = await adminSession();
    const outsider = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Ivo',
      lastName: 'Idor',
      email: 'ivo.idor@test.example',
      password: 'ivo-passwort-1234',
      permissionKeys: ['customer.view'],
    });
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    const forbidden = await ctx.app.inject({
      method: 'GET',
      url: `/staff/machines/${machine.id}`,
      headers: { cookie: outsider.cookie },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.body).not.toContain('MR-10-01-01');
    const unknown = await ctx.app.inject({
      method: 'GET',
      url: `/staff/machines/${randomUUID()}`,
      headers: { cookie },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('75. QR-IDOR: Resolver liefert ohne Recht/Session keinerlei Maschinendaten', async () => {
    const { admin } = await adminSession();
    const machine = await machineByCode(ctx.db, 'MR-10-01-02');
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/staff/machines/qr/${machine.qrToken}`,
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.body).not.toContain(machine.id);
    const outsider = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Q',
      lastName: 'Los',
      email: 'q.los@test.example',
      password: 'q-los-passwort-1234',
      permissionKeys: ['inventory.view'],
    });
    const forbidden = await ctx.app.inject({
      method: 'GET',
      url: `/staff/machines/qr/${machine.qrToken}`,
      headers: { cookie: outsider.cookie },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.body).not.toContain(machine.id);
  });

  it('76. Referenzfoto: Ersetzen ohne Recht blockiert', async () => {
    const { admin } = await adminSession();
    const outsider = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Foto',
      lastName: 'Frei',
      email: 'foto.frei@test.example',
      password: 'foto-passwort-1234',
      permissionKeys: ['machine.view'],
    });
    const machine = await machineByCode(ctx.db, 'MR-10-01-03');
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/staff/machines/${machine.id}/reference-photo`,
      headers: { cookie: outsider.cookie },
      payload: { mimeType: 'image/png', dataBase64: 'aGFsbG8=' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('77./78./79. Lager-/Inventur-/Historien-Endpunkte sind serverseitig geschützt', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const item = (await inventory.listItems())[0]!;
    const outsider = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Lara',
      lastName: 'Lagerlos',
      email: 'lara.lagerlos@test.example',
      password: 'lara-passwort-1234',
      permissionKeys: ['customer.view'],
    });
    for (const [method, url, payload] of [
      ['GET', '/staff/inventory', undefined],
      ['POST', `/staff/inventory/${item.itemId}/receive`, { addedQuantity: 5 }],
      ['PUT', `/staff/inventory/${item.itemId}/min-stock`, { minStock: 5 }],
      ['GET', '/staff/inventory/movements', undefined],
      [
        'POST',
        '/staff/inventory/stocktakes',
        { entries: [{ itemId: item.itemId, countedStock: 1 }] },
      ],
      ['GET', '/staff/inventory/stocktakes', undefined],
      ['POST', `/staff/inventory/stocktakes/${randomUUID()}/approve`, undefined],
    ] as const) {
      const response = await ctx.app.inject({
        method,
        url,
        headers: { cookie: outsider.cookie },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
    // Unbekannte Inventur-ID für Berechtigte: neutral 404.
    const { cookie } = { cookie: (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie };
    const unknown = await ctx.app.inject({
      method: 'GET',
      url: `/staff/inventory/stocktakes/${randomUUID()}`,
      headers: { cookie },
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('80.–82. Direkte Manipulation & Datenminimierung', () => {
  it('80. current_stock ist über keine API direkt setzbar (nur Bewegungen)', async () => {
    const { admin, cookie } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const item = (await inventory.listItems())[0]!;
    const stocktake = await inventory.createStocktake(admin.id, [
      { itemId: item.itemId, countedStock: 10 },
    ]);
    await inventory.approveStocktake(admin.id, stocktake.id);

    // Strikte Schemas lehnen eingeschmuggelte Bestandsfelder ab.
    for (const [method, url, payload] of [
      ['POST', `/staff/inventory/${item.itemId}/receive`, { addedQuantity: 1, currentStock: 999 }],
      ['PUT', `/staff/inventory/${item.itemId}/min-stock`, { minStock: 1, currentStock: 999 }],
      [
        'POST',
        '/staff/inventory/stocktakes',
        { entries: [{ itemId: item.itemId, countedStock: 1, currentStock: 999 }] },
      ],
    ] as const) {
      const response = await ctx.app.inject({
        method,
        url,
        headers: { cookie },
        payload,
      });
      expect(response.statusCode, `${method} ${url}`).toBe(400);
    }
    expect((await inventory.itemById(item.itemId)).item.currentStock).toBe(10);
  });

  it('81./82. Keine Storage-Keys/QR-Token in normalen Maschinenantworten (Datenminimierung)', async () => {
    const { cookie } = await adminSession();
    const machine = await machineByCode(ctx.db, 'MR-10-02-01');
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/staff/machines/${machine.id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    // Storage-Schlüssel und QR-Token gehören NICHT in die Detailantwort –
    // der QR-Token kommt nur über den eigenen, separat berechtigten Endpunkt.
    expect(detail.body).not.toContain('referencePhotoKey');
    expect(detail.body).not.toContain(machine.qrToken);
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/staff/machines',
      headers: { cookie },
    });
    expect(list.body).not.toContain(machine.qrToken);
    expect(list.body).not.toContain('reference_photo_key');
  });
});

describe('83.–84. Umgebungs- und Storage-Isolation', () => {
  it('Demo/Produktion inkl. Storage-Bucket kollidieren weiterhin nicht unbemerkt', () => {
    const base = {
      APP_ENV: 'production',
      DATABASE_URL: 'postgresql://prod:SYNTH@db-prod.internal:5432/mietroyal_prod',
      AUTH_SECRET_KEY: '1'.repeat(64),
      STORAGE_DRIVER: 's3',
      STORAGE_S3_ENDPOINT: 'https://s3.synthetic.example',
      STORAGE_S3_REGION: 'eu-central-1',
      STORAGE_S3_BUCKET: 'mietroyal-prod-documents',
      STORAGE_S3_ACCESS_KEY_ID: 'SYNTH-PROD',
      STORAGE_S3_SECRET_ACCESS_KEY: 'SYNTH-prod-secret',
    };
    const production = loadConfig(base);
    const demo = loadConfig({
      ...base,
      APP_ENV: 'demo',
      DATABASE_URL: 'postgresql://demo:SYNTH@db-demo.internal:5432/mietroyal_demo',
      AUTH_SECRET_KEY: '2'.repeat(64),
      STORAGE_S3_BUCKET: 'mietroyal-demo-documents',
      STORAGE_S3_ACCESS_KEY_ID: 'SYNTH-DEMO',
      STORAGE_S3_SECRET_ACCESS_KEY: 'SYNTH-demo-secret',
    });
    expect(() => assertConfigsIsolated(production, demo)).not.toThrow();
    // Gleicher Bucket = Storage-Kollision → Fehler.
    const collidingStorage = loadConfig({
      ...base,
      APP_ENV: 'demo',
      DATABASE_URL: 'postgresql://demo:SYNTH@db-demo.internal:5432/mietroyal_demo',
      AUTH_SECRET_KEY: '2'.repeat(64),
    });
    expect(() => assertConfigsIsolated(production, collidingStorage)).toThrow();
  });
});

describe('R5–R6. Review-Fixes: Datenminimierung bei Mutationen & QR-Basis-URL', () => {
  it('R5. Auch Mutationsantworten enthalten weder QR-Token noch Storage-Keys', async () => {
    const { cookie } = await adminSession();
    const machine = await machineByCode(ctx.db, 'MR-10-02-01');
    const product = await productBySlug(ctx.db, 'slush-2x8');

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/staff/machines',
      headers: { cookie },
      payload: { productId: product.id },
    });
    expect(created.statusCode).toBe(200);
    expect(created.body).not.toContain('qrToken');
    expect(created.body).not.toContain('referencePhotoKey');

    const status = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/status`,
      headers: { cookie },
      payload: { status: 'repair' },
    });
    expect(status.statusCode).toBe(200);
    expect(status.body).not.toContain(machine.qrToken);
    expect(status.body).not.toContain('qrToken');

    const location = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/location`,
      headers: { cookie },
      payload: { locationKind: 'repair' },
    });
    expect(location.statusCode).toBe(200);
    expect(location.body).not.toContain(machine.qrToken);

    const master = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/machines/${machine.id}`,
      headers: { cookie },
      payload: { weightGrams: 21000 },
    });
    expect(master.statusCode).toBe(200);
    expect(master.body).not.toContain(machine.qrToken);
    expect(master.body).not.toContain('referencePhotoKey');
  });

  it('R6. QR-Basis-URL ist NUR mit system.settings pflegbar und wirkt sofort auf den QR-Endpunkt', async () => {
    const { admin, cookie } = await adminSession();
    const outsider = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Selma',
      lastName: 'Settings',
      email: 'selma.settings@test.example',
      password: 'selma-passwort-1234',
      permissionKeys: ['machine.view', 'machine.qr'],
    });
    const denied = await ctx.app.inject({
      method: 'PUT',
      url: '/staff/settings/staff-app-base-url',
      headers: { cookie: outsider.cookie },
      payload: { url: 'https://staff.example.de' },
    });
    expect(denied.statusCode).toBe(403);

    const invalid = await ctx.app.inject({
      method: 'PUT',
      url: '/staff/settings/staff-app-base-url',
      headers: { cookie },
      payload: { url: 'kein-schema.example' },
    });
    expect(invalid.statusCode).toBe(400);

    const saved = await ctx.app.inject({
      method: 'PUT',
      url: '/staff/settings/staff-app-base-url',
      headers: { cookie },
      payload: { url: 'https://staff.example.de/' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().url).toBe('https://staff.example.de');

    const machine = await machineByCode(ctx.db, 'MR-10-02-01');
    const qr = await ctx.app.inject({
      method: 'GET',
      url: `/staff/machines/${machine.id}/qr`,
      headers: { cookie },
    });
    expect(qr.statusCode).toBe(200);
    const body = qr.json() as { url: string | null; baseConfigured: boolean };
    expect(body.baseConfigured).toBe(true);
    expect(body.url).toBe(`https://staff.example.de/qr/${machine.qrToken}`);
  });
});
