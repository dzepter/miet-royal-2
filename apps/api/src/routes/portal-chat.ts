import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { StorageProvider } from '@mietroyal/integrations';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sha256Hex } from '../auth/crypto.ts';
import { authErrorStatus, sendAuthError, sendError } from '../auth/http.ts';
import { MANUAL_REPLY_MAX_CHARS } from '../communication/conversation/conversation-service.ts';
import type { PushService } from '../communication/push/push-service.ts';
import {
  PORTAL_MESSAGE_MAX_PHOTOS,
  PORTAL_PHOTO_REJECTED_MESSAGE,
  PortalChatService,
  type PortalChatPhotoInput,
} from '../portal/chat/chat-service.ts';
import {
  portalSessionCookieName,
  requirePortalSession,
  type PortalSessionAuthenticator,
} from '../portal/guard.ts';
import { PORTAL_MESSAGES, PortalError } from '../portal/types.ts';
import { resolveVisibleBooking } from '../portal/visibility.ts';
import { UUID_PATTERN } from './auth.ts';

/**
 * Phase 15 (CHAT, Order §25–§28; Design §3.1): Portal-Chat des Kunden.
 * - GET  /portal/bookings/:id/messages – Nachrichten (nur Kanal portal), `canSend`.
 * - POST /portal/bookings/:id/messages – Text + bis zu 5 Bilder (base64), nur
 *   Buchungszustand `active` (sonst 409 PORTAL_BOOKING_CLOSED); 20/min je Session.
 * - GET  /portal/bookings/:id/messages/:messageId/photos/:photoId – Bytes privat.
 * Kunde IMMER aus der Session; Buchung über die zentrale Sichtbarkeits-Policy
 * (fremd/unsichtbar ⇒ neutrales 404). Antworten `cache-control: no-store`
 * (globaler Default) bzw. `private, no-store` + `nosniff` für Fotos
 * (Phase 15, Review Polyglot-CSP: zusätzlich `content-security-policy: default-src 'none'; sandbox`).
 */

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const bookingParams = z.object({ id: uuidSchema });
const photoParams = z.object({ id: uuidSchema, messageId: uuidSchema, photoId: uuidSchema });
const photoBody = z.strictObject({
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  dataBase64: z.string().min(1),
});
/** strictObject: `customerId`, `senderCustomerId` o. Ä. im Body ⇒ 400 (Order §12). */
const messageBody = z.strictObject({
  body: z.string().min(1, 'darf nicht leer sein').max(MANUAL_REPLY_MAX_CHARS),
  photos: z.array(photoBody).max(PORTAL_MESSAGE_MAX_PHOTOS).optional(),
});

/** JSON-Body-Grenze des POST (Text + base64-Bilder; je Bild ≤ 8 MiB dekodiert). */
export const PORTAL_CHAT_BODY_LIMIT = 12 * 1024 * 1024;
export const PORTAL_CHAT_RATE_LIMIT_PER_MINUTE = 20;
/** Obergrenze für die base64-Dekodierung je Bild (knapp über 8 MiB – Prüfung folgt). */
const PHOTO_DECODE_MAX_BYTES = 9 * 1024 * 1024;

export interface PortalChatRouteOptions {
  db: Database;
  config: AppConfig;
  storage: StorageProvider;
  push: PushService;
  sessions: PortalSessionAuthenticator;
  logger?: { warn(obj: Record<string, unknown>, msg?: string): void };
}

function decodeBase64(value: string, maxBytes: number): Uint8Array | null {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(value, 'base64'));
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > maxBytes) return null;
  return bytes;
}

export function registerPortalChatRoutes(
  app: FastifyInstance,
  options: PortalChatRouteOptions,
): void {
  const { db, config, storage, push, sessions } = options;
  const chat = new PortalChatService({
    db,
    storage,
    push,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const cookieName = portalSessionCookieName(config.appEnv);

  /** 20/min je Session (Schlüssel = IP + gehashter Sessiontoken, nie der Token selbst). */
  const sessionLimit = {
    rateLimit: {
      max: PORTAL_CHAT_RATE_LIMIT_PER_MINUTE,
      timeWindow: '1 minute',
      keyGenerator: (request: FastifyRequest) => {
        const token = request.cookies?.[cookieName];
        return `${request.ip}|${typeof token === 'string' ? sha256Hex(token).slice(0, 32) : 'anon'}`;
      },
    },
  };

  const notFound = (request: FastifyRequest, reply: FastifyReply): void => {
    sendError(request, reply, 404, 'NOT_FOUND', 'Nicht gefunden.');
  };

  /** PortalError ⇒ Status aus dem AuthError-Code, Fachcode `portalCode`; sonst AuthError-Mapping. */
  const sendFailure = (request: FastifyRequest, reply: FastifyReply, error: unknown): boolean => {
    if (error instanceof PortalError) {
      sendError(request, reply, authErrorStatus(error.code), error.portalCode, error.message);
      return true;
    }
    return sendAuthError(request, reply, error);
  };

  app.get('/portal/bookings/:id/messages', async (request, reply) => {
    const session = await requirePortalSession(request, reply, sessions, config, { touch: false });
    if (session === null) return;
    const params = parseOrThrow(bookingParams, request.params, 'params');
    const booking = await resolveVisibleBooking(db, session.customerId, params.id, new Date());
    if (booking === null) {
      notFound(request, reply);
      return;
    }
    const messages = await chat.listMessages(booking.process.id);
    return { messages, canSend: booking.portalState === 'active' };
  });

  app.post(
    '/portal/bookings/:id/messages',
    { bodyLimit: PORTAL_CHAT_BODY_LIMIT, config: sessionLimit },
    async (request, reply) => {
      const session = await requirePortalSession(request, reply, sessions, config, {
        touch: true,
      });
      if (session === null) return;
      const params = parseOrThrow(bookingParams, request.params, 'params');
      const body = parseOrThrow(messageBody, request.body);
      const now = new Date();
      const booking = await resolveVisibleBooking(db, session.customerId, params.id, now);
      if (booking === null) {
        notFound(request, reply);
        return;
      }
      if (booking.portalState !== 'active') {
        sendError(request, reply, 409, 'PORTAL_BOOKING_CLOSED', PORTAL_MESSAGES.BOOKING_CLOSED);
        return;
      }
      const photos: PortalChatPhotoInput[] = [];
      for (const photo of body.photos ?? []) {
        const bytes = decodeBase64(photo.dataBase64, PHOTO_DECODE_MAX_BYTES);
        if (bytes === null) {
          sendError(request, reply, 400, 'PORTAL_PHOTO_REJECTED', PORTAL_PHOTO_REJECTED_MESSAGE);
          return;
        }
        photos.push({ mimeType: photo.mimeType, bytes });
      }
      try {
        const view = await chat.createCustomerMessage({
          processId: booking.process.id,
          customerId: session.customerId,
          body: body.body,
          photos,
          now,
        });
        return reply.status(201).send(view);
      } catch (error) {
        if (sendFailure(request, reply, error)) return;
        throw error;
      }
    },
  );

  app.get('/portal/bookings/:id/messages/:messageId/photos/:photoId', async (request, reply) => {
    const session = await requirePortalSession(request, reply, sessions, config, { touch: false });
    if (session === null) return;
    const params = parseOrThrow(photoParams, request.params, 'params');
    const booking = await resolveVisibleBooking(db, session.customerId, params.id, new Date());
    if (booking === null) {
      notFound(request, reply);
      return;
    }
    const photo = await chat.photoBytes({
      processId: booking.process.id,
      messageId: params.messageId,
      photoId: params.photoId,
    });
    if (photo === null) {
      notFound(request, reply);
      return;
    }
    // Phase 15 (Review Polyglot-CSP, Defense in Depth): ein Bild mit angehängtem HTML/Script
    // (gültige Magic Bytes) kann beim direkten Öffnen nichts ausführen oder nachladen. Nur für
    // Bilder – Dokument-PDFs (portal-booking.ts) bekommen die Policy bewusst nicht.
    return reply
      .header('content-type', photo.mimeType)
      .header('content-disposition', 'inline')
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(Buffer.from(photo.bytes));
  });
}
