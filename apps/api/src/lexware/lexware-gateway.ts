import { AuthError } from '../auth/service.ts';
import type { AccountingGateway, AccountingTransferResult } from '../accounting/gateway.ts';
import type { LexwareContext } from './context.ts';

/**
 * AccountingGateway-Provider „lexware“ (Order §4). Der eigentliche Transfer
 * läuft zweiphasig in `AccountingTransferService` (Vertrag §6, Agent B);
 * `transfer()` dieses Providers wird deshalb nie direkt aufgerufen.
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
        'LexwareAccountingGateway.transfer: zweiphasiger Pfad noch nicht implementiert (Agent B)',
      ),
    );
  }
}
