import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { JobQueue, JobRunnerLogger, StorageProvider } from '@mietroyal/integrations';
import { createMailAdapter, type StaffMailPort } from '../../auth/mail.ts';
import { StaffAuthService } from '../../auth/service.ts';
import { OrderConfirmationService } from '../../commerce/confirmation-service.ts';
import { DocumentService } from '../../commerce/document-service.ts';
import { InquiryService } from '../../commerce/inquiry-service.ts';
import { OfferService } from '../../commerce/offer-service.ts';
import { ProductService } from '../../commerce/product-service.ts';
import { TermsService } from '../../commerce/terms-service.ts';
import { ConversationService } from '../../communication/conversation/conversation-service.ts';
import {
  createCommunicationContext,
  type CommunicationContext,
} from '../../communication/context.ts';
import type { MailOutboxService } from '../../communication/mail/outbox.ts';
import type { OutboundMailGateway } from '../../communication/types.ts';
import { CustomerService } from '../../crm/customer-service.ts';
import { ProcessService } from '../../crm/process-service.ts';
import { AssignmentService } from '../../handover/assignment-service.ts';
import { HandoverService } from '../../handover/handover-service.ts';
import { createRiskRefreshListener } from '../../handover/risk-refresh-listener.ts';
import { createRetentionCompletionListener } from '../../jobs/communication-scan.ts';
import {
  createTransactionalMailModule,
  type TransactionalMailModule,
} from '../../jobs/communication-transactional.ts';
import {
  assertAccountingGatewayAllowed,
  createAccountingGatewayFor,
  createAccountingTransferService,
  createLexwareContext,
  createVoucherTriggers,
} from '../../jobs/finance.ts';
import { pdfEnvironmentLabel } from '../../documents/environment-label.ts'; // Phase 14 (reset)
import { DamageService } from '../../returns/damage-service.ts';
import { ReturnService } from '../../returns/return-service.ts';
import { getDepotAddress, resolveOperativeAddress } from '../../routing/address-resolver.ts';
import { createRoutingGateway } from '../../routing/factory.ts';
import { GeocodingService } from '../../routing/geocoding-service.ts';
import type { RoutingGateway } from '../../routing/types.ts';
import { SchedulingService } from '../../scheduling/scheduling-service.ts';
import { createSettlementEnsureListener } from '../../settlement/return-listener.ts';
import { SettlementService } from '../../settlement/settlement-service.ts';
import { createTourStaleListener } from '../../tours/listeners.ts';
import { PlanningService } from '../../tours/planning-service.ts';
import { TourService } from '../../tours/tour-service.ts';
import { InventoryService } from '../../warehouse/inventory-service.ts';
import { MachineService } from '../../warehouse/machine-service.ts';

/**
 * Phase 14 (Order §10, Code-Map B §0): Die Fachservices, über die der Demo-Seed
 * AUSSCHLIESSLICH arbeitet – dieselben Konstruktoren und dieselbe Verdrahtung
 * wie `app.ts`/die Routen (Mail-Outbox, Gutschein-Trigger, Abrechnungs-Hook
 * nach der Rückgabe, Risiko-/Tour-Listener der Terminplanung). Keine Fachlogik
 * wird dupliziert; der Seed ruft nur diese Instanzen.
 */
export interface DemoSeedServices {
  auth: StaffAuthService;
  customers: CustomerService;
  processes: ProcessService;
  inquiries: InquiryService;
  products: ProductService;
  terms: TermsService;
  documents: DocumentService;
  offers: OfferService;
  confirmations: OrderConfirmationService;
  /** Terminplanung MIT Listenern (Risikohinweise, Tour-Stale) – wie die Scheduling-Routen. */
  scheduling: SchedulingService;
  machines: MachineService;
  assignments: AssignmentService;
  inventory: InventoryService;
  damages: DamageService;
  handover: HandoverService;
  /** Rückgabe MIT Abrechnungs-Hook (Settlement nach Finalisierung) – wie app.ts. */
  returns: ReturnService;
  settlements: SettlementService;
  conversations: ConversationService;
  outbox: MailOutboxService;
  tours: TourService;
  planning: PlanningService;
  routing: RoutingGateway;
  communication: CommunicationContext;
  transactional: TransactionalMailModule;
}

export interface DemoSeedServiceDeps {
  db: Database;
  config: AppConfig;
  storage: StorageProvider;
  queue: JobQueue;
  logger?: JobRunnerLogger | undefined;
  /** Test-Injection (FakeMailGateway); Default: Gateway laut Konfiguration (in demo ohne SMTP ⇒ disabled). */
  mailGateway?: OutboundMailGateway | undefined;
  /** Test-Injection des Routing-Gateways; Default: laut Konfiguration (demo ⇒ Mock). */
  routingGateway?: RoutingGateway | undefined;
  /** Mail-Port des Auth-Services (nur für Konstruktor-Pflicht; der Seed versendet keine Staff-Mails). */
  staffMail?: StaffMailPort | undefined;
}

export function createDemoSeedServices(deps: DemoSeedServiceDeps): DemoSeedServices {
  const { db, config, storage, queue } = deps;
  const logger = deps.logger;
  const auth = new StaffAuthService(db, config, deps.staffMail ?? createMailAdapter(config));
  // Buchhaltung/Lexware wie app.ts – Phase 14 (accounting), Order W1/§24/§29: die
  // Fabrik liefert in demo DisabledAccountingGateway (kein Mock-Erfolg, kein Lexware);
  // der Seed stellt deshalb nie Transferjobs ein. Fail-closed auch hier.
  const lexware = createLexwareContext(config, db, logger ?? noopLogger);
  const accounting = createAccountingGatewayFor(config, lexware);
  assertAccountingGatewayAllowed(config.appEnv, accounting);
  const communication = createCommunicationContext(config, db, queue, {
    gateway: deps.mailGateway,
    storage,
    logger,
  });
  const loggerOption = logger === undefined ? {} : { logger };
  const voucherTriggers = createVoucherTriggers({ db, queue, ...loggerOption });
  const transfers = createAccountingTransferService({
    db,
    queue,
    accountingGateway: accounting,
    lexware,
    ...loggerOption,
    paymentStatusListeners: [voucherTriggers.paymentStatusListener],
  });
  const transactional = createTransactionalMailModule({
    communication,
    db,
    config,
    queue,
    lexware,
    transfers,
    logger,
  });
  const retentionListener = createRetentionCompletionListener(queue, logger);
  const processes = new ProcessService(db, [retentionListener]);
  const documents = new DocumentService(db, storage);
  const products = new ProductService(db);
  const machines = new MachineService(db, storage, voucherTriggers.cleaningEndedListener);
  const assignments = new AssignmentService(db, machines, storage);
  const inventory = new InventoryService(db);
  const damages = new DamageService(db, storage);
  const tours = new TourService(db);
  // Terminplanung wie in den Scheduling-Routen (Risiko-Refresh + Tour-Stale);
  // Übergabe/Rückgabe erhalten – wie ihre Routen – eine Instanz ohne Listener.
  const scheduling = new SchedulingService(db, [
    createRiskRefreshListener(assignments),
    createTourStaleListener(tours),
  ]);
  const plainScheduling = new SchedulingService(db);
  const handover = new HandoverService(
    db,
    storage,
    assignments,
    inventory,
    machines,
    documents,
    products,
    plainScheduling,
    damages,
    transactional.packetMailer,
    pdfEnvironmentLabel(config), // Phase 14 (reset): Demo-Kennzeichnung der PDFs
  );
  const settlements = new SettlementService({
    db,
    transfers,
    notices: transactional.noticeMailer,
    queue,
    processes,
    appEnv: config.appEnv,
    ...(logger === undefined ? {} : { logger }),
  });
  const returns = new ReturnService(
    db,
    storage,
    inventory,
    machines,
    documents,
    plainScheduling,
    damages,
    assignments,
    [createSettlementEnsureListener(settlements, logger ?? noopLogger)],
    transactional.packetMailer,
    pdfEnvironmentLabel(config), // Phase 14 (reset): Demo-Kennzeichnung der PDFs
  );
  const routing = deps.routingGateway ?? createRoutingGateway(config, logger, { db });
  const geocoding = new GeocodingService(db, routing, logger);
  const planning = new PlanningService(db, tours, routing, geocoding, {
    resolveOperativeAddress,
    getDepotAddress,
  });
  return {
    auth,
    customers: new CustomerService(db),
    processes,
    inquiries: new InquiryService(db),
    products,
    terms: new TermsService(db, config),
    documents,
    offers: new OfferService(db, config, documents, transactional.offerGateway),
    confirmations: new OrderConfirmationService(db, config, documents, transactional.offerGateway),
    scheduling,
    machines,
    assignments,
    inventory,
    damages,
    handover,
    returns,
    settlements,
    conversations: new ConversationService(db, storage),
    outbox: communication.outbox,
    tours,
    planning,
    routing,
    communication,
    transactional,
  };
}

const noopLogger: JobRunnerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
