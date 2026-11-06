import type { AppEnvironment } from '@mietroyal/config';
import {
  cmsEntries,
  cmsRevisions,
  type CmsEntryRow,
  type CmsRevisionRow,
  type Database,
} from '@mietroyal/database';
import {
  CMS_FIXED_PAGE_PATHS,
  cmsPageContentSchema,
  cmsSiteSettingsSchema,
  collectCmsMediaIds,
  collectCmsStrings,
  containsExactAddress,
  exactAddressFragments,
  type CmsBlock,
  type CmsImageRef,
  type CmsPageContent,
  type CmsPageTypeName,
  type CmsSiteSettings,
} from '@mietroyal/validation/cms';
import { and, asc, eq } from 'drizzle-orm';
import { getPickupExactAddress } from '../crm/settings-service.ts';
import {
  buildPublicCatalog,
  buildPublicProducts,
  publicPickupArea,
  type PublicCatalog,
  type PublicProduct,
} from '../public/catalog.ts';
import type { ReviewMode } from '../reviews/types.ts';
import type { CmsMediaService, CmsMediaVariantInfo } from './media-service.ts';
import type { CmsPreviewSession } from './preview-service.ts';
import { loadPublishedEntry } from './published-content.ts';

/**
 * Phase 16 (CMS, Design §2.5/§11.2.2b/§11.2.3): öffentliche Projektion VERÖFFENTLICHTER
 * Inhalte (und – nur über das Vorschau-Cookie – genau einer gebundenen Revision).
 *
 * - Bildreferenzen ⇒ `PublicImage` mit Varianten-URLs über die opake Medien-ID
 *   (`/api/public/cms/media/…`, Vorschau `/api/public/cms/preview-media/…`); nie Storage-Keys.
 * - `product_grid`/`included_items` werden serverseitig mit dem aktuellen Katalog aufgelöst
 *   (Preise ausschließlich aus products/product_prices zum Zeitpunkt `now`).
 * - Exakte Abholadresse fail-closed: Blöcke/Felder, die die (inzwischen) gepflegte Adresse
 *   enthalten, fallen weg; betrifft es Titel/Meta-Titel, gilt die Seite als nicht vorhanden.
 *   Geloggt wird nur die Eintrags-ID.
 * - `reviews`-Blöcke entfallen, solange kein Bewertungs-Provider aktiv ist.
 * - Keine Redaktionsnotizen, keine Staff-IDs, keine Storage-Keys.
 */

export const PUBLIC_MEDIA_URL_BASE = '/api/public/cms/media';
export const PREVIEW_MEDIA_URL_BASE = '/api/public/cms/preview-media';

export interface PublicImage {
  mediaId: string;
  alt: string;
  decorative: boolean;
  width: number;
  height: number;
  variants: Array<{ width: number; url: string }>;
}

type BlockOf<T extends CmsBlock['type']> = Extract<CmsBlock, { type: T }>;

export type PublicHeroBlock = Omit<BlockOf<'hero'>, 'image'> & { image?: PublicImage };
export type PublicImageBlock = Omit<BlockOf<'image'>, 'image'> & { image: PublicImage };
export type PublicGalleryBlock = Omit<BlockOf<'gallery'>, 'images'> & { images: PublicImage[] };
export type PublicProductGridBlock = BlockOf<'product_grid'> & { products: PublicProduct[] };
export type PublicIncludedItemsBlock = BlockOf<'included_items'> & {
  included: PublicCatalog['included'];
  syrups: PublicProduct[];
  accessories: PublicProduct[];
  canister: PublicCatalog['canister'];
};
export type PublicBlock =
  | PublicHeroBlock
  | PublicImageBlock
  | PublicGalleryBlock
  | PublicProductGridBlock
  | PublicIncludedItemsBlock
  | BlockOf<
      | 'text'
      | 'features'
      | 'steps'
      | 'faq'
      | 'reviews'
      | 'service_areas'
      | 'secondary_offers'
      | 'contact_details'
      | 'cta'
    >;

export interface PublicPage {
  path: string;
  pageType: CmsPageTypeName;
  revisionId: string;
  /** Zeitpunkt der Veröffentlichung; `null` nur in der Vorschau eines Entwurfs. */
  publishedAt: string | null;
  title: string;
  metaTitle: string | null;
  metaDescription: string | null;
  blocks: PublicBlock[];
}

export interface PublicSiteSettings {
  businessName: string;
  tagline: string | null;
  phone: string | null;
  email: string | null;
  instagramUrl: string | null;
  logo: PublicImage | null;
  footerNote: string | null;
}

export interface PublicSitePageSummary {
  path: string;
  pageType: CmsPageTypeName;
  title: string;
  metaDescription: string | null;
}

export interface PublicSiteBootstrap {
  environment: AppEnvironment;
  settings: PublicSiteSettings | null;
  pages: PublicSitePageSummary[];
  reviews: { mode: ReviewMode };
  pickupArea: string;
}

export interface PublicPreviewPage {
  preview: {
    revisionId: string;
    revisionNumber: number;
    expiresAt: string;
    entryKind: 'site_settings' | 'page';
  };
  /** Seitenentwurf bzw. – bei einer Einstellungs-Vorschau – die veröffentlichte Startseite. */
  page: PublicPage | null;
  /** Einstellungs-Entwurf bei einer Einstellungs-Vorschau, sonst die veröffentlichten Einstellungen. */
  settings: PublicSiteSettings | null;
}

export interface PublicSiteLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface PublicSiteServiceOptions {
  environment: AppEnvironment;
  reviewsMode: ReviewMode;
  logger: PublicSiteLogger;
}

/** Kontext EINES Requests (Adressfragmente und Katalog nur einmal laden). */
interface ProjectionContext {
  now: Date;
  fragments: string[];
  catalog: () => Promise<PublicCatalog>;
}

function hasAddress(ctx: ProjectionContext, value: unknown): boolean {
  if (ctx.fragments.length === 0) return false;
  return collectCmsStrings(value).some((text) => containsExactAddress(text, ctx.fragments));
}

export class PublicSiteService {
  constructor(
    private readonly db: Database,
    private readonly media: CmsMediaService,
    private readonly options: PublicSiteServiceOptions,
  ) {}

  private async context(now: Date): Promise<ProjectionContext> {
    const fragments = exactAddressFragments(await getPickupExactAddress(this.db));
    let catalog: Promise<PublicCatalog> | null = null;
    return {
      now,
      fragments,
      catalog: () =>
        (catalog ??= buildPublicCatalog(this.db, now, {
          fragments,
          logger: this.options.logger,
        })),
    };
  }

  /** `GET /public/site/settings` – nur Veröffentlichtes; ohne Empfehlungsregeln. */
  async bootstrap(now = new Date()): Promise<PublicSiteBootstrap> {
    const ctx = await this.context(now);
    const settings = await this.publishedSettings(ctx);
    return {
      environment: this.options.environment,
      settings,
      pages: await this.publishedPages(ctx),
      reviews: { mode: this.options.reviewsMode },
      pickupArea: await publicPickupArea(this.db, ctx.fragments),
    };
  }

  /** `GET /public/site/page?path=…` – `null` ⇒ 404 (nicht veröffentlicht oder fail-closed). */
  async publishedPage(path: string, now = new Date()): Promise<PublicPage | null> {
    const published = await loadPublishedEntry(this.db, { path });
    if (published === null || published.entry.kind !== 'page') return null;
    const ctx = await this.context(now);
    return this.projectPage(published.entry, published.revision, PUBLIC_MEDIA_URL_BASE, ctx, {
      publishedAt: published.entry.publishedAt,
    });
  }

  /** `GET /public/cms/preview/page` – genau die gebundene Revision (über das Vorschau-Cookie). */
  async previewPage(
    session: CmsPreviewSession,
    now = new Date(),
  ): Promise<PublicPreviewPage | null> {
    const rows = await this.db
      .select({ entry: cmsEntries, revision: cmsRevisions })
      .from(cmsRevisions)
      .innerJoin(cmsEntries, eq(cmsEntries.id, cmsRevisions.entryId))
      .where(
        and(eq(cmsRevisions.id, session.revisionId), eq(cmsRevisions.entryId, session.entryId)),
      );
    const row = rows[0];
    if (row === undefined) return null;
    const ctx = await this.context(now);
    let page: PublicPage | null;
    let settings: PublicSiteSettings | null;
    if (row.entry.kind === 'page') {
      page = await this.projectPage(row.entry, row.revision, PREVIEW_MEDIA_URL_BASE, ctx, {
        publishedAt: null,
      });
      settings = await this.publishedSettings(ctx);
    } else {
      const parsed = cmsSiteSettingsSchema.safeParse(row.revision.content);
      settings = parsed.success
        ? await this.projectSettings(parsed.data, PREVIEW_MEDIA_URL_BASE, ctx, {
            entryId: row.entry.id,
          })
        : null;
      const home = await loadPublishedEntry(this.db, { path: CMS_FIXED_PAGE_PATHS.home });
      page =
        home === null || home.entry.kind !== 'page'
          ? null
          : await this.projectPage(home.entry, home.revision, PUBLIC_MEDIA_URL_BASE, ctx, {
              publishedAt: home.entry.publishedAt,
            });
    }
    return {
      preview: {
        revisionId: row.revision.id,
        revisionNumber: row.revision.revisionNumber,
        expiresAt: session.expiresAt.toISOString(),
        entryKind: row.entry.kind,
      },
      page,
      settings,
    };
  }

  // ── Projektion ──────────────────────────────────────────────────────────

  /**
   * Veröffentlichte Website-Einstellungen (fail-closed: ungültiger Inhalt ⇒ null, wie
   * `loadPublishedSiteSettings`), projiziert ohne Empfehlungsregeln.
   */
  private async publishedSettings(ctx: ProjectionContext): Promise<PublicSiteSettings | null> {
    const published = await loadPublishedEntry(this.db, { kind: 'site_settings' });
    if (published === null) return null;
    const parsed = cmsSiteSettingsSchema.safeParse(published.revision.content);
    if (!parsed.success) {
      this.options.logger.warn({ entryId: published.entry.id }, 'cms.public.content_invalid');
      return null;
    }
    return this.projectSettings(parsed.data, PUBLIC_MEDIA_URL_BASE, ctx, {
      entryId: published.entry.id,
    });
  }

  private async publishedPages(ctx: ProjectionContext): Promise<PublicSitePageSummary[]> {
    const rows = await this.db
      .select({ entry: cmsEntries, revision: cmsRevisions })
      .from(cmsEntries)
      .innerJoin(cmsRevisions, eq(cmsRevisions.id, cmsEntries.publishedRevisionId))
      .where(eq(cmsEntries.kind, 'page'))
      .orderBy(asc(cmsEntries.path));
    const out: PublicSitePageSummary[] = [];
    for (const row of rows) {
      if (row.entry.path === null || row.entry.pageType === null) continue;
      const parsed = cmsPageContentSchema.safeParse(row.revision.content);
      if (!parsed.success) {
        this.options.logger.warn({ entryId: row.entry.id }, 'cms.public.content_invalid');
        continue;
      }
      if (hasAddress(ctx, [parsed.data.title, row.revision.metaTitle])) {
        this.options.logger.warn({ entryId: row.entry.id }, 'cms.public.exact_address_suppressed');
        continue;
      }
      out.push({
        path: row.entry.path,
        pageType: row.entry.pageType,
        title: parsed.data.title,
        metaDescription: hasAddress(ctx, row.revision.metaDescription)
          ? null
          : row.revision.metaDescription,
      });
    }
    return out;
  }

  private async projectPage(
    entry: CmsEntryRow,
    revision: CmsRevisionRow,
    mediaBase: string,
    ctx: ProjectionContext,
    extra: { publishedAt: Date | null },
  ): Promise<PublicPage | null> {
    if (entry.path === null || entry.pageType === null) return null;
    const parsed = cmsPageContentSchema.safeParse(revision.content);
    if (!parsed.success) {
      this.options.logger.warn({ entryId: entry.id }, 'cms.public.content_invalid');
      return null;
    }
    const content: CmsPageContent = parsed.data;
    if (hasAddress(ctx, [content.title, revision.metaTitle])) {
      this.options.logger.warn({ entryId: entry.id }, 'cms.public.exact_address_suppressed');
      return null;
    }
    let suppressed = false;
    const kept = content.blocks.filter((block) => {
      if (block.type === 'reviews' && this.options.reviewsMode === 'disabled') return false;
      if (hasAddress(ctx, block)) {
        suppressed = true;
        return false;
      }
      return true;
    });
    const metaDescription = hasAddress(ctx, revision.metaDescription)
      ? null
      : revision.metaDescription;
    if (suppressed || (metaDescription === null && revision.metaDescription !== null)) {
      this.options.logger.warn({ entryId: entry.id }, 'cms.public.exact_address_suppressed');
    }
    const variants = await this.media.variantsFor(collectCmsMediaIds(kept));
    const blocks: PublicBlock[] = [];
    for (const block of kept) {
      const projected = await this.projectBlock(block, variants, mediaBase, ctx);
      if (projected !== null) blocks.push(projected);
    }
    return {
      path: entry.path,
      pageType: entry.pageType,
      revisionId: revision.id,
      publishedAt: extra.publishedAt?.toISOString() ?? null,
      title: content.title,
      metaTitle: revision.metaTitle,
      metaDescription,
      blocks,
    };
  }

  private async projectBlock(
    block: CmsBlock,
    variants: Map<string, CmsMediaVariantInfo[]>,
    mediaBase: string,
    ctx: ProjectionContext,
  ): Promise<PublicBlock | null> {
    switch (block.type) {
      case 'hero': {
        const { image, ...rest } = block;
        if (image === undefined) return rest;
        const projected = publicImage(image, variants, mediaBase);
        return projected === null ? rest : { ...rest, image: projected };
      }
      case 'image': {
        const projected = publicImage(block.image, variants, mediaBase);
        return projected === null ? null : { ...block, image: projected };
      }
      case 'gallery': {
        const images = block.images
          .map((image) => publicImage(image, variants, mediaBase))
          .filter((image): image is PublicImage => image !== null);
        return images.length === 0 ? null : { ...block, images };
      }
      case 'product_grid': {
        const products =
          block.productSlugs === undefined
            ? (await ctx.catalog()).machines
            : await buildPublicProducts(this.db, block.productSlugs, ctx.now, {
                fragments: ctx.fragments,
                logger: this.options.logger,
              });
        return { ...block, products };
      }
      case 'included_items': {
        const catalog = await ctx.catalog();
        return {
          ...block,
          included: catalog.included,
          syrups: catalog.syrups,
          accessories: catalog.accessories,
          canister: catalog.canister,
        };
      }
      default:
        return block;
    }
  }

  private async projectSettings(
    settings: CmsSiteSettings,
    mediaBase: string,
    ctx: ProjectionContext,
    log: { entryId: string },
  ): Promise<PublicSiteSettings | null> {
    const guard = <T>(value: T | undefined): T | null => {
      if (value === undefined) return null;
      if (hasAddress(ctx, value)) {
        this.options.logger.warn(log, 'cms.public.exact_address_suppressed');
        return null;
      }
      return value;
    };
    const businessName = guard(settings.businessName);
    if (businessName === null) return null;
    const logoRef = guard(settings.logo);
    let logo: PublicImage | null = null;
    if (logoRef !== null) {
      logo = publicImage(logoRef, await this.media.variantsFor([logoRef.mediaId]), mediaBase);
    }
    return {
      businessName,
      tagline: guard(settings.tagline),
      phone: guard(settings.contact.phone),
      email: guard(settings.contact.email),
      instagramUrl: guard(settings.instagramUrl),
      logo,
      footerNote: guard(settings.footerNote),
    };
  }
}

/** Bildreferenz ⇒ PublicImage (nur vorhandene Varianten; Maße = größte Variante). */
function publicImage(
  ref: CmsImageRef,
  variants: Map<string, CmsMediaVariantInfo[]>,
  mediaBase: string,
): PublicImage | null {
  const list = variants.get(ref.mediaId);
  if (list === undefined || list.length === 0) return null;
  const sorted = [...list].sort((a, b) => a.width - b.width);
  const largest = sorted[sorted.length - 1]!;
  return {
    mediaId: ref.mediaId,
    alt: ref.decorative ? '' : ref.alt,
    decorative: ref.decorative,
    width: largest.width,
    height: largest.height,
    variants: sorted.map((variant) => ({
      width: variant.width,
      url: `${mediaBase}/${ref.mediaId}/${variant.width}`,
    })),
  };
}
