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
