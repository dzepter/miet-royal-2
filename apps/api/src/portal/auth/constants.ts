/**
 * Phase 15 (Kundenportal, AUTH): feste Zeitkonstanten der Portal-Authentifizierung.
 * Quelle: Auftrag §6 (Magic Link 15 min), §8 (Session absolut 30 Tage, kein
 * Sliding), §32 (Reauth-Frische 15 min).
 */
export const PORTAL_MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
export const PORTAL_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const PORTAL_REAUTH_FRESH_MS = 15 * 60 * 1000;
/** `last_seen_at` wird höchstens einmal je Minute geschrieben (Diagnostik, nie Verlängerung). */
export const PORTAL_LAST_SEEN_THROTTLE_MS = 60 * 1000;
/** Gültigkeit in Minuten für den Mailtext (Kontext `validMinutes`). */
export const PORTAL_MAGIC_LINK_VALID_MINUTES = PORTAL_MAGIC_LINK_TTL_MS / 60_000;

/** Reauth gilt als frisch, wenn `reauthenticatedAt` höchstens 15 Minuten zurückliegt. */
export function isReauthFresh(reauthenticatedAt: Date, now: Date): boolean {
  return now.getTime() - reauthenticatedAt.getTime() <= PORTAL_REAUTH_FRESH_MS;
}

// Phase 15 (Review R4): DB-basierte Versanddrossel – unabhängig von IP und
// X-Forwarded-For (zweite Verteidigungslinie hinter den IP-Rate-Limits der Route).
// Wurden im Fenster bereits so viele Links erzeugt (Login/E-Mail-Wechsel je Kunde,
// Reauth je Session), entsteht still KEIN weiterer Link (kein Widerruf, keine Mail);
// die öffentliche Antwort bleibt unverändert neutral.
export const PORTAL_LINK_THROTTLE_MAX = 5;
export const PORTAL_LINK_THROTTLE_WINDOW_MS = 15 * 60 * 1000;
