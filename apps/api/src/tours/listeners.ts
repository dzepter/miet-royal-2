import type { ProcessCompletionListener } from '../crm/process-service.ts';
import type { AppointmentChangeListener } from '../scheduling/hooks.ts';
import type { TourService } from './tour-service.ts';

/**
 * Phase 13 (Order §36/§37): Verdrahtung über die BESTEHENDEN Ereignis-
 * Schnittstellen – keine direkte Abhängigkeit der Terminplanung oder des
 * Stornos auf die Touren. Beide Listener laufen nach dem Commit; Fehler
 * werden vom Aufrufer protokolliert, die Lazy-Heilung beim Lesen der Tour
 * holt die Arbeit nach.
 */

/** Terminzeit geändert ⇒ offene Touren mit diesem Stopp: Version +1, Plan stale. */
export function createTourStaleListener(tours: TourService): AppointmentChangeListener {
  return {
    async appointmentTimesChanged(event) {
      await tours.markStaleForAppointment(event.appointmentId);
    },
  };
}

/** Vorgang storniert ⇒ Stopps der stornierten Termine operativ übersprungen. */
export function createTourCancellationListener(tours: TourService): ProcessCompletionListener {
  return {
    async processCompleted() {
      // Abschluss eines Vorgangs ändert keine Tour (erledigte Stopps leiten sich aus Terminen ab).
    },
    async processCancelled(event) {
      await tours.markCancelledStops(event.processId, event.cancelledAt);
    },
  };
}
