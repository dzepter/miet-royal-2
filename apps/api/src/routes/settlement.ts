import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { JobQueue, StorageProvider } from '@mietroyal/integrations';
import type { FastifyInstance } from 'fastify';
import type { AccountingGateway } from '../accounting/gateway.ts';
import type { AccountingTransferService } from '../accounting/transfer-service.ts';
import type { StaffAuthService } from '../auth/service.ts';
import type { SettlementNoticeGateway } from '../settlement/notice-gateway.ts';

export interface SettlementRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  storage: StorageProvider;
  queue: JobQueue;
  accountingGateway: AccountingGateway;
  transfers: AccountingTransferService;
  noticeGateway: SettlementNoticeGateway;
}

/**
 * Abrechnungs-Routen (Phase 9 §§4–§48, §66–§70). Implementierung folgt im
 * SettlementService (Agent Abrechnung) – siehe scratchpad/phase9_contracts.md.
 */
export function registerSettlementRoutes(
  _app: FastifyInstance,
  _options: SettlementRouteOptions,
): void {
  // Platzhalter – wird in Phase 9 gefüllt.
}
