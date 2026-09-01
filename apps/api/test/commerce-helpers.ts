import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { termsVersions, type Database } from '@mietroyal/database';
import { FilesystemStorageProvider } from '@mietroyal/integrations';
import type pg from 'pg';
import { OrderConfirmationService } from '../src/commerce/confirmation-service.ts';
import { OutboxDeliveryGateway } from '../src/commerce/delivery-gateway.ts';
import { DocumentService } from '../src/commerce/document-service.ts';
import { InquiryService } from '../src/commerce/inquiry-service.ts';
import { OfferService } from '../src/commerce/offer-service.ts';
import { ProductService } from '../src/commerce/product-service.ts';
import { setStringSetting, PICKUP_EXACT_ADDRESS_KEY } from '../src/crm/settings-service.ts';
import { createTestCustomer, processServiceFor } from './crm-helpers.ts';
import type { TestContext } from './auth-helpers.ts';

/** Frischer, isolierter FS-Storage je Testkontext (kein S3 nötig). */
export function testStorage(): FilesystemStorageProvider {
  return new FilesystemStorageProvider(mkdtempSync(join(tmpdir(), 'mietroyal-storage-')));
}

/** Slugs der per Migration 0007 gesäten Produkte – bleiben zwischen Tests bestehen. */
export const SEED_SLUGS = [
  'slush-1x8',
  'slush-2x8',
  'slush-1x10',
  'slush-2x10',
  'sirup-wassermelone',
  'sirup-kirsche',
  'sirup-waldmeister',
  'sirup-blaue-himbeere',
  'becher-25',
  'strohhalme-25',
  'mischkanister-6l',
] as const;

/**
 * Commerce-Tabellen auf den Seed-Zustand zurücksetzen: transaktionale Daten
 * leeren, Test-Produkte/-Preise entfernen, Seed-Produkte reaktivieren.
 */
export async function truncateCommerceTables(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE offer_deliveries, documents, order_confirmations, bookings,
     offer_access_tokens, offer_line_items, offer_version_selections,
     offer_versions, offers, inquiry_selections, inquiries, terms_versions CASCADE`,
  );
  await pool.query(
    `DELETE FROM product_prices WHERE effective_from <> TIMESTAMPTZ '2020-01-01 00:00:00+00'`,
  );
  await pool.query(`DELETE FROM products WHERE slug <> ALL($1)`, [[...SEED_SLUGS]]);
  await pool.query(`UPDATE products SET active = true`);
  await pool.query(`DELETE FROM system_settings WHERE key <> 'pickup_public_area'`);
  // TRUNCATE staff_users CASCADE (Auth-Reset) leert product_prices mit
  // (FK created_by) – die Seed-Preise der Migration 0007 wiederherstellen:
  await pool.query(
    `INSERT INTO product_prices (product_id, price_cents, effective_from)
     SELECT p.id, v.price_cents, TIMESTAMPTZ '2020-01-01 00:00:00+00'
     FROM (VALUES
       ('slush-1x8', 6000), ('slush-2x8', 10000), ('slush-1x10', 7500), ('slush-2x10', 12000),
       ('sirup-wassermelone', 1200), ('sirup-kirsche', 1200), ('sirup-waldmeister', 1200),
       ('sirup-blaue-himbeere', 1200), ('becher-25', 250), ('strohhalme-25', 200),
       ('mischkanister-6l', 500)
     ) AS v(slug, price_cents)
     JOIN products p ON p.slug = v.slug
     WHERE NOT EXISTS (
       SELECT 1 FROM product_prices pp
       WHERE pp.product_id = p.id AND pp.effective_from = TIMESTAMPTZ '2020-01-01 00:00:00+00'
     )`,
  );
}

export function productServiceFor(ctx: TestContext): ProductService {
  return new ProductService(ctx.db);
}

export function inquiryServiceFor(ctx: TestContext): InquiryService {
  return new InquiryService(ctx.db);
}

/** TEST-Mietbedingungen anlegen (Versand-Voraussetzung in Dev/Test). */
export async function ensureTestTerms(db: Database): Promise<void> {
  await db
    .insert(termsVersions)
    .values({
      label: 'TEST-Platzhalter v1',
      content: 'TEST – Dies ist ein Platzhalter, kein echter Rechtstext.',
      isTest: true,
    })
    .onConflictDoNothing();
}

export async function setPickupExactAddress(ctx: TestContext, actorId: string): Promise<void> {
  await setStringSetting(
    ctx.db,
    actorId,
    PICKUP_EXACT_ADDRESS_KEY,
    'Teststraße 1, 55129 Mainz-Hechtsheim (SYNTHETISCH)',
  );
}

export interface CommerceWorld {
  adminId: string;
  customerId: string;
  processId: string;
  machineId: string;
  syrupId: string;
  cupsId: string;
  canisterId: string;
}

/**
 * Standard-Testwelt: Kunde + Vorgang + Anfrage (Event in `eventInDays`
 * Tagen, Maschine 2×10, 2 L Gratis-Sirup, TEST-Mietbedingungen).
 */
export async function createCommerceWorld(
  ctx: TestContext,
  adminId: string,
  options: { eventInDays?: number; fulfillment?: 'pickup' | 'delivery' } = {},
): Promise<CommerceWorld> {
  const products = productServiceFor(ctx);
  const machine = await products.getProductBySlug('slush-2x10');
  const syrup = await products.getProductBySlug('sirup-kirsche');
  const cups = await products.getProductBySlug('becher-25');
  const canister = await products.getProductBySlug('mischkanister-6l');

  const customer = await createTestCustomer(ctx, adminId, {
    firstName: 'Klara',
    lastName: 'Kommerz',
    email: 'klara.kommerz@test.example',
    phone: '0171 9998877',
  });
  const process = await processServiceFor(ctx).createProcess(adminId, {
    customerId: customer.id,
  });

  const eventInDays = options.eventInDays ?? 30;
  const eventDate = new Date(Date.now() + eventInDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  await inquiryServiceFor(ctx).upsertForProcess(adminId, process.id, {
    eventDate,
    guestCount: 40,
    occasion: 'birthday',
    machineProductId: machine.id,
    fulfillment: options.fulfillment ?? 'pickup',
    selections: [{ productId: syrup.id, role: 'free', quantity: 2 }],
  });
  await ensureTestTerms(ctx.db);

  return {
    adminId,
    customerId: customer.id,
    processId: process.id,
    machineId: machine.id,
    syrupId: syrup.id,
    cupsId: cups.id,
    canisterId: canister.id,
  };
}

/**
 * Direkte Service-Instanzen (mit dem Test-Storage des Kontexts) – für
 * Tests, die `now` injizieren müssen (Ablauf/Races). Fachlich identisch zu
 * den Instanzen der Routen.
 */
export function commerceServices(ctx: TestContext): {
  offers: OfferService;
  confirmations: OrderConfirmationService;
  documents: DocumentService;
} {
  const documents = new DocumentService(ctx.db, ctx.storage);
  const gateway = new OutboxDeliveryGateway(ctx.db);
  return {
    offers: new OfferService(ctx.db, ctx.config, documents, gateway),
    confirmations: new OrderConfirmationService(ctx.db, ctx.config, documents, gateway),
    documents,
  };
}
