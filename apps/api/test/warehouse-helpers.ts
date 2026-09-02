import type pg from 'pg';
import { machines, products, type Database } from '@mietroyal/database';
import { asc, eq } from 'drizzle-orm';
import { MachineService } from '../src/warehouse/machine-service.ts';
import { MachineAvailabilityService } from '../src/warehouse/availability.ts';
import { InventoryService } from '../src/warehouse/inventory-service.ts';
import type { TestContext } from './auth-helpers.ts';

/** Die 11 verbindlichen Seed-Maschinen (Phase-5-Order §2/§3). */
export const SEED_MACHINE_CODES = [
  'MR-08-01-01',
  'MR-08-01-02',
  'MR-08-02-01',
  'MR-10-01-01',
  'MR-10-01-02',
  'MR-10-01-03',
  'MR-10-01-04',
  'MR-10-01-05',
  'MR-10-01-06',
  'MR-10-02-01',
  'MR-10-02-02',
] as const;

/**
 * Warehouse-Zustand auf den Seed-Stand der Migration 0010 zurücksetzen:
 * Bewegungs-/Sperr-/Inventurtabellen leeren, Test-Maschinen entfernen,
 * Seed-Maschinen zurücksetzen, Lagerartikel wieder "Noch nicht erfasst".
 * (VOR den Auth-Resets aufrufen; die Truncates der Auth-Helper räumen
 * FK-abhängige Tabellen ohnehin mit ab.)
 */
export async function resetWarehouse(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE inventory_stocktake_items, inventory_stocktakes,
     inventory_movements, machine_blocks CASCADE`,
  );
  await pool.query(
    `DELETE FROM machines WHERE machine_code NOT IN (${SEED_MACHINE_CODES.map((code) => `'${code}'`).join(',')})`,
  );
  await pool.query(
    `UPDATE machines SET status = 'ready', location_kind = 'warehouse',
     location_note = NULL, purchase_date = NULL, weight_grams = NULL,
     reference_photo_key = NULL, reference_photo_mime = NULL`,
  );
  await pool.query(`UPDATE inventory_items SET current_stock = NULL, min_stock = NULL`);
  await pool.query(`DELETE FROM system_settings WHERE key = 'staff_app_base_url'`);
}

export function machineServiceFor(ctx: TestContext): MachineService {
  return new MachineService(ctx.db, ctx.storage);
}

export function availabilityServiceFor(ctx: TestContext): MachineAvailabilityService {
  return new MachineAvailabilityService(ctx.db);
}

export function inventoryServiceFor(ctx: TestContext): InventoryService {
  return new InventoryService(ctx.db);
}

export async function machineByCode(db: Database, code: string) {
  const rows = await db.select().from(machines).where(eq(machines.machineCode, code));
  if (rows[0] === undefined) throw new Error(`Seed-Maschine ${code} fehlt`);
  return rows[0];
}

export async function productBySlug(db: Database, slug: string) {
  const rows = await db.select().from(products).where(eq(products.slug, slug));
  if (rows[0] === undefined) throw new Error(`Produkt ${slug} fehlt`);
  return rows[0];
}

export async function allMachines(db: Database) {
  return db.select().from(machines).orderBy(asc(machines.machineCode));
}
