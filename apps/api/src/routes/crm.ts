import type { AppConfig } from '@mietroyal/config';
import { vouchers as vouchersTable, type Database } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import type { PermissionKey } from '@mietroyal/permissions';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance } from 'fastify';
import type { JobQueue } from '@mietroyal/integrations';
import { requireAuth, requirePermission, sendAuthError } from '../auth/http.ts';
import { AuthError, type StaffAuthService } from '../auth/service.ts';
import { enqueueVoucherDelivery } from '../communication/voucher-delivery-job.ts';
import {
  loadCancellationSummary,
  loadProcessRelations,
  type CancellationService,
} from '../cancellation/cancellation-service.ts';
import { CustomerService } from '../crm/customer-service.ts';
import { isValidIsoDate } from '../crm/normalize.ts';
import { ProcessService, type ProcessCompletionListener } from '../crm/process-service.ts';
import { SearchService } from '../crm/search-service.ts';
import { getCompletedVisibilityDays, setCompletedVisibilityDays } from '../crm/settings-service.ts';
import { buildVisibilityContext } from '../crm/visibility.ts';
import { voucherSendNowState, type VoucherSendNowBlock } from '../voucher/voucher-delivery.ts';
import type { VoucherService } from '../voucher/voucher-service.ts';
import { UUID_PATTERN } from './auth.ts';
import { sendCancellationError } from './cancellation.ts';

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const idParams = z.object({ id: uuidSchema });
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'muss ein Datum (JJJJ-MM-TT) sein')
  .refine(isValidIsoDate, 'muss ein existierendes Kalenderdatum sein');

const customerInputSchema = z.object({
  type: z.enum(['private', 'organization']),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  organizationName: z.string().max(200).optional(),
  contactPerson: z.string().max(200).optional(),
  email: z.string().max(320).optional(),
  phone: z.string().max(50).optional(),
  billingStreet: z.string().max(200).optional(),
  billingPostalCode: z.string().max(20).optional(),
  billingCity: z.string().max(100).optional(),
  billingCountry: z.string().max(100).optional(),
  vatId: z.string().max(50).optional(),
  department: z.string().max(100).optional(),
  costCenter: z.string().max(100).optional(),
  orderReference: z.string().max(100).optional(),
});

const createProcessSchema = z.object({
  customerId: uuidSchema,
  source: z.enum(['website', 'whatsapp', 'staff_manual', 'other']).optional(),
  eventDate: dateSchema.optional(),
  assignedUserId: uuidSchema.optional(),
});

interface CrmRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  /**
   * Phase 9: Storno-Pfad für Vorgänge MIT bestätigter Buchung. Ohne Instanz
   * (z. B. reine CRM-Komposition) werden solche Vorgänge über die Legacy-
   * Route mit 409 auf den Storno-Pfad verwiesen.
   */
  cancellationService?: CancellationService;
  /**
   * Phase 11: Wiedermieter-Gutschein in Kundenprofil/Vorgang (nur Status,
   * Gültigkeit, maskierte Referenz – nie Code/Hash/Versandkopie). Ohne
   * Instanz liefern die Routen `voucher: null`.
   */
  vouchers?: VoucherService;
  /** Phase 12 (scan): Nach-Commit-Listener für den Vorgangsabschluss (Retention). */
  processCompletionListeners?: readonly ProcessCompletionListener[];
  /**
   * Phase 12 (transactional, Order §15): Staff-Aktion „Gutschein jetzt senden“
   * reiht nur den Job `voucher.delivery` ein (Versand im Job über die Mail-
   * Outbox; Staff sieht nie den Klartext). Ohne Queue fehlt die Route.
   */
  voucherDelivery?: { queue: JobQueue };
}

export function registerCrmRoutes(app: FastifyInstance, options: CrmRouteOptions): void {
  const { db, auth, config, cancellationService, vouchers, voucherDelivery } = options;
  const customersService = new CustomerService(db);
  const processService = new ProcessService(db, options.processCompletionListeners ?? []);
  const searchService = new SearchService(db);

  const visibilityCtxFor = async (effective: ReadonlySet<PermissionKey>) =>
    buildVisibilityContext(effective, await getCompletedVisibilityDays(db));

  // ── Kunden ──────────────────────────────────────────────────────────────

  app.get('/staff/customers', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'customer.view'))) return;
    return { customers: await customersService.listCustomers() };
  });

  app.post('/staff/customers', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'customer.create'))) return;
    const body = parseOrThrow(customerInputSchema, request.body);
    try {
      return await customersService.createCustomer(context.user.id, body);
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  /** Dublettenhinweis VOR dem Anlegen – warnt nur, blockiert nie. */
  app.post('/staff/customers/duplicate-check', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'customer.create'))) return;
    const body = parseOrThrow(customerInputSchema, request.body);
    return { duplicates: await customersService.findDuplicates(body) };
  });

  app.get('/staff/customers/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'customer.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const customer = await customersService.getActiveCustomer(params.id);
      const effective = await auth.effectivePermissions(context.user.id);
      const processesForCustomer = effective.has('process.view_all')
        ? await processService.listForCustomer(params.id, await visibilityCtxFor(effective))
        : [];
      // Phase 11 (Order §52): Kundensichtbarkeit genügt; nur maskierte Referenz.
      const voucher =
        vouchers === undefined ? null : await vouchers.customerVoucherSummary(customer.id);
      return { customer, processes: processesForCustomer, voucher };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.patch('/staff/customers/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'customer.edit'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(customerInputSchema, request.body);
    try {
      return { customer: await customersService.updateCustomer(context.user.id, params.id, body) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Papierkorb (nur Admin; kein Hard Delete) ────────────────────────────

  app.delete('/staff/customers/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'trash.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      await customersService.moveToTrash(context.user.id, params.id);
      return { trashed: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.get('/staff/trash/customers', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'trash.manage'))) return;
    return { customers: await customersService.listTrash() };
  });

  app.post('/staff/trash/customers/:id/restore', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'trash.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      await customersService.restoreFromTrash(params.id);
      return { restored: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Vorgänge ────────────────────────────────────────────────────────────

  app.post('/staff/processes', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.create'))) return;
    const body = parseOrThrow(createProcessSchema, request.body);
    // Erstzuweisung ist ebenfalls eine Zuweisung (§7): ohne process.reassign
    // kann ein Vorgang nur unzugewiesen angelegt werden.
    if (
      body.assignedUserId !== undefined &&
      !(await requirePermission(request, reply, auth, context, 'process.reassign'))
    ) {
      return;
    }
    try {
      return { process: await processService.createProcess(context.user.id, body) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.get('/staff/processes', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return;
    const query = parseOrThrow(
      z.object({ includeCompleted: z.enum(['true', 'false']).optional() }),
      request.query,
      'query',
    );
    const effective = await auth.effectivePermissions(context.user.id);
    const ctx = await visibilityCtxFor(effective);
    return {
      processes: await processService.listVisible(ctx, query.includeCompleted === 'true'),
      canViewCompleted: ctx.canViewCompleted,
    };
  });

  app.get('/staff/processes/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const effective = await auth.effectivePermissions(context.user.id);
      const process = await processService.getVisibleProcess(
        params.id,
        await visibilityCtxFor(effective),
      );
      // Datenminimierung: Im Vorgangskontext nur die Anzeige-/Kontaktdaten
      // des Kunden – die vollständigen Stammdaten (Rechnungsadresse, USt-ID,
      // Kostenstelle …) gibt es nur über /staff/customers/:id (customer.view).
      const fullCustomer = await customersService
        .getActiveCustomer(process.customerId)
        .catch(() => null);
      const customer =
        fullCustomer === null
          ? null
          : {
              id: fullCustomer.id,
              type: fullCustomer.type,
              firstName: fullCustomer.firstName,
              lastName: fullCustomer.lastName,
              organizationName: fullCustomer.organizationName,
              email: fullCustomer.email,
              phone: fullCustomer.phone,
            };
      const notes = await processService.listNotes(process.id);
      const assignee =
        process.assignedUserId === null
          ? null
          : ((await auth.findUserById(process.assignedUserId)) ?? null);
      // Phase 9: Storno-Kurzinfo und Verknüpfung Storno ↔ Folgevorgang.
      const cancellation = await loadCancellationSummary(db, process.id);
      const relations = await loadProcessRelations(db, process.id);
      // Phase 11 (Order §53): Gutschein aus DIESEM Ursprungsvorgang (Vorgangssichtbarkeit genügt).
      const voucher =
        vouchers === undefined ? null : await vouchers.processVoucherSummary(process.id);
      return {
        process,
        customer,
        notes,
        assignee:
          assignee === null
            ? null
            : { id: assignee.id, firstName: assignee.firstName, lastName: assignee.lastName },
        cancellation,
        relations,
        voucher,
      };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.patch('/staff/processes/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.edit'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(z.object({ eventDate: dateSchema.nullable() }), request.body);
    try {
      const effective = await auth.effectivePermissions(context.user.id);
      await processService.updateEventDate(
        params.id,
        body.eventDate,
        await visibilityCtxFor(effective),
      );
      return { updated: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/processes/:id/assign', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.reassign'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(z.object({ userId: uuidSchema.nullable() }), request.body);
    try {
      const effective = await auth.effectivePermissions(context.user.id);
      await processService.assign(params.id, body.userId, await visibilityCtxFor(effective));
      return { assigned: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/processes/:id/complete', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.complete'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const effective = await auth.effectivePermissions(context.user.id);
      await processService.complete(params.id, await visibilityCtxFor(effective));
      return { completed: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/processes/:id/reopen', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.reopen_completed')))
      return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      await processService.reopen(params.id, context.user.id);
      return { reopened: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/processes/:id/cancel', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.cancel'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const effective = await auth.effectivePermissions(context.user.id);
      const visibility = await visibilityCtxFor(effective);
      // Phase 9: Vorgänge MIT bestätigter Buchung laufen über den Storno-Pfad
      // (Stornoberechnung, Ressourcenfreigabe, Stornorechnung) – zusätzlich
      // booking.cancel erforderlich. Vorgänge ohne Buchung wie bisher.
      const process = await processService.getVisibleProcess(params.id, visibility);
      const booking = await processService.bookingForProcess(process.id);
      if (booking !== null && cancellationService !== undefined) {
        if (!(await requirePermission(request, reply, auth, context, 'booking.cancel'))) return;
        const isAdmin = await auth.isSystemAdmin(context.user.id);
        const cancellation = await cancellationService.cancel(
          process.id,
          { id: context.user.id, type: isAdmin ? 'admin' : 'employee' },
          { permissions: effective, isAdmin },
        );
        return { cancelled: true, cancellation };
      }
      await processService.cancel(params.id, visibility);
      return { cancelled: true, cancellation: null };
    } catch (error) {
      if (sendCancellationError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/processes/:id/notes', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.edit'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(z.object({ text: z.string().min(1).max(4000) }), request.body);
    try {
      const effective = await auth.effectivePermissions(context.user.id);
      await processService.addNote(
        params.id,
        context.user.id,
        body.text,
        await visibilityCtxFor(effective),
      );
      return { created: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Auswahl, Suche, Dashboard, Einstellungen ────────────────────────────

  app.get('/staff/staff-options', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return;
    return { staff: await processService.listAssignableStaff() };
  });

  app.get('/staff/search', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const query = parseOrThrow(
      z.object({
        q: z.string().min(1).max(200),
        includeCompleted: z.enum(['true', 'false']).optional(),
      }),
      request.query,
      'query',
    );
    const effective = await auth.effectivePermissions(context.user.id);
    const results = await searchService.search(query.q, {
      effective,
      visibility: await visibilityCtxFor(effective),
      includeCompleted: query.includeCompleted === 'true',
    });
    return { ...results, canViewCompleted: effective.has('process.view_completed') };
  });

  app.get('/staff/dashboard', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const effective = await auth.effectivePermissions(context.user.id);
    if (!effective.has('process.view_all')) {
      return { openCount: null, myProcesses: [], recentProcesses: [] };
    }
    return processService.dashboard(context.user.id, await visibilityCtxFor(effective));
  });

  app.get('/staff/settings/completed-visibility', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'system.settings'))) return;
    return { days: await getCompletedVisibilityDays(db) };
  });

  // Phase 12 (transactional, Order §15): „Gutschein jetzt senden“ – bewusste
  // Staff-Aktion, wenn der Kunde inzwischen eine E-Mail-Adresse hat. Pfad unter
  // dem Kunden (kein eigener /vouchers- oder /voucher-Pfad – Phase-11-Regel F19):
  // der Gutschein muss zu DIESEM Kunden gehören (sonst neutrales 404). Rechte:
  // Kundensicht (customer.view) + Versandfreigabe (email.approve_prepared, wie
  // die Stornobestätigung). Antwort nur Status – nie Code/Hash/Versandkopie.
  if (vouchers !== undefined && voucherDelivery !== undefined) {
    const sendVoucherBody = z.strictObject({ voucherId: uuidSchema });
    // Härtung RA-9/H6: verständliche 409-Texte je Blockade (keine technischen Codes).
    const sendNowMessages: Record<VoucherSendNowBlock, string> = {
      ALREADY_SENT: 'Der Gutschein wurde bereits versendet.',
      NO_DELIVERY_COPY: 'Gutschein kann nicht gesendet werden: keine Versandkopie vorhanden.',
      VOUCHER_EXPIRED: 'Gutschein kann nicht gesendet werden: Der Gutschein ist abgelaufen.',
      NO_EMAIL: 'Gutschein kann nicht gesendet werden: keine E-Mail-Adresse hinterlegt.',
      DELIVERY_IN_PROGRESS: 'Der Gutschein wird gerade versendet – bitte den Versand abwarten.',
      DELIVERY_OUTCOME_UNKNOWN:
        'Die Zustellung des Gutscheins ist unklar (der Kunde kann ihn erhalten haben). Bitte in der Kommunikations-Übersicht prüfen.',
    };
    app.post('/staff/customers/:id/send-voucher', async (request, reply) => {
      const context = await requireAuth(request, reply, auth, config);
      if (context === null) return;
      if (!(await requirePermission(request, reply, auth, context, 'customer.view'))) return;
      if (!(await requirePermission(request, reply, auth, context, 'email.approve_prepared')))
        return;
      const params = parseOrThrow(idParams, request.params, 'params');
      const body = parseOrThrow(sendVoucherBody, request.body ?? {});
      try {
        const customer = await customersService.getActiveCustomer(params.id);
        const summary = await vouchers.voucherSummaryById(body.voucherId, customer.id);
        if (summary === null) {
          throw new AuthError('NOT_FOUND', 'Gutschein nicht gefunden.');
        }
        if (!config.mail.enabled) {
          throw new AuthError(
            'CONFLICT',
            'Gutschein kann nicht gesendet werden: Der Mailversand ist nicht konfiguriert.',
          );
        }
        // Eine Regel für Profil (canSendNow), Route und Job (Härtung RA-9/H6).
        const voucherRows = await db
          .select()
          .from(vouchersTable)
          .where(eq(vouchersTable.id, summary.id));
        const voucherRow = voucherRows[0];
        if (voucherRow === undefined) throw new AuthError('NOT_FOUND', 'Gutschein nicht gefunden.');
        const state = await voucherSendNowState(db, voucherRow);
        if (state.block !== null) {
          throw new AuthError('CONFLICT', sendNowMessages[state.block]);
        }
        // Nach gescheiterter Vorzustellung: neue Zustellung an die AKTUELLE Kundenadresse.
        await enqueueVoucherDelivery(
          voucherDelivery.queue,
          summary.id,
          state.retryOfDeliveryId === null
            ? `manual:${Date.now().toString(36)}`
            : `retry:${state.retryOfDeliveryId}:${Date.now().toString(36)}`,
          { retryOfDeliveryId: state.retryOfDeliveryId },
        );
        return { queued: true, voucherId: summary.id };
      } catch (error) {
        if (sendAuthError(request, reply, error)) return;
        throw error;
      }
    });
  }

  app.put('/staff/settings/completed-visibility', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'system.settings'))) return;
    const body = parseOrThrow(z.object({ days: z.number().int() }), request.body);
    try {
      await setCompletedVisibilityDays(db, context.user.id, body.days);
      return { days: body.days };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });
}
