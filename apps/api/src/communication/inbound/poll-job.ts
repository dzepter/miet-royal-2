/**
 * Phase 12 (Order §37): Job `mail.inbound_poll` – pollt die IMAP-Mailbox und
 * reiht sich selbst alle 2 Minuten mit Zeit-Bucket-Schlüssel neu ein
 * (integration_jobs.idempotency_key bleibt für immer UNIQUE). Bei
 * deaktivierter Quelle: no-op, keine Folgejobs.
 * Härtung B6: Folge-Bucket = max(Payload-Bucket + 2 min, Bucket nach now)
 * (Worker-Uhr hinter DB-Uhr reißt die Kette nicht ab); der Worker-Watchdog
 * reiht zusätzlich minütlich den aktuellen Bucket ein (dedupliziert).
 */
import type { JobHandler, JobQueue, JobRunnerLogger } from '@mietroyal/integrations';
import { followUpBucket, payloadBucket } from '../chain-bucket.ts';
import type { InboundMailSource } from '../types.ts';
import { MAIL_INBOUND_POLL_JOB_TYPE } from '../types.ts';
import type { InboundMailProcessor } from './processor.ts';

export const INBOUND_POLL_INTERVAL_MS = 2 * 60 * 1000;

export function inboundPollIdempotencyKey(bucketStart: Date): string {
  return `${MAIL_INBOUND_POLL_JOB_TYPE}:${bucketStart.toISOString()}`;
}

/** Beginn des nächsten 2-Minuten-Buckets nach `now`. */
export function nextInboundPollBucket(now: Date): Date {
  const bucket = Math.floor(now.getTime() / INBOUND_POLL_INTERVAL_MS) + 1;
  return new Date(bucket * INBOUND_POLL_INTERVAL_MS);
}

/** Initialer Poll (Worker-Boot) – dedupliziert über den aktuellen Bucket. */
export async function enqueueInboundPoll(
  queue: JobQueue,
  source: InboundMailSource,
  now = new Date(),
): Promise<void> {
  if (source.kind === 'disabled') return;
  const bucketStart = new Date(
    Math.floor(now.getTime() / INBOUND_POLL_INTERVAL_MS) * INBOUND_POLL_INTERVAL_MS,
  );
  await queue.enqueue(
    MAIL_INBOUND_POLL_JOB_TYPE,
    { bucket: bucketStart.toISOString() },
    {
      idempotencyKey: inboundPollIdempotencyKey(bucketStart),
      maxAttempts: 3,
    },
  );
}

export function createInboundPollHandler(deps: {
  processor: InboundMailProcessor;
  source: InboundMailSource;
  queue: JobQueue;
  mailbox: string;
  logger?: JobRunnerLogger;
  now?: () => Date;
}): JobHandler {
  return async (job) => {
    if (deps.source.kind === 'disabled') return;
    const now = deps.now === undefined ? new Date() : deps.now();
    // Nächsten Lauf ZUERST einreihen (kein Abriss der Kette bei Fehlern unten).
    const next = followUpBucket(payloadBucket(job.payload), now, INBOUND_POLL_INTERVAL_MS);
    await deps.queue.enqueue(
      MAIL_INBOUND_POLL_JOB_TYPE,
      { bucket: next.toISOString() },
      {
        idempotencyKey: inboundPollIdempotencyKey(next),
        runAt: next,
        maxAttempts: 3,
      },
    );
    const result = await deps.processor.pollOnce(deps.mailbox);
    deps.logger?.info(
      {
        jobId: job.id,
        mailbox: result.mailbox,
        fetched: result.fetched,
        lastUid: result.lastUid,
        errorCode: result.errorCode,
      },
      'mail.inbound_poll ausgeführt',
    );
  };
}
