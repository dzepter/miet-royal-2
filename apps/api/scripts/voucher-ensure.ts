/**
 * Idempotenter Backfill des Wiedermieter-Gutscheins (Phase 11, Order §8):
 * prüft alle übertragenen, als bezahlt gemeldeten regulären Abrechnungen ohne
 * Gutschein und legt – nur bei vollständiger Berechtigung (schadenfrei,
 * Nachtragsfenster beendet, kein Storno) – genau einen Gutschein an.
 * Mehrfaches Ausführen erzeugt keine Duplikate (Advisory-Lock + UNIQUE
 * origin_settlement_id). Ausgabe: nur Zähler – nie Codes, nie Kundendaten.
 *
 * Aufruf: pnpm voucher:ensure
 */
import { loadConfig } from '@mietroyal/config';
import { createDb, createPool, runMigrations } from '@mietroyal/database';
import { VoucherService } from '../src/voucher/voucher-service.ts';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  const db = createDb(pool);
  await runMigrations(db);
  const service = new VoucherService(db, config);
  const result = await service.ensureForAllEligible();
  console.log(
    `Gutschein-Abgleich fertig (APP_ENV=${config.appEnv}): ${result.scanned} bezahlte Abrechnung(en) geprüft, ${result.created} Gutschein(e) neu angelegt, ${result.exists} bereits vorhanden, ${result.ineligible} nicht berechtigt.`,
  );
} finally {
  await pool.end();
}
