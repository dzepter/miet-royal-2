import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Phase 12 (E2E): Fake eines Web-Push-Dienstes (RFC 8030) für den echten
 * `WebPushGateway` (Bibliothek web-push, VAPID RFC 8292, aes128gcm RFC 8291)
 * der E2E-API. Läuft im HTTPS-Server von communication-fakes.ts (Test-
 * Zertifikat aus fixtures/tls); Specs registrieren Subscriptions mit dem
 * Endpoint `https://localhost:<FAKES_HTTPS_PORT>/push/<id>`.
 *
 * Jeder `POST /push/<id>` wird aufgezeichnet (Header TTL/Urgency/Topic/
 * Content-Encoding/Authorization + verschlüsselter Body als Base64) und mit
 * 201 beantwortet – oder mit dem per Steuerung gesetzten Status (z. B. 410
 * „Subscription abgelaufen“, 404, 429, 500) für Fehlerpfade. Entschlüsselt
 * wird hier NICHT: das kann die Spec mit ihrem privaten Subscription-
 * Schlüssel selbst (helpers/push.ts).
 */

export interface PushRequestRecord {
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
  /** Verschlüsselter Body (aes128gcm) als Base64. */
  body: string;
}

export interface PushResponseRule {
  /** Subscription-ID (Pfadsegment) oder `*` für alle. */
  subscriptionId: string;
  status: number;
  /** Anzahl Antworten; `null` = dauerhaft. */
  times: number | null;
}

export interface PushServiceFake {
  readonly requests: PushRequestRecord[];
  readonly rules: PushResponseRule[];
  clear(): void;
  /** true, wenn der Request behandelt wurde. */
  handle(request: IncomingMessage, response: ServerResponse, body: Buffer): boolean;
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(', ') : value;
}

export function createPushServiceFake(): PushServiceFake {
  const requests: PushRequestRecord[] = [];
  const rules: PushResponseRule[] = [];

  function statusFor(subscriptionId: string): number {
    const index = rules.findIndex(
      (rule) => rule.subscriptionId === subscriptionId || rule.subscriptionId === '*',
    );
    if (index < 0) return 201;
    const rule = rules[index]!;
    if (rule.times !== null) {
      rule.times -= 1;
      if (rule.times <= 0) rules.splice(index, 1);
    }
    return rule.status;
  }

  return {
    requests,
    rules,
    clear() {
      requests.length = 0;
      rules.length = 0;
    },
    handle(request, response, body) {
      const match = /^\/push\/([A-Za-z0-9_-]{1,128})$/.exec(
        new URL(request.url ?? '/', 'https://localhost').pathname,
      );
      if (match === null) return false;
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return true;
      }
      const subscriptionId = match[1]!;
      const status = statusFor(subscriptionId);
      requests.push({
        subscriptionId,
        receivedAt: new Date().toISOString(),
        status,
        headers: {
          ttl: header(request, 'ttl'),
          urgency: header(request, 'urgency'),
          topic: header(request, 'topic'),
          contentEncoding: header(request, 'content-encoding'),
          contentType: header(request, 'content-type'),
          authorization: header(request, 'authorization'),
        },
        body: body.toString('base64'),
      });
      response.writeHead(
        status,
        status === 201 ? { location: `/messages/${requests.length}` } : {},
      );
      response.end();
      return true;
    },
  };
}
