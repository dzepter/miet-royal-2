'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { apiFetch } from '../../lib/api';

function ResetForm() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== repeat) {
      setError('Die Passwörter stimmen nicht überein.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await apiFetch('/auth/password/reset', {
      method: 'POST',
      body: { token, newPassword: password },
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Zurücksetzen fehlgeschlagen.');
      return;
    }
    router.replace('/login');
  }

  if (token === '') {
    return (
      <div>
        <p className="error">Der Link ist unvollständig.</p>
        <Link href="/passwort-vergessen">Neuen Link anfordern</Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      <p className="muted">Mindestens 10 Zeichen – am besten aus deinem Passwortmanager.</p>
      <label htmlFor="new-password">Neues Passwort</label>
      <input
        id="new-password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <label htmlFor="repeat-password">Neues Passwort wiederholen</label>
      <input
        id="repeat-password"
        type="password"
        autoComplete="new-password"
        value={repeat}
        onChange={(e) => setRepeat(e.target.value)}
        required
      />
      {error !== null && <p className="error">{error}</p>}
      <button className="primary" type="submit" disabled={busy}>
        Passwort setzen
      </button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="auth-page">
      <div className="card">
        <h1>Passwort zurücksetzen</h1>
        <Suspense fallback={<p className="muted">Wird geladen …</p>}>
          <ResetForm />
        </Suspense>
      </div>
    </div>
  );
}
