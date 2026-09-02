import type { AppConfig } from '@mietroyal/config';
import { offerDeliveries, type Database } from '@mietroyal/database';
import { parseOrThrow, z } from '@mietroyal/validation';
import { desc } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth, requirePermission, sendAuthError, sendError } from '../auth/http.ts';
import type { AuthenticatedContext, StaffAuthService } from '../auth/service.ts';
import { ProcessService } from '../crm/process-service.ts';
import { buildVisibilityContext } from '../crm/visibility.ts';
import { OrderConfirmationService } from '../commerce/confirmation-service.ts';
import { createOfferDeliveryGateway } from '../commerce/delivery-gateway.ts';
import { DocumentService } from '../commerce/document-service.ts';
import { InquiryService } from '../commerce/inquiry-service.ts';
import { OfferService } from '../commerce/offer-service.ts';
import { ProductService } from '../commerce/product-service.ts';
import { TermsService } from '../commerce/terms-service.ts';
import { SchedulingService } from '../scheduling/scheduling-service.ts';
import {
  getCompletedVisibilityDays,
  getPickupExactAddress,
  getPickupPublicArea,
  PICKUP_EXACT_ADDRESS_KEY,
  PICKUP_PUBLIC_AREA_KEY,
  setStringSetting,
} from '../crm/settings-service.ts';
import type { StorageProvider } from '@mietroyal/integrations';
import { UUID_PATTERN } from './auth.ts';

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const idParams = z.object({ id: uuidSchema });
const tokenParams = z.object({ token: z.string().min(16).max(128) });
const centsSchema = z.number().int().min(0).max(100_000_000);

const productCategorySchema = z.enum(['machine', 'syrup', 'consumable', 'purchase']);
const billingModeSchema = z.enum(['fixed', 'commission', 'included']);

const productCreateSchema = z.object({
  slug: z.string().min(2).max(80),
  name: z.string().min(1).max(200),
  category: productCategorySchema,
  description: z.string().max(2000).optional(),
  saleUnit: z.string().min(1).max(60),
  defaultBillingMode: billingModeSchema.optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  containerCount: z.number().int().min(1).max(100).optional(),
  containerVolumeLiters: z.number().int().min(1).max(1000).optional(),
  weightGrams: z.number().int().min(1).max(10_000_000).optional(),
  carryPersons: z.number().int().min(1).max(10).optional(),
  initialPriceCents: centsSchema,
});

const productUpdateSchema = productCreateSchema
  .omit({ slug: true, category: true, initialPriceCents: true })
  .partial();

const selectionSchema = z.object({
  productId: uuidSchema,
  role: z.enum(['free', 'extra']),
  quantity: z.number().int().min(1).max(1000),
});

const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'muss ein gültiger Zeitpunkt sein');

const inquirySchema = z.object({
  eventDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  eventStart: isoDateTime.nullable().optional(),
  eventEnd: isoDateTime.nullable().optional(),
  guestCount: z.number().int().min(1).max(1_000_000).nullable().optional(),
  occasion: z
    .enum([
      'birthday',
      'wedding',
      'company_event',
      'club',
      'party',
      'school_kindergarten',
      'festival',
      'other',
    ])
    .nullable()
    .optional(),
  machineProductId: uuidSchema.nullable().optional(),
  fulfillment: z.enum(['pickup', 'delivery']).optional(),
  deliveryStreet: z.string().max(200).nullable().optional(),
  deliveryPostalCode: z.string().max(20).nullable().optional(),
  deliveryCity: z.string().max(100).nullable().optional(),
  deliveryWindowFrom: isoDateTime.nullable().optional(),
  deliveryWindowTo: isoDateTime.nullable().optional(),
  collectionWindowFrom: isoDateTime.nullable().optional(),
  collectionWindowTo: isoDateTime.nullable().optional(),
  onsiteContactName: z.string().max(200).nullable().optional(),
  onsiteContactPhone: z.string().max(50).nullable().optional(),
  selections: z.array(selectionSchema).max(50).optional(),
});

const draftSchema = z.object({
  machineProductId: uuidSchema.nullable().optional(),
  machineQuantity: z.number().int().min(1).max(20).optional(),
  fulfillment: z.enum(['pickup', 'delivery']).optional(),
  deliveryStreet: z.string().max(200).nullable().optional(),
  deliveryPostalCode: z.string().max(20).nullable().optional(),
  deliveryCity: z.string().max(100).nullable().optional(),
  deliveryPriceCents: centsSchema.nullable().optional(),
  selections: z.array(selectionSchema).max(50).optional(),
});

const discountSchema = z
  .object({
    type: z.enum(['percent', 'fixed']),
    value: z.number().int().min(1).max(100_000_000),
    reason: z.string().max(500).nullable().optional(),
  })
  .nullable();

interface CommerceRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  storage: StorageProvider;
  rateLimitEnabled: boolean;
}

export function registerCommerceRoutes(app: FastifyInstance, options: CommerceRouteOptions): void {
  const { db, auth, config, storage } = options;
  const productService = new ProductService(db);
  const inquiryService = new InquiryService(db);
  const documentService = new DocumentService(db, storage);
  const gateway = createOfferDeliveryGateway(config, db);
  const offerService = new OfferService(db, config, documentService, gateway);
  const confirmationService = new OrderConfirmationService(db, config, documentService, gateway);
  const termsService = new TermsService(db, config);
  const processService = new ProcessService(db);

  /**
   * Zentrale Vorgangs-Sichtbarkeit (Phase-2-Regel, §45 IDOR) auch für alle
   * vorgangsbezogenen Commerce-Ressourcen: process.view_all + Sichtbarkeits-
   * fenster für Abgeschlossene; unsichtbar = neutrales 404. Gibt false
   * zurück, wenn bereits geantwortet wurde.
   */
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

  /** Sichtbarkeitsprüfung für versions-adressierte Routen (Version → Vorgang). */
  const requireVisibleVersion = async (
    request: FastifyRequest,
    reply: FastifyReply,
    context: AuthenticatedContext,
    versionId: string,
  ): Promise<boolean> => {
    try {
      const processId = await offerService.processIdForVersion(versionId);
      return await requireVisibleProcess(request, reply, context, processId);
    } catch (error) {
      if (sendAuthError(request, reply, error)) return false;
      throw error;
    }
  };

  const publicLimit = (max: number) =>
    options.rateLimitEnabled
      ? {
          rateLimit: {
            max,
            timeWindow: '1 minute',
            keyGenerator: (request: FastifyRequest) => request.ip,
          },
        }
      : false;

  // ── Produkte & Preise (Vorgabe Nr. 38) ─────────────────────────────────

  app.get('/staff/products', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'product.view'))) return;
    const effective = await auth.effectivePermissions(context.user.id);
    const includeInactive = effective.has('product.manage');
    return { products: await productService.listProducts(includeInactive) };
  });

  app.post('/staff/products', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'product.manage'))) return;
    const body = parseOrThrow(productCreateSchema, request.body);
    try {
      const { initialPriceCents, ...input } = body;
      const product = await productService.createProduct(context.user.id, input, initialPriceCents);
      return { product };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.patch('/staff/products/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'product.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(productUpdateSchema, request.body);
    try {
      return { product: await productService.updateProduct(params.id, body) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/products/:id/active', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'product.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(z.object({ active: z.boolean() }), request.body);
    try {
      await productService.setActive(params.id, body.active);
      return { updated: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/products/:id/price', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'price.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(z.object({ priceCents: centsSchema }), request.body);
    try {
      await productService.setCurrentPrice(context.user.id, params.id, body.priceCents);
      return { updated: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/products/:id/future-price', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'price.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(
      z.object({ priceCents: centsSchema, effectiveFrom: isoDateTime }),
      request.body,
    );
    try {
      await productService.planFuturePrice(
        context.user.id,
        params.id,
        body.priceCents,
        new Date(body.effectiveFrom),
      );
      return { created: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.patch('/staff/product-prices/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'price.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(
      z.object({ priceCents: centsSchema.optional(), effectiveFrom: isoDateTime.optional() }),
      request.body,
    );
    try {
      await productService.updateFuturePrice(params.id, {
        priceCents: body.priceCents,
        effectiveFrom: body.effectiveFrom === undefined ? undefined : new Date(body.effectiveFrom),
      });
      return { updated: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.delete('/staff/product-prices/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'price.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      await productService.deleteFuturePrice(params.id);
      return { deleted: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Anfrage (Vorgabe Nr. 10/39) ────────────────────────────────────────

  app.get('/staff/processes/:id/inquiry', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'inquiry.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    if (!(await requireVisibleProcess(request, reply, context, params.id))) return;
    return { inquiry: await inquiryService.getForProcess(params.id) };
  });

  app.put('/staff/processes/:id/inquiry', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    if (!(await requireVisibleProcess(request, reply, context, params.id))) return;
    const existing = await inquiryService.getForProcess(params.id);
    const needed = existing === null ? 'inquiry.create' : 'inquiry.edit';
    if (!(await requirePermission(request, reply, auth, context, needed))) return;
    const body = parseOrThrow(inquirySchema, request.body);
    try {
      const inquiryId = await inquiryService.upsertForProcess(context.user.id, params.id, {
        ...body,
        eventStart:
          body.eventStart === null || body.eventStart === undefined
            ? body.eventStart
            : new Date(body.eventStart),
        eventEnd:
          body.eventEnd === null || body.eventEnd === undefined
            ? body.eventEnd
            : new Date(body.eventEnd),
        deliveryWindowFrom:
          body.deliveryWindowFrom === null || body.deliveryWindowFrom === undefined
            ? body.deliveryWindowFrom
            : new Date(body.deliveryWindowFrom),
        deliveryWindowTo:
          body.deliveryWindowTo === null || body.deliveryWindowTo === undefined
            ? body.deliveryWindowTo
            : new Date(body.deliveryWindowTo),
        collectionWindowFrom:
          body.collectionWindowFrom === null || body.collectionWindowFrom === undefined
            ? body.collectionWindowFrom
            : new Date(body.collectionWindowFrom),
        collectionWindowTo:
          body.collectionWindowTo === null || body.collectionWindowTo === undefined
            ? body.collectionWindowTo
            : new Date(body.collectionWindowTo),
      });
      return { inquiryId };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Angebot (Vorgaben Nr. 20–24/40) ────────────────────────────────────

  app.get('/staff/processes/:id/offer', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'offer.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    if (!(await requireVisibleProcess(request, reply, context, params.id))) return;
    const offer = await offerService.getOfferForProcess(params.id);
    const booking = await offerService.bookingForProcess(params.id);
    const confirmation =
      booking === null ? null : await confirmationService.byBookingId(booking.id);
    return { offer, booking, confirmation };
  });

  app.post('/staff/processes/:id/offer', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'offer.create'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    if (!(await requireVisibleProcess(request, reply, context, params.id))) return;
    try {
      return await offerService.createOffer(context.user.id, params.id);
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.patch('/staff/offer-versions/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'offer.edit_draft'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(draftSchema, request.body);
    // Der manuelle Lieferpreis ist eine Preisänderung am Angebot und
    // verlangt zusätzlich das PERMISSIONS.md-Recht offer.change_price.
    if (body.deliveryPriceCents !== undefined) {
      if (!(await requirePermission(request, reply, auth, context, 'offer.change_price'))) return;
    }
    if (!(await requireVisibleVersion(request, reply, context, params.id))) return;
    try {
      await offerService.updateDraft(context.user.id, params.id, body);
      return { updated: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/offer-versions/:id/discount', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'offer.apply_discount'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(z.object({ discount: discountSchema }), request.body);
    if (!(await requireVisibleVersion(request, reply, context, params.id))) return;
    try {
      const effective = await auth.effectivePermissions(context.user.id);
      await offerService.setDiscount(context.user.id, params.id, effective, body.discount);
      return { updated: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/offer-versions/:id/approve-discount', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'discount.over_20_approve'))) {
      return;
    }
    const params = parseOrThrow(idParams, request.params, 'params');
    if (!(await requireVisibleVersion(request, reply, context, params.id))) return;
    try {
      await offerService.approveDiscount(context.user.id, params.id);
      return { approved: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/offer-versions/:id/special-price', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'offer.apply_special_price'))) {
      return;
    }
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(
      z.object({ lineKey: z.string().min(1).max(120), unitPriceCents: centsSchema.nullable() }),
      request.body,
    );
    if (!(await requireVisibleVersion(request, reply, context, params.id))) return;
    try {
      const effective = await auth.effectivePermissions(context.user.id);
      await offerService.setSpecialPrice(context.user.id, params.id, effective, body);
      return { updated: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/offer-versions/:id/send', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'offer.send'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    if (!(await requireVisibleVersion(request, reply, context, params.id))) return;
    try {
      const effective = await auth.effectivePermissions(context.user.id);
      const result = await offerService.send(context.user.id, params.id, effective);
      return { sent: true, publicPath: `/angebot/${result.token}` };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/offers/:id/new-version', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'offer.create_new_version'))) {
      return;
    }
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(
      z.object({ changeNote: z.string().max(500).nullable().optional() }),
      request.body,
    );
    try {
      const processId = await offerService.processIdForOffer(params.id);
      if (!(await requireVisibleProcess(request, reply, context, processId))) return;
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
    try {
      return await offerService.createNewVersion(
        context.user.id,
        params.id,
        body.changeNote ?? null,
      );
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/offer-versions/:id/decline', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'offer.edit_draft'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    if (!(await requireVisibleVersion(request, reply, context, params.id))) return;
    try {
      await offerService.markDeclined(params.id);
      return { declined: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  /** Entwurf neu aus der Anfrage übernehmen (§40): Maschine/Sirup/Extras. */
  app.post('/staff/offer-versions/:id/sync-from-inquiry', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'offer.edit_draft'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    if (!(await requireVisibleVersion(request, reply, context, params.id))) return;
    try {
      await offerService.syncDraftFromInquiry(context.user.id, params.id);
      return { updated: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.get('/staff/offer-versions/:id/pdf-preview', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'offer.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    if (!(await requireVisibleVersion(request, reply, context, params.id))) return;
    try {
      const bytes = await offerService.renderPreviewPdf(params.id);
      void reply.header('content-type', 'application/pdf');
      void reply.header('content-disposition', 'inline; filename="angebot-vorschau.pdf"');
      return reply.send(bytes);
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Dokumente (Vorgabe Nr. 34/35/37) ───────────────────────────────────

  app.get('/staff/documents/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'offer.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const document = await documentService.byId(params.id);
      if (!(await requireVisibleProcess(request, reply, context, document.processId))) return;
      const bytes = await documentService.bytesFor(document);
      void reply.header('content-type', document.mimeType);
      void reply.header('content-disposition', `inline; filename="dokument-${document.id}.pdf"`);
      return reply.send(Buffer.from(bytes));
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Auftragsbestätigung (Vorgaben Nr. 31/41) ───────────────────────────

  app.get('/staff/processes/:id/confirmation', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'offer.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    if (!(await requireVisibleProcess(request, reply, context, params.id))) return;
    const booking = await offerService.bookingForProcess(params.id);
    if (booking === null) return { booking: null, confirmation: null, blockers: [] };
    const confirmation = await confirmationService.byBookingId(booking.id);
    const blockers =
      confirmation === null ? [] : (await confirmationService.readinessFor(confirmation)).blockers;
    return { booking, confirmation, blockers };
  });

  /** AB-Prüfvorschau als PDF (§41 „ansehen“) – ohne Speicherung/Finalisierung. */
  app.get('/staff/order-confirmations/:id/pdf-preview', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'offer.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const processId = await confirmationService.processIdFor(params.id);
      if (!(await requireVisibleProcess(request, reply, context, processId))) return;
      const bytes = await confirmationService.renderPreviewPdf(params.id);
      void reply.header('content-type', 'application/pdf');
      void reply.header('content-disposition', 'inline; filename="ab-vorschau.pdf"');
      return reply.send(bytes);
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/order-confirmations/:id/approve', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'booking.confirm'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const processId = await confirmationService.processIdFor(params.id);
      if (!(await requireVisibleProcess(request, reply, context, processId))) return;
      await confirmationService.approve(context.user.id, params.id);
      return { approved: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/order-confirmations/:id/send', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'booking.confirm'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const processId = await confirmationService.processIdFor(params.id);
      if (!(await requireVisibleProcess(request, reply, context, processId))) return;
      await confirmationService.send(params.id);
      return { sent: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Einstellungen: Abholung + Mietbedingungen (Nr. 13/27/33) ───────────

  app.get('/staff/settings/pickup', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'system.settings'))) return;
    return {
      publicArea: await getPickupPublicArea(db),
      exactAddress: await getPickupExactAddress(db),
    };
  });

  app.put('/staff/settings/pickup', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'system.settings'))) return;
    const body = parseOrThrow(
      z.object({
        publicArea: z.string().max(200).nullable().optional(),
        exactAddress: z.string().max(500).nullable().optional(),
      }),
      request.body,
    );
    if (body.publicArea !== undefined) {
      await setStringSetting(db, context.user.id, PICKUP_PUBLIC_AREA_KEY, body.publicArea);
    }
    if (body.exactAddress !== undefined) {
      await setStringSetting(db, context.user.id, PICKUP_EXACT_ADDRESS_KEY, body.exactAddress);
    }
    return { updated: true };
  });

  app.get('/staff/terms', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'system.settings'))) return;
    return { terms: await termsService.list() };
  });

  app.post('/staff/terms', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'system.settings'))) return;
    const body = parseOrThrow(
      z.object({
        label: z.string().min(1).max(120),
        content: z.string().min(1).max(100_000),
        isTest: z.boolean(),
      }),
      request.body,
    );
    try {
      return { terms: await termsService.create(body) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  /** Outbox-Einsicht (Dev/Test-Adapter) für Prüfzwecke. */
  app.get('/staff/outbox', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'system.settings'))) return;
    const deliveries = await db
      .select()
      .from(offerDeliveries)
      .orderBy(desc(offerDeliveries.createdAt))
      .limit(50);
    return { deliveries };
  });

  // ── Öffentlicher Angebotszugang (Vorgaben Nr. 25/26/28/29) ─────────────
  // Kein Login; Autorität ist ausschließlich das kryptografische Token
  // (nur als Hash gespeichert). Ungültig/fremd → neutrales 404.

  app.get('/public/offers/:token', { config: publicLimit(60) }, async (request, reply) => {
    const params = parseOrThrow(tokenParams, request.params, 'params');
    const view = await offerService.publicView(params.token);
    if (view === null) {
      sendError(request, reply, 404, 'NOT_FOUND', 'Dieses Angebot ist nicht verfügbar.');
      return;
    }
    return { offer: view };
  });

  app.get('/public/offers/:token/pdf', { config: publicLimit(30) }, async (request, reply) => {
    const params = parseOrThrow(tokenParams, request.params, 'params');
    const documentId = await offerService.publicDocumentId(params.token);
    if (documentId === null) {
      sendError(request, reply, 404, 'NOT_FOUND', 'Dieses Angebot ist nicht verfügbar.');
      return;
    }
    const document = await documentService.byId(documentId);
    const bytes = await documentService.bytesFor(document);
    void reply.header('content-type', document.mimeType);
    void reply.header('content-disposition', 'inline; filename="angebot.pdf"');
    return reply.send(Buffer.from(bytes));
  });

  app.post('/public/offers/:token/accept', { config: publicLimit(10) }, async (request, reply) => {
    const params = parseOrThrow(tokenParams, request.params, 'params');
    try {
      const result = await offerService.accept(params.token);
      // Die verbindliche Annahme löst die operative Terminplanung aus
      // (Phase-4-Order §4) – als Routen-Orchestrierung, damit der
      // OfferService selbst keine Terminlogik kennt. Best effort: schlägt
      // die Terminerzeugung fehl, bleibt die Annahme gültig; der
      // Selbstheilungs-Pass der Heute-/Offen-Ansichten zieht die Termine
      // nach (keine bestätigte Buchung geht verloren, §8).
      try {
        await new SchedulingService(db).ensureAppointmentsForBooking(result.bookingId);
      } catch (schedulingError) {
        request.log.warn(
          { err: schedulingError, bookingId: result.bookingId },
          'Terminerzeugung nach Annahme fehlgeschlagen – Selbstheilung greift beim nächsten Kalenderaufruf.',
        );
      }
      return { accepted: true, bookingId: result.bookingId };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/public/offers/:token/recheck', { config: publicLimit(10) }, async (request, reply) => {
    const params = parseOrThrow(tokenParams, request.params, 'params');
    try {
      await offerService.requestRecheck(params.token);
      return { requested: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });
}
