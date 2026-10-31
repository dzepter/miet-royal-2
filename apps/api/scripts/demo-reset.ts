/**
 * Phase 14 (Order §15/§16): `pnpm demo:reset` – setzt ALLE Demo-Geschäftsdaten
 * auf den kanonischen Datensatz zurück (destruktiv).
 *
 * - Ausschließlich APP_ENV=demo (sonst Abbruch, Exit 2).
 * - Bestätigung: interaktiv genau „DEMO ZURÜCKSETZEN“ eingeben oder `--yes`
 *   (nur für Automatisierung; ohne Terminal und ohne `--yes` Abbruch).
 * - `--force` (Review F8, nur CLI): ein hängender Reset (Flag gesetzt, aber
 *   kein Prozess hält mehr den Advisory-Lock – z. B. nach Deploy/OOM während
 *   eines Resets) wird sofort als abgelaufen markiert und der Reset neu
 *   gestartet, statt bis zum Ablauf der Stale-Spanne (10 min) zu warten.
 *   Läuft tatsächlich ein Reset (Lock belegt), bleibt es bei
 *   DEMO_RESET_RUNNING. Die Bestätigung gilt unverändert.
 * - Akteur: der erste aktive Systemadmin der Demo-Datenbank.
 * - Staff-Konten, Rollen, Rechte, Geräte, Audit, Einstellungen und Stammdaten
 *   bleiben erhalten; Vorgangsnummern beginnen danach wieder bei 0001.
 * - Protokolliert nur Datenbankname und Zähler, nie Inhalte oder Secrets.
 */
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '@mietroyal/config';
import { createDb, createPool } from '@mietroyal/database';
import { createStorageProvider, PostgresJobQueue } from '@mietroyal/integrations';
import { DemoResetService } from '../src/demo/reset-service.ts';
import { DEMO_MESSAGES, DemoError } from '../src/demo/types.ts';
import {
  assertDemoCli,
  cliLogger,
  databaseNameOf,
  formatCounts,
  requireSystemAdmin,
} from './demo-cli.ts';

const config = loadConfig();
assertDemoCli(config);

const databaseName = databaseNameOf(config);
const autoConfirm = process.argv.includes('--yes');
const force = process.argv.includes('--force');
if (autoConfirm) {
  console.warn(
    `Hinweis: --yes überspringt die Bestätigung (nur für Automatisierung). Datenbank: ${databaseName}.`,
  );
} else {
  if (!process.stdin.isTTY) {
    console.error(
      `Kein interaktives Terminal – für die Automatisierung „--yes“ übergeben. Abbruch (Datenbank: ${databaseName}).`,
    );
    process.exit(2);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = (
      await rl.question(
        `ALLE Demo-Geschäftsdaten der Datenbank „${databaseName}“ werden gelöscht und neu angelegt.\n` +
          `Zum Bestätigen genau „${DEMO_MESSAGES.RESET_CONFIRMATION}“ eingeben: `,
      )
    ).trim();
  } finally {
    rl.close();
  }
  if (answer !== DEMO_MESSAGES.RESET_CONFIRMATION) {
    console.error('Bestätigung stimmt nicht überein – Abbruch, nichts geändert.');
    process.exit(2);
  }
}

const pool = createPool(config.databaseUrl);
try {
  const db = createDb(pool);
  const actorId = await requireSystemAdmin(db);
  const reset = new DemoResetService({
    db,
    config,
    storage: createStorageProvider(config.storage),
    queue: new PostgresJobQueue(pool),
    logger: cliLogger(),
  });
  const now = new Date();
  if (force) {
    // Nur ein hängendes Flag ohne Lock-Inhaber wird freigegeben; ein wirklich
    // laufender Reset meldet DEMO_RESET_RUNNING (unten).
    const released = await reset.releaseStaleReset(now);
    console.warn(
      released
        ? 'Hinweis: --force – hängender Reset als abgelaufen markiert; der Reset startet neu.'
        : 'Hinweis: --force ohne Wirkung – es hing kein Reset.',
    );
  }
  console.log(`Demo-Reset startet (Datenbank: ${databaseName}).`);
  const result = await reset.reset({ actorId, now });
  const deletedRows = Object.values(result.deleted).reduce((sum, value) => sum + value, 0);
  console.log(
    `Demo-Reset fertig in ${result.durationMs} ms (Dataset-Version ${result.datasetVersion}): ` +
      `${deletedRows} Zeilen gelöscht; neu: ${formatCounts(result.seeded)}.`,
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
