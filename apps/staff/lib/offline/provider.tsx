'use client';

import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { APP_LOCKED_EVENT, UNAUTHENTICATED_EVENT, setOfflineRouter } from '../api';
import { prefetchPages } from '../../components/pwa-register';
import type { OfflineIdentity } from './device';
import { routeOffline } from './router';
import {
  OFFLINE_SESSION_INVALID_EVENT,
  PACKAGE_REFRESHED_EVENT,
  offlineRuntime,
  type OfflineRuntime,
  type OfflineRuntimeState,
} from './runtime';

export interface OfflineContextValue {
  state: OfflineRuntimeState;
  runtime: OfflineRuntime;
  /** true = Sitzung/Identität stammt aus dem Offline-Workspace (kein Serverkontakt). */
  offlineSession: boolean;
  /** Aktuelle Seite ist eine laufende Erfassung (Wizard-Route) – kein Update-Hinweis (§72). */
  inCapture: boolean;
  syncNow: () => Promise<void>;
  refreshPackage: () => Promise<boolean>;
}

const OfflineContext = createContext<OfflineContextValue | null>(null);

export function useOffline(): OfflineContextValue | null {
  return useContext(OfflineContext);
}

/** Paket älter als 15 Minuten → bei Onlinekontakt aktualisieren (§9/§37). */
const PACKAGE_STALE_MS = 15 * 60 * 1000;

// Router sofort beim Laden des Moduls registrieren – Effekte von Kind-Seiten
// (erster Datenabruf eines Wizards) laufen VOR dem Provider-Effekt; der Router
// liefert null, solange die Laufzeit nicht initialisiert/entsperrt ist.
setOfflineRouter(routeOffline);

/**
 * Verdrahtet die Offline-Laufzeit mit React: initialisiert den Workspace für
 * die angemeldete Identität, hält den Zustand für Indikator/Sync-Seite und
 * stößt Sync/Paketaktualisierung bei Onlinekontakt an. React-Komponenten
 * sprechen nie direkt mit IndexedDB.
 */
export function OfflineProvider({
  identity,
  offlineSession,
  children,
}: {
  identity: OfflineIdentity | null;
  offlineSession: boolean;
  children: ReactNode;
}) {
  const runtime = offlineRuntime();
  const [state, setState] = useState<OfflineRuntimeState>(runtime.snapshot);
  const pathname = usePathname();

  useEffect(() => runtime.subscribe(setState), [runtime]);

  useEffect(() => {
    if (identity === null || !runtime.available) return;
    let cancelled = false;
    void (async () => {
      await runtime.init(identity);
      if (cancelled) return;
      if (offlineSession) {
        runtime.checkConnectivity(false).catch(() => undefined);
        return;
      }
      const connectivity = await runtime.checkConnectivity(false);
      if (cancelled) return;
      if (!connectivity.online) {
        // Server nicht erreichbar, Arbeitsbereich noch gesperrt: in die
        // Offline-Entsperrung wechseln statt online weiterzuarbeiten.
        if (!runtime.unlocked && (await runtime.hasWorkspace())) {
          window.dispatchEvent(new Event(APP_LOCKED_EVENT));
        }
        return;
      }
      if (connectivity.unauthenticated) return;
      if (!runtime.unlocked) {
        const unlocked = await runtime.unlockSilently();
        // Kein Lease-Wrap vorhanden: Lease ausstellen. Bei bereits eingerichtetem,
        // gesperrtem Arbeitsbereich wird NICHT neu verschlüsselt – stattdessen
        // Sperrbildschirm (Passwort entsperrt Wrap A und erneuert das Lease).
        if (!unlocked) {
          const authorized = await runtime.authorizeOnline(null);
          if (!authorized && (await runtime.hasWorkspace())) {
            window.dispatchEvent(new Event(APP_LOCKED_EVENT));
            return;
          }
        }
      }
      if (cancelled || !runtime.unlocked) return;
      await runtime.sync(false);
      const last = runtime.snapshot.lastPackageAt;
      if (last === null || Date.now() - Date.parse(last) > PACKAGE_STALE_MS) {
        await runtime.refreshPackage();
      }
      void prefetchShells(runtime);
    })();
    return () => {
      cancelled = true;
    };
  }, [identity, offlineSession, runtime]);

  useEffect(() => {
    const onInvalid = () => window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
    window.addEventListener(OFFLINE_SESSION_INVALID_EVENT, onInvalid);
    return () => window.removeEventListener(OFFLINE_SESSION_INVALID_EVENT, onInvalid);
  }, []);

  // Nach jedem Paketabruf die Seiten-Shells der Paketvorgänge vorab cachen (nur HTML).
  useEffect(() => {
    const onRefreshed = () => void prefetchShells(runtime);
    window.addEventListener(PACKAGE_REFRESHED_EVENT, onRefreshed);
    return () => window.removeEventListener(PACKAGE_REFRESHED_EVENT, onRefreshed);
  }, [runtime]);

  // Sicherer Aktualisierungspunkt (§72): nicht in laufender Erfassung, nichts ausstehend.
  const inCapture = /\/(uebergabe|rueckgabe|ausgabe)(\/|$)/.test(pathname ?? '');

  const syncNow = useCallback(async () => {
    await runtime.checkConnectivity(false);
    await runtime.sync(true);
  }, [runtime]);
  const refreshPackage = useCallback(() => runtime.refreshPackage(), [runtime]);

  return (
    <OfflineContext.Provider
      value={{ state, runtime, offlineSession, inCapture, syncNow, refreshPackage }}
    >
      {children}
    </OfflineContext.Provider>
  );
}

/** Statusbezeichnung des Indikators (§40) – exakt diese Texte. */
export function offlineStatusLabel(state: OfflineRuntimeState): string {
  if (state.conflicts > 0) return 'PRÜFUNG ERFORDERLICH';
  if (state.connectivity === 'offline') {
    return state.pending > 0 ? `OFFLINE – ${state.pending} ÄNDERUNGEN AUSSTEHEND` : 'OFFLINE';
  }
  if (state.syncing) return 'SYNCHRONISIERUNG …';
  if (state.pending > 0) return `${state.pending} ÄNDERUNGEN AUSSTEHEND`;
  if (state.connectivity !== 'online') return 'VERBINDUNG WIRD GEPRÜFT';
  return state.lastSyncAt !== null ? 'SYNCHRONISIERT' : 'ONLINE';
}

/** Seiten-Shells der geladenen Vorgänge für den Offline-Start vorab cachen (nur HTML). */
async function prefetchShells(runtime: OfflineRuntime): Promise<void> {
  const urls = new Set<string>([
    '/',
    '/tablet',
    '/ausgabe',
    '/rueckgabe',
    '/reinigung',
    '/sync',
    '/maschinen',
  ]);
  for (const booking of await runtime.listBookings()) {
    if (booking.handover !== null) {
      urls.add(`/vorgaenge/${booking.processId}/uebergabe`);
      urls.add(`/vorgaenge/${booking.processId}/ausgabe`);
    }
    if (booking.return !== null || booking.returnStartable)
      urls.add(`/vorgaenge/${booking.processId}/rueckgabe`);
  }
  for (const machine of await runtime.listMachines()) urls.add(`/maschinen/${machine.machineId}`);
  await prefetchPages([...urls]);
}
