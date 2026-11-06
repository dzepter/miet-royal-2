/**
 * Phase-16-E2E (Order §26 H–J) – Website-CMS im Staff (/website) mit echter Web-Vorschau
 * (Web 3100 ↔ Haupt-API 3101, MAIL_PUBLIC_WEB_BASE_URL = Web 3100) und öffentlicher Website.
 *
 * H Entwurf einer veröffentlichten Seite ändern + speichern ⇒ öffentliche Seite unverändert ⇒
 *   „Vorschau öffnen“ (Popup, Fragment-Token, Consume, /vorschau/seite) zeigt den Entwurf mit
 *   Vorschau-Banner (noindex/no-store/no-referrer) ⇒ Veröffentlichen ⇒ öffentlich neue Revision
 * I Rechte: nur cms.edit ⇒ speichern ja, veröffentlichen nein (Knopf fehlt UND API 403);
 *   nur cms.publish ⇒ Lesemodus, Vorschau und Veröffentlichen
 * J Medien: echtes PNG (im Test erzeugt) hochladen, mit Alt-Text in einen Block einsetzen,
 *   speichern ⇒ öffentlich weder Bild noch Medien-URL (404) ⇒ nach Veröffentlichen Bild mit
 *   Alt-Text, Medien-URL 200 image/webp (immutable); nirgends ein Storage-Key
 *
 * Daten: Basis-Seed + apps/api/scripts/e2e-website-seed.ts (CMS-Bootstrap, alle Standardseiten
 * veröffentlicht in Revision 1; Mitarbeiter „nur cms.edit“/„nur cms.publish“). Vorschau-Tokens
 * erscheinen nie in Ausgaben (nur boolesche Vergleiche).
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, resetE2eDatabase } from '../helpers/seed.ts';
import { login } from '../helpers/settlement.ts';
import {
  CMS_EDITOR,
  CMS_PUBLISHER,
  WEB_ORIGIN,
  entryIdOf,
  generateTestPng,
  mainDb,
  seedWebsite,
  type WebsiteSeedResult,
} from '../helpers/website.ts';

test.describe.configure({ mode: 'serial' });

/** Entwicklungs-Cookie der Vorschau (apps/api/src/cms/preview-service.ts). */
const PREVIEW_COOKIE = 'mr_cms_preview';

let seed: WebsiteSeedResult;
let admin: Page;

interface EntryDetail {
  draft: { revisionId: string; revisionNumber: number; content: { blocks: unknown[] } };
  published: { revisionId: string; revisionNumber: number } | null;
}

function publishedHeading(path: string): string {
  const rows = mainDb<{ heading: string }>(
    `SELECT r.content->'blocks'->0->>'heading' AS heading
       FROM cms_entries e JOIN cms_revisions r ON r.id = e.published_revision_id
      WHERE e.path = $1`,
    [path],
  );
  expect(rows, `veröffentlichte Revision von ${path}`).toHaveLength(1);
  return rows[0]!.heading;
}

function publishedState(path: string): { revision_number: number; published_by: string | null } {
  return mainDb<{ revision_number: number; published_by: string | null }>(
    `SELECT r.revision_number, e.published_by
       FROM cms_entries e JOIN cms_revisions r ON r.id = e.published_revision_id
      WHERE e.path = $1`,
    [path],
  )[0]!;
}

async function visitorPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

/** Öffentliche Seite frisch laden und die H1 (Hero-Überschrift) prüfen. */
async function expectPublicHeading(page: Page, path: string, heading: string): Promise<void> {
  const response = await page.goto(`${WEB_ORIGIN}${path}`, { timeout: 60_000 });
  expect(response?.status(), `GET ${path}`).toBe(200);
  await expect(page.locator('h1')).toHaveText(heading);
  await expect(page.getByTestId('preview-banner')).toHaveCount(0);
}

async function openEditor(page: Page, entryId: string): Promise<void> {
  await page.goto(`/website/eintrag/${entryId}`);
  await expect(page.getByTestId('cms-entry-info')).toBeVisible({ timeout: 30_000 });
}

/**
 * „Vorschau öffnen“: der Staff öffnet sofort ein Popup und lenkt es auf
 * `${MAIL_PUBLIC_WEB_BASE_URL}/vorschau#token=…`; die Web-App löst das Token per POST ein
 * (HttpOnly-Cookie) und zeigt /vorschau/seite. Liefert das Popup auf /vorschau/seite.
 */
async function openPreviewPopup(page: Page): Promise<Page> {
  const popupPromise = page.waitForEvent('popup');
  const consumed = page.context().waitForEvent('response', {
    predicate: (response) => new URL(response.url()).pathname === '/api/public/cms/preview/consume',
    timeout: 60_000,
  });
  await page.getByTestId('cms-preview').click();
  const popup = await popupPromise;
  expect((await consumed).status(), 'POST /api/public/cms/preview/consume').toBe(200);
  await popup.waitForURL(`${WEB_ORIGIN}/vorschau/seite`, { timeout: 60_000 });
  await expect(popup.getByTestId('preview-banner')).toBeVisible({ timeout: 30_000 });
  // Fragment-Token ist aus der Adresszeile entfernt; Vorschau-Cookie HttpOnly + SameSite=Strict.
  expect(new URL(popup.url()).hash, 'Fragment entfernt').toBe('');
  const cookie = (await popup.context().cookies(WEB_ORIGIN)).find(
    (candidate) => candidate.name === PREVIEW_COOKIE,
  );
  expect(cookie, 'Vorschau-Cookie').toBeDefined();
  expect(cookie!.httpOnly).toBe(true);
  expect(cookie!.sameSite).toBe('Strict');
  expect(cookie!.path).toBe('/');
  return popup;
}

async function publishViaUi(page: Page, revisionNumber: number): Promise<void> {
  const publish = page.getByTestId('cms-publish');
  await expect(publish).toBeEnabled();
  await publish.click();
  const dialog = page.getByTestId('cms-publish-dialog');
  await expect(dialog).toContainText(`Revision ${revisionNumber} veröffentlichen?`);
  await page.getByTestId('cms-publish-confirm').click();
  await expect(page.getByTestId('cms-notice')).toHaveText(
    `Revision ${revisionNumber} ist veröffentlicht.`,
  );
  await expect(page.getByTestId('cms-entry-info')).toContainText(
    `Veröffentlicht: Revision ${revisionNumber}`,
  );
}

async function saveDraftViaUi(page: Page, revisionNumber: number): Promise<void> {
  await expect(page.getByTestId('cms-dirty')).toBeVisible();
  // Mit cms.publish: Veröffentlichen ist bei ungespeicherten Änderungen gesperrt (nur cms.edit:
  // der Knopf fehlt ganz – Szenario I prüft das gesondert).
  if ((await page.getByTestId('cms-publish').count()) > 0) {
    await expect(page.getByTestId('cms-publish')).toBeDisabled();
  }
  await page.getByTestId('cms-save').click();
  await expect(page.getByTestId('cms-notice')).toHaveText(
    `Entwurf gespeichert (Revision ${revisionNumber}). Die öffentliche Website ist unverändert.`,
  );
  await expect(page.getByTestId('cms-dirty')).toHaveCount(0);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  resetE2eDatabase();
  seed = seedWebsite('main');
  admin = await browser.newPage();
  await login(admin, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
});

test.afterAll(async () => {
  await admin?.context().close();
});

// ── H ─────────────────────────────────────────────────────────────────────

test('H. CMS: Entwurf von /ueber-uns ändern und speichern ⇒ öffentliche Seite unverändert ⇒ Vorschau (Popup, Fragment-Token, Consume) zeigt den Entwurf mit Banner und noindex/no-store ⇒ Veröffentlichen ⇒ öffentliche Seite zeigt Revision 2', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const path = '/ueber-uns';
  const entryId = entryIdOf(seed, path);
  const original = publishedHeading(path);
  const draftHeading = 'Über uns: Familienbetrieb mit Herz für Slush (Entwurf H)';
  const visitor = await visitorPage(browser);
  await expectPublicHeading(visitor, path, original);

  // Übersicht /website ⇒ Eintrag öffnen.
  await admin.goto('/');
  await admin.getByTestId('nav-website').click();
  await admin.waitForURL('**/website');
  const row = admin.getByTestId(`cms-entry-${path}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole('link').first().click();
  await admin.waitForURL(`**/website/eintrag/${entryId}`);
  await expect(admin.getByTestId('cms-entry-info')).toContainText('Entwurf: Revision 1');
  await expect(admin.getByTestId('cms-entry-info')).toContainText('Veröffentlicht: Revision 1');
  await expect(admin.getByTestId('cms-publish')).toBeDisabled(); // Entwurf == veröffentlicht

  await admin.getByTestId('cms-blocks-0-heading').fill(draftHeading);
  await saveDraftViaUi(admin, 2);
  await expect(admin.getByTestId('cms-entry-info')).toContainText('Veröffentlicht: Revision 1');

  // Öffentlich unverändert (Seite + Seiten-API), Entwurf nirgends öffentlich.
  await expectPublicHeading(visitor, path, original);
  expect((await visitor.content()).includes(draftHeading)).toBe(false);
  const publicPage = await visitor.request.get(
    `${WEB_ORIGIN}/api/public/site/page?path=${encodeURIComponent(path)}`,
  );
  expect(publicPage.status()).toBe(200);
  expect((await publicPage.text()).includes(draftHeading)).toBe(false);

  // Vorschau im Popup: echter Web-Renderer mit Banner, gebunden an Revision 2.
  const popup = await openPreviewPopup(admin);
  await expect(popup.getByTestId('preview-banner')).toContainText(
    'Vorschau – Entwurf (Revision 2), nicht veröffentlicht',
  );
  await expect(popup.locator('h1')).toHaveText(draftHeading);
  await expect(popup.getByTestId('site-frame')).toBeVisible();
  await expect(popup.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  // Antwort-Header der Vorschau-Seite (next dev ersetzt Cache-Control ggf. durch no-cache).
  const previewHtml = await popup.request.get(`${WEB_ORIGIN}/vorschau/seite`);
  expect(previewHtml.status()).toBe(200);
  const htmlHeaders = previewHtml.headers();
  expect(htmlHeaders['x-robots-tag']).toContain('noindex');
  expect(htmlHeaders['x-robots-tag']).toContain('noarchive');
  expect(htmlHeaders['referrer-policy']).toBe('no-referrer');
  expect(htmlHeaders['cache-control']).toMatch(/no-store|no-cache/);
  expect((await previewHtml.text()).includes(draftHeading)).toBe(true);
  // Vorschau-API: private, no-store, noindex/noarchive, no-referrer; genau Revision 2.
  const previewApi = await popup.request.get(`${WEB_ORIGIN}/api/public/cms/preview/page`);
  expect(previewApi.status()).toBe(200);
  const apiHeaders = previewApi.headers();
  expect(apiHeaders['cache-control']).toContain('no-store');
  expect(apiHeaders['x-robots-tag']).toContain('noindex');
  expect(apiHeaders['referrer-policy']).toBe('no-referrer');
  const previewBody = (await previewApi.json()) as {
    preview: { revisionNumber: number; entryKind: string };
    page: { path: string; publishedAt: string | null };
  };
  expect(previewBody.preview).toMatchObject({ revisionNumber: 2, entryKind: 'page' });
  expect(previewBody.page).toMatchObject({ path, publishedAt: null });
  // Öffentliche Routen lesen das Vorschau-Cookie nie (gleicher Browser, gleiche Seite).
  await expectPublicHeading(popup, path, original);
  await popup.close();

  // Veröffentlichen ⇒ öffentliche Seite zeigt die neue Revision; Historie bleibt erhalten.
  await publishViaUi(admin, 2);
  await expect(admin.getByTestId('cms-history-1')).toBeVisible();
  await expect(admin.getByTestId('cms-history-2')).toContainText('Veröffentlicht');
  await expectPublicHeading(visitor, path, draftHeading);
  expect(publishedState(path).revision_number).toBe(2);
  const audit = mainDb<{ n: number }>(
    `SELECT count(*)::int AS n FROM staff_security_events
      WHERE type = 'cms.published' AND details->>'entryId' = $1 AND details->>'source' = 'staff'`,
    [entryId],
  );
  expect(audit[0]!.n).toBe(1);
  await visitor.context().close();
});

// ── I ─────────────────────────────────────────────────────────────────────

test('I. Rechte: nur cms.edit speichert, kann aber nicht veröffentlichen (Knopf fehlt, API 403); nur cms.publish sieht den Lesemodus, öffnet die Vorschau und veröffentlicht', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const path = '/ablauf';
  const entryId = entryIdOf(seed, path);
  const original = publishedHeading(path);
  const editorHeading = 'So läuft deine Slush-Miete ab (Entwurf der Redaktion)';
  const visitor = await visitorPage(browser);

  // Redaktion (nur cms.edit).
  const editorContext = await browser.newContext();
  const editor = await editorContext.newPage();
  await login(editor, CMS_EDITOR.email, CMS_EDITOR.password, CMS_EDITOR.firstName);
  await expect(editor.getByTestId('nav-website')).toBeVisible();
  await openEditor(editor, entryId);
  await expect(editor.getByTestId('cms-read-only')).toHaveCount(0);
  await expect(editor.getByTestId('cms-publish')).toHaveCount(0);
  await expect(editor.getByTestId('cms-preview')).toBeVisible();
  await editor.getByTestId('cms-blocks-0-heading').fill(editorHeading);
  await saveDraftViaUi(editor, 2);
  const detail = (await (
    await editor.request.get(`/api/staff/cms/entries/${entryId}`)
  ).json()) as EntryDetail;
  expect(detail.draft.revisionNumber).toBe(2);
  // Serverseitig: Veröffentlichen ohne cms.publish ⇒ 403, nichts geändert.
  const denied = await editor.request.post(`/api/staff/cms/entries/${entryId}/publish`, {
    data: { revisionId: detail.draft.revisionId },
  });
  expect(denied.status()).toBe(403);
  expect(publishedState(path).revision_number).toBe(1);
  await expectPublicHeading(visitor, path, original);
  await editorContext.close();

  // Freigabe (nur cms.publish): Lesemodus, keine Bearbeitung, Vorschau + Veröffentlichen.
  const publisherContext = await browser.newContext();
  const publisher = await publisherContext.newPage();
  await login(publisher, CMS_PUBLISHER.email, CMS_PUBLISHER.password, CMS_PUBLISHER.firstName);
  await expect(publisher.getByTestId('nav-website')).toBeVisible();
  await openEditor(publisher, entryId);
  await expect(publisher.getByTestId('cms-read-only')).toBeVisible();
  await expect(publisher.getByTestId('cms-save')).toHaveCount(0);
  await expect(publisher.getByTestId('cms-add-block')).toHaveCount(0);
  const headingField = publisher.getByTestId('cms-blocks-0-heading');
  await expect(headingField).toHaveValue(editorHeading);
  await expect(headingField).toBeDisabled();
  // Serverseitig: Entwurf ändern bzw. Medien hochladen ohne cms.edit ⇒ 403.
  const draftDenied = await publisher.request.put(`/api/staff/cms/entries/${entryId}/draft`, {
    data: {
      baseRevisionId: detail.draft.revisionId,
      content: detail.draft.content,
      metaTitle: null,
      metaDescription: null,
      editorNote: null,
    },
  });
  expect(draftDenied.status()).toBe(403);
  const uploadDenied = await publisher.request.post('/api/staff/cms/media', {
    data: {
      label: 'Nicht erlaubt',
      mimeType: 'image/png',
      dataBase64: generateTestPng(8, 8).toString('base64'),
    },
  });
  expect(uploadDenied.status()).toBe(403);

  const popup = await openPreviewPopup(publisher);
  await expect(popup.getByTestId('preview-banner')).toContainText('Revision 2');
  await expect(popup.locator('h1')).toHaveText(editorHeading);
  await popup.close();

  await publishViaUi(publisher, 2);
  await expectPublicHeading(visitor, path, editorHeading);
  const state = publishedState(path);
  expect(state.revision_number).toBe(2);
  expect(state.published_by).toBe(seed.users[CMS_PUBLISHER.email]);
  await publisherContext.close();
  await visitor.context().close();
});

// ── J ─────────────────────────────────────────────────────────────────────

test('J. Medien: PNG hochladen, mit Alt-Text in einen Block einsetzen und speichern ⇒ öffentlich weder Bild noch Medien-URL (404) ⇒ nach Veröffentlichen Bild mit Alt-Text, Medien-URL 200 image/webp; kein Storage-Key in DOM oder Antworten', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const path = '/faq';
  const entryId = entryIdOf(seed, path);
  const label = 'E2E-Testmuster Creme-Bronze';
  const alt = 'Abstraktes Testmuster: Farbverlauf von Creme nach Bronze';
  const visitor = await visitorPage(browser);

  // Upload über /website/medien (echte Datei, JPEG/PNG/WebP – hier PNG 800×500).
  await admin.goto('/website/medien');
  await expect(admin.getByTestId('cms-media-upload')).toBeVisible({ timeout: 30_000 });
  await admin.getByTestId('cms-media-file').setInputFiles({
    name: 'e2e-testmuster.png',
    mimeType: 'image/png',
    buffer: generateTestPng(800, 500),
  });
  await admin.getByTestId('cms-media-label').fill(label);
  await admin.getByTestId('cms-media-alt').fill(alt);
  await admin.getByTestId('cms-media-upload-submit').click();
  await expect(admin.getByText(`„${label}“ wurde hochgeladen.`)).toBeVisible({ timeout: 30_000 });

  const mediaResponse = await admin.request.get('/api/staff/cms/media');
  expect(mediaResponse.status()).toBe(200);
  const mediaText = await mediaResponse.text();
  const media = (
    JSON.parse(mediaText) as {
      media: { id: string; label: string; variantWidths: number[]; usedInPublished: boolean }[];
    }
  ).media.find((item) => item.label === label);
  expect(media, 'hochgeladenes Medium').toBeDefined();
  const mediaId = media!.id;
  expect(media!.variantWidths.length).toBeGreaterThan(0);
  expect(media!.usedInPublished).toBe(false);
  await expect(admin.getByTestId(`cms-media-${mediaId}`)).toBeVisible();
  // Storage-Keys (`cms-media/<id>/<w>.webp`) bleiben intern.
  const storageKeys = mainDb<{ storage_key: string }>(
    'SELECT storage_key FROM cms_media_variants WHERE media_id = $1 ORDER BY width',
    [mediaId],
  ).map((row) => row.storage_key);
  expect(storageKeys.length).toBe(media!.variantWidths.length);
  const leaksKey = (text: string) =>
    storageKeys.some((key) => text.includes(key)) || /storage_?key/i.test(text);
  expect(leaksKey(mediaText), 'Storage-Key in der Staff-Medienliste').toBe(false);
  expect(leaksKey(await admin.content()), 'Storage-Key im Staff-DOM').toBe(false);

  // Bild als neuen Block in /faq einsetzen (Alt-Text), speichern.
  await openEditor(admin, entryId);
  const before = (await (
    await admin.request.get(`/api/staff/cms/entries/${entryId}`)
  ).json()) as EntryDetail;
  const blockIndex = before.draft.content.blocks.length;
  await admin.getByTestId('cms-add-block-type').selectOption('image');
  await admin.getByTestId('cms-add-block-submit').click();
  await admin.getByTestId(`cms-blocks-${blockIndex}-image-media`).selectOption(mediaId);
  const altField = admin.getByTestId(`cms-blocks-${blockIndex}-image-alt`);
  await expect(altField).toHaveValue(alt); // Vorschlag aus dem Standard-Alt-Text
  await altField.fill(alt);
  await saveDraftViaUi(admin, before.draft.revisionNumber + 1);

  // Öffentlich: weder Bild noch Medien-URL (Entwurfsmedien sind nicht erratbar).
  await visitor.goto(`${WEB_ORIGIN}${path}`, { timeout: 60_000 });
  await expect(visitor.getByTestId('cms-page')).toBeVisible();
  await expect(visitor.locator(`img[alt="${alt}"]`)).toHaveCount(0);
  expect((await visitor.content()).includes(mediaId)).toBe(false);
  for (const width of media!.variantWidths) {
    const hidden = await visitor.request.get(
      `${WEB_ORIGIN}/api/public/cms/media/${mediaId}/${width}`,
    );
    expect(hidden.status(), `Entwurfsmedium ${width} öffentlich`).toBe(404);
    const previewOnly = await visitor.request.get(
      `${WEB_ORIGIN}/api/public/cms/preview-media/${mediaId}/${width}`,
    );
    expect(previewOnly.status(), `Vorschau-Medium ohne Cookie ${width}`).toBe(404);
  }

  // Veröffentlichen ⇒ Bild mit Alt-Text, öffentliche Varianten 200 image/webp + immutable.
  await publishViaUi(admin, before.draft.revisionNumber + 1);
  await visitor.goto(`${WEB_ORIGIN}${path}`, { timeout: 60_000 });
  const image = visitor.locator(`img[alt="${alt}"]`);
  await expect(image).toHaveCount(1);
  await image.scrollIntoViewIfNeeded();
  await expect(image).toBeVisible();
  const src = (await image.getAttribute('src')) ?? '';
  expect(src).toMatch(new RegExp(`^/api/public/cms/media/${mediaId}/\\d+$`));
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
  for (const width of media!.variantWidths) {
    const variant = await visitor.request.get(
      `${WEB_ORIGIN}/api/public/cms/media/${mediaId}/${width}`,
    );
    expect(variant.status(), `Medium ${width}`).toBe(200);
    const headers = variant.headers();
    expect(headers['content-type']).toBe('image/webp');
    expect(headers['cache-control']).toContain('immutable');
    expect(headers['x-content-type-options']).toBe('nosniff');
    const bytes = await variant.body();
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP');
  }
  expect(leaksKey(await visitor.content()), 'Storage-Key im öffentlichen DOM').toBe(false);
  const pageJson = await visitor.request.get(
    `${WEB_ORIGIN}/api/public/site/page?path=${encodeURIComponent(path)}`,
  );
  const pageText = await pageJson.text();
  expect(pageText.includes(mediaId)).toBe(true);
  expect(leaksKey(pageText), 'Storage-Key in der Seiten-API').toBe(false);
  const listed = (
    (await (await admin.request.get('/api/staff/cms/media')).json()) as {
      media: { id: string; usedInPublished: boolean }[];
    }
  ).media.find((item) => item.id === mediaId);
  expect(listed?.usedInPublished).toBe(true);
  await visitor.context().close();
});
