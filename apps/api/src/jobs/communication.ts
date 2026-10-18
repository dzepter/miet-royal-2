import type { JobRunner } from '@mietroyal/integrations';
import type { CommunicationContext } from '../communication/context.ts';
import { createMailSendHandler } from '../communication/mail/send-job.ts';
import { MAIL_SEND_JOB_TYPE } from '../communication/types.ts';

/**
 * Kommunikations-Jobs (Phase 12, Order §37) auf der bestehenden PostgreSQL-
 * Queue – dieselben Handler im Worker (`@mietroyal/api/jobs/communication`)
 * und im nicht gestarteten API-Runner (Mock-Steuerung/Tests). Weitere
 * Handler (mail.inbound_poll, communication.scan_due, cleanup, whatsapp.*,
 * push.*) hängen die jeweiligen Module hier ein.
 */
export function registerCommunicationJobHandlers(
  runner: JobRunner,
  deps: { communication: CommunicationContext },
): void {
  const c = deps.communication;
  runner.register(
    MAIL_SEND_JOB_TYPE,
    createMailSendHandler({
      db: c.db,
      config: c.config,
      crypto: c.crypto,
      gateway: c.mailGateway,
      queue: c.queue,
      documents: c.documents,
      invoiceFiles: c.invoiceFileFetcher,
      sentListeners: c.mailSentListeners,
      failedListeners: c.mailFailedListeners,
      // Phase 12 Härtung (B7): fachliche Pre-Send-Guards (Erinnerungen, Angebote).
      preSendGuards: c.mailPreSendGuards,
      logger: c.logger,
    }),
  );
}

export { createCommunicationContext, type CommunicationContext } from '../communication/context.ts';
export { COMMUNICATION_LOG_REDACT_PATHS } from '../communication/logging.ts';
export { MAIL_SEND_JOB_TYPE };
