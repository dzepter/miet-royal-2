import type { AppConfig, AppEnvironment } from '@mietroyal/config';
import webpush from 'web-push';
import { checkPushEndpoint } from './endpoint-policy.ts';
import type {
  PushGateway,
  PushPayload,
  PushSendOutcome,
  PushSubscriptionTarget,
} from '../types.ts';

/**
 * Push-Gateways (Order §29/§41). Der Endpoint ist eine Capability-URL
 * (RFC 8030 §8.3) – Endpoint und Schlüssel erscheinen nie in Logs oder
 * Fehlermeldungen; Ergebnisse tragen nur neutrale Codes.
 *
 * Statuszuordnung (RFC 8030 §5/§7.3 + Praxis der Push-Dienste):
 * - 200/201 ⇒ sent (angenommen, nicht „zugestellt“)
 * - 404/410 ⇒ gone (Subscription abgelaufen/entfernt ⇒ deaktivieren)
 * - 429/5xx/Netzfehler ⇒ transient_error (Queue-Retry)
 * - 400/401/403/413 (u. a.) ⇒ permanent_error (Konfiguration/Payload)
 * Härtung B10 (Defense in depth): vor jedem Versand dieselbe Endpoint-Regel
 * wie bei der Registrierung (`checkPushEndpoint`) – Altbestand oder direkt
 * geschriebene Zeilen erreichen so nie interne Ziele. web-push folgt keinen
 * Redirects (https.request; 3xx ⇒ permanent_error HTTP_3xx).
 */

/** TTL 1 h: ein Terminhinweis ist danach wertlos (RFC 8030 §5.2 verlangt TTL). */
export const PUSH_TTL_SECONDS = 3600;

interface WebPushErrorLike {
  statusCode?: unknown;
}

export function outcomeFromStatusCode(statusCode: number): PushSendOutcome {
  if (statusCode === 200 || statusCode === 201) return { outcome: 'sent' };
  if (statusCode === 404 || statusCode === 410) return { outcome: 'gone' };
  if (statusCode === 429 || statusCode >= 500) {
    return { outcome: 'transient_error', code: `HTTP_${statusCode}` };
  }
  return { outcome: 'permanent_error', code: `HTTP_${statusCode}` };
}

export class WebPushGateway implements PushGateway {
  readonly kind = 'web_push' as const;
  private readonly vapidDetails: { subject: string; publicKey: string; privateKey: string };
  private readonly appEnv: AppEnvironment;

  /** `appEnv` bestimmt die Endpoint-Regel; Default ist die strenge Regel (production). */
  constructor(
    vapid: { subject: string; publicKey: string; privateKey: string },
    options: { appEnv?: AppEnvironment } = {},
  ) {
    // Kein globaler Zustand (kein webpush.setVapidDetails): die Details
    // werden je Aufruf übergeben, damit mehrere Instanzen/Umgebungen im
    // selben Prozess (Tests) sich nicht gegenseitig beeinflussen.
    this.vapidDetails = { ...vapid };
    this.appEnv = options.appEnv ?? 'production';
  }

  async send(target: PushSubscriptionTarget, payload: PushPayload): Promise<PushSendOutcome> {
    const blocked = checkPushEndpoint(target.endpoint, this.appEnv);
    if (blocked !== null) return { outcome: 'permanent_error', code: blocked };
    try {
      const result = await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(payload),
        { TTL: PUSH_TTL_SECONDS, vapidDetails: this.vapidDetails, contentEncoding: 'aes128gcm' },
      );
      return outcomeFromStatusCode(result.statusCode);
    } catch (error) {
      const statusCode = (error as WebPushErrorLike | null)?.statusCode;
      if (typeof statusCode === 'number') return outcomeFromStatusCode(statusCode);
      // Netz-/DNS-/TLS-Fehler: transient; die Fehlermeldung (kann den
      // Endpoint enthalten) wird bewusst NICHT weitergegeben.
      return { outcome: 'transient_error', code: 'NETWORK' };
    }
  }
}

export type FakePushBehaviour = 'sent' | 'gone' | 'transient' | 'permanent';

export interface FakePushRecord {
  endpoint: string;
  payload: PushPayload;
  outcome: PushSendOutcome;
  at: Date;
}

/** Contract-Fake (Order §41): zeichnet Sendungen auf, Verhalten je Endpoint steuerbar. */
export class FakePushGateway implements PushGateway {
  readonly kind = 'fake' as const;
  readonly sent: FakePushRecord[] = [];
  private readonly behaviours = new Map<string, FakePushBehaviour>();
  private defaultBehaviour: FakePushBehaviour = 'sent';

  setBehaviour(endpoint: string, behaviour: FakePushBehaviour): void {
    this.behaviours.set(endpoint, behaviour);
  }

  setDefaultBehaviour(behaviour: FakePushBehaviour): void {
    this.defaultBehaviour = behaviour;
  }

  reset(): void {
    this.sent.length = 0;
    this.behaviours.clear();
    this.defaultBehaviour = 'sent';
  }

  /** Sendungen an einen Endpoint (Reihenfolge = Versandreihenfolge). */
  forEndpoint(endpoint: string): FakePushRecord[] {
    return this.sent.filter((record) => record.endpoint === endpoint);
  }

  async send(target: PushSubscriptionTarget, payload: PushPayload): Promise<PushSendOutcome> {
    const behaviour = this.behaviours.get(target.endpoint) ?? this.defaultBehaviour;
    const outcome: PushSendOutcome =
      behaviour === 'sent'
        ? { outcome: 'sent' }
        : behaviour === 'gone'
          ? { outcome: 'gone' }
          : behaviour === 'transient'
            ? { outcome: 'transient_error', code: 'HTTP_503' }
            : { outcome: 'permanent_error', code: 'HTTP_400' };
    this.sent.push({ endpoint: target.endpoint, payload, outcome, at: new Date() });
    return outcome;
  }
}

/** Ohne VAPID-Konfiguration: nichts wird gesendet, Zustellungen enden als failed (NOT_CONFIGURED). */
export class DisabledPushGateway implements PushGateway {
  readonly kind = 'disabled' as const;

  async send(): Promise<PushSendOutcome> {
    return { outcome: 'permanent_error', code: 'PUSH_NOT_CONFIGURED' };
  }
}

/**
 * Auswahl nach Konfiguration: push.enabled (alle drei PUSH_VAPID_*-Werte)
 * ⇒ echter Web-Push, sonst Disabled. Der Fake wird hier NIE gewählt –
 * er ist reine Test-Injection (buildApp lehnt ihn in production ab).
 */
export function createPushGateway(config: AppConfig): PushGateway {
  const push = config.push;
  if (
    push.enabled &&
    push.vapidPublicKey !== null &&
    push.vapidPrivateKey !== null &&
    push.vapidSubject !== null
  ) {
    return new WebPushGateway(
      {
        subject: push.vapidSubject,
        publicKey: push.vapidPublicKey,
        privateKey: push.vapidPrivateKey,
      },
      { appEnv: config.appEnv },
    );
  }
  return new DisabledPushGateway();
}
