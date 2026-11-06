import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cmsEntries, cmsRevisions, staffSecurityEvents } from '@mietroyal/database';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CmsBootstrapEntry } from '../src/cms/bootstrap-content.ts';
import { CMS_BOOTSTRAP_ENTRIES } from '../src/cms/bootstrap-content.ts';
import { CmsBootstrapRefusedError, runCmsBootstrap } from '../src/cms/bootstrap.ts';
import { destroyTestContext, TEST_DATABASE_URL, type TestContext } from './auth-helpers.ts';
import { createCmsTestContext, faqContent, resetCmsWorld, type CmsWorld } from './cms-world.ts';

/**
 * Phase 16 (Order §10, Design §2.1/§11.2.4/§11.3): `pnpm cms:bootstrap` – legt fehlende
 * Standard-Einträge als Entwurf an, idempotent, überschreibt NIE Redaktionsarbeit;
 * `--publish-demo` nur development/demo/test über CmsService.publish (Audit actor NULL,
 * Quelle `bootstrap`), production/staging ⇒ Abbruch vor jeder Änderung. Funktioniert mit
 * leerer und gefüllter Standardliste. Namen laufen als „B<n>.“.
 */

const API_DIR = join(import.meta.dirname, '..');

let ctx: TestContext;
let world: CmsWorld;

beforeAll(async () => {
  ctx = await createCmsTestContext();
});

afterAll(async () => {
  await destroyTestContext(ctx);
});

beforeEach(async () => {
  world = await resetCmsWorld(ctx);
});

const ENTRIES: readonly CmsBootstrapEntry[] = [
  {
    kind: 'site_settings',
    content: { businessName: 'Miet-Royal', contact: {}, recommendationRules: [] },
    editorNote: 'Kontaktwerte vor Veröffentlichung bestätigen.',
  },
  {
    kind: 'page',
    pageType: 'faq',
    path: '/faq',
    content: faqContent() as never,
    metaTitle: 'FAQ',
  },
  {
    kind: 'page',
    pageType: 'region',
    path: '/slushmaschine-mieten/mainz',
    content: { title: 'Slush in Mainz', blocks: [{ type: 'text', body: 'Eigener Text.' }] },
    metaTitle: 'Slush in Mainz',
    editorNote: 'Vor Veröffentlichung lokal prüfen.',
  },
  {
    kind: 'page',
    pageType: 'about',
    path: '/ueber-uns',
    content: { title: 'Über uns', blocks: [] },
    // ohne Meta-Titel ⇒ beim Demo-Veröffentlichen abgelehnt
  },
];

async function entryRows() {
  return ctx.db.select().from(cmsEntries).orderBy(asc(cmsEntries.kind), asc(cmsEntries.path));
}

describe('Phase 16 – cms:bootstrap', () => {
  it('B1. Legt fehlende Einträge als Entwurf an (Revision 1, ohne Akteur), veröffentlicht nichts, idempotent', async () => {
    const first = await runCmsBootstrap(ctx.db, { entries: ENTRIES, appEnv: 'production' });
    expect(first.created).toEqual([
      'site_settings',
      '/faq',
      '/slushmaschine-mieten/mainz',
      '/ueber-uns',
    ]);
    expect(first.invalid).toEqual([]);
    expect(first.published).toEqual([]);
    const rows = await entryRows();
    expect(rows).toHaveLength(4);
    expect(
      rows.every((row) => row.publishedRevisionId === null && row.draftRevisionId !== null),
    ).toBe(true);
    const revisions = await ctx.db.select().from(cmsRevisions);
    expect(revisions.every((row) => row.revisionNumber === 1 && row.createdBy === null)).toBe(true);
    const mainz = revisions.find((row) => row.editorNote === 'Vor Veröffentlichung lokal prüfen.');
    expect(mainz?.metaTitle).toBe('Slush in Mainz');

    const second = await runCmsBootstrap(ctx.db, { entries: ENTRIES, appEnv: 'production' });
    expect(second.created).toEqual([]);
    expect(second.skipped).toHaveLength(4);
    expect(await ctx.db.select().from(cmsRevisions)).toHaveLength(4);
    expect(await publishedEvents()).toEqual([]);
  });

  it('B2. Überschreibt NIE vorhandene Redaktionsarbeit (auch leere/andere Einträge bleiben unberührt)', async () => {
    const faq = await world.cms.createEntryIfMissing(
      { kind: 'page', pageType: 'faq', path: '/faq' },
      { content: { title: 'Eigene FAQ', blocks: [] } },
    );
    const detail = await world.cms.getEntry(faq.entryId);
    const edited = await world.cms.saveDraft(world.editor.id, faq.entryId, {
      baseRevisionId: detail.draft.revisionId,
      content: faqContent('Redaktionell überarbeitet.'),
      metaTitle: 'FAQ',
    });
    const result = await runCmsBootstrap(ctx.db, { entries: ENTRIES, appEnv: 'development' });
    expect(result.skipped).toEqual(['/faq']);
    const after = await world.cms.getEntry(faq.entryId);
    expect(after.draft.revisionId).toBe(edited.draft.revisionId);
    expect(after.history).toHaveLength(2);
    expect(JSON.stringify(after.draft.content)).toContain('Redaktionell überarbeitet.');
  });

  it('B3. Ungültige Standard-Einträge werden gemeldet und nicht angelegt', async () => {
    const result = await runCmsBootstrap(ctx.db, {
      appEnv: 'development',
      entries: [
        { kind: 'page', pageType: 'faq', path: '/ablauf', content: faqContent() as never },
        {
          kind: 'page',
          pageType: 'process',
          path: '/ablauf',
          content: { title: 'Ablauf', blocks: [{ type: 'text', body: 'Nur 60 € pro Tag.' }] },
        },
        {
          kind: 'page',
          pageType: 'contact',
          path: '/kontakt',
          content: { title: 'Kontakt', blocks: [{ type: 'text', body: '<b>fett</b>' }] } as never,
        },
      ],
    });
    expect(result.invalid).toEqual([
      { target: '/ablauf', code: 'CMS_PATH_INVALID' },
      { target: '/ablauf', code: 'CMS_PRICE_TEXT_FORBIDDEN' },
      { target: '/kontakt', code: 'VALIDATION_ERROR' },
    ]);
    expect(await entryRows()).toEqual([]);
  });

  it('B4. --publish-demo in production/staging verweigert – VOR jeder Änderung', async () => {
    for (const appEnv of ['production', 'staging']) {
      await expect(
        runCmsBootstrap(ctx.db, { entries: ENTRIES, appEnv, publishDemo: true }),
      ).rejects.toBeInstanceOf(CmsBootstrapRefusedError);
    }
    expect(await entryRows()).toEqual([]);
  });

  it('B5. --publish-demo (development/demo): veröffentlicht nie Veröffentlichtes über CmsService.publish mit Audit „bootstrap“', async () => {
    // Region wurde früher bewusst zurückgezogen ⇒ bleibt zurückgezogen
    await runCmsBootstrap(ctx.db, { entries: ENTRIES, appEnv: 'demo' });
    const region = (await entryRows()).find((row) => row.path === '/slushmaschine-mieten/mainz')!;
    await world.cms.publish(world.publisher.id, region.id, { revisionId: region.draftRevisionId! });
    await world.cms.unpublish(world.publisher.id, region.id);

    const result = await runCmsBootstrap(ctx.db, {
      entries: ENTRIES,
      appEnv: 'demo',
      publishDemo: true,
    });
    expect(result.published.sort()).toEqual(['/faq', 'site_settings']);
    expect(result.publishFailed).toEqual([
      { target: '/ueber-uns', code: 'CMS_PUBLISH_INCOMPLETE' },
    ]);
    const rows = await entryRows();
    expect(
      rows.find((row) => row.path === '/slushmaschine-mieten/mainz')?.publishedRevisionId,
    ).toBeNull();
    expect(rows.find((row) => row.path === '/faq')?.publishedBy).toBeNull();
    const events = await ctx.db
      .select()
      .from(staffSecurityEvents)
      .where(eq(staffSecurityEvents.type, 'cms.published'));
    const bootstrapEvents = events.filter(
      (event) => (event.details as { source?: string }).source === 'bootstrap',
    );
    expect(bootstrapEvents).toHaveLength(2);
    expect(bootstrapEvents.every((event) => event.actorUserId === null)).toBe(true);
    // Öffentlich sichtbar, zweiter Lauf ändert nichts mehr
    const again = await runCmsBootstrap(ctx.db, {
      entries: ENTRIES,
      appEnv: 'development',
      publishDemo: true,
    });
    expect(again.published).toEqual([]);
  });

  it('B6. Mit der echten Standardliste: alle Einträge gültig, zweiter Lauf legt nichts an', async () => {
    const first = await runCmsBootstrap(ctx.db, {
      entries: CMS_BOOTSTRAP_ENTRIES,
      appEnv: 'development',
    });
    expect(first.created.length + first.invalid.length).toBe(CMS_BOOTSTRAP_ENTRIES.length);
    // Phase 16 (Integration): Die echte Liste ist befüllt und muss vollständig gültig sein.
    expect(CMS_BOOTSTRAP_ENTRIES.length).toBeGreaterThan(0);
    expect(first.invalid).toEqual([]);
    const second = await runCmsBootstrap(ctx.db, {
      entries: CMS_BOOTSTRAP_ENTRIES,
      appEnv: 'development',
    });
    expect(second.created).toEqual([]);
    expect(second.skipped.length).toBe(first.created.length);
    expect((await entryRows()).every((row) => row.publishedRevisionId === null)).toBe(true);
  });

  it('B7. Skript: --publish-demo mit APP_ENV=production bricht mit Exit 2 ab, ohne Datenbankzugriff', () => {
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/cms-bootstrap.ts', '--publish-demo'],
      {
        cwd: API_DIR,
        env: { ...process.env, APP_ENV: 'production', DATABASE_URL: TEST_DATABASE_URL },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('verboten');
    const unknown = spawnSync('pnpm', ['exec', 'tsx', 'scripts/cms-bootstrap.ts', '--force'], {
      cwd: API_DIR,
      env: { ...process.env, APP_ENV: 'development', DATABASE_URL: TEST_DATABASE_URL },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(unknown.status).toBe(2);
  });

  it('B8. Skript ohne Flag (development): legt nur Entwürfe an und gibt keine Inhalte aus', async () => {
    const result = spawnSync('pnpm', ['exec', 'tsx', 'scripts/cms-bootstrap.ts'], {
      cwd: API_DIR,
      env: {
        ...process.env,
        APP_ENV: 'development',
        DATABASE_URL: TEST_DATABASE_URL,
        LOG_LEVEL: 'error',
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.stdout).toContain('CMS-Bootstrap fertig');
    expect([0, 1]).toContain(result.status); // 1 nur bei ungültigen Standard-Einträgen
    expect((await entryRows()).every((row) => row.publishedRevisionId === null)).toBe(true);
    for (const entry of CMS_BOOTSTRAP_ENTRIES) {
      if (entry.editorNote !== undefined) expect(result.stdout).not.toContain(entry.editorNote);
    }
  });
});

async function publishedEvents() {
  return ctx.db
    .select()
    .from(staffSecurityEvents)
    .where(eq(staffSecurityEvents.type, 'cms.published'));
}
