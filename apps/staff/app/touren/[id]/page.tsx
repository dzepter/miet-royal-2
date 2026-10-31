'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import { AuthGuard, useMe } from '../../../components/auth-guard';
import { OfflineActionHint, useOfflineNow } from '../../../components/communication';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import {
  AddressStatusBadge,
  DelayBadge,
  PlanningStatusBadge,
  RouteAttribution,
  StopStateBadge,
  StopTime,
  stopTitle,
  TourStatusBadge,
} from '../../../components/tours';
import { hasPermission, type ApiResult } from '../../../lib/api';
import { formatBerlin } from '../../../lib/commerce';
import {
  berlinDateLabel,
  berlinTime,
  fromBerlinInput,
  KIND_LABELS,
  timeLabel,
} from '../../../lib/scheduling';
import {
  addStop,
  applyPlan,
  blockedReasonText,
  cancelTour,
  confirmGeocoding,
  endTour,
  evaluatePlan,
  formatKm,
  formatMinutes,
  getCandidates,
  getTour,
  isVersionConflict,
  markReady,
  patchStop,
  proposePlan,
  removeStop,
  reorderStops,
  startTour,
  TOUR_STOP_BUFFER_MINUTES_MAX,
  TOUR_STOP_BUFFER_MINUTES_MIN,
  TOUR_TEXTS,
  tourErrorText,
  warningText,
  type PlanBlockedReason,
  type TourCandidate,
  type TourPlanDto,
  type TourStopView,
  type TourView,
} from '../../../lib/tours';

/**
 * Tour planen (Phase 13, Design §13 / Order §18–§25, §65–§68): Stoppliste
 * (HTML5-Drag&Drop wie im Kalender + Pfeile), Pin, Puffer, Adress-Status mit
 * „Adresse für Route prüfen“, verfügbare Stopps mit bewusster Zuständigkeits-
 * bestätigung, Routenvorschlag (propose ⇒ Panel ⇒ apply/verwerfen), Zeiten
 * für die aktuelle Reihenfolge (evaluate), Metriken, Warnungen und die
 * Aktionen Bereit/Start/Beenden/Abbrechen. Routing ist Assistenz – jede
 * Antwort kann 409 TOUR_VERSION_CONFLICT (Tour neu laden), 503
 * ROUTING_UNAVAILABLE oder 409 ROUTING_DISABLED sein.
 */

const DRAG_TYPE = 'text/tour-stop';

interface ReviewDialog {
  label: string;
  cacheId: string;
  candidates: { ref: string; label: string }[];
}

interface ReassignDialog {
  candidate: TourCandidate;
  assignedName: string | null;
}

function TourPlanner() {
  const params = useParams<{ id: string }>();
  const tourId = params.id;
  const router = useRouter();
  const me = useMe();
  const canManage = hasPermission(me, 'calendar.manage');
  const offlineNow = useOfflineNow();

  const [tour, setTour] = useState<TourView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<TourCandidate[] | null>(null);
  const [proposal, setProposal] = useState<TourPlanDto | null>(null);
  const [blocked, setBlocked] = useState<PlanBlockedReason[] | null>(null);
  const [lastPlan, setLastPlan] = useState<TourPlanDto | null>(null);
  const [departure, setDeparture] = useState('');
  const [review, setReview] = useState<ReviewDialog | null>(null);
  const [reassign, setReassign] = useState<ReassignDialog | null>(null);
  const [confirm, setConfirm] = useState<'start' | 'end' | 'cancel' | null>(null);
  const [forceReason, setForceReason] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [bufferDrafts, setBufferDrafts] = useState<Record<string, string>>({});

  const editable = tour !== null && tour.canEdit && canManage && !offlineNow;
  const planningOpen = tour !== null && (tour.status === 'draft' || tour.status === 'ready');

  const load = useCallback(async () => {
    const result = await getTour(tourId);
    if (result.data !== null) {
      setTour(result.data.tour);
      setNotFound(false);
      return result.data.tour;
    }
    if (result.status === 404) setNotFound(true);
    else setError(tourErrorText(result, 'Die Tour konnte nicht geladen werden.'));
    return null;
  }, [tourId]);

  const loadCandidates = useCallback(async () => {
    if (!canManage) return;
    const result = await getCandidates(tourId);
    if (result.data !== null) setCandidates(result.data.appointments);
  }, [canManage, tourId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (planningOpen && canManage && !offlineNow) void loadCandidates();
  }, [planningOpen, canManage, offlineNow, loadCandidates]);

  /**
   * Gemeinsame Antwortbehandlung: Tour übernehmen; Versionskonflikt ⇒ Tour neu
   * laden + Hinweis; Routing-/Tourfehler ⇒ verständlicher Text. Liefert true bei Erfolg.
   */
  const handle = useCallback(
    async (result: ApiResult<{ tour: TourView }>, fallback: string): Promise<boolean> => {
      if (result.ok && result.data !== null) {
        setTour(result.data.tour);
        setError(null);
        return true;
      }
      if (isVersionConflict(result)) {
        await load();
        setProposal(null);
        setNotice(TOUR_TEXTS.versionConflict);
        return false;
      }
      setError(tourErrorText(result, fallback));
      return false;
    },
    [load],
  );

  async function run(action: () => Promise<boolean>) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  const departureIso = useMemo(() => fromBerlinInput(departure) ?? undefined, [departure]);

  // ── Stopps ────────────────────────────────────────────────────────────────

  const orderedStops = useMemo(
    () => (tour === null ? [] : [...tour.stops].sort((a, b) => a.sequence - b.sequence)),
    [tour],
  );

  function moveStop(stopId: string, targetId: string, placeAfter: boolean): string[] {
    const ids = orderedStops.map((stop) => stop.id).filter((id) => id !== stopId);
    const index = ids.indexOf(targetId);
    ids.splice(index + (placeAfter ? 1 : 0), 0, stopId);
    return ids;
  }

  async function submitOrder(order: string[]) {
    if (tour === null) return;
    const current = orderedStops.map((stop) => stop.id);
    if (order.join() === current.join()) return;
    await run(async () => {
      const ok = await handle(
        await reorderStops(tour.id, tour.version, order),
        'Die Reihenfolge konnte nicht gespeichert werden.',
      );
      if (ok) setProposal(null);
      return ok;
    });
  }

  function shift(stopId: string, delta: -1 | 1) {
    const ids = orderedStops.map((stop) => stop.id);
    const index = ids.indexOf(stopId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ids.length) return;
    const next = [...ids];
    next.splice(index, 1);
    next.splice(target, 0, stopId);
    void submitOrder(next);
  }

  function onDragStart(event: DragEvent<HTMLElement>, stopId: string) {
    event.dataTransfer.setData(DRAG_TYPE, stopId);
    event.dataTransfer.effectAllowed = 'move';
    setDragId(stopId);
  }

  function onDrop(event: DragEvent<HTMLElement>, targetId: string) {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData(DRAG_TYPE) || dragId;
    setDragId(null);
    setDropTarget(null);
    if (sourceId === null || sourceId === '' || sourceId === targetId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const placeAfter = event.clientY > rect.top + rect.height / 2;
    void submitOrder(moveStop(sourceId, targetId, placeAfter));
  }

  async function togglePin(stop: TourStopView) {
    if (tour === null) return;
    await run(async () =>
      handle(
        await patchStop(tour.id, stop.id, {
          expectedVersion: tour.version,
          isPinned: !stop.isPinned,
        }),
        'Die Fixierung konnte nicht gespeichert werden.',
      ),
    );
  }

  async function saveBuffer(stop: TourStopView) {
    if (tour === null) return;
    const raw = bufferDrafts[stop.id];
    if (raw === undefined) return;
    const value = Number(raw);
    if (
      !Number.isInteger(value) ||
      value < TOUR_STOP_BUFFER_MINUTES_MIN ||
      value > TOUR_STOP_BUFFER_MINUTES_MAX
    ) {
      setError(
        `Der Puffer muss zwischen ${TOUR_STOP_BUFFER_MINUTES_MIN} und ${TOUR_STOP_BUFFER_MINUTES_MAX} Minuten liegen.`,
      );
      return;
    }
    setBufferDrafts((drafts) => {
      const next = { ...drafts };
      delete next[stop.id];
      return next;
    });
    if (value === stop.bufferMinutes) return;
    await run(async () =>
      handle(
        await patchStop(tour.id, stop.id, { expectedVersion: tour.version, bufferMinutes: value }),
        'Der Puffer konnte nicht gespeichert werden.',
      ),
    );
  }

  async function remove(stop: TourStopView) {
    if (tour === null) return;
    await run(async () => {
      const ok = await handle(
        await removeStop(tour.id, stop.id, tour.version),
        'Der Stopp konnte nicht entfernt werden.',
      );
      if (ok) {
        setProposal(null);
        await loadCandidates();
      }
      return ok;
    });
  }

  async function add(candidate: TourCandidate, reassignConfirmed: boolean) {
    if (tour === null) return;
    if (candidate.assignment === 'other' && !reassignConfirmed) {
      setReassign({
        candidate,
        assignedName: candidate.effectiveAssigneeName ?? candidate.assignedName,
      });
      return;
    }
    await run(async () => {
      const result = await addStop(tour.id, {
        appointmentId: candidate.id,
        expectedVersion: tour.version,
        ...(reassignConfirmed ? { reassign: true } : {}),
      });
      if (!result.ok && result.errorCode === 'APPOINTMENT_ASSIGNED_ELSEWHERE') {
        const details = result.errorDetails as { assignedName?: string | null } | undefined;
        setReassign({ candidate, assignedName: details?.assignedName ?? candidate.assignedName });
        return false;
      }
      const ok = await handle(result, 'Der Stopp konnte nicht hinzugefügt werden.');
      if (ok) {
        setProposal(null);
        await loadCandidates();
      }
      return ok;
    });
  }

  // ── Adresse prüfen ────────────────────────────────────────────────────────

  function openReview(stop: TourStopView) {
    if (stop.address.cacheId === null) return;
    setReview({
      label: stop.address.label,
      cacheId: stop.address.cacheId,
      candidates: stop.address.candidates,
    });
  }

  function openReviewFromReason(reason: PlanBlockedReason) {
    if (reason.cacheId === null) return;
    setReview({
      label: reason.addressLabel,
      cacheId: reason.cacheId,
      candidates: reason.candidates,
    });
  }

  async function chooseCandidate(ref: string) {
    if (tour === null || review === null) return;
    await run(async () => {
      const ok = await handle(
        await confirmGeocoding(tour.id, { cacheId: review.cacheId, candidateRef: ref }),
        'Die Adresse konnte nicht bestätigt werden.',
      );
      if (ok) {
        setReview(null);
        setBlocked(null);
      }
      return ok;
    });
  }

  // ── Planung ───────────────────────────────────────────────────────────────

  async function propose() {
    if (tour === null) return;
    await run(async () => {
      const result = await proposePlan(tour.id, departureIso);
      if (result.data === null) {
        setError(tourErrorText(result, 'Der Routenvorschlag konnte nicht berechnet werden.'));
        return false;
      }
      setError(null);
      if (result.data.status === 'blocked') {
        setBlocked(result.data.reasons);
        setProposal(null);
        return false;
      }
      setBlocked(null);
      setProposal(result.data.plan);
      if (result.data.version !== tour.version) await load();
      return true;
    });
  }

  async function apply() {
    if (tour === null || proposal === null) return;
    await run(async () => {
      const result = await applyPlan(tour.id, {
        expectedVersion: tour.version,
        order: proposal.order,
        ...(departureIso === undefined ? {} : { departureAt: departureIso }),
      });
      const ok = await handle(result, 'Der Vorschlag konnte nicht übernommen werden.');
      if (ok && result.data !== null) {
        setLastPlan(result.data.plan);
        setProposal(null);
        setBlocked(null);
      }
      return ok;
    });
  }

  async function evaluate() {
    if (tour === null) return;
    await run(async () => {
      const result = await evaluatePlan(tour.id, {
        expectedVersion: tour.version,
        ...(departureIso === undefined ? {} : { departureAt: departureIso }),
      });
      if (!result.ok && result.errorCode === 'TOUR_PLAN_BLOCKED') {
        const details = result.errorDetails as { reasons?: PlanBlockedReason[] } | undefined;
        if (details?.reasons !== undefined) setBlocked(details.reasons);
      }
      const ok = await handle(result, 'Die Zeiten konnten nicht berechnet werden.');
      if (ok && result.data !== null) {
        setLastPlan(result.data.plan);
        setBlocked(null);
      }
      return ok;
    });
  }

  // ── Lebenszyklus ──────────────────────────────────────────────────────────

  async function ready() {
    if (tour === null) return;
    await run(async () =>
      handle(
        await markReady(tour.id, tour.version),
        'Die Tour konnte nicht als bereit markiert werden.',
      ),
    );
  }

  async function start() {
    if (tour === null) return;
    setConfirm(null);
    await run(async () => {
      const ok = await handle(
        await startTour(tour.id, tour.version),
        'Die Tour konnte nicht gestartet werden.',
      );
      if (ok) router.push(`/touren/aktiv?id=${tour.id}`);
      return ok;
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
        return false;
      }
      const ok = await handle(result, 'Die Tour konnte nicht beendet werden.');
      if (ok) setForceReason(null);
      return ok;
    });
  }

  async function cancel() {
    if (tour === null) return;
    setConfirm(null);
    await run(async () =>
      handle(await cancelTour(tour.id), 'Die Tour konnte nicht abgebrochen werden.'),
    );
  }

  // ── Darstellung ───────────────────────────────────────────────────────────

  if (notFound) {
    return (
      <main className="page">
        <h1>Tour</h1>
        <p className="error">Tour nicht gefunden.</p>
        <p>
          <Link href="/touren">Zurück zu den Touren</Link>
        </p>
      </main>
    );
  }
  if (tour === null) {
    return (
      <main className="page">
        <h1>Tour</h1>
        {error !== null ? (
          <p className="error">{error}</p>
        ) : (
          <p className="muted">Wird geladen …</p>
        )}
      </main>
    );
  }

  const stopById = new Map(tour.stops.map((stop) => [stop.id, stop]));
  const activeStopCount = tour.stops.filter((stop) => stop.state !== 'skipped').length;
  const forceValid =
    (forceReason ?? '').trim().length >= 3 && (forceReason ?? '').trim().length <= 500;

  return (
    <main className="page">
      <p>
        <Link href="/touren">← Touren</Link>
      </p>
      <h1>
        Tour {berlinDateLabel(tour.tourDate)} · {tour.assignedName ?? '–'}
      </h1>
      <p data-testid="tour-header">
        <TourStatusBadge status={tour.status} />{' '}
        <PlanningStatusBadge status={tour.planningStatus} />{' '}
        {tour.substituted && tour.effectiveDriverName !== null && (
          <span className="badge" data-testid="tour-substitute">
            Vertretung: {tour.effectiveDriverName}
          </span>
        )}
      </p>
      <OfflineActionHint testId="tour-offline-hint" />
      {notice !== null && (
        <p className="conflict-box" role="status" data-testid="tour-notice">
          {notice}
        </p>
      )}
      {error !== null && (
        <p className="error" role="alert" data-testid="tour-error">
          {error}
        </p>
      )}

      {tour.status === 'active' && (
        <div className="card next-stop-card">
          <p>
            Diese Tour ist aktiv.{' '}
            <Link href={`/touren/aktiv?id=${tour.id}`} data-testid="tour-open-active">
              Aktive Tour öffnen
            </Link>
          </p>
        </div>
      )}

      {tour.warnings.length > 0 && (
        <div className="conflict-box" data-testid="tour-warnings">
          {tour.warnings.map((warning, index) => (
            <div key={`${warning.code}-${warning.stopId ?? index}`} data-warning={warning.code}>
              ⚠︎ {warningText(warning)}
              {warning.stopId !== undefined && stopById.has(warning.stopId) && (
                <span className="muted">
                  {' '}
                  · {stopById.get(warning.stopId)!.appointment.processNumber}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Metriken (Order §24: keine Preise, keine „garantierte Ankunft“) ── */}
      <div className="card" data-testid="tour-metrics">
        <h2>Route</h2>
        <div className="list-row">
          <span>Stopps</span>
          <strong data-testid="metric-stops">{activeStopCount}</strong>
        </div>
        <div className="list-row">
          <span>Gesamtdistanz</span>
          <strong data-testid="metric-distance">{formatKm(tour.plannedDistanceMeters)}</strong>
        </div>
        <div className="list-row">
          <span>Fahrzeit</span>
          <strong data-testid="metric-duration">
            {formatMinutes(tour.plannedDurationSeconds)}
          </strong>
        </div>
        <div className="list-row">
          <span>Geplanter Start / Ende</span>
          <strong>
            {tour.plannedStartAt === null ? '–' : `${berlinTime(tour.plannedStartAt)} Uhr`} –{' '}
            {tour.plannedEndAt === null ? '–' : `${berlinTime(tour.plannedEndAt)} Uhr`}
          </strong>
        </div>
        <div className="list-row">
          <span>Depot</span>
          <span>{tour.depot.status === 'ok' ? tour.depot.label : TOUR_TEXTS.depotMissing}</span>
        </div>
        {tour.routeCalculatedAt !== null && (
          <p className="muted">
            Zuletzt berechnet: {formatBerlin(tour.routeCalculatedAt)}
            {tour.planningStatus === 'stale' && <> · {TOUR_TEXTS.stale}</>}
          </p>
        )}
        {tour.routeCalculatedAt !== null && <RouteAttribution provider={tour.routeProvider} />}
      </div>

      {/* ── Stoppliste ────────────────────────────────────────────────────── */}
      <div className="card" data-testid="tour-stops">
        <h2>Stopps</h2>
        {orderedStops.length === 0 && (
          <p className="muted">Noch keine Stopps – unten verfügbare Termine hinzufügen.</p>
        )}
        {orderedStops.map((stop, index) => {
          const draggable = editable && planningOpen && stop.state !== 'done';
          const bufferValue = bufferDrafts[stop.id] ?? String(stop.bufferMinutes);
          return (
            <div
              key={stop.id}
              className={`tour-stop ${dragId === stop.id ? 'dragging' : ''} ${dropTarget === stop.id ? 'drop-target' : ''}`}
              draggable={draggable}
              data-testid={`tour-stop-${stop.id}`}
              data-sequence={stop.sequence}
              data-appointment-id={stop.appointmentId}
              onDragStart={(event) => onDragStart(event, stop.id)}
              onDragEnd={() => {
                setDragId(null);
                setDropTarget(null);
              }}
              onDragOver={(event) => {
                if (!draggable) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                if (dropTarget !== stop.id) setDropTarget(stop.id);
              }}
              onDragLeave={() => {
                if (dropTarget === stop.id) setDropTarget(null);
              }}
              onDrop={(event) => onDrop(event, stop.id)}
            >
              <span className="seq" aria-hidden="true" data-testid={`stop-handle-${stop.id}`}>
                {draggable ? '⋮⋮ ' : ''}
                {index + 1}.
              </span>
              <div className="stop-main">
                <div>
                  <strong>{stopTitle(stop)}</strong>{' '}
                  {tour.canOpenProcess && (
                    <Link href={`/vorgaenge/${stop.appointment.processId}`} className="muted">
                      Zum Vorgang
                    </Link>
                  )}
                </div>
                <div>
                  <StopTime stop={stop} />
                  {stop.appointment.machineName !== null && (
                    <span className="muted"> · {stop.appointment.machineName}</span>
                  )}
                </div>
                <div className="muted" data-testid={`stop-address-${stop.id}`}>
                  {stop.address.lines.length > 0
                    ? stop.address.lines.join(', ')
                    : stop.address.label}
                </div>
                <div>
                  <StopStateBadge state={stop.state} />{' '}
                  <AddressStatusBadge status={stop.address.status} />{' '}
                  {stop.isPinned && (
                    <span className="badge" data-testid={`stop-pinned-${stop.id}`}>
                      Fixiert
                    </span>
                  )}{' '}
                  <DelayBadge stop={stop} />
                </div>
                {(stop.plannedArrivalAt !== null || stop.legDistanceMeters !== null) && (
                  <div className="muted" data-testid={`stop-plan-${stop.id}`}>
                    {stop.plannedArrivalAt !== null && (
                      <>Geplante Ankunft {berlinTime(stop.plannedArrivalAt)} Uhr</>
                    )}
                    {stop.legDistanceMeters !== null && (
                      <>
                        {' '}
                        · Abschnitt {formatKm(stop.legDistanceMeters)} /{' '}
                        {formatMinutes(stop.legDurationSeconds)}
                      </>
                    )}
                  </div>
                )}
                {stop.address.status === 'missing' && (
                  <div className="warning-red">{TOUR_TEXTS.addressMissing}</div>
                )}
              </div>
              {editable && planningOpen && (
                <div className="stop-actions">
                  <button
                    type="button"
                    aria-label="Nach oben"
                    disabled={busy || index === 0}
                    data-testid={`stop-up-${stop.id}`}
                    onClick={() => shift(stop.id, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label="Nach unten"
                    disabled={busy || index === orderedStops.length - 1}
                    data-testid={`stop-down-${stop.id}`}
                    onClick={() => shift(stop.id, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className={stop.isPinned ? 'primary' : ''}
                    disabled={busy}
                    aria-pressed={stop.isPinned}
                    data-testid={`stop-pin-${stop.id}`}
                    onClick={() => void togglePin(stop)}
                  >
                    {stop.isPinned ? 'Fixiert' : 'Fixieren'}
                  </button>
                  <label className="muted" style={{ margin: 0 }}>
                    Puffer (min){' '}
                    <input
                      type="number"
                      min={TOUR_STOP_BUFFER_MINUTES_MIN}
                      max={TOUR_STOP_BUFFER_MINUTES_MAX}
                      step={1}
                      value={bufferValue}
                      disabled={busy}
                      aria-label="Puffer in Minuten"
                      data-testid={`stop-buffer-${stop.id}`}
                      onChange={(event) =>
                        setBufferDrafts((drafts) => ({ ...drafts, [stop.id]: event.target.value }))
                      }
                      onBlur={() => void saveBuffer(stop)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          (event.target as HTMLInputElement).blur();
                        }
                      }}
                    />
                  </label>
                  {(stop.address.status === 'review_required' ||
                    stop.address.candidates.length > 0) &&
                    stop.address.cacheId !== null && (
                      <button
                        type="button"
                        disabled={busy}
                        data-testid={`stop-review-${stop.id}`}
                        onClick={() => openReview(stop)}
                      >
                        Adresse für Route prüfen
                      </button>
                    )}
                  <button
                    type="button"
                    className="danger"
                    disabled={busy || stop.state === 'done'}
                    data-testid={`stop-remove-${stop.id}`}
                    onClick={() => void remove(stop)}
                  >
                    Entfernen
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Planung ───────────────────────────────────────────────────────── */}
      {editable && planningOpen && (
        <div className="card" data-testid="tour-planning">
          <h2>Route berechnen</h2>
          <label htmlFor="tour-departure">Abfahrt vom Depot (optional, Europe/Berlin)</label>
          <input
            id="tour-departure"
            type="datetime-local"
            value={departure}
            data-testid="tour-departure"
            onChange={(event) => setDeparture(event.target.value)}
          />
          <div className="tour-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || orderedStops.length === 0}
              data-testid="tour-propose"
              onClick={() => void propose()}
            >
              Route berechnen
            </button>
            <button
              type="button"
              disabled={busy || orderedStops.length === 0}
              data-testid="tour-evaluate"
              onClick={() => void evaluate()}
            >
              Zeiten für aktuelle Reihenfolge
            </button>
          </div>

          {blocked !== null && (
            <div className="conflict-box" data-testid="tour-plan-blocked">
              <strong>Route kann noch nicht berechnet werden:</strong>
              {blocked.map((reason, index) => (
                <div
                  key={`${reason.code}-${reason.stopId ?? 'depot'}-${index}`}
                  data-reason={reason.code}
                >
                  {reason.stopId === null
                    ? 'Depot'
                    : (stopById.get(reason.stopId)?.appointment.processNumber ?? 'Stopp')}
                  : {blockedReasonText(reason)}
                  {reason.code === 'GEOCODING_REVIEW_REQUIRED' && reason.cacheId !== null && (
                    <>
                      {' '}
                      <button
                        type="button"
                        className="link-like"
                        disabled={busy}
                        data-testid={`blocked-review-${reason.stopId ?? 'depot'}`}
                        onClick={() => openReviewFromReason(reason)}
                      >
                        Adresse für Route prüfen
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {proposal !== null && (
            <div className="card" style={{ marginTop: '1rem' }} data-testid="tour-proposal">
              <h2>Routenvorschlag</h2>
              {!proposal.feasible && (
                <p className="warning-red" data-testid="proposal-infeasible">
                  Keine machbare Route – Konflikte:
                </p>
              )}
              {proposal.conflicts.map((conflict) => (
                <p
                  className="conflict-box"
                  key={`${conflict.stopId}-${conflict.code}`}
                  data-testid="proposal-conflict"
                >
                  ⚠︎ {conflict.message}
                </p>
              ))}
              <ol data-testid="proposal-order">
                {proposal.visits.map((visit) => {
                  const stop = stopById.get(visit.stopId);
                  return (
                    <li key={visit.stopId} data-testid={`proposal-stop-${visit.stopId}`}>
                      {stop === undefined ? visit.stopId : stopTitle(stop)} – Ankunft{' '}
                      {berlinTime(visit.arrivalAt)} Uhr
                      {visit.waitingSeconds > 0 && (
                        <> (Wartezeit {formatMinutes(visit.waitingSeconds)})</>
                      )}
                      <span className="muted">
                        {' '}
                        · {formatKm(visit.legDistanceMeters)} /{' '}
                        {formatMinutes(visit.legDurationSeconds)}
                      </span>
                    </li>
                  );
                })}
              </ol>
              <p>
                Gesamt:{' '}
                <strong data-testid="proposal-distance">
                  {formatKm(proposal.totalDistanceMeters)}
                </strong>{' '}
                ·{' '}
                <strong data-testid="proposal-duration">
                  {formatMinutes(proposal.totalDurationSeconds)}
                </strong>{' '}
                · {berlinTime(proposal.plannedStartAt)}–{berlinTime(proposal.plannedEndAt)} Uhr
                {proposal.returnLeg !== null && (
                  <span className="muted">
                    {' '}
                    (Rückfahrt {formatKm(proposal.returnLeg.distanceMeters)} /{' '}
                    {formatMinutes(proposal.returnLeg.durationSeconds)})
                  </span>
                )}
              </p>
              <RouteAttribution provider={proposal.provider} />
              <div className="tour-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  data-testid="tour-apply"
                  onClick={() => void apply()}
                >
                  Vorschlag übernehmen
                </button>
                <button
                  type="button"
                  disabled={busy}
                  data-testid="tour-discard"
                  onClick={() => setProposal(null)}
                >
                  Verwerfen
                </button>
              </div>
            </div>
          )}

          {lastPlan !== null && proposal === null && (
            <div data-testid="tour-last-plan">
              {!lastPlan.feasible && (
                <p className="warning-red" data-testid="plan-infeasible">
                  Keine machbare Route – Konflikte:
                </p>
              )}
              {lastPlan.conflicts.map((conflict) => (
                <p
                  className="conflict-box"
                  key={`${conflict.stopId}-${conflict.code}`}
                  data-testid="plan-conflict"
                >
                  ⚠︎ {conflict.message}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Verfügbare Stopps ─────────────────────────────────────────────── */}
      {editable && planningOpen && candidates !== null && (
        <div className="card" data-testid="tour-candidates">
          <h2>Verfügbare Stopps</h2>
          {candidates.length === 0 ? (
            <p className="muted">Keine weiteren Termine für diesen Tag verfügbar.</p>
          ) : (
            candidates.map((candidate) => (
              <div
                className="list-row"
                key={candidate.id}
                data-testid={`candidate-${candidate.id}`}
              >
                <div>
                  <strong>
                    {timeLabel(candidate)} · {KIND_LABELS[candidate.kind]}
                  </strong>{' '}
                  · {candidate.customerName}
                  <span className="muted"> · {candidate.processNumber}</span>
                  <div className="muted" data-testid={`candidate-assignment-${candidate.id}`}>
                    {candidate.assignment === 'unassigned' &&
                      'Noch nicht zugewiesen – wird dem Tourfahrer zugewiesen'}
                    {candidate.assignment === 'tour_driver' && 'Zuständig: Tourfahrer'}
                    {candidate.assignment === 'other' &&
                      `Zuständig: ${candidate.effectiveAssigneeName ?? candidate.assignedName ?? 'andere Person'}`}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  data-testid={`candidate-add-${candidate.id}`}
                  onClick={() => void add(candidate, false)}
                >
                  Stopp hinzufügen
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── Aktionen ──────────────────────────────────────────────────────── */}
      {(tour.status === 'draft' || tour.status === 'ready' || tour.status === 'active') && (
        <div className="card" data-testid="tour-lifecycle">
          <h2>Aktionen</h2>
          <div className="tour-actions">
            {tour.status === 'draft' && editable && (
              <button
                type="button"
                disabled={busy || orderedStops.length === 0}
                data-testid="tour-ready"
                onClick={() => void ready()}
              >
                Bereit
              </button>
            )}
            {tour.canStart && (
              <button
                type="button"
                className="primary"
                disabled={busy || offlineNow}
                data-testid="tour-start"
                onClick={() => setConfirm('start')}
              >
                Tour starten
              </button>
            )}
            {tour.canEnd && (
              <button
                type="button"
                disabled={busy || offlineNow}
                data-testid="tour-end"
                onClick={() => setConfirm('end')}
              >
                Tour beenden
              </button>
            )}
            {canManage && (tour.status === 'draft' || tour.status === 'ready') && (
              <button
                type="button"
                className="danger"
                disabled={busy || offlineNow}
                data-testid="tour-cancel"
                onClick={() => setConfirm('cancel')}
              >
                Tour abbrechen
              </button>
            )}
          </div>
          {offlineNow && <p className="muted">{TOUR_TEXTS.onlineOnly}</p>}
        </div>
      )}
      {tour.status === 'completed' && (
        <p className="muted" data-testid="tour-completed">
          Tour beendet am {formatBerlin(tour.endedAt)}
          {tour.endReason !== null && <> · Grund: {tour.endReason}</>}
        </p>
      )}

      {/* ── Dialoge ───────────────────────────────────────────────────────── */}
      {review !== null && (
        <div
          className="lock-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Adresse für Route prüfen"
          data-testid="address-review-dialog"
        >
          <div className="card" style={{ maxWidth: '28rem' }}>
            <h2 style={{ marginTop: 0 }}>Adresse für Route prüfen</h2>
            <p>
              Eingegebene Adresse: <strong>{review.label}</strong>
            </p>
            {review.candidates.length === 0 ? (
              <p className="muted">
                Keine Kandidaten verfügbar – bitte die Adresse im Vorgang prüfen.
              </p>
            ) : (
              <p className="muted">Bitte den passenden Treffer auswählen:</p>
            )}
            {review.candidates.map((candidate) => (
              <p key={candidate.ref}>
                <button
                  type="button"
                  disabled={busy}
                  data-testid={`address-candidate-${candidate.ref}`}
                  onClick={() => void chooseCandidate(candidate.ref)}
                >
                  {candidate.label}
                </button>
              </p>
            ))}
            <p>
              <button
                type="button"
                disabled={busy}
                data-testid="address-review-cancel"
                onClick={() => setReview(null)}
              >
                Abbrechen
              </button>
            </p>
          </div>
        </div>
      )}

      {reassign !== null && (
        <ConfirmDialog
          testId="reassign-dialog"
          title="Zuständigkeit ändern?"
          confirmLabel="Zuständigkeit ändern und hinzufügen"
          confirmTestId="reassign-confirm"
          busy={busy}
          onCancel={() => setReassign(null)}
          onConfirm={() => {
            const candidate = reassign.candidate;
            setReassign(null);
            void add(candidate, true);
          }}
        >
          <p>
            Der Termin {reassign.candidate.processNumber} ist derzeit{' '}
            <strong>{reassign.assignedName ?? 'einer anderen Person'}</strong> zugewiesen. Beim
            Hinzufügen wird er dem Tourfahrer <strong>{tour.assignedName ?? ''}</strong> zugewiesen
            (bestehende Zuweisungsregeln gelten).
          </p>
        </ConfirmDialog>
      )}

      {confirm === 'start' && (
        <ConfirmDialog
          testId="start-dialog"
          title="Tour starten?"
          confirmLabel="Tour starten"
          confirmTestId="start-confirm"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void start()}
        >
          <p>
            Die Tour wird für {tour.effectiveDriverName ?? tour.assignedName ?? 'den Fahrer'} aktiv.
          </p>
          {tour.warnings.length > 0 && (
            <p className="warning-red">
              Es liegen Warnungen vor – die Tour kann trotzdem gestartet werden.
            </p>
          )}
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
          <p>Die Tour wird beendet, wenn alle Stopps erledigt oder übersprungen sind.</p>
        </ConfirmDialog>
      )}

      {confirm === 'cancel' && (
        <ConfirmDialog
          testId="cancel-dialog"
          title="Tour abbrechen?"
          confirmLabel="Tour abbrechen"
          confirmTestId="cancel-confirm"
          busy={busy}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => void cancel()}
        >
          <p>Die Tour wird abgebrochen; die Termine bleiben unverändert bestehen.</p>
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

export default function TourPage() {
  return (
    <AuthGuard>
      <TourPlanner />
    </AuthGuard>
  );
}
