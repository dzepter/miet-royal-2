/**
 * Kryptografie des Offline-Arbeitsbereichs (Phase-8-Order §§6–8, 12).
 *
 * Ausschließlich WebCrypto (Browser UND Node ≥ 20 – keine Node-Buffer-APIs):
 * - DEK: zufälliger AES-256-GCM-Schlüssel je Benutzer × Umgebung × Gerät.
 *   Er wird `extractable` erzeugt, damit er für die Wraps als Rohbytes
 *   exportiert und per AES-GCM eingewickelt werden kann (Wrap A = PBKDF2-KEK
 *   aus dem Passwort, Wrap B = serverseitiges Lease-Secret).
 * - Jeder Datensatz wird mit datensatzspezifischer AAD verschlüsselt; ein
 *   verschobener/vertauschter Datensatz scheitert damit am GCM-Tag.
 * - HKDF liefert aus dem DEK den HMAC-Schlüssel für den Lease-Datensatz
 *   (manipulierte Ablaufzeit ⇒ `lease_tampered`).
 * - Fehlgeschlagene Entschlüsselung (falscher Schlüssel, falsche AAD,
 *   manipuliertes Chiffrat) liefert `null` – nie eine Exception mit Fachdaten.
 */
import type { EncryptedBlob } from './records.ts';

/** PBKDF2-SHA-256-Iterationen für Wrap A (Order §7). */
export const PBKDF2_ITERATIONS = 600_000;
/** Salt-Länge für PBKDF2 in Bytes. */
export const PBKDF2_SALT_BYTES = 16;
const AES_KEY_LENGTH = 256;
const GCM_IV_BYTES = 12;
const GCM_TAG_LENGTH = 128;

function subtle(): SubtleCrypto {
  const api = globalThis.crypto?.subtle;
  if (api === undefined) throw new Error('WebCrypto (crypto.subtle) ist nicht verfügbar.');
  return api;
}

/** Kopie der Bytes in einem eigenen ArrayBuffer (BufferSource ohne SharedArrayBuffer-Typen). */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

// ── Base64url ───────────────────────────────────────────────────────────────

const BASE64_CHUNK = 0x8000;

function bytesToBinaryString(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return binary;
}

export function toBase64Url(bytes: Uint8Array): string {
  return btoa(bytesToBinaryString(bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const normalized = text.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Standard-Base64 (für Wire-Formate wie `dataBase64`). */
export function toBase64(bytes: Uint8Array): string {
  return btoa(bytesToBinaryString(bytes));
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// ── Schlüssel ───────────────────────────────────────────────────────────────

/** Neuer DEK (AES-256-GCM). `extractable`, damit er für die Wraps exportiert werden kann. */
export function generateDek(): Promise<CryptoKey> {
  return subtle().generateKey({ name: 'AES-GCM', length: AES_KEY_LENGTH }, true, [
    'encrypt',
    'decrypt',
  ]);
}

export async function exportRawKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await subtle().exportKey('raw', key));
}

export async function importAesKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  return subtle().importKey('raw', bufferOf(raw), { name: 'AES-GCM' }, extractable, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Wrap A: KEK aus dem Mitarbeiterpasswort (PBKDF2-SHA-256, 600 000 Iterationen,
 * 16-Byte-Salt). Deterministisch für gleiches Passwort/Salt/Iterationen; das
 * Passwort selbst wird nie gespeichert.
 */
export async function deriveKekFromPassword(
  password: string,
  salt: Uint8Array,
  iterations = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', bufferOf(utf8Bytes(password)), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: bufferOf(salt), iterations },
    material,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Wrap B: Lease-Secret des Servers (32 zufällige Bytes, Base64url) als AES-GCM-Schlüssel. */
export function importLeaseSecret(leaseSecretBase64Url: string): Promise<CryptoKey> {
  const raw = fromBase64Url(leaseSecretBase64Url);
  if (raw.byteLength !== AES_KEY_LENGTH / 8) {
    return Promise.reject(new Error('Lease-Secret hat nicht die erwartete Länge.'));
  }
  return importAesKey(raw, false);
}

// ── AES-GCM mit AAD ─────────────────────────────────────────────────────────

export async function encryptBytes(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad: string,
): Promise<EncryptedBlob> {
  const iv = randomBytes(GCM_IV_BYTES);
  const ciphertext = await subtle().encrypt(
    {
      name: 'AES-GCM',
      iv: bufferOf(iv),
      additionalData: bufferOf(utf8Bytes(aad)),
      tagLength: GCM_TAG_LENGTH,
    },
    key,
    bufferOf(plaintext),
  );
  return { v: 1, iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ciphertext)) };
}

/** `null` bei falschem Schlüssel, falscher AAD, manipuliertem Chiffrat oder unbekannter Version. */
export async function decryptBytes(
  key: CryptoKey,
  blob: EncryptedBlob,
  aad: string,
): Promise<Uint8Array | null> {
  if (blob.v !== 1) return null;
  try {
    const plaintext = await subtle().decrypt(
      {
        name: 'AES-GCM',
        iv: bufferOf(fromBase64Url(blob.iv)),
        additionalData: bufferOf(utf8Bytes(aad)),
        tagLength: GCM_TAG_LENGTH,
      },
      key,
      bufferOf(fromBase64Url(blob.ct)),
    );
    return new Uint8Array(plaintext);
  } catch {
    return null;
  }
}

export function encryptJson(key: CryptoKey, value: unknown, aad: string): Promise<EncryptedBlob> {
  return encryptBytes(key, utf8Bytes(JSON.stringify(value)), aad);
}

export async function decryptJson<T>(
  key: CryptoKey,
  blob: EncryptedBlob,
  aad: string,
): Promise<T | null> {
  const bytes = await decryptBytes(key, blob, aad);
  if (bytes === null) return null;
  try {
    return JSON.parse(decoder.decode(bytes)) as T;
  } catch {
    return null;
  }
}

/** DEK einwickeln: Rohbytes exportieren und mit dem Wrap-Schlüssel AES-GCM-verschlüsseln. */
export async function wrapDek(
  dek: CryptoKey,
  wrappingKey: CryptoKey,
  aad: string,
): Promise<EncryptedBlob> {
  return encryptBytes(wrappingKey, await exportRawKey(dek), aad);
}

/** DEK auswickeln – `null`, wenn der Wrap-Schlüssel oder die AAD nicht passt. */
export async function unwrapDek(
  blob: EncryptedBlob,
  wrappingKey: CryptoKey,
  aad: string,
): Promise<CryptoKey | null> {
  const raw = await decryptBytes(wrappingKey, blob, aad);
  if (raw === null || raw.byteLength !== AES_KEY_LENGTH / 8) return null;
  return importAesKey(raw, true);
}

// ── HMAC (HKDF aus dem DEK) ─────────────────────────────────────────────────

/** HMAC-SHA-256-Schlüssel per HKDF aus dem DEK; `info` trennt die Verwendungszwecke. */
export async function deriveHmacKey(dek: CryptoKey, info: string): Promise<CryptoKey> {
  const raw = await exportRawKey(dek);
  const material = await subtle().importKey('raw', bufferOf(raw), 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: bufferOf(utf8Bytes(info)) },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

export async function hmacHex(key: CryptoKey, data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? utf8Bytes(data) : data;
  const signature = await subtle().sign('HMAC', key, bufferOf(bytes));
  return toHex(new Uint8Array(signature));
}

export async function hmacVerify(
  key: CryptoKey,
  data: Uint8Array | string,
  expectedHex: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(expectedHex)) return false;
  const bytes = typeof data === 'string' ? utf8Bytes(data) : data;
  return subtle().verify('HMAC', key, bufferOf(fromHex(expectedHex)), bufferOf(bytes));
}

// ── Hashes ──────────────────────────────────────────────────────────────────

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? utf8Bytes(data) : data;
  return toHex(new Uint8Array(await subtle().digest('SHA-256', bufferOf(bytes))));
}

export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
