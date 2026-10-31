import { documents } from '@mietroyal/database';
import { PDF_TITLE_PREFIX_DEMO } from '@mietroyal/documents';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PDF_DEMO_ENVIRONMENT_LABEL,
  pdfEnvironmentLabel,
  pdfRenderOptions,
} from '../src/documents/environment-label.ts';
import {
  bootstrapAdmin,
  createTestContext,
  destroyTestContext,
  type TestContext,
} from './auth-helpers.ts';
import {
  commerceServices,
  createCommerceWorld,
  setPickupExactAddress,
} from './commerce-helpers.ts';
import { createDemoTestContext, freshDemoDatabase, wipeDemoTestDatabase } from './demo-helpers.ts';
import { handoverServicesFor, pdfText, scheduledBooking } from './handover-helpers.ts';
import { issuedBooking, readyReturn, startedReturn } from './return-helpers.ts';

/**
 * Phase 14 (RESET, Order §89, Design Teil 2 §2.6): sichtbare Demo-Kennzeichnung
 * der Kundendokumente. In APP_ENV=demo tragen Angebot, Auftragsbestätigung,
 * Lieferschein (Entwurf und final), Übergabe- und Rückgabeprotokoll die Zeile
 * „DEMO – keine echten Kundendaten“ und den Titelpräfix „DEMO · “; in
 * development (und damit production, gleicher Codepfad ohne Label) nicht.
 * Läuft gegen eine eigene Test-DB.
 */

/**
 * Dokumenttitel aus den PDF-Metadaten: pdfkit schreibt `/Title <n> 0 R` und das
 * Objekt als Literal `(…)` – bei Nicht-ASCII als UTF-16BE mit BOM (þÿ).
 */
function pdfTitle(bytes: Uint8Array | Buffer): string {
  const raw = Buffer.from(bytes).toString('latin1');
  const reference = /\/Title (\d+) 0 R/.exec(raw);
  const scope = reference === null ? raw : raw.slice(raw.indexOf(`\n${reference[1]} 0 obj`));
  const literal = /\((?:\\.|[^)])*\)/.exec(scope);
  if (literal === null) return '';
  const inner = literal[0].slice(1, -1).replace(/\\(.)/g, '$1');
  const bytesOfLiteral = Buffer.from(inner, 'latin1');
  if (bytesOfLiteral[0] === 0xfe && bytesOfLiteral[1] === 0xff) {
    return bytesOfLiteral.subarray(2).swap16().toString('utf16le');
  }
  return inner;
}

/** Beide Textbestandteile des Labels (ASCII-sicher; der Gedankenstrich ist WinAnsi-kodiert). */
function expectLabel(bytes: Uint8Array | Buffer, present: boolean, what: string): void {
  const text = pdfText(bytes);
  expect(/keine\s*echten\s*Kundendaten/.test(text), `${what}: Label-Text`).toBe(present);
  expect(/DEMO/.test(text), `${what}: DEMO`).toBe(present);
  const title = pdfTitle(bytes);
  expect(title.length, `${what}: Titel`).toBeGreaterThan(0);
  expect(title.startsWith(PDF_TITLE_PREFIX_DEMO), `${what}: Titelpräfix (${title})`).toBe(present);
}

interface Rendered {
  offerFinal: Buffer;
  offerPreview: Buffer;
  confirmation: Buffer;
  deliveryNoteDraft: Buffer;
  deliveryNoteFinal: Buffer;
  handoverProtocol: Buffer;
  returnProtocol: Buffer;
}

/** Alle fünf Dokumentarten über die echten Fachpfade erzeugen (Offer/AB, Lieferschein, Protokolle). */
async function renderAll(ctx: TestContext, adminId: string): Promise<Rendered> {
  const services = commerceServices(ctx);
  const world = await createCommerceWorld(ctx, adminId);
  const { versionId } = await services.offers.createOffer(adminId, world.processId);
  const effective = await ctx.auth.effectivePermissions(adminId);
  const offerPreview = Buffer.from(await services.offers.renderPreviewPdf(versionId));
  const { token } = await services.offers.send(adminId, versionId, effective);
  const [offerDocument] = await ctx.db
    .select()
    .from(documents)
    .where(eq(documents.offerVersionId, versionId));
  const offerFinal = Buffer.from(await services.documents.bytesFor(offerDocument!));
  const { bookingId } = await services.offers.accept(token);
  const confirmation = await services.confirmations.byBookingId(bookingId);
  await setPickupExactAddress(ctx, adminId);
  await services.confirmations.approve(adminId, confirmation!.id);
  const approved = await services.confirmations.byId(confirmation!.id);
  const confirmationBytes = Buffer.from(
    await services.documents.bytesFor(await services.documents.byId(approved.documentId!)),
  );
  // Lieferschein-Entwurf (Vorschau vor der Übergabe).
  const draftBooking = await scheduledBooking(ctx, adminId);
  const handover = handoverServicesFor(ctx);
  await handover.handover.ensureForBooking(draftBooking.bookingId, adminId);
  const deliveryNoteDraft = Buffer.from(
    await handover.handover.renderDeliveryNotePreview(draftBooking.bookingId),
  );
  // Übergabe finalisiert ⇒ finaler Lieferschein + Übergabeprotokoll; danach Rückgabe ⇒ Rückgabeprotokoll.
  const issued = await issuedBooking(ctx, adminId, { machineCodes: ['MR-10-01-02'] });
  const finals = await ctx.db
    .select()
    .from(documents)
    .where(eq(documents.bookingId, issued.bookingId));
  const deliveryNote = finals.find((d) => d.type === 'delivery_note' && d.finalizedAt !== null);
  const protocol = finals.find((d) => d.type === 'handover_protocol');
  const returnWorld = await startedReturn(ctx, adminId, {
    machineCodes: ['MR-10-01-04'],
    skipInventoryInit: true,
  });
  await readyReturn(ctx, adminId, returnWorld.services, returnWorld.world.bookingId);
  await returnWorld.services.returns.finalize(adminId, returnWorld.world.bookingId);
  const returnDocuments = (
    await ctx.db.select().from(documents).where(eq(documents.type, 'return_protocol'))
  ).filter((d) => d.bookingId === returnWorld.world.bookingId);
  expect(returnDocuments.length).toBeGreaterThanOrEqual(1);
  const bytesOf = async (document: (typeof finals)[number] | undefined, what: string) => {
    if (document === undefined) throw new Error(`${what} fehlt`);
    return Buffer.from(await services.documents.bytesFor(document));
  };
  return {
    offerFinal,
    offerPreview,
    confirmation: confirmationBytes,
    deliveryNoteDraft,
    deliveryNoteFinal: await bytesOf(deliveryNote, 'finaler Lieferschein'),
    handoverProtocol: await bytesOf(protocol, 'Übergabeprotokoll'),
    returnProtocol: await bytesOf(returnDocuments[0], 'Rückgabeprotokoll'),
  };
}

describe('Phase 14 – Demo-Kennzeichnung der PDFs (Order §89)', () => {
  let demo: TestContext;
  let dev: TestContext;

  beforeAll(async () => {
    demo = await createDemoTestContext();
    dev = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await destroyTestContext(demo);
    await destroyTestContext(dev);
  });

  it('Helfer: Label nur in demo; Render-Optionen leer außerhalb', () => {
    expect(pdfEnvironmentLabel({ appEnv: 'demo' })).toBe(PDF_DEMO_ENVIRONMENT_LABEL);
    expect(PDF_DEMO_ENVIRONMENT_LABEL).toBe('DEMO – keine echten Kundendaten');
    for (const appEnv of ['development', 'staging', 'production'] as const) {
      expect(pdfEnvironmentLabel({ appEnv })).toBeUndefined();
      expect(pdfRenderOptions({ appEnv })).toEqual({});
    }
    expect(pdfRenderOptions({ appEnv: 'demo' })).toEqual({
      environmentLabel: PDF_DEMO_ENVIRONMENT_LABEL,
    });
  });

  it('Demo: Angebots-PDF (final + Vorschau), Auftragsbestätigung, Lieferschein (Entwurf + final), Übergabe- und Rückgabeprotokoll tragen „DEMO – keine echten Kundendaten“ und den Titelpräfix „DEMO · “', async () => {
    const { adminId } = await freshDemoDatabase(demo);
    const rendered = await renderAll(demo, adminId);
    for (const [what, bytes] of Object.entries(rendered)) expectLabel(bytes, true, what);
    // Mehrseitiges Dokument: die Zeile wiederholt sich auf jeder Seite (Rückgabeprotokoll mit Fotos/Unterschriften).
    const pages = (pdfText(rendered.returnProtocol).match(/\/Type \/Page[^s]/g) ?? []).length;
    const labels = (pdfText(rendered.returnProtocol).match(/keine\s*echten\s*Kundendaten/g) ?? [])
      .length;
    expect(labels).toBeGreaterThanOrEqual(Math.max(1, pages));
  }, 120_000);

  it('Development: dieselben Dokumente enthalten weder Label noch Präfix (unveränderter Codepfad ohne Umgebungs-Label; gilt ebenso für production)', async () => {
    await wipeDemoTestDatabase(dev.pool);
    const admin = await bootstrapAdmin(dev);
    const rendered = await renderAll(dev, admin.id);
    for (const [what, bytes] of Object.entries(rendered)) expectLabel(bytes, false, what);
  }, 120_000);
});
