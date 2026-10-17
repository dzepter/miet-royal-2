import { lexwareInvoiceMappings, lexwareWebhookEvents } from '@mietroyal/database';
import type { JobHandler } from '@mietroyal/integrations';
import { and, eq } from 'drizzle-orm';
import type { FinanceHandlerDeps } from '../jobs/finance.ts';
import { LexwareConnectionService } from './connection-service.ts';
import { LexwareApiError } from './errors.ts';
import { syncLexwareInvoice } from './invoice-sync.ts';

/**
 * Job `lexware.event.process` (Payload { eventId }, Order §§48–51): Der
 * Webhook-Payload ist nur ein Trigger – der Worker liest den aktuellen Stand
 * bei Lexware über `syncLexwareInvoice`. token.revoked ⇒ Verbindung getrennt
 * (keine Auto-Retries, nichts löschen). Ohne Mapping ⇒ Event ignoriert.
 * Idempotent: ein bereits verarbeitetes Event wird nicht erneut angefasst.
 * Transiente Lexware-Fehler werden geworfen (Queue-Retry mit Backoff);
 * permanente Fehler enden mit Status failed + neutralem Code ohne Retry.
 */
export function createLexwareEventHandler(deps: FinanceHandlerDeps): JobHandler {
  const connection = new LexwareConnectionService(deps.lexware);
  return async (job) => {
    const payload = job.payload as { eventId?: unknown } | null;
    const eventId = payload?.eventId;
    if (typeof eventId !== 'string' || eventId === '') {
      throw new Error('lexware.event.process: Payload ohne eventId');
    }
    const rows = await deps.db
      .select()
      .from(lexwareWebhookEvents)
      .where(eq(lexwareWebhookEvents.id, eventId));
    const event = rows[0];
    if (event === undefined) {
      deps.logger?.warn({ jobId: job.id, eventId }, 'lexware.event.process: Event fehlt');
      return;
    }
    if (event.status === 'processed' || event.status === 'ignored') return;
    const now = new Date();
    const finish = async (status: 'processed' | 'ignored' | 'failed', resultCode: string) => {
      await deps.db
        .update(lexwareWebhookEvents)
        .set({ status, resultCode, processedAt: now })
        .where(eq(lexwareWebhookEvents.id, event.id));
      deps.logger?.info(
        {
          jobId: job.id,
          eventId: event.id,
          eventType: event.eventType,
          status,
          resultCode,
          attempt: job.attempts,
        },
        'lexware.event.process verarbeitet',
      );
    };

    if (event.eventType === 'token.revoked') {
      await connection.markDisconnected('TOKEN_REVOKED');
      await finish('processed', 'TOKEN_REVOKED');
      return;
    }

    const mappings = await deps.db
      .select()
      .from(lexwareInvoiceMappings)
      .where(
        and(
          eq(lexwareInvoiceMappings.lexwareInvoiceId, event.resourceId),
          eq(lexwareInvoiceMappings.organizationId, event.organizationId),
        ),
      );
    const mapping = mappings[0];
    if (mapping === undefined) {
      await finish('ignored', 'NO_MAPPING');
      return;
    }

    try {
      const result = await syncLexwareInvoice(
        deps.lexware,
        deps.db,
        deps.transfers,
        mapping.id,
        now,
      );
      await finish(
        'processed',
        result.outcome === 'attention'
          ? (result.attentionCode ?? 'ATTENTION')
          : result.outcome.toUpperCase(),
      );
    } catch (error) {
      if (error instanceof LexwareApiError) {
        if (error.kind === 'unauthorized') {
          await connection.markDisconnected(error.code);
          await finish('failed', error.code);
          return;
        }
        await finish('failed', error.code);
        if (error.transient) throw error;
        return;
      }
      await finish('failed', 'INTERNAL_ERROR');
      throw error;
    }
  };
}
