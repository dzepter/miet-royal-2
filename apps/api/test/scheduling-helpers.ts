import type pg from 'pg';
import { SchedulingService } from '../src/scheduling/scheduling-service.ts';
import { SubstitutionService } from '../src/scheduling/substitution-service.ts';
import { adminVisibilityCtx, processServiceFor } from './crm-helpers.ts';
import {
  commerceServices,
  createCommerceWorld,
  inquiryServiceFor,
  productServiceFor,
} from './commerce-helpers.ts';
import type { TestContext } from './auth-helpers.ts';

/** Scheduling-Tabellen leeren (VOR den Commerce-/Auth-Resets aufrufen). */
export async function truncateSchedulingTables(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE appointment_overdue_incidents, appointment_conflict_suppressions,
     appointments, staff_substitutions CASCADE`,
  );
}

export function schedulingServiceFor(ctx: TestContext): SchedulingService {
  return new SchedulingService(ctx.db);
}

export function substitutionServiceFor(ctx: TestContext): SubstitutionService {
  return new SubstitutionService(ctx.db);
}

export interface BookingWorld {
  processId: string;
  bookingId: string;
  customerId: string;
  machineId: string;
}

/**
 * Bestätigte Buchung über den ECHTEN Annahmepfad erzeugen (Anfrage →
 * Angebot → Versand → verbindliche Annahme) – keine Datenbank-Abkürzung.
 */
export async function createAcceptedBooking(
  ctx: TestContext,
  adminId: string,
  options: {
    fulfillment?: 'pickup' | 'delivery';
    eventInDays?: number;
    eventDate?: string;
    eventStart?: Date | null;
    eventEnd?: Date | null;
    deliveryWindowFrom?: Date | null;
    deliveryWindowTo?: Date | null;
    collectionWindowFrom?: Date | null;
    collectionWindowTo?: Date | null;
    assignProcessTo?: string | null;
  } = {},
): Promise<BookingWorld> {
  const fulfillment = options.fulfillment ?? 'pickup';
  const world = await createCommerceWorld(ctx, adminId, {
    eventInDays: options.eventInDays ?? 30,
    fulfillment,
  });
  const machine = await productServiceFor(ctx).getProductBySlug('slush-2x10');
  const eventDate =
    options.eventDate ??
    new Date(Date.now() + (options.eventInDays ?? 30) * 86_400_000).toISOString().slice(0, 10);
  await inquiryServiceFor(ctx).upsertForProcess(adminId, world.processId, {
    eventDate,
    eventStart: options.eventStart ?? null,
    eventEnd: options.eventEnd ?? null,
    guestCount: 40,
    occasion: 'birthday',
    machineProductId: machine.id,
    fulfillment,
    deliveryStreet: fulfillment === 'delivery' ? 'Lieferweg 12' : null,
    deliveryPostalCode: fulfillment === 'delivery' ? '55129' : null,
    deliveryCity: fulfillment === 'delivery' ? 'Mainz' : null,
    deliveryWindowFrom: options.deliveryWindowFrom ?? null,
    deliveryWindowTo: options.deliveryWindowTo ?? null,
    collectionWindowFrom: options.collectionWindowFrom ?? null,
    collectionWindowTo: options.collectionWindowTo ?? null,
    selections: [],
  });
  if (options.assignProcessTo !== undefined) {
    await processServiceFor(ctx).assign(
      world.processId,
      options.assignProcessTo,
      adminVisibilityCtx(),
    );
  }
  const services = commerceServices(ctx);
  const { versionId } = await services.offers.createOffer(adminId, world.processId);
  const effective = await ctx.auth.effectivePermissions(adminId);
  const { token } = await services.offers.send(adminId, versionId, effective);
  const { bookingId } = await services.offers.accept(token);
  return {
    processId: world.processId,
    bookingId,
    customerId: world.customerId,
    machineId: machine.id,
  };
}
