import { pushDeliveries, type Database, type DatabaseExecutor } from '@mietroyal/database';
import type { JobQueue, JobRunnerLogger } from '@mietroyal/integrations';
import { eq } from 'drizzle-orm';
import { PUSH_SEND_JOB_TYPE, type PushKind, type PushPayload } from '../types.ts';

/**
 * Push-Outbox (Order §29/§32/§37): `enqueue` schreibt genau eine Zeile je
 * Idempotenzschlüssel in `push_deliveries` (UNIQUE ⇒ Dedupe) und reiht den
 * Job `push.send` (Key `push.send:<deliveryId>`) ein. Der Versand läuft nie
 * in einer offenen Fachtransaktion, sondern im Job.
 *
 * Phase 12 Finalisierung (Reassignment-Claim): beide Schritte sind auch
 * einzeln nutzbar – `createDelivery(input, tx)` legt die Zeile INNERHALB
 * einer Fachtransaktion an (z. B. zusammen mit einem atomaren Claim),
 * `enqueueSendJob(deliveryId)` reiht den Job NACH dem Commit ein. Fehlt der
 * Job nach einem Absturz dazwischen, holt der Push-Outbox-Backstop
 * (`PushRuleScanner.scheduleOutboxBackstop`) ihn mit demselben Schlüssel nach.
 */

export const PUSH_SEND_MAX_ATTEMPTS = 5;

export interface PushEnqueueInput {
  kind: PushKind;
  userId: string;
  /** Fachlich eindeutig, z. B. `push:return_overdue:<incidentId>:<userId>`. */
  idempotencyKey: string;
  payload: PushPayload;
  /**
   * Phase 12 Finalisierung (B2): Termin terminbezogener Pushes (`appointment_1h`,
   * `assignment_reassigned`) – `push.send` prüft damit vor jedem Gateway-Aufruf,
   * ob die Zustellung noch zum aktuellen Terminstand passt (sonst SUPERSEDED).
   */
  appointmentId?: string;
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
    const result = await this.createDelivery(input);
    await this.enqueueSendJob(result.deliveryId);
    if (!result.deduplicated) {
      this.logger?.info(
        { deliveryId: result.deliveryId, kind: input.kind, userId: input.userId },
        'Push-Zustellung eingereiht',
      );
    }
    return result;
  }

  /**
   * Nur die Outbox-Zeile (ohne Job) – optional in der Transaktion des
   * Aufrufers (`executor`). Dedupe über den Idempotenzschlüssel: ein zweiter
   * Aufruf liefert die bestehende Zeile (`deduplicated`).
   */
  async createDelivery(
    input: PushEnqueueInput,
    executor: DatabaseExecutor = this.db,
  ): Promise<PushEnqueueResult> {
    const inserted = await executor
      .insert(pushDeliveries)
      .values({
        kind: input.kind,
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
        appointmentId: input.appointmentId ?? null,
      })
      .onConflictDoNothing({ target: pushDeliveries.idempotencyKey })
      .returning({ id: pushDeliveries.id });
    const created = inserted[0]?.id;
    if (created !== undefined) return { deliveryId: created, deduplicated: false };
    const existing = await executor
      .select({ id: pushDeliveries.id })
      .from(pushDeliveries)
      .where(eq(pushDeliveries.idempotencyKey, input.idempotencyKey));
    const deliveryId = existing[0]?.id;
    if (deliveryId === undefined) {
      throw new Error('Push-Zustellung konnte nicht angelegt werden');
    }
    return { deliveryId, deduplicated: true };
  }

  /**
   * Job `push.send` für eine bestehende Zustellung (nie in einer offenen
   * Transaktion aufrufen – die Queue nutzt eine eigene Verbindung). Der
   * Job-Key ist je Delivery stabil: ein zweiter Aufruf (Backstop) erzeugt
   * keinen zweiten Job, holt aber einen fehlenden nach. true ⇒ neu eingereiht.
   */
  async enqueueSendJob(deliveryId: string): Promise<boolean> {
    const payload: PushSendJobPayload = { deliveryId };
    const result = await this.queue.enqueue(PUSH_SEND_JOB_TYPE, payload, {
      idempotencyKey: pushSendJobKey(deliveryId),
      maxAttempts: PUSH_SEND_MAX_ATTEMPTS,
    });
    return !result.deduplicated;
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
