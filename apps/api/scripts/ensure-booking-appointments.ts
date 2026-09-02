/**
 * Idempotenter Backfill (Phase-4-Order §4): legt für ALLE bestätigten
 * Buchungen fehlende operative Termine an (Selbstabholung: Abholung +
 * Rückgabe; Lieferung: Lieferung + Rückgabe). Mehrfaches Ausführen erzeugt
 * keine Doppeltermine (Unique je Buchung+Terminart); vorhandene – auch
 * manuell geänderte – Termine bleiben unangetastet. Keine manuelle
 * Datenbankmanipulation nötig.
 *
 * Aufruf: pnpm scheduling:ensure-booking-appointments
 */
import { loadConfig } from '@mietroyal/config';
import { createDb, createPool, runMigrations } from '@mietroyal/database';
import { SchedulingService } from '../src/scheduling/scheduling-service.ts';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  const db = createDb(pool);
  await runMigrations(db);
  const scheduling = new SchedulingService(db);
  const result = await scheduling.ensureAllBookingAppointments();
  console.log(
    `Terminabgleich fertig (APP_ENV=${config.appEnv}): ${result.bookings} Buchung(en) geprüft, ${result.created} Termin(e) neu angelegt.`,
  );
} finally {
  await pool.end();
}
