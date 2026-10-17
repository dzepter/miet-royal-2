'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
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
import {
  WAREHOUSE_MODE_EVENT,
  setWarehouseMode,
  warehouseModeEnabled,
  type OfflineIdentity,
} from '../lib/offline/device';
import { OfflineProvider } from '../lib/offline/provider';
import { cachedIdentity, offlineRuntime } from '../lib/offline/runtime';
import { OfflineIndicator, UpdateBanner } from './offline-indicator';

export { cachedIdentity };

/** 15 Minuten Inaktivität → App-Sperre (serverseitig durchgesetzt, hier UI – auch offline). */
const CLIENT_LOCK_MS = 15 * 60 * 1000;

type GuardState =
  'loading' | 'ready' | 'locked' | 'offline-ready' | 'offline-locked' | 'offline-unavailable';

const MeContext = createContext<Me | null>(null);
export function useMe(): Me | null {
  return useContext(MeContext);
}

const OFFLINE_UNLOCK_MESSAGES: Record<string, string> = {
  wrong_password: 'Das Passwort ist falsch.',
  lease_expired:
    'Die Offline-Berechtigung dieses Geräts ist abgelaufen (max. 72 Stunden). Bitte online anmelden.',
  lease_tampered: 'Der Offline-Arbeitsbereich ist beschädigt. Bitte online anmelden.',
  no_workspace:
    'Auf diesem Gerät ist kein Offline-Arbeitsbereich eingerichtet. Bitte online anmelden.',
};

function LockScreen({
  name,
  offline,
  onUnlockedOnline,
  onUnlockedOffline,
}: {
  name: string;
  offline: boolean;
  onUnlockedOnline: (password: string) => Promise<void>;
  onUnlockedOffline: () => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const runtime = offlineRuntime();
    // Server zuerst, sobald das Gerät (wieder) online ist – auch aus einer Offline-Sitzung
    // heraus (§7); nur bei Netzausfall die lokale Offline-Entsperrung.
    const tryServer = !offline || navigator.onLine !== false;
    const result = tryServer
      ? await apiFetch('/auth/unlock', { method: 'POST', body: { password } })
      : null;
    if (result !== null && result.ok) {
      setPassword('');
      setBusy(false);
      await onUnlockedOnline(password);
      return;
    }
    if (result !== null && result.errorCode === 'UNAUTHENTICATED') {
      setBusy(false);
      router.replace('/login');
      return;
    }
    if (result !== null && result.status !== 0) {
      setBusy(false);
      setError(result.errorMessage ?? 'Entsperren fehlgeschlagen.');
      return;
    }
    // Keine Verbindung: lokale Offline-Entsperrung (Passwort → Wrap A).
    const local = await runtime.unlockOffline(password);
    setBusy(false);
    if (local.ok) {
      setPassword('');
      await onUnlockedOffline();
      return;
    }
    const reason = (local as { reason?: string }).reason ?? 'no_workspace';
    setError(OFFLINE_UNLOCK_MESSAGES[reason] ?? 'Entsperren fehlgeschlagen.');
  }

  return (
    <div className="lock-overlay" role="dialog" aria-label="App gesperrt">
      <div className="card">
        <h1>App gesperrt</h1>
        <p className="muted">
          Aus Sicherheitsgründen wurde die App nach 15 Minuten Inaktivität gesperrt
          {name !== '' ? `, ${name}` : ''}. Bitte melde dich erneut an.
        </p>
        {offline && (
          <p className="muted" data-testid="offline-unlock-hint">
            Keine Verbindung zum Server – die Entsperrung erfolgt mit deinem Passwort aus dem
            lokalen, verschlüsselten Offline-Arbeitsbereich.
          </p>
        )}
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

export function meFromIdentity(identity: OfflineIdentity, permissions: string[]): Me {
  return {
    appLocked: false,
    user: { id: identity.userId, firstName: identity.firstName, lastName: identity.lastName },
    permissions,
    environment: identity.environment,
  };
}

/**
 * Umhüllt alle angemeldeten Seiten: lädt /auth/me, leitet Unangemeldete zum
 * Login, zeigt den Sperrbildschirm bei App-Sperre (Server-Signal oder lokale
 * 15-Minuten-Inaktivität) und stellt Nutzer + Rechte per Context bereit.
 * Phase 8: ohne Serververbindung startet die App aus dem verschlüsselten
 * Offline-Arbeitsbereich (Identität + Rechte-Snapshot aus dem Lease).
 */
export function AuthGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<GuardState>('loading');
  const [identity, setIdentity] = useState<OfflineIdentity | null>(null);
  const [warehouseMode, setWarehouseModeState] = useState(false);
  const lastActivityRef = useRef(Date.now());

  useEffect(() => {
    const syncMode = () => setWarehouseModeState(warehouseModeEnabled());
    syncMode();
    // Moduswechsel auf der Tablet-Seite (gleicher Tab) und in anderen Tabs (storage) übernehmen.
    window.addEventListener(WAREHOUSE_MODE_EVENT, syncMode);
    window.addEventListener('storage', syncMode);
    return () => {
      window.removeEventListener(WAREHOUSE_MODE_EVENT, syncMode);
      window.removeEventListener('storage', syncMode);
    };
  }, []);

  const startOffline = useCallback(async () => {
    const runtime = offlineRuntime();
    const cached = cachedIdentity();
    if (cached === null || !runtime.available) {
      setState('offline-unavailable');
      return;
    }
    try {
      await runtime.init(cached);
    } catch {
      setState('offline-unavailable');
      return;
    }
    setIdentity(cached);
    if (runtime.unlocked) {
      setMe(meFromIdentity(cached, runtime.snapshot.permissions));
      setState('offline-ready');
      return;
    }
    if (!(await runtime.hasWorkspace())) {
      setState('offline-unavailable');
      return;
    }
    setMe(meFromIdentity(cached, []));
    setState('offline-locked');
  }, []);

  const refresh = useCallback(async () => {
    const result = await apiFetch<Me>('/auth/me');
    if (result.status === 401) {
      // Session serverseitig ungültig/widerrufen: Offline-Arbeitsbereich sperren (§39),
      // Daten bleiben verschlüsselt erhalten.
      offlineRuntime().lock();
      router.replace('/login');
      return;
    }
    if (result.status === 0) {
      await startOffline();
      return;
    }
    if (result.data === null) return;
    setMe(result.data);
    if (result.data.appLocked) {
      offlineRuntime().lock();
      setState('locked');
    } else {
      lastActivityRef.current = Date.now();
      if (result.data.user.id !== undefined && result.data.environment !== undefined) {
        const online: OfflineIdentity = {
          userId: result.data.user.id,
          environment: result.data.environment,
          firstName: result.data.user.firstName,
          lastName: result.data.user.lastName,
        };
        setIdentity(online);
        // Offline-Laufzeit VOR dem Rendern der Seiten öffnen und (still) entsperren:
        // der erste Datenabruf einer Seite muss lokal ausstehende Änderungen sehen (§2).
        const runtime = offlineRuntime();
        if (runtime.available) {
          try {
            await runtime.init(online);
            if (!runtime.unlocked) await runtime.unlockSilently();
          } catch {
            // Ohne Offline-Laufzeit weiter online arbeiten.
          }
        }
      }
      setState('ready');
    }
  }, [router, startOffline]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const markActivity = () => {
      lastActivityRef.current = Date.now();
      offlineRuntime().touchActivity();
    };
    const lock = () => {
      offlineRuntime().lock();
      setState((current) =>
        current === 'offline-ready' || current === 'offline-locked' ? 'offline-locked' : 'locked',
      );
    };
    const toLogin = () => {
      // Session serverseitig ungültig/widerrufen: Offline-Arbeitsbereich sperren (§39),
      // Daten bleiben verschlüsselt erhalten.
      offlineRuntime().lock();
      router.replace('/login');
    };

    window.addEventListener('pointerdown', markActivity);
    window.addEventListener('keydown', markActivity);
    window.addEventListener(APP_LOCKED_EVENT, lock);
    window.addEventListener(UNAUTHENTICATED_EVENT, toLogin);
    const interval = window.setInterval(() => {
      if (Date.now() - lastActivityRef.current > CLIENT_LOCK_MS) lock();
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
    const runtime = offlineRuntime();
    if (await runtime.hasPendingWork()) {
      // Order §38: nicht still vernichten – bewusste Entscheidung des Mitarbeiters.
      const discard = window.confirm(
        'Auf diesem Gerät sind noch nicht synchronisierte Daten vorhanden.\n\n' +
          'Abbrechen = zuerst synchronisieren (empfohlen). OK = Abmelden und die lokalen Offline-Erfassungen (inkl. Fotos/Unterschriften) bewusst verwerfen.',
      );
      if (!discard) return;
    }
    await runtime.revokeLeaseOnline();
    await runtime.wipe();
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

  if (state === 'offline-unavailable') {
    return (
      <main className="page">
        <p className="error">Keine Verbindung zum Server. Bitte erneut versuchen.</p>
        <p className="muted">
          Auf diesem Gerät ist kein Offline-Arbeitsbereich eingerichtet – bitte mit Verbindung
          anmelden, danach steht die App auch offline zur Verfügung.
        </p>
        <p>
          <button className="primary" onClick={() => void refresh()}>
            Erneut versuchen
          </button>
        </p>
      </main>
    );
  }

  if (state === 'locked' || state === 'offline-locked') {
    // Gesperrter Zustand: Inhalte werden NICHT gerendert – nichts bleibt
    // hinter dem Overlay lesbar.
    return (
      <LockScreen
        name={me?.user.firstName ?? ''}
        offline={state === 'offline-locked'}
        onUnlockedOnline={async (password) => {
          lastActivityRef.current = Date.now();
          await refresh();
          // Online-Re-Auth: Lease erneuern und Passwort-Wrap aktualisieren (§7).
          const runtime = offlineRuntime();
          if (runtime.snapshot.initialized) await runtime.authorizeOnline(password);
        }}
        onUnlockedOffline={async () => {
          lastActivityRef.current = Date.now();
          const runtime = offlineRuntime();
          const cached = runtime.identity ?? cachedIdentity();
          if (cached !== null) setMe(meFromIdentity(cached, runtime.snapshot.permissions));
          setState('offline-ready');
        }}
      />
    );
  }

  const offlineSession = state === 'offline-ready';
  const inCapture = /\/(uebergabe|rueckgabe|ausgabe)(\/|$)/.test(pathname ?? '');
  const tablet = warehouseMode;

  return (
    <MeContext.Provider value={me}>
      <OfflineProvider identity={identity} offlineSession={offlineSession}>
        <UpdateBanner inCapture={inCapture} />
        <header className={`topbar${tablet ? ' topbar-tablet' : ''}`}>
          <strong>Miet-Royal Staff</strong>
          <nav aria-label="Hauptnavigation">
            {tablet ? (
              <>
                <Link href="/tablet">Lager-Tablet</Link>
                <Link href="/sync">Synchronisierung</Link>
                <button
                  type="button"
                  className="link-like"
                  onClick={() => {
                    setWarehouseMode(false);
                    setWarehouseModeState(false);
                  }}
                >
                  Vollansicht
                </button>
              </>
            ) : (
              <>
                <Link href="/">Heute</Link>
                {hasPermission(me, 'calendar.view') && <Link href="/kalender">Kalender</Link>}
                {hasPermission(me, 'process.view_all') && <Link href="/vorgaenge">Vorgänge</Link>}
                {hasPermission(me, 'handover.view') && <Link href="/ausgabe">Ausgabe</Link>}
                {hasPermission(me, 'return.view') && <Link href="/rueckgabe">Rückgabe</Link>}
                {(hasPermission(me, 'machine.view') || hasPermission(me, 'inventory.view')) && (
                  <Link href={hasPermission(me, 'machine.view') ? '/maschinen' : '/lager'}>
                    Maschinen &amp; Lager
                  </Link>
                )}
                {hasPermission(me, 'customer.view') && <Link href="/kunden">Kunden</Link>}
                {hasPermission(me, 'product.view') && <Link href="/produkte">Produkte</Link>}
                {hasPermission(me, 'employee.manage') && (
                  <Link href="/mitarbeiter">Mitarbeiter</Link>
                )}
                {hasPermission(me, 'permission.manage') && (
                  <Link href="/rollen">Rollen &amp; Rechte</Link>
                )}
                {hasPermission(me, 'system.settings') && (
                  <Link href="/einstellungen">Einstellungen</Link>
                )}
                <Link href="/konto">Mein Konto</Link>
                <Link href="/tablet">Lager-Tablet</Link>
                <Link href="/suche" aria-label="Suche">
                  🔍 Suche
                </Link>
              </>
            )}
          </nav>
          <OfflineIndicator />
          <button onClick={() => void logout()} aria-label="Abmelden">
            Abmelden
          </button>
        </header>
        {children}
      </OfflineProvider>
    </MeContext.Provider>
  );
}

/** Lager-/Tabletmodus dieses Geräts (localStorage) – Wechsel wirkt sofort in allen Komponenten. */
export function useWarehouseMode(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const syncMode = () => setEnabled(warehouseModeEnabled());
    syncMode();
    window.addEventListener(WAREHOUSE_MODE_EVENT, syncMode);
    window.addEventListener('storage', syncMode);
    return () => {
      window.removeEventListener(WAREHOUSE_MODE_EVENT, syncMode);
      window.removeEventListener('storage', syncMode);
    };
  }, []);
  return [
    enabled,
    (value: boolean) => {
      setWarehouseMode(value);
      setEnabled(value);
    },
  ];
}
