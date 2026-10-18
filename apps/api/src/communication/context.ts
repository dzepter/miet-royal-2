/**
 * Komposition der Kommunikationsschicht (Phase 12) – EINE Stelle für API
 * (app.ts), Worker (apps/worker) und Tests: Gateway-Wahl je Umgebung,
 * Payload-Krypto, Outbox, Dokumentenzugriff für Anhänge sowie die
 * Registrierungspunkte für Listener (Agent T: Gutschein/AB/Pakete) und den
 * transienten Rechnungsabruf. Production lehnt ein Fake-Gateway hart ab.
 */
import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { JobQueue, JobRunnerLogger, StorageProvider } from '@mietroyal/integrations';
import { DocumentService } from '../commerce/document-service.ts';
import { createOfferMailPreSendGuard } from '../commerce/offer-mail-guard.ts';
import { CommunicationService } from './communication-service.ts';
import { assertMailGatewayAllowed, createOutboundMailGateway } from './mail/gateways.ts';
import { MailOutboxService } from './mail/outbox.ts';
import type {
  InvoiceFileFetcher,
  MailFailedListener,
  MailPreSendGuard,
  MailSentListener,
} from './mail/send-job.ts';
import { PayloadCrypto } from './payload-crypto.ts';
import type { OutboundMailGateway } from './types.ts';

export interface CommunicationContext {
  config: AppConfig;
  db: Database;
  queue: JobQueue;
  crypto: PayloadCrypto;
  mailGateway: OutboundMailGateway;
  outbox: MailOutboxService;
  documents: DocumentService;
  service: CommunicationService;
  logger: JobRunnerLogger | undefined;
  /** Nach bestätigtem Versand (z. B. Gutschein markDelivered, AB sent, Paket sent). */
  addMailSentListener(listener: MailSentListener): void;
  addMailFailedListener(listener: MailFailedListener): void;
  /** Härtung B7: fachliche Prüfung unmittelbar vor dem Versand (z. B. veraltete Erinnerung). */
  addMailPreSendGuard(guard: MailPreSendGuard): void;
  /** Lexware-Rechnungsdatei transient für invoice_delivery (Agent T). */
  setInvoiceFileFetcher(fetcher: InvoiceFileFetcher | null): void;
  mailSentListeners(): readonly MailSentListener[];
  mailFailedListeners(): readonly MailFailedListener[];
  mailPreSendGuards(): readonly MailPreSendGuard[];
  invoiceFileFetcher(): InvoiceFileFetcher | null;
}

export function createCommunicationContext(
  config: AppConfig,
  db: Database,
  queue: JobQueue,
  options: {
    gateway?: OutboundMailGateway | undefined;
    storage: StorageProvider;
    logger?: JobRunnerLogger | undefined;
  },
): CommunicationContext {
  const mailGateway = options.gateway ?? createOutboundMailGateway(config);
  assertMailGatewayAllowed(config, mailGateway);
  const crypto = new PayloadCrypto(config);
  const outbox = new MailOutboxService(db, config, crypto, mailGateway, queue);
  const documents = new DocumentService(db, options.storage);
  const sent: MailSentListener[] = [];
  const failed: MailFailedListener[] = [];
  // Härtung RA-5: Angebotsmail einer abgelösten Version wird nie mehr versendet.
  const guards: MailPreSendGuard[] = [createOfferMailPreSendGuard(db)];
  let invoiceFiles: InvoiceFileFetcher | null = null;
  return {
    config,
    db,
    queue,
    crypto,
    mailGateway,
    outbox,
    documents,
    service: new CommunicationService(outbox, crypto),
    logger: options.logger,
    addMailSentListener: (listener) => {
      sent.push(listener);
    },
    addMailFailedListener: (listener) => {
      failed.push(listener);
    },
    addMailPreSendGuard: (guard) => {
      guards.push(guard);
    },
    setInvoiceFileFetcher: (fetcher) => {
      invoiceFiles = fetcher;
    },
    mailSentListeners: () => sent,
    mailFailedListeners: () => failed,
    mailPreSendGuards: () => guards,
    invoiceFileFetcher: () => invoiceFiles,
  };
}
