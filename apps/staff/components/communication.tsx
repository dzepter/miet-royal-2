'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { hasPermission, type Me } from '../lib/api';
import {
  CONTACT_KIND_LABELS,
  deliveryBadgeClass,
  fetchCustomerContacts,
  fetchProcessCommunicationStatus,
  messagePhotoPath,
  sendVoucherNow,
  sortDeliveriesByKind,
  VOUCHER_NO_EMAIL_TEXT,
  voucherProblemText,
  type ConversationPhoto,
  type CustomerContact,
  type ProcessCommunicationStatus,
} from '../lib/communication';
import type { VoucherSummary } from '../lib/crm';
import { formatBerlin } from '../lib/handover';
import { ONLINE_REQUIRED_MESSAGE } from '../lib/offline/router';
import { useOffline } from '../lib/offline/provider';
import { ConfirmDialog } from './confirm-dialog';

/**
 * Phase 12 (UI): gemeinsame Bausteine der Kommunikationsbereiche.
 * Kommunikationsaktionen sind Online-Aktionen: ohne Verbindung sind sie
 * deaktiviert und zeigen denselben Hinweis wie der Offline-Router
 * (ONLINE_REQUIRED) – serverseitig bleibt die Prüfung unverändert.
 */

/** true, solange die App laut Offline-Laufzeit keine Serververbindung hat. */
export function useOfflineNow(): boolean {
  const offline = useOffline();
  return offline?.state.connectivity === 'offline';
}

export function OfflineActionHint({ testId }: { testId: string }) {
  const offlineNow = useOfflineNow();
  if (!offlineNow) return null;
  return (
    <div className="offline-banner" role="status" data-testid={testId}>
      {ONLINE_REQUIRED_MESSAGE}
    </div>
  );
}

/**
 * Foto einer Kundennachricht: Bytes per fetch mit Session-Cookie (Sichtbarkeit
 * prüft die API), Anzeige nur als Blob-URL im Speicher dieses Tabs – kein
 * direkter <img src> auf die API, kein Cache. Gelöschte Fotos (Retention)
 * erscheinen als Hinweis.
 */
export function MessagePhotoThumb({
  messageId,
  photo,
  index,
}: {
  messageId: string;
  photo: ConversationPhoto;
  index: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (photo.deleted) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    setFailed(false);
    void fetch(messagePhotoPath(messageId, photo.id), {
      credentials: 'same-origin',
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('photo');
        const blob = await response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [messageId, photo.id, photo.deleted]);

  if (photo.deleted) {
    return (
      <span className="badge" data-testid="conversation-photo-deleted">
        Foto gemäß Aufbewahrungsfrist gelöscht
      </span>
    );
  }
  if (failed) {
    return (
      <span className="badge" data-testid="conversation-photo-unavailable">
        Foto nicht verfügbar
      </span>
    );
  }
  if (url === null) {
    return <span className="badge">Foto wird geladen …</span>;
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" data-testid="conversation-photo-link">
      {/* Blob-URL aus geprüfter API-Antwort (JPEG/PNG/WebP) – kein externes Bild. */}
      <img
        className="photo-thumb"
        src={url}
        alt={`Foto ${index + 1} der Kundennachricht`}
        data-testid="conversation-photo"
      />
    </a>
  );
}

/**
 * Kompakter Kommunikationsstatus im Vorgangsüberblick (Order §35): je Mailart
 * die letzte Zustellung („Angebot – E-Mail gesendet“ …; Labels aus der API),
 * aktueller Abholperson-/Lieferkontakt aus dem Kunden-Aktionslink und der
 * Einstieg in „Kommunikation“.
 */
export function ProcessCommunicationCard({ processId }: { processId: string }) {
  const [status, setStatus] = useState<ProcessCommunicationStatus | null>(null);
  const [contacts, setContacts] = useState<CustomerContact[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    const [statusResult, contactResult] = await Promise.all([
      fetchProcessCommunicationStatus(processId),
      fetchCustomerContacts(processId),
    ]);
    if (statusResult.data !== null) {
      setStatus(statusResult.data);
      setLoadFailed(false);
    } else {
      setLoadFailed(true);
    }
    if (contactResult.data !== null) setContacts(contactResult.data.contacts);
  }, [processId]);
  useEffect(() => {
    void load();
  }, [load]);

  const deliveries = status === null ? [] : sortDeliveriesByKind(status.deliveries);

  return (
    <div className="card" data-testid="process-communication">
      <h2>Kommunikation</h2>
      {loadFailed && status === null && (
        <p className="muted">Kommunikationsstatus derzeit nicht verfügbar.</p>
      )}
      {status !== null && !status.mailConfigured && (
        <p className="muted" data-testid="communication-mail-not-configured">
          E-Mail-Versand ist in dieser Umgebung nicht konfiguriert – Mails bleiben im Status
          „Versand blockiert“.
        </p>
      )}
      {status !== null && deliveries.length === 0 && (
        <p className="muted" data-testid="communication-status-empty">
          Noch keine E-Mails zu diesem Vorgang.
        </p>
      )}
      {deliveries.map((delivery) => (
        <div
          className="list-row"
          key={delivery.id}
          data-testid="communication-status-row"
          data-kind={delivery.kind}
          data-status={delivery.status}
        >
          <span>
            <strong>{delivery.kindLabel}</strong> –{' '}
            <span className={`badge ${deliveryBadgeClass(delivery.status)}`}>
              {delivery.statusLabel}
            </span>
          </span>
          <span className="muted">
            {delivery.sentAt !== null
              ? formatBerlin(delivery.sentAt)
              : delivery.status === 'retry' && delivery.nextAttemptAt !== null
                ? `nächster Versuch ${formatBerlin(delivery.nextAttemptAt)}`
                : formatBerlin(delivery.updatedAt)}
          </span>
        </div>
      ))}
      {contacts.map((contact) => (
        <p
          className="muted"
          key={contact.kind}
          data-testid="process-customer-contact"
          data-kind={contact.kind}
        >
          {CONTACT_KIND_LABELS[contact.kind]}:{' '}
          <strong>
            {contact.firstName} {contact.lastName}
          </strong>{' '}
          · <a href={`tel:${contact.phone}`}>{contact.phone}</a>{' '}
          <span className="muted">(vom Kunden angegeben, {formatBerlin(contact.updatedAt)})</span>
        </p>
      ))}
      <p>
        <Link
          href={`/vorgaenge/${processId}/kommunikation`}
          data-testid="process-communication-open"
        >
          <strong>Nachrichten öffnen</strong>
        </Link>
      </p>
    </div>
  );
}

/**
 * Versandzustand des Wiedermieter-Gutscheins (Order §15): Problemtext (z. B.
 * keine E-Mail-Adresse) und die bewusste Staff-Aktion „Gutschein jetzt senden“
 * (nur mit `customer.view` + `email.approve_prepared`, wenn der Server
 * `canSendNow` meldet). Nie Klartext-Code – nur die maskierte Referenz.
 */
export function VoucherDeliveryActions({
  customerId,
  voucher,
  me,
  testIdPrefix,
  onChanged,
}: {
  customerId: string;
  voucher: VoucherSummary;
  me: Me | null;
  testIdPrefix: string;
  onChanged: () => Promise<void>;
}) {
  const offlineNow = useOfflineNow();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (voucher.deliveryStatus !== 'pending') return null;
  // Manuelles Senden nur nach einem Versandproblem (z. B. zunächst keine E-Mail-Adresse);
  // im Normalfall sendet der Server automatisch. Unlesbare Versandkopie ⇒ zwecklos.
  const problemCode = voucher.deliveryProblemCode ?? null;
  const canSendNow =
    voucher.canSendNow === true &&
    problemCode !== null &&
    problemCode !== 'DELIVERY_COPY_UNDECRYPTABLE';
  const mayApprove =
    hasPermission(me, 'customer.view') && hasPermission(me, 'email.approve_prepared');
  const problem =
    problemCode === 'NO_EMAIL' && canSendNow
      ? 'Gutschein erstellt – noch nicht per E-Mail versendet (E-Mail-Adresse inzwischen vorhanden).'
      : problemCode === 'NO_EMAIL'
        ? VOUCHER_NO_EMAIL_TEXT
        : voucherProblemText(problemCode);

  async function send() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await sendVoucherNow(customerId, voucher.id);
    setBusy(false);
    setConfirming(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Der Gutschein konnte nicht gesendet werden.');
      await onChanged();
      return;
    }
    setNotice(
      'Versand eingeplant – der Gutschein gilt erst nach erfolgreichem E-Mail-Versand als versendet.',
    );
    await onChanged();
  }

  if (problem === null && !(canSendNow && mayApprove) && error === null && notice === null) {
    return null;
  }

  return (
    <div data-testid={`${testIdPrefix}-delivery-actions`}>
      {problem !== null && (
        <p className="muted" data-testid={`${testIdPrefix}-delivery-problem`}>
          {problem}
        </p>
      )}
      {error !== null && <p className="error">{error}</p>}
      {notice !== null && (
        <p className="success" data-testid={`${testIdPrefix}-send-notice`}>
          {notice}
        </p>
      )}
      {canSendNow && mayApprove && notice === null && (
        <>
          <OfflineActionHint testId={`${testIdPrefix}-send-offline`} />
          <p>
            <button
              type="button"
              data-testid={`${testIdPrefix}-send-now`}
              disabled={busy || offlineNow}
              onClick={() => setConfirming(true)}
            >
              Gutschein jetzt senden
            </button>
          </p>
        </>
      )}
      {confirming && (
        <ConfirmDialog
          testId={`${testIdPrefix}-send-dialog`}
          title="Gutschein jetzt senden?"
          confirmLabel="Gutschein jetzt senden"
          confirmTestId={`${testIdPrefix}-send-confirm`}
          busy={busy}
          disabled={offlineNow}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void send()}
        >
          <p>
            Der Kunde erhält den 20-%-Wiedermieter-Gutschein per E-Mail an die hinterlegte Adresse.
            Der Code steht nur in dieser E-Mail und ist hier nie sichtbar.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
