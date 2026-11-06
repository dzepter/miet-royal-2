/**
 * Phase 15 – Regressionstests zum adversarialen Review, Gruppe A (BOOKING):
 *
 * - R1: Eine Buchung mit Stornozeile ist NIE `active` – auch nicht nach einem
 *   Reopen des Vorgangs. Zustand, Storno-Block und Rechnungsstatus stammen aus
 *   der Stornozeile; Chat und Online-Storno bleiben gesperrt. Nachbesserung:
 *   Auch die Staff-Portalantwort (canReplyPortal, replyByPortal) ist mit
 *   Stornozeile gesperrt – keine Hinweis-Mail zu einer unsichtbaren Nachricht.
 * - R2: Die bestätigte Stornogebühr ist an den gezeigten Betrag gebunden
 *   (`expectedFeeCents`); weicht sie unter der Prozesssperre ab (Berliner
 *   Mitternacht), antwortet das Portal 409 PORTAL_CANCELLATION_FEE_CHANGED ohne
 *   jede Schreibwirkung.
 * - R5: Wiederholte Storno-Klicks nach einer gescheiterten Bestätigung erzeugen
 *   keine weitere Zustellung; Rate-Limit 10/min je Session.
 * - R11: Die automatische Bestätigung eines Kundenstornos geht an die aktuelle
 *   (verifizierte) Kundenadresse; Staff-Stornos bleiben beim Snapshot.
 * - R12: Das 24-h-Bestätigungsfenster eines kostenfreien Stornos gilt nur für
 *   Kundenstornos und nur für Detailansicht und Storno-Antwort.
 * - R13: Abgeschlossen ohne (übertragene) Abrechnung ⇒ „Rechnung wird vorbereitet“.
 */
import { randomUUID } from 'node:crypto';
import {
  accountingTransfers,
  bookings,
  cancellations,
  conversationMessages,
  customers,
  mailDeliveries,
  processes,
} from '@mietroyal/database';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CancellationFeeChangedError,
  type CancellationRow,
} from '../src/cancellation/cancellation-service.ts';
import { ConversationService } from '../src/communication/conversation/conversation-service.ts';
import { PORTAL_CANCELLATION_VIEWER } from '../src/portal/cancellation.ts';
import { portalInvoiceStatus } from '../src/portal/invoice-status.ts';
import { PORTAL_MESSAGES } from '../src/portal/types.ts';
import {
  PORTAL_CANCELLED_FREE_VISIBLE_MS,
  portalStateOf,
  type VisibleBooking,
} from '../src/portal/visibility.ts';
import {
  PORTAL_INVOICE_LABELS,
  PORTAL_STATE_LABELS,
  type PortalBookingView,
  type PortalCancellationPreview,
} from '../src/portal/views.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  adminSession,
  appointmentsOf,
  bookedProcess,
  bookingRow,
  cancelBooking,
  cancellationServicesFor,
  eventDateInDays,
} from './cancellation-helpers.ts';
import { adminVisibilityCtx, processServiceFor } from './crm-helpers.ts';
import { latestPortalMailToken } from './portal-auth-helpers.ts';
import {
  forbiddenKeysIn,
  portalApp,
  portalGet,
  portalPost,
  portalSessionFor,
  resetPortalWorld,
  type PortalTestApp,
} from './portal-test-helpers.ts';
import { drainAllJobs } from './settlement-helpers.ts';

let ctx: TestContext;
let portal: PortalTestApp;

beforeAll(async () => {
  ctx = await createTestContext();
  portal = await portalApp(ctx);
});
afterAll(async () => {
  await portal.close();
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetPortalWorld(ctx);
});
afterEach(() => {
  vi.useRealTimers();
});

// ── Hilfen ────────────────────────────────────────────────────────────────

const BERLIN_FORMAT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Zeitpunkt zu einer Berliner Wanduhrzeit (CET/CEST werden geprüft, nichts geraten). */
function berlinInstant(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss] = time.split(':').map(Number);
  for (const offsetHours of [1, 2]) {
    const candidate = new Date(
      Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, (hh ?? 0) - offsetHours, mm ?? 0, ss ?? 0),
    );
    if (BERLIN_FORMAT.format(candidate) === `${date} ${time}`) return candidate;
  }
  throw new Error(`Keine eindeutige Berliner Zeit für ${date} ${time}.`);
}

async function previewFor(cookie: string, bookingId: string): Promise<PortalCancellationPreview> {
  const response = await portalGet(
    portal.app,
    cookie,
    `/portal/bookings/${bookingId}/cancellation/preview`,
  );
  expect(response.status).toBe(200);
  return response.body as PortalCancellationPreview;
}

/** Storno wie der Web-Dialog: gezeigte Gebühr der Vorschau als `expectedFeeCents`. */
async function cancelVia(cookie: string, bookingId: string, expectedFeeCents?: number) {
  const fee = expectedFeeCents ?? (await previewFor(cookie, bookingId)).feeCents ?? 0;
  return portalPost(portal.app, cookie, `/portal/bookings/${bookingId}/cancellation`, {
    confirm: true,
    expectedFeeCents: fee,
  });
}

async function cancellationRows(processId: string) {
  return ctx.db.select().from(cancellations).where(eq(cancellations.processId, processId));
}

async function confirmationDeliveries(processId: string) {
  return ctx.db
    .select()
    .from(mailDeliveries)
    .where(
      and(
        eq(mailDeliveries.processId, processId),
        eq(mailDeliveries.kind, 'cancellation_confirmation'),
      ),
    );
}

async function mainStatusOf(processId: string) {
  return (await ctx.db.select().from(processes).where(eq(processes.id, processId)))[0]!.mainStatus;
}

async function listStates(cookie: string): Promise<{ bookingId: string; portalState: string }[]> {
  const response = await portalGet(portal.app, cookie, '/portal/bookings');
  expect(response.status).toBe(200);
  return (response.body as { bookings: { bookingId: string; portalState: string }[] }).bookings;
}

/** Minimal befüllte Stornozeile für die reine Zustandsfunktion. */
function cancellationStub(input: {
  feeCents: number;
  financeStatus: CancellationRow['financeStatus'];
  cancelerType: CancellationRow['cancelerType'];
  cancelledAt: Date;
}): CancellationRow {
  return {
    id: randomUUID(),
    feePercent: input.feeCents > 0 ? 50 : 0,
    paymentStatus: null,
    reopenedAt: null,
    ...input,
  } as unknown as CancellationRow;
}

// ── R1 ────────────────────────────────────────────────────────────────────

describe('R1. Stornozeile entscheidet – Reopen macht eine stornierte Buchung nie wieder aktiv', () => {
  it('R1. Zustandsfunktion: mit Stornozeile nie `active` – unabhängig vom Vorgangsstatus', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const booking = await bookingRow(ctx, booked.bookingId);
    const now = new Date();
    for (const mainStatus of ['open', 'reopened', 'completed', 'cancelled'] as const) {
      const row = (cancellation: CancellationRow) => ({
        booking,
        process: {
          id: booked.processId,
          processNumber: 'MR-0000-0000',
          mainStatus,
          eventDate: null,
        },
        settlement: null,
        cancellation,
      });
      const fee = (financeStatus: CancellationRow['financeStatus']) =>
        cancellationStub({
          feeCents: 3750,
          financeStatus,
          cancelerType: 'admin',
          cancelledAt: now,
        });
      expect(
        portalStateOf(row(fee('accounting_pending')), now, { includeCancelledFree: false }),
        mainStatus,
      ).toBe('cancelled_fee');
      expect(
        portalStateOf(row(fee('invoice_open')), now, { includeCancelledFree: true }),
        mainStatus,
      ).toBe('cancelled_fee');
      expect(
        portalStateOf(row(fee('paid')), now, { includeCancelledFree: true }),
        mainStatus,
      ).toBeNull();
      const free = cancellationStub({
        feeCents: 0,
        financeStatus: 'no_invoice',
        cancelerType: 'customer',
        cancelledAt: now,
      });
      expect(portalStateOf(row(free), now, { includeCancelledFree: false }), mainStatus).toBeNull();
      expect(portalStateOf(row(free), now, { includeCancelledFree: true }), mainStatus).toBe(
        'cancelled_free',
      );
    }
  });

  it('R1. Reopen nach kostenpflichtigem Storno: weiter cancelled_fee mit Storno-Block und Rechnungsstatus, kein Chat, kein Online-Storno', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 10 }); // 50 %
    const session = await portalSessionFor(ctx, booked.customerId);
    const cancelled = await cancelBooking(ctx, admin.id, booked.processId);
    expect(cancelled.feeCents).toBeGreaterThan(0);
    await processServiceFor(ctx).reopen(booked.processId, admin.id);
    expect(await mainStatusOf(booked.processId)).toBe('reopened');

    const detail = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${booked.bookingId}`,
    );
    expect(detail.status).toBe(200);
    const view = detail.body as PortalBookingView;
    expect(view).toMatchObject({
      portalState: 'cancelled_fee',
      stateLabel: PORTAL_STATE_LABELS.cancelled_fee,
      canCancelOnline: false,
      canMessage: false,
      travelStatus: 'none',
      cancellation: {
        feeCents: cancelled.feeCents,
        feePercent: 50,
        invoiceFollows: true,
      },
      invoice: { status: 'preparing', label: PORTAL_INVOICE_LABELS.preparing },
    });
    expect(forbiddenKeysIn(detail.body)).toEqual([]);
    expect(await listStates(session.cookie)).toEqual([
      expect.objectContaining({ bookingId: booked.bookingId, portalState: 'cancelled_fee' }),
    ]);
    const preview = await previewFor(session.cookie, booked.bookingId);
    expect(preview).toMatchObject({
      allowed: false,
      blockedMessage: PORTAL_MESSAGES.CANCELLATION_BLOCKED,
    });

    // CHAT nutzt dieselbe Policy: lesen ja, neue Nachricht 409.
    const messages = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${booked.bookingId}/messages`,
    );
    expect(messages.status).toBe(200);
    expect((messages.body as { canSend: boolean }).canSend).toBe(false);
    const post = await portalPost(
      portal.app,
      session.cookie,
      `/portal/bookings/${booked.bookingId}/messages`,
      { body: 'Ist meine Buchung wieder aktiv?' },
    );
    expect(post.status).toBe(409);
    expect(post.body).toMatchObject({
      error: { code: 'PORTAL_BOOKING_CLOSED', message: PORTAL_MESSAGES.BOOKING_CLOSED },
    });

    // Erneuter Storno-Klick: idempotent, kein zweites Storno.
    const again = await cancelVia(session.cookie, booked.bookingId, 0);
    expect(again.status).toBe(200);
    expect((again.body as PortalBookingView).portalState).toBe('cancelled_fee');
    expect(await cancellationRows(booked.processId)).toHaveLength(1);

    // Finanziell erledigt ⇒ unsichtbar, auch im wiedereröffneten Vorgang.
    await ctx.db
      .update(cancellations)
      .set({ financeStatus: 'paid' })
      .where(eq(cancellations.processId, booked.processId));
    expect(await listStates(session.cookie)).toEqual([]);
    expect(
      (await portalGet(portal.app, session.cookie, `/portal/bookings/${booked.bookingId}`)).status,
    ).toBe(404);
  });

  it('R1. Reopen nach 0-€-Storno: bleibt unsichtbar (Liste leer, Detail 404)', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30 }); // 0 %
    const session = await portalSessionFor(ctx, booked.customerId);
    const cancelled = await cancelBooking(ctx, admin.id, booked.processId);
    expect(cancelled.feeCents).toBe(0);
    await processServiceFor(ctx).reopen(booked.processId, admin.id);
    expect(await listStates(session.cookie)).toEqual([]);
    expect(
      (await portalGet(portal.app, session.cookie, `/portal/bookings/${booked.bookingId}`)).status,
    ).toBe(404);
  });
});

// ── R1 (Nachbesserung): Staff-Portalantwort folgt der Policy ─────────────

const staffConversation = (processId: string, cookie: string) =>
  ctx.app.inject({
    method: 'GET',
    url: `/staff/processes/${processId}/conversation`,
    headers: { cookie },
  });

const staffReply = (processId: string, cookie: string, payload: Record<string, unknown>) =>
  ctx.app.inject({
    method: 'POST',
    url: `/staff/processes/${processId}/conversation/reply`,
    headers: { cookie },
    payload,
  });

async function portalReplyRows(processId: string) {
  return ctx.db
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.processId, processId),
        eq(conversationMessages.channel, 'portal'),
      ),
    );
}

async function replyNotices(processId: string) {
  return ctx.db
    .select()
    .from(mailDeliveries)
    .where(
      and(
        eq(mailDeliveries.processId, processId),
        eq(mailDeliveries.kind, 'customer_portal_reply_notice'),
      ),
    );
}

describe('R1. Nach einem Storno keine Staff-Portalantwort – auch nicht im wiedereröffneten Vorgang', () => {
  it('R1. 0-€-Staff-Storno, dann Reopen ⇒ canReplyPortal false, Portalantwort 409 ohne Nachricht und ohne Hinweis-Mail; E-Mail-Antwort bleibt möglich', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30 }); // 0 %
    const session = await portalSessionFor(ctx, booked.customerId);
    const cancelled = await cancelBooking(ctx, admin.id, booked.processId);
    expect(cancelled.feeCents).toBe(0);
    await processServiceFor(ctx).reopen(booked.processId, admin.id);
    expect(await mainStatusOf(booked.processId)).toBe('reopened');

    const view = await staffConversation(booked.processId, cookie);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ canReplyPortal: false, portalActive: true });
    const blocked = await staffReply(booked.processId, cookie, {
      channel: 'portal',
      body: 'Neue Nachricht im Portal',
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('CONFLICT');
    expect(await portalReplyRows(booked.processId)).toHaveLength(0);
    expect(await replyNotices(booked.processId)).toHaveLength(0);

    // Service direkt (ohne Route): dieselbe Sperre unter der Prozesssperre.
    await expect(
      new ConversationService(ctx.db, ctx.storage).replyByPortal(null, {
        processId: booked.processId,
        body: 'Direkt über den Service',
        staffUserId: admin.id,
        appEnv: 'development',
      }),
    ).rejects.toMatchObject({ name: 'AuthError', code: 'CONFLICT' });
    expect(await portalReplyRows(booked.processId)).toHaveLength(0);

    // Der Kunde sieht die Buchung weiterhin nicht – es gäbe nichts zu lesen.
    expect(
      (await portalGet(portal.app, session.cookie, `/portal/bookings/${booked.bookingId}/messages`))
        .status,
    ).toBe(404);
    await drainAllJobs(ctx);
    expect(ctx.mailGateway.sent.map((mail) => mail.subject)).not.toContainEqual(
      expect.stringMatching(/^Neue Nachricht von Miet-Royal/),
    );

    // Der Weg zum Kunden bleibt die E-Mail-Antwort.
    const email = await staffReply(booked.processId, cookie, {
      channel: 'email',
      body: 'Per E-Mail',
    });
    expect(email.statusCode).toBe(201);
  });

  it('R1. Kostenpflichtiger Staff-Storno, dann Reopen ⇒ ebenfalls keine Portalantwort (Kunde liest nur, canMessage false) – Fachentscheidung bestätigt (2026-11-06): keine Portal-Chat-Reaktivierung durch Reopen', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 10 }); // 50 %
    const session = await portalSessionFor(ctx, booked.customerId);
    const cancelled = await cancelBooking(ctx, admin.id, booked.processId);
    expect(cancelled.feeCents).toBeGreaterThan(0);
    await processServiceFor(ctx).reopen(booked.processId, admin.id);

    const detail = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${booked.bookingId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ portalState: 'cancelled_fee', canMessage: false });

    expect((await staffConversation(booked.processId, cookie)).json().canReplyPortal).toBe(false);
    const blocked = await staffReply(booked.processId, cookie, {
      channel: 'portal',
      body: 'Antwort im Portal',
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('CONFLICT');
    expect(await portalReplyRows(booked.processId)).toHaveLength(0);
    expect(await replyNotices(booked.processId)).toHaveLength(0);
    const messages = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${booked.bookingId}/messages`,
    );
    expect(messages.status).toBe(200);
    expect(messages.body).toMatchObject({ messages: [], canSend: false });
  });

  it('R1. Gegenprobe: abgeschlossen und wiedereröffnet OHNE Storno ⇒ Portalantwort weiter möglich (201, ein Hinweis, Kunde sieht sie)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const session = await portalSessionFor(ctx, booked.customerId);
    await processServiceFor(ctx).complete(booked.processId, adminVisibilityCtx());
    await processServiceFor(ctx).reopen(booked.processId, admin.id);
    expect(await mainStatusOf(booked.processId)).toBe('reopened');
    expect(await cancellationRows(booked.processId)).toHaveLength(0);

    expect((await staffConversation(booked.processId, cookie)).json().canReplyPortal).toBe(true);
    const sent = await staffReply(booked.processId, cookie, {
      channel: 'portal',
      body: 'Wir sind wieder für dich da.',
    });
    expect(sent.statusCode).toBe(201);
    expect(await replyNotices(booked.processId)).toHaveLength(1);
    const messages = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${booked.bookingId}/messages`,
    );
    expect(messages.status).toBe(200);
    expect(messages.body).toMatchObject({
      canSend: true,
      messages: [
        expect.objectContaining({ from: 'miet_royal', body: 'Wir sind wieder für dich da.' }),
      ],
    });
  });
});

// ── R2 ────────────────────────────────────────────────────────────────────

describe('R2. Bestätigte Stornogebühr ist an die gezeigte Vorschau gebunden', () => {
  it('R2. Vorschau 23:59:30 Berlin (0 %), Bestätigung 00:00:30 mit erwartet 0 ⇒ 409 ohne Wirkung; erneut mit neuem Betrag ⇒ 200', async () => {
    const { admin } = await adminSession(ctx);
    // Tag D = morgen (Berlin); Event = D + 15 ⇒ an D noch 15 Tage (0 %), an D+1 nur 14 (50 %).
    const dayD = eventDateInDays(1);
    const t1 = berlinInstant(dayD, '23:59:30');
    const t2 = new Date(t1.getTime() + 60_000);
    expect(BERLIN_FORMAT.format(t2).endsWith('00:00:30')).toBe(true);
    const booked = await bookedProcess(ctx, admin.id, { eventDate: eventDateInDays(15, t1) });
    const session = await portalSessionFor(ctx, booked.customerId);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t1);
    const shown = await previewFor(session.cookie, booked.bookingId);
    expect(shown).toMatchObject({ remainingDays: 15, feePercent: 0, feeCents: 0, allowed: true });

    vi.setSystemTime(t2);
    const stale = await cancelVia(session.cookie, booked.bookingId, shown.feeCents!);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      error: {
        code: 'PORTAL_CANCELLATION_FEE_CHANGED',
        message: PORTAL_MESSAGES.CANCELLATION_FEE_CHANGED,
      },
    });
    // Nichts geschrieben: keine Stornozeile, Vorgang offen, Termine geplant, keine Mail, kein Transfer.
    expect(await cancellationRows(booked.processId)).toEqual([]);
    expect(await mainStatusOf(booked.processId)).toBe('open');
    expect((await appointmentsOf(ctx, booked.bookingId)).map((a) => a.status)).toEqual([
      'scheduled',
      'scheduled',
    ]);
    expect(await confirmationDeliveries(booked.processId)).toEqual([]);
    expect(
      await ctx.db
        .select()
        .from(accountingTransfers)
        .where(eq(accountingTransfers.processId, booked.processId)),
    ).toEqual([]);

    // Neue Vorschau zeigt den neuen Betrag – mit ihm gelingt die Bestätigung.
    const fresh = await previewFor(session.cookie, booked.bookingId);
    expect(fresh).toMatchObject({ remainingDays: 14, feePercent: 50, allowed: true });
    expect(fresh.feeCents).toBeGreaterThan(0);
    const confirmed = await cancelVia(session.cookie, booked.bookingId, fresh.feeCents!);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({
      portalState: 'cancelled_fee',
      cancellation: { feeCents: fresh.feeCents, feePercent: 50 },
    });
    const rows = await cancellationRows(booked.processId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ feeCents: fresh.feeCents, cancelerType: 'customer' });
  });

  it('R2. Body: expectedFeeCents ist Pflicht (ganzzahlig, ≥ 0) – sonst 400 ohne Wirkung', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const session = await portalSessionFor(ctx, booked.customerId);
    for (const payload of [
      { confirm: true },
      { confirm: true, expectedFeeCents: -1 },
      { confirm: true, expectedFeeCents: 1.5 },
      { confirm: true, expectedFeeCents: '0' },
      { confirm: true, expectedFeeCents: 100_000_001 },
      { confirm: false, expectedFeeCents: 0 },
      { confirm: true, expectedFeeCents: 0, feePercent: 0 },
    ]) {
      const response = await portalPost(
        portal.app,
        session.cookie,
        `/portal/bookings/${booked.bookingId}/cancellation`,
        payload,
      );
      expect(response.status, JSON.stringify(payload)).toBe(400);
    }
    expect(await cancellationRows(booked.processId)).toEqual([]);
    const ok = await cancelVia(session.cookie, booked.bookingId, 0);
    expect(ok.status).toBe(200);
  });

  it('R2. Service: Abweichung unter der Sperre ⇒ CancellationFeeChangedError vor jeder Schreiboperation; der idempotente Zweig ignoriert den Wert', async () => {
    const { admin } = await adminSession(ctx);
    const { service } = cancellationServicesFor(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    const preview = await service.preview(booked.processId);
    expect(preview.feeCents).toBeGreaterThan(0);
    const attempt = service.cancel(
      booked.processId,
      { id: null, type: 'customer' },
      PORTAL_CANCELLATION_VIEWER,
      new Date(),
      { expectedFeeCents: preview.feeCents! - 1 },
    );
    await expect(attempt).rejects.toBeInstanceOf(CancellationFeeChangedError);
    await expect(attempt).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await cancellationRows(booked.processId)).toEqual([]);
    expect(await mainStatusOf(booked.processId)).toBe('open');

    const view = await service.cancel(
      booked.processId,
      { id: null, type: 'customer' },
      PORTAL_CANCELLATION_VIEWER,
      new Date(),
      { expectedFeeCents: preview.feeCents! },
    );
    expect(view.feeCents).toBe(preview.feeCents);
    // Bereits storniert: idempotent, der Prüfwert spielt keine Rolle mehr.
    const again = await service.cancel(
      booked.processId,
      { id: null, type: 'customer' },
      PORTAL_CANCELLATION_VIEWER,
      new Date(),
      { expectedFeeCents: 0 },
    );
    expect(again.id).toBe(view.id);
    expect(await cancellationRows(booked.processId)).toHaveLength(1);
  });
});

// ── R5 ────────────────────────────────────────────────────────────────────

describe('R5. Wiederholte Storno-Klicks erzeugen keine weiteren Mails', () => {
  it('R5. Gescheiterte Bestätigung + 4 weitere Klicks ⇒ keine zusätzliche Zustellung, kein weiterer Gateway-Versuch', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30 }); // 0 €
    const session = await portalSessionFor(ctx, booked.customerId);
    // Erst nach dem Welt-Helfer einstellen (der verbraucht vorher gesetzte Ergebnisse).
    // Jede Zustellung scheitert dauerhaft (wie im Review) – beforeEach leert die Warteschlange.
    ctx.mailGateway.nextOutcomes(
      ...Array.from({ length: 5 }, () => ({ outcome: 'permanent_error' as const })),
    );
    expect((await cancelVia(session.cookie, booked.bookingId, 0)).status).toBe(200);
    await drainAllJobs(ctx);
    const first = await confirmationDeliveries(booked.processId);
    expect(first.map((d) => d.status)).toEqual(['failed']);
    expect((await cancellationRows(booked.processId))[0]!.confirmationStatus).toBe('failed');
    const attemptsAfterFirst = ctx.mailGateway.attempts.length;
    expect(attemptsAfterFirst).toBe(1);

    for (let click = 0; click < 4; click += 1) {
      const response = await cancelVia(session.cookie, booked.bookingId, 0);
      expect(response.status).toBe(200);
      expect((response.body as PortalBookingView).portalState).toBe('cancelled_free');
      await drainAllJobs(ctx);
    }
    expect(await confirmationDeliveries(booked.processId)).toHaveLength(1);
    expect(ctx.mailGateway.attempts).toHaveLength(attemptsAfterFirst);
    expect(await cancellationRows(booked.processId)).toHaveLength(1);
    expect((await cancellationRows(booked.processId))[0]!.confirmationStatus).toBe('failed');
  });

  it('R5. Rate-Limit: 10 Storno-POSTs je Session und Minute, der 11. ⇒ 429; eine andere Session ist nicht betroffen', async () => {
    const limited = await createTestContext({ rateLimitEnabled: true });
    try {
      const { admin } = await adminSession(ctx);
      const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
      const session = await portalSessionFor(ctx, booked.customerId);
      const other = await portalSessionFor(ctx, booked.customerId);
      const post = (cookie: string) =>
        limited.app.inject({
          method: 'POST',
          url: `/portal/bookings/${booked.bookingId}/cancellation`,
          headers: { cookie },
          payload: { confirm: true, expectedFeeCents: 0 },
        });
      for (let i = 0; i < 10; i += 1) {
        expect((await post(session.cookie)).statusCode, `Klick ${i + 1}`).toBe(200);
      }
      expect((await post(session.cookie)).statusCode).toBe(429);
      expect((await post(other.cookie)).statusCode).toBe(200);
      expect(await cancellationRows(booked.processId)).toHaveLength(1);
      expect(await confirmationDeliveries(booked.processId)).toHaveLength(1);
    } finally {
      await destroyTestContext(limited);
    }
  });
});

// ── R11 ───────────────────────────────────────────────────────────────────

describe('R11. Bestätigung eines Kundenstornos geht an die aktuelle Kundenadresse', () => {
  it('R11. Verifizierter E-Mail-Wechsel, dann Kundenstorno ⇒ Zustellung an die neue Adresse (Snapshot unverändert)', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const snapshotEmail = (
      (await bookingRow(ctx, booked.bookingId)).customerSnapshot as Record<string, unknown>
    ).email;
    expect(snapshotEmail).toBe('klara.kommerz@test.example');

    // Echter Portal-Wechsel: Anforderung (frische Reauth der Session) → Link → Consume.
    const before = await portalSessionFor(ctx, booked.customerId);
    const request = await portal.app.inject({
      method: 'POST',
      url: '/portal/auth/email-change/request',
      headers: { cookie: before.cookie },
      payload: { email: 'klara.neu@test.example' },
    });
    expect(request.statusCode).toBe(202);
    const link = await latestPortalMailToken(ctx, 'customer_portal_email_change');
    expect(link?.recipientEmail).toBe('klara.neu@test.example');
    const consume = await portal.app.inject({
      method: 'POST',
      url: '/portal/auth/email-change/consume',
      payload: { token: link!.token },
    });
    expect(consume.statusCode).toBe(200);
    const customer = (
      await ctx.db.select().from(customers).where(eq(customers.id, booked.customerId))
    )[0]!;
    expect(customer.email).toBe('klara.neu@test.example');

    const session = await portalSessionFor(ctx, booked.customerId);
    expect((await cancelVia(session.cookie, booked.bookingId)).status).toBe(200);
    const deliveries = await confirmationDeliveries(booked.processId);
    expect(deliveries.map((d) => d.recipientEmail)).toEqual(['klara.neu@test.example']);
    // Der eingefrorene Snapshot bleibt unberührt.
    expect(
      (
        (await ctx.db.select().from(bookings).where(eq(bookings.id, booked.bookingId)))[0]!
          .customerSnapshot as Record<string, unknown>
      ).email,
    ).toBe('klara.kommerz@test.example');
  });

  it('R11. Staff-Storno bleibt bei der Snapshot-Adresse; ohne aktuelle Adresse Rückfall auf den Snapshot', async () => {
    const { admin } = await adminSession(ctx);
    const { service } = cancellationServicesFor(ctx);

    const staffCase = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    await ctx.db
      .update(customers)
      .set({ email: 'klara.staff@test.example' })
      .where(eq(customers.id, staffCase.customerId));
    const staffView = await cancelBooking(ctx, admin.id, staffCase.processId);
    await service.sendConfirmation(staffView.id);
    expect(
      (await confirmationDeliveries(staffCase.processId)).map((d) => d.recipientEmail),
    ).toEqual(['klara.kommerz@test.example']);

    const noCurrent = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    await ctx.db
      .update(customers)
      .set({ email: null })
      .where(eq(customers.id, noCurrent.customerId));
    const session = await portalSessionFor(ctx, noCurrent.customerId);
    expect((await cancelVia(session.cookie, noCurrent.bookingId)).status).toBe(200);
    expect(
      (await confirmationDeliveries(noCurrent.processId)).map((d) => d.recipientEmail),
    ).toEqual(['klara.kommerz@test.example']);
  });
});

// ── R12 ───────────────────────────────────────────────────────────────────

const subRoutes = (bookingId: string, documentId: string) => [
  `/portal/bookings/${bookingId}/documents`,
  `/portal/bookings/${bookingId}/documents/${documentId}`,
  `/portal/bookings/${bookingId}/cancellation/preview`,
  `/portal/bookings/${bookingId}/travel-status`,
  `/portal/bookings/${bookingId}/messages`,
  `/portal/bookings/${bookingId}/messages/${randomUUID()}/photos/${randomUUID()}`,
];

describe('R12. 24-h-Bestätigungsfenster nur für Kundenstorno und nur für Detail/Storno-Antwort', () => {
  it('R12. Kundenstorno 0 €: Detail und Storno-Antwort zeigen die Bestätigung; Dokumente, Vorschau, Travel-Status, Nachrichten, Fotos ⇒ 404', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const session = await portalSessionFor(ctx, booked.customerId);
    const documents = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${booked.bookingId}/documents`,
    );
    const list = (documents.body as { documents: { id: string }[] }).documents;
    expect(list.length).toBeGreaterThan(0);

    const cancelled = await cancelVia(session.cookie, booked.bookingId, 0);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      portalState: 'cancelled_free',
      cancellation: { feeCents: 0, invoiceFollows: false },
    });
    const detail = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${booked.bookingId}`,
    );
    expect(detail.status).toBe(200);
    expect((detail.body as PortalBookingView).portalState).toBe('cancelled_free');
    expect(await listStates(session.cookie)).toEqual([]);
    for (const url of subRoutes(booked.bookingId, list[0]!.id)) {
      const response = await portalGet(portal.app, session.cookie, url);
      expect(response.status, url).toBe(404);
      expect(response.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    // Wiederholter Klick innerhalb des Fensters: idempotente Bestätigungsansicht.
    const again = await cancelVia(session.cookie, booked.bookingId, 0);
    expect(again.status).toBe(200);
    expect((again.body as PortalBookingView).portalState).toBe('cancelled_free');

    // Nach 24 h ist auch die Detailansicht weg.
    await ctx.db
      .update(cancellations)
      .set({ cancelledAt: new Date(Date.now() - PORTAL_CANCELLED_FREE_VISIBLE_MS - 60_000) })
      .where(eq(cancellations.processId, booked.processId));
    expect(
      (await portalGet(portal.app, session.cookie, `/portal/bookings/${booked.bookingId}`)).status,
    ).toBe(404);
  });

  it('R12. Staff-Storno 0 € ⇒ sofort unsichtbar (Detail, Unterrouten und Storno-POST 404)', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const session = await portalSessionFor(ctx, booked.customerId);
    const view = await cancelBooking(ctx, admin.id, booked.processId);
    expect(view.feeCents).toBe(0);
    for (const url of [
      `/portal/bookings/${booked.bookingId}`,
      ...subRoutes(booked.bookingId, randomUUID()),
    ]) {
      const response = await portalGet(portal.app, session.cookie, url);
      expect(response.status, url).toBe(404);
    }
    expect((await cancelVia(session.cookie, booked.bookingId, 0)).status).toBe(404);
    expect(await listStates(session.cookie)).toEqual([]);
  });
});

// ── R13 ───────────────────────────────────────────────────────────────────

describe('R13. Abgeschlossen ohne (übertragene) Abrechnung ⇒ „Rechnung wird vorbereitet“', () => {
  it('R13. completed ohne Abrechnung: „Abgeschlossen – Rechnung offen“ mit „Rechnung wird vorbereitet“, nie „Keine Rechnung vorhanden“', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const session = await portalSessionFor(ctx, booked.customerId);
    await processServiceFor(ctx).complete(booked.processId, adminVisibilityCtx());
    const detail = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${booked.bookingId}`,
    );
    expect(detail.status).toBe(200);
    const view = detail.body as PortalBookingView;
    expect(view.portalState).toBe('completed_open');
    expect(view.stateLabel).toBe(PORTAL_STATE_LABELS.completed_open);
    expect(view.invoice).toEqual({
      status: 'preparing',
      label: 'Rechnung wird vorbereitet',
      finalAmountCents: null,
    });
    expect(JSON.stringify(view)).not.toContain(PORTAL_INVOICE_LABELS.none);
  });

  it('R13. Statusmatrix: completed_open ohne bzw. mit nicht übertragener Abrechnung ⇒ preparing; aktive Buchung ohne Abrechnung bleibt none', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const booking = await bookingRow(ctx, booked.bookingId);
    const base = (
      mainStatus: 'open' | 'completed',
      portalState: VisibleBooking['portalState'],
      settlement: VisibleBooking['settlement'],
    ): VisibleBooking => ({
      booking,
      process: { id: booked.processId, processNumber: 'MR-0000-0000', mainStatus, eventDate: null },
      settlement,
      cancellation: null,
      portalState,
    });
    expect(portalInvoiceStatus(base('completed', 'completed_open', null)).status).toBe('preparing');
    expect(
      portalInvoiceStatus(
        base('completed', 'completed_open', {
          id: randomUUID(),
          lockedAt: null,
          paymentStatus: null,
          amountDueCents: 1234,
        }),
      ),
    ).toEqual({ status: 'preparing', label: 'Rechnung wird vorbereitet', finalAmountCents: null });
    expect(portalInvoiceStatus(base('open', 'active', null)).status).toBe('none');
  });
});
