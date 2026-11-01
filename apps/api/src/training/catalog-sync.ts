import {
  trainingDefinitions,
  trainingFeatureRequirements,
  trainingPathItems,
  trainingPaths,
  type Database,
  type DatabaseTransaction,
} from '@mietroyal/database';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { TRAINING_CATALOG, type TrainingCatalog, type TrainingPathSpec } from './catalog.ts';
import { isEvaluatorKey } from './evaluators.ts';

/**
 * Phase 14 (Training, Order §69/§70/§71, Design §4.2): spiegelt den Code-
 * Katalog beim Start idempotent in die Datenbank der jeweiligen Umgebung.
 *
 * - Eine Transaktion unter `pg_advisory_xact_lock(hashtext('training-catalog-
 *   sync'))` – parallele Starts (API + Worker, mehrere Instanzen) laufen
 *   nacheinander, nie gegeneinander.
 * - Definitionen und Pfade werden nach `key` upserted (Titel, Texte, Version,
 *   Evaluator, aktiv, Demo-Pfad, Seed-Schlüssel); Pfad-Elemente nach
 *   (path, definition) mit Zwei-Schritt-Resequenzierung: bestehende Sequenzen
 *   werden zuerst in einen kollisionsfreien Bereich verschoben (CHECK verlangt
 *   `sequence >= 1`, daher ein positiver Offset statt negativer Werte), dann
 *   erhalten die Katalog-Elemente ihre Soll-Sequenz, nicht mehr im Code
 *   enthaltene Elemente werden hinten angehängt.
 * - Es wird NIE gelöscht, und Versuche, Zuweisungen, Sperren und Freigaben
 *   werden nicht angefasst (§70); Deaktivieren = `active: false` (§71).
 */
export const TRAINING_CATALOG_SYNC_LOCK_KEY = 'training-catalog-sync';

export interface TrainingCatalogSyncResult {
  definitions: number;
  paths: number;
  items: number;
}

export interface TrainingCatalogSyncLogger {
  info(context: Record<string, unknown>, message: string): void;
  /** Review 14b (Härtung): Warnung je aktivierter Sperre auf eine inaktive/fehlende Übung. */
  warn?(context: Record<string, unknown>, message: string): void;
}

/** Review-Fix F6: Katalogquelle für Routen und Gate – „liegt vor oder scheitert“, memoisiert. */
export interface TrainingCatalogSource {
  ensureSynced(): Promise<TrainingCatalogSyncResult>;
}

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Programmierfehler im Katalog früh erkennen (Start schlägt dann fehl). */
export function validateTrainingCatalog(catalog: TrainingCatalog): void {
  const definitionKeys = new Set<string>();
  for (const definition of catalog.definitions) {
    if (!KEY_PATTERN.test(definition.key)) {
      throw new Error(`Trainingskatalog: ungültiger Definition-Key „${definition.key}“`);
    }
    if (definitionKeys.has(definition.key)) {
      throw new Error(`Trainingskatalog: doppelter Definition-Key „${definition.key}“`);
    }
    definitionKeys.add(definition.key);
    if (!isEvaluatorKey(definition.evaluatorKey)) {
      throw new Error(`Trainingskatalog: unbekannter Evaluator „${definition.evaluatorKey}“`);
    }
    if (!Number.isInteger(definition.version) || definition.version < 1) {
      throw new Error(`Trainingskatalog: Version von „${definition.key}“ muss ≥ 1 sein`);
    }
    if (!definition.demoPath.startsWith('/')) {
      throw new Error(`Trainingskatalog: demoPath von „${definition.key}“ muss mit / beginnen`);
    }
  }
  const pathKeys = new Set<string>();
  for (const path of catalog.paths) {
    if (!KEY_PATTERN.test(path.key)) {
      throw new Error(`Trainingskatalog: ungültiger Pfad-Key „${path.key}“`);
    }
    if (pathKeys.has(path.key))
      throw new Error(`Trainingskatalog: doppelter Pfad-Key „${path.key}“`);
    pathKeys.add(path.key);
    const sequences = new Set<number>();
    const itemKeys = new Set<string>();
    for (const item of path.items) {
      if (!definitionKeys.has(item.definitionKey)) {
        throw new Error(
          `Trainingskatalog: Pfad „${path.key}“ verweist auf unbekannte Übung „${item.definitionKey}“`,
        );
      }
      if (!Number.isInteger(item.sequence) || item.sequence < 1 || sequences.has(item.sequence)) {
        throw new Error(`Trainingskatalog: Pfad „${path.key}“ hat keine eindeutige Reihenfolge`);
      }
      sequences.add(item.sequence);
      if (itemKeys.has(item.definitionKey)) {
        throw new Error(
          `Trainingskatalog: Pfad „${path.key}“ enthält „${item.definitionKey}“ mehrfach`,
        );
      }
      itemKeys.add(item.definitionKey);
    }
  }
}

export class TrainingCatalogService implements TrainingCatalogSource {
  private synced: Promise<TrainingCatalogSyncResult> | null = null;

  constructor(
    private readonly db: Database,
    private readonly options: { logger?: TrainingCatalogSyncLogger | undefined } = {},
  ) {}

  /**
   * Review-Fix F6: genau ein erfolgreicher Sync je Instanz (memoisiertes
   * Promise; parallele Aufrufer teilen den laufenden Lauf). Scheitert ein Lauf
   * (z. B. Datenbank beim Start nicht erreichbar), wird der Merker verworfen –
   * der nächste Aufruf synchronisiert erneut (Lazy Retry beim ersten Zugriff).
   */
  ensureSynced(catalog: TrainingCatalog = TRAINING_CATALOG): Promise<TrainingCatalogSyncResult> {
    if (this.synced === null) {
      const attempt: Promise<TrainingCatalogSyncResult> = this.sync(catalog).catch(
        (error: unknown) => {
          if (this.synced === attempt) this.synced = null;
          throw error;
        },
      );
      this.synced = attempt;
    }
    return this.synced;
  }

  async sync(
    catalog: TrainingCatalog = TRAINING_CATALOG,
    now = new Date(),
  ): Promise<TrainingCatalogSyncResult> {
    validateTrainingCatalog(catalog);
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${TRAINING_CATALOG_SYNC_LOCK_KEY}))`,
      );
      for (const definition of catalog.definitions) {
        await tx
          .insert(trainingDefinitions)
          .values({
            key: definition.key,
            version: definition.version,
            title: definition.title,
            objective: definition.objective,
            instructions: definition.instructions,
            evaluatorKey: definition.evaluatorKey,
            active: definition.active,
            demoPath: definition.demoPath,
            seedKey: definition.seedKey,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: trainingDefinitions.key,
            set: {
              version: definition.version,
              title: definition.title,
              objective: definition.objective,
              instructions: definition.instructions,
              evaluatorKey: definition.evaluatorKey,
              active: definition.active,
              demoPath: definition.demoPath,
              seedKey: definition.seedKey,
              updatedAt: now,
            },
          });
      }
      const definitionIds = new Map<string, string>();
      if (catalog.definitions.length > 0) {
        const rows = await tx
          .select({ id: trainingDefinitions.id, key: trainingDefinitions.key })
          .from(trainingDefinitions)
          .where(
            inArray(
              trainingDefinitions.key,
              catalog.definitions.map((definition) => definition.key),
            ),
          );
        for (const row of rows) definitionIds.set(row.key, row.id);
      }
      let items = 0;
      for (const path of catalog.paths) {
        items += await this.syncPath(tx, path, definitionIds, now);
      }
      // Review 14b (Härtung, nur Log): aktivierte Live-Sperren, deren Übung jetzt inaktiv
      // oder unbekannt ist – das Gate blockiert dann fail-closed (§97,
      // TRAINING_CONFIGURATION_INVALID). Der Sync deaktiviert nichts und bricht nicht ab
      // (Admin-Entscheidung, §98); er macht den Zustand nur beim Start sichtbar.
      const requirements = await tx
        .select({
          featureKey: trainingFeatureRequirements.featureKey,
          definitionKey: trainingFeatureRequirements.definitionKey,
          active: trainingDefinitions.active,
        })
        .from(trainingFeatureRequirements)
        .leftJoin(
          trainingDefinitions,
          eq(trainingDefinitions.key, trainingFeatureRequirements.definitionKey),
        )
        .where(eq(trainingFeatureRequirements.enabled, true));
      return {
        definitions: catalog.definitions.length,
        paths: catalog.paths.length,
        items,
        invalidRequirements: requirements.filter((row) => row.active !== true),
      };
    });
    for (const requirement of result.invalidRequirements) {
      this.options.logger?.warn?.(
        { featureKey: requirement.featureKey, definitionKey: requirement.definitionKey },
        'Trainingskatalog: aktivierte Live-Sperre verweist auf eine inaktive oder fehlende Übung – die Funktion bleibt fail-closed gesperrt (TRAINING_CONFIGURATION_INVALID); Sperre prüfen oder deaktivieren',
      );
    }
    const { definitions, paths, items } = result;
    this.options.logger?.info({ definitions, paths, items }, 'Trainingskatalog synchronisiert');
    return { definitions, paths, items };
  }

  private async syncPath(
    tx: DatabaseTransaction,
    path: TrainingPathSpec,
    definitionIds: ReadonlyMap<string, string>,
    now: Date,
  ): Promise<number> {
    const upserted = await tx
      .insert(trainingPaths)
      .values({
        key: path.key,
        title: path.title,
        description: path.description,
        active: path.active,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: trainingPaths.key,
        set: {
          title: path.title,
          description: path.description,
          active: path.active,
          updatedAt: now,
        },
      })
      .returning({ id: trainingPaths.id });
    const pathId = upserted[0]?.id;
    if (pathId === undefined)
      throw new Error(`Trainingskatalog: Pfad „${path.key}“ nicht gespeichert`);

    const existing = await tx
      .select()
      .from(trainingPathItems)
      .where(eq(trainingPathItems.pathId, pathId))
      .orderBy(asc(trainingPathItems.sequence));
    const maxExisting = existing.reduce((max, item) => Math.max(max, item.sequence), 0);
    const maxTarget = path.items.reduce((max, item) => Math.max(max, item.sequence), 0);
    // Schritt 1: bestehende Sequenzen in einen kollisionsfreien Bereich verschieben.
    if (existing.length > 0) {
      const offset = maxExisting + maxTarget + 1;
      await tx
        .update(trainingPathItems)
        .set({ sequence: sql`${trainingPathItems.sequence} + ${offset}` })
        .where(eq(trainingPathItems.pathId, pathId));
    }
    // Schritt 2: Soll-Sequenzen der Katalog-Elemente setzen (Upsert nach Pfad + Übung).
    const catalogDefinitionIds = new Set<string>();
    for (const item of path.items) {
      const definitionId = definitionIds.get(item.definitionKey);
      if (definitionId === undefined) {
        throw new Error(`Trainingskatalog: Übung „${item.definitionKey}“ fehlt in der Datenbank`);
      }
      catalogDefinitionIds.add(definitionId);
      await tx
        .insert(trainingPathItems)
        .values({ pathId, definitionId, sequence: item.sequence, required: item.required })
        .onConflictDoUpdate({
          target: [trainingPathItems.pathId, trainingPathItems.definitionId],
          set: { sequence: item.sequence, required: item.required },
        });
    }
    // Nicht mehr im Code enthaltene Elemente bleiben erhalten und wandern ans Ende.
    let next = maxTarget;
    for (const item of existing) {
      if (catalogDefinitionIds.has(item.definitionId)) continue;
      next += 1;
      await tx
        .update(trainingPathItems)
        .set({ sequence: next })
        .where(eq(trainingPathItems.id, item.id));
    }
    return path.items.length;
  }
}
