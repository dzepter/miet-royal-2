import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import type { AppConfig } from '@mietroyal/config';
import { decryptDeliveryCode } from '../voucher/voucher-crypto.ts';

/**
 * Zentrale Verschlüsselung von Kommunikations-Geheimnissen (Phase 12, Order §§7/8):
 * Angebots-Token, Aktions-Token, Dokument-Token und Gutscheincodes liegen in der
 * Datenbank nie im Klartext, sondern als AES-256-GCM-Payload.
 *
 * Format v2: `v2:<keyId>:<base64(iv|tag|ciphertext)>`
 * - Schlüssel: HKDF-SHA256 aus COMMUNICATION_PAYLOAD_KEY (eigener Schlüssel,
 *   nie AUTH_SECRET_KEY), zufällige 12-Byte-Nonce je Payload.
 * - keyId: 12 Hex-Zeichen eines SHA-256 über den Schlüssel (nicht umkehrbar);
 *   erlaubt die Auswahl zwischen aktuellem und genau einem Vorgängerschlüssel.
 * - AAD = `<appEnv>|<purpose>|<entityId>`: Purpose Separation, Umgebung und
 *   Entität sind authentifiziert – eine Payload lässt sich nicht an eine andere
 *   Entität, einen anderen Zweck oder eine andere Umgebung hängen.
 *
 * Legacy v1 (Phase 11, kein Präfix): Gutschein-Versandkopie per HKDF aus
 * AUTH_SECRET_KEY (voucher-crypto.ts). Nur für `voucher-delivery` lesbar und
 * ausschließlich zum Rewrap nach v2 gedacht; neue Payloads sind immer v2.
 */
export type PayloadPurpose =
  'voucher-delivery' | 'mail-secret-payload' | 'customer-action-link' | 'document-link';

export const PAYLOAD_FORMAT_VERSION = 'v2';

export type PayloadCryptoErrorCode =
  'FORMAT' | 'UNKNOWN_KEY' | 'AUTH_FAILED' | 'LEGACY_NOT_ALLOWED';

/** Trägt nie Klartext oder Schlüsselmaterial – nur den Fehlercode. */
export class PayloadCryptoError extends Error {
  constructor(readonly code: PayloadCryptoErrorCode) {
    super(`Kommunikations-Payload nicht lesbar (${code}).`);
    this.name = 'PayloadCryptoError';
  }
}

const HKDF_SALT = Buffer.from('mietroyal/communication-payload/salt/v2', 'utf8');
const HKDF_INFO = 'mietroyal/communication-payload/v2';
const KEY_ID_DOMAIN = 'mietroyal/communication-payload/key-id/v2/';
const V2_PATTERN = /^v2:([0-9a-f]{12}):([A-Za-z0-9+/=]+)$/;

export function payloadKeyId(key: string): string {
  return createHash('sha256')
    .update(KEY_ID_DOMAIN + key, 'utf8')
    .digest('hex')
    .slice(0, 12);
}

function deriveKey(key: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(key, 'utf8'), HKDF_SALT, HKDF_INFO, 32));
}

function aad(appEnv: string, purpose: PayloadPurpose, entityId: string): Buffer {
  return Buffer.from(`${appEnv}|${purpose}|${entityId}`, 'utf8');
}

export type PayloadCryptoConfig = Pick<AppConfig, 'appEnv' | 'communication' | 'auth'>;

export interface PayloadInspection {
  version: 'v1' | 'v2';
  keyId: string | null;
  /** v2 mit aktuellem Schlüssel – kein Rewrap nötig. */
  current: boolean;
}

export class PayloadCrypto {
  private readonly current: { id: string; key: Buffer };
  private readonly previous: { id: string; key: Buffer } | null;

  constructor(private readonly config: PayloadCryptoConfig) {
    const { payloadKey, payloadKeyPrevious } = config.communication;
    this.current = { id: payloadKeyId(payloadKey), key: deriveKey(payloadKey) };
    this.previous =
      payloadKeyPrevious === null
        ? null
        : { id: payloadKeyId(payloadKeyPrevious), key: deriveKey(payloadKeyPrevious) };
  }

  get currentKeyId(): string {
    return this.current.id;
  }

  /** Immer v2 mit dem aktuellen Schlüssel. */
  encrypt(plaintext: string, purpose: PayloadPurpose, entityId: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.current.key, iv);
    cipher.setAAD(aad(this.config.appEnv, purpose, entityId));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PAYLOAD_FORMAT_VERSION}:${this.current.id}:${Buffer.concat([iv, tag, body]).toString('base64')}`;
  }

  /** Liefert Format/Key-Zuordnung ohne zu entschlüsseln. */
  inspect(ciphertext: string): PayloadInspection {
    const match = V2_PATTERN.exec(ciphertext);
    if (match === null) return { version: 'v1', keyId: null, current: false };
    const keyId = match[1] ?? '';
    return { version: 'v2', keyId, current: keyId === this.current.id };
  }

  /**
   * v2: aktueller oder Vorgängerschlüssel (per keyId). v1 (ohne Präfix) nur für
   * `voucher-delivery` über AUTH_SECRET_KEY (Legacy Phase 11). Falscher
   * Schlüssel / falsche AAD ⇒ AUTH_FAILED; unbekannte keyId ⇒ UNKNOWN_KEY.
   */
  decrypt(ciphertext: string, purpose: PayloadPurpose, entityId: string): string {
    const match = V2_PATTERN.exec(ciphertext);
    if (match === null) {
      if (purpose !== 'voucher-delivery') throw new PayloadCryptoError('LEGACY_NOT_ALLOWED');
      return this.decryptLegacyVoucher(ciphertext, entityId);
    }
    const keyId = match[1] ?? '';
    const material =
      keyId === this.current.id
        ? this.current
        : this.previous !== null && keyId === this.previous.id
          ? this.previous
          : null;
    if (material === null) throw new PayloadCryptoError('UNKNOWN_KEY');
    const raw = Buffer.from(match[2] ?? '', 'base64');
    if (raw.length < 28) throw new PayloadCryptoError('FORMAT');
    const decipher = createDecipheriv('aes-256-gcm', material.key, raw.subarray(0, 12));
    decipher.setAAD(aad(this.config.appEnv, purpose, entityId));
    decipher.setAuthTag(raw.subarray(12, 28));
    try {
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      throw new PayloadCryptoError('AUTH_FAILED');
    }
  }

  /** Nach erfolgreicher Entschlüsselung neu mit dem aktuellen Schlüssel kapseln (v1→v2, previous→current). */
  rewrap(ciphertext: string, purpose: PayloadPurpose, entityId: string): string {
    if (this.inspect(ciphertext).current) return ciphertext;
    return this.encrypt(this.decrypt(ciphertext, purpose, entityId), purpose, entityId);
  }

  private decryptLegacyVoucher(ciphertext: string, voucherId: string): string {
    if (!/^[A-Za-z0-9+/=]+$/.test(ciphertext)) throw new PayloadCryptoError('FORMAT');
    try {
      return decryptDeliveryCode(ciphertext, voucherId, this.config.auth.secretKey);
    } catch (error) {
      if (error instanceof Error && /Format/.test(error.message)) {
        throw new PayloadCryptoError('FORMAT');
      }
      throw new PayloadCryptoError('AUTH_FAILED');
    }
  }
}
