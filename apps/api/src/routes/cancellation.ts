import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { JobQueue, StorageProvider } from '@mietroyal/integrations';
import type { FastifyInstance } from 'fastify';
import type { AccountingGateway } from '../accounting/gateway.ts';
import type { AccountingTransferService } from '../accounting/transfer-service.ts';
import type { StaffAuthService } from '../auth/service.ts';

export interface CancellationRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  storage: StorageProvider;
  queue: JobQueue;
  accountingGateway: AccountingGateway;
  transfers: AccountingTransferService;
}

/**
 * Storno-/Folgevorgangs-Routen (Phase 9 §§49–§65). Implementierung folgt im
 * CancellationService (Agent Storno) – siehe scratchpad/phase9_contracts.md.
 */
export function registerCancellationRoutes(
  _app: FastifyInstance,
  _options: CancellationRouteOptions,
): void {
  // Platzhalter – wird in Phase 9 gefüllt.
}
