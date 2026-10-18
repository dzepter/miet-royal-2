/**
 * Demo-Whitelist (Phase 12, Order §§5/39): In APP_ENV=demo verlässt eine
 * E-Mail das System nur, wenn der Empfänger freigegeben ist – als
 * vollständige Adresse oder als `@domain`-Eintrag (ganze Domain). Vergleich
 * immer kleingeschrieben; Teilstrings zählen nicht (`@example.com` erlaubt
 * NICHT `x@notexample.com`).
 */
export function isDemoWhitelisted(email: string, whitelist: readonly string[]): boolean {
  const address = email.trim().toLowerCase();
  if (address === '' || !address.includes('@')) return false;
  const domain = address.slice(address.lastIndexOf('@'));
  for (const entry of whitelist) {
    const normalized = entry.trim().toLowerCase();
    if (normalized === '') continue;
    if (normalized.startsWith('@')) {
      if (domain === normalized) return true;
    } else if (normalized === address) {
      return true;
    }
  }
  return false;
}
