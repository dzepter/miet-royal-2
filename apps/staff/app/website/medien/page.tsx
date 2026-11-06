'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthGuard, useMe } from '../../../components/auth-guard';
import { OfflineActionHint, useOfflineNow } from '../../../components/communication';
import { CmsNoAccess, WebsiteSubnav, canReadCms } from '../../../components/website';
import { apiFetch, hasPermission, type ApiResult } from '../../../lib/api';
import {
  CMS_MEDIA_ACCEPT,
  CMS_MEDIA_ALT_MAX,
  CMS_MEDIA_LABEL_MAX,
  CMS_MEDIA_MAX_BYTES,
  CMS_MEDIA_TYPES,
  cmsStaffMediaUrl,
  normalizeIssuePath,
  type StaffCmsMedia,
} from '../../../lib/cms';
import { fileToBase64, formatBerlin } from '../../../lib/handover';

/**
 * Phase 16 (STAFF, Design §2.3/§6): Medien der Website. Upload nur JPEG/PNG/WebP bis
 * 6 MiB als Base64-JSON (`{ label, mimeType, dataBase64 }`, cms.edit); die API prüft
 * Magic Bytes und Decode, entfernt Metadaten und erzeugt WebP-Varianten. Vorschau über
 * `/api/staff/cms/media/:id/:width` (Sitzung, no-store) – Storage-Keys erscheinen nie.
 * Standard-Alt-Text wird bei der Bildwahl im Editor vorgeschlagen. Kein Löschen
 * (ältere Revisionen referenzieren Bilder).
 */

function issueText(result: ApiResult<unknown>, fallback: string): string {
  const details = (result.errorIssues ?? [])
    .map((issue) => {
      const path = normalizeIssuePath(issue.path);
      const field =
        path === 'label' ? 'Bezeichnung' : path === 'defaultAlt' ? 'Standard-Alt-Text' : path;
      return `${field}: ${issue.message}`;
    })
    .join(' ');
  return `${result.errorMessage ?? fallback}${details === '' ? '' : ` ${details}`}`;
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
}

function UploadForm({ onUploaded }: { onUploaded: () => Promise<void> }) {
  const offlineNow = useOfflineNow();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState('');
  const [defaultAlt, setDefaultAlt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function pick(next: File | null) {
    setError(null);
    setNotice(null);
    if (next === null) {
      setFile(null);
      return;
    }
    if (!CMS_MEDIA_TYPES.includes(next.type)) {
      setFile(null);
      setError('Nur JPEG-, PNG- oder WebP-Bilder sind erlaubt (kein SVG, GIF oder HEIC).');
      return;
    }
    if (next.size < 1 || next.size > CMS_MEDIA_MAX_BYTES) {
      setFile(null);
      setError(`Das Bild ist ${formatMiB(next.size)} groß – erlaubt sind höchstens 6 MB.`);
      return;
    }
    setFile(next);
    if (label.trim() === '') setLabel(next.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 120));
  }

  async function upload() {
    if (file === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    let dataBase64: string;
    try {
      dataBase64 = await fileToBase64(file);
    } catch {
      setBusy(false);
      setError('Die Datei konnte nicht gelesen werden.');
      return;
    }
    const result = await apiFetch<StaffCmsMedia>('/staff/cms/media', {
      method: 'POST',
      body: { label: label.trim(), mimeType: file.type, dataBase64 },
    });
    if (!result.ok || result.data === null) {
      setBusy(false);
      setError(issueText(result, 'Das Bild konnte nicht hochgeladen werden.'));
      return;
    }
    if (defaultAlt.trim() !== '') {
      const altResult = await apiFetch<StaffCmsMedia>(`/staff/cms/media/${result.data.id}`, {
        method: 'PATCH',
        body: { defaultAlt: defaultAlt.trim() },
      });
      if (!altResult.ok) {
        setError(
          issueText(
            altResult,
            'Das Bild ist hochgeladen, aber der Standard-Alt-Text konnte nicht gespeichert werden.',
          ),
        );
      }
    }
    setBusy(false);
    setNotice(`„${result.data.label}“ wurde hochgeladen.`);
    setFile(null);
    setLabel('');
    setDefaultAlt('');
    if (fileInput.current !== null) fileInput.current.value = '';
    await onUploaded();
  }

  return (
    <section className="card" data-testid="cms-media-upload">
      <h2>Bild hochladen</h2>
      <p className="muted">
        JPEG, PNG oder WebP bis 6 MB. Beim Hochladen werden Metadaten (z. B. Kamera- und
        Standortdaten) entfernt und Web-Varianten erzeugt. Nur eigene Bilder mit geklärter Herkunft
        verwenden. Bilder werden erst öffentlich, wenn eine Seite mit dem Bild veröffentlicht ist.
      </p>
      <label htmlFor="cms-media-file">Datei</label>
      <input
        id="cms-media-file"
        data-testid="cms-media-file"
        ref={fileInput}
        type="file"
        accept={CMS_MEDIA_ACCEPT}
        onChange={(e) => pick(e.target.files?.[0] ?? null)}
      />
      {file !== null && (
        <p className="muted">
          Ausgewählt: {file.name} ({formatMiB(file.size)})
        </p>
      )}
      <label htmlFor="cms-media-label">Bezeichnung (intern)</label>
      <input
        id="cms-media-label"
        data-testid="cms-media-label"
        value={label}
        maxLength={CMS_MEDIA_LABEL_MAX}
        onChange={(e) => setLabel(e.target.value)}
      />
      <label htmlFor="cms-media-alt">Standard-Alt-Text (optional, Vorschlag im Editor)</label>
      <input
        id="cms-media-alt"
        data-testid="cms-media-alt"
        value={defaultAlt}
        maxLength={CMS_MEDIA_ALT_MAX}
        onChange={(e) => setDefaultAlt(e.target.value)}
      />
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice !== null && (
        <p className="success" role="status">
          {notice}
        </p>
      )}
      <button
        type="button"
        className="primary"
        data-testid="cms-media-upload-submit"
        disabled={busy || offlineNow || file === null || label.trim() === ''}
        onClick={() => void upload()}
      >
        {busy ? 'Wird hochgeladen …' : 'Hochladen'}
      </button>
    </section>
  );
}

function MediaRow({
  item,
  canEdit,
  onChanged,
}: {
  item: StaffCmsMedia;
  canEdit: boolean;
  onChanged: (item: StaffCmsMedia) => void;
}) {
  const offlineNow = useOfflineNow();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(item.label);
  const [defaultAlt, setDefaultAlt] = useState(item.defaultAlt ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const result = await apiFetch<StaffCmsMedia>(`/staff/cms/media/${item.id}`, {
      method: 'PATCH',
      body: {
        label: label.trim(),
        defaultAlt: defaultAlt.trim() === '' ? null : defaultAlt.trim(),
      },
    });
    setBusy(false);
    if (!result.ok || result.data === null) {
      setError(issueText(result, 'Speichern fehlgeschlagen.'));
      return;
    }
    setEditing(false);
    onChanged(result.data);
  }

  return (
    <div className="list-row" data-testid={`cms-media-${item.id}`}>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <img
          src={cmsStaffMediaUrl(item)}
          alt={`Vorschau: ${item.label}`}
          className="photo-thumb"
          loading="lazy"
        />
        <div>
          <strong>{item.label}</strong>{' '}
          {item.usedInPublished ? (
            <span className="badge active">Auf der Website veröffentlicht</span>
          ) : (
            <span className="badge">Nicht in einer veröffentlichten Seite</span>
          )}
          <div className="muted">
            {item.width} × {item.height} px · Varianten: {item.variantWidths.join(', ')} px ·
            hochgeladen am {formatBerlin(item.createdAt)}
          </div>
          <div className="muted">
            Standard-Alt-Text: {item.defaultAlt ?? '– (beim Einsetzen angeben oder dekorativ)'}
          </div>
        </div>
      </div>
      {canEdit && !editing && (
        <button type="button" onClick={() => setEditing(true)}>
          Bearbeiten
        </button>
      )}
      {editing && (
        <div style={{ flexBasis: '100%' }}>
          <label htmlFor={`cms-media-${item.id}-label`}>Bezeichnung (intern)</label>
          <input
            id={`cms-media-${item.id}-label`}
            value={label}
            maxLength={CMS_MEDIA_LABEL_MAX}
            onChange={(e) => setLabel(e.target.value)}
          />
          <label htmlFor={`cms-media-${item.id}-alt`}>Standard-Alt-Text</label>
          <input
            id={`cms-media-${item.id}-alt`}
            value={defaultAlt}
            maxLength={CMS_MEDIA_ALT_MAX}
            onChange={(e) => setDefaultAlt(e.target.value)}
          />
          <p className="muted">
            Der Standard-Alt-Text ist nur ein Vorschlag beim Einsetzen. Bereits gespeicherte Seiten
            behalten ihren Alt-Text.
          </p>
          {error !== null && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            className="primary"
            disabled={busy || offlineNow || label.trim() === ''}
            onClick={() => void save()}
          >
            Speichern
          </button>{' '}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setLabel(item.label);
              setDefaultAlt(item.defaultAlt ?? '');
              setError(null);
            }}
          >
            Abbrechen
          </button>
        </div>
      )}
    </div>
  );
}

function MediaView() {
  const me = useMe();
  const allowed = canReadCms(me);
  const canEdit = hasPermission(me, 'cms.edit');
  const [media, setMedia] = useState<StaffCmsMedia[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await apiFetch<{ media: StaffCmsMedia[] }>('/staff/cms/media');
    if (result.ok && result.data !== null) {
      setMedia(result.data.media);
      setError(null);
    } else {
      setError(result.errorMessage ?? 'Die Medien konnten nicht geladen werden.');
    }
  }, []);
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  if (me === null) return null;
  if (!allowed) return <CmsNoAccess title="Website – Medien" />;

  return (
    <main className="page">
      <h1>Website – Medien</h1>
      <WebsiteSubnav me={me} />
      <OfflineActionHint testId="cms-media-offline-hint" />
      {canEdit && <UploadForm onUploaded={load} />}
      <section className="card" data-testid="cms-media-list">
        <h2>Bilder</h2>
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {media !== null && media.length === 0 && (
          <p className="muted">Noch keine Bilder hochgeladen.</p>
        )}
        {(media ?? []).map((item) => (
          <MediaRow
            key={item.id}
            item={item}
            canEdit={canEdit}
            onChanged={(updated) =>
              setMedia((current) => (current ?? []).map((m) => (m.id === updated.id ? updated : m)))
            }
          />
        ))}
      </section>
    </main>
  );
}

export default function WebsiteMediaPage() {
  return (
    <AuthGuard>
      <MediaView />
    </AuthGuard>
  );
}
