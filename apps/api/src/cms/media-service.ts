import { createHash, randomUUID } from 'node:crypto';
import {
  cmsEntries,
  cmsMedia,
  cmsMediaVariants,
  cmsRevisionMedia,
  type CmsMediaRow,
  type Database,
} from '@mietroyal/database';
import type { StorageProvider } from '@mietroyal/integrations';
import { RequestValidationError } from '@mietroyal/validation';
import { hasForbiddenTextCharacters, hasTagLikeText } from '@mietroyal/validation/cms';
import { and, asc, desc, eq, exists, inArray, isNotNull, or } from 'drizzle-orm';
import sharp from 'sharp';
import { detectImageMime, normalizeDeclaredMime } from '../communication/inbound/content.ts';
import { CMS_MESSAGES, CmsError } from './errors.ts';

/**
 * Phase 16 (CMS-Medien, Order §8, Design §2.3/§11.2.11).
 *
 * Upload-Reihenfolge: Größe (roh ≤ 6 MiB) ⇒ Magic Bytes passend zum deklarierten Typ
 * (nur JPEG/PNG/WebP; SVG/HTML/GIF/HEIC/getarnte Dateien ⇒ 400) ⇒ erst DANN Decode mit
 * sharp (`failOn: 'error'`, Pixelgrenze) ⇒ Format aus dem Decode als zweite Stufe.
 * Gespeichert werden ausschließlich neu kodierte WebP-Varianten (480/960/1600, nur ≤
 * Originalbreite, mindestens eine); EXIF-Ausrichtung wird angewendet, alle Metadaten
 * (EXIF/XMP/ICC/GPS) fallen weg (sharp ohne `withMetadata`). Kein Original im Storage.
 *
 * Storage-Keys `cms-media/<mediaId>/<breite>.webp` sind intern – nie in DTOs/Logs.
 * Öffentlich ausgeliefert wird nur über die opake Medien-ID, und nur Medien, die in einer
 * aktuell VERÖFFENTLICHTEN Revision stehen (Entwurfsmedien sind nicht erratbar).
 * Kein Löschen in Phase 16 (die Revisionshistorie referenziert Medien).
 */

export const CMS_MEDIA_MAX_BYTES = 6 * 1024 * 1024;
export const CMS_MEDIA_MAX_INPUT_PIXELS = 40_000_000;
export const CMS_MEDIA_VARIANT_WIDTHS = [480, 960, 1600] as const;
export const CMS_MEDIA_WEBP_QUALITY = 82;
export const CMS_MEDIA_LABEL_MAX = 120;
export const CMS_MEDIA_ALT_MAX = 200;

const ALLOWED_SOURCE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
type AllowedSourceType = (typeof ALLOWED_SOURCE_TYPES)[number];
const SHARP_FORMAT: Record<AllowedSourceType, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface StaffCmsMedia {
  id: string;
  label: string;
  width: number;
  height: number;
  defaultAlt: string | null;
  createdAt: string;
  usedInPublished: boolean;
  variantWidths: number[];
}

export interface CmsMediaVariantInfo {
  width: number;
  height: number;
}

/** Zugriffsart für die Auslieferung einer Variante. */
export type CmsMediaAccess =
  | { kind: 'staff' }
  | { kind: 'published' }
  /** Vorschau: Medium der gebundenen Revision ODER veröffentlicht. */
  | { kind: 'preview'; revisionId: string };

/** Variantenbreiten für eine (ausgerichtete) Originalbreite: nur ≤ Original, mindestens eine. */
export function variantWidthsFor(originalWidth: number): number[] {
  const widths = CMS_MEDIA_VARIANT_WIDTHS.filter((width) => width <= originalWidth);
  return widths.length > 0 ? [...widths] : [originalWidth];
}

export function cmsMediaStorageKey(mediaId: string, width: number): string {
  return `cms-media/${mediaId}/${width}.webp`;
}

/** Review cms-3: Steuer-/Formatzeichen (Cc/Cf/U+2028/U+2029, auch kein \n) und HTML-artige Tags. */
function hasForbiddenText(value: string): boolean {
  return hasForbiddenTextCharacters(value, { allowNewline: false }) || hasTagLikeText(value);
}

function parseLabel(value: string): string {
  const label = value.trim();
  if (label.length < 1 || label.length > CMS_MEDIA_LABEL_MAX || hasForbiddenText(label)) {
    throw new RequestValidationError([
      { path: 'label', message: `Bitte eine Bezeichnung (1–${CMS_MEDIA_LABEL_MAX} Zeichen).` },
    ]);
  }
  return label;
}

function parseDefaultAlt(value: string | null): string | null {
  if (value === null) return null;
  const alt = value.trim();
  if (alt === '') return null;
  if (alt.length > CMS_MEDIA_ALT_MAX || hasForbiddenText(alt)) {
    throw new RequestValidationError([
      { path: 'defaultAlt', message: `Höchstens ${CMS_MEDIA_ALT_MAX} Zeichen, reiner Text.` },
    ]);
  }
  return alt;
}

function rejected(message: string = CMS_MESSAGES.MEDIA_REJECTED): CmsError {
  return new CmsError('CMS_MEDIA_REJECTED', message);
}

export class CmsMediaService {
  constructor(
    private readonly db: Database,
    private readonly storage: StorageProvider,
  ) {}

  /** Upload eines Bildes (Design §2.3); liefert die Staff-Projektion ohne Storage-Key. */
  async upload(
    actorId: string,
    input: { label: string; mimeType: string; bytes: Uint8Array },
    now = new Date(),
  ): Promise<StaffCmsMedia> {
    const label = parseLabel(input.label);
    // 1) Größe
    if (input.bytes.length === 0 || input.bytes.length > CMS_MEDIA_MAX_BYTES) {
      throw rejected(CMS_MESSAGES.MEDIA_TOO_LARGE);
    }
    // 2) Magic Bytes passend zum deklarierten Typ (nur JPEG/PNG/WebP)
    const declared = normalizeDeclaredMime(input.mimeType);
    if (!(ALLOWED_SOURCE_TYPES as readonly string[]).includes(declared)) throw rejected();
    const detected = detectImageMime(input.bytes);
    if (detected === null || detected !== declared) throw rejected();
    const sourceType = detected as AllowedSourceType;
    // 3) Decode (erst jetzt) – Format aus dem Decode muss passen
    const sharpOptions = {
      failOn: 'error' as const,
      limitInputPixels: CMS_MEDIA_MAX_INPUT_PIXELS,
    };
    let orientedWidth: number;
    let orientedHeight: number;
    try {
      const metadata = await sharp(input.bytes, sharpOptions).metadata();
      if (metadata.format !== SHARP_FORMAT[sourceType]) throw rejected();
      orientedWidth = metadata.autoOrient.width;
      orientedHeight = metadata.autoOrient.height;
    } catch (error) {
      if (error instanceof CmsError) throw error;
      throw rejected();
    }
    if (!(orientedWidth > 0) || !(orientedHeight > 0)) throw rejected();
    // 4) Re-Encoding: WebP-Varianten ohne Metadaten
    const mediaId = randomUUID();
    const variants: Array<{ width: number; height: number; bytes: Buffer; key: string }> = [];
    try {
      for (const width of variantWidthsFor(orientedWidth)) {
        const { data, info } = await sharp(input.bytes, sharpOptions)
          .autoOrient()
          .resize({ width, withoutEnlargement: true })
          .webp({ quality: CMS_MEDIA_WEBP_QUALITY })
          .toBuffer({ resolveWithObject: true });
        variants.push({
          width,
          height: info.height,
          bytes: data,
          key: cmsMediaStorageKey(mediaId, width),
        });
      }
    } catch {
      throw rejected();
    }
    const sourceSha256 = createHash('sha256').update(input.bytes).digest('hex');
    const stored: string[] = [];
    try {
      for (const variant of variants) {
        await this.storage.put(variant.key, new Uint8Array(variant.bytes), {
          contentType: 'image/webp',
        });
        stored.push(variant.key);
      }
      await this.db.transaction(async (tx) => {
        await tx.insert(cmsMedia).values({
          id: mediaId,
          label,
          sourceMimeType: sourceType,
          width: orientedWidth,
          height: orientedHeight,
          sourceSha256,
          uploadedBy: actorId,
          createdAt: now,
        });
        await tx.insert(cmsMediaVariants).values(
          variants.map((variant) => ({
            mediaId,
            width: variant.width,
            height: variant.height,
            mimeType: 'image/webp',
            byteSize: variant.bytes.length,
            storageKey: variant.key,
            createdAt: now,
          })),
        );
      });
    } catch (error) {
      // Nur die eben geschriebenen, eigenen Keys aufräumen – nie bucket-weit.
      for (const key of stored) await this.storage.delete(key).catch(() => undefined);
      throw error;
    }
    return this.get(mediaId);
  }

  async list(): Promise<StaffCmsMedia[]> {
    const rows = await this.db.select().from(cmsMedia).orderBy(desc(cmsMedia.createdAt));
    return this.project(rows);
  }

  async get(mediaId: string): Promise<StaffCmsMedia> {
    const rows = await this.db.select().from(cmsMedia).where(eq(cmsMedia.id, mediaId));
    if (rows.length === 0) throw new CmsError('NOT_FOUND', CMS_MESSAGES.MEDIA_NOT_FOUND);
    return (await this.project(rows))[0]!;
  }

  async update(
    mediaId: string,
    input: { label?: string | undefined; defaultAlt?: string | null | undefined },
  ): Promise<StaffCmsMedia> {
    const set: { label?: string; defaultAlt?: string | null } = {};
    if (input.label !== undefined) set.label = parseLabel(input.label);
    if (input.defaultAlt !== undefined) set.defaultAlt = parseDefaultAlt(input.defaultAlt);
    if (Object.keys(set).length > 0) {
      const updated = await this.db
        .update(cmsMedia)
        .set(set)
        .where(eq(cmsMedia.id, mediaId))
        .returning({ id: cmsMedia.id });
      if (updated.length === 0) throw new CmsError('NOT_FOUND', CMS_MESSAGES.MEDIA_NOT_FOUND);
    }
    return this.get(mediaId);
  }

  /** Vorhandene Varianten je Medium (für Bild-DTOs mit Varianten-URLs). */
  async variantsFor(mediaIds: readonly string[]): Promise<Map<string, CmsMediaVariantInfo[]>> {
    const out = new Map<string, CmsMediaVariantInfo[]>();
    if (mediaIds.length === 0) return out;
    const rows = await this.db
      .select({
        mediaId: cmsMediaVariants.mediaId,
        width: cmsMediaVariants.width,
        height: cmsMediaVariants.height,
      })
      .from(cmsMediaVariants)
      .where(inArray(cmsMediaVariants.mediaId, [...mediaIds]))
      .orderBy(asc(cmsMediaVariants.width));
    for (const row of rows) {
      const list = out.get(row.mediaId) ?? [];
      list.push({ width: row.width, height: row.height });
      out.set(row.mediaId, list);
    }
    return out;
  }

  /**
   * Bytes einer Variante – nur exakt vorhandene Breiten; `null` = nicht verfügbar
   * (unbekannt, Entwurfsmedium ohne Berechtigung, Breite fehlt). Neutral für alle Fälle.
   */
  async variantBytes(
    mediaId: string,
    width: number,
    access: CmsMediaAccess,
  ): Promise<Uint8Array | null> {
    const publishedUse = exists(
      this.db
        .select({ one: cmsRevisionMedia.mediaId })
        .from(cmsRevisionMedia)
        .innerJoin(cmsEntries, eq(cmsEntries.publishedRevisionId, cmsRevisionMedia.revisionId))
        .where(
          and(eq(cmsRevisionMedia.mediaId, mediaId), isNotNull(cmsEntries.publishedRevisionId)),
        ),
    );
    const visibility =
      access.kind === 'staff'
        ? undefined
        : access.kind === 'published'
          ? publishedUse
          : or(
              publishedUse,
              exists(
                this.db
                  .select({ one: cmsRevisionMedia.mediaId })
                  .from(cmsRevisionMedia)
                  .where(
                    and(
                      eq(cmsRevisionMedia.mediaId, mediaId),
                      eq(cmsRevisionMedia.revisionId, access.revisionId),
                    ),
                  ),
              ),
            );
    const rows = await this.db
      .select({ storageKey: cmsMediaVariants.storageKey })
      .from(cmsMediaVariants)
      .where(
        and(
          eq(cmsMediaVariants.mediaId, mediaId),
          eq(cmsMediaVariants.width, width),
          ...(visibility === undefined ? [] : [visibility]),
        ),
      );
    const row = rows[0];
    if (row === undefined) return null;
    try {
      return await this.storage.get(row.storageKey);
    } catch {
      return null;
    }
  }

  private async project(rows: CmsMediaRow[]): Promise<StaffCmsMedia[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const variants = await this.variantsFor(ids);
    const used = await this.db
      .selectDistinct({ mediaId: cmsRevisionMedia.mediaId })
      .from(cmsRevisionMedia)
      .innerJoin(cmsEntries, eq(cmsEntries.publishedRevisionId, cmsRevisionMedia.revisionId))
      .where(inArray(cmsRevisionMedia.mediaId, ids));
    const usedIds = new Set(used.map((row) => row.mediaId));
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      width: row.width,
      height: row.height,
      defaultAlt: row.defaultAlt,
      createdAt: row.createdAt.toISOString(),
      usedInPublished: usedIds.has(row.id),
      variantWidths: (variants.get(row.id) ?? []).map((variant) => variant.width),
    }));
  }
}
