import { staffUsers, type Database } from '@mietroyal/database';
import type { PermissionKey } from '@mietroyal/permissions';
import { eq } from 'drizzle-orm';

/** Minimale Rechte-Schnittstelle (StaffAuthService.effectivePermissions). */
export interface PermissionResolver {
  effectivePermissions(userId: string): Promise<ReadonlySet<PermissionKey>>;
}

/**
 * Empfänger administrativer Pushes (Order §31/§36): alle AKTIVEN Nutzer,
 * die mindestens eines der genannten Rechte effektiv besitzen – frisch
 * berechnet (Rechteänderungen gelten sofort, Systemadmins immer dabei).
 * Overdue/Risiko ⇒ `calendar.view_all` (Planung) oder `employee.manage`
 * (Admin); neues Gerät ⇒ nur `employee.manage` (Security-Verwaltung).
 */
export async function listActiveUsersWithAnyPermission(
  db: Database,
  auth: PermissionResolver,
  keys: readonly PermissionKey[],
): Promise<string[]> {
  const users = await db
    .select({ id: staffUsers.id })
    .from(staffUsers)
    .where(eq(staffUsers.status, 'active'));
  const result: string[] = [];
  for (const user of users) {
    const effective = await auth.effectivePermissions(user.id);
    if (keys.some((key) => effective.has(key))) result.push(user.id);
  }
  return result;
}

export const PLANNING_PUSH_PERMISSIONS: readonly PermissionKey[] = [
  'calendar.view_all',
  'employee.manage',
];
export const SECURITY_PUSH_PERMISSIONS: readonly PermissionKey[] = ['employee.manage'];
