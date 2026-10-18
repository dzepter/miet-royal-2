'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard } from '../../../components/auth-guard';
import {
  fetchPushDevices,
  fetchPushStatus,
  subscribeToPush,
  unsubscribeFromPush,
  type PushDevice,
  type PushStatus,
} from '../../../lib/push';

/**
 * Einstellungen → Benachrichtigungen (Phase 12, Order §29): Push auf DIESEM
 * Gerät aktivieren/deaktivieren – nur nach Klick (Berechtigungsabfrage des
 * Browsers) – und die eigenen registrierten Geräte sehen. Für jede
 * angemeldete Person, kein Admin-Recht nötig.
 */
function formatDate(value: string | null): string {
  if (value === null) return '–';
  return new Date(value).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
}

function NotificationSettings() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [nextStatus, nextDevices] = await Promise.all([fetchPushStatus(), fetchPushDevices()]);
    setStatus(nextStatus);
    setDevices(nextDevices);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function enable() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const outcome = await subscribeToPush();
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    setNotice('Push ist auf diesem Gerät aktiv.');
    await load();
  }

  async function disable() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const ok = await unsubscribeFromPush();
    setBusy(false);
    if (!ok) {
      setError('Push konnte nicht deaktiviert werden.');
      return;
    }
    setNotice('Push ist auf diesem Gerät deaktiviert.');
    await load();
  }

  return (
    <main className="page">
      <h1>Benachrichtigungen</h1>
      <p className="muted">
        <Link href="/konto">← Mein Konto</Link>
      </p>
      <div className="card">
        <h2>Push auf diesem Gerät</h2>
        <p className="muted">
          Kurze Hinweise zu Terminen (1 Stunde vorher), Vertretungen und – für Planung/Admin –
          überfälligen Rückgaben, Maschinenkonflikten und neuen Anmeldungen. Die Nachrichten
          enthalten nur die Vorgangsnummer, nie Kundendaten.
        </p>
        {status === null && <p className="muted">Wird geladen …</p>}
        {status !== null && !status.supported && (
          <p className="error">Dieser Browser unterstützt keine Push-Benachrichtigungen.</p>
        )}
        {status !== null && status.supported && !status.serverEnabled && (
          <p className="error">Push ist auf diesem Server nicht konfiguriert.</p>
        )}
        {status?.permission === 'denied' && (
          <p className="error">
            Benachrichtigungen sind im Browser blockiert. Bitte in den Seiteneinstellungen erlauben.
          </p>
        )}
        {error !== null && <p className="error">{error}</p>}
        {notice !== null && <p className="success">{notice}</p>}
        {status !== null && status.supported && status.serverEnabled && !status.active && (
          <button
            className="primary"
            type="button"
            data-testid="push-enable"
            disabled={busy || status.permission === 'denied'}
            onClick={() => void enable()}
          >
            Push auf diesem Gerät aktivieren
          </button>
        )}
        {status !== null && status.active && (
          <button
            type="button"
            data-testid="push-disable"
            disabled={busy}
            onClick={() => void disable()}
          >
            Push auf diesem Gerät deaktivieren
          </button>
        )}
      </div>
      <div className="card">
        <h2>Meine Push-Geräte</h2>
        <div data-testid="push-device-list">
          {devices.length === 0 && <p className="muted">Keine Geräte registriert.</p>}
          {devices.map((device) => (
            <div className="list-row" key={device.id}>
              <div>
                {device.userAgentLabel ?? 'Unbekanntes Gerät'}
                {device.currentSession && <span className="badge active"> dieses Gerät</span>}
                <div className="muted">
                  Registriert: {formatDate(device.createdAt)} · Letzter Erfolg:{' '}
                  {formatDate(device.lastSuccessAt)}
                </div>
              </div>
            </div>
          ))}
        </div>
        <p className="muted">
          Abmelden eines Geräts (unter „Mein Konto“) beendet auch dessen Push-Benachrichtigungen.
        </p>
      </div>
    </main>
  );
}

export default function NotificationSettingsPage() {
  return (
    <AuthGuard>
      <NotificationSettings />
    </AuthGuard>
  );
}
