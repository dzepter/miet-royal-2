import type { AppConfig } from '@mietroyal/config';
import { settlements, type Database } from '@mietroyal/database';
import type { JobRunner } from '@mietroyal/integrations';
import { parseOrThrow, z } from '@mietroyal/validation';
import { eq, isNotNull, and } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MockAccountingGateway, type AccountingGateway } from '../accounting/gateway.ts';
import type { AccountingTransferService } from '../accounting/transfer-service.ts';
import { requireAuth, requirePermission, sendAuthError, sendError } from '../auth/http.ts';
import type { StaffAuthService } from '../auth/service.ts';
import { UUID_PATTERN } from './auth.ts';

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const paymentStatusBody = z.strictObject({
  transferId: uuidSchema,
  status: z.enum(['open', 'paid', 'overdue']),
});
const failNextBody = z.strictObject({
  count: z.number().int().min(0).max(20),
  code: z.enum(['TRANSIENT', 'REJECTED']).optional(),
});
const expireWaitBody = z.strictObject({ settlementId: uuidSchema });

export interface AccountingRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  accountingGateway: AccountingGateway;
  transfers: AccountingTransferService;
  /** Nicht gestarteter Runner mit registrierten Finanz-Handlern (Mock „fällige Jobs ausführen“). */
  jobRunner: JobRunner;
}

/**
 * Buchhaltungs-Status und Mock-Steuerung (Phase-9-Vorgabe §42/§43, Tests
 * 145/147): Die Mock-Routen existieren NUR außerhalb von production und
 * verlangen system.settings. In production antworten sie mit 404 – es gibt
 * dort keine Mock-Buchhaltung, die man steuern könnte.
 */
export function registerAccountingRoutes(
  app: FastifyInstance,
  options: AccountingRouteOptions,
): void {
  const { db, auth, config, accountingGateway, transfers, jobRunner } = options;
  const mockAllowed = config.appEnv !== 'production';

  app.get('/staff/accounting/status', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'settlement.view'))) return;
    return {
      provider: accountingGateway.provider,
      configured: accountingGateway.isConfigured(),
      mock: accountingGateway.provider === 'mock',
      mockControlsAvailable: mockAllowed && accountingGateway instanceof MockAccountingGateway,
      environment: config.appEnv,
    };
  });

  const requireMockControl = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<MockAccountingGateway | null> => {
    if (!mockAllowed) {
      sendError(request, reply, 404, 'NOT_FOUND', 'Nicht gefunden.');
      return null;
    }
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return null;
    if (!(await requirePermission(request, reply, auth, context, 'system.settings'))) return null;
    if (!(accountingGateway instanceof MockAccountingGateway)) {
      sendError(
        request,
        reply,
        409,
        'CONFLICT',
        'Mock-Buchhaltung ist in dieser Umgebung nicht aktiv.',
      );
      return null;
    }
    return accountingGateway;
  };

  app.post('/staff/accounting/mock/payment-status', async (request, reply) => {
    if ((await requireMockControl(request, reply)) === null) return;
    const body = parseOrThrow(paymentStatusBody, request.body);
    try {
      const row = await transfers.setPaymentStatus(body.transferId, body.status);
      return { transferId: row.id, paymentStatus: row.paymentStatus, mock: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/accounting/mock/fail-next', async (request, reply) => {
    const mock = await requireMockControl(request, reply);
    if (mock === null) return;
    const body = parseOrThrow(failNextBody, request.body);
    mock.failNext(body.count, body.code ?? 'TRANSIENT');
    return { pendingFailures: mock.pendingFailureCount, mock: true };
  });

  app.post('/staff/accounting/mock/expire-wait', async (request, reply) => {
    if ((await requireMockControl(request, reply)) === null) return;
    const body = parseOrThrow(expireWaitBody, request.body);
    const expired = new Date(Date.now() - 60_000);
    const rows = await db
      .update(settlements)
      .set({ waitUntil: expired, updatedAt: new Date() })
      .where(and(eq(settlements.id, body.settlementId), isNotNull(settlements.waitUntil)))
      .returning({ id: settlements.id, waitUntil: settlements.waitUntil });
    if (rows[0] === undefined) {
      sendError(request, reply, 409, 'CONFLICT', 'Für diese Abrechnung läuft keine Frist.');
      return;
    }
    return {
      settlementId: rows[0].id,
      waitUntil: rows[0].waitUntil?.toISOString() ?? null,
      mock: true,
    };
  });

  app.post('/staff/accounting/mock/run-due-jobs', async (request, reply) => {
    if ((await requireMockControl(request, reply)) === null) return;
    let processed = 0;
    let failed = 0;
    for (let i = 0; i < 50; i += 1) {
      const outcome = await jobRunner.runOnce();
      if (outcome === 'idle') break;
      if (outcome === 'processed') processed += 1;
      else failed += 1;
    }
    return { processed, failed, mock: true };
  });
}
