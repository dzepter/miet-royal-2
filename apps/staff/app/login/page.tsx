'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiFetch } from '../../lib/api';

type Phase =
  | { step: 'credentials' }
  | { step: 'totp'; challengeToken: string; useRecovery: boolean }
  | { step: 'totp_setup'; challengeToken: string; qrDataUrl: string; secret: string }
  | { step: 'recovery_codes'; codes: string[] };

interface LoginResponse {
  next: 'authenticated' | 'totp_required' | 'totp_setup_required';
  challengeToken?: string;
  user?: unknown;
  recoveryCodes?: string[];
}

export default function LoginPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ step: 'credentials' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitCredentials(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await apiFetch<LoginResponse>('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    setBusy(false);
    if (!result.ok || result.data === null) {
      setError(result.errorMessage ?? 'Anmeldung nicht möglich.');
      return;
    }
    const data = result.data;
    if (data.next === 'authenticated') {
      router.replace('/');
      return;
    }
    const challengeToken = data.challengeToken ?? '';
    if (data.next === 'totp_required') {
      setPhase({ step: 'totp', challengeToken, useRecovery: false });
      return;
    }
    // Erzwungene 2FA-Einrichtung: QR-Code laden
    const setup = await apiFetch<{ qrDataUrl: string; secret: string }>('/auth/totp/setup/begin', {
      method: 'POST',
      body: { challengeToken },
    });
    if (!setup.ok || setup.data === null) {
      setError(setup.errorMessage ?? 'Einrichtung nicht möglich.');
      return;
    }
    setPhase({
      step: 'totp_setup',
      challengeToken,
      qrDataUrl: setup.data.qrDataUrl,
      secret: setup.data.secret,
    });
  }

  async function submitTotp(event: React.FormEvent) {
    event.preventDefault();
    if (phase.step !== 'totp') return;
    setBusy(true);
    setError(null);
    const path = phase.useRecovery ? '/auth/login/recovery' : '/auth/login/totp';
    const body = phase.useRecovery
      ? { challengeToken: phase.challengeToken, recoveryCode: code }
      : { challengeToken: phase.challengeToken, code };
    const result = await apiFetch<LoginResponse>(path, { method: 'POST', body });
    setBusy(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Der Code ist ungültig.');
      return;
    }
    router.replace('/');
  }

  async function submitSetup(event: React.FormEvent) {
    event.preventDefault();
    if (phase.step !== 'totp_setup') return;
    setBusy(true);
    setError(null);
    const result = await apiFetch<LoginResponse>('/auth/totp/setup/confirm', {
      method: 'POST',
      body: { challengeToken: phase.challengeToken, code },
    });
    setBusy(false);
    if (!result.ok || result.data === null) {
      setError(result.errorMessage ?? 'Der Code ist ungültig.');
      return;
    }
    setPhase({ step: 'recovery_codes', codes: result.data.recoveryCodes ?? [] });
  }

  return (
    <div className="auth-page">
      <div className="card">
        <h1>Miet-Royal Staff – Anmeldung</h1>

        {phase.step === 'credentials' && (
          <form onSubmit={submitCredentials}>
            <label htmlFor="email">E-Mail</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <label htmlFor="password">Passwort</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {error !== null && <p className="error">{error}</p>}
            <button className="primary" type="submit" disabled={busy}>
              Anmelden
            </button>
            <p>
              <Link href="/passwort-vergessen">Passwort vergessen?</Link>
            </p>
          </form>
        )}

        {phase.step === 'totp' && (
          <form onSubmit={submitTotp}>
            <p className="muted">
              {phase.useRecovery
                ? 'Gib einen deiner Wiederherstellungscodes ein.'
                : 'Gib den 6-stelligen Code aus deiner Authenticator-App ein.'}
            </p>
            <label htmlFor="code">{phase.useRecovery ? 'Wiederherstellungscode' : 'Code'}</label>
            <input
              id="code"
              inputMode={phase.useRecovery ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
              required
            />
            {error !== null && <p className="error">{error}</p>}
            <button className="primary" type="submit" disabled={busy}>
              Bestätigen
            </button>
            <p>
              <button
                type="button"
                onClick={() => {
                  setCode('');
                  setError(null);
                  setPhase({ ...phase, useRecovery: !phase.useRecovery });
                }}
              >
                {phase.useRecovery
                  ? 'Zurück zum App-Code'
                  : 'Gerät verloren? Wiederherstellungscode'}
              </button>{' '}
              <button
                type="button"
                onClick={() => {
                  setCode('');
                  setError(null);
                  setPhase({ step: 'credentials' });
                }}
              >
                Zurück zur Anmeldung
              </button>
            </p>
          </form>
        )}

        {phase.step === 'totp_setup' && (
          <form onSubmit={submitSetup}>
            <h2>Zwei-Faktor-Authentifizierung einrichten</h2>
            <p className="muted">
              Scanne den QR-Code mit deiner Authenticator-App (z. B. Google Authenticator) und gib
              danach den angezeigten Code ein.
            </p>
            <img
              src={phase.qrDataUrl}
              alt="QR-Code für Authenticator-App"
              width={200}
              height={200}
            />
            <p className="muted">Manuell: </p>
            <p className="code-box">{phase.secret}</p>
            <label htmlFor="setup-code">Code aus der App</label>
            <input
              id="setup-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
            {error !== null && <p className="error">{error}</p>}
            <button className="primary" type="submit" disabled={busy}>
              Einrichtung abschließen
            </button>{' '}
            <button
              type="button"
              onClick={() => {
                setCode('');
                setError(null);
                setPhase({ step: 'credentials' });
              }}
            >
              Zurück zur Anmeldung
            </button>
          </form>
        )}

        {phase.step === 'recovery_codes' && (
          <div>
            <h2>Wiederherstellungscodes</h2>
            <p className="muted">
              Bewahre diese Codes sicher auf – sie werden nur EINMAL angezeigt. Jeder Code ist
              einmal verwendbar, falls du dein 2FA-Gerät verlierst.
            </p>
            <p className="code-box">{phase.codes.join('\n')}</p>
            <button className="primary" onClick={() => router.replace('/')}>
              Weiter zur App
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
