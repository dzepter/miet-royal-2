/**
 * Phase 13: reine Touren-Fachlogik (Order §§18–25, §47/§48) – Puffer-
 * Konstante, Deadline-/Frühestbeginn-Regel je Terminart, deterministischer
 * lokaler Planer (gepinnte Stopps als feste Anker, flexible Segmente
 * dazwischen), Bewertung einer gegebenen Reihenfolge und Navigations-Links.
 * Keine DB, kein Provider: Fahrzeiten/Distanzen kommen als Matrix herein
 * (Index 0 … n), Zeitpunkte sind UTC-Instants.
 */
import { berlinDateOf, berlinDateTimeToUtc } from './scheduling.ts';

/** Standard-Servicepuffer je operativem Stopp (Order §21) – EINZIGE Stelle. */
export const TOUR_STOP_BUFFER_MINUTES_DEFAULT = 15;
export const TOUR_STOP_BUFFER_MINUTES_MIN = 0;
export const TOUR_STOP_BUFFER_MINUTES_MAX = 240;

/**
 * Planungs-Startwert (kein Fachgeheimnis, nur Default der Abfahrt am
 * Depot, in der UI änderbar): Tourdatum heute ⇒ jetzt; sonst 08:00 Berlin.
 */
export const DEFAULT_TOUR_DEPARTURE_HOUR = 8;

/** Flexible Segmente bis zu dieser Größe werden vollständig permutiert (Design §6). */
export const TOUR_PLAN_FULL_PERMUTATION_MAX = 7;

export interface TourTimePosition {
  startAt: Date | null;
  endAt: Date | null;
}

/**
 * Spätester Zeitpunkt eines Stopps (Order §22/§50): exakter Termin ⇒ der
 * Termin selbst; Zeitfenster ⇒ Fensterende; ungeplant ⇒ keine Deadline.
 */
export function stopDeadline(position: TourTimePosition): Date | null {
  if (position.startAt === null) return null;
  return position.endAt ?? position.startAt;
}

/** Frühester Beginn am Stopp: Terminbeginn (Ankunft davor ⇒ Wartezeit); ungeplant ⇒ keiner. */
export function stopEarliestStart(position: TourTimePosition): Date | null {
  return position.startAt;
}

/** Hartes Zeitfenster für den Provider: exakt ⇒ earliest = latest = Termin. */
export function stopTimeWindow(
  position: TourTimePosition,
): { earliest: Date; latest: Date } | null {
  if (position.startAt === null) return null;
  return { earliest: position.startAt, latest: position.endAt ?? position.startAt };
}

/** Standard-Abfahrt am Depot (Design §6 d): heute ⇒ jetzt, sonst 08:00 Berlin des Tourdatums. */
export function defaultTourDeparture(tourDateIso: string, now: Date): Date {
  if (berlinDateOf(now) === tourDateIso) return now;
  return berlinDateTimeToUtc(tourDateIso, DEFAULT_TOUR_DEPARTURE_HOUR, 0);
}

// ── Stopp-Zustand (Order §35/§36) – rein abgeleitet ────────────────────────

export type TourStopState = 'open' | 'arrived' | 'done' | 'skipped';

/**
 * Zustand eines Stopps ausschließlich aus dem Termin (Source of Truth) und
 * den operativen Marken: erledigt ⇔ Termin abgeschlossen (Übergabe/Rückgabe),
 * übersprungen ⇔ Termin storniert oder operativ geschlossen, angekommen ⇔
 * Marke gesetzt. Kein eigener „Erledigt“-Knopf.
 */
export function tourStopState(input: {
  appointmentStatus: 'scheduled' | 'completed' | 'cancelled';
  skippedAt: Date | null;
  arrivedAt: Date | null;
}): TourStopState {
  if (input.appointmentStatus === 'completed') return 'done';
  if (input.appointmentStatus === 'cancelled' || input.skippedAt !== null) return 'skipped';
  if (input.arrivedAt !== null) return 'arrived';
  return 'open';
}

// ── Planer ────────────────────────────────────────────────────────────────

export interface TourPlanMatrix {
  /** [from][to] Sekunden; null = keine Verbindung. */
  durationsSeconds: readonly (number | null)[][];
  /** [from][to] Meter; null = keine Verbindung. */
  distancesMeters: readonly (number | null)[][];
}

export interface PlanStop extends TourTimePosition {
  id: string;
  /** Zeile/Spalte dieses Stopps in der Matrix. */
  matrixIndex: number;
  isPinned: boolean;
  bufferMinutes: number;
  /** Anzeige für Konfliktmeldungen (z. B. „Liefertermin MR-2026-1234“) – nie an den Provider. */
  label: string;
}

export interface PlanInput {
  matrix: TourPlanMatrix;
  /** Startpunkt der Fahrt (Depot oder aktueller Standort). */
  originIndex: number;
  /** Rückfahrtziel (Depot); null = keine Rückfahrt einrechnen. */
  depotIndex: number | null;
  /** Stopps in der aktuellen Reihenfolge. */
  stops: readonly PlanStop[];
  departureAt: Date;
  provider: string;
}

export type TourPlanConflictCode = 'TIME_WINDOW_MISSED' | 'UNREACHABLE' | 'UNASSIGNED';

export interface TourPlanConflict {
  stopId: string;
  code: TourPlanConflictCode;
  message: string;
}

export interface TourPlanVisit {
  stopId: string;
  arrivalAt: Date;
  departureAt: Date;
  /** Wartezeit bis zum frühesten Beginn (Sekunden). */
  waitingSeconds: number;
  /** Abschnitt VOM vorherigen Punkt BIS hier. */
  legDistanceMeters: number;
  legDurationSeconds: number;
}

export interface TourPlan {
  order: string[];
  visits: TourPlanVisit[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  plannedStartAt: Date;
  /** Ankunft am Depot nach dem letzten Stopp (bzw. Abfahrt am letzten Stopp ohne Rückfahrt). */
  plannedEndAt: Date;
  returnLeg: { distanceMeters: number; durationSeconds: number } | null;
  conflicts: TourPlanConflict[];
  feasible: boolean;
  provider: string;
}

export function timeWindowMissedMessage(label: string): string {
  return `${label} ist nach dem vorherigen Stopp voraussichtlich nicht rechtzeitig erreichbar.`;
}

export function unreachableMessage(label: string): string {
  return `${label}: Adresse über das Straßennetz nicht erreichbar.`;
}

function matrixCell(matrix: readonly (number | null)[][], from: number, to: number): number | null {
  const row = matrix[from];
  if (row === undefined) return null;
  const value = row[to];
  return value === undefined ? null : value;
}

/**
 * Zeiten/Metriken für GENAU diese Reihenfolge (Order §24): Fahrzeit aus der
 * Matrix, Wartezeit bis zum frühesten Beginn, Puffer je Stopp, Rückfahrt
 * zum Depot. Harte Zeitfenster: Ankunft nach der Deadline ⇒ Konflikt (keine
 * Terminmutation, Order §22/§23); Matrix-null ⇒ nicht erreichbar.
 */
export function evaluateOrder(input: PlanInput): TourPlan {
  const visits: TourPlanVisit[] = [];
  const conflicts: TourPlanConflict[] = [];
  let clock = input.departureAt.getTime();
  let position = input.originIndex;
  let totalDistance = 0;
  for (const stop of input.stops) {
    const duration = matrixCell(input.matrix.durationsSeconds, position, stop.matrixIndex);
    const distance = matrixCell(input.matrix.distancesMeters, position, stop.matrixIndex);
    const legDurationSeconds = duration ?? 0;
    const legDistanceMeters = distance ?? 0;
    if (duration === null || distance === null) {
      conflicts.push({
        stopId: stop.id,
        code: 'UNREACHABLE',
        message: unreachableMessage(stop.label),
      });
    }
    let arrival = clock + legDurationSeconds * 1000;
    let waitingSeconds = 0;
    const earliest = stopEarliestStart(stop);
    if (earliest !== null && arrival < earliest.getTime()) {
      waitingSeconds = Math.round((earliest.getTime() - arrival) / 1000);
      arrival = earliest.getTime();
    }
    const deadline = stopDeadline(stop);
    if (deadline !== null && arrival > deadline.getTime()) {
      conflicts.push({
        stopId: stop.id,
        code: 'TIME_WINDOW_MISSED',
        message: timeWindowMissedMessage(stop.label),
      });
    }
    const departure = arrival + Math.max(0, stop.bufferMinutes) * 60_000;
    visits.push({
      stopId: stop.id,
      arrivalAt: new Date(arrival),
      departureAt: new Date(departure),
      waitingSeconds,
      legDistanceMeters,
      legDurationSeconds,
    });
    totalDistance += legDistanceMeters;
    clock = departure;
    position = stop.matrixIndex;
  }
  let returnLeg: TourPlan['returnLeg'] = null;
  if (input.depotIndex !== null && input.stops.length > 0) {
    const duration = matrixCell(input.matrix.durationsSeconds, position, input.depotIndex) ?? 0;
    const distance = matrixCell(input.matrix.distancesMeters, position, input.depotIndex) ?? 0;
    returnLeg = { distanceMeters: distance, durationSeconds: duration };
    totalDistance += distance;
    clock += duration * 1000;
  }
  const plannedEndAt = new Date(clock);
  return {
    order: input.stops.map((stop) => stop.id),
    visits,
    totalDistanceMeters: totalDistance,
    totalDurationSeconds: Math.max(
      0,
      Math.round((plannedEndAt.getTime() - input.departureAt.getTime()) / 1000),
    ),
    plannedStartAt: input.departureAt,
    plannedEndAt,
    returnLeg,
    conflicts,
    feasible: conflicts.length === 0,
    provider: input.provider,
  };
}

/** Bewertung (kleiner = besser): erst Konfliktzahl, dann Gesamtabschlusszeit. */
function planScore(plan: TourPlan): [number, number] {
  return [plan.conflicts.length, plan.plannedEndAt.getTime()];
}

function betterScore(a: [number, number], b: [number, number]): boolean {
  if (a[0] !== b[0]) return a[0] < b[0];
  return a[1] < b[1];
}

function* permutations<T>(items: readonly T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let i = 0; i < items.length; i += 1) {
    const head = items[i]!;
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) yield [head, ...tail];
  }
}

/** Nächster-Nachbar ab `fromIndex` über die Fahrzeiten-Matrix; Gleichstand ⇒ bestehende Reihenfolge. */
function nearestNeighbourOrder(
  matrix: TourPlanMatrix,
  fromIndex: number,
  stops: readonly PlanStop[],
): PlanStop[] {
  const remaining = [...stops];
  const result: PlanStop[] = [];
  let position = fromIndex;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDuration = Number.POSITIVE_INFINITY;
    for (let i = 0; i < remaining.length; i += 1) {
      const duration = matrixCell(matrix.durationsSeconds, position, remaining[i]!.matrixIndex);
      const value = duration === null ? Number.POSITIVE_INFINITY : duration;
      if (value < bestDuration) {
        bestDuration = value;
        bestIdx = i;
      }
    }
    const [next] = remaining.splice(bestIdx, 1);
    result.push(next!);
    position = next!.matrixIndex;
  }
  return result;
}

/**
 * Lokaler deterministischer Planer (Design §6 b / Order §20): gepinnte
 * Stopps behalten ihre Position (feste Anker); jedes flexible Segment
 * zwischen zwei Ankern wird vollständig permutiert (≤ 7 Stopps), sonst
 * Nächster-Nachbar + 2-opt. Bewertung je Segment: Konfliktzahl, dann
 * Abschlusszeit bis einschließlich des nächsten Ankers. Ergebnis ist die
 * Bewertung der vollständigen Reihenfolge (inkl. Rückfahrt).
 */
export function planWithAnchors(input: PlanInput): TourPlan {
  const stops = input.stops;
  if (stops.length === 0) return evaluateOrder(input);
  const order: (PlanStop | null)[] = stops.map((stop) => (stop.isPinned ? stop : null));

  const evaluatePartial = (sequence: readonly PlanStop[]): [number, number] =>
    planScore(evaluateOrder({ ...input, stops: sequence, depotIndex: null }));

  let index = 0;
  while (index < stops.length) {
    if (order[index] !== null) {
      index += 1;
      continue;
    }
    const segmentStart = index;
    while (index < stops.length && order[index] === null) index += 1;
    const segmentEnd = index; // exklusiv
    const flexible = stops.slice(segmentStart, segmentEnd);
    const prefix = order.slice(0, segmentStart).filter((stop): stop is PlanStop => stop !== null);
    const nextAnchor = segmentEnd < stops.length ? stops[segmentEnd]! : null;
    const suffix = nextAnchor === null ? [] : [nextAnchor];

    let best: PlanStop[];
    if (flexible.length <= TOUR_PLAN_FULL_PERMUTATION_MAX) {
      best = [...flexible];
      let bestScore = evaluatePartial([...prefix, ...best, ...suffix]);
      for (const candidate of permutations(flexible)) {
        const score = evaluatePartial([...prefix, ...candidate, ...suffix]);
        if (betterScore(score, bestScore)) {
          bestScore = score;
          best = candidate;
        }
      }
    } else {
      const from = prefix.length > 0 ? prefix[prefix.length - 1]!.matrixIndex : input.originIndex;
      best = nearestNeighbourOrder(input.matrix, from, flexible);
      let bestScore = evaluatePartial([...prefix, ...best, ...suffix]);
      // 2-opt: Teilstücke umkehren, solange sich die Bewertung verbessert (begrenzt).
      let improved = true;
      let passes = 0;
      while (improved && passes < 50) {
        improved = false;
        passes += 1;
        for (let i = 0; i < best.length - 1; i += 1) {
          for (let j = i + 1; j < best.length; j += 1) {
            const candidate = [
              ...best.slice(0, i),
              ...best.slice(i, j + 1).reverse(),
              ...best.slice(j + 1),
            ];
            const score = evaluatePartial([...prefix, ...candidate, ...suffix]);
            if (betterScore(score, bestScore)) {
              bestScore = score;
              best = candidate;
              improved = true;
            }
          }
        }
      }
    }
    for (let i = 0; i < best.length; i += 1) order[segmentStart + i] = best[i]!;
  }
  const finalOrder = order.filter((stop): stop is PlanStop => stop !== null);
  return evaluateOrder({ ...input, stops: finalOrder });
}

// ── Navigation (Order §47/§48, Design §12) ────────────────────────────────

export interface NavigationLinks {
  apple: string;
  android: string;
  web: string;
}

function formatCoordinate(value: number): string {
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Externe Karten-Links: NUR das Ziel (Koordinate oder Adresse) – nie Name,
 * Telefon, Vorgangsnummer oder ein API-Key. Funktioniert ohne Provider
 * (Adress-Variante). Plattformwahl trifft der Client.
 */
export function navigationLinks(
  point: { latitude: number; longitude: number } | null,
  addressText: string | null,
): NavigationLinks | null {
  if (point !== null) {
    const lat = formatCoordinate(point.latitude);
    const lon = formatCoordinate(point.longitude);
    const coordinate = `${lat},${lon}`;
    return {
      apple: `https://maps.apple.com/?daddr=${coordinate}`,
      android: `geo:${coordinate}?q=${coordinate}`,
      web: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(coordinate)}`,
    };
  }
  const text = addressText?.trim() ?? '';
  if (text === '') return null;
  const encoded = encodeURIComponent(text);
  return {
    apple: `https://maps.apple.com/?daddr=${encoded}`,
    android: `geo:0,0?q=${encoded}`,
    web: `https://www.google.com/maps/dir/?api=1&destination=${encoded}`,
  };
}
