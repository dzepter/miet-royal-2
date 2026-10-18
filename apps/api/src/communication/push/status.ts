import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import { PushSubscriptionService } from './subscription-service.ts';

/**
 * Admin-Status „Push/VAPID“ (Order §35) für Einstellungen → Kommunikation:
 * nur enabled, öffentlicher VAPID-Key und Anzahl aktiver Geräte – der
 * private Schlüssel oder Endpoints tauchen hier NIE auf.
 */
export interface PushStatusSummary {
  enabled: boolean;
  vapidPublicKey: string | null;
  activeDevices: number;
}

export async function pushStatusSummary(
  db: Database,
  config: AppConfig,
): Promise<PushStatusSummary> {
  const subscriptions = new PushSubscriptionService(db);
  return {
    enabled: config.push.enabled,
    vapidPublicKey: config.push.enabled ? config.push.vapidPublicKey : null,
    activeDevices: await subscriptions.countActive(),
  };
}
