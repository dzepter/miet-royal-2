/**
 * Phase 12 (transactional) – Pflichttests TRANSAKTION 17–38 (Order §42):
 * Angebot genau einmal + gültiger Link + Token nie in DB; AB mit finalem PDF;
 * Übergabe-/Rückgabeprotokoll als Mail-Intent unabhängig vom Mailerfolg;
 * Schaden-/Fehlteil-Information mit 24-h-Frist ERST nach Mailerfolg;
 * Stornobestätigung nur bewusst; Gutscheinmail (Code nur in der Payload,
 * sent löscht die Kopie, Hash bleibt, ohne E-Mail gültig); Lexware-Rechnung
 * transient (kein Storage-Put, sent, keine Doppelmail). Versand ausschließlich
 * über den FakeMailGateway des Test-Runners (nichts verlässt das System).
 */
import { randomUUID } from 'node:crypto';
import {
  cancellations,
  customerActionTokens,
  deliveryPackets,
  documents,
  handovers,
  mailDeliveries,
  orderConfirmations,
  rentalReturns,
  settlements,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatVoucherCode } from '@mietroyal/domain';
import { parseTransactionalKey } from '../src/communication/transactional/keys.ts';
import { enqueueInvoiceDelivery } from '../src/communication/invoice-delivery-job.ts';
import {
  enqueuePendingVoucherDeliveries,
  enqueueVoucherDelivery,
} from '../src/communication/voucher-delivery-job.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { bookedProcess, cancelBooking, resetForCancellationTests } from './cancellation-helpers.ts';
import {
  commerceServices,
  createCommerceWorld,
  setPickupExactAddress,
  truncateCommerceTables,
} from './commerce-helpers.ts';
import {
  invoiceMappingFor,
  readyLexware,
  resetLexwareWorld,
  transferRowForSettlement,
} from './lexware-test-helpers.ts';
import {
  handoverServicesFor,
  initializeAllInventory,
  readyHandover,
  scheduledBooking,
} from './handover-helpers.ts';
import { readyReturn, startedReturn } from './return-helpers.ts';
import {
  adminSession,
  drainAllJobs,
  openClarifications,
  post,
  sentNoticeMails,
  settledReturn,
  settlementViewFor,
} from './settlement-helpers.ts';
import {
  completeCleaningViaRoute,
  paidSettledWorld,
  payAndCompleteWorld,
  setPaymentViaRoute,
  truncateVoucherTables,
  vouchersForSettlement,
} from './voucher-helpers.ts';

const PUBLIC_BASE = 'https://web.test.example';
/** Mailversand explizit konfiguriert (Gateway bleibt der Fake des Testkontexts). */
const MAIL_ENV = {
  MAIL_ENABLED: 'true',
  MAIL_SMTP_HOST: 'smtp.test.example',
  MAIL_SMTP_USER: 'mailer@miet-royal.test',
  MAIL_SMTP_PASSWORD: 'smtp-password-only-for-tests',
  MAIL_FROM_NAME: 'Miet-Royal Mainz',
  MAIL_FROM_ADDRESS: 'noreply@miet-royal.test',
  MAIL_PUBLIC_WEB_BASE_URL: PUBLIC_BASE,
};
const HOUR = 3_600_000;

/** Mock-Buchhaltung (Angebot, AB, Protokolle, Kundeninformation, Storno, Gutschein). */
let ctx: TestContext;
/** Lexware-Contract-Fake (Rechnungsmail transient aus Lexware). */
let lexCtx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ env: MAIL_ENV });
  lexCtx = await createTestContext({ lexware: true, env: MAIL_ENV });
});
afterAll(async () => {
  await destroyTestContext(lexCtx);
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetLexwareWorld(lexCtx);
  await truncateVoucherTables(ctx.pool);
  await resetForCancellationTests(ctx);
  await truncateCommerceTables(ctx.pool);
  await ctx.pool.query(
    'TRUNCATE mail_deliveries, customer_action_tokens, integration_jobs CASCADE',
  );
  ctx.mailGateway.reset();
  lexCtx.mailGateway.reset();
});

async function deliveriesOfKind(kind: string, context: TestContext = ctx) {
  return (await context.db.select().from(mailDeliveries)).filter((row) => row.kind === kind);
}

const c = () => lexCtx;

/** Alle offenen Mailjobs der Welt-Erstellung abarbeiten und die Fake-Aufzeichnung leeren. */
async function settleWorldMails(context: TestContext = ctx): Promise<void> {
  await drainAllJobs(context);
  context.mailGateway.sent.length = 0;
  context.mailGateway.attempts.length = 0;
}

/** Keine Spalte der Outbox trägt den Klartext (Kontext, Betreff, Empfänger, Schlüssel). */
async function outboxContains(secret: string): Promise<boolean> {
  const rows = await ctx.pool.query<{ found: boolean }>(
    `SELECT bool_or(
       context::text LIKE $1 OR subject LIKE $1 OR idempotency_key LIKE $1
       OR recipient_email LIKE $1 OR coalesce(recipient_name, '') LIKE $1
     ) AS found FROM mail_deliveries`,
    [`%${secret}%`],
  );
  return rows.rows[0]?.found === true;
}

async function sentOffer() {
  const { admin, cookie } = await adminSession(ctx);
  const world = await createCommerceWorld(ctx, admin.id);
  const services = commerceServices(ctx);
  const { versionId } = await services.offers.createOffer(admin.id, world.processId);
  const effective = await ctx.auth.effectivePermissions(admin.id);
  const { token } = await services.offers.send(admin.id, versionId, effective);
  return { admin, cookie, world, services, versionId, token, effective };
}

describe('17.–19. Angebot', () => {
  it('17./19. Versand reiht GENAU EINE Zustellung je Version ein; Token nur verschlüsselt in der Outbox, nie im Klartext in der DB', async () => {
    const { token, versionId, services, admin, effective } = await sentOffer();
    const rows = await deliveriesOfKind('offer');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'pending',
      idempotencyKey: `offer:${versionId}`,
      recipientEmail: expect.stringContaining('@'),
    });
    expect(rows[0]!.secretPayloadCiphertext).not.toBeNull();
    expect(rows[0]!.secretPayloadCiphertext).not.toContain(token);
    expect(await outboxContains(token)).toBe(false);
    // Phase-5-Altbestand offer_deliveries wird nicht mehr befüllt.
    const legacy = await ctx.pool.query('SELECT count(*)::int AS n FROM offer_deliveries');
    expect(legacy.rows[0].n).toBe(0);
    // Eine Version kann nur einmal versendet werden ⇒ nie eine zweite Angebotsmail.
    await expect(services.offers.send(admin.id, versionId, effective)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await deliveriesOfKind('offer')).toHaveLength(1);
    const tokens = await ctx.pool.query(
      `SELECT token_hash FROM offer_access_tokens WHERE revoked_at IS NULL`,
    );
    expect(tokens.rows).toHaveLength(1);
    expect(tokens.rows[0].token_hash).not.toBe(token);
  });

  it('18. Nach dem Versandjob enthält die Mail den gültigen Angebotslink; der Link öffnet das Angebot; Secret-Payload danach gelöscht', async () => {
    const { token, versionId, cookie } = await sentOffer();
    await drainAllJobs(ctx);
    const rows = await deliveriesOfKind('offer');
    expect(rows[0]).toMatchObject({ status: 'sent', secretPayloadCiphertext: null });
    const mail = ctx.mailGateway.sent.find((m) => m.messageId === rows[0]!.messageId)!;
    expect(mail.text).toContain(`${PUBLIC_BASE}/angebot/${token}`);
    expect(mail.html).toContain(`${PUBLIC_BASE}/angebot/${token}`);
    expect(mail.text).toContain('Mit freundlichen Grüßen');
    const view = await ctx.app.inject({ method: 'GET', url: `/public/offers/${token}` });
    expect(view.statusCode).toBe(200);
    expect(view.json().offer.versionId ?? versionId).toBeDefined();
    const status = await ctx.app.inject({
      method: 'GET',
      url: `/staff/outbox`,
      headers: { cookie },
    });
    expect(status.statusCode).toBe(200);
    expect(JSON.stringify(status.json())).not.toContain(token);
  });
});

describe('20. Auftragsbestätigung', () => {
  it('20. Bewusste AB-Sendeaktion ⇒ queued; Mail mit finalem AB-PDF; sent erst nach Versand; Mailfehler ⇒ failed, erneute Aktion erzeugt neue Zustellung', async () => {
    const { token, services, admin } = await sentOffer();
    const { bookingId } = await services.offers.accept(token);
    const confirmation = (await services.confirmations.byBookingId(bookingId))!;
    await setPickupExactAddress(ctx, admin.id);
    await services.confirmations.approve(admin.id, confirmation.id);
    await settleWorldMails();
    ctx.mailGateway.nextOutcomes({ outcome: 'permanent_error', code: 'SMTP_550' });
    await services.confirmations.send(confirmation.id);
    let row = (await ctx.db.select().from(orderConfirmations))[0]!;
    expect(row.status).toBe('queued');
    await drainAllJobs(ctx);
    row = (await ctx.db.select().from(orderConfirmations))[0]!;
    expect(row.status).toBe('failed');
    expect(row.sentAt).toBeNull();
    const first = row.mailDeliveryId!;
    // Erneute bewusste Sendeaktion ⇒ neue Zustellung (Retry-Schlüssel), diesmal erfolgreich.
    await services.confirmations.send(confirmation.id);
    await drainAllJobs(ctx);
    row = (await ctx.db.select().from(orderConfirmations))[0]!;
    expect(row.status).toBe('sent');
    expect(row.sentAt).not.toBeNull();
    expect(row.mailDeliveryId).not.toBe(first);
    const deliveries = await deliveriesOfKind('order_confirmation');
    expect(deliveries.map((d) => d.status).sort()).toEqual(['failed', 'sent']);
    const sentDelivery = deliveries.find((d) => d.status === 'sent')!;
    expect(parseTransactionalKey(sentDelivery.idempotencyKey)).toEqual({
      kind: 'order_confirmation',
      entityId: confirmation.id,
    });
    const mail = ctx.mailGateway.sent.find((m) => m.messageId === sentDelivery.messageId)!;
    const document = await services.documents.byId(row.documentId!);
    const bytes = Buffer.from(await services.documents.bytesFor(document));
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0]!.filename).toMatch(/^Auftragsbestaetigung-.+\.pdf$/);
    expect(Buffer.from(mail.attachments[0]!.content).equals(bytes)).toBe(true);
  });
});

describe('21.–24. Übergabe-/Rückgabeprotokoll', () => {
  /** Übergabe finalisieren OHNE die Mail abzuarbeiten (anders als issuedBooking). */
  async function finalizedHandover(adminId: string) {
    await initializeAllInventory(ctx, adminId, 20);
    const world = await scheduledBooking(ctx, adminId, { machineQuantity: 1 });
    await settleWorldMails();
    await readyHandover(ctx, adminId, world.bookingId, ['MR-10-01-01']);
    await handoverServicesFor(ctx).handover.finalize(adminId, world.bookingId);
    return world;
  }

  it('21./22. Übergabe-Finalisierung reiht Lieferschein + Übergabeprotokoll ein; Transportabsturz im Job lässt die Übergabe final', async () => {
    const { admin } = await adminSession(ctx);
    const world = await finalizedHandover(admin.id);
    ctx.mailGateway.nextOutcomes({ outcome: 'throw' });
    const packet = (await ctx.db.select().from(deliveryPackets))[0]!;
    expect(packet).toMatchObject({ kind: 'handover_completed', status: 'queued' });
    const delivery = (await deliveriesOfKind('handover_protocol'))[0]!;
    expect(delivery.id).toBe(packet.mailDeliveryId);
    expect(delivery.attachments).toHaveLength(2);
    expect(delivery.idempotencyKey).toBe(`handover_protocol:${packet.handoverId}`);
    await drainAllJobs(ctx);
    // Härtung RA-12: unklare Zustellung (Transportabsturz) bleibt fachlich `queued` – nie
    // „fehlgeschlagen“ (der Kunde kann die Mail erhalten haben); erneut nur per Admin-Resend.
    const unclear = (await ctx.db.select().from(deliveryPackets))[0]!;
    expect(unclear.status).toBe('queued');
    expect(
      (await ctx.db.select().from(mailDeliveries).where(eq(mailDeliveries.id, delivery.id)))[0],
    ).toMatchObject({ status: 'outcome_unknown' });
    const handover = (
      await ctx.db.select().from(handovers).where(eq(handovers.bookingId, world.bookingId))
    )[0]!;
    expect(handover.status).toBe('finalized');
    expect(handover.protocolDocumentId).not.toBeNull();
  });

  it('21b. Erfolgreicher Versand ⇒ Paket sent mit beiden Anhängen (Lieferschein, Übergabeprotokoll)', async () => {
    const { admin } = await adminSession(ctx);
    await finalizedHandover(admin.id);
    await drainAllJobs(ctx);
    const packet = (await ctx.db.select().from(deliveryPackets))[0]!;
    expect(packet.status).toBe('sent');
    expect(packet.sentAt).not.toBeNull();
    const delivery = (await deliveriesOfKind('handover_protocol'))[0]!;
    const mail = ctx.mailGateway.sent.find((m) => m.messageId === delivery.messageId)!;
    expect(mail.attachments.map((a) => a.filename)).toEqual([
      expect.stringMatching(/^Lieferschein-.+\.pdf$/),
      expect.stringMatching(/^Uebergabeprotokoll-.+\.pdf$/),
    ]);
    expect(mail.attachments.every((a) => a.contentType === 'application/pdf')).toBe(true);
  });

  it('23./24. Rückgabe-Finalisierung reiht das Rückgabeprotokoll ein; permanenter Mailfehler lässt die Rückgabe final (Paket failed)', async () => {
    const { admin } = await adminSession(ctx);
    const { world, services } = await startedReturn(ctx, admin.id);
    await settleWorldMails();
    await readyReturn(ctx, admin.id, services, world.bookingId);
    ctx.mailGateway.nextOutcomes({ outcome: 'permanent_error', code: 'SMTP_550' });
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    const packet = (await ctx.db.select().from(deliveryPackets)).find(
      (p) => p.kind === 'return_completed',
    )!;
    expect(packet).toMatchObject({ status: 'queued', returnId: finalized.return.id });
    const delivery = (await deliveriesOfKind('return_protocol'))[0]!;
    expect(delivery.idempotencyKey).toBe(`return_protocol:${finalized.return.id}`);
    expect(delivery.attachments).toEqual([
      expect.objectContaining({ documentId: finalized.return.protocolDocumentId }),
    ]);
    await drainAllJobs(ctx);
    const after = (await ctx.db.select().from(deliveryPackets)).find(
      (p) => p.kind === 'return_completed',
    )!;
    expect(after.status).toBe('failed');
    const ret = (
      await ctx.db.select().from(rentalReturns).where(eq(rentalReturns.id, finalized.return.id))
    )[0]!;
    expect(ret.status).toBe('finalized');
  });

  it('24b. Ohne Kunden-E-Mail im Buchungs-Snapshot: Zustellung blocked NO_RECIPIENT, Paket failed, Rückgabe trotzdem final', async () => {
    const { admin } = await adminSession(ctx);
    const { world, services } = await startedReturn(ctx, admin.id);
    await settleWorldMails();
    await ctx.pool.query(
      `UPDATE bookings SET customer_snapshot = customer_snapshot - 'email' WHERE id = $1`,
      [world.bookingId],
    );
    await readyReturn(ctx, admin.id, services, world.bookingId);
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    expect(finalized.return.status).toBe('finalized');
    const packet = (await ctx.db.select().from(deliveryPackets)).find(
      (p) => p.kind === 'return_completed',
    )!;
    expect(packet.status).toBe('failed');
    const delivery = (await deliveriesOfKind('return_protocol'))[0]!;
    expect(delivery).toMatchObject({ status: 'blocked', blockedReason: 'NO_RECIPIENT' });
  });
});

describe('25.–27. Schaden-/Fehlteil-Information', () => {
  async function chargedDamage() {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, {
      damages: [{ description: 'Riss im Deckel', severity: 'light' }],
    });
    const clarification = openClarifications(view, 'damage_cost')[0]!;
    const decided = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/clarifications/${clarification.id}/resolve`,
      { decision: 'charge', amountCents: 5000, version: view.settlement.version },
    );
    expect(decided.status).toBe(200);
    await settleWorldMails();
    return {
      admin,
      cookie,
      world,
      view: await settlementViewFor(ctx.app, cookie, world.processId),
    };
  }

  it('25./26. Freigabe reiht ein (queued, keine Frist); erst der bestätigte Mailversand startet die 24 h; Mail enthält Positionen, Summe und Dokument-Link', async () => {
    const { cookie, world, view } = await chargedDamage();
    const sent = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/notice/approve-and-send`,
      { version: view.settlement.version },
    );
    expect(sent.status).toBe(200);
    let current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.notice).toMatchObject({ status: 'queued', gateway: 'mail' });
    expect(current.settlement.noticeSentAt).toBeNull();
    expect(current.settlement.waitUntil).toBeNull();
    expect(current.settlement.status).toBe('customer_notice_required');
    // Zweite Freigabe während des Versands ⇒ 409 (nie zwei Mails).
    const again = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/notice/approve-and-send`,
      { version: current.settlement.version },
    );
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe('NOTICE_ALREADY_QUEUED');
    const delivery = (await deliveriesOfKind('settlement_damage_missing_notice'))[0]!;
    expect(delivery.status).toBe('pending');
    const tokenRows = await ctx.db.select().from(customerActionTokens);
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toMatchObject({ purpose: 'document_view', processId: world.processId });

    await drainAllJobs(ctx);
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.notice!.status).toBe('sent');
    expect(current.settlement.noticeSentAt).not.toBeNull();
    const sentRow = (await sentNoticeMails(ctx))[0]!;
    expect(current.settlement.noticeSentAt).toBe(sentRow.sentAt!.toISOString());
    expect(
      new Date(current.settlement.waitUntil!).getTime() -
        new Date(current.settlement.noticeSentAt!).getTime(),
    ).toBe(24 * HOUR);
    expect(current.settlement.status).toBe('customer_waiting');
    expect(current.clarifications.find((c) => c.type === 'customer_notice')).toMatchObject({
      status: 'resolved',
      resolution: 'sent',
    });
    const mail = ctx.mailGateway.sent.find((m) => m.messageId === sentRow.messageId)!;
    expect(mail.text).toContain('Riss im Deckel');
    expect(mail.text).toContain('50,00');
    expect(mail.text).toMatch(/\/dokument\/[A-Za-z0-9_-]{43}/);
    expect(mail.text).not.toMatch(/Mahnung|rechtliche Schritte|Frist/i);
    const token = /\/dokument\/([A-Za-z0-9_-]{43})/.exec(mail.text)![1]!;
    expect(await outboxContains(token)).toBe(false);
    const pdf = await ctx.app.inject({ method: 'GET', url: `/public/documents/${token}` });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('inline');
    expect(pdf.headers['cache-control']).toBe('no-store');
    const returnRow = (
      await ctx.db.select().from(rentalReturns).where(eq(rentalReturns.id, world.returnId))
    )[0]!;
    const protocol = await ctx.db
      .select()
      .from(documents)
      .where(eq(documents.id, returnRow.protocolDocumentId!));
    expect(pdf.rawPayload.length).toBe(protocol[0]!.byteSize);
  });

  it('27. Mailfehler startet die 24 h NICHT: Notice failed, Transfer bleibt blockiert; erneute Freigabe ⇒ neue Zustellung ⇒ Frist erst nach Erfolg', async () => {
    const { cookie, world, view } = await chargedDamage();
    ctx.mailGateway.nextOutcomes({ outcome: 'permanent_error', code: 'SMTP_550' });
    const sent = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/notice/approve-and-send`,
      { version: view.settlement.version },
    );
    expect(sent.status).toBe(200);
    await drainAllJobs(ctx);
    let current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.notice).toMatchObject({ status: 'failed', blockedReason: 'SMTP_550' });
    expect(current.settlement.noticeSentAt).toBeNull();
    expect(current.settlement.waitUntil).toBeNull();
    expect(current.settlement.status).toBe('customer_notice_required');
    expect(await sentNoticeMails(ctx)).toHaveLength(0);
    const transfer = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/transfer`,
      {
        version: current.settlement.version,
      },
    );
    expect(transfer.status).toBe(409);
    expect(ctx.accounting.calls).toHaveLength(0);
    // Erneute Freigabe: neue Zustellung (Retry-Schlüssel), Erfolg ⇒ Frist beginnt jetzt.
    const retry = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/notice/approve-and-send`,
      { version: current.settlement.version },
    );
    expect(retry.status).toBe(200);
    await drainAllJobs(ctx);
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.notice!.status).toBe('sent');
    expect(current.settlement.status).toBe('customer_waiting');
    expect(await deliveriesOfKind('settlement_damage_missing_notice')).toHaveLength(2);
    expect(await sentNoticeMails(ctx)).toHaveLength(1);
  });

  it('26b. Dokument-Link: abgelaufenes oder fremdes Token ⇒ neutrales 404', async () => {
    const { cookie, world, view } = await chargedDamage();
    await post(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/notice/approve-and-send`,
      {
        version: view.settlement.version,
      },
    );
    await drainAllJobs(ctx);
    const mail = ctx.mailGateway.sent.at(-1)!;
    const token = /\/dokument\/([A-Za-z0-9_-]{43})/.exec(mail.text)![1]!;
    await ctx.pool.query(
      `UPDATE customer_action_tokens SET expires_at = now() - interval '1 minute'`,
    );
    const expired = await ctx.app.inject({ method: 'GET', url: `/public/documents/${token}` });
    expect(expired.statusCode).toBe(404);
    expect(expired.json().error.code).toBe('NOT_FOUND');
    const foreign = await ctx.app.inject({
      method: 'GET',
      url: `/public/documents/${randomUUID().replace(/-/g, '').padEnd(43, 'x')}`,
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).toBe(
      expired.body.replace(expired.json().error.correlationId, foreign.json().error.correlationId),
    );
    void world;
  });
});

describe('28. Stornobestätigung', () => {
  it('28. Storno erzeugt keine Mail; erst die bewusste Staff-Aktion reiht ein (queued ⇒ sent); 0 EUR ohne Rechnung', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const view = await cancelBooking(ctx, admin.id, world.processId);
    expect(view.confirmationStatus).toBe('prepared');
    expect(view.financeStatus).toBe('no_invoice');
    await drainAllJobs(ctx);
    expect(await deliveriesOfKind('cancellation_confirmation')).toHaveLength(0);
    expect(await deliveriesOfKind('invoice_delivery')).toHaveLength(0);
    const sent = await ctx.app.inject({
      method: 'POST',
      url: `/staff/cancellations/${view.id}/confirmation/send`,
      headers: { cookie },
      payload: {},
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().confirmationStatus).toBe('queued');
    const delivery = (await deliveriesOfKind('cancellation_confirmation'))[0]!;
    expect(delivery.idempotencyKey).toBe(`cancellation_confirmation:${view.id}`);
    expect(delivery.context).toMatchObject({ chargeCents: 0 });
    await drainAllJobs(ctx);
    const stored = (
      await ctx.db.select().from(cancellations).where(eq(cancellations.id, view.id))
    )[0]!;
    expect(stored.confirmationStatus).toBe('sent');
    expect(stored.confirmationSentAt).not.toBeNull();
    expect(stored.confirmationMailDeliveryId).toBe(delivery.id);
    expect(ctx.mailGateway.sent.filter((m) => m.subject.includes('Storno'))).toHaveLength(1);
  });
});

describe('29.–33. Gutscheinmail', () => {
  it('29./30./31./32. Gutschein ⇒ Versandjob ⇒ Mail mit Code (nur Secret-Payload); sent löscht die Versandkopie, Hash bleibt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await payAndCompleteWorld(ctx, admin.id, cookie);
    await drainAllJobs(ctx);
    const voucher = (await vouchersForSettlement(ctx, paid.settlementId))[0]!;
    expect(voucher.deliveryStatus).toBe('sent');
    expect(voucher.deliveredAt).not.toBeNull();
    expect(voucher.deliveryCodeCiphertext).toBeNull();
    expect(voucher.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(voucher.deliveryProblemCode).toBeNull();
    const delivery = (await deliveriesOfKind('voucher_delivery'))[0]!;
    expect(delivery).toMatchObject({
      status: 'sent',
      idempotencyKey: `voucher_delivery:${voucher.id}`,
      secretPayloadCiphertext: null,
    });
    expect(voucher.mailDeliveryId).toBe(delivery.id);
    const mail = ctx.mailGateway.sent.find((m) => m.messageId === delivery.messageId)!;
    const code = /MR20(?:-?[A-Z0-9]{4}){3}/.exec(mail.text)![0]!.replace(/-/g, '');
    expect(code).toHaveLength(16);
    expect(mail.text).toContain(formatVoucherCode(code));
    expect(mail.text).toMatch(/20 ?%/);
    // Klartext steht in keiner Klartextspalte der Outbox/Gutscheintabelle.
    expect(await outboxContains(code)).toBe(false);
    expect(await outboxContains(formatVoucherCode(code))).toBe(false);
    expect(JSON.stringify(voucher)).not.toContain(code);
    // Keine zweite Mail bei erneutem Job/Sweep.
    await enqueueVoucherDelivery(ctx.queue, voucher.id, 'again');
    expect(await enqueuePendingVoucherDeliveries({ db: ctx.db, queue: ctx.queue })).toBe(0);
    await drainAllJobs(ctx);
    expect(await deliveriesOfKind('voucher_delivery')).toHaveLength(1);
    expect(ctx.mailGateway.sent.filter((m) => m.messageId === delivery.messageId)).toHaveLength(1);
  });

  it('33. Ohne Kunden-E-Mail bleibt der Gutschein gültig (NO_EMAIL, keine Mail); „Gutschein jetzt senden“ nach Nachtrag der Adresse', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidSettledWorld(ctx, admin.id, cookie, { paymentStatus: 'open' });
    await ctx.pool.query(`UPDATE customers SET email = NULL WHERE id = $1`, [
      paid.world.customerId,
    ]);
    await setPaymentViaRoute(ctx, cookie, paid.transferId, 'paid');
    await completeCleaningViaRoute(ctx, cookie, paid.world.machineCodes[0]!);
    await drainAllJobs(ctx);
    const rows = await vouchersForSettlement(ctx, paid.settlementId);
    expect(rows).toHaveLength(1);
    const voucher = rows[0]!;
    expect(voucher).toMatchObject({
      status: 'active',
      deliveryStatus: 'pending',
      deliveryProblemCode: 'NO_EMAIL',
      mailDeliveryId: null,
    });
    expect(voucher.deliveryCodeCiphertext).not.toBeNull();
    expect(await deliveriesOfKind('voucher_delivery')).toHaveLength(0);
    // Staff-Aktion ohne E-Mail ⇒ 409; Kundenprofil zeigt Problemcode und canSendNow=false.
    const profileBefore = await ctx.app.inject({
      method: 'GET',
      url: `/staff/customers/${paid.world.customerId}`,
      headers: { cookie },
    });
    expect(profileBefore.json().voucher).toMatchObject({
      deliveryProblemCode: 'NO_EMAIL',
      canSendNow: false,
    });
    expect(profileBefore.body).not.toMatch(/codeHash|ciphertext/i);
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/staff/customers/${paid.world.customerId}/send-voucher`,
      headers: { cookie },
      payload: { voucherId: voucher.id },
    });
    expect(denied.statusCode).toBe(409);
    // IDOR: Gutschein nur über SEINEN Kunden (fremder/unbekannter Kunde ⇒ neutrales 404).
    const foreign = await ctx.app.inject({
      method: 'POST',
      url: `/staff/customers/${randomUUID()}/send-voucher`,
      headers: { cookie },
      payload: { voucherId: voucher.id },
    });
    expect(foreign.statusCode).toBe(404);
    await ctx.pool.query(`UPDATE customers SET email = $2 WHERE id = $1`, [
      paid.world.customerId,
      'nachtrag@test.example',
    ]);
    const profileAfter = await ctx.app.inject({
      method: 'GET',
      url: `/staff/customers/${paid.world.customerId}`,
      headers: { cookie },
    });
    expect(profileAfter.json().voucher.canSendNow).toBe(true);
    const sendNow = await ctx.app.inject({
      method: 'POST',
      url: `/staff/customers/${paid.world.customerId}/send-voucher`,
      headers: { cookie },
      payload: { voucherId: voucher.id },
    });
    expect(sendNow.statusCode).toBe(200);
    expect(sendNow.json()).toEqual({ queued: true, voucherId: voucher.id });
    await drainAllJobs(ctx);
    const after = (await vouchersForSettlement(ctx, paid.settlementId))[0]!;
    expect(after).toMatchObject({ deliveryStatus: 'sent', deliveryProblemCode: null });
    expect(after.deliveryCodeCiphertext).toBeNull();
    expect(after.codeHash).toBe(voucher.codeHash);
    const delivery = (await deliveriesOfKind('voucher_delivery'))[0]!;
    expect(delivery.recipientEmail).toBe('nachtrag@test.example');
    expect(delivery.status).toBe('sent');
  });
});

describe('34.–38. Lexware-Rechnung', () => {
  async function invoicedSettlement() {
    const { admin, cookie } = await adminSession(c());
    await readyLexware(c(), admin.id);
    const { world, view } = await settledReturn(c(), admin.id, cookie);
    // Jobs bis zum erfolgreichen Transfer (Rechnung) verarbeiten – danach ist
    // invoice.delivery eingereiht, aber noch nicht gelaufen.
    for (let i = 0; i < 20; i += 1) {
      const row = await transferRowForSettlement(c(), view.settlement.id);
      if (row?.status === 'succeeded') break;
      expect(await c().jobs.runOnce()).toBe('processed');
    }
    c().mailGateway.sent.length = 0;
    const current = await settlementViewFor(c().app, cookie, world.processId);
    expect(current.settlement.status).toBe('transferred');
    expect(current.settlement.invoiceDeliveryStatus).toBe('pending');
    const transferId = (await transferRowForSettlement(c(), view.settlement.id))!.id;
    const mapping = (await invoiceMappingFor(c(), transferId))!;
    expect(mapping.deliveryStatus).toBe('pending');
    return { admin, cookie, world, view, mapping, transferId };
  }

  it('34./35./36./37. Rechnungsmail nach Erfolg: PDF transient aus Lexware (kein Storage-Put, keine documents-Zeile), sent an Mapping + Abrechnung', async () => {
    const { cookie, world, mapping } = await invoicedSettlement();
    const putSpy = vi.spyOn(c().storage, 'put');
    const documentsBefore = await c().db.select().from(documents);
    await drainAllJobs(c());
    expect(putSpy).not.toHaveBeenCalled();
    putSpy.mockRestore();
    expect(await c().db.select().from(documents)).toHaveLength(documentsBefore.length);
    const delivery = (await deliveriesOfKind('invoice_delivery', c()))[0]!;
    expect(delivery).toMatchObject({
      status: 'sent',
      idempotencyKey: `invoice_delivery:${mapping.id}`,
      recipientEmail: 'klara.kommerz@test.example',
    });
    expect(delivery.attachments).toEqual([
      expect.objectContaining({
        kind: 'lexware_invoice',
        lexwareInvoiceId: mapping.lexwareInvoiceId,
      }),
    ]);
    const mail = c().mailGateway.sent.find((m) => m.messageId === delivery.messageId)!;
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0]!.filename).toBe(`Rechnung-${mapping.voucherNumber}.pdf`);
    expect(Buffer.from(mail.attachments[0]!.content).toString('utf8')).toContain('%PDF-1.4 FAKE');
    expect(mail.subject).toContain(mapping.voucherNumber!);
    const after = (await invoiceMappingFor(c(), mapping.accountingTransferId))!;
    expect(after).toMatchObject({ deliveryStatus: 'sent', mailDeliveryId: delivery.id });
    const current = await settlementViewFor(c().app, cookie, world.processId);
    expect(current.settlement.invoiceDeliveryStatus).toBe('sent');
    expect(current.settlement.accounting.invoice).toMatchObject({
      deliveryStatus: 'sent',
      deliveryLabel: 'Versendet',
    });
    const settlement = (await c().db.select().from(settlements))[0]!;
    expect(settlement.invoiceMailDeliveryId).toBe(delivery.id);
  });

  it('38. Automatisch nie doppelt: erneuter Job und erneuter Transferlauf erzeugen keine zweite Rechnungsmail', async () => {
    const { mapping } = await invoicedSettlement();
    await drainAllJobs(c());
    await enqueueInvoiceDelivery(c().queue, mapping.id);
    await c().pool.query(
      `UPDATE integration_jobs SET idempotency_key = idempotency_key || ':again' WHERE type = 'invoice.delivery' AND status = 'succeeded'`,
    );
    await enqueueInvoiceDelivery(c().queue, mapping.id);
    await drainAllJobs(c());
    expect(await deliveriesOfKind('invoice_delivery', c())).toHaveLength(1);
    expect(c().mailGateway.sent.filter((m) => m.subject.startsWith('Rechnung'))).toHaveLength(1);
  });

  it('36b. Mailfehler: Rechnung bleibt gültig, Abrechnung bleibt übertragen/gesperrt, Versandstatus failed (Mapping pending)', async () => {
    const { cookie, world, mapping } = await invoicedSettlement();
    c().mailGateway.nextOutcomes({ outcome: 'permanent_error', code: 'SMTP_550' });
    await drainAllJobs(c());
    const delivery = (await deliveriesOfKind('invoice_delivery', c()))[0]!;
    expect(delivery.status).toBe('failed');
    const current = await settlementViewFor(c().app, cookie, world.processId);
    expect(current.settlement.status).toBe('transferred');
    expect(current.settlement.locked).toBe(true);
    expect(current.settlement.invoiceDeliveryStatus).toBe('failed');
    expect((await invoiceMappingFor(c(), mapping.accountingTransferId))!.deliveryStatus).toBe(
      'pending',
    );
    expect(current.settlement.accounting.invoice.deliveryLabel).toBe('Versand ausstehend');
    // Manueller Resend (Outbox) ⇒ neue Zustellung, neue Message-ID ⇒ sent.
    const resend = await c().app.inject({
      method: 'POST',
      url: `/staff/communication/deliveries/${delivery.id}/resend`,
      headers: { cookie },
      payload: {},
    });
    expect(resend.statusCode).toBe(200);
    expect(resend.json().messageId).not.toBe(delivery.messageId);
    await drainAllJobs(c());
    expect((await invoiceMappingFor(c(), mapping.accountingTransferId))!.deliveryStatus).toBe(
      'sent',
    );
    const after = await settlementViewFor(c().app, cookie, world.processId);
    expect(after.settlement.invoiceDeliveryStatus).toBe('sent');
  });
});

describe('Rechnung bei Storno (Order §14)', () => {
  it('Kostenpflichtiges Storno: Stornobestätigung und Stornorechnung sind getrennte Zustellungen', async () => {
    const { admin, cookie } = await adminSession(c());
    await readyLexware(c(), admin.id);
    const world = await bookedProcess(c(), admin.id, { eventInDays: 3 });
    const view = await cancelBooking(c(), admin.id, world.processId);
    expect(view.feeCents).toBeGreaterThan(0);
    await drainAllJobs(c());
    const invoiceDeliveries = await deliveriesOfKind('invoice_delivery', c());
    expect(invoiceDeliveries).toHaveLength(1);
    expect(invoiceDeliveries[0]!.status).toBe('sent');
    const stored = (
      await c().db.select().from(cancellations).where(eq(cancellations.id, view.id))
    )[0]!;
    expect(stored.invoiceDeliveryStatus).toBe('sent');
    expect(stored.confirmationStatus).toBe('prepared');
    expect(await deliveriesOfKind('cancellation_confirmation', c())).toHaveLength(0);
    const confirm = await c().app.inject({
      method: 'POST',
      url: `/staff/cancellations/${view.id}/confirmation/send`,
      headers: { cookie },
      payload: {},
    });
    expect(confirm.statusCode).toBe(200);
    await drainAllJobs(c());
    const confirmation = (await deliveriesOfKind('cancellation_confirmation', c()))[0]!;
    expect(confirmation.status).toBe('sent');
    expect(confirmation.context).toMatchObject({ chargeCents: stored.feeCents });
    expect(await vouchersForSettlement(c(), randomUUID())).toEqual([]);
  });
});
