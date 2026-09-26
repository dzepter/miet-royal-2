import type { AppointmentChangeListener } from '../scheduling/hooks.ts';
import type { AssignmentService } from './assignment-service.ts';

/**
 * Phase-6-Finalisierung A2: Terminänderungen (Abholung/Lieferung/Rückgabe)
 * verschieben den Live-Mietzeitraum – Risikohinweise (Sperre/Status/
 * Kollision) werden deshalb unmittelbar nach dem Commit neu bewertet:
 * veraltete Incidents werden gelöst, neue angelegt, Duplikate durch den
 * Fingerprint verhindert. Kein Push (Phase 12).
 */
export function createRiskRefreshListener(
  assignments: AssignmentService,
): AppointmentChangeListener {
  return {
    async appointmentTimesChanged(event) {
      if (event.bookingId === null) return;
      await assignments.refreshRiskIncidents();
    },
  };
}
