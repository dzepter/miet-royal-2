'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { apiFetch, hasPermission, type Me } from '../lib/api';
import {
  fromBerlinInput,
  KIND_LABELS,
  timeLabel,
  toBerlinInput,
  type CalendarEntry,
} from '../lib/scheduling';
import { formatBerlin } from '../lib/commerce';

/**
 * Kompakte Termin-Vorschau (Order §15/§28): Kunde, Vorgang, Zeit, Art,
 * Standort, Maschinentyp, effektiver Mitarbeiter, Konflikte – plus die
 * Phase-4-Aktionen. WhatsApp/E-Mail folgen mit der offiziellen Integration
 * (bewusst kein privates mailto-/WhatsApp-Schattenverfahren).
 */
export function AppointmentPreview({
  entry,
  me,
  onChanged,
  onClose,
}: {
  entry: CalendarEntry;
  me: Me | null;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [start, setStart] = useState(toBerlinInput(entry.startAt));
  const [end, setEnd] = useState(toBerlinInput(entry.endAt));
  const [staffOptions, setStaffOptions] = useState<{ id: string; name: string }[]>([]);
  const [assignTo, setAssignTo] = useState('');
  const cardRef = useRef<HTMLDivElement | null>(null);

  const canAssign = hasPermission(me, 'appointment.assign');
  const canReschedule = hasPermission(me, 'calendar.drag_drop');
  const canComplete = hasPermission(me, 'calendar.manage');
  const myId = me?.user.id;

  useEffect(() => {
    setStart(toBerlinInput(entry.startAt));
    setEnd(toBerlinInput(entry.endAt));
    setError(null);
  }, [entry.id, entry.version, entry.startAt, entry.endAt]);

  // Die Vorschau rendert unterhalb von Liste/Raster – beim Öffnen bzw.
  // Terminwechsel in den sichtbaren Bereich holen (Order §15).
  useEffect(() => {
    cardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [entry.id]);

  useEffect(() => {
    if (!canAssign) return;
    void apiFetch<{ staff: { id: string; firstName: string; lastName: string }[] }>(
      '/staff/scheduling/staff-options',
    ).then((result) => {
      if (result.data !== null) {
        setStaffOptions(
          result.data.staff.map((user) => ({
            id: user.id,
            name: `${user.lastName}, ${user.firstName}`,
          })),
        );
      }
    });
  }, [canAssign]);

  async function run(path: string, body?: unknown, method = 'POST'): Promise<boolean> {
    setBusy(true);
    setError(null);
    const result = await apiFetch(path, { method, body });
    setBusy(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Aktion fehlgeschlagen.');
      return false;
    }
    await onChanged();
    return true;
  }

  function saveTime(confirmText: string) {
    const startIso = fromBerlinInput(start);
    const endIso = fromBerlinInput(end);
    if (startIso === null && endIso !== null) {
      setError('Ein Zeitfenster-Ende ohne Beginn ist nicht möglich.');
      return;
    }
    // Kurze Bestätigung vor dem Speichern (Order §16/§27).
    if (!window.confirm(confirmText)) return;
    void run(
      `/staff/appointments/${entry.id}/schedule`,
      { startAt: startIso, endAt: endIso, expectedVersion: entry.version },
      'PATCH',
    );
  }

  return (
    <div className="card appointment-preview" data-testid="appointment-preview" ref={cardRef}>
      <div className="list-row" style={{ alignItems: 'flex-start' }}>
        <div>
          <h3 style={{ margin: 0 }}>
            {KIND_LABELS[entry.kind]} · {entry.customerName}
          </h3>
          <p className="muted" style={{ margin: '0.2rem 0' }}>
            <Link href={`/vorgaenge/${entry.processId}`}>{entry.processNumber}</Link> ·{' '}
            {timeLabel(entry)}
          </p>
        </div>
        <button onClick={onClose} aria-label="Vorschau schließen">
          ✕
        </button>
      </div>

      {error !== null && <p className="error">{error}</p>}

      <p style={{ margin: '0.3rem 0' }}>
        Standort: {entry.locationLabel}
        <br />
        Maschine: {entry.machineName ?? '–'}
        <br />
        Mitarbeiter: {entry.effectiveAssigneeName ?? entry.assignedName ?? 'Mitarbeiter zuweisen'}
        {entry.substituted && entry.assignedName !== null && (
          <span className="muted"> (Vertretung für {entry.assignedName})</span>
        )}
      </p>

      <p style={{ margin: '0.3rem 0' }}>
        {entry.overdue && <span className="badge locked">Überfällig</span>}{' '}
        {entry.acknowledgementPending && (
          <span className="badge">Übernahmebestätigung ausstehend</span>
        )}{' '}
        {entry.customerInfoRequiredAt !== null && (
          <span className="badge">Kundeninformation erforderlich</span>
        )}{' '}
        {entry.status === 'completed' && (
          <span className="badge active">Intern abgeschlossen (kein Rückgabeabschluss)</span>
        )}
      </p>

      {entry.conflicts.length > 0 && (
        <div className="conflict-box">
          {entry.conflicts.map((conflict) => (
            <p
              key={`${conflict.type}-${conflict.appointmentIds.join('-')}`}
              style={{ margin: '0.3rem 0' }}
            >
              <span className="conflict-icon" aria-hidden="true">
                ⚠︎
              </span>{' '}
              {conflict.reason}{' '}
              <button
                disabled={busy}
                onClick={() =>
                  void run('/staff/conflicts/resolve', {
                    type: conflict.type,
                    appointmentIds: conflict.appointmentIds,
                  })
                }
              >
                Konflikt gelöst
              </button>
            </p>
          ))}
        </div>
      )}

      <p>
        {entry.customerPhone !== null && (
          <a className="button-like" href={`tel:${entry.customerPhone.replace(/\s/g, '')}`}>
            Anrufen
          </a>
        )}{' '}
        <Link className="button-like" href={`/vorgaenge/${entry.processId}`}>
          Vorgang öffnen
        </Link>{' '}
        {entry.overdue && (
          <button
            disabled={busy}
            onClick={() => void run(`/staff/appointments/${entry.id}/customer-contacted`)}
          >
            Kunde kontaktiert
          </button>
        )}{' '}
        {entry.acknowledgementPending && entry.acknowledgementRequestedFor === myId && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => void run(`/staff/appointments/${entry.id}/acknowledge`)}
          >
            Termin übernommen
          </button>
        )}
      </p>
      {entry.overdueIncident !== null && entry.overdueIncident.customerContactedAt !== null && (
        <p className="muted">
          Kunde kontaktiert: {formatBerlin(entry.overdueIncident.customerContactedAt)}
        </p>
      )}

      {canReschedule && entry.status === 'scheduled' && (
        <div style={{ borderTop: '1px solid #eee', paddingTop: '0.5rem' }}>
          <p className="muted" style={{ margin: '0 0 0.3rem' }}>
            Zeiten in Europe/Berlin.
          </p>
          <div className="grid-2">
            <div>
              <label htmlFor={`ap-start-${entry.id}`}>
                {entry.overdue ? 'Neue Rückgabezeit' : 'Beginn'}
              </label>
              <input
                id={`ap-start-${entry.id}`}
                type="datetime-local"
                value={start}
                onChange={(event) => setStart(event.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`ap-end-${entry.id}`}>Ende (optional, Zeitfenster)</label>
              <input
                id={`ap-end-${entry.id}`}
                type="datetime-local"
                value={end}
                onChange={(event) => setEnd(event.target.value)}
              />
            </div>
          </div>
          <p>
            <button
              disabled={busy}
              onClick={() =>
                saveTime(
                  entry.overdue
                    ? 'Neue Rückgabezeit verbindlich vereinbaren? Der Kunde muss anschließend informiert werden.'
                    : 'Terminzeit wirklich ändern?',
                )
              }
            >
              {entry.overdue ? 'Neue Rückgabezeit vereinbart' : 'Zeit speichern'}
            </button>
          </p>
        </div>
      )}

      {canAssign && entry.status === 'scheduled' && (
        <div style={{ borderTop: '1px solid #eee', paddingTop: '0.5rem' }}>
          <label htmlFor={`ap-assign-${entry.id}`}>Mitarbeiter zuweisen</label>
          <select
            id={`ap-assign-${entry.id}`}
            value={assignTo}
            onChange={(event) => setAssignTo(event.target.value)}
          >
            <option value="">– Mitarbeiter wählen –</option>
            {staffOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>{' '}
          <button
            disabled={busy || assignTo === ''}
            onClick={() =>
              void run(`/staff/appointments/${entry.id}/assign`, {
                userId: assignTo,
                expectedVersion: entry.version,
              }).then((ok) => ok && setAssignTo(''))
            }
          >
            Zuweisen
          </button>
        </div>
      )}

      {canComplete && entry.status === 'scheduled' && (
        <p style={{ borderTop: '1px solid #eee', paddingTop: '0.5rem' }}>
          <button
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  'Termin nur INTERN als erledigt markieren? Die fachliche Übergabe/Rückgabe folgt in einer späteren Phase.',
                )
              )
                return;
              void run(`/staff/appointments/${entry.id}/complete`, {
                expectedVersion: entry.version,
              });
            }}
          >
            Intern als erledigt markieren
          </button>
        </p>
      )}
    </div>
  );
}
