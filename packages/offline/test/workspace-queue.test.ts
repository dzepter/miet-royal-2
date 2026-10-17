import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateDek, randomBytes, toBase64Url } from '../src/crypto.ts';
import { OfflineDb, deleteOfflineDatabase, offlineDbName, openOfflineDatabase } from '../src/db.ts';
import {
  SessionInvalidError,
  SyncEngine,
  TransientSyncError,
  backoffDelayMs,
  type SyncMutationEnvelope,
  type SyncOutcome,
  type SyncTransport,
} from '../src/queue.ts';
import { OfflineStore } from '../src/store.ts';
import { OfflineWorkspace, WorkspaceRekeyRefusedError, type LeaseGrant } from '../src/workspace.ts';
import { createTestSigner, type TestSigner } from './lease-signer.ts';

const names: string[] = [];
async function fresh(): Promise<{ db: OfflineDb; store: OfflineStore }> {
  const name = offlineDbName('development', `ws-${Math.random().toString(16).slice(2)}`);
  names.push(name);
  const db = new OfflineDb(await openOfflineDatabase(name));
  return { db, store: new OfflineStore(db) };
}
afterEach(async () => {
  for (const name of names.splice(0)) await deleteOfflineDatabase(name);
});

const IDENTITY = { userId: 'user-1', environment: 'development' as const, deviceId: 'device-1' };
/** Server-Signer (Ed25519) der Tests – jeder Grant trägt einen gültig signierten Claim (§1). */
let signer: TestSigner;
beforeAll(async () => {
  signer = await createTestSigner();
});
function grant(overrides: Partial<LeaseGrant> = {}): Promise<LeaseGrant> {
  return signer.grant(overrides);
}

describe('Offline-Workspace: Entsperrung und Lease (§§7/8, Tests 9–13, 103)', () => {
  it('10./9. korrektes Passwort entsperrt, falsches Passwort entschlüsselt nichts', async () => {
    const { store } = await fresh();
    let now = new Date('2026-09-28T09:00:00.000Z');
    const ws = new OfflineWorkspace(store, IDENTITY, () => now);
    await ws.authorizeOnline(await grant(), 'geheimes-passwort-1');
    await store.putBooking(
      { bookingId: 'b', processId: 'p', packageId: 'k', relevantDay: null, updatedAt: 'v' },
      { name: 'Kunde' },
    );
    ws.lock();
    expect(ws.unlocked).toBe(false);
    await expect(store.getBooking('b')).rejects.toThrow();
    expect(await ws.unlockWithPassword('falsch-falsch-1')).toEqual({
      ok: false,
      reason: 'wrong_password',
    });
    expect(ws.unlocked).toBe(false);
    expect(await ws.unlockWithPassword('geheimes-passwort-1')).toEqual({ ok: true });
    expect((await store.getBooking<{ name: string }>('b'))?.payload.name).toBe('Kunde');
    now = new Date('2026-09-29T09:00:00.000Z');
    expect((await ws.leaseState()).kind).toBe('valid');
  });

  it('14. der Workspace-Datensatz enthält weder Passwort noch Passworthash noch TOTP-Secrets', async () => {
    const { store, db } = await fresh();
    const ws = new OfflineWorkspace(store, IDENTITY, () => new Date('2026-09-28T09:00:00.000Z'));
    const g = await grant();
    await ws.authorizeOnline(g, 'geheimes-passwort-1');
    const raw = JSON.stringify(await db.getAll('workspace'), (_k, v) =>
      v instanceof Uint8Array ? `<${v.length} bytes>` : v,
    );
    expect(raw).not.toContain('geheimes-passwort-1');
    expect(raw).not.toContain(g.leaseSecret);
    expect(raw).not.toMatch(/argon2|totp|password_hash|passwordHash/i);
    expect(raw).toContain('"leaseId":"lease-1"');
    expect(raw).toContain('"kdfIterations":600000');
  });

  it('12./13. Lease gültig innerhalb 72 h, danach blockiert die Offline-Entsperrung; Online-Neuautorisierung öffnet wieder', async () => {
    const { store } = await fresh();
    let now = new Date('2026-09-28T09:00:00.000Z');
    const ws = new OfflineWorkspace(store, IDENTITY, () => now);
    await ws.authorizeOnline(await grant(), 'geheimes-passwort-1');
    await store.putBooking(
      { bookingId: 'b', processId: 'p', packageId: 'k', relevantDay: null, updatedAt: 'v' },
      { name: 'Kunde' },
    );
    ws.lock();
    now = new Date('2026-09-30T20:00:00.000Z'); // 60 h später
    expect(await ws.unlockWithPassword('geheimes-passwort-1')).toEqual({ ok: true });
    ws.lock();
    now = new Date('2026-10-01T09:00:00.000Z'); // 73 h später
    expect(await ws.unlockWithPassword('geheimes-passwort-1')).toEqual({
      ok: false,
      reason: 'lease_expired',
    });
    expect(ws.unlocked).toBe(false);
    expect((await ws.leaseState()).kind).toBe('expired');
    // Ohne Passwort und ohne Schlüssel darf der bestehende Arbeitsbereich nicht
    // still neu verschlüsselt werden (Pending-Daten wären verloren).
    const freshLease = {
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 72 * 3_600_000).toISOString(),
    };
    await expect(
      ws.authorizeOnline(await grant({ leaseId: 'lease-x', ...freshLease }), null, {
        allowNewDek: false,
      }),
    ).rejects.toBeInstanceOf(WorkspaceRekeyRefusedError);
    // Online erneut autorisiert: neue Lease, gleicher DEK (bestehende Daten lesbar).
    store.setKey(null);
    await ws.authorizeOnline(
      await grant({
        leaseId: 'lease-2',
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 72 * 3_600_000).toISOString(),
      }),
      'geheimes-passwort-1',
    );
    expect(ws.unlocked).toBe(true);
    expect((await store.getBooking<{ name: string }>('b'))?.payload.name).toBe('Kunde');
    const state = await ws.leaseState();
    expect(state.kind).toBe('valid');
    expect(state.kind === 'valid' && state.lease.leaseId).toBe('lease-2');
    // Passwortwechsel: Wrap A folgt dem neuen Passwort, Daten bleiben.
    await ws.rewrapWithPassword('neues-passwort-2');
    ws.lock();
    expect(await ws.unlockWithPassword('geheimes-passwort-1')).toEqual({
      ok: false,
      reason: 'wrong_password',
    });
    expect(await ws.unlockWithPassword('neues-passwort-2')).toEqual({ ok: true });
  });

  it('Flüchtige Schlüsselübergabe: nur der passende DEK entsperrt (Lease-MAC), ein fremder wird verworfen', async () => {
    const { store } = await fresh();
    let now = new Date('2026-09-28T09:00:00.000Z');
    const ws = new OfflineWorkspace(store, IDENTITY, () => now);
    await ws.authorizeOnline(await grant(), 'geheimes-passwort-1');
    const key = ws.currentKey();
    expect(key).not.toBeNull();
    ws.lock();
    expect(ws.currentKey()).toBeNull();
    // Fremder Schlüssel (anderer Arbeitsbereich): Lease-MAC passt nicht ⇒ nicht übernommen.
    const foreign = await generateDek();
    expect(await ws.unlockWithKey(foreign)).toEqual({ ok: false, reason: 'lease_tampered' });
    expect(ws.unlocked).toBe(false);
    // Passender Schlüssel: entsperrt mit denselben Lease-Prüfungen.
    expect(await ws.unlockWithKey(key as CryptoKey)).toEqual({ ok: true });
    expect(ws.unlocked).toBe(true);
    ws.lock();
    now = new Date('2026-10-01T09:00:00.000Z'); // Lease abgelaufen ⇒ auch der richtige Schlüssel öffnet nicht
    expect(await ws.unlockWithKey(key as CryptoKey)).toEqual({
      ok: false,
      reason: 'lease_expired',
    });
  });

  it('103. lokal verlängerte Lease wird als manipuliert erkannt', async () => {
    const { store } = await fresh();
    const now = new Date('2026-09-28T09:00:00.000Z');
    const ws = new OfflineWorkspace(store, IDENTITY, () => now);
    await ws.authorizeOnline(await grant(), 'geheimes-passwort-1');
    ws.lock();
    const record = (await store.getWorkspace())!;
    await store.putWorkspace({
      ...record,
      lease: { ...record.lease!, expiresAt: '2030-01-01T00:00:00.000Z' },
    });
    expect(await ws.unlockWithPassword('geheimes-passwort-1')).toEqual({
      ok: false,
      reason: 'lease_tampered',
    });
    expect(ws.unlocked).toBe(false);
    // Auch erweiterte Rechte im lokalen Snapshot fallen auf (nur Darstellung, aber integer).
    await store.putWorkspace({
      ...record,
      lease: { ...record.lease!, permissions: [...record.lease!.permissions, 'employee.manage'] },
    });
    expect(await ws.unlockWithPassword('geheimes-passwort-1')).toEqual({
      ok: false,
      reason: 'lease_tampered',
    });
  });

  it('Stille Online-Entsperrung nur mit dem passenden Lease-Secret; Widerruf entwertet die Lease lokal ohne Datenverlust', async () => {
    const { store } = await fresh();
    const ws = new OfflineWorkspace(store, IDENTITY, () => new Date('2026-09-28T09:00:00.000Z'));
    const g = await grant();
    await ws.authorizeOnline(g, null);
    await store.putBooking(
      { bookingId: 'b', processId: 'p', packageId: 'k', relevantDay: null, updatedAt: 'v' },
      { name: 'Kunde' },
    );
    ws.lock();
    expect(await ws.unlockWithLeaseSecret('lease-1', toBase64Url(randomBytes(32)))).toEqual({
      ok: false,
      reason: 'wrong_password',
    });
    expect(await ws.unlockWithLeaseSecret('lease-1', g.leaseSecret)).toEqual({ ok: true });
    await ws.invalidateLease();
    ws.lock();
    expect(await ws.unlockWithLeaseSecret('lease-1', g.leaseSecret)).toEqual({
      ok: false,
      reason: 'lease_expired',
    });
    expect((await ws.leaseState()).kind).toBe('none');
    // Daten sind nicht vernichtet: nach erneuter Online-Autorisierung (mit Passwort) lesbar.
    expect((await store.getWorkspace())?.wrappedByLease).toBeNull();
    await ws
      .authorizeOnline(await grant({ leaseId: 'lease-2' }), 'geheimes-passwort-1', {
        allowNewDek: false,
      })
      .catch((error: unknown) => {
        // Ohne Wrap A (nie mit Passwort autorisiert) ist der DEK ohne Schlüssel nicht wiederherstellbar.
        expect(error).toBeInstanceOf(WorkspaceRekeyRefusedError);
      });
    expect((await store.listBookingRecords()).length).toBe(1);
  });
});

// ── Sync-Queue ────────────────────────────────────────────────────────────

interface RecordingTransport extends SyncTransport {
  calls: string[];
}

function transportWith(
  handler: (envelope: SyncMutationEnvelope) => SyncOutcome | Error,
): RecordingTransport {
  const calls: string[] = [];
  return {
    calls,
    send(envelope) {
      calls.push(envelope.clientMutationId);
      const outcome = handler(envelope);
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };
}

/** Schaden → Schadenfoto (Medium) → Abschluss, alle pending. */
async function seeded(store: OfflineStore): Promise<void> {
  store.setKey(await generateDek());
  await store.putMedia({
    mediaId: 'photo-1',
    purpose: 'return_damage_photo',
    mimeType: 'image/jpeg',
    bytes: new Uint8Array([1, 2, 3]),
    sha256: 'h'.repeat(64),
    contextKind: 'booking',
    contextId: 'b-1',
    createdAt: '2026-09-28T08:00:00.000Z',
  });
  await store.enqueueMutation({
    clientMutationId: 'damage',
    type: 'return.damage',
    contextKind: 'booking',
    contextId: 'b-1',
    payload: { clientDamageId: 'd-1', description: 'Kratzer' },
    summary: { processNumber: 'MR-1', actionLabel: 'Schaden', detail: null },
    createdAt: '2026-09-28T08:00:00.000Z',
    dependsOn: [],
  });
  await store.enqueueMutation({
    clientMutationId: 'photo',
    type: 'return.damage_photo',
    contextKind: 'booking',
    contextId: 'b-1',
    payload: { damageMutationId: 'damage', damageId: null, mediaId: 'photo-1' },
    summary: { processNumber: 'MR-1', actionLabel: 'Foto', detail: null },
    createdAt: '2026-09-28T08:01:00.000Z',
    dependsOn: ['damage'],
    mediaIds: ['photo-1'],
  });
  await store.enqueueMutation({
    clientMutationId: 'finalize',
    type: 'return.finalize',
    contextKind: 'booking',
    contextId: 'b-1',
    payload: {},
    summary: { processNumber: 'MR-1', actionLabel: 'Abschluss', detail: null },
    createdAt: '2026-09-28T08:02:00.000Z',
    dependsOn: ['damage', 'photo'],
  });
}

const applied = (e: SyncMutationEnvelope): SyncOutcome => ({
  status: 'applied',
  resultRef: { id: e.clientMutationId },
  processedAt: 'p',
});

describe('Sync-Queue (§§27–31/36, Tests 69–80)', () => {
  it('Unterbrochener Lauf: „syncing“ ohne Ergebnis wird beim nächsten Lauf erneut gesendet (Receipts machen es idempotent)', async () => {
    const { store } = await fresh();
    await seeded(store);
    // Simuliert: Seite wurde mitten in der Übertragung von „damage“ geschlossen.
    await store.updateMutation('damage', { status: 'syncing' }, '2026-09-28T08:59:00.000Z');
    const transport = transportWith(applied);
    const engine = new SyncEngine(store, transport, {
      now: () => new Date('2026-09-28T09:00:00.000Z'),
    });
    expect(await engine.pendingCount()).toBe(3);
    const run = await engine.runOnce();
    expect(transport.calls).toEqual(['damage', 'photo', 'finalize']);
    expect(run.applied).toBe(3);
    expect(await engine.pendingCount()).toBe(0);
    expect((await store.listReceipts()).map((r) => r.clientMutationId).sort()).toEqual([
      'damage',
      'finalize',
      'photo',
    ]);
    expect((await store.listMediaRecords())[0]?.status).toBe('uploaded');
  });

  it('70./71./72. Abhängigkeiten: Medien-Mutation vor Finalisierung; transienter Fehler ⇒ Backoff und Retry', async () => {
    const { store } = await fresh();
    await seeded(store);
    let photoFails = true;
    const transport = transportWith((e) => {
      if (e.clientMutationId === 'photo' && photoFails)
        return new TransientSyncError('SERVER_UNAVAILABLE');
      return applied(e);
    });
    let now = new Date('2026-09-28T09:00:00.000Z');
    const engine = new SyncEngine(store, transport, {
      now: () => now,
      backoffBaseMs: 10_000,
      backoffCapMs: 60_000,
    });
    const first = await engine.runOnce();
    expect(transport.calls).toEqual(['damage', 'photo']); // finalize wartet auf photo
    expect(first).toMatchObject({ attempted: 2, applied: 1, transientFailures: 1 });
    const photo = (await store.listMutationRecords()).find((m) => m.clientMutationId === 'photo')!;
    expect(photo.status).toBe('failed_retryable');
    expect(photo.retryCount).toBe(1);
    expect(photo.lastErrorCode).toBe('SERVER_UNAVAILABLE');
    expect(photo.nextAttemptAt).toBe(new Date(now.getTime() + 10_000).toISOString());
    // Medien-Bytes werden mit dem Envelope übertragen (Medien vor Finalisierung, Test 71).
    // Innerhalb des Backoff-Fensters: kein erneuter Versuch (außer force).
    photoFails = false;
    now = new Date(now.getTime() + 5_000);
    expect((await engine.runOnce()).attempted).toBe(0);
    expect(transport.calls).toEqual(['damage', 'photo']);
    now = new Date(now.getTime() + 6_000);
    const second = await engine.runOnce();
    expect(second).toMatchObject({ attempted: 2, applied: 2, transientFailures: 0 });
    expect(transport.calls).toEqual(['damage', 'photo', 'photo', 'finalize']);
    expect(await engine.pendingCount()).toBe(0);
    expect(backoffDelayMs(1, 10_000, 60_000)).toBe(10_000);
    expect(backoffDelayMs(2, 10_000, 60_000)).toBe(20_000);
    expect(backoffDelayMs(3, 10_000, 60_000)).toBe(40_000);
    expect(backoffDelayMs(4, 10_000, 60_000)).toBe(60_000);
  });

  it('72. erschöpfte automatische Versuche: kein weiterer Auto-Retry, manuell (force) weiterhin möglich', async () => {
    const { store } = await fresh();
    await seeded(store);
    let fails = true;
    const transport = transportWith((e) =>
      fails ? new TransientSyncError('HTTP_503') : applied(e),
    );
    let now = new Date('2026-09-28T09:00:00.000Z');
    const engine = new SyncEngine(store, transport, {
      now: () => now,
      backoffBaseMs: 1_000,
      backoffCapMs: 1_000,
      maxAutoRetries: 2,
    });
    await engine.runOnce();
    now = new Date(now.getTime() + 2_000);
    await engine.runOnce();
    expect(transport.calls).toEqual(['damage', 'damage']);
    const damage = (await store.listMutationRecords()).find(
      (m) => m.clientMutationId === 'damage',
    )!;
    expect(damage.status).toBe('failed_retryable');
    expect(damage.retryCount).toBe(2);
    expect(damage.nextAttemptAt).toBeNull();
    now = new Date(now.getTime() + 60_000);
    expect((await engine.runOnce()).attempted).toBe(0);
    expect(await engine.pendingCount()).toBe(3); // weiterhin offene Arbeit
    fails = false;
    expect((await engine.runOnce({ force: true })).applied).toBe(3);
    expect(await engine.pendingCount()).toBe(0);
  });

  it('73./77./79. fachlicher Konflikt: kein Endlos-Retry, Payload und Medien bleiben, Bereinigung lässt Konflikte stehen', async () => {
    const { store } = await fresh();
    await seeded(store);
    let damageConflicts = true;
    const transport = transportWith((e) =>
      e.clientMutationId === 'damage' && damageConflicts
        ? {
            status: 'conflict',
            code: 'ALREADY_FINALIZED',
            message: 'Bereits abgeschlossen',
            serverState: { returnStatus: 'completed' },
            processedAt: 'p',
          }
        : applied(e),
    );
    let now = new Date('2026-09-28T09:00:00.000Z');
    const engine = new SyncEngine(store, transport, { now: () => now, cleanupDelayMs: 0 });
    await engine.runOnce();
    await engine.runOnce({ force: true });
    expect(transport.calls).toEqual(['damage']); // abhängige Mutationen nie gesendet, kein Retry des Konflikts
    expect((await store.getMutation('damage'))?.status).toBe('conflict');
    expect((await store.getMutation('damage'))?.payload).toEqual({
      clientDamageId: 'd-1',
      description: 'Kratzer',
    });
    expect(await engine.conflictCount()).toBe(1);
    expect(await engine.pendingCount()).toBe(2);
    const conflict = await store.getConflict<{ message: string; serverState: unknown }>('damage');
    expect(conflict?.code).toBe('ALREADY_FINALIZED');
    expect(conflict?.payload.message).toBe('Bereits abgeschlossen');
    expect(conflict?.payload.serverState).toEqual({ returnStatus: 'completed' });
    now = new Date('2026-09-30T09:00:00.000Z');
    const cleaned = await engine.cleanupSynced();
    expect(cleaned).toEqual({ mutations: 0, media: 0 });
    expect((await store.listMutationRecords()).length).toBe(3);
    expect((await store.listMediaRecords()).length).toBe(1);
    expect((await store.getMediaBytes('photo-1'))?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    // „Erneut anwenden“ nach Prüfung: normaler Weg über den Server, Kette läuft weiter.
    damageConflicts = false;
    await engine.retryMutation('damage');
    expect(await store.getConflict('damage')).toBeNull();
    expect(await engine.conflictCount()).toBe(0);
    expect((await engine.runOnce()).applied).toBe(3);
    expect(transport.calls).toEqual(['damage', 'damage', 'photo', 'finalize']);
    // bewusstes Verwerfen entfernt Mutation + exklusive Medien
    const { store: other } = await fresh();
    await seeded(other);
    const otherEngine = new SyncEngine(other, transportWith(applied), { now: () => now });
    expect(await otherEngine.discardMutation('photo')).toEqual(['photo']);
    expect((await other.listMediaRecords()).length).toBe(0);
    expect((await other.listMutationRecords()).map((m) => m.clientMutationId)).toEqual([
      'damage',
      'finalize',
    ]);
    expect(await otherEngine.discardMutation('unbekannt')).toEqual([]);
  });

  it('Verwerfen kaskadiert nur auf fachliche Kinder (Schadenfoto), der Abschluss bleibt sendebereit (§29/§34)', async () => {
    const { store } = await fresh();
    await seeded(store);
    const transport = transportWith(applied);
    const engine = new SyncEngine(store, transport, {
      now: () => new Date('2026-09-28T09:00:00.000Z'),
    });
    expect((await engine.discardMutation('damage')).sort()).toEqual(['damage', 'photo']);
    expect((await store.listMutationRecords()).map((m) => m.clientMutationId)).toEqual([
      'finalize',
    ]);
    expect((await store.listMediaRecords()).length).toBe(0); // exklusives Foto entfernt
    await engine.runOnce();
    expect(transport.calls).toEqual(['finalize']); // fehlende (verworfene) Abhängigkeit blockiert nicht
  });

  it('80./88./89./111. Pending-Zähler zählt nur Offenes; Medien einer Konflikt-Mutation (Foto/Unterschrift) bleiben samt Bytes – auch nach der Aufräumfrist', async () => {
    const { store } = await fresh();
    await seeded(store);
    // Unterschrift als weitere medientragende Mutation (Test 89).
    await store.putMedia({
      mediaId: 'sig-1',
      purpose: 'return_signature',
      mimeType: 'image/png',
      bytes: new Uint8Array([7, 8, 9]),
      sha256: 's'.repeat(64),
      contextKind: 'booking',
      contextId: 'b-1',
      createdAt: '2026-09-28T08:03:00.000Z',
    });
    await store.enqueueMutation({
      clientMutationId: 'signature',
      type: 'return.signature',
      contextKind: 'booking',
      contextId: 'b-1',
      payload: { role: 'customer', mediaId: 'sig-1' },
      summary: { processNumber: 'MR-1', actionLabel: 'Unterschrift', detail: null },
      createdAt: '2026-09-28T08:03:00.000Z',
      dependsOn: [],
      mediaIds: ['sig-1'],
    });
    await store.updateMutation('damage', { status: 'syncing' }, '2026-09-28T08:59:00.000Z');
    const transport = transportWith((e) =>
      e.clientMutationId === 'damage' || e.clientMutationId === 'signature'
        ? {
            status: 'conflict',
            code: 'ALREADY_FINALIZED',
            message: 'Bereits abgeschlossen',
            serverState: null,
            processedAt: 'p',
          }
        : applied(e),
    );
    let now = new Date('2026-09-28T09:00:00.000Z');
    const engine = new SyncEngine(store, transport, { now: () => now, cleanupDelayMs: 0 });
    expect(await engine.pendingCount()).toBe(4); // damage (syncing), photo, finalize, signature
    await engine.runOnce();
    // Konflikt ⇒ nicht mehr „ausstehend“, sondern „Prüfung erforderlich“ (Test 80).
    expect(await engine.pendingCount()).toBe(2); // photo + finalize warten auf damage
    expect(await engine.conflictCount()).toBe(2);
    // Medien der konfliktierten Mutationen bleiben samt Bytes erhalten (Tests 88/89).
    expect((await store.getMediaBytes('photo-1'))?.bytes.length).toBeGreaterThan(0);
    expect((await store.getMediaBytes('sig-1'))?.bytes).toEqual(new Uint8Array([7, 8, 9]));
    now = new Date('2026-10-05T09:00:00.000Z'); // weit nach der Aufräumfrist
    expect(await engine.cleanupSynced()).toEqual({ mutations: 0, media: 0 }); // Test 111
    expect((await store.listMediaRecords()).map((m) => m.mediaId).sort()).toEqual([
      'photo-1',
      'sig-1',
    ]);
  });

  it('78./109./110. erfolgreiche Mutationen und Medien werden nach der Frist bereinigt, pending Medien bleiben', async () => {
    const { store } = await fresh();
    await seeded(store);
    // Zusätzliches pending Foto (noch keiner gesendeten Mutation zugeordnet, z. B. Erfassung läuft).
    await store.putMedia({
      mediaId: 'photo-2',
      purpose: 'return_cleanup_photo',
      mimeType: 'image/jpeg',
      bytes: new Uint8Array([4, 5, 6]),
      sha256: 'g'.repeat(64),
      contextKind: 'booking',
      contextId: 'b-1',
      createdAt: '2026-09-28T08:05:00.000Z',
    });
    await store.enqueueMutation({
      clientMutationId: 'cleanup',
      type: 'return.cleanup_photo',
      contextKind: 'booking',
      contextId: 'b-2',
      payload: { mediaId: 'photo-2' },
      summary: { processNumber: 'MR-2', actionLabel: 'Reinigungsfoto', detail: null },
      createdAt: '2026-09-28T08:05:00.000Z',
      dependsOn: [],
      mediaIds: ['photo-2'],
    });
    const transport = transportWith((e) =>
      e.clientMutationId === 'cleanup' ? new TransientSyncError('HTTP_502') : applied(e),
    );
    let now = new Date('2026-09-28T09:00:00.000Z');
    const engine = new SyncEngine(store, transport, {
      now: () => now,
      cleanupDelayMs: 60 * 60_000,
    });
    const run = await engine.runOnce();
    expect(run).toMatchObject({ applied: 3, transientFailures: 1 });
    // Vor Ablauf der Frist: nichts entfernen (§36).
    now = new Date('2026-09-28T09:30:00.000Z');
    expect(await engine.cleanupSynced()).toEqual({ mutations: 0, media: 0 });
    expect((await store.listMutationRecords()).length).toBe(4);
    now = new Date('2026-09-28T10:30:00.000Z');
    expect(await engine.cleanupSynced()).toEqual({ mutations: 3, media: 1 });
    expect((await store.listMutationRecords()).map((m) => m.clientMutationId)).toEqual(['cleanup']);
    expect((await store.listMediaRecords()).map((m) => m.mediaId)).toEqual(['photo-2']);
    expect((await store.listReceipts()).length).toBe(0);
    expect(await engine.pendingCount()).toBe(1);
  });

  it('Sitzung ungültig ⇒ Sync bricht ab, Mutation bleibt pending (§39); Rejected ⇒ failed_permanent ohne Retry', async () => {
    const { store } = await fresh();
    await seeded(store);
    let sessionValid = false;
    const transport = transportWith((e) => {
      if (!sessionValid) return new SessionInvalidError();
      if (e.clientMutationId === 'photo')
        return {
          status: 'rejected',
          code: 'MEDIA_HASH_MISMATCH',
          message: 'Medien-Hash stimmt nicht.',
          processedAt: 'p',
        };
      return applied(e);
    });
    let now = new Date('2026-09-28T09:00:00.000Z');
    const engine = new SyncEngine(store, transport, { now: () => now });
    const aborted = await engine.runOnce();
    expect(aborted).toMatchObject({ attempted: 1, applied: 0, sessionInvalid: true });
    expect(transport.calls).toEqual(['damage']);
    expect((await store.getMutation('damage'))?.status).toBe('pending');
    expect((await store.getMutation('damage'))?.retryCount).toBe(0);
    expect(await engine.pendingCount()).toBe(3);

    sessionValid = true;
    const run = await engine.runOnce();
    expect(run).toMatchObject({ applied: 1, rejected: 1, sessionInvalid: false });
    expect(transport.calls).toEqual(['damage', 'damage', 'photo']);
    expect((await store.getMutation('photo'))?.status).toBe('failed_permanent');
    expect((await store.getMutation('photo'))?.lastErrorCode).toBe('MEDIA_HASH_MISMATCH');
    expect((await store.getConflict('photo'))?.status).toBe('rejected');
    expect(await engine.conflictCount()).toBe(1);
    // Kein automatischer Retry; der Abschluss wartet auf die abgelehnte Abhängigkeit.
    now = new Date('2026-09-29T09:00:00.000Z');
    expect((await engine.runOnce({ force: true })).attempted).toBe(0);
    expect(transport.calls).toEqual(['damage', 'damage', 'photo']);
    // Netzwerkausfall beendet den Lauf (NETWORK_ERROR), Rest bleibt für den nächsten Versuch.
    const { store: offline } = await fresh();
    await seeded(offline);
    const failing = transportWith(() => new TransientSyncError('NETWORK_ERROR'));
    const offlineEngine = new SyncEngine(offline, failing, { now: () => now });
    expect(await offlineEngine.runOnce()).toMatchObject({ attempted: 1, transientFailures: 1 });
    expect(failing.calls).toEqual(['damage']);
  });
});
