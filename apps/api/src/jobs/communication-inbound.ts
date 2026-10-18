/**
 * Phase 12 (inbound): Job-Handler für eingehende E-Mail und WhatsApp auf der
 * bestehenden PostgreSQL-Queue – eine Registrierung für API (nicht
 * gestarteter Runner) und Worker.
 */
import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type {
  JobQueue,
  JobRunner,
  JobRunnerLogger,
  StorageProvider,
} from '@mietroyal/integrations';
import { ConversationService } from '../communication/conversation/conversation-service.ts';
import { createConversationDeliveryListeners as createListeners } from '../communication/conversation/outbox-listener.ts';
import { createInboundPollHandler } from '../communication/inbound/poll-job.ts';
import { InboundMailProcessor } from '../communication/inbound/processor.ts';
import { createInboundMailSource } from '../communication/inbound/sources.ts';
import type { InboundMailSource, WhatsAppGateway } from '../communication/types.ts';
import {
  MAIL_INBOUND_POLL_JOB_TYPE,
  WHATSAPP_MEDIA_FETCH_JOB_TYPE,
  WHATSAPP_SEND_JOB_TYPE,
} from '../communication/types.ts';
import { createWhatsAppGateway } from '../communication/whatsapp/gateways.ts';
import {
  createWhatsAppMediaFetchHandler,
  createWhatsAppSendHandler,
} from '../communication/whatsapp/jobs.ts';

export interface InboundJobDeps {
  db: Database;
  config: AppConfig;
  queue: JobQueue;
  storage: StorageProvider;
  /** Default: aus config.mail.imap (Disabled ohne IMAP). */
  inboundMailSource?: InboundMailSource;
  /** Default: aus config.whatsapp.mode. */
  whatsappGateway?: WhatsAppGateway;
  logger?: JobRunnerLogger;
}

export { createInboundMailSource, createWhatsAppGateway };
export { enqueueInboundPoll } from '../communication/inbound/poll-job.ts';

/** Zustellstatus der Outbox in die Konversation spiegeln (API und Worker). */
export function createConversationDeliveryListeners(
  db: Database,
  storage: StorageProvider,
): ReturnType<typeof createListeners> {
  return createListeners(new ConversationService(db, storage));
}

export function registerInboundJobHandlers(runner: JobRunner, deps: InboundJobDeps): void {
  const source = deps.inboundMailSource ?? createInboundMailSource(deps.config);
  const gateway = deps.whatsappGateway ?? createWhatsAppGateway(deps.config);
  const logger = deps.logger;
  const processor = new InboundMailProcessor({
    db: deps.db,
    storage: deps.storage,
    source,
    ...(logger === undefined ? {} : { logger }),
  });
  runner.register(
    MAIL_INBOUND_POLL_JOB_TYPE,
    createInboundPollHandler({
      processor,
      source,
      queue: deps.queue,
      mailbox: deps.config.mail.imap?.folder ?? 'INBOX',
      ...(logger === undefined ? {} : { logger }),
    }),
  );
  const whatsappDeps = {
    db: deps.db,
    storage: deps.storage,
    gateway,
    ...(logger === undefined ? {} : { logger }),
  };
  runner.register(WHATSAPP_SEND_JOB_TYPE, createWhatsAppSendHandler(whatsappDeps));
  runner.register(WHATSAPP_MEDIA_FETCH_JOB_TYPE, createWhatsAppMediaFetchHandler(whatsappDeps));
}
