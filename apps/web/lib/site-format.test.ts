import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatNumber,
  formatPriceCents,
  isMachine,
  machineCapacityText,
  phoneHref,
  productPriceText,
  quantityText,
  ratingStars,
  ratingText,
  sitePageTitle,
  textParagraphs,
} from './site-format.ts';
import { cmsPageMetadata, noindexMetadata, readIndexingEnabled, siteRobots } from './site-meta.ts';
import type { PublicMachine, PublicProduct } from './site-types.ts';

/**
 * Phase 16 (WEB, Design §11.3 „WEB“): Formatierung (Cent ⇒ EUR, Texte, Titel) und
 * Indexierungs-Entscheidung der öffentlichen Website. Läuft mit `node --test`.
 */

const machine: PublicMachine = {
  slug: 'slush-2x8',
  name: '2×8 L',
  category: 'machine',
  description: 'Slushmaschine mit 2 Behältern à 8 Liter.',
  priceCents: 10000,
  billingMode: 'fixed',
  unitLabel: 'Stück',
  containerCount: 2,
  containerVolumeLiters: 8,
};
const syrup: PublicProduct = {
  slug: 'sirup-kirsche',
  name: 'Sirup Kirsche',
  category: 'syrup',
  description: null,
  priceCents: 1200,
  billingMode: 'commission',
  unitLabel: '1-L-Flasche',
};
const canister: PublicProduct = {
  slug: 'mischkanister-6l',
  name: '6-L-Mischkanister',
  category: 'purchase',
  description: null,
  priceCents: 500,
  billingMode: 'fixed',
  unitLabel: 'Stück',
};

describe('Website-Formatierung (Phase 16)', () => {
  it('W-F1. Cent ⇒ EUR (de-DE, deterministisch); ungültige Werte ⇒ „–“, nie gerundete Fantasiepreise', () => {
    assert.equal(formatPriceCents(10000), '100,00 €');
    assert.equal(formatPriceCents(250), '2,50 €');
    assert.equal(formatPriceCents(123456), '1.234,56 €');
    assert.equal(formatPriceCents(0), '0,00 €');
    assert.equal(formatPriceCents(12.5), '–');
    assert.equal(formatPriceCents(Number.NaN), '–');
  });

  it('W-F2. Preiszeilen nur aus DTO-Werten: Maschine „Mietpreis“, Kommission mit Einheit, Kaufartikel', () => {
    assert.equal(productPriceText(machine), 'Mietpreis 100,00 €');
    assert.equal(productPriceText(syrup), '12,00 € je 1-L-Flasche · auf Kommission');
    assert.equal(productPriceText(canister), '5,00 € je Stück · Kaufartikel');
    assert.equal(isMachine(machine), true);
    assert.equal(isMachine(syrup), false);
    assert.equal(machineCapacityText(machine), '2 Behälter à 8 L');
    assert.equal(
      machineCapacityText({ ...machine, containerCount: 1, containerVolumeLiters: 10.5 }),
      '1 Behälter à 10,5 L',
    );
  });

  it('W-F3. Mengen/Zahlen: Liter direkt, Packs mit „×“; deutsche Dezimalschreibweise', () => {
    assert.equal(quantityText(2, 'L'), '2 L');
    assert.equal(quantityText(3, '25er-Pack'), '3 × 25er-Pack');
    assert.equal(quantityText(1, ''), '1');
    assert.equal(formatNumber(2), '2');
    assert.equal(formatNumber(0.25), '0,25');
    assert.equal(formatNumber(1.5), '1,5');
  });

  it('W-F4. CMS-Text ⇒ Absätze an Leerzeilen, Zeilen innerhalb eines Absatzes bleiben; kein HTML-Parsing', () => {
    assert.deepEqual(textParagraphs('Erster Absatz.\n\nZweiter\nmit Zeile.\n\n\n  \nDritter'), [
      ['Erster Absatz.'],
      ['Zweiter', 'mit Zeile.'],
      ['Dritter'],
    ]);
    assert.deepEqual(textParagraphs('<b>kein HTML</b>'), [['<b>kein HTML</b>']]);
    assert.deepEqual(textParagraphs('a\r\n\r\nb'), [['a'], ['b']]);
    assert.deepEqual(textParagraphs('   '), []);
  });

  it('W-F5. Seitentitel: Meta-Titel bzw. Titel + „ – Miet-Royal“, nicht doppelt', () => {
    assert.equal(
      sitePageTitle('Slushmaschine mieten in Mainz', 'X'),
      'Slushmaschine mieten in Mainz – Miet-Royal',
    );
    assert.equal(sitePageTitle(null, 'Häufige Fragen'), 'Häufige Fragen – Miet-Royal');
    assert.equal(sitePageTitle('  ', 'Ablauf'), 'Ablauf – Miet-Royal');
    assert.equal(
      sitePageTitle('Miet-Royal – Slush für dein Event', 'X'),
      'Miet-Royal – Slush für dein Event',
    );
    assert.equal(sitePageTitle('Über MIET-ROYAL', 'X'), 'Über MIET-ROYAL');
    assert.equal(sitePageTitle(null, ''), 'Miet-Royal');
  });

  it('W-F6. Bewertung als Text (nie nur Sterne), Telefonlink nur aus gültiger Nummer', () => {
    assert.equal(ratingText(4.84), '4,8 von 5');
    assert.equal(ratingText(5), '5 von 5');
    assert.equal(ratingText(7), '5 von 5');
    assert.equal(ratingStars(4.4), '★★★★☆');
    assert.equal(phoneHref('+49 6131 000000'), 'tel:+496131000000');
    assert.equal(phoneHref('06131 / 00 00 00'), 'tel:06131000000');
    assert.equal(phoneHref('kein Telefon'), null);
  });
});

describe('Indexierungs-Entscheidung (Phase 16, Design §1.7)', () => {
  it('W-I1. Default AUS: nur WEB_INDEXING_ENABLED=true öffnet die Indexierung', () => {
    assert.equal(readIndexingEnabled(undefined), false);
    assert.equal(readIndexingEnabled(''), false);
    assert.equal(readIndexingEnabled('false'), false);
    assert.equal(readIndexingEnabled('1'), false);
    assert.equal(readIndexingEnabled('TRUE'), false);
    assert.equal(readIndexingEnabled('yes'), false);
    assert.equal(readIndexingEnabled('true'), true);
    assert.equal(readIndexingEnabled(' true '), true);
    assert.deepEqual(siteRobots(false), { index: false, follow: false });
    assert.deepEqual(siteRobots(true), { index: true, follow: true });
  });

  it('W-I2. CMS-Metadaten aus Meta-Titel/-Beschreibung; Fehlerdarstellung immer noindex', () => {
    assert.deepEqual(
      cmsPageMetadata({
        title: 'FAQ',
        metaTitle: 'Fragen zur Slushmaschine',
        metaDescription: ' Alles Wichtige. ',
      }),
      { title: 'Fragen zur Slushmaschine – Miet-Royal', description: 'Alles Wichtige.' },
    );
    assert.deepEqual(cmsPageMetadata({ title: 'FAQ', metaTitle: null, metaDescription: null }), {
      title: 'FAQ – Miet-Royal',
    });
    assert.deepEqual(noindexMetadata('Gleich wieder da'), {
      title: 'Gleich wieder da – Miet-Royal',
      robots: { index: false, follow: false },
    });
  });
});
