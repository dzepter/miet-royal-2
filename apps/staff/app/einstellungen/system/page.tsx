'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../../components/auth-guard';
import { hasPermission } from '../../../lib/api';
import { formatBerlin } from '../../../lib/handover';
import {
  fetchJobMonitor,
  jobProcessLink,
  jobTypeLabel,
  type JobMonitorEntry,
  type JobMonitorSnapshot,
} from '../../../lib/system-jobs';

/**
 * Einstellungen → System (Phase 19, Recht system.settings): Operator-Sicht auf
 * Hintergrundjobs. Zeigt endgültig fehlgeschlagene (dead) und gerade wiederholte Jobs mit
 * Typ, Zeitpunkt, Versuchen, Fehlerzusammenfassung, sicherer Vorgangsreferenz und der
 * Betriebsanweisung. Rein lesend – nichts wird hier „auf erfolgreich“ gesetzt.
 */

function JobRow({ entry }: { entry: JobMonitorEntry }) {
  const processLink = jobProcessLink(entry);
  const otherReferences = Object.entries(entry.references).filter(([key]) => key !== 'processId');
  return (
    <div
      className="list-row"
      data-testid="system-job-row"
      data-state={entry.state}
      data-job-type={entry.type}
    >
      <div style={{ flex: '1 1 16rem', minWidth: 0 }}>
        <strong>{jobTypeLabel(entry.type)}</strong>{' '}
        <span className={`badge ${entry.state === 'dead' ? 'locked' : 'warn'}`}>
          {entry.state === 'dead' ? 'endgültig fehlgeschlagen' : 'wird wiederholt'}
        </span>
        <div className="muted" style={{ fontSize: '0.85rem' }}>
          Versuche {entry.attempts}/{entry.maxAttempts} · angelegt {formatBerlin(entry.createdAt)} ·{' '}
          {entry.state === 'dead'
            ? `aufgegeben ${formatBerlin(entry.updatedAt)}`
            : `nächster Versuch ${entry.nextRunAt === null ? '–' : formatBerlin(entry.nextRunAt)}`}
        </div>
        {entry.lastError !== null && (
          <div
            className="muted"
            style={{ overflowWrap: 'anywhere' }}
            data-testid="system-job-error"
          >
            Fehler: {entry.lastError}
          </div>
        )}
        <div style={{ fontSize: '0.9rem' }}>
          {processLink !== null && (
            <>
              <Link href={processLink} data-testid="system-job-process-link">
                Vorgang öffnen
              </Link>{' '}
            </>
          )}
          {otherReferences.length > 0 && (
            <span className="muted">
              Referenzen: {otherReferences.map(([key, value]) => `${key} ${value}`).join(', ')}
            </span>
          )}
        </div>
        <div data-testid="system-job-guidance">
          <strong>Was tun:</strong> {entry.guidance}
        </div>
      </div>
    </div>
  );
}

function SystemSettings() {
  const me = useMe();
  const [snapshot, setSnapshot] = useState<JobMonitorSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await fetchJobMonitor();
    if (result.data !== null) {
      setSnapshot(result.data);
      setError(null);
    } else {
      setError(result.errorMessage ?? 'Jobstatus konnte nicht geladen werden.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (me !== null && !hasPermission(me, 'system.settings')) {
    return (
      <main className="page">
        <h1>System</h1>
        <p className="muted" data-testid="system-forbidden">
          Für diese Seite fehlt dir die Berechtigung „Systemeinstellungen“.
        </p>
        <p>
          <Link href="/einstellungen">Zurück zu den Einstellungen</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="page">
      <h1>System</h1>
      <p className="muted">
        Hintergrundjobs (E-Mail-Versand, Buchhaltungsübertragung, Gutscheine, Push, Erinnerungen).
        Ein Job wird nach allen Versuchen endgültig aufgegeben und erscheint dann hier – er wird nie
        automatisch wiederholt.
      </p>
      <p>
        <Link href="/einstellungen">Zurück zu den Einstellungen</Link>
      </p>
      {error !== null && <p className="error">{error}</p>}
      {snapshot !== null && (
        <>
          <div className="card" data-testid="system-jobs-counts">
            <h2>Überblick</h2>
            <p>
              <span
                className={`badge ${snapshot.counts.dead > 0 ? 'locked' : 'ok'}`}
                data-testid="system-jobs-dead-count"
              >
                {snapshot.counts.dead} endgültig fehlgeschlagen
              </span>{' '}
              <span className={`badge ${snapshot.counts.retrying > 0 ? 'warn' : 'ok'}`}>
                {snapshot.counts.retrying} in Wiederholung
              </span>{' '}
              <span className="badge ok">{snapshot.counts.pending} wartend</span>{' '}
              <span className="badge ok">{snapshot.counts.processing} in Arbeit</span>{' '}
              <span className="badge ok">
                {snapshot.counts.succeededLast24h} erfolgreich (24 h)
              </span>
            </p>
            <p data-testid="system-worker-status">
              {snapshot.worker.stalled ? (
                <span className="badge locked" data-testid="system-worker-stalled">
                  Worker verarbeitet nicht: fällige Aufgaben warten seit{' '}
                  {Math.floor(snapshot.worker.overdueSeconds / 60)} min – Worker-Prozess prüfen und
                  neu starten (DEPLOYMENT_NOTES „Betrieb im Pilot“)
                </span>
              ) : (
                <span className="badge ok">Worker verarbeitet</span>
              )}{' '}
              <span className="muted" style={{ fontSize: '0.85rem' }}>
                zuletzt erfolgreich verarbeitet:{' '}
                {snapshot.worker.lastSucceededAt === null
                  ? 'noch nie'
                  : formatBerlin(snapshot.worker.lastSucceededAt)}
                {snapshot.worker.oldestDueAt !== null &&
                  ` · älteste fällige Aufgabe wartet seit ${snapshot.worker.overdueSeconds} s`}
              </span>
            </p>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              Stand {formatBerlin(snapshot.generatedAt)} ·{' '}
              <button type="button" className="secondary" onClick={() => void load()}>
                Aktualisieren
              </button>
            </p>
          </div>
          <div className="card" data-testid="system-jobs-dead">
            <h2>Endgültig fehlgeschlagen</h2>
            {snapshot.dead.length === 0 ? (
              <p className="muted" data-testid="system-jobs-dead-empty">
                Keine endgültig fehlgeschlagenen Jobs.
              </p>
            ) : (
              snapshot.dead.map((entry) => <JobRow key={entry.id} entry={entry} />)
            )}
          </div>
          <div className="card" data-testid="system-jobs-retrying">
            <h2>In Wiederholung</h2>
            {snapshot.retrying.length === 0 ? (
              <p className="muted">Keine Jobs in Wiederholung.</p>
            ) : (
              snapshot.retrying.map((entry) => <JobRow key={entry.id} entry={entry} />)
            )}
          </div>
        </>
      )}
    </main>
  );
}

export default function SystemSettingsPage() {
  return (
    <AuthGuard>
      <SystemSettings />
    </AuthGuard>
  );
}
