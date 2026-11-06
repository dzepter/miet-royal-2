'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PHOTO_MAX_COUNT,
  PHOTO_MIME_TYPES,
  PORTAL_MESSAGES,
  PORTAL_UI,
  base64FromDataUrl,
  formatDateTime,
  isPortalPhotoMimeType,
  isUnauthenticated,
  portalErrorMessage,
  portalFetch,
  portalPhotoHref,
  validatePhotoSelection,
  type PortalMessageInput,
  type PortalMessageListResponse,
  type PortalMessagePhoto,
  type PortalMessageView,
} from '../lib/portal';
import {
  ErrorBox,
  InfoBox,
  SectionTitle,
  card,
  inputStyle,
  labelStyle,
  mutedStyle,
  primaryButton,
} from './portal-ui';

/**
 * Portalnachrichten (Order §25–§27; Design §3.1/§5): Liste der Nachrichten
 * des Kanals „portal“ (eigene vs. Miet-Royal), Formular Text + bis zu 5
 * Bilder (JPEG/PNG/WebP, je ≤ 8 MB, Base64 im JSON-Body). Fotos werden mit
 * Cookie über denselben Origin als Blob-URL geladen (private Bytes, no-store).
 * `canSend=false` ⇒ Hinweis BOOKING_CLOSED, kein Formular. Neue Antworten von
 * Miet-Royal erscheinen über ein leichtes Polling (30 s, nur sichtbarer Tab).
 */

export const MESSAGES_POLL_MS = 30_000;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsDataURL(file);
  });
}

function PhotoThumb({
  bookingId,
  messageId,
  photo,
}: {
  bookingId: string;
  messageId: string;
  photo: PortalMessagePhoto;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (photo.deleted) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const response = await fetch(portalPhotoHref(bookingId, messageId, photo.id), {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('photo unavailable');
        const blob = await response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [bookingId, messageId, photo.id, photo.deleted]);

  if (photo.deleted) {
    return (
      <span
        style={{ ...mutedStyle, fontSize: '0.85rem' }}
        data-testid="portal-message-photo-deleted"
      >
        Foto nicht mehr verfügbar
      </span>
    );
  }
  if (failed) {
    return (
      <span style={{ ...mutedStyle, fontSize: '0.85rem' }}>Foto konnte nicht geladen werden</span>
    );
  }
  if (url === null) {
    return (
      <span
        aria-label="Foto wird geladen"
        style={{
          display: 'inline-block',
          width: 96,
          height: 96,
          background: '#eee',
          borderRadius: 6,
        }}
      />
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" data-testid="portal-message-photo-link">
      <img
        src={url}
        alt="Foto zur Nachricht"
        data-testid="portal-message-photo-image"
        style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 6, display: 'block' }}
      />
    </a>
  );
}

export function PortalMessages({
  bookingId,
  onUnauthenticated,
}: {
  bookingId: string;
  onUnauthenticated: () => void;
}) {
  const [messages, setMessages] = useState<PortalMessageView[] | null>(null);
  const [canSend, setCanSend] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(
    async (silent: boolean) => {
      try {
        const response = await portalFetch<PortalMessageListResponse>(
          `/bookings/${encodeURIComponent(bookingId)}/messages`,
        );
        setMessages(Array.isArray(response?.messages) ? response.messages : []);
        setCanSend(response?.canSend === true);
        setLoadError(null);
      } catch (caught) {
        if (isUnauthenticated(caught)) {
          onUnauthenticated();
          return;
        }
        if (!silent) setLoadError(portalErrorMessage(caught));
      }
    },
    [bookingId, onUnauthenticated],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, MESSAGES_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  function onFilesChanged(list: FileList | null) {
    const selected = list === null ? [] : Array.from(list);
    const problem = validatePhotoSelection(selected);
    setFileError(problem);
    setFiles(problem === null ? selected : []);
    if (problem !== null && fileInput.current !== null) fileInput.current.value = '';
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const text = body.trim();
    if (text === '') {
      setSendError('Bitte gib eine Nachricht ein.');
      return;
    }
    setBusy(true);
    setSendError(null);
    try {
      const photos: NonNullable<PortalMessageInput['photos']> = [];
      for (const file of files) {
        if (!isPortalPhotoMimeType(file.type)) throw new Error(PORTAL_UI.PHOTO_REJECTED);
        const dataBase64 = base64FromDataUrl(await readAsDataUrl(file));
        if (dataBase64 === null) throw new Error(PORTAL_UI.PHOTO_REJECTED);
        photos.push({ mimeType: file.type, dataBase64 });
      }
      const input: PortalMessageInput = photos.length > 0 ? { body: text, photos } : { body: text };
      const created = await portalFetch<PortalMessageView>(
        `/bookings/${encodeURIComponent(bookingId)}/messages`,
        { method: 'POST', body: input },
      );
      setBody('');
      setFiles([]);
      if (fileInput.current !== null) fileInput.current.value = '';
      if (created !== undefined && created !== null && typeof created.id === 'string') {
        setMessages((current) =>
          current === null || current.some((m) => m.id === created.id)
            ? current
            : [...current, created],
        );
      }
      await load(true);
    } catch (caught) {
      if (isUnauthenticated(caught)) {
        onUnauthenticated();
        return;
      }
      setSendError(
        caught instanceof Error && !('status' in caught)
          ? caught.message
          : portalErrorMessage(caught),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={card} data-testid="portal-messages" aria-labelledby="portal-messages-title">
      <h2 id="portal-messages-title" style={{ marginTop: 0, fontSize: '1.1rem' }}>
        Nachrichten
      </h2>
      <p style={{ ...mutedStyle, marginTop: 0 }}>
        Hier kannst du uns direkt zu dieser Buchung schreiben – auch mit Fotos. Wir antworten dir
        hier und informieren dich zusätzlich per E-Mail.
      </p>

      {loadError !== null && <ErrorBox message={loadError} testId="portal-messages-error" />}

      {messages === null ? (
        <p style={mutedStyle}>Nachrichten werden geladen …</p>
      ) : messages.length === 0 ? (
        <p style={mutedStyle} data-testid="portal-messages-empty">
          Noch keine Nachrichten zu dieser Buchung.
        </p>
      ) : (
        <ol
          style={{ listStyle: 'none', padding: 0, margin: '0 0 1rem' }}
          aria-label="Nachrichtenverlauf"
        >
          {messages.map((message) => {
            const own = message.from === 'customer';
            return (
              <li
                key={message.id}
                data-testid="portal-message-item"
                data-from={message.from}
                style={{
                  margin: '0.5rem 0',
                  padding: '0.6rem 0.8rem',
                  borderRadius: 8,
                  border: `1px solid ${own ? '#c5d8c7' : '#c9d6ea'}`,
                  background: own ? '#f1f8e9' : '#eef3fb',
                  marginLeft: own ? '15%' : 0,
                  marginRight: own ? 0 : '15%',
                }}
              >
                <p style={{ margin: '0 0 0.25rem', fontSize: '0.85rem', ...mutedStyle }}>
                  <strong>{own ? 'Du' : 'Miet-Royal'}</strong> · {formatDateTime(message.createdAt)}
                </p>
                <p style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {message.bodyDeleted ? (
                    <em style={mutedStyle}>Nachricht nicht mehr verfügbar</em>
                  ) : (
                    message.body
                  )}
                </p>
                {message.photos.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '0.5rem',
                      marginTop: '0.5rem',
                    }}
                  >
                    {message.photos.map((photo) => (
                      <PhotoThumb
                        key={photo.id}
                        bookingId={bookingId}
                        messageId={message.id}
                        photo={photo}
                      />
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {messages !== null && !canSend && (
        <InfoBox tone="info" testId="portal-messages-closed">
          {PORTAL_MESSAGES.BOOKING_CLOSED}
        </InfoBox>
      )}

      {messages !== null && canSend && (
        <form onSubmit={(e) => void send(e)} data-testid="portal-message-form">
          <SectionTitle>Neue Nachricht</SectionTitle>
          <label htmlFor="portal-message-body" style={labelStyle}>
            Deine Nachricht
          </label>
          <textarea
            id="portal-message-body"
            data-testid="portal-message-body"
            style={{ ...inputStyle, minHeight: '6rem', resize: 'vertical', fontFamily: 'inherit' }}
            maxLength={5000}
            required
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <label htmlFor="portal-message-photo" style={labelStyle}>
            Fotos (optional, bis zu {PHOTO_MAX_COUNT} Bilder, JPEG/PNG/WebP, je max. 8 MB)
          </label>
          <input
            id="portal-message-photo"
            data-testid="portal-message-photo"
            ref={fileInput}
            type="file"
            accept={PHOTO_MIME_TYPES.join(',')}
            multiple
            onChange={(e) => onFilesChanged(e.target.files)}
            style={{ margin: '0.25rem 0 0.9rem', display: 'block' }}
          />
          {files.length > 0 && (
            <p
              style={{ ...mutedStyle, fontSize: '0.9rem' }}
              data-testid="portal-message-photo-count"
            >
              {files.length} {files.length === 1 ? 'Bild' : 'Bilder'} ausgewählt
            </p>
          )}
          {fileError !== null && (
            <ErrorBox message={fileError} testId="portal-message-photo-error" />
          )}
          {sendError !== null && <ErrorBox message={sendError} testId="portal-message-error" />}
          <button
            type="submit"
            disabled={busy}
            style={primaryButton(busy)}
            data-testid="portal-message-send"
          >
            {busy ? 'Wird gesendet …' : 'Nachricht senden'}
          </button>
        </form>
      )}
    </section>
  );
}
