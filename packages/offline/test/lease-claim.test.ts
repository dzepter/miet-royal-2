/**
 * Client-Lease-Verifikation (Phase-8-Finalisierung §1, Pflichttests 1–7, 9, 11):
 * Nur ein vom Server signierter, unveränderter Claim für genau diese Identität
 * autorisiert den Offline-Arbeitsbereich. Jede lokale Veränderung – im Claim-
 * Text oder im Datensatz – wird offline erkannt; ein lokal mit DEK/HMAC
 * „selbst signierter“ Datensatz ohne gültige Serversignatur wird abgelehnt.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OfflineDb, deleteOfflineDatabase, offlineDbName, openOfflineDatabase } from '../src/db.ts';
import { LeaseInvalidError, verifyLeaseClaim } from '../src/lease-claim.ts';
import { OFFLINE_LEASE_MAX_MS, parseOfflineLeaseClaim } from '../src/package-types.ts';
import type { LeaseRecord } from '../src/records.ts';
import { OfflineStore } from '../src/store.ts';
import { OfflineWorkspace, computeLeaseMac } from '../src/workspace.ts';
import {
  DEFAULT_EXPIRES_AT,
  DEFAULT_ISSUED_AT,
  createTestSigner,
  type TestSigner,
} from './lease-signer.ts';

const IDENTITY = { userId: 'user-1', environment: 'development' as const, deviceId: 'device-1' };
const PASSWORD = 'geheimes-passwort-1';
const AT_ISSUE = new Date('2026-09-28T09:00:00.000Z');

let signer: TestSigner;
let attacker: TestSigner;
beforeAll(async () => {
  signer = await createTestSigner();
  attacker = await createTestSigner();
});

const names: string[] = [];
async function fresh(): Promise<OfflineStore> {
  const name = offlineDbName('development', `lc-${Math.random().toString(16).slice(2)}`);
  names.push(name);
  return new OfflineStore(new OfflineDb(await openOfflineDatabase(name)));
}
afterEach(async () => {
  for (const name of names.splice(0)) await deleteOfflineDatabase(name);
});

/** Eingerichteter, gesperrter Arbeitsbereich mit gültiger Lease (offline weiter prüfbar). */
async function setUp(now: () => Date = () => AT_ISSUE) {
  const store = await fresh();
  const ws = new OfflineWorkspace(store, IDENTITY, now);
  await ws.authorizeOnline(await signer.grant(), PASSWORD);
  const dek = ws.currentKey()!;
  ws.lock();
  return { store, ws, dek };
}

/** Lokalen Lease-Datensatz verändern und – wie ein Angreifer mit DEK – den HMAC neu berechnen. */
async function tamper(
  store: OfflineStore,
  dek: CryptoKey,
  patch: Partial<LeaseRecord>,
  options: { resignMac?: boolean } = {},
): Promise<void> {
  const record = (await store.getWorkspace())!;
  const lease: LeaseRecord = { ...record.lease!, ...patch };
  await store.putWorkspace({
    ...record,
    lease,
    leaseMac:
      options.resignMac === false ? record.leaseMac : await computeLeaseMac(dek, IDENTITY, lease),
  });
}

describe('Lease-Claim: Signatur und Struktur', () => {
  it('1. unveränderter Server-Claim ist offline gültig (ohne Serverkontakt, ohne DEK)', async () => {
    const signed = await signer.signedClaim({});
    const result = await verifyLeaseClaim(signed, IDENTITY);
    expect(result.ok).toBe(true);
    expect(result.ok && result.claim.leaseId).toBe('lease-1');
    expect(result.ok && result.claim.expiresAt).toBe(DEFAULT_EXPIRES_AT);
  });

  it('11b. Signatur eines anderen Schlüssels ⇒ ungültig; Schlüsseltausch im Datensatz ⇒ ungültig bei Pinning', async () => {
    const signed = await signer.signedClaim({});
    const foreign = await attacker.sign(signed.claim);
    expect(await verifyLeaseClaim({ ...signed, signature: foreign }, IDENTITY)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    // Angreifer tauscht Signatur UND Verifikationsschlüssel: mit gepinntem Serverschlüssel abgelehnt.
    const swapped = await attacker.signedClaim({});
    expect(await verifyLeaseClaim(swapped, IDENTITY, signer.verificationKey)).toEqual({
      ok: false,
      reason: 'untrusted_key',
    });
    expect((await verifyLeaseClaim(signed, IDENTITY, signer.verificationKey)).ok).toBe(true);
    // Kaputte/zu kurze Signatur oder Schlüssel: nie durchwinken.
    expect((await verifyLeaseClaim({ ...signed, signature: 'AAAA' }, IDENTITY)).ok).toBe(false);
    expect((await verifyLeaseClaim({ ...signed, verificationKey: 'AAAA' }, IDENTITY)).ok).toBe(
      false,
    );
  });

  it('Claim mit 73 h Laufzeit ⇒ ungültig (auch mit gültiger Signatur)', async () => {
    const expiresAt = new Date(Date.parse(DEFAULT_ISSUED_AT) + 73 * 3_600_000).toISOString();
    const signed = await signer.signedClaim({ expiresAt });
    expect(parseOfflineLeaseClaim(signed.claim)).toBeNull();
    expect(await verifyLeaseClaim(signed, IDENTITY)).toEqual({ ok: false, reason: 'bad_claim' });
    const exact = await signer.signedClaim({
      expiresAt: new Date(Date.parse(DEFAULT_ISSUED_AT) + OFFLINE_LEASE_MAX_MS).toISOString(),
    });
    expect((await verifyLeaseClaim(exact, IDENTITY)).ok).toBe(true);
    const store = await fresh();
    const ws = new OfflineWorkspace(store, IDENTITY, () => AT_ISSUE);
    await expect(
      ws.authorizeOnline(await signer.grant({ expiresAt }), PASSWORD),
    ).rejects.toBeInstanceOf(LeaseInvalidError);
    expect(await store.getWorkspace()).toBeUndefined();
  });

  it('11a. Claim für environment demo bei Identität development ⇒ ungültig (auch Grant-Übernahme)', async () => {
    const signed = await signer.signedClaim({ environment: 'demo' });
    expect(await verifyLeaseClaim(signed, IDENTITY)).toEqual({
      ok: false,
      reason: 'identity_mismatch',
    });
    const store = await fresh();
    const ws = new OfflineWorkspace(store, IDENTITY, () => AT_ISSUE);
    await expect(
      ws.authorizeOnline(await signer.grant({ environment: 'demo' }), PASSWORD),
    ).rejects.toBeInstanceOf(LeaseInvalidError);
    expect(ws.unlocked).toBe(false);
    expect(await store.getWorkspace()).toBeUndefined();
  });

  it('Grant mit gültigem Claim, aber lose Grant-Felder abweichend: der Datensatz folgt NUR dem Claim', async () => {
    const store = await fresh();
    const ws = new OfflineWorkspace(store, IDENTITY, () => AT_ISSUE);
    const g = await signer.grant();
    await ws.authorizeOnline({ ...g, expiresAt: '2030-01-01T00:00:00.000Z' }, PASSWORD);
    const lease = (await store.getWorkspace())!.lease!;
    expect(lease.expiresAt).toBe(DEFAULT_EXPIRES_AT);
    expect(lease.claim).toBe(g.claim);
    expect(lease.signature).toBe(g.signature);
    expect(lease.verificationKey).toBe(g.verificationKey);
  });
});

describe('Lease-Claim im Arbeitsbereich: jede Entsperrung prüft erneut (offline)', () => {
  it('1. unveränderter Datensatz: Passwort-Entsperrung und leaseState offline gültig', async () => {
    const { ws } = await setUp(() => new Date('2026-09-30T20:00:00.000Z')); // 60 h später
    expect((await ws.leaseState()).kind).toBe('valid');
    expect(await ws.unlockWithPassword(PASSWORD)).toEqual({ ok: true });
    expect((await ws.leaseState()).kind).toBe('valid');
  });

  it('2. expiresAt lokal verändert – im Record-Feld (HMAC neu berechnet) ⇒ lease_tampered', async () => {
    const { store, ws, dek } = await setUp();
    await tamper(store, dek, { expiresAt: '2030-01-01T00:00:00.000Z' });
    expect(await ws.unlockWithPassword(PASSWORD)).toEqual({ ok: false, reason: 'lease_tampered' });
    expect(ws.unlocked).toBe(false);
    expect(await ws.leaseState()).toEqual({ kind: 'tampered', reason: 'record_mismatch' });
  });

  it('2. expiresAt im Claim-Text verändert (Signatur passt nicht mehr) ⇒ lease_tampered', async () => {
    const { store, ws, dek } = await setUp();
    const record = (await store.getWorkspace())!;
    const forged = JSON.stringify({
      ...(JSON.parse(record.lease!.claim) as Record<string, unknown>),
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    await tamper(store, dek, { claim: forged, expiresAt: '2030-01-01T00:00:00.000Z' });
    expect(await ws.unlockWithPassword(PASSWORD)).toEqual({ ok: false, reason: 'lease_tampered' });
    expect(await ws.leaseState()).toEqual({ kind: 'tampered', reason: 'bad_signature' });
    // Flüchtiger Schlüssel (Service Worker) öffnet ebenso wenig.
    expect(await ws.unlockWithKey(dek)).toEqual({ ok: false, reason: 'lease_tampered' });
  });

  it('3. issuedAt lokal verändert ⇒ lease_tampered', async () => {
    const { store, ws, dek } = await setUp();
    await tamper(store, dek, { issuedAt: '2026-09-29T08:00:00.000Z' });
    expect(await ws.unlockWithPassword(PASSWORD)).toEqual({ ok: false, reason: 'lease_tampered' });
  });

  it('4. userId lokal verändert ⇒ lease_tampered', async () => {
    const { store, ws, dek } = await setUp();
    await tamper(store, dek, { userId: 'user-2' });
    expect(await ws.unlockWithPassword(PASSWORD)).toEqual({ ok: false, reason: 'lease_tampered' });
  });

  it('5. deviceId lokal verändert ⇒ lease_tampered', async () => {
    const { store, ws, dek } = await setUp();
    await tamper(store, dek, { deviceId: 'device-2' });
    expect(await ws.unlockWithPassword(PASSWORD)).toEqual({ ok: false, reason: 'lease_tampered' });
  });

  it('6. environment lokal verändert ⇒ lease_tampered', async () => {
    const { store, ws, dek } = await setUp();
    await tamper(store, dek, { environment: 'demo' });
    expect(await ws.unlockWithPassword(PASSWORD)).toEqual({ ok: false, reason: 'lease_tampered' });
  });

  it('7. selbst erzeugte Lease mit lokalem DEK/HMAC, aber ohne gültige Serversignatur ⇒ nicht akzeptiert', async () => {
    let now = AT_ISSUE;
    const { store, ws, dek } = await setUp(() => now);
    now = new Date('2026-10-02T09:00:00.000Z'); // Lease abgelaufen
    expect(await ws.unlockWithPassword(PASSWORD)).toEqual({ ok: false, reason: 'lease_expired' });
    // Angreifer mit DEK: neue Lease bis 2030 und passender HMAC, Claim-Text angepasst,
    // Signatur (a) unverändert, (b) mit eigenem Schlüssel + eigenem Verifikationsschlüssel.
    const record = (await store.getWorkspace())!;
    const until = '2030-01-01T00:00:00.000Z';
    const forgedClaim = JSON.stringify({
      ...(JSON.parse(record.lease!.claim) as Record<string, unknown>),
      expiresAt: until,
    });
    await tamper(store, dek, { expiresAt: until, claim: forgedClaim });
    // Der HMAC stimmt (Angreifer hat den DEK) – trotzdem keine Autorisierung.
    const tampered = (await store.getWorkspace())!;
    expect(tampered.leaseMac).toBe(await computeLeaseMac(dek, IDENTITY, tampered.lease!));
    expect(await ws.unlockWithPassword(PASSWORD)).toEqual({ ok: false, reason: 'lease_tampered' });
    const selfSigned = await attacker.signedClaim({ expiresAt: until });
    await tamper(store, dek, { expiresAt: until, ...selfSigned });
    // Ohne gepinnten Schlüssel wäre ein komplett eigenes Schlüsselpaar formal „gültig“ –
    // mit gepinntem Serverschlüssel (Runtime-Option) wird es abgelehnt.
    const pinned = new OfflineWorkspace(store, IDENTITY, () => now, {
      trustedVerificationKey: signer.verificationKey,
    });
    expect(await pinned.unlockWithPassword(PASSWORD)).toEqual({
      ok: false,
      reason: 'lease_tampered',
    });
    expect(await pinned.leaseState()).toEqual({ kind: 'tampered', reason: 'untrusted_key' });
    expect(ws.unlocked).toBe(false);
    expect(pinned.unlocked).toBe(false);
  });

  it('9. abgelaufene Lease ⇒ lease_expired (Signatur gültig, Uhr monoton vom Aufrufer)', async () => {
    let now = AT_ISSUE;
    const { ws } = await setUp(() => now);
    now = new Date('2026-10-01T08:00:00.001Z'); // 72 h + 1 ms nach Ausstellung
    expect(await ws.unlockWithPassword(PASSWORD)).toEqual({ ok: false, reason: 'lease_expired' });
    const state = await ws.leaseState();
    expect(state.kind).toBe('expired');
    expect(state.kind === 'expired' && state.expiresAt).toBe(DEFAULT_EXPIRES_AT);
    // Online-Neuautorisierung mit frischer Server-Lease öffnet wieder.
    const issuedAt = now.toISOString();
    await ws.authorizeOnline(
      await signer.grant({
        leaseId: 'lease-2',
        issuedAt,
        expiresAt: new Date(now.getTime() + 72 * 3_600_000).toISOString(),
      }),
      PASSWORD,
    );
    expect((await ws.leaseState()).kind).toBe('valid');
  });

  it('bereits abgelaufener Grant wird nicht übernommen (LeaseInvalidError expired)', async () => {
    const store = await fresh();
    const ws = new OfflineWorkspace(store, IDENTITY, () => new Date('2026-10-05T00:00:00.000Z'));
    await expect(ws.authorizeOnline(await signer.grant(), PASSWORD)).rejects.toMatchObject({
      name: 'LeaseInvalidError',
      reason: 'expired',
    });
  });

  it('Ed25519 nicht verfügbar (alte Engine) ⇒ Lease ungültig, nie durchgewinkt', async () => {
    const { ws } = await setUp();
    const subtle = crypto.subtle;
    const originalImport = subtle.importKey.bind(subtle);
    (subtle as { importKey: unknown }).importKey = (...args: unknown[]) => {
      const algorithm = args[2] as { name?: string } | string;
      if (typeof algorithm === 'object' && algorithm.name === 'Ed25519') {
        return Promise.reject(new Error('NotSupportedError'));
      }
      return (originalImport as (...a: unknown[]) => Promise<CryptoKey>)(...args);
    };
    try {
      expect(await ws.unlockWithPassword(PASSWORD)).toEqual({
        ok: false,
        reason: 'lease_tampered',
      });
      expect(await ws.leaseState()).toEqual({ kind: 'tampered', reason: 'unsupported' });
    } finally {
      (subtle as { importKey: unknown }).importKey = originalImport;
    }
  });
});
