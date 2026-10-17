'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthGuard, useMe, useWarehouseMode } from '../../components/auth-guard';
import { QrScanner } from '../../components/qr-scanner';
import { apiFetch, hasPermission } from '../../lib/api';
import { useOffline } from '../../lib/offline/provider';
import type { ReturnResolved } from '../../lib/returns';

/**
 * Lager-/Tabletmodus (Phase-8-Order §§48–52): große Aktionen AUSGABE /
 * RÜCKGABE / QR SCANNEN / REINIGUNG (optional LAGER), reduzierte Navigation.
 * Reine Darstellung – Rechte kommen unverändert vom Server bzw. aus dem
 * Lease-Snapshot; keine neue Rolle, keine PIN. Der QR-Scan zeigt den
 * passenden operativen Kontext an, der Mitarbeiter entscheidet (§51).
 */
interface ScanResult {
  machineId: string;
  machineCode: string;
  returnBooking: ReturnResolved | null;
  handoverBooking: { processId: string; processNumber: string } | null;
}

function TabletView() {
  const me = useMe();
  const router = useRouter();
  const offline = useOffline();
  const [enabled, setEnabled] = useWarehouseMode();
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);

  const canHandover = hasPermission(me, 'handover.view');
  const canReturn = hasPermission(me, 'return.view');
  const canMachines = hasPermission(me, 'machine.view');
  const canClean = hasPermission(me, 'machine.clean_complete');

  async function resolveScan(
    token: string,
  ): Promise<{ data: ScanResult | null; errorMessage: string | null }> {
    // Token nur im POST-Body – nie in URL oder Protokoll.
    const machine = await apiFetch<{ machineId: string; machineCode: string }>(
      '/staff/machines/qr/resolve',
      { method: 'POST', body: { token } },
    );
    if (machine.data === null) return { data: null, errorMessage: machine.errorMessage };
    const machineId = machine.data.machineId;
    // Kontext zeigen, Mitarbeiter entscheidet (§51) – keine automatische Geschäftsaktion.
    let returnBooking: ReturnResolved | null = null;
    if (canReturn) {
      const candidate = await apiFetch<ReturnResolved>('/staff/returns/resolve-qr', {
        method: 'POST',
        body: { token },
      });
      if (candidate.data !== null) returnBooking = candidate.data;
    }
    // Ausgabe-Kontext: offener Übergabe-Vorgang aus dem lokalen Arbeitspaket, dessen Slot
    // diese Maschine trägt (online wie offline dieselbe Quelle).
    let handoverBooking: ScanResult['handoverBooking'] = null;
    if (canHandover && offline !== null && offline.state.unlocked) {
      for (const booking of await offline.runtime.listBookings()) {
        const handover = booking.handover;
        if (
          handover !== null &&
          handover.handover.status !== 'finalized' &&
          handover.slots.some((slot) => slot.machine?.id === machineId)
        ) {
          handoverBooking = { processId: booking.processId, processNumber: booking.processNumber };
          break;
        }
      }
    }
    return { data: { ...machine.data, returnBooking, handoverBooking }, errorMessage: null };
  }

  return (
    <main className="page">
      <h1>Lager-Tablet</h1>
      {offline !== null && offline.state.connectivity === 'offline' && (
        <div className="offline-banner" data-testid="tablet-offline-banner">
          Offline – Erfassungen werden lokal gespeichert und später synchronisiert
          {offline.state.pending > 0 ? ` (${offline.state.pending} Änderungen ausstehend)` : ''}.
        </div>
      )}
      <div className="tablet-grid" data-testid="tablet-actions">
        {canHandover && (
          <Link href="/ausgabe" className="tablet-action" data-testid="tablet-ausgabe">
            AUSGABE
            <span className="sub">Heutige und ungeplante Ausgaben</span>
          </Link>
        )}
        {canReturn && (
          <Link href="/rueckgabe" className="tablet-action" data-testid="tablet-rueckgabe">
            RÜCKGABE
            <span className="sub">Erwartet heute, überfällig, ±3 Tage</span>
          </Link>
        )}
        {(canMachines || canReturn) && (
          <button
            type="button"
            className="tablet-action"
            data-testid="tablet-qr"
            onClick={() => {
              setScanResult(null);
              setScanning(true);
            }}
          >
            QR SCANNEN
            <span className="sub">Maschine erkennen – dann entscheiden</span>
          </button>
        )}
        {canMachines && (
          <Link href="/reinigung" className="tablet-action" data-testid="tablet-reinigung">
            REINIGUNG
            <span className="sub">Maschinen in Reinigung, älteste zuerst</span>
          </Link>
        )}
        {hasPermission(me, 'inventory.view') && (
          <Link href="/lager" className="tablet-action secondary" data-testid="tablet-lager">
            Lager
            <span className="sub">Bestände laut letzter Synchronisierung</span>
          </Link>
        )}
      </div>
      {scanning && (
        <QrScanner<ScanResult>
          resolve={resolveScan}
          onResolved={(result) => {
            setScanning(false);
            setScanResult(result);
          }}
          onClose={() => setScanning(false)}
        />
      )}
      {scanResult !== null && (
        <div className="card" data-testid="tablet-scan-result">
          <h2>Maschine {scanResult.machineCode}</h2>
          <p>Was möchtest du tun?</p>
          <p>
            {scanResult.handoverBooking !== null && canHandover && (
              <button
                className="primary big"
                data-testid="tablet-scan-ausgabe"
                onClick={() =>
                  router.push(`/vorgaenge/${scanResult.handoverBooking!.processId}/uebergabe`)
                }
              >
                Ausgabe {scanResult.handoverBooking.processNumber}
              </button>
            )}{' '}
            {scanResult.returnBooking !== null && canReturn && (
              <button
                className="primary big"
                data-testid="tablet-scan-rueckgabe"
                onClick={() =>
                  router.push(`/vorgaenge/${scanResult.returnBooking!.processId}/rueckgabe`)
                }
              >
                Rückgabe {scanResult.returnBooking.processNumber}
              </button>
            )}{' '}
            {canMachines && (
              <Link href={`/maschinen/${scanResult.machineId}`} className="button-like big">
                Maschine {canClean ? '/ Reinigung' : ''}
              </Link>
            )}{' '}
            <button className="big" onClick={() => setScanResult(null)}>
              Schließen
            </button>
          </p>
        </div>
      )}
      <p className="muted" style={{ marginTop: '2rem' }}>
        {enabled ? (
          <>
            Die Lageransicht ist auf diesem Gerät aktiv.{' '}
            <button
              className="link-like"
              onClick={() => setEnabled(false)}
              data-testid="warehouse-mode-off"
            >
              Vollansicht auf diesem Gerät verwenden
            </button>
          </>
        ) : (
          <button
            className="link-like"
            onClick={() => setEnabled(true)}
            data-testid="warehouse-mode-on"
          >
            Lageransicht auf diesem Gerät verwenden
          </button>
        )}
      </p>
    </main>
  );
}

export default function TabletPage() {
  return (
    <AuthGuard>
      <TabletView />
    </AuthGuard>
  );
}
