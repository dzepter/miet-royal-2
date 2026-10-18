/**
 * Phase 12 – Vollständigkeitsprüfung der Pflichttests (Order §42) –
 * Integrationsanteil. Echte Tests für Themen, die in den Modul-Testdateien
 * nicht oder nur mittelbar abgedeckt waren (Zuordnung aller Nummern 1–205:
 * docs/PHASE12_TEST_TRACEABILITY.md):
 *
 * - PUSH 146–149: Push erst nach bewusster Aktivierung, mehrere Geräte je
 *   Mitarbeiter, Maschinenrisiko vor Ablauf der 6 h behoben ⇒ keine
 *   Erinnerung, stornierter Termin/Vorgang ⇒ kein 1-h-Push.
 * - ICS 167–168: nur offene, nicht stornierte Termine im Feed-Zeitraum;
 *   Titel je Terminart und abschließende Property-Liste (keine Kundendaten).
 * - CRYPTO 183/184: Gutscheincode über den gesamten Lebenszyklus (Ausgabe,
 *   Retry, Rewrap, Versand) nie im Klartext in der DB, im API- oder im
 *   Worker-Log.
 * - SECURITY 186 (Mail-IDOR) und 204 (Offline-Mutationen blockiert).
 *
 * Versand ausschließlich über die Fakes des Testkontexts (nichts verlässt das System).
 */
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { formatVoucherCode } from '@mietroyal/domain';
import {
  appointments,
  conversationMessages,
  integrationJobs,
  machineRiskIncidents,
  mailDeliveries,
  offlineMutationReceipts,
  processes,
  pushDeliveries,
  pushSubscriptions,
} from '@mietroyal/database';
import { JobRunner, type JobRunnerLogger } from '@mietroyal/integrations';
import { OFFLINE_MUTATION_TYPES } from '@mietroyal/offline/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unfoldIcs } from '../src/communication/calendar/ics.ts';
import { createCommunicationContext } from '../src/communication/context.ts';
import { PayloadCrypto } from '../src/communication/payload-crypto.ts';
import { buildPushPayload } from '../src/communication/push/payload.ts';
import { PushService } from '../src/communication/push/push-service.ts';
import { PushRuleScanner } from '../src/communication/push/rules.ts';
import { rewrapCommunicationSecrets } from '../src/communication/rewrap.ts';
import { registerCommunicationJobHandlers } from '../src/jobs/communication.ts';
import { registerFinanceJobHandlers } from '../src/jobs/finance.ts';
import { createConversationDeliveryListeners } from '../src/jobs/communication-inbound.ts';
import {
  createTransactionalMailModule,
  registerTransactionalJobHandlers,
} from '../src/jobs/communication-transactional.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createTestContext,
  destroyTestContext,
  login,
  type TestContext,
} from './auth-helpers.ts';
import {
  completeProcess,
  createCustomerWithProcess,
  drainJobs,
  insertOwnDelivery,
  truncateCommunicationTables,
} from './communication-helpers.ts';
import { createStaffWithPermissions } from './crm-helpers.ts';
import { DAYS, HOURS, handoverServicesFor, scheduledBooking } from './handover-helpers.ts';
import { offlineHelpers } from './offline-helpers.ts';
import { createAcceptedBooking, schedulingServiceFor } from './scheduling-helpers.ts';
import { adminSession, drainAllJobs, resetSettlementWorld } from './settlement-helpers.ts';
import {
  completeCleaningViaRoute,
  paidSettledWorld,
  truncateVoucherTables,
  voucherDeliveryFor,
  vouchersForSettlement,
} from './voucher-helpers.ts';
import { machineByCode } from './warehouse-helpers.ts';

const MINUTES = 60_000;
const PUBLIC_BASE = 'https://web.test.example';
const MAIL_ENV = {
  MAIL_ENABLED: 'true',
  MAIL_SMTP_HOST: 'smtp.test.example',
  MAIL_SMTP_USER: 'mailer@miet-royal.test',
  MAIL_SMTP_PASSWORD: 'smtp-password-coverage-never-logged',
  MAIL_FROM_NAME: 'Miet-Royal Mainz',
  MAIL_FROM_ADDRESS: 'noreply@miet-royal.test',
  MAIL_PUBLIC_WEB_BASE_URL: PUBLIC_BASE,
};
const UA_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1';
const UA_IPAD = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Safari/605.1';
const KEYS = { p256dh: 'BPk'.padEnd(87, 'A'), auth: 'auth-secret-16by' };
const TOKEN_PATH = /^\/api\/public\/calendar\/([A-Za-z0-9_-]{43})\.ics$/;

let ctx: TestContext;
const logLines: string[] = [];
const logDestination = new Writable({
  write(chunk: Buffer | string, _encoding, callback) {
    logLines.push(chunk.toString());
    callback();
  },
});
const logText = () => logLines.join('');

beforeAll(async () => {
  ctx = await createTestContext({ logDestination, logLevel: 'trace', env: MAIL_ENV });
});
afterAll(async () => {
  // Nichts in der geteilten Test-DB zurücklassen (Statusrouten anderer Tests erwarten leere Tabellen).
  await truncateCommunicationTables(ctx.pool);
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await ctx.pool.query(
    `TRUNCATE push_deliveries, push_subscriptions, appointment_reminders, calendar_feed_tokens,
     booking_customer_contacts, offline_mutation_receipts, offline_access_leases CASCADE`,
  );
  await truncateCommunicationTables(ctx.pool);
  await truncateVoucherTables(ctx.pool);
  // Abrechnung, Übergabe/Rückgabe, Lager, Termine, CRM, Auth, Commerce + Mock-Zähler.
  await resetSettlementWorld(ctx);
  ctx.push.reset();
  logLines.length = 0;
});

// ── Hilfen ──────────────────────────────────────────────────────────────────

function endpointFor(label: string): string {
  return `https://push.example.test/send/${label}-${'e'.repeat(40)}`;
}

async function subscribe(cookie: string, endpoint: string, label = 'Testgerät') {
  return ctx.app.inject({
    method: 'POST',
    url: '/staff/push/subscriptions',
    headers: { cookie },
    payload: { endpoint, keys: KEYS, userAgentLabel: label },
  });
}

async function pushDeliveryByKey(key: string) {
  const rows = await ctx.db
    .select()
    .from(pushDeliveries)
    .where(eq(pushDeliveries.idempotencyKey, key));
  return rows[0]!;
}

function scanner(): PushRuleScanner {
  return new PushRuleScanner({
    db: ctx.db,
    push: new PushService(ctx.db, ctx.queue),
    auth: ctx.auth,
  });
}

function employee(adminId: string, name: string, permissionKeys: string[]) {
  return createStaffWithPermissions(ctx, adminId, {
    firstName: name,
    lastName: 'Abdeckung',
    email: `${name.toLowerCase()}@test.example`,
    password: `${name.toLowerCase()}-passwort-1234`,
    permissionKeys: permissionKeys as never,
  });
}

/** Bestätigte Buchung, Vorgang zugewiesen; Abhol-/Liefer- und Rückgabetermin optional geplant. */
async function bookingWithTimes(
  adminId: string,
  assigneeId: string,
  times: { outbound: Date | null; inbound?: Date | null },
  options: { fulfillment?: 'pickup' | 'delivery'; eventInDays?: number } = {},
) {
  const world = await createAcceptedBooking(ctx, adminId, {
    fulfillment: options.fulfillment ?? 'pickup',
    assignProcessTo: assigneeId,
    ...(options.eventInDays === undefined ? {} : { eventInDays: options.eventInDays }),
  });
  const scheduling = schedulingServiceFor(ctx);
  await scheduling.ensureAppointmentsForBooking(world.bookingId);
  const rows = await ctx.db
    .select()
    .from(appointments)
    .where(eq(appointments.bookingId, world.bookingId));
  const outbound = rows.find((row) => row.kind === 'pickup' || row.kind === 'delivery')!;
  const inbound = rows.find((row) => row.kind === 'return')!;
  if (times.outbound !== null) {
    await scheduling.reschedule(adminId, outbound.id, {
      startAt: times.outbound,
      endAt: null,
      expectedVersion: outbound.version,
    });
  }
  if (times.inbound !== undefined && times.inbound !== null) {
    await scheduling.reschedule(adminId, inbound.id, {
      startAt: times.inbound,
      endAt: null,
      expectedVersion: inbound.version,
    });
  }
  const processRow = (
    await ctx.db.select().from(processes).where(eq(processes.id, world.processId))
  )[0]!;
  return {
    ...world,
    processNumber: processRow.processNumber,
    outboundId: outbound.id,
    inboundId: inbound.id,
    scheduling,
  };
}

/** Termine und Vorgang stornieren wie der Storno-Pfad (Termine cancelled, Vorgang cancelled). */
async function cancelProcessAndAppointments(processId: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await schedulingServiceFor(ctx).cancelForProcessWithin(tx, processId, new Date());
    await tx
      .update(processes)
      .set({ mainStatus: 'cancelled', cancelledAt: new Date() })
      .where(eq(processes.id, processId));
  });
}

async function cancelProcessOnly(processId: string): Promise<void> {
  await ctx.db
    .update(processes)
    .set({ mainStatus: 'cancelled', cancelledAt: new Date() })
    .where(eq(processes.id, processId));
}

async function createFeed(cookie: string) {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/staff/calendar/feed',
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { url: string };
  const match = TOKEN_PATH.exec(body.url.replace(/^https?:\/\/[^/]+/, ''));
  expect(match).not.toBeNull();
  return `/public/calendar/${match![1]!}.ics`;
}

/** Alle Text-/JSON-Spalten der DB nach einem Klartext durchsuchen (nur Test). */
async function tablesContaining(needle: string): Promise<string[]> {
  const columns = await ctx.pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'jsonb', 'json')`,
  );
  const hits: string[] = [];
  for (const column of columns.rows) {
    const result = await ctx.pool.query(
      `SELECT 1 FROM "${column.table_name}" WHERE "${column.column_name}"::text ILIKE $1 LIMIT 1`,
      [`%${needle}%`],
    );
    if (result.rowCount !== null && result.rowCount > 0)
      hits.push(`${column.table_name}.${column.column_name}`);
  }
  return hits;
}

// ── PUSH 146–149 ────────────────────────────────────────────────────────────

describe('PUSH 146–149: bewusste Aktivierung, mehrere Geräte, Risiko behoben, Storno', () => {
  it('146. Push erst nach bewusster Benutzeraktion: Login (zwei Geräte), Status- und VAPID-Abfragen legen KEINE Subscription an; erst POST /staff/push/subscriptions registriert das Gerät', async () => {
    const admin = await bootstrapAdmin(ctx);
    const laptop = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD, UA_WINDOWS);
    await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD, UA_IPHONE);
    const probes = [
      { method: 'GET' as const, url: '/staff/push/vapid-public-key' },
      { method: 'GET' as const, url: '/staff/push/subscriptions' },
      {
        method: 'POST' as const,
        url: '/staff/push/subscriptions/status',
        payload: { endpoint: endpointFor('probe') },
      },
    ];
    for (const probe of probes) {
      const response = await ctx.app.inject({ ...probe, headers: { cookie: laptop.cookie } });
      expect(response.statusCode, probe.url).toBe(200);
    }
    expect(await ctx.db.select().from(pushSubscriptions)).toHaveLength(0);
    // Ohne registriertes Gerät entsteht für die neue Anmeldung kein Security-Push.
    expect(await ctx.db.select().from(pushDeliveries)).toHaveLength(0);

    // Ein fachlicher Push vor der Aktivierung erreicht niemanden.
    const push = new PushService(ctx.db, ctx.queue);
    await push.enqueue({
      kind: 'substitution_started',
      userId: admin.id,
      idempotencyKey: 'coverage:146:before',
      payload: buildPushPayload({ kind: 'substitution_started' }),
    });
    await drainJobs(ctx);
    expect(ctx.push.sent).toHaveLength(0);
    expect(await pushDeliveryByKey('coverage:146:before')).toMatchObject({
      status: 'failed',
      lastErrorCode: 'NO_SUBSCRIPTIONS',
      subscriptionsTargeted: 0,
    });

    // Bewusste Aktivierung auf genau diesem Gerät.
    expect((await subscribe(laptop.cookie, endpointFor('laptop'))).statusCode).toBe(200);
    const rows = await ctx.db.select().from(pushSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: admin.id, disabledAt: null });
    await push.enqueue({
      kind: 'substitution_started',
      userId: admin.id,
      idempotencyKey: 'coverage:146:after',
      payload: buildPushPayload({ kind: 'substitution_started' }),
    });
    await drainJobs(ctx);
    expect(ctx.push.sent.map((record) => record.endpoint)).toEqual([endpointFor('laptop')]);
    expect((await pushDeliveryByKey('coverage:146:after')).status).toBe('sent');
  });

  it('147. Mehrere Geräte eines Mitarbeiters: jedes aktive Gerät erhält den Push genau einmal; ein abgemeldetes (Logout) und ein vom Dienst gelöschtes (410) Gerät danach nicht mehr', async () => {
    const admin = await bootstrapAdmin(ctx);
    const laptop = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD, UA_WINDOWS);
    const phone = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD, UA_IPHONE);
    const tablet = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD, UA_IPAD);
    for (const [cookie, label] of [
      [laptop.cookie, 'laptop'],
      [phone.cookie, 'phone'],
      [tablet.cookie, 'tablet'],
    ] as const) {
      expect((await subscribe(cookie, endpointFor(label), label)).statusCode).toBe(200);
    }
    const subscriptions = await ctx.db.select().from(pushSubscriptions);
    expect(subscriptions).toHaveLength(3);
    expect(new Set(subscriptions.map((row) => row.sessionId)).size).toBe(3);
    expect(subscriptions.every((row) => row.userId === admin.id)).toBe(true);

    const push = new PushService(ctx.db, ctx.queue);
    const send = async (key: string) => {
      await push.enqueue({
        kind: 'substitution_started',
        userId: admin.id,
        idempotencyKey: key,
        payload: buildPushPayload({ kind: 'substitution_started' }),
      });
      const before = ctx.push.sent.length;
      await drainJobs(ctx);
      return ctx.push.sent.slice(before).filter((r) => r.payload.kind === 'substitution_started');
    };

    const first = await send('coverage:147:all');
    expect(first.map((r) => r.endpoint).sort()).toEqual(
      [endpointFor('laptop'), endpointFor('phone'), endpointFor('tablet')].sort(),
    );
    expect(await pushDeliveryByKey('coverage:147:all')).toMatchObject({
      status: 'sent',
      subscriptionsTargeted: 3,
      subscriptionsSucceeded: 3,
    });

    // Telefon meldet sich ab; Tablet-Subscription ist beim Push-Dienst gelöscht (410).
    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: phone.cookie },
    });
    expect(logout.statusCode).toBe(200);
    ctx.push.setBehaviour(endpointFor('tablet'), 'gone');
    const second = await send('coverage:147:partial');
    expect(second.map((r) => r.endpoint).sort()).toEqual(
      [endpointFor('laptop'), endpointFor('tablet')].sort(),
    );
    expect(await pushDeliveryByKey('coverage:147:partial')).toMatchObject({
      status: 'sent',
      subscriptionsTargeted: 2,
      subscriptionsSucceeded: 1,
    });
    const byEndpoint = new Map(
      (await ctx.db.select().from(pushSubscriptions)).map((row) => [row.endpoint, row]),
    );
    expect(byEndpoint.get(endpointFor('phone'))!.disabledReason).toBe('session_revoked');
    expect(byEndpoint.get(endpointFor('tablet'))!.disabledReason).toBe('gone');
    expect(byEndpoint.get(endpointFor('laptop'))!.disabledAt).toBeNull();

    const third = await send('coverage:147:remaining');
    expect(third.map((r) => r.endpoint)).toEqual([endpointFor('laptop')]);
    expect(await pushDeliveryByKey('coverage:147:remaining')).toMatchObject({
      status: 'sent',
      subscriptionsTargeted: 1,
    });
  });

  it('148. Maschinenrisiko vor Ablauf der 6 h behoben ⇒ KEINE Erinnerung (nur „nach 6 h offen“); der Erst-Push bleibt der einzige', async () => {
    const { admin } = await adminSession(ctx);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    const services = handoverServicesFor(ctx);
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    const world = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 1 * DAYS),
      to: new Date(Date.now() + 3 * DAYS),
    });
    await services.handover.ensureForBooking(world.bookingId, admin.id);
    const slot = (await services.assignments.slotsForBooking(world.bookingId))[0]!;
    await services.assignments.assign(admin.id, effective, slot.id, machine.id, null);
    const block = await services.machineService.createBlock(machine.id, admin.id, {
      startsAt: new Date(Date.now() + 1 * DAYS),
      endsAt: new Date(Date.now() + 2 * DAYS),
      reason: 'Wartung',
    });
    await services.assignments.refreshRiskIncidents();
    expect(await ctx.db.select().from(machineRiskIncidents)).toHaveLength(1);

    const now = new Date();
    const initial = await scanner().scanDue(now);
    expect(initial.machineRisk).toBe(1);
    const riskDeliveries = async (kind: 'machine_risk' | 'machine_risk_6h') =>
      (await ctx.db.select().from(pushDeliveries)).filter((row) => row.kind === kind);
    expect(await riskDeliveries('machine_risk')).toHaveLength(1);

    // Sperre nach 2 h aufgehoben ⇒ Neubewertung schließt den Fall.
    await services.machineService.liftBlock(block.id, admin.id);
    await services.assignments.refreshRiskIncidents();
    const incident = (await ctx.db.select().from(machineRiskIncidents))[0]!;
    expect(incident.resolvedAt).not.toBeNull();
    expect(incident.followUpSentAt).toBeNull();

    const due = await scanner().scanDue(new Date(now.getTime() + 6 * HOURS + 1));
    expect(due).toMatchObject({ machineRisk: 0, machineRisk6h: 0 });
    const later = await scanner().scanDue(new Date(now.getTime() + 24 * HOURS));
    expect(later.machineRisk6h).toBe(0);
    expect(await riskDeliveries('machine_risk_6h')).toHaveLength(0);
    expect(await riskDeliveries('machine_risk')).toHaveLength(1);
    expect((await ctx.db.select().from(machineRiskIncidents))[0]!.followUpSentAt).toBeNull();
  });

  it('149. Stornierter Termin bzw. stornierter Vorgang ⇒ kein 1-h-Push; ein unveränderter Termin im selben Scan erhält genau einen', async () => {
    const { admin } = await adminSession(ctx);
    const anna = await employee(admin.id, 'Anna', ['calendar.view']);
    const now = new Date();
    const control = await bookingWithTimes(admin.id, anna.user.id, {
      outbound: new Date(now.getTime() + 30 * MINUTES),
    });
    const cancelledBoth = await bookingWithTimes(admin.id, anna.user.id, {
      outbound: new Date(now.getTime() + 35 * MINUTES),
    });
    const cancelledProcess = await bookingWithTimes(admin.id, anna.user.id, {
      outbound: new Date(now.getTime() + 40 * MINUTES),
    });
    await cancelProcessAndAppointments(cancelledBoth.processId);
    await cancelProcessOnly(cancelledProcess.processId);

    const summary = await scanner().scanDue(now);
    expect(summary.appointment1h).toBe(1);
    const rows = (await ctx.db.select().from(pushDeliveries)).filter(
      (row) => row.kind === 'appointment_1h',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(anna.user.id);
    expect(rows[0]!.payload).toMatchObject({
      url: `/vorgaenge/${control.processId}/termine`,
      body: `Abholung ${control.processNumber}`,
    });
    // Wiederholte Scans holen nichts für die stornierten Vorgänge nach.
    const again = await scanner().scanDue(new Date(now.getTime() + 2 * MINUTES));
    expect(again.appointment1h).toBe(0);
    const reminderRows = await ctx.pool.query<{ appointment_id: string }>(
      `SELECT appointment_id FROM appointment_reminders WHERE kind = 'push_1_hour'`,
    );
    expect(reminderRows.rows.map((row) => row.appointment_id)).toEqual([control.outboundId]);
  });
});

// ── ICS 167–168 ─────────────────────────────────────────────────────────────

describe('ICS 167–168: nur offene Termine im Zeitraum; Titel je Terminart, abschließende Properties', () => {
  it('167. Stornierte Termine, stornierte Vorgänge und Termine außerhalb −30…+180 Tage erscheinen nicht im Feed; der offene Termin schon', async () => {
    const { admin } = await adminSession(ctx);
    const anna = await employee(admin.id, 'Anna', ['calendar.view']);
    const visible = await bookingWithTimes(admin.id, anna.user.id, {
      outbound: new Date(Date.now() + 2 * DAYS),
    });
    const cancelledBoth = await bookingWithTimes(admin.id, anna.user.id, {
      outbound: new Date(Date.now() + 3 * DAYS),
    });
    const cancelledProcess = await bookingWithTimes(admin.id, anna.user.id, {
      outbound: new Date(Date.now() + 4 * DAYS),
    });
    const farFuture = await bookingWithTimes(
      admin.id,
      anna.user.id,
      { outbound: new Date(Date.now() + 200 * DAYS) },
      { eventInDays: 201 },
    );
    const feedPath = await createFeed(anna.cookie);
    const before = unfoldIcs((await ctx.app.inject({ method: 'GET', url: feedPath })).body);
    // Vor dem Storno sind die drei nahen Termine sichtbar (Gegenprobe).
    for (const world of [visible, cancelledBoth, cancelledProcess]) {
      expect(before).toContain(`UID:${world.outboundId}@miet-royal`);
    }
    expect(before).not.toContain(`UID:${farFuture.outboundId}@miet-royal`);

    await cancelProcessAndAppointments(cancelledBoth.processId);
    await cancelProcessOnly(cancelledProcess.processId);
    const response = await ctx.app.inject({ method: 'GET', url: feedPath });
    expect(response.statusCode).toBe(200);
    const lines = unfoldIcs(response.body);
    expect(lines).toContain(`UID:${visible.outboundId}@miet-royal`);
    for (const world of [cancelledBoth, cancelledProcess, farFuture]) {
      expect(lines).not.toContain(`UID:${world.outboundId}@miet-royal`);
      expect(response.body).not.toContain(world.processNumber);
    }
    expect(lines.filter((line) => line === 'BEGIN:VEVENT')).toHaveLength(1);
  });

  it('168. Titel je Terminart („Miet-Royal – Abholung/Lieferung/Rückgabe MR-…“); VEVENT/VCALENDAR enthalten ausschließlich die erlaubten Properties (keine Adresse/Teilnehmer/Alarme)', async () => {
    const { admin } = await adminSession(ctx);
    const anna = await employee(admin.id, 'Anna', ['calendar.view']);
    const pickup = await bookingWithTimes(admin.id, anna.user.id, {
      outbound: new Date(Date.now() + 2 * DAYS),
      inbound: new Date(Date.now() + 3 * DAYS),
    });
    const delivery = await bookingWithTimes(
      admin.id,
      anna.user.id,
      { outbound: new Date(Date.now() + 4 * DAYS) },
      { fulfillment: 'delivery' },
    );
    const feedPath = await createFeed(anna.cookie);
    const body = (await ctx.app.inject({ method: 'GET', url: feedPath })).body;
    const lines = unfoldIcs(body);
    const summaries = lines.filter((line) => line.startsWith('SUMMARY:')).sort();
    expect(summaries).toEqual(
      [
        `SUMMARY:Miet-Royal – Abholung ${pickup.processNumber}`,
        `SUMMARY:Miet-Royal – Lieferung ${delivery.processNumber}`,
        `SUMMARY:Miet-Royal – Rückgabe ${pickup.processNumber}`,
      ].sort(),
    );
    const descriptions = lines.filter((line) => line.startsWith('DESCRIPTION:'));
    expect(descriptions).toHaveLength(3);
    for (const description of descriptions) {
      expect(description).toMatch(
        /^DESCRIPTION:(Abholung|Lieferung|Rückgabe) MR-\d{4}-\d{4,}\\n\S*\/vorgaenge\/[0-9a-f-]{36}\/termine$/,
      );
    }
    // Lieferadresse der Delivery-Buchung (Lieferweg 12, 55129 Mainz) erscheint nirgends.
    for (const forbidden of ['Lieferweg', '55129', 'Klara', 'Kommerz', '€']) {
      expect(body, forbidden).not.toContain(forbidden);
    }

    // Abschließende Property-Liste je VEVENT (RFC 5545 + Order §34).
    const allowedEvent = new Set([
      'UID',
      'DTSTAMP',
      'DTSTART;TZID=Europe/Berlin',
      'DTEND;TZID=Europe/Berlin',
      'SEQUENCE',
      'SUMMARY',
      'DESCRIPTION',
      'URL',
    ]);
    const nameOf = (line: string) => line.slice(0, line.indexOf(':'));
    let inEvent = false;
    let events = 0;
    const calendarLevel: string[] = [];
    let inTimezone = false;
    for (const line of lines) {
      if (line === 'BEGIN:VEVENT') {
        inEvent = true;
        events += 1;
        continue;
      }
      if (line === 'END:VEVENT') {
        inEvent = false;
        continue;
      }
      if (line === 'BEGIN:VTIMEZONE') inTimezone = true;
      if (inTimezone) {
        if (line === 'END:VTIMEZONE') inTimezone = false;
        continue;
      }
      if (inEvent) {
        expect(allowedEvent.has(nameOf(line)), line).toBe(true);
      } else calendarLevel.push(nameOf(line));
    }
    expect(events).toBe(3);
    expect(calendarLevel).toEqual([
      'BEGIN',
      'VERSION',
      'PRODID',
      'CALSCALE',
      'METHOD',
      'NAME',
      'X-WR-CALNAME',
      'X-WR-TIMEZONE',
      'REFRESH-INTERVAL;VALUE=DURATION',
      'X-PUBLISHED-TTL',
      'END',
    ]);
    expect(lines.some((line) => /^(BEGIN:VALARM|ATTENDEE|ORGANIZER|LOCATION|GEO)/.test(line))).toBe(
      false,
    );
  });
});

// ── CRYPTO 183/184 ──────────────────────────────────────────────────────────

describe('CRYPTO 183/184: kein Klartext des Gutscheincodes in DB und Logs', () => {
  /** Worker-ähnliche Komposition mit mitschreibendem Logger (wie apps/worker). */
  function capturingWorker() {
    const lines: string[] = [];
    const record =
      (level: string): JobRunnerLogger['info'] =>
      (context, message) =>
        void lines.push(JSON.stringify({ level, context, message }));
    const logger: JobRunnerLogger = {
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    };
    const communication = createCommunicationContext(ctx.config, ctx.db, ctx.queue, {
      gateway: ctx.mailGateway,
      storage: ctx.storage,
      logger,
    });
    createTransactionalMailModule({
      communication,
      db: ctx.db,
      config: ctx.config,
      queue: ctx.queue,
      lexware: ctx.lexware,
      transfers: ctx.transfersFor('coverage-listener'),
      logger,
    });
    const conversation = createConversationDeliveryListeners(ctx.db, ctx.storage);
    communication.addMailSentListener(conversation.sent);
    communication.addMailFailedListener(conversation.failed);
    const runner = new JobRunner(ctx.queue, 'coverage-worker', logger);
    // Gutschein-Prüfung (Codeerzeugung) wie im Worker – ebenfalls mit mitschreibendem Logger.
    registerFinanceJobHandlers(runner, {
      db: ctx.db,
      config: ctx.config,
      queue: ctx.queue,
      storage: ctx.storage,
      accountingGateway: ctx.gateway,
      lexware: ctx.lexware,
      lexwareConnection: ctx.lexwareConnection,
      workerId: 'coverage-worker',
      logger,
    });
    registerCommunicationJobHandlers(runner, { communication });
    registerTransactionalJobHandlers(runner, {
      communication,
      db: ctx.db,
      config: ctx.config,
      logger,
    });
    const drain = async () => {
      for (let i = 0; i < 50; i += 1) if ((await runner.runOnce()) === 'idle') break;
    };
    return { lines, drain };
  }

  it('183./184. Gutscheincode über Ausgabe, Versand-Retry, Rewrap und Versand: in KEINER DB-Spalte im Klartext (nur v2-Ciphertext), nie im API- oder Worker-Log; nach Versand bleibt nur der Hash', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidSettledWorld(ctx, admin.id, cookie);
    // Fachjobs der Welt (Transfer usw.) zuerst über den Standard-Runner abarbeiten.
    await drainAllJobs(ctx);
    ctx.mailGateway.reset();
    // Reinigung abgeschlossen ⇒ voucher.eligibility_check (Codeerzeugung) ⇒ voucher.delivery
    // ⇒ mail.send; der erste Versandversuch wird temporär abgelehnt (Retry).
    for (const code of paid.world.machineCodes) await completeCleaningViaRoute(ctx, cookie, code);
    const worker = capturingWorker();
    ctx.mailGateway.nextOutcomes({ outcome: 'transient_error', code: 'SMTP_421' });
    await worker.drain();
    const voucher = (await vouchersForSettlement(ctx, paid.settlementId))[0]!;
    expect(voucher).toMatchObject({ status: 'active', deliveryStatus: 'pending' });
    expect(voucher.deliveryCodeCiphertext).toMatch(/^v2:[0-9a-f]{12}:/);
    const pending = (await ctx.db.select().from(mailDeliveries)).find(
      (row) => row.kind === 'voucher_delivery',
    )!;
    expect(pending).toMatchObject({ status: 'retry', lastErrorCode: 'SMTP_421' });
    expect(pending.secretPayloadCiphertext).toMatch(/^v2:[0-9a-f]{12}:/);
    // Klartext NUR für den Test (serverseitiger Versandpfad, v2 ⇒ kein Rewrap).
    const code = await voucherDeliveryFor(ctx).revealCodeForDelivery(voucher.id);
    expect(code).toMatch(/^MR20[A-Z0-9]{12}$/);
    const needles = [code, formatVoucherCode(code), code.slice(0, -4)];
    const assertNoPlaintextInDb = async (phase: string) => {
      for (const needle of needles) expect(await tablesContaining(needle), phase).toEqual([]);
    };
    await assertNoPlaintextInDb('nach Ausgabe, im Retry');

    // Rewrap-Lauf (pnpm communication:rewrap-secrets) mit aktuellem Schlüssel: Zähler, kein Klartext.
    const rewrap = await rewrapCommunicationSecrets(ctx.db, new PayloadCrypto(ctx.config));
    expect(rewrap.vouchers).toMatchObject({ scanned: 1, current: 1, undecryptable: 0 });
    expect(rewrap.mailDeliveries).toMatchObject({ undecryptable: 0 });
    expect(JSON.stringify(rewrap)).not.toContain(code);
    await assertNoPlaintextInDb('nach Rewrap');

    // Retry fällig ⇒ Zustellung; Code steht ausschließlich in der Mail.
    await ctx.pool.query(`UPDATE integration_jobs SET run_at = now() WHERE status = 'pending'`);
    await ctx.pool.query(`UPDATE mail_deliveries SET next_attempt_at = now() WHERE id = $1`, [
      pending.id,
    ]);
    await worker.drain();
    const sent = (await ctx.db.select().from(mailDeliveries)).find((row) => row.id === pending.id)!;
    expect(sent).toMatchObject({ status: 'sent', secretPayloadCiphertext: null });
    const mail = ctx.mailGateway.sent.find((m) => m.messageId === sent.messageId)!;
    expect(mail.text).toContain(formatVoucherCode(code));
    const after = (await vouchersForSettlement(ctx, paid.settlementId))[0]!;
    expect(after).toMatchObject({ deliveryStatus: 'sent', deliveryCodeCiphertext: null });
    expect(after.codeHash).toBe(voucher.codeHash);
    await assertNoPlaintextInDb('nach Versand');

    // Logs: Worker (Jobs, Outbox, Listener) und API (trace) – nie Code, Schlüssel oder Mailtext.
    expect(worker.lines.length).toBeGreaterThan(0);
    const logs = `${logText()}\n${worker.lines.join('\n')}`;
    const mailBody = 'Gib den Code einfach bei deiner nächsten Anfrage an.';
    for (const needle of [...needles, ctx.config.communication.payloadKey, mailBody]) {
      expect(logs, needle).not.toContain(needle);
    }
    expect(logs).not.toContain(voucher.deliveryCodeCiphertext!);
  });
});

// ── SECURITY 186 / 204 ──────────────────────────────────────────────────────

describe('SECURITY 186 (Mail-IDOR) und 204 (Offline-Mutationen blockiert)', () => {
  it('186. Mail-IDOR: Kommunikationsstatus eines unsichtbaren (alt abgeschlossenen) Vorgangs ⇒ dasselbe neutrale 404 wie eine unbekannte ID; „Kunden informieren“ auf einem fremden Termin ⇒ 404 ohne Mail', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id, {
      email: 'idor.kunde@example.org',
    });
    await insertOwnDelivery(ctx, {
      processId: process.id,
      customerId: customer.id,
      messageId: '<coverage-186@miet-royal.test>',
      recipientEmail: 'idor.kunde@example.org',
    });
    // Abgeschlossen vor 30 Tagen (Sichtbarkeitsfenster normaler Mitarbeitender: 7 Tage).
    await completeProcess(ctx, process.id);
    await ctx.db
      .update(processes)
      .set({ completedAt: new Date(Date.now() - 30 * DAYS) })
      .where(eq(processes.id, process.id));
    const viewer = await employee(admin.id, 'Vera', ['process.view_all']);
    const status = (processId: string, as: string) =>
      ctx.app.inject({
        method: 'GET',
        url: `/staff/processes/${processId}/communication-status`,
        headers: { cookie: as },
      });
    const hidden = await status(process.id, viewer.cookie);
    const unknown = await status(randomUUID(), viewer.cookie);
    expect(hidden.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    const neutral = (body: { error: { code: string; message: string } }) => ({
      code: body.error.code,
      message: body.error.message,
    });
    expect(neutral(hidden.json())).toEqual(neutral(unknown.json()));
    expect(hidden.body).not.toContain('idor.kunde');
    expect(hidden.body).not.toContain('coverage-186');
    // Gegenprobe: Admin (process.view_completed) sieht den Status.
    const visible = await status(process.id, cookie);
    expect(visible.statusCode).toBe(200);
    expect(visible.json().deliveries).toEqual([
      expect.objectContaining({ kind: 'offer', status: 'sent' }),
    ]);

    // „Kunden über Terminänderung informieren“ nur für sichtbare Termine.
    const world = await bookingWithTimes(admin.id, admin.id, {
      outbound: new Date(Date.now() + 8 * DAYS),
    });
    const current = await world.scheduling.byId(world.outboundId);
    await world.scheduling.reschedule(admin.id, world.outboundId, {
      startAt: new Date(Date.now() + 9 * DAYS),
      endAt: null,
      expectedVersion: current.version,
    });
    expect((await world.scheduling.byId(world.outboundId)).customerInfoRequiredAt).not.toBeNull();
    await drainAllJobs(ctx);
    const clerk = await employee(admin.id, 'Clara', ['email.approve_prepared', 'calendar.view']);
    const inform = (as: string) =>
      ctx.app.inject({
        method: 'POST',
        url: `/staff/appointments/${world.outboundId}/inform-customer`,
        headers: { cookie: as },
      });
    const foreign = await inform(clerk.cookie);
    expect(foreign.statusCode).toBe(404);
    const changedMails = async () =>
      (await ctx.db.select().from(mailDeliveries)).filter(
        (row) => row.kind === 'appointment_changed',
      );
    expect(await changedMails()).toHaveLength(0);
    expect((await world.scheduling.byId(world.outboundId)).customerInfoRequiredAt).not.toBeNull();
    const own = await inform(cookie);
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ informed: true });
    expect(await changedMails()).toHaveLength(1);
  });

  it('204. Offline-Mutationen blockiert: Kommunikationsaktionen sind keine Offline-Mutationsart – der Sync lehnt sie per Schema ab (400), nichts wird quittiert, eingereiht oder versendet; online ist dieselbe Antwort möglich', async () => {
    // Die abgeschlossene Liste der Offline-Mutationen enthält keine Kommunikationsaktion.
    expect(
      OFFLINE_MUTATION_TYPES.filter((type) =>
        /mail|message|conversation|whatsapp|push|calendar|voucher|notice|inform|reply|resend|communication/i.test(
          type,
        ),
      ),
    ).toEqual([]);
    const helpers = offlineHelpers(() => ctx);
    const { admin } = await adminSession(ctx);
    const { process } = await createCustomerWithProcess(ctx, admin.id, {
      email: 'offline.kunde@example.org',
    });
    const staff = await helpers.staffWith(
      admin.id,
      [...helpers.OPERATIVE, 'message.reply_customer', 'whatsapp.reply', 'email.approve_prepared'],
      'Kommunikation',
    );
    expect((await helpers.lease(staff.cookie)).statusCode).toBe(200);
    const communicationTypes = [
      'conversation.reply',
      'message.reply_customer',
      'whatsapp.reply',
      'mail.send',
      'mail.resend',
      'voucher.send',
      'appointment.inform_customer',
      'settlement.notice_send',
      'cancellation.confirmation_send',
      'push.subscribe',
      'calendar.feed_regenerate',
    ];
    for (const type of communicationTypes) {
      const result = await helpers.sync(staff.cookie, {
        type,
        contextKind: 'booking',
        contextId: process.id,
        payload: { channel: 'email', body: 'Hallo aus dem Funkloch' },
      });
      expect(result.response.statusCode, type).toBe(400);
      expect((result.json.error as { code: string }).code, type).toBe('VALIDATION_ERROR');
    }
    expect(await ctx.db.select().from(offlineMutationReceipts)).toHaveLength(0);
    expect(await ctx.db.select().from(mailDeliveries)).toHaveLength(0);
    expect(await ctx.db.select().from(conversationMessages)).toHaveLength(0);
    const communicationJobs = (await ctx.db.select().from(integrationJobs)).filter((job) =>
      /^(mail|whatsapp|push|voucher|invoice)\./.test(job.type),
    );
    expect(communicationJobs).toEqual([]);
    expect(ctx.mailGateway.attempts).toHaveLength(0);

    // Gegenprobe online: dieselbe Antwort über die Staff-Route wird angenommen und versendet.
    const online = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${process.id}/conversation/reply`,
      headers: { cookie: staff.cookie },
      payload: { channel: 'email', body: 'Hallo aus dem Funkloch' },
    });
    expect(online.statusCode).toBe(201);
    await drainJobs(ctx);
    expect(ctx.mailGateway.sent.map((m) => m.to.email)).toEqual(['offline.kunde@example.org']);
  });
});
