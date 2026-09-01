import { processes } from '@mietroyal/database';
import type { PermissionKey } from '@mietroyal/permissions';
import { and, eq, gte, inArray, or, type SQL } from 'drizzle-orm';

/**
 * Zentrale Sichtbarkeitsregel für Vorgänge (Phase-2-Vorgaben Nr. 9/10/15).
 * Eine Implementierung für Liste, Detail, Kundenakte, Suche und Dashboard –
 * niemals nur in der UI.
 *
 * - open: für alle mit process.view_all sichtbar.
 * - completed/cancelled: für normale Mitarbeitende nur innerhalb von
 *   completed_process_staff_visibility_days nach Abschluss; mit
 *   process.view_completed unbegrenzt.
 * - reopened: standardmäßig nur mit process.view_completed sichtbar.
 */
export interface ProcessVisibilityContext {
  canViewCompleted: boolean;
  visibilityDays: number;
  now: Date;
}

export function buildVisibilityContext(
  effective: ReadonlySet<PermissionKey>,
  visibilityDays: number,
  now = new Date(),
): ProcessVisibilityContext {
  return {
    canViewCompleted: effective.has('process.view_completed'),
    visibilityDays,
    now,
  };
}

function cutoff(ctx: ProcessVisibilityContext): Date {
  return new Date(ctx.now.getTime() - ctx.visibilityDays * 24 * 60 * 60 * 1000);
}

/** SQL-Filter für Listen/Suche/Dashboard. */
export function visibleProcessesWhere(ctx: ProcessVisibilityContext): SQL {
  if (ctx.canViewCompleted) {
    return inArray(processes.mainStatus, ['open', 'completed', 'reopened', 'cancelled']);
  }
  const limit = cutoff(ctx);
  const openOnly = eq(processes.mainStatus, 'open');
  const recentCompleted = and(
    eq(processes.mainStatus, 'completed'),
    gte(processes.completedAt, limit),
  );
  const recentCancelled = and(
    eq(processes.mainStatus, 'cancelled'),
    gte(processes.cancelledAt, limit),
  );
  return or(openOnly, recentCompleted, recentCancelled) as SQL;
}

/** Objekt-Variante für Einzelprüfungen (Detailzugriff). */
export function isProcessVisible(
  process: {
    mainStatus: 'open' | 'completed' | 'reopened' | 'cancelled';
    completedAt: Date | null;
    cancelledAt: Date | null;
  },
  ctx: ProcessVisibilityContext,
): boolean {
  if (process.mainStatus === 'open') return true;
  if (ctx.canViewCompleted) return true;
  if (process.mainStatus === 'reopened') return false;
  const endedAt = process.mainStatus === 'completed' ? process.completedAt : process.cancelledAt;
  if (endedAt === null) return false;
  return endedAt.getTime() >= cutoff(ctx).getTime();
}
