/**
 * Phase-5-Finalisierung (Order A, Pflichttests 1–8; identisch mit den
 * Phase-6-Regressionstests 84–87): Für denselben Lagerartikel existiert zu
 * einem Zeitpunkt höchstens EINE offene (pending) Inventurzählung – auch
 * zwischen Einzelartikel- und Komplettinventur, race-sicher und ohne
 * Deadlocks; Wareneingänge zwischen Zählung und Freigabe bleiben erhalten.
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
import { truncateCrmTables } from './crm-helpers.ts';
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

async function itemBySlug(slug: string) {
  const inventory = inventoryServiceFor(ctx);
  return (await inventory.listItems()).find((item) => item.productSlug === slug)!;
}

async function initializeItem(adminId: string, itemId: string, stock: number) {
  const inventory = inventoryServiceFor(ctx);
  const stocktake = await inventory.createStocktake(adminId, [{ itemId, countedStock: stock }]);
  await inventory.approveStocktake(adminId, stocktake.id);
}

describe('A1–A8 / 84–87. Höchstens EINE offene Inventur je Artikel', () => {
  it('A1/84. Offene Einzelinventur blockiert eine zweite offene Einzelinventur desselben Artikels', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const becher = await itemBySlug('becher-25');
    await initializeItem(admin.id, becher.itemId, 10);
    const first = await inventory.createStocktake(admin.id, [
      { itemId: becher.itemId, countedStock: 8 },
    ]);
    expect(first.status).toBe('pending_approval');
    await expect(
      inventory.createStocktake(admin.id, [{ itemId: becher.itemId, countedStock: 7 }]),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // Beispiel aus der Order: A freigeben → 8; B existiert nicht → nie 5.
    await inventory.approveStocktake(admin.id, first.id);
    expect((await inventory.itemById(becher.itemId)).item.currentStock).toBe(8);
  });

  it('A2/85. Offene Komplettinventur blockiert eine parallele Einzelinventur eines enthaltenen Artikels', async () => {
    const { admin, cookie } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const items = await inventory.listItems();
    const complete = await inventory.createStocktake(
      admin.id,
      items.map((item) => ({ itemId: item.itemId, countedStock: 3 })),
    );
    expect(complete.status).toBe('pending_approval');
    const sirup = items.find((item) => item.productSlug === 'sirup-kirsche')!;
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/staff/inventory/stocktakes',
      headers: { cookie },
      payload: { entries: [{ itemId: sirup.itemId, countedStock: 2 }] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain('ausstehender Freigabe');
    expect(response.json().error.message).toContain(sirup.productName);
  });

  it('A3/85. Offene Einzelinventur blockiert eine Komplettinventur, die denselben Artikel enthielte', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const items = await inventory.listItems();
    const straws = items.find((item) => item.productSlug === 'strohhalme-25')!;
    await inventory.createStocktake(admin.id, [{ itemId: straws.itemId, countedStock: 4 }]);
    await expect(
      inventory.createStocktake(
        admin.id,
        items.map((item) => ({ itemId: item.itemId, countedStock: 1 })),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // Nur die eine offene Zählung existiert – nichts halb angelegt.
    const open = await inventory.listStocktakes();
    expect(open.filter((row) => row.status === 'pending_approval')).toHaveLength(1);
  });

  it('A4/86. Zwei parallele Create-Versuche desselben Artikels → genau einer gewinnt', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const cups = await itemBySlug('becher-25');
    await initializeItem(admin.id, cups.itemId, 10);
    const results = await Promise.allSettled([
      inventory.createStocktake(admin.id, [{ itemId: cups.itemId, countedStock: 8 }]),
      inventory.createStocktake(admin.id, [{ itemId: cups.itemId, countedStock: 7 }]),
      inventory.createStocktake(admin.id, [{ itemId: cups.itemId, countedStock: 6 }]),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const result of rejected) {
      expect((result as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });
    }
    const pending = (await inventory.listStocktakes()).filter(
      (row) => row.status === 'pending_approval',
    );
    expect(pending).toHaveLength(1);
  });

  it('A5. Unterschiedliche Artikel können parallel gezählt werden', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const items = await inventory.listItems();
    const results = await Promise.all(
      items.map((item, index) =>
        inventory.createStocktake(admin.id, [{ itemId: item.itemId, countedStock: index + 1 }]),
      ),
    );
    expect(results).toHaveLength(items.length);
    expect(results.every((row) => row.status === 'pending_approval')).toBe(true);
    // Komplettinventur mit Artikeln in anderer Reihenfolge plus parallele
    // Einzelinventuren erzeugen keinen Deadlock (deterministische Lock-Reihenfolge).
    for (const row of results) await inventory.approveStocktake(admin.id, row.id);
    const reversed = [...items].reverse();
    const mixed = await Promise.allSettled([
      inventory.createStocktake(
        admin.id,
        reversed.map((item) => ({ itemId: item.itemId, countedStock: 2 })),
      ),
      inventory.createStocktake(
        admin.id,
        items.map((item) => ({ itemId: item.itemId, countedStock: 2 })),
      ),
    ]);
    expect(mixed.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(mixed.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('A6. Abgeschlossene/freigegebene Inventuren blockieren keine neue Inventur', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const cups = await itemBySlug('becher-25');
    await initializeItem(admin.id, cups.itemId, 10);
    // Ohne Differenz: sofort completed – blockiert nicht.
    const same = await inventory.createStocktake(admin.id, [
      { itemId: cups.itemId, countedStock: 10 },
    ]);
    expect(same.status).toBe('completed');
    const pending = await inventory.createStocktake(admin.id, [
      { itemId: cups.itemId, countedStock: 9 },
    ]);
    expect(pending.status).toBe('pending_approval');
    await inventory.approveStocktake(admin.id, pending.id);
    // Nach der Freigabe ist der Artikel wieder zählbar.
    const next = await inventory.createStocktake(admin.id, [
      { itemId: cups.itemId, countedStock: 5 },
    ]);
    expect(next.status).toBe('pending_approval');
  });

  it('A7/87. Wareneingang zwischen Zählung und Freigabe bleibt erhalten', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const cups = await itemBySlug('becher-25');
    await initializeItem(admin.id, cups.itemId, 10);
    const stocktake = await inventory.createStocktake(admin.id, [
      { itemId: cups.itemId, countedStock: 6 },
    ]);
    await inventory.receive(admin.id, cups.itemId, 5);
    await inventory.approveStocktake(admin.id, stocktake.id);
    expect((await inventory.itemById(cups.itemId)).item.currentStock).toBe(11);
    const adjustments = await ctx.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.kind, 'inventory_adjustment'));
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]!.quantityDelta).toBe(-4);
  });

  it('A8. Datenbank-Backstop: der partielle Unique-Index verhindert eine zweite offene Zeile je Artikel', async () => {
    const { admin } = await adminSession();
    const inventory = inventoryServiceFor(ctx);
    const cups = await itemBySlug('becher-25');
    const stocktake = await inventory.createStocktake(admin.id, [
      { itemId: cups.itemId, countedStock: 4 },
    ]);
    // Direkter Versuch, eine zweite offene Zeile für denselben Artikel zu
    // schreiben, scheitert bereits an der Datenbank.
    await expect(
      ctx.pool.query(
        `INSERT INTO inventory_stocktake_items (stocktake_id, item_id, counted_stock, open_item_id)
         VALUES ($1, $2, 1, $2)`,
        [stocktake.id, cups.itemId],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });
});
