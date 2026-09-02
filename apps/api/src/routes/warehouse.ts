import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { StorageProvider } from '@mietroyal/integrations';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance } from 'fastify';
import { requireAuth, requirePermission, sendAuthError, sendError } from '../auth/http.ts';
import type { StaffAuthService } from '../auth/service.ts';
import { getStaffAppBaseUrl, setStaffAppBaseUrl } from '../crm/settings-service.ts';
import { MachineAvailabilityService } from '../warehouse/availability.ts';
import {
  MACHINE_LOCATION_LABELS,
  MACHINE_STATUS_LABELS,
  MachineService,
  blockOverlaps,
} from '../warehouse/machine-service.ts';
import { InventoryService } from '../warehouse/inventory-service.ts';
import { UUID_PATTERN } from './auth.ts';

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const idParams = z.object({ id: uuidSchema });
const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'muss ein gültiger Zeitpunkt sein')
  .refine((value) => {
    const year = new Date(value).getUTCFullYear();
    return year >= 2020 && year <= 2100;
  }, 'liegt außerhalb des fachlich möglichen Zeitraums (2020–2100)');
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'muss ein Datum (JJJJ-MM-TT) sein')
  .refine((value) => {
    // Kalendergültigkeit (kein 31.02.): Round-Trip über UTC-Date.
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'ist kein gültiges Kalenderdatum');

/**
 * Stammdaten (Order §3/§4): NUR Kaufdatum/Gewicht – machineCode, Typ und
 * QR sind bewusst NICHT änderbar; unbekannte Felder werden abgelehnt
 * (strict), damit die Maschinen-ID nie zum editierbaren Textfeld wird.
 */
const masterDataBody = z.strictObject({
  purchaseDate: isoDate.nullable().optional(),
  weightGrams: z.number().int().min(0).max(1_000_000).nullable().optional(),
});

const createMachineBody = z.strictObject({
  productId: uuidSchema,
  purchaseDate: isoDate.nullable().optional(),
  weightGrams: z.number().int().min(0).max(1_000_000).nullable().optional(),
});

const statusBody = z.strictObject({
  status: z.enum(['ready', 'rented', 'reserved', 'cleaning', 'repair', 'out_of_service']),
});

const locationBody = z.strictObject({
  locationKind: z.enum(['warehouse', 'customer', 'staff', 'repair', 'other']),
  locationNote: z.string().max(200).nullable().optional(),
});

const blockBody = z.strictObject({
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  reason: z.string().min(1).max(500),
});

const photoBody = z.strictObject({
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  dataBase64: z.string().min(1),
});

const availabilityQuery = z.object({
  productId: uuidSchema,
  from: isoDateTime,
  to: isoDateTime,
});

const receiveBody = z.strictObject({
  // Bewusst NUR die HINZUGEFÜGTE Menge (Order §31) – nie ein Gesamtwert.
  addedQuantity: z.number().int().min(1).max(1_000_000),
});

const minStockBody = z.strictObject({
  minStock: z.number().int().min(0).max(1_000_000).nullable(),
});

const stocktakeBody = z.strictObject({
  entries: z
    .array(
      z.strictObject({ itemId: uuidSchema, countedStock: z.number().int().min(0).max(10_000_000) }),
    )
    .min(1)
    .max(100),
});

const correctBody = z.strictObject({
  countedStock: z.number().int().min(0).max(10_000_000),
});

interface WarehouseRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  storage: StorageProvider;
}

/**
 * Antwortprojektion für Maschinen-Mutationen: NIE die rohe Drizzle-Zeile –
 * qrToken bleibt dem separat geschützten QR-Endpunkt (machine.qr)
 * vorbehalten, Storage-Keys bleiben intern.
 */
function serializeMachine(machine: {
  id: string;
  machineCode: string;
  productId: string;
  status: keyof typeof MACHINE_STATUS_LABELS;
  locationKind: keyof typeof MACHINE_LOCATION_LABELS;
  locationNote: string | null;
  purchaseDate: string | null;
  weightGrams: number | null;
  referencePhotoKey: string | null;
  updatedAt: Date;
}) {
  return {
    id: machine.id,
    machineCode: machine.machineCode,
    productId: machine.productId,
    status: machine.status,
    statusLabel: MACHINE_STATUS_LABELS[machine.status],
    locationKind: machine.locationKind,
    locationLabel: MACHINE_LOCATION_LABELS[machine.locationKind],
    locationNote: machine.locationNote,
    purchaseDate: machine.purchaseDate,
    weightGrams: machine.weightGrams,
    hasReferencePhoto: machine.referencePhotoKey !== null,
    updatedAt: machine.updatedAt.toISOString(),
  };
}

export function registerWarehouseRoutes(
  app: FastifyInstance,
  options: WarehouseRouteOptions,
): void {
  const { db, auth, config, storage } = options;
  const machineService = new MachineService(db, storage);
  const availability = new MachineAvailabilityService(db);
  const inventory = new InventoryService(db);

  // ── Maschinen (Order §§23/24) ──────────────────────────────────────────

  app.get('/staff/machines', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.view'))) return;
    const now = new Date();
    const rows = await machineService.list();
    const blocks = await machineService.allOpenBlocks(now);
    return {
      machines: rows.map(({ machine, product }) => {
        const own = blocks.filter((block) => block.machineId === machine.id);
        const activeBlock = own.find((block) => blockOverlaps(block, now, now));
        return {
          id: machine.id,
          machineCode: machine.machineCode,
          productId: product.id,
          productName: product.name,
          status: machine.status,
          statusLabel: MACHINE_STATUS_LABELS[machine.status],
          locationKind: machine.locationKind,
          locationLabel: MACHINE_LOCATION_LABELS[machine.locationKind],
          locationNote: machine.locationNote,
          activeBlockReason: activeBlock?.reason ?? null,
          openBlockCount: own.length,
          notRegularlyAvailable: machine.status !== 'ready' || activeBlock !== undefined,
        };
      }),
    };
  });

  app.post('/staff/machines', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.manage'))) return;
    const body = parseOrThrow(createMachineBody, request.body);
    try {
      const machine = await machineService.createMachine({
        productId: body.productId,
        purchaseDate: body.purchaseDate ?? null,
        weightGrams: body.weightGrams ?? null,
      });
      return { machine: serializeMachine(machine) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  /** Auswahlvorschlag für Phase 6 (Order §20) – reine Vorschlagsfunktion. */
  app.get('/staff/machines/suggestion', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.view'))) return;
    const query = parseOrThrow(availabilityQuery, request.query, 'query');
    try {
      return await availability.suggestMachines(query.productId, {
        from: new Date(query.from),
        to: new Date(query.to),
      });
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  /**
   * QR-Auflösung (Order §10): nur nach Staff-Login + machine.view; ungültige
   * oder unbekannte Tokens werden neutral abgelehnt. Der Token wird nicht
   * geloggt und gibt ohne Recht keinerlei Maschinendaten preis.
   */
  app.get('/staff/machines/qr/:token', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.view'))) return;
    const params = parseOrThrow(
      z.object({ token: z.string().min(8).max(200) }),
      request.params,
      'params',
    );
    const resolved = await machineService.byQrToken(params.token);
    if (resolved === null) {
      sendError(request, reply, 404, 'NOT_FOUND', 'Dieser QR-Code ist nicht gültig.');
      return;
    }
    return { machineId: resolved.machine.id, machineCode: resolved.machine.machineCode };
  });

  app.get('/staff/machines/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const now = new Date();
      const { machine, product } = await machineService.byId(params.id);
      const blocks = await machineService.openBlocks(params.id, now);
      // Kapazitätslage des Typs für die nächsten 14 Tage (Order §22/§24) –
      // reine Warnung, keine Blockade.
      const check = await availability.checkProduct(product.id, {
        from: now,
        to: new Date(now.getTime() + 14 * 24 * 3_600_000),
      });
      return {
        machine: {
          id: machine.id,
          machineCode: machine.machineCode,
          productId: product.id,
          productName: product.name,
          status: machine.status,
          statusLabel: MACHINE_STATUS_LABELS[machine.status],
          locationKind: machine.locationKind,
          locationLabel: MACHINE_LOCATION_LABELS[machine.locationKind],
          locationNote: machine.locationNote,
          purchaseDate: machine.purchaseDate,
          weightGrams: machine.weightGrams,
          carryPersons: product.carryPersons,
          hasReferencePhoto: machine.referencePhotoKey !== null,
          createdAt: machine.createdAt.toISOString(),
          updatedAt: machine.updatedAt.toISOString(),
        },
        blocks: blocks.map((block) => ({
          id: block.id,
          startsAt: block.startsAt.toISOString(),
          endsAt: block.endsAt.toISOString(),
          reason: block.reason,
          active: blockOverlaps(block, now, now),
        })),
        availability: {
          status: check.status,
          reasons: check.reasons,
          notFullyCheckable: check.notFullyCheckable,
        },
      };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.patch('/staff/machines/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(masterDataBody, request.body);
    try {
      const machine = await machineService.updateMasterData(params.id, body);
      return { machine: serializeMachine(machine) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/machines/:id/status', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.change_status'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(statusBody, request.body);
    try {
      const machine = await machineService.setStatus(params.id, body.status);
      return { machine: serializeMachine(machine) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/machines/:id/location', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.change_location')))
      return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(locationBody, request.body);
    try {
      const machine = await machineService.setLocation(params.id, {
        locationKind: body.locationKind,
        locationNote: body.locationNote ?? null,
      });
      return { machine: serializeMachine(machine) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Sperren (Order §§12/13) ────────────────────────────────────────────

  app.post('/staff/machines/:id/blocks', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.block'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(blockBody, request.body);
    try {
      const block = await machineService.createBlock(params.id, context.user.id, {
        startsAt: new Date(body.startsAt),
        endsAt: new Date(body.endsAt),
        reason: body.reason,
      });
      // Starke interne Warnung statt Verhinderung (Order §12): entsteht
      // durch die Sperre ein Kapazitätsproblem, wird es benannt.
      const { product } = await machineService.byId(params.id);
      const check = await availability.checkProduct(product.id, {
        from: block.startsAt,
        to: block.endsAt,
      });
      return {
        block: { id: block.id },
        // Bei entstehendem Engpass ALLE Gründe; ohne Engpass bleiben die
        // §15-Hinweise auf nicht prüfbare Buchungen trotzdem sichtbar –
        // "verfügbar" darf fehlende Terminzeiten nicht verschlucken.
        warnings:
          check.status === 'available'
            ? check.undetermined.map((entry) => `${entry.processNumber}: ${entry.reason}`)
            : check.reasons,
      };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/machine-blocks/:id/lift', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.block'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      await machineService.liftBlock(params.id, context.user.id);
      return { lifted: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── QR-Anzeige/-Druckgrundlage (Order §§10/11) ─────────────────────────

  app.get('/staff/machines/:id/qr', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.qr'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const { machine } = await machineService.byId(params.id);
      const baseUrl = await getStaffAppBaseUrl(db);
      return {
        token: machine.qrToken,
        // Ohne konfigurierte Basis-URL wird KEINE Live-URL erfunden –
        // die UI zeigt dann nur den Identifier (Order §11).
        url: baseUrl === null ? null : `${baseUrl}/qr/${machine.qrToken}`,
        baseConfigured: baseUrl !== null,
      };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // QR-Basis-URL als adminpflegbares Setting (Order §11): ohne Konfiguration
  // bleibt der QR-Druck bewusst ohne Live-URL – hier wird sie gepflegt.
  app.get('/staff/settings/staff-app-base-url', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'system.settings'))) return;
    return { url: await getStaffAppBaseUrl(db) };
  });

  app.put('/staff/settings/staff-app-base-url', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'system.settings'))) return;
    const body = parseOrThrow(
      z.strictObject({ url: z.string().max(300).nullable() }),
      request.body,
    );
    try {
      await setStaffAppBaseUrl(db, context.user.id, body.url);
      return { url: await getStaffAppBaseUrl(db) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Referenzfoto (Order §9) ────────────────────────────────────────────

  app.put(
    '/staff/machines/:id/reference-photo',
    { bodyLimit: 9 * 1024 * 1024 },
    async (request, reply) => {
      const context = await requireAuth(request, reply, auth, config);
      if (context === null) return;
      if (
        !(await requirePermission(request, reply, auth, context, 'machine.replace_reference_photo'))
      )
        return;
      const params = parseOrThrow(idParams, request.params, 'params');
      const body = parseOrThrow(photoBody, request.body);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(Buffer.from(body.dataBase64, 'base64'));
      } catch {
        sendError(request, reply, 400, 'VALIDATION', 'Das Foto konnte nicht gelesen werden.');
        return;
      }
      if (bytes.length === 0 || bytes.length > 6 * 1024 * 1024) {
        sendError(
          request,
          reply,
          400,
          'VALIDATION',
          'Das Foto muss zwischen 1 Byte und 6 MB groß sein.',
        );
        return;
      }
      try {
        await machineService.replaceReferencePhoto(params.id, {
          bytes,
          mimeType: body.mimeType,
        });
        return { replaced: true };
      } catch (error) {
        if (sendAuthError(request, reply, error)) return;
        throw error;
      }
    },
  );

  app.get('/staff/machines/:id/reference-photo', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const photo = await machineService.referencePhotoBytes(params.id);
      if (photo === null) {
        sendError(request, reply, 404, 'NOT_FOUND', 'Kein Referenzfoto hinterlegt.');
        return;
      }
      void reply.header('content-type', photo.mimeType);
      void reply.header('cache-control', 'private, no-store');
      return reply.send(Buffer.from(photo.bytes));
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Verfügbarkeit (Order §§14–19) ──────────────────────────────────────

  app.get('/staff/machine-availability', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'machine.view'))) return;
    const query = parseOrThrow(availabilityQuery, request.query, 'query');
    try {
      return await availability.checkProduct(query.productId, {
        from: new Date(query.from),
        to: new Date(query.to),
      });
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Lager (Order §§25–37) ──────────────────────────────────────────────

  app.get('/staff/inventory', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'inventory.view'))) return;
    return { items: await inventory.listItems() };
  });

  app.post('/staff/inventory/:id/receive', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'inventory.add_stock'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(receiveBody, request.body);
    try {
      const movement = await inventory.receive(context.user.id, params.id, body.addedQuantity);
      return { movementId: movement.id, resultingStock: movement.resultingStock };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.put('/staff/inventory/:id/min-stock', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'inventory.manage_min_stock')))
      return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(minStockBody, request.body);
    try {
      const item = await inventory.setMinStock(params.id, body.minStock);
      return { minStock: item.minStock };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.get('/staff/inventory/movements', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (
      !(await requirePermission(request, reply, auth, context, 'inventory.view_movement_history'))
    )
      return;
    return { movements: await inventory.listMovements() };
  });

  app.post('/staff/inventory/stocktakes', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'inventory.count'))) return;
    const body = parseOrThrow(stocktakeBody, request.body);
    try {
      return { stocktake: await inventory.createStocktake(context.user.id, body.entries) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.get('/staff/inventory/stocktakes', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'inventory.count'))) return;
    return { stocktakes: await inventory.listStocktakes() };
  });

  app.get('/staff/inventory/stocktakes/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'inventory.count'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      return { stocktake: await inventory.stocktakeById(params.id) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.patch('/staff/inventory/stocktakes/:id/items/:itemId', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'inventory.approve_adjustment')))
      return;
    const params = parseOrThrow(
      z.object({ id: uuidSchema, itemId: uuidSchema }),
      request.params,
      'params',
    );
    const body = parseOrThrow(correctBody, request.body);
    try {
      await inventory.correctCountedStock(params.id, params.itemId, body.countedStock);
      return { corrected: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/inventory/stocktakes/:id/approve', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'inventory.approve_adjustment')))
      return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      return { stocktake: await inventory.approveStocktake(context.user.id, params.id) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Kompakte Warnübersicht für „Heute“ (Order §§22/29/48) ──────────────

  app.get('/staff/warehouse/warnings', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const effective = await auth.effectivePermissions(context.user.id);
    const result: {
      lowStock:
        | {
            itemId: string;
            productName: string;
            currentStock: number | null;
            minStock: number | null;
          }[]
        | null;
      machineWarnings: { machineId: string; machineCode: string; reason: string }[] | null;
    } = { lowStock: null, machineWarnings: null };
    if (effective.has('inventory.view')) {
      result.lowStock = (await inventory.lowStockItems()).map((item) => ({
        itemId: item.itemId,
        productName: item.productName,
        currentStock: item.currentStock,
        minStock: item.minStock,
      }));
    }
    if (effective.has('machine.view')) {
      const now = new Date();
      const rows = await machineService.list();
      const blocks = await machineService.allOpenBlocks(now);
      const warnings: { machineId: string; machineCode: string; reason: string }[] = [];
      for (const { machine } of rows) {
        if (machine.status !== 'ready') {
          warnings.push({
            machineId: machine.id,
            machineCode: machine.machineCode,
            reason: `Status ${MACHINE_STATUS_LABELS[machine.status]}`,
          });
          continue;
        }
        // Nur JETZT wirksame Sperren zählen als "heute nicht regulär
        // einsetzbar" – rein zukünftige Sperren sind heute keine Warnung.
        const block = blocks.find(
          (candidate) => candidate.machineId === machine.id && blockOverlaps(candidate, now, now),
        );
        if (block !== undefined) {
          warnings.push({
            machineId: machine.id,
            machineCode: machine.machineCode,
            reason: `Sperre (${block.reason})`,
          });
        }
      }
      result.machineWarnings = warnings;
    }
    return result;
  });
}
