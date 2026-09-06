import { createHash, randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { KeyedMutex } from './keyed-mutex.ts';
import {
  appointments,
  bookingAdditions,
  bookingPickupRepresentatives,
  bookings,
  deliveryNoteItems,
  deliveryNotes,
  deliveryPackets,
  documents,
  handoverMachineChecks,
  handoverPhotos,
  handoverSignatures,
  handovers,
  inventoryItems,
  machineAssignments,
  processes,
  products,
  staffUsers,
  type Booking,
  type Database,
  type DatabaseTransaction,
  type DeliveryNoteItem,
  type Handover,
  type HandoverSignature,
} from '@mietroyal/database';
import {
  renderDeliveryNotePdf,
  renderHandoverProtocolPdf,
  SignatureImageError,
} from '@mietroyal/documents';
import { CANISTER_SLUG, CANISTERS_PER_CONTAINER_LIMIT } from '@mietroyal/domain';
import type { StorageProvider } from '@mietroyal/integrations';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import { transportNotes } from '../commerce/confirmation-service.ts';
import { visibleProcessesWhere, type ProcessVisibilityContext } from '../crm/visibility.ts';
import type { DocumentService } from '../commerce/document-service.ts';
import type { ProductService } from '../commerce/product-service.ts';
import { getPickupExactAddress } from '../crm/settings-service.ts';
import type { SchedulingService } from '../scheduling/scheduling-service.ts';
import type { InventoryService } from '../warehouse/inventory-service.ts';
import type { MachineService } from '../warehouse/machine-service.ts';
import type { AssignmentService, AssignmentView } from './assignment-service.ts';

/**
 * Geführter Ausgabe-/Übergabeprozess (Phase-6-Order §§10, 12, 14–44):
 * Lieferschein-Entwurf aus der bestätigten Buchung (Soll) mit editierbarem
 * Ist, Zusatzpositionen mit eingefrorenem Preis, Abholperson/Vertreter,
 * aktive Maschinenprüfung, Pflicht-Gesamtfoto je Maschine, beide
 * Unterschriften und eine idempotente, fachlich atomare Finalisierung
 * (Dokumente, Lagerbewegungen, Maschinenstatus/-standort, Terminabschluss,
 * Dokumentpaket). Der unveränderbare Buchungs-Snapshot wird NIE mutiert.
 */

/** Order §26: spätere Phase-7-Quelle bestehender Schäden – kein eigener Speicher hier. */
export interface ExistingDamageProvider {
  existingDamagesFor(machineId: string): Promise<{ summary: string }[]>;
}

export const NO_EXISTING_DAMAGES: ExistingDamageProvider = {
  existingDamagesFor: () => Promise.resolve([]),
};

interface SnapshotItem {
  kind?: string;
  billingMode?: 'fixed' | 'commission' | 'included';
  description?: string;
  quantity?: number;
  unit?: string;
  agreedUnitPriceCents?: number;
  productId?: string | null;
  productSnapshot?: Record<string, unknown> | null;
}

export interface DeliveryNoteItemView {
  id: string;
  kind: DeliveryNoteItem['kind'];
  kindLabel: string;
  productId: string | null;
  inventoryItemId: string | null;
  description: string;
  unit: string;
  plannedQuantity: number;
  actualQuantity: number;
  unitPriceCents: number;
  billingMode: string;
  fromAddition: boolean;
}

export interface StockCheckView {
  inventoryItemId: string;
  productName: string;
  systemStock: number | null;
  required: number;
  sufficient: boolean;
}

export interface HandoverDetailView {
  booking: {
    id: string;
    processId: string;
    processNumber: string;
    processStatus: string;
    customerName: string;
    customerEmail: string | null;
    customerPhone: string | null;
    eventDate: string | null;
    eventTimeLabel: string | null;
    fulfillment: Booking['fulfillment'];
    deliveryAddressLines: string[];
    onsiteContactName: string | null;
    onsiteContactPhone: string | null;
    pickupAddress: string | null;
    transportNotes: string[];
    machineTypeName: string | null;
    machineQuantity: number;
    containersTotal: number;
  };
  handover: {
    id: string;
    status: Handover['status'];
    recipientKind: Handover['recipientKind'];
    recipientName: string | null;
    recipientPhone: string | null;
    finalizedAt: string | null;
    actualIssueAt: string | null;
    protocolDocumentId: string | null;
    appointment: {
      id: string;
      kind: string;
      status: string;
      startAt: string | null;
      endAt: string | null;
    } | null;
  };
  slots: AssignmentView[];
  deliveryNote: {
    id: string;
    status: string;
    documentId: string | null;
    items: DeliveryNoteItemView[];
  };
  additions: {
    id: string;
    description: string;
    quantity: number;
    unit: string;
    unitPriceCents: number;
    billingMode: string;
    createdAt: string;
  }[];
  representative: {
    firstName: string;
    lastName: string;
    phone: string | null;
    changeableUntil: string | null;
  } | null;
  machines: {
    assignmentId: string;
    machineId: string | null;
    machineCode: string | null;
    checked: boolean;
    checkedAt: string | null;
    photos: { id: string; takenAt: string }[];
  }[];
  signatures: {
    customer: { signerName: string; signedAt: string } | null;
    staff: { signerName: string; signedAt: string } | null;
  };
  stock: StockCheckView[];
  canisterLimit: number;
  /** Serverseitig berechnete Hindernisse für die Finalisierung. */
  blockers: string[];
  /** Nächste Aktion (Order §55), rein informativ. */
  nextAction: 'assign' | 'prepare' | 'handover' | 'done';
}

export interface IssueListEntry {
  bookingId: string;
  processId: string;
  processNumber: string;
  customerName: string;
  fulfillment: Booking['fulfillment'];
  machineTypeName: string | null;
  machineQuantity: number;
  appointmentKind: string | null;
  startAt: string | null;
  endAt: string | null;
  assigneeName: string | null;
  handoverStatus: 'draft' | 'finalized' | null;
  preparation: 'none' | 'partial' | 'prepared';
  unscheduled: boolean;
}

const ITEM_KIND_LABELS: Record<DeliveryNoteItem['kind'], string> = {
  included: 'inklusive',
  commission: 'Kommission',
  purchase: 'Kauf',
};

const RECIPIENT_KIND_LABELS = {
  customer: 'Kunde selbst',
  representative: 'Hinterlegte Abholperson',
  other: 'Vertreter',
} as const;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * Unterschrift-PNG prüfen (Magic, IHDR mit plausiblen Maßen, IDAT/IEND,
 * Bilddaten synchron dekomprimierbar): pdfkit dekomprimiert PNGs mit
 * Alphakanal ASYNCHRON – ein nicht dekodierbares Bild würde dort nicht als
 * Fehler zurückkommen, sondern den Prozess abbrechen. Deshalb wird jede
 * Unterschrift VOR dem Speichern vollständig geprüft; ein nicht
 * darstellbares Bild wäre ohnehin keine Unterschrift (Order §§33/37).
 */
function signaturePngLooksValid(bytes: Uint8Array): boolean {
  if (bytes.length < 64 || bytes.length > 2 * 1024 * 1024) return false;
  const buf = Buffer.from(bytes);
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return false;
  if (buf.readUInt32BE(8) !== 13 || buf.subarray(12, 16).toString('latin1') !== 'IHDR') {
    return false;
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0 || width > 10_000 || height > 10_000) return false;
  const bitDepth = buf[24] ?? 0;
  const colorType = buf[25] ?? -1;
  if (![1, 2, 4, 8, 16].includes(bitDepth) || ![0, 2, 3, 4, 6].includes(colorType)) return false;
  // Chunks durchlaufen, IDAT-Daten sammeln, IEND verlangen.
  const idat: Buffer[] = [];
  let offset = 8;
  let sawEnd = false;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('latin1');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) return false;
    if (type === 'IDAT') idat.push(buf.subarray(dataStart, dataEnd));
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
    offset = dataEnd + 4;
  }
  if (!sawEnd || idat.length === 0) return false;
  try {
    const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: 64 * 1024 * 1024 });
    // Mindestens eine Filterbyte-Zeile je Bildzeile.
    return raw.length >= height;
  } catch {
    return false;
  }
}

/** Deklarierter MIME-Typ muss zu den tatsächlichen Bytes passen (kein Fremdinhalt im Storage). */
function imageMagicMatches(bytes: Uint8Array, mimeType: string): boolean {
  const head = Buffer.from(bytes.subarray(0, 12));
  if (mimeType === 'image/png') return head.subarray(0, 8).equals(PNG_MAGIC);
  if (mimeType === 'image/jpeg') return head.subarray(0, 3).equals(JPEG_MAGIC);
  if (mimeType === 'image/webp') {
    return (
      head.subarray(0, 4).toString('latin1') === 'RIFF' &&
      head.subarray(8, 12).toString('latin1') === 'WEBP'
    );
  }
  return false;
}

/**
 * Fachlicher Inhalt, der in die finalen PDFs einfließt: ändert er sich
 * zwischen dem Rendern (Phase 1) und der Transaktion (Phase 2), wird die
 * Finalisierung abgebrochen statt ein veraltetes Dokument zu registrieren.
 */
function finalizationFingerprint(view: HandoverDetailView): string {
  return JSON.stringify({
    slots: view.slots.map((slot) => [
      slot.id,
      slot.machine?.id ?? null,
      slot.status,
      slot.override?.id ?? null,
    ]),
    items: view.deliveryNote.items.map((item) => [
      item.id,
      item.actualQuantity,
      item.unitPriceCents,
    ]),
    additions: view.additions.map((addition) => addition.id),
    recipient: [view.handover.recipientKind, view.handover.recipientName],
    machines: view.machines.map((machine) => [
      machine.assignmentId,
      machine.checked,
      machine.photos.map((photo) => photo.id),
    ]),
    representative:
      view.representative === null
        ? null
        : [view.representative.firstName, view.representative.lastName],
  });
}

function berlin(value: Date | null | undefined): string {
  return value === null || value === undefined
    ? '–'
    : value.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
}

function berlinTime(iso: unknown): string | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export class HandoverService {
  /**
   * Prozessintern je Service-Instanz (die API hält genau eine): Doppeltipps
   * auf „Abschließen“ warten aufeinander, statt Transaktionen und
   * Pool-Verbindungen zu stapeln. Über Instanzen/Prozesse hinweg entscheiden
   * die Advisory-/Zeilensperren (so testen es die Integrationstests).
   */
  private readonly finalizeMutex = new KeyedMutex();

  constructor(
    private readonly db: Database,
    private readonly storage: StorageProvider,
    private readonly assignments: AssignmentService,
    private readonly inventory: InventoryService,
    private readonly machineService: MachineService,
    private readonly documentService: DocumentService,
    private readonly productService: ProductService,
    private readonly scheduling: SchedulingService,
    private readonly damages: ExistingDamageProvider = NO_EXISTING_DAMAGES,
  ) {}

  // ── Laden / Anlegen (Order §18: Entwurf automatisch) ────────────────────

  async bookingById(bookingId: string): Promise<Booking> {
    const rows = await this.db.select().from(bookings).where(eq(bookings.id, bookingId));
    const booking = rows[0];
    if (booking === undefined) throw new AuthError('NOT_FOUND', 'Buchung nicht gefunden.');
    return booking;
  }

  async bookingForProcess(processId: string): Promise<Booking | null> {
    const rows = await this.db.select().from(bookings).where(eq(bookings.processId, processId));
    return rows[0] ?? null;
  }

  private machineItemOf(booking: Booking): {
    productId: string | null;
    quantity: number;
    containers: number;
    typeName: string | null;
    snapshot: Record<string, unknown>;
  } {
    const items = (booking.itemsSnapshot ?? []) as SnapshotItem[];
    const machineItem = items.find((item) => item.kind === 'machine');
    const snapshot = (machineItem?.productSnapshot ?? {}) as Record<string, unknown>;
    const quantity =
      typeof machineItem?.quantity === 'number' && machineItem.quantity > 0
        ? machineItem.quantity
        : 0;
    const containers =
      typeof snapshot.containerCount === 'number' && snapshot.containerCount > 0
        ? snapshot.containerCount
        : 0;
    return {
      productId: typeof machineItem?.productId === 'string' ? machineItem.productId : null,
      quantity,
      containers: containers * quantity,
      typeName: typeof snapshot.name === 'string' ? snapshot.name : null,
      snapshot,
    };
  }

  /**
   * Idempotent: Handover + Lieferschein-Entwurf (Soll aus dem Snapshot) +
   * Assignment-Slots. Parallele Aufrufe sind durch die Unique-Constraints
   * (booking_id) unschädlich.
   */
  async ensureForBooking(bookingId: string, actorId: string | null): Promise<void> {
    const booking = await this.bookingById(bookingId);
    await this.assignments.ensureSlotsForBooking(bookingId, actorId);
    await this.db
      .insert(handovers)
      .values({ bookingId, processId: booking.processId, createdBy: actorId })
      .onConflictDoNothing({ target: handovers.bookingId });
    const existing = await this.db
      .select({ id: deliveryNotes.id })
      .from(deliveryNotes)
      .where(eq(deliveryNotes.bookingId, bookingId));
    if (existing.length > 0) return;
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${'delivery-note:' + bookingId}))`,
      );
      const again = await tx
        .select({ id: deliveryNotes.id })
        .from(deliveryNotes)
        .where(eq(deliveryNotes.bookingId, bookingId));
      if (again.length > 0) return;
      const inserted = await tx
        .insert(deliveryNotes)
        .values({ bookingId, processId: booking.processId })
        .returning({ id: deliveryNotes.id });
      const noteId = inserted[0]!.id;
      const items = (booking.itemsSnapshot ?? []) as SnapshotItem[];
      const inventoryRows = await tx
        .select({ id: inventoryItems.id, productId: inventoryItems.productId })
        .from(inventoryItems);
      const inventoryByProduct = new Map(inventoryRows.map((row) => [row.productId, row.id]));
      let position = 1;
      for (const item of items) {
        if (item.kind === 'machine' || item.kind === 'delivery') continue;
        const kind: DeliveryNoteItem['kind'] =
          item.billingMode === 'included'
            ? 'included'
            : item.kind === 'purchase'
              ? 'purchase'
              : 'commission';
        const quantity =
          typeof item.quantity === 'number' && Number.isInteger(item.quantity) && item.quantity >= 0
            ? item.quantity
            : 0;
        const productId = typeof item.productId === 'string' ? item.productId : null;
        await tx.insert(deliveryNoteItems).values({
          deliveryNoteId: noteId,
          position,
          kind,
          productId,
          inventoryItemId: productId === null ? null : (inventoryByProduct.get(productId) ?? null),
          description: String(item.description ?? ''),
          unit: String(item.unit ?? 'Stück'),
          plannedQuantity: quantity,
          actualQuantity: quantity,
          unitPriceCents: kind === 'included' ? 0 : Number(item.agreedUnitPriceCents ?? 0),
          billingMode: String(item.billingMode ?? 'fixed'),
        });
        position += 1;
      }
    });
  }

  private async handoverFor(bookingId: string): Promise<Handover> {
    const rows = await this.db.select().from(handovers).where(eq(handovers.bookingId, bookingId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Übergabe nicht gefunden.');
    return row;
  }

  async handoverById(handoverId: string): Promise<Handover> {
    const rows = await this.db.select().from(handovers).where(eq(handovers.id, handoverId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Übergabe nicht gefunden.');
    return row;
  }

  private async outboundAppointment(bookingId: string) {
    const rows = await this.db
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.bookingId, bookingId),
          inArray(appointments.kind, ['pickup', 'delivery']),
          ne(appointments.status, 'cancelled'),
        ),
      );
    return rows[0] ?? null;
  }

  private async noteItems(noteId: string): Promise<DeliveryNoteItemView[]> {
    const rows = await this.db
      .select()
      .from(deliveryNoteItems)
      .where(eq(deliveryNoteItems.deliveryNoteId, noteId))
      .orderBy(asc(deliveryNoteItems.position));
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      kindLabel: ITEM_KIND_LABELS[row.kind],
      productId: row.productId,
      inventoryItemId: row.inventoryItemId,
      description: row.description,
      unit: row.unit,
      plannedQuantity: row.plannedQuantity,
      actualQuantity: row.actualQuantity,
      unitPriceCents: row.unitPriceCents,
      billingMode: row.billingMode,
      fromAddition: row.bookingAdditionId !== null,
    }));
  }

  /** Bedarf je Lagerartikel vs. Systembestand (Order §23 – nie still negativ). */
  private async stockCheck(items: DeliveryNoteItemView[]): Promise<StockCheckView[]> {
    const required = new Map<string, number>();
    for (const item of items) {
      if (item.inventoryItemId === null || item.actualQuantity <= 0) continue;
      required.set(
        item.inventoryItemId,
        (required.get(item.inventoryItemId) ?? 0) + item.actualQuantity,
      );
    }
    if (required.size === 0) return [];
    const rows = await this.db
      .select({ item: inventoryItems, productName: products.name })
      .from(inventoryItems)
      .innerJoin(products, eq(products.id, inventoryItems.productId))
      .where(inArray(inventoryItems.id, [...required.keys()]));
    return rows.map(({ item, productName }) => {
      const need = required.get(item.id) ?? 0;
      return {
        inventoryItemId: item.id,
        productName,
        systemStock: item.currentStock,
        required: need,
        sufficient: item.currentStock !== null && item.currentStock >= need,
      };
    });
  }

  async detail(bookingId: string, now = new Date()): Promise<HandoverDetailView> {
    const booking = await this.bookingById(bookingId);
    await this.ensureForBooking(bookingId, null);
    const handover = await this.handoverFor(bookingId);
    const processRows = await this.db
      .select({ processNumber: processes.processNumber, mainStatus: processes.mainStatus })
      .from(processes)
      .where(eq(processes.id, booking.processId));
    const process = processRows[0];
    if (process === undefined) throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
    const customer = booking.customerSnapshot as Record<string, unknown>;
    const event = (booking.eventSnapshot ?? {}) as Record<string, unknown>;
    const delivery = (booking.deliverySnapshot ?? {}) as Record<string, unknown>;
    const machine = this.machineItemOf(booking);

    const slots = await this.assignments.slotsForBooking(bookingId, now);
    const noteRows = await this.db
      .select()
      .from(deliveryNotes)
      .where(eq(deliveryNotes.bookingId, bookingId));
    const note = noteRows[0];
    if (note === undefined) throw new AuthError('NOT_FOUND', 'Lieferschein nicht gefunden.');
    const items = await this.noteItems(note.id);
    const additionRows = await this.db
      .select()
      .from(bookingAdditions)
      .where(eq(bookingAdditions.bookingId, bookingId))
      .orderBy(asc(bookingAdditions.createdAt));
    const representativeRows = await this.db
      .select()
      .from(bookingPickupRepresentatives)
      .where(eq(bookingPickupRepresentatives.bookingId, bookingId));
    const representative = representativeRows[0] ?? null;
    const appointment = await this.outboundAppointment(bookingId);
    const checks = await this.db
      .select()
      .from(handoverMachineChecks)
      .where(eq(handoverMachineChecks.handoverId, handover.id));
    const photos = await this.db
      .select()
      .from(handoverPhotos)
      .where(eq(handoverPhotos.handoverId, handover.id))
      .orderBy(asc(handoverPhotos.takenAt));
    const signatures = await this.db
      .select()
      .from(handoverSignatures)
      .where(eq(handoverSignatures.handoverId, handover.id));
    const stock = await this.stockCheck(items);
    const pickupAddress =
      booking.fulfillment === 'pickup' ? await getPickupExactAddress(this.db) : null;

    const machineViews = slots.map((slot) => {
      const check = checks.find((row) => row.assignmentId === slot.id);
      return {
        assignmentId: slot.id,
        machineId: slot.machine?.id ?? null,
        machineCode: slot.machine?.machineCode ?? null,
        checked: check !== undefined && check.machineId === slot.machine?.id,
        checkedAt: check?.checkedAt.toISOString() ?? null,
        photos: photos
          .filter((photo) => photo.assignmentId === slot.id && photo.machineId === slot.machine?.id)
          .map((photo) => ({ id: photo.id, takenAt: photo.takenAt.toISOString() })),
      };
    });
    const customerSignature = signatures.find((row) => row.role === 'customer') ?? null;
    const staffSignature = signatures.find((row) => row.role === 'staff') ?? null;

    const blockers = this.computeBlockers({
      processStatus: process.mainStatus,
      handover,
      slots,
      machineViews,
      items,
      stock,
      customerSignature,
      staffSignature,
      containersTotal: machine.containers,
    });
    const allAssigned = slots.length > 0 && slots.every((slot) => slot.machine !== null);
    const allPrepared =
      slots.length > 0 &&
      slots.every((slot) => slot.status === 'prepared' || slot.status === 'issued');
    const nextAction: HandoverDetailView['nextAction'] =
      handover.status === 'finalized'
        ? 'done'
        : !allAssigned
          ? 'assign'
          : !allPrepared
            ? 'prepare'
            : 'handover';

    const start = berlinTime(event.eventStart);
    const end = berlinTime(event.eventEnd);
    const deliveryAddressLines: string[] = [];
    if (booking.fulfillment === 'delivery') {
      const street = String(delivery.street ?? '');
      const cityLine = [delivery.postalCode, delivery.city].filter(Boolean).join(' ');
      if (street !== '') deliveryAddressLines.push(street);
      if (cityLine !== '') deliveryAddressLines.push(cityLine);
    }
    const changeableUntil =
      appointment?.startAt === null || appointment?.startAt === undefined
        ? null
        : new Date(appointment.startAt.getTime() - 3_600_000).toISOString();

    return {
      booking: {
        id: booking.id,
        processId: booking.processId,
        processNumber: process.processNumber,
        processStatus: process.mainStatus,
        customerName: String(customer.displayName ?? ''),
        customerEmail: typeof customer.email === 'string' ? customer.email : null,
        customerPhone: typeof customer.phone === 'string' ? customer.phone : null,
        eventDate: typeof event.eventDate === 'string' ? event.eventDate : null,
        eventTimeLabel:
          start === null && end === null ? null : `${start ?? '–'} bis ${end ?? '–'} Uhr`,
        fulfillment: booking.fulfillment,
        deliveryAddressLines,
        onsiteContactName:
          typeof event.onsiteContactName === 'string' ? event.onsiteContactName : null,
        onsiteContactPhone:
          typeof event.onsiteContactPhone === 'string' ? event.onsiteContactPhone : null,
        pickupAddress,
        transportNotes: booking.fulfillment === 'pickup' ? transportNotes(machine.snapshot) : [],
        machineTypeName: machine.typeName,
        machineQuantity: machine.quantity,
        containersTotal: machine.containers,
      },
      handover: {
        id: handover.id,
        status: handover.status,
        recipientKind: handover.recipientKind,
        recipientName: handover.recipientName,
        recipientPhone: handover.recipientPhone,
        finalizedAt: handover.finalizedAt?.toISOString() ?? null,
        actualIssueAt: handover.actualIssueAt?.toISOString() ?? null,
        protocolDocumentId: handover.protocolDocumentId,
        appointment:
          appointment === null
            ? null
            : {
                id: appointment.id,
                kind: appointment.kind,
                status: appointment.status,
                startAt: appointment.startAt?.toISOString() ?? null,
                endAt: appointment.endAt?.toISOString() ?? null,
              },
      },
      slots,
      deliveryNote: { id: note.id, status: note.status, documentId: note.documentId, items },
      additions: additionRows.map((row) => ({
        id: row.id,
        description: row.description,
        quantity: row.quantity,
        unit: row.unit,
        unitPriceCents: row.unitPriceCents,
        billingMode: row.billingMode,
        createdAt: row.createdAt.toISOString(),
      })),
      representative:
        representative === null
          ? null
          : {
              firstName: representative.firstName,
              lastName: representative.lastName,
              phone: representative.phone,
              changeableUntil,
            },
      machines: machineViews,
      signatures: {
        customer:
          customerSignature === null
            ? null
            : {
                signerName: customerSignature.signerName,
                signedAt: customerSignature.signedAt.toISOString(),
              },
        staff:
          staffSignature === null
            ? null
            : {
                signerName: staffSignature.signerName,
                signedAt: staffSignature.signedAt.toISOString(),
              },
      },
      stock,
      canisterLimit: machine.containers * CANISTERS_PER_CONTAINER_LIMIT,
      blockers,
      nextAction,
    };
  }

  /** Serverseitige Vorbedingungen der Finalisierung (Order §40). */
  private computeBlockers(input: {
    processStatus: string;
    handover: Handover;
    slots: AssignmentView[];
    machineViews: HandoverDetailView['machines'];
    items: DeliveryNoteItemView[];
    stock: StockCheckView[];
    customerSignature: HandoverSignature | null;
    staffSignature: HandoverSignature | null;
    containersTotal: number;
  }): string[] {
    const blockers: string[] = [];
    if (input.handover.status === 'finalized') return blockers;
    if (input.processStatus === 'cancelled') blockers.push('Der Vorgang ist storniert.');
    if (input.processStatus === 'completed') {
      blockers.push('Der Vorgang ist bereits abgeschlossen – bitte zuerst wieder öffnen.');
    }
    for (const item of input.items) {
      if (item.kind === 'included' && item.actualQuantity > item.plannedQuantity) {
        blockers.push(
          `${item.description}: inklusive nur bis ${item.plannedQuantity} ${item.unit} – mehr als Zusatzposition erfassen.`,
        );
      }
    }
    if (input.slots.length === 0) blockers.push('Die Buchung enthält keine Maschine.');
    for (const slot of input.slots) {
      if (slot.machine === null) {
        blockers.push(
          `Maschine ${slot.slotNo} (${slot.productName}): noch keine konkrete Maschine zugewiesen.`,
        );
        continue;
      }
      if (slot.status !== 'prepared' && slot.status !== 'issued') {
        blockers.push(
          `Maschine ${slot.machine.machineCode}: noch nicht als vorbereitet markiert (Order §10 – Vorbereitung → Reserviert).`,
        );
      }
      const hard = slot.currentProblems.find(
        (p) => p.code === 'issued_elsewhere' || p.code === 'status_rented',
      );
      if (hard !== undefined) {
        blockers.push(`Maschine ${slot.machine.machineCode}: ${hard.detail}`);
      } else if (slot.overrideStale) {
        blockers.push(
          `Maschine ${slot.machine.machineCode}: Die Problemlage hat sich seit der Zuweisung geändert – bitte erneut prüfen und bewusst bestätigen.`,
        );
      }
      const machineView = input.machineViews.find((m) => m.assignmentId === slot.id);
      if (machineView === undefined || !machineView.checked) {
        blockers.push(
          `Maschine ${slot.machine.machineCode}: Übergabeprüfung noch nicht bestätigt.`,
        );
      }
      if (machineView === undefined || machineView.photos.length === 0) {
        blockers.push(`Maschine ${slot.machine.machineCode}: Gesamtfoto fehlt.`);
      }
    }
    const machineIds = input.slots
      .map((slot) => slot.machine?.id)
      .filter((id): id is string => id !== undefined);
    if (new Set(machineIds).size !== machineIds.length) {
      blockers.push(
        'Dieselbe Maschine ist mehreren Slots dieser Buchung zugeordnet – bitte je Slot eine eigene Maschine wählen.',
      );
    }
    const canisterActual = input.items
      .filter((item) => item.kind === 'purchase')
      .reduce((sum, item) => sum + item.actualQuantity, 0);
    const canisterLimit = input.containersTotal * CANISTERS_PER_CONTAINER_LIMIT;
    if (canisterActual > canisterLimit) {
      blockers.push(
        `Maximal ${canisterLimit} Mischkanister möglich (${CANISTERS_PER_CONTAINER_LIMIT} je gebuchtem Behälter).`,
      );
    }
    for (const entry of input.stock) {
      if (!entry.sufficient) {
        blockers.push(
          `Lagerbestand prüfen: ${entry.productName} – System ${entry.systemStock === null ? 'nicht erfasst' : entry.systemStock}, benötigt ${entry.required}.`,
        );
      }
    }
    if (input.handover.recipientKind === null || (input.handover.recipientName ?? '') === '') {
      blockers.push('Kunde oder Vertreter für die Übergabe noch nicht bestimmt.');
    }
    if (input.customerSignature === null) blockers.push('Unterschrift Kunde/Vertreter fehlt.');
    if (input.staffSignature === null) blockers.push('Unterschrift Mitarbeiter fehlt.');
    return blockers;
  }

  private async assertDraft(bookingId: string): Promise<Handover> {
    await this.ensureForBooking(bookingId, null);
    const handover = await this.handoverFor(bookingId);
    if (handover.status === 'finalized') {
      throw new AuthError('CONFLICT', 'Die Übergabe ist bereits abgeschlossen und unveränderlich.');
    }
    return handover;
  }

  /**
   * Jede Mutation einer Übergabe läuft unter der Zeilensperre der
   * handovers-Zeile und nur im Entwurf: so serialisiert sie mit der
   * Finalisierung (Phase 2 hält dieselbe Sperre) und kann eine bereits
   * abgeschlossene Übergabe nie mehr verändern (kein TOCTOU über den
   * ungesperrten Status-Vorabcheck).
   */
  private async withDraftLock<T>(
    bookingId: string,
    fn: (tx: DatabaseTransaction, handover: Handover) => Promise<T>,
  ): Promise<T> {
    await this.ensureForBooking(bookingId, null);
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(handovers)
        .where(eq(handovers.bookingId, bookingId))
        .for('no key update');
      const handover = rows[0];
      if (handover === undefined) throw new AuthError('NOT_FOUND', 'Übergabe nicht gefunden.');
      if (handover.status === 'finalized') {
        throw new AuthError(
          'CONFLICT',
          'Die Übergabe ist bereits abgeschlossen und unveränderlich.',
        );
      }
      return fn(tx, handover);
    });
  }

  // ── Lieferschein-Mengen & Zusatzpositionen (Order §§19/20) ──────────────

  private async assertCanisterLimit(
    tx: DatabaseTransaction,
    booking: Booking,
    noteId: string,
    exceptItemId: string | null,
    addQuantity: number,
  ): Promise<void> {
    const machine = this.machineItemOf(booking);
    const limit = machine.containers * CANISTERS_PER_CONTAINER_LIMIT;
    const rows = await tx
      .select({ item: deliveryNoteItems, slug: products.slug })
      .from(deliveryNoteItems)
      .innerJoin(products, eq(products.id, deliveryNoteItems.productId))
      .where(and(eq(deliveryNoteItems.deliveryNoteId, noteId), eq(products.slug, CANISTER_SLUG)));
    const current = rows
      .filter((row) => row.item.id !== exceptItemId)
      .reduce((sum, row) => sum + row.item.actualQuantity, 0);
    if (current + addQuantity > limit) {
      throw new AuthError(
        'VALIDATION',
        `Maximal ${limit} Mischkanister möglich (${CANISTERS_PER_CONTAINER_LIMIT} je gebuchtem Behälter).`,
      );
    }
  }

  async updateItemQuantity(
    bookingId: string,
    itemId: string,
    actualQuantity: number,
    now = new Date(),
  ): Promise<void> {
    if (!Number.isInteger(actualQuantity) || actualQuantity < 0 || actualQuantity > 10_000) {
      throw new AuthError('VALIDATION', 'Die Ausgabemenge muss eine ganze Zahl ≥ 0 sein.');
    }
    const booking = await this.bookingById(bookingId);
    await this.withDraftLock(bookingId, async (tx) => {
      const rows = await tx
        .select({
          item: deliveryNoteItems,
          slug: products.slug,
          noteBooking: deliveryNotes.bookingId,
        })
        .from(deliveryNoteItems)
        .innerJoin(deliveryNotes, eq(deliveryNotes.id, deliveryNoteItems.deliveryNoteId))
        .leftJoin(products, eq(products.id, deliveryNoteItems.productId))
        .where(eq(deliveryNoteItems.id, itemId))
        .for('no key update', { of: deliveryNoteItems });
      const row = rows[0];
      if (row === undefined || row.noteBooking !== bookingId) {
        throw new AuthError('NOT_FOUND', 'Lieferschein-Position nicht gefunden.');
      }
      // Inklusive Positionen (0 €) sind auf das gebuchte Kontingent begrenzt –
      // mehr ist Kommission und läuft über eine Zusatzposition (Order §§15/16).
      if (row.item.kind === 'included' && actualQuantity > row.item.plannedQuantity) {
        throw new AuthError(
          'VALIDATION',
          `Inklusive Positionen können nur bis zur gebuchten Menge (${row.item.plannedQuantity} ${row.item.unit}) ausgegeben werden – mehr bitte als Zusatzposition (Kommission) erfassen.`,
        );
      }
      if (row.slug === CANISTER_SLUG) {
        await this.assertCanisterLimit(
          tx,
          booking,
          row.item.deliveryNoteId,
          row.item.id,
          actualQuantity,
        );
      }
      await tx
        .update(deliveryNoteItems)
        .set({ actualQuantity, updatedAt: now })
        .where(eq(deliveryNoteItems.id, itemId));
      await tx
        .update(deliveryNotes)
        .set({ updatedAt: now })
        .where(eq(deliveryNotes.id, row.item.deliveryNoteId));
    });
  }

  /** Zusatzposition mit EINGEFRORENEM Preis (Order §20) – Snapshot bleibt. */
  async addAddition(
    actorId: string,
    bookingId: string,
    productId: string,
    quantity: number,
    now = new Date(),
  ): Promise<{ additionId: string }> {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1_000) {
      throw new AuthError('VALIDATION', 'Die Menge muss eine ganze Zahl von 1 bis 1000 sein.');
    }
    const booking = await this.bookingById(bookingId);
    const product = await this.productService.getProduct(productId);
    if (product.category === 'machine') {
      throw new AuthError('VALIDATION', 'Zusätzliche Maschinen können hier nicht erfasst werden.');
    }
    if (!product.active) {
      throw new AuthError('VALIDATION', 'Dieser Artikel ist deaktiviert.');
    }
    const pricing = await this.productService.pricingProduct(productId, now);
    return this.withDraftLock(bookingId, async (tx) => {
      const noteRows = await tx
        .select()
        .from(deliveryNotes)
        .where(eq(deliveryNotes.bookingId, bookingId))
        .for('no key update');
      const note = noteRows[0];
      if (note === undefined) throw new AuthError('NOT_FOUND', 'Lieferschein nicht gefunden.');
      if (note.status !== 'draft')
        throw new AuthError('CONFLICT', 'Der Lieferschein ist bereits final.');
      if (product.slug === CANISTER_SLUG) {
        await this.assertCanisterLimit(tx, booking, note.id, null, quantity);
      }
      // Gratis-Sirup-Kontingent (1 L je gebuchtem Behälter, Order §15): noch
      // nicht ausgeschöpfte Liter werden inklusive (0 €) ausgegeben, alles
      // darüber ist Kommission zum eingefrorenen Listenpreis (§16).
      let includedQuantity = 0;
      if (product.category === 'syrup') {
        const quota = this.machineItemOf(booking).containers;
        const usedRows = await tx
          .select({
            used: sql<number>`coalesce(sum(${deliveryNoteItems.actualQuantity}), 0)`,
          })
          .from(deliveryNoteItems)
          .innerJoin(products, eq(products.id, deliveryNoteItems.productId))
          .where(
            and(
              eq(deliveryNoteItems.deliveryNoteId, note.id),
              eq(deliveryNoteItems.kind, 'included'),
              eq(products.category, 'syrup'),
            ),
          );
        const freeLeft = Math.max(0, quota - Number(usedRows[0]?.used ?? 0));
        includedQuantity = Math.min(freeLeft, quantity);
      }
      const inventoryRows = await tx
        .select({ id: inventoryItems.id })
        .from(inventoryItems)
        .where(eq(inventoryItems.productId, productId));
      const insertLine = async (
        lineKind: 'included' | 'commission' | 'purchase',
        lineQuantity: number,
      ): Promise<string> => {
        const billingMode =
          lineKind === 'included' ? 'included' : lineKind === 'purchase' ? 'fixed' : 'commission';
        const unitPriceCents = lineKind === 'included' ? 0 : pricing.listPriceCents;
        const inserted = await tx
          .insert(bookingAdditions)
          .values({
            bookingId,
            processId: booking.processId,
            productId,
            description: product.name,
            quantity: lineQuantity,
            unit: product.saleUnit,
            unitPriceCents,
            billingMode,
            createdBy: actorId,
            createdAt: now,
          })
          .returning({ id: bookingAdditions.id });
        const additionId = inserted[0]!.id;
        const positionRows = await tx
          .select({ max: sql<number>`coalesce(max(${deliveryNoteItems.position}), 0)` })
          .from(deliveryNoteItems)
          .where(eq(deliveryNoteItems.deliveryNoteId, note.id));
        await tx.insert(deliveryNoteItems).values({
          deliveryNoteId: note.id,
          position: Number(positionRows[0]?.max ?? 0) + 1,
          kind: lineKind,
          productId,
          inventoryItemId: inventoryRows[0]?.id ?? null,
          bookingAdditionId: additionId,
          description:
            lineKind === 'included'
              ? `${product.name} (inklusive – Gratis-Kontingent)`
              : `${product.name} (nachträglich vereinbart)`,
          unit: product.saleUnit,
          plannedQuantity: lineQuantity,
          actualQuantity: lineQuantity,
          unitPriceCents,
          billingMode,
        });
        return additionId;
      };
      let additionId: string | null = null;
      if (includedQuantity > 0) additionId = await insertLine('included', includedQuantity);
      const paidQuantity = quantity - includedQuantity;
      if (paidQuantity > 0) {
        const paidId = await insertLine(
          product.category === 'purchase' ? 'purchase' : 'commission',
          paidQuantity,
        );
        additionId ??= paidId;
      }
      await tx.update(deliveryNotes).set({ updatedAt: now }).where(eq(deliveryNotes.id, note.id));
      return { additionId: additionId! };
    });
  }

  // ── Abholperson / Empfänger (Order §§29–32) ─────────────────────────────

  async setRepresentative(
    actorId: string,
    bookingId: string,
    input: { firstName: string; lastName: string; phone: string | null },
    now = new Date(),
  ): Promise<void> {
    const booking = await this.bookingById(bookingId);
    if (booking.fulfillment !== 'pickup') {
      throw new AuthError(
        'VALIDATION',
        'Eine alternative Abholperson gibt es nur bei Selbstabholung.',
      );
    }
    const firstName = input.firstName.trim();
    const lastName = input.lastName.trim();
    if (firstName === '' || lastName === '') {
      throw new AuthError('VALIDATION', 'Vorname und Nachname der Abholperson sind Pflicht.');
    }
    const phone = input.phone?.trim() === '' ? null : (input.phone?.trim() ?? null);
    const removedKeys = await this.withDraftLock(bookingId, async (tx, handover) => {
      await tx
        .insert(bookingPickupRepresentatives)
        .values({
          bookingId,
          firstName,
          lastName,
          phone,
          updatedBy: actorId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: bookingPickupRepresentatives.bookingId,
          set: {
            firstName,
            lastName,
            phone,
            phoneDeletedAt: null,
            updatedBy: actorId,
            updatedAt: now,
          },
        });
      // Ist die Abholperson bereits der bestimmte Empfänger, folgt der
      // Empfänger der Korrektur – eine alte Kundenunterschrift gehört zum
      // vorherigen Namen (Order §§30/31/35).
      if (handover.recipientKind === 'representative') {
        return this.replaceRecipientWithin(tx, handover.id, {
          kind: 'representative',
          name: `${firstName} ${lastName}`.trim(),
          phone,
          now,
        });
      }
      return [];
    });
    await this.deleteStorageKeys(removedKeys);
  }

  async clearRepresentative(bookingId: string, now = new Date()): Promise<void> {
    const removedKeys = await this.withDraftLock(bookingId, async (tx, handover) => {
      await tx
        .delete(bookingPickupRepresentatives)
        .where(eq(bookingPickupRepresentatives.bookingId, bookingId));
      if (handover.recipientKind === 'representative') {
        // Ohne hinterlegte Abholperson muss der Empfänger neu bestimmt werden.
        return this.replaceRecipientWithin(tx, handover.id, {
          kind: null,
          name: null,
          phone: null,
          now,
        });
      }
      return [];
    });
    await this.deleteStorageKeys(removedKeys);
  }

  /** Empfänger unter gehaltener Sperre setzen und die Kundenunterschrift entwerten. */
  private async replaceRecipientWithin(
    tx: DatabaseTransaction,
    handoverId: string,
    input: {
      kind: 'customer' | 'representative' | 'other' | null;
      name: string | null;
      phone: string | null;
      now: Date;
    },
  ): Promise<string[]> {
    await tx
      .update(handovers)
      .set({
        recipientKind: input.kind,
        recipientName: input.name,
        recipientPhone: input.phone,
        updatedAt: input.now,
      })
      .where(eq(handovers.id, handoverId));
    const removed = await tx
      .delete(handoverSignatures)
      .where(
        and(eq(handoverSignatures.handoverId, handoverId), eq(handoverSignatures.role, 'customer')),
      )
      .returning({ storageKey: handoverSignatures.storageKey });
    return removed.map((row) => row.storageKey);
  }

  private async deleteStorageKeys(keys: string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.storage.delete(key);
      } catch {
        // best effort – verwaistes Altobjekt ist unkritisch
      }
    }
  }

  async setRecipient(
    bookingId: string,
    input: {
      kind: 'customer' | 'representative' | 'other';
      name?: string | null;
      phone?: string | null;
    },
    now = new Date(),
  ): Promise<void> {
    const booking = await this.bookingById(bookingId);
    let name: string;
    let phone: string | null = null;
    if (input.kind === 'customer') {
      const customer = booking.customerSnapshot as Record<string, unknown>;
      name = String(customer.displayName ?? '').trim();
    } else if (input.kind === 'representative') {
      const rows = await this.db
        .select()
        .from(bookingPickupRepresentatives)
        .where(eq(bookingPickupRepresentatives.bookingId, bookingId));
      const representative = rows[0];
      if (representative === undefined) {
        throw new AuthError(
          'VALIDATION',
          'Für diese Buchung ist keine alternative Abholperson hinterlegt.',
        );
      }
      name = `${representative.firstName} ${representative.lastName}`.trim();
      phone = representative.phone;
    } else {
      name = (input.name ?? '').trim();
      if (name === '')
        throw new AuthError('VALIDATION', 'Bitte den Namen des Vertreters erfassen.');
      phone = input.phone?.trim() === '' ? null : (input.phone?.trim() ?? null);
    }
    if (name === '') throw new AuthError('VALIDATION', 'Der Name der Empfangsperson fehlt.');
    const removedKeys = await this.withDraftLock(bookingId, (tx, handover) =>
      // Eine bereits gezeichnete Kundenunterschrift gehört zum vorherigen Namen.
      this.replaceRecipientWithin(tx, handover.id, { kind: input.kind, name, phone, now }),
    );
    await this.deleteStorageKeys(removedKeys);
  }

  // ── Aktive Prüfung / Gesamtfoto (Order §§25/27) ─────────────────────────

  private async assignedSlot(bookingId: string, assignmentId: string) {
    const assignment = await this.assignments.assignmentById(assignmentId);
    if (assignment.bookingId !== bookingId)
      throw new AuthError('NOT_FOUND', 'Zuordnung nicht gefunden.');
    if (assignment.machineId === null) {
      throw new AuthError('VALIDATION', 'Für diesen Slot ist noch keine Maschine zugewiesen.');
    }
    return { assignment, machineId: assignment.machineId };
  }

  async checkMachine(
    actorId: string,
    bookingId: string,
    assignmentId: string,
    now = new Date(),
  ): Promise<void> {
    const { assignment, machineId } = await this.assignedSlot(bookingId, assignmentId);
    await this.withDraftLock(bookingId, async (tx, handover) => {
      await tx
        .insert(handoverMachineChecks)
        .values({
          handoverId: handover.id,
          assignmentId: assignment.id,
          machineId,
          checkedBy: actorId,
          checkedAt: now,
        })
        .onConflictDoUpdate({
          target: handoverMachineChecks.assignmentId,
          set: { machineId, checkedBy: actorId, checkedAt: now },
        });
    });
  }

  async addPhoto(
    actorId: string,
    bookingId: string,
    assignmentId: string,
    input: { bytes: Uint8Array; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' },
    now = new Date(),
  ): Promise<{ photoId: string }> {
    const handover = await this.assertDraft(bookingId);
    const { assignment, machineId } = await this.assignedSlot(bookingId, assignmentId);
    if (assignment.status === 'open' || assignment.status === 'returned') {
      throw new AuthError('VALIDATION', 'Für diesen Slot ist noch keine Maschine zugewiesen.');
    }
    if (!imageMagicMatches(input.bytes, input.mimeType)) {
      throw new AuthError(
        'VALIDATION',
        'Das Foto muss ein JPEG-, PNG- oder WebP-Bild sein und zum angegebenen Bildtyp passen.',
      );
    }
    const extension =
      input.mimeType === 'image/png' ? 'png' : input.mimeType === 'image/webp' ? 'webp' : 'jpg';
    const key = `handovers/${handover.id}/photos/${assignment.id}-${randomBytes(8).toString('hex')}.${extension}`;
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    await this.storage.put(key, input.bytes, { contentType: input.mimeType });
    try {
      return await this.withDraftLock(bookingId, async (tx) => {
        const inserted = await tx
          .insert(handoverPhotos)
          .values({
            handoverId: handover.id,
            assignmentId: assignment.id,
            machineId,
            storageKey: key,
            mimeType: input.mimeType,
            byteSize: input.bytes.length,
            sha256,
            takenBy: actorId,
            takenAt: now,
          })
          .returning({ id: handoverPhotos.id });
        return { photoId: inserted[0]!.id };
      });
    } catch (error) {
      try {
        await this.storage.delete(key);
      } catch {
        // best effort
      }
      throw error;
    }
  }

  /** Nur Metadaten (für die Sichtbarkeitsprüfung VOR jedem Storage-Zugriff). */
  async photoMeta(photoId: string): Promise<{ processId: string; mimeType: string }> {
    const rows = await this.db
      .select({ processId: handovers.processId, mimeType: handoverPhotos.mimeType })
      .from(handoverPhotos)
      .innerJoin(handovers, eq(handovers.id, handoverPhotos.handoverId))
      .where(eq(handoverPhotos.id, photoId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Foto nicht gefunden.');
    return row;
  }

  async photoBytes(
    photoId: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string; processId: string }> {
    const rows = await this.db
      .select({ photo: handoverPhotos, processId: handovers.processId })
      .from(handoverPhotos)
      .innerJoin(handovers, eq(handovers.id, handoverPhotos.handoverId))
      .where(eq(handoverPhotos.id, photoId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Foto nicht gefunden.');
    const bytes = await this.storage.get(row.photo.storageKey);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== row.photo.sha256) {
      throw new AuthError('CONFLICT', 'Foto-Integritätsprüfung fehlgeschlagen.');
    }
    return { bytes, mimeType: row.photo.mimeType, processId: row.processId };
  }

  // ── Unterschriften (Order §§33–35) ──────────────────────────────────────

  async sign(
    actorId: string,
    bookingId: string,
    role: 'customer' | 'staff',
    png: Uint8Array,
    now = new Date(),
  ): Promise<void> {
    const handover = await this.assertDraft(bookingId);
    if (!signaturePngLooksValid(png)) {
      throw new AuthError(
        'VALIDATION',
        'Die Unterschrift muss als darstellbares PNG-Bild (max. 2 MB) übermittelt werden.',
      );
    }
    let staffSignerName: string | null = null;
    if (role === 'staff') {
      // Der Unterzeichner ist IMMER die authentifizierte Session (Order §34).
      const rows = await this.db
        .select({ firstName: staffUsers.firstName, lastName: staffUsers.lastName })
        .from(staffUsers)
        .where(eq(staffUsers.id, actorId));
      const user = rows[0];
      if (user === undefined) throw new AuthError('NOT_FOUND', 'Mitarbeiter nicht gefunden.');
      staffSignerName = `${user.firstName} ${user.lastName}`.trim();
    } else if (handover.recipientKind === null || (handover.recipientName ?? '') === '') {
      throw new AuthError(
        'VALIDATION',
        'Bitte zuerst Kunde oder Vertreter für die Übergabe bestimmen.',
      );
    }
    const signerUserId = role === 'staff' ? actorId : null;
    const key = `handovers/${handover.id}/signatures/${role}-${randomBytes(8).toString('hex')}.png`;
    const sha256 = createHash('sha256').update(png).digest('hex');
    await this.storage.put(key, png, { contentType: 'image/png' });
    // Ersetzen unter Zeilensperre der Übergabe: serialisiert mit der
    // Finalisierung (Phase 2 hält dieselbe Sperre) und mit parallelen
    // Unterschriften derselben Rolle – nie zwei Zeilen, nie nach Abschluss.
    const replacedKeys = await this.db.transaction(async (tx) => {
      const locked = await tx
        .select({
          status: handovers.status,
          recipientKind: handovers.recipientKind,
          recipientName: handovers.recipientName,
        })
        .from(handovers)
        .where(eq(handovers.id, handover.id))
        .for('no key update');
      if (locked[0]?.status !== 'draft') {
        throw new AuthError(
          'CONFLICT',
          'Die Übergabe ist bereits abgeschlossen und unveränderlich.',
        );
      }
      // Der Kundenname stammt aus der GESPERRTEN Zeile – nie aus einem
      // ungesperrten Vorab-Read (Empfängerwechsel parallel zur Unterschrift).
      const signerName =
        staffSignerName ??
        (locked[0].recipientKind === null || (locked[0].recipientName ?? '') === ''
          ? null
          : (locked[0].recipientName ?? ''));
      if (signerName === null) {
        throw new AuthError(
          'VALIDATION',
          'Bitte zuerst Kunde oder Vertreter für die Übergabe bestimmen.',
        );
      }
      const old = await tx
        .delete(handoverSignatures)
        .where(
          and(eq(handoverSignatures.handoverId, handover.id), eq(handoverSignatures.role, role)),
        )
        .returning({ storageKey: handoverSignatures.storageKey });
      await tx.insert(handoverSignatures).values({
        handoverId: handover.id,
        role,
        signerName,
        signerUserId,
        storageKey: key,
        mimeType: 'image/png',
        byteSize: png.length,
        sha256,
        signedAt: now,
      });
      return old.map((row) => row.storageKey);
    });
    for (const replaced of replacedKeys) {
      try {
        await this.storage.delete(replaced);
      } catch {
        // best effort – verwaistes Altobjekt ist unkritisch
      }
    }
  }

  async signatureBytes(bookingId: string, role: 'customer' | 'staff'): Promise<Uint8Array> {
    const handover = await this.handoverFor(bookingId);
    const rows = await this.db
      .select()
      .from(handoverSignatures)
      .where(
        and(eq(handoverSignatures.handoverId, handover.id), eq(handoverSignatures.role, role)),
      );
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Unterschrift nicht vorhanden.');
    return this.storage.get(row.storageKey);
  }

  // ── PDF-Daten ───────────────────────────────────────────────────────────

  private async deliveryNotePdf(
    view: HandoverDetailView,
    isFinal: boolean,
    now: Date,
  ): Promise<Buffer> {
    const booking = await this.bookingById(view.booking.id);
    const customer = booking.customerSnapshot as Record<string, unknown>;
    const scheduleLabel =
      view.handover.appointment?.startAt === null || view.handover.appointment === null
        ? null
        : `${view.booking.fulfillment === 'pickup' ? 'Abholung' : 'Lieferung'}: ${berlin(new Date(view.handover.appointment.startAt as string))}${
            view.handover.appointment.endAt === null
              ? ''
              : ` – ${berlin(new Date(view.handover.appointment.endAt))}`
          }`;
    return renderDeliveryNotePdf({
      processNumber: view.booking.processNumber,
      customerName: view.booking.customerName,
      customerAddressLines: [
        String(customer.billingStreet ?? '') || null,
        [customer.billingPostalCode, customer.billingCity].filter(Boolean).join(' ') || null,
      ].filter((line): line is string => line !== null),
      eventDateLabel: view.booking.eventDate ?? '–',
      eventTimeLabel: view.booking.eventTimeLabel,
      fulfillmentLabel: view.booking.fulfillment === 'pickup' ? 'Selbstabholung' : 'Lieferung',
      deliveryAddressLines: view.booking.deliveryAddressLines.map((line, index) =>
        index === 0 ? `Lieferadresse: ${line}` : line,
      ),
      scheduleLabel,
      machines: view.slots.map((slot) => ({
        machineCode: slot.machine?.machineCode ?? '– (nicht zugewiesen)',
        typeName: slot.productName,
      })),
      items: view.deliveryNote.items
        .filter((item) => item.actualQuantity > 0)
        .map((item) => ({
          description: item.description,
          quantity: item.actualQuantity,
          unit: item.unit,
          kindLabel: item.kindLabel,
        })),
      createdAtLabel: now.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' }),
      isFinal,
    });
  }

  async renderDeliveryNotePreview(bookingId: string, now = new Date()): Promise<Buffer> {
    const view = await this.detail(bookingId, now);
    return this.deliveryNotePdf(view, false, now);
  }

  // ── Finalisierung (Order §§40/41/43/44) ─────────────────────────────────

  /**
   * Zweiphasig: (1) alle Vorbedingungen prüfen, PDFs rendern und in den
   * Storage laden – ohne Fachzustand; (2) EINE Transaktion unter
   * Advisory-Lock: Dokumente registrieren, Lagerbewegungen, Assignments →
   * issued, Maschinen → Vermietet/Kunde, Termin abschließen, Lieferschein
   * final, Übergabe final, Dokumentpaket versandbereit. Idempotent: eine
   * bereits abgeschlossene Übergabe liefert dieselbe Antwort ohne neue
   * Bewegungen/Dokumente; Storage-Fehler vor Phase 2 hinterlassen nichts,
   * Fehler in Phase 2 höchstens unreferenzierte Storage-Objekte.
   */
  async finalize(
    actorId: string,
    bookingId: string,
    options: { actualIssueAt?: Date | null } = {},
    now = new Date(),
  ): Promise<HandoverDetailView> {
    return this.finalizeMutex.run(`finalize:${bookingId}`, () =>
      this.finalizeExclusive(actorId, bookingId, options, now),
    );
  }

  private async finalizeExclusive(
    actorId: string,
    bookingId: string,
    options: { actualIssueAt?: Date | null },
    now: Date,
  ): Promise<HandoverDetailView> {
    const view = await this.detail(bookingId, now);
    if (view.handover.status === 'finalized') return view;
    if (view.blockers.length > 0) {
      throw new AuthError(
        'CONFLICT',
        `Übergabe kann noch nicht abgeschlossen werden: ${view.blockers.join(' ')}`,
      );
    }
    const handover = await this.handoverFor(bookingId);
    const booking = await this.bookingById(bookingId);
    const phase1Fingerprint = finalizationFingerprint(view);
    // Phase 1: Signaturen laden, PDFs rendern, hochladen (neue Keys je Versuch).
    const customerPng = await this.signatureBytes(bookingId, 'customer');
    const staffPng = await this.signatureBytes(bookingId, 'staff');
    const signatureRows = await this.db
      .select()
      .from(handoverSignatures)
      .where(eq(handoverSignatures.handoverId, handover.id));
    const customerSig = signatureRows.find((row) => row.role === 'customer')!;
    const staffSig = signatureRows.find((row) => row.role === 'staff')!;
    const machineSections = [];
    for (const slot of view.slots) {
      const damages =
        slot.machine === null ? [] : await this.damages.existingDamagesFor(slot.machine.id);
      const check = view.machines.find((m) => m.assignmentId === slot.id);
      machineSections.push({
        machineCode: slot.machine?.machineCode ?? '–',
        typeName: slot.productName,
        checkedLabel:
          check?.checkedAt === null || check?.checkedAt === undefined
            ? 'nicht bestätigt'
            : `Maschine gemeinsam geprüft (${berlin(new Date(check.checkedAt))})`,
        existingDamagesLines:
          damages.length === 0
            ? ['Keine bestehenden Schäden dokumentiert.']
            : damages.map((d) => d.summary),
        notes: [],
      });
    }
    const finalizedAt = now;
    let protocolPdf: Buffer;
    try {
      protocolPdf = await renderHandoverProtocolPdf({
        processNumber: view.booking.processNumber,
        customerName: view.booking.customerName,
        recipientLabel: `${view.handover.recipientName ?? ''} (${RECIPIENT_KIND_LABELS[view.handover.recipientKind ?? 'customer']})`,
        eventDateLabel: view.booking.eventDate ?? '–',
        fulfillmentLabel: view.booking.fulfillment === 'pickup' ? 'Selbstabholung' : 'Lieferung',
        machines: machineSections,
        itemLines: view.deliveryNote.items
          .filter((item) => item.actualQuantity > 0)
          .map(
            (item) =>
              `${item.description}: ${item.actualQuantity} ${item.unit} (${item.kindLabel})`,
          ),
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
        documentReference: handover.id,
      });
    } catch (error) {
      if (error instanceof SignatureImageError) {
        throw new AuthError('VALIDATION', `${error.message} Bitte erneut unterschreiben.`);
      }
      throw error;
    }
    const deliveryNotePdf = await this.deliveryNotePdf(view, true, now);
    const attempt = `${finalizedAt.getTime()}-${randomBytes(4).toString('hex')}`;
    const deliveryNoteKey = `documents/delivery-notes/${handover.id}-${attempt}.pdf`;
    const protocolKey = `documents/handover-protocols/${handover.id}-${attempt}.pdf`;
    const deliveryNoteUpload = await this.documentService.uploadBytes(
      deliveryNoteKey,
      deliveryNotePdf,
    );
    const protocolUpload = await this.documentService.uploadBytes(protocolKey, protocolPdf);

    // Phase 2: fachlich atomare Transaktion.
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${'handover-finalize:' + handover.id}))`,
      );
      const lockedRows = await tx
        .select()
        .from(handovers)
        .where(eq(handovers.id, handover.id))
        .for('no key update');
      const locked = lockedRows[0];
      if (locked === undefined) throw new AuthError('NOT_FOUND', 'Übergabe nicht gefunden.');
      if (locked.status === 'finalized') return; // idempotent – parallele Finalisierung

      // Sperrreihenfolge wie im AssignmentService: erst die Slot-Zeilen, dann
      // die Advisory-Locks aller Maschinen (sortiert) – parallele Zuweisungen,
      // Vorbereitungen und fremde Finalisierungen derselben Maschine warten,
      // bis diese Finalisierung entschieden ist.
      const slotRows = await tx
        .select({ id: machineAssignments.id, machineId: machineAssignments.machineId })
        .from(machineAssignments)
        .where(eq(machineAssignments.bookingId, bookingId))
        .orderBy(asc(machineAssignments.slotNo))
        .for('no key update');
      const lockedMachineIds = [
        ...new Set(slotRows.map((row) => row.machineId).filter((id): id is string => id !== null)),
      ].sort();
      for (const machineId of lockedMachineIds) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${'machine-assign:' + machineId}))`,
        );
      }

      // Vorbedingungen unter Sperre erneut prüfen (kein TOCTOU).
      const fresh = await this.detail(bookingId, now);
      if (fresh.blockers.length > 0) {
        throw new AuthError(
          'CONFLICT',
          `Übergabe kann noch nicht abgeschlossen werden: ${fresh.blockers.join(' ')}`,
        );
      }
      const freshSignatures = await tx
        .select({ role: handoverSignatures.role, sha256: handoverSignatures.sha256 })
        .from(handoverSignatures)
        .where(eq(handoverSignatures.handoverId, handover.id));
      const freshSha = (role: 'customer' | 'staff') =>
        freshSignatures.find((row) => row.role === role)?.sha256 ?? null;
      if (
        finalizationFingerprint(fresh) !== phase1Fingerprint ||
        freshSha('customer') !== customerSig.sha256 ||
        freshSha('staff') !== staffSig.sha256
      ) {
        throw new AuthError(
          'CONFLICT',
          'Die Übergabedaten wurden zwischenzeitlich geändert (Mengen, Maschinen, Empfänger oder Unterschriften). Bitte den Abschluss erneut auslösen.',
        );
      }

      const processRows = await tx
        .select({ processNumber: processes.processNumber })
        .from(processes)
        .where(eq(processes.id, booking.processId));
      const processNumber = processRows[0]?.processNumber ?? '';

      const deliveryNoteDocument = await this.documentService.registerUploaded(tx, {
        type: 'delivery_note',
        processId: booking.processId,
        bookingId,
        storageKey: deliveryNoteKey,
        sha256: deliveryNoteUpload.sha256,
        byteSize: deliveryNotePdf.length,
      });
      const protocolDocument = await this.documentService.registerUploaded(tx, {
        type: 'handover_protocol',
        processId: booking.processId,
        bookingId,
        storageKey: protocolKey,
        sha256: protocolUpload.sha256,
        byteSize: protocolPdf.length,
      });

      // Lagerbewegungen: je Lagerartikel EINE issue-Bewegung über das Ledger.
      const required = new Map<string, number>();
      for (const item of fresh.deliveryNote.items) {
        if (item.inventoryItemId === null || item.actualQuantity <= 0) continue;
        required.set(
          item.inventoryItemId,
          (required.get(item.inventoryItemId) ?? 0) + item.actualQuantity,
        );
      }
      for (const [inventoryItemId, quantity] of [...required.entries()].sort((a, b) =>
        a[0].localeCompare(b[0]),
      )) {
        try {
          await this.inventory.issueWithin(tx, actorId, inventoryItemId, quantity);
        } catch (error) {
          if (error instanceof AuthError && error.code === 'VALIDATION') {
            throw new AuthError(
              'CONFLICT',
              `Lagerbestand prüfen: Für die Ausgabe reicht der Systembestand nicht aus (${error.message}). Bitte Wareneingang erfassen, Bestand/Inventur prüfen oder die Ausgabemenge korrigieren.`,
            );
          }
          throw error;
        }
      }

      // Assignments → issued, Maschinen → Vermietet beim Kunden.
      for (const slot of fresh.slots) {
        if (slot.machine === null) continue;
        const issued = await tx
          .update(machineAssignments)
          .set({ status: 'issued', issuedAt: finalizedAt, updatedAt: finalizedAt })
          .where(
            and(
              eq(machineAssignments.id, slot.id),
              eq(machineAssignments.machineId, slot.machine.id),
              eq(machineAssignments.status, 'prepared'),
            ),
          )
          .returning({ id: machineAssignments.id });
        if (issued.length !== 1) {
          throw new AuthError(
            'CONFLICT',
            `Maschine ${slot.machine.machineCode}: Die Zuordnung wurde zwischenzeitlich geändert – bitte die Vorbereitung prüfen und den Abschluss erneut auslösen.`,
          );
        }
        await this.machineService.applyProcessStatus(
          tx,
          slot.machine.id,
          'rented',
          { locationKind: 'customer', locationNote: processNumber },
          finalizedAt,
        );
      }

      // Ausgabe-/Liefertermin fachlich abschließen (Order §44).
      let appointmentId: string | null = null;
      if (fresh.handover.appointment !== null) {
        appointmentId = fresh.handover.appointment.id;
        await this.scheduling.completeWithin(tx, actorId, appointmentId, finalizedAt);
      }

      await tx
        .update(deliveryNotes)
        .set({
          status: 'final',
          documentId: deliveryNoteDocument.id,
          finalizedAt,
          updatedAt: finalizedAt,
        })
        .where(eq(deliveryNotes.bookingId, bookingId));

      // Primärzeit ist der Abschluss (Unterschriften); eine tatsächliche
      // Ausgabezeit wird nur gespeichert, wenn sie davon abweicht (Order §43).
      const actualIssueAt =
        options.actualIssueAt !== null &&
        options.actualIssueAt !== undefined &&
        Math.abs(options.actualIssueAt.getTime() - finalizedAt.getTime()) > 60_000
          ? options.actualIssueAt
          : null;
      await tx
        .update(handovers)
        .set({
          status: 'finalized',
          finalizedAt,
          finalizedBy: actorId,
          appointmentId,
          protocolDocumentId: protocolDocument.id,
          actualIssueAt,
          actualIssueCorrectedBy: actualIssueAt === null ? null : actorId,
          actualIssueCorrectedAt: actualIssueAt === null ? null : finalizedAt,
          // Ephemere Telefonnummern werden mit Abschluss gelöscht (MASTER_SPEC §12).
          recipientPhone: null,
          updatedAt: finalizedAt,
        })
        .where(eq(handovers.id, handover.id));
      await tx
        .update(bookingPickupRepresentatives)
        .set({ phone: null, phoneDeletedAt: finalizedAt, updatedAt: finalizedAt })
        .where(eq(bookingPickupRepresentatives.bookingId, bookingId));

      // Dokumentpaket (Order §39): genau EIN Paket je Übergabe, versandbereit.
      const customer = booking.customerSnapshot as Record<string, unknown>;
      await tx
        .insert(deliveryPackets)
        .values({
          kind: 'handover_completed',
          processId: booking.processId,
          bookingId,
          handoverId: handover.id,
          recipient: typeof customer.email === 'string' ? customer.email : '',
          subject: `Ihre Miet-Royal-Ausgabe ${processNumber}: Lieferschein und Übergabeprotokoll`,
          body:
            `Guten Tag ${String(customer.displayName ?? '')},\n\n` +
            `anbei erhalten Sie den Lieferschein und das Übergabeprotokoll zu Vorgang ${processNumber}.\n\n` +
            'Mit freundlichen Grüßen\nMiet-Royal Mainz',
          documentIds: [deliveryNoteDocument.id, protocolDocument.id],
          status: 'ready',
        })
        .onConflictDoNothing({ target: [deliveryPackets.handoverId, deliveryPackets.kind] });
    });
    await this.assignments.refreshRiskIncidents(now);
    return this.detail(bookingId, now);
  }

  // ── Ausgabe-Ansicht (Order §12) ─────────────────────────────────────────

  async listForDay(
    dayIso: string,
    visibility: ProcessVisibilityContext,
  ): Promise<IssueListEntry[]> {
    const result: IssueListEntry[] = [];
    const rows = await this.db
      .select({
        booking: bookings,
        processNumber: processes.processNumber,
        mainStatus: processes.mainStatus,
      })
      .from(bookings)
      .innerJoin(processes, eq(processes.id, bookings.processId))
      // Phase-2-Sichtbarkeitsregel gilt auch für die Ausgabe-Liste (Order §57).
      .where(and(ne(processes.mainStatus, 'cancelled'), visibleProcessesWhere(visibility)));
    for (const row of rows) {
      const appointment = await this.outboundAppointment(row.booking.id);
      const handoverRows = await this.db
        .select({ status: handovers.status })
        .from(handovers)
        .where(eq(handovers.bookingId, row.booking.id));
      const handoverStatus = handoverRows[0]?.status ?? null;
      if (handoverStatus === 'finalized') continue;
      const startAt = appointment?.startAt ?? null;
      const unscheduled = appointment === null || startAt === null;
      if (!unscheduled) {
        const berlinDay = startAt.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
        if (berlinDay !== dayIso) continue;
      } else if (row.mainStatus !== 'open' && row.mainStatus !== 'reopened') {
        continue;
      }
      const slots = await this.db
        .select({ status: machineAssignments.status })
        .from(machineAssignments)
        .where(eq(machineAssignments.bookingId, row.booking.id));
      const preparedCount = slots.filter(
        (slot) => slot.status === 'prepared' || slot.status === 'issued',
      ).length;
      let assigneeName: string | null = null;
      if (appointment?.assignedUserId) {
        const users = await this.db
          .select({ firstName: staffUsers.firstName, lastName: staffUsers.lastName })
          .from(staffUsers)
          .where(eq(staffUsers.id, appointment.assignedUserId));
        assigneeName =
          users[0] === undefined ? null : `${users[0].firstName} ${users[0].lastName}`.trim();
      }
      const customer = row.booking.customerSnapshot as Record<string, unknown>;
      const machine = this.machineItemOf(row.booking);
      result.push({
        bookingId: row.booking.id,
        processId: row.booking.processId,
        processNumber: row.processNumber,
        customerName: String(customer.displayName ?? ''),
        fulfillment: row.booking.fulfillment,
        machineTypeName: machine.typeName,
        machineQuantity: machine.quantity,
        appointmentKind: appointment?.kind ?? null,
        startAt: startAt?.toISOString() ?? null,
        endAt: appointment?.endAt?.toISOString() ?? null,
        assigneeName,
        handoverStatus,
        preparation:
          slots.length === 0 || preparedCount === 0
            ? 'none'
            : preparedCount < slots.length
              ? 'partial'
              : 'prepared',
        unscheduled,
      });
    }
    return result.sort((a, b) => (a.startAt ?? '9').localeCompare(b.startAt ?? '9'));
  }

  async listPackets(processId: string) {
    const rows = await this.db
      .select()
      .from(deliveryPackets)
      .where(eq(deliveryPackets.processId, processId))
      .orderBy(asc(deliveryPackets.createdAt));
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      recipient: row.recipient,
      subject: row.subject,
      status: row.status,
      sentAt: row.sentAt?.toISOString() ?? null,
      documentIds: row.documentIds as string[],
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** Dokument-Metadaten der Übergabe (für Vorgang/Übergabe-UI). */
  async documentsFor(
    bookingId: string,
  ): Promise<{ id: string; type: string; createdAt: string; sha256: string }[]> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.bookingId, bookingId),
          inArray(documents.type, ['delivery_note', 'handover_protocol']),
        ),
      )
      .orderBy(asc(documents.createdAt));
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      createdAt: row.createdAt.toISOString(),
      sha256: row.sha256,
    }));
  }
}
