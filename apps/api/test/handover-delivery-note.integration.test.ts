/**
 * Phase-6-Pflichttests 47–55 (Order §63): Lieferschein-Entwurf aus der
 * Buchung, konkrete Maschinen-IDs, tatsächliche Artikel, Editierbarkeit vor
 * Ausgabe ohne Snapshot-Mutation, finale Immutabilität, serverseitiges PDF,
 * verifizierbarer Hash, blockierter unberechtigter Zugriff.
 */
import { createHash } from 'node:crypto';
import { bookings, documents } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createTestContext,
  destroyTestContext,
  login,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { createStaffWithPermissions, truncateCrmTables } from './crm-helpers.ts';
import { productServiceFor, truncateCommerceTables } from './commerce-helpers.ts';
import { truncateSchedulingTables } from './scheduling-helpers.ts';
import { resetWarehouse } from './warehouse-helpers.ts';
import {
  handoverServicesFor,
  initializeAllInventory,
  pdfText,
  readyHandover,
  scheduledBooking,
  truncateHandoverTables,
} from './handover-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateHandoverTables(ctx.pool);
  await resetWarehouse(ctx.pool);
  await truncateSchedulingTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
});

async function adminSession() {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  return { admin, cookie: session.cookie };
}

describe('47.–51. Entwurf', () => {
  it('47./48./49. Entwurf entsteht aus der Buchung; konkrete Maschinen-IDs und tatsächliche Artikel erscheinen', async () => {
    const { admin, cookie } = await adminSession();
    const { handover, assignments } = handoverServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id, {
      selections: [{ slug: 'sirup-kirsche', role: 'free', quantity: 1 }],
    });
    const detail = await handover.detail(world.bookingId);
    expect(detail.deliveryNote.status).toBe('draft');
    expect(detail.deliveryNote.items.length).toBeGreaterThanOrEqual(3);
    const slot = detail.slots[0]!;
    const effective = await ctx.auth.effectivePermissions(admin.id);
    const machine = (
      await ctx.pool.query(`SELECT id FROM machines WHERE machine_code = 'MR-10-01-02'`)
    ).rows[0].id;
    await assignments.assign(admin.id, effective, slot.id, machine, null);
    const preview = await ctx.app.inject({
      method: 'GET',
      url: `/staff/handover/${world.bookingId}/delivery-note/preview`,
      headers: { cookie },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toContain('application/pdf');
    const pdf = pdfText(preview.rawPayload);
    expect(pdf.startsWith('%PDF')).toBe(true);
    expect(pdf).toContain('MR-10-01-02');
    expect(pdf).toContain('Sirup Kirsche');
    expect(pdf).toContain('Lieferschein (Entwurf)');
  });

  it('50./51. Der Entwurf ist vor der Ausgabe editierbar – der Buchungs-Snapshot bleibt unverändert', async () => {
    const { admin, cookie } = await adminSession();
    const { handover } = handoverServicesFor(ctx);
    const products = productServiceFor(ctx);
    const world = await scheduledBooking(ctx, admin.id);
    const before = (
      await ctx.db.select().from(bookings).where(eq(bookings.id, world.bookingId))
    )[0]!;
    const detail = await handover.detail(world.bookingId);
    const cups = detail.deliveryNote.items.find((item) => item.description.includes('Becher'))!;
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/handover/${world.bookingId}/items/${cups.id}`,
      headers: { cookie },
      payload: { actualQuantity: 0 },
    });
    expect(patch.statusCode).toBe(200);
    const syrup = await products.getProductBySlug('sirup-kirsche');
    const addition = await ctx.app.inject({
      method: 'POST',
      url: `/staff/handover/${world.bookingId}/additions`,
      headers: { cookie },
      payload: { productId: syrup.id, quantity: 2 },
    });
    expect(addition.statusCode).toBe(200);
    const after = (
      await ctx.db.select().from(bookings).where(eq(bookings.id, world.bookingId))
    )[0]!;
    expect(JSON.stringify(after.itemsSnapshot)).toBe(JSON.stringify(before.itemsSnapshot));
    expect(JSON.stringify(after.totalsSnapshot)).toBe(JSON.stringify(before.totalsSnapshot));
    const updated = await handover.detail(world.bookingId);
    expect(updated.deliveryNote.items.find((item) => item.id === cups.id)?.actualQuantity).toBe(0);
    // 2 L Sirup ohne gebuchtes Gratis-Kontingent: 1 L inklusive + 1 L Kommission.
    expect(updated.additions).toHaveLength(2);
    expect(updated.additions.reduce((sum, addition) => sum + addition.quantity, 0)).toBe(2);
    expect(updated.additions.map((addition) => addition.unitPriceCents).sort()).toEqual([0, 1200]);
  });
});

describe('52.–55. Finaler Lieferschein', () => {
  it('52./53./54. Final = immutable, serverseitiges PDF, Hash verifizierbar (Manipulation fällt auf)', async () => {
    const { admin } = await adminSession();
    const { handover, documentService } = handoverServicesFor(ctx);
    await initializeAllInventory(ctx, admin.id);
    const world = await scheduledBooking(ctx, admin.id);
    await readyHandover(ctx, admin.id, world.bookingId, ['MR-10-01-01']);
    const detail = await handover.finalize(admin.id, world.bookingId);
    expect(detail.deliveryNote.status).toBe('final');
    const documentId = detail.deliveryNote.documentId!;
    const cups = detail.deliveryNote.items.find((item) => item.description.includes('Becher'))!;
    await expect(handover.updateItemQuantity(world.bookingId, cups.id, 0)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const row = await documentService.byId(documentId);
    expect(row.type).toBe('delivery_note');
    expect(row.finalizedAt).not.toBeNull();
    const bytes = await documentService.bytesFor(row);
    expect(Buffer.from(bytes.subarray(0, 4)).toString()).toBe('%PDF');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256);
    expect(pdfText(bytes)).toContain('MR-10-01-01');
    // Manipulation im Storage → Integritätsprüfung schlägt an; Zeile bleibt.
    await ctx.storage.put(row.storageKey, new Uint8Array(Buffer.from('%PDF-manipuliert')), {
      contentType: 'application/pdf',
    });
    await expect(documentService.bytesFor(row)).rejects.toMatchObject({ code: 'CONFLICT' });
    const docs = await ctx.db
      .select()
      .from(documents)
      .where(eq(documents.bookingId, world.bookingId));
    expect(docs.filter((d) => d.type === 'delivery_note')).toHaveLength(1);
  });

  it('55. Ohne passendes Recht ist der Lieferschein nicht abrufbar; mit handover.view schon', async () => {
    const { admin } = await adminSession();
    const { handover } = handoverServicesFor(ctx);
    await initializeAllInventory(ctx, admin.id);
    const world = await scheduledBooking(ctx, admin.id);
    await readyHandover(ctx, admin.id, world.bookingId, ['MR-10-01-01']);
    const detail = await handover.finalize(admin.id, world.bookingId);
    const documentId = detail.deliveryNote.documentId!;
    const outsider = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Olga',
      lastName: 'Ohne',
      email: 'olga.ohne@test.example',
      password: 'olga-passwort-1234',
      permissionKeys: ['process.view_all'],
    });
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/staff/documents/${documentId}`,
      headers: { cookie: outsider.cookie },
    });
    expect(denied.statusCode).toBe(403);
    const viewer = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Vera',
      lastName: 'View',
      email: 'vera.view@test.example',
      password: 'vera-passwort-1234',
      permissionKeys: ['process.view_all', 'handover.view'],
    });
    const allowed = await ctx.app.inject({
      method: 'GET',
      url: `/staff/documents/${documentId}`,
      headers: { cookie: viewer.cookie },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['content-type']).toContain('application/pdf');
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/staff/documents/${documentId}`,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
