'use client';

import { useEffect, useState } from 'react';
import { AuthGuard } from '../../components/auth-guard';
import { apiFetch } from '../../lib/api';

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
    </main>
  );
}

export default function SettingsPage() {
  return (
    <AuthGuard>
      <SettingsView />
    </AuthGuard>
  );
}
