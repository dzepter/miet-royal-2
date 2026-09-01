'use client';

import Link from 'next/link';
import { AuthGuard, useMe } from '../components/auth-guard';
import { hasPermission } from '../lib/api';

function Home() {
  const me = useMe();
  return (
    <main className="page">
      <h1>Willkommen{me !== null ? `, ${me.user.firstName}` : ''}!</h1>
      <div className="grid-2">
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
          <h2>Fachbereiche</h2>
          <p className="muted">
            „Heute“, Vorgänge, Kalender sowie Maschinen &amp; Lager folgen ab Phase 2.
          </p>
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
