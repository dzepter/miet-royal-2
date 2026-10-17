/**
 * Zahlungsstatus-Abgleich mit Lexware (Order §53): nur gemappte offene/
 * überfällige/unklare Rechnungen, max. 100 je Lauf, über die zentrale
 * Drosselung. Kein permanentes Polling – bewusst nur manuell/per Admin.
 *
 * Aufruf: pnpm lexware:reconcile
 */
import { loadConfig } from '@mietroyal/config';
import { createDb, createPool, runMigrations } from '@mietroyal/database';
import { PostgresJobQueue } from '@mietroyal/integrations';
import { AccountingTransferService } from '../src/accounting/transfer-service.ts';
import { createAccountingGatewayFor } from '../src/jobs/finance.ts';
import { LexwareConnectionService } from '../src/lexware/connection-service.ts';
import { createLexwareContext } from '../src/lexware/context.ts';
import { LexwareReconcileService } from '../src/lexware/reconcile-service.ts';
import { scriptLogger } from './lexware-script-logger.ts';

const config = loadConfig();
if (!config.lexware.enabled) {
  console.error(`Lexware ist in APP_ENV=${config.appEnv} nicht aktiv.`);
  process.exit(2);
}
const pool = createPool(config.databaseUrl);
let exitCode = 0;
try {
  const db = createDb(pool);
  await runMigrations(db);
  const lexware = createLexwareContext(config, db, scriptLogger);
  const connection = new LexwareConnectionService(lexware);
  const transfers = new AccountingTransferService(
    db,
    createAccountingGatewayFor(config, lexware),
    new PostgresJobQueue(pool),
  );
  const result = await new LexwareReconcileService(lexware, db, transfers, connection).run();
  console.log(
    `Lexware-Abgleich (APP_ENV=${config.appEnv}): ${result.checked} geprüft, ${result.updated} aktualisiert, ${result.attention} mit Prüfbedarf, ${result.failed} fehlgeschlagen.`,
  );
  if (result.failed > 0) exitCode = 1;
} catch (error) {
  console.error(
    `Lexware-Abgleich abgebrochen: ${error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'Fehler'}`,
  );
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);
