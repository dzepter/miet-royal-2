import { PassThrough } from 'node:stream';
import { cmsPreviewAccess, staffSecurityEvents } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/auth/crypto.ts';
import type { StaffCmsEntryDetail } from '../src/cms/cms-service.ts';
import type { StaffCmsMedia } from '../src/cms/media-service.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  call,
  CMS_TEST_WEB_BASE,
  createCmsTestContext,
  faqContent,
  resetCmsWorld,
  seedPage,
  seedSiteSettings,
  SETTINGS_CONTENT,
  testImage,
  uploadMedia,
  type CmsWorld,
} from './cms-world.ts';

/**
 * Phase 16 (CMS-Vorschau, Order §9/§25, Design §2.4/§11.2.5/§11.3): Zugang nur als Hash,
 * ~30 min, an GENAU eine Revision des Eintrags gebunden; Einlösen per POST einmalig und
 * atomar ⇒ HttpOnly-/SameSite=Strict-Cookie; Vorschau zeigt exakt die gebundene Revision;
 * falsche/abgelaufene/verbrauchte Tokens ⇒ 401; fremde Revision ⇒ 404; Token/Cookie nie im
 * Log; Cross-Site-POST ⇒ 403; Demo/Live (zwei Datenbanken) strikt getrennt; Rate-Limit;
 * ohne öffentliche Web-Adresse 409. Namen laufen als „P<n>.“.
 */

const SECOND_DATABASE_URL =
  process.env.TEST_DATABASE_URL_SECOND ??
  'postgresql://mietroyal:mietroyal_local_dev@localhost:55432/mietroyal_test7';

let ctx: TestContext;
let world: CmsWorld;
let logBuffer = '';

beforeAll(async () => {
  const sink = new PassThrough();
  sink.on('data', (chunk: Buffer) => {
    logBuffer += chunk.toString('utf8');
  });
  ctx = await createCmsTestContext({ logDestination: sink, logLevel: 'trace' });
});

afterAll(async () => {
  await destroyTestContext(ctx);
});

beforeEach(async () => {
  world = await resetCmsWorld(ctx);
});

function tokenOf(url: string): string {
  const token = url.split('#token=')[1];
  if (token === undefined) throw new Error('kein Token im Fragment');
  return token;
}

async function createPreview(
  context: TestContext,
  cookie: string,
  entryId: string,
  payload: Record<string, unknown> = {},
) {
  return call(context, 'POST', `/staff/cms/entries/${entryId}/preview`, { cookie, payload });
}

async function consume(context: TestContext, token: string, headers: Record<string, string> = {}) {
  return call(context, 'POST', '/public/cms/preview/consume', { payload: { token }, headers });
}

function previewCookieOf(response: Awaited<ReturnType<typeof consume>>): string {
  const cookie = response.cookies.find(
    (item) => item.name === 'mr_cms_preview' || item.name === '__Host-mr_cms_preview',
  );
  if (cookie === undefined) throw new Error('kein Vorschau-Cookie');
  return `${cookie.name}=${cookie.value}`;
}

async function publishedFaqWithDraft() {
  const faq = await seedPage(
    world,
    { pageType: 'faq', path: '/faq' },
    { content: faqContent('Veröffentlichte Antwort.'), metaTitle: 'FAQ' },
  );
  await world.cms.publish(world.publisher.id, faq.id, { revisionId: faq.draft.revisionId });
  const v2 = await world.cms.saveDraft(world.editor.id, faq.id, {
    baseRevisionId: faq.draft.revisionId,
    content: faqContent('Entwurfsantwort Version zwei.'),
    metaTitle: 'FAQ',
  });
  return { faq, v2 };
}

describe('Phase 16 – CMS-Vorschau', () => {
  it('P1. Zugang: Token nur im Fragment, DB nur Hash, ~30 min, no-store, Audit ohne Token', async () => {
    const { faq, v2 } = await publishedFaqWithDraft();
    const before = Date.now();
    const response = await createPreview(ctx, world.publisher.cookie, faq.id);
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json() as { url: string; expiresAt: string };
    expect(body.url.startsWith(`${CMS_TEST_WEB_BASE}/vorschau#token=`)).toBe(true);
    expect(body.url).not.toContain('?');
    const token = tokenOf(body.url);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expiresIn = new Date(body.expiresAt).getTime() - before;
    expect(expiresIn).toBeGreaterThan(29 * 60_000);
    expect(expiresIn).toBeLessThanOrEqual(30 * 60_000 + 5_000);
    const rows = await ctx.db.select().from(cmsPreviewAccess);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entryId: faq.id,
      revisionId: v2.draft.revisionId,
      accessTokenHash: sha256Hex(token),
      sessionTokenHash: null,
      consumedAt: null,
      createdBy: world.publisher.id,
    });
    expect(JSON.stringify(rows)).not.toContain(token);
    const events = await ctx.db
      .select()
      .from(staffSecurityEvents)
      .where(eq(staffSecurityEvents.type, 'cms.preview_created'));
    expect(events).toHaveLength(1);
    expect(events[0]!.details).toEqual({ entryId: faq.id, revisionId: v2.draft.revisionId });
    // Ohne CMS-Recht keine Vorschau
    expect((await createPreview(ctx, world.viewer.cookie, faq.id)).statusCode).toBe(403);
  });

  it('P2. Einlösen: einmalig, HttpOnly/SameSite=Strict-Cookie, no-store/noindex/no-referrer', async () => {
    const { faq } = await publishedFaqWithDraft();
    const token = tokenOf((await createPreview(ctx, world.editor.cookie, faq.id)).json().url);
    const consumed = await consume(ctx, token);
    expect(consumed.statusCode).toBe(200);
    expect(consumed.json()).toMatchObject({ path: '/faq', entryKind: 'page' });
    expect(consumed.headers['cache-control']).toBe('private, no-store');
    expect(consumed.headers['x-robots-tag']).toBe('noindex, noarchive');
    expect(consumed.headers['referrer-policy']).toBe('no-referrer');
    const cookie = consumed.cookies.find((item) => item.name === 'mr_cms_preview')!;
    expect(cookie).toBeDefined();
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    expect(cookie.path).toBe('/');
    expect(cookie.secure).toBeUndefined(); // development: ohne Secure
    expect(cookie.maxAge).toBeGreaterThan(29 * 60);
    expect(cookie.maxAge).toBeLessThanOrEqual(30 * 60);
    expect(cookie.value).not.toBe(token);
    const row = (await ctx.db.select().from(cmsPreviewAccess))[0]!;
    expect(row.sessionTokenHash).toBe(sha256Hex(cookie.value));
    expect(row.consumedAt).not.toBeNull();

    const again = await consume(ctx, token);
    expect(again.statusCode).toBe(401);
    expect(again.json().error.code).toBe('CMS_PREVIEW_INVALID');
    expect(again.body).not.toContain(token);
    for (const wrong of ['x'.repeat(43), 'kurz', `${token}x`]) {
      const response = await consume(ctx, wrong);
      expect(response.statusCode, wrong).toBe(401);
    }
  });

  it('P3. Vorschau zeigt GENAU die gebundene Revision; öffentliche Seite und öffentliche Routen bleiben unberührt', async () => {
    const { faq, v2 } = await publishedFaqWithDraft();
    const token = tokenOf((await createPreview(ctx, world.editor.cookie, faq.id)).json().url);
    const cookie = previewCookieOf(await consume(ctx, token));
    // Danach weiter bearbeitet – die Vorschau bleibt an Revision 2 gebunden
    await world.cms.saveDraft(world.editor.id, faq.id, {
      baseRevisionId: v2.draft.revisionId,
      content: faqContent('Dritte Fassung.'),
      metaTitle: 'FAQ',
    });
    const preview = await call(ctx, 'GET', '/public/cms/preview/page', { cookie });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['cache-control']).toBe('private, no-store');
    expect(preview.headers['x-robots-tag']).toBe('noindex, noarchive');
    const body = preview.json();
    expect(body.preview).toMatchObject({
      revisionId: v2.draft.revisionId,
      revisionNumber: 2,
      entryKind: 'page',
    });
    expect(body.page).toMatchObject({ path: '/faq', pageType: 'faq', publishedAt: null });
    expect(preview.body).toContain('Entwurfsantwort Version zwei.');
    expect(preview.body).not.toContain('Dritte Fassung.');
    expect(preview.body).not.toContain('editorNote');
    // Öffentliche Seite liest das Vorschau-Cookie nie
    const publicPage = await call(ctx, 'GET', '/public/site/page?path=/faq', { cookie });
    expect(publicPage.body).toContain('Veröffentlichte Antwort.');
    expect(publicPage.body).not.toContain('Entwurfsantwort');
    // Ohne Cookie keine Vorschau
    expect((await call(ctx, 'GET', '/public/cms/preview/page')).statusCode).toBe(401);
  });

  it('P4. Nur Revisionen DIESES Eintrags; ältere eigene Revision ausdrücklich wählbar', async () => {
    const { faq } = await publishedFaqWithDraft();
    const about = await seedPage(
      world,
      { pageType: 'about', path: '/ueber-uns' },
      { content: { title: 'Über uns', blocks: [] } },
    );
    const foreign = await createPreview(ctx, world.editor.cookie, faq.id, {
      revisionId: about.draft.revisionId,
    });
    expect(foreign.statusCode).toBe(404);
    const older = await createPreview(ctx, world.editor.cookie, faq.id, {
      revisionId: faq.draft.revisionId,
    });
    expect(older.statusCode).toBe(201);
    const cookie = previewCookieOf(await consume(ctx, tokenOf(older.json().url)));
    const preview = (await call(ctx, 'GET', '/public/cms/preview/page', { cookie })).json();
    expect(preview.preview.revisionNumber).toBe(1);
    expect(JSON.stringify(preview.page)).toContain('Veröffentlichte Antwort.');
    expect(
      (await createPreview(ctx, world.editor.cookie, '00000000-0000-4000-8000-000000000000'))
        .statusCode,
    ).toBe(404);
  });

  it('P5. Ablauf: abgelaufener Zugang nicht einlösbar, abgelaufene Sitzung ⇒ 401/404; Aufräumen beim Erzeugen', async () => {
    const { faq } = await publishedFaqWithDraft();
    const first = tokenOf((await createPreview(ctx, world.editor.cookie, faq.id)).json().url);
    const second = tokenOf((await createPreview(ctx, world.editor.cookie, faq.id)).json().url);
    const cookie = previewCookieOf(await consume(ctx, second));
    expect((await call(ctx, 'GET', '/public/cms/preview/page', { cookie })).statusCode).toBe(200);
    await ctx.pool.query(
      `UPDATE cms_preview_access SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'`,
    );
    expect((await consume(ctx, first)).statusCode).toBe(401);
    expect((await call(ctx, 'GET', '/public/cms/preview/page', { cookie })).statusCode).toBe(401);
    // Länger als einen Tag abgelaufen ⇒ beim nächsten Erzeugen gelöscht
    await ctx.pool.query(
      `UPDATE cms_preview_access SET created_at = now() - interval '3 days', expires_at = now() - interval '2 days'`,
    );
    expect((await createPreview(ctx, world.editor.cookie, faq.id)).statusCode).toBe(201);
    expect(await ctx.db.select().from(cmsPreviewAccess)).toHaveLength(1);
  });

  it('P6. Vorschau-Medien: Entwurfsbild nur mit Cookie der gebundenen Revision (private, no-store)', async () => {
    const upload = await uploadMedia(
      ctx,
      world.editor.cookie,
      await testImage('png', 600, 300),
      'image/png',
    );
    const media = upload.json() as StaffCmsMedia;
    const unrelated = (
      await uploadMedia(ctx, world.editor.cookie, await testImage('png', 500, 500), 'image/png')
    ).json() as StaffCmsMedia;
    const page = await seedPage(
      world,
      { pageType: 'about', path: '/ueber-uns' },
      {
        content: {
          title: 'Über uns',
          blocks: [
            {
              type: 'hero',
              heading: 'Wir sind Miet-Royal',
              image: { mediaId: media.id, alt: 'Team am Stand', decorative: false },
            },
          ],
        },
      },
    );
    const token = tokenOf((await createPreview(ctx, world.editor.cookie, page.id)).json().url);
    const cookie = previewCookieOf(await consume(ctx, token));
    const preview = (await call(ctx, 'GET', '/public/cms/preview/page', { cookie })).json();
    expect(preview.page.blocks[0].image.variants).toEqual([
      { width: 480, url: `/api/public/cms/preview-media/${media.id}/480` },
    ]);
    const image = await call(ctx, 'GET', `/public/cms/preview-media/${media.id}/480`, { cookie });
    expect(image.statusCode).toBe(200);
    expect(image.headers['cache-control']).toBe('private, no-store');
    expect(image.headers['content-type']).toBe('image/webp');
    expect((await call(ctx, 'GET', `/public/cms/preview-media/${media.id}/480`)).statusCode).toBe(
      404,
    );
    expect((await call(ctx, 'GET', `/public/cms/media/${media.id}/480`)).statusCode).toBe(404);
    expect(
      (await call(ctx, 'GET', `/public/cms/preview-media/${unrelated.id}/480`, { cookie }))
        .statusCode,
    ).toBe(404);
  });

  it('P7. Einstellungs-Vorschau: Entwurf der Einstellungen + veröffentlichte Startseite', async () => {
    const home = await seedPage(
      world,
      { pageType: 'home', path: '/' },
      {
        content: { title: 'Start', blocks: [{ type: 'text', body: 'Willkommen.' }] },
        metaTitle: 'Start',
      },
    );
    await world.cms.publish(world.publisher.id, home.id, { revisionId: home.draft.revisionId });
    const settings = await seedSiteSettings(world, {
      ...SETTINGS_CONTENT,
      tagline: 'ENTWURF-TAGLINE',
    });
    const token = tokenOf((await createPreview(ctx, world.editor.cookie, settings.id)).json().url);
    const consumed = await consume(ctx, token);
    expect(consumed.json()).toMatchObject({ path: null, entryKind: 'site_settings' });
    const preview = (
      await call(ctx, 'GET', '/public/cms/preview/page', { cookie: previewCookieOf(consumed) })
    ).json();
    expect(preview.preview.entryKind).toBe('site_settings');
    expect(preview.settings).toMatchObject({
      businessName: 'Miet-Royal',
      tagline: 'ENTWURF-TAGLINE',
    });
    expect(preview.page).toMatchObject({ path: '/', title: 'Start' });
    // Öffentlich: Einstellungen nie veröffentlicht ⇒ null
    expect((await call(ctx, 'GET', '/public/site/settings')).json().settings).toBeNull();
  });

  it('P8. Token und Sitzungs-Cookie erscheinen nie im Log', async () => {
    logBuffer = '';
    const { faq } = await publishedFaqWithDraft();
    const token = tokenOf((await createPreview(ctx, world.editor.cookie, faq.id)).json().url);
    const consumed = await consume(ctx, token);
    const cookie = previewCookieOf(consumed);
    await call(ctx, 'GET', '/public/cms/preview/page', { cookie });
    await consume(ctx, token); // 401
    const sessionValue = cookie.split('=')[1]!;
    expect(logBuffer.length).toBeGreaterThan(0);
    expect(logBuffer).not.toContain(token);
    expect(logBuffer).not.toContain(sessionValue);
    expect(logBuffer).not.toContain(sha256Hex(token));
    expect(logBuffer).not.toContain('#token=');
  });

  it('P9. Cross-Site-/Same-Site-POST auf das Einlösen ⇒ 403; kein CORS-Header', async () => {
    const { faq } = await publishedFaqWithDraft();
    const token = tokenOf((await createPreview(ctx, world.editor.cookie, faq.id)).json().url);
    for (const site of ['cross-site', 'same-site']) {
      const response = await consume(ctx, token, { 'sec-fetch-site': site });
      expect(response.statusCode, site).toBe(403);
      expect(response.json().error.code).toBe('CSRF_REJECTED');
    }
    const foreignOrigin = await consume(ctx, token, { origin: 'https://evil.example' });
    expect(foreignOrigin.statusCode).toBe(403);
    // Der Zugang ist weiterhin unverbraucht und same-origin einlösbar
    const ok = await consume(ctx, token, { 'sec-fetch-site': 'same-origin' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('P10. Demo/Live getrennt: Zugang aus Datenbank A ist in Datenbank B ungültig (und umgekehrt)', async () => {
    const { faq } = await publishedFaqWithDraft();
    const tokenA = tokenOf((await createPreview(ctx, world.editor.cookie, faq.id)).json().url);
    const other = await createCmsTestContext({ databaseUrl: SECOND_DATABASE_URL });
    try {
      const worldB = await resetCmsWorld(other);
      const faqB = await seedPage(
        worldB,
        { pageType: 'faq', path: '/faq' },
        { content: faqContent('Antwort B.'), metaTitle: 'FAQ' },
      );
      const tokenB = tokenOf(
        (await createPreview(other, worldB.editor.cookie, faqB.id)).json().url,
      );
      expect((await consume(other, tokenA)).statusCode).toBe(401);
      expect((await consume(ctx, tokenB)).statusCode).toBe(401);
      const cookieA = previewCookieOf(await consume(ctx, tokenA));
      expect(
        (await call(other, 'GET', '/public/cms/preview/page', { cookie: cookieA })).statusCode,
      ).toBe(401);
      expect((await consume(other, tokenB)).statusCode).toBe(200);
    } finally {
      await destroyTestContext(other);
    }
  });

  it('P11. Ohne öffentliche Web-Adresse 409 CMS_PREVIEW_UNAVAILABLE; Einlösen 20/min je IP', async () => {
    const plain = await createTestContext({ rateLimitEnabled: true });
    try {
      expect(plain.config.mail.publicWebBaseUrl).toBeNull();
      const worldPlain = await resetCmsWorld(plain);
      const faq = await seedPage(
        worldPlain,
        { pageType: 'faq', path: '/faq' },
        { content: faqContent() },
      );
      const unavailable = await createPreview(plain, worldPlain.editor.cookie, faq.id);
      expect(unavailable.statusCode).toBe(409);
      expect(unavailable.json().error.code).toBe('CMS_PREVIEW_UNAVAILABLE');
      expect(await plain.db.select().from(cmsPreviewAccess)).toEqual([]);
      const statuses: number[] = [];
      for (let i = 0; i < 21; i += 1) {
        statuses.push((await consume(plain, 'y'.repeat(43))).statusCode);
      }
      expect(statuses.slice(0, 20).every((status) => status === 401)).toBe(true);
      expect(statuses[20]).toBe(429);
    } finally {
      await destroyTestContext(plain);
    }
  });

  it('P12. Nur-Veröffentlicher sieht Entwurf in der Vorschau und kann ihn danach veröffentlichen', async () => {
    const { faq, v2 } = await publishedFaqWithDraft();
    const created = await createPreview(ctx, world.publisher.cookie, faq.id);
    const cookie = previewCookieOf(await consume(ctx, tokenOf(created.json().url)));
    expect((await call(ctx, 'GET', '/public/cms/preview/page', { cookie })).body).toContain(
      'Entwurfsantwort Version zwei.',
    );
    const published = await call(ctx, 'POST', `/staff/cms/entries/${faq.id}/publish`, {
      cookie: world.publisher.cookie,
      payload: { revisionId: v2.draft.revisionId },
    });
    expect(published.statusCode).toBe(200);
    expect((published.json() as StaffCmsEntryDetail).status).toBe('published');
    expect((await call(ctx, 'GET', '/public/site/page?path=/faq')).body).toContain(
      'Entwurfsantwort Version zwei.',
    );
  });
});
