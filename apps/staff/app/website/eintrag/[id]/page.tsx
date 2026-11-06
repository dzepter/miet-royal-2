'use client';

import {
  cmsMetaDescriptionSchema,
  cmsMetaTitleSchema,
  cmsPageContentSchema,
  cmsSiteSettingsSchema,
  type CmsBlock,
  type CmsBlockType,
} from '@mietroyal/validation/cms';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthGuard, useMe } from '../../../../components/auth-guard';
import {
  CmsBlockFields,
  CmsEditorDataContext,
  CmsIssueContext,
  CmsTextField,
  type CmsProductOption,
} from '../../../../components/cms-fields';
import {
  CmsSettingsFields,
  settingsContentFrom,
  settingsFormFrom,
  type CmsSettingsForm,
} from '../../../../components/cms-settings-form';
import { OfflineActionHint, useOfflineNow } from '../../../../components/communication';
import { ConfirmDialog } from '../../../../components/confirm-dialog';
import {
  CmsNoAccess,
  CmsStatusBadge,
  WebsiteSubnav,
  canReadCms,
} from '../../../../components/website';
import { apiFetch, hasPermission, type ApiIssue, type ApiResult } from '../../../../lib/api';
import {
  CMS_BLOCK_TYPE_LABELS,
  CMS_EDITOR_NOTE_MAX,
  CMS_META_DESCRIPTION_MAX,
  CMS_META_TITLE_MAX,
  CMS_PAGE_TYPE_LABELS,
  allowedBlockTypes,
  blockIndexOfPath,
  cleanCmsBlock,
  describeIssuePath,
  issuesFromSchema,
  newCmsBlock,
  normalizeIssuePath,
  type CmsCatalog,
  type CmsCatalogMachine,
  type CmsPreviewAccess,
  type StaffCmsEntryDetail,
  type StaffCmsHistoryItem,
  type StaffCmsMedia,
  type StaffCmsRevision,
} from '../../../../lib/cms';
import { CATEGORY_LABELS, type ProductRow } from '../../../../lib/commerce';
import { formatBerlin } from '../../../../lib/handover';

/**
 * Phase 16 (STAFF, Design §6/§2.2): Editor eines CMS-Eintrags (Seite oder
 * Website-Einstellungen).
 *
 * - `cms.edit`: Entwurf speichern (PUT = vollständige Ersetzung, mit `baseRevisionId`),
 *   ältere Revision „Als neuen Entwurf übernehmen“.
 * - `cms.publish`: aktuellen, GESPEICHERTEN Entwurf veröffentlichen (Bestätigung mit
 *   Revisionsnummer), regionale Seiten/sekundäre Angebote zurückziehen.
 * - beide: lesen, Vorschau öffnen (kurzlebiger Link der API in neuem Tab).
 * - Nur `cms.publish` ⇒ Lesemodus (alle Felder gesperrt).
 * Alle Aktionen brauchen eine Verbindung (Offline-Router ⇒ ONLINE_REQUIRED). Die Rechte
 * prüft der Server; ausgeblendete Knöpfe sind nur UX.
 */

const CONFLICT_MESSAGE = 'Der Entwurf wurde inzwischen geändert – bitte neu laden.';
const CONFLICT_CODES = new Set(['CMS_DRAFT_CONFLICT', 'CMS_PUBLISH_STALE']);

interface KeyedBlock {
  key: string;
  block: CmsBlock;
}

type EditorModel =
  | { kind: 'page'; title: string; blocks: KeyedBlock[] }
  | { kind: 'site_settings'; form: CmsSettingsForm }
  | { kind: 'invalid' };

interface MetaModel {
  metaTitle: string;
  metaDescription: string;
  editorNote: string;
}

type Dialog =
  | { kind: 'publish' }
  | { kind: 'unpublish' }
  | { kind: 'restore'; item: StaffCmsHistoryItem }
  | { kind: 'removeBlock'; index: number };

let blockKeySeq = 0;
function keyed(block: CmsBlock): KeyedBlock {
  blockKeySeq += 1;
  return { key: `b${blockKeySeq}`, block };
}

function modelFrom(detail: StaffCmsEntryDetail): EditorModel {
  if (detail.kind === 'site_settings') {
    const parsed = cmsSiteSettingsSchema.safeParse(detail.draft.content);
    return parsed.success
      ? { kind: 'site_settings', form: settingsFormFrom(parsed.data) }
      : { kind: 'invalid' };
  }
  const parsed = cmsPageContentSchema.safeParse(detail.draft.content);
  return parsed.success
    ? { kind: 'page', title: parsed.data.title, blocks: parsed.data.blocks.map(keyed) }
    : { kind: 'invalid' };
}

function metaFrom(revision: StaffCmsRevision): MetaModel {
  return {
    metaTitle: revision.metaTitle ?? '',
    metaDescription: revision.metaDescription ?? '',
    editorNote: revision.editorNote ?? '',
  };
}

/** Vergleichsform für „ungespeicherte Änderungen“ (ohne die lokalen Block-Schlüssel). */
function serialize(model: EditorModel, meta: MetaModel): string {
  const content =
    model.kind === 'page'
      ? { title: model.title, blocks: model.blocks.map((b) => b.block) }
      : model.kind === 'site_settings'
        ? model.form
        : null;
  return JSON.stringify({ content, meta });
}

function orNull(value: string): string | null {
  return value.trim() === '' ? null : value;
}

function personName(ref: { name: string } | null): string {
  return ref === null ? 'System' : ref.name;
}

function excerpt(value: string | undefined, length = 80): string {
  if (value === undefined) return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length)} …` : flat;
}

function blockSummary(block: CmsBlock): string {
  switch (block.type) {
    case 'hero':
    case 'cta':
      return excerpt(block.heading);
    case 'text':
      return excerpt(block.heading ?? block.body);
    case 'image':
      return excerpt(
        block.caption ?? (block.image.decorative ? 'dekoratives Bild' : block.image.alt),
      );
    case 'faq':
      return `${excerpt(block.heading)} (${block.items.length} Fragen)`;
    case 'features':
    case 'steps':
      return `${excerpt(block.heading)} (${block.items.length} Einträge)`;
    case 'gallery':
      return `${excerpt(block.heading)} (${block.images.length} Bilder)`;
    case 'service_areas':
      return excerpt(block.areas.join(', '));
    default:
      return excerpt(block.heading);
  }
}

/** Lesesicht einer (älteren) Revision aus der Historie. */
function RevisionView({
  revision,
  kind,
  onClose,
}: {
  revision: StaffCmsRevision;
  kind: StaffCmsEntryDetail['kind'];
  onClose: () => void;
}) {
  const page = kind === 'page' ? cmsPageContentSchema.safeParse(revision.content) : null;
  const settings =
    kind === 'site_settings' ? cmsSiteSettingsSchema.safeParse(revision.content) : null;
  return (
    <div className="card" data-testid="cms-revision-view" style={{ borderColor: '#7aa7dd' }}>
      <div className="list-row" style={{ paddingTop: 0 }}>
        <h3 style={{ margin: 0 }}>Revision {revision.revisionNumber} (nur ansehen)</h3>
        <button type="button" onClick={onClose}>
          Schließen
        </button>
      </div>
      <p className="muted">
        Erstellt am {formatBerlin(revision.createdAt)} von {personName(revision.createdBy)}
      </p>
      {revision.metaTitle !== null && <p>Meta-Titel: {revision.metaTitle}</p>}
      {revision.metaDescription !== null && <p>Meta-Beschreibung: {revision.metaDescription}</p>}
      {revision.editorNote !== null && (
        <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>
          Redaktionsnotiz: {revision.editorNote}
        </p>
      )}
      {page?.success === true && (
        <>
          <p>
            <strong>{page.data.title}</strong>
          </p>
          <ol>
            {page.data.blocks.map((block, index) => (
              <li key={index}>
                {CMS_BLOCK_TYPE_LABELS[block.type]}
                {blockSummary(block) !== '' ? ` – ${blockSummary(block)}` : ''}
              </li>
            ))}
          </ol>
          {page.data.blocks.length === 0 && <p className="muted">Keine Blöcke.</p>}
        </>
      )}
      {settings?.success === true && (
        <ul>
          <li>Firmenname: {settings.data.businessName}</li>
          <li>Telefon: {settings.data.contact.phone ?? '–'}</li>
          <li>E-Mail: {settings.data.contact.email ?? '–'}</li>
          <li>Instagram: {settings.data.instagramUrl ?? '–'}</li>
          <li>
            Empfehlungsregeln:{' '}
            {settings.data.recommendationRules.length === 0
              ? 'keine'
              : settings.data.recommendationRules
                  .map(
                    (rule) =>
                      `${rule.guestMin}–${rule.guestMax ?? '∞'} Gäste ⇒ ${rule.machineProductSlug}`,
                  )
                  .join('; ')}
          </li>
        </ul>
      )}
      {(page?.success === false || settings?.success === false) && (
        <p className="muted">Der Inhalt dieser Revision kann hier nicht dargestellt werden.</p>
      )}
    </div>
  );
}

function EntryEditor() {
  const params = useParams<{ id: string }>();
  const entryId = params.id;
  const me = useMe();
  const offlineNow = useOfflineNow();
  const allowed = canReadCms(me);
  const canEdit = hasPermission(me, 'cms.edit');
  const canPublish = hasPermission(me, 'cms.publish');
  const canViewProducts = hasPermission(me, 'product.view');

  const [detail, setDetail] = useState<StaffCmsEntryDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [model, setModel] = useState<EditorModel>({ kind: 'invalid' });
  const [meta, setMeta] = useState<MetaModel>({
    metaTitle: '',
    metaDescription: '',
    editorNote: '',
  });
  const [baseline, setBaseline] = useState('');
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [addType, setAddType] = useState<CmsBlockType>('text');
  const [media, setMedia] = useState<StaffCmsMedia[]>([]);
  const [products, setProducts] = useState<CmsProductOption[] | null>(null);
  const [machines, setMachines] = useState<CmsCatalogMachine[] | null>(null);
  const [viewRevision, setViewRevision] = useState<StaffCmsRevision | null>(null);
  const [previewLink, setPreviewLink] = useState<CmsPreviewAccess | null>(null);

  const applyDetail = useCallback((next: StaffCmsEntryDetail) => {
    const nextModel = modelFrom(next);
    const nextMeta = metaFrom(next.draft);
    setDetail(next);
    setModel(nextModel);
    setMeta(nextMeta);
    setBaseline(serialize(nextModel, nextMeta));
    setIssues([]);
    setConflict(false);
  }, []);

  const load = useCallback(async () => {
    const result = await apiFetch<StaffCmsEntryDetail>(`/staff/cms/entries/${entryId}`);
    if (result.ok && result.data !== null) {
      applyDetail(result.data);
      setLoadError(null);
    } else {
      setLoadError(
        result.status === 404 || result.status === 400
          ? 'Dieser Website-Eintrag wurde nicht gefunden.'
          : (result.errorMessage ?? 'Der Eintrag konnte nicht geladen werden.'),
      );
    }
  }, [entryId, applyDetail]);

  const loadMedia = useCallback(() => {
    void apiFetch<{ media: StaffCmsMedia[] }>('/staff/cms/media').then((result) => {
      if (result.ok && result.data !== null) setMedia(result.data.media);
    });
  }, []);

  useEffect(() => {
    if (!allowed) return;
    void load();
    loadMedia();
  }, [allowed, load, loadMedia]);

  // Produktauswahl (product_grid) und Maschinen (Empfehlungsregeln) nur mit product.view;
  // nur beim Wechsel der Eintragsart laden, nicht bei jeder Detailänderung.
  const detailKind = detail?.kind ?? null;
  useEffect(() => {
    if (!allowed || !canViewProducts || detailKind === null) return;
    if (detailKind === 'site_settings') {
      void apiFetch<CmsCatalog>('/staff/cms/catalog').then((result) => {
        if (result.ok && result.data !== null) setMachines(result.data.machines);
      });
    } else {
      void apiFetch<{ products: ProductRow[] }>('/staff/products').then((result) => {
        if (result.ok && result.data !== null) {
          setProducts(
            result.data.products
              .filter((product) => product.active)
              .map((product) => ({
                slug: product.slug,
                name: product.name,
                categoryLabel: CATEGORY_LABELS[product.category] ?? product.category,
              })),
          );
        }
      });
    }
  }, [allowed, canViewProducts, detailKind]);

  const dirty = detail !== null && serialize(model, meta) !== baseline;

  // Ungespeicherte Änderungen nicht stillschweigend verlieren.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const issueMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const issue of issues) {
      const list = map.get(issue.path) ?? [];
      if (!list.includes(issue.message)) list.push(issue.message);
      map.set(issue.path, list);
    }
    return map;
  }, [issues]);

  const editorData = useMemo(
    () => ({ media, reloadMedia: loadMedia, products, readOnly: !canEdit }),
    [media, loadMedia, products, canEdit],
  );

  if (me === null) return null;
  if (!allowed) return <CmsNoAccess title="Website" />;

  const pageBlocks = model.kind === 'page' ? model.blocks.map((b) => b.block) : [];

  function showFailure(result: ApiResult<unknown>, fallback: string) {
    if (result.errorCode !== null && CONFLICT_CODES.has(result.errorCode)) {
      setConflict(true);
      setError(result.errorMessage ?? CONFLICT_MESSAGE);
      return;
    }
    setIssues(
      (result.errorIssues ?? []).map((issue) => ({
        path: normalizeIssuePath(issue.path),
        message: issue.message,
      })),
    );
    setError(result.errorMessage ?? fallback);
  }

  function resetMessages() {
    setError(null);
    setNotice(null);
    setPreviewLink(null);
  }

  /** Clientseitige Prüfung (UX) ⇒ Inhalt für den Server oder Prüfmeldungen. */
  function prepareContent(): { content: unknown } | { issues: ApiIssue[] } {
    const found: ApiIssue[] = [];
    let content: unknown = null;
    if (model.kind === 'page') {
      const parsed = cmsPageContentSchema.safeParse({
        title: model.title,
        blocks: model.blocks.map((b) => cleanCmsBlock(b.block)),
      });
      if (parsed.success) content = parsed.data;
      else found.push(...issuesFromSchema(parsed.error.issues));
      if (meta.metaTitle.trim() !== '') {
        const title = cmsMetaTitleSchema.safeParse(meta.metaTitle);
        if (!title.success) found.push(...issuesFromSchema(title.error.issues, ['metaTitle']));
      }
      if (meta.metaDescription.trim() !== '') {
        const description = cmsMetaDescriptionSchema.safeParse(meta.metaDescription);
        if (!description.success) {
          found.push(...issuesFromSchema(description.error.issues, ['metaDescription']));
        }
      }
    } else if (model.kind === 'site_settings') {
      const parsed = cmsSiteSettingsSchema.safeParse(settingsContentFrom(model.form));
      if (parsed.success) content = parsed.data;
      else found.push(...issuesFromSchema(parsed.error.issues));
    }
    if (meta.editorNote.trim().length > CMS_EDITOR_NOTE_MAX) {
      found.push({ path: 'editorNote', message: `Höchstens ${CMS_EDITOR_NOTE_MAX} Zeichen.` });
    }
    return found.length > 0 ? { issues: found } : { content };
  }

  async function saveDraft() {
    if (detail === null || model.kind === 'invalid') return;
    resetMessages();
    const prepared = prepareContent();
    if ('issues' in prepared) {
      setIssues(prepared.issues);
      setError('Bitte die markierten Angaben prüfen – der Entwurf wurde noch nicht gespeichert.');
      return;
    }
    setBusy(true);
    const result = await apiFetch<StaffCmsEntryDetail>(`/staff/cms/entries/${detail.id}/draft`, {
      method: 'PUT',
      body: {
        baseRevisionId: detail.draft.revisionId,
        content: prepared.content,
        metaTitle: orNull(meta.metaTitle),
        metaDescription: orNull(meta.metaDescription),
        editorNote: orNull(meta.editorNote),
      },
    });
    setBusy(false);
    if (!result.ok || result.data === null) {
      showFailure(result, 'Der Entwurf konnte nicht gespeichert werden.');
      return;
    }
    applyDetail(result.data);
    setNotice(
      `Entwurf gespeichert (Revision ${result.data.draft.revisionNumber}). Die öffentliche Website ist unverändert.`,
    );
  }

  async function publish() {
    if (detail === null) return;
    resetMessages();
    setBusy(true);
    const revisionNumber = detail.draft.revisionNumber;
    const result = await apiFetch<StaffCmsEntryDetail>(`/staff/cms/entries/${detail.id}/publish`, {
      method: 'POST',
      body: { revisionId: detail.draft.revisionId },
    });
    setBusy(false);
    setDialog(null);
    if (!result.ok || result.data === null) {
      showFailure(result, 'Veröffentlichen ist fehlgeschlagen.');
      return;
    }
    applyDetail(result.data);
    setNotice(`Revision ${revisionNumber} ist veröffentlicht.`);
  }

  async function unpublish() {
    if (detail === null) return;
    resetMessages();
    setBusy(true);
    const result = await apiFetch<StaffCmsEntryDetail>(
      `/staff/cms/entries/${detail.id}/unpublish`,
      { method: 'POST', body: {} },
    );
    setBusy(false);
    setDialog(null);
    if (!result.ok || result.data === null) {
      showFailure(result, 'Zurückziehen ist fehlgeschlagen.');
      return;
    }
    applyDetail(result.data);
    setNotice(
      'Die Seite ist zurückgezogen und nicht mehr öffentlich. Entwurf und Historie bleiben erhalten.',
    );
  }

  async function restore(item: StaffCmsHistoryItem) {
    if (detail === null) return;
    resetMessages();
    setBusy(true);
    const result = await apiFetch<StaffCmsEntryDetail>(`/staff/cms/entries/${detail.id}/restore`, {
      method: 'POST',
      body: { revisionId: item.revisionId, baseRevisionId: detail.draft.revisionId },
    });
    setBusy(false);
    setDialog(null);
    if (!result.ok || result.data === null) {
      showFailure(result, 'Die Revision konnte nicht übernommen werden.');
      return;
    }
    applyDetail(result.data);
    setViewRevision(null);
    setNotice(
      `Revision ${item.revisionNumber} wurde als neuer Entwurf übernommen (Revision ${result.data.draft.revisionNumber}). Veröffentlicht ist weiterhin der bisherige Stand.`,
    );
  }

  /**
   * Vorschau: Der Tab wird SOFORT (im Klick) geöffnet, damit Popup-Blocker ihn zulassen,
   * und erst nach der Antwort auf die kurzlebige Vorschau-URL (Token im Fragment) gelenkt.
   * Ohne Tab (blockiert) erscheint ein einmal nutzbarer Link.
   */
  async function openPreview(revisionId?: string) {
    if (detail === null) return;
    resetMessages();
    const win = window.open('', '_blank');
    setBusy(true);
    const result = await apiFetch<CmsPreviewAccess>(`/staff/cms/entries/${detail.id}/preview`, {
      method: 'POST',
      body: revisionId === undefined ? {} : { revisionId },
    });
    setBusy(false);
    if (!result.ok || result.data === null) {
      win?.close();
      showFailure(result, 'Die Vorschau konnte nicht erzeugt werden.');
      return;
    }
    const until = formatBerlin(result.data.expiresAt);
    if (win !== null) {
      win.opener = null;
      win.location.replace(result.data.url);
      setNotice(`Vorschau in neuem Tab geöffnet (einmal nutzbar, gültig bis ${until}).`);
    } else {
      setPreviewLink(result.data);
    }
  }

  async function showRevision(item: StaffCmsHistoryItem) {
    setError(null);
    const result = await apiFetch<StaffCmsRevision>(`/staff/cms/revisions/${item.revisionId}`);
    if (!result.ok || result.data === null) {
      setError(result.errorMessage ?? 'Die Revision konnte nicht geladen werden.');
      return;
    }
    setViewRevision(result.data);
  }

  function setBlocks(blocks: KeyedBlock[], structural: boolean) {
    if (model.kind !== 'page') return;
    setModel({ ...model, blocks });
    // Pfade („blocks.3…“) verschieben sich – alte Meldungen würden falsch zugeordnet.
    if (structural) setIssues([]);
  }

  function addBlock() {
    if (model.kind !== 'page') return;
    const block = keyed(newCmsBlock(addType));
    setBlocks(addType === 'hero' ? [block, ...model.blocks] : [...model.blocks, block], true);
  }

  function moveBlock(from: number, to: number) {
    if (model.kind !== 'page' || to < 0 || to >= model.blocks.length) return;
    const next = [...model.blocks];
    const [item] = next.splice(from, 1);
    if (item !== undefined) next.splice(to, 0, item);
    setBlocks(next, true);
  }

  if (loadError !== null) {
    return (
      <main className="page">
        <p>
          <Link href="/website">← Website</Link>
        </p>
        <p className="error" role="alert">
          {loadError}
        </p>
      </main>
    );
  }
  if (detail === null) {
    return (
      <main className="page">
        <p className="muted">Wird geladen …</p>
      </main>
    );
  }

  const isSettings = detail.kind === 'site_settings';
  const draftIsPublished = detail.published?.revisionId === detail.draft.revisionId;
  const actionsBlocked = busy || offlineNow;
  const hasHero = pageBlocks.some((block) => block.type === 'hero');
  const blockTypes = allowedBlockTypes(detail.pageType);
  const history = [...detail.history].sort((a, b) => b.revisionNumber - a.revisionNumber);

  return (
    <main className="page">
      <p>
        <Link href="/website">← Website</Link>
      </p>
      <h1 style={{ marginBottom: '0.25rem' }}>
        {detail.title} <CmsStatusBadge status={detail.status} />
      </h1>
      <WebsiteSubnav me={me} />
      <p className="muted" data-testid="cms-entry-info">
        {detail.path ?? 'Website-Einstellungen'}
        {detail.pageType !== null ? ` · ${CMS_PAGE_TYPE_LABELS[detail.pageType]}` : ''} · Entwurf:
        Revision {detail.draft.revisionNumber}
        {detail.published !== null
          ? ` · Veröffentlicht: Revision ${detail.published.revisionNumber} am ${formatBerlin(
              detail.published.publishedAt,
            )} von ${personName(detail.published.publishedBy)}`
          : ' · Nicht veröffentlicht'}
      </p>
      {!canEdit && (
        <p className="card" data-testid="cms-read-only" style={{ padding: '0.5rem 0.75rem' }}>
          <strong>Lesemodus:</strong> Du kannst diesen Entwurf ansehen, als Vorschau öffnen und
          veröffentlichen, aber nicht bearbeiten.
        </p>
      )}
      <OfflineActionHint testId="cms-offline-hint" />
      {conflict && (
        <div className="conflict-box" role="alert" data-testid="cms-conflict">
          <p style={{ margin: 0 }}>{CONFLICT_MESSAGE}</p>
          <p style={{ marginBottom: 0 }}>
            <button type="button" onClick={() => void load()}>
              Neu laden{dirty ? ' (eigene Änderungen verwerfen)' : ''}
            </button>
          </p>
        </div>
      )}
      {error !== null && !conflict && (
        <p className="error" role="alert" data-testid="cms-error">
          {error}
        </p>
      )}
      {notice !== null && (
        <p className="success" role="status" data-testid="cms-notice">
          {notice}
        </p>
      )}
      {previewLink !== null && (
        <p className="conflict-box" data-testid="cms-preview-link">
          Der Browser hat das Öffnen eines neuen Tabs blockiert.{' '}
          <a
            href={previewLink.url}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            onClick={() => setPreviewLink(null)}
          >
            Vorschau jetzt öffnen
          </a>{' '}
          (einmal nutzbar, gültig bis {formatBerlin(previewLink.expiresAt)}).
        </p>
      )}
      {issues.length > 0 && (
        <div className="conflict-box" data-testid="cms-issues">
          <strong>Bitte prüfen:</strong>
          <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>
            {issues.map((issue, index) => (
              <li key={`${issue.path}-${index}`}>
                {describeIssuePath(issue.path, pageBlocks)}: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <CmsIssueContext.Provider value={issueMap}>
        <CmsEditorDataContext.Provider value={editorData}>
          {model.kind === 'invalid' && (
            <p className="error" role="alert">
              Der gespeicherte Entwurf entspricht nicht dem aktuellen Inhaltsschema und kann hier
              nicht bearbeitet werden. Eine ältere Revision kann unten als neuer Entwurf übernommen
              werden.
            </p>
          )}
          <fieldset
            disabled={!canEdit || busy}
            style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }}
          >
            {model.kind === 'page' && (
              <section className="card">
                <h2>Seite</h2>
                <CmsTextField
                  path="title"
                  label={hasHero ? 'Seitentitel (H1 ist die Hero-Überschrift)' : 'Seitentitel (H1)'}
                  value={model.title}
                  max={120}
                  onChange={(title) => setModel({ ...model, title })}
                />
                <CmsTextField
                  path="metaTitle"
                  label="Meta-Titel (Suchergebnis-Titel, Pflicht zum Veröffentlichen)"
                  value={meta.metaTitle}
                  max={CMS_META_TITLE_MAX}
                  onChange={(metaTitle) => setMeta({ ...meta, metaTitle })}
                />
                <CmsTextField
                  path="metaDescription"
                  label="Meta-Beschreibung (Suchergebnis-Text)"
                  value={meta.metaDescription}
                  max={CMS_META_DESCRIPTION_MAX}
                  optional
                  multiline
                  rows={2}
                  onChange={(metaDescription) => setMeta({ ...meta, metaDescription })}
                />
              </section>
            )}

            {model.kind === 'site_settings' && (
              <CmsSettingsFields
                form={model.form}
                machines={canViewProducts ? machines : null}
                onChange={(form) => setModel({ ...model, form })}
              />
            )}

            {model.kind === 'page' && (
              <section data-testid="cms-blocks">
                <h2>Inhalt</h2>
                {detail.pageType === 'legal' && (
                  <p className="muted">Rechtstexte bestehen nur aus Textblöcken.</p>
                )}
                {model.blocks.length === 0 && (
                  <p className="muted card">Noch keine Blöcke – unten einen Block hinzufügen.</p>
                )}
                {model.blocks.map(({ key, block }, index) => {
                  const blockHasIssue = issues.some(
                    (issue) => blockIndexOfPath(issue.path) === index,
                  );
                  return (
                    <section className="card" key={key} data-testid={`cms-block-${index}`}>
                      <div className="list-row" style={{ paddingTop: 0 }}>
                        <h3 style={{ margin: 0, fontSize: '1rem' }}>
                          Block {index + 1}: {CMS_BLOCK_TYPE_LABELS[block.type]}{' '}
                          {blockHasIssue && <span className="badge locked">Bitte prüfen</span>}
                        </h3>
                        {canEdit && (
                          <span
                            style={{ display: 'inline-flex', gap: '0.25rem', flexWrap: 'wrap' }}
                          >
                            <button
                              type="button"
                              aria-label={`Block ${index + 1} nach oben`}
                              disabled={index === 0}
                              onClick={() => moveBlock(index, index - 1)}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              aria-label={`Block ${index + 1} nach unten`}
                              disabled={index === model.blocks.length - 1}
                              onClick={() => moveBlock(index, index + 1)}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              aria-label={`Block ${index + 1} entfernen`}
                              onClick={() => setDialog({ kind: 'removeBlock', index })}
                            >
                              Entfernen
                            </button>
                          </span>
                        )}
                      </div>
                      <CmsBlockFields
                        path={`blocks.${index}`}
                        block={block}
                        onChange={(next) =>
                          setBlocks(
                            model.blocks.map((item, i) =>
                              i === index ? { key: item.key, block: next } : item,
                            ),
                            false,
                          )
                        }
                      />
                    </section>
                  );
                })}
                {canEdit && (
                  <div className="card" data-testid="cms-add-block">
                    <label htmlFor="cms-add-block-type">Block hinzufügen</label>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <select
                        id="cms-add-block-type"
                        data-testid="cms-add-block-type"
                        value={addType}
                        style={{ flex: '1 1 14rem', marginBottom: 0 }}
                        onChange={(e) => setAddType(e.target.value as CmsBlockType)}
                      >
                        {blockTypes.map((type) => (
                          <option key={type} value={type} disabled={type === 'hero' && hasHero}>
                            {CMS_BLOCK_TYPE_LABELS[type]}
                            {type === 'hero' ? ' – nur als erster Block' : ''}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        data-testid="cms-add-block-submit"
                        disabled={
                          model.blocks.length >= 40 ||
                          !blockTypes.includes(addType) ||
                          (addType === 'hero' && hasHero)
                        }
                        onClick={addBlock}
                      >
                        Hinzufügen
                      </button>
                    </div>
                  </div>
                )}
              </section>
            )}

            <section className="card">
              <h2>Redaktionsnotiz (intern, nie öffentlich)</h2>
              <CmsTextField
                path="editorNote"
                label="Notiz für das Team, z. B. was vor dem Veröffentlichen noch zu prüfen ist"
                value={meta.editorNote}
                max={CMS_EDITOR_NOTE_MAX}
                optional
                multiline
                rows={3}
                onChange={(editorNote) => setMeta({ ...meta, editorNote })}
              />
            </section>
          </fieldset>
        </CmsEditorDataContext.Provider>
      </CmsIssueContext.Provider>

      <section className="card" data-testid="cms-actions">
        <h2>Aktionen</h2>
        {dirty && (
          <p className="badge warn" style={{ display: 'inline-block' }} data-testid="cms-dirty">
            Ungespeicherte Änderungen
          </p>
        )}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {canEdit && (
            <button
              type="button"
              className="primary"
              data-testid="cms-save"
              disabled={actionsBlocked || !dirty || model.kind === 'invalid'}
              onClick={() => void saveDraft()}
            >
              Entwurf speichern
            </button>
          )}
          <button
            type="button"
            data-testid="cms-preview"
            disabled={actionsBlocked}
            onClick={() => void openPreview()}
          >
            Vorschau öffnen
          </button>
          {canPublish && (
            <button
              type="button"
              className={canEdit ? undefined : 'primary'}
              data-testid="cms-publish"
              disabled={actionsBlocked || dirty || draftIsPublished}
              onClick={() => {
                resetMessages();
                setDialog({ kind: 'publish' });
              }}
            >
              Veröffentlichen
            </button>
          )}
          {canPublish && detail.canUnpublish && (
            <button
              type="button"
              className="danger"
              data-testid="cms-unpublish"
              disabled={actionsBlocked}
              onClick={() => {
                resetMessages();
                setDialog({ kind: 'unpublish' });
              }}
            >
              Zurückziehen
            </button>
          )}
        </div>
        <p className="muted">
          {dirty
            ? 'Vorschau und Veröffentlichen beziehen sich auf den zuletzt gespeicherten Entwurf – bitte zuerst speichern.'
            : draftIsPublished
              ? `Der aktuelle Entwurf (Revision ${detail.draft.revisionNumber}) ist veröffentlicht.`
              : `Die Vorschau zeigt den gespeicherten Entwurf (Revision ${detail.draft.revisionNumber}) mit dem echten Website-Layout. Der Vorschau-Link gilt 30 Minuten und nur einmal.`}
        </p>
      </section>

      <section className="card" data-testid="cms-history">
        <h2>Historie</h2>
        {viewRevision !== null && (
          <RevisionView
            revision={viewRevision}
            kind={detail.kind}
            onClose={() => setViewRevision(null)}
          />
        )}
        {history.map((item) => (
          <div
            className="list-row"
            key={item.revisionId}
            data-testid={`cms-history-${item.revisionNumber}`}
          >
            <div>
              <strong>Revision {item.revisionNumber}</strong>{' '}
              {item.isDraft && <span className="badge">Aktueller Entwurf</span>}{' '}
              {item.isPublished && <span className="badge active">Veröffentlicht</span>}
              <div className="muted">
                {formatBerlin(item.createdAt)} · {personName(item.createdBy)}
                {item.basedOnRevisionNumber !== null
                  ? ` · übernommen aus Revision ${item.basedOnRevisionNumber}`
                  : ''}
              </div>
            </div>
            <span style={{ display: 'inline-flex', gap: '0.25rem', flexWrap: 'wrap' }}>
              <button type="button" disabled={busy} onClick={() => void showRevision(item)}>
                Ansehen
              </button>
              <button
                type="button"
                disabled={actionsBlocked}
                onClick={() => void openPreview(item.revisionId)}
              >
                Vorschau
              </button>
              {canEdit && !item.isDraft && (
                <button
                  type="button"
                  data-testid={`cms-restore-${item.revisionNumber}`}
                  disabled={actionsBlocked}
                  onClick={() => {
                    resetMessages();
                    setDialog({ kind: 'restore', item });
                  }}
                >
                  Als neuen Entwurf übernehmen
                </button>
              )}
            </span>
          </div>
        ))}
      </section>

      {dialog?.kind === 'publish' && (
        <ConfirmDialog
          testId="cms-publish-dialog"
          title={`Revision ${detail.draft.revisionNumber} veröffentlichen?`}
          confirmLabel={`Revision ${detail.draft.revisionNumber} veröffentlichen`}
          confirmTestId="cms-publish-confirm"
          busy={busy}
          disabled={offlineNow}
          maxWidth="28rem"
          onConfirm={() => void publish()}
          onCancel={() => setDialog(null)}
        >
          {isSettings ? (
            <p>
              Die Website-Einstellungen (Kontaktangaben, Logo, Instagram-Link, Maschinenempfehlung)
              gelten danach öffentlich in Revision {detail.draft.revisionNumber}.
            </p>
          ) : (
            <p>
              „{detail.title}“ ({detail.path}) ist danach öffentlich in Revision{' '}
              {detail.draft.revisionNumber} zu sehen.
            </p>
          )}
          <p className="muted">
            {detail.published !== null
              ? `Bisher veröffentlicht: Revision ${detail.published.revisionNumber}. Sie bleibt in der Historie erhalten.`
              : 'Dieser Eintrag ist bisher nicht veröffentlicht.'}
          </p>
        </ConfirmDialog>
      )}
      {dialog?.kind === 'unpublish' && (
        <ConfirmDialog
          testId="cms-unpublish-dialog"
          title="Seite zurückziehen?"
          confirmLabel="Zurückziehen"
          confirmTestId="cms-unpublish-confirm"
          busy={busy}
          danger
          disabled={offlineNow}
          maxWidth="28rem"
          onConfirm={() => void unpublish()}
          onCancel={() => setDialog(null)}
        >
          <p>
            „{detail.title}“ ({detail.path}) ist danach nicht mehr öffentlich erreichbar. Entwurf
            und Historie bleiben erhalten; die Seite kann später erneut veröffentlicht werden.
          </p>
        </ConfirmDialog>
      )}
      {dialog?.kind === 'restore' && (
        <ConfirmDialog
          testId="cms-restore-dialog"
          title={`Revision ${dialog.item.revisionNumber} als neuen Entwurf übernehmen?`}
          confirmLabel="Als neuen Entwurf übernehmen"
          confirmTestId="cms-restore-confirm"
          busy={busy}
          disabled={offlineNow}
          maxWidth="28rem"
          onConfirm={() => void restore(dialog.item)}
          onCancel={() => setDialog(null)}
        >
          <p>
            Es entsteht eine neue Entwurfsrevision mit dem Inhalt von Revision{' '}
            {dialog.item.revisionNumber}. Der veröffentlichte Stand bleibt unverändert, bis du
            erneut veröffentlichst.
          </p>
          {dirty && (
            <p className="warning-red">Deine ungespeicherten Änderungen gehen dabei verloren.</p>
          )}
        </ConfirmDialog>
      )}
      {dialog?.kind === 'removeBlock' && model.kind === 'page' && (
        <ConfirmDialog
          testId="cms-remove-block-dialog"
          title={`Block ${dialog.index + 1} entfernen?`}
          confirmLabel="Block entfernen"
          confirmTestId="cms-remove-block-confirm"
          busy={false}
          danger
          onConfirm={() => {
            setBlocks(
              model.blocks.filter((_, i) => i !== dialog.index),
              true,
            );
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        >
          <p>
            Der Block wird aus diesem Entwurf entfernt. Gespeichert wird erst mit „Entwurf
            speichern“; ältere Revisionen bleiben unverändert.
          </p>
        </ConfirmDialog>
      )}
    </main>
  );
}

export default function WebsiteEntryPage() {
  return (
    <AuthGuard>
      <EntryEditor />
    </AuthGuard>
  );
}
