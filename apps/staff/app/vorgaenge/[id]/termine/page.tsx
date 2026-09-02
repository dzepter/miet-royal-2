'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../../../components/auth-guard';
import { AppointmentPreview } from '../../../../components/appointment-preview';
import { apiFetch, hasPermission } from '../../../../lib/api';
import { KIND_LABELS, timeLabel, type CalendarEntry } from '../../../../lib/scheduling';

/**
 * Terminplanung im Vorgang (Order §§4–6/8): Termine der bestätigten
 * Buchung (werden idempotent sichergestellt), „Wochenend-Standard
 * übernehmen“ (nur wenn fachlich passend) und Zeiten/Zuweisung pflegen.
 */
function PlanningView() {
  const params = useParams<{ id: string }>();
  const me = useMe();
  const [entries, setEntries] = useState<CalendarEntry[] | null>(null);
  const [selected, setSelected] = useState<CalendarEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await apiFetch<{ entries: CalendarEntry[] }>(
      `/staff/processes/${params.id}/appointments`,
    );
    if (result.data !== null) {
      setEntries(result.data.entries);
      setSelected((current) =>
        current === null
          ? null
          : (result.data!.entries.find((entry) => entry.id === current.id) ?? null),
      );
    } else {
      setError(result.errorMessage ?? 'Termine konnten nicht geladen werden.');
    }
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function applyWeekendStandard() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await apiFetch(`/staff/processes/${params.id}/appointments/weekend-standard`, {
      method: 'POST',
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Der Wochenend-Standard konnte nicht übernommen werden.');
      return;
    }
    setNotice(
      'Wochenend-Standard übernommen: Freitag 18:00 Uhr Abholung, Sonntag 11:00 Uhr Rückgabe.',
    );
    await load();
  }

  return (
    <main className="page">
      <p>
        <Link href={`/vorgaenge/${params.id}`}>← Vorgang</Link>
      </p>
      <h1>Terminplanung</h1>
      {error !== null && <p className="error">{error}</p>}
      {notice !== null && <p className="success">{notice}</p>}

      {entries !== null && entries.length === 0 && (
        <div className="card">
          <p className="muted">
            Für diesen Vorgang existiert noch keine bestätigte Buchung – Termine entstehen mit der
            verbindlichen Annahme des Angebots.
          </p>
        </div>
      )}

      {entries !== null && entries.length > 0 && (
        <div className="card">
          {/* Wochenend-Standard ist eine SELBSTABHOLUNGS-Regel – bei
              Lieferbuchungen bleibt das vereinbarte Fenster führend. */}
          {hasPermission(me, 'calendar.drag_drop') &&
            !entries.some((entry) => entry.kind === 'delivery') && (
              <p>
                <button disabled={busy} onClick={() => void applyWeekendStandard()}>
                  Wochenend-Standard übernehmen (Fr 18:00 / So 11:00)
                </button>
              </p>
            )}
          {entries.map((entry) => (
            <button key={entry.id} className="entry-row" onClick={() => setSelected(entry)}>
              <span>
                <strong>{KIND_LABELS[entry.kind]}</strong> · {timeLabel(entry)}
                <span className="muted"> · {entry.locationLabel}</span>
              </span>
              <span>
                {entry.startAt === null && <span className="badge">Zeit festlegen</span>}{' '}
                {entry.assignedUserId === null && (
                  <span className="badge">Mitarbeiter zuweisen</span>
                )}{' '}
                {entry.overdue && <span className="badge locked">Überfällig</span>}{' '}
                {entry.status === 'completed' && (
                  <span className="badge active">Intern abgeschlossen</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}

      {selected !== null && (
        <AppointmentPreview
          entry={selected}
          me={me}
          onChanged={load}
          onClose={() => setSelected(null)}
        />
      )}
      <p>
        <Link href="/kalender">Zum Kalender</Link>
      </p>
    </main>
  );
}

export default function PlanningPage() {
  return (
    <AuthGuard>
      <PlanningView />
    </AuthGuard>
  );
}
