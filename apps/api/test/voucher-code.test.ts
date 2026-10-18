/**
 * Phase-11-Pflichttests Code/Security 18–24, 30–32 (Unit; Order §§11–13):
 * kryptografisch zufällige, formatkonforme Codes; Hash eindeutig;
 * Versandkopie nur verschlüsselt (AES-256-GCM, HKDF-Zweck voucher-delivery-v1),
 * falscher Schlüssel/fremde Gutschein-ID scheitern; Normalisierung.
 */
import { randomUUID } from 'node:crypto';
import {
  formatVoucherCode,
  normalizeVoucherCode,
  VOUCHER_CODE_ALPHABET,
  VOUCHER_CODE_BODY_LENGTH,
} from '@mietroyal/domain';
import { describe, expect, it } from 'vitest';
import { codeSuffix, generateVoucherCode, hashVoucherCode } from '../src/voucher/voucher-codes.ts';
import { decryptDeliveryCode, encryptDeliveryCode } from '../src/voucher/voucher-crypto.ts';

const KEY_A = 'development-only-secret-key-aaaaaaaaaaaaaaaa';
const KEY_B = 'development-only-secret-key-bbbbbbbbbbbbbbbb';

describe('Gutscheincodes (Tests 18–20, 30–32)', () => {
  it('18. Codes sind zufällig und nicht fortlaufend (1000 Codes ohne Duplikat, keine gemeinsame Sequenz)', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 1000; i += 1) codes.add(generateVoucherCode());
    expect(codes.size).toBe(1000);
    const bodies = [...codes].map((code) => code.slice(4));
    // Jede Position nutzt mehrere Alphabetzeichen (kein Zähler, keine Konstante).
    for (let position = 0; position < VOUCHER_CODE_BODY_LENGTH; position += 1) {
      const distinct = new Set(bodies.map((body) => body[position]));
      expect(distinct.size).toBeGreaterThan(10);
    }
  });

  it('19. Format MR20 + 12 Zeichen aus dem verwechslungsarmen Alphabet; Anzeige MR20-XXXX-XXXX-XXXX', () => {
    const code = generateVoucherCode();
    expect(code).toMatch(new RegExp(`^MR20[${VOUCHER_CODE_ALPHABET}]{12}$`));
    expect(code.slice(4)).not.toMatch(/[01IOL]/);
    expect(formatVoucherCode(code)).toMatch(/^MR20-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(codeSuffix(code)).toBe(code.slice(-4));
    expect(normalizeVoucherCode(formatVoucherCode(code))).toBe(code);
  });

  it('20. Hash ist SHA-256 der kompakten Form, deterministisch und je Code eindeutig', () => {
    const a = generateVoucherCode();
    const b = generateVoucherCode();
    expect(hashVoucherCode(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashVoucherCode(a)).toBe(hashVoucherCode(a));
    expect(hashVoucherCode(a)).not.toBe(hashVoucherCode(b));
    expect(hashVoucherCode(a)).not.toContain(a.slice(4, 8));
  });

  it('30./31. Eingabe case-insensitiv und mit/ohne Bindestriche/Leerzeichen normalisierbar', () => {
    expect(normalizeVoucherCode('mr20-7k3f-x9qm-t2rw')).toBe('MR207K3FX9QMT2RW');
    expect(normalizeVoucherCode('MR207K3FX9QMT2RW')).toBe('MR207K3FX9QMT2RW');
    expect(normalizeVoucherCode(' mr20 7k3f x9qm t2rw ')).toBe('MR207K3FX9QMT2RW');
    expect(normalizeVoucherCode('MR20-7K3F-X9QM-T2RW')).toBe('MR207K3FX9QMT2RW');
  });

  it('32. Ungültige Form ⇒ null (streng): falsche Länge, verbotene Zeichen, fremdes Präfix, Überlänge', () => {
    for (const input of [
      '',
      'MR20',
      'MR20-7K3F-X9QM-T2R',
      'MR20-7K3F-X9QM-T2RWX',
      'MR20-7K3F-X9QM-T20W',
      'MR20-7K3F-X9QM-T2IW',
      'MR21-7K3F-X9QM-T2RW',
      'XX20-7K3F-X9QM-T2RW',
      'MR20-7K3F-X9QM-T2RW; DROP TABLE',
      'M'.repeat(100),
    ]) {
      expect(normalizeVoucherCode(input), input).toBeNull();
    }
  });
});

describe('Versandkopie (Tests 21–24)', () => {
  it('22./23. Versandkopie ist base64 iv|tag|ct ohne Klartext und mit richtigem Schlüssel + ID entschlüsselbar', () => {
    const voucherId = randomUUID();
    const code = generateVoucherCode();
    const ciphertext = encryptDeliveryCode(code, voucherId, KEY_A);
    expect(ciphertext).not.toContain(code);
    expect(ciphertext).not.toContain(code.slice(4));
    expect(Buffer.from(ciphertext, 'base64').length).toBe(12 + 16 + code.length);
    expect(decryptDeliveryCode(ciphertext, voucherId, KEY_A)).toBe(code);
    // Zufällige Nonce: zweimal verschlüsseln ergibt unterschiedliche Kopien.
    expect(encryptDeliveryCode(code, voucherId, KEY_A)).not.toBe(ciphertext);
  });

  it('24./126. Falscher Schlüssel (andere Umgebung) oder fremde Gutschein-ID ⇒ Entschlüsselung scheitert', () => {
    const voucherId = randomUUID();
    const code = generateVoucherCode();
    const ciphertext = encryptDeliveryCode(code, voucherId, KEY_A);
    expect(() => decryptDeliveryCode(ciphertext, voucherId, KEY_B)).toThrow();
    expect(() => decryptDeliveryCode(ciphertext, randomUUID(), KEY_A)).toThrow();
    expect(() => decryptDeliveryCode('AAAA', voucherId, KEY_A)).toThrow();
    // Manipuliertes Tag/Ciphertext ⇒ Authentifizierung schlägt fehl.
    const raw = Buffer.from(ciphertext, 'base64');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0x01;
    expect(() => decryptDeliveryCode(raw.toString('base64'), voucherId, KEY_A)).toThrow();
  });
});
