import { processes, type Database } from '@mietroyal/database';
import { navigationLinks } from '@mietroyal/domain';
import type { OfflineTourSnapshot, OfflineTourStopSnapshot } from '@mietroyal/offline/shared';
import type { PermissionKey } from '@mietroyal/permissions';
import { inArray } from 'drizzle-orm';
import type { GeoPoint } from '../../routing/types.ts';
import type { TourService } from '../tour-service.ts';
import type { OperativeAddressResolver, TourGeocodingResolver } from '../types.ts';

/**
 * Phase 13 (Order §46, Design §11): Offline-Snapshot der EIGENEN aktiven
 * Tour (gespeicherter Fahrer oder Vertretung) für das Offline-Paket –
 * Reihenfolge, Terminart, Vorgangsnummer, Zeiten, operative Adresse,
 * Navigations-Links, Zustand. Sichtbarkeit wie die Tour-View des Fahrers
 * (Adressen nur für den Fahrer der Tour); keine GPS-Daten, keine Kunden-
 * namen/Telefonnummern. Kein Provider-Aufruf (nur Geocoding-Cache für die
 * Koordinate im Navigations-Link, sonst Adress-Variante).
 */
export interface OfflineTourSnapshotDeps {
  db: Database;
  tours: TourService;
  addresses: OperativeAddressResolver;
  geocoding?: TourGeocodingResolver | undefined;
}

export interface OfflineTourSnapshotSource {
  activeTourSnapshotFor(
    userId: string,
    effective: ReadonlySet<PermissionKey>,
    now: Date,
  ): Promise<OfflineTourSnapshot | null>;
}

export function createOfflineTourSnapshotSource(
  deps: OfflineTourSnapshotDeps,
): OfflineTourSnapshotSource {
  return {
    async activeTourSnapshotFor(userId, effective, now) {
      if (!effective.has('calendar.view')) return null;
      const loaded = await deps.tours.findActiveFor(userId, now);
      if (loaded === null) return null;
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
    },
  };
}
