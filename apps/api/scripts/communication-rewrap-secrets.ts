/**
 * Schlüsselrotation der Kommunikations-Payloads (Phase 12, Order §8):
 * kapselt Gutschein-Versandkopien (v1 aus AUTH_SECRET_KEY oder v2 mit
 * COMMUNICATION_PAYLOAD_KEY_PREVIOUS) und offene Mail-Secret-Payloads mit
 * dem aktuellen COMMUNICATION_PAYLOAD_KEY neu. Idempotent; mehrfaches
 * Ausführen ändert nichts mehr. Ausgabe: nur Zähler – nie Codes/Token.
 *
 * Aufruf: pnpm communication:rewrap-secrets
 * Ablauf bei Rotation: neuen Key als COMMUNICATION_PAYLOAD_KEY, alten als
 * COMMUNICATION_PAYLOAD_KEY_PREVIOUS setzen ⇒ Script ausführen ⇒ danach
 * PREVIOUS entfernen (siehe docs/DEPLOYMENT_NOTES.md).
 */
import { loadConfig } from '@mietroyal/config';
import { createDb, createPool, runMigrations } from '@mietroyal/database';
import { PayloadCrypto } from '../src/communication/payload-crypto.ts';
import { rewrapCommunicationSecrets } from '../src/communication/rewrap.ts';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  const db = createDb(pool);
  await runMigrations(db);
  const result = await rewrapCommunicationSecrets(db, new PayloadCrypto(config));
  const line = (
    name: string,
    c: { scanned: number; current: number; rewrapped: number; undecryptable: number },
  ) =>
    `  ${name}: ${c.scanned} geprüft, ${c.current} bereits aktuell, ${c.rewrapped} neu gekapselt, ${c.undecryptable} nicht entschlüsselbar`;
  console.log(`Rewrap abgeschlossen (APP_ENV=${config.appEnv}):`);
  console.log(line('Gutschein-Versandkopien', result.vouchers));
  console.log(line('Mail-Secret-Payloads', result.mailDeliveries));
  if (result.vouchers.undecryptable > 0 || result.mailDeliveries.undecryptable > 0) {
    console.error(
      'Hinweis: nicht entschlüsselbare Einträge wurden markiert (Gutschein: delivery_problem_code, Mail: blocked) – Codes/Hashes bleiben unverändert.',
    );
  }
} finally {
  await pool.end();
}
