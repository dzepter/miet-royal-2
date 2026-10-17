import { afterEach, describe, expect, it } from 'vitest';
import { generateDek, sha256Hex } from '../src/crypto.ts';
import {
  OFFLINE_MIGRATIONS,
  OFFLINE_SCHEMA_VERSION,
  OfflineDb,
  deleteOfflineDatabase,
  offlineDbName,
  openOfflineDatabase,
} from '../src/db.ts';
import { OfflineStore, WorkspaceLockedError } from '../src/store.ts';

const names: string[] = [];
async function freshDb(version = OFFLINE_SCHEMA_VERSION): Promise<OfflineDb> {
  const name = offlineDbName(
    'development',
    `user-${names.length}-${Math.random().toString(16).slice(2)}`,
  );
  names.push(name);
  return new OfflineDb(await openOfflineDatabase(name, version));
}
afterEach(async () => {
  for (const name of names.splice(0)) await deleteOfflineDatabase(name);
});

/** Klartext-Abbild einer IndexedDB (Bytes als Längenangabe) für Leak-Prüfungen. */
async function rawDump(db: OfflineDb): Promise<string> {
  const parts: unknown[] = [];
  for (const store of [...db.raw.objectStoreNames]) {
    parts.push(await db.getAll(store as Parameters<OfflineDb['getAll']>[0]));
  }
  return JSON.stringify(parts, (_k, v) => (v instanceof Uint8Array ? `<${v.length} bytes>` : v));
}

describe('IndexedDB-Schema (§§5/71)', () => {
  it('5. frische Installation legt alle Stores und Indizes an', async () => {
    const db = await freshDb();
    expect(db.version).toBe(OFFLINE_SCHEMA_VERSION);
    expect([...db.raw.objectStoreNames].sort()).toEqual([
      'bookings',
      'conflicts',
      'documents',
      'machines',
      'media',
      'meta',
      'mutations',
      'packages',
      'receipts',
      'workspace',
    ]);
    const tx = db.raw.transaction(['mutations', 'bookings', 'machines', 'documents', 'media']);
    expect([...tx.objectStore('mutations').indexNames].sort()).toEqual([
      'byContext',
      'bySeq',
      'byStatus',
    ]);
    expect([...tx.objectStore('bookings').indexNames]).toEqual(['byPackage']);
    expect([...tx.objectStore('machines').indexNames]).toEqual(['byQrHash']);
    expect([...tx.objectStore('documents').indexNames]).toEqual(['byBooking']);
    expect([...tx.objectStore('media').indexNames]).toEqual(['byStatus']);
    expect(OFFLINE_MIGRATIONS.map((m) => m.version)).toEqual([1, 2]);
    db.close();
  });

  it('115. Umgebungen desselben Benutzers teilen sich weder Datenbank noch Daten noch Schlüssel', async () => {
    const dev = offlineDbName('development', 'same-user');
    const demo = offlineDbName('demo', 'same-user');
    names.push(dev, demo);
    expect(dev).toBe('mietroyal-offline-development-same-user');
    expect(dev).not.toBe(demo);
    const devStore = new OfflineStore(new OfflineDb(await openOfflineDatabase(dev)));
    devStore.setKey(await generateDek());
    await devStore.putBooking(
      { bookingId: 'b', processId: 'p', packageId: 'k', relevantDay: null, updatedAt: 'v' },
      { name: 'Nur Entwicklung' },
    );
    const demoStore = new OfflineStore(new OfflineDb(await openOfflineDatabase(demo)));
    demoStore.setKey(await generateDek());
    expect(await demoStore.listBookingRecords()).toEqual([]);
    expect(await demoStore.getBooking('b')).toBeNull();
    // Fremder Schlüssel (andere Umgebung) entschlüsselt die Development-Daten nicht.
    const cross = new OfflineStore(new OfflineDb(await openOfflineDatabase(dev)));
    cross.setKey(await generateDek());
    expect(await cross.getBooking('b')).toBeNull();
    expect((await cross.listBookingRecords()).length).toBe(1);
    devStore.db.close();
    demoStore.db.close();
    cross.db.close();
  });

  it('6./7. Upgrade von Version 1 auf die aktuelle Version erhält pending Mutations; Downgrade bricht ab', async () => {
    const name = offlineDbName('development', 'upgrade-user');
    names.push(name);
    const v1 = new OfflineDb(await openOfflineDatabase(name, 1, OFFLINE_MIGRATIONS));
    expect(v1.version).toBe(1);
    expect([...v1.raw.transaction('mutations').objectStore('mutations').indexNames]).not.toContain(
      'byContext',
    );
    const dek = await generateDek();
    const store = new OfflineStore(v1);
    store.setKey(dek);
    await store.enqueueMutation({
      clientMutationId: 'm-1',
      type: 'handover.recipient',
      contextKind: 'booking',
      contextId: 'b-1',
      payload: { kind: 'customer', name: 'Erika', phone: null },
      summary: { processNumber: 'MR-1', actionLabel: 'Empfänger', detail: null },
      createdAt: '2026-09-28T08:00:00.000Z',
      dependsOn: [],
    });
    await store.putMedia({
      mediaId: 'media-1',
      purpose: 'handover_photo',
      mimeType: 'image/jpeg',
      bytes: new Uint8Array([1, 2, 3]),
      sha256: 'a'.repeat(64),
      contextKind: 'booking',
      contextId: 'b-1',
      createdAt: '2026-09-28T08:00:00.000Z',
    });
    v1.close();

    const v2 = new OfflineDb(await openOfflineDatabase(name));
    expect(v2.version).toBe(OFFLINE_SCHEMA_VERSION);
    expect([...v2.raw.transaction('mutations').objectStore('mutations').indexNames]).toContain(
      'byContext',
    );
    const upgraded = new OfflineStore(v2);
    upgraded.setKey(dek);
    const records = await upgraded.listMutationRecords();
    expect(records.map((m) => [m.clientMutationId, m.status, m.seq])).toEqual([
      ['m-1', 'pending', 1],
    ]);
    expect((await upgraded.getMutation('m-1'))?.payload).toEqual({
      kind: 'customer',
      name: 'Erika',
      phone: null,
    });
    expect((await upgraded.listMutationsForContext('booking', 'b-1')).length).toBe(1);
    expect((await upgraded.getMediaBytes('media-1'))?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    // Zähler läuft nach dem Upgrade weiter (keine doppelte Sequenz).
    const next = await upgraded.enqueueMutation({
      clientMutationId: 'm-2',
      type: 'handover.finalize',
      contextKind: 'booking',
      contextId: 'b-1',
      payload: { capturedAt: '2026-09-28T08:05:00.000Z', expectedSlots: [] },
      summary: { processNumber: 'MR-1', actionLabel: 'Abschluss', detail: null },
      createdAt: '2026-09-28T08:05:00.000Z',
      dependsOn: ['m-1'],
    });
    expect(next.seq).toBe(2);
    v2.close();

    // Downgrade (ältere App gegen neuere Datenbank): VersionError, keine Datenlöschung.
    await expect(openOfflineDatabase(name, 1, OFFLINE_MIGRATIONS)).rejects.toMatchObject({
      name: 'VersionError',
    });
    const again = new OfflineDb(await openOfflineDatabase(name));
    expect(await again.count('mutations')).toBe(2);
    again.close();
  });
});

describe('Verschlüsselnder Store (§§8/12/92)', () => {
  it('8./92. Fachpayloads liegen nur verschlüsselt vor; ohne DEK kein Zugriff', async () => {
    const db = await freshDb();
    const store = new OfflineStore(db);
    await expect(store.getBooking('b')).rejects.toBeInstanceOf(WorkspaceLockedError);
    await expect(
      store.putBooking(
        { bookingId: 'b', processId: 'p', packageId: 'k', relevantDay: null, updatedAt: 'v' },
        { name: 'x' },
      ),
    ).rejects.toBeInstanceOf(WorkspaceLockedError);
    const dek = await generateDek();
    store.setKey(dek);
    await store.putPackage(
      {
        packageId: 'pkg-1',
        environment: 'development',
        createdAt: 'c',
        serverTime: 's',
        horizonFrom: '2026-09-25',
        horizonTo: '2026-10-01',
        expiresAt: 'e',
        bookingIds: ['b-1'],
        machineIds: [],
      },
      { permissions: ['handover.view'], inventory: [{ name: 'Sirup Cola' }] },
    );
    await store.putBooking(
      { bookingId: 'b-1', processId: 'p-1', packageId: 'pkg-1', relevantDay: null, updatedAt: 'v' },
      { customer: { name: 'Klara Kommerz', phone: '0171 9998877' } },
    );
    await store.putDocument(
      {
        documentId: 'doc-1',
        bookingId: 'b-1',
        type: 'delivery_note',
        createdAt: 'c',
        sha256: 'd'.repeat(64),
        byteSize: 4,
      },
      new TextEncoder().encode('%PDF'),
    );
    await store.enqueueMutation({
      clientMutationId: 'm-1',
      type: 'handover.recipient',
      contextKind: 'booking',
      contextId: 'b-1',
      payload: { kind: 'other', name: 'Vertreter Volker', phone: '0160 1234567' },
      summary: { processNumber: 'MR-1', actionLabel: 'Empfänger', detail: null },
      createdAt: '2026-09-28T08:00:00.000Z',
      dependsOn: [],
    });
    await store.putMedia({
      mediaId: 'media-1',
      purpose: 'handover_signature',
      mimeType: 'image/png',
      bytes: new TextEncoder().encode('SIGNATURBYTES'),
      sha256: 'a'.repeat(64),
      contextKind: 'booking',
      contextId: 'b-1',
      createdAt: '2026-09-28T08:00:00.000Z',
    });
    await store.putConflict('m-1', {
      code: 'SERVER_STATE_CHANGED',
      status: 'conflict',
      message: 'Serverstand: Empfänger Klara Kommerz',
      serverState: { recipient: 'Klara Kommerz' },
      details: null,
      processedAt: 'p',
    });

    const raw = await rawDump(db);
    for (const secret of [
      'Klara Kommerz',
      '0171 9998877',
      'Vertreter Volker',
      '0160 1234567',
      'Sirup Cola',
      'SIGNATURBYTES',
      '%PDF',
      'handover.view',
    ]) {
      expect(raw).not.toContain(secret);
    }
    // Technische Felder bleiben lesbar (Indizes/Status).
    expect(raw).toContain('"status":"pending"');
    expect(raw).toContain('"contextId":"b-1"');
    expect(raw).toContain('"code":"SERVER_STATE_CHANGED"');

    // Entschlüsselt wieder vollständig – nur mit dem passenden Schlüssel.
    expect(
      (await store.getBooking<{ customer: { name: string } }>('b-1'))?.payload.customer.name,
    ).toBe('Klara Kommerz');
    expect((await store.getDocumentBytes('doc-1'))?.bytes).toEqual(
      new TextEncoder().encode('%PDF'),
    );
    expect((await store.getConflict('m-1'))?.payload.serverState).toEqual({
      recipient: 'Klara Kommerz',
    });
    expect(
      (await store.getPackage<{ permissions: string[] }>('pkg-1'))?.payload.permissions,
    ).toEqual(['handover.view']);
    store.setKey(await generateDek());
    expect(await store.getBooking('b-1')).toBeNull();
    expect(await store.getMediaBytes('media-1')).toBeNull();
    store.setKey(null);
    await expect(store.getMutation('m-1')).rejects.toBeInstanceOf(WorkspaceLockedError);
    db.close();
  });

  it('QR-Auflösung nur über Hash; Medien und Mutationen verschlüsselt; Zähler/Status/Wipe', async () => {
    const db = await freshDb();
    const store = new OfflineStore(db);
    store.setKey(await generateDek());
    const token = 'QR-Token-SECRET-0123456789abcdef';
    const qrHash = await sha256Hex(token.toLowerCase());
    await store.putMachines([
      {
        record: { machineId: 'mac-1', qrHash, packageId: 'pkg-1', updatedAt: 'u' },
        payload: { machineCode: 'MR-10-01-03', status: 'ready', qrHash },
      },
    ]);
    expect((await rawDump(db)).toLowerCase()).not.toContain(token.toLowerCase());
    expect(
      (await store.findMachineByQrHash<{ machineCode: string }>(qrHash))?.payload.machineCode,
    ).toBe('MR-10-01-03');
    expect(await store.findMachineByQrHash(await sha256Hex('unbekannt'))).toBeNull();
    expect((await store.listMachineRecords()).map((m) => m.machineId)).toEqual(['mac-1']);

    const first = await store.enqueueMutation({
      clientMutationId: 'm-1',
      type: 'machine.clean_complete',
      contextKind: 'machine',
      contextId: 'mac-1',
      payload: { expectedCleaningSince: null },
      summary: { processNumber: null, actionLabel: 'Reinigung', detail: 'MR-10-01-03' },
      createdAt: '2026-09-28T08:00:00.000Z',
      dependsOn: [],
      baseVersion: '{"machineUpdatedAt":null}',
    });
    const second = await store.enqueueMutation({
      clientMutationId: 'm-2',
      type: 'return.start',
      contextKind: 'booking',
      contextId: 'b-1',
      payload: {},
      summary: { processNumber: 'MR-1', actionLabel: 'Rückgabe', detail: null },
      createdAt: '2026-09-28T08:01:00.000Z',
      dependsOn: [],
      mediaIds: [],
    });
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(first.baseVersion).toBe('{"machineUpdatedAt":null}');
    expect(second.baseVersion).toBeNull();
    expect((await store.listMutationsForContext('machine', 'mac-1')).map((m) => m.seq)).toEqual([
      1,
    ]);
    await store.updateMutation('m-2', { status: 'conflict', lastErrorCode: 'NOT_VISIBLE' }, 'n');
    expect(await store.countByStatus()).toEqual({
      pending: 1,
      syncing: 0,
      synced: 0,
      conflict: 1,
      failed_retryable: 0,
      failed_permanent: 0,
    });
    expect(await store.updateMutation('fehlt', { status: 'synced' }, 'n')).toBeNull();
    const media = await store.putMedia({
      mediaId: 'media-1',
      purpose: 'return_damage_photo',
      mimeType: 'image/jpeg',
      bytes: new Uint8Array([9, 9, 9, 9]),
      sha256: 'b'.repeat(64),
      contextKind: 'booking',
      contextId: 'b-1',
      createdAt: 'c',
    });
    expect(media.byteSize).toBe(4);
    expect(media.status).toBe('pending');
    expect((await store.updateMedia('media-1', { status: 'uploaded' }))?.status).toBe('uploaded');
    expect((await store.listMediaRecords()).map((m) => m.status)).toEqual(['uploaded']);
    await store.putReceipt({
      clientMutationId: 'm-1',
      status: 'applied',
      processedAt: 'p',
      resultRef: { damageId: 'd' },
      code: null,
    });
    expect((await store.getReceipt('m-1'))?.resultRef).toEqual({ damageId: 'd' });
    expect((await store.listReceipts()).length).toBe(1);
    await store.deleteReceipts(['m-1']);
    expect(await store.getReceipt('m-1')).toBeUndefined();
    await store.wipeAll();
    expect(await db.count('mutations')).toBe(0);
    expect(await db.count('machines')).toBe(0);
    expect(await db.count('media')).toBe(0);
    db.close();
  });
});
