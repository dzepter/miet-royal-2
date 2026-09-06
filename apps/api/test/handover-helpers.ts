import type pg from 'pg';
import { appointments } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { DocumentService } from '../src/commerce/document-service.ts';
import { ProductService } from '../src/commerce/product-service.ts';
import { AssignmentService } from '../src/handover/assignment-service.ts';
import { HandoverService } from '../src/handover/handover-service.ts';
import { SchedulingService } from '../src/scheduling/scheduling-service.ts';
import { InventoryService } from '../src/warehouse/inventory-service.ts';
import { MachineService } from '../src/warehouse/machine-service.ts';
import type { TestContext } from './auth-helpers.ts';
import { productServiceFor } from './commerce-helpers.ts';
import { createAcceptedBooking, schedulingServiceFor } from './scheduling-helpers.ts';
import { machineByCode } from './warehouse-helpers.ts';

/** Phase-6-Tabellen leeren – VOR resetWarehouse (FK auf machines) aufrufen. */
export async function truncateHandoverTables(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE delivery_packets, handover_signatures, handover_photos, handover_machine_checks,
     handovers, delivery_note_items, delivery_notes, booking_additions,
     booking_pickup_representatives, machine_risk_incidents,
     machine_assignment_overrides, machine_assignments CASCADE`,
  );
}

export interface HandoverServices {
  machineService: MachineService;
  assignments: AssignmentService;
  inventory: InventoryService;
  documentService: DocumentService;
  productService: ProductService;
  scheduling: SchedulingService;
  handover: HandoverService;
}

export function handoverServicesFor(ctx: TestContext): HandoverServices {
  const machineService = new MachineService(ctx.db, ctx.storage);
  const assignments = new AssignmentService(ctx.db, machineService, ctx.storage);
  const inventory = new InventoryService(ctx.db);
  const documentService = new DocumentService(ctx.db, ctx.storage);
  const productService = new ProductService(ctx.db);
  const scheduling = new SchedulingService(ctx.db);
  const handover = new HandoverService(
    ctx.db,
    ctx.storage,
    assignments,
    inventory,
    machineService,
    documentService,
    productService,
    scheduling,
  );
  return {
    machineService,
    assignments,
    inventory,
    documentService,
    productService,
    scheduling,
    handover,
  };
}

export const HOURS = 3_600_000;
export const DAYS = 24 * HOURS;

/** Minimal gültiges PNG (1×1 Pixel) – für Fotos und Unterschriften. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export function pngBytes(): Uint8Array {
  return new Uint8Array(PNG_1X1);
}

export interface ScheduledBooking {
  processId: string;
  bookingId: string;
  customerId: string;
  machineProductId: string;
  outboundAppointmentId: string;
  returnAppointmentId: string;
}

/**
 * Bestätigte Buchung mit vollständigem Mietzeitraum (Abhol-/Liefertermin →
 * Rückgabetermin) über die echten Phase-3/4-Wege.
 */
export async function scheduledBooking(
  ctx: TestContext,
  adminId: string,
  options: {
    machineSlug?: string;
    machineQuantity?: number;
    fulfillment?: 'pickup' | 'delivery';
    from?: Date;
    to?: Date;
    selections?: { slug: string; role: 'free' | 'extra'; quantity: number }[];
    assignProcessTo?: string;
  } = {},
): Promise<ScheduledBooking> {
  const products = productServiceFor(ctx);
  const selections = [];
  for (const selection of options.selections ?? []) {
    const product = await products.getProductBySlug(selection.slug);
    selections.push({ productId: product.id, role: selection.role, quantity: selection.quantity });
  }
  const world = await createAcceptedBooking(ctx, adminId, {
    fulfillment: options.fulfillment ?? 'pickup',
    machineSlug: options.machineSlug ?? 'slush-1x10',
    ...(options.machineQuantity === undefined ? {} : { machineQuantity: options.machineQuantity }),
    ...(options.assignProcessTo === undefined ? {} : { assignProcessTo: options.assignProcessTo }),
    selections,
  });
  const scheduling = schedulingServiceFor(ctx);
  await scheduling.ensureAppointmentsForBooking(world.bookingId);
  const rows = await ctx.db
    .select()
    .from(appointments)
    .where(eq(appointments.bookingId, world.bookingId));
  const outbound = rows.find((row) => row.kind === 'pickup' || row.kind === 'delivery')!;
  const inbound = rows.find((row) => row.kind === 'return')!;
  const from = options.from ?? new Date(Date.now() + 1 * DAYS);
  const to = options.to ?? new Date(Date.now() + 3 * DAYS);
  await scheduling.reschedule(adminId, outbound.id, {
    startAt: from,
    endAt: null,
    expectedVersion: outbound.version,
  });
  await scheduling.reschedule(adminId, inbound.id, {
    startAt: to,
    endAt: null,
    expectedVersion: inbound.version,
  });
  return {
    processId: world.processId,
    bookingId: world.bookingId,
    customerId: world.customerId,
    machineProductId: world.machineId,
    outboundAppointmentId: outbound.id,
    returnAppointmentId: inbound.id,
  };
}

/** Alle Lagerartikel per Erstinventur auf `stock` initialisieren. */
export async function initializeAllInventory(
  ctx: TestContext,
  adminId: string,
  stock = 50,
): Promise<void> {
  const inventory = new InventoryService(ctx.db);
  const items = await inventory.listItems();
  const stocktake = await inventory.createStocktake(
    adminId,
    items.map((item) => ({ itemId: item.itemId, countedStock: stock })),
  );
  if (stocktake.status === 'pending_approval') {
    await inventory.approveStocktake(adminId, stocktake.id);
  }
}

/**
 * Übergabe bis unmittelbar VOR die Finalisierung bringen: Maschinen
 * zuweisen + vorbereiten, Empfänger, Prüfung, Gesamtfoto, beide
 * Unterschriften. Lagerbestände müssen vorher initialisiert sein.
 */
export async function readyHandover(
  ctx: TestContext,
  adminId: string,
  bookingId: string,
  machineCodes: string[],
): Promise<void> {
  const services = handoverServicesFor(ctx);
  const effective = await ctx.auth.effectivePermissions(adminId);
  await services.handover.ensureForBooking(bookingId, adminId);
  const slots = await services.assignments.slotsForBooking(bookingId);
  for (const [index, slot] of slots.entries()) {
    const code = machineCodes[index];
    if (code === undefined) throw new Error(`Kein Maschinencode für Slot ${slot.slotNo}`);
    const machine = await machineByCode(ctx.db, code);
    await services.assignments.assign(adminId, effective, slot.id, machine.id, null);
    await services.assignments.prepare(adminId, slot.id);
  }
  await services.handover.setRecipient(bookingId, { kind: 'customer' });
  for (const slot of slots) {
    await services.handover.checkMachine(adminId, bookingId, slot.id);
    await services.handover.addPhoto(adminId, bookingId, slot.id, {
      bytes: pngBytes(),
      mimeType: 'image/png',
    });
  }
  await services.handover.sign(adminId, bookingId, 'customer', pngBytes());
  await services.handover.sign(adminId, bookingId, 'staff', pngBytes());
}

/**
 * Klartext aus einem (unkomprimierten) pdfkit-PDF: pdfkit schreibt Text als
 * Hex-Strings – alle in Reihenfolge dekodieren und konkatenieren macht
 * Wörter/Zeilen prüfbar (gleiches Verfahren wie die Phase-3-Dokumenttests).
 */
export function pdfText(bytes: Uint8Array | Buffer): string {
  const raw = Buffer.from(bytes).toString('latin1');
  let out = '';
  for (const match of raw.matchAll(/<([0-9a-fA-F]+)>/g)) {
    const hex = match[1]!;
    if (hex.length % 2 === 0) out += Buffer.from(hex, 'hex').toString('latin1');
  }
  return `${raw}\n${out}`;
}
