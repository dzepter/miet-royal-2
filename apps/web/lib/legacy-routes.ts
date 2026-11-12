/**
 * Phase 17 (WEB-ROUTES, Design D4/D5): Alt-URLs der bisherigen WordPress-Website
 * (docs/WEBSITE_MIGRATION_NOTES.md §2a/§2b; nur lesende Verifikation der Alt-Seite vom
 * 12.11.2026) – reine Funktionen ohne Next-Imports (node --test). Verbindliche Tabelle:
 * docs/REDIRECT_MATRIX.md (Konsistenztest `redirect-matrix.test.ts`). Umsetzung im Proxy
 * `apps/web/proxy.ts`.
 *
 * Regeln:
 * - Projektweit EIN Verfahren: permanenter Redirect 308 in genau EINEM Hop. Nexts eigener
 *   Trailing-Slash-Redirect ist abgeschaltet (`skipTrailingSlashRedirect`), sonst entstünde die
 *   Kette `/uber-uns/` → `/uber-uns` → `/ueber-uns`; hier werden Legacy-Ziel und Schluss-Slash
 *   in einem Schritt entschieden.
 * - Beide Schreibweisen treffen dieselbe Regel (mit/ohne Schluss-Slash, Groß-/Kleinschreibung) –
 *   die Alt-Seite leitete Pfade ohne Slash per 301 auf die Slash-Variante, Links existieren
 *   daher in beiden Formen.
 * - Query bei Legacy-Redirects VERWORFEN (kein Open Redirect über `?next=`), bei reiner
 *   Slash-Normalisierung behalten (nur sichtbares ASCII, nie Zeilenumbrüche).
 * - Entscheidungs-Location IMMER relativ (`/ziel`), nie aus Host-/Forwarded-Headern gebaut. Der
 *   Proxy löst sie gegen die eigene Server-URL auf (Nexts Adapter verlangt eine absolute URL und
 *   relativiert same-origin-Ziele wieder) – der Client erhält `Location: /ziel`.
 * - Nur „sichere“ Pfade (SAFE_PATH) werden behandelt. `//`, `\`, `%`, `:`, `?`, `#` ⇒ keine
 *   Entscheidung: Next normalisiert Mehrfach-Slashes/Backslashes selbst (308 auf den bereinigten
 *   Pfad), alles andere wird 404.
 * - 410 nur für exakte Pfade (Unterpfade wie `/shop/x` ⇒ keine Entscheidung ⇒ 404 der Website).
 */

export interface LegacyRedirect {
  /** Alt-Pfad: lowercase, ohne Schluss-Slash. */
  readonly from: string;
  /** Ziel: relativer Pfad einer bestehenden Route der neuen Website. */
  readonly to: string;
  readonly reason: string;
}

export interface LegacyGone {
  /** Alt-Pfad: lowercase, ohne Schluss-Slash. */
  readonly path: string;
  readonly reason: string;
}

/** Permanente Redirects (308) – Auftrag §6 plus Legacy-Verifikation (`/my-bookings`, Sitemap-Index). */
export const LEGACY_REDIRECTS: ReadonlyArray<LegacyRedirect> = [
  {
    from: '/maschinen-zubehoer',
    to: '/slushmaschine-mieten',
    reason:
      'Alte Produktübersicht „Maschinen & Zubehör“ (indexiert, Produkt-Intention) ⇒ neue Slush-Seite.',
  },
  {
    from: '/buchung',
    to: '/konfigurator',
    reason:
      'Alte Anfrage-/Buchungsseite (Ziel des Header-Buttons der Alt-Seite) ⇒ Konfigurator mit unverbindlicher Anfrage.',
  },
  {
    from: '/uber-uns',
    to: '/ueber-uns',
    reason: 'Gleiche Seite, neue Schreibweise mit „ue“.',
  },
  {
    from: '/kontaktformular',
    to: '/kontakt',
    reason: 'Alte Kontaktseite mit Formular ⇒ neue Kontaktseite (ohne exakte Abholadresse).',
  },
  {
    from: '/metform-form/contact-form',
    to: '/kontakt',
    reason:
      'Technische Formularvorlage des MetForm-Plugins (kein eigener Inhalt, aber indexiert und in der Alt-Sitemap) – gleiche Intention wie Kontakt.',
  },
  {
    from: '/book-appointment',
    to: '/konfigurator',
    reason:
      'BookingPress-Terminseite (nur roher Shortcode) – Intention „Termin anfragen“ ⇒ Konfigurator.',
  },
  {
    from: '/mein-konto',
    to: '/konto',
    reason: 'WooCommerce-Login (ungenutzt) – Intention „Konto“ ⇒ Kundenbereich (Auftrag §6).',
  },
  {
    from: '/my-bookings',
    to: '/konto',
    reason:
      'BookingPress „Meine Buchungen“ (roher Shortcode) – Auftrag §7 nimmt den Pfad bewusst aus 410 heraus ⇒ Kundenbereich.',
  },
  {
    from: '/sitemap_index.xml',
    to: '/sitemap.xml',
    reason:
      'Rank-Math-Sitemap-Index der Alt-Seite (in deren robots.txt referenziert) ⇒ neue Sitemap, damit Suchmaschinen sie finden.',
  },
];

/** HTTP 410 Gone – Auftrag §7 (alle 12 verifiziert) plus weitere WordPress-Reste aus der Legacy-Verifikation. */
export const LEGACY_GONE: ReadonlyArray<LegacyGone> = [
  {
    path: '/shop',
    reason: 'WooCommerce-Shoparchiv ohne Produkte („Es wurden keine Produkte gefunden“).',
  },
  { path: '/warenkorb', reason: 'Leerer WooCommerce-Warenkorb (noindex).' },
  { path: '/kasse', reason: 'WooCommerce-Kasse (leitete per 302 auf den leeren Warenkorb).' },
  { path: '/hello-world', reason: 'WordPress-Standardbeitrag inkl. Standardkommentar.' },
  { path: '/category/uncategorized', reason: 'Kategorie-Archiv des WordPress-Standardbeitrags.' },
  { path: '/sample-page', reason: 'WordPress-Beispielseite (englischer Platzhaltertext).' },
  { path: '/thank-you', reason: 'BookingPress-Dankeseite mit rohen Shortcodes.' },
  {
    path: '/cancel-appointment',
    reason:
      'BookingPress-Stornoseite (englischer Plugin-Standardtext) – verifiziert 12.11.2026: index/follow, kein Inhalt.',
  },
  {
    path: '/cancel-payment',
    reason:
      'BookingPress „Zahlung fehlgeschlagen“ (englischer Plugin-Standardtext) – verifiziert 12.11.2026.',
  },
  {
    path: '/appointment-cancellation-confirmation',
    reason: 'BookingPress-Stornobestätigung (nur roher Shortcode) – verifiziert 12.11.2026.',
  },
  {
    path: '/appointment-reschedule',
    reason: 'BookingPress-Terminverschiebung (nur roher Shortcode) – verifiziert 12.11.2026.',
  },
  {
    path: '/bookingpress-complete-payment',
    reason: 'BookingPress-Zahlungsabschluss (nur roher Shortcode) – verifiziert 12.11.2026.',
  },
  { path: '/feed', reason: 'RSS-Feed der Alt-Seite (es gab keinen Blog).' },
  { path: '/comments/feed', reason: 'Kommentar-Feed der Alt-Seite.' },
  {
    path: '/author/techremedys',
    reason: 'Autorenarchiv der Agentur-/Autorenkennung (nicht in der Alt-Sitemap).',
  },
  { path: '/page/2', reason: 'Paginierungsrest der statischen Startseite der Alt-Seite.' },
  {
    path: '/post-sitemap.xml',
    reason:
      'Rank-Math-Unter-Sitemap der Alt-Seite – nicht umleiten, neue Sitemap nur unter /sitemap.xml.',
  },
  {
    path: '/page-sitemap.xml',
    reason:
      'Rank-Math-Unter-Sitemap der Alt-Seite – nicht umleiten, neue Sitemap nur unter /sitemap.xml.',
  },
  {
    path: '/metform-form-sitemap.xml',
    reason:
      'Rank-Math-Unter-Sitemap der Alt-Seite – nicht umleiten, neue Sitemap nur unter /sitemap.xml.',
  },
  {
    path: '/category-sitemap.xml',
    reason:
      'Rank-Math-Unter-Sitemap der Alt-Seite – nicht umleiten, neue Sitemap nur unter /sitemap.xml.',
  },
];

/**
 * „Sicherer“ Pfad: Segmente aus unreservierten URL-Zeichen, höchstens EIN Schluss-Slash.
 * Kein `//` (auch nicht am Ende), `\`, `%`, `:`, `?`, `#`, Leer- oder Steuerzeichen.
 */
export const SAFE_PATH = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?$/;

/** Cache-Dauer der Legacy-308-Antworten (Tabellen-Redirects: rein URL-abhängig, öffentliche Alt-URLs). */
export const REDIRECT_CACHE_CONTROL = 'public, max-age=3600';
/**
 * Slash-Normalisierungen werden NICHT geteilt gecacht (Review RD-2/RB-2): sie treffen auch
 * Token-/Portal-/Vorschau-Pfade (`/angebot/<token>/`, `/konto/…/`), deren `headers()`-Regel
 * `private, no-store` der Proxy sonst überschriebe – Token-URL und Location gehörten dann eine
 * Stunde in Shared Caches. Der Nutzen eines Caches ist hier null (seltene Alt-Links).
 */
export const SLASH_REDIRECT_CACHE_CONTROL = 'private, no-store';

/** Antwort-Header der 410-Seite (Header-Namen lowercase). */
export const GONE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'public, max-age=3600',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});

export type LegacyRouteDecision =
  | { readonly kind: 'redirect'; readonly location: string; readonly cacheControl: string }
  | { readonly kind: 'gone' }
  | { readonly kind: 'none' };

const NONE: LegacyRouteDecision = { kind: 'none' };
const GONE: LegacyRouteDecision = { kind: 'gone' };

const GONE_PATHS: ReadonlySet<string> = new Set(LEGACY_GONE.map((entry) => entry.path));
const REDIRECT_TARGETS: ReadonlyMap<string, string> = new Map(
  LEGACY_REDIRECTS.map((entry) => [entry.from, entry.to]),
);

/** Relativ = genau ein führender `/`, danach weder `/` noch `\`; nie CR/LF (Header-Injection). */
export function isRelativeLocation(location: string): boolean {
  return /^\/(?![/\\])/.test(location) && !/[\r\n]/.test(location);
}

/** Query nur übernehmen, wenn sie mit `?` beginnt und ausschließlich sichtbares ASCII enthält. */
function keptSearch(search: string): string {
  if (search === '') return '';
  return /^\?[\x21-\x7e]*$/.test(search) ? search : '';
}

function redirectTo(location: string, cacheControl: string): LegacyRouteDecision {
  return isRelativeLocation(location) ? { kind: 'redirect', location, cacheControl } : NONE;
}

/**
 * Entscheidung für einen Request-Pfad (`request.nextUrl.pathname`) mit Query (`nextUrl.search`,
 * `''` oder `?…`):
 * (a) `/` oder nicht SAFE ⇒ none; (b) normalisiert = lowercase + Schluss-Slash entfernt;
 * (c) exakt in LEGACY_GONE ⇒ gone; (d) exakt in LEGACY_REDIRECTS ⇒ redirect auf `to`, Query
 * verworfen, `cache-control` öffentlich 1 h; (e) Pfad endete mit `/` ⇒ redirect auf den Pfad ohne
 * Schluss-Slash in Original-Schreibweise plus Query, `cache-control: private, no-store`; (f) sonst none.
 */
export function decideLegacyRoute(pathname: string, search: string): LegacyRouteDecision {
  if (pathname === '/' || !SAFE_PATH.test(pathname)) return NONE;
  const trimmed = pathname.replace(/\/+$/, '');
  const normalized = trimmed.toLowerCase();
  if (GONE_PATHS.has(normalized)) return GONE;
  const target = REDIRECT_TARGETS.get(normalized);
  if (target !== undefined) return redirectTo(target, REDIRECT_CACHE_CONTROL);
  if (trimmed !== pathname) {
    return redirectTo(`${trimmed}${keptSearch(search)}`, SLASH_REDIRECT_CACHE_CONTROL);
  }
  return NONE;
}

export const GONE_TITLE = 'Diese Seite gibt es nicht mehr – Miet-Royal';
export const GONE_HEADLINE = 'Diese Seite gibt es nicht mehr.';

/*
 * Eigenständiges Dokument im Website-Look (Tokens aus components/site/site.module.css: Creme
 * #FFFCF2, Text #1C1712, Sekundärtext #4D4237, Bronze #7B5426/#6A4720, Linie #E9DCC0; Serifen-
 * Überschrift, Systemschrift, Fokus 3 px, Touchflächen ≥ 44 px). CSS Modules und der SiteFrame
 * stehen in einer Proxy-Antwort nicht zur Verfügung; ein Rewrite auf eine Seite könnte den Status
 * 410 nicht setzen. Kein Script, keine externen Ressourcen, keine Adresse, keine technischen Codes.
 */
const GONE_HTML = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${GONE_TITLE}</title>
<style>
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:#fffcf2;color:#1c1712;font:1.0625rem/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif}
:focus-visible{outline:3px solid #7b5426;outline-offset:3px;border-radius:4px}
a{color:#7b5426;text-underline-offset:.18em}
a:hover{color:#6a4720}
header{padding:.75rem clamp(1rem,4vw,2rem);border-bottom:1px solid #e9dcc0}
.brand{display:inline-flex;align-items:center;min-height:44px;color:#1c1712;font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif;font-size:1.25rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;text-decoration:none}
main{flex:1;width:100%;max-width:46rem;margin:0 auto;padding:clamp(3rem,10vw,6rem) clamp(1rem,4vw,2rem)}
.eyebrow{margin:0 0 .6rem;color:#7b5426;font-size:.82rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
h1{margin:0;font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif;font-size:clamp(2.1rem,6vw,3.4rem);font-weight:600;line-height:1.12;overflow-wrap:anywhere}
.lead{max-width:40rem;margin:1rem 0 0;color:#4d4237;font-size:clamp(1.1rem,2.6vw,1.3rem);line-height:1.55}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;margin:1.75rem 0 0}
.button{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:.7rem 1.4rem;border:2px solid #7b5426;border-radius:999px;background:#7b5426;color:#fff;font-weight:650;line-height:1.2;text-decoration:none}
.button:hover{border-color:#6a4720;background:#6a4720}
nav ul{display:flex;flex-wrap:wrap;gap:.25rem 1.5rem;margin:2rem 0 0;padding:0;list-style:none}
nav a{display:inline-flex;align-items:center;min-height:44px;font-weight:650}
</style>
</head>
<body>
<header><a class="brand" href="/">Miet-Royal</a></header>
<main id="inhalt">
<p class="eyebrow">Nicht mehr verfügbar</p>
<h1>${GONE_HEADLINE}</h1>
<p class="lead">Unsere Website ist umgezogen, und diese Adresse haben wir dabei bewusst entfernt. Alles rund um unsere Slushmaschinen findest du auf den neuen Seiten.</p>
<p class="actions"><a class="button" href="/konfigurator">Slush konfigurieren</a></p>
<nav aria-label="Weiter auf der Website"><ul>
<li><a href="/">Zur Startseite</a></li>
<li><a href="/slushmaschine-mieten">Slushmaschine mieten</a></li>
<li><a href="/kontakt">Kontakt</a></li>
</ul></nav>
</main>
</body>
</html>
`;

/** HTML der 410-Seite (konstant; der Proxy liefert es mit Status 410 und GONE_HEADERS). */
export function goneHtml(): string {
  return GONE_HTML;
}
