import { appointments, customerPortalSessions } from '@mietroyal/database';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { generateToken, sha256Hex } from '../src/auth/crypto.ts';
import { PORTAL_SESSION_TTL_MS } from '../src/portal/auth/constants.ts';
import { PortalSessionService } from '../src/portal/auth/session-service.ts';
import { portalSessionCookieName } from '../src/portal/guard.ts';
import { registerPortalBookingRoutes } from '../src/routes/portal-booking.ts';
import type { TestContext } from './auth-helpers.ts';
import { cancellationServicesFor, resetForCancellationTests } from './cancellation-helpers.ts';
import { truncateCommunicationTables } from './communication-helpers.ts';
import {
  commerceServices,
  ensureTestTerms,
  inquiryServiceFor,
  productServiceFor,
} from './commerce-helpers.ts';
import { processServiceFor } from './crm-helpers.ts';
import { settleOfferMailJobs } from './mail-job-helpers.ts';
import { schedulingServiceFor } from './scheduling-helpers.ts';
import { truncateSettlementTables } from './settlement-helpers.ts';
import { truncateVoucherTables } from './voucher-helpers.ts';

/**
 * Phase 15 (BOOKING, Design §2.6): Test-Helfer des Kundenportals – von BOOKING
 * und CHAT gemeinsam genutzt.
 *
 * - `portalSessionFor` legt eine Portal-Session DIREKT in `customer_portal_sessions`
 *   an (Token/Hash wie der Session-Service) und liefert den Cookie-Header.
 * - `portalApp` liefert die App mit Portal-Routen: die Kontext-App, sobald
 *   app.ts das Portal-Modul einhängt, sonst (Übergang) eine zweite App auf
 *   denselben Fakes/derselben DB, auf der die BOOKING-Routen registriert sind.
 * - `acceptedBookingForCustomer` erzeugt eine weitere bestätigte Buchung für
 *   einen BESTEHENDEN Kunden (mehrere aktuelle Buchungen).
 * - `collectKeys`/`FORBIDDEN_PORTAL_KEYS` für den Deep-Scan der Antworten.
 */

/** Vollständiger Reset für Portal-Tests (Finanzen, Übergabe, Lager, Termine, CRM, Auth, Commerce, Kommunikation, Gutscheine). */
export async function resetPortalWorld(ctx: TestContext): Promise<void> {
  await truncateSettlementTables(ctx.pool);
  await truncateVoucherTables(ctx.pool);
  await truncateCommunicationTables(ctx.pool);
  await resetForCancellationTests(ctx);
  ctx.mailGateway.reset();
}

export interface PortalSession {
  sessionId: string;
  token: string;
  /** Wert für den `cookie`-Request-Header. */
  cookie: string;
  expiresAt: Date;
}

export async function portalSessionFor(
  ctx: TestContext,
  customerId: string,
  options: { now?: Date } = {},
): Promise<PortalSession> {
  const now = options.now ?? new Date();
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + PORTAL_SESSION_TTL_MS);
  const inserted = await ctx.db
    .insert(customerPortalSessions)
    .values({
      customerId,
      tokenHash: sha256Hex(token),
      createdAt: now,
      authenticatedAt: now,
      reauthenticatedAt: now,
      expiresAt,
      userAgentLabel: 'Test',
    })
    .returning({ id: customerPortalSessions.id });
  const row = inserted[0];
  if (row === undefined) throw new Error('Portal-Session konnte nicht angelegt werden.');
  return {
    sessionId: row.id,
    token,
    cookie: `${portalSessionCookieName(ctx.config.appEnv)}=${token}`,
    expiresAt,
  };
}

/** Cookie-Header für ein frei gewähltes (z. B. ungültiges) Token. */
export function portalCookie(ctx: TestContext, token: string): string {
  return `${portalSessionCookieName(ctx.config.appEnv)}=${token}`;
}

export interface PortalTestApp {
  app: FastifyInstance;
  /** true = eigene Übergangs-App (muss in afterAll geschlossen werden). */
  standalone: boolean;
  close(): Promise<void>;
}

/**
 * App mit den Portal-Buchungsrouten. Sobald `registerPortalModule` in app.ts
 * hängt, ist das die Kontext-App selbst; davor eine zweite App mit identischen
 * Fakes/Pool und den BOOKING-Routen (Session-Service von AUTH gegen dieselbe DB).
 */
export async function portalApp(ctx: TestContext): Promise<PortalTestApp> {
  if (ctx.app.hasRoute({ method: 'GET', url: '/portal/bookings' })) {
    return { app: ctx.app, standalone: false, close: async () => undefined };
  }
  const app = buildApp({
    config: ctx.config,
    pool: ctx.pool,
    mailAdapter: ctx.mail,
    rateLimitEnabled: false,
    storage: ctx.storage,
    accountingGateway: ctx.gateway,
    jobQueue: ctx.queue,
    lexwareContext: ctx.lexware,
    lexwareConnection: ctx.lexwareConnection,
    mailGateway: ctx.mailGateway,
    pushGateway: ctx.push,
    whatsappGateway: ctx.whatsapp,
    inboundMailSource: ctx.inboundMail,
  });
  if (!app.hasRoute({ method: 'GET', url: '/portal/bookings' })) {
    registerPortalBookingRoutes(app, {
      db: ctx.db,
      config: ctx.config,
      storage: ctx.storage,
      cancellationService: cancellationServicesFor(ctx).service,
      sessions: new PortalSessionService(ctx.db),
    });
  }
  await app.ready();
  return { app, standalone: true, close: () => app.close() };
}

export interface PortalResponse {
  status: number;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  raw: Buffer;
}

/** GET/POST gegen die Portal-App mit Cookie-Header; Body als JSON (falls möglich). */
export async function portalRequest(
  app: FastifyInstance,
  cookie: string | null,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<PortalResponse> {
  const response = await app.inject({
    method,
    url,
    ...(cookie === null ? {} : { headers: { cookie } }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  let body: unknown = null;
  const contentType = String(response.headers['content-type'] ?? '');
  if (contentType.includes('application/json')) {
    body = response.json();
  }
  return {
    status: response.statusCode,
    body,
    headers: response.headers as Record<string, string | string[] | undefined>,
    raw: response.rawPayload,
  };
}

export const portalGet = (app: FastifyInstance, cookie: string | null, url: string) =>
  portalRequest(app, cookie, 'GET', url);

export const portalPost = (
  app: FastifyInstance,
  cookie: string | null,
  url: string,
  payload: unknown,
) => portalRequest(app, cookie, 'POST', url, payload);

/**
 * Weitere bestätigte Buchung für einen BESTEHENDEN Kunden über den echten
 * Pfad (Vorgang → Anfrage → Angebot → Versand → Annahme → Termine).
 */
export async function acceptedBookingForCustomer(
  ctx: TestContext,
  adminId: string,
  customerId: string,
  options: {
    eventDate?: string;
    eventInDays?: number;
    fulfillment?: 'pickup' | 'delivery';
    machineSlug?: string;
    machineQuantity?: number;
    collectionWindowFrom?: Date | null;
    collectionWindowTo?: Date | null;
    deliveryWindowFrom?: Date | null;
    deliveryWindowTo?: Date | null;
    eventStart?: Date | null;
    eventEnd?: Date | null;
    selections?: { slug: string; role: 'free' | 'extra'; quantity: number }[];
  } = {},
): Promise<{ processId: string; bookingId: string; processNumber: string }> {
  const fulfillment = options.fulfillment ?? 'pickup';
  const process = await processServiceFor(ctx).createProcess(adminId, { customerId });
  const products = productServiceFor(ctx);
  const machine = await products.getProductBySlug(options.machineSlug ?? 'slush-2x10');
  const selections = [];
  for (const selection of options.selections ?? []) {
    const product = await products.getProductBySlug(selection.slug);
    selections.push({ productId: product.id, role: selection.role, quantity: selection.quantity });
  }
  const eventDate =
    options.eventDate ??
    new Date(Date.now() + (options.eventInDays ?? 30) * 86_400_000).toISOString().slice(0, 10);
  await inquiryServiceFor(ctx).upsertForProcess(adminId, process.id, {
    eventDate,
    eventStart: options.eventStart ?? null,
    eventEnd: options.eventEnd ?? null,
    guestCount: 25,
    occasion: 'party',
    machineProductId: machine.id,
    fulfillment,
    deliveryStreet: fulfillment === 'delivery' ? 'Lieferweg 12' : null,
    deliveryPostalCode: fulfillment === 'delivery' ? '55129' : null,
    deliveryCity: fulfillment === 'delivery' ? 'Mainz' : null,
    deliveryWindowFrom: options.deliveryWindowFrom ?? null,
    deliveryWindowTo: options.deliveryWindowTo ?? null,
    collectionWindowFrom: options.collectionWindowFrom ?? null,
    collectionWindowTo: options.collectionWindowTo ?? null,
    selections,
  });
  await ensureTestTerms(ctx.db);
  const services = commerceServices(ctx);
  const { versionId } = await services.offers.createOffer(adminId, process.id);
  if (options.machineQuantity !== undefined && options.machineQuantity !== 1) {
    await services.offers.updateDraft(adminId, versionId, {
      machineQuantity: options.machineQuantity,
    });
  }
  const effective = await ctx.auth.effectivePermissions(adminId);
  const { token } = await services.offers.send(adminId, versionId, effective);
  await settleOfferMailJobs(ctx);
  const { bookingId } = await services.offers.accept(token);
  await schedulingServiceFor(ctx).ensureAppointmentsForBooking(bookingId);
  return { processId: process.id, bookingId, processNumber: process.processNumber };
}

export async function appointmentsForBooking(ctx: TestContext, bookingId: string) {
  return ctx.db
    .select()
    .from(appointments)
    .where(eq(appointments.bookingId, bookingId))
    .orderBy(asc(appointments.kind));
}

/** Verbotene Schlüssel in Portal-Antworten (Design §0, Order §51). */
export const FORBIDDEN_PORTAL_KEYS: readonly string[] = [
  'assignedUserId',
  'assigned_user_id',
  'internalNote',
  'internal_note',
  'note',
  'notes',
  'discountReason',
  'specialPrices',
  'approvedBy',
  'discountApprovedBy',
  'staffUserId',
  'createdByStaffId',
  'cancelerStaffId',
  'storageKey',
  'storage_key',
  'accountingReference',
  'externalReference',
  'lexwareInvoiceId',
  'providerMessageId',
  'lastTransferErrorCode',
  'attentionCode',
  'releasedResources',
  'riskIncidents',
  'standardUnitPriceCents',
  'priceSource',
  'productId',
  'listPriceCents',
  'tokenHash',
  'token_hash',
  'onsiteContactPhone',
  'phoneNormalized',
];

/** Alle Objektschlüssel eines JSON-Werts rekursiv (für den Deep-Scan). */
export function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      collectKeys(entry, into);
    }
  }
  return into;
}

/** Verbotene Schlüssel, die in `value` vorkommen (leer = sauber). */
export function forbiddenKeysIn(value: unknown): string[] {
  const keys = collectKeys(value);
  return FORBIDDEN_PORTAL_KEYS.filter((key) => keys.has(key));
}
