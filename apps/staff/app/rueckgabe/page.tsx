'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../components/auth-guard';
import { QrScanner } from '../../components/qr-scanner';
import { apiFetch, hasPermission } from '../../lib/api';
import { formatBerlin } from '../../lib/handover';
import type { ReturnListEntry, ReturnResolved } from '../../lib/returns';

/**
 * RÜCKGABE-Bereich (Phase-7-Order §§5/6): Tablet/Smartphone-first,
 * überfällige Rückgaben zuerst, dann heute, dann die kommenden Tage (±3),
 * zuletzt bestätigte Ausgaben ohne Rückgabetermin. Einstieg auch per
 * QR-Scan einer ausgegebenen Maschine (Rechte bleiben serverseitig).
 */
const GROUP_TITLES: Record<ReturnListEntry['group'], string> = {
  overdue: 'Überfällige Rückgaben',
  today: 'Heute erwartete Rückgaben',
  upcoming: 'Rückgaben der kommenden Tage',
  unscheduled: 'Ausgegeben, aber ohne Rückgabetermin',
};

function ReturnListView() {
  const me = useMe();
  const router = useRouter();
  const [entries, setEntries] = useState<ReturnListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const canView = hasPermission(me, 'return.view');

  const load = useCallback(async () => {
    const result = await apiFetch<{ entries: ReturnListEntry[] }>('/staff/returns');
    if (result.data !== null) {
      setEntries(result.data.entries);
      setError(null);
    } else {
      setError(result.errorMessage ?? 'Rückgaben konnten nicht geladen werden.');
    }
  }, []);
  useEffect(() => {
    if (canView) void load();
  }, [canView, load]);

  if (!canView) {
    return (
      <main className="page">
        <h1>Rückgabe</h1>
        <p className="muted">Dir fehlt das Recht, den Rückgabe-Bereich einzusehen.</p>
      </main>
    );
  }

  const groups = (['overdue', 'today', 'upcoming', 'unscheduled'] as const).map((group) => ({
    group,
    items: (entries ?? []).filter((entry) => entry.group === group),
  }));

  return (
    <main className="page">
      <h1>Rückgabe</h1>
      <p>
        <button className="primary" onClick={() => setScanning(true)} data-testid="return-scan">
          📷 Maschine scannen
        </button>
      </p>
      {scanning && (
        <QrScanner<ReturnResolved>
          resolvePath="/staff/returns/resolve-qr/"
          onResolved={(resolved) => {
            setScanning(false);
            router.push(`/vorgaenge/${resolved.processId}/rueckgabe`);
          }}
          onClose={() => setScanning(false)}
        />
      )}
      {error !== null && <p className="error">{error}</p>}
      {entries === null && error === null && <p className="muted">Lade …</p>}
      {entries !== null && entries.length === 0 && (
        <p className="muted">Keine offenen Rückgaben in den nächsten Tagen.</p>
      )}
      {groups.map(({ group, items }) =>
        items.length === 0 ? null : (
          <section key={group} className={group === 'overdue' ? 'overdue-card card' : ''}>
            <h2>{GROUP_TITLES[group]}</h2>
            {items.map((entry) => (
              <Link
                key={entry.bookingId}
                href={`/vorgaenge/${entry.processId}/rueckgabe`}
                className="card touch-card"
                data-testid={`return-${entry.processNumber}`}
              >
                <div className="list-row" style={{ alignItems: 'flex-start' }}>
                  <div>
                    <strong style={{ fontSize: '1.1rem' }}>
                      {entry.fulfillment === 'delivery' ? '🚚' : '🏬'} {entry.processNumber}
                    </strong>
                    <div>{entry.customerName}</div>
                    <div className="muted">
                      Maschinen: {entry.machineCodes.join(', ')} · Mitarbeiter:{' '}
                      {entry.assigneeName ?? 'nicht zugewiesen'}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '1.2rem' }}>
                      {entry.plannedAt === null
                        ? 'Kein Rückgabetermin'
                        : `${formatBerlin(entry.plannedAt)} Uhr`}
                    </div>
                    {entry.overdue && <span className="badge locked">Überfällig</span>}{' '}
                    {entry.returnStatus === 'draft' && (
                      <span className="badge">Rückgabe begonnen</span>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </section>
        ),
      )}
    </main>
  );
}

export default function ReturnListPage() {
  return (
    <AuthGuard>
      <ReturnListView />
    </AuthGuard>
  );
}
