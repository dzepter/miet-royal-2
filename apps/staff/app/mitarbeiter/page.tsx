'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AuthGuard } from '../../components/auth-guard';
import { apiFetch } from '../../lib/api';

interface UserRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  status: 'active' | 'locked' | 'disabled';
  totpEnabled: boolean;
  totpRequired: boolean;
}

const STATUS_LABEL: Record<UserRow['status'], string> = {
  active: 'aktiv',
  locked: 'gesperrt',
  disabled: 'deaktiviert',
};

function EmployeeList() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [setupLink, setSetupLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const result = await apiFetch<{ users: UserRow[] }>('/staff/users');
    if (result.data !== null) setUsers(result.data.users);
  }
  useEffect(() => {
    void load();
  }, []);

  async function createEmployee(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await apiFetch<{ user: UserRow; setupToken: string }>('/staff/users', {
      method: 'POST',
      body: { firstName, lastName, email },
    });
    setBusy(false);
    if (!result.ok || result.data === null) {
      setError(result.errorMessage ?? 'Anlegen fehlgeschlagen.');
      return;
    }
    setSetupLink(
      `${window.location.origin}/passwort-zuruecksetzen?token=${result.data.setupToken}`,
    );
    setFirstName('');
    setLastName('');
    setEmail('');
    setShowCreate(false);
    await load();
  }

  return (
    <main className="page">
      <h1>Mitarbeiter</h1>

      {setupLink !== null && (
        <div className="card">
          <h2>Einrichtungs-Link (nur einmal sichtbar)</h2>
          <p className="muted">
            Gib diesen Link sicher an die neue Person weiter. Darüber setzt sie ihr eigenes Passwort
            (7 Tage gültig).
          </p>
          <p className="code-box">{setupLink}</p>
          <button onClick={() => setSetupLink(null)}>Ausblenden</button>
        </div>
      )}

      <div className="card">
        {showCreate ? (
          <form onSubmit={createEmployee}>
            <h2>Neuen Mitarbeiter anlegen</h2>
            <label htmlFor="firstName">Vorname</label>
            <input
              id="firstName"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              required
            />
            <label htmlFor="lastName">Nachname</label>
            <input
              id="lastName"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              required
            />
            <label htmlFor="new-email">E-Mail</label>
            <input
              id="new-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            {error !== null && <p className="error">{error}</p>}
            <button className="primary" type="submit" disabled={busy}>
              Anlegen
            </button>{' '}
            <button type="button" onClick={() => setShowCreate(false)}>
              Abbrechen
            </button>
          </form>
        ) : (
          <button className="primary" onClick={() => setShowCreate(true)}>
            Neuen Mitarbeiter anlegen
          </button>
        )}
      </div>

      <div className="card">
        {users.length === 0 && <p className="muted">Noch keine Mitarbeiter.</p>}
        {users.map((user) => (
          <div className="list-row" key={user.id}>
            <div>
              <Link href={`/mitarbeiter/${user.id}`}>
                {user.lastName}, {user.firstName}
              </Link>
              <div className="muted">{user.email}</div>
            </div>
            <div>
              <span className={`badge ${user.status}`}>{STATUS_LABEL[user.status]}</span>{' '}
              {user.totpEnabled && <span className="badge">2FA</span>}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

export default function EmployeeListPage() {
  return (
    <AuthGuard>
      <EmployeeList />
    </AuthGuard>
  );
}
