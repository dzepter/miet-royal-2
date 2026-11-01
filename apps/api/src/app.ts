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
import { assertAccountingGatewayAllowed, type AccountingGateway } from './accounting/gateway.ts';
import {
  createAccountingGatewayFor,
  createAccountingTransferService,
  createVoucherTriggers,
  registerFinanceJobHandlers,
} from './jobs/finance.ts';
import { VoucherService } from './voucher/voucher-service.ts';
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
import { createSettlementEnsureListener } from './settlement/return-listener.ts';
import { SettlementService } from './settlement/settlement-service.ts';
import { ProcessService } from './crm/process-service.ts';
import { AssignmentService } from './handover/assignment-service.ts';
import { createRiskRefreshListener } from './handover/risk-refresh-listener.ts';
import { MachineService } from './warehouse/machine-service.ts';
import { registerStaffAdminRoutes } from './routes/staff-admin.ts';
import { registerLexwareAdminRoutes } from './routes/lexware-admin.ts';
import { registerLexwareWebhookRoutes } from './routes/lexware-webhooks.ts';
// Phase 12 (transactional): Angebot/AB/Protokolle/Kundeninformation/Storno/
// Gutschein/Rechnung über die Mail-Outbox; öffentlicher Dokument-Link.
import {
  createTransactionalMailModule,
  registerTransactionalJobHandlers,
} from './jobs/communication-transactional.ts';
import { registerPublicDocumentRoutes } from './routes/public-documents.ts';
// Phase 12 (mail)
import { createCommunicationContext } from './communication/context.ts';
import { COMMUNICATION_LOG_REDACT_PATHS } from './communication/logging.ts';
import type { OutboundMailGateway } from './communication/types.ts';
import { registerCommunicationJobHandlers } from './jobs/communication.ts';
import { registerCommunicationAdminRoutes } from './routes/communication-admin.ts';
// Phase 12 (push)
import type { PushGateway } from './communication/types.ts';
import { createPushModule, registerPushJobHandlers } from './jobs/communication-push.ts';
import { registerPushRoutes } from './routes/push.ts';
import { registerCalendarFeedRoutes } from './routes/calendar-feed.ts';
// Phase 12 (inbound)
import type { InboundMailSource, WhatsAppGateway } from './communication/types.ts';
import {
  createConversationDeliveryListeners,
  createInboundMailSource,
  createWhatsAppGateway,
  registerInboundJobHandlers,
} from './jobs/communication-inbound.ts';
import { registerConversationRoutes } from './routes/communication-conversation.ts';
import { registerCommunicationInboxRoutes } from './routes/communication-inbox.ts';
import { registerWhatsAppWebhookRoutes } from './routes/whatsapp-webhook.ts';
// Phase 12 (scan)
import {
  createRetentionCompletionListener,
  registerScanDueJobHandlers,
} from './jobs/communication-scan.ts';
import { registerCommunicationActionRoutes } from './routes/communication-actions.ts';
import { enqueuePendingVoucherDeliveries } from './communication/voucher-delivery-job.ts';
import { enqueuePendingInvoiceDeliveries } from './communication/invoice-delivery-job.ts';
import type { RoutingGateway } from './routing/types.ts';
import { createRoutingGateway } from './routing/factory.ts';
// Phase 13 (tours): Touren, Planung, Stale-/Storno-Listener; Adressautorität + Geocoding aus routing/.
import { getDepotAddress, resolveOperativeAddress } from './routing/address-resolver.ts';
import { GeocodingService } from './routing/geocoding-service.ts';
import { registerTourRoutes } from './routes/tours.ts';
import { createTourCancellationListener, createTourStaleListener } from './tours/listeners.ts';
import { TourService } from './tours/tour-service.ts';
import type { OperativeAddressResolver, TourGeocodingResolver } from './tours/types.ts';
// Phase 13 (tours-live): GPS, Verspätungsrisiko, Scanner tour_delay, Offline-Tour-Snapshot.
import { DelayEvaluationState } from './tours/live/delay-state.ts';
import { createTourLiveModule } from './tours/live/module.ts';
import { createOfflineTourSnapshotSource } from './tours/live/offline-snapshot.ts';
import { registerTourLiveRoutes } from './routes/tours-live.ts';
// Phase 14 (demo): Dataset-Zustand, Seed-Registry, Reset-Gate (503) und Demo-Routen – nur in APP_ENV=demo.
import { createDemoModule } from './demo/module.ts';
import { DemoResetService } from './demo/reset-service.ts';
import type { DemoResetRunner } from './demo/types.ts';
// Phase 14 Final (Reset-Barrier): Shared-Lock über jede Business-Mutation (Hooks nach dem Gate).
import { createDemoBarrierHooks, registerDemoBarrierHooks } from './demo/barrier-hooks.ts';
import type { DemoResetBarrier } from './demo/reset-barrier.ts';
import { registerDemoRoutes } from './routes/demo.ts';
// Phase 14 (training): Katalog-Sync beim Start (alle Umgebungen), Recorder nur in demo, Trainings-Routen.
import { registerTrainingRoutes } from './routes/training.ts';
import { TrainingCatalogService } from './training/catalog-sync.ts';
import { createTrainingMailSentListener } from './training/listeners.ts';
import { DemoTrainingEventRecorder, createNoopTrainingRecorder } from './training/recorder.ts';
import { DEMO_RESET_INTERRUPTION_CODE, TrainingService } from './training/training-service.ts';
// Phase 14 (reset): Nachbereinigung alter Demo-Dateien (Job demo.storage_cleanup, Order §22).
import {
  createDemoStorageCleanupHandler,
  installDemoWorkerGuards, // Phase 14 Final (Reset-Barrier): beforeRun + Execution-Guard
  DEMO_STORAGE_CLEANUP_JOB_TYPE,
} from './jobs/demo.ts';
// Phase 14 (training gate): Live-Trainingssperren (Order §56–§66) – erzwungen nur in production,
// konfigurierbar außerhalb demo; Admin-Routen in demo nicht registriert (§68).
import { TrainingGateService } from './training/gate-service.ts';
import { registerTrainingGateRoutes } from './routes/training-gates.ts';

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
  return (
    path
      .replace(/(\/public\/offers\/)[^/]+/, '$1***')
      .replace(/(\/staff\/machines\/qr\/)(?!resolve(?:\/|$))[^/]+/, '$1***')
      .replace(/(\/staff\/returns\/resolve-qr\/)[^/]+/, '$1***')
      // Phase 12 (push): Kalender-Feed-Token (Order §33) nie im Log.
      .replace(/(\/public\/calendar\/)[^/]+/, '$1***')
      // Phase 12 (scan): Kunden-Aktions-Token (Order §20) nie im Log.
      .replace(/(\/public\/actions\/)[^/]+/, '$1***')
      // Phase 12 (transactional): Dokument-Token (Order §13) nie im Log.
      .replace(/(\/public\/documents\/)[^/]+/, '$1***')
  );
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
  /** Phase 9: Test-Injection der Buchhaltungsgrenze (Default: Mock in development/staging, Disabled in demo/production ohne Lexware; Mock in demo/production verboten – Phase 14). */
  accountingGateway?: AccountingGateway;
  /** Phase 9: Test-Injection der Job-Queue (Default: PostgresJobQueue auf dem Pool). */
  jobQueue?: JobQueue;
  /** Phase 10: Test-Injection des Lexware-Kontexts (Default: aus config.lexware). */
  lexwareContext?: LexwareContext;
  /** Phase 10: Test-Injection der Verbindungsprüfung (Default: LexwareConnectionService). */
  lexwareConnection?: LexwareConnectionService;
  /** Phase 12 (mail): Test-Injection des Mail-Gateways (Default: SMTP wenn konfiguriert, sonst Disabled; Fake in production verboten). */
  mailGateway?: OutboundMailGateway;
  /** Phase 12 (push): Test-Injection des Push-Gateways (Default: WebPush bei VAPID-Konfiguration, sonst Disabled; Fake nie in production). */
  pushGateway?: PushGateway;
  /** Phase 12 (inbound): Test-Injection der IMAP-Quelle (Default: aus config.mail.imap, sonst Disabled). */
  inboundMailSource?: InboundMailSource;
  /** Phase 12 (inbound): Test-Injection des WhatsApp-Gateways (Default: nach config.whatsapp.mode; Fake/Mock nie in production). */
  whatsappGateway?: WhatsAppGateway;
  /** Phase 13 (routing): Test-Injection der Routing-Grenze (Default: aus config.routing; Fake/Mock nie in production). */
  routingGateway?: RoutingGateway;
  /** Phase 13 (tours): Test-Injection der Geokodierung (Default: GeocodingService auf dem Routing-Gateway). */
  geocodingResolver?: TourGeocodingResolver;
  /** Phase 13 (tours): Test-Injection der Adressautorität (Default: routing/address-resolver.ts). */
  addressResolver?: OperativeAddressResolver;
  /** Phase 13 (tours-live): Tests – geteiltes Bewertungsgedächtnis und kürzeres GPS-Rate-Limit. */
  tourLiveOptions?: { state?: DelayEvaluationState; locationMinIntervalMs?: number };
  /** Phase 14 (demo): Test-Injection des Reset-Runners (Default: DemoResetService bzw. Stub, nur in demo). */
  demoReset?: DemoResetRunner;
  /** Phase 14 Final (Reset-Barrier): Test-Injection der Barrier (Default: eigene Instanz; `onClose` schließt sie). */
  demoBarrier?: DemoResetBarrier;
  /** Phase 14 (reset fix F6): Test-Injection des Katalog-Syncs (Default: TrainingCatalogService auf db). */
  trainingCatalog?: TrainingCatalogService;
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
  jobQueue,
  lexwareContext,
  lexwareConnection,
  mailGateway,
  pushGateway,
  inboundMailSource,
  whatsappGateway,
  routingGateway,
  geocodingResolver,
  addressResolver,
  tourLiveOptions,
  demoReset,
  demoBarrier, // Phase 14 Final (Reset-Barrier)
  trainingCatalog,
}: AppOptions): FastifyInstance {
  // Phase 13 (routing): production startet nie mit Fake-/Mock-Routing (Order §5).
  if (
    config.appEnv === 'production' &&
    (routingGateway?.kind === 'fake' || routingGateway?.kind === 'mock')
  ) {
    throw new Error('Fake-/Mock-Routing-Gateway ist in production nicht zulässig.');
  }
  // Phase 12 (inbound): production startet nie mit Fake-/Mock-WhatsApp (Order §39).
  if (
    config.appEnv === 'production' &&
    (whatsappGateway?.kind === 'fake' || whatsappGateway?.kind === 'mock')
  ) {
    throw new Error('Fake-/Mock-WhatsApp-Gateway ist in production nicht zulässig.');
  }
  if (config.appEnv === 'production' && inboundMailSource?.kind === 'fake') {
    throw new Error('FakeInboundMailSource ist in production nicht zulässig.');
  }
  // Phase 12 (mail): production startet nie mit einem Fake-Gateway (Pflichttest „Production FakeMail blockiert“).
  if (config.appEnv === 'production' && mailGateway?.kind === 'fake') {
    throw new Error('FakeMailGateway ist in production nicht zulässig.');
  }
  // Phase 12 (push): dito für den Push-Fake (Pflichttest 120).
  if (config.appEnv === 'production' && pushGateway?.kind === 'fake') {
    throw new Error('FakePushGateway ist in production nicht zulässig.');
  }
  // Phase 14 (accounting): demo und production starten nie mit dem Mock-Buchhaltungs-
  // Gateway (Order W1/§29/§96) – auch nicht per Test-Injection; die Fabrik liefert
  // dort Disabled (demo) bzw. Lexware/Disabled (production).
  if (accountingGateway !== undefined) {
    assertAccountingGatewayAllowed(config.appEnv, accountingGateway);
  }
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
          // Phase 12 (mail): SMTP-/IMAP-Passwörter, WhatsApp-/Push-/Communication-Keys.
          ...COMMUNICATION_LOG_REDACT_PATHS,
          // Phase 13 (routing): GraphHopper-API-Key unter keinem Pfad im Log (Order §4/§64).
          'routing.graphhopper.apiKey',
          '*.routing.graphhopper.apiKey',
          'config.routing.graphhopper.apiKey',
          '*.config.routing.graphhopper.apiKey',
          'GRAPHHOPPER_API_KEY',
          '*.GRAPHHOPPER_API_KEY',
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
    // Phase 14 (demo): Demo-Modul nur in der Demo-Umgebung; das Reset-Gate
    // (503 DEMO_RESET für Business-Mutationen während eines Resets, Design §7)
    // hängt als onRequest-Hook auf der Root-Instanz VOR dem Routen-Plugin.
    const demo =
      config.appEnv === 'demo'
        ? createDemoModule({
            db,
            config,
            auth: authService,
            logger: app.log,
            ...(demoReset === undefined ? {} : { reset: demoReset }),
            ...(demoBarrier === undefined ? {} : { barrier: demoBarrier }), // Phase 14 Final
          })
        : null;
    if (demo !== null) app.addHook('onRequest', demo.gate.onRequest);
    // Phase 14 Final (Reset-Barrier, Order §3): NACH dem Gate – Shared-Lock über die gesamte
    // Mutation, ungecachte Zweitprüfung des Flags, Freigabe in allen Antwort-/Abbruchpfaden.
    if (demo !== null) {
      registerDemoBarrierHooks(app, createDemoBarrierHooks(demo.barrier, { logger: app.log }));
      app.addHook('onClose', async () => {
        await demo.barrier.shutdown();
      });
    }
    // Als Plugin NACH @fastify/rate-limit registrieren, damit dessen
    // onRoute-Hook die per-Route-Limits der Auth-Endpunkte wirklich anwendet.
    void app.register(async (instance) => {
      registerAuthRoutes(instance, {
        auth: authService,
        config,
        rateLimitEnabled,
      });
      registerStaffAdminRoutes(instance, { auth: authService, admin: adminService, config });
      // Phase 14 (training gate): eine Gate-Instanz für Online-Routen und Offline-Sync – prüft
      // jede Anfrage frisch gegen die Datenbank (kein Cache, kein Systemadmin-Bypass, §59/§65).
      // Phase 14 (reset fix F6): Katalog-Sync fail-soft beim Start, Lazy Retry beim ersten
      // Trainingszugriff (Routen und Gate) – die API startet auch ohne erreichbare Datenbank.
      const catalogSync = trainingCatalog ?? new TrainingCatalogService(db, { logger: app.log });
      const trainingGate = new TrainingGateService(db, config, { catalog: catalogSync });
      // Phase 14 (training): Recorder nur in demo (sonst Noop, Order §43); Service und
      // Katalog-Sync in ALLEN Umgebungen (stabile Keys, §69/§70) – der Sync läuft beim Start
      // (`onReady`) fail-soft (Review-Fix F6: Log nur Fehlerklasse, Retry beim ersten Zugriff).
      const trainingRecorder =
        config.appEnv === 'demo'
          ? new DemoTrainingEventRecorder(db, { logger: app.log })
          : createNoopTrainingRecorder();
      const trainingService = new TrainingService({
        db,
        environment: config.appEnv,
        seedEntities: demo === null ? undefined : (seedKey) => demo.registry.resolve(seedKey),
      });
      instance.addHook('onReady', async () => {
        try {
          await catalogSync.ensureSynced();
        } catch (error) {
          // Review-Fix F6: kein Startabbruch – /ready meldet die Datenbank wie bisher als 503.
          app.log.warn(
            { errorName: error instanceof Error ? error.name : 'Error' },
            'Trainingskatalog beim Start nicht synchronisiert – erneuter Versuch beim ersten Zugriff',
          );
        }
      });
      registerTrainingRoutes(instance, {
        db,
        auth: authService,
        config,
        training: trainingService,
        catalog: catalogSync, // Phase 14 (reset fix F6)
        gateStatus: (userId) => trainingGate.statusForUser(userId),
      });
      const storageProvider = storage ?? createStorageProvider(config.storage);
      // Phase 9: Abrechnung/Storno/Buchhaltung – eine Gateway-Grenze, eine
      // Transfer-Boundary, Jobs auf der bestehenden PostgreSQL-Queue.
      // Phase 10: ein Lexware-Kontext je Prozess (Client nur bei aktiver Konfiguration).
      const lexware = lexwareContext ?? createLexwareContext(config, db, app.log);
      const accounting = accountingGateway ?? createAccountingGatewayFor(config, lexware);
      const queue = jobQueue ?? new PostgresJobQueue(pool);
      // Phase 12 (mail): Kommunikationsschicht (Outbox, Gateway, Krypto) – eine
      // Komposition für API und Worker; mail.send läuft im Finanz-Runner (unten).
      const communication = createCommunicationContext(config, db, queue, {
        gateway: mailGateway,
        storage: storageProvider,
        logger: app.log,
      });
      const connection = lexwareConnection ?? new LexwareConnectionService(lexware);
      // Phase 11: Gutschein-Trigger (Zahlung → paid, Reinigungsende) reihen
      // nur Jobs auf die PostgreSQL-Queue ein; Entscheidung im VoucherService.
      const voucherTriggers = createVoucherTriggers({ db, queue, logger: app.log });
      const voucherService = new VoucherService(db, config, app.log);
      const transfers = createAccountingTransferService({
        db,
        queue,
        accountingGateway: accounting,
        lexware,
        lexwareConnection: connection,
        paymentStatusListeners: [voucherTriggers.paymentStatusListener],
      });
      // Phase 12 (transactional): fachliche Auslöser auf die Mail-Outbox
      // (Order §§11–16) – registriert Sent-/Failed-Listener + Rechnungsabruf.
      const transactional = createTransactionalMailModule({
        communication,
        db,
        config,
        queue,
        lexware,
        transfers,
        logger: app.log,
      });
      // Phase 12 (scan): Vorgangsabschluss ⇒ Retention-Job für Chatfotos (Order §25).
      // Phase 12 (retention-final): derselbe Listener auch für „storniert“ (beide Wege).
      const retentionListener = createRetentionCompletionListener(queue, app.log);
      // Eine Storno-Instanz für die Storno-Routen UND die Legacy-Storno-Route
      // (Vorgänge mit bestätigter Buchung werden nur über diesen Pfad storniert).
      // Phase 13 (tours): Storno ⇒ Stopps stornierter Termine operativ übersprungen
      // (Nach-Commit-Listener, Order §36); der Service braucht nur die DB.
      const tourService = new TourService(db);
      const tourCancellationListener = createTourCancellationListener(tourService);
      const cancellationService = createCancellationService({
        db,
        config,
        storage: storageProvider,
        transfers,
        confirmations: transactional.cancellationMailer, // Phase 12 (transactional)
        logger: app.log,
        processListeners: [retentionListener, tourCancellationListener], // Phase 12 (retention-final), Phase 13 (tours)
      });
      registerCrmRoutes(instance, {
        db,
        auth: authService,
        config,
        cancellationService,
        vouchers: voucherService,
        processCompletionListeners: [retentionListener],
        voucherDelivery: { queue }, // Phase 12 (transactional)
      });
      registerCommerceRoutes(instance, {
        db,
        auth: authService,
        config,
        storage: storageProvider,
        rateLimitEnabled,
        // Phase 12 (transactional): Angebot/AB über die Mail-Outbox.
        offerGateway: transactional.offerGateway,
        mailOutbox: communication.outbox,
        trainingGate, // Phase 14 (training gate)
        trainingRecorder, // Phase 14 (training)
      });
      // Phase 12 (transactional): öffentlicher Dokument-Link (Order §13).
      registerPublicDocumentRoutes(instance, {
        config,
        documentLinks: transactional.documentLinks,
        rateLimitEnabled,
      });
      // Phase-6-Finalisierung A2: Terminzeitänderungen bewerten die
      // Risikohinweise sofort neu – verdrahtet über die Listener-
      // Schnittstelle der Terminplanung (keine zyklische Modulabhängigkeit).
      const riskRefreshListener = createRiskRefreshListener(
        new AssignmentService(db, new MachineService(db, storageProvider), storageProvider),
      );
      // Phase 13 (routing): eine Gateway-Instanz je Prozess (Order §2); die
      // Fabrik entscheidet nach config.routing (production: nur graphhopper|disabled).
      // Phase 13 Final (routing): globale Drossel in integration_rate_limits (API + Worker teilen die Zeile).
      const routing: RoutingGateway =
        routingGateway ?? createRoutingGateway(config, app.log, { db });
      // Phase 13 (tours): Tour-Listener werden in registerTourRoutes (Agent TOUR) erzeugt und
      // hier an die Terminplanung gehängt – Einfügepunkt, nicht entfernen.
      const schedulingListeners = [riskRefreshListener, createTourStaleListener(tourService)];
      registerSchedulingRoutes(instance, {
        db,
        auth: authService,
        config,
        listeners: schedulingListeners,
      });
      // Phase 13 (tours): Tour-Routen (Design §8) – Adressautorität + Geocoding aus routing/.
      // Phase 13 (tours-live): dieselben Instanzen für Live-Modul/Offline-Snapshot; das
      // Bewertungsgedächtnis entsteht vor den Routen (die View liest daraus).
      const tourGeocoding = geocodingResolver ?? new GeocodingService(db, routing, app.log);
      const tourAddresses = addressResolver ?? { resolveOperativeAddress, getDepotAddress };
      const tourDelayState = tourLiveOptions?.state ?? new DelayEvaluationState();
      registerTourRoutes(instance, {
        db,
        auth: authService,
        config,
        tours: tourService,
        routing,
        geocoding: tourGeocoding,
        addresses: tourAddresses,
        delay: tourDelayState,
        trainingGate, // Phase 14 (training gate)
        trainingRecorder, // Phase 14 (training)
      });
      registerWarehouseRoutes(instance, {
        db,
        auth: authService,
        config,
        storage: storageProvider,
        cleaningEndedListener: voucherTriggers.cleaningEndedListener,
        trainingGate, // Phase 14 (training gate)
        trainingRecorder, // Phase 14 (training)
      });
      registerHandoverRoutes(instance, {
        db,
        auth: authService,
        config,
        storage: storageProvider,
        cleaningEndedListener: voucherTriggers.cleaningEndedListener,
        packetMailer: transactional.packetMailer, // Phase 12 (transactional)
        trainingGate, // Phase 14 (training gate)
        trainingRecorder, // Phase 14 (training)
      });
      // Phase 9: nach erfolgreicher Finalisierung (online wie offline-sync)
      // entsteht die Abrechnung – idempotent, außerhalb der Finalisierungs-Transaktion.
      const settlementListener = createSettlementEnsureListener(
        new SettlementService({
          db,
          transfers,
          notices: transactional.noticeMailer, // Phase 12 (transactional)
          queue,
          processes: new ProcessService(db, [retentionListener]), // Phase 12 (scan)
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
        cleaningEndedListener: voucherTriggers.cleaningEndedListener,
        packetMailer: transactional.packetMailer, // Phase 12 (transactional)
        trainingGate, // Phase 14 (training gate)
        trainingRecorder, // Phase 14 (training)
      });
      registerOfflineRoutes(instance, {
        db,
        auth: authService,
        config,
        storage: storageProvider,
        finalizedListeners: [settlementListener],
        cleaningEndedListener: voucherTriggers.cleaningEndedListener,
        packetMailer: transactional.packetMailer, // Phase 12 (transactional)
        // Phase 13 (tours-live, Order §46): eigene aktive Tour im Offline-Paket (ohne GPS).
        tourSnapshots: createOfflineTourSnapshotSource({
          db,
          tours: tourService,
          addresses: tourAddresses,
          geocoding: tourGeocoding,
        }),
        trainingGate, // Phase 14 (training gate)
        trainingRecorder, // Phase 14 (training)
        // Phase 14 (offline epoch, Order §91/§92): Dataset-Epoch nur in demo (sonst null).
        datasetEpochProvider: demo === null ? undefined : () => demo.dataset.datasetEpoch(),
      });
      // Nicht gestarteter Runner: verarbeitet Finanz-Jobs nur auf Anforderung
      // der Mock-Steuerung (nicht in production); den Dauerbetrieb übernimmt
      // apps/worker mit denselben Handlern.
      const financeRunner = new JobRunner(queue, `api:${process.pid}`, app.log);
      // Phase 14 (reset fix F2): derselbe Demo-Guard wie im Worker (Order §21) – während eines
      // Resets werden Jobs zurückgelegt, Jobs des alten Datensatzes ohne Ausführung als
      // dead/DEMO_DATASET_CHANGED beendet; nur in demo (run-due-jobs ist dort erreichbar).
      // Phase 14 Final (Reset-Barrier): zusätzlich Shared-Lock über den ganzen Handler (Execution-Guard).
      if (config.appEnv === 'demo' && demo !== null) {
        installDemoWorkerGuards(financeRunner, { db, barrier: demo.barrier, logger: app.log });
      }
      registerFinanceJobHandlers(financeRunner, {
        db,
        config,
        queue,
        storage: storageProvider,
        accountingGateway: accounting,
        lexware,
        lexwareConnection: connection,
        logger: app.log,
        paymentStatusListeners: [voucherTriggers.paymentStatusListener],
      });
      // Phase 12 (mail): mail.send im selben Runner (Kontext siehe oben bei der Queue).
      registerCommunicationJobHandlers(financeRunner, { communication });
      // Phase 12 (transactional): voucher.delivery + invoice.delivery (Order §37).
      registerTransactionalJobHandlers(financeRunner, {
        communication,
        db,
        config,
        logger: app.log,
      });
      // Phase 12 (inbound): IMAP-Eingang, WhatsApp (Webhook, Antworten, Medien),
      // Konversation je Vorgang, Unmatched-Inbox; Zustellstatus-Spiegelung.
      const inboundSource = inboundMailSource ?? createInboundMailSource(config);
      const whatsapp = whatsappGateway ?? createWhatsAppGateway(config);
      registerInboundJobHandlers(financeRunner, {
        db,
        config,
        queue,
        storage: storageProvider,
        inboundMailSource: inboundSource,
        whatsappGateway: whatsapp,
        logger: app.log,
        trainingRecorder, // Phase 14 (training): WhatsApp-Antwort zählt erst mit `sent`
      });
      const conversationListeners = createConversationDeliveryListeners(db, storageProvider);
      communication.addMailSentListener(conversationListeners.sent);
      // Phase 14 (training): Mail-Antwort (manual_customer_reply) zählt erst mit bestätigtem Versand.
      communication.addMailSentListener(createTrainingMailSentListener(trainingRecorder));
      communication.addMailFailedListener(conversationListeners.failed);
      registerConversationRoutes(instance, {
        db,
        auth: authService,
        config,
        storage: storageProvider,
        queue,
        whatsappGateway: whatsapp,
        mailOutbox: communication.outbox,
      });
      registerCommunicationInboxRoutes(instance, {
        db,
        auth: authService,
        config,
        storage: storageProvider,
      });
      registerWhatsAppWebhookRoutes(instance, {
        db,
        config,
        queue,
        storage: storageProvider,
        rateLimitEnabled,
      });
      registerCommunicationAdminRoutes(instance, {
        db,
        auth: authService,
        config,
        communication,
      });
      // Phase 12 (push): Web Push (Subscriptions, Versandjob push.send, Regeln
      // für communication.scan_due) und privater ICS-Feed.
      const pushModule = createPushModule(
        {
          db,
          config,
          queue,
          logger: app.log,
          ...(pushGateway === undefined ? {} : { gateway: pushGateway }),
        },
        authService,
      );
      registerPushJobHandlers(financeRunner, {
        db,
        subscriptions: pushModule.subscriptions,
        gateway: pushModule.gateway,
        logger: app.log,
      });
      registerPushRoutes(instance, {
        auth: authService,
        config,
        subscriptions: pushModule.subscriptions,
        gateway: pushModule.gateway,
      });
      registerCalendarFeedRoutes(instance, { db, auth: authService, config, rateLimitEnabled });
      // Phase 13 (tours-live): GPS-/Delay-Routen, Offline-Tour-Snapshot, Scanner tour_delay
      // (Push über die Phase-12-Outbox; Provider nur über das Routing-Gateway).
      const tourLive = createTourLiveModule({
        db,
        tours: tourService,
        routing,
        geocoding: tourGeocoding,
        addresses: tourAddresses,
        push: pushModule.push,
        auth: authService,
        logger: app.log,
        state: tourDelayState,
        locationMinIntervalMs: tourLiveOptions?.locationMinIntervalMs,
      });
      registerTourLiveRoutes(instance, {
        db,
        auth: authService,
        config,
        tours: tourService,
        live: tourLive,
      });
      // Phase 12 (scan): zentraler communication.scan_due (Erinnerungen 7d/1d,
      // Push-Regeln, Outbox-/Retention-Backstop), cleanup_retention, Aktionslinks,
      // Terminänderungs-Mail – dieselben Handler im Worker.
      const scanModule = registerScanDueJobHandlers(financeRunner, {
        db,
        config,
        queue,
        storage: storageProvider,
        communication,
        scanners: [
          { name: 'push_rules', scanDue: (now) => pushModule.rules.scanDue(now) },
          // Gutschein-Sweep (Agent T): pending Gutscheinmails ohne Zustellung nachreihen.
          {
            name: 'voucher_sweep',
            scanDue: (now) => enqueuePendingVoucherDeliveries({ db, queue, now, config }),
          },
          // Rechnungs-Sweep (Phase 12 §16): vor der Mailkonfiguration entstandene Rechnungen nachreihen.
          {
            name: 'invoice_sweep',
            scanDue: (now) => enqueuePendingInvoiceDeliveries({ db, queue, now, config }),
          },
          // Phase 13 (tours-live): Verspätungsbewertung aktiver Touren mit frischem Standort.
          tourLive.scanner,
        ],
        logger: app.log,
      });
      registerCommunicationActionRoutes(instance, {
        db,
        auth: authService,
        config,
        rateLimitEnabled,
        actionLinks: scanModule.actionLinks,
        appointmentInfo: scanModule.appointmentInfo,
      });
      registerSettlementRoutes(instance, {
        db,
        auth: authService,
        config,
        storage: storageProvider,
        queue,
        accountingGateway: accounting,
        transfers,
        notices: transactional.noticeMailer, // Phase 12 (transactional)
        trainingGate, // Phase 14 (training gate)
        trainingRecorder, // Phase 14 (training)
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
      // Phase 14 (demo): Status/Registry/Reset (demo.manage) – nur in demo registriert, sonst 404.
      // Der echte Reset-Runner braucht Storage und Queue, die erst hier existieren;
      // Tests injizieren `demoReset`, sonst wird der Stub aus createDemoModule ersetzt.
      if (demo !== null) {
        if (demoReset === undefined) {
          demo.reset = new DemoResetService({
            db,
            // Phase 14 Final (Reset-Barrier): Lauf-Lock und Exclusive-Barrier auf dem Lock-Pool der Barrier.
            barrier: demo.barrier,
            config,
            storage: storageProvider,
            queue,
            logger: app.log,
            routingGateway: routing,
            ...(mailGateway === undefined ? {} : { mailGateway }),
            // Phase 14 (training, Order §94): laufende Versuche vor dem Löschen unterbrechen (nie löschen).
            hooks: {
              beforeBusinessWipe: async (tx) => {
                await trainingService.interruptAllInProgress(tx, {
                  code: DEMO_RESET_INTERRUPTION_CODE,
                  now: new Date(),
                });
              },
            },
          });
        }
        // Phase 14 (reset, Order §22): Storage-Nachbereinigung auch im API-Runner (Mock-Steuerung/Tests).
        financeRunner.register(
          DEMO_STORAGE_CLEANUP_JOB_TYPE,
          createDemoStorageCleanupHandler(storageProvider, { logger: app.log }),
        );
        registerDemoRoutes(instance, { db, auth: authService, config, demo });
      }
      // Phase 14 (training gate): Verwaltung der Live-Sperren/Freigaben (training.manage) –
      // nur außerhalb demo (§67/§68); diese Routen werden nie gegated (§98).
      if (config.appEnv !== 'demo') {
        // Phase 14 (reset fix F6): Katalog vor den Gate-Verwaltungsrouten sicherstellen.
        registerTrainingGateRoutes(instance, {
          db,
          auth: authService,
          config,
          catalog: catalogSync,
        });
      }
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
