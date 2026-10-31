import {
  processes,
  tourLiveLocations,
  tourStops,
  tours,
  type Database,
  type DatabaseTransaction,
  type Tour,
} from '@mietroyal/database';
import {
  defaultTourDeparture,
  evaluateOrder,
  planWithAnchors,
  stopTimeWindow,
  timeWindowMissedMessage,
  unreachableMessage,
  type PlanStop,
  type TourPlan,
  type TourPlanConflict,
  type TourPlanMatrix,
} from '@mietroyal/domain';
import { eq, inArray } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import type { GeocodingResolution } from '../routing/geocoding-types.ts';
import { RoutingError, type GeoPoint, type RoutingGateway } from '../routing/types.ts';
import { TOUR_MESSAGES, TourError } from './errors.ts';
import type { LoadedStop, LoadedTour, TourService } from './tour-service.ts';
import type { OperativeAddressResolver, TourGeocodingResolver } from './types.ts';
import { LIVE_LOCATION_STALE_MS } from './views.ts';

/**
 * Phase 13 (Design §6): Routenvorschlag, Übernahme, Bewertung der aktuellen
 * Reihenfolge und Restroute der aktiven Tour.
 *
 * Zweiphasig (Order §62/§63): Snapshot lesen → Provider rechnen (OHNE DB-
 * Sperre) → CAS auf `tours.version` schreiben. Ein Vorschlag wird NIE
 * gespeichert; „übernehmen“ rechnet die Zeiten für die gesendete Reihenfolge
 * serverseitig erneut (der Client liefert nie Werte). An den Provider gehen
 * nur Koordinaten, Zeitfenster, Servicezeiten und anonyme Stopp-IDs.
 * Persistiert werden ausschließlich skalare Planungswerte (Order §5/§24).
 */

const KIND_LABELS = {
  delivery: 'Liefertermin',
  pickup: 'Abholtermin',
  return: 'Rückgabetermin',
} as const;

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
  /** Anzahl geplanter Stopps (Metrik, Order §24). */
  stopCount: number;
}

export type ProposeResult =
  | { status: 'blocked'; version: number; reasons: PlanBlockedReason[] }
  | { status: 'ok'; version: number; plan: TourPlanDto };

interface PreparedStop {
  entry: LoadedStop;
  point: GeoPoint;
  label: string;
}

type Prepared =
  | { status: 'blocked'; reasons: PlanBlockedReason[] }
  | { status: 'ok'; depot: GeoPoint; stops: PreparedStop[] };

export function toPlanDto(plan: TourPlan): TourPlanDto {
  return {
    order: plan.order,
    visits: plan.visits.map((visit) => ({
      stopId: visit.stopId,
      arrivalAt: visit.arrivalAt.toISOString(),
      departureAt: visit.departureAt.toISOString(),
      waitingSeconds: visit.waitingSeconds,
      legDistanceMeters: visit.legDistanceMeters,
      legDurationSeconds: visit.legDurationSeconds,
    })),
    totalDistanceMeters: plan.totalDistanceMeters,
    totalDurationSeconds: plan.totalDurationSeconds,
    plannedStartAt: plan.plannedStartAt.toISOString(),
    plannedEndAt: plan.plannedEndAt.toISOString(),
    returnLeg: plan.returnLeg,
    conflicts: plan.conflicts,
    feasible: plan.feasible,
    provider: plan.provider,
    stopCount: plan.visits.length,
  };
}

function isRemaining(entry: LoadedStop): boolean {
  return entry.state === 'open' || entry.state === 'arrived';
}

export class PlanningService {
  constructor(
    private readonly db: Database,
    private readonly tours: TourService,
    private readonly gateway: RoutingGateway,
    private readonly geocoding: TourGeocodingResolver,
    private readonly addresses: OperativeAddressResolver,
  ) {}

  // ── Vorbereitung: Adressen + Geokodierung (keine Routing-Calls bei Blockern) ─

  private async geocode(text: string, now: Date): Promise<GeocodingResolution> {
    const resolution = await this.geocoding.resolve(text, { now });
    if (resolution.status === 'unavailable') {
      // Provider-Fehler ⇒ 503 (Design §8); disabled ⇒ 409.
      throw new RoutingError(this.gateway.kind === 'disabled' ? 'disabled' : 'network');
    }
    return resolution;
  }

  private async prepare(loaded: LoadedTour, now: Date): Promise<Prepared> {
    const remaining = loaded.stops.filter(isRemaining);
    const reasons: PlanBlockedReason[] = [];
    const processIds = [...new Set(remaining.map((entry) => entry.appointment.processId))];
    const processRows =
      processIds.length === 0
        ? []
        : await this.db
            .select({ id: processes.id, processNumber: processes.processNumber })
            .from(processes)
            .where(inArray(processes.id, processIds));
    const processNumbers = new Map(processRows.map((row) => [row.id, row.processNumber]));

    const depotAddress = await this.addresses.getDepotAddress(this.db);
    let depot: GeoPoint | null = null;
    if (depotAddress.status === 'missing' || depotAddress.text === null) {
      reasons.push({
        stopId: null,
        code: 'DEPOT_ADDRESS_MISSING',
        message: TOUR_MESSAGES.DEPOT_MISSING,
        addressLabel: depotAddress.lines.join(', '),
        cacheId: null,
        candidates: [],
      });
    } else {
      const resolution = await this.geocode(depotAddress.text, now);
      if (resolution.status === 'resolved' && resolution.point !== null) depot = resolution.point;
      else {
        reasons.push({
          stopId: null,
          code:
            resolution.status === 'review_required'
              ? 'GEOCODING_REVIEW_REQUIRED'
              : 'GEOCODING_NO_RESULT',
          message: TOUR_MESSAGES.DEPOT_MISSING,
          addressLabel: depotAddress.lines.join(', '),
          cacheId: resolution.cacheId,
          candidates: resolution.candidates.map((c) => ({ ref: c.ref, label: c.label })),
        });
      }
    }

    const resolved = new Map<string, GeocodingResolution>();
    const stops: PreparedStop[] = [];
    for (const entry of remaining) {
      const address = await this.addresses.resolveOperativeAddress(this.db, entry.appointment);
      const addressLabel = address.lines.join(', ');
      const label =
        `${KIND_LABELS[entry.appointment.kind]} ${processNumbers.get(entry.appointment.processId) ?? ''}`.trim();
      if (address.status === 'missing' || address.text === null) {
        reasons.push({
          stopId: entry.stop.id,
          code: 'ADDRESS_MISSING',
          message: TOUR_MESSAGES.ADDRESS_MISSING,
          addressLabel,
          cacheId: null,
          candidates: [],
        });
        continue;
      }
      let resolution = resolved.get(address.text);
      if (resolution === undefined) {
        resolution = await this.geocode(address.text, now);
        resolved.set(address.text, resolution);
      }
      if (resolution.status === 'resolved' && resolution.point !== null) {
        stops.push({ entry, point: resolution.point, label });
        continue;
      }
      reasons.push({
        stopId: entry.stop.id,
        code:
          resolution.status === 'review_required'
            ? 'GEOCODING_REVIEW_REQUIRED'
            : 'GEOCODING_NO_RESULT',
        message:
          resolution.status === 'review_required'
            ? 'Adresse ist mehrdeutig – bitte „Adresse für Route prüfen“.'
            : 'Adresse konnte nicht gefunden werden – Route nicht berechenbar.',
        addressLabel,
        cacheId: resolution.cacheId,
        candidates: resolution.candidates.map((c) => ({ ref: c.ref, label: c.label })),
      });
    }
    if (reasons.length > 0 || depot === null) return { status: 'blocked', reasons };
    return { status: 'ok', depot, stops };
  }

  private toPlanStops(stops: readonly PreparedStop[], firstMatrixIndex: number): PlanStop[] {
    return stops.map((prepared, index) => ({
      id: prepared.entry.stop.id,
      matrixIndex: firstMatrixIndex + index,
      isPinned: prepared.entry.stop.isPinned,
      bufferMinutes: prepared.entry.stop.bufferMinutes,
      startAt: prepared.entry.appointment.startAt,
      endAt: prepared.entry.appointment.endAt,
      label: prepared.label,
    }));
  }

  private async matrixFor(points: readonly GeoPoint[]): Promise<TourPlanMatrix> {
    const result = await this.gateway.matrix({ points: [...points] });
    return { durationsSeconds: result.durationsSeconds, distancesMeters: result.distancesMeters };
  }

  private assertPlannable(tour: Tour): void {
    if (tour.status === 'active') {
      throw new TourError(
        'CONFLICT',
        'TOUR_ACTIVE',
        'In einer aktiven Tour wird nur die verbleibende Route neu berechnet.',
      );
    }
    if (tour.status !== 'draft' && tour.status !== 'ready') {
      throw new TourError(
        'CONFLICT',
        'TOUR_NOT_EDITABLE',
        'Abgeschlossene oder abgebrochene Touren werden nicht mehr geplant.',
      );
    }
  }

  private assertVersion(tour: Tour, expectedVersion: number | undefined): void {
    if (expectedVersion !== undefined && tour.version !== expectedVersion) {
      throw new TourError(
        'CONFLICT',
        'TOUR_VERSION_CONFLICT',
        'Die Tour wurde zwischenzeitlich geändert. Bitte neu laden und erneut prüfen.',
      );
    }
  }

  private blocked(reasons: PlanBlockedReason[]): TourError {
    return new TourError(
      'CONFLICT',
      'TOUR_PLAN_BLOCKED',
      'Die Route kann nicht berechnet werden, solange Adressen fehlen oder ungeprüft sind.',
      { reasons },
    );
  }

  // ── Vorschlag (Design §6, 1–3) ───────────────────────────────────────────

  async propose(
    tourId: string,
    input: { departureAt?: Date | undefined } = {},
    now = new Date(),
  ): Promise<ProposeResult> {
    const loaded = await this.tours.load(tourId, now);
    this.assertPlannable(loaded.tour);
    const prepared = await this.prepare(loaded, now);
    if (prepared.status === 'blocked') {
      return { status: 'blocked', version: loaded.tour.version, reasons: prepared.reasons };
    }
    if (prepared.stops.length === 0) {
      throw new AuthError('VALIDATION', 'Die Tour enthält keine offenen Stopps.');
    }
    const departureAt = input.departureAt ?? defaultTourDeparture(loaded.tour.tourDate, now);
    const hasPinned = prepared.stops.some((stop) => stop.entry.stop.isPinned);
    const plan = hasPinned
      ? await this.planLocally(prepared, departureAt)
      : await this.planWithProvider(prepared, departureAt);
    return { status: 'ok', version: loaded.tour.version, plan: toPlanDto(plan) };
  }

  /** Mindestens ein gepinnter Stopp ⇒ Matrix + lokaler Planer (Order §20). */
  private async planLocally(
    prepared: Extract<Prepared, { status: 'ok' }>,
    departureAt: Date,
  ): Promise<TourPlan> {
    const matrix = await this.matrixFor([prepared.depot, ...prepared.stops.map((s) => s.point)]);
    return planWithAnchors({
      matrix,
      originIndex: 0,
      depotIndex: 0,
      stops: this.toPlanStops(prepared.stops, 1),
      departureAt,
      provider: this.gateway.providerName,
    });
  }

  /** Keine Pins ⇒ Provider-Optimierung (harte Zeitfenster, Servicezeiten, ein Fahrzeug). */
  private async planWithProvider(
    prepared: Extract<Prepared, { status: 'ok' }>,
    departureAt: Date,
  ): Promise<TourPlan> {
    const byId = new Map(prepared.stops.map((stop) => [stop.entry.stop.id, stop]));
    const result = await this.gateway.optimizeTour({
      depot: prepared.depot,
      earliestStart: departureAt,
      stops: prepared.stops.map((stop) => ({
        id: stop.entry.stop.id,
        point: stop.point,
        serviceSeconds: stop.entry.stop.bufferMinutes * 60,
        timeWindow: stopTimeWindow(stop.entry.appointment),
      })),
      sequenceRelations: [],
    });
    const visits: TourPlan['visits'] = [];
    let previousDistance = 0;
    let previousDriving = 0;
    for (const visit of result.visits) {
      const stop = byId.get(visit.stopId);
      if (stop === undefined) continue;
      const earliest = stop.entry.appointment.startAt;
      const waitingSeconds =
        earliest === null
          ? 0
          : Math.max(0, Math.round((earliest.getTime() - visit.arrivalAt.getTime()) / 1000));
      visits.push({
        stopId: visit.stopId,
        arrivalAt: visit.arrivalAt,
        departureAt: visit.departureAt,
        waitingSeconds,
        legDistanceMeters: Math.max(0, visit.cumulativeDistanceMeters - previousDistance),
        legDurationSeconds: Math.max(0, visit.cumulativeDrivingSeconds - previousDriving),
      });
      previousDistance = visit.cumulativeDistanceMeters;
      previousDriving = visit.cumulativeDrivingSeconds;
    }
    const conflicts: TourPlanConflict[] = result.unassigned
      .filter((item) => byId.has(item.stopId))
      .map((item) => {
        const label = byId.get(item.stopId)!.label;
        if (item.reasonCode === '2') {
          return {
            stopId: item.stopId,
            code: 'TIME_WINDOW_MISSED',
            message: timeWindowMissedMessage(label),
          };
        }
        if (item.reasonCode === '50' || item.reasonCode === '51') {
          return { stopId: item.stopId, code: 'UNREACHABLE', message: unreachableMessage(label) };
        }
        return {
          stopId: item.stopId,
          code: 'UNASSIGNED',
          message: `${label} konnte nicht eingeplant werden.`,
        };
      });
    const lastVisit = visits[visits.length - 1];
    const plannedEndAt =
      result.returnToDepotArrivalAt ??
      (lastVisit === undefined ? departureAt : lastVisit.departureAt);
    const returnLeg =
      lastVisit === undefined
        ? null
        : {
            distanceMeters: Math.max(0, result.totalDistanceMeters - previousDistance),
            durationSeconds: Math.max(
              0,
              Math.round((plannedEndAt.getTime() - lastVisit.departureAt.getTime()) / 1000),
            ),
          };
    return {
      order: [...visits.map((visit) => visit.stopId), ...conflicts.map((c) => c.stopId)],
      visits,
      totalDistanceMeters: result.totalDistanceMeters,
      totalDurationSeconds: Math.max(
        0,
        Math.round((plannedEndAt.getTime() - departureAt.getTime()) / 1000),
      ),
      plannedStartAt: departureAt,
      plannedEndAt,
      returnLeg,
      conflicts,
      feasible: conflicts.length === 0,
      provider: this.gateway.providerName,
    };
  }

  // ── Übernehmen / Bewerten (CAS) ──────────────────────────────────────────

  async apply(
    tourId: string,
    actorId: string,
    input: { expectedVersion: number; order: readonly string[]; departureAt?: Date | undefined },
    now = new Date(),
  ): Promise<{ tour: LoadedTour; plan: TourPlanDto }> {
    void actorId;
    const loaded = await this.tours.load(tourId, now);
    this.assertPlannable(loaded.tour);
    this.assertVersion(loaded.tour, input.expectedVersion);
    const remainingIds = loaded.stops.filter(isRemaining).map((entry) => entry.stop.id);
    const requested = new Set(input.order);
    if (
      requested.size !== input.order.length ||
      requested.size !== remainingIds.length ||
      remainingIds.some((id) => !requested.has(id))
    ) {
      throw new AuthError(
        'VALIDATION',
        'Die Reihenfolge muss genau alle offenen Stopps der Tour enthalten.',
      );
    }
    const prepared = await this.prepare(loaded, now);
    if (prepared.status === 'blocked') throw this.blocked(prepared.reasons);
    if (prepared.stops.length === 0) {
      throw new AuthError('VALIDATION', 'Die Tour enthält keine offenen Stopps.');
    }
    const departureAt = input.departureAt ?? defaultTourDeparture(loaded.tour.tourDate, now);
    const byId = new Map(prepared.stops.map((stop) => [stop.entry.stop.id, stop]));
    const ordered = input.order.map((id) => byId.get(id)!);
    // Provider-Call OHNE DB-Sperre (Order §63).
    const matrix = await this.matrixFor([prepared.depot, ...ordered.map((s) => s.point)]);
    const plan = evaluateOrder({
      matrix,
      originIndex: 0,
      depotIndex: 0,
      stops: this.toPlanStops(ordered, 1),
      departureAt,
      provider: this.gateway.providerName,
    });
    await this.db.transaction(async (tx) => {
      const tour = await this.lockForWrite(tx, tourId, input.expectedVersion, remainingIds);
      const closed = (await this.tours.loadStops(tx, tourId)).filter(
        (entry) => !isRemaining(entry),
      );
      let sequence = 0;
      for (const entry of closed) {
        sequence += 1;
        await tx
          .update(tourStops)
          .set({ sequence, updatedAt: now })
          .where(eq(tourStops.id, entry.stop.id));
      }
      for (const stopId of plan.order) {
        sequence += 1;
        const visit = plan.visits.find((v) => v.stopId === stopId);
        await tx
          .update(tourStops)
          .set({
            sequence,
            plannedArrivalAt: visit?.arrivalAt ?? null,
            plannedDepartureAt: visit?.departureAt ?? null,
            legDistanceMeters: visit?.legDistanceMeters ?? null,
            legDurationSeconds: visit?.legDurationSeconds ?? null,
            updatedAt: now,
          })
          .where(eq(tourStops.id, stopId));
      }
      await tx
        .update(tours)
        .set({
          planningStatus: plan.feasible ? 'planned' : 'infeasible',
          plannedStartAt: plan.plannedStartAt,
          plannedEndAt: plan.plannedEndAt,
          plannedDistanceMeters: plan.totalDistanceMeters,
          plannedDurationSeconds: plan.totalDurationSeconds,
          routeCalculatedAt: now,
          routeProvider: this.gateway.providerName,
          version: tour.version + 1,
          updatedAt: now,
        })
        .where(eq(tours.id, tourId));
    });
    return { tour: await this.tours.load(tourId, now), plan: toPlanDto(plan) };
  }

  /** „Zeiten für aktuelle Reihenfolge“ – ohne Optimierung, speichert via CAS wie apply. */
  async evaluate(
    tourId: string,
    actorId: string,
    input: { expectedVersion: number; departureAt?: Date | undefined },
    now = new Date(),
  ): Promise<{ tour: LoadedTour; plan: TourPlanDto }> {
    const loaded = await this.tours.load(tourId, now);
    this.assertPlannable(loaded.tour);
    this.assertVersion(loaded.tour, input.expectedVersion);
    const order = loaded.stops.filter(isRemaining).map((entry) => entry.stop.id);
    return this.apply(tourId, actorId, { ...input, order }, now);
  }

  /**
   * Restroute der aktiven Tour (Design §6.5): nur verbleibende Stopps, Start
   * = frischer Live-Standort (≤ 10 min), sonst letzter erledigter Stopp bzw.
   * Depot; erledigte Stopps bleiben unverändert (Historie).
   */
  async recalculate(
    tourId: string,
    actorId: string,
    input: { expectedVersion: number },
    now = new Date(),
  ): Promise<{ tour: LoadedTour; plan: TourPlanDto }> {
    void actorId;
    const loaded = await this.tours.load(tourId, now);
    if (loaded.tour.status !== 'active') {
      throw new TourError(
        'CONFLICT',
        'TOUR_NOT_ACTIVE',
        'Die Restroute gibt es nur für aktive Touren.',
      );
    }
    this.assertVersion(loaded.tour, input.expectedVersion);
    const prepared = await this.prepare(loaded, now);
    if (prepared.status === 'blocked') throw this.blocked(prepared.reasons);
    if (prepared.stops.length === 0) {
      throw new AuthError('VALIDATION', 'Die Tour enthält keine offenen Stopps mehr.');
    }
    const remainingIds = prepared.stops.map((stop) => stop.entry.stop.id);
    const origin = await this.originFor(loaded, prepared.depot, now);
    const points = [origin, prepared.depot, ...prepared.stops.map((s) => s.point)];
    const matrix = await this.matrixFor(points);
    const plan = evaluateOrder({
      matrix,
      originIndex: 0,
      depotIndex: 1,
      stops: this.toPlanStops(prepared.stops, 2),
      departureAt: now,
      provider: this.gateway.providerName,
    });
    await this.db.transaction(async (tx) => {
      const tour = await this.lockForWrite(tx, tourId, input.expectedVersion, remainingIds);
      const stops = await this.tours.loadStops(tx, tourId);
      for (const visit of plan.visits) {
        await tx
          .update(tourStops)
          .set({
            plannedArrivalAt: visit.arrivalAt,
            plannedDepartureAt: visit.departureAt,
            legDistanceMeters: visit.legDistanceMeters,
            legDurationSeconds: visit.legDurationSeconds,
            updatedAt: now,
          })
          .where(eq(tourStops.id, visit.stopId));
      }
      const closedDistance = stops
        .filter((entry) => !isRemaining(entry))
        .reduce((sum, entry) => sum + (entry.stop.legDistanceMeters ?? 0), 0);
      const plannedStartAt = tour.plannedStartAt ?? tour.startedAt ?? now;
      await tx
        .update(tours)
        .set({
          planningStatus: plan.feasible ? 'planned' : 'infeasible',
          plannedStartAt,
          plannedEndAt: plan.plannedEndAt,
          plannedDistanceMeters: closedDistance + plan.totalDistanceMeters,
          plannedDurationSeconds: Math.max(
            0,
            Math.round((plan.plannedEndAt.getTime() - plannedStartAt.getTime()) / 1000),
          ),
          routeCalculatedAt: now,
          routeProvider: this.gateway.providerName,
          version: tour.version + 1,
          updatedAt: now,
        })
        .where(eq(tours.id, tourId));
    });
    return { tour: await this.tours.load(tourId, now), plan: toPlanDto(plan) };
  }

  private async originFor(loaded: LoadedTour, depot: GeoPoint, now: Date): Promise<GeoPoint> {
    const liveRows = await this.db
      .select()
      .from(tourLiveLocations)
      .where(eq(tourLiveLocations.tourId, loaded.tour.id));
    const live = liveRows[0];
    if (live !== undefined && now.getTime() - live.observedAt.getTime() <= LIVE_LOCATION_STALE_MS) {
      return { latitude: live.latitude, longitude: live.longitude };
    }
    const lastDone = [...loaded.stops].reverse().find((entry) => entry.state === 'done');
    if (lastDone !== undefined) {
      const address = await this.addresses.resolveOperativeAddress(this.db, lastDone.appointment);
      if (address.text !== null) {
        const resolution = await this.geocode(address.text, now);
        if (resolution.status === 'resolved' && resolution.point !== null) return resolution.point;
      }
    }
    return depot;
  }

  /**
   * Tour sperren, CAS prüfen und sicherstellen, dass die offenen Stopps noch
   * dieselben sind – Phase 13 (Fix F4): in derselben REIHENFOLGE (Sequence),
   * nicht nur als Menge; eine parallele Umsortierung ⇒ 409.
   */
  private async lockForWrite(
    tx: DatabaseTransaction,
    tourId: string,
    expectedVersion: number | undefined,
    remainingIds: readonly string[],
  ): Promise<Tour> {
    const tour = await this.tours.lockTour(tx, tourId);
    this.assertVersion(tour, expectedVersion);
    if (tour.status !== 'draft' && tour.status !== 'ready' && tour.status !== 'active') {
      throw new TourError('CONFLICT', 'TOUR_NOT_EDITABLE', 'Die Tour ist nicht mehr offen.');
    }
    const stops = await this.tours.loadStops(tx, tourId);
    const current = stops.filter(isRemaining).map((entry) => entry.stop.id);
    if (
      current.length !== remainingIds.length ||
      current.some((id, index) => id !== remainingIds[index])
    ) {
      throw new TourError(
        'CONFLICT',
        'TOUR_VERSION_CONFLICT',
        'Die Stopps der Tour haben sich während der Berechnung geändert. Bitte neu berechnen.',
      );
    }
    return tour;
  }
}
