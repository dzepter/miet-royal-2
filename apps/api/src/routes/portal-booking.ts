import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { StorageProvider } from '@mietroyal/integrations';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sha256Hex } from '../auth/crypto.ts';
import { authErrorStatus, sendAuthError, sendError } from '../auth/http.ts';
import type { CancellationService } from '../cancellation/cancellation-service.ts';
import { DocumentService } from '../commerce/document-service.ts';
import { PortalBookingService } from '../portal/booking-service.ts';
import {
  PortalCancellationService,
  type PortalCancellationBackend,
} from '../portal/cancellation.ts';
import {
  listPortalDocuments,
  portalDocumentFilename,
  resolvePortalDocument,
} from '../portal/documents.ts';
import {
  portalSessionCookieName,
  requirePortalSession,
  type PortalSessionAuthenticator,
} from '../portal/guard.ts';
import { PortalError } from '../portal/types.ts';
import type { VisibleBooking } from '../portal/visibility.ts';
import { UUID_PATTERN } from './auth.ts';

/**
 * Phase 15 (Design §2.5): Buchungsrouten des Kundenportals. Alle Routen
 * verlangen die Portal-Session (Kunde IMMER aus der Session, Order §12); die
 * Buchung wird ausschließlich über die `CustomerPortalVisibilityPolicy`
 * aufgelöst – fremd/unbekannt/unsichtbar ⇒ neutrales 404 „Nicht gefunden.“
 * (nie 403, kein Existenz-Orakel). Es gibt keine Historien-Route.
 */
export interface PortalBookingRouteDeps {
  db: Database;
  config: AppConfig;
  storage: StorageProvider;
  cancellationService: Pick<CancellationService, 'preview' | 'cancel' | 'sendConfirmation'>;
  sessions: PortalSessionAuthenticator;
  logger?: { warn(obj: Record<string, unknown>, msg?: string): void } | undefined;
}

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const bookingParams = z.object({ id: uuidSchema });
const documentParams = z.object({ id: uuidSchema, documentId: uuidSchema });
/**
 * Der Kunde bestätigt nur – Satz, Basis und Gebühr rechnet der Server (strict ⇒ 400).
 * Phase 15 (Review R2): `expectedFeeCents` = Gebühr der angezeigten Vorschau (Pflicht, nur
 * Prüfwert): weicht die unter der Prozesssperre berechnete Gebühr ab ⇒ 409, nichts geschrieben.
 */
const cancelBody = z.strictObject({
  confirm: z.literal(true),
  expectedFeeCents: z.number().int().min(0).max(100_000_000),
});

export const PORTAL_NOT_FOUND_MESSAGE = 'Nicht gefunden.';
/** Phase 15 (Review R5): Storno-Bestätigungen je Session und Minute. */
export const PORTAL_CANCELLATION_RATE_LIMIT_PER_MINUTE = 10;

function sendNotFound(request: FastifyRequest, reply: FastifyReply): void {
  sendError(request, reply, 404, 'NOT_FOUND', PORTAL_NOT_FOUND_MESSAGE);
}

function sendPortalError(request: FastifyRequest, reply: FastifyReply, error: unknown): boolean {
  if (error instanceof PortalError) {
    sendError(request, reply, authErrorStatus(error.code), error.portalCode, error.message);
    return true;
  }
  return sendAuthError(request, reply, error);
}

export function registerPortalBookingRoutes(
  app: FastifyInstance,
  deps: PortalBookingRouteDeps,
): void {
  const bookingService = new PortalBookingService({
    db: deps.db,
    cancellation: deps.cancellationService,
  });
  const cancellation = new PortalCancellationService(
    deps.cancellationService as PortalCancellationBackend,
    deps.logger,
  );
  const documentService = new DocumentService(deps.db, deps.storage);

  // Phase 15 (Review R5): Storno-POST 10/min je Session (Muster portal-chat.ts; Schlüssel =
  // gehashter Sessiontoken, nie der Token selbst; ohne Cookie die IP). Inert ohne Rate-Limit-Plugin.
  const cookieName = portalSessionCookieName(deps.config.appEnv);
  const cancellationLimit = {
    rateLimit: {
      max: PORTAL_CANCELLATION_RATE_LIMIT_PER_MINUTE,
      timeWindow: '1 minute',
      keyGenerator: (request: FastifyRequest) => {
        const token = request.cookies?.[cookieName];
        return typeof token === 'string' && token !== ''
          ? `portal-cancellation|session|${sha256Hex(token).slice(0, 32)}`
          : `portal-cancellation|ip|${request.ip}`;
      },
    },
  };

  /**
   * Session + Buchung des Kunden; `null` ⇒ Antwort bereits gesendet (401/404).
   * Phase 15 (Review R12): `confirmationWindow` (24-h-Bestätigung eines kostenfreien
   * Kundenstornos) NUR für Detailansicht und Storno-POST – alle übrigen Unterrouten ⇒ 404.
   */
  const requireBooking = async (
    request: FastifyRequest,
    reply: FastifyReply,
    now: Date,
    options: { confirmationWindow?: boolean } = {},
  ): Promise<{ customerId: string; visible: VisibleBooking } | null> => {
    const session = await requirePortalSession(request, reply, deps.sessions, deps.config, {
      now,
      touch: false,
    });
    if (session === null) return null;
    // Ungültige IDs sind wie unbekannte IDs: neutrales 404 (kein Existenz-/Format-Orakel).
    const params = bookingParams.safeParse(request.params);
    if (!params.success) {
      sendNotFound(request, reply);
      return null;
    }
    const visible = await bookingService.resolve(session.customerId, params.data.id, now, options);
    if (visible === null) {
      sendNotFound(request, reply);
      return null;
    }
    return { customerId: session.customerId, visible };
  };

  // ── Übersicht (Order §15) ───────────────────────────────────────────────
  app.get('/portal/bookings', async (request, reply) => {
    const now = new Date();
    const session = await requirePortalSession(request, reply, deps.sessions, deps.config, {
      now,
      touch: false,
    });
    if (session === null) return;
    return { bookings: await bookingService.listSummaries(session.customerId, now) };
  });

  // ── Buchungsansicht (Order §16–§22) ─────────────────────────────────────
  app.get('/portal/bookings/:id', async (request, reply) => {
    const now = new Date();
    // Phase 15 (Review R12): einzige GET-Route mit Bestätigungsfenster.
    const resolved = await requireBooking(request, reply, now, { confirmationWindow: true });
    if (resolved === null) return;
    return bookingService.view(resolved.visible, now);
  });

  // ── „Unterwegs“ (Order §21) – leichtgewichtig für Polling ────────────────
  app.get('/portal/bookings/:id/travel-status', async (request, reply) => {
    const now = new Date();
    const resolved = await requireBooking(request, reply, now);
    if (resolved === null) return;
    return { status: await bookingService.travelStatus(resolved.visible, now) };
  });

  // ── Dokumente (Order §23/§24) ───────────────────────────────────────────
  app.get('/portal/bookings/:id/documents', async (request, reply) => {
    const now = new Date();
    const resolved = await requireBooking(request, reply, now);
    if (resolved === null) return;
    const documents = await listPortalDocuments(deps.db, resolved.visible);
    return { documents: documents.map((document) => document.view) };
  });

  app.get('/portal/bookings/:id/documents/:documentId', async (request, reply) => {
    const now = new Date();
    const resolved = await requireBooking(request, reply, now);
    if (resolved === null) return;
    const params = documentParams.safeParse(request.params);
    const document = params.success
      ? await resolvePortalDocument(deps.db, resolved.visible, params.data.documentId)
      : null;
    if (document === null) {
      sendNotFound(request, reply);
      return;
    }
    try {
      const bytes = await documentService.bytesFor(document.row);
      const filename = portalDocumentFilename(
        resolved.visible.process.processNumber,
        document.view.type,
      );
      return reply
        .header('content-type', document.row.mimeType)
        .header('content-disposition', `inline; filename="${filename}"`)
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .send(Buffer.from(bytes));
    } catch (error) {
      if (sendPortalError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Storno (Order §38–§44) ──────────────────────────────────────────────
  app.get('/portal/bookings/:id/cancellation/preview', async (request, reply) => {
    const now = new Date();
    const resolved = await requireBooking(request, reply, now);
    if (resolved === null) return;
    return cancellation.preview(resolved.visible, now);
  });

  app.post(
    '/portal/bookings/:id/cancellation',
    { config: cancellationLimit },
    async (request, reply) => {
      const now = new Date();
      // Phase 15 (Review R12): Wiederholter Klick im Fenster ⇒ idempotente Bestätigungsansicht.
      const resolved = await requireBooking(request, reply, now, { confirmationWindow: true });
      if (resolved === null) return;
      const body = parseOrThrow(cancelBody, request.body);
      try {
        // Phase 15 (Review R2): Bestätigung an die angezeigte Gebühr gebunden.
        await cancellation.cancel(
          resolved.visible,
          { expectedFeeCents: body.expectedFeeCents },
          now,
        );
      } catch (error) {
        if (sendPortalError(request, reply, error)) return;
        throw error;
      }
      // Bestätigungsansicht (Order §44): Zustand cancelled_free/cancelled_fee mit Storno-Block.
      const after = await bookingService.resolve(
        resolved.customerId,
        resolved.visible.booking.id,
        now,
        { confirmationWindow: true }, // Phase 15 (Review R12)
      );
      if (after === null) {
        sendNotFound(request, reply);
        return;
      }
      return bookingService.view(after, now);
    },
  );
}
