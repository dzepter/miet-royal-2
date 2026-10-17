/**
 * Phase-10-Pflichttests PDF/Versand 106–113 (Order §§3/38/39/40/85):
 * keine Rechnungsdatei in documents/Storage, deliveryStatus 'pending', nie
 * 'sent', keine Versandbehauptung, Deeplink nur offizielle Struktur ohne
 * Key; Rechnungsdatei nur als Streaming-Proxy (accounting.view_reference)
 * ohne Persistenz.
 */
import { readdirSync } from 'node:fs';
import { documents } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { createStaffWithPermissions } from './crm-helpers.ts';
import {
  fakeInvoices,
  invoiceMappingFor,
  readyLexware,
  resetLexwareWorld,
  transferRowForSettlement,
} from './lexware-test-helpers.ts';
import { adminSession, settledReturn, settlementViewFor } from './settlement-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ lexware: true });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetLexwareWorld(ctx);
});

function storageFileCount(): number {
  const root = (ctx.storage as unknown as { root: string }).root;
  const walk = (dir: string): number =>
    readdirSync(dir, { withFileTypes: true }).reduce(
      (sum, entry) => sum + (entry.isDirectory() ? walk(`${dir}/${entry.name}`) : 1),
      0,
    );
  return walk(root);
}

describe('Rechnungsdatei und Versand (Tests 106–113)', () => {
  it('106.–111. Transfer legt keine documents-Zeile und keine Storage-Datei an; Versand „ausstehend“, nie „gesendet“; Deeplink offiziell ohne Key', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { world, view } = await settledReturn(ctx, admin.id, cookie);
    const documentsBefore = await ctx.db
      .select()
      .from(documents)
      .where(eq(documents.processId, world.processId));
    const filesBefore = storageFileCount();
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const documentsAfter = await ctx.db
      .select()
      .from(documents)
      .where(eq(documents.processId, world.processId));
    expect(documentsAfter).toHaveLength(documentsBefore.length);
    expect(documentsAfter.some((doc) => /rechnung|invoice/i.test(String(doc.type)))).toBe(false);
    expect(storageFileCount()).toBe(filesBefore);

    const current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.invoiceDeliveryStatus).toBe('pending');
    expect(current.settlement.accounting.invoice.deliveryStatus).toBe('pending');
    expect(current.settlement.accounting.invoice.deliveryLabel).toBe('Versand ausstehend');
    expect(JSON.stringify(current)).not.toMatch(/versendet|gesendet|"sent"/i);
    const row = (await transferRowForSettlement(ctx, view.settlement.id))!;
    const mapping = (await invoiceMappingFor(ctx, row.id))!;
    expect(mapping.deliveryStatus).toBe('pending');
    const deeplink = current.settlement.accounting.invoice.deeplink!;
    expect(deeplink).toBe(
      `https://app.lexware.de/permalink/invoices/view/${mapping.lexwareInvoiceId}`,
    );
    expect(deeplink).not.toContain(ctx.config.lexware.apiKey ?? 'NIE');
    expect(deeplink).not.toContain('?');
    // Sichtbarkeit der Zeile: 'sent' kann in Phase 10 nirgends gesetzt werden.
    const sent = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM settlements WHERE invoice_delivery_status = 'sent'
       UNION ALL SELECT count(*)::int FROM lexware_invoice_mappings WHERE delivery_status = 'sent'`,
    );
    expect(sent.rows.every((r) => (r as { n: number }).n === 0)).toBe(true);
  });

  it('112./113. Rechnungsdatei: Streaming nur mit accounting.view_reference, Content-Disposition, keine Persistenz; ohne Rechnung 404', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { world, view } = await settledReturn(ctx, admin.id, cookie);
    const missing = await ctx.app.inject({
      method: 'GET',
      url: `/staff/settlements/${view.settlement.id}/invoice-file`,
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const filesBefore = storageFileCount();
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/staff/settlements/${view.settlement.id}/invoice-file`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    const invoice = fakeInvoices(ctx)[0]!;
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="${invoice.voucherNumber}.pdf"`,
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(storageFileCount()).toBe(filesBefore);
    const docs = await ctx.db
      .select()
      .from(documents)
      .where(eq(documents.processId, world.processId));
    expect(docs.some((doc) => /rechnung|invoice/i.test(String(doc.type)))).toBe(false);

    const staff = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Ohne',
      lastName: 'Referenzrecht',
      email: 'ohne-referenz@test.example',
      password: 'ohne-referenz-12345',
      permissionKeys: ['process.view_all', 'settlement.view', 'process.view_completed'],
    });
    const forbidden = await ctx.app.inject({
      method: 'GET',
      url: `/staff/settlements/${view.settlement.id}/invoice-file`,
      headers: { cookie: staff.cookie },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
