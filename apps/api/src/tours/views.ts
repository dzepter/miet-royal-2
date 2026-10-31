import {
  bookings,
  customers,
  processes,
  staffUsers,
  tourDelayIncidents,
  tourLiveLocations,
  type Appointment,
  type Database,
  type Tour,
  type TourDelayIncident,
  type TourLiveLocation,
} from '@mietroyal/database';
import { berlinDateOf, navigationLinks, stopDeadline, type TourStopState } from '@mietroyal/domain';
import type { PermissionKey } from '@mietroyal/permissions';
import { and, inArray, isNull } from 'drizzle-orm';
import type { GeoPoint } from '../routing/types.ts';
import type { GeocodingResolution, OperativeAddress } from '../routing/geocoding-types.ts';
import { effectiveAssigneeForAppointment, loadSubstitutions } from '../scheduling/assignee.ts';
import { TOUR_MESSAGES } from './errors.ts';
import type { TourDelaySource } from './live/delay-state.ts';
import type { LoadedTour, TourService } from './tour-service.ts';
import type { OperativeAddressResolver, TourGeocodingResolver } from './types.ts';

/** Live-Standort älter als 10 Minuten ⇒ „nicht aktuell“ (Design §9). */
export const LIVE_LOCATION_STALE_MS = 10 * 60_000;

export type TourAddressStatus = 'ok' | 'missing' | 'review_required' | 'no_result' | 'unavailable';

export interface TourStopView {
  id: string;
  appointmentId: string;
  sequence: number;
  isPinned: boolean;
  bufferMinutes: number;
  state: TourStopState;
  appointment: {
    kind: Appointment['kind'];
    status: Appointment['status'];
    startAt: string | null;
    endAt: string | null;
    processId: string;
    processNumber: string;
    bookingId: string;
    /** Nur, wenn der Betrachter den Termin sehen darf (view_all/manage/eigene Zuständigkeit/Fahrer). */
    customerName: string | null;
    machineName: string | null;
    assignedUserId: string | null;
    effectiveAssigneeId: string | null;
  };
  address: {
    lines: string[];
    label: string;
    /** ok = Adresse vorhanden (point null ⇒ noch nicht geokodiert); Status aus dem Geocoding-Cache ohne Provider-Aufruf. */
    status: TourAddressStatus;
    point: { latitude: number; longitude: number } | null;
    cacheId: string | null;
    /** Nur bei review_required: Kandidaten für „Adresse für Route prüfen“. */
    candidates: { ref: string; label: string }[];
  };
  plannedArrivalAt: string | null;
  plannedDepartureAt: string | null;
  legDistanceMeters: number | null;
  legDurationSeconds: number | null;
  arrivedAt: string | null;
  skippedAt: string | null;
  deadlineAt: string | null;
  delay: { status: 'none' | 'risk' | 'unknown'; predictedArrivalAt?: string; incidentId?: string };
  travel: 'customer' | 'depot';
  navigation: { apple: string; android: string; web: string } | null;
}

export interface TourWarning {
  code: string;
  message: string;
  stopId?: string;
}

export interface TourView {
  id: string;
  tourDate: string;
  status: Tour['status'];
  planningStatus: Tour['planningStatus'];
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
  liveLocation: { observedAt: string; receivedAt: string; stale: boolean } | null;
  openIncidents: { id: string; stopId: string; predictedArrivalAt: string; deadlineAt: string }[];
  canStart: boolean;
  canEnd: boolean;
  canTakeover: boolean;
  canEdit: boolean;
  /** Vorgangs-Link `/vorgaenge/<id>` nur mit process.view_all (sonst nur Vorgangsnummer). */
  canOpenProcess: boolean;
}

export interface TourViewer {
  userId: string;
  permissions: ReadonlySet<PermissionKey>;
}

export interface TourViewDeps {
  db: Database;
  tours: TourService;
  addresses: OperativeAddressResolver;
  geocoding?: TourGeocodingResolver | undefined;
  /** Phase 13 (tours-live): In-Process-Stand der Verspätungsbewertung – fehlt er, ist die Prognose „unknown“. */
  delay?: TourDelaySource | undefined;
}

/** Phase 13 (tours-live): Warnungstexte der Verspätungsprognose (Design §13). */
export const DELAY_FORECAST_UNAVAILABLE_MESSAGE = 'Verspätungsprognose derzeit nicht verfügbar.';

const DELAY_KIND_LABELS: Record<Appointment['kind'], string> = {
  delivery: 'Liefertermin',
  pickup: 'Abholtermin',
  return: 'Rückgabetermin',
};

function iso(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

function customerLabel(row: {
  firstName: string | null;
  lastName: string | null;
  organizationName: string | null;
}): string {
  const name = row.organizationName ?? `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim();
  return name === '' ? 'Unbekannt' : name;
}

function machineNameOf(itemsSnapshot: unknown): string | null {
  const items = (Array.isArray(itemsSnapshot) ? itemsSnapshot : []) as {
    kind?: string;
    productSnapshot?: { name?: unknown } | null;
    description?: string;
  }[];
  const machine = items.find((item) => item.kind === 'machine');
  const name = machine?.productSnapshot?.name;
  return typeof name === 'string' ? name : (machine?.description ?? null);
}

export async function buildTourViews(
  deps: TourViewDeps,
  loadedTours: readonly LoadedTour[],
  viewer: TourViewer,
  now = new Date(),
): Promise<TourView[]> {
  const { db } = deps;
  const allStops = loadedTours.flatMap((entry) => entry.stops);
  const processIds = [...new Set(allStops.map((entry) => entry.appointment.processId))];
  const bookingIds = [...new Set(allStops.map((entry) => entry.appointment.bookingId))];
  const tourIds = loadedTours.map((entry) => entry.tour.id);

  const processRows =
    processIds.length === 0
      ? []
      : await db
          .select({
            id: processes.id,
            processNumber: processes.processNumber,
            customerId: processes.customerId,
          })
          .from(processes)
          .where(inArray(processes.id, processIds));
  const customerIds = [...new Set(processRows.map((row) => row.customerId))];
  const customerRows =
    customerIds.length === 0
      ? []
      : await db
          .select({
            id: customers.id,
            firstName: customers.firstName,
            lastName: customers.lastName,
            organizationName: customers.organizationName,
          })
          .from(customers)
          .where(inArray(customers.id, customerIds));
  const bookingRows =
    bookingIds.length === 0
      ? []
      : await db
          .select({ id: bookings.id, itemsSnapshot: bookings.itemsSnapshot })
          .from(bookings)
          .where(inArray(bookings.id, bookingIds));
  const userRows = await db
    .select({ id: staffUsers.id, firstName: staffUsers.firstName, lastName: staffUsers.lastName })
    .from(staffUsers);
  const userNames = new Map(
    userRows.map((row) => [row.id, `${row.firstName} ${row.lastName}`.trim()]),
  );
  const processNumbers = new Map(processRows.map((row) => [row.id, row.processNumber]));
  const customerByProcess = new Map<string, string>();
  for (const process of processRows) {
    const customer = customerRows.find((row) => row.id === process.customerId);
    customerByProcess.set(
      process.id,
      customer === undefined ? 'Unbekannt' : customerLabel(customer),
    );
  }
  const machineByBooking = new Map(
    bookingRows.map((row) => [row.id, machineNameOf(row.itemsSnapshot)]),
  );
  const substitutions = await loadSubstitutions(db);
  const liveRows: TourLiveLocation[] =
    tourIds.length === 0
      ? []
      : await db.select().from(tourLiveLocations).where(inArray(tourLiveLocations.tourId, tourIds));
  const incidentRows: TourDelayIncident[] =
    tourIds.length === 0
      ? []
      : await db
          .select()
          .from(tourDelayIncidents)
          .where(
            and(inArray(tourDelayIncidents.tourId, tourIds), isNull(tourDelayIncidents.resolvedAt)),
          );
  const depot = await deps.addresses.getDepotAddress(db);

  // Adressen je Stopp (Adressautorität) + Cache-Stand der Geokodierung (kein Provider-Aufruf).
  const addressByStop = new Map<string, OperativeAddress>();
  const geocodeByText = new Map<string, GeocodingResolution | null>();
  for (const entry of allStops) {
    const address = await deps.addresses.resolveOperativeAddress(db, entry.appointment);
    addressByStop.set(entry.stop.id, address);
    if (address.text !== null && deps.geocoding?.peekCached !== undefined) {
      if (!geocodeByText.has(address.text)) {
        geocodeByText.set(address.text, await deps.geocoding.peekCached(address.text, { now }));
      }
    }
  }

  const viewAll =
    viewer.permissions.has('calendar.view_all') || viewer.permissions.has('calendar.manage');
  const canManage = viewer.permissions.has('calendar.manage');
  const todayIso = berlinDateOf(now);

  return loadedTours.map((loaded) => {
    const { tour } = loaded;
    const effectiveDriverId = deps.tours.effectiveDriverId(tour, substitutions, now);
    const isDriver = tour.assignedUserId === viewer.userId || effectiveDriverId === viewer.userId;
    // Phase 13 (Fix F2/F3): offene Incidents zählen nur für AKTIVE Touren und nur
    // für verbleibende Stopps (open/arrived) als „risk“ – erledigte/übersprungene
    // Stopps und beendete Touren zeigen nie eine stehengebliebene Warnung.
    const remainingStopIds = new Set(
      loaded.stops
        .filter((entry) => entry.state === 'open' || entry.state === 'arrived')
        .map((entry) => entry.stop.id),
    );
    const tourIncidents =
      tour.status === 'active'
        ? incidentRows.filter((row) => row.tourId === tour.id && remainingStopIds.has(row.stopId))
        : [];
    const incidentsByStop = new Map(tourIncidents.map((row) => [row.stopId, row]));
    const warnings: TourWarning[] = [];
    if (tour.planningStatus === 'stale') {
      warnings.push({
        code: 'PLAN_STALE',
        message:
          'Termine, Adressen oder Reihenfolge haben sich seit der letzten Berechnung geändert – Route neu berechnen.',
      });
    }
    if (tour.planningStatus === 'infeasible') {
      warnings.push({
        code: 'PLAN_INFEASIBLE',
        message: 'Die letzte Berechnung konnte nicht alle Zeitvorgaben einhalten.',
      });
    }
    if (depot.status === 'missing') {
      warnings.push({ code: 'DEPOT_ADDRESS_MISSING', message: TOUR_MESSAGES.DEPOT_MISSING });
    }
    // Phase 13 (tours-live): Live-Prognose nur mit frischem Standort UND frischer
    // In-Process-Bewertung (ok/risk); sonst „unknown“ – nie eine stille Entwarnung.
    const live = liveRows.find((row) => row.tourId === tour.id) ?? null;
    const liveFresh =
      live !== null && now.getTime() - live.observedAt.getTime() <= LIVE_LOCATION_STALE_MS;
    const lastEvaluation = deps.delay?.get(tour.id);
    const forecastAvailable =
      tour.status === 'active' &&
      liveFresh &&
      lastEvaluation !== undefined &&
      lastEvaluation.status !== 'unavailable' &&
      now.getTime() - lastEvaluation.evaluatedAt.getTime() <= LIVE_LOCATION_STALE_MS;
    let forecastUnknown = false;
    const isOpen = tour.status === 'draft' || tour.status === 'ready' || tour.status === 'active';

    const stops: TourStopView[] = loaded.stops.map((entry) => {
      const { stop, appointment } = entry;
      const address = addressByStop.get(stop.id)!;
      const cached = address.text === null ? null : (geocodeByText.get(address.text) ?? null);
      let status: TourAddressStatus = address.status === 'missing' ? 'missing' : 'ok';
      let point: GeoPoint | null = null;
      let cacheId: string | null = null;
      let candidates: { ref: string; label: string }[] = [];
      if (status === 'ok' && cached !== null) {
        cacheId = cached.cacheId;
        if (cached.status === 'resolved') point = cached.point;
        else if (cached.status === 'review_required') {
          status = 'review_required';
          candidates = cached.candidates.map((c) => ({ ref: c.ref, label: c.label }));
        } else if (cached.status === 'no_result') status = 'no_result';
      }
      if (status === 'missing') {
        warnings.push({
          code: 'ADDRESS_MISSING',
          message: TOUR_MESSAGES.ADDRESS_MISSING,
          stopId: stop.id,
        });
      } else if (status === 'review_required') {
        warnings.push({
          code: 'GEOCODING_REVIEW_REQUIRED',
          message: 'Adresse ist mehrdeutig – bitte „Adresse für Route prüfen“.',
          stopId: stop.id,
        });
      } else if (status === 'no_result') {
        warnings.push({
          code: 'GEOCODING_NO_RESULT',
          message: 'Adresse konnte nicht gefunden werden – Route nicht berechenbar.',
          stopId: stop.id,
        });
      }
      const effectiveAssigneeId = effectiveAssigneeForAppointment(appointment, substitutions, now);
      const customerVisible =
        viewAll ||
        isDriver ||
        appointment.assignedUserId === viewer.userId ||
        effectiveAssigneeId === viewer.userId;
      const incident = incidentsByStop.get(stop.id);
      const label = address.lines.join(', ');
      const remaining = entry.state === 'open' || entry.state === 'arrived';
      // Phase 13 (Fix N3): Termin inzwischen auf einen anderen Tag verschoben ⇒
      // zusätzlich zur Stale-Markierung eine eigene Warnung je Stopp.
      if (
        isOpen &&
        remaining &&
        appointment.startAt !== null &&
        berlinDateOf(appointment.startAt) !== tour.tourDate
      ) {
        warnings.push({
          code: 'APPOINTMENT_NOT_ON_TOUR_DATE',
          message: 'Termin liegt nicht mehr am Tourtag.',
          stopId: stop.id,
        });
      }
      let delay: TourStopView['delay'];
      if (incident !== undefined) {
        delay = {
          status: 'risk',
          predictedArrivalAt: incident.predictedArrivalAt.toISOString(),
          incidentId: incident.id,
        };
        warnings.push({
          code: 'DELAY_RISK',
          message: `${DELAY_KIND_LABELS[appointment.kind]} ${processNumbers.get(appointment.processId) ?? ''} droht den Termin zu verpassen.`,
          stopId: stop.id,
        });
      } else if (tour.status === 'active' && remaining && !forecastAvailable) {
        delay = { status: 'unknown' };
        forecastUnknown = true;
      } else {
        delay = { status: 'none' };
      }
      return {
        id: stop.id,
        appointmentId: appointment.id,
        sequence: stop.sequence,
        isPinned: stop.isPinned,
        bufferMinutes: stop.bufferMinutes,
        state: entry.state,
        appointment: {
          kind: appointment.kind,
          status: appointment.status,
          startAt: iso(appointment.startAt),
          endAt: iso(appointment.endAt),
          processId: appointment.processId,
          processNumber: processNumbers.get(appointment.processId) ?? '',
          bookingId: appointment.bookingId,
          customerName: customerVisible
            ? (customerByProcess.get(appointment.processId) ?? 'Unbekannt')
            : null,
          machineName: machineByBooking.get(appointment.bookingId) ?? null,
          assignedUserId: appointment.assignedUserId,
          effectiveAssigneeId,
        },
        address: {
          lines: address.lines,
          label: address.status === 'missing' ? 'Adresse fehlt' : label,
          status,
          point,
          cacheId,
          candidates,
        },
        plannedArrivalAt: iso(stop.plannedArrivalAt),
        plannedDepartureAt: iso(stop.plannedDepartureAt),
        legDistanceMeters: stop.legDistanceMeters,
        legDurationSeconds: stop.legDurationSeconds,
        arrivedAt: iso(stop.arrivedAt),
        skippedAt: iso(stop.skippedAt),
        deadlineAt: iso(stopDeadline(appointment)),
        delay,
        travel: appointment.locationKind === 'customer' ? 'customer' : 'depot',
        navigation:
          address.status === 'missing' ? null : navigationLinks(point, address.text ?? label),
      };
    });

    const nextStop =
      stops.find((stop) => stop.state === 'open' || stop.state === 'arrived') ?? null;
    if (forecastUnknown) {
      warnings.push({
        code: 'DELAY_FORECAST_UNAVAILABLE',
        message: DELAY_FORECAST_UNAVAILABLE_MESSAGE,
      });
    }
    return {
      id: tour.id,
      tourDate: tour.tourDate,
      status: tour.status,
      planningStatus: tour.planningStatus,
      version: tour.version,
      assignedUserId: tour.assignedUserId,
      assignedName: userNames.get(tour.assignedUserId) ?? null,
      effectiveDriverId,
      effectiveDriverName:
        effectiveDriverId === null ? null : (userNames.get(effectiveDriverId) ?? null),
      substituted: effectiveDriverId !== tour.assignedUserId,
      startedAt: iso(tour.startedAt),
      endedAt: iso(tour.endedAt),
      endReason: tour.endReason,
      cancelledAt: iso(tour.cancelledAt),
      plannedStartAt: iso(tour.plannedStartAt),
      plannedEndAt: iso(tour.plannedEndAt),
      plannedDistanceMeters: tour.plannedDistanceMeters,
      plannedDurationSeconds: tour.plannedDurationSeconds,
      routeCalculatedAt: iso(tour.routeCalculatedAt),
      routeProvider: tour.routeProvider,
      depot: {
        label: depot.status === 'missing' ? 'Depotadresse fehlt' : depot.lines.join(', '),
        status: depot.status,
      },
      stops,
      warnings,
      nextStop,
      liveLocation:
        live === null
          ? null
          : {
              observedAt: live.observedAt.toISOString(),
              receivedAt: live.receivedAt.toISOString(),
              stale: !liveFresh,
            },
      openIncidents: tourIncidents.map((row) => ({
        id: row.id,
        stopId: row.stopId,
        predictedArrivalAt: row.predictedArrivalAt.toISOString(),
        deadlineAt: row.deadlineAt.toISOString(),
      })),
      canStart:
        (tour.status === 'draft' || tour.status === 'ready') &&
        tour.tourDate === todayIso &&
        (canManage || isDriver),
      canEnd: tour.status === 'active' && (canManage || isDriver),
      canTakeover:
        tour.status === 'active' && !isDriver && viewer.permissions.has('appointment.assign'),
      canEdit: isOpen && canManage,
      canOpenProcess: viewer.permissions.has('process.view_all'),
    };
  });
}

export async function buildTourView(
  deps: TourViewDeps,
  loaded: LoadedTour,
  viewer: TourViewer,
  now = new Date(),
): Promise<TourView> {
  const [view] = await buildTourViews(deps, [loaded], viewer, now);
  return view!;
}
