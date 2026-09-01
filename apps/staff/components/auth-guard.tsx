'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  APP_LOCKED_EVENT,
  UNAUTHENTICATED_EVENT,
  apiFetch,
  hasPermission,
  type Me,
} from '../lib/api';

/** 15 Minuten Inaktivität → App-Sperre (serverseitig durchgesetzt, hier UI). */
const CLIENT_LOCK_MS = 15 * 60 * 1000;

const MeContext = createContext<Me | null>(null);
export function useMe(): Me | null {
  return useContext(MeContext);
}

function LockScreen({ onUnlocked, name }: { onUnlocked: () => void; name: string }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await apiFetch('/auth/unlock', { method: 'POST', body: { password } });
    setBusy(false);
    if (result.ok) {
      setPassword('');
      onUnlocked();
    } else if (result.errorCode === 'UNAUTHENTICATED') {
      router.replace('/login');
    } else {
      setError(result.errorMessage ?? 'Entsperren fehlgeschlagen.');
    }
  }

  return (
    <div className="lock-overlay" role="dialog" aria-label="App gesperrt">
      <div className="card">
        <h1>App gesperrt</h1>
        <p className="muted">
          Aus Sicherheitsgründen wurde die App nach 15 Minuten Inaktivität gesperrt
          {name !== '' ? `, ${name}` : ''}. Bitte melde dich erneut an.
        </p>
        <form onSubmit={unlock}>
          <label htmlFor="unlock-password">Passwort</label>
          <input
            id="unlock-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
          {error !== null && <p className="error">{error}</p>}
          <button className="primary" type="submit" disabled={busy || password === ''}>
            Entsperren
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * Umhüllt alle angemeldeten Seiten: lädt /auth/me, leitet Unangemeldete zum
 * Login, zeigt den Sperrbildschirm bei App-Sperre (Server-Signal oder lokale
 * 15-Minuten-Inaktivität) und stellt Nutzer + Rechte per Context bereit.
 */
export function AuthGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'locked'>('loading');
  const lastActivityRef = useRef(Date.now());

  const refresh = useCallback(async () => {
    const result = await apiFetch<Me>('/auth/me');
    if (result.status === 401) {
      router.replace('/login');
      return;
    }
    if (result.data === null) return;
    setMe(result.data);
    if (result.data.appLocked) {
      setState('locked');
    } else {
      lastActivityRef.current = Date.now();
      setState('ready');
    }
  }, [router]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const markActivity = () => {
      lastActivityRef.current = Date.now();
    };
    const lock = () => setState('locked');
    const toLogin = () => router.replace('/login');

    window.addEventListener('pointerdown', markActivity);
    window.addEventListener('keydown', markActivity);
    window.addEventListener(APP_LOCKED_EVENT, lock);
    window.addEventListener(UNAUTHENTICATED_EVENT, toLogin);
    const interval = window.setInterval(() => {
      if (Date.now() - lastActivityRef.current > CLIENT_LOCK_MS) setState('locked');
    }, 30_000);

    return () => {
      window.removeEventListener('pointerdown', markActivity);
      window.removeEventListener('keydown', markActivity);
      window.removeEventListener(APP_LOCKED_EVENT, lock);
      window.removeEventListener(UNAUTHENTICATED_EVENT, toLogin);
      window.clearInterval(interval);
    };
  }, [router]);

  async function logout() {
    await apiFetch('/auth/logout', { method: 'POST', body: {} });
    router.replace('/login');
  }

  if (state === 'loading') {
    return (
      <main className="page">
        <p className="muted">Wird geladen …</p>
      </main>
    );
  }

  if (state === 'locked') {
    // Gesperrter Zustand: Inhalte werden NICHT gerendert – nichts bleibt
    // hinter dem Overlay lesbar.
    return <LockScreen name={me?.user.firstName ?? ''} onUnlocked={() => void refresh()} />;
  }

  return (
    <MeContext.Provider value={me}>
      <header className="topbar">
        <strong>Miet-Royal Staff</strong>
        <nav aria-label="Hauptnavigation">
          <Link href="/">Start</Link>
          {hasPermission(me, 'process.view_all') && <Link href="/vorgaenge">Vorgänge</Link>}
          {hasPermission(me, 'customer.view') && <Link href="/kunden">Kunden</Link>}
          {hasPermission(me, 'employee.manage') && <Link href="/mitarbeiter">Mitarbeiter</Link>}
          {hasPermission(me, 'permission.manage') && (
            <Link href="/rollen">Rollen &amp; Rechte</Link>
          )}
          {hasPermission(me, 'system.settings') && <Link href="/einstellungen">Einstellungen</Link>}
          <Link href="/konto">Mein Konto</Link>
          <Link href="/suche" aria-label="Suche">
            🔍 Suche
          </Link>
        </nav>
        <button onClick={() => void logout()} aria-label="Abmelden">
          Abmelden
        </button>
      </header>
      {children}
    </MeContext.Provider>
  );
}
