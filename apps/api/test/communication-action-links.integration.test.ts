/**
 * Phase 12 – ACTION LINKS (Pflichttests 54–68, Order §§20/42) plus Security
 * (Token-Enumeration neutral, kein Token im Log, Cutoff exakt 1 h):
 * Token nur als Hash, Booking-Bindung, Ablauf/Cutoff, Pflichtfelder,
 * Überschreiben, alle Maschinen, Phone-Löschung, Pickup/Delivery-Trennung,
 * Widerruf bei erneuter Ausgabe, Rate-Limit, Datenminimierung, Staff-Sicht.
 */
import { Writable } from 'node:stream';
import {
  appointments,
  bookingCustomerContacts,
  customerActionTokens,
  processes,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTION_LINK_CUTOFF_MS,
  CustomerActionLinkService,
  hashActionToken,
} from '../src/communication/action-links/service.ts';
import { maskLoggedPath } from '../src/app.ts';
import {
  createEmployeeWithPassword,
  createTestContext,
  destroyTestContext,
  login,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { createStaffWithPermissions, truncateCrmTables } from './crm-helpers.ts';
import { DAYS, HOURS } from './handover-helpers.ts';
import {
  createAcceptedBooking,
  schedulingServiceFor,
  truncateSchedulingTables,
} from './scheduling-helpers.ts';
import { adminSession } from './settlement-helpers.ts';

const MINUTES = 60_000;
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
  ctx = await createTestContext({ logDestination, logLevel: 'trace' });
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
  logLines.length = 0;
});

/** Buchung mit geplantem Übergabetermin (Default: in 3 Tagen) – liefert Termin-IDs. */
async function bookingWithAppointment(
  adminId: string,
  options: { fulfillment?: 'pickup' | 'delivery'; startAt?: Date; machineQuantity?: number } = {},
) {
  const booking = await createAcceptedBooking(ctx, adminId, {
    fulfillment: options.fulfillment ?? 'pickup',
    ...(options.machineQuantity === undefined ? {} : { machineQuantity: options.machineQuantity }),
  });
  const scheduling = schedulingServiceFor(ctx);
  await scheduling.ensureAppointmentsForBooking(booking.bookingId);
  const rows = await ctx.db
    .select()
    .from(appointments)
    .where(eq(appointments.bookingId, booking.bookingId));
  const outbound = rows.find((row) => row.kind === 'pickup' || row.kind === 'delivery')!;
  const startAt = options.startAt ?? new Date(Date.now() + 3 * DAYS);
  await scheduling.reschedule(adminId, outbound.id, {
    startAt,
    endAt: null,
    expectedVersion: outbound.version,
  });
  const processRow = (
    await ctx.db.select().from(processes).where(eq(processes.id, booking.processId))
  )[0]!;
  return { ...booking, appointmentId: outbound.id, startAt, scheduling, processRow };
}

async function issueFor(
  w: Awaited<ReturnType<typeof bookingWithAppointment>>,
  purpose: 'pickup_contact_update' | 'delivery_contact_update' = 'pickup_contact_update',
  service = ctx.scan.actionLinks,
) {
  return service.issue({
    purpose,
    processId: w.processId,
    customerId: w.customerId,
    bookingId: w.bookingId,
    appointmentId: w.appointmentId,
    expiresAt: new Date(w.startAt.getTime() - ACTION_LINK_CUTOFF_MS),
  });
}

const getAction = (token: string) =>
  ctx.app.inject({ method: 'GET', url: `/public/actions/${token}` });
const postAction = (token: string, payload: unknown) =>
  ctx.app.inject({ method: 'POST', url: `/public/actions/${token}`, payload: payload as object });

const VALID_BODY = { firstName: 'Erika', lastName: 'Abholer', phone: '0176 1234567' };

async function contactsOf(bookingId: string) {
  return ctx.db
    .select()
    .from(bookingCustomerContacts)
    .where(eq(bookingCustomerContacts.bookingId, bookingId));
}

/** Alle Text-/JSON-Spalten nach einem Klartext durchsuchen (nur Test). */
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

describe('54.–57. Token-Hash, kein Log, Booking-Bindung, neutrale Antworten', () => {
  it('54. Token: 32 zufällige Bytes base64url; in der DB nur der SHA-256-Hash; erneute Ausgabe widerruft den alten', async () => {
    const { admin } = await adminSession(ctx);
    const w = await bookingWithAppointment(admin.id);
    const first = await issueFor(w);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await ctx.db.select().from(customerActionTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashActionToken(first.token));
    expect(rows[0]!.tokenHash).not.toContain(first.token);
    expect(await tablesContaining(first.token)).toEqual([]);
    expect((await getAction(first.token)).statusCode).toBe(200);

    const second = await issueFor(w);
    expect(second.token).not.toBe(first.token);
    const all = await ctx.db.select().from(customerActionTokens);
    expect(all.filter((r) => r.revokedAt === null)).toHaveLength(1);
    expect((await getAction(first.token)).statusCode).toBe(404);
    expect((await getAction(second.token)).statusCode).toBe(200);
  });

  it('55. Kein Token im Serverlog: Pfad wird maskiert, auch bei 404/400/POST', async () => {
    const { admin } = await adminSession(ctx);
    const w = await bookingWithAppointment(admin.id);
    const { token } = await issueFor(w);
    expect(maskLoggedPath(`/public/actions/${token}`)).toBe('/public/actions/***');
    expect(maskLoggedPath(`/public/actions/${token}?x=1`)).toBe('/public/actions/***');
    await getAction(token);
    await postAction(token, VALID_BODY);
    await postAction(token, { firstName: '' });
    await getAction('unbekannt-token-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ');
    expect(logText()).not.toContain(token);
    expect(logText()).not.toContain('unbekannt-token-ZZZZ');
    expect(logText()).toContain('/public/actions/***');
  });

  it('56. Booking-Bindung: der Link liest und schreibt nur die eigene Buchung', async () => {
    const { admin } = await adminSession(ctx);
    const a = await bookingWithAppointment(admin.id);
    const b = await bookingWithAppointment(admin.id);
    const { token } = await issueFor(a);
    const view = await getAction(token);
    expect(view.json().action.processNumber).toBe(a.processRow.processNumber);
    expect(view.json().action.processNumber).not.toBe(b.processRow.processNumber);
    const submitted = await postAction(token, VALID_BODY);
    expect(submitted.statusCode).toBe(200);
    expect(await contactsOf(a.bookingId)).toHaveLength(1);
    expect(await contactsOf(b.bookingId)).toHaveLength(0);
  });

  it('57. Neutral: unbekannt, syntaktisch ungültig, widerrufen, abgelaufen, falscher Zweck ⇒ identisches 404 (kein Orakel)', async () => {
    const { admin } = await adminSession(ctx);
    const w = await bookingWithAppointment(admin.id);
    const issued = await issueFor(w);
    const revoked = await issueFor(w); // widerruft `issued`
    const expired = await ctx.scan.actionLinks.issue({
      purpose: 'pickup_contact_update',
      processId: w.processId,
      customerId: w.customerId,
      bookingId: w.bookingId,
      appointmentId: w.appointmentId,
      expiresAt: new Date(Date.now() - MINUTES),
    });
    const fresh = await issueFor(w);
    expect(revoked.tokenId).toBeTruthy();
    const unknownResponse = await getAction('A'.repeat(43));
    const bodies = new Set<string>();
    for (const token of [
      'A'.repeat(43),
      issued.token,
      expired.token,
      'x',
      'nicht.base64url!!',
      'a'.repeat(99), // Fastify maxParamLength (100) antwortet darüber mit 414 – noch vor der Route
    ]) {
      const response = await getAction(token);
      expect(response.statusCode).toBe(404);
      bodies.add(
        JSON.stringify({
          ...response.json(),
          error: { ...response.json().error, correlationId: null },
        }),
      );
      const post = await postAction(token, VALID_BODY);
      expect(post.statusCode).toBe(404);
    }
    expect(bodies.size).toBe(1);
    expect(unknownResponse.json().error.message).toBe('Dieser Link ist nicht verfügbar.');
    // Falscher Zweck (Service-Ebene): Pickup-Token gegen delivery_contact_update ⇒ null.
    expect(await ctx.scan.actionLinks.resolve(fresh.token, 'delivery_contact_update')).toBeNull();
    expect(await ctx.scan.actionLinks.resolve(fresh.token, 'pickup_contact_update')).not.toBeNull();
    expect(await contactsOf(w.bookingId)).toHaveLength(0);
  });
});

describe('58.–60. Ablauf/Cutoff, Pflichtfelder, Überschreiben', () => {
  it('58. Cutoff exakt 1 h vor Terminbeginn – serverseitig, auch bei gültigem Token; Vorziehen des Termins wirkt sofort', async () => {
    const { admin } = await adminSession(ctx);
    const startAt = new Date('2027-05-10T08:00:00.000Z');
    const w = await bookingWithAppointment(admin.id, { startAt });
    let now = new Date(startAt.getTime() - 2 * HOURS);
    const service = new CustomerActionLinkService(ctx.db, () => now);
    const { token } = await issueFor(w, 'pickup_contact_update', service);
    expect(await service.resolve(token)).not.toBeNull();
    now = new Date(startAt.getTime() - ACTION_LINK_CUTOFF_MS - 1000);
    expect(await service.resolve(token)).not.toBeNull();
    expect(await service.submit(token, VALID_BODY)).not.toBeNull();
    now = new Date(startAt.getTime() - ACTION_LINK_CUTOFF_MS);
    expect(await service.resolve(token)).toBeNull();
    expect(await service.submit(token, VALID_BODY)).toBeNull();
    now = new Date(startAt.getTime() + HOURS);
    expect(await service.resolve(token)).toBeNull();

    // Termin wird nach vorn verschoben: Cutoff folgt dem AKTUELLEN Beginn.
    now = new Date(startAt.getTime() - 3 * HOURS);
    const early = await issueFor(w, 'pickup_contact_update', service);
    expect(await service.resolve(early.token)).not.toBeNull();
    const version = (await w.scheduling.byId(w.appointmentId)).version;
    await w.scheduling.reschedule(admin.id, w.appointmentId, {
      startAt: new Date(now.getTime() + 30 * MINUTES),
      endAt: null,
      expectedVersion: version,
    });
    expect(await service.resolve(early.token)).toBeNull();
  });

  it('59. Pflichtfelder: Vor-/Nachname 1–80 Zeichen, Telefon 6–20 Ziffern (normalisiert) – Fehler blockieren, Link bleibt gültig', async () => {
    const { admin } = await adminSession(ctx);
    const w = await bookingWithAppointment(admin.id);
    const { token } = await issueFor(w);
    const invalid = [
      { lastName: 'Abholer', phone: '0176 1234567' },
      { firstName: '', lastName: 'Abholer', phone: '0176 1234567' },
      { firstName: 'E'.repeat(81), lastName: 'Abholer', phone: '0176 1234567' },
      { firstName: 'Erika', lastName: 'Abholer' },
      { firstName: 'Erika', lastName: 'Abholer', phone: '12345' },
      { firstName: 'Erika', lastName: 'Abholer', phone: '0'.repeat(25) },
      { firstName: 'Erika', lastName: 'Abholer', phone: 'keine nummer' },
      { firstName: 'Erika\nBcc: x@y', lastName: 'Abholer', phone: '0176 1234567' },
    ];
    for (const body of invalid) {
      const response = await postAction(token, body);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION');
    }
    expect(await contactsOf(w.bookingId)).toHaveLength(0);
    const ok = await postAction(token, {
      firstName: ' Erika ',
      lastName: 'Abholer',
      phone: '+49 (176) 123-4567',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().action.current).toEqual({
      firstName: 'Erika',
      lastName: 'Abholer',
      phone: '+491761234567',
    });
  });

  it('60. Überschreiben: ein aktueller Kontakt je Buchung und Art – die Änderung ersetzt den Stand vollständig', async () => {
    const { admin } = await adminSession(ctx);
    const w = await bookingWithAppointment(admin.id);
    const { token } = await issueFor(w);
    await postAction(token, VALID_BODY);
    const second = await postAction(token, {
      firstName: 'Max',
      lastName: 'Neu',
      phone: '06131 998877',
    });
    expect(second.statusCode).toBe(200);
    const rows = await contactsOf(w.bookingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'pickup',
      firstName: 'Max',
      lastName: 'Neu',
      phone: '+496131998877',
    });
    const view = await getAction(token);
    expect(view.json().action.current).toEqual({
      firstName: 'Max',
      lastName: 'Neu',
      phone: '+496131998877',
    });
    const tokenRow = (await ctx.db.select().from(customerActionTokens))[0]!;
    expect(tokenRow.useCount).toBe(2);
    expect(tokenRow.lastUsedAt).not.toBeNull();
  });
});

describe('61.–65. Alle Maschinen, Phone-Löschung, Trennung, Storno', () => {
  it('61. Alle Maschinen: der Kontakt gilt für die gesamte Buchung (eine Zeile, unabhängig von der Maschinenzahl)', async () => {
    const { admin } = await adminSession(ctx);
    const w = await bookingWithAppointment(admin.id, { machineQuantity: 2 });
    const { token } = await issueFor(w);
    await postAction(token, VALID_BODY);
    const rows = await contactsOf(w.bookingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bookingId).toBe(w.bookingId);
    const appointmentRows = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.bookingId, w.bookingId));
    expect(appointmentRows.filter((r) => r.kind === 'pickup')).toHaveLength(1);
  });

  it('62. Phone-Löschung: die alte Telefonnummer wird vollständig überschrieben und ist nirgends mehr gespeichert', async () => {
    const { admin } = await adminSession(ctx);
    const w = await bookingWithAppointment(admin.id);
    const { token } = await issueFor(w);
    const oldPhone = '0170 55566677';
    await postAction(token, { ...VALID_BODY, phone: oldPhone });
    expect((await tablesContaining('49170555666')).length).toBeGreaterThan(0);
    await postAction(token, { ...VALID_BODY, phone: '0151 44433322' });
    expect(await tablesContaining('49170555666')).toEqual([]);
    expect(await tablesContaining('55566677')).toEqual([]);
    expect(logText()).not.toContain('55566677');
    const rows = await contactsOf(w.bookingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.phone).toBe('+4915144433322');
  });

  it('63. Pickup/Delivery-Trennung: ein Pickup-Token ändert nie den Lieferkontakt (und umgekehrt)', async () => {
    const { admin } = await adminSession(ctx);
    const pickup = await bookingWithAppointment(admin.id, { fulfillment: 'pickup' });
    const delivery = await bookingWithAppointment(admin.id, { fulfillment: 'delivery' });
    const pickupToken = (await issueFor(pickup, 'pickup_contact_update')).token;
    const deliveryToken = (await issueFor(delivery, 'delivery_contact_update')).token;
    expect((await getAction(pickupToken)).json().action.purpose).toBe('pickup_contact_update');
    expect((await getAction(deliveryToken)).json().action.purpose).toBe('delivery_contact_update');
    await postAction(pickupToken, VALID_BODY);
    await postAction(deliveryToken, {
      firstName: 'Lina',
      lastName: 'VorOrt',
      phone: '0160 1112223',
    });
    const pickupRows = await contactsOf(pickup.bookingId);
    const deliveryRows = await contactsOf(delivery.bookingId);
    expect(pickupRows.map((r) => r.kind)).toEqual(['pickup']);
    expect(deliveryRows.map((r) => r.kind)).toEqual(['delivery']);
    // Zweck ist Teil der Auflösung: Pickup-Token als Lieferkontakt-Link ⇒ unbrauchbar.
    expect(
      await ctx.scan.actionLinks.submit(pickupToken, VALID_BODY, 'delivery_contact_update'),
    ).toBeNull();
    expect(
      await ctx.scan.actionLinks.submit(deliveryToken, VALID_BODY, 'pickup_contact_update'),
    ).toBeNull();
    expect((await contactsOf(pickup.bookingId)).map((r) => r.kind)).toEqual(['pickup']);
    expect((await contactsOf(delivery.bookingId)).map((r) => r.kind)).toEqual(['delivery']);
  });

  it('64. Storno: stornierter Termin oder Vorgang ⇒ Link neutral unbrauchbar', async () => {
    const { admin } = await adminSession(ctx);
    const w = await bookingWithAppointment(admin.id);
    const { token } = await issueFor(w);
    expect((await getAction(token)).statusCode).toBe(200);
    await ctx.db.transaction(async (tx) => {
      await w.scheduling.cancelForProcessWithin(tx, w.processId, new Date());
    });
    expect((await getAction(token)).statusCode).toBe(404);
    expect((await postAction(token, VALID_BODY)).statusCode).toBe(404);

    const v = await bookingWithAppointment(admin.id);
    const second = await issueFor(v);
    await ctx.db
      .update(processes)
      .set({ mainStatus: 'cancelled', cancelledAt: new Date() })
      .where(eq(processes.id, v.processId));
    expect((await getAction(second.token)).statusCode).toBe(404);
  });

  it('65. Datenminimierung: die öffentliche Antwort enthält nur Zweck, Vorgangsnummer, Termin und den aktuellen Kontakt', async () => {
    const { admin } = await adminSession(ctx);
    const w = await bookingWithAppointment(admin.id);
    const { token } = await issueFor(w);
    const response = await getAction(token);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    const action = response.json().action;
    expect(Object.keys(action).sort()).toEqual(
      ['appointmentAt', 'appointmentEndAt', 'current', 'processNumber', 'purpose'].sort(),
    );
    expect(action.current).toBeNull();
    expect(action.appointmentAt).toBe(w.startAt.toISOString());
    const raw = response.body;
    expect(raw).not.toContain('klara.kommerz@test.example');
    expect(raw).not.toContain('Kommerz');
    expect(raw).not.toContain('9998877');
    expect(raw).not.toContain(w.customerId);
    expect(raw).not.toContain(w.bookingId);
  });
});

describe('66.–68. Rate-Limit, Staff-Sicht, Rechte', () => {
  it('66. Rate-Limit: öffentliche Aktionsrouten sind IP-limitiert (POST 10/min)', async () => {
    const limited = await createTestContext({ rateLimitEnabled: true });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        const response = await limited.app.inject({
          method: 'POST',
          url: `/public/actions/${'B'.repeat(43)}`,
          payload: VALID_BODY,
        });
        statuses.push(response.statusCode);
      }
      expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
      expect(statuses[10]).toBe(429);
    } finally {
      await destroyTestContext(limited);
    }
  });

  it('67. Staff sieht den vom Kunden gepflegten Kontakt im Vorgang (process.view_all + Sichtbarkeit)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const w = await bookingWithAppointment(admin.id);
    const { token } = await issueFor(w);
    await postAction(token, VALID_BODY);
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${w.processId}/customer-contacts`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().contacts).toHaveLength(1);
    expect(response.json().contacts[0]).toMatchObject({
      kind: 'pickup',
      firstName: 'Erika',
      lastName: 'Abholer',
      phone: '+491761234567',
    });
    expect(response.body).not.toContain(token);
  });

  it('68. Rechte: ohne process.view_all 403; unsichtbarer Vorgang neutral 404; Token-Hash nie in Staff-Antworten', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const w = await bookingWithAppointment(admin.id);
    const { token } = await issueFor(w);
    await postAction(token, VALID_BODY);
    const staff = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Ohne',
      lastName: 'Recht',
      email: 'ohne-recht@test.example',
      password: 'ohne-recht-passwort-123',
      permissionKeys: [],
    });
    const forbidden = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${w.processId}/customer-contacts`,
      headers: { cookie: staff.cookie },
    });
    expect(forbidden.statusCode).toBe(403);
    const unknown = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/00000000-0000-4000-8000-000000000000/customer-contacts`,
      headers: { cookie },
    });
    expect(unknown.statusCode).toBe(404);
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${w.processId}/customer-contacts`,
    });
    expect(anonymous.statusCode).toBe(401);
    const ok = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${w.processId}/customer-contacts`,
      headers: { cookie },
    });
    expect(ok.body).not.toContain(hashActionToken(token));
    expect(admin.id).toBeTruthy();
    const employee = await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Z',
      lastName: 'Z',
      email: 'z@test.example',
      password: 'zzzz-passwort-123456',
    });
    expect((await login(ctx.app, 'z@test.example', 'zzzz-passwort-123456')).statusCode).toBe(200);
    expect(employee.id).toBeTruthy();
  });
});
