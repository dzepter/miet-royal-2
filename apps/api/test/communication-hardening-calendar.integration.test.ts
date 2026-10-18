/**
 * Phase 12 Härtung (Review B) – ICS-Feed: Regressionstests zu den Funden
 *  B12 Rechteentzug ⇒ bestehender Feed-Link liefert nichts mehr (neutral 404),
 *  B16 Feed-Link zeigt auf den Staff-Proxy `/api/public/calendar/<token>.ics`
 *      (die Staff-App leitet nur `/api/*` an die API weiter),
 * sowie der geprüfte Punkt ohne Fund OK-6 (TEXT-Escaping des Namens).
 */
import { Writable } from 'node:stream';
import { appointments, staffUsers } from '@mietroyal/database';
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
import { truncateCommerceTables } from './commerce-helpers.ts';
import { createStaffWithPermissions, truncateCrmTables } from './crm-helpers.ts';
import { DAYS } from './handover-helpers.ts';
import {
  createAcceptedBooking,
  schedulingServiceFor,
  truncateSchedulingTables,
} from './scheduling-helpers.ts';

let ctx: TestContext;
const logChunks: string[] = [];
const logDestination = new Writable({
  write(chunk: Buffer, _encoding, callback) {
    logChunks.push(chunk.toString('utf8'));
    callback();
  },
});

beforeAll(async () => {
  ctx = await createTestContext({ logDestination, logLevel: 'info' });
});
afterAll(async () => {
  await ctx.pool.query('TRUNCATE calendar_feed_tokens CASCADE');
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

/** Link-Form der Staff-App (Proxy-Präfix /api). */
const LINK_PATH = /^\/api\/public\/calendar\/([A-Za-z0-9_-]{43})\.ics$/;

interface FeedCreated {
  url: string;
  absolute: boolean;
  hint: string | null;
}

async function createFeedResponse(cookie: string): Promise<FeedCreated> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/staff/calendar/feed',
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as FeedCreated;
}

/**
 * Wendet die Rewrite-Regel der Staff-App (apps/staff/next.config.ts) auf den
 * Link an und liefert den Pfad, den die API tatsächlich erhält.
 */
async function apiPathBehindStaffProxy(link: string): Promise<string> {
  const { default: nextConfig } = await import('../../staff/next.config.ts');
  const rewrites = (await nextConfig.rewrites!()) as { source: string; destination: string }[];
  const path = link.replace(/^https?:\/\/[^/]+/, '');
  for (const rule of rewrites) {
    const prefix = rule.source.replace(/\/:path\*$/, '');
    if (!path.startsWith(`${prefix}/`)) continue;
    const destination = new URL(rule.destination.replace(':path*', path.slice(prefix.length + 1)));
    return destination.pathname;
  }
  throw new Error(`Staff-App leitet ${path} nicht an die API weiter`);
}

async function createFeed(cookie: string): Promise<string> {
  const created = await createFeedResponse(cookie);
  return apiPathBehindStaffProxy(created.url);
}

async function pickupFor(adminId: string, assigneeId: string, startAt: Date) {
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
  return pickup.id;
}

describe('Härtung Review B – ICS-Feed', () => {
  it('B16. Feed-Link lautet <Staff-Basis>/api/public/calendar/<token>.ics (relativ ohne Basis ebenfalls mit /api) und erreicht über den Staff-Proxy die API; Token in beiden Pfadformen maskiert', async () => {
    const admin = await bootstrapAdmin(ctx);
    const { cookie } = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    await pickupFor(admin.id, admin.id, new Date(Date.now() + 2 * DAYS));

    // Ohne Basis-URL: relativer Link mit Proxy-Präfix + Hinweis.
    const relative = await createFeedResponse(cookie);
    expect(relative.absolute).toBe(false);
    expect(relative.url).toMatch(LINK_PATH);
    expect(relative.hint).toMatch(/Basis-URL/);

    // Mit Basis-URL: absoluter Link auf die Staff-App, Pfad /api/public/calendar/….
    await setStaffAppBaseUrl(ctx.db, admin.id, 'https://staff.example.de/');
    const absolute = await createFeedResponse(cookie);
    expect(absolute.absolute).toBe(true);
    const url = new URL(absolute.url);
    expect(url.origin).toBe('https://staff.example.de');
    const token = LINK_PATH.exec(url.pathname)![1]!;

    // Der Staff-Proxy streift /api ab ⇒ die API erhält /public/calendar/<token>.ics ⇒ 200.
    const apiPath = await apiPathBehindStaffProxy(absolute.url);
    expect(apiPath).toBe(`/public/calendar/${token}.ics`);
    const feed = await ctx.app.inject({ method: 'GET', url: apiPath });
    expect(feed.statusCode).toBe(200);
    expect(feed.headers['content-type']).toContain('text/calendar');
    // Die alte (fehlerhafte) Link-Form wäre in der Staff-App nicht weitergeleitet worden.
    await expect(apiPathBehindStaffProxy(`/public/calendar/${token}.ics`)).rejects.toThrow(
      /nicht an die API weiter/,
    );

    // Token nie im Log – weder in der API-Form noch in der Proxy-Form.
    expect(logChunks.join('')).not.toContain(token);
    expect(maskLoggedPath(apiPath)).toBe('/public/calendar/***');
    expect(maskLoggedPath(`${url.pathname}?x=1`)).toBe('/api/public/calendar/***');
  });

  it('B12. Recht calendar.view entzogen ⇒ der bestehende Feed-Link antwortet sofort neutral 404 (wie ein unbekannter Token); erneute Vergabe ⇒ derselbe Link gilt wieder', async () => {
    const admin = await bootstrapAdmin(ctx);
    const emp = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Kai',
      lastName: 'Kalender',
      email: 'kai@test.example',
      password: 'kai-passwort-1234',
      permissionKeys: ['calendar.view'] as never,
    });
    const appointmentId = await pickupFor(admin.id, emp.user.id, new Date(Date.now() + 3 * DAYS));
    const path = await createFeed(emp.cookie);
    expect((await ctx.app.inject({ method: 'GET', url: path })).body).toContain(appointmentId);
    const roles = await ctx.pool.query<{ role_id: string }>(
      'SELECT role_id FROM staff_user_roles WHERE user_id = $1',
      [emp.user.id],
    );

    await ctx.admin.setUserRoles(admin.id, emp.user.id, []);
    const staffStatus = await ctx.app.inject({
      method: 'GET',
      url: '/staff/calendar/feed',
      headers: { cookie: emp.cookie },
    });
    expect(staffStatus.statusCode).toBe(403);
    const revoked = await ctx.app.inject({ method: 'GET', url: path });
    const unknown = await ctx.app.inject({
      method: 'GET',
      url: `/public/calendar/${'A'.repeat(43)}.ics`,
    });
    expect(revoked.statusCode).toBe(404);
    expect(revoked.body).not.toContain(appointmentId);
    expect(revoked.json().error.message).toBe(unknown.json().error.message);

    await ctx.admin.setUserRoles(
      admin.id,
      emp.user.id,
      roles.rows.map((row) => row.role_id),
    );
    const restored = await ctx.app.inject({ method: 'GET', url: path });
    expect(restored.statusCode).toBe(200);
    expect(restored.body).toContain(`UID:${appointmentId}@miet-royal`);
  });

  it('OK-6 (Review B, kein Fund): CRLF/Semikolon/Komma/Backslash im Mitarbeiternamen erzeugen keine neuen Properties (TEXT-Escaping)', async () => {
    const admin = await bootstrapAdmin(ctx);
    const { cookie } = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    await ctx.db
      .update(staffUsers)
      .set({
        firstName: 'Eve\r\nBEGIN:VEVENT\r\nUID:evil;X=1,2\\',
        lastName: 'X\nATTACH:http://evil',
      })
      .where(eq(staffUsers.id, admin.id));
    await pickupFor(admin.id, admin.id, new Date(Date.now() + 2 * DAYS));
    const path = await createFeed(cookie);
    const feed = await ctx.app.inject({ method: 'GET', url: path });
    expect(feed.statusCode).toBe(200);
    const lines = unfoldIcs(feed.body);
    expect(lines.filter((line) => line === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(lines.some((line) => line.startsWith('UID:evil'))).toBe(false);
    expect(lines.some((line) => line.startsWith('ATTACH'))).toBe(false);
    const name = lines.find((line) => line.startsWith('X-WR-CALNAME:'))!;
    expect(name).toContain('Eve\\nBEGIN:VEVENT\\nUID:evil\\;X=1\\,2\\\\');
  });
});
