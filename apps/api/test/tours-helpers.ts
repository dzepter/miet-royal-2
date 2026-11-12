/**
 * Phase 13 (Touren): Test-Helfer – zweite App-Instanz mit FakeRoutingGateway
 * und skriptbarem In-Test-Geocoding (gegen die Schnittstelle
 * routing/geocoding-types.ts), Buchungen mit Lieferadresse/Terminen, Fahrer
 * mit Rechten, Berliner Zeit-Helfer. Baut auf den bestehenden Helfern auf.
 */
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import {
  appointments,
  pushDeliveries,
  tourDelayIncidents,
  type Appointment,
  type TourDelayIncident,
} from '@mietroyal/database';
import { berlinDateOf, berlinDateTimeToUtc, berlinStartOfDay } from '@mietroyal/domain';
import type { PermissionKey } from '@mietroyal/permissions';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { AuthError } from '../src/auth/service.ts';
import { PushService } from '../src/communication/push/push-service.ts';
import { DelayEvaluationState } from '../src/tours/live/delay-state.ts';
import { createTourLiveModule, type TourLiveModule } from '../src/tours/live/module.ts';
import { getDepotAddress, resolveOperativeAddress } from '../src/routing/address-resolver.ts';
import { FakeRoutingGateway } from '../src/routing/fake.ts';
import type {
  GeocodingCandidateView,
  GeocodingResolution,
} from '../src/routing/geocoding-types.ts';
import { RoutingError, type RoutingGateway } from '../src/routing/types.ts';
import { TourService } from '../src/tours/tour-service.ts';
import type { TourGeocodingResolver } from '../src/tours/types.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createTestContext,
  login,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { setPickupExactAddress, truncateCommerceTables } from './commerce-helpers.ts';
import { truncateCommunicationTables } from './communication-helpers.ts';
import { createStaffWithPermissions, truncateCrmTables } from './crm-helpers.ts';
import {
  createAcceptedBooking,
  schedulingServiceFor,
  truncateSchedulingTables,
} from './scheduling-helpers.ts';

export async function truncateTourTables(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE tour_delay_incidents, tour_live_locations, tour_stops, tours, geocoding_cache CASCADE`,
  );
}

/**
 * In-Test-Geokodierung gegen die Schnittstelle: 0 Treffer ⇒ no_result,
 * 1 ⇒ resolved, mehrere ⇒ review_required; RoutingError ⇒ unavailable.
 * Skriptbar je Adresse (RegExp) und mit Cache-Stand für `peekCached`.
 */
export class TestGeocodingResolver implements TourGeocodingResolver {
  readonly calls: string[] = [];
  private readonly overrides: {
    match: RegExp;
    resolution: Omit<GeocodingResolution, 'cacheId'>;
  }[] = [];
  private readonly cache = new Map<string, GeocodingResolution>();
  private readonly cacheIds = new Map<string, string>();

  constructor(private readonly gateway: RoutingGateway) {}

  override(match: RegExp, resolution: Omit<GeocodingResolution, 'cacheId'>): void {
    this.overrides.push({ match, resolution });
  }

  reset(): void {
    this.calls.length = 0;
    this.overrides.length = 0;
    this.cache.clear();
  }

  private cacheIdFor(text: string): string {
    let id = this.cacheIds.get(text);
    if (id === undefined) {
      id = randomUUID();
      this.cacheIds.set(text, id);
    }
    return id;
  }

  async resolve(addressText: string): Promise<GeocodingResolution> {
    this.calls.push(addressText);
    const cacheId = this.cacheIdFor(addressText);
    const override = this.overrides.find((entry) => entry.match.test(addressText));
    if (override !== undefined) {
      const resolution = { ...override.resolution, cacheId };
      this.cache.set(addressText, resolution);
      return resolution;
    }
    let resolution: GeocodingResolution;
    try {
      const result = await this.gateway.geocode({
        query: `${addressText}, Deutschland`,
        limit: 5,
        locale: 'de',
      });
      const candidates: GeocodingCandidateView[] = result.candidates.map((c, index) => ({
        ref: c.ref ?? `cand:${index}`,
        label: c.label,
        point: c.point,
      }));
      if (candidates.length === 0) {
        resolution = { status: 'no_result', point: null, label: null, candidates: [], cacheId };
      } else if (candidates.length === 1) {
        resolution = {
          status: 'resolved',
          point: candidates[0]!.point,
          label: candidates[0]!.label,
          candidates: [],
          cacheId,
        };
      } else {
        resolution = { status: 'review_required', point: null, label: null, candidates, cacheId };
      }
    } catch (error) {
      if (!(error instanceof RoutingError)) throw error;
      return { status: 'unavailable', point: null, label: null, candidates: [], cacheId: null };
    }
    this.cache.set(addressText, resolution);
    return resolution;
  }

  async peekCached(addressText: string): Promise<GeocodingResolution | null> {
    return this.cache.get(addressText) ?? null;
  }

  async confirmCandidate(cacheId: string, candidateRef: string): Promise<GeocodingResolution> {
    for (const [text, resolution] of this.cache) {
      if (resolution.cacheId !== cacheId) continue;
      const candidate = resolution.candidates.find((c) => c.ref === candidateRef);
      if (candidate === undefined) {
        throw new AuthError(
          'VALIDATION',
          'Der gewählte Kandidat gehört nicht zu dieser Adressprüfung.',
        );
      }
      const resolved: GeocodingResolution = {
        status: 'resolved',
        point: candidate.point,
        label: candidate.label,
        candidates: [],
        cacheId,
      };
      this.cache.set(text, resolved);
      // Skript entfernen, damit die bestätigte Adresse ab jetzt aufgelöst ist.
      const index = this.overrides.findIndex((entry) => entry.match.test(text));
      if (index >= 0) this.overrides.splice(index, 1);
      return resolved;
    }
    throw new AuthError('NOT_FOUND', 'Adressprüfung nicht gefunden.');
  }
}

export interface ToursWorld {
  ctx: TestContext;
  /** App mit FakeRoutingGateway + In-Test-Geocoding (Sessions/DB wie ctx.app). */
  app: FastifyInstance;
  routing: FakeRoutingGateway;
  geocoding: TestGeocodingResolver;
  /** Phase 13 (tours-live): Bewertungsgedächtnis der App (geteilt mit `live`). */
  delayState: DelayEvaluationState;
  /** Phase 13 (tours-live): Live-Modul gegen dieselben Fakes/DB wie `app` (direkte Bewertung, Scanner). */
  live: TourLiveModule;
  /** Serverlog der Tour-App (Leak-Prüfungen) – nur mit `captureLog: true`. */
  logText: () => string;
}

export interface ToursWorldOptions {
  /** Pino-Stream der Tour-App auffangen (Level trace). */
  captureLog?: boolean;
  /** Rate-Limit der Standort-Updates (Default 10 s; Tests kürzer). */
  locationMinIntervalMs?: number;
  /** Phase 13 Final (§2.4): PostgreSQL-Pool der Test-App begrenzen (1 ⇒ jeder zweite Acquire in gehaltener Tx hängt). */
  poolMax?: number;
}

export async function createToursWorld(options: ToursWorldOptions = {}): Promise<ToursWorld> {
  const ctx = await createTestContext(
    options.poolMax === undefined ? {} : { poolMax: options.poolMax },
  );
  const routing = new FakeRoutingGateway();
  const geocoding = new TestGeocodingResolver(routing);
  const delayState = new DelayEvaluationState();
  const logChunks: string[] = [];
  const logDestination = new Writable({
    write(chunk, _encoding, callback) {
      logChunks.push(String(chunk));
      callback();
    },
  });
  const config =
    options.captureLog === true ? { ...ctx.config, logLevel: 'trace' as const } : ctx.config;
  const app = buildApp({
    config,
    pool: ctx.pool,
    mailAdapter: ctx.mail,
    rateLimitEnabled: false,
    storage: ctx.storage,
    accountingGateway: ctx.gateway,
    jobQueue: ctx.queue,
    lexwareContext: ctx.lexware,
    lexwareConnection: ctx.lexwareConnection,
    mailGateway: ctx.mailGateway,
    pushGateway: ctx.push,
    whatsappGateway: ctx.whatsapp,
    inboundMailSource: ctx.inboundMail,
    routingGateway: routing,
    geocodingResolver: geocoding,
    addressResolver: { resolveOperativeAddress, getDepotAddress },
    tourLiveOptions: {
      state: delayState,
      ...(options.locationMinIntervalMs === undefined
        ? {}
        : { locationMinIntervalMs: options.locationMinIntervalMs }),
    },
    ...(options.captureLog === true ? { logDestination } : {}),
  });
  await app.ready();
  const live = createTourLiveModule({
    db: ctx.db,
    tours: new TourService(ctx.db),
    routing,
    geocoding,
    addresses: { resolveOperativeAddress, getDepotAddress },
    push: new PushService(ctx.db, ctx.queue),
    auth: ctx.auth,
    state: delayState,
  });
  return { ctx, app, routing, geocoding, delayState, live, logText: () => logChunks.join('') };
}

export async function destroyToursWorld(world: ToursWorld): Promise<void> {
  await world.app.close();
  await world.ctx.app.close();
  await world.ctx.pool.end();
}

export async function resetToursWorld(world: ToursWorld): Promise<void> {
  // Phase 13 (tours-live): asynchrone Bewertungen (nach Tour-Antworten) abwarten, bevor TRUNCATE sperrt.
  await world.delayState.settle();
  await truncateTourTables(world.ctx.pool);
  await truncateSchedulingTables(world.ctx.pool);
  await truncateCrmTables(world.ctx.pool);
  await truncateAuthTables(world.ctx.pool);
  await truncateCommerceTables(world.ctx.pool);
  // Phase 13 (tours-live): Push-Outbox/Jobs/Kundenkommunikation leeren (Delay-Tests zählen Zeilen).
  await truncateCommunicationTables(world.ctx.pool);
  await world.ctx.pool.query('TRUNCATE push_deliveries, push_subscriptions CASCADE');
  world.routing.reset();
  world.geocoding.reset();
  world.delayState.reset();
  world.ctx.push.reset();
}

// ── Live-Standort (Phase 13, tours-live) ──────────────────────────────────

export interface LocationInput {
  latitude: number;
  longitude: number;
  accuracyMeters?: number | null;
  /** Default: jetzt. */
  observedAt?: Date | string;
}

/** POST /staff/tours/:id/location als der eingeloggte Nutzer der `api`. */
export async function sendLocation(
  api: ReturnType<typeof apiFor>,
  tourId: string,
  input: LocationInput,
): Promise<ApiResult> {
  const observedAt = input.observedAt ?? new Date();
  return api('POST', `/staff/tours/${tourId}/location`, {
    latitude: input.latitude,
    longitude: input.longitude,
    ...(input.accuracyMeters === undefined ? {} : { accuracyMeters: input.accuracyMeters }),
    observedAt: observedAt instanceof Date ? observedAt.toISOString() : observedAt,
  });
}

/**
 * Live-Standort direkt setzen (deterministische Delay-Tests ohne asynchrone Bewertung).
 * Phase 13 Final (§3): Genauigkeit Default 20 m (prognosefähig); `null` = unbekannt.
 */
export async function setLiveLocation(
  world: ToursWorld,
  tourId: string,
  userId: string,
  point: { latitude: number; longitude: number },
  observedAt = new Date(),
  accuracyMeters: number | null = 20,
): Promise<void> {
  await world.ctx.pool.query(
    `INSERT INTO tour_live_locations (tour_id, user_id, latitude, longitude, accuracy_meters, observed_at, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (tour_id) DO UPDATE SET user_id = EXCLUDED.user_id, latitude = EXCLUDED.latitude,
       longitude = EXCLUDED.longitude, accuracy_meters = EXCLUDED.accuracy_meters,
       observed_at = EXCLUDED.observed_at, received_at = now()`,
    [tourId, userId, point.latitude, point.longitude, accuracyMeters, observedAt.toISOString()],
  );
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function adminSession(world: ToursWorld) {
  const admin = await bootstrapAdmin(world.ctx);
  const session = await login(world.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  await setPickupExactAddress(world.ctx, admin.id);
  return { admin, cookie: session.cookie };
}

let staffCounter = 0;

/** Mitarbeiter mit exakt diesen Rechten (Fahrer: calendar.view). */
export async function staffWith(
  world: ToursWorld,
  adminId: string,
  permissionKeys: readonly PermissionKey[],
  label = 'Fahrer',
) {
  staffCounter += 1;
  return createStaffWithPermissions(world.ctx, adminId, {
    firstName: label,
    lastName: `Test${staffCounter}`,
    email: `${label.toLowerCase()}-${staffCounter}@test.example`,
    password: `${label.toLowerCase()}-passwort-12345`,
    permissionKeys,
  });
}

export const DRIVER_PERMISSIONS: readonly PermissionKey[] = ['calendar.view'];
export const PLANNER_PERMISSIONS: readonly PermissionKey[] = [
  'calendar.view',
  'calendar.view_all',
  'calendar.manage',
  'appointment.assign',
  'appointment.reassign_same_day',
  'calendar.drag_drop',
];

// ── Zeit ──────────────────────────────────────────────────────────────────

export const HOURS = 3_600_000;

export function todayBerlin(): string {
  return berlinDateOf(new Date());
}

export function dateInDays(days: number): string {
  const [y, m, d] = todayBerlin().split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

/** Zeitpunkt „HH:MM Berlin“ an einem ISO-Tag. */
export function berlinAt(dateIso: string, hour: number, minute = 0): Date {
  return berlinDateTimeToUtc(dateIso, hour, minute);
}

// ── Testuhr (Phase 17, Order §27 B) ───────────────────────────────────────

/** Ab dieser Berliner Wanduhrzeit (Minuten seit 0:00) wird die Testuhr zurückgedreht. */
export const EVENING_PIN_FROM_MINUTE = 19 * 60;
/** Zielzeit des Pins: 09:00 Berlin desselben Tages (lässt `inMinutes(+240)` bis 13:00 zu). */
export const MORNING_PIN_HOUR = 9;
/** Test-Env (NUR hier gelesen): erzwingt den Pin, um den Fake-Uhr-Pfad auch vormittags zu beweisen. */
export const FORCE_EVENING_PIN_ENV = 'MR_TEST_FORCE_EVENING_PIN';

export interface MorningClockPinOptions {
  /** Echte Uhr (Standard `new Date()`) – nur für Tests des Helfers selbst. */
  now?: Date;
  /** Pin unabhängig von der Uhrzeit erzwingen (Standard: `MR_TEST_FORCE_EVENING_PIN=1`). */
  force?: boolean;
}

/** Berliner Wanduhr „HH:MM“ (h23). */
export function berlinClockOf(at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

/** Berliner Wanduhr-Minuten seit 0:00 (DST-korrekt über Intl, nicht über Tagesanfang gerechnet). */
export function berlinMinutesOfDay(at: Date): number {
  const [h, m] = berlinClockOf(at).split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Abends (ab 19:00 Uhr Berlin) die Testuhr auf 09:00 DESSELBEN Berliner Tages zurückdrehen –
 * in `beforeAll` VOR `createToursWorld` und dem ersten `inMinutes`; Rückgabe für `afterAll`.
 *
 * Warum: Die Touren-Tests legen Termine mit `inMinutes(+N)` (bis +240) an und verlangen das
 * heutige Berliner Tourdatum (`todayBerlin()`). Die Produktregel APPOINTMENT_NOT_ON_TOUR_DATE
 * (tour-service.ts `addStop`) lehnt Termine ab, die ab etwa 20:00 Uhr auf den Folgetag
 * rutschen; TOUR_NOT_TODAY erlaubt Tourstarts nur am heutigen Tag, ein „Tourdatum morgen“
 * ist deshalb keine Option. Die Produktlogik bleibt unverändert – gefälscht wird allein die
 * Uhr des Testprozesses (die App läuft in-process, ihre `new Date()` sind dieselbe Uhr).
 *
 * NUR RÜCKWÄRTS, nie vorwärts: `staff_sessions.last_activity_at` wird beim Login per
 * DB-`defaultNow()` (echte Uhr) gesetzt und in `authenticate` mit `Date.now()` verglichen –
 * eine um mehr als APP_LOCK_MS (15 min) vorgestellte Testuhr liefert für JEDEN Request
 * APP_LOCKED. Rückwärts ergibt sich nur negative Inaktivität (unkritisch). Vor 09:00 Berlin
 * ist der Helfer darum auch mit `force` wirkungslos (Warnung statt Vorwärtsdrehen).
 *
 * Nur `Date` wird gefälscht (`toFake: ['Date']`); Timer bleiben echt (`sleep`, pg-Timeouts,
 * `delayState.settle()`). `shouldAdvanceTime: true` lässt die Fake-Uhr weiterlaufen, damit
 * Reihenfolgen wie „Anton zuerst“ (`startedAt`, tours-multi-active V2) unterscheidbar bleiben.
 * Tagsüber ist der Helfer eine No-op – der Produktpfad läuft dann ohne Fake.
 */
export function pinMorningClockIfEvening(options: MorningClockPinOptions = {}): () => void {
  const now = options.now ?? new Date();
  const force = options.force ?? process.env[FORCE_EVENING_PIN_ENV] === '1';
  if (!force && berlinMinutesOfDay(now) < EVENING_PIN_FROM_MINUTE) return () => {};
  const today = berlinDateOf(now);
  const clock = berlinClockOf(now);
  const target = berlinAt(today, MORNING_PIN_HOUR, 0);
  if (target.getTime() >= now.getTime()) {
    console.warn(
      `[tours-helpers] Testuhr-Pin übersprungen: ${today} ${clock} Berlin liegt nicht nach 09:00 (nie vorwärts).`,
    );
    return () => {};
  }
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(target);
  console.warn(
    `[tours-helpers] Testuhr auf ${today} 09:00 Berlin zurückgedreht (Uhr ${clock}${force ? ', erzwungen' : ''}).`,
  );
  return () => vi.useRealTimers();
}

// ── Buchungen / Termine ───────────────────────────────────────────────────

export interface BookingWithAppointments {
  processId: string;
  bookingId: string;
  customerId: string;
  /** Liefer- bzw. Abholtermin. */
  outbound: Appointment;
  inbound: Appointment;
}

/**
 * Bestätigte Buchung (echter Annahmepfad) mit Terminen; Lieferadresse der
 * Buchung ist „Lieferweg 12, 55129 Mainz“ (bekannte Mock-Adresse) – optional
 * im Termin-Snapshot auf eine andere Straße gesetzt (deterministische Mock-
 * Koordinate je Adresse). Zeiten werden über die bestehende Terminplanung
 * gesetzt (reschedule).
 */
export async function bookingWithAppointments(
  world: ToursWorld,
  adminId: string,
  options: {
    fulfillment?: 'delivery' | 'pickup';
    assignTo?: string | null;
    outboundStartAt?: Date | null;
    outboundEndAt?: Date | null;
    inboundStartAt?: Date | null;
    inboundEndAt?: Date | null;
    street?: string;
    eventInDays?: number;
  } = {},
): Promise<BookingWithAppointments> {
  const { ctx } = world;
  const fulfillment = options.fulfillment ?? 'delivery';
  const booked = await createAcceptedBooking(ctx, adminId, {
    fulfillment,
    eventInDays: options.eventInDays ?? 30,
    ...(options.assignTo === undefined || options.assignTo === null
      ? {}
      : { assignProcessTo: options.assignTo }),
  });
  const scheduling = schedulingServiceFor(ctx);
  await scheduling.ensureAppointmentsForBooking(booked.bookingId);
  const rows = await ctx.db
    .select()
    .from(appointments)
    .where(eq(appointments.bookingId, booked.bookingId));
  const outboundKind = fulfillment === 'delivery' ? 'delivery' : 'pickup';
  let outbound = rows.find((row) => row.kind === outboundKind)!;
  let inbound = rows.find((row) => row.kind === 'return')!;
  if (options.street !== undefined && fulfillment === 'delivery') {
    for (const row of [outbound, inbound]) {
      await ctx.db
        .update(appointments)
        .set({ locationSnapshot: { street: options.street, postalCode: '55128', city: 'Mainz' } })
        .where(eq(appointments.id, row.id));
    }
  }
  if (options.outboundStartAt !== undefined) {
    await scheduling.reschedule(adminId, outbound.id, {
      startAt: options.outboundStartAt,
      endAt: options.outboundEndAt ?? null,
      expectedVersion: outbound.version,
    });
  }
  if (options.inboundStartAt !== undefined) {
    await scheduling.reschedule(adminId, inbound.id, {
      startAt: options.inboundStartAt,
      endAt: options.inboundEndAt ?? null,
      expectedVersion: inbound.version,
    });
  }
  outbound = (await appointmentRow(world, outbound.id))!;
  inbound = (await appointmentRow(world, inbound.id))!;
  return {
    processId: booked.processId,
    bookingId: booked.bookingId,
    customerId: booked.customerId,
    outbound,
    inbound,
  };
}

export async function appointmentRow(world: ToursWorld, id: string): Promise<Appointment | null> {
  const rows = await world.ctx.db.select().from(appointments).where(eq(appointments.id, id));
  return rows[0] ?? null;
}

/** Fachlicher Abschluss wie Übergabe/Rückgabe (completeWithin) – Stopp ⇒ done. */
export async function completeAppointment(
  world: ToursWorld,
  actorId: string,
  appointmentId: string,
): Promise<void> {
  const scheduling = schedulingServiceFor(world.ctx);
  await world.ctx.db.transaction((tx) => scheduling.completeWithin(tx, actorId, appointmentId));
}

// ── API ───────────────────────────────────────────────────────────────────

export interface ApiResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export function apiFor(app: FastifyInstance, cookie: string) {
  return async (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
    url: string,
    payload?: unknown,
  ): Promise<ApiResult> => {
    const response = await app.inject({
      method,
      url,
      headers: { cookie },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    // Phase 13 (tours-live): 204-Antworten (Standort-Update) haben keinen Body.
    return { status: response.statusCode, body: response.body === '' ? null : response.json() };
  };
}

/** JSON der Tour-View (TourView) – in Tests bewusst untypisiert. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TourJson = any;

export async function createTour(
  api: ReturnType<typeof apiFor>,
  input: { tourDate: string; assignedUserId: string },
) {
  const result = await api('POST', '/staff/tours', input);
  if (result.status !== 200)
    throw new Error(`Tour anlegen fehlgeschlagen: ${JSON.stringify(result.body)}`);
  return result.body.tour as TourJson;
}

export async function addStop(
  api: ReturnType<typeof apiFor>,
  tourId: string,
  appointmentId: string,
  extra: { expectedVersion?: number; reassign?: boolean } = {},
): Promise<ApiResult> {
  return api('POST', `/staff/tours/${tourId}/stops`, { appointmentId, ...extra });
}

/** Tour mit Stopps aus Terminen anlegen (Admin) – Rückgabe: Tour-View. */
export async function tourWithStops(
  api: ReturnType<typeof apiFor>,
  input: { tourDate: string; assignedUserId: string; appointmentIds: readonly string[] },
) {
  const tour = await createTour(api, {
    tourDate: input.tourDate,
    assignedUserId: input.assignedUserId,
  });
  let view = tour;
  for (const appointmentId of input.appointmentIds) {
    const result = await addStop(api, tour.id, appointmentId);
    if (result.status !== 200) {
      throw new Error(`Stopp hinzufügen fehlgeschlagen: ${JSON.stringify(result.body)}`);
    }
    view = result.body.tour;
  }
  return view as TourJson;
}

export async function getTour(api: ReturnType<typeof apiFor>, tourId: string) {
  const result = await api('GET', `/staff/tours/${tourId}`);
  if (result.status !== 200) throw new Error(`Tour laden: ${JSON.stringify(result.body)}`);
  return result.body.tour;
}

// ── Phase 13 Final: gemeinsame Fixtures der Delay-/Push-/Genauigkeits-/Konflikt-Tests ──

export const MINUTES = 60_000;
/** Fahrer-Position weit vom Ziel (Koordinate geht nur an das Fake-Gateway). */
export const DRIVER_POINT = { latitude: 49.99, longitude: 8.24 };
/** Nahe am Ziel „Lieferweg 12“. */
export const NEAR_POINT = { latitude: 49.9742, longitude: 8.2566 };

/**
 * Feste Fahrzeiten: Zeile 0 = Live-Standort, danach die Stopps in Tour-Reihenfolge.
 * `fromOrigin[i]` = Sekunden Standort → Stopp i+1, `between` = Sekunden zwischen Stopps.
 */
export function configureFixedMatrix(world: ToursWorld, fromOrigin: number[], between = 600): void {
  world.routing.configure({
    matrix: (request) => {
      const n = request.points.length;
      const durationsSeconds: (number | null)[][] = [];
      const distancesMeters: (number | null)[][] = [];
      for (let i = 0; i < n; i += 1) {
        const row: (number | null)[] = [];
        for (let j = 0; j < n; j += 1) {
          if (i === j) row.push(0);
          else if (i === 0) row.push(fromOrigin[j - 1] ?? between);
          else if (j === 0) row.push(fromOrigin[i - 1] ?? between);
          else row.push(between);
        }
        durationsSeconds.push(row);
        distancesMeters.push(row.map((value) => (value === null ? null : value * 11)));
      }
      return { durationsSeconds, distancesMeters };
    },
  });
}

/**
 * Zeitpunkt relativ zu jetzt; Vergangenheitswerte bleiben am heutigen Berliner Tag
 * (Tourdatum), damit Läufe kurz nach Mitternacht nicht an „Termin nicht am Tourdatum“ scheitern.
 */
export function inMinutes(minutes: number): Date {
  const at = Date.now() + minutes * MINUTES;
  const dayStart = berlinStartOfDay(todayBerlin()).getTime() + MINUTES;
  return new Date(minutes < 0 ? Math.max(at, dayStart) : at);
}

export interface ActiveTourStopSpec {
  startAt: Date;
  endAt?: Date | null;
  street: string;
  bufferMinutes?: number;
}

/**
 * Aktive Tour eines Fahrers (calendar.view) mit Stopps (Zeiten relativ zu jetzt) und
 * – sofern nicht abgeschaltet – frischem Live-Standort (Default: genau, 20 m).
 */
export async function startActiveTour(
  world: ToursWorld,
  stops: readonly ActiveTourStopSpec[],
  options: {
    driverLabel?: string;
    /** Genauigkeit des initialen Live-Standorts (null = unbekannt). */
    accuracyMeters?: number | null;
    /** false ⇒ kein Live-Standort setzen. */
    liveLocation?: boolean;
    /** Rechte des Fahrers (Default calendar.view; P3: Fahrer zugleich Planer). */
    driverPermissions?: readonly PermissionKey[];
  } = {},
) {
  const { admin, cookie } = await adminSession(world);
  const api = apiFor(world.app, cookie);
  const driver = await staffWith(
    world,
    admin.id,
    options.driverPermissions ?? DRIVER_PERMISSIONS,
    options.driverLabel ?? 'Fahrer',
  );
  const driverApi = apiFor(world.app, driver.cookie);
  const today = todayBerlin();
  const bookings: BookingWithAppointments[] = [];
  for (const spec of stops) {
    bookings.push(
      await bookingWithAppointments(world, admin.id, {
        assignTo: driver.user.id,
        outboundStartAt: spec.startAt,
        outboundEndAt: spec.endAt ?? null,
        street: spec.street,
      }),
    );
  }
  let tour = await tourWithStops(api, {
    tourDate: today,
    assignedUserId: driver.user.id,
    appointmentIds: bookings.map((b) => b.outbound.id),
  });
  for (let i = 0; i < stops.length; i += 1) {
    const buffer = stops[i]!.bufferMinutes;
    if (buffer === undefined) continue;
    const patched = await api('PATCH', `/staff/tours/${tour.id}/stops/${tour.stops[i].id}`, {
      bufferMinutes: buffer,
    });
    if (patched.status !== 200) throw new Error(`Puffer setzen: ${JSON.stringify(patched.body)}`);
    tour = patched.body.tour;
  }
  const started = await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
  if (started.status !== 200) throw new Error(`Tour starten: ${JSON.stringify(started.body)}`);
  tour = started.body.tour;
  if (options.liveLocation !== false) {
    await setLiveLocation(
      world,
      tour.id,
      driver.user.id,
      DRIVER_POINT,
      new Date(),
      options.accuracyMeters === undefined ? 20 : options.accuracyMeters,
    );
  }
  // Asynchrone Bewertungen aus der Planungsphase (Stopp hinzufügen/Start) abwarten.
  await world.delayState.settle();
  return {
    admin,
    adminCookie: cookie,
    api,
    driver: driver.user,
    driverCookie: driver.cookie,
    driverApi,
    today,
    tour,
    bookings,
  };
}

export async function delayIncidents(
  world: ToursWorld,
  tourId: string,
): Promise<TourDelayIncident[]> {
  return world.ctx.db
    .select()
    .from(tourDelayIncidents)
    .where(eq(tourDelayIncidents.tourId, tourId))
    .orderBy(asc(tourDelayIncidents.detectedAt));
}

export async function delayDeliveries(world: ToursWorld, kind = 'tour_delay_risk') {
  return world.ctx.db
    .select()
    .from(pushDeliveries)
    .where(eq(pushDeliveries.kind, kind))
    .orderBy(asc(pushDeliveries.createdAt));
}

export function pushEndpointFor(label: string): string {
  return `https://push.example.test/send/${label}-${'e'.repeat(40)}`;
}

/** Push-Subscription anlegen (Versand bis zum Fake-Gateway) – Rückgabe: HTTP-Status. */
export async function subscribePush(
  world: ToursWorld,
  cookie: string,
  label: string,
): Promise<number> {
  const response = await world.app.inject({
    method: 'POST',
    url: '/staff/push/subscriptions',
    headers: { cookie },
    payload: {
      endpoint: pushEndpointFor(label),
      keys: { p256dh: 'BPk'.padEnd(87, 'A'), auth: 'auth-secret-16by' },
    },
  });
  return response.statusCode;
}
