'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../../components/auth-guard';
import { apiFetch, hasPermission } from '../../../lib/api';
import { formatBerlin } from '../../../lib/handover';

/**
 * Risikohinweise (Phase-6-Order §§45–47): bereits zugewiesene Maschinen,
 * die für eine laufende/zukünftige Buchung problematisch geworden sind.
 * Keine automatische Neuzuweisung – Admin prüft und markiert „Geprüft“.
 */
interface IncidentRow {
  id: string;
  machineCode: string;
  processId: string;
  processNumber: string;
  reasonKind: 'status' | 'block';
  reasonText: string;
  createdAt: string;
}

function RiskView() {
  const me = useMe();
  const [rows, setRows] = useState<IncidentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const result = await apiFetch<{ incidents: IncidentRow[] }>('/staff/machine-risk-incidents');
    if (result.data !== null) setRows(result.data.incidents);
    else setError(result.errorMessage ?? 'Hinweise konnten nicht geladen werden.');
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <main className="page">
      <p>
        <Link href="/maschinen">← Maschinen</Link>
      </p>
      <h1>Risikohinweise zu zugewiesenen Maschinen</h1>
      {error !== null && <p className="error">{error}</p>}
      {rows !== null && rows.length === 0 && <p className="muted">Keine offenen Hinweise.</p>}
      {(rows ?? []).map((row) => (
        <div className="conflict-box" key={row.id} data-testid={`risk-${row.machineCode}`}>
          <strong>⚠️ {row.machineCode}</strong> ·{' '}
          <Link href={`/vorgaenge/${row.processId}/ausgabe`}>{row.processNumber}</Link>
          <div>{row.reasonText}</div>
          <div className="muted">seit {formatBerlin(row.createdAt)}</div>
          {hasPermission(me, 'machine.block') && (
            <p style={{ margin: '0.4rem 0 0' }}>
              <button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void apiFetch(`/staff/machine-risk-incidents/${row.id}/acknowledge`, {
                    method: 'POST',
                  }).then(async (result) => {
                    setBusy(false);
                    if (!result.ok) setError(result.errorMessage ?? 'Aktion fehlgeschlagen.');
                    await load();
                  });
                }}
              >
                Geprüft
              </button>
            </p>
          )}
        </div>
      ))}
    </main>
  );
}

export default function RiskPage() {
  return (
    <AuthGuard>
      <RiskView />
    </AuthGuard>
  );
}
