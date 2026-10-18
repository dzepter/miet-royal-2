import { randomInt } from 'node:crypto';
import {
  VOUCHER_CODE_ALPHABET,
  VOUCHER_CODE_BODY_LENGTH,
  VOUCHER_CODE_PREFIX,
} from '@mietroyal/domain';
import { sha256Hex } from '../auth/crypto.ts';

/**
 * Gutscheincodes (Phase 11, Order §§11–12): kryptografisch zufällig
 * (`crypto.randomInt`, verwechslungsarmes Alphabet, 12 Zeichen ≈ 59 Bit
 * Entropie), nicht fortlaufend, ohne Bezug zu IDs/Kunde. Persistiert wird
 * ausschließlich der SHA-256-Hash der kompakten Form plus die letzten vier
 * Zeichen für die maskierte Darstellung.
 */

/** Kompakte Form `MR20XXXXXXXXXXXX` (ohne Bindestriche). */
export function generateVoucherCode(): string {
  let body = '';
  for (let i = 0; i < VOUCHER_CODE_BODY_LENGTH; i += 1) {
    body += VOUCHER_CODE_ALPHABET[randomInt(VOUCHER_CODE_ALPHABET.length)];
  }
  return `${VOUCHER_CODE_PREFIX}${body}`;
}

/** SHA-256 (hex) der kompakten Form – einzige persistierte Referenz auf den Code. */
export function hashVoucherCode(compact: string): string {
  return sha256Hex(compact);
}

/** Letzte vier Zeichen für `MR20-••••-••••-XXXX`. */
export function codeSuffix(compact: string): string {
  return compact.slice(-4);
}
