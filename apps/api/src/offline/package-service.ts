import { createHash, randomUUID } from 'node:crypto';
import type { AppConfig } from '@mietroyal/config';
import {
  appointments,
  bookings,
  deliveryNoteItems,
  deliveryNotes,
  documents,
  machineAssignments,
  processes,
  products,
  type Booking,
  type Database,
  type Process,
} from '@mietroyal/database';
import { berlinDateOf } from '@mietroyal/domain';
import type {
  OfflineBookingRelevance,
  OfflineBookingSnapshot,
  OfflineCandidateMachine,
  OfflineDocumentPayload,
  OfflineDocumentReference,
  OfflineExistingDamage,
  OfflineMachineSnapshot,
  OfflinePackage,
  OfflineReturnSeed,
  PackageRequestInput,
} from '@mietroyal/offline/shared';
import type { PermissionKey } from '@mietroyal/permissions';
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { AuthError, type AuthenticatedContext, type StaffAuthService } from '../auth/service.ts';
import type { DocumentService } from '../commerce/document-service.ts';
import { getCompletedVisibilityDays } from '../crm/settings-service.ts';
import {
  buildVisibilityContext,
  isProcessVisible,
  type ProcessVisibilityContext,
} from '../crm/visibility.ts';
import { fingerprintOf, type AssignmentService } from '../handover/assignment-service.ts';
import type { ExistingDamageSnapshot, HandoverDetailView } from '../handover/handover-service.ts';
import type { HandoverService } from '../handover/handover-service.ts';
import type { DamageService } from '../returns/damage-service.ts';
import type { ReturnDetailView, ReturnService } from '../returns/return-service.ts';
import { effectiveAssigneeForAppointment, loadSubstitutions } from '../scheduling/assignee.ts';
import type { InventoryService } from '../warehouse/inventory-service.ts';
import type { MachineService } from '../warehouse/machine-service.ts';
import type { OfflineLeaseService } from './lease-service.ts';

/**
 * Offline-Arbeitspaket (Phase-8-Order §§9–12, 54): die serverseitige
 * Boundary, die Rechte und Phase-2-Sichtbarkeit anwendet und je Vorgang nur
 * das Nötige liefert – Übergabe-Detail, Rückgabe-Seed, Kandidaten-Maschinen
 * mit Problemlage, bestehende Schäden, neueste Dokumente je Typ und minimale
 * Kontaktdaten. Keine E-Mail-, Admin- oder Finanz-/Abrechnungsdaten (§11).
 * Das Paket ist eine temporäre Arbeitskopie – PostgreSQL bleibt die
 * Autorität; nichts hier erzeugt Fachwirkung.
 */

/** Horizont: heute ±3 Berliner Kalendertage (§9). */
export const OFFLINE_HORIZON_DAYS = 3;
/** Deckel je Paket (§10) – darüber `truncated`. */
export const OFFLINE_MAX_BOOKINGS = 60;

/** Dokumenttypen je Sicht (§12): Übergabe- bzw. Rückgabedokumente. */
const HANDOVER_DOCUMENT_TYPES = ['delivery_note', 'handover_protocol'] as const;
const RETURN_DOCUMENT_TYPES = ['return_protocol'] as const;

/** Paketabruf/Sync ohne aktives Lease (Order §8) – der Client muss online neu autorisieren. */
export class OfflineLeaseRequiredError extends Error {
  constructor() {
    super(
      'Für dieses Gerät besteht keine gültige Offline-Berechtigung – bitte online neu anmelden.',
    );
    this.name = 'OfflineLeaseRequiredError';
  }
}

export interface OfflinePackageDeps {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  handover: HandoverService;
  returns: ReturnService;
  assignments: AssignmentService;
  damages: DamageService;
  machines: MachineService;
  inventory: InventoryService;
  documents: DocumentService;
  leases: OfflineLeaseService;
}

export type OfflineBookingSnapshotView = OfflineBookingSnapshot<
  HandoverDetailView,
  ReturnDetailView
>;
export type OfflinePackageView = OfflinePackage<HandoverDetailView, ReturnDetailView>;

interface Rights {
  effective: ReadonlySet<PermissionKey>;
  visibility: ProcessVisibilityContext;
  handover: boolean;
  returns: boolean;
  machines: boolean;
  inventory: boolean;
}

interface Candidate {
  bookingId: string;
  relevance: Set<OfflineBookingRelevance>;
  days: Set<string>;
  /** Sortierschlüssel: erster relevanter Tag. */
  firstDay: string;
}

/** Berliner Kalendertag ± Tage (DST-unabhängig, wie ReturnService.listOpen). */
function shiftDay(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

function toExistingDamage(damage: ExistingDamageSnapshot): OfflineExistingDamage {
  return {
    id: damage.id,
    productSlug: damage.productSlug ?? '',
    severity: damage.severity,
    severityLabel: damage.severityLabel,
    description: damage.description,
    createdAt: damage.createdAt,
    markers: damage.markers.map((marker) => ({
      view: marker.view,
      markerType: marker.markerType,
      x: marker.x,
      y: marker.y,
      width: marker.width,
      height: marker.height,
    })),
    summary: damage.summary,
  };
}

export class OfflinePackageService {
  constructor(private readonly deps: OfflinePackageDeps) {}

  private async rightsFor(context: AuthenticatedContext, now: Date): Promise<Rights> {
    const effective = await this.deps.auth.effectivePermissions(context.user.id);
    const visibility = buildVisibilityContext(
      effective,
      await getCompletedVisibilityDays(this.deps.db),
      now,
    );
    const viewAll = effective.has('process.view_all');
    return {
      effective,
      visibility,
      handover: viewAll && effective.has('handover.view'),
      returns: viewAll && effective.has('return.view'),
      machines: effective.has('machine.view'),
      inventory: effective.has('inventory.view'),
    };
  }

  /**
   * Arbeitspaket bauen: nur mit aktivem Lease (§8). Kandidaten kommen aus den
   * bestehenden Listen (Ausgabe je Tag, offene Rückgaben) plus bewusst
   * geöffneten Vorgängen (`extraBookingIds`, gleiche Rechteprüfung).
   */
  async build(
    context: AuthenticatedContext,
    input: PackageRequestInput,
    now = new Date(),
  ): Promise<OfflinePackageView> {
    this.deps.leases.assertEnvironment(input.environment);
    const lease = await this.deps.leases.activeLease(context.user.id, input.deviceId, now);
    if (lease === null) throw new OfflineLeaseRequiredError();
    const rights = await this.rightsFor(context, now);

    const today = berlinDateOf(now);
    const days: string[] = [];
    for (let offset = -OFFLINE_HORIZON_DAYS; offset <= OFFLINE_HORIZON_DAYS; offset += 1) {
      days.push(shiftDay(today, offset));
    }
    const horizonFrom = days[0]!;
    const horizonTo = days[days.length - 1]!;

    const candidates = new Map<string, Candidate>();
    const add = (bookingId: string, relevance: OfflineBookingRelevance, day: string) => {
      const existing = candidates.get(bookingId);
      if (existing === undefined) {
        candidates.set(bookingId, {
          bookingId,
          relevance: new Set([relevance]),
          days: new Set([day]),
          firstDay: day,
        });
        return;
      }
      existing.relevance.add(relevance);
      existing.days.add(day);
      if (day < existing.firstDay) existing.firstDay = day;
    };

    if (rights.handover) {
      for (const day of days) {
        for (const entry of await this.deps.handover.listForDay(day, rights.visibility)) {
          add(entry.bookingId, 'handover', day);
        }
      }
    }
    if (rights.returns) {
      // Aktive Vermietungen (ausgegebene Maschinen) inkl. überfälliger Rückgaben (§9).
      for (const entry of await this.deps.returns.listOpen(rights.visibility, now)) {
        const plannedDay =
          entry.plannedAt === null ? null : berlinDateOf(new Date(entry.plannedAt));
        const day =
          plannedDay !== null && plannedDay >= horizonFrom && plannedDay <= horizonTo
            ? plannedDay
            : today;
        add(entry.bookingId, 'active', day);
        add(entry.bookingId, 'return', day);
        if (entry.overdue) add(entry.bookingId, 'overdue', day);
      }
    }
    for (const bookingId of input.extraBookingIds ?? []) {
      if (candidates.has(bookingId)) {
        candidates.get(bookingId)!.relevance.add('extra');
        continue;
      }
      const visible = await this.visibleBooking(bookingId, rights);
      if (visible !== null) add(bookingId, 'extra', today);
    }

    const ordered = [...candidates.values()].sort(
      (a, b) => a.firstDay.localeCompare(b.firstDay) || a.bookingId.localeCompare(b.bookingId),
    );
    const truncated = ordered.length > OFFLINE_MAX_BOOKINGS;
    const selected = ordered.slice(0, OFFLINE_MAX_BOOKINGS);

    const bookingSnapshots: OfflineBookingSnapshotView[] = [];
    const documentPayloads: OfflineDocumentPayload[] = [];
    const includeDocuments = input.includeDocuments !== false;
    for (const candidate of selected) {
      const loaded = await this.visibleBooking(candidate.bookingId, rights);
      if (loaded === null) continue;
      const snapshot = await this.snapshotOf(
        loaded.booking,
        loaded.process,
        rights,
        [...candidate.relevance],
        [...candidate.days].sort(),
        now,
      );
      bookingSnapshots.push(snapshot);
      if (includeDocuments) {
        documentPayloads.push(...(await this.documentPayloads(snapshot)));
      }
    }

    const machines = rights.machines ? await this.machineSnapshots() : [];
    const inventory = rights.inventory ? await this.deps.inventory.listItems() : null;
    await this.deps.leases.touchPackage(lease.id, now);

    return {
      packageId: randomUUID(),
      environment: this.deps.config.appEnv,
      serverTime: now.toISOString(),
      horizonFrom,
      horizonTo,
      expiresAt: lease.expiresAt.toISOString(),
      truncated,
      user: {
        id: context.user.id,
        firstName: context.user.firstName,
        lastName: context.user.lastName,
      },
      permissions: this.deps.leases.offlinePermissions(rights.effective),
      lease: { leaseId: lease.id, expiresAt: lease.expiresAt.toISOString() },
      bookings: bookingSnapshots,
      machines,
      inventory,
      documents: documentPayloads,
    };
  }

  /**
   * Einzelner Vorgangs-Snapshot (Serverstand laden / Konfliktprüfung):
   * gleiche Rechte- und Sichtbarkeitsregel wie das Paket; unsichtbar ⇒
   * neutrales NOT_FOUND (IDOR-Schutz, §57/§88).
   */
  async bookingSnapshotFor(
    context: AuthenticatedContext,
    bookingId: string,
    now = new Date(),
  ): Promise<{
    booking: OfflineBookingSnapshotView;
    documents: OfflineDocumentPayload[];
    serverTime: string;
  }> {
    const rights = await this.rightsFor(context, now);
    const loaded = await this.visibleBooking(bookingId, rights);
    if (loaded === null) throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
    const snapshot = await this.snapshotOf(
      loaded.booking,
      loaded.process,
      rights,
      ['extra'],
      [berlinDateOf(now)],
      now,
    );
    return {
      booking: snapshot,
      documents: await this.documentPayloads(snapshot),
      serverTime: now.toISOString(),
    };
  }

  /** Buchung + Vorgang laden, sofern operativ berechtigt und sichtbar (Phase-2-Regel). */
  private async visibleBooking(
    bookingId: string,
    rights: Rights,
  ): Promise<{ booking: Booking; process: Process } | null> {
    if (!rights.handover && !rights.returns) return null;
    const rows = await this.deps.db
      .select({ booking: bookings, process: processes })
      .from(bookings)
      .innerJoin(processes, eq(processes.id, bookings.processId))
      .where(eq(bookings.id, bookingId));
    const row = rows[0];
    if (row === undefined) return null;
    if (!isProcessVisible(row.process, rights.visibility)) return null;
    return row;
  }

  private async snapshotOf(
    booking: Booking,
    process: Process,
    rights: Rights,
    relevance: OfflineBookingRelevance[],
    days: string[],
    now: Date,
  ): Promise<OfflineBookingSnapshotView> {
    const bookingId = booking.id;
    const customer = booking.customerSnapshot as Record<string, unknown>;
    const delivery = (booking.deliverySnapshot ?? {}) as Record<string, unknown>;

    // Termine mit Versionszähler (Basisstand für APPOINTMENT_CHANGED) und
    // effektiver Zuständigkeit inkl. Vertretung (Phase 2/4).
    const substitutions = await loadSubstitutions(this.deps.db);
    const appointmentRows = await this.deps.db
      .select()
      .from(appointments)
      .where(and(eq(appointments.bookingId, bookingId), ne(appointments.status, 'cancelled')))
      .orderBy(asc(appointments.createdAt));
    const appointmentSnapshots = appointmentRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      version: row.version,
      startAt: row.startAt?.toISOString() ?? null,
      endAt: row.endAt?.toISOString() ?? null,
      assignedUserId: row.assignedUserId,
      effectiveAssigneeId: effectiveAssigneeForAppointment(row, substitutions, now),
    }));

    let handover: HandoverDetailView | null = null;
    if (rights.handover) {
      try {
        const detail = await this.deps.handover.detail(bookingId, now);
        // Datenminimierung (§11): keine E-Mail-Adresse im Offline-Paket.
        handover = { ...detail, booking: { ...detail.booking, customerEmail: null } };
      } catch (error) {
        if (!(error instanceof AuthError)) throw error;
        handover = null;
      }
    }

    let returnView: ReturnDetailView | null = null;
    let returnStartable = false;
    let returnSeed: OfflineReturnSeed | null = null;
    if (rights.returns) {
      const existing = await this.deps.returns.returnFor(bookingId);
      if (existing !== null) {
        const detail = await this.deps.returns.detail(bookingId, now);
        returnView = { ...detail, booking: { ...detail.booking, customerEmail: null } };
      } else {
        const seed = await this.returnSeedFor(bookingId);
        if (seed.machines.length > 0) {
          returnStartable = true;
          returnSeed = seed;
        }
      }
    }

    // Kandidaten-Maschinen je noch nicht ausgegebenem Slot (§§16/17) mit Problemlage.
    const candidateMachines: Record<string, OfflineCandidateMachine[]> = {};
    if (handover !== null && rights.effective.has('machine.assign')) {
      for (const slot of handover.slots) {
        if (slot.status === 'issued' || slot.status === 'returned') continue;
        candidateMachines[slot.id] = await this.candidatesFor(slot.id, now);
      }
    }

    // Bestehende Schäden der zugeordneten Maschinen (§35: Schema + Text, keine Fotos).
    const machineIds = new Set<string>();
    for (const slot of handover?.slots ?? [])
      if (slot.machine !== null) machineIds.add(slot.machine.id);
    for (const machine of returnView?.machines ?? []) machineIds.add(machine.machineId);
    for (const machine of returnSeed?.machines ?? []) machineIds.add(machine.machineId);
    const existingDamages: Record<string, OfflineExistingDamage[]> = {};
    for (const machineId of machineIds) {
      existingDamages[machineId] = (await this.deps.damages.existingDamagesFor(machineId)).map(
        toExistingDamage,
      );
    }

    const deliveryAddressLines: string[] = [];
    if (booking.fulfillment === 'delivery') {
      const street = String(delivery.street ?? '');
      const cityLine = [delivery.postalCode, delivery.city].filter(Boolean).join(' ');
      if (street !== '') deliveryAddressLines.push(street);
      if (cityLine !== '') deliveryAddressLines.push(cityLine);
    }

    return {
      bookingId,
      processId: booking.processId,
      processNumber: process.processNumber,
      snapshotAt: now.toISOString(),
      days,
      relevance,
      customer: {
        name: String(customer.displayName ?? '').trim(),
        phone: typeof customer.phone === 'string' && customer.phone !== '' ? customer.phone : null,
        deliveryAddressLines,
      },
      appointments: appointmentSnapshots,
      handover,
      return: returnView,
      returnStartable,
      returnSeed,
      existingDamages,
      candidateMachines,
      documents: await this.documentReferences(bookingId, rights),
    };
  }

  /** Spiegelt, was `ReturnService.start` anlegen würde – ohne zu schreiben. */
  private async returnSeedFor(bookingId: string): Promise<OfflineReturnSeed> {
    const issued = await this.deps.db
      .select({ id: machineAssignments.id, machineId: machineAssignments.machineId })
      .from(machineAssignments)
      .where(
        and(eq(machineAssignments.bookingId, bookingId), eq(machineAssignments.status, 'issued')),
      )
      .orderBy(asc(machineAssignments.slotNo));
    const machines = issued
      .filter((row): row is { id: string; machineId: string } => row.machineId !== null)
      .map((row) => ({ assignmentId: row.id, machineId: row.machineId }));
    const items: OfflineReturnSeed['items'] = [];
    const noteRows = await this.deps.db
      .select({ id: deliveryNotes.id })
      .from(deliveryNotes)
      .where(eq(deliveryNotes.bookingId, bookingId));
    const note = noteRows[0];
    if (note !== undefined) {
      const rows = await this.deps.db
        .select({ item: deliveryNoteItems, category: products.category })
        .from(deliveryNoteItems)
        .leftJoin(products, eq(products.id, deliveryNoteItems.productId))
        .where(eq(deliveryNoteItems.deliveryNoteId, note.id))
        .orderBy(asc(deliveryNoteItems.position));
      for (const { item, category } of rows) {
        if (item.kind === 'purchase') continue;
        if (item.actualQuantity <= 0) continue;
        if (category === 'purchase') continue;
        items.push({
          deliveryNoteItemId: item.id,
          issuedQuantity: item.actualQuantity,
          kind: item.kind,
        });
      }
    }
    return { machines, items };
  }

  /** Vorschlagsliste des Slots mit Problemlage + Fingerprint (Order §§45/49). */
  private async candidatesFor(assignmentId: string, now: Date): Promise<OfflineCandidateMachine[]> {
    const suggestion = await this.deps.assignments.suggestionForSlot(assignmentId, now);
    return suggestion.entries.map((entry) => ({
      machineId: entry.machineId,
      machineCode: entry.machineCode,
      situationFingerprint: fingerprintOf(
        entry.problems.filter((p) => !p.warningOnly).map((p) => p.descriptor),
      ),
      overrideRequired: entry.overrideRequired,
      hardBlocked: entry.hardBlocked,
      problems: entry.problems.map((p) => ({
        code: p.code,
        descriptor: p.descriptor,
        label: p.label,
        detail: p.detail,
        warningOnly: p.warningOnly,
      })),
    }));
  }

  /** Neueste Dokumentreferenz je Typ (nur die Typen der berechtigten Sicht). */
  private async documentReferences(
    bookingId: string,
    rights: Rights,
  ): Promise<OfflineDocumentReference[]> {
    const types: string[] = [];
    if (rights.handover) types.push(...HANDOVER_DOCUMENT_TYPES);
    if (rights.returns) types.push(...RETURN_DOCUMENT_TYPES);
    if (types.length === 0) return [];
    const rows = await this.deps.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.bookingId, bookingId),
          inArray(documents.type, types as (typeof documents.type.enumValues)[number][]),
        ),
      )
      .orderBy(desc(documents.createdAt));
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) if (!latest.has(row.type)) latest.set(row.type, row);
    return [...latest.values()].map((row) => ({
      id: row.id,
      type: row.type,
      createdAt: row.createdAt.toISOString(),
      sha256: row.sha256,
      byteSize: row.byteSize,
    }));
  }

  /** Dokument-Bytes (PDF) zu den Referenzen eines Snapshots – Integrität über sha256. */
  private async documentPayloads(
    snapshot: OfflineBookingSnapshotView,
  ): Promise<OfflineDocumentPayload[]> {
    const result: OfflineDocumentPayload[] = [];
    for (const reference of snapshot.documents) {
      const row = await this.deps.documents.byId(reference.id);
      const bytes = await this.deps.documents.bytesFor(row);
      result.push({
        ...reference,
        byteSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bookingId: snapshot.bookingId,
        dataBase64: Buffer.from(bytes).toString('base64'),
      });
    }
    return result;
  }

  /** Maschinenbasis (machine.view): QR nur als Hash, Status + Reinigungszyklus + aktuelle Schäden. */
  private async machineSnapshots(): Promise<OfflineMachineSnapshot[]> {
    const rows = await this.deps.machines.list();
    const result: OfflineMachineSnapshot[] = [];
    for (const { machine, product } of rows) {
      result.push({
        machineId: machine.id,
        machineCode: machine.machineCode,
        // Der Rohtoken wird nie übertragen (§28); offline wird nur der Hash verglichen.
        qrHash: createHash('sha256').update(machine.qrToken.toLowerCase(), 'utf8').digest('hex'),
        status: machine.status,
        cleaningSince: machine.cleaningSince?.toISOString() ?? null,
        updatedAt: machine.updatedAt.toISOString(),
        machineTypeName: product.name,
        productSlug: product.slug,
        currentDamages: (await this.deps.damages.existingDamagesFor(machine.id)).map(
          toExistingDamage,
        ),
      });
    }
    return result;
  }
}
