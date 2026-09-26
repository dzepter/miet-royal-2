import { machineAssignments } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import type { TestContext } from './auth-helpers.ts';
import {
  handoverServicesFor,
  initializeAllInventory,
  pngBytes,
  readyHandover,
  scheduledBooking,
  type HandoverServices,
  type ScheduledBooking,
} from './handover-helpers.ts';
import { machineByCode } from './warehouse-helpers.ts';

/**
 * Phase-7-Testbausteine: ausgegebene Buchung über die ECHTEN Phase-3/4/6-
 * Wege (Annahme, Termine, Zuweisung, Vorbereitung, Übergabe-Finalisierung),
 * gestartete Rückgabe und eine bis unmittelbar vor die Finalisierung
 * gebrachte Rückgabe ohne Beanstandung.
 */

/** Kleinstes gültiges JPEG (1×1 Pixel, SOF0) – strukturell prüfbar und pdfkit-einbettbar. */
export const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

export function jpegBytes(): Uint8Array {
  return new Uint8Array(JPEG_1X1);
}

export interface IssuedBooking extends ScheduledBooking {
  machineCodes: string[];
  assignmentIds: string[];
}

/**
 * Buchung anlegen, Termine setzen, Lager initialisieren, Maschinen
 * zuweisen/vorbereiten, Übergabe finalisieren → Maschinen sind ausgegeben.
 */
export async function issuedBooking(
  ctx: TestContext,
  adminId: string,
  options: {
    machineCodes?: string[];
    machineSlug?: string;
    machineQuantity?: number;
    selections?: { slug: string; role: 'free' | 'extra'; quantity: number }[];
    from?: Date;
    to?: Date;
    stock?: number;
    skipInventoryInit?: boolean;
  } = {},
): Promise<IssuedBooking> {
  const codes = options.machineCodes ?? ['MR-10-01-01'];
  if (options.skipInventoryInit !== true) {
    await initializeAllInventory(ctx, adminId, options.stock ?? 20);
  }
  const world = await scheduledBooking(ctx, adminId, {
    ...(options.machineSlug === undefined ? {} : { machineSlug: options.machineSlug }),
    machineQuantity: options.machineQuantity ?? codes.length,
    ...(options.selections === undefined ? {} : { selections: options.selections }),
    ...(options.from === undefined ? {} : { from: options.from }),
    ...(options.to === undefined ? {} : { to: options.to }),
  });
  await readyHandover(ctx, adminId, world.bookingId, codes);
  const services = handoverServicesFor(ctx);
  await services.handover.finalize(adminId, world.bookingId);
  const rows = await ctx.db
    .select({ id: machineAssignments.id, slotNo: machineAssignments.slotNo })
    .from(machineAssignments)
    .where(eq(machineAssignments.bookingId, world.bookingId))
    .orderBy(machineAssignments.slotNo);
  return { ...world, machineCodes: codes, assignmentIds: rows.map((row) => row.id) };
}

/** Rückgabe starten und Detail liefern. */
export async function startedReturn(
  ctx: TestContext,
  adminId: string,
  options: Parameters<typeof issuedBooking>[2] = {},
) {
  const world = await issuedBooking(ctx, adminId, options);
  const services = handoverServicesFor(ctx);
  await services.returns.start(adminId, world.bookingId);
  const detail = await services.returns.detail(world.bookingId);
  return { world, services, detail };
}

/**
 * Rückgabe ohne Beanstandung bis unmittelbar VOR die Finalisierung bringen:
 * Rückgabeperson Kunde, Zubehör vollständig, alle drei Sauberkeitspunkte
 * erfüllt, beide Unterschriften.
 */
export async function readyReturn(
  ctx: TestContext,
  adminId: string,
  services: HandoverServices,
  bookingId: string,
  options: {
    skipSignatures?: boolean;
    skipCleanliness?: boolean;
    skipAccessories?: boolean;
    returner?: Parameters<HandoverServices['returns']['setReturner']>[2];
  } = {},
) {
  const effective = await ctx.auth.effectivePermissions(adminId);
  await services.returns.setReturner(adminId, bookingId, options.returner ?? { kind: 'customer' });
  const detail = await services.returns.detail(bookingId);
  for (const machine of detail.machines) {
    if (options.skipAccessories !== true) {
      await services.returns.confirmAccessoriesComplete(adminId, bookingId, machine.id);
    }
    if (options.skipCleanliness !== true) {
      await services.returns.checkCleanliness(adminId, effective, bookingId, machine.id, {
        emptied: true,
        rinsedTwice: true,
        nothingDismantled: true,
      });
    }
  }
  if (options.skipSignatures !== true) {
    await services.returns.sign(adminId, bookingId, 'customer', pngBytes());
    await services.returns.sign(adminId, bookingId, 'staff', pngBytes());
  }
  return services.returns.detail(bookingId);
}

export async function machineStatus(ctx: TestContext, code: string) {
  const machine = await machineByCode(ctx.db, code);
  return {
    status: machine.status,
    locationKind: machine.locationKind,
    cleaningSince: machine.cleaningSince,
  };
}

export const POINT_MARKER = {
  view: 'front' as const,
  markerType: 'point' as const,
  x: 0.4,
  y: 0.3,
};
export const AREA_MARKER = {
  view: 'left' as const,
  markerType: 'area' as const,
  x: 0.2,
  y: 0.5,
  width: 0.3,
  height: 0.2,
};
