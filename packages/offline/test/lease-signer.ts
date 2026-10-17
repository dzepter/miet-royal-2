/**
 * Test-Signer für Lease-Claims (Phase-8-Finalisierung §1): erzeugt ein
 * Ed25519-Schlüsselpaar mit Node-WebCrypto und signiert Claim-Texte genau so,
 * wie es der Server tut (Signatur über die UTF-8-Bytes des JSON-Texts).
 */
import { randomBytes, toBase64Url, utf8Bytes } from '../src/crypto.ts';
import type { LeaseGrant, OfflineLeaseClaim } from '../src/package-types.ts';

export interface TestSigner {
  verificationKey: string;
  sign(claimText: string): Promise<string>;
  /** Claim in Serialisierungsreihenfolge + Signatur – `claim` darf nachträglich überschrieben werden. */
  signedClaim(
    claim: Partial<OfflineLeaseClaim>,
  ): Promise<{ claim: string; signature: string; verificationKey: string }>;
  /** `claimFields` überschreibt Felder des signierten Claims (z. B. nonce, environment). */
  grant(
    overrides?: Partial<LeaseGrant> & { claimFields?: Partial<OfflineLeaseClaim> },
  ): Promise<LeaseGrant>;
}

export const DEFAULT_ISSUED_AT = '2026-09-28T08:00:00.000Z';
export const DEFAULT_EXPIRES_AT = new Date(
  Date.parse(DEFAULT_ISSUED_AT) + 72 * 3_600_000,
).toISOString();

export function claimText(claim: Partial<OfflineLeaseClaim>): string {
  const full: OfflineLeaseClaim = {
    v: 1,
    leaseId: 'lease-1',
    userId: 'user-1',
    deviceId: 'device-1',
    environment: 'development',
    issuedAt: DEFAULT_ISSUED_AT,
    expiresAt: DEFAULT_EXPIRES_AT,
    nonce: toBase64Url(randomBytes(16)),
    ...claim,
  };
  return JSON.stringify(full);
}

export async function createTestSigner(): Promise<TestSigner> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const verificationKey = toBase64Url(
    new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
  );
  const sign = async (text: string): Promise<string> => {
    const bytes = utf8Bytes(text);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return toBase64Url(
      new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, copy.buffer)),
    );
  };
  const signedClaim = async (claim: Partial<OfflineLeaseClaim>) => {
    const text = claimText(claim);
    return { claim: text, signature: await sign(text), verificationKey };
  };
  return {
    verificationKey,
    sign,
    signedClaim,
    async grant(
      overrides: Partial<LeaseGrant> & { claimFields?: Partial<OfflineLeaseClaim> } = {},
    ) {
      const { claimFields, ...rest } = overrides;
      const base = JSON.parse(
        claimText({
          ...(rest.leaseId !== undefined ? { leaseId: rest.leaseId } : {}),
          ...(rest.userId !== undefined ? { userId: rest.userId } : {}),
          ...(rest.deviceId !== undefined ? { deviceId: rest.deviceId } : {}),
          ...(rest.environment !== undefined ? { environment: rest.environment } : {}),
          ...(rest.issuedAt !== undefined ? { issuedAt: rest.issuedAt } : {}),
          ...(rest.expiresAt !== undefined ? { expiresAt: rest.expiresAt } : {}),
          ...(claimFields ?? {}),
        }),
      ) as OfflineLeaseClaim;
      const signed = await signedClaim(base);
      return {
        leaseId: base.leaseId,
        userId: base.userId,
        environment: base.environment,
        deviceId: base.deviceId,
        issuedAt: base.issuedAt,
        expiresAt: base.expiresAt,
        leaseSecret: toBase64Url(randomBytes(32)),
        permissions: ['return.perform', 'handover.perform'],
        firstName: 'Erika',
        lastName: 'E2E',
        ...rest,
        ...signed,
      };
    },
  };
}
