import { appointments, settlements } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { AccountingTransferService } from '../src/accounting/transfer-service.ts';
import { ProcessService } from '../src/crm/process-service.ts';
import { SettlementService, type SettlementView } from '../src/settlement/settlement-service.ts';
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
import { truncateCrmTables } from './crm-helpers.ts';
import {
  DAYS,
  handoverServicesFor,
  initializeAllInventory,
  pngBytes,
  readyHandover,
  truncateHandoverTables,
  type HandoverServices,
  type ScheduledBooking,
} from './handover-helpers.ts';
import { jpegBytes, POINT_MARKER, readyReturn } from './return-helpers.ts';
import { schedulingServiceFor, truncateSchedulingTables } from './scheduling-helpers.ts';
import { resetWarehouse } from './warehouse-helpers.ts';

/**
 * Phase-9-Testbausteine: finalisierte Rückgabe über die ECHTEN Wege
 * (Annahme mit Rabatt/Lieferpreis, Termine, Ausgabe inkl. Kaufartikel,
 * Rückgabe mit Kommission/Reinigung/Schaden/Fehlteil, Finalisierung über
 * die echte Route – damit der Abrechnungs-Hook greift). Keine Rohdaten-
 * Fakes für Fakten, die Phase 6/7 erzeugt.
 */

export async function truncateSettlementTables(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE settlement_customer_notices, settlement_clarifications, settlement_lines,
     settlements, accounting_transfers, booking_advance_payments, booking_security_deposits,
     cancellations, process_relations, integration_jobs CASCADE`,
  );
}

/** Kompletter Reset aller beteiligten Tabellen + Mock-Zähler. */
export async function resetSettlementWorld(ctx: TestContext): Promise<void> {
  await truncateSettlementTables(ctx.pool);
  await truncateHandoverTables(ctx.pool);
  await resetWarehouse(ctx.pool);
  await truncateSchedulingTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
  ctx.accounting.calls.length = 0;
  ctx.accounting.failNext(0);
  ctx.notices.sent.length = 0;
}

export async function adminSession(ctx: TestContext) {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  const effective = await ctx.auth.effectivePermissions(admin.id);
  return { admin, cookie: session.cookie, effective };
}

/** Service-Instanz wie in den Routen (dieselbe Queue/dasselbe Gateway wie die App). */
export function settlementServiceFor(ctx: TestContext): SettlementService {
  return new SettlementService({
    db: ctx.db,
    transfers: new AccountingTransferService(ctx.db, ctx.accounting, ctx.queue),
    noticeGateway: ctx.notices,
    queue: ctx.queue,
    processes: new ProcessService(ctx.db),
    appEnv: ctx.config.appEnv,
  });
}

export interface FinalizedReturnOptions {
  machineCodes?: string[];
  machineSlug?: string;
  fulfillment?: 'pickup' | 'delivery';
  deliveryPriceCents?: number;
  discount?: { type: 'percent' | 'fixed'; value: number; reason?: string };
  /** Zusatz-/Gratisartikel der Anfrage (z. B. Kommission, Kaufartikel). */
  selections?: { slug: string; role: 'free' | 'extra'; quantity: number }[];
  /** Ungeöffnet zurückgegebene Mengen je Beschreibungs-Teilstring (nur Kommission/inklusive). */
  returnedUnopened?: { match: string; quantity: number; kind?: 'commission' | 'included' }[];
  /** Indizes der Maschinen mit Reinigungsmangel (75 € Fakt + Beweisfoto). */
  cleanupMachines?: number[];
  damages?: {
    machineIndex?: number;
    severity?: 'light' | 'medium' | 'severe';
    description: string;
  }[];
  missing?: { machineIndex?: number; accessoryType: 'lid' | 'drip_tray'; quantity: number }[];
  /** Zeitpunkt der Rückgabe-Finalisierung (Default: jetzt). */
  now?: Date;
  /**
   * Phase 11: liefert einen Gutscheincode des (gerade erzeugten) Kunden, der
   * im Entwurf VOR dem Versand angewendet wird (Agent O, voucher-offer-helpers).
   */
  voucherCodeFor?: (customerId: string) => Promise<string>;
}

export interface FinalizedReturn extends ScheduledBooking {
  machineCodes: string[];
  returnId: string;
  services: HandoverServices;
  returnMachineIds: string[];
  damageIds: string[];
  missingCaseIds: string[];
}

/** Bestätigte Buchung mit optionalem Rabatt/Lieferpreis über den echten Annahmepfad. */
async function acceptedBookingWithOptions(
  ctx: TestContext,
  adminId: string,
  options: FinalizedReturnOptions,
  machineQuantity: number,
): Promise<ScheduledBooking> {
  const fulfillment = options.fulfillment ?? 'pickup';
  const world = await createCommerceWorld(ctx, adminId, { eventInDays: 30, fulfillment });
  const products = productServiceFor(ctx);
  const machine = await products.getProductBySlug(options.machineSlug ?? 'slush-1x10');
  const selections = [];
  for (const selection of options.selections ?? []) {
    const product = await products.getProductBySlug(selection.slug);
    selections.push({ productId: product.id, role: selection.role, quantity: selection.quantity });
  }
  const eventDate = new Date(Date.now() + 30 * DAYS).toISOString().slice(0, 10);
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
  const { versionId } = await services.offers.createOffer(adminId, world.processId);
  if (machineQuantity !== 1 || options.deliveryPriceCents !== undefined) {
    await services.offers.updateDraft(adminId, versionId, {
      ...(machineQuantity === 1 ? {} : { machineQuantity }),
      ...(options.deliveryPriceCents === undefined
        ? {}
        : { deliveryPriceCents: options.deliveryPriceCents }),
    });
  }
  const effective = await ctx.auth.effectivePermissions(adminId);
  if (options.discount !== undefined) {
    await services.offers.setDiscount(adminId, versionId, effective, {
      type: options.discount.type,
      value: options.discount.value,
      reason: options.discount.reason ?? 'Testrabatt',
    });
    await services.offers.approveDiscount(adminId, versionId);
  }
  if (options.voucherCodeFor !== undefined) {
    const code = await options.voucherCodeFor(world.customerId);
    await services.offers.applyVoucher(adminId, versionId, code);
  }
  const { token } = await services.offers.send(adminId, versionId, effective);
  const { bookingId } = await services.offers.accept(token);
  const scheduling = schedulingServiceFor(ctx);
  await scheduling.ensureAppointmentsForBooking(bookingId);
  const rows = await ctx.db
    .select()
    .from(appointments)
    .where(eq(appointments.bookingId, bookingId));
  const outbound = rows.find((row) => row.kind === 'pickup' || row.kind === 'delivery')!;
  const inbound = rows.find((row) => row.kind === 'return')!;
  await scheduling.reschedule(adminId, outbound.id, {
    startAt: new Date(Date.now() + 1 * DAYS),
    endAt: null,
    expectedVersion: outbound.version,
  });
  await scheduling.reschedule(adminId, inbound.id, {
    startAt: new Date(Date.now() + 3 * DAYS),
    endAt: null,
    expectedVersion: inbound.version,
  });
  return {
    processId: world.processId,
    bookingId,
    customerId: world.customerId,
    machineProductId: machine.id,
    outboundAppointmentId: outbound.id,
    returnAppointmentId: inbound.id,
  };
}

/** Ausgegebene Buchung mit Optionen (Rabatt/Lieferung/Kaufartikel) – ohne Rückgabe. */
export async function issuedBookingWithOptions(
  ctx: TestContext,
  adminId: string,
  options: FinalizedReturnOptions = {},
): Promise<ScheduledBooking & { machineCodes: string[]; services: HandoverServices }> {
  const codes = options.machineCodes ?? ['MR-10-01-01'];
  await initializeAllInventory(ctx, adminId, 20);
  const world = await acceptedBookingWithOptions(ctx, adminId, options, codes.length);
  await readyHandover(ctx, adminId, world.bookingId, codes);
  const services = handoverServicesFor(ctx);
  await services.handover.finalize(adminId, world.bookingId);
  return { ...world, machineCodes: codes, services };
}

/**
 * Rückgabe bis vor die Finalisierung bringen (inkl. optionaler Kommissions-
 * mengen, Reinigungsmängel, Schäden, Fehlteile) – die Finalisierung selbst
 * läuft über die ECHTE Route, damit der Abrechnungs-Hook greift.
 */
export async function finalizedReturn(
  ctx: TestContext,
  adminId: string,
  cookie: string,
  options: FinalizedReturnOptions = {},
): Promise<FinalizedReturn> {
  const world = await issuedBookingWithOptions(ctx, adminId, options);
  const { services } = world;
  const effective = await ctx.auth.effectivePermissions(adminId);
  await services.returns.start(adminId, world.bookingId);
  await readyReturn(ctx, adminId, services, world.bookingId, { skipSignatures: true });
  let detail = await services.returns.detail(world.bookingId);
  for (const entry of options.returnedUnopened ?? []) {
    const candidates = detail.items.filter((candidate) =>
      candidate.description.includes(entry.match),
    );
    const item =
      candidates.find((candidate) => candidate.kind === (entry.kind ?? 'commission')) ??
      candidates[0];
    if (item === undefined) throw new Error(`Rückgabeposition „${entry.match}“ nicht gefunden`);
    await services.returns.setReturnedQuantity(adminId, world.bookingId, item.id, entry.quantity);
  }
  for (const index of options.cleanupMachines ?? []) {
    const rm = detail.machines[index]!;
    await services.returns.checkCleanliness(adminId, effective, world.bookingId, rm.id, {
      emptied: false,
      rinsedTwice: true,
      nothingDismantled: true,
    });
    await services.returns.addCleanupPhoto(adminId, world.bookingId, rm.id, {
      bytes: jpegBytes(),
      mimeType: 'image/jpeg',
    });
  }
  const damageIds: string[] = [];
  for (const damage of options.damages ?? []) {
    const rm = detail.machines[damage.machineIndex ?? 0]!;
    const { damageId } = await services.returns.addDamage(adminId, world.bookingId, rm.id, {
      severity: damage.severity ?? 'medium',
      description: damage.description,
      markers: [POINT_MARKER],
    });
    await services.damages.addPhoto(adminId, damageId, {
      bytes: jpegBytes(),
      mimeType: 'image/jpeg',
    });
    damageIds.push(damageId);
  }
  const missingCaseIds: string[] = [];
  for (const missing of options.missing ?? []) {
    const rm = detail.machines[missing.machineIndex ?? 0]!;
    const { caseId } = await services.returns.addMissingCase(adminId, world.bookingId, rm.id, {
      accessoryType: missing.accessoryType,
      missingQuantity: missing.quantity,
    });
    missingCaseIds.push(caseId);
  }
  await services.returns.sign(adminId, world.bookingId, 'customer', pngBytes());
  await services.returns.sign(adminId, world.bookingId, 'staff', pngBytes());
  detail = await services.returns.detail(world.bookingId);
  if (detail.blockers.length > 0) throw new Error(`Blocker: ${detail.blockers.join(' ')}`);
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/staff/returns/${world.bookingId}/finalize`,
    headers: { cookie },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Finalisierung fehlgeschlagen: ${response.statusCode} ${response.body}`);
  }
  const finalized = response.json() as {
    detail: { return: { id: string }; machines: { id: string }[] };
  };
  return {
    ...world,
    returnId: finalized.detail.return.id,
    returnMachineIds: finalized.detail.machines.map((m) => m.id),
    damageIds,
    missingCaseIds,
  };
}

/** SettlementView über die echte Route (GET /staff/processes/:id/settlement). */
export async function settlementViewFor(
  app: FastifyInstance,
  cookie: string,
  processId: string,
): Promise<SettlementView> {
  const response = await app.inject({
    method: 'GET',
    url: `/staff/processes/${processId}/settlement`,
    headers: { cookie },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Settlement nicht ladbar: ${response.statusCode} ${response.body}`);
  }
  return response.json() as SettlementView;
}

export async function settlementById(app: FastifyInstance, cookie: string, settlementId: string) {
  const response = await app.inject({
    method: 'GET',
    url: `/staff/settlements/${settlementId}`,
    headers: { cookie },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Settlement nicht ladbar: ${response.statusCode} ${response.body}`);
  }
  return response.json() as SettlementView;
}

export async function settlementRowFor(ctx: TestContext, processId: string) {
  const rows = await ctx.db.select().from(settlements).where(eq(settlements.processId, processId));
  return rows[0] ?? null;
}

/** Hilfsaufruf für Mutationen mit aktueller Version. */
export async function post(
  app: FastifyInstance,
  cookie: string,
  url: string,
  payload: Record<string, unknown>,
  method: 'POST' | 'PATCH' | 'DELETE' = 'POST',
) {
  const response = await app.inject({ method, url, headers: { cookie }, payload });
  return {
    status: response.statusCode,
    body: response.json() as Record<string, unknown> & {
      settlement?: SettlementView['settlement'];
      error?: { code: string; message: string };
    },
  };
}

export function lineOf(view: SettlementView, type: string) {
  return view.lines.filter((line) => line.type === type);
}

export function openClarifications(view: SettlementView, type?: string) {
  return view.clarifications.filter(
    (c) => c.status === 'open' && (type === undefined || c.type === type),
  );
}

/** Finalisierte Rückgabe + direkt die Abrechnung. */
export async function settledReturn(
  ctx: TestContext,
  adminId: string,
  cookie: string,
  options: FinalizedReturnOptions = {},
) {
  const world = await finalizedReturn(ctx, adminId, cookie, options);
  const view = await settlementViewFor(ctx.app, cookie, world.processId);
  return { world, view };
}
