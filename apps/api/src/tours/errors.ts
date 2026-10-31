import { AuthError, type AuthErrorCode } from '../auth/service.ts';

/**
 * Phase 13 (Touren): fachliche Tour-Fehler mit eigenem, stabilem Code für
 * die UI (z. B. TOUR_VERSION_CONFLICT, APPOINTMENT_ASSIGNED_ELSEWHERE);
 * der HTTP-Status folgt dem AuthError-Code (409/400/403/404).
 */
export class TourError extends AuthError {
  constructor(
    code: AuthErrorCode,
    readonly tourCode: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code, message);
    this.name = 'TourError';
  }
}

export const TOUR_MESSAGES = {
  ROUTING_UNAVAILABLE: 'Route konnte gerade nicht berechnet werden.',
  ROUTING_DISABLED: 'Routing ist nicht konfiguriert.',
  OPEN_STOPS: 'Die Tour enthält noch offene Stopps.',
  ADDRESS_MISSING: 'Adresse fehlt – Route nicht berechenbar.',
  DEPOT_MISSING: 'Depotadresse ist noch nicht vollständig hinterlegt.',
} as const;
