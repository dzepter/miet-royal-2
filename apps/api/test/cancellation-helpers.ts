import type pg from 'pg';
import { appointments, bookings, machineAssignments } from '@mietroyal/database';
import type { PermissionKey } from '@mietroyal/permissions';
import { asc, eq } from 'drizzle-orm';
import { AccountingTransferService } from '../src/accounting/transfer-service.ts';
import {
  CancellationService,
  type CancellationView,
  type CancellationViewer,
} from '../src/cancellation/cancellation-service.ts';
import { OutboxCancellationConfirmationGateway } from '../src/cancellation/confirmation-gateway.ts';
import { ProcessService } from '../src/crm/process-service.ts';
import { AssignmentService } from '../src/handover/assignment-service.ts';
import { SchedulingService } from '../src/scheduling/scheduling-service.ts';
import { MachineService } from '../src/warehouse/machine-service.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  login,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import {
  commerceServices,
  createCommerceWorld,
  inquiryServiceFor,
  productServiceFor,
  truncateCommerceTables,
} from './commerce-helpers.ts';
import { createStaffWithPermissions, truncateCrmTables } from './crm-helpers.ts';
import { truncateHandoverTables } from './handover-helpers.ts';
import { schedulingServiceFor, truncateSchedulingTables } from './scheduling-helpers.ts';
import { resetWarehouse } from './warehouse-helpers.ts';

/** Phase-9-Finanztabellen leeren (vor den Handover-/Commerce-Resets). */
export async function truncateFinanceTables(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE process_relations, cancellations, accounting_transfers,
     booking_advance_payments, booking_security_deposits,
     settlement_customer_notices, settlement_clarifications, settlement_lines, settlements,
     integration_jobs CASCADE`,
  );
}

/** Vollständiger Reset für Storno-Tests (Reihenfolge beachtet Fremdschlüssel). */
export async function resetForCancellationTests(ctx: TestContext): Promise<void> {
  await truncateFinanceTables(ctx.pool);
  await truncateHandoverTables(ctx.pool);
  await resetWarehouse(ctx.pool);
  await truncateSchedulingTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
  ctx.accounting.calls.length = 0;
  ctx.accounting.failNext(0);
}

export async function adminSession(ctx: TestContext) {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  const effective = await ctx.auth.effectivePermissions(admin.id);
  return { admin, cookie: session.cookie, effective };
}

export const adminViewer = (effective: ReadonlySet<PermissionKey>): CancellationViewer => ({
  permissions: effective,
  isAdmin: true,
});

export function transfersFor(ctx: TestContext): AccountingTransferService {
  return new AccountingTransferService(ctx.db, ctx.accounting, ctx.queue);
}

export interface CancellationTestServices {
  service: CancellationService;
  transfers: AccountingTransferService;
  assignments: AssignmentService;
  scheduling: SchedulingService;
  confirmations: OutboxCancellationConfirmationGateway;
}

/** Komposition wie in der App (Mock-Buchhaltung des TestContext, Outbox-Bestätigung). */
export function cancellationServicesFor(ctx: TestContext): CancellationTestServices {
  const transfers = transfersFor(ctx);
  const machineService = new MachineService(ctx.db, ctx.storage);
  const assignments = new AssignmentService(ctx.db, machineService, ctx.storage);
  const scheduling = new SchedulingService(ctx.db);
  const confirmations = new OutboxCancellationConfirmationGateway();
  const service = new CancellationService({
    db: ctx.db,
    config: ctx.config,
    transfers,
    assignments,
    scheduling,
    processes: new ProcessService(ctx.db),
    confirmations,
  });
  return { service, transfers, assignments, scheduling, confirmations };
}

export const DAY_MS = 86_400_000;

/** Kalenderdatum (JJJJ-MM-TT) in Europe/Berlin zu einem Zeitpunkt. */
export function berlinDateOf(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** Eventdatum genau `days` Berliner Kalendertage nach `now`. */
export function eventDateInDays(days: number, now = new Date()): string {
  const [y, m, d] = berlinDateOf(now).split('-').map(Number);
  const base = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}

export interface BookedProcess {
  processId: string;
  bookingId: string;
  customerId: string;
  machineProductId: string;
  processNumber: string;
  appointmentIds: string[];
}

/**
 * Bestätigte Buchung über den ECHTEN Annahmepfad (Anfrage → Angebot →
 * optional Rabatt/Sonderpreis/Lieferpreis → Versand → Annahme) inkl.
 * Terminen. Eventdatum als Berliner Kalendertag.
 */
export async function bookedProcess(
  ctx: TestContext,
  adminId: string,
  options: {
    eventDate?: string;
    eventInDays?: number;
    fulfillment?: 'pickup' | 'delivery';
    machineSlug?: string;
    machineQuantity?: number;
    selections?: { slug: string; role: 'free' | 'extra'; quantity: number }[];
    discount?: { type: 'percent' | 'fixed'; value: number; reason?: string };
    specialMachinePriceCents?: number;
    deliveryPriceCents?: number;
  } = {},
): Promise<BookedProcess> {
  const fulfillment = options.fulfillment ?? 'pickup';
  const world = await createCommerceWorld(ctx, adminId, { fulfillment });
  const products = productServiceFor(ctx);
  const machine = await products.getProductBySlug(options.machineSlug ?? 'slush-1x10');
  const selections = [];
  for (const selection of options.selections ?? []) {
    const product = await products.getProductBySlug(selection.slug);
    selections.push({ productId: product.id, role: selection.role, quantity: selection.quantity });
  }
  const eventDate = options.eventDate ?? eventDateInDays(options.eventInDays ?? 30);
  await inquiryServiceFor(ctx).upsertForProcess(adminId, world.processId, {
    eventDate,
    eventStart: null,
    eventEnd: null,
    guestCount: 40,
    occasion: 'birthday',
    machineProductId: machine.id,
    fulfillment,
    deliveryStreet: fulfillment === 'delivery' ? 'Lieferweg 12' : null,
    deliveryPostalCode: fulfillment === 'delivery' ? '55129' : null,
    deliveryCity: fulfillment === 'delivery' ? 'Mainz' : null,
    deliveryWindowFrom: null,
    deliveryWindowTo: null,
    collectionWindowFrom: null,
    collectionWindowTo: null,
    selections,
  });
  const services = commerceServices(ctx);
  const effective = await ctx.auth.effectivePermissions(adminId);
  const { versionId } = await services.offers.createOffer(adminId, world.processId);
  const draft: Record<string, unknown> = {};
  if (options.machineQuantity !== undefined) draft.machineQuantity = options.machineQuantity;
  if (options.deliveryPriceCents !== undefined)
    draft.deliveryPriceCents = options.deliveryPriceCents;
  if (Object.keys(draft).length > 0) await services.offers.updateDraft(adminId, versionId, draft);
  if (options.specialMachinePriceCents !== undefined) {
    await services.offers.setSpecialPrice(adminId, versionId, effective, {
      lineKey: 'machine',
      unitPriceCents: options.specialMachinePriceCents,
    });
  }
  if (options.discount !== undefined) {
    await services.offers.setDiscount(adminId, versionId, effective, {
      type: options.discount.type,
      value: options.discount.value,
      reason: options.discount.reason ?? 'Testrabatt',
    });
    await services.offers.approveDiscount(adminId, versionId);
  }
  const { token } = await services.offers.send(adminId, versionId, effective);
  const { bookingId } = await services.offers.accept(token);
  await schedulingServiceFor(ctx).ensureAppointmentsForBooking(bookingId);
  const appointmentRows = await ctx.db
    .select({ id: appointments.id })
    .from(appointments)
    .where(eq(appointments.bookingId, bookingId))
    .orderBy(asc(appointments.kind));
  const processRows = await ctx.pool.query('SELECT process_number FROM processes WHERE id = $1', [
    world.processId,
  ]);
  return {
    processId: world.processId,
    bookingId,
    customerId: world.customerId,
    machineProductId: machine.id,
    processNumber: processRows.rows[0].process_number as string,
    appointmentIds: appointmentRows.map((row) => row.id),
  };
}

/** Storno über den Service (Admin) – Abkürzung für Folgetests. */
export async function cancelBooking(
  ctx: TestContext,
  adminId: string,
  processId: string,
  now = new Date(),
): Promise<CancellationView> {
  const { service } = cancellationServicesFor(ctx);
  const effective = await ctx.auth.effectivePermissions(adminId);
  return service.cancel(processId, { id: adminId, type: 'admin' }, adminViewer(effective), now);
}

export async function staffWith(
  ctx: TestContext,
  adminId: string,
  permissionKeys: readonly PermissionKey[],
  label = 'Staff',
) {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]/g, '')}-${permissionKeys.length}@test.example`;
  return createStaffWithPermissions(ctx, adminId, {
    firstName: label,
    lastName: 'Test',
    email,
    password: `${label.toLowerCase()}-passwort-12345`,
    permissionKeys,
  });
}

export async function assignmentsOf(ctx: TestContext, bookingId: string) {
  return ctx.db
    .select()
    .from(machineAssignments)
    .where(eq(machineAssignments.bookingId, bookingId))
    .orderBy(asc(machineAssignments.slotNo));
}

export async function appointmentsOf(ctx: TestContext, bookingId: string) {
  return ctx.db
    .select()
    .from(appointments)
    .where(eq(appointments.bookingId, bookingId))
    .orderBy(asc(appointments.kind));
}

export async function bookingRow(ctx: TestContext, bookingId: string) {
  return (await ctx.db.select().from(bookings).where(eq(bookings.id, bookingId)))[0]!;
}
