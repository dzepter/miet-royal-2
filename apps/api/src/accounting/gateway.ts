import type { AppConfig } from '@mietroyal/config';
import { AuthError } from '../auth/service.ts';

/**
 * Buchhaltungs-Gateway (Phase-9-Vorgabe §36–§40). Eine einzige Grenze
 * zwischen Abrechnung/Storno und der (späteren) echten Buchhaltung:
 *
 * - development/test/demo/staging: MockAccountingGateway – erzeugt eine
 *   deterministische MOCK-Referenz, löst keinerlei echte Rechnung aus und
 *   wird in der Oberfläche IMMER als „MOCK“ ausgewiesen.
 * - production: DisabledAccountingGateway – jede Übertragung wird hart mit
 *   „Buchhaltungsintegration nicht konfiguriert“ blockiert. Es wird niemals
 *   so getan, als sei etwas übertragen worden.
 *
 * Der Payload ist ein eingefrorener Snapshot (§37): Er wird VOR der
 * Übertragung in accounting_transfers gespeichert und danach nie geändert.
 * Steuerinformationen bewusst noch nicht enthalten (§3) – Phase 10 ergänzt
 * das Feld `tax` (heute immer null), ohne die Struktur zu brechen.
 */

export const ACCOUNTING_PROVIDERS = ['mock', 'disabled', 'lexware'] as const;
export type AccountingProvider = (typeof ACCOUNTING_PROVIDERS)[number];

export interface AccountingPayloadLine {
  /** Stabile Positions-ID (settlement_lines.id bzw. cancellation-<id>). */
  id: string;
  type: string;
  description: string;
  quantity: number;
  unit: string;
  unitPriceCents: number;
  amountCents: number;
  /** Credits mindern den Betrag; Belastungen erhöhen ihn. */
  direction: 'charge' | 'credit';
}

export interface AccountingPayloadCustomer {
  customerId: string;
  displayName: string;
  companyName: string | null;
  email: string | null;
  billingAddress: {
    street: string | null;
    postalCode: string | null;
    city: string | null;
  };
}

export interface AccountingPayload {
  schemaVersion: 1;
  kind: 'settlement' | 'cancellation';
  /** settlement.id bzw. cancellation.id – interne Referenz. */
  sourceId: string;
  processId: string;
  processNumber: string;
  bookingId: string;
  eventDate: string;
  customer: AccountingPayloadCustomer;
  lines: AccountingPayloadLine[];
  totals: {
    chargesCents: number;
    creditsCents: number;
    amountDueCents: number;
    overpaymentCents: number;
  };
  /** Storno-Zusatzangaben (§58) – nur bei kind = 'cancellation'. */
  cancellation?: {
    originalEventDate: string;
    regularMachinePriceCents: number;
    feePercent: number;
    feeCents: number;
    remainingDays: number;
  };
  /** Reserviert für Phase 10 (Steuersatz/-betrag). Heute immer null. */
  tax: null;
  /** Stabiler Idempotenzschlüssel – identisch mit accounting_transfers.idempotency_key. */
  idempotencyKey: string;
  createdAt: string;
}

export interface AccountingTransferRequest {
  idempotencyKey: string;
  payload: AccountingPayload;
  /** 1-basierter Versuch (für Logs/Mock-Fehlersimulation). */
  attempt: number;
}

export interface AccountingTransferResult {
  provider: AccountingProvider;
  externalReference: string;
  /** Neu angelegte Rechnungen sind immer offen (§42). */
  paymentStatus: 'open';
}

export class AccountingGatewayError extends Error {
  constructor(
    readonly code: 'NOT_CONFIGURED' | 'TRANSIENT' | 'REJECTED',
    message: string,
  ) {
    super(message);
    this.name = 'AccountingGatewayError';
  }
}

export interface AccountingGateway {
  readonly provider: AccountingProvider;
  /** false ⇒ jede Übertragung ist unmöglich (production ohne echte Anbindung). */
  isConfigured(): boolean;
  /** Wirft AuthError CONFLICT „Buchhaltungsintegration nicht konfiguriert“. */
  assertConfigured(): void;
  /**
   * Überträgt den eingefrorenen Payload. Dieselbe idempotencyKey muss beim
   * Gateway idempotent sein (Mock: liefert dieselbe Referenz erneut).
   */
  transfer(request: AccountingTransferRequest): Promise<AccountingTransferResult>;
}

export const ACCOUNTING_NOT_CONFIGURED_MESSAGE = 'Buchhaltungsintegration nicht konfiguriert';

export class DisabledAccountingGateway implements AccountingGateway {
  readonly provider = 'disabled' as const;

  isConfigured(): boolean {
    return false;
  }

  assertConfigured(): void {
    throw new AuthError(
      'CONFLICT',
      `${ACCOUNTING_NOT_CONFIGURED_MESSAGE}. Die Übertragung wird bewusst blockiert, statt eine Buchung vorzutäuschen.`,
    );
  }

  transfer(): Promise<AccountingTransferResult> {
    return Promise.reject(
      new AccountingGatewayError('NOT_CONFIGURED', ACCOUNTING_NOT_CONFIGURED_MESSAGE),
    );
  }
}

export interface MockAccountingCall {
  idempotencyKey: string;
  kind: AccountingPayload['kind'];
  attempt: number;
  externalReference: string;
  amountDueCents: number;
}

/**
 * Mock für development/test/demo/staging. Deterministisch: dieselbe
 * idempotencyKey ⇒ dieselbe Referenz (kein zweiter „Beleg“ bei Retry).
 * Fehlersimulation ausschließlich über failNext(); nie zufällig.
 */
export class MockAccountingGateway implements AccountingGateway {
  readonly provider = 'mock' as const;
  readonly calls: MockAccountingCall[] = [];
  private readonly references = new Map<string, string>();
  private pendingFailures = 0;
  private failureCode: 'TRANSIENT' | 'REJECTED' = 'TRANSIENT';
  private sequence = 0;

  isConfigured(): boolean {
    return true;
  }

  assertConfigured(): void {
    // Mock ist in Nicht-Production-Umgebungen immer verfügbar.
  }

  /** Nächste n Übertragungen scheitern (Retry-/Backoff-Tests, Mock-Steuerung). */
  failNext(count: number, code: 'TRANSIENT' | 'REJECTED' = 'TRANSIENT'): void {
    this.pendingFailures = Math.max(0, Math.floor(count));
    this.failureCode = code;
  }

  get pendingFailureCount(): number {
    return this.pendingFailures;
  }

  async transfer(request: AccountingTransferRequest): Promise<AccountingTransferResult> {
    if (this.pendingFailures > 0) {
      this.pendingFailures -= 1;
      throw new AccountingGatewayError(
        this.failureCode,
        this.failureCode === 'TRANSIENT'
          ? 'MOCK: Buchhaltung vorübergehend nicht erreichbar'
          : 'MOCK: Buchhaltung hat den Beleg abgelehnt',
      );
    }
    let reference = this.references.get(request.idempotencyKey);
    if (reference === undefined) {
      this.sequence += 1;
      const prefix = request.payload.kind === 'cancellation' ? 'MOCK-STORNO' : 'MOCK-RE';
      reference = `${prefix}-${request.payload.processNumber}-${String(this.sequence).padStart(4, '0')}`;
      this.references.set(request.idempotencyKey, reference);
    }
    this.calls.push({
      idempotencyKey: request.idempotencyKey,
      kind: request.payload.kind,
      attempt: request.attempt,
      externalReference: reference,
      amountDueCents: request.payload.totals.amountDueCents,
    });
    return { provider: 'mock', externalReference: reference, paymentStatus: 'open' };
  }
}

/**
 * Providerwahl (Phase 10, Order §4): production ⇒ lexware nur bei aktivem
 * Lexware-Kontext, sonst Disabled (nie Mock); demo ⇒ immer Mock;
 * development/staging ⇒ lexware nur per explizitem Opt-in, sonst Mock.
 * Der Lexware-Provider selbst wird von `lexwareGatewayFactory` geliefert
 * (apps/api/src/lexware/lexware-gateway.ts), damit dieses Modul frei von
 * Lexware-Abhängigkeiten bleibt.
 */
export function createAccountingGateway(
  config: AppConfig,
  lexware?: { client: unknown | null; gateway: () => AccountingGateway } | null,
): AccountingGateway {
  const lexwareActive = lexware !== undefined && lexware !== null && lexware.client !== null;
  if (config.appEnv === 'production') {
    return lexwareActive ? lexware.gateway() : new DisabledAccountingGateway();
  }
  if (config.appEnv === 'demo') return new MockAccountingGateway();
  return lexwareActive ? lexware.gateway() : new MockAccountingGateway();
}

/** Job-Typen auf der bestehenden PostgreSQL-Queue (§44). */
export const SETTLEMENT_ACCOUNTING_TRANSFER_JOB_TYPE = 'settlement.accounting_transfer';
export const CANCELLATION_ACCOUNTING_TRANSFER_JOB_TYPE = 'cancellation.accounting_transfer';

export function settlementTransferIdempotencyKey(settlementId: string): string {
  return `settlement-transfer:${settlementId}`;
}

export function cancellationTransferIdempotencyKey(cancellationId: string): string {
  return `cancellation-transfer:${cancellationId}`;
}
