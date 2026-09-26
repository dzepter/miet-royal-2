import { createHash, randomBytes } from 'node:crypto';
import {
  appointments,
  bookingPickupRepresentatives,
  bookings,
  deliveryNoteItems,
  deliveryNotes,
  deliveryPackets,
  documents,
  machineAssignmentOverrides,
  machineAssignments,
  machines,
  missingAccessoryCases,
  processes,
  products,
  rentalReturns,
  returnInventoryItems,
  returnMachines,
  returnPhotos,
  returnSignatures,
  staffUsers,
  type Booking,
  type Database,
  type DatabaseExecutor,
  type DatabaseTransaction,
  type MissingAccessoryCase,
  type RentalReturn,
  type ReturnMachine,
} from '@mietroyal/database';
import {
  PhotoImageError,
  renderReturnProtocolPdf,
  SignatureImageError,
  type ReturnProtocolMachineSection,
} from '@mietroyal/documents';
import type { StorageProvider } from '@mietroyal/integrations';
import { and, asc, eq, isNull, lt, ne, sql } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import type { DocumentService } from '../commerce/document-service.ts';
import { visibleProcessesWhere, type ProcessVisibilityContext } from '../crm/visibility.ts';
import type { AssignmentService } from '../handover/assignment-service.ts';
import { KeyedMutex } from '../handover/keyed-mutex.ts';
import {
  embeddablePhotoLooksValid,
  imageExtension,
  signaturePngLooksValid,
  type ImageMimeType,
} from '../handover/media.ts';
import type { SchedulingService } from '../scheduling/scheduling-service.ts';
import type { InventoryService } from '../warehouse/inventory-service.ts';
import { MACHINE_STATUS_LABELS, type MachineService } from '../warehouse/machine-service.ts';
import {
  DamageService,
  postReturnWindowOpen,
  type DamageMarkerInput,
  type DamageView,
} from './damage-service.ts';
import { sketchImagesFor } from './sketch-assets.ts';

/**
 * Zentrale Rückgabegrenze (Phase-7-Order §2): orchestriert Rückgabeperson,
 * Zubehör-/Sauberkeitskontrolle, Reinigungsgebühr-Fakt, Kommissionsrückgabe,
 * Schäden/Fehlteile, Unterschriften, Rückgabeprotokoll und die atomare,
 * idempotente Finalisierung. Bestehende Services (Lager, Maschinen,
 * Dokumente, Terminplanung, Zuordnung, Schäden) werden wiederverwendet – die
 * Rückgabelogik selbst ist NUR hier.
 */

export const CLEANUP_FEE_CENTS = 7500;

export const RETURNER_KIND_LABELS = {
  customer: 'Kunde selbst',
  representative: 'Hinterlegte Abholperson',
  other: 'Sonstige Rückgabeperson',
} as const;

export const ACCESSORY_LABELS: Record<MissingAccessoryCase['accessoryType'], string> = {
  lid: 'Deckel',
  drip_tray: 'Tropfschale',
};

const CLEANLINESS_LABELS = {
  emptied: 'Maschine entleert',
  rinsedTwice: 'Zweimal mit Wasser gespült',
  nothingDismantled: 'Nichts demontiert',
} as const;

const CLEANUP_FAIL_LABELS = {
  emptied: 'nicht entleert',
  rinsedTwice: 'nicht zweimal gespült',
  nothingDismantled: 'Teile demontiert',
} as const;

const PHOTO_MAX_BYTES = 6 * 1024 * 1024;
const CLEANING_WARNING_HOURS = 24;
const RANGE_DAYS = 3;

type ReturnerKind = keyof typeof RETURNER_KIND_LABELS;

export interface ReturnItemView {
  id: string;
  deliveryNoteItemId: string;
  /** null = kein Lagerartikel hinterlegt (Fakten ohne Lagerbewegung). */
  inventoryItemId: string | null;
  kind: 'included' | 'commission' | 'purchase';
  kindLabel: string;
  description: string;
  unit: string;
  issuedQuantity: number;
  returnedUnopenedQuantity: number;
  unitPriceSnapshotCents: number;
  /** Vorläufig (Entwurf berechnet, final eingefroren) – KEINE Settlement-Position. */
  chargeableQuantity: number;
  chargeableAmountCents: number;
}

export interface MissingCaseView {
  id: string;
  returnId: string;
  returnMachineId: string;
  machineId: string;
  machineCode: string;
  processId: string;
  processNumber: string;
  accessoryType: MissingAccessoryCase['accessoryType'];
  accessoryLabel: string;
  missingQuantity: number;
  description: string | null;
  status: MissingAccessoryCase['status'];
  requiresFinancialReview: boolean;
  followUpOpenedAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ReturnMachineView {
  id: string;
  assignmentId: string;
  slotNo: number;
  machineId: string;
  machineCode: string;
  machineStatus: string;
  machineStatusLabel: string;
  typeName: string;
  /** Maschinentyp für die Asset-Schnittstelle des Schadensschemas (Order §30). */
  productSlug: string;
  expectedLids: number;
  expectedDripTrays: number;
  accessoryComplete: boolean | null;
  accessoryCheckedAt: string | null;
  emptied: boolean | null;
  rinsedTwice: boolean | null;
  nothingDismantled: boolean | null;
  cleanlinessCheckedAt: string | null;
  cleanupRequired: boolean;
  cleanupFeeCents: number | null;
  cleanupReason: string | null;
  cleanupPhotos: { id: string; takenAt: string }[];
  damages: DamageView[];
  missingCases: MissingCaseView[];
  returnedAt: string | null;
}

export interface ReturnDetailView {
  booking: {
    id: string;
    processId: string;
    processNumber: string;
    processStatus: string;
    customerName: string;
    customerEmail: string | null;
    fulfillment: Booking['fulfillment'];
    machineTypeName: string | null;
    machineQuantity: number;
  };
  return: {
    id: string;
    status: RentalReturn['status'];
    returnerKind: ReturnerKind | null;
    returnerName: string | null;
    returnerPhone: string | null;
    startedAt: string;
    finalizedAt: string | null;
    draftActualReturnAt: string | null;
    actualReturnAt: string | null;
    originalActualReturnAt: string | null;
    correctedActualReturnAt: string | null;
    correctedAt: string | null;
    protocolDocumentId: string | null;
    appointment: {
      id: string;
      status: string;
      startAt: string | null;
      endAt: string | null;
      overdue: boolean;
    } | null;
  };
  representative: { firstName: string; lastName: string } | null;
  machines: ReturnMachineView[];
  items: ReturnItemView[];
  signatures: {
    customer: { signerName: string; signedAt: string } | null;
    staff: { signerName: string; signedAt: string } | null;
  };
  summary: {
    withoutComplaint: boolean;
    cleanupMachines: number;
    cleanupFeeTotalCents: number;
    damages: number;
    missingCases: number;
    commissionChargeableCents: number;
    lines: string[];
  };
  blockers: string[];
  nextAction: 'returner' | 'checks' | 'sign' | 'finalize' | 'done';
}

export interface ReturnListEntry {
  bookingId: string;
  processId: string;
  processNumber: string;
  customerName: string;
  fulfillment: Booking['fulfillment'];
  machineCodes: string[];
  plannedAt: string | null;
  plannedEndAt: string | null;
  assigneeName: string | null;
  overdue: boolean;
  returnStatus: 'none' | 'draft';
  group: 'overdue' | 'today' | 'upcoming' | 'unscheduled';
}

export interface CleaningWarning {
  machineId: string;
  machineCode: string;
  cleaningSince: string;
  hoursInCleaning: number;
}

function berlin(value: Date | null | undefined): string {
  return value === null || value === undefined
    ? '–'
    : value.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
}

function berlinDayOf(value: Date): string {
  return value.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
}

/** Fachlicher Inhalt, der ins Protokoll einfließt (Phase 1 ↔ Phase 2 Vergleich). */
function finalizationFingerprint(view: ReturnDetailView): string {
  return JSON.stringify({
    returner: [view.return.returnerKind, view.return.returnerName],
    draftActualReturnAt: view.return.draftActualReturnAt,
    machines: view.machines.map((machine) => [
      machine.id,
      machine.machineId,
      machine.accessoryComplete,
      machine.emptied,
      machine.rinsedTwice,
      machine.nothingDismantled,
      machine.cleanupRequired,
      machine.cleanupFeeCents,
      machine.cleanupPhotos.map((photo) => photo.id),
      machine.damages.map((damage) => [
        damage.id,
        damage.severity,
        damage.description,
        damage.markers.map((marker) => marker.id),
        damage.photos.map((photo) => photo.id),
      ]),
      machine.missingCases.map((missing) => [missing.id, missing.missingQuantity]),
    ]),
    items: view.items.map((item) => [item.id, item.returnedUnopenedQuantity]),
  });
}

export class ReturnService {
  private readonly finalizeMutex = new KeyedMutex();

  constructor(
    private readonly db: Database,
    private readonly storage: StorageProvider,
    private readonly inventory: InventoryService,
    private readonly machineService: MachineService,
    private readonly documentService: DocumentService,
    private readonly scheduling: SchedulingService,
    private readonly damages: DamageService,
    private readonly assignments: AssignmentService,
  ) {}

  // ── Laden / Starten (Order §§3/4/6) ──────────────────────────────────────

  async bookingById(bookingId: string, executor: DatabaseExecutor = this.db): Promise<Booking> {
    const rows = await executor.select().from(bookings).where(eq(bookings.id, bookingId));
    const booking = rows[0];
    if (booking === undefined) throw new AuthError('NOT_FOUND', 'Buchung nicht gefunden.');
    return booking;
  }

  async returnFor(
    bookingId: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<RentalReturn | null> {
    const rows = await executor
      .select()
      .from(rentalReturns)
      .where(eq(rentalReturns.bookingId, bookingId));
    return rows[0] ?? null;
  }

  async returnById(returnId: string): Promise<RentalReturn> {
    const rows = await this.db.select().from(rentalReturns).where(eq(rentalReturns.id, returnId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Rückgabe nicht gefunden.');
    return row;
  }

  /** Ausgegebene Zuordnungen (Status issued) einer Buchung. */
  private async issuedAssignments(bookingId: string, executor: DatabaseExecutor) {
    return executor
      .select({ assignment: machineAssignments, machine: machines, product: products })
      .from(machineAssignments)
      .innerJoin(machines, eq(machines.id, machineAssignments.machineId))
      .innerJoin(products, eq(products.id, machineAssignments.productId))
      .where(
        and(eq(machineAssignments.bookingId, bookingId), eq(machineAssignments.status, 'issued')),
      )
      .orderBy(asc(machineAssignments.slotNo));
  }

  async hasIssuedMachines(bookingId: string): Promise<boolean> {
    return (await this.issuedAssignments(bookingId, this.db)).length > 0;
  }

  /**
   * Rückgabe starten (idempotent): nur wenn mindestens eine Maschine
   * tatsächlich ausgegeben ist (Order §4). Legt Abschnitte je ausgegebener
   * Maschine (Zubehör-Soll aus dem Maschinentyp) und die rückgabefähigen
   * Lieferscheinpositionen (inklusive/Kommission mit Lagerartikel, keine
   * Kaufartikel) an – Mengen aus der TATSÄCHLICHEN Ausgabe (Order §25).
   */
  async start(actorId: string, bookingId: string, now = new Date()): Promise<RentalReturn> {
    const booking = await this.bookingById(bookingId);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'return-start:' + bookingId}))`);
      const existing = await this.returnFor(bookingId, tx);
      if (existing !== null) return existing;
      const issued = await this.issuedAssignments(bookingId, tx);
      if (issued.length === 0) {
        throw new AuthError(
          'CONFLICT',
          'Für diese Buchung wurde noch keine Maschine ausgegeben – eine Rückgabe ist erst nach der Ausgabe möglich.',
        );
      }
      const appointmentRows = await tx
        .select()
        .from(appointments)
        .where(
          and(
            eq(appointments.bookingId, bookingId),
            eq(appointments.kind, 'return'),
            ne(appointments.status, 'cancelled'),
          ),
        )
        .orderBy(asc(appointments.createdAt));
      const inserted = await tx
        .insert(rentalReturns)
        .values({
          bookingId,
          processId: booking.processId,
          status: 'draft',
          startedBy: actorId,
          startedAt: now,
          returnAppointmentId: appointmentRows[0]?.id ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const created = inserted[0]!;
      for (const row of issued) {
        const containers = row.product.containerCount ?? 1;
        await tx.insert(returnMachines).values({
          returnId: created.id,
          assignmentId: row.assignment.id,
          machineId: row.machine.id,
          productId: row.product.id,
          expectedLids: containers,
          expectedDripTrays: containers,
          createdAt: now,
          updatedAt: now,
        });
      }
      const noteRows = await tx
        .select()
        .from(deliveryNotes)
        .where(eq(deliveryNotes.bookingId, bookingId));
      const note = noteRows[0];
      if (note !== undefined) {
        const items = await tx
          .select({ item: deliveryNoteItems, product: products })
          .from(deliveryNoteItems)
          .leftJoin(products, eq(products.id, deliveryNoteItems.productId))
          .where(eq(deliveryNoteItems.deliveryNoteId, note.id))
          .orderBy(asc(deliveryNoteItems.position));
        for (const { item, product } of items) {
          if (item.kind === 'purchase') continue; // Kaufartikel bleibt Eigentum des Kunden
          if (item.actualQuantity <= 0) continue;
          if (product !== null && product.category === 'purchase') continue;
          // Auch ohne Lagerartikel (inventoryItemId null) werden die Fakten
          // ausgegeben/ungeöffnet zurück/abrechenbar geführt (Order §22) – nur
          // die Ledger-Bewegung entfällt dann.
          await tx.insert(returnInventoryItems).values({
            returnId: created.id,
            deliveryNoteItemId: item.id,
            inventoryItemId: item.inventoryItemId,
            productId: item.productId,
            kind: item.kind,
            description: item.description,
            unit: item.unit,
            issuedQuantity: item.actualQuantity,
            returnedUnopenedQuantity: 0,
            unitPriceSnapshotCents: item.unitPriceCents,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
      return created;
    });
  }

  /**
   * QR-Einstieg (Order §6): gescannte Maschine → aktuell ausgegebener
   * Vorgang. Ungültiger Code und Maschine ohne offene Ausgabe liefern
   * denselben neutralen Fehler – Rechte werden davon nicht berührt.
   */
  async resolveQr(
    token: string,
  ): Promise<{ bookingId: string; processId: string; processNumber: string; machineCode: string }> {
    const neutral = () =>
      new AuthError('NOT_FOUND', 'Für diesen QR-Code ist kein ausgegebener Vorgang offen.');
    const resolved = await this.machineService.byQrToken(token);
    if (resolved === null) throw neutral();
    const rows = await this.db
      .select({ assignment: machineAssignments, processNumber: processes.processNumber })
      .from(machineAssignments)
      .innerJoin(processes, eq(processes.id, machineAssignments.processId))
      .where(
        and(
          eq(machineAssignments.machineId, resolved.machine.id),
          eq(machineAssignments.status, 'issued'),
        ),
      );
    const row = rows[0];
    if (row === undefined) throw neutral();
    return {
      bookingId: row.assignment.bookingId,
      processId: row.assignment.processId,
      processNumber: row.processNumber,
      machineCode: resolved.machine.machineCode,
    };
  }

  // ── Detailansicht ────────────────────────────────────────────────────────

  async detail(bookingId: string, now = new Date()): Promise<ReturnDetailView> {
    return this.detailWithin(this.db, bookingId, now);
  }

  private async detailWithin(
    executor: DatabaseExecutor,
    bookingId: string,
    now: Date,
  ): Promise<ReturnDetailView> {
    const booking = await this.bookingById(bookingId, executor);
    const ret = await this.returnFor(bookingId, executor);
    if (ret === null) throw new AuthError('NOT_FOUND', 'Rückgabe nicht gefunden.');
    const processRows = await executor
      .select({ processNumber: processes.processNumber, mainStatus: processes.mainStatus })
      .from(processes)
      .where(eq(processes.id, booking.processId));
    const process = processRows[0];
    if (process === undefined) throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
    const customer = booking.customerSnapshot as Record<string, unknown>;
    const machineItem = this.machineItemOf(booking);

    const machineRows = await executor
      .select({
        rm: returnMachines,
        slotNo: machineAssignments.slotNo,
        machine: machines,
        product: products,
      })
      .from(returnMachines)
      .innerJoin(machineAssignments, eq(machineAssignments.id, returnMachines.assignmentId))
      .innerJoin(machines, eq(machines.id, returnMachines.machineId))
      .innerJoin(products, eq(products.id, returnMachines.productId))
      .where(eq(returnMachines.returnId, ret.id))
      .orderBy(asc(machineAssignments.slotNo));
    const photoRows = await executor
      .select()
      .from(returnPhotos)
      .where(eq(returnPhotos.returnId, ret.id))
      .orderBy(asc(returnPhotos.takenAt));
    const damageViews = await this.damages.forReturn(ret.id, executor);
    const missingRows = await executor
      .select()
      .from(missingAccessoryCases)
      .where(eq(missingAccessoryCases.returnId, ret.id))
      .orderBy(asc(missingAccessoryCases.createdAt));
    const itemRows = await executor
      .select()
      .from(returnInventoryItems)
      .where(eq(returnInventoryItems.returnId, ret.id))
      .orderBy(asc(returnInventoryItems.createdAt));
    const signatureRows = await executor
      .select()
      .from(returnSignatures)
      .where(eq(returnSignatures.returnId, ret.id));
    const representativeRows = await executor
      .select()
      .from(bookingPickupRepresentatives)
      .where(eq(bookingPickupRepresentatives.bookingId, bookingId));
    const representative = representativeRows[0] ?? null;
    let appointment: ReturnDetailView['return']['appointment'] = null;
    if (ret.returnAppointmentId !== null) {
      const rows = await executor
        .select()
        .from(appointments)
        .where(eq(appointments.id, ret.returnAppointmentId));
      const row = rows[0];
      if (row !== undefined) {
        const due = row.endAt ?? row.startAt;
        appointment = {
          id: row.id,
          status: row.status,
          startAt: row.startAt?.toISOString() ?? null,
          endAt: row.endAt?.toISOString() ?? null,
          overdue: row.status === 'scheduled' && due !== null && due.getTime() < now.getTime(),
        };
      }
    }

    const machinesView: ReturnMachineView[] = machineRows.map(
      ({ rm, slotNo, machine, product }) => ({
        id: rm.id,
        assignmentId: rm.assignmentId,
        slotNo,
        machineId: machine.id,
        machineCode: machine.machineCode,
        machineStatus: machine.status,
        machineStatusLabel: MACHINE_STATUS_LABELS[machine.status],
        typeName: product.name,
        productSlug: product.slug,
        expectedLids: rm.expectedLids,
        expectedDripTrays: rm.expectedDripTrays,
        accessoryComplete: rm.accessoryComplete,
        accessoryCheckedAt: rm.accessoryCheckedAt?.toISOString() ?? null,
        emptied: rm.emptied,
        rinsedTwice: rm.rinsedTwice,
        nothingDismantled: rm.nothingDismantled,
        cleanlinessCheckedAt: rm.cleanlinessCheckedAt?.toISOString() ?? null,
        cleanupRequired: rm.cleanupRequired,
        cleanupFeeCents: rm.cleanupFeeSnapshotCents,
        cleanupReason: rm.cleanupReason,
        cleanupPhotos: photoRows
          .filter((photo) => photo.returnMachineId === rm.id)
          .map((photo) => ({ id: photo.id, takenAt: photo.takenAt.toISOString() })),
        damages: damageViews.filter(
          (damage) => damage.returnMachineId === rm.id && damage.origin === 'return',
        ),
        missingCases: missingRows
          .filter((row) => row.returnMachineId === rm.id)
          .map((row) =>
            this.missingCaseView(
              row,
              machine.machineCode,
              booking.processId,
              process.processNumber,
            ),
          ),
        returnedAt: rm.returnedAt?.toISOString() ?? null,
      }),
    );

    const items: ReturnItemView[] = itemRows.map((row) => {
      const chargeableQuantity =
        row.kind === 'commission' ? row.issuedQuantity - row.returnedUnopenedQuantity : 0;
      return {
        id: row.id,
        deliveryNoteItemId: row.deliveryNoteItemId,
        inventoryItemId: row.inventoryItemId,
        kind: row.kind,
        kindLabel: row.kind === 'commission' ? 'Kommission' : 'inklusive',
        description: row.description,
        unit: row.unit,
        issuedQuantity: row.issuedQuantity,
        returnedUnopenedQuantity: row.returnedUnopenedQuantity,
        unitPriceSnapshotCents: row.unitPriceSnapshotCents,
        chargeableQuantity: row.chargeableQuantity ?? chargeableQuantity,
        chargeableAmountCents:
          row.chargeableAmountCents ??
          (row.kind === 'commission' ? chargeableQuantity * row.unitPriceSnapshotCents : 0),
      };
    });

    const customerSig = signatureRows.find((row) => row.role === 'customer');
    const staffSig = signatureRows.find((row) => row.role === 'staff');
    const blockers = this.computeBlockers(
      ret,
      machinesView,
      customerSig !== undefined,
      staffSig !== undefined,
    );
    const cleanupMachines = machinesView.filter((m) => m.cleanupRequired);
    const damageCount = machinesView.reduce((sum, m) => sum + m.damages.length, 0);
    const missingCount = machinesView.reduce((sum, m) => sum + m.missingCases.length, 0);
    const commissionChargeableCents = items.reduce(
      (sum, item) => sum + item.chargeableAmountCents,
      0,
    );
    const withoutComplaint =
      machinesView.length > 0 &&
      machinesView.every((m) => m.accessoryComplete === true && !m.cleanupRequired) &&
      damageCount === 0 &&
      missingCount === 0;
    const summaryLines: string[] = [];
    for (const m of machinesView) {
      for (const damage of m.damages) {
        summaryLines.push(
          `Schaden ${m.machineCode} (${damage.severityLabel}): ${damage.description} – finanzielle Klärung erforderlich`,
        );
      }
      for (const missing of m.missingCases) {
        summaryLines.push(
          `Fehlteil ${m.machineCode}: ${missing.missingQuantity} × ${missing.accessoryLabel} – finanzielle Klärung später erforderlich`,
        );
      }
      if (m.cleanupRequired) {
        summaryLines.push(
          `Reinigungsaufwand ${m.machineCode}: nicht ordnungsgemäß vorbereitet (${m.cleanupReason ?? ''}) – Reinigungsgebühr-Fakt 75,00 €`,
        );
      }
    }
    for (const item of items) {
      if (item.returnedUnopenedQuantity > 0 || item.kind === 'commission') {
        summaryLines.push(
          `${item.description}: ausgegeben ${item.issuedQuantity}, ungeöffnet zurück ${item.returnedUnopenedQuantity}` +
            (item.kind === 'commission'
              ? `, verbraucht/abrechenbar ${item.chargeableQuantity}`
              : ' (inklusive)'),
        );
      }
    }

    const returnerSet = ret.returnerKind !== null;
    const checksDone = machinesView.every(
      (m) => m.accessoryComplete !== null && m.cleanlinessCheckedAt !== null,
    );
    const nextAction: ReturnDetailView['nextAction'] =
      ret.status === 'finalized'
        ? 'done'
        : !returnerSet
          ? 'returner'
          : !checksDone
            ? 'checks'
            : customerSig === undefined || staffSig === undefined
              ? 'sign'
              : 'finalize';

    return {
      booking: {
        id: booking.id,
        processId: booking.processId,
        processNumber: process.processNumber,
        processStatus: process.mainStatus,
        customerName: String(customer.displayName ?? ''),
        customerEmail: typeof customer.email === 'string' ? customer.email : null,
        fulfillment: booking.fulfillment,
        machineTypeName: machineItem.typeName,
        machineQuantity: machineItem.quantity,
      },
      return: {
        id: ret.id,
        status: ret.status,
        returnerKind: ret.returnerKind,
        returnerName: ret.returnerName,
        returnerPhone: ret.returnerPhone,
        startedAt: ret.startedAt.toISOString(),
        finalizedAt: ret.finalizedAt?.toISOString() ?? null,
        draftActualReturnAt: ret.draftActualReturnAt?.toISOString() ?? null,
        actualReturnAt: ret.actualReturnAt?.toISOString() ?? null,
        originalActualReturnAt: ret.originalActualReturnAt?.toISOString() ?? null,
        correctedActualReturnAt: ret.correctedActualReturnAt?.toISOString() ?? null,
        correctedAt: ret.correctedAt?.toISOString() ?? null,
        protocolDocumentId: ret.protocolDocumentId,
        appointment,
      },
      representative:
        representative === null
          ? null
          : { firstName: representative.firstName, lastName: representative.lastName },
      machines: machinesView,
      items,
      signatures: {
        customer:
          customerSig === undefined
            ? null
            : { signerName: customerSig.signerName, signedAt: customerSig.signedAt.toISOString() },
        staff:
          staffSig === undefined
            ? null
            : { signerName: staffSig.signerName, signedAt: staffSig.signedAt.toISOString() },
      },
      summary: {
        withoutComplaint,
        cleanupMachines: cleanupMachines.length,
        cleanupFeeTotalCents: cleanupMachines.reduce((sum, m) => sum + (m.cleanupFeeCents ?? 0), 0),
        damages: damageCount,
        missingCases: missingCount,
        commissionChargeableCents,
        lines: summaryLines,
      },
      blockers,
      nextAction,
    };
  }

  private missingCaseView(
    row: MissingAccessoryCase,
    machineCode: string,
    processId: string,
    processNumber: string,
  ): MissingCaseView {
    return {
      id: row.id,
      returnId: row.returnId,
      returnMachineId: row.returnMachineId,
      machineId: row.machineId,
      machineCode,
      processId,
      processNumber,
      accessoryType: row.accessoryType,
      accessoryLabel: ACCESSORY_LABELS[row.accessoryType],
      missingQuantity: row.missingQuantity,
      description: row.description,
      status: row.status,
      requiresFinancialReview: row.requiresFinancialReview,
      followUpOpenedAt: row.followUpOpenedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
    };
  }

  private machineItemOf(booking: Booking): { typeName: string | null; quantity: number } {
    const items = (booking.itemsSnapshot ?? []) as {
      kind?: string;
      quantity?: number;
      productSnapshot?: Record<string, unknown>;
    }[];
    const machineItem = items.find((item) => item.kind === 'machine');
    const snapshot = machineItem?.productSnapshot ?? {};
    return {
      typeName: typeof snapshot.name === 'string' ? snapshot.name : null,
      quantity:
        typeof machineItem?.quantity === 'number' && machineItem.quantity > 0
          ? machineItem.quantity
          : 0,
    };
  }

  /** Serverseitige Vorbedingungen der Finalisierung (Order §47) – auch für die UI. */
  private computeBlockers(
    ret: RentalReturn,
    machinesView: ReturnMachineView[],
    customerSigned: boolean,
    staffSigned: boolean,
  ): string[] {
    if (ret.status === 'finalized') return [];
    const blockers: string[] = [];
    if (machinesView.length === 0) {
      blockers.push('Keine ausgegebene Maschine – Rückgabe nicht möglich.');
    }
    if (ret.returnerKind === null || (ret.returnerName ?? '').trim() === '') {
      blockers.push('Rückgabeperson (Kunde oder Vertreter) noch nicht bestimmt.');
    }
    for (const m of machinesView) {
      if (m.accessoryComplete === null) {
        blockers.push(`Maschine ${m.machineCode}: Zubehörkontrolle noch nicht bestätigt.`);
      }
      if (m.cleanlinessCheckedAt === null) {
        blockers.push(
          `Maschine ${m.machineCode}: Rückgabevorbereitung (entleert / zweimal gespült / nichts demontiert) noch nicht geprüft.`,
        );
      }
      if (m.cleanupRequired && m.cleanupPhotos.length === 0) {
        blockers.push(`Maschine ${m.machineCode}: Beweisfoto für die Reinigungsgebühr fehlt.`);
      }
      for (const damage of m.damages) {
        if (damage.photos.length === 0) {
          blockers.push(
            `Schaden „${damage.description}“ an ${m.machineCode}: mindestens ein Foto fehlt.`,
          );
        }
        if (damage.markers.length === 0) {
          blockers.push(
            `Schaden „${damage.description}“ an ${m.machineCode}: Markierung am Schema fehlt.`,
          );
        }
      }
    }
    if (!customerSigned) blockers.push('Unterschrift Kunde / Vertreter fehlt.');
    if (!staffSigned) blockers.push('Unterschrift Mitarbeiter fehlt.');
    return blockers;
  }

  // ── Entwurfssperre ───────────────────────────────────────────────────────

  private async withDraftLock<T>(
    bookingId: string,
    fn: (tx: DatabaseTransaction, ret: RentalReturn) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(rentalReturns)
        .where(eq(rentalReturns.bookingId, bookingId))
        .for('no key update');
      const ret = rows[0];
      if (ret === undefined) throw new AuthError('NOT_FOUND', 'Rückgabe nicht gefunden.');
      if (ret.status === 'finalized') {
        throw new AuthError(
          'CONFLICT',
          'Die Rückgabe ist bereits abgeschlossen und unveränderlich.',
        );
      }
      return fn(tx, ret);
    });
  }

  private async returnMachineOf(
    tx: DatabaseExecutor,
    returnId: string,
    returnMachineId: string,
  ): Promise<ReturnMachine> {
    const rows = await tx
      .select()
      .from(returnMachines)
      .where(and(eq(returnMachines.id, returnMachineId), eq(returnMachines.returnId, returnId)));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Rückgabeabschnitt nicht gefunden.');
    return row;
  }

  // ── Rückgabeperson (Order §§8/9) ─────────────────────────────────────────

  async setReturner(
    actorId: string,
    bookingId: string,
    input: {
      kind: ReturnerKind;
      firstName?: string | null | undefined;
      lastName?: string | null | undefined;
      phone?: string | null | undefined;
    },
    now = new Date(),
  ): Promise<void> {
    const booking = await this.bookingById(bookingId);
    const replaced = await this.withDraftLock(bookingId, async (tx, ret) => {
      let name: string;
      let phone: string | null = null;
      if (input.kind === 'customer') {
        const customer = booking.customerSnapshot as Record<string, unknown>;
        name = String(customer.displayName ?? '').trim();
      } else if (input.kind === 'representative') {
        const rows = await tx
          .select()
          .from(bookingPickupRepresentatives)
          .where(eq(bookingPickupRepresentatives.bookingId, bookingId));
        const rep = rows[0];
        if (rep === undefined) {
          throw new AuthError('VALIDATION', 'Für diese Buchung ist keine Abholperson hinterlegt.');
        }
        name = `${rep.firstName} ${rep.lastName}`.trim();
      } else {
        const first = (input.firstName ?? '').trim();
        const last = (input.lastName ?? '').trim();
        phone = (input.phone ?? '').trim();
        if (first === '' || last === '' || phone === '') {
          throw new AuthError(
            'VALIDATION',
            'Für eine sonstige Rückgabeperson sind Vorname, Nachname und Telefonnummer Pflicht.',
          );
        }
        name = `${first} ${last}`;
      }
      if (name === '') throw new AuthError('VALIDATION', 'Rückgabeperson ohne Namen.');
      const changed = ret.returnerKind !== input.kind || ret.returnerName !== name;
      await tx
        .update(rentalReturns)
        .set({ returnerKind: input.kind, returnerName: name, returnerPhone: phone, updatedAt: now })
        .where(eq(rentalReturns.id, ret.id));
      if (!changed) return [];
      // Wechsel der Rückgabeperson entwertet eine vorhandene Kundenunterschrift.
      const old = await tx
        .delete(returnSignatures)
        .where(and(eq(returnSignatures.returnId, ret.id), eq(returnSignatures.role, 'customer')))
        .returning({ storageKey: returnSignatures.storageKey });
      return old.map((row) => row.storageKey);
    });
    await this.deleteKeys(replaced);
    void actorId;
  }

  // ── Zubehör / Fehlteile (Order §§10–14) ──────────────────────────────────

  async confirmAccessoriesComplete(
    actorId: string,
    bookingId: string,
    returnMachineId: string,
    now = new Date(),
  ): Promise<void> {
    await this.withDraftLock(bookingId, async (tx, ret) => {
      const rm = await this.returnMachineOf(tx, ret.id, returnMachineId);
      const open = await tx
        .select({ id: missingAccessoryCases.id })
        .from(missingAccessoryCases)
        .where(eq(missingAccessoryCases.returnMachineId, rm.id));
      if (open.length > 0) {
        throw new AuthError(
          'VALIDATION',
          'Für diese Maschine sind Fehlteile erfasst – „Zubehör vollständig“ ist damit nicht möglich. Bitte zuerst die Fehlteil-Einträge entfernen.',
        );
      }
      await tx
        .update(returnMachines)
        .set({
          accessoryComplete: true,
          accessoryCheckedBy: actorId,
          accessoryCheckedAt: now,
          updatedAt: now,
        })
        .where(eq(returnMachines.id, rm.id));
    });
  }

  async addMissingCase(
    actorId: string,
    bookingId: string,
    returnMachineId: string,
    input: {
      accessoryType: MissingAccessoryCase['accessoryType'];
      missingQuantity: number;
      description?: string | null | undefined;
    },
    now = new Date(),
  ): Promise<{ caseId: string }> {
    if (!Number.isInteger(input.missingQuantity) || input.missingQuantity < 1) {
      throw new AuthError('VALIDATION', 'Die fehlende Menge muss eine ganze Zahl ab 1 sein.');
    }
    return this.withDraftLock(bookingId, async (tx, ret) => {
      const rm = await this.returnMachineOf(tx, ret.id, returnMachineId);
      const expected = input.accessoryType === 'lid' ? rm.expectedLids : rm.expectedDripTrays;
      const existing = await tx
        .select({ quantity: missingAccessoryCases.missingQuantity })
        .from(missingAccessoryCases)
        .where(
          and(
            eq(missingAccessoryCases.returnMachineId, rm.id),
            eq(missingAccessoryCases.accessoryType, input.accessoryType),
          ),
        );
      const already = existing.reduce((sum, row) => sum + row.quantity, 0);
      if (already + input.missingQuantity > expected) {
        throw new AuthError(
          'VALIDATION',
          `Für diese Maschine sind ${expected} × ${ACCESSORY_LABELS[input.accessoryType]} vorgesehen – mehr kann nicht fehlen.`,
        );
      }
      const inserted = await tx
        .insert(missingAccessoryCases)
        .values({
          returnId: ret.id,
          returnMachineId: rm.id,
          machineId: rm.machineId,
          accessoryType: input.accessoryType,
          missingQuantity: input.missingQuantity,
          description:
            (input.description ?? '').trim() === '' ? null : (input.description ?? '').trim(),
          status: 'open',
          requiresFinancialReview: true,
          createdBy: actorId,
          createdAt: now,
        })
        .returning({ id: missingAccessoryCases.id });
      await tx
        .update(returnMachines)
        .set({
          accessoryComplete: false,
          accessoryCheckedBy: actorId,
          accessoryCheckedAt: now,
          updatedAt: now,
        })
        .where(eq(returnMachines.id, rm.id));
      return { caseId: inserted[0]!.id };
    });
  }

  async deleteMissingCase(
    actorId: string,
    bookingId: string,
    caseId: string,
    now = new Date(),
  ): Promise<void> {
    await this.withDraftLock(bookingId, async (tx, ret) => {
      const deleted = await tx
        .delete(missingAccessoryCases)
        .where(
          and(eq(missingAccessoryCases.id, caseId), eq(missingAccessoryCases.returnId, ret.id)),
        )
        .returning({ returnMachineId: missingAccessoryCases.returnMachineId });
      const row = deleted[0];
      if (row === undefined) throw new AuthError('NOT_FOUND', 'Fehlteil nicht gefunden.');
      const remaining = await tx
        .select({ id: missingAccessoryCases.id })
        .from(missingAccessoryCases)
        .where(eq(missingAccessoryCases.returnMachineId, row.returnMachineId));
      if (remaining.length === 0) {
        await tx
          .update(returnMachines)
          .set({
            accessoryComplete: null,
            accessoryCheckedBy: actorId,
            accessoryCheckedAt: null,
            updatedAt: now,
          })
          .where(eq(returnMachines.id, row.returnMachineId));
      }
    });
  }

  // ── Sauberkeit / Reinigungsgebühr-Fakt (Order §§15–18) ───────────────────

  async checkCleanliness(
    actorId: string,
    effective: ReadonlySet<string>,
    bookingId: string,
    returnMachineId: string,
    input: { emptied: boolean; rinsedTwice: boolean; nothingDismantled: boolean },
    now = new Date(),
  ): Promise<void> {
    const failed = (
      Object.keys(CLEANUP_FAIL_LABELS) as (keyof typeof CLEANUP_FAIL_LABELS)[]
    ).filter((key) => input[key] !== true);
    if (failed.length > 0 && !effective.has('return.mark_cleanup_issue')) {
      throw new AuthError(
        'FORBIDDEN',
        'Dir fehlt das Recht, Reinigungsmängel zu erfassen (return.mark_cleanup_issue).',
      );
    }
    await this.withDraftLock(bookingId, async (tx, ret) => {
      const rm = await this.returnMachineOf(tx, ret.id, returnMachineId);
      const cleanupRequired = failed.length > 0;
      await tx
        .update(returnMachines)
        .set({
          emptied: input.emptied,
          rinsedTwice: input.rinsedTwice,
          nothingDismantled: input.nothingDismantled,
          cleanlinessCheckedBy: actorId,
          cleanlinessCheckedAt: now,
          cleanupRequired,
          // Unveränderlicher Fakt (Order §17) – Betrag serverseitig, nie vom Client.
          cleanupFeeSnapshotCents: cleanupRequired ? CLEANUP_FEE_CENTS : null,
          cleanupReason: cleanupRequired
            ? failed.map((key) => CLEANUP_FAIL_LABELS[key]).join(', ')
            : null,
          updatedAt: now,
        })
        .where(eq(returnMachines.id, rm.id));
    });
  }

  async addCleanupPhoto(
    actorId: string,
    bookingId: string,
    returnMachineId: string,
    input: { bytes: Uint8Array; mimeType: ImageMimeType },
    now = new Date(),
  ): Promise<{ photoId: string }> {
    if (!embeddablePhotoLooksValid(input.bytes, input.mimeType, PHOTO_MAX_BYTES)) {
      throw new AuthError(
        'VALIDATION',
        'Das Foto muss ein darstellbares JPEG- oder PNG-Bild (max. 6 MB) sein und zum angegebenen Bildtyp passen.',
      );
    }
    const ret = await this.returnFor(bookingId);
    if (ret === null) throw new AuthError('NOT_FOUND', 'Rückgabe nicht gefunden.');
    const key = `returns/${ret.id}/photos/${returnMachineId}-${randomBytes(8).toString('hex')}.${imageExtension(input.mimeType)}`;
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    await this.storage.put(key, input.bytes, { contentType: input.mimeType });
    try {
      return await this.withDraftLock(bookingId, async (tx, locked) => {
        const rm = await this.returnMachineOf(tx, locked.id, returnMachineId);
        const inserted = await tx
          .insert(returnPhotos)
          .values({
            returnId: locked.id,
            returnMachineId: rm.id,
            machineId: rm.machineId,
            storageKey: key,
            mimeType: input.mimeType,
            byteSize: input.bytes.length,
            sha256,
            takenBy: actorId,
            takenAt: now,
          })
          .returning({ id: returnPhotos.id });
        return { photoId: inserted[0]!.id };
      });
    } catch (error) {
      await this.deleteKeys([key]);
      throw error;
    }
  }

  async photoMeta(photoId: string): Promise<{ processId: string; mimeType: string }> {
    const rows = await this.db
      .select({ processId: rentalReturns.processId, mimeType: returnPhotos.mimeType })
      .from(returnPhotos)
      .innerJoin(rentalReturns, eq(rentalReturns.id, returnPhotos.returnId))
      .where(eq(returnPhotos.id, photoId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Foto nicht gefunden.');
    return row;
  }

  async photoBytes(photoId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const rows = await this.db.select().from(returnPhotos).where(eq(returnPhotos.id, photoId));
    const photo = rows[0];
    if (photo === undefined) throw new AuthError('NOT_FOUND', 'Foto nicht gefunden.');
    const bytes = await this.storage.get(photo.storageKey);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== photo.sha256) {
      throw new AuthError('CONFLICT', 'Foto-Integritätsprüfung fehlgeschlagen.');
    }
    return { bytes, mimeType: photo.mimeType };
  }

  // ── Kommissionsrückgabe (Order §§19–23) ──────────────────────────────────

  async setReturnedQuantity(
    actorId: string,
    bookingId: string,
    itemId: string,
    returnedUnopenedQuantity: number,
    now = new Date(),
  ): Promise<void> {
    if (!Number.isInteger(returnedUnopenedQuantity) || returnedUnopenedQuantity < 0) {
      throw new AuthError(
        'VALIDATION',
        'Die ungeöffnet zurückgegebene Menge muss eine ganze Zahl ab 0 sein.',
      );
    }
    await this.withDraftLock(bookingId, async (tx, ret) => {
      const rows = await tx
        .select()
        .from(returnInventoryItems)
        .where(and(eq(returnInventoryItems.id, itemId), eq(returnInventoryItems.returnId, ret.id)));
      const item = rows[0];
      if (item === undefined) throw new AuthError('NOT_FOUND', 'Rückgabeposition nicht gefunden.');
      if (returnedUnopenedQuantity > item.issuedQuantity) {
        throw new AuthError(
          'VALIDATION',
          `Die ungeöffnet zurückgegebene Menge darf die ausgegebene Menge (${item.issuedQuantity} ${item.unit}) nicht überschreiten.`,
        );
      }
      await tx
        .update(returnInventoryItems)
        .set({ returnedUnopenedQuantity, updatedAt: now })
        .where(eq(returnInventoryItems.id, item.id));
    });
    void actorId;
  }

  // ── Schäden im Rückgabe-Entwurf (Order §26) ──────────────────────────────

  async addDamage(
    actorId: string,
    bookingId: string,
    returnMachineId: string,
    input: {
      severity: 'light' | 'medium' | 'severe';
      description: string;
      markers: readonly DamageMarkerInput[];
    },
    now = new Date(),
  ): Promise<{ damageId: string }> {
    return this.withDraftLock(bookingId, async (tx, ret) => {
      const rm = await this.returnMachineOf(tx, ret.id, returnMachineId);
      const damageId = await this.damages.insertWithin(tx, {
        actorId,
        machineId: rm.machineId,
        returnId: ret.id,
        returnMachineId: rm.id,
        severity: input.severity,
        description: input.description,
        markers: input.markers,
        origin: 'return',
        activatedAt: null,
        now,
      });
      return { damageId };
    });
  }

  async deleteDamage(actorId: string, bookingId: string, damageId: string): Promise<void> {
    const keys = await this.withDraftLock(bookingId, (tx, ret) =>
      this.damages.deleteDraftDamage(tx, damageId, ret.id),
    );
    await this.deleteKeys(keys);
    void actorId;
  }

  // ── Unterschriften (Order §43) ───────────────────────────────────────────

  async sign(
    actorId: string,
    bookingId: string,
    role: 'customer' | 'staff',
    png: Uint8Array,
    now = new Date(),
  ): Promise<void> {
    if (!signaturePngLooksValid(png)) {
      throw new AuthError(
        'VALIDATION',
        'Die Unterschrift muss als darstellbares PNG-Bild (max. 2 MB) übermittelt werden.',
      );
    }
    let staffSignerName: string | null = null;
    if (role === 'staff') {
      // Der Unterzeichner ist IMMER die authentifizierte Session (Order §43).
      const rows = await this.db
        .select({ firstName: staffUsers.firstName, lastName: staffUsers.lastName })
        .from(staffUsers)
        .where(eq(staffUsers.id, actorId));
      const user = rows[0];
      if (user === undefined) throw new AuthError('NOT_FOUND', 'Mitarbeiter nicht gefunden.');
      staffSignerName = `${user.firstName} ${user.lastName}`.trim();
    }
    const ret = await this.returnFor(bookingId);
    if (ret === null) throw new AuthError('NOT_FOUND', 'Rückgabe nicht gefunden.');
    const key = `returns/${ret.id}/signatures/${role}-${randomBytes(8).toString('hex')}.png`;
    const sha256 = createHash('sha256').update(png).digest('hex');
    await this.storage.put(key, png, { contentType: 'image/png' });
    let replacedKeys: string[];
    try {
      replacedKeys = await this.withDraftLock(bookingId, async (tx, locked) => {
        const signerName =
          staffSignerName ??
          (locked.returnerKind === null || (locked.returnerName ?? '') === ''
            ? null
            : (locked.returnerName ?? ''));
        if (signerName === null) {
          throw new AuthError(
            'VALIDATION',
            'Bitte zuerst die anwesende Rückgabeperson (Kunde oder Vertreter) bestimmen.',
          );
        }
        const old = await tx
          .delete(returnSignatures)
          .where(and(eq(returnSignatures.returnId, locked.id), eq(returnSignatures.role, role)))
          .returning({ storageKey: returnSignatures.storageKey });
        await tx.insert(returnSignatures).values({
          returnId: locked.id,
          role,
          signerName,
          signerUserId: role === 'staff' ? actorId : null,
          storageKey: key,
          mimeType: 'image/png',
          byteSize: png.length,
          sha256,
          signedAt: now,
        });
        return old.map((row) => row.storageKey);
      });
    } catch (error) {
      await this.deleteKeys([key]);
      throw error;
    }
    await this.deleteKeys(replacedKeys);
  }

  async signatureBytes(bookingId: string, role: 'customer' | 'staff'): Promise<Uint8Array> {
    const ret = await this.returnFor(bookingId);
    if (ret === null) throw new AuthError('NOT_FOUND', 'Rückgabe nicht gefunden.');
    const rows = await this.db
      .select()
      .from(returnSignatures)
      .where(and(eq(returnSignatures.returnId, ret.id), eq(returnSignatures.role, role)));
    const signature = rows[0];
    if (signature === undefined) throw new AuthError('NOT_FOUND', 'Unterschrift nicht vorhanden.');
    const bytes = await this.storage.get(signature.storageKey);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== signature.sha256) {
      throw new AuthError('CONFLICT', 'Unterschrift-Integritätsprüfung fehlgeschlagen.');
    }
    return bytes;
  }

  // ── Tatsächliche Rückgabezeit (Order §50) ────────────────────────────────

  async setDraftActualReturnAt(
    actorId: string,
    bookingId: string,
    at: Date | null,
    now = new Date(),
  ): Promise<void> {
    if (at !== null && at.getTime() > now.getTime() + 60_000) {
      throw new AuthError(
        'VALIDATION',
        'Die tatsächliche Rückgabezeit kann nicht in der Zukunft liegen.',
      );
    }
    await this.withDraftLock(bookingId, async (tx, ret) => {
      await tx
        .update(rentalReturns)
        .set({ draftActualReturnAt: at, updatedAt: now })
        .where(eq(rentalReturns.id, ret.id));
    });
    void actorId;
  }

  /** Nachträgliche Korrektur: separat gespeichert, Originalzeit und PDF bleiben. */
  async correctActualReturnAt(
    actorId: string,
    bookingId: string,
    at: Date,
    now = new Date(),
  ): Promise<void> {
    if (at.getTime() > now.getTime() + 60_000) {
      throw new AuthError(
        'VALIDATION',
        'Die tatsächliche Rückgabezeit kann nicht in der Zukunft liegen.',
      );
    }
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(rentalReturns)
        .where(eq(rentalReturns.bookingId, bookingId))
        .for('no key update');
      const ret = rows[0];
      if (ret === undefined) throw new AuthError('NOT_FOUND', 'Rückgabe nicht gefunden.');
      if (ret.status !== 'finalized') {
        throw new AuthError(
          'CONFLICT',
          'Vor dem Abschluss wird die Rückgabezeit direkt im Entwurf gesetzt.',
        );
      }
      await tx
        .update(rentalReturns)
        .set({
          actualReturnAt: at,
          correctedActualReturnAt: at,
          correctedBy: actorId,
          correctedAt: now,
          updatedAt: now,
        })
        .where(eq(rentalReturns.id, ret.id));
    });
  }

  // ── Finalisierung (Order §§47–49) ────────────────────────────────────────

  async finalize(actorId: string, bookingId: string, now = new Date()): Promise<ReturnDetailView> {
    return this.finalizeMutex.run(`return-finalize:${bookingId}`, () =>
      this.finalizeExclusive(actorId, bookingId, now),
    );
  }

  private async finalizeExclusive(
    actorId: string,
    bookingId: string,
    now: Date,
  ): Promise<ReturnDetailView> {
    const view = await this.detail(bookingId, now);
    if (view.return.status === 'finalized') return view;
    if (view.blockers.length > 0) {
      throw new AuthError(
        'CONFLICT',
        `Rückgabe kann noch nicht abgeschlossen werden: ${view.blockers.join(' ')}`,
      );
    }
    const booking = await this.bookingById(bookingId);
    const ret = await this.returnById(view.return.id);
    const phase1Fingerprint = finalizationFingerprint(view);

    // Phase 1 (ohne Sperren): Bilder laden, PDF rendern, hochladen.
    const customerPng = await this.signatureBytes(bookingId, 'customer');
    const staffPng = await this.signatureBytes(bookingId, 'staff');
    const signatureRows = await this.db
      .select()
      .from(returnSignatures)
      .where(eq(returnSignatures.returnId, ret.id));
    const customerSig = signatureRows.find((row) => row.role === 'customer')!;
    const staffSig = signatureRows.find((row) => row.role === 'staff')!;
    const finalizedAt = now;
    const actualReturnAt = ret.draftActualReturnAt ?? finalizedAt;
    const machineSections: ReturnProtocolMachineSection[] = [];
    for (const m of view.machines) {
      const cleanupPhotos: Uint8Array[] = [];
      for (const photo of m.cleanupPhotos)
        cleanupPhotos.push((await this.photoBytes(photo.id)).bytes);
      const damages = [];
      for (const damage of m.damages) {
        damages.push({
          severityLabel: damage.severityLabel,
          description: damage.description,
          markers: damage.markers.map((marker) => ({
            view: marker.view,
            markerType: marker.markerType,
            x: marker.x,
            y: marker.y,
            width: marker.width,
            height: marker.height,
          })),
          photos: await this.damages.photosBytesFor(damage.id),
          sketchImages: sketchImagesFor(m.productSlug),
        });
      }
      machineSections.push({
        machineCode: m.machineCode,
        typeName: m.typeName,
        accessoryLabel:
          m.accessoryComplete === true
            ? `Zubehör vollständig (${m.expectedLids} Deckel, ${m.expectedDripTrays} Tropfschale${m.expectedDripTrays === 1 ? '' : 'n'})`
            : `Fehlteile erfasst (Soll ${m.expectedLids} Deckel, ${m.expectedDripTrays} Tropfschale${m.expectedDripTrays === 1 ? '' : 'n'})`,
        cleanlinessLines: [
          `${CLEANLINESS_LABELS.emptied}: ${m.emptied === true ? 'ja' : 'nein'}`,
          `${CLEANLINESS_LABELS.rinsedTwice}: ${m.rinsedTwice === true ? 'ja' : 'nein'}`,
          `${CLEANLINESS_LABELS.nothingDismantled}: ${m.nothingDismantled === true ? 'ja' : 'nein'}`,
        ],
        cleanupFactLabel: m.cleanupRequired
          ? `Reinigungsgebühr-Fakt: 75,00 € (nicht ordnungsgemäß vorbereitet: ${m.cleanupReason ?? ''})`
          : null,
        cleanupPhotos,
        damages,
        missingLines: m.missingCases.map(
          (missing) =>
            `${missing.missingQuantity} × ${missing.accessoryLabel}${missing.description === null ? '' : ` (${missing.description})`} – finanzielle Klärung später erforderlich`,
        ),
      });
    }
    let protocolPdf: Buffer;
    try {
      protocolPdf = await renderReturnProtocolPdf({
        processNumber: view.booking.processNumber,
        customerName: view.booking.customerName,
        returnerLabel: `${view.return.returnerName ?? ''} (${RETURNER_KIND_LABELS[view.return.returnerKind ?? 'customer']})`,
        actualReturnAtLabel: berlin(actualReturnAt),
        machines: machineSections,
        commissionLines: view.items.map((item) => ({
          description: item.description,
          unit: item.unit,
          issued: item.issuedQuantity,
          returnedUnopened: item.returnedUnopenedQuantity,
          chargeable: item.chargeableQuantity,
          kindLabel: item.kind === 'commission' ? 'Kommission' : 'inklusive',
        })),
        withoutComplaint: view.summary.withoutComplaint,
        summaryLines: view.summary.lines,
        customerSignature: {
          png: customerPng,
          name: customerSig.signerName,
          signedAtLabel: berlin(customerSig.signedAt),
        },
        staffSignature: {
          png: staffPng,
          name: staffSig.signerName,
          signedAtLabel: berlin(staffSig.signedAt),
        },
        finalizedAtLabel: berlin(finalizedAt),
        documentReference: ret.id,
      });
    } catch (error) {
      if (error instanceof SignatureImageError) {
        throw new AuthError('VALIDATION', `${error.message} Bitte erneut unterschreiben.`);
      }
      if (error instanceof PhotoImageError) {
        throw new AuthError('VALIDATION', `${error.message} Bitte das Foto erneut aufnehmen.`);
      }
      throw error;
    }
    const attempt = `${finalizedAt.getTime()}-${randomBytes(4).toString('hex')}`;
    const protocolKey = `documents/return-protocols/${ret.id}-${attempt}.pdf`;
    const upload = await this.documentService.uploadBytes(protocolKey, protocolPdf);

    // Phase 2: fachlich atomare Transaktion (A1: alle Reads über tx). Wird das
    // hochgeladene PDF nicht registriert (Idempotenz-Rückkehr, CONFLICT, DB-Fehler),
    // wird es wieder gelöscht – keine verwaisten Protokolle im Storage.
    let registered = false;
    try {
      await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${'return-finalize:' + ret.id}))`,
        );
        const lockedRows = await tx
          .select()
          .from(rentalReturns)
          .where(eq(rentalReturns.id, ret.id))
          .for('no key update');
        const locked = lockedRows[0];
        if (locked === undefined) throw new AuthError('NOT_FOUND', 'Rückgabe nicht gefunden.');
        if (locked.status === 'finalized') return; // idempotent – parallele Finalisierung
        // Sperrreihenfolge wie Zuweisung/Übergabe: Slot-Zeilen, dann sortierte
        // Maschinen-Advisory-Locks – keine Deadlocks mit Assign/Prepare/Handover.
        const slotRows = await tx
          .select({ id: machineAssignments.id, machineId: machineAssignments.machineId })
          .from(machineAssignments)
          .where(eq(machineAssignments.bookingId, bookingId))
          .orderBy(asc(machineAssignments.slotNo))
          .for('no key update');
        const machineIds = [
          ...new Set(
            slotRows.map((row) => row.machineId).filter((id): id is string => id !== null),
          ),
        ].sort();
        for (const machineId of machineIds) {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${'machine-assign:' + machineId}))`,
          );
        }
        const fresh = await this.detailWithin(tx, bookingId, now);
        if (fresh.blockers.length > 0) {
          throw new AuthError(
            'CONFLICT',
            `Rückgabe kann noch nicht abgeschlossen werden: ${fresh.blockers.join(' ')}`,
          );
        }
        // Order §47: ALLE ausgegebenen Zuordnungen der Buchung müssen Teil dieser
        // Rückgabe sein (und umgekehrt) – geprüft unter den gehaltenen Sperren.
        const issuedNow = await tx
          .select({ id: machineAssignments.id })
          .from(machineAssignments)
          .where(
            and(
              eq(machineAssignments.bookingId, bookingId),
              eq(machineAssignments.status, 'issued'),
            ),
          );
        const inReturn = new Set(fresh.machines.map((m) => m.assignmentId));
        if (issuedNow.length !== inReturn.size || issuedNow.some((row) => !inReturn.has(row.id))) {
          throw new AuthError(
            'CONFLICT',
            'Die ausgegebenen Maschinen dieser Buchung stimmen nicht mehr mit der Rückgabe überein – bitte die Rückgabe neu laden.',
          );
        }
        const freshSignatures = await tx
          .select({ role: returnSignatures.role, sha256: returnSignatures.sha256 })
          .from(returnSignatures)
          .where(eq(returnSignatures.returnId, ret.id));
        const freshSha = (role: 'customer' | 'staff') =>
          freshSignatures.find((row) => row.role === role)?.sha256 ?? null;
        if (
          finalizationFingerprint(fresh) !== phase1Fingerprint ||
          freshSha('customer') !== customerSig.sha256 ||
          freshSha('staff') !== staffSig.sha256
        ) {
          throw new AuthError(
            'CONFLICT',
            'Die Rückgabedaten wurden zwischenzeitlich geändert (Kontrollen, Mengen, Schäden, Rückgabeperson oder Unterschriften). Bitte den Abschluss erneut auslösen.',
          );
        }
        const processNumber = fresh.booking.processNumber;
        const protocolDocument = await this.documentService.registerUploaded(tx, {
          type: 'return_protocol',
          processId: booking.processId,
          bookingId,
          storageKey: protocolKey,
          sha256: upload.sha256,
          byteSize: protocolPdf.length,
        });
        registered = true;

        // Lagerrücknahme: je Lagerartikel EINE return-Bewegung über das Ledger (Order §24).
        const returned = new Map<string, number>();
        for (const item of fresh.items) {
          if (item.returnedUnopenedQuantity <= 0) continue;
          if (item.inventoryItemId === null) continue; // kein Lagerartikel – Fakt ohne Ledger-Bewegung
          returned.set(
            item.inventoryItemId,
            (returned.get(item.inventoryItemId) ?? 0) + item.returnedUnopenedQuantity,
          );
        }
        for (const [inventoryItemId, quantity] of [...returned.entries()].sort((a, b) =>
          a[0].localeCompare(b[0]),
        )) {
          await this.inventory.returnWithin(tx, actorId, inventoryItemId, quantity);
        }
        // Abrechenbare Kommissionsfakten einfrieren (Order §22 – vorläufig, kein Settlement).
        for (const item of fresh.items) {
          const chargeableQuantity =
            item.kind === 'commission' ? item.issuedQuantity - item.returnedUnopenedQuantity : 0;
          await tx
            .update(returnInventoryItems)
            .set({
              chargeableQuantity,
              chargeableAmountCents: chargeableQuantity * item.unitPriceSnapshotCents,
              updatedAt: finalizedAt,
            })
            .where(eq(returnInventoryItems.id, item.id));
        }
        // Zuordnungen → returned, Maschinen → 🟡 Reinigung / Lager, Overrides archivieren.
        for (const m of fresh.machines) {
          const updated = await tx
            .update(machineAssignments)
            .set({ status: 'returned', returnedAt: finalizedAt, updatedAt: finalizedAt })
            .where(
              and(
                eq(machineAssignments.id, m.assignmentId),
                eq(machineAssignments.machineId, m.machineId),
                eq(machineAssignments.status, 'issued'),
              ),
            )
            .returning({ overrideId: machineAssignments.overrideId });
          if (updated.length !== 1) {
            throw new AuthError(
              'CONFLICT',
              `Maschine ${m.machineCode}: Die Zuordnung ist nicht mehr als ausgegeben markiert – bitte den Stand prüfen.`,
            );
          }
          const overrideId = updated[0]!.overrideId;
          if (overrideId !== null) {
            await tx
              .update(machineAssignmentOverrides)
              .set({ archivedAt: finalizedAt })
              .where(
                and(
                  eq(machineAssignmentOverrides.id, overrideId),
                  isNull(machineAssignmentOverrides.archivedAt),
                ),
              );
          }
          await tx
            .update(returnMachines)
            .set({ returnedAt: finalizedAt, updatedAt: finalizedAt })
            .where(eq(returnMachines.id, m.id));
          await this.machineService.applyReturned(tx, m.machineId, finalizedAt);
        }
        // Rückgabetermin fachlich abschließen (Order §59).
        if (locked.returnAppointmentId !== null) {
          await this.scheduling.completeWithin(
            tx,
            actorId,
            locked.returnAppointmentId,
            finalizedAt,
          );
        }
        // Fehlteil-Follow-ups aktivieren, Rückgabeschäden werden aktuelle Schäden.
        await tx
          .update(missingAccessoryCases)
          .set({ followUpOpenedAt: finalizedAt })
          .where(
            and(
              eq(missingAccessoryCases.returnId, ret.id),
              isNull(missingAccessoryCases.followUpOpenedAt),
            ),
          );
        await tx.execute(sql`
        UPDATE machine_damages SET activated_at = ${finalizedAt}
        WHERE return_id = ${ret.id} AND origin = 'return' AND activated_at IS NULL
      `);
        await tx
          .update(rentalReturns)
          .set({
            status: 'finalized',
            finalizedAt,
            finalizedBy: actorId,
            actualReturnAt,
            originalActualReturnAt: actualReturnAt,
            protocolDocumentId: protocolDocument.id,
            // Ephemere Telefonnummer wird mit Abschluss gelöscht (Order §8).
            returnerPhone: null,
            returnerPhoneDeletedAt: locked.returnerPhone === null ? null : finalizedAt,
            updatedAt: finalizedAt,
          })
          .where(eq(rentalReturns.id, ret.id));
        // Dokumentpaket (Order §57): genau EIN Paket je Rückgabe, versandbereit.
        const customer = booking.customerSnapshot as Record<string, unknown>;
        await tx
          .insert(deliveryPackets)
          .values({
            kind: 'return_completed',
            processId: booking.processId,
            bookingId,
            returnId: ret.id,
            recipient: typeof customer.email === 'string' ? customer.email : '',
            subject: `Ihre Miet-Royal-Rückgabe ${processNumber}: Rückgabeprotokoll`,
            body:
              `Guten Tag ${String(customer.displayName ?? '')},\n\n` +
              `anbei erhalten Sie das Rückgabeprotokoll zu Vorgang ${processNumber}.\n\n` +
              'Mit freundlichen Grüßen\nMiet-Royal Mainz',
            documentIds: [protocolDocument.id],
            status: 'ready',
          })
          .onConflictDoNothing({
            target: [deliveryPackets.returnId, deliveryPackets.kind],
            where: sql`"return_id" IS NOT NULL`,
          });
      });
    } finally {
      if (!registered) await this.deleteKeys([protocolKey]);
    }
    await this.assignments.refreshRiskIncidents(now);
    return this.detail(bookingId, now);
  }

  // ── Dokumente / Pakete ───────────────────────────────────────────────────

  async documentsFor(
    bookingId: string,
  ): Promise<{ id: string; type: string; createdAt: string; sha256: string }[]> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.bookingId, bookingId), eq(documents.type, 'return_protocol')))
      .orderBy(asc(documents.createdAt));
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      createdAt: row.createdAt.toISOString(),
      sha256: row.sha256,
    }));
  }

  // ── Rückgabe-Ansicht (Order §5) ──────────────────────────────────────────

  /**
   * Offene Rückgaben ausgegebener Buchungen: überfällig zuerst, dann heute,
   * dann die kommenden ±3 Tage, zuletzt ohne Termin. Phase-2-Sichtbarkeit
   * gilt wie für die Ausgabe-Liste.
   */
  async listOpen(
    visibility: ProcessVisibilityContext,
    now = new Date(),
  ): Promise<ReturnListEntry[]> {
    const rows = await this.db
      .select({
        bookingId: machineAssignments.bookingId,
        processId: machineAssignments.processId,
        processNumber: processes.processNumber,
        machineCode: machines.machineCode,
        booking: bookings,
      })
      .from(machineAssignments)
      .innerJoin(processes, eq(processes.id, machineAssignments.processId))
      .innerJoin(machines, eq(machines.id, machineAssignments.machineId))
      .innerJoin(bookings, eq(bookings.id, machineAssignments.bookingId))
      .where(and(eq(machineAssignments.status, 'issued'), visibleProcessesWhere(visibility)))
      .orderBy(asc(machineAssignments.slotNo));
    const byBooking = new Map<string, { row: (typeof rows)[number]; codes: string[] }>();
    for (const row of rows) {
      const entry = byBooking.get(row.bookingId);
      if (entry === undefined) byBooking.set(row.bookingId, { row, codes: [row.machineCode] });
      else entry.codes.push(row.machineCode);
    }
    const todayIso = berlinDayOf(now);
    // Browse-Regel ±3 Tage ist kalendertagbasiert (Order §5): bis einschließlich
    // des dritten Berliner Kalendertages nach heute – nicht ein rollierendes 72-h-Fenster.
    const [ty, tm, td] = todayIso.split('-').map(Number);
    const horizonDayIso = new Date(Date.UTC(ty ?? 0, (tm ?? 1) - 1, (td ?? 1) + RANGE_DAYS))
      .toISOString()
      .slice(0, 10); // heute + 3 Berliner Kalendertage (DST-unabhängig)
    const result: ReturnListEntry[] = [];
    for (const { row, codes } of byBooking.values()) {
      const appointmentRows = await this.db
        .select({
          appointment: appointments,
          firstName: staffUsers.firstName,
          lastName: staffUsers.lastName,
        })
        .from(appointments)
        .leftJoin(staffUsers, eq(staffUsers.id, appointments.assignedUserId))
        .where(
          and(
            eq(appointments.bookingId, row.bookingId),
            eq(appointments.kind, 'return'),
            ne(appointments.status, 'cancelled'),
          ),
        );
      const appointment = appointmentRows[0]?.appointment ?? null;
      const assigneeName =
        appointmentRows[0]?.firstName === null || appointmentRows[0]?.firstName === undefined
          ? null
          : `${appointmentRows[0].firstName} ${appointmentRows[0].lastName ?? ''}`.trim();
      const ret = await this.returnFor(row.bookingId);
      const planned = appointment?.startAt ?? null;
      const due = appointment?.endAt ?? appointment?.startAt ?? null;
      let group: ReturnListEntry['group'];
      if (planned === null) group = 'unscheduled';
      else if (due !== null && due.getTime() < now.getTime()) group = 'overdue';
      else if (berlinDayOf(planned) === todayIso) group = 'today';
      else if (berlinDayOf(planned) <= horizonDayIso) group = 'upcoming';
      else continue; // außerhalb des Browse-Fensters (±3 Tage)
      const customer = row.booking.customerSnapshot as Record<string, unknown>;
      result.push({
        bookingId: row.bookingId,
        processId: row.processId,
        processNumber: row.processNumber,
        customerName: String(customer.displayName ?? ''),
        fulfillment: row.booking.fulfillment,
        machineCodes: codes,
        plannedAt: planned?.toISOString() ?? null,
        plannedEndAt: appointment?.endAt?.toISOString() ?? null,
        assigneeName,
        overdue: group === 'overdue',
        returnStatus: ret === null ? 'none' : 'draft',
        group,
      });
    }
    const order: Record<ReturnListEntry['group'], number> = {
      overdue: 0,
      today: 1,
      upcoming: 2,
      unscheduled: 3,
    };
    return result.sort(
      (a, b) =>
        order[a.group] - order[b.group] || (a.plannedAt ?? '').localeCompare(b.plannedAt ?? ''),
    );
  }

  // ── Fehlteil-Follow-ups (Order §§13/55) ──────────────────────────────────

  /**
   * Offene Fehlteil-Fälle – Vorgangsbezug nur innerhalb der zentralen
   * Sichtbarkeitsregel (Phase 2): `visibility` filtert die Vorgänge, `null`
   * (kein process.view_all) liefert keine vorgangsbezogenen Fälle.
   */
  async openMissingCases(
    machineId?: string,
    visibility?: ProcessVisibilityContext | null,
  ): Promise<MissingCaseView[]> {
    if (visibility === null) return [];
    const rows = await this.db
      .select({
        row: missingAccessoryCases,
        machineCode: machines.machineCode,
        processId: rentalReturns.processId,
        processNumber: processes.processNumber,
      })
      .from(missingAccessoryCases)
      .innerJoin(machines, eq(machines.id, missingAccessoryCases.machineId))
      .innerJoin(rentalReturns, eq(rentalReturns.id, missingAccessoryCases.returnId))
      .innerJoin(processes, eq(processes.id, rentalReturns.processId))
      .where(
        and(
          eq(missingAccessoryCases.status, 'open'),
          eq(rentalReturns.status, 'finalized'),
          machineId === undefined ? undefined : eq(missingAccessoryCases.machineId, machineId),
          visibility === undefined ? undefined : visibleProcessesWhere(visibility),
        ),
      )
      .orderBy(asc(missingAccessoryCases.createdAt));
    return rows.map(({ row, machineCode, processId, processNumber }) =>
      this.missingCaseView(row, machineCode, processId, processNumber),
    );
  }

  async missingCaseById(caseId: string): Promise<MissingCaseView> {
    const rows = await this.db
      .select({
        row: missingAccessoryCases,
        machineCode: machines.machineCode,
        processId: rentalReturns.processId,
        processNumber: processes.processNumber,
      })
      .from(missingAccessoryCases)
      .innerJoin(machines, eq(machines.id, missingAccessoryCases.machineId))
      .innerJoin(rentalReturns, eq(rentalReturns.id, missingAccessoryCases.returnId))
      .innerJoin(processes, eq(processes.id, rentalReturns.processId))
      .where(eq(missingAccessoryCases.id, caseId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Fehlteil nicht gefunden.');
    return this.missingCaseView(row.row, row.machineCode, row.processId, row.processNumber);
  }

  /**
   * „Fehlteil erledigt“ – ein Klick, kein Pflichtgrund; idempotent. Nur für
   * Follow-ups finalisierter Rückgaben: im Entwurf wird ein irrtümlicher
   * Eintrag entfernt, nicht „erledigt“ (das Protokoll ist noch nicht fix).
   */
  async resolveMissingCase(
    actorId: string,
    caseId: string,
    now = new Date(),
  ): Promise<MissingCaseView> {
    const existing = await this.missingCaseById(caseId);
    const ret = await this.returnById(existing.returnId);
    if (ret.status !== 'finalized') {
      throw new AuthError(
        'CONFLICT',
        'Die Rückgabe ist noch nicht abgeschlossen – bitte den Fehlteil-Eintrag im Entwurf entfernen statt erledigen.',
      );
    }
    await this.db
      .update(missingAccessoryCases)
      .set({
        status: 'resolved',
        requiresFinancialReview: false,
        resolvedBy: actorId,
        resolvedAt: now,
      })
      .where(and(eq(missingAccessoryCases.id, caseId), eq(missingAccessoryCases.status, 'open')));
    return this.missingCaseById(caseId);
  }

  // ── Reinigung (Order §§51–53) ────────────────────────────────────────────

  async completeCleaning(actorId: string, machineId: string, now = new Date()) {
    const machine = await this.machineService.completeCleaning(actorId, machineId, now);
    await this.assignments.refreshRiskIncidents(now);
    return machine;
  }

  /** Zeitabhängig abgeleitet (kein Job): länger als 24 h nach Rückgabe noch in Reinigung. */
  async cleaningWarnings(now = new Date()): Promise<CleaningWarning[]> {
    const threshold = new Date(now.getTime() - CLEANING_WARNING_HOURS * 3_600_000);
    const rows = await this.db
      .select()
      .from(machines)
      .where(and(eq(machines.status, 'cleaning'), lt(machines.cleaningSince, threshold)))
      .orderBy(asc(machines.cleaningSince));
    return rows.map((machine) => ({
      machineId: machine.id,
      machineCode: machine.machineCode,
      cleaningSince: machine.cleaningSince!.toISOString(),
      hoursInCleaning: Math.floor((now.getTime() - machine.cleaningSince!.getTime()) / 3_600_000),
    }));
  }

  /** Maschinenzustand für die Maschinenansicht (Order §§37/39/53/61). */
  async machineCondition(
    machineId: string,
    now = new Date(),
    visibility: ProcessVisibilityContext | null | undefined = undefined,
  ) {
    const { machine, product } = await this.machineService.byId(machineId);
    const currentDamages = await this.damages.currentForMachine(machineId);
    const openMissing = await this.openMissingCases(machineId, visibility);
    const defects = await this.damages.technicalDefectsFor(machineId, visibility);
    const cleaningSince = machine.cleaningSince;
    const overdueCleaning =
      machine.status === 'cleaning' &&
      cleaningSince !== null &&
      now.getTime() - cleaningSince.getTime() > CLEANING_WARNING_HOURS * 3_600_000;
    const lastReturnOpen = await this.damages.defectLinkOpen(machineId);
    return {
      productSlug: product.slug,
      currentDamages,
      openMissingCases: openMissing,
      technicalDefects: defects,
      cleaning: {
        active: machine.status === 'cleaning',
        since: cleaningSince?.toISOString() ?? null,
        overdue: overdueCleaning,
        cleanedAt: machine.cleanedAt?.toISOString() ?? null,
        cleanedBy: machine.cleanedBy,
      },
      /** Nachträglicher Kundenschaden zum letzten Return möglich? (Order §§37/38) */
      postReturnFindingOpen: postReturnWindowOpen(machine) && lastReturnOpen,
      /** Technischer Defekt intern verknüpfbar? (Order §§39/40) */
      defectLinkOpen: lastReturnOpen,
    };
  }

  // ── intern ───────────────────────────────────────────────────────────────

  private async deleteKeys(keys: string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.storage.delete(key);
      } catch {
        // best effort – verwaistes Altobjekt ist unkritisch
      }
    }
  }
}

export { DamageService };
export type { DamageMarkerInput, DamageView };
