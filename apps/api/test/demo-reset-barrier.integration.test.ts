import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { customers, demoDatasetState, integrationJobs, mailDeliveries } from '@mietroyal/database';
import { JobRunner, PostgresJobQueue } from '@mietroyal/integrations';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCommunicationContext } from '../src/communication/context.ts';
import { mailSendJobKey } from '../src/communication/mail/outbox.ts';
import type {
  OutboundMailGateway,
  OutboundMailMessage,
  OutboundMailOutcome,
} from '../src/communication/types.ts';
import { DemoDatasetService } from '../src/demo/dataset.ts';
import { DEMO_DATASET_CHANGED_REASON } from '../src/demo/job-types.ts';
import {
  DEMO_RESET_BARRIER_LOCK_KEY,
  DemoResetBarrier,
  type BarrierLease,
} from '../src/demo/reset-barrier.ts';
import { DemoResetService } from '../src/demo/reset-service.ts';
import { DEMO_MESSAGES } from '../src/demo/types.ts';
import { registerCommunicationJobHandlers } from '../src/jobs/communication.ts';
import { installDemoWorkerGuards } from '../src/jobs/demo.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  createTestContext,
  destroyTestContext,
  login,
  type TestContext,
} from './auth-helpers.ts';
import { createTestCustomer } from './crm-helpers.ts';
import { demoServicesFor, demoTestNow, freshDemoDatabase } from './demo-helpers.ts';

/**
 * Phase 14 Final (Order §1–§6, Design E): verteilte Reset-Barrier – Pflicht-
 * tests RB1–RB18. In-flight Requests/Jobs blockieren Phase B des Resets
 * ehrlich (kein Zeitfenster), prozessübergreifend (zwei Apps / App + Worker-
 * Runner auf derselben DB), ohne Lock-/Pool-Leaks; Reset-Route ohne Shared-
 * Lock; nach dem Reset normaler Betrieb auf dem neuen Datensatz. Läuft gegen
 * eine eigene Test-DB (mietroyal_test5).
 */

const RESET_TIMEOUT_MS = 180_000;
const SLOW_ROUTE = '/staff/barrier-test/slow';
const THROW_ROUTE = '/staff/barrier-test/throw';
const CONFIRMATION = DEMO_MESSAGES.RESET_CONFIRMATION;
/** Weit über dem früheren Schutzfenster von 1,2 s (Order §6 RB1/RB2). */
const BLOCK_MS = 1500;

interface Gate {
  entered: Promise<void>;
  markEntered: () => void;
  released: Promise<void>;
  release: () => void;
}

function gate(): Gate {
  let markEntered: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, markEntered, released, release };
}

let ctx: TestContext;
let adminId: string;
let adminCookie: string;
const now = demoTestNow();
/** Testrouten: Handler wartet an einem Gate und schreibt DANACH einen Kunden (Business-Mutation). */
let slowGate: Gate | null = null;
let slowRequestEndedAt = 0;

beforeAll(async () => {
  ctx = await createTestContext({
    appEnv: 'demo',
    // RB3: echter mail.send-Versand an eine Whitelist-Domain (Demo-Senke), wie im Deployment.
    env: { MAIL_DEMO_WHITELIST: '@demo.test', MAIL_PUBLIC_WEB_BASE_URL: 'https://web.demo.test' },
    beforeReady: (app) => {
      app.post(SLOW_ROUTE, async (request) => {
        const body = request.body as { name: string };
        slowGate?.markEntered();
        await slowGate?.released;
        const customer = await createTestCustomer(ctx, adminId, {
          firstName: 'Barrier',
          lastName: body.name,
        });
        slowRequestEndedAt = Date.now();
        return { customerId: customer.id };
      });
      app.post(THROW_ROUTE, async () => {
        throw new Error('synthetischer Handlerfehler');
      });
    },
  });
  ({ adminId } = await freshDemoDatabase(ctx));
  await demoServicesFor(ctx).seed.seed({ actorId: adminId, now });
  adminCookie = (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie;
}, RESET_TIMEOUT_MS);

afterAll(async () => {
  await destroyTestContext(ctx);
});

// ── Hilfen ─────────────────────────────────────────────────────────────────────

/** Advisory-Locks des Barrier-Schlüssels in pg_locks (alle Sessions der Datenbank). */
async function barrierLocks(): Promise<Array<{ mode: string; granted: boolean }>> {
  const result = await ctx.pool.query<{ mode: string; granted: boolean }>(
    `SELECT mode, granted FROM pg_locks
     WHERE locktype = 'advisory' AND objsubid = 1
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND classid::bigint = ((hashtext($1)::bigint >> 32) & 4294967295)
       AND objid::bigint = (hashtext($1)::bigint & 4294967295)
     ORDER BY mode, granted`,
    [DEMO_RESET_BARRIER_LOCK_KEY],
  );
  return result.rows;
}

/** Diagnose bei Hängern: aktive Sessions und Barrier-Locks. */
async function dumpActivity(label: string): Promise<void> {
  const activity = await ctx.pool.query(
    `SELECT pid, state, wait_event_type, wait_event, left(query, 160) AS query, xact_start
     FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
     ORDER BY xact_start NULLS LAST`,
  );
  console.error(`[diag ${label}] activity`, JSON.stringify(activity.rows, null, 1));
  console.error(`[diag ${label}] locks`, JSON.stringify(await barrierLocks()));
}

async function withDiag<T>(label: string, promise: Promise<T>, ms = 40_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const diag = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void dumpActivity(label).finally(() => reject(new Error(`Hänger: ${label}`)));
    }, ms);
  });
  try {
    return await Promise.race([promise, diag]);
  } finally {
    clearTimeout(timer);
  }
}

async function sharedHeld(): Promise<number> {
  return (await barrierLocks()).filter((l) => l.mode === 'ShareLock' && l.granted).length;
}

async function exclusiveWaiting(): Promise<number> {
  return (await barrierLocks()).filter((l) => l.mode === 'ExclusiveLock' && !l.granted).length;
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error('waitFor: Bedingung nicht erfüllt');
}

/** Keine Barrier-Locks mehr, keine entliehenen Lock-Verbindungen (RB10–RB14). */
async function expectNoLeak(barrier: DemoResetBarrier = ctx.demoBarrier!) {
  await waitFor(async () => (await barrierLocks()).length === 0);
  await waitFor(() => {
    const stats = barrier.stats();
    return stats.totalCount === stats.idleCount && stats.waitingCount === 0;
  });
  expect(await barrierLocks()).toEqual([]);
}

async function resetInProgress(): Promise<boolean> {
  return new DemoDatasetService(ctx.db).resetInProgress();
}

/** Reset-Flag direkt setzen/löschen (wie Phase A/D, ohne Exclusive-Lock) – nur Tests. */
async function setFlag(value: boolean): Promise<void> {
  const dataset = new DemoDatasetService(ctx.db);
  if (value) {
    await ctx.db.transaction(async (tx) => {
      await dataset.lockRow(tx);
      await dataset.beginReset(tx, { actorId: adminId, now: new Date() });
    });
    return;
  }
  await ctx.db
    .update(demoDatasetState)
    .set({ resetInProgress: false, resetStartedAt: null })
    .where(eq(demoDatasetState.id, 1));
}

/** Reset-Service mit beobachtbarem Beginn von Phase B (Hook läuft in der Wipe-Transaktion). */
function observingReset(options: { barrier?: DemoResetBarrier; barrierTimeoutMs?: number } = {}) {
  const demo = demoServicesFor(ctx, {
    hooks: {
      beforeBusinessWipe: async () => {
        observed.wipeAt = Date.now();
      },
    },
    ...(options.barrierTimeoutMs === undefined
      ? {}
      : { barrierTimeoutMs: options.barrierTimeoutMs }),
  });
  const observed = { wipeAt: 0 };
  const reset =
    options.barrier === undefined
      ? demo.reset
      : new DemoResetService({
          db: ctx.db,
          config: ctx.config,
          storage: ctx.storage,
          queue: ctx.queue,
          mailGateway: ctx.mailGateway,
          dataset: demo.dataset,
          registry: demo.registry,
          seed: demo.seed,
          barrier: options.barrier,
          fkRetryDelayMs: 0,
          hooks: {
            beforeBusinessWipe: async () => {
              observed.wipeAt = Date.now();
            },
          },
        });
  return { reset, observed, dataset: demo.dataset };
}

/** Runner wie der Demo-Worker (beide Guards) auf der Queue des Kontexts; eigene Barrier möglich. */
function guardedRunner(
  handlers: Record<string, (jobId: string) => Promise<void> | void>,
  options: { barrier?: DemoResetBarrier; cacheTtlMs?: number } = {},
): JobRunner {
  const runner = new JobRunner(ctx.queue, `barrier-test:${randomUUID()}`);
  for (const [type, handler] of Object.entries(handlers)) {
    runner.register(type, async (job) => {
      await handler(job.id);
    });
  }
  installDemoWorkerGuards(runner, {
    db: ctx.db,
    barrier: options.barrier ?? ctx.demoBarrier!,
    cacheTtlMs: options.cacheTtlMs ?? 0,
  });
  return runner;
}

async function makeDueFirst(jobId: string): Promise<void> {
  await ctx.pool.query(
    `UPDATE integration_jobs SET run_at = now() - interval '1 day' WHERE id = $1`,
    [jobId],
  );
}

async function jobRow(id: string) {
  return (await ctx.db.select().from(integrationJobs).where(eq(integrationJobs.id, id)))[0] ?? null;
}

async function customerExists(lastName: string): Promise<boolean> {
  const rows = await ctx.db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.lastName, lastName));
  return rows.length > 0;
}

function startSlowRequest(app: FastifyInstance, name: string) {
  slowGate = gate();
  slowRequestEndedAt = 0;
  const response = app.inject({
    method: 'POST',
    url: SLOW_ROUTE,
    headers: { cookie: adminCookie },
    payload: { name },
  });
  return { gate: slowGate, response };
}

function resetViaRoute(app: FastifyInstance, cookie: string) {
  return app.inject({
    method: 'POST',
    url: '/staff/demo/reset',
    headers: { cookie },
    payload: { confirmation: CONFIRMATION },
  });
}

function postCustomer(app: FastifyInstance, cookie: string, lastName: string) {
  return app.inject({
    method: 'POST',
    url: '/staff/customers',
    headers: { cookie },
    payload: { type: 'private', firstName: 'Barrier', lastName },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Phase 14 Final – Demo-Reset-Barrier (RB1–RB18)', () => {
  it(
    'RB1. Businessrequest blockiert > 1,2 s, Reset währenddessen: Phase B beginnt nicht vor dem Request-Ende; die Mutation des Requests wird danach mit gelöscht',
    async () => {
      const { gate: slow, response } = startSlowRequest(ctx.app, 'RB1');
      await slow.entered;
      expect(await sharedHeld()).toBe(1);
      const { reset, observed } = observingReset();
      const run = reset.reset({ actorId: adminId, now: new Date() });
      await sleep(BLOCK_MS);
      expect(await resetInProgress()).toBe(true); // Phase A committet
      expect(await exclusiveWaiting()).toBe(1); // Reset wartet an der Barrier
      expect(observed.wipeAt).toBe(0); // Phase B nicht begonnen
      slow.release();
      const reply = await response;
      expect(reply.statusCode).toBe(200);
      const result = await run;
      expect(result.ok).toBe(true);
      expect(observed.wipeAt).toBeGreaterThanOrEqual(slowRequestEndedAt);
      expect(result.barrierWaitMs).toBeGreaterThanOrEqual(BLOCK_MS - 50);
      expect(await customerExists('RB1')).toBe(false); // vor Phase B geschrieben ⇒ gelöscht
      await expectNoLeak();
    },
    RESET_TIMEOUT_MS,
  );

  it(
    'RB2. Jobhandler blockiert > 1,2 s: kein Wipe vor dem Handlerende; der Job endet regulär (succeeded)',
    async () => {
      const handlerGate = gate();
      let handlerEndedAt = 0;
      const runner = guardedRunner({
        'barrier.test.slow': async () => {
          handlerGate.markEntered();
          await handlerGate.released;
          handlerEndedAt = Date.now();
        },
      });
      const job = await ctx.queue.enqueue(
        'barrier.test.slow',
        {},
        { idempotencyKey: `rb2:${randomUUID()}` },
      );
      await makeDueFirst(job.jobId);
      const running = runner.runOnce();
      await handlerGate.entered;
      expect(await sharedHeld()).toBe(1);
      const { reset, observed } = observingReset();
      const run = reset.reset({ actorId: adminId, now: new Date() });
      await sleep(BLOCK_MS);
      expect(await exclusiveWaiting()).toBe(1);
      expect(observed.wipeAt).toBe(0);
      handlerGate.release();
      expect(await running).toBe('processed');
      expect((await run).ok).toBe(true);
      expect(observed.wipeAt).toBeGreaterThanOrEqual(handlerEndedAt);
      expect((await jobRow(job.jobId))?.status).toBe('succeeded');
      await expectNoLeak();
    },
    RESET_TIMEOUT_MS,
  );

  it(
    'RB3. geclaimter mail.send (echter Handler, Fake-Gateway hängt im Versand): Reset wartet; die Zustellung endet vor Phase B; nach Wipe/Neuseed kein weiterer Gateway-Aufruf für die alte Zustellung',
    async () => {
      const sendGate = gate();
      let sentAt = 0;
      class SlowGateway implements OutboundMailGateway {
        readonly kind = 'fake' as const;
        async send(message: OutboundMailMessage): Promise<OutboundMailOutcome> {
          sendGate.markEntered();
          await sendGate.released;
          const outcome = await ctx.mailGateway.send(message);
          sentAt = Date.now();
          return outcome;
        }
        verify() {
          return ctx.mailGateway.verify();
        }
      }
      const communication = createCommunicationContext(ctx.config, ctx.db, ctx.queue, {
        gateway: new SlowGateway(),
        storage: ctx.storage,
      });
      const runner = new JobRunner(ctx.queue, `barrier-mail:${randomUUID()}`);
      registerCommunicationJobHandlers(runner, { communication });
      installDemoWorkerGuards(runner, { db: ctx.db, barrier: ctx.demoBarrier!, cacheTtlMs: 0 });

      const enqueued = await ctx.communication.outbox.enqueueAndSchedule({
        kind: 'manual_customer_reply',
        recipient: { email: `rb3-${randomUUID().slice(0, 8)}@demo.test`, name: 'Barrier Test' },
        context: {
          salutation: 'Guten Tag,',
          processNumber: 'MR-2026-0001',
          body: 'Barrier-Test (synthetisch).',
          staffName: null,
        },
        idempotencyKey: `rb3:${randomUUID()}`,
      });
      expect(enqueued.status).toBe('pending');
      const jobs = await ctx.db
        .select({ id: integrationJobs.id })
        .from(integrationJobs)
        .where(eq(integrationJobs.idempotencyKey, mailSendJobKey(enqueued.deliveryId)));
      const mailJobId = jobs[0]?.id;
      expect(mailJobId).toBeDefined();
      await makeDueFirst(mailJobId!);
      const attemptsBefore = ctx.mailGateway.attempts.length;

      const running = runner.runOnce();
      await sendGate.entered; // Handler hält den Shared-Lock und hängt im Gateway
      expect(await sharedHeld()).toBe(1);
      const { reset, observed } = observingReset();
      const run = reset.reset({ actorId: adminId, now: new Date() });
      await sleep(BLOCK_MS);
      expect(await exclusiveWaiting()).toBe(1);
      expect(observed.wipeAt).toBe(0);
      expect(ctx.mailGateway.attempts.length).toBe(attemptsBefore);

      sendGate.release();
      expect(await running).toBe('processed');
      expect((await run).ok).toBe(true);
      // Die laufende Zustellung endete VOR Phase B; danach existieren weder Zeile noch Job.
      expect(sentAt).toBeGreaterThan(0);
      expect(observed.wipeAt).toBeGreaterThanOrEqual(sentAt);
      expect(ctx.mailGateway.attempts.length).toBe(attemptsBefore + 1);
      expect(
        await ctx.db
          .select({ id: mailDeliveries.id })
          .from(mailDeliveries)
          .where(eq(mailDeliveries.id, enqueued.deliveryId)),
      ).toEqual([]);
      expect(await jobRow(mailJobId!)).toBeNull();
      // Neuer Datensatz: kein weiterer Gateway-Aufruf für die alte Zustellung.
      while ((await runner.runOnce()) !== 'idle') {
        // Seed-Mails des neuen Datensatzes dürfen laufen (andere Zustellungen).
      }
      expect(
        ctx.mailGateway.attempts
          .slice(attemptsBefore + 1)
          .filter((m) => m.messageId.includes(enqueued.deliveryId)),
      ).toEqual([]);
      await expectNoLeak();
    },
    RESET_TIMEOUT_MS,
  );

  it('RB4. Request nach gesetztem reset_in_progress: 503 DEMO_RESET (Gate), keine Mutation, kein Lock', async () => {
    await setFlag(true);
    try {
      await sleep(1100); // Gate-Cache (TTL 1 s) sicher abgelaufen
      const blocked = await postCustomer(ctx.app, adminCookie, 'RB4');
      expect(blocked.statusCode).toBe(503);
      expect(blocked.headers['retry-after']).toBe('15');
      expect(blocked.json().error.code).toBe('DEMO_RESET');
      expect(await customerExists('RB4')).toBe(false);
      await expectNoLeak();
    } finally {
      await setFlag(false);
    }
  });

  it('RB5. Request sieht im Gate-Cache noch false, erwirbt den Shared-Lock, die ungecachte Zweitprüfung liest true ⇒ 503 DEMO_RESET, keine Mutation, Lock sofort frei', async () => {
    await sleep(1100); // Gate-Cache von RB4 („true“) abgelaufen
    // Gate-Cache mit „false“ füllen (eine gewöhnliche Mutation).
    expect((await postCustomer(ctx.app, adminCookie, 'RB5-warm')).statusCode).toBe(200);
    await setFlag(true);
    try {
      const blocked = await postCustomer(ctx.app, adminCookie, 'RB5');
      expect(blocked.statusCode).toBe(503);
      expect(blocked.json().error.code).toBe('DEMO_RESET');
      expect(await customerExists('RB5')).toBe(false);
      await expectNoLeak();
    } finally {
      await setFlag(false);
    }
  });

  it('RB6. Job sieht den Reset erst nach dem Lock-Erwerb (beforeRun-Cache noch false): defer ohne Attempt-Verbrauch, Handler läuft nicht, kein Lock', async () => {
    const handled: string[] = [];
    const runner = guardedRunner(
      {
        'barrier.test.rb6': async (id) => {
          handled.push(id);
        },
      },
      { cacheTtlMs: 1000 },
    );
    const warm = await ctx.queue.enqueue(
      'barrier.test.rb6',
      {},
      { idempotencyKey: `rb6:warm:${randomUUID()}` },
    );
    await makeDueFirst(warm.jobId);
    expect(await runner.runOnce()).toBe('processed'); // Cache: kein Reset
    await setFlag(true);
    try {
      const job = await ctx.queue.enqueue(
        'barrier.test.rb6',
        {},
        { idempotencyKey: `rb6:${randomUUID()}` },
      );
      await makeDueFirst(job.jobId);
      const before = Date.now();
      expect(await runner.runOnce()).toBe('deferred');
      expect(handled).toEqual([warm.jobId]);
      const row = await jobRow(job.jobId);
      expect(row).toMatchObject({ status: 'pending', attempts: 0 });
      expect(row!.runAt.getTime()).toBeGreaterThanOrEqual(before + 14_000);
      await expectNoLeak();
    } finally {
      await setFlag(false);
    }
  });

  describe('zwei Prozesse (zweite App / Worker-Runner auf derselben Datenbank)', () => {
    let ctxB: TestContext;
    let cookieB: string;

    beforeAll(async () => {
      ctxB = await createTestContext({ appEnv: 'demo' });
      cookieB = (await login(ctxB.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie;
    }, RESET_TIMEOUT_MS);

    afterAll(async () => {
      await destroyTestContext(ctxB);
    });

    it(
      'RB7. zwei API-Instanzen: ein laufender Request in A blockiert den Reset (Route) in B; nach dem Request-Ende läuft der Reset durch und löscht die Mutation aus A',
      async () => {
        const { gate: slow, response } = startSlowRequest(ctx.app, 'RB7');
        await slow.entered;
        const resetB = resetViaRoute(ctxB.app, cookieB);
        await waitFor(async () => (await exclusiveWaiting()) === 1);
        await sleep(BLOCK_MS);
        expect(await resetInProgress()).toBe(true);
        expect(await exclusiveWaiting()).toBe(1);
        expect(await sharedHeld()).toBe(1);
        let resetDone = false;
        void resetB.then(() => {
          resetDone = true;
        });
        await sleep(100);
        expect(resetDone).toBe(false);
        slow.release();
        expect((await withDiag('RB7 slow response', response)).statusCode).toBe(200);
        const reply = await withDiag('RB7 reset B', resetB, 120_000);
        expect(reply.statusCode).toBe(200);
        expect(reply.json().ok).toBe(true);
        expect(await customerExists('RB7')).toBe(false);
        await expectNoLeak();
        await expectNoLeak(ctxB.demoBarrier!);
      },
      RESET_TIMEOUT_MS,
    );

    it(
      'RB8. API + Worker: ein laufender Worker-Job (eigener Prozess/eigene Barrier) blockiert den Reset über die API-Route',
      async () => {
        const workerBarrier = new DemoResetBarrier({ databaseUrl: ctx.config.databaseUrl });
        try {
          const handlerGate = gate();
          const runner = guardedRunner(
            {
              'barrier.test.rb8': async () => {
                handlerGate.markEntered();
                await handlerGate.released;
              },
            },
            { barrier: workerBarrier },
          );
          const job = await ctx.queue.enqueue(
            'barrier.test.rb8',
            {},
            { idempotencyKey: `rb8:${randomUUID()}` },
          );
          await makeDueFirst(job.jobId);
          const running = runner.runOnce();
          await handlerGate.entered;
          const reset = resetViaRoute(ctx.app, adminCookie);
          await waitFor(async () => (await exclusiveWaiting()) === 1);
          await sleep(BLOCK_MS);
          expect(await sharedHeld()).toBe(1);
          expect(await exclusiveWaiting()).toBe(1);
          handlerGate.release();
          expect(await running).toBe('processed');
          const reply = await reset;
          expect(reply.statusCode).toBe(200);
          expect(reply.json().ok).toBe(true);
          await expectNoLeak();
          await expectNoLeak(workerBarrier);
        } finally {
          await workerBarrier.shutdown();
        }
      },
      RESET_TIMEOUT_MS,
    );

    it(
      'RB9. Exclusive verhindert Phase B, solange IRGENDEIN Shared-Lock existiert (zwei Inhaber aus zwei Barrier-Instanzen; erst der letzte gibt frei)',
      async () => {
        const first = (await ctx.demoBarrier!.tryAcquireShared()) as BarrierLease;
        const second = (await ctxB.demoBarrier!.tryAcquireShared()) as BarrierLease;
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        const { reset, observed } = observingReset();
        const run = reset.reset({ actorId: adminId, now: new Date() });
        await sleep(BLOCK_MS);
        expect(await exclusiveWaiting()).toBe(1);
        expect(observed.wipeAt).toBe(0);
        // Während ein Exclusive wartet, bekommt KEINE neue Mutation einen Shared-Lock (503).
        expect((await postCustomer(ctx.app, adminCookie, 'RB9')).statusCode).toBe(503);
        await first.release();
        await sleep(500);
        expect(observed.wipeAt).toBe(0);
        expect(await sharedHeld()).toBe(1);
        const releasedAt = Date.now();
        await second.release();
        expect((await run).ok).toBe(true);
        expect(observed.wipeAt).toBeGreaterThanOrEqual(releasedAt);
        expect(await customerExists('RB9')).toBe(false);
        await expectNoLeak();
        await expectNoLeak(ctxB.demoBarrier!);
      },
      RESET_TIMEOUT_MS,
    );
  });

  it(
    'RB-T1. Barrier-Timeout: enden laufende Mutationen nicht innerhalb barrierTimeoutMs, bricht der Reset fail-closed ab (DEMO_RESET_BARRIER_TIMEOUT, nie Phase B), markInterrupted (resetStale) + Audit demo.reset_failed mit errorClass; kein Lock bleibt zurück; ein erneuter Reset nach dem Ende der Mutation gelingt',
    async () => {
      const holder = (await ctx.demoBarrier!.tryAcquireShared()) as BarrierLease;
      expect(holder).not.toBeNull();
      // Direkt: acquireExclusive mit kurzem Timeout ⇒ DemoError, kein Exclusive-Lock übrig.
      await expect(ctx.demoBarrier!.acquireExclusive({ timeoutMs: 300 })).rejects.toMatchObject({
        demoCode: 'DEMO_RESET_BARRIER_TIMEOUT',
        code: 'CONFLICT',
      });
      expect(await barrierLocks()).toEqual([{ mode: 'ShareLock', granted: true }]);
      // Kompletter Reset mit kurzem Timeout: Phase A läuft, Phase B nie.
      const { reset, observed, dataset } = observingReset({ barrierTimeoutMs: 500 });
      const eventsBefore = (
        await ctx.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM staff_security_events`)
      ).rows[0]!.n;
      await expect(reset.reset({ actorId: adminId, now: new Date() })).rejects.toMatchObject({
        demoCode: 'DEMO_RESET_BARRIER_TIMEOUT',
      });
      expect(observed.wipeAt).toBe(0);
      const state = await dataset.state();
      expect(state.resetInProgress).toBe(true); // Flag bleibt (Gate fail-closed) …
      expect(state.resetStale).toBe(true); // … aber sofort erneut zurücksetzbar
      const failed = await ctx.pool.query<{ type: string; details: Record<string, unknown> }>(
        `SELECT type, details FROM staff_security_events ORDER BY created_at DESC, id DESC LIMIT 2`,
      );
      expect(failed.rows.map((r) => r.type).sort()).toEqual([
        'demo.reset_failed',
        'demo.reset_started',
      ]);
      const failedEvent = failed.rows.find((r) => r.type === 'demo.reset_failed')!;
      expect(failedEvent.details).toMatchObject({
        status: 'failed',
        errorClass: 'DEMO_RESET_BARRIER_TIMEOUT',
      });
      expect(Object.keys(failedEvent.details).sort()).toEqual([
        'datasetVersion',
        'errorClass',
        'resetRunId',
        'status',
      ]);
      expect(
        (
          await ctx.pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM staff_security_events`,
          )
        ).rows[0]!.n,
      ).toBe(eventsBefore + 2);
      expect(await barrierLocks()).toEqual([{ mode: 'ShareLock', granted: true }]);
      // Während des hängenden Flags: Mutationen 503 (Gate fail-closed).
      await sleep(1100);
      expect((await postCustomer(ctx.app, adminCookie, 'RB-T1')).statusCode).toBe(503);
      await holder.release();
      const retry = await observingReset().reset.reset({ actorId: adminId, now: new Date() });
      expect(retry.ok).toBe(true);
      expect((await dataset.state()).resetInProgress).toBe(false);
      await expectNoLeak();
    },
    RESET_TIMEOUT_MS,
  );

  it('RB10. Freigabe bei erfolgreicher Antwort (200): kein Advisory-Lock, keine entliehene Lock-Verbindung', async () => {
    expect((await postCustomer(ctx.app, adminCookie, 'RB10')).statusCode).toBe(200);
    expect(await customerExists('RB10')).toBe(true);
    await expectNoLeak();
  });

  it('RB11. Freigabe bei 4xx/Fachfehler (Validierung 400, Berechtigung 401)', async () => {
    const invalid = await ctx.app.inject({
      method: 'POST',
      url: '/staff/customers',
      headers: { cookie: adminCookie },
      payload: { type: 'unbekannt' },
    });
    expect(invalid.statusCode).toBe(400);
    const anonymous = await ctx.app.inject({
      method: 'POST',
      url: '/staff/customers',
      payload: { type: 'private', firstName: 'Barrier', lastName: 'RB11' },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(await customerExists('RB11')).toBe(false);
    await expectNoLeak();
  });

  it('RB12. Freigabe bei 500/Exception im Handler', async () => {
    const crashed = await ctx.app.inject({
      method: 'POST',
      url: THROW_ROUTE,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(crashed.statusCode).toBe(500);
    expect(crashed.json().error.code).toBe('INTERNAL_ERROR');
    await expectNoLeak();
  });

  it('RB13. Freigabe bei Jobfehler (Handler wirft ⇒ markFailed, Lock frei)', async () => {
    const runner = guardedRunner({
      'barrier.test.fail': async () => {
        throw new Error('synthetischer Jobfehler');
      },
    });
    const job = await ctx.queue.enqueue(
      'barrier.test.fail',
      {},
      { idempotencyKey: `rb13:${randomUUID()}` },
    );
    await makeDueFirst(job.jobId);
    expect(await runner.runOnce()).toBe('failed');
    expect((await jobRow(job.jobId))?.attempts).toBe(1);
    await expectNoLeak();
    await ctx.pool.query(`DELETE FROM integration_jobs WHERE id = $1`, [job.jobId]);
  });

  it('RB14. keine Pool-/Advisory-Lock-Leaks nach vielen parallelen Mutationen (Erfolg, 4xx, 500 gemischt)', async () => {
    const before = ctx.demoBarrier!.stats();
    const responses = await Promise.all([
      ...Array.from({ length: 6 }, (_, i) => postCustomer(ctx.app, adminCookie, `RB14-${i}`)),
      ...Array.from({ length: 3 }, () =>
        ctx.app.inject({
          method: 'POST',
          url: '/staff/customers',
          headers: { cookie: adminCookie },
          payload: {},
        }),
      ),
      ...Array.from({ length: 3 }, () =>
        ctx.app.inject({ method: 'POST', url: THROW_ROUTE, headers: { cookie: adminCookie } }),
      ),
    ]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([
      200, 200, 200, 200, 200, 200, 400, 400, 400, 500, 500, 500,
    ]);
    await expectNoLeak();
    const after = ctx.demoBarrier!.stats();
    expect(after.idleCount).toBe(after.totalCount);
    expect(after.totalCount).toBeGreaterThanOrEqual(before.totalCount);
  });

  it(
    'RB15. Fach-Pool mit max = 1: Mutation, Job und kompletter Reset laufen ohne Deadlock (Lock-Verbindungen kommen aus dem separaten Lock-Pool)',
    async () => {
      const small = await createTestContext({ appEnv: 'demo', poolMax: 1 });
      try {
        const cookie = (await login(small.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie;
        expect((await postCustomer(small.app, cookie, 'RB15')).statusCode).toBe(200);
        const handled: string[] = [];
        small.jobs.register('barrier.test.rb15', async (job) => {
          handled.push(job.id);
        });
        const job = await small.queue.enqueue(
          'barrier.test.rb15',
          {},
          { idempotencyKey: `rb15:${randomUUID()}` },
        );
        await makeDueFirst(job.jobId);
        expect(await small.jobs.runOnce()).toBe('processed');
        expect(handled).toEqual([job.jobId]);
        const result = await demoServicesFor(small).reset.reset({
          actorId: adminId,
          now: new Date(),
        });
        expect(result.ok).toBe(true);
        expect(await customerExists('RB15')).toBe(false);
        await expectNoLeak(small.demoBarrier!);
      } finally {
        await destroyTestContext(small);
      }
    },
    RESET_TIMEOUT_MS,
  );

  it(
    'RB16. die Reset-Route hält keinen Shared-Lock: während der Reset an einem fremden Shared-Inhaber wartet, existiert genau EIN Shared-Lock (der fremde) und ein wartender Exclusive',
    async () => {
      const holder = (await ctx.demoBarrier!.tryAcquireShared()) as BarrierLease;
      expect(holder).not.toBeNull();
      const reset = resetViaRoute(ctx.app, adminCookie);
      await waitFor(async () => (await exclusiveWaiting()) === 1);
      await sleep(500);
      expect(await barrierLocks()).toEqual([
        { mode: 'ExclusiveLock', granted: false },
        { mode: 'ShareLock', granted: true },
      ]);
      await holder.release();
      const reply = await reset;
      expect(reply.statusCode).toBe(200);
      expect(reply.json().ok).toBe(true);
      expect(reply.json().barrierWaitMs).toBeGreaterThanOrEqual(400);
      await expectNoLeak();
    },
    RESET_TIMEOUT_MS,
  );

  it(
    'RB17. nach dem Reset laufen neue Requests und Jobs normal auf dem neuen Datensatz (neue Epoch, Flag frei, 200 statt 503)',
    async () => {
      const epochBefore = await new DemoDatasetService(ctx.db).datasetEpoch();
      const reply = await resetViaRoute(ctx.app, adminCookie);
      expect(reply.statusCode).toBe(200);
      expect(await resetInProgress()).toBe(false);
      expect(await new DemoDatasetService(ctx.db).datasetEpoch()).not.toBe(epochBefore);
      expect((await postCustomer(ctx.app, adminCookie, 'RB17')).statusCode).toBe(200);
      expect(await customerExists('RB17')).toBe(true);
      const handled: string[] = [];
      const runner = guardedRunner({
        'barrier.test.rb17': async (id) => {
          handled.push(id);
        },
      });
      const job = await ctx.queue.enqueue(
        'barrier.test.rb17',
        {},
        { idempotencyKey: `rb17:${randomUUID()}` },
      );
      await makeDueFirst(job.jobId);
      expect(await runner.runOnce()).toBe('processed');
      expect(handled).toEqual([job.jobId]);
      await expectNoLeak();
    },
    RESET_TIMEOUT_MS,
  );

  it(
    'RB18. ein alter processing-Job (Lease abgelaufen) wird nach dem Reset nie auf den neuen Seed angewendet: beforeRun-Guard beendet ihn als dead/DEMO_DATASET_CHANGED, Handler läuft nicht, kein Lock',
    async () => {
      const old = await ctx.queue.enqueue(
        'mail.send',
        { deliveryId: randomUUID() },
        { idempotencyKey: `rb18:${randomUUID()}` },
      );
      const zombie = new PostgresJobQueue(ctx.pool, { leaseMs: 1 });
      await makeDueFirst(old.jobId);
      const claimed = await zombie.claimNext('zombie');
      expect(claimed?.id).toBe(old.jobId);
      expect((await jobRow(old.jobId))?.status).toBe('processing');

      const reply = await resetViaRoute(ctx.app, adminCookie);
      expect(reply.statusCode).toBe(200);
      expect((await jobRow(old.jobId))?.status).toBe('processing'); // laufende Jobs bleiben
      await zombie.reclaimExpired();
      expect((await jobRow(old.jobId))?.status).toBe('pending');

      const handled: string[] = [];
      const runner = guardedRunner({
        'mail.send': async (id) => {
          handled.push(id);
        },
      });
      await makeDueFirst(old.jobId);
      expect(await runner.runOnce()).toBe('skipped');
      expect(handled).toEqual([]);
      expect(await jobRow(old.jobId)).toMatchObject({
        status: 'dead',
        lastError: DEMO_DATASET_CHANGED_REASON,
      });
      await expectNoLeak();
    },
    RESET_TIMEOUT_MS,
  );
});
