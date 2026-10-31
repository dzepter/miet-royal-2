import { processes, type Database } from '@mietroyal/database';
import { navigationLinks } from '@mietroyal/domain';
import type { OfflineTourSnapshot, OfflineTourStopSnapshot } from '@mietroyal/offline/shared';
import type { PermissionKey } from '@mietroyal/permissions';
import { inArray } from 'drizzle-orm';
import type { GeoPoint } from '../../routing/types.ts';
import type { LoadedTour, TourService } from '../tour-service.ts';
import type { OperativeAddressResolver, TourGeocodingResolver } from '../types.ts';

/**
 * Phase 13 (Order §46, Design §11): Offline-Snapshots der EIGENEN aktiven
 * Touren (gespeicherter Fahrer oder Vertretung) für das Offline-Paket –
 * je Tour Reihenfolge, Terminart, Vorgangsnummer, Zeiten, operative Adresse,
 * Navigations-Links, Zustand. Sichtbarkeit wie die Tour-View des Fahrers
 * (Adressen nur für den Fahrer der Tour); keine GPS-Daten, keine Kunden-
 * namen/Telefonnummern. Kein Provider-Aufruf (nur Geocoding-Cache für die
 * Koordinate im Navigations-Link, sonst Adress-Variante).
 *
 * Phase 13 Corr (§3): Ist die Person effektiv für mehrere aktive Touren
 * zuständig (Planungskonflikt, z. B. nachträgliche Vertretung), enthält das
 * Paket ALLE diese Touren (`TourService.resolveActiveToursFor`, Reihenfolge
 * started_at, id) – keine wird still auf „die erste“ reduziert. Online wird
 * der Konflikt über `GET /staff/tours/active` (`conflict`) und die
 * View-Warnung MULTIPLE_ACTIVE_TOURS ausgewiesen; offline sind alle Touren
 * read-only lesbar, Tour-Mutationen und GPS bleiben online-only.
 */
export interface OfflineTourSnapshotDeps {
  db: Database;
  tours: TourService;
  addresses: OperativeAddressResolver;
  geocoding?: TourGeocodingResolver | undefined;
}

export interface OfflineTourSnapshotSource {
  /**
   * Alle aktiven Touren der Person als Snapshots (nur mit `calendar.view`,
   * sonst `[]`): 0 ⇒ `[]`, 1 ⇒ `[Tour]`, Konflikt ⇒ alle in deterministischer
   * Reihenfolge (started_at, id).
   */
  activeTourSnapshotsFor(
    userId: string,
    effective: ReadonlySet<PermissionKey>,
    now: Date,
  ): Promise<OfflineTourSnapshot[]>;
}

export function createOfflineTourSnapshotSource(
  deps: OfflineTourSnapshotDeps,
): OfflineTourSnapshotSource {
  return {
    async activeTourSnapshotsFor(userId, effective, now) {
      if (!effective.has('calendar.view')) return [];
      const resolution = await deps.tours.resolveActiveToursFor(userId, now);
      if (resolution.kind === 'none') return [];
      const active = resolution.kind === 'single' ? [resolution.tour] : resolution.tours;
      const snapshots: OfflineTourSnapshot[] = [];
      for (const loaded of active) snapshots.push(await snapshotOf(deps, loaded, now));
      return snapshots;
    },
  };
}

/** Exakt die bisherigen Felder je Tour – keine Vorgangs-/Kundendaten, kein GPS. */
async function snapshotOf(
  deps: OfflineTourSnapshotDeps,
  loaded: LoadedTour,
  now: Date,
): Promise<OfflineTourSnapshot> {
  const processIds = [...new Set(loaded.stops.map((entry) => entry.appointment.processId))];
  const processRows =
    processIds.length === 0
      ? []
      : await deps.db
          .select({ id: processes.id, processNumber: processes.processNumber })
          .from(processes)
          .where(inArray(processes.id, processIds));
  const processNumbers = new Map(processRows.map((row) => [row.id, row.processNumber]));
  const stops: OfflineTourStopSnapshot[] = [];
  for (const entry of loaded.stops) {
    const address = await deps.addresses.resolveOperativeAddress(deps.db, entry.appointment);
    let point: GeoPoint | null = null;
    if (address.text !== null && deps.geocoding?.peekCached !== undefined) {
      const cached = await deps.geocoding.peekCached(address.text, { now });
      if (cached?.status === 'resolved') point = cached.point;
    }
    stops.push({
      stopId: entry.stop.id,
      appointmentId: entry.appointment.id,
      sequence: entry.stop.sequence,
      kind: entry.appointment.kind,
      processNumber: processNumbers.get(entry.appointment.processId) ?? '',
      processId: entry.appointment.processId,
      bookingId: entry.appointment.bookingId,
      startAt: entry.appointment.startAt?.toISOString() ?? null,
      endAt: entry.appointment.endAt?.toISOString() ?? null,
      addressLines: address.status === 'missing' ? [] : address.lines,
      navigation:
        address.status === 'missing'
          ? null
          : navigationLinks(point, address.text ?? address.lines.join(', ')),
      state: entry.state,
    });
  }
  return {
    tourId: loaded.tour.id,
    tourDate: loaded.tour.tourDate,
    status: loaded.tour.status,
    version: loaded.tour.version,
    snapshotAt: now.toISOString(),
    stops,
  };
}
