'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react';
import { AuthGuard, useMe } from '../../../components/auth-guard';
import { useOfflineNow } from '../../../components/communication';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { apiFetch, hasPermission, type Me } from '../../../lib/api';
import { formatBerlin } from '../../../lib/handover';
import { berlinWallTimeToIso } from '../../../lib/scheduling';
import {
  assignmentStatusLabel,
  attemptStatusLabel,
  clearanceSourceLabel,
  clearanceStateLabel,
  clearanceTitle,
  clearanceUserName,
  createAssignment,
  createClearance,
  environmentLabel,
  eventResultLabel,
  exerciseStateLabel,
  fetchAdminCatalog,
  fetchAdminOverview,
  fetchAdminUserDetail,
  fetchClearances,
  fetchGates,
  fullName,
  interruptionLabel,
  resetTraining,
  revokeClearance,
  TRAINING_OFFLINE_TEXT,
  TRAINING_OVERRIDE_REASON_REQUIRED,
  TRAINING_RESET_HISTORY_HINT,
  TRAINING_VERIFIED_DEMO_PERMANENT_HINT,
  trainingErrorLabel,
  updateGate,
  type AdminCatalog,
  type AdminOverviewUser,
  type AdminUserDetail,
  type ClearanceView,
  type GateFeatureView,
  type GatesAdminView,
  type TrainingUserRef,
} from '../../../lib/training';

/**
 * Einstellungen → Training (Phase 14, Order §§48, 53, 54, 67, 68; Design Teil 2
 * §4.6; Recht training.manage).
 * Demo: Mitarbeiter-Fortschritt (Pfade, bestandene/offene Übungen, letzter
 * Versuch, Fehlprüfungen, unterbrochene Versuche – nur Metadaten, nie
 * Businessinhalte), Pfad zuweisen, Training zurücksetzen (Historie bleibt),
 * Katalog. Außerhalb der Demo: Live-Sperren je Funktion, Freigaben
 * („Demo-Training bestätigen“) und Overrides mit Pflicht-Begründung. Zwischen
 * Demo und Live fließen keine Daten – Live-Ansichten zeigen nur Live-Zeilen.
 */

const CELL: React.CSSProperties = { padding: '0.4rem 0.25rem', verticalAlign: 'top' };
const ROW: React.CSSProperties = { borderTop: '1px solid #eee' };

function sortUsers(users: TrainingUserRef[]): TrainingUserRef[] {
  return [...users].sort((a, b) =>
    `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`, 'de'),
  );
}

/**
 * Phase 14 Final §9: Auswahllisten für Zuweisung, Freigabe und Override führen keine
 * deaktivierten Mitarbeiter (der Server lehnt sie mit „Der Mitarbeiter ist deaktiviert.“ ab);
 * ihre Historie bleibt in Übersicht und Freigabeliste lesbar.
 */
function mergeUsers(base: TrainingUserRef[], extra: TrainingUserRef[]): TrainingUserRef[] {
  const byId = new Map<string, TrainingUserRef>();
  for (const user of [...base, ...extra]) {
    if (user.status === 'disabled') continue;
    if (!byId.has(user.id)) byId.set(user.id, user);
  }
  return sortUsers([...byId.values()]);
}

/**
 * Mitarbeiterauswahl: Mitarbeiterverwaltung (employee.manage), sonst die
 * bestehenden Staff-Auswahllisten (Kalender/CRM); null, wenn keine Liste
 * erlaubt ist – dann bleiben nur die Personen aus Trainingsdaten wählbar.
 */
async function loadStaffOptions(me: Me): Promise<TrainingUserRef[] | null> {
  if (hasPermission(me, 'employee.manage')) {
    const result = await apiFetch<{
      users: (TrainingUserRef & { status?: 'active' | 'locked' | 'disabled' })[];
    }>('/staff/users');
    if (result.data !== null) {
      return result.data.users
        .filter((user) => user.status !== 'disabled')
        .map(({ id, firstName, lastName }) => ({ id, firstName, lastName }));
    }
  }
  if (
    ['appointment.assign', 'substitution.manage', 'calendar.view_all', 'calendar.manage'].some(
      (key) => hasPermission(me, key),
    )
  ) {
    const result = await apiFetch<{ staff: TrainingUserRef[] }>('/staff/scheduling/staff-options');
    if (result.data !== null) return result.data.staff;
  }
  if (hasPermission(me, 'process.view_all')) {
    const result = await apiFetch<{ staff: TrainingUserRef[] }>('/staff/staff-options');
    if (result.data !== null) return result.data.staff;
  }
  return null;
}

function UserSelect({
  id,
  users,
  value,
  disabled,
  onChange,
}: {
  id: string;
  users: TrainingUserRef[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <>
      <label htmlFor={id}>Mitarbeiter</label>
      <select
        id={id}
        data-testid={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">– bitte wählen –</option>
        {users.map((user) => (
          <option key={user.id} value={user.id}>
            {user.lastName}, {user.firstName}
          </option>
        ))}
      </select>
    </>
  );
}

function DefinitionSelect({
  id,
  label,
  definitions,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  definitions: { key: string; title: string; active: boolean }[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        data-testid={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">– bitte wählen –</option>
        {definitions.map((definition) => (
          <option key={definition.key} value={definition.key} disabled={!definition.active}>
            {definition.title}
            {definition.active ? '' : ' (inaktiv)'}
          </option>
        ))}
      </select>
    </>
  );
}

function UsersUnavailableHint({ context }: { context: string }) {
  return (
    <p className="muted" data-testid="training-users-unavailable">
      Die vollständige Mitarbeiterliste ist für dich nicht verfügbar (Recht „Mitarbeiter verwalten“
      fehlt). Zur Auswahl stehen nur Personen mit vorhandenen {context}.
    </p>
  );
}

/* ── Demo: Fortschritt, Zuweisen, Zurücksetzen, Katalog ─────────────────── */

type ResetScope = 'all' | 'path' | 'definition';

function catalogDefinitions(catalog: AdminCatalog | null) {
  const byKey = new Map<string, { key: string; title: string; version: number; active: boolean }>();
  if (catalog === null) return byKey;
  for (const path of catalog.paths) {
    for (const item of path.items) byKey.set(item.definition.key, item.definition);
  }
  for (const definition of catalog.definitions ?? []) {
    if (!byKey.has(definition.key)) byKey.set(definition.key, definition);
  }
  return byKey;
}

function UserDetailView({
  detail,
  titleByKey,
}: {
  detail: AdminUserDetail;
  titleByKey: Map<string, { title: string }>;
}) {
  return (
    <div data-testid="training-admin-user-detail">
      {detail.assignments.length > 0 && (
        <>
          <h4 style={{ margin: '0.25rem 0' }}>Zuweisungen</h4>
          {detail.assignments.map((assignment) => (
            <div key={assignment.id} style={{ marginBottom: '0.5rem' }}>
              <strong>{assignment.path.title}</strong>{' '}
              <span className="badge">{assignmentStatusLabel(assignment.status)}</span>
              <span className="muted">
                {' '}
                · zugewiesen {formatBerlin(assignment.assignedAt)}
                {assignment.dueAt !== null && ` · fällig bis ${formatBerlin(assignment.dueAt)}`}
                {assignment.round > 1 && ` · Runde ${assignment.round}`}
              </span>
              <ul className="muted" style={{ margin: '0.25rem 0' }}>
                {assignment.items.map((item) => (
                  <li key={item.definition.key}>
                    {item.sequence}. {item.definition.title}: {exerciseStateLabel(item.state)}
                    {item.passedAt !== null && ` (${formatBerlin(item.passedAt)})`}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
      <h4 style={{ margin: '0.25rem 0' }}>Versuche</h4>
      {detail.attempts.length === 0 ? (
        <p className="muted">Noch keine Versuche.</p>
      ) : (
        detail.attempts.map((attempt) => {
          const stepTitle = (stepKey: string | null) =>
            stepKey === null
              ? '–'
              : (attempt.steps.find((step) => step.key === stepKey)?.title ?? stepKey);
          const title =
            attempt.definitionTitle ??
            titleByKey.get(attempt.definitionKey)?.title ??
            attempt.definitionKey;
          return (
            <div
              key={attempt.id}
              className="conflict-box"
              data-testid="training-admin-attempt"
              data-definition={attempt.definitionKey}
              data-status={attempt.status}
              style={{ background: '#fff', borderColor: '#eee' }}
            >
              <strong>{title}</strong>{' '}
              <span className={attempt.status === 'passed' ? 'badge ok' : 'badge'}>
                {attemptStatusLabel(attempt.status)}
              </span>
              <div className="muted">
                Gestartet {formatBerlin(attempt.startedAt)}
                {attempt.completedAt !== null &&
                  ` · bestanden ${formatBerlin(attempt.completedAt)}`}
                {attempt.status === 'interrupted' &&
                  ` · ${interruptionLabel(attempt.interruptionCode)}${
                    attempt.interruptedAt !== null
                      ? ` (${formatBerlin(attempt.interruptedAt)})`
                      : ''
                  }`}
                {' · Fehlprüfungen: '}
                <span data-testid="training-admin-attempt-failed-checks">
                  {attempt.failedCheckCount}
                </span>
              </div>
              {attempt.events.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  <table
                    style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}
                    data-testid="training-admin-events"
                  >
                    <thead>
                      <tr style={{ textAlign: 'left' }}>
                        <th>Zeitpunkt</th>
                        <th>Ereignis</th>
                        <th>Schritt</th>
                        <th>Hinweis</th>
                      </tr>
                    </thead>
                    <tbody>
                      {attempt.events.map((event, index) => (
                        <tr
                          key={`${attempt.id}-${index}`}
                          style={ROW}
                          data-testid="training-admin-event"
                          data-result={event.result}
                          data-error={event.errorCode ?? ''}
                        >
                          <td style={CELL}>{formatBerlin(event.occurredAt)}</td>
                          <td style={CELL}>{eventResultLabel(event.result)}</td>
                          <td style={CELL}>{stepTitle(event.stepKey)}</td>
                          <td style={CELL}>{trainingErrorLabel(event.errorCode)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

function DemoTrainingAdmin({ me }: { me: Me }) {
  const [overview, setOverview] = useState<AdminOverviewUser[] | null>(null);
  const [catalog, setCatalog] = useState<AdminCatalog | null>(null);
  const [directory, setDirectory] = useState<TrainingUserRef[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, AdminUserDetail | 'loading'>>({});
  const [detailError, setDetailError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [assignUser, setAssignUser] = useState('');
  const [assignPath, setAssignPath] = useState('');
  const [assignDue, setAssignDue] = useState('');
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  const [resetUser, setResetUser] = useState('');
  const [resetScope, setResetScope] = useState<ResetScope>('all');
  const [resetPath, setResetPath] = useState('');
  const [resetDefinition, setResetDefinition] = useState('');
  const [resetDialog, setResetDialog] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [overviewResult, catalogResult, staff] = await Promise.all([
      fetchAdminOverview(),
      fetchAdminCatalog(),
      loadStaffOptions(me),
    ]);
    if (overviewResult.data === null) {
      setLoadError(
        overviewResult.errorMessage ?? 'Trainingsübersicht konnte nicht geladen werden.',
      );
      return;
    }
    setOverview(overviewResult.data.users);
    setLoadError(null);
    if (catalogResult.data !== null) setCatalog(catalogResult.data);
    setDirectory(staff);
  }, [me]);

  useEffect(() => {
    void load();
  }, [load]);

  const overviewUsers = (overview ?? []).map((row) => row.user);
  const users = mergeUsers(directory ?? [], overviewUsers);
  const titleByKey = catalogDefinitions(catalog);
  const activePaths = (catalog?.paths ?? []).filter((path) => path.active);
  const definitionOptions = [...titleByKey.values()];
  const userName = (id: string) => {
    const user = users.find((entry) => entry.id === id);
    return user === undefined ? 'Mitarbeiter' : fullName(user);
  };

  async function toggleDetail(userId: string) {
    if (details[userId] !== undefined) {
      setDetails((current) => {
        const next = { ...current };
        delete next[userId];
        return next;
      });
      return;
    }
    setDetails((current) => ({ ...current, [userId]: 'loading' }));
    setDetailError(null);
    const result = await fetchAdminUserDetail(userId);
    if (result.data === null) {
      setDetails((current) => {
        const next = { ...current };
        delete next[userId];
        return next;
      });
      setDetailError(result.errorMessage ?? 'Details konnten nicht geladen werden.');
      return;
    }
    const detail = result.data;
    setDetails((current) => ({
      ...current,
      [userId]: {
        ...detail,
        assignments: detail.assignments ?? [],
        attempts: detail.attempts ?? [],
      },
    }));
  }

  async function assign(event: FormEvent) {
    event.preventDefault();
    if (assignBusy) return;
    if (assignUser === '' || assignPath === '') {
      setAssignError('Bitte Mitarbeiter und Pfad wählen.');
      return;
    }
    setAssignBusy(true);
    setAssignError(null);
    setNotice(null);
    const body =
      assignDue === ''
        ? { userId: assignUser, pathKey: assignPath }
        : {
            userId: assignUser,
            pathKey: assignPath,
            dueAt: berlinWallTimeToIso(assignDue, 23, 59),
          };
    const result = await createAssignment(body);
    setAssignBusy(false);
    if (!result.ok) {
      setAssignError(result.errorMessage ?? 'Zuweisung fehlgeschlagen.');
      return;
    }
    const pathTitle = activePaths.find((path) => path.key === assignPath)?.title ?? 'Pfad';
    setNotice(`Pfad „${pathTitle}“ wurde ${userName(assignUser)} zugewiesen.`);
    setAssignPath('');
    setAssignDue('');
    setDetails({});
    await load();
  }

  const resetReady =
    resetUser !== '' &&
    (resetScope === 'all' ||
      (resetScope === 'path' && resetPath !== '') ||
      (resetScope === 'definition' && resetDefinition !== ''));

  function resetScopeText(): string {
    if (resetScope === 'path') {
      const title = activePaths.find((path) => path.key === resetPath)?.title ?? 'der Pfad';
      return `der Pfad „${title}“`;
    }
    if (resetScope === 'definition') {
      const title = titleByKey.get(resetDefinition)?.title ?? 'die Übung';
      return `die Übung „${title}“`;
    }
    return 'das gesamte Training (alle Pfade und Übungen)';
  }

  async function runReset() {
    if (!resetReady || resetBusy) return;
    setResetBusy(true);
    setResetError(null);
    setNotice(null);
    const body =
      resetScope === 'path'
        ? { userId: resetUser, pathKey: resetPath }
        : resetScope === 'definition'
          ? { userId: resetUser, definitionKey: resetDefinition }
          : { userId: resetUser };
    const result = await resetTraining(body);
    setResetBusy(false);
    setResetDialog(false);
    if (result.data === null) {
      setResetError(result.errorMessage ?? 'Zurücksetzen fehlgeschlagen.');
      return;
    }
    setNotice(
      `Training von ${userName(resetUser)} zurückgesetzt: ${result.data.interruptedAttempts} laufende ` +
        `Versuche unterbrochen, ${result.data.supersededAttempts} bestandene Versuche als Historie ` +
        `markiert, ${result.data.resetAssignments} Zuweisungen in neuer Runde.`,
    );
    setDetails({});
    await load();
  }

  if (loadError !== null) {
    return (
      <p className="error" data-testid="training-admin-error">
        {loadError}
      </p>
    );
  }
  if (overview === null) return <p className="muted">Wird geladen …</p>;

  return (
    <div data-testid="training-admin-demo">
      {notice !== null && (
        <p className="success" data-testid="training-admin-notice" role="status">
          {notice}
        </p>
      )}

      <section className="card" data-testid="training-admin-users">
        <h2>Mitarbeiter</h2>
        <p className="muted">
          Fortschritt je zugewiesenem Pfad, Fehlprüfungen („Übung prüfen“ ohne erfüllte Schritte)
          und unterbrochene Versuche. Details zeigen nur Zeitpunkt, Übung, Schritt und Hinweis –
          keine Geschäftsdaten.
        </p>
        {detailError !== null && <p className="error">{detailError}</p>}
        {overview.length === 0 ? (
          <p className="muted" data-testid="training-admin-users-empty">
            Noch keine Zuweisungen oder Versuche.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th>Mitarbeiter</th>
                  <th>Pfade und Übungen</th>
                  <th>Fehlprüfungen</th>
                  <th>Unterbrochen</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {overview.map((row) => {
                  const detail = details[row.user.id];
                  return (
                    <Fragment key={row.user.id}>
                      <tr style={ROW} data-testid="training-admin-user-row" data-user={row.user.id}>
                        <td style={CELL}>
                          {row.user.lastName}, {row.user.firstName}
                          {row.user.status === 'disabled' && (
                            <>
                              {' '}
                              <span
                                className="badge locked"
                                data-testid="training-admin-user-disabled"
                              >
                                deaktiviert
                              </span>
                            </>
                          )}
                        </td>
                        <td style={CELL}>
                          {row.assignments.length === 0 && (
                            <span className="muted">keine Zuweisung</span>
                          )}
                          {row.assignments.map((assignment) => {
                            const passed = assignment.items.filter(
                              (item) => item.state === 'passed',
                            ).length;
                            return (
                              <div
                                key={assignment.pathKey}
                                data-testid="training-admin-assignment"
                                data-path={assignment.pathKey}
                                data-status={assignment.status}
                              >
                                <strong>{assignment.pathTitle}</strong>{' '}
                                <span data-testid="training-admin-progress">
                                  {passed}/{assignment.items.length}
                                </span>{' '}
                                <span
                                  className={
                                    assignment.status === 'completed' ? 'badge ok' : 'badge'
                                  }
                                >
                                  {assignmentStatusLabel(assignment.status)}
                                </span>
                                {assignment.round > 1 && (
                                  <span className="muted"> · Runde {assignment.round}</span>
                                )}
                                <ul className="muted" style={{ margin: '0.15rem 0 0.4rem' }}>
                                  {assignment.items.map((item) => (
                                    <li
                                      key={item.definitionKey}
                                      data-testid="training-admin-item"
                                      data-key={item.definitionKey}
                                      data-state={item.state}
                                    >
                                      {item.title}: {exerciseStateLabel(item.state)}
                                      {item.lastAttempt !== null &&
                                        ` – letzter Versuch ${attemptStatusLabel(item.lastAttempt.status)}` +
                                          (item.lastAttempt.failedCheckCount > 0
                                            ? `, ${item.lastAttempt.failedCheckCount} Fehlprüfungen`
                                            : '') +
                                          (item.lastAttempt.status === 'interrupted'
                                            ? ` (${interruptionLabel(item.lastAttempt.interruptionCode)})`
                                            : '')}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            );
                          })}
                        </td>
                        <td style={CELL} data-testid="training-admin-failed-checks">
                          {row.failedChecks}
                        </td>
                        <td style={CELL} data-testid="training-admin-interrupted">
                          {row.interruptedAttempts}
                        </td>
                        <td style={CELL}>
                          <button
                            type="button"
                            data-testid="training-admin-user-toggle"
                            disabled={detail === 'loading'}
                            onClick={() => void toggleDetail(row.user.id)}
                          >
                            {detail === undefined ? 'Details' : 'Schließen'}
                          </button>
                        </td>
                      </tr>
                      {detail !== undefined && (
                        <tr data-testid="training-admin-user" data-user={row.user.id}>
                          <td style={CELL} colSpan={5}>
                            {detail === 'loading' ? (
                              <p className="muted">Wird geladen …</p>
                            ) : (
                              <UserDetailView detail={detail} titleByKey={titleByKey} />
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Zuweisen</h2>
        {directory === null && <UsersUnavailableHint context="Zuweisungen oder Versuchen" />}
        <form onSubmit={(event) => void assign(event)} data-testid="training-assign-form">
          <UserSelect
            id="training-assign-user"
            users={users}
            value={assignUser}
            disabled={assignBusy}
            onChange={setAssignUser}
          />
          <label htmlFor="training-assign-path">Pfad</label>
          <select
            id="training-assign-path"
            data-testid="training-assign-path"
            value={assignPath}
            disabled={assignBusy}
            onChange={(event) => setAssignPath(event.target.value)}
          >
            <option value="">– bitte wählen –</option>
            {activePaths.map((path) => (
              <option key={path.key} value={path.key}>
                {path.title}
              </option>
            ))}
          </select>
          <label htmlFor="training-assign-due">Fällig am (optional)</label>
          <input
            id="training-assign-due"
            data-testid="training-assign-due"
            type="date"
            value={assignDue}
            disabled={assignBusy}
            onChange={(event) => setAssignDue(event.target.value)}
          />
          {assignError !== null && (
            <p className="error" data-testid="training-assign-error" role="alert">
              {assignError}
            </p>
          )}
          <button
            className="primary"
            type="submit"
            data-testid="training-assign"
            disabled={assignBusy}
          >
            {assignBusy ? 'Wird zugewiesen …' : 'Zuweisen'}
          </button>
        </form>
      </section>

      <section className="card" data-testid="training-reset-form">
        <h2>Training zurücksetzen</h2>
        <p className="muted">
          Bewusste Aktion für eine neue Fortschrittsrunde: laufende Versuche werden unterbrochen,
          bestandene Übungen zählen in der neuen Runde nicht mehr. {TRAINING_RESET_HISTORY_HINT}
        </p>
        <UserSelect
          id="training-reset-user"
          users={users}
          value={resetUser}
          disabled={resetBusy}
          onChange={setResetUser}
        />
        <fieldset style={{ border: 0, padding: 0, margin: '0.5rem 0' }}>
          <legend>Umfang</legend>
          <label style={{ display: 'block' }}>
            <input
              type="radio"
              name="training-reset-scope"
              value="all"
              data-testid="training-reset-scope-all"
              checked={resetScope === 'all'}
              disabled={resetBusy}
              onChange={() => setResetScope('all')}
            />{' '}
            Gesamter Mitarbeiter (alle Pfade und Übungen)
          </label>
          <label style={{ display: 'block' }}>
            <input
              type="radio"
              name="training-reset-scope"
              value="path"
              data-testid="training-reset-scope-path"
              checked={resetScope === 'path'}
              disabled={resetBusy}
              onChange={() => setResetScope('path')}
            />{' '}
            Ein Pfad
          </label>
          {resetScope === 'path' && (
            <select
              aria-label="Pfad"
              data-testid="training-reset-path"
              value={resetPath}
              disabled={resetBusy}
              onChange={(event) => setResetPath(event.target.value)}
            >
              <option value="">– Pfad wählen –</option>
              {(catalog?.paths ?? []).map((path) => (
                <option key={path.key} value={path.key}>
                  {path.title}
                </option>
              ))}
            </select>
          )}
          <label style={{ display: 'block' }}>
            <input
              type="radio"
              name="training-reset-scope"
              value="definition"
              data-testid="training-reset-scope-definition"
              checked={resetScope === 'definition'}
              disabled={resetBusy}
              onChange={() => setResetScope('definition')}
            />{' '}
            Eine einzelne Übung
          </label>
          {resetScope === 'definition' && (
            <select
              aria-label="Übung"
              data-testid="training-reset-definition"
              value={resetDefinition}
              disabled={resetBusy}
              onChange={(event) => setResetDefinition(event.target.value)}
            >
              <option value="">– Übung wählen –</option>
              {definitionOptions.map((definition) => (
                <option key={definition.key} value={definition.key}>
                  {definition.title}
                </option>
              ))}
            </select>
          )}
        </fieldset>
        {resetError !== null && (
          <p className="error" data-testid="training-reset-error" role="alert">
            {resetError}
          </p>
        )}
        <button
          type="button"
          className="danger"
          data-testid="training-reset"
          disabled={!resetReady || resetBusy}
          onClick={() => setResetDialog(true)}
        >
          Training zurücksetzen
        </button>
      </section>

      <section className="card" data-testid="training-admin-catalog">
        <h2>Katalog</h2>
        <p className="muted">
          Fester Katalog aus dem Code (stabile Schlüssel). Eine neue Version einer Übung erkennt
          bestandene Trainings nicht ab; echtes Nachschulen läuft über eine neue Übung oder einen
          bewussten Reset.
        </p>
        {catalog === null ? (
          <p className="muted">Katalog konnte nicht geladen werden.</p>
        ) : (
          <>
            {catalog.paths.map((path) => (
              <div key={path.key} data-testid="training-catalog-path" data-key={path.key}>
                <h3 style={{ margin: '0.5rem 0 0.25rem' }}>
                  {path.title}{' '}
                  <span className={path.active ? 'badge ok' : 'badge locked'}>
                    {path.active ? 'aktiv' : 'inaktiv'}
                  </span>
                </h3>
                {path.description !== '' && <p className="muted">{path.description}</p>}
                <ol style={{ paddingLeft: '1.25rem' }}>
                  {path.items.map((item) => (
                    <li
                      key={item.definition.key}
                      data-testid="training-catalog-definition"
                      data-key={item.definition.key}
                      data-version={item.definition.version}
                      data-active={item.definition.active ? 'true' : 'false'}
                    >
                      {item.definition.title}{' '}
                      <span className="muted">(Version {item.definition.version})</span>{' '}
                      <span className={item.definition.active ? 'badge ok' : 'badge locked'}>
                        {item.definition.active ? 'aktiv' : 'inaktiv'}
                      </span>
                      {!item.required && <span className="muted"> · optional</span>}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
            {(catalog.definitions ?? []).some(
              (definition) =>
                !catalog.paths.some((path) =>
                  path.items.some((item) => item.definition.key === definition.key),
                ),
            ) && (
              <div data-testid="training-catalog-unassigned">
                <h3 style={{ margin: '0.5rem 0 0.25rem' }}>Übungen ohne Pfad</h3>
                <ul>
                  {(catalog.definitions ?? [])
                    .filter(
                      (definition) =>
                        !catalog.paths.some((path) =>
                          path.items.some((item) => item.definition.key === definition.key),
                        ),
                    )
                    .map((definition) => (
                      <li
                        key={definition.key}
                        data-testid="training-catalog-definition"
                        data-key={definition.key}
                        data-version={definition.version}
                        data-active={definition.active ? 'true' : 'false'}
                      >
                        {definition.title}{' '}
                        <span className="muted">(Version {definition.version})</span>{' '}
                        <span className={definition.active ? 'badge ok' : 'badge locked'}>
                          {definition.active ? 'aktiv' : 'inaktiv'}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      {resetDialog && (
        <ConfirmDialog
          testId="training-reset-dialog"
          title="Training zurücksetzen?"
          confirmLabel={resetBusy ? 'Wird zurückgesetzt …' : 'Training zurücksetzen'}
          confirmTestId="training-reset-confirm"
          busy={resetBusy}
          danger
          maxWidth="30rem"
          onConfirm={() => void runReset()}
          onCancel={() => {
            if (!resetBusy) setResetDialog(false);
          }}
        >
          <p>
            Für <strong>{userName(resetUser)}</strong> wird {resetScopeText()} zurückgesetzt.
            Laufende Versuche werden unterbrochen, bestandene Übungen zählen in der neuen Runde
            nicht mehr.
          </p>
          <p className="muted">{TRAINING_RESET_HISTORY_HINT}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/* ── Live: Sperren, Freigaben, Overrides ────────────────────────────────── */

function LiveTrainingAdmin({ me }: { me: Me }) {
  const [gates, setGates] = useState<GatesAdminView | null>(null);
  const [clearances, setClearances] = useState<ClearanceView[] | null>(null);
  const [directory, setDirectory] = useState<TrainingUserRef[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [gateDrafts, setGateDrafts] = useState<Record<string, string>>({});
  const [gateBusy, setGateBusy] = useState<string | null>(null);
  const [gateErrors, setGateErrors] = useState<Record<string, string>>({});

  const [verifyUser, setVerifyUser] = useState('');
  const [verifyDefinition, setVerifyDefinition] = useState('');
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [overrideUser, setOverrideUser] = useState('');
  const [overrideDefinition, setOverrideDefinition] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideValidUntil, setOverrideValidUntil] = useState('');
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<ClearanceView | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [gatesResult, clearancesResult, staff] = await Promise.all([
      fetchGates(),
      fetchClearances(),
      loadStaffOptions(me),
    ]);
    if (gatesResult.data === null) {
      setLoadError(gatesResult.errorMessage ?? 'Live-Sperren konnten nicht geladen werden.');
      return;
    }
    setGates(gatesResult.data);
    setLoadError(null);
    if (clearancesResult.data !== null) setClearances(clearancesResult.data.clearances);
    setDirectory(staff);
  }, [me]);

  useEffect(() => {
    void load();
  }, [load]);

  const clearanceUsers = (clearances ?? []).flatMap((clearance) =>
    clearance.user === null
      ? []
      : [
          {
            id: clearance.userId,
            firstName: clearance.user.firstName,
            lastName: clearance.user.lastName,
            ...(clearance.user.status === undefined ? {} : { status: clearance.user.status }),
          },
        ],
  );
  const users = mergeUsers(directory ?? [], clearanceUsers);
  const definitions = gates?.definitions ?? [];
  const activeDefinitions = definitions.filter((definition) => definition.active);
  const userName = (id: string) => {
    const user = users.find((entry) => entry.id === id);
    return user === undefined ? 'Mitarbeiter' : fullName(user);
  };
  const definitionTitle = (key: string) =>
    definitions.find((definition) => definition.key === key)?.title ?? key;

  function setGateError(featureKey: string, message: string | null) {
    setGateErrors((current) => {
      const next = { ...current };
      if (message === null) delete next[featureKey];
      else next[featureKey] = message;
      return next;
    });
  }

  async function saveGate(feature: GateFeatureView, definitionKey: string, enabled: boolean) {
    if (gateBusy !== null) return;
    if (definitionKey === '') {
      setGateError(feature.featureKey, 'Bitte zuerst eine Übung wählen.');
      return;
    }
    setGateBusy(feature.featureKey);
    setGateError(feature.featureKey, null);
    setNotice(null);
    const result = await updateGate(feature.featureKey, { definitionKey, enabled });
    if (!result.ok) {
      setGateError(
        feature.featureKey,
        result.errorMessage ??
          'Die Sperre konnte nicht gespeichert werden. Bitte erneut versuchen.',
      );
    } else {
      setNotice(
        enabled
          ? `Sperre „${feature.title}“ aktiviert – erforderlich: „${definitionTitle(definitionKey)}“.`
          : `Sperre „${feature.title}“ deaktiviert.`,
      );
    }
    await load();
    setGateBusy(null);
  }

  function changeGateDefinition(feature: GateFeatureView, definitionKey: string) {
    setGateDrafts((current) => ({ ...current, [feature.featureKey]: definitionKey }));
    setGateError(feature.featureKey, null);
    if (feature.requirement?.enabled === true && definitionKey !== '') {
      void saveGate(feature, definitionKey, true);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    if (verifyBusy) return;
    if (verifyUser === '' || verifyDefinition === '') {
      setVerifyError('Bitte Mitarbeiter und Übung wählen.');
      return;
    }
    setVerifyBusy(true);
    setVerifyError(null);
    setNotice(null);
    const result = await createClearance({
      userId: verifyUser,
      definitionKey: verifyDefinition,
      source: 'verified_demo',
    });
    setVerifyBusy(false);
    if (!result.ok) {
      setVerifyError(result.errorMessage ?? 'Bestätigung fehlgeschlagen.');
      return;
    }
    setNotice(
      result.data?.created === false
        ? `Demo-Training „${definitionTitle(verifyDefinition)}“ ist für ${userName(verifyUser)} bereits bestätigt.`
        : `Demo-Training „${definitionTitle(verifyDefinition)}“ für ${userName(verifyUser)} bestätigt.`,
    );
    setVerifyDefinition('');
    await load();
  }

  async function grantOverride(event: FormEvent) {
    event.preventDefault();
    if (overrideBusy) return;
    if (overrideUser === '' || overrideDefinition === '') {
      setOverrideError('Bitte Mitarbeiter und Übung wählen.');
      return;
    }
    if (overrideReason.trim() === '') {
      setOverrideError(TRAINING_OVERRIDE_REASON_REQUIRED);
      return;
    }
    setOverrideBusy(true);
    setOverrideError(null);
    setNotice(null);
    const base = {
      userId: overrideUser,
      definitionKey: overrideDefinition,
      source: 'override' as const,
      reason: overrideReason.trim(),
    };
    const result = await createClearance(
      overrideValidUntil === ''
        ? base
        : { ...base, validUntil: berlinWallTimeToIso(overrideValidUntil, 23, 59) },
    );
    setOverrideBusy(false);
    if (!result.ok) {
      setOverrideError(result.errorMessage ?? 'Override fehlgeschlagen.');
      return;
    }
    setNotice(
      result.data?.created === false
        ? `Für ${userName(overrideUser)} besteht bereits ein gültiger Override (Übung „${definitionTitle(overrideDefinition)}“).`
        : `Override für ${userName(overrideUser)} (Übung „${definitionTitle(overrideDefinition)}“) erteilt.`,
    );
    setOverrideReason('');
    setOverrideValidUntil('');
    await load();
  }

  async function runRevoke() {
    if (revokeTarget === null || revokeBusy) return;
    setRevokeBusy(true);
    setRevokeError(null);
    setNotice(null);
    const result = await revokeClearance(revokeTarget.id);
    setRevokeBusy(false);
    if (!result.ok) {
      setRevokeError(result.errorMessage ?? 'Widerruf fehlgeschlagen.');
      return;
    }
    setNotice(
      `${clearanceSourceLabel(revokeTarget.source)} für ${clearanceUserName(revokeTarget)} (Übung „${clearanceTitle(
        revokeTarget,
      )}“) widerrufen – die Sperre gilt sofort wieder.`,
    );
    setRevokeTarget(null);
    await load();
  }

  if (loadError !== null) {
    return (
      <p className="error" data-testid="training-admin-error">
        {loadError}
      </p>
    );
  }
  if (gates === null) return <p className="muted">Wird geladen …</p>;

  const now = new Date();

  return (
    <div data-testid="training-admin-live">
      {notice !== null && (
        <p className="success" data-testid="training-admin-notice" role="status">
          {notice}
        </p>
      )}
      {(gates.enforced ?? me.environment === 'production') === false && (
        <p className="conflict-box" data-testid="training-gates-hint">
          Live-Sperren werden nur in der Produktivumgebung erzwungen. In der{' '}
          {environmentLabel(gates.environment ?? me.environment)} kannst du sie hier nur
          vorbereiten.
        </p>
      )}

      <section className="card" data-testid="training-gates">
        <h2>Live-Sperren</h2>
        <p className="muted">
          Je Funktion kann zusätzlich zum normalen Recht ein bestätigtes Demo-Training verlangt
          werden. Ohne Freigabe sehen Mitarbeitende beim Ausführen den Hinweis, welches Training
          erforderlich ist. Verwaltungsfunktionen werden nie gesperrt.
        </p>
        {gates.features.map((feature) => {
          const enabled = feature.requirement?.enabled === true;
          const selected =
            gateDrafts[feature.featureKey] ?? feature.requirement?.definitionKey ?? '';
          const busy = gateBusy === feature.featureKey;
          const error = gateErrors[feature.featureKey] ?? null;
          const inactiveDefinition = feature.definition !== null && !feature.definition.active;
          return (
            <div
              key={feature.featureKey}
              className="list-row"
              style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}
              data-testid="training-gate"
              data-feature={feature.featureKey}
              data-enabled={enabled ? 'true' : 'false'}
            >
              <div style={{ flex: '1 1 16rem' }}>
                <strong>{feature.title}</strong>{' '}
                <span
                  className={enabled ? 'badge locked' : 'badge'}
                  data-testid="training-gate-state"
                >
                  {enabled ? 'Sperre aktiv' : 'keine Sperre'}
                </span>
                {feature.description !== '' && <div className="muted">{feature.description}</div>}
                {feature.requirement !== null && (
                  <div className="muted">
                    Zuletzt geändert {formatBerlin(feature.requirement.configuredAt)}
                  </div>
                )}
                {inactiveDefinition && (
                  <div className="error">
                    Die hinterlegte Übung ist inaktiv – bitte eine aktive Übung wählen.
                  </div>
                )}
                {error !== null && (
                  <div className="error" data-testid="training-gate-error" role="alert">
                    {error}
                  </div>
                )}
              </div>
              <div style={{ flex: '1 1 14rem' }}>
                <label htmlFor={`training-gate-definition-${feature.featureKey}`}>
                  Erforderliche Übung
                </label>
                <select
                  id={`training-gate-definition-${feature.featureKey}`}
                  data-testid="training-gate-definition"
                  value={selected}
                  disabled={busy}
                  onChange={(event) => changeGateDefinition(feature, event.target.value)}
                >
                  <option value="">– Übung wählen –</option>
                  {definitions.map((definition) => (
                    <option
                      key={definition.key}
                      value={definition.key}
                      disabled={!definition.active && definition.key !== selected}
                    >
                      {definition.title}
                      {definition.active ? '' : ' (inaktiv)'}
                    </option>
                  ))}
                </select>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                  <input
                    type="checkbox"
                    role="switch"
                    data-testid="training-gate-toggle"
                    checked={enabled}
                    disabled={busy}
                    onChange={() => void saveGate(feature, selected, !enabled)}
                  />
                  {busy ? 'Wird gespeichert …' : enabled ? 'Sperre aktiv' : 'Sperre inaktiv'}
                </label>
                {!enabled && selected === '' && (
                  <div className="muted">Zuerst eine Übung wählen, dann die Sperre aktivieren.</div>
                )}
              </div>
            </div>
          );
        })}
      </section>

      <section className="card" data-testid="training-clearances">
        <h2>Freigaben</h2>
        <p className="muted">
          Bestätigte Demo-Trainings und Overrides. Es werden nur Mitarbeiter und Übungsschlüssel
          gespeichert – keine Demo-Daten. Ein Widerruf wirkt sofort.
        </p>
        {revokeError !== null && (
          <p className="error" data-testid="training-clearance-error" role="alert">
            {revokeError}
          </p>
        )}
        {clearances === null ? (
          <p className="muted">Freigaben konnten nicht geladen werden.</p>
        ) : clearances.length === 0 ? (
          <p className="muted" data-testid="training-clearances-empty">
            Noch keine Freigaben.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th>Mitarbeiter</th>
                  <th>Übung</th>
                  <th>Art</th>
                  <th>Gültig</th>
                  <th>Erteilt</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {clearances.map((clearance) => {
                  const state = clearanceStateLabel(clearance, now);
                  const revocable = clearance.revokedAt === null && clearance.active;
                  return (
                    <tr
                      key={clearance.id}
                      style={ROW}
                      data-testid="training-clearance"
                      data-id={clearance.id}
                      data-source={clearance.source}
                      data-definition={clearance.definitionKey}
                      data-user={clearance.userId}
                      data-active={clearance.active ? 'true' : 'false'}
                    >
                      <td style={CELL}>
                        {clearanceUserName(clearance)}
                        {clearance.user?.status === 'disabled' && (
                          <>
                            {' '}
                            <span
                              className="badge locked"
                              data-testid="training-clearance-user-disabled"
                            >
                              deaktiviert
                            </span>
                          </>
                        )}
                      </td>
                      <td style={CELL}>{clearanceTitle(clearance)}</td>
                      <td style={CELL}>
                        {clearanceSourceLabel(clearance.source)}
                        {clearance.reason !== null && clearance.reason !== '' && (
                          <div className="muted">Begründung: {clearance.reason}</div>
                        )}
                      </td>
                      <td style={CELL}>
                        ab {formatBerlin(clearance.validFrom)}
                        <br />
                        {clearance.validUntil !== null
                          ? `bis ${formatBerlin(clearance.validUntil)}`
                          : 'unbefristet'}
                      </td>
                      <td style={CELL}>{formatBerlin(clearance.grantedAt)}</td>
                      <td style={CELL}>
                        <span
                          className={state === 'aktiv' ? 'badge ok' : 'badge locked'}
                          data-testid="training-clearance-state"
                        >
                          {state}
                        </span>
                        {clearance.revokedAt !== null && (
                          <div className="muted">{formatBerlin(clearance.revokedAt)}</div>
                        )}
                      </td>
                      <td style={CELL}>
                        {revocable && (
                          <button
                            type="button"
                            data-testid="training-clearance-revoke"
                            disabled={revokeBusy}
                            onClick={() => {
                              setRevokeError(null);
                              setRevokeTarget(clearance);
                            }}
                          >
                            Widerrufen
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <h3>Demo-Training bestätigen</h3>
        <p className="muted">
          Bestätige nur Übungen, deren Bestehen du in der Demo selbst geprüft hast. Zwischen Demo
          und Live wird nichts automatisch übertragen. {TRAINING_VERIFIED_DEMO_PERMANENT_HINT}
        </p>
        {directory === null && <UsersUnavailableHint context="Freigaben" />}
        <form onSubmit={(event) => void verify(event)} data-testid="training-verify-form">
          <UserSelect
            id="training-verify-user"
            users={users}
            value={verifyUser}
            disabled={verifyBusy}
            onChange={setVerifyUser}
          />
          <DefinitionSelect
            id="training-verify-definition"
            label="Übung"
            definitions={activeDefinitions}
            value={verifyDefinition}
            disabled={verifyBusy}
            onChange={setVerifyDefinition}
          />
          {verifyError !== null && (
            <p className="error" data-testid="training-verify-error" role="alert">
              {verifyError}
            </p>
          )}
          <button
            className="primary"
            type="submit"
            data-testid="training-verify"
            disabled={verifyBusy}
          >
            {verifyBusy ? 'Wird bestätigt …' : 'Demo-Training bestätigen'}
          </button>
        </form>
      </section>

      <section className="card">
        <h2>Overrides</h2>
        <p className="muted">
          Bewusste Ausnahme von einer Live-Sperre ohne bestätigtes Demo-Training – mit
          Pflicht-Begründung, optional befristet. Auch Administratoren nutzen diesen Weg; einen
          stillen Bypass gibt es nicht.
        </p>
        <form onSubmit={(event) => void grantOverride(event)} data-testid="training-override-form">
          <UserSelect
            id="training-override-user"
            users={users}
            value={overrideUser}
            disabled={overrideBusy}
            onChange={setOverrideUser}
          />
          <DefinitionSelect
            id="training-override-definition"
            label="Übung"
            definitions={activeDefinitions}
            value={overrideDefinition}
            disabled={overrideBusy}
            onChange={setOverrideDefinition}
          />
          <label htmlFor="training-override-reason">Begründung (Pflicht)</label>
          <textarea
            id="training-override-reason"
            data-testid="training-override-reason"
            rows={3}
            value={overrideReason}
            disabled={overrideBusy}
            onChange={(event) => setOverrideReason(event.target.value)}
          />
          <label htmlFor="training-override-valid-until">Gültig bis (optional)</label>
          <input
            id="training-override-valid-until"
            data-testid="training-override-valid-until"
            type="date"
            value={overrideValidUntil}
            disabled={overrideBusy}
            onChange={(event) => setOverrideValidUntil(event.target.value)}
          />
          {overrideError !== null && (
            <p className="error" data-testid="training-override-error" role="alert">
              {overrideError}
            </p>
          )}
          <button
            className="primary"
            type="submit"
            data-testid="training-override"
            disabled={overrideBusy}
          >
            {overrideBusy ? 'Wird erteilt …' : 'Override erteilen'}
          </button>
        </form>
      </section>

      {revokeTarget !== null && (
        <ConfirmDialog
          testId="training-clearance-revoke-dialog"
          title="Freigabe widerrufen?"
          confirmLabel={revokeBusy ? 'Wird widerrufen …' : 'Widerrufen'}
          confirmTestId="training-clearance-revoke-confirm"
          busy={revokeBusy}
          danger
          maxWidth="28rem"
          onConfirm={() => void runRevoke()}
          onCancel={() => {
            if (!revokeBusy) setRevokeTarget(null);
          }}
        >
          <p>
            {clearanceSourceLabel(revokeTarget.source)} für{' '}
            <strong>{clearanceUserName(revokeTarget)}</strong> (Übung „
            {clearanceTitle(revokeTarget)}
            “) wird sofort widerrufen. Solange die Sperre aktiv ist, kann diese Person die Funktion
            danach nicht mehr ausführen.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function TrainingAdminView() {
  const me = useMe();
  const offlineNow = useOfflineNow();

  if (me === null) return null;

  if (!hasPermission(me, 'training.manage')) {
    return (
      <main className="page">
        <p>
          <Link href="/einstellungen">← Einstellungen</Link>
        </p>
        <h1>Training verwalten</h1>
        <p className="error" data-testid="training-not-available">
          Diese Seite ist nur für Administratoren mit dem Recht „Training verwalten“ verfügbar.
        </p>
      </main>
    );
  }

  return (
    <main className="page" data-testid="training-admin">
      <p>
        <Link href="/einstellungen">← Einstellungen</Link>
      </p>
      <h1>Training verwalten</h1>
      {offlineNow ? (
        <p className="offline-banner" role="status" data-testid="training-offline">
          {TRAINING_OFFLINE_TEXT}
        </p>
      ) : me.environment === 'demo' ? (
        <DemoTrainingAdmin me={me} />
      ) : (
        <LiveTrainingAdmin me={me} />
      )}
    </main>
  );
}

export default function TrainingAdminPage() {
  return (
    <AuthGuard>
      <TrainingAdminView />
    </AuthGuard>
  );
}
