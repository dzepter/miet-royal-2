import { staffSecurityEvents, type DatabaseExecutor } from '@mietroyal/database';

/**
 * Bewusst kleines Security-Audit (Phase-1-Vorgabe Nr. 14): nur
 * sicherheitsrelevante Ereignisse, kein Klick-Tracking. `details` darf
 * niemals Passwörter, Tokens oder Secrets enthalten.
 */
export const SECURITY_EVENT_TYPES = [
  'employee.created',
  'employee.locked',
  'employee.disabled',
  'employee.reactivated',
  'permission.roles_changed',
  'permission.system_admin_granted',
  'permission.system_admin_revoked',
  'permission.role_created',
  'permission.role_updated',
  'permission.role_deleted',
  'permission.override_added',
  'permission.override_removed',
  'permission.explanation_updated',
  'password.changed',
  'password.reset_completed',
  'password.reset_link_issued',
  'twofa.requirement_changed',
  'twofa.enabled',
  'twofa.reset',
  'twofa.recovery_code_used',
  'session.created',
  'session.new_device_login',
  'session.revoked',
  'session.revoked_all',
  // Phase 8: Offline-Lease (Order §8) und Umgebungs-Hard-Reject (§76).
  'offline.lease_issued',
  'offline.lease_renewed',
  'offline.lease_revoked',
  'offline.environment_mismatch',
  // Phase 14 (reset, Order §31): Demo-Reset – Start nach Phase A, Abschluss nach Phase D,
  // Abbruch mit technischer Fehlerklasse. Details ausschließlich
  // { resetRunId, datasetVersion, status, errorClass? } – nie Seed-Inhalte, nie Meldungen.
  'demo.reset_started',
  'demo.reset_completed',
  'demo.reset_failed',
  // Phase 14 (training gate): Live-Sperren und Freigaben (Order §84) – Details nur
  // Feature-/Übungs-Keys, Freigabe-IDs und Zeitstempel, nie Begründungstexte.
  'training.gate_enabled',
  'training.gate_disabled',
  'training.demo_verified',
  'training.override_granted',
  'training.override_revoked',
  'training.demo_verification_revoked',
  // Phase 14 (training): Zuweisung und bewusster Training-Reset (Order §84) – Details nur
  // IDs, Pfad-/Übungs-Keys und Zähler; nie Businessdaten.
  'training.assignment_created',
  'training.assignment_reset',
  // Phase 15 (portal): Kundenportal-Auth (Order §6/§35) – Details ausschließlich
  // { customerId, sessionId?, count?, reason? }; nie Tokens, nie E-Mail-Adressen. actorUserId bleibt null.
  'portal.login',
  'portal.logout',
  'portal.email_changed',
  'portal.sessions_revoked',
] as const;

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

export interface SecurityEventInput {
  type: SecurityEventType;
  actorUserId?: string | null;
  targetUserId?: string | null;
  sessionId?: string | null;
  details?: Record<string, string | number | boolean | null>;
}

export async function recordSecurityEvent(
  db: DatabaseExecutor,
  event: SecurityEventInput,
): Promise<void> {
  await db.insert(staffSecurityEvents).values({
    type: event.type,
    actorUserId: event.actorUserId ?? null,
    targetUserId: event.targetUserId ?? null,
    sessionId: event.sessionId ?? null,
    details: event.details ?? {},
  });
}
