/**
 * Phase 12 – REMINDER (Pflichttests 39–53, Order §§17–19/42): 7-Tage- und
 * 1-Tag-Erinnerung für Pickup/Delivery, DST (März/Oktober: gleiche
 * Wanduhrzeit), ungeplant, verspätete Buchung (kein Nachholen), Storno,
 * Reschedule (Fingerprint), Dedupe über mehrere Scans, Transporthinweise,
 * Abholadresse, Rückgabezeit, Terminänderungs-Mail (§19). Versand nur über
 * den FakeMailGateway.
 */
import {
  appointmentReminders,
  appointments,
  bookings,
  customerActionTokens,
  mailDeliveries,
  processes,
} from '@mietroyal/database';
import { addBerlinCalendarDays } from '@mietroyal/domain';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashActionToken } from '../src/communication/action-links/service.ts';
import {
  REMINDER_TOLERANCE_MS,
  reminderDueAt,
  reminderFingerprint,
  reminderIdempotencyKey,
} from '../src/communication/reminders/service.ts';
import {
  createEmployeeWithPassword,
  createTestContext,
  destroyTestContext,
  login,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { setPickupExactAddress, truncateCommerceTables } from './commerce-helpers.ts';
import { truncateCrmTables } from './crm-helpers.ts';
import { DAYS, HOURS } from './handover-helpers.ts';
import {
  createAcceptedBooking,
  schedulingServiceFor,
  truncateSchedulingTables,
} from './scheduling-helpers.ts';
import { adminSession } from './settlement-helpers.ts';

const MINUTES = 60_000;
const PUBLIC_BASE = 'https://web.test.example';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      MAIL_ENABLED: 'true',
      MAIL_SMTP_HOST: 'smtp.test.example',
      MAIL_SMTP_USER: 'mailer@miet-royal.test',
      MAIL_SMTP_PASSWORD: 'smtp-password-never-logged',
      MAIL_FROM_NAME: 'Miet-Royal Mainz',
      MAIL_FROM_ADDRESS: 'noreply@miet-royal.test',
      MAIL_PUBLIC_WEB_BASE_URL: PUBLIC_BASE,
    },
  });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await ctx.pool.query(
    'TRUNCATE appointment_reminders, customer_action_tokens, booking_customer_contacts, mail_deliveries, integration_jobs CASCADE',
  );
  await truncateSchedulingTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  // Zuletzt: stellt die Seed-Preise wieder her (Auth-Reset leert product_prices per CASCADE).
  await truncateCommerceTables(ctx.pool);
  ctx.mailGateway.reset();
});

async function drain(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if ((await ctx.jobs.runOnce()) === 'idle') break;
  }
}

/** Buchung mit (optional) geplantem Übergabe-/Rückgabetermin; Buchungsdatum frei setzbar. */
async function world(
  adminId: string,
  options: {
    fulfillment?: 'pickup' | 'delivery';
    outbound?: { startAt: Date; endAt?: Date | null } | null;
    inbound?: Date | null;
    bookingCreatedAt?: Date;
  } = {},
) {
  const fulfillment = options.fulfillment ?? 'pickup';
  const booking = await createAcceptedBooking(ctx, adminId, { fulfillment });
  const scheduling = schedulingServiceFor(ctx);
  await scheduling.ensureAppointmentsForBooking(booking.bookingId);
  const rows = await ctx.db
    .select()
    .from(appointments)
    .where(eq(appointments.bookingId, booking.bookingId));
  const outbound = rows.find((row) => row.kind === 'pickup' || row.kind === 'delivery')!;
  const inbound = rows.find((row) => row.kind === 'return')!;
  if (options.outbound !== undefined && options.outbound !== null) {
    await scheduling.reschedule(adminId, outbound.id, {
      startAt: options.outbound.startAt,
      endAt: options.outbound.endAt ?? null,
      expectedVersion: outbound.version,
    });
  }
  if (options.inbound !== undefined && options.inbound !== null) {
    await scheduling.reschedule(adminId, inbound.id, {
      startAt: options.inbound,
      endAt: null,
      expectedVersion: inbound.version,
    });
  }
  // Buchungsdatum ist in echten Daten älter als der 7-Tage-Zeitpunkt – im Test gezielt setzen.
  await ctx.db
    .update(bookings)
    .set({ createdAt: options.bookingCreatedAt ?? new Date(Date.now() - 60 * DAYS) })
    .where(eq(bookings.id, booking.bookingId));
  const processRow = (
    await ctx.db.select().from(processes).where(eq(processes.id, booking.processId))
  )[0]!;
  // Angebotsmail der Buchungserzeugung abarbeiten und aus dem Fake entfernen – Tests zählen nur Erinnerungen.
  await drain();
  ctx.mailGateway.reset();
  return { ...booking, outboundId: outbound.id, inboundId: inbound.id, scheduling, processRow };
}

/** Nur Erinnerungs-/Terminänderungs-Zustellungen (die Angebotsmail der Buchungserzeugung bleibt außen vor). */
const OWN_KINDS = new Set(['reminder_7_days', 'reminder_1_day', 'appointment_changed']);
async function deliveriesOf(kind?: string) {
  const rows = (await ctx.db.select().from(mailDeliveries)).filter((row) =>
    OWN_KINDS.has(row.kind),
  );
  return kind === undefined ? rows : rows.filter((row) => row.kind === kind);
}

async function remindersOf(appointmentId: string) {
  return ctx.db
    .select()
    .from(appointmentReminders)
    .where(eq(appointmentReminders.appointmentId, appointmentId));
}

/** Terminbeginn in 8 Tagen zu einer festen Wanduhrzeit (ausreichend Abstand zur 6-h-Toleranz). */
function futureStart(days = 8): Date {
  const start = new Date(Date.now() + days * DAYS);
  start.setUTCMinutes(0, 0, 0);
  return start;
}

describe('39.–42. 7-Tage-/1-Tag-Mail für Pickup und Delivery', () => {
  it('39. 7-Tage-Mail Pickup: fällig ab startAt − 7 Kalendertage, genau eine Zustellung an die Buchungs-E-Mail', async () => {
    const { admin } = await adminSession(ctx);
    const startAt = futureStart();
    const w = await world(admin.id, { outbound: { startAt } });
    const dueAt = reminderDueAt('reminder_7_days', startAt);
    expect(dueAt.toISOString()).toBe(addBerlinCalendarDays(startAt, -7).toISOString());

    // Eine Minute VOR Fälligkeit: nichts.
    await ctx.scan.reminders.scanDue(new Date(dueAt.getTime() - MINUTES));
    expect(await deliveriesOf()).toHaveLength(0);

    // Ab Fälligkeit: Zustellung mit stabilem Schlüssel.
    const summary = await ctx.scan.reminders.scanDue(new Date(dueAt.getTime() + MINUTES));
    expect(summary.enqueued).toBe(1);
    const rows = await deliveriesOf('reminder_7_days');
    expect(rows).toHaveLength(1);
    const fingerprint = reminderFingerprint(w.outboundId, 'reminder_7_days', startAt);
    expect(rows[0]!.idempotencyKey).toBe(reminderIdempotencyKey('reminder_7_days', fingerprint));
    expect(rows[0]!.recipientEmail).toBe('klara.kommerz@test.example');
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.secretPayloadCiphertext).toBeNull(); // 7-Tage-Mail ohne Aktionslink
    expect(rows[0]!.context).toMatchObject({
      processNumber: w.processRow.processNumber,
      appointmentKind: 'pickup',
      appointmentAt: startAt.toISOString(),
    });

    await drain();
    expect(ctx.mailGateway.sent).toHaveLength(1);
    const mail = ctx.mailGateway.sent[0]!;
    expect(mail.subject).toContain('Erinnerung');
    expect(mail.subject).toContain(w.processRow.processNumber);
    expect(mail.text).toContain('In einer Woche');
    expect(mail.text).toContain('Abholung');
    expect(mail.text).toContain(w.processRow.processNumber);
    expect(mail.text).not.toContain('/kontakt/');
    // Reminder-Zeile: an Fingerprint gebunden, nach Versand sentAt gesetzt.
    const reminders = await remindersOf(w.outboundId);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.fingerprint).toBe(fingerprint);
    expect(reminders[0]!.mailDeliveryId).toBe(rows[0]!.id);
    expect(reminders[0]!.sentAt).not.toBeNull();
  });

  it('40. 7-Tage-Mail Delivery: Terminart Lieferung, Lieferfenster und Lieferadresse aus dem Buchungs-Snapshot', async () => {
    const { admin } = await adminSession(ctx);
    const startAt = futureStart();
    const endAt = new Date(startAt.getTime() + 2 * HOURS);
    const w = await world(admin.id, { fulfillment: 'delivery', outbound: { startAt, endAt } });
    const dueAt = reminderDueAt('reminder_7_days', startAt);
    await ctx.scan.reminders.scanDue(new Date(dueAt.getTime() + MINUTES));
    const rows = await deliveriesOf('reminder_7_days');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.context).toMatchObject({
      appointmentKind: 'delivery',
      windowEnd: endAt.toISOString(),
      address: 'Lieferweg 12\n55129 Mainz',
    });
    await drain();
    const mail = ctx.mailGateway.sent[0]!;
    expect(mail.text).toContain('Lieferung');
    expect(mail.text).toContain('Lieferadresse');
    expect(mail.text).toContain('Lieferweg 12');
    expect(mail.text).toContain(' bis ');
    expect(mail.text).not.toContain('Kofferraum');
    expect(w.outboundId).toBeTruthy();
  });

  it('41. 1-Tag-Mail Pickup: Aktionslink „Abholperson ändern“ (Token nur als Hash, Ablauf exakt 1 h vor Termin)', async () => {
    const { admin } = await adminSession(ctx);
    await setPickupExactAddress(ctx, admin.id);
    const startAt = futureStart();
    const w = await world(admin.id, { outbound: { startAt } });
    const dueAt = reminderDueAt('reminder_1_day', startAt);
    expect(dueAt.toISOString()).toBe(addBerlinCalendarDays(startAt, -1).toISOString());
    await ctx.scan.reminders.scanDue(new Date(dueAt.getTime() + MINUTES));
    // Nur die 1-Tag-Mail: die 7-Tage-Fälligkeit liegt > 6 h zurück ⇒ übersprungen, nicht nachgeholt.
    const rows = await deliveriesOf();
    expect(rows.map((row) => row.kind)).toEqual(['reminder_1_day']);
    expect(rows[0]!.secretPayloadCiphertext).not.toBeNull();
    const reminders = await remindersOf(w.outboundId);
    expect(reminders.map((r) => [r.kind, r.mailDeliveryId === null]).sort()).toEqual([
      ['reminder_1_day', false],
      ['reminder_7_days', true],
    ]);

    await drain();
    const mail = ctx.mailGateway.sent[0]!;
    expect(mail.subject).toContain('Erinnerung für morgen');
    const match = /https:\/\/web\.test\.example\/kontakt\/([A-Za-z0-9_-]+)/.exec(mail.text);
    expect(match).not.toBeNull();
    const token = match![1]!;
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(mail.text).toContain('Abholperson ändern');
    const tokens = await ctx.db.select().from(customerActionTokens);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.tokenHash).toBe(hashActionToken(token));
    expect(tokens[0]!.purpose).toBe('pickup_contact_update');
    expect(tokens[0]!.appointmentId).toBe(w.outboundId);
    expect(tokens[0]!.bookingId).toBe(w.bookingId);
    expect(tokens[0]!.expiresAt.toISOString()).toBe(
      new Date(startAt.getTime() - 1 * HOURS).toISOString(),
    );
    // Der Klartext-Token steht in keiner Tabelle (nur Hash + verschlüsselte Payload, die nach Versand weg ist).
    const hits = await ctx.pool.query(
      `SELECT 1 FROM customer_action_tokens WHERE token_hash = $1 OR token_hash LIKE $2`,
      [token, `%${token}%`],
    );
    expect(hits.rowCount).toBe(0);
    const sentRow = (await deliveriesOf('reminder_1_day'))[0]!;
    expect(sentRow.status).toBe('sent');
    expect(sentRow.secretPayloadCiphertext).toBeNull();
  });

  it('42. 1-Tag-Mail Delivery: Lieferadresse/-fenster und Link „Kontakt vor Ort ändern“ (Zweck delivery_contact_update)', async () => {
    const { admin } = await adminSession(ctx);
    const startAt = futureStart();
    const endAt = new Date(startAt.getTime() + 3 * HOURS);
    const w = await world(admin.id, { fulfillment: 'delivery', outbound: { startAt, endAt } });
    const dueAt = reminderDueAt('reminder_1_day', startAt);
    await ctx.scan.reminders.scanDue(new Date(dueAt.getTime() + MINUTES));
    await drain();
    const mail = ctx.mailGateway.sent.find((m) => m.subject.includes('für morgen'))!;
    expect(mail.text).toContain('Kontakt vor Ort ändern');
    expect(mail.text).toContain('Lieferweg 12');
    expect(mail.text).toContain('55129 Mainz');
    expect(mail.text).toContain('Kontaktperson vor Ort');
    expect(mail.html).toContain('/kontakt/');
    const tokens = await ctx.db.select().from(customerActionTokens);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.purpose).toBe('delivery_contact_update');
    expect(tokens[0]!.appointmentId).toBe(w.outboundId);
  });
});

describe('43.–44. DST: 7 Kalendertage bei gleicher Wanduhrzeit', () => {
  it('43. März: Termin am Tag nach der Umstellung – 7-Tage-Zeitpunkt ist 167 h vorher (gleiche Wanduhrzeit 10:00)', async () => {
    const { admin } = await adminSession(ctx);
    const startAt = new Date('2026-03-30T08:00:00.000Z'); // 30.03.2026 10:00 MESZ
    const w = await world(admin.id, {
      outbound: { startAt },
      bookingCreatedAt: new Date('2026-01-10T10:00:00.000Z'),
    });
    const dueAt = reminderDueAt('reminder_7_days', startAt);
    expect(dueAt.toISOString()).toBe('2026-03-23T09:00:00.000Z'); // 23.03. 10:00 MEZ
    // 7 × 24 h vorher (= 23.03. 09:00 MEZ) wäre FALSCH: dort noch nicht fällig.
    await ctx.scan.reminders.scanDue(new Date(startAt.getTime() - 7 * DAYS + 30 * MINUTES));
    expect(await deliveriesOf()).toHaveLength(0);
    await ctx.scan.reminders.scanDue(new Date(dueAt.getTime() + MINUTES));
    const rows = await deliveriesOf('reminder_7_days');
    expect(rows).toHaveLength(1);
    expect((await remindersOf(w.outboundId))[0]!.dueAt.toISOString()).toBe(dueAt.toISOString());
  });

  it('44. Oktober: Termin am Tag nach der Umstellung – 7-Tage-Zeitpunkt ist 169 h vorher (gleiche Wanduhrzeit 09:30)', async () => {
    const { admin } = await adminSession(ctx);
    const startAt = new Date('2026-10-26T08:30:00.000Z'); // 26.10.2026 09:30 MEZ
    const w = await world(admin.id, {
      outbound: { startAt },
      bookingCreatedAt: new Date('2026-09-01T10:00:00.000Z'),
    });
    const dueAt = reminderDueAt('reminder_7_days', startAt);
    expect(dueAt.toISOString()).toBe('2026-10-19T07:30:00.000Z'); // 19.10. 09:30 MESZ
    expect((startAt.getTime() - dueAt.getTime()) / HOURS).toBe(169);
    await ctx.scan.reminders.scanDue(new Date(dueAt.getTime() - MINUTES));
    expect(await deliveriesOf()).toHaveLength(0);
    await ctx.scan.reminders.scanDue(new Date(dueAt.getTime() + MINUTES));
    expect(await deliveriesOf('reminder_7_days')).toHaveLength(1);
    expect(w.outboundId).toBeTruthy();
  });
});

describe('45.–49. Ungeplant, verspätete Buchung, Storno, Reschedule, Dedupe', () => {
  it('45. Ungeplanter Termin (startAt NULL): keine Mail, keine Reminder-Zeile', async () => {
    const { admin } = await adminSession(ctx);
    const w = await world(admin.id, { outbound: null });
    await ctx.scan.reminders.scanDue(new Date());
    await ctx.scan.reminders.scanDue(new Date(Date.now() + 30 * DAYS));
    expect(await deliveriesOf()).toHaveLength(0);
    expect(await remindersOf(w.outboundId)).toHaveLength(0);
  });

  it('46. Buchung nach verstrichenem 7-Tage-Zeitpunkt: nicht nachgeholt (Zeile ohne Zustellung, idempotent); Toleranz 6 h', async () => {
    const { admin } = await adminSession(ctx);
    // Buchung entsteht 3 Tage vor dem Termin: der 7-Tage-Zeitpunkt lag schon vor der Buchung.
    const startAt = futureStart(3);
    const w = await world(admin.id, { outbound: { startAt }, bookingCreatedAt: new Date() });
    const first = await ctx.scan.reminders.scanDue(new Date());
    expect(first).toEqual({ enqueued: 0, skipped: 1 });
    expect(await deliveriesOf()).toHaveLength(0);
    const rows = await remindersOf(w.outboundId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('reminder_7_days');
    expect(rows[0]!.mailDeliveryId).toBeNull();
    expect(rows[0]!.sentAt).toBeNull();
    // Weitere Scans: nichts Neues (Zeile existiert).
    const second = await ctx.scan.reminders.scanDue(new Date());
    expect(second).toEqual({ enqueued: 0, skipped: 0 });
    expect(await remindersOf(w.outboundId)).toHaveLength(1);

    // Toleranz: alte Buchung, aber dueAt liegt > 6 h zurück (z. B. Ausfall) ⇒ ebenfalls nicht nachgeholt.
    const startB = futureStart(9);
    const b = await world(admin.id, { outbound: { startAt: startB } });
    const dueB = reminderDueAt('reminder_7_days', startB);
    // (Summenzähler bewusst nicht geprüft: andere Termine dieses Tests können zeitgleich fällig sein.)
    await ctx.scan.reminders.scanDue(new Date(dueB.getTime() + REMINDER_TOLERANCE_MS + MINUTES));
    const lateRows = await remindersOf(b.outboundId);
    expect(lateRows.map((r) => r.kind)).toEqual(['reminder_7_days']);
    expect(lateRows[0]!.mailDeliveryId).toBeNull();
    // Knapp innerhalb der Toleranz würde gesendet (anderer Termin, frischer Scan).
    const startC = futureStart(10);
    const c = await world(admin.id, { outbound: { startAt: startC } });
    const dueC = reminderDueAt('reminder_7_days', startC);
    await ctx.scan.reminders.scanDue(new Date(dueC.getTime() + REMINDER_TOLERANCE_MS - MINUTES));
    const inTimeRows = await remindersOf(c.outboundId);
    expect(inTimeRows.map((r) => r.kind)).toEqual(['reminder_7_days']);
    expect(inTimeRows[0]!.mailDeliveryId).not.toBeNull();
  });

  it('46b. Buchung ohne E-Mail-Adresse: Zustellung blockiert (NO_RECIPIENT), Zeile angelegt, keine Mail', async () => {
    const { admin } = await adminSession(ctx);
    const startAt = futureStart();
    const w = await world(admin.id, { outbound: { startAt } });
    await ctx.pool.query(
      `UPDATE bookings SET customer_snapshot = customer_snapshot - 'email' WHERE id = $1`,
      [w.bookingId],
    );
    const dueAt = reminderDueAt('reminder_7_days', startAt);
    await ctx.scan.reminders.scanDue(new Date(dueAt.getTime() + MINUTES));
    const rows = await deliveriesOf('reminder_7_days');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('blocked');
    expect(rows[0]!.blockedReason).toBe('NO_RECIPIENT');
    await drain();
    expect(ctx.mailGateway.sent).toHaveLength(0);
    expect((await remindersOf(w.outboundId))[0]!.mailDeliveryId).toBe(rows[0]!.id);
  });

  it('47. Storno: stornierte Termine/Vorgänge bekommen keine Erinnerung', async () => {
    const { admin } = await adminSession(ctx);
    const startAt = futureStart();
    const w = await world(admin.id, { outbound: { startAt } });
    await ctx.db.transaction(async (tx) => {
      await w.scheduling.cancelForProcessWithin(tx, w.processId, new Date());
      await tx
        .update(processes)
        .set({ mainStatus: 'cancelled', cancelledAt: new Date() })
        .where(eq(processes.id, w.processId));
    });
    const dueAt = reminderDueAt('reminder_7_days', startAt);
    const summary = await ctx.scan.reminders.scanDue(new Date(dueAt.getTime() + MINUTES));
    expect(summary).toEqual({ enqueued: 0, skipped: 0 });
    expect(await deliveriesOf()).toHaveLength(0);
    expect(await remindersOf(w.outboundId)).toHaveLength(0);

    // Nur der Vorgang storniert (Termin noch scheduled): ebenfalls nichts.
    const v = await world(admin.id, { outbound: { startAt } });
    await ctx.db
      .update(processes)
      .set({ mainStatus: 'cancelled', cancelledAt: new Date() })
      .where(eq(processes.id, v.processId));
    await ctx.scan.reminders.scanDue(new Date(dueAt.getTime() + MINUTES));
    expect(await deliveriesOf()).toHaveLength(0);
  });

  it('48. Reschedule: alte Zeile bleibt (no-op), neuer Fingerprint bekommt seine Mail; gesendete nie doppelt; Verschiebung mit bereits verstrichenem Zeitpunkt ⇒ keine Mail', async () => {
    const { admin } = await adminSession(ctx);
    const startA = futureStart(8);
    const w = await world(admin.id, { outbound: { startAt: startA } });
    const dueA = reminderDueAt('reminder_7_days', startA);
    await ctx.scan.reminders.scanDue(new Date(dueA.getTime() + MINUTES));
    await drain();
    expect(ctx.mailGateway.sent).toHaveLength(1);

    // Verschiebung um 3 Tage nach hinten: 7-Tage-Zeitpunkt des NEUEN Termins liegt noch vor uns.
    const startB = new Date(startA.getTime() + 3 * DAYS);
    const current = (await w.scheduling.byId(w.outboundId)).version;
    await w.scheduling.reschedule(admin.id, w.outboundId, {
      startAt: startB,
      endAt: null,
      expectedVersion: current,
    });
    // Alter Fingerprint: weiterhin no-op (kein zweiter Versand für Termin A).
    await ctx.scan.reminders.scanDue(new Date(dueA.getTime() + 2 * MINUTES));
    expect(await deliveriesOf('reminder_7_days')).toHaveLength(1);
    const dueB = reminderDueAt('reminder_7_days', startB);
    await ctx.scan.reminders.scanDue(new Date(dueB.getTime() + MINUTES));
    const rows = await deliveriesOf('reminder_7_days');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(2);
    expect(rows.map((r) => (r.context as { appointmentAt: string }).appointmentAt).sort()).toEqual(
      [startA.toISOString(), startB.toISOString()].sort(),
    );
    await drain();
    expect(ctx.mailGateway.sent).toHaveLength(2);
    const reminders = await remindersOf(w.outboundId);
    expect(reminders.filter((r) => r.kind === 'reminder_7_days')).toHaveLength(2);
    expect(reminders.map((r) => r.fingerprint)).toContain(
      reminderFingerprint(w.outboundId, 'reminder_7_days', startA),
    );
    expect(reminders.map((r) => r.fingerprint)).toContain(
      reminderFingerprint(w.outboundId, 'reminder_7_days', startB),
    );

    // Verschiebung nach vorn auf 2 Tage nach „jetzt“: der 7-Tage-Zeitpunkt ist längst vorbei ⇒ keine Mail.
    const now = new Date(dueB.getTime() + 2 * MINUTES);
    const startC = new Date(now.getTime() + 2 * DAYS);
    const v2 = (await w.scheduling.byId(w.outboundId)).version;
    await w.scheduling.reschedule(admin.id, w.outboundId, {
      startAt: startC,
      endAt: null,
      expectedVersion: v2,
    });
    const summary = await ctx.scan.reminders.scanDue(now);
    expect(summary.enqueued).toBe(0);
    expect(await deliveriesOf('reminder_7_days')).toHaveLength(2);
    await drain();
    expect(ctx.mailGateway.sent).toHaveLength(2);
  });

  it('49. Dedupe: mehrere Scans und wiederholte Jobs erzeugen genau eine Mail je Termin und Art', async () => {
    const { admin } = await adminSession(ctx);
    const startAt = futureStart();
    const w = await world(admin.id, { outbound: { startAt } });
    const dueAt = reminderDueAt('reminder_7_days', startAt);
    for (let i = 1; i <= 4; i += 1) {
      await ctx.scan.reminders.scanDue(new Date(dueAt.getTime() + i * MINUTES));
    }
    await drain();
    for (let i = 5; i <= 7; i += 1) {
      await ctx.scan.reminders.scanDue(new Date(dueAt.getTime() + i * MINUTES));
    }
    await drain();
    expect(await deliveriesOf()).toHaveLength(1);
    expect(ctx.mailGateway.sent).toHaveLength(1);
    expect(await remindersOf(w.outboundId)).toHaveLength(1);
  });
});

describe('50.–52. Inhalt: Transporthinweise, Abholadresse, Rückgabezeit', () => {
  it('50. 1-Tag-Mail Pickup enthält die Transporthinweise und Tragepersonen; Delivery nicht', async () => {
    const { admin } = await adminSession(ctx);
    const startAt = futureStart();
    await world(admin.id, { outbound: { startAt } });
    await ctx.scan.reminders.scanDue(
      new Date(reminderDueAt('reminder_1_day', startAt).getTime() + MINUTES),
    );
    await drain();
    const mail = ctx.mailGateway.sent[0]!;
    for (const needle of [
      'aufrecht transportieren',
      'gegen Umkippen sichern',
      'Kofferraum oder auf der Ladefläche',
      'nicht auf dem Sitz oder im Fußraum',
      'Tragepersonen',
    ]) {
      expect(mail.text).toContain(needle);
      expect(mail.html).toContain(needle);
    }
    expect(mail.text).toContain('Mit freundlichen Grüßen');
    expect(mail.text).toContain('Miet-Royal Mainz');
  });

  it('51. Abholadresse: bestätigte Betriebsadresse (pickup_exact_address) in der Pickup-Mail; ohne Einstellung keine Adresszeile', async () => {
    const { admin } = await adminSession(ctx);
    const startAt = futureStart();
    await world(admin.id, { outbound: { startAt } });
    const dueAt = reminderDueAt('reminder_1_day', startAt);
    await ctx.scan.reminders.scanDue(new Date(dueAt.getTime() + MINUTES));
    await drain();
    expect(ctx.mailGateway.sent[0]!.text).not.toContain('Abholadresse');

    ctx.mailGateway.reset();
    await setPickupExactAddress(ctx, admin.id);
    const startB = futureStart(9);
    await world(admin.id, { outbound: { startAt: startB } });
    await ctx.scan.reminders.scanDue(
      new Date(reminderDueAt('reminder_1_day', startB).getTime() + MINUTES),
    );
    await drain();
    const mail = ctx.mailGateway.sent[0]!;
    expect(mail.text).toContain('Abholadresse');
    expect(mail.text).toContain('Teststraße 1, 55129 Mainz-Hechtsheim');
  });

  it('52. Rückgabezeit: geplanter Rückgabetermin wird genannt, ungeplanter nicht', async () => {
    const { admin } = await adminSession(ctx);
    const startAt = futureStart();
    const returnAt = new Date(startAt.getTime() + 2 * DAYS);
    await world(admin.id, { outbound: { startAt }, inbound: returnAt });
    const dueAt = reminderDueAt('reminder_7_days', startAt);
    await ctx.scan.reminders.scanDue(new Date(dueAt.getTime() + MINUTES));
    const rows = await deliveriesOf('reminder_7_days');
    expect(rows[0]!.context).toMatchObject({ returnAt: returnAt.toISOString() });
    await drain();
    expect(ctx.mailGateway.sent[0]!.text).toContain('Rückgabe');

    ctx.mailGateway.reset();
    const startB = futureStart(9);
    await world(admin.id, { outbound: { startAt: startB }, inbound: null });
    await ctx.scan.reminders.scanDue(
      new Date(reminderDueAt('reminder_7_days', startB).getTime() + MINUTES),
    );
    const rowsB = (await deliveriesOf('reminder_7_days')).filter(
      (r) => (r.context as { appointmentAt: string }).appointmentAt === startB.toISOString(),
    );
    expect(rowsB[0]!.context).toMatchObject({ returnAt: null });
  });
});

describe('53. Terminänderung (Order §19): bewusste Staff-Mail, Kunde-informiert-Zustand', () => {
  it('53. Nur bei offener Kundeninformation; Recht email.approve_prepared; nach Versand customerInformedAt gesetzt und Markierung abgeräumt; Doppelklick dedupliziert', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const startA = futureStart(8);
    const w = await world(admin.id, { outbound: { startAt: startA } });

    // Ohne offene Kundeninformation: 409.
    const none = await ctx.app.inject({
      method: 'POST',
      url: `/staff/appointments/${w.outboundId}/inform-customer`,
      headers: { cookie },
    });
    expect(none.statusCode).toBe(409);

    const version = (await w.scheduling.byId(w.outboundId)).version;
    const startB = new Date(startA.getTime() + 1 * DAYS);
    await w.scheduling.reschedule(admin.id, w.outboundId, {
      startAt: startB,
      endAt: null,
      expectedVersion: version,
    });
    expect((await w.scheduling.byId(w.outboundId)).customerInfoRequiredAt).not.toBeNull();

    // Mitarbeiter ohne das Recht: 403, keine Mail.
    const clerk = await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Carl',
      lastName: 'Clerk',
      email: 'carl@test.example',
      password: 'clerk-passwort-123456',
    });
    const clerkSession = await login(ctx.app, 'carl@test.example', 'clerk-passwort-123456');
    const forbidden = await ctx.app.inject({
      method: 'POST',
      url: `/staff/appointments/${w.outboundId}/inform-customer`,
      headers: { cookie: clerkSession.cookie },
    });
    expect([403, 404]).toContain(forbidden.statusCode);
    expect(await deliveriesOf('appointment_changed')).toHaveLength(0);
    expect(clerk.id).toBeTruthy();

    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/staff/appointments/${w.outboundId}/inform-customer`,
      headers: { cookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ informed: true, status: 'pending', deduplicated: false });
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/staff/appointments/${w.outboundId}/inform-customer`,
      headers: { cookie },
    });
    expect(again.json()).toMatchObject({ deduplicated: true });
    const rows = await deliveriesOf('appointment_changed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idempotencyKey).toBe(`appointment_changed:${w.outboundId}:${version + 1}`);
    expect(rows[0]!.context).toMatchObject({
      appointmentKind: 'pickup',
      newAt: startB.toISOString(),
      // Phase 12 §19: der dem Kunden bekannte (alte) Termin wird serverseitig festgehalten.
      oldAt: startA.toISOString(),
    });
    expect(rows[0]!.createdBy).toBe(admin.id);

    await drain();
    expect(ctx.mailGateway.sent).toHaveLength(1);
    const mail = ctx.mailGateway.sent[0]!;
    expect(mail.subject).toContain('Terminänderung');
    expect(mail.text).toContain('Abholung');
    expect(mail.text).toContain(w.processRow.processNumber);
    expect(mail.text).toContain('Neu');
    expect(mail.text).toContain('Bisher');
    const after = await w.scheduling.byId(w.outboundId);
    expect(after.customerInformedAt).not.toBeNull();
    expect(after.customerInfoRequiredAt).toBeNull();
    expect(after.customerKnownStartAt).toBeNull();
    // Kalendereintrag zeigt den Zustand.
    const entry = await w.scheduling.entryById(w.outboundId);
    expect(entry.customerInformedAt).not.toBeNull();
    expect(entry.customerInfoRequiredAt).toBeNull();

    // Erneut: keine offene Information mehr ⇒ 409.
    const closed = await ctx.app.inject({
      method: 'POST',
      url: `/staff/appointments/${w.outboundId}/inform-customer`,
      headers: { cookie },
    });
    expect(closed.statusCode).toBe(409);

    // Erinnerungen bleiben an den Fingerprint des aktuellen Termins gebunden.
    const dueB = reminderDueAt('reminder_7_days', startB);
    await ctx.scan.reminders.scanDue(new Date(dueB.getTime() + MINUTES));
    const reminders = await ctx.db
      .select()
      .from(appointmentReminders)
      .where(
        and(
          eq(appointmentReminders.appointmentId, w.outboundId),
          eq(appointmentReminders.kind, 'reminder_7_days'),
        ),
      );
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.fingerprint).toBe(
      reminderFingerprint(w.outboundId, 'reminder_7_days', startB),
    );
  });
});

describe('53b. Terminänderung: alter Termin = dem Kunden zuletzt mitgeteilter Termin', () => {
  it('53b. Mehrfache Verschiebung vor der Information nennt den ursprünglich bekannten Termin; Verschiebung während des Versands nennt danach den zuletzt gemailten Termin', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const startA = futureStart(10);
    const w = await world(admin.id, { outbound: { startAt: startA } });
    const inform = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/staff/appointments/${w.outboundId}/inform-customer`,
        headers: { cookie },
      });
    const move = async (startAt: Date) => {
      const version = (await w.scheduling.byId(w.outboundId)).version;
      await w.scheduling.reschedule(admin.id, w.outboundId, {
        startAt,
        endAt: null,
        expectedVersion: version,
      });
    };
    const startB = new Date(startA.getTime() + 1 * DAYS);
    const startC = new Date(startA.getTime() + 2 * DAYS);
    const startD = new Date(startA.getTime() + 3 * DAYS);

    // A → B → C ohne Information: bekannt bleibt A.
    await move(startB);
    await move(startC);
    expect((await w.scheduling.byId(w.outboundId)).customerKnownStartAt?.toISOString()).toBe(
      startA.toISOString(),
    );
    expect((await inform()).statusCode).toBe(200);
    let rows = await deliveriesOf('appointment_changed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.context).toMatchObject({
      oldAt: startA.toISOString(),
      newAt: startC.toISOString(),
    });

    // Vor dem Versand erneut verschoben (C → D): Mail mit „neu = C“ geht raus,
    // danach kennt der Kunde C; die offene Information für D bleibt bestehen.
    await move(startD);
    await drain();
    expect(ctx.mailGateway.sent).toHaveLength(1);
    const afterFirst = await w.scheduling.byId(w.outboundId);
    expect(afterFirst.customerInfoRequiredAt).not.toBeNull();
    expect(afterFirst.customerKnownStartAt?.toISOString()).toBe(startC.toISOString());

    expect((await inform()).statusCode).toBe(200);
    rows = await deliveriesOf('appointment_changed');
    expect(rows).toHaveLength(2);
    const second = rows.find(
      (r) => (r.context as { newAt: string }).newAt === startD.toISOString(),
    );
    expect(second?.context).toMatchObject({ oldAt: startC.toISOString() });
    await drain();
    const done = await w.scheduling.byId(w.outboundId);
    expect(done.customerInfoRequiredAt).toBeNull();
    expect(done.customerKnownStartAt).toBeNull();
  });
});

describe('53c. Terminänderung nach fehlgeschlagener Zustellung (Härtung RA-15)', () => {
  it('53c. Fehlgeschlagene Mail ⇒ erneute Aktion erzeugt eine neue Zustellung (…:retry:<vorherige>), nach Versand Kunde informiert; laufende Zustellung wird nicht dupliziert', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const startA = futureStart(9);
    const w = await world(admin.id, { outbound: { startAt: startA } });
    const version = (await w.scheduling.byId(w.outboundId)).version;
    const startB = new Date(startA.getTime() + 1 * DAYS);
    await w.scheduling.reschedule(admin.id, w.outboundId, {
      startAt: startB,
      endAt: null,
      expectedVersion: version,
    });
    const inform = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/staff/appointments/${w.outboundId}/inform-customer`,
        headers: { cookie },
      });

    // Erste Zustellung scheitert dauerhaft (5xx).
    ctx.mailGateway.nextOutcomes({ outcome: 'permanent_error', code: 'SMTP_550' });
    const first = await inform();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ informed: true, existingStatus: null });
    await drain();
    let rows = await deliveriesOf('appointment_changed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('failed');
    let appt = await w.scheduling.byId(w.outboundId);
    expect(appt.customerInformedAt).toBeNull();
    expect(appt.customerInfoRequiredAt).not.toBeNull();

    // Erneute bewusste Aktion: neue Zustellung mit Retry-Schlüssel, solange
    // sie läuft keine weitere (Doppelklick).
    const second = await inform();
    expect(second.json()).toMatchObject({ informed: true, existingStatus: null });
    const third = await inform();
    expect(third.json()).toMatchObject({ informed: true, deduplicated: true });
    rows = await deliveriesOf('appointment_changed');
    expect(rows).toHaveLength(2);
    const retry = rows.find((r) => r.id !== rows.find((x) => x.status === 'failed')!.id)!;
    expect(retry.idempotencyKey).toMatch(
      new RegExp(`^appointment_changed:${w.outboundId}:${version + 1}:retry:`),
    );
    await drain();
    expect(ctx.mailGateway.sent).toHaveLength(1);
    appt = await w.scheduling.byId(w.outboundId);
    // Der Sent-Listener erkennt auch Retry-Schlüssel.
    expect(appt.customerInformedAt).not.toBeNull();
    expect(appt.customerInfoRequiredAt).toBeNull();
    expect(appt.customerKnownStartAt).toBeNull();
  });
});
