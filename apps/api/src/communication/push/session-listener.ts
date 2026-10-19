import type { JobRunnerLogger } from '@mietroyal/integrations';
import type { SessionLifecycleListener } from '../../auth/service.ts';
import type { PushRuleScanner } from './rules.ts';
import type { PushSubscriptionService } from './subscription-service.ts';

/**
 * Verdrahtung der Auth-Ereignisse mit Web Push (Order §29/§31):
 * - Logout/Revoke/Deaktivierung ⇒ Subscriptions dieser Session(s) sofort
 *   deaktiviert (`session_revoked`) – zusätzlich prüft der Versand lazy.
 * - Neues Gerät (`session.new_device_login`) ⇒ sofort ein Admin-Security-Push
 *   (Schlüssel je Session; der Scan ist nur Backstop).
 * - Phase 12 Finalisierung (B1): neue Session ⇒ Subscriptions DESSELBEN Users
 *   auf DEMSELBEN Gerät (gleicher Geräte-Hash) an die neue Session binden.
 *   Abhängigkeitsrichtung wie beim newDeviceLogin-Hook: die Auth kennt Push
 *   nicht, sie meldet nur das Ereignis; Push entscheidet selbst.
 * Fehler landen im Log (nur IDs + neutraler Code) und brechen Login/Logout nie.
 */
export function createPushSessionListener(deps: {
  subscriptions: PushSubscriptionService;
  rules: PushRuleScanner;
  logger?: JobRunnerLogger;
}): SessionLifecycleListener {
  return {
    async sessionCreated(event) {
      try {
        const rebound = await deps.subscriptions.rebindSameDeviceSessions(
          event.userId,
          event.sessionId,
        );
        if (rebound > 0) {
          deps.logger?.info(
            { userId: event.userId, sessionId: event.sessionId, rebound },
            'Push-Subscriptions an die neue Session gebunden',
          );
        }
      } catch (error) {
        deps.logger?.warn(
          {
            userId: event.userId,
            sessionId: event.sessionId,
            error: error instanceof Error ? error.name : 'Error',
          },
          'Push-Subscriptions konnten nicht an die neue Session gebunden werden',
        );
      }
    },
    async newDeviceLogin(event) {
      try {
        await deps.rules.notifyNewDeviceLogin(event.sessionId);
      } catch (error) {
        deps.logger?.warn(
          { sessionId: event.sessionId, error: error instanceof Error ? error.name : 'Error' },
          'Push „neues Gerät“ konnte nicht eingereiht werden',
        );
      }
    },
    async sessionRevoked(event) {
      await deps.subscriptions.disableForSession(event.sessionId, 'session_revoked');
    },
    async sessionsRevoked(event) {
      for (const sessionId of event.sessionIds) {
        await deps.subscriptions.disableForSession(sessionId, 'session_revoked');
      }
    },
  };
}
