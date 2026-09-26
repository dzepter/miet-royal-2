import type { Appointment } from '@mietroyal/database';

/**
 * Ereignis-Schnittstelle der Terminplanung (Phase-6-Finalisierung A2):
 * Nach einer COMMITTETEN Zeitänderung eines Termins werden registrierte
 * Listener benachrichtigt. Die Terminplanung kennt nur diese Schnittstelle
 * – keine Abhängigkeit auf Handover/Zuordnung (keine zyklische Kopplung);
 * die Verdrahtung erfolgt in der App-Komposition.
 */
export interface AppointmentTimesChangedEvent {
  appointmentId: string;
  processId: string;
  bookingId: string | null;
  kind: Appointment['kind'];
}

export interface AppointmentChangeListener {
  appointmentTimesChanged(event: AppointmentTimesChangedEvent): Promise<void>;
}
