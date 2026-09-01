'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../../components/auth-guard';
import { apiFetch, hasPermission } from '../../../lib/api';
import {
  formatEventDate,
  STATUS_BADGE_CLASS,
  STATUS_LABELS,
  type MainStatus,
} from '../../../lib/crm';

const SOURCE_LABELS: Record<string, string> = {
  website: 'Website',
  whatsapp: 'WhatsApp',
  staff_manual: 'Manuell angelegt',
  other: 'Sonstige',
};

interface ProcessDetail {
  process: {
    id: string;
    processNumber: string;
    customerId: string;
    mainStatus: MainStatus;
    source: string;
    eventDate: string | null;
    assignedUserId: string | null;
    createdAt: string;
    completedAt: string | null;
    cancelledAt: string | null;
    reopenedAt: string | null;
  };
  customer: {
    id: string;
    type: 'private' | 'organization';
    firstName: string | null;
    lastName: string | null;
    organizationName: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  notes: {
    id: string;
    text: string;
    createdAt: string;
    authorFirstName: string;
    authorLastName: string;
  }[];
  assignee: { id: string; firstName: string; lastName: string } | null;
}

interface StaffOption {
  id: string;
  firstName: string;
  lastName: string;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return date.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ProcessView() {
  const params = useParams<{ id: string }>();
  const me = useMe();
  const [detail, setDetail] = useState<ProcessDetail | null>(null);
  const [staffOptions, setStaffOptions] = useState<StaffOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingDate, setEditingDate] = useState(false);
  const [dateValue, setDateValue] = useState('');
  const [noteText, setNoteText] = useState('');
  const [commerce, setCommerce] = useState<{
    hasInquiry: boolean;
    offerStatus: string | null;
    confirmationStatus: string | null;
  }>({ hasInquiry: false, offerStatus: null, confirmationStatus: null });

  const load = useCallback(async () => {
    const result = await apiFetch<ProcessDetail>(`/staff/processes/${params.id}`);
    if (result.data !== null) {
      setDetail(result.data);
      setDateValue(result.data.process.eventDate ?? '');
    } else {
      setLoadError(result.errorMessage ?? 'Vorgang nicht gefunden.');
    }
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void apiFetch<{ staff: StaffOption[] }>('/staff/staff-options').then((result) => {
      if (result.data !== null) setStaffOptions(result.data.staff);
    });
  }, []);

  const loadCommerce = useCallback(async () => {
    const [inquiryResult, offerResult] = await Promise.all([
      apiFetch<{ inquiry: unknown }>(`/staff/processes/${params.id}/inquiry`),
      apiFetch<{
        offer: {
          offer: { currentVersionId: string | null };
          versions: { id: string; effectiveStatus: string }[];
        } | null;
        confirmation: { status: string } | null;
      }>(`/staff/processes/${params.id}/offer`),
    ]);
    const hasInquiry =
      inquiryResult.data?.inquiry !== null && inquiryResult.data?.inquiry !== undefined;
    let offerStatus: string | null = null;
    if (offerResult.data?.offer !== null && offerResult.data?.offer !== undefined) {
      const currentId = offerResult.data.offer.offer.currentVersionId;
      offerStatus =
        offerResult.data.offer.versions.find((version) => version.id === currentId)
          ?.effectiveStatus ?? null;
    }
    setCommerce({
      hasInquiry,
      offerStatus,
      confirmationStatus: offerResult.data?.confirmation?.status ?? null,
    });
  }, [params.id]);
  useEffect(() => {
    void loadCommerce();
  }, [loadCommerce]);

  async function runAction(path: string, body: unknown): Promise<void> {
    setBusy(true);
    setActionError(null);
    const result = await apiFetch(path, { method: 'POST', body });
    setBusy(false);
    if (!result.ok) {
      setActionError(result.errorMessage ?? 'Aktion fehlgeschlagen.');
      return;
    }
    await load();
  }

  async function saveEventDate(): Promise<void> {
    setBusy(true);
    setActionError(null);
    const result = await apiFetch(`/staff/processes/${params.id}`, {
      method: 'PATCH',
      body: { eventDate: dateValue === '' ? null : dateValue },
    });
    setBusy(false);
    if (!result.ok) {
      setActionError(result.errorMessage ?? 'Speichern fehlgeschlagen.');
      return;
    }
    setEditingDate(false);
    await load();
  }

  async function addNote(): Promise<void> {
    setBusy(true);
    setActionError(null);
    const result = await apiFetch(`/staff/processes/${params.id}/notes`, {
      method: 'POST',
      body: { text: noteText },
    });
    setBusy(false);
    if (!result.ok) {
      setActionError(result.errorMessage ?? 'Notiz konnte nicht gespeichert werden.');
      return;
    }
    setNoteText('');
    await load();
  }

  if (detail === null) {
    return (
      <main className="page">
        {loadError !== null ? (
          <p className="error">{loadError}</p>
        ) : (
          <p className="muted">Wird geladen …</p>
        )}
      </main>
    );
  }

  const { process, customer, notes, assignee } = detail;
  const customerLabel =
    customer === null
      ? 'Kunde nicht verfügbar'
      : customer.type === 'organization'
        ? (customer.organizationName ?? 'Organisation')
        : `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim();
  const isEditable = process.mainStatus === 'open' || process.mainStatus === 'reopened';
  const canEdit = hasPermission(me, 'process.edit');
  const canAssign = hasPermission(me, 'process.reassign');

  return (
    <main className="page">
      <p>
        <Link href="/vorgaenge">← Vorgänge</Link>
      </p>

      <div className="card">
        <h1 style={{ marginTop: 0 }}>{process.processNumber}</h1>
        <p>
          Kunde:{' '}
          {customer !== null ? (
            <Link href={`/kunden/${customer.id}`}>
              <strong>{customerLabel}</strong>
            </Link>
          ) : (
            <strong>{customerLabel}</strong>
          )}
          {' · '}Event: <strong>{formatEventDate(process.eventDate)}</strong>
          {' · '}
          <span className={`badge ${STATUS_BADGE_CLASS[process.mainStatus]}`}>
            {STATUS_LABELS[process.mainStatus]}
          </span>
        </p>
        <p className="muted">
          Zuständig:{' '}
          {assignee !== null ? `${assignee.firstName} ${assignee.lastName}` : 'Nicht zugewiesen'}
        </p>
      </div>

      <div className="card" aria-label="Nächste Aktion">
        <h2 style={{ marginTop: 0 }}>Nächste Aktion</h2>
        {commerce.confirmationStatus === 'prepared' ? (
          <p>
            <Link href={`/vorgaenge/${params.id}/angebot`}>
              <strong>Auftragsbestätigung prüfen</strong>
            </Link>
          </p>
        ) : commerce.confirmationStatus === 'approved' ? (
          <p>
            <Link href={`/vorgaenge/${params.id}/angebot`}>
              <strong>Auftragsbestätigung versenden</strong>
            </Link>
          </p>
        ) : commerce.offerStatus === 'draft' ? (
          <p>
            <Link href={`/vorgaenge/${params.id}/angebot`}>
              <strong>Angebot fertigstellen und versenden</strong>
            </Link>
          </p>
        ) : commerce.offerStatus === 'recheck_requested' ? (
          <p>
            <Link href={`/vorgaenge/${params.id}/angebot`}>
              <strong>Erneute Prüfung bearbeiten</strong>
            </Link>
          </p>
        ) : !commerce.hasInquiry && isEditable ? (
          <p>
            <Link href={`/vorgaenge/${params.id}/anfrage`}>
              <strong>Anfrage erfassen</strong>
            </Link>
          </p>
        ) : commerce.hasInquiry && commerce.offerStatus === null && isEditable ? (
          <p>
            <Link href={`/vorgaenge/${params.id}/angebot`}>
              <strong>Angebot erstellen</strong>
            </Link>
          </p>
        ) : (
          <p>Vorgang bearbeiten</p>
        )}
      </div>

      {actionError !== null && <p className="error">{actionError}</p>}
      {!isEditable && (
        <p className="muted">
          Der Vorgang ist {STATUS_LABELS[process.mainStatus].toLowerCase()} und für die normale
          Bearbeitung gesperrt.
          {hasPermission(me, 'process.reopen_completed')
            ? ' Zum Bearbeiten bitte wieder öffnen.'
            : ''}
        </p>
      )}

      <div className="card">
        <h2>Grunddaten</h2>
        <p>
          Quelle: {SOURCE_LABELS[process.source] ?? process.source} · Angelegt:{' '}
          {formatDateTime(process.createdAt)}
        </p>
        {editingDate ? (
          <p>
            <label htmlFor="p-event">Eventdatum</label>
            <input
              id="p-event"
              type="date"
              value={dateValue}
              onChange={(e) => setDateValue(e.target.value)}
            />
            <button className="primary" disabled={busy} onClick={() => void saveEventDate()}>
              Speichern
            </button>{' '}
            <button onClick={() => setEditingDate(false)}>Abbrechen</button>
          </p>
        ) : (
          <p>
            Eventdatum: {formatEventDate(process.eventDate)}{' '}
            {canEdit && isEditable && (
              <button onClick={() => setEditingDate(true)}>Datum ändern</button>
            )}
          </p>
        )}
        {customer !== null && (
          <p className="muted">
            Kontakt: {customer.email ?? '–'} · {customer.phone ?? '–'}
          </p>
        )}
      </div>

      <div className="card">
        <h2>Zuständigkeit</h2>
        {canAssign && isEditable ? (
          <p>
            <label htmlFor="p-assign">Zuständiger Mitarbeiter</label>
            <select
              id="p-assign"
              value={process.assignedUserId ?? ''}
              disabled={busy}
              onChange={(e) =>
                void runAction(`/staff/processes/${params.id}/assign`, {
                  userId: e.target.value === '' ? null : e.target.value,
                })
              }
            >
              <option value="">Nicht zugewiesen</option>
              {staffOptions.map((option) => (
                <option value={option.id} key={option.id}>
                  {option.lastName}, {option.firstName}
                </option>
              ))}
            </select>
          </p>
        ) : (
          <p>
            {assignee !== null ? `${assignee.firstName} ${assignee.lastName}` : 'Nicht zugewiesen'}
          </p>
        )}
      </div>

      <div className="card">
        <h2>Interne Notizen</h2>
        <p className="muted">Nur für Mitarbeitende sichtbar – nie für Kunden.</p>
        {canEdit && isEditable && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void addNote();
            }}
          >
            <label htmlFor="p-note">Neue Notiz</label>
            <textarea
              id="p-note"
              rows={3}
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
            />
            <button className="primary" type="submit" disabled={busy || noteText.trim() === ''}>
              Notiz speichern
            </button>
          </form>
        )}
        {notes.length === 0 && <p className="muted">Noch keine Notizen.</p>}
        {notes.map((note) => (
          <div className="list-row" key={note.id}>
            <div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{note.text}</div>
              <div className="muted">
                {note.authorFirstName} {note.authorLastName} · {formatDateTime(note.createdAt)}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Aktionen</h2>
        <p>
          {hasPermission(me, 'process.complete') && isEditable && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => void runAction(`/staff/processes/${params.id}/complete`, {})}
            >
              Vorgang abschließen
            </button>
          )}{' '}
          {hasPermission(me, 'process.reopen_completed') && !isEditable && (
            <button
              disabled={busy}
              onClick={() => void runAction(`/staff/processes/${params.id}/reopen`, {})}
            >
              Wieder öffnen
            </button>
          )}{' '}
          {hasPermission(me, 'process.cancel') && isEditable && (
            <button
              className="danger"
              disabled={busy}
              onClick={() => void runAction(`/staff/processes/${params.id}/cancel`, {})}
            >
              Stornieren
            </button>
          )}
        </p>
      </div>

      <div className="card">
        <h2>Anfrage &amp; Angebot</h2>
        <p>
          <Link href={`/vorgaenge/${params.id}/anfrage`}>
            Anfrage {commerce.hasInquiry ? 'ansehen/bearbeiten' : 'erfassen'}
          </Link>
        </p>
        <p>
          <Link href={`/vorgaenge/${params.id}/angebot`}>Angebot &amp; Auftragsbestätigung</Link>
        </p>
      </div>

      {/* Vorbereitete Bereiche späterer Phasen – bewusst ohne Fake-Inhalte. */}
      <div className="card">
        <h2>Weitere Bereiche</h2>
        <p className="muted">Lieferung/Tour, Rückgabe und Abrechnung folgen in späteren Phasen.</p>
      </div>
    </main>
  );
}

export default function ProcessDetailPage() {
  return (
    <AuthGuard>
      <ProcessView />
    </AuthGuard>
  );
}
