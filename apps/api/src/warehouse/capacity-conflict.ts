import { appointments, bookings, processes, type Database } from '@mietroyal/database';
import { and, eq, inArray, ne } from 'drizzle-orm';
import {
  conflictFingerprint,
  type ConflictAppointment,
  type ConflictProvider,
  type DetectedConflict,
} from '../scheduling/conflicts.ts';
import { MachineAvailabilityService, type DemandInterval } from './availability.ts';
import { blockOverlaps } from './machine-service.ts';

/**
 * Kapazitätskonflikt-Provider (Phase-5-Order §18/§47): registriert sich in
 * der bestehenden Phase-4-Konfliktarchitektur (keine zweite Engine) und
 * warnt, wenn für einen Maschinentyp im relevanten Zeitraum mehr
 * bestätigter Bedarf besteht als einsetzbare physische Maschinen. Es wird
 * KEINE konkrete Maschine zugewiesen; der Konflikt ist eine WARNUNG, keine
 * Blockade.
 *
 * Der Fingerprint rechnet den kapazitätsrelevanten Zustand mit ein
 * (Maschinenbestand/-status, offene Sperren, beteiligte Buchungszeiträume):
 * ändert sich davon etwas, entsteht ein NEUER Fingerprint – eine alte
 * "Konflikt gelöst"-Suppression wirkt dann nicht mehr (Order §47).
 */

interface Cluster {
  demands: DemandInterval[];
  from: Date;
  to: Date;
}

function buildClusters(demands: readonly DemandInterval[]): Cluster[] {
  const sorted = [...demands].sort((a, b) => a.from.getTime() - b.from.getTime());
  const clusters: Cluster[] = [];
  for (const demand of sorted) {
    const current = clusters[clusters.length - 1];
    if (current !== undefined && demand.from.getTime() < current.to.getTime()) {
      current.demands.push(demand);
      if (demand.to.getTime() > current.to.getTime()) current.to = demand.to;
    } else {
      clusters.push({ demands: [demand], from: demand.from, to: demand.to });
    }
  }
  return clusters;
}

export function createMachineCapacityProvider(db: Database): ConflictProvider {
  const availability = new MachineAvailabilityService(db);
  return {
    key: 'machine_capacity',
    async detect(context): Promise<DetectedConflict[]> {
      const now = new Date();
      const contextBookingIds = new Set(
        context.appointments
          .filter((appointment) => appointment.status === 'scheduled')
          .map((appointment) => appointment.bookingId),
      );
      if (contextBookingIds.size === 0) return [];
      const bookingRows = await db
        .select({ id: bookings.id, itemsSnapshot: bookings.itemsSnapshot })
        .from(bookings)
        .innerJoin(processes, eq(processes.id, bookings.processId))
        .where(
          and(inArray(bookings.id, [...contextBookingIds]), ne(processes.mainStatus, 'cancelled')),
        );
      const productIds = new Set<string>();
      for (const row of bookingRows) {
        const items = (row.itemsSnapshot ?? []) as { kind?: string; productId?: string }[];
        const machineItem = items.find(
          (item) => item.kind === 'machine' && typeof item.productId === 'string',
        );
        if (machineItem?.productId !== undefined) productIds.add(machineItem.productId);
      }

      const conflicts: DetectedConflict[] = [];
      for (const productId of productIds) {
        const state = await availability.loadState(productId, now);
        if (state.rows.length === 0) continue;
        const { determined } = await availability.demandForProduct(productId);
        for (const cluster of buildClusters(determined)) {
          // Relevanz: mindestens eine Buchung des Clusters ist im Kontext.
          if (!cluster.demands.some((demand) => contextBookingIds.has(demand.bookingId))) continue;
          // Vollständig vergangene Zeiträume werden nicht rückwirkend mit dem
          // HEUTIGEN Flottenzustand bewertet – dort ist nichts mehr zu tun,
          // und abgelaufene Sperren/heutige Status wären historisch falsch.
          if (cluster.to.getTime() <= now.getTime()) continue;

          // Kritische Zeitpunkte: Bedarfstarts + Sperrbeginne im Cluster.
          const instants = new Set<number>(cluster.demands.map((demand) => demand.from.getTime()));
          for (const block of state.blocks) {
            const t = block.startsAt.getTime();
            if (t >= cluster.from.getTime() && t < cluster.to.getTime()) instants.add(t);
          }
          let peakDemand = 0;
          let usableAtPeak = state.rows.length;
          let maxShortage = 0;
          for (const instantMs of instants) {
            // Bedarf = Summe der gebuchten MENGEN (eine Buchung über 2
            // Maschinen belegt 2), nicht Anzahl Buchungen.
            const demandAt = cluster.demands
              .filter(
                (demand) => demand.from.getTime() <= instantMs && demand.to.getTime() > instantMs,
              )
              .reduce((sum, demand) => sum + demand.quantity, 0);
            const usable = availability.usableAt(state, new Date(instantMs));
            if (demandAt - usable > maxShortage) {
              maxShortage = demandAt - usable;
              peakDemand = demandAt;
              usableAtPeak = usable;
            }
          }
          if (maxShortage <= 0) continue;

          const clusterBookingIds = cluster.demands.map((demand) => demand.bookingId);
          const memberRows = await db
            .select()
            .from(appointments)
            .where(
              and(
                inArray(appointments.bookingId, clusterBookingIds),
                ne(appointments.status, 'cancelled'),
              ),
            );
          const members: ConflictAppointment[] = memberRows.map((row) => ({
            ...row,
            effectiveAssigneeId: null,
          }));
          const extra = {
            productId,
            machines: state.rows
              .map((machine) => ({ id: machine.id, status: machine.status }))
              .sort((a, b) => a.id.localeCompare(b.id)),
            // NUR Sperren, die das Cluster-Fenster berühren: irrelevante
            // (z. B. längst abgelaufene oder weit entfernte) Sperren dürfen
            // eine "Konflikt gelöst"-Suppression nicht entwerten (§47 –
            // neuer Fingerprint nur bei kapazitätsrelevanter Änderung).
            blocks: state.blocks
              .filter((block) => blockOverlaps(block, cluster.from, cluster.to))
              .map((block) => ({
                machineId: block.machineId,
                startsAt: block.startsAt.toISOString(),
                endsAt: block.endsAt.toISOString(),
              }))
              .sort((a, b) =>
                `${a.machineId}|${a.startsAt}|${a.endsAt}`.localeCompare(
                  `${b.machineId}|${b.startsAt}|${b.endsAt}`,
                ),
              ),
            demand: cluster.demands
              .map((demand) => ({
                bookingId: demand.bookingId,
                quantity: demand.quantity,
                from: demand.from.toISOString(),
                to: demand.to.toISOString(),
              }))
              .sort((a, b) => a.bookingId.localeCompare(b.bookingId)),
          };
          conflicts.push({
            type: 'machine_capacity',
            severity: 'warning',
            appointmentIds: memberRows.map((row) => row.id).sort(),
            reason: `Kapazitätswarnung ${state.product.name}: Im Zeitraum werden bis zu ${peakDemand} Maschinen benötigt, aber nur ${usableAtPeak} sind einsetzbar (${cluster.demands
              .map((demand) => demand.processNumber)
              .sort()
              .join(', ')}).`,
            fingerprint: conflictFingerprint('machine_capacity', members, extra),
          });
        }
      }
      return conflicts;
    },
  };
}
