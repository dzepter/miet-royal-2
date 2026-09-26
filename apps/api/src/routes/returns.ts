import type { AppConfig } from '@mietroyal/config';
import { bookings, type Booking, type Database } from '@mietroyal/database';
import type { StorageProvider } from '@mietroyal/integrations';
import { parseOrThrow, z } from '@mietroyal/validation';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth, requirePermission, sendAuthError, sendError } from '../auth/http.ts';
import { AuthError, type AuthenticatedContext, type StaffAuthService } from '../auth/service.ts';
import { DocumentService } from '../commerce/document-service.ts';
import { ProcessService } from '../crm/process-service.ts';
import { getCompletedVisibilityDays } from '../crm/settings-service.ts';
import { buildVisibilityContext } from '../crm/visibility.ts';
import { AssignmentService } from '../handover/assignment-service.ts';
import { DamageService } from '../returns/damage-service.ts';
import { ReturnService } from '../returns/return-service.ts';
import { SchedulingService } from '../scheduling/scheduling-service.ts';
import { InventoryService } from '../warehouse/inventory-service.ts';
import { MachineService } from '../warehouse/machine-service.ts';
import { UUID_PATTERN } from './auth.ts';

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const bookingParams = z.object({ bookingId: uuidSchema });
const machineParams = z.object({ bookingId: uuidSchema, returnMachineId: uuidSchema });
const idParams = z.object({ id: uuidSchema });
const tokenParams = z.object({ token: z.string().min(1).max(200) });
const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'muss ein gültiger Zeitpunkt sein');

const returnerBody = z.strictObject({
  kind: z.enum(['customer', 'representative', 'other']),
  firstName: z.string().max(100).nullable().optional(),
  lastName: z.string().max(100).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
});
const accessoriesBody = z.strictObject({ complete: z.literal(true) });
const missingBody = z.strictObject({
  accessoryType: z.enum(['lid', 'drip_tray']),
  missingQuantity: z.number().int().min(1).max(10),
  description: z.string().max(500).nullable().optional(),
});
const cleanlinessBody = z.strictObject({
  emptied: z.boolean(),
  rinsedTwice: z.boolean(),
  nothingDismantled: z.boolean(),
});
/** Fotos, die im Rückgabeprotokoll erscheinen: JPEG/PNG (pdfkit-einbettbar). */
const embeddablePhotoBody = z.strictObject({
  mimeType: z.enum(['image/jpeg', 'image/png']),
  dataBase64: z.string().min(1),
});
const anyPhotoBody = z.strictObject({
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  dataBase64: z.string().min(1),
});
const quantityBody = z.strictObject({
  returnedUnopenedQuantity: z.number().int().min(0).max(10_000),
});
const markerSchema = z.strictObject({
  view: z.enum(['front', 'back', 'left', 'right']),
  markerType: z.enum(['point', 'area']),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1).nullable().optional(),
  height: z.number().min(0).max(1).nullable().optional(),
});
/** Kein Betrag, keine Kostenfelder – Schaden ist Dokumentation (Order §27, Test 132). */
const damageBody = z.strictObject({
  severity: z.enum(['light', 'medium', 'severe']),
  description: z.string().min(1).max(2000),
  markers: z.array(markerSchema).min(1).max(20),
});
const postReturnDamageBody = damageBody.extend({ photo: embeddablePhotoBody });
const defectBody = z.strictObject({
  description: z.string().min(1).max(2000),
  occurredAt: isoDateTime.nullable().optional(),
  photo: anyPhotoBody.nullable().optional(),
});
const signatureBody = z.strictObject({ dataBase64: z.string().min(1) });
const signatureParams = z.object({ bookingId: uuidSchema, role: z.enum(['customer', 'staff']) });
const actualTimeBody = z.strictObject({ actualReturnAt: isoDateTime.nullable() });

interface ReturnRouteOptions {
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

export function registerReturnRoutes(app: FastifyInstance, options: ReturnRouteOptions): void {
  const { db, auth, config, storage } = options;
  const machineService = new MachineService(db, storage);
  const assignments = new AssignmentService(db, machineService, storage);
  const inventory = new InventoryService(db);
  const documentService = new DocumentService(db, storage);
  const scheduling = new SchedulingService(db);
  const damages = new DamageService(db, storage);
  const returns = new ReturnService(
    db,
    storage,
    inventory,
    machineService,
    documentService,
    scheduling,
    damages,
    assignments,
  );
  const processService = new ProcessService(db);

  const visibilityFor = async (context: AuthenticatedContext) => {
    const effective = await auth.effectivePermissions(context.user.id);
    return buildVisibilityContext(effective, await getCompletedVisibilityDays(db));
  };

  /** Zentrale Vorgangs-Sichtbarkeit (Phase-2-Regel) – unsichtbar = neutrales 404. */
  const requireVisibleProcess = async (
    request: FastifyRequest,
    reply: FastifyReply,
    context: AuthenticatedContext,
    processId: string,
  ): Promise<boolean> => {
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return false;
    try {
      await processService.getVisibleProcess(processId, await visibilityFor(context));
      return true;
    } catch (error) {
      if (sendAuthError(request, reply, error)) return false;
      throw error;
    }
  };

  /** Buchung laden + Sichtbarkeit prüfen (IDOR-Schutz, Order §§66/122). */
  const visibleBooking = async (
    request: FastifyRequest,
    reply: FastifyReply,
    context: AuthenticatedContext,
    bookingId: string,
  ): Promise<Booking | null> => {
    // Grundrecht VOR dem Laden – kein Existenz-Orakel über 404/403.
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return null;
    const rows = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    const booking = rows[0];
    if (booking === undefined) {
      sendError(request, reply, 404, 'NOT_FOUND', 'Buchung nicht gefunden.');
      return null;
    }
    if (!(await requireVisibleProcess(request, reply, context, booking.processId))) return null;
    return booking;
  };

  const withDetail = async (bookingId: string) => ({
    detail: await returns.detail(bookingId),
    documents: await returns.documentsFor(bookingId),
  });

  // ── Rückgabe-Ansicht / Einstieg (Order §§5/6) ────────────────────────────

  app.get('/staff/returns', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'return.view'))) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return;
    return { entries: await returns.listOpen(await visibilityFor(context)) };
  });

  app.get('/staff/returns/resolve-qr/:token', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    // QR umgeht keine Rechte (Order §6/§130): Rückgabe-Recht UND Sichtbarkeit.
    if (!(await requirePermission(request, reply, auth, context, 'return.view'))) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return;
    const params = parseOrThrow(tokenParams, request.params, 'params');
    try {
      const resolved = await returns.resolveQr(params.token);
      if (!(await requireVisibleProcess(request, reply, context, resolved.processId))) return;
      return resolved;
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.get('/staff/processes/:id/return', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'return.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    if (!(await requireVisibleProcess(request, reply, context, params.id))) return;
    const rows = await db.select().from(bookings).where(eq(bookings.processId, params.id));
    const booking = rows[0];
    if (booking === undefined) return { detail: null, canStart: false, documents: [] };
    const existing = await returns.returnFor(booking.id);
    if (existing === null) {
      return {
        detail: null,
        bookingId: booking.id,
        canStart: await returns.hasIssuedMachines(booking.id),
        documents: [],
      };
    }
    return { ...(await withDetail(booking.id)), bookingId: booking.id, canStart: true };
  });

  app.post('/staff/returns/:bookingId/start', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'return.perform'))) return;
    const params = parseOrThrow(bookingParams, request.params, 'params');
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      await returns.start(context.user.id, booking.id);
      return await withDetail(booking.id);
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.get('/staff/returns/:bookingId', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'return.view'))) return;
    const params = parseOrThrow(bookingParams, request.params, 'params');
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      return await withDetail(booking.id);
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Bearbeitung des Entwurfs (return.perform) ────────────────────────────

  const performRoute = <T>(
    path: string,
    schema: z.ZodType<T>,
    handler: (
      context: AuthenticatedContext,
      params: { bookingId: string; returnMachineId?: string },
      body: T,
    ) => Promise<unknown>,
    permission: string = 'return.perform',
    bodyLimit?: number,
  ) => {
    app.post(path, bodyLimit === undefined ? {} : { bodyLimit }, async (request, reply) => {
      const context = await requireAuth(request, reply, auth, config);
      if (context === null) return;
      if (!(await requirePermission(request, reply, auth, context, permission))) return;
      const params = parseOrThrow(
        path.includes(':returnMachineId') ? machineParams : bookingParams,
        request.params,
        'params',
      ) as { bookingId: string; returnMachineId?: string };
      const body = parseOrThrow(schema, request.body ?? {});
      const booking = await visibleBooking(request, reply, context, params.bookingId);
      if (booking === null) return;
      try {
        return await handler(context, params, body);
      } catch (error) {
        if (sendAuthError(request, reply, error)) return;
        throw error;
      }
    });
  };

  app.put('/staff/returns/:bookingId/returner', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'return.perform'))) return;
    const params = parseOrThrow(bookingParams, request.params, 'params');
    const body = parseOrThrow(returnerBody, request.body);
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      await returns.setReturner(context.user.id, booking.id, body);
      return await withDetail(booking.id);
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  performRoute(
    '/staff/returns/:bookingId/machines/:returnMachineId/accessories',
    accessoriesBody,
    async (context, params) => {
      await returns.confirmAccessoriesComplete(
        context.user.id,
        params.bookingId,
        params.returnMachineId!,
      );
      return withDetail(params.bookingId);
    },
  );

  performRoute(
    '/staff/returns/:bookingId/machines/:returnMachineId/missing',
    missingBody,
    async (context, params, body) => {
      await returns.addMissingCase(
        context.user.id,
        params.bookingId,
        params.returnMachineId!,
        body,
      );
      return withDetail(params.bookingId);
    },
    'missing_item.create',
  );

  app.delete('/staff/returns/:bookingId/missing/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'missing_item.create'))) return;
    const params = parseOrThrow(
      z.object({ bookingId: uuidSchema, id: uuidSchema }),
      request.params,
      'params',
    );
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      await returns.deleteMissingCase(context.user.id, booking.id, params.id);
      return await withDetail(booking.id);
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  performRoute(
    '/staff/returns/:bookingId/machines/:returnMachineId/cleanliness',
    cleanlinessBody,
    async (context, params, body) => {
      const effective = await auth.effectivePermissions(context.user.id);
      await returns.checkCleanliness(
        context.user.id,
        effective,
        params.bookingId,
        params.returnMachineId!,
        body,
      );
      return withDetail(params.bookingId);
    },
  );

  performRoute(
    '/staff/returns/:bookingId/machines/:returnMachineId/photos',
    embeddablePhotoBody,
    async (context, params, body) => {
      const bytes = decodeBase64(body.dataBase64, 6 * 1024 * 1024);
      if (bytes === null) {
        throw new AuthError('VALIDATION', 'Das Foto muss zwischen 1 Byte und 6 MB groß sein.');
      }
      await returns.addCleanupPhoto(context.user.id, params.bookingId, params.returnMachineId!, {
        bytes,
        mimeType: body.mimeType,
      });
      return withDetail(params.bookingId);
    },
    'return.perform',
    9 * 1024 * 1024,
  );

  app.get('/staff/returns/photos/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'return.view'))) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      // Erst Sichtbarkeit (Metadaten), dann Storage-Zugriff (Order §§33/61).
      const meta = await returns.photoMeta(params.id);
      if (!(await requireVisibleProcess(request, reply, context, meta.processId))) return;
      const photo = await returns.photoBytes(params.id);
      void reply.header('content-type', photo.mimeType);
      void reply.header('cache-control', 'private, no-store');
      return reply.send(Buffer.from(photo.bytes));
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.patch('/staff/returns/:bookingId/items/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'return.perform'))) return;
    const params = parseOrThrow(
      z.object({ bookingId: uuidSchema, id: uuidSchema }),
      request.params,
      'params',
    );
    const body = parseOrThrow(quantityBody, request.body);
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      await returns.setReturnedQuantity(
        context.user.id,
        booking.id,
        params.id,
        body.returnedUnopenedQuantity,
      );
      return await withDetail(booking.id);
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Schäden (damage.document) ────────────────────────────────────────────

  performRoute(
    '/staff/returns/:bookingId/machines/:returnMachineId/damages',
    damageBody,
    async (context, params, body) => {
      const created = await returns.addDamage(
        context.user.id,
        params.bookingId,
        params.returnMachineId!,
        body,
      );
      return { ...created, ...(await withDetail(params.bookingId)) };
    },
    'damage.document',
  );

  app.delete('/staff/returns/:bookingId/damages/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'damage.document'))) return;
    const params = parseOrThrow(
      z.object({ bookingId: uuidSchema, id: uuidSchema }),
      request.params,
      'params',
    );
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      await returns.deleteDamage(context.user.id, booking.id, params.id);
      return await withDetail(booking.id);
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  /** Sichtbarkeit eines Schadens: über den Rückgabe-Vorgang (falls vorhanden) – sonst Maschinenrecht. */
  const damageVisible = async (
    request: FastifyRequest,
    reply: FastifyReply,
    context: AuthenticatedContext,
    damageId: string,
  ): Promise<boolean> => {
    // Grundrecht VOR dem Laden – kein Existenz-Orakel über 404/403.
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return false;
    const damage = await damages.byId(damageId);
    if (damage.returnId === null) return true;
    const ret = await returns.returnById(damage.returnId);
    return requireVisibleProcess(request, reply, context, ret.processId);
  };

  app.post('/staff/damages/:id/photos', { bodyLimit: 9 * 1024 * 1024 }, async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'damage.document'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(embeddablePhotoBody, request.body);
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
      if (!(await damageVisible(request, reply, context, params.id))) return;
      return await damages.addPhoto(context.user.id, params.id, { bytes, mimeType: body.mimeType });
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.get('/staff/damages/photos/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    // Interne Beweisfotos: Maschinen- ODER Rückgabe-Recht, nie öffentlich.
    const effective = await auth.effectivePermissions(context.user.id);
    if (!effective.has('machine.view') && !effective.has('return.view')) {
      if (!(await requirePermission(request, reply, auth, context, 'return.view'))) return;
    }
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const meta = await damages.photoMeta(params.id);
      if (meta.returnId !== null) {
        const ret = await returns.returnById(meta.returnId);
        if (!(await requireVisibleProcess(request, reply, context, ret.processId))) return;
      }
      const photo = await damages.photoBytes(params.id);
      void reply.header('content-type', photo.mimeType);
      void reply.header('cache-control', 'private, no-store');
      return reply.send(Buffer.from(photo.bytes));
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/damages/:id/resolve', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'damage.resolve_current'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      if (!(await damageVisible(request, reply, context, params.id))) return;
      await damages.resolveCurrent(context.user.id, params.id);
      return { resolved: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Maschinenbezogen: Zustand, Nachtrag, Defekt, Reinigung ──────────────

  app.get('/staff/machines/:id/condition', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const effective = await auth.effectivePermissions(context.user.id);
      // Vorgangsbezogene Einträge (Fehlteile, Defekte) nur mit process.view_all
      // und innerhalb der zentralen Sichtbarkeitsregel (Phase 2).
      const condition = await returns.machineCondition(
        params.id,
        new Date(),
        effective.has('process.view_all') ? await visibilityFor(context) : null,
      );
      // Wer gereinigt hat: nur administrative Sicht (Order §52) – Mitarbeiterverwaltung als Maßstab.
      const adminView = effective.has('employee.manage');
      return {
        ...condition,
        cleaning: {
          ...condition.cleaning,
          cleanedAt: adminView ? condition.cleaning.cleanedAt : null,
          cleanedBy: adminView ? condition.cleaning.cleanedBy : null,
        },
      };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post(
    '/staff/machines/:id/damages',
    { bodyLimit: 9 * 1024 * 1024 },
    async (request, reply) => {
      const context = await requireAuth(request, reply, auth, config);
      if (context === null) return;
      if (!(await requirePermission(request, reply, auth, context, 'damage.document'))) return;
      if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return;
      const params = parseOrThrow(idParams, request.params, 'params');
      const body = parseOrThrow(postReturnDamageBody, request.body);
      // Der Nachtrag hängt am letzten Rückgabevorgang der Maschine – dessen
      // Sichtbarkeit wird VOR dem Schreiben geprüft (Phase-2-Regel, neutral).
      const target = await damages.postReturnTarget(params.id);
      if (
        target !== null &&
        !(await requireVisibleProcess(request, reply, context, target.processId))
      )
        return;
      const bytes = decodeBase64(body.photo.dataBase64, 6 * 1024 * 1024);
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
        return await damages.createPostReturnFinding(context.user.id, params.id, {
          severity: body.severity,
          description: body.description,
          markers: body.markers,
          photo: { bytes, mimeType: body.photo.mimeType },
        });
      } catch (error) {
        if (sendAuthError(request, reply, error)) return;
        throw error;
      }
    },
  );

  app.post(
    '/staff/machines/:id/technical-defects',
    { bodyLimit: 9 * 1024 * 1024 },
    async (request, reply) => {
      const context = await requireAuth(request, reply, auth, config);
      if (context === null) return;
      if (!(await requirePermission(request, reply, auth, context, 'machine.change_status')))
        return;
      if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return;
      const params = parseOrThrow(idParams, request.params, 'params');
      const body = parseOrThrow(defectBody, request.body);
      // Der Defekt wird intern mit dem letzten Rückgabevorgang verknüpft – Sichtbarkeit vor dem Schreiben.
      const target = await damages.postReturnTarget(params.id);
      if (
        target !== null &&
        !(await requireVisibleProcess(request, reply, context, target.processId))
      )
        return;
      let photo: { bytes: Uint8Array; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' } | null =
        null;
      if (body.photo !== null && body.photo !== undefined) {
        const bytes = decodeBase64(body.photo.dataBase64, 6 * 1024 * 1024);
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
        photo = { bytes, mimeType: body.photo.mimeType };
      }
      try {
        return await damages.addTechnicalDefect(context.user.id, params.id, {
          description: body.description,
          occurredAt:
            body.occurredAt === null || body.occurredAt === undefined
              ? null
              : new Date(body.occurredAt),
          photo,
        });
      } catch (error) {
        if (sendAuthError(request, reply, error)) return;
        throw error;
      }
    },
  );

  app.get('/staff/technical-defects/:id/photo', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.view'))) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const photo = await damages.technicalDefectPhoto(params.id);
      void reply.header('content-type', photo.mimeType);
      void reply.header('cache-control', 'private, no-store');
      return reply.send(Buffer.from(photo.bytes));
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/machines/:id/clean-complete', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.clean_complete'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const machine = await returns.completeCleaning(context.user.id, params.id);
      return { machine: { id: machine.id, status: machine.status } };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.get('/staff/cleaning-warnings', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.view'))) return;
    return { warnings: await returns.cleaningWarnings() };
  });

  // ── Fehlteil-Follow-ups (Order §55) ──────────────────────────────────────

  app.get('/staff/missing-items', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'return.view'))) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return;
    return { cases: await returns.openMissingCases(undefined, await visibilityFor(context)) };
  });

  app.post('/staff/missing-items/:id/resolve', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'missing_item.resolve'))) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const existing = await returns.missingCaseById(params.id);
      if (!(await requireVisibleProcess(request, reply, context, existing.processId))) return;
      return { case: await returns.resolveMissingCase(context.user.id, params.id) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Unterschriften / Zeit / Finalisierung ────────────────────────────────

  app.put(
    '/staff/returns/:bookingId/signatures/:role',
    { bodyLimit: 4 * 1024 * 1024 },
    async (request, reply) => {
      const context = await requireAuth(request, reply, auth, config);
      if (context === null) return;
      if (!(await requirePermission(request, reply, auth, context, 'return.perform'))) return;
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
        // Der Unterzeichner-Mitarbeiter ist IMMER die Session (Order §43/§134).
        await returns.sign(context.user.id, booking.id, params.role, bytes);
        return { signed: true };
      } catch (error) {
        if (sendAuthError(request, reply, error)) return;
        throw error;
      }
    },
  );

  app.get('/staff/returns/:bookingId/signatures/:role', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'return.view'))) return;
    const params = parseOrThrow(signatureParams, request.params, 'params');
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      const bytes = await returns.signatureBytes(booking.id, params.role);
      void reply.header('content-type', 'image/png');
      void reply.header('cache-control', 'private, no-store');
      return reply.send(Buffer.from(bytes));
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.put('/staff/returns/:bookingId/actual-return-time', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'return.correct_actual_time')))
      return;
    const params = parseOrThrow(bookingParams, request.params, 'params');
    const body = parseOrThrow(actualTimeBody, request.body);
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      const existing = await returns.returnFor(booking.id);
      if (existing === null) {
        sendError(request, reply, 404, 'NOT_FOUND', 'Rückgabe nicht gefunden.');
        return;
      }
      if (existing.status === 'finalized') {
        if (body.actualReturnAt === null) {
          sendError(
            request,
            reply,
            400,
            'VALIDATION',
            'Nach dem Abschluss ist eine konkrete Korrekturzeit erforderlich.',
          );
          return;
        }
        await returns.correctActualReturnAt(
          context.user.id,
          booking.id,
          new Date(body.actualReturnAt),
        );
      } else {
        await returns.setDraftActualReturnAt(
          context.user.id,
          booking.id,
          body.actualReturnAt === null ? null : new Date(body.actualReturnAt),
        );
      }
      return await withDetail(booking.id);
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/returns/:bookingId/finalize', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'return.complete'))) return;
    const params = parseOrThrow(bookingParams, request.params, 'params');
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      const detail = await returns.finalize(context.user.id, booking.id);
      return { detail, documents: await returns.documentsFor(booking.id) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });
}
