/**
 * Krypto-Bausteine für die Mitarbeiter-Authentifizierung.
 * Ausschließlich Node-Standardkrypto – keine Eigenentwicklungen.
 *
 * - Tokens (Session, Reset, Challenge) sind 256-Bit-Zufallswerte; persistiert
 *   wird ausschließlich ihr SHA-256-Hash.
 * - TOTP-Secrets werden mit AES-256-GCM verschlüsselt (Schlüssel abgeleitet
 *   aus AUTH_SECRET_KEY, je Umgebung verschieden).
 * - Recovery-Codes sind Zufallswerte; persistiert wird nur ihr Hash.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function deriveAesKey(secretKey: string): Buffer {
  return createHash('sha256').update(`mietroyal:auth:${secretKey}`, 'utf8').digest();
}

export function encryptSecret(plaintext: string, secretKey: string): string {
  const key = deriveAesKey(secretKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptSecret(encoded: string, secretKey: string): string {
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', deriveAesKey(secretKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Format: XXXX-XXXX-XX aus einem verwechslungsarmen Alphabet. */
export function generateRecoveryCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 10; i += 1) {
    code += alphabet[randomInt(alphabet.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

/** Recovery-Codes werden case-/bindestrich-unabhängig verglichen. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replaceAll('-', '').trim();
}
