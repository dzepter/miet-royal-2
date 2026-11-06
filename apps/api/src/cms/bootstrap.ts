import { cmsEntries, staffSecurityEvents, type Database } from '@mietroyal/database';
import { RequestValidationError } from '@mietroyal/validation';
import { isValidCmsPathForPageType } from '@mietroyal/validation/cms';
import { and, asc, isNull, sql } from 'drizzle-orm';
import type { CmsBootstrapEntry } from './bootstrap-content.ts';
import { CmsService } from './cms-service.ts';
import { CmsError } from './errors.ts';

/**
 * Phase 16 (Order §10, Design §2.1/§11.2.4): `pnpm cms:bootstrap`.
 *
 * - Legt FEHLENDE Standard-Einträge aus `CMS_BOOTSTRAP_ENTRIES` als ENTWURF an (Revision 1,
 *   created_by NULL). Idempotent: ein vorhandener Eintrag bleibt unberührt – auch wenn er
 *   leer ist oder anders aussieht; Redaktionsarbeit wird nie überschrieben.
 * - `--publish-demo` NUR in development/demo/test: veröffentlicht die Entwürfe aller
 *   Einträge, die noch NIE veröffentlicht waren – über `CmsService.publish` (gleiche
 *   Prüfungen, Audit `cms.published` mit actor NULL und Quelle `bootstrap`).
 *   production/staging ⇒ Abbruch VOR jeder Änderung.
 * - Läuft nie bei API-Start, Migration oder Deployment (nur als bewusster CLI-Aufruf).
 * - Ergebnis/Log enthalten nur Pfade, IDs und Fehlercodes – nie Inhalte.
 */

export const CMS_PUBLISH_DEMO_ENVIRONMENTS: readonly string[] = ['development', 'demo', 'test'];

export class CmsBootstrapRefusedError extends Error {
  constructor(appEnv: string) {
    super(
      `cms:bootstrap --publish-demo ist in APP_ENV=${appEnv} verboten – nur development, demo oder test. Es wurde nichts geändert.`,
    );
    this.name = 'CmsBootstrapRefusedError';
  }
}

export function assertPublishDemoAllowed(appEnv: string): void {
  if (!CMS_PUBLISH_DEMO_ENVIRONMENTS.includes(appEnv)) {
    throw new CmsBootstrapRefusedError(appEnv);
  }
}

export interface CmsBootstrapIssue {
  /** Pfad bzw. `site_settings`. */
  target: string;
  /** Fehlercode (z. B. `VALIDATION_ERROR`, `CMS_PUBLISH_INCOMPLETE`) – nie Inhalte. */
  code: string;
}

export interface CmsBootstrapResult {
  created: string[];
  skipped: string[];
  invalid: CmsBootstrapIssue[];
  published: string[];
  publishFailed: CmsBootstrapIssue[];
}

function targetOf(entry: CmsBootstrapEntry): string {
  return entry.kind === 'site_settings' ? 'site_settings' : entry.path;
}

function codeOf(error: unknown): string {
  if (error instanceof CmsError) return error.code;
  if (error instanceof RequestValidationError) return 'VALIDATION_ERROR';
  return error instanceof Error ? error.name : 'UNKNOWN';
}

export async function runCmsBootstrap(
  db: Database,
  options: {
    entries: readonly CmsBootstrapEntry[];
    appEnv: string;
    publishDemo?: boolean;
    publicWebBaseUrl?: string | null;
    now?: Date;
  },
): Promise<CmsBootstrapResult> {
  // Prüfung VOR jeder Änderung: production/staging veröffentlichen nie automatisch.
  if (options.publishDemo === true) assertPublishDemoAllowed(options.appEnv);
  const now = options.now ?? new Date();
  const service = new CmsService(db, { publicWebBaseUrl: options.publicWebBaseUrl ?? null });
  const result: CmsBootstrapResult = {
    created: [],
    skipped: [],
    invalid: [],
    published: [],
    publishFailed: [],
  };

  for (const entry of options.entries) {
    const target = targetOf(entry);
    if (entry.kind === 'page' && !isValidCmsPathForPageType(entry.pageType, entry.path)) {
      result.invalid.push({ target, code: 'CMS_PATH_INVALID' });
      continue;
    }
    try {
      const outcome = await service.createEntryIfMissing(
        entry.kind === 'site_settings'
          ? { kind: 'site_settings' }
          : { kind: 'page', pageType: entry.pageType, path: entry.path },
        {
          content: entry.content,
          metaTitle: entry.kind === 'page' ? entry.metaTitle : undefined,
          metaDescription: entry.kind === 'page' ? entry.metaDescription : undefined,
          editorNote: entry.editorNote,
        },
        now,
      );
      (outcome.created ? result.created : result.skipped).push(target);
    } catch (error) {
      result.invalid.push({ target, code: codeOf(error) });
    }
  }

  if (options.publishDemo === true) {
    // „Noch nie veröffentlicht“: kein veröffentlichter Stand UND kein früheres
    // cms.published-Audit für diesen Eintrag (bewusst Zurückgezogenes bleibt zurückgezogen).
    const candidates = await db
      .select({ id: cmsEntries.id, path: cmsEntries.path, draft: cmsEntries.draftRevisionId })
      .from(cmsEntries)
      .where(
        and(
          isNull(cmsEntries.publishedRevisionId),
          sql`NOT EXISTS (SELECT 1 FROM ${staffSecurityEvents} WHERE ${staffSecurityEvents.type} = 'cms.published' AND ${staffSecurityEvents.details}->>'entryId' = ${cmsEntries.id}::text)`,
        ),
      )
      .orderBy(asc(cmsEntries.kind), asc(cmsEntries.path));
    for (const candidate of candidates) {
      const target = candidate.path ?? 'site_settings';
      if (candidate.draft === null) continue;
      try {
        await service.publish(
          null,
          candidate.id,
          { revisionId: candidate.draft },
          { source: 'bootstrap', now },
        );
        result.published.push(target);
      } catch (error) {
        result.publishFailed.push({ target, code: codeOf(error) });
      }
    }
  }
  return result;
}
