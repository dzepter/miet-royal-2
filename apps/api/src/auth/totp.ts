import * as OTPAuth from 'otpauth';

/**
 * TOTP nach RFC 6238 über die etablierte Bibliothek `otpauth`
 * (Authenticator-Apps: 6 Stellen, 30 s, SHA-1 – maximale Kompatibilität).
 */
const TOTP_ISSUER = 'Miet-Royal';

export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export function buildOtpauthUri(secretBase32: string, accountEmail: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label: accountEmail,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.toString();
}

/**
 * window=1: toleriert eine Periode Uhrzeit-Drift in beide Richtungen.
 * Rückgabe: der getroffene RFC-6238-Zeitschritt (für den Replay-Schutz –
 * derselbe Schritt darf nie zweimal akzeptiert werden) oder null.
 */
export function verifyTotpCode(secretBase32: string, code: string): number | null {
  const trimmed = code.replaceAll(' ', '').trim();
  if (!/^\d{6}$/.test(trimmed)) return null;
  const totp = new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  const delta = totp.validate({ token: trimmed, window: 1 });
  if (delta === null) return null;
  return Math.floor(Date.now() / 30_000) + delta;
}
