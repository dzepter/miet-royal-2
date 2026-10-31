'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthGuard, useMe } from '../../../components/auth-guard';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import {
  DelayBadge,
  RouteAttribution,
  StopStateBadge,
  StopTime,
  stopTitle,
} from '../../../components/tours';
import { hasPermission } from '../../../lib/api';
import { useOffline } from '../../../lib/offline/provider';
import { berlinDateLabel, berlinTime, timeLabel } from '../../../lib/scheduling';
import {
  endTour,
  formatKm,
  formatMinutes,
  getActiveTour,
  getTour,
  KIND_SHORT_LABELS,
  markArrived,
  navigationHref,
  navigationPlatform,
  nextOpenStop,
  recalculatePlan,
  sendLocation,
  shouldSendLocation,
  takeoverTour,
  TOUR_TEXTS,
  tourErrorText,
  warningText,
  type LocationSendState,
  type OfflineTourSnapshot,
  type TourStopView,
  type TourView,
} from '../../../lib/tours';

/**
 * Aktive Tour (Phase 13, Design §9/§11/§12/§13; Order §32–§48): mobile-first.
 * Nächster Stopp groß (Art, Vorgangsnummer, Zeit/Fenster, Adresse, Navigation
 * starten, Zum Vorgang, Angekommen), darunter verbleibende Stopps mit Status,
 * geplanter Ankunft und Verspätungswarnung; Banner bei Verspätungsrisiko mit
 * „Kunden kontaktieren“; Route neu berechnen; Tour übernehmen (fremde aktive
 * Tour, nur online, Bestätigung); Tour beenden (+ Planer-Dialog mit Grund).
 *
 * Standort (Order §38–§45): `watchPosition` NUR auf dieser Seite, NUR bei
 * eigener aktiver Tour und NUR nach Klick „Standort freigeben“; Zustand
 * ausschließlich im Speicher der Seite (Refs), nichts im Browser gespeichert;
 * Drossel ≥ 60 s oder ≥ 250 m, nie öfter als 15 s; Watch stoppt beim
 * Verlassen, bei Tourende, offline und bei 404 (Tour nicht mehr aktiv/fremd).
 * PWA-/iOS-Grenze: kein Hintergrund-GPS – ist die Seite nicht im Vordergrund,
 * kommen keine Positionen; der Server markiert den letzten Standort nach
 * 10 Minuten als „nicht aktuell“.
 */

type GpsState = 'idle' | 'requesting' | 'active' | 'denied' | 'unsupported' | 'error';

/** Vereinheitlichte Stoppdarstellung für Online-View und Offline-Snapshot. */
interface StopRow {
  stopId: string;
  sequence: number;
  kind: TourStopView['appointment']['kind'];
  processNumber: string;
  processId: string;
  startAt: string | null;
  endAt: string | null;
  addressLines: string[];
  navigation: TourStopView['navigation'];
  state: TourStopView['state'];
  view: TourStopView | null;
}

function rowsFromView(tour: TourView): StopRow[] {
  return [...tour.stops]
    .sort((a, b) => a.sequence - b.sequence)
    .map((stop) => ({
      stopId: stop.id,
      sequence: stop.sequence,
      kind: stop.appointment.kind,
      processNumber: stop.appointment.processNumber,
      processId: stop.appointment.processId,
      startAt: stop.appointment.startAt,
      endAt: stop.appointment.endAt,
      addressLines: stop.address.lines.length > 0 ? stop.address.lines : [stop.address.label],
      navigation: stop.navigation,
      state: stop.state,
      view: stop,
    }));
}

function rowsFromSnapshot(snapshot: OfflineTourSnapshot): StopRow[] {
  return [...(snapshot.stops ?? [])]
    .sort((a, b) => a.sequence - b.sequence)
    .map((stop) => ({
      stopId: stop.stopId,
      sequence: stop.sequence,
      kind: stop.kind,
      processNumber: stop.processNumber,
      processId: stop.processId,
      startAt: stop.startAt ?? null,
      endAt: stop.endAt ?? null,
      addressLines: stop.addressLines ?? [],
      navigation: stop.navigation ?? null,
      state: stop.state,
      view: null,
    }));
}

const POLL_MS = 60_000;

function ActiveTour() {
  const me = useMe();
  const search = useSearchParams();
  const requestedId = search.get('id');
  const offline = useOffline();
  const offlineNow = offline?.state.connectivity === 'offline';
  const canManage = hasPermission(me, 'calendar.manage');
  const myId = me?.user.id;

  const [tour, setTour] = useState<TourView | null>(null);
  const [snapshot, setSnapshot] = useState<OfflineTourSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [fromSnapshot, setFromSnapshot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'takeover' | 'end' | null>(null);
  const [forceReason, setForceReason] = useState<string | null>(null);
  const [gps, setGps] = useState<GpsState>('idle');
  const [lastSentAt, setLastSentAt] = useState<string | null>(null);
  const [platform] = useState(() =>
    navigationPlatform(typeof navigator === 'undefined' ? '' : navigator.userAgent),
  );

  // Standort-Zustand NUR im Speicher dieser Seite (nie localStorage/IndexedDB).
  const watchIdRef = useRef<number | null>(null);
  const sendStateRef = useRef<LocationSendState>({ lastSentAt: null, lastSentPoint: null });
  const tourRef = useRef<TourView | null>(null);
  tourRef.current = tour;
  // Verbindungszustand für den Watch-Callback (Closure würde sonst einen alten Stand sehen).
  const offlineNowRef = useRef(offlineNow);
  offlineNowRef.current = offlineNow;

  const stopWatch = useCallback(() => {
    if (
      watchIdRef.current !== null &&
      typeof navigator !== 'undefined' &&
      'geolocation' in navigator
    ) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
    watchIdRef.current = null;
    sendStateRef.current = { lastSentAt: null, lastSentPoint: null };
  }, []);

  const readSnapshot = useCallback(async () => {
    if (offline === null) return null;
    try {
      const info = (await offline.runtime.packageInfo()) as
        ({ activeTour?: OfflineTourSnapshot | null } & Record<string, unknown>) | null;
      return info?.activeTour ?? null;
    } catch {
      return null;
    }
  }, [offline]);

  const load = useCallback(async () => {
    if (offlineNow) {
      setSnapshot(await readSnapshot());
      setFromSnapshot(true);
      setLoaded(true);
      return;
    }
    const result = requestedId === null ? await getActiveTour() : await getTour(requestedId);
    if (result.data !== null) {
      setTour(result.data.tour);
      setFromSnapshot(false);
      setError(null);
    } else if (result.status === 0) {
      // Server nicht erreichbar: Offline-Snapshot des Arbeitspakets anzeigen (Design §11).
      setSnapshot(await readSnapshot());
      setFromSnapshot(true);
    } else if (result.status === 404) {
      setTour(null);
      setError('Tour nicht gefunden.');
    } else {
      setError(tourErrorText(result, 'Die Tour konnte nicht geladen werden.'));
    }
    setLoaded(true);
  }, [offlineNow, readSnapshot, requestedId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Regelmäßig aktualisieren (Delay-/Standortstatus), nur online, sichtbar und aktiv.
  useEffect(() => {
    if (offlineNow || tour === null || tour.status !== 'active') return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !busy) void load();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [offlineNow, tour, busy, load]);

  const isDriver =
    tour !== null &&
    myId !== undefined &&
    (tour.effectiveDriverId === myId ||
      (tour.effectiveDriverId === null && tour.assignedUserId === myId));
  const active = tour !== null && tour.status === 'active';
  const canOperate = active && (isDriver || canManage) && !offlineNow;

  // Watch stoppen, sobald die Tour nicht mehr aktiv/eigen ist oder die Verbindung fehlt.
  useEffect(() => {
    if (!active || !isDriver || offlineNow) {
      stopWatch();
      if (gps === 'active' || gps === 'requesting') setGps('idle');
    }
  }, [active, isDriver, offlineNow, stopWatch, gps]);

  // Watch beim Verlassen der Seite stoppen.
  useEffect(() => stopWatch, [stopWatch]);

  function onPosition(position: GeolocationPosition) {
    const current = tourRef.current;
    if (current === null || current.status !== 'active') return;
    if (offlineNowRef.current) return; // offline verwerfen, nie nachsenden
    const point = { latitude: position.coords.latitude, longitude: position.coords.longitude };
    const now = Date.now();
    if (!shouldSendLocation(sendStateRef.current, point, now)) return;
    sendStateRef.current = { lastSentAt: now, lastSentPoint: point };
    setGps('active');
    void sendLocation(current.id, {
      latitude: point.latitude,
      longitude: point.longitude,
      ...(Number.isFinite(position.coords.accuracy)
        ? { accuracyMeters: Math.min(100_000, Math.max(0, Math.round(position.coords.accuracy))) }
        : {}),
      observedAt: new Date(position.timestamp).toISOString(),
    }).then((result) => {
      if (result.ok || result.status === 429) {
        setLastSentAt(new Date(now).toISOString());
        return;
      }
      if (result.status === 404) {
        // Tour nicht mehr aktiv oder nicht (mehr) eigener Fahrer: Watch beenden.
        stopWatch();
        setGps('idle');
        void load();
      }
    });
  }

  function onPositionError(positionError: GeolocationPositionError) {
    if (positionError.code === positionError.PERMISSION_DENIED) {
      stopWatch();
      setGps('denied');
      return;
    }
    setGps('error');
  }

  function enableLocation() {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setGps('unsupported');
      return;
    }
    if (watchIdRef.current !== null) return;
    setGps('requesting');
    watchIdRef.current = navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      maximumAge: 10_000,
      timeout: 30_000,
    });
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  async function applyResult(
    result: {
      ok: boolean;
      data: { tour: TourView } | null;
      status: number;
      errorCode: string | null;
      errorMessage: string | null;
    },
    fallback: string,
  ): Promise<boolean> {
    if (result.ok && result.data !== null) {
      setTour(result.data.tour);
      setError(null);
      return true;
    }
    if (result.status === 409 && result.errorCode === 'TOUR_VERSION_CONFLICT') {
      await load();
      setNotice(TOUR_TEXTS.versionConflict);
      return false;
    }
    setError(tourErrorText(result, fallback));
    return false;
  }

  async function arrived(stopId: string) {
    if (tour === null) return;
    await run(async () => {
      await applyResult(
        await markArrived(tour.id, stopId),
        'Die Ankunft konnte nicht gespeichert werden.',
      );
    });
  }

  async function recalculate() {
    if (tour === null) return;
    await run(async () => {
      await applyResult(
        await recalculatePlan(tour.id, tour.version),
        'Die Route konnte nicht neu berechnet werden.',
      );
    });
  }

  async function takeover() {
    if (tour === null) return;
    setConfirm(null);
    await run(async () => {
      const ok = await applyResult(
        await takeoverTour(tour.id, tour.version),
        'Die Tour konnte nicht übernommen werden.',
      );
      if (ok) setNotice('Du hast die Tour übernommen.');
    });
  }

  async function end(force: boolean) {
    if (tour === null) return;
    setConfirm(null);
    await run(async () => {
      const result = await endTour(
        tour.id,
        force ? { force: true, reason: (forceReason ?? '').trim() } : {},
      );
      if (!result.ok && result.errorCode === 'TOUR_HAS_OPEN_STOPS') {
        setError(TOUR_TEXTS.openStops);
        if (canManage && !force) setForceReason('');
        return;
      }
      const ok = await applyResult(result, 'Die Tour konnte nicht beendet werden.');
      if (ok) {
        setForceReason(null);
        stopWatch();
        setGps('idle');
        setNotice('Tour beendet.');
      }
    });
  }

  // ── Daten für die Darstellung (Online-View oder Offline-Snapshot) ─────────

  const rows = useMemo<StopRow[]>(() => {
    if (tour !== null && !fromSnapshot) return rowsFromView(tour);
    if (snapshot !== null) return rowsFromSnapshot(snapshot);
    return [];
  }, [tour, fromSnapshot, snapshot]);

  const next = useMemo<StopRow | null>(() => {
    if (tour !== null && !fromSnapshot && tour.nextStop !== null) {
      return rows.find((row) => row.stopId === tour.nextStop!.id) ?? nextOpenStop(rows);
    }
    return nextOpenStop(rows);
  }, [tour, fromSnapshot, rows]);

  const remaining = rows.filter(
    (row) => row.stopId !== next?.stopId && (row.state === 'open' || row.state === 'arrived'),
  );
  const finished = rows.filter((row) => row.state === 'done' || row.state === 'skipped');
  const riskStops = tour === null ? [] : tour.stops.filter((stop) => stop.delay?.status === 'risk');
  const delayUnknown =
    tour !== null &&
    tour.status === 'active' &&
    tour.stops.some((stop) => stop.delay?.status === 'unknown');
  const forceValid =
    (forceReason ?? '').trim().length >= 3 && (forceReason ?? '').trim().length <= 500;
  const showingSnapshot = fromSnapshot && snapshot !== null;
  const headerDate = tour !== null && !fromSnapshot ? tour.tourDate : (snapshot?.tourDate ?? null);

  if (!loaded) {
    return (
      <main className="page">
        <h1>Aktive Tour</h1>
        <p className="muted">Wird geladen …</p>
      </main>
    );
  }

  if (!showingSnapshot && tour === null) {
    return (
      <main className="page">
        <h1>Aktive Tour</h1>
        {error !== null ? (
          <p className="error">{error}</p>
        ) : (
          <p className="muted" data-testid="no-active-tour">
            {offlineNow
              ? 'Offline ist keine aktive Tour gespeichert.'
              : 'Derzeit ist keine Tour aktiv.'}
          </p>
        )}
        <p>
          <Link href="/touren">Zu den Touren</Link>
        </p>
      </main>
    );
  }

  const canOpenProcess = tour !== null && !fromSnapshot && tour.canOpenProcess;

  return (
    <main className="page" data-testid="active-tour-page">
      <h1>Aktive Tour{headerDate !== null && <> · {berlinDateLabel(headerDate)}</>}</h1>
      {tour !== null && !fromSnapshot && (
        <p className="muted" data-testid="active-tour-driver">
          Fahrer: {tour.assignedName ?? '–'}
          {tour.substituted && tour.effectiveDriverName !== null && (
            <> · Vertretung: {tour.effectiveDriverName}</>
          )}
          {tour.status !== 'active' && (
            <> · Status: {tour.status === 'completed' ? 'beendet' : tour.status}</>
          )}
        </p>
      )}

      {(offlineNow || showingSnapshot) && (
        <div className="offline-banner" role="status" data-testid="active-tour-offline">
          Offline – Stand des letzten Arbeitspakets. {TOUR_TEXTS.onlineOnly}
        </div>
      )}
      {notice !== null && (
        <p className="conflict-box" role="status" data-testid="active-tour-notice">
          {notice}
        </p>
      )}
      {error !== null && (
        <p className="error" role="alert" data-testid="active-tour-error">
          {error}
        </p>
      )}

      {riskStops.length > 0 && (
        <div className="delay-banner" role="alert" data-testid="delay-banner">
          Tour droht Termin zu verpassen – {riskStops[0]!.appointment.processNumber}
          {riskStops[0]!.delay?.predictedArrivalAt !== undefined && (
            <span className="muted">
              {' '}
              · voraussichtlich {berlinTime(riskStops[0]!.delay!.predictedArrivalAt!)} Uhr
            </span>
          )}
          {canOpenProcess && (
            <>
              {' '}
              <Link
                href={`/vorgaenge/${riskStops[0]!.appointment.processId}/kommunikation`}
                data-testid="delay-contact-customer"
              >
                Kunden kontaktieren
              </Link>
            </>
          )}
        </div>
      )}
      {delayUnknown && (
        <p className="muted" data-testid="delay-unknown">
          {TOUR_TEXTS.delayUnknown}
        </p>
      )}
      {tour !== null && !fromSnapshot && tour.warnings.length > 0 && (
        <div className="conflict-box" data-testid="active-tour-warnings">
          {tour.warnings.map((warning, index) => (
            <div key={`${warning.code}-${index}`}>⚠︎ {warningText(warning)}</div>
          ))}
        </div>
      )}

      {/* ── Standort (nur eigene aktive Tour, nur online) ─────────────────── */}
      {active && isDriver && !fromSnapshot && (
        <div className="card" data-testid="location-card">
          {gps === 'idle' && (
            <p>
              <button
                type="button"
                className="primary"
                disabled={offlineNow}
                data-testid="location-enable"
                onClick={enableLocation}
              >
                Standort freigeben
              </button>{' '}
              <span className="muted">
                Nur während der aktiven Tour und nur, solange diese Seite geöffnet ist.
              </span>
            </p>
          )}
          {gps === 'requesting' && (
            <p className="muted" data-testid="location-requesting">
              Standort wird ermittelt …
            </p>
          )}
          {gps === 'active' && (
            <p className="muted" data-testid="location-active">
              Standort wird übermittelt
              {lastSentAt !== null && <> · zuletzt {berlinTime(lastSentAt)} Uhr</>}
            </p>
          )}
          {(gps === 'denied' || gps === 'unsupported') && (
            <p className="warning-red" data-testid="location-denied">
              {TOUR_TEXTS.locationUnavailable}
            </p>
          )}
          {gps === 'error' && (
            <p className="warning-red" data-testid="location-error">
              {TOUR_TEXTS.locationUnavailable}
            </p>
          )}
          {tour.liveLocation !== undefined &&
            tour.liveLocation !== null &&
            tour.liveLocation.stale && (
              <p className="warning-red" data-testid="location-stale">
                {TOUR_TEXTS.locationStale}
              </p>
            )}
        </div>
      )}
      {tour !== null &&
        !fromSnapshot &&
        !isDriver &&
        tour.liveLocation !== undefined &&
        tour.liveLocation !== null &&
        tour.liveLocation.stale && (
          <p className="warning-red" data-testid="location-stale">
            {TOUR_TEXTS.locationStale}
          </p>
        )}

      {/* ── Nächster Stopp ────────────────────────────────────────────────── */}
      {next === null ? (
        <div className="card next-stop-card" data-testid="next-stop-none">
          <h2>Alle Stopps erledigt</h2>
          <p className="muted">Die Tour kann beendet werden.</p>
        </div>
      ) : (
        <div className="card next-stop-card" data-testid="next-stop" data-stop-id={next.stopId}>
          <h2>Nächster Stopp</h2>
          <p className="big">
            <strong>{KIND_SHORT_LABELS[next.kind]}</strong> · {next.processNumber}
            {next.view !== null && next.view.appointment.customerName !== null && (
              <> · {next.view.appointment.customerName}</>
            )}
          </p>
          <p className="big" data-testid="next-stop-time">
            {next.startAt === null ? (
              <span className="muted">ohne Zeitvorgabe</span>
            ) : (
              <>
                {next.endAt === null ? 'Fester Termin ' : 'Zeitfenster '}
                {timeLabel({ startAt: next.startAt, endAt: next.endAt })}
              </>
            )}
          </p>
          <p data-testid="next-stop-address">
            {next.addressLines.map((line, index) => (
              <span key={index}>
                {line}
                <br />
              </span>
            ))}
          </p>
          {next.view !== null && (
            <p>
              <StopStateBadge state={next.view.state} /> <DelayBadge stop={next.view} />
              {next.view.plannedArrivalAt !== null && (
                <span className="muted">
                  {' '}
                  · geplante Ankunft {berlinTime(next.view.plannedArrivalAt)} Uhr
                </span>
              )}
            </p>
          )}
          <div className="tour-actions">
            {navigationHref(next.navigation, platform) !== null && (
              <a
                className="button-like primary"
                href={navigationHref(next.navigation, platform)!}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="navigation-start"
                data-platform={platform}
              >
                Navigation starten
              </a>
            )}
            {canOpenProcess && (
              <Link
                href={`/vorgaenge/${next.processId}`}
                className="button-like"
                data-testid="next-stop-process"
              >
                Zum Vorgang
              </Link>
            )}
            {next.view !== null && next.view.state === 'open' && canOperate && (
              <button
                type="button"
                disabled={busy}
                data-testid="stop-arrived"
                onClick={() => void arrived(next.stopId)}
              >
                Angekommen
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Verbleibende Stopps ───────────────────────────────────────────── */}
      <div className="card" data-testid="remaining-stops">
        <h2>Verbleibende Stopps</h2>
        {remaining.length === 0 ? (
          <p className="muted">Keine weiteren Stopps.</p>
        ) : (
          remaining.map((row) => (
            <div
              className="tour-stop"
              key={row.stopId}
              data-testid={`remaining-stop-${row.stopId}`}
            >
              <span className="seq">{row.sequence}.</span>
              <div className="stop-main">
                <div>
                  <strong>
                    {row.view !== null
                      ? stopTitle(row.view)
                      : `${KIND_SHORT_LABELS[row.kind]} · ${row.processNumber}`}
                  </strong>
                </div>
                <div>
                  <StopTime stop={{ appointment: { startAt: row.startAt, endAt: row.endAt } }} />
                </div>
                <div className="muted">{row.addressLines.join(', ')}</div>
                <div>
                  <StopStateBadge state={row.state} />{' '}
                  {row.view !== null && <DelayBadge stop={row.view} />}
                  {row.view !== null && row.view.plannedArrivalAt !== null && (
                    <span className="muted">
                      {' '}
                      · geplante Ankunft {berlinTime(row.view.plannedArrivalAt)} Uhr
                    </span>
                  )}
                </div>
                {navigationHref(row.navigation, platform) !== null && (
                  <a
                    href={navigationHref(row.navigation, platform)!}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid={`navigation-${row.stopId}`}
                  >
                    Navigation
                  </a>
                )}
              </div>
            </div>
          ))
        )}
        {finished.length > 0 && (
          <>
            <h2 style={{ marginTop: '1rem' }}>Erledigt / übersprungen</h2>
            {finished.map((row) => (
              <div
                className="tour-stop"
                key={row.stopId}
                data-testid={`finished-stop-${row.stopId}`}
              >
                <span className="seq">{row.sequence}.</span>
                <div className="stop-main">
                  {KIND_SHORT_LABELS[row.kind]} · {row.processNumber}{' '}
                  <StopStateBadge state={row.state} />
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {tour !== null && !fromSnapshot && tour.routeCalculatedAt !== null && (
        <div className="card" data-testid="active-tour-metrics">
          <p className="muted">
            Restroute: {formatKm(tour.plannedDistanceMeters)} ·{' '}
            {formatMinutes(tour.plannedDurationSeconds)}
            {tour.plannedEndAt !== null && <> · Ende ca. {berlinTime(tour.plannedEndAt)} Uhr</>}
          </p>
          <RouteAttribution provider={tour.routeProvider} />
        </div>
      )}

      {/* ── Aktionen ──────────────────────────────────────────────────────── */}
      {tour !== null && !fromSnapshot && (
        <div className="card" data-testid="active-tour-actions">
          <div className="tour-actions">
            {active && (isDriver || canManage) && (
              <button
                type="button"
                disabled={busy || offlineNow}
                data-testid="tour-recalculate"
                onClick={() => void recalculate()}
              >
                Route neu berechnen
              </button>
            )}
            {tour.canTakeover && active && (
              <button
                type="button"
                className="primary"
                disabled={busy || offlineNow}
                data-testid="tour-takeover"
                onClick={() => setConfirm('takeover')}
              >
                Tour übernehmen
              </button>
            )}
            {tour.canEnd && active && (
              <button
                type="button"
                className="danger"
                disabled={busy || offlineNow}
                data-testid="tour-end"
                onClick={() => setConfirm('end')}
              >
                Tour beenden
              </button>
            )}
          </div>
          {offlineNow && <p className="muted">{TOUR_TEXTS.onlineOnly}</p>}
          {canManage && (
            <p>
              <Link href={`/touren/${tour.id}`} data-testid="active-tour-plan-link">
                Zur Tourplanung
              </Link>
            </p>
          )}
        </div>
      )}
      <p>
        <Link href="/touren">Alle Touren</Link>
      </p>

      {confirm === 'takeover' && tour !== null && (
        <ConfirmDialog
          testId="takeover-dialog"
          title="Tour übernehmen?"
          confirmLabel="Tour übernehmen"
          confirmTestId="takeover-confirm"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void takeover()}
        >
          <p>
            Alle offenen Stopps dieser Tour werden dir zugewiesen (bestehende Zuweisungsregeln
            gelten); bereits erledigte Stopps bleiben bei{' '}
            {tour.assignedName ?? 'der bisherigen Person'}.
          </p>
        </ConfirmDialog>
      )}

      {confirm === 'end' && (
        <ConfirmDialog
          testId="end-dialog"
          title="Tour beenden?"
          confirmLabel="Tour beenden"
          confirmTestId="end-confirm"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void end(false)}
        >
          <p>
            Die Tour wird beendet, wenn alle Stopps erledigt oder übersprungen sind. Der Standort
            wird gelöscht.
          </p>
        </ConfirmDialog>
      )}

      {forceReason !== null && (
        <ConfirmDialog
          testId="force-end-dialog"
          title="Trotzdem beenden"
          confirmLabel="Trotzdem beenden"
          confirmTestId="force-end-confirm"
          busy={busy}
          danger
          disabled={!forceValid}
          onCancel={() => setForceReason(null)}
          onConfirm={() => void end(true)}
        >
          <p>
            {TOUR_TEXTS.openStops} Offene Termine bleiben geplant und können später neu aufgenommen
            werden.
          </p>
          <label htmlFor="force-end-reason">Grund (Pflicht, 3–500 Zeichen)</label>
          <textarea
            id="force-end-reason"
            rows={3}
            maxLength={500}
            value={forceReason}
            data-testid="tour-end-reason"
            onChange={(event) => setForceReason(event.target.value)}
          />
        </ConfirmDialog>
      )}
    </main>
  );
}

export default function ActiveTourPage() {
  return (
    <AuthGuard>
      <Suspense fallback={<p className="muted">Wird geladen …</p>}>
        <ActiveTour />
      </Suspense>
    </AuthGuard>
  );
}
