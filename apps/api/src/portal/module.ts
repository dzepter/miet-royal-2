import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { JobQueue, StorageProvider } from '@mietroyal/integrations';
import type { FastifyInstance } from 'fastify';
import type { StaffAuthService } from '../auth/service.ts';
import type { CommunicationContext } from '../communication/context.ts';
import type { PushService } from '../communication/push/push-service.ts';
import type { CancellationService } from '../cancellation/cancellation-service.ts';
import type { PortalSessionAuthenticator } from './guard.ts';

/**
 * Phase 15 (Kundenportal): Einhängepunkt aller `/portal/*`-Routen. Die
 * Fachteile (AUTH, BOOKING, CHAT) registrieren hier ihre Routen; app.ts ruft
 * nur `registerPortalModule(instance, deps)` (Block `// Phase 15 (portal)`).
 *
 * Reihenfolge: AUTH liefert den `PortalSessionAuthenticator`, den alle anderen
 * Teile über `requirePortalSession` nutzen.
 */
export interface PortalModuleDeps {
  db: Database;
  config: AppConfig;
  auth: StaffAuthService;
  storage: StorageProvider;
  queue: JobQueue;
  communication: CommunicationContext;
  push: PushService;
  cancellationService: CancellationService;
  logger: FastifyInstance['log'];
}

export interface PortalModule {
  /** Session-Authentifikator (AUTH) – auch für Tests/Staff-Hinweise nutzbar. */
  sessions: PortalSessionAuthenticator;
}

export function registerPortalModule(
  _instance: FastifyInstance,
  _deps: PortalModuleDeps,
): PortalModule {
  // Phase 15 (AUTH): const sessions = createPortalAuth(...); registerPortalAuthRoutes(instance, {...});
  // Phase 15 (BOOKING): registerPortalBookingRoutes(instance, { ..., sessions });
  // Phase 15 (CHAT): registerPortalChatRoutes(instance, { ..., sessions });
  throw new Error(
    'Phase 15: Portal-Modul noch nicht verdrahtet (AUTH/BOOKING/CHAT ergänzen hier).',
  );
}
