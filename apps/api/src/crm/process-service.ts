import {
  bookingPickupRepresentatives,
  bookings,
  cancellations,
  customers,
  handovers,
  machineAssignments,
  processNotes,
  processes,
  staffUsers,
  type Database,
  type DatabaseTransaction,
  type Process,
} from '@mietroyal/database';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import { berlinYear } from './normalize.ts';
import {
  isProcessVisible,
  visibleProcessesWhere,
  type ProcessVisibilityContext,
} from './visibility.ts';

const processListColumns = {
  id: processes.id,
  processNumber: processes.processNumber,
  mainStatus: processes.mainStatus,
  eventDate: processes.eventDate,
  createdAt: processes.createdAt,
  completedAt: processes.completedAt,
  customerId: processes.customerId,
  customerType: customers.type,
  customerFirstName: customers.firstName,
  customerLastName: customers.lastName,
  customerOrganizationName: customers.organizationName,
  assignedUserId: processes.assignedUserId,
  assignedFirstName: staffUsers.firstName,
  assignedLastName: staffUsers.lastName,
};

const LOCKED_MESSAGE =
  'Der Vorgang ist abgeschlossen und für die normale Bearbeitung gesperrt. Zum Bearbeiten bitte wieder öffnen.';

/**
 * Phase 12 (reminders/retention): Nach-Commit-Listener für den
 * Vorgangsabschluss (z. B. Retention-Job für Chatfotos). Fehler im Listener
 * machen den Abschluss nie rückgängig.
 * Phase-12-Finalisierung (Retention §4.1): optional auch für den Eintritt in
 * „storniert“ – beide Storno-Wege (Legacy ohne Buchung, Phase-9-Storno mit
 * Buchung) melden nach ihrem Commit mit `processes.cancelled_at`.
 */
export interface ProcessCompletionListener {
  processCompleted(event: { processId: string; completedAt: Date }): Promise<void>;
  processCancelled?(event: { processId: string; cancelledAt: Date }): Promise<void>;
}

export class ProcessService {
  constructor(
    private readonly db: Database,
    private readonly completionListeners: readonly ProcessCompletionListener[] = [],
  ) {}

  /**
   * Race-sichere Vergabe der öffentlichen Vorgangsnummer MR-YYYY-NNNN:
   * Die laufende Nummer kommt aus einer PostgreSQL-Sequenz (nie doppelt,
   * nie wiederverwendet, läuft über Jahresgrenzen weiter); das Jahr ist das
   * Erstellungsjahr in Europe/Berlin. Unveränderbarkeit erzwingt zusätzlich
   * ein DB-Trigger (Migration 0004).
   */
  async createProcess(
    actorId: string,
    input: {
      customerId: string;
      source?: 'website' | 'whatsapp' | 'staff_manual' | 'other' | undefined;
      eventDate?: string | undefined;
      assignedUserId?: string | undefined;
    },
    now = new Date(),
  ): Promise<Process> {
    if (input.assignedUserId !== undefined) {
      await this.assertAssignableUser(input.assignedUserId);
    }

    return this.db.transaction((tx) => this.createProcessWithin(tx, actorId, input, now));
  }

  /**
   * Anlegen innerhalb einer laufenden Transaktion (Phase 9: Folgevorgang
   * aus Storno – Verknüpfung und neuer Vorgang entstehen atomar). Die
   * Zuweisungsprüfung übernimmt der Aufrufer von createProcess.
   */
  async createProcessWithin(
    tx: DatabaseTransaction,
    actorId: string,
    input: {
      customerId: string;
      source?: 'website' | 'whatsapp' | 'staff_manual' | 'other' | undefined;
      eventDate?: string | undefined;
      assignedUserId?: string | undefined;
    },
    now = new Date(),
  ): Promise<Process> {
    // Kundenzeile sperren (FOR KEY SHARE): kollidiert mit dem FOR UPDATE
    // des Papierkorbs – ein Kunde kann nicht gleichzeitig gelöscht werden,
    // während ihm ein Vorgang angelegt wird (und umgekehrt).
    const customerRows = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, input.customerId), isNull(customers.deletedAt)))
      .for('key share');
    if (customerRows.length === 0) throw new AuthError('NOT_FOUND', 'Kunde nicht gefunden.');

    const seqResult = await tx.execute(sql`SELECT nextval('process_number_seq') AS seq`);
    const seqValue = seqResult.rows[0]?.seq;
    if (seqValue === undefined) throw new AuthError('CONFLICT', 'Nummernvergabe fehlgeschlagen.');
    const sequence = Number(seqValue);
    const processNumber = `MR-${berlinYear(now)}-${String(sequence).padStart(4, '0')}`;

    const inserted = await tx
      .insert(processes)
      .values({
        processNumber,
        customerId: input.customerId,
        source: input.source ?? 'staff_manual',
        eventDate: input.eventDate ?? null,
        assignedUserId: input.assignedUserId ?? null,
        createdBy: actorId,
      })
      .returning();
    const process = inserted[0];
    if (process === undefined) throw new AuthError('CONFLICT', 'Anlegen fehlgeschlagen.');
    return process;
  }

  /** Bestätigte Buchung des Vorgangs (Phase 9: entscheidet über den Storno-Pfad). */
  async bookingForProcess(processId: string): Promise<{ id: string } | null> {
    const rows = await this.db
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.processId, processId));
    return rows[0] ?? null;
  }

  async getProcess(processId: string): Promise<Process> {
    const rows = await this.db.select().from(processes).where(eq(processes.id, processId));
    const process = rows[0];
    if (process === undefined) throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
    return process;
  }

  /** Detailzugriff mit zentraler Sichtbarkeitsregel: unsichtbar = 404. */
  async getVisibleProcess(processId: string, ctx: ProcessVisibilityContext): Promise<Process> {
    const process = await this.getProcess(processId);
    if (!isProcessVisible(process, ctx)) {
      throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
    }
    return process;
  }

  private assertEditable(process: Process): void {
    if (process.mainStatus === 'completed' || process.mainStatus === 'cancelled') {
      throw new AuthError('CONFLICT', LOCKED_MESSAGE);
    }
  }

  /**
   * Gemeinsamer Kern aller Schreibpfade: Zeile sperren (FOR UPDATE, kein
   * Check-then-act-Rennen) UND die zentrale Sichtbarkeitsregel anwenden –
   * ein unsichtbarer Vorgang ist auch für Schreibzugriffe ein 404, damit
   * weder Existenz noch Status durchsickern (§9/§10/§15/§24).
   */
  private async lockVisibleProcess(
    tx: DatabaseTransaction,
    processId: string,
    ctx: ProcessVisibilityContext,
  ): Promise<Process> {
    const rows = await tx.select().from(processes).where(eq(processes.id, processId)).for('update');
    const process = rows[0];
    if (process === undefined || !isProcessVisible(process, ctx)) {
      throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
    }
    return process;
  }

  private async assertAssignableUser(userId: string): Promise<void> {
    const rows = await this.db
      .select({ status: staffUsers.status })
      .from(staffUsers)
      .where(eq(staffUsers.id, userId));
    const user = rows[0];
    if (user === undefined) throw new AuthError('NOT_FOUND', 'Mitarbeiter nicht gefunden.');
    if (user.status !== 'active') {
      throw new AuthError('VALIDATION', 'Nur aktive Mitarbeitende können zugewiesen werden.');
    }
  }

  async updateEventDate(
    processId: string,
    eventDate: string | null,
    ctx: ProcessVisibilityContext,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const process = await this.lockVisibleProcess(tx, processId, ctx);
      this.assertEditable(process);
      await tx
        .update(processes)
        .set({ eventDate, updatedAt: new Date() })
        .where(eq(processes.id, processId));
    });
  }

  /**
   * Zuweisung/Wechsel der Zuständigkeit. Bestehende historische Referenzen
   * bleiben unangetastet, wenn ein Mitarbeiter später deaktiviert wird –
   * nur NEUE Zuweisungen verlangen ein aktives Konto. Die spätere
   * Vertretungslogik setzt hier zentral auf (eine Auflösungsstelle).
   */
  async assign(
    processId: string,
    userId: string | null,
    ctx: ProcessVisibilityContext,
  ): Promise<void> {
    if (userId !== null) await this.assertAssignableUser(userId);
    await this.db.transaction(async (tx) => {
      const process = await this.lockVisibleProcess(tx, processId, ctx);
      this.assertEditable(process);
      await tx
        .update(processes)
        .set({ assignedUserId: userId, updatedAt: new Date() })
        .where(eq(processes.id, processId));
    });
  }

  /** Operativ beendet – keine Rechnungs-/Zahlungslogik in Phase 2. */
  async complete(processId: string, ctx: ProcessVisibilityContext): Promise<void> {
    const completedAt = await this.db.transaction(async (tx) => {
      const process = await this.lockVisibleProcess(tx, processId, ctx);
      if (process.mainStatus !== 'open' && process.mainStatus !== 'reopened') {
        throw new AuthError('CONFLICT', 'Nur offene Vorgänge können abgeschlossen werden.');
      }
      // Phase 6: zugewiesene, vorbereitete oder ausgegebene Maschinen halten
      // den Vorgang operativ offen (Rückgabe folgt in Phase 7).
      const activeAssignments = await tx
        .select({ id: machineAssignments.id })
        .from(machineAssignments)
        .where(
          and(
            eq(machineAssignments.processId, processId),
            inArray(machineAssignments.status, ['assigned', 'prepared', 'issued']),
          ),
        );
      if (activeAssignments.length > 0) {
        throw new AuthError(
          'CONFLICT',
          'Der Vorgang hat noch zugewiesene, vorbereitete oder ausgegebene Maschinen – bitte zuerst die Zuordnungen lösen bzw. die Rückgabe abschließen.',
        );
      }
      const now = new Date();
      await tx
        .update(processes)
        .set({ mainStatus: 'completed', completedAt: now, updatedAt: now })
        .where(eq(processes.id, processId));
      await this.deleteEphemeralPhones(tx, processId, now);
      return now;
    });
    // Phase 12 (retention): Listener NACH dem Commit, nie unter Sperren.
    for (const listener of this.completionListeners) {
      try {
        await listener.processCompleted({ processId, completedAt });
      } catch (error) {
        console.error('Vorgangsabschluss-Listener fehlgeschlagen', error);
      }
    }
  }

  /**
   * Wiederöffnen (nur mit process.reopen_completed): Status „Wieder
   * geöffnet“, keine automatischen Termine/Aufgaben, keine Pflichtbegründung.
   * Wieder geöffnete Vorgänge sind standardmäßig nur mit
   * process.view_completed sichtbar (visibility.ts).
   */
  async reopen(processId: string, actorId: string | null = null): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Bewusst OHNE Sichtbarkeitskontext: process.reopen_completed schließt
      // den Zugriff auf abgeschlossene Vorgänge fachlich ein (§10).
      const rows = await tx
        .select()
        .from(processes)
        .where(eq(processes.id, processId))
        .for('update');
      const process = rows[0];
      if (process === undefined) throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
      if (process.mainStatus !== 'completed' && process.mainStatus !== 'cancelled') {
        throw new AuthError(
          'CONFLICT',
          'Nur abgeschlossene Vorgänge können wieder geöffnet werden.',
        );
      }
      const now = new Date();
      await tx
        .update(processes)
        .set({ mainStatus: 'reopened', reopenedAt: now, updatedAt: now })
        .where(eq(processes.id, processId));
      // Phase 9 §63: Reopen eines Stornos wird an der Stornierung markiert;
      // Buchhaltungsdaten bleiben unverändert, die alte Buchung wird NICHT
      // reaktiviert – der wieder geöffnete Vorgang ist nur Arbeitsgrundlage.
      if (process.mainStatus === 'cancelled') {
        await tx
          .update(cancellations)
          .set({ reopenedAt: now, reopenedBy: actorId, updatedAt: now })
          .where(eq(cancellations.processId, processId));
      }
    });
  }

  /**
   * Grundzustand „storniert“ für Vorgänge OHNE bestätigte Buchung
   * (Phase-2-Vorgabe Nr. 3/6). Vorgänge mit akzeptierter Buchung werden
   * ausschließlich über den Storno-Pfad (CancellationService, Phase 9)
   * storniert: Stornoberechnung, Ressourcenfreigabe, Stornorechnung.
   */
  async cancel(processId: string, ctx: ProcessVisibilityContext): Promise<void> {
    const cancelledAt = await this.db.transaction(async (tx) => {
      const process = await this.lockVisibleProcess(tx, processId, ctx);
      if (process.mainStatus !== 'open' && process.mainStatus !== 'reopened') {
        throw new AuthError('CONFLICT', 'Nur offene Vorgänge können storniert werden.');
      }
      const bookingRows = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(eq(bookings.processId, processId));
      if (bookingRows.length > 0) {
        throw new AuthError(
          'CONFLICT',
          'Der Vorgang hat eine bestätigte Buchung – bitte über „Buchung stornieren“ (Stornovorschau) stornieren.',
        );
      }
      const now = new Date();
      await this.markCancelledWithin(tx, processId, now);
      return now;
    });
    // Phase-12-Finalisierung (Retention): Listener NACH dem Commit, nie unter Sperren.
    await this.notifyCancelled({ processId, cancelledAt });
  }

  /**
   * Phase-12-Finalisierung (Retention §4.1): Storno-Listener nach dem Commit
   * benachrichtigen – auch vom Phase-9-Storno (CancellationService) nach
   * dessen Commit aufgerufen. Fehler machen das Storno nie rückgängig (der
   * Retention-Backstop in scan_due holt die Arbeit nach).
   */
  async notifyCancelled(event: { processId: string; cancelledAt: Date }): Promise<void> {
    for (const listener of this.completionListeners) {
      if (listener.processCancelled === undefined) continue;
      try {
        await listener.processCancelled(event);
      } catch (error) {
        console.error('Storno-Listener fehlgeschlagen', error);
      }
    }
  }

  /**
   * Statusübergang „storniert“ unter bereits gehaltener Vorgangssperre –
   * EINE Stelle für den Übergang (Legacy-Storno ohne Buchung und Phase-9-
   * Storno mit Buchung): Status, Zeitstempel, ephemere Telefonnummern.
   * `processes.cancelled_at` ist damit der persistierte fachliche
   * Stornozeitpunkt beider Wege (beim Phase-9-Storno identisch mit
   * `cancellations.cancelled_at`) – Retention-Anker der Kommunikation.
   */
  async markCancelledWithin(tx: DatabaseTransaction, processId: string, now: Date): Promise<void> {
    await tx
      .update(processes)
      .set({ mainStatus: 'cancelled', cancelledAt: now, updatedAt: now })
      .where(eq(processes.id, processId));
    await this.deleteEphemeralPhones(tx, processId, now);
  }

  /**
   * Ephemere Telefonnummern (Abholperson, sonstiger Vertreter – Phase 6)
   * werden mit dem Ende des Vorgangs gelöscht, auch ohne Finalisierung
   * (MASTER_SPEC §12: Telefon nach Abschluss löschen, Name bleibt).
   */
  private async deleteEphemeralPhones(
    tx: DatabaseTransaction,
    processId: string,
    now: Date,
  ): Promise<void> {
    const bookingIds = tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.processId, processId));
    await tx
      .update(bookingPickupRepresentatives)
      .set({ phone: null, phoneDeletedAt: now, updatedAt: now })
      .where(
        and(
          inArray(bookingPickupRepresentatives.bookingId, bookingIds),
          isNotNull(bookingPickupRepresentatives.phone),
        ),
      );
    await tx
      .update(handovers)
      .set({ recipientPhone: null, updatedAt: now })
      .where(and(eq(handovers.processId, processId), isNotNull(handovers.recipientPhone)));
  }

  async addNote(
    processId: string,
    authorUserId: string,
    text: string,
    ctx: ProcessVisibilityContext,
  ): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === '') throw new AuthError('VALIDATION', 'Die Notiz darf nicht leer sein.');
    await this.db.transaction(async (tx) => {
      const process = await this.lockVisibleProcess(tx, processId, ctx);
      this.assertEditable(process);
      await tx.insert(processNotes).values({ processId, authorUserId, text: trimmed });
    });
  }

  /** Standardliste: offene zuerst, sichtbarkeitsgefiltert, kompakt. */
  async listVisible(ctx: ProcessVisibilityContext, includeCompleted: boolean) {
    const statusFilter = includeCompleted
      ? visibleProcessesWhere(ctx)
      : sql`${processes.mainStatus} IN ('open','reopened') AND ${visibleProcessesWhere(ctx)}`;
    const openFirst = sql<number>`CASE WHEN ${processes.mainStatus} IN ('open','reopened') THEN 0 ELSE 1 END`;
    return this.db
      .select(processListColumns)
      .from(processes)
      .innerJoin(customers, eq(processes.customerId, customers.id))
      .leftJoin(staffUsers, eq(processes.assignedUserId, staffUsers.id))
      .where(statusFilter)
      .orderBy(openFirst, asc(processes.eventDate), desc(processes.createdAt))
      .limit(200);
  }

  /** Vorgänge eines Kunden (sichtbarkeitsgefiltert) für die Kundenakte. */
  async listForCustomer(customerId: string, ctx: ProcessVisibilityContext) {
    return this.db
      .select(processListColumns)
      .from(processes)
      .innerJoin(customers, eq(processes.customerId, customers.id))
      .leftJoin(staffUsers, eq(processes.assignedUserId, staffUsers.id))
      .where(and(eq(processes.customerId, customerId), visibleProcessesWhere(ctx)))
      .orderBy(desc(processes.createdAt))
      .limit(100);
  }

  /**
   * Dashboard-Grundlage (Phase-2-Vorgabe Nr. 16): offene, eigene und
   * neueste Vorgänge – ohne Termine/Kalender, ohne künstliche Aufgaben.
   * Das spätere „Heute“-Dashboard baut hierauf auf.
   */
  async dashboard(userId: string, ctx: ProcessVisibilityContext) {
    const openWhere = sql`${processes.mainStatus} IN ('open','reopened') AND ${visibleProcessesWhere(ctx)}`;
    const countRows = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(processes)
      .where(openWhere);
    const mine = await this.db
      .select(processListColumns)
      .from(processes)
      .innerJoin(customers, eq(processes.customerId, customers.id))
      .leftJoin(staffUsers, eq(processes.assignedUserId, staffUsers.id))
      .where(sql`${openWhere} AND ${processes.assignedUserId} = ${userId}`)
      .orderBy(asc(processes.eventDate), desc(processes.createdAt))
      .limit(8);
    const recent = await this.db
      .select(processListColumns)
      .from(processes)
      .innerJoin(customers, eq(processes.customerId, customers.id))
      .leftJoin(staffUsers, eq(processes.assignedUserId, staffUsers.id))
      .where(openWhere)
      .orderBy(desc(processes.createdAt))
      .limit(8);
    return { openCount: countRows[0]?.total ?? 0, myProcesses: mine, recentProcesses: recent };
  }

  /** Aktive Mitarbeitende für Zuweisungs-Auswahl (Datenminimierung). */
  async listAssignableStaff() {
    return this.db
      .select({
        id: staffUsers.id,
        firstName: staffUsers.firstName,
        lastName: staffUsers.lastName,
      })
      .from(staffUsers)
      .where(eq(staffUsers.status, 'active'))
      .orderBy(asc(staffUsers.lastName), asc(staffUsers.firstName));
  }

  async listNotes(processId: string) {
    return this.db
      .select({
        id: processNotes.id,
        text: processNotes.text,
        createdAt: processNotes.createdAt,
        authorFirstName: staffUsers.firstName,
        authorLastName: staffUsers.lastName,
      })
      .from(processNotes)
      .innerJoin(staffUsers, eq(processNotes.authorUserId, staffUsers.id))
      .where(eq(processNotes.processId, processId))
      .orderBy(desc(processNotes.createdAt))
      .limit(200);
  }
}
