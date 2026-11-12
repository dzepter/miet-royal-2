import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { LEGACY_GONE, LEGACY_REDIRECTS, decideLegacyRoute } from './legacy-routes.ts';

/**
 * Phase 17 (WEB-ROUTES, Auftrag §32): docs/REDIRECT_MATRIX.md ist die verbindliche Tabelle der
 * Alt-URLs. Dieser Test hält Tabelle und Code (`legacy-routes.ts`) deckungsgleich: jeder
 * Code-Eintrag steht in der Tabelle mit richtigem Ergebnis/Ziel, keine Tabellenzeile behauptet
 * einen Redirect/410 ohne Code-Eintrag, jedes Ziel existiert als Route der Web-App, und die
 * Testnamen der Tabelle existieren. Läuft mit `node --test`.
 */

const DOC_PATH = path.resolve(import.meta.dirname, '../../../docs/REDIRECT_MATRIX.md');
const APP_DIR = path.resolve(import.meta.dirname, '../app');
const UNIT_TEST_PATH = path.resolve(import.meta.dirname, 'legacy-routes.test.ts');
const HEADER = ['Altpfad', 'Ergebnis', 'Ziel', 'Begründung', 'Testname'];
const E2E_NAMES: ReadonlySet<string> = new Set(
  Array.from({ length: 9 }, (_v, index) => `SEO-R${index + 1}`),
);

interface MatrixRow {
  line: number;
  altpfad: string;
  ergebnis: string;
  ziel: string;
  begruendung: string;
  testname: string;
}

function cells(line: string): string[] {
  return line
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

/** Alle Zeilen aller Tabellen mit der Matrix-Kopfzeile. */
function parseMatrix(markdown: string): MatrixRow[] {
  const rows: MatrixRow[] = [];
  let inTable = false;
  markdown.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line.startsWith('|') || !line.endsWith('|')) {
      inTable = false;
      return;
    }
    const columns = cells(line);
    if (columns.join('|') === HEADER.join('|')) {
      inTable = true;
      return;
    }
    if (!inTable) return;
    if (columns.every((cell) => /^:?-+:?$/.test(cell))) return;
    assert.equal(columns.length, 5, `Zeile ${index + 1}: fünf Spalten erwartet`);
    rows.push({
      line: index + 1,
      altpfad: columns[0] ?? '',
      ergebnis: columns[1] ?? '',
      ziel: columns[2] ?? '',
      begruendung: columns[3] ?? '',
      testname: columns[4] ?? '',
    });
  });
  return rows;
}

/** Inhalt einer `code`-Zelle. */
function code(cell: string, where: string): string {
  const match = /^`([^`]+)`$/.exec(cell);
  assert.ok(match, `${where}: Code-Formatierung erwartet, war „${cell}“`);
  return match?.[1] ?? '';
}

/** Wie `decideLegacyRoute`: Schluss-Slash entfernt, lowercase (Pfadteil vor `?`). */
function normalize(altpfad: string): string {
  const pathname = altpfad.split('?')[0] ?? '';
  return pathname === '/' ? pathname : pathname.replace(/\/+$/, '').toLowerCase();
}

function routeExists(target: string): boolean {
  if (target === '/sitemap.xml') {
    // Metadata-Route (app/sitemap.ts), kein page.tsx.
    return ['sitemap.ts', 'sitemap.tsx', 'sitemap.js', 'sitemap.xml'].some((file) =>
      existsSync(path.join(APP_DIR, file)),
    );
  }
  if (target === '/robots.txt') {
    return ['robots.ts', 'robots.tsx', 'robots.js', 'robots.txt'].some((file) =>
      existsSync(path.join(APP_DIR, file)),
    );
  }
  const relative = target === '/' ? 'page.tsx' : `${target.slice(1)}/page.tsx`;
  return existsSync(path.join(APP_DIR, relative));
}

const markdown = readFileSync(DOC_PATH, 'utf8');
const rows = parseMatrix(markdown);
const unitTestSource = readFileSync(UNIT_TEST_PATH, 'utf8');

describe('docs/REDIRECT_MATRIX.md ↔ lib/legacy-routes.ts (Phase 17, SEO-R-D)', () => {
  it('SEO-R-D1. Jeder Code-Eintrag (Redirect/410) steht in der Tabelle mit richtigem Ergebnis, Ziel und Begründung', () => {
    assert.ok(
      rows.length >= LEGACY_REDIRECTS.length + LEGACY_GONE.length + 4,
      'Tabelle unvollständig',
    );
    for (const entry of LEGACY_REDIRECTS) {
      const row = rows.find(
        (candidate) => normalize(code(candidate.altpfad, `Zeile ${candidate.line}`)) === entry.from,
      );
      assert.ok(row, `Tabellenzeile für ${entry.from} fehlt`);
      assert.equal(row?.ergebnis, '308', entry.from);
      assert.equal(code(row?.ziel ?? '', entry.from), entry.to, entry.from);
      assert.ok((row?.begruendung ?? '').length > 10, `${entry.from}: Begründung fehlt`);
    }
    for (const entry of LEGACY_GONE) {
      const row = rows.find(
        (candidate) => normalize(code(candidate.altpfad, `Zeile ${candidate.line}`)) === entry.path,
      );
      assert.ok(row, `Tabellenzeile für ${entry.path} fehlt`);
      assert.equal(row?.ergebnis, '410', entry.path);
      assert.equal(row?.ziel, '–', entry.path);
      assert.ok((row?.begruendung ?? '').length > 10, `${entry.path}: Begründung fehlt`);
    }
    // Keine Alt-URL doppelt (außer Varianten der Startseite mit Query).
    const sources = rows
      .filter(
        (row) => row.ergebnis === '308' || row.ergebnis === '410' || row.ergebnis === '308 (Slash)',
      )
      .map((row) => normalize(code(row.altpfad, `Zeile ${row.line}`)));
    assert.equal(new Set(sources).size, sources.length, 'Alt-URL doppelt in der Tabelle');
  });

  it('SEO-R-D2. Jede Tabellenzeile stimmt mit dem Code überein: 308 ⇒ Legacy-Redirect, 308 (Slash) ⇒ nur Slash-Normalisierung, 410 ⇒ Legacy-Gone, 200/404 ⇒ keine Regel', () => {
    for (const row of rows) {
      const where = `Zeile ${row.line} (${row.altpfad})`;
      const alt = code(row.altpfad, where);
      const base = alt.replace(/\/\*$/, '').replace(/\/+$/, '');
      switch (row.ergebnis) {
        case '308': {
          const entry = LEGACY_REDIRECTS.find((candidate) => candidate.from === normalize(alt));
          assert.ok(entry, `${where}: 308 ohne LEGACY_REDIRECTS-Eintrag`);
          assert.equal(code(row.ziel, where), entry?.to, where);
          for (const variant of [alt, base, `${base}/`]) {
            assert.deepEqual(
              decideLegacyRoute(variant, '?next=https://evil.example/'),
              { kind: 'redirect', location: entry?.to },
              `${where}: ${variant}`,
            );
          }
          break;
        }
        case '308 (Slash)': {
          assert.ok(
            alt.endsWith('/') && alt !== '/',
            `${where}: Slash-Zeile braucht Schluss-Slash`,
          );
          const ziel = code(row.ziel, where);
          assert.equal(ziel, alt.slice(0, -1), `${where}: Ziel = Pfad ohne Slash`);
          assert.ok(
            !LEGACY_REDIRECTS.some((entry) => entry.from === normalize(alt)) &&
              !LEGACY_GONE.some((entry) => entry.path === normalize(alt)),
            `${where}: ist Legacy-Eintrag, nicht nur Slash`,
          );
          assert.deepEqual(decideLegacyRoute(alt, ''), { kind: 'redirect', location: ziel }, where);
          assert.deepEqual(
            decideLegacyRoute(alt, '?x=1'),
            { kind: 'redirect', location: `${ziel}?x=1` },
            `${where}: Query bleibt`,
          );
          assert.equal(decideLegacyRoute(ziel, '').kind, 'none', `${where}: Ziel löst erneut aus`);
          break;
        }
        case '410': {
          assert.ok(
            LEGACY_GONE.some((entry) => entry.path === normalize(alt)),
            `${where}: 410 ohne LEGACY_GONE-Eintrag`,
          );
          assert.equal(row.ziel, '–', where);
          for (const variant of [alt, base, `${base}/`]) {
            assert.deepEqual(
              decideLegacyRoute(variant, ''),
              { kind: 'gone' },
              `${where}: ${variant}`,
            );
          }
          break;
        }
        case '200': {
          const [pathname = '', query] = alt.split('?');
          const search = query === undefined ? '' : `?${query}`;
          assert.equal(decideLegacyRoute(pathname, search).kind, 'none', where);
          assert.equal(code(row.ziel, where), pathname, `${where}: Ziel = Pfad selbst`);
          break;
        }
        case '404': {
          assert.equal(row.ziel, '–', where);
          assert.equal(decideLegacyRoute(base, '').kind, 'none', `${where}: ${base}`);
          const withSlash = decideLegacyRoute(`${base}/`, '');
          assert.notEqual(withSlash.kind, 'gone', where);
          if (withSlash.kind === 'redirect') assert.equal(withSlash.location, base, where);
          if (alt.endsWith('/*')) {
            assert.equal(decideLegacyRoute(`${base}/beispiel.jpg`, '').kind, 'none', where);
          }
          break;
        }
        default:
          assert.fail(`${where}: unbekanntes Ergebnis „${row.ergebnis}“`);
      }
    }
  });

  it('SEO-R-D3. Jedes Ziel existiert als Route der Web-App (page.tsx bzw. Metadata-Route app/sitemap.ts)', () => {
    for (const entry of LEGACY_REDIRECTS) {
      assert.ok(
        routeExists(entry.to),
        `Ziel ${entry.to} (${entry.from}) existiert nicht unter apps/web/app`,
      );
    }
    for (const row of rows) {
      if (row.ziel === '–') continue;
      const target = code(row.ziel, `Zeile ${row.line}`);
      assert.ok(
        routeExists(target),
        `Zeile ${row.line}: Ziel ${target} existiert nicht unter apps/web/app`,
      );
    }
    assert.equal(routeExists('/gibt-es-nicht'), false, 'Gegenprobe');
  });

  it('SEO-R-D4. Testnamen: jede Zeile nennt mindestens einen Unit-Test (SEO-R-U<n>, in legacy-routes.test.ts vorhanden); E2E-Namen nur SEO-R1–SEO-R9; alle neun sind im Dokument festgelegt', () => {
    for (const row of rows) {
      const tokens = row.testname.split(',').map((token) => token.trim());
      let unitTests = 0;
      for (const token of tokens) {
        if (/^SEO-R-U\d+$/.test(token)) {
          unitTests += 1;
          assert.ok(
            unitTestSource.includes(`'${token}. `),
            `Zeile ${row.line}: ${token} existiert nicht in legacy-routes.test.ts`,
          );
        } else {
          assert.ok(E2E_NAMES.has(token), `Zeile ${row.line}: unbekannter Testname „${token}“`);
        }
      }
      assert.ok(unitTests >= 1, `Zeile ${row.line}: Unit-Test fehlt`);
    }
    for (const name of E2E_NAMES) {
      assert.ok(
        markdown.includes(`${name} `) ||
          markdown.includes(`${name},`) ||
          markdown.includes(`${name}:`),
        `${name} nicht im Dokument`,
      );
    }
  });

  it('SEO-R-D5. Kopf nennt Verfahren (308, Proxy, skipTrailingSlashRedirect), 410, Query-/Slash-Regel und den kanonischen Host (DEPLOYMENT_NOTES)', () => {
    for (const needle of [
      'skipTrailingSlashRedirect',
      'apps/web/proxy.ts',
      '308',
      '410',
      'Trailing-Slash',
      'Query',
      'www.miet-royal.de',
      'DEPLOYMENT_NOTES',
      'PRE_START_CHECKLIST',
      'Diese Seite gibt es nicht mehr.',
    ]) {
      assert.ok(markdown.includes(needle), `„${needle}“ fehlt im Dokument`);
    }
  });
});
