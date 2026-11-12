import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  GONE_HEADERS,
  REDIRECT_CACHE_CONTROL,
  decideLegacyRoute,
  goneHtml,
} from './lib/legacy-routes';

/**
 * Phase 17 (WEB-ROUTES, Design D4/D5): Alt-URL-Behandlung der Website in EINEM Hop –
 * Legacy-Redirect (308, Query verworfen), Legacy-410 (direkte HTML-Antwort) und
 * Trailing-Slash-Normalisierung (308, Query bleibt). Regeln und Listen: `lib/legacy-routes.ts`,
 * Tabelle: docs/REDIRECT_MATRIX.md. Setzt `skipTrailingSlashRedirect: true` (next.config.ts)
 * voraus, sonst liefe Nexts eigener Slash-Redirect vorher und erzeugte Ketten.
 *
 * Sicherheit: Das Ziel kommt ausschließlich aus `decideLegacyRoute` (relativer Pfad, genau ein
 * führender `/`) und wird NIE aus Host-/Forwarded-Headern gebaut (kein Open Redirect, kein
 * Host-Header-Vertrauen); der Client erhält eine relative Location. Kein Logging –
 * Pfade können Token enthalten (/kontakt/<token>, /angebot/<token>, /dokument/<token>).
 */
export function proxy(request: NextRequest) {
  const decision = decideLegacyRoute(request.nextUrl.pathname, request.nextUrl.search);
  if (decision.kind === 'gone') {
    return new NextResponse(goneHtml(), { status: 410, headers: GONE_HEADERS });
  }
  if (decision.kind === 'redirect') {
    // Nexts Node-Adapter verlangt im Location-Header eine ABSOLUTE URL (relativ ⇒ `TypeError: Invalid
    // URL` ⇒ 500, in Phase 17 am Production-Build belegt) und relativiert same-origin-Ziele danach
    // selbst, sodass der Client `Location: /ziel` erhält. Basis ist `request.nextUrl`: im
    // Node-Runtime die eigene Server-Adresse (hostname/port des Servers, `trustHostHeader` aus) –
    // NICHT der Host-/Forwarded-Header. Der Pfad stammt ausschließlich aus `decideLegacyRoute`
    // (relativ, genau ein führender `/`); ein Origin-Wechsel ist damit ausgeschlossen und wird
    // zusätzlich geprüft (sonst kein Redirect).
    const target = new URL(decision.location, request.nextUrl);
    if (target.origin !== request.nextUrl.origin) return NextResponse.next();
    return new NextResponse(null, {
      status: 308,
      headers: { location: target.href, 'cache-control': REDIRECT_CACHE_CONTROL },
    });
  }
  return NextResponse.next();
}

/**
 * Alles außer dem API-Rewrite (`/api/…`), Next-Assets (`/_next/…`) und den exakten Dateien
 * `favicon.ico`, `robots.txt`, `sitemap.xml`. Die Alt-Sitemaps (`/sitemap_index.xml`,
 * `/*-sitemap.xml`) bleiben absichtlich im Matcher (308 bzw. 410). Konstante – wird beim Build
 * statisch analysiert.
 */
export const config = {
  matcher: ['/((?!api/|_next/|favicon\\.ico$|robots\\.txt$|sitemap\\.xml$).*)'],
};
