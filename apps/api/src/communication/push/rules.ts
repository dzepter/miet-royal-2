import { createHash } from 'node:crypto';
import {
  appointmentOverdueIncidents,
  appointmentReminders,
  appointments,
  machineRiskIncidents,
  processes,
  staffSecurityEvents,
  staffSubstitutions,
  staffUsers,
  type Database,
} from '@mietroyal/database';
import type { JobRunnerLogger } from '@mietroyal/integrations';
import { substitutionEffectiveEnd } from '@mietroyal/domain';
import { and, eq, gt, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import { getAppointmentReminderMinutes } from '../../crm/settings-service.ts';
import { effectiveAssigneeForAppointment, loadSubstitutions } from '../../scheduling/assignee.ts';
import { SchedulingService } from '../../scheduling/scheduling-service.ts';
import { buildPushPayload, type PushAppointmentKind } from './payload.ts';
import type { PushService } from './push-service.ts';
import { PushSubscriptionService } from './subscription-service.ts';
import {
  listActiveUsersWithAnyPermission,
  PLANNING_PUSH_PERMISSIONS,
  SECURITY_PUSH_PERMISSIONS,
  type PermissionResolver,
} from './recipients.ts';

/**
 * Operative Push-Regeln (Order §31/§32). Der zentrale Job
 * `communication.scan_due` ruft `scanDue(now)` auf; jede Regel ist für
 * sich idempotent (Fingerprints/Idempotenzschlüssel), ein Scan darf
 * beliebig oft laufen. Kein zweites Scheduler-System.
 *
 * (a) 1 h vor Pickup/Delivery/Return an die EFFEKTIVE Zuständigkeit inkl.
 *     Vertretung; Fingerprint = sha256(appointmentId|startAt|assignee):
 *     Reschedule/Neuzuweisung ⇒ neuer Fingerprint ⇒ neuer Empfänger bekommt
 *     den Hinweis, alte Zeile bleibt (no-op). Ungeplante Termine nie.
 *     Härtung B14: erst Push-Zustellung, dann Reminder-Marke (absturzsicher).
 * (b) Vertretungsbeginn: kleiner Hinweis an die Vertretung (Key je Vertretung).
 * (c) Überfällige Rückgabe: genau EIN Push je Incident an Planung/Admin.
 * (d) Maschinenrisiko: ein Push bei Entstehung, genau EINE Erinnerung ≥ 6 h
 *     danach, solange offen; nie mehr.
 * (e) Neues Gerät: Backstop zum Sofort-Hook der Anmeldung (gleicher Schlüssel).
 * (f) Reinigung > 24 h: bewusst KEIN Push. Touren existieren nicht
 *     (tour.delay_risk bleibt Grenze, kein PushKind).
 */

export const RISK_FOLLOW_UP_DELAY_MS = 6 * 3_600_000;
/** Rückschau für Vertretungsbeginn/neues Gerät – Dedupe über Schlüssel, daher großzügig. */
const LOOKBACK_MS = 24 * 3_600_000;

export interface PushRuleScannerDeps {
  db: Database;
  push: PushService;
  auth: PermissionResolver;
  logger?: JobRunnerLogger;
}

export interface PushScanSummary {
  appointment1h: number;
  substitutionStarted: number;
  returnOverdue: number;
  machineRisk: number;
  machineRisk6h: number;
  newDevice: number;
}

export function appointmentPushFingerprint(
  appointmentId: string,
  startAt: Date,
  assigneeUserId: string,
): string {
  return createHash('sha256')
    .update(`${appointmentId}|${startAt.toISOString()}|${assigneeUserId}`)
    .digest('hex');
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
};

export class PushRuleScanner {
  private readonly scheduling: SchedulingService;
  private readonly subscriptions: PushSubscriptionService;

  constructor(private readonly deps: PushRuleScannerDeps) {
    this.scheduling = new SchedulingService(deps.db);
    this.subscriptions = new PushSubscriptionService(deps.db);
  }

  async scanDue(now = new Date()): Promise<PushScanSummary> {
    const summary: PushScanSummary = {
      appointment1h: await this.scanAppointmentReminders(now),
      substitutionStarted: await this.scanSubstitutionStarts(now),
      returnOverdue: await this.scanOverdueReturns(now),
      machineRisk: 0,
      machineRisk6h: 0,
      newDevice: 0,
    };
    const risk = await this.scanMachineRisks(now);
    summary.machineRisk = risk.initial;
    summary.machineRisk6h = risk.followUp;
    summary.newDevice = await this.scanNewDeviceLogins(now);
    this.deps.logger?.info({ ...summary }, 'Push-Regeln geprüft');
    return summary;
  }

  // (a) ─────────────────────────────────────────────────────────────────────
  async scanAppointmentReminders(now: Date): Promise<number> {
    const minutes = await getAppointmentReminderMinutes(this.deps.db);
    const windowEnd = new Date(now.getTime() + minutes * 60_000);
    const rows = await this.deps.db
      .select({ appointment: appointments, processNumber: processes.processNumber })
      .from(appointments)
      .innerJoin(processes, eq(processes.id, appointments.processId))
      .where(
        and(
          eq(appointments.status, 'scheduled'),
          isNotNull(appointments.startAt),
          gt(appointments.startAt, now),
          lte(appointments.startAt, windowEnd),
          ne(processes.mainStatus, 'cancelled'),
        ),
      );
    if (rows.length === 0) return 0;
    const substitutions = await loadSubstitutions(this.deps.db);
    let enqueued = 0;
    for (const { appointment, processNumber } of rows) {
      const startAt = appointment.startAt;
      if (startAt === null) continue;
      const assignee = effectiveAssigneeForAppointment(appointment, substitutions, now);
      if (assignee === null) continue; // ohne Zuständigkeit kein Empfänger
      const fingerprint = appointmentPushFingerprint(appointment.id, startAt, assignee);
      // Härtung B14: Reihenfolge wie bei Overdue/Risiko – ZUERST die Push-
      // Zustellung (+ Job; Schlüssel je Fingerprint ⇒ dedupliziert), DANACH die
      // Reminder-Zeile als „erledigt“-Marke. Ein Absturz dazwischen lässt die
      // Marke fehlen ⇒ der nächste Scan holt nach (gleicher Schlüssel ⇒ kein
      // zweiter Push). Eine Marke ohne Zustellung (Altbestand) wird ergänzt.
      const existing = await this.deps.db
        .select({
          id: appointmentReminders.id,
          pushDeliveryId: appointmentReminders.pushDeliveryId,
        })
        .from(appointmentReminders)
        .where(
          and(
            eq(appointmentReminders.appointmentId, appointment.id),
            eq(appointmentReminders.kind, 'push_1_hour'),
            eq(appointmentReminders.fingerprint, fingerprint),
          ),
        );
      const marker = existing[0];
      if (marker !== undefined && marker.pushDeliveryId !== null) continue; // bereits behandelt
      const payload = buildPushPayload({
        kind: 'appointment_1h',
        processId: appointment.processId,
        processNumber,
        appointmentKind: appointment.kind as PushAppointmentKind,
      });
      const result = await this.deps.push.enqueue({
        kind: 'appointment_1h',
        userId: assignee,
        idempotencyKey: pushKeys.appointment1h(appointment.id, fingerprint),
        payload,
      });
      const marked = await this.deps.db.transaction(async (tx) => {
        const rows =
          marker === undefined
            ? await tx
                .insert(appointmentReminders)
                .values({
                  appointmentId: appointment.id,
                  kind: 'push_1_hour',
                  fingerprint,
                  dueAt: new Date(startAt.getTime() - minutes * 60_000),
                  pushDeliveryId: result.deliveryId,
                  sentAt: now,
                })
                .onConflictDoNothing()
                .returning({ id: appointmentReminders.id })
            : await tx
                .update(appointmentReminders)
                .set({ pushDeliveryId: result.deliveryId, sentAt: now })
                .where(
                  and(
                    eq(appointmentReminders.id, marker.id),
                    isNull(appointmentReminders.pushDeliveryId),
                  ),
                )
                .returning({ id: appointmentReminders.id });
        if (rows.length === 0) return false; // paralleler Scan war schneller
        await tx
          .update(appointments)
          .set({ reminderSentAt: now })
          .where(eq(appointments.id, appointment.id));
        return true;
      });
      if (marked) enqueued += 1;
    }
    return enqueued;
  }

  // (b) ─────────────────────────────────────────────────────────────────────
  async scanSubstitutionStarts(now: Date): Promise<number> {
    const rows = await this.deps.db
      .select({ substitution: staffSubstitutions, substituteStatus: staffUsers.status })
      .from(staffSubstitutions)
      .innerJoin(staffUsers, eq(staffUsers.id, staffSubstitutions.substituteUserId))
      .where(
        and(
          lte(staffSubstitutions.startsAt, now),
          gt(staffSubstitutions.startsAt, new Date(now.getTime() - LOOKBACK_MS)),
        ),
      );
    let enqueued = 0;
    for (const { substitution, substituteStatus } of rows) {
      if (substituteStatus !== 'active') continue;
      if (substitutionEffectiveEnd(substitution).getTime() <= now.getTime()) continue;
      const result = await this.deps.push.enqueue({
        kind: 'substitution_started',
        userId: substitution.substituteUserId,
        idempotencyKey: pushKeys.substitution(substitution.id),
        payload: buildPushPayload({ kind: 'substitution_started' }),
      });
      if (!result.deduplicated) enqueued += 1;
    }
    return enqueued;
  }

  // (c) ─────────────────────────────────────────────────────────────────────
  async scanOverdueReturns(now: Date): Promise<number> {
    const due = await this.scheduling.listDueOverdueAdminNotifications(now);
    if (due.length === 0) return 0;
    const recipients = await listActiveUsersWithAnyPermission(
      this.deps.db,
      this.deps.auth,
      PLANNING_PUSH_PERMISSIONS,
    );
    let enqueued = 0;
    for (const incident of due) {
      const rows = await this.deps.db
        .select({ processId: appointments.processId, processNumber: processes.processNumber })
        .from(appointments)
        .innerJoin(processes, eq(processes.id, appointments.processId))
        .where(eq(appointments.id, incident.appointmentId));
      const row = rows[0];
      if (row === undefined) continue;
      const payload = buildPushPayload({
        kind: 'return_overdue',
        processId: row.processId,
        processNumber: row.processNumber,
      });
      await this.deps.push.enqueueForUsers(recipients, 'return_overdue', payload, (userId) =>
        pushKeys.returnOverdue(incident.incidentId, userId),
      );
      // Genau EIN Push je Incident – auch bei 0 Empfängern gilt er als behandelt.
      await this.deps.db
        .update(appointmentOverdueIncidents)
        .set({ adminNotifiedAt: now })
        .where(
          and(
            eq(appointmentOverdueIncidents.id, incident.incidentId),
            isNull(appointmentOverdueIncidents.adminNotifiedAt),
          ),
        );
      enqueued += 1;
    }
    return enqueued;
  }

  // (d) ─────────────────────────────────────────────────────────────────────
  async scanMachineRisks(now: Date): Promise<{ initial: number; followUp: number }> {
    const initialRows = await this.deps.db
      .select({ incident: machineRiskIncidents, processNumber: processes.processNumber })
      .from(machineRiskIncidents)
      .innerJoin(processes, eq(processes.id, machineRiskIncidents.processId))
      .where(
        and(
          isNull(machineRiskIncidents.resolvedAt),
          isNull(machineRiskIncidents.adminNotifiedAt),
          lte(machineRiskIncidents.adminNotificationDueAt, now),
        ),
      );
    const followUpRows = await this.deps.db
      .select({ incident: machineRiskIncidents, processNumber: processes.processNumber })
      .from(machineRiskIncidents)
      .innerJoin(processes, eq(processes.id, machineRiskIncidents.processId))
      .where(
        and(
          isNull(machineRiskIncidents.resolvedAt),
          isNull(machineRiskIncidents.followUpSentAt),
          sql`${machineRiskIncidents.followUpDueAt} IS NOT NULL AND ${machineRiskIncidents.followUpDueAt} <= ${now}`,
        ),
      );
    if (initialRows.length === 0 && followUpRows.length === 0) return { initial: 0, followUp: 0 };
    const recipients = await listActiveUsersWithAnyPermission(
      this.deps.db,
      this.deps.auth,
      PLANNING_PUSH_PERMISSIONS,
    );
    let initial = 0;
    for (const { incident, processNumber } of initialRows) {
      const payload = buildPushPayload({
        kind: 'machine_risk',
        processId: incident.processId,
        processNumber,
      });
      await this.deps.push.enqueueForUsers(recipients, 'machine_risk', payload, (userId) =>
        pushKeys.machineRisk(incident.id, userId),
      );
      await this.deps.db
        .update(machineRiskIncidents)
        .set({
          adminNotifiedAt: now,
          followUpDueAt: new Date(now.getTime() + RISK_FOLLOW_UP_DELAY_MS),
        })
        .where(
          and(
            eq(machineRiskIncidents.id, incident.id),
            isNull(machineRiskIncidents.adminNotifiedAt),
          ),
        );
      initial += 1;
    }
    let followUp = 0;
    for (const { incident, processNumber } of followUpRows) {
      const payload = buildPushPayload({
        kind: 'machine_risk_6h',
        processId: incident.processId,
        processNumber,
      });
      await this.deps.push.enqueueForUsers(recipients, 'machine_risk_6h', payload, (userId) =>
        pushKeys.machineRisk6h(incident.id, userId),
      );
      await this.deps.db
        .update(machineRiskIncidents)
        .set({ followUpSentAt: now })
        .where(
          and(
            eq(machineRiskIncidents.id, incident.id),
            isNull(machineRiskIncidents.followUpSentAt),
          ),
        );
      followUp += 1;
    }
    return { initial, followUp };
  }

  // (e) ─────────────────────────────────────────────────────────────────────
  /**
   * Sofortpfad ist der Auth-Hook (`notifyNewDeviceLogin`); der Scan holt
   * verpasste Ereignisse der letzten 24 h nach – gleicher Schlüssel, daher
   * nie doppelt.
   */
  async scanNewDeviceLogins(now: Date): Promise<number> {
    const events = await this.deps.db
      .select({ sessionId: staffSecurityEvents.sessionId })
      .from(staffSecurityEvents)
      .where(
        and(
          eq(staffSecurityEvents.type, 'session.new_device_login'),
          gt(staffSecurityEvents.createdAt, new Date(now.getTime() - LOOKBACK_MS)),
          isNotNull(staffSecurityEvents.sessionId),
        ),
      );
    let enqueued = 0;
    for (const event of events) {
      if (event.sessionId === null) continue;
      enqueued += await this.notifyNewDeviceLogin(event.sessionId);
    }
    return enqueued;
  }

  /**
   * Ein Admin-Security-Push je neuer Gerätesession (Order §31). Der Hook
   * feuert bei JEDEM Login; damit ohne registrierte Admin-Geräte keine
   * Zustellungen/Jobs entstehen (Queue bleibt für Fachjobs frei), werden nur
   * Empfänger mit mindestens einem aktiven Gerät berücksichtigt.
   */
  async notifyNewDeviceLogin(sessionId: string): Promise<number> {
    const candidates = await listActiveUsersWithAnyPermission(
      this.deps.db,
      this.deps.auth,
      SECURITY_PUSH_PERMISSIONS,
    );
    const recipients: string[] = [];
    for (const userId of candidates) {
      if (await this.subscriptions.hasActiveSubscription(userId)) recipients.push(userId);
    }
    if (recipients.length === 0) return 0;
    const results = await this.deps.push.enqueueForUsers(
      recipients,
      'session_new_device_login',
      buildPushPayload({ kind: 'session_new_device_login' }),
      (userId) => pushKeys.newDevice(sessionId, userId),
    );
    return results.some((result) => !result.deduplicated) ? 1 : 0;
  }
}
