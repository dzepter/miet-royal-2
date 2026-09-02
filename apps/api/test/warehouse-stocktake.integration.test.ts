/**
 * Phase-5-Pflichttests 59–73 (Order §56): Inventur (einzeln/komplett),
 * Differenzanzeige (absolut/prozentual, keine NaN/Infinity), Freigabe mit
 * genau einer Bewegung, Korrektur vor Freigabe, Double-Submit-/Race-
 * Sicherheit und Rechteprüfung.
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
import { percentDifference } from '../src/warehouse/inventory-service.ts';

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

async function initializeItem(adminId: string, itemId: string, stock: number) {
  const inventory = inventoryServiceFor(ctx);
  const stocktake = await inventory.createStocktake(adminId, [{ itemId, countedStock: stock }]);
  await inventory.approveStocktake(adminId, stocktake.id);
}

describe('59.–64. Inventur & Differenzanzeige', () => {
  it('59./61./62./63. Einzelartikel-Inventur zeigt System, Ist, absolute und prozentuale Differenz', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const becher = (await inventory.listItems()).find((item) => item.productSlug === 'becher-25')!;
    await initializeItem(admin.id, becher.itemId, 8);
    const stocktake = await inventory.createStocktake(admin.id, [
      { itemId: becher.itemId, countedStock: 6 },
    ]);
    expect(stocktake.items).toHaveLength(1);
    const line = stocktake.items[0]!;
    expect(line.systemStock).toBe(8);
    expect(line.countedStock).toBe(6);
    expect(line.absoluteDifference).toBe(-2);
    expect(line.percentDifference).toBe(25);
  });

  it('60. Komplette Lagerinventur über alle Artikel', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const items = await inventory.listItems();
    const stocktake = await inventory.createStocktake(
      admin.id,
      items.map((item, index) => ({ itemId: item.itemId, countedStock: index + 1 })),
    );
    expect(stocktake.items).toHaveLength(items.length);
    expect(stocktake.status).toBe('pending_approval');
  });

  it('63. Prozentrechnung ist exakt gerundet (Integer-Arithmetik, keine Float-Artefakte)', () => {
    expect(percentDifference(8, 6)).toBe(25);
    expect(percentDifference(7, 5)).toBe(28.6);
    expect(percentDifference(3, 4)).toBe(33.3);
    expect(percentDifference(3, 3)).toBe(0);
  });

  it('64. Systembestand 0 → „nicht berechenbar“ statt NaN/Infinity', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const kanister = (await inventory.listItems()).find(
      (item) => item.productSlug === 'mischkanister-6l',
    )!;
    await initializeItem(admin.id, kanister.itemId, 0);
    const stocktake = await inventory.createStocktake(admin.id, [
      { itemId: kanister.itemId, countedStock: 3 },
    ]);
    const line = stocktake.items[0]!;
    expect(line.percentDifference).toBeNull();
    expect(JSON.stringify(stocktake)).not.toContain('Infinity');
    expect(JSON.stringify(stocktake)).not.toContain('NaN');
    expect(percentDifference(0, 3)).toBeNull();
    expect(percentDifference(null, 3)).toBeNull();
  });
});

describe('65.–70. Freigabeworkflow', () => {
  it('65. Ist = System → Inventur direkt abgeschlossen, keine Korrekturbewegung', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const becher = (await inventory.listItems()).find((item) => item.productSlug === 'becher-25')!;
    await initializeItem(admin.id, becher.itemId, 8);
    const stocktake = await inventory.createStocktake(admin.id, [
      { itemId: becher.itemId, countedStock: 8 },
    ]);
    expect(stocktake.status).toBe('completed');
    const movements = await ctx.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.itemId, becher.itemId));
    // Nur die Initialisierungsbewegung – keine Korrektur.
    expect(movements).toHaveLength(1);
  });

  it('66./67./68./69./70. Differenz → Freigabe erforderlich; Korrektur vor Freigabe; genau EINE Bewegung', async () => {
    const { admin, cookie } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const sirup = (await inventory.listItems()).find(
      (item) => item.productSlug === 'sirup-waldmeister',
    )!;
    await initializeItem(admin.id, sirup.itemId, 10);
    const stocktake = await inventory.createStocktake(admin.id, [
      { itemId: sirup.itemId, countedStock: 7 },
    ]);
    expect(stocktake.status).toBe('pending_approval');
    // 67: Der Bestand ändert sich VOR der Freigabe nicht.
    expect((await inventory.itemById(sirup.itemId)).item.currentStock).toBe(10);

    // 68: Admin korrigiert den gezählten Wert vor der Freigabe (Route).
    const correct = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/inventory/stocktakes/${stocktake.id}/items/${sirup.itemId}`,
      headers: { cookie },
      payload: { countedStock: 6 },
    });
    expect(correct.statusCode).toBe(200);

    // 69/70: Freigabe → genau EINE inventory_adjustment-Bewegung, Bestand exakt.
    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/staff/inventory/stocktakes/${stocktake.id}/approve`,
      headers: { cookie },
    });
    expect(approve.statusCode).toBe(200);
    expect((await inventory.itemById(sirup.itemId)).item.currentStock).toBe(6);
    const adjustments = await ctx.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.itemId, sirup.itemId));
    const adjustment = adjustments.filter((movement) => movement.kind === 'inventory_adjustment');
    expect(adjustment).toHaveLength(1);
    expect(adjustment[0]!.quantityDelta).toBe(-4);
    expect(adjustment[0]!.resultingStock).toBe(6);
  });
});

describe('71.–73. Double-Submit, Races, Rechte', () => {
  it('71./72. Doppelte und parallele Freigabe erzeugen keine doppelte Korrektur', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const sirup = (await inventory.listItems()).find(
      (item) => item.productSlug === 'sirup-blaue-himbeere',
    )!;
    await initializeItem(admin.id, sirup.itemId, 10);
    const stocktake = await inventory.createStocktake(admin.id, [
      { itemId: sirup.itemId, countedStock: 4 },
    ]);

    const outcomes = await Promise.allSettled([
      inventory.approveStocktake(admin.id, stocktake.id),
      inventory.approveStocktake(admin.id, stocktake.id),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);

    // Nochmaliger (Doppel-)Klick nach Abschluss: sauberer Konflikt.
    await expect(inventory.approveStocktake(admin.id, stocktake.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    expect((await inventory.itemById(sirup.itemId)).item.currentStock).toBe(4);
    const adjustments = (
      await ctx.db
        .select()
        .from(inventoryMovements)
        .where(eq(inventoryMovements.itemId, sirup.itemId))
    ).filter((movement) => movement.kind === 'inventory_adjustment');
    expect(adjustments).toHaveLength(1);
  });

  it('73. Ohne inventory.approve_adjustment ist die Freigabe blockiert', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const sirup = (await inventory.listItems()).find(
      (item) => item.productSlug === 'sirup-wassermelone',
    )!;
    await initializeItem(admin.id, sirup.itemId, 10);
    const stocktake = await inventory.createStocktake(admin.id, [
      { itemId: sirup.itemId, countedStock: 2 },
    ]);
    const counter = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Zoe',
      lastName: 'Zaehlt',
      email: 'zoe.zaehlt@test.example',
      password: 'zoe-passwort-1234',
      permissionKeys: ['inventory.view', 'inventory.count'],
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/inventory/stocktakes/${stocktake.id}/approve`,
      headers: { cookie: counter.cookie },
    });
    expect(response.statusCode).toBe(403);
    expect((await inventory.itemById(sirup.itemId)).item.currentStock).toBe(10);
  });
});

describe('R7. Review-Fix: Freigabe-Semantik = Zähl-Differenz auf aktuellen Bestand', () => {
  it('R7. Ein Wareneingang ZWISCHEN Zählung und Freigabe geht nicht verloren', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const becher = (await inventory.listItems()).find((item) => item.productSlug === 'becher-25')!;
    await initializeItem(admin.id, becher.itemId, 10);
    // Zählung stellt 6 fest (Differenz −4 gegenüber System 10) …
    const stocktake = await inventory.createStocktake(admin.id, [
      { itemId: becher.itemId, countedStock: 6 },
    ]);
    expect(stocktake.status).toBe('pending_approval');
    // … dann kommt VOR der Freigabe ein Wareneingang von +5.
    await inventory.receive(admin.id, becher.itemId, 5);
    await inventory.approveStocktake(admin.id, stocktake.id);
    // Korrekt: 10 − 4 + 5 = 11 – der Eingang wird NICHT still ausgebucht.
    expect((await inventory.itemById(becher.itemId)).item.currentStock).toBe(11);
    const adjustments = await ctx.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.kind, 'inventory_adjustment'));
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]!.quantityDelta).toBe(-4);
    expect(adjustments[0]!.resultingStock).toBe(11);
  });
});
