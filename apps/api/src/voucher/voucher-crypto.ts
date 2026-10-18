import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Verschlüsselte temporäre Versandkopie des Gutscheincodes (Order §13).
 *
 * AES-256-GCM mit zufälliger 12-Byte-Nonce; Schlüssel per HKDF-SHA256 aus
 * AUTH_SECRET_KEY mit eigenem Salt/Info (Purpose Separation
 * `voucher-delivery-v1` – ein anderer Schlüssel als für TOTP-Secrets oder
 * Offline-Leases). Die Gutschein-ID ist Additional Authenticated Data: eine
 * Kopie lässt sich nicht an einen anderen Gutschein hängen. Ausgabe base64
 * `iv|tag|ciphertext` (Muster wie auth/crypto.ts). Falscher Schlüssel oder
 * falsche ID ⇒ Entschlüsselung wirft.
 *
 * Folge einer Rotation von AUTH_SECRET_KEY: noch nicht versendete Kopien
 * werden unentschlüsselbar (Phase 12 meldet dann ein Versandproblem); der
 * Code-Hash und damit die Einlösbarkeit bleiben unberührt.
 */
const HKDF_SALT = Buffer.from('mietroyal/voucher-delivery/salt/v1', 'utf8');
const HKDF_INFO = 'mietroyal/voucher-delivery/v1';

function deriveDeliveryKey(secretKey: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secretKey, 'utf8'), HKDF_SALT, HKDF_INFO, 32));
}

export function encryptDeliveryCode(compact: string, voucherId: string, secretKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveDeliveryKey(secretKey), iv);
  cipher.setAAD(Buffer.from(voucherId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(compact, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptDeliveryCode(
  ciphertext: string,
  voucherId: string,
  secretKey: string,
): string {
  const raw = Buffer.from(ciphertext, 'base64');
  if (raw.length < 28) throw new Error('Versandkopie hat ein ungültiges Format.');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', deriveDeliveryKey(secretKey), iv);
  decipher.setAAD(Buffer.from(voucherId, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
