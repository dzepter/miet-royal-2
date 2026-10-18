import { pushDeliveries, type Database } from '@mietroyal/database';
import type { JobQueue, JobRunnerLogger } from '@mietroyal/integrations';
import { eq } from 'drizzle-orm';
import { PUSH_SEND_JOB_TYPE, type PushKind, type PushPayload } from '../types.ts';

/**
 * Push-Outbox (Order §29/§32/§37): `enqueue` schreibt genau eine Zeile je
 * Idempotenzschlüssel in `push_deliveries` (UNIQUE ⇒ Dedupe) und reiht den
 * Job `push.send` (Key `push.send:<deliveryId>`) ein. Der Versand läuft nie
 * in einer offenen Fachtransaktion, sondern im Job.
 */

export const PUSH_SEND_MAX_ATTEMPTS = 5;

export interface PushEnqueueInput {
  kind: PushKind;
  userId: string;
  /** Fachlich eindeutig, z. B. `push:return_overdue:<incidentId>:<userId>`. */
  idempotencyKey: string;
  payload: PushPayload;
}

export interface PushEnqueueResult {
  deliveryId: string;
  deduplicated: boolean;
}

export interface PushSendJobPayload {
  deliveryId: string;
}

export function pushSendJobKey(deliveryId: string): string {
  return `${PUSH_SEND_JOB_TYPE}:${deliveryId}`;
}

export class PushService {
  constructor(
    private readonly db: Database,
    private readonly queue: JobQueue,
    private readonly logger?: JobRunnerLogger,
  ) {}

  async enqueue(input: PushEnqueueInput): Promise<PushEnqueueResult> {
    const inserted = await this.db
      .insert(pushDeliveries)
      .values({
        kind: input.kind,
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
      })
      .onConflictDoNothing({ target: pushDeliveries.idempotencyKey })
      .returning({ id: pushDeliveries.id });
    let deliveryId = inserted[0]?.id;
    let deduplicated = false;
    if (deliveryId === undefined) {
      const existing = await this.db
        .select({ id: pushDeliveries.id })
        .from(pushDeliveries)
        .where(eq(pushDeliveries.idempotencyKey, input.idempotencyKey));
      deliveryId = existing[0]?.id;
      deduplicated = true;
      if (deliveryId === undefined) {
        throw new Error('Push-Zustellung konnte nicht angelegt werden');
      }
    }
    // Job-Key ist je Delivery stabil: ein zweiter Aufruf (Backstop) erzeugt
    // keinen zweiten Job, holt aber einen fehlenden nach.
    const payload: PushSendJobPayload = { deliveryId };
    await this.queue.enqueue(PUSH_SEND_JOB_TYPE, payload, {
      idempotencyKey: pushSendJobKey(deliveryId),
      maxAttempts: PUSH_SEND_MAX_ATTEMPTS,
    });
    if (!deduplicated) {
      this.logger?.info(
        { deliveryId, kind: input.kind, userId: input.userId },
        'Push-Zustellung eingereiht',
      );
    }
    return { deliveryId, deduplicated };
  }

  /** Dieselbe Nutzlast an mehrere Empfänger (je Empfänger eigener Schlüssel). */
  async enqueueForUsers(
    userIds: readonly string[],
    kind: PushKind,
    payload: PushPayload,
    keyFor: (userId: string) => string,
  ): Promise<PushEnqueueResult[]> {
    const results: PushEnqueueResult[] = [];
    for (const userId of [...new Set(userIds)]) {
      results.push(await this.enqueue({ kind, userId, idempotencyKey: keyFor(userId), payload }));
    }
    return results;
  }
}
