import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CmsService } from '../src/cms/cms-service.ts';
import { CmsMediaService } from '../src/cms/media-service.ts';
import { destroyTestContext, type TestContext } from './auth-helpers.ts';
import { truncateCmsTables } from './cms-helpers.ts';
import {
  call,
  createCmsTestContext,
  faqContent,
  SETTINGS_CONTENT,
  testImage,
} from './cms-world.ts';
import {
  demoServicesFor,
  demoTestNow,
  freshDemoDatabase,
  type DemoTestServices,
} from './demo-helpers.ts';

/**
 * Phase 16 (Order §21/§25, Design §3.5/§11.3): CMS-/Website-Redaktionsinhalt überlebt den
 * Demo-Business-Reset (Einträge, Revisionen, Medien samt Varianten im Storage,
 * Medienbindungen); die Website liefert danach unverändert. In demo heißt das
 * Vorschau-Cookie `__Host-mr_cms_preview` (Secure). Namen laufen als „R<n>.“.
 */

const RESET_TIMEOUT_MS = 180_000;
const CMS_TABLES = [
  'cms_entries',
  'cms_revisions',
  'cms_media',
  'cms_media_variants',
  'cms_revision_media',
  'cms_preview_access',
] as const;

let ctx: TestContext;
let demo: DemoTestServices;
let adminId: string;
const now = demoTestNow();

beforeAll(async () => {
  ctx = await createCmsTestContext({ appEnv: 'demo' });
  demo = demoServicesFor(ctx);
  ({ adminId } = await freshDemoDatabase(ctx));
  await truncateCmsTables(ctx.pool);
  await demo.seed.seed({ actorId: adminId, now });
}, RESET_TIMEOUT_MS);

afterAll(async () => {
  await destroyTestContext(ctx);
});

async function count(table: string): Promise<number> {
  const result = await ctx.pool.query(`SELECT count(*)::int AS n FROM "${table}"`);
  return result.rows[0].n as number;
}

describe('Phase 16 – CMS und Demo-Reset', () => {
  it(
    'R1. CMS-Inhalte, Revisionen, Medien und Vorschau-Zugänge überleben den Business-Reset',
    async () => {
      const cms = new CmsService(ctx.db, { publicWebBaseUrl: ctx.config.mail.publicWebBaseUrl });
      const media = await new CmsMediaService(ctx.db, ctx.storage).upload(adminId, {
        label: 'Demo-Bild',
        mimeType: 'image/png',
        bytes: await testImage('png', 1000, 600),
      });
      const settings = await cms.createEntryIfMissing(
        { kind: 'site_settings' },
        { content: SETTINGS_CONTENT },
      );
      await cms.publish(adminId, settings.entryId, {
        revisionId: (await cms.getEntry(settings.entryId)).draft.revisionId,
      });
      const faq = await cms.createEntryIfMissing(
        { kind: 'page', pageType: 'faq', path: '/faq' },
        {
          content: {
            ...faqContent('Demo-Antwort.'),
            blocks: [
              ...faqContent('Demo-Antwort.').blocks,
              {
                type: 'image',
                image: { mediaId: media.id, alt: 'Demo-Maschine', decorative: false },
              },
            ],
          },
          metaTitle: 'FAQ',
        },
      );
      const faqDetail = await cms.getEntry(faq.entryId);
      await cms.publish(adminId, faq.entryId, { revisionId: faqDetail.draft.revisionId });
      await cms.saveDraft(adminId, faq.entryId, {
        baseRevisionId: faqDetail.draft.revisionId,
        content: faqContent('Entwurf nach Veröffentlichung.'),
        metaTitle: 'FAQ',
      });
      const preview = await cms.createPreviewAccess(adminId, faq.entryId, {});
      const before = new Map<string, number>();
      for (const table of CMS_TABLES) before.set(table, await count(table));
      expect(before.get('cms_revisions')).toBe(3);
      expect(before.get('cms_preview_access')).toBe(1);
      const pageBefore = (await call(ctx, 'GET', '/public/site/page?path=/faq')).body;

      const result = await demo.reset.reset({ actorId: adminId, now });
      expect(result.ok).toBe(true);

      for (const table of CMS_TABLES) expect(await count(table), table).toBe(before.get(table));
      const pageAfter = await call(ctx, 'GET', '/public/site/page?path=/faq');
      expect(pageAfter.statusCode).toBe(200);
      expect(pageAfter.body).toBe(pageBefore);
      const image = await call(ctx, 'GET', `/public/cms/media/${media.id}/960`);
      expect(image.statusCode).toBe(200);
      expect((await call(ctx, 'GET', '/public/site/settings')).json().settings.businessName).toBe(
        'Miet-Royal',
      );

      // Vorschau in demo: __Host-Cookie mit Secure
      const token = preview.url.split('#token=')[1]!;
      const consumed = await call(ctx, 'POST', '/public/cms/preview/consume', {
        payload: { token },
      });
      expect(consumed.statusCode).toBe(200);
      const cookie = consumed.cookies.find((item) => item.name === '__Host-mr_cms_preview');
      expect(cookie).toBeDefined();
      expect(cookie!.secure).toBe(true);
      expect(cookie!.httpOnly).toBe(true);
      expect(cookie!.sameSite).toBe('Strict');
      expect(cookie!.path).toBe('/');
      expect(cookie!.domain).toBeUndefined();
      const previewPage = await call(ctx, 'GET', '/public/cms/preview/page', {
        cookie: `${cookie!.name}=${cookie!.value}`,
      });
      expect(previewPage.body).toContain('Entwurf nach Veröffentlichung.');
      expect((await call(ctx, 'GET', '/public/site/settings')).json().environment).toBe('demo');
    },
    RESET_TIMEOUT_MS,
  );
});
