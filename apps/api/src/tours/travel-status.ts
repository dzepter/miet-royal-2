import { appointments, tourStops, tours, type Database } from '@mietroyal/database';
import { tourStopState } from '@mietroyal/domain';
import { and, asc, eq, isNull } from 'drizzle-orm';

export type CustomerTravelStatus = { status: 'none' | 'en_route' };

/**
 * Phase 13 (Order §56–§58, Design §10): interner Status „Unterwegs“ je
 * Buchung – Vorbereitung für Phase 15, KEIN Endpunkt. en_route ⇔ eine
 * AKTIVE Tour hat als NÄCHSTEN offenen Stopp (kleinste Sequenz unter
 * open/arrived) einen Termin dieser Buchung mit locationKind 'customer'
 * (Kundenfahrt; Depot-/Selbstabholungsstopps nie – Locationsemantik, nicht
 * Namensraten). Kein ETA, kein GPS, kein Fahrername.
 */
export async function getCustomerTravelStatus(
  db: Database,
  bookingId: string,
  now = new Date(),
): Promise<CustomerTravelStatus> {
  void now;
  const candidates = await db
    .select({ tourId: tourStops.tourId })
    .from(tourStops)
    .innerJoin(appointments, eq(appointments.id, tourStops.appointmentId))
    .innerJoin(tours, eq(tours.id, tourStops.tourId))
    .where(
      and(
        eq(appointments.bookingId, bookingId),
        eq(tours.status, 'active'),
        isNull(tourStops.releasedAt),
      ),
    );
  const tourIds = [...new Set(candidates.map((row) => row.tourId))];
  for (const tourId of tourIds) {
    const rows = await db
      .select({ stop: tourStops, appointment: appointments })
      .from(tourStops)
      .innerJoin(appointments, eq(appointments.id, tourStops.appointmentId))
      .where(and(eq(tourStops.tourId, tourId), isNull(tourStops.releasedAt)))
      .orderBy(asc(tourStops.sequence), asc(tourStops.createdAt));
    const next = rows.find((row) => {
      const state = tourStopState({
        appointmentStatus: row.appointment.status,
        skippedAt: row.stop.skippedAt,
        arrivedAt: row.stop.arrivedAt,
      });
      return state === 'open' || state === 'arrived';
    });
    if (
      next !== undefined &&
      next.appointment.bookingId === bookingId &&
      next.appointment.locationKind === 'customer'
    ) {
      return { status: 'en_route' };
    }
  }
  return { status: 'none' };
}
