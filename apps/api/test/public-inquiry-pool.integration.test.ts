import { customers } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrapAdmin,
  createTestContext,
  destroyTestContext,
  type TestContext,
} from './auth-helpers.ts';
import { publishCmsForTests, publishPrivacyForTests } from './cms-helpers.ts';
import { createTestCustomer } from './crm-helpers.ts';
import { loginPortalCustomerSession } from './portal-auth-helpers.ts';
import {
  countRows,
  inquiryBody,
  postInquiry,
  postPreview,
  resetPublicWorld,
} from './public-helpers.ts';

/**
 * Phase 16 (PUBLIC, Order §15, Design §3.3): der gesamte Anfrage-Kern läuft in EINER
 * Transaktion über EINE Verbindung. Mit einem Pool von genau einer Verbindung würde jeder
 * verschachtelte Pool-Zugriff (z. B. `this.db` statt `tx`) deterministisch in den
 * Verbindungs-Timeout laufen (Detektor wie handover-pool.integration.test.ts).
 * Namen laufen als „PP<n>“.
 */

let ctx: TestContext;
let adminId: string;

beforeAll(async () => {
  ctx = await createTestContext({ poolMax: 1 });
  await resetPublicWorld(ctx.pool);
  adminId = (await bootstrapAdmin(ctx)).id;
  await publishPrivacyForTests(ctx.db);
  await publishCmsForTests(
    ctx.db,
    { kind: 'site_settings' },
    {
      content: {
        businessName: 'Miet-Royal',
        contact: {},
        recommendationRules: [{ guestMin: 1, guestMax: 99, machineProductSlug: 'slush-1x10' }],
      },
    },
  );
});

afterAll(async () => {
  await destroyTestContext(ctx);
});

describe('Phase 16 – Website-Anfrage mit Pool max = 1', () => {
  it('PP1. Neue Anfrage (neuer Kunde, Lieferung, Auswahl) ⇒ 201 ohne Verbindungs-Timeout', async () => {
    const response = await postInquiry(
      ctx,
      inquiryBody({
        extras: { cups25: 1, straws25: 1 },
        canisters: 2,
        fulfillment: {
          type: 'delivery',
          street: 'Poolweg 1',
          postalCode: '55118',
          city: 'Mainz',
          windowFrom: '10:00',
          windowTo: '12:00',
        },
      }),
    );
    expect(response.statusCode, response.body).toBe(201);
  });

  it('PP2. Bestehender Kunde per E-Mail, Portal-Session, Wiederholung und Doppelklick ⇒ jeweils ohne Timeout, genau ein Vorgang je ID', async () => {
    const existing = await createTestCustomer(ctx, adminId, {
      firstName: 'Ella',
      lastName: 'Eindeutig',
      email: 'ella.eindeutig@test.example',
    });
    const byEmail = inquiryBody({
      contact: {
        type: 'private',
        firstName: 'Ella',
        lastName: 'Eindeutig',
        email: 'ella.eindeutig@test.example',
      },
    });
    expect((await postInquiry(ctx, byEmail)).statusCode).toBe(201);
    expect((await postInquiry(ctx, byEmail)).statusCode).toBe(200);

    const portal = await loginPortalCustomerSession(ctx, existing.id);
    const viaPortal = await postInquiry(ctx, inquiryBody(), { cookie: portal.cookie });
    expect(viaPortal.statusCode, viaPortal.body).toBe(201);

    const processesBefore = await countRows(ctx.pool, 'processes');
    const twice = inquiryBody();
    const [a, b] = await Promise.all([postInquiry(ctx, twice), postInquiry(ctx, twice)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(await countRows(ctx.pool, 'processes')).toBe(processesBefore + 1);
    const ella = await ctx.db.select().from(customers).where(eq(customers.id, existing.id));
    expect(ella[0]?.firstName).toBe('Ella');
  });

  it('PP3. Katalog und Vorschau (mit Empfehlung aus veröffentlichten Regeln) laufen ebenfalls mit einer Verbindung', async () => {
    const catalog = await ctx.app.inject({ method: 'GET', url: '/public/configurator/catalog' });
    expect(catalog.statusCode).toBe(200);
    const preview = await postPreview(ctx, {
      guests: 40,
      machineSlug: 'slush-2x8',
      syrups: { free: [{ slug: 'sirup-kirsche', liters: 1 }], extra: [] },
      extras: { cups25: 1, straws25: 0 },
      canisters: 1,
      fulfillment: 'delivery',
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().recommendation.machineSlug).toBe('slush-1x10');
  });
});
