import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

/**
 * Phase 17 (Review RD-1/RD-Hinweise): CSS-Invarianten der Website, die Responsive-/A11y-Befunde
 * absichern – reine Quelltextprüfung von `components/site/site.module.css`.
 */
// Kommentare entfernen, damit Selektoren exakt erkannt werden.
const css = readFileSync(
  resolve(import.meta.dirname, '../components/site/site.module.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

function blocks(selectorPattern: RegExp): string[] {
  const found: string[] = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  for (const match of css.matchAll(re)) {
    const selector = (match[1] ?? '').trim();
    const body = match[2] ?? '';
    if (selectorPattern.test(selector)) found.push(body);
  }
  return found;
}

const configuratorCss = readFileSync(
  resolve(import.meta.dirname, '../components/configurator/configurator.module.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

describe('site.module.css – Invarianten (Phase 17)', () => {
  it('SEO-W-CSS3. Konfigurator-Raster schrumpft unter die Min-Content-Breite (Fortschrittsbalken scrollt intern statt das Raster zu dehnen)', () => {
    const layout = configuratorCss.match(/\.layout\s*\{([^}]*)\}/);
    assert.ok(layout, '.layout-Block vorhanden');
    assert.match(layout?.[1] ?? '', /grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/);
    const progress = configuratorCss.match(/\n\.progress\s*\{([^}]*)\}/);
    assert.match(progress?.[1] ?? '', /overflow-x\s*:\s*auto/);
  });

  it('SEO-W-CSS1. `.listValue` ohne `white-space: nowrap` (Preiszeilen brechen bei 320/360 px um, kein Seiten-Overflow)', () => {
    const listValue = blocks(/^\.listValue$/);
    assert.equal(listValue.length, 1, 'genau ein .listValue-Block');
    assert.doesNotMatch(listValue[0] ?? '', /white-space\s*:\s*nowrap/);
    // Die Zeile selbst darf umbrechen (flex-wrap) – sonst drückt ein langer Wert die Karte auf.
    const listRow = blocks(/^\.listRow$/);
    assert.match(listRow[0] ?? '', /flex-wrap\s*:\s*wrap/);
  });

  it('SEO-W-CSS2. Brotkrumen-Einträge haben Touchflächen ≥ 44 px und brechen um', () => {
    const breadcrumb = blocks(/\.breadcrumbList/).join('\n');
    assert.match(breadcrumb, /min-height\s*:\s*44px/);
    assert.match(breadcrumb, /flex-wrap\s*:\s*wrap/);
  });
});
