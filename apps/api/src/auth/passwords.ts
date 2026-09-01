import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id mit OWASP-empfohlenen Parametern (Stand 2026): 19 MiB, t=2, p=1.
 * Keine Eigenkryptografie.
 * algorithm: 2 entspricht Algorithm.Argon2id aus @node-rs/argon2 – das
 * ambient const enum ist unter verbatimModuleSyntax nicht importierbar.
 */
const ARGON2_OPTIONS = {
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Passwortregeln (Phase-1-Vorgabe): ausreichend lang, passwortmanager-
 * freundlich, KEINE Zwangsregeln wie Großbuchstabe+Sonderzeichen+Zahl.
 * Rückgabe: null = ok, sonst verständliche deutsche Fehlermeldung.
 */
export function validateNewPassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Das Passwort muss mindestens ${PASSWORD_MIN_LENGTH} Zeichen lang sein.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Das Passwort darf höchstens ${PASSWORD_MAX_LENGTH} Zeichen lang sein.`;
  }
  if (password.trim().length === 0) {
    return 'Das Passwort darf nicht nur aus Leerzeichen bestehen.';
  }
  return null;
}
