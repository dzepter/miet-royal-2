import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { JobQueue, JobRunner, JobRunnerLogger } from '@mietroyal/integrations';
import type { AccountingTransferService } from '../accounting/transfer-service.ts';
import {
  createOfferDeliveryGateway,
  type OfferDeliveryGateway,
} from '../commerce/delivery-gateway.ts';
import type { CommunicationContext } from '../communication/context.ts';
import { CustomerDocumentLinkService } from '../communication/document-links.ts';
import {
  createInvoiceDeliveryHandler,
  createLexwareInvoiceFileFetcher,
} from '../communication/invoice-delivery-job.ts';
import { createTransactionalMailListeners } from '../communication/transactional/listeners.ts';
import {
  CancellationConfirmationMailer,
  DeliveryPacketMailer,
  SettlementNoticeMailer,
  type TransactionalMailDeps,
} from '../communication/transactional/mailers.ts';
import { INVOICE_DELIVERY_JOB_TYPE, VOUCHER_DELIVERY_JOB_TYPE } from '../communication/types.ts';
import {
  createVoucherDeliveryHandler,
  enqueuePendingVoucherDeliveries,
  enqueueVoucherDelivery,
} from '../communication/voucher-delivery-job.ts';
import { ProcessService } from '../crm/process-service.ts';
import type { LexwareContext } from '../lexware/context.ts';
import { SettlementService } from '../settlement/settlement-service.ts';

/**
 * Transaktionsmails (Phase 12, Order §§11–16, 37): EINE Komposition für API
 * (app.ts), Worker (apps/worker) und Tests. Erzeugt die fachlichen Auslöser
 * auf die Mail-Outbox (Angebot/AB-Gateway, Paket-/Notice-/Storno-Mailer,
 * Dokument-Links), registriert die Sent-/Failed-Listener und den transienten
 * Rechnungsabruf an der Kommunikationsschicht und stellt die Job-Handler
 * `voucher.delivery` und `invoice.delivery` bereit.
 */
export interface TransactionalMailModuleDeps {
  communication: CommunicationContext;
  db: Database;
  config: AppConfig;
  queue: JobQueue;
  lexware: LexwareContext;
  /** Transfer-Boundary (für den Settlement-Service der Notice-Listener). */
  transfers: AccountingTransferService;
  logger?: JobRunnerLogger | undefined;
}

export interface TransactionalMailModule {
  mail: TransactionalMailDeps;
  offerGateway: OfferDeliveryGateway;
  packetMailer: DeliveryPacketMailer;
  noticeMailer: SettlementNoticeMailer;
  cancellationMailer: CancellationConfirmationMailer;
  documentLinks: CustomerDocumentLinkService;
  /** Settlement-Service mit Notice-Mailer (für Routen UND Listener dieselbe Komposition). */
  settlements: SettlementService;
}

export function createTransactionalMailModule(
  deps: TransactionalMailModuleDeps,
): TransactionalMailModule {
  const c = deps.communication;
  const mail: TransactionalMailDeps = { outbox: c.outbox, mailGatewayKind: c.mailGateway.kind };
  const documentLinks = new CustomerDocumentLinkService(deps.db, c.documents);
  const noticeMailer = new SettlementNoticeMailer(mail, documentLinks);
  const settlements = new SettlementService({
    db: deps.db,
    transfers: deps.transfers,
    notices: noticeMailer,
    queue: deps.queue,
    processes: new ProcessService(deps.db),
    appEnv: deps.config.appEnv,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
  const listeners = createTransactionalMailListeners({
    db: deps.db,
    config: deps.config,
    settlements,
    logger: deps.logger,
  });
  c.addMailSentListener(listeners.sent);
  c.addMailFailedListener(listeners.failed);
  // Rechnungs-PDF transient aus Lexware – nie in documents/Storage (Order §16).
  c.setInvoiceFileFetcher(createLexwareInvoiceFileFetcher(deps.lexware));
  return {
    mail,
    offerGateway: createOfferDeliveryGateway(deps.config, c),
    packetMailer: new DeliveryPacketMailer(mail),
    noticeMailer,
    cancellationMailer: new CancellationConfirmationMailer(mail),
    documentLinks,
    settlements,
  };
}

/** Jobs `voucher.delivery` und `invoice.delivery` (Order §37) auf der bestehenden Queue. */
export function registerTransactionalJobHandlers(
  runner: JobRunner,
  deps: Pick<TransactionalMailModuleDeps, 'communication' | 'db' | 'config' | 'logger'>,
): void {
  const c = deps.communication;
  runner.register(
    VOUCHER_DELIVERY_JOB_TYPE,
    createVoucherDeliveryHandler({
      db: deps.db,
      config: deps.config,
      outbox: c.outbox,
      mailGateway: c.mailGateway,
      logger: deps.logger,
    }),
  );
  runner.register(
    INVOICE_DELIVERY_JOB_TYPE,
    createInvoiceDeliveryHandler({
      db: deps.db,
      config: deps.config,
      outbox: c.outbox,
      logger: deps.logger,
    }),
  );
}

export { enqueuePendingVoucherDeliveries, enqueueVoucherDelivery };
export {
  enqueueInvoiceDelivery,
  enqueuePendingInvoiceDeliveries,
} from '../communication/invoice-delivery-job.ts';
export { CustomerDocumentLinkService };
