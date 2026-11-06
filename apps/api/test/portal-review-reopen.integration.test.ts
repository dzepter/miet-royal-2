/**
 * Phase 15 (Final-Korrektur) – Paid-Booking-Reopen (Auftrag §1–§5, §8):
 *
 * - Eine finanziell abgeschlossene Buchung (reguläres Settlement übertragen, `locked_at`
 *   gesetzt, `payment_status = 'paid'`) bleibt im Portal unsichtbar – unabhängig vom
 *   Vorgangsstatus (completed, reopened, technisch wieder open). Ein Staff-Reopen ist ein
 *   interner Arbeitsstatus, keine Reaktivierung der alten Kundenbuchung.
 * - Die Staff-Portalantwort folgt derselben Regel: bei final bezahltem Settlement kein
 *   `canReplyPortal`, `replyByPortal` ⇒ 409 ohne Nachricht und ohne Hinweis-Mail.
 * - Ohne finale Zahlung (Settlement open/overdue, nicht übertragen, Zahlungsstatus NULL)
 *   bleibt ein wiedereröffneter Vorgang sichtbar.
 * - Stornozeile hat weiterhin Vorrang (bestehende Policy unverändert); nach Storno + Reopen
 *   bleibt die Staff-Portalantwort gesperrt.
 * - Eine Portalnachricht ist KEINE automatische Settlement-Kundenantwort.
 */
import {
  conversationMessages,
  mailDeliveries,
  processes,
  settlementClarifications,
  settlements,
} from '@mietroyal/database';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConversationService } from '../src/communication/conversation/conversation-service.ts';
import { portalStateOf } from '../src/portal/visibility.ts';
import {
  PORTAL_INVOICE_LABELS,
  PORTAL_STATE_LABELS,
  type PortalBookingView,
} from '../src/portal/views.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { adminSession, bookedProcess, bookingRow, cancelBooking } from './cancellation-helpers.ts';
import { adminVisibilityCtx, processServiceFor } from './crm-helpers.ts';
import {
  acceptedBookingForCustomer,
  portalApp,
  portalGet,
  portalPost,
  portalSessionFor,
  resetPortalWorld,
  type PortalTestApp,
} from './portal-test-helpers.ts';
import {
  drainAllJobs,
  openClarifications,
  post,
  settledReturn,
  settlementRowFor,
  settlementViewFor,
} from './settlement-helpers.ts';
import { paidSettledWorld } from './voucher-helpers.ts';

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

// ── Hilfen ────────────────────────────────────────────────────────────────

const PORTAL_REPLY_BLOCKED = 'Zu diesem Vorgang ist keine Portalnachricht möglich.';

interface Summary {
  bookingId: string;
  portalState: string;
}

async function listFor(cookie: string): Promise<Summary[]> {
  const response = await portalGet(portal.app, cookie, '/portal/bookings');
  expect(response.status).toBe(200);
  return (response.body as { bookings: Summary[] }).bookings;
}

async function detailStatus(cookie: string, bookingId: string): Promise<number> {
  return (await portalGet(portal.app, cookie, `/portal/bookings/${bookingId}`)).status;
}

async function mainStatusOf(processId: string) {
  return (await ctx.db.select().from(processes).where(eq(processes.id, processId)))[0]!.mainStatus;
}

/** Reopen über die echte Staff-Route (Recht process.reopen_completed). */
async function reopenViaRoute(cookie: string, processId: string): Promise<void> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/staff/processes/${processId}/reopen`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ reopened: true });
  expect(await mainStatusOf(processId)).toBe('reopened');
}

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

async function portalRows(processId: string) {
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

/** Abgeschlossen + Settlement übertragen (`locked_at`) + `payment_status = 'paid'`. */
async function paidAndCompleted(adminId: string, cookie: string) {
  const paid = await paidSettledWorld(ctx, adminId, cookie, { paymentStatus: 'paid' });
  expect(await mainStatusOf(paid.world.processId)).toBe('completed');
  const settlement = (await settlementRowFor(ctx, paid.world.processId))!;
  expect(settlement.lockedAt).not.toBeNull();
  expect(settlement.paymentStatus).toBe('paid');
  return paid;
}

// ── R15-1 – R15-3: final bezahlt ⇒ immer unsichtbar ───────────────────────

describe('R15-1. – R15-3. Final bezahltes Settlement ⇒ unsichtbar, unabhängig vom Vorgangsstatus', () => {
  it('R15-1. completed + finales Settlement + payment_status=paid ⇒ unsichtbar (Liste leer, Detail 404)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidAndCompleted(admin.id, cookie);
    const session = await portalSessionFor(ctx, paid.world.customerId);
    expect(await listFor(session.cookie)).toEqual([]);
    expect(await detailStatus(session.cookie, paid.world.bookingId)).toBe(404);
  });

  it('R15-2. derselbe Vorgang danach über die Staff-Route wiedereröffnet ⇒ weiterhin unsichtbar', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidAndCompleted(admin.id, cookie);
    const session = await portalSessionFor(ctx, paid.world.customerId);
    await reopenViaRoute(cookie, paid.world.processId);
    // Das Settlement bleibt durch den Reopen unverändert final bezahlt.
    const settlement = (await settlementRowFor(ctx, paid.world.processId))!;
    expect(settlement.lockedAt).not.toBeNull();
    expect(settlement.paymentStatus).toBe('paid');

    expect(await listFor(session.cookie)).toEqual([]);
    const detail = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${paid.world.bookingId}`,
    );
    expect(detail.status).toBe(404);
    expect(detail.body).toMatchObject({ error: { code: 'NOT_FOUND', message: 'Nicht gefunden.' } });
    expect(JSON.stringify(detail.body)).not.toContain(PORTAL_STATE_LABELS.active);
  });

  it('R15-2b. Staff-Portalantwort bei bezahltem, wiedereröffnetem Vorgang gesperrt (canReplyPortal false, 409, keine Hinweis-Mail)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidAndCompleted(admin.id, cookie);
    const session = await portalSessionFor(ctx, paid.world.customerId);
    await reopenViaRoute(cookie, paid.world.processId);
    ctx.mailGateway.reset();

    const view = await staffConversation(paid.world.processId, cookie);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ canReplyPortal: false, portalActive: true });

    const blocked = await staffReply(paid.world.processId, cookie, {
      channel: 'portal',
      body: 'Ihre Buchung ist wieder aktiv.',
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      error: { code: 'CONFLICT', message: PORTAL_REPLY_BLOCKED },
    });
    expect(await portalRows(paid.world.processId)).toHaveLength(0);
    expect(await replyNotices(paid.world.processId)).toHaveLength(0);

    // Service direkt (ohne Route): dieselbe Sperre unter der Vorgangssperre.
    await expect(
      new ConversationService(ctx.db, ctx.storage).replyByPortal(null, {
        processId: paid.world.processId,
        body: 'Direkt über den Service',
        staffUserId: admin.id,
        appEnv: 'development',
      }),
    ).rejects.toMatchObject({ name: 'AuthError', code: 'CONFLICT' });
    expect(await portalRows(paid.world.processId)).toHaveLength(0);

    await drainAllJobs(ctx);
    expect(ctx.mailGateway.sent.map((mail) => mail.subject)).not.toContainEqual(
      expect.stringMatching(/^Neue Nachricht von Miet-Royal/),
    );
    // Der Kunde sieht die Buchung (und damit den Chat) nicht.
    expect(
      (
        await portalGet(
          portal.app,
          session.cookie,
          `/portal/bookings/${paid.world.bookingId}/messages`,
        )
      ).status,
    ).toBe(404);
    // Der Weg zum Kunden bleibt die E-Mail-Antwort.
    const email = await staffReply(paid.world.processId, cookie, {
      channel: 'email',
      body: 'Per E-Mail',
    });
    expect(email.statusCode).toBe(201);
  });

  it('R15-3. derselbe Vorgang danach technisch wieder auf open gesetzt ⇒ weiterhin unsichtbar (Policy-Matrix)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidAndCompleted(admin.id, cookie);
    const session = await portalSessionFor(ctx, paid.world.customerId);
    await reopenViaRoute(cookie, paid.world.processId);
    // Technische Simulation (administrativ/versehentlich): main_status direkt auf open.
    await ctx.db
      .update(processes)
      .set({ mainStatus: 'open' })
      .where(eq(processes.id, paid.world.processId));
    expect(await mainStatusOf(paid.world.processId)).toBe('open');

    expect(await listFor(session.cookie)).toEqual([]);
    expect(await detailStatus(session.cookie, paid.world.bookingId)).toBe(404);
    expect((await staffConversation(paid.world.processId, cookie)).json().canReplyPortal).toBe(
      false,
    );
    const blocked = await staffReply(paid.world.processId, cookie, {
      channel: 'portal',
      body: 'Hallo',
    });
    expect(blocked.statusCode).toBe(409);
    expect(await replyNotices(paid.world.processId)).toHaveLength(0);

    // Zustandsfunktion: final bezahlt ⇒ null für jeden Vorgangsstatus; NULL-Werte sperren nie.
    const booking = await bookingRow(ctx, paid.world.bookingId);
    const now = new Date();
    const row = (
      mainStatus: 'open' | 'reopened' | 'completed' | 'cancelled',
      lockedAt: Date | null,
      paymentStatus: 'open' | 'paid' | 'overdue' | null,
    ) => ({
      booking,
      process: {
        id: paid.world.processId,
        processNumber: 'MR-0000-0000',
        mainStatus,
        eventDate: null,
      },
      settlement: { id: paid.settlementId, lockedAt, paymentStatus, amountDueCents: 1234 },
      cancellation: null,
    });
    const options = { includeCancelledFree: true };
    for (const mainStatus of ['open', 'reopened', 'completed', 'cancelled'] as const) {
      expect(portalStateOf(row(mainStatus, now, 'paid'), now, options), mainStatus).toBeNull();
    }
    for (const paymentStatus of ['open', 'overdue', null] as const) {
      for (const mainStatus of ['open', 'reopened'] as const) {
        expect(
          portalStateOf(row(mainStatus, now, paymentStatus), now, options),
          `${mainStatus}/${String(paymentStatus)}`,
        ).toBe('active');
      }
      expect(portalStateOf(row('completed', now, paymentStatus), now, options)).toBe(
        'completed_open',
      );
    }
    // Nicht übertragen (locked_at NULL) ist nie „final bezahlt“ – auch nicht mit paid.
    expect(portalStateOf(row('reopened', null, 'paid'), now, options)).toBe('active');
    expect(portalStateOf(row('completed', null, 'paid'), now, options)).toBe('completed_open');
  });
});

// ── R15-4 – R15-5: nicht final bezahlt ⇒ wiedereröffnet sichtbar ──────────

describe('R15-4. – R15-5. Wiedereröffnet ohne finale Zahlung bleibt sichtbar', () => {
  it('R15-4. reopened + Settlement open ⇒ weiterhin sichtbar (active); Zahlungsstatus NULL sperrt nicht', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const open = await paidSettledWorld(ctx, admin.id, cookie, { paymentStatus: 'open' });
    const session = await portalSessionFor(ctx, open.world.customerId);
    expect((await listFor(session.cookie)).map((b) => b.portalState)).toEqual(['completed_open']);
    await reopenViaRoute(cookie, open.world.processId);
    const settlement = (await settlementRowFor(ctx, open.world.processId))!;
    expect(settlement.lockedAt).not.toBeNull();
    expect(settlement.paymentStatus).not.toBe('paid');

    expect(await listFor(session.cookie)).toEqual([
      expect.objectContaining({ bookingId: open.world.bookingId, portalState: 'active' }),
    ]);
    const detail = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${open.world.bookingId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      portalState: 'active',
      invoice: {
        status: 'open',
        label: PORTAL_INVOICE_LABELS.open,
        finalAmountCents: settlement.amountDueCents,
      },
    });
    expect((await staffConversation(open.world.processId, cookie)).json().canReplyPortal).toBe(
      true,
    );

    // SQL-NULL-Semantik: übertragen, Zahlungsstatus NULL ⇒ nicht final bezahlt.
    await ctx.db
      .update(settlements)
      .set({ paymentStatus: null })
      .where(eq(settlements.id, open.settlementId));
    expect((await listFor(session.cookie)).map((b) => b.portalState)).toEqual(['active']);
    expect((await staffConversation(open.world.processId, cookie)).json().canReplyPortal).toBe(
      true,
    );
    const sent = await staffReply(open.world.processId, cookie, {
      channel: 'portal',
      body: 'Rückfrage zur Rechnung',
    });
    expect(sent.statusCode).toBe(201);
    expect(await replyNotices(open.world.processId)).toHaveLength(1);
  });

  it('R15-4b. reopened + Settlement noch nicht übertragen (locked_at NULL) ⇒ sichtbar', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world } = await settledReturn(ctx, admin.id, cookie);
    const session = await portalSessionFor(ctx, world.customerId);
    await processServiceFor(ctx).complete(world.processId, adminVisibilityCtx());
    expect((await listFor(session.cookie)).map((b) => b.portalState)).toEqual(['completed_open']);
    await reopenViaRoute(cookie, world.processId);
    const settlement = (await settlementRowFor(ctx, world.processId))!;
    expect(settlement.lockedAt).toBeNull();

    expect(await listFor(session.cookie)).toEqual([
      expect.objectContaining({ bookingId: world.bookingId, portalState: 'active' }),
    ]);
    const detail = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${world.bookingId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      portalState: 'active',
      invoice: { status: 'preparing', finalAmountCents: null },
    });
    expect((await staffConversation(world.processId, cookie)).json().canReplyPortal).toBe(true);

    // locked_at NULL sperrt nie – auch nicht bei (technisch) gesetztem Zahlungsstatus paid.
    await ctx.db
      .update(settlements)
      .set({ paymentStatus: 'paid' })
      .where(eq(settlements.id, settlement.id));
    expect((await listFor(session.cookie)).map((b) => b.portalState)).toEqual(['active']);
    expect((await staffConversation(world.processId, cookie)).json().canReplyPortal).toBe(true);
  });

  it('R15-5. reopened + Settlement overdue ⇒ sichtbar (active, Rechnung „Überfällig“)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const overdue = await paidSettledWorld(ctx, admin.id, cookie, { paymentStatus: 'overdue' });
    const session = await portalSessionFor(ctx, overdue.world.customerId);
    await reopenViaRoute(cookie, overdue.world.processId);
    const settlement = (await settlementRowFor(ctx, overdue.world.processId))!;
    expect(settlement.lockedAt).not.toBeNull();
    expect(settlement.paymentStatus).toBe('overdue');

    expect(await listFor(session.cookie)).toEqual([
      expect.objectContaining({ bookingId: overdue.world.bookingId, portalState: 'active' }),
    ]);
    const detail = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${overdue.world.bookingId}`,
    );
    expect(detail.status).toBe(200);
    expect((detail.body as PortalBookingView).invoice).toMatchObject({
      status: 'overdue',
      label: PORTAL_INVOICE_LABELS.overdue,
    });
    expect((await staffConversation(overdue.world.processId, cookie)).json().canReplyPortal).toBe(
      true,
    );
  });
});

// ── R15-6 – R15-7: Storno + Reopen (bestehende Policy) ────────────────────

describe('R15-6. – R15-7. Storno + Reopen bleibt bei der Cancellation-Policy', () => {
  it('R15-6. Storno + Reopen ⇒ Cancellation-Policy unverändert (kostenpflichtig cancelled_fee, 0-€-Staff-Storno unsichtbar)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    // Kostenpflichtig (50 %): bleibt cancelled_fee, nie active.
    const fee = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    const feeSession = await portalSessionFor(ctx, fee.customerId);
    const feeView = await cancelBooking(ctx, admin.id, fee.processId);
    expect(feeView.feeCents).toBeGreaterThan(0);
    await reopenViaRoute(cookie, fee.processId);
    expect(await listFor(feeSession.cookie)).toEqual([
      expect.objectContaining({ bookingId: fee.bookingId, portalState: 'cancelled_fee' }),
    ]);
    const detail = await portalGet(
      portal.app,
      feeSession.cookie,
      `/portal/bookings/${fee.bookingId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      portalState: 'cancelled_fee',
      canMessage: false,
      canCancelOnline: false,
    });

    // 0 € (Staff-Storno): unsichtbar, auch nach Reopen.
    const free = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const freeSession = await portalSessionFor(ctx, free.customerId);
    const freeView = await cancelBooking(ctx, admin.id, free.processId);
    expect(freeView.feeCents).toBe(0);
    await reopenViaRoute(cookie, free.processId);
    expect(await listFor(freeSession.cookie)).toEqual([]);
    expect(await detailStatus(freeSession.cookie, free.bookingId)).toBe(404);
  });

  it('R15-7. Storno + Reopen ⇒ Staff-Portalantwort weiterhin blockiert (canReplyPortal false, 409, keine Hinweis-Mail)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 10 }); // 50 %
    await portalSessionFor(ctx, booked.customerId);
    const cancelled = await cancelBooking(ctx, admin.id, booked.processId);
    expect(cancelled.feeCents).toBeGreaterThan(0);
    await reopenViaRoute(cookie, booked.processId);
    ctx.mailGateway.reset();

    expect((await staffConversation(booked.processId, cookie)).json().canReplyPortal).toBe(false);
    const blocked = await staffReply(booked.processId, cookie, {
      channel: 'portal',
      body: 'Antwort im Portal',
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      error: { code: 'CONFLICT', message: PORTAL_REPLY_BLOCKED },
    });
    expect(await portalRows(booked.processId)).toHaveLength(0);
    expect(await replyNotices(booked.processId)).toHaveLength(0);
    await drainAllJobs(ctx);
    expect(ctx.mailGateway.sent.map((mail) => mail.subject)).not.toContainEqual(
      expect.stringMatching(/^Neue Nachricht von Miet-Royal/),
    );
  });
});

// ── R15-8: Portalnachricht ist keine Settlement-Kundenantwort ─────────────

describe('R15-8. Portalnachricht und Abrechnung', () => {
  it('R15-8. Portalnachricht verändert keine Settlement-Kundenantwort automatisch', async () => {
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
    const current = await settlementViewFor(ctx.app, cookie, world.processId);
    const sent = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/notice/approve-and-send`,
      { version: current.settlement.version },
    );
    expect(sent.status).toBe(200);
    await drainAllJobs(ctx); // bestätigter Mailversand ⇒ notice_sent_at

    const before = (await settlementRowFor(ctx, world.processId))!;
    expect(before.noticeSentAt).not.toBeNull();
    expect(before.customerResponseReceivedAt).toBeNull();
    expect(before.lockedAt).toBeNull();
    expect(await mainStatusOf(world.processId)).toBe('open');

    const session = await portalSessionFor(ctx, world.customerId);
    expect((await listFor(session.cookie)).map((b) => b.portalState)).toEqual(['active']);
    const message = await portalPost(
      portal.app,
      session.cookie,
      `/portal/bookings/${world.bookingId}/messages`,
      { body: 'Den Riss gab es schon bei der Abholung.' },
    );
    expect(message.status).toBe(201);
    await drainAllJobs(ctx);

    const after = (await settlementRowFor(ctx, world.processId))!;
    expect(after.customerResponseReceivedAt).toBeNull();
    expect(after.manualTransferRequired).toBe(before.manualTransferRequired);
    expect(after.status).toBe(before.status);
    expect(after.version).toBe(before.version);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    const responses = await ctx.db
      .select()
      .from(settlementClarifications)
      .where(
        and(
          eq(settlementClarifications.settlementId, before.id),
          eq(settlementClarifications.type, 'customer_response'),
        ),
      );
    expect(responses).toHaveLength(0);
  });
});

// ── R15-9 – R15-10: keine Rückkehr der alten bezahlten Buchung ────────────

describe('R15-9. – R15-10. Alte bezahlte Buchung nach Reopen weder in Liste noch in Detail-/Unterrouten', () => {
  it('R15-9. alte bezahlte, wiedereröffnete Buchung: GET /portal/bookings leer, Detail und Unterrouten 404, POST messages 404', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidAndCompleted(admin.id, cookie);
    const session = await portalSessionFor(ctx, paid.world.customerId);
    await reopenViaRoute(cookie, paid.world.processId);
    const base = `/portal/bookings/${paid.world.bookingId}`;

    expect(await listFor(session.cookie)).toEqual([]);
    for (const suffix of [
      '',
      '/documents',
      '/messages',
      '/travel-status',
      '/cancellation/preview',
    ]) {
      const response = await portalGet(portal.app, session.cookie, `${base}${suffix}`);
      expect(response.status, suffix).toBe(404);
      expect(response.body, suffix).toMatchObject({
        error: { code: 'NOT_FOUND', message: 'Nicht gefunden.' },
      });
    }
    const message = await portalPost(portal.app, session.cookie, `${base}/messages`, {
      body: 'Ist meine Buchung wieder aktiv?',
    });
    expect(message.status).toBe(404);
    expect(message.body).toMatchObject({
      error: { code: 'NOT_FOUND', message: 'Nicht gefunden.' },
    });
    expect(await portalRows(paid.world.processId)).toHaveLength(0);
    const cancel = await portalPost(portal.app, session.cookie, `${base}/cancellation`, {
      confirm: true,
      expectedFeeCents: 0,
    });
    expect(cancel.status).toBe(404);
  });

  it('R15-10. mehrere Buchungen desselben Kunden: alte paid+reopened unsichtbar, aktuelle offene sichtbar', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidAndCompleted(admin.id, cookie);
    const current = await acceptedBookingForCustomer(ctx, admin.id, paid.world.customerId, {
      eventInDays: 20,
    });
    await reopenViaRoute(cookie, paid.world.processId);
    const session = await portalSessionFor(ctx, paid.world.customerId);

    const list = await listFor(session.cookie);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ bookingId: current.bookingId, portalState: 'active' });
    expect(await detailStatus(session.cookie, paid.world.bookingId)).toBe(404);
    expect(await detailStatus(session.cookie, current.bookingId)).toBe(200);
  });
});
