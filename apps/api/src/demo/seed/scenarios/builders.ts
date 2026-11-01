import { appointments, machines, type Database } from '@mietroyal/database';
import { asc, eq } from 'drizzle-orm';
import type { InquiryInput } from '../../../commerce/inquiry-service.ts';
import type { CustomerInput } from '../../../crm/customer-service.ts';
import { demoJpegBytes, demoPngBytes } from '../assets.ts';
import type { DemoSeedContext } from '../context.ts';
import type { DemoCustomerSpec } from '../data.ts';

/**
 * Phase 14: wiederverwendbare Fachpfad-Sequenzen des Demo-Seeds. Jede Funktion
 * ruft ausschließlich die bestehenden Services (Kunde → Vorgang → Anfrage →
 * Angebot → Versand → Kundenannahme per Token → Termine → Zuweisung/
 * Vorbereitung → Übergabe → Rückgabe → Abrechnungs-Hook) – exakt die Wege, die
 * auch die Routen bzw. die Integrationstest-Helfer benutzen. Kein INSERT in
 * Business-Tabellen.
 */

export async function createDemoCustomer(
  ctx: DemoSeedContext,
  spec: DemoCustomerSpec,
): Promise<string> {
  const input: CustomerInput = {
    type: spec.type,
    firstName: spec.firstName,
    lastName: spec.lastName,
    organizationName: spec.organizationName,
    contactPerson: spec.contactPerson,
    email: spec.email,
    // Telefon bewusst leer: kein Fachflow des Seeds verlangt eine Nummer (Order §9).
    billingStreet: spec.billingStreet,
    billingPostalCode: spec.billingPostalCode,
    billingCity: spec.billingCity,
    billingCountry: 'DE',
    vatId: spec.vatId,
    department: spec.department,
    orderReference: spec.orderReference,
  };
  const { customer } = await ctx.services.customers.createCustomer(ctx.actorId, input);
  await ctx.register(spec.key, 'customer', customer.id);
  return customer.id;
}

export interface SelectionSpec {
  slug: string;
  role: 'free' | 'extra';
  quantity: number;
}

export interface InquirySpec {
  /** Berliner Kalendertag relativ zu heute. */
  eventInDays: number;
  guestCount: number;
  occasion: NonNullable<InquiryInput['occasion']>;
  machineSlug: string;
  fulfillment: 'pickup' | 'delivery';
  delivery?: { street: string; postalCode: string; city: string } | undefined;
  selections?: readonly SelectionSpec[] | undefined;
  deliveryWindow?: { from: Date; to: Date } | undefined;
  collectionWindow?: { from: Date; to: Date } | undefined;
  onsiteContactName?: string | undefined;
}

export interface ProcessSpec {
  customerId: string;
  source?: 'website' | 'whatsapp' | 'staff_manual' | 'other' | undefined;
  /** Vorgang dem Fachaktor zuweisen („Meine Termine“ in der Demo). */
  assignToActor?: boolean | undefined;
  inquiry: InquirySpec;
}

/** Vorgang (MR-Nummer aus der Sequenz) + Anfrage über InquiryService. */
export async function createDemoProcess(
  ctx: DemoSeedContext,
  spec: ProcessSpec,
): Promise<{ processId: string; processNumber: string; machineProductId: string }> {
  const eventDate = ctx.clock.dayIso(spec.inquiry.eventInDays);
  const process = await ctx.services.processes.createProcess(
    ctx.actorId,
    {
      customerId: spec.customerId,
      source: spec.source ?? 'website',
      eventDate,
      ...(spec.assignToActor === true ? { assignedUserId: ctx.actorId } : {}),
    },
    ctx.now,
  );
  const machine = await ctx.services.products.getProductBySlug(spec.inquiry.machineSlug);
  const selections = [];
  for (const selection of spec.inquiry.selections ?? []) {
    const product = await ctx.services.products.getProductBySlug(selection.slug);
    selections.push({ productId: product.id, role: selection.role, quantity: selection.quantity });
  }
  const delivery = spec.inquiry.fulfillment === 'delivery' ? spec.inquiry.delivery : undefined;
  await ctx.services.inquiries.upsertForProcess(ctx.actorId, process.id, {
    eventDate,
    guestCount: spec.inquiry.guestCount,
    occasion: spec.inquiry.occasion,
    machineProductId: machine.id,
    fulfillment: spec.inquiry.fulfillment,
    deliveryStreet: delivery?.street ?? null,
    deliveryPostalCode: delivery?.postalCode ?? null,
    deliveryCity: delivery?.city ?? null,
    deliveryWindowFrom: spec.inquiry.deliveryWindow?.from ?? null,
    deliveryWindowTo: spec.inquiry.deliveryWindow?.to ?? null,
    collectionWindowFrom: spec.inquiry.collectionWindow?.from ?? null,
    collectionWindowTo: spec.inquiry.collectionWindow?.to ?? null,
    onsiteContactName: spec.inquiry.onsiteContactName ?? null,
    selections,
  });
  return {
    processId: process.id,
    processNumber: process.processNumber,
    machineProductId: machine.id,
  };
}

export interface DraftSpec {
  machineQuantity?: number | undefined;
  deliveryPriceCents?: number | undefined;
}

/** Angebotsentwurf (Version 1 aus der Anfrage) über OfferService. */
export async function createDemoDraft(
  ctx: DemoSeedContext,
  processId: string,
  draft: DraftSpec = {},
): Promise<{ offerId: string; versionId: string }> {
  const { offerId, versionId } = await ctx.services.offers.createOffer(ctx.actorId, processId);
  const patch: { machineQuantity?: number; deliveryPriceCents?: number } = {};
  if (draft.machineQuantity !== undefined && draft.machineQuantity !== 1) {
    patch.machineQuantity = draft.machineQuantity;
  }
  if (draft.deliveryPriceCents !== undefined) patch.deliveryPriceCents = draft.deliveryPriceCents;
  if (Object.keys(patch).length > 0) {
    await ctx.services.offers.updateDraft(ctx.actorId, versionId, patch);
  }
  return { offerId, versionId };
}

/** Versand (Mail-Outbox; in der Demo ggf. `blocked`) – liefert den Kundentoken. */
export async function sendDemoOffer(
  ctx: DemoSeedContext,
  versionId: string,
  at: Date,
): Promise<{ token: string }> {
  return ctx.services.offers.send(ctx.actorId, versionId, ctx.effective, at);
}

/** Kundenannahme über den Token-Pfad (wie POST /public/offers/:token/accept) + Termine. */
export async function acceptDemoOffer(
  ctx: DemoSeedContext,
  token: string,
  at: Date,
): Promise<{ bookingId: string }> {
  const { bookingId } = await ctx.services.offers.accept(token, at);
  await ctx.services.scheduling.ensureAppointmentsForBooking(bookingId);
  return { bookingId };
}

export interface TimeSpec {
  startAt: Date;
  endAt?: Date | null | undefined;
}

export async function appointmentsOf(
  db: Database,
  bookingId: string,
): Promise<{
  outbound: typeof appointments.$inferSelect;
  inbound: typeof appointments.$inferSelect;
}> {
  const rows = await db
    .select()
    .from(appointments)
    .where(eq(appointments.bookingId, bookingId))
    .orderBy(asc(appointments.createdAt));
  const outbound = rows.find((row) => row.kind === 'pickup' || row.kind === 'delivery');
  const inbound = rows.find((row) => row.kind === 'return');
  if (outbound === undefined || inbound === undefined) {
    throw new Error('Demo-Seed: Termine der Buchung fehlen');
  }
  return { outbound, inbound };
}

/** Terminzeiten über die Terminplanung setzen (reschedule mit Versionsprüfung). */
export async function scheduleDemoAppointments(
  ctx: DemoSeedContext,
  bookingId: string,
  times: { outbound?: TimeSpec | undefined; inbound?: TimeSpec | undefined },
  at: Date,
): Promise<{ outboundId: string; inboundId: string }> {
  const { outbound, inbound } = await appointmentsOf(ctx.db, bookingId);
  if (times.outbound !== undefined) {
    await ctx.services.scheduling.reschedule(
      ctx.actorId,
      outbound.id,
      {
        startAt: times.outbound.startAt,
        endAt: times.outbound.endAt ?? null,
        expectedVersion: outbound.version,
      },
      at,
    );
  }
  if (times.inbound !== undefined) {
    await ctx.services.scheduling.reschedule(
      ctx.actorId,
      inbound.id,
      {
        startAt: times.inbound.startAt,
        endAt: times.inbound.endAt ?? null,
        expectedVersion: inbound.version,
      },
      at,
    );
  }
  return { outboundId: outbound.id, inboundId: inbound.id };
}

/** Auftragsbestätigung freigeben (PDF) und optional versenden (Outbox). */
export async function confirmDemoBooking(
  ctx: DemoSeedContext,
  bookingId: string,
  mode: 'approve' | 'send',
  at: Date,
): Promise<void> {
  const confirmation = await ctx.services.confirmations.byBookingId(bookingId);
  if (confirmation === null) throw new Error('Demo-Seed: Auftragsbestätigung fehlt');
  await ctx.services.confirmations.approve(ctx.actorId, confirmation.id, at);
  if (mode === 'send') await ctx.services.confirmations.send(confirmation.id, at);
}

export async function machineIdByCode(db: Database, code: string): Promise<string> {
  const rows = await db
    .select({ id: machines.id })
    .from(machines)
    .where(eq(machines.machineCode, code));
  const row = rows[0];
  if (row === undefined) throw new Error(`Demo-Seed: Seed-Maschine ${code} fehlt`);
  return row.id;
}

/** Slots anlegen + Maschinen zuweisen (Status der Slots: assigned). */
export async function assignDemoMachines(
  ctx: DemoSeedContext,
  bookingId: string,
  machineCodes: readonly string[],
  at: Date,
): Promise<string[]> {
  await ctx.services.handover.ensureForBooking(bookingId, ctx.actorId);
  const slots = await ctx.services.assignments.slotsForBooking(bookingId, at);
  const assignmentIds: string[] = [];
  for (const [index, slot] of slots.entries()) {
    const code = machineCodes[index];
    if (code === undefined)
      throw new Error(`Demo-Seed: kein Maschinencode für Slot ${slot.slotNo}`);
    const machineId = await machineIdByCode(ctx.db, code);
    await ctx.services.assignments.assign(ctx.actorId, ctx.effective, slot.id, machineId, null, at);
    assignmentIds.push(slot.id);
  }
  return assignmentIds;
}

/** Zuweisung + Vorbereitung (Maschine ⇒ reserviert, Slot ⇒ prepared). */
export async function prepareDemoMachines(
  ctx: DemoSeedContext,
  bookingId: string,
  machineCodes: readonly string[],
  at: Date,
): Promise<string[]> {
  const assignmentIds = await assignDemoMachines(ctx, bookingId, machineCodes, at);
  for (const assignmentId of assignmentIds) {
    await ctx.services.assignments.prepare(ctx.actorId, assignmentId, at);
  }
  return assignmentIds;
}

/**
 * Übergabe vollständig durchführen und finalisieren (Lager-Ausgabe, Maschinen
 * ⇒ vermietet, Outbound-Termin erledigt, Protokoll-PDF, Protokollmail).
 */
export async function issueDemoBooking(
  ctx: DemoSeedContext,
  bookingId: string,
  machineCodes: readonly string[],
  at: Date,
): Promise<void> {
  const assignmentIds = await prepareDemoMachines(ctx, bookingId, machineCodes, at);
  await ctx.services.handover.setRecipient(bookingId, { kind: 'customer' }, at);
  for (const assignmentId of assignmentIds) {
    await ctx.services.handover.checkMachine(ctx.actorId, bookingId, assignmentId, at);
    await ctx.services.handover.addPhoto(
      ctx.actorId,
      bookingId,
      assignmentId,
      { bytes: demoPngBytes(), mimeType: 'image/png' },
      at,
    );
  }
  await ctx.services.handover.sign(ctx.actorId, bookingId, 'customer', demoPngBytes(), at);
  await ctx.services.handover.sign(ctx.actorId, bookingId, 'staff', demoPngBytes(), at);
  await ctx.services.handover.finalize(ctx.actorId, bookingId, {}, at);
}

export interface ReturnSpec {
  /** Index der Maschine (Slot-Reihenfolge) mit dokumentiertem Schaden. */
  damages?:
    | readonly {
        machineIndex?: number | undefined;
        severity: 'light' | 'medium' | 'severe';
        description: string;
      }[]
    | undefined;
  missing?:
    | readonly {
        machineIndex?: number | undefined;
        accessoryType: 'lid' | 'drip_tray';
        quantity: number;
        description?: string | undefined;
      }[]
    | undefined;
  /** Indizes der Maschinen mit Reinigungsmangel (Gebühr 75 € + Beweisfoto). */
  cleanupMachines?: readonly number[] | undefined;
  /** Ungeöffnet zurückgegebene Kommissionsware (Teilstring der Beschreibung). */
  returnedUnopened?: readonly { match: string; quantity: number }[] | undefined;
}

/**
 * Rückgabe starten, erfassen und finalisieren (Maschinen ⇒ Reinigung,
 * Rückgabetermin erledigt, Protokoll, Abrechnung über den Listener).
 */
export async function finalizeDemoReturn(
  ctx: DemoSeedContext,
  bookingId: string,
  spec: ReturnSpec,
  at: Date,
): Promise<{ returnId: string; damageIds: string[]; missingCaseIds: string[] }> {
  const { returns, damages } = ctx.services;
  await returns.start(ctx.actorId, bookingId, at);
  await returns.setReturner(ctx.actorId, bookingId, { kind: 'customer' }, at);
  let detail = await returns.detail(bookingId, at);
  const cleanupSet = new Set(spec.cleanupMachines ?? []);
  const missingByMachine = new Map<number, number>();
  for (const missing of spec.missing ?? []) {
    const index = missing.machineIndex ?? 0;
    missingByMachine.set(index, (missingByMachine.get(index) ?? 0) + 1);
  }
  for (const [index, machine] of detail.machines.entries()) {
    if (!missingByMachine.has(index)) {
      await returns.confirmAccessoriesComplete(ctx.actorId, bookingId, machine.id, at);
    }
    if (cleanupSet.has(index)) {
      await returns.checkCleanliness(
        ctx.actorId,
        ctx.effective,
        bookingId,
        machine.id,
        { emptied: false, rinsedTwice: true, nothingDismantled: true },
        at,
      );
      await returns.addCleanupPhoto(
        ctx.actorId,
        bookingId,
        machine.id,
        { bytes: demoJpegBytes(), mimeType: 'image/jpeg' },
        at,
      );
    } else {
      await returns.checkCleanliness(
        ctx.actorId,
        ctx.effective,
        bookingId,
        machine.id,
        { emptied: true, rinsedTwice: true, nothingDismantled: true },
        at,
      );
    }
  }
  for (const entry of spec.returnedUnopened ?? []) {
    const candidates = detail.items.filter((candidate) =>
      candidate.description.includes(entry.match),
    );
    const item = candidates.find((candidate) => candidate.kind === 'commission') ?? candidates[0];
    if (item === undefined) throw new Error(`Demo-Seed: Rückgabeposition „${entry.match}“ fehlt`);
    await returns.setReturnedQuantity(ctx.actorId, bookingId, item.id, entry.quantity, at);
  }
  const missingCaseIds: string[] = [];
  for (const missing of spec.missing ?? []) {
    const machine = detail.machines[missing.machineIndex ?? 0];
    if (machine === undefined) throw new Error('Demo-Seed: Rückgabemaschine fehlt');
    const { caseId } = await returns.addMissingCase(
      ctx.actorId,
      bookingId,
      machine.id,
      {
        accessoryType: missing.accessoryType,
        missingQuantity: missing.quantity,
        description: missing.description ?? null,
      },
      at,
    );
    missingCaseIds.push(caseId);
  }
  const damageIds: string[] = [];
  for (const damage of spec.damages ?? []) {
    const machine = detail.machines[damage.machineIndex ?? 0];
    if (machine === undefined) throw new Error('Demo-Seed: Rückgabemaschine fehlt');
    const { damageId } = await returns.addDamage(
      ctx.actorId,
      bookingId,
      machine.id,
      {
        severity: damage.severity,
        description: damage.description,
        markers: [{ view: 'front', markerType: 'point', x: 0.42, y: 0.31 }],
      },
      at,
    );
    await damages.addPhoto(
      ctx.actorId,
      damageId,
      { bytes: demoJpegBytes(), mimeType: 'image/jpeg' },
      at,
    );
    damageIds.push(damageId);
  }
  await returns.sign(ctx.actorId, bookingId, 'customer', demoPngBytes(), at);
  await returns.sign(ctx.actorId, bookingId, 'staff', demoPngBytes(), at);
  detail = await returns.detail(bookingId, at);
  if (detail.blockers.length > 0) {
    throw new Error(`Demo-Seed: Rückgabe nicht abschließbar (${detail.blockers.length} Blocker)`);
  }
  const finalized = await returns.finalize(ctx.actorId, bookingId, at);
  return { returnId: finalized.return.id, damageIds, missingCaseIds };
}
