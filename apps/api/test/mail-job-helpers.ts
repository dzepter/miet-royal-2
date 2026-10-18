import { mailDeliveries } from '@mietroyal/database';
import { asc, eq } from 'drizzle-orm';
import { MailSendProcessor } from '../src/communication/mail/send-job.ts';
import type { TestContext } from './auth-helpers.ts';

/**
 * Phase 12: Welt-Helfer der Phasen 3–11 lösen inzwischen Transaktionsmails
 * aus (Angebot beim Versand, Übergabe-/Rückgabeprotokoll bei der
 * Finalisierung). Damit die fachlichen Erwartungen der Bestandstests an die
 * Job-Queue („genau ein Transferjob“, `runOnce()` verarbeitet den
 * Transferjob, „keine Jobs“) unverändert gelten, verarbeitet dieser Helfer
 * GEZIELT nur die offenen Outbox-Zustellungen (MailSendProcessor wie im Job
 * `mail.send`, inkl. Sent-/Failed-Listener) und entfernt anschließend die
 * zugehörigen `mail.send`-Jobs. Andere Jobs (Transfer, Gutschein, Lexware)
 * werden NICHT angefasst. Die Fake-Aufzeichnung wird geleert; bereits mit
 * `nextOutcomes` eingestellte Ergebnisse werden dabei verbraucht – Tests,
 * die Mailfehler simulieren, stellen sie daher NACH dem Welt-Helfer ein.
 */
export async function settleMailJobs(ctx: TestContext): Promise<void> {
  const c = ctx.communication;
  const processor = new MailSendProcessor({
    db: c.db,
    config: c.config,
    crypto: c.crypto,
    gateway: c.mailGateway,
    queue: c.queue,
    documents: c.documents,
    invoiceFiles: c.invoiceFileFetcher,
    sentListeners: c.mailSentListeners,
    failedListeners: c.mailFailedListeners,
    logger: c.logger,
  });
  const pending = await ctx.db
    .select({ id: mailDeliveries.id })
    .from(mailDeliveries)
    .where(eq(mailDeliveries.status, 'pending'))
    .orderBy(asc(mailDeliveries.createdAt));
  for (const row of pending) await processor.process(row.id);
  await ctx.pool.query(`DELETE FROM integration_jobs WHERE type = 'mail.send'`);
  ctx.mailGateway.sent.length = 0;
  ctx.mailGateway.attempts.length = 0;
}

/** Bisheriger Name (Angebotsversand der Welt-Helfer). */
export const settleOfferMailJobs = settleMailJobs;
