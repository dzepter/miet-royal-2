import { AuthError } from '../auth/service.ts';

/**
 * Phase 15 (Kundenportal): gemeinsame Typen der Portal-Grenze.
 *
 * Der Kunde bleibt die Identität (Order §3): jede Portal-Anfrage wird
 * serverseitig über die Session auf GENAU einen `customers.id` abgebildet; der
 * Client sendet nie eine Kunden-ID als Autorität (Order §12).
 */

/** Serverseitiger Kontext einer gültigen Portal-Session (nie an den Client serialisieren). */
export interface PortalSessionContext {
  sessionId: string;
  customerId: string;
  createdAt: Date;
  /** Absolutes Ende (created_at + 30 Tage) – kein Sliding Window (Order §8). */
  expiresAt: Date;
  authenticatedAt: Date;
  /** Letzte bestätigte Anmeldung/Reauth; Profilmutationen verlangen ≤ 15 min (Order §32). */
  reauthenticatedAt: Date;
}

/** Fehlercodes der Portal-Grenze (HTTP-Status über `authErrorStatus`). */
export type PortalErrorCode =
  | 'PORTAL_UNAUTHENTICATED'
  | 'PORTAL_REAUTH_REQUIRED'
  | 'PORTAL_TOKEN_INVALID'
  | 'PORTAL_EMAIL_UNAVAILABLE'
  | 'PORTAL_BOOKING_CLOSED'
  | 'PORTAL_CANCELLATION_BLOCKED'
  // Phase 15 (Review R2): Gebühr zwischen Vorschau und Bestätigung geändert (z. B. Berliner Mitternacht).
  | 'PORTAL_CANCELLATION_FEE_CHANGED'
  | 'PORTAL_PHOTO_REJECTED'
  | 'PORTAL_MAIL_UNAVAILABLE';

/**
 * Portal-Fehler: `code` steuert den HTTP-Status (wie AuthError), `portalCode`
 * ist der stabile Fachcode für das Web-Frontend. Die Nachricht ist kundentauglich
 * (deutsch, „du“) und enthält NIE interne Blocker, IDs oder Provider-Details.
 */
export class PortalError extends AuthError {
  constructor(
    code: AuthError['code'],
    readonly portalCode: PortalErrorCode,
    message: string,
  ) {
    super(code, message);
    this.name = 'PortalError';
  }
}

/** Kundentexte, die an mehreren Stellen (API, Tests, Doku) identisch sein müssen. */
export const PORTAL_MESSAGES = {
  /** Öffentliche Antwort auf JEDE Magic-Link-Anforderung (Order §4). */
  MAGIC_LINK_REQUESTED:
    'Wenn die E-Mail-Adresse bei uns hinterlegt ist, erhältst du gleich einen Anmeldelink.',
  TOKEN_INVALID: 'Dieser Anmeldelink ist ungültig oder abgelaufen. Bitte fordere einen neuen an.',
  UNAUTHENTICATED: 'Bitte melde dich an, um deinen Kundenbereich zu öffnen.',
  REAUTH_REQUIRED:
    'Bitte bestätige diese Änderung zuerst über den Link, den wir dir per E-Mail schicken.',
  CANCELLATION_BLOCKED:
    'Diese Buchung kann nicht mehr online storniert werden. Bitte kontaktiere uns.',
  BOOKING_CLOSED: 'Zu dieser Buchung können keine neuen Nachrichten mehr gesendet werden.',
  PROFILE_HINT:
    'Änderungen gelten für zukünftige Anfragen. Deine bereits bestätigte Buchung bleibt unverändert.',
  EMAIL_CHANGED: 'E-Mail-Adresse geändert. Bitte melde dich mit deiner neuen Adresse erneut an.',
  EMAIL_UNAVAILABLE: 'Diese E-Mail-Adresse kann nicht verwendet werden.',
  /** Phase 15 (Review R2): Bestätigung an den gezeigten Betrag gebunden. */
  CANCELLATION_FEE_CHANGED:
    'Die Stornogebühr hat sich inzwischen geändert. Bitte prüfe den neuen Betrag und bestätige erneut.',
  /** Phase 15 (Review R8): neutrale Antwort auf jede E-Mail-Wechsel-Anforderung (keine Enumeration). */
  EMAIL_CHANGE_REQUESTED:
    'Wenn die Adresse verwendet werden kann, erhältst du dort gleich einen Bestätigungslink.',
} as const;
