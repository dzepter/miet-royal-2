'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../components/auth-guard';
import type { CleaningWarning, MissingCaseView } from '../lib/returns';
import { AppointmentPreview } from '../components/appointment-preview';
import { apiFetch, hasPermission } from '../lib/api';
import { customerName, formatEventDate, STATUS_LABELS, type ProcessRow } from '../lib/crm';
import { dayTimeLabel, KIND_LABELS, type CalendarEntry } from '../lib/scheduling';

/**
 * „Heute“ – die operative Startseite (Order §22/§37/§38):
 * 1. überfällige Rückgaben IMMER ganz oben, 2. heutige Termine,
 * 3. organisatorisch Offenes („Zeit festlegen“ / „Mitarbeiter zuweisen“),
 * 4. bei wenig Inhalt bis zu 2 kommende Termine. Keine Umsatzcharts.
 */

interface TodayData {
  scope: 'mine' | 'all';
  overdue: CalendarEntry[];
  today: CalendarEntry[];
  organizational: CalendarEntry[];
  upcoming: CalendarEntry[];
}

function EntryRow({
  entry,
  onSelect,
}: {
  entry: CalendarEntry;
  onSelect: (entry: CalendarEntry) => void;
}) {
  return (
    <button className="entry-row" onClick={() => onSelect(entry)}>
      <span>
        <strong>{dayTimeLabel(entry)}</strong> · {KIND_LABELS[entry.kind]} · {entry.customerName}
        <span className="muted"> · {entry.processNumber}</span>
      </span>
      <span>
        {entry.overdue && <span className="badge locked">Überfällig</span>}{' '}
        {entry.startAt === null && <span className="badge">Zeit festlegen</span>}{' '}
        {entry.assignedUserId === null && <span className="badge">Mitarbeiter zuweisen</span>}{' '}
        {entry.acknowledgementPending && <span className="badge">Übernahme ausstehend</span>}{' '}
        {entry.conflicts.length > 0 && (
          <span aria-label="Konflikt" title="Konflikt" className="conflict-icon">
            ⚠︎
          </span>
        )}
      </span>
    </button>
  );
}

interface WarehouseWarnings {
  lowStock: { itemId: string }[] | null;
  machineWarnings: { machineId: string; machineCode: string; reason: string }[] | null;
}

function Home() {
  const me = useMe();
  const [today, setToday] = useState<TodayData | null>(null);
  const [selected, setSelected] = useState<CalendarEntry | null>(null);
  const [myProcesses, setMyProcesses] = useState<ProcessRow[]>([]);
  const [warehouse, setWarehouse] = useState<WarehouseWarnings | null>(null);
  const [riskCount, setRiskCount] = useState(0);
  const [cleaningWarnings, setCleaningWarnings] = useState<CleaningWarning[]>([]);
  const [openMissing, setOpenMissing] = useState<MissingCaseView[]>([]);
  const canReturns = hasPermission(me, 'return.view');
  const canCalendar = hasPermission(me, 'calendar.view');
  const canSeeProcesses = hasPermission(me, 'process.view_all');
  const canWarehouse = hasPermission(me, 'machine.view') || hasPermission(me, 'inventory.view');

  const load = useCallback(async () => {
    if (!canCalendar) return;
    const result = await apiFetch<TodayData>('/staff/today');
    if (result.data !== null) {
      setToday(result.data);
      setSelected((current) => {
        if (current === null) return null;
        const all = [
          ...result.data!.overdue,
          ...result.data!.today,
          ...result.data!.organizational,
          ...result.data!.upcoming,
        ];
        return all.find((entry) => entry.id === current.id) ?? null;
      });
    }
  }, [canCalendar]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canSeeProcesses) return;
    void apiFetch<{ myProcesses: ProcessRow[] }>('/staff/dashboard').then((result) => {
      if (result.data !== null) setMyProcesses(result.data.myProcesses);
    });
  }, [canSeeProcesses]);

  useEffect(() => {
    if (!canWarehouse) return;
    void apiFetch<WarehouseWarnings>('/staff/warehouse/warnings').then((result) => {
      if (result.data !== null) setWarehouse(result.data);
    });
    // Phase 6 (Order §45): zugewiesene Maschinen, die für eine spätere
    // Buchung problematisch geworden sind – klarer Risikohinweis.
    void apiFetch<{ incidents: unknown[] }>('/staff/machine-risk-incidents').then((result) => {
      if (result.data !== null) setRiskCount(result.data.incidents.length);
    });
    // Phase 7 (Order §53): länger als 24 h in Reinigung – rote interne Warnung, kein Push.
    if (hasPermission(me, 'machine.view')) {
      void apiFetch<{ warnings: CleaningWarning[] }>('/staff/cleaning-warnings').then((result) => {
        if (result.data !== null) setCleaningWarnings(result.data.warnings);
      });
    }
  }, [canWarehouse, me]);

  const canMissingItems = canReturns && hasPermission(me, 'process.view_all');
  useEffect(() => {
    if (!canMissingItems) return;
    // Phase 7 (Order §13/§55): offene Fehlteil-Follow-ups ohne Fälligkeit
    // (vorgangsbezogen → nur mit Vorgangsrecht, serverseitig gefiltert).
    void apiFetch<{ cases: MissingCaseView[] }>('/staff/missing-items').then((result) => {
      if (result.data !== null) setOpenMissing(result.data.cases);
    });
  }, [canMissingItems]);

  // Kompakte Maschinen-/Lagerwarnungen (Order §48/UX_RULES „Heute“ Nr. 4)
  // – die operative Startseite bleibt schlank, Details hinter dem Link.
  const lowStockCount = warehouse?.lowStock?.length ?? 0;
  const machineWarningCount = warehouse?.machineWarnings?.length ?? 0;
  const warehouseCard =
    lowStockCount > 0 ||
    machineWarningCount > 0 ||
    riskCount > 0 ||
    cleaningWarnings.length > 0 ||
    openMissing.length > 0 ? (
      <div className="card" data-testid="warehouse-warnings">
        <h2>Maschinen- &amp; Lagerwarnungen</h2>
        {cleaningWarnings.length > 0 && (
          <p className="warning-red" data-testid="cleaning-warning">
            🧽{' '}
            {cleaningWarnings.length === 1
              ? `Maschine ${cleaningWarnings[0]!.machineCode} ist seit ${cleaningWarnings[0]!.hoursInCleaning} h in Reinigung (länger als 24 h)`
              : `${cleaningWarnings.length} Maschinen sind länger als 24 h in Reinigung`}{' '}
            <Link href={`/maschinen/${cleaningWarnings[0]!.machineId}`}>Maschine öffnen</Link>
          </p>
        )}
        {openMissing.length > 0 && (
          <p data-testid="missing-items-warning">
            <Link href={`/maschinen/${openMissing[0]!.machineId}`}>
              Offene Fehlteile: {openMissing.length} (
              {openMissing.map((c) => c.machineCode).join(', ')})
            </Link>
          </p>
        )}
        {riskCount > 0 && (
          <p>
            <Link href="/maschinen/risiken" data-testid="risk-incidents-link">
              ⚠️ {riskCount === 1 ? '1 zugewiesene Maschine' : `${riskCount} zugewiesene Maschinen`}{' '}
              für zukünftige Buchungen problematisch
            </Link>
          </p>
        )}
        {machineWarningCount > 0 && (
          <p>
            <Link href="/maschinen">
              {machineWarningCount === 1
                ? '1 Maschine nicht regulär einsetzbar'
                : `${machineWarningCount} Maschinen nicht regulär einsetzbar`}
            </Link>
          </p>
        )}
        {lowStockCount > 0 && (
          <p>
            <Link href="/lager">Lagerbestand niedrig: {lowStockCount} Artikel</Link>
          </p>
        )}
      </div>
    ) : null;

  const dateLabel = new Date().toLocaleDateString('de-DE', {
    timeZone: 'Europe/Berlin',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return (
    <main className="page">
      <h1>Heute</h1>
      <p className="muted">
        Willkommen{me !== null ? `, ${me.user.firstName}` : ''} · {dateLabel}
      </p>

      {canCalendar && today !== null && (
        <>
          {today.overdue.length > 0 && (
            <div className="card overdue-card">
              <h2>Überfällige Rückgaben</h2>
              {today.overdue.map((entry) => (
                <EntryRow key={entry.id} entry={entry} onSelect={setSelected} />
              ))}
            </div>
          )}

          <div className="card">
            <h2>Heutige Termine</h2>
            {today.today.length === 0 ? (
              <p className="muted">Heute stehen keine Termine an.</p>
            ) : (
              today.today.map((entry) => (
                <EntryRow key={entry.id} entry={entry} onSelect={setSelected} />
              ))
            )}
          </div>

          {today.organizational.length > 0 && (
            <div className="card">
              <h2>Organisatorisch offen</h2>
              {today.organizational.map((entry) => (
                <EntryRow key={entry.id} entry={entry} onSelect={setSelected} />
              ))}
            </div>
          )}

          {warehouseCard}

          {today.upcoming.length > 0 && (
            <div className="card">
              <h2>Nächste Termine</h2>
              {today.upcoming.map((entry) => (
                <EntryRow key={entry.id} entry={entry} onSelect={setSelected} />
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
        </>
      )}

      {!canCalendar && warehouseCard}

      {canSeeProcesses && myProcesses.length > 0 && (
        <div className="card">
          <h2>Meine Vorgänge</h2>
          {myProcesses.map((process) => (
            <div className="list-row" key={process.id}>
              <div>
                <Link href={`/vorgaenge/${process.id}`}>{process.processNumber}</Link> ·{' '}
                {customerName(process)}
                <div className="muted">Event: {formatEventDate(process.eventDate)}</div>
              </div>
              <span className="badge">{STATUS_LABELS[process.mainStatus]}</span>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

export default function HomePage() {
  return (
    <AuthGuard>
      <Home />
    </AuthGuard>
  );
}
