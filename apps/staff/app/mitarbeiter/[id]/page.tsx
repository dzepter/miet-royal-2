'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../../components/auth-guard';
import { apiFetch, hasPermission } from '../../../lib/api';

interface Detail {
  user: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    status: 'active' | 'locked' | 'disabled';
    totpRequired: boolean;
    totpEnabled: boolean;
  };
  roles: { id: string; name: string }[];
  overrides: {
    id: string;
    permissionKey: string;
    effect: 'allow' | 'deny';
    validFrom: string | null;
    validUntil: string | null;
  }[];
  sessions: {
    id: string;
    deviceLabel: string;
    createdAt: string;
    lastActivityAt: string;
    revokedAt: string | null;
  }[];
  effectivePermissions: string[];
}

interface RoleRow {
  id: string;
  name: string;
  permissionKeys: string[];
}
interface PermissionMeta {
  key: string;
  label: string;
  category: string;
}

const STATUS_LABEL = { active: 'aktiv', locked: 'gesperrt', disabled: 'deaktiviert' } as const;

function formatDate(value: string | null): string {
  if (value === null) return '–';
  return new Date(value).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
}

function EmployeeDetail() {
  const params = useParams<{ id: string }>();
  const me = useMe();
  const userId = params.id;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [allRoles, setAllRoles] = useState<RoleRow[]>([]);
  const [permissions, setPermissions] = useState<PermissionMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [resetLink, setResetLink] = useState<string | null>(null);
  const [overrideKey, setOverrideKey] = useState('');
  const [overrideEffect, setOverrideEffect] = useState<'allow' | 'deny'>('allow');
  const [overrideFrom, setOverrideFrom] = useState('');
  const [overrideUntil, setOverrideUntil] = useState('');

  const canManagePermissions = hasPermission(me, 'permission.manage');
  const canRevokeDevices = hasPermission(me, 'device.revoke');

  const load = useCallback(async () => {
    const result = await apiFetch<Detail>(`/staff/users/${userId}`);
    if (result.data !== null) setDetail(result.data);
    const rolesResult = await apiFetch<{ roles: RoleRow[] }>('/staff/roles');
    if (rolesResult.data !== null) setAllRoles(rolesResult.data.roles);
    const permResult = await apiFetch<{ permissions: PermissionMeta[] }>('/staff/permissions');
    if (permResult.data !== null) setPermissions(permResult.data.permissions);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(path: string, body: unknown, method = 'POST') {
    setError(null);
    setNotice(null);
    const result = await apiFetch(path, { method, body });
    if (!result.ok) {
      setError(result.errorMessage ?? 'Aktion fehlgeschlagen.');
    } else {
      setNotice('Gespeichert.');
    }
    await load();
  }

  if (detail === null) {
    return (
      <main className="page">
        <p className="muted">Wird geladen …</p>
      </main>
    );
  }
  const { user } = detail;
  const roleIds = new Set(detail.roles.map((r) => r.id));

  return (
    <main className="page">
      <p>
        <Link href="/mitarbeiter">← Mitarbeiter</Link>
      </p>
      <h1>
        {user.firstName} {user.lastName}{' '}
        <span className={`badge ${user.status}`}>{STATUS_LABEL[user.status]}</span>
      </h1>
      <p className="muted">{user.email}</p>
      {error !== null && <p className="error">{error}</p>}
      {notice !== null && <p className="success">{notice}</p>}

      <div className="card">
        <h2>Status</h2>
        <p className="muted">Sperren/Deaktivieren meldet die Person sofort auf allen Geräten ab.</p>
        {user.status !== 'active' && (
          <button onClick={() => void act(`/staff/users/${user.id}/status`, { status: 'active' })}>
            Reaktivieren
          </button>
        )}{' '}
        {user.status !== 'locked' && (
          <button
            className="danger"
            onClick={() => void act(`/staff/users/${user.id}/status`, { status: 'locked' })}
          >
            Sperren
          </button>
        )}{' '}
        {user.status !== 'disabled' && (
          <button
            className="danger"
            onClick={() => void act(`/staff/users/${user.id}/status`, { status: 'disabled' })}
          >
            Deaktivieren
          </button>
        )}
      </div>

      <div className="card">
        <h2>Passwort</h2>
        <p className="muted">
          Erzeugt einen einmaligen Link (60 Minuten gültig), über den die Person ein neues Passwort
          setzt – der Wiederherstellungsweg ohne E-Mail-Versand.
        </p>
        {resetLink !== null && <p className="code-box">{resetLink}</p>}
        <button
          onClick={() => {
            void (async () => {
              setError(null);
              setNotice(null);
              const result = await apiFetch<{ resetToken: string }>(
                `/staff/users/${user.id}/reset-link`,
                { method: 'POST', body: {} },
              );
              if (result.data !== null) {
                setResetLink(
                  `${window.location.origin}/passwort-zuruecksetzen?token=${result.data.resetToken}`,
                );
              } else {
                setError(result.errorMessage ?? 'Nicht möglich.');
              }
            })();
          }}
        >
          Passwort-Reset-Link erzeugen
        </button>
      </div>

      <div className="card">
        <h2>Zwei-Faktor-Authentifizierung</h2>
        <p>
          Status: {user.totpEnabled ? 'eingerichtet' : 'nicht eingerichtet'}
          {user.totpRequired ? ' · vom Admin verlangt' : ''}
        </p>
        <button
          onClick={() =>
            void act(`/staff/users/${user.id}/totp-requirement`, { required: !user.totpRequired })
          }
        >
          {user.totpRequired ? '2FA-Pflicht aufheben' : '2FA verlangen'}
        </button>{' '}
        {user.totpEnabled && (
          <button
            className="danger"
            onClick={() => void act(`/staff/users/${user.id}/totp-reset`, {})}
          >
            2FA zurücksetzen (Gerät verloren)
          </button>
        )}
      </div>

      {canManagePermissions && (
        <div className="card">
          <h2>Rollen</h2>
          {allRoles.length === 0 && <p className="muted">Noch keine Rollen angelegt.</p>}
          {allRoles.map((role) => (
            <div className="perm-item" key={role.id}>
              <input
                type="checkbox"
                id={`role-${role.id}`}
                checked={roleIds.has(role.id)}
                onChange={(e) => {
                  const next = new Set(roleIds);
                  if (e.target.checked) next.add(role.id);
                  else next.delete(role.id);
                  void act(`/staff/users/${user.id}/roles`, { roleIds: [...next] });
                }}
              />
              <label htmlFor={`role-${role.id}`} style={{ margin: 0 }}>
                {role.name} <span className="muted">({role.permissionKeys.length} Rechte)</span>
              </label>
            </div>
          ))}
        </div>
      )}

      {canManagePermissions && (
        <div className="card">
          <h2>Individuelle Rechte &amp; befristete Sonderrechte</h2>
          {detail.overrides.length === 0 && <p className="muted">Keine individuellen Rechte.</p>}
          {detail.overrides.map((override) => (
            <div className="list-row" key={override.id}>
              <div>
                <strong>{override.effect === 'allow' ? 'Erlaubt' : 'Verweigert'}:</strong>{' '}
                {permissions.find((p) => p.key === override.permissionKey)?.label ??
                  override.permissionKey}
                <div className="muted">
                  {override.validFrom !== null || override.validUntil !== null
                    ? `${formatDate(override.validFrom)} bis ${formatDate(override.validUntil)}`
                    : 'unbefristet'}
                </div>
              </div>
              <button
                className="danger"
                onClick={() => void act(`/staff/overrides/${override.id}`, undefined, 'DELETE')}
              >
                Entfernen
              </button>
            </div>
          ))}
          <h2 style={{ marginTop: '1rem' }}>Recht hinzufügen</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(`/staff/users/${user.id}/overrides`, {
                permissionKey: overrideKey,
                effect: overrideEffect,
                ...(overrideFrom !== '' ? { validFrom: new Date(overrideFrom).toISOString() } : {}),
                ...(overrideUntil !== ''
                  ? { validUntil: new Date(overrideUntil).toISOString() }
                  : {}),
              });
            }}
          >
            <label htmlFor="override-key">Berechtigung</label>
            <select
              id="override-key"
              value={overrideKey}
              onChange={(e) => setOverrideKey(e.target.value)}
              required
            >
              <option value="">Bitte wählen …</option>
              {permissions.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label} ({p.key})
                </option>
              ))}
            </select>
            <label htmlFor="override-effect">Wirkung</label>
            <select
              id="override-effect"
              value={overrideEffect}
              onChange={(e) => setOverrideEffect(e.target.value === 'deny' ? 'deny' : 'allow')}
            >
              <option value="allow">Erlauben</option>
              <option value="deny">Verweigern</option>
            </select>
            <div className="grid-2">
              <div>
                <label htmlFor="override-from">Beginn (optional)</label>
                <input
                  id="override-from"
                  type="datetime-local"
                  value={overrideFrom}
                  onChange={(e) => setOverrideFrom(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="override-until">Ende (optional)</label>
                <input
                  id="override-until"
                  type="datetime-local"
                  value={overrideUntil}
                  onChange={(e) => setOverrideUntil(e.target.value)}
                />
              </div>
            </div>
            <button className="primary" type="submit" disabled={overrideKey === ''}>
              Recht hinzufügen
            </button>
          </form>
        </div>
      )}

      <div className="card">
        <h2>Geräte / Sitzungen</h2>
        {detail.sessions.length === 0 && <p className="muted">Keine Sitzungen.</p>}
        {detail.sessions.map((session) => (
          <div className="list-row" key={session.id}>
            <div>
              {session.deviceLabel}
              <div className="muted">
                Zuletzt aktiv: {formatDate(session.lastActivityAt)}
                {session.revokedAt !== null ? ' · abgemeldet' : ''}
              </div>
            </div>
            {session.revokedAt === null && canRevokeDevices && (
              <button
                className="danger"
                onClick={() => void act(`/staff/sessions/${session.id}/revoke`, {})}
              >
                Abmelden
              </button>
            )}
          </div>
        ))}
        {canRevokeDevices && detail.sessions.some((s) => s.revokedAt === null) && (
          <button
            className="danger"
            onClick={() => void act(`/staff/users/${user.id}/sessions/revoke-all`, {})}
          >
            Alle Geräte abmelden
          </button>
        )}
      </div>

      <div className="card">
        <h2>Effektive Rechte ({detail.effectivePermissions.length})</h2>
        <p className="muted">{detail.effectivePermissions.join(', ') || 'keine'}</p>
      </div>
    </main>
  );
}

export default function EmployeeDetailPage() {
  return (
    <AuthGuard>
      <EmployeeDetail />
    </AuthGuard>
  );
}
