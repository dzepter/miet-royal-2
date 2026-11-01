/**
 * Phase 14 (E2E, Szenarien L–N – Live-Trainingssperren): bereitet die
 * Datenbank der zusätzlichen PRODUCTION-API der E2E-Suite vor
 * (tests/e2e/playwright.config.ts, Projekt `production-gates`). Läuft im
 * Startkommando DIESER API mit deren Umgebung (APP_ENV=production, eigene
 * DB/Storage/Schlüssel) – vor `src/server.ts`. Muster: e2e-demo-setup.ts.
 *
 * - Ausschließlich gegen die E2E-Production-Datenbank `mietroyal_test_prod`
 *   (Sicherheitsstopp sonst) und nur mit APP_ENV=production.
 * - Jede E2E-Ausführung beginnt mit einer FRISCHEN Datenbank: DROP (FORCE) +
 *   CREATE über die Wartungsdatenbank `postgres`, danach alle Migrationen;
 *   das fs-Storage-Verzeichnis wird geleert.
 * - Bootstrap genau eines synthetischen Live-Admins über denselben Weg wie
 *   `pnpm staff:bootstrap-admin` (StaffAdminService.bootstrapFirstAdmin) und
 *   einer Mitarbeiterin mit der Rolle „E2E-Live“ (Angebot bearbeiten und
 *   versenden – die in der Staff-UI dafür nötigen Fachrechte, keine
 *   Verwaltungsrechte, kein `training.manage`). Zugangsdaten aus
 *   E2E_PROD_ADMIN_EMAIL/-PASSWORD und E2E_PROD_STAFF_EMAIL/-PASSWORD
 *   (synthetisches Testmaterial aus tests/e2e/helpers/prod-env.ts).
 * - Der Trainingskatalog wird beim API-Start synchronisiert (onReady-Hook) –
 *   hier nichts weiter nötig. Keine Ausgabe von Zugangsdaten.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { loadConfig } from '@mietroyal/config';
import { createDb, createPool, runMigrations } from '@mietroyal/database';
import type { PermissionKey } from '@mietroyal/permissions';
import { StaffAdminService } from '../src/auth/admin-service.ts';
import { NoopMailAdapter } from '../src/auth/mail.ts';
import { StaffAuthService } from '../src/auth/service.ts';

const PROD_DATABASE_NAME = 'mietroyal_test_prod';

/** Fachrechte der Rolle „E2E-Live“: Angebot aus der Anfrage erstellen, bearbeiten und versenden. */
const LIVE_ROLE_PERMISSIONS: readonly PermissionKey[] = [
  'process.view_all',
  'customer.view',
  'product.view',
  'inquiry.view',
  'offer.view',
  'offer.create',
  'offer.edit_draft',
  'offer.send',
  'calendar.view',
];

const config = loadConfig();
const target = new URL(config.databaseUrl);
if (config.appEnv !== 'production' || target.pathname !== `/${PROD_DATABASE_NAME}`) {
  console.error(
    `Sicherheitsstopp: e2e-prod-setup läuft nur mit APP_ENV=production gegen ${PROD_DATABASE_NAME}.`,
  );
  process.exit(2);
}
const adminEmail = process.env.E2E_PROD_ADMIN_EMAIL ?? '';
const adminPassword = process.env.E2E_PROD_ADMIN_PASSWORD ?? '';
const staffEmail = process.env.E2E_PROD_STAFF_EMAIL ?? '';
const staffPassword = process.env.E2E_PROD_STAFF_PASSWORD ?? '';
if (adminEmail === '' || adminPassword === '' || staffEmail === '' || staffPassword === '') {
  console.error(
    'E2E_PROD_ADMIN_EMAIL, E2E_PROD_ADMIN_PASSWORD, E2E_PROD_STAFF_EMAIL und E2E_PROD_STAFF_PASSWORD sind erforderlich.',
  );
  process.exit(2);
}

// Frisches fs-Storage (Temp-Verzeichnis der E2E-Suite, nie ein Production-Storage).
if (config.storage.driver === 'fs') {
  rmSync(config.storage.fsRoot, { recursive: true, force: true });
  mkdirSync(config.storage.fsRoot, { recursive: true });
}

// Frische Datenbank über die Wartungsdatenbank (gleicher Server, gleiche Rolle).
const maintenance = new URL(config.databaseUrl);
maintenance.pathname = '/postgres';
const maintenancePool = createPool(maintenance.toString());
try {
  await maintenancePool.query(`DROP DATABASE IF EXISTS ${PROD_DATABASE_NAME} WITH (FORCE)`);
  await maintenancePool.query(`CREATE DATABASE ${PROD_DATABASE_NAME}`);
} finally {
  await maintenancePool.end();
}

const pool = createPool(config.databaseUrl);
try {
  const db = createDb(pool);
  await runMigrations(db);
  const auth = new StaffAuthService(db, config, new NoopMailAdapter());
  const admin = new StaffAdminService(auth);
  const adminUser = await admin.bootstrapFirstAdmin({
    firstName: 'Lars',
    lastName: 'Live',
    email: adminEmail,
    password: adminPassword,
  });
  const staff = await admin.createEmployee(adminUser.id, {
    firstName: 'Mia',
    lastName: 'Live',
    email: staffEmail,
  });
  await auth.resetPassword(staff.setupToken, staffPassword);
  const roleId = await admin.createRole(adminUser.id, {
    name: 'E2E-Live',
    permissionKeys: [...LIVE_ROLE_PERMISSIONS],
  });
  await admin.setUserRoles(adminUser.id, staff.user.id, [roleId]);
  // Angebotsversand verlangt in production eine Nicht-Test-Mietbedingungen-Version
  // (TermsService.activeForSending). Hier ein klar als SYNTHETISCH markierter Platzhalter –
  // ausschließlich in dieser E2E-Datenbank, nie ein echter Rechtstext (Muster e2e-seed.ts).
  await pool.query(
    `INSERT INTO terms_versions (label, content, is_test) VALUES
     ('E2E-Platzhalter Live v1 (SYNTHETISCH)',
      'E2E – Dies ist ein synthetischer Platzhalter der Testumgebung, kein echter Rechtstext.',
      false)
     ON CONFLICT (label) DO NOTHING`,
  );
  console.log(
    'E2E-Production-Datenbank bereit (frisch migriert, Live-Admin und Mitarbeiterin „E2E-Live“ angelegt).',
  );
} finally {
  await pool.end();
}
