'use client';

import { useCallback, useEffect, useState } from 'react';
import { AuthGuard } from '../../components/auth-guard';
import { apiFetch } from '../../lib/api';

interface RoleRow {
  id: string;
  name: string;
  permissionKeys: string[];
}
interface PermissionMeta {
  key: string;
  category: string;
  label: string;
  explanation: string;
  adminInfra: boolean;
  hasCustomExplanation: boolean;
}

/**
 * Erklärtext je Funktion (wird Mitarbeitenden ohne Recht angezeigt).
 * Bewusst kleine Admin-Möglichkeit – kein CMS (Phase-1-Vorgabe Nr. 13).
 */
function ExplanationEditor({ catalog, onSaved }: { catalog: Catalog; onSaved: () => void }) {
  const [selectedKey, setSelectedKey] = useState('');
  const [text, setText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const selected = catalog.permissions.find((p) => p.key === selectedKey);

  return (
    <div className="card">
      <h2>Erklärtexte für gesperrte Funktionen</h2>
      <p className="muted">
        Dieser Text erscheint, wenn jemandem das Recht fehlt. Leer speichern stellt den Standardtext
        wieder her.
      </p>
      <label htmlFor="expl-key">Funktion</label>
      <select
        id="expl-key"
        value={selectedKey}
        onChange={(e) => {
          setSelectedKey(e.target.value);
          const meta = catalog.permissions.find((p) => p.key === e.target.value);
          setText(meta?.hasCustomExplanation === true ? meta.explanation : '');
          setMessage(null);
        }}
      >
        <option value="">Bitte wählen …</option>
        {catalog.permissions
          .filter((p) => !p.adminInfra)
          .map((p) => (
            <option key={p.key} value={p.key}>
              {p.label} ({p.key})
            </option>
          ))}
      </select>
      {selected !== undefined && (
        <>
          <p className="muted">Aktuell: „{selected.explanation}“</p>
          <label htmlFor="expl-text">Eigener Text (leer = Standard)</label>
          <textarea
            id="expl-text"
            rows={3}
            maxLength={500}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {message !== null && <p className="success">{message}</p>}
          <button
            className="primary"
            onClick={() => {
              void (async () => {
                const result = await apiFetch(
                  `/staff/permissions/${encodeURIComponent(selectedKey)}/explanation`,
                  { method: 'PUT', body: { explanation: text } },
                );
                setMessage(
                  result.ok ? 'Erklärtext gespeichert.' : (result.errorMessage ?? 'Fehler.'),
                );
                if (result.ok) onSaved();
              })();
            }}
          >
            Erklärtext speichern
          </button>
        </>
      )}
    </div>
  );
}
interface Catalog {
  categories: { key: string; label: string }[];
  permissions: PermissionMeta[];
}

/**
 * Rechte verständlich nach Kategorien gruppiert; auf dem Smartphone sind die
 * Kategorien eingeklappt (keine Enterprise-Matrix).
 */
function PermissionPicker({
  catalog,
  selected,
  onToggle,
}: {
  catalog: Catalog;
  selected: ReadonlySet<string>;
  onToggle: (key: string, checked: boolean) => void;
}) {
  return (
    <div>
      {catalog.categories.map((category) => {
        const items = catalog.permissions.filter((p) => p.category === category.key);
        if (items.length === 0) return null;
        const checkedCount = items.filter((p) => selected.has(p.key)).length;
        return (
          <details className="perm-category" key={category.key}>
            <summary>
              {category.label}{' '}
              <span className="muted">
                ({checkedCount}/{items.length})
              </span>
            </summary>
            <div className="perm-items">
              {items.map((permission) => (
                <div className="perm-item" key={permission.key}>
                  <input
                    type="checkbox"
                    id={`perm-${permission.key}`}
                    checked={selected.has(permission.key)}
                    onChange={(e) => onToggle(permission.key, e.target.checked)}
                  />
                  <label htmlFor={`perm-${permission.key}`} style={{ margin: 0 }}>
                    {permission.label} <span className="muted">({permission.key})</span>
                  </label>
                </div>
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function RolesAdmin() {
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [editing, setEditing] = useState<{
    id: string | null;
    name: string;
    keys: Set<string>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const rolesResult = await apiFetch<{ roles: RoleRow[] }>('/staff/roles');
    if (rolesResult.data !== null) setRoles(rolesResult.data.roles);
    const catalogResult = await apiFetch<Catalog>('/staff/permissions');
    if (catalogResult.data !== null) setCatalog(catalogResult.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (editing === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = { name: editing.name, permissionKeys: [...editing.keys] };
    const result =
      editing.id === null
        ? await apiFetch('/staff/roles', { method: 'POST', body })
        : await apiFetch(`/staff/roles/${editing.id}`, { method: 'PATCH', body });
    setBusy(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Speichern fehlgeschlagen.');
      return;
    }
    setNotice('Rolle gespeichert.');
    setEditing(null);
    await load();
  }

  async function removeRole(roleId: string) {
    setError(null);
    setNotice(null);
    const result = await apiFetch(`/staff/roles/${roleId}`, { method: 'DELETE' });
    if (!result.ok) setError(result.errorMessage ?? 'Löschen fehlgeschlagen.');
    else setNotice('Rolle gelöscht.');
    await load();
  }

  return (
    <main className="page">
      <h1>Rollen &amp; Rechte</h1>
      <p className="muted">
        Rollen sind frei benennbare Vorlagen – individuelle Rechte pflegst du direkt am Mitarbeiter.
      </p>
      {error !== null && <p className="error">{error}</p>}
      {notice !== null && <p className="success">{notice}</p>}

      {editing === null ? (
        <div className="card">
          <button
            className="primary"
            onClick={() => setEditing({ id: null, name: '', keys: new Set() })}
          >
            Neue Rolle anlegen
          </button>
        </div>
      ) : (
        <div className="card">
          <h2>{editing.id === null ? 'Neue Rolle' : 'Rolle bearbeiten'}</h2>
          <label htmlFor="role-name">Name</label>
          <input
            id="role-name"
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            required
          />
          {catalog !== null && (
            <PermissionPicker
              catalog={catalog}
              selected={editing.keys}
              onToggle={(key, checked) => {
                const keys = new Set(editing.keys);
                if (checked) keys.add(key);
                else keys.delete(key);
                setEditing({ ...editing, keys });
              }}
            />
          )}
          <p>
            <button
              className="primary"
              onClick={() => void save()}
              disabled={busy || editing.name === ''}
            >
              Speichern
            </button>{' '}
            <button onClick={() => setEditing(null)}>Abbrechen</button>
          </p>
        </div>
      )}

      {catalog !== null && <ExplanationEditor catalog={catalog} onSaved={() => void load()} />}

      <div className="card">
        {roles.length === 0 && <p className="muted">Noch keine Rollen.</p>}
        {roles.map((role) => (
          <div className="list-row" key={role.id}>
            <div>
              <strong>{role.name}</strong>
              <div className="muted">{role.permissionKeys.length} Rechte</div>
            </div>
            <div>
              <button
                onClick={() =>
                  setEditing({ id: role.id, name: role.name, keys: new Set(role.permissionKeys) })
                }
              >
                Bearbeiten
              </button>{' '}
              <button className="danger" onClick={() => void removeRole(role.id)}>
                Löschen
              </button>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

export default function RolesPage() {
  return (
    <AuthGuard>
      <RolesAdmin />
    </AuthGuard>
  );
}
