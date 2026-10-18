import { createHmac, randomUUID } from 'node:crypto';
import {
  FAKES_CONTROL_ORIGIN,
  WHATSAPP_APP_SECRET,
  WHATSAPP_BUSINESS_ACCOUNT_ID,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
} from '../fakes/constants.ts';

/**
 * Phase-12-Helfer WhatsApp (Grundlage der Szenarien K/L): Die Haupt-API der
 * E2E (Port 3101) läuft mit dem ECHTEN `CloudApiWhatsAppGateway` gegen den
 * Graph-Fake (fakes/whatsapp-graph.ts). Eingehende Nachrichten simuliert die
 * Spec als offiziell signierten Webhook (`X-Hub-Signature-256` = HMAC-SHA256
 * über die Rohbytes mit dem TEST-App-Secret) an `POST /webhooks/whatsapp`;
 * ausgehende Staff-Antworten zeichnet der Graph-Fake auf (`whatsappRequests`).
 * Bilder: `registerWhatsAppMedia` legt die Bytes beim Fake ab, der Webhook
 * referenziert die Media-ID (Download über HTTPS mit Bearer-Token).
 */

/** Haupt-API (Projekt chromium) – direkt, ohne Staff-Proxy (Webhook ist öffentlich). */
export const WHATSAPP_API_ORIGIN = 'http://127.0.0.1:3101';

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

export interface WhatsAppGraphRequest {
  receivedAt: string;
  method: string;
  path: string;
  endpoint: 'messages' | 'media_meta' | 'media_download' | 'unknown';
  authorized: boolean;
  status: number;
  body: unknown;
}

export async function whatsappRequests(): Promise<WhatsAppGraphRequest[]> {
  return (await control<{ requests: WhatsAppGraphRequest[] }>('GET', '/whatsapp/requests'))
    .requests;
}

/** Aufzeichnungen, Medien und Fehlerinjektionen des Graph-Fakes leeren. */
export async function clearWhatsAppFake(): Promise<void> {
  await control('DELETE', '/whatsapp/requests');
}

export async function registerWhatsAppMedia(
  mediaId: string,
  mimeType: string,
  bytes: Buffer,
): Promise<void> {
  await control('POST', '/whatsapp/media', { mediaId, mimeType, base64: bytes.toString('base64') });
}

/** Nächste Graph-Antwort(en) eines Endpunkts als Fehler (z. B. 400 + 131047 Fenster zu, 429 + 130429). */
export async function failNextWhatsApp(options: {
  endpoint: 'messages' | 'media_meta' | 'media_download';
  status: number;
  graphCode?: number;
  times?: number;
}): Promise<void> {
  await control('POST', '/whatsapp/fail-next', options);
}

/** `sha256=<hex>` über die exakten Rohbytes (Meta-Signaturverfahren). */
export function signWhatsAppBody(rawBody: string): string {
  return `sha256=${createHmac('sha256', WHATSAPP_APP_SECRET).update(rawBody, 'utf8').digest('hex')}`;
}

/** Signierten Webhook an die API senden; liefert Status + Antworttext. */
export async function postWhatsAppWebhook(
  payload: unknown,
  options: { signature?: string; apiOrigin?: string } = {},
): Promise<{ status: number; body: string }> {
  const raw = JSON.stringify(payload);
  const response = await fetch(`${options.apiOrigin ?? WHATSAPP_API_ORIGIN}/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      connection: 'close',
      'content-type': 'application/json',
      'x-hub-signature-256': options.signature ?? signWhatsAppBody(raw),
    },
    body: raw,
  });
  return { status: response.status, body: await response.text() };
}

/** Verify-Challenge wie Meta (GET hub.mode/hub.verify_token/hub.challenge). */
export async function whatsappVerifyChallenge(
  challenge: string,
  verifyToken = WHATSAPP_VERIFY_TOKEN,
): Promise<{ status: number; body: string }> {
  const query = new URLSearchParams({
    'hub.mode': 'subscribe',
    'hub.verify_token': verifyToken,
    'hub.challenge': challenge,
  });
  const response = await fetch(`${WHATSAPP_API_ORIGIN}/webhooks/whatsapp?${query.toString()}`, {
    headers: { connection: 'close' },
  });
  return { status: response.status, body: await response.text() };
}

export interface InboundWhatsAppMessage {
  /** Absender (wa_id, nur Ziffern inkl. Ländervorwahl, z. B. 4915112345678). */
  from: string;
  profileName?: string;
  /** Default: zufällige wamid. */
  id?: string;
  /** Default: jetzt. */
  timestamp?: Date;
  text?: string;
  image?: { mediaId: string; mimeType: string; caption?: string };
  /** Antwort-Kontext auf eine frühere (ausgehende) Nachricht. */
  contextMessageId?: string;
}

/** Webhook-Payload im offiziellen Format (object/entry/changes/value/messages). */
export function inboundWhatsAppPayload(message: InboundWhatsAppMessage): {
  payload: unknown;
  messageId: string;
} {
  const messageId = message.id ?? `wamid.E2EIN${randomUUID().replace(/-/g, '')}`;
  const timestamp = String(Math.floor((message.timestamp ?? new Date()).getTime() / 1000));
  const content =
    message.image !== undefined
      ? {
          type: 'image',
          image: {
            id: message.image.mediaId,
            mime_type: message.image.mimeType,
            ...(message.image.caption === undefined ? {} : { caption: message.image.caption }),
          },
        }
      : { type: 'text', text: { body: message.text ?? '' } };
  return {
    messageId,
    payload: {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: WHATSAPP_BUSINESS_ACCOUNT_ID,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '4961310000000',
                  phone_number_id: WHATSAPP_PHONE_NUMBER_ID,
                },
                contacts: [
                  { profile: { name: message.profileName ?? 'E2E Kunde' }, wa_id: message.from },
                ],
                messages: [
                  {
                    from: message.from,
                    id: messageId,
                    timestamp,
                    ...(message.contextMessageId === undefined
                      ? {}
                      : {
                          context: { from: WHATSAPP_PHONE_NUMBER_ID, id: message.contextMessageId },
                        }),
                    ...content,
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  };
}
