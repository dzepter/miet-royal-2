import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AppConfig } from '@mietroyal/config';
import { createDb, createPool, runMigrations, type Database } from '@mietroyal/database';
import { FilesystemStorageProvider } from '@mietroyal/integrations';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../src/app.ts';
import { StaffAdminService } from '../src/auth/admin-service.ts';
import { InMemoryMailAdapter } from '../src/auth/mail.ts';
import { StaffAuthService } from '../src/auth/service.ts';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://mietroyal:mietroyal_local_dev@localhost:55432/mietroyal_test';

export interface TestContext {
  pool: pg.Pool;
  db: Database;
  config: AppConfig;
  app: FastifyInstance;
  mail: InMemoryMailAdapter;
  auth: StaffAuthService;
  admin: StaffAdminService;
  storage: FilesystemStorageProvider;
}

export async function createTestContext(
  options: { rateLimitEnabled?: boolean } = {},
): Promise<TestContext> {
  const config = loadConfig({
    APP_ENV: 'development',
    DATABASE_URL: TEST_DATABASE_URL,
    LOG_LEVEL: 'error',
  });
  const pool = createPool(config.databaseUrl);
  const db = createDb(pool);
  await runMigrations(db);
  const mail = new InMemoryMailAdapter();
  // Isolierter FS-Storage je Testkontext (PDF-/Dokumententests).
  const storage = new FilesystemStorageProvider(mkdtempSync(join(tmpdir(), 'mietroyal-test-')));
  const app = buildApp({
    config,
    pool,
    mailAdapter: mail,
    rateLimitEnabled: options.rateLimitEnabled ?? false,
    storage,
  });
  await app.ready();
  const auth = new StaffAuthService(db, config, mail);
  const admin = new StaffAdminService(auth);
  return { pool, db, config, app, mail, auth, admin, storage };
}

export async function destroyTestContext(context: TestContext): Promise<void> {
  await context.app.close();
  await context.pool.end();
}

/** Reihenfolge beachtet Fremdschlüssel; CASCADE räumt Restbezüge ab. */
export async function truncateAuthTables(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE staff_security_events, staff_user_permission_overrides, staff_user_roles,
     staff_role_permissions, staff_roles, staff_recovery_codes,
     staff_password_reset_tokens, staff_login_challenges, staff_sessions,
     staff_permission_explanations, staff_users CASCADE`,
  );
}

export const ADMIN_EMAIL = 'admin@test.example';
export const ADMIN_PASSWORD = 'test-admin-passwort-123';

export async function bootstrapAdmin(context: TestContext) {
  return context.admin.bootstrapFirstAdmin({
    firstName: 'Anna',
    lastName: 'Admin',
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
}

export interface LoginResult {
  cookie: string;
  body: Record<string, unknown>;
  statusCode: number;
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36';

export async function login(
  app: FastifyInstance,
  email: string,
  password: string,
  userAgent = DEFAULT_UA,
): Promise<LoginResult> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
    headers: { 'user-agent': userAgent },
  });
  const setCookie = response.cookies.find((c) => c.name === 'mr_staff_session');
  return {
    cookie: setCookie === undefined ? '' : `mr_staff_session=${setCookie.value}`,
    body: response.json(),
    statusCode: response.statusCode,
  };
}

/** Legt einen normalen Mitarbeiter mit Passwort an (über Setup-Token-Weg). */
export async function createEmployeeWithPassword(
  context: TestContext,
  adminUserId: string,
  input: { firstName: string; lastName: string; email: string; password: string },
) {
  const { user, setupToken } = await context.admin.createEmployee(adminUserId, {
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
  });
  await context.auth.resetPassword(setupToken, input.password);
  return user;
}
