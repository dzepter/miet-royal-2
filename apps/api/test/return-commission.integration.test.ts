/**
 * Phase-7-Pflichttests 35–50 (Order §71): Kommissionsrückgabe – nur die
 * UNGEÖFFNET zurückgegebene Menge wird erfasst, returned ≤ issued,
 * abrechenbar = ausgegeben − ungeöffnet zurück, eingefrorener Preis-Snapshot,
 * Becher-/Strohhalm-Kommission, inklusive Rückgabe ohne Gutschrift, Kanister
 * nicht rückgabefähig, genau eine return-Bewegung (Double-Submit, parallel),
 * kein Negativbestand, Bestand steigt.
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
import { productServiceFor, truncateCommerceTables } from './commerce-helpers.ts';
import { truncateSchedulingTables } from './scheduling-helpers.ts';
import { resetWarehouse } from './warehouse-helpers.ts';
import {
  handoverServicesFor,
  initializeAllInventory,
  pdfText,
  readyHandover,
  scheduledBooking,
  truncateHandoverTables,
} from './handover-helpers.ts';
import { readyReturn, startedReturn } from './return-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateHandoverTables(ctx.pool);
  await resetWarehouse(ctx.pool);
  await truncateSchedulingTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
});

async function adminSession() {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  const effective = await ctx.auth.effectivePermissions(admin.id);
  return { admin, cookie: session.cookie, effective };
}

/** 1×10 mit 1 L Gratis-Sirup (Kontingent) + 5 Flaschen extra (Kommission) + 2 Becher-/1 Strohhalm-Pack extra + 1 Kanister (Kauf). */
const SELECTIONS = [
  { slug: 'sirup-kirsche', role: 'free' as const, quantity: 1 },
  { slug: 'sirup-kirsche', role: 'extra' as const, quantity: 5 },
  { slug: 'becher-25', role: 'extra' as const, quantity: 2 },
  { slug: 'strohhalme-25', role: 'extra' as const, quantity: 1 },
  { slug: 'mischkanister-6l', role: 'extra' as const, quantity: 1 },
];

function commissionSyrup(detail: Awaited<ReturnType<typeof startedReturn>>['detail']) {
  return detail.items.find(
    (item) => item.kind === 'commission' && item.description.includes('Kirsche'),
  )!;
}

async function stockOf(slug: string) {
  const product = await productServiceFor(ctx).getProductBySlug(slug);
  const rows = await ctx.pool.query<{ current_stock: number | null }>(
    'SELECT current_stock FROM inventory_items WHERE product_id = $1',
    [product.id],
  );
  return rows.rows[0]!.current_stock;
}

describe('35.–45. Kommissionsmengen', () => {
  it('35./36. Ausgegebener Extra-Sirup ist rückgabefähig; nur die ungeöffnete Menge wird eingegeben', async () => {
    const { admin } = await adminSession();
    const { detail } = await startedReturn(ctx, admin.id, { selections: SELECTIONS, stock: 30 });
    const syrup = commissionSyrup(detail);
    expect(syrup.issuedQuantity).toBe(5);
    expect(syrup.returnedUnopenedQuantity).toBe(0);
    expect(syrup.unitPriceSnapshotCents).toBe(1200);
    expect(syrup.chargeableQuantity).toBe(5);
    // Kein Feld „verbrauchte Menge“ eingebbar – nur returnedUnopenedQuantity (Route-Schema).
    const columns = await ctx.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'return_inventory_items'`,
    );
    expect(columns.rows.map((row) => row.column_name)).toContain('returned_unopened_quantity');
    expect(columns.rows.some((row) => /consumed|verbraucht/i.test(row.column_name))).toBe(false);
  });

  it('37./38./39. returned ≤ issued wird serverseitig geprüft; Mehr wird abgelehnt; abrechenbar = ausgegeben − ungeöffnet zurück', async () => {
    const { admin, cookie } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id, {
      selections: SELECTIONS,
      stock: 30,
    });
    const syrup = commissionSyrup(detail);
    await expect(
      services.returns.setReturnedQuantity(admin.id, world.bookingId, syrup.id, 6),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      services.returns.setReturnedQuantity(admin.id, world.bookingId, syrup.id, -1),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      services.returns.setReturnedQuantity(admin.id, world.bookingId, syrup.id, 1.5),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const tooMany = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/returns/${world.bookingId}/items/${syrup.id}`,
      headers: { cookie },
      payload: { returnedUnopenedQuantity: 6 },
    });
    expect(tooMany.statusCode).toBe(400);
    await services.returns.setReturnedQuantity(admin.id, world.bookingId, syrup.id, 2);
    const view = await services.returns.detail(world.bookingId);
    const updated = commissionSyrup(view);
    expect(updated.returnedUnopenedQuantity).toBe(2);
    expect(updated.chargeableQuantity).toBe(3);
    expect(updated.chargeableAmountCents).toBe(3 * 1200);
  });

  it('40./41. Preis-Snapshot bleibt der Ausgabe-/Buchungspreis – ein neuer Produktpreis überschreibt ihn nicht', async () => {
    const { admin } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id, {
      selections: SELECTIONS,
      stock: 30,
    });
    const products = productServiceFor(ctx);
    const syrupProduct = await products.getProductBySlug('sirup-kirsche');
    await products.setCurrentPrice(admin.id, syrupProduct.id, 9900);
    expect(await products.effectivePriceCents(syrupProduct.id)).toBe(9900);
    const syrup = commissionSyrup(detail);
    await services.returns.setReturnedQuantity(admin.id, world.bookingId, syrup.id, 2);
    await readyReturn(ctx, admin.id, services, world.bookingId);
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    const frozen = commissionSyrup(finalized);
    expect(frozen.unitPriceSnapshotCents).toBe(1200);
    expect(frozen.chargeableQuantity).toBe(3);
    expect(frozen.chargeableAmountCents).toBe(3600);
    const row = await ctx.pool.query(
      'SELECT chargeable_quantity, chargeable_amount_cents, unit_price_snapshot_cents FROM return_inventory_items WHERE id = $1',
      [syrup.id],
    );
    expect(row.rows[0]).toEqual({
      chargeable_quantity: 3,
      chargeable_amount_cents: 3600,
      unit_price_snapshot_cents: 1200,
    });
  });

  it('42./43. Becher- und Strohhalm-Kommission werden korrekt berechnet (Packs, ganze Zahlen)', async () => {
    const { admin } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id, {
      selections: SELECTIONS,
      stock: 30,
    });
    const cups = detail.items.find(
      (i) => i.kind === 'commission' && i.description.includes('Becher'),
    )!;
    const straws = detail.items.find(
      (i) => i.kind === 'commission' && i.description.includes('Strohhalme'),
    )!;
    expect(cups.issuedQuantity).toBe(2);
    expect(cups.unitPriceSnapshotCents).toBe(250);
    expect(straws.issuedQuantity).toBe(1);
    expect(straws.unitPriceSnapshotCents).toBe(200);
    await services.returns.setReturnedQuantity(admin.id, world.bookingId, cups.id, 1);
    await services.returns.setReturnedQuantity(admin.id, world.bookingId, straws.id, 1);
    const view = await services.returns.detail(world.bookingId);
    const cupsNow = view.items.find((i) => i.id === cups.id)!;
    const strawsNow = view.items.find((i) => i.id === straws.id)!;
    expect(cupsNow.chargeableQuantity).toBe(1);
    expect(cupsNow.chargeableAmountCents).toBe(250);
    expect(strawsNow.chargeableQuantity).toBe(0);
    expect(strawsNow.chargeableAmountCents).toBe(0);
  });

  it('44. Inklusive Artikel: ungeöffnete Rückgabe erzeugt eine return-Bewegung, aber keine finanzielle Gutschrift', async () => {
    const { admin } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id, {
      selections: SELECTIONS,
      stock: 30,
    });
    const includedSyrup = detail.items.find(
      (i) => i.kind === 'included' && i.description.includes('Kirsche'),
    )!;
    expect(includedSyrup.issuedQuantity).toBe(1);
    expect(includedSyrup.unitPriceSnapshotCents).toBe(0);
    await services.returns.setReturnedQuantity(admin.id, world.bookingId, includedSyrup.id, 1);
    await readyReturn(ctx, admin.id, services, world.bookingId);
    const stockBefore = await stockOf('sirup-kirsche');
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    const frozen = finalized.items.find((i) => i.id === includedSyrup.id)!;
    expect(frozen.chargeableQuantity).toBe(0);
    expect(frozen.chargeableAmountCents).toBe(0);
    expect(finalized.summary.commissionChargeableCents).toBe(5 * 1200 + 2 * 250 + 1 * 200);
    expect(await stockOf('sirup-kirsche')).toBe((stockBefore ?? 0) + 1);
    const document = await services.documentService.byId(finalized.return.protocolDocumentId!);
    const text = pdfText(await services.documentService.bytesFor(document));
    expect(text).toContain('inklusive');
    expect(text).not.toContain('Gutschrift');
  });

  it('45. Kanister (Kaufartikel) wird nicht als Rückgabeartikel angeboten', async () => {
    const { admin } = await adminSession();
    const { detail } = await startedReturn(ctx, admin.id, { selections: SELECTIONS, stock: 30 });
    expect(detail.items.some((item) => item.description.includes('Kanister'))).toBe(false);
    expect(detail.items.some((item) => item.kind === 'purchase')).toBe(false);
    expect(detail.items.map((item) => item.kind).sort()).toEqual(
      ['commission', 'commission', 'commission', 'included', 'included', 'included'].sort(),
    );
  });
});

describe('46.–50. Lagerbewegungen der Rückgabe', () => {
  it('46./47. Genau eine return-Bewegung je Artikel; Double-Submit erzeugt keine doppelte Rückbuchung', async () => {
    const { admin } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id, {
      selections: SELECTIONS,
      stock: 30,
    });
    const syrup = commissionSyrup(detail);
    await services.returns.setReturnedQuantity(admin.id, world.bookingId, syrup.id, 2);
    await readyReturn(ctx, admin.id, services, world.bookingId);
    const before = await stockOf('sirup-kirsche');
    const first = await services.returns.finalize(admin.id, world.bookingId);
    const second = await services.returns.finalize(admin.id, world.bookingId);
    expect(second.return.finalizedAt).toBe(first.return.finalizedAt);
    const movements = await ctx.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.kind, 'return'));
    expect(movements).toHaveLength(1);
    expect(movements[0]!.quantityDelta).toBe(2);
    expect(await stockOf('sirup-kirsche')).toBe((before ?? 0) + 2);
    const docs = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM documents WHERE type = 'return_protocol'`,
    );
    expect(docs.rows[0].n).toBe(1);
  });

  it('48. Parallele Finalisierung über getrennte Instanzen erzeugt keine doppelte Rückbuchung', async () => {
    const { admin } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id, {
      selections: SELECTIONS,
      stock: 30,
    });
    const syrup = commissionSyrup(detail);
    await services.returns.setReturnedQuantity(admin.id, world.bookingId, syrup.id, 3);
    await readyReturn(ctx, admin.id, services, world.bookingId);
    const before = await stockOf('sirup-kirsche');
    const results = await Promise.allSettled([
      handoverServicesFor(ctx).returns.finalize(admin.id, world.bookingId),
      handoverServicesFor(ctx).returns.finalize(admin.id, world.bookingId),
      handoverServicesFor(ctx).returns.finalize(admin.id, world.bookingId),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const movements = await ctx.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.kind, 'return'));
    expect(movements).toHaveLength(1);
    expect(await stockOf('sirup-kirsche')).toBe((before ?? 0) + 3);
    const packets = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM delivery_packets WHERE kind = 'return_completed'`,
    );
    expect(packets.rows[0].n).toBe(1);
  });

  it('49./50. Rückgabe senkt den Bestand nie unter 0 und erhöht ihn exakt um die ungeöffnete Menge – auch bei nie erfasstem Bestand', async () => {
    const { admin } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id, {
      selections: SELECTIONS,
      stock: 30,
    });
    const syrup = commissionSyrup(detail);
    const cups = detail.items.find(
      (i) => i.kind === 'commission' && i.description.includes('Becher'),
    )!;
    await services.returns.setReturnedQuantity(admin.id, world.bookingId, syrup.id, 5);
    await services.returns.setReturnedQuantity(admin.id, world.bookingId, cups.id, 2);
    await readyReturn(ctx, admin.id, services, world.bookingId);
    const syrupBefore = await stockOf('sirup-kirsche');
    const cupsBefore = await stockOf('becher-25');
    await services.returns.finalize(admin.id, world.bookingId);
    expect(await stockOf('sirup-kirsche')).toBe((syrupBefore ?? 0) + 5);
    expect(await stockOf('becher-25')).toBe((cupsBefore ?? 0) + 2);
    const negative = await ctx.pool.query(
      'SELECT count(*)::int AS n FROM inventory_items WHERE current_stock < 0',
    );
    expect(negative.rows[0].n).toBe(0);
    const ledger = await ctx.pool.query<{ resulting_stock: number; quantity_delta: number }>(
      `SELECT resulting_stock, quantity_delta FROM inventory_movements WHERE kind = 'return' ORDER BY created_at`,
    );
    expect(ledger.rows.every((row) => row.quantity_delta > 0 && row.resulting_stock >= 0)).toBe(
      true,
    );
  });
});

describe('Review-Härtung (Order §22): Kommissionsartikel ohne Lagerartikel', () => {
  it('R3. Ein Kommissionsartikel ohne hinterlegten Lagerartikel behält seine Fakten (ausgegeben/ungeöffnet/abrechenbar, Preis-Snapshot, PDF) – nur die Ledger-Bewegung entfällt', async () => {
    const { admin } = await adminSession();
    const products = productServiceFor(ctx);
    // Neuer Verbrauchsartikel NACH der Lager-Grundausstattung: kein inventory_items-Datensatz.
    const created = await products.createProduct(
      admin.id,
      {
        slug: 'sirup-holunder',
        name: 'Sirup Holunder',
        category: 'syrup',
        saleUnit: 'Flasche',
        defaultBillingMode: 'commission',
      },
      1_250,
    );
    await initializeAllInventory(ctx, admin.id, 20);
    const world = await scheduledBooking(ctx, admin.id, { machineQuantity: 1 });
    await readyHandover(ctx, admin.id, world.bookingId, ['MR-10-01-01']);
    const services = handoverServicesFor(ctx);
    await services.handover.addAddition(admin.id, world.bookingId, created.id, 3);
    await services.handover.finalize(admin.id, world.bookingId);
    const movementsBefore = await ctx.db.select().from(inventoryMovements);

    await services.returns.start(admin.id, world.bookingId);
    const detail = await services.returns.detail(world.bookingId);
    // Phase-6-Regel: 1 L Gratis-Sirup je Behälter wird inklusive gebucht, der Rest Kommission.
    const holunderItems = detail.items.filter((item) => item.description.includes('Holunder'));
    expect(
      holunderItems
        .map((item) => [item.kind, item.issuedQuantity, item.inventoryItemId] as const)
        .sort((a, b) => a[0].localeCompare(b[0])),
    ).toEqual([
      ['commission', 2, null],
      ['included', 1, null],
    ]);
    const holunder = holunderItems.find((item) => item.kind === 'commission')!;
    expect(holunder).toMatchObject({
      returnedUnopenedQuantity: 0,
      unitPriceSnapshotCents: 1_250,
      chargeableQuantity: 2,
      chargeableAmountCents: 2_500,
    });
    await services.returns.setReturnedQuantity(admin.id, world.bookingId, holunder.id, 1);
    await readyReturn(ctx, admin.id, services, world.bookingId);
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    const frozen = finalized.items.find((item) => item.id === holunder.id)!;
    expect(frozen).toMatchObject({
      returnedUnopenedQuantity: 1,
      chargeableQuantity: 1,
      chargeableAmountCents: 1_250,
    });
    // Keine Ledger-Bewegung für den Artikel ohne Lagerartikel – andere Artikel unverändert.
    const movementsAfter = await ctx.db.select().from(inventoryMovements);
    const newReturnMovements = movementsAfter.filter(
      (m) => m.kind === 'return' && !movementsBefore.some((b) => b.id === m.id),
    );
    expect(newReturnMovements).toEqual([]);
    const document = await services.documentService.byId(finalized.return.protocolDocumentId!);
    const text = pdfText(await services.documentService.bytesFor(document));
    expect(text).toContain('Sirup Holunder');
    expect(text).toContain('ausgegeben 2');
    expect(text).toContain('ungeöffnet zurück 1');
    expect(text).toContain('verbraucht/abrechenbar 1');
  });
});
