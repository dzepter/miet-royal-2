/**
 * Phase-3-Pflichttests 44–54: finale PDFs (Erzeugung, korrekte Version,
 * Immutabilität, stabiler Hash), Zugriffsschutz (Staff-Recht, Token-Scope,
 * neutrales 404) und Auftragsbestätigung (vorbereitet → Freigabe →
 * Versand, Blockade ohne exakte Abholadresse). Läuft gegen PostgreSQL.
 */
import { createHash } from 'node:crypto';
import { documents, offerDeliveries, processes } from '@mietroyal/database';
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
import {
  commerceServices,
  createCommerceWorld,
  setPickupExactAddress,
  truncateCommerceTables,
} from './commerce-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
});

async function adminSession() {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  return { admin, cookie: session.cookie };
}

/** Welt mit versendetem V1-Angebot (Standard: Selbstabholung, Event +30 Tage). */
async function sentWorld(adminId: string) {
  const world = await createCommerceWorld(ctx, adminId);
  const services = commerceServices(ctx);
  const { offerId, versionId } = await services.offers.createOffer(adminId, world.processId);
  const effective = await ctx.auth.effectivePermissions(adminId);
  const { token } = await services.offers.send(adminId, versionId, effective);
  return { world, services, offerId, versionId, token, effective };
}

async function processNumberOf(processId: string): Promise<string> {
  const rows = await ctx.db
    .select({ processNumber: processes.processNumber })
    .from(processes)
    .where(eq(processes.id, processId));
  return rows[0]?.processNumber ?? '';
}

async function offerDocumentFor(versionId: string) {
  const rows = await ctx.db.select().from(documents).where(eq(documents.offerVersionId, versionId));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/**
 * Fließtext aus einem unkomprimierten PDF extrahieren: pdfkit schreibt
 * Text als Hex-Strings in TJ-Arrays (mit Kerning-Splits) – alle Hex-Teile
 * in Reihenfolge dekodieren und konkatenieren macht Wörter/Zeilen prüfbar.
 */
function pdfText(bytes: Buffer): string {
  const raw = bytes.toString('latin1');
  let out = '';
  for (const match of raw.matchAll(/<([0-9a-fA-F]+)>/g)) {
    const hex = match[1]!;
    if (hex.length % 2 === 0) out += Buffer.from(hex, 'hex').toString('latin1');
  }
  return out;
}

describe('44.–47. Finale Angebots-PDFs', () => {
  it('44./45. Nach dem Versand existiert das finale PDF und trägt die korrekte Version', async () => {
    const { admin, cookie } = await adminSession();
    const { world, versionId } = await sentWorld(admin.id);
    const document = await offerDocumentFor(versionId);
    expect(document.type).toBe('offer');
    expect(document.finalizedAt).not.toBeNull();
    expect(document.mimeType).toBe('application/pdf');

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/staff/documents/${document.id}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    const bytes = response.rawPayload;
    expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    // PDF unkomprimiert (compress:false) → Titel im Klartext prüfbar:
    const processNumber = await processNumberOf(world.processId);
    expect(bytes.includes(Buffer.from(`Angebot ${processNumber} V1`, 'latin1'))).toBe(true);
  });

  it('46. Finale PDFs sind immutable: V2-Versand lässt das V1-Dokument unverändert', async () => {
    const { admin } = await adminSession();
    const { world, services, offerId, versionId, effective } = await sentWorld(admin.id);
    const documentV1 = await offerDocumentFor(versionId);
    const bytesV1 = Buffer.from(await services.documents.bytesFor(documentV1));

    const next = await services.offers.createNewVersion(admin.id, offerId, 'Preis erneut geprüft');
    await services.offers.send(admin.id, next.versionId, effective);

    // V1-Dokumentzeile und -Bytes sind unverändert:
    const reread = await services.documents.byId(documentV1.id);
    expect(reread.sha256).toBe(documentV1.sha256);
    expect(reread.storageKey).toBe(documentV1.storageKey);
    expect(reread.byteSize).toBe(documentV1.byteSize);
    expect(Buffer.from(await services.documents.bytesFor(reread)).equals(bytesV1)).toBe(true);

    // V2 erhält ein EIGENES Dokument unter neuem Storage-Key:
    const documentV2 = await offerDocumentFor(next.versionId);
    expect(documentV2.id).not.toBe(documentV1.id);
    expect(documentV2.storageKey).not.toBe(documentV1.storageKey);
    const processNumber = await processNumberOf(world.processId);
    const bytesV2 = Buffer.from(await services.documents.bytesFor(documentV2));
    expect(bytesV2.includes(Buffer.from(`Angebot ${processNumber} V2`, 'latin1'))).toBe(true);
    expect(bytesV1.includes(Buffer.from(`Angebot ${processNumber} V1`, 'latin1'))).toBe(true);
  });

  it('47. Dokumenthash ist stabil; manipulierter Storage fällt bei der Integritätsprüfung auf', async () => {
    const { admin } = await adminSession();
    const { services, versionId } = await sentWorld(admin.id);
    const document = await offerDocumentFor(versionId);

    const first = Buffer.from(await services.documents.bytesFor(document));
    const second = Buffer.from(await services.documents.bytesFor(document));
    expect(first.equals(second)).toBe(true);
    expect(createHash('sha256').update(first).digest('hex')).toBe(document.sha256);
    expect(document.byteSize).toBe(first.length);

    // Manipulation am Storage-Objekt → Lesen schlägt mit Integritätsfehler fehl.
    await ctx.storage.put(document.storageKey, new Uint8Array(Buffer.from('%PDF-1.7 MANIPULIERT')));
    await expect(services.documents.bytesFor(document)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('48.–50. Zugriffsschutz', () => {
  it('48. Ohne offer.view kein Dokumentzugriff (403); ohne Login 401', async () => {
    const { admin } = await adminSession();
    const { versionId } = await sentWorld(admin.id);
    const document = await offerDocumentFor(versionId);

    const limited = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Doku',
      lastName: 'Los',
      email: 'doku.los@test.example',
      password: 'DokuLos!Passwort9',
      permissionKeys: ['customer.view'],
    });
    const forbidden = await ctx.app.inject({
      method: 'GET',
      url: `/staff/documents/${document.id}`,
      headers: { cookie: limited.cookie },
    });
    expect(forbidden.statusCode).toBe(403);

    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/staff/documents/${document.id}`,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('49. Ein Token sieht ausschließlich das eigene Angebot (kein IDOR)', async () => {
    const { admin } = await adminSession();
    const a = await sentWorld(admin.id);
    const b = await sentWorld(admin.id);
    expect(a.token).not.toBe(b.token);

    const viewA = await a.services.offers.publicView(a.token);
    const viewB = await b.services.offers.publicView(b.token);
    expect(viewA?.offerVersionId).toBe(a.versionId);
    expect(viewB?.offerVersionId).toBe(b.versionId);
    expect(viewA?.processNumber).not.toBe(viewB?.processNumber);

    const documentA = await a.services.offers.publicDocumentId(a.token);
    const documentB = await b.services.offers.publicDocumentId(b.token);
    expect(documentA).toBe((await offerDocumentFor(a.versionId)).id);
    expect(documentB).toBe((await offerDocumentFor(b.versionId)).id);
    expect(documentA).not.toBe(documentB);

    const routeA = await ctx.app.inject({ method: 'GET', url: `/public/offers/${a.token}` });
    expect(routeA.statusCode).toBe(200);
    const bodyA = routeA.json() as { offer: { processNumber: string } };
    expect(bodyA.offer.processNumber).toBe(await processNumberOf(a.world.processId));
  });

  it('50. Falsches oder rotiertes Token → neutrales 404 ohne Detailpreisgabe', async () => {
    const { admin } = await adminSession();
    const { services, offerId, token, effective } = await sentWorld(admin.id);

    const fake = 'a'.repeat(43);
    for (const url of [`/public/offers/${fake}`, `/public/offers/${fake}/pdf`]) {
      const response = await ctx.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: { message: 'Dieses Angebot ist nicht verfügbar.' },
      });
    }

    // Token-Rotation: Nach dem Versand von V2 ist das V1-Token widerrufen.
    const next = await services.offers.createNewVersion(admin.id, offerId, null);
    await services.offers.send(admin.id, next.versionId, effective);
    const revoked = await ctx.app.inject({ method: 'GET', url: `/public/offers/${token}` });
    expect(revoked.statusCode).toBe(404);
    expect(revoked.json()).toMatchObject({
      error: { message: 'Dieses Angebot ist nicht verfügbar.' },
    });
  });
});

describe('51.–54. Auftragsbestätigung', () => {
  it('51./52. Nach Annahme vorbereitet; ohne Freigabe kein Versand', async () => {
    const { admin, cookie } = await adminSession();
    const { world, services, token } = await sentWorld(admin.id);
    const { bookingId } = await services.offers.accept(token);

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${world.processId}/confirmation`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      booking: { id: string } | null;
      confirmation: { id: string; status: string } | null;
    };
    expect(body.booking?.id).toBe(bookingId);
    expect(body.confirmation?.status).toBe('prepared');

    // Versand vor der Freigabe ist blockiert – Service UND Route:
    await expect(services.confirmations.send(body.confirmation!.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const sendRoute = await ctx.app.inject({
      method: 'POST',
      url: `/staff/order-confirmations/${body.confirmation!.id}/send`,
      headers: { cookie },
    });
    expect(sendRoute.statusCode).toBe(409);
  });

  it('53. Selbstabhol-AB ohne pickup_exact_address blockiert; mit Adresse freigebbar', async () => {
    const { admin } = await adminSession();
    const { services, token } = await sentWorld(admin.id);
    const { bookingId } = await services.offers.accept(token);
    const confirmation = await services.confirmations.byBookingId(bookingId);
    expect(confirmation).not.toBeNull();

    // Blockade gilt in JEDER Umgebung (strenger als das Production-Minimum
    // der Vorgabe – dokumentierte Entscheidung): keine Adresse erfinden.
    const readiness = await services.confirmations.readinessFor(confirmation!);
    expect(readiness.blockers.some((b) => b.includes('pickup_exact_address'))).toBe(true);
    await expect(services.confirmations.approve(admin.id, confirmation!.id)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('pickup_exact_address') as string,
    });

    await setPickupExactAddress(ctx, admin.id);
    expect((await services.confirmations.readinessFor(confirmation!)).blockers).toHaveLength(0);
    await services.confirmations.approve(admin.id, confirmation!.id);

    const approved = await services.confirmations.byId(confirmation!.id);
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe(admin.id);
    expect(approved.documentId).not.toBeNull();

    // AB-PDF: exakte Abholadresse + Transporthinweise (2×10 → zwei Personen).
    const document = await services.documents.byId(approved.documentId!);
    const bytes = Buffer.from(await services.documents.bytesFor(document));
    const text = pdfText(bytes);
    expect(text).toContain('SYNTHETISCH');
    expect(text).toContain('Kofferraum');
    expect(text).toContain('aufrecht transportieren');
    expect(text).toContain('2 Personen zum Tragen erforderlich');
  });

  it('54. Finale AB ist immutable; Versand nach Freigabe läuft über die Outbox', async () => {
    const { admin } = await adminSession();
    const { services, token } = await sentWorld(admin.id);
    const { bookingId } = await services.offers.accept(token);
    const confirmation = await services.confirmations.byBookingId(bookingId);
    await setPickupExactAddress(ctx, admin.id);
    await services.confirmations.approve(admin.id, confirmation!.id);

    const approved = await services.confirmations.byId(confirmation!.id);
    const document = await services.documents.byId(approved.documentId!);
    const bytes = Buffer.from(await services.documents.bytesFor(document));

    // Erneute Freigabe (und damit erneute PDF-Erzeugung) ist blockiert:
    await expect(services.confirmations.approve(admin.id, confirmation!.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    await services.confirmations.send(confirmation!.id);
    const sent = await services.confirmations.byId(confirmation!.id);
    expect(sent.status).toBe('sent');
    expect(sent.sentAt).not.toBeNull();
    const outbox = await ctx.db
      .select()
      .from(offerDeliveries)
      .where(eq(offerDeliveries.orderConfirmationId, confirmation!.id));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.recipient).toBe('klara.kommerz@test.example');

    // Dokument nach dem Versand unverändert (Zeile + Bytes):
    const reread = await services.documents.byId(document.id);
    expect(reread.sha256).toBe(document.sha256);
    expect(Buffer.from(await services.documents.bytesFor(reread)).equals(bytes)).toBe(true);
  });
});
