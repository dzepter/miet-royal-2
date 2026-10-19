import { generateToken, sha256Hex } from './crypto.ts';

/**
 * Grober Gerätename aus dem User-Agent – bewusst nur zur Wiedererkennung
 * in der Geräteübersicht, KEIN Fingerprinting (Phase-1-Vorgabe Nr. 7).
 * Phase-12-Finalisierung: entscheidet NIE über „neues Gerät“ (das macht
 * ausschließlich das Geräte-Cookie, siehe unten) – nur Anzeige.
 */
export function deviceLabelFromUserAgent(userAgent: string | undefined): string {
  if (userAgent === undefined || userAgent.trim() === '') return 'Unbekanntes Gerät';

  const ua = userAgent.toLowerCase();
  let system = 'Unbekanntes System';
  if (ua.includes('iphone')) system = 'iPhone';
  else if (ua.includes('ipad')) system = 'iPad';
  else if (ua.includes('android'))
    system = ua.includes('mobile') ? 'Android-Handy' : 'Android-Tablet';
  else if (ua.includes('windows')) system = 'Windows';
  else if (ua.includes('mac os') || ua.includes('macintosh')) system = 'Mac';
  else if (ua.includes('linux')) system = 'Linux';

  let browser = 'Browser';
  if (ua.includes('edg/')) browser = 'Edge';
  else if (ua.includes('opr/') || ua.includes('opera')) browser = 'Opera';
  else if (ua.includes('chrome/') || ua.includes('crios/')) browser = 'Chrome';
  else if (ua.includes('firefox/') || ua.includes('fxios/')) browser = 'Firefox';
  else if (ua.includes('safari/')) browser = 'Safari';

  return `${system} · ${browser}`;
}

// ── Phase-12-Finalisierung: stabile Geräteidentität ──────────────────────────
//
// Ein Gerät (genauer: ein Browserprofil) wird über einen serverseitig
// erzeugten Zufallswert im HttpOnly-Cookie `mr_staff_device` wiedererkannt.
// - 32 Zufallsbytes, base64url (43 Zeichen) – kein Fingerprinting, kein
//   Auth-Token (ersetzt nie Passwort/2FA, öffnet keine Session).
// - In der DB liegt ausschließlich der SHA-256 (`staff_known_devices`,
//   `staff_login_challenges.device_token_hash`); der Klartext erscheint nie
//   in Logs oder API-Antworten (nur im Set-Cookie-Header).
// - Fehlt das Cookie oder ist es syntaktisch ungültig, erzeugt der Server
//   beim Login einen neuen Wert (⇒ „neues Gerät“).
// - Logout und Session-Widerruf löschen das Cookie NICHT – das Gerät bleibt
//   bekannt.

export const DEVICE_COOKIE_NAME = 'mr_staff_device';

/** 400 Tage – die Obergrenze, die aktuelle Browser für Cookie-Laufzeiten akzeptieren. */
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/** 32 Byte base64url ohne Padding = genau 43 Zeichen aus [A-Za-z0-9_-]. */
const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function isWellFormedDeviceToken(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_TOKEN_PATTERN.test(value);
}

/** Schutz gegen versehentliches Speichern eines Klartexts statt des Hashes. */
export function isDeviceTokenHash(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

export interface ResolvedDeviceToken {
  /** Klartext – NUR für den Set-Cookie-Header, nie loggen/speichern/ausgeben. */
  token: string;
  /** SHA-256 (hex) – die einzige persistierte Form. */
  hash: string;
  /** true = es gab kein (gültiges) Cookie, der Wert wurde eben neu erzeugt. */
  issued: boolean;
}

/**
 * Liest die Geräteidentität aus dem Cookie-Wert der Anfrage; fehlt sie oder
 * ist sie syntaktisch ungültig, wird serverseitig ein neuer Wert erzeugt.
 * Ein ungültiger Wert wird verworfen und nie gehasht/gespeichert.
 */
export function resolveDeviceToken(cookieValue: string | undefined): ResolvedDeviceToken {
  if (isWellFormedDeviceToken(cookieValue)) {
    return { token: cookieValue, hash: sha256Hex(cookieValue), issued: false };
  }
  const token = generateToken();
  return { token, hash: sha256Hex(token), issued: true };
}
