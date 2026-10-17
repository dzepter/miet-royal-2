'use client';

import Link from 'next/link';
import { useState } from 'react';
import { offlineStatusLabel, useOffline } from '../lib/offline/provider';
import { applyPendingUpdate } from './pwa-register';

/**
 * Kleiner dauerhafter Status (Phase-8-Order §40/§41): ONLINE / OFFLINE /
 * SYNCHRONISIERUNG … / SYNCHRONISIERT / X ÄNDERUNGEN AUSSTEHEND /
 * PRÜFUNG ERFORDERLICH. Tippen öffnet die Sync-Übersicht. Keine technische
 * Netzwerkdiagnose. Daneben die Speicherwarnung (§43), sobald der Speicher
 * knapp wird – sichtbar auf jeder Seite, nicht erst beim letzten Foto.
 */
export function OfflineIndicator() {
  const offline = useOffline();
  if (offline === null || !offline.state.initialized) return null;
  const { state } = offline;
  const label = offlineStatusLabel(state);
  const tone =
    state.conflicts > 0
      ? 'conflict'
      : state.connectivity === 'offline'
        ? 'offline'
        : state.pending > 0
          ? 'pending'
          : 'online';
  return (
    <>
      <Link
        href="/sync"
        className={`offline-indicator offline-${tone}`}
        data-testid="offline-indicator"
        data-connectivity={state.connectivity}
        data-pending={state.pending}
        data-conflicts={state.conflicts}
        aria-label={`Synchronisierungsstatus: ${label}`}
      >
        {label}
      </Link>
      {state.storageWarning !== null && (
        <span className="badge locked" role="status" data-testid="storage-warning">
          {state.storageWarning}
        </span>
      )}
    </>
  );
}

/**
 * Hinweis auf eine wartende App-Version (§72): nur außerhalb laufender
 * Erfassung (Wizard-Routen), ohne ausstehende Mutationen und nicht während
 * eines Sync-Laufs. Aktivierung ausschließlich per Klick.
 */
export function UpdateBanner({ inCapture }: { inCapture: boolean }) {
  const offline = useOffline();
  const [refused, setRefused] = useState(false);
  if (offline === null || !offline.state.updateAvailable) return null;
  if (inCapture || offline.state.pending > 0 || offline.state.syncing) return null;
  return (
    <div className="update-banner" role="status" data-testid="update-banner">
      Neue Version verfügbar.{' '}
      <button
        type="button"
        onClick={() => {
          void applyPendingUpdate().then((applied) => setRefused(!applied));
        }}
      >
        Jetzt aktualisieren
      </button>
      {refused && (
        <span className="muted">
          Noch nicht möglich – bitte zuerst ausstehende Änderungen synchronisieren.
        </span>
      )}
    </div>
  );
}
