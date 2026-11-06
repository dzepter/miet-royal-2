import type { AppConfig } from '@mietroyal/config';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance } from 'fastify';
import { sendAuthError, sendError } from '../auth/http.ts';
import { AuthError } from '../auth/service.ts';
import { isReauthFresh } from '../portal/auth/constants.ts';
import type { PortalProfileService } from '../portal/auth/profile-service.ts';
import type { PortalSessionService } from '../portal/auth/session-service.ts';
import { clearPortalSessionCookie, requirePortalSession } from '../portal/guard.ts';
import { PORTAL_MESSAGES } from '../portal/types.ts';

/**
 * Phase 15 (Design §1.3, Order §31–§33): Profil des angemeldeten Kunden.
 * Der Kunde kommt IMMER aus der Session; `type` und `email` sind hier nie
 * änderbar (strictObject ⇒ 400). Mutationen verlangen eine Reauth ≤ 15 min.
 */
export interface PortalProfileRouteDeps {
  config: AppConfig;
  sessions: PortalSessionService;
  profile: PortalProfileService;
}

/** Felder je Kundentyp; Längen wie `customerInputSchema` (routes/crm.ts). */
const privatePatchSchema = z.strictObject({
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  phone: z.string().max(50).optional(),
  billingStreet: z.string().max(200).optional(),
  billingPostalCode: z.string().max(20).optional(),
  billingCity: z.string().max(100).optional(),
  billingCountry: z.string().max(100).optional(),
});
const organizationPatchSchema = privatePatchSchema
  .omit({ firstName: true, lastName: true })
  .extend({
    organizationName: z.string().max(200).optional(),
    contactPerson: z.string().max(200).optional(),
    vatId: z.string().max(50).optional(),
    department: z.string().max(100).optional(),
    costCenter: z.string().max(100).optional(),
    orderReference: z.string().max(100).optional(),
  });

export function registerPortalProfileRoutes(
  app: FastifyInstance,
  deps: PortalProfileRouteDeps,
): void {
  const { config, sessions, profile } = deps;

  app.get('/portal/profile', async (request, reply) => {
    const now = new Date();
    const session = await requirePortalSession(request, reply, sessions, config, { now });
    if (session === null) return;
    try {
      return await profile.view(session.customerId);
    } catch (error) {
      if (error instanceof AuthError && error.code === 'NOT_FOUND') {
        clearPortalSessionCookie(reply, config);
        sendError(request, reply, 401, 'PORTAL_UNAUTHENTICATED', PORTAL_MESSAGES.UNAUTHENTICATED);
        return;
      }
      throw error;
    }
  });

  app.patch('/portal/profile', async (request, reply) => {
    const now = new Date();
    const session = await requirePortalSession(request, reply, sessions, config, { now });
    if (session === null) return;
    if (!isReauthFresh(session.reauthenticatedAt, now)) {
      sendError(request, reply, 403, 'PORTAL_REAUTH_REQUIRED', PORTAL_MESSAGES.REAUTH_REQUIRED);
      return;
    }
    try {
      const type = await profile.customerType(session.customerId);
      const patch = parseOrThrow(
        type === 'organization' ? organizationPatchSchema : privatePatchSchema,
        request.body,
      );
      return await profile.update(session.customerId, patch, now);
    } catch (error) {
      if (error instanceof AuthError && error.code === 'NOT_FOUND') {
        clearPortalSessionCookie(reply, config);
        sendError(request, reply, 401, 'PORTAL_UNAUTHENTICATED', PORTAL_MESSAGES.UNAUTHENTICATED);
        return;
      }
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });
}
