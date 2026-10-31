/**
 * Phase 13 (Order §5/§6, Design §2): Fabrik der Routing-Grenze nach
 * `config.routing` – genau eine Instanz je Prozess (API bzw. Worker).
 *
 * - graphhopper ⇒ GraphHopperRoutingGateway (echter Provider, Key nur hier).
 * - mock ⇒ MockRoutingGateway (demo/development) – in production verweigert
 *   die Fabrik hart, einen Mock/Fake zu erzeugen (die Konfiguration lehnt das
 *   bereits ab; hier die zweite Sperre).
 * - disabled ⇒ DisabledRoutingGateway (jede Anfrage ROUTING_DISABLED).
 * Ein einmaliger Start-Log nennt nur den Provider – nie Key oder URL.
 */
import type { AppConfig } from '@mietroyal/config';
import { DisabledRoutingGateway, MockRoutingGateway } from './fake.ts';
import { GraphHopperRoutingGateway, type RoutingLogger } from './graphhopper.ts';
import type { RoutingGateway } from './types.ts';

export type { RoutingLogger } from './graphhopper.ts';

export function createRoutingGateway(
  config: Pick<AppConfig, 'appEnv' | 'routing'>,
  logger?: RoutingLogger,
): RoutingGateway {
  const routing = config.routing;
  let gateway: RoutingGateway;
  if (routing.provider === 'graphhopper') {
    if (routing.graphhopper.apiKey === null) {
      // Durch loadConfig nicht erreichbar (Key ⇔ provider graphhopper); fail-closed.
      gateway = new DisabledRoutingGateway();
    } else {
      gateway = new GraphHopperRoutingGateway({
        apiKey: routing.graphhopper.apiKey,
        baseUrl: routing.graphhopper.baseUrl,
        timeoutMs: routing.graphhopper.requestTimeoutMs,
        ...(logger === undefined ? {} : { logger }),
      });
    }
  } else if (routing.provider === 'mock') {
    if (config.appEnv === 'production') {
      throw new Error('Mock-Routing-Gateway ist in production nicht zulässig.');
    }
    gateway = new MockRoutingGateway();
  } else {
    gateway = new DisabledRoutingGateway();
  }
  if (gateway.kind === 'disabled' && config.appEnv === 'production') {
    logger?.warn(
      { routing: { provider: gateway.kind } },
      'Routing nicht konfiguriert (kein GRAPHHOPPER_API_KEY) – Touren ohne Routenberechnung',
    );
  }
  logger?.info({ routing: { provider: gateway.kind } }, `Routing: provider=${gateway.kind}`);
  return gateway;
}
