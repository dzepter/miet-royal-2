/**
 * Seed für die E2E-Smokes: leere Auth-Tabellen + ein Bootstrap-Admin.
 * Ausschließlich synthetische Testdaten; läuft gegen die per DATABASE_URL
 * übergebene TESTdatenbank (niemals dev/produktiv aufrufen).
 */
import { loadConfig } from '@mietroyal/config';
import { createDb, createPool, runMigrations } from '@mietroyal/database';
import { StaffAdminService } from '../src/auth/admin-service.ts';
import { NoopMailAdapter } from '../src/auth/mail.ts';
import { StaffAuthService } from '../src/auth/service.ts';

export const E2E_ADMIN_EMAIL = 'admin@e2e.example';
export const E2E_ADMIN_PASSWORD = 'e2e-admin-passwort-1';

const config = loadConfig();
if (!config.databaseUrl.includes('mietroyal_test')) {
  console.error('Sicherheitsstopp: e2e-seed läuft nur gegen die mietroyal_test-Datenbank.');
  process.exit(2);
}

const pool = createPool(config.databaseUrl);
try {
  const db = createDb(pool);
  await runMigrations(db);
  await pool.query('TRUNCATE process_notes, processes, customers, system_settings CASCADE');
  await pool.query(
    `TRUNCATE staff_security_events, staff_user_permission_overrides, staff_user_roles,
     staff_role_permissions, staff_roles, staff_recovery_codes,
     staff_password_reset_tokens, staff_login_challenges, staff_sessions,
     staff_permission_explanations, staff_users CASCADE`,
  );
  const auth = new StaffAuthService(db, config, new NoopMailAdapter());
  const admin = new StaffAdminService(auth);
  await admin.bootstrapFirstAdmin({
    firstName: 'Erika',
    lastName: 'E2E',
    email: E2E_ADMIN_EMAIL,
    password: E2E_ADMIN_PASSWORD,
  });
  console.log('E2E-Seed fertig: Admin admin@e2e.example angelegt.');
} finally {
  await pool.end();
}
