import { describe, expect, it } from 'vitest';
import {
  PBKDF2_ITERATIONS,
  decryptJson,
  deriveHmacKey,
  deriveKekFromPassword,
  encryptJson,
  exportRawKey,
  fromBase64Url,
  generateDek,
  hmacHex,
  hmacVerify,
  importLeaseSecret,
  randomBytes,
  sha256Hex,
  toBase64Url,
  unwrapDek,
  wrapDek,
} from '../src/crypto.ts';

/** Testlauf mit wenigen Iterationen – die Produktionszahl wird separat gepinnt. */
const TEST_ITERATIONS = 1_000;

describe('Kryptografie des Offline-Arbeitsbereichs (§§6–8, 12)', () => {
  it('wickelt den DEK ein und aus; ein fremder Wrap-Schlüssel liefert null statt Daten', async () => {
    const dek = await generateDek();
    const salt = randomBytes(16);
    const kek = await deriveKekFromPassword('geheimes-passwort-1', salt, TEST_ITERATIONS);
    const wrapped = await wrapDek(dek, kek, 'wrap:test');
    expect(wrapped.v).toBe(1);
    const restored = await unwrapDek(wrapped, kek, 'wrap:test');
    expect(restored).not.toBeNull();
    expect(await exportRawKey(restored as CryptoKey)).toEqual(await exportRawKey(dek));
    const wrong = await deriveKekFromPassword('falsch-falsch-1', salt, TEST_ITERATIONS);
    expect(await unwrapDek(wrapped, wrong, 'wrap:test')).toBeNull();
    const leaseKey = await importLeaseSecret(toBase64Url(randomBytes(32)));
    expect(await unwrapDek(wrapped, leaseKey, 'wrap:test')).toBeNull();
  });

  it('bindet Chiffrate an ihre AAD – vertauschte Datensätze entschlüsseln nicht', async () => {
    const dek = await generateDek();
    const blob = await encryptJson(dek, { name: 'Kunde' }, 'booking:a');
    expect(await decryptJson(dek, blob, 'booking:b')).toBeNull();
    expect(await decryptJson(dek, blob, 'booking:a')).toEqual({ name: 'Kunde' });
    const kek = await deriveKekFromPassword('pw', randomBytes(16), TEST_ITERATIONS);
    const wrapped = await wrapDek(dek, kek, 'wrap:user-1');
    expect(await unwrapDek(wrapped, kek, 'wrap:user-2')).toBeNull();
    // Manipuliertes Chiffrat scheitert am GCM-Tag.
    const tampered = { ...blob, ct: blob.ct.slice(0, -2) + (blob.ct.endsWith('AA') ? 'BB' : 'AA') };
    expect(await decryptJson(dek, tampered, 'booking:a')).toBeNull();
  });

  it('PBKDF2 ist deterministisch für Passwort × Salt × Iterationen und nutzt 600 000 Iterationen', async () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000);
    const salt = randomBytes(16);
    const dek = await generateDek();
    const first = await deriveKekFromPassword('pw-1', salt, TEST_ITERATIONS);
    const second = await deriveKekFromPassword('pw-1', salt, TEST_ITERATIONS);
    const wrapped = await wrapDek(dek, first, 'wrap');
    expect(await unwrapDek(wrapped, second, 'wrap')).not.toBeNull();
    const otherSalt = await deriveKekFromPassword('pw-1', randomBytes(16), TEST_ITERATIONS);
    expect(await unwrapDek(wrapped, otherSalt, 'wrap')).toBeNull();
    const otherIterations = await deriveKekFromPassword('pw-1', salt, TEST_ITERATIONS + 1);
    expect(await unwrapDek(wrapped, otherIterations, 'wrap')).toBeNull();
  });

  it('encryptJson/decryptJson: Roundtrip mit frischem IV je Aufruf, Base64url ohne Padding', async () => {
    const dek = await generateDek();
    const value = { text: 'Ärger & Umlaute – ok', items: [1, 2, 3], nested: { flag: true } };
    const a = await encryptJson(dek, value, 'aad');
    const b = await encryptJson(dek, value, 'aad');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(await decryptJson(dek, a, 'aad')).toEqual(value);
    expect(await decryptJson(dek, b, 'aad')).toEqual(value);
    expect(a.ct).not.toMatch(/[+/=]/);
    const bytes = randomBytes(33);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    // HMAC (HKDF aus dem DEK): verifizierbar, fremder Schlüssel/anderes Info scheitert.
    const mac = await hmacHex(await deriveHmacKey(dek, 'lease'), 'payload');
    expect(mac).toMatch(/^[0-9a-f]{64}$/);
    expect(await hmacVerify(await deriveHmacKey(dek, 'lease'), 'payload', mac)).toBe(true);
    expect(await hmacVerify(await deriveHmacKey(dek, 'other'), 'payload', mac)).toBe(false);
    expect(
      await hmacVerify(await deriveHmacKey(await generateDek(), 'lease'), 'payload', mac),
    ).toBe(false);
  });

  it('sha256Hex liefert den bekannten Hash (QR-Hash, Medien-Hash)', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await sha256Hex(new Uint8Array([0x61, 0x62, 0x63]))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
