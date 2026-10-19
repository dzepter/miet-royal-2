/**
 * Anzeigezustand „Push auf diesem Gerät“ (Phase 12 Finalisierung, bestätigte
 * Entscheidung): Die bewusste Entscheidung ist die Browserberechtigung –
 * Miet-Royal selbst bietet KEIN Ausschalten/Abmelden/Pausieren an.
 *
 * Reine Funktion ohne Browser-/DOM-Zugriff (unit-getestet in
 * apps/api/test/communication-push-final.integration.test.ts, P4); die
 * Einstellungsseite rendert ausschließlich diesen Zustand.
 */

export type PushPermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

export interface PushStateInput {
  supported: boolean;
  permission: PushPermissionState;
  /** Server-seitig konfiguriert (VAPID). */
  serverEnabled: boolean;
  /** Dieses Gerät hat eine aktive Subscription, die der Server kennt. */
  active: boolean;
}

export const PUSH_ENABLE_LABEL = 'Push-Benachrichtigungen aktivieren';
export const PUSH_DENIED_TEXT = 'Push ist auf diesem Gerät im Browser nicht aktiviert.';
export const PUSH_ACTIVE_TEXT = 'Push ist auf diesem Gerät aktiv.';
export const PUSH_UNSUPPORTED_TEXT = 'Dieser Browser unterstützt keine Push-Benachrichtigungen.';
export const PUSH_SERVER_DISABLED_TEXT = 'Push ist auf diesem Server nicht konfiguriert.';

export type PushViewState =
  | { kind: 'loading' }
  | { kind: 'unsupported'; text: string }
  | { kind: 'denied'; text: string }
  | { kind: 'server_disabled'; text: string }
  | { kind: 'active'; text: string }
  | { kind: 'inactive'; actionLabel: string };

/**
 * Reihenfolge: nicht unterstützt → im Browser abgelehnt (Notification.permission
 * === 'denied') → Server nicht konfiguriert → aktiv → aktivierbar. Es gibt
 * keinen Zustand mit einer Ausschalt-Aktion.
 */
export function derivePushViewState(status: PushStateInput | null): PushViewState {
  if (status === null) return { kind: 'loading' };
  if (!status.supported || status.permission === 'unsupported') {
    return { kind: 'unsupported', text: PUSH_UNSUPPORTED_TEXT };
  }
  if (status.permission === 'denied') return { kind: 'denied', text: PUSH_DENIED_TEXT };
  if (!status.serverEnabled) return { kind: 'server_disabled', text: PUSH_SERVER_DISABLED_TEXT };
  if (status.active) return { kind: 'active', text: PUSH_ACTIVE_TEXT };
  return { kind: 'inactive', actionLabel: PUSH_ENABLE_LABEL };
}
