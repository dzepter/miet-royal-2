/**
 * Phase 15 (AUTH) – Pflichttests Profil (Order §61, Design §1.6, Präfix „P“):
 * Profil aus der Session, Reauth-Frische, sessiongebundene Reauth-Links,
 * Stammdatenänderungen ohne Snapshot-Wirkung, verifizierter E-Mail-Wechsel.
 */
import {
  bookings,
  customerPortalMagicLinks,
  customerPortalSessions,
  customers,
  mailDeliveries,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PORTAL_REAUTH_FRESH_MS } from '../src/portal/auth/constants.ts';
import { PORTAL_MESSAGES } from '../src/portal/types.ts';
import { bootstrapAdmin, truncateAuthTables, type TestContext } from './auth-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { truncateCommunicationTables } from './communication-helpers.ts';
import { createTestCustomer, customerServiceFor, truncateCrmTables } from './crm-helpers.ts';
import {
  createPortalTestContext,
  destroyPortalTestContext,
  latestPortalMailToken,
  loginPortalCustomerSession,
  portalCookieName,
  requestMagicLink,
  truncatePortalTables,
  type PortalLogin,
  type PortalTestContext,
} from './portal-auth-helpers.ts';
import { createAcceptedBooking, truncateSchedulingTables } from './scheduling-helpers.ts';

const MINUTE = 60_000;
let ctx: PortalTestContext;

async function resetAll(context: TestContext): Promise<void> {
  await truncatePortalTables(context.pool);
  await truncateSchedulingTables(context.pool);
  await truncateCommunicationTables(context.pool);
  await truncateCrmTables(context.pool);
  await truncateAuthTables(context.pool);
  await truncateCommerceTables(context.pool); // nach dem Auth-Reset: stellt Seed-Preise wieder her
  context.mailGateway.reset();
}

beforeAll(async () => {
  ctx = await createPortalTestContext({
    env: { MAIL_PUBLIC_WEB_BASE_URL: 'https://web.test.example' },
  });
});
afterAll(async () => {
  await destroyPortalTestContext(ctx);
});
beforeEach(async () => {
  await resetAll(ctx);
});

async function privateCustomer(email = 'kunde@example.com') {
  const admin = await bootstrapAdmin(ctx);
  const customer = await createTestCustomer(ctx, admin.id, {
    email,
    firstName: 'Mia',
    lastName: 'Muster',
    phone: '06131 123456',
  });
  const session = await loginPortalCustomerSession(ctx, customer.id);
  return { admin, customer, session };
}

async function organizationCustomer(adminId: string, email = 'firma@example.com') {
  const { customer } = await customerServiceFor(ctx).createCustomer(adminId, {
    type: 'organization',
    organizationName: 'Beispiel GmbH',
    contactPerson: 'Olaf Orga',
    email,
  });
  const session = await loginPortalCustomerSession(ctx, customer.id);
  return { customer, session };
}

/** Reauth künstlich altern lassen (Testmanipulation der Session-Zeile). */
async function ageReauth(sessionId: string, ageMs: number) {
  await ctx.db
    .update(customerPortalSessions)
    .set({ reauthenticatedAt: new Date(Date.now() - ageMs) })
    .where(eq(customerPortalSessions.id, sessionId));
}

async function sessionRow(sessionId: string) {
  const rows = await ctx.db
    .select()
    .from(customerPortalSessions)
    .where(eq(customerPortalSessions.id, sessionId));
  return rows[0]!;
}

async function customerRow(customerId: string) {
  const rows = await ctx.db.select().from(customers).where(eq(customers.id, customerId));
  return rows[0]!;
}

const getProfile = (cookie: string) =>
  ctx.app.inject({ method: 'GET', url: '/portal/profile', headers: { cookie } });
const patchProfile = (cookie: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'PATCH', url: '/portal/profile', headers: { cookie }, payload });
const reauthRequest = (cookie: string) =>
  ctx.app.inject({ method: 'POST', url: '/portal/auth/reauth/request', headers: { cookie } });
const reauthConsume = (cookie: string, token: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/portal/auth/reauth/consume',
    headers: { cookie },
    payload: { token },
  });
const emailChangeRequest = (cookie: string, email: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/portal/auth/email-change/request',
    headers: { cookie },
    payload: { email },
  });
const emailChangeConsume = (token: string, cookie?: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/portal/auth/email-change/consume',
    headers: cookie === undefined ? {} : { cookie },
    payload: { token },
  });

async function reauthToken(): Promise<string> {
  const link = await latestPortalMailToken(ctx, 'customer_portal_reauth');
  if (link === null) throw new Error('kein Reauth-Link');
  return link.token;
}

async function emailChangeToken() {
  const link = await latestPortalMailToken(ctx, 'customer_portal_email_change');
  if (link === null) throw new Error('kein E-Mail-Wechsel-Link');
  return link;
}

describe('Profil lesen (Order §31)', () => {
  it('P1. GET /portal/profile liefert den eigenen Kunden (Session) als PortalProfileView mit Hinweis', async () => {
    const { session } = await privateCustomer();
    const response = await getProfile(session.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      type: 'private',
      firstName: 'Mia',
      lastName: 'Muster',
      organizationName: null,
      contactPerson: null,
      email: 'kunde@example.com',
      phone: '06131 123456',
      billingStreet: null,
      billingPostalCode: null,
      billingCity: null,
      billingCountry: null,
      vatId: null,
      department: null,
      costCenter: null,
      orderReference: null,
      hint: PORTAL_MESSAGES.PROFILE_HINT,
    });
    // Keine internen Schlüssel (IDs, phoneNormalized, deletedBy …).
    expect(Object.keys(response.json())).not.toContain('id');
    expect(JSON.stringify(response.json())).not.toContain('phoneNormalized');
    expect((await getProfile('')).statusCode).toBe(401);
  });

  it('P2. keine Customer-ID nötig oder erlaubt: customerId im Body ⇒ 400; zweiter Kunde sieht nur sich selbst', async () => {
    const { admin, session } = await privateCustomer();
    const other = await createTestCustomer(ctx, admin.id, {
      email: 'other@example.com',
      firstName: 'Otto',
      lastName: 'Other',
    });
    const otherSession = await loginPortalCustomerSession(ctx, other.id);
    expect((await getProfile(otherSession.cookie)).json().firstName).toBe('Otto');
    const forged = await patchProfile(session.cookie, { customerId: other.id, firstName: 'Hack' });
    expect(forged.statusCode).toBe(400);
    expect((await customerRow(other.id)).firstName).toBe('Otto');
  });
});

describe('Reauth (Order §32)', () => {
  it('P3. Mutation ohne frische Reauth ⇒ 403 PORTAL_REAUTH_REQUIRED (Profil und E-Mail-Wechsel); nichts geändert', async () => {
    const { customer, session } = await privateCustomer();
    await ageReauth(session.sessionId, PORTAL_REAUTH_FRESH_MS + MINUTE);
    const response = await patchProfile(session.cookie, { firstName: 'Neu' });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatchObject({
      code: 'PORTAL_REAUTH_REQUIRED',
      message: PORTAL_MESSAGES.REAUTH_REQUIRED,
    });
    expect((await customerRow(customer.id)).firstName).toBe('Mia');
    const change = await emailChangeRequest(session.cookie, 'neu@example.com');
    expect(change.statusCode).toBe(403);
    expect(change.json().error.code).toBe('PORTAL_REAUTH_REQUIRED');
    expect(await ctx.db.select().from(customerPortalMagicLinks)).toHaveLength(0);
    const meResponse = await ctx.app.inject({
      method: 'GET',
      url: '/portal/me',
      headers: { cookie: session.cookie },
    });
    expect(meResponse.json().session.reauthFresh).toBe(false);
  });

  it('P4. Reauth-Link (15 min, one-time) an die aktuelle Adresse macht die Mutation wieder möglich; abgelaufen ⇒ 401', async () => {
    const { customer, session } = await privateCustomer();
    await ageReauth(session.sessionId, PORTAL_REAUTH_FRESH_MS + MINUTE);
    const requested = await reauthRequest(session.cookie);
    expect(requested.statusCode).toBe(202);
    expect(requested.json()).toEqual({
      message: 'Wir haben dir einen Bestätigungslink geschickt.',
    });
    const link = await latestPortalMailToken(ctx, 'customer_portal_reauth');
    expect(link!.recipientEmail).toBe('kunde@example.com');
    const [row] = await ctx.db.select().from(customerPortalMagicLinks);
    expect(row).toMatchObject({
      purpose: 'reauth',
      sessionId: session.sessionId,
      customerId: customer.id,
    });
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(15 * MINUTE);

    const consumed = await reauthConsume(session.cookie, link!.token);
    expect(consumed.statusCode).toBe(200);
    expect(typeof consumed.json().reauthenticatedAt).toBe('string');
    const again = await reauthConsume(session.cookie, link!.token);
    expect(again.statusCode).toBe(401);
    expect(again.json().error.code).toBe('PORTAL_TOKEN_INVALID');

    const patched = await patchProfile(session.cookie, { firstName: 'Neu' });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().firstName).toBe('Neu');

    // Abgelaufener Reauth-Link.
    await ageReauth(session.sessionId, PORTAL_REAUTH_FRESH_MS + MINUTE);
    await reauthRequest(session.cookie);
    const expiredLink = await latestPortalMailToken(ctx, 'customer_portal_reauth');
    await ctx.db
      .update(customerPortalMagicLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(customerPortalMagicLinks.purpose, 'reauth'));
    expect((await reauthConsume(session.cookie, expiredLink!.token)).statusCode).toBe(401);
    expect((await patchProfile(session.cookie, { firstName: 'Nochmal' })).statusCode).toBe(403);
  });

  it('P5. Reauth-Link ist an die anfordernde Session gebunden: andere Session desselben Kunden ⇒ 401, Link bleibt für die eigene Session nutzbar', async () => {
    const { customer, session } = await privateCustomer();
    const second: PortalLogin = await loginPortalCustomerSession(ctx, customer.id);
    await ageReauth(session.sessionId, PORTAL_REAUTH_FRESH_MS + MINUTE);
    await ageReauth(second.sessionId, PORTAL_REAUTH_FRESH_MS + MINUTE);
    await reauthRequest(session.cookie);
    const token = await reauthToken();
    const foreign = await reauthConsume(second.cookie, token);
    expect(foreign.statusCode).toBe(401);
    expect(foreign.json().error.code).toBe('PORTAL_TOKEN_INVALID');
    expect((await patchProfile(second.cookie, { firstName: 'X' })).statusCode).toBe(403);
    expect((await reauthConsume(session.cookie, token)).statusCode).toBe(200);
    expect((await patchProfile(session.cookie, { firstName: 'Y' })).statusCode).toBe(200);
    // Ohne Session kein Reauth-Consume.
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/portal/auth/reauth/consume',
          payload: { token },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('P6./P7. Reauth setzt reauthenticated_at neu – expires_at, created_at und authenticated_at bleiben unverändert', async () => {
    const { session } = await privateCustomer();
    await ageReauth(session.sessionId, PORTAL_REAUTH_FRESH_MS + MINUTE);
    const before = await sessionRow(session.sessionId);
    await reauthRequest(session.cookie);
    const consumed = await reauthConsume(session.cookie, await reauthToken());
    expect(consumed.statusCode).toBe(200);
    const after = await sessionRow(session.sessionId);
    expect(after.reauthenticatedAt.getTime()).toBeGreaterThan(before.reauthenticatedAt.getTime());
    expect(after.reauthenticatedAt.toISOString()).toBe(consumed.json().reauthenticatedAt);
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
    expect(after.authenticatedAt.getTime()).toBe(before.authenticatedAt.getTime());
    // Neue Reauth-Anforderung widerruft den offenen Reauth-Link dieser Session.
    await reauthRequest(session.cookie);
    await reauthRequest(session.cookie);
    const links = await ctx.db.select().from(customerPortalMagicLinks);
    expect(
      links.filter((l) => l.purpose === 'reauth' && l.revokedAt === null && l.consumedAt === null),
    ).toHaveLength(1);
  });
});

describe('Stammdaten ändern (Order §33)', () => {
  it('P8. Name (privat) – Pflichtfelder bleiben Pflicht (leerer Nachname ⇒ 400)', async () => {
    const { customer, session } = await privateCustomer();
    const ok = await patchProfile(session.cookie, { firstName: ' Marie ', lastName: 'Musterfrau' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      firstName: 'Marie',
      lastName: 'Musterfrau',
      hint: PORTAL_MESSAGES.PROFILE_HINT,
    });
    expect((await customerRow(customer.id)).firstName).toBe('Marie');
    const empty = await patchProfile(session.cookie, { lastName: '' });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe('VALIDATION');
    expect((await customerRow(customer.id)).lastName).toBe('Musterfrau');
  });

  it('P9. Telefon mit CRM-Normalisierung (phone_normalized), leer ⇒ gelöscht', async () => {
    const { customer, session } = await privateCustomer();
    const ok = await patchProfile(session.cookie, { phone: '+49 6131 999 888' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().phone).toBe('+49 6131 999 888');
    const row = await customerRow(customer.id);
    expect(row.phoneNormalized).toBe('496131999888');
    const cleared = await patchProfile(session.cookie, { phone: '' });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().phone).toBeNull();
    expect((await customerRow(customer.id)).phoneNormalized).toBeNull();
  });

  it('P10. Rechnungsadresse (privat) und Organisationsfelder (Organisation); fremde Felder je Typ ⇒ 400', async () => {
    const { admin, session } = await privateCustomer();
    const address = await patchProfile(session.cookie, {
      billingStreet: 'Musterweg 3',
      billingPostalCode: '55116',
      billingCity: 'Mainz',
      billingCountry: 'DE',
    });
    expect(address.statusCode).toBe(200);
    expect(address.json()).toMatchObject({
      billingStreet: 'Musterweg 3',
      billingPostalCode: '55116',
      billingCity: 'Mainz',
      billingCountry: 'DE',
    });
    // Organisationsfelder sind für Privatkunden nicht erlaubt.
    expect((await patchProfile(session.cookie, { vatId: 'DE123' })).statusCode).toBe(400);
    expect((await patchProfile(session.cookie, { organizationName: 'X' })).statusCode).toBe(400);

    const org = await organizationCustomer(admin.id);
    const orgPatch = await patchProfile(org.session.cookie, {
      organizationName: 'Beispiel AG',
      contactPerson: 'Olga Orga',
      vatId: 'DE999999999',
      department: 'Einkauf',
      costCenter: 'KST-42',
      orderReference: 'PO-2026-7',
      phone: '06131 1',
      billingStreet: 'Industriestraße 9',
      billingPostalCode: '55120',
      billingCity: 'Mainz',
    });
    expect(orgPatch.statusCode).toBe(200);
    expect(orgPatch.json()).toMatchObject({
      type: 'organization',
      organizationName: 'Beispiel AG',
      contactPerson: 'Olga Orga',
      vatId: 'DE999999999',
      department: 'Einkauf',
      costCenter: 'KST-42',
      orderReference: 'PO-2026-7',
      firstName: null,
      lastName: null,
    });
    expect((await patchProfile(org.session.cookie, { firstName: 'Nein' })).statusCode).toBe(400);
    expect((await patchProfile(org.session.cookie, { organizationName: '' })).statusCode).toBe(400);
  });

  it('P11. Profiländerung lässt bookings.customer_snapshot der bestätigten Buchung unverändert', async () => {
    const admin = await bootstrapAdmin(ctx);
    const world = await createAcceptedBooking(ctx, admin.id);
    const [before] = await ctx.db.select().from(bookings).where(eq(bookings.id, world.bookingId));
    const session = await loginPortalCustomerSession(ctx, world.customerId);
    const patched = await patchProfile(session.cookie, {
      firstName: 'Geändert',
      lastName: 'Nachher',
      phone: '0171 0000000',
      billingStreet: 'Neue Straße 1',
      billingCity: 'Wiesbaden',
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().firstName).toBe('Geändert');
    const [after] = await ctx.db.select().from(bookings).where(eq(bookings.id, world.bookingId));
    expect(after!.customerSnapshot).toEqual(before!.customerSnapshot);
    expect(after!.eventSnapshot).toEqual(before!.eventSnapshot);
    expect(after!.totalsSnapshot).toEqual(before!.totalsSnapshot);
    expect(JSON.stringify(after!.customerSnapshot)).not.toContain('Geändert');
    expect((await customerRow(world.customerId)).firstName).toBe('Geändert');
  });

  it('P18. Customer.type ist nicht änderbar (400, Typ bleibt)', async () => {
    const { customer, session } = await privateCustomer();
    const response = await patchProfile(session.cookie, { type: 'organization' });
    expect(response.statusCode).toBe(400);
    expect((await customerRow(customer.id)).type).toBe('private');
  });

  it('P19. E-Mail ist über das Profil nicht änderbar und nie löschbar (400); E-Mail-Wechsel mit leerer Adresse ⇒ 400', async () => {
    const { customer, session } = await privateCustomer();
    expect((await patchProfile(session.cookie, { email: '' })).statusCode).toBe(400);
    expect((await patchProfile(session.cookie, { email: 'x@example.com' })).statusCode).toBe(400);
    const empty = await emailChangeRequest(session.cookie, '');
    expect(empty.statusCode).toBe(400);
    const invalid = await emailChangeRequest(session.cookie, 'ohne-at');
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('VALIDATION');
    const same = await emailChangeRequest(session.cookie, 'Kunde@example.com');
    expect(same.statusCode).toBe(400);
    expect(same.json().error.code).toBe('PORTAL_EMAIL_UNAVAILABLE');
    expect((await customerRow(customer.id)).email).toBe('kunde@example.com');
    expect(await ctx.db.select().from(customerPortalMagicLinks)).toHaveLength(0);
  });
});

describe('E-Mail-Wechsel (Order §34/§35)', () => {
  it('P12./P13. Link geht an die NEUE Adresse; bis zum Consume bleibt die alte Adresse aktiv (Login mit alter Mail möglich)', async () => {
    const { customer, session } = await privateCustomer();
    const requested = await emailChangeRequest(session.cookie, ' Neu@Example.com ');
    expect(requested.statusCode).toBe(202);
    expect(requested.json()).toEqual({
      message: 'Wir haben einen Bestätigungslink an die neue Adresse geschickt.',
    });
    const link = await emailChangeToken();
    expect(link.recipientEmail).toBe('neu@example.com');
    const [row] = await ctx.db.select().from(customerPortalMagicLinks);
    expect(row).toMatchObject({
      purpose: 'email_change',
      proposedEmail: 'neu@example.com',
      sessionId: session.sessionId,
      customerId: customer.id,
    });
    // Kontext/Audit ohne Adresse im Klartext (nur recipient_email der Zustellung).
    const [delivery] = await ctx.db.select().from(mailDeliveries);
    expect(JSON.stringify(delivery!.context)).not.toContain('neu@example.com');
    expect((await customerRow(customer.id)).email).toBe('kunde@example.com');
    const oldLogin = await requestMagicLink(ctx, 'kunde@example.com');
    expect(oldLogin.token).not.toBeNull();
    const newLogin = await requestMagicLink(ctx, 'neu@example.com');
    expect(newLogin.token).toBeNull();
    expect((await getProfile(session.cookie)).json().email).toBe('kunde@example.com');
  });

  it('P14./P16./P17. Consume ändert die Adresse (auch ohne Cookie), ist one-time, widerruft ALLE Sessions und offenen Links; Login danach nur mit neuer Mail', async () => {
    const { customer, session } = await privateCustomer();
    const second = await loginPortalCustomerSession(ctx, customer.id);
    await requestMagicLink(ctx, 'kunde@example.com'); // offener Login-Link
    await emailChangeRequest(session.cookie, 'neu@example.com');
    const link = await emailChangeToken();

    const consumed = await emailChangeConsume(link.token); // anderes Gerät: kein Cookie nötig
    expect(consumed.statusCode).toBe(200);
    expect(consumed.json()).toEqual({ changed: true, message: PORTAL_MESSAGES.EMAIL_CHANGED });
    expect(consumed.cookies.find((c) => c.name === portalCookieName(ctx))!.value).toBe('');
    expect((await customerRow(customer.id)).email).toBe('neu@example.com');

    const again = await emailChangeConsume(link.token);
    expect(again.statusCode).toBe(401);
    expect(again.json().error.code).toBe('PORTAL_TOKEN_INVALID');

    const sessions = await ctx.db.select().from(customerPortalSessions);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
    expect((await getProfile(session.cookie)).statusCode).toBe(401);
    expect((await getProfile(second.cookie)).statusCode).toBe(401);
    const links = await ctx.db.select().from(customerPortalMagicLinks);
    expect(links.filter((l) => l.consumedAt === null && l.revokedAt === null)).toHaveLength(0);

    const oldLogin = await requestMagicLink(ctx, 'kunde@example.com');
    expect(oldLogin.token).toBeNull();
    const newLogin = await requestMagicLink(ctx, 'neu@example.com');
    expect(newLogin.token).not.toBeNull();
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/portal/auth/consume',
      payload: { token: newLogin.token },
    });
    expect(login.statusCode).toBe(200);
    const events = await ctx.pool.query(
      `select type, details from staff_security_events where type in ('portal.email_changed','portal.sessions_revoked') order by type`,
    );
    expect(events.rows.map((r) => r.type)).toEqual([
      'portal.email_changed',
      'portal.sessions_revoked',
    ]);
    expect(JSON.stringify(events.rows)).not.toContain('example.com');
    expect(events.rows[1].details.count).toBe(2);

    // Snapshots bleiben auch beim E-Mail-Wechsel unberührt (keine Buchung hier – Tabelle leer).
    expect(await ctx.db.select().from(bookings)).toHaveLength(0);
  });

  it('P15. Duplicate-Mail: Adresse eines anderen aktiven Kunden ⇒ 400 PORTAL_EMAIL_UNAVAILABLE; gelöschter Kunde blockiert nicht', async () => {
    const { admin, customer, session } = await privateCustomer();
    await createTestCustomer(ctx, admin.id, { email: 'belegt@example.com', firstName: 'Bela' });
    const blocked = await emailChangeRequest(session.cookie, 'belegt@example.com');
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error).toMatchObject({
      code: 'PORTAL_EMAIL_UNAVAILABLE',
      message: PORTAL_MESSAGES.EMAIL_UNAVAILABLE,
    });
    expect(await ctx.db.select().from(customerPortalMagicLinks)).toHaveLength(0);
    const trashed = await createTestCustomer(ctx, admin.id, {
      email: 'frei@example.com',
      firstName: 'Weg',
    });
    await customerServiceFor(ctx).moveToTrash(admin.id, trashed.id);
    expect((await emailChangeRequest(session.cookie, 'frei@example.com')).statusCode).toBe(202);
    expect((await customerRow(customer.id)).email).toBe('kunde@example.com');
  });

  it('P15b. Race: zwei Kunden wollen dieselbe neue Adresse – erster Consume gewinnt, zweiter ⇒ 409 (fail-closed), zweite Adresse unverändert', async () => {
    const first = await privateCustomer('eins@example.com');
    const second = await createTestCustomer(ctx, first.admin.id, {
      email: 'zwei@example.com',
      firstName: 'Zwei',
    });
    const secondSession = await loginPortalCustomerSession(ctx, second.id);
    await emailChangeRequest(first.session.cookie, 'ziel@example.com');
    const firstLink = await emailChangeToken();
    await emailChangeRequest(secondSession.cookie, 'ziel@example.com');
    const secondLink = await emailChangeToken();
    expect(firstLink.token).not.toBe(secondLink.token);

    const [a, b] = await Promise.all([
      emailChangeConsume(firstLink.token),
      emailChangeConsume(secondLink.token),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error.code).toBe('PORTAL_EMAIL_UNAVAILABLE');
    const rows = await ctx.db
      .select()
      .from(customers)
      .where(eq(customers.email, 'ziel@example.com'));
    expect(rows).toHaveLength(1);
    const firstEmail = (await customerRow(first.customer.id)).email;
    const secondEmail = (await customerRow(second.id)).email;
    expect([firstEmail, secondEmail].filter((e) => e === 'ziel@example.com')).toHaveLength(1);
    expect(firstEmail === 'eins@example.com' || secondEmail === 'zwei@example.com').toBe(true);
  });

  it('P16b. Consume mit widerrufener/abgelaufener anfordernder Session ⇒ 401, Adresse unverändert', async () => {
    const { customer, session } = await privateCustomer();
    await emailChangeRequest(session.cookie, 'neu@example.com');
    const link = await emailChangeToken();
    await ctx.app.inject({
      method: 'POST',
      url: '/portal/auth/logout',
      headers: { cookie: session.cookie },
    });
    const response = await emailChangeConsume(link.token);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('PORTAL_TOKEN_INVALID');
    expect((await customerRow(customer.id)).email).toBe('kunde@example.com');
  });
});
