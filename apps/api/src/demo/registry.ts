import { demoSeedEntities, type Database, type DatabaseExecutor } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import type { DemoSeedEntityRef, DemoSeedKey } from './types.ts';

/**
 * Phase 14 (Order §13): Registry stabiler Seed-Schlüssel. Training und
 * Admin-UI referenzieren Demo-Szenarien ausschließlich über `seedKey`
 * (z. B. `process.offer.draft`), nie über Business-UUIDs. Keine FKs auf
 * Business-Tabellen; der Reset leert Business-Daten und Registry gemeinsam.
 */
export const DEMO_SEED_KEY_PATTERN = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/;

export class DemoSeedRegistry {
  constructor(private readonly db: Database) {}

  async register(tx: DatabaseExecutor, ref: DemoSeedEntityRef): Promise<void> {
    if (!DEMO_SEED_KEY_PATTERN.test(ref.seedKey)) {
      throw new Error(`Ungültiger Seed-Schlüssel: ${ref.seedKey}`);
    }
    await tx
      .insert(demoSeedEntities)
      .values({
        seedKey: ref.seedKey,
        entityType: ref.entityType,
        entityId: ref.entityId,
        datasetVersion: ref.datasetVersion,
      })
      .onConflictDoUpdate({
        target: demoSeedEntities.seedKey,
        set: {
          entityType: ref.entityType,
          entityId: ref.entityId,
          datasetVersion: ref.datasetVersion,
        },
      });
  }

  async resolve(seedKey: DemoSeedKey): Promise<DemoSeedEntityRef | null> {
    const [row] = await this.db
      .select()
      .from(demoSeedEntities)
      .where(eq(demoSeedEntities.seedKey, seedKey))
      .limit(1);
    return row === undefined
      ? null
      : {
          seedKey: row.seedKey,
          entityType: row.entityType,
          entityId: row.entityId,
          datasetVersion: row.datasetVersion,
        };
  }

  async list(): Promise<DemoSeedEntityRef[]> {
    const rows = await this.db.select().from(demoSeedEntities).orderBy(demoSeedEntities.seedKey);
    return rows.map((row) => ({
      seedKey: row.seedKey,
      entityType: row.entityType,
      entityId: row.entityId,
      datasetVersion: row.datasetVersion,
    }));
  }

  async clear(tx: DatabaseExecutor): Promise<number> {
    const deleted = await tx.delete(demoSeedEntities).returning({ id: demoSeedEntities.id });
    return deleted.length;
  }
}
