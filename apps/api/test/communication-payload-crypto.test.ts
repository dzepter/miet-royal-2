import { describe, expect, it } from 'vitest';
import {
  PayloadCrypto,
  PayloadCryptoError,
  payloadKeyId,
} from '../src/communication/payload-crypto.ts';
import { encryptDeliveryCode } from '../src/voucher/voucher-crypto.ts';

const KEY_A = 'communication-payload-key-A-0123456789abcdef';
const KEY_B = 'communication-payload-key-B-0123456789abcdef';
const AUTH = 'auth-secret-key-for-legacy-v1-0123456789';

function crypto(
  overrides: Partial<{
    appEnv: 'production' | 'demo' | 'development';
    key: string;
    previous: string | null;
    auth: string;
  }> = {},
): PayloadCrypto {
  return new PayloadCrypto({
    appEnv: overrides.appEnv ?? 'production',
    communication: {
      payloadKey: overrides.key ?? KEY_A,
      payloadKeyPrevious: overrides.previous ?? null,
    },
    auth: { secretKey: overrides.auth ?? AUTH, allowedOrigins: [] },
  });
}

describe('Kommunikations-Payload-Krypto (Phase 12, Pflichttests 172–184)', () => {
  it('172. AES-256-GCM v2: verschlüsselt und entschlüsselt mit Key-ID im Ciphertext', () => {
    const c = crypto();
    const ct = c.encrypt('secret-token', 'mail-secret-payload', 'entity-1');
    expect(ct).toMatch(/^v2:[0-9a-f]{12}:[A-Za-z0-9+/=]+$/);
    expect(ct.startsWith(`v2:${payloadKeyId(KEY_A)}:`)).toBe(true);
    expect(ct).not.toContain('secret-token');
    expect(c.decrypt(ct, 'mail-secret-payload', 'entity-1')).toBe('secret-token');
    expect(c.inspect(ct)).toEqual({ version: 'v2', keyId: payloadKeyId(KEY_A), current: true });
  });

  it('173. Zufällige Nonce: gleicher Klartext ⇒ verschiedene Ciphertexte', () => {
    const c = crypto();
    const a = c.encrypt('x', 'mail-secret-payload', 'e');
    const b = c.encrypt('x', 'mail-secret-payload', 'e');
    expect(a).not.toBe(b);
    expect(c.decrypt(b, 'mail-secret-payload', 'e')).toBe('x');
  });

  it('174. Purpose Separation: anderer Zweck ⇒ AUTH_FAILED', () => {
    const c = crypto();
    const ct = c.encrypt('x', 'mail-secret-payload', 'e');
    expect(() => c.decrypt(ct, 'customer-action-link', 'e')).toThrow(PayloadCryptoError);
    try {
      c.decrypt(ct, 'customer-action-link', 'e');
    } catch (error) {
      expect((error as PayloadCryptoError).code).toBe('AUTH_FAILED');
    }
  });

  it('175. Entity-Bindung: andere Entity-ID ⇒ AUTH_FAILED', () => {
    const c = crypto();
    const ct = c.encrypt('x', 'voucher-delivery', 'voucher-1');
    expect(() => c.decrypt(ct, 'voucher-delivery', 'voucher-2')).toThrow(/AUTH_FAILED/);
  });

  it('176. Environment im AAD: gleiche Schlüssel, andere Umgebung ⇒ AUTH_FAILED', () => {
    const prod = crypto({ appEnv: 'production' });
    const demo = crypto({ appEnv: 'demo' });
    const ct = prod.encrypt('x', 'mail-secret-payload', 'e');
    expect(() => demo.decrypt(ct, 'mail-secret-payload', 'e')).toThrow(/AUTH_FAILED/);
  });

  it('177. Falscher Schlüssel: unbekannte Key-ID ⇒ UNKNOWN_KEY (kein Klartext, kein Schlüssel in der Meldung)', () => {
    const a = crypto({ key: KEY_A });
    const b = crypto({ key: KEY_B });
    const ct = a.encrypt('x', 'mail-secret-payload', 'e');
    try {
      b.decrypt(ct, 'mail-secret-payload', 'e');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PayloadCryptoError);
      expect((error as PayloadCryptoError).code).toBe('UNKNOWN_KEY');
      expect((error as Error).message).not.toContain(KEY_A);
      expect((error as Error).message).not.toContain('x');
    }
  });

  it('178. Demo/Prod-Isolation: Key-ID ist nicht umkehrbar und je Schlüssel verschieden', () => {
    expect(payloadKeyId(KEY_A)).not.toBe(payloadKeyId(KEY_B));
    expect(payloadKeyId(KEY_A)).toHaveLength(12);
    expect(KEY_A).not.toContain(payloadKeyId(KEY_A));
  });

  it('179. Legacy v1 (Phase 11, HKDF aus AUTH_SECRET_KEY) bleibt für voucher-delivery lesbar', () => {
    const legacy = encryptDeliveryCode('MR20ABCDEFGHJKMN', 'voucher-1', AUTH);
    const c = crypto();
    expect(c.inspect(legacy)).toEqual({ version: 'v1', keyId: null, current: false });
    expect(c.decrypt(legacy, 'voucher-delivery', 'voucher-1')).toBe('MR20ABCDEFGHJKMN');
    expect(() => c.decrypt(legacy, 'voucher-delivery', 'voucher-2')).toThrow(/AUTH_FAILED/);
    // Legacy ist nur für Gutschein-Versandkopien zulässig.
    expect(() => c.decrypt(legacy, 'mail-secret-payload', 'voucher-1')).toThrow(
      /LEGACY_NOT_ALLOWED/,
    );
    // Rotierter AUTH_SECRET_KEY ⇒ Legacy nicht mehr lesbar (AUTH_FAILED), kein Absturz.
    expect(() =>
      crypto({ auth: 'another-auth-secret-key-0123456789abcdef' }).decrypt(
        legacy,
        'voucher-delivery',
        'voucher-1',
      ),
    ).toThrow(/AUTH_FAILED/);
  });

  it('180. v1 → v2 Rewrap: Ergebnis ist v2 mit aktuellem Schlüssel und demselben Klartext', () => {
    const legacy = encryptDeliveryCode('MR20ABCDEFGHJKMN', 'voucher-1', AUTH);
    const c = crypto();
    const v2 = c.rewrap(legacy, 'voucher-delivery', 'voucher-1');
    expect(c.inspect(v2).current).toBe(true);
    expect(c.decrypt(v2, 'voucher-delivery', 'voucher-1')).toBe('MR20ABCDEFGHJKMN');
    // Bereits aktuell ⇒ unverändert zurück.
    expect(c.rewrap(v2, 'voucher-delivery', 'voucher-1')).toBe(v2);
  });

  it('181. Current/Previous: Vorgängerschlüssel entschlüsselt, verschlüsselt aber nie', () => {
    const old = crypto({ key: KEY_A });
    const ct = old.encrypt('x', 'customer-action-link', 'e');
    const rotated = crypto({ key: KEY_B, previous: KEY_A });
    expect(rotated.decrypt(ct, 'customer-action-link', 'e')).toBe('x');
    expect(rotated.inspect(ct).current).toBe(false);
    expect(
      rotated.encrypt('y', 'customer-action-link', 'e').startsWith(`v2:${payloadKeyId(KEY_B)}:`),
    ).toBe(true);
  });

  it('182. Rewrap previous → current; ohne Vorgängerschlüssel UNKNOWN_KEY', () => {
    const old = crypto({ key: KEY_A });
    const ct = old.encrypt('x', 'document-link', 'e');
    const rotated = crypto({ key: KEY_B, previous: KEY_A });
    const fresh = rotated.rewrap(ct, 'document-link', 'e');
    expect(rotated.inspect(fresh)).toEqual({
      version: 'v2',
      keyId: payloadKeyId(KEY_B),
      current: true,
    });
    expect(crypto({ key: KEY_B }).decrypt(fresh, 'document-link', 'e')).toBe('x');
    expect(() => crypto({ key: KEY_B }).decrypt(ct, 'document-link', 'e')).toThrow(/UNKNOWN_KEY/);
  });

  it('183. Manipulierter oder zu kurzer Ciphertext ⇒ FORMAT/AUTH_FAILED, nie Klartext', () => {
    const c = crypto();
    const ct = c.encrypt('secret', 'mail-secret-payload', 'e');
    const [v, id, body] = ct.split(':');
    const flipped = `${v}:${id}:${(body ?? '').slice(0, -4)}AAAA`;
    expect(() => c.decrypt(flipped, 'mail-secret-payload', 'e')).toThrow(PayloadCryptoError);
    expect(() => c.decrypt(`v2:${id}:QUJD`, 'mail-secret-payload', 'e')).toThrow(/FORMAT/);
    expect(() => c.decrypt('nicht base64!', 'voucher-delivery', 'e')).toThrow(/FORMAT/);
  });

  it('184. Kein Klartext in Ciphertext/Fehlern (Vorbedingung für DB/Logs)', () => {
    const c = crypto();
    const ct = c.encrypt('MR20SECRETCODE12', 'voucher-delivery', 'v');
    expect(ct).not.toContain('MR20');
    expect(Buffer.from(ct.split(':')[2] ?? '', 'base64').toString('utf8')).not.toContain('MR20');
    const err = new PayloadCryptoError('AUTH_FAILED');
    expect(JSON.stringify(err)).not.toContain('MR20');
  });
});
