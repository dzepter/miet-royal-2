import { FAKES_CONTROL_ORIGIN } from '../fakes/constants.ts';

/**
 * Phase 13 (E2E): Steuerung des GraphHopper-Contract-Fakes, der im HTTPS-
 * Dispatcher der Kommunikations-Fakes (Port 4567, Pfadpräfix /api/1) läuft
 * (fakes/communication-fakes.ts, Routen `/routing/*` des Control-Servers).
 *
 * - `routingRequests()`: Aufzeichnung aller Anfragen (Pfad, Query OHNE Key,
 *   Body) – damit prüfen Specs, dass nur Adressen/Koordinaten/Zeitfenster
 *   gesendet werden und dass die Demo-API den Fake NIE erreicht.
 * - `resetRoutingFake()`: Aufzeichnung, Störungen und unerreichbare Paare
 *   zurücksetzen (Beginn/Ende jedes Szenarios).
 * - `failRouting()`: nächste Antworten stören (Status/Verzögerung/kaputtes
 *   JSON) – Szenario H „Provider aus“.
 * - `setUnreachablePairs()`: Matrix-Paare als unerreichbar (null) markieren.
 */

export type RoutingFakeEndpoint = 'geocode' | 'route' | 'matrix' | 'vrp' | 'all';

export interface RoutingFakeRequest {
  method: string;
  path: string;
  endpoint: Exclude<RoutingFakeEndpoint, 'all'> | null;
  query: Record<string, string>;
  keyPresent: boolean;
  keyValid: boolean;
  body: unknown;
  at: number;
  status: number;
}

async function control<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
  const response = await fetch(`${FAKES_CONTROL_ORIGIN}${path}`, {
    method,
    // Keine Keep-Alive-Sockets (siehe helpers/lexware.ts control()).
    headers: {
      connection: 'close',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Fake-Steuerung ${method} ${path}: ${response.status}`);
  return (await response.json()) as T;
}

export async function routingRequests(): Promise<RoutingFakeRequest[]> {
  const { requests } = await control<{ requests: RoutingFakeRequest[] }>(
    'GET',
    '/routing/requests',
  );
  return requests;
}

export async function resetRoutingFake(): Promise<void> {
  await control('DELETE', '/routing/requests');
}

export async function failRouting(input: {
  endpoint: RoutingFakeEndpoint;
  times?: number;
  mode?: 'status' | 'delay' | 'invalid_json';
  status?: number;
  delayMs?: number;
}): Promise<void> {
  await control('POST', '/routing/fail-next', input);
}

export async function setUnreachablePairs(pairs: readonly string[]): Promise<void> {
  await control('POST', '/routing/unreachable', { pairs });
}

/** Text aller aufgezeichneten Anfragen (Query + Body) – für Datenminimierungs-Prüfungen. */
export function routingRequestText(requests: readonly RoutingFakeRequest[]): string {
  return JSON.stringify(requests.map((request) => ({ query: request.query, body: request.body })));
}
