import { accountingTransfers, lexwareInvoiceMappings } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { FakeInvoice } from '../src/lexware/testing/fake-server.ts';
import { TaxConfigService } from '../src/lexware/tax-config-service.ts';
import type { TestContext } from './auth-helpers.ts';
import { resetSettlementWorld } from './settlement-helpers.ts';

/**
 * Phase-10-Testbausteine (Agent B): Lexware-Fake als aktiver Provider
 * (`createTestContext({ lexware: true })`), Verbindung über die ECHTE
 * Profilprüfung, synthetische Steuerkonfiguration (nur Test/Dev),
 * Fake-Steuerung über `/__control/*`.
 */

export async function resetLexwareWorld(ctx: TestContext): Promise<void> {
  await resetSettlementWorld(ctx);
  await ctx.pool.query(
    `TRUNCATE lexware_contact_mappings, lexware_invoice_mappings, lexware_webhook_events,
     lexware_integration_state, accounting_tax_config CASCADE`,
  );
  await fakeControl(ctx, 'reset');
  await fakeControl(ctx, 'profile', { taxType: 'net', smallBusiness: false });
}

export async function fakeControl(
  ctx: TestContext,
  action: string,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(`${ctx.config.lexware.baseUrl}/__control/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Fake-Steuerung ${action}: ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

/** Fehlerinjektion am Fake: `match` gegen `${METHOD} ${pathname}`. */
export async function failNext(
  ctx: TestContext,
  input: {
    match: string;
    status?: number;
    times?: number;
    mode?: 'status' | 'hang' | 'after_create';
    retryAfterSeconds?: number;
  },
): Promise<void> {
  await fakeControl(ctx, 'fail-next', { status: 500, times: 1, mode: 'status', ...input });
}

/** Verbindung prüfen (GET /v1/profile) ⇒ Zeile lexware_integration_state connected + organizationId gepinnt. */
export async function connectLexware(ctx: TestContext): Promise<void> {
  const result = await ctx.lexwareConnection.check();
  if (!result.ok) throw new Error(`Lexware-Verbindung nicht ok: ${result.code ?? ''}`);
}

export function taxConfigFor(ctx: TestContext): TaxConfigService {
  return new TaxConfigService(ctx.db, ctx.config.appEnv);
}

/** Synthetische Steuerkonfiguration (SYNTHETISCH markiert, nur außerhalb production). */
export async function syntheticTax(ctx: TestContext, adminId: string): Promise<void> {
  await taxConfigFor(ctx).applySyntheticDefaults(adminId);
}

/** Verbindung + synthetische Steuer: Standard-Vorbereitung eines Lexware-Tests. */
export async function readyLexware(ctx: TestContext, adminId: string): Promise<void> {
  await connectLexware(ctx);
  await syntheticTax(ctx, adminId);
}

export async function transferRowById(ctx: TestContext, transferId: string) {
  const rows = await ctx.db
    .select()
    .from(accountingTransfers)
    .where(eq(accountingTransfers.id, transferId));
  return rows[0] ?? null;
}

export async function transferRowForSettlement(ctx: TestContext, settlementId: string) {
  const rows = await ctx.db
    .select()
    .from(accountingTransfers)
    .where(eq(accountingTransfers.settlementId, settlementId));
  return rows[0] ?? null;
}

export async function transferRowForCancellation(ctx: TestContext, cancellationId: string) {
  const rows = await ctx.db
    .select()
    .from(accountingTransfers)
    .where(eq(accountingTransfers.cancellationId, cancellationId));
  return rows[0] ?? null;
}

export async function invoiceMappingFor(ctx: TestContext, transferId: string) {
  const rows = await ctx.db
    .select()
    .from(lexwareInvoiceMappings)
    .where(eq(lexwareInvoiceMappings.accountingTransferId, transferId));
  return rows[0] ?? null;
}

export function fakeInvoices(ctx: TestContext): FakeInvoice[] {
  return [...ctx.lexwareFake!.invoices.values()];
}

export function fakeRequests(ctx: TestContext, method: string, pathPrefix: string) {
  return ctx.lexwareFake!.requestLog.filter(
    (entry) => entry.method === method && entry.path.startsWith(pathPrefix),
  );
}

/** Manueller Transfer über die echte Route (Doppelklick-/Retry-Semantik). */
export async function transferSettlement(
  app: FastifyInstance,
  cookie: string,
  settlementId: string,
  version: number,
) {
  const response = await app.inject({
    method: 'POST',
    url: `/staff/settlements/${settlementId}/transfer`,
    headers: { cookie },
    payload: { version },
  });
  return {
    status: response.statusCode,
    body: response.json() as {
      outcome?: string;
      errorCode?: string;
      settlement?: Record<string, unknown>;
      error?: { code: string; message: string };
    },
  };
}

export async function jsonGet<T>(app: FastifyInstance, cookie: string, url: string) {
  const response = await app.inject({ method: 'GET', url, headers: { cookie } });
  return { status: response.statusCode, body: response.json() as T };
}

export async function jsonPost<T>(
  app: FastifyInstance,
  cookie: string,
  url: string,
  payload: Record<string, unknown> = {},
  method: 'POST' | 'PUT' = 'POST',
) {
  const response = await app.inject({ method, url, headers: { cookie }, payload });
  return { status: response.statusCode, body: response.json() as T };
}

/** Pending-Jobs sofort fällig stellen (Queue-Backoff überspringen). */
export async function makeJobsDue(ctx: TestContext): Promise<void> {
  await ctx.pool.query(
    `UPDATE integration_jobs SET run_at = now() - interval '1 minute' WHERE status = 'pending'`,
  );
}
