import { demoDatasetState, processes, publicInquirySubmissions } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DemoDatasetService } from '../src/demo/dataset.ts';
import { DEMO_RESET_RETRY_AFTER_SECONDS } from '../src/demo/reset-gate.ts';
import { DEMO_BUSINESS_TABLES_DELETE_ORDER } from '../src/demo/reset-service.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { publishPrivacyForTests, truncateCmsTables } from './cms-helpers.ts';
import { freshDemoDatabase } from './demo-helpers.ts';
import { inquiryBody, postInquiry, postPreview } from './public-helpers.ts';

/**
 * Phase 16 (PUBLIC, Order §21, Design §3.5): Website-Anfrage in APP_ENV=demo – erzeugt
 * Demo-Kunde/-Vorgang/-Anfrage nur in der Demo-DB; während eines Business-Resets sind
 * Vorschau und Anfrage gegated (503 DEMO_RESET), der Katalog (GET) bleibt lesbar;
 * strukturell steht `public_inquiry_submissions` VOR `inquiries` in der Löschliste und
 * keine CMS-Tabelle darin. Läuft gegen die zweite Test-DB (TEST_DATABASE_URL_SECOND).
 * Namen laufen als „PD<n>“.
 */

const SECOND_DATABASE_URL =
  process.env.TEST_DATABASE_URL_SECOND ??
  'postgresql://mietroyal:mietroyal_local_dev@localhost:55432/mietroyal_test7';

let ctx: TestContext;
let adminId: string;

beforeAll(async () => {
  ctx = await createTestContext({ appEnv: 'demo', databaseUrl: SECOND_DATABASE_URL });
  await truncateCmsTables(ctx.pool);
  ({ adminId } = await freshDemoDatabase(ctx));
  await publishPrivacyForTests(ctx.db);
}, 120_000);

afterAll(async () => {
  await destroyTestContext(ctx);
});

async function setResetFlag(value: boolean): Promise<void> {
  const dataset = new DemoDatasetService(ctx.db);
  if (value) {
    await ctx.db.transaction(async (tx) => {
      await dataset.lockRow(tx);
      await dataset.beginReset(tx, { actorId: adminId, now: new Date() });
    });
    return;
  }
  await ctx.db
    .update(demoDatasetState)
    .set({ resetInProgress: false, resetStartedAt: null })
    .where(eq(demoDatasetState.id, 1));
}

describe('Phase 16 – Website-Anfrage in der Demo-Umgebung', () => {
  it('PD1. Demo-Anfrage erzeugt Demo-Kunde/-Vorgang (source website) in der Demo-DB', async () => {
    const response = await postInquiry(ctx, inquiryBody());
    expect(response.statusCode, response.body).toBe(201);
    const [process] = await ctx.db
      .select()
      .from(processes)
      .where(eq(processes.processNumber, response.json().processNumber));
    expect(process?.source).toBe('website');
    const submissions = await ctx.db.select().from(publicInquirySubmissions);
    expect(submissions).toHaveLength(1);
  });

  it('PD2. Während eines Resets: Vorschau und Anfrage ⇒ 503 DEMO_RESET (retry-after), Katalog bleibt lesbar; danach wieder normal', async () => {
    await setResetFlag(true);
    try {
      // Gate-Cache (1 s) abwarten, damit der neue Zustand sicher greift.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      for (const response of [
        await postInquiry(ctx, inquiryBody()),
        await postPreview(ctx, { machineSlug: 'slush-1x8' }),
      ]) {
        expect(response.statusCode).toBe(503);
        expect(response.headers['retry-after']).toBe(String(DEMO_RESET_RETRY_AFTER_SECONDS));
        expect(response.json().error.code).toBe('DEMO_RESET');
      }
      const catalog = await ctx.app.inject({ method: 'GET', url: '/public/configurator/catalog' });
      expect(catalog.statusCode).toBe(200);
    } finally {
      await setResetFlag(false);
    }
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await postInquiry(ctx, inquiryBody())).statusCode).toBe(201);
  });

  it('PD3. Löschliste: public_inquiry_submissions vor inquiries/processes/customers, keine CMS-Tabelle (Redaktionsinhalt überlebt)', () => {
    const order = [...DEMO_BUSINESS_TABLES_DELETE_ORDER];
    const at = (table: string) => order.indexOf(table);
    expect(at('public_inquiry_submissions')).toBeGreaterThanOrEqual(0);
    expect(at('public_inquiry_submissions')).toBeLessThan(at('inquiries'));
    expect(at('public_inquiry_submissions')).toBeLessThan(at('processes'));
    expect(at('public_inquiry_submissions')).toBeLessThan(at('customers'));
    expect(order.filter((table) => table.startsWith('cms_'))).toEqual([]);
    expect(order).toHaveLength(76);
    expect(new Set(order).size).toBe(order.length);
  });
});
