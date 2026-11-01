import {
  getPickupExactAddress,
  PICKUP_EXACT_ADDRESS_KEY,
  setStringSetting,
} from '../../../crm/settings-service.ts';
import type { DemoScenario } from '../context.ts';
import {
  DEMO_DEPOT_ADDRESS,
  DEMO_INCOMING,
  DEMO_INITIAL_STOCK,
  DEMO_LOW_STOCK,
  DEMO_MIN_STOCK,
  DEMO_SEED_KEYS,
  DEMO_TERMS_CONTENT,
  DEMO_TERMS_LABEL,
} from '../data.ts';

/**
 * Voraussetzungen der Fachabläufe (Konfiguration bleibt beim Reset erhalten,
 * daher nur „sicherstellen“, nie überschreiben):
 * - exakte Abholadresse (Depot für Routing, Pflicht für die AB-Freigabe bei
 *   Selbstabholung) – synthetisch und als solche markiert;
 * - eine Mietbedingungen-Version (Pflicht für den Angebotsversand); fehlt
 *   jede Version, entsteht ein klar als TEST markierter Platzhalter – nie ein
 *   erfundener Rechtstext (Regelbuch §5, Lücke „Mietbedingungen in Demo“).
 */
export const foundationScenario: DemoScenario = {
  name: 'foundation',
  async run(ctx) {
    if ((await getPickupExactAddress(ctx.db)) === null) {
      await setStringSetting(ctx.db, ctx.actorId, PICKUP_EXACT_ADDRESS_KEY, DEMO_DEPOT_ADDRESS);
    }
    const versions = await ctx.services.terms.list();
    if (versions.length === 0) {
      await ctx.services.terms.create({
        label: DEMO_TERMS_LABEL,
        content: DEMO_TERMS_CONTENT,
        isTest: true,
      });
    }
  },
};

/**
 * Bestand/Lagerbewegungen (Order §10): Erstinventur mit Adminfreigabe
 * (Bewegung „initial“), Wareneingang („incoming“), Mindestbestände – einer
 * davon bewusst ÜBER dem Bestand (Warnung „Mindestbestand unterschritten“).
 * Ausgaben/Rückläufer entstehen später über Übergabe und Rückgabe.
 */
export const inventoryScenario: DemoScenario = {
  name: 'inventory',
  async run(ctx) {
    const { inventory } = ctx.services;
    const items = (await inventory.listItems()).filter((item) => item.productActive);
    const stocktake = await inventory.createStocktake(
      ctx.actorId,
      items.map((item) => ({
        itemId: item.itemId,
        countedStock: DEMO_INITIAL_STOCK[item.productSlug] ?? 12,
      })),
    );
    if (stocktake.status === 'pending_approval') {
      await inventory.approveStocktake(ctx.actorId, stocktake.id);
    }
    await ctx.register(
      DEMO_SEED_KEYS.inventoryStocktakeInitial,
      'inventory_stocktake',
      stocktake.id,
    );

    const incoming = items.find((item) => item.productSlug === DEMO_INCOMING.slug);
    if (incoming === undefined) throw new Error('Demo-Seed: Lagerartikel für Wareneingang fehlt');
    const movement = await inventory.receive(ctx.actorId, incoming.itemId, DEMO_INCOMING.quantity);
    await ctx.register(DEMO_SEED_KEYS.inventoryMovementIncoming, 'inventory_movement', movement.id);

    for (const item of items) {
      const minStock = DEMO_MIN_STOCK[item.productSlug];
      if (minStock !== undefined) await inventory.setMinStock(item.itemId, minStock);
    }
    const low = items.find((item) => item.productSlug === DEMO_LOW_STOCK.slug);
    if (low === undefined) throw new Error('Demo-Seed: Lagerartikel für Mindestbestand fehlt');
    await inventory.setMinStock(low.itemId, DEMO_LOW_STOCK.minStock);
    await ctx.register(DEMO_SEED_KEYS.inventoryItemLowStock, 'inventory_item', low.itemId);
  },
};
