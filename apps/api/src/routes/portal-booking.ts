import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { StorageProvider } from '@mietroyal/integrations';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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
import { requirePortalSession, type PortalSessionAuthenticator } from '../portal/guard.ts';
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
/** Der Kunde bestätigt nur – alles andere (Satz, Basis, Gebühr) ist serverseitig (strict ⇒ 400). */
const cancelBody = z.strictObject({ confirm: z.literal(true) });

export const PORTAL_NOT_FOUND_MESSAGE = 'Nicht gefunden.';

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

  /** Session + Buchung des Kunden; `null` ⇒ Antwort bereits gesendet (401/404). */
  const requireBooking = async (
    request: FastifyRequest,
    reply: FastifyReply,
    now: Date,
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
    const visible = await bookingService.resolve(session.customerId, params.data.id, now);
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
    const resolved = await requireBooking(request, reply, now);
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

  app.post('/portal/bookings/:id/cancellation', async (request, reply) => {
    const now = new Date();
    const resolved = await requireBooking(request, reply, now);
    if (resolved === null) return;
    parseOrThrow(cancelBody, request.body);
    try {
      await cancellation.cancel(resolved.visible, now);
    } catch (error) {
      if (sendPortalError(request, reply, error)) return;
      throw error;
    }
    // Bestätigungsansicht (Order §44): Zustand cancelled_free/cancelled_fee mit Storno-Block.
    const after = await bookingService.resolve(
      resolved.customerId,
      resolved.visible.booking.id,
      now,
    );
    if (after === null) {
      sendNotFound(request, reply);
      return;
    }
    return bookingService.view(after, now);
  });
}
