import type { AppConfig } from '@mietroyal/config';
import {
  accountingTaxConfig,
  systemSettings,
  type Database,
  type LexwareIntegrationStateRow,
} from '@mietroyal/database';
import { parseOrThrow, z } from '@mietroyal/validation';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AccountingTransferService } from '../accounting/transfer-service.ts';
import { requireAuth, requirePermission, sendAuthError, sendError } from '../auth/http.ts';
import type { StaffAuthService } from '../auth/service.ts';
import {
  LEXWARE_STATUS_LABELS,
  LexwareBlockedError,
  LexwareConnectionService,
} from '../lexware/connection-service.ts';
import type { LexwareContext } from '../lexware/context.ts';
import { LexwareApiError } from '../lexware/errors.ts';
import {
  LEXWARE_RECONCILE_ADMIN_LIMIT,
  LexwareReconcileRunningError,
  LexwareReconcileService,
} from '../lexware/reconcile-service.ts';
import { LexwareSubscriptionService, parseStored } from '../lexware/subscription-service.ts';

export interface LexwareAdminRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  lexware: LexwareContext;
  transfers: AccountingTransferService;
}

const confirmOrganizationBody = z.strictObject({
  organizationId: z.string().trim().min(1).max(128),
});

/**
 * Steuerkonfigurations-Vollständigkeit (Vertrag §4, hier als kleine lokale
 * Prüfung, damit die Statusroute nicht vom TaxConfigService abhängt): alle
 * zehn Kategorien vorhanden ∧ Lexware-taxType gesetzt ∧ in production keine
 * synthetische Zeile. Die Kategorienliste ist die der Order §13.
 */
export const LEXWARE_TAX_CATEGORIES = [
  'machine_rental',
  'delivery',
  'purchase',
  'commission_consumption',
  'cleanup_fee',
  'damage_charge',
  'missing_item_charge',
  'late_fee',
  'manual_charge',
  'cancellation_charge',
] as const;
export const LEXWARE_TAX_TYPE_SETTING_KEY = 'accounting_lexware_tax_type';

export async function isTaxConfigComplete(db: Database, appEnv: string): Promise<boolean> {
  const rows = await db
    .select({ category: accountingTaxConfig.category, synthetic: accountingTaxConfig.synthetic })
    .from(accountingTaxConfig);
  const present = new Set(rows.map((r) => r.category));
  if (LEXWARE_TAX_CATEGORIES.some((category) => !present.has(category))) return false;
  if (appEnv === 'production' && rows.some((r) => r.synthetic)) return false;
  const setting = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, LEXWARE_TAX_TYPE_SETTING_KEY));
  const value = setting[0]?.value;
  return typeof value === 'string' && ['net', 'gross', 'vatfree'].includes(value);
}

function shortOrganizationId(value: string | null): string | null {
  if (value === null) return null;
  return value.length <= 8 ? value : `${value.slice(0, 8)}…`;
}

/**
 * Admin-Integrationsstatus und -aktionen (Order §8, Vertrag §3) – alle mit
 * system.settings. Der API-Key erscheint nirgends; Fehlercodes sind neutral.
 */
export function registerLexwareAdminRoutes(
  app: FastifyInstance,
  options: LexwareAdminRouteOptions,
): void {
  const { db, auth, config, lexware, transfers } = options;
  const connection = new LexwareConnectionService(lexware);
  const subscriptions = new LexwareSubscriptionService(lexware, connection);
  const reconcile = new LexwareReconcileService(lexware, db, transfers, connection);

  const requireSettings = async (request: FastifyRequest, reply: FastifyReply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return null;
    if (!(await requirePermission(request, reply, auth, context, 'system.settings'))) return null;
    return context;
  };

  const statusPayload = async (state: LexwareIntegrationStateRow | null) => {
    const status = state?.status ?? 'not_configured';
    const stored = parseStored(state?.subscriptions);
    return {
      configured: lexware.client !== null,
      enabled: config.lexware.enabled,
      environment: config.appEnv,
      status,
      statusLabel: LEXWARE_STATUS_LABELS[status],
      companyName: state?.companyName ?? null,
      organizationIdShort: shortOrganizationId(state?.organizationId ?? null),
      connectionOk: status === 'connected',
      taxConfigComplete: await isTaxConfigComplete(db, config.appEnv),
      webhooks: {
        status: state?.webhookStatus ?? null,
        subscriptions: stored.map((s) => ({ eventType: s.eventType })),
        callbackUrl: config.lexware.webhookCallbackUrl,
        checkedAt: state?.webhooksCheckedAt?.toISOString() ?? null,
      },
      lastCheckedAt: state?.lastCheckedAt?.toISOString() ?? null,
      lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null,
      lastErrorCode: state?.lastErrorCode ?? null,
      apiKeyReminderDate: config.lexware.apiKeyReminderDate,
      pendingOrganizationId: state?.pendingOrganizationId ?? null,
      deeplinkBase: lexware.appBaseUrl,
    };
  };

  const sendLexwareError = (
    request: FastifyRequest,
    reply: FastifyReply,
    error: unknown,
  ): boolean => {
    if (error instanceof LexwareBlockedError || error instanceof LexwareReconcileRunningError) {
      sendError(request, reply, 409, error.code, error.message);
      return true;
    }
    if (error instanceof LexwareApiError) {
      sendError(
        request,
        reply,
        502,
        error.code,
        error.transient
          ? 'Lexware ist derzeit nicht erreichbar. Bitte später erneut versuchen.'
          : 'Lexware hat die Anfrage abgelehnt. Bitte Verbindung und Berechtigungen prüfen.',
      );
      return true;
    }
    return sendAuthError(request, reply, error);
  };

  app.get('/staff/lexware/status', async (request, reply) => {
    if ((await requireSettings(request, reply)) === null) return;
    return statusPayload(await connection.getState());
  });

  app.post('/staff/lexware/check-connection', async (request, reply) => {
    const context = await requireSettings(request, reply);
    if (context === null) return;
    const result = await connection.check(context.user.id);
    return { ok: result.ok, code: result.code, ...(await statusPayload(result.state)) };
  });

  app.post('/staff/lexware/setup-webhooks', async (request, reply) => {
    if ((await requireSettings(request, reply)) === null) return;
    try {
      const result = await subscriptions.setup();
      return {
        created: result.created,
        existing: result.existing,
        failed: result.failed,
        webhookStatus: result.webhookStatus,
        callbackUrl: result.callbackUrl,
      };
    } catch (error) {
      if (sendLexwareError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/lexware/reconcile', async (request, reply) => {
    if ((await requireSettings(request, reply)) === null) return;
    try {
      const result = await reconcile.run(new Date(), LEXWARE_RECONCILE_ADMIN_LIMIT, {
        exclusive: true,
      });
      return {
        checked: result.checked,
        updated: result.updated,
        attention: result.attention,
        failed: result.failed,
      };
    } catch (error) {
      if (sendLexwareError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/lexware/confirm-organization', async (request, reply) => {
    const context = await requireSettings(request, reply);
    if (context === null) return;
    const body = parseOrThrow(confirmOrganizationBody, request.body);
    try {
      await connection.confirmOrganization(context.user.id, body.organizationId);
      return statusPayload(await connection.getState());
    } catch (error) {
      if (sendLexwareError(request, reply, error)) return;
      throw error;
    }
  });
}
