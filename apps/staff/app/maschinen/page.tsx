'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthGuard, useMe } from '../../components/auth-guard';
import { apiFetch, hasPermission } from '../../lib/api';
import {
  MACHINE_STATUS_ICONS,
  MACHINE_STATUS_LABELS,
  type MachineListRow,
  type MachineStatus,
} from '../../lib/warehouse';

/**
 * Bereich MASCHINEN & LAGER → Maschinenliste (Order §23): kompakt mit
 * ID, Typ, Status, Standort und aktiver Sperre/Warnung; Filter nach Typ
 * und Status – bewusst keine Filterwand, kein Analytics-Dashboard.
 */
function MachinesView() {
  const me = useMe();
  const [rows, setRows] = useState<MachineListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [createProductId, setCreateProductId] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const canManage = hasPermission(me, 'machine.manage');

  const load = useCallback(async () => {
    const result = await apiFetch<{ machines: MachineListRow[] }>('/staff/machines');
    if (result.data !== null) {
      setRows(result.data.machines);
      setError(null);
    } else {
      setError(result.errorMessage ?? 'Maschinen konnten nicht geladen werden.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const types = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of rows ?? []) map.set(row.productId, row.productName);
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, [rows]);

  const filtered = (rows ?? []).filter(
    (row) =>
      (typeFilter === '' || row.productId === typeFilter) &&
      (statusFilter === '' || row.status === statusFilter),
  );

  return (
    <main className="page">
      <h1>Maschinen</h1>
      <p className="muted">
        Maschinen &amp; Lager · <Link href="/lager">Zum Lager</Link>
      </p>
      {error !== null && <p className="error">{error}</p>}

      <div className="card">
        <div className="list-row">
          <span>
            <label htmlFor="machine-type-filter">Typ</label>{' '}
            <select
              id="machine-type-filter"
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value)}
            >
              <option value="">Alle Typen</option>
              {types.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>{' '}
            <label htmlFor="machine-status-filter">Status</label>{' '}
            <select
              id="machine-status-filter"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">Alle Status</option>
              {(Object.keys(MACHINE_STATUS_LABELS) as MachineStatus[]).map((status) => (
                <option key={status} value={status}>
                  {MACHINE_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </span>
          <span className="muted">{filtered.length} Maschinen</span>
        </div>
      </div>

      <div className="card">
        {rows === null && <p className="muted">Lade …</p>}
        {rows !== null && filtered.length === 0 && (
          <p className="muted">Keine Maschinen für diese Filter.</p>
        )}
        {filtered.map((row) => (
          <div className="list-row" key={row.id} data-testid={`machine-${row.machineCode}`}>
            <div>
              <Link href={`/maschinen/${row.id}`}>
                <strong>{row.machineCode}</strong>
              </Link>{' '}
              · {row.productName}
              <div className="muted">
                {row.locationLabel}
                {row.locationNote !== null ? ` – ${row.locationNote}` : ''}
              </div>
            </div>
            <div>
              <span className="badge">
                <span aria-hidden="true">{MACHINE_STATUS_ICONS[row.status]}</span> {row.statusLabel}
              </span>{' '}
              {row.activeBlockReason !== null && (
                <span className="badge locked">Gesperrt: {row.activeBlockReason}</span>
              )}{' '}
              {row.activeBlockReason === null && row.openBlockCount > 0 && (
                <span className="badge">Sperre geplant</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {canManage && (
        <div className="card">
          <h2>Neue Maschine anlegen</h2>
          <p className="muted">
            Die Maschinen-ID wird serverseitig vergeben (nächste freie Laufnummer des Typs) und ist
            danach unveränderbar.
          </p>
          <label htmlFor="machine-create-type">Maschinentyp</label>
          <select
            id="machine-create-type"
            value={createProductId}
            onChange={(event) => setCreateProductId(event.target.value)}
          >
            <option value="">– Typ wählen –</option>
            {types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>{' '}
          <button
            disabled={createBusy || createProductId === ''}
            onClick={() => {
              setCreateBusy(true);
              void apiFetch('/staff/machines', {
                method: 'POST',
                body: { productId: createProductId },
              }).then(async (result) => {
                setCreateBusy(false);
                if (!result.ok) {
                  setError(result.errorMessage ?? 'Anlegen fehlgeschlagen.');
                  return;
                }
                setCreateProductId('');
                await load();
              });
            }}
          >
            Anlegen
          </button>
        </div>
      )}
    </main>
  );
}

export default function MachinesPage() {
  return (
    <AuthGuard>
      <MachinesView />
    </AuthGuard>
  );
}
