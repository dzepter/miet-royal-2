import { geocodingCache, type Database, type GeocodingCacheRow } from '@mietroyal/database';
import { z } from '@mietroyal/validation';
import { eq } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import { addressHashFor, geocodeQueryFor, normalizeAddressText } from './address-resolver.ts';
// Phase 13 (Fix F6): Adress-Zerlegung in eigener reiner Datei (auch Mock/Fake-Server nutzen sie);
// bisherige Importe aus dieser Datei bleiben über die Re-Exports gültig.
import {
  normalizeHousenumber,
  normalizeStreetName,
  parseAddressInput,
  type ParsedAddressInput,
} from './address-parse.ts';
import type {
  GeocodingCandidateView,
  GeocodingResolution,
  GeocodingResolver,
} from './geocoding-types.ts';
import type { RoutingLogger } from './graphhopper.ts';
import { RoutingError, type GeocodeCandidate, type RoutingGateway } from './types.ts';

/**
 * Phase 13 (Order §16/§17, Design §4): konservative, serverseitige Geokodierung
 * operativer Adressen mit temporärem Cache (`geocoding_cache`, ToS §5.2 –
 * nur Koordinaten/Labels mit TTL, nie Provider-Rohantworten).
 *
 * Ablauf `resolve(addressText, {now})`:
 * 1. Cache-Lookup per Hash der Provider-Anfrage (Adresse + „, Deutschland“,
 *    Kleinschreibung). Nicht abgelaufen ⇒ Ergebnis aus dem Cache. Abgelaufen
 *    mit bewusster Staff-Bestätigung (`confirmedOsmRef`) ⇒ Provider erneut;
 *    liefert er denselben Treffer, bleibt die Bestätigung wirksam.
 * 2. Provider (limit 5, locale de, provider nominatim – siehe graphhopper.ts).
 *    Im Query steht NUR die Adresse (+ Land) – nie Kundenname/Telefon/Vorgang.
 * 3. Entscheidung (`decideGeocoding`, rein): 0 Treffer ⇒ no_result; genau ein
 *    Treffer, der Straße + PLZ (bzw. Ort) + Hausnummer der Eingabe bestätigt ⇒
 *    resolved; sonst review_required mit ≤ 5 Kandidaten (keine stille
 *    Straßenmitte, keine abweichende PLZ). Nie still falsch routen.
 * 4. RoutingError ⇒ status unavailable, nichts gecacht.
 * `confirmCandidate(cacheId, candidateRef, actorId)` übernimmt ausschließlich
 * einen GESPEICHERTEN Kandidaten (keine freien Koordinaten vom Client, Order §23).
 * TTL: resolved 90 Tage, review_required/no_result 30 Tage.
 */

export const GEOCODING_TTL_RESOLVED_MS = 90 * 24 * 60 * 60 * 1000;
export const GEOCODING_TTL_REVIEW_MS = 30 * 24 * 60 * 60 * 1000;
export const GEOCODING_CANDIDATE_LIMIT = 5;

const storedCandidateSchema = z.object({
  label: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  osmRef: z.string().min(1),
});
const storedCandidatesSchema = z.array(storedCandidateSchema);
type StoredCandidate = z.infer<typeof storedCandidateSchema>;

export { normalizeStreetName, parseAddressInput, type ParsedAddressInput };

export type GeocodingDecision =
  | { status: 'resolved'; candidate: GeocodeCandidate; confirmed: boolean }
  | { status: 'review_required'; candidates: GeocodeCandidate[] }
  | { status: 'no_result' };

/** Stabile Kandidaten-Referenz (Provider-Ref, sonst Koordinate) – nur für Wiedererkennung. */
export function candidateRef(candidate: GeocodeCandidate): string {
  return (
    candidate.ref ??
    `point:${candidate.point.latitude.toFixed(6)},${candidate.point.longitude.toFixed(6)}`
  );
}

function cityMatches(candidateCity: string | null, inputCity: string | null): boolean {
  if (candidateCity === null || inputCity === null) return false;
  const a = normalizeStreetName(candidateCity);
  const b = normalizeStreetName(inputCity);
  return a !== '' && (a === b || a.startsWith(b) || b.startsWith(a));
}

/**
 * Konservative Eindeutigkeitsregel (Design §4 Punkt 3). Rein, ohne I/O –
 * damit die Regel unabhängig vom Provider testbar bleibt.
 */
export function decideGeocoding(
  input: ParsedAddressInput,
  candidates: GeocodeCandidate[],
  confirmedRef: string | null = null,
): GeocodingDecision {
  const limited = candidates.slice(0, GEOCODING_CANDIDATE_LIMIT);
  if (limited.length === 0) return { status: 'no_result' };
  if (confirmedRef !== null) {
    const confirmed = limited.find((candidate) => candidateRef(candidate) === confirmedRef);
    if (confirmed !== undefined)
      return { status: 'resolved', candidate: confirmed, confirmed: true };
  }
  const inputStreet = input.streetName === null ? null : normalizeStreetName(input.streetName);
  const exact = limited.filter((candidate) => {
    if (inputStreet === null || candidate.street === null) return false;
    if (normalizeStreetName(candidate.street) !== inputStreet) return false;
    if (input.postcode !== null) {
      if (candidate.postcode !== input.postcode) return false;
    } else if (!cityMatches(candidate.city, input.city)) {
      return false;
    }
    if (input.housenumber !== null) {
      // Eingabe mit Hausnummer: der Treffer muss sie bestätigen (keine stille Straßenmitte).
      return (
        candidate.housenumber !== null &&
        normalizeHousenumber(candidate.housenumber) === input.housenumber
      );
    }
    return true;
  });
  if (exact.length === 1) {
    const hit = exact[0]!;
    const othersSamePostcode = limited.some(
      (candidate) =>
        candidate !== hit && candidate.postcode !== null && candidate.postcode === hit.postcode,
    );
    if (hit.housenumber !== null || !othersSamePostcode) {
      return { status: 'resolved', candidate: hit, confirmed: false };
    }
  }
  return { status: 'review_required', candidates: limited };
}

function toView(candidate: StoredCandidate): GeocodingCandidateView {
  return {
    ref: candidate.osmRef,
    label: candidate.label,
    point: { latitude: candidate.latitude, longitude: candidate.longitude },
  };
}

function storedCandidates(row: GeocodingCacheRow): StoredCandidate[] {
  const parsed = storedCandidatesSchema.safeParse(row.candidates);
  return parsed.success ? parsed.data : [];
}

function resolutionFromRow(row: GeocodingCacheRow): GeocodingResolution {
  if (row.status === 'resolved' && row.latitude !== null && row.longitude !== null) {
    return {
      status: 'resolved',
      point: { latitude: row.latitude, longitude: row.longitude },
      label: row.displayLabel,
      candidates: [],
      cacheId: row.id,
    };
  }
  if (row.status === 'review_required') {
    return {
      status: 'review_required',
      point: null,
      label: null,
      candidates: storedCandidates(row).map(toView),
      cacheId: row.id,
    };
  }
  return { status: 'no_result', point: null, label: null, candidates: [], cacheId: row.id };
}

function unavailable(cacheId: string | null): GeocodingResolution {
  return { status: 'unavailable', point: null, label: null, candidates: [], cacheId };
}

export class GeocodingService implements GeocodingResolver {
  constructor(
    private readonly db: Database,
    private readonly gateway: RoutingGateway,
    private readonly logger?: RoutingLogger,
  ) {}

  async resolve(addressText: string, options: { now: Date }): Promise<GeocodingResolution> {
    const normalized = normalizeAddressText(addressText);
    if (normalized === '') {
      return { status: 'no_result', point: null, label: null, candidates: [], cacheId: null };
    }
    const now = options.now;
    const hash = addressHashFor(normalized);
    const existing = await this.db
      .select()
      .from(geocodingCache)
      .where(eq(geocodingCache.addressHash, hash));
    const row = existing[0] ?? null;
    if (row !== null && row.expiresAt.getTime() > now.getTime()) return resolutionFromRow(row);

    let candidates: GeocodeCandidate[];
    try {
      const result = await this.gateway.geocode({
        query: geocodeQueryFor(normalized),
        limit: GEOCODING_CANDIDATE_LIMIT,
        locale: 'de',
      });
      candidates = result.candidates;
    } catch (error) {
      if (error instanceof RoutingError) {
        this.logger?.warn(
          { routing: { geocoding: 'unavailable', code: error.code, transient: error.transient } },
          'Geocoding nicht verfügbar',
        );
        return unavailable(row?.id ?? null);
      }
      throw error;
    }

    const decision = decideGeocoding(
      parseAddressInput(normalized),
      candidates,
      row?.confirmedOsmRef ?? null,
    );
    const values = this.rowValues(normalized, hash, decision, now);
    const saved = await this.db
      .insert(geocodingCache)
      .values(values)
      .onConflictDoUpdate({
        target: geocodingCache.addressHash,
        set: {
          addressText: values.addressText,
          status: values.status,
          latitude: values.latitude,
          longitude: values.longitude,
          displayLabel: values.displayLabel,
          osmRef: values.osmRef,
          candidates: values.candidates,
          provider: values.provider,
          fetchedAt: values.fetchedAt,
          expiresAt: values.expiresAt,
        },
      })
      .returning();
    return resolutionFromRow(saved[0]!);
  }

  /**
   * Phase 13 (tours-live, Nacharbeit): Cache-Stand OHNE Provider-Aufruf –
   * für die Tour-View (Adress-Status/Kandidaten/cacheId) und den Offline-
   * Snapshot. Abgelaufene oder fehlende Einträge ⇒ null (die Planung ruft
   * dann `resolve`, nie die Anzeige).
   */
  async peekCached(
    addressText: string,
    options: { now: Date },
  ): Promise<GeocodingResolution | null> {
    const normalized = normalizeAddressText(addressText);
    if (normalized === '') return null;
    const rows = await this.db
      .select()
      .from(geocodingCache)
      .where(eq(geocodingCache.addressHash, addressHashFor(normalized)));
    const row = rows[0];
    if (row === undefined || row.expiresAt.getTime() <= options.now.getTime()) return null;
    return resolutionFromRow(row);
  }

  /**
   * Bewusste Staff-Auswahl eines gespeicherten Kandidaten (Order §17/§23).
   * Unbekannter Cache-Eintrag ⇒ NOT_FOUND; Ref nicht unter den gespeicherten
   * Kandidaten ⇒ VALIDATION (Client-Koordinaten werden nie übernommen).
   */
  async confirmCandidate(
    cacheId: string,
    candidateRef: string,
    actorId: string,
    options: { now?: Date } = {},
  ): Promise<GeocodingResolution> {
    const now = options.now ?? new Date();
    const rows = await this.db.select().from(geocodingCache).where(eq(geocodingCache.id, cacheId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Adressprüfung nicht gefunden.');
    const candidate = storedCandidates(row).find((entry) => entry.osmRef === candidateRef);
    if (candidate === undefined) {
      throw new AuthError(
        'VALIDATION',
        'Der gewählte Kandidat gehört nicht zu dieser Adressprüfung.',
      );
    }
    const updated = await this.db
      .update(geocodingCache)
      .set({
        status: 'resolved',
        latitude: candidate.latitude,
        longitude: candidate.longitude,
        displayLabel: candidate.label,
        osmRef: candidate.osmRef,
        confirmedBy: actorId,
        confirmedAt: now,
        confirmedOsmRef: candidate.osmRef,
        expiresAt: new Date(now.getTime() + GEOCODING_TTL_RESOLVED_MS),
      })
      .where(eq(geocodingCache.id, row.id))
      .returning();
    return resolutionFromRow(updated[0]!);
  }

  private rowValues(
    normalized: string,
    hash: string,
    decision: GeocodingDecision,
    now: Date,
  ): typeof geocodingCache.$inferInsert {
    const base = {
      addressHash: hash,
      addressText: normalized,
      provider: this.gateway.providerName,
      fetchedAt: now,
    };
    if (decision.status === 'resolved') {
      return {
        ...base,
        status: 'resolved',
        latitude: decision.candidate.point.latitude,
        longitude: decision.candidate.point.longitude,
        displayLabel: decision.candidate.label,
        osmRef: candidateRef(decision.candidate),
        candidates: null,
        expiresAt: new Date(now.getTime() + GEOCODING_TTL_RESOLVED_MS),
      };
    }
    if (decision.status === 'review_required') {
      const stored: StoredCandidate[] = decision.candidates.map((candidate) => ({
        label: candidate.label,
        latitude: candidate.point.latitude,
        longitude: candidate.point.longitude,
        osmRef: candidateRef(candidate),
      }));
      return {
        ...base,
        status: 'review_required',
        latitude: null,
        longitude: null,
        displayLabel: null,
        osmRef: null,
        candidates: stored,
        expiresAt: new Date(now.getTime() + GEOCODING_TTL_REVIEW_MS),
      };
    }
    return {
      ...base,
      status: 'no_result',
      latitude: null,
      longitude: null,
      displayLabel: null,
      osmRef: null,
      candidates: null,
      expiresAt: new Date(now.getTime() + GEOCODING_TTL_REVIEW_MS),
    };
  }
}
