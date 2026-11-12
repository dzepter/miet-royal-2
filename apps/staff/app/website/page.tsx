'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../components/auth-guard';
import { OfflineActionHint, useOfflineNow } from '../../components/communication';
import {
  CmsNoAccess,
  CmsStatusBadge,
  SeoWarningsBox,
  WebsiteSubnav,
  canReadCms,
} from '../../components/website';
import { apiFetch, hasPermission } from '../../lib/api';
import {
  CMS_GROUPS,
  CMS_PAGE_TYPE_LABELS,
  groupCmsEntries,
  groupSeoWarningsByEntry,
  isValidRegionSlug,
  normalizeIssuePath,
  regionPathOf,
  seoWarningCountLabel,
  seoWarningsOf,
  sortSeoWarnings,
  suggestRegionSlug,
  type SeoCheckResponse,
  type SeoWarning,
  type StaffCmsEntryDetail,
  type StaffCmsEntrySummary,
} from '../../lib/cms';
import { formatBerlin } from '../../lib/handover';

/**
 * Phase 16 (STAFF, Design §6): Übersicht „Website“ – alle CMS-Einträge in Gruppen
 * (Einstellungen, Hauptseiten, Regionale Seiten, Sekundäre Angebote, Rechtliches) mit
 * Status, Revisionsnummern und Datum. „Regionale Seite anlegen“ (cms.edit) legt genau
 * EINE Seite mit leerem Entwurf an – keine Massenerzeugung, keine Ortsnamen-Vorlage.
 *
 * Phase 17 (Design D12): Zusätzlich die Hinweise zur Suchmaschinen-Darstellung aus
 * `GET /staff/cms/seo-check` – als Kasten über den Gruppen und als Zähler je Eintrag.
 * Reine Redaktionshinweise: nichts wird blockiert; schlägt der Abruf fehl (Recht, offline,
 * Serverfehler), fehlt nur der Kasten – die Übersicht selbst ist davon unabhängig.
 */

function EntryRow({ entry, seoCount }: { entry: StaffCmsEntrySummary; seoCount: number }) {
  return (
    <div className="list-row" data-testid={`cms-entry-${entry.path ?? 'site-settings'}`}>
      <div>
        <Link href={`/website/eintrag/${entry.id}`}>
          <strong>{entry.title}</strong>
        </Link>{' '}
        <CmsStatusBadge status={entry.status} />
        <div className="muted">
          {entry.path ?? 'Kontakt, Logo, Instagram-Link, Maschinenempfehlung'}
          {entry.pageType !== null && entry.pageType !== 'region' && entry.kind === 'page'
            ? ` · ${CMS_PAGE_TYPE_LABELS[entry.pageType]}`
            : ''}
        </div>
        <div className="muted">
          Entwurf: Revision {entry.draftRevisionNumber}
          {entry.publishedRevisionNumber !== null
            ? ` · Veröffentlicht: Revision ${entry.publishedRevisionNumber}${
                entry.publishedAt !== null ? ` am ${formatBerlin(entry.publishedAt)}` : ''
              }`
            : ''}{' '}
          · Zuletzt geändert {formatBerlin(entry.updatedAt)}
        </div>
        {seoCount > 0 && (
          <div className="muted" data-testid="cms-entry-seo-count">
            <span className="badge warn">Hinweis</span> {seoWarningCountLabel(seoCount)} zur
            Suchmaschinen-Darstellung
          </div>
        )}
      </div>
      <Link href={`/website/eintrag/${entry.id}`} className="button-like">
        Öffnen
      </Link>
    </div>
  );
}

function CreateRegionForm() {
  const router = useRouter();
  const offlineNow = useOfflineNow();
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState('');
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveSlug = slugTouched ? slug : suggestRegionSlug(place);
  const slugValid = isValidRegionSlug(effectiveSlug);
  const titleValid = title.trim().length >= 1 && title.trim().length <= 120;

  async function create() {
    setBusy(true);
    setError(null);
    const result = await apiFetch<StaffCmsEntryDetail>('/staff/cms/entries', {
      method: 'POST',
      body: { regionSlug: effectiveSlug, title: title.trim() },
    });
    setBusy(false);
    if (!result.ok || result.data === null) {
      const details = (result.errorIssues ?? [])
        .map((issue) => {
          const path = normalizeIssuePath(issue.path);
          const field = path === 'regionSlug' ? 'Adresse' : path === 'title' ? 'Titel' : path;
          return `${field}: ${issue.message}`;
        })
        .join(' ');
      setError(
        `${result.errorMessage ?? 'Die Seite konnte nicht angelegt werden.'}${details ? ` ${details}` : ''}`,
      );
      return;
    }
    router.push(`/website/eintrag/${result.data.id}`);
  }

  if (!open) {
    return (
      <button type="button" data-testid="cms-region-create-open" onClick={() => setOpen(true)}>
        Regionale Seite anlegen
      </button>
    );
  }
  return (
    <div className="card" data-testid="cms-region-create">
      <h3 style={{ marginTop: 0 }}>Regionale Seite anlegen</h3>
      <p className="muted">
        Jede regionale Seite braucht eigenen, lokal geprüften Inhalt – bitte keine Vorlage mit
        ausgetauschtem Ortsnamen. Die Seite startet als leerer Entwurf und ist erst nach dem
        Veröffentlichen öffentlich.
      </p>
      <label htmlFor="cms-region-place">Ort</label>
      <input
        id="cms-region-place"
        data-testid="cms-region-place"
        value={place}
        maxLength={60}
        placeholder="z. B. Ingelheim"
        onChange={(e) => setPlace(e.target.value)}
      />
      <label htmlFor="cms-region-title">Seitentitel (Hauptüberschrift)</label>
      <input
        id="cms-region-title"
        data-testid="cms-region-title"
        value={title}
        maxLength={120}
        onChange={(e) => setTitle(e.target.value)}
      />
      <label htmlFor="cms-region-slug">Adresse der Seite (Ortsteil der URL)</label>
      <input
        id="cms-region-slug"
        data-testid="cms-region-slug"
        value={effectiveSlug}
        maxLength={60}
        placeholder="z. B. ingelheim"
        onChange={(e) => {
          setSlugTouched(true);
          setSlug(e.target.value.toLowerCase());
        }}
      />
      <p className="muted">
        Öffentliche Adresse nach dem Veröffentlichen:{' '}
        <code>{regionPathOf(effectiveSlug === '' ? '…' : effectiveSlug)}</code>
      </p>
      {effectiveSlug !== '' && !slugValid && (
        <p className="error">
          Nur Kleinbuchstaben, Ziffern und einzelne Bindestriche (2–60 Zeichen), z. B.
          „bad-kreuznach“.
        </p>
      )}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p>
        <button
          type="button"
          className="primary"
          data-testid="cms-region-create-submit"
          disabled={busy || offlineNow || !slugValid || !titleValid}
          onClick={() => void create()}
        >
          Seite als Entwurf anlegen
        </button>{' '}
        <button type="button" disabled={busy} onClick={() => setOpen(false)}>
          Abbrechen
        </button>
      </p>
    </div>
  );
}

function WebsiteOverview() {
  const me = useMe();
  const [entries, setEntries] = useState<StaffCmsEntrySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seoWarnings, setSeoWarnings] = useState<SeoWarning[]>([]);

  // SEO-Hinweise sind optional: jeder Fehler (403, offline, 500) ⇒ kein Kasten, keine Meldung.
  const loadSeo = useCallback(async () => {
    const result = await apiFetch<SeoCheckResponse>('/staff/cms/seo-check');
    setSeoWarnings(result.ok ? sortSeoWarnings(seoWarningsOf(result.data)) : []);
  }, []);

  const load = useCallback(async () => {
    const result = await apiFetch<{ entries: StaffCmsEntrySummary[] }>('/staff/cms/entries');
    if (result.ok && result.data !== null) {
      setEntries(result.data.entries);
      setError(null);
      void loadSeo();
    } else {
      setError(result.errorMessage ?? 'Die Website-Inhalte konnten nicht geladen werden.');
    }
  }, [loadSeo]);
  const allowed = canReadCms(me);
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  if (me === null) return null;
  if (!allowed) return <CmsNoAccess title="Website" />;
  const canEdit = hasPermission(me, 'cms.edit');
  const groups = groupCmsEntries(entries ?? []);
  const seoByEntry = groupSeoWarningsByEntry(seoWarnings);

  return (
    <main className="page">
      <h1>Website</h1>
      <WebsiteSubnav me={me} />
      <p className="muted">
        Entwürfe ändern die öffentliche Website nie. Erst „Veröffentlichen“ macht einen Stand
        öffentlich; ältere Stände bleiben in der Historie erhalten.
        {!canEdit && ' Du kannst Entwürfe ansehen, als Vorschau öffnen und veröffentlichen.'}
      </p>
      <OfflineActionHint testId="website-offline-hint" />
      {error !== null && (
        <p className="error" role="alert">
          {error}{' '}
          <button type="button" onClick={() => void load()}>
            Erneut laden
          </button>
        </p>
      )}
      {entries !== null && (
        <SeoWarningsBox
          testId="cms-seo-warnings"
          warnings={seoWarnings}
          intro="Das sind Hinweise für die Redaktion – nichts wird blockiert."
          catalogHref={hasPermission(me, 'product.view') ? '/website/produkte' : undefined}
        />
      )}
      {entries !== null && entries.length === 0 && (
        <div className="card">
          <p className="muted">
            Noch keine Website-Inhalte vorhanden. Die Standardseiten werden bei der Einrichtung als
            Entwürfe angelegt.
          </p>
        </div>
      )}
      {entries !== null &&
        CMS_GROUPS.map((group) => {
          const items = groups[group.key];
          if (items.length === 0 && !(group.key === 'region' && canEdit)) return null;
          return (
            <section className="card" key={group.key} data-testid={`cms-group-${group.key}`}>
              <h2>{group.title}</h2>
              {items.length === 0 && <p className="muted">Noch keine Seiten.</p>}
              {items.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  seoCount={seoByEntry.get(entry.id)?.length ?? 0}
                />
              ))}
              {group.key === 'region' && canEdit && (
                <div style={{ marginTop: '0.75rem' }}>
                  <CreateRegionForm />
                </div>
              )}
            </section>
          );
        })}
    </main>
  );
}

export default function WebsitePage() {
  return (
    <AuthGuard>
      <WebsiteOverview />
    </AuthGuard>
  );
}
