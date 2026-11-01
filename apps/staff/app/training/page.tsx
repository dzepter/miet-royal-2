'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../components/auth-guard';
import { useOfflineNow } from '../../components/communication';
import { formatBerlin } from '../../lib/handover';
import {
  assignmentStatusLabel,
  checkAttempt,
  checkIncompleteText,
  demoLinkFor,
  environmentLabel,
  exerciseStateLabel,
  fetchTrainingMe,
  gateStatusText,
  interruptionText,
  startAttempt,
  TRAINING_CHECK_PASSED_TEXT,
  TRAINING_DEMO_ONLY_TEXT,
  TRAINING_OFFLINE_TEXT,
  TRAINING_PERMISSION_MISSING_TEXT,
  type AttemptView,
  type DefinitionView,
  type TrainingExerciseState,
  type TrainingMe,
} from '../../lib/training';

/**
 * Training (Phase 14, Order §§44, 52, 55, 88; Design Teil 2 §4.6).
 * Demo: zugewiesene Pfade mit Pflichtübungen, Zustand erledigt/offen/läuft,
 * laufender Versuch mit Schrittliste, „Übung starten“ / „Übung prüfen“ und
 * Link in den passenden Demo-Bereich; zusätzlich alle Katalog-Übungen ohne
 * Zuweisung („Weitere Übungen“ – Zustand aus `definitions[].state/passedAt/
 * attempt` von `/staff/training/me`, Review-Fix F7: eine bestandene freie
 * Übung bleibt nach Reload „erledigt“ ohne „Übung starten“). Außerhalb der Demo nur der Hinweis, dass
 * Übungen in der Demo absolviert werden, plus die eigenen Live-Sperren.
 * Offline nicht verfügbar (nur Hinweis). Keine rohen Codes, eine Hauptaktion
 * je Übung, Status immer als Text.
 */

interface CheckResult {
  passed: boolean;
  text: string;
}

const STATE_BADGE_CLASS: Record<TrainingExerciseState, string> = {
  passed: 'badge ok',
  in_progress: 'badge warn',
  open: 'badge',
};

function ExerciseCard({
  definition,
  state,
  attempt,
  sequence,
  required,
  passedAt,
  busy,
  error,
  checkResult,
  onStart,
  onCheck,
}: {
  definition: DefinitionView;
  state: TrainingExerciseState;
  attempt: AttemptView | null;
  sequence: number | null;
  required: boolean;
  passedAt: string | null;
  busy: boolean;
  error: string | null;
  checkResult: CheckResult | null;
  onStart: () => void;
  onCheck: (attemptId: string) => void;
}) {
  const running = attempt !== null && attempt.status === 'in_progress';
  const interrupted =
    state !== 'passed' && !running && attempt !== null && attempt.status === 'interrupted';
  const demoLink = demoLinkFor(definition);
  const title = sequence === null ? definition.title : `${sequence}. ${definition.title}`;

  return (
    <div
      className="card"
      data-testid="training-exercise"
      data-key={definition.key}
      data-state={state}
      style={{ marginBottom: '0.75rem' }}
    >
      <h3 style={{ margin: '0 0 0.25rem' }}>
        {title}{' '}
        <span
          className={STATE_BADGE_CLASS[state]}
          data-testid="training-exercise-state"
          data-state={state}
        >
          {exerciseStateLabel(state)}
        </span>
        {!required && <span className="muted"> (optional)</span>}
      </h3>
      <p style={{ margin: '0 0 0.5rem' }}>{definition.objective}</p>
      <details open={running}>
        <summary>Schritte der Übung</summary>
        <p className="muted" style={{ whiteSpace: 'pre-line' }}>
          {definition.instructions}
        </p>
      </details>

      {state === 'passed' && (
        <p className="success" data-testid="training-exercise-passed">
          Bestanden{passedAt !== null ? ` am ${formatBerlin(passedAt)}` : ''}.
        </p>
      )}

      {interrupted && (
        <p className="conflict-box" data-testid="training-interrupted">
          {interruptionText(attempt.interruptionCode)}
        </p>
      )}

      {running && (
        <>
          <ol data-testid="training-steps" style={{ paddingLeft: '1.25rem' }}>
            {attempt.steps.map((step) => (
              <li
                key={step.key}
                data-testid="training-step"
                data-step={step.key}
                data-done={step.done ? 'true' : 'false'}
              >
                {step.done ? '✓ ' : '○ '}
                {step.title} <span className="muted">({step.done ? 'erledigt' : 'offen'})</span>
              </li>
            ))}
          </ol>
          {attempt.openStep !== null && (
            <p data-testid="training-open-step">
              Offener Schritt: <strong>{attempt.openStep.title}</strong>
            </p>
          )}
          <p className="muted">Gestartet {formatBerlin(attempt.startedAt)}.</p>
        </>
      )}

      {checkResult !== null && (
        <p
          className={checkResult.passed ? 'success' : 'conflict-box'}
          data-testid="training-check-result"
          data-passed={checkResult.passed ? 'true' : 'false'}
          role="status"
        >
          {checkResult.text}
        </p>
      )}

      {error !== null && (
        <p className="error" data-testid="training-exercise-error" role="alert">
          {error}
        </p>
      )}

      {state !== 'passed' && !running && definition.permissionMissing && (
        <p className="error" data-testid="training-permission-missing">
          {TRAINING_PERMISSION_MISSING_TEXT}
        </p>
      )}

      {state !== 'passed' && (
        <p style={{ margin: '0.5rem 0 0' }}>
          {running ? (
            <button
              type="button"
              className="primary"
              data-testid="training-check"
              disabled={busy}
              onClick={() => onCheck(attempt.id)}
            >
              {busy ? 'Wird geprüft …' : 'Übung prüfen'}
            </button>
          ) : (
            !definition.permissionMissing && (
              <button
                type="button"
                className="primary"
                data-testid="training-start"
                disabled={busy}
                onClick={onStart}
              >
                {busy ? 'Wird gestartet …' : 'Übung starten'}
              </button>
            )
          )}{' '}
          {demoLink !== null && (
            <Link href={demoLink} className="button-like" data-testid="training-demo-link">
              Zum Demo-Bereich
            </Link>
          )}
        </p>
      )}
    </div>
  );
}

function TrainingView() {
  const me = useMe();
  const offlineNow = useOfflineNow();
  const [data, setData] = useState<TrainingMe | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [networkDown, setNetworkDown] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [checkResults, setCheckResults] = useState<Record<string, CheckResult>>({});

  const load = useCallback(async () => {
    if (offlineNow) return;
    const result = await fetchTrainingMe();
    if (result.data !== null) {
      setData(result.data);
      setLoadError(null);
      setNetworkDown(false);
      return;
    }
    if (result.status === 0) {
      setNetworkDown(true);
      return;
    }
    setLoadError(result.errorMessage ?? 'Training konnte nicht geladen werden.');
  }, [offlineNow]);

  useEffect(() => {
    void load();
  }, [load]);

  function setExerciseError(key: string, message: string | null) {
    setErrors((current) => {
      const next = { ...current };
      if (message === null) delete next[key];
      else next[key] = message;
      return next;
    });
  }

  async function start(definitionKey: string) {
    if (busyKey !== null) return; // Doppelklick-Schutz (§39/§76)
    setBusyKey(definitionKey);
    setExerciseError(definitionKey, null);
    setCheckResults((current) => {
      const next = { ...current };
      delete next[definitionKey];
      return next;
    });
    const result = await startAttempt(definitionKey);
    if (!result.ok) {
      setExerciseError(
        definitionKey,
        result.errorMessage ?? 'Die Übung konnte nicht gestartet werden. Bitte erneut versuchen.',
      );
    }
    await load();
    setBusyKey(null);
  }

  async function check(definitionKey: string, attemptId: string) {
    if (busyKey !== null) return;
    setBusyKey(definitionKey);
    setExerciseError(definitionKey, null);
    const result = await checkAttempt(attemptId);
    const outcome = result.data;
    if (outcome !== null) {
      const checkResult: CheckResult = outcome.passed
        ? { passed: true, text: TRAINING_CHECK_PASSED_TEXT }
        : { passed: false, text: checkIncompleteText(outcome.openStep) };
      setCheckResults((current) => ({ ...current, [definitionKey]: checkResult }));
    } else {
      setExerciseError(
        definitionKey,
        result.errorMessage ??
          'Die Prüfung konnte nicht ausgeführt werden. Bitte erneut versuchen.',
      );
    }
    await load();
    setBusyKey(null);
  }

  if (me === null) return null;

  if (offlineNow || networkDown) {
    return (
      <main className="page" data-testid="training-page">
        <h1>Training</h1>
        <p className="offline-banner" role="status" data-testid="training-offline">
          {TRAINING_OFFLINE_TEXT}
        </p>
      </main>
    );
  }

  if (loadError !== null) {
    return (
      <main className="page" data-testid="training-page">
        <h1>Training</h1>
        <p className="error" data-testid="training-error">
          {loadError}
        </p>
      </main>
    );
  }

  if (data === null) {
    return (
      <main className="page" data-testid="training-page">
        <h1>Training</h1>
        <p className="muted">Wird geladen …</p>
      </main>
    );
  }

  if (!data.exercisesAvailable) {
    return (
      <main className="page" data-testid="training-page">
        <h1>Training</h1>
        <p className="conflict-box" data-testid="training-demo-only">
          {TRAINING_DEMO_ONLY_TEXT}
        </p>
        {me.counterpart?.kind === 'demo' && (
          <p className="muted">
            Über „Demo öffnen“ in der Kopfzeile wechselst du zur Demo-Umgebung – dort meldest du
            dich separat an.
          </p>
        )}
        <section className="card">
          <h2>Deine Live-Sperren</h2>
          <p className="muted">
            Für diese Funktionen verlangt die Produktivumgebung zusätzlich ein bestätigtes
            Demo-Training. Die Freigabe erteilt ein Administrator nach deiner Übung in der Demo.
          </p>
          {data.environment !== 'production' && (
            <p className="muted" data-testid="training-gates-not-enforced">
              Sperren werden nur in der Produktivumgebung erzwungen – in der{' '}
              {environmentLabel(data.environment)} gelten sie nicht.
            </p>
          )}
          {data.gates.length === 0 ? (
            <p className="muted" data-testid="training-gate-status-empty">
              Für dich sind keine Live-Sperren aktiv.
            </p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table
                style={{ width: '100%', borderCollapse: 'collapse' }}
                data-testid="training-gate-status"
              >
                <thead>
                  <tr style={{ textAlign: 'left' }}>
                    <th>Funktion</th>
                    <th>Erforderliches Training</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.gates.map((gate) => (
                    <tr
                      key={gate.featureKey}
                      data-testid="training-gate-row"
                      data-feature={gate.featureKey}
                      data-cleared={gate.cleared ? 'true' : 'false'}
                      data-training={gate.requiredTraining?.key ?? ''}
                      style={{ borderTop: '1px solid #eee' }}
                    >
                      <td style={{ padding: '0.4rem 0.25rem' }}>{gate.title}</td>
                      <td style={{ padding: '0.4rem 0.25rem' }}>
                        {gate.requiredTraining?.title ?? '–'}
                      </td>
                      <td style={{ padding: '0.4rem 0.25rem' }}>
                        <span className={gate.cleared ? 'badge ok' : 'badge locked'}>
                          {gateStatusText(gate, formatBerlin)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    );
  }

  const assignedKeys = new Set(
    data.assignments.flatMap((assignment) => assignment.items.map((item) => item.definition.key)),
  );
  const freeDefinitions = data.definitions.filter(
    (definition) => definition.active && !assignedKeys.has(definition.key),
  );
  const activeByKey = new Map(
    data.activeAttempts.map((attempt) => [attempt.definitionKey, attempt]),
  );

  return (
    <main className="page" data-testid="training-page">
      <h1>Training</h1>
      <p className="muted">
        Übungen laufen in der Demo mit synthetischen Daten: Übung starten, den Ablauf im
        Demo-Bereich wie im echten Betrieb durchführen und danach „Übung prüfen“ wählen. Bestandene
        Übungen bleiben bestanden.
      </p>
      <p>
        <button
          type="button"
          data-testid="training-refresh"
          disabled={busyKey !== null}
          onClick={() => void load()}
        >
          Aktualisieren
        </button>
      </p>

      {data.assignments.length === 0 && (
        <p className="muted" data-testid="training-no-assignments">
          Dir ist noch kein Trainingspfad zugewiesen. Du kannst trotzdem jede Übung unten starten.
        </p>
      )}

      {data.assignments.map((assignment) => {
        const requiredItems = assignment.items.filter((item) => item.required);
        const passedRequired = requiredItems.filter((item) => item.state === 'passed').length;
        return (
          <section
            key={assignment.id}
            className="card"
            data-testid="training-assignment"
            data-key={assignment.path.key}
            data-status={assignment.status}
          >
            <h2 style={{ marginTop: 0 }}>
              {assignment.path.title}{' '}
              <span className={assignment.status === 'completed' ? 'badge ok' : 'badge'}>
                {assignmentStatusLabel(assignment.status)}
              </span>
            </h2>
            {assignment.path.description !== '' && (
              <p className="muted">{assignment.path.description}</p>
            )}
            <p data-testid="training-assignment-progress">
              {passedRequired} von {requiredItems.length} Pflichtübungen erledigt
              {assignment.dueAt !== null && ` · fällig bis ${formatBerlin(assignment.dueAt)}`}
              {assignment.round > 1 && ` · Runde ${assignment.round}`}
            </p>
            {assignment.items.map((item) => (
              <ExerciseCard
                key={item.definition.key}
                definition={item.definition}
                state={item.state}
                attempt={item.attempt}
                sequence={item.sequence}
                required={item.required}
                passedAt={item.passedAt}
                busy={busyKey === item.definition.key}
                error={errors[item.definition.key] ?? null}
                checkResult={checkResults[item.definition.key] ?? null}
                onStart={() => void start(item.definition.key)}
                onCheck={(attemptId) => void check(item.definition.key, attemptId)}
              />
            ))}
          </section>
        );
      })}

      {freeDefinitions.length > 0 && (
        <section className="card" data-testid="training-free-exercises">
          <h2 style={{ marginTop: 0 }}>Weitere Übungen</h2>
          <p className="muted">
            Diese Übungen sind dir nicht zugewiesen – du kannst sie trotzdem jederzeit üben.
          </p>
          {freeDefinitions.map((definition) => {
            // Review-Fix F7: Serverzustand der Übung (`/me.definitions[]`) ist maßgeblich – ein
            // laufender Versuch bzw. ein lokales „bestanden“ ergänzen ihn nur.
            const attempt = activeByKey.get(definition.key) ?? definition.attempt;
            const state: TrainingExerciseState =
              definition.state === 'passed' || checkResults[definition.key]?.passed === true
                ? 'passed'
                : attempt !== null && attempt.status === 'in_progress'
                  ? 'in_progress'
                  : definition.state;
            return (
              <ExerciseCard
                key={definition.key}
                definition={definition}
                state={state}
                attempt={attempt}
                sequence={null}
                required
                passedAt={definition.passedAt}
                busy={busyKey === definition.key}
                error={errors[definition.key] ?? null}
                checkResult={checkResults[definition.key] ?? null}
                onStart={() => void start(definition.key)}
                onCheck={(attemptId) => void check(definition.key, attemptId)}
              />
            );
          })}
        </section>
      )}
    </main>
  );
}

export default function TrainingPage() {
  return (
    <AuthGuard>
      <TrainingView />
    </AuthGuard>
  );
}
