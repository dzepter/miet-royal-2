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
    }
  // Phase 13 (tours-live): Fahrer ⇒ Aktive-Tour-Seite, Planung ⇒ Tourseite; nie Adresse/Name/Koordinaten.
  | {
      kind: 'tour_delay_risk';
      processId: string;
      processNumber: string;
      appointmentKind: PushAppointmentKind;
      tourId: string;
      incidentId: string;
      audience: 'driver' | 'planning';
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
    case 'tour_delay_risk': {
      // Phase 13 (Order §53): datenminimiert – Terminart + Vorgangsnummer, sonst nichts.
      const label = appointmentKindLabel(input.appointmentKind);
      const number = assertProcessNumber(input.processNumber);
      const tourId = assertUuid(input.tourId, 'Tour-ID');
      const incidentId = assertUuid(input.incidentId, 'Incident-ID');
      // Phase 13 Final (Review F3): die Fahrer-Variante nennt die Tour-ID
      // (`/touren/aktiv?id=…`), damit der Push bei mehreren aktiven Touren
      // derselben effektiven Person (§7) nicht auf der falschen Tour landet.
      return {
        kind: input.kind,
        title: 'Tour droht Termin zu verpassen',
        body: `${label} ${number}`,
        url: input.audience === 'driver' ? tourActivePath(tourId) : `/touren/${tourId}`,
        tag: `tour-delay:${incidentId}`,
      };
    }
  }
}

/** Staff-Pfad der Seite „Aktive Tour“ (Phase 13, Design §13). */
export const TOUR_ACTIVE_PATH = '/touren/aktiv';

/** Seite „Aktive Tour“ für eine konkrete Tour (Review F3; die UI wertet `?id=` aus). */
export function tourActivePath(tourId: string): string {
  return `${TOUR_ACTIVE_PATH}?id=${tourId}`;
}

function assertUuid(value: string, what: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error(`Ungültige ${what} für Push-Nutzlast`);
  return value;
}

/**
 * Alle Push-Arten, die es fachlich gibt. Phase 13 ergänzt `tour_delay_risk`
 * (Order §53: drohende Verspätung – genau ein Push je Incident); die Phase-12-
 * Grenzkonstante `tour.delay_risk` bleibt kein PushKind.
 */
export const PUSH_KINDS: readonly PushKind[] = [
  'appointment_1h',
  'return_overdue',
  'machine_risk',
  'machine_risk_6h',
  'session_new_device_login',
  'substitution_started',
  'assignment_reassigned',
  'tour_delay_risk',
];
