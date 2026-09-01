'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../components/auth-guard';
import { apiFetch, hasPermission } from '../lib/api';
import {
  customerName,
  formatEventDate,
  STATUS_BADGE_CLASS,
  STATUS_LABELS,
  type ProcessRow,
} from '../lib/crm';

interface DashboardData {
  openCount: number | null;
  myProcesses: ProcessRow[];
  recentProcesses: ProcessRow[];
}

function ProcessMiniList({ rows, emptyText }: { rows: ProcessRow[]; emptyText: string }) {
  if (rows.length === 0) return <p className="muted">{emptyText}</p>;
  return (
    <>
      {rows.map((process) => (
        <div className="list-row" key={process.id}>
          <div>
            <Link href={`/vorgaenge/${process.id}`}>{process.processNumber}</Link> ·{' '}
            {customerName(process)}
            <div className="muted">Event: {formatEventDate(process.eventDate)}</div>
          </div>
          <span className={`badge ${STATUS_BADGE_CLASS[process.mainStatus]}`}>
            {STATUS_LABELS[process.mainStatus]}
          </span>
        </div>
      ))}
    </>
  );
}

function Home() {
  const me = useMe();
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const canSeeProcesses = hasPermission(me, 'process.view_all');

  useEffect(() => {
    if (!canSeeProcesses) return;
    void apiFetch<DashboardData>('/staff/dashboard').then((result) => {
      if (result.data !== null) setDashboard(result.data);
    });
  }, [canSeeProcesses]);

  return (
    <main className="page">
      <h1>Willkommen{me !== null ? `, ${me.user.firstName}` : ''}!</h1>

      {canSeeProcesses && dashboard !== null && (
        <>
          <div className="grid-2">
            <div className="card">
              <h2>Offene Vorgänge</h2>
              <p style={{ fontSize: '2rem', margin: 0 }}>{dashboard.openCount ?? '–'}</p>
              <Link href="/vorgaenge">Zur Vorgangsliste</Link>
            </div>
            <div className="card">
              <h2>Meine Vorgänge</h2>
              <ProcessMiniList
                rows={dashboard.myProcesses}
                emptyText="Dir sind derzeit keine offenen Vorgänge zugewiesen."
              />
            </div>
          </div>
          <div className="card">
            <h2>Neueste offene Vorgänge</h2>
            <ProcessMiniList
              rows={dashboard.recentProcesses}
              emptyText="Keine offenen Vorgänge vorhanden."
            />
          </div>
        </>
      )}

      <div className="grid-2">
        {hasPermission(me, 'customer.view') && (
          <div className="card">
            <h2>Kunden</h2>
            <p className="muted">Kundenstammdaten ansehen und pflegen.</p>
            <Link href="/kunden">Zu den Kunden</Link>
          </div>
        )}
        {hasPermission(me, 'employee.manage') && (
          <div className="card">
            <h2>Mitarbeiter</h2>
            <p className="muted">Konten, Status, Geräte, Rechte und 2FA verwalten.</p>
            <Link href="/mitarbeiter">Zur Mitarbeiterverwaltung</Link>
          </div>
        )}
        {hasPermission(me, 'permission.manage') && (
          <div className="card">
            <h2>Rollen &amp; Rechte</h2>
            <p className="muted">Rollen-Vorlagen anlegen und Berechtigungen pflegen.</p>
            <Link href="/rollen">Zu Rollen &amp; Rechten</Link>
          </div>
        )}
        <div className="card">
          <h2>Mein Konto</h2>
          <p className="muted">Passwort, Geräte und Zwei-Faktor-Authentifizierung.</p>
          <Link href="/konto">Zu meinem Konto</Link>
        </div>
        <div className="card">
          <h2>Weitere Fachbereiche</h2>
          <p className="muted">„Heute“, Kalender sowie Maschinen &amp; Lager folgen ab Phase 3.</p>
        </div>
      </div>
    </main>
  );
}

export default function HomePage() {
  return (
    <AuthGuard>
      <Home />
    </AuthGuard>
  );
}
