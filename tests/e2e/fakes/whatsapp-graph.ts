import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Phase 12 (E2E): Fake der WhatsApp Business Cloud API (Meta Graph API) für
 * den echten `CloudApiWhatsAppGateway` der E2E-API (development erlaubt
 * WHATSAPP_BASE_URL per http auf diesen Fake).
 *
 * Endpunkte wie bei Meta (Vertrag laut phase12_whatsapp_verification.md):
 * - `POST /{version}/{phone-number-id}/messages` (Bearer-Token) ⇒
 *   `{ messaging_product, contacts, messages: [{ id: 'wamid.…' }] }`
 * - `GET /{version}/{media-id}?phone_number_id=…` ⇒ `{ url, mime_type,
 *   sha256, file_size, id }` – die URL zeigt auf den HTTPS-Teil des Fakes
 *   (`/whatsapp-media/<id>`, Download ebenfalls mit Bearer-Token), weil der
 *   Gateway nur https-Medien-URLs akzeptiert.
 * Falsches Token ⇒ 401 mit Graph-Fehlercode 190. Fehlerinjektion je Endpunkt
 * (`POST /whatsapp/fail-next`) mit HTTP-Status + Graph-Fehlercode (z. B.
 * 131047 „Fenster geschlossen“, 130429 „Rate Limit“). Alle Requests werden
 * aufgezeichnet (Token NICHT – nur ob es stimmte).
 */

export interface WhatsAppGraphRequestRecord {
  receivedAt: string;
  method: string;
  path: string;
  /** Welcher Endpunkt: Nachricht senden, Medien-Metadaten, Medien-Download. */
  endpoint: 'messages' | 'media_meta' | 'media_download' | 'unknown';
  authorized: boolean;
  status: number;
  /** JSON-Body (nur `messages`). */
  body: unknown;
}

export interface WhatsAppFailure {
  endpoint: 'messages' | 'media_meta' | 'media_download';
  status: number;
  /** Graph-Fehlercode im Body (`error.code`); null ⇒ kein Fehlerobjekt. */
  graphCode: number | null;
  times: number;
}

export interface WhatsAppMedia {
  mediaId: string;
  mimeType: string;
  bytes: Buffer;
}

export interface WhatsAppGraphFake {
  readonly requests: WhatsAppGraphRequestRecord[];
  readonly failures: WhatsAppFailure[];
  readonly media: Map<string, WhatsAppMedia>;
  clear(): void;
  /** Graph-API (HTTP-Server). */
  handleGraph(request: IncomingMessage, response: ServerResponse, body: Buffer): void;
  /** Mediendownload (HTTPS-Server); true, wenn behandelt. */
  handleMediaDownload(request: IncomingMessage, response: ServerResponse): boolean;
}

export interface WhatsAppGraphFakeOptions {
  accessToken: string;
  phoneNumberId: string;
  /** Basis der Download-URLs (HTTPS-Teil des Fakes). */
  mediaBaseUrl: string;
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

export function createWhatsAppGraphFake(options: WhatsAppGraphFakeOptions): WhatsAppGraphFake {
  const requests: WhatsAppGraphRequestRecord[] = [];
  const failures: WhatsAppFailure[] = [];
  const media = new Map<string, WhatsAppMedia>();

  function takeFailure(endpoint: WhatsAppFailure['endpoint']): WhatsAppFailure | null {
    const index = failures.findIndex((failure) => failure.endpoint === endpoint);
    if (index < 0) return null;
    const failure = failures[index]!;
    failure.times -= 1;
    if (failure.times <= 0) failures.splice(index, 1);
    return failure;
  }

  function authorized(request: IncomingMessage): boolean {
    return request.headers.authorization === `Bearer ${options.accessToken}`;
  }

  function record(
    request: IncomingMessage,
    endpoint: WhatsAppGraphRequestRecord['endpoint'],
    status: number,
    body: unknown,
  ): void {
    requests.push({
      receivedAt: new Date().toISOString(),
      method: request.method ?? 'GET',
      path: new URL(request.url ?? '/', 'http://localhost').pathname,
      endpoint,
      authorized: authorized(request),
      status,
      body,
    });
  }

  function sendFailure(
    request: IncomingMessage,
    response: ServerResponse,
    endpoint: WhatsAppGraphRequestRecord['endpoint'],
    failure: WhatsAppFailure,
    body: unknown,
  ): void {
    record(request, endpoint, failure.status, body);
    json(
      response,
      failure.status,
      failure.graphCode === null
        ? {}
        : {
            error: {
              message: 'E2E-Fake: simulierter Graph-Fehler',
              type: 'OAuthException',
              code: failure.graphCode,
              fbtrace_id: 'E2E',
            },
          },
    );
  }

  return {
    requests,
    failures,
    media,
    clear() {
      requests.length = 0;
      failures.length = 0;
      media.clear();
    },
    handleGraph(request, response, body) {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const messages = /^\/(v\d{1,3}\.\d{1,3})\/(\d{1,32})\/messages$/.exec(url.pathname);
      if (messages !== null && request.method === 'POST') {
        let payload: unknown;
        try {
          payload = JSON.parse(body.toString('utf8'));
        } catch {
          payload = null;
        }
        if (!authorized(request)) {
          sendFailure(
            request,
            response,
            'messages',
            { endpoint: 'messages', status: 401, graphCode: 190, times: 1 },
            payload,
          );
          return;
        }
        if (messages[2] !== options.phoneNumberId) {
          sendFailure(
            request,
            response,
            'messages',
            { endpoint: 'messages', status: 400, graphCode: 100, times: 1 },
            payload,
          );
          return;
        }
        const failure = takeFailure('messages');
        if (failure !== null) {
          sendFailure(request, response, 'messages', failure, payload);
          return;
        }
        record(request, 'messages', 200, payload);
        const to = (payload as { to?: unknown } | null)?.to;
        json(response, 200, {
          messaging_product: 'whatsapp',
          contacts: [{ input: typeof to === 'string' ? to : '', wa_id: to }],
          messages: [{ id: `wamid.E2E${randomUUID().replace(/-/g, '')}` }],
        });
        return;
      }
      const meta = /^\/(v\d{1,3}\.\d{1,3})\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
      if (meta !== null && request.method === 'GET') {
        if (!authorized(request)) {
          sendFailure(
            request,
            response,
            'media_meta',
            { endpoint: 'media_meta', status: 401, graphCode: 190, times: 1 },
            null,
          );
          return;
        }
        const failure = takeFailure('media_meta');
        if (failure !== null) {
          sendFailure(request, response, 'media_meta', failure, null);
          return;
        }
        const entry = media.get(meta[2]!);
        if (entry === undefined) {
          sendFailure(
            request,
            response,
            'media_meta',
            { endpoint: 'media_meta', status: 404, graphCode: 100, times: 1 },
            null,
          );
          return;
        }
        record(request, 'media_meta', 200, null);
        json(response, 200, {
          messaging_product: 'whatsapp',
          url: `${options.mediaBaseUrl}/whatsapp-media/${encodeURIComponent(entry.mediaId)}`,
          mime_type: entry.mimeType,
          sha256: createHash('sha256').update(entry.bytes).digest('hex'),
          file_size: entry.bytes.length,
          id: entry.mediaId,
        });
        return;
      }
      record(request, 'unknown', 404, null);
      json(response, 404, { error: { message: 'Unbekannter Endpunkt', code: 100 } });
    },
    handleMediaDownload(request, response) {
      const match = /^\/whatsapp-media\/([A-Za-z0-9_-]{1,128})$/.exec(
        new URL(request.url ?? '/', 'https://localhost').pathname,
      );
      if (match === null) return false;
      if (!authorized(request)) {
        record(request, 'media_download', 401, null);
        response.writeHead(401).end();
        return true;
      }
      const failure = takeFailure('media_download');
      if (failure !== null) {
        record(request, 'media_download', failure.status, null);
        response.writeHead(failure.status).end();
        return true;
      }
      const entry = media.get(match[1]!);
      if (entry === undefined) {
        record(request, 'media_download', 404, null);
        response.writeHead(404).end();
        return true;
      }
      record(request, 'media_download', 200, null);
      response.writeHead(200, {
        'content-type': entry.mimeType,
        'content-length': String(entry.bytes.length),
      });
      response.end(entry.bytes);
      return true;
    },
  };
}
