'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard } from '../../../../components/auth-guard';
import {
  MessagePhotoThumb,
  OfflineActionHint,
  useOfflineNow,
} from '../../../../components/communication';
import { apiFetch } from '../../../../lib/api';
import {
  BODY_DELETED_TEXT,
  CHANNEL_LABELS,
  DELIVERY_STATE_LABELS,
  fetchConversation,
  REPLY_MAX_CHARS,
  sendReply,
  senderLabel,
  WHATSAPP_MOCK_LABEL,
  WHATSAPP_WINDOW_CLOSED_TEXT,
  type ConversationMessage,
  type ConversationView,
} from '../../../../lib/communication';
import { formatBerlin } from '../../../../lib/handover';

/**
 * Vorgang → Kommunikation (Phase 12, Order §§23/24/28): chronologische
 * Nachrichten (E-Mail/WhatsApp, eingehend/ausgehend), automatische Mails als
 * kompakte Ereigniszeilen, Fotos nur als Blob-Vorschau. Texte werden
 * ausschließlich als reiner Text dargestellt (kein HTML, keine externen
 * Bilder). Antworten ohne Empfängerfeld – der Server bestimmt den Empfänger
 * (Kunden-E-Mail bzw. WhatsApp-Nummer der letzten Kundennachricht).
 */

type ReplyChannel = 'email' | 'whatsapp';

function messageTime(message: ConversationMessage): string {
  return formatBerlin(message.receivedAt ?? message.sentAt ?? message.createdAt);
}

function authorLabel(message: ConversationMessage): string {
  if (message.direction === 'inbound') return senderLabel(message.sender);
  if (message.createdByStaff !== null) {
    return `Miet-Royal (${message.createdByStaff.firstName} ${message.createdByStaff.lastName})`;
  }
  return (message.sender.name ?? '').trim() !== '' ? (message.sender.name ?? '') : 'Miet-Royal';
}

function SystemEventRow({ message }: { message: ConversationMessage }) {
  return (
    <div
      className="list-row muted"
      data-testid="conversation-event"
      data-channel={message.channel}
      data-delivery-state={message.deliveryState}
      style={{ padding: '0.35rem 0', fontSize: '0.875rem' }}
    >
      <span>
        <span className="badge" data-testid="conversation-channel-badge">
          {CHANNEL_LABELS[message.channel]}
        </span>{' '}
        Automatische Mail: {message.bodyDeleted ? BODY_DELETED_TEXT : (message.subject ?? '–')}
      </span>
      <span>
        {DELIVERY_STATE_LABELS[message.deliveryState] ?? 'Unbekannt'} · {messageTime(message)}
      </span>
    </div>
  );
}

function MessageBlock({ message }: { message: ConversationMessage }) {
  const inbound = message.direction === 'inbound';
  const skipped = message.sender.skippedAttachments ?? 0;
  return (
    <div
      data-testid="conversation-message"
      data-direction={message.direction}
      data-channel={message.channel}
      style={{
        border: '1px solid var(--border)',
        borderRadius: '0.6rem',
        padding: '0.6rem 0.8rem',
        margin: '0.5rem 0',
        background: inbound ? '#ffffff' : '#eef3fb',
        marginLeft: inbound ? 0 : 'min(3rem, 8%)',
        marginRight: inbound ? 'min(3rem, 8%)' : 0,
      }}
    >
      <div className="muted" style={{ fontSize: '0.85rem', marginBottom: '0.25rem' }}>
        <span className="badge" data-testid="conversation-channel-badge">
          {CHANNEL_LABELS[message.channel]}
        </span>{' '}
        <span data-testid="conversation-direction">{inbound ? 'Eingehend' : 'Ausgehend'}</span> ·{' '}
        <span data-testid="conversation-sender">{authorLabel(message)}</span> ·{' '}
        {messageTime(message)}
        {!inbound && (
          <>
            {' '}
            ·{' '}
            <span data-testid="conversation-delivery-state">
              {DELIVERY_STATE_LABELS[message.deliveryState] ?? 'Unbekannt'}
            </span>
          </>
        )}
      </div>
      {message.subject !== null && message.subject !== '' && !message.bodyDeleted && (
        <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{message.subject}</div>
      )}
      {message.bodyDeleted ? (
        <p className="muted" data-testid="conversation-body-deleted" style={{ margin: 0 }}>
          {BODY_DELETED_TEXT}
        </p>
      ) : (
        // Reiner Text: React escaped, Zeilenumbrüche bleiben erhalten – nie HTML.
        <div
          data-testid="conversation-body"
          style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        >
          {message.body}
        </div>
      )}
      {message.photos.length > 0 && (
        <div
          style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}
          data-testid="conversation-photos"
        >
          {message.photos.map((photo, index) => (
            <MessagePhotoThumb key={photo.id} messageId={message.id} photo={photo} index={index} />
          ))}
        </div>
      )}
      {skipped > 0 && (
        <p className="muted" style={{ margin: '0.35rem 0 0', fontSize: '0.85rem' }}>
          {skipped} {skipped === 1 ? 'Anhang wurde' : 'Anhänge wurden'} nicht übernommen (nur Bilder
          JPEG/PNG/WebP werden gespeichert).
        </p>
      )}
    </div>
  );
}

function CommunicationView() {
  const params = useParams<{ id: string }>();
  const offlineNow = useOfflineNow();
  const [view, setView] = useState<ConversationView | null>(null);
  const [header, setHeader] = useState<{ processNumber: string; customer: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [channel, setChannel] = useState<ReplyChannel | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await fetchConversation(params.id);
    if (result.data !== null) {
      setView(result.data);
      setLoadError(null);
    } else {
      setLoadError(result.errorMessage ?? 'Kommunikation konnte nicht geladen werden.');
    }
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void apiFetch<{
      process: { processNumber: string };
      customer: {
        type: 'private' | 'organization';
        firstName: string | null;
        lastName: string | null;
        organizationName: string | null;
      } | null;
    }>(`/staff/processes/${params.id}`).then((result) => {
      if (result.data === null) return;
      const customer = result.data.customer;
      setHeader({
        processNumber: result.data.process.processNumber,
        customer:
          customer === null
            ? ''
            : customer.type === 'organization'
              ? (customer.organizationName ?? '')
              : `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim(),
      });
    });
  }, [params.id]);

  const emailUsable = view?.canReplyEmail === true;
  const whatsappShown = view?.canReplyWhatsApp === true;
  const whatsappUsable =
    whatsappShown && view?.whatsapp.available === true && view.whatsapp.windowOpen;
  const whatsappClosed = whatsappShown && view?.whatsapp.available === true && !whatsappUsable;

  // Standardkanal: Kanal der letzten Kundennachricht, sofern nutzbar – sonst E-Mail.
  useEffect(() => {
    if (view === null) return;
    setChannel((current) => {
      if (current === 'email' && emailUsable) return current;
      if (current === 'whatsapp' && whatsappUsable) return current;
      const lastInbound = [...view.messages]
        .reverse()
        .find((message) => message.direction === 'inbound' && !message.isSystemEvent);
      if (lastInbound?.channel === 'whatsapp' && whatsappUsable) return 'whatsapp';
      if (emailUsable) return 'email';
      if (whatsappUsable) return 'whatsapp';
      return null;
    });
  }, [view, emailUsable, whatsappUsable]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (channel === null || offlineNow) return;
    const text = body.trim();
    if (text === '') return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await sendReply(params.id, channel, text);
    setBusy(false);
    if (!result.ok || result.data === null) {
      setError(result.errorMessage ?? 'Die Antwort konnte nicht gesendet werden.');
      await load();
      return;
    }
    setBody('');
    setNotice(
      result.data.deliveryState === 'blocked'
        ? 'Antwort gespeichert, der Versand ist jedoch blockiert (E-Mail-Versand nicht möglich).'
        : channel === 'email'
          ? 'Antwort wird per E-Mail gesendet.'
          : 'Antwort wird per WhatsApp gesendet.',
    );
    await load();
  }

  const messages = view?.messages ?? [];
  const mock = view?.whatsapp.mode === 'mock';

  return (
    <main className="page">
      <p>
        <Link href={`/vorgaenge/${params.id}`}>← Vorgang</Link>
      </p>
      <h1>
        Kommunikation{header !== null ? ` · ${header.processNumber}` : ''}
        {header !== null && header.customer !== '' ? (
          <span className="muted" style={{ fontWeight: 400 }}>
            {' '}
            · {header.customer}
          </span>
        ) : null}
      </h1>
      {mock && (
        <p>
          <span className="badge locked" data-testid="whatsapp-demo-label">
            WhatsApp: {WHATSAPP_MOCK_LABEL}
          </span>
        </p>
      )}
      {loadError !== null && <p className="error">{loadError}</p>}
      {view === null && loadError === null && <p className="muted">Wird geladen …</p>}

      {view !== null && (
        <div className="card" data-testid="conversation-list">
          <h2>Nachrichten</h2>
          {messages.length === 0 && (
            <p className="muted" data-testid="conversation-empty">
              Noch keine Nachrichten zu diesem Vorgang.
            </p>
          )}
          {messages.map((message) =>
            message.isSystemEvent ? (
              <SystemEventRow key={message.id} message={message} />
            ) : (
              <MessageBlock key={message.id} message={message} />
            ),
          )}
        </div>
      )}

      {view !== null && (
        <div className="card" data-testid="reply-section">
          <h2>Antworten</h2>
          {!emailUsable && !whatsappShown ? (
            <p className="muted" data-testid="reply-not-allowed">
              Antworten an den Kunden erfordern das Recht „Kunden antworten“ (E-Mail) bzw. „WhatsApp
              antworten“.
            </p>
          ) : (
            <form data-testid="reply-form" onSubmit={(e) => void submit(e)}>
              <p className="muted" style={{ marginTop: 0 }}>
                Empfänger ist immer der Kunde dieses Vorgangs – bei E-Mail die hinterlegte
                Kunden-E-Mail, bei WhatsApp die Nummer der letzten Kundennachricht.
              </p>
              <fieldset style={{ border: 'none', padding: 0, margin: '0 0 0.5rem' }}>
                <legend className="muted" style={{ fontSize: '0.875rem' }}>
                  Kanal
                </legend>
                {emailUsable && (
                  <label className="perm-item" style={{ display: 'inline-flex' }}>
                    <input
                      type="radio"
                      name="reply-channel"
                      value="email"
                      data-testid="reply-channel-email"
                      checked={channel === 'email'}
                      onChange={() => setChannel('email')}
                    />
                    <span>E-Mail</span>
                  </label>
                )}{' '}
                {whatsappShown && (
                  <label className="perm-item" style={{ display: 'inline-flex' }}>
                    <input
                      type="radio"
                      name="reply-channel"
                      value="whatsapp"
                      data-testid="reply-channel-whatsapp"
                      checked={channel === 'whatsapp'}
                      disabled={!whatsappUsable}
                      onChange={() => setChannel('whatsapp')}
                    />
                    <span>
                      WhatsApp
                      {mock ? ` (${WHATSAPP_MOCK_LABEL})` : ''}
                    </span>
                  </label>
                )}
              </fieldset>
              {whatsappClosed && (
                <p className="warning-red" role="status" data-testid="whatsapp-window-closed">
                  {WHATSAPP_WINDOW_CLOSED_TEXT}
                </p>
              )}
              {whatsappShown && view.whatsapp.available === false && (
                <p className="muted" data-testid="whatsapp-not-available">
                  WhatsApp-Antwort erst möglich, wenn der Kunde in diesem Vorgang per WhatsApp
                  geschrieben hat.
                </p>
              )}
              {whatsappUsable && view.whatsapp.windowEndsAt !== null && (
                <p className="muted" data-testid="whatsapp-window-open">
                  WhatsApp-Antwortfenster offen bis {formatBerlin(view.whatsapp.windowEndsAt)}.
                </p>
              )}
              <label htmlFor="reply-body">Nachricht</label>
              <textarea
                id="reply-body"
                data-testid="reply-body"
                rows={5}
                maxLength={REPLY_MAX_CHARS}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              <p className="muted" style={{ margin: '0.25rem 0', fontSize: '0.8rem' }}>
                {body.length} / {REPLY_MAX_CHARS} Zeichen
              </p>
              {error !== null && (
                <p className="error" data-testid="reply-error">
                  {error}
                </p>
              )}
              {notice !== null && (
                <p className="success" data-testid="reply-success">
                  {notice}
                </p>
              )}
              <OfflineActionHint testId="communication-offline-hint" />
              <button
                type="submit"
                className="primary"
                data-testid="reply-submit"
                disabled={busy || offlineNow || channel === null || body.trim() === ''}
              >
                {channel === 'whatsapp' ? 'Per WhatsApp senden' : 'Per E-Mail senden'}
              </button>
            </form>
          )}
        </div>
      )}
    </main>
  );
}

export default function CommunicationPage() {
  return (
    <AuthGuard>
      <CommunicationView />
    </AuthGuard>
  );
}
