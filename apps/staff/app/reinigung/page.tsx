'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { cleaningOverdue, sortByCleaningPriority } from '@mietroyal/domain';
import { AuthGuard, useMe } from '../../components/auth-guard';
import { apiFetch, hasPermission } from '../../lib/api';
import { formatBerlin } from '../../lib/handover';
import { useOffline } from '../../lib/offline/provider';
import type { MachineCondition } from '../../lib/returns';
import { MACHINE_STATUS_ICONS, type MachineListRow } from '../../lib/warehouse';

/**
 * Reinigungsliste (Phase-8-Order §§25, 50): alle Maschinen in Reinigung,
 * länger als 24 h zuerst und rot markiert, danach die am längsten in Reinigung
 * befindliche. „Gereinigt & einsatzbereit“ läuft über die bestehende Route;
 * offline wird daraus eine Mutation („Reinigung … offline erfasst –
 * Synchronisierung ausstehend“). Sortierung/Überfälligkeit kommen aus
 * `@mietroyal/domain` – dieselben Regeln wie im Server.
 */
interface CleaningRow {
  id: string;
  machineCode: string;
  productName: string;
  cleaningSince: string | null;
  offlinePendingCleanComplete: boolean;
}

/** Offline liefert der Router Reinigungsbeginn/Pending direkt in der Liste, online nicht. */
type MachineListResponse = {
  machines: (MachineListRow & {
    cleaningSince?: string | null;
    offlinePendingCleanComplete?: boolean;
  })[];
};

function CleaningView() {
  const me = useMe();
  const offline = useOffline();
  const [rows, setRows] = useState<CleaningRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingNotice, setPendingNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canView = hasPermission(me, 'machine.view');
  const canClean = hasPermission(me, 'machine.clean_complete');

  const load = useCallback(async () => {
    const result = await apiFetch<MachineListResponse>('/staff/machines');
    if (result.data === null) {
      setError(result.errorMessage ?? 'Maschinen konnten nicht geladen werden.');
      return;
    }
    const cleaning = result.data.machines.filter((machine) => machine.status === 'cleaning');
    const resolved: CleaningRow[] = [];
    for (const machine of cleaning) {
      if (machine.cleaningSince !== undefined) {
        resolved.push({
          id: machine.id,
          machineCode: machine.machineCode,
          productName: machine.productName,
          cleaningSince: machine.cleaningSince,
          offlinePendingCleanComplete: machine.offlinePendingCleanComplete === true,
        });
        continue;
      }
      // Online: Reinigungsbeginn aus dem Zustand der Maschine (Phase-7-Route).
      const condition = await apiFetch<MachineCondition>(`/staff/machines/${machine.id}/condition`);
      resolved.push({
        id: machine.id,
        machineCode: machine.machineCode,
        productName: machine.productName,
        cleaningSince: condition.data?.cleaning.since ?? null,
        offlinePendingCleanComplete: condition.data?.offlinePendingCleanComplete === true,
      });
    }
    setRows(sortByCleaningPriority(resolved, new Date()));
    setError(null);
  }, []);
  useEffect(() => {
    if (canView) void load();
  }, [canView, load]);

  async function completeCleaning(row: CleaningRow) {
    setBusy(true);
    setError(null);
    setNotice(null);
    setPendingNotice(null);
    const result = await apiFetch<{ offlinePending?: boolean }>(
      `/staff/machines/${row.id}/clean-complete`,
      { method: 'POST', body: {} },
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Aktion fehlgeschlagen.');
      return;
    }
    if (result.data?.offlinePending === true) {
      setPendingNotice(
        `Reinigung ${row.machineCode} offline erfasst – Synchronisierung ausstehend.`,
      );
    } else {
      setNotice(`Maschine ${row.machineCode} ist gereinigt und einsatzbereit.`);
    }
    await load();
  }

  if (!canView) {
    return (
      <main className="page">
        <h1>Reinigung</h1>
        <p className="muted">Dir fehlt das Recht, Maschinen einzusehen.</p>
      </main>
    );
  }

  const now = new Date();

  return (
    <main className="page">
      <p>
        <Link href="/tablet">← Lager-Tablet</Link>
      </p>
      <h1>Reinigung</h1>
      {offline !== null && offline.state.connectivity === 'offline' && (
        <div className="offline-banner" data-testid="cleaning-offline-banner">
          Offline – Reinigungsabschlüsse werden lokal gespeichert und später synchronisiert.
        </div>
      )}
      {error !== null && <p className="error">{error}</p>}
      {notice !== null && <p className="success">{notice}</p>}
      {pendingNotice !== null && (
        <p className="success" data-testid="cleaning-pending">
          {pendingNotice}
        </p>
      )}
      {rows === null && error === null && <p className="muted">Lade …</p>}
      {rows !== null && rows.length === 0 && <p className="muted">Keine Maschine in Reinigung.</p>}
      {rows?.map((row) => {
        const overdue = cleaningOverdue(row.cleaningSince, now);
        return (
          <div
            key={row.id}
            className={overdue ? 'card conflict-box cleaning-warning' : 'card'}
            data-testid={`cleaning-${row.machineCode}`}
            data-overdue={overdue ? 'true' : 'false'}
          >
            <div className="list-row" style={{ alignItems: 'flex-start' }}>
              <div>
                <strong style={{ fontSize: '1.1rem' }}>
                  {MACHINE_STATUS_ICONS.cleaning} {row.machineCode}
                </strong>{' '}
                · {row.productName}
                <div className={overdue ? 'error' : 'muted'}>
                  {overdue ? '⚠️ ' : ''}In Reinigung seit {formatBerlin(row.cleaningSince)}
                  {overdue ? ' – länger als 24 Stunden' : ''}
                </div>
                {row.offlinePendingCleanComplete && (
                  <span className="badge" data-testid={`cleaning-pending-${row.machineCode}`}>
                    Offline erfasst – Synchronisierung ausstehend
                  </span>
                )}
              </div>
              <div>
                {canClean && !row.offlinePendingCleanComplete && (
                  <button
                    className="primary big"
                    data-testid={`clean-complete-${row.machineCode}`}
                    disabled={busy}
                    onClick={() => void completeCleaning(row)}
                  >
                    Gereinigt &amp; einsatzbereit
                  </button>
                )}{' '}
                <Link href={`/maschinen/${row.id}`} className="button-like">
                  Maschine
                </Link>
              </div>
            </div>
          </div>
        );
      })}
    </main>
  );
}

export default function CleaningPage() {
  return (
    <AuthGuard>
      <CleaningView />
    </AuthGuard>
  );
}
