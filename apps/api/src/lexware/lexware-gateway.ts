import { AuthError } from '../auth/service.ts';
import type { AccountingGateway, AccountingTransferResult } from '../accounting/gateway.ts';
import type { LexwareTransferDeps } from '../accounting/transfer-service.ts';
import { LexwareConnectionService } from './connection-service.ts';
import { ContactSyncService } from './contact-sync-service.ts';
import type { LexwareContext } from './context.ts';
import { TaxConfigService } from './tax-config-service.ts';

/**
 * AccountingGateway-Provider „lexware“ (Order §4). Der eigentliche Transfer
 * läuft zweiphasig in `AccountingTransferService.executeTwoPhase` (Vertrag
 * §6); `transfer()` dieses Providers wird deshalb nie direkt aufgerufen.
 */
export class LexwareAccountingGateway implements AccountingGateway {
  readonly provider = 'lexware' as const;

  constructor(readonly lexware: LexwareContext) {}

  isConfigured(): boolean {
    return this.lexware.client !== null;
  }

  assertConfigured(): void {
    if (this.lexware.client === null) {
      throw new AuthError('CONFLICT', 'Buchhaltungsintegration nicht konfiguriert');
    }
  }

  transfer(): Promise<AccountingTransferResult> {
    return Promise.reject(
      new Error(
        'LexwareAccountingGateway.transfer: Lexware-Transfers laufen ausschließlich zweiphasig über AccountingTransferService',
      ),
    );
  }
}

/**
 * Abhängigkeiten des Zweiphasenpfads – eine Komposition für API, Worker und
 * Tests. `connection` kann geteilt werden (Admin-Routen nutzen dieselbe).
 */
export function createLexwareTransferDeps(
  lexware: LexwareContext,
  options: { connection?: LexwareConnectionService; workerId?: string } = {},
): LexwareTransferDeps {
  return {
    context: lexware,
    connection: options.connection ?? new LexwareConnectionService(lexware),
    taxConfig: new TaxConfigService(lexware.db, lexware.config.appEnv),
    contacts: new ContactSyncService(lexware),
    workerId: options.workerId ?? `api:${process.pid}`,
  };
}
