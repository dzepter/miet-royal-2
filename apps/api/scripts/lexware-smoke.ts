/**
 * Manueller Live-Smoke gegen einen bewusst eingerichteten Lexware-
 * TESTACCOUNT (Order §§56/92): nur mit LEXWARE_SMOKE=1 und aktiver
 * Konfiguration, nie automatisch, nie in production. Liest ausschließlich
 * Profil und Event-Subscriptions – es wird NICHTS geschrieben (kein
 * Kontakt, keine Rechnung, keine Subscription). Ausgabe ohne Secrets.
 *
 * Aufruf: LEXWARE_SMOKE=1 pnpm lexware:smoke
 */
import { loadConfig } from '@mietroyal/config';
import { createDb, createPool } from '@mietroyal/database';
import { createLexwareContext } from '../src/lexware/context.ts';
import { LexwareApiError } from '../src/lexware/errors.ts';
import { scriptLogger } from './lexware-script-logger.ts';

if (process.env.LEXWARE_SMOKE !== '1') {
  console.error('Smoke-Test nur mit LEXWARE_SMOKE=1 (bewusster manueller Aufruf).');
  process.exit(2);
}
const config = loadConfig();
if (config.appEnv === 'production') {
  console.error('Smoke-Test ist in production nicht zulässig.');
  process.exit(2);
}
if (!config.lexware.enabled) {
  console.error(`Lexware ist in APP_ENV=${config.appEnv} nicht aktiv.`);
  process.exit(2);
}
const pool = createPool(config.databaseUrl);
let exitCode = 0;
try {
  const lexware = createLexwareContext(config, createDb(pool), scriptLogger);
  const client = lexware.client;
  if (client === null) throw new Error('Lexware-Client nicht aktiv');
  console.log(
    `Lexware-Smoke (APP_ENV=${config.appEnv}, Host ${config.lexware.baseUrl}) – nur lesend`,
  );
  const profile = (await client.profile()).data;
  console.log(`  Firma: ${profile.companyName}`);
  console.log(`  organizationId: ${profile.organizationId}`);
  console.log(
    `  taxType: ${profile.taxType ?? '–'}, smallBusiness: ${String(profile.smallBusiness ?? '–')}`,
  );
  console.log(`  businessFeatures: ${(profile.businessFeatures ?? []).join(', ') || '–'}`);
  if (
    config.lexware.organizationId !== null &&
    config.lexware.organizationId !== profile.organizationId
  ) {
    console.log('  ACHTUNG: organizationId weicht von LEXWARE_ORGANIZATION_ID ab.');
    exitCode = 1;
  }
  const subs = (await client.listEventSubscriptions()).data.content;
  console.log(`  Event-Subscriptions: ${subs.length}`);
  for (const s of subs) console.log(`    ${s.eventType} → ${s.callbackUrl}`);
  console.log('Smoke-Test abgeschlossen – nichts geschrieben.');
} catch (error) {
  console.error(
    `Smoke-Test fehlgeschlagen: ${error instanceof LexwareApiError ? error.code : 'Fehler'}`,
  );
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);
