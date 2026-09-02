'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../components/auth-guard';
import { apiFetch, hasPermission } from '../../lib/api';
import { formatBerlin } from '../../lib/commerce';
import { fromBerlinInput } from '../../lib/scheduling';

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
      <SubstitutionSection users={users} />
    </main>
  );
}

interface SubstitutionRow {
  id: string;
  originalUserId: string;
  substituteUserId: string;
  originalName: string;
  substituteName: string;
  startsAt: string;
  endsAt: string;
  endedEarlyAt: string | null;
}

/**
 * Vertretungen (Order §12): Admin trägt Ursprung, Vertretung und Zeitraum
 * ein – sofort wirksam, mit einem Klick vorzeitig beendbar. Nur aktive
 * Mitarbeiter wählbar; Überlappungen lehnt der Server ab.
 */
function SubstitutionSection({ users }: { users: UserRow[] }) {
  const me = useMe();
  const [rows, setRows] = useState<SubstitutionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    originalUserId: '',
    substituteUserId: '',
    startsAt: '',
    endsAt: '',
  });
  const canManage = hasPermission(me, 'substitution.manage');

  const load = useCallback(async () => {
    if (!canManage) return;
    const result = await apiFetch<{ substitutions: SubstitutionRow[] }>('/staff/substitutions');
    if (result.data !== null) setRows(result.data.substitutions);
  }, [canManage]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!canManage) return null;
  const active = users.filter((user) => user.status === 'active');
  const now = Date.now();

  return (
    <div className="card">
      <h2>Vertretungen</h2>
      {error !== null && <p className="error">{error}</p>}
      <div className="grid-2">
        <div>
          <label htmlFor="sub-original">Ursprünglicher Mitarbeiter</label>
          <select
            id="sub-original"
            value={form.originalUserId}
            onChange={(e) => setForm({ ...form, originalUserId: e.target.value })}
          >
            <option value="">– wählen –</option>
            {active.map((user) => (
              <option key={user.id} value={user.id}>
                {user.lastName}, {user.firstName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="sub-substitute">Vertretung</label>
          <select
            id="sub-substitute"
            value={form.substituteUserId}
            onChange={(e) => setForm({ ...form, substituteUserId: e.target.value })}
          >
            <option value="">– wählen –</option>
            {active.map((user) => (
              <option key={user.id} value={user.id}>
                {user.lastName}, {user.firstName}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="muted" style={{ margin: '0.3rem 0 0' }}>
        Zeiten in Europe/Berlin.
      </p>
      <div className="grid-2">
        <div>
          <label htmlFor="sub-start">Beginn</label>
          <input
            id="sub-start"
            type="datetime-local"
            value={form.startsAt}
            onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="sub-end">Ende</label>
          <input
            id="sub-end"
            type="datetime-local"
            value={form.endsAt}
            onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
          />
        </div>
      </div>
      <p>
        <button
          className="primary"
          disabled={
            busy ||
            form.originalUserId === '' ||
            form.substituteUserId === '' ||
            form.startsAt === '' ||
            form.endsAt === ''
          }
          onClick={() => {
            setBusy(true);
            setError(null);
            void apiFetch('/staff/substitutions', {
              method: 'POST',
              body: {
                originalUserId: form.originalUserId,
                substituteUserId: form.substituteUserId,
                // Eingaben gelten als Europe-Berlin-Wanduhrzeit (Order §3).
                startsAt: fromBerlinInput(form.startsAt),
                endsAt: fromBerlinInput(form.endsAt),
              },
            }).then(async (result) => {
              setBusy(false);
              if (!result.ok) {
                setError(result.errorMessage ?? 'Vertretung konnte nicht angelegt werden.');
                return;
              }
              setForm({ originalUserId: '', substituteUserId: '', startsAt: '', endsAt: '' });
              await load();
            });
          }}
        >
          Vertretung eintragen
        </button>
      </p>
      {rows.length === 0 ? (
        <p className="muted">Keine Vertretungen eingetragen.</p>
      ) : (
        rows.map((row) => {
          const effectiveEnd =
            row.endedEarlyAt !== null && new Date(row.endedEarlyAt) < new Date(row.endsAt)
              ? row.endedEarlyAt
              : row.endsAt;
          const isActive =
            new Date(row.startsAt).getTime() <= now && now < new Date(effectiveEnd).getTime();
          const isEnded = now >= new Date(effectiveEnd).getTime();
          return (
            <div className="list-row" key={row.id}>
              <div>
                {row.originalName} → <strong>{row.substituteName}</strong>
                <div className="muted">
                  {formatBerlin(row.startsAt)} bis {formatBerlin(effectiveEnd)}
                  {row.endedEarlyAt !== null && ' (vorzeitig beendet)'}
                </div>
              </div>
              <div>
                {isActive && <span className="badge active">Aktiv</span>}{' '}
                {isEnded && <span className="badge locked">Beendet</span>}{' '}
                {!isEnded && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void apiFetch(`/staff/substitutions/${row.id}/end`, { method: 'POST' }).then(
                        async (result) => {
                          setBusy(false);
                          if (!result.ok) {
                            setError(result.errorMessage ?? 'Beenden fehlgeschlagen.');
                            return;
                          }
                          await load();
                        },
                      );
                    }}
                  >
                    Jetzt beenden
                  </button>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

export default function EmployeeListPage() {
  return (
    <AuthGuard>
      <EmployeeList />
    </AuthGuard>
  );
}
