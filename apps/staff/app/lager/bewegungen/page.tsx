'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AuthGuard } from '../../../components/auth-guard';
import { apiFetch } from '../../../lib/api';

interface MovementRow {
  id: string;
  productName: string;
  kind: 'initial' | 'incoming' | 'issue' | 'return' | 'inventory_adjustment';
  quantityDelta: number;
  resultingStock: number;
  createdByName: string | null;
  createdAt: string;
}

const KIND_LABELS: Record<MovementRow['kind'], string> = {
  initial: 'Anfangsbestand',
  incoming: 'Wareneingang',
  issue: 'Ausgabe',
  return: 'Rücknahme',
  inventory_adjustment: 'Inventurkorrektur',
};

/**
 * Admin-Bewegungshistorie (Order §33): kompakt – Artikel, +/-, Menge, Art,
 * Mitarbeiter, Zeitpunkt. Keine Analytics, keine Statistiken.
 */
function MovementsView() {
  const [rows, setRows] = useState<MovementRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void apiFetch<{ movements: MovementRow[] }>('/staff/inventory/movements').then((result) => {
      if (result.data !== null) setRows(result.data.movements);
      else setError(result.errorMessage ?? 'Bewegungen konnten nicht geladen werden.');
    });
  }, []);

  return (
    <main className="page">
      <p>
        <Link href="/lager">← Lager</Link>
      </p>
      <h1>Lagerbewegungen</h1>
      {error !== null && <p className="error">{error}</p>}
      <div className="card">
        {rows === null && <p className="muted">Lade …</p>}
        {rows !== null && rows.length === 0 && <p className="muted">Noch keine Bewegungen.</p>}
        {(rows ?? []).map((row) => (
          <div className="list-row" key={row.id}>
            <div>
              <strong>{row.productName}</strong>
              <span className="muted"> · {KIND_LABELS[row.kind]}</span>
              <div className="muted">
                {new Date(row.createdAt).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}
                {row.createdByName !== null ? ` · ${row.createdByName}` : ''}
              </div>
            </div>
            <div>
              <strong>
                {row.quantityDelta > 0 ? '+' : ''}
                {row.quantityDelta}
              </strong>
              <span className="muted"> → {row.resultingStock}</span>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

export default function MovementsPage() {
  return (
    <AuthGuard>
      <MovementsView />
    </AuthGuard>
  );
}
