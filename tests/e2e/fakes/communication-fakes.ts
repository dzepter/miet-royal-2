import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import {
  FAKES_CONTROL_PORT,
  FAKES_HTTPS_PORT,
  IMAP_FAKE_PASSWORD,
  IMAP_FAKE_PORT,
  IMAP_FAKE_USER,
  PUSH_FAKE_ORIGIN,
  SMTP_SINK_HOST,
  SMTP_SINK_PASSWORD,
  SMTP_SINK_PORT,
  SMTP_SINK_USER,
  TEST_SERVER_CERT_FILE,
  TEST_SERVER_KEY_FILE,
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_GRAPH_FAKE_PORT,
  WHATSAPP_PHONE_NUMBER_ID,
} from './constants.ts';
import { startImapFake } from './imap-server.ts';
import { createPushServiceFake, type PushResponseRule } from './push-service.ts';
import { startSmtpSink, type SmtpFailure } from './smtp-sink.ts';
import { createWhatsAppGraphFake, type WhatsAppFailure } from './whatsapp-graph.ts';

/**
 * Phase 12 (E2E): EIN Prozess für alle lokalen Kommunikations-Fakes
 * (Playwright-webServer, startet VOR den APIs). Nur Loopback, nur Tests.
 *
 * | Port (constants.ts)        | Protokoll | Inhalt                                    |
 * |----------------------------|-----------|-------------------------------------------|
 * | SMTP_SINK_PORT 4565        | SMTPS     | SMTP-Senke (implizites TLS, AUTH)          |
 * | FAKES_CONTROL_PORT 4566    | HTTP      | Steuerung/Abfrage (siehe unten)            |
 * | FAKES_HTTPS_PORT 4567      | HTTPS     | Push-Endpunkte, WhatsApp-Mediendownload    |
 * | WHATSAPP_GRAPH_FAKE_PORT   | HTTP      | WhatsApp-Graph-API-Fake                    |
 * | IMAP_FAKE_PORT 4569        | IMAPS     | Inbound-Mailbox (implizites TLS, LOGIN)    |
 *
 * Steuerung (JSON):
 * - GET /health
 * - GET /smtp/messages[?to=<adresse>] (raw = Base64), DELETE /smtp/messages (leert auch
 *   Ablehnungen/Injektionen), GET /smtp/rejections,
 *   POST /smtp/fail-next {stage:'mail'|'rcpt'|'data', code, times?, recipient?, mode?:'reply'|'drop'}
 * - GET /push/requests, DELETE /push/requests,
 *   POST /push/respond {subscriptionId|'*', status, times?|null}
 * - GET /whatsapp/requests, DELETE /whatsapp/requests (leert auch Medien),
 *   POST /whatsapp/media {mediaId, mimeType, base64},
 *   POST /whatsapp/fail-next {endpoint:'messages'|'media_meta'|'media_download', status, graphCode?, times?}
 * - GET /imap/messages (ohne Rohdaten) + /imap/commands, DELETE /imap/messages (Mailboxen,
 *   Kommando-/Login-Protokoll), POST /imap/messages {raw (Base64), folder?, flags?} ⇒ {uid},
 *   POST /imap/uidvalidity {folder?, uidValidity}
 */

const key = readFileSync(process.env.E2E_TLS_KEY_FILE ?? TEST_SERVER_KEY_FILE);
const cert = readFileSync(process.env.E2E_TLS_CERT_FILE ?? TEST_SERVER_CERT_FILE);

const sink = await startSmtpSink({
  port: SMTP_SINK_PORT,
  host: SMTP_SINK_HOST,
  key,
  cert,
  user: SMTP_SINK_USER,
  password: SMTP_SINK_PASSWORD,
});
const imap = await startImapFake({
  port: IMAP_FAKE_PORT,
  host: SMTP_SINK_HOST,
  key,
  cert,
  user: IMAP_FAKE_USER,
  password: IMAP_FAKE_PASSWORD,
});
const push = createPushServiceFake();
const whatsapp = createWhatsAppGraphFake({
  accessToken: WHATSAPP_ACCESS_TOKEN,
  phoneNumberId: WHATSAPP_PHONE_NUMBER_ID,
  mediaBaseUrl: PUSH_FAKE_ORIGIN,
});

const MAX_BODY_BYTES = 10 * 1024 * 1024;

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(new Error('Body zu groß'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks)));
    request.on('error', rejectBody);
  });
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function parseJson(body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  const parsed: unknown = JSON.parse(body.toString('utf8'));
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

async function handleControl(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const route = `${request.method ?? 'GET'} ${url.pathname}`;
  const body = await readBody(request);
  switch (route) {
    case 'GET /health':
      return json(response, 200, { ok: true });
    case 'GET /smtp/messages': {
      // Optional `?to=<adresse>`: nur Nachrichten an diesen Empfänger (Umschlag).
      const to = url.searchParams.get('to')?.toLowerCase() ?? null;
      const selected =
        to === null
          ? sink.messages
          : sink.messages.filter((message) =>
              message.rcptTo.some((address) => address.toLowerCase() === to),
            );
      return json(response, 200, {
        messages: selected.map((message) => ({
          id: message.id,
          receivedAt: message.receivedAt,
          mailFrom: message.mailFrom,
          rcptTo: message.rcptTo,
          authUser: message.authUser,
          size: message.raw.length,
          raw: message.raw.toString('base64'),
        })),
      });
    }
    case 'DELETE /smtp/messages':
      sink.clear();
      return json(response, 200, { cleared: true });
    case 'GET /smtp/rejections':
      return json(response, 200, { rejections: sink.rejections });
    case 'POST /smtp/fail-next': {
      const input = parseJson(body);
      const stage = input.stage;
      if (stage !== 'mail' && stage !== 'rcpt' && stage !== 'data') {
        return json(response, 400, { error: 'stage muss mail|rcpt|data sein' });
      }
      const code = asInt(input.code, 451);
      if (code < 400 || code > 599) return json(response, 400, { error: 'code 400–599' });
      const failure: SmtpFailure = {
        stage,
        code,
        times: Math.max(1, asInt(input.times, 1)),
        recipient: typeof input.recipient === 'string' ? input.recipient : null,
        mode: input.mode === 'drop' ? 'drop' : 'reply',
      };
      sink.failures.push(failure);
      return json(response, 200, { queued: sink.failures.length });
    }
    case 'GET /push/requests':
      return json(response, 200, { requests: push.requests });
    case 'DELETE /push/requests':
      push.clear();
      return json(response, 200, { cleared: true });
    case 'POST /push/respond': {
      const input = parseJson(body);
      const rule: PushResponseRule = {
        subscriptionId: typeof input.subscriptionId === 'string' ? input.subscriptionId : '*',
        status: asInt(input.status, 201),
        times: input.times === null ? null : Math.max(1, asInt(input.times, 1)),
      };
      push.rules.push(rule);
      return json(response, 200, { rules: push.rules.length });
    }
    case 'GET /whatsapp/requests':
      return json(response, 200, { requests: whatsapp.requests });
    case 'DELETE /whatsapp/requests':
      whatsapp.clear();
      return json(response, 200, { cleared: true });
    case 'POST /whatsapp/media': {
      const input = parseJson(body);
      if (typeof input.mediaId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.mediaId)) {
        return json(response, 400, { error: 'mediaId ungültig' });
      }
      whatsapp.media.set(input.mediaId, {
        mediaId: input.mediaId,
        mimeType: typeof input.mimeType === 'string' ? input.mimeType : 'image/jpeg',
        bytes: Buffer.from(typeof input.base64 === 'string' ? input.base64 : '', 'base64'),
      });
      return json(response, 200, { stored: input.mediaId });
    }
    case 'POST /whatsapp/fail-next': {
      const input = parseJson(body);
      const endpoint = input.endpoint;
      if (endpoint !== 'messages' && endpoint !== 'media_meta' && endpoint !== 'media_download') {
        return json(response, 400, { error: 'endpoint ungültig' });
      }
      const failure: WhatsAppFailure = {
        endpoint,
        status: asInt(input.status, 400),
        graphCode: typeof input.graphCode === 'number' ? input.graphCode : null,
        times: Math.max(1, asInt(input.times, 1)),
      };
      whatsapp.failures.push(failure);
      return json(response, 200, { queued: whatsapp.failures.length });
    }
    case 'GET /imap/messages':
      return json(response, 200, {
        mailboxes: [...imap.mailboxes.entries()].map(([folder, box]) => ({
          folder,
          uidValidity: box.uidValidity,
          uidNext: box.nextUid,
          messages: box.messages.map((message) => ({
            uid: message.uid,
            size: message.raw.length,
            flags: message.flags,
          })),
        })),
      });
    case 'GET /imap/commands':
      return json(response, 200, { commands: imap.commands, logins: imap.logins });
    case 'DELETE /imap/messages':
      imap.clear();
      return json(response, 200, { cleared: true });
    case 'POST /imap/messages': {
      const input = parseJson(body);
      if (typeof input.raw !== 'string' || input.raw === '') {
        return json(response, 400, { error: 'raw (Base64) fehlt' });
      }
      const uid = imap.append(
        typeof input.folder === 'string' ? input.folder : 'INBOX',
        Buffer.from(input.raw, 'base64'),
        Array.isArray(input.flags) ? input.flags.map(String) : [],
      );
      return json(response, 200, { uid });
    }
    case 'POST /imap/uidvalidity': {
      const input = parseJson(body);
      imap.setUidValidity(
        typeof input.folder === 'string' ? input.folder : 'INBOX',
        asInt(input.uidValidity, 2),
      );
      return json(response, 200, { ok: true });
    }
    default:
      return json(response, 404, { error: `Unbekannte Steuerung: ${route}` });
  }
}

function listen(
  server: ReturnType<typeof createServer> | ReturnType<typeof createHttpsServer>,
  port: number,
  host: string,
): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
}

const control = createServer((request, response) => {
  handleControl(request, response).catch((error: unknown) => {
    json(response, 500, { error: error instanceof Error ? error.message : 'Fehler' });
  });
});

// HTTPS: Push-Endpunkte + WhatsApp-Mediendownload (localhost UND 127.0.0.1 – Zertifikat-SAN).
const https = createHttpsServer({ key, cert, minVersion: 'TLSv1.2' }, (request, response) => {
  readBody(request)
    .then((body) => {
      if (push.handle(request, response, body)) return;
      if (whatsapp.handleMediaDownload(request, response)) return;
      if (request.url === '/health') return json(response, 200, { ok: true });
      json(response, 404, { error: 'Unbekannter Pfad' });
    })
    .catch(() => json(response, 400, { error: 'Ungültiger Request' }));
});

const graph = createServer((request, response) => {
  readBody(request)
    .then((body) => whatsapp.handleGraph(request, response, body))
    .catch(() => json(response, 400, { error: 'Ungültiger Request' }));
});

await listen(https, FAKES_HTTPS_PORT, '127.0.0.1');
await listen(graph, WHATSAPP_GRAPH_FAKE_PORT, '127.0.0.1');
// Steuerung zuletzt: Playwright wartet auf /health – dann laufen alle Fakes.
await listen(control, FAKES_CONTROL_PORT, '127.0.0.1');
process.stdout.write(
  `Kommunikations-Fakes bereit: SMTPS ${SMTP_SINK_PORT}, Steuerung ${FAKES_CONTROL_PORT}, ` +
    `HTTPS ${FAKES_HTTPS_PORT}, WhatsApp-Graph ${WHATSAPP_GRAPH_FAKE_PORT}, IMAPS ${IMAP_FAKE_PORT}\n`,
);

const shutdown = () => {
  void sink.close();
  void imap.close();
  control.close();
  https.close();
  graph.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
