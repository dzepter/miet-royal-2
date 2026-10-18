import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  randomUUID,
  verify,
} from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import {
  FAKES_CONTROL_ORIGIN,
  PUSH_FAKE_ORIGIN,
  PUSH_VAPID_PUBLIC_KEY,
  PUSH_VAPID_SUBJECT,
} from '../fakes/constants.ts';

/**
 * Phase-12-Helfer Web Push (Grundlage der Szenarien M–Q): Der echte
 * `WebPushGateway` der E2E-API (web-push, VAPID, aes128gcm) sendet an den
 * Push-Fake (fakes/push-service.ts, HTTPS mit Test-Zertifikat).
 *
 * Eine Spec erzeugt je „Gerät“ ein P-256-Schlüsselpaar + Auth-Secret
 * (`createPushSubscriptionKeys`, nur im Testprozess), registriert es über
 * die Staff-API (`registerPushSubscription`, Endpoint
 * `https://localhost:4567/push/<id>`) und liest eingegangene Pushes über die
 * Fake-Steuerung (`pushRequests`). `decryptPush` entschlüsselt RFC 8291
 * (aes128gcm) mit dem privaten Schlüssel; `verifyVapid` prüft den
 * `Authorization: vapid t=…, k=…`-Header (RFC 8292, ES256-Signatur gegen den
 * VAPID-Test-Public-Key).
 */

export interface PushSubscriptionKeys {
  /** Pfadsegment des Endpoints beim Fake (`/push/<id>`). */
  id: string;
  endpoint: string;
  /** base64url (unkomprimierter P-256-Punkt, 65 Byte). */
  p256dh: string;
  /** base64url (16 Byte). */
  auth: string;
  /** Nur im Testprozess. */
  privateKey: Buffer;
  publicKey: Buffer;
  authSecret: Buffer;
}

export function createPushSubscriptionKeys(): PushSubscriptionKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const authSecret = randomBytes(16);
  const id = randomUUID().replace(/-/g, '');
  const publicKey = ecdh.getPublicKey();
  return {
    id,
    endpoint: `${PUSH_FAKE_ORIGIN}/push/${id}`,
    p256dh: publicKey.toString('base64url'),
    auth: authSecret.toString('base64url'),
    privateKey: ecdh.getPrivateKey(),
    publicKey,
    authSecret,
  };
}

/** Subscription des eingeloggten Staff-Users (Session der Seite) registrieren. */
export async function registerPushSubscription(
  page: Page,
  keys: PushSubscriptionKeys,
  label = 'E2E-Browser',
): Promise<string> {
  const response = await page.request.post('/api/staff/push/subscriptions', {
    data: {
      endpoint: keys.endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      userAgentLabel: label,
    },
  });
  expect(response.ok(), 'Push-Subscription registriert').toBe(true);
  return ((await response.json()) as { subscriptionId: string }).subscriptionId;
}

export interface PushRequest {
  subscriptionId: string;
  receivedAt: string;
  status: number;
  headers: {
    ttl: string | null;
    urgency: string | null;
    topic: string | null;
    contentEncoding: string | null;
    contentType: string | null;
    authorization: string | null;
  };
  body: string;
}

async function control<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
  const response = await fetch(`${FAKES_CONTROL_ORIGIN}${path}`, {
    method,
    // Keine Keep-Alive-Sockets (siehe helpers/lexware.ts control()).
    headers: {
      connection: 'close',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Fake-Steuerung ${method} ${path}: ${response.status}`);
  return (await response.json()) as T;
}

/** Eingegangene Pushes (optional nur für ein Gerät). */
export async function pushRequests(keys?: PushSubscriptionKeys): Promise<PushRequest[]> {
  const { requests } = await control<{ requests: PushRequest[] }>('GET', '/push/requests');
  return keys === undefined ? requests : requests.filter((r) => r.subscriptionId === keys.id);
}

export async function clearPushRequests(): Promise<void> {
  await control('DELETE', '/push/requests');
}

/** Nächste Antwort(en) des Push-Dienstes für ein Gerät (z. B. 410 ⇒ Subscription weg). */
export async function respondPush(
  keys: PushSubscriptionKeys | '*',
  status: number,
  times: number | null = 1,
): Promise<void> {
  await control('POST', '/push/respond', {
    subscriptionId: keys === '*' ? '*' : keys.id,
    status,
    times,
  });
}

/** RFC 8291 / RFC 8188 (aes128gcm, ein Record) – liefert den Klartext-Payload. */
export function decryptPush(request: PushRequest, keys: PushSubscriptionKeys): string {
  const body = Buffer.from(request.body, 'base64');
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const serverPublicKey = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(keys.privateKey);
  const sharedSecret = ecdh.computeSecret(serverPublicKey);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'latin1'),
    keys.publicKey,
    serverPublicKey,
  ]);
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, keys.authSecret, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12),
  );
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  // Padding: Daten || 0x02 (letzter Record) || 0x00*
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  expect(padded[end], 'Padding-Delimiter des letzten Records').toBe(2);
  return padded.subarray(0, end).toString('utf8');
}

/** `Authorization: vapid t=<JWT>, k=<key>` prüfen (ES256 gegen den VAPID-Test-Public-Key). */
export function verifyVapid(request: PushRequest): { aud: string; sub: string; exp: number } {
  const header = request.headers.authorization ?? '';
  const match = /^vapid t=([^,\s]+),\s*k=([A-Za-z0-9_-]+)$/.exec(header);
  expect(match, 'VAPID-Authorization-Header').not.toBeNull();
  const [, jwt, key] = match!;
  expect(key).toBe(PUSH_VAPID_PUBLIC_KEY);
  const [encodedHeader, encodedClaims, encodedSignature] = jwt!.split('.');
  const point = Buffer.from(PUSH_VAPID_PUBLIC_KEY, 'base64url');
  const publicKey = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
  const valid = verify(
    'sha256',
    Buffer.from(`${encodedHeader}.${encodedClaims}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(encodedSignature!, 'base64url'),
  );
  expect(valid, 'VAPID-Signatur (ES256)').toBe(true);
  const claims = JSON.parse(Buffer.from(encodedClaims!, 'base64url').toString('utf8')) as {
    aud: string;
    sub: string;
    exp: number;
  };
  expect(claims.aud).toBe(PUSH_FAKE_ORIGIN);
  expect(claims.sub).toBe(PUSH_VAPID_SUBJECT);
  expect(claims.exp * 1000).toBeGreaterThan(Date.now());
  return claims;
}
