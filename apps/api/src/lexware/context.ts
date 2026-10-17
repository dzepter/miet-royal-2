import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import { LexwareClient } from './client.ts';
import {
  NoopLexwareThrottle,
  PostgresLexwareThrottle,
  type LexwareThrottle,
} from './rate-limiter.ts';

/**
 * Gemeinsamer Lexware-Kontext für API und Worker (Order §§4/10/11): genau ein
 * Client je Prozess, gemeinsamer Rate-Limit-Zustand in PostgreSQL. `client`
 * ist null, wenn Lexware für diese Umgebung nicht aktiv ist (demo immer,
 * production ohne Key, development/staging ohne Opt-in).
 */
export interface LexwareLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface LexwareContext {
  config: AppConfig;
  db: Database;
  logger: LexwareLogger;
  throttle: LexwareThrottle;
  /** null ⇒ Lexware in dieser Umgebung nicht aktiv. */
  client: LexwareClient | null;
  /** Fester App-Link für Deeplinks (offizielle Permalink-Struktur). */
  appBaseUrl: string;
}

export const LEXWARE_APP_BASE_URL = 'https://app.lexware.de';

export function createLexwareContext(
  config: AppConfig,
  db: Database,
  logger: LexwareLogger,
  options: { throttle?: LexwareThrottle; fetchImpl?: typeof fetch } = {},
): LexwareContext {
  const throttle =
    options.throttle ??
    (config.lexware.enabled ? new PostgresLexwareThrottle(db) : new NoopLexwareThrottle());
  const client =
    config.lexware.enabled && config.lexware.apiKey !== null
      ? new LexwareClient({
          baseUrl: config.lexware.baseUrl,
          apiKey: config.lexware.apiKey,
          timeoutMs: config.lexware.requestTimeoutMs,
          throttle,
          logger,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        })
      : null;
  return { config, db, logger, throttle, client, appBaseUrl: LEXWARE_APP_BASE_URL };
}

/** Offizielle Deeplink-Struktur (docs/LEXWARE_API_NOTES.md) – nur mit validierter UUID. */
export function lexwareInvoiceDeeplink(appBaseUrl: string, invoiceId: string): string | null {
  return /^[0-9a-f-]{36}$/i.test(invoiceId)
    ? `${appBaseUrl}/permalink/invoices/view/${invoiceId}`
    : null;
}

export function lexwareContactDeeplink(appBaseUrl: string, contactId: string): string | null {
  return /^[0-9a-f-]{36}$/i.test(contactId)
    ? `${appBaseUrl}/permalink/contacts/view/${contactId}`
    : null;
}

/** Zahlungsstatus-Normalisierung (Order §41) – eine Implementierung für Webhook, Reconcile und Transfer. */
export function normalizeLexwarePaymentStatus(input: {
  voucherStatus: string;
  paymentStatus?: string | undefined;
  openAmountCents?: number | undefined;
  dueDate?: string | null | undefined;
  todayBerlinIso: string;
}): 'open' | 'paid' | 'overdue' | 'attention' {
  if (input.voucherStatus === 'voided') return 'attention';
  if (
    input.voucherStatus === 'paid' ||
    input.paymentStatus === 'balanced' ||
    input.openAmountCents === 0
  )
    return 'paid';
  if (input.voucherStatus === 'draft') return 'attention';
  const due = input.dueDate?.slice(0, 10);
  if (due !== undefined && due !== null && due < input.todayBerlinIso) return 'overdue';
  return 'open';
}

export function berlinTodayIso(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
