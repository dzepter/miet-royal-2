'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../../components/auth-guard';
import { apiFetch, hasPermission } from '../../../lib/api';
import { formatBerlin } from '../../../lib/handover';

/** Admin-Liste „Maschinen-Overrides“ (Phase-6-Order §9): kompakt, keine Filterwand. */
interface OverrideRow {
  id: string;
  machineCode: string;
  processId: string;
  processNumber: string;
  reason: string;
  problemSummary: string;
  confirmedByName: string | null;
  confirmedAt: string;
}

function OverridesView() {
  const me = useMe();
  const [rows, setRows] = useState<OverrideRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void apiFetch<{ overrides: OverrideRow[] }>('/staff/machine-overrides').then((result) => {
      if (result.data !== null) setRows(result.data.overrides);
      else setError(result.errorMessage ?? 'Overrides konnten nicht geladen werden.');
    });
  }, []);
  if (!hasPermission(me, 'machine.override_block')) {
    return (
      <main className="page">
        <h1>Maschinen-Overrides</h1>
        <p className="muted">Dir fehlt das Recht, Overrides einzusehen.</p>
      </main>
    );
  }
  return (
    <main className="page">
      <p>
        <Link href="/maschinen">← Maschinen</Link>
      </p>
      <h1>Maschinen-Overrides</h1>
      {error !== null && <p className="error">{error}</p>}
      {rows !== null && rows.length === 0 && <p className="muted">Keine aktiven Overrides.</p>}
      {(rows ?? []).map((row) => (
        <div className="list-row" key={row.id} data-testid={`override-${row.machineCode}`}>
          <div>
            <strong>{row.machineCode}</strong> ·{' '}
            <Link href={`/vorgaenge/${row.processId}`}>{row.processNumber}</Link>
            <div>Grund: {row.reason}</div>
            <div className="muted">{row.problemSummary}</div>
          </div>
          <div className="muted" style={{ textAlign: 'right' }}>
            {row.confirmedByName ?? '–'}
            <br />
            {formatBerlin(row.confirmedAt)}
          </div>
        </div>
      ))}
    </main>
  );
}

export default function OverridesPage() {
  return (
    <AuthGuard>
      <OverridesView />
    </AuthGuard>
  );
}
