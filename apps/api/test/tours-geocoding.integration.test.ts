/**
 * Phase-13-Pflichttests 17–24 (Order §73) + Cache-/Redaction-Belege: Adress-
 * autorität (Snapshot statt Kundenstamm, Depot aus pickup_exact_address),
 * konservatives Geocoding mit Cache (resolved / review_required / no_result /
 * unavailable), Bestätigung nur aus gespeicherten Kandidaten, TTL, Key nie in
 * DB/Log. Läuft gegen echtes PostgreSQL und den GraphHopper-Contract-Fake.
 */
import { Writable } from 'node:stream';
import { appointments, customers, geocodingCache } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthError } from '../src/auth/service.ts';
import { PICKUP_EXACT_ADDRESS_KEY, setStringSetting } from '../src/crm/settings-service.ts';
import {
  ADDRESS_MISSING_MESSAGE,
  customerAddressFromSnapshot,
  DEPOT_ADDRESS_MISSING_MESSAGE,
  getDepotAddress,
  resolveOperativeAddress,
} from '../src/routing/address-resolver.ts';
import {
  decideGeocoding,
  GEOCODING_TTL_RESOLVED_MS,
  GEOCODING_TTL_REVIEW_MS,
  GeocodingService,
  parseAddressInput,
} from '../src/routing/geocoding-service.ts';
import { MockRoutingGateway } from '../src/routing/fake.ts';
import { InMemoryIntegrationRateLimiter } from '../src/integrations/rate-limiter.ts';
import { GraphHopperRoutingGateway } from '../src/routing/graphhopper.ts';
import {
  FAKE_HITS,
  startGraphHopperFakeServer,
  type GraphHopperFakeServer,
} from '../src/routing/testing/fake-server.ts';
import type { GeocodeCandidate } from '../src/routing/types.ts';
import {
  bootstrapAdmin,
  createTestContext,
  destroyTestContext,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { truncateCrmTables } from './crm-helpers.ts';
import {
  createAcceptedBooking,
  schedulingServiceFor,
  truncateSchedulingTables,
} from './scheduling-helpers.ts';

const SYNTH_KEY = 'SYNTH-graphhopper-integration-key-never-real';
const NOW = new Date('2026-11-02T06:00:00Z');

let ctx: TestContext;
let fake: GraphHopperFakeServer;
let gateway: GraphHopperRoutingGateway;
let service: GeocodingService;
const logLines: string[] = [];
/** Serverlog beim Bauen der App (Start-Log der Routing-Fabrik). */
let startupLog = '';
const logDestination = new Writable({
  write(chunk, _encoding, callback) {
    logLines.push(chunk.toString());
    callback();
  },
});

beforeAll(async () => {
  fake = await startGraphHopperFakeServer({ apiKey: SYNTH_KEY });
  ctx = await createTestContext({
    logDestination,
    logLevel: 'info',
    env: {
      ROUTING_ENABLED: 'true',
      ROUTING_PROVIDER: 'graphhopper',
      GRAPHHOPPER_API_KEY: SYNTH_KEY,
      GRAPHHOPPER_BASE_URL: fake.baseUrl,
      ROUTING_REQUEST_TIMEOUT_MS: '2000',
    },
  });
  startupLog = logLines.join('');
  gateway = new GraphHopperRoutingGateway({
    apiKey: SYNTH_KEY,
    baseUrl: fake.baseUrl,
    timeoutMs: 2000,
    // Phase 13 Final (§1): Geocoding-Tests prüfen nicht die globale Drossel – eigener In-Memory-Limiter je Client.
    limiter: new InMemoryIntegrationRateLimiter({ provider: 'graphhopper', intervalMs: 0 }),
  });
  service = new GeocodingService(ctx.db, gateway);
});
afterAll(async () => {
  await destroyTestContext(ctx);
  await fake.stop();
});
beforeEach(async () => {
  await ctx.pool.query('TRUNCATE geocoding_cache CASCADE');
  await truncateSchedulingTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
  fake.state.reset();
  logLines.length = 0;
});

async function cacheRows() {
  return ctx.db.select().from(geocodingCache);
}

async function deliveryAppointments(adminId: string) {
  const world = await createAcceptedBooking(ctx, adminId, { fulfillment: 'delivery' });
  await schedulingServiceFor(ctx).ensureAppointmentsForBooking(world.bookingId);
  const rows = await ctx.db
    .select()
    .from(appointments)
    .where(eq(appointments.bookingId, world.bookingId));
  return { world, rows };
}

describe('Adressautorität und Geocoding (Phase 13, Agent ROUTE)', () => {
  it('T17. eindeutige Adresse ⇒ resolved mit Koordinate, Cache-Eintrag (TTL 90 Tage), zweiter Aufruf ohne Provider', async () => {
    const first = await service.resolve('  Lieferweg   12,  55129 Mainz ', { now: NOW });
    expect(first.status).toBe('resolved');
    expect(first.point).toEqual({ latitude: 49.9742, longitude: 8.2566 });
    expect(first.label).toBe('Lieferweg 12, 55129 Mainz');
    expect(first.candidates).toEqual([]);
    expect(first.cacheId).not.toBeNull();
    const rows = await cacheRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'resolved',
      addressText: 'Lieferweg 12, 55129 Mainz',
      latitude: 49.9742,
      longitude: 8.2566,
      osmRef: 'osm:W100002',
      provider: 'graphhopper',
      candidates: null,
      confirmedBy: null,
    });
    expect(rows[0]!.expiresAt.getTime()).toBe(NOW.getTime() + GEOCODING_TTL_RESOLVED_MS);
    // Normalisierte Anfrage: nur Adresse + Land, provider nominatim, locale de, limit 5.
    expect(fake.state.requests).toHaveLength(1);
    expect(fake.state.requests[0]!.query).toEqual({
      q: 'Lieferweg 12, 55129 Mainz, Deutschland',
      locale: 'de',
      limit: '5',
      provider: 'nominatim',
    });
    const second = await service.resolve('Lieferweg 12, 55129 Mainz', { now: NOW });
    expect(second).toEqual(first);
    expect(fake.state.requests).toHaveLength(1);
  });

  it('T18. mehrere Kandidaten / keine Hausnummer im Treffer ⇒ review_required mit ≤ 5 Kandidaten (keine stille Straßenmitte), TTL 30 Tage', async () => {
    const result = await service.resolve('Am Markt 3, 55116 Mainz', { now: NOW });
    expect(result.status).toBe('review_required');
    expect(result.point).toBeNull();
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.ref)).toEqual([
      'osm:W100003',
      'osm:W100004',
    ]);
    expect(result.candidates[0]).toEqual({
      ref: 'osm:W100003',
      label: 'Am Markt, 55116 Mainz',
      point: { latitude: 49.9997, longitude: 8.2733 },
    });
    const rows = await cacheRows();
    expect(rows[0]!.status).toBe('review_required');
    expect(rows[0]!.latitude).toBeNull();
    expect(rows[0]!.expiresAt.getTime()).toBe(NOW.getTime() + GEOCODING_TTL_REVIEW_MS);
    expect(rows[0]!.candidates).toHaveLength(2);

    // Mehr als fünf Treffer werden auf fünf Kandidaten begrenzt.
    fake.state.geocode = () =>
      Array.from({ length: 8 }, (_, index) => ({
        ...FAKE_HITS.amMarktA,
        osm_id: 200 + index,
        point: { lat: 49.99 + index / 1000, lng: 8.27 },
      }));
    const many = await service.resolve('Am Markt 9, 55116 Mainz', { now: NOW });
    expect(many.status).toBe('review_required');
    expect(many.candidates).toHaveLength(5);

    // Abweichende PLZ ⇒ review_required, auch bei einem einzigen vollständigen Treffer.
    fake.state.geocode = () => [{ ...FAKE_HITS.lieferweg12, postcode: '55131' }];
    const wrongPostcode = await service.resolve('Lieferweg 12, 55129 Mainz', { now: NOW });
    expect(wrongPostcode.status).toBe('review_required');
    expect(wrongPostcode.candidates).toHaveLength(1);

    // Reine Entscheidungsregel: genau ein Treffer mit Straße+PLZ+Hausnummer ⇒ resolved;
    // zwei Treffer, nur einer mit passender Hausnummer ⇒ resolved; zwei gleichwertige ⇒ review.
    const input = parseAddressInput('Lieferweg 12, 55129 Mainz');
    expect(input).toEqual({
      streetName: 'Lieferweg',
      housenumber: '12',
      postcode: '55129',
      city: 'Mainz',
    });
    const exact: GeocodeCandidate = {
      point: { latitude: 1, longitude: 2 },
      label: 'Lieferweg 12, 55129 Mainz',
      street: 'Lieferweg',
      housenumber: '12',
      postcode: '55129',
      city: 'Mainz',
      country: 'Deutschland',
      ref: 'osm:W1',
    };
    const street: GeocodeCandidate = { ...exact, housenumber: null, ref: 'osm:W2' };
    expect(decideGeocoding(input, [exact]).status).toBe('resolved');
    expect(decideGeocoding(input, [street, exact]).status).toBe('resolved');
    expect(decideGeocoding(input, [street]).status).toBe('review_required');
    expect(decideGeocoding(input, [exact, { ...exact, ref: 'osm:W3' }]).status).toBe(
      'review_required',
    );
    expect(decideGeocoding(input, []).status).toBe('no_result');
    expect(decideGeocoding(input, [{ ...exact, street: 'Lieferstraße' }]).status).toBe(
      'review_required',
    );
  });

  it('T19. kein Treffer ⇒ no_result (nicht routefähig), Cache-Eintrag no_result ohne Koordinate; leere Eingabe ⇒ no_result ohne Provider', async () => {
    const result = await service.resolve('Gibtesnicht 1, 99999 Nirgendwo', { now: NOW });
    expect(result.status).toBe('no_result');
    expect(result.point).toBeNull();
    expect(result.cacheId).not.toBeNull();
    const rows = await cacheRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'no_result', latitude: null, candidates: null });
    expect(fake.state.requests).toHaveLength(1);
    const empty = await service.resolve('   ', { now: NOW });
    expect(empty).toEqual({
      status: 'no_result',
      point: null,
      label: null,
      candidates: [],
      cacheId: null,
    });
    expect(fake.state.requests).toHaveLength(1);
  });

  it('T20. Kundendaten außer der Adresse stehen nie im Geocoding-Request (Name, Telefon, E-Mail, Vorgangsnummer, Preis)', async () => {
    const admin = await bootstrapAdmin(ctx);
    const { world, rows } = await deliveryAppointments(admin.id);
    const delivery = rows.find((row) => row.kind === 'delivery')!;
    const address = await resolveOperativeAddress(ctx.db, delivery);
    expect(address).toEqual({
      kind: 'customer',
      text: 'Lieferweg 12, 55129 Mainz',
      lines: ['Lieferweg 12', '55129 Mainz'],
      status: 'ok',
    });
    const result = await service.resolve(address.text!, { now: NOW });
    expect(result.status).toBe('resolved');
    const customer = (
      await ctx.db.select().from(customers).where(eq(customers.id, world.customerId))
    )[0]!;
    const sent = JSON.stringify(fake.state.requests);
    for (const forbidden of [
      customer.firstName,
      customer.lastName,
      customer.email,
      customer.phone ?? 'never',
      world.processId,
      world.bookingId,
      world.customerId,
      'MR-',
      'Cents',
    ]) {
      expect(forbidden).toBeTruthy();
      expect(sent).not.toContain(forbidden);
    }
    expect(fake.state.requests[0]!.query.q).toBe('Lieferweg 12, 55129 Mainz, Deutschland');
    expect(fake.state.requests[0]!.body).toBeNull();
    // Der Cache enthält ebenfalls nur die Adresse.
    const row = (await cacheRows())[0]!;
    expect(JSON.stringify(row)).not.toContain(customer.lastName);
  });

  it('T21. Delivery-Adresse kommt ausschließlich aus dem eingefrorenen Snapshot – nie aus dem (geänderten) Kundenstamm; unvollständiger Snapshot ⇒ missing', async () => {
    const admin = await bootstrapAdmin(ctx);
    const { world, rows } = await deliveryAppointments(admin.id);
    await ctx.db
      .update(customers)
      .set({ billingStreet: 'Neue Straße 99', billingPostalCode: '55116', billingCity: 'Mainz' })
      .where(eq(customers.id, world.customerId));
    for (const kind of ['delivery', 'return'] as const) {
      const appointment = rows.find((row) => row.kind === kind)!;
      expect(appointment.locationKind).toBe('customer');
      const address = await resolveOperativeAddress(ctx.db, appointment);
      expect(address.status).toBe('ok');
      expect(address.text).toBe('Lieferweg 12, 55129 Mainz');
      expect(address.text).not.toContain('Neue Straße');
    }
    // Snapshot ohne Straße / ohne PLZ und Ort ⇒ missing (Termin bleibt, Route nicht berechenbar).
    expect(customerAddressFromSnapshot({ postalCode: '55129', city: 'Mainz' })).toEqual({
      kind: 'customer',
      text: null,
      lines: [],
      status: 'missing',
    });
    expect(customerAddressFromSnapshot({ street: 'Lieferweg 12' }).status).toBe('missing');
    expect(customerAddressFromSnapshot(null).status).toBe('missing');
    expect(customerAddressFromSnapshot({ street: ' Lieferweg 12 ', city: 'Mainz' })).toEqual({
      kind: 'customer',
      text: 'Lieferweg 12, Mainz',
      lines: ['Lieferweg 12', 'Mainz'],
      status: 'ok',
    });
    expect(
      await resolveOperativeAddress(ctx.db, { locationKind: 'customer', locationSnapshot: null }),
    ).toMatchObject({ kind: 'customer', status: 'missing' });
    expect(ADDRESS_MISSING_MESSAGE).toBe('Adresse fehlt – Route nicht berechenbar.');
  });

  it('T22. fehlende Depotadresse (pickup_exact_address) ⇒ status missing als Blocker; gesetzt ⇒ Depot und Abhol-/Rückgabetermine am Standort nutzen dieselbe Adresse', async () => {
    const admin = await bootstrapAdmin(ctx);
    expect(await getDepotAddress(ctx.db)).toEqual({
      kind: 'depot',
      text: null,
      lines: [],
      status: 'missing',
    });
    expect(DEPOT_ADDRESS_MISSING_MESSAGE).toBe(
      'Depotadresse ist noch nicht vollständig hinterlegt.',
    );
    const world = await createAcceptedBooking(ctx, admin.id, { fulfillment: 'pickup' });
    await schedulingServiceFor(ctx).ensureAppointmentsForBooking(world.bookingId);
    const rows = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.bookingId, world.bookingId));
    expect(rows.every((row) => row.locationKind === 'base')).toBe(true);
    for (const row of rows) {
      expect((await resolveOperativeAddress(ctx.db, row)).status).toBe('missing');
    }
    expect(fake.state.requests).toHaveLength(0);

    await setStringSetting(
      ctx.db,
      admin.id,
      PICKUP_EXACT_ADDRESS_KEY,
      '  Robert-Koch-Straße 1,   55129 Mainz ',
    );
    const depot = await getDepotAddress(ctx.db);
    expect(depot).toEqual({
      kind: 'depot',
      text: 'Robert-Koch-Straße 1, 55129 Mainz',
      lines: ['Robert-Koch-Straße 1', '55129 Mainz'],
      status: 'ok',
    });
    for (const row of rows) {
      expect(await resolveOperativeAddress(ctx.db, row)).toEqual(depot);
    }
    const resolved = await service.resolve(depot.text!, { now: NOW });
    expect(resolved.status).toBe('resolved');
    expect(resolved.point).toEqual({ latitude: 49.9545, longitude: 8.2735 });
    // Depot-Tests: in einer Transaktion lesbar (DatabaseExecutor).
    await ctx.db.transaction(async (tx) => {
      expect((await getDepotAddress(tx)).status).toBe('ok');
    });
  });

  it('T23. Bestätigung nur aus gespeicherten Kandidaten: fremde Ref/freie Koordinate abgelehnt, gültige Ref ⇒ resolved + confirmed; Bestätigung überlebt den Cache-Ablauf', async () => {
    const admin = await bootstrapAdmin(ctx);
    const review = await service.resolve('Am Markt 3, 55116 Mainz', { now: NOW });
    expect(review.status).toBe('review_required');
    const cacheId = review.cacheId!;
    for (const bogus of ['point:50.000000,8.000000', 'osm:W999999', '', 'osm:W100002']) {
      await expect(service.confirmCandidate(cacheId, bogus, admin.id)).rejects.toMatchObject({
        name: 'AuthError',
        code: 'VALIDATION',
      });
    }
    let row = (await cacheRows())[0]!;
    expect(row.status).toBe('review_required');
    expect(row.confirmedBy).toBeNull();

    const confirmed = await service.confirmCandidate(cacheId, 'osm:W100004', admin.id, {
      now: NOW,
    });
    expect(confirmed).toEqual({
      status: 'resolved',
      point: { latitude: 50.0021, longitude: 8.2691 },
      label: 'Am Markt, 55116 Mainz',
      candidates: [],
      cacheId,
    });
    row = (await cacheRows())[0]!;
    expect(row).toMatchObject({
      status: 'resolved',
      latitude: 50.0021,
      longitude: 8.2691,
      osmRef: 'osm:W100004',
      confirmedBy: admin.id,
      confirmedOsmRef: 'osm:W100004',
    });
    expect(row.confirmedAt?.getTime()).toBe(NOW.getTime());
    expect(row.expiresAt.getTime()).toBe(NOW.getTime() + GEOCODING_TTL_RESOLVED_MS);
    // Aus dem Cache, ohne Provider.
    const requestsBefore = fake.state.requests.length;
    expect((await service.resolve('Am Markt 3, 55116 Mainz', { now: NOW })).status).toBe(
      'resolved',
    );
    expect(fake.state.requests).toHaveLength(requestsBefore);

    // Cache abgelaufen: Provider liefert dieselbe Ref ⇒ resolved bleibt, Bestätigung erhalten.
    const later = new Date(NOW.getTime() + GEOCODING_TTL_RESOLVED_MS + 1000);
    const afterExpiry = await service.resolve('Am Markt 3, 55116 Mainz', { now: later });
    expect(afterExpiry.status).toBe('resolved');
    expect(afterExpiry.point).toEqual({ latitude: 50.0021, longitude: 8.2691 });
    expect(fake.state.requests).toHaveLength(requestsBefore + 1);
    row = (await cacheRows())[0]!;
    expect(row.confirmedOsmRef).toBe('osm:W100004');
    expect(row.confirmedBy).toBe(admin.id);
    expect(row.expiresAt.getTime()).toBe(later.getTime() + GEOCODING_TTL_RESOLVED_MS);

    // Liefert der Provider die bestätigte Ref nicht mehr, gibt es keine stille Übernahme.
    fake.state.geocode = () => [FAKE_HITS.amMarktA];
    const evenLater = new Date(later.getTime() + GEOCODING_TTL_RESOLVED_MS + 1000);
    const gone = await service.resolve('Am Markt 3, 55116 Mainz', { now: evenLater });
    expect(gone.status).toBe('review_required');
    expect(gone.candidates.map((candidate) => candidate.ref)).toEqual(['osm:W100003']);
  });

  it('T24. Geocoding-IDOR: unbekannte cacheId ⇒ NOT_FOUND; Kandidaten-Ref eines anderen Eintrags ⇒ VALIDATION – nichts verändert', async () => {
    const admin = await bootstrapAdmin(ctx);
    const a = await service.resolve('Am Markt 3, 55116 Mainz', { now: NOW });
    fake.state.geocode = () => [
      { ...FAKE_HITS.amMarktA, osm_id: 300001, street: 'Rheinstraße', postcode: '55116' },
      { ...FAKE_HITS.amMarktB, osm_id: 300002, street: 'Rheinstraße', postcode: '55116' },
    ];
    const b = await service.resolve('Rheinstraße 7, 55116 Mainz', { now: NOW });
    expect(a.status).toBe('review_required');
    expect(b.status).toBe('review_required');
    await expect(
      service.confirmCandidate('00000000-0000-4000-8000-000000000000', 'osm:W100003', admin.id),
    ).rejects.toMatchObject({ name: 'AuthError', code: 'NOT_FOUND' });
    // Ref aus Eintrag A gegen Eintrag B ⇒ abgelehnt.
    await expect(
      service.confirmCandidate(b.cacheId!, 'osm:W100003', admin.id),
    ).rejects.toBeInstanceOf(AuthError);
    const rows = await cacheRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'review_required' && row.confirmedBy === null)).toBe(
      true,
    );
  });

  it('Cache-TTL: abgelaufener Eintrag ohne Bestätigung ⇒ Provider erneut, Eintrag wird ersetzt (kein zweiter Datensatz)', async () => {
    const first = await service.resolve('Lieferweg 12, 55129 Mainz', { now: NOW });
    expect(first.status).toBe('resolved');
    const expired = new Date(NOW.getTime() + GEOCODING_TTL_RESOLVED_MS + 1);
    fake.state.geocode = () => [];
    const refreshed = await service.resolve('Lieferweg 12, 55129 Mainz', { now: expired });
    expect(refreshed.status).toBe('no_result');
    expect(refreshed.cacheId).toBe(first.cacheId);
    expect(fake.state.requests).toHaveLength(2);
    const rows = await cacheRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('no_result');
    expect(rows[0]!.fetchedAt.getTime()).toBe(expired.getTime());
    expect(rows[0]!.expiresAt.getTime()).toBe(expired.getTime() + GEOCODING_TTL_REVIEW_MS);
  });

  it('T15-Teil. Provider-Fehler (5xx/429/Timeout/401) ⇒ unavailable ohne Cache-Eintrag; vorhandener abgelaufener Eintrag bleibt unverändert', async () => {
    fake.state.failures.push({ endpoint: 'geocode', times: 1, status: 503 });
    const down = await service.resolve('Lieferweg 12, 55129 Mainz', { now: NOW });
    expect(down).toEqual({
      status: 'unavailable',
      point: null,
      label: null,
      candidates: [],
      cacheId: null,
    });
    expect(await cacheRows()).toHaveLength(0);
    fake.state.failures.push({
      endpoint: 'geocode',
      times: 1,
      status: 429,
      headers: { 'X-RateLimit-Reset': '20' },
    });
    expect((await service.resolve('Lieferweg 12, 55129 Mainz', { now: NOW })).status).toBe(
      'unavailable',
    );
    // Fix F1: während der 429-Pause (20 s) scheitert der Client sofort ⇒ weiterhin
    // unavailable, aber OHNE Provider-Request und ohne Schlafen.
    const requestsBefore = fake.state.requests.length;
    expect((await service.resolve('Lieferweg 12, 55129 Mainz', { now: NOW })).status).toBe(
      'unavailable',
    );
    expect(fake.state.requests).toHaveLength(requestsBefore);
    // Frischer Client (ohne Pause) für die übrigen Fehlerarten.
    const freshGateway = new GraphHopperRoutingGateway({
      apiKey: SYNTH_KEY,
      baseUrl: fake.baseUrl,
      timeoutMs: 2000,
      limiter: new InMemoryIntegrationRateLimiter({ provider: 'graphhopper', intervalMs: 0 }),
    });
    const freshService = new GeocodingService(ctx.db, freshGateway);
    fake.state.failures.push({ endpoint: 'geocode', times: 1, status: 401 });
    expect((await freshService.resolve('Lieferweg 12, 55129 Mainz', { now: NOW })).status).toBe(
      'unavailable',
    );
    expect(await cacheRows()).toHaveLength(0);

    const ok = await freshService.resolve('Lieferweg 12, 55129 Mainz', { now: NOW });
    expect(ok.status).toBe('resolved');
    const expired = new Date(NOW.getTime() + GEOCODING_TTL_RESOLVED_MS + 1);
    fake.state.failures.push({ endpoint: 'geocode', times: 1, mode: 'delay', delayMs: 3000 });
    const timeout = await freshService.resolve('Lieferweg 12, 55129 Mainz', { now: expired });
    expect(timeout.status).toBe('unavailable');
    expect(timeout.cacheId).toBe(ok.cacheId);
    const rows = await cacheRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('resolved');
    expect(rows[0]!.fetchedAt.getTime()).toBe(NOW.getTime());
    await new Promise((resolve) => setTimeout(resolve, 3200));
  });

  it('F6. Seed-Depots (Demo „Teststraße 1, 55129 Mainz-Hechtsheim (SYNTHETISCH)“, E2E „Robert-Koch-Straße 1, 55129 Mainz“) und vollständige Adressen lösen ohne Review auf; „Am Markt 1“ bleibt mehrdeutig, ohne Hausnummer Review, unbekannte PLZ kein Treffer', async () => {
    const demoDepot = 'Teststraße 1, 55129 Mainz-Hechtsheim (SYNTHETISCH)';
    const e2eDepot = 'Robert-Koch-Straße 1, 55129 Mainz';
    // Contract-Fake-Server (Integration/E2E) über den echten GeocodingService –
    // eigener Client, da der geteilte nach T15 noch in der 429-Pause sein kann (Fix F1).
    const service = new GeocodingService(
      ctx.db,
      new GraphHopperRoutingGateway({
        apiKey: SYNTH_KEY,
        baseUrl: fake.baseUrl,
        timeoutMs: 2000,
        limiter: new InMemoryIntegrationRateLimiter({ provider: 'graphhopper', intervalMs: 0 }),
      }),
    );
    const demo = await service.resolve(demoDepot, { now: NOW });
    expect(demo.status).toBe('resolved');
    expect(demo.point).toEqual({ latitude: 49.9545, longitude: 8.2735 });
    expect(demo.label).toBe('Teststraße 1, 55129 Mainz-Hechtsheim');
    const e2e = await service.resolve(e2eDepot, { now: NOW });
    expect(e2e.status).toBe('resolved');
    expect(e2e.point).toEqual({ latitude: 49.9545, longitude: 8.2735 });
    const any = await service.resolve('Ahornweg 7, 55128 Mainz', { now: NOW });
    expect(any.status).toBe('resolved');
    expect(any.point).not.toBeNull();
    // Deterministisch: gleiche Adresse ⇒ gleiche Koordinate (neuer Cache-Eintrag nicht nötig).
    await ctx.pool.query('TRUNCATE geocoding_cache CASCADE');
    expect((await service.resolve('Ahornweg 7, 55128 Mainz', { now: NOW })).point).toEqual(
      any.point,
    );
    expect((await service.resolve('Am Markt 1, 55116 Mainz', { now: NOW })).status).toBe(
      'review_required',
    );
    expect((await service.resolve('Ahornweg, 55128 Mainz', { now: NOW })).status).toBe(
      'review_required',
    );
    expect((await service.resolve('Gibtesnicht 1, 99999 Nirgendwo', { now: NOW })).status).toBe(
      'no_result',
    );
    // Demo-Mock (APP_ENV=demo) mit derselben Entscheidungsregel.
    const mock = new MockRoutingGateway();
    for (const text of [
      demoDepot,
      e2eDepot,
      'Ahornweg 7, 55128 Mainz',
      'Lieferweg 12, 55129 Mainz',
    ]) {
      const result = await mock.geocode({ query: `${text}, Deutschland`, limit: 5, locale: 'de' });
      expect(decideGeocoding(parseAddressInput(text), result.candidates).status).toBe('resolved');
    }
    const mockDepot = await mock.geocode({
      query: `${demoDepot}, Deutschland`,
      limit: 5,
      locale: 'de',
    });
    expect(mockDepot.candidates[0]!.point).toEqual({ latitude: 49.9545, longitude: 8.2735 });
    const noNumber = await mock.geocode({
      query: 'Ahornweg, 55128 Mainz, Deutschland',
      limit: 5,
      locale: 'de',
    });
    expect(
      decideGeocoding(parseAddressInput('Ahornweg, 55128 Mainz'), noNumber.candidates).status,
    ).toBe('review_required');
  });

  it('T7./T8. Key steht nie in der Datenbank und nie im Serverlog (Pino-Redaction unter allen Pfaden); App-Gateway läuft über die Fabrik', async () => {
    await service.resolve('Lieferweg 12, 55129 Mainz', { now: NOW });
    await service.resolve('Am Markt 3, 55116 Mainz', { now: NOW });
    const dump = await ctx.pool.query(`SELECT row_to_json(g)::text AS row FROM geocoding_cache g`);
    for (const entry of dump.rows as { row: string }[]) {
      expect(entry.row).not.toContain(SYNTH_KEY);
      expect(entry.row).not.toContain('key=');
    }
    expect(ctx.config.routing.provider).toBe('graphhopper');
    expect(ctx.config.routing.graphhopper.apiKey).toBe(SYNTH_KEY);
    ctx.app.log.info(
      {
        config: ctx.config,
        routing: ctx.config.routing,
        nested: { config: { routing: ctx.config.routing } },
        GRAPHHOPPER_API_KEY: SYNTH_KEY,
        env: { GRAPHHOPPER_API_KEY: SYNTH_KEY },
      },
      'Redaction-Beleg Phase 13',
    );
    const output = logLines.join('');
    expect(output).toContain('Redaction-Beleg Phase 13');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain(SYNTH_KEY);
    // Start-Log der Fabrik (beim Bauen der App) nennt nur den Provider – nie Key/URL.
    expect(startupLog).toContain('Routing: provider=graphhopper');
    expect(startupLog).not.toContain(SYNTH_KEY);
    expect(startupLog).not.toContain(fake.baseUrl);
  });
});
