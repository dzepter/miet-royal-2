import type { CmsPageTypeName } from '@mietroyal/validation/cms';
import type { LightMyRequestResponse } from 'fastify';
import sharp from 'sharp';
import { CmsService } from '../src/cms/cms-service.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createTestContext,
  login,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { truncateCmsTables } from './cms-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { createStaffWithPermissions } from './crm-helpers.ts';

/**
 * Phase 16 (CMS): gemeinsame Testwelt der CMS-Integrationstests – Kontext mit
 * öffentlicher Web-Basis-URL (Vorschau-Links), Admin, reine Redakteurin (`cms.edit`),
 * reiner Veröffentlicher (`cms.publish`), Mitarbeiter ohne CMS-Recht (`product.view`)
 * sowie Helfer für Einträge, Requests und synthetische Testbilder.
 */

export const CMS_TEST_WEB_BASE = 'https://web.cms.test';
export const CMS_TEST_EXACT_ADDRESS = 'Teststraße 1, 55129 Mainz-Hechtsheim (SYNTHETISCH)';

export interface CmsTestUser {
  id: string;
  cookie: string;
}

export interface CmsWorld {
  adminId: string;
  admin: CmsTestUser;
  editor: CmsTestUser;
  publisher: CmsTestUser;
  viewer: CmsTestUser;
  cms: CmsService;
}

export function createCmsTestContext(
  options: Parameters<typeof createTestContext>[0] = {},
): Promise<TestContext> {
  return createTestContext({
    ...options,
    env: { MAIL_PUBLIC_WEB_BASE_URL: CMS_TEST_WEB_BASE, ...(options.env ?? {}) },
  });
}

/** Leere CMS-/Auth-/Commerce-Tabellen (Seed-Produkte/-Preise bleiben) und frische Rollen. */
export async function resetCmsWorld(ctx: TestContext): Promise<CmsWorld> {
  await truncateCmsTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
  const admin = await bootstrapAdmin(ctx);
  const adminLogin = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  const editor = await createStaffWithPermissions(ctx, admin.id, {
    firstName: 'Erika',
    lastName: 'Redaktion',
    email: 'editor@cms.test',
    password: 'editor-passwort-123',
    permissionKeys: ['cms.edit'],
  });
  const publisher = await createStaffWithPermissions(ctx, admin.id, {
    firstName: 'Paul',
    lastName: 'Freigabe',
    email: 'publisher@cms.test',
    password: 'publisher-passwort-123',
    permissionKeys: ['cms.publish'],
  });
  const viewer = await createStaffWithPermissions(ctx, admin.id, {
    firstName: 'Vera',
    lastName: 'Produkte',
    email: 'viewer@cms.test',
    password: 'viewer-passwort-123',
    permissionKeys: ['product.view'],
  });
  return {
    adminId: admin.id,
    admin: { id: admin.id, cookie: adminLogin.cookie },
    editor: { id: editor.user.id, cookie: editor.cookie },
    publisher: { id: publisher.user.id, cookie: publisher.cookie },
    viewer: { id: viewer.user.id, cookie: viewer.cookie },
    cms: new CmsService(ctx.db, { publicWebBaseUrl: ctx.config.mail.publicWebBaseUrl }),
  };
}

export async function call(
  ctx: TestContext,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  options: { cookie?: string; payload?: unknown; headers?: Record<string, string> } = {},
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method,
    url,
    headers: {
      ...(options.cookie === undefined || options.cookie === '' ? {} : { cookie: options.cookie }),
      ...(options.headers ?? {}),
    },
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
  });
}

/** Eintrag (Entwurf, Revision 1) direkt über den Service anlegen; liefert die Detailansicht. */
export async function seedPage(
  world: CmsWorld,
  target: { pageType: CmsPageTypeName; path: string },
  input: { content: unknown; metaTitle?: string | null; metaDescription?: string | null },
) {
  const result = await world.cms.createEntryIfMissing(
    { kind: 'page', pageType: target.pageType, path: target.path },
    input,
  );
  return world.cms.getEntry(result.entryId);
}

export async function seedSiteSettings(world: CmsWorld, content: unknown) {
  const result = await world.cms.createEntryIfMissing({ kind: 'site_settings' }, { content });
  return world.cms.getEntry(result.entryId);
}

export const SETTINGS_CONTENT = {
  businessName: 'Miet-Royal',
  tagline: 'Slush für dein Event',
  contact: { email: 'info@cms.test' },
  footerNote: 'Synthetischer Testinhalt.',
  recommendationRules: [],
};

export function faqContent(answer = 'Du holst die Maschine in Mainz-Hechtsheim ab.') {
  return {
    title: 'Häufige Fragen',
    blocks: [{ type: 'faq', items: [{ question: 'Wie läuft die Abholung?', answer }] }],
  };
}

/** Synthetisches Testbild (keine echten Fotos). */
export async function testImage(
  format: 'jpeg' | 'png' | 'webp',
  width: number,
  height: number,
  options: { exifMarker?: string; orientation?: number } = {},
): Promise<Buffer> {
  let image = sharp({
    create: { width, height, channels: 3, background: { r: 191, g: 155, b: 48 } },
  });
  if (format === 'jpeg') {
    if (options.exifMarker !== undefined || options.orientation !== undefined) {
      image = image.withMetadata({
        ...(options.orientation === undefined ? {} : { orientation: options.orientation }),
        ...(options.exifMarker === undefined
          ? {}
          : {
              exif: {
                IFD0: {
                  Copyright: options.exifMarker,
                  Artist: options.exifMarker,
                  ImageDescription: `GPS-${options.exifMarker}`,
                },
              },
            }),
      });
    }
    return image.jpeg({ quality: 80 }).toBuffer();
  }
  if (format === 'png') return image.png().toBuffer();
  return image.webp({ quality: 80 }).toBuffer();
}

export async function uploadMedia(
  ctx: TestContext,
  cookie: string,
  bytes: Buffer,
  mimeType: string,
  label = 'Testbild',
): Promise<LightMyRequestResponse> {
  return call(ctx, 'POST', '/staff/cms/media', {
    cookie,
    payload: { label, mimeType, dataBase64: bytes.toString('base64') },
  });
}
