/**
 * E2E-Testhelfer (nur Testdatenbank `mietroyal_test`, nie production): liest
 * die verschlüsselte Versandkopie eines Gutscheins über den Phase-12-Pfad
 * (`VoucherDeliveryService.revealCodeForDelivery`, serverseitige
 * Entschlüsselung mit dem Schlüssel aus AUTH_SECRET_KEY) und gibt den
 * kompakten Code als letzte Zeile `{"code":"MR20…"}` aus.
 *
 * Zweck: Die Phase-11-E2E-Spec (tests/e2e/specs/voucher-flow.spec.ts) braucht
 * für die Angebots-Szenarien den Klartextcode des in Szenario A automatisch
 * erzeugten Gutscheins. Die Produkt-UI/-API zeigt ihn nie (Order §§12/14);
 * dieser Weg prüft zugleich, dass die Versandkopie entschlüsselbar ist
 * (Phase-12-Vorbereitung, Pflichttest 23) – ohne DB-Mutation und ohne Route.
 * Aufruf mit VOUCHER_ID in der Umgebung.
 */
import { loadConfig } from '@mietroyal/config';
import { createDb, createPool } from '@mietroyal/database';
import { VoucherDeliveryService } from '../src/voucher/voucher-delivery.ts';

const config = loadConfig();
if (config.appEnv === 'production') {
  throw new Error('Nicht in Production ausführbar.');
}
if (!config.databaseUrl.includes('mietroyal_test')) {
  console.error(
    'Sicherheitsstopp: e2e-voucher-reveal läuft nur gegen eine mietroyal_test-Datenbank.',
  );
  process.exit(2);
}
const voucherId = process.env.VOUCHER_ID ?? '';
if (!/^[0-9a-f-]{36}$/.test(voucherId)) {
  throw new Error('VOUCHER_ID (UUID) ist erforderlich.');
}
const pool = createPool(config.databaseUrl);
try {
  const delivery = new VoucherDeliveryService(createDb(pool), config);
  const code = await delivery.revealCodeForDelivery(voucherId);
  // Nur auf stdout des Testhelfers – nie in ein Server-Log.
  process.stdout.write(`${JSON.stringify({ code })}\n`);
} finally {
  await pool.end();
}
