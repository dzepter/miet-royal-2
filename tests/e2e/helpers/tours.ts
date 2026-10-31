import { execFileSync } from 'node:child_process';
import { expect, type Page } from '@playwright/test';
import { TEST_DATABASE_URL } from './seed.ts';
import { queryTestDb } from './voucher.ts';

/**
 * Phase 13 (E2E): Helfer der Touren-Szenarien A–O.
 *
 * - `seedTours`/`completeAppointmentViaSeed`/`travelStatusViaSeed`: Kindprozess
 *   `apps/api/scripts/e2e-tours-seed.ts` (bestehende API-Test-Helfer: echter
 *   Annahmepfad, Terminplanung, Mitarbeiter mit Rechten) – Ausgabe als JSON.
 * - Datenbank-Lesezugriffe (nur Testdatenbank) wie in helpers/voucher.ts.
 * - Zeit-Helfer rechnen in Europe/Berlin (Termine „heute“ relativ zu jetzt).
 *   Phase 14: `fitTodayTimeline`/`todayWindow` klemmen auf den Berliner Tag
 *   (spätestens 23:58), garantieren Fenster ≥ 15 min und Beginn ≥ jetzt + 5 min
 *   und stauchen bei knappem Resttag die Abstände proportional – nie unter die
 *   Fahrzeit-/Puffer-Ketten der Szenarien (`minGap`). Passt selbst der minimale
 *   Plan nicht mehr in den Tag, bricht der Aufruf mit „Resttag zu kurz“ ab
 *   (inkl. Sperrfenster), statt still ungültige Termine anzulegen.
 * - `fakeDrivingMinutes`/`pointAtFakeEta`: simulierte Fahrerpositionen mit
 *   definierter Fake-Fahrzeit (Szenario G) – spiegeln nur das Fake-Modell.
 */

const REPO_ROOT = `${import.meta.dirname}/../../..`;

export interface ToursSeedUser {
  key: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  permissions: string[];
}

export interface ToursSeedBooking {
  key: string;
  fulfillment?: 'delivery' | 'pickup';
  customer?: { firstName: string; lastName: string };
  address?: { street: string; postalCode: string; city: string };
  outbound?: { startAt: string; endAt?: string | null } | null;
  inbound?: { startAt: string; endAt?: string | null } | null;
  assignTo?: string;
}

export interface ToursSeedInput {
  adminEmail: string;
  depotAddress?: string | null;
  users?: ToursSeedUser[];
  bookings?: ToursSeedBooking[];
}

export interface SeededAppointment {
  id: string;
  kind: 'delivery' | 'pickup' | 'return';
  version: number;
  status: string;
}

export interface SeededBooking {
  processId: string;
  processNumber: string;
  bookingId: string;
  customerId: string;
  outbound: SeededAppointment;
  inbound: SeededAppointment;
}

export interface ToursSeedResult {
  users: Record<string, { id: string; email: string }>;
  bookings: Record<string, SeededBooking>;
}

function runSeedScript<T>(databaseUrl: string, input: Record<string, unknown>): T {
  const output = execFileSync(
    'pnpm',
    ['--filter', '@mietroyal/api', 'exec', 'tsx', 'scripts/e2e-tours-seed.ts'],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
      env: {
        ...process.env,
        APP_ENV: 'development',
        TEST_DATABASE_URL: databaseUrl,
        LOG_LEVEL: 'error',
        E2E_TOURS_INPUT: JSON.stringify(input),
      },
    },
  );
  const lines = output.toString('utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1] ?? '{}') as T;
}

export function seedTours(input: ToursSeedInput, databaseUrl = TEST_DATABASE_URL): ToursSeedResult {
  return runSeedScript<ToursSeedResult>(databaseUrl, { mode: 'seed', ...input });
}

/** Fachlicher Abschluss eines Termins wie Übergabe/Rückgabe (SchedulingService.completeWithin). */
export function completeAppointmentViaSeed(
  adminEmail: string,
  appointmentId: string,
): SeededAppointment {
  return runSeedScript<{ completed: SeededAppointment }>(TEST_DATABASE_URL, {
    mode: 'complete',
    adminEmail,
    appointmentId,
  }).completed;
}

/** Interner Status „Unterwegs“ (getCustomerTravelStatus – kein Endpunkt, Szenario L). */
export function travelStatusViaSeed(bookingId: string): 'none' | 'en_route' {
  return runSeedScript<{ status: 'none' | 'en_route' }>(TEST_DATABASE_URL, {
    mode: 'travel-status',
    bookingId,
  }).status;
}

// ── Datenbank (nur lesen) ───────────────────────────────────────────────

export interface TourDbRow {
  id: string;
  status: string;
  planning_status: string;
  assigned_user_id: string;
  version: number;
  end_reason: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export function tourRow(tourId: string): TourDbRow {
  const rows = queryTestDb<TourDbRow>('SELECT * FROM tours WHERE id = $1', [tourId]);
  expect(rows, 'Tourzeile').toHaveLength(1);
  return rows[0]!;
}

export interface LiveLocationDbRow {
  tour_id: string;
  user_id: string;
  latitude: number;
  longitude: number;
  observed_at: string;
}

export function liveLocations(tourId: string): LiveLocationDbRow[] {
  return queryTestDb<LiveLocationDbRow>(
    'SELECT tour_id, user_id, latitude, longitude, observed_at FROM tour_live_locations WHERE tour_id = $1',
    [tourId],
  );
}

export interface DelayIncidentDbRow {
  id: string;
  tour_id: string;
  stop_id: string;
  resolved_at: string | null;
  notification_enqueued_at: string | null;
}

export function delayIncidents(tourId: string): DelayIncidentDbRow[] {
  return queryTestDb<DelayIncidentDbRow>(
    'SELECT id, tour_id, stop_id, resolved_at, notification_enqueued_at FROM tour_delay_incidents WHERE tour_id = $1 ORDER BY detected_at ASC',
    [tourId],
  );
}

export interface AppointmentDbRow {
  id: string;
  kind: string;
  status: string;
  start_at: string | null;
  end_at: string | null;
  assigned_user_id: string | null;
  version: number;
}

export function appointmentRow(appointmentId: string): AppointmentDbRow {
  const rows = queryTestDb<AppointmentDbRow>(
    'SELECT id, kind, status, start_at, end_at, assigned_user_id, version FROM appointments WHERE id = $1',
    [appointmentId],
  );
  expect(rows, 'Terminzeile').toHaveLength(1);
  return rows[0]!;
}

export interface PushDeliveryDbRow {
  id: string;
  kind: string;
  user_id: string;
  status: string;
}

export function pushDeliveriesOfKind(kind: string): PushDeliveryDbRow[] {
  return queryTestDb<PushDeliveryDbRow>(
    'SELECT id, kind, user_id, status FROM push_deliveries WHERE kind = $1 ORDER BY created_at ASC',
    [kind],
  );
}

export function tableCount(
  table: 'mail_deliveries' | 'conversation_messages' | 'whatsapp_events',
): number {
  const rows = queryTestDb<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(rows[0]?.n ?? '0');
}

// ── Zeit (Europe/Berlin) ─────────────────────────────────────────────────

export function berlinTodayIso(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Minuten seit Mitternacht (Berlin). */
export function berlinMinutesOfDay(now = new Date()): number {
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  const [h, m] = text.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** UTC-Offset (Minuten) von Europe/Berlin für einen Zeitpunkt. */
function berlinOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Berlin',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** Zeitpunkt „heute (Berlin) um HH:MM“ als Date (UTC-korrekt). */
export function berlinTodayAt(minutesOfDay: number, now = new Date()): Date {
  const [y, m, d] = berlinTodayIso(now).split('-').map(Number);
  const naive = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 0, 0, 0) + minutesOfDay * 60_000;
  // Offset am Zieltag bestimmen (DST-sicher genug für Testzwecke).
  const offset = berlinOffsetMinutes(new Date(naive));
  return new Date(naive - offset * 60_000);
}

/** „HH:MM“ (Berlin) eines Zeitpunkts – wie die Staff-App (berlinTime). */
export function berlinClock(at: Date | string): string {
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(typeof at === 'string' ? new Date(at) : at);
}

function clockOfMinute(minuteOfDay: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)}`;
}

// ── Tagesplan „heute relativ zu jetzt“ (Phase 14) ────────────────────────

/** Letzte Minute des Berliner Tages; Termine liegen nie später. */
const DAY_END_MINUTE = 23 * 60 + 59;
/** Reserve vor Tagesende: der späteste Zeitpunkt eines Plans ist 23:58. */
const DAY_END_RESERVE_MINUTES = 1;
/** Kürzestes Zeitfenster, das die Specs anlegen (Order §3 verlangt nur Ende > Beginn). */
export const MIN_WINDOW_MINUTES = 15;
/** Termine, die „in der Zukunft“ liegen müssen, beginnen nie vor jetzt + 5 min. */
export const FUTURE_FLOOR_MINUTES = 5;

export interface TimelinePoint {
  /**
   * Minuten nach „jetzt“ im ungestauchten Plan. Negativ = bewusst in der
   * Vergangenheit: bleibt unverändert (nur auf 00:01 des Tages geklemmt).
   */
  at: number;
  /**
   * Mindestabstand (Minuten) zum vorherigen Punkt des Plans (beim ersten
   * Punkt: zu „jetzt“) – die Fahrzeit-/Puffer-Kette des Szenarios, die auch
   * ein gestauchter Plan einhalten muss. Standard 0.
   */
  minGap?: number;
}

export interface TodayTimeline<K extends string> {
  /** Stauchungsfaktor der Abstände: 1 = Plan unverändert, < 1 = Resttag knapp. */
  factor: number;
  /** Minuten von jetzt bis 23:58 (Berlin). */
  availableMinutes: number;
  /** Minuten relativ zu jetzt (gestaucht/geklemmt). */
  minutes: Record<K, number>;
  at: Record<K, Date>;
  iso: Record<K, string>;
}

/**
 * Zeitpunkte „heute, N Minuten nach jetzt“ (Europe/Berlin) für ein Szenario.
 *
 * Passt der Plan in den Resttag (bis 23:58), bleibt er unverändert. Sonst
 * werden alle Abstände zwischen den (nach `at` sortierten) Punkten mit einem
 * Faktor f ∈ (0, 1) gestaucht – jeder Abstand aber nie unter sein `minGap`,
 * der erste Punkt nie vor jetzt + 5 min. Passt nicht einmal der minimale
 * Plan (alle Abstände = minGap), wird mit „Resttag zu kurz“ abgebrochen; die
 * Meldung nennt das Sperrfenster. Ganze Minuten; Fenster sind damit immer
 * gültig, solange `minGap` des Fensterendes ≥ MIN_WINDOW_MINUTES ist.
 */
export function fitTodayTimeline<K extends string>(
  points: Record<K, TimelinePoint>,
  now = new Date(),
): TodayTimeline<K> {
  const nowMinute = berlinMinutesOfDay(now);
  const availableMinutes = DAY_END_MINUTE - DAY_END_RESERVE_MINUTES - nowMinute;
  const keys = (Object.keys(points) as K[]).sort((a, b) => points[a].at - points[b].at);
  const future = keys.filter((key) => points[key].at >= 0);
  future.forEach((key, index) => {
    const previous = index === 0 ? 0 : points[future[index - 1]!].at;
    const gap = points[key].at - previous;
    if ((points[key].minGap ?? 0) > gap) {
      throw new Error(
        `Zeitplan: minGap von ${key} (${points[key].minGap} min) ist größer als der Abstand im ungestauchten Plan (${gap} min).`,
      );
    }
  });
  const offsetsFor = (factor: number): Map<K, number> => {
    const offsets = new Map<K, number>();
    let previous: { at: number; offset: number } | null = null;
    for (const key of future) {
      const point = points[key];
      const scaled = Math.round((point.at - (previous?.at ?? 0)) * factor);
      const offset: number =
        previous === null
          ? Math.max(FUTURE_FLOOR_MINUTES, point.minGap ?? 0, scaled)
          : previous.offset + Math.max(point.minGap ?? 0, scaled);
      offsets.set(key, offset);
      previous = { at: point.at, offset };
    }
    return offsets;
  };
  const spanOf = (offsets: Map<K, number>): number => Math.max(0, ...offsets.values());

  let factor = 1;
  let offsets = offsetsFor(factor);
  if (spanOf(offsets) > availableMinutes) {
    const needed = spanOf(offsetsFor(0));
    if (needed > availableMinutes) {
      const latestStart = DAY_END_MINUTE - DAY_END_RESERVE_MINUTES - needed;
      throw new Error(
        `Resttag zu kurz: ${berlinClock(now)} Uhr Berlin, ${availableMinutes} min bis 23:58, ` +
          `der Zeitplan braucht mindestens ${needed} min. Lauf nicht zwischen ` +
          `${clockOfMinute(latestStart)} und 00:02 Uhr Berlin starten.`,
      );
    }
    let low = 0;
    let high = 1;
    for (let step = 0; step < 40; step += 1) {
      const mid = (low + high) / 2;
      if (spanOf(offsetsFor(mid)) <= availableMinutes) low = mid;
      else high = mid;
    }
    factor = low;
    offsets = offsetsFor(factor);
  }
  for (const key of keys) {
    // Vergangenheit bleibt Vergangenheit – aber am heutigen Berliner Tag (frühestens 00:01).
    if (points[key].at < 0) offsets.set(key, Math.max(points[key].at, 1 - nowMinute));
  }

  const minutes = {} as Record<K, number>;
  const at = {} as Record<K, Date>;
  const iso = {} as Record<K, string>;
  for (const key of keys) {
    const offset = offsets.get(key)!;
    minutes[key] = offset;
    at[key] = berlinTodayAt(nowMinute + offset, now);
    iso[key] = at[key].toISOString();
  }
  return { factor, availableMinutes, minutes, at, iso };
}

/**
 * Einzelnes Zeitfenster „heute, von jetzt + start bis jetzt + end Minuten“:
 * auf den Tag geklemmt, Beginn ≥ jetzt + 5 min, Ende ≥ Beginn + 15 min
 * (bei knappem Resttag proportional gestaucht; sonst Fehler „Resttag zu kurz“).
 */
export function todayWindow(
  startMinutes: number,
  endMinutes: number,
  now = new Date(),
): { startAt: Date; endAt: Date } {
  const timeline = fitTodayTimeline(
    { start: { at: startMinutes }, end: { at: endMinutes, minGap: MIN_WINDOW_MINUTES } },
    now,
  );
  return { startAt: timeline.at.start, endAt: timeline.at.end };
}

// ── Routing-Fake: simulierte Positionen (Szenario G) ─────────────────────

export interface GeoPointLike {
  latitude: number;
  longitude: number;
}

/** Kundenpunkt „Lieferweg 12“ des Fakes/Mocks (routing/fake.ts MOCK_CUSTOMER_POINT). */
export const LIEFERWEG_POINT: GeoPointLike = { latitude: 49.9742, longitude: 8.2566 };

/**
 * Fahrzeit des Routing-Fakes/-Mocks in Minuten (apps/api/src/routing/fake.ts
 * `mockLeg`: Luftlinie × 1,3 bei 40 km/h) – NUR zur Wahl simulierter
 * Fahrerpositionen; die fachliche Bewertung macht die API gegen den
 * GraphHopper-Contract-Fake.
 */
export function fakeDrivingMinutes(from: GeoPointLike, to: GeoPointLike): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(to.latitude - from.latitude);
  const dLon = toRad(to.longitude - from.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.latitude)) * Math.cos(toRad(to.latitude)) * Math.sin(dLon / 2) ** 2;
  const meters = Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)) * 1.3);
  return Math.round((meters / 40_000) * 3600) / 60;
}

/**
 * Punkt auf der Geraden von `target` in Richtung `towards` (auch darüber
 * hinaus), der laut Fake-Modell `minutes` Fahrzeit vom Ziel entfernt ist.
 */
export function pointAtFakeEta(
  target: GeoPointLike,
  towards: GeoPointLike,
  minutes: number,
): GeoPointLike {
  const pointAt = (share: number): GeoPointLike => ({
    latitude: Number((target.latitude + (towards.latitude - target.latitude) * share).toFixed(5)),
    longitude: Number(
      (target.longitude + (towards.longitude - target.longitude) * share).toFixed(5),
    ),
  });
  let low = 0;
  let high = 4;
  for (let step = 0; step < 40; step += 1) {
    const mid = (low + high) / 2;
    if (fakeDrivingMinutes(pointAt(mid), target) < minutes) low = mid;
    else high = mid;
  }
  return pointAt(high);
}

// ── UI ───────────────────────────────────────────────────────────────────

export async function loginStaff(page: Page, email: string, password: string, firstName: string) {
  await page.goto('/login');
  await page.getByLabel('E-Mail').fill(email);
  await page.getByLabel('Passwort', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('heading', { name: 'Heute' })).toBeVisible();
  await expect(page.getByText(new RegExp(`Willkommen, ${firstName}`))).toBeVisible();
}

/** Tour-View über die Staff-API (Session der Seite). */
export async function tourViaApi(page: Page, tourId: string): Promise<TourViewJson> {
  const response = await page.request.get(`/api/staff/tours/${tourId}`);
  expect(response.ok(), `GET /staff/tours/${tourId}`).toBe(true);
  return ((await response.json()) as { tour: TourViewJson }).tour;
}

/** Tour-View (bewusst locker typisiert – Prüfungen greifen gezielt auf Felder zu). */
export interface TourViewJson {
  id: string;
  status: string;
  planningStatus: string;
  version: number;
  assignedUserId: string;
  assignedName: string | null;
  effectiveDriverId: string | null;
  effectiveDriverName: string | null;
  substituted: boolean;
  endReason: string | null;
  plannedDistanceMeters: number | null;
  plannedDurationSeconds: number | null;
  routeProvider: string | null;
  stops: {
    id: string;
    appointmentId: string;
    sequence: number;
    isPinned: boolean;
    bufferMinutes: number;
    state: string;
    appointment: {
      kind: string;
      status: string;
      startAt: string | null;
      endAt: string | null;
      processNumber: string;
      bookingId: string;
      assignedUserId: string | null;
      effectiveAssigneeId: string | null;
    };
    plannedArrivalAt: string | null;
    delay?: { status: string };
    navigation: { apple: string; android: string; web: string } | null;
  }[];
  warnings: { code: string; message: string; stopId?: string }[];
  nextStop: { id: string } | null;
  liveLocation: { observedAt: string; stale: boolean } | null;
  openIncidents: { id: string; stopId: string }[];
  canStart: boolean;
  canEnd: boolean;
  canTakeover: boolean;
}

/** Stopp der Tour-View zu einem Termin (Fehler, wenn nicht enthalten). */
export function stopOf(tour: TourViewJson, appointmentId: string) {
  const stop = tour.stops.find((candidate) => candidate.appointmentId === appointmentId);
  expect(stop, `Stopp für Termin ${appointmentId}`).toBeDefined();
  return stop!;
}
