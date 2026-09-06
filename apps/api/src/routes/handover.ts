import type { AppConfig } from '@mietroyal/config';
import { bookings, type Booking, type Database } from '@mietroyal/database';
import type { StorageProvider } from '@mietroyal/integrations';
import { parseOrThrow, z } from '@mietroyal/validation';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth, requirePermission, sendAuthError, sendError } from '../auth/http.ts';
import type { AuthenticatedContext, StaffAuthService } from '../auth/service.ts';
import { DocumentService } from '../commerce/document-service.ts';
import { ProductService } from '../commerce/product-service.ts';
import { ProcessService } from '../crm/process-service.ts';
import { getCompletedVisibilityDays } from '../crm/settings-service.ts';
import { buildVisibilityContext } from '../crm/visibility.ts';
import { AssignmentService } from '../handover/assignment-service.ts';
import { HandoverService } from '../handover/handover-service.ts';
import { SchedulingService } from '../scheduling/scheduling-service.ts';
import { InventoryService } from '../warehouse/inventory-service.ts';
import { MachineService } from '../warehouse/machine-service.ts';
import { UUID_PATTERN } from './auth.ts';

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const bookingParams = z.object({ bookingId: uuidSchema });
const slotParams = z.object({ bookingId: uuidSchema, assignmentId: uuidSchema });
const idParams = z.object({ id: uuidSchema });
const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'muss ein gültiger Zeitpunkt sein');

const assignBody = z.strictObject({
  machineId: uuidSchema,
  override: z
    .strictObject({
      confirmed: z.literal(true),
      reason: z.string().min(1).max(500),
    })
    .optional(),
});
const quantityBody = z.strictObject({ actualQuantity: z.number().int().min(0).max(10_000) });
const additionBody = z.strictObject({
  productId: uuidSchema,
  quantity: z.number().int().min(1).max(1_000),
});
const representativeBody = z.strictObject({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  phone: z.string().max(40).nullable().optional(),
});
const recipientBody = z.strictObject({
  kind: z.enum(['customer', 'representative', 'other']),
  name: z.string().max(200).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
});
const photoBody = z.strictObject({
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  dataBase64: z.string().min(1),
});
const signatureBody = z.strictObject({ dataBase64: z.string().min(1) });
const signatureParams = z.object({ bookingId: uuidSchema, role: z.enum(['customer', 'staff']) });
const finalizeBody = z.strictObject({ actualIssueAt: isoDateTime.nullable().optional() });
const dayQuery = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
const evaluateQuery = z.object({ machineId: uuidSchema });

interface HandoverRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  storage: StorageProvider;
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

export function registerHandoverRoutes(app: FastifyInstance, options: HandoverRouteOptions): void {
  const { db, auth, config, storage } = options;
  const machineService = new MachineService(db, storage);
  const assignments = new AssignmentService(db, machineService, storage);
  const inventory = new InventoryService(db);
  const documentService = new DocumentService(db, storage);
  const productService = new ProductService(db);
  const scheduling = new SchedulingService(db);
  const handover = new HandoverService(
    db,
    storage,
    assignments,
    inventory,
    machineService,
    documentService,
    productService,
    scheduling,
  );
  const processService = new ProcessService(db);

  /** Zentrale Vorgangs-Sichtbarkeit (Phase-2-Regel) – unsichtbar = neutrales 404. */
  const requireVisibleProcess = async (
    request: FastifyRequest,
    reply: FastifyReply,
    context: AuthenticatedContext,
    processId: string,
  ): Promise<boolean> => {
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return false;
    const effective = await auth.effectivePermissions(context.user.id);
    const visibility = buildVisibilityContext(effective, await getCompletedVisibilityDays(db));
    try {
      await processService.getVisibleProcess(processId, visibility);
      return true;
    } catch (error) {
      if (sendAuthError(request, reply, error)) return false;
      throw error;
    }
  };

  /** Buchung laden + Sichtbarkeit des Vorgangs prüfen (IDOR-Schutz, Order §57/§88). */
  const visibleBooking = async (
    request: FastifyRequest,
    reply: FastifyReply,
    context: AuthenticatedContext,
    bookingId: string,
  ): Promise<Booking | null> => {
    const rows = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    const booking = rows[0];
    if (booking === undefined) {
      sendError(request, reply, 404, 'NOT_FOUND', 'Buchung nicht gefunden.');
      return null;
    }
    if (!(await requireVisibleProcess(request, reply, context, booking.processId))) return null;
    return booking;
  };

  /** Slot muss zur Buchung gehören (keine fremden Zuordnungen über die URL). */
  const slotOfBooking = async (
    request: FastifyRequest,
    reply: FastifyReply,
    bookingId: string,
    assignmentId: string,
  ): Promise<boolean> => {
    try {
      const assignment = await assignments.assignmentById(assignmentId);
      if (assignment.bookingId !== bookingId) {
        sendError(request, reply, 404, 'NOT_FOUND', 'Zuordnung nicht gefunden.');
        return false;
      }
      return true;
    } catch (error) {
      if (sendAuthError(request, reply, error)) return false;
      throw error;
    }
  };

  // ── Ausgabe-Ansicht (Order §12) ─────────────────────────────────────────

  app.get('/staff/handover/day', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'handover.view'))) return;
    // Listen unterliegen der Phase-2-Sichtbarkeitsregel (Order §57).
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return;
    const query = parseOrThrow(dayQuery, request.query, 'query');
    const day = query.date ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
    const effective = await auth.effectivePermissions(context.user.id);
    const visibility = buildVisibilityContext(effective, await getCompletedVisibilityDays(db));
    return { date: day, entries: await handover.listForDay(day, visibility) };
  });

  // ── Übergabe-Detail (Order §§10/55) ─────────────────────────────────────

  app.get('/staff/processes/:id/handover', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'handover.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    if (!(await requireVisibleProcess(request, reply, context, params.id))) return;
    const booking = await handover.bookingForProcess(params.id);
    if (booking === null) return { detail: null };
    try {
      return { detail: await handover.detail(booking.id) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.get('/staff/handover/:bookingId', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'handover.view'))) return;
    const params = parseOrThrow(bookingParams, request.params, 'params');
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      return {
        detail: await handover.detail(booking.id),
        documents: await handover.documentsFor(booking.id),
      };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Zuweisung (Order §§5–8) ─────────────────────────────────────────────

  app.get('/staff/handover/:bookingId/slots/:assignmentId/suggestion', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.assign'))) return;
    const params = parseOrThrow(slotParams, request.params, 'params');
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    if (!(await slotOfBooking(request, reply, params.bookingId, params.assignmentId))) return;
    try {
      return await assignments.suggestionForSlot(params.assignmentId);
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.get('/staff/handover/:bookingId/slots/:assignmentId/evaluate', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.assign'))) return;
    const params = parseOrThrow(slotParams, request.params, 'params');
    const query = parseOrThrow(evaluateQuery, request.query, 'query');
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    if (!(await slotOfBooking(request, reply, params.bookingId, params.assignmentId))) return;
    try {
      const assignment = await assignments.assignmentById(params.assignmentId);
      const interval = await assignments.rentalIntervalFor(params.bookingId);
      const evaluation = await assignments.evaluateMachine(query.machineId, {
        ...assignment,
        rentalFrom: interval.from,
        rentalTo: interval.to,
      });
      return {
        machineId: evaluation.machineId,
        machineCode: evaluation.machineCode,
        productMatches: evaluation.productMatches,
        problems: evaluation.problems,
        hardBlocked: evaluation.hardBlocked,
        overrideRequired: evaluation.overrideRequired,
      };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/handover/:bookingId/slots/:assignmentId/assign', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.assign'))) return;
    const params = parseOrThrow(slotParams, request.params, 'params');
    const body = parseOrThrow(assignBody, request.body);
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    if (!(await slotOfBooking(request, reply, params.bookingId, params.assignmentId))) return;
    try {
      const effective = await auth.effectivePermissions(context.user.id);
      const slot = await assignments.assign(
        context.user.id,
        effective,
        params.assignmentId,
        body.machineId,
        body.override === undefined ? null : { reason: body.override.reason },
      );
      return { slot };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/handover/:bookingId/slots/:assignmentId/release', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.assign'))) return;
    const params = parseOrThrow(slotParams, request.params, 'params');
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    if (!(await slotOfBooking(request, reply, params.bookingId, params.assignmentId))) return;
    try {
      return { slot: await assignments.release(context.user.id, params.assignmentId) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  for (const action of ['prepare', 'unprepare'] as const) {
    app.post(`/staff/handover/:bookingId/slots/:assignmentId/${action}`, async (request, reply) => {
      const context = await requireAuth(request, reply, auth, config);
      if (context === null) return;
      if (!(await requirePermission(request, reply, auth, context, 'handover.prepare'))) return;
      const params = parseOrThrow(slotParams, request.params, 'params');
      const booking = await visibleBooking(request, reply, context, params.bookingId);
      if (booking === null) return;
      if (!(await slotOfBooking(request, reply, params.bookingId, params.assignmentId))) return;
      try {
        const slot =
          action === 'prepare'
            ? await assignments.prepare(context.user.id, params.assignmentId)
            : await assignments.unprepare(context.user.id, params.assignmentId);
        return { slot };
      } catch (error) {
        if (sendAuthError(request, reply, error)) return;
        throw error;
      }
    });
  }

  // ── Lieferschein-Entwurf (Order §§18–20) ────────────────────────────────

  app.patch('/staff/handover/:bookingId/items/:itemId', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'delivery_note.edit'))) return;
    const params = parseOrThrow(
      z.object({ bookingId: uuidSchema, itemId: uuidSchema }),
      request.params,
      'params',
    );
    const body = parseOrThrow(quantityBody, request.body);
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      await handover.updateItemQuantity(booking.id, params.itemId, body.actualQuantity);
      return { updated: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/handover/:bookingId/additions', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'delivery_note.edit'))) return;
    const params = parseOrThrow(bookingParams, request.params, 'params');
    const body = parseOrThrow(additionBody, request.body);
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      return await handover.addAddition(context.user.id, booking.id, body.productId, body.quantity);
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  /** Auswahl für Zusatzpositionen (Order §20): nur aktive Verbrauchs-/Kaufartikel. */
  app.get('/staff/handover-addition-products', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'delivery_note.edit'))) return;
    const rows = await productService.listProducts(false);
    return {
      products: rows
        .filter((product) => product.category !== 'machine')
        .map((product) => ({
          id: product.id,
          name: product.name,
          category: product.category,
          saleUnit: product.saleUnit,
        })),
    };
  });

  app.get('/staff/handover/:bookingId/delivery-note/preview', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'handover.view'))) return;
    const params = parseOrThrow(bookingParams, request.params, 'params');
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      const bytes = await handover.renderDeliveryNotePreview(booking.id);
      void reply.header('content-type', 'application/pdf');
      void reply.header('content-disposition', 'inline; filename="lieferschein-entwurf.pdf"');
      void reply.header('cache-control', 'private, no-store');
      return reply.send(bytes);
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Abholperson / Empfänger (Order §§29–32) ─────────────────────────────

  app.put('/staff/handover/:bookingId/representative', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'handover.prepare'))) return;
    const params = parseOrThrow(bookingParams, request.params, 'params');
    const body = parseOrThrow(representativeBody, request.body);
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      await handover.setRepresentative(context.user.id, booking.id, {
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone ?? null,
      });
      return { saved: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.delete('/staff/handover/:bookingId/representative', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'handover.prepare'))) return;
    const params = parseOrThrow(bookingParams, request.params, 'params');
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      await handover.clearRepresentative(booking.id);
      return { removed: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.put('/staff/handover/:bookingId/recipient', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'handover.perform'))) return;
    const params = parseOrThrow(bookingParams, request.params, 'params');
    const body = parseOrThrow(recipientBody, request.body);
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      await handover.setRecipient(booking.id, {
        kind: body.kind,
        name: body.name ?? null,
        phone: body.phone ?? null,
      });
      return { saved: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Prüfung / Fotos (Order §§25/27) ─────────────────────────────────────

  app.post('/staff/handover/:bookingId/machines/:assignmentId/check', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'handover.perform'))) return;
    const params = parseOrThrow(slotParams, request.params, 'params');
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      await handover.checkMachine(context.user.id, booking.id, params.assignmentId);
      return { checked: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post(
    '/staff/handover/:bookingId/machines/:assignmentId/photos',
    { bodyLimit: 9 * 1024 * 1024 },
    async (request, reply) => {
      const context = await requireAuth(request, reply, auth, config);
      if (context === null) return;
      if (!(await requirePermission(request, reply, auth, context, 'handover.perform'))) return;
      const params = parseOrThrow(slotParams, request.params, 'params');
      const body = parseOrThrow(photoBody, request.body);
      const booking = await visibleBooking(request, reply, context, params.bookingId);
      if (booking === null) return;
      const bytes = decodeBase64(body.dataBase64, 6 * 1024 * 1024);
      if (bytes === null) {
        sendError(
          request,
          reply,
          400,
          'VALIDATION',
          'Das Foto muss zwischen 1 Byte und 6 MB groß sein.',
        );
        return;
      }
      try {
        return await handover.addPhoto(context.user.id, booking.id, params.assignmentId, {
          bytes,
          mimeType: body.mimeType,
        });
      } catch (error) {
        if (sendAuthError(request, reply, error)) return;
        throw error;
      }
    },
  );

  app.get('/staff/handover/photos/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'handover.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      // Erst Sichtbarkeit (Metadaten), dann Storage-Zugriff.
      const meta = await handover.photoMeta(params.id);
      if (!(await requireVisibleProcess(request, reply, context, meta.processId))) return;
      const photo = await handover.photoBytes(params.id);
      void reply.header('content-type', photo.mimeType);
      void reply.header('cache-control', 'private, no-store');
      return reply.send(Buffer.from(photo.bytes));
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Unterschriften (Order §§33–35) ──────────────────────────────────────

  app.put(
    '/staff/handover/:bookingId/signatures/:role',
    { bodyLimit: 4 * 1024 * 1024 },
    async (request, reply) => {
      const context = await requireAuth(request, reply, auth, config);
      if (context === null) return;
      if (!(await requirePermission(request, reply, auth, context, 'handover.perform'))) return;
      const params = parseOrThrow(signatureParams, request.params, 'params');
      const body = parseOrThrow(signatureBody, request.body);
      const booking = await visibleBooking(request, reply, context, params.bookingId);
      if (booking === null) return;
      const bytes = decodeBase64(body.dataBase64, 2 * 1024 * 1024);
      if (bytes === null) {
        sendError(
          request,
          reply,
          400,
          'VALIDATION',
          'Die Unterschrift konnte nicht gelesen werden.',
        );
        return;
      }
      try {
        // Der Unterzeichner-Mitarbeiter ist IMMER die Session (Order §34).
        await handover.sign(context.user.id, booking.id, params.role, bytes);
        return { signed: true };
      } catch (error) {
        if (sendAuthError(request, reply, error)) return;
        throw error;
      }
    },
  );

  app.get('/staff/handover/:bookingId/signatures/:role', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'handover.view'))) return;
    const params = parseOrThrow(signatureParams, request.params, 'params');
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      const bytes = await handover.signatureBytes(booking.id, params.role);
      void reply.header('content-type', 'image/png');
      void reply.header('cache-control', 'private, no-store');
      return reply.send(Buffer.from(bytes));
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Finalisierung (Order §40) ───────────────────────────────────────────

  app.post('/staff/handover/:bookingId/finalize', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'handover.perform'))) return;
    const params = parseOrThrow(bookingParams, request.params, 'params');
    const body = parseOrThrow(finalizeBody, request.body ?? {});
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    if (
      body.actualIssueAt !== null &&
      body.actualIssueAt !== undefined &&
      !(await requirePermission(request, reply, auth, context, 'handover.correct_actual_time'))
    )
      return;
    try {
      const detail = await handover.finalize(context.user.id, booking.id, {
        actualIssueAt:
          body.actualIssueAt === null || body.actualIssueAt === undefined
            ? null
            : new Date(body.actualIssueAt),
      });
      return { detail, documents: await handover.documentsFor(booking.id) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.get('/staff/processes/:id/delivery-packets', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'handover.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    if (!(await requireVisibleProcess(request, reply, context, params.id))) return;
    return { packets: await handover.listPackets(params.id) };
  });

  // ── Overrides / Risiko-Incidents (Order §§9, 45–48) ─────────────────────

  app.get('/staff/machine-overrides', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.override_block'))) return;
    return { overrides: await assignments.listOverrides() };
  });

  app.get('/staff/machine-risk-incidents', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.view'))) return;
    return { incidents: await assignments.listOpenIncidents() };
  });

  app.post('/staff/machine-risk-incidents/:id/acknowledge', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.block'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      await assignments.acknowledgeIncident(context.user.id, params.id);
      return { acknowledged: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });
}
