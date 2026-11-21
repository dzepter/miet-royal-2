/**
 * Phase 19 (Pilot-Readiness): Operator-Sicht auf Hintergrundjobs (Recht system.settings).
 * Rein lesend – es gibt bewusst keine Route, die einen Job als erfolgreich markiert oder
 * aus `dead` zurückholt; Wiederholungen laufen fachlich über die vorhandenen Funktionen
 * (Erneut senden, manueller Transfer, Reconcile, voucher:ensure).
 */
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import { requireAuth, requirePermission } from '../auth/http.ts';
import type { StaffAuthService } from '../auth/service.ts';
import { loadJobMonitorSnapshot } from '../system/job-monitor.ts';

export interface SystemJobRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
}

export function registerSystemJobRoutes(
  app: FastifyInstance,
  options: SystemJobRouteOptions,
): void {
  const { db, auth, config } = options;

  app.get('/staff/system/jobs', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'system.settings'))) return;
    return loadJobMonitorSnapshot(db);
  });
}
