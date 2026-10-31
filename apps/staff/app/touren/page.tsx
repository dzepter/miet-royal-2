'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../components/auth-guard';
import { useOfflineNow } from '../../components/communication';
import {
  ActiveTourCard,
  PlanningStatusBadge,
  TourStatusBadge,
  useActiveTour,
} from '../../components/tours';
import { hasPermission } from '../../lib/api';
import { berlinDateLabel, isoDayShift, todayBerlinIso } from '../../lib/scheduling';
import { listTours, TOUR_TEXTS, warningText, type TourView } from '../../lib/tours';

/**
 * Touren (Phase 13, Design §13): Touren eines Tages mit Status, Fahrer/
 * Vertretung, Stoppzahl und Planungsstatus. „Neue Tour“ nur mit
 * calendar.manage; oben die eigene aktive Tour zum Fortsetzen.
 */
function tourHref(tour: TourView): string {
  return tour.status === 'active' ? `/touren/aktiv?id=${tour.id}` : `/touren/${tour.id}`;
}

function ToursList() {
  const me = useMe();
  const canManage = hasPermission(me, 'calendar.manage');
  const offlineNow = useOfflineNow();
  const [date, setDate] = useState(todayBerlinIso());
  const [tours, setTours] = useState<TourView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeTour = useActiveTour(!offlineNow);

  const load = useCallback(async () => {
    const result = await listTours(date);
    if (result.data !== null) {
      setTours(result.data.tours);
      setError(null);
    } else {
      setTours(null);
      setError(
        result.status === 0
          ? TOUR_TEXTS.onlineOnly
          : (result.errorMessage ?? 'Touren konnten nicht geladen werden.'),
      );
    }
  }, [date]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="page">
      <h1>Touren</h1>
      {activeTour !== null && <ActiveTourCard tour={activeTour} />}

      <div className="calendar-toolbar">
        <span>
          <button aria-label="Vortag" onClick={() => setDate(isoDayShift(date, -1))}>
            ←
          </button>{' '}
          <button onClick={() => setDate(todayBerlinIso())}>Heute</button>{' '}
          <button aria-label="Folgetag" onClick={() => setDate(isoDayShift(date, 1))}>
            →
          </button>
        </span>
        <span>
          <label htmlFor="tours-date" className="muted">
            Datum
          </label>
          <input
            id="tours-date"
            type="date"
            value={date}
            data-testid="tours-date"
            onChange={(event) => {
              if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) setDate(event.target.value);
            }}
          />
        </span>
        <span>
          {canManage && (
            <Link
              href={`/touren/neu?date=${date}`}
              className="button-like primary"
              data-testid="tours-new"
            >
              Neue Tour
            </Link>
          )}
        </span>
      </div>

      {error !== null && <p className="error">{error}</p>}

      <div className="card" data-testid="tours-list">
        <h2>Touren am {berlinDateLabel(date)}</h2>
        {tours === null ? (
          error === null && <p className="muted">Wird geladen …</p>
        ) : tours.length === 0 ? (
          <p className="muted">Für diesen Tag sind keine Touren angelegt.</p>
        ) : (
          tours.map((tour) => {
            const stopCount = tour.stops.filter((stop) => stop.state !== 'skipped').length;
            return (
              <div className="list-row" key={tour.id} data-testid={`tour-row-${tour.id}`}>
                <div>
                  <Link href={tourHref(tour)} data-testid={`tour-link-${tour.id}`}>
                    <strong>Tour {tour.assignedName ?? '–'}</strong>
                  </Link>
                  {tour.substituted && tour.effectiveDriverName !== null && (
                    <span className="muted"> · Vertretung: {tour.effectiveDriverName}</span>
                  )}
                  <div className="muted">
                    {stopCount === 1 ? '1 Stopp' : `${stopCount} Stopps`}
                    {tour.plannedStartAt !== null && tour.plannedEndAt !== null && (
                      <>
                        {' '}
                        ·{' '}
                        {new Date(tour.plannedStartAt).toLocaleTimeString('de-DE', {
                          timeZone: 'Europe/Berlin',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                        –
                        {new Date(tour.plannedEndAt).toLocaleTimeString('de-DE', {
                          timeZone: 'Europe/Berlin',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}{' '}
                        Uhr
                      </>
                    )}
                  </div>
                  {tour.warnings.length > 0 && (
                    <div className="warning-red" data-testid="tour-row-warnings">
                      ⚠︎ {tour.warnings.map(warningText).join(' · ')}
                    </div>
                  )}
                </div>
                <span>
                  <TourStatusBadge status={tour.status} />{' '}
                  <PlanningStatusBadge status={tour.planningStatus} />
                </span>
              </div>
            );
          })
        )}
      </div>
    </main>
  );
}

export default function ToursPage() {
  return (
    <AuthGuard>
      <ToursList />
    </AuthGuard>
  );
}
