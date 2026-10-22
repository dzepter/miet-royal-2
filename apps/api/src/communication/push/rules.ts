import {
  appointmentOverdueIncidents,
  appointmentReminders,
  appointments,
  integrationJobs,
  machineRiskIncidents,
  processes,
  pushDeliveries,
  staffSecurityEvents,
  staffSubstitutions,
  staffUsers,
  type Database,
} from '@mietroyal/database';
import type { JobRunnerLogger } from '@mietroyal/integrations';
import { substitutionEffectiveEnd } from '@mietroyal/domain';
import { and, eq, gt, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import { PUSH_SEND_JOB_TYPE } from '../types.ts';
import { getAppointmentReminderMinutes } from '../../crm/settings-service.ts';
import { effectiveAssigneeForAppointment, loadSubstitutions } from '../../scheduling/assignee.ts';
import { SchedulingService } from '../../scheduling/scheduling-service.ts';
import { appointmentPushFingerprint, pushKeys } from './keys.ts';
import { buildPushPayload, type PushAppointmentKind } from './payload.ts';
import type { PushService } from './push-service.ts';
import { PushSubscriptionService } from './subscription-service.ts';
import {
  isReassignmentVersionClosed,
  isReassignmentClaimDay,
  loadReassignmentVersionDeliveries,
} from './supersede.ts';
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
 *     Härtung B14: Zustellung und Reminder-Marke entstehen gemeinsam.
 *     Phase 12 Finalisierung: unter Terminsperre wird die Zuständigkeit erneut
 *     geprüft (kein 1h-Push an eine Person, der der Termin zwischen Lesen und
 *     Markieren entzogen wurde); Zustellung + Marke in EINER Transaktion,
 *     Job erst nach dem Commit (fehlt er, holt ihn der Outbox-Backstop nach).
 * (b) Vertretungsbeginn: kleiner Hinweis an die Vertretung (Key je Vertretung).
 * (c) Überfällige Rückgabe: genau EIN Push je Incident an Planung/Admin.
 * (d) Maschinenrisiko: ein Push bei Entstehung, genau EINE Erinnerung ≥ 6 h
 *     danach, solange offen; nie mehr.
 * (e) Neues Gerät: Backstop zum Sofort-Hook der Anmeldung (gleicher Schlüssel).
 * (g) Kurzfristige Neuzuweisung am Durchführungstag (Phase-4-Kriterium
 *     „acknowledgementRequestedAt gesetzt UND assignmentNotifiedAt NULL“):
 *     genau ein Push an die neu zuständige Person je Neuzuweisung.
 *     Phase 12 Finalisierung (Punkt 5): je Kandidat EINE Transaktion –
 *     atomarer Claim (CAS auf Termin + requestedAt + requestedFor +
 *     notifiedAt IS NULL + status scheduled), nur bei Erfolg in derselben
 *     Transaktion die Zustellung; Job nach dem Commit. Eine zwischenzeitlich
 *     geänderte Zuweisung lässt den Claim scheitern ⇒ kein Push an die alte
 *     Person; ein Fehler vor dem Commit rollt den Claim zurück ⇒ der nächste
 *     Scan holt nach. B3: nur Neuzuweisungen der letzten 24 h (LOOKBACK_MS).
 *     Phase 12 Finalisierung 2 (Regeln A–G, TECH_DECISIONS „Phase 12
 *     Finalisierung: kein Push-Opt-out, Reassignment-Claim“): Zuweisungs-Version
 *     V = (Termin, requestedAt, requestedFor) – requestedFor bleibt NUR die
 *     Phase-4-Bestätigung; Push-Empfänger R = EFFEKTIVE Zuständigkeit
 *     (Vertretung, wie (a)), Schlüssel K(R) je Version und Empfänger; Push nur,
 *     wenn start_at am selben Berliner Kalendertag wie requestedAt liegt.
 *     Kandidaten auch mit gesetztem assignment_notified_at (Vertretungswechsel
 *     erreicht die nun zuständige Person), aber nie „geschlossene“ Versionen.
 * Versandzeit (B2, send-job.ts + supersede.ts): Zustellungen von (a) und (g)
 *     tragen `appointmentId`; `push.send` vergleicht vor jedem Gateway-Aufruf
 *     den gespeicherten Schlüssel mit dem, den der aktuelle Stand erzeugen
 *     würde – passt er nicht mehr ⇒ `skipped`/`SUPERSEDED`, kein Versand.
 * (f) Reinigung > 24 h: bewusst KEIN Push. Touren existieren nicht
 *     (tour.delay_risk bleibt Grenze, kein PushKind).
 * Outbox-Backstop: ausstehende Zustellungen ohne `push.send`-Job erhalten
 * ihren Job (stabiler Schlüssel ⇒ nie zwei Jobs je Zustellung).
 */

// Schlüssel leben seit Phase 12 Finalisierung 2 in keys.ts (auch von supersede.ts genutzt).
export { appointmentPushFingerprint, pushKeys } from './keys.ts';

export const RISK_FOLLOW_UP_DELAY_MS = 6 * 3_600_000;
/**
 * Rückschau für Vertretungsbeginn/neues Gerät/Outbox-Backstop – Dedupe über
 * Schlüssel, daher großzügig; Phase 12 Finalisierung (B3) auch Zeitgrenze der
 * Kurzfrist-Regel (g).
 */
const LOOKBACK_MS = 24 * 3_600_000;

/** Kandidat einer Regel mit Claim (Testhook `onCandidateRead`). */
export interface PushRuleCandidate {
  rule: 'appointment_1h' | 'assignment_reassigned';
  appointmentId: string;
}

export interface PushRuleScannerDeps {
  db: Database;
  push: PushService;
  auth: PermissionResolver;
  logger?: JobRunnerLogger;
  /**
   * NUR Tests (Phase 12 Finalisierung, RA3): wird je Kandidat NACH dem Lesen
   * und VOR Claim/Transaktion aufgerufen – macht „Zuweisung ändert sich
   * zwischen Lesen und Claim“ deterministisch prüfbar. Produktion setzt ihn nie.
   */
  onCandidateRead?: (candidate: PushRuleCandidate) => Promise<void>;
}

/** Kandidat der Kurzfrist-Regel (g): genau diese Zuweisungs-Version wird geclaimt. */
export interface ReassignmentCandidate {
  appointmentId: string;
  requestedAt: Date;
  requestedFor: string;
}

/**
 * Ergebnis des Claims (g): `null` ⇒ nichts zu tun (Zuweisung geändert, Termin
 * nicht mehr geplant, Version geschlossen oder Zustellung für den aktuellen
 * effektiven Empfänger existiert bereits); `deliveryId: null` ⇒ Version
 * bewusst ohne Push erledigt (Empfänger nicht aktiv / Vorgang storniert /
 * nicht am selben Berliner Tag – Phase 12 Finalisierung 2, Regel C).
 */
export type ReassignmentClaim =
  | { deliveryId: string; deduplicated: boolean }
  | {
      deliveryId: null;
      skipped: 'recipient_inactive' | 'process_cancelled' | 'not_same_day';
    };

export interface PushScanSummary {
  appointment1h: number;
  substitutionStarted: number;
  returnOverdue: number;
  machineRisk: number;
  machineRisk6h: number;
  newDevice: number;
  reassignment: number;
  /** Phase 12 Finalisierung: nachgeholte `push.send`-Jobs (Outbox-Backstop). */
  outboxBackstop: number;
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.name || 'Error' : 'Error';
}

export class PushRuleScanner {
  private readonly scheduling: SchedulingService;
  private readonly subscriptions: PushSubscriptionService;

  constructor(private readonly deps: PushRuleScannerDeps) {
    this.scheduling = new SchedulingService(deps.db);
    this.subscriptions = new PushSubscriptionService(deps.db);
  }

  async scanDue(now = new Date()): Promise<PushScanSummary> {
    const summary: PushScanSummary = {
      appointment1h: 0,
      substitutionStarted: 0,
      returnOverdue: 0,
      machineRisk: 0,
      machineRisk6h: 0,
      newDevice: 0,
      reassignment: 0,
      outboxBackstop: 0,
    };
    try {
      summary.appointment1h = await this.scanAppointmentReminders(now);
      summary.substitutionStarted = await this.scanSubstitutionStarts(now);
      summary.returnOverdue = await this.scanOverdueReturns(now);
      const risk = await this.scanMachineRisks(now);
      summary.machineRisk = risk.initial;
      summary.machineRisk6h = risk.followUp;
      summary.newDevice = await this.scanNewDeviceLogins(now);
      summary.reassignment = await this.scanSameDayReassignments(now);
    } finally {
      // Phase 12 Finalisierung: Outbox-Backstop IMMER zuletzt – auch wenn eine
      // Regel oben scheitert – und selbst fehlertolerant.
      try {
        summary.outboxBackstop = await this.scheduleOutboxBackstop(now);
      } catch (error) {
        this.deps.logger?.error(
          { rule: 'push_outbox_backstop', errorCode: errorCode(error) },
          'Push-Outbox-Backstop fehlgeschlagen',
        );
      }
    }
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
      // Härtung B14: eine Marke MIT Zustellung ⇒ erledigt; eine Marke ohne
      // Zustellung (Altbestand vor der Härtung) wird unten ergänzt.
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
      await this.deps.onCandidateRead?.({ rule: 'appointment_1h', appointmentId: appointment.id });
      try {
        const deliveryId = await this.claimAppointmentReminder(
          {
            appointmentId: appointment.id,
            processId: appointment.processId,
            processNumber,
            kind: appointment.kind as PushAppointmentKind,
            startAt,
            assignee,
            fingerprint,
            markerId: marker?.id ?? null,
            dueAt: new Date(startAt.getTime() - minutes * 60_000),
          },
          now,
        );
        if (deliveryId === null) continue;
        enqueued += 1;
        // Job erst NACH dem Commit (Gateway/Queue nie in offener Transaktion).
        await this.deps.push.enqueueSendJob(deliveryId);
      } catch (error) {
        this.logCandidateFailure('appointment_1h', appointment.id, error);
      }
    }
    return enqueued;
  }

  /**
   * (a) unter Terminsperre (`FOR NO KEY UPDATE` wie `SchedulingService.
   * lockAppointment` ⇒ serialisiert gegen assign/reschedule/Storno): Termin
   * noch geplant, gleiche Zeit, Vorgang nicht storniert und – mit frisch
   * geladenen Vertretungen – noch dieselbe effektive Zuständigkeit? Nur dann
   * Zustellung + Reminder-Marke in DIESER Transaktion. Sonst `null`: der
   * nächste Scan sieht den neuen Stand (neuer Fingerprint ⇒ neue Person).
   * Rückgabe: neu markierte Zustellung (Job reiht der Aufrufer nach dem Commit ein).
   */
  private async claimAppointmentReminder(
    candidate: {
      appointmentId: string;
      processId: string;
      processNumber: string;
      kind: PushAppointmentKind;
      startAt: Date;
      assignee: string;
      fingerprint: string;
      markerId: string | null;
      dueAt: Date;
    },
    now: Date,
  ): Promise<string | null> {
    return this.deps.db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(appointments)
        .where(eq(appointments.id, candidate.appointmentId))
        .for('no key update');
      const current = locked[0];
      if (
        current === undefined ||
        current.status !== 'scheduled' ||
        current.startAt?.getTime() !== candidate.startAt.getTime()
      ) {
        return null;
      }
      const processRows = await tx
        .select({ mainStatus: processes.mainStatus })
        .from(processes)
        .where(eq(processes.id, current.processId));
      if (processRows[0] === undefined || processRows[0].mainStatus === 'cancelled') return null;
      const substitutions = await loadSubstitutions(tx);
      if (effectiveAssigneeForAppointment(current, substitutions, now) !== candidate.assignee) {
        return null; // Zuständigkeit inzwischen anders ⇒ kein Push an die alte Person
      }
      const delivery = await this.deps.push.createDelivery(
        {
          kind: 'appointment_1h',
          userId: candidate.assignee,
          idempotencyKey: pushKeys.appointment1h(candidate.appointmentId, candidate.fingerprint),
          appointmentId: candidate.appointmentId, // B2: Versandzeit-Prüfung (SUPERSEDED)
          payload: buildPushPayload({
            kind: 'appointment_1h',
            processId: candidate.processId,
            processNumber: candidate.processNumber,
            appointmentKind: candidate.kind,
          }),
        },
        tx,
      );
      const marked =
        candidate.markerId === null
          ? await tx
              .insert(appointmentReminders)
              .values({
                appointmentId: candidate.appointmentId,
                kind: 'push_1_hour',
                fingerprint: candidate.fingerprint,
                dueAt: candidate.dueAt,
                pushDeliveryId: delivery.deliveryId,
                sentAt: now,
              })
              .onConflictDoNothing()
              .returning({ id: appointmentReminders.id })
          : await tx
              .update(appointmentReminders)
              .set({ pushDeliveryId: delivery.deliveryId, sentAt: now })
              .where(
                and(
                  eq(appointmentReminders.id, candidate.markerId),
                  isNull(appointmentReminders.pushDeliveryId),
                ),
              )
              .returning({ id: appointmentReminders.id });
      if (marked.length === 0) return null; // paralleler Scan war schneller (gleiche Zustellung)
      await tx
        .update(appointments)
        .set({ reminderSentAt: now })
        .where(eq(appointments.id, candidate.appointmentId));
      return delivery.deliveryId;
    });
  }

  /** Fehler eines Kandidaten: nur IDs + Code loggen, nächster Scan holt nach. */
  private logCandidateFailure(
    rule: PushRuleCandidate['rule'],
    appointmentId: string,
    error: unknown,
  ) {
    this.deps.logger?.warn(
      { rule, appointmentId, errorCode: errorCode(error) },
      'Push-Regel: Kandidat nicht verarbeitet – nächster Scan holt nach',
    );
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

  // (g) ─────────────────────────────────────────────────────────────────────
  /**
   * Kandidaten (Regel E): geplant, requestedAt/-for gesetzt, requestedAt
   * jünger als 24 h (B3), assigned = requested_for – AUCH mit gesetztem
   * assignment_notified_at (ein Vertretungswechsel nach dem ersten Push soll
   * die nun zuständige Person erreichen), aber ohne geschlossene Versionen.
   * Der Vorab-Filter hier (geschlossen / K(R) existiert bereits) spart nur
   * Transaktionen – entschieden wird ausschließlich im Claim unter Sperre.
   */
  async scanSameDayReassignments(now: Date): Promise<number> {
    const rows = await this.deps.db
      .select({
        appointmentId: appointments.id,
        requestedAt: appointments.acknowledgementRequestedAt,
        requestedFor: appointments.acknowledgementRequestedFor,
        notifiedAt: appointments.assignmentNotifiedAt,
        assignedUserId: appointments.assignedUserId,
        startAt: appointments.startAt,
      })
      .from(appointments)
      .where(
        and(
          eq(appointments.status, 'scheduled'),
          isNotNull(appointments.acknowledgementRequestedAt),
          isNotNull(appointments.acknowledgementRequestedFor),
          eq(appointments.assignedUserId, appointments.acknowledgementRequestedFor),
          // Phase 12 Finalisierung (B3): nur Neuzuweisungen der letzten 24 h –
          // ältere (Bestandsdaten, Scan-Ausfall) sind nicht mehr „kurzfristig“:
          // weder Push noch Claim, sie fallen nur aus der Kandidatenmenge.
          gt(appointments.acknowledgementRequestedAt, new Date(now.getTime() - LOOKBACK_MS)),
        ),
      );
    if (rows.length === 0) return 0;
    const substitutions = await loadSubstitutions(this.deps.db);
    let enqueued = 0;
    for (const row of rows) {
      if (row.requestedAt === null || row.requestedFor === null) continue;
      try {
        // Vorab-Filter (außerhalb der Transaktion, keine Entscheidung).
        if (row.notifiedAt !== null) {
          const versionDeliveries = await loadReassignmentVersionDeliveries(
            this.deps.db,
            row.appointmentId,
            row.requestedAt,
          );
          if (isReassignmentVersionClosed(row.notifiedAt, versionDeliveries)) continue;
          const recipient = effectiveAssigneeForAppointment(row, substitutions, now);
          const key =
            recipient === null
              ? null
              : pushKeys.reassignment(row.appointmentId, row.requestedAt, recipient);
          if (versionDeliveries.some((delivery) => delivery.idempotencyKey === key)) continue;
        }
        await this.deps.onCandidateRead?.({
          rule: 'assignment_reassigned',
          appointmentId: row.appointmentId,
        });
        const claim = await this.claimReassignment(
          {
            appointmentId: row.appointmentId,
            requestedAt: row.requestedAt,
            requestedFor: row.requestedFor,
          },
          now,
        );
        if (claim === null || claim.deliveryId === null) continue;
        if (!claim.deduplicated) enqueued += 1;
        // (4) Job erst NACH dem Commit; fehlt er (Absturz), holt ihn der Backstop nach.
        await this.deps.push.enqueueSendJob(claim.deliveryId);
      } catch (error) {
        // Fehler vor dem Commit ⇒ Rollback ⇒ Claim zurück ⇒ nächster Scan holt nach.
        this.logCandidateFailure('assignment_reassigned', row.appointmentId, error);
      }
    }
    return enqueued;
  }

  /**
   * (g) Claim GENAU dieser Zuweisungs-Version (Phase 12 Finalisierung 2,
   * Regel D) in EINER Transaktion:
   *  1. Termin sperren (`FOR NO KEY UPDATE` wie `SchedulingService.
   *     lockAppointment` ⇒ serialisiert gegen assign/reschedule/Storno und
   *     gegen parallele Scanner); V erneut prüfen (status scheduled,
   *     requestedAt ms-genau, requestedFor, assigned = requested_for) –
   *     geändert ⇒ `null`, nichts geändert (die neue Version ist ein eigener
   *     Anspruch).
   *  2. No-op-Fälle schließen die Version (assignment_notified_at = now, falls
   *     NULL; ohne Zustellung ⇒ „geschlossen“, kein späteres Nachholen):
   *     Vorgang storniert; start_at fehlt oder anderer Berliner Kalendertag als
   *     requestedAt (Regel C); effektiver Empfänger nicht aktiv.
   *  3. Version geschlossen (Regel E) ⇒ `null`.
   *  4. Vertretungen IN der Transaktion laden, R = effektive Zuständigkeit
   *     (dieselbe Funktion wie die 1h-Regel). Existiert K(R) schon ⇒ nur
   *     markieren, `null` (genau eine Zustellung je Version und Empfänger).
   *     Sonst `createDelivery(K(R), R, appointmentId, tx)` + Markierung.
   *  5. Commit. Ein Fehler in 1–4 rollt alles zurück.
   * Der Job (`push.send`) wird vom Aufrufer nach dem Commit eingereiht. Die
   * Phase-4-Bestätigung bleibt bei requestedFor (nur diese Person bestätigt).
   * Vergleich auf Millisekunden: Werte stammen aus JS-Dates (ms-genau); so
   * scheitert der Vergleich auch bei µs-genau geschriebenen Altwerten nicht.
   */
  async claimReassignment(
    candidate: ReassignmentCandidate,
    now: Date,
  ): Promise<ReassignmentClaim | null> {
    return this.deps.db.transaction(async (tx) => {
      const locked = (
        await tx
          .select()
          .from(appointments)
          .where(eq(appointments.id, candidate.appointmentId))
          .for('no key update')
      )[0];
      const requestedAt = locked?.acknowledgementRequestedAt ?? null;
      if (
        locked === undefined ||
        locked.status !== 'scheduled' ||
        requestedAt === null ||
        requestedAt.getTime() !== candidate.requestedAt.getTime() ||
        locked.acknowledgementRequestedFor !== candidate.requestedFor ||
        locked.assignedUserId !== candidate.requestedFor
      ) {
        return null;
      }
      const markHandled = () =>
        tx
          .update(appointments)
          .set({ assignmentNotifiedAt: now })
          .where(and(eq(appointments.id, locked.id), isNull(appointments.assignmentNotifiedAt)));
      const process = (
        await tx
          .select({ processNumber: processes.processNumber, mainStatus: processes.mainStatus })
          .from(processes)
          .where(eq(processes.id, locked.processId))
      )[0];
      if (process === undefined || process.mainStatus === 'cancelled') {
        await markHandled();
        return { deliveryId: null, skipped: 'process_cancelled' };
      }
      if (!isReassignmentClaimDay(locked.startAt, requestedAt, now)) {
        await markHandled();
        return { deliveryId: null, skipped: 'not_same_day' };
      }
      const versionDeliveries = await loadReassignmentVersionDeliveries(tx, locked.id, requestedAt);
      if (isReassignmentVersionClosed(locked.assignmentNotifiedAt, versionDeliveries)) {
        return null;
      }
      const recipient = effectiveAssigneeForAppointment(locked, await loadSubstitutions(tx), now);
      const recipientRows =
        recipient === null
          ? []
          : await tx
              .select({ status: staffUsers.status })
              .from(staffUsers)
              .where(eq(staffUsers.id, recipient));
      if (recipient === null || recipientRows[0]?.status !== 'active') {
        await markHandled();
        return { deliveryId: null, skipped: 'recipient_inactive' };
      }
      const idempotencyKey = pushKeys.reassignment(locked.id, requestedAt, recipient);
      if (versionDeliveries.some((delivery) => delivery.idempotencyKey === idempotencyKey)) {
        await markHandled(); // Altbestand ohne Markierung (RA5b) – sonst bereits markiert
        return null;
      }
      const delivery = await this.deps.push.createDelivery(
        {
          kind: 'assignment_reassigned',
          userId: recipient,
          idempotencyKey,
          appointmentId: locked.id, // B2: Versandzeit-Prüfung (SUPERSEDED)
          payload: buildPushPayload({
            kind: 'assignment_reassigned',
            processId: locked.processId,
            processNumber: process.processNumber,
            appointmentKind: locked.kind as PushAppointmentKind,
          }),
        },
        tx,
      );
      await markHandled();
      return delivery;
    });
  }

  // Outbox-Backstop ──────────────────────────────────────────────────────────
  /**
   * Ausstehende Zustellungen der letzten 24 h, für die KEIN `push.send`-Job
   * existiert (Absturz zwischen Commit und Job-Einreihung), erhalten ihren Job.
   * Bewusst mit dem STABILEN Schlüssel `push.send:<deliveryId>` statt eines
   * Bucket-Schlüssels: „kein Job vorhanden“ heißt, dieser Schlüssel ist frei;
   * reiht der Normalpfad verspätet doch noch ein, dedupliziert die Queue – es
   * entstehen nie zwei Jobs (und damit nie zwei Sendungen) je Zustellung.
   * Eine Zustellung mit bereits existierendem (auch `dead`) Job wird nicht
   * angefasst ⇒ höchstens ein nachgeholter Job, keine Endlosschleife. Der Job
   * selbst ist für nicht mehr ausstehende Zustellungen ein No-op.
   */
  async scheduleOutboxBackstop(now: Date): Promise<number> {
    const rows = await this.deps.db
      .select({ id: pushDeliveries.id })
      .from(pushDeliveries)
      .where(
        and(
          eq(pushDeliveries.status, 'pending'),
          gt(pushDeliveries.createdAt, new Date(now.getTime() - LOOKBACK_MS)),
          sql`NOT EXISTS (
            SELECT 1 FROM ${integrationJobs} j
            WHERE j.idempotency_key = ${`${PUSH_SEND_JOB_TYPE}:`} || ${pushDeliveries.id}::text
          )`,
        ),
      )
      .limit(200);
    let scheduled = 0;
    for (const row of rows) {
      if (await this.deps.push.enqueueSendJob(row.id)) scheduled += 1;
    }
    if (scheduled > 0) {
      this.deps.logger?.info({ scheduled }, 'Push-Outbox-Backstop: fehlende Jobs nachgeholt');
    }
    return scheduled;
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
