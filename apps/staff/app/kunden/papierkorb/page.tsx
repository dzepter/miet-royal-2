'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard } from '../../../components/auth-guard';
import { apiFetch } from '../../../lib/api';

interface TrashRow {
  id: string;
  type: 'private' | 'organization';
  firstName: string | null;
  lastName: string | null;
  organizationName: string | null;
  deletedAt: string;
}

function TrashView() {
  const [rows, setRows] = useState<TrashRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const result = await apiFetch<{ customers: TrashRow[] }>('/staff/trash/customers');
    if (result.data !== null) {
      setRows(result.data.customers);
      setError(null);
    } else {
      setError(result.errorMessage ?? 'Papierkorb konnte nicht geladen werden.');
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function restore(id: string, name: string): Promise<void> {
    setBusy(true);
    setNotice(null);
    const result = await apiFetch(`/staff/trash/customers/${id}/restore`, {
      method: 'POST',
      body: {},
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Wiederherstellen fehlgeschlagen.');
      return;
    }
    setNotice(`„${name}“ wurde wiederhergestellt.`);
    await load();
  }

  return (
    <main className="page">
      <p>
        <Link href="/kunden">← Kunden</Link>
      </p>
      <h1>Papierkorb</h1>
      <p className="muted">
        Gelöschte Kunden können 30 Tage lang wiederhergestellt werden. Kunden mit Vorgängen können
        nicht gelöscht werden.
      </p>
      {error !== null && <p className="error">{error}</p>}
      {notice !== null && <p className="success">{notice}</p>}
      <div className="card">
        {loaded && rows.length === 0 && <p className="muted">Der Papierkorb ist leer.</p>}
        {rows.map((row) => {
          const name =
            row.type === 'organization'
              ? (row.organizationName ?? 'Organisation')
              : `${row.lastName ?? ''}, ${row.firstName ?? ''}`;
          return (
            <div className="list-row" key={row.id}>
              <div>
                {name}
                <div className="muted">
                  Gelöscht am {new Date(row.deletedAt).toLocaleDateString('de-DE')}
                </div>
              </div>
              <button disabled={busy} onClick={() => void restore(row.id, name)}>
                Wiederherstellen
              </button>
            </div>
          );
        })}
      </div>
    </main>
  );
}

export default function TrashPage() {
  return (
    <AuthGuard>
      <TrashView />
    </AuthGuard>
  );
}
