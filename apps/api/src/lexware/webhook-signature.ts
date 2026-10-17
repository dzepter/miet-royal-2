import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';

/**
 * Prüfung der Lexware-Webhook-Signatur (Order §45): Header `X-Lxo-Signature`
 * = Base64 einer RSA-SHA512-Signatur „of the JSON request body (without
 * whitespaces and linebreaks)“. Es werden die ROHBYTES des Requests geprüft
 * und – weil die Doku die kompakte Form nennt – zusätzlich die kompakt
 * serialisierte Form (JSON.parse → JSON.stringify ohne Whitespace). Beides
 * sind deterministische Darstellungen desselben Bodys; keine Heuristik, kein
 * Vertrauen ohne gültige Signatur.
 */
export function loadWebhookPublicKey(pem: string): KeyObject {
  return createPublicKey({ key: pem, format: 'pem' });
}

export function verifyLexwareSignature(
  publicKey: KeyObject,
  rawBody: Uint8Array,
  signatureHeader: string | undefined,
): boolean {
  if (signatureHeader === undefined || signatureHeader.trim() === '') return false;
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureHeader.trim(), 'base64');
  } catch {
    return false;
  }
  if (signature.length === 0) return false;
  if (verifyBytes(publicKey, rawBody, signature)) return true;
  const compact = compactJson(rawBody);
  if (compact !== null && !bytesEqual(compact, rawBody)) {
    return verifyBytes(publicKey, compact, signature);
  }
  return false;
}

function verifyBytes(publicKey: KeyObject, data: Uint8Array, signature: Buffer): boolean {
  try {
    const verifier = createVerify('RSA-SHA512');
    verifier.update(data);
    verifier.end();
    return verifier.verify(publicKey, signature);
  } catch {
    return false;
  }
}

function compactJson(raw: Uint8Array): Uint8Array | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as unknown;
    return Buffer.from(JSON.stringify(parsed), 'utf8');
  } catch {
    return null;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
