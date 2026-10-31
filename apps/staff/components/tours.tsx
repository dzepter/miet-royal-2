'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { berlinTime, timeLabel } from '../lib/scheduling';
import {
  ADDRESS_STATUS_LABELS,
  getActiveTour,
  KIND_SHORT_LABELS,
  PLANNING_STATUS_LABELS,
  providerLabel,
  STOP_STATE_LABELS,
  TOUR_STATUS_LABELS,
  TOUR_TEXTS,
  type ActiveTourConflict,
  type TourAddressStatus,
  type TourStopState,
  type TourStopView,
  type TourView,
} from '../lib/tours';

/**
 * Phase 13 (UI): kleine, wiederverwendete Bausteine der Touren-Seiten
 * (Design §13) – Badges, Attribution, Karte „Aktive Tour fortsetzen“.
 */

/** Phase 13 Final (§7): eigene aktive Tour plus Konflikt (mehrere aktive Touren derselben Person). */
export interface ActiveTourState {
  tour: TourView | null;
  conflict: ActiveTourConflict | null;
}

/** Eigene aktive Tour (inkl. Vertretung) – tour null, wenn keine; nur online abgefragt. */
export function useActiveTour(enabled: boolean): ActiveTourState {
  const [state, setState] = useState<ActiveTourState>({ tour: null, conflict: null });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void getActiveTour().then((result) => {
      if (!cancelled && result.data !== null) {
        setState({ tour: result.data.tour, conflict: result.data.conflict ?? null });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return state;
}

/**
 * Phase 13 Final (§7): deutlich sichtbarer Hinweis „Mehrere aktive Touren gleichzeitig –
 * Planung prüfen.“ – alle betroffenen Touren bleiben über ihre ID erreichbar; nichts
 * wird automatisch beendet oder übertragen.
 */
export function ActiveTourConflictNotice({ conflict }: { conflict: ActiveTourConflict }) {
  return (
    <div className="warning-red" role="alert" data-testid="active-tour-conflict">
      ⚠︎ {TOUR_TEXTS.multipleActiveTours}
      <ul>
        {conflict.tours.map((entry) => (
          <li key={entry.id}>
            <Link
              href={`/touren/aktiv?id=${entry.id}`}
              data-testid={`active-tour-conflict-link-${entry.id}`}
            >
              Tour {entry.assignedName ?? '–'}
              {entry.substituted && entry.effectiveDriverName !== null && (
                <> (Vertretung: {entry.effectiveDriverName})</>
              )}
              {entry.startedAt !== null && <> · gestartet {berlinTime(entry.startedAt)} Uhr</>}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ActiveTourCard({
  tour,
  conflict = null,
}: {
  tour: TourView;
  conflict?: ActiveTourConflict | null;
}) {
  const remaining = tour.stops.filter(
    (stop) => stop.state === 'open' || stop.state === 'arrived',
  ).length;
  const next = tour.nextStop;
  return (
    <div className="card next-stop-card" data-testid="active-tour-card">
      <h2>Aktive Tour</h2>
      {conflict !== null && <ActiveTourConflictNotice conflict={conflict} />}
      <p>
        {remaining === 1 ? '1 offener Stopp' : `${remaining} offene Stopps`}
        {next !== null && (
          <>
            {' '}
            · Nächster Stopp: {KIND_SHORT_LABELS[next.appointment.kind]}{' '}
            {next.appointment.processNumber}
            {next.appointment.startAt !== null && <> · {timeLabel(next.appointment)}</>}
          </>
        )}
      </p>
      <p>
        <Link href="/touren/aktiv" className="button-like primary" data-testid="active-tour-resume">
          Aktive Tour fortsetzen
        </Link>
      </p>
    </div>
  );
}

export function TourStatusBadge({ status }: { status: TourView['status'] }) {
  const cls = status === 'active' ? 'active' : status === 'cancelled' ? 'locked' : '';
  return (
    <span className={`badge ${cls}`} data-testid="tour-status">
      {TOUR_STATUS_LABELS[status]}
    </span>
  );
}

export function PlanningStatusBadge({ status }: { status: TourView['planningStatus'] }) {
  const cls =
    status === 'planned'
      ? 'ok'
      : status === 'infeasible'
        ? 'risk'
        : status === 'stale'
          ? 'warn'
          : '';
  return (
    <span className={`badge ${cls}`} data-testid="tour-planning-status">
      {PLANNING_STATUS_LABELS[status]}
    </span>
  );
}

export function StopStateBadge({ state }: { state: TourStopState }) {
  const cls =
    state === 'done' ? 'ok' : state === 'skipped' ? 'locked' : state === 'arrived' ? 'active' : '';
  return <span className={`badge ${cls}`}>{STOP_STATE_LABELS[state]}</span>;
}

export function AddressStatusBadge({ status }: { status: TourAddressStatus }) {
  const cls = status === 'ok' ? 'ok' : status === 'review_required' ? 'warn' : 'locked';
  return (
    <span className={`badge ${cls}`} data-testid="address-status" data-status={status}>
      {ADDRESS_STATUS_LABELS[status]}
    </span>
  );
}

export function DelayBadge({ stop }: { stop: TourStopView }) {
  const delay = stop.delay;
  if (delay === undefined || delay.status === 'none') return null;
  if (delay.status === 'risk') {
    return (
      <span className="badge risk" data-testid="stop-delay-risk">
        Verspätungsrisiko
        {delay.predictedArrivalAt !== undefined && (
          <> · voraussichtlich {berlinTime(delay.predictedArrivalAt)} Uhr</>
        )}
      </span>
    );
  }
  return (
    <span className="badge" title={TOUR_TEXTS.delayUnknown}>
      Prognose nicht verfügbar
    </span>
  );
}

/** OSM-Attribution (ODbL) – Pflicht bei angezeigten Routenwerten; plus Hinweis auf Simulation. */
export function RouteAttribution({ provider }: { provider: string | null | undefined }) {
  const simulation = providerLabel(provider);
  return (
    <p className="osm-attribution" data-testid="route-attribution">
      Routenwerte:{' '}
      <a href={TOUR_TEXTS.osmAttributionUrl} target="_blank" rel="noopener noreferrer">
        {TOUR_TEXTS.osmAttribution}
      </a>
      {simulation !== null && (
        <>
          {' '}
          · <span data-testid="route-simulation">{simulation}</span>
        </>
      )}
    </p>
  );
}

/** Kurzzeile eines Stopps: Art · Vorgangsnummer · Kunde (falls sichtbar). */
export function stopTitle(stop: TourStopView): string {
  const parts = [KIND_SHORT_LABELS[stop.appointment.kind], stop.appointment.processNumber];
  if (stop.appointment.customerName !== null) parts.push(stop.appointment.customerName);
  return parts.join(' · ');
}

export function StopTime({
  stop,
}: {
  stop: { appointment: Pick<TourStopView['appointment'], 'startAt' | 'endAt'> };
}) {
  const { startAt, endAt } = stop.appointment;
  if (startAt === null) return <span className="muted">ohne Zeitvorgabe</span>;
  return (
    <span>
      {endAt === null ? 'Fester Termin ' : 'Zeitfenster '}
      {timeLabel({ startAt, endAt })}
    </span>
  );
}
