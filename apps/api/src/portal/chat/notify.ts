import {
  processes,
  staffRoles,
  staffUserRoles,
  staffUsers,
  type Database,
} from '@mietroyal/database';
import { resolveEffectiveAssigneeId } from '@mietroyal/domain';
import { and, eq } from 'drizzle-orm';
import { buildPushPayload } from '../../communication/push/payload.ts';
import type { PushService } from '../../communication/push/push-service.ts';
import { loadSubstitutions } from '../../scheduling/assignee.ts';

/**
 * Phase 15 (CHAT, Order §28): interne Benachrichtigung über eine neue
 * Portal-Kundennachricht – Phase-12-Regel „Admin + effektiv zuständige Person“.
 * Push NUR mit Vorgangsnummer (fester Text, nie Nachrichtentext/Foto);
 * Idempotenzschlüssel `portal_message:<messageId>:<userId>` (ein Push je
 * Nachricht und Empfänger, auch bei Job-Wiederholung).
 */

export interface PortalMessageNotifyDeps {
  db: Database;
  push: PushService;
  logger?: { warn(obj: Record<string, unknown>, msg?: string): void };
}

export function portalMessagePushKey(messageId: string, userId: string): string {
  return `portal_message:${messageId}:${userId}`;
}

/**
 * Empfänger: alle AKTIVEN Mitglieder einer Systemrolle (`staff_roles.is_system_admin`)
 * ∪ die effektiv zuständige Person des Vorgangs (`processes.assigned_user_id`
 * unter Berücksichtigung aktiver Vertretungen zum Zeitpunkt `now`), sofern aktiv.
 * Dedupliziert; ohne Zuständigkeit nur die Admins.
 */
export async function portalMessageRecipients(
  db: Database,
  processId: string,
  now: Date,
): Promise<string[]> {
  const admins = await db
    .select({ id: staffUsers.id })
    .from(staffUsers)
    .innerJoin(staffUserRoles, eq(staffUserRoles.userId, staffUsers.id))
    .innerJoin(staffRoles, eq(staffRoles.id, staffUserRoles.roleId))
    .where(and(eq(staffUsers.status, 'active'), eq(staffRoles.isSystemAdmin, true)));
  const recipients = new Set<string>(admins.map((row) => row.id));

  const processRows = await db
    .select({ assignedUserId: processes.assignedUserId })
    .from(processes)
    .where(eq(processes.id, processId));
  const assigned = processRows[0]?.assignedUserId ?? null;
  if (assigned !== null) {
    const effective = resolveEffectiveAssigneeId(assigned, now, await loadSubstitutions(db));
    if (effective !== null) {
      const status = await db
        .select({ status: staffUsers.status })
        .from(staffUsers)
        .where(eq(staffUsers.id, effective));
      if (status[0]?.status === 'active') recipients.add(effective);
    }
  }
  return [...recipients];
}

/**
 * Nach dem Commit der Kundennachricht aufrufen (Push-Outbox + Job – nie unter
 * offener Fachtransaktion). Fehler werden nur geloggt: die Nachricht ist bereits
 * gespeichert und im Staff-Vorgang sichtbar; der Push ist ein Hinweis.
 */
export async function notifyStaffOfPortalMessage(
  deps: PortalMessageNotifyDeps,
  input: { messageId: string; processId: string; processNumber: string; now: Date },
): Promise<{ recipients: number }> {
  try {
    const recipients = await portalMessageRecipients(deps.db, input.processId, input.now);
    if (recipients.length === 0) return { recipients: 0 };
    const payload = buildPushPayload({
      kind: 'portal_message',
      processId: input.processId,
      processNumber: input.processNumber,
    });
    await deps.push.enqueueForUsers(recipients, 'portal_message', payload, (userId) =>
      portalMessagePushKey(input.messageId, userId),
    );
    return { recipients: recipients.length };
  } catch (error) {
    deps.logger?.warn(
      {
        messageId: input.messageId,
        processId: input.processId,
        errorCode: error instanceof Error ? error.name || 'Error' : 'Error',
      },
      'portal.message.notify_failed',
    );
    return { recipients: 0 };
  }
}
