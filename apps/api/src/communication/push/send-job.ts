import { pushDeliveries, type Database } from '@mietroyal/database';
import type { JobHandler, JobRunnerLogger } from '@mietroyal/integrations';
import { eq } from 'drizzle-orm';
import type { PushGateway, PushPayload } from '../types.ts';
import { PUSH_ENDPOINT_NOT_ALLOWED } from './endpoint-policy.ts';
import type { PushSendJobPayload } from './push-service.ts';
import type { PushSubscriptionService } from './subscription-service.ts';

/**
 * Job `push.send` (Order §29/§37): sendet eine Zustellung an alle aktiven
 * Subscriptions des Empfängers.
 * - 404/410 (gone) ⇒ Subscription deaktiviert (`gone`)
 * - ENDPOINT_NOT_ALLOWED (Härtung B10) ⇒ Subscription deaktiviert
 * - transient ⇒ Fehler werfen ⇒ Queue-Retry (max. 5 Versuche; AT-LEAST-ONCE –
 *   ein erneuter Versand an bereits erfolgreiche Geräte wird im Browser über
 *   den Notification-`tag` zusammengefasst)
 * - Ende: `sent` (≥ 1 Erfolg) oder `failed` (keine Subscriptions / alle permanent)
 * Log: nur IDs, kind, Zähler, neutraler Code – nie Endpoint/Keys/Payload.
 */
export interface PushSendJobDeps {
  db: Database;
  subscriptions: PushSubscriptionService;
  gateway: PushGateway;
  logger?: JobRunnerLogger;
}

export function createPushSendHandler(deps: PushSendJobDeps): JobHandler {
  return async (job) => {
    const payload = job.payload as Partial<PushSendJobPayload> | null;
    const deliveryId = payload?.deliveryId;
    if (typeof deliveryId !== 'string') throw new Error('push.send: deliveryId fehlt');

    const rows = await deps.db
      .select()
      .from(pushDeliveries)
      .where(eq(pushDeliveries.id, deliveryId));
    const delivery = rows[0];
    if (delivery === undefined) {
      deps.logger?.warn({ deliveryId }, 'push.send: Zustellung nicht gefunden');
      return;
    }
    if (delivery.status !== 'pending') return; // bereits verarbeitet (Replay)

    const targets = await deps.subscriptions.activeTargetsForUser(delivery.userId);
    if (targets.length === 0) {
      await deps.db
        .update(pushDeliveries)
        .set({ status: 'failed', subscriptionsTargeted: 0, lastErrorCode: 'NO_SUBSCRIPTIONS' })
        .where(eq(pushDeliveries.id, deliveryId));
      deps.logger?.info({ deliveryId, kind: delivery.kind }, 'push.send: keine aktiven Geräte');
      return;
    }

    const pushPayload = delivery.payload as PushPayload;
    let succeeded = 0;
    let transient = 0;
    let lastErrorCode: string | null = null;
    const succeededIds: string[] = [];
    for (const target of targets) {
      const outcome = await deps.gateway.send(
        { endpoint: target.endpoint, p256dh: target.p256dh, auth: target.auth },
        pushPayload,
      );
      if (outcome.outcome === 'sent') {
        succeeded += 1;
        succeededIds.push(target.id);
      } else if (outcome.outcome === 'gone') {
        await deps.subscriptions.disableById(target.id, 'gone');
        lastErrorCode = 'GONE';
      } else if (outcome.outcome === 'transient_error') {
        transient += 1;
        lastErrorCode = outcome.code;
      } else {
        // Härtung B10: unzulässiger Endpoint wird nie wieder angesprochen.
        if (outcome.code === PUSH_ENDPOINT_NOT_ALLOWED) {
          await deps.subscriptions.disableById(target.id, 'endpoint_not_allowed');
        }
        lastErrorCode = outcome.code;
      }
    }
    await deps.subscriptions.markSuccess(succeededIds);

    const lastAttempt = job.attempts >= job.maxAttempts;
    if (transient > 0 && !lastAttempt) {
      // Zwischenstand sichern, dann Retry über die Queue.
      await deps.db
        .update(pushDeliveries)
        .set({
          subscriptionsTargeted: targets.length,
          subscriptionsSucceeded: succeeded,
          lastErrorCode,
        })
        .where(eq(pushDeliveries.id, deliveryId));
      throw new Error(`push.send: vorübergehender Fehler (${lastErrorCode ?? 'TRANSIENT'})`);
    }

    const status = succeeded > 0 ? 'sent' : 'failed';
    await deps.db
      .update(pushDeliveries)
      .set({
        status,
        subscriptionsTargeted: targets.length,
        subscriptionsSucceeded: succeeded,
        lastErrorCode: succeeded > 0 ? null : lastErrorCode,
        sentAt: succeeded > 0 ? new Date() : null,
      })
      .where(eq(pushDeliveries.id, deliveryId));
    deps.logger?.info(
      {
        deliveryId,
        kind: delivery.kind,
        status,
        targeted: targets.length,
        succeeded,
        code: succeeded > 0 ? null : lastErrorCode,
      },
      'push.send verarbeitet',
    );
  };
}
