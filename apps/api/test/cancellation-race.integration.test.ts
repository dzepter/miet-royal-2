/**
 * Phase-9-Pflichttests 116–119 (Order §§82/83/95): Storno vs. Übergabe-
 * Finalisierung (mehrfach, beide Startreihenfolgen) ⇒ genau EIN gültiger
 * Zustand, nie „issued UND cancelled“; Storno vs. Vorbereitung; Storno vs.
 * Maschinenwechsel; Storno vs. Terminverschiebung; Doppelstorno parallel.
 */
import { cancellations, handovers, processes } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CancellationView } from '../src/cancellation/cancellation-service.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  adminSession,
  adminViewer,
  appointmentsOf,
  assignmentsOf,
  cancellationServicesFor,
  resetForCancellationTests,
} from './cancellation-helpers.ts';
import {
  DAYS,
  handoverServicesFor,
  initializeAllInventory,
  readyHandover,
  scheduledBooking,
} from './handover-helpers.ts';
import { machineByCode } from './warehouse-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetForCancellationTests(ctx);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function processStatus(processId: string) {
  return (await ctx.db.select().from(processes).where(eq(processes.id, processId)))[0]!.mainStatus;
}

describe('116. Storno vs. Übergabe-Finalisierung', () => {
  it('116. Parallel: genau einer gewinnt – nie issued UND cancelled (5 Durchläufe, beide Startreihenfolgen)', async () => {
    const { admin, effective } = await adminSession(ctx);
    const { handover } = handoverServicesFor(ctx);
    const { service } = cancellationServicesFor(ctx);
    await initializeAllInventory(ctx, admin.id, 200);
    const codes = ['MR-10-01-01', 'MR-10-01-02', 'MR-10-01-03', 'MR-10-01-04', 'MR-10-01-05'];
    const outcomes: ('issued' | 'cancelled')[] = [];
    for (const [iteration, code] of codes.entries()) {
      const world = await scheduledBooking(ctx, admin.id, {
        from: new Date(Date.now() + (10 + iteration) * DAYS),
        to: new Date(Date.now() + (12 + iteration) * DAYS),
      });
      await readyHandover(ctx, admin.id, world.bookingId, [code]);
      const cancel = () =>
        service.cancel(world.processId, { id: admin.id, type: 'admin' }, adminViewer(effective));
      const finalize = () => handover.finalize(admin.id, world.bookingId);
      // Abwechselnd: Storno zuerst / Finalisierung zuerst (deren Phase 1 rendert
      // PDFs, Phase 2 nimmt die Sperren – der Storno trifft mal davor, mal mittendrin).
      const delayedCancel = async () => {
        await sleep(iteration % 2 === 0 ? 0 : 40 + iteration * 60);
        return cancel();
      };
      const [cancelResult, finalizeResult] = await Promise.allSettled([
        delayedCancel(),
        finalize(),
      ]);
      const fulfilled = [cancelResult.status, finalizeResult.status].filter(
        (status) => status === 'fulfilled',
      );
      expect(fulfilled, `Durchlauf ${iteration + 1}: genau ein Gewinner`).toHaveLength(1);

      const slots = await assignmentsOf(ctx, world.bookingId);
      const status = await processStatus(world.processId);
      const handoverRow = (
        await ctx.db.select().from(handovers).where(eq(handovers.bookingId, world.bookingId))
      )[0]!;
      const storedCancellations = await ctx.db
        .select()
        .from(cancellations)
        .where(eq(cancellations.processId, world.processId));
      const machine = await machineByCode(ctx.db, code);
      const issued = slots.some((slot) => slot.status === 'issued');
      const cancelled = status === 'cancelled';
      expect(issued && cancelled, `Durchlauf ${iteration + 1}: nie issued UND cancelled`).toBe(
        false,
      );
      if (cancelResult.status === 'fulfilled') {
        expect(finalizeResult.status).toBe('rejected');
        expect(cancelled).toBe(true);
        expect(handoverRow.status).toBe('draft');
        expect(slots.map((s) => s.status)).toEqual(['open']);
        expect(machine.status).toBe('ready');
        expect(storedCancellations).toHaveLength(1);
        expect((await appointmentsOf(ctx, world.bookingId)).map((a) => a.status)).toEqual([
          'cancelled',
          'cancelled',
        ]);
        outcomes.push('cancelled');
      } else {
        expect(finalizeResult.status).toBe('fulfilled');
        expect((cancelResult as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });
        expect(status).toBe('open');
        expect(handoverRow.status).toBe('finalized');
        expect(slots.map((s) => s.status)).toEqual(['issued']);
        expect(machine.status).toBe('rented');
        expect(storedCancellations).toHaveLength(0);
        outcomes.push('issued');
      }
    }
    // Beide Ausgänge sind zulässig; der Test prüft die Invariante je Durchlauf.
    expect(outcomes).toHaveLength(codes.length);
  });

  it('116b. Storno gewinnt zuerst ⇒ Finalisierung scheitert mit „storniert“; Finalisierung zuerst ⇒ Storno blockiert', async () => {
    const { admin, effective } = await adminSession(ctx);
    const { handover } = handoverServicesFor(ctx);
    const { service } = cancellationServicesFor(ctx);
    await initializeAllInventory(ctx, admin.id);
    const a = await scheduledBooking(ctx, admin.id);
    await readyHandover(ctx, admin.id, a.bookingId, ['MR-10-01-01']);
    await service.cancel(a.processId, { id: admin.id, type: 'admin' }, adminViewer(effective));
    await expect(handover.finalize(admin.id, a.bookingId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await assignmentsOf(ctx, a.bookingId)).map((s) => s.status)).toEqual(['open']);

    const b = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 20 * DAYS),
      to: new Date(Date.now() + 22 * DAYS),
    });
    await readyHandover(ctx, admin.id, b.bookingId, ['MR-10-01-02']);
    await handover.finalize(admin.id, b.bookingId);
    await expect(
      service.cancel(b.processId, { id: admin.id, type: 'admin' }, adminViewer(effective)),
    ).rejects.toMatchObject({ name: 'CancellationBlockedError' });
    expect(await processStatus(b.processId)).toBe('open');
  });
});

describe('117./118. Storno vs. Vorbereitung / Maschinenwechsel', () => {
  it('117. Storno parallel zur Vorbereitung ⇒ Slot am Ende offen, Maschine nicht reserviert, Vorgang storniert', async () => {
    const { admin, effective } = await adminSession(ctx);
    const { assignments, handover } = handoverServicesFor(ctx);
    const { service } = cancellationServicesFor(ctx);
    for (const [iteration, code] of ['MR-10-01-01', 'MR-10-01-02', 'MR-10-01-03'].entries()) {
      const world = await scheduledBooking(ctx, admin.id, {
        from: new Date(Date.now() + (5 + iteration) * DAYS),
        to: new Date(Date.now() + (7 + iteration) * DAYS),
      });
      await handover.ensureForBooking(world.bookingId, admin.id);
      const slot = (await assignments.slotsForBooking(world.bookingId))[0]!;
      const machine = await machineByCode(ctx.db, code);
      await assignments.assign(admin.id, effective, slot.id, machine.id, null);
      const results = await Promise.allSettled([
        assignments.prepare(admin.id, slot.id),
        service.cancel(world.processId, { id: admin.id, type: 'admin' }, adminViewer(effective)),
      ]);
      expect(results[1]!.status, 'Storno gewinnt immer (vorbereitet oder nicht)').toBe('fulfilled');
      const slots = await assignmentsOf(ctx, world.bookingId);
      expect(slots[0]).toMatchObject({ status: 'open', machineId: null });
      expect((await machineByCode(ctx.db, code)).status).toBe('ready');
      expect(await processStatus(world.processId)).toBe('cancelled');
      await assignments.refreshRiskIncidents();
      expect(await assignments.listOpenIncidents()).toEqual([]);
    }
  });

  it('118. Storno parallel zum Maschinenwechsel ⇒ kein Lost Update: Slot offen, keine Maschine am stornierten Vorgang', async () => {
    const { admin, effective } = await adminSession(ctx);
    const { assignments, handover } = handoverServicesFor(ctx);
    const { service } = cancellationServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id);
    await handover.ensureForBooking(world.bookingId, admin.id);
    const slot = (await assignments.slotsForBooking(world.bookingId))[0]!;
    const first = await machineByCode(ctx.db, 'MR-10-01-01');
    const second = await machineByCode(ctx.db, 'MR-10-01-02');
    await assignments.assign(admin.id, effective, slot.id, first.id, null);
    await assignments.prepare(admin.id, slot.id);
    const results = await Promise.allSettled([
      assignments.assign(admin.id, effective, slot.id, second.id, null),
      service.cancel(world.processId, { id: admin.id, type: 'admin' }, adminViewer(effective)),
    ]);
    expect(results[1]!.status).toBe('fulfilled');
    if (results[0]!.status === 'rejected') {
      expect(results[0]!.reason).toMatchObject({ code: 'CONFLICT' });
    }
    const slots = await assignmentsOf(ctx, world.bookingId);
    expect(slots[0]).toMatchObject({ status: 'open', machineId: null });
    expect((await machineByCode(ctx.db, 'MR-10-01-01')).status).toBe('ready');
    expect((await machineByCode(ctx.db, 'MR-10-01-02')).status).toBe('ready');
    // Nach dem Storno ist keine Zuweisung mehr möglich.
    await expect(
      assignments.assign(admin.id, effective, slot.id, second.id, null),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('Storno vs. Terminverschiebung, Doppelstorno', () => {
  it('Storno parallel zur Terminverschiebung ⇒ Termin am Ende storniert, kein stilles Überschreiben', async () => {
    const { admin, effective } = await adminSession(ctx);
    const { scheduling, service } = cancellationServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id);
    const before = (await appointmentsOf(ctx, world.bookingId)).find((a) => a.kind === 'return')!;
    const results = await Promise.allSettled([
      scheduling.reschedule(admin.id, before.id, {
        startAt: new Date(Date.now() + 9 * DAYS),
        endAt: null,
        expectedVersion: before.version,
      }),
      service.cancel(world.processId, { id: admin.id, type: 'admin' }, adminViewer(effective)),
    ]);
    expect(results[1]!.status).toBe('fulfilled');
    if (results[0]!.status === 'rejected') {
      expect(results[0]!.reason).toMatchObject({ code: 'CONFLICT' });
    }
    const after = (await appointmentsOf(ctx, world.bookingId)).find((a) => a.kind === 'return')!;
    expect(after.status).toBe('cancelled');
    expect(after.version).toBeGreaterThan(before.version);
    // Verschieben nach dem Storno ⇒ Konflikt (Status/Version), nie ein Lost Update.
    await expect(
      scheduling.reschedule(admin.id, after.id, {
        startAt: new Date(Date.now() + 11 * DAYS),
        endAt: null,
        expectedVersion: after.version,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('119. Doppelstorno parallel ⇒ beide Aufrufe liefern dieselbe Stornierung, eine Zeile, ein Transfer', async () => {
    const { admin, effective } = await adminSession(ctx);
    const { service } = cancellationServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 2 * DAYS),
      to: new Date(Date.now() + 3 * DAYS),
    });
    const cancel = () =>
      service.cancel(world.processId, { id: admin.id, type: 'admin' }, adminViewer(effective));
    const results = await Promise.allSettled([cancel(), cancel(), cancel()]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const ids = new Set(
      results.map((r) => (r as PromiseFulfilledResult<CancellationView>).value.id),
    );
    expect(ids.size).toBe(1);
    expect(await ctx.db.select().from(cancellations)).toHaveLength(1);
    await ctx.jobs.drain();
    expect(ctx.accounting.calls.length).toBeLessThanOrEqual(1);
  });
});
