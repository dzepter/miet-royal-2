import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { JobQueue, StorageProvider } from '@mietroyal/integrations';
import type { FastifyInstance } from 'fastify';
import type { StaffAuthService } from '../auth/service.ts';
import type { CommunicationContext } from '../communication/context.ts';
import type { PushService } from '../communication/push/push-service.ts';
import type { CancellationService } from '../cancellation/cancellation-service.ts';
import type { PortalSessionAuthenticator } from './guard.ts';
// Phase 15 (AUTH)
import { PortalMagicLinkService } from './auth/magic-link-service.ts';
import { PortalProfileService } from './auth/profile-service.ts';
import { PortalSessionService } from './auth/session-service.ts';
import { registerPortalAuthRoutes } from '../routes/portal-auth.ts';
import { registerPortalProfileRoutes } from '../routes/portal-profile.ts';
import { registerPortalBookingRoutes } from '../routes/portal-booking.ts'; // Phase 15 (BOOKING)
import { registerPortalChatRoutes } from '../routes/portal-chat.ts'; // Phase 15 (CHAT)

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
  /** Phase 15 (AUTH): Rate-Limits der Auth-Grenze (Default: aktiv, wenn @fastify/rate-limit registriert ist). */
  rateLimitEnabled?: boolean | undefined;
}

export interface PortalModule {
  /** Session-Authentifikator (AUTH) – auch für Tests/Staff-Hinweise nutzbar. */
  sessions: PortalSessionAuthenticator;
}

export function registerPortalModule(
  instance: FastifyInstance,
  deps: PortalModuleDeps,
): PortalModule {
  // Phase 15 (AUTH): Sessions, Magic Links, Profil – Routen /portal/auth/*, /portal/me, /portal/profile.
  const sessions = new PortalSessionService(deps.db);
  const magicLinks = new PortalMagicLinkService(
    deps.db,
    deps.communication.outbox,
    deps.config,
    sessions,
    { logger: deps.logger },
  );
  registerPortalAuthRoutes(instance, {
    db: deps.db,
    config: deps.config,
    sessions,
    magicLinks,
    rateLimitEnabled: deps.rateLimitEnabled,
  });
  registerPortalProfileRoutes(instance, {
    config: deps.config,
    sessions,
    profile: new PortalProfileService(deps.db),
  });
  // Phase 15 (BOOKING): Buchungen, Dokumente, Rechnungsstatus, Storno – Order §13–§24, §38–§44.
  registerPortalBookingRoutes(instance, {
    db: deps.db,
    config: deps.config,
    storage: deps.storage,
    cancellationService: deps.cancellationService,
    sessions,
    logger: deps.logger,
  });
  // Phase 15 (CHAT): Portal-Chat (Nachrichten, Fotos) – Order §25–§28.
  registerPortalChatRoutes(instance, {
    db: deps.db,
    config: deps.config,
    storage: deps.storage,
    push: deps.push,
    sessions,
    logger: deps.logger,
  });
  return { sessions };
}
