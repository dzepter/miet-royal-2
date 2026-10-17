'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard } from '../../components/auth-guard';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { apiFetch } from '../../lib/api';
import { formatBerlin } from '../../lib/handover';
import {
  checkConnection,
  confirmOrganization,
  fetchLexwareStatus,
  LEXWARE_NOT_CONFIGURED_HINT,
  LEXWARE_WEBHOOK_STATUS_LABELS,
  lexwareErrorLabel,
  lexwareStatusLabel,
  reconcile,
  setupWebhooks,
  type LexwareStatus,
} from '../../lib/lexware';

function SettingsView() {
  const [days, setDays] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void apiFetch<{ days: number }>('/staff/settings/completed-visibility').then((result) => {
      if (result.data !== null) setDays(String(result.data.days));
      else setError(result.errorMessage ?? 'Einstellungen konnten nicht geladen werden.');
    });
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const parsed = Number(days);
    const result = await apiFetch<{ days: number }>('/staff/settings/completed-visibility', {
      method: 'PUT',
      body: { days: parsed },
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Speichern fehlgeschlagen.');
      return;
    }
    setNotice('Gespeichert. Die Regel gilt sofort für Listen, Detailansicht und Suche.');
  }

  return (
    <main className="page">
      <h1>Einstellungen</h1>
      <div className="card">
        <h2>Sichtbarkeit abgeschlossener Vorgänge</h2>
        <p className="muted">
          So viele Tage nach Abschluss bleibt ein Vorgang für normale Mitarbeitende sichtbar. Danach
          sehen ihn nur noch Mitarbeitende mit dem Recht „Abgeschlossene Vorgänge ansehen“.
        </p>
        {error !== null && <p className="error">{error}</p>}
        {notice !== null && <p className="success">{notice}</p>}
        <form onSubmit={(e) => void save(e)}>
          <label htmlFor="s-days">Sichtbarkeitsfrist in Tagen</label>
          <input
            id="s-days"
            type="number"
            min={0}
            max={3650}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            required
          />
          <button className="primary" type="submit" disabled={busy || days === ''}>
            Speichern
          </button>
        </form>
      </div>
      <PickupSettings />
      <BaseUrlSettings />
      <LexwareSettings />
      <TermsSettings />
    </main>
  );
}

function BaseUrlSettings() {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void apiFetch<{ url: string | null }>('/staff/settings/staff-app-base-url').then((result) => {
      if (result.data !== null) setUrl(result.data.url ?? '');
      else setError(result.errorMessage ?? 'Einstellung konnte nicht geladen werden.');
    });
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await apiFetch<{ url: string | null }>('/staff/settings/staff-app-base-url', {
      method: 'PUT',
      body: { url: url.trim() === '' ? null : url.trim() },
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Speichern fehlgeschlagen.');
      return;
    }
    setUrl(result.data?.url ?? '');
    setNotice(
      (result.data?.url ?? null) === null
        ? 'Basis-URL entfernt – QR-Codes zeigen nur den Identifier.'
        : 'Gespeichert. QR-Codes verlinken jetzt auf diese Basis-URL.',
    );
  }

  return (
    <div className="card">
      <h2>Staff-App-Basis-URL (QR-Codes)</h2>
      <p className="muted">
        Absolute Adresse der Mitarbeiter-App (z. B. https://staff.example.de). Sie wird
        ausschließlich für druckbare Maschinen-QR-Codes verwendet – ohne Konfiguration wird bewusst
        keine Live-URL erfunden.
      </p>
      {error !== null && <p className="error">{error}</p>}
      {notice !== null && <p className="success">{notice}</p>}
      <form onSubmit={(e) => void save(e)}>
        <label htmlFor="s-base-url">Basis-URL (leer = nicht konfiguriert)</label>
        <input
          id="s-base-url"
          type="text"
          placeholder="https://staff.example.de"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button className="primary" type="submit" disabled={busy}>
          Speichern
        </button>
      </form>
    </div>
  );
}

function PickupSettings() {
  const [publicArea, setPublicArea] = useState('');
  const [exactAddress, setExactAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void apiFetch<{ publicArea: string; exactAddress: string | null }>(
      '/staff/settings/pickup',
    ).then((result) => {
      if (result.data !== null) {
        setPublicArea(result.data.publicArea);
        setExactAddress(result.data.exactAddress ?? '');
      }
    });
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await apiFetch('/staff/settings/pickup', {
      method: 'PUT',
      body: {
        publicArea: publicArea.trim() === '' ? null : publicArea,
        exactAddress: exactAddress.trim() === '' ? null : exactAddress,
      },
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Speichern fehlgeschlagen.');
      return;
    }
    setNotice('Gespeichert.');
  }

  return (
    <div className="card">
      <h2>Abholung</h2>
      <p className="muted">
        Öffentlich sichtbar ist nur die Abholregion. Die exakte Abholadresse erscheint erst in der
        Auftragsbestätigung nach bestätigter Buchung – ohne konfigurierte Adresse wird die Freigabe
        einer Selbstabhol-AB blockiert.
      </p>
      {error !== null && <p className="error">{error}</p>}
      {notice !== null && <p className="success">{notice}</p>}
      <form onSubmit={(e) => void save(e)}>
        <label htmlFor="pk-area">Öffentliche Abholregion</label>
        <input id="pk-area" value={publicArea} onChange={(e) => setPublicArea(e.target.value)} />
        <label htmlFor="pk-exact">Exakte Abholadresse (nicht öffentlich)</label>
        <input
          id="pk-exact"
          value={exactAddress}
          onChange={(e) => setExactAddress(e.target.value)}
          placeholder="Noch nicht konfiguriert"
        />
        <button className="primary" type="submit" disabled={busy}>
          Speichern
        </button>
      </form>
    </div>
  );
}

function TermsSettings() {
  const [terms, setTerms] = useState<
    { id: string; label: string; isTest: boolean; createdAt: string }[]
  >([]);
  const [label, setLabel] = useState('');
  const [content, setContent] = useState('');
  const [isTest, setIsTest] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await apiFetch<{
      terms: { id: string; label: string; isTest: boolean; createdAt: string }[];
    }>('/staff/terms');
    if (result.data !== null) setTerms(result.data.terms);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await apiFetch('/staff/terms', {
      method: 'POST',
      body: { label, content, isTest },
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Anlegen fehlgeschlagen.');
      return;
    }
    setLabel('');
    setContent('');
    await load();
  }

  return (
    <div className="card">
      <h2>Mietbedingungen (versioniert)</h2>
      <p className="muted">
        Der endgültige Rechtstext liegt noch nicht vor – es werden keine Rechtstexte erfunden.
        Test-Platzhalter müssen als TEST markiert sein und werden in Production niemals versendet.
      </p>
      {error !== null && <p className="error">{error}</p>}
      {terms.map((version) => (
        <div className="list-row" key={version.id}>
          <span>
            {version.label} {version.isTest && <span className="badge locked">TEST</span>}
          </span>
          <span className="muted">{new Date(version.createdAt).toLocaleDateString('de-DE')}</span>
        </div>
      ))}
      <form onSubmit={(e) => void create(e)}>
        <label htmlFor="t-label">Label (neue Version)</label>
        <input id="t-label" value={label} onChange={(e) => setLabel(e.target.value)} />
        <label htmlFor="t-content">Inhalt</label>
        <textarea
          id="t-content"
          rows={4}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        <label className="perm-item" style={{ display: 'inline-flex' }}>
          <input type="checkbox" checked={isTest} onChange={(e) => setIsTest(e.target.checked)} />
          <span>Test-Platzhalter (kein echter Rechtstext)</span>
        </label>
        <p>
          <button
            className="primary"
            type="submit"
            disabled={busy || label === '' || content === ''}
          >
            Version anlegen
          </button>
        </p>
      </form>
    </div>
  );
}

/**
 * Phase 10 (Order §8): Einstellungen → Lexware. Zeigt Verbindungsstatus,
 * Firma, gekürzte Organisations-ID, Steuer- und Webhook-Status sowie die
 * letzte erfolgreiche Prüfung. Der API-Key wird nie geliefert oder gezeigt;
 * Konfiguration erfolgt ausschließlich serverseitig. Kein Dashboard.
 */
function LexwareSettings() {
  const [status, setStatus] = useState<LexwareStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOrg, setConfirmOrg] = useState(false);

  const load = useCallback(async () => {
    const result = await fetchLexwareStatus();
    if (result.data !== null) {
      setStatus(result.data);
      setLoadFailed(false);
    } else {
      setLoadFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function run<T>(
    action: () => Promise<{ ok: boolean; data: T | null; errorMessage: string | null }>,
    okText: (data: T) => string,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await action();
    setBusy(false);
    if (!result.ok || result.data === null) {
      setError(result.errorMessage ?? 'Aktion fehlgeschlagen – bitte später erneut versuchen.');
      await load();
      return;
    }
    setNotice(okText(result.data));
    await load();
  }

  const active = status !== null && status.configured && status.enabled;
  const connectionStatus = status?.status ?? 'not_configured';
  const webhookStatus = status?.webhooks?.status ?? null;
  const errorText = lexwareErrorLabel(status?.lastErrorCode);
  const reminder = status?.apiKeyReminderDate ?? null;

  return (
    <div className="card" data-testid="lexware-section">
      <h2>Lexware (Buchhaltung)</h2>
      <p className="muted">
        Rechnungen werden nach der Abrechnung in Lexware Office erstellt. Der API-Key liegt
        ausschließlich serverseitig und wird hier nie angezeigt. Rechnungen werden nicht automatisch
        versendet – der Versand bleibt ausstehend.
      </p>
      {error !== null && <p className="error">{error}</p>}
      {notice !== null && <p className="success">{notice}</p>}
      {loadFailed && status === null && (
        <p className="error">Lexware-Status konnte nicht geladen werden.</p>
      )}
      <p>
        Status:{' '}
        <span
          className={`badge ${
            connectionStatus === 'connected' && active
              ? 'ok'
              : active && connectionStatus !== 'incomplete'
                ? 'locked'
                : ''
          }`}
          data-testid="lexware-status"
        >
          {lexwareStatusLabel(status)}
        </span>
        {errorText !== null && active && <span className="muted"> – {errorText}</span>}
      </p>
      {!active && (
        <p className="muted" data-testid="lexware-not-configured">
          {LEXWARE_NOT_CONFIGURED_HINT}
        </p>
      )}
      {active && (
        <>
          {connectionStatus === 'organization_mismatch' && (
            <p className="warning-red" role="status">
              Die Lexware-Organisation hat sich geändert. Übertragungen sind gestoppt, bis die neue
              Organisation ausdrücklich bestätigt wird.
            </p>
          )}
          <p>
            Firma: <span data-testid="lexware-company">{status?.companyName ?? '–'}</span>
            <span className="muted">
              {' '}
              · Organisation:{' '}
              <span data-testid="lexware-org">{status?.organizationIdShort ?? '–'}</span>
            </span>
          </p>
          <p>
            Steuerkonfiguration:{' '}
            <span
              className={`badge ${status?.taxConfigComplete === true ? 'ok' : 'locked'}`}
              data-testid="lexware-tax-status"
            >
              {status?.taxConfigComplete === true ? 'vollständig' : 'unvollständig'}
            </span>{' '}
            Webhooks:{' '}
            <span
              className={`badge ${webhookStatus === 'configured' ? 'ok' : ''}`}
              data-testid="lexware-webhook-status"
            >
              {webhookStatus !== null
                ? (LEXWARE_WEBHOOK_STATUS_LABELS[webhookStatus] ?? 'Nicht eingerichtet')
                : 'Nicht eingerichtet'}
            </span>
          </p>
          <p className="muted">
            Letzte erfolgreiche Prüfung:{' '}
            <span data-testid="lexware-last-check">
              {formatBerlin(status?.lastSuccessAt ?? null)}
            </span>
            {status?.lastCheckedAt !== undefined &&
            status.lastCheckedAt !== null &&
            status.lastCheckedAt !== status.lastSuccessAt
              ? ` (zuletzt geprüft ${formatBerlin(status.lastCheckedAt)})`
              : ''}
          </p>
          {reminder !== null && (
            <p className="muted" data-testid="lexware-key-reminder">
              Erinnerung API-Key-Erneuerung: {new Date(reminder).toLocaleDateString('de-DE')}
            </p>
          )}
          <p>
            <button
              type="button"
              className="primary"
              data-testid="lexware-check-connection"
              disabled={busy}
              onClick={() =>
                void run(
                  checkConnection,
                  (next) => `Verbindung geprüft: ${lexwareStatusLabel(next)}.`,
                )
              }
            >
              Verbindung prüfen
            </button>{' '}
            <button
              type="button"
              data-testid="lexware-setup-webhooks"
              disabled={busy}
              onClick={() =>
                void run(setupWebhooks, (r) => {
                  const created = r.created?.length ?? 0;
                  const existing = r.existing?.length ?? 0;
                  const failed = r.failed?.length ?? 0;
                  return `Webhooks geprüft: ${created} neu, ${existing} vorhanden${
                    failed > 0 ? `, ${failed} fehlgeschlagen` : ''
                  }.`;
                })
              }
            >
              Webhooks einrichten/prüfen
            </button>{' '}
            <button
              type="button"
              data-testid="lexware-reconcile"
              disabled={busy}
              onClick={() =>
                void run(
                  reconcile,
                  (r) =>
                    `Zahlungsstatus abgeglichen: ${r.checked ?? 0} geprüft, ${r.updated ?? 0} aktualisiert${
                      (r.attention ?? 0) > 0 ? `, ${r.attention} mit Prüfbedarf` : ''
                    }.`,
                )
              }
            >
              Zahlungsstatus abgleichen
            </button>{' '}
            <Link href="/einstellungen/steuern" data-testid="lexware-open-tax-config">
              Steuerkonfiguration öffnen
            </Link>
          </p>
          {connectionStatus === 'organization_mismatch' && (
            <p>
              <button
                type="button"
                className="danger"
                data-testid="lexware-confirm-organization"
                disabled={busy || (status?.pendingOrganizationId ?? null) === null}
                onClick={() => setConfirmOrg(true)}
              >
                Organisation bestätigen
              </button>
            </p>
          )}
        </>
      )}
      {confirmOrg && status !== null && status.pendingOrganizationId !== undefined && (
        <ConfirmDialog
          testId="lexware-confirm-organization-dialog"
          title="Neue Lexware-Organisation bestätigen?"
          confirmLabel="Organisation bestätigen"
          confirmTestId="lexware-confirm-organization-confirm"
          busy={busy}
          danger
          onCancel={() => setConfirmOrg(false)}
          onConfirm={() => {
            const pending = status.pendingOrganizationId ?? null;
            setConfirmOrg(false);
            if (pending === null) return;
            void run(
              () => confirmOrganization(pending),
              () => 'Organisation bestätigt – Übertragungen sind wieder möglich.',
            );
          }}
        >
          <p>
            Künftige Rechnungen werden in der Organisation{' '}
            <strong>{(status.pendingOrganizationId ?? '').slice(0, 8)}…</strong> erstellt. Bestätige
            nur, wenn der API-Key bewusst auf diese Organisation umgestellt wurde.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <AuthGuard>
      <SettingsView />
    </AuthGuard>
  );
}
