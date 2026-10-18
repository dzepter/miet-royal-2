/**
 * Idempotenter Backfill (Phase-9-Vorgabe §48): legt für ALLE finalisierten
 * Rückgaben ohne Abrechnung das Settlement an (Positionen aus eingefrorenen
 * Fakten, Klärungen, Status; ggf. Auto-Transfer-Job). Mehrfaches Ausführen
 * erzeugt keine doppelten Settlements, Positionen oder Transfers. Ausgabe:
 * nur Zähler und IDs – keine Beträge, keine Kundendaten.
 *
 * Aufruf: pnpm settlement:ensure
 */
import { loadConfig } from '@mietroyal/config';
import { createDb, createPool, runMigrations } from '@mietroyal/database';
import { PostgresJobQueue } from '@mietroyal/integrations';
import { createAccountingGateway } from '../src/accounting/gateway.ts';
import { AccountingTransferService } from '../src/accounting/transfer-service.ts';
import { ProcessService } from '../src/crm/process-service.ts';
import { SettlementService } from '../src/settlement/settlement-service.ts';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  const db = createDb(pool);
  await runMigrations(db);
  const queue = new PostgresJobQueue(pool);
  const service = new SettlementService({
    db,
    transfers: new AccountingTransferService(db, createAccountingGateway(config), queue),
    // Phase 12: Script sendet keine Kundeninformationen – kein Mailer nötig.
    notices: null,
    queue,
    processes: new ProcessService(db),
    appEnv: config.appEnv,
  });
  const result = await service.ensureAll();
  console.log(
    `Abrechnungsabgleich fertig (APP_ENV=${config.appEnv}): ${result.checked} finalisierte Rückgabe(n) geprüft, ${result.created.length} Abrechnung(en) neu angelegt.`,
  );
  for (const id of result.created) console.log(`  neu: ${id}`);
} finally {
  await pool.end();
}
