'use client';

import { useEffect } from 'react';

/**
 * Registrierung des Service Workers (Phase-8-Order §§3, 70–72): `updateViaCache:
 * 'none'`, damit eine neue Version zuverlässig erkannt wird. Eine wartende
 * Version wird NICHT automatisch aktiviert – die Laufzeit meldet
 * `updateAvailable`, der Hinweis erscheint nur außerhalb laufender Erfassung
 * und ohne ausstehende Mutationen; `SKIP_WAITING` erst auf Nutzerklick, der
 * Reload nur, wenn dieser Tab die Aktualisierung angefordert hat.
 */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

let updateRequested = false;

async function markUpdate(available: boolean): Promise<void> {
  const { offlineRuntime } = await import('../lib/offline/runtime');
  offlineRuntime().setUpdateAvailable(available);
}

export function PwaRegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    let cancelled = false;
    let timer: number | null = null;
    const onControllerChange = () => {
      if (updateRequested) window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    void (async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', {
          updateViaCache: 'none',
        });
        if (cancelled) return;
        if (registration.waiting !== null && navigator.serviceWorker.controller !== null) {
          void markUpdate(true);
        }
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (installing === null) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller !== null) {
              void markUpdate(true);
            }
          });
        });
        timer = window.setInterval(() => void registration.update(), UPDATE_CHECK_INTERVAL_MS);
      } catch {
        // Ohne Service Worker läuft die App online normal weiter.
      }
    })();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);
  return null;
}

/** Wartende Version aktivieren – nur durch Nutzerklick (§72); false = abgelehnt (Pending-Daten). */
export async function applyPendingUpdate(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  // Frisch aus IndexedDB (auch Erfassungen anderer Tabs): mit Pending-Daten nie aktivieren (§72).
  const { offlineRuntime } = await import('../lib/offline/runtime');
  if (await offlineRuntime().hasPendingWork()) return false;
  const registration = await navigator.serviceWorker.getRegistration();
  if (registration?.waiting === null || registration?.waiting === undefined) return false;
  updateRequested = true;
  registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  return true;
}

/** Seiten-Shells für Offline-Navigation vorab cachen (nur HTML, keine Fachdaten). */
export async function prefetchPages(urls: string[]): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  registration?.active?.postMessage({ type: 'PREFETCH_PAGES', urls });
}
