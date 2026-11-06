import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Phase 16 (REVIEWS, Design §11.3): lokaler Contract-Fake der Places API (New) – Place
 * Details `GET /v1/places/{placeId}` mit der dokumentierten Antwortform
 * (docs/GOOGLE_REVIEWS_API_NOTES.md; alle URLs sind Platzhalter auf den Beispiel-Hosts).
 * Tests rufen NIE Google auf.
 *
 * - Auth nur im Header `X-Goog-Api-Key`; fehlend/falsch ⇒ 403 (Fehlerform AIP-193).
 * - Feldmaske Pflicht (`X-Goog-FieldMask`), sonst 400.
 * - skriptbare Störungen (`state.failures`): Status (z. B. 429/500/503), Verzögerung
 *   (Timeout), kaputtes JSON.
 * - zeichnet jede Anfrage auf (Pfad, Query, Feldmaske, Header-NAMEN, Key gültig ja/nein) –
 *   den Key selbst NIE.
 */

export interface PlacesFakeFailure {
  /** Wie oft die Störung greift (danach entfernt). */
  times: number;
  /** 'status' (Default): Statuscode + AIP-193-Fehlerkörper; 'delay': Antwort verzögern; 'invalid_json'. */
  mode?: 'status' | 'delay' | 'invalid_json';
  status?: number;
  delayMs?: number;
}

export interface PlacesFakeRequest {
  method: string;
  /** Pfad ohne Query. */
  path: string;
  placeId: string | null;
  query: Record<string, string>;
  fieldMask: string | null;
  keyPresent: boolean;
  keyValid: boolean;
  /** Kleingeschriebene Header-Namen (ohne Werte). */
  headerNames: string[];
  at: number;
  status: number;
}

export interface PlacesFakeState {
  apiKey: string;
  placeId: string;
  requests: PlacesFakeRequest[];
  failures: PlacesFakeFailure[];
  /** Antwortkörper für 200 (skriptbar; Default `defaultPlacesFakeBody`). */
  body: unknown;
  reset(): void;
}

export const PLACES_FAKE_DEFAULT_PLACE_ID = 'ChIJSynthMietRoyalTestPlace0001';

/** Platzhalter-Antwort mit drei vollständigen Bewertungen (eine davon übersetzt). */
export function defaultPlacesFakeBody(placeId: string = PLACES_FAKE_DEFAULT_PLACE_ID): unknown {
  const review = (n: number, overrides: Record<string, unknown> = {}) => ({
    name: `places/${placeId}/reviews/synth-${n}`,
    relativePublishTimeDescription: `vor ${n} Wochen`,
    rating: n === 3 ? 4 : 5,
    text: { text: `Synthetischer Testtext ${n}.`, languageCode: 'de' },
    originalText: { text: `Synthetischer Testtext ${n}.`, languageCode: 'de' },
    authorAttribution: {
      displayName: `Test Person ${n}`,
      uri: `https://www.google.com/maps/contrib/synth-${n}/reviews`,
      photoUri: `https://lh3.googleusercontent.com/a-/synth-${n}=s128-c0x00000000-cc-rp-mo`,
    },
    publishTime: `2026-10-0${n}T10:00:00.000000Z`,
    flagContentUri: `https://www.google.com/local/review/rap/report?postId=synth-${n}`,
    googleMapsUri: `https://www.google.com/maps/reviews/data=synth-${n}`,
    ...overrides,
  });
  return {
    id: placeId,
    rating: 4.8,
    userRatingCount: 42,
    googleMapsUri: `https://maps.google.com/?cid=1234567890`,
    reviews: [
      review(1),
      review(2, {
        text: { text: 'Synthetischer Testtext 2 (übersetzt).', languageCode: 'de' },
        originalText: { text: 'Synthetic test text 2.', languageCode: 'en' },
      }),
      review(3),
    ],
  };
}

export function createPlacesFakeState(
  options: { apiKey?: string; placeId?: string } = {},
): PlacesFakeState {
  const placeId = options.placeId ?? PLACES_FAKE_DEFAULT_PLACE_ID;
  const state: PlacesFakeState = {
    apiKey: options.apiKey ?? 'SYNTH-places-key-never-real',
    placeId,
    requests: [],
    failures: [],
    body: defaultPlacesFakeBody(placeId),
    reset() {
      state.requests = [];
      state.failures = [];
      state.body = defaultPlacesFakeBody(placeId);
    },
  };
  return state;
}

function aipError(status: number, message: string): unknown {
  const statusName: Record<number, string> = {
    400: 'INVALID_ARGUMENT',
    403: 'PERMISSION_DENIED',
    404: 'NOT_FOUND',
    429: 'RESOURCE_EXHAUSTED',
    500: 'INTERNAL',
    503: 'UNAVAILABLE',
  };
  return { error: { code: status, message, status: statusName[status] ?? 'UNKNOWN' } };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export function createPlacesFakeHandler(state: PlacesFakeState) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://fake.local');
    const match = /^\/v1\/places\/([^/]+)$/.exec(url.pathname);
    const key = req.headers['x-goog-api-key'];
    const fieldMask = req.headers['x-goog-fieldmask'];
    const record: PlacesFakeRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      placeId: match?.[1] === undefined ? null : decodeURIComponent(match[1]),
      query: Object.fromEntries(url.searchParams.entries()),
      fieldMask: typeof fieldMask === 'string' ? fieldMask : null,
      keyPresent: typeof key === 'string' && key !== '',
      keyValid: key === state.apiKey,
      headerNames: Object.keys(req.headers).sort(),
      at: Date.now(),
      status: 0,
    };
    state.requests.push(record);
    const finish = (status: number, body: unknown) => {
      record.status = status;
      send(res, status, body);
    };
    if (record.method !== 'GET' || match === null) {
      finish(404, aipError(404, 'Not found'));
      return;
    }
    if (!record.keyValid) {
      finish(403, aipError(403, 'The provided API key is invalid.'));
      return;
    }
    if (record.fieldMask === null || record.fieldMask === '') {
      finish(400, aipError(400, 'FieldMask is a required parameter.'));
      return;
    }
    const failure = state.failures[0];
    if (failure !== undefined) {
      failure.times -= 1;
      if (failure.times <= 0) state.failures.shift();
      const mode = failure.mode ?? 'status';
      if (mode === 'delay') {
        await new Promise((resolve) => setTimeout(resolve, failure.delayMs ?? 5000));
        if (res.destroyed || res.writableEnded) return;
      } else if (mode === 'invalid_json') {
        finish(200, '{"id": "kaputt", "reviews": [');
        return;
      } else {
        const status = failure.status ?? 500;
        finish(status, aipError(status, 'Synthetic failure.'));
        return;
      }
    }
    if (record.placeId !== state.placeId) {
      finish(404, aipError(404, 'Place not found.'));
      return;
    }
    finish(200, state.body);
  };
}

export interface PlacesFakeServer {
  /** z. B. http://127.0.0.1:PORT – als `baseUrl` des GoogleReviewGateway (nur Tests). */
  baseUrl: string;
  state: PlacesFakeState;
  stop(): Promise<void>;
}

export async function startPlacesFakeServer(
  options: { apiKey?: string; placeId?: string; port?: number } = {},
): Promise<PlacesFakeServer> {
  const state = createPlacesFakeState(options);
  const handler = createPlacesFakeHandler(state);
  const server: Server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.writableEnded) send(res, 500, aipError(500, 'fake crashed'));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve()),
  );
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
