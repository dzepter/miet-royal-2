import { isIP } from 'node:net';
import type { AppEnvironment } from '@mietroyal/config';

/**
 * Phase 12 Härtung (Review B, B10): Push-Endpoints sind frei vom Browser
 * gelieferte URLs, an die der Server (push.send) Verbindungen aufbaut – ohne
 * Prüfung ein SSRF-/Port-Scan-Kanal ins interne Netz (Cloud-Metadaten,
 * Datenbank, Admin-Oberflächen).
 *
 * Regel (eine Implementierung für Route UND WebPushGateway):
 * - überall: https, keine Zugangsdaten in der URL;
 * - production/staging/demo: Host MUSS ein bekannter Push-Dienst sein
 *   (Allowlist unten), Standardport 443, keine IP-Literale (damit auch keine
 *   privaten/Loopback-/Link-local-Adressen);
 * - development: keine weitere Einschränkung (lokale Fakes, z. B. der
 *   E2E-Push-Dienst unter https://localhost:<port>).
 *
 * Quelle der Hosts: die Push-Dienste der verbreiteten Browser (Chrome/Edge-
 * Chromium über FCM, Firefox über Mozilla autopush, Safari über Apple, alte
 * Edge-/Windows-Clients über WNS). NICHT amtlich verifiziert –
 * phase12_push_ics_verification.md (RFC 8030/8292/8291, MDN) nennt keine
 * Hostnamen. Lehnt ein neuer Browser ab („Dieser Push-Dienst wird nicht
 * unterstützt“), muss sein Host hier ergänzt werden.
 */
export const KNOWN_PUSH_SERVICE_HOSTS: readonly string[] = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
];
/** Subdomains (z. B. `wns2-…notify.windows.com`, `…push.apple.com`). */
export const KNOWN_PUSH_SERVICE_HOST_SUFFIXES: readonly string[] = [
  '.notify.windows.com',
  '.push.apple.com',
];

export const PUSH_ENDPOINT_NOT_ALLOWED = 'ENDPOINT_NOT_ALLOWED';

function isKnownPushHost(hostname: string): boolean {
  if (KNOWN_PUSH_SERVICE_HOSTS.includes(hostname)) return true;
  return KNOWN_PUSH_SERVICE_HOST_SUFFIXES.some(
    (suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length,
  );
}

/** IPv4/IPv6-Literal (URL-Hostnamen von IPv6 stehen in eckigen Klammern). */
function isIpLiteral(hostname: string): boolean {
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return isIP(bare) !== 0;
}

/** null ⇒ erlaubt; sonst neutraler Code (Endpoint nie loggen – Capability-URL). */
export function checkPushEndpoint(endpoint: string, appEnv: AppEnvironment): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return PUSH_ENDPOINT_NOT_ALLOWED;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return PUSH_ENDPOINT_NOT_ALLOWED;
  }
  if (appEnv === 'development') return null;
  const hostname = url.hostname.toLowerCase();
  if (isIpLiteral(hostname)) return PUSH_ENDPOINT_NOT_ALLOWED;
  if (url.port !== '' && url.port !== '443') return PUSH_ENDPOINT_NOT_ALLOWED;
  return isKnownPushHost(hostname) ? null : PUSH_ENDPOINT_NOT_ALLOWED;
}
