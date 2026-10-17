import { randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import type { AppConfig } from '@mietroyal/config';
import { createDb, pingDatabase } from '@mietroyal/database';
import { RequestValidationError } from '@mietroyal/validation';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import { StaffAdminService } from './auth/admin-service.ts';
import { csrfRejects } from './auth/http.ts';
import { createMailAdapter, type StaffMailPort } from './auth/mail.ts';
import { StaffAuthService } from './auth/service.ts';
import {
  createStorageProvider,
  type StorageProvider,
  JobRunner,
  PostgresJobQueue,
  type JobQueue,
} from '@mietroyal/integrations';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerCommerceRoutes } from './routes/commerce.ts';
import { registerCrmRoutes } from './routes/crm.ts';
import { registerSchedulingRoutes } from './routes/scheduling.ts';
import { registerWarehouseRoutes } from './routes/warehouse.ts';
import { registerHandoverRoutes } from './routes/handover.ts';
import { registerReturnRoutes } from './routes/returns.ts';
import { registerOfflineRoutes } from './routes/offline.ts';
import type { AccountingGateway } from './accounting/gateway.ts';
import {
  createAccountingGatewayFor,
  createAccountingTransferService,
  registerFinanceJobHandlers,
} from './jobs/finance.ts';
import { LexwareConnectionService } from './lexware/connection-service.ts';
import { createLexwareContext, type LexwareContext } from './lexware/context.ts';
import { createLexwareTransferDeps } from './lexware/lexware-gateway.ts';
import { TaxConfigService } from './lexware/tax-config-service.ts';
import { registerAccountingRoutes } from './routes/accounting.ts';
import { registerAccountingTaxRoutes } from './routes/accounting-tax.ts';
import { registerLexwareContactRoutes } from './routes/lexware-contacts.ts';
import { registerCancellationRoutes } from './routes/cancellation.ts';
import { createCancellationService } from './cancellation/cancellation-service.ts';
import { registerSettlementRoutes } from './routes/settlement.ts';
import {
  createSettlementNoticeGateway,
  type SettlementNoticeGateway,
} from './settlement/notice-gateway.ts';
import { createSettlementEnsureListener } from './settlement/return-listener.ts';
import { SettlementService } from './settlement/settlement-service.ts';
import { ProcessService } from './crm/process-service.ts';
import { AssignmentService } from './handover/assignment-service.ts';
import { createRiskRefreshListener } from './handover/risk-refresh-listener.ts';
import { MachineService } from './warehouse/machine-service.ts';
import { registerStaffAdminRoutes } from './routes/staff-admin.ts';
import { registerLexwareAdminRoutes } from './routes/lexware-admin.ts';
import { registerLexwareWebhookRoutes } from './routes/lexware-webhooks.ts';

export const API_VERSION = '0.1.0';

const CORRELATION_ID_HEADER = 'x-correlation-id';
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Pfad fürs Request-Log: Query-Strings enthalten Kundendaten (z. B.
 * Suchbegriffe wie Namen oder Telefonnummern) und werden komplett
 * weggelassen; opake Tokens im Pfad (öffentliche Angebots-Links,
 * Maschinen-QR-Identifier) erscheinen nie im Klartext im Log. Die QR-Routen
 * nehmen den Token seit der Phase-8-Finalisierung (§2) nur noch im Body
 * entgegen; die Maskierung bleibt als Schutz gegen Altclients/Tippfehler
 * (der statische Routenname `resolve` bleibt lesbar).
 */
export function maskLoggedPath(url: string): string {
  const path = url.split('?')[0] ?? url;
  return path
    .replace(/(\/public\/offers\/)[^/]+/, '$1***')
    .replace(/(\/staff\/machines\/qr\/)(?!resolve(?:\/|$))[^/]+/, '$1***')
    .replace(/(\/staff\/returns\/resolve-qr\/)[^/]+/, '$1***');
}

export interface AppOptions {
  config: AppConfig;
  /** Ohne Pool antwortet /ready mit 503 und Auth-Routen fehlen (reine Unit-Tests). */
  pool?: pg.Pool;
  /** Test-Injection für den Mailversand (Default: umgebungsabhängiger Adapter). */
  mailAdapter?: StaffMailPort;
  /** Brute-Force-Limits; in Integrationstests abschaltbar. Default: true. */
  rateLimitEnabled?: boolean;
  /** Test-Injection für den Objektspeicher (Default: laut config.storage). */
  storage?: StorageProvider;
  /**
   * Test-Injection für das Logger-Ziel (pino-Stream), damit Tests das
   * Serverlog auffangen und auf Datenlecks prüfen können (Phase-8-
   * Finalisierung §2). Default: stdout wie bisher.
   */
  logDestination?: NodeJS.WritableStream;
  /** Phase 9: Test-Injection der Buchhaltungsgrenze (Default: Mock außerhalb von production, sonst Disabled). */
  accountingGateway?: AccountingGateway;
  /** Phase 9: Test-Injection des Kundeninformations-Versandwegs (Default: Outbox außerhalb von production). */
  noticeGateway?: SettlementNoticeGateway;
  /** Phase 9: Test-Injection der Job-Queue (Default: PostgresJobQueue auf dem Pool). */
  jobQueue?: JobQueue;
  /** Phase 10: Test-Injection des Lexware-Kontexts (Default: aus config.lexware). */
  lexwareContext?: LexwareContext;
  /** Phase 10: Test-Injection der Verbindungsprüfung (Default: LexwareConnectionService). */
  lexwareConnection?: LexwareConnectionService;
}

/**
 * Einheitliche Fehlerform für alle API-Antworten (PHASE_00_FOUNDATION.md,
 * Nr. 6). Interne Details (Stacktraces, SQL, Pfade) verlassen den Server nie.
 */
interface ErrorBody {
  error: {
    code: string;
    message: string;
    correlationId: string;
    issues?: readonly { path: string; message: string }[];
  };
}

export function buildApp({
  config,
  pool,
  mailAdapter,
  rateLimitEnabled = true,
  storage,
  logDestination,
  accountingGateway,
  noticeGateway,
  jobQueue,
  lexwareContext,
  lexwareConnection,
}: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Phase 10: Lexware-API-Key darf unter keinem Pfad im Log landen (Order §5).
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'apiKey',
          '*.apiKey',
          'config.lexware.apiKey',
          '*.config.lexware.apiKey',
          '*.*.apiKey',
          'lexware.apiKey',
          'headers.authorization',
          '*.headers.authorization',
        ],
        censor: '[REDACTED]',
      },
      // Der Request-Serializer gibt NUR Methode + maskierten Pfad aus –
      // nie Query, Header-Werte oder Bodies (QR-Tokens, Telefonnummern,
      // Base64-Medien reisen im Body und dürfen nie im Log landen).
      serializers: {
        req(request: FastifyRequest) {
          return { method: request.method, url: maskLoggedPath(request.url) };
        },
      },
      ...(logDestination === undefined ? {} : { stream: logDestination }),
    },
    genReqId: (req) => {
      const incoming = req.headers[CORRELATION_ID_HEADER];
      if (typeof incoming === 'string' && CORRELATION_ID_PATTERN.test(incoming)) {
        return incoming;
      }
      return randomUUID();
    },
    // 0 = keinem Proxy vertrauen; hinter dem Staff-Proxy/nginx die Hop-Zahl
    // setzen (API_TRUST_PROXY_HOPS), damit request.ip – und damit das
    // Brute-Force-Limit – die echte Client-IP trifft statt der Proxy-IP.
    // Niemals pauschal true (X-Forwarded-For wäre von Direktaufrufern fälschbar).
    trustProxy:
      config.api.trustProxyHops > 0
        ? (_address: string, hop: number) => hop < config.api.trustProxyHops
        : false,
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header(CORRELATION_ID_HEADER, request.id);
    // Phase 8 (Order §4): API-Antworten (Fachdaten, PDFs, Fotos) landen nie in
    // einem HTTP-/Service-Worker-Cache – Offline-Daten liegen ausschließlich
    // im verschlüsselten lokalen Store.
    if (reply.getHeader('cache-control') === undefined) {
      reply.header('cache-control', 'no-store');
    }
  });

  void app.register(fastifyCookie);
  if (rateLimitEnabled) {
    // global:false – Limits gelten gezielt auf den Auth-Endpunkten.
    // hook 'preHandler': erst nach dem Body-Parsing, damit die keyGeneratoren
    // E-Mail/Challenge aus dem Body in den Limit-Schlüssel aufnehmen können.
    void app.register(fastifyRateLimit, { global: false, hook: 'preHandler' });
  }

  // CSRF-Schutz für zustandsändernde Anfragen (Details: auth/http.ts).
  app.addHook('onRequest', async (request, reply) => {
    if (csrfRejects(request, config.auth.allowedOrigins)) {
      const body: ErrorBody = {
        error: {
          code: 'CSRF_REJECTED',
          message: 'Anfrage aus fremdem Kontext abgelehnt.',
          correlationId: request.id,
        },
      };
      void reply.status(403).send(body);
    }
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ErrorBody = {
      error: {
        code: 'NOT_FOUND',
        message: 'Ressource nicht gefunden',
        correlationId: request.id,
      },
    };
    void reply.status(404).send(body);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RequestValidationError) {
      const body: ErrorBody = {
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message,
          correlationId: request.id,
          issues: error.issues,
        },
      };
      void reply.status(400).send(body);
      return;
    }

    const fastifyError = error as { statusCode?: unknown; code?: unknown; message?: unknown };
    const statusCode = typeof fastifyError.statusCode === 'number' ? fastifyError.statusCode : 500;
    if (statusCode >= 400 && statusCode < 500) {
      // Client-Fehler (z. B. ungültiges JSON, Payload zu groß): Meldung ist
      // von Fastify generiert und enthält keine internen Details.
      const body: ErrorBody = {
        error: {
          code: typeof fastifyError.code === 'string' ? fastifyError.code : 'BAD_REQUEST',
          message:
            typeof fastifyError.message === 'string' ? fastifyError.message : 'Ungültige Anfrage',
          correlationId: request.id,
        },
      };
      void reply.status(statusCode).send(body);
      return;
    }

    // Drizzle verpackt PostgreSQL-Fehler in DrizzleQueryError; der PG-Code
    // steckt dann in error.cause. Beide Formen berücksichtigen.
    const cause = (error as { cause?: unknown }).cause as
      { code?: unknown; constraint?: unknown; table?: unknown } | undefined;
    const pgCode =
      (error as { code?: unknown }).code === '23505' || cause?.code === '23505'
        ? '23505'
        : typeof cause?.code === 'string'
          ? cause.code
          : undefined;

    // Unique-Constraint-Rennen (z. B. doppelte E-Mail/Rollenname parallel):
    // korrektes 409 statt generischem 500.
    if (pgCode === '23505') {
      const body: ErrorBody = {
        error: {
          code: 'CONFLICT',
          message: 'Der Eintrag existiert bereits.',
          correlationId: request.id,
        },
      };
      void reply.status(409).send(body);
      return;
    }

    // Datenbankfehler: DrizzleQueryError trägt das vollständige SQL samt
    // Parametern (= potenziell Kundendaten) in message/query/params – davon
    // wird NICHTS geloggt, nur technische Metadaten.
    if ((error as { query?: unknown }).query !== undefined || pgCode !== undefined) {
      request.log.error(
        {
          // Kein message/stack: beide enthalten bei DrizzleQueryError das
          // vollständige SQL inkl. Parameterwerten.
          dbCode: pgCode ?? null,
          constraint: typeof cause?.constraint === 'string' ? cause.constraint : null,
          table: typeof cause?.table === 'string' ? cause.table : null,
        },
        'Unbehandelter Datenbankfehler',
      );
      const body: ErrorBody = {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Interner Fehler. Bitte später erneut versuchen.',
          correlationId: request.id,
        },
      };
      void reply.status(500).send(body);
      return;
    }

    // Interne Fehler: vollständig loggen, nach außen nur generische Antwort.
    request.log.error({ err: error }, 'Unbehandelter Fehler');
    const body: ErrorBody = {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Interner Fehler. Bitte später erneut versuchen.',
        correlationId: request.id,
      },
    };
    void reply.status(500).send(body);
  });

  if (pool !== undefined) {
    const db = createDb(pool);
    const authService = new StaffAuthService(db, config, mailAdapter ?? createMailAdapter(config));
    const adminService = new StaffAdminService(authService);
    // Als Plugin NACH @fastify/rate-limit registrieren, damit dessen
    // onRoute-Hook die per-Route-Limits der Auth-Endpunkte wirklich anwendet.
    void app.register(async (instance) => {
      registerAuthRoutes(instance, {
        auth: authService,
        config,
        rateLimitEnabled,
      });
      registerStaffAdminRoutes(instance, { auth: authService, admin: adminService, config });
      const storageProvider = storage ?? createStorageProvider(config.storage);
      // Phase 9: Abrechnung/Storno/Buchhaltung – eine Gateway-Grenze, eine
      // Transfer-Boundary, Jobs auf der bestehenden PostgreSQL-Queue.
      // Phase 10: ein Lexware-Kontext je Prozess (Client nur bei aktiver Konfiguration).
      const lexware = lexwareContext ?? createLexwareContext(config, db, app.log);
      const accounting = accountingGateway ?? createAccountingGatewayFor(config, lexware);
      const notices = noticeGateway ?? createSettlementNoticeGateway(config);
      const queue = jobQueue ?? new PostgresJobQueue(pool);
      const connection = lexwareConnection ?? new LexwareConnectionService(lexware);
      const transfers = createAccountingTransferService({
        db,
        queue,
        accountingGateway: accounting,
        lexware,
        lexwareConnection: connection,
      });
      // Eine Storno-Instanz für die Storno-Routen UND die Legacy-Storno-Route
      // (Vorgänge mit bestätigter Buchung werden nur über diesen Pfad storniert).
      const cancellationService = createCancellationService({
        db,
        config,
        storage: storageProvider,
        transfers,
        logger: app.log,
      });
      registerCrmRoutes(instance, { db, auth: authService, config, cancellationService });
      registerCommerceRoutes(instance, {
        db,
        auth: authService,
        config,
        storage: storageProvider,
        rateLimitEnabled,
      });
      // Phase-6-Finalisierung A2: Terminzeitänderungen bewerten die
      // Risikohinweise sofort neu – verdrahtet über die Listener-
      // Schnittstelle der Terminplanung (keine zyklische Modulabhängigkeit).
      const riskRefreshListener = createRiskRefreshListener(
        new AssignmentService(db, new MachineService(db, storageProvider), storageProvider),
      );
      registerSchedulingRoutes(instance, {
        db,
        auth: authService,
        config,
        listeners: [riskRefreshListener],
      });
      registerWarehouseRoutes(instance, {
        db,
        auth: authService,
        config,
        storage: storageProvider,
      });
      registerHandoverRoutes(instance, {
        db,
        auth: authService,
        config,
        storage: storageProvider,
      });
      // Phase 9: nach erfolgreicher Finalisierung (online wie offline-sync)
      // entsteht die Abrechnung – idempotent, außerhalb der Finalisierungs-Transaktion.
      const settlementListener = createSettlementEnsureListener(
        new SettlementService({
          db,
          transfers,
          noticeGateway: notices,
          queue,
          processes: new ProcessService(db),
          appEnv: config.appEnv,
          logger: app.log,
        }),
        app.log,
      );
      registerReturnRoutes(instance, {
        db,
        auth: authService,
        config,
        storage: storageProvider,
        finalizedListeners: [settlementListener],
      });
      registerOfflineRoutes(instance, {
        db,
        auth: authService,
        config,
        storage: storageProvider,
        finalizedListeners: [settlementListener],
      });
      // Nicht gestarteter Runner: verarbeitet Finanz-Jobs nur auf Anforderung
      // der Mock-Steuerung (nicht in production); den Dauerbetrieb übernimmt
      // apps/worker mit denselben Handlern.
      const financeRunner = new JobRunner(queue, `api:${process.pid}`, app.log);
      registerFinanceJobHandlers(financeRunner, {
        db,
        config,
        queue,
        storage: storageProvider,
        accountingGateway: accounting,
        lexware,
        lexwareConnection: connection,
        logger: app.log,
      });
      registerSettlementRoutes(instance, {
        db,
        auth: authService,
        config,
        storage: storageProvider,
        queue,
        accountingGateway: accounting,
        transfers,
        noticeGateway: notices,
      });
      registerCancellationRoutes(instance, {
        db,
        auth: authService,
        config,
        storage: storageProvider,
        queue,
        accountingGateway: accounting,
        transfers,
        cancellationService,
      });
      registerAccountingRoutes(instance, {
        db,
        auth: authService,
        config,
        accountingGateway: accounting,
        transfers,
        jobRunner: financeRunner,
      });
      // Phase 10: Lexware-Integrationsstatus/-aktionen (system.settings) und
      // der öffentliche, signaturgeprüfte Webhook-Endpunkt (Order §§8/44).
      registerLexwareAdminRoutes(instance, { db, auth: authService, config, lexware, transfers });
      // Phase 10 (Agent B): Steuerkonfiguration und Kunde ↔ Lexware-Kontakt.
      registerAccountingTaxRoutes(instance, {
        auth: authService,
        config,
        taxConfig: transfers.lexwareDeps?.taxConfig ?? new TaxConfigService(db, config.appEnv),
      });
      registerLexwareContactRoutes(instance, {
        db,
        auth: authService,
        config,
        connection,
        contacts: transfers.lexwareDeps?.contacts ?? createLexwareTransferDeps(lexware).contacts,
      });
      registerLexwareWebhookRoutes(instance, { db, config, lexware, queue });
    });
  }

  app.get('/health', async () => ({
    status: 'ok',
    version: API_VERSION,
    environment: config.appEnv,
  }));

  app.get('/ready', async (request, reply) => {
    if (pool === undefined) {
      const body: ErrorBody = {
        error: {
          code: 'DATABASE_UNAVAILABLE',
          message: 'Datenbankverbindung nicht konfiguriert',
          correlationId: request.id,
        },
      };
      return reply.status(503).send(body);
    }
    try {
      await pingDatabase(pool);
      return { status: 'ready' };
    } catch (error) {
      request.log.error({ err: error }, 'Readiness-Check fehlgeschlagen');
      const body: ErrorBody = {
        error: {
          code: 'DATABASE_UNAVAILABLE',
          message: 'Datenbank nicht erreichbar',
          correlationId: request.id,
        },
      };
      return reply.status(503).send(body);
    }
  });

  return app;
}
