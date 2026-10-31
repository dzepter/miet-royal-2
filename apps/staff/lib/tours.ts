'use client';

import {
  TOUR_STOP_BUFFER_MINUTES_DEFAULT,
  TOUR_STOP_BUFFER_MINUTES_MAX,
  TOUR_STOP_BUFFER_MINUTES_MIN,
} from '@mietroyal/domain';
import { apiFetch, type ApiResult } from './api';
import type { CalendarEntry } from './scheduling';

/**
 * Phase 13 (UI): Typen, API-Aufrufe und Darstellungshelfer der Touren
 * (Design §8/§9/§12/§13, Tour-Bericht). Alle Felder, die der ACTIVE-Agent
 * parallel liefert (delay, liveLocation, Offline-Snapshot), werden defensiv
 * als optional behandelt.
 *
 * PWA-/iOS-Grenzen (Order §45, ehrlich dokumentiert):
 * - Es gibt KEIN Hintergrund-GPS: `navigator.geolocation.watchPosition` läuft
 *   nur, solange die Seite „Aktive Tour“ im Vordergrund geöffnet ist. Wechselt
 *   der Fahrer die App, sperrt das Gerät oder schließt den Tab, stoppt der
 *   Browser (insbesondere iOS/Safari-PWA) die Standortmeldungen – der Server
 *   kennzeichnet den letzten Standort dann nach 10 Minuten als „nicht aktuell“.
 * - Der Standort wird nie im Browser gespeichert (kein localStorage/IndexedDB),
 *   nur im Speicher der offenen Seite gehalten und gedrosselt gesendet.
 * - Offline werden Standorte verworfen, nie nachsynchronisiert.
 */

export {
  TOUR_STOP_BUFFER_MINUTES_DEFAULT,
  TOUR_STOP_BUFFER_MINUTES_MAX,
  TOUR_STOP_BUFFER_MINUTES_MIN,
};

export type TourStatus = 'draft' | 'ready' | 'active' | 'completed' | 'cancelled';
export type TourPlanningStatus = 'unplanned' | 'planned' | 'stale' | 'infeasible';
export type TourStopState = 'open' | 'arrived' | 'done' | 'skipped';
export type TourAddressStatus = 'ok' | 'missing' | 'review_required' | 'no_result' | 'unavailable';
export type AppointmentKind = 'pickup' | 'return' | 'delivery';

export interface NavigationLinks {
  apple: string;
  android: string;
  web: string;
}

export interface TourStopDelay {
  status: 'none' | 'risk' | 'unknown';
  predictedArrivalAt?: string;
  incidentId?: string;
}

export interface TourStopView {
  id: string;
  appointmentId: string;
  sequence: number;
  isPinned: boolean;
  bufferMinutes: number;
  state: TourStopState;
  appointment: {
    kind: AppointmentKind;
    status: 'scheduled' | 'completed' | 'cancelled';
    startAt: string | null;
    endAt: string | null;
    processId: string;
    processNumber: string;
    bookingId: string;
    customerName: string | null;
    machineName: string | null;
    assignedUserId: string | null;
    effectiveAssigneeId: string | null;
  };
  address: {
    lines: string[];
    label: string;
    status: TourAddressStatus;
    point: { latitude: number; longitude: number } | null;
    cacheId: string | null;
    candidates: { ref: string; label: string }[];
  };
  plannedArrivalAt: string | null;
  plannedDepartureAt: string | null;
  legDistanceMeters: number | null;
  legDurationSeconds: number | null;
  arrivedAt: string | null;
  skippedAt: string | null;
  deadlineAt: string | null;
  /** ACTIVE-Agent – optional behandeln. */
  delay?: TourStopDelay;
  travel: 'customer' | 'depot';
  navigation: NavigationLinks | null;
}

export interface TourWarning {
  code: string;
  message: string;
  stopId?: string;
}

export interface TourView {
  id: string;
  tourDate: string;
  status: TourStatus;
  planningStatus: TourPlanningStatus;
  version: number;
  assignedUserId: string;
  assignedName: string | null;
  effectiveDriverId: string | null;
  effectiveDriverName: string | null;
  substituted: boolean;
  startedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  cancelledAt: string | null;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  plannedDistanceMeters: number | null;
  plannedDurationSeconds: number | null;
  routeCalculatedAt: string | null;
  routeProvider: string | null;
  depot: { label: string; status: 'ok' | 'missing' };
  stops: TourStopView[];
  warnings: TourWarning[];
  nextStop: TourStopView | null;
  /** ACTIVE-Agent – optional behandeln (keine Koordinaten). */
  liveLocation?: { observedAt: string; receivedAt: string; stale: boolean } | null;
  openIncidents?: { id: string; stopId: string; predictedArrivalAt: string; deadlineAt: string }[];
  canStart: boolean;
  canEnd: boolean;
  canTakeover: boolean;
  canEdit: boolean;
  canOpenProcess: boolean;
}

export interface TourPlanConflict {
  stopId: string;
  code: 'TIME_WINDOW_MISSED' | 'UNREACHABLE' | 'UNASSIGNED';
  message: string;
}

export interface TourPlanDto {
  order: string[];
  visits: {
    stopId: string;
    arrivalAt: string;
    departureAt: string;
    waitingSeconds: number;
    legDistanceMeters: number;
    legDurationSeconds: number;
  }[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  plannedStartAt: string;
  plannedEndAt: string;
  returnLeg: { distanceMeters: number; durationSeconds: number } | null;
  conflicts: TourPlanConflict[];
  feasible: boolean;
  provider: string;
  stopCount: number;
}

export type PlanBlockedCode =
  'ADDRESS_MISSING' | 'GEOCODING_REVIEW_REQUIRED' | 'GEOCODING_NO_RESULT' | 'DEPOT_ADDRESS_MISSING';

export interface PlanBlockedReason {
  /** null = Depot. */
  stopId: string | null;
  code: PlanBlockedCode;
  message: string;
  addressLabel: string;
  cacheId: string | null;
  candidates: { ref: string; label: string }[];
}

export type ProposeResult =
  | { status: 'blocked'; version: number; reasons: PlanBlockedReason[] }
  | { status: 'ok'; version: number; plan: TourPlanDto };

/** Kandidat für „Verfügbare Stopps“ (CalendarEntry ohne Telefon + Zuständigkeitshinweis). */
export type TourCandidate = Omit<CalendarEntry, 'customerPhone'> & {
  assignment: 'unassigned' | 'tour_driver' | 'other';
};

/** Offline-Snapshot der eigenen aktiven Tour im Arbeitspaket (Design §11) – vom ACTIVE-Agenten geliefert. */
export interface OfflineTourSnapshot {
  tourId: string;
  tourDate: string;
  status: TourStatus;
  stops: {
    stopId: string;
    sequence: number;
    kind: AppointmentKind;
    processNumber: string;
    processId: string;
    startAt: string | null;
    endAt: string | null;
    addressLines: string[];
    navigation: NavigationLinks | null;
    state: TourStopState;
  }[];
}

export interface DelayStatus {
  status: 'ok' | 'risk' | 'unavailable';
  evaluatedAt: string | null;
  stops: {
    stopId: string;
    predictedArrivalAt: string | null;
    deadlineAt: string | null;
    late: boolean;
  }[];
}

// ── Texte (Design §13 – exakt) ──────────────────────────────────────────────

export const TOUR_TEXTS = {
  routingUnavailable: 'Route konnte gerade nicht berechnet werden.',
  routingDisabled: 'Routing ist nicht konfiguriert.',
  addressMissing: 'Adresse fehlt – Route nicht berechenbar.',
  depotMissing: 'Depotadresse ist noch nicht vollständig hinterlegt.',
  locationUnavailable: 'Standort nicht verfügbar – Verspätungswarnungen sind eingeschränkt.',
  locationStale: 'Standort nicht aktuell',
  delayUnknown: 'Verspätungsprognose derzeit nicht verfügbar.',
  openStops: 'Die Tour enthält noch offene Stopps.',
  versionConflict: 'Die Tour wurde zwischenzeitlich geändert.',
  stale: 'Route veraltet – neu berechnen',
  onlineOnly: 'Diese Aktion ist nur online möglich.',
  mockProvider: 'Simulation (Demo)',
  osmAttribution: '© OpenStreetMap-Mitwirkende',
  osmAttributionUrl: 'https://www.openstreetmap.org/copyright',
} as const;

export const TOUR_STATUS_LABELS: Record<TourStatus, string> = {
  draft: 'Entwurf',
  ready: 'Bereit',
  active: 'Aktiv',
  completed: 'Beendet',
  cancelled: 'Abgebrochen',
};

export const PLANNING_STATUS_LABELS: Record<TourPlanningStatus, string> = {
  unplanned: 'Noch nicht berechnet',
  planned: 'Route berechnet',
  stale: 'Route veraltet',
  infeasible: 'Route nicht machbar',
};

export const STOP_STATE_LABELS: Record<TourStopState, string> = {
  open: 'Offen',
  arrived: 'Angekommen',
  done: 'Erledigt',
  skipped: 'Übersprungen',
};

export const ADDRESS_STATUS_LABELS: Record<TourAddressStatus, string> = {
  ok: 'Adresse ok',
  missing: 'Adresse fehlt',
  review_required: 'Adresse prüfen',
  no_result: 'Kein Treffer',
  unavailable: 'Nicht verfügbar',
};

export const KIND_SHORT_LABELS: Record<AppointmentKind, string> = {
  pickup: 'Abholung',
  return: 'Rückgabe',
  delivery: 'Lieferung',
};

/** Warnungstexte je Code – Design §13 übersteuert den Servertext, wo exakt vorgegeben. */
export function warningText(warning: TourWarning): string {
  if (warning.code === 'PLAN_STALE') return TOUR_TEXTS.stale;
  if (warning.code === 'DEPOT_ADDRESS_MISSING') return TOUR_TEXTS.depotMissing;
  if (warning.code === 'ADDRESS_MISSING') return TOUR_TEXTS.addressMissing;
  return warning.message;
}

export function blockedReasonText(reason: PlanBlockedReason): string {
  if (reason.code === 'DEPOT_ADDRESS_MISSING') return TOUR_TEXTS.depotMissing;
  if (reason.code === 'ADDRESS_MISSING') return TOUR_TEXTS.addressMissing;
  return reason.message;
}

/** Fehlertext für Tour-/Routing-Fehler (nie Provider-Details). */
export function tourErrorText(result: ApiResult<unknown>, fallback: string): string {
  if (result.status === 503 || result.errorCode === 'ROUTING_UNAVAILABLE')
    return TOUR_TEXTS.routingUnavailable;
  if (result.errorCode === 'ROUTING_DISABLED') return TOUR_TEXTS.routingDisabled;
  if (result.errorCode === 'TOUR_VERSION_CONFLICT') return TOUR_TEXTS.versionConflict;
  if (result.errorCode === 'TOUR_HAS_OPEN_STOPS') return TOUR_TEXTS.openStops;
  if (result.errorCode === 'ONLINE_REQUIRED' || result.status === 0) return TOUR_TEXTS.onlineOnly;
  return result.errorMessage ?? fallback;
}

export function isVersionConflict(result: ApiResult<unknown>): boolean {
  return result.status === 409 && result.errorCode === 'TOUR_VERSION_CONFLICT';
}

// ── API ─────────────────────────────────────────────────────────────────────

export function listTours(date: string) {
  return apiFetch<{ scope: 'mine' | 'all'; date: string; tours: TourView[] }>(
    `/staff/tours?date=${encodeURIComponent(date)}`,
  );
}

export function getActiveTour() {
  return apiFetch<{ tour: TourView | null }>('/staff/tours/active');
}

export function getTour(id: string) {
  return apiFetch<{ tour: TourView }>(`/staff/tours/${id}`);
}

export function getCandidates(id: string) {
  return apiFetch<{ appointments: TourCandidate[] }>(`/staff/tours/${id}/candidates`);
}

export function createTour(body: { tourDate: string; assignedUserId: string }) {
  return apiFetch<{ tour: TourView }>('/staff/tours', { method: 'POST', body });
}

export function addStop(
  id: string,
  body: { appointmentId: string; expectedVersion: number; reassign?: boolean },
) {
  return apiFetch<{ tour: TourView }>(`/staff/tours/${id}/stops`, { method: 'POST', body });
}

export function removeStop(id: string, stopId: string, expectedVersion: number) {
  return apiFetch<{ tour: TourView }>(`/staff/tours/${id}/stops/${stopId}`, {
    method: 'DELETE',
    body: { expectedVersion },
  });
}

export function reorderStops(id: string, expectedVersion: number, order: string[]) {
  return apiFetch<{ tour: TourView }>(`/staff/tours/${id}/stops/order`, {
    method: 'POST',
    body: { expectedVersion, order },
  });
}

export function patchStop(
  id: string,
  stopId: string,
  body: { expectedVersion: number; isPinned?: boolean; bufferMinutes?: number },
) {
  return apiFetch<{ tour: TourView }>(`/staff/tours/${id}/stops/${stopId}`, {
    method: 'PATCH',
    body,
  });
}

export function proposePlan(id: string, departureAt?: string) {
  return apiFetch<ProposeResult>(`/staff/tours/${id}/plan/propose`, {
    method: 'POST',
    body: departureAt === undefined ? {} : { departureAt },
  });
}

export function applyPlan(
  id: string,
  body: { expectedVersion: number; order: string[]; departureAt?: string },
) {
  return apiFetch<{ tour: TourView; plan: TourPlanDto }>(`/staff/tours/${id}/plan/apply`, {
    method: 'POST',
    body,
  });
}

export function evaluatePlan(id: string, body: { expectedVersion: number; departureAt?: string }) {
  return apiFetch<{ tour: TourView; plan: TourPlanDto }>(`/staff/tours/${id}/plan/evaluate`, {
    method: 'POST',
    body,
  });
}

// Phase 13 (Fix F4): expectedVersion ist Pflicht (409 TOUR_VERSION_CONFLICT bei Abweichung).
export function recalculatePlan(id: string, expectedVersion: number) {
  return apiFetch<{ tour: TourView; plan: TourPlanDto }>(`/staff/tours/${id}/plan/recalculate`, {
    method: 'POST',
    body: { expectedVersion },
  });
}

export function confirmGeocoding(id: string, body: { cacheId: string; candidateRef: string }) {
  return apiFetch<{ tour: TourView }>(`/staff/tours/${id}/geocoding/confirm`, {
    method: 'POST',
    body,
  });
}

export function markReady(id: string, expectedVersion?: number) {
  return apiFetch<{ tour: TourView }>(`/staff/tours/${id}/ready`, {
    method: 'POST',
    body: expectedVersion === undefined ? {} : { expectedVersion },
  });
}

export function startTour(id: string, expectedVersion?: number) {
  return apiFetch<{ started: boolean; tour: TourView }>(`/staff/tours/${id}/start`, {
    method: 'POST',
    body: expectedVersion === undefined ? {} : { expectedVersion },
  });
}

export function endTour(id: string, body: { force?: boolean; reason?: string } = {}) {
  return apiFetch<{ ended: boolean; tour: TourView }>(`/staff/tours/${id}/end`, {
    method: 'POST',
    body,
  });
}

export function cancelTour(id: string) {
  return apiFetch<{ cancelled: boolean; tour: TourView }>(`/staff/tours/${id}/cancel`, {
    method: 'POST',
    body: {},
  });
}

export function takeoverTour(id: string, expectedVersion?: number) {
  return apiFetch<{ tour: TourView }>(`/staff/tours/${id}/takeover`, {
    method: 'POST',
    body: expectedVersion === undefined ? {} : { expectedVersion },
  });
}

export function markArrived(id: string, stopId: string) {
  return apiFetch<{ tour: TourView }>(`/staff/tours/${id}/stops/${stopId}/arrived`, {
    method: 'POST',
    body: {},
  });
}

/** GPS-Update (ACTIVE-Agent): 204 ok, 429 Drossel, 404 Tour nicht (mehr) aktiv/fremd. */
export function sendLocation(
  id: string,
  body: { latitude: number; longitude: number; accuracyMeters?: number; observedAt: string },
) {
  return apiFetch<unknown>(`/staff/tours/${id}/location`, { method: 'POST', body });
}

export function getDelay(id: string) {
  return apiFetch<DelayStatus>(`/staff/tours/${id}/delay`);
}

// ── Darstellung ─────────────────────────────────────────────────────────────

export function formatKm(meters: number | null | undefined): string {
  if (meters === null || meters === undefined) return '–';
  const km = meters / 1000;
  return `${km.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
}

export function formatMinutes(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '–';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function providerLabel(provider: string | null | undefined): string | null {
  if (provider === null || provider === undefined) return null;
  if (provider === 'mock' || provider === 'fake') return TOUR_TEXTS.mockProvider;
  return null;
}

/** Nächster offener Stopp (open/arrived, kleinste Sequenz) – Fallback, wenn die View keinen liefert. */
export function nextOpenStop<T extends { sequence: number; state: TourStopState }>(
  stops: T[],
): T | null {
  return (
    [...stops]
      .filter((stop) => stop.state === 'open' || stop.state === 'arrived')
      .sort((a, b) => a.sequence - b.sequence)[0] ?? null
  );
}

// ── Navigation (Design §12: Plattformwahl im Client) ────────────────────────

export type NavigationPlatform = 'apple' | 'android' | 'web';

export function navigationPlatform(userAgent: string): NavigationPlatform {
  if (/iPhone|iPad|iPod|Macintosh|Mac OS X/i.test(userAgent)) return 'apple';
  if (/Android/i.test(userAgent)) return 'android';
  return 'web';
}

export function navigationHref(
  links: NavigationLinks | null,
  platform: NavigationPlatform,
): string | null {
  if (links === null) return null;
  return links[platform];
}

// ── Client-Drossel für GPS (Design §9) ──────────────────────────────────────

/** Mindestens 60 s ODER 250 m Bewegung – und nie öfter als alle 15 s. */
export const LOCATION_MIN_INTERVAL_MS = 15_000;
export const LOCATION_SEND_INTERVAL_MS = 60_000;
export const LOCATION_SEND_DISTANCE_M = 250;

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/** Großkreis-Distanz in Metern (Haversine). */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earth = 6_371_000;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface LocationSendState {
  lastSentAt: number | null;
  lastSentPoint: GeoPoint | null;
}

/** Reine Entscheidung „jetzt senden?“ – Zustand lebt nur im Speicher der Seite. */
export function shouldSendLocation(
  state: LocationSendState,
  point: GeoPoint,
  nowMs: number,
): boolean {
  if (state.lastSentAt === null || state.lastSentPoint === null) return true;
  const elapsed = nowMs - state.lastSentAt;
  if (elapsed < LOCATION_MIN_INTERVAL_MS) return false;
  if (elapsed >= LOCATION_SEND_INTERVAL_MS) return true;
  return haversineMeters(state.lastSentPoint, point) >= LOCATION_SEND_DISTANCE_M;
}
