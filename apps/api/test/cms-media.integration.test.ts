import { PassThrough } from 'node:stream';
import { cmsMedia, cmsMediaVariants, cmsRevisionMedia } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StaffCmsEntryDetail } from '../src/cms/cms-service.ts';
import type { StaffCmsMedia } from '../src/cms/media-service.ts';
import { destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  call,
  createCmsTestContext,
  resetCmsWorld,
  seedPage,
  testImage,
  uploadMedia,
  type CmsWorld,
} from './cms-world.ts';

/**
 * Phase 16 (CMS-Medien, Order §8/§25, Design §2.3/§11.2.11/§11.3): Upload nur mit
 * cms.edit; nur JPEG/PNG/WebP (Größe ⇒ Magic Bytes ⇒ Decode); SVG/HTML/GIF/getarnte und
 * defekte Dateien ⇒ 400; EXIF/Metadaten entfernt, Ausrichtung angewendet; WebP-Varianten
 * 480/960/1600 (nur ≤ Original, mindestens eine); Storage-Key in keinem DTO und keinem Log;
 * Entwurfsmedium öffentlich 404, nach Veröffentlichung 200 mit immutable-Cache-Headern;
 * `cms_revision_media` je Revision. Namen laufen als „M<n>.“.
 */

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

async function uploadOk(bytes: Buffer, mimeType: string, label = 'Testbild') {
  const response = await uploadMedia(ctx, world.editor.cookie, bytes, mimeType, label);
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as StaffCmsMedia;
}

async function imagePage(mediaId: string, alt = 'Slushmaschine auf einem Gartenfest') {
  return seedPage(
    world,
    { pageType: 'about', path: '/ueber-uns' },
    {
      content: {
        title: 'Über uns',
        blocks: [{ type: 'image', image: { mediaId, alt, decorative: false } }],
      },
      metaTitle: 'Über uns',
    },
  );
}

describe('Phase 16 – CMS-Medien', () => {
  it('M1. Upload nur mit cms.edit', async () => {
    const png = await testImage('png', 800, 400);
    expect((await uploadMedia(ctx, world.publisher.cookie, png, 'image/png')).statusCode).toBe(403);
    expect((await uploadMedia(ctx, world.viewer.cookie, png, 'image/png')).statusCode).toBe(403);
    expect((await uploadMedia(ctx, '', png, 'image/png')).statusCode).toBe(401);
    const media = await uploadOk(png, 'image/png');
    expect(media).toMatchObject({
      width: 800,
      height: 400,
      variantWidths: [480],
      usedInPublished: false,
    });
    const patchByPublisher = await call(ctx, 'PATCH', `/staff/cms/media/${media.id}`, {
      cookie: world.publisher.cookie,
      payload: { defaultAlt: 'x' },
    });
    expect(patchByPublisher.statusCode).toBe(403);
    const patched = await call(ctx, 'PATCH', `/staff/cms/media/${media.id}`, {
      cookie: world.editor.cookie,
      payload: { label: 'Maschine', defaultAlt: 'Slushmaschine mit zwei Behältern' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      label: 'Maschine',
      defaultAlt: 'Slushmaschine mit zwei Behältern',
    });
    const listed = await call(ctx, 'GET', '/staff/cms/media', { cookie: world.publisher.cookie });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { media: StaffCmsMedia[] }).media).toHaveLength(1);
  });

  it('M2. Abgelehnt: SVG, HTML, GIF, getarnte, defekte und zu große Dateien – nichts gespeichert', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      'utf8',
    );
    const html = Buffer.from('<!doctype html><html><body>x</body></html>', 'utf8');
    const gif = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .gif()
      .toBuffer();
    const png = await testImage('png', 100, 100);
    const jpeg = await testImage('jpeg', 400, 300);
    const truncated = Buffer.concat([jpeg.subarray(0, 200), Buffer.alloc(200, 0x11)]);
    const tooLarge = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.alloc(6 * 1024 * 1024),
    ]);
    const cases: Array<[string, Buffer, string]> = [
      ['svg', svg, 'image/svg+xml'],
      ['svg als png', svg, 'image/png'],
      ['html als jpeg', html, 'image/jpeg'],
      ['gif', gif, 'image/gif'],
      ['gif als png', gif, 'image/png'],
      ['png als jpeg getarnt', png, 'image/jpeg'],
      ['jpeg als webp getarnt', jpeg, 'image/webp'],
      ['defektes jpeg', truncated, 'image/jpeg'],
      ['zu groß', tooLarge, 'image/jpeg'],
    ];
    for (const [name, bytes, mimeType] of cases) {
      const response = await uploadMedia(ctx, world.editor.cookie, bytes, mimeType);
      expect(response.statusCode, name).toBe(400);
      expect(response.json().error.code, name).toBe('CMS_MEDIA_REJECTED');
    }
    const notBase64 = await call(ctx, 'POST', '/staff/cms/media', {
      cookie: world.editor.cookie,
      payload: { label: 'x', mimeType: 'image/png', dataBase64: '<<<kein base64>>>' },
    });
    expect(notBase64.statusCode).toBe(400);
    const extraField = await call(ctx, 'POST', '/staff/cms/media', {
      cookie: world.editor.cookie,
      payload: {
        label: 'x',
        mimeType: 'image/png',
        dataBase64: png.toString('base64'),
        storageKey: 'cms-media/x/1.webp',
      },
    });
    expect(extraField.statusCode).toBe(400);
    expect(await ctx.db.select().from(cmsMedia)).toEqual([]);
    expect(await ctx.db.select().from(cmsMediaVariants)).toEqual([]);
  });

  it('M3. EXIF/Metadaten entfernt, Ausrichtung angewendet, WebP-Varianten nur ≤ Original', async () => {
    const marker = 'GEHEIM-EXIF-MARKER-4711';
    const jpeg = await testImage('jpeg', 1200, 600, { exifMarker: marker, orientation: 6 });
    const before = await sharp(jpeg).metadata();
    expect(before.exif).toBeDefined();
    expect(jpeg.includes(Buffer.from(marker))).toBe(true);

    const media = await uploadOk(jpeg, 'image/jpeg');
    // Orientation 6 ⇒ um 90° gedreht: 600 × 1200; nur 480 ≤ 600
    expect(media).toMatchObject({ width: 600, height: 1200, variantWidths: [480] });
    const variant = await call(ctx, 'GET', `/staff/cms/media/${media.id}/480`, {
      cookie: world.publisher.cookie,
    });
    expect(variant.statusCode).toBe(200);
    expect(variant.headers['content-type']).toBe('image/webp');
    expect(variant.headers['cache-control']).toBe('private, no-store');
    const bytes = variant.rawPayload;
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(480);
    expect(meta.height).toBe(960);
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(bytes.includes(Buffer.from(marker))).toBe(false);
    expect(bytes.includes(Buffer.from('Exif'))).toBe(false);

    const big = await uploadOk(await testImage('png', 2000, 1000), 'image/png');
    expect(big.variantWidths).toEqual([480, 960, 1600]);
    const small = await uploadOk(await testImage('webp', 300, 200), 'image/webp');
    expect(small.variantWidths).toEqual([300]);
    const rows = await ctx.db
      .select()
      .from(cmsMediaVariants)
      .where(eq(cmsMediaVariants.mediaId, big.id));
    expect(rows.map((row) => [row.width, row.height, row.mimeType])).toEqual(
      expect.arrayContaining([
        [480, 240, 'image/webp'],
        [960, 480, 'image/webp'],
        [1600, 800, 'image/webp'],
      ]),
    );
    expect(rows.every((row) => row.storageKey === `cms-media/${big.id}/${row.width}.webp`)).toBe(
      true,
    );
    // Kein Original im Storage: nur die Varianten-Keys existieren
    expect(await ctx.storage.exists(`cms-media/${big.id}/2000.webp`)).toBe(false);
  });

  it('M4. Entwurfsmedium öffentlich 404 (auch erraten); nach Veröffentlichung 200 mit immutable-Headern', async () => {
    const media = await uploadOk(await testImage('png', 1000, 500), 'image/png');
    const page = await imagePage(media.id);
    const publicUrl = `/public/cms/media/${media.id}/960`;
    expect((await call(ctx, 'GET', publicUrl)).statusCode).toBe(404);
    expect((await call(ctx, 'GET', `/public/cms/preview-media/${media.id}/960`)).statusCode).toBe(
      404,
    );

    const published = await call(ctx, 'POST', `/staff/cms/entries/${page.id}/publish`, {
      cookie: world.publisher.cookie,
      payload: { revisionId: page.draft.revisionId },
    });
    expect(published.statusCode).toBe(200);
    const response = await call(ctx, 'GET', publicUrl);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(response.headers['content-type']).toBe('image/webp');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    // Nur exakt vorhandene Breiten
    expect((await call(ctx, 'GET', `/public/cms/media/${media.id}/1600`)).statusCode).toBe(404);
    expect((await call(ctx, 'GET', `/public/cms/media/${media.id}/abc`)).statusCode).toBe(400);
    expect(
      (await call(ctx, 'GET', '/public/cms/media/00000000-0000-4000-8000-000000000000/480'))
        .statusCode,
    ).toBe(404);
    // Anderes (nie veröffentlichtes) Medium bleibt privat
    const other = await uploadOk(await testImage('png', 500, 500), 'image/png');
    expect((await call(ctx, 'GET', `/public/cms/media/${other.id}/480`)).statusCode).toBe(404);
    const listed = (
      await call(ctx, 'GET', '/staff/cms/media', { cookie: world.editor.cookie })
    ).json() as { media: StaffCmsMedia[] };
    expect(listed.media.find((item) => item.id === media.id)?.usedInPublished).toBe(true);
    expect(listed.media.find((item) => item.id === other.id)?.usedInPublished).toBe(false);

    // Öffentliches Seiten-DTO: PublicImage mit Varianten-URLs, keine Storage-Keys
    const publicPage = await call(ctx, 'GET', '/public/site/page?path=/ueber-uns');
    expect(publicPage.statusCode).toBe(200);
    expect(publicPage.json().blocks[0]).toEqual({
      type: 'image',
      image: {
        mediaId: media.id,
        alt: 'Slushmaschine auf einem Gartenfest',
        decorative: false,
        width: 960,
        height: 480,
        variants: [
          { width: 480, url: `/api/public/cms/media/${media.id}/480` },
          { width: 960, url: `/api/public/cms/media/${media.id}/960` },
        ],
      },
    });
  });

  it('M5. cms_revision_media je Revision; unbekannte Medien-ID ⇒ 400 CMS_MEDIA_UNKNOWN', async () => {
    const media = await uploadOk(await testImage('webp', 600, 400), 'image/webp');
    const page = await imagePage(media.id);
    const saved = await call(ctx, 'PUT', `/staff/cms/entries/${page.id}/draft`, {
      cookie: world.editor.cookie,
      payload: {
        baseRevisionId: page.draft.revisionId,
        content: {
          title: 'Über uns',
          blocks: [
            {
              type: 'gallery',
              images: [{ mediaId: media.id, alt: '', decorative: true }],
            },
          ],
        },
      },
    });
    expect(saved.statusCode).toBe(200);
    const v2 = saved.json() as StaffCmsEntryDetail;
    const bindings = await ctx.db.select().from(cmsRevisionMedia);
    expect(bindings.map((row) => row.revisionId).sort()).toEqual(
      [page.draft.revisionId, v2.draft.revisionId].sort(),
    );
    const unknown = await call(ctx, 'PUT', `/staff/cms/entries/${page.id}/draft`, {
      cookie: world.editor.cookie,
      payload: {
        baseRevisionId: v2.draft.revisionId,
        content: {
          title: 'Über uns',
          blocks: [
            {
              type: 'image',
              image: {
                mediaId: '00000000-0000-4000-8000-000000000000',
                alt: 'Erfundenes Bild',
                decorative: false,
              },
            },
          ],
        },
      },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('CMS_MEDIA_UNKNOWN');
  });

  it('M6. Storage-Key erscheint in keinem DTO und keinem Log', async () => {
    logBuffer = '';
    const media = await uploadOk(await testImage('jpeg', 1000, 800), 'image/jpeg');
    const page = await imagePage(media.id);
    await call(ctx, 'POST', `/staff/cms/entries/${page.id}/publish`, {
      cookie: world.publisher.cookie,
      payload: { revisionId: page.draft.revisionId },
    });
    const bodies = [
      (await call(ctx, 'GET', '/staff/cms/media', { cookie: world.editor.cookie })).body,
      (await call(ctx, 'GET', `/staff/cms/entries/${page.id}`, { cookie: world.editor.cookie }))
        .body,
      (await call(ctx, 'GET', '/staff/cms/entries', { cookie: world.editor.cookie })).body,
      (await call(ctx, 'GET', '/public/site/page?path=/ueber-uns')).body,
      (await call(ctx, 'GET', '/public/site/settings')).body,
    ];
    for (const body of bodies) {
      expect(body).not.toContain('cms-media/');
      expect(body).not.toContain('storageKey');
      expect(body).not.toContain('sourceSha256');
    }
    expect(logBuffer).not.toContain('cms-media/');
    expect(logBuffer).not.toContain('dataBase64');
  });
});
