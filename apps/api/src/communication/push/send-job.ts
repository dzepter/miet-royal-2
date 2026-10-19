import { appointmentReminders, pushDeliveries, type Database } from '@mietroyal/database';
import type { JobHandler, JobRunnerLogger } from '@mietroyal/integrations';
import { and, eq, sql } from 'drizzle-orm';
import type { PushGateway, PushPayload } from '../types.ts';
import { PUSH_ENDPOINT_NOT_ALLOWED } from './endpoint-policy.ts';
import type { PushSendJobPayload } from './push-service.ts';
import type { PushSubscriptionService } from './subscription-service.ts';
import { isDeliveryStillCurrent, PUSH_SUPERSEDED_CODE } from './supersede.ts';

/**
 * Job `push.send` (Order §29/§37): sendet eine Zustellung an alle aktiven
 * Subscriptions des Empfängers.
 * - 404/410 (gone) ⇒ Subscription deaktiviert (`gone`)
 * - ENDPOINT_NOT_ALLOWED (Härtung B10) ⇒ Subscription deaktiviert
 * - transient ⇒ Fehler werfen ⇒ Queue-Retry (max. 5 Versuche; AT-LEAST-ONCE –
 *   ein erneuter Versand an bereits erfolgreiche Geräte wird im Browser über
 *   den Notification-`tag` zusammengefasst)
 * - Ende: `sent` (≥ 1 Erfolg) oder `failed` (keine Subscriptions / alle permanent)
 * - Phase 12 Finalisierung (B2): terminbezogene Zustellungen (`appointment_1h`,
 *   `assignment_reassigned` mit `appointmentId`) werden VOR JEDEM Gateway-
 *   Aufruf – auch in Retries – gegen den aktuellen Terminstand geprüft
 *   (supersede.ts). Überholt ⇒ `skipped`/`SUPERSEDED`, kein (weiterer) Aufruf,
 *   Job endet erfolgreich (kein Retry). Restfenster: eine Änderung während
 *   eines laufenden Gateway-Aufrufs (keine Sperre über den Versand).
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

    // Phase 12 Finalisierung (B2): passt die Zustellung noch zum aktuellen Stand?
    const stillCurrent = () => isDeliveryStillCurrent(deps.db, delivery, new Date());
    const markSuperseded = async (targeted: number, succeeded: number) => {
      // Review Runde 2 (B1): Wurde noch kein Gerät erreicht, gibt die überholte
      // Zustellung ihren fachlichen Schlüssel frei (Suffix `:superseded:<id>`)
      // und löst die 1-h-Marke. Kehrt der Termin später zum selben Stand zurück
      // (Rückzuweisung, Rückverschiebung ⇒ gleicher Fingerprint), legt der Scan
      // eine NEUE Zustellung mit eigenem Job an – sonst ginge der Push verloren.
      // Wurde schon ein Gerät erreicht, bleibt der Schlüssel belegt (kein
      // zweiter Push für denselben Stand).
      await deps.db.transaction(async (tx) => {
        const released = succeeded === 0;
        const updated = await tx
          .update(pushDeliveries)
          .set({
            status: 'skipped',
            subscriptionsTargeted: targeted,
            subscriptionsSucceeded: succeeded,
            lastErrorCode: PUSH_SUPERSEDED_CODE,
            ...(released
              ? {
                  idempotencyKey: sql`${pushDeliveries.idempotencyKey} || ':superseded:' || ${pushDeliveries.id}::text`,
                }
              : {}),
          })
          .where(and(eq(pushDeliveries.id, deliveryId), eq(pushDeliveries.status, 'pending')))
          .returning({ id: pushDeliveries.id });
        if (updated.length === 0 || !released) return;
        await tx
          .update(appointmentReminders)
          .set({ pushDeliveryId: null, sentAt: null })
          .where(eq(appointmentReminders.pushDeliveryId, deliveryId));
      });
      deps.logger?.info(
        { deliveryId, kind: delivery.kind, code: PUSH_SUPERSEDED_CODE, targeted, succeeded },
        'push.send: Zustellung überholt – nicht gesendet',
      );
    };
    if (!(await stillCurrent())) {
      await markSuperseded(0, 0);
      return;
    }

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
      // B2: unmittelbar vor JEDEM Gateway-Aufruf erneut prüfen (enges Restfenster).
      if (!(await stillCurrent())) {
        await deps.subscriptions.markSuccess(succeededIds);
        await markSuperseded(targets.length, succeeded);
        return;
      }
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
