import { createHash } from 'node:crypto';

/**
 * Idempotenzschlüssel der Push-Regeln (Order §31/§32). Eigenes Modul (Phase 12
 * Finalisierung 2, Kurzfrist-Push effektiv/same-day): Regeln (rules.ts) und
 * Versandzeit-Prüfung (supersede.ts) bauen Schlüssel aus denselben Bausteinen,
 * ohne sich gegenseitig zu importieren. rules.ts exportiert beide weiter.
 * Schlüssel enthalten nur IDs und Zeitpunkte (Datenminimierung).
 */

export function appointmentPushFingerprint(
  appointmentId: string,
  startAt: Date,
  assigneeUserId: string,
): string {
  return createHash('sha256')
    .update(`${appointmentId}|${startAt.toISOString()}|${assigneeUserId}`)
    .digest('hex');
}

/**
 * Präfix aller Kurzfrist-Zustellungen EINER Zuweisungs-Version
 * (Termin + `acknowledgement_requested_at`, ms-genau). Der Empfänger folgt als
 * letztes Segment; freigegebene (überholte) Schlüssel tragen zusätzlich nur ein
 * Suffix `:superseded:<id>` – sie beginnen weiterhin mit diesem Präfix.
 */
export function reassignmentKeyPrefix(appointmentId: string, requestedAt: Date): string {
  return `push:assignment_reassigned:${appointmentId}:${requestedAt.toISOString()}:`;
}

export const pushKeys = {
  appointment1h: (appointmentId: string, fingerprint: string) =>
    `push:appointment_1h:${appointmentId}:${fingerprint}`,
  substitution: (substitutionId: string) => `push:substitution:${substitutionId}`,
  returnOverdue: (incidentId: string, userId: string) =>
    `push:return_overdue:${incidentId}:${userId}`,
  machineRisk: (riskId: string, userId: string) => `push:machine_risk:${riskId}:${userId}`,
  machineRisk6h: (riskId: string, userId: string) => `push:machine_risk_6h:${riskId}:${userId}`,
  newDevice: (sessionId: string, userId: string) => `push:new_device:${sessionId}:${userId}`,
  /** Stabiler Recipient-Fingerprint: K(R) je Zuweisungs-Version und EFFEKTIVEM Empfänger. */
  reassignment: (appointmentId: string, requestedAt: Date, userId: string) =>
    `${reassignmentKeyPrefix(appointmentId, requestedAt)}${userId}`,
};
