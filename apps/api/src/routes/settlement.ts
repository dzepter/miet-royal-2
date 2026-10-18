import type { AppConfig } from '@mietroyal/config';
import { bookings, type Booking, type Database } from '@mietroyal/database';
import type { JobQueue, StorageProvider } from '@mietroyal/integrations';
import { parseOrThrow, z } from '@mietroyal/validation';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AccountingGateway } from '../accounting/gateway.ts';
import type { AccountingTransferService } from '../accounting/transfer-service.ts';
import { requireAuth, requirePermission, sendAuthError, sendError } from '../auth/http.ts';
import { AuthError, type AuthenticatedContext, type StaffAuthService } from '../auth/service.ts';
import { ProcessService } from '../crm/process-service.ts';
import { LexwareApiError } from '../lexware/errors.ts';
import { getCompletedVisibilityDays } from '../crm/settings-service.ts';
import { buildVisibilityContext } from '../crm/visibility.ts';
import { createRetentionCompletionListener } from '../communication/retention/cleanup.ts';
import type { SettlementNoticeMailer } from '../communication/transactional/mailers.ts';
import {
  SettlementError,
  SettlementService,
  type SettlementRow,
} from '../settlement/settlement-service.ts';
import { UUID_PATTERN } from './auth.ts';

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const idParams = z.object({ id: uuidSchema });
const processParams = z.object({ processId: uuidSchema });
const bookingParams = z.object({ bookingId: uuidSchema });
const lineParams = z.object({ id: uuidSchema, lineId: uuidSchema });
const clarificationParams = z.object({ id: uuidSchema, clarificationId: uuidSchema });
const versionSchema = z.number().int().min(1);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'muss ein Datum YYYY-MM-DD sein')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }, 'muss ein gültiges Kalenderdatum sein');

/**
 * Alle Mutationen sind strictObject-Schemas (Tests 138–142): Felder wie
 * status, transferred, accountingReference, feePercent, baseCents,
 * cleanupFee oder chargeableQuantity werden mit 400 abgelehnt.
 */
const versionBody = z.strictObject({ version: versionSchema });
const addLineBody = z.strictObject({
  type: z.enum(['manual_charge', 'late_fee']),
  description: z.string().min(1).max(500),
  amountCents: z.number().int().min(1).max(100_000_000),
  internalNote: z.string().max(1000).nullable().optional(),
  version: versionSchema,
});
const patchLineBody = z.strictObject({
  amountCents: z.number().int().min(1).max(100_000_000).optional(),
  description: z.string().min(1).max(500).optional(),
  internalNote: z.string().max(1000).nullable().optional(),
  version: versionSchema,
});
const resolveBody = z.strictObject({
  decision: z.enum(['charge', 'no_charge']),
  amountCents: z.number().int().min(1).max(100_000_000).optional(),
  description: z.string().min(1).max(500).optional(),
  version: versionSchema,
});
const paymentBody = z.strictObject({
  amountCents: z.number().int().min(1).max(100_000_000),
  receivedAt: isoDate,
  externalReference: z.string().max(200).nullable().optional(),
});
const applyDepositBody = z.strictObject({
  amountCents: z.number().int().min(1).max(100_000_000),
  version: versionSchema,
});

export interface SettlementRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  storage: StorageProvider;
  queue: JobQueue;
  accountingGateway: AccountingGateway;
  transfers: AccountingTransferService;
  /** Phase 12 (Order §12): Kundeninformation über die Mail-Outbox. */
  notices: SettlementNoticeMailer;
}

/** SettlementError ⇒ Status + fachlicher Code (z. B. 409 SETTLEMENT_LOCKED); sonst sendAuthError. */
export function sendSettlementError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): boolean {
  if (error instanceof SettlementError) {
    const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'VALIDATION' ? 400 : 409;
    sendError(request, reply, status, error.reason, error.message);
    return true;
  }
  return sendAuthError(request, reply, error);
}

/**
 * Abrechnungs-Routen (Phase 9 §§4–48, §§69–72; Vertrag §4). Rechte werden
 * serverseitig je Aktion geprüft; die Sichtbarkeit des Vorgangs gilt wie in
 * returns.ts (`visibleBooking`): fremde/unbekannte IDs ⇒ neutrales 404.
 */
export function registerSettlementRoutes(
  app: FastifyInstance,
  options: SettlementRouteOptions,
): void {
  const { db, auth, config, transfers, notices, queue } = options;
  // Phase 12 (E2E-Agent 2, Retention Order §25): manueller Transfer schließt den Vorgang ab ⇒
  // Foto-Retention-Job sofort einreihen (wie CRM-Abschluss; Backstop bleibt).
  const processService = new ProcessService(db, [
    createRetentionCompletionListener(queue, app.log),
  ]);
  const service = new SettlementService({
    db,
    transfers,
    notices,
    queue,
    processes: processService,
    appEnv: config.appEnv,
    logger: app.log,
  });

  const effectiveFor = (context: AuthenticatedContext) =>
    auth.effectivePermissions(context.user.id);

  const visibilityFor = async (context: AuthenticatedContext) => {
    const effective = await effectiveFor(context);
    return buildVisibilityContext(effective, await getCompletedVisibilityDays(db));
  };

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

  /** Settlement laden + Vorgangs-Sichtbarkeit (IDOR-Schutz, Tests 130–135). */
  const visibleSettlement = async (
    request: FastifyRequest,
    reply: FastifyReply,
    context: AuthenticatedContext,
    settlementId: string,
  ): Promise<SettlementRow | null> => {
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return null;
    let settlement: SettlementRow;
    try {
      settlement = await service.byId(settlementId);
    } catch (error) {
      if (sendSettlementError(request, reply, error)) return null;
      throw error;
    }
    if (!(await requireVisibleProcess(request, reply, context, settlement.processId))) return null;
    return settlement;
  };

  const visibleBooking = async (
    request: FastifyRequest,
    reply: FastifyReply,
    context: AuthenticatedContext,
    bookingId: string,
  ): Promise<Booking | null> => {
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

  const viewFor = async (context: AuthenticatedContext, settlementId: string) =>
    service.view(settlementId, await effectiveFor(context));

  // ── Ansicht / Ensure ─────────────────────────────────────────────────────

  app.get('/staff/processes/:processId/settlement', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'settlement.view'))) return;
    const params = parseOrThrow(processParams, request.params, 'params');
    if (!(await requireVisibleProcess(request, reply, context, params.processId))) return;
    const settlement = await service.byProcessId(params.processId);
    if (settlement === null) {
      sendError(
        request,
        reply,
        404,
        'SETTLEMENT_NOT_FOUND',
        'Abrechnung entsteht nach Abschluss der Rückgabe.',
      );
      return;
    }
    try {
      return await viewFor(context, settlement.id);
    } catch (error) {
      if (sendSettlementError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/processes/:processId/settlement/ensure', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'settlement.view'))) return;
    const params = parseOrThrow(processParams, request.params, 'params');
    if (!(await requireVisibleProcess(request, reply, context, params.processId))) return;
    try {
      const settlement = await service.ensureForProcess(params.processId);
      return await viewFor(context, settlement.id);
    } catch (error) {
      if (sendSettlementError(request, reply, error)) return;
      throw error;
    }
  });

  app.get('/staff/settlements/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'settlement.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const settlement = await visibleSettlement(request, reply, context, params.id);
    if (settlement === null) return;
    try {
      return await viewFor(context, settlement.id);
    } catch (error) {
      if (sendSettlementError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Positionen ───────────────────────────────────────────────────────────

  app.post('/staff/settlements/:id/lines', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'settlement.add_manual_charge')))
      return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(addLineBody, request.body);
    const settlement = await visibleSettlement(request, reply, context, params.id);
    if (settlement === null) return;
    try {
      await service.addManualLine(context.user.id, settlement.id, body);
      return await viewFor(context, settlement.id);
    } catch (error) {
      if (sendSettlementError(request, reply, error)) return;
      throw error;
    }
  });

  /** Recht je Positionstyp: manuell/Verspätung ⇒ add_manual_charge; Schaden/Fehlteil ⇒ edit_cost_before_lexware. */
  const linePermission = (type: string) =>
    type === 'damage_charge' || type === 'missing_item_charge'
      ? ('damage.edit_cost_before_lexware' as const)
      : ('settlement.add_manual_charge' as const);

  app.patch('/staff/settlements/:id/lines/:lineId', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'settlement.view'))) return;
    const params = parseOrThrow(lineParams, request.params, 'params');
    const body = parseOrThrow(patchLineBody, request.body);
    const settlement = await visibleSettlement(request, reply, context, params.id);
    if (settlement === null) return;
    try {
      const line = await service.lineById(settlement.id, params.lineId);
      if (!(await requirePermission(request, reply, auth, context, linePermission(line.type))))
        return;
      await service.updateLine(context.user.id, settlement.id, line.id, body);
      return await viewFor(context, settlement.id);
    } catch (error) {
      if (sendSettlementError(request, reply, error)) return;
      throw error;
    }
  });

  app.delete('/staff/settlements/:id/lines/:lineId', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'settlement.view'))) return;
    const params = parseOrThrow(lineParams, request.params, 'params');
    const body = parseOrThrow(versionBody, request.body ?? {});
    const settlement = await visibleSettlement(request, reply, context, params.id);
    if (settlement === null) return;
    try {
      const line = await service.lineById(settlement.id, params.lineId);
      if (!(await requirePermission(request, reply, auth, context, linePermission(line.type))))
        return;
      await service.removeLine(context.user.id, settlement.id, line.id, body.version);
      return await viewFor(context, settlement.id);
    } catch (error) {
      if (sendSettlementError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Klärungen (Schaden-/Fehlteilkosten) ─────────────────────────────────

  app.post(
    '/staff/settlements/:id/clarifications/:clarificationId/resolve',
    async (request, reply) => {
      const context = await requireAuth(request, reply, auth, config);
      if (context === null) return;
      if (!(await requirePermission(request, reply, auth, context, 'settlement.view'))) return;
      const params = parseOrThrow(clarificationParams, request.params, 'params');
      const body = parseOrThrow(resolveBody, request.body);
      const settlement = await visibleSettlement(request, reply, context, params.id);
      if (settlement === null) return;
      try {
        const clarification = await service.clarificationById(
          settlement.id,
          params.clarificationId,
        );
        const permission =
          clarification.type === 'damage_cost'
            ? 'damage.set_cost'
            : clarification.type === 'missing_item_cost'
              ? 'missing_item.set_cost'
              : null;
        if (permission === null) {
          throw new AuthError(
            'CONFLICT',
            'Diese Klärung wird über die zugehörige Aktion erledigt, nicht über einen Kostenentscheid.',
          );
        }
        if (!(await requirePermission(request, reply, auth, context, permission))) return;
        await service.resolveClarification(context.user.id, settlement.id, clarification.id, body);
        return await viewFor(context, settlement.id);
      } catch (error) {
        if (sendSettlementError(request, reply, error)) return;
        throw error;
      }
    },
  );

  // ── Kundeninformation / Wartefenster / Freigaben ─────────────────────────

  app.get('/staff/settlements/:id/notice', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'settlement.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const settlement = await visibleSettlement(request, reply, context, params.id);
    if (settlement === null) return;
    try {
      return await service.notice(settlement.id);
    } catch (error) {
      if (sendSettlementError(request, reply, error)) return;
      throw error;
    }
  });

  const releaseRoute = (
    path: string,
    permission: 'settlement.release' | 'settlement.end_pre_notice_wait',
    action: (actorId: string, settlementId: string, version: number) => Promise<unknown>,
    schema: z.ZodType<{ version: number }> = versionBody,
  ) => {
    app.post(path, async (request, reply) => {
      const context = await requireAuth(request, reply, auth, config);
      if (context === null) return;
      if (!(await requirePermission(request, reply, auth, context, permission))) return;
      const params = parseOrThrow(idParams, request.params, 'params');
      const body = parseOrThrow(schema, request.body ?? {});
      const settlement = await visibleSettlement(request, reply, context, params.id);
      if (settlement === null) return;
      try {
        await action(context.user.id, settlement.id, body.version);
        return await viewFor(context, settlement.id);
      } catch (error) {
        if (sendSettlementError(request, reply, error)) return;
        throw error;
      }
    });
  };

  releaseRoute('/staff/settlements/:id/notice/approve-and-send', 'settlement.release', (a, s, v) =>
    service.approveAndSendNotice(a, s, v),
  );
  releaseRoute('/staff/settlements/:id/customer-response', 'settlement.release', (a, s, v) =>
    service.recordCustomerResponse(a, s, v),
  );
  releaseRoute('/staff/settlements/:id/release', 'settlement.release', (a, s, v) =>
    service.releaseAsCalculated(a, s, v),
  );
  releaseRoute('/staff/settlements/:id/end-wait', 'settlement.end_pre_notice_wait', (a, s, v) =>
    service.endWait(a, s, v),
  );

  // ── Manuelle Übertragung (synchron) ──────────────────────────────────────

  app.post('/staff/settlements/:id/transfer', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'lexware.manual_transfer')))
      return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(versionBody, request.body ?? {});
    const settlement = await visibleSettlement(request, reply, context, params.id);
    if (settlement === null) return;
    try {
      const result = await service.transferNow(context.user.id, settlement.id, body.version);
      return {
        outcome: result.outcome,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        settlement: await viewFor(context, settlement.id),
      };
    } catch (error) {
      if (sendSettlementError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Phase 10: Rechnungsdatei (Streaming, keine Persistenz; Order §39) ──

  app.get('/staff/settlements/:id/invoice-file', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'accounting.view_reference')))
      return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const settlement = await visibleSettlement(request, reply, context, params.id);
    if (settlement === null) return;
    const deps = transfers.lexwareDeps;
    if (deps === null || deps.context.client === null) {
      sendError(request, reply, 404, 'NOT_FOUND', 'Keine Rechnungsdatei verfügbar.');
      return;
    }
    const mapping =
      settlement.accountingTransferId === null
        ? null
        : await transfers.invoiceMapping(settlement.accountingTransferId);
    if (
      mapping === null ||
      mapping.lexwareInvoiceId === null ||
      settlement.accountingProvider !== 'lexware'
    ) {
      sendError(request, reply, 404, 'NOT_FOUND', 'Keine Rechnungsdatei verfügbar.');
      return;
    }
    try {
      const file = await deps.context.client.getInvoiceFile(mapping.lexwareInvoiceId);
      const name = (mapping.voucherNumber ?? 'rechnung').replace(/[^A-Za-z0-9_-]/g, '_');
      return await reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="${name}.pdf"`)
        .header('cache-control', 'no-store')
        .send(Buffer.from(file.data));
    } catch (error) {
      if (error instanceof LexwareApiError) {
        sendError(
          request,
          reply,
          error.transient ? 503 : 409,
          error.code,
          'Rechnungsdatei derzeit nicht abrufbar.',
        );
        return;
      }
      throw error;
    }
  });

  // ── Anzahlungen / Kautionen (auch VOR der Rückgabe) ─────────────────────

  app.get('/staff/bookings/:bookingId/payments', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'settlement.view'))) return;
    const params = parseOrThrow(bookingParams, request.params, 'params');
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      return await service.payments(booking.id, await effectiveFor(context));
    } catch (error) {
      if (sendSettlementError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/bookings/:bookingId/advance-payments', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'deposit.record_advance'))) return;
    const params = parseOrThrow(bookingParams, request.params, 'params');
    const body = parseOrThrow(paymentBody, request.body);
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      await service.recordAdvance(context.user.id, booking.id, body);
      return await service.payments(booking.id, await effectiveFor(context));
    } catch (error) {
      if (sendSettlementError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/advance-payments/:id/cancel', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'deposit.record_advance'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const advance = await service.advanceById(params.id);
      const booking = await visibleBooking(request, reply, context, advance.bookingId);
      if (booking === null) return;
      await service.cancelAdvance(context.user.id, advance.id);
      return await service.payments(booking.id, await effectiveFor(context));
    } catch (error) {
      if (sendSettlementError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/bookings/:bookingId/security-deposits', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'deposit.record_security')))
      return;
    const params = parseOrThrow(bookingParams, request.params, 'params');
    const body = parseOrThrow(paymentBody, request.body);
    const booking = await visibleBooking(request, reply, context, params.bookingId);
    if (booking === null) return;
    try {
      await service.recordDeposit(context.user.id, booking.id, body);
      return await service.payments(booking.id, await effectiveFor(context));
    } catch (error) {
      if (sendSettlementError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/security-deposits/:id/apply', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'deposit.retain_security')))
      return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(applyDepositBody, request.body);
    try {
      const deposit = await service.depositById(params.id);
      const booking = await visibleBooking(request, reply, context, deposit.bookingId);
      if (booking === null) return;
      await service.applyDeposit(context.user.id, deposit.id, body);
      return await service.payments(booking.id, await effectiveFor(context));
    } catch (error) {
      if (sendSettlementError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/security-deposits/:id/release', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'deposit.refund_security')))
      return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(versionBody, request.body ?? {});
    try {
      const deposit = await service.depositById(params.id);
      const booking = await visibleBooking(request, reply, context, deposit.bookingId);
      if (booking === null) return;
      await service.releaseDeposit(context.user.id, deposit.id, body.version);
      return await service.payments(booking.id, await effectiveFor(context));
    } catch (error) {
      if (sendSettlementError(request, reply, error)) return;
      throw error;
    }
  });
}
