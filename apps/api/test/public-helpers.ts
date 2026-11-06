import { randomUUID } from 'node:crypto';
import { berlinDateOf } from '@mietroyal/domain';
import type { LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { truncateAuthTables, type TestContext } from './auth-helpers.ts';
import { truncateCmsTables } from './cms-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { truncateCrmTables } from './crm-helpers.ts';
import { truncatePortalTables } from './portal-auth-helpers.ts';
import { resetWarehouse } from './warehouse-helpers.ts';

/**
 * Phase 16 (PUBLIC): Test-Helfer des öffentlichen Konfigurators und der Website-Anfrage.
 * Alle Kontaktdaten sind synthetisch (`*.test.example`).
 */

/** Website-relevante Tabellen auf den Seed-Zustand zurücksetzen (Reihenfolge wie andere Suites). */
export async function resetPublicWorld(pool: pg.Pool): Promise<void> {
  await truncatePortalTables(pool);
  await truncateCrmTables(pool); // CASCADE leert auch public_inquiry_submissions (FK)
  await truncateAuthTables(pool);
  await truncateCommerceTables(pool);
  await truncateCmsTables(pool);
  await resetWarehouse(pool);
}

/** Kalendertag (Europe/Berlin) in `days` Tagen. */
export function berlinDateInDays(days: number, from: Date = new Date()): string {
  return berlinDateOf(new Date(from.getTime() + days * 24 * 60 * 60 * 1000));
}

export type InquiryBody = Record<string, unknown> & {
  clientMutationId: string;
  event: Record<string, unknown>;
  contact: Record<string, unknown>;
  fulfillment: Record<string, unknown>;
};

/** Vollständige, gültige Anfrage (Abholung, Privatperson, 2×10 L, 2 L Gratis-Sirup). */
export function inquiryBody(overrides: Partial<InquiryBody> = {}): InquiryBody {
  return {
    clientMutationId: randomUUID(),
    event: {
      date: berlinDateInDays(40),
      startTime: '18:00',
      endTime: '23:00',
      guests: 80,
      occasion: 'birthday',
    },
    machineSlug: 'slush-2x10',
    syrups: {
      free: [
        { slug: 'sirup-kirsche', liters: 1 },
        { slug: 'sirup-waldmeister', liters: 1 },
      ],
      extra: [],
    },
    extras: { cups25: 0, straws25: 0 },
    canisters: 0,
    fulfillment: { type: 'pickup' },
    contact: {
      type: 'private',
      firstName: 'Paula',
      lastName: 'Publikum',
      email: 'paula.publikum@test.example',
      phone: '0171 5550101',
    },
    privacyAcknowledged: true,
    ...overrides,
  };
}

export async function postInquiry(
  ctx: Pick<TestContext, 'app'>,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: 'POST',
    url: '/public/inquiries',
    payload: body as object,
    headers,
  });
}

export async function postPreview(
  ctx: Pick<TestContext, 'app'>,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: 'POST',
    url: '/public/configurator/preview',
    payload: body as object,
    headers,
  });
}

export async function countRows(pool: pg.Pool, table: string): Promise<number> {
  const result = await pool.query(`SELECT count(*)::int AS n FROM "${table}"`);
  return result.rows[0].n as number;
}

/**
 * Rekursive Suche nach verbotenen Schlüsseln (Deep-Scan öffentlicher DTOs) und nach
 * UUID-förmigen Werten (keine internen IDs).
 */
export function forbiddenPublicFields(value: unknown, forbiddenKeys: readonly string[]): string[] {
  const found: string[] = [];
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        if (forbiddenKeys.includes(key)) found.push(`${path}.${key}`);
        walk(item, `${path}.${key}`);
      }
      return;
    }
    if (typeof node === 'string' && uuid.test(node)) found.push(`${path}=<uuid>`);
  };
  walk(value, '$');
  return found;
}

export const PUBLIC_FORBIDDEN_KEYS = [
  'id',
  'productId',
  'machineId',
  'machineCode',
  'qrToken',
  'stock',
  'currentStock',
  'minStock',
  'status',
  'active',
  'weightGrams',
  'carryPersons',
  'futurePrices',
  'effectiveFrom',
  'createdBy',
  'createdAt',
  'updatedAt',
  'purchaseDate',
  'sortOrder',
  'locationKind',
  'locationNote',
] as const;
