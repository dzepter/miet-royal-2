'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthGuard, useMe } from '../../components/auth-guard';
import { AppointmentPreview } from '../../components/appointment-preview';
import { apiFetch, hasPermission } from '../../lib/api';
import {
  berlinDateLabel,
  berlinDayOf,
  berlinWallTime,
  berlinWallTimeToIso,
  firstOfMonth,
  isoDayShift,
  KIND_BADGE_CLASS,
  KIND_LABELS,
  mondayOf,
  timeLabel,
  todayBerlinIso,
  type CalendarEntry,
} from '../../lib/scheduling';

/**
 * Kalender (Order §§13/14/16/19): Tag/Woche/Monat, Filter (Meine/Alle,
 * Terminart, Mitarbeiter), Drag & Drop auf Desktop/Tablet mit kurzer
 * Bestätigung – Konflikte erscheinen DIREKT am Termin (Warnsymbol, bei
 * Doppelbelegung dezente rote Umrandung), niemals als Blockade.
 */

type ViewMode = 'day' | 'week' | 'month';
const KINDS = ['pickup', 'return', 'delivery'] as const;

function Chip({
  entry,
  draggable,
  onSelect,
}: {
  entry: CalendarEntry;
  draggable: boolean;
  onSelect: (entry: CalendarEntry) => void;
}) {
  const strong = entry.conflicts.some((conflict) => conflict.severity === 'strong');
  return (
    <button
      className={`calendar-chip ${KIND_BADGE_CLASS[entry.kind]} ${strong ? 'chip-conflict-strong' : ''} ${entry.overdue ? 'chip-overdue' : ''}`}
      draggable={draggable}
      data-testid={`chip-${entry.id}`}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/appointment', JSON.stringify({ id: entry.id }));
      }}
      onClick={() => onSelect(entry)}
      title={`${KIND_LABELS[entry.kind]} · ${entry.customerName}`}
    >
      <span>
        {timeLabel(entry)} {KIND_LABELS[entry.kind]}
      </span>
      <span className="chip-sub">
        {entry.customerName}
        {entry.overdue && <span className="badge locked">Überfällig</span>}
        {entry.conflicts.length > 0 && (
          <span className="conflict-icon" aria-label="Konflikt" title="Konflikt">
            ⚠︎
          </span>
        )}
      </span>
    </button>
  );
}

function CalendarView() {
  const me = useMe();
  const canViewAll = hasPermission(me, 'calendar.view_all');
  const canDrag = hasPermission(me, 'calendar.drag_drop');

  const [view, setView] = useState<ViewMode>('week');
  const [anchor, setAnchor] = useState(todayBerlinIso());
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [kindFilter, setKindFilter] = useState<Set<string>>(new Set(KINDS));
  const [userFilter, setUserFilter] = useState('');
  const [staffOptions, setStaffOptions] = useState<{ id: string; name: string }[]>([]);
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [open, setOpen] = useState<CalendarEntry[]>([]);
  const [selected, setSelected] = useState<CalendarEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (canViewAll) setScope('all');
  }, [canViewAll]);

  const days = useMemo(() => {
    if (view === 'day') return [anchor];
    if (view === 'week') {
      const monday = mondayOf(anchor);
      return Array.from({ length: 7 }, (_, index) => isoDayShift(monday, index));
    }
    // Monat: volle Wochen (Montag-Start), die den Monat abdecken.
    const first = firstOfMonth(anchor);
    const nextMonthFirst = firstOfMonth(isoDayShift(first, 32));
    const result: string[] = [];
    let cursor = mondayOf(first);
    while ((cursor < nextMonthFirst || result.length % 7 !== 0) && result.length < 42) {
      result.push(cursor);
      cursor = isoDayShift(cursor, 1);
    }
    return result;
  }, [view, anchor]);

  const load = useCallback(async () => {
    // Großzügiger UTC-Puffer um die Berliner Tagesgrenzen; die Zuordnung zu
    // Kalendertagen passiert clientseitig exakt über Europe/Berlin.
    const from = new Date(new Date(`${days[0]}T00:00:00Z`).getTime() - 12 * 3_600_000);
    const to = new Date(
      new Date(`${isoDayShift(days[days.length - 1]!, 1)}T00:00:00Z`).getTime() + 12 * 3_600_000,
    );
    const params = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      scope,
    });
    if (kindFilter.size < KINDS.length) params.set('kinds', [...kindFilter].join(','));
    if (userFilter !== '') params.set('userId', userFilter);
    const result = await apiFetch<{ entries: CalendarEntry[] }>(`/staff/calendar?${params}`);
    if (result.data !== null) {
      setEntries(result.data.entries);
      setError(null);
      setSelected((current) =>
        current === null
          ? null
          : (result.data!.entries.find((entry) => entry.id === current.id) ?? current),
      );
    } else {
      setError(result.errorMessage ?? 'Kalender konnte nicht geladen werden.');
    }
    const openResult = await apiFetch<{ entries: CalendarEntry[] }>('/staff/appointments/open');
    if (openResult.data !== null) setOpen(openResult.data.entries);
  }, [days, scope, kindFilter, userFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canViewAll) return;
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
  }, [canViewAll]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>();
    for (const entry of entries) {
      if (entry.startAt === null) continue;
      const day = berlinDayOf(entry.startAt);
      const list = map.get(day) ?? [];
      list.push(entry);
      map.set(day, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.startAt ?? '').localeCompare(b.startAt ?? ''));
    }
    return map;
  }, [entries]);

  async function dropOnDay(dayIso: string, payload: string) {
    try {
      const { id } = JSON.parse(payload) as { id: string };
      const entry = entries.find((item) => item.id === id);
      if (entry === undefined || entry.startAt === null) return;
      const wall = berlinWallTime(entry.startAt);
      const newStart = berlinWallTimeToIso(dayIso, wall.hour, wall.minute);
      let newEnd: string | null = null;
      if (entry.endAt !== null) {
        const duration = new Date(entry.endAt).getTime() - new Date(entry.startAt).getTime();
        newEnd = new Date(new Date(newStart).getTime() + duration).toISOString();
      }
      const label = `${berlinDateLabel(dayIso)}, ${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')} Uhr`;
      // Kurze Bestätigung vor dem Speichern; Konflikte blockieren NICHT –
      // sie werden nach dem Speichern als Warnung angezeigt (Order §16).
      if (!window.confirm(`Termin auf ${label} verschieben?`)) return;
      const result = await apiFetch(`/staff/appointments/${id}/schedule`, {
        method: 'PATCH',
        body: { startAt: newStart, endAt: newEnd, expectedVersion: entry.version },
      });
      if (!result.ok) setError(result.errorMessage ?? 'Verschieben fehlgeschlagen.');
      await load();
    } catch {
      /* ignorierte Drop-Daten */
    }
  }

  const today = todayBerlinIso();

  return (
    <main className="page page-wide">
      <h1>Kalender</h1>
      {error !== null && <p className="error">{error}</p>}

      <div className="calendar-toolbar">
        <span>
          <button onClick={() => setView('day')} className={view === 'day' ? 'primary' : ''}>
            Tag
          </button>{' '}
          <button onClick={() => setView('week')} className={view === 'week' ? 'primary' : ''}>
            Woche
          </button>{' '}
          <button onClick={() => setView('month')} className={view === 'month' ? 'primary' : ''}>
            Monat
          </button>
        </span>
        <span>
          <button
            aria-label="Zurück"
            onClick={() =>
              setAnchor(
                view === 'day'
                  ? isoDayShift(anchor, -1)
                  : view === 'week'
                    ? isoDayShift(anchor, -7)
                    : isoDayShift(firstOfMonth(anchor), -1),
              )
            }
          >
            ←
          </button>{' '}
          <button onClick={() => setAnchor(todayBerlinIso())}>Heute</button>{' '}
          <button
            aria-label="Weiter"
            onClick={() =>
              setAnchor(
                view === 'day'
                  ? isoDayShift(anchor, 1)
                  : view === 'week'
                    ? isoDayShift(anchor, 7)
                    : firstOfMonth(isoDayShift(firstOfMonth(anchor), 32)),
              )
            }
          >
            →
          </button>{' '}
          <strong>
            {view === 'month'
              ? new Date(`${firstOfMonth(anchor)}T12:00:00Z`).toLocaleDateString('de-DE', {
                  timeZone: 'UTC',
                  month: 'long',
                  year: 'numeric',
                })
              : berlinDateLabel(anchor)}
          </strong>
        </span>
        <span>
          {canViewAll && (
            <select
              aria-label="Terminbereich"
              value={scope}
              onChange={(event) => setScope(event.target.value as 'mine' | 'all')}
            >
              <option value="all">Alle Termine</option>
              <option value="mine">Meine Termine</option>
            </select>
          )}{' '}
          {KINDS.map((kind) => (
            <label key={kind} className="kind-filter">
              <input
                type="checkbox"
                checked={kindFilter.has(kind)}
                onChange={(event) => {
                  const next = new Set(kindFilter);
                  if (event.target.checked) next.add(kind);
                  else next.delete(kind);
                  setKindFilter(next);
                }}
              />
              <span>{KIND_LABELS[kind]}</span>
            </label>
          ))}{' '}
          {canViewAll && (
            <select
              aria-label="Mitarbeiterfilter"
              value={userFilter}
              onChange={(event) => setUserFilter(event.target.value)}
            >
              <option value="">Alle Mitarbeiter</option>
              {staffOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          )}
        </span>
      </div>

      <div className={`calendar-grid view-${view}`}>
        {days.map((day) => (
          <div
            key={day}
            className={`calendar-day ${day === today ? 'calendar-today' : ''} ${day.slice(0, 7) !== firstOfMonth(anchor).slice(0, 7) && view === 'month' ? 'calendar-outside' : ''}`}
            data-testid={`day-${day}`}
            onDragOver={(event) => {
              if (canDrag) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              void dropOnDay(day, event.dataTransfer.getData('text/appointment'));
            }}
          >
            <div className="calendar-day-head">{berlinDateLabel(day)}</div>
            {(byDay.get(day) ?? []).map((entry) => (
              <Chip key={entry.id} entry={entry} draggable={canDrag} onSelect={setSelected} />
            ))}
          </div>
        ))}
      </div>

      {open.length > 0 && (
        <div className="card">
          <h2>Ungeplant / organisatorisch offen</h2>
          <p className="muted">
            Diese Termine bestätigter Buchungen brauchen noch eine Zeit oder einen Mitarbeiter – sie
            erscheinen erst mit vollständiger Zeitposition im Kalenderraster.
          </p>
          {open.map((entry) => (
            <button key={entry.id} className="entry-row" onClick={() => setSelected(entry)}>
              <span>
                {KIND_LABELS[entry.kind]} · {entry.customerName}
                <span className="muted"> · {entry.processNumber}</span>
              </span>
              <span>
                {entry.startAt === null && <span className="badge">Zeit festlegen</span>}{' '}
                {entry.assignedUserId === null && (
                  <span className="badge">Mitarbeiter zuweisen</span>
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
    </main>
  );
}

export default function CalendarPage() {
  return (
    <AuthGuard>
      <CalendarView />
    </AuthGuard>
  );
}
