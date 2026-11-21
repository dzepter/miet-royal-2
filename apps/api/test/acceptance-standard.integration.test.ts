/**
 * Phase 18 – Szenario A „Standardvermietung“ als Abnahmekette auf API-Ebene
 * (Karte A, Matrix „Szenario A“): Website-Anfrage → Angebot → Online-Annahme →
 * AB → Termine → Zuweisung/Vorbereitung → Übergabe → Rückgabe → Abrechnung →
 * Buchhaltungstransfer (Mock) → Zahlung → Reinigung → Gutschein → Kundenportal.
 *
 * Jeder Schritt läuft über die ECHTEN Routen (`ctx.app.inject`) bzw. – wo die
 * Bestandshelfer den Wizard abbilden – über dieselben Services wie die Routen.
 * Geprüft werden je Schritt API-Ergebnis, DB-Zustand und Idempotenz (Replay,
 * Doppelklick, paralleler Aufruf, Job-Wiederholung). Am Ende läuft der
 * gemeinsame Integritätscheck (`acceptance-integrity.ts`) ohne Ausnahme.
 *
 * Die Schritte teilen Zustand (`A`) und laufen in Dateireihenfolge; scheitert
 * ein Schritt, nennen die folgenden die fehlende Voraussetzung statt eines
 * zufälligen Folgefehlers.
 *
 * Teil 2 (P18-A15–A17) wiederholt den Finanzteil kurz mit dem Lexware-Contract-
 * Fake (`createTestContext({ lexware: true })`): genau eine Rechnung im Fake,
 * doppelter signierter Webhook ⇒ ein Ereignis, Zahlung „bezahlt“ per Webhook.
 *
 * Nur Fakes/Mocks: MockAccountingGateway, FakeMailGateway (MAIL_ENV schaltet den
 * Versand fachlich frei, Gateway bleibt der Fake), FakeLexwareServer in-process.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settlementTransferIdempotencyKey } from '../src/accounting/gateway.ts';
import type { FakeLexwareServer } from '../src/lexware/testing/fake-server.ts';
import type {
  PortalBookingSummary,
  PortalBookingView,
  PortalDocumentView,
} from '../src/portal/views.ts';
import { PORTAL_DOCUMENT_LABELS } from '../src/portal/views.ts';
import {
  documentStorageMismatches,
  integrityViolations,
  tableCounts,
} from './acceptance-integrity.ts';
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
import { publishPrivacyForTests, truncateCmsTables } from './cms-helpers.ts';
import {
  ensureTestTerms,
  setPickupExactAddress,
  truncateCommerceTables,
} from './commerce-helpers.ts';
import { truncateCommunicationTables } from './communication-helpers.ts';
import { truncateCrmTables } from './crm-helpers.ts';
import {
  DAYS,
  handoverServicesFor,
  initializeAllInventory,
  pngBytes,
  truncateHandoverTables,
} from './handover-helpers.ts';
import { postWebhook } from './lexware-connection-helpers.ts';
import {
  fakeInvoices,
  fakeRequests,
  invoiceMappingFor,
  readyLexware,
  resetLexwareWorld,
  transferRowForSettlement,
  transferSettlement,
} from './lexware-test-helpers.ts';
import { truncatePortalTables } from './portal-auth-helpers.ts';
import { forbiddenKeysIn, portalGet, portalSessionFor } from './portal-test-helpers.ts';
import { inquiryBody, postInquiry } from './public-helpers.ts';
import { readyReturn } from './return-helpers.ts';
import { truncateSchedulingTables } from './scheduling-helpers.ts';
import {
  adminSession,
  drainAllJobs,
  settledReturn,
  settlementViewFor,
  truncateSettlementTables,
} from './settlement-helpers.ts';
import { truncateVoucherTables } from './voucher-helpers.ts';
import { machineByCode, productBySlug, resetWarehouse } from './warehouse-helpers.ts';

/**
 * Mailversand fachlich konfiguriert (sonst beendet `voucher.delivery` bzw.
 * `invoice.delivery` mit `mail_not_configured` und es entsteht keine Outbox-
 * Zeile). Das Gateway bleibt der FakeMailGateway des Testkontexts – es wird
 * nichts real versendet.
 */
const MAIL_ENV = {
  MAIL_ENABLED: 'true',
  MAIL_SMTP_HOST: 'smtp.test.example',
  MAIL_SMTP_USER: 'mailer@miet-royal.test',
  MAIL_SMTP_PASSWORD: 'smtp-password-acceptance-never-real',
  MAIL_FROM_NAME: 'Miet-Royal Mainz',
  MAIL_FROM_ADDRESS: 'noreply@miet-royal.test',
  MAIL_PUBLIC_WEB_BASE_URL: 'https://web.test.example',
};

/** Seed-Listenpreis der 2×10-L-Maschine (Migration 0007) – Basis des Preis-Snapshots. */
const SEED_PRICE_SLUSH_2X10_CENTS = 12_000;
/** Seed-Maschine des Typs slush-2x10 (Migration 0010). */
const MACHINE_CODE = 'MR-10-02-01';
const CUSTOMER_EMAIL = 'paula.publikum@test.example';
const SHA256_HEX = /^[0-9a-f]{64}$/;

type Row = Record<string, unknown>;

async function rowsIn<T extends Row>(
  ctx: TestContext,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await ctx.pool.query<T>(sql, params)).rows;
}

async function oneIn<T extends Row>(
  ctx: TestContext,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const result = await rowsIn<T>(ctx, sql, params);
  expect(result, `genau eine Zeile erwartet: ${sql}`).toHaveLength(1);
  return result[0]!;
}

async function countIn(ctx: TestContext, sql: string, params: unknown[] = []): Promise<number> {
  const result = await ctx.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM (${sql}) AS q`,
    params,
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Jobs je Typ/Status (für „genau ein Transferjob“, „keine toten Jobs“). */
async function jobRows(ctx: TestContext, type?: string) {
  return rowsIn<{ type: string; status: string; idempotency_key: string; payload: Row }>(
    ctx,
    `SELECT type, status, idempotency_key, payload FROM integration_jobs
     WHERE $1::text IS NULL OR type = $1 ORDER BY created_at`,
    [type ?? null],
  );
}

/** Mails eines Vorgangs je Art/Status. */
async function mailRows(ctx: TestContext, processId: string, kind?: string) {
  return rowsIn<{
    id: string;
    kind: string;
    status: string;
    recipient_email: string | null;
    booking_id: string | null;
    secret_payload_ciphertext: string | null;
  }>(
    ctx,
    `SELECT id, kind, status, recipient_email, booking_id, secret_payload_ciphertext
     FROM mail_deliveries WHERE process_id = $1 AND ($2::text IS NULL OR kind::text = $2)
     ORDER BY created_at`,
    [processId, kind ?? null],
  );
}

/** Alle Buchungs-Snapshots als Text (byteidentischer Vergleich). */
async function bookingSnapshots(ctx: TestContext, bookingId: string) {
  return oneIn<{
    customer_snapshot: string;
    event_snapshot: string;
    items_snapshot: string;
    totals_snapshot: string;
    delivery_snapshot: string | null;
    voucher_snapshot: string | null;
  }>(
    ctx,
    `SELECT customer_snapshot::text, event_snapshot::text, items_snapshot::text,
            totals_snapshot::text, delivery_snapshot::text, voucher_snapshot::text
     FROM bookings WHERE id = $1`,
    [bookingId],
  );
}

/** Minimale DTO-Typen der genutzten Staff-Routen (nur die geprüften Felder). */
interface HandoverDetailDto {
  detail: {
    finalized?: boolean;
    blockers: string[];
    handover: {
      status: string;
      finalizedAt: string | null;
      protocolDocumentId: string | null;
      appointment: { id: string; status: string } | null;
    };
    slots: {
      id: string;
      slotNo: number;
      status: string;
      machine: { id: string; machineCode: string; status: string } | null;
    }[];
    deliveryNote: {
      status: string;
      documentId: string | null;
      items: { inventoryItemId: string | null; actualQuantity: number }[];
    };
  };
}

interface ReturnDetailDto {
  detail: {
    finalized?: boolean;
    blockers: string[];
    return: { id: string; status: string; finalizedAt: string | null };
    machines: { id: string; machineId: string; machineCode: string }[];
  };
}

describe('P18-A – Szenario A: Standardvermietung (Website-Anfrage → … → Gutschein → Portal)', () => {
  let ctx: TestContext;
  let adminId = '';
  let cookie = '';

  /** Geteilter Kettenzustand – wird von Schritt zu Schritt gefüllt. */
  const A = {
    clientMutationId: '',
    processId: '',
    processNumber: '',
    customerId: '',
    payloadHash: '',
    offerId: '',
    versionId: '',
    token: '',
    bookingId: '',
    confirmationId: '',
    snapshots: null as Awaited<ReturnType<typeof bookingSnapshots>> | null,
    offerCustomerSnapshot: '',
    pickupAppointmentId: '',
    returnAppointmentId: '',
    slotId: '',
    machineId: '',
    expectedIssueItems: 0,
    handoverProtocolDocumentId: '',
    returnId: '',
    settlementId: '',
    transferId: '',
    voucherId: '',
  };

  /** Voraussetzung eines Vorschritts benennen statt Folgefehler zu produzieren. */
  function requires(step: string, ...values: string[]): void {
    for (const value of values) {
      expect(value, `Voraussetzung fehlt – Schritt ${step} muss zuvor grün sein`).not.toBe('');
    }
  }

  async function staff<T = Row>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    url: string,
    payload?: Record<string, unknown>,
  ): Promise<{ status: number; body: T; raw: Buffer; contentType: string }> {
    const response = await ctx.app.inject({
      method,
      url,
      headers: { cookie },
      ...(payload === undefined ? {} : { payload }),
    });
    const contentType = String(response.headers['content-type'] ?? '');
    return {
      status: response.statusCode,
      body: (contentType.includes('application/json') ? response.json() : null) as T,
      raw: response.rawPayload,
      contentType,
    };
  }

  const rows = <T extends Row>(sql: string, params: unknown[] = []) => rowsIn<T>(ctx, sql, params);
  const one = <T extends Row>(sql: string, params: unknown[] = []) => oneIn<T>(ctx, sql, params);
  const count = (sql: string, params: unknown[] = []) => countIn(ctx, sql, params);

  beforeAll(async () => {
    ctx = await createTestContext({ env: MAIL_ENV });
    expect(ctx.gateway.provider, 'Teil 1 läuft gegen die Mock-Buchhaltung').toBe('mock');
    // Vollständiger Reset in FK-Reihenfolge (zweiter Lauf auf derselben DB muss grün sein).
    await truncateVoucherTables(ctx.pool);
    await truncateSettlementTables(ctx.pool);
    await truncateCommunicationTables(ctx.pool);
    await truncateHandoverTables(ctx.pool);
    await resetWarehouse(ctx.pool);
    await truncateSchedulingTables(ctx.pool);
    await truncatePortalTables(ctx.pool);
    await truncateCrmTables(ctx.pool);
    await truncateAuthTables(ctx.pool);
    await truncateCommerceTables(ctx.pool);
    await truncateCmsTables(ctx.pool);
    ctx.accounting.calls.length = 0;
    ctx.accounting.failNext(0);
    ctx.mailGateway.reset();
    // Rahmenbedingungen wie im Betrieb: Admin, veröffentlichte Datenschutzhinweise
    // (Website-Gate), exakte Abholadresse (AB-Freigabe), Mietbedingungen (Versand),
    // Erstinventur (Lagerausgabe bei der Übergabe).
    adminId = (await bootstrapAdmin(ctx)).id;
    cookie = (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie;
    await publishPrivacyForTests(ctx.db);
    await setPickupExactAddress(ctx, adminId);
    await ensureTestTerms(ctx.db);
    await initializeAllInventory(ctx, adminId, 20);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  it('P18-A1. Website-Anfrage: 201 erzeugt genau einen Vorgang (website, created_by NULL); Replay ⇒ 200 identisch, anderer Inhalt ⇒ 409; keine Mail, kein Job, kein Angebot', async () => {
    const body = inquiryBody(); // Abholung, Privatperson, 2×10 L, 2 L Gratis-Sirup, Event in 40 Tagen
    A.clientMutationId = body.clientMutationId;

    const first = await postInquiry(ctx, body);
    expect(first.statusCode, first.body).toBe(201);
    const created = first.json() as { processNumber: string; receivedAt: string };
    expect(created.processNumber).toMatch(/^MR-\d{4}-\d{4,}$/);
    A.processNumber = created.processNumber;

    const submission = await one<{ process_id: string; customer_id: string; payload_hash: string }>(
      `SELECT process_id, customer_id, payload_hash FROM public_inquiry_submissions
       WHERE client_mutation_id = $1`,
      [body.clientMutationId],
    );
    expect(submission.payload_hash).toMatch(SHA256_HEX);
    A.payloadHash = submission.payload_hash;
    A.processId = submission.process_id;
    A.customerId = submission.customer_id;

    // Replay (identischer Body) ⇒ 200 mit denselben Werten, keine zweite Zeile, gleicher Hash.
    const replay = await postInquiry(ctx, body);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(created);
    // Gleiche clientMutationId, anderer Inhalt ⇒ 409 mit der gespeicherten Vorgangsnummer.
    const conflict = await postInquiry(ctx, { ...body, event: { ...body.event, guests: 81 } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatchObject({
      code: 'PUBLIC_INQUIRY_CONFLICT',
      processNumber: created.processNumber,
    });

    const process = await one<{
      source: string;
      created_by: string | null;
      main_status: string;
      customer_id: string;
    }>(`SELECT source, created_by, main_status, customer_id FROM processes WHERE id = $1`, [
      A.processId,
    ]);
    expect(process).toEqual({
      source: 'website',
      created_by: null,
      main_status: 'open',
      customer_id: A.customerId,
    });
    expect(await count(`SELECT 1 FROM processes`)).toBe(1);
    expect(await count(`SELECT 1 FROM inquiries WHERE process_id = $1`, [A.processId])).toBe(1);
    expect(await count(`SELECT 1 FROM public_inquiry_submissions`)).toBe(1);
    expect(
      (await one<{ payload_hash: string }>(`SELECT payload_hash FROM public_inquiry_submissions`))
        .payload_hash,
    ).toBe(A.payloadHash);
    expect(
      await count(`SELECT 1 FROM customers WHERE email = $1 AND deleted_at IS NULL`, [
        CUSTOMER_EMAIL,
      ]),
    ).toBe(1);
    // Nebenobjekte: keine Mail, kein Job, kein Angebot (Website erzeugt nur die Anfrage).
    expect(await count(`SELECT 1 FROM mail_deliveries`)).toBe(0);
    expect(await count(`SELECT 1 FROM integration_jobs`)).toBe(0);
    expect(await count(`SELECT 1 FROM offers`)).toBe(0);
  });

  it('P18-A2. Staff erstellt und versendet das Angebot: Version sent (sent_by/sent_at/Snapshot), genau ein Angebots-PDF, genau eine Angebotsmail, ein gültiger Link; erneuter Versand ⇒ 409 ohne zweite Mail/zweites PDF', async () => {
    requires('P18-A1', A.processId);
    const createdOffer = await staff<{ offerId: string; versionId: string }>(
      'POST',
      `/staff/processes/${A.processId}/offer`,
    );
    expect(createdOffer.status, JSON.stringify(createdOffer.body)).toBe(200);
    A.offerId = createdOffer.body.offerId;
    A.versionId = createdOffer.body.versionId;

    const sent = await staff<{ sent: boolean; publicPath: string }>(
      'POST',
      `/staff/offer-versions/${A.versionId}/send`,
    );
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.sent).toBe(true);
    expect(sent.body.publicPath).toMatch(/^\/angebot\/[A-Za-z0-9_-]{20,}$/);
    A.token = sent.body.publicPath.replace('/angebot/', '');

    const version = await one<{
      status: string;
      sent_by: string | null;
      sent_at: Date | null;
      expires_at: Date | null;
      customer_snapshot: string | null;
      terms_version_id: string | null;
      fixed_total_cents: number;
    }>(
      `SELECT status, sent_by, sent_at, expires_at, customer_snapshot::text, terms_version_id,
              fixed_total_cents FROM offer_versions WHERE id = $1`,
      [A.versionId],
    );
    expect(version.status).toBe('sent');
    expect(version.sent_by).toBe(adminId);
    expect(version.sent_at).not.toBeNull();
    expect(version.expires_at).not.toBeNull();
    expect(version.customer_snapshot).not.toBeNull();
    expect(version.terms_version_id).not.toBeNull();
    expect(version.fixed_total_cents).toBe(SEED_PRICE_SLUSH_2X10_CENTS);
    A.offerCustomerSnapshot = version.customer_snapshot ?? '';
    // Token liegt nur als Hash vor – genau ein nicht widerrufener Link je Angebot.
    expect(
      await count(`SELECT 1 FROM offer_access_tokens WHERE offer_id = $1 AND revoked_at IS NULL`, [
        A.offerId,
      ]),
    ).toBe(1);
    expect(await count(`SELECT 1 FROM offer_access_tokens WHERE token_hash = $1`, [A.token])).toBe(
      0,
    );

    const docsAfterSend = async () =>
      count(
        `SELECT 1 FROM documents WHERE process_id = $1 AND type = 'offer' AND finalized_at IS NOT NULL`,
        [A.processId],
      );
    expect(await docsAfterSend()).toBe(1);
    const offerMails = await mailRows(ctx, A.processId, 'offer');
    expect(offerMails).toHaveLength(1);
    expect(offerMails[0]).toMatchObject({ status: 'pending', recipient_email: CUSTOMER_EMAIL });
    expect(await count(`SELECT 1 FROM integration_jobs WHERE type = 'mail.send'`)).toBe(1);

    // Doppelklick auf „Versenden“: versendete Version ist eingefroren ⇒ 409 (commerce-offer 29/30).
    const resend = await staff('POST', `/staff/offer-versions/${A.versionId}/send`);
    expect(resend.status).toBe(409);
    expect(await docsAfterSend()).toBe(1);
    expect(await mailRows(ctx, A.processId, 'offer')).toHaveLength(1);

    // Worker: Angebotsmail wird genau einmal über den Fake zugestellt.
    await drainAllJobs(ctx);
    const sentMails = await mailRows(ctx, A.processId, 'offer');
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]).toMatchObject({ status: 'sent', secret_payload_ciphertext: null });
    expect(ctx.mailGateway.sent).toHaveLength(1);
  });

  it('P18-A3. Online-Annahme zweimal parallel + einmal danach ⇒ alle 200 mit derselben Buchung; genau 1 Buchung, AB vorbereitet, genau 2 Termine (pickup/return); Snapshots festgehalten', async () => {
    requires('P18-A2', A.token);
    const accept = () =>
      ctx.app.inject({ method: 'POST', url: `/public/offers/${A.token}/accept` });
    const [first, second] = await Promise.all([accept(), accept()]);
    const third = await accept();
    for (const response of [first, second, third]) {
      expect(response.statusCode, response.body).toBe(200);
    }
    const bookingIds = [first, second, third].map(
      (response) => (response.json() as { accepted: boolean; bookingId: string }).bookingId,
    );
    expect(new Set(bookingIds).size).toBe(1);
    A.bookingId = bookingIds[0]!;

    expect(await count(`SELECT 1 FROM bookings`)).toBe(1);
    const booking = await one<{
      process_id: string;
      offer_id: string;
      offer_version_id: string;
      accepted_at: Date;
      fulfillment: string;
    }>(
      `SELECT process_id, offer_id, offer_version_id, accepted_at, fulfillment FROM bookings WHERE id = $1`,
      [A.bookingId],
    );
    expect(booking).toMatchObject({
      process_id: A.processId,
      offer_id: A.offerId,
      offer_version_id: A.versionId,
      fulfillment: 'pickup',
    });
    expect(booking.accepted_at).not.toBeNull();
    expect(
      await one<{ status: string; accepted_at: Date | null }>(
        `SELECT status, accepted_at FROM offer_versions WHERE id = $1`,
        [A.versionId],
      ),
    ).toMatchObject({ status: 'accepted' });

    const confirmations = await rows<{ id: string; status: string }>(
      `SELECT id, status FROM order_confirmations WHERE booking_id = $1`,
      [A.bookingId],
    );
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]!.status).toBe('prepared');
    A.confirmationId = confirmations[0]!.id;

    const appointments = await rows<{ id: string; kind: string; status: string }>(
      `SELECT id, kind, status FROM appointments WHERE booking_id = $1 ORDER BY kind::text`,
      [A.bookingId],
    );
    expect(appointments.map((row) => [row.kind, row.status])).toEqual([
      ['pickup', 'scheduled'],
      ['return', 'scheduled'],
    ]);
    A.pickupAppointmentId = appointments[0]!.id;
    A.returnAppointmentId = appointments[1]!.id;

    A.snapshots = await bookingSnapshots(ctx, A.bookingId);
    const totals = JSON.parse(A.snapshots.totals_snapshot) as { fixedTotalCents: number };
    expect(totals.fixedTotalCents).toBe(SEED_PRICE_SLUSH_2X10_CENTS);
    const customer = JSON.parse(A.snapshots.customer_snapshot) as {
      firstName: string;
      email: string;
    };
    expect(customer).toMatchObject({ firstName: 'Paula', email: CUSTOMER_EMAIL });
    // Annahme löst keine Kundenmail aus (erst die AB).
    expect(await count(`SELECT 1 FROM mail_deliveries WHERE process_id = $1`, [A.processId])).toBe(
      1,
    );
  });

  it('P18-A4. AB: Freigabe genau einmal (zweite ⇒ 409, ein AB-Dokument), Versand genau einmal (zweiter ⇒ 409, eine Mail); Worker ⇒ status sent', async () => {
    requires('P18-A3', A.bookingId, A.confirmationId);
    const view = await staff<{
      booking: { id: string } | null;
      confirmation: { id: string; status: string } | null;
      blockers: string[];
    }>('GET', `/staff/processes/${A.processId}/confirmation`);
    expect(view.status).toBe(200);
    expect(view.body.booking?.id).toBe(A.bookingId);
    expect(view.body.confirmation).toMatchObject({ id: A.confirmationId, status: 'prepared' });
    expect(view.body.blockers).toEqual([]);

    const approve = () => staff('POST', `/staff/order-confirmations/${A.confirmationId}/approve`);
    const approved = await approve();
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toEqual({ approved: true });
    const approvedAgain = await approve();
    expect(approvedAgain.status).toBe(409);

    const abDocuments = () =>
      count(
        `SELECT 1 FROM documents WHERE process_id = $1 AND type = 'order_confirmation' AND finalized_at IS NOT NULL`,
        [A.processId],
      );
    expect(await abDocuments()).toBe(1);
    const afterApprove = await one<{
      status: string;
      approved_by: string | null;
      approved_at: Date | null;
      document_id: string | null;
    }>(
      `SELECT status, approved_by, approved_at, document_id FROM order_confirmations WHERE id = $1`,
      [A.confirmationId],
    );
    expect(afterApprove.status).toBe('approved');
    expect(afterApprove.approved_by).toBe(adminId);
    expect(afterApprove.approved_at).not.toBeNull();
    expect(afterApprove.document_id).not.toBeNull();

    const send = () => staff('POST', `/staff/order-confirmations/${A.confirmationId}/send`);
    const sent = await send();
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body).toEqual({ sent: true });
    const sentAgain = await send();
    expect(sentAgain.status).toBe(409);
    expect(await mailRows(ctx, A.processId, 'order_confirmation')).toHaveLength(1);
    expect(
      (
        await one<{ status: string }>(`SELECT status FROM order_confirmations WHERE id = $1`, [
          A.confirmationId,
        ])
      ).status,
    ).toBe('queued');

    await drainAllJobs(ctx);
    await drainAllJobs(ctx);
    const afterSend = await one<{
      status: string;
      sent_at: Date | null;
      mail_delivery_id: string | null;
    }>(`SELECT status, sent_at, mail_delivery_id FROM order_confirmations WHERE id = $1`, [
      A.confirmationId,
    ]);
    expect(afterSend.status).toBe('sent');
    expect(afterSend.sent_at).not.toBeNull();
    const abMails = await mailRows(ctx, A.processId, 'order_confirmation');
    expect(abMails).toHaveLength(1);
    expect(abMails[0]).toMatchObject({
      id: afterSend.mail_delivery_id,
      status: 'sent',
      booking_id: A.bookingId,
      recipient_email: CUSTOMER_EMAIL,
    });
    expect(await abDocuments()).toBe(1);
    // Erneuter Versand nach „sent“ bleibt blockiert.
    expect((await send()).status).toBe(409);
  });

  it('P18-A5. Preisfreeze: spätere Kunden- und Preisänderung lassen alle Buchungs-Snapshots und den versendeten Angebots-Snapshot byteidentisch', async () => {
    requires('P18-A3', A.bookingId, A.customerId);
    expect(A.snapshots).not.toBeNull();
    const patched = await staff<{ customer: { firstName: string } }>(
      'PATCH',
      `/staff/customers/${A.customerId}`,
      {
        type: 'private',
        firstName: 'Paula-Petra',
        lastName: 'Publikum-Neu',
        email: CUSTOMER_EMAIL,
        phone: '0171 5550102',
        billingStreet: 'Neue Straße 7',
        billingPostalCode: '55116',
        billingCity: 'Mainz',
      },
    );
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.customer.firstName).toBe('Paula-Petra');

    const machineProduct = await productBySlug(ctx.db, 'slush-2x10');
    const priced = await staff('POST', `/staff/products/${machineProduct.id}/price`, {
      priceCents: 55_500,
    });
    expect(priced.status, JSON.stringify(priced.body)).toBe(200);

    // Stammdaten/Preis sind geändert …
    expect(
      (
        await one<{ first_name: string }>(`SELECT first_name FROM customers WHERE id = $1`, [
          A.customerId,
        ])
      ).first_name,
    ).toBe('Paula-Petra');
    expect(
      (
        await one<{ price_cents: number }>(
          `SELECT price_cents FROM product_prices WHERE product_id = $1 AND effective_from <= now()
         ORDER BY effective_from DESC LIMIT 1`,
          [machineProduct.id],
        )
      ).price_cents,
    ).toBe(55_500);
    // … die eingefrorenen Snapshots nicht (byteidentisch).
    expect(await bookingSnapshots(ctx, A.bookingId)).toEqual(A.snapshots);
    expect(
      await one<{ customer_snapshot: string; fixed_total_cents: number }>(
        `SELECT customer_snapshot::text, fixed_total_cents FROM offer_versions WHERE id = $1`,
        [A.versionId],
      ),
    ).toEqual({
      customer_snapshot: A.offerCustomerSnapshot,
      fixed_total_cents: SEED_PRICE_SLUSH_2X10_CENTS,
    });
  });

  it('P18-A6. Termine geplant (Version +1), Maschine über Route zugewiesen und vorbereitet ⇒ Zuordnung prepared, Maschine reserved', async () => {
    requires('P18-A3', A.bookingId, A.pickupAppointmentId, A.returnAppointmentId);
    const pickup = await one<{ version: number }>(
      `SELECT version FROM appointments WHERE id = $1`,
      [A.pickupAppointmentId],
    );
    const scheduledPickup = await staff<{ updated: boolean; version: number }>(
      'PATCH',
      `/staff/appointments/${A.pickupAppointmentId}/schedule`,
      {
        startAt: new Date(Date.now() + 1 * DAYS).toISOString(),
        endAt: null,
        expectedVersion: pickup.version,
      },
    );
    expect(scheduledPickup.status, JSON.stringify(scheduledPickup.body)).toBe(200);
    expect(scheduledPickup.body.version).toBe(pickup.version + 1);
    const ret = await one<{ version: number }>(`SELECT version FROM appointments WHERE id = $1`, [
      A.returnAppointmentId,
    ]);
    const scheduledReturn = await staff<{ updated: boolean; version: number }>(
      'PATCH',
      `/staff/appointments/${A.returnAppointmentId}/schedule`,
      {
        startAt: new Date(Date.now() + 3 * DAYS).toISOString(),
        endAt: null,
        expectedVersion: ret.version,
      },
    );
    expect(scheduledReturn.status, JSON.stringify(scheduledReturn.body)).toBe(200);
    // Veraltete Version ⇒ Konflikt, kein stilles Überschreiben.
    const stale = await staff('PATCH', `/staff/appointments/${A.returnAppointmentId}/schedule`, {
      startAt: new Date(Date.now() + 4 * DAYS).toISOString(),
      endAt: null,
      expectedVersion: ret.version,
    });
    expect(stale.status).toBe(409);

    const detail = await staff<HandoverDetailDto>('GET', `/staff/handover/${A.bookingId}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.detail.slots).toHaveLength(1);
    expect(detail.body.detail.slots[0]).toMatchObject({ slotNo: 1, status: 'open', machine: null });
    A.slotId = detail.body.detail.slots[0]!.id;

    const machine = await machineByCode(ctx.db, MACHINE_CODE);
    A.machineId = machine.id;
    const assigned = await staff<{ slot: { status: string; machine: { id: string } | null } }>(
      'POST',
      `/staff/handover/${A.bookingId}/slots/${A.slotId}/assign`,
      { machineId: machine.id },
    );
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(assigned.body.slot.status).toBe('assigned');
    expect(assigned.body.slot.machine?.id).toBe(machine.id);
    const prepared = await staff<{ slot: { status: string } }>(
      'POST',
      `/staff/handover/${A.bookingId}/slots/${A.slotId}/prepare`,
    );
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    expect(prepared.body.slot.status).toBe('prepared');

    expect(
      await one<{ status: string; machine_id: string | null }>(
        `SELECT status, machine_id FROM machine_assignments WHERE id = $1`,
        [A.slotId],
      ),
    ).toEqual({ status: 'prepared', machine_id: machine.id });
    expect(
      await one<{ status: string; location_kind: string }>(
        `SELECT status, location_kind FROM machines WHERE id = $1`,
        [machine.id],
      ),
    ).toEqual({ status: 'reserved', location_kind: 'warehouse' });
  });

  it('P18-A7. Übergabe: Wizard komplett, Finalize zweimal ⇒ genau eine Finalisierung (zweiter Aufruf finalized:false), 1 Lieferschein + 1 Protokoll, Zuordnung issued, Maschine rented, je Lagerartikel genau eine Ausgabe, Abholtermin completed, genau eine Protokollmail', async () => {
    requires('P18-A6', A.slotId, A.machineId);
    // Wizard-Schritte (Empfänger, Prüfung, Gesamtfoto, beide Unterschriften) über dieselben
    // Services wie die Routen – Zuweisung/Vorbereitung sind bereits über die Route erfolgt.
    const services = handoverServicesFor(ctx);
    await services.handover.setRecipient(A.bookingId, { kind: 'customer' });
    await services.handover.checkMachine(adminId, A.bookingId, A.slotId);
    await services.handover.addPhoto(adminId, A.bookingId, A.slotId, {
      bytes: pngBytes(),
      mimeType: 'image/png',
    });
    await services.handover.sign(adminId, A.bookingId, 'customer', pngBytes());
    await services.handover.sign(adminId, A.bookingId, 'staff', pngBytes());

    const before = await staff<HandoverDetailDto>('GET', `/staff/handover/${A.bookingId}`);
    expect(before.body.detail.blockers).toEqual([]);
    // Erwartete Lagerausgaben: je Lagerartikel mit Ist-Menge > 0 genau EINE issue-Bewegung.
    const stockItems = new Set(
      before.body.detail.deliveryNote.items
        .filter((item) => item.inventoryItemId !== null && item.actualQuantity > 0)
        .map((item) => item.inventoryItemId),
    );
    A.expectedIssueItems = stockItems.size;
    expect(A.expectedIssueItems, 'Gratis-Sirup ist Lagerware').toBeGreaterThanOrEqual(1);
    expect(await count(`SELECT 1 FROM inventory_movements WHERE kind = 'issue'`)).toBe(0);

    const finalize = () =>
      staff<HandoverDetailDto>('POST', `/staff/handover/${A.bookingId}/finalize`);
    const first = await finalize();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.detail.finalized).toBe(true);
    expect(first.body.detail.handover.status).toBe('finalized');
    const second = await finalize();
    expect(second.status).toBe(200);
    expect(second.body.detail.finalized).toBe(false);
    expect(second.body.detail.handover.finalizedAt).toBe(first.body.detail.handover.finalizedAt);
    expect(second.body.detail.handover.protocolDocumentId).toBe(
      first.body.detail.handover.protocolDocumentId,
    );
    A.handoverProtocolDocumentId = first.body.detail.handover.protocolDocumentId ?? '';

    const handover = await one<{
      status: string;
      finalized_by: string | null;
      finalized_at: Date | null;
      appointment_id: string | null;
      protocol_document_id: string | null;
    }>(
      `SELECT status, finalized_by, finalized_at, appointment_id, protocol_document_id
       FROM handovers WHERE booking_id = $1`,
      [A.bookingId],
    );
    expect(handover.status).toBe('finalized');
    expect(handover.finalized_by).toBe(adminId);
    expect(handover.finalized_at).not.toBeNull();
    expect(handover.appointment_id).toBe(A.pickupAppointmentId);
    expect(handover.protocol_document_id).toBe(A.handoverProtocolDocumentId);
    expect(
      (
        await rows<{ type: string; n: number }>(
          `SELECT type, count(*)::int AS n FROM documents
           WHERE process_id = $1 AND finalized_at IS NOT NULL GROUP BY type ORDER BY type::text`,
          [A.processId],
        )
      ).map((row) => [row.type, row.n]),
    ).toEqual([
      ['delivery_note', 1],
      ['handover_protocol', 1],
      ['offer', 1],
      ['order_confirmation', 1],
    ]);
    expect(
      await one<{ status: string; document_id: string | null }>(
        `SELECT status, document_id FROM delivery_notes WHERE booking_id = $1`,
        [A.bookingId],
      ),
    ).toMatchObject({ status: 'final' });
    expect(
      await one<{ status: string; issued_at: Date | null }>(
        `SELECT status, issued_at FROM machine_assignments WHERE id = $1`,
        [A.slotId],
      ),
    ).toMatchObject({ status: 'issued' });
    expect(
      await one<{ status: string; location_kind: string }>(
        `SELECT status, location_kind FROM machines WHERE id = $1`,
        [A.machineId],
      ),
    ).toEqual({ status: 'rented', location_kind: 'customer' });
    expect(await count(`SELECT 1 FROM inventory_movements WHERE kind = 'issue'`)).toBe(
      A.expectedIssueItems,
    );
    expect(
      await count(
        `SELECT item_id FROM inventory_movements WHERE kind = 'issue' GROUP BY item_id HAVING count(*) > 1`,
      ),
    ).toBe(0);
    expect(
      await one<{ status: string; completed_by: string | null }>(
        `SELECT status, completed_by FROM appointments WHERE id = $1`,
        [A.pickupAppointmentId],
      ),
    ).toEqual({ status: 'completed', completed_by: adminId });
    expect(
      await count(
        `SELECT 1 FROM delivery_packets WHERE booking_id = $1 AND kind = 'handover_completed'`,
        [A.bookingId],
      ),
    ).toBe(1);
    expect(await mailRows(ctx, A.processId, 'handover_protocol')).toHaveLength(1);

    await drainAllJobs(ctx);
    await drainAllJobs(ctx);
    const protocolMails = await mailRows(ctx, A.processId, 'handover_protocol');
    expect(protocolMails).toHaveLength(1);
    expect(protocolMails[0]).toMatchObject({ status: 'sent', booking_id: A.bookingId });
    expect(
      (
        await one<{ status: string }>(
          `SELECT status FROM delivery_packets WHERE booking_id = $1 AND kind = 'handover_completed'`,
          [A.bookingId],
        )
      ).status,
    ).toBe('sent');
  });

  it('P18-A8. Rückgabe ohne Beanstandung: Start, Prüfungen, Finalize zweimal ⇒ ein Rückgabeprotokoll, Zuordnung returned, Maschine cleaning, Rückgabetermin completed, genau eine Abrechnung ready_for_accounting (Snapshot-Preis, keine Reinigungsgebühr), genau ein Transferjob', async () => {
    requires('P18-A7', A.handoverProtocolDocumentId);
    const started = await staff<ReturnDetailDto>('POST', `/staff/returns/${A.bookingId}/start`);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.detail.return.status).toBe('draft');
    expect(started.body.detail.machines.map((m) => m.machineCode)).toEqual([MACHINE_CODE]);
    A.returnId = started.body.detail.return.id;
    // Rückgabeperson, Zubehör vollständig, drei Sauberkeitspunkte, beide Unterschriften.
    const services = handoverServicesFor(ctx);
    const ready = await readyReturn(ctx, adminId, services, A.bookingId);
    expect(ready.blockers).toEqual([]);

    const finalize = () => staff<ReturnDetailDto>('POST', `/staff/returns/${A.bookingId}/finalize`);
    const first = await finalize();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.detail.finalized).toBe(true);
    expect(first.body.detail.return.status).toBe('finalized');
    const second = await finalize();
    expect(second.status).toBe(200);
    expect(second.body.detail.finalized).toBe(false);
    expect(second.body.detail.return.finalizedAt).toBe(first.body.detail.return.finalizedAt);

    const rentalReturn = await one<{
      status: string;
      finalized_by: string | null;
      finalized_at: Date | null;
      actual_return_at: Date | null;
      protocol_document_id: string | null;
      return_appointment_id: string | null;
    }>(
      `SELECT status, finalized_by, finalized_at, actual_return_at, protocol_document_id,
              return_appointment_id FROM rental_returns WHERE id = $1`,
      [A.returnId],
    );
    expect(rentalReturn.status).toBe('finalized');
    expect(rentalReturn.finalized_by).toBe(adminId);
    expect(rentalReturn.finalized_at).not.toBeNull();
    expect(rentalReturn.actual_return_at).not.toBeNull();
    expect(rentalReturn.protocol_document_id).not.toBeNull();
    expect(rentalReturn.return_appointment_id).toBe(A.returnAppointmentId);
    expect(
      await count(
        `SELECT 1 FROM documents WHERE process_id = $1 AND type = 'return_protocol' AND finalized_at IS NOT NULL`,
        [A.processId],
      ),
    ).toBe(1);
    expect(
      await one<{ status: string; returned_at: Date | null }>(
        `SELECT status, returned_at FROM machine_assignments WHERE id = $1`,
        [A.slotId],
      ),
    ).toMatchObject({ status: 'returned' });
    const machine = await one<{
      status: string;
      location_kind: string;
      cleaning_since: Date | null;
    }>(`SELECT status, location_kind, cleaning_since FROM machines WHERE id = $1`, [A.machineId]);
    expect(machine).toMatchObject({ status: 'cleaning', location_kind: 'warehouse' });
    expect(machine.cleaning_since).not.toBeNull();
    expect(
      await one<{ status: string; completed_by: string | null }>(
        `SELECT status, completed_by FROM appointments WHERE id = $1`,
        [A.returnAppointmentId],
      ),
    ).toEqual({ status: 'completed', completed_by: adminId });
    // Ohne Beanstandung: keine Schäden, keine Fehlteile, keine Reinigungsgebühr, keine Rücknahme-Bewegung.
    expect(await count(`SELECT 1 FROM machine_damages`)).toBe(0);
    expect(await count(`SELECT 1 FROM missing_accessory_cases`)).toBe(0);
    expect(
      await count(
        `SELECT 1 FROM return_machines WHERE return_id = $1 AND cleanup_fee_snapshot_cents IS NOT NULL`,
        [A.returnId],
      ),
    ).toBe(0);
    expect(await count(`SELECT 1 FROM inventory_movements WHERE kind = 'return'`)).toBe(0);
    expect(
      await count(
        `SELECT 1 FROM delivery_packets WHERE booking_id = $1 AND kind = 'return_completed'`,
        [A.bookingId],
      ),
    ).toBe(1);
    expect(await mailRows(ctx, A.processId, 'return_protocol')).toHaveLength(1);

    // Abrechnung entsteht genau einmal aus der Finalisierung (Listener) und ist bereit.
    expect(await count(`SELECT 1 FROM settlements`)).toBe(1);
    const view = await settlementViewFor(ctx.app, cookie, A.processId);
    A.settlementId = view.settlement.id;
    expect(view.settlement).toMatchObject({
      bookingId: A.bookingId,
      returnId: A.returnId,
      status: 'ready_for_accounting',
      accountingBlocker: null,
    });
    expect(view.transfer).toBeNull();
    const lineTypes = view.lines.map((line) => line.type);
    expect(lineTypes).toContain('machine_rental');
    expect(lineTypes).not.toContain('cleanup_fee');
    expect(lineTypes).not.toContain('damage_charge');
    expect(lineTypes).not.toContain('missing_item_charge');
    const rental = view.lines.find((line) => line.type === 'machine_rental')!;
    // Snapshot-Preis trotz Listenpreisänderung in P18-A5 (55 500 Cent).
    expect(rental.amountCents).toBe(SEED_PRICE_SLUSH_2X10_CENTS);
    expect(view.clarifications.filter((c) => c.status === 'open')).toEqual([]);
    expect(
      await one<{ status: string; locked_at: Date | null; payment_status: string | null }>(
        `SELECT status, locked_at, payment_status FROM settlements WHERE id = $1`,
        [A.settlementId],
      ),
    ).toEqual({ status: 'ready_for_accounting', locked_at: null, payment_status: null });

    const transferJobs = await jobRows(ctx, 'settlement.accounting_transfer');
    expect(transferJobs).toHaveLength(1);
    expect(transferJobs[0]).toMatchObject({
      status: 'pending',
      idempotency_key: settlementTransferIdempotencyKey(A.settlementId),
    });
    expect(transferJobs[0]!.payload).toMatchObject({ settlementId: A.settlementId });
  });

  it('P18-A9. Buchhaltungstransfer: zwei Job-Durchläufe ⇒ genau ein Mock-Transfer (succeeded, MOCK-RE-…), Abrechnung transferred/gesperrt, Vorgang completed; manueller Transfer danach ⇒ already_succeeded ohne zweiten Gateway-Aufruf', async () => {
    requires('P18-A8', A.settlementId);
    expect(ctx.accounting.calls).toHaveLength(0);
    await drainAllJobs(ctx);
    await drainAllJobs(ctx);

    const transfers = await rows<{
      id: string;
      status: string;
      provider: string;
      external_reference: string | null;
      attempts: number;
      payment_status: string | null;
      transferred_at: Date | null;
      idempotency_key: string;
    }>(
      `SELECT id, status, provider, external_reference, attempts, payment_status, transferred_at,
              idempotency_key FROM accounting_transfers WHERE settlement_id = $1`,
      [A.settlementId],
    );
    expect(transfers).toHaveLength(1);
    const transfer = transfers[0]!;
    A.transferId = transfer.id;
    expect(transfer).toMatchObject({
      status: 'succeeded',
      provider: 'mock',
      attempts: 1,
      payment_status: 'open',
      idempotency_key: settlementTransferIdempotencyKey(A.settlementId),
    });
    expect(transfer.external_reference).toMatch(new RegExp(`^MOCK-RE-${A.processNumber}-\\d{4}$`));
    expect(transfer.transferred_at).not.toBeNull();
    expect(ctx.accounting.calls).toHaveLength(1);
    expect(ctx.accounting.calls[0]).toMatchObject({
      idempotencyKey: settlementTransferIdempotencyKey(A.settlementId),
      kind: 'settlement',
      amountDueCents: SEED_PRICE_SLUSH_2X10_CENTS,
      externalReference: transfer.external_reference,
    });

    const settlement = await one<{
      status: string;
      locked_at: Date | null;
      transferred_at: Date | null;
      accounting_transfer_id: string | null;
      payment_status: string | null;
    }>(
      `SELECT status, locked_at, transferred_at, accounting_transfer_id, payment_status
       FROM settlements WHERE id = $1`,
      [A.settlementId],
    );
    expect(settlement).toMatchObject({
      status: 'transferred',
      accounting_transfer_id: A.transferId,
      payment_status: 'open',
    });
    expect(settlement.locked_at).not.toBeNull();
    expect(settlement.transferred_at).not.toBeNull();
    const process = await one<{ main_status: string; completed_at: Date | null }>(
      `SELECT main_status, completed_at FROM processes WHERE id = $1`,
      [A.processId],
    );
    expect(process.main_status).toBe('completed');
    expect(process.completed_at).not.toBeNull();
    // Der Transferjob lief genau einmal erfolgreich; die Rückgabeprotokoll-Mail ist zugestellt.
    const transferJobs = await jobRows(ctx, 'settlement.accounting_transfer');
    expect(transferJobs.map((job) => job.status)).toEqual(['succeeded']);
    expect(
      await count(`SELECT 1 FROM integration_jobs WHERE status IN ('pending','processing')`),
    ).toBe(0);
    expect((await mailRows(ctx, A.processId, 'return_protocol'))[0]).toMatchObject({
      status: 'sent',
    });

    // Manuelle Übertragung nach erfolgtem Transfer: bestehender Vertrag ist 200 `already_succeeded`
    // (settlement-transfer 69) – nie ein zweiter externer Beleg.
    const view = await settlementViewFor(ctx.app, cookie, A.processId);
    expect(view.transfer?.id).toBe(A.transferId);
    const manual = await transferSettlement(
      ctx.app,
      cookie,
      A.settlementId,
      view.settlement.version,
    );
    expect(manual.status).toBe(200);
    expect(manual.body.outcome).toBe('already_succeeded');
    expect(ctx.accounting.calls).toHaveLength(1);
    expect(await count(`SELECT 1 FROM accounting_transfers`)).toBe(1);
    expect(
      (
        await one<{ attempts: number }>(`SELECT attempts FROM accounting_transfers WHERE id = $1`, [
          A.transferId,
        ])
      ).attempts,
    ).toBe(1);
  });

  it('P18-A10. Portal vor der Zahlung: Buchung sichtbar als completed_open, Rechnung offen, genau die 5 finalen Dokumente (byteidentischer Download), keine verbotenen Schlüssel', async () => {
    requires('P18-A9', A.transferId);
    const session = await portalSessionFor(ctx, A.customerId);
    const list = await portalGet(ctx.app, session.cookie, '/portal/bookings');
    expect(list.status).toBe(200);
    const summaries = (list.body as { bookings: PortalBookingSummary[] }).bookings;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      bookingId: A.bookingId,
      processNumber: A.processNumber,
      portalState: 'completed_open',
      stateLabel: 'Abgeschlossen – Rechnung offen',
      fulfillment: 'pickup',
      travelStatus: 'none',
    });
    expect(forbiddenKeysIn(list.body)).toEqual([]);

    const detail = await portalGet(ctx.app, session.cookie, `/portal/bookings/${A.bookingId}`);
    expect(detail.status).toBe(200);
    const view = detail.body as PortalBookingView;
    expect(view).toMatchObject({
      bookingId: A.bookingId,
      portalState: 'completed_open',
      canCancelOnline: false,
      canMessage: false,
    });
    expect(view.invoice.status).toBe('open');
    expect(view.price.agreedTotalCents).toBe(SEED_PRICE_SLUSH_2X10_CENTS);
    expect(view.appointments.map((a) => [a.kind, a.status])).toEqual([
      ['pickup', 'completed'],
      ['return', 'completed'],
    ]);
    expect(forbiddenKeysIn(detail.body)).toEqual([]);

    const documents = await portalGet(
      ctx.app,
      session.cookie,
      `/portal/bookings/${A.bookingId}/documents`,
    );
    expect(documents.status).toBe(200);
    const listed = (documents.body as { documents: PortalDocumentView[] }).documents;
    expect(listed.map((d) => d.type).sort()).toEqual([
      'delivery_note',
      'handover_protocol',
      'offer',
      'order_confirmation',
      'return_protocol',
    ]);
    for (const document of listed)
      expect(document.label).toBe(PORTAL_DOCUMENT_LABELS[document.type]);
    const stored = await rows<{ id: string; type: string; sha256: string }>(
      `SELECT id, type, sha256 FROM documents WHERE process_id = $1`,
      [A.processId],
    );
    expect(stored).toHaveLength(5);
    expect(listed.map((d) => d.id).sort()).toEqual(stored.map((d) => d.id).sort());
    expect(forbiddenKeysIn(documents.body)).toEqual([]);

    // Download des Rückgabeprotokolls: Bytes entsprechen dem registrierten Dokument.
    const returnProtocol = stored.find((d) => d.type === 'return_protocol')!;
    const download = await portalGet(
      ctx.app,
      session.cookie,
      `/portal/bookings/${A.bookingId}/documents/${returnProtocol.id}`,
    );
    expect(download.status).toBe(200);
    expect(String(download.headers['content-type'])).toBe('application/pdf');
    expect(String(download.headers['cache-control'])).toBe('private, no-store');
    expect(download.raw.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(createHash('sha256').update(download.raw).digest('hex')).toBe(returnProtocol.sha256);
  });

  it('P18-A11. Zahlung bezahlt (Mock) ⇒ noch kein Gutschein (Reinigung offen); Reinigungsabschluss ⇒ genau ein 20-%-Gutschein + genau eine Gutscheinmail; „bezahlt“ erneut und zweiter Reinigungsabschluss ⇒ nichts Neues', async () => {
    requires('P18-A9', A.transferId, A.machineId);
    const paid = await staff<{ transferId: string; paymentStatus: string; mock: boolean }>(
      'POST',
      '/staff/accounting/mock/payment-status',
      { transferId: A.transferId, status: 'paid' },
    );
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body).toEqual({ transferId: A.transferId, paymentStatus: 'paid', mock: true });
    expect(
      (
        await one<{ payment_status: string | null }>(
          `SELECT payment_status FROM settlements WHERE id = $1`,
          [A.settlementId],
        )
      ).payment_status,
    ).toBe('paid');
    await drainAllJobs(ctx);
    // Nachtragsfenster (Maschine in Reinigung) ⇒ Prüfjob gelaufen, aber kein Gutschein.
    expect((await jobRows(ctx, 'voucher.eligibility_check')).map((j) => j.status)).toEqual([
      'succeeded',
    ]);
    expect(await count(`SELECT 1 FROM vouchers`)).toBe(0);

    const cleaned = await staff<{ machine: { id: string; status: string } }>(
      'POST',
      `/staff/machines/${A.machineId}/clean-complete`,
    );
    expect(cleaned.status, JSON.stringify(cleaned.body)).toBe(200);
    expect(cleaned.body.machine).toEqual({ id: A.machineId, status: 'ready' });
    const machine = await one<{
      status: string;
      cleaning_since: Date | null;
      cleaned_at: Date | null;
      cleaned_by: string | null;
    }>(`SELECT status, cleaning_since, cleaned_at, cleaned_by FROM machines WHERE id = $1`, [
      A.machineId,
    ]);
    expect(machine).toMatchObject({ status: 'ready', cleaning_since: null, cleaned_by: adminId });
    expect(machine.cleaned_at).not.toBeNull();

    await drainAllJobs(ctx);
    await drainAllJobs(ctx);
    const vouchers = await rows<{
      id: string;
      status: string;
      discount_percent: number;
      customer_id: string;
      origin_process_id: string;
      origin_booking_id: string;
      origin_return_id: string;
      delivery_status: string;
      delivery_code_ciphertext: string | null;
      mail_delivery_id: string | null;
      code_hash: string;
      activated_at: Date;
      expires_at: Date;
    }>(
      `SELECT id, status, discount_percent, customer_id, origin_process_id, origin_booking_id,
              origin_return_id, delivery_status, delivery_code_ciphertext, mail_delivery_id,
              code_hash, activated_at, expires_at FROM vouchers WHERE origin_settlement_id = $1`,
      [A.settlementId],
    );
    expect(vouchers).toHaveLength(1);
    const voucher = vouchers[0]!;
    A.voucherId = voucher.id;
    expect(voucher).toMatchObject({
      status: 'active',
      discount_percent: 20,
      customer_id: A.customerId,
      origin_process_id: A.processId,
      origin_booking_id: A.bookingId,
      origin_return_id: A.returnId,
      delivery_status: 'sent',
      delivery_code_ciphertext: null,
    });
    expect(voucher.code_hash).toMatch(SHA256_HEX);
    expect(voucher.expires_at.getTime()).toBeGreaterThan(voucher.activated_at.getTime());
    expect(await count(`SELECT 1 FROM vouchers`)).toBe(1);
    const voucherMails = await mailRows(ctx, A.processId, 'voucher_delivery');
    expect(voucherMails).toHaveLength(1);
    expect(voucherMails[0]).toMatchObject({
      id: voucher.mail_delivery_id,
      status: 'sent',
      recipient_email: CUSTOMER_EMAIL,
      secret_payload_ciphertext: null,
    });
    // Code nur in der Mail: nirgends in der DB im Klartext (Outbox-Kontext ohne Code).
    expect(await count(`SELECT 1 FROM mail_deliveries WHERE context::text LIKE '%MR20%'`)).toBe(0);
    expect(
      (await jobRows(ctx, 'voucher.eligibility_check')).map((j) => [
        (j.payload as { trigger: string }).trigger,
        j.status,
      ]),
    ).toEqual([
      ['paid', 'succeeded'],
      ['cleaning', 'succeeded'],
    ]);
    expect((await jobRows(ctx, 'voucher.delivery')).map((j) => j.status)).toEqual(['succeeded']);

    // Wiederholungen: „bezahlt“ erneut melden ⇒ kein neuer Job, kein zweiter Gutschein, keine zweite Mail.
    const paidAgain = await staff('POST', '/staff/accounting/mock/payment-status', {
      transferId: A.transferId,
      status: 'paid',
    });
    expect(paidAgain.status).toBe(200);
    await drainAllJobs(ctx);
    expect(await jobRows(ctx, 'voucher.eligibility_check')).toHaveLength(2);
    expect(await count(`SELECT 1 FROM vouchers`)).toBe(1);
    expect(await mailRows(ctx, A.processId, 'voucher_delivery')).toHaveLength(1);
    // Zweiter Reinigungsabschluss: Maschine ist nicht mehr in Reinigung ⇒ 409, nichts Neues.
    const cleanedAgain = await staff('POST', `/staff/machines/${A.machineId}/clean-complete`);
    expect(cleanedAgain.status).toBe(409);
    await drainAllJobs(ctx);
    expect(await count(`SELECT 1 FROM vouchers`)).toBe(1);
    expect(await mailRows(ctx, A.processId, 'voucher_delivery')).toHaveLength(1);
  });

  it('P18-A12. Portal nach finaler Zahlung (Regel B): Buchung unsichtbar – Liste leer, Detail/Dokumente neutral 404', async () => {
    requires('P18-A11', A.voucherId);
    const session = await portalSessionFor(ctx, A.customerId);
    const list = await portalGet(ctx.app, session.cookie, '/portal/bookings');
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ bookings: [] });
    expect(
      (await portalGet(ctx.app, session.cookie, `/portal/bookings/${A.bookingId}`)).status,
    ).toBe(404);
    expect(
      (await portalGet(ctx.app, session.cookie, `/portal/bookings/${A.bookingId}/documents`))
        .status,
    ).toBe(404);
    expect(
      (
        await portalGet(
          ctx.app,
          session.cookie,
          `/portal/bookings/${A.bookingId}/documents/${A.handoverProtocolDocumentId}`,
        )
      ).status,
    ).toBe(404);
  });

  it('P18-A13. Historie/Audit: alle Zeilenfelder der Fachschritte gesetzt; je Mailart genau eine gesendete Zustellung; Jobs ohne dead/pending und ohne doppelte Schlüssel; Pakete und Termine abgeschlossen', async () => {
    requires('P18-A11', A.voucherId);
    const history = await one<Record<string, unknown>>(
      `SELECT v.sent_by, v.sent_at, v.accepted_at,
              c.approved_by, c.approved_at, c.sent_at AS confirmation_sent_at,
              h.finalized_by AS handover_by, h.finalized_at AS handover_at,
              r.finalized_by AS return_by, r.finalized_at AS return_at,
              m.cleaned_by, m.cleaned_at,
              s.locked_at, s.transferred_at AS settlement_transferred_at,
              t.transferred_at AS transfer_transferred_at,
              p.completed_at
       FROM offer_versions v
       JOIN bookings b ON b.offer_version_id = v.id
       JOIN order_confirmations c ON c.booking_id = b.id
       JOIN handovers h ON h.booking_id = b.id
       JOIN rental_returns r ON r.booking_id = b.id
       JOIN machines m ON m.id = $2
       JOIN settlements s ON s.booking_id = b.id
       JOIN accounting_transfers t ON t.id = s.accounting_transfer_id
       JOIN processes p ON p.id = b.process_id
       WHERE v.id = $1`,
      [A.versionId, A.machineId],
    );
    for (const [field, value] of Object.entries(history)) {
      expect(value, `Historienfeld ${field} muss gesetzt sein`).not.toBeNull();
    }
    expect(history).toMatchObject({
      sent_by: adminId,
      approved_by: adminId,
      handover_by: adminId,
      return_by: adminId,
      cleaned_by: adminId,
    });

    // Mails: je Art genau eine gesendete Zustellung, sonst nichts; keine Secret-Payloads nach Versand.
    const mails = await rows<{ kind: string; status: string; n: number }>(
      `SELECT kind, status, count(*)::int AS n FROM mail_deliveries WHERE process_id = $1
       GROUP BY kind, status ORDER BY kind::text`,
      [A.processId],
    );
    expect(mails).toEqual([
      { kind: 'handover_protocol', status: 'sent', n: 1 },
      { kind: 'offer', status: 'sent', n: 1 },
      { kind: 'order_confirmation', status: 'sent', n: 1 },
      { kind: 'return_protocol', status: 'sent', n: 1 },
      { kind: 'voucher_delivery', status: 'sent', n: 1 },
    ]);
    expect(
      await count(`SELECT 1 FROM mail_deliveries WHERE process_id IS DISTINCT FROM $1`, [
        A.processId,
      ]),
    ).toBe(0);
    expect(
      await count(
        `SELECT 1 FROM mail_deliveries WHERE status = 'sent' AND secret_payload_ciphertext IS NOT NULL`,
      ),
    ).toBe(0);
    expect(ctx.mailGateway.sent).toHaveLength(5);

    // Jobs: nichts tot, nichts offen, keine doppelten Idempotenzschlüssel, Transfer genau einmal erfolgreich.
    const jobs = await jobRows(ctx);
    expect(jobs.filter((job) => job.status === 'dead')).toEqual([]);
    expect(jobs.filter((job) => job.status !== 'succeeded')).toEqual([]);
    expect(new Set(jobs.map((job) => job.idempotency_key)).size).toBe(jobs.length);
    expect(jobs.filter((job) => job.type === 'settlement.accounting_transfer')).toHaveLength(1);
    expect(jobs.filter((job) => job.type === 'mail.send')).toHaveLength(5);

    expect(
      await rows<{ kind: string; status: string }>(
        `SELECT kind, status FROM delivery_packets WHERE booking_id = $1 ORDER BY kind`,
        [A.bookingId],
      ),
    ).toEqual([
      { kind: 'handover_completed', status: 'sent' },
      { kind: 'return_completed', status: 'sent' },
    ]);
    expect(
      await rows<{ kind: string; status: string; version: number }>(
        `SELECT kind, status, version FROM appointments WHERE booking_id = $1 ORDER BY kind::text`,
        [A.bookingId],
      ),
    ).toEqual([
      { kind: 'pickup', status: 'completed', version: 3 },
      { kind: 'return', status: 'completed', version: 3 },
    ]);
    expect(
      await count(
        `SELECT 1 FROM machine_assignments WHERE process_id = $1 AND status <> 'returned'`,
        [A.processId],
      ),
    ).toBe(0);
  });

  it('P18-A14. Integritätscheck: keine SQL-Invariante verletzt, alle Dokumente byteidentisch im Storage, Endzählstände 1/1/1/1/5', async () => {
    requires('P18-A11', A.voucherId);
    expect(await integrityViolations(ctx.pool)).toEqual([]);
    expect(await documentStorageMismatches(ctx.pool, ctx.storage)).toEqual([]);
    expect(
      await tableCounts(ctx.pool, [
        'processes',
        'bookings',
        'settlements',
        'accounting_transfers',
        'vouchers',
        'documents',
        'public_inquiry_submissions',
      ]),
    ).toEqual({
      processes: 1,
      bookings: 1,
      settlements: 1,
      accounting_transfers: 1,
      vouchers: 1,
      documents: 5,
      public_inquiry_submissions: 1,
    });
  });
});

describe('P18-A – Szenario A, Variante Lexware-Contract-Fake (Transfer, Webhook, Zahlung)', () => {
  let ctx: TestContext;
  let fake: FakeLexwareServer;
  let adminId = '';
  let cookie = '';
  const L = { processId: '', settlementId: '', transferId: '', invoiceId: '', mappingId: '' };

  beforeAll(async () => {
    ctx = await createTestContext({ lexware: true, env: MAIL_ENV });
    fake = ctx.lexwareFake as FakeLexwareServer;
    expect(ctx.gateway.provider).toBe('lexware');
    await truncateVoucherTables(ctx.pool);
    await truncatePortalTables(ctx.pool);
    await resetLexwareWorld(ctx); // Settlement-/Übergabe-/Lager-/Termin-/CRM-/Auth-/Commerce-Reset + Lexware-Tabellen + Fake
    const session = await adminSession(ctx);
    adminId = session.admin.id;
    cookie = session.cookie;
    await readyLexware(ctx, adminId); // Verbindung (GET /v1/profile) + synthetische Steuerkonfiguration
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  it('P18-A15. Auto-Transfer über zwei Job-Durchläufe ⇒ genau eine Rechnung im Fake (ein POST /v1/invoices), Mapping mit Rechnungs-ID, Rechnungsmail genau einmal, Vorgang completed; manueller Transfer ⇒ already_succeeded', async () => {
    const { world, view } = await settledReturn(ctx, adminId, cookie);
    L.processId = world.processId;
    L.settlementId = view.settlement.id;
    expect(view.settlement.status).toBe('ready_for_accounting');
    expect(
      await rowsIn(
        ctx,
        `SELECT 1 FROM integration_jobs WHERE type = 'settlement.accounting_transfer' AND status = 'pending'`,
      ),
    ).toHaveLength(1);

    await drainAllJobs(ctx);
    await drainAllJobs(ctx);
    const transfer = (await transferRowForSettlement(ctx, L.settlementId))!;
    expect(transfer).toMatchObject({ status: 'succeeded', provider: 'lexware', attempts: 1 });
    expect(transfer.externalReference).not.toBeNull();
    L.transferId = transfer.id;
    expect(fakeInvoices(ctx)).toHaveLength(1);
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(1);
    const mapping = (await invoiceMappingFor(ctx, transfer.id))!;
    expect(mapping.lexwareInvoiceId).toBe(fakeInvoices(ctx)[0]!.id);
    expect(mapping.paymentStatus).toBe('open');
    L.invoiceId = mapping.lexwareInvoiceId!;
    L.mappingId = mapping.id;
    expect(await countIn(ctx, `SELECT 1 FROM accounting_transfers`)).toBe(1);
    expect(await countIn(ctx, `SELECT 1 FROM lexware_invoice_mappings`)).toBe(1);
    expect(await countIn(ctx, `SELECT 1 FROM lexware_contact_mappings`)).toBe(1);

    const settlement = await oneIn<{
      status: string;
      locked_at: Date | null;
      payment_status: string | null;
      invoice_delivery_status: string | null;
    }>(
      ctx,
      `SELECT status, locked_at, payment_status, invoice_delivery_status FROM settlements WHERE id = $1`,
      [L.settlementId],
    );
    expect(settlement).toMatchObject({
      status: 'transferred',
      payment_status: 'open',
      invoice_delivery_status: 'sent',
    });
    expect(settlement.locked_at).not.toBeNull();
    const invoiceMails = await rowsIn<{ status: string; idempotency_key: string }>(
      ctx,
      `SELECT status, idempotency_key FROM mail_deliveries WHERE kind = 'invoice_delivery'`,
    );
    expect(invoiceMails).toEqual([
      { status: 'sent', idempotency_key: `invoice_delivery:${L.mappingId}` },
    ]);
    expect(
      (
        await oneIn<{ main_status: string }>(
          ctx,
          `SELECT main_status FROM processes WHERE id = $1`,
          [L.processId],
        )
      ).main_status,
    ).toBe('completed');

    const current = await settlementViewFor(ctx.app, cookie, L.processId);
    const manual = await transferSettlement(
      ctx.app,
      cookie,
      L.settlementId,
      current.settlement.version,
    );
    expect(manual.status).toBe(200);
    expect(manual.body.outcome).toBe('already_succeeded');
    expect(fakeInvoices(ctx)).toHaveLength(1);
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(1);
  });

  it('P18-A16. Zahlung per signiertem Webhook: dreimal dasselbe Ereignis ⇒ 202 queued + 2× duplicate, genau eine Event-Zeile, ein Job; Verarbeitung ⇒ Zahlungsstatus paid an Mapping, Transfer und Abrechnung', async () => {
    expect(L.invoiceId, 'Voraussetzung fehlt – Schritt P18-A15 muss zuvor grün sein').not.toBe('');
    fake.setInvoicePaid(L.invoiceId, '2026-10-20T00:00:00.000+02:00');
    const signed = fake.signWebhook({ eventType: 'payment.changed', resourceId: L.invoiceId });
    const first = await postWebhook(ctx, signed.body, signed.signature);
    const second = await postWebhook(ctx, signed.body, signed.signature);
    const third = await postWebhook(ctx, signed.body, signed.signature);
    expect([first, second, third].map((r) => r.statusCode)).toEqual([202, 202, 202]);
    expect([first, second, third].map((r) => r.json().status)).toEqual([
      'queued',
      'duplicate',
      'duplicate',
    ]);
    const events = await rowsIn<{ status: string; fingerprint: string }>(
      ctx,
      `SELECT status, fingerprint FROM lexware_webhook_events`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe('queued');
    const eventJobs = await rowsIn<{ status: string; idempotency_key: string }>(
      ctx,
      `SELECT status, idempotency_key FROM integration_jobs WHERE type = 'lexware.event.process'`,
    );
    expect(eventJobs).toEqual([
      { status: 'pending', idempotency_key: `lexware-event:${events[0]!.fingerprint}` },
    ]);

    await drainAllJobs(ctx);
    await drainAllJobs(ctx);
    expect(
      await rowsIn<{ status: string; result_code: string | null }>(
        ctx,
        `SELECT status, result_code FROM lexware_webhook_events`,
      ),
    ).toEqual([{ status: 'processed', result_code: 'UPDATED' }]);
    expect((await invoiceMappingFor(ctx, L.transferId))!).toMatchObject({
      paymentStatus: 'paid',
      voucherStatus: 'paid',
      openAmountCents: 0,
    });
    expect((await transferRowForSettlement(ctx, L.settlementId))!.paymentStatus).toBe('paid');
    expect(
      await oneIn<{ payment_status: string | null; status: string }>(
        ctx,
        `SELECT payment_status, status FROM settlements WHERE id = $1`,
        [L.settlementId],
      ),
    ).toEqual({ payment_status: 'paid', status: 'transferred' });
    // Nur ein Rechnungsbeleg, kein zweiter Create durch die Verarbeitung.
    expect(fakeInvoices(ctx)).toHaveLength(1);
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(1);
    expect(
      await countIn(
        ctx,
        `SELECT 1 FROM integration_jobs WHERE status IN ('pending','processing','dead')`,
      ),
    ).toBe(0);
  });

  it('P18-A17. Integritätscheck der Lexware-Variante: keine Invariante verletzt, Dokumente byteidentisch im Storage', async () => {
    expect(await integrityViolations(ctx.pool)).toEqual([]);
    expect(await documentStorageMismatches(ctx.pool, ctx.storage)).toEqual([]);
  });
});
