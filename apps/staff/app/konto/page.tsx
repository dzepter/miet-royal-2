'use client';

import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../components/auth-guard';
import { apiFetch } from '../../lib/api';

interface OwnSessions {
  currentSessionId: string;
  sessions: {
    id: string;
    deviceLabel: string;
    createdAt: string;
    lastActivityAt: string;
    revokedAt: string | null;
  }[];
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
}

function Account() {
  const me = useMe();
  const [sessions, setSessions] = useState<OwnSessions | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pwMessage, setPwMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(
    null,
  );
  const [totpSetup, setTotpSetup] = useState<{ qrDataUrl: string; secret: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [totpError, setTotpError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await apiFetch<OwnSessions>('/auth/sessions');
    if (result.data !== null) setSessions(result.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setPwMessage(null);
    const result = await apiFetch('/auth/password/change', {
      method: 'POST',
      body: { currentPassword, newPassword },
    });
    if (!result.ok) {
      setPwMessage({ kind: 'error', text: result.errorMessage ?? 'Änderung fehlgeschlagen.' });
      return;
    }
    setCurrentPassword('');
    setNewPassword('');
    setPwMessage({
      kind: 'success',
      text: 'Passwort geändert. Alle anderen Geräte wurden abgemeldet.',
    });
    await load();
  }

  async function beginTotp() {
    setTotpError(null);
    const result = await apiFetch<{ qrDataUrl: string; secret: string }>('/auth/totp/self/begin', {
      method: 'POST',
      body: {},
    });
    if (result.data !== null) setTotpSetup(result.data);
    else setTotpError(result.errorMessage ?? 'Einrichtung nicht möglich.');
  }

  async function confirmTotp(event: React.FormEvent) {
    event.preventDefault();
    setTotpError(null);
    const result = await apiFetch<{ recoveryCodes: string[] }>('/auth/totp/self/confirm', {
      method: 'POST',
      body: { code: totpCode },
    });
    if (!result.ok || result.data === null) {
      setTotpError(result.errorMessage ?? 'Der Code ist ungültig.');
      return;
    }
    setRecoveryCodes(result.data.recoveryCodes);
    setTotpSetup(null);
    setTotpCode('');
  }

  async function revokeSession(sessionId: string) {
    await apiFetch(`/auth/sessions/${sessionId}/revoke`, { method: 'POST', body: {} });
    await load();
  }

  return (
    <main className="page">
      <h1>Mein Konto</h1>

      <div className="card">
        <h2>Passwort ändern</h2>
        <p className="muted">
          Alle anderen Geräte werden dabei abgemeldet; dieses bleibt angemeldet.
        </p>
        <form onSubmit={changePassword}>
          <label htmlFor="current-password">Aktuelles Passwort</label>
          <input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
          <label htmlFor="new-password">Neues Passwort (mind. 10 Zeichen)</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
          {pwMessage !== null && <p className={pwMessage.kind}>{pwMessage.text}</p>}
          <button className="primary" type="submit">
            Passwort ändern
          </button>
        </form>
      </div>

      <div className="card">
        <h2>Zwei-Faktor-Authentifizierung</h2>
        {me?.user.totpEnabled === true ? (
          <p className="success">2FA ist aktiv.</p>
        ) : recoveryCodes !== null ? (
          <div>
            <p className="success">2FA ist jetzt aktiv.</p>
            <p className="muted">
              Wiederherstellungscodes – nur EINMAL sichtbar, bitte sicher aufbewahren:
            </p>
            <p className="code-box">{recoveryCodes.join('\n')}</p>
          </div>
        ) : totpSetup !== null ? (
          <form onSubmit={confirmTotp}>
            <p className="muted">QR-Code mit der Authenticator-App scannen, dann Code eingeben.</p>
            <img
              src={totpSetup.qrDataUrl}
              alt="QR-Code für Authenticator-App"
              width={200}
              height={200}
            />
            <p className="code-box">{totpSetup.secret}</p>
            <label htmlFor="totp-code">Code aus der App</label>
            <input
              id="totp-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              required
            />
            {totpError !== null && <p className="error">{totpError}</p>}
            <button className="primary" type="submit">
              Aktivieren
            </button>
          </form>
        ) : (
          <div>
            <p className="muted">Schütze dein Konto zusätzlich mit einer Authenticator-App.</p>
            {totpError !== null && <p className="error">{totpError}</p>}
            <button className="primary" onClick={() => void beginTotp()}>
              2FA einrichten
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Meine Geräte</h2>
        {sessions === null && <p className="muted">Wird geladen …</p>}
        {sessions?.sessions
          .filter((s) => s.revokedAt === null)
          .map((session) => (
            <div className="list-row" key={session.id}>
              <div>
                {session.deviceLabel}
                {session.id === sessions.currentSessionId && (
                  <span className="badge active"> dieses Gerät</span>
                )}
                <div className="muted">Zuletzt aktiv: {formatDate(session.lastActivityAt)}</div>
              </div>
              {session.id !== sessions.currentSessionId && (
                <button className="danger" onClick={() => void revokeSession(session.id)}>
                  Abmelden
                </button>
              )}
            </div>
          ))}
      </div>
    </main>
  );
}

export default function AccountPage() {
  return (
    <AuthGuard>
      <Account />
    </AuthGuard>
  );
}
