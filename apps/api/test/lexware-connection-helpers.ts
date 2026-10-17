/**
 * Gemeinsame Hilfen der Phase-10-Tests von Agent A (Verbindung, Webhooks,
 * Reconcile, Rate-Limit): Tabellen-Reset, Admin-Session, Fake-Rechnung und
 * eine erfolgreich übertragene Storno-Transferzeile mit Lexware-Mapping.
 * Die Mapping-/Transferzeilen werden per SQL/Drizzle direkt angelegt, damit
 * diese Tests nicht vom zweiphasigen Transferpfad (Agent B) abhängen.
 */
import { randomUUID } from 'node:crypto';
import { accountingTransfers, cancellations, lexwareInvoiceMappings } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { cancellationTransferIdempotencyKey } from '../src/accounting/gateway.ts';
import type { FakeLexwareServer } from '../src/lexware/testing/fake-server.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  login,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { createAcceptedBooking } from './scheduling-helpers.ts';

export async function truncateLexwareWorld(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE lexware_webhook_events, lexware_invoice_mappings, lexware_contact_mappings,
     lexware_integration_state, lexware_rate_limit, accounting_tax_config,
     accounting_transfers, cancellations, process_relations, integration_jobs CASCADE`,
  );
  await truncateAuthTables(pool);
  await truncateCommerceTables(pool);
}

export async function adminSession(ctx: TestContext) {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  return { admin, cookie: session.cookie };
}

/** Finalisierte Rechnung im Fake (über den echten Client, netto 100,00 € + 19 %). */
export async function createFakeInvoice(
  ctx: TestContext,
  options: { netCents?: number; remark?: string } = {},
): Promise<{ id: string; voucherNumber: string; grossCents: number; dueDate: string }> {
  const client = ctx.lexware.client;
  if (client === null) throw new Error('Lexware-Client im Testkontext fehlt');
  const net = (options.netCents ?? 10_000) / 100;
  const created = await client.createInvoice(
    {
      voucherDate: '2026-10-17T00:00:00.000+02:00',
      address: { name: 'Max Mustermann', countryCode: 'DE' },
      lineItems: [
        {
          type: 'custom',
          name: 'Maschinenmiete',
          quantity: 1,
          unitName: 'Pauschale',
          unitPrice: { currency: 'EUR', netAmount: net, taxRatePercentage: 19 },
        },
      ],
      totalPrice: { currency: 'EUR' },
      taxConditions: { taxType: 'net' },
      shippingConditions: {
        shippingType: 'service',
        shippingDate: '2026-10-17T00:00:00.000+02:00',
      },
      title: 'Rechnung',
      ...(options.remark === undefined ? {} : { remark: options.remark }),
    },
    true,
  );
  const fake = ctx.lexwareFake as FakeLexwareServer;
  const invoice = fake.invoices.get(created.data.id);
  if (invoice === undefined) throw new Error('Fake-Rechnung fehlt');
  return {
    id: invoice.id,
    voucherNumber: invoice.voucherNumber ?? '',
    grossCents: Math.round(invoice.totalPrice.totalGrossAmount * 100),
    dueDate: invoice.dueDate ?? '',
  };
}

/**
 * Erfolgreich übertragene Storno-Transferzeile (provider lexware, Zahlung
 * offen) samt Mapping auf eine Fake-Rechnung – entspricht dem Zustand nach
 * Phase 3 des zweiphasigen Transfers.
 */
export async function createMappedTransfer(
  ctx: TestContext,
  adminId: string,
  invoice: { id: string; voucherNumber: string; grossCents: number; dueDate: string },
  overrides: Partial<typeof lexwareInvoiceMappings.$inferInsert> = {},
) {
  const fake = ctx.lexwareFake as FakeLexwareServer;
  const world = await createAcceptedBooking(ctx, adminId);
  const now = new Date();
  const [cancellation] = await ctx.db
    .insert(cancellations)
    .values({
      processId: world.processId,
      bookingId: world.bookingId,
      cancelerType: 'employee',
      cancelerStaffId: adminId,
      cancelledAt: now,
      eventDate: '2026-08-01',
      remainingDays: 10,
      feePercent: 50,
      baseCents: invoice.grossCents,
      feeCents: invoice.grossCents,
      financeStatus: 'invoice_open',
      accountingProvider: 'lexware',
      accountingReference: invoice.voucherNumber,
      paymentStatus: 'open',
      transferredAt: now,
      invoiceDeliveryStatus: 'pending',
    })
    .returning();
  if (cancellation === undefined) throw new Error('Storno fehlt');
  const [transfer] = await ctx.db
    .insert(accountingTransfers)
    .values({
      kind: 'cancellation',
      cancellationId: cancellation.id,
      processId: world.processId,
      idempotencyKey: cancellationTransferIdempotencyKey(cancellation.id),
      status: 'succeeded',
      provider: 'lexware',
      snapshot: { schemaVersion: 1, kind: 'cancellation', test: true },
      snapshotHash: `test-${randomUUID()}`,
      attempts: 1,
      externalReference: invoice.voucherNumber,
      paymentStatus: 'open',
      transferredAt: now,
    })
    .returning();
  if (transfer === undefined) throw new Error('Transfer fehlt');
  await ctx.db
    .update(cancellations)
    .set({ accountingTransferId: transfer.id })
    .where(eq(cancellations.id, cancellation.id));
  const [mapping] = await ctx.db
    .insert(lexwareInvoiceMappings)
    .values({
      accountingTransferId: transfer.id,
      organizationId: fake.organizationId,
      transferMarker: `MRT-${randomUUID().slice(0, 10)}`,
      lexwareInvoiceId: invoice.id,
      voucherNumber: invoice.voucherNumber,
      voucherStatus: 'open',
      voucherDate: '2026-10-17',
      dueDate: invoice.dueDate.slice(0, 10),
      expectedGrossCents: invoice.grossCents,
      openAmountCents: invoice.grossCents,
      paymentStatus: 'open',
      lastSyncedAt: now,
      ...overrides,
    })
    .returning();
  if (mapping === undefined) throw new Error('Mapping fehlt');
  return { world, cancellation, transfer, mapping };
}

/** Signierter Webhook-Request gegen die App (Rohbytes, Header wie Lexware). */
export async function postWebhook(
  ctx: TestContext,
  body: string,
  signature: string | undefined,
  extraHeaders: Record<string, string> = {},
) {
  return ctx.app.inject({
    method: 'POST',
    url: '/webhooks/lexware',
    payload: body,
    headers: {
      'content-type': 'application/json',
      ...(signature === undefined ? {} : { 'x-lxo-signature': signature }),
      ...extraHeaders,
    },
  });
}
