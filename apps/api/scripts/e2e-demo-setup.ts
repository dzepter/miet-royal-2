/**
 * Phase 12 (E2E, Szenario T – Demo-Isolation): bereitet die Datenbank der
 * zusätzlichen Demo-API der E2E-Suite vor (playwright.config.ts, Projekt
 * `demo-communication`). Läuft im Startkommando DIESER API mit deren
 * Umgebung (APP_ENV=demo, eigene DB/Storage/Schlüssel) – vor `src/server.ts`.
 *
 * - Ausschließlich gegen die E2E-Demo-Datenbank `mietroyal_test_demo`
 *   (Sicherheitsstopp sonst) und nur mit APP_ENV=demo.
 * - Jede E2E-Ausführung beginnt mit einer FRISCHEN Datenbank: DROP (FORCE) +
 *   CREATE über die Wartungsdatenbank `postgres`, danach alle Migrationen.
 * - Bootstrap genau eines synthetischen Demo-Admins über denselben Weg wie
 *   `pnpm staff:bootstrap-admin` (StaffAdminService.bootstrapFirstAdmin) –
 *   Zugangsdaten aus E2E_DEMO_ADMIN_EMAIL/E2E_DEMO_ADMIN_PASSWORD
 *   (synthetisches Testmaterial aus tests/e2e/helpers/demo-env.ts).
 * Keine Ausgabe von Zugangsdaten; nur ein neutraler Fertig-Hinweis.
 */
import { loadConfig } from '@mietroyal/config';
import { createDb, createPool, runMigrations } from '@mietroyal/database';
import { StaffAdminService } from '../src/auth/admin-service.ts';
import { NoopMailAdapter } from '../src/auth/mail.ts';
import { StaffAuthService } from '../src/auth/service.ts';

const DEMO_DATABASE_NAME = 'mietroyal_test_demo';

const config = loadConfig();
const target = new URL(config.databaseUrl);
if (config.appEnv !== 'demo' || target.pathname !== `/${DEMO_DATABASE_NAME}`) {
  console.error(
    `Sicherheitsstopp: e2e-demo-setup läuft nur mit APP_ENV=demo gegen ${DEMO_DATABASE_NAME}.`,
  );
  process.exit(2);
}
const adminEmail = process.env.E2E_DEMO_ADMIN_EMAIL ?? '';
const adminPassword = process.env.E2E_DEMO_ADMIN_PASSWORD ?? '';
if (adminEmail === '' || adminPassword === '') {
  console.error('E2E_DEMO_ADMIN_EMAIL und E2E_DEMO_ADMIN_PASSWORD sind erforderlich.');
  process.exit(2);
}

// Frische Datenbank über die Wartungsdatenbank (gleicher Server, gleiche Rolle).
const maintenance = new URL(config.databaseUrl);
maintenance.pathname = '/postgres';
const maintenancePool = createPool(maintenance.toString());
try {
  await maintenancePool.query(`DROP DATABASE IF EXISTS ${DEMO_DATABASE_NAME} WITH (FORCE)`);
  await maintenancePool.query(`CREATE DATABASE ${DEMO_DATABASE_NAME}`);
} finally {
  await maintenancePool.end();
}

const pool = createPool(config.databaseUrl);
try {
  const db = createDb(pool);
  await runMigrations(db);
  const auth = new StaffAuthService(db, config, new NoopMailAdapter());
  await new StaffAdminService(auth).bootstrapFirstAdmin({
    firstName: 'Dana',
    lastName: 'Demo',
    email: adminEmail,
    password: adminPassword,
  });
  console.log('E2E-Demo-Datenbank bereit (frisch migriert, Demo-Admin angelegt).');
} finally {
  await pool.end();
}
