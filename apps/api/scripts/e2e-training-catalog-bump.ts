/**
 * Phase 14 (E2E, Szenario O – Definition Update Stability, Order §46/§70):
 * spielt eine KATALOG-VARIANTE (eine Übung mit erhöhter Version und
 * geändertem Titel) über denselben idempotenten Upsert wie der API-Start
 * (`TrainingCatalogService.sync`) in eine E2E-Datenbank ein – bzw. stellt den
 * normalen Katalog wieder her. Läuft als Kindprozess der Spec
 * (tests/e2e/helpers/training.ts) gegen die per DATABASE_URL übergebene
 * E2E-Datenbank (Sicherheitsstopp sonst; nie dev/produktiv).
 *
 * Eingabe: DATABASE_URL, E2E_CATALOG_MODE = `bump` | `restore`,
 * E2E_CATALOG_DEFINITION (Definition-Key, Default `offer_send`).
 * Ausgabe: genau eine JSON-Zeile auf stdout (Key, Version, Titel).
 * Versuche, Zuweisungen, Sperren und Freigaben werden nie angefasst (§70).
 */
import { createDb, createPool } from '@mietroyal/database';
import { TRAINING_CATALOG, type TrainingCatalog } from '../src/training/catalog.ts';
import { TrainingCatalogService } from '../src/training/catalog-sync.ts';

export const E2E_CATALOG_BUMP_TITLE_SUFFIX = ' (E2E-Variante)';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!databaseUrl.includes('mietroyal_test')) {
  console.error(
    'Sicherheitsstopp: e2e-training-catalog-bump läuft nur gegen eine mietroyal_test-Datenbank.',
  );
  process.exit(2);
}
const mode = process.env.E2E_CATALOG_MODE ?? '';
if (mode !== 'bump' && mode !== 'restore') {
  console.error('E2E_CATALOG_MODE muss `bump` oder `restore` sein.');
  process.exit(2);
}
const definitionKey = process.env.E2E_CATALOG_DEFINITION ?? 'offer_send';
const base = TRAINING_CATALOG.definitions.find((definition) => definition.key === definitionKey);
if (base === undefined) {
  console.error(`Unbekannte Übung „${definitionKey}“.`);
  process.exit(2);
}

/** Variante: nur Version und Titel der gewählten Übung ändern – Key, Evaluator, Pfade bleiben. */
const variant: TrainingCatalog = {
  definitions: TRAINING_CATALOG.definitions.map((definition) =>
    definition.key === definitionKey
      ? {
          ...definition,
          version: definition.version + 1,
          title: `${definition.title}${E2E_CATALOG_BUMP_TITLE_SUFFIX}`,
        }
      : definition,
  ),
  paths: TRAINING_CATALOG.paths,
};

const pool = createPool(databaseUrl);
try {
  const service = new TrainingCatalogService(createDb(pool));
  const catalog = mode === 'bump' ? variant : TRAINING_CATALOG;
  await service.sync(catalog);
  const synced = catalog.definitions.find((definition) => definition.key === definitionKey)!;
  process.stdout.write(
    `${JSON.stringify({ mode, key: synced.key, version: synced.version, title: synced.title })}\n`,
  );
} finally {
  await pool.end();
}
