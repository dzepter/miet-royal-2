/**
 * Phase-5-Pflichttests 40–58 (Order §§53–55): Lagerinitialisierung ohne
 * erfundene Bestände, Wareneingang als hinzugefügte Menge, Mindestbestand
 * und Warnungen, deaktivierte Artikel.
 */
import { inventoryMovements } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
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
import { inventoryServiceFor, resetWarehouse } from './warehouse-helpers.ts';

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

/** Artikel initialisieren (Erstinventur über den echten Freigabepfad). */
async function initializeItem(adminId: string, itemId: string, stock: number) {
  const inventory = inventoryServiceFor(ctx);
  const stocktake = await inventory.createStocktake(adminId, [{ itemId, countedStock: stock }]);
  await inventory.approveStocktake(adminId, stocktake.id);
}

describe('40.–46. Lagerinitialisierung', () => {
  it('40./41./42. Alle bekannten Artikel existieren – OHNE erfundenen Anfangsbestand', async () => {
    const inventory = inventoryServiceFor(ctx);
    const items = await inventory.listItems();
    expect(items.map((item) => item.productSlug).sort()).toEqual([
      'becher-25',
      'mischkanister-6l',
      'sirup-blaue-himbeere',
      'sirup-kirsche',
      'sirup-waldmeister',
      'sirup-wassermelone',
      'strohhalme-25',
    ]);
    for (const item of items) {
      // NICHT still 0: unbekannter Bestand ist NULL ("Noch nicht erfasst").
      expect(item.currentStock).toBeNull();
      expect(item.minStock).toBeNull();
    }
  });

  it('43. Ohne Konfiguration/Initialisierung entsteht keine falsche Mindestbestandswarnung', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    let items = await inventory.listItems();
    expect(items.every((item) => item.lowStock === false)).toBe(true);
    // Auch mit gesetztem Minimum, aber OHNE erfassten Bestand: keine Warnung.
    const becher = items.find((item) => item.productSlug === 'becher-25')!;
    await inventory.setMinStock(becher.itemId, 10);
    items = await inventory.listItems();
    expect(items.find((item) => item.productSlug === 'becher-25')!.lowStock).toBe(false);
    void admin;
  });

  it('44./45./46. Anfangsbestand erfassen → nach Freigabe exakt und ohne Float-Artefakte', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const items = await inventory.listItems();
    const sirup = items.find((item) => item.productSlug === 'sirup-kirsche')!;
    const stocktake = await inventory.createStocktake(admin.id, [
      { itemId: sirup.itemId, countedStock: 17 },
    ]);
    // Erstinventur braucht IMMER die Freigabe (erste freigegebene Erfassung).
    expect(stocktake.status).toBe('pending_approval');
    expect((await inventory.itemById(sirup.itemId)).item.currentStock).toBeNull();
    await inventory.approveStocktake(admin.id, stocktake.id);
    const after = await inventory.itemById(sirup.itemId);
    expect(after.item.currentStock).toBe(17);
    expect(Number.isInteger(after.item.currentStock)).toBe(true);
    const movements = await ctx.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.itemId, sirup.itemId));
    expect(movements).toHaveLength(1);
    expect(movements[0]!.kind).toBe('initial');
  });
});

describe('47.–52. Wareneingang', () => {
  it('47./48./50. +Menge erhöht den Bestand exakt; API nimmt NUR die hinzugefügte Menge', async () => {
    const { admin, cookie } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const becher = (await inventory.listItems()).find((item) => item.productSlug === 'becher-25')!;
    await initializeItem(admin.id, becher.itemId, 8);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/inventory/${becher.itemId}/receive`,
      headers: { cookie },
      payload: { addedQuantity: 12 },
    });
    expect(response.statusCode).toBe(200);
    expect((await inventory.itemById(becher.itemId)).item.currentStock).toBe(20);

    // Ein "neuer Gesamtbestand" wird abgelehnt (strictes Schema).
    const total = await ctx.app.inject({
      method: 'POST',
      url: `/staff/inventory/${becher.itemId}/receive`,
      headers: { cookie },
      payload: { newTotalStock: 50 },
    });
    expect(total.statusCode).toBe(400);

    const movements = await ctx.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.itemId, becher.itemId));
    expect(movements.some((movement) => movement.kind === 'incoming')).toBe(true);
    const incoming = movements.find((movement) => movement.kind === 'incoming')!;
    expect(incoming.quantityDelta).toBe(12);
    expect(incoming.resultingStock).toBe(20);
  });

  it('49. Zwei parallele Wareneingänge gehen BEIDE ein (kein Lost Update)', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const kanister = (await inventory.listItems()).find(
      (item) => item.productSlug === 'mischkanister-6l',
    )!;
    await initializeItem(admin.id, kanister.itemId, 5);
    await Promise.all([
      inventory.receive(admin.id, kanister.itemId, 3),
      inventory.receive(admin.id, kanister.itemId, 4),
    ]);
    expect((await inventory.itemById(kanister.itemId)).item.currentStock).toBe(12);
    const movements = await ctx.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.itemId, kanister.itemId));
    expect(movements.filter((movement) => movement.kind === 'incoming')).toHaveLength(2);
  });

  it('51. Ohne inventory.add_stock ist der Wareneingang blockiert', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const becher = (await inventory.listItems()).find((item) => item.productSlug === 'becher-25')!;
    await initializeItem(admin.id, becher.itemId, 8);
    const viewer = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Vera',
      lastName: 'Viewer',
      email: 'vera.viewer@test.example',
      password: 'vera-passwort-1234',
      permissionKeys: ['inventory.view'],
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/inventory/${becher.itemId}/receive`,
      headers: { cookie: viewer.cookie },
      payload: { addedQuantity: 5 },
    });
    expect(response.statusCode).toBe(403);
    expect((await inventory.itemById(becher.itemId)).item.currentStock).toBe(8);
  });

  it('52. Null-, negative und nicht ganzzahlige Mengen werden sauber validiert', async () => {
    const { admin, cookie } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const becher = (await inventory.listItems()).find((item) => item.productSlug === 'becher-25')!;
    await initializeItem(admin.id, becher.itemId, 8);
    for (const addedQuantity of [0, -3, 2.5]) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/staff/inventory/${becher.itemId}/receive`,
        headers: { cookie },
        payload: { addedQuantity },
      });
      expect(response.statusCode, String(addedQuantity)).toBe(400);
    }
    expect((await inventory.itemById(becher.itemId)).item.currentStock).toBe(8);
  });
});

describe('53.–58. Mindestbestand & Deaktivierung', () => {
  it('53.–57. Warnungslogik: unter Minimum warnt, ab Minimum nicht; Wareneingang beendet die Warnung', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const strohhalme = (await inventory.listItems()).find(
      (item) => item.productSlug === 'strohhalme-25',
    )!;
    await initializeItem(admin.id, strohhalme.itemId, 4);
    await inventory.setMinStock(strohhalme.itemId, 6);

    const lowState = (await inventory.listItems()).find(
      (item) => item.itemId === strohhalme.itemId,
    )!;
    expect(lowState.lowStock).toBe(true);
    expect((await inventory.lowStockItems()).map((item) => item.productSlug)).toContain(
      'strohhalme-25',
    );

    // Bestand = Minimum → KEINE Unterbestandswarnung.
    await inventory.receive(admin.id, strohhalme.itemId, 2);
    expect(
      (await inventory.listItems()).find((item) => item.itemId === strohhalme.itemId)!.lowStock,
    ).toBe(false);

    // Bestand über Minimum → weiterhin keine Warnung.
    await inventory.receive(admin.id, strohhalme.itemId, 10);
    expect(
      (await inventory.listItems()).find((item) => item.itemId === strohhalme.itemId)!.lowStock,
    ).toBe(false);
  });

  it('58. Deaktivierte Artikel bleiben historisch erhalten (Bewegungen/Inventuren)', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const kanister = (await inventory.listItems()).find(
      (item) => item.productSlug === 'mischkanister-6l',
    )!;
    await initializeItem(admin.id, kanister.itemId, 5);
    await inventory.receive(admin.id, kanister.itemId, 2);
    await ctx.pool.query(`UPDATE products SET active = false WHERE slug = 'mischkanister-6l'`);

    const items = await inventory.listItems();
    const row = items.find((item) => item.productSlug === 'mischkanister-6l');
    expect(row).toBeDefined();
    expect(row!.productActive).toBe(false);
    expect(row!.currentStock).toBe(7);
    const movements = await inventory.listMovements();
    expect(movements.some((movement) => movement.productName === row!.productName)).toBe(true);
  });
});

describe('R8. Review-Fix: Deaktivierte Artikel serverseitig nur historisch', () => {
  it('R8. Wareneingang, Mindestbestand und neue Inventur sind für deaktivierte Artikel blockiert', async () => {
    const { admin, cookie } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const item = (await inventory.listItems()).find(
      (entry) => entry.productSlug === 'mischkanister-6l',
    )!;
    await initializeItem(admin.id, item.itemId, 4);
    await ctx.pool.query(`UPDATE products SET active = false WHERE slug = 'mischkanister-6l'`);

    const receive = await ctx.app.inject({
      method: 'POST',
      url: `/staff/inventory/${item.itemId}/receive`,
      headers: { cookie },
      payload: { addedQuantity: 3 },
    });
    expect(receive.statusCode).toBe(400);
    expect(receive.json().error.message).toContain('deaktiviert');

    const minStock = await ctx.app.inject({
      method: 'PUT',
      url: `/staff/inventory/${item.itemId}/min-stock`,
      headers: { cookie },
      payload: { minStock: 2 },
    });
    expect(minStock.statusCode).toBe(400);

    const stocktake = await ctx.app.inject({
      method: 'POST',
      url: '/staff/inventory/stocktakes',
      headers: { cookie },
      payload: { entries: [{ itemId: item.itemId, countedStock: 4 }] },
    });
    expect(stocktake.statusCode).toBe(400);

    // Bestand und Historie bleiben unverändert erhalten (Order §38).
    expect((await inventory.itemById(item.itemId)).item.currentStock).toBe(4);
  });
});
