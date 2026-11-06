import { cmsEntries, cmsRevisions, products, staffSecurityEvents } from '@mietroyal/database';
import { asc, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setStringSetting, PICKUP_EXACT_ADDRESS_KEY } from '../src/crm/settings-service.ts';
import type { StaffCmsEntryDetail } from '../src/cms/cms-service.ts';
import { destroyTestContext, type TestContext } from './auth-helpers.ts';
import { publishCmsForTests } from './cms-helpers.ts';
import {
  call,
  CMS_TEST_EXACT_ADDRESS,
  createCmsTestContext,
  faqContent,
  resetCmsWorld,
  seedPage,
  seedSiteSettings,
  SETTINGS_CONTENT,
  type CmsWorld,
} from './cms-world.ts';

/**
 * Phase 16 (CMS, Order §6/§7/§22/§25, Design §2.2/§11.2/§11.3): Redaktion – Rechte
 * cms.edit vs. cms.publish, immutable Revisionen, optimistische Entwurfsprüfung, Entwurf nie
 * öffentlich, atomares Veröffentlichen (stale/parallel), Wiederherstellen, Zurückziehen,
 * Regionsseiten, Preis-/Adress-Schutz, Empfehlungsregeln, Audit ohne Texte.
 * Namen laufen als „C<n>.“. Test-DB: TEST_DATABASE_URL (Phase 16: mietroyal_test3).
 */

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

async function saveDraft(
  cookie: string,
  detail: StaffCmsEntryDetail,
  content: unknown,
  extra: Record<string, unknown> = {},
) {
  return call(ctx, 'PUT', `/staff/cms/entries/${detail.id}/draft`, {
    cookie,
    payload: { baseRevisionId: detail.draft.revisionId, content, ...extra },
  });
}

async function publish(cookie: string, entryId: string, revisionId: string) {
  return call(ctx, 'POST', `/staff/cms/entries/${entryId}/publish`, {
    cookie,
    payload: { revisionId },
  });
}

async function cmsEvents() {
  return ctx.db
    .select()
    .from(staffSecurityEvents)
    .where(like(staffSecurityEvents.type, 'cms.%'))
    .orderBy(asc(staffSecurityEvents.createdAt));
}

describe('Phase 16 – CMS Redaktion', () => {
  it('C1. Rechte: Lesen edit|publish, Entwurf nur cms.edit, Veröffentlichen nur cms.publish', async () => {
    const faq = await seedPage(
      world,
      { pageType: 'faq', path: '/faq' },
      { content: faqContent(), metaTitle: 'FAQ' },
    );
    // Ohne Anmeldung / ohne CMS-Recht
    expect((await call(ctx, 'GET', '/staff/cms/entries')).statusCode).toBe(401);
    expect(
      (await call(ctx, 'GET', '/staff/cms/entries', { cookie: world.viewer.cookie })).statusCode,
    ).toBe(403);
    expect(
      (await call(ctx, 'GET', `/staff/cms/entries/${faq.id}`, { cookie: world.viewer.cookie }))
        .statusCode,
    ).toBe(403);
    // Nur Veröffentlicher: alles lesen, Vorschau, veröffentlichen – aber nicht bearbeiten
    for (const url of [
      '/staff/cms/entries',
      `/staff/cms/entries/${faq.id}`,
      `/staff/cms/revisions/${faq.draft.revisionId}`,
      '/staff/cms/media',
    ]) {
      expect((await call(ctx, 'GET', url, { cookie: world.publisher.cookie })).statusCode).toBe(
        200,
      );
    }
    expect((await saveDraft(world.publisher.cookie, faq, faqContent('Neu.'))).statusCode).toBe(403);
    expect(
      (
        await call(ctx, 'POST', `/staff/cms/entries/${faq.id}/restore`, {
          cookie: world.publisher.cookie,
          payload: { revisionId: faq.draft.revisionId, baseRevisionId: faq.draft.revisionId },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call(ctx, 'POST', '/staff/cms/entries', {
          cookie: world.publisher.cookie,
          payload: { regionSlug: 'ingelheim', title: 'Slush in Ingelheim' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call(ctx, 'POST', `/staff/cms/entries/${faq.id}/preview`, {
          cookie: world.publisher.cookie,
          payload: {},
        })
      ).statusCode,
    ).toBe(201);
    // Nur Redakteurin: bearbeiten ja, veröffentlichen/zurückziehen nein
    const saved = await saveDraft(world.editor.cookie, faq, faqContent('Neu.'), {
      metaTitle: 'FAQ',
    });
    expect(saved.statusCode).toBe(200);
    const draftId = (saved.json() as StaffCmsEntryDetail).draft.revisionId;
    expect((await publish(world.editor.cookie, faq.id, draftId)).statusCode).toBe(403);
    expect(
      (
        await call(ctx, 'POST', `/staff/cms/entries/${faq.id}/unpublish`, {
          cookie: world.editor.cookie,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect((await publish(world.publisher.cookie, faq.id, draftId)).statusCode).toBe(200);
    // „Produkte & Preise“: product.view, nicht cms.*
    expect(
      (await call(ctx, 'GET', '/staff/cms/catalog', { cookie: world.editor.cookie })).statusCode,
    ).toBe(403);
    const catalog = await call(ctx, 'GET', '/staff/cms/catalog', { cookie: world.viewer.cookie });
    expect(catalog.statusCode).toBe(200);
    expect((catalog.json() as { machines: unknown[] }).machines).toHaveLength(4);
  });

  it('C2. Revisionen sind immutable: UPDATE/DELETE scheitern, Speichern erzeugt eine neue Revision', async () => {
    const faq = await seedPage(world, { pageType: 'faq', path: '/faq' }, { content: faqContent() });
    const before = (
      await ctx.db.select().from(cmsRevisions).where(eq(cmsRevisions.id, faq.draft.revisionId))
    )[0]!;
    await expect(
      ctx.pool.query(`UPDATE cms_revisions SET meta_title = 'x' WHERE id = $1`, [before.id]),
    ).rejects.toThrow(/unveränderlich/);
    await expect(
      ctx.pool.query(`DELETE FROM cms_revisions WHERE id = $1`, [before.id]),
    ).rejects.toThrow(/unveränderlich/);

    const saved = await saveDraft(world.editor.cookie, faq, faqContent('Zweite Fassung.'), {
      metaTitle: 'FAQ',
      editorNote: 'intern',
    });
    expect(saved.statusCode).toBe(200);
    const detail = saved.json() as StaffCmsEntryDetail;
    expect(detail.draft.revisionNumber).toBe(2);
    expect(detail.draft.revisionId).not.toBe(before.id);
    expect(detail.draft.createdBy).toEqual({ id: world.editor.id, name: 'Erika Redaktion' });
    expect(detail.version).toBe(faq.version + 1);
    expect(detail.history.map((item) => item.revisionNumber)).toEqual([2, 1]);
    const after = (
      await ctx.db.select().from(cmsRevisions).where(eq(cmsRevisions.id, before.id))
    )[0]!;
    expect(after).toEqual(before);
  });

  it('C3. Optimistische Prüfung: veralteter baseRevisionId ⇒ 409 CMS_DRAFT_CONFLICT, nichts gespeichert', async () => {
    const faq = await seedPage(world, { pageType: 'faq', path: '/faq' }, { content: faqContent() });
    expect((await saveDraft(world.editor.cookie, faq, faqContent('A.'))).statusCode).toBe(200);
    const stale = await saveDraft(world.admin.cookie, faq, faqContent('B.'));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('CMS_DRAFT_CONFLICT');
    const revisions = await ctx.db
      .select()
      .from(cmsRevisions)
      .where(eq(cmsRevisions.entryId, faq.id));
    expect(revisions).toHaveLength(2);
  });

  it('C4. Entwurf nie öffentlich: Seite, Seitenliste und Einstellungen zeigen nur Veröffentlichtes', async () => {
    const faq = await seedPage(
      world,
      { pageType: 'faq', path: '/faq' },
      { content: faqContent('Veröffentlichte Antwort.'), metaTitle: 'FAQ' },
    );
    const about = await seedPage(
      world,
      { pageType: 'about', path: '/ueber-uns' },
      { content: { title: 'Über uns', blocks: [] }, metaTitle: 'Über uns' },
    );
    await seedSiteSettings(world, SETTINGS_CONTENT);
    // Noch nichts veröffentlicht
    expect((await call(ctx, 'GET', '/public/site/page?path=/faq')).statusCode).toBe(404);
    const emptySite = (await call(ctx, 'GET', '/public/site/settings')).json();
    expect(emptySite.settings).toBeNull();
    expect(emptySite.pages).toEqual([]);

    expect((await publish(world.publisher.cookie, faq.id, faq.draft.revisionId)).statusCode).toBe(
      200,
    );
    const v2 = await saveDraft(world.editor.cookie, faq, faqContent('ENTWURF-GEHEIM'), {
      metaTitle: 'FAQ',
    });
    expect(v2.statusCode).toBe(200);
    const page = await call(ctx, 'GET', '/public/site/page?path=/faq');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Veröffentlichte Antwort.');
    expect(page.body).not.toContain('ENTWURF-GEHEIM');
    expect(page.json().revisionId).toBe(faq.draft.revisionId);
    const site = (await call(ctx, 'GET', '/public/site/settings')).json();
    expect(site.settings).toBeNull(); // Einstellungen nur als Entwurf
    expect(site.pages.map((item: { path: string }) => item.path)).toEqual(['/faq']);
    expect(about.status).toBe('never_published');
    const list = (
      await call(ctx, 'GET', '/staff/cms/entries', { cookie: world.publisher.cookie })
    ).json() as { entries: Array<{ path: string | null; status: string; title: string }> };
    expect(list.entries.map((entry) => [entry.path, entry.status])).toEqual([
      [null, 'never_published'],
      ['/faq', 'published_with_draft_changes'],
      ['/ueber-uns', 'never_published'],
    ]);
    expect(list.entries[0]!.title).toBe('Website-Einstellungen');
  });

  it('C5. Atomares Veröffentlichen: veraltete Revision ⇒ 409 ohne Änderung; parallel ⇒ genau einer', async () => {
    const faq = await seedPage(
      world,
      { pageType: 'faq', path: '/faq' },
      { content: faqContent(), metaTitle: 'FAQ' },
    );
    const saved = (
      await saveDraft(world.editor.cookie, faq, faqContent('Zwei.'), { metaTitle: 'FAQ' })
    ).json() as StaffCmsEntryDetail;
    const stale = await publish(world.publisher.cookie, faq.id, faq.draft.revisionId);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('CMS_PUBLISH_STALE');
    const unchanged = (await ctx.db.select().from(cmsEntries).where(eq(cmsEntries.id, faq.id)))[0]!;
    expect(unchanged.publishedRevisionId).toBeNull();
    expect(unchanged.version).toBe(saved.version);
    expect(await cmsEvents()).toEqual([]);
    const results = await Promise.all([
      publish(world.publisher.cookie, faq.id, saved.draft.revisionId),
      publish(world.admin.cookie, faq.id, saved.draft.revisionId),
    ]);
    const codes = results.map((response) => response.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    const conflict = results.find((response) => response.statusCode === 409)!;
    expect(conflict.json().error.code).toBe('CMS_ALREADY_PUBLISHED');
    const published = (await cmsEvents()).filter((event) => event.type === 'cms.published');
    expect(published).toHaveLength(1);
    const entry = (await ctx.db.select().from(cmsEntries).where(eq(cmsEntries.id, faq.id)))[0]!;
    expect(entry.publishedRevisionId).toBe(saved.draft.revisionId);
    expect(entry.version).toBe(saved.version + 1);
  });

  it('C6. Pflichtangaben beim Veröffentlichen: Meta-Titel und Seitentyp-Regeln (Rechtstexte nur Text)', async () => {
    const faq = await seedPage(world, { pageType: 'faq', path: '/faq' }, { content: faqContent() });
    const missing = await publish(world.publisher.cookie, faq.id, faq.draft.revisionId);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('CMS_PUBLISH_INCOMPLETE');
    expect(missing.json().error.issues[0].path).toBe('metaTitle');

    const legal = await seedPage(
      world,
      { pageType: 'legal', path: '/impressum' },
      {
        content: {
          title: 'Impressum',
          blocks: [
            { type: 'text', body: 'Angaben gemäß Gesetz.' },
            {
              type: 'cta',
              heading: 'Kontakt',
              primary: { label: 'Schreib uns', href: '/kontakt' },
            },
          ],
        },
        metaTitle: 'Impressum',
      },
    );
    const invalid = await publish(world.publisher.cookie, legal.id, legal.draft.revisionId);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('CMS_CONTENT_INVALID');
    expect(await cmsEvents()).toEqual([]);
  });

  it('C7. Alte Revision bewusst als neuen Entwurf übernehmen (based_on), Historie bleibt', async () => {
    const faq = await seedPage(
      world,
      { pageType: 'faq', path: '/faq' },
      { content: faqContent('Erste Fassung.'), metaTitle: 'FAQ' },
    );
    const v2 = (
      await saveDraft(world.editor.cookie, faq, faqContent('Zweite Fassung.'), {
        metaTitle: 'FAQ neu',
      })
    ).json() as StaffCmsEntryDetail;
    const stale = await call(ctx, 'POST', `/staff/cms/entries/${faq.id}/restore`, {
      cookie: world.editor.cookie,
      payload: { revisionId: faq.draft.revisionId, baseRevisionId: faq.draft.revisionId },
    });
    expect(stale.statusCode).toBe(409);
    const restored = await call(ctx, 'POST', `/staff/cms/entries/${faq.id}/restore`, {
      cookie: world.editor.cookie,
      payload: { revisionId: faq.draft.revisionId, baseRevisionId: v2.draft.revisionId },
    });
    expect(restored.statusCode).toBe(200);
    const detail = restored.json() as StaffCmsEntryDetail;
    expect(detail.draft.revisionNumber).toBe(3);
    expect(detail.draft.content).toEqual(faq.draft.content);
    expect(detail.draft.metaTitle).toBe('FAQ');
    expect(detail.history[0]).toMatchObject({ revisionNumber: 3, basedOnRevisionNumber: 1 });
    expect(detail.history).toHaveLength(3);
    // Revision eines anderen Eintrags ⇒ 404
    const other = await seedPage(
      world,
      { pageType: 'about', path: '/ueber-uns' },
      { content: { title: 'Über uns', blocks: [] } },
    );
    const foreign = await call(ctx, 'POST', `/staff/cms/entries/${faq.id}/restore`, {
      cookie: world.editor.cookie,
      payload: { revisionId: other.draft.revisionId, baseRevisionId: detail.draft.revisionId },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('C8. Zurückziehen nur für region/secondary_offer; Audit cms.unpublished; danach 404', async () => {
    const faq = await seedPage(
      world,
      { pageType: 'faq', path: '/faq' },
      { content: faqContent(), metaTitle: 'FAQ' },
    );
    await publish(world.publisher.cookie, faq.id, faq.draft.revisionId);
    const forbidden = await call(ctx, 'POST', `/staff/cms/entries/${faq.id}/unpublish`, {
      cookie: world.publisher.cookie,
      payload: {},
    });
    expect(forbidden.statusCode).toBe(409);
    expect(forbidden.json().error.code).toBe('CMS_UNPUBLISH_FORBIDDEN');

    const region = await seedPage(
      world,
      { pageType: 'region', path: '/slushmaschine-mieten/mainz' },
      {
        content: { title: 'Slush in Mainz', blocks: [{ type: 'text', body: 'Eigener Text.' }] },
        metaTitle: 'Slush in Mainz',
      },
    );
    const published = await publish(world.publisher.cookie, region.id, region.draft.revisionId);
    expect((published.json() as StaffCmsEntryDetail).canUnpublish).toBe(true);
    expect(
      (await call(ctx, 'GET', '/public/site/page?path=/slushmaschine-mieten/mainz')).statusCode,
    ).toBe(200);
    const unpublished = await call(ctx, 'POST', `/staff/cms/entries/${region.id}/unpublish`, {
      cookie: world.publisher.cookie,
      payload: {},
    });
    expect(unpublished.statusCode).toBe(200);
    expect((unpublished.json() as StaffCmsEntryDetail).status).toBe('never_published');
    expect(
      (await call(ctx, 'GET', '/public/site/page?path=/slushmaschine-mieten/mainz')).statusCode,
    ).toBe(404);
    const again = await call(ctx, 'POST', `/staff/cms/entries/${region.id}/unpublish`, {
      cookie: world.publisher.cookie,
      payload: {},
    });
    expect(again.json().error.code).toBe('CMS_NOT_PUBLISHED');
    const events = await cmsEvents();
    const unpublishEvent = events.find((event) => event.type === 'cms.unpublished')!;
    expect(unpublishEvent.actorUserId).toBe(world.publisher.id);
    expect(unpublishEvent.details).toEqual({
      entryId: region.id,
      revisionId: region.draft.revisionId,
      revisionNumber: 1,
      path: '/slushmaschine-mieten/mainz',
      source: 'staff',
    });
  });

  it('C9. Regionsseite anlegen: eigener Entwurf, kein Doppel, strenge Slugs', async () => {
    const created = await call(ctx, 'POST', '/staff/cms/entries', {
      cookie: world.editor.cookie,
      payload: { regionSlug: 'ingelheim', title: 'Slushmaschine mieten in Ingelheim' },
    });
    expect(created.statusCode).toBe(201);
    const detail = created.json() as StaffCmsEntryDetail;
    expect(detail).toMatchObject({
      kind: 'page',
      pageType: 'region',
      path: '/slushmaschine-mieten/ingelheim',
      status: 'never_published',
      draftRevisionNumber: 1,
      canUnpublish: false,
    });
    expect(detail.draft.content).toEqual({
      title: 'Slushmaschine mieten in Ingelheim',
      blocks: [],
    });
    const duplicate = await call(ctx, 'POST', '/staff/cms/entries', {
      cookie: world.editor.cookie,
      payload: { regionSlug: 'ingelheim', title: 'Nochmal' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('CMS_PATH_TAKEN');
    for (const regionSlug of ['../faq', 'a', 'mainz/innenstadt', 'bad kreuznach']) {
      const invalid = await call(ctx, 'POST', '/staff/cms/entries', {
        cookie: world.editor.cookie,
        payload: { regionSlug, title: 'Test' },
      });
      expect(invalid.statusCode, regionSlug).toBe(400);
    }
    const extra = await call(ctx, 'POST', '/staff/cms/entries', {
      cookie: world.editor.cookie,
      payload: { regionSlug: 'bingen', title: 'Bingen', path: '/faq' },
    });
    expect(extra.statusCode).toBe(400);
  });

  it('C10. Preisfeld/Preistext ⇒ 400 (Feldpfad ohne Wert); Rechtstexte dürfen Beträge nennen', async () => {
    const slush = await seedPage(
      world,
      { pageType: 'slush', path: '/slushmaschine-mieten' },
      { content: { title: 'Slush', blocks: [] } },
    );
    const priceField = await saveDraft(world.editor.cookie, slush, {
      title: 'Slush',
      blocks: [{ type: 'product_grid', priceCents: 1 }],
    });
    expect(priceField.statusCode).toBe(400);
    expect(priceField.json().error.code).toBe('VALIDATION_ERROR');
    const priceText = await saveDraft(world.editor.cookie, slush, {
      title: 'Slush',
      blocks: [{ type: 'text', body: 'Die große Maschine kostet nur 99,00 € am Wochenende.' }],
    });
    expect(priceText.statusCode).toBe(400);
    expect(priceText.json().error.code).toBe('CMS_PRICE_TEXT_FORBIDDEN');
    expect(priceText.json().error.issues).toEqual([
      { path: 'content.blocks.0.body', message: 'Enthält eine Preisangabe.' },
    ]);
    expect(priceText.body).not.toContain('99,00');
    const priceMeta = await saveDraft(
      world.editor.cookie,
      slush,
      { title: 'Slush', blocks: [] },
      { metaTitle: 'Slush ab 60 Euro' },
    );
    expect(priceMeta.json().error.code).toBe('CMS_PRICE_TEXT_FORBIDDEN');
    expect((await ctx.db.select().from(cmsRevisions)).length).toBe(1);

    const legal = await seedPage(
      world,
      { pageType: 'legal', path: '/impressum' },
      { content: { title: 'Impressum', blocks: [{ type: 'text', body: 'Text.' }] } },
    );
    const legalAmount = await saveDraft(world.editor.cookie, legal, {
      title: 'Impressum',
      blocks: [{ type: 'text', body: 'Stammkapital 25.000 € (synthetisch).' }],
    });
    expect(legalAmount.statusCode).toBe(200);
  });

  it('C11. Exakte Abholadresse ⇒ 400 beim Speichern UND beim Veröffentlichen (auch Rechtstexte)', async () => {
    const contact = await seedPage(
      world,
      { pageType: 'contact', path: '/kontakt' },
      {
        content: {
          title: 'Kontakt',
          blocks: [{ type: 'text', body: 'Teststraße 1 ist unser Lager.' }],
        },
        metaTitle: 'Kontakt',
      },
    );
    await setStringSetting(ctx.db, world.adminId, PICKUP_EXACT_ADDRESS_KEY, CMS_TEST_EXACT_ADDRESS);
    const publishLater = await publish(
      world.publisher.cookie,
      contact.id,
      contact.draft.revisionId,
    );
    expect(publishLater.statusCode).toBe(400);
    expect(publishLater.json().error.code).toBe('CMS_EXACT_ADDRESS_FORBIDDEN');
    const save = await saveDraft(world.editor.cookie, contact, {
      title: 'Kontakt',
      blocks: [{ type: 'text', body: 'Abholung: TESTSTRASSE 1, Mainz.' }],
    });
    expect(save.statusCode).toBe(400);
    expect(save.json().error.code).toBe('CMS_EXACT_ADDRESS_FORBIDDEN');
    expect(save.body.toLowerCase()).not.toContain('teststr');
    const legal = await seedPage(
      world,
      { pageType: 'legal', path: '/datenschutz' },
      { content: { title: 'Datenschutz', blocks: [{ type: 'text', body: 'Text.' }] } },
    );
    const legalSave = await saveDraft(world.editor.cookie, legal, {
      title: 'Datenschutz',
      blocks: [{ type: 'text', body: 'Verantwortlich: Teststraße 1, 55129 Mainz.' }],
    });
    expect(legalSave.json().error.code).toBe('CMS_EXACT_ADDRESS_FORBIDDEN');
    const fine = await saveDraft(world.editor.cookie, contact, {
      title: 'Kontakt',
      blocks: [{ type: 'text', body: 'Abholung in Mainz-Hechtsheim.' }],
    });
    expect(fine.statusCode).toBe(200);
  });

  it('C12. Audit cms.published: nur IDs/Nummern/Pfad/Quelle, keine Texte', async () => {
    const faq = await seedPage(
      world,
      { pageType: 'faq', path: '/faq' },
      { content: faqContent('AUDIT-GEHEIMTEXT'), metaTitle: 'FAQ-META-GEHEIM' },
    );
    await publish(world.publisher.cookie, faq.id, faq.draft.revisionId);
    const v2 = (
      await saveDraft(world.editor.cookie, faq, faqContent('Neu.'), { metaTitle: 'FAQ' })
    ).json() as StaffCmsEntryDetail;
    await publish(world.admin.cookie, faq.id, v2.draft.revisionId);
    const events = (await cmsEvents()).filter((event) => event.type === 'cms.published');
    expect(events).toHaveLength(2);
    expect(events[0]!.actorUserId).toBe(world.publisher.id);
    expect(events[1]!.details).toEqual({
      entryId: faq.id,
      revisionId: v2.draft.revisionId,
      revisionNumber: 2,
      previousRevisionId: faq.draft.revisionId,
      path: '/faq',
      source: 'staff',
    });
    const serialized = JSON.stringify(await cmsEvents());
    expect(serialized).not.toContain('GEHEIM');
  });

  it('C13. Website-Einstellungen: Empfehlungsregeln nur auf aktive Slush-Maschinen, nicht überlappend, nie öffentlich', async () => {
    const settings = await seedSiteSettings(world, SETTINGS_CONTENT);
    const withRules = (rules: unknown[]) => ({ ...SETTINGS_CONTENT, recommendationRules: rules });
    const syrup = await saveDraft(
      world.editor.cookie,
      settings,
      withRules([{ guestMin: 1, guestMax: 50, machineProductSlug: 'sirup-kirsche' }]),
    );
    expect(syrup.statusCode).toBe(400);
    expect(syrup.json().error.code).toBe('CMS_RECOMMENDATION_INVALID');
    expect(syrup.json().error.issues[0].path).toBe(
      'content.recommendationRules.0.machineProductSlug',
    );
    const overlapping = await saveDraft(
      world.editor.cookie,
      settings,
      withRules([
        { guestMin: 1, guestMax: 50, machineProductSlug: 'slush-1x8' },
        { guestMin: 40, machineProductSlug: 'slush-2x10' },
      ]),
    );
    expect(overlapping.statusCode).toBe(400);
    expect(overlapping.json().error.code).toBe('VALIDATION_ERROR');
    const valid = await saveDraft(
      world.editor.cookie,
      settings,
      withRules([{ guestMin: 1, guestMax: 50, machineProductSlug: 'slush-1x8' }]),
    );
    expect(valid.statusCode).toBe(200);
    const draft = valid.json() as StaffCmsEntryDetail;
    // Maschine inzwischen deaktiviert ⇒ Veröffentlichen lehnt ab
    await ctx.db.update(products).set({ active: false }).where(eq(products.slug, 'slush-1x8'));
    const inactive = await publish(world.publisher.cookie, settings.id, draft.draft.revisionId);
    expect(inactive.statusCode).toBe(400);
    expect(inactive.json().error.code).toBe('CMS_RECOMMENDATION_INVALID');
    await ctx.db.update(products).set({ active: true }).where(eq(products.slug, 'slush-1x8'));
    expect(
      (await publish(world.publisher.cookie, settings.id, draft.draft.revisionId)).statusCode,
    ).toBe(200);
    const site = await call(ctx, 'GET', '/public/site/settings');
    expect(site.json().settings).toMatchObject({
      businessName: 'Miet-Royal',
      email: 'info@cms.test',
    });
    expect(site.body).not.toContain('recommendationRules');
    expect(site.body).not.toContain('guestMin');
  });

  it('C14. Ungültige Bodies (strict) und unbekannte IDs', async () => {
    const faq = await seedPage(world, { pageType: 'faq', path: '/faq' }, { content: faqContent() });
    const extra = await saveDraft(world.editor.cookie, faq, faqContent(), { publishNow: true });
    expect(extra.statusCode).toBe(400);
    const html = await saveDraft(world.editor.cookie, faq, {
      title: 'FAQ',
      blocks: [{ type: 'text', body: '<script>alert(1)</script>' }],
    });
    expect(html.statusCode).toBe(400);
    const unknown = await call(
      ctx,
      'GET',
      '/staff/cms/entries/00000000-0000-4000-8000-000000000000',
      { cookie: world.editor.cookie },
    );
    expect(unknown.statusCode).toBe(404);
    const badId = await call(ctx, 'GET', '/staff/cms/entries/nicht-uuid', {
      cookie: world.editor.cookie,
    });
    expect(badId.statusCode).toBe(400);
  });

  it('C15. Preis-Strich-Schreibweisen („ab 60,- €“, „60,– €“, „60.- EUR“, „EUR60“) ⇒ 400 beim Speichern UND Veröffentlichen (Review pricing-1/cms-2/content_ux-1)', async () => {
    const slush = await seedPage(
      world,
      { pageType: 'slush', path: '/slushmaschine-mieten' },
      { content: { title: 'Slush', blocks: [] }, metaTitle: 'Slush' },
    );
    for (const body of [
      'Unsere 1×8 L gibt es ab 60,- € pro Wochenende.',
      'Ab 60,– € pro Wochenende.',
      'Ab 60.- EUR.',
      'Nur EUR60 fürs Wochenende.',
      'Für 60 Euros.',
      'Schon ab 60,-',
    ]) {
      const saved = await saveDraft(world.editor.cookie, slush, {
        title: 'Slush',
        blocks: [{ type: 'text', body }],
      });
      expect(saved.statusCode, body).toBe(400);
      expect(saved.json().error.code, body).toBe('CMS_PRICE_TEXT_FORBIDDEN');
      expect(saved.json().error.issues).toEqual([
        { path: 'content.blocks.0.body', message: 'Enthält eine Preisangabe.' },
      ]);
      expect(saved.body).not.toContain(body);
    }
    const hero = await saveDraft(world.editor.cookie, slush, {
      title: 'Slush',
      blocks: [{ type: 'hero', heading: 'Slush', lead: 'Schon ab 60,- € fürs Wochenende' }],
    });
    expect(hero.json().error.code).toBe('CMS_PRICE_TEXT_FORBIDDEN');
    expect(hero.json().error.issues).toEqual([
      { path: 'content.blocks.0.lead', message: 'Enthält eine Preisangabe.' },
    ]);
    expect(hero.body).not.toContain('60,-');
    // Am Speicher-Guard vorbei abgelegter Entwurf ⇒ auch das Veröffentlichen lehnt ab.
    const bypass = await publishCmsForTests(
      ctx.db,
      { kind: 'page', pageType: 'slush', path: '/slushmaschine-mieten' },
      {
        content: { title: 'Slush', blocks: [{ type: 'text', body: 'Ab 60,– € pro Wochenende.' }] },
        metaTitle: 'Slush',
        publish: false,
      },
    );
    const published = await publish(world.publisher.cookie, slush.id, bypass.revisionId);
    expect(published.statusCode).toBe(400);
    expect(published.json().error.code).toBe('CMS_PRICE_TEXT_FORBIDDEN');
    expect(published.body).not.toContain('60,–');
    const [entry] = await ctx.db.select().from(cmsEntries).where(eq(cmsEntries.id, slush.id));
    expect(entry!.publishedRevisionId).toBeNull();
    // Zeitangaben/Mengen bleiben erlaubt.
    const fine = await saveDraft(world.editor.cookie, await world.cms.getEntry(slush.id), {
      title: 'Slush',
      blocks: [
        { type: 'text', body: 'Abholung Sa., 12.-14. Juni, 10-12 Uhr; 2 Europaletten; 2×10 L.' },
      ],
    });
    expect(fine.statusCode, fine.body).toBe(200);
  });

  it('C16. Exakte Abholadresse ohne Komma bzw. in Schreibvarianten ⇒ 400 beim Speichern UND Veröffentlichen; Firmenname/Region bleiben erlaubt (Review cms-1/pricing-2)', async () => {
    let faq = await seedPage(
      world,
      { pageType: 'faq', path: '/faq' },
      { content: faqContent(), metaTitle: 'Häufige Fragen | Miet-Royal' },
    );
    for (const address of [
      'Lindenhainweg 90 55130 Mainz',
      '55130 Mainz, Lindenhainweg 90',
      'Miet-Royal, Lindenhainweg 90, 55130 Mainz',
    ]) {
      await setStringSetting(ctx.db, world.adminId, PICKUP_EXACT_ADDRESS_KEY, address);
      for (const answer of [
        'Abholung am Lindenhainweg 90 in Mainz-Hechtsheim',
        'Abholung am Lindenhainweg Nr. 90.',
        'Abholung: Lindenhainweg90',
        'Abholung am Lindenhain-Weg 90.',
      ]) {
        const saved = await saveDraft(world.editor.cookie, faq, faqContent(answer));
        expect(saved.statusCode, `${address} / ${answer}`).toBe(400);
        expect(saved.json().error.code).toBe('CMS_EXACT_ADDRESS_FORBIDDEN');
        expect(saved.json().error.issues).toEqual([
          { path: 'content.blocks.0.items.0.answer', message: 'Enthält die genaue Abholadresse.' },
        ]);
        expect(saved.body.toLowerCase()).not.toContain('lindenhain');
      }
      const mapsLink = await saveDraft(world.editor.cookie, faq, {
        ...faqContent(),
        blocks: [
          ...faqContent().blocks,
          {
            type: 'cta',
            heading: 'Route',
            primary: { label: 'Karte', href: 'https://maps.google.com/?q=Lindenhainweg%2090' },
          },
        ],
      });
      expect(mapsLink.json().error.code, address).toBe('CMS_EXACT_ADDRESS_FORBIDDEN');
      expect(mapsLink.json().error.issues).toEqual([
        { path: 'content.blocks.1.primary.href', message: 'Enthält die genaue Abholadresse.' },
      ]);
      // Region, Firmenname (Meta-Titel „… | Miet-Royal“) und eine andere Hausnummer bleiben erlaubt.
      const fine = await saveDraft(
        world.editor.cookie,
        faq,
        faqContent('Du holst die Maschine in Mainz-Hechtsheim ab (nicht am Lindenhainweg 12).'),
        { metaTitle: 'Häufige Fragen | Miet-Royal' },
      );
      expect(fine.statusCode, `${address}: ${fine.body}`).toBe(200);
      faq = await world.cms.getEntry(faq.id);
    }
    // Am Speicher-Guard vorbei abgelegter Entwurf ⇒ das Veröffentlichen lehnt ab.
    const bypass = await publishCmsForTests(
      ctx.db,
      { kind: 'page', pageType: 'faq', path: '/faq' },
      {
        content: {
          title: 'Häufige Fragen',
          blocks: [
            {
              type: 'faq',
              items: [
                {
                  question: 'Wie läuft die Abholung?',
                  answer: 'Abholung am Lindenhainweg 90 in Mainz-Hechtsheim',
                },
              ],
            },
          ],
        },
        metaTitle: 'Häufige Fragen',
        publish: false,
      },
    );
    const published = await publish(world.publisher.cookie, faq.id, bypass.revisionId);
    expect(published.statusCode).toBe(400);
    expect(published.json().error.code).toBe('CMS_EXACT_ADDRESS_FORBIDDEN');
    expect(published.body.toLowerCase()).not.toContain('lindenhain');
  });

  it('C17. Steuer-/Formatzeichen (C1, Bidi, Zero-Width, U+2028) in Titel, Meta-Titel und Redaktionsnotiz ⇒ 400 VALIDATION_ERROR (Review cms-3)', async () => {
    const faq = await seedPage(world, { pageType: 'faq', path: '/faq' }, { content: faqContent() });
    const title = await saveDraft(world.editor.cookie, faq, { ...faqContent(), title: 'A\u0085B' });
    expect(title.statusCode).toBe(400);
    expect(title.json().error.code).toBe('VALIDATION_ERROR');
    expect(title.json().error.issues).toEqual([
      { path: 'content.title', message: 'Unzulässige Steuerzeichen.' },
    ]);
    for (const metaTitle of ['Meta\u202Etitel', 'Meta\u200Btitel', 'Meta\u2028titel']) {
      const meta = await saveDraft(world.editor.cookie, faq, faqContent(), { metaTitle });
      expect(meta.statusCode, JSON.stringify(metaTitle)).toBe(400);
      expect(meta.json().error.issues).toEqual([
        { path: 'metaTitle', message: 'Unzulässige Steuerzeichen.' },
      ]);
    }
    const note = await saveDraft(world.editor.cookie, faq, faqContent(), {
      editorNote: 'Notiz\u00ADmit weichem Trennzeichen',
    });
    expect(note.statusCode).toBe(400);
    expect(note.json().error.issues).toEqual([
      { path: 'editorNote', message: 'Unzulässige Steuerzeichen.' },
    ]);
    const fine = await saveDraft(
      world.editor.cookie,
      faq,
      faqContent('Zeile eins.\n\nZeile zwei.'),
      {
        editorNote: 'Notiz\nmit Zeilenumbruch',
      },
    );
    expect(fine.statusCode, fine.body).toBe(200);
    expect((await ctx.db.select().from(cmsRevisions)).length).toBe(2);
  });
});
