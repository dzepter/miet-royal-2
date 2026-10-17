/**
 * Phase-8-Finalisierung (Hardening) – Serverteil:
 *
 * §1 Serversignierte Offline-Lease (Pflichttests 2–6 als Signaturnachweis,
 *    8, 10, 11): Claim-Laufzeit ist serverbestimmt (72 h), kein Client-
 *    Parameter beeinflusst sie, der DB-Check hält 73 h ab; jede Online-
 *    Autorisierung erzeugt einen neuen Claim (Nonce/Zeiten, nach Widerruf neue
 *    Lease-ID) mit gültiger Ed25519-Signatur; manipulierte Claims
 *    (expiresAt/issuedAt/userId/deviceId/environment/leaseId/nonce) und Claims
 *    fremder Umgebungen/Schlüssel verifizieren NICHT.
 *
 * §2 QR-Token nur im Body (Pflichttests 12–15) und Log-Hygiene (55–58): Der
 *    Rohtoken erscheint weder in der Request-URL noch im aufgefangenen
 *    Serverlog (Level trace, inkl. Fehlerfälle); Telefonnummern und
 *    Unterschrift-/Fotobytes (roh, hex, base64) landen nie im Log.
 *
 * Paket (Pflichttests 52/53 Serverteil): Ausgabe in +2 Tagen drin, +5 Tagen
 *    nicht, Rückgabe in +3 Tagen drin; Maschinen-Datensätze tragen keine
 *    Kundendaten, ein unsichtbarer Vorgang fehlt im Paket, obwohl seine
 *    Maschine per QR auflösbar ist.
 */
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { Writable } from 'node:stream';
import { offlineAccessLeases, processes } from '@mietroyal/database';
import { berlinDateOf, berlinDateTimeToUtc } from '@mietroyal/domain';
import { OFFLINE_LEASE_MAX_MS, parseOfflineLeaseClaim } from '@mietroyal/offline/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OfflineLeaseSigner } from '../src/offline/lease-signing.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { createStaffWithPermissions } from './crm-helpers.ts';
import { DAYS, PNG_1X1, initializeAllInventory, scheduledBooking } from './handover-helpers.ts';
import {
  DEVICE,
  DEVICE_B,
  offlineHelpers,
  truncateOfflineWorld,
  type MutationInput,
} from './offline-helpers.ts';
import { JPEG_1X1, issuedBooking } from './return-helpers.ts';
import { machineByCode } from './warehouse-helpers.ts';

let ctx: TestContext;
const h = offlineHelpers(() => ctx);

/** Aufgefangenes Serverlog (pino-Zeilen, Level trace). */
const logLines: string[] = [];
const logDestination = new Writable({
  write(chunk: Buffer | string, _encoding, callback) {
    logLines.push(chunk.toString());
    callback();
  },
});
const logText = () => logLines.join('');

beforeAll(async () => {
  ctx = await createTestContext({ logDestination, logLevel: 'trace' });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateOfflineWorld(ctx);
  logLines.length = 0;
});

// ── Krypto-Hilfen (nur node:crypto) ─────────────────────────────────────────

/** SPKI-DER-Präfix eines Ed25519-Public-Keys (RFC 8410), gefolgt von 32 rohen Bytes. */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifies(claim: string, signature: string, verificationKey: string): boolean {
  const raw = Buffer.from(verificationKey, 'base64url');
  expect(raw.length).toBe(32);
  const publicKey = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
  return verify(null, Buffer.from(claim, 'utf8'), publicKey, Buffer.from(signature, 'base64url'));
}

interface Grant {
  leaseId: string;
  userId: string;
  environment: string;
  deviceId: string;
  issuedAt: string;
  expiresAt: string;
  claim: string;
  signature: string;
  verificationKey: string;
  leaseSecret: string;
}

async function grantFor(cookie: string, deviceId = DEVICE): Promise<Grant> {
  const response = await h.lease(cookie, deviceId);
  expect(response.statusCode).toBe(200);
  return response.json() as Grant;
}

const berlinNoon = (offsetDays: number) =>
  berlinDateTimeToUtc(berlinDateOf(new Date(Date.now() + offsetDays * DAYS)), 12);

// ── Medien mit eindeutigem Byte-Marker (Log-Hygiene) ────────────────────────

/** PNG 1×1 mit zusätzlichem tEXt-Chunk (vor IEND) – bleibt strukturell gültig. */
function pngWithText(marker: string): Uint8Array {
  const iend = PNG_1X1.subarray(PNG_1X1.length - 12);
  const body = PNG_1X1.subarray(0, PNG_1X1.length - 12);
  const data = Buffer.from(marker, 'latin1');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write('tEXt', 4, 'latin1');
  data.copy(chunk, 8);
  return new Uint8Array(Buffer.concat([body, chunk, iend]));
}

/** JPEG 1×1 mit COM-Segment direkt nach SOI – bleibt strukturell gültig. */
function jpegWithComment(marker: string): Uint8Array {
  const data = Buffer.from(marker, 'latin1');
  const segment = Buffer.alloc(4 + data.length);
  segment[0] = 0xff;
  segment[1] = 0xfe;
  segment.writeUInt16BE(2 + data.length, 2);
  data.copy(segment, 4);
  return new Uint8Array(Buffer.concat([JPEG_1X1.subarray(0, 2), segment, JPEG_1X1.subarray(2)]));
}

/** Alle Darstellungen, in denen der Marker im Log auftauchen könnte: roh, hex, base64-Fenster. */
function representationsOf(bytes: Uint8Array, marker: string): string[] {
  const buf = Buffer.from(bytes);
  const offset = buf.indexOf(marker, 0, 'latin1');
  expect(offset).toBeGreaterThan(0);
  const full = buf.toString('base64');
  const start = Math.floor(offset / 3) * 4;
  const end = Math.ceil((offset + marker.length) / 3) * 4;
  return [marker, Buffer.from(marker, 'latin1').toString('hex'), full, full.slice(start, end)];
}

describe('§1 Serversignierte Offline-Lease (Pflichttests 2–6, 8, 10, 11)', () => {
  it('8. Laufzeit ist serverbestimmt: Claim exakt 72 h, kein Client-Parameter, DB-Check hält 73 h ab', async () => {
    const { admin } = await h.adminSession();
    const staff = await h.staffWith(admin.id, h.OPERATIVE, 'Claim');
    const grant = await grantFor(staff.cookie);

    // Claim-Text: exakte Feldreihenfolge, Werte identisch mit dem Grant und der DB-Zeile.
    const parsed = parseOfflineLeaseClaim(grant.claim);
    expect(parsed).not.toBeNull();
    expect(Object.keys(JSON.parse(grant.claim) as object)).toEqual([
      'v',
      'leaseId',
      'userId',
      'deviceId',
      'environment',
      'issuedAt',
      'expiresAt',
      'nonce',
    ]);
    expect(parsed).toMatchObject({
      v: 1,
      leaseId: grant.leaseId,
      userId: staff.user.id,
      deviceId: DEVICE,
      environment: 'development',
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
    });
    expect(Buffer.from(parsed!.nonce, 'base64url').length).toBe(16);
    expect(Date.parse(parsed!.expiresAt) - Date.parse(parsed!.issuedAt)).toBe(72 * 3_600_000);
    expect(OFFLINE_LEASE_MAX_MS).toBe(72 * 3_600_000);
    expect(verifies(grant.claim, grant.signature, grant.verificationKey)).toBe(true);
    const row = (await ctx.db.select().from(offlineAccessLeases))[0]!;
    expect(row.issuedAt.toISOString()).toBe(parsed!.issuedAt);
    expect(row.expiresAt.toISOString()).toBe(parsed!.expiresAt);
    // Der Claim enthält weder Secret noch Rechte – nur Identität und Laufzeit.
    expect(grant.claim).not.toContain(grant.leaseSecret);
    expect(grant.claim).not.toContain('permissions');

    // Kein Client-Parameter beeinflusst die Laufzeit: unbekannte Felder werden abgelehnt (strict),
    // die bestehende Lease bleibt bei 72 h.
    for (const extra of [
      { expiresAt: new Date(Date.now() + 30 * DAYS).toISOString() },
      { ttlHours: 500 },
      { hours: 200 },
    ]) {
      const attempt = await ctx.app.inject({
        method: 'POST',
        url: '/staff/offline/lease',
        headers: { cookie: staff.cookie },
        payload: { deviceId: DEVICE, environment: 'development', ...extra },
      });
      expect(attempt.statusCode, JSON.stringify(extra)).toBe(400);
    }
    const rows = await ctx.db.select().from(offlineAccessLeases);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expiresAt.getTime() - rows[0]!.issuedAt.getTime()).toBe(72 * 3_600_000);

    // Direkter DB-Insert mit 73 h scheitert am Check-Constraint (Server-Autorität auch gegen Code-Fehler).
    const issuedAt = new Date();
    let constraint: string | null = null;
    try {
      await ctx.db.insert(offlineAccessLeases).values({
        staffUserId: staff.user.id,
        deviceId: DEVICE_B,
        appEnv: 'development',
        leaseSecretEncrypted: 'x',
        issuedAt,
        expiresAt: new Date(issuedAt.getTime() + 73 * 3_600_000),
      });
    } catch (error) {
      const cause = (error as { cause?: { constraint?: string } }).cause;
      constraint =
        cause?.constraint ?? (error as { constraint?: string }).constraint ?? 'unbekannt';
    }
    expect(constraint).toBe('offline_access_leases_max_check');
    expect(await ctx.db.select().from(offlineAccessLeases)).toHaveLength(1);

    // Der Secret-Endpunkt bleibt unverändert (kein Claim, nur Secret + Ablauf).
    const secret = await ctx.app.inject({
      method: 'GET',
      url: `/staff/offline/lease/secret?deviceId=${DEVICE}&environment=development`,
      headers: { cookie: staff.cookie },
    });
    expect(secret.statusCode).toBe(200);
    expect(Object.keys(secret.json() as object).sort()).toEqual([
      'expiresAt',
      'leaseId',
      'leaseSecret',
    ]);
  });

  it('10. Jede Online-Autorisierung erzeugt einen neuen, gültig signierten Claim (Nonce, Zeiten, nach Widerruf neue Lease-ID)', async () => {
    const { admin } = await h.adminSession();
    const staff = await h.staffWith(admin.id, h.OPERATIVE, 'Renew');
    const first = await grantFor(staff.cookie);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const renewed = await grantFor(staff.cookie);
    const a = parseOfflineLeaseClaim(first.claim)!;
    const b = parseOfflineLeaseClaim(renewed.claim)!;
    // Verlängerung: gleiche Lease-ID, aber neuer Claim (Nonce, issuedAt/expiresAt, Signatur, Secret).
    expect(renewed.leaseId).toBe(first.leaseId);
    expect(b.leaseId).toBe(a.leaseId);
    expect(b.nonce).not.toBe(a.nonce);
    expect(Date.parse(b.issuedAt)).toBeGreaterThan(Date.parse(a.issuedAt));
    expect(Date.parse(b.expiresAt) - Date.parse(b.issuedAt)).toBe(72 * 3_600_000);
    expect(renewed.signature).not.toBe(first.signature);
    expect(renewed.claim).not.toBe(first.claim);
    expect(renewed.leaseSecret).not.toBe(first.leaseSecret);
    expect(renewed.verificationKey).toBe(first.verificationKey); // ein Serverschlüssel je Umgebung
    expect(verifies(first.claim, first.signature, first.verificationKey)).toBe(true);
    expect(verifies(renewed.claim, renewed.signature, renewed.verificationKey)).toBe(true);
    // Signaturen sind nicht austauschbar.
    expect(verifies(renewed.claim, first.signature, first.verificationKey)).toBe(false);

    // Widerruf (Logout) + neue Online-Autorisierung ⇒ neue Lease-ID, neuer Claim.
    const revoke = await ctx.app.inject({
      method: 'POST',
      url: '/staff/offline/lease/revoke',
      headers: { cookie: staff.cookie },
      payload: { deviceId: DEVICE, environment: 'development' },
    });
    expect((revoke.json() as { revoked: boolean }).revoked).toBe(true);
    const fresh = await grantFor(staff.cookie);
    const c = parseOfflineLeaseClaim(fresh.claim)!;
    expect(fresh.leaseId).not.toBe(first.leaseId);
    expect(c.leaseId).toBe(fresh.leaseId);
    expect(c.nonce).not.toBe(a.nonce);
    expect(c.nonce).not.toBe(b.nonce);
    expect(verifies(fresh.claim, fresh.signature, fresh.verificationKey)).toBe(true);
    // Zweites Gerät desselben Benutzers: eigener Claim mit eigener Lease-ID und deviceId.
    const other = await grantFor(staff.cookie, DEVICE_B);
    const d = parseOfflineLeaseClaim(other.claim)!;
    expect(d.deviceId).toBe(DEVICE_B);
    expect(d.leaseId).not.toBe(fresh.leaseId);
    expect(verifies(other.claim, other.signature, other.verificationKey)).toBe(true);
    expect(await ctx.db.select().from(offlineAccessLeases)).toHaveLength(3);
  });

  it('11 + 2–6. Fremde Umgebung/fremder Schlüssel und jede Claim-Manipulation verifizieren NICHT', async () => {
    const { admin } = await h.adminSession();
    const staff = await h.staffWith(admin.id, h.OPERATIVE, 'Tamper');
    // Serverseite (11): Lease für eine andere Umgebung wird nie ausgestellt.
    const foreign = await h.lease(staff.cookie, DEVICE, 'production');
    expect(foreign.statusCode).toBe(409);
    expect((foreign.json() as { error: { code: string } }).error.code).toBe('ENVIRONMENT_MISMATCH');
    const grant = await grantFor(staff.cookie);
    const claim = parseOfflineLeaseClaim(grant.claim)!;
    expect(claim.environment).toBe('development');
    expect(verifies(grant.claim, grant.signature, grant.verificationKey)).toBe(true);
    // Gleiche Bytes, re-serialisiert in Vertragsreihenfolge ⇒ weiterhin gültig (Kontrolle).
    expect(verifies(JSON.stringify(claim), grant.signature, grant.verificationKey)).toBe(true);

    // Pflichttests 2–6 als Signaturnachweis: jede Feldänderung bricht die Signatur.
    const tampered: Record<string, unknown>[] = [
      { expiresAt: new Date(Date.parse(claim.expiresAt) + 3_600_000).toISOString() }, // +1 h
      { expiresAt: new Date(Date.parse(claim.expiresAt) + 1).toISOString() }, // +1 ms
      { issuedAt: new Date(Date.parse(claim.issuedAt) - 3_600_000).toISOString() },
      { userId: admin.id },
      { deviceId: DEVICE_B },
      { environment: 'production' },
      { environment: 'demo' },
      { leaseId: randomUUID() },
      { nonce: Buffer.alloc(16, 7).toString('base64url') },
      { v: 2 },
    ];
    for (const change of tampered) {
      const text = JSON.stringify({ ...claim, ...change });
      expect(text).not.toBe(grant.claim);
      expect(verifies(text, grant.signature, grant.verificationKey), JSON.stringify(change)).toBe(
        false,
      );
    }
    // Auch Whitespace-/Reihenfolgeänderungen am Text sind keine gültige Signatur mehr.
    expect(verifies(`${grant.claim} `, grant.signature, grant.verificationKey)).toBe(false);
    const { nonce, ...withoutNonce } = claim;
    const reordered = JSON.stringify({ nonce, ...withoutNonce });
    expect(verifies(reordered, grant.signature, grant.verificationKey)).toBe(false);
    // Strukturprüfung des Clients lehnt eine > 72-h-Laufzeit unabhängig von der Signatur ab.
    expect(
      parseOfflineLeaseClaim(
        JSON.stringify({
          ...claim,
          expiresAt: new Date(Date.parse(claim.issuedAt) + 73 * 3_600_000).toISOString(),
        }),
      ),
    ).toBeNull();

    // Fremder Schlüssel (andere Umgebung = anderer AUTH_SECRET_KEY): eigener Claim einer anderen
    // Umgebung verifiziert nicht gegen den Serverschlüssel – und umgekehrt.
    const foreignSigner = new OfflineLeaseSigner('demo-umgebung-anderer-auth-secret-key-0000');
    expect(foreignSigner.verificationKey).not.toBe(grant.verificationKey);
    const foreignClaim = foreignSigner.sign({
      leaseId: claim.leaseId,
      userId: claim.userId,
      deviceId: claim.deviceId,
      environment: 'demo',
      issuedAt: new Date(claim.issuedAt),
      expiresAt: new Date(claim.expiresAt),
    });
    expect(verifies(foreignClaim.claim, foreignClaim.signature, foreignClaim.verificationKey)).toBe(
      true,
    );
    expect(verifies(foreignClaim.claim, foreignClaim.signature, grant.verificationKey)).toBe(false);
    expect(verifies(grant.claim, grant.signature, foreignClaim.verificationKey)).toBe(false);
    // Ein fremder Signierer mit identischen Claim-Werten (gleiche Umgebung) kann die
    // Serversignatur ebenfalls nicht nachbilden.
    const sameValues = foreignSigner.sign({
      leaseId: claim.leaseId,
      userId: claim.userId,
      deviceId: claim.deviceId,
      environment: 'development',
      issuedAt: new Date(claim.issuedAt),
      expiresAt: new Date(claim.expiresAt),
    });
    expect(verifies(sameValues.claim, sameValues.signature, grant.verificationKey)).toBe(false);
    // Der Serverschlüssel ist deterministisch aus dem Server-Secret abgeleitet (Neustart-stabil).
    expect(new OfflineLeaseSigner(ctx.config.auth.secretKey).verificationKey).toBe(
      grant.verificationKey,
    );
  });
});

describe('§2 QR-Token nur im Body, Log-Hygiene (Pflichttests 12–15, 55–58)', () => {
  it('12/13. Rohtoken erscheint weder in der URL noch im Serverlog (trace), auch nicht bei Fehlern', async () => {
    const { cookie } = await h.adminSession();
    const machine = await machineByCode(ctx.db, 'MR-10-01-03');
    const unknown = 'deadbeef'.repeat(6);

    // Alte GET-Routen existieren nicht mehr (kein Token im Pfad).
    for (const url of [
      `/staff/machines/qr/${machine.qrToken}`,
      `/staff/returns/resolve-qr/${machine.qrToken}`,
    ]) {
      const gone = await ctx.app.inject({ method: 'GET', url, headers: { cookie } });
      expect(gone.statusCode, url).toBe(404);
      expect(gone.body).not.toContain(machine.id);
    }
    const resolved = await ctx.app.inject({
      method: 'POST',
      url: '/staff/machines/qr/resolve',
      headers: { cookie },
      payload: { token: machine.qrToken },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toEqual({ machineId: machine.id, machineCode: 'MR-10-01-03' });
    // Fehlerfälle: unbekannt (404), kaputter Body (400), fremdes Feld (400), Rückgabe-Resolve 404.
    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/staff/machines/qr/resolve',
      headers: { cookie },
      payload: { token: unknown },
    });
    expect(missing.statusCode).toBe(404);
    const broken = await ctx.app.inject({
      method: 'POST',
      url: '/staff/machines/qr/resolve',
      headers: { cookie, 'content-type': 'application/json' },
      payload: `{"token":"${unknown}"`,
    });
    expect(broken.statusCode).toBe(400);
    const strict = await ctx.app.inject({
      method: 'POST',
      url: '/staff/machines/qr/resolve',
      headers: { cookie },
      payload: { token: machine.qrToken, redirect: unknown },
    });
    expect(strict.statusCode).toBe(400);
    expect(strict.body).not.toContain(machine.qrToken);
    const noReturn = await ctx.app.inject({
      method: 'POST',
      url: '/staff/returns/resolve-qr',
      headers: { cookie },
      payload: { token: unknown },
    });
    expect(noReturn.statusCode).toBe(404);

    const log = logText();
    // Das Log ist aktiv und enthält die Requests – aber keinen Token.
    expect(log).toContain('/staff/machines/qr/resolve');
    expect(log).toContain('/staff/returns/resolve-qr');
    expect(log).toContain('incoming request');
    expect(log).not.toContain(machine.qrToken);
    expect(log).not.toContain(unknown);
    expect(log).not.toContain('deadbeefdeadbeef');
    // Neue Route lesbar, Altpfade (Token im Pfad) weiterhin maskiert.
    for (const match of log.matchAll(/\/staff\/machines\/qr\/([^"\s]+)/g)) {
      expect(['resolve', '***']).toContain(match[1]);
    }
    expect(log).toContain('"url":"/staff/machines/qr/***"');
    for (const match of log.matchAll(/\/staff\/returns\/resolve-qr([^"\s]*)/g)) {
      expect(['', '/***']).toContain(match[1]);
    }
    // Der Request-Serializer gibt nie Bodies/Query aus.
    expect(log).not.toContain('"body"');
    expect(log).not.toContain('"token"');
  });

  it('14. Ungültige Tokens werden neutral mit 404 beantwortet – identisch für unbekannt und falsches Format', async () => {
    const { admin, cookie } = await h.adminSession();
    await issuedBooking(ctx, admin.id, { machineCodes: ['MR-10-01-01'] });
    const bodies = new Set<string>();
    for (const token of ['0'.repeat(48), 'nicht-hex-token-123', 'a'.repeat(9), 'f'.repeat(128)]) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/staff/machines/qr/resolve',
        headers: { cookie },
        payload: { token },
      });
      expect(response.statusCode, token).toBe(404);
      const body = response.json() as { error: { code: string; message: string } };
      expect(body.error.message).toBe('Dieser QR-Code ist nicht gültig.');
      bodies.add(JSON.stringify({ code: body.error.code, message: body.error.message }));
    }
    expect(bodies.size).toBe(1);
    // Rückgabe: unbekannter Token und nicht ausgegebene Maschine ⇒ derselbe neutrale Fehler.
    const notIssued = await machineByCode(ctx.db, 'MR-10-01-02');
    const neutral = 'Für diesen QR-Code ist kein ausgegebener Vorgang offen.';
    for (const token of ['deadbeef'.repeat(4), notIssued.qrToken]) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/staff/returns/resolve-qr',
        headers: { cookie },
        payload: { token },
      });
      expect(response.statusCode).toBe(404);
      expect((response.json() as { error: { message: string } }).error.message).toBe(neutral);
      expect(response.body).not.toContain(notIssued.id);
    }
    // Zu kurzer Token scheitert am Schema (400), nicht an der Datenbank.
    const tooShort = await ctx.app.inject({
      method: 'POST',
      url: '/staff/machines/qr/resolve',
      headers: { cookie },
      payload: { token: 'abc' },
    });
    expect(tooShort.statusCode).toBe(400);
  });

  it('15. Ohne machine.view 403; Rückgabe-Resolve ohne return.view/Sichtbarkeit abgelehnt', async () => {
    const { admin } = await h.adminSession();
    const world = await issuedBooking(ctx, admin.id, { machineCodes: ['MR-10-01-01'] });
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    const resolveMachine = (cookie?: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/staff/machines/qr/resolve',
        ...(cookie === undefined ? {} : { headers: { cookie } }),
        payload: { token: machine.qrToken },
      });
    const resolveReturn = (cookie?: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/staff/returns/resolve-qr',
        ...(cookie === undefined ? {} : { headers: { cookie } }),
        payload: { token: machine.qrToken },
      });
    expect((await resolveMachine()).statusCode).toBe(401);
    expect((await resolveReturn()).statusCode).toBe(401);

    const outsider = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Ohne',
      lastName: 'Recht',
      email: 'ohne.recht@test.example',
      password: 'ohne-recht-passwort-1',
      permissionKeys: ['customer.view', 'process.view_all', 'return.view'],
    });
    const forbidden = await resolveMachine(outsider.cookie);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.body).not.toContain(machine.id);
    expect(forbidden.body).not.toContain('MR-10-01-01');

    // Rückgabe: ohne return.view 403; ohne Vorgangsrecht/Sichtbarkeit 403; mit beidem 200.
    const noReturnRight = await h.staffWith(admin.id, ['machine.view', 'process.view_all'], 'Qr');
    expect((await resolveReturn(noReturnRight.cookie)).statusCode).toBe(403);
    const blind = await h.staffWith(admin.id, ['return.view', 'machine.view'], 'Blind');
    const invisible = await resolveReturn(blind.cookie);
    expect(invisible.statusCode).toBe(403);
    expect(invisible.body).not.toContain(world.bookingId);
    const allowed = await h.staffWith(admin.id, ['return.view', 'process.view_all'], 'Ok');
    const ok = await resolveReturn(allowed.cookie);
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { bookingId: string }).bookingId).toBe(world.bookingId);
    // Kein Token im Log – auch nicht aus den abgelehnten Anfragen.
    expect(logText()).not.toContain(machine.qrToken);
  });

  it('55–58. Sync von Empfänger (Telefon), Unterschrift (PNG) und Foto (JPEG) plus QR-Resolve: nichts davon im Serverlog', async () => {
    const { admin } = await h.adminSession();
    await initializeAllInventory(ctx, admin.id, 20);
    const world = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 3_600_000),
      to: new Date(Date.now() + 2 * DAYS),
    });
    const staff = await h.staffWith(admin.id, h.OPERATIVE, 'Loghygiene');
    const before = await h.packageFor(staff.cookie);
    const snapshot = before.bookings.find((b) => b.bookingId === world.bookingId)!;
    const slotId = (snapshot.handover!.slots as { id: string }[])[0]!.id;
    const candidate = snapshot.candidateMachines[slotId]!.find(
      (c) => !c.overrideRequired && !c.hardBlocked,
    )!;
    const outbound = snapshot.appointments.find((a) => a.kind !== 'return')!;
    const base = {
      processStatus: 'open',
      appointmentId: outbound.id,
      appointmentVersion: outbound.version,
    };
    const PHONE = '0160 44332211';
    const SIGNATURE_MARKER = 'MRSIGMARK-7f3a9c2e-UNTERSCHRIFT';
    const PHOTO_MARKER = 'MRFOTOMARK-5b1d8e4a-GESAMTFOTO';
    const png = pngWithText(SIGNATURE_MARKER);
    const jpeg = jpegWithComment(PHOTO_MARKER);
    logLines.length = 0;

    const steps: MutationInput[] = [
      {
        type: 'handover.assign',
        contextId: world.bookingId,
        base: { ...base, expectedMachineId: null },
        payload: {
          assignmentId: slotId,
          machineId: candidate.machineId,
          override: null,
          situationFingerprint: candidate.situationFingerprint,
        },
      },
      {
        type: 'handover.prepare',
        contextId: world.bookingId,
        base: { ...base, expectedMachineId: candidate.machineId },
        payload: { assignmentId: slotId },
      },
      {
        type: 'handover.recipient',
        contextId: world.bookingId,
        base,
        payload: { kind: 'other', name: 'Rita Vertreterin', phone: PHONE },
      },
      {
        type: 'handover.check_machine',
        contextId: world.bookingId,
        base,
        payload: { assignmentId: slotId, machineId: candidate.machineId },
      },
    ];
    for (const step of steps) {
      const outcome = await h.sync(staff.cookie, step);
      expect(outcome.json.status, step.type).toBe('applied');
    }
    const photoId = randomUUID();
    const photo = await h.sync(staff.cookie, {
      type: 'handover.photo',
      contextId: world.bookingId,
      base,
      payload: { assignmentId: slotId, machineId: candidate.machineId, mediaId: photoId },
      media: [{ mediaId: photoId, purpose: 'handover_photo', mimeType: 'image/jpeg', bytes: jpeg }],
    });
    expect(photo.json.status).toBe('applied');
    const signatureId = randomUUID();
    const signature = await h.sync(staff.cookie, {
      type: 'handover.signature',
      contextId: world.bookingId,
      base,
      payload: { role: 'customer', mediaId: signatureId },
      media: [
        { mediaId: signatureId, purpose: 'handover_signature', mimeType: 'image/png', bytes: png },
      ],
    });
    expect(signature.json.status).toBe('applied');
    // Abgelehnte Mutation (falscher Hash) – auch Fehlerpfade loggen keine Nutzdaten.
    const rejected = await h.sync(staff.cookie, {
      type: 'handover.photo',
      contextId: world.bookingId,
      base,
      payload: { assignmentId: slotId, machineId: candidate.machineId, mediaId: randomUUID() },
      media: [
        {
          mediaId: randomUUID(),
          purpose: 'handover_photo',
          mimeType: 'image/jpeg',
          bytes: jpeg,
          sha256: '0'.repeat(64),
        },
      ],
    });
    expect(rejected.response.statusCode).toBeLessThan(500);
    expect(rejected.json.status).not.toBe('applied');
    const candidateMachine = before.machines.find((m) => m.machineId === candidate.machineId)!;
    const row = await machineByCode(ctx.db, candidateMachine.machineCode);
    const resolved = await ctx.app.inject({
      method: 'POST',
      url: '/staff/machines/qr/resolve',
      headers: { cookie: staff.cookie },
      payload: { token: row.qrToken },
    });
    expect(resolved.statusCode).toBe(200);

    const log = logText();
    expect(log).toContain('/staff/offline/sync');
    expect(log).toContain('/staff/machines/qr/resolve');
    expect(log).not.toContain(PHONE);
    expect(log).not.toContain(PHONE.replaceAll(' ', ''));
    expect(log).not.toContain('Rita');
    for (const representation of [
      ...representationsOf(png, SIGNATURE_MARKER),
      ...representationsOf(jpeg, PHOTO_MARKER),
    ]) {
      expect(log).not.toContain(representation);
    }
    expect(log).not.toContain(row.qrToken);
    expect(log).not.toContain('dataBase64');
  });
});

describe('Paket: Horizont und Datenminimierung (Pflichttests 52/53 Serverteil)', () => {
  it('52. Ausgabe in +2 Tagen enthalten, +5 Tagen nicht, Rückgabe in +3 Tagen enthalten', async () => {
    const { admin } = await h.adminSession();
    await initializeAllInventory(ctx, admin.id, 20);
    const inTwoDays = await scheduledBooking(ctx, admin.id, {
      from: berlinNoon(2),
      to: berlinNoon(6),
    });
    const inFiveDays = await scheduledBooking(ctx, admin.id, {
      from: berlinNoon(5),
      to: berlinNoon(8),
    });
    const returnInThreeDays = await issuedBooking(ctx, admin.id, {
      machineCodes: ['MR-10-01-02'],
      to: berlinNoon(3),
      skipInventoryInit: true,
    });
    const staff = await h.staffWith(admin.id, h.OPERATIVE, 'Horizont');
    const result = await h.packageFor(staff.cookie);
    const ids = result.bookings.map((b) => b.bookingId);
    expect(ids).toContain(inTwoDays.bookingId);
    expect(ids).not.toContain(inFiveDays.bookingId);
    expect(ids).toContain(returnInThreeDays.bookingId);
    const twoDays = result.bookings.find((b) => b.bookingId === inTwoDays.bookingId)!;
    expect(twoDays.relevance).toContain('handover');
    const threeDays = result.bookings.find((b) => b.bookingId === returnInThreeDays.bookingId)!;
    expect(threeDays.relevance).toContain('return');
    expect(threeDays.relevance).not.toContain('overdue');
    expect(threeDays.returnStartable).toBe(true);
    expect(result.horizonTo).toBe(berlinDateOf(berlinNoon(3)));
  });

  it('53. Maschinen-Datensätze tragen keine Kundendaten; unsichtbarer Vorgang fehlt, obwohl seine Maschine per QR auflösbar ist', async () => {
    const { admin } = await h.adminSession();
    const hidden = await issuedBooking(ctx, admin.id, { machineCodes: ['MR-10-01-01'] });
    // Vorgang vor 30 Tagen abgeschlossen ⇒ ohne process.view_completed unsichtbar (Phase-2-Regel).
    await ctx.db
      .update(processes)
      .set({ mainStatus: 'completed', completedAt: new Date(Date.now() - 30 * DAYS) })
      .where(eq(processes.id, hidden.processId));
    const staff = await h.staffWith(admin.id, h.OPERATIVE, 'Sichtbarkeit');
    const result = await h.packageFor(staff.cookie);
    expect(result.bookings.map((b) => b.bookingId)).not.toContain(hidden.bookingId);
    const row = await machineByCode(ctx.db, 'MR-10-01-01');
    const machine = result.machines.find((m) => m.machineId === row.id)!;
    expect(machine.qrHash).toBe(
      createHash('sha256').update(row.qrToken.toLowerCase()).digest('hex'),
    );
    expect(machine.status).toBe('rented');
    // Maschinen-Datensatz: nur technische Felder, keine Vorgangs-/Kundendaten.
    for (const entry of result.machines) {
      expect(Object.keys(entry).sort()).toEqual([
        'cleaningSince',
        'currentDamages',
        'machineCode',
        'machineId',
        'machineTypeName',
        'productSlug',
        'qrHash',
        'status',
        'updatedAt',
      ]);
    }
    const machinesJson = JSON.stringify(result.machines);
    expect(machinesJson).not.toContain('Klara');
    expect(machinesJson).not.toContain('0171 9998877');
    expect(machinesJson).not.toContain(hidden.bookingId);
    expect(machinesJson).not.toContain(hidden.processId);
    expect(JSON.stringify(result)).not.toContain(row.qrToken);
    // Online auflösbar (machine.view), aber der unsichtbare Rückgabevorgang bleibt verschlossen.
    const resolved = await ctx.app.inject({
      method: 'POST',
      url: '/staff/machines/qr/resolve',
      headers: { cookie: staff.cookie },
      payload: { token: row.qrToken },
    });
    expect(resolved.statusCode).toBe(200);
    const returnResolve = await ctx.app.inject({
      method: 'POST',
      url: '/staff/returns/resolve-qr',
      headers: { cookie: staff.cookie },
      payload: { token: row.qrToken },
    });
    // Unsichtbarer Vorgang ⇒ neutrales 404 (kein Existenz-Orakel), nie Vorgangsdaten.
    expect(returnResolve.statusCode).toBe(404);
    expect(returnResolve.body).not.toContain(hidden.bookingId);
    expect(returnResolve.body).not.toContain(hidden.processId);
    // Einzel-Snapshot des unsichtbaren Vorgangs: neutral 404.
    const single = await ctx.app.inject({
      method: 'GET',
      url: `/staff/offline/bookings/${hidden.bookingId}`,
      headers: { cookie: staff.cookie },
    });
    expect(single.statusCode).toBe(404);
  });
});
