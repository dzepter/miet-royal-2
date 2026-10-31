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
 * - Zeit-Helfer rechnen in Europe/Berlin (Termine „heute“ relativ zu jetzt;
 *   Werte werden auf den Berliner Kalendertag geklemmt, damit ein Lauf kurz
 *   vor Mitternacht nicht an „nicht am Tourtag“ scheitert).
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
  notification_sent_at: string | null;
}

export function delayIncidents(tourId: string): DelayIncidentDbRow[] {
  return queryTestDb<DelayIncidentDbRow>(
    'SELECT id, tour_id, stop_id, resolved_at, notification_sent_at FROM tour_delay_incidents WHERE tour_id = $1 ORDER BY detected_at ASC',
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

/**
 * „jetzt + N Minuten“, auf den heutigen Berliner Kalendertag geklemmt
 * (00:01 … 23:59), damit alle Termine am Tourtag liegen.
 */
export function todayPlusMinutes(deltaMinutes: number, now = new Date()): Date {
  const target = Math.min(23 * 60 + 59, Math.max(1, berlinMinutesOfDay(now) + deltaMinutes));
  return berlinTodayAt(target, now);
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
