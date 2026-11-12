import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  GONE_HEADERS,
  GONE_HEADLINE,
  GONE_TITLE,
  LEGACY_GONE,
  LEGACY_REDIRECTS,
  REDIRECT_CACHE_CONTROL,
  SAFE_PATH,
  decideLegacyRoute,
  goneHtml,
  isRelativeLocation,
} from './legacy-routes.ts';

/**
 * Phase 17 (WEB-ROUTES, Design D4/D5, Auftrag §6/§7/§28 R1–R6): Alt-URL-Entscheidung der
 * Website – permanente Redirects (308) in genau einem Hop, 410 für WordPress-Reste,
 * Trailing-Slash-Normalisierung, kein Open Redirect. Läuft mit `node --test`.
 * Die Alt-Seite leitete Pfade ohne Schluss-Slash per 301 auf die Slash-Variante; deshalb
 * werden hier immer BEIDE Schreibweisen (und Groß-/Kleinschreibung) geprüft.
 */

/** Ziele der neuen Website, die Legacy-Redirects verwenden dürfen (bestehende Routen). */
const APP_TARGETS: ReadonlySet<string> = new Set([
  '/',
  '/slushmaschine-mieten',
  '/konfigurator',
  '/ueber-uns',
  '/kontakt',
  '/konto',
  '/sitemap.xml',
]);

/** Auftrag §6 (plus `/my-bookings` aus §7 und der Sitemap-Index aus der Legacy-Verifikation). */
const ORDER_REDIRECTS: ReadonlyArray<readonly [string, string]> = [
  ['/maschinen-zubehoer', '/slushmaschine-mieten'],
  ['/buchung', '/konfigurator'],
  ['/uber-uns', '/ueber-uns'],
  ['/kontaktformular', '/kontakt'],
  ['/metform-form/contact-form', '/kontakt'],
  ['/book-appointment', '/konfigurator'],
  ['/mein-konto', '/konto'],
  ['/my-bookings', '/konto'],
  ['/sitemap_index.xml', '/sitemap.xml'],
];

/** Auftrag §7 (12 Pfade) plus die zusätzlichen WordPress-Reste der Legacy-Verifikation. */
const ORDER_GONE: ReadonlyArray<string> = [
  '/shop',
  '/warenkorb',
  '/kasse',
  '/hello-world',
  '/category/uncategorized',
  '/sample-page',
  '/thank-you',
  '/cancel-appointment',
  '/cancel-payment',
  '/appointment-cancellation-confirmation',
  '/appointment-reschedule',
  '/bookingpress-complete-payment',
  '/feed',
  '/comments/feed',
  '/author/techremedys',
  '/page/2',
  '/post-sitemap.xml',
  '/page-sitemap.xml',
  '/metform-form-sitemap.xml',
  '/category-sitemap.xml',
];

function kindOf(pathname: string, search = ''): string {
  return decideLegacyRoute(pathname, search).kind;
}

function redirect(pathname: string, search = ''): string {
  const decision = decideLegacyRoute(pathname, search);
  assert.equal(
    decision.kind,
    'redirect',
    `${pathname}${search}: redirect erwartet, war ${decision.kind}`,
  );
  return decision.kind === 'redirect' ? decision.location : '';
}

/** Schreibvarianten eines Alt-Pfads: mit/ohne Schluss-Slash, Versalien, erster Buchstabe groß. */
function variants(pathname: string): string[] {
  const upperFirst = pathname.replace(/^\/([a-z])/, (_m, c: string) => `/${c.toUpperCase()}`);
  const upper = pathname.toUpperCase();
  return [pathname, `${pathname}/`, upper, `${upper}/`, upperFirst, `${upperFirst}/`];
}

describe('Legacy-Routen: Redirects und 410 (Phase 17, SEO-R-U)', () => {
  it('SEO-R-U1. Jeder Legacy-Redirect trifft mit/ohne Schluss-Slash und in jeder Schreibweise ⇒ Ziel; Query wird verworfen', () => {
    for (const { from, to } of LEGACY_REDIRECTS) {
      for (const variant of variants(from)) {
        assert.equal(redirect(variant), to, variant);
        assert.equal(redirect(variant, '?utm_source=alt&next=https://evil.example/'), to, variant);
        assert.equal(redirect(variant, '?'), to, variant);
      }
    }
    for (const [from, to] of ORDER_REDIRECTS) {
      assert.equal(redirect(from), to, `Auftrag: ${from}`);
      assert.equal(redirect(`${from}/`), to, `Auftrag: ${from}/`);
    }
  });

  it('SEO-R-U2. Jeder 410-Pfad mit/ohne Schluss-Slash, in jeder Schreibweise und mit Query ⇒ gone', () => {
    for (const { path: gonePath } of LEGACY_GONE) {
      for (const variant of variants(gonePath)) {
        assert.equal(kindOf(variant), 'gone', variant);
        assert.equal(kindOf(variant, '?add-to-cart=1'), 'gone', variant);
      }
    }
    for (const gonePath of ORDER_GONE) {
      assert.equal(kindOf(gonePath), 'gone', `Auftrag: ${gonePath}`);
      assert.equal(kindOf(`${gonePath}/`), 'gone', `Auftrag: ${gonePath}/`);
    }
    // Auftrag §7: /my-bookings bewusst KEIN 410, sondern Redirect auf /konto.
    assert.equal(kindOf('/my-bookings/'), 'redirect');
  });

  it('SEO-R-U3. Keine Präfixregeln: Unterpfade von 410-/Redirect-Pfaden ⇒ none (bzw. nur Slash-Normalisierung)', () => {
    for (const { path: gonePath } of LEGACY_GONE) {
      assert.equal(kindOf(`${gonePath}/unterseite`), 'none', gonePath);
      assert.equal(redirect(`${gonePath}/unterseite/`), `${gonePath}/unterseite`, gonePath);
    }
    for (const { from } of LEGACY_REDIRECTS) {
      assert.equal(kindOf(`${from}/x`), 'none', from);
      assert.equal(redirect(`${from}/x/`), `${from}/x`, from);
    }
    assert.equal(kindOf('/shop/x'), 'none');
    assert.equal(kindOf('/shopping'), 'none');
    assert.equal(kindOf('/kassenbuch'), 'none');
    assert.equal(kindOf('/buchungen'), 'none');
    assert.equal(kindOf('/page/3'), 'none');
    assert.equal(kindOf('/author/jemand'), 'none');
  });

  it('SEO-R-U4. Slash-Normalisierung: `/ablauf/` ⇒ `/ablauf` (Query bleibt, Schreibweise bleibt), auch /impressum/, /datenschutz/, /konto/, Regionsseite', () => {
    assert.equal(redirect('/ablauf/'), '/ablauf');
    assert.equal(redirect('/ablauf/', '?x=1&y=2'), '/ablauf?x=1&y=2');
    assert.equal(redirect('/impressum/'), '/impressum');
    assert.equal(redirect('/datenschutz/'), '/datenschutz');
    assert.equal(redirect('/faq/'), '/faq');
    assert.equal(redirect('/kontakt/'), '/kontakt');
    assert.equal(redirect('/ueber-uns/'), '/ueber-uns');
    assert.equal(redirect('/slushmaschine-mieten/'), '/slushmaschine-mieten');
    assert.equal(redirect('/slushmaschine-mieten/mainz/'), '/slushmaschine-mieten/mainz');
    assert.equal(redirect('/konto/'), '/konto');
    assert.equal(redirect('/konto/anmelden/'), '/konto/anmelden');
    assert.equal(
      redirect('/konfigurator/', '?maschine=slush-10'),
      '/konfigurator?maschine=slush-10',
    );
    // Groß-/Kleinschreibung bleibt erhalten (Next-Routen sind case-sensitive ⇒ danach 404).
    assert.equal(redirect('/Ablauf/'), '/Ablauf');
    assert.equal(redirect('/Konto/Profil/'), '/Konto/Profil');
  });

  it('SEO-R-U5. Keine Entscheidung für `/` (auch mit `?p=`/`?s=`), kanonische Pfade ohne Slash, Konfigurator-Query, 404-belassene WordPress-Pfade, robots/sitemap/favicon', () => {
    for (const pathname of [
      '/',
      '/ablauf',
      '/impressum',
      '/datenschutz',
      '/faq',
      '/kontakt',
      '/ueber-uns',
      '/konto',
      '/konto/anmelden',
      '/konfigurator',
      '/slushmaschine-mieten',
      '/slushmaschine-mieten/mainz',
      '/popcornmaschine-mieten',
      '/waffeleisen-mieten',
      '/robots.txt',
      '/sitemap.xml',
      '/favicon.ico',
      '/.well-known/security.txt',
      '/wp-login.php',
      '/xmlrpc.php',
      '/wp-json',
      '/wp-json/wp/v2/pages',
      '/tag',
      '/wp-content/uploads/2026/01/bild.jpg',
      '/wp-admin',
      '/api/public/site/settings',
      '/_next/static/chunks/main.js',
      '/kontakt/abcdefghijklmnop',
      '/angebot/abcdefghijklmnop',
    ]) {
      assert.equal(kindOf(pathname), 'none', pathname);
    }
    assert.equal(kindOf('/', '?p=25'), 'none');
    assert.equal(kindOf('/', '?s=slush'), 'none');
    assert.equal(kindOf('/konfigurator', '?maschine=slush-10'), 'none');
    assert.equal(kindOf('/ablauf', '?x=1'), 'none');
  });

  it('SEO-R-U6. Open-Redirect-Versuche über den Pfad ⇒ none (`//evil.com/`, `/\\evil.com/`, `/buchung//`, `/%2F%2Fevil.com/`, …)', () => {
    for (const pathname of [
      '//evil.com/',
      '//evil.com',
      '///evil.com/',
      '/\\evil.com/',
      '/\\\\evil.com/',
      '/buchung//',
      '/buchung///',
      '//buchung/',
      '/%2F%2Fevil.com/',
      '/%2f%2fevil.com/',
      '/buchung/%2F%2Fevil.com',
      '/buchung%2F',
      '/buchung:/',
      '/buchung?/',
      '/buchung#/',
      '/buchung/@evil.com/',
      '/buchung/;/',
      '/buchung/\\evil.com',
      '/buchung/ /',
      '/ablauf/%0d%0a',
      '/ablauf/\r\n',
      '/ablauf/\u0000',
      '/äblauf/',
      '//',
      '///',
      '/\\',
      '',
      'buchung/',
      'https://evil.com/buchung/',
      'http://evil.com/',
    ]) {
      assert.equal(kindOf(pathname), 'none', JSON.stringify(pathname));
      assert.equal(kindOf(pathname, '?x=1'), 'none', JSON.stringify(pathname));
      assert.equal(
        SAFE_PATH.test(pathname),
        false,
        `SAFE_PATH darf ${JSON.stringify(pathname)} nicht akzeptieren`,
      );
    }
    assert.equal(SAFE_PATH.test('/buchung/'), true);
    assert.equal(SAFE_PATH.test('/sitemap_index.xml'), true);
    assert.equal(SAFE_PATH.test('/a/b-c/d_e.f~g'), true);
  });

  it('SEO-R-U7. Query kann kein externes Ziel erzeugen: `/buchung/?next=https://evil.com` ⇒ exakt `/konfigurator`; `/ablauf/?x=//evil` ⇒ `/ablauf?x=//evil`; Location beginnt immer mit genau einem `/`', () => {
    assert.equal(redirect('/buchung/', '?next=https://evil.com'), '/konfigurator');
    assert.equal(redirect('/buchung', '?next=//evil.com'), '/konfigurator');
    assert.equal(redirect('/mein-konto/', '?redirect_to=https://evil.com/'), '/konto');
    assert.equal(redirect('/ablauf/', '?x=//evil'), '/ablauf?x=//evil');
    assert.equal(redirect('/ablauf/', '?url=https://evil.com/'), '/ablauf?url=https://evil.com/');
    assert.equal(redirect('/ablauf/', '?@evil.com'), '/ablauf?@evil.com');

    const probes: ReadonlyArray<readonly [string, string]> = [
      ['/buchung/', '?next=https://evil.com'],
      ['/ablauf/', '?x=//evil'],
      ['/ablauf/', '?//evil.com'],
      ['/ablauf/', '?\\\\evil.com'],
      ['/konto/', '?a=1'],
      ['/slushmaschine-mieten/mainz/', ''],
      ['/sitemap_index.xml/', '?x'],
      ...LEGACY_REDIRECTS.map((entry) => [`${entry.from}/`, '?next=//evil.com'] as const),
    ];
    for (const [pathname, search] of probes) {
      const location = redirect(pathname, search);
      assert.ok(isRelativeLocation(location), location);
      assert.match(location, /^\/[^/\\]/, location);
      assert.doesNotMatch(location, /^\/\//, location);
      assert.doesNotMatch(location, /^https?:/i, location);
      assert.doesNotMatch(location, /[\r\n]/, location);
    }
    assert.equal(isRelativeLocation('//evil.com'), false);
    assert.equal(isRelativeLocation('/\\evil.com'), false);
    assert.equal(isRelativeLocation('https://evil.com/'), false);
    assert.equal(isRelativeLocation('/ablauf\r\nSet-Cookie: a=b'), false);
    assert.equal(isRelativeLocation('/ablauf?x=//evil'), true);
  });

  it('SEO-R-U8. Zeilenumbruch/Steuer-/Leer-/Nicht-ASCII-Zeichen oder fehlendes `?` in der Query ⇒ Query entfällt (kodierte Werte bleiben)', () => {
    assert.equal(redirect('/ablauf/', '?x=1\r\nSet-Cookie: a=b'), '/ablauf');
    assert.equal(redirect('/ablauf/', '?x=1\n'), '/ablauf');
    assert.equal(redirect('/ablauf/', '?x=1\r'), '/ablauf');
    assert.equal(redirect('/ablauf/', '?x=1 2'), '/ablauf');
    assert.equal(redirect('/ablauf/', '?x=\u0000'), '/ablauf');
    assert.equal(redirect('/ablauf/', '?x=ä'), '/ablauf');
    assert.equal(redirect('/ablauf/', 'x=1'), '/ablauf');
    assert.equal(redirect('/ablauf/', '?x=%0d%0a'), '/ablauf?x=%0d%0a');
    assert.equal(redirect('/ablauf/', '?x=1%202'), '/ablauf?x=1%202');
    // Legacy-Redirects verwerfen die Query ohnehin.
    assert.equal(redirect('/buchung/', '?x=1\r\nLocation: https://evil.com'), '/konfigurator');
  });

  it('SEO-R-U9. Listen konsistent: lowercase, ohne Schluss-Slash, SAFE, eindeutig, Ziele sind App-Routen und nie selbst Legacy-Quelle (kein Loop, keine Kette), Begründungen vorhanden', () => {
    const sources = [
      ...LEGACY_REDIRECTS.map((entry) => entry.from),
      ...LEGACY_GONE.map((entry) => entry.path),
    ];
    assert.equal(new Set(sources).size, sources.length, 'Pfad doppelt (Redirect/410)');
    for (const source of sources) {
      assert.ok(SAFE_PATH.test(source), source);
      assert.equal(source, source.toLowerCase(), source);
      assert.ok(source.startsWith('/') && !source.endsWith('/'), source);
      assert.notEqual(source, '/');
    }
    for (const entry of LEGACY_REDIRECTS) {
      assert.ok(APP_TARGETS.has(entry.to), `Ziel ${entry.to} ist keine bekannte App-Route`);
      assert.ok(!sources.includes(entry.to), `Ziel ${entry.to} ist selbst Legacy-Quelle (Kette)`);
      assert.equal(kindOf(entry.to), 'none', `Ziel ${entry.to} löst erneut aus (Kette)`);
      assert.notEqual(entry.from, entry.to);
      assert.ok(entry.reason.trim().length > 10, entry.from);
    }
    for (const entry of LEGACY_GONE) {
      assert.ok(entry.reason.trim().length > 10, entry.path);
    }
    // Vollständigkeit gegenüber Auftrag §6/§7 und Legacy-Verifikation.
    assert.deepEqual(
      LEGACY_REDIRECTS.map((entry) => [entry.from, entry.to]),
      ORDER_REDIRECTS.map(([from, to]) => [from, to]),
    );
    assert.deepEqual(
      LEGACY_GONE.map((entry) => entry.path),
      [...ORDER_GONE],
    );
  });

  it('SEO-R-U10. Alt-Sitemaps: `/sitemap_index.xml` ⇒ `/sitemap.xml` (308), Rank-Math-Unter-Sitemaps ⇒ 410; neue `/sitemap.xml` und `/robots.txt` unberührt', () => {
    assert.equal(redirect('/sitemap_index.xml'), '/sitemap.xml');
    assert.equal(redirect('/sitemap_index.xml/'), '/sitemap.xml');
    assert.equal(redirect('/Sitemap_Index.XML'), '/sitemap.xml');
    assert.equal(redirect('/sitemap_index.xml', '?x=1'), '/sitemap.xml');
    for (const sitemap of [
      '/post-sitemap.xml',
      '/page-sitemap.xml',
      '/metform-form-sitemap.xml',
      '/category-sitemap.xml',
    ]) {
      assert.equal(kindOf(sitemap), 'gone', sitemap);
      assert.equal(kindOf(`${sitemap}/`), 'gone', sitemap);
    }
    assert.equal(kindOf('/sitemap.xml'), 'none');
    assert.equal(kindOf('/robots.txt'), 'none');
    assert.equal(redirect('/sitemap.xml/'), '/sitemap.xml');
    for (const rest of ['/feed', '/comments/feed', '/author/techremedys', '/page/2']) {
      assert.equal(kindOf(rest), 'gone', rest);
      assert.equal(kindOf(`${rest}/`), 'gone', rest);
    }
  });

  it('SEO-R-U11. goneHtml: eigenständiges deutsches Dokument mit noindex, Überschrift, drei Links + CTA, Website-Tokens; kein Script, keine externen Ressourcen, keine Codes, kein „buchen“, keine Adresse', () => {
    const html = goneHtml();
    assert.equal(goneHtml(), html, 'konstant');
    assert.match(html, /^<!doctype html>\n<html lang="de">/i);
    assert.match(html, /<meta charset="utf-8">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.ok(html.includes(`<title>${GONE_TITLE}</title>`));
    assert.equal(GONE_TITLE, 'Diese Seite gibt es nicht mehr – Miet-Royal');
    assert.equal(GONE_HEADLINE, 'Diese Seite gibt es nicht mehr.');
    assert.ok(html.includes(`<h1>${GONE_HEADLINE}</h1>`));
    assert.equal(html.match(/<h1[\s>]/g)?.length, 1, 'genau eine H1');
    assert.match(html, /<main[\s>]/);
    assert.match(html, /<a[^>]*href="\/"[^>]*>Zur Startseite<\/a>/);
    assert.match(html, /<a[^>]*href="\/slushmaschine-mieten"[^>]*>Slushmaschine mieten<\/a>/);
    assert.match(html, /<a[^>]*href="\/kontakt"[^>]*>Kontakt<\/a>/);
    assert.match(html, /<a class="button" href="\/konfigurator">Slush konfigurieren<\/a>/);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /http:\/\//i);
    assert.doesNotMatch(html, /https:\/\//i);
    assert.doesNotMatch(html, /<link|<iframe|<img|@import|url\(/i);
    assert.doesNotMatch(html, /buchen/i);
    const body = html.slice(html.indexOf('<body>'));
    assert.doesNotMatch(body, /\b410\b|\bgone\b|fehler|error|status/i, 'keine technischen Codes');
    assert.doesNotMatch(body, /\b\d{5}\b|straße|strasse|str\.|hechtsheim/i, 'keine Adresse');
    assert.match(body, /\bdu\b|\bdir\b|\bdich\b/, 'du-Ansprache');
    // Website-Tokens und Bedienbarkeit.
    for (const token of ['#fffcf2', '#1c1712', '#7b5426', 'serif', 'system-ui']) {
      assert.ok(html.includes(token), token);
    }
    assert.match(html, /:focus-visible\{outline:3px solid #7b5426/);
    assert.match(html, /min-height:44px/);
    assert.match(html, /min-height:48px/);
    assert.match(html, /max-width:46rem/);
    for (const match of html.matchAll(/href="([^"]*)"/g)) {
      const href = match[1] ?? '';
      assert.ok(isRelativeLocation(href), href);
    }
    assert.ok(Buffer.byteLength(html, 'utf8') < 8192, 'kompakt');
  });

  it('SEO-R-U12. GONE_HEADERS vollständig (text/html utf-8, public max-age=3600, noindex/nofollow, nosniff, no-referrer), eingefroren, lowercase; REDIRECT_CACHE_CONTROL', () => {
    assert.deepEqual(
      { ...GONE_HEADERS },
      {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=3600',
        'x-robots-tag': 'noindex, nofollow',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      },
    );
    assert.ok(Object.isFrozen(GONE_HEADERS));
    for (const key of Object.keys(GONE_HEADERS)) assert.equal(key, key.toLowerCase());
    assert.equal(REDIRECT_CACHE_CONTROL, 'public, max-age=3600');
  });

  it('SEO-R-U13. proxy.ts (statisch): Matcher-Konstante schließt nur api/, _next/, favicon.ico, robots.txt, sitemap.xml aus; Alt-Sitemaps bleiben drin; Ziel-URL nur aus Entscheidung + eigener Server-URL mit Origin-Guard, kein NextResponse.redirect/request.url/Header-Zugriff, kein Logging, kein runtime-Export', () => {
    const source = readFileSync(path.resolve(import.meta.dirname, '../proxy.ts'), 'utf8');
    // Verbote gelten für den Code (Kommentare dürfen die Begriffe erklären).
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.match(source, /export function proxy\(request: NextRequest\)/);
    assert.match(
      source,
      /decideLegacyRoute\(request\.nextUrl\.pathname, request\.nextUrl\.search\)/,
    );
    assert.match(source, /status: 410, headers: GONE_HEADERS/);
    assert.match(source, /status: 308/);
    // Nexts Node-Adapter verlangt eine absolute Location (relativ ⇒ 500); Basis ist die EIGENE
    // Server-URL (`request.nextUrl`, nicht der Host-Header), der Pfad kommt nur aus der Entscheidung,
    // und ein Origin-Wechsel wird abgefangen.
    assert.ok(source.includes('new URL(decision.location, request.nextUrl)'));
    assert.ok(
      source.includes('if (target.origin !== request.nextUrl.origin) return NextResponse.next();'),
    );
    assert.match(source, /location: target\.href/);
    assert.equal(source.match(/new URL\(/g)?.length, 1, 'genau eine URL-Konstruktion');
    assert.match(source, /'cache-control': REDIRECT_CACHE_CONTROL/);
    assert.match(source, /NextResponse\.next\(\)/);
    assert.doesNotMatch(code, /export const runtime/);
    assert.doesNotMatch(code, /NextResponse\.redirect\(/);
    assert.doesNotMatch(code, /request\.url\b/);
    assert.doesNotMatch(code, /request\.headers/);
    assert.doesNotMatch(code, /headers\.get\(/);
    assert.doesNotMatch(code, /x-forwarded|\bhost\b|hostname/i);
    assert.doesNotMatch(code, /console\./);
    assert.doesNotMatch(code, /process\.env/);

    const matcherLiteral = /export const config = \{\s*matcher: \[\s*'([^']+)'\s*\],?\s*\};/.exec(
      source,
    );
    assert.ok(matcherLiteral, 'config.matcher muss eine konstante Ein-Element-Liste sein');
    // Quelltext-Literal ⇒ Laufzeitwert (`\\.` ⇒ `\.`); der Matcher nutzt nur eine Regex-Gruppe,
    // daher ist er zugleich eine gültige Regex (path-to-regexp hängt nur `[/#?]?$` an).
    const value = (matcherLiteral?.[1] ?? '').replace(/\\\\/g, '\\');
    assert.equal(value, '/((?!api/|_next/|favicon\\.ico$|robots\\.txt$|sitemap\\.xml$).*)');
    const matcher = new RegExp(`^${value}$`);
    for (const excluded of [
      '/api/public/site/settings',
      '/api/x',
      '/api/',
      '/_next/static/chunks/main.js',
      '/_next/image',
      '/_next/data/x/y.json',
      '/favicon.ico',
      '/robots.txt',
      '/sitemap.xml',
    ]) {
      assert.equal(matcher.test(excluded), false, `${excluded} darf nicht durch den Proxy laufen`);
    }
    for (const included of [
      '/',
      '/buchung/',
      '/shop',
      '/sitemap_index.xml',
      '/post-sitemap.xml',
      '/page-sitemap.xml',
      '/metform-form-sitemap.xml',
      '/category-sitemap.xml',
      '/konto/',
      '/kontakt/abcdefghijklmnop',
      '/robots.txt/',
      '/feed/',
    ]) {
      assert.equal(matcher.test(included), true, `${included} muss durch den Proxy laufen`);
    }
  });
});
