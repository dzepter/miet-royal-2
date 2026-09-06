/**
 * Phase-6-Pflichttests 31–46 (Order §62): inklusive/Kommissions-/Kaufartikel,
 * Kanisterlimit, tatsächliche Mengen, issue-Bewegungen (Double-Submit,
 * parallele Finalisierung), unzureichender Bestand, Zusatzpositionen mit
 * eigenem Preis-Snapshot, unveränderter Buchungs-Snapshot.
 */
import { bookingAdditions, bookings, inventoryMovements } from '@mietroyal/database';
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
  readyHandover,
  scheduledBooking,
  truncateHandoverTables,
} from './handover-helpers.ts';

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
  return { admin, cookie: session.cookie };
}

const FULL_SELECTIONS = [
  { slug: 'sirup-kirsche', role: 'free' as const, quantity: 2 },
  { slug: 'sirup-kirsche', role: 'extra' as const, quantity: 3 },
  { slug: 'becher-25', role: 'extra' as const, quantity: 2 },
  { slug: 'strohhalme-25', role: 'extra' as const, quantity: 1 },
  { slug: 'mischkanister-6l', role: 'extra' as const, quantity: 2 },
];

async function itemsFor(bookingId: string) {
  const { handover } = handoverServicesFor(ctx);
  return (await handover.detail(bookingId)).deliveryNote.items;
}

describe('31.–37. Artikelarten aus der Buchung', () => {
  it('31. Inklusive Sirup: 1 L je Behälter (2×10 → 2 L) als inklusive Position', async () => {
    const { admin } = await adminSession();
    const world = await scheduledBooking(ctx, admin.id, {
      machineSlug: 'slush-2x10',
      selections: FULL_SELECTIONS,
    });
    const items = await itemsFor(world.bookingId);
    const included = items.find(
      (item) => item.kind === 'included' && item.description.includes('Kirsche'),
    );
    expect(included?.plannedQuantity).toBe(2);
    expect(included?.unitPriceCents).toBe(0);
  });

  it('32./33. Becher und Strohhalme sind genau EINMAL je Vorgang inklusive – auch bei zwei Maschinen', async () => {
    const { admin } = await adminSession();
    const world = await scheduledBooking(ctx, admin.id, { machineQuantity: 2 });
    const items = await itemsFor(world.bookingId);
    const cups = items.filter(
      (item) => item.kind === 'included' && item.description.includes('Becher'),
    );
    const straws = items.filter(
      (item) => item.kind === 'included' && item.description.includes('Strohhalme'),
    );
    expect(cups).toHaveLength(1);
    expect(cups[0]!.plannedQuantity).toBe(1);
    expect(straws).toHaveLength(1);
    expect(straws[0]!.plannedQuantity).toBe(1);
  });

  it('34./35./36./37. Zusätzlicher Sirup/Becher/Strohhalme sind Kommission, der Kanister Kaufartikel', async () => {
    const { admin } = await adminSession();
    const world = await scheduledBooking(ctx, admin.id, {
      machineSlug: 'slush-2x10',
      selections: FULL_SELECTIONS,
    });
    const items = await itemsFor(world.bookingId);
    const extraSyrup = items.find(
      (item) => item.kind === 'commission' && item.description.includes('Kirsche'),
    );
    const extraCups = items.find(
      (item) => item.kind === 'commission' && item.description.includes('Becher'),
    );
    const extraStraws = items.find(
      (item) => item.kind === 'commission' && item.description.includes('Strohhalme'),
    );
    const canister = items.find((item) => item.kind === 'purchase');
    expect(extraSyrup?.plannedQuantity).toBe(3);
    expect(extraSyrup?.unitPriceCents).toBe(1200);
    expect(extraCups?.plannedQuantity).toBe(2);
    expect(extraCups?.unitPriceCents).toBe(250);
    expect(extraStraws?.unitPriceCents).toBe(200);
    expect(canister?.plannedQuantity).toBe(2);
    expect(canister?.billingMode).toBe('fixed');
    expect(canister?.unitPriceCents).toBe(500);
  });
});

describe('38.–39. Kanisterlimit und tatsächliche Mengen', () => {
  it('38. Das Kanisterlimit (2 je Behälter) gilt serverseitig für Mengen und Zusatzpositionen', async () => {
    const { admin, cookie } = await adminSession();
    const { handover } = handoverServicesFor(ctx);
    const products = productServiceFor(ctx);
    const world = await scheduledBooking(ctx, admin.id, {
      machineSlug: 'slush-1x10',
      selections: [{ slug: 'mischkanister-6l', role: 'extra', quantity: 1 }],
    });
    const items = await itemsFor(world.bookingId);
    const canister = items.find((item) => item.kind === 'purchase')!;
    const tooMany = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/handover/${world.bookingId}/items/${canister.id}`,
      headers: { cookie },
      payload: { actualQuantity: 3 },
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error.message).toContain('Maximal 2');
    const okay = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/handover/${world.bookingId}/items/${canister.id}`,
      headers: { cookie },
      payload: { actualQuantity: 2 },
    });
    expect(okay.statusCode).toBe(200);
    const product = await products.getProductBySlug('mischkanister-6l');
    await expect(
      handover.addAddition(admin.id, world.bookingId, product.id, 1),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('39. Die tatsächliche Ausgabemenge wird getrennt vom Soll gespeichert', async () => {
    const { admin } = await adminSession();
    const { handover } = handoverServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id);
    const straws = (await itemsFor(world.bookingId)).find((item) =>
      item.description.includes('Strohhalme'),
    )!;
    await handover.updateItemQuantity(world.bookingId, straws.id, 0);
    const after = (await itemsFor(world.bookingId)).find((item) => item.id === straws.id)!;
    expect(after.plannedQuantity).toBe(1);
    expect(after.actualQuantity).toBe(0);
  });
});

describe('40.–44. Lagerbewegungen bei der Ausgabe', () => {
  it('40./41. Die Finalisierung erzeugt je Artikel EINE issue-Bewegung – ein Double-Submit keine zweite', async () => {
    const { admin } = await adminSession();
    const { handover, inventory } = handoverServicesFor(ctx);
    await initializeAllInventory(ctx, admin.id, 20);
    const world = await scheduledBooking(ctx, admin.id, {
      machineSlug: 'slush-2x10',
      selections: FULL_SELECTIONS,
    });
    await readyHandover(ctx, admin.id, world.bookingId, ['MR-10-02-01']);
    await handover.finalize(admin.id, world.bookingId);
    await handover.finalize(admin.id, world.bookingId); // Double-Submit
    const movements = await ctx.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.kind, 'issue'));
    // Kirsche (2 inkl. + 3 extra = 5), Becher (1 + 2 = 3), Strohhalme (1 + 1 = 2), Kanister 2.
    expect(movements).toHaveLength(4);
    const byItem = new Map(movements.map((row) => [row.itemId, row.quantityDelta]));
    const items = await inventory.listItems();
    const idOf = (slug: string) => items.find((item) => item.productSlug === slug)!.itemId;
    expect(byItem.get(idOf('sirup-kirsche'))).toBe(-5);
    expect(byItem.get(idOf('becher-25'))).toBe(-3);
    expect(byItem.get(idOf('strohhalme-25'))).toBe(-2);
    expect(byItem.get(idOf('mischkanister-6l'))).toBe(-2);
    expect((await inventory.itemById(idOf('sirup-kirsche'))).item.currentStock).toBe(15);
  });

  it('42. Parallele Finalisierungen erzeugen keine doppelten Bewegungen oder Dokumente', async () => {
    const { admin } = await adminSession();
    await initializeAllInventory(ctx, admin.id, 20);
    const world = await scheduledBooking(ctx, admin.id);
    await readyHandover(ctx, admin.id, world.bookingId, ['MR-10-01-01']);
    // Drei GETRENNTE Service-Instanzen (wie mehrere API-Prozesse): die
    // prozessinterne Mutex greift nicht, es zählen Advisory-/Zeilensperren.
    const results = await Promise.allSettled([
      handoverServicesFor(ctx).handover.finalize(admin.id, world.bookingId),
      handoverServicesFor(ctx).handover.finalize(admin.id, world.bookingId),
      handoverServicesFor(ctx).handover.finalize(admin.id, world.bookingId),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const finalizedAts = new Set(
      results.map((r) => (r.status === 'fulfilled' ? r.value.handover.finalizedAt : null)),
    );
    expect(finalizedAts.size).toBe(1);
    const movements = await ctx.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.kind, 'issue'));
    expect(movements).toHaveLength(2); // Becher + Strohhalme inklusive
    const docs = await ctx.pool.query(
      `SELECT type FROM documents WHERE booking_id = $1 ORDER BY type`,
      [world.bookingId],
    );
    expect(docs.rows.map((row) => row.type)).toEqual(['delivery_note', 'handover_protocol']);
    const packets = await ctx.pool.query(`SELECT count(*)::int AS n FROM delivery_packets`);
    expect(packets.rows[0].n).toBe(1);
  });

  it('43./44. Unzureichender Systembestand blockiert verständlich – kein Negativbestand, Buchung bleibt', async () => {
    const { admin, cookie } = await adminSession();
    const { handover, inventory } = handoverServicesFor(ctx);
    await initializeAllInventory(ctx, admin.id, 0);
    const world = await scheduledBooking(ctx, admin.id);
    await readyHandover(ctx, admin.id, world.bookingId, ['MR-10-01-01']);
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/handover/${world.bookingId}/finalize`,
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain('Lagerbestand prüfen');
    const items = await inventory.listItems();
    expect(items.every((item) => (item.currentStock ?? 0) >= 0)).toBe(true);
    const detail = await handover.detail(world.bookingId);
    expect(detail.handover.status).toBe('draft');
    expect(detail.booking.processStatus).toBe('open');
    expect(detail.blockers.join(' ')).toContain('Lagerbestand prüfen');
    // Handlungsoption: Wareneingang → danach Abschluss möglich.
    const cups = items.find((item) => item.productSlug === 'becher-25')!;
    const straws = items.find((item) => item.productSlug === 'strohhalme-25')!;
    await inventory.receive(admin.id, cups.itemId, 5);
    await inventory.receive(admin.id, straws.itemId, 5);
    const finalized = await handover.finalize(admin.id, world.bookingId);
    expect(finalized.handover.status).toBe('finalized');
  });
});

describe('45.–46. Zusatzpositionen und Snapshot', () => {
  it('45./46. Eine Zusatzposition speichert ihren eigenen Preis-Snapshot; der Buchungs-Snapshot bleibt unverändert', async () => {
    const { admin } = await adminSession();
    const { handover } = handoverServicesFor(ctx);
    const products = productServiceFor(ctx);
    // Gratis-Kontingent (1 L) bereits gebucht → jeder weitere Sirup ist Kommission.
    const world = await scheduledBooking(ctx, admin.id, {
      selections: [{ slug: 'sirup-kirsche', role: 'free', quantity: 1 }],
    });
    const before = (
      await ctx.db.select().from(bookings).where(eq(bookings.id, world.bookingId))
    )[0]!;
    const syrup = await products.getProductBySlug('sirup-waldmeister');
    const { additionId } = await handover.addAddition(admin.id, world.bookingId, syrup.id, 2);
    const addition = (
      await ctx.db.select().from(bookingAdditions).where(eq(bookingAdditions.id, additionId))
    )[0]!;
    expect(addition.unitPriceCents).toBe(1200);
    expect(addition.billingMode).toBe('commission');
    expect(addition.createdBy).toBe(admin.id);
    const items = await itemsFor(world.bookingId);
    expect(
      items.some((item) => item.fromAddition && item.description.includes('Waldmeister')),
    ).toBe(true);
    // Mengen ändern + Zusatzposition → Snapshot byte-identisch.
    const straws = items.find((item) => item.description.includes('Strohhalme'))!;
    await handover.updateItemQuantity(world.bookingId, straws.id, 0);
    const after = (
      await ctx.db.select().from(bookings).where(eq(bookings.id, world.bookingId))
    )[0]!;
    expect(JSON.stringify(after.itemsSnapshot)).toBe(JSON.stringify(before.itemsSnapshot));
    expect(JSON.stringify(after.totalsSnapshot)).toBe(JSON.stringify(before.totalsSnapshot));
  });
});

describe('R10. Inklusive-Kontingent serverseitig', () => {
  it('R10. Inklusive Mengen sind auf das gebuchte Kontingent begrenzt; nicht genutztes Gratis-Sirup-Kontingent wird bei Zusatzpositionen inklusive', async () => {
    const { admin } = await adminSession();
    const { handover } = handoverServicesFor(ctx);
    // 1×10 L ohne Gratis-Sirup-Auswahl: Kontingent 1 L bleibt offen.
    const world = await scheduledBooking(ctx, admin.id);
    await handover.ensureForBooking(world.bookingId, admin.id);
    const items = await itemsFor(world.bookingId);
    const cups = items.find(
      (item) => item.kind === 'included' && item.description.includes('Becher'),
    )!;
    await expect(
      handover.updateItemQuantity(world.bookingId, cups.id, cups.plannedQuantity + 1),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await handover.updateItemQuantity(world.bookingId, cups.id, 0); // weniger ist erlaubt
    const syrup = await productServiceFor(ctx).getProductBySlug('sirup-kirsche');
    await handover.addAddition(admin.id, world.bookingId, syrup.id, 2);
    const after = await itemsFor(world.bookingId);
    const freeLine = after.find(
      (item) => item.kind === 'included' && item.description.includes('Kirsche'),
    );
    const paidLine = after.find(
      (item) => item.kind === 'commission' && item.description.includes('Kirsche'),
    );
    expect(freeLine?.actualQuantity).toBe(1);
    expect(freeLine?.unitPriceCents).toBe(0);
    expect(paidLine?.actualQuantity).toBe(1);
    expect(paidLine?.unitPriceCents).toBe(1200);
    // Kontingent ausgeschöpft: weiterer Sirup ist reine Kommission.
    await handover.addAddition(admin.id, world.bookingId, syrup.id, 1);
    const later = await itemsFor(world.bookingId);
    expect(
      later.filter((item) => item.kind === 'included' && item.description.includes('Kirsche')),
    ).toHaveLength(1);
    expect(
      later
        .filter((item) => item.kind === 'commission' && item.description.includes('Kirsche'))
        .reduce((sum, item) => sum + item.actualQuantity, 0),
    ).toBe(2);
  });
});
