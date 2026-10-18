/**
 * Phase 12 – ICS (Pflichttests 150–171): privater Kalender-Feed je
 * Mitarbeiter – erzeugen, nur Hash in DB, Regenerate, ungültiger Token,
 * kein Token im Log, parsebar, UID/SEQUENCE, nur eigene effektive Termine,
 * Vertretung, keine Fremd-/Finanzdaten/Telefon/Preise/Namen, App-Link,
 * Europe/Berlin, read-only, Cross-User.
 */
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { appointments, calendarFeedTokens } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { maskLoggedPath } from '../src/app.ts';
import { unfoldIcs } from '../src/communication/calendar/ics.ts';
import { setStaffAppBaseUrl } from '../src/crm/settings-service.ts';
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
import { truncateCommerceTables } from './commerce-helpers.ts';
import { DAYS, HOURS } from './handover-helpers.ts';
import {
  createAcceptedBooking,
  schedulingServiceFor,
  substitutionServiceFor,
  truncateSchedulingTables,
} from './scheduling-helpers.ts';

let ctx: TestContext;
const logChunks: string[] = [];
const logDestination = new Writable({
  write(chunk, _encoding, callback) {
    logChunks.push(String(chunk));
    callback();
  },
});
const logText = () => logChunks.join('');

beforeAll(async () => {
  ctx = await createTestContext({ logDestination, logLevel: 'trace' });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await ctx.pool.query('TRUNCATE calendar_feed_tokens, push_deliveries, integration_jobs CASCADE');
  await truncateSchedulingTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
  logChunks.length = 0;
});

// Phase 12 Härtung (B16): Link-Form über den Staff-Proxy (/api wird dort abgestreift).
const TOKEN_PATH = /^\/api\/public\/calendar\/([A-Za-z0-9_-]{43})\.ics$/;

async function adminSession() {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  return { admin, cookie: session.cookie };
}

async function employee(
  adminId: string,
  name: string,
  permissionKeys: string[] = ['calendar.view'],
) {
  return createStaffWithPermissions(ctx, adminId, {
    firstName: name,
    lastName: 'Kalender',
    email: `${name.toLowerCase()}@test.example`,
    password: `${name.toLowerCase()}-passwort-1234`,
    permissionKeys: permissionKeys as never,
  });
}

async function createFeed(cookie: string) {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/staff/calendar/feed',
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { url: string; absolute: boolean; hint: string | null };
  const match = TOKEN_PATH.exec(body.url.replace(/^https?:\/\/[^/]+/, ''));
  expect(match).not.toBeNull();
  return { ...body, token: match![1]!, path: `/public/calendar/${match![1]!}.ics` };
}

async function fetchFeed(path: string) {
  return ctx.app.inject({ method: 'GET', url: path });
}

async function bookingFor(adminId: string, assigneeId: string, startAt: Date) {
  const world = await createAcceptedBooking(ctx, adminId, { assignProcessTo: assigneeId });
  const scheduling = schedulingServiceFor(ctx);
  await scheduling.ensureAppointmentsForBooking(world.bookingId);
  const rows = await ctx.db
    .select()
    .from(appointments)
    .where(eq(appointments.bookingId, world.bookingId));
  const pickup = rows.find((row) => row.kind === 'pickup')!;
  await scheduling.reschedule(adminId, pickup.id, {
    startAt,
    endAt: null,
    expectedVersion: pickup.version,
  });
  return { ...world, pickupId: pickup.id, returnId: rows.find((r) => r.kind === 'return')!.id };
}

describe('150.–154. Feed erzeugen, Hash, Regenerate, ungültig, kein Log', () => {
  it('150. Feed erzeugen liefert einmalig eine URL (relativ ohne Basis-URL, absolut mit) + Status ohne Token', async () => {
    const { admin, cookie } = await adminSession();
    const first = await createFeed(cookie);
    expect(first.absolute).toBe(false);
    expect(first.url).toBe(`/api${first.path}`);
    expect(first.hint).toMatch(/Basis-URL/);
    const status = await ctx.app.inject({
      method: 'GET',
      url: '/staff/calendar/feed',
      headers: { cookie },
    });
    expect(status.json()).toMatchObject({ configured: true, regeneratedAt: null });
    expect(status.body).not.toContain(first.token);

    await setStaffAppBaseUrl(ctx.db, admin.id, 'https://staff.example.de/');
    const second = await createFeed(cookie);
    expect(second.absolute).toBe(true);
    expect(second.url).toBe(`https://staff.example.de/api${second.path}`);
    expect(second.hint).toBeNull();
  });

  it('151. In der Datenbank liegt nur der SHA-256-Hash, nie der Token', async () => {
    const { admin, cookie } = await adminSession();
    const feed = await createFeed(cookie);
    const rows = await ctx.db.select().from(calendarFeedTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(admin.id);
    expect(rows[0]!.tokenHash).toBe(createHash('sha256').update(feed.token).digest('hex'));
    expect(JSON.stringify(rows)).not.toContain(feed.token);
    expect(Buffer.from(feed.token, 'base64url')).toHaveLength(32);
  });

  it('152. Regenerate ersetzt den Hash – der alte Link ist sofort ungültig, der neue gültig', async () => {
    const { cookie } = await adminSession();
    const first = await createFeed(cookie);
    expect((await fetchFeed(first.path)).statusCode).toBe(200);
    const second = await createFeed(cookie);
    expect(second.token).not.toBe(first.token);
    expect((await fetchFeed(first.path)).statusCode).toBe(404);
    expect((await fetchFeed(second.path)).statusCode).toBe(200);
    const rows = await ctx.db.select().from(calendarFeedTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.regeneratedAt).not.toBeNull();
    expect(rows[0]!.lastAccessAt).not.toBeNull();
  });

  it('153. Ungültige/unbekannte/fehlerhafte Tokens ⇒ neutrales 404 (keine Unterscheidung)', async () => {
    const { cookie } = await adminSession();
    await createFeed(cookie);
    const unknown = await fetchFeed(`/public/calendar/${'A'.repeat(43)}.ics`);
    const malformed = await fetchFeed('/public/calendar/kurz.ics');
    const noSuffix = await fetchFeed(`/public/calendar/${'A'.repeat(43)}`);
    for (const response of [unknown, malformed, noSuffix]) {
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    }
    expect(unknown.json().error.message).toBe(malformed.json().error.message);
  });

  it('154. Der Token erscheint nie im Serverlog (Pfad maskiert)', async () => {
    const { cookie } = await adminSession();
    const feed = await createFeed(cookie);
    await fetchFeed(feed.path);
    await fetchFeed(`/public/calendar/${'B'.repeat(43)}.ics`);
    const log = logText();
    expect(log).toContain('/public/calendar/***');
    expect(log).not.toContain(feed.token);
    expect(log).not.toContain('B'.repeat(43));
    expect(maskLoggedPath(`/public/calendar/${feed.token}.ics?x=1`)).toBe('/public/calendar/***');
  });

  it('154b. Deaktivierter Mitarbeiter: Feed antwortet 404', async () => {
    const { admin } = await adminSession();
    const anna = await employee(admin.id, 'Anna');
    const feed = await createFeed(anna.cookie);
    expect((await fetchFeed(feed.path)).statusCode).toBe(200);
    await ctx.admin.setUserStatus(admin.id, anna.user.id, 'disabled');
    expect((await fetchFeed(feed.path)).statusCode).toBe(404);
  });
});

describe('155.–161. Inhalt: parsebar, UID/SEQUENCE, eigene Termine, Vertretung, Datenminimierung, Link, Berlin', () => {
  it('155./161. Feed ist RFC-5545-konform: CRLF, ≤ 75 Oktette, VTIMEZONE Europe/Berlin, Header/Content-Type', async () => {
    const { admin, cookie } = await adminSession();
    await bookingFor(admin.id, admin.id, new Date(Date.now() + 2 * DAYS));
    const feed = await createFeed(cookie);
    const response = await fetchFeed(feed.path);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(response.headers['cache-control']).toBe('private, no-store');
    const text = response.body;
    expect(text.endsWith('\r\n')).toBe(true);
    const encoder = new TextEncoder();
    for (const raw of text.split('\r\n')) {
      expect(raw.includes('\n')).toBe(false);
      expect(encoder.encode(raw).length).toBeLessThanOrEqual(75);
    }
    const lines = unfoldIcs(text);
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines.at(-1)).toBe('END:VCALENDAR');
    expect(lines).toContain('VERSION:2.0');
    expect(lines).toContain('PRODID:-//Miet-Royal//Staff Calendar//DE');
    expect(lines).toContain('METHOD:PUBLISH');
    expect(lines).toContain('TZID:Europe/Berlin');
    expect(lines).toContain('X-WR-CALNAME:Miet-Royal – Anna Admin');
    expect(lines.filter((line) => line === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(lines.some((line) => line.startsWith('DTSTART;TZID=Europe/Berlin:'))).toBe(true);
    expect(lines.some((line) => line.startsWith('DTEND;TZID=Europe/Berlin:'))).toBe(true);
    expect(lines.some((line) => line.startsWith('BEGIN:VALARM'))).toBe(false);
    expect(lines.some((line) => line.startsWith('LOCATION'))).toBe(false);
  });

  it('156. UID = Termin-ID, SEQUENCE = Terminversion − 1; Reschedule erhöht SEQUENCE bei gleicher UID', async () => {
    const { admin, cookie } = await adminSession();
    const world = await bookingFor(admin.id, admin.id, new Date(Date.now() + 2 * DAYS));
    const feed = await createFeed(cookie);
    const before = unfoldIcs((await fetchFeed(feed.path)).body);
    expect(before).toContain(`UID:${world.pickupId}@miet-royal`);
    const row = (
      await ctx.db.select().from(appointments).where(eq(appointments.id, world.pickupId))
    )[0]!;
    expect(before).toContain(`SEQUENCE:${row.version - 1}`);
    await schedulingServiceFor(ctx).reschedule(admin.id, world.pickupId, {
      startAt: new Date(Date.now() + 3 * DAYS),
      endAt: null,
      expectedVersion: row.version,
    });
    const after = unfoldIcs((await fetchFeed(feed.path)).body);
    expect(after).toContain(`UID:${world.pickupId}@miet-royal`);
    expect(after).toContain(`SEQUENCE:${row.version}`);
    expect(after.filter((line) => line.startsWith('UID:'))).toHaveLength(1);
  });

  it('157./163. Nur eigene effektive Termine; ungeplante nicht; fremde Feeds zeigen fremde Termine nicht', async () => {
    const { admin, cookie: adminCookie } = await adminSession();
    const anna = await employee(admin.id, 'Anna');
    const bernd = await employee(admin.id, 'Bernd');
    const annaWorld = await bookingFor(admin.id, anna.user.id, new Date(Date.now() + 2 * DAYS));
    const berndWorld = await bookingFor(admin.id, bernd.user.id, new Date(Date.now() + 4 * DAYS));
    const annaFeed = await createFeed(anna.cookie);
    const berndFeed = await createFeed(bernd.cookie);
    const adminFeed = await createFeed(adminCookie);
    const annaLines = unfoldIcs((await fetchFeed(annaFeed.path)).body);
    expect(annaLines).toContain(`UID:${annaWorld.pickupId}@miet-royal`);
    expect(annaLines).not.toContain(`UID:${berndWorld.pickupId}@miet-royal`);
    // Rückgabe ohne Zeit (ungeplant) erscheint nicht.
    expect(annaLines).not.toContain(`UID:${annaWorld.returnId}@miet-royal`);
    const berndLines = unfoldIcs((await fetchFeed(berndFeed.path)).body);
    expect(berndLines).toContain(`UID:${berndWorld.pickupId}@miet-royal`);
    expect(berndLines).not.toContain(`UID:${annaWorld.pickupId}@miet-royal`);
    // Admin ohne eigene Termine: leerer Kalender, auch mit calendar.view_all (Feed = Person, nicht Rolle).
    const adminLines = unfoldIcs((await fetchFeed(adminFeed.path)).body);
    expect(adminLines.filter((line) => line === 'BEGIN:VEVENT')).toHaveLength(0);
  });

  it('158. Vertretung: Vertreter sieht den Termin, Original nicht (im Vertretungszeitraum)', async () => {
    const { admin } = await adminSession();
    const anna = await employee(admin.id, 'Anna');
    const bernd = await employee(admin.id, 'Bernd');
    const world = await bookingFor(admin.id, anna.user.id, new Date(Date.now() + 2 * DAYS));
    await substitutionServiceFor(ctx).create(admin.id, {
      originalUserId: anna.user.id,
      substituteUserId: bernd.user.id,
      startsAt: new Date(Date.now() - 1 * HOURS),
      endsAt: new Date(Date.now() + 5 * DAYS),
    });
    const annaFeed = await createFeed(anna.cookie);
    const berndFeed = await createFeed(bernd.cookie);
    expect(unfoldIcs((await fetchFeed(berndFeed.path)).body)).toContain(
      `UID:${world.pickupId}@miet-royal`,
    );
    expect(unfoldIcs((await fetchFeed(annaFeed.path)).body)).not.toContain(
      `UID:${world.pickupId}@miet-royal`,
    );
  });

  it('159./160. Keine Kundennamen/Telefon/Adresse/Preise – nur Terminart, Vorgangsnummer und Staff-Link', async () => {
    const { admin, cookie } = await adminSession();
    await setStaffAppBaseUrl(ctx.db, admin.id, 'https://staff.example.de');
    const world = await bookingFor(admin.id, admin.id, new Date(Date.now() + 2 * DAYS));
    const feed = await createFeed(cookie);
    const text = (await fetchFeed(feed.path)).body;
    for (const forbidden of [
      'Klara',
      'Kommerz',
      'klara.kommerz',
      '9998877',
      'Lieferweg',
      'Mainz',
      '€',
      'EUR',
      'Preis',
      'Schaden',
      'Notiz',
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    const lines = unfoldIcs(text);
    const summary = lines.find((line) => line.startsWith('SUMMARY:'))!;
    expect(summary).toMatch(/^SUMMARY:Miet-Royal – Abholung MR-\d{4}-\d{4}$/);
    const description = lines.find((line) => line.startsWith('DESCRIPTION:'))!;
    expect(description).toMatch(
      /^DESCRIPTION:Abholung MR-\d{4}-\d{4}\\nhttps:\/\/staff\.example\.de\/vorgaenge\//,
    );
    expect(description).toContain(`/vorgaenge/${world.processId}/termine`);
    expect(lines).toContain(`URL:https://staff.example.de/vorgaenge/${world.processId}/termine`);
  });
});

describe('162.–165. Read-only, Rechte, Cross-User', () => {
  it('162. Der öffentliche Feed ist read-only: PUT/POST/DELETE/PATCH ⇒ 404', async () => {
    const { cookie } = await adminSession();
    const feed = await createFeed(cookie);
    for (const method of ['PUT', 'POST', 'DELETE', 'PATCH'] as const) {
      const response = await ctx.app.inject({ method, url: feed.path, payload: {} });
      expect(response.statusCode, method).toBe(404);
    }
    expect((await fetchFeed(feed.path)).statusCode).toBe(200);
  });

  it('163b. Ohne calendar.view kein Feed (403); ohne Login 401', async () => {
    const { admin } = await adminSession();
    const none = await employee(admin.id, 'Ohne', []);
    const forbidden = await ctx.app.inject({
      method: 'POST',
      url: '/staff/calendar/feed',
      headers: { cookie: none.cookie },
    });
    expect(forbidden.statusCode).toBe(403);
    const anonymous = await ctx.app.inject({ method: 'POST', url: '/staff/calendar/feed' });
    expect(anonymous.statusCode).toBe(401);
    expect(await ctx.db.select().from(calendarFeedTokens)).toHaveLength(0);
  });

  it('164. Cross-User: Regenerate eines Users lässt fremde Feeds unberührt; ein Token je User', async () => {
    const { admin } = await adminSession();
    const anna = await employee(admin.id, 'Anna');
    const bernd = await employee(admin.id, 'Bernd');
    const annaFeed = await createFeed(anna.cookie);
    const berndFeed = await createFeed(bernd.cookie);
    await createFeed(anna.cookie); // Regenerate Anna
    expect((await fetchFeed(annaFeed.path)).statusCode).toBe(404);
    expect((await fetchFeed(berndFeed.path)).statusCode).toBe(200);
    const rows = await ctx.db.select().from(calendarFeedTokens);
    expect(rows.map((row) => row.userId).sort()).toEqual([anna.user.id, bernd.user.id].sort());
  });
});
