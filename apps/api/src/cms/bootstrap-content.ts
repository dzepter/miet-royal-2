import type { CmsPageContent, CmsPageTypeName, CmsSiteSettings } from '@mietroyal/validation/cms';

/**
 * Phase 16 (Order §5/§10): redaktionelle Erst-Entwürfe für `pnpm cms:bootstrap`.
 * Reine Daten – der Bootstrap legt nur FEHLENDE Einträge mit diesem Inhalt als
 * ENTWURF an, überschreibt nie Redaktionsarbeit und veröffentlicht in production
 * nie. Nur belegte Fakten (MASTER_SPEC, Datenbank, bestehende Website laut
 * docs/WEBSITE_MIGRATION_NOTES.md); KEINE Preise (kommen aus dem Katalog).
 *
 * Wird vom Inhalts-Teil (Agent CONTENT) befüllt; der Schema-Test prüft jeden
 * Eintrag gegen packages/validation `cms.ts`.
 */
export type CmsBootstrapEntry =
  | {
      kind: 'site_settings';
      content: CmsSiteSettings;
      editorNote?: string;
    }
  | {
      kind: 'page';
      pageType: CmsPageTypeName;
      path: string;
      content: CmsPageContent;
      metaTitle?: string;
      metaDescription?: string;
      /** Interne Redaktionsnotiz, z. B. „vor Live rechtlich prüfen“. */
      editorNote?: string;
    };

export const CMS_BOOTSTRAP_ENTRIES: readonly CmsBootstrapEntry[] = [];
