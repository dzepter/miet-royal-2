import { randomUUID } from 'node:crypto';
import { bookings, handoverPhotos, offlineMutationReceipts } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_DATASET_VERSION } from '../src/demo/dataset.ts';
import { DEMO_SEED_KEYS } from '../src/demo/seed/data.ts';
import { OfflineDatasetChangedError } from '../src/offline/lease-service.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  createTestContext,
  destroyTestContext,
  login,
  type TestContext,
} from './auth-helpers.ts';
import {
  createDemoTestContext,
  demoServicesFor,
  freshDemoDatabase,
  type DemoTestServices,
} from './demo-helpers.ts';
import { pngBytes, scheduledBooking } from './handover-helpers.ts';
import { DEVICE, DEVICE_B, offlineHelpers } from './offline-helpers.ts';

/**
 * Phase 14 (RESET, Order §91/§92, Design Teil 2 §2.5, Pflichttests T60–T64/T67/T68):
 * Demo-Offline-Lease, -Paket und -Status tragen die Dataset-Epoch; ein Reset
 * erzeugt eine neue Generation; Mutationen der alten Generation werden mit 409
 * DEMO_DATASET_CHANGED abgewiesen, ohne Quittung und ohne Wirkung auf den neuen
 * Seed; ein neues Paket ist ladbar; außerhalb der Demo (development) ist die
 * Epoch überall null und der Sync unverändert. Läuft gegen eine eigene Test-DB.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESET_TIMEOUT_MS = 180_000;

let ctx: TestContext;
let demo: DemoTestServices;
let adminId: string;
let adminCookie: string;
const h = offlineHelpers(() => ctx);

beforeAll(async () => {
  ctx = await createDemoTestContext();
  demo = demoServicesFor(ctx);
  ({ adminId } = await freshDemoDatabase(ctx));
  // Zustandszeile mit Epoch existiert ab dem ersten Seed-Stand (hier ohne vollen Seed).
  await ctx.db.transaction((tx) =>
    demo.dataset.markSeeded(tx, {
      datasetVersion: DEMO_DATASET_VERSION,
      seededBy: adminId,
      now: new Date(),
    }),
  );
  adminCookie = (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie;
}, 120_000);

afterAll(async () => {
  await destroyTestContext(ctx);
});

async function status(cookie = adminCookie, app = ctx.app) {
  const response = await app.inject({
    method: 'GET',
    url: `/staff/offline/status?deviceId=${DEVICE}`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { environment: string; datasetEpoch: string | null };
}

async function receiptFor(clientMutationId: string) {
  return ctx.db
    .select()
    .from(offlineMutationReceipts)
    .where(eq(offlineMutationReceipts.clientMutationId, clientMutationId));
}

describe('Phase 14 – Demo-Offline-Epoch (Server)', () => {
  let epochBefore: string;
  let oldBookingId: string;
  let oldProcessId: string;

  it('T60. Demo-Offline-Lease trägt die aktuelle Dataset-Epoch (Ausstellung und Verlängerung)', async () => {
    const stateEpoch = await demo.dataset.datasetEpoch();
    expect(stateEpoch).toMatch(UUID);
    const issued = await h.lease(adminCookie, DEVICE, 'demo');
    expect(issued.statusCode).toBe(200);
    expect(issued.json().environment).toBe('demo');
    expect(issued.json().datasetEpoch).toBe(stateEpoch);
    const renewed = await h.lease(adminCookie, DEVICE, 'demo');
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json().datasetEpoch).toBe(stateEpoch);
    epochBefore = stateEpoch!;
  });

  it('T61. Demo-Offline-Paket und Statusendpunkt tragen dieselbe Epoch; das Paket enthält den Vorgang der Generation', async () => {
    const booking = await scheduledBooking(ctx, adminId);
    oldBookingId = booking.bookingId;
    oldProcessId = booking.processId;
    const pkg = await h.pkg(adminCookie, { environment: 'demo' });
    expect(pkg.statusCode).toBe(200);
    expect(pkg.json().environment).toBe('demo');
    expect(pkg.json().datasetEpoch).toBe(epochBefore);
    expect(pkg.json().bookings.map((b: { bookingId: string }) => b.bookingId)).toContain(
      oldBookingId,
    );
    expect((await status()).datasetEpoch).toBe(epochBefore);
    // Sync mit aktueller Epoch läuft normal (Sanity vor dem Reset).
    const ok = await h.sync(
      adminCookie,
      {
        type: 'handover.recipient',
        contextId: oldBookingId,
        payload: { kind: 'customer', name: null, phone: null },
      },
      { environment: 'demo', datasetEpoch: epochBefore },
    );
    expect(ok.response.statusCode).toBe(200);
    expect(ok.json.status).toBe('applied');
  });

  it(
    'T62. Reset ändert die Epoch (Status vor/nach; Lease/Paket folgen); Development/Production-Pfad unberührt',
    async () => {
      const result = await demo.reset.reset({ actorId: adminId, now: new Date() });
      expect(result.ok).toBe(true);
      const after = await status();
      expect(after.datasetEpoch).toMatch(UUID);
      expect(after.datasetEpoch).not.toBe(epochBefore);
      expect(await demo.dataset.datasetEpoch()).toBe(after.datasetEpoch);
      const renewed = await h.lease(adminCookie, DEVICE, 'demo');
      expect(renewed.json().datasetEpoch).toBe(after.datasetEpoch);
      // Alte Generation existiert nicht mehr: der alte Vorgang ist weg.
      expect(
        await ctx.db.select().from(bookings).where(eq(bookings.id, oldBookingId)),
      ).toHaveLength(0);
    },
    RESET_TIMEOUT_MS,
  );

  it('T63. alte Mutation (Epoch vor dem Reset) ⇒ 409 DEMO_DATASET_CHANGED mit verständlichem Text, keine Quittung; fehlende Epoch ebenso; falsche (fremde) Epoch ebenso', async () => {
    const current = (await status()).datasetEpoch!;
    const message = new OfflineDatasetChangedError().message;
    for (const datasetEpoch of [epochBefore, undefined, randomUUID()]) {
      const id = randomUUID();
      const rejected = await h.sync(
        adminCookie,
        {
          id,
          type: 'handover.recipient',
          contextId: oldBookingId,
          payload: { kind: 'customer', name: null, phone: null },
        },
        { environment: 'demo', ...(datasetEpoch === undefined ? {} : { datasetEpoch }) },
      );
      expect(rejected.response.statusCode, String(datasetEpoch)).toBe(409);
      expect(rejected.json.error).toMatchObject({ code: 'DEMO_DATASET_CHANGED', message });
      expect(await receiptFor(id)).toHaveLength(0);
    }
    expect(message).toBe(
      'Die Demo-Daten wurden zurückgesetzt. Offline erfasste Änderungen gehören zum alten Datenstand und können nicht mehr übernommen werden.',
    );
    expect(current).not.toBe(epochBefore);
  });

  it('T64. alte Mutation verändert den neuen Seed nicht: handover.photo auf die alte Buchungs-ID (alte Epoch ⇒ 409; neue Epoch ⇒ keine Wirkung, Vorgang unbekannt) hinterlässt keine Zeile; Vorgänge des neuen Seeds bleiben unverändert', async () => {
    const current = (await status()).datasetEpoch!;
    const photosBefore = (await ctx.db.select().from(handoverPhotos)).length;
    const snapshotOfBookings = async () =>
      (await ctx.db.select().from(bookings)).map((row) => JSON.stringify(row)).sort();
    const newBookingsBefore = await snapshotOfBookings();
    const mediaId = randomUUID();
    const photo = {
      type: 'handover.photo',
      contextId: oldBookingId,
      payload: { assignmentId: randomUUID(), machineId: randomUUID(), mediaId },
      media: [{ mediaId, purpose: 'handover_photo', mimeType: 'image/png', bytes: pngBytes() }],
    };
    const stale = await h.sync(
      adminCookie,
      { ...photo, id: randomUUID() },
      {
        environment: 'demo',
        datasetEpoch: epochBefore,
      },
    );
    expect(stale.response.statusCode).toBe(409);
    expect((stale.json.error as { code: string }).code).toBe('DEMO_DATASET_CHANGED');
    const withNewEpoch = await h.sync(
      adminCookie,
      { ...photo, id: randomUUID() },
      {
        environment: 'demo',
        datasetEpoch: current,
      },
    );
    // Der Vorgang existiert nicht mehr: keine Anwendung (Konflikt/Ablehnung), nie „applied“.
    expect(withNewEpoch.json.status).not.toBe('applied');
    expect((await ctx.db.select().from(handoverPhotos)).length).toBe(photosBefore);
    const newBookingsAfter = await snapshotOfBookings();
    expect(newBookingsAfter).toEqual(newBookingsBefore);
    expect(
      await ctx.db.select().from(bookings).where(eq(bookings.processId, oldProcessId)),
    ).toHaveLength(0);
  });

  it('T67. neues Paket ladbar: nach dem Reset liefert das Paket die neue Epoch und ausschließlich Vorgänge des neuen Seeds; eine Mutation mit der neuen Epoch wird verarbeitet', async () => {
    const current = (await status()).datasetEpoch!;
    const pkg = await h.pkg(adminCookie, { environment: 'demo' });
    expect(pkg.statusCode).toBe(200);
    expect(pkg.json().datasetEpoch).toBe(current);
    const ids = pkg.json().bookings.map((b: { bookingId: string }) => b.bookingId) as string[];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain(oldBookingId);
    const ready = await demo.registry.resolve(DEMO_SEED_KEYS.processHandoverReady);
    const [readyBooking] = await ctx.db
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.processId, ready!.entityId));
    expect(ids).toContain(readyBooking!.id);
    const applied = await h.sync(
      adminCookie,
      {
        type: 'handover.recipient',
        contextId: readyBooking!.id,
        payload: { kind: 'customer', name: null, phone: null },
      },
      { environment: 'demo', datasetEpoch: current },
    );
    expect(applied.response.statusCode).toBe(200);
    expect(applied.json.status).toBe('applied');
  });

  it('T68. Production/Development unverändert: im development-Kontext sind Epoch-Felder in Lease, Paket und Status null; Sync ohne Feld und mit beliebigem Feld wird unverändert verarbeitet (nie DEMO_DATASET_CHANGED)', async () => {
    const dev = await createTestContext();
    try {
      const session = await login(dev.app, ADMIN_EMAIL, ADMIN_PASSWORD);
      expect(session.statusCode).toBe(200);
      const lease = await dev.app.inject({
        method: 'POST',
        url: '/staff/offline/lease',
        headers: { cookie: session.cookie },
        payload: { deviceId: DEVICE_B, environment: 'development' },
      });
      expect(lease.statusCode).toBe(200);
      expect(lease.json().datasetEpoch).toBeNull();
      const pkg = await dev.app.inject({
        method: 'POST',
        url: '/staff/offline/package',
        headers: { cookie: session.cookie },
        payload: { deviceId: DEVICE_B, environment: 'development', includeDocuments: false },
      });
      expect(pkg.statusCode).toBe(200);
      expect(pkg.json().datasetEpoch).toBeNull();
      const devStatus = await dev.app.inject({
        method: 'GET',
        url: `/staff/offline/status?deviceId=${DEVICE_B}`,
        headers: { cookie: session.cookie },
      });
      expect(devStatus.json().datasetEpoch).toBeNull();
      expect(devStatus.json().environment).toBe('development');
      const ready = await demo.registry.resolve(DEMO_SEED_KEYS.processHandoverReady);
      const [readyBooking] = await dev.db
        .select({ id: bookings.id })
        .from(bookings)
        .where(eq(bookings.processId, ready!.entityId));
      for (const datasetEpoch of [undefined, randomUUID(), null]) {
        const response = await dev.app.inject({
          method: 'POST',
          url: '/staff/offline/sync',
          headers: { cookie: session.cookie },
          payload: {
            deviceId: DEVICE_B,
            environment: 'development',
            clientTime: new Date().toISOString(),
            ...(datasetEpoch === undefined ? {} : { datasetEpoch }),
            mutation: h.mutation({
              type: 'handover.recipient',
              contextId: readyBooking!.id,
              payload: { kind: 'customer', name: null, phone: null },
            }),
          },
        });
        expect(response.statusCode, String(datasetEpoch)).toBe(200);
        expect(response.json().status).toBe('applied');
      }
    } finally {
      await destroyTestContext(dev);
    }
  });
});
