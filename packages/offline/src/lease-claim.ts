/**
 * Client-Verifikation des serverseitig signierten Lease-Claims
 * (Phase-8-Finalisierung §1).
 *
 * Der Server signiert den JSON-Text eines `OfflineLeaseClaim` mit Ed25519;
 * der Client prüft Signatur, Struktur (inkl. Laufzeit ≤ 72 h) und die Bindung
 * an die eigene Identität (userId × deviceId × environment) vollständig
 * offline mit WebCrypto. Nur ein so verifizierter Claim darf Ablauf und
 * Identität der lokalen Lease bestimmen – nie lokal veränderbare Felder.
 *
 * Fehlt Ed25519 in der WebCrypto-Implementierung (alte Engine), gilt die
 * Lease als ungültig (`unsupported`) – es wird nie „durchgewinkt“.
 */
import { fromBase64Url, utf8Bytes } from './crypto.ts';
import {
  parseOfflineLeaseClaim,
  type LeaseGrant,
  type OfflineLeaseClaim,
} from './package-types.ts';

const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/** Signierte Teile einer Lease (Grant vom Server oder lokaler Datensatz). */
export type SignedLeaseClaim = Pick<LeaseGrant, 'claim' | 'signature' | 'verificationKey'>;

export interface LeaseClaimIdentity {
  userId: string;
  deviceId: string;
  environment: string;
}

export type LeaseClaimFailure =
  /** WebCrypto kennt Ed25519 nicht – keine Prüfung möglich, Lease ungültig. */
  | 'unsupported'
  /** Signatur, Schlüssel oder Signaturformat passen nicht zum Claim-Text. */
  | 'bad_signature'
  /** Claim-Text strukturell ungültig (Felder, Zeitformat, Laufzeit > 72 h). */
  | 'bad_claim'
  /** Claim gehört zu einer anderen Identität (Benutzer/Gerät/Umgebung). */
  | 'identity_mismatch'
  /** Verifikationsschlüssel weicht vom erwarteten (gepinnten) Schlüssel ab. */
  | 'untrusted_key';

export type LeaseClaimVerification =
  { ok: true; claim: OfflineLeaseClaim } | { ok: false; reason: LeaseClaimFailure };

export class LeaseInvalidError extends Error {
  constructor(readonly reason: LeaseClaimFailure | 'expired') {
    super(
      reason === 'expired'
        ? 'Die Offline-Berechtigung ist bereits abgelaufen.'
        : reason === 'unsupported'
          ? 'Dieses Gerät kann die Offline-Berechtigung nicht prüfen (Ed25519 nicht verfügbar).'
          : 'Die Offline-Berechtigung ist ungültig oder gehört zu einer anderen Identität.',
    );
    this.name = 'LeaseInvalidError';
  }
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function decodeBase64Url(text: string): Uint8Array | null {
  if (typeof text !== 'string' || text === '' || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    return fromBase64Url(text);
  } catch {
    return null;
  }
}

/**
 * Ed25519-Signatur über die UTF-8-Bytes des Claim-Texts prüfen.
 * `unsupported`, wenn WebCrypto den Algorithmus nicht importieren kann.
 */
export async function verifyLeaseSignature(
  signed: SignedLeaseClaim,
): Promise<{ ok: true } | { ok: false; reason: 'unsupported' | 'bad_signature' }> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return { ok: false, reason: 'unsupported' };
  const publicKey = decodeBase64Url(signed.verificationKey);
  const signature = decodeBase64Url(signed.signature);
  if (
    publicKey === null ||
    signature === null ||
    publicKey.byteLength !== ED25519_PUBLIC_KEY_BYTES ||
    signature.byteLength !== ED25519_SIGNATURE_BYTES ||
    typeof signed.claim !== 'string' ||
    signed.claim === ''
  ) {
    return { ok: false, reason: 'bad_signature' };
  }
  let key: CryptoKey;
  try {
    key = await subtle.importKey('raw', bufferOf(publicKey), { name: 'Ed25519' }, false, [
      'verify',
    ]);
  } catch {
    // Alte Engine ohne Ed25519 (NotSupportedError) oder ungültiger Schlüssel: nie durchwinken.
    return { ok: false, reason: 'unsupported' };
  }
  try {
    const valid = await subtle.verify(
      'Ed25519',
      key,
      bufferOf(signature),
      bufferOf(utf8Bytes(signed.claim)),
    );
    return valid ? { ok: true } : { ok: false, reason: 'bad_signature' };
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
}

/**
 * Vollständige Prüfung: Signatur → Struktur/Laufzeit → Identität. Liefert den
 * verifizierten Claim; Ablauf prüft der Aufrufer gegen seine (monotone) Uhr.
 * `trustedVerificationKey` (optional, Base64url) pinnt den Serverschlüssel.
 */
export async function verifyLeaseClaim(
  signed: SignedLeaseClaim,
  identity: LeaseClaimIdentity,
  trustedVerificationKey: string | null = null,
): Promise<LeaseClaimVerification> {
  if (trustedVerificationKey !== null && signed.verificationKey !== trustedVerificationKey) {
    return { ok: false, reason: 'untrusted_key' };
  }
  const signature = await verifyLeaseSignature(signed);
  if (!signature.ok) return signature;
  const claim = parseOfflineLeaseClaim(signed.claim);
  if (claim === null) return { ok: false, reason: 'bad_claim' };
  if (
    claim.userId !== identity.userId ||
    claim.deviceId !== identity.deviceId ||
    claim.environment !== identity.environment
  ) {
    return { ok: false, reason: 'identity_mismatch' };
  }
  return { ok: true, claim };
}

/** Lease abgelaufen (oder Zeit unlesbar) relativ zu `nowMs`. */
export function leaseClaimExpired(
  claim: Pick<OfflineLeaseClaim, 'expiresAt'>,
  nowMs: number,
): boolean {
  const expires = Date.parse(claim.expiresAt);
  return !Number.isFinite(expires) || expires <= nowMs;
}
