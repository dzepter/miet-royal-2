'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthGuard, useMe } from '../../../components/auth-guard';
import { OfflineActionHint, useOfflineNow } from '../../../components/communication';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { apiFetch, hasPermission } from '../../../lib/api';
import {
  assignUnmatched,
  CHANNEL_LABELS,
  fetchUnmatched,
  ignoreUnmatched,
  senderLabel,
  type UnmatchedMessage,
} from '../../../lib/communication';
import { formatEventDate, STATUS_LABELS, type MainStatus } from '../../../lib/crm';
import { formatBerlin } from '../../../lib/handover';

/**
 * Mehr → Kommunikation → Nicht zugeordnet (Phase 12, Order §22/§27): Kunden-
 * nachrichten, die keinem Vorgang sicher zugeordnet werden konnten. Nur
 * Absender, Betreff, Zeit, Textvorschau (reiner Text), Kanal und Fotoanzahl;
 * Aktionen „Vorgang zuordnen“ (über die bestehende Suche, nur sichtbare
 * Vorgänge) und „Ignorieren“. Keine Mailbox-App, keine Fachmutation.
 * Recht: message.reply_customer (serverseitig geprüft).
 */

interface ProcessHit {
  id: string;
  processNumber: string;
  mainStatus: MainStatus;
  eventDate: string | null;
  customerDisplayName: string;
}

function ProcessSearch({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (process: ProcessHit) => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ProcessHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setHits(null);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      setSearching(true);
      void apiFetch<{ processes: ProcessHit[] }>(
        `/staff/search?q=${encodeURIComponent(trimmed)}&includeCompleted=false`,
      ).then((result) => {
        setSearching(false);
        if (result.data !== null) {
          setHits(result.data.processes);
          setError(null);
        } else {
          setError(result.errorMessage ?? 'Die Suche ist fehlgeschlagen.');
        }
      });
    }, 250);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [query]);

  return (
    <div className="conflict-box" data-testid="unmatched-search-box">
      <label htmlFor="unmatched-search">Vorgang suchen (MR-Nummer, Kunde, E-Mail, Telefon)</label>
      <input
        id="unmatched-search"
        data-testid="unmatched-search"
        type="search"
        autoComplete="off"
        value={query}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
      />
      {searching && <p className="muted">Suche …</p>}
      {error !== null && <p className="error">{error}</p>}
      {hits !== null && hits.length === 0 && !searching && (
        <p className="muted">Kein passender Vorgang gefunden.</p>
      )}
      {hits?.map((hit) => (
        <div className="list-row" key={hit.id}>
          <span>
            <strong>{hit.processNumber}</strong> · {hit.customerDisplayName}
            <span className="muted">
              {' '}
              · Event {formatEventDate(hit.eventDate)} · {STATUS_LABELS[hit.mainStatus]}
            </span>
          </span>
          <button
            type="button"
            data-testid="unmatched-search-result"
            disabled={disabled}
            onClick={() => onPick(hit)}
          >
            Diesem Vorgang zuordnen
          </button>
        </div>
      ))}
    </div>
  );
}

function UnmatchedView() {
  const me = useMe();
  const offlineNow = useOfflineNow();
  const [messages, setMessages] = useState<UnmatchedMessage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; processId: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [searchFor, setSearchFor] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<{
    message: UnmatchedMessage;
    process: ProcessHit;
  } | null>(null);
  const [ignoreTarget, setIgnoreTarget] = useState<UnmatchedMessage | null>(null);

  const load = useCallback(async () => {
    const result = await fetchUnmatched();
    if (result.data !== null) {
      setMessages(result.data.messages);
      setLoadError(null);
    } else {
      setLoadError(result.errorMessage ?? 'Nachrichten konnten nicht geladen werden.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function confirmAssign() {
    if (assignTarget === null) return;
    const { message, process } = assignTarget;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await assignUnmatched(message.id, process.id);
    setBusy(false);
    setAssignTarget(null);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Die Nachricht konnte nicht zugeordnet werden.');
      await load();
      return;
    }
    setSearchFor(null);
    setNotice({
      text: `Nachricht wurde Vorgang ${process.processNumber} zugeordnet.`,
      processId: process.id,
    });
    await load();
  }

  async function confirmIgnore() {
    if (ignoreTarget === null) return;
    const target = ignoreTarget;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await ignoreUnmatched(target.id);
    setBusy(false);
    setIgnoreTarget(null);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Die Nachricht konnte nicht ignoriert werden.');
      await load();
      return;
    }
    setNotice({ text: 'Nachricht ignoriert.', processId: null });
    await load();
  }

  const canHandle = hasPermission(me, 'message.reply_customer');

  return (
    <main className="page">
      <p className="muted">Kommunikation › Nicht zugeordnet</p>
      <h1>Nicht zugeordnete Nachrichten</h1>
      <p className="muted">
        Kundennachrichten (E-Mail/WhatsApp), die keinem Vorgang eindeutig zugeordnet werden konnten.
        Eine Zuordnung verknüpft nur die Nachricht mit dem Vorgang – sie ändert nichts am Vorgang
        selbst.
      </p>
      {loadError !== null && <p className="error">{loadError}</p>}
      {error !== null && (
        <p className="error" data-testid="unmatched-error">
          {error}
        </p>
      )}
      {notice !== null && (
        <p className="success" data-testid="unmatched-notice">
          {notice.text}
          {notice.processId !== null && (
            <>
              {' '}
              <Link href={`/vorgaenge/${notice.processId}/kommunikation`}>
                Kommunikation öffnen
              </Link>
            </>
          )}
        </p>
      )}
      <OfflineActionHint testId="unmatched-offline-hint" />
      {messages === null && loadError === null && <p className="muted">Wird geladen …</p>}
      {messages !== null && (
        <div className="card" data-testid="unmatched-list">
          {messages.length === 0 && (
            <p className="muted" data-testid="unmatched-empty">
              Keine nicht zugeordneten Nachrichten.
            </p>
          )}
          {messages.map((message) => (
            <div
              key={message.id}
              data-testid="unmatched-item"
              data-channel={message.channel}
              style={{ borderBottom: '1px solid var(--border)', padding: '0.75rem 0' }}
            >
              <div className="muted" style={{ fontSize: '0.85rem' }}>
                <span className="badge" data-testid="unmatched-channel">
                  {CHANNEL_LABELS[message.channel]}
                </span>{' '}
                <span data-testid="unmatched-sender">{senderLabel(message.sender)}</span> ·{' '}
                {formatBerlin(message.receivedAt ?? message.createdAt)}
                {message.photoCount > 0 && (
                  <>
                    {' '}
                    ·{' '}
                    <span data-testid="unmatched-photo-count">
                      {message.photoCount} {message.photoCount === 1 ? 'Foto' : 'Fotos'}
                    </span>
                  </>
                )}
              </div>
              {message.subject !== null && message.subject !== '' && (
                <div
                  style={{ fontWeight: 600, overflowWrap: 'anywhere' }}
                  data-testid="unmatched-subject"
                >
                  {message.subject}
                </div>
              )}
              <div
                className="muted"
                data-testid="unmatched-preview"
                style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
              >
                {message.preview !== '' ? message.preview : '(kein Text)'}
              </div>
              {canHandle && (
                <p style={{ margin: '0.5rem 0 0' }}>
                  <button
                    type="button"
                    className="primary"
                    data-testid="unmatched-assign"
                    disabled={busy || offlineNow}
                    aria-expanded={searchFor === message.id}
                    onClick={() =>
                      setSearchFor((current) => (current === message.id ? null : message.id))
                    }
                  >
                    Vorgang zuordnen
                  </button>{' '}
                  <button
                    type="button"
                    data-testid="unmatched-ignore"
                    disabled={busy || offlineNow}
                    onClick={() => setIgnoreTarget(message)}
                  >
                    Ignorieren
                  </button>
                </p>
              )}
              {searchFor === message.id && (
                <ProcessSearch
                  disabled={busy || offlineNow}
                  onPick={(process) => setAssignTarget({ message, process })}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {assignTarget !== null && (
        <ConfirmDialog
          testId="unmatched-assign-dialog"
          title="Nachricht zuordnen?"
          confirmLabel="Zuordnen"
          confirmTestId="unmatched-assign-confirm"
          busy={busy}
          disabled={offlineNow}
          maxWidth="28rem"
          onCancel={() => setAssignTarget(null)}
          onConfirm={() => void confirmAssign()}
        >
          <p>
            Nachricht von <strong>{senderLabel(assignTarget.message.sender)}</strong> dem Vorgang{' '}
            <strong>{assignTarget.process.processNumber}</strong> (
            {assignTarget.process.customerDisplayName}) zuordnen?
          </p>
          <p className="muted">
            Bitte prüfen, ob Absender und Vorgang wirklich zusammengehören – die Nachricht ist
            danach für alle sichtbar, die diesen Vorgang sehen.
          </p>
        </ConfirmDialog>
      )}

      {ignoreTarget !== null && (
        <ConfirmDialog
          testId="unmatched-ignore-dialog"
          title="Nachricht ignorieren?"
          confirmLabel="Ignorieren"
          confirmTestId="unmatched-ignore-confirm"
          busy={busy}
          danger
          disabled={offlineNow}
          onCancel={() => setIgnoreTarget(null)}
          onConfirm={() => void confirmIgnore()}
        >
          <p>
            Die Nachricht von <strong>{senderLabel(ignoreTarget.sender)}</strong> verschwindet aus
            dieser Liste und wird keinem Vorgang zugeordnet. Das lässt sich hier nicht rückgängig
            machen.
          </p>
        </ConfirmDialog>
      )}
    </main>
  );
}

export default function UnmatchedPage() {
  return (
    <AuthGuard>
      <UnmatchedView />
    </AuthGuard>
  );
}
