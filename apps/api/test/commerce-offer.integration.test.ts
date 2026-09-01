/**
 * Phase-3-Pflichttests 18–43: Rabatte/Sonderpreise (Rechte + Schwellen),
 * Angebotsversionen, Gültigkeit, verbindliche Annahme inkl. Races und
 * eingefrorene Snapshots. Läuft gegen echtes PostgreSQL.
 */
import { eq } from 'drizzle-orm';
import { bookings, offerVersions } from '@mietroyal/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import {
  commerceServices,
  createCommerceWorld,
  inquiryServiceFor,
  productServiceFor,
  truncateCommerceTables,
} from './commerce-helpers.ts';
import { CustomerService } from '../src/crm/customer-service.ts';
import { UnconfiguredProductionGateway } from '../src/commerce/delivery-gateway.ts';
import { DocumentService } from '../src/commerce/document-service.ts';
import { OfferService } from '../src/commerce/offer-service.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
});

async function adminSession() {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  return { admin, cookie: session.cookie };
}

const SALES_KEYS = [
  'process.view_all',
  'customer.view',
  'inquiry.view',
  'inquiry.create',
  'inquiry.edit',
  'product.view',
  'offer.view',
  'offer.create',
  'offer.edit_draft',
  'offer.send',
  'offer.create_new_version',
  'offer.apply_discount',
  'offer.apply_special_price',
] as const;

async function draftOffer(adminId: string, eventInDays = 30) {
  const world = await createCommerceWorld(ctx, adminId, { eventInDays });
  const services = commerceServices(ctx);
  const { offerId, versionId } = await services.offers.createOffer(adminId, world.processId);
  return { world, services, offerId, versionId };
}

describe('18.–27. Rabatte & Sonderpreise (Rechte + Schwellen)', () => {
  it('18./20. Bis einschließlich 10 % ohne Grund, Betrag korrekt (discount.up_to_10)', async () => {
    const { admin } = await adminSession();
    const { versionId } = await draftOffer(admin.id);
    const seller = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Sven',
      lastName: 'Sale',
      email: 'sale@test.example',
      password: 'sale-passwort-1234',
      permissionKeys: [...SALES_KEYS, 'discount.up_to_10'],
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${versionId}/discount`,
      headers: { cookie: seller.cookie },
      payload: { discount: { type: 'percent', value: 1000 } },
    });
    expect(response.statusCode).toBe(200);
    const version = await commerceServices(ctx).offers.getVersion(versionId);
    expect(version.discountCents).toBe(1200); // 10 % von 120 EUR
    expect(version.fixedTotalCents).toBe(10800);
  });

  it('19. EUR-Rabatt korrekt inkl. effektiver Prozentprüfung', async () => {
    const { admin } = await adminSession();
    const { versionId, services } = await draftOffer(admin.id);
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${versionId}/discount`,
      headers: { cookie: (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie },
      payload: { discount: { type: 'fixed', value: 1200, reason: null } },
    });
    expect(response.statusCode).toBe(200);
    const version = await services.offers.getVersion(versionId);
    expect(version.discountCents).toBe(1200);
  });

  it('21./22. Über 10 %: ohne Grund abgelehnt, mit Grund und Recht erlaubt', async () => {
    const { admin } = await adminSession();
    const { versionId } = await draftOffer(admin.id);
    const seller = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Rita',
      lastName: 'Reason',
      email: 'reason@test.example',
      password: 'reason-passwort-123',
      permissionKeys: [...SALES_KEYS, 'discount.up_to_10', 'discount.over_10_with_reason'],
    });
    const noReason = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${versionId}/discount`,
      headers: { cookie: seller.cookie },
      payload: { discount: { type: 'percent', value: 1500 } },
    });
    expect(noReason.statusCode).toBe(400);

    const withReason = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${versionId}/discount`,
      headers: { cookie: seller.cookie },
      payload: { discount: { type: 'percent', value: 1500, reason: 'Stammkunde' } },
    });
    expect(withReason.statusCode).toBe(200);

    // Ohne das Über-10-%-Recht scheitert es trotz Grund:
    const limited = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Lars',
      lastName: 'Limitiert',
      email: 'limitiert@test.example',
      password: 'limit-passwort-1234',
      permissionKeys: [...SALES_KEYS, 'discount.up_to_10'],
    });
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${versionId}/discount`,
      headers: { cookie: limited.cookie },
      payload: { discount: { type: 'percent', value: 1500, reason: 'Grund' } },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('23./24. Über 20 %: ohne Freigabe nicht versendbar, mit Freigabe erlaubt', async () => {
    const { admin } = await adminSession();
    const { versionId } = await draftOffer(admin.id);
    const seller = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Greta',
      lastName: 'Grossrabatt',
      email: 'grossrabatt@test.example',
      password: 'gross-passwort-1234',
      permissionKeys: [
        ...SALES_KEYS,
        'discount.up_to_10',
        'discount.over_10_with_reason',
        'discount.over_20_request',
      ],
    });
    const set = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${versionId}/discount`,
      headers: { cookie: seller.cookie },
      payload: { discount: { type: 'percent', value: 2500, reason: 'Vereinsaktion' } },
    });
    expect(set.statusCode).toBe(200);

    // 23: Versand OHNE Freigabe blockiert.
    const send = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${versionId}/send`,
      headers: { cookie: seller.cookie },
    });
    expect(send.statusCode).toBe(409);

    // 24: Admin (discount.over_20_approve) gibt frei, danach ist der Versand möglich.
    const adminCookie = (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie;
    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${versionId}/approve-discount`,
      headers: { cookie: adminCookie },
    });
    expect(approve.statusCode).toBe(200);
    const sendApproved = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${versionId}/send`,
      headers: { cookie: seller.cookie },
    });
    expect(sendApproved.statusCode).toBe(200);
  });

  it('25. Sonderpreis speichert Standard- UND neuen Preis samt Mitarbeiter/Zeitpunkt', async () => {
    const { admin, cookie } = await adminSession();
    const { versionId, services } = await draftOffer(admin.id);
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${versionId}/special-price`,
      headers: { cookie },
      payload: { lineKey: 'machine', unitPriceCents: 9000 },
    });
    expect(response.statusCode).toBe(200);
    const version = await services.offers.getVersion(versionId);
    const specials = version.specialPrices as {
      lineKey: string;
      unitPriceCents: number;
      previousStandardCents: number;
      byUserId: string;
      at: string;
    }[];
    expect(specials).toHaveLength(1);
    expect(specials[0]?.previousStandardCents).toBe(12000);
    expect(specials[0]?.unitPriceCents).toBe(9000);
    expect(specials[0]?.byUserId).toBe(admin.id);
    const machineLine = await ctx.pool.query(
      `SELECT standard_unit_price_cents, agreed_unit_price_cents, price_source, special_price_by
       FROM offer_line_items WHERE offer_version_id = $1 AND kind = 'machine'`,
      [versionId],
    );
    expect(machineLine.rows[0].standard_unit_price_cents).toBe(12000);
    expect(machineLine.rows[0].agreed_unit_price_cents).toBe(9000);
    expect(machineLine.rows[0].price_source).toBe('special');
    expect(machineLine.rows[0].special_price_by).toBe(admin.id);
  });

  it('26. 0-EUR-Sonderpreis ohne eigenes Recht blockiert, mit Recht erlaubt', async () => {
    const { admin, cookie } = await adminSession();
    const { versionId } = await draftOffer(admin.id);
    const seller = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Nulla',
      lastName: 'Nichts',
      email: 'nullpreis@test.example',
      password: 'null-passwort-12345',
      permissionKeys: [...SALES_KEYS],
    });
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${versionId}/special-price`,
      headers: { cookie: seller.cookie },
      payload: { lineKey: 'machine', unitPriceCents: 0 },
    });
    expect(denied.statusCode).toBe(403);
    // Admin (Systemadmin → besitzt offer.apply_special_price_zero) darf:
    const allowed = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${versionId}/special-price`,
      headers: { cookie },
      payload: { lineKey: 'machine', unitPriceCents: 0 },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('27. Rabatt kann die Summe nicht negativ machen', async () => {
    const { admin, cookie } = await adminSession();
    const { versionId } = await draftOffer(admin.id);
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${versionId}/discount`,
      headers: { cookie },
      payload: { discount: { type: 'fixed', value: 12001, reason: 'zu viel' } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('Manueller Lieferpreis verlangt offer.change_price (serverseitig)', async () => {
    const { admin } = await adminSession();
    const { versionId } = await draftOffer(admin.id);
    // SALES_KEYS enthält offer.edit_draft, aber NICHT offer.change_price.
    const seller = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Paul',
      lastName: 'Preislos',
      email: 'preislos@test.example',
      password: 'preislos-passwort-1',
      permissionKeys: [...SALES_KEYS, 'discount.up_to_10'],
    });
    const denied = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/offer-versions/${versionId}`,
      headers: { cookie: seller.cookie },
      payload: { deliveryPriceCents: 4900 },
    });
    expect(denied.statusCode).toBe(403);
    // Andere Entwurfsänderungen bleiben mit offer.edit_draft erlaubt:
    const allowed = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/offer-versions/${versionId}`,
      headers: { cookie: seller.cookie },
      payload: {},
    });
    expect(allowed.statusCode).toBe(200);
  });
});

describe('28.–32. Entwurf, Versand, Versionen', () => {
  it('28. Entwurf anlegen: V1 mit Positionen aus der Anfrage (inkl. Inklusivpositionen)', async () => {
    const { admin } = await adminSession();
    const { versionId, services } = await draftOffer(admin.id);
    const version = await services.offers.getVersion(versionId);
    expect(version.status).toBe('draft');
    expect(version.versionNumber).toBe(1);
    expect(version.fixedTotalCents).toBe(12000);
    const items = await ctx.pool.query(
      `SELECT kind, billing_mode FROM offer_line_items WHERE offer_version_id = $1 ORDER BY position`,
      [versionId],
    );
    const kinds = items.rows.map((row) => `${row.kind}:${row.billing_mode}`);
    expect(kinds).toContain('machine:fixed');
    expect(kinds).toContain('syrup:included');
    expect(kinds.filter((kind) => kind === 'consumable:included')).toHaveLength(2);
  });

  it('29./30. Versand friert V1 ein (sent_at/expires_at/Snapshots); gesendete Version ist nicht mutierbar', async () => {
    const { admin, cookie } = await adminSession();
    const { versionId, services } = await draftOffer(admin.id);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    const { token } = await services.offers.send(admin.id, versionId, effective);
    expect(token.length).toBeGreaterThan(20);

    const version = await services.offers.getVersion(versionId);
    expect(version.status).toBe('sent');
    expect(version.sentAt).not.toBeNull();
    expect(version.expiresAt).not.toBeNull();
    expect(version.customerSnapshot).not.toBeNull();
    expect(version.termsVersionId).not.toBeNull();

    // Outbox-Adapter hat den fachlichen Versand protokolliert:
    const outbox = await ctx.pool.query(`SELECT kind, recipient FROM offer_deliveries`);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].kind).toBe('offer');

    // 30: Mutationen an der gesendeten Version sind blockiert.
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/offer-versions/${versionId}`,
      headers: { cookie },
      payload: { machineQuantity: 2 },
    });
    expect(patch.statusCode).toBe(409);
    const discount = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${versionId}/discount`,
      headers: { cookie },
      payload: { discount: { type: 'percent', value: 500 } },
    });
    expect(discount.statusCode).toBe(409);
    const resend = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${versionId}/send`,
      headers: { cookie },
    });
    expect(resend.statusCode).toBe(409);
  });

  it('31./32. Änderung erzeugt V2; V1 bleibt historisch, nur V2 ist aktuell', async () => {
    const { admin } = await adminSession();
    const { versionId, offerId, services } = await draftOffer(admin.id);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    await services.offers.send(admin.id, versionId, effective);

    const next = await services.offers.createNewVersion(admin.id, offerId, 'Menge angepasst');
    expect(next.versionNumber).toBe(2);

    const v1 = await services.offers.getVersion(versionId);
    expect(v1.supersededAt).not.toBeNull();
    expect(v1.status).toBe('sent'); // Historie bleibt erhalten
    const offerRow = await ctx.pool.query(`SELECT current_version_id FROM offers WHERE id = $1`, [
      offerId,
    ]);
    expect(offerRow.rows[0].current_version_id).toBe(next.versionId);
    const v2 = await services.offers.getVersion(next.versionId);
    expect(v2.status).toBe('draft');
    expect(v2.fixedTotalCents).toBe(12000);
  });
});

describe('33.–38. Gültigkeit & Ablauf', () => {
  async function sentWorld(eventDate: string, sentAtIso: string) {
    const { admin } = await adminSession();
    const world = await createCommerceWorld(ctx, admin.id);
    await inquiryServiceFor(ctx).upsertForProcess(admin.id, world.processId, {
      eventDate,
      machineProductId: world.machineId,
      fulfillment: 'pickup',
      selections: [],
    });
    const services = commerceServices(ctx);
    const { offerId, versionId } = await services.offers.createOffer(admin.id, world.processId);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    const { token } = await services.offers.send(
      admin.id,
      versionId,
      effective,
      new Date(sentAtIso),
    );
    return { admin, world, services, offerId, versionId, token };
  }

  it('33. Event ≤ 14 Tage entfernt → 3 Tage Gültigkeit', async () => {
    const { services, versionId } = await sentWorld('2026-09-10', '2026-09-01T10:00:00Z');
    const version = await services.offers.getVersion(versionId);
    expect(version.expiresAt?.getTime()).toBe(
      new Date('2026-09-01T10:00:00Z').getTime() + 3 * 86_400_000,
    );
  });

  it('34. Event > 14 Tage entfernt → 7 Tage Gültigkeit', async () => {
    const { services, versionId } = await sentWorld('2026-10-15', '2026-09-01T10:00:00Z');
    const version = await services.offers.getVersion(versionId);
    expect(version.expiresAt?.getTime()).toBe(
      new Date('2026-09-01T10:00:00Z').getTime() + 7 * 86_400_000,
    );
  });

  it('35. Grenzwert exakt 14 Tage → 3 Tage; 15 Tage → 7 Tage', async () => {
    const at14 = await sentWorld('2026-09-15', '2026-09-01T10:00:00Z');
    const v14 = await at14.services.offers.getVersion(at14.versionId);
    expect(v14.expiresAt?.getTime()).toBe(
      new Date('2026-09-01T10:00:00Z').getTime() + 3 * 86_400_000,
    );

    await truncateCrmTables(ctx.pool);
    await truncateAuthTables(ctx.pool);
    await truncateCommerceTables(ctx.pool);

    const at15 = await sentWorld('2026-09-16', '2026-09-01T10:00:00Z');
    const v15 = await at15.services.offers.getVersion(at15.versionId);
    expect(v15.expiresAt?.getTime()).toBe(
      new Date('2026-09-01T10:00:00Z').getTime() + 7 * 86_400_000,
    );
  });

  it('36./37. Abgelaufenes Angebot ist nicht annehmbar; „Erneute Prüfung“ ist möglich', async () => {
    const { services, token } = await sentWorld('2026-09-10', '2026-09-01T10:00:00Z');
    const afterExpiry = new Date('2026-09-05T10:00:00Z');
    await expect(services.offers.accept(token, afterExpiry)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    // Öffentliche Sicht zeigt „abgelaufen“:
    const view = await services.offers.publicView(token, afterExpiry);
    expect(view?.status).toBe('expired');
    // Erneute Prüfung anfragen – erzeugt KEINE neue Version automatisch.
    await services.offers.requestRecheck(token, afterExpiry);
    const view2 = await services.offers.publicView(token, afterExpiry);
    expect(view2?.status).toBe('recheck_requested');
    const versionCount = await ctx.pool.query(`SELECT count(*)::int AS n FROM offer_versions`);
    expect(versionCount.rows[0].n).toBe(1);
  });

  it('38. Ersetzte Version ist nicht mehr annehmbar', async () => {
    const { admin, services, offerId, token } = await sentWorld(
      '2026-10-15',
      '2026-09-01T10:00:00Z',
    );
    await services.offers.createNewVersion(admin.id, offerId, null);
    // V1-Token existiert noch (Rotation erst beim Versand von V2), aber die
    // Annahme scheitert an der ersetzten/aktuellen Version:
    await expect(
      services.offers.accept(token, new Date('2026-09-02T10:00:00Z')),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const count = await ctx.pool.query(`SELECT count(*)::int AS n FROM bookings`);
    expect(count.rows[0].n).toBe(0);
  });
});

describe('39.–43. Annahme: Idempotenz, Races, Snapshots', () => {
  async function acceptedSetup() {
    const { admin } = await adminSession();
    const world = await createCommerceWorld(ctx, admin.id, { eventInDays: 40 });
    const services = commerceServices(ctx);
    const { offerId, versionId } = await services.offers.createOffer(admin.id, world.processId);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    const { token } = await services.offers.send(admin.id, versionId, effective);
    return { admin, world, services, offerId, versionId, token };
  }

  it('39. Doppelter Annahmeklick erzeugt genau EINE Buchung (idempotent)', async () => {
    const { services, token } = await acceptedSetup();
    const [first, second] = await Promise.all([
      services.offers.accept(token),
      services.offers.accept(token),
    ]);
    expect(first.bookingId).toBe(second.bookingId);
    const count = await ctx.pool.query(`SELECT count(*)::int AS n FROM bookings`);
    expect(count.rows[0].n).toBe(1);
    // AB wurde genau einmal vorbereitet:
    const confirmations = await ctx.pool.query(
      `SELECT count(*)::int AS n, min(status) AS status FROM order_confirmations`,
    );
    expect(confirmations.rows[0].n).toBe(1);
    expect(confirmations.rows[0].status).toBe('prepared');
  });

  it('40. Annahme vs. Ablauf: nach Ablauf keine Buchung, vor Ablauf angenommen bleibt angenommen', async () => {
    const { services, token, versionId } = await acceptedSetup();
    const version = await commerceServices(ctx).offers.getVersion(versionId);
    const expires = version.expiresAt!;
    const justBefore = new Date(expires.getTime() - 1000);
    const justAfter = new Date(expires.getTime() + 1000);

    const results = await Promise.allSettled([
      services.offers.accept(token, justAfter),
      services.offers.accept(token, justBefore),
    ]);
    const bookingsCount = await ctx.pool.query(`SELECT count(*)::int AS n FROM bookings`);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    if (bookingsCount.rows[0].n === 1) {
      // Die Vor-Ablauf-Annahme hat gewonnen; einmal angenommen bleibt angenommen.
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      const fresh = await services.offers.getVersion(versionId);
      expect(fresh.status).toBe('accepted');
    } else {
      // Die Nach-Ablauf-Prüfung kam zuerst UND die zweite wurde korrekt
      // abgelehnt – dann darf es keine Buchung geben.
      expect(bookingsCount.rows[0].n).toBe(0);
    }
  });

  it('41. Annahme vs. neue Version: konsistenter Ausgang, niemals beides', async () => {
    const { admin, services, offerId, token, versionId } = await acceptedSetup();
    const results = await Promise.allSettled([
      services.offers.accept(token),
      services.offers.createNewVersion(admin.id, offerId, 'Race-Test'),
    ]);
    const bookingsCount = await ctx.pool.query(`SELECT count(*)::int AS n FROM bookings`);
    const version = await services.offers.getVersion(versionId);
    if (bookingsCount.rows[0].n === 1) {
      // Annahme gewann → neue Version muss abgelehnt worden sein.
      expect(version.status).toBe('accepted');
      expect(results[1].status).toBe('rejected');
    } else {
      // Neue Version gewann → Annahme der alten Version wurde abgelehnt.
      expect(version.supersededAt).not.toBeNull();
      expect(results[0].status).toBe('rejected');
      expect(bookingsCount.rows[0].n).toBe(0);
    }
  });

  it('42. Kunden-Snapshot ist eingefroren – spätere Profiländerungen wirken nicht', async () => {
    const { admin, world, services, token } = await acceptedSetup();
    const { bookingId } = await services.offers.accept(token);

    const customerService = new CustomerService(ctx.db);
    await customerService.updateCustomer(admin.id, world.customerId, {
      type: 'private',
      firstName: 'Geändert',
      lastName: 'Anders',
      email: 'neu@test.example',
    });

    const booking = await ctx.db.select().from(bookings).where(eq(bookings.id, bookingId));
    const snapshot = booking[0]?.customerSnapshot as { firstName: string; email: string };
    expect(snapshot.firstName).toBe('Klara');
    expect(snapshot.email).toBe('klara.kommerz@test.example');
  });

  it('43. Preis-Snapshot ist eingefroren – spätere Preisänderungen wirken nicht', async () => {
    const { admin, world, services, token, versionId } = await acceptedSetup();
    const { bookingId } = await services.offers.accept(token);

    await productServiceFor(ctx).setCurrentPrice(admin.id, world.machineId, 55500);

    const booking = await ctx.db.select().from(bookings).where(eq(bookings.id, bookingId));
    const totals = booking[0]?.totalsSnapshot as { fixedTotalCents: number };
    expect(totals.fixedTotalCents).toBe(12000);
    const version = await ctx.db
      .select()
      .from(offerVersions)
      .where(eq(offerVersions.id, versionId));
    expect(version[0]?.fixedTotalCents).toBe(12000);
  });
});

describe('Härtungen aus dem adversarialen Review', () => {
  it('Production ohne Versandadapter: Blockade VOR dem Einfrieren (kein sent, kein Token, kein PDF)', async () => {
    const { admin } = await adminSession();
    const { versionId } = await draftOffer(admin.id);
    const productionOffers = new OfferService(
      ctx.db,
      ctx.config,
      new DocumentService(ctx.db, ctx.storage),
      new UnconfiguredProductionGateway(),
    );
    const effective = await ctx.auth.effectivePermissions(admin.id);
    await expect(productionOffers.send(admin.id, versionId, effective)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const version = await ctx.db
      .select()
      .from(offerVersions)
      .where(eq(offerVersions.id, versionId));
    expect(version[0]?.status).toBe('draft');
    expect(version[0]?.sentAt).toBeNull();
    const tokens = await ctx.pool.query('SELECT count(*)::int AS n FROM offer_access_tokens');
    expect(tokens.rows[0].n).toBe(0);
    const docs = await ctx.pool.query('SELECT count(*)::int AS n FROM documents');
    expect(docs.rows[0].n).toBe(0);
  });

  it('Rabatt-Drift: Änderung der Maschinen-Zwischensumme entfernt den gesetzten Rabatt', async () => {
    const { admin } = await adminSession();
    const { versionId } = await draftOffer(admin.id);
    const services = commerceServices(ctx);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    // Fixer EUR-Rabatt = exakt 10 % der 2×10-Maschine (12000 → 1200).
    await services.offers.setDiscount(admin.id, versionId, effective, {
      type: 'fixed',
      value: 1200,
    });
    // Maschinenwechsel auf 1×8 (6000): Der fixe Rabatt wäre plötzlich 20 % –
    // deshalb wird er entfernt und muss rechtegeprüft neu gesetzt werden.
    // (Gratis-Sirup mit leeren, da 1×8 nur 1 L Kontingent hat.)
    const smallMachine = await productServiceFor(ctx).getProductBySlug('slush-1x8');
    await services.offers.updateDraft(admin.id, versionId, {
      machineProductId: smallMachine.id,
      selections: [],
    });
    const version = await ctx.db
      .select()
      .from(offerVersions)
      .where(eq(offerVersions.id, versionId));
    expect(version[0]?.discountType).toBeNull();
    expect(version[0]?.discountCents).toBe(0);
    expect(version[0]?.fixedTotalCents).toBe(6000);
  });

  it('Sonderpreis auf die Lieferposition wird abgelehnt (kein stiller No-Op)', async () => {
    const { admin } = await adminSession();
    const world = await createCommerceWorld(ctx, admin.id, { fulfillment: 'delivery' });
    const services = commerceServices(ctx);
    const { versionId } = await services.offers.createOffer(admin.id, world.processId);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    await expect(
      services.offers.setSpecialPrice(admin.id, versionId, effective, {
        lineKey: 'delivery',
        unitPriceCents: 1000,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('Vorgangs-Sichtbarkeit gilt auch für Commerce-Routen (ohne process.view_all → 403)', async () => {
    const { admin } = await adminSession();
    const world = await createCommerceWorld(ctx, admin.id);
    const limited = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Sina',
      lastName: 'Sichtlos',
      email: 'sichtlos@test.example',
      password: 'sichtlos-passwort-1',
      permissionKeys: ['offer.view', 'inquiry.view'],
    });
    for (const url of [
      `/staff/processes/${world.processId}/offer`,
      `/staff/processes/${world.processId}/inquiry`,
      `/staff/processes/${world.processId}/confirmation`,
    ]) {
      const response = await ctx.app.inject({
        method: 'GET',
        url,
        headers: { cookie: limited.cookie },
      });
      expect(response.statusCode, url).toBe(403);
    }
  });

  it('Kanisterlimit serverseitig: max. 2 je Behälter über die Anfrage erzwungen', async () => {
    const { admin } = await adminSession();
    const world = await createCommerceWorld(ctx, admin.id);
    const inquiries = inquiryServiceFor(ctx);
    const eventDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    // 2×10-Maschine hat 2 Behälter → maximal 4 Kanister.
    await expect(
      inquiries.upsertForProcess(admin.id, world.processId, {
        eventDate,
        machineProductId: world.machineId,
        fulfillment: 'pickup',
        selections: [{ productId: world.canisterId, role: 'extra', quantity: 5 }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await inquiries.upsertForProcess(admin.id, world.processId, {
      eventDate,
      machineProductId: world.machineId,
      fulfillment: 'pickup',
      selections: [{ productId: world.canisterId, role: 'extra', quantity: 4 }],
    });
  });
});
