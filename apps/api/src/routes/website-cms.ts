import type { PermissionKey } from '@mietroyal/permissions';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth, requirePermission, sendError } from '../auth/http.ts';
import type { AuthenticatedContext } from '../auth/service.ts';
import { CmsService } from '../cms/cms-service.ts';
import { CMS_MESSAGES, CmsError, sendCmsError } from '../cms/errors.ts';
import { CMS_MEDIA_MAX_BYTES, CmsMediaService } from '../cms/media-service.ts';
import { cmsPreviewCookieName, CmsPreviewService } from '../cms/preview-service.ts';
import { PublicSiteService } from '../cms/public-site.ts';
import { buildPublicCatalog } from '../public/catalog.ts';
import type { WebsiteModuleDeps } from '../website/module.ts';
import { UUID_PATTERN } from './auth.ts';

/**
 * Phase 16 – CMS (Order §6–§10/§22, Design §2): `/staff/cms/*`, `/public/site/*`, `/public/cms/*`.
 *
 * Rechte (serverseitig, frisch berechnet): Lesen `cms.edit` ODER `cms.publish`; Entwurf
 * ändern/wiederherstellen, Regionsseite anlegen, Medien hochladen/bearbeiten `cms.edit`;
 * Veröffentlichen/Zurückziehen `cms.publish`; Vorschau erzeugen edit|publish;
 * „Produkte & Preise“-Lesesicht `product.view`. Bodies sind `strictObject`.
 *
 * Öffentlich: `/public/site/*` (SSR der Web-App, KEIN IP-Limit, `no-store`, kein CORS) liest
 * nur VERÖFFENTLICHTE Inhalte; das Vorschau-Cookie wird dort nie gelesen. Medien nur über
 * die opake ID, veröffentlicht mit `immutable`-Cache. Vorschau: POST-Einlösen (CSRF-Hook,
 * 20/min je IP, Reset-Gate in demo) ⇒ HttpOnly-Cookie; Antworten `private, no-store`,
 * `noindex, noarchive`, `no-referrer`. Tokens erscheinen nie in Logs oder Fehlerbodies.
 */

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const widthSchema = z.string().regex(/^[1-9][0-9]{0,4}$/, 'muss eine Breite sein');
const idParams = z.strictObject({ id: uuidSchema });
const revisionParams = z.strictObject({ revisionId: uuidSchema });
const mediaVariantParams = z.strictObject({ mediaId: uuidSchema, width: widthSchema });
const staffMediaVariantParams = z.strictObject({ id: uuidSchema, width: widthSchema });

const optionalText = (maxLength: number) => z.string().max(maxLength).nullable().optional();

const draftBody = z.strictObject({
  baseRevisionId: uuidSchema,
  content: z.unknown(),
  metaTitle: optionalText(500),
  metaDescription: optionalText(1000),
  editorNote: optionalText(4000),
});
const restoreBody = z.strictObject({ revisionId: uuidSchema, baseRevisionId: uuidSchema });
const publishBody = z.strictObject({ revisionId: uuidSchema });
const emptyBody = z.strictObject({});
const createRegionBody = z.strictObject({
  regionSlug: z.string().max(100),
  title: z.string().max(500),
});
const previewBody = z.strictObject({ revisionId: uuidSchema.optional() });
const mediaUploadBody = z.strictObject({
  label: z.string().max(500),
  mimeType: z.string().max(100),
  // Base64 von höchstens 6 MiB Rohdaten (+ Padding); Feinprüfung nach dem Dekodieren.
  dataBase64: z
    .string()
    .min(1)
    .max(Math.ceil(CMS_MEDIA_MAX_BYTES / 3) * 4 + 8),
});
const mediaUpdateBody = z.strictObject({
  label: z.string().max(500).optional(),
  defaultAlt: z.string().max(1000).nullable().optional(),
});
const consumeBody = z.strictObject({ token: z.string().max(200) });
/** Pfad wie DB-Check `cms_entries_path_format`. */
const sitePageQuery = z.strictObject({
  path: z
    .string()
    .max(200)
    .regex(/^\/([a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*)?$/, 'Ungültiger Pfad.'),
});

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64(value: string): Uint8Array | null {
  if (!BASE64_PATTERN.test(value)) return null;
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  return bytes.length === 0 ? null : bytes;
}

/** Header der Vorschau-Antworten (Design §2.4.5): nie gecacht, nie indexiert, kein Referrer. */
function setPreviewHeaders(reply: FastifyReply): void {
  void reply.header('cache-control', 'private, no-store');
  void reply.header('x-robots-tag', 'noindex, noarchive');
  void reply.header('referrer-policy', 'no-referrer');
}

function sendImage(reply: FastifyReply, bytes: Uint8Array, cacheControl: string) {
  void reply.header('content-type', 'image/webp');
  void reply.header('cache-control', cacheControl);
  void reply.header('x-content-type-options', 'nosniff');
  void reply.header('content-security-policy', "default-src 'none'; sandbox");
  void reply.header('cross-origin-resource-policy', 'same-origin');
  return reply.send(Buffer.from(bytes));
}

function notFound(request: FastifyRequest, reply: FastifyReply): void {
  sendError(request, reply, 404, 'NOT_FOUND', 'Ressource nicht gefunden');
}

const READ: readonly PermissionKey[] = ['cms.edit', 'cms.publish'];
const EDIT: readonly PermissionKey[] = ['cms.edit'];
const PUBLISH: readonly PermissionKey[] = ['cms.publish'];

export function registerWebsiteCmsRoutes(instance: FastifyInstance, deps: WebsiteModuleDeps): void {
  const { db, auth, config, storage, logger } = deps;
  const cms = new CmsService(db, { publicWebBaseUrl: config.mail.publicWebBaseUrl });
  const media = new CmsMediaService(db, storage);
  const previews = new CmsPreviewService(db);
  const site = new PublicSiteService(db, media, {
    environment: config.appEnv,
    reviewsMode: deps.reviews.mode,
    logger,
  });
  const previewCookie = cmsPreviewCookieName(config.appEnv);
  const rateLimitEnabled = deps.rateLimitEnabled ?? instance.hasDecorator('rateLimit');
  const ipLimit = (max: number) =>
    rateLimitEnabled
      ? {
          rateLimit: {
            max,
            timeWindow: '1 minute',
            keyGenerator: (request: FastifyRequest) => request.ip,
          },
        }
      : false;

  /** Anmeldung + MINDESTENS EINES der Rechte (Lesen: cms.edit ODER cms.publish). */
  const requireAny = async (
    request: FastifyRequest,
    reply: FastifyReply,
    keys: readonly PermissionKey[],
  ): Promise<AuthenticatedContext | null> => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return null;
    if (keys.length === 1) {
      return (await requirePermission(request, reply, auth, context, keys[0]!)) ? context : null;
    }
    const effective = await auth.effectivePermissions(context.user.id);
    if (!keys.some((key) => effective.has(key))) {
      sendError(
        request,
        reply,
        403,
        'FORBIDDEN',
        'Dafür fehlt dir die erforderliche Berechtigung.',
      );
      return null;
    }
    return context;
  };

  const handle = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    work: () => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await work();
    } catch (error) {
      if (sendCmsError(request, reply, error)) return undefined;
      throw error;
    }
  };

  // ── Staff: Einträge ───────────────────────────────────────────────────────

  instance.get('/staff/cms/entries', async (request, reply) => {
    if ((await requireAny(request, reply, READ)) === null) return;
    return { entries: await cms.listEntries() };
  });

  instance.get('/staff/cms/entries/:id', async (request, reply) => {
    if ((await requireAny(request, reply, READ)) === null) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    return handle(request, reply, () => cms.getEntry(params.id));
  });

  instance.get('/staff/cms/revisions/:revisionId', async (request, reply) => {
    if ((await requireAny(request, reply, READ)) === null) return;
    const params = parseOrThrow(revisionParams, request.params, 'params');
    return handle(request, reply, () => cms.getRevision(params.revisionId));
  });

  instance.put('/staff/cms/entries/:id/draft', async (request, reply) => {
    const context = await requireAny(request, reply, EDIT);
    if (context === null) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(draftBody, request.body);
    return handle(request, reply, () =>
      cms.saveDraft(context.user.id, params.id, {
        baseRevisionId: body.baseRevisionId,
        content: body.content,
        metaTitle: body.metaTitle,
        metaDescription: body.metaDescription,
        editorNote: body.editorNote,
      }),
    );
  });

  instance.post('/staff/cms/entries/:id/restore', async (request, reply) => {
    const context = await requireAny(request, reply, EDIT);
    if (context === null) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(restoreBody, request.body);
    return handle(request, reply, () => cms.restoreRevision(context.user.id, params.id, body));
  });

  instance.post('/staff/cms/entries/:id/publish', async (request, reply) => {
    const context = await requireAny(request, reply, PUBLISH);
    if (context === null) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(publishBody, request.body);
    return handle(request, reply, () =>
      cms.publish(context.user.id, params.id, body, { source: 'staff' }),
    );
  });

  instance.post('/staff/cms/entries/:id/unpublish', async (request, reply) => {
    const context = await requireAny(request, reply, PUBLISH);
    if (context === null) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    parseOrThrow(emptyBody, request.body ?? {});
    return handle(request, reply, () => cms.unpublish(context.user.id, params.id));
  });

  instance.post('/staff/cms/entries', async (request, reply) => {
    const context = await requireAny(request, reply, EDIT);
    if (context === null) return;
    const body = parseOrThrow(createRegionBody, request.body);
    const detail = await handle(request, reply, () => cms.createRegionPage(context.user.id, body));
    if (detail === undefined) return;
    return reply.status(201).send(detail);
  });

  instance.post('/staff/cms/entries/:id/preview', async (request, reply) => {
    const context = await requireAny(request, reply, READ);
    if (context === null) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(previewBody, request.body ?? {});
    void reply.header('cache-control', 'no-store');
    void reply.header('referrer-policy', 'no-referrer');
    const access = await handle(request, reply, () =>
      cms.createPreviewAccess(context.user.id, params.id, { revisionId: body.revisionId }),
    );
    if (access === undefined) return;
    return reply.status(201).send(access);
  });

  // ── Staff: Medien ─────────────────────────────────────────────────────────

  instance.get('/staff/cms/media', async (request, reply) => {
    if ((await requireAny(request, reply, READ)) === null) return;
    return { media: await media.list() };
  });

  instance.post('/staff/cms/media', { bodyLimit: 9 * 1024 * 1024 }, async (request, reply) => {
    const context = await requireAny(request, reply, EDIT);
    if (context === null) return;
    const body = parseOrThrow(mediaUploadBody, request.body);
    const bytes = decodeBase64(body.dataBase64);
    if (bytes === null) {
      sendCmsError(request, reply, new CmsError('CMS_MEDIA_REJECTED', CMS_MESSAGES.MEDIA_REJECTED));
      return;
    }
    const created = await handle(request, reply, () =>
      media.upload(context.user.id, { label: body.label, mimeType: body.mimeType, bytes }),
    );
    if (created === undefined) return;
    return reply.status(201).send(created);
  });

  instance.patch('/staff/cms/media/:id', async (request, reply) => {
    if ((await requireAny(request, reply, EDIT)) === null) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(mediaUpdateBody, request.body);
    return handle(request, reply, () =>
      media.update(params.id, { label: body.label, defaultAlt: body.defaultAlt }),
    );
  });

  instance.get('/staff/cms/media/:id/:width', async (request, reply) => {
    if ((await requireAny(request, reply, READ)) === null) return;
    const params = parseOrThrow(staffMediaVariantParams, request.params, 'params');
    const bytes = await media.variantBytes(params.id, Number(params.width), { kind: 'staff' });
    if (bytes === null) return notFound(request, reply);
    return sendImage(reply, bytes, 'private, no-store');
  });

  // ── Staff: „Produkte & Preise“ (Lesesicht der öffentlichen Projektion) ─────

  instance.get('/staff/cms/catalog', async (request, reply) => {
    if ((await requireAny(request, reply, ['product.view'])) === null) return;
    return buildPublicCatalog(db, new Date(), { logger: request.log });
  });

  // ── Öffentlich: veröffentlichte Website-Inhalte (SSR, ohne IP-Limit) ─────

  instance.get('/public/site/settings', async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
    return site.bootstrap(new Date());
  });

  instance.get('/public/site/page', async (request, reply) => {
    const query = parseOrThrow(sitePageQuery, request.query, 'query');
    void reply.header('cache-control', 'no-store');
    const page = await site.publishedPage(query.path, new Date());
    if (page === null) return notFound(request, reply);
    return page;
  });

  instance.get('/public/cms/media/:mediaId/:width', async (request, reply) => {
    const params = parseOrThrow(mediaVariantParams, request.params, 'params');
    const bytes = await media.variantBytes(params.mediaId, Number(params.width), {
      kind: 'published',
    });
    if (bytes === null) return notFound(request, reply);
    return sendImage(reply, bytes, 'public, max-age=31536000, immutable');
  });

  // ── Öffentlich: Vorschau (Cookie-gebunden an genau eine Revision) ─────────

  instance.post('/public/cms/preview/consume', { config: ipLimit(20) }, async (request, reply) => {
    setPreviewHeaders(reply);
    const body = parseOrThrow(consumeBody, request.body);
    const now = new Date();
    const result = await previews.consume(body.token, now);
    if (result === null) {
      sendError(request, reply, 401, 'CMS_PREVIEW_INVALID', CMS_MESSAGES.PREVIEW_INVALID);
      return;
    }
    const maxAge = Math.max(1, Math.floor((result.expiresAt.getTime() - now.getTime()) / 1000));
    void reply.setCookie(previewCookie, result.sessionToken, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: config.appEnv !== 'development',
      maxAge,
    });
    return {
      path: result.path,
      entryKind: result.entryKind,
      expiresAt: result.expiresAt.toISOString(),
    };
  });

  instance.get('/public/cms/preview/page', async (request, reply) => {
    setPreviewHeaders(reply);
    const now = new Date();
    const session = await previews.resolveSession(request.cookies[previewCookie], now);
    const page = session === null ? null : await site.previewPage(session, now);
    if (page === null) {
      sendError(request, reply, 401, 'CMS_PREVIEW_INVALID', CMS_MESSAGES.PREVIEW_INVALID);
      return;
    }
    return page;
  });

  instance.get('/public/cms/preview-media/:mediaId/:width', async (request, reply) => {
    setPreviewHeaders(reply);
    const params = parseOrThrow(mediaVariantParams, request.params, 'params');
    const session = await previews.resolveSession(request.cookies[previewCookie]);
    if (session === null) return notFound(request, reply);
    const bytes = await media.variantBytes(params.mediaId, Number(params.width), {
      kind: 'preview',
      revisionId: session.revisionId,
    });
    if (bytes === null) return notFound(request, reply);
    return sendImage(reply, bytes, 'private, no-store');
  });
}
