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
import {
  DEVICE_COOKIE_NAME_DEVELOPMENT,
  DEVICE_COOKIE_NAME_HOST_PREFIXED,
} from '../src/auth/device.ts';
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
// Phase 12 (transactional)
import {
  createTransactionalMailModule,
  registerTransactionalJobHandlers,
  type TransactionalMailModule,
} from '../src/jobs/communication-transactional.ts';
// Phase 12 (mail)
import {
  createCommunicationContext,
  type CommunicationContext,
} from '../src/communication/context.ts';
import { FakeMailGateway } from '../src/communication/mail/gateways.ts';
import { registerCommunicationJobHandlers } from '../src/jobs/communication.ts';
// Phase 12 (push)
import { FakePushGateway } from '../src/communication/push/gateways.ts';
import { PushSubscriptionService } from '../src/communication/push/subscription-service.ts';
import { registerPushJobHandlers } from '../src/jobs/communication-push.ts';
// Phase 12 (inbound)
import { FakeInboundMailSource } from '../src/communication/inbound/sources.ts';
import { FakeWhatsAppGateway } from '../src/communication/whatsapp/gateways.ts';
import {
  createConversationDeliveryListeners,
  registerInboundJobHandlers,
} from '../src/jobs/communication-inbound.ts';
// Phase 12 (scan)
import { createPushModule } from '../src/jobs/communication-push.ts';
import { registerScanDueJobHandlers, type ScanModule } from '../src/jobs/communication-scan.ts';
import { enqueuePendingVoucherDeliveries } from '../src/communication/voucher-delivery-job.ts';
import { enqueuePendingInvoiceDeliveries } from '../src/communication/invoice-delivery-job.ts';

// Phase 12 (inbound): feste Test-Geheimnisse (nur Tests; nie echte Werte).
const WHATSAPP_TEST_ACCESS_TOKEN = 'test-whatsapp-access-token-never-real';
const WHATSAPP_TEST_APP_SECRET = 'test-whatsapp-app-secret-0123456789';
const WHATSAPP_TEST_VERIFY_TOKEN = 'test-whatsapp-verify-token-0123456789';

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
  /** Phase 12 (transactional): fachliche Mail-Auslöser des Test-Runners (Angebot/AB-Gateway, Mailer, Dokument-Links). */
  transactional: TransactionalMailModule;
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
  /** Phase 12 (mail): Contract-Fake des Mailversands (zeichnet auf, simuliert Ergebnisse). */
  mailGateway: FakeMailGateway;
  /** Phase 12 (mail): Kommunikationskontext des Test-Runners (Outbox, Krypto, Listener-Registrierung). */
  communication: CommunicationContext;
  /** Phase 12 (push): Contract-Fake des Push-Gateways (Sendungen abfragbar, Verhalten je Endpoint). */
  push: FakePushGateway;
  /** Phase 12 (inbound): Contract-Fake des WhatsApp-Gateways (Requests, 429/Fehler, Medien-Fixtures). */
  whatsapp: FakeWhatsAppGateway;
  /** Phase 12 (inbound): Fake-IMAP-Quelle (RFC-822-Fixtures einstellen, `jobs.drain()` pollt). */
  inboundMail: FakeInboundMailSource;
  /** Phase 12 (inbound): Webhook-Geheimnisse der Live-Testkonfiguration (nur mit `whatsapp: true`). */
  whatsappSecrets: { appSecret: string; verifyToken: string } | null;
  /** Phase 12 (scan): Erinnerungen, Aktionslinks, Retention, Scan-Lauf (`scan.runOnce(now)`) des Test-Runners. */
  scan: ScanModule;
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
    /** Phase 12 (mail): zusätzliche Umgebungsvariablen (z. B. MAIL_PUBLIC_WEB_BASE_URL, MAIL_DEMO_WHITELIST). */
    env?: Record<string, string>;
    /** Phase 12 (inbound): WhatsApp als `live` konfigurieren (Webhook-Signatur/Verify prüfbar; Gateway bleibt der Fake). */
    whatsapp?: boolean;
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
    ...(options.whatsapp === true
      ? {
          WHATSAPP_ENABLED: 'true',
          WHATSAPP_ACCESS_TOKEN: WHATSAPP_TEST_ACCESS_TOKEN,
          WHATSAPP_PHONE_NUMBER_ID: '100000000000001',
          WHATSAPP_BUSINESS_ACCOUNT_ID: '200000000000001',
          WHATSAPP_APP_SECRET: WHATSAPP_TEST_APP_SECRET,
          WHATSAPP_VERIFY_TOKEN: WHATSAPP_TEST_VERIFY_TOKEN,
          WHATSAPP_BASE_URL: 'http://127.0.0.1:9/graph-never-called',
        }
      : {}),
    ...(options.env ?? {}),
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
  const mailGateway = new FakeMailGateway();
  const push = new FakePushGateway(); // Phase 12 (push)
  const whatsapp = new FakeWhatsAppGateway(); // Phase 12 (inbound)
  const inboundMail = new FakeInboundMailSource(config.mail.imap?.folder ?? 'INBOX');
  const app = buildApp({
    config,
    pool,
    mailAdapter: mail,
    rateLimitEnabled: options.rateLimitEnabled ?? false,
    storage,
    accountingGateway: gateway,
    jobQueue: queue,
    lexwareContext: lexware,
    lexwareConnection,
    mailGateway,
    pushGateway: push,
    whatsappGateway: whatsapp,
    inboundMailSource: inboundMail,
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
  // Phase 12 (mail): derselbe Fake wie in der App; mail.send läuft über ctx.jobs.
  const communication = createCommunicationContext(config, db, queue, {
    gateway: mailGateway,
    storage,
    logger: testLogger,
  });
  registerCommunicationJobHandlers(jobs, { communication });
  // Phase 12 (push): push.send im Test-Runner wie im Worker (Fake-Gateway der App).
  registerPushJobHandlers(jobs, {
    db,
    subscriptions: new PushSubscriptionService(db),
    gateway: push,
  });
  // Phase 12 (inbound): mail.inbound_poll / whatsapp.* im Test-Runner mit denselben Fakes wie die App.
  registerInboundJobHandlers(jobs, {
    db,
    config,
    queue,
    storage,
    inboundMailSource: inboundMail,
    whatsappGateway: whatsapp,
  });
  const conversationListeners = createConversationDeliveryListeners(db, storage);
  communication.addMailSentListener(conversationListeners.sent);
  communication.addMailFailedListener(conversationListeners.failed);
  // Phase 12 (scan): communication.scan_due / cleanup_retention im Test-Runner
  // (Push-Regeln über ein eigenes Push-Modul mit demselben Fake-Gateway).
  const testPushModule = createPushModule({ db, config, queue, gateway: push }, auth);
  const scan = registerScanDueJobHandlers(jobs, {
    db,
    config,
    queue,
    storage,
    communication,
    scanners: [
      { name: 'push_rules', scanDue: (now) => testPushModule.rules.scanDue(now) },
      {
        name: 'voucher_sweep',
        scanDue: (now) => enqueuePendingVoucherDeliveries({ db, queue, now, config }),
      },
      // Rechnungs-Sweep (Phase 12 §16): vor der Mailkonfiguration entstandene Rechnungen nachreihen.
      {
        name: 'invoice_sweep',
        scanDue: (now) => enqueuePendingInvoiceDeliveries({ db, queue, now, config }),
      },
    ],
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
  // Phase 12 (transactional): Listener (AB/Pakete/Kundeninformation/Storno/
  // Gutschein/Rechnung) + voucher.delivery/invoice.delivery im Test-Runner.
  const transactional = createTransactionalMailModule({
    communication,
    db,
    config,
    queue,
    lexware,
    transfers: transfersFor('test-listener'),
    logger: testLogger,
  });
  registerTransactionalJobHandlers(jobs, { communication, db, config, logger: testLogger });
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
    transactional,
    queue,
    jobs,
    lexware,
    lexwareFake,
    gateway,
    lexwareConnection,
    transfersFor,
    mailGateway,
    communication,
    push,
    whatsapp,
    inboundMail,
    whatsappSecrets:
      options.whatsapp === true
        ? { appSecret: WHATSAPP_TEST_APP_SECRET, verifyToken: WHATSAPP_TEST_VERIFY_TOKEN }
        : null,
    scan,
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
     staff_known_devices, staff_permission_explanations, staff_users CASCADE`,
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
  /**
   * Phase-12-Finalisierung (Geräteidentität): `mr_staff_device=<wert>` (bzw.
   * `__Host-mr_staff_device=<wert>` außerhalb development) wie
   * ihn der Browser danach hält – vom Server gesetzt oder (ohne Set-Cookie)
   * der mitgeschickte Wert; '' = kein Geräte-Cookie. Für „gleiches Gerät“ an
   * den nächsten `login(…, { deviceCookie })` weiterreichen.
   */
  deviceCookie: string;
  body: Record<string, unknown>;
  statusCode: number;
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36';

export async function login(
  app: FastifyInstance,
  email: string,
  password: string,
  userAgent = DEFAULT_UA,
  // Phase-12-Finalisierung: bestimmtes Geräte-Cookie mitschicken (`mr_staff_device=…`).
  options: { deviceCookie?: string } = {},
): Promise<LoginResult> {
  const deviceCookie = options.deviceCookie ?? '';
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
    headers: { 'user-agent': userAgent, ...(deviceCookie === '' ? {} : { cookie: deviceCookie }) },
  });
  const setCookie = response.cookies.find((c) => c.name === 'mr_staff_session');
  // Phase 12 (finale Geräteidentität): Name je Umgebung der App (development
  // ohne, sonst mit `__Host-`-Präfix) – der Helfer übernimmt, was gesetzt wurde.
  const setDevice = response.cookies.find(
    (c) => c.name === DEVICE_COOKIE_NAME_DEVELOPMENT || c.name === DEVICE_COOKIE_NAME_HOST_PREFIXED,
  );
  return {
    cookie: setCookie === undefined ? '' : `mr_staff_session=${setCookie.value}`,
    deviceCookie: setDevice === undefined ? deviceCookie : `${setDevice.name}=${setDevice.value}`,
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
