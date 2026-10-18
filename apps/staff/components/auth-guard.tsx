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
  lease_unsupported:
    'Dieser Browser unterstützt die Offline-Prüfung der Berechtigung nicht. Bitte online anmelden.',
  lease_untrusted:
    'Die Offline-Berechtigung konnte nicht gegen den hinterlegten Serverschlüssel geprüft werden. Bitte online anmelden.',
  no_workspace:
    'Auf diesem Gerät ist kein Offline-Arbeitsbereich eingerichtet. Bitte online anmelden.',
  too_many_attempts:
    'Zu viele Fehlversuche – die Offline-Entsperrung ist auf diesem Gerät gesperrt. Bitte mit Verbindung anmelden.',
};

/**
 * Zweistufige Bestätigung vor dem Verwerfen lokaler Erfassungen (Order §38,
 * Finalisierung §7) – ersetzt `window.confirm`. Stufe 1 nennt die Zähler und
 * bietet „Zuerst synchronisieren“ (nur beim Abmelden), Stufe 2 verlangt die
 * ausdrückliche, unwiderrufliche Bestätigung. „Abbrechen“ ändert nichts.
 */
function DiscardDialog({
  prefix,
  stage,
  counts,
  busy,
  confirmLabel,
  onSyncFirst,
  onCancel,
  onDiscard,
  onConfirm,
}: {
  prefix: 'logout' | 'rekey';
  stage: 1 | 2;
  counts: { mutations: number; media: number };
  busy: boolean;
  confirmLabel: string;
  onSyncFirst?: () => void;
  onCancel: () => void;
  onDiscard: () => void;
  onConfirm: () => void;
}) {
  const amounts = `${counts.mutations} Erfassungen, ${counts.media} Fotos/Unterschriften`;
  if (stage === 1) {
    return (
      <div
        className="lock-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Nicht synchronisierte Erfassungen"
        data-testid={`${prefix}-dialog`}
      >
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Nicht synchronisierte Erfassungen</h2>
          <p>
            Auf diesem Gerät sind noch nicht synchronisierte Erfassungen vorhanden ({amounts}). Beim
            Abmelden ohne Synchronisierung gehen sie unwiderruflich verloren.
          </p>
          <p>
            {onSyncFirst !== undefined && (
              <>
                <button
                  type="button"
                  className="primary"
                  data-testid={`${prefix}-sync-first`}
                  disabled={busy}
                  onClick={onSyncFirst}
                >
                  Zuerst synchronisieren (empfohlen)
                </button>{' '}
              </>
            )}
            <button
              type="button"
              data-testid={`${prefix}-cancel`}
              disabled={busy}
              onClick={onCancel}
            >
              Abbrechen
            </button>{' '}
            <button
              type="button"
              className="danger"
              data-testid={`${prefix}-discard`}
              disabled={busy}
              onClick={onDiscard}
            >
              Lokale Erfassungen verwerfen …
            </button>
          </p>
        </div>
      </div>
    );
  }
  return (
    <div
      className="lock-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Wirklich verwerfen?"
      data-testid={`${prefix}-dialog-confirm`}
    >
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Wirklich verwerfen?</h2>
        <p>
          Wirklich verwerfen? {amounts} werden unwiderruflich gelöscht und können nicht
          wiederhergestellt werden.
        </p>
        <p>
          <button
            type="button"
            className="danger"
            data-testid={`${prefix}-discard-confirm`}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>{' '}
          <button type="button" data-testid={`${prefix}-cancel`} disabled={busy} onClick={onCancel}>
            Abbrechen
          </button>
        </p>
      </div>
    </div>
  );
}

function LockScreen({
  name,
  offline,
  onUnlockedOnline,
  onUnlockedOffline,
  onDiscardWorkspace,
}: {
  name: string;
  offline: boolean;
  onUnlockedOnline: (password: string) => Promise<'ok' | 'rekey_refused'>;
  onUnlockedOffline: () => Promise<void>;
  onDiscardWorkspace: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rekeyRefused, setRekeyRefused] = useState(false);
  const [rekeyConfirm, setRekeyConfirm] = useState<{ mutations: number; media: number } | null>(
    null,
  );
  const acceptedPasswordRef = useRef('');
  const router = useRouter();

  async function askDiscardWorkspace() {
    // Order §38: nie still vernichten – Stufe 2 mit Zählern (Klartext-Metadaten, ohne DEK).
    setRekeyConfirm(await offlineRuntime().pendingSummary());
  }

  async function discardWorkspace() {
    setRekeyConfirm(null);
    setBusy(true);
    await onDiscardWorkspace(acceptedPasswordRef.current);
    acceptedPasswordRef.current = '';
    setBusy(false);
  }

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
      const outcome = await onUnlockedOnline(password);
      setBusy(false);
      if (outcome === 'rekey_refused') {
        // Server akzeptiert das Passwort, der lokale Arbeitsbereich (altes Passwort, Lease
        // abgelaufen) nicht – mit ausstehenden Daten wird nicht still neu verschlüsselt.
        acceptedPasswordRef.current = password;
        setRekeyRefused(true);
      }
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
        {rekeyRefused && (
          <div className="conflict-box" data-testid="rekey-refused">
            <p>
              Das Passwort wurde vom Server akzeptiert, aber der lokale Offline-Arbeitsbereich
              dieses Geräts lässt sich damit nicht öffnen (z. B. nach einer Passwortänderung) und
              enthält noch nicht synchronisierte Erfassungen. Sie bleiben erhalten, bis du sie
              bewusst verwirfst.
            </p>
            <p className="muted">
              Ohne Verbindung kannst du den Arbeitsbereich mit dem bisherigen Passwort entsperren
              und anschließend synchronisieren.
            </p>
            <button
              type="button"
              data-testid="rekey-discard"
              disabled={busy}
              onClick={() => void askDiscardWorkspace()}
            >
              Lokale Offline-Erfassungen verwerfen und neu einrichten
            </button>
          </div>
        )}
      </div>
      {rekeyConfirm !== null && (
        <DiscardDialog
          prefix="rekey"
          stage={2}
          counts={rekeyConfirm}
          busy={busy}
          confirmLabel="Ja, unwiderruflich verwerfen und neu einrichten"
          onCancel={() => setRekeyConfirm(null)}
          onDiscard={() => undefined}
          onConfirm={() => void discardWorkspace()}
        />
      )}
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
  const [logoutDialog, setLogoutDialog] = useState<{
    stage: 1 | 2;
    counts: { mutations: number; media: number };
  } | null>(null);
  const [logoutBusy, setLogoutBusy] = useState(false);
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
      const runtime = offlineRuntime();
      runtime.lock();
      // Ohne Verbindung (laut Statusprüfung oder Browser) zeigt der Sperrbildschirm die
      // Offline-Entsperrung – unabhängig davon, ob die Sitzung online oder offline begann.
      const offlineNow =
        runtime.snapshot.connectivity === 'offline' ||
        (typeof navigator !== 'undefined' && navigator.onLine === false);
      setState((current) =>
        current === 'offline-ready' || current === 'offline-locked' || offlineNow
          ? 'offline-locked'
          : 'locked',
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

  /** Abmelden ohne lokale Daten (bzw. nach ausdrücklicher Stufe-2-Bestätigung). */
  async function performLogout() {
    setLogoutBusy(true);
    const runtime = offlineRuntime();
    await runtime.revokeLeaseOnline();
    await runtime.wipe();
    await apiFetch('/auth/logout', { method: 'POST', body: {} });
    router.replace('/login');
  }

  async function logout() {
    const counts = await offlineRuntime().pendingSummary();
    if (counts.mutations + counts.media > 0) {
      // Order §38 / Finalisierung §7: nicht still vernichten – zweistufiger In-App-Dialog,
      // kein window.confirm, kein Timeout-Wipe.
      setLogoutDialog({ stage: 1, counts });
      return;
    }
    await performLogout();
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
          // Online-Re-Auth: erst Lease erneuern und Passwort-Wrap aktualisieren (§7), dann
          // die Seiten freigeben – ein nicht wiederherstellbarer Schlüssel (Passwort geändert,
          // Lease abgelaufen, Daten ausstehend) darf nicht in eine Sperrschleife führen.
          const runtime = offlineRuntime();
          if (runtime.snapshot.initialized) {
            const outcome = await runtime.authorizeOnlineDetailed(password);
            if (
              !outcome.ok &&
              outcome.reason === 'rekey_refused' &&
              !runtime.unlocked &&
              (await runtime.hasWorkspace())
            ) {
              return 'rekey_refused';
            }
          }
          await refresh();
          return 'ok';
        }}
        onDiscardWorkspace={async (password) => {
          const runtime = offlineRuntime();
          await runtime.revokeLeaseOnline();
          await runtime.wipe();
          if (password !== '') await runtime.authorizeOnline(password);
          lastActivityRef.current = Date.now();
          await refresh();
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
                {/* Phase 12 (UI): Mehr → Kommunikation → Nicht zugeordnet (message.reply_customer). */}
                {hasPermission(me, 'message.reply_customer') && (
                  <Link href="/kommunikation/nicht-zugeordnet" data-testid="nav-communication">
                    Kommunikation
                  </Link>
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
        {logoutDialog !== null && (
          <DiscardDialog
            prefix="logout"
            stage={logoutDialog.stage}
            counts={logoutDialog.counts}
            busy={logoutBusy}
            confirmLabel="Ja, unwiderruflich verwerfen und abmelden"
            onSyncFirst={() => {
              setLogoutDialog(null);
              router.push('/sync');
            }}
            onCancel={() => setLogoutDialog(null)}
            onDiscard={() => setLogoutDialog({ stage: 2, counts: logoutDialog.counts })}
            onConfirm={() => void performLogout()}
          />
        )}
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
