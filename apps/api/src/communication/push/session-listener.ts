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
 * Fehler landen im Log (nur IDs) und brechen Login/Logout nie.
 */
export function createPushSessionListener(deps: {
  subscriptions: PushSubscriptionService;
  rules: PushRuleScanner;
  logger?: JobRunnerLogger;
}): SessionLifecycleListener {
  return {
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
