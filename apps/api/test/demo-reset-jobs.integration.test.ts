import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  appointments,
  bookings,
  demoDatasetState,
  documents,
  integrationJobs,
  mailDeliveries,
  processes,
  rentalReturns,
  settlements,
  staffSecurityEvents,
  vouchers,
} from '@mietroyal/database';
import { JobRunner, PostgresJobQueue, type StorageProvider } from '@mietroyal/integrations';
import type { PermissionKey } from '@mietroyal/permissions';
import { and, eq, inArray, lt } from 'drizzle-orm';
import webpush from 'web-push';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomerActionLinkService } from '../src/communication/action-links/service.ts';
import { buildPushPayload } from '../src/communication/push/payload.ts';
import { PushService } from '../src/communication/push/push-service.ts';
import { DEMO_DATASET_VERSION, DemoDatasetService } from '../src/demo/dataset.ts';
import {
  DEMO_BUSINESS_JOB_TYPES,
  DEMO_DATASET_CHANGED_REASON,
  DEMO_STORAGE_CLEANUP_JOB_TYPE,
  isDemoDatasetBoundJob,
} from '../src/demo/job-types.ts';
import { createDemoResetGate } from '../src/demo/reset-gate.ts';
import {
  DEMO_BUSINESS_TABLES_DELETE_ORDER,
  DEMO_RESET_ADVISORY_LOCK_KEY,
  DemoResetService,
  errorClassOf,
} from '../src/demo/reset-service.ts';
import { DEMO_SEED_KEYS } from '../src/demo/seed/data.ts';
import { DEMO_MESSAGES, DemoError } from '../src/demo/types.ts';
import {
  createDemoDatasetChangeSource,
  createDemoJobGuard,
  createDemoStorageCleanupHandler,
  demoStorageCleanupJobKey,
  enqueueDemoStorageCleanup,
} from '../src/jobs/demo.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  destroyTestContext,
  login,
  type TestContext,
} from './auth-helpers.ts';
import { createCommerceWorld, commerceServices } from './commerce-helpers.ts';
import { createStaffWithPermissions } from './crm-helpers.ts';
import {
  createDemoTestContext,
  demoServicesFor,
  demoTestNow,
  freshDemoDatabase,
  type DemoTestServices,
} from './demo-helpers.ts';
import { withEnvApp } from './env-app-helpers.ts';
import { issueTestVoucher } from './voucher-helpers.ts';

/**
 * Phase 14 (RESET, Order §21/§22/§31/§93, Design Teil 2 §2.1–§2.4): Jobs, Outbox,
 * Storage-Nachbereinigung, Audit und Business-Tokens rund um den Demo-Reset.
 * Pflichttests T53–T59 (§103) plus dünne Mapping-Tests T35–T52/T57, die auf die
 * bestehenden Assertions in demo-reset / demo-platform verweisen und je eine
 * eigene, günstige Prüfung ausführen. Läuft gegen eine eigene Test-DB.
 */

const RESET_TIMEOUT_MS = 180_000;

let ctx: TestContext;
let demo: DemoTestServices;
let adminId: string;
let adminCookie: string;
const now = demoTestNow();

beforeAll(async () => {
  ctx = await createDemoTestContext();
  demo = demoServicesFor(ctx);
  ({ adminId } = await freshDemoDatabase(ctx));
  await demo.seed.seed({ actorId: adminId, now });
  adminCookie = (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie;
}, 180_000);

afterAll(async () => {
  await destroyTestContext(ctx);
});

async function count(table: string): Promise<number> {
  const result = await ctx.pool.query(`SELECT count(*)::int AS n FROM "${table}"`);
  return result.rows[0].n as number;
}

async function resolveId(seedKey: string): Promise<string> {
  const ref = await demo.registry.resolve(seedKey);
  if (ref === null) throw new Error(`Seed-Schlüssel ${seedKey} fehlt`);
  return ref.entityId;
}

async function jobRow(id: string) {
  const rows = await ctx.db.select().from(integrationJobs).where(eq(integrationJobs.id, id));
  return rows[0] ?? null;
}

async function lastResetStartedAt(): Promise<Date> {
  const value = await demo.dataset.lastResetStartedAt();
  if (value === null) throw new Error('last_reset_started_at fehlt');
  return value;
}

/**
 * Business-Jobs, die VOR dem letzten Reset-Beginn eingereiht wurden und noch
 * ausführbar sind (pending/processing) – nach einem Reset darf es keine geben:
 * gelöscht in Phase B oder vom Guard als dead/DEMO_DATASET_CHANGED beendet.
 */
async function staleBusinessJobs() {
  const since = await lastResetStartedAt();
  return ctx.db
    .select({ id: integrationJobs.id, type: integrationJobs.type, status: integrationJobs.status })
    .from(integrationJobs)
    .where(
      and(
        inArray(integrationJobs.type, [...DEMO_BUSINESS_JOB_TYPES]),
        lt(integrationJobs.createdAt, since),
        inArray(integrationJobs.status, ['pending', 'processing']),
      ),
    );
}

/** Guard-Runner wie der Demo-Worker (Gate + Zeitstempel-Skip, Caches 0 für Tests). */
function guardedRunner(handlers: Record<string, (jobId: string) => void>) {
  const dataset = new DemoDatasetService(ctx.db);
  const runner = new JobRunner(ctx.queue, `demo-jobs-test:${randomUUID()}`);
  for (const [type, handler] of Object.entries(handlers)) {
    runner.register(type, async (job) => handler(job.id));
  }
  runner.setBeforeRun(
    createDemoJobGuard(createDemoResetGate({ dataset, cacheTtlMs: 0 }), {
      datasetChange: createDemoDatasetChangeSource(dataset, { cacheTtlMs: 0 }),
    }),
  );
  return runner;
}

/** Job als frühesten fälligen markieren (claimNext ordnet nach run_at) – ändert nichts an created_at. */
async function makeDueFirst(jobId: string): Promise<void> {
  await ctx.pool.query(
    `UPDATE integration_jobs SET run_at = now() - interval '1 day' WHERE id = $1`,
    [jobId],
  );
}

/** „Zombie“-Worker: beansprucht einen Job mit sofort ablaufender Lease (überlebt den Wipe als processing). */
async function claimAsZombie(jobId: string): Promise<PostgresJobQueue> {
  const zombie = new PostgresJobQueue(ctx.pool, { leaseMs: 1 });
  await makeDueFirst(jobId);
  const claimed = await zombie.claimNext('zombie');
  if (claimed === null || claimed.id !== jobId) throw new Error('Zombie-Claim fehlgeschlagen');
  return zombie;
}

async function drainTestRunner(): Promise<void> {
  while ((await ctx.jobs.runOnce()) !== 'idle') {
    // weiter
  }
}

describe('Phase 14 – Demo-Reset: Jobs, Outbox, Storage, Audit, Tokens (RESET)', () => {
  it(
    'T53. alte Jobs neutralisiert: ein beim Reset laufender (processing) Business-Job des alten Datensatzes wird nach dem Reset vom Worker-Guard als dead/DEMO_DATASET_CHANGED beendet, der Handler nie aufgerufen; pending Business-Jobs werden gelöscht; neue Jobs laufen',
    async () => {
      const oldProcessing = await ctx.queue.enqueue(
        'mail.send',
        { deliveryId: randomUUID() },
        { idempotencyKey: `t53:processing:${randomUUID()}` },
      );
      const oldPending = await ctx.queue.enqueue(
        'push.send',
        { deliveryId: randomUUID() },
        { idempotencyKey: `t53:pending:${randomUUID()}` },
      );
      const zombie = await claimAsZombie(oldProcessing.jobId);
      expect((await jobRow(oldProcessing.jobId))?.status).toBe('processing');

      const result = await demo.reset.reset({ actorId: adminId, now: new Date() });
      expect(result.ok).toBe(true);

      // Pending Business-Job des alten Datensatzes: gelöscht (Phase B); laufender überlebt als processing.
      expect(await jobRow(oldPending.jobId)).toBeNull();
      expect((await jobRow(oldProcessing.jobId))?.status).toBe('processing');
      // Lease abgelaufen ⇒ Crash-Recovery gibt ihn frei (pending, Versuch übrig).
      const reclaimed = await zombie.reclaimExpired();
      expect(reclaimed.reclaimed).toBeGreaterThanOrEqual(1);
      expect((await jobRow(oldProcessing.jobId))?.status).toBe('pending');
      const row = await jobRow(oldProcessing.jobId);
      expect(row!.createdAt.getTime()).toBeLessThan((await lastResetStartedAt()).getTime());

      const handled: string[] = [];
      const runner = guardedRunner({
        'mail.send': (id) => handled.push(id),
        'push.send': (id) => handled.push(id),
      });
      await makeDueFirst(oldProcessing.jobId);
      expect(await runner.runOnce()).toBe('skipped');
      expect(handled).toEqual([]);
      expect(await jobRow(oldProcessing.jobId)).toMatchObject({
        status: 'dead',
        lastError: DEMO_DATASET_CHANGED_REASON,
      });

      // Neuer Business-Job (nach dem Reset eingereiht) läuft normal.
      const fresh = await ctx.queue.enqueue(
        'push.send',
        { deliveryId: randomUUID() },
        { idempotencyKey: `t53:fresh:${randomUUID()}` },
      );
      await makeDueFirst(fresh.jobId);
      expect(await runner.runOnce()).toBe('processed');
      expect(handled).toEqual([fresh.jobId]);
      // Infrastruktur-Jobs sind nie datensatzgebunden.
      expect(isDemoDatasetBoundJob('system.heartbeat', {})).toBe(false);
      expect(isDemoDatasetBoundJob('communication.scan_due', {})).toBe(false);
      expect(isDemoDatasetBoundJob('mail.inbound_poll', {})).toBe(false);
      expect(isDemoDatasetBoundJob(DEMO_STORAGE_CLEANUP_JOB_TYPE, { keys: [] })).toBe(false);
      expect(isDemoDatasetBoundJob('communication.cleanup_retention', { scope: 'backstop' })).toBe(
        false,
      );
      expect(isDemoDatasetBoundJob('communication.cleanup_retention', { scope: 'photos' })).toBe(
        true,
      );
      expect(isDemoDatasetBoundJob('mail.send', {})).toBe(true);
    },
    RESET_TIMEOUT_MS,
  );

  it(
    'T54. alte Outbox neutralisiert: mail_deliveries/push_deliveries/whatsapp_events des alten Datensatzes sind weg; ein überlebender mail.send-Job des alten Datensatzes löst keinen Gateway-Aufruf aus (Handler endet ohne Zustellung)',
    async () => {
      const oldMailIds = (await ctx.db.select({ id: mailDeliveries.id }).from(mailDeliveries)).map(
        (row) => row.id,
      );
      expect(oldMailIds.length).toBeGreaterThan(0);
      const push = new PushService(ctx.db, ctx.queue);
      const delivery = await push.enqueue({
        kind: 'session_new_device_login',
        userId: adminId,
        idempotencyKey: `t54:push:${randomUUID()}`,
        payload: buildPushPayload({ kind: 'session_new_device_login' }),
      });
      expect(await count('push_deliveries')).toBeGreaterThanOrEqual(1);
      // Alter mail.send-Job auf eine Zustellung des alten Datensatzes, beim Reset „laufend“.
      const oldMailJob = await ctx.queue.enqueue(
        'mail.send',
        { deliveryId: oldMailIds[0] },
        { idempotencyKey: `t54:mail:${randomUUID()}` },
      );
      const zombie = await claimAsZombie(oldMailJob.jobId);
      const attemptsBefore = ctx.mailGateway.attempts.length;

      await demo.reset.reset({ actorId: adminId, now: new Date() });

      const remainingOld = await ctx.db
        .select({ id: mailDeliveries.id })
        .from(mailDeliveries)
        .where(inArray(mailDeliveries.id, oldMailIds));
      expect(remainingOld).toHaveLength(0);
      const pushRows = await ctx.pool.query(`SELECT id FROM push_deliveries WHERE id = $1`, [
        delivery.deliveryId,
      ]);
      expect(pushRows.rows).toHaveLength(0);
      expect(await count('whatsapp_events')).toBe(0);
      // Push-Geräte (push_subscriptions) bleiben – Geräte sind keine Business-Daten (D-R2).
      // Überlebender mail.send-Job: ohne Guard ausgeführt ⇒ Handler findet keine Zustellung ⇒ kein Versand.
      await zombie.reclaimExpired();
      await makeDueFirst(oldMailJob.jobId);
      await drainTestRunner();
      expect(ctx.mailGateway.attempts.length).toBe(attemptsBefore);
      expect(ctx.mailGateway.sent.length).toBe(0);
      const after = await jobRow(oldMailJob.jobId);
      expect(after?.status === 'succeeded' || after?.status === 'dead').toBe(true);
    },
    RESET_TIMEOUT_MS,
  );

  it('T53b. nach dem Reset existieren nur neue Business-Jobs: jeder verbliebene Business-Job hat created_at ≥ Reset-Beginn (außer vom Guard beendete)', async () => {
    const stale = await staleBusinessJobs();
    expect(stale).toEqual([]);
    const state = await demo.dataset.state();
    expect(state.lastResetStartedAt).not.toBeNull();
    expect(state.resetInProgress).toBe(false);
    // Nach einem beendeten Reset bleibt der Zeitstempel stehen (anders als reset_started_at).
    expect(state.resetStartedAt).toBeNull();
    const [row] = await ctx.db.select().from(demoDatasetState).where(eq(demoDatasetState.id, 1));
    expect(row!.lastResetStartedAt?.getTime()).toBe(state.lastResetStartedAt?.getTime());
  });

  it(
    'T55. alte Business-Tokens tot: Angebots-Token, Kontakt-Aktionstoken, Dokument-Token und Gutschein des alten Datensatzes sind nach dem Reset ungültig (404/≥400); der Kalender-Feed-Token bleibt gültig und liefert nur Termine des neuen Datensatzes',
    async () => {
      // Angebots- und Dokument-Token des alten Datensatzes (eigene Testwelt im Demo-Kontext).
      const world = await createCommerceWorld(ctx, adminId);
      const services = commerceServices(ctx);
      const { versionId } = await services.offers.createOffer(adminId, world.processId);
      const effective = await ctx.auth.effectivePermissions(adminId);
      const { token: offerToken } = await services.offers.send(adminId, versionId, effective);
      expect(
        (await ctx.app.inject({ method: 'GET', url: `/public/offers/${offerToken}` })).statusCode,
      ).toBe(200);
      const [offerDocument] = await ctx.db
        .select()
        .from(documents)
        .where(eq(documents.offerVersionId, versionId));
      const documentLink = await ctx.transactional.documentLinks.issue({
        documentId: offerDocument!.id,
        processId: world.processId,
        customerId: world.customerId,
      });
      expect(
        (await ctx.app.inject({ method: 'GET', url: `/public/documents/${documentLink.token}` }))
          .statusCode,
      ).toBe(200);
      // Kontakt-Aktionstoken auf einen Liefertermin des Seeds.
      const deliveryProcessId = await resolveId(DEMO_SEED_KEYS.processBookingAcceptedDelivery);
      const [deliveryBooking] = await ctx.db
        .select({ id: bookings.id, customerId: processes.customerId })
        .from(bookings)
        .innerJoin(processes, eq(processes.id, bookings.processId))
        .where(eq(bookings.processId, deliveryProcessId));
      const deliveryAppointmentId = await resolveId(DEMO_SEED_KEYS.appointmentDeliveryToday);
      const actionLinks = new CustomerActionLinkService(ctx.db);
      const action = await actionLinks.issue({
        purpose: 'delivery_contact_update',
        processId: deliveryProcessId,
        customerId: deliveryBooking!.customerId,
        bookingId: deliveryBooking!.id,
        appointmentId: deliveryAppointmentId,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      });
      const actionBefore = await ctx.app.inject({
        method: 'GET',
        url: `/public/actions/${action.token}`,
      });
      expect([200, 404]).toContain(actionBefore.statusCode); // Cutoff 1 h vor Termin möglich
      // Gutschein des alten Datensatzes (Rückgabe mit Abrechnung des Seeds).
      const damageProcessId = await resolveId(DEMO_SEED_KEYS.processReturnDamage);
      const [damageBooking] = await ctx.db
        .select({ id: bookings.id, customerId: processes.customerId })
        .from(bookings)
        .innerJoin(processes, eq(processes.id, bookings.processId))
        .where(eq(bookings.processId, damageProcessId));
      const [damageReturn] = await ctx.db
        .select({ id: rentalReturns.id })
        .from(rentalReturns)
        .where(eq(rentalReturns.bookingId, damageBooking!.id));
      const [damageSettlement] = await ctx.db
        .select({ id: settlements.id })
        .from(settlements)
        .where(eq(settlements.bookingId, damageBooking!.id));
      const voucher = await issueTestVoucher(ctx, {
        customerId: damageBooking!.customerId,
        originProcessId: damageProcessId,
        originBookingId: damageBooking!.id,
        originReturnId: damageReturn!.id,
        originSettlementId: damageSettlement!.id,
      });
      // Kalender-Feed-Token (Staff-gebunden) vor dem Reset.
      const feed = await ctx.app.inject({
        method: 'POST',
        url: '/staff/calendar/feed',
        headers: { cookie: adminCookie },
      });
      expect(feed.statusCode).toBe(200);
      const feedToken = (feed.json() as { url: string }).url.match(
        /\/public\/calendar\/([^/]+)$/,
      )![1]!;
      const feedBefore = await ctx.app.inject({
        method: 'GET',
        url: `/public/calendar/${feedToken}`,
      });
      expect(feedBefore.statusCode).toBe(200);
      const uidsBefore = [...feedBefore.body.matchAll(/^UID:([0-9a-f-]{36})@miet-royal/gm)].map(
        (m) => m[1]!,
      );
      const oldAppointmentIds = new Set(
        (await ctx.db.select({ id: appointments.id }).from(appointments)).map((row) => row.id),
      );

      await demo.reset.reset({ actorId: adminId, now: new Date() });

      expect(
        (await ctx.app.inject({ method: 'GET', url: `/public/offers/${offerToken}` })).statusCode,
      ).toBe(404);
      expect(
        (await ctx.app.inject({ method: 'GET', url: `/public/offers/${offerToken}/pdf` }))
          .statusCode,
      ).toBe(404);
      expect(
        (await ctx.app.inject({ method: 'GET', url: `/public/documents/${documentLink.token}` }))
          .statusCode,
      ).toBe(404);
      expect(
        (await ctx.app.inject({ method: 'GET', url: `/public/actions/${action.token}` }))
          .statusCode,
      ).toBe(404);
      expect(
        await ctx.db.select().from(vouchers).where(eq(vouchers.id, voucher.voucherId)),
      ).toHaveLength(0);
      // Gutscheincode auf einem neuen Entwurf des neuen Datensatzes: ungültig (nie „applied“).
      const draftProcessId = await resolveId(DEMO_SEED_KEYS.processOfferDraft);
      const [draftVersion] = await ctx.pool
        .query<{ id: string }>(
          `SELECT ov.id FROM offer_versions ov JOIN offers o ON o.id = ov.offer_id WHERE o.process_id = $1 ORDER BY ov.version_number DESC LIMIT 1`,
          [draftProcessId],
        )
        .then((r) => r.rows);
      const applied = await ctx.app.inject({
        method: 'POST',
        url: `/staff/offer-versions/${draftVersion!.id}/voucher`,
        headers: { cookie: adminCookie },
        payload: { code: voucher.code },
      });
      expect(applied.statusCode).toBeGreaterThanOrEqual(400);
      expect(applied.json()).not.toMatchObject({ applied: true });
      // Kalender-Feed: Token bleibt (Staff-gebunden), liefert nur Termine des neuen Datensatzes.
      const feedAfter = await ctx.app.inject({
        method: 'GET',
        url: `/public/calendar/${feedToken}`,
      });
      expect(feedAfter.statusCode).toBe(200);
      const uidsAfter = [...feedAfter.body.matchAll(/^UID:([0-9a-f-]{36})@miet-royal/gm)].map(
        (m) => m[1]!,
      );
      for (const uid of uidsAfter) expect(oldAppointmentIds.has(uid)).toBe(false);
      for (const uid of uidsBefore) expect(uidsAfter).not.toContain(uid);
      const newAppointmentIds = new Set(
        (await ctx.db.select({ id: appointments.id }).from(appointments)).map((row) => row.id),
      );
      for (const uid of uidsAfter) expect(newAppointmentIds.has(uid)).toBe(true);
      expect(await count('calendar_feed_tokens')).toBe(1);
    },
    RESET_TIMEOUT_MS,
  );

  it(
    'T56. Storage: alte Referenzen weg (D-R9/D-R10 decken Löschung und Neuanlage ab); scheitert das Löschen einzelner Objekte, entsteht genau ein Job demo.storage_cleanup mit exakt den fehlgeschlagenen Schlüsseln, der neue Datensatz bleibt konsistent, und der Handler löscht die Objekte beim nächsten Lauf; Status zählt pending/dead',
    async () => {
      const keysBefore = (
        await ctx.db.select({ storageKey: documents.storageKey }).from(documents)
      ).map((row) => row.storageKey);
      expect(keysBefore.length).toBeGreaterThanOrEqual(3);
      const failing = new Set(keysBefore.slice(0, 2));
      const deleteCalls: string[] = [];
      const storage: StorageProvider = {
        put: (key, data, options) => ctx.storage.put(key, data, options),
        get: (key) => ctx.storage.get(key),
        exists: (key) => ctx.storage.exists(key),
        async delete(key) {
          deleteCalls.push(key);
          if (failing.has(key)) {
            const error = new Error('S3 nicht erreichbar (synthetisch)');
            error.name = 'StorageUnavailableError';
            throw error;
          }
          await ctx.storage.delete(key);
        },
      };
      const reset = new DemoResetService({
        db: ctx.db,
        config: ctx.config,
        storage,
        queue: ctx.queue,
        dataset: demo.dataset,
        registry: demo.registry,
        seed: demo.seed,
        settleDelayMs: 0,
        fkRetryDelayMs: 0,
      });
      const eventsBefore = await count('staff_security_events');

      const result = await reset.reset({ actorId: adminId, now: new Date() });
      expect(result.ok).toBe(true);
      for (const key of keysBefore) expect(deleteCalls).toContain(key);
      // Alte Objekte: nur die fehlgeschlagenen existieren noch, keine DB-Zeile referenziert sie.
      for (const key of keysBefore) {
        expect(await ctx.storage.exists(key)).toBe(failing.has(key));
      }
      const referenced = await ctx.db
        .select({ storageKey: documents.storageKey })
        .from(documents)
        .where(inArray(documents.storageKey, keysBefore));
      expect(referenced).toEqual([]);
      // Genau ein Cleanup-Job (≤ 100 Schlüssel) mit exakt den fehlgeschlagenen Schlüsseln.
      const started = (await ctx.db.select().from(staffSecurityEvents))
        .filter((event) => event.type === 'demo.reset_started')
        .at(-1)!;
      const resetRunId = (started.details as { resetRunId: string }).resetRunId;
      const jobs = await ctx.db
        .select()
        .from(integrationJobs)
        .where(eq(integrationJobs.type, DEMO_STORAGE_CLEANUP_JOB_TYPE));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.idempotencyKey).toBe(demoStorageCleanupJobKey(resetRunId, 0));
      expect(jobs[0]!.status).toBe('pending');
      const payload = jobs[0]!.payload as { resetRunId: string; keys: string[] };
      expect(payload.resetRunId).toBe(resetRunId);
      expect([...payload.keys].sort()).toEqual([...failing].sort());
      expect(await count('staff_security_events')).toBe(eventsBefore + 2);
      // Status-Endpunkt zählt den ausstehenden Job.
      const statusPending = await ctx.app.inject({
        method: 'GET',
        url: '/staff/demo/status',
        headers: { cookie: adminCookie },
      });
      expect(statusPending.json().storageCleanup).toEqual({ pendingJobs: 1, deadJobs: 0 });
      // Nächster Lauf (Test-Runner hat den Handler wie Worker/API): Objekte weg, Job erledigt.
      await makeDueFirst(jobs[0]!.id);
      expect(await ctx.jobs.runOnce()).toBe('processed');
      for (const key of failing) expect(await ctx.storage.exists(key)).toBe(false);
      expect((await jobRow(jobs[0]!.id))?.status).toBe('succeeded');
      // Ein zweiter Lauf desselben Jobs wäre idempotent (fehlende Objekte gelten als erledigt).
      const handler = createDemoStorageCleanupHandler(ctx.storage);
      await expect(
        handler({
          id: 'x',
          type: DEMO_STORAGE_CLEANUP_JOB_TYPE,
          payload,
          idempotencyKey: 'x',
          attempts: 1,
          maxAttempts: 5,
          claimedBy: 'test',
        }),
      ).resolves.toBeUndefined();
      // Dauerhaft scheiternd ⇒ Fehler (Retry/dead), Status zählt dead-Jobs; Infrastruktur-Jobtyp (nie in der Löschliste).
      await expect(
        createDemoStorageCleanupHandler(storage)({
          id: 'y',
          type: DEMO_STORAGE_CLEANUP_JOB_TYPE,
          payload: { resetRunId, keys: [...failing] },
          idempotencyKey: 'y',
          attempts: 5,
          maxAttempts: 5,
          claimedBy: 'test',
        }),
      ).rejects.toMatchObject({ name: 'DemoStorageCleanupError' });
      await ctx.pool.query(
        `UPDATE integration_jobs SET status = 'dead', last_error = 'x' WHERE id = $1`,
        [jobs[0]!.id],
      );
      const statusDead = await ctx.app.inject({
        method: 'GET',
        url: '/staff/demo/status',
        headers: { cookie: adminCookie },
      });
      expect(statusDead.json().storageCleanup).toEqual({ pendingJobs: 0, deadJobs: 1 });
      expect(DEMO_BUSINESS_JOB_TYPES).not.toContain(DEMO_STORAGE_CLEANUP_JOB_TYPE);
      // Mehr als 100 Schlüssel ⇒ mehrere Jobs mit fortlaufendem Batch-Index.
      const many = Array.from({ length: 150 }, (_, index) => `documents/t56/${index}.pdf`);
      const ids = await enqueueDemoStorageCleanup(ctx.queue, { resetRunId: 'run-t56', keys: many });
      expect(ids).toHaveLength(2);
      await ctx.pool.query(
        `DELETE FROM integration_jobs WHERE idempotency_key LIKE 'demo-storage-cleanup:run-t56:%'`,
      );
      await ctx.pool.query(`DELETE FROM integration_jobs WHERE id = $1`, [jobs[0]!.id]);
    },
    RESET_TIMEOUT_MS,
  );

  it(
    'T58. Audit: demo.reset_started nach Phase A und demo.reset_completed nach Phase D mit derselben resetRunId, Actor und Session; Details ausschließlich { resetRunId, datasetVersion, status } (Order §31); Hook beforeBusinessWipe läuft genau einmal in Phase B (T51/T52-Hook-Punkt)',
    async () => {
      const sessionId = randomUUID();
      let hookCalls = 0;
      const withHook = demoServicesFor(ctx, {
        hooks: {
          beforeBusinessWipe: async () => {
            hookCalls += 1;
          },
        },
      });
      const before = (await ctx.db.select().from(staffSecurityEvents)).length;
      await withHook.reset.reset({ actorId: adminId, sessionId, now: new Date() });
      const events = (
        await ctx.db.select().from(staffSecurityEvents).orderBy(staffSecurityEvents.createdAt)
      )
        .slice(before)
        .filter((event) => event.type.startsWith('demo.'));
      expect(events.map((event) => event.type)).toEqual([
        'demo.reset_started',
        'demo.reset_completed',
      ]);
      const [started, completed] = events;
      const startedDetails = started!.details as Record<string, unknown>;
      const completedDetails = completed!.details as Record<string, unknown>;
      expect(Object.keys(startedDetails).sort()).toEqual([
        'datasetVersion',
        'resetRunId',
        'status',
      ]);
      expect(Object.keys(completedDetails).sort()).toEqual([
        'datasetVersion',
        'resetRunId',
        'status',
      ]);
      expect(startedDetails).toMatchObject({
        datasetVersion: DEMO_DATASET_VERSION,
        status: 'started',
      });
      expect(completedDetails).toMatchObject({
        datasetVersion: DEMO_DATASET_VERSION,
        status: 'completed',
      });
      expect(startedDetails.resetRunId).toMatch(/^[0-9a-f-]{36}$/);
      expect(completedDetails.resetRunId).toBe(startedDetails.resetRunId);
      for (const event of events) {
        expect(event.actorUserId).toBe(adminId);
        expect(event.sessionId).toBe(sessionId);
        expect(event.targetUserId).toBeNull();
      }
      expect(hookCalls).toBe(1);
    },
    RESET_TIMEOUT_MS,
  );

  it(
    'T59. Fehler ⇒ demo.reset_failed: wirft der Hook in Phase B, entsteht ein Audit-Event mit technischer Fehlerklasse (Name bzw. SQLSTATE), ohne Fehlermeldung; Flag bleibt gesetzt (stale), der nächste Reset gelingt',
    async () => {
      const secret = 'Kundendaten-in-der-Meldung-niemals-im-Audit';
      const failing = demoServicesFor(ctx, {
        hooks: {
          beforeBusinessWipe: async () => {
            const error = new Error(secret);
            error.name = 'TrainingHookFailure';
            throw error;
          },
        },
      });
      const before = (await ctx.db.select().from(staffSecurityEvents)).length;
      await expect(failing.reset.reset({ actorId: adminId, now: new Date() })).rejects.toThrow(
        secret,
      );
      const events = (
        await ctx.db.select().from(staffSecurityEvents).orderBy(staffSecurityEvents.createdAt)
      )
        .slice(before)
        .filter((event) => event.type.startsWith('demo.'));
      expect(events.map((event) => event.type)).toEqual([
        'demo.reset_started',
        'demo.reset_failed',
      ]);
      const failedDetails = events[1]!.details as Record<string, unknown>;
      expect(Object.keys(failedDetails).sort()).toEqual([
        'datasetVersion',
        'errorClass',
        'resetRunId',
        'status',
      ]);
      expect(failedDetails).toMatchObject({ status: 'failed', errorClass: 'TrainingHookFailure' });
      expect(failedDetails.resetRunId).toBe(
        (events[0]!.details as { resetRunId: string }).resetRunId,
      );
      expect(JSON.stringify(events)).not.toContain(secret);
      expect((await demo.dataset.state()).resetStale).toBe(true);
      // SQLSTATE-Fehler werden als Klasse SQLSTATE_<code> geführt (nie die Meldung).
      expect(
        errorClassOf(Object.assign(new Error('duplicate key value "geheim"'), { code: '23505' })),
      ).toBe('SQLSTATE_23505');
      expect(errorClassOf({ cause: { code: '23503' } })).toBe('SQLSTATE_23503');
      expect(errorClassOf(new TypeError('x'))).toBe('TypeError');
      expect(errorClassOf('kaputt')).toBe('string');
      // Erneuter Reset ohne Wartezeit gelingt (D-R12).
      const result = await demo.reset.reset({ actorId: adminId, now: new Date() });
      expect(result.ok).toBe(true);
      expect((await demo.dataset.state()).resetInProgress).toBe(false);
    },
    RESET_TIMEOUT_MS,
  );

  // ── Dünne Mapping-Tests T35–T52/T57 (Assertions liegen in demo-reset / demo-platform) ──

  it('T35. nur demo.manage: Mitarbeiter ohne das Recht erhält 403 (D-P3 deckt Systemadmin/Rolle/anonym ab)', async () => {
    const staff = await createStaffWithPermissions(ctx, adminId, {
      firstName: 'Ohne',
      lastName: 'Recht',
      email: 'ohne.recht@example.com',
      password: 'ohne-recht-passwort-1',
      permissionKeys: ['process.view_all'] as PermissionKey[],
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/staff/demo/reset',
      headers: { cookie: staff.cookie },
      payload: { confirmation: DEMO_MESSAGES.RESET_CONFIRMATION },
    });
    expect(response.statusCode).toBe(403);
    expect((await demo.dataset.state()).resetInProgress).toBe(false);
  });

  it('T36. nur APP_ENV=demo: der Reset-Service lehnt jede andere Umgebung mit DEMO_ONLY ab (D-R8 prüft zusätzlich, dass nichts gelöscht wird)', async () => {
    for (const appEnv of ['development', 'staging', 'production'] as const) {
      const service = new DemoResetService({
        db: ctx.db,
        config: { ...ctx.config, appEnv },
        storage: ctx.storage,
        queue: ctx.queue,
        dataset: demo.dataset,
        registry: demo.registry,
        seed: demo.seed,
        settleDelayMs: 0,
      });
      await expect(service.reset({ actorId: adminId })).rejects.toMatchObject({
        demoCode: 'DEMO_ONLY',
      });
    }
  });

  it('T37. Production-Endpunkt nicht verfügbar: eine production-App (dieselbe DB) kennt /staff/demo/* nicht (404); D-P2 deckt development ab', async () => {
    const keys = webpush.generateVAPIDKeys();
    await withEnvApp(
      ctx,
      'production',
      async (app) => {
        const session = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
        expect(session.statusCode).toBe(200);
        for (const [method, url] of [
          ['POST', '/staff/demo/reset'],
          ['GET', '/staff/demo/status'],
          ['GET', '/staff/demo/seed-entities'],
        ] as const) {
          const response = await app.inject({
            method,
            url,
            headers: { cookie: session.cookie },
            ...(method === 'POST'
              ? { payload: { confirmation: DEMO_MESSAGES.RESET_CONFIRMATION } }
              : {}),
          });
          expect(response.statusCode, `${method} ${url}`).toBe(404);
        }
      },
      {
        extraEnv: {
          PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
          PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
          PUSH_VAPID_SUBJECT: 'mailto:it@miet-royal.example',
        },
      },
    );
  });

  it('T38./T39. globaler Reset-Lock: hält ein anderer Prozess den Advisory-Lock, antwortet reset() sofort mit DEMO_RESET_RUNNING (D-R4 prüft zwei echte parallele Resets ⇒ genau einer läuft)', async () => {
    const holder = await ctx.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        DEMO_RESET_ADVISORY_LOCK_KEY,
      ]);
      await expect(demo.reset.reset({ actorId: adminId, now: new Date() })).rejects.toMatchObject({
        demoCode: 'DEMO_RESET_RUNNING',
      });
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
    expect((await demo.dataset.state()).resetInProgress).toBe(false);
  });

  it('T40. Business-Mutation während des Resets blockiert: Flag gesetzt ⇒ 503 DEMO_RESET für POST /staff/customers (D-P5 prüft alle Pfadbereiche und Ausnahmen)', async () => {
    // Nur das Flag (wie demo-platform), nicht beginReset: last_reset_started_at bleibt unberührt.
    await ctx.pool.query(
      `UPDATE demo_dataset_state SET reset_in_progress = true, reset_started_at = now() WHERE id = 1`,
    );
    try {
      await sleep(1100); // Gate-Cache (TTL 1 s) sicher abgelaufen
      const blocked = await ctx.app.inject({
        method: 'POST',
        url: '/staff/customers',
        headers: { cookie: adminCookie },
        payload: {
          type: 'private',
          firstName: 'Blockiert',
          lastName: 'Kunde',
          email: 'b@example.com',
        },
      });
      expect(blocked.statusCode).toBe(503);
      expect(blocked.json().error.code).toBe('DEMO_RESET');
    } finally {
      await ctx.pool.query(
        `UPDATE demo_dataset_state SET reset_in_progress = false, reset_started_at = NULL WHERE id = 1`,
      );
    }
  });

  it('T41./T42. Businessdaten weg und neuer Seed vorhanden (D-R1): nach den Resets dieser Datei entsprechen Registry und Zähler dem kanonischen Datensatz', async () => {
    const counts = await demo.seed.counts();
    expect(counts.customers).toBeGreaterThan(0);
    expect(counts.processes).toBeGreaterThan(0);
    const keys = new Set((await demo.registry.list()).map((entry) => entry.seedKey));
    for (const key of [
      DEMO_SEED_KEYS.processOfferDraft,
      DEMO_SEED_KEYS.processHandoverReady,
      DEMO_SEED_KEYS.tourTodayMultiStop,
    ]) {
      expect(keys.has(key), key).toBe(true);
    }
    expect((await demo.dataset.state()).datasetVersion).toBe(DEMO_DATASET_VERSION);
  });

  it('T43.–T47. Staff-Konten, Rollen, 2FA, bekannte Geräte und Security-Audit bleiben (D-R2 zählt jede Tabelle): strukturell steht keine staff_*-, Geräte-, Audit- oder Push-Gerätetabelle in der Löschliste; der Admin kann sich nach den Resets weiter anmelden', async () => {
    for (const table of DEMO_BUSINESS_TABLES_DELETE_ORDER) {
      expect(table.startsWith('staff_'), table).toBe(false);
      expect(['push_subscriptions', 'calendar_feed_tokens', 'offline_access_leases']).not.toContain(
        table,
      );
    }
    expect(await count('staff_users')).toBeGreaterThan(0);
    expect(await count('staff_security_events')).toBeGreaterThan(0);
    expect((await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).statusCode).toBe(200);
  });

  it('T48.–T52. Trainingsdaten (Definitionen, Zuweisungen, bestandene Versuche) stehen nie in der Löschliste; laufende Versuche ⇒ interrupted/DEMO_DATA_RESET läuft über den Hook beforeBusinessWipe in Phase B (T58 zeigt genau einen Aufruf; Fachassertion bei TRAINING-CORE, Tests 85/86)', () => {
    for (const table of DEMO_BUSINESS_TABLES_DELETE_ORDER) {
      expect(table.startsWith('training_'), table).toBe(false);
      expect(table.startsWith('demo_'), table).toBe(false);
    }
  });

  it(
    'RF14-2. API-Runner (POST /staff/accounting/mock/run-due-jobs) trägt denselben Demo-Guard wie der Worker (Review-Fix F2, Order §21): ein beim Reset laufender Business-Job des alten Datensatzes wird nach dem Reset ohne Ausführung als dead/DEMO_DATASET_CHANGED beendet (kein Handler-Lauf)',
    async () => {
      const stale = await ctx.queue.enqueue(
        'mail.send',
        { deliveryId: randomUUID() },
        { idempotencyKey: `rf14-2:stale:${randomUUID()}` },
      );
      const zombie = await claimAsZombie(stale.jobId);
      expect((await demo.reset.reset({ actorId: adminId, now: new Date() })).ok).toBe(true);
      expect((await jobRow(stale.jobId))?.status).toBe('processing'); // überlebt den Wipe
      await zombie.reclaimExpired();
      const reclaimed = await jobRow(stale.jobId);
      expect(reclaimed?.status).toBe('pending');
      expect(reclaimed!.createdAt.getTime()).toBeLessThan((await lastResetStartedAt()).getTime());
      await makeDueFirst(stale.jobId);

      const run = await ctx.app.inject({
        method: 'POST',
        url: '/staff/accounting/mock/run-due-jobs',
        headers: { cookie: adminCookie },
        payload: {},
      });
      expect(run.statusCode).toBe(200);
      // Der Claim zählt als Versuch (+1); dead/DEMO_DATASET_CHANGED entsteht nur im Skip-Zweig
      // VOR dem Handler (ohne Guard: succeeded). Kein Retry, kein weiterer Versuch.
      expect(await jobRow(stale.jobId)).toMatchObject({
        status: 'dead',
        lastError: DEMO_DATASET_CHANGED_REASON,
        attempts: reclaimed!.attempts + 1,
      });
      expect(await staleBusinessJobs()).toEqual([]);
    },
    RESET_TIMEOUT_MS,
  );

  it('T57. Reset mehrfach sicher: nach mehreren Resets in dieser Datei ist der Zustand konsistent (kein Flag, Version aktuell, keine veralteten Business-Jobs); D-R1/D-R7/RF3 resetten ebenfalls mehrfach', async () => {
    const state = await demo.dataset.state();
    expect(state.resetInProgress).toBe(false);
    expect(state.resetStale).toBe(false);
    expect(state.datasetVersion).toBe(DEMO_DATASET_VERSION);
    expect(await staleBusinessJobs()).toEqual([]);
    const resets = (await ctx.db.select().from(staffSecurityEvents)).filter(
      (event) => event.type === 'demo.reset_completed',
    );
    expect(resets.length).toBeGreaterThanOrEqual(5);
    expect(DemoError.name).toBe('DemoError');
  });
});
