/**
 * Phase 14 (Order §14): `pnpm demo:seed` – legt den kanonischen Demo-Datensatz
 * auf einem LEEREN Demo-Geschäftsbestand an.
 *
 * - Ausschließlich APP_ENV=demo (sonst Abbruch, Exit 2).
 * - Akteur: der erste aktive Systemadmin der Demo-Datenbank (nie angelegt;
 *   ohne Admin Abbruch mit Hinweis auf `pnpm staff:bootstrap-admin`).
 * - Existieren bereits Demo-Geschäftsdaten: kein stilles Überschreiben –
 *   Hinweis „Demo-Daten existieren bereits – demo:reset verwenden.“ (Exit 1).
 * - Protokolliert nur Datenbankname und Zähler, nie Inhalte oder Secrets.
 * - Migrationen werden NICHT angewendet (`pnpm db:migrate` ist ein eigener Schritt).
 */
import { loadConfig } from '@mietroyal/config';
import { createDb, createPool } from '@mietroyal/database';
import { createStorageProvider, PostgresJobQueue } from '@mietroyal/integrations';
import { DemoSeedService } from '../src/demo/seed/seed-service.ts';
import { DemoError } from '../src/demo/types.ts';
import {
  assertDemoCli,
  cliLogger,
  databaseNameOf,
  formatCounts,
  requireSystemAdmin,
} from './demo-cli.ts';

const config = loadConfig();
assertDemoCli(config);

const pool = createPool(config.databaseUrl);
try {
  const db = createDb(pool);
  const actorId = await requireSystemAdmin(db);
  console.log(`Demo-Seed startet (Datenbank: ${databaseNameOf(config)}).`);
  const seed = new DemoSeedService({
    db,
    config,
    storage: createStorageProvider(config.storage),
    queue: new PostgresJobQueue(pool),
    logger: cliLogger(),
  });
  const result = await seed.seed({ actorId, now: new Date() });
  console.log(
    `Demo-Seed fertig (Dataset-Version ${result.datasetVersion}): ${formatCounts(result.seeded)}.`,
  );
} catch (error) {
  if (error instanceof DemoError) {
    console.error(`${error.message} [${error.demoCode}]`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
