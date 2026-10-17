import {
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import type { OfflineEnvironment, OfflineLeaseClaim } from '@mietroyal/offline/shared';

/**
 * Serversignierte Offline-Lease (Phase-8-Finalisierung §1).
 *
 * Der Client darf die Laufzeit eines Lease weder selbst setzen noch ein Lease
 * lokal „verlängern“: userId/deviceId/environment/issuedAt/expiresAt stehen in
 * einem vom Server signierten Claim, den der Client vollständig offline mit
 * dem mitgelieferten öffentlichen Schlüssel prüft. Ohne den privaten Schlüssel
 * (nur serverseitig) lässt sich kein gültiger Claim erzeugen.
 *
 * Schlüsselmaterial: ausschließlich node:crypto Ed25519 – keine eigene
 * Kryptografie. Der private Seed wird per HKDF-SHA256 aus `AUTH_SECRET_KEY`
 * abgeleitet (eigener Salt/Info), ist also je Umgebung verschieden
 * (Env-Isolation erzwingt unterschiedliche AUTH_SECRET_KEY) und muss nicht
 * separat gespeichert werden. AUTH_SECRET_KEY selbst verlässt den Server nie;
 * ausgeliefert wird nur der öffentliche Verifikationsschlüssel.
 */

const HKDF_SALT = Buffer.from('mietroyal/offline-lease-signing/salt/v1', 'utf8');
const HKDF_INFO = 'mietroyal/offline-lease-signing/v1';
/** PKCS#8-DER-Präfix eines Ed25519-Private-Keys (RFC 8410), gefolgt vom 32-Byte-Seed. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_PUBLIC_KEY_BYTES = 32;

export interface SignedLeaseClaim {
  /** Exakter JSON-Text des Claims – über dessen UTF-8-Bytes wurde signiert. */
  claim: string;
  /** Base64url – Ed25519-Signatur. */
  signature: string;
  /** Base64url – roher 32-Byte-Ed25519-Verifikationsschlüssel. */
  verificationKey: string;
}

export interface LeaseClaimInput {
  leaseId: string;
  userId: string;
  deviceId: string;
  environment: OfflineEnvironment;
  issuedAt: Date;
  expiresAt: Date;
}

/** Signaturschlüssel pro Serverprozess – abgeleitet, nie persistiert. */
export class OfflineLeaseSigner {
  private readonly privateKey: KeyObject;
  readonly verificationKey: string;

  constructor(secretKey: string) {
    const seed = Buffer.from(
      hkdfSync('sha256', Buffer.from(secretKey, 'utf8'), HKDF_SALT, HKDF_INFO, 32),
    );
    this.privateKey = createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
      format: 'der',
      type: 'pkcs8',
    });
    const spki = createPublicKey(this.privateKey).export({ format: 'der', type: 'spki' });
    // SPKI-DER eines Ed25519-Schlüssels endet mit den 32 rohen Public-Key-Bytes.
    this.verificationKey = spki
      .subarray(spki.length - ED25519_PUBLIC_KEY_BYTES)
      .toString('base64url');
  }

  /**
   * Claim bauen und signieren. Feldreihenfolge ist Teil des Vertrags
   * (`OfflineLeaseClaim`): `{ v, leaseId, userId, deviceId, environment,
   * issuedAt, expiresAt, nonce }` – der Client verifiziert über den exakten
   * Text, nicht über ein re-serialisiertes Objekt.
   */
  sign(input: LeaseClaimInput): SignedLeaseClaim {
    const claimObject: OfflineLeaseClaim = {
      v: 1,
      leaseId: input.leaseId,
      userId: input.userId,
      deviceId: input.deviceId,
      environment: input.environment,
      issuedAt: input.issuedAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      nonce: randomBytes(16).toString('base64url'),
    };
    const claim = JSON.stringify(claimObject);
    const signature = sign(null, Buffer.from(claim, 'utf8'), this.privateKey).toString('base64url');
    return { claim, signature, verificationKey: this.verificationKey };
  }
}
