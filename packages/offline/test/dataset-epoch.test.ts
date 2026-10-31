import { afterEach, describe, expect, it } from 'vitest';
import { generateDek } from '../src/crypto.ts';
import {
  DEMO_DATASET_CHANGED_CODE,
  META_DATASET_CHANGED_PENDING,
  META_DATASET_EPOCH,
  datasetChanged,
  datasetChangedMessage,
} from '../src/dataset-epoch.ts';
import { OfflineDb, deleteOfflineDatabase, offlineDbName, openOfflineDatabase } from '../src/db.ts';
import {
  DatasetChangedError,
  SyncEngine,
  type SyncMutationEnvelope,
  type SyncOutcome,
  type SyncTransport,
} from '../src/queue.ts';
import { OfflineStore } from '../src/store.ts';

/**
 * Phase 14 (offline epoch, Order §91/§92, Tests T65/T66): Erkennung eines
 * Datensatzwechsels im Client, Abbruch der Sync-Queue bei 409
 * DEMO_DATASET_CHANGED (nichts wird verworfen), Epoch je Mutation/Paket im
 * Sync-Envelope und das bewusste Verwerfen des alten Stands.
 */

const EPOCH_A = '11111111-1111-4111-8111-111111111111';
const EPOCH_B = '22222222-2222-4222-8222-222222222222';

const names: string[] = [];
async function fresh(): Promise<{ db: OfflineDb; store: OfflineStore }> {
  const name = offlineDbName('demo', `epoch-${Math.random().toString(16).slice(2)}`);
  names.push(name);
  const db = new OfflineDb(await openOfflineDatabase(name));
  const store = new OfflineStore(db);
  store.setKey(await generateDek());
  return { db, store };
}
afterEach(async () => {
  for (const name of names.splice(0)) await deleteOfflineDatabase(name);
});

function transportWith(
  handler: (envelope: SyncMutationEnvelope) => SyncOutcome | Error,
): SyncTransport & { calls: SyncMutationEnvelope[] } {
  const calls: SyncMutationEnvelope[] = [];
  return {
    calls,
    send(envelope) {
      calls.push(envelope);
      const outcome = handler(envelope);
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };
}

async function enqueue(
  store: OfflineStore,
  id: string,
  datasetEpoch: string | null | undefined,
  createdAt = '2026-10-31T08:00:00.000Z',
): Promise<void> {
  await store.enqueueMutation({
    clientMutationId: id,
    type: 'handover.recipient',
    contextKind: 'booking',
    contextId: 'b-1',
    payload: { kind: 'customer', name: null, phone: null },
    summary: { processNumber: 'MR-2026-0001', actionLabel: 'Empfänger', detail: null },
    createdAt,
    dependsOn: [],
    ...(datasetEpoch === undefined ? {} : { datasetEpoch }),
  });
}

describe('Phase 14 – Offline-Epoch (Client, Tests T65/T66)', () => {
  it('T65. Client erkennt den Datensatzwechsel nur, wenn beide Epochen bekannt sind und abweichen (Production/Development: nie)', () => {
    expect(datasetChanged(EPOCH_A, EPOCH_B)).toBe(true);
    expect(datasetChanged(EPOCH_A, EPOCH_A)).toBe(false);
    // Außerhalb der Demo (Server liefert null) oder ohne lokales Paket: kein Wechsel, kein Dialog.
    expect(datasetChanged(null, EPOCH_B)).toBe(false);
    expect(datasetChanged(EPOCH_A, null)).toBe(false);
    expect(datasetChanged(undefined, undefined)).toBe(false);
    expect(datasetChanged(null, null)).toBe(false);
    expect(datasetChangedMessage(3)).toBe(
      'Die Demo-Daten wurden zurückgesetzt. 3 nicht synchronisierte Erfassungen gehören zum alten Datenstand und können nicht mehr übernommen werden.',
    );
    expect(DEMO_DATASET_CHANGED_CODE).toBe('DEMO_DATASET_CHANGED');
  });

  it('T65b. Sync-Envelope trägt die Epoch der Mutation, ersatzweise die des lokalen Pakets (Meta), sonst null', async () => {
    const { store } = await fresh();
    await enqueue(store, 'm-eigene', EPOCH_A, '2026-10-31T08:00:00.000Z');
    await enqueue(store, 'm-ohne', undefined, '2026-10-31T08:01:00.000Z');
    const transport = transportWith((envelope) => ({
      status: 'applied',
      resultRef: { id: envelope.clientMutationId },
      processedAt: 'p',
    }));
    const engine = new SyncEngine(store, transport, {
      now: () => new Date('2026-10-31T09:00:00.000Z'),
    });
    // Ohne Meta-Epoch (kein Demo-Paket): eigene Epoch bzw. null.
    await engine.runOnce();
    expect(transport.calls.map((c) => [c.clientMutationId, c.datasetEpoch ?? null])).toEqual([
      ['m-eigene', EPOCH_A],
      ['m-ohne', null],
    ]);
    // Mit Meta-Epoch (Paket der Generation B): Mutation ohne eigene Epoch erbt sie.
    await store.setMeta(META_DATASET_EPOCH, EPOCH_B, '2026-10-31T09:00:00.000Z');
    await enqueue(store, 'm-erbt', null, '2026-10-31T09:02:00.000Z');
    await engine.runOnce();
    expect(transport.calls.at(-1)?.clientMutationId).toBe('m-erbt');
    expect(transport.calls.at(-1)?.datasetEpoch).toBe(EPOCH_B);
    // Der Sync-Envelope enthält weiterhin alle Mutationsfelder (Server-Schema unverändert).
    const last = transport.calls.at(-1)!;
    expect(Object.keys(last).sort()).toEqual([
      'baseVersion',
      'clientMutationId',
      'contextId',
      'contextKind',
      'createdAt',
      'datasetEpoch',
      'media',
      'payload',
      'type',
    ]);
  });

  it('T65c. 409 DEMO_DATASET_CHANGED (DatasetChangedError) ⇒ Lauf endet sofort, Mutationen bleiben pending (kein Konflikt, kein Backoff, kein Verwerfen), Ergebnis datasetChanged', async () => {
    const { store } = await fresh();
    await store.setMeta(META_DATASET_EPOCH, EPOCH_A, '2026-10-31T08:00:00.000Z');
    await enqueue(store, 'm1', EPOCH_A, '2026-10-31T08:00:00.000Z');
    await enqueue(store, 'm2', EPOCH_A, '2026-10-31T08:01:00.000Z');
    const transport = transportWith(() => new DatasetChangedError());
    const engine = new SyncEngine(store, transport, {
      now: () => new Date('2026-10-31T09:00:00.000Z'),
    });
    const run = await engine.runOnce();
    expect(run).toMatchObject({
      attempted: 1,
      applied: 0,
      conflicts: 0,
      rejected: 0,
      transientFailures: 0,
      sessionInvalid: false,
      datasetChanged: true,
    });
    expect(transport.calls.map((c) => c.clientMutationId)).toEqual(['m1']);
    const records = await store.listMutationRecords();
    expect(records.map((r) => [r.clientMutationId, r.status, r.retryCount])).toEqual([
      ['m1', 'pending', 0],
      ['m2', 'pending', 0],
    ]);
    expect(await store.listConflictRecords()).toEqual([]);
    expect(await store.listReceipts()).toEqual([]);
    expect(await engine.pendingCount()).toBe(2);
    // Ein gewöhnlicher Konflikt (409 mit anderem Code) bleibt ein Mutationskonflikt – kein Abbruch.
    const conflicting = transportWith(() => ({
      status: 'conflict',
      code: 'SERVER_STATE_CHANGED',
      message: 'Der Serverstand hat sich geändert.',
      serverState: null,
      processedAt: 'p',
    }));
    const other = new SyncEngine(store, conflicting, {
      now: () => new Date('2026-10-31T09:05:00.000Z'),
    });
    const second = await other.runOnce();
    expect(second).toMatchObject({ attempted: 2, conflicts: 2, datasetChanged: false });
  });

  it('T66. altes Paket verworfen: nach der Bestätigung sind Pakete, Vorgänge, Maschinen, Dokumente, Mutationen, Medien, Konflikte und Quittungen leer, Epoch-Metadaten gelöscht – Workspace und Uhr bleiben', async () => {
    const { store, db } = await fresh();
    await store.putWorkspace({
      key: 'workspace',
      userId: 'u-1',
      environment: 'demo',
      deviceId: 'd-1',
      createdAt: '2026-10-31T08:00:00.000Z',
      salt: 's',
      kdfIterations: 600000,
      wrappedByPassword: null,
      wrappedByLease: null,
      lease: null,
      leaseMac: null,
      lastAuthorizedAt: '2026-10-31T08:00:00.000Z',
    });
    await store.setMeta('clock.serverMs', 1_700_000_000_000, '2026-10-31T08:00:00.000Z');
    await store.setMeta(META_DATASET_EPOCH, EPOCH_A, '2026-10-31T08:00:00.000Z');
    await store.setMeta(META_DATASET_CHANGED_PENDING, true, '2026-10-31T08:30:00.000Z');
    await store.putPackage(
      {
        packageId: 'p-1',
        environment: 'demo',
        createdAt: 'c',
        serverTime: 's',
        horizonFrom: '2026-10-28',
        horizonTo: '2026-11-03',
        expiresAt: 'e',
        bookingIds: ['b-1'],
        machineIds: ['m-1'],
      },
      { permissions: [] },
    );
    await store.putBooking(
      { bookingId: 'b-1', processId: 'pr-1', packageId: 'p-1', relevantDay: null, updatedAt: 'u' },
      { name: 'Kunde' },
    );
    await store.putMachines([
      {
        record: { machineId: 'm-1', qrHash: 'h'.repeat(64), packageId: 'p-1', updatedAt: 'u' },
        payload: { code: 'MR-10-01-01' },
      },
    ]);
    await store.putDocument(
      {
        documentId: 'doc-1',
        bookingId: 'b-1',
        type: 'delivery_note',
        createdAt: 'c',
        sha256: 'a'.repeat(64),
        byteSize: 3,
      },
      new Uint8Array([1, 2, 3]),
    );
    await store.putMedia({
      mediaId: 'media-1',
      purpose: 'handover_photo',
      mimeType: 'image/png',
      bytes: new Uint8Array([9, 9, 9]),
      sha256: 'b'.repeat(64),
      contextKind: 'booking',
      contextId: 'b-1',
      createdAt: 'c',
    });
    await enqueue(store, 'm-1', EPOCH_A);
    await store.putConflict('m-1', {
      code: 'SERVER_STATE_CHANGED',
      status: 'conflict',
      message: 'x',
      serverState: null,
      details: null,
      processedAt: 'p',
    });
    await store.putReceipt({
      clientMutationId: 'm-0',
      status: 'applied',
      processedAt: 'p',
      resultRef: null,
      code: null,
    });

    await store.discardDataset();

    for (const name of [
      'packages',
      'bookings',
      'machines',
      'documents',
      'mutations',
      'media',
      'conflicts',
      'receipts',
    ] as const) {
      expect(await db.count(name), name).toBe(0);
    }
    expect(await store.getMeta(META_DATASET_EPOCH)).toBeUndefined();
    expect(await store.getMeta(META_DATASET_CHANGED_PENDING)).toBeUndefined();
    expect(await store.getMeta('clock.serverMs')).toBe(1_700_000_000_000);
    expect((await store.getWorkspace())?.userId).toBe('u-1');
    expect(await store.countByStatus()).toMatchObject({ pending: 0, conflict: 0 });
    // Neues Paket der nächsten Generation lässt sich danach normal übernehmen (T67 serverseitig).
    await store.setMeta(META_DATASET_EPOCH, EPOCH_B, '2026-10-31T09:00:00.000Z');
    expect(await store.getMeta(META_DATASET_EPOCH)).toBe(EPOCH_B);
  });
});
