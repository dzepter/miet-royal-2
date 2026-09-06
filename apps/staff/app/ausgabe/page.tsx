'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthGuard, useMe } from '../../components/auth-guard';
import { apiFetch, hasPermission } from '../../lib/api';
import { formatBerlin } from '../../lib/handover';

/**
 * AUSGABE (Phase-6-Order §12): operativer Bereich für Tablet/Smartphone –
 * heutige Abholungen und Lieferungen sowie bestätigte, noch ungeplante
 * Ausgaben. Große Touchziele, keine Tabellenwand.
 */
interface IssueEntry {
  bookingId: string;
  processId: string;
  processNumber: string;
  customerName: string;
  fulfillment: 'pickup' | 'delivery';
  machineTypeName: string | null;
  machineQuantity: number;
  appointmentKind: string | null;
  startAt: string | null;
  endAt: string | null;
  assigneeName: string | null;
  handoverStatus: 'draft' | 'finalized' | null;
  preparation: 'none' | 'partial' | 'prepared';
  unscheduled: boolean;
}

const PREPARATION_LABELS: Record<IssueEntry['preparation'], string> = {
  none: 'Noch nicht vorbereitet',
  partial: 'Teilweise vorbereitet',
  prepared: 'Vorbereitet',
};

function berlinToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
}

function IssueView() {
  const me = useMe();
  const [date, setDate] = useState(berlinToday());
  const [entries, setEntries] = useState<IssueEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Schneller Tageswechsel: eine verspätete ältere Antwort darf die
  // aktuell gewählte Liste nicht überschreiben.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    const result = await apiFetch<{ date: string; entries: IssueEntry[] }>(
      `/staff/handover/day?date=${encodeURIComponent(date)}`,
    );
    if (seq !== requestSeq.current) return;
    if (result.data !== null) {
      setEntries(result.data.entries);
      setError(null);
    } else {
      setError(result.errorMessage ?? 'Ausgaben konnten nicht geladen werden.');
    }
  }, [date]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!hasPermission(me, 'handover.view')) {
    return (
      <main className="page">
        <h1>Ausgabe</h1>
        <p className="muted">Dir fehlt das Recht, den Ausgabe-Bereich einzusehen.</p>
      </main>
    );
  }

  const scheduled = (entries ?? []).filter((entry) => !entry.unscheduled);
  const unscheduled = (entries ?? []).filter((entry) => entry.unscheduled);

  const card = (entry: IssueEntry) => (
    <Link
      key={entry.bookingId}
      href={`/vorgaenge/${entry.processId}/ausgabe`}
      className="card touch-card"
      data-testid={`issue-${entry.processNumber}`}
    >
      <div className="list-row" style={{ alignItems: 'flex-start' }}>
        <div>
          <strong style={{ fontSize: '1.1rem' }}>
            {entry.appointmentKind === 'delivery' ? '🚚 Lieferung' : '🏬 Abholung'} ·{' '}
            {entry.processNumber}
          </strong>
          <div>{entry.customerName}</div>
          <div className="muted">
            {entry.machineQuantity > 1 ? `${entry.machineQuantity} × ` : ''}
            {entry.machineTypeName ?? 'Maschine'} · Mitarbeiter:{' '}
            {entry.assigneeName ?? 'nicht zugewiesen'}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '1.2rem' }}>
            {entry.startAt === null
              ? 'Zeit festlegen'
              : `${formatBerlin(entry.startAt).slice(-5)} Uhr`}
          </div>
          <span className={`badge ${entry.preparation === 'prepared' ? 'ok' : 'locked'}`}>
            {PREPARATION_LABELS[entry.preparation]}
          </span>
        </div>
      </div>
    </Link>
  );

  return (
    <main className="page">
      <h1>Ausgabe</h1>
      <p>
        <label htmlFor="issue-date">Tag</label>{' '}
        <input id="issue-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />{' '}
        <button onClick={() => setDate(berlinToday())}>Heute</button>
      </p>
      {error !== null && <p className="error">{error}</p>}
      {entries === null && <p className="muted">Lade …</p>}
      {entries !== null && scheduled.length === 0 && (
        <p className="muted">Keine Abholungen oder Lieferungen an diesem Tag.</p>
      )}
      {scheduled.map(card)}
      {unscheduled.length > 0 && (
        <>
          <h2>Bestätigt, aber noch ohne Zeit</h2>
          {unscheduled.map(card)}
        </>
      )}
    </main>
  );
}

export default function IssuePage() {
  return (
    <AuthGuard>
      <IssueView />
    </AuthGuard>
  );
}
