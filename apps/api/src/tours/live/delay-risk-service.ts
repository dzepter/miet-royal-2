import {
  processes,
  tourDelayIncidents,
  tourLiveLocations,
  tours,
  type Database,
  type DatabaseTransaction,
  type Tour,
  type TourDelayIncident,
} from '@mietroyal/database';
import {
  DELAY_LOCATION_MAX_ACCURACY_METERS,
  evaluateOrder,
  stopDeadline,
  type PlanStop,
} from '@mietroyal/domain';
import type { JobRunnerLogger } from '@mietroyal/integrations';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { AuthError } from '../../auth/service.ts';
import { buildPushPayload, type PushAppointmentKind } from '../../communication/push/payload.ts';
import { pushKeys } from '../../communication/push/keys.ts';
import type { PushService } from '../../communication/push/push-service.ts';
import {
  listActiveUsersWithAnyPermission,
  PLANNING_PUSH_PERMISSIONS,
  type PermissionResolver,
} from '../../communication/push/recipients.ts';
import { RoutingError, type GeoPoint, type RoutingGateway } from '../../routing/types.ts';
import { loadSubstitutions } from '../../scheduling/assignee.ts';
import type { LoadedStop, LoadedTour, TourService } from '../tour-service.ts';
import type { OperativeAddressResolver, TourGeocodingResolver } from '../types.ts';
import { LIVE_LOCATION_STALE_MS } from '../views.ts';
import {
  DelayEvaluationState,
  type DelayEvaluationRecord,
  type DelayEvaluationStatus,
  type DelayStopResult,
} from './delay-state.ts';

/**
 * Phase 13 (Order §§49–55, Design §9): aktive ETA und Verspätungsrisiko
 * (`tour.delay_risk`).
 *
 * - Startpunkt ist AUSSCHLIESSLICH ein frischer Live-Standort (≤ 10 min);
 *   ohne ihn gibt es keine Live-Prognose (`unavailable`) – nie ein Risk
 *   ohne Daten und nie eine falsche Entwarnung (Order §51).
 * - Restroute = `gateway.matrix(Position + verbleibende offene Stopps)` in
 *   Tour-Reihenfolge; ETA je Stopp über `evaluateOrder` (Fahrzeit, Warten
 *   bis Frühestbeginn, Servicepuffer der vorherigen Stopps, Order §50).
 *   Deadline exakt ⇒ Termin, Fenster ⇒ Fensterende, ohne Zeit ⇒ kein Risk.
 * - late ⇒ Incident öffnen (genau ein offener je Stopp, Partial-Unique) und
 *   GENAU EINEN Push je Incident an effektiven Fahrer + Planung (Order §53/
 *   §54); weiter late ⇒ nur `last_evaluated_at`/Prognose aktualisieren;
 *   wieder pünktlich ⇒ `resolved_at`, kein Push; erneut late nach Auflösung
 *   ⇒ neuer Incident ⇒ neuer Push.
 * - Provider-Fehler/disabled ⇒ `unavailable`, Incidents unverändert.
 * - Drossel (Order §49): Location-/Scanner-Trigger bewerten nur, wenn ≥ 3 min
 *   seit der letzten Bewertung ODER ≥ 500 m Bewegung seit der Bewertungs-
 *   position (In-Process-Gedächtnis, keine Positionsspur); Trigger „Stopp
 *   erledigt/übersprungen“, „Plan geändert“, „Neu berechnen“ immer.
 * - Keine DB-Transaktion während des Provider-Aufrufs; Pushs laufen über die
 *   Phase-12-Outbox (PushService). KEINE Kundennachricht.
 * - Phase 13 Final (§2): Die Push-Outbox wird ATOMAR mit dem Incident
 *   geschrieben (eine kurze Transaktion: Tour FOR SHARE, Incident FOR UPDATE,
 *   Empfänger, `createDelivery(…, tx)`, `notification_enqueued_at`); der Job
 *   `push.send` wird erst NACH dem Commit eingereiht – fehlt er (Absturz,
 *   Queue-Fehler), holt ihn der Push-Outbox-Backstop nach. Nie ein zweiter
 *   Pool-Acquire in der gehaltenen Transaktion (Pool max=1 sicher).
 * - Phase 13 Final (§3): Bewertung NUR bei Standortgenauigkeit ≤
 *   `DELAY_LOCATION_MAX_ACCURACY_METERS` (250 m, domain); sonst `unavailable`
 *   mit Grund LOCATION_INACCURATE – Incidents bleiben unverändert.
 * - Phase 13 (Fix F2): Incidents/Pushs nur, wenn die Tour beim Schreiben noch
 *   aktiv und ihre Version seit dem Laden unverändert ist (Tour FOR SHARE in
 *   derselben Transaktion) – ein Ende/eine Übernahme/Planänderung während des
 *   Provider-Aufrufs verwirft die Bewertung (nichts geschrieben, kein Push).
 * - Phase 13 Final (Review F1/F2): Verspätung gibt es NUR für Stopps, die in
 *   der Schreibtransaktion FRISCH geladen noch `open` sind. `arrived`-Stopps
 *   bleiben Zwischenpunkte der Restroute (Fahrzeiten), öffnen aber keinen
 *   Incident (Ankunft ist erfolgt – „Angekommen“ nach der Deadline ist kein
 *   Risiko). Wird ein Stopp während des Provider-Aufrufs erreicht/erledigt/
 *   übersprungen (die Tourversion ändert sich dabei nicht), entsteht weder
 *   Incident noch Push; ein offener Incident zu einem solchen Stopp wird wie
 *   „nicht mehr verbleibend“ gelöst.
 * - An den Provider gehen nur Koordinaten; Logs enthalten nur IDs/Status.
 */

export const DELAY_EVALUATION_MIN_INTERVAL_MS = 3 * 60_000;
export const DELAY_EVALUATION_MIN_MOVE_METERS = 500;
/** Phase 13 Final (§3): zentrale Genauigkeitsgrenze (packages/domain) – hier nur weitergereicht. */
export { DELAY_LOCATION_MAX_ACCURACY_METERS };

/** Push-Zielgruppe eines Verspätungs-Pushs (Payload-Variante, Ziel-URL). */
type DelayPushAudience = 'driver' | 'planning';

/** Offene Incidents einer Tour, deren Push-Outbox noch nicht geschrieben wurde. */
function pendingIncidentsWhere(tourId: string) {
  return and(
    eq(tourDelayIncidents.tourId, tourId),
    isNull(tourDelayIncidents.resolvedAt),
    isNull(tourDelayIncidents.notificationEnqueuedAt),
  );
}

export type DelayTrigger =
  'location' | 'scanner' | 'stop_changed' | 'plan_changed' | 'recalculate' | 'manual';

/** Trigger, die der Drossel unterliegen (Design §9). */
const THROTTLED_TRIGGERS: ReadonlySet<DelayTrigger> = new Set(['location', 'scanner']);

export type DelayEvaluation =
  | { status: 'skipped'; evaluatedAt: Date | null; reason: 'THROTTLED' }
  | {
      status: DelayEvaluationStatus;
      evaluatedAt: Date;
      reason: string | null;
      stops: DelayStopResult[];
    };

const KIND_LABELS: Record<PushAppointmentKind, string> = {
  delivery: 'Liefertermin',
  pickup: 'Abholtermin',
  return: 'Rückgabetermin',
};

export interface DelayRiskServiceDeps {
  db: Database;
  tours: TourService;
  gateway: RoutingGateway;
  geocoding: TourGeocodingResolver;
  addresses: OperativeAddressResolver;
  push: PushService;
  auth: PermissionResolver;
  state?: DelayEvaluationState | undefined;
  logger?: JobRunnerLogger | undefined;
}

/** Verbleibende Stopps der Restroute (Fahrzeiten): offen ODER erreicht (noch nicht erledigt). */
function isRemaining(entry: LoadedStop): boolean {
  return entry.state === 'open' || entry.state === 'arrived';
}

/** Nur ein noch OFFENER Stopp kann verspätet sein (Review F1/F2). */
function isOpen(entry: LoadedStop): boolean {
  return entry.state === 'open';
}

/** Luftlinie in Metern (nur für die Bewegungs-Drossel – kein Routing). */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export class DelayRiskService {
  readonly state: DelayEvaluationState;

  constructor(private readonly deps: DelayRiskServiceDeps) {
    this.state = deps.state ?? new DelayEvaluationState();
  }

  /** Letzte In-Process-Bewertung (Route GET …/delay, Tour-View). */
  lastEvaluation(tourId: string): DelayEvaluationRecord | undefined {
    return this.state.get(tourId);
  }

  async evaluate(
    tourId: string,
    trigger: DelayTrigger,
    now = new Date(),
  ): Promise<DelayEvaluation> {
    // Billige Vorprüfungen OHNE Zeilensperre: Tourstatus und frischer Live-Standort.
    // Erst danach wird die Tour (mit Heilung, kurze Sperre) vollständig geladen.
    const statusRows = await this.deps.db
      .select({ status: tours.status })
      .from(tours)
      .where(eq(tours.id, tourId));
    if (statusRows[0] === undefined) throw new AuthError('NOT_FOUND', 'Tour nicht gefunden.');
    if (statusRows[0].status !== 'active') {
      // Kein Gedächtnis-Eintrag (die View prüft den Tourstatus selbst) – ein
      // verspäteter Trigger aus der Planungsphase überschreibt nie eine Live-Bewertung.
      return { status: 'unavailable', evaluatedAt: now, reason: 'TOUR_NOT_ACTIVE', stops: [] };
    }
    const liveRows = await this.deps.db
      .select()
      .from(tourLiveLocations)
      .where(eq(tourLiveLocations.tourId, tourId));
    const live = liveRows[0];
    if (live === undefined || now.getTime() - live.observedAt.getTime() > LIVE_LOCATION_STALE_MS) {
      return this.record(tourId, now, 'unavailable', 'NO_LIVE_LOCATION', null, [], trigger);
    }
    // Phase 13 Final (§3): nur ein hinreichend genauer Standort trägt eine Prognose.
    // Sonst `unavailable`/LOCATION_INACCURATE: kein Incident, keine Entwarnung, kein
    // Push; Gedächtnis OHNE Position, damit der nächste genaue Standort sofort
    // (ohne Drossel) bewertet wird. Der Genauigkeitswert wird nie geloggt.
    if (live.accuracyMeters === null || live.accuracyMeters > DELAY_LOCATION_MAX_ACCURACY_METERS) {
      return this.record(tourId, now, 'unavailable', 'LOCATION_INACCURATE', null, [], trigger);
    }
    const loaded = await this.deps.tours.load(tourId, now);
    if (loaded.tour.status !== 'active') {
      return { status: 'unavailable', evaluatedAt: now, reason: 'TOUR_NOT_ACTIVE', stops: [] };
    }
    const position: GeoPoint = { latitude: live.latitude, longitude: live.longitude };
    if (THROTTLED_TRIGGERS.has(trigger)) {
      const last = this.state.get(tourId);
      if (
        last !== undefined &&
        last.position !== null &&
        now.getTime() - last.evaluatedAt.getTime() < DELAY_EVALUATION_MIN_INTERVAL_MS &&
        distanceMeters(last.position, position) < DELAY_EVALUATION_MIN_MOVE_METERS
      ) {
        return { status: 'skipped', evaluatedAt: last.evaluatedAt, reason: 'THROTTLED' };
      }
    }

    const remaining = loaded.stops.filter(isRemaining);
    // Ohne offenen Stopp gibt es nichts zu prognostizieren (erreichte Stopps sind
    // keine Verspätung mehr): Incidents lösen, kein Provider-Aufruf (Review F1).
    if (!remaining.some(isOpen)) {
      await this.resolveAll(tourId, now);
      return this.record(tourId, now, 'ok', null, position, [], trigger);
    }

    const processNumbers = await this.processNumbers(remaining);
    const points: GeoPoint[] = [];
    const planStops: PlanStop[] = [];
    for (const entry of remaining) {
      const address = await this.deps.addresses.resolveOperativeAddress(
        this.deps.db,
        entry.appointment,
      );
      if (address.status === 'missing' || address.text === null) {
        return this.record(tourId, now, 'unavailable', 'ADDRESS_MISSING', position, [], trigger);
      }
      const resolution = await this.deps.geocoding.resolve(address.text, { now });
      if (resolution.status !== 'resolved' || resolution.point === null) {
        return this.record(
          tourId,
          now,
          'unavailable',
          `GEOCODING_${resolution.status.toUpperCase()}`,
          position,
          [],
          trigger,
        );
      }
      points.push(resolution.point);
      planStops.push({
        id: entry.stop.id,
        matrixIndex: points.length,
        isPinned: entry.stop.isPinned,
        bufferMinutes: entry.stop.bufferMinutes,
        startAt: entry.appointment.startAt,
        endAt: entry.appointment.endAt,
        label:
          `${KIND_LABELS[entry.appointment.kind]} ${processNumbers.get(entry.appointment.processId) ?? ''}`.trim(),
      });
    }

    // Provider-Aufruf OHNE DB-Transaktion (Order §63); nur Koordinaten.
    let matrix;
    try {
      matrix = await this.deps.gateway.matrix({ points: [position, ...points] });
    } catch (error) {
      if (!(error instanceof RoutingError)) throw error;
      this.deps.logger?.warn(
        { tourId, trigger, routing: { code: error.code, transient: error.transient } },
        'Verspätungsprognose nicht verfügbar (Routing)',
      );
      return this.record(tourId, now, 'unavailable', error.code, position, [], trigger);
    }
    const plan = evaluateOrder({
      matrix: {
        durationsSeconds: matrix.durationsSeconds,
        distancesMeters: matrix.distancesMeters,
      },
      originIndex: 0,
      depotIndex: null,
      stops: planStops,
      departureAt: now,
      provider: this.deps.gateway.providerName,
    });
    if (plan.conflicts.some((conflict) => conflict.code === 'UNREACHABLE')) {
      return this.record(tourId, now, 'unavailable', 'UNREACHABLE', position, [], trigger);
    }
    const results: DelayStopResult[] = remaining.map((entry) => {
      const visit = plan.visits.find((v) => v.stopId === entry.stop.id);
      const deadline = stopDeadline(entry.appointment);
      const predicted = visit?.arrivalAt ?? null;
      return {
        stopId: entry.stop.id,
        predictedArrivalAt: predicted,
        deadlineAt: deadline,
        // Review F1: ein bereits erreichter Stopp ist nie „verspätet“.
        late:
          isOpen(entry) &&
          deadline !== null &&
          predicted !== null &&
          predicted.getTime() > deadline.getTime(),
      };
    });

    // Phase 13 (Fix F2): Ergebnis nur übernehmen, wenn die Tour beim Schreiben
    // noch aktiv und ihre Version seit dem Laden unverändert ist (Tour FOR SHARE
    // in derselben Transaktion). Sonst wird die Bewertung verworfen: nichts
    // geschrieben, kein Push, kein Gedächtnis-Eintrag (eine jüngere Bewertung
    // der geänderten Tour wird nie überschrieben).
    // Review F2: `applied` trägt die Verspätung nur für Stopps, die in der
    // Schreibtransaktion noch offen waren (frisch geladen).
    const applied = await this.applyIncidents(loaded, results, now);
    if (applied === null) {
      this.deps.logger?.info(
        { tourId, trigger, status: 'unavailable', reason: 'TOUR_CHANGED' },
        'Verspätungsbewertung verworfen (Tour beendet oder geändert)',
      );
      return { status: 'unavailable', evaluatedAt: now, reason: 'TOUR_CHANGED', stops: [] };
    }
    await this.notifyPending(loaded, processNumbers, now);
    const status: DelayEvaluationStatus = applied.some((r) => r.late) ? 'risk' : 'ok';
    return this.record(tourId, now, status, null, position, applied, trigger);
  }

  /**
   * Fix F2: Tour in der Schreibtransaktion `FOR SHARE` laden (serialisiert
   * gegen Ende/Übernahme mit FOR NO KEY UPDATE; Sperrreihenfolge Tour → Incidents
   * wie in TourService.releaseWithin). Null ⇒ Tour nicht mehr aktiv oder Version
   * seit dem Laden verändert ⇒ Aufrufer verwirft das Ergebnis.
   */
  private async lockUnchanged(tx: DatabaseTransaction, loaded: LoadedTour): Promise<Tour | null> {
    const rows = await tx.select().from(tours).where(eq(tours.id, loaded.tour.id)).for('share');
    const current = rows[0];
    if (current === undefined || current.status !== 'active') return null;
    if (current.version !== loaded.tour.version) return null;
    return current;
  }

  private async processNumbers(stops: readonly LoadedStop[]): Promise<Map<string, string>> {
    const ids = [...new Set(stops.map((entry) => entry.appointment.processId))];
    if (ids.length === 0) return new Map();
    const rows = await this.deps.db
      .select({ id: processes.id, processNumber: processes.processNumber })
      .from(processes)
      .where(inArray(processes.id, ids));
    return new Map(rows.map((row) => [row.id, row.processNumber]));
  }

  /**
   * Incidents fortschreiben – kurze Transaktion ohne externe Aufrufe; null ⇒
   * verworfen (Fix F2). Review F1/F2: Die Stoppzustände werden in der
   * Transaktion FRISCH geladen (`TourService.loadStops(tx)`, nur `tx`, kein
   * zweiter Pool-Acquire); verspätet zählt nur ein noch OFFENER Stopp. Ein
   * offener Incident zu einem inzwischen erreichten/erledigten/übersprungenen
   * Stopp wird wie „nicht mehr verbleibend“ gelöst. Rückgabe: die Ergebnisse
   * mit der tatsächlich übernommenen Verspätung.
   */
  private async applyIncidents(
    loaded: LoadedTour,
    results: readonly DelayStopResult[],
    now: Date,
  ): Promise<DelayStopResult[] | null> {
    const tourId = loaded.tour.id;
    return this.deps.db.transaction(async (tx) => {
      if ((await this.lockUnchanged(tx, loaded)) === null) return null;
      const openStopIds = new Set(
        (await this.deps.tours.loadStops(tx, tourId)).filter(isOpen).map((e) => e.stop.id),
      );
      const applied = results.map((result) => ({
        ...result,
        late: result.late && openStopIds.has(result.stopId),
      }));
      const open = await tx
        .select()
        .from(tourDelayIncidents)
        .where(and(eq(tourDelayIncidents.tourId, tourId), isNull(tourDelayIncidents.resolvedAt)));
      const openByStop = new Map(open.map((row) => [row.stopId, row]));
      for (const result of applied) {
        const existing = openByStop.get(result.stopId);
        if (result.late && result.predictedArrivalAt !== null && result.deadlineAt !== null) {
          if (existing !== undefined) {
            await tx
              .update(tourDelayIncidents)
              .set({
                lastEvaluatedAt: now,
                predictedArrivalAt: result.predictedArrivalAt,
                deadlineAt: result.deadlineAt,
              })
              .where(eq(tourDelayIncidents.id, existing.id));
          } else {
            // Partial-Unique (stop_id WHERE resolved_at IS NULL): ein paralleler
            // Lauf öffnet nie einen zweiten Incident.
            await tx
              .insert(tourDelayIncidents)
              .values({
                tourId,
                stopId: result.stopId,
                detectedAt: now,
                lastEvaluatedAt: now,
                predictedArrivalAt: result.predictedArrivalAt,
                deadlineAt: result.deadlineAt,
              })
              .onConflictDoNothing({
                target: tourDelayIncidents.stopId,
                where: isNull(tourDelayIncidents.resolvedAt),
              });
          }
          openByStop.delete(result.stopId);
        } else if (existing !== undefined) {
          await tx
            .update(tourDelayIncidents)
            .set({ resolvedAt: now, lastEvaluatedAt: now })
            .where(eq(tourDelayIncidents.id, existing.id));
          openByStop.delete(result.stopId);
        }
      }
      // Offene Incidents zu Stopps, die nicht mehr verbleiben (erledigt/übersprungen) ⇒ gelöst.
      for (const stale of openByStop.values()) {
        await tx
          .update(tourDelayIncidents)
          .set({ resolvedAt: now, lastEvaluatedAt: now })
          .where(eq(tourDelayIncidents.id, stale.id));
      }
      return applied;
    });
  }

  private async resolveAll(tourId: string, now: Date): Promise<void> {
    await this.deps.db
      .update(tourDelayIncidents)
      .set({ resolvedAt: now, lastEvaluatedAt: now })
      .where(and(eq(tourDelayIncidents.tourId, tourId), isNull(tourDelayIncidents.resolvedAt)));
  }

  /**
   * Genau ein Push je Incident und Empfänger (Order §54; Phase 13 Final §2,
   * Outbox atomar). In EINER kurzen Transaktion: Tour FOR SHARE (Fix F2 –
   * Ende/Übernahme/Versionsänderung ⇒ nichts), offene Incidents ohne
   * `notification_enqueued_at` FOR UPDATE (parallele Bewertungen serialisieren
   * sich hier; die zweite sieht nichts mehr), effektiver Fahrer aus der
   * gesperrten Tour + Vertretungen derselben Transaktion, Stoppzustände
   * FRISCH aus derselben Transaktion (Review F2: nur für einen noch OFFENEN
   * Stopp wird eine Delivery angelegt – ein inzwischen erreichter/erledigter/
   * übersprungener Stopp bekommt keinen Push, sein Incident wird gelöst),
   * Planung/Admin (vorab ermittelt – die Rechteauflösung nutzt eigene
   * Verbindungen und darf nie in der gehaltenen Transaktion laufen),
   * Delivery-Zeilen über
   * `PushService.createDelivery(…, tx)` (UNIQUE-Schlüssel je Incident+Empfänger
   * ⇒ ein Retry erzeugt nie eine zweite Zeile; eine Person in beiden Rollen ⇒
   * genau eine Zustellung), `notification_enqueued_at`, Commit.
   * KEIN `enqueueSendJob` in der Transaktion. Erst nach dem Commit wird je
   * neuer Zeile der Job `push.send` eingereiht; schlägt das fehl, wird nur
   * geloggt – der Push-Outbox-Backstop (`PushRuleScanner.scheduleOutboxBackstop`)
   * holt den Job mit demselben stabilen Schlüssel nach.
   */
  private async notifyPending(
    loaded: LoadedTour,
    processNumbers: Map<string, string>,
    now: Date,
  ): Promise<void> {
    const tourId = loaded.tour.id;
    // Billige Vorprüfung ohne Sperre: meist gibt es nichts zu melden.
    const probe = await this.deps.db
      .select({ id: tourDelayIncidents.id })
      .from(tourDelayIncidents)
      .where(pendingIncidentsWhere(tourId))
      .limit(1);
    if (probe.length === 0) return;
    const planners = await listActiveUsersWithAnyPermission(
      this.deps.db,
      this.deps.auth,
      PLANNING_PUSH_PERMISSIONS,
    );
    const created = await this.deps.db.transaction(async (tx): Promise<string[]> => {
      const current = await this.lockUnchanged(tx, loaded);
      if (current === null) return [];
      const pending: TourDelayIncident[] = await tx
        .select()
        .from(tourDelayIncidents)
        .where(pendingIncidentsWhere(current.id))
        .for('update');
      if (pending.length === 0) return [];
      const substitutions = await loadSubstitutions(tx);
      const driverId =
        this.deps.tours.effectiveDriverId(current, substitutions, now) ?? current.assignedUserId;
      // Dedupe über alle Rollen: der Fahrer bekommt die Fahrer-Variante, jeder weitere
      // Planer/Admin die Planungs-Variante – nie zwei Zustellungen an dieselbe Person.
      const recipients = new Map<string, DelayPushAudience>([[driverId, 'driver']]);
      for (const userId of planners) {
        if (!recipients.has(userId)) recipients.set(userId, 'planning');
      }
      const freshStops = await this.deps.tours.loadStops(tx, current.id);
      const newDeliveryIds: string[] = [];
      for (const incident of pending) {
        const entry = freshStops.find((stop) => stop.stop.id === incident.stopId);
        if (entry === undefined) continue;
        if (!isOpen(entry)) {
          // Review F2: Stopp zwischen Incident-Transaktion und Outbox erreicht/erledigt/
          // übersprungen ⇒ kein Push; Incident wie „nicht mehr verbleibend“ lösen.
          await tx
            .update(tourDelayIncidents)
            .set({ resolvedAt: now, lastEvaluatedAt: now })
            .where(eq(tourDelayIncidents.id, incident.id));
          continue;
        }
        const base = {
          processId: entry.appointment.processId,
          processNumber: processNumbers.get(entry.appointment.processId) ?? '',
          appointmentKind: entry.appointment.kind,
          tourId: current.id,
          incidentId: incident.id,
        } as const;
        for (const [userId, audience] of recipients) {
          const result = await this.deps.push.createDelivery(
            {
              kind: 'tour_delay_risk',
              userId,
              idempotencyKey: pushKeys.tourDelayRisk(incident.id, userId),
              payload: buildPushPayload({ kind: 'tour_delay_risk', audience, ...base }),
            },
            tx,
          );
          if (!result.deduplicated) newDeliveryIds.push(result.deliveryId);
        }
        await tx
          .update(tourDelayIncidents)
          .set({ notificationEnqueuedAt: now })
          .where(eq(tourDelayIncidents.id, incident.id));
        this.deps.logger?.info(
          {
            tourId: current.id,
            incidentId: incident.id,
            stopId: incident.stopId,
            recipients: recipients.size,
          },
          'Verspätungsrisiko gemeldet (Push-Outbox geschrieben)',
        );
      }
      return newDeliveryIds;
    });
    // Nach dem Commit: Jobs einreihen. Fehler nur loggen – der Push-Outbox-Backstop
    // holt fehlende `push.send`-Jobs nach (gleicher Schlüssel, nie ein zweiter Job).
    for (const deliveryId of created) {
      try {
        await this.deps.push.enqueueSendJob(deliveryId);
      } catch (error) {
        this.deps.logger?.warn(
          {
            tourId,
            deliveryId,
            errorCode: error instanceof Error ? error.name || 'Error' : 'Error',
          },
          'push.send-Job nicht eingereiht – Push-Outbox-Backstop holt nach',
        );
      }
    }
  }

  private record(
    tourId: string,
    now: Date,
    status: DelayEvaluationStatus,
    reason: string | null,
    position: GeoPoint | null,
    stops: DelayStopResult[],
    trigger: DelayTrigger,
  ): DelayEvaluation {
    this.state.set(tourId, { evaluatedAt: now, status, reason, position, stops });
    this.deps.logger?.info(
      { tourId, trigger, status, reason, lateStops: stops.filter((s) => s.late).length },
      'Verspätungsbewertung',
    );
    return { status, evaluatedAt: now, reason, stops };
  }
}
