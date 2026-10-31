import { tourLiveLocations, tours, type Database, type Tour } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { AuthError } from '../../auth/service.ts';
import type { TourService } from '../tour-service.ts';

/**
 * Phase 13 (Order §§38–45, Design §9): Live-Standort der AKTIVEN Tour.
 *
 * - Genau EINE Zeile je Tour (`tour_live_locations`, PK tour_id): jedes
 *   Update überschreibt, es gibt keine Historie und keinen Track.
 * - Nur der aktuell EFFEKTIVE Fahrer (bei Vertretung der Vertreter, sonst der
 *   gespeicherte Fahrer) einer aktiven Tour darf melden; alles andere ⇒
 *   neutral NOT_FOUND (kein Existenz-Orakel) – Fix N1, Order §42. Nach Tourende/Abbruch/Übernahme lehnt der Server ab – die
 *   Zeile löscht `TourService.clearLiveLocation` in derselben Transaktion.
 * - Validierung: Breiten-/Längengrad-Bereiche, Genauigkeit 0–100 000 m,
 *   `observedAt` ∈ [now − 10 min, now + 2 min] (keine nachträglich
 *   synchronisierten Offline-Spuren, Order §46/§70).
 * - In-Process-Rate-Limit je Tour (Default 1 Update / 10 s) ⇒ 429.
 * - Diese Datei loggt NICHTS (Koordinaten dürfen nie ins Log).
 */

export const LOCATION_MIN_INTERVAL_MS = 10_000;
export const LOCATION_OBSERVED_MAX_PAST_MS = 10 * 60_000;
export const LOCATION_OBSERVED_MAX_FUTURE_MS = 2 * 60_000;
export const LOCATION_ACCURACY_MAX_METERS = 100_000;
/** Maximale Body-Größe des Standort-Updates (Design §8). */
export const LOCATION_BODY_LIMIT_BYTES = 512;

export interface LocationUpdateInput {
  latitude: number;
  longitude: number;
  accuracyMeters?: number | null | undefined;
  observedAt: Date;
}

/** Zu häufige Updates (Order §44) – die Route antwortet 429. */
export class LocationRateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Standort-Updates sind auf ein Update je 10 Sekunden begrenzt.');
    this.name = 'LocationRateLimitedError';
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export class LocationService {
  private readonly lastAccepted = new Map<string, number>();
  private readonly minIntervalMs: number;

  constructor(
    private readonly db: Database,
    private readonly tours: TourService,
    options: { minIntervalMs?: number | undefined } = {},
  ) {
    this.minIntervalMs = options.minIntervalMs ?? LOCATION_MIN_INTERVAL_MS;
  }

  /** Reine Wertprüfung – unabhängig von der Tour (kein Oracle über fremde IDs). */
  validate(input: LocationUpdateInput, now: Date): void {
    if (!isFiniteNumber(input.latitude) || input.latitude < -90 || input.latitude > 90) {
      throw new AuthError('VALIDATION', 'Breitengrad muss zwischen -90 und 90 liegen.');
    }
    if (!isFiniteNumber(input.longitude) || input.longitude < -180 || input.longitude > 180) {
      throw new AuthError('VALIDATION', 'Längengrad muss zwischen -180 und 180 liegen.');
    }
    if (input.accuracyMeters !== undefined && input.accuracyMeters !== null) {
      if (
        !isFiniteNumber(input.accuracyMeters) ||
        input.accuracyMeters < 0 ||
        input.accuracyMeters > LOCATION_ACCURACY_MAX_METERS
      ) {
        throw new AuthError(
          'VALIDATION',
          `Genauigkeit muss zwischen 0 und ${LOCATION_ACCURACY_MAX_METERS} Metern liegen.`,
        );
      }
    }
    const observed = input.observedAt.getTime();
    if (!Number.isFinite(observed)) {
      throw new AuthError('VALIDATION', 'Messzeitpunkt ist ungültig.');
    }
    if (observed < now.getTime() - LOCATION_OBSERVED_MAX_PAST_MS) {
      throw new AuthError(
        'VALIDATION',
        'Messzeitpunkt liegt zu weit zurück – ältere Standorte werden nicht übernommen.',
      );
    }
    if (observed > now.getTime() + LOCATION_OBSERVED_MAX_FUTURE_MS) {
      throw new AuthError('VALIDATION', 'Messzeitpunkt liegt in der Zukunft.');
    }
  }

  /**
   * Standort melden. Reihenfolge: Werte prüfen (400) → Tour aktiv + Aufrufer
   * effektiver Fahrer (sonst neutral 404) → Rate-Limit (429) → Upsert.
   * Die Statusprüfung und der Upsert laufen unter `FOR SHARE` auf der Tour,
   * damit ein paralleles Ende/Übernahme (FOR NO KEY UPDATE) serialisiert
   * wird und nie eine Zeile für eine bereits beendete Tour entsteht.
   */
  async update(
    actorId: string,
    tourId: string,
    input: LocationUpdateInput,
    now = new Date(),
  ): Promise<void> {
    this.validate(input, now);
    const tour = await this.tours.byId(tourId).catch((error: unknown) => {
      if (error instanceof AuthError && error.code === 'NOT_FOUND') return null;
      throw error;
    });
    if (tour === null || !(await this.authorized(tour, actorId, now))) {
      throw new AuthError('NOT_FOUND', 'Tour nicht gefunden.');
    }
    this.assertRate(tourId, now);
    const written = await this.db.transaction(async (tx) => {
      const locked = await tx.select().from(tours).where(eq(tours.id, tourId)).for('share');
      const current = locked[0];
      if (current === undefined || current.status !== 'active') return false;
      await tx
        .insert(tourLiveLocations)
        .values({
          tourId,
          userId: actorId,
          latitude: input.latitude,
          longitude: input.longitude,
          accuracyMeters: input.accuracyMeters ?? null,
          observedAt: input.observedAt,
          receivedAt: now,
        })
        .onConflictDoUpdate({
          target: tourLiveLocations.tourId,
          set: {
            userId: actorId,
            latitude: input.latitude,
            longitude: input.longitude,
            accuracyMeters: input.accuracyMeters ?? null,
            observedAt: input.observedAt,
            receivedAt: now,
          },
        });
      return true;
    });
    if (!written) throw new AuthError('NOT_FOUND', 'Tour nicht gefunden.');
    this.lastAccepted.set(tourId, now.getTime());
  }

  /**
   * Phase 13 (Fix N1, Order §42): Standort meldet NUR der aktuell EFFEKTIVE
   * Fahrer (bei aktiver Vertretung der Vertreter; der vertretene gespeicherte
   * Fahrer wird neutral 404 abgelehnt). Start/Ende/„Angekommen“ bleiben für
   * gespeicherten ODER effektiven Fahrer erlaubt (TourService.isDriver).
   */
  private async authorized(tour: Tour, actorId: string, now: Date): Promise<boolean> {
    if (tour.status !== 'active') return false;
    const context = await this.tours.driverContext(tour, now);
    return (context.effectiveDriverId ?? tour.assignedUserId) === actorId;
  }

  private assertRate(tourId: string, now: Date): void {
    const last = this.lastAccepted.get(tourId);
    if (last !== undefined && now.getTime() - last < this.minIntervalMs) {
      throw new LocationRateLimitedError(this.minIntervalMs - (now.getTime() - last));
    }
    if (this.lastAccepted.size > 1000) {
      const cutoff = now.getTime() - 3_600_000;
      for (const [id, at] of this.lastAccepted) if (at < cutoff) this.lastAccepted.delete(id);
    }
  }

  /** Tests/Übernahme: Drossel einer Tour vergessen. */
  forgetRate(tourId: string): void {
    this.lastAccepted.delete(tourId);
  }
}
