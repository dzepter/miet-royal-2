import type { PushKind, PushPayload } from '../types.ts';

/**
 * Datenminimierung für Web Push (Order §30): Die Nutzlast entsteht
 * AUSSCHLIESSLICH hier aus einer geschlossenen Menge erlaubter Felder –
 * Vorgangsnummer, Terminart und generische Texte. Es gibt keinen freien
 * Textparameter; Kundennamen, Telefonnummern, Adressen, Schäden oder
 * Beträge können technisch nicht in eine Push-Nachricht gelangen.
 * `url` ist immer ein relativer Staff-App-Pfad (notificationclick öffnet ihn).
 */

export type PushAppointmentKind = 'pickup' | 'delivery' | 'return';

const APPOINTMENT_KIND_LABELS: Record<PushAppointmentKind, string> = {
  pickup: 'Abholung',
  delivery: 'Lieferung',
  return: 'Rückgabe',
};

const PROCESS_NUMBER_PATTERN = /^MR-\d{4}-\d{4,}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PUSH_CHECK_HINT = 'in Miet-Royal prüfen';

export type PushPayloadInput =
  | {
      kind: 'appointment_1h';
      processId: string;
      processNumber: string;
      appointmentKind: PushAppointmentKind;
    }
  | { kind: 'return_overdue'; processId: string; processNumber: string }
  | { kind: 'machine_risk'; processId: string; processNumber: string }
  | { kind: 'machine_risk_6h'; processId: string; processNumber: string }
  | { kind: 'session_new_device_login' }
  | { kind: 'substitution_started' }
  | {
      kind: 'assignment_reassigned';
      processId: string;
      processNumber: string;
      appointmentKind: PushAppointmentKind;
    };

function assertProcessNumber(value: string): string {
  // Nur das kanonische Format MR-YYYY-NNNN – kein freier Text.
  if (!PROCESS_NUMBER_PATTERN.test(value)) {
    throw new Error('Ungültige Vorgangsnummer für Push-Nutzlast');
  }
  return value;
}

function assertProcessId(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error('Ungültige Vorgangs-ID für Push-Nutzlast');
  return value;
}

export function appointmentKindLabel(kind: PushAppointmentKind): string {
  return APPOINTMENT_KIND_LABELS[kind];
}

/** Staff-Pfad eines Vorgangs (Terminseite für Terminhinweise). */
export function processPath(processId: string, section?: 'termine'): string {
  const base = `/vorgaenge/${assertProcessId(processId)}`;
  return section === undefined ? base : `${base}/${section}`;
}

export function buildPushPayload(input: PushPayloadInput): PushPayload {
  switch (input.kind) {
    case 'appointment_1h': {
      const label = appointmentKindLabel(input.appointmentKind);
      const number = assertProcessNumber(input.processNumber);
      return {
        kind: input.kind,
        title: 'Termin in 1 Stunde',
        body: `${label} ${number}`,
        url: processPath(input.processId, 'termine'),
        tag: `appointment-1h:${input.processId}:${input.appointmentKind}`,
      };
    }
    case 'return_overdue': {
      const number = assertProcessNumber(input.processNumber);
      return {
        kind: input.kind,
        title: 'Rückgabe überfällig',
        body: `${number} – ${PUSH_CHECK_HINT}`,
        url: processPath(input.processId, 'termine'),
        tag: `return-overdue:${input.processId}`,
      };
    }
    case 'machine_risk': {
      const number = assertProcessNumber(input.processNumber);
      return {
        kind: input.kind,
        title: 'Maschinenkonflikt',
        body: `${number} – ${PUSH_CHECK_HINT}`,
        url: processPath(input.processId, 'termine'),
        tag: `machine-risk:${input.processId}`,
      };
    }
    case 'machine_risk_6h': {
      const number = assertProcessNumber(input.processNumber);
      return {
        kind: input.kind,
        title: 'Maschinenkonflikt weiterhin offen',
        body: `${number} – ${PUSH_CHECK_HINT}`,
        url: processPath(input.processId, 'termine'),
        tag: `machine-risk:${input.processId}`,
      };
    }
    case 'session_new_device_login':
      // Bewusst ohne Mitarbeitername (konservativ): Details stehen in der
      // Mitarbeiterverwaltung, der Push ist nur der Anstoß zur Prüfung.
      return {
        kind: input.kind,
        title: 'Neue Anmeldung',
        body: `Neue Anmeldung von einem neuen Gerät – ${PUSH_CHECK_HINT}`,
        url: '/mitarbeiter',
        tag: 'session-new-device',
      };
    case 'assignment_reassigned': {
      const label = appointmentKindLabel(input.appointmentKind);
      const number = assertProcessNumber(input.processNumber);
      return {
        kind: input.kind,
        title: 'Kurzfristig zugewiesen',
        body: `${label} ${number} – ${PUSH_CHECK_HINT}`,
        url: processPath(input.processId, 'termine'),
        tag: `assignment-reassigned:${input.processId}:${input.appointmentKind}`,
      };
    }
    case 'substitution_started':
      return {
        kind: input.kind,
        title: 'Vertretung aktiv',
        body: `Vertretung aktiv – ${PUSH_CHECK_HINT}`,
        url: '/',
        tag: 'substitution-started',
      };
  }
}

/** Alle Push-Arten, die es fachlich gibt – Touren (tour.delay_risk) sind bewusst KEINE (Order §31/§45). */
export const PUSH_KINDS: readonly PushKind[] = [
  'appointment_1h',
  'return_overdue',
  'machine_risk',
  'machine_risk_6h',
  'session_new_device_login',
  'substitution_started',
  'assignment_reassigned',
];
