/**
 * Phase 12 Finalisierung (Auftrag Punkt 4): Push nach Session-Ablauf
 * automatisch wieder anbinden.
 *
 * Läuft eine Session ab (Inaktivität), wird sie widerrufen oder meldet sich
 * jemand ab, deaktiviert der Server die daran gebundene Push-Subscription
 * technisch. Die Browserberechtigung und die Browser-Subscription bleiben
 * dabei bestehen. Nach dem nächsten Login bzw. beim Start der App mit
 * gültiger Session registriert dieses Modul GENAU DIESE vorhandene
 * Browser-Subscription erneut über den bestehenden Registrierpfad
 * (POST /staff/push/subscriptions) – der Server bindet sie an den
 * angemeldeten User und die aktuelle Session und reaktiviert sie.
 *
 * Grenzen (sicherheitsrelevant):
 * - nur bei `Notification.permission === 'granted'` – bei 'default' oder
 *   'denied' passiert nichts (kein Prompt, kein Request);
 * - nur eine echte Subscription aus `pushManager.getSubscription()` des
 *   registrierten Service Workers – nie aus LocalStorage/Query/Cookie;
 * - NIE `Notification.requestPermission()`, NIE `pushManager.subscribe()`
 *   (das bleibt dem Klick auf der Einstellungsseite vorbehalten);
 * - kein Logging (der Endpoint ist eine Capability-URL), Fehler werden still
 *   geschluckt – die Einstellungsseite zeigt den echten Status.
 *
 * Reines Modul ohne Browser-Globals (Abhängigkeiten werden übergeben):
 * unit-getestet in apps/api/test/staff-push-rebind.test.ts, gegen die echte
 * Route in apps/api/test/communication-push-rebind.integration.test.ts.
 */

export type PushRebindSkipReason =
  | 'unsupported'
  | 'offline'
  | 'permission_default'
  | 'permission_denied'
  | 'no_registration'
  | 'no_subscription'
  | 'incomplete_subscription'
  | 'already_attempted';

export type PushRebindResult = 'rebound' | `skipped:${PushRebindSkipReason}` | 'failed';

/** Ausschnitt von `PushSubscription` (strukturell, ohne DOM-Typen). */
export interface PushRebindSubscription {
  readonly endpoint: string;
  toJSON(): { endpoint?: string | undefined; keys?: Record<string, string> | undefined };
}

/** Ausschnitt von `ServiceWorkerRegistration`. */
export interface PushRebindRegistration {
  readonly pushManager: { getSubscription(): Promise<PushRebindSubscription | null> };
}

export interface PushRebindRegisterBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgentLabel: string;
}

export interface PushRebindEnv {
  /** serviceWorker + PushManager + Notification vorhanden. */
  supported: boolean;
  /** `navigator.onLine` – offline wird nichts erzwungen. */
  online: boolean;
  /** Ausschnitt von `Notification` – nur `permission` wird gelesen. */
  notification: { readonly permission: string };
  /** Ausschnitt von `navigator.serviceWorker`. */
  serviceWorker: { getRegistration(): Promise<PushRebindRegistration | undefined | null> };
  /** Bestehender Registrierpfad: POST /staff/push/subscriptions. */
  register(body: PushRebindRegisterBody): Promise<{ ok: boolean }>;
  userAgentLabel(): string;
}

/** Vorhandene Browser-Subscription beim Server erneut registrieren (siehe Modulkommentar). */
export async function rebindExistingPushSubscription(
  env: PushRebindEnv,
): Promise<PushRebindResult> {
  try {
    if (!env.supported) return 'skipped:unsupported';
    if (!env.online) return 'skipped:offline';
    const permission = env.notification.permission;
    if (permission === 'denied') return 'skipped:permission_denied';
    if (permission !== 'granted') return 'skipped:permission_default';
    const registration = await env.serviceWorker.getRegistration();
    if (registration === undefined || registration === null) return 'skipped:no_registration';
    const subscription = await registration.pushManager.getSubscription();
    if (subscription === null) return 'skipped:no_subscription';
    const json = subscription.toJSON();
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (
      typeof subscription.endpoint !== 'string' ||
      subscription.endpoint === '' ||
      typeof p256dh !== 'string' ||
      typeof auth !== 'string'
    ) {
      return 'skipped:incomplete_subscription';
    }
    const result = await env.register({
      endpoint: subscription.endpoint,
      keys: { p256dh, auth },
      userAgentLabel: env.userAgentLabel(),
    });
    return result.ok ? 'rebound' : 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * „Genau einmal je App-Start“: der erste Aufruf von `run` versucht das
 * Wiederanbinden, weitere liefern `skipped:already_attempted`, bis
 * `armAfterLogin()` (erfolgreicher Login im selben Tab) erneut freigibt.
 */
export interface PushRebindScheduler {
  run(env: () => PushRebindEnv): Promise<PushRebindResult>;
  armAfterLogin(): void;
}

export function createPushRebindScheduler(): PushRebindScheduler {
  let attempted = false;
  return {
    async run(env) {
      if (attempted) return 'skipped:already_attempted';
      attempted = true;
      try {
        return await rebindExistingPushSubscription(env());
      } catch {
        return 'failed';
      }
    },
    armAfterLogin() {
      attempted = false;
    },
  };
}
