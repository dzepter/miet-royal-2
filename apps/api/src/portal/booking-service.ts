import type { Database } from '@mietroyal/database';
import { navigationLinks } from '@mietroyal/domain';
import type { CancellationService } from '../cancellation/cancellation-service.ts';
import { getPickupExactAddress } from '../crm/settings-service.ts';
import { SchedulingService } from '../scheduling/scheduling-service.ts';
import { getCustomerTravelStatus } from '../tours/travel-status.ts';
import { portalInvoiceStatus } from './invoice-status.ts';
import { listVisibleBookings, resolveVisibleBooking, type VisibleBooking } from './visibility.ts';
import {
  PORTAL_STATE_LABELS,
  buildPortalBookingSummary,
  buildPortalCancellationInfo,
  buildPortalDelivery,
  buildPortalEvent,
  buildPortalItems,
  buildPortalPrice,
  portalAppointmentLabel,
  type PortalAppointment,
  type PortalBookingSummary,
  type PortalBookingView,
} from './views.ts';

/**
 * Phase 15 (Order §16–§22, Design §2.2): Buchungsansicht des Kundenportals –
 * ausschließlich aus den eingefrorenen Snapshots der Buchung (keine
 * Neuberechnung, kein Live-Preis), Terminen der bestehenden Terminquelle, der
 * kanonischen Abholadresse und dem „Unterwegs“-Status (Phase 13).
 */
export interface PortalBookingServiceDeps {
  db: Database;
  /** Für `canCancelOnline` (Vorschau ohne Blocker) – Phase-9-Regel, nie dupliziert. */
  cancellation: Pick<CancellationService, 'preview'>;
  scheduling?: SchedulingService;
}

export class PortalBookingService {
  private readonly db: Database;
  private readonly cancellation: Pick<CancellationService, 'preview'>;
  private readonly scheduling: SchedulingService;

  constructor(deps: PortalBookingServiceDeps) {
    this.db = deps.db;
    this.cancellation = deps.cancellation;
    this.scheduling = deps.scheduling ?? new SchedulingService(deps.db);
  }

  /** Aktuelle Buchungen (Order §15) – 0, 1 oder mehrere; nie Historie. */
  async listSummaries(customerId: string, now = new Date()): Promise<PortalBookingSummary[]> {
    const visible = await listVisibleBookings(this.db, customerId, now);
    const summaries: PortalBookingSummary[] = [];
    for (const entry of visible) {
      summaries.push(buildPortalBookingSummary(entry, await this.travelStatus(entry, now)));
    }
    return summaries;
  }

  /**
   * Buchung des Kunden auflösen oder null. Phase 15 (Review R12): das 24-h-Fenster eines
   * kostenfreien Kundenstornos (`confirmationWindow`) gilt NUR für die Detailansicht und die
   * Antwort des Storno-POST; Dokumente, Vorschau und Travel-Status lösen ohne Fenster auf.
   */
  async resolve(
    customerId: string,
    bookingId: string,
    now = new Date(),
    options: { confirmationWindow?: boolean } = {},
  ) {
    return resolveVisibleBooking(this.db, customerId, bookingId, now, {
      includeCancelledFree: options.confirmationWindow ?? false,
    });
  }

  async travelStatus(visible: VisibleBooking, now = new Date()): Promise<'none' | 'en_route'> {
    // Nur Lieferungen fahren zum Kunden; Selbstabholung ist nie „unterwegs“.
    if (visible.booking.fulfillment !== 'delivery' || visible.portalState !== 'active') {
      return 'none';
    }
    return (await getCustomerTravelStatus(this.db, visible.booking.id, now)).status;
  }

  async view(visible: VisibleBooking, now = new Date()): Promise<PortalBookingView> {
    const booking = visible.booking;
    const [appointments, pickup, travelStatus, canCancelOnline] = await Promise.all([
      this.appointments(visible, now),
      this.pickup(visible),
      this.travelStatus(visible, now),
      this.canCancelOnline(visible, now),
    ]);
    return {
      bookingId: booking.id,
      processNumber: visible.process.processNumber,
      portalState: visible.portalState,
      stateLabel: PORTAL_STATE_LABELS[visible.portalState],
      event: buildPortalEvent(booking.eventSnapshot),
      fulfillment: booking.fulfillment,
      pickup,
      delivery: buildPortalDelivery(booking.fulfillment, booking.deliverySnapshot),
      appointments,
      items: buildPortalItems(booking.itemsSnapshot),
      price: buildPortalPrice(booking.totalsSnapshot, booking.deliverySnapshot),
      invoice: portalInvoiceStatus(visible),
      cancellation: buildPortalCancellationInfo(visible),
      travelStatus,
      canCancelOnline,
      canMessage: visible.portalState === 'active',
      acceptedAt: booking.acceptedAt.toISOString(),
    };
  }

  /**
   * Termine aus der bestehenden Terminquelle (Order §18): exakt = Start ohne
   * Ende, Fenster = Start + Ende, ungeplant = kein Start. Aus Fenstern wird
   * NIE eine Uhrzeit erfunden. Nur kind/startAt/endAt/status verlassen den Server.
   */
  private async appointments(visible: VisibleBooking, now: Date): Promise<PortalAppointment[]> {
    const entries = await this.scheduling.listForProcess(visible.process.id, now);
    return entries
      .filter((entry) => entry.bookingId === visible.booking.id)
      .map((entry) => ({
        kind: entry.kind,
        label: portalAppointmentLabel(entry.kind, visible.booking.fulfillment),
        timing: entry.startAt === null ? 'unplanned' : entry.endAt === null ? 'exact' : 'window',
        startAt: entry.startAt,
        endAt: entry.endAt,
        status: entry.status,
      }));
  }

  /**
   * Abholung (Order §19/§20): nur die kanonische `pickup_exact_address`; nicht
   * gepflegt ⇒ keine Adresse (nie erfunden). Navigation nur aus der Adresse –
   * ohne Namen, Vorgangsnummer oder Schlüssel.
   */
  private async pickup(visible: VisibleBooking): Promise<PortalBookingView['pickup']> {
    if (visible.booking.fulfillment !== 'pickup') return null;
    const address = await getPickupExactAddress(this.db);
    return { address, navigation: navigationLinks(null, address) };
  }

  /** Online-Storno möglich = Zustand aktiv UND Phase-9-Vorschau ohne Blocker. */
  private async canCancelOnline(visible: VisibleBooking, now: Date): Promise<boolean> {
    if (visible.portalState !== 'active') return false;
    try {
      const preview = await this.cancellation.preview(visible.process.id, now);
      return preview.blockers.length === 0;
    } catch {
      return false;
    }
  }
}
