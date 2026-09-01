'use client';

import { useCallback, useEffect, useState } from 'react';
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
      <PickupSettings />
      <TermsSettings />
    </main>
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

export default function SettingsPage() {
  return (
    <AuthGuard>
      <SettingsView />
    </AuthGuard>
  );
}
