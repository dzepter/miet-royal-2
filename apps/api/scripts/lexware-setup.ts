/**
 * Idempotente Lexware-Einrichtung (Order §54): Profil prüfen, organizationId
 * pinnen/prüfen, Event-Subscriptions lesen, fehlende anlegen, eigene mit
 * veralteter Callback-URL ersetzen, fremde NIE löschen. Ausgabe ohne
 * Secrets (kein API-Key, keine Profil-Personendaten).
 *
 * Aufruf: pnpm lexware:setup
 */
import { loadConfig } from '@mietroyal/config';
import { createDb, createPool, runMigrations } from '@mietroyal/database';
import { LexwareConnectionService } from '../src/lexware/connection-service.ts';
import { createLexwareContext } from '../src/lexware/context.ts';
import { LexwareSubscriptionService } from '../src/lexware/subscription-service.ts';
import { scriptLogger } from './lexware-script-logger.ts';

const config = loadConfig();
if (!config.lexware.enabled) {
  console.error(
    `Lexware ist in APP_ENV=${config.appEnv} nicht aktiv (LEXWARE_ENABLED/LEXWARE_API_KEY prüfen).`,
  );
  process.exit(2);
}
const pool = createPool(config.databaseUrl);
let exitCode = 0;
try {
  const db = createDb(pool);
  await runMigrations(db);
  const lexware = createLexwareContext(config, db, scriptLogger);
  const connection = new LexwareConnectionService(lexware);
  const check = await connection.check();
  console.log(
    `Verbindung (APP_ENV=${config.appEnv}): ${check.state.status}${check.code === null ? '' : ` (${check.code})`}`,
  );
  console.log(`  Firma: ${check.state.companyName ?? '–'}`);
  console.log(`  organizationId: ${check.state.organizationId ?? '–'}`);
  if (check.state.pendingOrganizationId !== null) {
    console.log(
      `  ACHTUNG: Lexware meldet eine andere organizationId (${check.state.pendingOrganizationId}) – Bestätigung in den Einstellungen bzw. LEXWARE_ORGANIZATION_ID erforderlich.`,
    );
  }
  console.log(
    `  taxType: ${check.state.taxType ?? '–'}, smallBusiness: ${String(check.state.smallBusiness ?? '–')}`,
  );
  if (!check.ok) {
    console.error('Subscriptions werden nicht eingerichtet, solange die Verbindung nicht ok ist.');
    exitCode = 1;
  } else {
    const result = await new LexwareSubscriptionService(lexware, connection).setup();
    console.log(`Webhooks (${result.callbackUrl ?? 'KEINE Callback-URL konfiguriert'}):`);
    for (const t of result.existing) console.log(`  vorhanden: ${t}`);
    for (const t of result.created) console.log(`  neu angelegt: ${t}`);
    for (const f of result.failed) console.log(`  FEHLGESCHLAGEN: ${f.eventType} (${f.code})`);
    console.log(`  Status: ${result.webhookStatus}`);
    if (result.failed.length > 0) exitCode = 1;
  }
} finally {
  await pool.end();
}
process.exit(exitCode);
