import { randomUUID } from 'node:crypto';
import {
  accountingTransfers,
  appointments,
  conversationMessages,
  handovers,
  integrationJobs,
  mailDeliveries,
  settlements,
  whatsappContacts,
} from '@mietroyal/database';
import { berlinDateOf } from '@mietroyal/domain';
import type { PermissionKey } from '@mietroyal/permissions';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TRAINING_ERROR_CODES, TRAINING_MESSAGES } from '../src/training/errors.ts';
import { destroyTestContext, type TestContext } from './auth-helpers.ts';
import { commerceServices, createCommerceWorld } from './commerce-helpers.ts';
import { createCustomerWithProcess, drainJobs } from './communication-helpers.ts';
import {
  handoverServicesFor,
  initializeAllInventory,
  pngBytes,
  readyHandover,
  scheduledBooking,
} from './handover-helpers.ts';
import { readyReturn, startedReturn } from './return-helpers.ts';
import { createAcceptedBooking, schedulingServiceFor } from './scheduling-helpers.ts';
import { openClarifications, settledReturn } from './settlement-helpers.ts';
import {
  adminSession,
  apiFor,
  attemptRow,
  checkAttempt,
  createTrainingDemoContext,
  eventsOf,
  resetTrainingWorld,
  startAttempt,
  startedAttemptId,
  syncCatalog,
  trainee,
  trainingMe,
} from './training-helpers.ts';
import { machineByCode } from './warehouse-helpers.ts';

/**
 * Phase 14 (Training, Order §106 – Pflichttests 90–98, Design §4.7): die
 * initialen Übungen laufen über die ECHTEN Fachpfade (Routen + bestehende
 * Welt-Helfer); der Trainee ist ein Mitarbeiter mit exakt den nötigen Rechten
 * und führt die entscheidende Aktion selbst über die Route aus. Demo-Kontext
 * mit Mail-Whitelist `@example.com` (Fake-Gateway), WhatsApp-Fake (wie Mock:
 * accepted), Routing-Mock, keine Buchhaltungsübertragung.
 */

const PLANNER: readonly PermissionKey[] = [
  'calendar.view',
  'calendar.view_all',
  'calendar.manage',
  'appointment.assign',
];
const WA_ID = '4917612345678';
const DAMAGE = { description: 'Kratzer am Gehäuse', severity: 'medium' as const };

let demo: TestContext;

beforeAll(async () => {
  demo = await createTrainingDemoContext();
});
afterAll(async () => {
  await syncCatalog(demo);
  await destroyTestContext(demo);
});
beforeEach(async () => {
  await resetTrainingWorld(demo.pool);
  demo.mailGateway.reset();
  demo.whatsapp.reset();
});

/** Zeitpunkt heute (Berlin) für Terminstopps – kurz nach jetzt, am Tagesende sofort. */
function todayAppointmentStart(): Date {
  const candidate = new Date(Date.now() + 30 * 60_000);
  return berlinDateOf(candidate) === berlinDateOf(new Date())
    ? candidate
    : new Date(Date.now() + 60_000);
}

describe('T90 offer_send', () => {
  it('T90. offer_send: Entwurf über die Route bearbeiten und versenden ⇒ bestanden (Ereignisse edit/send mit dem Angebot als Fachobjekt)', async () => {
    const { admin } = await adminSession(demo);
    const user = await trainee(
      demo,
      admin.id,
      ['offer.edit_draft', 'offer.send', 'offer.view', 'process.view_all'],
      'Verkauf',
    );
    const api = apiFor(demo.app, user.cookie);
    const world = await createCommerceWorld(demo, admin.id);
    const { offerId, versionId } = await commerceServices(demo).offers.createOffer(
      admin.id,
      world.processId,
    );
    const attemptId = await startedAttemptId(api, 'offer_send');
    const patched = await api('PATCH', `/staff/offer-versions/${versionId}`, {
      machineQuantity: 2,
    });
    expect(patched.status).toBe(200);
    expect((await attemptRow(demo, attemptId)).status).toBe('in_progress');
    const sent = await api('POST', `/staff/offer-versions/${versionId}/send`, {});
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const attempt = await attemptRow(demo, attemptId);
    expect(attempt.status).toBe('passed');
    expect(
      (await eventsOf(demo, attemptId)).map((e) => [e.eventKey, e.stepKey, e.result, e.subjectRef]),
    ).toEqual([
      ['offer.draft_updated', 'edit', 'accepted', offerId],
      ['offer.sent', 'send', 'accepted', offerId],
    ]);
    const me = await trainingMe(api);
    expect(me.body.definitions.find((d: { key: string }) => d.key === 'offer_send').state).toBe(
      'passed',
    );
  });

  it('T90. offer_send: nur senden ohne eigene Bearbeitung ⇒ nicht bestanden (send abgelehnt, offener Schritt „edit“)', async () => {
    const { admin } = await adminSession(demo);
    const user = await trainee(
      demo,
      admin.id,
      ['offer.edit_draft', 'offer.send', 'offer.view', 'process.view_all'],
      'Verkauf',
    );
    const api = apiFor(demo.app, user.cookie);
    const world = await createCommerceWorld(demo, admin.id);
    const { offers } = commerceServices(demo);
    const { versionId } = await offers.createOffer(admin.id, world.processId);
    await offers.updateDraft(admin.id, versionId, { machineQuantity: 2 }); // Bearbeitung durch jemand anderen, vor dem Versuch
    const attemptId = await startedAttemptId(api, 'offer_send');
    const sent = await api('POST', `/staff/offer-versions/${versionId}/send`, {});
    expect(sent.status).toBe(200);
    expect((await attemptRow(demo, attemptId)).status).toBe('in_progress');
    expect(
      (await eventsOf(demo, attemptId)).map((e) => [e.stepKey, e.result, e.errorCode]),
    ).toEqual([['send', 'rejected', 'PREREQUISITE_MISSING']]);
    const check = await checkAttempt(api, attemptId);
    expect(check.body).toMatchObject({ passed: false, openStep: { key: 'edit' } });
  });
});

describe('T91/T92 Übergabe und Rückgabe', () => {
  it('T91. handover_complete: vorbereitete Übergabe über die Route abschließen ⇒ bestanden; Wiederholung ist idempotent (kein zweites Ereignis)', async () => {
    const { admin } = await adminSession(demo);
    const user = await trainee(
      demo,
      admin.id,
      ['handover.view', 'handover.perform', 'process.view_all'],
      'Ausgabe',
    );
    const api = apiFor(demo.app, user.cookie);
    await initializeAllInventory(demo, admin.id, 20);
    const booking = await scheduledBooking(demo, admin.id);
    await readyHandover(demo, admin.id, booking.bookingId, ['MR-10-01-01']);
    const attemptId = await startedAttemptId(api, 'handover_complete');
    const finalized = await api('POST', `/staff/handover/${booking.bookingId}/finalize`, {});
    expect(finalized.status, JSON.stringify(finalized.body)).toBe(200);
    expect(finalized.body.detail.finalized).toBe(true);
    expect(finalized.body.detail.handover.status).toBe('finalized');
    expect((await attemptRow(demo, attemptId)).status).toBe('passed');
    expect(
      (await eventsOf(demo, attemptId)).map((e) => [e.eventKey, e.result, e.subjectRef]),
    ).toEqual([['handover.finalized', 'accepted', booking.bookingId]]);
    const again = await api('POST', `/staff/handover/${booking.bookingId}/finalize`, {});
    expect(again.status).toBe(200);
    expect(again.body.detail.finalized).toBe(false);
    expect(await eventsOf(demo, attemptId)).toHaveLength(1);
  });

  it('T92. return_complete: vollständig vorbereitete Rückgabe über die Route finalisieren ⇒ bestanden', async () => {
    const { admin } = await adminSession(demo);
    const user = await trainee(
      demo,
      admin.id,
      ['return.view', 'return.complete', 'process.view_all'],
      'Ruecknahme',
    );
    const api = apiFor(demo.app, user.cookie);
    const { world, services } = await startedReturn(demo, admin.id);
    await readyReturn(demo, admin.id, services, world.bookingId);
    const attemptId = await startedAttemptId(api, 'return_complete');
    const finalized = await api('POST', `/staff/returns/${world.bookingId}/finalize`, {});
    expect(finalized.status, JSON.stringify(finalized.body)).toBe(200);
    expect(finalized.body.detail.finalized).toBe(true);
    expect(finalized.body.detail.return.status).toBe('finalized');
    expect((await attemptRow(demo, attemptId)).status).toBe('passed');
    expect(
      (await eventsOf(demo, attemptId)).map((e) => [e.eventKey, e.result, e.subjectRef]),
    ).toEqual([['return.finalized', 'accepted', world.bookingId]]);
    expect((await machineByCode(demo.db, 'MR-10-01-01')).status).toBe('cleaning');
  });
});

describe('T93 tour_complete', () => {
  async function deliveryToday(adminId: string, driverId: string) {
    const booking = await createAcceptedBooking(demo, adminId, {
      fulfillment: 'delivery',
      assignProcessTo: driverId,
    });
    const scheduling = schedulingServiceFor(demo);
    await scheduling.ensureAppointmentsForBooking(booking.bookingId);
    const rows = await demo.db
      .select()
      .from(appointments)
      .where(eq(appointments.bookingId, booking.bookingId));
    const outbound = rows.find((row) => row.kind === 'delivery')!;
    await scheduling.reschedule(adminId, outbound.id, {
      startAt: todayAppointmentStart(),
      endAt: null,
      expectedVersion: outbound.version,
    });
    return { booking, outboundId: outbound.id, scheduling };
  }

  it('T93. tour_complete: Tour anlegen, bereit markieren, starten, Stopp erledigen, beenden ⇒ bestanden', async () => {
    const { admin } = await adminSession(demo);
    const driver = await trainee(demo, admin.id, PLANNER, 'Fahrer');
    const api = apiFor(demo.app, driver.cookie);
    const { outboundId, scheduling } = await deliveryToday(admin.id, driver.user.id);
    const attemptId = await startedAttemptId(api, 'tour_complete');
    const created = await api('POST', '/staff/tours', {
      tourDate: berlinDateOf(new Date()),
      assignedUserId: driver.user.id,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const tourId = created.body.tour.id as string;
    const stop = await api('POST', `/staff/tours/${tourId}/stops`, { appointmentId: outboundId });
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    const ready = await api('POST', `/staff/tours/${tourId}/ready`, {});
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    expect(ready.body.tour.status).toBe('ready');
    const started = await api('POST', `/staff/tours/${tourId}/start`, {});
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.started).toBe(true);
    // Zweiter Start ist idempotent (started: false) und erzeugt kein weiteres Ereignis.
    expect((await api('POST', `/staff/tours/${tourId}/start`, {})).body.started).toBe(false);
    await demo.db.transaction((tx) => scheduling.completeWithin(tx, admin.id, outboundId));
    const ended = await api('POST', `/staff/tours/${tourId}/end`, {});
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(ended.body.ended).toBe(true);
    expect((await attemptRow(demo, attemptId)).status).toBe('passed');
    expect(
      (await eventsOf(demo, attemptId)).map((e) => [e.eventKey, e.stepKey, e.result, e.subjectRef]),
    ).toEqual([
      ['tour.ready', 'plan', 'accepted', tourId],
      ['tour.started', 'start', 'accepted', tourId],
      ['tour.completed', 'end', 'accepted', tourId],
    ]);
  });

  it('T93. tour_complete: nur starten (ohne Planung/Bereit) ⇒ offen – Start abgelehnt, offener Schritt „plan“', async () => {
    const { admin } = await adminSession(demo);
    const driver = await trainee(demo, admin.id, PLANNER, 'Fahrer');
    const api = apiFor(demo.app, driver.cookie);
    const { outboundId } = await deliveryToday(admin.id, driver.user.id);
    const attemptId = await startedAttemptId(api, 'tour_complete');
    const created = await api('POST', '/staff/tours', {
      tourDate: berlinDateOf(new Date()),
      assignedUserId: driver.user.id,
    });
    const tourId = created.body.tour.id as string;
    expect(
      (await api('POST', `/staff/tours/${tourId}/stops`, { appointmentId: outboundId })).status,
    ).toBe(200);
    const started = await api('POST', `/staff/tours/${tourId}/start`, {});
    expect(started.status).toBe(200);
    expect(started.body.started).toBe(true);
    expect((await attemptRow(demo, attemptId)).status).toBe('in_progress');
    expect(
      (await eventsOf(demo, attemptId)).map((e) => [e.stepKey, e.result, e.errorCode]),
    ).toEqual([['start', 'rejected', 'PREREQUISITE_MISSING']]);
    const check = await checkAttempt(api, attemptId);
    expect(check.body).toMatchObject({
      passed: false,
      openStep: { key: 'plan' },
      attempt: { failedCheckCount: 1 },
    });
  });
});

describe('T94 communication_reply', () => {
  it('T94. communication_reply (WhatsApp-Mock): Antwort über die Route ⇒ queued ist nicht bestanden; nach dem Versandjob (sent) bestanden', async () => {
    const { admin } = await adminSession(demo);
    const user = await trainee(
      demo,
      admin.id,
      ['process.view_all', 'message.reply_customer', 'whatsapp.reply'],
      'Service',
    );
    const api = apiFor(demo.app, user.cookie);
    const { customer, process } = await createCustomerWithProcess(demo, admin.id, {
      email: 'kunde@example.com',
    });
    // In demo gibt es keinen Webhook – eine Kundennachricht existiert nur als Fixture (wie E2E).
    await demo.db.insert(conversationMessages).values({
      processId: process.id,
      customerId: customer.id,
      channel: 'whatsapp',
      direction: 'inbound',
      senderSnapshot: { name: 'Demo Kunde', phone: WA_ID },
      body: 'Hallo (Demo-Fixture)',
      providerMessageId: `wamid.fixture.${randomUUID()}`,
      deliveryState: 'received',
      receivedAt: new Date(),
    });
    await demo.db
      .insert(whatsappContacts)
      .values({
        waId: WA_ID,
        customerId: customer.id,
        lastInboundAt: new Date(),
        profileName: 'Demo Kunde',
      })
      .onConflictDoUpdate({ target: whatsappContacts.waId, set: { lastInboundAt: new Date() } });
    const attemptId = await startedAttemptId(api, 'communication_reply');
    const reply = await api('POST', `/staff/processes/${process.id}/conversation/reply`, {
      channel: 'whatsapp',
      body: 'Antwort aus der Demo (simuliert).',
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect(reply.body.deliveryState).toBe('queued');
    expect((await attemptRow(demo, attemptId)).status).toBe('in_progress');
    expect(await eventsOf(demo, attemptId)).toEqual([]);
    await drainJobs(demo);
    const [message] = await demo.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, reply.body.messageId));
    expect(message!.deliveryState).toBe('sent');
    expect((await attemptRow(demo, attemptId)).status).toBe('passed');
    expect(
      (await eventsOf(demo, attemptId)).map((e) => [e.eventKey, e.result, e.subjectRef]),
    ).toEqual([['communication.reply_sent', 'accepted', reply.body.messageId]]);
    // Zweiter Jobdurchlauf (At-least-once) erzeugt kein weiteres Ereignis.
    await drainJobs(demo);
    expect(await eventsOf(demo, attemptId)).toHaveLength(1);
  });

  it('T94. communication_reply (E-Mail an Whitelist-Adresse): Antwort ⇒ Outbox-Job ⇒ sent ⇒ bestanden; [DEMO]-Betreff', async () => {
    const { admin } = await adminSession(demo);
    const user = await trainee(
      demo,
      admin.id,
      ['process.view_all', 'message.reply_customer'],
      'Mailer',
    );
    const api = apiFor(demo.app, user.cookie);
    const { process } = await createCustomerWithProcess(demo, admin.id, {
      email: 'kunde@example.com',
    });
    const attemptId = await startedAttemptId(api, 'communication_reply');
    const reply = await api('POST', `/staff/processes/${process.id}/conversation/reply`, {
      channel: 'email',
      body: 'Vielen Dank für Ihre Nachricht.',
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect(reply.body.deliveryState).toBe('queued');
    expect((await attemptRow(demo, attemptId)).status).toBe('in_progress');
    await drainJobs(demo);
    const [delivery] = await demo.db
      .select()
      .from(mailDeliveries)
      .where(eq(mailDeliveries.id, reply.body.mailDeliveryId));
    expect(delivery).toMatchObject({
      kind: 'manual_customer_reply',
      status: 'sent',
      createdBy: user.user.id,
    });
    expect(demo.mailGateway.sent.map((m) => m.to.email)).toEqual(['kunde@example.com']);
    expect(demo.mailGateway.sent[0]!.subject.startsWith('[DEMO]')).toBe(true);
    expect((await attemptRow(demo, attemptId)).status).toBe('passed');
    expect(
      (await eventsOf(demo, attemptId)).map((e) => [e.eventKey, e.result, e.subjectRef]),
    ).toEqual([['communication.reply_sent', 'accepted', reply.body.messageId]]);
  });

  it('T94. communication_reply: blockierte Mail (Adresse nicht auf der Demo-Whitelist) ⇒ kein Versand, nicht bestanden', async () => {
    const { admin } = await adminSession(demo);
    const user = await trainee(
      demo,
      admin.id,
      ['process.view_all', 'message.reply_customer'],
      'Mailer',
    );
    const api = apiFor(demo.app, user.cookie);
    const { process } = await createCustomerWithProcess(demo, admin.id, {
      email: 'kunde@example.invalid',
    });
    const attemptId = await startedAttemptId(api, 'communication_reply');
    const reply = await api('POST', `/staff/processes/${process.id}/conversation/reply`, {
      channel: 'email',
      body: 'Diese Mail darf die Demo nicht verlassen.',
    });
    expect(reply.status).toBe(201);
    expect(reply.body.deliveryState).toBe('blocked');
    await drainJobs(demo);
    expect(demo.mailGateway.attempts).toEqual([]);
    expect((await attemptRow(demo, attemptId)).status).toBe('in_progress');
    expect(await eventsOf(demo, attemptId)).toEqual([]);
    const check = await checkAttempt(api, attemptId);
    expect(check.body).toMatchObject({ passed: false, openStep: { key: 'reply' } });
  });
});

describe('T95/T96 settlement_review', () => {
  async function reviewedSettlement() {
    const { admin, cookie } = await adminSession(demo);
    const { world, view } = await settledReturn(demo, admin.id, cookie, { damages: [DAMAGE] });
    expect(view.settlement.status).toBe('clarification_required');
    const reviewer = await trainee(
      demo,
      admin.id,
      ['settlement.view', 'damage.set_cost', 'process.view_all'],
      'Pruefung',
    );
    const api = apiFor(demo.app, reviewer.cookie);
    const attemptId = await startedAttemptId(api, 'settlement_review');
    const clarification = openClarifications(view, 'damage_cost')[0]!;
    const resolved = await api(
      'POST',
      `/staff/settlements/${view.settlement.id}/clarifications/${clarification.id}/resolve`,
      { decision: 'no_charge', version: view.settlement.version },
    );
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    return { admin, world, view, api, attemptId, resolved };
  }

  it('T95. settlement_review: Klärung lösen bis „Bereit zur Buchhaltung“ ⇒ bestanden (Ereignis settlement.reviewed)', async () => {
    const { view, attemptId, resolved } = await reviewedSettlement();
    expect(resolved.body.settlement.status).toBe('ready_for_accounting');
    expect((await attemptRow(demo, attemptId)).status).toBe('passed');
    expect(
      (await eventsOf(demo, attemptId)).map((e) => [e.eventKey, e.result, e.subjectRef]),
    ).toEqual([['settlement.reviewed', 'accepted', view.settlement.id]]);
  });

  it('T96. Kein Lexware-Erfolg erforderlich: Abrechnung bleibt ready_for_accounting, keine Übertragung, kein Lexware-Client – Versuch bestanden', async () => {
    const { world, attemptId } = await reviewedSettlement();
    const [row] = await demo.db
      .select()
      .from(settlements)
      .where(eq(settlements.processId, world.processId));
    expect(row).toMatchObject({
      status: 'ready_for_accounting',
      accountingTransferId: null,
      transferredAt: null,
    });
    expect(await demo.db.select().from(accountingTransfers)).toEqual([]);
    const succeededTransfers = await demo.db
      .select()
      .from(integrationJobs)
      .where(
        and(
          eq(integrationJobs.type, 'settlement.accounting_transfer'),
          eq(integrationJobs.status, 'succeeded'),
        ),
      );
    expect(succeededTransfers).toEqual([]);
    expect(demo.lexware.client).toBeNull();
    expect((await attemptRow(demo, attemptId)).status).toBe('passed');
  });

  it('RF14-4. Keine Prüfung ohne Übergang (Review-Fix F4): eine manuelle Position auf einer bereits „bereiten“ Abrechnung (ohne Klärung) erzeugt kein settlement.reviewed – der Versuch bleibt in_progress; erst der Übergang nach ready_for_accounting zählt (T95)', async () => {
    const { admin, cookie } = await adminSession(demo);
    // Rückgabe ohne Schäden/Fehlteile ⇒ Abrechnung sofort „Bereit zur Buchhaltung“.
    const { view } = await settledReturn(demo, admin.id, cookie);
    expect(view.settlement.status).toBe('ready_for_accounting');
    const reviewer = await trainee(
      demo,
      admin.id,
      ['settlement.view', 'settlement.release', 'settlement.add_manual_charge', 'process.view_all'],
      'Pruefung',
    );
    const api = apiFor(demo.app, reviewer.cookie);
    const attemptId = await startedAttemptId(api, 'settlement_review');
    const line = await api('POST', `/staff/settlements/${view.settlement.id}/lines`, {
      type: 'manual_charge',
      description: 'Prüfvermerk',
      amountCents: 100,
      version: view.settlement.version,
    });
    expect(line.status, JSON.stringify(line.body)).toBe(200);
    expect(line.body.settlement.status).toBe('ready_for_accounting'); // war bereits bereit
    expect((await attemptRow(demo, attemptId)).status).toBe('in_progress');
    expect(await eventsOf(demo, attemptId)).toEqual([]);
    // „Übung prüfen“ bestätigt: offener Schritt, kein Bestehen.
    const check = await checkAttempt(api, attemptId);
    expect(check.status).toBe(200);
    expect((await attemptRow(demo, attemptId)).status).toBe('in_progress');
  });
});

describe('T97/T98 Fachrechte und Pflichtschritte', () => {
  it('T97. Fachrechte gelten: ohne offer.send ⇒ Start 403 TRAINING_PERMISSION_MISSING; Fachroute 403 FORBIDDEN unverändert', async () => {
    const { admin } = await adminSession(demo);
    const user = await trainee(demo, admin.id, ['offer.edit_draft', 'process.view_all'], 'Azubi');
    const api = apiFor(demo.app, user.cookie);
    const blocked = await startAttempt(api, 'offer_send');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatchObject({
      code: TRAINING_ERROR_CODES.PERMISSION_MISSING,
      message: TRAINING_MESSAGES.PERMISSION_MISSING,
      details: { definitionKey: 'offer_send' },
    });
    const me = await trainingMe(api);
    expect(
      me.body.definitions.find((d: { key: string }) => d.key === 'offer_send').permissionMissing,
    ).toBe(true);
    const world = await createCommerceWorld(demo, admin.id);
    const { versionId } = await commerceServices(demo).offers.createOffer(
      admin.id,
      world.processId,
    );
    const sent = await api('POST', `/staff/offer-versions/${versionId}/send`, {});
    expect(sent.status).toBe(403);
    expect(sent.body.error.code).toBe('FORBIDDEN');
    // Mit vorhandenem Recht wäre der Start möglich – Training erweitert keine Rechte (§55).
    const allowed = await trainee(
      demo,
      admin.id,
      ['offer.edit_draft', 'offer.send', 'process.view_all'],
      'Verkauf',
    );
    expect((await startAttempt(apiFor(demo.app, allowed.cookie), 'offer_send')).status).toBe(201);
  });

  it('T98. Keine Business-Pflichtschritte umgehbar: Finalisierung ohne Unterschriften scheitert fachlich (409) ⇒ kein Ereignis; erst der vollständige Weg besteht', async () => {
    const { admin } = await adminSession(demo);
    const user = await trainee(
      demo,
      admin.id,
      ['handover.view', 'handover.perform', 'process.view_all'],
      'Ausgabe',
    );
    const api = apiFor(demo.app, user.cookie);
    await initializeAllInventory(demo, admin.id, 20);
    const booking = await scheduledBooking(demo, admin.id);
    const services = handoverServicesFor(demo);
    const effective = await demo.auth.effectivePermissions(admin.id);
    await services.handover.ensureForBooking(booking.bookingId, admin.id);
    const slots = await services.assignments.slotsForBooking(booking.bookingId);
    const machine = await machineByCode(demo.db, 'MR-10-01-01');
    await services.assignments.assign(admin.id, effective, slots[0]!.id, machine.id, null);
    await services.assignments.prepare(admin.id, slots[0]!.id);
    await services.handover.setRecipient(booking.bookingId, { kind: 'customer' });
    await services.handover.checkMachine(admin.id, booking.bookingId, slots[0]!.id);
    await services.handover.addPhoto(admin.id, booking.bookingId, slots[0]!.id, {
      bytes: pngBytes(),
      mimeType: 'image/png',
    });
    const attemptId = await startedAttemptId(api, 'handover_complete');
    const blocked = await api('POST', `/staff/handover/${booking.bookingId}/finalize`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('Übergabe kann noch nicht abgeschlossen werden');
    expect(await eventsOf(demo, attemptId)).toEqual([]);
    expect((await attemptRow(demo, attemptId)).status).toBe('in_progress');
    const [handover] = await demo.db
      .select()
      .from(handovers)
      .where(eq(handovers.bookingId, booking.bookingId));
    expect(handover!.status).not.toBe('finalized');
    // Pflichtschritte nachholen ⇒ der normale Fachweg besteht die Übung.
    await services.handover.sign(admin.id, booking.bookingId, 'customer', pngBytes());
    await services.handover.sign(admin.id, booking.bookingId, 'staff', pngBytes());
    const finalized = await api('POST', `/staff/handover/${booking.bookingId}/finalize`, {});
    expect(finalized.status, JSON.stringify(finalized.body)).toBe(200);
    expect((await attemptRow(demo, attemptId)).status).toBe('passed');
  });
});
