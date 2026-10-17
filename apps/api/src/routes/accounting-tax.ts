import type { AppConfig } from '@mietroyal/config';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance } from 'fastify';
import { requireAuth, requirePermission, sendAuthError, sendError } from '../auth/http.ts';
import type { StaffAuthService } from '../auth/service.ts';
import { LEXWARE_TAX_TYPES, type TaxConfigService } from '../lexware/tax-config-service.ts';

const taxConfigBody = z.strictObject({
  taxType: z.enum(LEXWARE_TAX_TYPES),
  categories: z
    .array(
      z.strictObject({
        category: z.string().min(1).max(64),
        treatment: z.enum(['taxable', 'vatfree']),
        taxRateBp: z.number().int().min(0).max(10_000),
      }),
    )
    .max(20),
});

export interface AccountingTaxRouteOptions {
  auth: StaffAuthService;
  config: AppConfig;
  taxConfig: TaxConfigService;
}

/**
 * Steuerkonfiguration (Vertrag §4, Order §13/§62): nur system.settings.
 * Synthetische Werte gibt es ausschließlich außerhalb von production –
 * dort antwortet die Route neutral mit 404.
 */
export function registerAccountingTaxRoutes(
  app: FastifyInstance,
  options: AccountingTaxRouteOptions,
): void {
  const { auth, config, taxConfig } = options;

  app.get('/staff/accounting/tax-config', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'system.settings'))) return;
    return taxConfig.list();
  });

  app.put('/staff/accounting/tax-config', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'system.settings'))) return;
    const body = parseOrThrow(taxConfigBody, request.body);
    try {
      await taxConfig.update(context.user.id, body);
      return await taxConfig.list();
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/accounting/tax-config/synthetic', async (request, reply) => {
    if (config.appEnv === 'production') {
      sendError(request, reply, 404, 'NOT_FOUND', 'Nicht gefunden.');
      return;
    }
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'system.settings'))) return;
    try {
      await taxConfig.applySyntheticDefaults(context.user.id);
      return await taxConfig.list();
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });
}
