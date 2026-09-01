import type { AppConfig } from '@mietroyal/config';
import { PERMISSION_CATEGORIES, PERMISSION_DEFINITIONS } from '@mietroyal/permissions';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance } from 'fastify';
import type { StaffAdminService } from '../auth/admin-service.ts';
import { requireAuth, requirePermission, sendAuthError } from '../auth/http.ts';
import type { StaffAuthService } from '../auth/service.ts';
import { UUID_PATTERN } from './auth.ts';

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const idParams = z.object({ id: uuidSchema });

const createUserSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().min(3).max(320),
});
const statusSchema = z.object({ status: z.enum(['active', 'locked', 'disabled']) });
const rolesSchema = z.object({ roleIds: z.array(uuidSchema).max(50) });
const overrideSchema = z.object({
  permissionKey: z.string().min(1).max(100),
  effect: z.enum(['allow', 'deny']),
  validFrom: z.iso.datetime({ offset: true }).optional(),
  validUntil: z.iso.datetime({ offset: true }).optional(),
});
const roleCreateSchema = z.object({
  name: z.string().min(1).max(100),
  permissionKeys: z.array(z.string().min(1).max(100)).max(200),
});
const roleUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  permissionKeys: z.array(z.string().min(1).max(100)).max(200).optional(),
});
const totpRequirementSchema = z.object({ required: z.boolean() });
const explanationSchema = z.object({ explanation: z.string().max(500) });

interface StaffAdminRouteOptions {
  auth: StaffAuthService;
  admin: StaffAdminService;
  config: AppConfig;
}

/**
 * Admin-Endpunkte. Jede Route prüft serverseitig FRISCH die erforderliche
 * Berechtigung (employee.manage / permission.manage / device.revoke) –
 * manipulierte Anfragen ohne Recht enden mit 403, unabhängig von der UI.
 */
export function registerStaffAdminRoutes(
  app: FastifyInstance,
  options: StaffAdminRouteOptions,
): void {
  const { auth, admin, config } = options;

  // ── Mitarbeiter ─────────────────────────────────────────────────────────

  app.get('/staff/users', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'employee.manage'))) return;
    return { users: await admin.listUsers() };
  });

  app.post('/staff/users', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'employee.manage'))) return;
    const body = parseOrThrow(createUserSchema, request.body);
    try {
      const { user, setupToken } = await admin.createEmployee(context.user.id, body);
      return {
        user: {
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
        },
        // Einmalig sichtbar: Einrichtungs-Link für die neue Person.
        setupToken,
      };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.get('/staff/users/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'employee.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      return await admin.getUserDetail(params.id);
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/users/:id/status', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'employee.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(statusSchema, request.body);
    try {
      await admin.setUserStatus(context.user.id, params.id, body.status);
      return { status: body.status };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  /** Admin-Reset-Weg: einmaliger Passwort-Reset-Link für ein aktives Konto. */
  app.post('/staff/users/:id/reset-link', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'employee.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const { resetToken } = await admin.issuePasswordResetLink(context.user.id, params.id);
      // Einmalig sichtbar; der Admin übergibt den Link persönlich.
      return { resetToken };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/users/:id/totp-requirement', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'employee.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(totpRequirementSchema, request.body);
    try {
      await admin.setTotpRequirement(context.user.id, params.id, body.required);
      return { required: body.required };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/users/:id/totp-reset', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'employee.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      await admin.resetTotp(context.user.id, params.id);
      return { reset: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Rollen & Rechte ─────────────────────────────────────────────────────

  app.get('/staff/roles', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'permission.manage'))) return;
    return { roles: await admin.listRoles() };
  });

  app.post('/staff/roles', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'permission.manage'))) return;
    const body = parseOrThrow(roleCreateSchema, request.body);
    try {
      const roleId = await admin.createRole(context.user.id, body);
      return { roleId };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.patch('/staff/roles/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'permission.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(roleUpdateSchema, request.body);
    try {
      await admin.updateRole(context.user.id, params.id, body);
      return { updated: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.delete('/staff/roles/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'permission.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      await admin.deleteRole(context.user.id, params.id);
      return { deleted: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/users/:id/roles', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'permission.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(rolesSchema, request.body);
    try {
      await admin.setUserRoles(context.user.id, params.id, body.roleIds);
      return { updated: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/users/:id/overrides', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'permission.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(overrideSchema, request.body);
    try {
      const overrideId = await admin.addOverride(context.user.id, params.id, {
        permissionKey: body.permissionKey,
        effect: body.effect,
        ...(body.validFrom !== undefined ? { validFrom: new Date(body.validFrom) } : {}),
        ...(body.validUntil !== undefined ? { validUntil: new Date(body.validUntil) } : {}),
      });
      return { overrideId };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.delete('/staff/overrides/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'permission.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      await admin.removeOverride(context.user.id, params.id);
      return { removed: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Geräte / Sessions ───────────────────────────────────────────────────

  app.get('/staff/users/:id/sessions', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'employee.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    return { sessions: await admin.listUserSessions(params.id) };
  });

  app.post('/staff/sessions/:id/revoke', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'device.revoke'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    await auth.revokeSessionById(params.id, 'admin_revoked', context.user.id);
    return { revoked: true };
  });

  app.post('/staff/users/:id/sessions/revoke-all', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'device.revoke'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const count = await auth.revokeAllSessions(params.id, 'admin_revoked_all', context.user.id);
    return { revoked: count };
  });

  // ── Berechtigungskatalog + Erklärtexte ──────────────────────────────────

  /** Katalog-Metadaten (keine Secrets) für Rollen-Editor und Sperr-Hinweise. */
  app.get('/staff/permissions', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const custom = await admin.listExplanations();
    const customByKey = new Map(custom.map((c) => [c.permissionKey, c.explanation]));
    return {
      categories: PERMISSION_CATEGORIES,
      permissions: PERMISSION_DEFINITIONS.map((d) => ({
        key: d.key,
        category: d.category,
        label: d.label,
        adminInfra: d.adminInfra,
        explanation: customByKey.get(d.key) ?? d.defaultExplanation,
        hasCustomExplanation: customByKey.has(d.key),
      })),
    };
  });

  app.put('/staff/permissions/:key/explanation', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'permission.manage'))) return;
    const params = parseOrThrow(
      z.object({ key: z.string().min(1).max(100) }),
      request.params,
      'params',
    );
    const body = parseOrThrow(explanationSchema, request.body);
    try {
      await admin.setPermissionExplanation(context.user.id, params.key, body.explanation);
      return { updated: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Security-Audit ──────────────────────────────────────────────────────

  app.get('/staff/security-events', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'employee.manage'))) return;
    const query = parseOrThrow(z.object({ userId: uuidSchema.optional() }), request.query, 'query');
    return { events: await admin.listSecurityEvents(query.userId) };
  });
}
