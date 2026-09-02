import {
  inventoryItems,
  inventoryMovements,
  inventoryStocktakeItems,
  inventoryStocktakes,
  products,
  staffUsers,
  type Database,
  type InventoryItem,
  type InventoryMovement,
  type InventoryStocktake,
  type DatabaseExecutor,
  type Product,
} from '@mietroyal/database';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';

/**
 * EIN zentraler, autoritativer InventoryService (Phase-5-Order §41): ALLE
 * Bestandsänderungen laufen über dieses Ledger – keine Bestandsarithmetik
 * in React, keine direkten current_stock-Mutationen. Jede echte Änderung
 * resultiert nachvollziehbar aus genau einer Bewegung (Order §32).
 *
 * Bestände sind GANZE Lagereinheiten (Integer, Order §26); current_stock
 * NULL bedeutet "Noch nicht initial erfasst" (Order §27) – erst die erste
 * FREIGEGEBENE Erfassung initialisiert den Artikel (Order §36).
 */

export interface InventoryItemView {
  itemId: string;
  productId: string;
  productSlug: string;
  productName: string;
  saleUnit: string;
  productActive: boolean;
  /** NULL = Noch nicht initial erfasst. */
  currentStock: number | null;
  /** NULL = Mindestbestand nicht festgelegt. */
  minStock: number | null;
  /** Warnung NUR bei initialisiertem Bestand + gesetztem Mindestbestand. */
  lowStock: boolean;
}

export interface StocktakeItemView {
  itemId: string;
  productName: string;
  saleUnit: string;
  systemStock: number | null;
  countedStock: number;
  absoluteDifference: number | null;
  /** Prozent mit 1 Nachkommastelle; NULL = nicht berechenbar (System 0/unbekannt). */
  percentDifference: number | null;
}

export interface StocktakeView {
  id: string;
  status: InventoryStocktake['status'];
  createdAt: string;
  createdByName: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  items: StocktakeItemView[];
}

/**
 * Prozentuale Abweichung (Order §37) in Integer-Arithmetik (eine
 * Nachkommastelle) – kein Float-Drift, kein NaN/Infinity: bei System 0
 * oder unbekannt ist das Ergebnis NULL ("nicht berechenbar").
 */
export function percentDifference(systemStock: number | null, counted: number): number | null {
  if (systemStock === null || systemStock === 0) return null;
  return Math.round((Math.abs(counted - systemStock) * 1000) / systemStock) / 10;
}

export class InventoryService {
  constructor(private readonly db: Database) {}

  // ── Lesen ───────────────────────────────────────────────────────────────

  async listItems(): Promise<InventoryItemView[]> {
    const rows = await this.db
      .select({ item: inventoryItems, product: products })
      .from(inventoryItems)
      .innerJoin(products, eq(products.id, inventoryItems.productId))
      .orderBy(asc(products.sortOrder), asc(products.name));
    return rows.map(({ item, product }) => ({
      itemId: item.id,
      productId: product.id,
      productSlug: product.slug,
      productName: product.name,
      saleUnit: product.saleUnit,
      productActive: product.active,
      currentStock: item.currentStock,
      minStock: item.minStock,
      lowStock:
        item.currentStock !== null && item.minStock !== null && item.currentStock < item.minStock,
    }));
  }

  async itemById(itemId: string): Promise<{ item: InventoryItem; product: Product }> {
    const rows = await this.db
      .select({ item: inventoryItems, product: products })
      .from(inventoryItems)
      .innerJoin(products, eq(products.id, inventoryItems.productId))
      .where(eq(inventoryItems.id, itemId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Lagerartikel nicht gefunden.');
    return row;
  }

  /** Artikel mit aktiver Unterbestandswarnung (Order §§28/29). */
  async lowStockItems(): Promise<InventoryItemView[]> {
    return (await this.listItems()).filter((item) => item.lowStock);
  }

  // ── Ledger-Kern ─────────────────────────────────────────────────────────

  /**
   * Einzige Stelle, die current_stock verändert: Artikelzeile sperren,
   * Bewegung schreiben, Bestand fortschreiben – transaktional und damit
   * race-sicher (zwei parallele Wareneingänge addieren BEIDE, Order §42).
   */
  private async applyMovement(
    tx: DatabaseExecutor,
    input: {
      itemId: string;
      kind: InventoryMovement['kind'];
      quantityDelta: number;
      resultingStockOverride?: number;
      stocktakeId?: string | null;
      actorId: string | null;
      allowUninitialized?: boolean;
    },
  ): Promise<InventoryMovement> {
    const lockedRows = await tx
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.id, input.itemId))
      .for('no key update');
    const item = lockedRows[0];
    if (item === undefined) throw new AuthError('NOT_FOUND', 'Lagerartikel nicht gefunden.');
    if (item.currentStock === null && input.allowUninitialized !== true) {
      throw new AuthError(
        'VALIDATION',
        'Der Anfangsbestand dieses Artikels ist noch nicht erfasst. Bitte zuerst die Erstinventur freigeben.',
      );
    }
    const resulting =
      input.resultingStockOverride ?? (item.currentStock ?? 0) + input.quantityDelta;
    if (resulting < 0) {
      throw new AuthError('VALIDATION', 'Diese Bewegung würde den Bestand unter 0 senken.');
    }
    const inserted = await tx
      .insert(inventoryMovements)
      .values({
        itemId: input.itemId,
        kind: input.kind,
        quantityDelta: input.quantityDelta,
        resultingStock: resulting,
        stocktakeId: input.stocktakeId ?? null,
        createdBy: input.actorId,
      })
      .returning();
    await tx
      .update(inventoryItems)
      .set({ currentStock: resulting, updatedAt: new Date() })
      .where(eq(inventoryItems.id, input.itemId));
    return inserted[0]!;
  }

  // ── Wareneingang (Order §31) ────────────────────────────────────────────

  /**
   * Deaktivierte Artikel sind historisch (Order §38): keine neuen
   * Lageraktionen – serverseitig durchgesetzt, nicht nur im UI (§46).
   */
  private async requireActiveItem(itemId: string): Promise<void> {
    const { product } = await this.itemById(itemId);
    if (!product.active) {
      throw new AuthError(
        'VALIDATION',
        'Dieser Artikel ist deaktiviert und nur noch historisch sichtbar.',
      );
    }
  }

  /** Nimmt die HINZUGEFÜGTE Menge entgegen – nie einen neuen Gesamtwert. */
  async receive(
    actorId: string,
    itemId: string,
    addedQuantity: number,
  ): Promise<InventoryMovement> {
    if (!Number.isInteger(addedQuantity) || addedQuantity <= 0) {
      throw new AuthError(
        'VALIDATION',
        'Die hinzugefügte Menge muss eine ganze Zahl größer 0 sein.',
      );
    }
    await this.requireActiveItem(itemId);
    return this.db.transaction(async (tx) =>
      this.applyMovement(tx, {
        itemId,
        kind: 'incoming',
        quantityDelta: addedQuantity,
        actorId,
      }),
    );
  }

  // ── Mindestbestand (Order §28) ──────────────────────────────────────────

  async setMinStock(itemId: string, minStock: number | null): Promise<InventoryItem> {
    if (minStock !== null && (!Number.isInteger(minStock) || minStock < 0)) {
      throw new AuthError('VALIDATION', 'Der Mindestbestand muss eine ganze Zahl ≥ 0 sein.');
    }
    await this.requireActiveItem(itemId);
    const updated = await this.db
      .update(inventoryItems)
      .set({ minStock, updatedAt: new Date() })
      .where(eq(inventoryItems.id, itemId))
      .returning();
    const row = updated[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Lagerartikel nicht gefunden.');
    return row;
  }

  // ── Bewegungshistorie (Order §33) ───────────────────────────────────────

  async listMovements(limit = 200): Promise<
    {
      id: string;
      productName: string;
      kind: InventoryMovement['kind'];
      quantityDelta: number;
      resultingStock: number;
      createdByName: string | null;
      createdAt: string;
    }[]
  > {
    const rows = await this.db
      .select({
        movement: inventoryMovements,
        productName: products.name,
        firstName: staffUsers.firstName,
        lastName: staffUsers.lastName,
      })
      .from(inventoryMovements)
      .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryMovements.itemId))
      .innerJoin(products, eq(products.id, inventoryItems.productId))
      .leftJoin(staffUsers, eq(staffUsers.id, inventoryMovements.createdBy))
      .orderBy(desc(inventoryMovements.createdAt))
      .limit(limit);
    return rows.map(({ movement, productName, firstName, lastName }) => ({
      id: movement.id,
      productName,
      kind: movement.kind,
      quantityDelta: movement.quantityDelta,
      resultingStock: movement.resultingStock,
      createdByName: firstName === null ? null : `${firstName} ${lastName ?? ''}`.trim(),
      createdAt: movement.createdAt.toISOString(),
    }));
  }

  // ── Inventur (Order §§34–37) ────────────────────────────────────────────

  /**
   * Inventur anlegen (komplett oder Einzelartikel): speichert System- und
   * Ist-Bestand, ändert den Bestand aber NICHT. Ohne Differenz und mit
   * initialisierten Artikeln wird sie direkt abgeschlossen; sonst
   * "Freigabe erforderlich" (auch für die Erstinventur, Order §36).
   */
  async createStocktake(
    actorId: string,
    entries: { itemId: string; countedStock: number }[],
  ): Promise<StocktakeView> {
    if (entries.length === 0) {
      throw new AuthError('VALIDATION', 'Eine Inventur braucht mindestens einen Artikel.');
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!Number.isInteger(entry.countedStock) || entry.countedStock < 0) {
        throw new AuthError('VALIDATION', 'Gezählte Bestände müssen ganze Zahlen ≥ 0 sein.');
      }
      if (seen.has(entry.itemId)) {
        throw new AuthError(
          'VALIDATION',
          'Ein Artikel darf je Inventur nur einmal gezählt werden.',
        );
      }
      seen.add(entry.itemId);
    }
    const stocktakeId = await this.db.transaction(async (tx) => {
      const itemRows = await tx
        .select({ item: inventoryItems, productActive: products.active })
        .from(inventoryItems)
        .innerJoin(products, eq(products.id, inventoryItems.productId))
        .where(
          inArray(
            inventoryItems.id,
            entries.map((entry) => entry.itemId),
          ),
        )
        .then((rows) => rows.map(({ item, productActive }) => ({ ...item, productActive })));
      if (itemRows.length !== entries.length) {
        throw new AuthError('NOT_FOUND', 'Mindestens ein Lagerartikel wurde nicht gefunden.');
      }
      if (itemRows.some((row) => !row.productActive)) {
        throw new AuthError(
          'VALIDATION',
          'Deaktivierte Artikel sind nur historisch sichtbar und können nicht neu gezählt werden.',
        );
      }
      const needsApproval = entries.some((entry) => {
        const item = itemRows.find((row) => row.id === entry.itemId)!;
        return item.currentStock === null || item.currentStock !== entry.countedStock;
      });
      const inserted = await tx
        .insert(inventoryStocktakes)
        .values({
          status: needsApproval ? 'pending_approval' : 'completed',
          createdBy: actorId,
        })
        .returning({ id: inventoryStocktakes.id });
      const id = inserted[0]!.id;
      await tx.insert(inventoryStocktakeItems).values(
        entries.map((entry) => ({
          stocktakeId: id,
          itemId: entry.itemId,
          systemStock: itemRows.find((row) => row.id === entry.itemId)!.currentStock,
          countedStock: entry.countedStock,
        })),
      );
      return id;
    });
    return this.stocktakeById(stocktakeId);
  }

  async stocktakeById(stocktakeId: string): Promise<StocktakeView> {
    const rows = await this.db
      .select()
      .from(inventoryStocktakes)
      .where(eq(inventoryStocktakes.id, stocktakeId));
    const stocktake = rows[0];
    if (stocktake === undefined) throw new AuthError('NOT_FOUND', 'Inventur nicht gefunden.');
    const itemRows = await this.db
      .select({
        line: inventoryStocktakeItems,
        productName: products.name,
        saleUnit: products.saleUnit,
      })
      .from(inventoryStocktakeItems)
      .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryStocktakeItems.itemId))
      .innerJoin(products, eq(products.id, inventoryItems.productId))
      .where(eq(inventoryStocktakeItems.stocktakeId, stocktakeId))
      .orderBy(asc(products.sortOrder), asc(products.name));
    const userIds = [stocktake.createdBy, stocktake.approvedBy].filter(
      (value): value is string => value !== null,
    );
    const userRows =
      userIds.length === 0
        ? []
        : await this.db
            .select({
              id: staffUsers.id,
              firstName: staffUsers.firstName,
              lastName: staffUsers.lastName,
            })
            .from(staffUsers)
            .where(inArray(staffUsers.id, userIds));
    const nameOf = (id: string | null) => {
      if (id === null) return null;
      const user = userRows.find((row) => row.id === id);
      return user === undefined ? null : `${user.firstName} ${user.lastName}`.trim();
    };
    return {
      id: stocktake.id,
      status: stocktake.status,
      createdAt: stocktake.createdAt.toISOString(),
      createdByName: nameOf(stocktake.createdBy),
      approvedAt: stocktake.approvedAt?.toISOString() ?? null,
      approvedByName: nameOf(stocktake.approvedBy),
      items: itemRows.map(({ line, productName, saleUnit }) => ({
        itemId: line.itemId,
        productName,
        saleUnit,
        systemStock: line.systemStock,
        countedStock: line.countedStock,
        absoluteDifference: line.systemStock === null ? null : line.countedStock - line.systemStock,
        percentDifference: percentDifference(line.systemStock, line.countedStock),
      })),
    };
  }

  async listStocktakes(limit = 50): Promise<StocktakeView[]> {
    const rows = await this.db
      .select({ id: inventoryStocktakes.id })
      .from(inventoryStocktakes)
      .orderBy(desc(inventoryStocktakes.createdAt))
      .limit(limit);
    return Promise.all(rows.map((row) => this.stocktakeById(row.id)));
  }

  /** Vor der Freigabe darf der gezählte Ist-Wert korrigiert werden (§35). */
  async correctCountedStock(
    stocktakeId: string,
    itemId: string,
    countedStock: number,
  ): Promise<void> {
    if (!Number.isInteger(countedStock) || countedStock < 0) {
      throw new AuthError('VALIDATION', 'Gezählte Bestände müssen ganze Zahlen ≥ 0 sein.');
    }
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(inventoryStocktakes)
        .where(eq(inventoryStocktakes.id, stocktakeId))
        .for('no key update');
      const stocktake = rows[0];
      if (stocktake === undefined) throw new AuthError('NOT_FOUND', 'Inventur nicht gefunden.');
      if (stocktake.status !== 'pending_approval') {
        throw new AuthError(
          'CONFLICT',
          'Nur Inventuren mit ausstehender Freigabe können korrigiert werden.',
        );
      }
      const updated = await tx
        .update(inventoryStocktakeItems)
        .set({ countedStock, updatedAt: new Date() })
        .where(
          and(
            eq(inventoryStocktakeItems.stocktakeId, stocktakeId),
            eq(inventoryStocktakeItems.itemId, itemId),
          ),
        )
        .returning({ id: inventoryStocktakeItems.id });
      if (updated.length === 0) {
        throw new AuthError('NOT_FOUND', 'Dieser Artikel gehört nicht zur Inventur.');
      }
    });
  }

  /**
   * Freigabe (Order §35/§36): genau EINE Bewegung je Artikel mit Differenz
   * bzw. je Erstinventur-Artikel. Der konditionale Statuswechsel
   * (pending_approval → approved) macht Double-Submit und PARALLELE
   * Freigaben unschädlich – nur ein Aufruf gewinnt.
   */
  async approveStocktake(actorId: string, stocktakeId: string): Promise<StocktakeView> {
    await this.db.transaction(async (tx) => {
      const claimed = await tx
        .update(inventoryStocktakes)
        .set({ status: 'approved', approvedBy: actorId, approvedAt: new Date() })
        .where(
          and(
            eq(inventoryStocktakes.id, stocktakeId),
            eq(inventoryStocktakes.status, 'pending_approval'),
          ),
        )
        .returning({ id: inventoryStocktakes.id });
      if (claimed.length === 0) {
        const rows = await tx
          .select()
          .from(inventoryStocktakes)
          .where(eq(inventoryStocktakes.id, stocktakeId));
        if (rows.length === 0) throw new AuthError('NOT_FOUND', 'Inventur nicht gefunden.');
        throw new AuthError(
          'CONFLICT',
          'Diese Inventur ist bereits freigegeben oder ohne Differenz abgeschlossen.',
        );
      }
      const lines = await tx
        .select()
        .from(inventoryStocktakeItems)
        .where(eq(inventoryStocktakeItems.stocktakeId, stocktakeId));
      for (const line of lines) {
        // Die Korrektur ist die bei der ZÄHLUNG festgestellte DIFFERENZ
        // (Ist − System-Snapshot). Sie wird auf den AKTUELLEN Bestand
        // angewendet – zwischenzeitliche Wareneingänge bleiben so erhalten
        // und werden nicht still wieder ausgebucht.
        const lockedRows = await tx
          .select()
          .from(inventoryItems)
          .where(eq(inventoryItems.id, line.itemId))
          .for('no key update');
        const item = lockedRows[0];
        if (item === undefined) continue;
        if (item.currentStock === null) {
          await this.applyMovement(tx, {
            itemId: line.itemId,
            kind: 'initial',
            quantityDelta: line.countedStock,
            resultingStockOverride: line.countedStock,
            stocktakeId,
            actorId,
            allowUninitialized: true,
          });
          continue;
        }
        if (line.systemStock === null) {
          // Bei der Zählung war der Artikel noch nicht initialisiert,
          // inzwischen wurde er durch eine ANDERE Inventur initialisiert:
          // der Zähl-Snapshot ist nicht mehr interpretierbar – niemals
          // still überschreiben.
          throw new AuthError(
            'CONFLICT',
            'Ein Artikel wurde seit dieser Zählung durch eine andere Inventur initialisiert. Bitte neu zählen.',
          );
        }
        const delta = line.countedStock - line.systemStock;
        if (delta === 0) continue;
        if (item.currentStock + delta < 0) {
          throw new AuthError(
            'CONFLICT',
            'Der Bestand hat sich seit der Zählung so verändert, dass die Freigabe ihn unter 0 senken würde. Bitte neu zählen.',
          );
        }
        await this.applyMovement(tx, {
          itemId: line.itemId,
          kind: 'inventory_adjustment',
          quantityDelta: delta,
          stocktakeId,
          actorId,
        });
      }
    });
    return this.stocktakeById(stocktakeId);
  }

  // ── Vorbereitete Schnittstellen für Phase 6/7 (Order §40) ───────────────

  /**
   * Ausgabe aus dem Lager (Kommission/Kaufartikel). In Phase 5 bewusst
   * NICHT über Routen erreichbar – reine Domain-Schnittstelle, damit
   * Phase 6 atomar ausbuchen kann. `allowNegative` erlaubt später die
   * fachliche "warnen statt blockieren"-Regel (Order §42).
   */
  async issue(
    actorId: string,
    itemId: string,
    quantity: number,
    options: { allowNegative?: boolean } = {},
  ): Promise<InventoryMovement> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new AuthError('VALIDATION', 'Die Ausgabemenge muss eine ganze Zahl größer 0 sein.');
    }
    return this.db.transaction(async (tx) => {
      if (options.allowNegative === true) {
        // Spätere fachliche Regel: warnen statt blockieren. Der Bestand
        // wird dennoch NIE unter 0 geschrieben – die Differenz bleibt als
        // fachliche Warnung Sache der aufrufenden Phase.
        const lockedRows = await tx
          .select()
          .from(inventoryItems)
          .where(eq(inventoryItems.id, itemId))
          .for('no key update');
        const current = lockedRows[0]?.currentStock ?? 0;
        const effective = Math.min(quantity, Math.max(current, 0));
        if (effective === 0) {
          throw new AuthError('VALIDATION', 'Kein Bestand für diese Ausgabe vorhanden.');
        }
        return this.applyMovement(tx, {
          itemId,
          kind: 'issue',
          quantityDelta: -effective,
          actorId,
        });
      }
      return this.applyMovement(tx, { itemId, kind: 'issue', quantityDelta: -quantity, actorId });
    });
  }

  /** Rücknahme ungeöffneter Ware (Phase 7) – vorbereitete Schnittstelle. */
  async returnToStock(
    actorId: string,
    itemId: string,
    quantity: number,
  ): Promise<InventoryMovement> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new AuthError('VALIDATION', 'Die Rücknahmemenge muss eine ganze Zahl größer 0 sein.');
    }
    return this.db.transaction(async (tx) =>
      this.applyMovement(tx, { itemId, kind: 'return', quantityDelta: quantity, actorId }),
    );
  }
}
