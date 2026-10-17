import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AppConfig } from '@mietroyal/config';
import { createDb, createPool, runMigrations, type Database } from '@mietroyal/database';
import { FilesystemStorageProvider, JobRunner, PostgresJobQueue } from '@mietroyal/integrations';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { MockAccountingGateway, type AccountingGateway } from '../src/accounting/gateway.ts';
import type { AccountingTransferService } from '../src/accounting/transfer-service.ts';
import { buildApp } from '../src/app.ts';
import { StaffAdminService } from '../src/auth/admin-service.ts';
import { InMemoryMailAdapter } from '../src/auth/mail.ts';
import { StaffAuthService } from '../src/auth/service.ts';
import {
  createAccountingGatewayFor,
  createAccountingTransferService,
  registerFinanceJobHandlers,
} from '../src/jobs/finance.ts';
import { LexwareConnectionService } from '../src/lexware/connection-service.ts';
import { createLexwareContext, type LexwareContext } from '../src/lexware/context.ts';
import { NoopLexwareThrottle } from '../src/lexware/rate-limiter.ts';
import { FakeLexwareServer } from '../src/lexware/testing/fake-server.ts';
import { OutboxSettlementNoticeGateway } from '../src/settlement/notice-gateway.ts';

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
  /** Phase 9: Mock-Buchhaltung (Aufrufe/Fehlersimulation abfragbar). */
  accounting: MockAccountingGateway;
  /** Phase 9: Outbox der Kundeninformationen (nichts verlässt das System). */
  notices: OutboxSettlementNoticeGateway;
  /** Phase 9: dieselbe Queue wie die App; `jobs.runOnce()`/`drain()` verarbeitet Finanz-Jobs wie der Worker. */
  queue: PostgresJobQueue;
  jobs: JobRunner;
  /** Phase 10: Lexware-Kontext (client null ohne `lexware: true`). */
  lexware: LexwareContext;
  /** Phase 10: Contract-Fake (nur mit `lexware: true`). */
  lexwareFake: FakeLexwareServer | null;
  /** Phase 10: aktives Gateway der App (Mock oder Lexware). */
  gateway: AccountingGateway;
  /** Phase 10: Verbindungsprüfung (von App, Jobs und `transfersFor()` geteilt). */
  lexwareConnection: LexwareConnectionService;
  /** Phase 10: Transfer-Boundary wie in der App (inkl. Lexware-Zweiphasenpfad); `workerId` optional. */
  transfersFor: (workerId?: string) => AccountingTransferService;
}

export async function createTestContext(
  options: {
    rateLimitEnabled?: boolean;
    poolMax?: number;
    /** Log-Ziel zum Auffangen des Serverlogs (Default: stdout, Level error). */
    logDestination?: NodeJS.WritableStream;
    logLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
    /** Phase 10: Lexware-Contract-Fake starten und als aktiven Provider verdrahten. */
    lexware?:
      | boolean
      | {
          rateLimit?: boolean;
          taxType?: 'net' | 'gross' | 'vatfree';
          smallBusiness?: boolean;
          throttle?: 'postgres' | 'noop';
        };
  } = {},
): Promise<TestContext> {
  const lexwareOptions =
    options.lexware === true
      ? {}
      : options.lexware === undefined || options.lexware === false
        ? null
        : options.lexware;
  const lexwareFake =
    lexwareOptions === null
      ? null
      : new FakeLexwareServer({
          rateLimit: lexwareOptions.rateLimit ?? false,
          ...(lexwareOptions.taxType === undefined ? {} : { taxType: lexwareOptions.taxType }),
          ...(lexwareOptions.smallBusiness === undefined
            ? {}
            : { smallBusiness: lexwareOptions.smallBusiness }),
        });
  const lexwareBaseUrl = lexwareFake === null ? null : await lexwareFake.start();
  const config = loadConfig({
    APP_ENV: 'development',
    DATABASE_URL: TEST_DATABASE_URL,
    LOG_LEVEL: options.logLevel ?? 'error',
    ...(lexwareFake === null || lexwareBaseUrl === null
      ? {}
      : {
          LEXWARE_ENABLED: 'true',
          LEXWARE_API_KEY: lexwareFake.apiKey,
          LEXWARE_BASE_URL: lexwareBaseUrl,
          LEXWARE_ORGANIZATION_ID: lexwareFake.organizationId,
          LEXWARE_WEBHOOK_CALLBACK_URL: 'https://test.example/webhooks/lexware',
          LEXWARE_WEBHOOK_PUBLIC_KEY_PEM: lexwareFake.publicKeyPem,
          LEXWARE_REQUEST_TIMEOUT_MS: '2000',
        }),
  });
  // TEST_POOL_MAX=1 macht jede verschachtelte Pool-Akquise unter einer
  // Transaktion als Verbindungs-Timeout sichtbar (Phase-6-Finalisierung A1).
  const envPoolMax = Number(process.env.TEST_POOL_MAX ?? '');
  const poolMax =
    options.poolMax ?? (Number.isInteger(envPoolMax) && envPoolMax > 0 ? envPoolMax : undefined);
  const pool = createPool(config.databaseUrl, poolMax === undefined ? {} : { max: poolMax });
  const db = createDb(pool);
  await runMigrations(db);
  const mail = new InMemoryMailAdapter();
  // Isolierter FS-Storage je Testkontext (PDF-/Dokumententests).
  const storage = new FilesystemStorageProvider(mkdtempSync(join(tmpdir(), 'mietroyal-test-')));
  const accounting = new MockAccountingGateway();
  const notices = new OutboxSettlementNoticeGateway();
  const queue = new PostgresJobQueue(pool);
  const testLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const lexware = createLexwareContext(
    config,
    db,
    testLogger,
    lexwareOptions?.throttle === 'postgres' ? {} : { throttle: new NoopLexwareThrottle() },
  );
  const gateway = lexwareFake === null ? accounting : createAccountingGatewayFor(config, lexware);
  const lexwareConnection = new LexwareConnectionService(lexware);
  const app = buildApp({
    config,
    pool,
    mailAdapter: mail,
    rateLimitEnabled: options.rateLimitEnabled ?? false,
    storage,
    accountingGateway: gateway,
    noticeGateway: notices,
    jobQueue: queue,
    lexwareContext: lexware,
    lexwareConnection,
    ...(options.logDestination === undefined ? {} : { logDestination: options.logDestination }),
  });
  await app.ready();
  const auth = new StaffAuthService(db, config, mail);
  const admin = new StaffAdminService(auth);
  const jobs = new JobRunner(queue, 'test-worker');
  registerFinanceJobHandlers(jobs, {
    db,
    config,
    queue,
    storage,
    accountingGateway: gateway,
    lexware,
    lexwareConnection,
    workerId: 'test-worker',
  });
  const transfersFor = (workerId = 'test-direct') =>
    createAccountingTransferService({
      db,
      queue,
      accountingGateway: gateway,
      lexware,
      lexwareConnection,
      workerId,
    });
  return {
    pool,
    db,
    config,
    app,
    mail,
    auth,
    admin,
    storage,
    accounting,
    notices,
    queue,
    jobs,
    lexware,
    lexwareFake,
    gateway,
    lexwareConnection,
    transfersFor,
  };
}

export async function destroyTestContext(context: TestContext): Promise<void> {
  await context.app.close();
  await context.pool.end();
  if (context.lexwareFake !== null) await context.lexwareFake.stop();
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
