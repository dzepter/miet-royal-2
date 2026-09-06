import { createHash } from 'node:crypto';
import {
  appointments,
  bookings,
  handoverMachineChecks,
  handoverPhotos,
  machineAssignmentOverrides,
  machineAssignments,
  machineBlocks,
  machineRiskIncidents,
  machines,
  processes,
  products,
  staffUsers,
  type Database,
  type DatabaseTransaction,
  type Machine,
  type MachineAssignment,
  type MachineBlock,
  type MachineRiskIncident,
} from '@mietroyal/database';
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { StorageProvider } from '@mietroyal/integrations';
import { AuthError } from '../auth/service.ts';
import { MachineAvailabilityService } from '../warehouse/availability.ts';
import { KeyedMutex } from './keyed-mutex.ts';
import {
  blockOverlaps,
  MACHINE_LOCATION_LABELS,
  MACHINE_STATUS_LABELS,
  type MachineService,
} from '../warehouse/machine-service.ts';

/**
 * Konkrete Maschinenzuweisung (Phase-6-Order §§2–11, 45–50): Slots je
 * benötigter physischer Maschine, bewusste Zuweisung durch Mitarbeiter,
 * serverseitig berechnete Problemlagen (Status/Sperre/Kollision), Override
 * nur mit Recht + Pflichtgrund + Bestätigung, harter Block für physisch
 * bereits ausgegebene Maschinen, Vorbereitung (🟠 Reserviert) und
 * deduplizierte Risiko-Incidents für spätere Buchungen.
 *
 * Der Client behauptet NIE, ob ein Override nötig ist – der Server rechnet
 * die Situation bei jeder Mutation neu (Order §8/§49).
 */

export type MachineProblemCode =
  | 'status_cleaning'
  | 'status_repair'
  | 'status_out_of_service'
  | 'status_rented'
  | 'blocked'
  | 'collision'
  | 'issued_elsewhere'
  | 'period_unknown';

export interface MachineProblem {
  code: MachineProblemCode;
  /** Stabiler Deskriptor für Fingerprint/Override-Abgleich (z. B. block:<id>). */
  descriptor: string;
  label: string;
  detail: string;
  /** Ein Problem, das nur informiert (kein Override nötig). */
  warningOnly: boolean;
  otherProcessNumber?: string;
  otherBookingId?: string;
  from?: string;
  to?: string;
}

export interface MachineEvaluation {
  machineId: string;
  machineCode: string;
  productMatches: boolean;
  problems: MachineProblem[];
  /** Physisch unmöglich (aktuell an anderen Vorgang ausgegeben). */
  hardBlocked: boolean;
  overrideRequired: boolean;
  situationFingerprint: string;
}

export interface AssignmentView {
  id: string;
  slotNo: number;
  productId: string;
  productName: string;
  status: MachineAssignment['status'];
  machine: {
    id: string;
    machineCode: string;
    status: Machine['status'];
    statusLabel: string;
    locationKind: Machine['locationKind'];
    locationLabel: string;
    locationNote: string | null;
  } | null;
  rentalFrom: string | null;
  rentalTo: string | null;
  assignedAt: string | null;
  preparedAt: string | null;
  issuedAt: string | null;
  override: {
    id: string;
    reason: string;
    problemSummary: string;
    confirmedByName: string | null;
    confirmedAt: string;
  } | null;
  /** Aktuelle Problemlage der zugewiesenen Maschine (für Warnhinweise). */
  currentProblems: MachineProblem[];
  /** Ein alter Override deckt die AKTUELLE Lage nicht mehr ab (Order §49). */
  overrideStale: boolean;
}

export interface SuggestionEntryView {
  machineId: string;
  machineCode: string;
  status: Machine['status'];
  statusLabel: string;
  locationKind: Machine['locationKind'];
  locationLabel: string;
  locationNote: string | null;
  purchaseDate: string | null;
  preferred: boolean;
  preferredBasis: string | null;
  eligibility: 'eligible' | 'warning' | 'override_required';
  problems: MachineProblem[];
  hardBlocked: boolean;
  overrideRequired: boolean;
}

export interface RiskIncidentView {
  id: string;
  machineId: string;
  machineCode: string;
  assignmentId: string;
  bookingId: string;
  processId: string;
  processNumber: string;
  reasonKind: MachineRiskIncident['reasonKind'];
  reasonText: string;
  createdAt: string;
  adminNotifiedAt: string | null;
  followUpDueAt: string | null;
  followUpSentAt: string | null;
}

const PROBLEM_LABELS: Record<MachineProblemCode, string> = {
  status_cleaning: 'In Reinigung',
  status_repair: 'In Reparatur',
  status_out_of_service: 'Außer Betrieb',
  status_rented: 'Aktuell vermietet',
  blocked: 'Gesperrt',
  collision: 'Zeitliche Kollision',
  issued_elsewhere: 'An anderen Vorgang ausgegeben',
  period_unknown: 'Mietzeitraum unbekannt',
};

const FOLLOW_UP_DELAY_MS = 6 * 3_600_000;

export function fingerprintOf(descriptors: readonly string[]): string {
  return createHash('sha256')
    .update([...descriptors].sort().join('|'))
    .digest('hex');
}

interface RentalInterval {
  from: Date | null;
  to: Date | null;
}

function overlaps(a: RentalInterval, b: RentalInterval): boolean | null {
  if (a.from === null || a.to === null || b.from === null || b.to === null) return null;
  return a.from.getTime() < b.to.getTime() && b.from.getTime() < a.to.getTime();
}

/** Prozessweit: Risiko-Scans laufen nie verschränkt (Order §46, keine Duplikate). */
const RISK_REFRESH_MUTEX = new KeyedMutex();

export class AssignmentService {
  private readonly availability: MachineAvailabilityService;

  constructor(
    private readonly db: Database,
    private readonly machineService: MachineService,
    /** Für das Löschen verwaister Gesamtfotos beim Lösen/Wechseln (best effort). */
    private readonly storage: StorageProvider | null = null,
  ) {
    this.availability = new MachineAvailabilityService(db);
  }

  /**
   * Prüfung „gemeinsam geprüft“ und Gesamtfotos gelten nur für die AKTUELLE
   * Zuordnung (Order §§25/27): beim Lösen oder Maschinenwechsel werden sie
   * entfernt, damit eine spätere Zuordnung derselben Maschine erneut aktiv
   * geprüft und fotografiert wird.
   */
  private async clearHandoverEvidence(
    tx: DatabaseTransaction,
    assignmentId: string,
    keys: string[],
  ): Promise<void> {
    await tx
      .delete(handoverMachineChecks)
      .where(eq(handoverMachineChecks.assignmentId, assignmentId));
    const photos = await tx
      .delete(handoverPhotos)
      .where(eq(handoverPhotos.assignmentId, assignmentId))
      .returning({ storageKey: handoverPhotos.storageKey });
    keys.push(...photos.map((photo) => photo.storageKey));
  }

  private async deleteStorageKeys(keys: string[]): Promise<void> {
    if (this.storage === null) return;
    for (const key of keys) {
      try {
        await this.storage.delete(key);
      } catch {
        // best effort – verwaistes Objekt ist unkritisch
      }
    }
  }

  // ── Slots (Order §§3–5) ─────────────────────────────────────────────────

  /** Fachlicher Mietzeitraum aus den Phase-4-Terminen der Buchung. */
  async rentalIntervalFor(bookingId: string): Promise<RentalInterval> {
    const rows = await this.db
      .select()
      .from(appointments)
      .where(and(eq(appointments.bookingId, bookingId), ne(appointments.status, 'cancelled')));
    const outbound = rows.find((row) => row.kind === 'pickup' || row.kind === 'delivery');
    const inbound = rows.find((row) => row.kind === 'return');
    const from = outbound?.startAt ?? null;
    const to = inbound === undefined ? null : (inbound.endAt ?? inbound.startAt);
    if (from !== null && to !== null && to.getTime() <= from.getTime()) {
      return { from, to: null };
    }
    return { from, to };
  }

  /**
   * Idempotent: je gebuchter Maschine (Snapshot-Menge) genau ein Slot;
   * Unique (Buchung, Laufnummer) macht parallele Aufrufe unschädlich.
   * Keine automatische Maschine (Order §6).
   */
  async ensureSlotsForBooking(
    bookingId: string,
    actorId: string | null,
  ): Promise<{ created: number }> {
    const bookingRows = await this.db.select().from(bookings).where(eq(bookings.id, bookingId));
    const booking = bookingRows[0];
    if (booking === undefined) throw new AuthError('NOT_FOUND', 'Buchung nicht gefunden.');
    const items = (booking.itemsSnapshot ?? []) as {
      kind?: string;
      productId?: string | null;
      quantity?: number;
    }[];
    const machineItem = items.find(
      (item) => item.kind === 'machine' && typeof item.productId === 'string',
    );
    if (machineItem === undefined || typeof machineItem.productId !== 'string') {
      return { created: 0 };
    }
    const quantity =
      typeof machineItem.quantity === 'number' &&
      Number.isInteger(machineItem.quantity) &&
      machineItem.quantity > 0
        ? machineItem.quantity
        : 1;
    const interval = await this.rentalIntervalFor(bookingId);
    let created = 0;
    for (let slotNo = 1; slotNo <= quantity; slotNo += 1) {
      const inserted = await this.db
        .insert(machineAssignments)
        .values({
          bookingId,
          processId: booking.processId,
          productId: machineItem.productId,
          slotNo,
          status: 'open',
          rentalFrom: interval.from,
          rentalTo: interval.to,
          createdBy: actorId,
        })
        .onConflictDoNothing({ target: [machineAssignments.bookingId, machineAssignments.slotNo] })
        .returning({ id: machineAssignments.id });
      created += inserted.length;
    }
    return { created };
  }

  async slotsForBooking(bookingId: string, now = new Date()): Promise<AssignmentView[]> {
    const rows = await this.db
      .select({ assignment: machineAssignments, productName: products.name })
      .from(machineAssignments)
      .innerJoin(products, eq(products.id, machineAssignments.productId))
      .where(eq(machineAssignments.bookingId, bookingId))
      .orderBy(asc(machineAssignments.slotNo));
    const views: AssignmentView[] = [];
    for (const row of rows) {
      views.push(await this.viewOf(row.assignment, row.productName, now));
    }
    return views;
  }

  async assignmentById(assignmentId: string): Promise<MachineAssignment> {
    const rows = await this.db
      .select()
      .from(machineAssignments)
      .where(eq(machineAssignments.id, assignmentId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Zuordnung nicht gefunden.');
    return row;
  }

  private async viewOf(
    assignment: MachineAssignment,
    productName: string,
    now: Date,
  ): Promise<AssignmentView> {
    let machineView: AssignmentView['machine'] = null;
    let currentProblems: MachineProblem[] = [];
    let overrideStale = false;
    let overrideView: AssignmentView['override'] = null;
    if (assignment.machineId !== null) {
      const machineRows = await this.db
        .select()
        .from(machines)
        .where(eq(machines.id, assignment.machineId));
      const machine = machineRows[0];
      if (machine !== undefined) {
        machineView = {
          id: machine.id,
          machineCode: machine.machineCode,
          status: machine.status,
          statusLabel: MACHINE_STATUS_LABELS[machine.status],
          locationKind: machine.locationKind,
          locationLabel: MACHINE_LOCATION_LABELS[machine.locationKind],
          locationNote: machine.locationNote,
        };
        if (assignment.status !== 'issued' && assignment.status !== 'returned') {
          const evaluation = await this.evaluateMachine(machine.id, assignment, now);
          currentProblems = evaluation.problems;
          if (assignment.overrideId !== null) {
            const overrideRows = await this.db
              .select({
                override: machineAssignmentOverrides,
                firstName: staffUsers.firstName,
                lastName: staffUsers.lastName,
              })
              .from(machineAssignmentOverrides)
              .leftJoin(staffUsers, eq(staffUsers.id, machineAssignmentOverrides.confirmedBy))
              .where(eq(machineAssignmentOverrides.id, assignment.overrideId));
            const found = overrideRows[0];
            if (found !== undefined) {
              overrideView = {
                id: found.override.id,
                reason: found.override.reason,
                problemSummary: found.override.problemSummary,
                confirmedByName:
                  found.firstName === null
                    ? null
                    : `${found.firstName} ${found.lastName ?? ''}`.trim(),
                confirmedAt: found.override.confirmedAt.toISOString(),
              };
              overrideStale =
                evaluation.overrideRequired &&
                found.override.situationFingerprint !== evaluation.situationFingerprint;
            }
          } else if (evaluation.overrideRequired) {
            // Zugewiesen ohne Override, inzwischen problematisch (Order §45/§49).
            overrideStale = true;
          }
        }
      }
    }
    return {
      id: assignment.id,
      slotNo: assignment.slotNo,
      productId: assignment.productId,
      productName,
      status: assignment.status,
      machine: machineView,
      rentalFrom: assignment.rentalFrom?.toISOString() ?? null,
      rentalTo: assignment.rentalTo?.toISOString() ?? null,
      assignedAt: assignment.assignedAt?.toISOString() ?? null,
      preparedAt: assignment.preparedAt?.toISOString() ?? null,
      issuedAt: assignment.issuedAt?.toISOString() ?? null,
      override: overrideView,
      currentProblems,
      overrideStale,
    };
  }

  // ── Problemlage einer Maschine (Order §§7/8) ────────────────────────────

  private async openBlocksFor(machineId: string, now: Date): Promise<MachineBlock[]> {
    return this.db
      .select()
      .from(machineBlocks)
      .where(
        and(
          eq(machineBlocks.machineId, machineId),
          isNull(machineBlocks.liftedAt),
          sql`${machineBlocks.endsAt} > ${now}`,
        ),
      )
      .orderBy(asc(machineBlocks.startsAt));
  }

  /**
   * Serverseitige Bewertung: Status, Sperren im Mietzeitraum, zeitliche
   * Kollisionen mit anderen Zuordnungen derselben Maschine. „issued_elsewhere“
   * und „status_rented“ sind HARTE Blocker (Physik, Order §7); alles andere
   * ist per Override übersteuerbar.
   */
  async evaluateMachine(
    machineId: string,
    assignment: Pick<
      MachineAssignment,
      'id' | 'bookingId' | 'productId' | 'rentalFrom' | 'rentalTo'
    >,
    now = new Date(),
  ): Promise<MachineEvaluation> {
    const machineRows = await this.db.select().from(machines).where(eq(machines.id, machineId));
    const machine = machineRows[0];
    if (machine === undefined) throw new AuthError('NOT_FOUND', 'Maschine nicht gefunden.');
    const problems: MachineProblem[] = [];
    // Immer der LIVE-Mietzeitraum aus den Phase-4-Terminen: die gespeicherten
    // rental_from/to sind nur ein Spiegel und veralten bei Terminverschiebung.
    const interval = await this.rentalIntervalFor(assignment.bookingId);
    const intervalCache = new Map<string, RentalInterval>([[assignment.bookingId, interval]]);

    if (
      machine.status === 'cleaning' ||
      machine.status === 'repair' ||
      machine.status === 'out_of_service'
    ) {
      const code = `status_${machine.status}` as MachineProblemCode;
      problems.push({
        code,
        descriptor: `status:${machine.status}`,
        label: PROBLEM_LABELS[code],
        detail: `Maschine ${machine.machineCode} ist aktuell „${MACHINE_STATUS_LABELS[machine.status]}“.`,
        warningOnly: false,
      });
    }

    // Sperren im Mietzeitraum. Bekannter Beginn ohne Ende: Sperren, die vor
    // dem Beginn enden, sind irrelevant; ohne bekannten Beginn ist eine
    // Überlappung nicht bestimmbar → Warnung statt Override-Pflicht (Order §7).
    for (const block of await this.openBlocksFor(machineId, now)) {
      const relevant =
        interval.from === null
          ? true
          : interval.to === null
            ? block.endsAt.getTime() > interval.from.getTime()
            : blockOverlaps(block, interval.from, interval.to);
      if (!relevant) continue;
      problems.push({
        code: 'blocked',
        descriptor: `block:${block.id}`,
        label: PROBLEM_LABELS.blocked,
        detail: `Sperre ${block.startsAt.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })} – ${block.endsAt.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}: ${block.reason}`,
        warningOnly: interval.from === null,
        from: block.startsAt.toISOString(),
        to: block.endsAt.toISOString(),
      });
    }

    // Andere Zuordnungen derselben Maschine (nicht dieser Slot).
    const others = await this.db
      .select({ assignment: machineAssignments, processNumber: processes.processNumber })
      .from(machineAssignments)
      .innerJoin(processes, eq(processes.id, machineAssignments.processId))
      .where(
        and(
          eq(machineAssignments.machineId, machineId),
          ne(machineAssignments.id, assignment.id),
          inArray(machineAssignments.status, ['assigned', 'prepared', 'issued']),
          // Stornierte Vorgänge erzeugen keine Phantom-Kollisionen; eine
          // physisch ausgegebene Maschine bleibt trotzdem beim Kunden.
          or(eq(machineAssignments.status, 'issued'), ne(processes.mainStatus, 'cancelled')),
        ),
      );
    let hardBlocked = false;
    for (const other of others) {
      let otherInterval = intervalCache.get(other.assignment.bookingId);
      if (otherInterval === undefined) {
        otherInterval = await this.rentalIntervalFor(other.assignment.bookingId);
        intervalCache.set(other.assignment.bookingId, otherInterval);
      }
      if (other.assignment.status === 'issued') {
        // Physisch beim anderen Kunden – bis zur Rückgabe unmöglich.
        hardBlocked = true;
        problems.push({
          code: 'issued_elsewhere',
          descriptor: `issued:${other.assignment.id}`,
          label: PROBLEM_LABELS.issued_elsewhere,
          detail: `Maschine ${machine.machineCode} ist an Vorgang ${other.processNumber} ausgegeben und noch nicht zurück.`,
          warningOnly: false,
          otherProcessNumber: other.processNumber,
          otherBookingId: other.assignment.bookingId,
        });
        continue;
      }
      const overlap = overlaps(interval, otherInterval);
      if (overlap === true) {
        problems.push({
          code: 'collision',
          descriptor: `collision:${other.assignment.id}`,
          label: PROBLEM_LABELS.collision,
          detail: `Maschine ${machine.machineCode} ist für Vorgang ${other.processNumber} im überlappenden Zeitraum eingeplant.`,
          warningOnly: false,
          otherProcessNumber: other.processNumber,
          otherBookingId: other.assignment.bookingId,
          from: otherInterval.from?.toISOString() ?? undefined,
          to: otherInterval.to?.toISOString() ?? undefined,
        } as MachineProblem);
      } else if (overlap === null) {
        problems.push({
          code: 'period_unknown',
          descriptor: `period-unknown:${other.assignment.id}`,
          label: PROBLEM_LABELS.period_unknown,
          detail: `Maschine ${machine.machineCode} ist auch für Vorgang ${other.processNumber} eingeplant – eine Kollision ist ohne vollständige Terminzeiten nicht ausschließbar.`,
          warningOnly: true,
          otherProcessNumber: other.processNumber,
          otherBookingId: other.assignment.bookingId,
        });
      }
    }
    if (machine.status === 'rented' && !hardBlocked) {
      // Vermietet ohne bekannte Zuordnung – physisch nicht verfügbar.
      hardBlocked = true;
      problems.push({
        code: 'status_rented',
        descriptor: 'status:rented',
        label: PROBLEM_LABELS.status_rented,
        detail: `Maschine ${machine.machineCode} ist aktuell vermietet.`,
        warningOnly: false,
      });
    }

    const overrideDescriptors = problems.filter((p) => !p.warningOnly).map((p) => p.descriptor);
    return {
      machineId: machine.id,
      machineCode: machine.machineCode,
      productMatches: machine.productId === assignment.productId,
      problems,
      hardBlocked,
      overrideRequired: !hardBlocked && overrideDescriptors.length > 0,
      situationFingerprint: fingerprintOf(overrideDescriptors),
    };
  }

  /** Vorschlagsliste (Order §6) auf Basis der Phase-5-Logik + Problemlage. */
  async suggestionForSlot(
    assignmentId: string,
    now = new Date(),
  ): Promise<{
    preferredBasis: string | null;
    entries: SuggestionEntryView[];
    warnings: string[];
  }> {
    const assignment = await this.assignmentById(assignmentId);
    const live = await this.rentalIntervalFor(assignment.bookingId);
    const interval =
      live.from !== null && live.to !== null ? { from: live.from, to: live.to } : null;
    const suggestion = await this.availability.suggestMachines(assignment.productId, interval, now);
    const all =
      suggestion.preferred === null
        ? suggestion.others
        : [suggestion.preferred, ...suggestion.others];
    const evaluated: {
      entry: (typeof all)[number];
      evaluation: MachineEvaluation;
      locationNote: string | null;
      index: number;
    }[] = [];
    for (const [index, entry] of all.entries()) {
      const evaluation = await this.evaluateMachine(entry.machineId, assignment, now);
      const machineRows = await this.db
        .select({ locationNote: machines.locationNote })
        .from(machines)
        .where(eq(machines.id, entry.machineId));
      evaluated.push({
        entry,
        evaluation,
        locationNote: machineRows[0]?.locationNote ?? null,
        index,
      });
    }
    // Wählbare Maschinen zuerst (stabil in der Phase-5-Reihenfolge: ältestes
    // bekanntes Kaufdatum, dann Maschinen-ID), Override-pflichtige danach,
    // physisch nicht verfügbare zuletzt. Bevorzugt ist die erste ohne
    // Konflikt – nie eine, die einen Override bräuchte.
    const rank = (item: (typeof evaluated)[number]) =>
      item.evaluation.hardBlocked ? 2 : item.evaluation.overrideRequired ? 1 : 0;
    const ordered = [...evaluated].sort((a, b) => rank(a) - rank(b) || a.index - b.index);
    const preferred = ordered.find((item) => rank(item) === 0) ?? null;
    const preferredBasis =
      preferred === null
        ? null
        : preferred.entry.machineId === suggestion.preferred?.machineId
          ? suggestion.preferredBasis
          : `${suggestion.preferredBasis ?? 'Reihenfolge nach Kaufdatum und Maschinen-ID'} – nächste Maschine ohne Konflikt`;
    const entries: SuggestionEntryView[] = ordered.map(({ entry, evaluation, locationNote }) => {
      const isPreferred = preferred?.entry.machineId === entry.machineId;
      return {
        machineId: entry.machineId,
        machineCode: entry.machineCode,
        status: entry.status,
        statusLabel: entry.statusLabel,
        locationKind: entry.locationKind,
        locationLabel: MACHINE_LOCATION_LABELS[entry.locationKind],
        locationNote,
        purchaseDate: entry.purchaseDate,
        preferred: isPreferred,
        preferredBasis: isPreferred ? preferredBasis : null,
        eligibility: evaluation.hardBlocked
          ? 'override_required'
          : evaluation.overrideRequired
            ? 'override_required'
            : entry.eligibility === 'warning' || evaluation.problems.length > 0
              ? 'warning'
              : 'eligible',
        problems: evaluation.problems,
        hardBlocked: evaluation.hardBlocked,
        overrideRequired: evaluation.overrideRequired,
      };
    });
    return { preferredBasis, entries, warnings: suggestion.warnings };
  }

  // ── Zuweisung / Override / Lösen (Order §§5–8, 50) ──────────────────────

  private async lockAssignment(
    tx: DatabaseTransaction,
    assignmentId: string,
  ): Promise<MachineAssignment> {
    const rows = await tx
      .select()
      .from(machineAssignments)
      .where(eq(machineAssignments.id, assignmentId))
      .for('no key update');
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Zuordnung nicht gefunden.');
    return row;
  }

  /** Advisory-Locks aller beteiligten Maschinen in sortierter Reihenfolge (Deadlock-frei). */
  private async lockMachines(
    tx: DatabaseTransaction,
    machineIds: (string | null)[],
  ): Promise<void> {
    const ids = [...new Set(machineIds.filter((id): id is string => id !== null))].sort();
    for (const id of ids) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'machine-assign:' + id}))`);
    }
  }

  private async assertBookingOperational(
    tx: DatabaseTransaction,
    processId: string,
  ): Promise<void> {
    const rows = await tx.select().from(processes).where(eq(processes.id, processId));
    const process = rows[0];
    if (process === undefined) throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
    if (process.mainStatus === 'cancelled') {
      throw new AuthError('CONFLICT', 'Der Vorgang ist storniert.');
    }
    if (process.mainStatus === 'completed') {
      throw new AuthError(
        'CONFLICT',
        'Der Vorgang ist bereits abgeschlossen – bitte zuerst wieder öffnen.',
      );
    }
  }

  /**
   * Andere Zuordnungen, die dieselbe Maschine vorbereitet haben? Dann darf
   * der Status „Reserviert“ nicht zurückgesetzt werden (Order §11: kein
   * anderer aktueller Fachzustand steht entgegen).
   */
  private async otherPreparedExists(
    tx: DatabaseTransaction,
    machineId: string,
    exceptAssignmentId: string,
  ): Promise<boolean> {
    const rows = await tx
      .select({ id: machineAssignments.id })
      .from(machineAssignments)
      .where(
        and(
          eq(machineAssignments.machineId, machineId),
          ne(machineAssignments.id, exceptAssignmentId),
          eq(machineAssignments.status, 'prepared'),
        ),
      );
    return rows.length > 0;
  }

  async assign(
    actorId: string,
    effective: ReadonlySet<string>,
    assignmentId: string,
    machineId: string,
    override: { reason: string } | null,
    now = new Date(),
  ): Promise<AssignmentView> {
    const evidenceKeys: string[] = [];
    const result = await this.db.transaction(async (tx) => {
      // Einheitliche Sperrreihenfolge (deadlock-frei, wie prepare/release/
      // finalize): erst die Slot-Zeile, dann die Advisory-Locks ALLER
      // beteiligten Maschinen (bisherige + neue, sortiert).
      const assignment = await this.lockAssignment(tx, assignmentId);
      await this.lockMachines(tx, [assignment.machineId, machineId]);
      await this.assertBookingOperational(tx, assignment.processId);
      if (assignment.status === 'issued' || assignment.status === 'returned') {
        throw new AuthError('CONFLICT', 'Diese Zuordnung ist bereits ausgegeben.');
      }
      // Dieselbe physische Maschine kann nicht zwei Slots derselben Buchung
      // besetzen (Order §4: je Maschine eine eigene Zeile) – kein Override.
      const sisters = await tx
        .select({ slotNo: machineAssignments.slotNo })
        .from(machineAssignments)
        .where(
          and(
            eq(machineAssignments.bookingId, assignment.bookingId),
            ne(machineAssignments.id, assignment.id),
            eq(machineAssignments.machineId, machineId),
            ne(machineAssignments.status, 'open'),
          ),
        );
      if (sisters[0] !== undefined) {
        throw new AuthError(
          'VALIDATION',
          `Diese Maschine ist bereits Maschine ${sisters[0].slotNo} dieser Buchung zugeordnet – bitte je Slot eine eigene Maschine wählen.`,
        );
      }
      const interval = await this.rentalIntervalFor(assignment.bookingId);
      const candidate = { ...assignment, rentalFrom: interval.from, rentalTo: interval.to };
      const evaluation = await this.evaluateMachine(machineId, candidate, now);
      if (!evaluation.productMatches) {
        throw new AuthError(
          'VALIDATION',
          `Maschine ${evaluation.machineCode} ist nicht vom gebuchten Maschinentyp.`,
        );
      }
      if (evaluation.hardBlocked) {
        throw new AuthError(
          'CONFLICT',
          `Maschine ${evaluation.machineCode} kann nicht zugeordnet werden: ${evaluation.problems
            .filter((p) => p.code === 'issued_elsewhere' || p.code === 'status_rented')
            .map((p) => p.detail)
            .join(' ')} Eine Maschine kann nicht gleichzeitig bei zwei Kunden sein.`,
        );
      }
      let overrideId: string | null = null;
      if (evaluation.overrideRequired) {
        const summary = evaluation.problems
          .filter((p) => !p.warningOnly)
          .map((p) => `${p.label}: ${p.detail}`)
          .join(' ');
        if (override === null) {
          throw new AuthError(
            'CONFLICT',
            `Maschine ${evaluation.machineCode} ist problematisch – ${summary} Eine Zuordnung ist nur mit ausdrücklicher Bestätigung und Grund möglich.`,
          );
        }
        if (!effective.has('machine.override_block')) {
          throw new AuthError(
            'FORBIDDEN',
            'Das Übersteuern problematischer Maschinen erfordert das Recht „Maschinensperre übersteuern“.',
          );
        }
        const reason = override.reason.trim();
        if (reason === '') {
          throw new AuthError('VALIDATION', 'Für einen Override ist ein Grund Pflicht.');
        }
        const inserted = await tx
          .insert(machineAssignmentOverrides)
          .values({
            assignmentId: assignment.id,
            bookingId: assignment.bookingId,
            processId: assignment.processId,
            machineId,
            problemCodes: evaluation.problems
              .filter((p) => !p.warningOnly)
              .map((p) => p.descriptor),
            problemSummary: summary,
            situationFingerprint: evaluation.situationFingerprint,
            reason,
            confirmedBy: actorId,
            confirmedAt: now,
          })
          .returning({ id: machineAssignmentOverrides.id });
        overrideId = inserted[0]?.id ?? null;
      }

      // Vorherige (andere) Maschine sauber freigeben – Prüfung/Fotos der
      // alten Maschine gelten nicht für die neue.
      if (assignment.machineId !== null && assignment.machineId !== machineId) {
        await this.clearHandoverEvidence(tx, assignment.id, evidenceKeys);
        if (
          assignment.status === 'prepared' &&
          !(await this.otherPreparedExists(tx, assignment.machineId, assignment.id))
        ) {
          const previousRows = await tx
            .select({ status: machines.status })
            .from(machines)
            .where(eq(machines.id, assignment.machineId));
          if (previousRows[0]?.status === 'reserved') {
            await this.machineService.applyProcessStatus(
              tx,
              assignment.machineId,
              'ready',
              undefined,
              now,
            );
          }
        }
      }
      // Ein ersetzter Override ist nicht mehr operativ relevant (Order §9).
      if (assignment.overrideId !== null && assignment.overrideId !== overrideId) {
        await tx
          .update(machineAssignmentOverrides)
          .set({ archivedAt: now })
          .where(eq(machineAssignmentOverrides.id, assignment.overrideId));
      }
      const sameMachine = assignment.machineId === machineId;
      await tx
        .update(machineAssignments)
        .set({
          machineId,
          status: sameMachine && assignment.status === 'prepared' ? 'prepared' : 'assigned',
          assignedBy: actorId,
          assignedAt: now,
          rentalFrom: interval.from,
          rentalTo: interval.to,
          overrideId,
          ...(sameMachine && assignment.status === 'prepared'
            ? {}
            : { preparedAt: null, preparedBy: null }),
          releasedAt: null,
          releasedBy: null,
          updatedAt: now,
        })
        .where(eq(machineAssignments.id, assignment.id));
      return assignment.id;
    });
    await this.deleteStorageKeys(evidenceKeys);
    await this.refreshRiskIncidents(now);
    const views = await this.slotsForBooking((await this.assignmentById(result)).bookingId, now);
    return views.find((view) => view.id === result)!;
  }

  /** Zuordnung lösen (Order §50): keine Pflichtbegründung, kein Fachzustand. */
  async release(actorId: string, assignmentId: string, now = new Date()): Promise<AssignmentView> {
    const evidenceKeys: string[] = [];
    const bookingId = await this.db.transaction(async (tx) => {
      const assignment = await this.lockAssignment(tx, assignmentId);
      if (assignment.status === 'issued' || assignment.status === 'returned') {
        throw new AuthError(
          'CONFLICT',
          'Eine ausgegebene Zuordnung kann nicht mehr gelöst werden.',
        );
      }
      await this.releaseWithin(tx, assignment, actorId, now, evidenceKeys);
      return assignment.bookingId;
    });
    await this.deleteStorageKeys(evidenceKeys);
    await this.refreshRiskIncidents(now);
    const views = await this.slotsForBooking(bookingId, now);
    return views.find((view) => view.id === assignmentId)!;
  }

  /**
   * Lösen unter bereits gehaltener Slot-Sperre: Reserviert sauber
   * zurückführen (nur wenn kein anderer vorbereiteter Slot die Maschine
   * hält), Override archivieren, Slot wieder offen. actorId null = System
   * (z. B. Storno des Vorgangs).
   */
  private async releaseWithin(
    tx: DatabaseTransaction,
    assignment: MachineAssignment,
    actorId: string | null,
    now: Date,
    evidenceKeys: string[],
  ): Promise<void> {
    await this.clearHandoverEvidence(tx, assignment.id, evidenceKeys);
    if (assignment.machineId !== null) {
      await this.lockMachines(tx, [assignment.machineId]);
      if (
        assignment.status === 'prepared' &&
        !(await this.otherPreparedExists(tx, assignment.machineId, assignment.id))
      ) {
        const rows = await tx
          .select({ status: machines.status })
          .from(machines)
          .where(eq(machines.id, assignment.machineId));
        if (rows[0]?.status === 'reserved') {
          await this.machineService.applyProcessStatus(
            tx,
            assignment.machineId,
            'ready',
            undefined,
            now,
          );
        }
      }
    }
    if (assignment.overrideId !== null) {
      await tx
        .update(machineAssignmentOverrides)
        .set({ archivedAt: now })
        .where(eq(machineAssignmentOverrides.id, assignment.overrideId));
    }
    await tx
      .update(machineAssignments)
      .set({
        machineId: null,
        status: 'open',
        overrideId: null,
        preparedAt: null,
        preparedBy: null,
        releasedAt: now,
        releasedBy: actorId,
        updatedAt: now,
      })
      .where(eq(machineAssignments.id, assignment.id));
  }

  // ── Vorbereitung / Reserviert (Order §§10/11) ───────────────────────────

  async prepare(actorId: string, assignmentId: string, now = new Date()): Promise<AssignmentView> {
    const bookingId = await this.db.transaction(async (tx) => {
      const assignment = await this.lockAssignment(tx, assignmentId);
      if (assignment.machineId === null || assignment.status === 'open') {
        throw new AuthError('VALIDATION', 'Bitte zuerst eine konkrete Maschine zuweisen.');
      }
      if (assignment.status === 'issued' || assignment.status === 'returned') {
        throw new AuthError('CONFLICT', 'Diese Zuordnung ist bereits ausgegeben.');
      }
      await this.lockMachines(tx, [assignment.machineId]);
      const evaluation = await this.evaluateMachine(assignment.machineId, assignment, now);
      if (evaluation.hardBlocked) {
        throw new AuthError(
          'CONFLICT',
          `Maschine ${evaluation.machineCode} ist an einen anderen Vorgang ausgegeben und kann nicht vorbereitet werden.`,
        );
      }
      const rows = await tx
        .select({ status: machines.status })
        .from(machines)
        .where(eq(machines.id, assignment.machineId));
      // Reserviert nur aus Einsatzbereit heraus; Problemstatus (Override)
      // wird nicht überschrieben (kein Status-Race, Order §11).
      if (rows[0]?.status === 'ready') {
        await this.machineService.applyProcessStatus(
          tx,
          assignment.machineId,
          'reserved',
          undefined,
          now,
        );
      }
      await tx
        .update(machineAssignments)
        .set({ status: 'prepared', preparedAt: now, preparedBy: actorId, updatedAt: now })
        .where(eq(machineAssignments.id, assignment.id));
      return assignment.bookingId;
    });
    const views = await this.slotsForBooking(bookingId, now);
    return views.find((view) => view.id === assignmentId)!;
  }

  async unprepare(
    actorId: string,
    assignmentId: string,
    now = new Date(),
  ): Promise<AssignmentView> {
    const bookingId = await this.db.transaction(async (tx) => {
      const assignment = await this.lockAssignment(tx, assignmentId);
      if (assignment.status !== 'prepared' || assignment.machineId === null) {
        throw new AuthError('CONFLICT', 'Diese Zuordnung ist nicht vorbereitet.');
      }
      await this.lockMachines(tx, [assignment.machineId]);
      if (!(await this.otherPreparedExists(tx, assignment.machineId, assignment.id))) {
        const rows = await tx
          .select({ status: machines.status })
          .from(machines)
          .where(eq(machines.id, assignment.machineId));
        if (rows[0]?.status === 'reserved') {
          await this.machineService.applyProcessStatus(
            tx,
            assignment.machineId,
            'ready',
            undefined,
            now,
          );
        }
      }
      await tx
        .update(machineAssignments)
        .set({ status: 'assigned', preparedAt: null, preparedBy: null, updatedAt: now })
        .where(eq(machineAssignments.id, assignment.id));
      void actorId;
      return assignment.bookingId;
    });
    const views = await this.slotsForBooking(bookingId, now);
    return views.find((view) => view.id === assignmentId)!;
  }

  // ── Override-Liste (Order §9) ───────────────────────────────────────────

  async listOverrides(): Promise<
    {
      id: string;
      machineCode: string;
      processId: string;
      processNumber: string;
      reason: string;
      problemSummary: string;
      confirmedByName: string | null;
      confirmedAt: string;
    }[]
  > {
    const rows = await this.db
      .select({
        override: machineAssignmentOverrides,
        machineCode: machines.machineCode,
        processNumber: processes.processNumber,
        firstName: staffUsers.firstName,
        lastName: staffUsers.lastName,
      })
      .from(machineAssignmentOverrides)
      .innerJoin(machines, eq(machines.id, machineAssignmentOverrides.machineId))
      .innerJoin(processes, eq(processes.id, machineAssignmentOverrides.processId))
      .leftJoin(staffUsers, eq(staffUsers.id, machineAssignmentOverrides.confirmedBy))
      .where(isNull(machineAssignmentOverrides.archivedAt))
      .orderBy(asc(machineAssignmentOverrides.confirmedAt));
    return rows.map(({ override, machineCode, processNumber, firstName, lastName }) => ({
      id: override.id,
      machineCode,
      processId: override.processId,
      processNumber,
      reason: override.reason,
      problemSummary: override.problemSummary,
      confirmedByName: firstName === null ? null : `${firstName} ${lastName ?? ''}`.trim(),
      confirmedAt: override.confirmedAt.toISOString(),
    }));
  }

  // ── Risiko-Incidents (Order §§45–48) ────────────────────────────────────

  /**
   * Lazy, dedupliziert: für jede zugewiesene/vorbereitete Maschine mit
   * laufendem oder zukünftigem Mietzeitraum entsteht je konkreter,
   * NACH der Zuweisung entstandener Problemursache genau ein offener
   * Incident; behobene Ursachen werden automatisch gelöst. Probleme, die
   * ein Override bewusst abdeckt, sind kein neues Risiko. Scans laufen
   * prozessintern serialisiert; Schreibzugriffe nur unter Advisory-Lock
   * (try-lock: läuft anderswo ein Scan, ist dessen Ergebnis aktuell genug)
   * und die Auto-Auflösung trifft nur Incidents, die VOR Scanbeginn
   * existierten – ein parallel neu entstandener Incident bleibt erhalten.
   */
  async refreshRiskIncidents(now = new Date()): Promise<void> {
    await RISK_REFRESH_MUTEX.run('risk-refresh', async () => {
      await this.releaseCancelledAssignments(now);
      const scanStart = new Date();
      const rows = await this.db
        .select({ assignment: machineAssignments, machine: machines })
        .from(machineAssignments)
        .innerJoin(machines, eq(machines.id, machineAssignments.machineId))
        .innerJoin(processes, eq(processes.id, machineAssignments.processId))
        .where(
          and(
            inArray(machineAssignments.status, ['assigned', 'prepared']),
            ne(processes.mainStatus, 'cancelled'),
          ),
        );
      const desired = new Map<string, { row: (typeof rows)[number]; problem: MachineProblem }>();
      for (const row of rows) {
        const interval = await this.rentalIntervalFor(row.assignment.bookingId);
        if (interval.to !== null && interval.to.getTime() <= now.getTime()) continue;
        const evaluation = await this.evaluateMachine(row.machine.id, row.assignment, now);
        let accepted = new Set<string>();
        if (row.assignment.overrideId !== null) {
          const overrideRows = await this.db
            .select({ problemCodes: machineAssignmentOverrides.problemCodes })
            .from(machineAssignmentOverrides)
            .where(eq(machineAssignmentOverrides.id, row.assignment.overrideId));
          const codes = overrideRows[0]?.problemCodes;
          if (Array.isArray(codes))
            accepted = new Set(codes.filter((c): c is string => typeof c === 'string'));
        }
        for (const problem of evaluation.problems) {
          if (problem.warningOnly) continue;
          if (problem.code === 'collision' || problem.code === 'issued_elsewhere') continue;
          if (accepted.has(problem.descriptor)) continue;
          const fingerprint = `risk:${row.assignment.id}:${row.machine.id}:${problem.descriptor}`;
          desired.set(fingerprint, { row, problem });
        }
      }
      await this.db.transaction(async (tx) => {
        const lock = await tx.execute<{ locked: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(hashtext('machine-risk-refresh')) AS locked`,
        );
        if (lock.rows[0]?.locked !== true) return;
        // Admin „Geprüft“ (Order §47) gilt, solange DIESELBE Problemlage
        // besteht; verschwindet sie, wird der Fall geschlossen – ein späteres
        // erneutes Auftreten ist ein neuer Incident.
        const acknowledged = await tx
          .select()
          .from(machineRiskIncidents)
          .where(eq(machineRiskIncidents.resolution, 'acknowledged'));
        const suppressed = new Set<string>();
        for (const incident of acknowledged) {
          if (desired.has(incident.fingerprint)) {
            suppressed.add(incident.fingerprint);
          } else {
            await tx
              .update(machineRiskIncidents)
              .set({ resolution: 'acknowledged_cleared' })
              .where(eq(machineRiskIncidents.id, incident.id));
          }
        }
        // Neue Incidents (Unique auf offenem Fingerprint macht Races unschädlich).
        for (const [fingerprint, { row, problem }] of desired) {
          if (suppressed.has(fingerprint)) continue;
          await tx
            .insert(machineRiskIncidents)
            .values({
              machineId: row.machine.id,
              assignmentId: row.assignment.id,
              bookingId: row.assignment.bookingId,
              processId: row.assignment.processId,
              reasonKind: problem.code === 'blocked' ? 'block' : 'status',
              reasonText: `${problem.label}: ${problem.detail}`,
              fingerprint,
              adminNotificationDueAt: now,
            })
            .onConflictDoNothing({
              target: machineRiskIncidents.fingerprint,
              where: sql`"resolved_at" IS NULL`,
            });
        }
        // Automatische Auflösung: offene Incidents ohne aktuelle Ursache –
        // nur solche, die vor Scanbeginn existierten.
        const open = await tx
          .select()
          .from(machineRiskIncidents)
          .where(
            and(
              isNull(machineRiskIncidents.resolvedAt),
              sql`${machineRiskIncidents.createdAt} < ${scanStart}`,
            ),
          );
        const stale = open.filter((incident) => !desired.has(incident.fingerprint));
        if (stale.length > 0) {
          await tx
            .update(machineRiskIncidents)
            .set({ resolvedAt: now, resolution: 'auto' })
            .where(
              and(
                inArray(
                  machineRiskIncidents.id,
                  stale.map((incident) => incident.id),
                ),
                isNull(machineRiskIncidents.resolvedAt),
              ),
            );
        }
      });
    });
  }

  /**
   * Storno eines Vorgangs (Phase 2) löst dessen noch nicht ausgegebene
   * Zuordnungen systemseitig: Reserviert wird sauber zurückgeführt, es
   * entstehen keine Phantom-Kollisionen oder Risikohinweise (Order §11).
   */
  private async releaseCancelledAssignments(now: Date): Promise<void> {
    const rows = await this.db
      .select({ id: machineAssignments.id })
      .from(machineAssignments)
      .innerJoin(processes, eq(processes.id, machineAssignments.processId))
      .where(
        and(
          inArray(machineAssignments.status, ['assigned', 'prepared']),
          eq(processes.mainStatus, 'cancelled'),
        ),
      );
    for (const row of rows) {
      const evidenceKeys: string[] = [];
      await this.db.transaction(async (tx) => {
        const assignment = await this.lockAssignment(tx, row.id);
        if (assignment.status !== 'assigned' && assignment.status !== 'prepared') return;
        await this.releaseWithin(tx, assignment, null, now, evidenceKeys);
      });
      await this.deleteStorageKeys(evidenceKeys);
    }
  }

  async listOpenIncidents(now = new Date()): Promise<RiskIncidentView[]> {
    await this.refreshRiskIncidents(now);
    const rows = await this.db
      .select({
        incident: machineRiskIncidents,
        machineCode: machines.machineCode,
        processNumber: processes.processNumber,
      })
      .from(machineRiskIncidents)
      .innerJoin(machines, eq(machines.id, machineRiskIncidents.machineId))
      .innerJoin(processes, eq(processes.id, machineRiskIncidents.processId))
      .where(isNull(machineRiskIncidents.resolvedAt))
      .orderBy(asc(machineRiskIncidents.createdAt));
    return rows.map(({ incident, machineCode, processNumber }) => ({
      id: incident.id,
      machineId: incident.machineId,
      machineCode,
      assignmentId: incident.assignmentId,
      bookingId: incident.bookingId,
      processId: incident.processId,
      processNumber,
      reasonKind: incident.reasonKind,
      reasonText: incident.reasonText,
      createdAt: incident.createdAt.toISOString(),
      adminNotifiedAt: incident.adminNotifiedAt?.toISOString() ?? null,
      followUpDueAt: incident.followUpDueAt?.toISOString() ?? null,
      followUpSentAt: incident.followUpSentAt?.toISOString() ?? null,
    }));
  }

  /** Admin „Geprüft“ (Order §47) – kein Pflichtgrund. */
  async acknowledgeIncident(actorId: string, incidentId: string, now = new Date()): Promise<void> {
    const updated = await this.db
      .update(machineRiskIncidents)
      .set({ resolvedAt: now, resolvedBy: actorId, resolution: 'acknowledged' })
      .where(and(eq(machineRiskIncidents.id, incidentId), isNull(machineRiskIncidents.resolvedAt)))
      .returning({ id: machineRiskIncidents.id });
    if (updated.length === 0) {
      const rows = await this.db
        .select({ id: machineRiskIncidents.id })
        .from(machineRiskIncidents)
        .where(eq(machineRiskIncidents.id, incidentId));
      if (rows.length === 0) throw new AuthError('NOT_FOUND', 'Hinweis nicht gefunden.');
      throw new AuthError('CONFLICT', 'Dieser Hinweis ist bereits erledigt.');
    }
  }

  /** Push-Datengrundlage (Order §46): fällige erste Admin-Benachrichtigungen. */
  async listDueAdminNotifications(now = new Date()): Promise<MachineRiskIncident[]> {
    return this.db
      .select()
      .from(machineRiskIncidents)
      .where(
        and(
          isNull(machineRiskIncidents.resolvedAt),
          isNull(machineRiskIncidents.adminNotifiedAt),
          sql`${machineRiskIncidents.adminNotificationDueAt} <= ${now}`,
        ),
      );
  }

  /** Phase 12 markiert den Versand; hier nur die Zustandsgrundlage. */
  async markAdminNotified(incidentId: string, at = new Date()): Promise<void> {
    await this.db
      .update(machineRiskIncidents)
      .set({ adminNotifiedAt: at, followUpDueAt: new Date(at.getTime() + FOLLOW_UP_DELAY_MS) })
      .where(
        and(eq(machineRiskIncidents.id, incidentId), isNull(machineRiskIncidents.adminNotifiedAt)),
      );
  }

  /** Genau EIN Follow-up ≥ 6 h nach der ersten Benachrichtigung (Order §48). */
  async listDueFollowUps(now = new Date()): Promise<MachineRiskIncident[]> {
    return this.db
      .select()
      .from(machineRiskIncidents)
      .where(
        and(
          isNull(machineRiskIncidents.resolvedAt),
          isNull(machineRiskIncidents.followUpSentAt),
          sql`${machineRiskIncidents.followUpDueAt} IS NOT NULL AND ${machineRiskIncidents.followUpDueAt} <= ${now}`,
        ),
      );
  }

  async markFollowUpSent(incidentId: string, at = new Date()): Promise<void> {
    await this.db
      .update(machineRiskIncidents)
      .set({ followUpSentAt: at })
      .where(
        and(eq(machineRiskIncidents.id, incidentId), isNull(machineRiskIncidents.followUpSentAt)),
      );
  }
}
