/**
 * E2E-Testhelfer (nur Testdatenbank): setzt den Reinigungsbeginn einer
 * Maschine um HOURS Stunden zurück, um die zeitabhängige 24-h-Warnung
 * deterministisch zu prüfen. Aufruf mit MACHINE_CODE und HOURS in der Umgebung.
 */
import { loadConfig } from '@mietroyal/config';
import { createPool } from '@mietroyal/database';

const config = loadConfig();
if (config.appEnv === 'production') {
  throw new Error('Nicht in Production ausführbar.');
}
const machineCode = process.env.MACHINE_CODE ?? '';
const hours = Number(process.env.HOURS ?? '25');
if (machineCode === '' || !Number.isFinite(hours)) {
  throw new Error('MACHINE_CODE und HOURS sind erforderlich.');
}
const pool = createPool(config.databaseUrl);
try {
  const result = await pool.query(
    `UPDATE machines SET cleaning_since = now() - ($2 || ' hours')::interval
     WHERE machine_code = $1 AND status = 'cleaning' AND cleaning_since IS NOT NULL`,
    [machineCode, String(hours)],
  );
  if (result.rowCount !== 1) {
    throw new Error(`Maschine ${machineCode} ist nicht in Reinigung nach Rückgabe.`);
  }
} finally {
  await pool.end();
}
