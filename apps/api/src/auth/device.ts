/**
 * Grober Gerätename aus dem User-Agent – bewusst nur zur Wiedererkennung
 * in der Geräteübersicht, KEIN Fingerprinting (Phase-1-Vorgabe Nr. 7).
 */
export function deviceLabelFromUserAgent(userAgent: string | undefined): string {
  if (userAgent === undefined || userAgent.trim() === '') return 'Unbekanntes Gerät';

  const ua = userAgent.toLowerCase();
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
  else if (ua.includes('opr/') || ua.includes('opera')) browser = 'Opera';
  else if (ua.includes('chrome/') || ua.includes('crios/')) browser = 'Chrome';
  else if (ua.includes('firefox/') || ua.includes('fxios/')) browser = 'Firefox';
  else if (ua.includes('safari/')) browser = 'Safari';

  return `${system} · ${browser}`;
}
