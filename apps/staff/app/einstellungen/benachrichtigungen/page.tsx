'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard } from '../../../components/auth-guard';
import {
  fetchPushDevices,
  fetchPushStatus,
  subscribeToPush,
  type PushDevice,
  type PushStatus,
} from '../../../lib/push';
import { derivePushViewState } from '../../../lib/push-state';

/**
 * Einstellungen → Benachrichtigungen (Phase 12, Order §29): Push auf DIESEM
 * Gerät aktivieren – nur nach Klick (Berechtigungsabfrage des Browsers) –
 * und die eigenen registrierten Geräte sehen. Für jede angemeldete Person,
 * kein Admin-Recht nötig.
 * Phase 12 Finalisierung (bestätigte Entscheidung): Die bewusste
 * Entscheidung ist die Browserberechtigung; Miet-Royal bietet danach
 * keinen eigenen Schalter mehr an. Der Anzeigezustand kommt ausschließlich
 * aus `derivePushViewState` (lib/push-state.ts).
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
    const outcome = await subscribeToPush();
    setBusy(false);
    // Abgelehnte Browserberechtigung zeigt der Status selbst (push-denied).
    if (!outcome.ok && outcome.reason !== 'denied') setError(outcome.message);
    await load();
  }

  const view = derivePushViewState(status);

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
        {view.kind === 'loading' && <p className="muted">Wird geladen …</p>}
        {(view.kind === 'unsupported' || view.kind === 'server_disabled') && (
          <p className="error">{view.text}</p>
        )}
        {view.kind === 'denied' && (
          <p className="error" data-testid="push-denied">
            {view.text}
          </p>
        )}
        {view.kind === 'active' && (
          <p className="success" data-testid="push-status">
            {view.text}
          </p>
        )}
        {error !== null && <p className="error">{error}</p>}
        {view.kind === 'inactive' && (
          <button
            className="primary"
            type="button"
            data-testid="push-enable"
            disabled={busy}
            onClick={() => void enable()}
          >
            {view.actionLabel}
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
