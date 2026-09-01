'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard } from '../../components/auth-guard';
import { apiFetch } from '../../lib/api';
import {
  customerName,
  formatEventDate,
  STATUS_BADGE_CLASS,
  STATUS_LABELS,
  type ProcessRow,
} from '../../lib/crm';

function ProcessList() {
  const [rows, setRows] = useState<ProcessRow[]>([]);
  const [canViewCompleted, setCanViewCompleted] = useState(false);
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (withCompleted: boolean) => {
    const result = await apiFetch<{ processes: ProcessRow[]; canViewCompleted: boolean }>(
      `/staff/processes?includeCompleted=${withCompleted ? 'true' : 'false'}`,
    );
    if (result.data !== null) {
      setRows(result.data.processes);
      setCanViewCompleted(result.data.canViewCompleted);
      setError(null);
    } else {
      setError(result.errorMessage ?? 'Vorgänge konnten nicht geladen werden.');
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load(includeCompleted);
  }, [load, includeCompleted]);

  return (
    <main className="page">
      <h1>Vorgänge</h1>
      {error !== null && <p className="error">{error}</p>}

      {canViewCompleted && (
        <p>
          <label className="perm-item" style={{ display: 'inline-flex' }}>
            <input
              type="checkbox"
              checked={includeCompleted}
              onChange={(e) => setIncludeCompleted(e.target.checked)}
            />
            <span>Abgeschlossene einblenden</span>
          </label>
        </p>
      )}

      <div className="card">
        {loaded && rows.length === 0 && (
          <p className="muted">
            Keine offenen Vorgänge. Lege einen Vorgang über einen Kunden an (Kunden → Kunde öffnen →
            „Vorgang anlegen“).
          </p>
        )}
        {rows.map((process) => (
          <div className="list-row" key={process.id}>
            <div>
              <Link href={`/vorgaenge/${process.id}`}>
                <strong>{process.processNumber}</strong>
              </Link>{' '}
              · {customerName(process)}
              <div className="muted">
                Event: {formatEventDate(process.eventDate)}
                {process.assignedLastName !== null && process.assignedLastName !== undefined
                  ? ` · Zuständig: ${process.assignedFirstName} ${process.assignedLastName}`
                  : ' · Nicht zugewiesen'}
              </div>
            </div>
            <span className={`badge ${STATUS_BADGE_CLASS[process.mainStatus]}`}>
              {STATUS_LABELS[process.mainStatus]}
            </span>
          </div>
        ))}
      </div>
    </main>
  );
}

export default function ProcessesPage() {
  return (
    <AuthGuard>
      <ProcessList />
    </AuthGuard>
  );
}
