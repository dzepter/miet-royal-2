'use client';

import Link from 'next/link';
import { useState } from 'react';
import { apiFetch } from '../../lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    await apiFetch('/auth/password/forgot', { method: 'POST', body: { email } });
    setBusy(false);
    setDone(true);
  }

  return (
    <div className="auth-page">
      <div className="card">
        <h1>Passwort vergessen</h1>
        {done ? (
          <div>
            <p className="success">
              Falls ein Konto zu dieser E-Mail existiert, wurde ein Link zum Zurücksetzen
              verschickt.
            </p>
            <Link href="/login">Zurück zur Anmeldung</Link>
          </div>
        ) : (
          <form onSubmit={submit}>
            <label htmlFor="email">E-Mail</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <button className="primary" type="submit" disabled={busy}>
              Link anfordern
            </button>
            <p>
              <Link href="/login">Zurück zur Anmeldung</Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
