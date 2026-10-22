'use client';

import { apiFetch } from './api';
import { createPushRebindScheduler, type PushRebindResult } from './push-rebind';
import { PUSH_DENIED_TEXT, type PushStateInput } from './push-state';

/**
 * Web Push im Browser (Phase 12, Order §29): Registrierung NUR nach
 * bewusster Benutzeraktion (`subscribe()` im Klick-Handler ruft
 * Notification.requestPermission). Der Server erhält Endpoint + Schlüssel
 * genau einmal (POST) und gibt sie nie wieder heraus.
 * Phase 12 Finalisierung: kein Push-Opt-out in Miet-Royal – es gibt keine
 * Funktion zum Abmelden/Ausschalten; die Entscheidung trifft der Browser
 * (Berechtigung). Hat der Browser die Subscription verloren, zeigt der
 * Status wieder „aktivieren“ (erneute Registrierung reaktiviert serverseitig).
 */

export type PushStatus = PushStateInput;

export interface PushDevice {
  id: string;
  userAgentLabel: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
  currentSession: boolean;
}

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** VAPID-Public-Key (base64url) → Uint8Array für pushManager.subscribe. */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/** Grobes Gerätelabel (max. 120 Zeichen) – kein Fingerprinting. */
export function deviceLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent.toLowerCase();
  let system = 'Unbekanntes System';
  if (ua.includes('iphone')) system = 'iPhone';
  else if (ua.includes('ipad')) system = 'iPad';
  else if (ua.includes('android'))
    system = ua.includes('mobile') ? 'Android-Handy' : 'Android-Tablet';
  else if (ua.includes('windows')) system = 'Windows';
  else if (ua.includes('mac os') || ua.includes('macintosh')) system = 'Mac';
  else if (ua.includes('linux')) system = 'Linux';
  let browser = 'Browser';
  if (ua.includes('edg/')) browser = 'Edge';
  else if (ua.includes('chrome/') || ua.includes('crios/')) browser = 'Chrome';
  else if (ua.includes('firefox/') || ua.includes('fxios/')) browser = 'Firefox';
  else if (ua.includes('safari/')) browser = 'Safari';
  return `${system} · ${browser}`.slice(0, 120);
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  if (registration === undefined) return null;
  return registration.pushManager.getSubscription();
}

export async function fetchPushStatus(): Promise<PushStatus> {
  const supported = isPushSupported();
  const server = await apiFetch<{ enabled: boolean; publicKey: string | null }>(
    '/staff/push/vapid-public-key',
  );
  const serverEnabled = server.data?.enabled === true && server.data.publicKey !== null;
  if (!supported) return { supported, permission: 'unsupported', serverEnabled, active: false };
  const subscription = await currentSubscription();
  let active = false;
  if (subscription !== null) {
    const status = await apiFetch<{ active: boolean }>('/staff/push/subscriptions/status', {
      method: 'POST',
      body: { endpoint: subscription.endpoint },
    });
    active = status.data?.active === true;
  }
  return { supported, permission: Notification.permission, serverEnabled, active };
}

export async function fetchPushDevices(): Promise<PushDevice[]> {
  const result = await apiFetch<{ devices: PushDevice[] }>('/staff/push/subscriptions');
  return result.data?.devices ?? [];
}

export type SubscribeOutcome =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'denied' | 'server_disabled' | 'failed'; message: string };

/** Nur aus einem Klick-Handler aufrufen (Berechtigungsabfrage des Browsers). */
export async function subscribeToPush(): Promise<SubscribeOutcome> {
  if (!isPushSupported()) {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'Dieser Browser unterstützt keine Push-Benachrichtigungen.',
    };
  }
  const key = await apiFetch<{ enabled: boolean; publicKey: string | null }>(
    '/staff/push/vapid-public-key',
  );
  if (key.data?.enabled !== true || key.data.publicKey === null) {
    return {
      ok: false,
      reason: 'server_disabled',
      message: 'Push ist auf diesem Server nicht konfiguriert.',
    };
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return {
      ok: false,
      reason: 'denied',
      message: PUSH_DENIED_TEXT,
    };
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key.data.publicKey) as BufferSource,
      }));
    const json = subscription.toJSON();
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (typeof p256dh !== 'string' || typeof auth !== 'string') {
      return { ok: false, reason: 'failed', message: 'Die Push-Registrierung ist unvollständig.' };
    }
    const result = await apiFetch('/staff/push/subscriptions', {
      method: 'POST',
      body: {
        endpoint: subscription.endpoint,
        keys: { p256dh, auth },
        userAgentLabel: deviceLabel(),
      },
    });
    if (!result.ok) {
      return {
        ok: false,
        reason: 'failed',
        message: result.errorMessage ?? 'Die Registrierung konnte nicht gespeichert werden.',
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'failed', message: 'Push konnte nicht aktiviert werden.' };
  }
}

// Phase 12 Finalisierung (Punkt 4): automatisches Wiederanbinden ohne Prompt.

/** Ereignis nach erfolgreichem Wiederanbinden – die Einstellungsseite lädt den Status neu. */
export const PUSH_REBOUND_EVENT = 'mietroyal:push-rebound';

const pushRebind = createPushRebindScheduler();

/**
 * Einmal je App-Start mit gültiger Session (AuthGuard, Zustand „ready“):
 * vorhandene Browser-Subscription bei erteilter Berechtigung still erneut
 * registrieren (lib/push-rebind.ts). Kein Prompt, kein neues Abo, kein Log.
 */
export async function rebindPushOnAppStart(): Promise<PushRebindResult> {
  const result = await pushRebind.run(() => ({
    supported: isPushSupported(),
    online: typeof navigator === 'undefined' || navigator.onLine !== false,
    notification: { permission: isPushSupported() ? Notification.permission : 'default' },
    serviceWorker: {
      getRegistration: async () =>
        isPushSupported() ? navigator.serviceWorker.getRegistration() : undefined,
    },
    register: async (body) => {
      const response = await apiFetch('/staff/push/subscriptions', { method: 'POST', body });
      return { ok: response.ok };
    },
    userAgentLabel: deviceLabel,
  }));
  if (result === 'rebound' && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(PUSH_REBOUND_EVENT));
  }
  return result;
}

/** Nach erfolgreichem Login im selben Tab: nächster App-Start-Aufruf bindet erneut an. */
export function armPushRebindAfterLogin(): void {
  pushRebind.armAfterLogin();
}
