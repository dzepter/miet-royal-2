import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth, sendAuthError, sendError } from '../auth/http.ts';
import type { AuthenticatedContext, StaffAuthService } from '../auth/service.ts';
import { CustomerService } from '../crm/customer-service.ts';
import {
  LexwareBlockedError,
  type LexwareConnectionService,
} from '../lexware/connection-service.ts';
import { ContactSyncError, type ContactSyncService } from '../lexware/contact-sync-service.ts';
import { LexwareApiError } from '../lexware/errors.ts';
import { UUID_PATTERN } from './auth.ts';

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const idParams = z.object({ id: uuidSchema });
const linkBody = z.strictObject({
  lexwareContactId: z.string().regex(/^[0-9a-f-]{36}$/i, 'muss eine Lexware-Kontakt-ID sein'),
});
const emptyBody = z.strictObject({}).optional();

export interface LexwareContactRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  connection: LexwareConnectionService;
  contacts: ContactSyncService;
}

/** Fachliche Lexware-Fehler neutral abbilden (nie Rohfehler/Key). */
export function sendLexwareError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): boolean {
  if (error instanceof ContactSyncError) {
    sendError(request, reply, error.code === 'NOT_FOUND' ? 404 : 409, error.reason, error.message);
    return true;
  }
  if (error instanceof LexwareBlockedError) {
    sendError(request, reply, 409, error.code, error.message);
    return true;
  }
  if (error instanceof LexwareApiError) {
    sendError(
      request,
      reply,
      error.transient ? 503 : 409,
      error.code,
      error.transient
        ? 'Lexware ist derzeit nicht erreichbar – bitte später erneut versuchen.'
        : 'Lexware hat die Anfrage abgelehnt – Einstellungen und Daten prüfen.',
    );
    return true;
  }
  return sendAuthError(request, reply, error);
}

/**
 * Kunde ↔ Lexware-Kontakt (Vertrag §5). Lesen: settlement.view ∨
 * system.settings; Klärung (link/create): system.settings. Unsichtbare
 * Kunden (Papierkorb/unbekannt) ⇒ neutrales 404.
 */
export function registerLexwareContactRoutes(
  app: FastifyInstance,
  options: LexwareContactRouteOptions,
): void {
  const { db, auth, config, connection, contacts } = options;
  const customersService = new CustomerService(db);

  const requireAnyPermission = async (
    request: FastifyRequest,
    reply: FastifyReply,
    context: AuthenticatedContext,
    keys: readonly ('settlement.view' | 'system.settings')[],
  ): Promise<boolean> => {
    const effective = await auth.effectivePermissions(context.user.id);
    if (keys.some((key) => effective.has(key))) return true;
    sendError(request, reply, 403, 'FORBIDDEN', 'Dafür fehlt dir die erforderliche Berechtigung.');
    return false;
  };

  const visibleCustomer = async (
    request: FastifyRequest,
    reply: FastifyReply,
    customerId: string,
  ): Promise<boolean> => {
    try {
      await customersService.getActiveCustomer(customerId);
      return true;
    } catch (error) {
      if (sendAuthError(request, reply, error)) return false;
      throw error;
    }
  };

  app.get('/staff/customers/:id/lexware-contact', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (
      !(await requireAnyPermission(request, reply, context, ['settlement.view', 'system.settings']))
    )
      return;
    const params = parseOrThrow(idParams, request.params, 'params');
    if (!(await visibleCustomer(request, reply, params.id))) return;
    return contacts.view(params.id);
  });

  app.post('/staff/customers/:id/lexware-contact/link', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requireAnyPermission(request, reply, context, ['system.settings']))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(linkBody, request.body);
    if (!(await visibleCustomer(request, reply, params.id))) return;
    try {
      const { organizationId } = await connection.assertReady();
      return await contacts.link(context.user.id, params.id, body.lexwareContactId, organizationId);
    } catch (error) {
      if (sendLexwareError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/customers/:id/lexware-contact/create', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requireAnyPermission(request, reply, context, ['system.settings']))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    parseOrThrow(emptyBody, request.body ?? {});
    if (!(await visibleCustomer(request, reply, params.id))) return;
    try {
      const { organizationId } = await connection.assertReady();
      return await contacts.createForCustomer(context.user.id, params.id, organizationId);
    } catch (error) {
      if (sendLexwareError(request, reply, error)) return;
      throw error;
    }
  });
}
