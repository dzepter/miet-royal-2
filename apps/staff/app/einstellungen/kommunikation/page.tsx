'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard } from '../../../components/auth-guard';
import { OfflineActionHint, useOfflineNow } from '../../../components/communication';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import {
  checkSmtp,
  deliveryBadgeClass,
  fetchCommunicationStatus,
  fetchDeliveries,
  MAIL_DELIVERY_STATUS_FILTER,
  MAIL_GATEWAY_LABELS,
  mailCodeLabel,
  resendDelivery,
  smtpTlsLabel,
  WHATSAPP_MOCK_LABEL,
  WHATSAPP_MODE_LABELS,
  type CommunicationAdminStatus,
  type MailDeliveryStatus,
  type MailDeliverySummary,
} from '../../../lib/communication';
import { formatBerlin } from '../../../lib/handover';

/**
 * Einstellungen → Kommunikation (Phase 12, Order §35; Recht system.settings):
 * reine Statusseite – E-Mail (SMTP), Posteingang (IMAP), WhatsApp, Web Push
 * und die letzten Zustellungen mit „Erneut senden“. Hosts/Zugangsdaten sind
 * serverseitig konfiguriert und hier nicht änderbar; die API liefert nie
 * Passwörter, Token oder private Schlüssel.
 */

function Diagnose({ code, testId }: { code: string | null; testId: string }) {
  const label = mailCodeLabel(code);
  if (label === null) return null;
  return (
    <span data-testid={testId}>
      {label} <span className="muted">(Diagnosecode {code})</span>
    </span>
  );
}

function StatusBadge({ active, testId }: { active: boolean; testId: string }) {
  return (
    <span className={`badge ${active ? 'ok' : 'locked'}`} data-testid={testId}>
      {active ? 'aktiv' : 'inaktiv'}
    </span>
  );
}

function CommunicationSettings() {
  const offlineNow = useOfflineNow();
  const [status, setStatus] = useState<CommunicationAdminStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; code: string | null } | null>(null);
  const [filter, setFilter] = useState<MailDeliveryStatus | ''>('');
  const [deliveries, setDeliveries] = useState<MailDeliverySummary[] | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [resendTarget, setResendTarget] = useState<MailDeliverySummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    const result = await fetchCommunicationStatus();
    if (result.data !== null) {
      setStatus(result.data);
      setLoadError(null);
    } else {
      setLoadError(result.errorMessage ?? 'Kommunikationsstatus konnte nicht geladen werden.');
    }
  }, []);

  const loadDeliveries = useCallback(async () => {
    const result = await fetchDeliveries(filter);
    if (result.data !== null) {
      setDeliveries(result.data.deliveries);
      setDeliveryError(null);
    } else {
      setDeliveryError(result.errorMessage ?? 'Zustellungen konnten nicht geladen werden.');
    }
  }, [filter]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);
  useEffect(() => {
    void loadDeliveries();
  }, [loadDeliveries]);

  async function runCheck() {
    setBusy(true);
    setError(null);
    setNotice(null);
    setCheckResult(null);
    const result = await checkSmtp();
    setBusy(false);
    if (result.data === null) {
      setError(result.errorMessage ?? 'Die Prüfung ist fehlgeschlagen.');
      return;
    }
    setCheckResult({ ok: result.data.ok, code: result.data.code });
  }

  async function confirmResend() {
    if (resendTarget === null) return;
    const target = resendTarget;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await resendDelivery(target.id);
    setBusy(false);
    setResendTarget(null);
    if (!result.ok || result.data === null) {
      setError(result.errorMessage ?? 'Erneutes Senden fehlgeschlagen.');
      await loadDeliveries();
      return;
    }
    setNotice(
      result.data.status === 'pending'
        ? `${target.kindLabel}: neue Zustellung eingeplant.`
        : `${target.kindLabel}: neue Zustellung angelegt, Versand ist weiterhin blockiert.`,
    );
    await loadDeliveries();
  }

  const mail = status?.mail;
  const imap = status?.imap;
  const whatsappMode = status?.whatsapp.mode ?? 'disabled';
  const whatsappLabel =
    status?.whatsapp.label ?? (whatsappMode === 'mock' ? WHATSAPP_MOCK_LABEL : null);

  return (
    <main className="page" data-testid="comm-settings">
      <p>
        <Link href="/einstellungen">← Einstellungen</Link>
      </p>
      <h1>Kommunikation</h1>
      <p className="muted">
        Status von E-Mail, Posteingang, WhatsApp und Push. Zugangsdaten und Server liegen
        ausschließlich in der Serverkonfiguration und werden hier nie angezeigt.
      </p>
      {loadError !== null && <p className="error">{loadError}</p>}
      {error !== null && <p className="error">{error}</p>}
      {notice !== null && (
        <p className="success" data-testid="comm-notice">
          {notice}
        </p>
      )}
      <OfflineActionHint testId="comm-offline-hint" />

      {status !== null && mail !== undefined && (
        <div className="card" data-testid="comm-mail">
          <h2>E-Mail-Versand (SMTP)</h2>
          <p>
            Status: <StatusBadge active={mail.enabled} testId="comm-mail-status" /> · Versandweg:{' '}
            <span data-testid="comm-mail-gateway">
              {MAIL_GATEWAY_LABELS[mail.gateway] ?? 'Unbekannt'}
            </span>
          </p>
          <p className="muted">
            SMTP-Server: <span data-testid="comm-smtp-host">{mail.smtpHost ?? '–'}</span> · Port:{' '}
            <span data-testid="comm-smtp-port">{mail.smtpPort ?? '–'}</span> · Verschlüsselung:{' '}
            <span data-testid="comm-smtp-tls">{smtpTlsLabel(mail.smtpTls ?? null)}</span>
          </p>
          <p className="muted">
            Absender:{' '}
            <span data-testid="comm-mail-from">
              {mail.fromAddress === null
                ? '–'
                : `${mail.fromName ?? ''} <${mail.fromAddress}>`.trim()}
            </span>
            {mail.replyAddress !== null && <> · Antwortadresse: {mail.replyAddress}</>}
          </p>
          <p className="muted">
            Kundenlinks: {mail.publicWebBaseUrl ?? '– (nicht konfiguriert)'} · Demo-Whitelist:{' '}
            <span data-testid="comm-demo-whitelist-count">{mail.demoWhitelistCount}</span> Adressen
            {status.environment === 'demo'
              ? ' (Betreff immer mit [DEMO])'
              : ' (nur in der Demo-Umgebung wirksam)'}
          </p>
          <p>
            <button
              type="button"
              className="primary"
              data-testid="comm-smtp-check"
              disabled={busy || offlineNow}
              onClick={() => void runCheck()}
            >
              SMTP-Verbindung prüfen
            </button>
          </p>
          {checkResult !== null && (
            <p
              className={checkResult.ok ? 'success' : 'error'}
              role="status"
              data-testid="comm-smtp-check-result"
              data-ok={checkResult.ok ? 'true' : 'false'}
            >
              {checkResult.ok ? (
                'Verbindung zum Mailserver erfolgreich geprüft.'
              ) : (
                <>
                  Verbindung fehlgeschlagen:{' '}
                  <Diagnose code={checkResult.code} testId="comm-smtp-check-code" />
                  {checkResult.code === null && 'unbekannter Fehler.'}
                </>
              )}
            </p>
          )}
        </div>
      )}

      {status !== null && imap !== undefined && (
        <div className="card" data-testid="comm-imap">
          <h2>Posteingang (IMAP)</h2>
          <p>
            Status: <StatusBadge active={imap.configured} testId="comm-imap-status" />
            {imap.configured && (
              <span className="muted">
                {' '}
                · {imap.host ?? '–'} · Ordner {imap.folder ?? '–'}
              </span>
            )}
          </p>
          <p className="muted">
            Letzter Abruf:{' '}
            <span data-testid="comm-imap-last-poll">{formatBerlin(imap.lastPollAt)}</span> · Letzter
            erfolgreicher Abruf:{' '}
            <span data-testid="comm-imap-last-success">{formatBerlin(imap.lastSuccessAt)}</span>
          </p>
          {imap.lastErrorCode !== null && (
            <p className="error">
              Letzter Fehler: <Diagnose code={imap.lastErrorCode} testId="comm-imap-last-error" />
            </p>
          )}
        </div>
      )}

      {status !== null && (
        <div className="card" data-testid="comm-whatsapp">
          <h2>WhatsApp Business</h2>
          <p>
            Modus:{' '}
            <span
              className={`badge ${whatsappMode === 'live' ? 'ok' : whatsappMode === 'mock' ? '' : 'locked'}`}
              data-testid="comm-whatsapp-mode"
            >
              {WHATSAPP_MODE_LABELS[whatsappMode] ?? 'Unbekannt'}
            </span>{' '}
            {whatsappLabel !== null && (
              <span className="badge locked" data-testid="comm-whatsapp-label">
                {whatsappLabel}
              </span>
            )}
          </p>
          <p>
            Letzte Kundennachricht:{' '}
            <span data-testid="comm-whatsapp-last-inbound">
              {formatBerlin(status.whatsapp.lastInboundAt ?? null)}
            </span>{' '}
            · Ereignisse (24 h):{' '}
            <span data-testid="comm-whatsapp-events">{status.whatsapp.eventsLast24h ?? 0}</span> ·
            Offene Antwortfenster:{' '}
            <span data-testid="comm-whatsapp-open-windows">
              {status.whatsapp.contactsWithOpenWindow ?? 0}
            </span>
          </p>
          <p className="muted">
            Antworten sind nur innerhalb von 24 Stunden nach der letzten Kundennachricht frei
            möglich; automatische WhatsApp-Nachrichten gibt es nicht.
          </p>
        </div>
      )}

      {status !== null && (
        <div className="card" data-testid="comm-push">
          <h2>Push-Benachrichtigungen</h2>
          <p>
            Status: <StatusBadge active={status.push.enabled} testId="comm-push-status" /> ·
            VAPID-Schlüssel:{' '}
            <span data-testid="comm-push-vapid">
              {status.push.vapidPublicKey !== null ? 'hinterlegt' : 'nicht hinterlegt'}
            </span>{' '}
            · Aktive Pushgeräte:{' '}
            <strong data-testid="comm-push-devices">{status.push.activeDevices}</strong>
          </p>
          <p className="muted">
            Push aktiviert jede Person selbst unter{' '}
            <Link href="/einstellungen/benachrichtigungen">Benachrichtigungen</Link>.
          </p>
        </div>
      )}

      <div className="card" data-testid="comm-deliveries">
        <h2>Letzte Zustellungen</h2>
        <label htmlFor="comm-deliveries-filter">Status</label>
        <select
          id="comm-deliveries-filter"
          data-testid="comm-deliveries-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value as MailDeliveryStatus | '')}
        >
          {MAIL_DELIVERY_STATUS_FILTER.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {deliveryError !== null && <p className="error">{deliveryError}</p>}
        {deliveries !== null && deliveries.length === 0 && (
          <p className="muted" data-testid="comm-deliveries-empty">
            Keine Zustellungen{filter === '' ? '' : ' mit diesem Status'}.
          </p>
        )}
        {deliveries?.map((delivery) => (
          <div
            className="list-row"
            key={delivery.id}
            data-testid="comm-delivery-row"
            data-status={delivery.status}
            data-kind={delivery.kind}
          >
            <div style={{ flex: '1 1 16rem', minWidth: 0 }}>
              <strong>{delivery.kindLabel}</strong>{' '}
              <span className={`badge ${deliveryBadgeClass(delivery.status)}`}>
                {delivery.statusLabel}
              </span>
              <div className="muted" style={{ overflowWrap: 'anywhere' }}>
                {delivery.subject} · an{' '}
                {delivery.recipientEmail !== '' ? delivery.recipientEmail : '–'}
              </div>
              <div className="muted" style={{ fontSize: '0.85rem' }}>
                Angelegt {formatBerlin(delivery.createdAt)} · Versuche {delivery.attempts}
                {delivery.sentAt !== null && <> · gesendet {formatBerlin(delivery.sentAt)}</>}
                {delivery.status === 'retry' && delivery.nextAttemptAt !== null && (
                  <> · nächster Versuch {formatBerlin(delivery.nextAttemptAt)}</>
                )}
                {delivery.processId !== null && (
                  <>
                    {' '}
                    · <Link href={`/vorgaenge/${delivery.processId}`}>Vorgang</Link>
                  </>
                )}
              </div>
              {(delivery.blockedReason ?? delivery.lastErrorCode) !== null && (
                <div className="muted" style={{ fontSize: '0.85rem' }}>
                  <Diagnose
                    code={delivery.blockedReason ?? delivery.lastErrorCode}
                    testId="comm-delivery-reason"
                  />
                </div>
              )}
            </div>
            {delivery.resendable && (
              <button
                type="button"
                data-testid="comm-delivery-resend"
                disabled={busy || offlineNow}
                onClick={() => setResendTarget(delivery)}
              >
                Erneut senden
              </button>
            )}
          </div>
        ))}
      </div>

      {resendTarget !== null && (
        <ConfirmDialog
          testId="comm-resend-dialog"
          title="Erneut senden?"
          confirmLabel="Erneut senden"
          confirmTestId="comm-resend-confirm"
          busy={busy}
          disabled={offlineNow}
          maxWidth="28rem"
          onCancel={() => setResendTarget(null)}
          onConfirm={() => void confirmResend()}
        >
          <p>
            <strong>{resendTarget.kindLabel}</strong> an{' '}
            {resendTarget.recipientEmail !== '' ? resendTarget.recipientEmail : '–'} wird als neue
            Zustellung (neue Message-ID) erneut versendet.
          </p>
          {resendTarget.status === 'outcome_unknown' && (
            <p className="warning-red">
              Die bisherige Zustellung ist unklar – der Kunde hat die E-Mail eventuell schon
              erhalten und bekommt sie dann doppelt.
            </p>
          )}
        </ConfirmDialog>
      )}
    </main>
  );
}

export default function CommunicationSettingsPage() {
  return (
    <AuthGuard>
      <CommunicationSettings />
    </AuthGuard>
  );
}
